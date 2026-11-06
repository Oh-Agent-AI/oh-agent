"""Claude Code 适配器的 "derive → coverage" 两段（五段式流水线 locate → shape →
extract → derive → coverage，"locate → shape → extract" 留在
`scripts/agent_vitals/adapters/claude_session.py`，I/O 不在这里）。它把
`~/.claude/projects/*.jsonl` 里抽出的原始记录折成 `evidence::CanonicalSession`
的等价字典，覆盖计数按 `docs/RUNTIME_EVIDENCE_CONTRACT.md` §13 harness coverage
matrix 的 **Claude Code 列**逐条对应。

与 Rust `crates/agent-vitals-harnesses/src/harnesses/claude_code/sessions/evidence.rs` 逐字节对齐——产出
同一个 `claude_evidence_json` 输出字典（键序一致），`tests/test_cli_matrix.py::
both()` 的差分靠这份一致把关。

**§8 turn 重建的判据是内容，不是 `parentUuid`。** 真机语料（8 会话、2,447 条
消息）里纯文本 user 且 `parentUuid != null` 的有 886 条、`parentUuid == null`
的只有 8 条——naive「parentUuid=null 即根」会漏掉 99% 的 turn 边界。文档 §8 问 4
的判定（`message.content` 含 `tool_result` 块 = 工具循环续写；纯文本/image =
新 human prompt → turn 根）才是可靠的。这里以内容为准。

**孤儿不合成 turn。** §8 问 3 说「无 open turn 时起一个合成 turn（Derived）」，
但问 8 的收尾是「重建不出报 Unavailable……**绝不发明不存在的边界**」。两者冲突
时后者赢：没有纯文本 user 根的记录（截断文件）→ turns 恒空 → SV612 经
timeline_is_empty 诚实 Unavailable；中途无根可归的 tool_result/assistant →
`turn=None`。合成一个不存在的边界正是问 8 禁止的事。

**`is_error` 译 `failed` 是 lossy，`error_code` 恒 None。** Claude 的
`tool_result.is_error` 是布尔三态（实测 true×169 / false×5336 / 键缺失×3947），
只证明「失败了」、不证明**失败原因**（§2.3）。译成 `failed=Some(bool)`（理由被
截断成布尔）；键缺失的记 Measured。`error_code` 保持 None——绝不伪造一个码
（§3：把一切失败伪造成错误码 → SV607/608 错误地 MeasuredZero）。SV607/608 的
Unavailable 是 dispatcher 层的判定，不在本适配器：本适配器的职责是产出**诚实的
证据**，不能靠「不填 tool_results」把 SV613(b) 的 lossy 路径一起饿死。
"""

import json

from .harness_capability import harness_profile
from ..util import session_span

# 20 个 Signal 的声明序——`signals` 数组 / `coverage` 字典的输出顺序都靠这份显式
# 表对齐（与 Rust `claude_code_evidence.rs::ALL_SIGNALS` 同表同序），不靠 Python
# 的任意 set 迭代序。
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
    "SubagentSpawns",
    "SkillInvocations",
    "Hooks",
    "FileMutations",
    "UserPrompts",
    "UserCorrections",
)

# 顶层 `{type, timestamp, uuid, parentUuid, ...}` 记录的已知 type 值。实测
# （8 会话抽样）出现 14 种；其余 type 记成 SourceAttempt，绝不当作损坏吞掉。
KNOWN_TYPES = frozenset((
    "ai-title",
    "assistant",
    "atis-latch",
    "attachment",
    "file-history-delta",
    "file-history-snapshot",
    "frame-link",
    "last-prompt",
    "mode",
    "permission-mode",
    "pr-link",
    "queue-operation",
    "system",
    "user",
))

# §13 Claude Code 列明确 unavailable / 没有对应列的信号。`derive_coverage` 的
# 置零与 `claude_evidence_json` 的 `available` 标记共用这一份清单，不准两处各写
# 一份漂移。v0.6 harness-contract spec §6/§11-M2a：执行环境级 unmeasured 声明不再是
# 本文件的字面量表，改从 `harness_capability.HARNESSES` 的 "claude-code" 行读（行上
# 的值就是从这里原来的字面量表搬过去的，golden 字节不变）。
#
# `ApprovalDecisions` 是 first-slice 范围：§13 列值是 **partial——denials only,
# derived+lossy**，靠匹配 tool-result 文本里的 marker string 恢复（§14.5），本次
# 不实现——先诚实 Unavailable，后续项做 marker 恢复时从这里挪出来（这条注记的
# 权威版本在 `harness_capability.py` 的 `HARNESSES` 行注释里）。
_UNAVAILABLE_SIGNALS = tuple(harness_profile("claude-code")["unmeasured_signals"])

# §14.5 的 SkillInvocations 说明文本——与 Rust 逐字节相同，差分测试靠它。
_SKILL_INVOCATION_NOTE = (
    "Claude Code does not persist skill invocations as structured events; "
    "SkillInvocations coverage is a derived presence lower bound from `Skill` "
    "tool calls, and offline inference may disagree with the harness's runtime "
    "decision."
)
_TURN_BOUNDARY_NOTE = (
    "Turn boundaries are rebuilt from the message stream (pure-text user "
    "roots), not native turn events; SV612/613(a) are Derived/Partial and "
    "rebuild failure degrades to Unavailable, never fabricated boundaries."
)
_APPROVAL_DECISIONS_NOTE = (
    "ApprovalDecisions is unavailable in this slice: only `permission-mode` "
    "snapshots are persisted, and per-decision recovery needs marker strings "
    "in tool-result text (RUNTIME_EVIDENCE_CONTRACT §14.5), a follow-up."
)

# §7 工具名规范化表。未映射的名字原样透传（won't match 规则 → 诚实 MeasuredZero，
# 不会误报）。`MultiEdit` 并入 `edit`——SV611 会把同一语义拆成两个名字识别成
# 不同调用。
_TOOL_NAME_NORMALIZATION = {
    "Bash": "bash",
    "Write": "write",
    "Edit": "edit",
    "MultiEdit": "edit",
    "Read": "read",
    "Glob": "glob",
    "Grep": "grep",
    "WebFetch": "web_fetch",
    "WebSearch": "web_search",
    "Task": "task",
    "TodoWrite": "todo_write",
    "NotebookEdit": "notebook_edit",
}


def _num(seg):
    """`std::str::from_utf8(r)?.parse::<i64>()` 的镜像：可选 +/− 前缀 + 纯 ASCII
    数字。**不能用裸 `int()`**：Python 的 int() 容忍空白与 0x/0o/0b 前缀
    （`int(" 26")`=26、`int("0x10")`=16），Rust 对空白/非十进制全部拒绝——切片是
    固定位置，任何不匹配都必须按失败处理（raise → `parse_iso` 返回 None），不能
    宽容出一个 Rust 不会给的值。"""
    body = seg
    if body[:1] in ("+", "-"):
        body = body[1:]
    if not body or not body.isascii() or not body.isdigit():
        raise ValueError(seg)
    return int(seg)


def _days_from_civil(y, m, d):
    """公历 → 1970 起的天数（Hinnant 算法，**非校验**）。Rust 侧对 02-30 这类
    无效日期也算出一个值；Python 用 `datetime.date` 会 raise ValueError 当场分叉。
    Hinnant 的所有除法都是非负操作数（`era` 用 floor 得到、`yoe`∈[0,400)、
    `doy` 恒非负），Python `//`（floor）与 Rust `/`（截断）在非负域等价。"""
    if m <= 2:
        y -= 1
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    mp = (m + 9) % 12
    doy = (153 * mp + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def parse_iso(s):
    """ISO-8601 → (unix 秒, 是否有显式 offset)。与 Rust `budget.rs::parse_iso`
    逐字节对齐——Claude 的 `"2026-08-20T14:27:08.827Z"` 带 fraction + Z 后缀已
    处理。裸时间戳（无 offset）按北京时间解释（+8:00，explicit=False）——与
    `budget.py::_read_snooze` 的 `dt.replace(tzinfo=_BEIJING)` 同一约定；Z/z →
    0；`±HH:MM` 显式 offset。fraction 跳过不解析。

    **必须直接实现 Hinnant `_days_from_civil`，不能复用 `codex_usage.py` 的
    `_days_from_civil`**——那个用 `datetime.date` 校验日期合法性，02-30 这类无效
    日期 Rust 算出一个值、Python raise，当场分叉。"""
    if len(s) < 19:
        return None
    for idx, ch in ((4, "-"), (7, "-"), (10, "T"), (13, ":"), (16, ":")):
        if s[idx] != ch:
            return None
    try:
        y = _num(s[0:4])
        m = _num(s[5:7])
        d = _num(s[8:10])
        hh = _num(s[11:13])
        mm = _num(s[14:16])
        ss = _num(s[17:19])
    except ValueError:
        return None
    rest = s[19:]
    if rest[:1] == ".":
        i = 1
        while i < len(rest) and rest[i].isascii() and rest[i].isdigit():
            i += 1
        rest = rest[i:]
    if rest == "":
        offset, explicit = 8 * 3600, False
    elif rest[0] in ("Z", "z"):
        offset, explicit = 0, True
    elif rest[0] in ("+", "-"):
        if len(rest) < 6:
            return None
        if rest[3] != ":":
            return None
        try:
            oh = _num(rest[1:3])
            om = _num(rest[4:6])
        except ValueError:
            return None
        sign = -1 if rest[0] == "-" else 1
        offset, explicit = sign * (oh * 3600 + om * 60), True
    else:
        return None
    days = _days_from_civil(y, m, d)
    return (days * 86400 + hh * 3600 + mm * 60 + ss - offset, explicit)


def _canonical_string(value):
    """`vitals_core::canonical::canonical_string` 的镜像：键按 UTF-8 字节序递归
    排序、压缩无空格序列化。SV611 把键序不同、语义相同的参数识别成不同调用的风险
    靠它消灭。`json.dumps(sort_keys=True)` 的键序是码位序 == UTF-8 字节序（工具
    参数键都是 ASCII）；`3` vs `3.0` 天然区分。**U+2028/U+2029 必须手动转义**——
    Python `json.dumps` 不转、serde_json 转（JS-safe）：RFC 8259 允许裸字符，但
    JS 的 `JSON.parse` 把裸 U+2028 当行分隔符，会崩（这正是 serde_json 转它的
    原因）。"""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      sort_keys=True)
    return text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def normalize_tool_name(name):
    """§7 工具名规范化表；未映射的名字原样透传。"""
    return _TOOL_NAME_NORMALIZATION.get(name, name)


def normalize_tool(name, input_value):
    """`(canonical_name, args_text)`。`args_text` 用 `_canonical_string` 做 key
    递归排序的压缩序列化——否则 SV611 把键序不同、语义相同 的参数识别成不同调用。
    **Bash 例外**：直接取 `input.command`（shell 字符串），与 DSH/Codex 的 bash
    处理同一形状。

    `input_value` 为 None 时（缺键 **或** JSON null——Python 两者都坍缩成 None，
    与 Rust `Option<&Value>` + `!i.is_null()` 的两路都归 "" 恰好一致）→ 空串。"""
    canonical = normalize_tool_name(name)
    if canonical == "bash":
        cmd = ""
        if isinstance(input_value, dict):
            c = input_value.get("command")
            if isinstance(c, str):
                cmd = c
        return canonical, cmd
    if input_value is None:
        return canonical, ""
    return canonical, _canonical_string(input_value)


def _text_content(content):
    """字符串或全 text 块且非空（首回合的历史判据）。镜像 Rust
    `sessions::turns::text_content`。"""
    if isinstance(content, str):
        return content.strip() != ""
    if isinstance(content, list):
        return len(content) > 0 and all(
            isinstance(b, dict) and b.get("type") == "text"
            and isinstance(b.get("text"), str) and b.get("text").strip() != ""
            for b in content)
    return False


def _user_prompt_text(content):
    """用户文本：字符串，或不含 tool_result 块的数组里 text 块的拼接。"""
    if isinstance(content, str):
        return content if content.strip() else None
    if isinstance(content, list):
        if any(is_tool_result_block(b) for b in content):
            return None
        parts = [b.get("text") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"
                 and isinstance(b.get("text"), str) and b.get("text").strip()]
        text = "".join(parts)
        return text if text.strip() else None
    return None


_HARNESS_ECHO = ("<task-notification", "<local-command-stdout", "<local-command-stderr",
              "<local-command-caveat", "<bash-input", "<bash-stdout", "<bash-stderr",
              "[Request interrupted")
_SETTINGS_ONLY = frozenset(("model", "effort", "clear", "compact", "fast", "config", "cost",
                            "status", "help", "login", "logout", "permissions", "context",
                            "memory", "resume", "exit"))


def turn_signal(record, has_turn):
    """user 记录的回合信号：`"request"` / `"interrupt"` / `"other"`。镜像 Rust
    `harnesses::claude_code::sessions::turns::turn_signal`——evidence 与 workflow 共用
    的唯一判据（此前本函数的前身 `is_pure_text_user` 把 skill 正文注入、
    `<task-notification>`、中断标记都算成新 turn）。首回合沿用历史判据
    `_text_content`（workflow 的 task_started event_id 依赖它）；其后排除 meta
    注入、压缩摘要、执行环境回灌与只改设置的斜杠命令。"""
    if not isinstance(record, dict):
        return "other"
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if record.get("isSidechain") is True:
        return "other"
    if not has_turn:
        return "request" if _text_content(content) else "other"
    text = _user_prompt_text(content)
    if text is None:
        return "other"
    text = text.lstrip()
    if text.startswith("[Request interrupted"):
        return "interrupt"
    # 后续回合允许 text + image 混合（贴图的请求也是新请求）；_user_prompt_text
    # 已排除 tool_result 数组并要求非空文本。
    if record.get("isMeta") is True or record.get("isCompactSummary") is True:
        return "other"
    if text.startswith(_HARNESS_ECHO):
        return "other"
    if text.startswith("<command-name>/"):
        rest = text[len("<command-name>/"):]
        command = ""
        for ch in rest:
            if ch == "<" or ch.isspace():
                break
            command += ch
        if command in _SETTINGS_ONLY:
            return "other"
    return "request"


def is_turn_root(record, has_turn):
    """§8 问 4：user 事件是不是 turn 根（按内容判，不是 `parentUuid`）。"""
    return turn_signal(record, has_turn) == "request"


def is_tool_result_block(b):
    return isinstance(b, dict) and b.get("type") == "tool_result"


def _timeline_entry(observation, seq, time, turn, call_id, ordinal):
    """一条 timeline entry 的构造器。Claude 逐事件带 timestamp（`parse_iso` →
    秒），比 Codex（无时间戳）多一维；`step` 恒 None——Claude 无原生 step，
    StepBoundaries 只在 coverage 层按 assistant 消息数派生。与
    `codex_evidence._timeline_entry` 同一形状，多一个 `time` 键。"""
    return {"observation": observation, "seq": seq, "time": time, "turn": turn,
            "step": None, "call_id": call_id, "ordinal": ordinal}


def _process_tool_result_blocks(record, tool_results, seq, time, turn, next_ordinal):
    """一条 tool_result user 的续写块 → `tool_results`。三态 is_error（§2.3）：
    - 键存在（true/false）→ `failed=Some(bool)`（失败理由被截断成布尔）；
    - 键缺失 → `failed=None`（执行环境记了结果、无失败信号）。
    `error_code` 恒 None（§3：Claude 无原因码来源，绝不伪造）。
    `next_ordinal` 是**跨块**的唯一序号（`evt-{ordinal}` 契约）——一条记录可含
    多个块，用记录序当 ordinal 会撞号。list 容器 = Python 缺引用的惯用替代。"""
    message = record.get("message")
    items = message.get("content") if isinstance(message, dict) else None
    if not isinstance(items, list):
        return
    for blk in items:
        if not is_tool_result_block(blk):
            continue
        ordinal = next_ordinal[0]
        next_ordinal[0] += 1
        is_error = blk.get("is_error")
        failed = is_error if isinstance(is_error, bool) else None
        tid = blk.get("tool_use_id")
        tool_results.append(_timeline_entry(
            {"failed": failed, "error_code": None},
            seq, time, turn,
            tid if isinstance(tid, str) else None,
            ordinal))


def _process_tool_use_blocks(record, tool_calls, seq, time, turn, next_ordinal):
    """一条 assistant 的 tool_use 块 → `tool_calls`，返回各块 `(name, args_text)`
    的 sig 贡献。**sidechain 归属由调用方决定**：调用方只在非 sidechain 时把返回
    值 extend 进当前 turn 的 sig（SV612 死循环检测的输入）——abandoned branch
    不进 turn 边界（§8 问 2），但它的工具调用本身照常记录（`turn=None`）。"""
    message = record.get("message")
    items = message.get("content") if isinstance(message, dict) else None
    if not isinstance(items, list):
        return []
    sig = []
    for blk in items:
        if not isinstance(blk, dict) or blk.get("type") != "tool_use":
            continue
        ordinal = next_ordinal[0]
        next_ordinal[0] += 1
        name = blk.get("name")
        if not isinstance(name, str):
            name = ""
        canonical_name, args_text = normalize_tool(name, blk.get("input"))
        call_id = blk.get("id")
        tool_calls.append(_timeline_entry(
            {"name": canonical_name, "args_text": args_text},
            seq, time, turn,
            call_id if isinstance(call_id, str) else None,
            ordinal))
        sig.append((canonical_name, args_text))
    return sig


def _flush_turn(turns, p, next_ordinal):
    """关掉一个 turn：push TurnObservation。entry 坐标 = turn/start（根事件）；
    `end_seq`/`end_time` = `last_*`（最后一个主干事件——镜像 DSH fixture 里
    `last_seq == end_seq` 的不变式），`end_reason_kind`/`end_error_code` 恒 None
    （Claude 无 turn/end 事件）。SV613(a) 读 `end_reason_kind=="error"` 恒不命中 →
    诚实 MeasuredZero，不发明 error turn。
    `next_ordinal` 同前：turn 是第三条 timeline，序号与另两条共用同一把递增
    （曾硬编码 0——撞 `tool_calls` 首条的 `evt-0`）。"""
    ordinal = next_ordinal[0]
    next_ordinal[0] += 1
    turns.append(_timeline_entry(
        {
            "turn": p["turn"], "sig": p["sig"],
            "last_seq": p["last_seq"],
            "end_reason_kind": None, "end_error_code": None,
            "end_seq": p["last_seq"], "end_time": p["last_time"],
        },
        p["start_seq"], p["start_time"], p["turn"], None, ordinal))


def _populate_claude_timelines(records):
    """跑一遍 `records`，把 Claude 线格式翻译成五个 harness-neutral timeline（§11.5）
    里的三条（approvals/sandbox_modes 恒空——§13 Claude 列两行 unavailable）：
    - `tool_calls`：assistant 的 `tool_use` 块 → §7 规范化名 + 确定性 args_text。
    - `tool_results`：user 的 `tool_result` 块 → 三态 is_error → `failed`。
    - `turns`：纯文本 user 根开 turn、EOF 兜底关闭；turn 内主干 tool_use 的
      (name, args_text) 进 `sig`。

    turn 边界判据 = 内容（§8 问 4），非 `parentUuid`。turn 号是**合成序数**——
    编造序数不是编造零：序数只做会话内排序，不做任何「Claude 没记录的事」。"""
    tool_calls, tool_results, turns = [], [], []
    pending = None
    next_turn = 0
    # `next_ordinal` 与 `rec_idx` 是两把不同的尺：rec_idx = 记录序（`seq` 坐标，
    # 同记录的所有块共享），next_ordinal = 跨三条 timeline 的 entry 唯一序。
    # 曾用记录序当 ordinal——一条记录多块（或 _flush_turn 硬编码 0）就撞号。
    next_ordinal = [0]

    for rec_idx, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        typ = record.get("type")
        if not isinstance(typ, str):
            continue
        # Rust `as_bool` 只认 JSON 布尔：`is_sidechain is True` 排除 `1`/`"true"`
        # 等非布尔真值（Python `1 is True` 为 False）。
        is_sidechain = record.get("isSidechain") is True
        seq = rec_idx
        time = None
        ts = record.get("timestamp")
        if isinstance(ts, str):
            parsed = parse_iso(ts)
            if parsed is not None:
                time = parsed[0]
        message = record.get("message")
        message = message if isinstance(message, dict) else None

        if typ == "user":
            content = message.get("content") if message is not None else None
            if not is_sidechain:
                if is_turn_root(record, next_turn > 0):
                    # 新 turn 根：flush 上一个、开新的。根**不**推进上一个 turn
                    # 的 last_seq（上一个 turn 到根**之前**的最后一个事件为止）。
                    if pending is not None:
                        _flush_turn(turns, pending, next_ordinal)
                    pending = {
                        "turn": next_turn, "sig": [],
                        "start_seq": seq, "start_time": time,
                        "last_seq": seq, "last_time": time,
                    }
                    next_turn += 1
                elif pending is not None:
                    # tool_result 续写推进 turn 的 last_seq（turn 内任何事件都推进）。
                    pending["last_seq"] = seq
                    pending["last_time"] = time
            _process_tool_result_blocks(
                record, tool_results, seq, time,
                None if is_sidechain else (pending["turn"] if pending is not None else None),
                next_ordinal)
        elif typ == "assistant":
            if not is_sidechain and pending is not None:
                pending["last_seq"] = seq
                pending["last_time"] = time
            turn_opt = (None if is_sidechain
                        else (pending["turn"] if pending is not None else None))
            sig = _process_tool_use_blocks(
                record, tool_calls, seq, time, turn_opt, next_ordinal)
            if not is_sidechain and pending is not None:
                pending["sig"].extend(sig)

    # EOF 兜底（§8 问 7）：最后一个 open turn 在文件尾关闭。
    if pending is not None:
        _flush_turn(turns, pending, next_ordinal)

    return {
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "approvals": [],
        "sandbox_modes": [],
        "turns": turns,
    }


def _total(counts):
    """四个计数桶的总和——`CoverageCounts::total()` 的镜像。"""
    return counts["measured"] + counts["derived"] + counts["lossy"] + counts["unmetered"]


def _bump(coverage, signal, bucket, n=1):
    """往某个 Signal 的某个桶里加计数。"""
    coverage[signal][bucket] += n


def _derive_coverage(records, turns_len):
    """§13 Claude Code 列逐条喂覆盖。**ToolCalls/ToolResults/TurnBoundaries 三个
    计数与 populate 的 timeline 同源**（tool_use 块数 = tool_calls.entries.len()，
    等）——这是 repo 的纪律：coverage 与 timeline 两条账必须对得上，否则门控读
    timeline 非空而 coverage 全零。Usage 按 `message.id` 去重：Claude 在消息的
    每条 content 行上重复同一份 `message.usage`（实测 1,517/2,447 消息跨 2-4 行），
    不去重会把 Usage 虚增 2-4 倍。返回 `(sigset, coverage, 未知类型列表)`。"""
    coverage = {s: {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0}
                for s in ALL_SIGNALS}
    unknown = []
    usage_ids = set()
    step_ids = set()
    prompts = 0

    for record in records:
        typ = record.get("type") if isinstance(record, dict) else None
        if not isinstance(typ, str):
            # 非 dict / 缺 type（或 type 非字符串）的记录没有归类的锚点——静默
            # 跳过等于让证据消失（评审 P4-13：skipped and recorded, never
            # treated as corruption）。记进 `unknown` 由 SourceAttempt 上报，绝不吞。
            msg = "missing record type"
            if msg not in unknown:
                unknown.append(msg)
            continue
        if typ not in KNOWN_TYPES:
            msg = "unknown record type: %s" % typ
            if msg not in unknown:
                unknown.append(msg)
            continue
        is_sidechain = record.get("isSidechain") is True
        message = record.get("message")
        message = message if isinstance(message, dict) else None

        if typ == "user":
            content = message.get("content") if message is not None else None
            if not is_sidechain and is_turn_root(record, prompts > 0):
                # turn 根 = 真人 human prompt（与 codex 的 UserPrompts 同义）。
                prompts += 1
                _bump(coverage, "UserPrompts", "measured")
            if isinstance(content, list):
                for blk in content:
                    if is_tool_result_block(blk):
                        _bump(coverage, "ToolResults", "measured")
        elif typ == "assistant":
            if message is not None and isinstance(message.get("content"), list):
                for blk in message["content"]:
                    if not isinstance(blk, dict) or blk.get("type") != "tool_use":
                        continue
                    _bump(coverage, "ToolCalls", "measured")
                    name = blk.get("name")
                    if not isinstance(name, str):
                        name = ""
                    if name in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
                        # §13 FileMutations = "derived (from tool calls)"。
                        _bump(coverage, "FileMutations", "derived")
                    elif name == "Task" and not is_sidechain:
                        # is_sidechain 守卫 = SubagentSpawns 的**按记录去重**：
                        # 记录级 is_sidechain 臂（下面）已数过这条记录，sidechain
                        # 记录里的 Task 块不能再数一次——否则一条 sidechain 记录
                        # 既走 Task 臂又走 is_sidechain 臂，双计（评审 P4-12）。
                        # 主干（非 sidechain）的 Task 块 = 一次真实子代理 spawn，
                        # 按块数。
                        _bump(coverage, "SubagentSpawns", "measured")
                    elif name == "Skill":
                        # §13 SkillInvocations = "derived (Skill tool call)"。
                        _bump(coverage, "SkillInvocations", "derived")
            # Usage measured：按 message.id 去重。无 id 时回退 uuid（每条 content
            # 行计一次，罕见，可接受）。
            if message is not None and isinstance(message.get("usage"), dict):
                key = message.get("id")
                if not isinstance(key, str):
                    key = record.get("uuid")
                    if not isinstance(key, str):
                        key = ""
                if key not in usage_ids:
                    usage_ids.add(key)
                    _bump(coverage, "Usage", "measured")
            # StepBoundaries derived：每个 assistant message = 一个 step（§13
            # Claude 列 "derived"；没有原生 step 事件，按消息数派生，去重跨行）。
            if message is not None:
                mid = message.get("id")
                if isinstance(mid, str) and mid not in step_ids:
                    step_ids.add(mid)
                    _bump(coverage, "StepBoundaries", "derived")
        elif typ == "system":
            subtype = record.get("subtype")
            subtype = subtype if isinstance(subtype, str) else ""
            if subtype == "compact_boundary":
                # §13 Compaction = "lossy (compact_boundary, no volume)"。
                _bump(coverage, "Compaction", "lossy")
            elif subtype == "stop_hook_summary":
                # §13 Hooks = "lossy (stop_hook_summary)"。
                _bump(coverage, "Hooks", "lossy")
        elif typ == "permission-mode":
            # §13 ApprovalPolicy = "measured (permission-mode)"——模式快照即策略。
            _bump(coverage, "ApprovalPolicy", "measured")
        # mode/attachment/last-prompt/ai-title/file-history-*/queue-operation/… 不喂信号
        # §13 SubagentSpawns：isSidechain 真本身就是子代理分支的证据。记录级去重
        # 锚点：Task 臂只认主干（守卫在上面），所以一条 sidechain 记录无论含几个
        # Task 块都只计一次（评审 P4-12）。
        if is_sidechain:
            _bump(coverage, "SubagentSpawns", "measured")

    # TurnBoundaries derived，count = populate 重建出的 turn 数——coverage 与
    # turns timeline 同源。整文件无 user 根（截断）→ 0 → 不进 sigset → SV612 经
    # timeline_is_empty 诚实 Unavailable（§8 问 8）。
    if turns_len > 0:
        _bump(coverage, "TurnBoundaries", "derived", turns_len)

    sigset = {s for s in ALL_SIGNALS if _total(coverage[s]) > 0}

    # UsageAggregate 的存在性派生（§13 "derivable"）。
    if _total(coverage["Usage"]) > 0:
        _bump(coverage, "UsageAggregate", "derived")
        sigset.add("UsageAggregate")

    # §13 unavailable 的信号显式置零（不进 sigset）——不能编一个非零数字出来。
    # （这些信号在 Claude 路径没有任何 bump 分支，本来就是零；显式置零是
    # belt-and-suspenders，与 Rust 侧 `coverage.set(.., default())` 同义。）
    for s in _UNAVAILABLE_SIGNALS:
        coverage[s] = {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0}

    unknown.sort()
    return sigset, coverage, unknown


def _extract_model(records):
    """第一条真的把 `attempts` 填起来的适配器是 codex_evidence.rs；Claude 同
    规矩：未知记录类型记成 SourceAttempt，不当作损坏吞掉。model = 第一条携带
    `message.model` 的记录（会话的主模型，逐事件携带）。"""
    for r in records:
        if not isinstance(r, dict):
            continue
        message = r.get("message")
        if isinstance(message, dict):
            model = message.get("model")
            if isinstance(model, str):
                return model
    return None


def _first_cwd(records):
    """§13 Claude 列的 Workspace root = `cwd`（逐事件携带）。取第一条非空 cwd——
    会话的起跑目录，比「最常见的 cwd」少一次全量扫描，且同一会话内 cwd 几乎不变。"""
    for r in records:
        if not isinstance(r, dict):
            continue
        cwd = r.get("cwd")
        if isinstance(cwd, str):
            return [cwd]
    return []


def _build_notes(coverage):
    notes = []
    if _total(coverage["SkillInvocations"]) > 0:
        notes.append(_SKILL_INVOCATION_NOTE)
    if _total(coverage["TurnBoundaries"]) > 0:
        notes.append(_TURN_BOUNDARY_NOTE)
    if _total(coverage["ApprovalDecisions"]) == 0:
        notes.append(_APPROVAL_DECISIONS_NOTE)
    return notes


def build_claude_evidence(raw_records, session_id):
    """记录数组 → evidence 字典（"derive → coverage" 两段；"locate → shape →
    extract" 留在 `adapters/claude_session.py`）。与 Rust `build_claude_evidence`
    对齐：返回 `{"canonical", "raw_records"}`，其中 `canonical` 是
    `CanonicalSession` 的等价字典（meta/signals/coverage/attempts/notes +
    五条 timeline，approvals/sandbox_modes 恒空——§13 Claude 列两行
    unavailable 的「故意空」构造点）。

    诚实真值表（喂 Claude canonical 后每条 SV 规则的结果）：

    | 规则 | Claude Code |
    |---|---|
    | SV601–606 | 跑（§7 规范化 + args_text 确定性序列化） |
    | SV607/608 | **Unavailable**（error_code 恒 None，原因级不可消费；本适配器不伪造码） |
    | SV609/610/614 | Unavailable（approvals / sandbox_modes 恒空） |
    | SV611 | 跑（比较 (name, args_text)） |
    | SV612 | Derived/Partial（turn 重建） |
    | SV613(a) | MeasuredZero（无 error turn/end） |
    | SV613(b) | Lossy/Partial（is_error → failed） |
    """
    timelines = _populate_claude_timelines(raw_records)
    turns_len = len(timelines["turns"])
    sigset, coverage, unknown = _derive_coverage(raw_records, turns_len)
    attempts = [{
        "source_id": "claude.session.jsonl",
        "kind": "LogFile",
        "surface": "SessionLog",
        "available": False,
        "error": msg,
        "observed_span": None,
    } for msg in unknown]
    notes = _build_notes(coverage)
    # D1–D4：喂进本证据的**原生记录**时间 min/max。Claude 的 `timestamp` 经
    # `parse_iso` 出**秒**，由 `session_span` 归一到毫秒。0 条记录 → None
    # （不造 (0,0)，那会被读成 1970）。镜像 Rust 同名字段。
    native_times = []
    for record in raw_records:
        stamp = record.get("timestamp")
        if isinstance(stamp, str):
            parsed = parse_iso(stamp)
            if parsed is not None:
                native_times.append(parsed[0])
    canonical = {
        "meta": {
            "session_id": session_id,
            "harness_id": "claude-code",
            "workspace_roots": _first_cwd(raw_records),
            "model": _extract_model(raw_records),
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


def claude_evidence_json(evidence):
    """evidence 字典 → `claude-evidence --json` 的输出形状。与 Rust
    `claude_evidence_json` 逐字节对齐——键序、嵌套结构、`attempts`/`notes` 的
    序列化都是这里单独控制的。`signals` 数组按 ALL_SIGNALS 序；`coverage` 20
    键全量（unavailable 的也是全零四条，不是缺键）；`available` 标记执行环境是否
    提供该维度——false = 结构缺口，任何会话都为零，KPI 分母不算它。"""
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
        "harness": "claude-code",
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
