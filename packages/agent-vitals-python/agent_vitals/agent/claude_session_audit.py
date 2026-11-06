"""Claude Code 单会话审计组合 —— `claude-session` 子命令的数据层（Python 镜像）。

与 Rust `src/agent/claude_session.rs` 的后半段（`claude_session_list` /
`render_claude_session_list` / `degrade_sv607_608` / `claude_audit_projection` /
`claude_session_audit_json`）逐字节对齐。Rust 把 locate→shape→extract 与审计组合
收在同一个文件里；Python 侧按 repo 的模块纪律分两处——I/O 在
`adapters/claude_session.py`，纯组合在这里（`derive → coverage` 又在
`agent/claude_evidence.py`）。五段式流水线：locate → shape → extract（适配器）→
derive → coverage（evidence）→ 组合（本模块）。

**SV607/608 的 Unavailable 是本模块的 harness-capability degradation（§12），不是
core 规则改动。** Claude 的 tool_result 没有原因码词汇——core 适配器 §3 让
`error_code` 结构性恒 None（绝不伪造），而 SV607/608 是原因级检测器（读
error_code，不读 failed）。家族①门控按 timeline 非空放行后，检测器会在全 None
上空转产出 MeasuredZero——那是对「结构上读不到原因」撒谎（DSH 的
error_code=None 是「工具成功」的真测量，Claude 的 None 是「schema 不可能有」）。
所以这里在 Claude 路径把 SV607/608 从 MeasuredZero 覆盖成 Unavailable，理由写进
`reason`（读报告的人能看见为什么）。**只在 Claude 路径生效**——DSH/Codex 的
golden 字节零改动（它们的 `failed` 恒 None，走不到这个 override 之外任何分支）。
SV609/610/614 不需要 override：approvals/sandbox_modes timeline 恒空，家族①门控 /
家族④ OR 门控已经如实给 Unavailable。

SV607/608 的 override 放在本模块（dispatcher 层）、不在 `canonical_audit.py`
（共享求值器）——求值器是执行环境无关的，特例一旦进共享代码就再难摘出来。
`claude_audit_projection` 委托共享求值器算三态契约（§10 验收 #4），然后对
rule_outcomes 做 override、重算 `summary.rules_unavailable`。
"""

import functools
import json
from pathlib import Path

from ..paths import user_home

from agent_vitals.adapters import claude_session
from agent_vitals.agent import canonical_audit, claude_evidence, harness_capability


def claude_audit_projection(canonical):
    """family① + family④ 的审计投影：findings + 三态 rule_outcomes + summary。

    委托共享求值器 `canonical_audit.audit_projection`（执行环境无关），然后做唯一的
    Claude 特例：把 SV607/608 从 MeasuredZero 覆盖成 Unavailable（harness-capability
    degradation，`harness_capability.py`——表已下沉，这里是消费方）。**只覆盖
    MeasuredZero**：门控已因 timeline 空给 Unavailable（缺失信号、无需 override）
    或给了 Findings（Claude 不可能，但 override 不吞真命中）时保持原样。覆盖后
    重算 `rules_unavailable`——共享求值器的数已经不反映 degrade 后的状态（健康
    会话 3 → 5）。"""
    proj = canonical_audit.audit_projection(canonical)
    harness_capability.degrade_rule_outcomes("claude-code", proj["rule_outcomes"])
    proj["summary"]["rules_unavailable"] = sum(
        1 for v in proj["rule_outcomes"].values() if v.get("status") == "unavailable")
    return proj


def _session_cmp(a, b):
    """`claude-session --list` 的排序：末行时间戳降序（最新在前），平局按
    session_id 升序；无时间样本排最后（`a.get("last") or ""` 兜底成空串——
    Rust 的 `as_str().unwrap_or("")` 同款，空串恒排最后）。"""
    al = a.get("last") or ""
    bl = b.get("last") or ""
    if bl != al:
        return -1 if bl < al else 1
    sa = a.get("session_id") or ""
    sb = b.get("session_id") or ""
    return (sa > sb) - (sa < sb)


def claude_session_list(home=None):
    """`claude-session --list`：所有会话的行摘要（id/title/model/cwd/首末时间戳），
    按 `_session_cmp` 排序。`model` 取第一条携带 `message.model` 的记录（与
    evidence 的 extract_model 同一惯例）。`home` 默认 `Path.home()`——尊重
    `HOME`（测试用 isolated_home_env 注入）。"""
    if home is None:
        home = user_home()
    sessions = []
    for path in claude_session.claude_project_files(home):
        info = claude_session._file_info(path)
        model = None
        for r in info["records"]:
            if not isinstance(r, dict):
                continue
            message = r.get("message")
            if isinstance(message, dict):
                m = message.get("model")
                if isinstance(m, str):
                    model = m
                    break
        sessions.append({
            "session_id": info["session_id"],
            "title": claude_session._title_of(info["records"]),
            "model": model,
            "cwd": claude_session._cwd_of(info["records"]),
            "first": info["first"],
            "last": info["last"],
        })
    sessions.sort(key=functools.cmp_to_key(_session_cmp))
    return {"harness": "claude-code", "sessions": sessions}


def _render_list(out):
    """`claude-session --list` 的人读呈现。缺席的字段一律 `-`（诚实缺失，不编造）；
    session_id 缺失 → 空串（`{sid:<28}` 留白，同 Rust）。与 Rust
    `render_claude_session_list` 逐字节对齐：`harness: claude-code\\n` +
    `sessions: {n}\\n\\n` + 每行 `"{sid:<28}  {title}  {model}  {first} → {last}\\n"`。"""
    s = "harness: claude-code\n"
    sessions = out.get("sessions")
    sessions = sessions if isinstance(sessions, list) else []
    s += "sessions: %d\n\n" % len(sessions)
    for row in sessions:
        sid = row.get("session_id")
        sid = sid if isinstance(sid, str) else ""
        title = row.get("title")
        title = title if isinstance(title, str) else "-"
        model = row.get("model")
        model = model if isinstance(model, str) else "-"
        first = row.get("first")
        first = first if isinstance(first, str) else "-"
        last = row.get("last")
        last = last if isinstance(last, str) else "-"
        s += "%-28s  %s  %s  %s → %s\n" % (sid, title, model, first, last)
    return s


def claude_session_audit_json(home, session_id):
    """`claude-session` 单会话审计：coverage（§13 逐信号）+ SV601–614 findings。
    `None` = 没有会话文件属于该 session_id，或该 session 的文件 degraded（不可读 /
    无记录）。文件**存在**但读不出记录时绝不能报「空审计」——那是把不可读编成 0 条
    真数据（codex 的 §14.4 back-fill 同款纪律）。

    跨文件按路径序拼接（resume 理论情况）；first/last 取全局 min/max（`first` 只在
    首个匹配文件上取，`last` 每次覆盖——与 Rust `first.is_none()` 分支同构）。

    输出键序是字节一致的一部分（Python 镜像逐字节对齐），不能重排。"""
    records = []
    files = []
    file = None
    first = None
    last = None
    for path in claude_session.claude_project_files(home):
        info = claude_session._file_info(path)
        if info["session_id"] == session_id:
            file = str(path)
            files.append(str(path))
            if first is None:
                first = info["first"]
            last = info["last"]
            records.extend(info["records"])
    if file is None:
        return None
    if not records:
        return None

    evidence = claude_evidence.build_claude_evidence(records, session_id)
    ev = claude_evidence.claude_evidence_json(evidence)
    audit = claude_audit_projection(evidence["canonical"])
    roots = ev["workspace_roots"]
    roots = roots if isinstance(roots, list) else []
    cwd = roots[0] if roots else None
    return {
        "harness": "claude-code",
        "session_id": session_id,
        "title": claude_session._title_of(evidence["raw_records"]),
        "model": ev["model"],
        # 会话实际覆盖跨度（D1–D4）——直接取扁平证据 DTO 的 `span`，不重算。
        # 键位置与 Rust 组装点逐字节对齐（差分门比 claude-session 的输出）。
        "span": ev["span"],
        "cwd": cwd,
        "file": file,
        "files": files,
        "date_span": {"first": first, "last": last},
        "audit": audit,
        "coverage": ev["coverage"],
        "signals": ev["signals"],
        "attempts": ev["attempts"],
        "notes": ev["notes"],
    }
