"""V16 内容富化原语：错误分类词表、凭据 scrub、任务意图摘录。

`crates/agent-vitals-domain/src/domain/enrichment.rs` 的逐函数 Python 镜像——
权威定义：`docs/v1.0.0/SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md` §2/§3。
锁步测试：`tests/test_enrichment_lockstep.py` + 共享向量
`fixtures/enrichment/vectors.json`（两侧断言同一份期望；改向量 = 双语言一起过评审）。

诚实性规则（与 Rust 侧 docstring 逐条对齐，naive 实现为什么是错的）：
1. scrub 先于截断（先截断会把凭据劈成两半漏检）。
2. 按 Unicode code point 截断（Python ``len()``/切片天然按码点，与 Rust
   ``chars()`` 同语义；不按字节）。
3. 空白裁剪用共享 ``WS_CHARS``（Unicode White_Space 全集），不用内建
   ``str.strip()``——后者额外裁 ``\\x1c``–``\\x1f``，两侧语义有缝。
4. 不追加省略号（provenance 已声明截断，文本里塞 ``…`` 是第二份真值）。
5. ``harness:`` 家族原生码一律归 ``unknown``，不猜分类。
6. ``scrubbed`` 优先于 ``truncated``（provenance 报更保守的那个）。
"""

import re
from collections import namedtuple

# ── 词表（闭合；新增值必须先改 spec §2） ──

ERROR_CLASS_VALUES = (
    "transport", "rate_limit", "auth", "schema_violation", "method_not_found",
    "timeout", "parse", "tool_policy", "context_overflow", "unknown",
)

#: spec §15 默认档位：200/120/120/120（改档位 = spec + 双语言 + vectors 三处一起改）。
ROLE_CHAR_LIMITS = {
    "user_first": 200,
    "user_turn": 120,
    "assistant_final": 120,
    "subagent_task": 120,
}

PROVENANCE_VALUES = ("verbatim", "truncated", "scrubbed")

# ── scrub ──

#: scrub 命中的 span 统一替换标记（spec §15：改字形 = 双语言同改 + golden 评审）。
SCRUB_MARKER = "[…]"

#: Unicode White_Space 全集（25 字符），与 Rust 侧 ``WS_CHARS`` 同一字面量。
#: 全部用显式转义——U+2000–U+200A 一族肉眼不可分，写字面量等于埋雷。
WS_CHARS = (
    "\t\n\x0b\x0c\r\x20"
    "\x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)

#: 正则表（有序）。语法限定在 Python ``re`` 与 Rust ``regex`` 的公共子集：
#: 无 lookaround/反向引用；大小写不敏感用 ``(?i)`` 前缀、跨行块用 ``(?s)`` + 惰性
#: 量词（与 ``skills/security.py`` ↔ ``skills/security_rules.rs`` 同款纪律）。
#: 注意"公共**语法**"不等于"公共**语义**"——裸 ``\\s`` 在 Python 含 \\x1c-\\x1f、
#: 在 Rust 恰为 White_Space（Step1 对拍验收实锤），凡空白类一律用 WS_CHARS 字面类。
SCRUB_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"sk-[A-Za-z0-9_-]{20,}",
        r"gh[pousr]_[A-Za-z0-9]{36,}",
        r"github_pat_[A-Za-z0-9_]{22,}",
        r"AKIA[0-9A-Z]{16}",
        r"xox[baprs]-[A-Za-z0-9-]{10,}",
        f"(?i)bearer[{WS_CHARS}]+[A-Za-z0-9._~+/=-]{{20,}}",
        # JWT：仅要求首段 eyJ（真实 JWT 的签名段是随机 base64url，不以 eyJ 开头）
        r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        r"(?s)-----BEGIN[A-Z ]*PRIVATE KEY-----.*?-----END[A-Z ]*PRIVATE KEY-----",
        r"(?s)-----BEGIN[A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\r\n ]{40,}",
    )
)

ScrubOutcome = namedtuple("ScrubOutcome", "text scrubbed")
Excerpt = namedtuple("Excerpt", "text provenance")


def scrub_text(text):
    """依序应用全部 scrub 正则，命中 span 替换为 ``SCRUB_MARKER``。"""
    current = text
    scrubbed = False
    for pattern in SCRUB_PATTERNS:
        replaced = pattern.sub(SCRUB_MARKER, current)
        if replaced != current:
            scrubbed = True
        current = replaced
    return ScrubOutcome(current, scrubbed)


def error_class_from_wire(value):
    """闭集校验；不在闭集内返回 ``None``（对应 Rust ``ErrorClass::from_wire``）。"""
    return value if value in _ERROR_CLASS_SET else None


_ERROR_CLASS_SET = frozenset(ERROR_CLASS_VALUES)


def classify_error_code(code):
    """``error_code`` 语法 ``家族:细节`` → 闭集分类。

    语法不合法或语义上不是错误（如 ``http:200``）返回 ``None``——对应库列存
    NULL（"未断言"），绝不存一个编造的类（规则 5）。
    """
    if ":" not in code:
        return None
    family, detail = code.split(":", 1)
    if not detail:
        return None
    if family == "http":
        # ASCII 纯数字预检：int() 还收 Unicode 数字/下划线/前后空白/正号，
        # Rust 整数解析只认 ASCII——双侧显式收窄到同一条边界。
        if not (detail.isascii() and detail.isdigit()):
            return None
        status = int(detail)
        if not 100 <= status <= 599:
            return None
        if status in (401, 403):
            return "auth"
        if status in (408, 504):
            return "timeout"
        if status == 429:
            return "rate_limit"
        if 400 <= status <= 599:
            return "transport"
        return None  # 1xx–3xx 不是错误码
    if family == "jsonrpc":
        digits = detail[1:] if detail.startswith("-") else detail
        if not digits or not (digits.isascii() and digits.isdigit()):
            return None
        value = int(detail)
        # JSON-RPC 保留带恰为 −32768..−32000（−32799..−32769 是协议外，两侧同拒）。
        if not -32768 <= value <= -32000:
            return None
        if value == -32700:
            return "parse"
        if value in (-32600, -32602):
            return "schema_violation"
        if value == -32601:
            return "method_not_found"
        return "transport"  # -32603 internal 与 -32000..-32099 server 桶
    if family == "tool":
        # errno 风格的 ETIMEDOUT 不含子串 "timeout"（是 "timedout"）——两种拼法都认。
        lowered = detail.lower()
        if "timeout" in lowered or "timedout" in lowered:
            return "timeout"
        return "tool_policy"
    if family == "harness":
        return "unknown"  # 原生码透传，不猜（规则 5）
    return None


def make_excerpt(text, role):
    """三步钉死：归一（共享 WS 集裁剪首尾）→ scrub → 按码点截断（规则 1/2/3）。

    归一后为空返回 ``None``（调用方不产行——空文本没有"缺省摘录"）。
    ``role`` 是 ``ROLE_CHAR_LIMITS`` 的键。
    """
    normalized = text.strip(WS_CHARS)
    if not normalized:
        return None
    limit = ROLE_CHAR_LIMITS[role]
    outcome = scrub_text(normalized)
    if outcome.scrubbed:
        provenance = "scrubbed"
    else:
        provenance = "verbatim"
    if len(outcome.text) <= limit:
        return Excerpt(outcome.text, provenance)
    text = outcome.text[:limit]
    # 截断不得劈开 scrub 标记：残尾 '[' / '[…' 去掉（与 Rust 侧同规则；标记由
    # scrub 先于截断完整生成，截断只会落在标记内部或整段保留——劈开即残尾这两种）。
    if text.endswith("[…"):
        text = text[:-2]
    elif text.endswith("["):
        text = text[:-1]
    return Excerpt(text, "scrubbed" if outcome.scrubbed else "truncated")
