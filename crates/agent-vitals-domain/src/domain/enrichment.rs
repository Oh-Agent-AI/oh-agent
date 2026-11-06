//! V16 内容富化原语：错误分类词表、凭据 scrub、任务意图摘录。
//!
//! 权威定义：`docs/v1.0.0/SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md` §2/§3。
//! Python 镜像：`packages/agent-vitals-python/agent_vitals/agent/enrichment.py`
//! （逐函数同语义，锁步测试 `tests/test_enrichment_lockstep.py` + 共享向量
//! `fixtures/enrichment/vectors.json`——两侧断言同一份期望，改向量 = 双语言一起过评审）。
//!
//! 诚实性规则（naive 实现为什么是错的）：
//!
//! 1. **scrub 先于截断**。先截断会把凭据劈成两半，前后半段都漏检；且截断后
//!    scrub 的命中位置与全文不同，输出不再确定。顺序钉死：归一 → scrub → 截断。
//! 2. **按 Unicode code point 截断，不是字节**。CJK 每字符 3 字节、emoji 是
//!    代理对（UTF-16 视角 2 码元、UTF-8 视角 4 字节），按字节截会把字劈开并
//!    产出无效 UTF-8；两侧都以字符（Unicode 标量值）计数，Python `len()` 与
//!    Rust `chars().count()` 在这个定义下天然一致。
//! 3. **空白裁剪用显式字符集，不用语言内建 strip**。Python `str.strip()` 额外
//!    裁 `\x1c`–`\x1f`（文件分隔符），Rust `char::is_whitespace` 不含它们——
//!    内建函数两边语义有缝，共享 `WS_CHARS`（Unicode White_Space 全集）才能
//!    字节对等。
//! 4. **不追加省略号**。provenance 字段已经声明了截断，往文本里塞 `…` 是第二
//!    份真值：下游一旦按长度/前缀匹配就会两边不一致。
//! 5. **执行环境原生码不猜分类**。`harness:` 家族一律 `unknown`——拿不到语义的码，
//!    诚实归 unknown，比一个看起来合理其实编造的类好（`evidence.rs`「adapter
//!    不得用读不到的东西刷覆盖」同一条纪律）。
//! 6. **scrubbed 优先于 truncated**。两个字段语义并存时，provenance 报"更保守
//!    的那个"：读者最该知道的是这段文本被动过手脚，其次才是被截过。

use std::sync::OnceLock;

use regex::Regex;

// ────────────────────────── 词表（闭合，新增变体必须先改 spec） ──────────────────────────

/// 权威库 `workflow_events.error_class` 的十值闭集（spec §2）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum ErrorClass {
    Transport,
    RateLimit,
    Auth,
    SchemaViolation,
    MethodNotFound,
    Timeout,
    Parse,
    ToolPolicy,
    ContextOverflow,
    Unknown,
}

impl ErrorClass {
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorClass::Transport => "transport",
            ErrorClass::RateLimit => "rate_limit",
            ErrorClass::Auth => "auth",
            ErrorClass::SchemaViolation => "schema_violation",
            ErrorClass::MethodNotFound => "method_not_found",
            ErrorClass::Timeout => "timeout",
            ErrorClass::Parse => "parse",
            ErrorClass::ToolPolicy => "tool_policy",
            ErrorClass::ContextOverflow => "context_overflow",
            ErrorClass::Unknown => "unknown",
        }
    }

    /// 刻意不叫 `from_str`（clippy `should_implement_trait`；返回 `Option` 不返回
    /// `Result`——见 `data_contract.rs::BillingBasis` 的同款说明）。
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "transport" => ErrorClass::Transport,
            "rate_limit" => ErrorClass::RateLimit,
            "auth" => ErrorClass::Auth,
            "schema_violation" => ErrorClass::SchemaViolation,
            "method_not_found" => ErrorClass::MethodNotFound,
            "timeout" => ErrorClass::Timeout,
            "parse" => ErrorClass::Parse,
            "tool_policy" => ErrorClass::ToolPolicy,
            "context_overflow" => ErrorClass::ContextOverflow,
            "unknown" => ErrorClass::Unknown,
            _ => return None,
        })
    }

    pub const fn variant_count() -> usize {
        10
    }
}

/// `session_excerpts.role` 的四值闭集 + 各自的截断档位（spec §15 默认：200/120/120/120）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum ExcerptRole {
    UserFirst,
    UserTurn,
    AssistantFinal,
    SubagentTask,
}

impl ExcerptRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            ExcerptRole::UserFirst => "user_first",
            ExcerptRole::UserTurn => "user_turn",
            ExcerptRole::AssistantFinal => "assistant_final",
            ExcerptRole::SubagentTask => "subagent_task",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "user_first" => ExcerptRole::UserFirst,
            "user_turn" => ExcerptRole::UserTurn,
            "assistant_final" => ExcerptRole::AssistantFinal,
            "subagent_task" => ExcerptRole::SubagentTask,
            _ => return None,
        })
    }

    pub const fn variant_count() -> usize {
        4
    }

    /// 按 Unicode code point 计的截断上限（诚实性规则 2）。
    pub const fn char_limit(self) -> usize {
        match self {
            ExcerptRole::UserFirst => 200,
            ExcerptRole::UserTurn | ExcerptRole::AssistantFinal | ExcerptRole::SubagentTask => 120,
        }
    }
}

/// `session_excerpts.provenance` 三态（spec §2）。`verbatim` = 限内且未 scrub；
/// `truncated` = 超限截断；`scrubbed` = 命中凭据正则（优先级高于 truncated，规则 6）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum ExcerptProvenance {
    Verbatim,
    Truncated,
    Scrubbed,
}

impl ExcerptProvenance {
    pub const fn as_str(self) -> &'static str {
        match self {
            ExcerptProvenance::Verbatim => "verbatim",
            ExcerptProvenance::Truncated => "truncated",
            ExcerptProvenance::Scrubbed => "scrubbed",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "verbatim" => ExcerptProvenance::Verbatim,
            "truncated" => ExcerptProvenance::Truncated,
            "scrubbed" => ExcerptProvenance::Scrubbed,
            _ => return None,
        })
    }
}

// ────────────────────────── scrub：凭据永不落盘与保留文本的自洽点 ──────────────────────────

/// scrub 命中的 span 统一替换标记（spec §15：改字形 = 双语言同改 + golden 评审）。
pub const SCRUB_MARKER: &str = "[…]";

/// Unicode White_Space 全集（U+0009–U+000D、U+0020、U+0085、U+00A0、U+1680、
/// U+2000–U+200A、U+2028、U+2029、U+202F、U+205F、U+3000）。两侧共享同一份
/// 字面量裁剪，不用语言内建 strip（诚实性规则 3）。
pub const WS_CHARS: &str = concat!(
    "\t\n\x0b\x0c\r\x20",
    "\u{85}\u{a0}\u{1680}",
    "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}",
    "\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}",
);

/// scrub 正则表（有序）。语法刻意限定在 Python `re` 与 Rust `regex` 的公共子集：
/// 无 lookaround、无反向引用；大小写不敏感用 `(?i)` 前缀、跨行块用 `(?s)` + 惰性
/// 量词（`skills/security_rules.rs` ↔ `skills/security.py` 的同款纪律）。
fn scrub_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        // Bearer 与凭据之间的分隔符用共享 WS_CHARS 字面类，**不用裸 \s**——
        // Python re 的 \s 含 \x1c-\x1f（非 White_Space），Rust 的 \s 恰为
        // White_Space：同一模式两种语义（Step1 对拍验收实锤的分歧点）。类内
        // 全是空白、无正则元字符，可整体内嵌；分隔符语义与摘录归一（规则 3）
        // 钉在同一份常量上。
        let bearer = format!(r"(?i)bearer[{}]+[A-Za-z0-9._~+/=-]{{20,}}", WS_CHARS);
        [
            // OpenAI 风格 key
            r"sk-[A-Za-z0-9_-]{20,}".to_string(),
            // GitHub token 家族（ghp_/gho_/ghu_/ghr_/ghs_）
            r"gh[pousr]_[A-Za-z0-9]{36,}".to_string(),
            r"github_pat_[A-Za-z0-9_]{22,}".to_string(),
            // AWS access key id
            r"AKIA[0-9A-Z]{16}".to_string(),
            // Slack token 家族
            r"xox[baprs]-[A-Za-z0-9-]{10,}".to_string(),
            // Authorization: Bearer …（scheme 大小写不敏感）
            bearer,
            // JWT：仅要求首段 eyJ（真实 JWT 的签名段是随机 base64url，不以 eyJ 开头）
            r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}".to_string(),
            // PEM 私钥块：先整块（含 END），再裸头 + base64 长跑（无 END 的残块）
            r"(?s)-----BEGIN[A-Z ]*PRIVATE KEY-----.*?-----END[A-Z ]*PRIVATE KEY-----".to_string(),
            r"(?s)-----BEGIN[A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\r\n ]{40,}".to_string(),
        ]
        .iter()
        .map(|source| Regex::new(source).expect("scrub pattern must compile"))
        .collect()
    })
}

/// scrub 结果：处理后的文本 + 是否有任何命中。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ScrubOutcome {
    pub text: String,
    pub scrubbed: bool,
}

/// 依序应用全部 scrub 正则，命中 span 替换为 [`SCRUB_MARKER`]。
pub fn scrub_text(text: &str) -> ScrubOutcome {
    let mut current = text.to_string();
    let mut scrubbed = false;
    for pattern in scrub_patterns() {
        let replaced = pattern.replace_all(&current, SCRUB_MARKER).into_owned();
        if replaced != current {
            scrubbed = true;
        }
        current = replaced;
    }
    ScrubOutcome { text: current, scrubbed }
}

/// Session display titles use the same scrub-before-truncate rule as excerpts.
/// Kept in the enrichment layer so the contracts vocabulary module stays dependency-free.
pub fn bound_session_title(raw: &str) -> Option<String> {
    let text = scrub_text(raw).text;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(256).collect())
}

#[cfg(test)]
mod session_title_tests {
    use super::bound_session_title;

    #[test]
    fn session_title_is_scrubbed_trimmed_and_bounded_by_unicode_chars() {
        assert_eq!(bound_session_title("  会话标题  ").as_deref(), Some("会话标题"));
        assert_eq!(bound_session_title("   "), None);
        let long = bound_session_title(&"长".repeat(300)).unwrap();
        assert_eq!(long.chars().count(), 256);
        let scrubbed = bound_session_title("部署用了 sk-abcdefghij0123456789 别外传").unwrap();
        assert_ne!(scrubbed, "部署用了 sk-abcdefghij0123456789 别外传");
        assert!(scrubbed.contains("部署用了"));
    }
}

// ────────────────────────── 错误码分类 ──────────────────────────

/// `error_code` 语法 `家族:细节`（家族 ∈ http/jsonrpc/tool/harness）→ 闭集分类。
/// 语法不合法或语义上不是错误（如 `http:200`）返回 `None`——`error_class` 列
/// 存 NULL（"未断言"），绝不存一个编造的类（诚实性规则 5）。
pub fn classify_error_code(code: &str) -> Option<ErrorClass> {
    let (family, detail) = code.split_once(':')?;
    if detail.is_empty() {
        return None;
    }
    match family {
        "http" => {
            // ASCII 纯数字预检：Rust 整数解析本就只认这套；显式写出来是给 Python
            // 镜像的同一条边界（Python int() 还收 Unicode 数字/下划线/前后空白）。
            if !detail.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let status: u16 = detail.parse().ok()?;
            if !(100..=599).contains(&status) {
                return None;
            }
            match status {
                401 | 403 => Some(ErrorClass::Auth),
                408 | 504 => Some(ErrorClass::Timeout),
                429 => Some(ErrorClass::RateLimit),
                400..=599 => Some(ErrorClass::Transport),
                _ => None, // 1xx–3xx 不是错误码
            }
        }
        "jsonrpc" => {
            let digits = detail.strip_prefix('-').unwrap_or(detail);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let code: i32 = detail.parse().ok()?;
            // JSON-RPC 保留带恰为 −32768..−32000（−32799..−32769 是协议外，两侧同拒）。
            if !(-32768..=-32000).contains(&code) {
                return None;
            }
            match code {
                -32700 => Some(ErrorClass::Parse),
                -32600 | -32602 => Some(ErrorClass::SchemaViolation),
                -32601 => Some(ErrorClass::MethodNotFound),
                _ => Some(ErrorClass::Transport), // -32603 internal 与 -32000..-32099 server 桶
            }
        }
        "tool" => {
            // errno 风格的 ETIMEDOUT 不含子串 "timeout"（是 "timedout"）——两种拼法都认。
            let lower = detail.to_ascii_lowercase();
            if lower.contains("timeout") || lower.contains("timedout") {
                Some(ErrorClass::Timeout)
            } else {
                Some(ErrorClass::ToolPolicy)
            }
        }
        "harness" => Some(ErrorClass::Unknown), // 原生码透传，不猜（诚实性规则 5）
        _ => None,
    }
}

// ────────────────────────── 摘录提取 ──────────────────────────

/// 一次摘录的产物。`text` 是 scrub + 截断后的最终文本；`provenance` 声明它被动过什么。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Excerpt {
    pub text: String,
    pub provenance: ExcerptProvenance,
}

fn trim_ws(text: &str) -> &str {
    text.trim_matches(|c| WS_CHARS.contains(c))
}

/// 三步钉死：归一（共享 WS 集裁剪首尾）→ scrub → 按 code point 截断（诚实性规则 1/2/3）。
/// 归一后为空返回 `None`（调用方不产行——空文本没有"缺省摘录"）。
pub fn make_excerpt(text: &str, role: ExcerptRole) -> Option<Excerpt> {
    let normalized = trim_ws(text);
    if normalized.is_empty() {
        return None;
    }
    let scrubbed = scrub_text(normalized);
    let provenance = if scrubbed.scrubbed {
        ExcerptProvenance::Scrubbed
    } else {
        ExcerptProvenance::Verbatim
    };
    let limit = role.char_limit();
    if scrubbed.text.chars().count() <= limit {
        return Some(Excerpt { text: scrubbed.text, provenance });
    }
    let mut text: String = scrubbed.text.chars().take(limit).collect();
    // 截断不得劈开 scrub 标记：残尾 '[' / '[…' 去掉（两侧同规则）。标记由 scrub
    // 先于截断完整生成，截断只会落在标记内部或整段保留——劈开即残尾这两种。
    if text.ends_with("[…") {
        let keep = text.len() - '['.len_utf8() - '…'.len_utf8();
        text.truncate(keep);
    } else if text.ends_with('[') {
        text.pop();
    }
    Some(Excerpt {
        text,
        provenance: if scrubbed.scrubbed {
            ExcerptProvenance::Scrubbed // scrubbed 优先（规则 6）
        } else {
            ExcerptProvenance::Truncated
        },
    })
}

/// Shared local-presentation quality filter. Does not remove analytical signal at ingest.
/// Wrappers, bare file references and acknowledgement-only turns are not task summaries.
pub fn make_presentation_excerpt(text: &str, role: ExcerptRole) -> Option<Excerpt> {
    let normalized = trim_ws(text);
    let lower = normalized.to_ascii_lowercase();
    if ["<system", "<environment_context", "<command", "<local-command", "<image", "[image", "<tool_result"]
        .iter().any(|prefix| lower.starts_with(prefix)) { return None; }
    if matches!(lower.as_str(), "ok" | "okay" | "yes" | "no" | "continue" | "thanks" | "好的" | "继续" | "谢谢" | "可以") {
        return None;
    }
    if (normalized.starts_with('/') || normalized.starts_with("~/") || normalized.starts_with("file://"))
        && !normalized.contains(char::is_whitespace) { return None; }
    make_excerpt(normalized, role)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 词表往返 ──

    #[test]
    fn error_class_round_trips_all_ten_variants() {
        // 十项闭集逐个断言（新增/删除变体必须立刻在这里炸）。
        let all = [
            (ErrorClass::Transport, "transport"),
            (ErrorClass::RateLimit, "rate_limit"),
            (ErrorClass::Auth, "auth"),
            (ErrorClass::SchemaViolation, "schema_violation"),
            (ErrorClass::MethodNotFound, "method_not_found"),
            (ErrorClass::Timeout, "timeout"),
            (ErrorClass::Parse, "parse"),
            (ErrorClass::ToolPolicy, "tool_policy"),
            (ErrorClass::ContextOverflow, "context_overflow"),
            (ErrorClass::Unknown, "unknown"),
        ];
        assert_eq!(all.len(), ErrorClass::variant_count());
        for (variant, wire) in all {
            assert_eq!(variant.as_str(), wire);
            assert_eq!(ErrorClass::from_wire(wire), Some(variant));
        }
        assert_eq!(ErrorClass::from_wire("credits"), None);
    }

    #[test]
    fn excerpt_role_limits_match_spec_defaults() {
        // spec §15 默认档位：200/120/120/120。改档位 = spec + 双语言 + vectors 三处一起改。
        assert_eq!(ExcerptRole::UserFirst.char_limit(), 200);
        assert_eq!(ExcerptRole::UserTurn.char_limit(), 120);
        assert_eq!(ExcerptRole::AssistantFinal.char_limit(), 120);
        assert_eq!(ExcerptRole::SubagentTask.char_limit(), 120);
        assert_eq!(ExcerptRole::variant_count(), 4);
        assert_eq!(ExcerptRole::from_wire("user_first"), Some(ExcerptRole::UserFirst));
        assert_eq!(ExcerptRole::from_wire("assistant"), None);
    }

    // ── 分类 ──

    #[test]
    fn classify_covers_every_family_and_rejects_non_errors() {
        assert_eq!(classify_error_code("http:401"), Some(ErrorClass::Auth));
        assert_eq!(classify_error_code("http:403"), Some(ErrorClass::Auth));
        assert_eq!(classify_error_code("http:429"), Some(ErrorClass::RateLimit));
        assert_eq!(classify_error_code("http:504"), Some(ErrorClass::Timeout));
        assert_eq!(classify_error_code("http:500"), Some(ErrorClass::Transport));
        assert_eq!(classify_error_code("http:200"), None, "2xx 不是错误码");
        assert_eq!(classify_error_code("http:abc"), None, "细节必须可解析");
        assert_eq!(classify_error_code("jsonrpc:-32700"), Some(ErrorClass::Parse));
        assert_eq!(classify_error_code("jsonrpc:-32600"), Some(ErrorClass::SchemaViolation));
        assert_eq!(classify_error_code("jsonrpc:-32601"), Some(ErrorClass::MethodNotFound));
        assert_eq!(classify_error_code("jsonrpc:-32602"), Some(ErrorClass::SchemaViolation));
        assert_eq!(classify_error_code("jsonrpc:-32603"), Some(ErrorClass::Transport));
        assert_eq!(classify_error_code("jsonrpc:-32000"), Some(ErrorClass::Transport));
        assert_eq!(classify_error_code("jsonrpc:-1"), None, "保留区之外不猜");
        assert_eq!(classify_error_code("tool:enoent"), Some(ErrorClass::ToolPolicy));
        assert_eq!(classify_error_code("tool:timeout"), Some(ErrorClass::Timeout));
        assert_eq!(classify_error_code("tool:ETIMEDOUT"), Some(ErrorClass::Timeout));
        assert_eq!(classify_error_code("harness:claude_4711"), Some(ErrorClass::Unknown));
        assert_eq!(classify_error_code("ftp:550"), None, "家族闭集之外");
        assert_eq!(classify_error_code("http:"), None, "空细节");
        assert_eq!(classify_error_code("no-colon"), None);
        // 整数边界：Python int() 比 Rust 解析宽（Unicode 数字/下划线/空白/正号），
        // 双侧显式收窄为 ASCII 纯数字——这些输入必须两侧同拒（向量另有跨语言版）。
        assert_eq!(classify_error_code("http:+401"), None);
        assert_eq!(classify_error_code("http: 401"), None);
        assert_eq!(classify_error_code("http:٤٠١"), None, "阿拉伯-印度数字不是 ASCII");
        // JSON-RPC 保留带恰为 −32768..−32000（−32799 起是协议外）。
        assert_eq!(classify_error_code("jsonrpc:-32768"), Some(ErrorClass::Transport));
        assert_eq!(classify_error_code("jsonrpc:-32770"), None);
    }

    #[test]
    fn ws_chars_is_the_full_unicode_whitespace_set() {
        // 独立于常量本身构造全集（Python 侧 test_ws_chars_is_the_full_unicode_
        // whitespace_set 的镜像）——漏字符（如 U+2003）或多字符都会在这里炸，
        // 不依赖任何向量是否恰好覆盖该字符。
        let mut expected = String::new();
        for c in (0x09..=0x0d)
            .chain(std::iter::once(0x20))
            .chain([0x85, 0xa0, 0x1680])
            .chain(0x2000..=0x200a)
            .chain([0x2028, 0x2029, 0x202f, 0x205f, 0x3000])
        {
            expected.push(char::from_u32(c).unwrap());
        }
        let mut got: Vec<char> = WS_CHARS.chars().collect();
        got.sort_unstable();
        let mut want: Vec<char> = expected.chars().collect();
        want.sort_unstable();
        assert_eq!(got, want);
        assert_eq!(WS_CHARS.chars().count(), 25);
    }

    // ── scrub ──

    #[test]
    fn scrub_hits_every_pattern_and_spares_lookalikes() {
        // 每个模式 ≥1 正例（替换为标记）+ ≥1 负例（原样不动）——spec §10-1 的库内版，
        // vectors.json 里有跨语言版。
        let cases: &[(&str, &str, bool)] = &[
            ("token=sk-abcdefghij0123456789 done", "token=[…] done", true),
            ("short sk-abc nope", "short sk-abc nope", false),
            ("ghp_abcdefghijklmnopqrstuvwxyz1234567890", "[…]", true),
            ("ghp_tooshort", "ghp_tooshort", false),
            ("github_pat_11ABCDEFGHabcdefgh0123456789_", "[…]", true),
            ("AKIAIOSFODNN7EXAMPLE", "[…]", true),
            ("AKIAIOSFODNN7EXAMPL", "AKIAIOSFODNN7EXAMPL", false),
            ("xoxb-1234567890abc-abcdef", "[…]", true),
            ("Bearer abcdefghij1234567890ABCD", "[…]", true),
            // (?i) 前缀必须覆盖小写 scheme
            ("bearer abcdefghij1234567890ABCD", "[…]", true),
            ("bearer short", "bearer short", false),
            (
                "jwt eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkw.esInR5cCI6IkpXVCJ9",
                "jwt […]",
                true,
            ),
            ("no jwt here.a.b", "no jwt here.a.b", false),
            (
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----",
                "[…]",
                true,
            ),
            ("-----BEGIN PUBLIC KEY-----", "-----BEGIN PUBLIC KEY-----", false),
        ];
        for (input, expected_text, expected_scrubbed) in cases {
            let outcome = scrub_text(input);
            assert_eq!(outcome.text, *expected_text, "输入 {input:?}");
            assert_eq!(outcome.scrubbed, *expected_scrubbed, "输入 {input:?}");
        }
        // 多处命中一次全换；输出幂等（再跑一遍不变）。
        let two_keys = "a sk-abcdefghij0123456789 b sk-zyxwvutsrqponmlkjihg c";
        assert_eq!(scrub_text(two_keys).text, "a […] b […] c");
        let once = scrub_text(two_keys);
        assert_eq!(scrub_text(&once.text).text, once.text);
    }

    // ── 摘录 ──

    #[test]
    fn excerpt_trims_only_shared_whitespace_set() {
        // Python str.strip() 会额外裁 \x1c-\x1f，Rust 不会——共享集两侧一致（规则 3）。
        let padded = "\u{3000}\t\n 帮我修登录页 \r\u{2028}";
        let out = make_excerpt(padded, ExcerptRole::UserFirst).unwrap();
        assert_eq!(out.text, "帮我修登录页");
        assert_eq!(out.provenance, ExcerptProvenance::Verbatim);
        // \x1c 不在共享集内：必须保留（两侧同语义的证据位）。
        let file_sep = "\x1c内容\x1c";
        assert_eq!(make_excerpt(file_sep, ExcerptRole::UserTurn).unwrap().text, "\x1c内容\x1c");
    }

    #[test]
    fn excerpt_none_when_only_whitespace() {
        assert!(make_excerpt("  \t\r\n ", ExcerptRole::UserTurn).is_none());
        assert!(make_excerpt("", ExcerptRole::UserFirst).is_none());
    }

    #[test]
    fn excerpt_truncates_by_code_point_not_byte() {
        // 201 个 CJK 字符（每字符 3 字节）按 user_first 200 截：按字节截会在 600 字节处劈字。
        let cjk: String = "锚".repeat(201);
        let out = make_excerpt(&cjk, ExcerptRole::UserFirst).unwrap();
        assert_eq!(out.text.chars().count(), 200);
        assert_eq!(out.text, "锚".repeat(200));
        assert_eq!(out.provenance, ExcerptProvenance::Truncated);
        // emoji（代理对）按 1 字符计，不劈半：
        let emoji: String = "😀".repeat(121);
        let out = make_excerpt(&emoji, ExcerptRole::UserTurn).unwrap();
        assert_eq!(out.text.chars().count(), 120);
        assert!(out.text.chars().all(|c| c == '😀'), "不能产出劈开的代理对");
        assert_eq!(out.provenance, ExcerptProvenance::Truncated);
    }

    #[test]
    fn excerpt_scrub_wins_over_truncate_and_runs_before_it() {
        // 200+ 字符且含凭据：先 scrub（标记 […] 计 3 字符）再按 200 截，provenance 报 scrubbed（规则 1/6）。
        let text = format!("key sk-abcdefghij0123456789 then {}", "尾部".repeat(120));
        let out = make_excerpt(&text, ExcerptRole::UserFirst).unwrap();
        assert_eq!(out.provenance, ExcerptProvenance::Scrubbed);
        assert!(out.text.contains("[…]"));
        assert!(out.text.chars().count() <= 200);
        // 凭据被劈断的反例：若先截断再 scrub，sk- 键可能只剩前缀漏检——顺序由本测试钉住。
        assert!(!out.text.contains("sk-abcdefghij"));
    }

    #[test]
    fn excerpt_truncation_never_splits_the_scrub_marker() {
        // scrubbed 文本 202 字符，截断点落在标记的 '[' 上：残尾必须去掉，输出以
        // 空格收尾而不是裸 '['（两侧同规则；标记整段保留的边界另由向量钉）。
        let text = format!("{} sk-abcdefghij0123456789", "y".repeat(198));
        let out = make_excerpt(&text, ExcerptRole::UserFirst).unwrap();
        assert_eq!(out.text, format!("{} ", "y".repeat(198)));
        assert_eq!(out.provenance, ExcerptProvenance::Scrubbed);
        // 截断点落在 '…' 上：残尾 '[…' 同样去掉。
        let text = format!("{} sk-abcdefghij0123456789", "y".repeat(197));
        let out = make_excerpt(&text, ExcerptRole::UserFirst).unwrap();
        assert_eq!(out.text, format!("{} ", "y".repeat(197)));
        // 恰好 200（含完整标记）：不截断，标记整段保留。
        let text = format!("{} sk-abcdefghij0123456789", "y".repeat(196));
        let out = make_excerpt(&text, ExcerptRole::UserFirst).unwrap();
        assert_eq!(out.text, format!("{} […]", "y".repeat(196)));
    }

    #[test]
    fn excerpt_deterministic_byte_equal_across_runs() {
        let text = "  修复 SQLite 迁移的 fencepost，凭据 sk-abcdefghij0123456789 别提交 ";
        let a = make_excerpt(text, ExcerptRole::UserTurn).unwrap();
        let b = make_excerpt(text, ExcerptRole::UserTurn).unwrap();
        assert_eq!(a.text.as_bytes(), b.text.as_bytes());
        assert_eq!(a, b);
    }

    // ── 共享向量锁步（Python 侧 tests/test_enrichment_lockstep.py 断言同一份文件） ──

    #[test]
    fn shared_vectors_fixture_all_cases_pass() {
        let raw = include_str!("../../../../fixtures/enrichment/vectors.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("vectors.json 必须可解析");
        let cases = doc["cases"].as_array().expect("cases 数组");
        assert!(cases.len() >= 30, "向量覆盖不足：{}", cases.len());
        let mut seen_ids = std::collections::BTreeSet::new();
        for case in cases {
            let id = case["id"].as_str().expect("id").to_string();
            assert!(seen_ids.insert(id.clone()), "向量 id 重复：{id}");
            let kind = case["kind"].as_str().expect("kind");
            match kind {
                "classify" => {
                    let input = case["input"].as_str().expect("input");
                    let expected = case
                        .get("expected_class")
                        .and_then(|v| v.as_str())
                        .map(|wire| {
                            ErrorClass::from_wire(wire)
                                .unwrap_or_else(|| panic!("向量 {id} 的 expected_class 不在闭集：{wire}"))
                        });
                    assert_eq!(classify_error_code(input), expected, "向量 {id}");
                }
                "scrub" => {
                    let input = case["input"].as_str().expect("input");
                    let outcome = scrub_text(input);
                    assert_eq!(
                        outcome.text,
                        case["expected_text"].as_str().expect("expected_text"),
                        "向量 {id}"
                    );
                    assert_eq!(
                        outcome.scrubbed,
                        case["expected_scrubbed"].as_bool().expect("expected_scrubbed"),
                        "向量 {id}"
                    );
                }
                "excerpt" => {
                    let input = case["input"].as_str().expect("input");
                    let role = ExcerptRole::from_wire(case["role"].as_str().expect("role"))
                        .unwrap_or_else(|| panic!("向量 {id} 的 role 非法"));
                    let outcome = make_excerpt(input, role);
                    let expect_none = case.get("expected").map(|v| v.is_null()).unwrap_or(false);
                    if expect_none {
                        assert!(outcome.is_none(), "向量 {id} 应为 None");
                    } else {
                        let out = outcome.unwrap_or_else(|| panic!("向量 {id} 不应为 None"));
                        assert_eq!(
                            out.text,
                            case["expected_text"].as_str().expect("expected_text"),
                            "向量 {id}"
                        );
                        assert_eq!(
                            out.provenance.as_str(),
                            case["expected_provenance"].as_str().expect("expected_provenance"),
                            "向量 {id}"
                        );
                    }
                }
                other => panic!("向量 {id} 的 kind 非法：{other}"),
            }
        }
    }

    #[test]
    fn shared_vectors_cover_every_scrub_pattern_by_positive_case() {
        // 每条 scrub 正则必须在向量里保留一个 'scrub-<name>-' 前缀且 expected_scrubbed
        // 为 true 的**正例**——负例同前缀不计数（否则删掉正例守卫照样绿）。
        let raw = include_str!("../../../../fixtures/enrichment/vectors.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("vectors.json");
        let positive_ids: Vec<String> = doc["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .filter(|c| c["kind"].as_str() == Some("scrub"))
            .filter(|c| c["expected_scrubbed"].as_bool() == Some(true))
            .filter_map(|c| c["id"].as_str().map(str::to_string))
            .collect();
        for prefix in [
            "scrub-openai-",
            "scrub-github-",
            "scrub-github-fine-",
            "scrub-aws-",
            "scrub-slack-",
            "scrub-bearer-",
            "scrub-jwt-",
            "scrub-pem-",
        ] {
            assert!(
                positive_ids.iter().any(|id| id.starts_with(prefix)),
                "vectors.json 缺少前缀 {prefix} 的正例"
            );
        }
    }
}
