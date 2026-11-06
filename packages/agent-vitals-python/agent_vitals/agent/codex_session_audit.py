"""Codex 单会话审计组合 —— `codex-session` 子命令的数据层（Python 镜像）。

`codex-cost` 在折叠时把会话身份立刻丢弃（聚合进 `by_hour_model`/`by_model`），
`codex-evidence` 逐 rollout 文件给出处但不含成本。本模块把两半拼回一个
**逻辑 session**（按 `session_id` 分组，跨文件 resume 合并）：

- **逐 session 成本**：逐文件 `codex_fold_file` → `codex_merge_folds` →
  `codex_cost_report`（`want_hours=True` 给出小时轴时间线）。与 `codex-cost`
  完全同一条折叠→计价路径，只是把文件集限定为该 session 的。
- **出处覆盖并集**：把该 session 所有文件的 items concat 成一条，交
  `build_codex_evidence` 一次折叠——`derive_coverage` 对全部 item 计数，
  任一文件覆盖即覆盖，并集 by construction（无需手工并）。
- **会话元数据**（model / cli_version / history_mode / workspace_roots）取
  路径序最后一个文件（同 per-file 内 latest-wins 的「当前状态」惯例——
  resume 会话的续写文件落在更新路径里）。
- **时间跨度**：Codex rollout 只有逐行顶层 `timestamp`（ISO UTC），用每文件
  首/末行时间戳界定，跨文件取 min/max。
- **上下文窗口**：最后一个 token_count 的 `info.model_context_window`（最后看见
  的赢）——Codex 无逐 turn 上下文峰值，窗口是报告能诚实给出的「上下文上限」。

全是既有纯函数的组合，**无新规则**；与 Rust `apps/cli/src/agent/codex_session_audit.rs`
逐字节对齐，由 `tests/test_cli_matrix.py::both()` 差分看守。HTML 模板与 Rust
共用 `assets/templates/codex_session.html`（DSH 审计 tab 版式）。
"""

import functools
import json
from pathlib import Path

from agent_vitals.adapters import codex_session
from agent_vitals.agent import codex_cost, codex_evidence, codex_usage

# 折叠结果里空桶的兜底（与 main.rs `codex_report_from_merged` 的兜底同构）：调用方
# 要的是「没有数据」而不是「崩了」，unaccounted/plan 必须透传。
def _empty_cost_report(unaccounted, plan):
    return {
        "total_cost_usd": 0,
        "total_tokens": {f: 0 for f in codex_usage.CODEX_TOKEN_FIELDS},
        "per_model": {},
        "days": [],
        "unpriced_tokens": 0,
        "unaccounted_usage": unaccounted,
        "plan": plan,
        "hours": [],
    }


def _item_ts(item):
    """顶层 `timestamp` 的字符串提取——`serde_json::as_str` 的镜像：非 dict 或
    非字符串 → None，绝不把别的类型当时间戳。"""
    if isinstance(item, dict):
        ts = item.get("timestamp")
        if isinstance(ts, str):
            return ts
    return None


def _context_window_of(items):
    """最后一个 token_count 事件的 `info.model_context_window`（事件序即时间序，
    最后看见的赢——同 plan 的惯例）。与 Rust `context_window_of` 逐字节对齐：
    `info` 必须真为 dict（键存在但 null 不是窗口），窗口必须真是 int（浮点
    `128000.0` 挡在门外，`serde_json::as_i64` 对浮点返回 None）。"""
    found = None
    for item in items:
        if not isinstance(item, dict):
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue
        ptype = payload.get("type")
        if not isinstance(ptype, str):
            ptype = ""
        if ptype != "token_count":
            continue
        info = payload.get("info")
        if isinstance(info, dict):
            w = info.get("model_context_window")
            if isinstance(w, int) and not isinstance(w, bool):
                found = w
    return found


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _quota_trajectory_of(items):
    samples = []
    for item in items:
        payload = item.get("payload") if isinstance(item, dict) else None
        if not isinstance(payload, dict) or payload.get("type") != "token_count":
            continue
        primary = payload.get("rate_limits")
        primary = primary.get("primary") if isinstance(primary, dict) else None
        used = primary.get("used_percent") if isinstance(primary, dict) else None
        if _number(used) is not None:
            samples.append({"used_percent": used, "observed_at": _item_ts(item),
                            "resets_at": primary.get("resets_at") if isinstance(primary.get("resets_at"), int) and not isinstance(primary.get("resets_at"), bool) else None})
    if not samples:
        return None
    first, last = samples[0], samples[-1]
    comparable, reason = True, None
    if first["resets_at"] != last["resets_at"]:
        comparable, reason = False, "reset_window_changed"
    elif last["used_percent"] < first["used_percent"]:
        comparable, reason = False, "used_percent_decreased"
    return {"scope": "primary", "samples": len(samples),
            "first": {"used_percent": first["used_percent"], "observed_at": first["observed_at"]},
            "last": {"used_percent": last["used_percent"], "observed_at": last["observed_at"]},
            "consumed_percent": last["used_percent"] - first["used_percent"] if comparable else None,
            "resets_at": last["resets_at"], "comparable": comparable, "reason": reason}


def _permission_trajectory_of(items):
    effective = None; transitions = []; dangerous_turns = set(); dangerous_no_turn = 0
    for item in items:
        payload = item.get("payload") if isinstance(item, dict) else None
        if not isinstance(payload, dict) or item.get("type") != "turn_context":
            continue
        # 真实线格式（01a029cb/01a050f5 实测）active_permission_profile 是
        # object {"id": ...}，不是 string——只认 string 会把 observed/effective
        # 全读成 null、轨迹死透（修复前真机报告权限列全空）。两态都认（同
        # sandbox_policy 先例），effective 按 last-seen 推进（null 档=保持上一档）。
        observed = payload.get("active_permission_profile")
        if isinstance(observed, dict):
            observed = observed.get("id")
        observed = observed if isinstance(observed, str) else None
        if observed is not None: effective = observed
        sandbox = payload.get("sandbox_policy")
        sandbox = sandbox.get("type") if isinstance(sandbox, dict) else sandbox
        sandbox = sandbox if isinstance(sandbox, str) else None
        approval = payload.get("approval_policy")
        approval = approval if isinstance(approval, str) else None
        turn = payload.get("turn_id")
        turn = turn if isinstance(turn, str) else None
        # dangerous 按 **distinct turn** 计：同一 turn 的多次 turn_context 会
        # 重复计（per-event 把少数几个危险 turn 数成几十条——01a050f5 实报 43）。
        # 无 turn_id 的事件无从去重，退化为按事件计。
        if effective == ":danger-full-access" or sandbox == "danger-full-access":
            if turn is None: dangerous_no_turn += 1
            else: dangerous_turns.add(turn)
        state = {"turn": turn, "observed_profile": observed, "effective_profile": effective,
                 "sandbox": sandbox, "approval": approval}
        if not transitions or transitions[-1]["effective_profile"] != state["effective_profile"] or transitions[-1]["sandbox"] != sandbox or transitions[-1]["approval"] != approval:
            transitions.append(state)
    return {"dangerous_turns": dangerous_no_turn + len(dangerous_turns), "transitions": transitions}


def _turn_ends_of(canonical):
    total = clean = error = incomplete = 0; codes = {}
    for entry in canonical["turns"]["entries"]:
        obs = entry["observation"]; total += 1
        if obs.get("end_seq") is None: incomplete += 1
        elif obs.get("end_reason_kind") == "error":
            error += 1
            code = obs.get("end_error_code")
            if isinstance(code, str): codes[code] = codes.get(code, 0) + 1
        else: clean += 1
    return {"total": total, "clean": clean, "error": error, "incomplete": incomplete, "codes": codes}


def _effort_of(items):
    values = []; summary = None
    for item in items:
        payload = item.get("payload") if isinstance(item, dict) else None
        settings = payload.get("thread_settings") if isinstance(payload, dict) and payload.get("type") == "thread_settings_applied" else None
        if isinstance(settings, dict):
            effort = settings.get("reasoning_effort")
            if isinstance(effort, str): values.append(effort)
            if isinstance(settings.get("reasoning_summary"), str): summary = settings["reasoning_summary"]
    return {"effective": values[-1] if values else None, "reasoning_effort": values[-1] if values else None,
            "reasoning_summary": summary, "changed": len(set(values)) > 1}


def _tool_output_bytes_of(items):
    stdout = stderr = commands = 0; top = []
    for item in items:
        payload = item.get("payload") if isinstance(item, dict) else None
        it = payload.get("item") if isinstance(payload, dict) and payload.get("type") == "item_completed" else None
        if not isinstance(it, dict) or it.get("type") != "CommandExecution": continue
        out = it.get("stdout") if isinstance(it.get("stdout"), str) else ""
        err = it.get("stderr") if isinstance(it.get("stderr"), str) else ""
        ob, eb = len(out.encode("utf-8")), len(err.encode("utf-8")); stdout += ob; stderr += eb; commands += 1
        top.append({"turn": payload.get("turn_id") if isinstance(payload.get("turn_id"), str) else None, "tool": "bash", "stdout_bytes": ob})
    top.sort(key=lambda x: x["stdout_bytes"], reverse=True)
    return {"stdout": stdout, "stderr": stderr, "commands": commands, "top": top[:5]}


def _turn_timeline_of(items, audit):
    """Source-order event list; source_order is explicit, never a fabricated seq."""
    refs = {}
    for finding in audit.get("findings", []):
        seq = finding.get("seq")
        if isinstance(seq, int) and not isinstance(seq, bool): refs.setdefault(seq, []).append(finding["rule"])
    events = []
    for source_order, item in enumerate(items):
        payload = item.get("payload") if isinstance(item, dict) else None
        if not isinstance(payload, dict): continue
        top, kind, turn, summary = item.get("type"), payload.get("type"), payload.get("turn_id"), None
        if top == "turn_context": summary = "权限上下文"
        elif kind == "task_started": summary = "turn 开始"
        elif kind == "task_complete": summary = "turn 完成" if payload.get("error") is None else "turn error"
        elif kind == "item_completed" and isinstance(payload.get("item"), dict) and payload["item"].get("type") == "CommandExecution": summary = "命令执行"
        elif kind == "token_count": summary = "用量 / 配额快照"
        if summary is not None:
            ts = item.get("timestamp")
            events.append({"source_order": source_order, "turn": turn if isinstance(turn, str) else None,
                           "kind": kind if isinstance(kind, str) else top, "summary": summary,
                           "rule_refs": refs.get(source_order, []),
                           # hour：核心 codex_hour_of 折好的北京小时桶键（与
                           # cost_report.hours 同一把尺）——事件对齐小时桶只做字典
                           # 查表，浏览器不算第二遍北京时间；ts：原始 ISO，诚实出处。
                           "hour": codex_usage.codex_hour_of(item),
                           "ts": ts if isinstance(ts, str) else None})
    return events


def _file_info(path):
    """一份 rollout 文件对 `codex-session` 有用的全部信息。degraded 文件（不可读/
    非 JSON/空）→ items 空 + 时间戳 None，但**仍按文件名兜底的 session_id
    参与分组**（同 `codex-evidence` 的 §14.4 back-fill——session 永远可指认，
    绝不把缺席当成 0 条真数据）。"""
    parsed = codex_session.read_codex_session_log(path)
    items = parsed.get("items") or []
    sid = parsed.get("session_id")
    if not isinstance(sid, str):
        sid = Path(path).stem
    return {
        "path": str(path),
        "session_id": sid,
        "history_mode": parsed.get("history_mode"),
        "cli_version": parsed.get("cli_version"),
        "model": parsed.get("model"),
        "workspace_roots": parsed.get("workspace_roots") or [],
        "first": _item_ts(items[0]) if items else None,
        "last": _item_ts(items[-1]) if items else None,
        "items": items,
    }


def _session_cmp(a, b):
    """`codex_session_list` 的排序比较器——镜像 Rust `sessions.sort_by`：末行时间戳
    降序（最新在前），None（无时间样本）按最老排最后，平局按 session_id 升序。
    `(last, session_id)` 是全序，排序结果与输入顺序无关，两侧稳定一致。"""
    al = a.get("last") or ""
    bl = b.get("last") or ""
    if bl < al:
        return -1  # b 更旧 → a 在前（降序）
    if bl > al:
        return 1
    sa, sb = a.get("session_id") or "", b.get("session_id") or ""
    return (sa > sb) - (sa < sb)


def codex_session_list(home=None):
    """`codex-session --list`：所有逻辑 session 的行摘要（id/标题/模型/文件数/时间
    跨度），按「末行时间戳降序（最新在前），平局按 session_id 升序」。标题来自
    `session_index.jsonl` 查表（索引缺失/不在索引 → None，存在性探测绝不报错）。

    与 Rust `codex_session_audit.rs::codex_session_list` 逐字节对齐。键序是字节
    一致的一部分，不能重排。
    """
    index = codex_session.read_session_index(home)
    by_session = {}
    for path in codex_session.codex_rollout_files(home):
        info = _file_info(path)
        by_session.setdefault(info["session_id"], []).append(info)
    sessions = []
    for sid, files in by_session.items():
        current = files[-1]
        first = min((f["first"] for f in files if f["first"] is not None), default=None)
        last = max((f["last"] for f in files if f["last"] is not None), default=None)
        sessions.append({
            "session_id": sid,
            "title": index.get(sid),
            "model": current["model"],
            "cli_version": current["cli_version"],
            "history_mode": current["history_mode"],
            "files": len(files),
            "first": first,
            "last": last,
        })
    sessions.sort(key=functools.cmp_to_key(_session_cmp))
    return {"harness": "codex", "currency": "USD", "sessions": sessions}


def codex_session_audit_json(home, session_id):
    """`codex-session` 单会话深挖：逐 session 成本 + 出处覆盖并集。`None` = 没有
    任何 rollout 文件属于该 session_id（调用方报「session not found」）。

    与 Rust `codex_session_audit.rs::codex_session_audit_json` 逐字节对齐。键序是
    字节一致的一部分，不能重排。
    """
    index = codex_session.read_session_index(home)
    files = []
    for path in codex_session.codex_rollout_files(home):
        info = _file_info(path)
        if info["session_id"] == session_id:
            files.append(info)
    if not files:
        return None
    current = files[-1]

    # ── 逐 session 成本：折叠 → 合并 → 计价（codex-cost 同一条路径）──────
    all_items = []
    fold_folds = []
    for f in files:
        all_items.extend(f["items"])
        fold_folds.append(codex_usage.codex_fold_file(f["items"]))
    # 上下文窗口必须在 all_items 被 build_codex_evidence 消耗之前读。
    context_window = _context_window_of(all_items)
    merged = codex_usage.codex_merge_folds(fold_folds)
    pricing = codex_cost.load_codex_pricing()
    cost_report = codex_cost.codex_cost_report(
        merged["by_hour_model"], merged["by_model"], merged["unaccounted"],
        merged["plan"], pricing, want_hours=True)
    if cost_report is None:
        cost_report = _empty_cost_report(merged["unaccounted"], merged["plan"])

    # ── 出处：concat 全部 items → 一次 build（覆盖 = 跨文件并集）──────────
    evidence = codex_evidence.build_codex_evidence(
        all_items, session_id, index.get(session_id), current["history_mode"],
        current["cli_version"], current["workspace_roots"], current["model"])
    ev = codex_evidence.codex_evidence_json(evidence)
    audit = codex_evidence.codex_audit_projection(evidence["canonical"])

    first = min((f["first"] for f in files if f["first"] is not None), default=None)
    last_ts = max((f["last"] for f in files if f["last"] is not None), default=None)

    return {
        "harness": "codex",
        "currency": "USD",
        "session_id": session_id,
        "title": index.get(session_id),
        "model": current["model"],
        "cli_version": current["cli_version"],
        "history_mode": current["history_mode"],
        "workspace_roots": current["workspace_roots"],
        "files": [str(f["path"]) for f in files],
        "context_window": context_window,
        "date_span": {"first": first, "last": last_ts},
        "audit": audit,
        "quota_trajectory": _quota_trajectory_of(all_items),
        "permission_transitions": _permission_trajectory_of(all_items),
        "turn_ends": _turn_ends_of(evidence["canonical"]),
        "effort": _effort_of(all_items),
        "tool_output_bytes": _tool_output_bytes_of(all_items),
        "turn_timeline": _turn_timeline_of(all_items, audit),
        "cost_report": cost_report,
        "coverage": ev["coverage"],
        "signals": ev["signals"],
        "attempts": ev["attempts"],
        "notes": ev["notes"],
    }


def _render_list(out):
    """`codex-session --list` 的人读呈现——与 Rust `render_codex_session_list`
    逐字节对齐。缺席的字段一律 `-`（诚实缺失，不编造），行宽固定 28。"""
    s = "harness: codex\n"
    sessions = out.get("sessions") or []
    s += "sessions: %d\n\n" % len(sessions)
    for row in sessions:
        sid = row.get("session_id")
        title = row.get("title")
        model = row.get("model")
        files = row.get("files")
        first = row.get("first")
        last = row.get("last")
        s += "%-28s  %s  %s  %d files  %s → %s\n" % (
            sid if isinstance(sid, str) else "",
            title if isinstance(title, str) else "-",
            model if isinstance(model, str) else "-",
            files if isinstance(files, int) and not isinstance(files, bool) else 0,
            first if isinstance(first, str) else "-",
            last if isinstance(last, str) else "-",
        )
    return s


def _render_audit(out):
    """`codex-session` 单会话深挖的人读呈现——与 Rust `render_codex_session`
    逐字节对齐。覆盖/信号/残差哨兵是最下面三行——终端里只看概要，详情在
    `--json` 或 `--html`。"""
    s = "harness: codex\n"
    sid = out.get("session_id")
    s += "session_id: %s\n" % (sid if isinstance(sid, str) else "")
    for key in ("title", "model", "cli_version", "history_mode"):
        v = out.get(key)
        s += "%s: %s\n" % (key, v if isinstance(v, str) else "-")
    roots = out.get("workspace_roots") or []
    roots = [r for r in roots if isinstance(r, str)]
    s += "workspace_roots: %s\n" % (", ".join(roots) if roots else "-")
    files = out.get("files") or []
    s += "files: %d\n" % len(files)
    span = out.get("date_span") or {}
    first = span.get("first")
    last = span.get("last")
    s += "span: %s → %s\n" % (
        first if isinstance(first, str) else "-",
        last if isinstance(last, str) else "-",
    )
    cr = out.get("cost_report")
    if isinstance(cr, dict):
        cost = cr.get("total_cost_usd")
        s += "total_cost_usd: %.2f\n" % (cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) else 0.0)
        tt = cr.get("total_tokens")
        if isinstance(tt, dict):
            parts = ["%s=%s" % (k, v if isinstance(v, int) and not isinstance(v, bool) else 0)
                     for k, v in tt.items()]
            s += "total_tokens: %s\n" % " ".join(parts)
        up = cr.get("unpriced_tokens")
        s += "unpriced_tokens: %s\n" % (up if isinstance(up, int) and not isinstance(up, bool) else 0)
    signals = out.get("signals") or []
    cov = out.get("coverage")
    avail = 0
    if isinstance(cov, dict):
        # 分母是执行环境可用信号数，不是 19——结构缺口（available=false）任何会话
        # 都为零，算进分母只会把「9/19」这种数字弄成永远到不了的满分。
        avail = sum(1 for c in cov.values()
                    if isinstance(c, dict) and c.get("available") is not False)
    s += "coverage: %d/%d available signals\n" % (len(signals), avail)
    notes = out.get("notes") or []
    s += "notes: %d\n" % len(notes)
    return s


def _render_codex_session_html(output_path, out):
    """`codex-session --html`：独立模板 codex_session.html（套 DSH 审计 tab 版式，
    不是 calendar.html——那是日历看板）。只内联本 session 的审计 JSON 单块
    `<script id="agent-vitals-data-codex-session">`。JSON 经 `</script`/`<!--`
    转义。与 Rust `render_codex_session_html` 同构（HTML 文件不参与差分，只需
    等价可解析的页面；两边共读同一份模板文件）。"""
    # packages/agent-vitals-python/agent_vitals/agent/codex_session_audit.py → 仓库根爬 5 层。
    template = Path(__file__).resolve().parents[4] / "assets" / "templates" / "codex_session.html"
    if not template.is_file():
        raise FileNotFoundError(
            "codex-session template not found at %s" % template)
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    html = template.read_text(encoding="utf-8")
    json_text = json.dumps(out, ensure_ascii=False)
    # JSON 里可能含 </script> / <!-- —— 必须转义，否则浏览器解析到这就崩。
    json_text_safe = (json_text.replace("</script", "<\\/script")
                      .replace("<!--", "<\\!--"))
    inject = ("<script id=\"agent-vitals-data-codex-session\" type=\"application/json\">"
              + json_text_safe + "</script>")
    html = html.replace("</head>", inject + "\n</head>", 1)
    out_path.write_text(html, encoding="utf-8")
