"""WorkBuddy 单会话审计组合 —— `workbuddy-session` 子命令的数据层（Python 镜像）。

与 Rust `src/agent/workbuddy_session.rs` 的后半段（`workbuddy_session_list` /
`render_workbuddy_session_list` / `workbuddy_audit_projection`（`degrade_sv604_605` 已随 E2 移除）/
`workbuddy_session_audit_json`）逐字节对齐。五段式流水线：locate → shape → extract
（`adapters/workbuddy_session.py`）→ derive → coverage（`agent/workbuddy_evidence.py`）
→ 组合（本模块）。

**SV604/605 的 Unavailable 是本模块的 harness-capability degradation（spec §3.1），
不是 core 规则改动。** WorkBuddy 的 `tool_calls` timeline 只有 bash（audit-log
`commandPreview`）和 web_fetch（`WebFetch` target）两个子集可 join——write/edit
工具调用只存在于会话匿名的 traces（file-history 有内容没路径）。SV604/605 是
"是否写过 workspace 文件"的检测器，在只能看见 bash/web_fetch 的 timeline 上会把
"看不见写操作"空转成 MeasuredZero——那是对「结构上读不到写维度」撒谎（DSH 的
MeasuredZero 是「跑了所有工具、确实没有写」的真测量，WorkBuddy 是「只有两类工具
join 得进来」）。所以这里在 WorkBuddy 路径把 SV604/605 从 MeasuredZero 覆盖成
Unavailable，理由写进 `reason`。**只在 WorkBuddy 路径生效**——Claude/DSH/Codex 的
golden 字节零改动。

SV604/605 的 override 放在本模块（dispatcher 层）、不在 `canonical_audit.py`
（共享求值器）——与 Claude 的 SV607/608 同款纪律：执行环境特例不进共享代码。
`workbuddy_audit_projection` 委托共享求值器算三态契约（spec §10 验收 #4），然后对
rule_outcomes 做 override、重算 `summary.rules_unavailable`（Claude 侧健康会话
3 → 5 同款；WorkBuddy 侧健康会话 5 → 7）。

**成本块直接吃执行环境账单**（spec §6.1/§9）：`session_usage.used`（tokens）+ 解析
`credit_json` 求和——但那求和是**积分（credit），不是人民币**。旧字段名 `cny` 把
积分当货币，1000 积分才 ¥50、单请求积分中位 ~22，约 20× 高估（spec §3.1）。新契约
`{tokens, credits, cash_cny, nominal_cny, nominal_basis, harness_billed}`：`credits`
（诚实单位名，取代旧 `cny` 的同一求和值）+ `cash_cny`（现金口径实付，**恒 None**——
本机无支付证据，填 0 是断言「确实没花」，我们不知道，§11 第 12 条）+ `nominal_cny`
（`credits × 0.05`，公开加量包兑换价折算，落**名义栏**，永不进实付栏/预算分子）+
`nominal_basis`（可追溯的「什么价、什么日期」串）。**pricing.json 零参与**——兑换价
不是模型价卡，不长第四份价格拷贝（spec §11 项 6）。
"""
import functools
import json
import math

from pathlib import Path

from ..paths import user_home

from agent_vitals.adapters import workbuddy_session, workbuddy_traces
from agent_vitals.agent import canonical_audit, harness_capability, workbuddy_evidence


def workbuddy_audit_projection(canonical):
    """family① + family④ 的审计投影：findings + 三态 rule_outcomes + summary。

    委托共享求值器 `canonical_audit.audit_projection`（执行环境无关），然后做唯一的
    WorkBuddy 特例：把 SV604/605 从 MeasuredZero 覆盖成 Unavailable（harness-capability
    degradation，`harness_capability.py`——表已下沉，这里是消费方）。**只覆盖
    MeasuredZero**：门控已因 timeline 空给 Unavailable（缺失信号）或给了 Findings
    （audit-log 里有真命令时 SV601-603 会命中）时保持原样——override 不吞真命中。
    覆盖后重算 `rules_unavailable`——共享求值器的数已经不反映 degrade 后的状态
    （健康会话 5 → 7）。"""
    proj = canonical_audit.audit_projection(canonical)
    harness_capability.degrade_rule_outcomes("workbuddy", proj["rule_outcomes"])
    proj["summary"]["rules_unavailable"] = sum(
        1 for v in proj["rule_outcomes"].values() if v.get("status") == "unavailable")
    return proj


def _session_cmp(a, b):
    """`workbuddy-session --list` 的排序：`updated_at` 降序（最新在前），平局按
    session_id 升序；无时间样本排最后（`a.get("last") or ""` 兜底成空串——Rust 的
    `as_str().unwrap_or("")` 同款，空串恒排最后）。"""
    al = a.get("last") or ""
    bl = b.get("last") or ""
    if bl != al:
        return -1 if bl < al else 1
    sa = a.get("session_id") or ""
    sb = b.get("session_id") or ""
    return (sa > sb) - (sa < sb)


def workbuddy_session_list(home=None):
    """`workbuddy-session --list`：db `sessions` 表是会话索引（真实语料 22 行）——
    每行的 id/title/model/cwd/created/updated，按 `_session_cmp` 排序。audit-log
    独苗会话（db 无行）不进列表（列表是索引不是账本；单会话深挖仍可按 id 审）。
    `home` 默认 `Path.home()`——尊重 `HOME`（测试用 isolated_home_env 注入）。"""
    if home is None:
        home = user_home()
    root = workbuddy_session.workbuddy_root(home)
    db_sessions, db_usage = workbuddy_session.read_workbuddy_db(root)
    sessions = []
    if db_sessions is not None:
        for sid, rec in db_sessions.items():
            meta = workbuddy_session.workbuddy_session_meta(root, sid, rec, db_usage)
            sessions.append({
                "session_id": sid,
                "title": meta["title"],
                "model": meta["model"],
                "cwd": meta["cwd"],
                "first": meta["created_at"],
                "last": meta["updated_at"],
                # B5：生命周期字段原样浮出，只浮出不过滤（spec §10 B5）。
                "lifecycle": workbuddy_session.lifecycle_of(rec),
            })
    sessions.sort(key=functools.cmp_to_key(_session_cmp))
    source_snapshot = workbuddy_session.read_workbuddy_source_snapshot(root)
    # B4：`schema_probe` 追加在 `source_snapshot` 之后的末位（spec §10 B4，
    # 键序是输出契约的一部分，不能重排）。
    schema_probe = workbuddy_session.read_workbuddy_schema_probe(root)
    return {
        "harness": "workbuddy",
        "sessions": sessions,
        "source_snapshot": source_snapshot,
        "schema_probe": schema_probe,
    }


def _render_list(out):
    """`workbuddy-session --list` 的人读呈现。缺席的字段一律 `-`（诚实缺失，不编造）；
    session_id 缺失 → 空串（`{sid:<28}` 留白，同 Rust）。与 Rust
    `render_workbuddy_session_list` 逐字节对齐：`harness: workbuddy\\n` +
    `sessions: {n}\\n\\n` + 每行 `"{sid:<28}  {title}  {model}  {first} → {last}\\n"`。"""
    s = "harness: workbuddy\n"
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


def _timestamp_attempts(db_rec, records, now_secs):
    """spec §6.2 rule 3：db `created_at`/`updated_at` 与 audit-log `timestamp` 里
    归一后越界的 epoch-ms 值——报 null 之外还要留一条 `attempts` 痕迹
    （§14.4：skipped and recorded, never treated as corruption）。**只有
    OutOfWindow 进 attempts**：字符串照走 ISO，其它类型静默 null。

    Rust 镜像 `sources/mod.rs::timestamp_attempts`，逐字节对齐（顺序：先 db 两列，
    再 audit-log 记录序）。"""
    out = []

    def mk(source_id, kind, field, raw):
        return {
            "source_id": source_id,
            "kind": kind,
            "surface": "SessionLog",
            "available": False,
            "error": ("%s: epoch-ms timestamp %s normalizes outside the validity "
                      "window [2000-01-01T00:00:00Z, now+24h]; treated as "
                      "unparseable" % (field, json.dumps(raw))),
            "observed_span": None,
        }

    for field in ("created_at", "updated_at"):
        raw = db_rec.get(field) if isinstance(db_rec, dict) else None
        _, oow = workbuddy_session.normalize_wb_ts(raw, now_secs)
        if oow:
            out.append(mk("workbuddy.db", "Sqlite", "sessions.%s" % field, raw))
    for rec in records:
        raw = rec.get("timestamp") if isinstance(rec, dict) else None
        _, oow = workbuddy_session.normalize_wb_ts(raw, now_secs)
        if oow:
            out.append(mk("workbuddy.audit-log", "LogFile", "audit-log timestamp", raw))
    return out


def _schema_drift_attempts_and_notes(probe):
    """spec §10 B4 的哨兵 surface（单会话审计 JSON only）：`schema_probe` 里任一
    表 `unknown`/`missing` 非空时各推一条 `attempts` + `notes`——「宽进严出：
    机器发现，人来分类」（`CLAUDE.md`）。**只报告，不解释**：消费列仍按名读取，
    未知/缺失列不改变任何测量值。`probe` 为 None（db 不可读）时调用方不进这条
    路径——没有 probe 就没有「漂移」可报，是既有 Unavailable 降级的镜像面，不是
    这里新开一条判断。顺序固定：先 unknown 后 missing（各自 sessions 在前）。
    Rust 镜像 `sources/mod.rs::schema_drift_attempts_and_notes`，逐字节对齐。"""
    attempts = []
    notes = []
    tables = ("sessions", "session_usage")

    def collect(key):
        parts = []
        total = 0
        for t in tables:
            entry = probe.get(t)
            names = entry.get(key) if isinstance(entry, dict) else None
            if names:
                parts.append("%s: %s" % (t, ",".join(names)))
                total += len(names)
        return parts, total

    unknown_parts, unknown_total = collect("unknown")
    if unknown_parts:
        attempts.append({
            "source_id": "workbuddy.db",
            "kind": "Sqlite",
            "surface": "SessionLog",
            "available": True,
            "error": "schema-drift: unknown columns %d (%s)"
                     % (unknown_total, "; ".join(unknown_parts)),
            "observed_span": None,
        })
        notes.append(
            "schema-drift: %d column(s) not in the 2026-09-11 known baseline "
            "— consumed columns are read by name so measurement is "
            "unaffected; the unknown columns are reported, not interpreted"
            % unknown_total)

    missing_parts, missing_total = collect("missing")
    if missing_parts:
        attempts.append({
            "source_id": "workbuddy.db",
            "kind": "Sqlite",
            "surface": "SessionLog",
            "available": True,
            "error": "schema-drift: missing known columns %d (%s)"
                     % (missing_total, "; ".join(missing_parts)),
            "observed_span": None,
        })
        notes.append(
            "schema-drift: %d known column(s) not found on this machine "
            "— an older harness version or a renamed column is possible; "
            "any consumed column among the missing ones already degrades to "
            "null by the existing missing-column-reports-null rule"
            % missing_total)

    return attempts, notes


def _to_cents(value):
    """credit_json 单条**积分**值 → 厘（int）。按厘累计再除 100，规避浮点逐条相加的漂移；
    int/float/数字字符串都认（真实 credit_json 里值可能是字符串），布尔与
    非数字 → 0（记账缺口报缺，不把垃圾算进成本）。"""
    if isinstance(value, bool):
        return 0
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0
    if math.isnan(f) or math.isinf(f):
        return 0
    return int(round(f * 100))


def _credit_cents(cj):
    """credit_json 里所有 requestId 值求和 → 厘（int）。空串/空格串/非法 JSON/非
    对象 → 0。`_cost_of` 与 `_is_unbilled_to_credits` 共用这一把求和。"""
    cents = 0
    parsed = None
    if isinstance(cj, str) and cj.strip():
        try:
            parsed = json.loads(cj)
        except json.JSONDecodeError:
            parsed = None
    if isinstance(parsed, dict):
        for v in parsed.values():
            cents += _to_cents(v)
    return cents


# 公开加量包兑换价：1000 积分 = 50 CNY，2026-07-01 起。名义栏度量换算（§5.1/§6.1），
# 不是价卡、不进实付栏或预算分子。汇率变了改这个串，不改静默数字。
_WB_NOMINAL_BASIS = "pack-price-public:1000cr=50CNY@2026-07-01"

# 非积分轨会话（`used` 有值、credit 求和 0）的诚实注记。`credits: 0.0` 是真测量
# （平台积分轨确实没消耗），不是「没花钱」——真实开销在用户自配 API 账户、本机不可
# 观测，这条 note 承担那层意思（spec §6.1、§11 第 14 条）。
# spec §2.1：**绝不指认成因**。旧串断言「钱花在用户自有 API 账户」——真机当场
# 证伪：`hy3` 是平台内置模型、根本没有自配路由可走，却有零积分会话，用户
# 2026-09-11 给出真相是**平台推广自家模型的限免**（真免费，不存在那笔支出）。
# 零积分至少三种成因且本机不可分辨，适配器的职责到「未计入积分」为止。
_WB_UNBILLED_TO_CREDITS_NOTE = (
    "session not billed to credits: the platform credit ledger recorded no "
    "consumption (credits: 0.0 is a real measurement). The cause is NOT "
    "determinable from this machine \u2014 a self-configured route, a promotional "
    "free tier, and harness-side non-billing are indistinguishable here."
)

# spec §6.1/§9E.5 E5 的 `cost.tokens` 语义注记：`used` 是 session_usage 里**最后
# 一次调用的上下文占用 prompt_tokens 快照**（§9E.5 E5 实测 22/22：16 逐字
# 相等、1 个 ±0.5%、5 偏离），**不是 processed token 总量**——真处理量在 cost.processed_tokens
# （traces 四桶之和，无 trace 证据时 null）。键保留，语义由 note 承担。Rust
# `sources/mod.rs::WB_TOKENS_ARE_LAST_CALL_NOTE` 字节一致。
_WB_TOKENS_ARE_LAST_CALL_NOTE = (
    "cost.tokens = session_usage.used: the last generation call's prompt_tokens "
    "snapshot (context size), not a processed-token total \u2014 the session's "
    "processed tokens are cost.processed_tokens (four-bucket sum of the trace "
    "generation spans)."
)


# spec §10 B5：`lifecycle` 非 None 时附在 `notes` 的诚实注记——五个字段是原样
# 浮出，其取值词表执行环境未声明，所以这里不据其值过滤任何会话；过滤是消费方的
# 决定。Rust `sources/mod.rs::WB_LIFECYCLE_NOTE` 字节一致。
_WB_LIFECYCLE_NOTE = (
    "lifecycle fields (status / source_mode / is_playground / deleted_at / "
    "is_background_automation) are surfaced verbatim; their value vocabularies "
    "are not declared by the harness, so no session is filtered on them here \u2014 "
    "filtering is the consumer's decision"
)


def _processed_tokens_from_spans(spans):
    """会话 traces 的 processed token 四桶之和（E5）：遍历该会话的 generation
    span，每个有 usages 的 span 取第一条 usage（与 E4a emitter 同一挑选），
    四桶 = uncached(prompt−cached, 下限 0) + cache_read(cached) + cache_write(0)
    + output(completion)。**traces 目录缺失 → None**（诚实无观测，不借 0）；
    目录存在但 span 无 usage（全取消/全解码失败）→ 0，真测量零（与
    traces_probe 零值对象同口径）。decode_failed 的 span 不进（usage 不可读）。
    Rust `sources/mod.rs::processed_tokens_from_spans` 逐字节对齐。"""
    total = 0
    any_generation = False
    for span in spans:
        if span.get("kind") != "generation":
            continue
        any_generation = True
        usages = span.get("usages") or []
        if not usages:
            continue
        u = usages[0]
        prompt = u.get("prompt_tokens") or 0
        cached = u.get("cached_tokens") or 0
        completion = u.get("completion_tokens") or 0
        total += max(prompt - cached, 0) + cached + completion
    return total if any_generation else None


def _cost_of(meta, processed_tokens):
    """spec §6.1 cost 块，键序 `{tokens, processed_tokens, credits, cash_cny,
    nominal_cny, nominal_basis, harness_billed}`（docs §9E.5 E5：processed 是新成员）。
    tokens = `used`（session_usage 的**最后调用上下文 prompt_tokens 快照**，不是
    processed 总量，语义见 note）；processed_tokens = traces 四桶之和（无 trace
    证据 → None，不编 0）；credits = credit_json 求和（**积分**，不是货币）；
    cash_cny 恒 None（本机无支付证据，绝不填 0）；nominal_cny = credits × 0.05
    （名义栏输入，不入实付/预算分子）。usage 行缺失且 credit_json 空 → None（诚实
    缺失，不编 0）。"""
    used = meta.get("used")
    cj = meta.get("credit_json")
    if used is None and not cj:
        return None
    tokens = used if isinstance(used, int) and used >= 0 else 0
    cents = _credit_cents(cj)
    # 名义人民币 = credits × 0.05；按整数点（cents × 0.05）再 round，与 credit 求和
    # 同一防浮点漂移手法。Python `round` 银行家舍入 vs Rust `round()` 半数向上——
    # 差异只在 x.5，兑换价 × 0.05 不落 x.5（fixture 与真实账单均无），可接受。
    nominal_cents = int(round(cents * 0.05))
    return {
        "tokens": tokens,
        "processed_tokens": processed_tokens,
        "credits": cents / 100.0,
        "cash_cny": None,
        "nominal_cny": nominal_cents / 100.0,
        "nominal_basis": _WB_NOMINAL_BASIS,
        "harness_billed": True,
    }


def _is_unbilled_to_credits(meta):
    """`used` 有值但 credit 求和为 0（credit_json 空/缺/空对象）。与 `_cost_of` 的
    「整块 None」降级互斥——那条还要求 `used` 也缺失。"""
    return meta.get("used") is not None and _credit_cents(meta.get("credit_json")) == 0


def workbuddy_session_audit_json(home, session_id):
    """`workbuddy-session` 单会话审计：coverage（§13 逐信号）+ SV601–614 findings +
    成本块。`None` = db 无该会话行 **且** audit-log 无该 sessionId 的记录（两面都
    没有 → 不存在，不可审）。**db 有行但 audit-log 无记录 → 照审**（真会话、
    决策账本为空是诚实结果；不是不可读）。audit-log 独苗会话（db 无行）→ 照审，
    元数据降级 None（缺列报缺）。

    输出键序是字节一致的一部分（Python 镜像逐字节对齐），不能重排。"""
    root = workbuddy_session.workbuddy_root(home)
    db_sessions, db_usage = workbuddy_session.read_workbuddy_db(root)
    recs_by_session, file_of, degraded = workbuddy_session.read_workbuddy_audit_log(root)
    db_rec = None
    if db_sessions is not None:
        db_rec = db_sessions.get(session_id)
    records = recs_by_session.get(session_id, [])
    if db_rec is None and not records:
        return None

    meta = workbuddy_session.workbuddy_session_meta(root, session_id, db_rec, db_usage)
    # E1/E2：traces 读取层。目录不存在 → 探针 None、spans 空；存在 → 本会话的 span
    # 折进 evidence（E2），探针照报。全量读，真机 ~686MB——E4 的索引落地前接受。
    if workbuddy_traces.workbuddy_traces_root(root).is_dir():
        traces_read = workbuddy_traces.read_workbuddy_traces(root)
    else:
        traces_read = None
    spans = (workbuddy_traces.session_spans(traces_read, session_id)
             if traces_read is not None else [])
    evidence = workbuddy_evidence.build_workbuddy_evidence(records, session_id, meta, spans)
    ev = workbuddy_evidence.workbuddy_evidence_json(evidence)
    audit = workbuddy_audit_projection(evidence["canonical"])
    roots = ev["workspace_roots"]
    roots = roots if isinstance(roots, list) else []
    cwd = roots[0] if roots else None

    # degraded 的 audit-log 文件若正是本会话的主账本文件，把账本缺口 surface 进
    # attempts（§14.4：skipped and recorded, never treated as corruption）。
    attempts = list(ev["attempts"])
    fpath = file_of.get(session_id)
    if fpath is not None:
        for path_str, reason in degraded:
            if str(path_str) == str(fpath):
                attempts.append({
                    "source_id": "workbuddy.audit-log",
                    "kind": "LogFile",
                    "surface": "SessionLog",
                    "available": False,
                    "error": "audit-log/%s: %s"
                             % (Path(path_str).name, reason),
                    "observed_span": None,
                })
                break
    attempts.extend(_timestamp_attempts(db_rec, records,
                                        workbuddy_session.now_unix_secs()))

    # `file` = 主账本文件（审计据以计算的 audit-log）；db 独苗会话无审计记录 →
    # db 路径兜底（会话锚点所在）。date_span = audit-log 记录 min/max，无记录 →
    # db created/updated 兜底（adapter.date_span_of）。
    file = fpath if fpath is not None else (str(root / "workbuddy.db")
                                            if db_rec is not None else None)
    date_span = workbuddy_session.date_span_of(records, meta)

    # E5：cost 块不再只吃 db——processed_tokens 来自本会话 traces 的四桶之和
    # （无 trace 证据 → None，不编 0）；tokens 语义由 note 承担。镜像 Rust：note
    # 夹在基线 note 与 unbilled/lifecycle 之间，同序。
    processed_tokens = _processed_tokens_from_spans(spans)

    notes = list(ev["notes"])
    if _cost_of(meta, None) is not None:
        notes.append(_WB_TOKENS_ARE_LAST_CALL_NOTE)
    # 非积分轨会话：`credits: 0.0` 是真测量，但真实开销在用户自配 API 账户、本机
    # 不可见——由 note 承担那层意思，不由数字冒充（spec §11 第 14 条）。
    if _is_unbilled_to_credits(meta):
        notes.append(_WB_UNBILLED_TO_CREDITS_NOTE)

    traces_probe = (workbuddy_traces.traces_probe_json(traces_read, session_id)
                    if traces_read is not None else None)

    # B5：生命周期字段（spec §10 B5）。db 行缺失（audit-log 独苗会话）→ None，
    # 不追加 note——没有行就没有可浮出的生命周期状态。
    # **压在 B4 漂移 note 之前**：lifecycle 是会话自身状态的注记，schema-drift 是
    # 库级诊断——B4 的回归钉住「漂移 note 严格追加在 notes 末尾」，这里不能插队。
    lifecycle = workbuddy_session.lifecycle_of(db_rec)
    if lifecycle is not None:
        notes.append(_WB_LIFECYCLE_NOTE)

    # B4：schema 哨兵。probe 为 None（db 不可读）时没有「漂移」可报——两个 db
    # 表面（sessions/session_usage）已经在别处降级，这里不再重复一条 attempts。
    schema_probe = workbuddy_session.read_workbuddy_schema_probe(root)
    if schema_probe is not None:
        drift_attempts, drift_notes = _schema_drift_attempts_and_notes(schema_probe)
        attempts.extend(drift_attempts)
        notes.extend(drift_notes)

    return {
        "harness": "workbuddy",
        "session_id": session_id,
        "title": meta["title"],
        "model": ev["model"],
        # 会话实际覆盖跨度（D1–D4）——直接取扁平证据 DTO 的 `span`，不重算。
        # 键位置与 Rust 组装点逐字节对齐。
        "span": ev["span"],
        "cwd": cwd,
        "file": file,
        "date_span": date_span,
        "audit": audit,
        "coverage": ev["coverage"],
        "signals": ev["signals"],
        "attempts": attempts,
        "cost": _cost_of(meta, processed_tokens),
        "notes": notes,
        "source_snapshot": workbuddy_session.read_workbuddy_source_snapshot(root),
        "schema_probe": schema_probe,
        "lifecycle": lifecycle,
        # E1：traces 探针（末位，spec §9E.5）。目录不存在 → None；存在但本会话无 trace
        # → 零值对象（真测量）。全量读，真机 ~686MB——E4 的索引落地前接受。
        "traces_probe": traces_probe,
    }
