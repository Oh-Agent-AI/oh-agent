//! frontmatter 解析。不依赖 YAML 库 —— 与 scan.py 保持同一套（有限的）语义。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::domain::util::split_lines;

fn fm_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Python: re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
    // (?s) = DOTALL；^ 在未开 multi-line 时锚定文本起点，与 re.match 等价。
    RE.get_or_init(|| Regex::new(r"(?s)^---\s*\n(.*?)\n---\s*\n?").unwrap())
}

pub struct Frontmatter {
    pub map: HashMap<String, String>,
    pub raw: String,
    pub body: String,
}

impl Frontmatter {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.map.get(k).map(|s| s.as_str())
    }
}

/// 返回 (frontmatter 映射, frontmatter 原文, 正文)。
///
/// 一处必须逐字复刻的行为：闭合 `---` 之后的 `\s*\n?` 会把**紧跟的所有空行
/// 一起吃掉**，正文从首个非空行开始。`body_lines` 与 `tier2_core_tokens` 都
/// 由正文算出，这段正则写松或写紧，两个数都跟着偏。
pub fn parse_frontmatter(raw: &str) -> Frontmatter {
    let caps = match fm_re().captures(raw) {
        Some(c) => c,
        None => {
            return Frontmatter {
                map: HashMap::new(),
                raw: String::new(),
                body: raw.to_string(),
            }
        }
    };
    let whole = caps.get(0).unwrap();
    let fm_raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    let body = &raw[whole.end()..];

    let mut map: HashMap<String, String> = HashMap::new();
    let mut key: Option<String> = None;

    for line in split_lines(fm_raw) {
        // 缩进行并入上一个 key，用**一个空格**连接（不是换行）
        let starts_with_ws = line.chars().next().is_some_and(|c| c.is_whitespace());
        if starts_with_ws {
            if let Some(k) = key.as_ref() {
                if let Some(v) = map.get_mut(k) {
                    v.push(' ');
                    v.push_str(line.trim());
                }
                continue;
            }
            // 没有前一个 key 的缩进行直接丢弃（与 Python 一致：continue 只在
            // key 存在时执行，否则落到下面的冒号判断，而缩进行通常无冒号）
        }
        if let Some(idx) = line.find(':') {
            let k = line[..idx].trim().to_string();
            let v = line[idx + 1..]
                .trim()
                .trim_matches(|c| c == '\'' || c == '"')
                .to_string();
            map.insert(k.clone(), v);
            key = Some(k);
        }
    }

    Frontmatter {
        map,
        raw: fm_raw.to_string(),
        body: body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期望值来自 tests/test_characterization.py::TestParseFrontmatter

    #[test]
    fn no_frontmatter_is_all_body() {
        let f = parse_frontmatter("just a body\n");
        assert!(f.map.is_empty());
        assert_eq!(f.raw, "");
        assert_eq!(f.body, "just a body\n");
    }

    #[test]
    fn blank_line_after_frontmatter_is_consumed() {
        let f = parse_frontmatter("---\nname: a\ndescription: d\n---\n\nbody\n");
        assert_eq!(f.get("name"), Some("a"));
        assert_eq!(f.get("description"), Some("d"));
        assert_eq!(f.raw, "name: a\ndescription: d");
        assert_eq!(f.body, "body\n", "闭合 --- 之后的空行必须被吃掉");
    }

    #[test]
    fn many_blank_lines_all_consumed() {
        let f = parse_frontmatter("---\nname: a\n---\n\n\n\nbody\n");
        assert_eq!(f.body, "body\n");
    }

    #[test]
    fn quotes_stripped_both_kinds() {
        let f = parse_frontmatter("---\nname: 'a'\ndescription: \"d\"\n---\n");
        assert_eq!(f.get("name"), Some("a"));
        assert_eq!(f.get("description"), Some("d"));
    }

    #[test]
    fn value_keeps_everything_after_first_colon() {
        let f = parse_frontmatter("---\nk: value: with: colons\n---\n");
        assert_eq!(f.get("k"), Some("value: with: colons"));
    }

    #[test]
    fn quoted_value_with_inner_colon() {
        let f = parse_frontmatter("---\ndescription: 'Quoted: with a colon inside'\n---\n");
        assert_eq!(f.get("description"), Some("Quoted: with a colon inside"));
    }

    #[test]
    fn continuation_joins_with_single_space() {
        let f = parse_frontmatter("---\ndescription: first\n  second line\n    third\n---\n");
        assert_eq!(f.get("description"), Some("first second line third"));
    }

    #[test]
    fn line_without_colon_ignored() {
        let f = parse_frontmatter("---\nname: a\nbare-line\n---\n");
        assert_eq!(f.map.len(), 1);
    }

    #[test]
    fn crlf_reaches_parser_already_normalized() {
        // read_lossy() 已做 universal newlines 转换（移植清单第 8 条），
        // 所以解析器实际拿到的是 \n。这条钉住「解析器不必自己处理 \r」。
        let f = parse_frontmatter("---\nname: a\ndescription: d\n---\n\nbody\n");
        assert_eq!(f.get("name"), Some("a"));
        assert_eq!(f.get("description"), Some("d"));
        assert_eq!(f.body, "body\n");
    }

    #[test]
    fn unclosed_frontmatter_is_all_body() {
        let f = parse_frontmatter("---\nname: a\n\nbody\n");
        assert!(f.map.is_empty());
        assert_eq!(f.raw, "");
        assert!(f.body.starts_with("---"));
    }

    #[test]
    fn duplicate_key_last_wins() {
        let f = parse_frontmatter("---\nname: a\nname: b\n---\n");
        assert_eq!(f.get("name"), Some("b"));
    }
}
