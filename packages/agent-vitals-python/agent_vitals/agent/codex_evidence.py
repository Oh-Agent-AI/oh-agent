"""Codex 适配器的 "derive → coverage" 两段（五段式流水线 locate → shape →
extract → derive → coverage，见 `docs/RUNTIME_EVIDENCE_CONTRACT.md` §4.2）。
"locate → shape → extract" 留在 `scripts/agent_vitals/adapters/codex_session.py`，
I/O 不在这里。它把一份 rollout JSONL 里抽出的原始条目折成
`evidence::CanonicalSession` 的等价字典，覆盖计数按
`docs/RUNTIME_EVIDENCE_CONTRACT.md` §13 harness coverage matrix 的 **Codex
(Legacy) 与 Codex (Paginated) 两列**逐条对应。

与 Rust `crates/agent-vitals-harnesses/src/harnesses/codex/sessions/evidence.rs` 逐字节对齐——产出
同一个 `codex_evidence_json` 输出字典（键序一致），差分测试靠这份一致把关。

**P4 的验收标准是单个词 "sound"**：Codex 是唯一一个在两种互不兼容的词表
（`ThreadHistoryMode` 的 Legacy / Paginated，见 §14.1）之间不自我声明、必须靠
探测内容区分的执行环境。如果加这一个执行环境、两种形状会逼着共享类型层
（`CanonicalSession`/`Coverage`/`RuleSpec`，P1 落地）做结构性改动，这个模型
就失败了。这里不触碰 `evidence.rs` 的任何类型——**"Tool-call duration" 也不
在 20 个 `Signal` 里，它是 `CommandExecutionItem.duration` 这个**值**而不是
通道**：duration 跟着原始条目走，将来做 duration 折叠时从 item 上读即可，
覆盖率模型不为它开新槽。这正是 P4 不需要改共享类型层的证据之一。

**§14.1 的 Rust 枚举名不是线格式。** 文档自己也承认格式无版本、靠兼容 shim
演进（§14.4），本机 51 份真实 rollout 实测出的 `event_msg.type` /
`item_completed.payload.item.type` / `response_item.payload.type` 三套
snake_case / PascalCase 线格式才是权威。下面的映射表直接以实测词表为准。

**不是 trait**——理由同 `dsh_evidence.rs`：执行环境之间差的是"哪些阶段存在"，
trait 会强迫每个执行环境实现一堆空方法。Codex 的 `build_codex_evidence` 返回的
evidence 把 `canonical`（§12 规定不持有任何执行环境专属 payload）和它派生自的
原始条目捆在一起——将来把 SV 规则迁到 Codex 上时，规则引擎需要原始条目。
"""

import re

from agent_vitals.agent import canonical_audit
from agent_vitals.agent.harness_capability import harness_profile
from ..util import iso_to_epoch_ms, session_span

# 19 个 Signal 的声明序——与 Rust `codex_evidence.rs::ALL_SIGNALS` 同名同序。
# `signals` 数组 / `coverage` 字典的输出顺序都靠这份显式表对齐，不靠 Python
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

# 顶层 `{type, timestamp, payload}` 包络的已知 type 值。实测（本机 51 份
# rollout）出现 7 种；`compacted` 是顶层独立类型（带着 `replacement_history`，
# §13 Compaction 行 "measured (+ replacement_history)" 的来源）。
KNOWN_TOP_LEVEL_TYPES = frozenset((
    "session_meta",
    "turn_context",
    "event_msg",
    "response_item",
    "world_state",
    "compacted",
    "inter_agent_communication_metadata",
))

# `event_msg.payload.type` 的已知值。实测 17 种（Legacy 词表 + Paginated 的
# `item_completed` 载体）。`HookPrompt` 是 §14.1 文档里有、本机语料没采样到
# 的 Paginated item——不是 event，所以这里不放。
KNOWN_EVENT_TYPES = frozenset((
    "agent_message",
    "agent_reasoning",
    "context_compacted",
    "image_generation_end",
    "item_completed",
    "mcp_tool_call_end",
    "patch_apply_end",
    "sub_agent_activity",
    "task_complete",
    "task_started",
    "thread_goal_updated",
    "thread_rolled_back",
    "thread_settings_applied",
    "token_count",
    "turn_aborted",
    "user_message",
    "web_search_end",
))

# `event_msg.payload.type == "item_completed"` 时 `payload.item.type` 的已知值
# （Paginated 的 TurnItem 词表）。实测 13 种；`HookPrompt` 是 §14.1 文档明确
# 列出的 TurnItem 变体，本机语料没采样到（n=2 份 Paginated 太小，不能当
# "不存在"，见 docs §14.1 与 `codex-corpus-facts` 记忆）。
KNOWN_ITEM_TYPES = frozenset((
    "AgentMessage",
    "CollabAgentToolCall",
    "CommandExecution",
    "ContextCompaction",
    "DynamicToolCall",
    "Extension",
    "FileChange",
    "HookPrompt",
    "ImageView",
    "McpToolCall",
    "Plan",
    "Reasoning",
    "SubAgentActivity",
    "UserMessage",
))

# `response_item.payload.type` 的已知值。实测 9 种。
KNOWN_RESPONSE_TYPES = frozenset((
    "agent_message",
    "custom_tool_call",
    "custom_tool_call_output",
    "function_call",
    "function_call_output",
    "message",
    "reasoning",
    "tool_search_call",
    "tool_search_output",
))

# §13 没有 Codex 列 / 明确 unavailable 的信号——照 DSH 的规矩显式记全零
# （不进 SignalSet），不能编一个非零数字出来。SandboxModes 不在其中：2026-08
# 确认 turn_context.sandbox_policy 持久化，已改 measured（见 derive_coverage）。
# UserPrompts 同样不在其中：response_item.payload.type="message" + role="user"
# 是真实线格式（session 01a029cb 实测 15 条），2026-08 已改 measured。
# UserCorrections 留在里面：它的定义是 UserPrompts + TurnBoundaries 的关键词/
# 时间窗启发（§3.2），没有任何执行环境有参考实现（DSH 也显式置零），移植即发明。
# v0.6 harness-contract spec §6/§11-M2a：这份清单不再是本文件的字面量表，改从
# `harness_capability.HARNESSES` 的 "codex" 行读（行上的值就是从这里原来的字面量表
# 搬过去的，golden 字节不变）。
_UNAVAILABLE_SIGNALS = tuple(harness_profile("codex")["unmeasured_signals"])

# §14.3 的 SkillInvocations 说明文本——在 Rust 里逐字节相同，差分测试靠它。
_SKILL_INVOCATION_NOTE = (
    "Codex does not persist skill invocations (§14.3); SkillInvocations "
    "coverage is a derived presence lower bound, and offline inference may "
    "disagree with the harness's runtime decision. The upstream heuristic "
    "detect_implicit_skill_invocation_for_command is deliberately not ported."
)


def _user_prompt_kind(payload):
    """Classify a user-role message without returning its body.

    Codex persists harness-injected context in the same `message/user` envelope
    as a human prompt.  We only inspect the shallow text fragments needed to
    recognize known wrappers; callers receive a category, never the text.
    """
    content = payload.get("content")
    if not isinstance(content, list):
        return "unknown"
    texts = []
    for part in content:
        if not isinstance(part, dict) or not isinstance(part.get("text"), str):
            return "unknown"
        text = part["text"].strip()
        if text:
            texts.append(text)
    if not texts:
        return "unknown"
    ambient = tuple(t.startswith(("<recommended_plugins>", "<environment_context>",
                                  "<skills_instructions>", "<permissions instructions>",
                                  "<collaboration_mode>", "<apps_instructions>",
                                  "<plugins_instructions>")) for t in texts)
    if all(ambient):
        return "ambient_only"
    return "mixed" if any(ambient) else "human"


def _total(counts):
    """四个计数桶的总和——`CoverageCounts::total()` 的镜像。"""
    return counts["measured"] + counts["derived"] + counts["lossy"] + counts["unmetered"]


def _bump(coverage, signal, bucket, n=1):
    """往某个 Signal 的某个桶里加计数。与 Rust `bump` 对齐：n==0 直接返回。"""
    if n == 0:
        return
    coverage[signal][bucket] += n


def _classify(item):
    """一个条目在哪个命名空间、叫什么类型。返回 `("known", None)` 或
    `("unknown", "<报错文本>")`——报错文本是"要记进 attempts 的字符串"，已
    去重。

    顶层 type 在不在已知表里；在的话，按命名空间往下看内层 type 认不认得。
    任何一层不认识 → `("unknown", "unknown … type: …")`，调用方把它记进
    `attempts`（§14.4："unknown item types are skipped and recorded in
    attempts, never treated as corruption"）——这是 P4 顺带证明的第一条真实
    使用的 `SourceAttempt`（DSH 的 attempts 一直是空的）。

    **已知但恰好不映射到任何 Signal 的条目（`reasoning` / `agent_reasoning` /
    `world_state` …）直接跳过，不记 attempts**——`attempts` 只记"不认识"的，
    不记"认识但恰好不喂信号"的，否则一份真实会话会因为这类高频条目刷出
    一墙噪音。
    """
    top = item.get("type") if isinstance(item, dict) else None
    if not isinstance(top, str):
        top = ""
    if top not in KNOWN_TOP_LEVEL_TYPES:
        return "unknown", "unknown record type: %s" % top
    payload = item.get("payload") if isinstance(item, dict) else None
    if not isinstance(payload, dict):
        return "known", None  # 没有 payload 的 record 是合法的（如 session_meta 可能极简）
    inner = payload.get("type")
    if not isinstance(inner, str):
        inner = ""
    if top == "event_msg" and inner not in KNOWN_EVENT_TYPES:
        return "unknown", "unknown event type: %s" % inner
    if top == "event_msg" and inner == "item_completed":
        # item_completed 是 Paginated 的载体：再往下探一层 item.type。
        it = payload.get("item")
        item_type = it.get("type") if isinstance(it, dict) else None
        if not isinstance(item_type, str):
            item_type = ""
        if item_type not in KNOWN_ITEM_TYPES:
            return "unknown", "unknown item type: %s" % item_type
        return "known", None
    if top == "response_item" and inner not in KNOWN_RESPONSE_TYPES:
        return "unknown", "unknown response item type: %s" % inner
    return "known", None


def _classify_item(coverage, item_type, payload):
    """`item_completed.payload.item` 的 TurnItem 分型喂信号——单独抽出来，让
    `derive_coverage` 的主循环只读一层。与 Rust `classify_item` 逐条对齐。"""
    if item_type in ("McpToolCall", "DynamicToolCall", "CollabAgentToolCall",
                     "Extension"):
        # §14.1 列出的 typed 等价物——工具执行。
        _bump(coverage, "ToolCalls", "measured")
    elif item_type == "CommandExecution":
        _bump(coverage, "ToolCalls", "measured")
        # 带 stdout/stderr/exit_code 的执行记录同时是"结果"载体。
        _bump(coverage, "ToolResults", "measured")
        # `.duration`（实测 157/157 都有）是**值**不是通道——20 个 Signal 里
        # 没有 ToolCallDuration 变体，P4 的 "sound" 恰好证明不需要加：duration
        # 跟着原始条目走，将来做 duration 折叠时从 item 上读即可。
    elif item_type == "FileChange":
        # §13 Paginated FileMutations 列 measured；`auto_approved` 非空时是
        # ApprovalDecisions 的 partial 证据（§13 Paginated 列）。
        _bump(coverage, "FileMutations", "measured")
        it = payload.get("item")
        auto = (isinstance(it, dict) and "auto_approved" in it
                and it.get("auto_approved") is not None)
        if auto:
            _bump(coverage, "ApprovalDecisions", "measured")
    elif item_type == "ContextCompaction":
        _bump(coverage, "Compaction", "measured")
    elif item_type == "SubAgentActivity":
        _bump(coverage, "SubagentSpawns", "measured")
    elif item_type == "HookPrompt":
        _bump(coverage, "Hooks", "measured")
    # Plan / Reasoning / AgentMessage / UserMessage / ImageView 不喂信号。


def _is_u64(value):
    """`serde_json::as_u64` 的镜像：只认非负整数；bool 是 int 子类必须排除，
    浮点 `128000.0` 也一样挡在门外（Rust `as_u64` 对两者都返回 None）。"""
    return (isinstance(value, int) and not isinstance(value, bool) and value >= 0)


def derive_coverage(items):
    """顶层/event/item/response 四个来源的计数。返回 `(signals, coverage,
    未知类型的报错列表)`——报错是 §14.4 要求记进 `attempts` 的那份 "skipped,
    never corruption" 清单，去重后按字典序排序，保证跨语言字节一致。

    `signals` 是**按 ALL_SIGNALS 序过滤成员资格**的列表（与 Rust 序列化
    `signals` 数组同一个做法——SignalSet 的内部序不参与输出）；`coverage` 是
    {signal: {measured, derived, lossy, unmetered}}，19 键全量。

    映射表逐条对应 §13 的 Codex 两列（Legacy / Paginated 同列时说明两套词表
    都覆盖；分列时标在注释里）——见 Rust `codex_evidence.rs` 里那张完整表，
    这里只重述与本实现相关的口径。
    """
    coverage = {s: {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0}
                for s in ALL_SIGNALS}
    unknown = []

    for item in items:
        kind, msg = _classify(item)
        if kind == "unknown":
            if msg not in unknown:
                unknown.append(msg)

        if not isinstance(item, dict):
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue
        inner = payload.get("type")
        if not isinstance(inner, str):
            inner = ""
        top = item.get("type")
        if not isinstance(top, str):
            top = ""

        if top == "event_msg":
            if inner in ("mcp_tool_call_end", "web_search_end"):
                _bump(coverage, "ToolCalls", "measured")
            elif inner in ("task_started", "task_complete"):
                _bump(coverage, "TurnBoundaries", "measured")
            elif inner == "token_count":
                _bump(coverage, "Usage", "measured")
                # 只有 rate_limits 真是 object 才计 QuotaConsumption——键存在但
                # 值为 null（真实线格式偶尔如此）不是配额证据，`in payload` 会
                # 把 null 也 bump 成 1（LOW-5：与 usage_shaped 哨兵的「宽进」不
                # 冲突——这里是覆盖计数，宽进会虚增 measured）。
                if isinstance(payload.get("rate_limits"), dict):
                    _bump(coverage, "QuotaConsumption", "measured")
                # 常驻上下文窗口（model_context_window）在 payload.info 里——
                # 与逐请求 token 分离，§13 ContextWindow 行的来源。
                info = payload.get("info")
                if isinstance(info, dict) and _is_u64(info.get("model_context_window")):
                    _bump(coverage, "ContextWindow", "measured")
            elif inner == "thread_settings_applied":
                # §14.2：ThreadSettingsSnapshot 两种 mode 都持久化，携带
                # approval_policy。策略是"设置了策略"这
                # 件事的载体，数它即可，不解析策略值。键存在（即便 null）
                # 就计——与 Rust `.is_some()` 同义。
                ts = payload.get("thread_settings")
                if isinstance(ts, dict) and "approval_policy" in ts:
                    _bump(coverage, "ApprovalPolicy", "measured")
            elif inner == "patch_apply_end":
                # §13 FileMutations (Legacy) = "lossy (patch_apply_end only)"——
                # 只有 end，没有变更明细，进 lossy 桶。
                _bump(coverage, "FileMutations", "lossy")
            elif inner == "context_compacted":
                _bump(coverage, "Compaction", "measured")
            elif inner == "sub_agent_activity":
                _bump(coverage, "SubagentSpawns", "measured")
            elif inner == "item_completed":
                it = payload.get("item")
                item_type = it.get("type") if isinstance(it, dict) else None
                if not isinstance(item_type, str):
                    item_type = ""
                _classify_item(coverage, item_type, payload)
            # agent_message / agent_reasoning / user_message / turn_aborted / ...
            # 不喂信号
        elif top == "response_item":
            if inner in ("custom_tool_call", "function_call", "tool_search_call"):
                _bump(coverage, "ToolCalls", "measured")
            elif inner in ("custom_tool_call_output", "function_call_output",
                           "tool_search_output"):
                _bump(coverage, "ToolResults", "measured")
            elif inner == "message" and payload.get("role") == "user":
                kind = _user_prompt_kind(payload)
                if kind in ("human", "mixed"):
                    _bump(coverage, "UserPrompts", "measured")
                elif kind == "unknown":
                    _bump(coverage, "UserPrompts", "lossy")
            # reasoning / agent_message 不喂信号
        elif top == "turn_context":
            # 顶层 turn_context 也携带 approval_policy（实测字段）——与
            # thread_settings_applied 同源不同载体，数它的存在性即可。
            if "approval_policy" in payload:
                _bump(coverage, "ApprovalPolicy", "measured")
            # sandbox_policy 同源：真实线格式是对象 `{type}`、旧 fixture 是
            # 字符串，两态都认。populate 侧把它填进 sandbox_modes timeline，
            # 这里必须同步计数——coverage 与 timeline 同一来源，否则门控
            # 读 timeline 非空而 coverage 全零，两条账对不上。
            if _has_sandbox_policy(payload):
                _bump(coverage, "SandboxModes", "measured")
        elif top == "compacted":
            _bump(coverage, "Compaction", "measured")
        # session_meta / world_state / inter_agent_communication_metadata 不喂
        # 信号

    # UsageAggregate / SkillInvocations 的存在性派生，收尾统一判——它们不依赖
    # 具体条目形态，只依赖"有没有 Usage 证据 / 有没有工具执行证据"。成员资格
    # 先进 sigset（与 Rust 的 SignalSet 同义），最终列表按 ALL_SIGNALS 序生成
    # —— 与 `codex_evidence_json` 的 `signals` 数组同一个顺序，这个中间列表不
    # 参与字节输出，但保持与输出一致更不容易误读。
    sigset = {s for s in ALL_SIGNALS if _total(coverage[s]) > 0}
    if _total(coverage["Usage"]) > 0:
        _bump(coverage, "UsageAggregate", "derived")
        sigset.add("UsageAggregate")
    if _total(coverage["ToolCalls"]) > 0:
        _bump(coverage, "SkillInvocations", "derived")
        sigset.add("SkillInvocations")

    # §13 没有 Codex 列 / 明确 unavailable 的信号——显式记全零（本来就是零，
    # 这里保证不出现在 signals 里），不能编一个非零数字出来。
    for s in _UNAVAILABLE_SIGNALS:
        coverage[s] = {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0}

    signals = [s for s in ALL_SIGNALS if s in sigset]
    unknown.sort()
    return signals, coverage, unknown


# `evidence::CanonicalSession` 的五个 harness-neutral timeline 字段（Rust 侧
# `crates/agent-vitals-domain/src/contracts/evidence.rs` 的 struct 字段集——形状对账测试
# `tests/test_canonical_schema.py` 钉死两边一致，漏加一个字段这里就红）。
# 共享类型层的文档化 schema，与 ALL_SIGNALS 同为显式清单。
_TIMELINE_KEYS = (
    "tool_calls",
    "tool_results",
    "approvals",
    "sandbox_modes",
    "turns",
)


def _has_sandbox_policy(payload):
    """`turn_context.sandbox_policy` 的存在性判定（覆盖计数用，不取值）：真实线格式
    是对象 `{type:"danger-full-access"}`，旧 fixture 是字符串 `"workspace-write"`，
    两态都认。与 `_sandbox_policy_mode`（populate 取值）是同一个判定的两个读法。
    """
    sp = payload.get("sandbox_policy")
    if isinstance(sp, str):
        return True
    if isinstance(sp, dict):
        return "type" in sp
    return False


def _sandbox_policy_mode(payload):
    """取 `sandbox_policy` 的模式字符串：对象取 `.type`，字符串取自身，其他/缺失 None。"""
    sp = payload.get("sandbox_policy")
    if isinstance(sp, str):
        return sp
    if isinstance(sp, dict):
        mode = sp.get("type")
        return mode if isinstance(mode, str) else None
    return None


def _command_text(item):
    """从 `CommandExecution.item.command` 数组抽命令文本：剥掉 `/bin/zsh -lc …` /
    `bash -c …` 这类 shell 前缀（解释器 + 紧跟的 `-*` 标志段），剩下的 join 成串。
    剥前缀是让 SV601-603 的正则在命令本体上匹配，不是把命令改掉。
    """
    command = item.get("command")
    if not isinstance(command, list):
        return ""
    parts = [c for c in command if isinstance(c, str)]
    if parts:
        basename = parts[0].rsplit("/", 1)[-1]
        if basename in ("zsh", "bash", "sh", "dash", "ksh"):
            rest = parts[1:]
            if rest and rest[0].startswith("-"):
                rest = rest[1:]
            parts = rest
    return " ".join(parts)


def _error_code_from(error):
    """task_complete 的 `error` 对象 → 字符串错误码的防御性抽取。真实日志/fixture 全
    是 null（本机 51 份语料无一份带非 null 的 task_complete.error），所以这只看做
    结构保险：有 `codex_error_info.code` 用它的，否则退化成稳定标记 "error"——
    宁可语义含糊也不能在这里抛异常或编造一个不存在的码。
    """
    if isinstance(error, str) and error:
        return error
    if isinstance(error, dict):
        nested = error.get("codex_error_info")
        if isinstance(nested, dict):
            code = nested.get("code")
            if isinstance(code, str):
                return code
        for key in ("code", "type"):
            code = error.get(key)
            if isinstance(code, str):
                return code
        return "error"
    return "error"


def _output_error_code(error):
    """`function_call_output` 的 `error`（真实日志全 null）→ `error_code` 的稳定性标记：
    非 null 即 "error"。SV613(b) 只判 `is_some()`，SV607/608 只认 DSH 码，
    所以「有没有失败」这条轴是诚实的，具体码值不值得逐对象猜。
    """
    return None if error is None else "error"


def _is_i64(value):
    """`serde_json::as_i64` 的镜像：只认 int；bool 是 int 子类必须排除，
    浮点（`128000.0` 之类）也一样挡在门外（Rust `as_i64` 对两者都返回 None）。"""
    return isinstance(value, int) and not isinstance(value, bool)


def _timeline_entry(observation, seq, turn, call_id, ordinal):
    """一条 timeline entry 的构造器。Codex 无 seq/step：`seq` 用 enumerate 序数当
    合成 seq（`NativeId::Seq` 注释「适配器内部合成的序号」的正当用法），`time`/`step`
    留 None（`started_at` 秒 vs DSH 毫秒的时间轴统一是 timeaxis 阶段的事）。
    """
    return {"observation": observation, "seq": seq, "time": None, "turn": turn,
            "step": None, "call_id": call_id, "ordinal": ordinal}


def _next_turn_ordinal(ordinals, turn_id):
    """按 task_started 出现序给 turn_id 分配合成序数：见过的返回旧号，新的分配
    `len(ordinals)`（保证 0,1,2,… 连续且按出现序递增）。
    """
    if turn_id in ordinals:
        return ordinals[turn_id]
    ordinal = len(ordinals)
    ordinals[turn_id] = ordinal
    return ordinal


_EXEC_COMMAND_RE = re.compile(
    r"""exec_command\(\s*\{\s*["']cmd["']\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')""",
    re.S,
)


def _cmd_from_js_input(input_text):
    """Legacy 回退：从 `custom_tool_call` 的 `input`（JS 片段）里挖真 shell 命令。

    `custom_tool_call{name:"exec"}` 是 **JS 沙箱工具**，不是 shell——真实日志 7/25
    的 679 次工具执行里，`input` 真跑的是 exec_command（474）、apply_patch（127）、
    write_stdin（61）、view_image（23）、web__run（8）、image_gen（2）、
    mcp__node_repl__js（1）。只有字面量 `exec_command({"cmd":"…"})` 才是 shell 命令，
    翻译成 `bash` 有依据；其余（JS 动态拼 cmd / 非 shell 工具）诚实跳过——SV601-603
    只认 `name=="bash"`，不会在 apply_patch 上误报。

    quote-aware：值以 `"` 开就吃到匹配的 `"`（允许 `\\"`），以 `'` 开就吃到 `'`。
    旧写法 `[^"']` 会在值内嵌的单引号处截断，把 `sed -n '1,240p' '…'` 截成
    `sed -n ` 这种看着像命令的残片——args_text 必须取完整命令，正则得认全引号。
    与 Rust `exec_command_cmd`（`codex_evidence.rs`）同一模式、同一组号。
    """
    m = _EXEC_COMMAND_RE.search(input_text)
    if not m:
        return None
    # 二选一分支只有一个组参与匹配：双引号值落 group 1、单引号值落 group 2。
    return m.group(1) if m.group(1) is not None else m.group(2)


def _has_command_execution(items):
    """整份 session 有没有 CommandExecution？populate 的线格式探测。

    - 有（Paginated，真实 8/27：127 CommandExecution + 255 custom_tool_call）→
      CommandExecution 是 tool_calls 主源，custom_tool_call 是它的影子（call_id
      与 item.id 无 join key），跳过，否则双重计数破坏 SV611。
    - 没有（Legacy，真实 7/25：0 item_completed，679 次工具执行全是
      custom_tool_call）→ 回退到 `_cmd_from_js_input` 从 input JS 里挖真 shell 命令。

    与 Rust `populate_codex_timelines` 开头的 `has_command_execution` 同逻辑。
    """
    for item in items:
        if not isinstance(item, dict):
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue
        if payload.get("type") != "item_completed":
            continue
        item_obj = payload.get("item")
        if isinstance(item_obj, dict) and item_obj.get("type") == "CommandExecution":
            return True
    return False


def _populate_codex_timelines(items):
    """跑一遍 `items`，把 Codex 线格式翻译成五个 harness-neutral timeline（§11.5）。
    仿 Rust `populate_codex_timelines`（`crates/agent-vitals-harnesses/src/harnesses/codex/sessions/evidence.rs`）
    的状态机写法，与它逐条对齐：
    - `sandbox_modes`：顶层 turn_context 的 sandbox_policy（对象/字符串两态）→ 一条。
    - `tool_calls`：`CommandExecution` → `name:"bash"` + 命令文本；`function_call` →
      原生工具名 + arguments。`custom_tool_call` 看线格式：有 CommandExecution 时它是
      影子、**跳过**（双重计数破坏 SV611）；没有（Legacy，7/25 实测）→ 回退到
      `_cmd_from_js_input` 挖 `exec_command({cmd})` 真 shell 命令，挖不到的（apply_patch
      等非 shell 工具、JS 动态拼 cmd）诚实跳过。
    - `tool_results`：`CommandExecution` → `exit_code≠0` 时 `"exit_code:N"`；
      `function_call_output` → `.error` 非 null 时 `"error"`。**跳过**
      `custom_tool_call_output`（影子）；Legacy 回退的 **custom_tool_call 路径不填**——
      同源 output.error 实测恒 null，无 exit/error 源，用 None 填充只是假装
      MeasuredZero。规则最终结果看整份 session：function_call_output 路径照常填
      tool_results（error 恒 null → None），所以真机 Legacy 的 SV607/608 是
      MeasuredZero 不是 Unavailable（真值表见 build_codex_evidence 注释）。
    - `turns`：task_started 开、task_complete 收，合成 turn 序数；turn 内
      CommandExecution 的 (name, args_text) 进 `sig`（SV612 死循环检测的输入）。
      `function_call` 无 turn_id，只进 tool_calls、不进任何 turn 的 sig。
    - `approvals`：恒空——Codex 无 asked/decided 生命周期（approval_policy 是
      策略不是审批事件），「故意空」的构造点，比传一个永不填充的参数更诚实。

    `exec`→`bash` / `exit_code`→`error_code` 是 L2 适配器持有的执行环境词表翻译；
    诚实代价与真值表见 Rust `build_codex_evidence` 的注释（同一份，不另抄）。
    """
    tool_calls, tool_results, sandbox_modes, turns = [], [], [], []
    turn_ordinals = {}
    pending = {}
    # 未关闭 turn 的开启序——EOF 兜底时按这个序 flush，保证 turns 输出顺序确定
    # （dict 迭代序是插入序，但 HashMap 无序，这里显式留 open_order 与 Rust 对齐）。
    open_order = []

    # 线格式探测：整份 session 有没有 CommandExecution？决定 custom_tool_call 是
    # 影子（跳过）还是主源（回退挖 cmd）。coverage 侧 custom_tool_call 本来就计
    # ToolCalls measured（见 derive_coverage），回退是把 timeline 补到与覆盖一致。
    has_command_execution = _has_command_execution(items)

    for ordinal, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue
        seq = ordinal
        inner = payload.get("type")
        if not isinstance(inner, str):
            inner = ""
        top = item.get("type")
        if not isinstance(top, str):
            top = ""

        if top == "turn_context":
            mode = _sandbox_policy_mode(payload)
            if mode is not None:
                sandbox_modes.append(_timeline_entry(
                    {"mode": mode}, seq, None, None, ordinal))
        elif top == "event_msg" and inner == "task_started":
            turn_id = payload.get("turn_id")
            if not isinstance(turn_id, str):
                turn_id = ""
            turn = _next_turn_ordinal(turn_ordinals, turn_id)
            open_order.append(turn_id)
            pending[turn_id] = {
                "turn": turn, "sig": [], "last_seq": seq,
                "end_reason_kind": None, "end_error_code": None,
                "end_seq": None, "end_time": None,
            }
        elif top == "event_msg" and inner == "task_complete":
            turn_id = payload.get("turn_id")
            if not isinstance(turn_id, str):
                turn_id = ""
            started_at = payload.get("started_at")
            if not _is_i64(started_at):
                started_at = None
            error = payload.get("error")
            p = pending.pop(turn_id, None)
            if p is not None:
                p["last_seq"] = seq
                p["end_seq"] = seq
                p["end_time"] = started_at
                if error is not None:
                    p["end_reason_kind"] = "error"
                    p["end_error_code"] = _error_code_from(error)
                turns.append(_timeline_entry(
                    {
                        "turn": p["turn"], "sig": p["sig"],
                        "last_seq": p["last_seq"],
                        "end_reason_kind": p["end_reason_kind"],
                        "end_error_code": p["end_error_code"],
                        "end_seq": p["end_seq"], "end_time": p["end_time"],
                    },
                    seq, p["turn"], None, ordinal))
        elif top == "event_msg" and inner == "item_completed":
            it = payload.get("item")
            item_type = it.get("type") if isinstance(it, dict) else None
            if item_type == "CommandExecution" and isinstance(it, dict):
                name = "bash"  # exec → bash 翻译（L2 适配器执行环境词表）
                args = _command_text(it)
                turn_id = payload.get("turn_id")
                turn_coord = None
                if isinstance(turn_id, str):
                    turn_coord = turn_ordinals.get(turn_id)
                call_id = it.get("id")
                call_id = call_id if isinstance(call_id, str) else None
                tool_calls.append(_timeline_entry(
                    {"name": name, "args_text": args}, seq, turn_coord, call_id,
                    ordinal))
                # 结果：exit_code 非零 → 合成码 "exit_code:N"（SV613(b) 认 is_some，
                # SV607/608 的 DSH 码集不会误报）；零 → None（成功）。
                exit_code = it.get("exit_code")
                if not _is_i64(exit_code):
                    exit_code = None
                error_code = None
                if exit_code is not None and exit_code != 0:
                    error_code = "exit_code:%s" % exit_code
                tool_results.append(_timeline_entry(
                    {"error_code": error_code}, seq, turn_coord, None, ordinal))
                # 归属 turn 的 sig（按 payload.turn_id 直接归属，不依赖状态机：
                # 该 turn 的 task_started 先到，pending 里必然在）。
                if isinstance(turn_id, str) and turn_id in pending:
                    pending[turn_id]["sig"].append((name, args))
        elif top == "response_item" and inner == "custom_tool_call":
            # Legacy 回退：有 CommandExecution 时这分支是影子、整支跳过（见上
            # has_command_execution 注释）；没有时挖 input 里 exec_command({cmd})。
            # 只挖得出真 shell 命令的才翻成 bash；**本路径不填 tool_results**——同源
            # custom_tool_call_output.error 实测恒 null，无 exit/error 源，用 None
            # 填充只是假装 MeasuredZero。规则最终结果看整份 session：function_call_
            # output 路径照常填 tool_results（error 恒 null → None），所以真机 Legacy
            # 的 SV607/608 是 MeasuredZero 不是 Unavailable（真值表见 build_codex_
            # evidence 注释）；不进 turn sig（Legacy custom_tool_call 无 turn_id，
            # 679/679 实测）。
            if not has_command_execution:
                input_text = payload.get("input")
                input_text = input_text if isinstance(input_text, str) else ""
                cmd = _cmd_from_js_input(input_text)
                if cmd is not None:
                    call_id = payload.get("call_id")
                    call_id = call_id if isinstance(call_id, str) else None
                    tool_calls.append(_timeline_entry(
                        {"name": "bash", "args_text": cmd}, seq, None, call_id,
                        ordinal))
        elif top == "response_item" and inner == "function_call":
            name = payload.get("name")
            name = name if isinstance(name, str) else ""
            args_text = payload.get("arguments")
            args_text = args_text if isinstance(args_text, str) else ""
            call_id = payload.get("call_id")
            call_id = call_id if isinstance(call_id, str) else None
            tool_calls.append(_timeline_entry(
                {"name": name, "args_text": args_text}, seq, None, call_id,
                ordinal))
        elif top == "response_item" and inner == "function_call_output":
            error_code = _output_error_code(payload.get("error"))
            call_id = payload.get("call_id")
            call_id = call_id if isinstance(call_id, str) else None
            tool_results.append(_timeline_entry(
                {"error_code": error_code}, seq, None, call_id, ordinal))

    # EOF 兜底：未收到 task_complete 的 turn 也 push（end_* 为 None）——SV613(a)
    # 跳过 end_seq == None 的 turn，这类 turn 只贡献 sig 给 SV612，语义与 DSH 的
    # EOF 关闭一致。
    for tid in open_order:
        p = pending.pop(tid, None)
        if p is not None:
            turns.append(_timeline_entry(
                {
                    "turn": p["turn"], "sig": p["sig"], "last_seq": p["last_seq"],
                    "end_reason_kind": None, "end_error_code": None,
                    "end_seq": None, "end_time": None,
                },
                None, p["turn"], None, 0))

    timelines = {
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "approvals": [],
        "sandbox_modes": sandbox_modes,
        "turns": turns,
    }
    return {key: {"entries": timelines[key]} for key in _TIMELINE_KEYS}


# Audit is deliberately evaluated from the canonical timelines above, not from
# rollout records again.  That keeps the harness adapter responsible for vocabulary
# translation and gives the Python CLI the same rule boundary as Rust core.
# §6.5 regex 与 `_audit_evidence`/`_audit_finding`/求值器本体全部移入共享模块
# `canonical_audit.py`——Codex 与 Claude 是同一批 core dispatcher 的两个执行环境镜像，
# 求值器是执行环境无关的，只允许一份 Python 拷贝（差分测试把关不漂移）。


def codex_audit_projection(canonical):
    """Evaluate SV601–SV614 on canonical Codex timelines.

    Delegates to the shared harness-neutral evaluator in `canonical_audit.py`
    (the Python mirror of Rust's canonical dispatchers).  Codex has no
    harness-specific degradation to apply here.
    """
    return canonical_audit.audit_projection(canonical)


def build_codex_evidence(items, session_id, title, history_mode, cli_version,
                         workspace_roots, model):
    """条目数组 → evidence 字典（"derive → coverage" 两段；"locate → shape →
    extract" 留在 `adapters/codex_session.py`）。与 Rust
    `build_codex_evidence` 对齐：返回 `{"canonical", "items", "title",
    "history_mode", "cli_version"}`，其中 `canonical` 是 `CanonicalSession` 的
    等价字典。

    这是**第一条真的把 `attempts` 填起来**的适配器（DSH 的 attempts 一直是空
    列表）：未知条目类型记成 `{available: False, error: "unknown … type: …"}`
    ——§14.4 说 Codex 只能靠 existence probing 降级，"skipped and recorded in
    attempts, never treated as corruption"。

    `title` 是 `session_index.jsonl` 查出的 `thread_name`（**Codex 专属
    provenance**，与 `history_mode`/`cli_version` 同位——放 evidence 顶层，
    不放 `canonical`，§12 铁律「执行环境专属字段不进共享类型层」）。`None` 表示
    索引缺失或该 session 不在索引里，绝不编造。
    """
    signals, coverage, unknown = derive_coverage(items)
    attempts = [{
        "source_id": "codex.rollout.jsonl",
        "kind": "LogFile",
        "surface": "SessionLog",
        "available": False,
        "error": msg,
        "observed_span": None,
    } for msg in unknown]

    notes = []
    if _total(coverage["SkillInvocations"]) > 0:
        # §14.3：诚实标记 Derived，说明离线推断可能与执行环境运行时决定不一致，
        # 且明确拒绝 port 上游的 detect_implicit_skill_invocation_for_command。
        # 这段文本在 Rust 里逐字节相同。
        notes.append(_SKILL_INVOCATION_NOTE)

    canonical = {
        "meta": {
            "session_id": session_id,
            "harness_id": "codex",
            "workspace_roots": workspace_roots,
            "model": model,
            # D1–D4：Codex 的顶层 `{type, timestamp, payload}` 包络带 ISO 时间戳。
            # **必须走 `iso_to_epoch_ms` 而不是 `parse_iso`**——后者只到秒，会与
            # Rust 侧的毫秒精度不一致（差分门逐字节比）。0 条记录 → None。
            "span": session_span(
                t for t in (iso_to_epoch_ms(r.get("timestamp")) for r in items)
                if t is not None
            ),
        },
        "signals": signals,
        "coverage": coverage,
        "attempts": attempts,
        "notes": notes,
        # §11.5 timeline 原生填充（2026-08）：Codex 线格式能填满 4 条（approvals
        # 除外），见 `_populate_codex_timelines`。上一轮「Codex wire 格式凑不齐
        # payload、硬填即编造零、timeline 恒为空」的结论基于旧 fixture，被真实
        # rollout 纠正。诚实真值表（喂 Codex canonical 后每条 SV 规则的结果）：
        #
        #   Paginated（CommandExecution 在）：
        #     SV601/602/603 → 跑（exec→bash）       SV604/605/606 → MeasuredZero
        #     SV607/608 → MeasuredZero（exit_code:N ∉ DSH 码集）
        #     SV609 → Unavailable（approvals 空）    SV610 → 跑（danger-full-access）
        #     SV611/612/613 → 跑                     SV614 → c 可发；a/b 空转（OR 门控）
        #   Legacy（无 CommandExecution，真实 7/25 的 679 次 custom_tool_call）：
        #     SV601/602/603 → 跑——只挖得出 exec_command({cmd}) 的翻 bash
        #       （实测 187/679），apply_patch 等非 shell 不误报
        #     SV604/605/606 → MeasuredZero            SV607/608 → MeasuredZero
        #       （custom_tool_call 路径不产 tool_results，但 function_call_output
        #       照常填、error 恒 null → None，规则照跑零命中）
        #     SV609 → Unavailable                     SV610 → 跑
        #     SV611 → 跑（只在挖出的 bash 子集上）    SV612 → MeasuredZero（custom_tool_call
        #       与 function_call 都无 turn_id，turn sig 恒空被跳过）
        #     SV613 → MeasuredZero（(a) 无 error turn；(b) tool_results 的 error_code
        #       恒 None）    SV614 → c 可发；a/b 空转
        #
        # 一个已知的诚实性代价：populate tool_calls 本身就把 Paginated 的
        # SV604-606/607-608 从 Unavailable 翻成 MeasuredZero——正是「门控读 timeline
        # 而非 coverage」要保护的那类问题。`exec→bash` 救回 3 条 shell 规则，但
        # write/edit/web_fetch、DSH 错误码这些 Codex 没有的维度只能 MeasuredZero
        # （name-aware 门控是后续项）。Legacy 的另一半诚实性：挖不出的 non-cmd
        # 调用不硬翻 bash（避免在 apply_patch 上误报 SV601），代价是 SV611 只覆盖
        # shell 子集——宁缺勿假。
        **_populate_codex_timelines(items),
    }
    return {"canonical": canonical, "items": items,
            "title": title,
            "history_mode": history_mode, "cli_version": cli_version}


def codex_evidence_json(evidence):
    """evidence 字典 → `codex-evidence --json` 的输出形状。与 Rust
    `codex_evidence_json` 逐字节对齐——键序、嵌套结构、`attempts`/`notes` 的
    序列化都是这里单独控制的。`signals` 数组按 ALL_SIGNALS 序；`coverage` 19
    键全量（unavailable 的也是全零四条，不是缺键）；`available` 标记执行环境是否
    提供该维度——false = 结构缺口，任何会话都为零，KPI 分母不算它。
    """
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
    attempts = []
    for a in canonical["attempts"]:
        entry = {
            "source_id": a["source_id"],
            "kind": a["kind"],
            "surface": a["surface"],
            "available": a["available"],
            "error": a["error"],
            "observed_span": a["observed_span"],
        }
        if a["observed_span"] is not None:
            span = a["observed_span"]
            entry["observed_span"] = {"start_ms": span["start_ms"],
                                      "end_ms": span["end_ms"]}
        attempts.append(entry)
    notes = [n["message"] if isinstance(n, dict) else n
             for n in canonical["notes"]]
    return {
        "harness": "codex",
        "session_id": canonical["meta"]["session_id"],
        "title": evidence["title"],
        "history_mode": evidence["history_mode"],
        "cli_version": evidence["cli_version"],
        "workspace_roots": canonical["meta"]["workspace_roots"],
        "model": canonical["meta"]["model"],
        # 会话实际覆盖跨度（D1–D4）。键位置与 Rust 序列化器逐字节对齐。
        "span": canonical["meta"]["span"],
        "signals": signals,
        "coverage": coverage_map,
        "attempts": attempts,
        "notes": notes,
    }
