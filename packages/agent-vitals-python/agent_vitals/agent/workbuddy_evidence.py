"""WorkBuddy 适配器的 "derive → coverage" 两段（五段式流水线 locate → shape →
extract → derive → coverage，"locate → shape → extract" 留在
`scripts/agent_vitals/adapters/workbuddy_session.py`，I/O 不在这里）。它把
`~/.workbuddy/audit-log/*.jsonl` 里按 `sessionId` 分组出的原始记录 + db/file-history
拆出的 `session_meta` 折成 `evidence::CanonicalSession` 的等价字典，覆盖计数按
`docs/WORKBUDDY_INTEGRATION.md` §3 矩阵逐信号对应。

与 Rust `crates/agent-vitals-harnesses/src/harnesses/workbuddy/sessions/evidence.rs` 逐字节对齐——产出同一个
`workbuddy_evidence_json` 输出字典（键序一致），`tests/test_cli_matrix.py::both()`
的差分靠这份一致把关。

**audit-log 只喂三条 timeline（approvals/sandbox_modes 非空，turns 恒空）。** 五条
timeline 里：`tool_calls` 只有 bash 子集（`command-safety.sandbox-executed` 的
`commandPreview`）+ `web_fetch`（`network`+`WebFetch` 的 `messageParams.target`）可
join——write/edit 只在匿名 traces 里（spec §3）；`approvals` 由
`approval`/`rejection`+`Bash`、`file-safety`+`bulk-delete.*` 喂（spec §7 决策映射）；
`sandbox_modes` 由 `command-safety.sandbox-executed` 喂（mode = WorkBuddy
原生的 `permission_mode`，**不翻译成 DSH 的 danger-full-access**，spec §3.3）；
`turns` **恒空**——没有 turn 结构，把 distinct requestId 硬填成 turn 就是发明不存在
的边界，SV612/613 靠 timeline_is_empty 诚实 Unavailable（spec §8）。

**决策映射不双计。** 审批/拒绝记录只进 approvals 轴；sandbox-executed 才进
tool_calls + sandbox 轴。被批准的命令是否另有执行记录不可靠，两条记录之间不做
join（spec §7）。

**audit-log 按 `sequence` 排序。** 记录可能来自多个并发 spool 文件，`sequence` 是
执行环境原生顺序（实测有跳号，来自并发写）。排序键 = `(sequence or MAX, 文件内序)`；
输出 `seq` = 排序后的下标（会话内序，同 Claude 的 `seq = ordinal` 惯例）。

**`session_meta` 携带 db/file-history 拆出的会话级数据**（I/O 层拆好传进来）：
`{permission_mode, use_sandbox_cli, model, cwd, used, credit_json, file_mutations,
title}`。db 缺失的列 → 对应信号降级 Unavailable（缺列报缺，编列害人），绝不编一个
非零数字出来。
"""

import json
import math

from agent_vitals.agent.claude_evidence import parse_iso
from ..util import session_span

# epoch 秒的固定合法性窗口（spec §10 A6）：`[2000-01-01, 2100-01-01)`。
# `adapters/workbuddy_session.py` 那侧在 I/O 层、能读时钟，用的是 `now + 24h`
# 上界；这个模块是纯的（Rust 镜像可链进 wasm），读不了时钟，退一步用固定的
# 2100 上界，与 Rust `evidence.rs::{WB_TS_MIN_SECS, WB_TS_MAX_SECS}` 同值。
_WB_TS_MIN_SECS = 946684800    # 2000-01-01T00:00:00Z
_WB_TS_MAX_SECS = 4102444800   # 2100-01-01T00:00:00Z

# 20 个 Signal 的声明序——`signals` 数组 / `coverage` 字典的输出顺序都靠这份显式
# 表对齐（与 Rust `workbuddy_evidence.rs::ALL_SIGNALS` 同表同序），不靠 Python
# 的任意 set 迭代序。与 claude_evidence / codex_evidence 同一张表。
ALL_SIGNALS = (
    "ToolCalls",
    "ToolResults",
    "TurnBoundaries",
    "StepBoundaries",
    "Usage",
    "UsageAggregate",
    "ContextWindow",
    "QuotaConsumption",
    "ApprovalDecisions",
    "ApprovalPolicy",
    "SandboxModes",
    "SandboxPolicy",
    "NetworkAccess",
    "Compaction",
    # E2 前 Python 侧漏了 SubagentSpawns（Rust ALL_SIGNALS 一直有）——它恒 unavailable
    # 时 `_UNAVAILABLE_SIGNALS` 的循环顺手把键塞进 coverage，掩盖了缺口；E2 让它可测，
    # 缺口当场暴露（KeyError）。按 Rust 序补齐。
    "SubagentSpawns",
    "SkillInvocations",
    "Hooks",
    "FileMutations",
    "UserPrompts",
    "UserCorrections",
)

# audit-log 已知的 (category, eventType) 对——**WorkBuddy 自己的决策轴就是
# category**（轴名 + 全限定 eventType），真机词表（2026-09-02 全量 2,563 条实测）：
# 命令进沙箱 `command-safety`+`command-safety.sandbox-executed`、网页抓取
# `network`+`WebFetch`、批量删除 `file-safety`+`file-safety.bulk-delete.*`、
# 审批/拒绝 `approval`/`rejection`+`Bash`。其余对记成 SourceAttempt，绝不当作
# 损坏吞掉——审计账本可能还有没被本机语料触发的路径，吞掉就是假装账本干净。
#
# 曾用纸面词表（'sandbox-executed'/'commandApproved'/'bulk-delete.*' 裸名）当
# 白名单——真机零命中，2,471/2,563 条记录全被当 unknown 丢掉（ToolCalls 只剩
# WebFetch 的 75 条），差分门禁过了是因为 fixture 写的也是纸面词。§14.4 的
# schema-drift sentinel（skipped and recorded）当时照实报了 attempts——哨兵没
# 错，错在白名单本身。分类键必须用执行环境自己的判别器，见
# docs/WORKBUDDY_INTEGRATION.md §2.2 的漂移注记。
KNOWN_EVENT_TYPES = frozenset((
    ("command-safety", "command-safety.sandbox-executed"),
    ("network", "WebFetch"),
    ("file-safety", "file-safety.bulk-delete.needs-approval"),
    ("file-safety", "file-safety.bulk-delete.approved"),
    ("file-safety", "file-safety.bulk-delete.rejected"),
    ("approval", "Bash"),
    ("rejection", "Bash"),
))

# spec §3 明确 unavailable / 没有对应列的信号（WorkBuddy 列）。`derive_coverage`
# 的置零与 `workbuddy_evidence_json` 的 `available` 标记共用这一份清单，不准两处
# 各写一份漂移。
#
# - ToolResults / SubagentSpawns **不在**这个集合里（spec §9E.5 E2，2026-09-11）：
#   traces 可按 `trace.sessionId` 归属（B2），function span 的 status/error →
#   tool_results，agent span → SubagentSpawns。此前「接不进 session」是 09-02 的
#   分析错误；
# - TurnBoundaries **不在**这个集合里——它按 distinct requestId 派生 coverage
#   （lossy 下界，available=true），但 turns timeline 恒空（spec §8）；
# - Usage：无逐请求 token（traces 只有 trace 级 totalTokens）；UsageAggregate
#   反而 measured（session_usage.used，spec §9）；
# - SandboxPolicy：use_sandbox_cli 是常量（恒 1），不是结构化策略事件；
# - QuotaConsumption **不在**这个集合里（spec §10 B6，2026-09-11）：`credit_json`
#   的每个 requestId 条目就是一次「执行环境报告的配额消耗」——分子 measured；分母
#   （allowance/余额）在服务端账户面、本机不可观测，由 note 说明，不出百分比。
#   此前把它声明成 unavailable 是错的——那是「有证据却不计」。§13 矩阵文档滞后，
#   按 G5 流程在 tests/test_harness_contract.py::_REGISTERED_DEVIATIONS 登记；
# - SubagentSpawns / SkillInvocations / Hooks / UserPrompts / UserCorrections /
#   ContextWindow / StepBoundaries / Compaction：只存于 traces（可按
#   `trace.sessionId` 归属但现有实现未接，Phase E）或根本不在会话面上。
_UNAVAILABLE_SIGNALS = (
    "StepBoundaries",
    "Usage",
    "ContextWindow",
    "SandboxPolicy",
    "Compaction",
    "SkillInvocations",
    "Hooks",
    "UserPrompts",
    "UserCorrections",
)

# 各 note 的说明文本——与 Rust 逐字节相同，差分测试靠它。
_TURN_BOUNDARY_NOTE = (
    "turn boundaries are derived from distinct audit-log requestId (a lower "
    "bound: audit-log is not a per-request ledger); native turn structure is "
    "absent, so SV612/613 are Unavailable, never fabricated boundaries."
)
_SANDBOX_MODE_NOTE = (
    "sandbox mode is the WorkBuddy-native permission_mode (bypassPermissions / "
    "fullAccess); the DSH danger-full-access vocabulary does not apply, so SV610 "
    "is an honest MeasuredZero, never a translation."
)
# spec §10 B6：分子可测、分母不可观测——只报绝对量，不出百分比（§6.6「无法证明
# 完整时不编百分比」同款）。与 Rust 逐字节相同。
_QUOTA_CONSUMPTION_NOTE = (
    "quota consumption is measured from credit_json entries (one per billed "
    "request); the allowance / balance that would give a percentage lives on the "
    "account plane and is not observable on this machine, so only the absolute "
    "consumption is reported"
)

# traces 是「已知但刻意不用的表面」（spec §12.2）——会话匿名，join 不进 session。
# 记成 SourceAttempt（§14.4：skipped and recorded, never treated as corruption）。
# spec §9E.5 E2/E3：traces 已按 `trace.sessionId` 归属并折进 timeline（B2 推翻了
# 「session-anonymous」）。**Bash function span 永不进 tool_calls**（E3 裁决，2026-09-11
# 真机实测）：audit-log `toolCallId`（call_00_…）与 span `spanId`（span_…）两套命名
# 空间、0/2,398 可 join；sandbox-executed 2,398 vs Bash span 1,661（traces 按 pid 存、
# 轮转丢失约 30%）；命令文本 59% 相等——模糊 join 就是猜。audit-log 是 Bash 唯一源。
# 代价如实：Bash 的 status/duration 无键可挂 → Bash 没有 tool_results。与 Rust 逐字节相同。
_TRACES_FOLDED_NOTE_PREFIX = "traces folded via trace.sessionId: "

# §7 工具名规范化（与 claude_evidence.py 同一张表，WorkBuddy 的 toolName 是同一套
# PascalCase）。未映射的原样透传。**Bash 不在这里处理**（E2 排除在 tool_calls 外）。
_SPAN_TOOL_NAMES = {
    "Write": "write", "Edit": "edit", "MultiEdit": "edit", "Read": "read",
    "Glob": "glob", "Grep": "grep", "WebFetch": "web_fetch", "WebSearch": "web_search",
    "Task": "task",
}


def _normalize_span_tool_name(name):
    return _SPAN_TOOL_NAMES.get(name, name)


def _span_time(span):
    """span 的 ISO 毫秒串 → unix 秒。走 `parse_iso` 的字符串路径（A2）；解不出 → None。"""
    s = span.get("started_at")
    if not isinstance(s, str):
        return None
    r = parse_iso(s)
    return r[0] if r is not None else None


def _sort_spans(spans):
    """确定性顺序 `(started_at, span_id)`——同一毫秒内多个 span 靠 span_id 定序。"""
    objs = [s for s in spans if isinstance(s, dict)]
    return sorted(objs, key=lambda s: (s.get("started_at") if isinstance(s.get("started_at"), str) else "",
                                       s.get("span_id") if isinstance(s.get("span_id"), str) else ""))


def _timeline_entry(observation, seq, time, call_id, ordinal):
    """一条 timeline entry 的构造器。`turn`/`step` 恒 None——WorkBuddy 无 turn/step
    结构；`time` = audit-log timestamp 归一后的 unix 秒（字符串走 `parse_iso`、
    整数/浮点按 epoch 毫秒解释，见 `_parse_time`；无效则 None）。"""
    return {"observation": observation, "seq": seq, "time": time, "turn": None,
            "step": None, "call_id": call_id, "ordinal": ordinal}


def _text(record, key):
    value = record.get(key)
    return value if isinstance(value, str) else ""


def _seq_of(record):
    """audit-log `sequence` 字段 → int（int 或数字字符串），否则 None。只认纯
    ASCII 数字，与 `claude_evidence._num` 同纪律（不宽容出 Rust 不会给的值）；
    非 dict 记录 → None（排序兜底，不崩溃）。"""
    if not isinstance(record, dict):
        return None
    value = record.get("sequence")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value and value.isascii() and value.isdigit():
        return int(value)
    return None


def _sort_records(records):
    """按 `(sequence or MAX, 文件内序)` 排序。并发 spool 写的跳号不影响顺序；
    缺 sequence 的记录排最后、内部保输入序。

    负 sequence 按缺处理（排最后）——Rust 侧曾是 `seq as u64`（负 i64 回绕成
    巨大正数），与本实现的负 int 自然排最前排序相反，是「同一字典」的一个隐藏
    分歧（评审 P3-7）；`seq >= 0` 检查让两侧一致地把负值当缺失。"""
    def key(t):
        seq = _seq_of(t[1])
        return (seq if seq is not None and seq >= 0 else 2 ** 63, t[0])
    return sorted(enumerate(records), key=key)


def _command_preview(record):
    """sandbox-executed 的完整 bash 命令 → SV601-603 的 args_text（spec §3）。"""
    return _text(record, "commandPreview")


def _target_of(record):
    """WebFetch 的 `messageParams.target` URL → SV606 的 args_text。"""
    params = record.get("messageParams")
    if isinstance(params, dict):
        target = params.get("target")
        if isinstance(target, str):
            return target
    return ""


def _message_key(record):
    """审批/拒绝记录的 `messageKey` → ApprovalAsked.reason（spec §7）。"""
    return _text(record, "messageKey")


def _record_key(record):
    """(category, eventType) 对——分类键。WorkBuddy 的记录 schema 里 category 就是
    决策轴（command-safety / network / file-safety / approval / rejection），
    eventType 是轴内路径（真机实测：命令类是 `command-safety.sandbox-executed`
    全限定名，审批类是裸工具名 `Bash`）。按对键分类才用得上执行环境自己的判别器；
    只按 eventType 裸词建白名单正是 2026-09-02 真机事故的根源（见 KNOWN_EVENT_TYPES
    的漂移注记）。"""
    return (_text(record, "category"), _text(record, "eventType"))


def _approval_tool(record):
    """审批记录的 tool_name：approval/rejection 轴（真机 eventType='Bash'）→
    bash；file-safety 批量删除 → bulk_delete。旧实现按 `startswith('command')`
    猜 eventType——真机审批记录是裸 `Bash`，会被错标成 bulk_delete。"""
    return ("bash" if _text(record, "category") in ("approval", "rejection")
            else "bulk_delete")


def _parse_time(record):
    """audit-log `timestamp` → 该 entry 的 `time`（unix 秒；`time` 字段是
    整数或 None，从来不是 ISO 串）。

    - **字符串** → 既有 `parse_iso` 路径，**原样不回归**。
    - **整数/浮点** → 按 epoch **毫秒**解释（真机 `~/.workbuddy/audit-log/*.jsonl`
      的 `timestamp` 是 13 位 epoch-ms 整数，2026-09-10 实测），floor-除 1000 归一
      到秒——与 Rust `evidence.rs::parse_time` 的 `i64::div_euclid(1000)` /
      `(f / 1000.0).floor()` 逐字节对齐；落在固定窗口 `[2000-01-01, 2100-01-01)`
      之外 → None（纯层无 `attempts` 汇，只 null）。
    - **其余类型（bool/null/object）/缺失** → None。

    旧实现只收字符串（`isinstance(ts, str)`），整数一律 None——于是有 findings 的
    会话里每条 finding 的 `time` 是 null（评审 A6：与 Rust 同一 commit，否则
    `both()` 差分转红）。**不做秒/毫秒位数嗅探**（spec §6.2 rule 5）。"""
    ts = record.get("timestamp")
    if isinstance(ts, str):
        parsed = parse_iso(ts)
        return parsed[0] if parsed is not None else None
    # bool 是 int 的子类——必须先短路（否则 True // 1000 = 0 → 归一成 1970）。
    if isinstance(ts, bool):
        return None
    if isinstance(ts, int):
        secs = ts // 1000
    elif isinstance(ts, float):
        if not math.isfinite(ts):
            return None
        secs = math.floor(ts / 1000.0)
    else:
        return None
    if secs < _WB_TS_MIN_SECS or secs >= _WB_TS_MAX_SECS:
        return None
    return secs


def _chain_note(records):
    """audit-log `prevHash→hash` 链的完整性 note（spec §2.3/§4）。只做**结构校验**
    （`records[i+1].prevHash == records[i].hash`），不重算 hash 算法。轮转诚实
    标注：首条 prevHash 非空且匹配不到任何记录 → 「最老记录可能被轮转，链从
    seq=F 起验证」。头 prevHash 空 = 该记录是已知起点（干净链）。"""
    seqs = []
    for idx, rec in _sort_records(records):
        if not isinstance(rec, dict):
            continue
        seq = _seq_of(rec)
        seqs.append((idx, seq if seq is not None else idx, rec))
    if not seqs:
        return None
    first_seq = seqs[0][1]
    if len(seqs) == 1:
        return ("audit-log hash chain: 1 record, no links to verify "
                "(verified from seq=%s)" % first_seq)
    hashes = {_text(rec, "hash") for _, _, rec in seqs}
    head_prev = _text(seqs[0][2], "prevHash")
    for i in range(len(seqs) - 1):
        cur_hash = _text(seqs[i][2], "hash")
        nxt_prev = _text(seqs[i + 1][2], "prevHash")
        if cur_hash and nxt_prev != cur_hash:
            return ("audit-log hash chain broken at seq=%s (prevHash does not "
                    "match hash of seq=%s)" % (seqs[i + 1][1], seqs[i][1]))
    if head_prev and head_prev not in hashes:
        return ("audit-log hash chain verified from seq=%s: oldest records may "
                "be rotated (first prevHash has no predecessor)" % first_seq)
    return ("audit-log hash chain continuous: %d records (verified from seq=%s)"
            % (len(seqs), first_seq))


def _populate_workbuddy_timelines(records, session_meta, spans):
    """跑一遍（按 sequence 排序后的）audit-log 记录，翻译成五条 harness-neutral
    timeline（spec §7 决策映射）：
    - `tool_calls`：`command-safety`+`command-safety.sandbox-executed` → bash
      （commandPreview）；`network`+`WebFetch` → web_fetch（messageParams.target）。
    - `approvals`：`approval`/`rejection`+`Bash`、`file-safety`+`bulk-delete.*` →
      asked（tool_name + messageKey），approved/rejected 再补 decided
      （allowed-once/rejected）。needs-approval 只有 asked。
    - `sandbox_modes`：`command-safety.sandbox-executed` → mode = permission_mode
      （原生值，不翻译）。
    - `turns`/`tool_results`：恒空（spec §3/§8）。

    返回 `(timelines, unknown)`。`seq` = 排序后的下标（会话内序）。"""
    tool_calls, tool_results, approvals, sandbox = [], [], [], []
    unknown = []
    mode = session_meta.get("permission_mode")
    mode = mode if isinstance(mode, str) else None
    # `next_ordinal` 与 `rec_idx` 是两把不同的尺：rec_idx = 排序后下标（`seq`
    # 坐标），next_ordinal = 跨五条 timeline 的 entry 唯一序（`evt-{ordinal}`
    # 契约）。sandbox-executed 一条记录产 **2 条** entry（tool_calls + sandbox），
    # 曾共用记录序——bridge 后撞出重复 `evt-{n}`。
    next_ordinal = [0]

    def take_ordinal():
        o = next_ordinal[0]
        next_ordinal[0] += 1
        return o

    for rec_idx, (_, record) in enumerate(_sort_records(records)):
        if not isinstance(record, dict):
            # 非对象记录没有 eventType 可归类——静默跳过等于让证据消失（评审
            # P4-13：skipped and recorded, never treated as corruption）。记进
            # `unknown` 由 SourceAttempt 上报（与 `_derive_coverage` 的同款缺口
            # 一起修，两个 unknown 合并时去重）。
            msg = "non-object audit-log record"
            if msg not in unknown:
                unknown.append(msg)
            continue
        key = _record_key(record)
        if key not in KNOWN_EVENT_TYPES:
            msg = "unknown audit-log event (category=%s, eventType=%s)" % key
            if msg not in unknown:
                unknown.append(msg)
            continue
        seq = rec_idx
        time = _parse_time(record)
        call_id = record.get("toolCallId")
        call_id = call_id if isinstance(call_id, str) else None
        if key == ("command-safety", "command-safety.sandbox-executed"):
            tool_calls.append(_timeline_entry(
                {"name": "bash", "args_text": _command_preview(record)},
                seq, time, call_id, take_ordinal()))
            sandbox.append(_timeline_entry({"mode": mode}, seq, time, call_id,
                                          take_ordinal()))
        elif key == ("network", "WebFetch"):
            tool_calls.append(_timeline_entry(
                {"name": "web_fetch", "args_text": _target_of(record)},
                seq, time, call_id, take_ordinal()))
        else:
            observation = {
                "asked": {"tool_name": _approval_tool(record),
                          "reason": _message_key(record)},
            }
            if key in (("approval", "Bash"),
                       ("file-safety", "file-safety.bulk-delete.approved")):
                observation["decided"] = {"outcome": "allowed-once"}
            elif key in (("rejection", "Bash"),
                         ("file-safety", "file-safety.bulk-delete.rejected")):
                observation["decided"] = {"outcome": "rejected"}
            approvals.append(_timeline_entry(observation, seq, time, call_id,
                                             take_ordinal()))

    # E2：traces 的 function span → tool_calls + tool_results（Measured）。**Bash 排除**
    # （E3 定主源前不双计）。args_text 只放 `{"file_path": …}`——SV604/605 的正则读它；
    # 其余 input 一律不进（§4 不要正文）。tool_results：`failed` = status≠ok 或 error
    # 非空；`error_code` = 执行环境原生 status，**不翻译成 DSH 码集**——SV607/608 照跑
    # 零命中是诚实 MeasuredZero（Codex `exit_code:N` 同款纪律）。
    for span in _sort_spans(spans):
        if span.get("kind") != "function":
            continue
        tool = span.get("tool_name")
        if not isinstance(tool, str) or not tool or tool == "Bash":
            continue
        call_id = span.get("span_id") if isinstance(span.get("span_id"), str) else None
        time = _span_time(span)
        fp = span.get("file_path")
        # 与 Rust `serde_json::json!({"file_path": fp}).to_string()` 逐字节一致：
        # 紧凑分隔符、不转义非 ASCII。
        args_text = (json.dumps({"file_path": fp}, ensure_ascii=False, separators=(",", ":"))
                     if isinstance(fp, str) else "")
        tool_calls.append(_timeline_entry(
            {"name": _normalize_span_tool_name(tool), "args_text": args_text},
            None, time, call_id, take_ordinal()))
        status = span.get("status") if isinstance(span.get("status"), str) else ""
        err = span.get("error")
        has_error = isinstance(err, str) and err != ""
        not_ok = status != "" and status != "ok"
        tool_results.append(_timeline_entry(
            {"failed": not_ok or has_error, "error_code": status if not_ok else None},
            None, time, call_id, take_ordinal()))

    return {
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "approvals": approvals,
        "sandbox_modes": sandbox,
        "turns": [],
    }, unknown


def _total(counts):
    return counts["measured"] + counts["derived"] + counts["lossy"] + counts["unmetered"]


def _bump(coverage, signal, bucket, n=1):
    coverage[signal][bucket] += n


def _credit_entry_count(credit_json):
    """`credit_json`（`{requestId: credit}` 的 JSON 串）里可解析为数值的条目数。
    解析失败 / 非对象 / 空串 → 0。bool 显式排除（`isinstance(True, int)` 为真，
    Rust 侧也短路）；数值字符串（真实账单里出现过）算数值。与 Rust
    `credit_entry_count` 逐字节同判。"""
    if not isinstance(credit_json, str) or not credit_json.strip():
        return 0
    try:
        parsed = json.loads(credit_json)
    except (ValueError, TypeError):
        return 0
    if not isinstance(parsed, dict):
        return 0
    n = 0
    for v in parsed.values():
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            if v == v and v not in (float("inf"), float("-inf")):
                n += 1
            continue
        if isinstance(v, str):
            try:
                f = float(v)
            except ValueError:
                continue
            if f == f and f not in (float("inf"), float("-inf")):
                n += 1
    return n


def _derive_coverage(records, timelines, session_meta, spans):
    """spec §3 矩阵逐信号喂覆盖。ToolCalls/SandboxModes/NetworkAccess/ApprovalDecisions
    与 populate 的 timeline 同源（sandbox-executed 数 = tool_calls 的 bash 数 =
    sandbox 数，等）——coverage 与 timeline 两条账必须对得上，否则门控读 timeline
    非空而 coverage 全零。FileMutations/ApprovalPolicy/UsageAggregate 从
    `session_meta`（db/file-history）拆出。返回 `(sigset, coverage, unknown)`。"""
    coverage = {s: {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0}
                for s in ALL_SIGNALS}
    unknown = []
    request_ids = set()

    for record in records:
        if not isinstance(record, dict):
            # 同 populate 的 P4-13 修复：非对象记录进 unknown，由 SourceAttempt
            # 上报（与 populate 的 unknown 合并，去重）。
            msg = "non-object audit-log record"
            if msg not in unknown:
                unknown.append(msg)
            continue
        key = _record_key(record)
        if key not in KNOWN_EVENT_TYPES:
            msg = "unknown audit-log event (category=%s, eventType=%s)" % key
            if msg not in unknown:
                unknown.append(msg)
            continue
        rid = record.get("requestId")
        if isinstance(rid, str) and rid:
            request_ids.add(rid)
        if key == ("command-safety", "command-safety.sandbox-executed"):
            _bump(coverage, "ToolCalls", "measured")
            _bump(coverage, "SandboxModes", "measured")
        elif key == ("network", "WebFetch"):
            _bump(coverage, "ToolCalls", "measured")
            _bump(coverage, "NetworkAccess", "measured")
        else:
            _bump(coverage, "ApprovalDecisions", "measured")

    # FileMutations measured = file-history 版本数（spec §3 Measured 行）。
    fm = session_meta.get("file_mutations")
    if isinstance(fm, int) and fm > 0:
        _bump(coverage, "FileMutations", "measured", fm)
    # ApprovalPolicy measured = permission_mode / use_sandbox_cli 存在（spec §3）。
    if session_meta.get("permission_mode") is not None or session_meta.get("use_sandbox_cli") is not None:
        _bump(coverage, "ApprovalPolicy", "measured")
    # UsageAggregate measured = session_usage.used / credit_json 存在（spec §9）。
    if session_meta.get("used") is not None or session_meta.get("credit_json"):
        _bump(coverage, "UsageAggregate", "measured")
    # QuotaConsumption measured = credit_json 里**可解析为数值**的条目数（spec §10 B6）
    # ——每条 = 执行环境为一个 requestId 记了一笔配额消耗。只数条目不看金额：0 积分的
    # 条目也是一次记账观察。非数值（bool/字符串垃圾/None）不计——记账缺口报缺。
    # 与 workbuddy_session_audit._credit_cents 的求和是两件事：那边算钱，这边算次数。
    quota_entries = _credit_entry_count(session_meta.get("credit_json"))
    if quota_entries > 0:
        _bump(coverage, "QuotaConsumption", "measured", quota_entries)
    # TurnBoundaries derived = distinct requestId（lossy 下界，spec §8）。coverage
    # 与 turns timeline **不同源**（timeline 恒空）——这正是
    # empty_timeline_with_nonzero_coverage_is_unavailable_not_measured_zero 钉住的
    # 模式：SV612/613 读 timeline 判 Unavailable，coverage 只报可观察的请求下界。
    # E2：traces span 的覆盖。function（非 Bash）→ ToolCalls + ToolResults 各 +1；
    # agent → SubagentSpawns +1。Bash span 不计（E3 前主源是 audit-log，重复计就是
    # 虚增覆盖）。
    fn_spans = agent_spans = 0
    for span in spans:
        if not isinstance(span, dict):
            continue
        kind = span.get("kind")
        if kind == "function":
            tool = span.get("tool_name")
            if isinstance(tool, str) and tool and tool != "Bash":
                fn_spans += 1
        elif kind == "agent":
            agent_spans += 1
    if fn_spans > 0:
        _bump(coverage, "ToolCalls", "measured", fn_spans)
        _bump(coverage, "ToolResults", "measured", fn_spans)
    if agent_spans > 0:
        _bump(coverage, "SubagentSpawns", "measured", agent_spans)
    if request_ids:
        _bump(coverage, "TurnBoundaries", "derived", len(request_ids))

    sigset = {s for s in ALL_SIGNALS if _total(coverage[s]) > 0}
    for s in _UNAVAILABLE_SIGNALS:
        coverage[s] = {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0}
    unknown.sort()
    return sigset, coverage, unknown


def _build_notes(coverage, records, spans):
    notes = []
    if _total(coverage["TurnBoundaries"]) > 0:
        notes.append(_TURN_BOUNDARY_NOTE)
    if _total(coverage["SandboxModes"]) > 0:
        notes.append(_SANDBOX_MODE_NOTE)
    if _total(coverage["QuotaConsumption"]) > 0:
        notes.append(_QUOTA_CONSUMPTION_NOTE)
    chain = _chain_note(records)
    if chain is not None:
        notes.append(chain)
    # E2：有 span 就说明折了什么、没折什么。Bash span 数单独报——E3 定主源前它们
    # 不进 tool_calls，读者得知道这个缺口是刻意的。
    objs = [s for s in spans if isinstance(s, dict)]
    if objs:
        fn_non_bash = bash = agent = 0
        for s in objs:
            kind = s.get("kind")
            if kind == "function":
                tool = s.get("tool_name")
                if tool == "Bash":
                    bash += 1
                elif isinstance(tool, str) and tool:
                    fn_non_bash += 1
            elif kind == "agent":
                agent += 1
        notes.append(
            "%s%d non-Bash function span(s) -> tool_calls/tool_results, %d agent span(s) -> "
            "SubagentSpawns; %d Bash span(s) NOT folded: audit-log sandbox-executed is the Bash "
            "source (no shared identity key \u2014 audit toolCallId vs span spanId \u2014 and "
            "audit-log is the hash-chained security ledger with the more complete record; "
            "merging would double-count)"
            % (_TRACES_FOLDED_NOTE_PREFIX, fn_non_bash, agent, bash))
    return notes


def build_workbuddy_evidence(raw_records, session_id, session_meta, spans=()):
    """记录数组 + 会话元数据 → evidence 字典（"derive → coverage" 两段；"locate →
    shape → extract" 留在 `adapters/workbuddy_session.py`）。与 Rust
    `build_workbuddy_evidence` 对齐：返回 `{"canonical", "raw_records"}`，其中
    `canonical` 是 `CanonicalSession` 的等价字典（meta/signals/coverage/attempts/
    notes + 五条 timeline，turns 恒空——spec §8 的「故意空」构造点）。

    诚实真值表（喂 WorkBuddy canonical 后每条 SV 规则的结果）：

    | 规则 | WorkBuddy |
    |---|---|
    | SV601–603 | 跑（`command-safety.sandbox-executed` 的 commandPreview → bash args_text） |
    | SV604/605 | 跑（E2：Edit/Write span 解码后的 file_path → args_text）；降级行已删 |
    | SV606 | 跑（network+WebFetch target → web_fetch args_text） |
    | SV607/608 | 跑（E2：span status → error_code，原生码不翻译 → 诚实 MeasuredZero） |
    | SV609 | 跑（audit-log 审批路径 → asked）；无审批记录则 Unavailable |
    | SV610 | 跑（sandbox 非空），mode 恒非 danger-full-access → 诚实 MeasuredZero |
    | SV611 | 跑（bash+web_fetch 子集） |
    | SV612/613 | SV612 Unavailable（turns 恒空）；SV613 有 span 时跑（(b) 读 tool_results），无 span 时 Unavailable |
    | SV614 | 跑（approvals+sandbox 双轴都在） |
    """
    spans = list(spans)
    timelines, unknown = _populate_workbuddy_timelines(raw_records, session_meta, spans)
    sigset, coverage, cov_unknown = _derive_coverage(raw_records, timelines, session_meta, spans)
    all_unknown = unknown + [m for m in cov_unknown if m not in unknown]
    all_unknown.sort()
    # E2：traces 不再是「已知但刻意不用」的表面——已折进 timeline，不再记 attempt。
    attempts = [{
        "source_id": "workbuddy.audit-log",
        "kind": "LogFile",
        "surface": "SessionLog",
        "available": False,
        "error": msg,
        "observed_span": None,
    } for msg in all_unknown]
    notes = _build_notes(coverage, raw_records, spans)
    # D1–D4：喂进本证据的**原生记录**时间 min/max。`_parse_time` 出**秒**，
    # 由 `session_span` 归一到毫秒。0 条记录 → None（不造 (0,0)）。
    native_times = [t for t in (_parse_time(r) for r in raw_records) if t is not None]
    canonical = {
        "meta": {
            "session_id": session_id,
            "harness_id": "workbuddy",
            "workspace_roots": _first_cwd(session_meta),
            "model": _extract_model(session_meta),
            "span": session_span(native_times),
        },
        "signals": [s for s in ALL_SIGNALS if s in sigset],
        "coverage": coverage,
        "attempts": attempts,
        "notes": notes,
        "tool_calls": {"entries": timelines["tool_calls"]},
        "tool_results": {"entries": timelines["tool_results"]},
        "approvals": {"entries": timelines["approvals"]},
        "sandbox_modes": {"entries": timelines["sandbox_modes"]},
        "turns": {"entries": timelines["turns"]},
    }
    return {"canonical": canonical, "raw_records": raw_records}


def _extract_model(session_meta):
    model = session_meta.get("model")
    return model if isinstance(model, str) else None


def _first_cwd(session_meta):
    cwd = session_meta.get("cwd")
    return [cwd] if isinstance(cwd, str) else []


def workbuddy_evidence_json(evidence):
    """evidence 字典 → `workbuddy-evidence --json` 的输出形状。与 Rust
    `workbuddy_evidence_json` 逐字节对齐——键序、嵌套结构、`attempts`/`notes` 的
    序列化都是这里单独控制的。`signals` 数组按 ALL_SIGNALS 序；`coverage` 20 键
    全量（unavailable 的也是全零四条，不是缺键）；`available` 标记执行环境是否提供该
    维度——false = 结构缺口，任何会话都为零，KPI 分母不算它。"""
    canonical = evidence["canonical"]
    sigset = set(canonical["signals"])
    signals = [s for s in ALL_SIGNALS if s in sigset]
    coverage_map = {}
    for s in ALL_SIGNALS:
        c = canonical["coverage"][s]
        coverage_map[s] = {
            "measured": c["measured"],
            "derived": c["derived"],
            "lossy": c["lossy"],
            "unmetered": c["unmetered"],
            "available": s not in _UNAVAILABLE_SIGNALS,
        }
    attempts = [{
        "source_id": a["source_id"],
        "kind": a["kind"],
        "surface": a["surface"],
        "available": a["available"],
        "error": a["error"],
        "observed_span": a["observed_span"],
    } for a in canonical["attempts"]]
    notes = [n["message"] if isinstance(n, dict) else n
             for n in canonical["notes"]]
    return {
        "harness": "workbuddy",
        "session_id": canonical["meta"]["session_id"],
        "workspace_roots": canonical["meta"]["workspace_roots"],
        "model": canonical["meta"]["model"],
        # 会话实际覆盖跨度（D1–D4）。键位置与 Rust 序列化器逐字节对齐。
        "span": canonical["meta"]["span"],
        "signals": signals,
        "coverage": coverage_map,
        "attempts": attempts,
        "notes": notes,
    }
