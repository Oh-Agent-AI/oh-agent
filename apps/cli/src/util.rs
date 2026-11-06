//! 基础工具。每个函数都对应 scan.py 里的一个同名函数，行为必须逐位一致。

use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// 单一真相源在 domain（`agent_vitals_domain::util::norm`）—— v0.8 Phase E7.6
/// 起 `agent-vitals-harnesses` 的执行环境适配器也要用它，不能各写一份。
pub use agent_vitals_domain::util::norm;

/// 读文件，非 UTF-8 字节替换为 U+FFFD，并做 universal newlines 转换。
///
/// **移植清单第 2 条，最危险的一条。**Python 的 `read_text(errors="replace")`
/// 永不失败；直译成 `fs::read_to_string` 遇到非 UTF-8 会 `Err`，于是编码异常的
/// skill 被**跳过而非扫描**。在安全工具里这是静默漏报 —— 它在正常语料上永远
/// 不显形。
///
/// **移植清单第 8 条：换行归一。**`Path.read_text()` 走的是文本模式，Python
/// 默认开启 universal newlines，把 `\r\n` 和单独的 `\r` 都转成 `\n`。
/// `fs::read` 是原样字节，不做这件事。差异会传导到三个数：
/// `content_hash`（字节不同）、`tier1_tokens`（字符数不同）、`body_lines`。
/// 它只在 CRLF 文件上显形 —— 也就是 Windows 上写的 skill。
pub fn read_lossy(p: &Path) -> Option<String> {
    // I/O 在这里；转换逻辑（宽松 UTF-8 + universal newlines）下沉到 domain——
    // v0.8 Phase E7.6 起 agent-vitals-harnesses 读 ~/.claude.json 也要同一份转换，
    // 见 agent_vitals_domain::util::bytes_to_lossy_normalized 的文档注释。
    let bytes = std::fs::read(p).ok()?;
    Some(agent_vitals_domain::util::bytes_to_lossy_normalized(&bytes))
}

/// 复刻 Python 的 `round(x, n)`（银行家舍入）。实现在 core —— `budget.rs` 的
/// reason 格式化与这个 repo 其他舍入共用一份（详见 core 侧文档注释）。
pub use agent_vitals_domain::util::pyround;

#[cfg(test)]
mod tests {
    use super::*;
    // est_tokens/split_lines 单一真相源都在 domain（`agent_vitals_domain::
    // util`）。v0.8 Phase E7.5 起 `discovery.rs`/`security_rules::check()`
    // 等非测试调用点全部迁进了库 crate（`agent-vitals-runtime`/
    // `agent-vitals-domain`），apps/cli 侧已无非测试调用点，这里只留测试用
    // 的 import（同款测试见 crates/agent-vitals-domain/src/domain/util.rs）。
    use agent_vitals_domain::util::{est_tokens, split_lines};

    // 期望值来自 tests/test_characterization.py，逐条对齐。比例是 DeepSeek 官方
    // 换算（CJK×0.6、其余×0.3，2026-08-21 从旧比例换过来——理由见
    // crates/agent-vitals-domain/src/domain/util.rs 的文档注释）。

    #[test]
    fn est_tokens_ascii_truncates() {
        assert_eq!(est_tokens(""), 0);
        assert_eq!(est_tokens("hello"), 1); // 5*0.3 = 1.5 → 1
        assert_eq!(est_tokens("xxxx"), 1); // 4*0.3 = 1.2 → 1
        assert_eq!(est_tokens("xxx"), 0); // 3*0.3 = 0.9 → 0，向下截断，不是四舍五入
        assert_eq!(est_tokens(&"x".repeat(400)), 120); // 400*0.3 = 120
    }

    #[test]
    fn est_tokens_cjk() {
        assert_eq!(est_tokens("中文"), 1); // 2*0.6 = 1.2 → 1
        assert_eq!(est_tokens("中中中"), 1); // 3*0.6 = 1.8 → 1
        assert_eq!(est_tokens(&"中".repeat(150)), 90); // 150*0.6 = 90
        assert_eq!(est_tokens("中文，English"), 3); // U+FF0C 不算 CJK；2*0.6+8*0.3=3.6→3
    }

    #[test]
    fn est_tokens_cjk_boundaries() {
        assert_eq!(est_tokens(&"一".repeat(3)), 1); // U+4E00 下界，含；3*0.6=1.8→1
        assert_eq!(est_tokens(&"鿿".repeat(3)), 1); // U+9FFF 上界，含
        assert_eq!(est_tokens(&"䷿".repeat(3)), 0); // U+4DFF 界外，3*0.3=0.9→0
        assert_eq!(est_tokens(&"ꀀ".repeat(3)), 0); // U+A000 界外
        assert_eq!(est_tokens(&"㐀".repeat(3)), 0); // 扩展 A 区
        assert_eq!(est_tokens(&"\u{20000}".repeat(3)), 0); // 扩展 B 区
    }

    #[test]
    fn est_tokens_is_total() {
        for s in ["😀😀😀", "\0\u{1}\u{2}", "🇨🇳🇺🇸", "\n\r\t"] {
            assert!(est_tokens(s) >= 0);
        }
    }

    #[test]
    fn split_lines_matches_python() {
        assert_eq!(split_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\r\nb\r"), vec!["a", "b"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
    }

    // ── 属性测试（ENGINEERING §4.4 第 3 层）──────────────
    //
    // §4.4 限定属性测试**只做两件事**，其一即「est_tokens 对任意 Unicode
    // 输入不 panic 且非负」。这不是形式主义：扫描器会读到任何人写的任何
    // 文件，而 §4.5 的硬规矩是「单个 skill 的失败不得影响其余」——
    // 一次 panic 就把整次扫描带走了。

    proptest::proptest! {
        #[test]
        fn est_tokens_is_total_over_arbitrary_unicode(s in ".*") {
            proptest::prop_assert!(est_tokens(&s) >= 0);
        }

        #[test]
        fn est_tokens_never_shrinks_under_concatenation(s in ".{1,200}") {
            // int() 截断使它不严格可加，但必须单调不减
            proptest::prop_assert!(est_tokens(&(s.clone() + &s)) >= est_tokens(&s));
        }

        #[test]
        fn split_lines_loses_nothing_but_terminators(s in ".*") {
            let joined: String = split_lines(&s).concat();
            let stripped: String = s.chars().filter(|c| *c != '\n' && *c != '\r').collect();
            proptest::prop_assert_eq!(joined, stripped);
        }

        #[test]
        fn pyround_output_is_finite(x in -1e9f64..1e9f64, n in 0usize..6) {
            proptest::prop_assert!(pyround(x, n).is_finite());
        }
    }

    #[test]
    fn pyround_uses_banker_rounding() {
        assert_eq!(pyround(0.25, 1), 0.2); // 半分点向偶数靠
        assert_eq!(pyround(0.35, 1), 0.3); // 0.35 的二进制略小于 0.35
        assert_eq!(pyround(9.66, 1), 9.7);
    }
}

// ── 终端折行（doctor / explain 共用）─────────────────────
//
// **按显示列宽折，不按字符数。**表格那边（skills::render::pad）刻意按字符数对齐，
// 因为两个实现的格式化原语都按字符计，字符计才能让输出逐字节一致。但整段
// 中文说明按字符折的话，一行 75 个汉字会铺开 150 列 —— caveat 是最需要被
// 读到的那几行，不能糊成一片。
//
// 所以这里改用显示列宽（CJK 记 2 列），区间写死：两个实现用同一张表，
// 一致性照样成立，只是口径换了一个。

pub const DOCTOR_WIDTH: usize = 88;

const WIDE_RANGES: [(u32, u32); 11] = [
    (0x1100, 0x115F), (0x2E80, 0x303E), (0x3041, 0x33FF), (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF), (0xA000, 0xA4CF), (0xAC00, 0xD7A3), (0xF900, 0xFAFF),
    (0xFE30, 0xFE4F), (0xFF00, 0xFF60), (0xFFE0, 0xFFE6),
];

/// 不得出现在行首的字符（中日文排版的「禁则处理」）
/// **必须与 scan.py 的 `_NO_LINE_START` 逐字一致**，否则同一段文字在两个实现里
/// 会在不同的位置换行，差分测试直接红。
const NO_LINE_START: [char; 17] = ['」', '』', '）', '〉', '》', '”', '’', '、',
                                   '。', '，', '！', '？', '：', '；', '·', '…', '—'];

fn is_wide(c: char) -> bool {
    let o = c as u32;
    WIDE_RANGES.iter().any(|&(lo, hi)| o >= lo && o <= hi)
}

/// 显示列宽：CJK 与全角记 2，其余记 1。
pub fn cols(text: &str) -> usize {
    text.chars().map(|c| if is_wide(c) { 2 } else { 1 }).sum()
}

/// 按列宽折行；续行缩进到 `cont`（None 表示与 prefix 等宽）。
///
/// CJK 之间没有空格，按空白切根本折不动 —— 一整段中文会原样吐出一行。
/// 所以这里自己切：英文按词切（不劈开单词），CJK 逐字切。
pub fn wrap(text: &str, prefix: &str, cont: Option<&str>) -> Vec<String> {
    let room = (DOCTOR_WIDTH as i64 - cols(prefix) as i64).max(20) as usize;

    // 切成「可换行的最小单位」：一个 CJK 字，或一段非空白的 ASCII 词
    let mut units: Vec<String> = Vec::new();
    let mut buf = String::new();
    for c in text.chars() {
        if is_wide(c) || c == ' ' {
            if !buf.is_empty() {
                units.push(std::mem::take(&mut buf));
            }
            units.push(if c == ' ' { " ".to_string() } else { c.to_string() });
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        units.push(buf);
    }

    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for u in units {
        if u == " " && cur.is_empty() {
            continue; // 行首不留空格
        }
        // 禁则：闭引号、句读不能落在行首。宁可多出一两列，也不要让一行以
        // 「」时 开头 —— 那读起来像上一行被截断了。
        let no_start = u.chars().count() == 1
            && NO_LINE_START.contains(&u.chars().next().unwrap_or(' '));
        if !cur.is_empty() && cols(&cur) + cols(&u) > room && !no_start {
            lines.push(cur.trim_end().to_string());
            cur = if u == " " { String::new() } else { u };
        } else {
            cur.push_str(&u);
        }
    }
    if !cur.trim().is_empty() {
        lines.push(cur.trim_end().to_string());
    }

    let pad_cont = match cont {
        Some(c) => c.to_string(),
        None => " ".repeat(cols(prefix)),
    };
    if lines.is_empty() {
        return vec![prefix.trim_end().to_string()];
    }
    lines
        .iter()
        .enumerate()
        .map(|(i, ln)| format!("{}{}", if i == 0 { prefix } else { &pad_cont }, ln))
        .collect()
}

/// 报告内容的短哈希 —— 用来证明这份报告背后真的跑过一次扫描。
///
/// 对应 Python 的 `run_id`：`json.dumps(sort_keys=True, ensure_ascii=False,
/// separators=(",", ":"))` 再取 sha256 前 8 位。**不进 scan JSON**，只在渲染时算
/// —— 放进 schema 会让 11 份 golden 全部失效。
///
/// 关键差异点：serde_json 的 `preserve_order` 保插入序，不排序；Python 的
/// `sort_keys=True` 是递归字典序。所以这里先把对象键递归排序，再紧凑序列化，
/// 否则同一个报告在两个实现里算出不同的 8 位。
fn sorted_json(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(k, val)| (k.clone(), sorted_json(val)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted_json).collect()),
        other => other.clone(),
    }
}

pub fn run_id(report: &Value) -> String {
    let canonical = serde_json::to_string(&sorted_json(report)).unwrap_or_default();
    let digest = Sha256::digest(canonical.as_bytes());
    format!("{:x}", digest).chars().take(8).collect()
}

#[cfg(test)]
mod wrap_tests {
    use super::*;

    #[test]
    fn cjk_counts_two_columns() {
        assert_eq!(cols("中文"), 4);
        assert_eq!(cols("ab"), 2);
        assert_eq!(cols("中a"), 3);
    }

    #[test]
    fn lines_fit_the_width() {
        let text = "这是一段很长的中文说明，".repeat(12);
        for line in wrap(&text, "  ! ", None) {
            assert!(cols(&line) <= DOCTOR_WIDTH + 2, "{line}");
        }
    }

    #[test]
    fn english_words_are_not_split() {
        let text = "run agent-vitals overlap ".repeat(12);
        let joined: String = wrap(&text, "  → ", None)
            .iter()
            .map(|l| l.trim().to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!joined.contains("skill-vital s"));
        assert!(joined.contains("agent-vitals"));
    }

    #[test]
    fn closing_bracket_never_starts_a_line() {
        let text = format!("{}说「便宜了」时必须指明是哪个数降了。", "前面填充".repeat(20));
        for line in wrap(&text, "  ! ", None) {
            let first = line.trim_start().chars().next().unwrap_or(' ');
            assert!(!NO_LINE_START.contains(&first), "{line}");
        }
    }
}
