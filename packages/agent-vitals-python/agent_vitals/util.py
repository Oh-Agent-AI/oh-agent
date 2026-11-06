"""Small deterministic helpers shared by inventory and report code."""

import hashlib
import json

# 危险命令可能藏在 run_code 桥接出的嵌套子调用里，规则须一并匹配——与
# behavior.py 的 TOOL_CALL_TYPES 是同一份常量，这里独立定义一份（不 import
# behavior.py：那边才该反过来 import 这里，避免循环依赖）。
_TOOL_CALL_TYPES = ("tool/call", "tool/code-dispatch-start", "tool/code-dispatch")

# 事件 type → 计入哪个信号的覆盖计数。与 Rust
# crates/agent-vitals-harnesses/src/harnesses/dsh/sessions/evidence.rs::derive_coverage 对齐，只镜像
# 目前 P3 各 group 实际用到的信号（不是完整 19 个）。approval/asked 和
# approval/decided 是同一个"问了→给了结果"生命周期的两端，都算
# ApprovalDecisions 的证据——与 Rust 那边这次一起修的 bug 对齐（之前只数了
# decided，漏了 asked）。
SIGNAL_EVENT_TYPES = {
    "ToolCalls": _TOOL_CALL_TYPES,
    "ToolResults": ("tool/result",),
    "ApprovalDecisions": ("approval/asked", "approval/decided"),
    "SandboxModes": ("sandbox/mode",),
    "TurnBoundaries": ("turn/start", "turn/end"),
    "StepBoundaries": ("step/start", "step/end"),
    "Hooks": ("hook/invoked", "hook/result"),
    "Compaction": ("compaction/start", "compaction/summary", "compaction/end", "compaction/prune"),
}

# SubagentSpawns / SkillInvocations 不是按 type 白名单能数出来的独立事件——
# 前者要看 tool/call 的 data.name=="subagent"（subagent.rs 判定子代理启动
# 的唯一入口），后者是两条独立路径的并集：explicit 挂在 user/message 上
# （dsh.rs 只在 data.source.kind=="skill-invocation" 时才把 user/message
# 塞进 execution_events，普通 user/message 不会出现在这里，数它不需要再判
# 一次 source.kind）、model_selected 挂在 tool/call name=="skill" 上。
# 只镜像"有没有这类证据"，不重新实现 subagent.py/skill.py 的完整判定逻辑
# （那两个还要从 tool/result 文本里抠 UUID、按 callId 配对）。与 Rust
# dsh_evidence.rs 这次一起改的逻辑逐字节对齐。
_FIELD_BASED_SIGNALS = {
    "SubagentSpawns": lambda e: e.get("type") == "tool/call" and (e.get("data") or {}).get("name") == "subagent",
    "SkillInvocations": lambda e: e.get("type") == "user/message" or (
        e.get("type") == "tool/call" and (e.get("data") or {}).get("name") == "skill"),
}


def signal_coverage(events):
    """事件流 → 各信号的证据计数（镜像 Rust
    dsh_evidence.rs::derive_coverage，只取 `SIGNAL_EVENT_TYPES` 里这几个 +
    `_FIELD_BASED_SIGNALS`，不是完整 19 个）。调用方负责先 `post_fork`——
    覆盖率不能算进分叉前的历史,否则一个信号的证据全部落在分叉前会被误判
    成"有覆盖"。"""
    counts = {name: 0 for name in SIGNAL_EVENT_TYPES}
    counts.update({name: 0 for name in _FIELD_BASED_SIGNALS})
    for event in events:
        if not isinstance(event, dict):
            continue
        for name, predicate in _FIELD_BASED_SIGNALS.items():
            if predicate(event):
                counts[name] += 1
        etype = event.get("type")
        for name, types in SIGNAL_EVENT_TYPES.items():
            if etype in types:
                counts[name] += 1
    return counts


def run_id(report) -> str:
    """报告内容的短哈希 —— 用来证明这份报告背后真的跑过一次扫描。

    防的不是「算错数字」（那一类已经被结构性消灭：token 数、预算、冲突分类
    只以扫描输出的形式存在），而是**根本没跑就凭上次的印象写报告**。Agent
    编不出这 8 位，因为它由本次扫描的全部内容决定。

    **不进 scan JSON**，只在渲染时算。放进 schema 会让 11 份 golden 全部失效，
    而 CLAUDE.md 明确警告过反射性 `--update` 会让 golden 退化成「当前行为的
    记录」，测试就此失去意义。

    同一份机器状态在同一天重复跑得到同一个值；`days_since` 按天变，所以跨天
    会变 —— 那本来就是另一次扫描。

    `default=str` 是保险：标记算不出来也绝不能让 doctor 崩掉。
    """
    canonical = json.dumps(report, sort_keys=True, ensure_ascii=False,
                           separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]


def safe_str(value: str) -> str:
    """Replace surrogateescaped filename bytes with the Unicode replacement char."""
    return value.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def norm(path) -> str:
    """Return a lossy, forward-slash path representation on every platform."""
    return safe_str(str(path).replace("\\", "/"))


def split_lines(s: str) -> list:
    """JSONL 专用换行切分——只认 `\\n` / `\\r\\n` / `\\r`，不认 Python
    `str.splitlines()` 额外识别的那批 Unicode 段落/换行符（`\\v` `\\f`
    `\\x1c`–`\\x1e` `\\x85` `\\u2028` `\\u2029`）。与 Rust 的 `util::split_lines`
    逐字节对齐——那个函数本来就是为这个目的写的，只是当初 `dsh.py` 这边没跟着
    换掉，直接用了裸 `str.splitlines()`。

    JSONL 一条记录的边界只能是真正的换行；这几个 Unicode 分隔符合法出现在
    JSON 字符串值里（JSON 只要求转义 U+0000–U+001F、`"`、`\\`），用
    `str.splitlines()` 切会把它们也当成记录分隔符，把一整行 JSON 拦腰斩断。
    真实会话日志里出现过这种字符（用户可见文本内容自带 U+0085），Python 侧
    因此把一份完全可读的日志误判成 `degraded: non-json`，Rust 侧没有这个
    问题——这不是假设性的边界情况，是一份真实用户日志（session-9681e216）
    实测触发的。"""
    out = []
    start = 0
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == "\n":
            out.append(s[start:i])
            i += 1
            start = i
        elif ch == "\r":
            out.append(s[start:i])
            i += 2 if i + 1 < n and s[i + 1] == "\n" else 1
            start = i
        else:
            i += 1
    if start < n:
        out.append(s[start:])
    return out


def est_tokens(text: str) -> int:
    """粗略 token 估算。中文按 0.6 token/字符，其余按 0.3 token/字符——DeepSeek
    官方换算比例（https://api-docs.deepseek.com/zh-cn/quick_start/token_usage）。

    2026-08-21 从旧比例（CJK/1.5、其余/4，来源不可考）改过来的：拿真实会话
    550 段 assistant 输出（reasoning+text 合并——这是推理模型，outputTokens
    把隐藏推理内容也计进去了，只算可见文本会先低估 69%）比对 provider 实际
    outputTokens，旧公式系统性低估 22.2%，DeepSeek 官方比例低估 8.8%，明显
    更准。仍然是估算，不是精确计数——DeepSeek 自己的文档也写"以接口返回为准"。

    Rust 平行实现见 `crates/agent-vitals-domain/src/domain/util.rs`。
    """
    if not text:
        return 0
    cjk = sum(1 for char in text if "一" <= char <= "鿿")
    other = len(text) - cjk
    return int(cjk * 0.6 + other * 0.3)


def fork_boundary(events):
    """会话分叉边界：日志头 `session` 事件里的 `seedLength`；没有就是没分叉。

    DSH 里从已有会话「branch into new conversation」派生的新会话，会先把上游
    会话的整段事件历史**原样抄进自己的日志**再往后追加。抄来的那段含上游当时
    的 usage 记录——那笔钱已经算在上游那本账里了，不认这条边界就是重复计费。

    实测 session-e4b0be69：分叉前 ¥680.36 / 分叉后 ¥433.30，显示的 ¥1113.66
    里 61% 是上游的账。证据：分叉前那段 513 个 callId 逐个都能在上游日志里找到
    （100%），分叉后那段只有 3.5% 重叠。

    **为什么不能用 `session/end-seed` 事件**：初版就是那么做的（事件在流里，
    wasm 和执行环境都拿得到，不用透传 header），并在 e4b0be69 上验证通过——那个
    会话的第一个 end-seed 正好等于 seedLength。但那是巧合。`session/end-seed`
    标记的是「一段续种结束」，**会话每次被重新唤醒都会触发**：真实日志
    session-6b47acc7 完全没分叉（seedLength 缺席、parentSession 为空），却有
    一个 end-seed 落在 seq=65762——整份日志的最后一个事件。按「第一个 end-seed」
    判，整个会话都会被丢光，UI 上费用/上下文/常驻前缀/子代理全变「不可用」。

    一个事件是不是分叉边界，取决于当初有没有分叉，而这只有日志头知道。
    """
    for e in events:
        # 非 dict 条目跳过而不是崩——Rust 侧 `Value::get` 对非 object 天然
        # 返回 null，两侧要同一条容错纪律（真实 dsh.py 读出的事件流从不会有
        # 这种条目，但 skill.py 等纯函数消费者不再只吃它的输出）。
        if not isinstance(e, dict) or e.get("type") != "session":
            continue
        # 顶层与 data 下都看一眼：CLI 读的是原始日志头（顶层），执行环境侧是从
        # session.header 合成的（可能挂在 data 下）。
        n = e.get("seedLength")
        if n is None and isinstance(e.get("data"), dict):
            n = e["data"].get("seedLength")
        # 0 或负数不是有效边界——那是「没有续种」，不是「续种了 0 个事件」。
        return n if isinstance(n, int) and n > 0 else None
    return None


def post_fork(events):
    """只保留分叉之后的事件；没有分叉标记时原样返回。"""
    b = fork_boundary(events)
    if b is None:
        return list(events)
    return [e for e in events
            if not isinstance(e, dict) or not isinstance(e.get("seq"), int) or e["seq"] >= b]


def find_request(requests, turn, step):
    """把一次 `(turn, step)` 对回 `request_metrics` 那次请求行——精确匹配
    turn+step，不是"最近的 seq"。`skill.py` 与 `waste.py` 共用，语义一致。
    非 dict 行跳过而不是崩（喂进来的 requests 不保证全是良构 dict）。"""
    for r in requests:
        if isinstance(r, dict) and r.get("turn") == turn and r.get("step") == step:
            return r
    return None


def find_next_request(requests, after_request_seq):
    """`find_request` 命中后算上下文增量 after 值用：`request_seq` 严格大于
    `after_request_seq` 里最小的一次（`waste.py::_emit_failure_waste` 用）。"""
    candidates = [r for r in requests
                  if isinstance(r.get("request_seq"), int) and r["request_seq"] > after_request_seq]
    if not candidates:
        return None
    return min(candidates, key=lambda r: r["request_seq"])


# ────────────────────────── 纪元时间归一与会话跨度 ──────────────────────────
#
# 镜像 Rust `agent_vitals_domain::util::to_epoch_ms` +
# `agent_vitals_harnesses::workflow_utils::session_span`。
# 方案：`docs/v1.0.0/OBSERVED_SPAN_IMPLEMENTATION_PLAN.md`。

EPOCH_SECONDS_CUTOFF = 100_000_000_000
_I64_MIN = -(2 ** 63)
_I64_MAX = 2 ** 63 - 1


def to_epoch_ms(value: int) -> int:
    """纪元时间归一为**毫秒**——本仓「整数纪元一律以毫秒为契约」的唯一实现。

    秒级输入（`< 1e11`）视为秒并放大 1000 倍，其余原样返回。**幂等**。

    `_I64_*` 钳位是为了与 Rust 的 `saturating_mul` 逐位一致：Rust 溢出时饱和到
    i64 边界，Python 整数无界，不钳就会在畸形输入上偏离（差分门是逐字节比的）。
    """
    if value < EPOCH_SECONDS_CUTOFF:
        return max(_I64_MIN, min(_I64_MAX, value * 1000))
    return value


def session_span(times):
    """会话跨度 = **喂进这份证据的所有原生记录**时间的 min/max。

    语义（`OBSERVED_SPAN_IMPLEMENTATION_PLAN.md` §3.1 的 D1–D4）：

    - **D1** 取实测事件时间，不是会话头声明的范围。
    - **D2** **0 条记录 → `None`**，**绝不返回 `{"start_ms": 0, "end_ms": 0}`**——
      后者会被日桶/时间窗读成 1970-01-01，正是本仓反复栽过的「把缺失渲染成零」。
      单条记录 → `start_ms == end_ms`（合法）。
    - **D3** 一律过 `to_epoch_ms`（Claude 与 WorkBuddy 的 `parse_iso` 出**秒**，
      DSH 出**毫秒**）。
    - **D4** 只取原生记录的时间，不含合成的序数。

    跨度跟随调用方给的记录集合：给的是分叉后的事件，跨度就是分叉后的。
    """
    values = [to_epoch_ms(t) for t in times]
    if not values:
        return None
    return {"start_ms": min(values), "end_ms": max(values)}


def iso_to_epoch_ms(value):
    """ISO-8601 串 → **毫秒**。镜像 Rust `agent_vitals_harnesses::workflow_utils::iso_to_epoch_ms`。

    **为什么不直接用 `parse_iso`**：那个只到**秒**（`(secs, has_offset)`）。Codex 的
    跨度若只按秒算，就会与 Rust 侧（解析到毫秒小数位）不一致，而差分门是逐字节
    比的——`2026-09-05T17:00:00.123Z` 两边会差 123ms。

    分数位处理与 Rust 逐条对齐：取小数点后最多 3 位、补零到 3 位；含非数字 → None；
    无小数部分 → 0。

    **非字符串一律 None**——镜像 Rust 的 `Option<&str>` 签名：那边的调用点是
    `.and_then(Value::as_str)`，整数/布尔/null 根本进不来。夹具里 `"timestamp": 0`
    这种整数时间戳在两侧都按"没有可解析的 ISO 串"处理。
    """
    if not isinstance(value, str):
        return None
    # 延迟导入：`claude_evidence` 反过来依赖本模块（`session_span`），
    # 模块加载期导入会成环。同 `behavior.py` 的 `from ..adapters import dsh`。
    from .agent.claude_evidence import parse_iso
    parsed = parse_iso(value)
    if parsed is None:
        return None
    seconds = parsed[0]
    if "." not in value:
        fraction = ""
    else:
        rest = value.split(".", 1)[1]
        cuts = [i for i in (rest.find(c) for c in "Z+-") if i != -1]
        fraction = rest[:min(cuts)] if cuts else rest
    digits = fraction[:3]
    if any(not c.isdigit() for c in digits):
        return None
    fraction_ms = int(digits.ljust(3, "0")) if digits else 0
    return seconds * 1000 + fraction_ms
