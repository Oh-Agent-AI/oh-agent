//! `overlap`：字面相似度筛选（PRODUCT §5.4）。
//!
//! 这一块是**筛选器，不是判决**。语义竞争完全可能发生在用词毫无交集的两个
//! skill 之间，Jaccard 查不到；反过来，两个都在讲「文件」的 skill 也未必真
//! 争抢。所以输出里必须带 `[Lexical，待判定]`，并给出下一步怎么拿到真判断。
//!
//! 判断为什么不写进扫描器：它不是正则问题（同 SKILL.md 的 2.3）。
//! 脚本负责测量，模型负责判断 —— 这条分界是整个设计的支点。
//!
//! 与 `scripts/scan.py` 的 `overlap_pairs` / `render_overlap` 逐字节对齐，
//! 由 `tests/test_render.py` 的双实现比对钉住。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::domain::util::{b, s};

pub struct OverlapOpts {
    pub min: f64,
    pub top: Option<usize>,
}

// 停用词只挡真正没有区分度的功能词。**宁可少挡**：挡多了会把两个本来
// 就该被看见的 skill 的共享词全滤掉，只剩一个孤零零的 Jaccard 数字。
const STOP_EN: &[&str] = &[
    "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "by",
    "with", "from", "this", "that", "these", "those", "is", "are", "be", "was",
    "were", "it", "its", "you", "your", "as", "if", "when", "then", "than",
    "can", "will", "should", "would", "may", "must", "not", "no", "any", "all",
    "use", "uses", "used", "using", "skill", "skills", "user", "users", "via",
];
const STOP_ZH: &str = "的了和与或在是为对把被就都也还很更最之及其等这那有个上下前后中";

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// 按标点切成若干串中文字符。bigram 与展示短语都基于它。
///
/// 二元组**不跨串**：跨过标点把「导出。图片」拼成一个词是凭空造词。
///
/// **不在这里删停用字。**删了之后「在线文档」会变成「线文档」，展示时打出来
/// 的是一个原文里根本没有的说法 —— 而这条输出的全部用处就是让人自己判断
/// 两个 skill 是不是在讲同一件事。噪声改在 bigram 那层挡。
fn cjk_runs(text: &str) -> Vec<Vec<char>> {
    let mut runs = Vec::new();
    let mut cur: Vec<char> = Vec::new();
    for c in text.chars() {
        if is_cjk(c) {
            cur.push(c);
        } else if !cur.is_empty() {
            runs.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        runs.push(cur);
    }
    runs
}

/// 英文按词、中文按字二元组。
///
/// 中文不做分词：**引入词典就引入了一个必须随语料更新的依赖**，而这里只需要
/// 「有没有共同的说法」这个粗粒度信号。二元组够用，且两个实现能逐字节对齐 ——
/// 分词器做不到这一点。
fn tokenize(text: &str) -> BTreeSet<String> {
    let mut tokens = BTreeSet::new();
    // Python: [A-Za-z][A-Za-z0-9_-]*
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '-')
            {
                i += 1;
            }
            let w: String = chars[start..i].iter().collect::<String>().to_lowercase();
            if w.chars().count() > 1 && !STOP_EN.contains(&w.as_str()) {
                tokens.insert(w);
            }
        } else {
            i += 1;
        }
    }
    for run in cjk_runs(text) {
        for w in run.windows(2) {
            // 只丢弃**两个字都是虚词**的组合；「在线」这种一实一虚的保留
            if STOP_ZH.contains(w[0]) && STOP_ZH.contains(w[1]) {
                continue;
            }
            tokens.insert(w.iter().collect());
        }
    }
    tokens
}

/// 把交集整理成**能读的**共享词。
///
/// 二元组适合算相似度，不适合给人看：直接打印会得到 `云文 · 件夹 · 件管`
/// 这样的半个词，读者无法据此判断这两个 skill 是不是真的在讲同一件事 ——
/// 而那正是这条输出唯一的用处。
///
/// 所以展示时把连续命中的二元组接回长串，并且**要求接出来的串在两边的原文里
/// 都真的出现过**。否则「云文」+「文档」能接出一个谁都没写过的词，
/// 那就是凭空造证据。
fn shared_display(
    a_text: &str,
    b_text: &str,
    inter: &BTreeSet<String>,
    df: &BTreeMap<String, usize>,
) -> Vec<String> {
    let mut out: BTreeSet<String> = inter
        .iter()
        .filter(|t| t.is_ascii())
        .cloned()
        .collect();

    let b_runs: Vec<String> = cjk_runs(b_text)
        .into_iter()
        .map(|r| r.into_iter().collect())
        .collect();
    for run in cjk_runs(a_text) {
        let bigram = |k: usize| -> String { run[k..k + 2].iter().collect() };
        let mut i = 0usize;
        while run.len() >= 2 && i < run.len() - 1 {
            if inter.contains(&bigram(i)) {
                let mut j = i + 1;
                while j < run.len() - 1 && inter.contains(&bigram(j)) {
                    j += 1;
                }
                let phrase: String = run[i..=j].iter().collect();
                if b_runs.iter().any(|r| r.contains(&phrase)) {
                    out.insert(phrase);
                }
                i = j + 1;
            } else {
                i += 1;
            }
        }
    }

    // 罕见的排前面。短语的 df 取组成它的二元组里最小的那个：
    // 一个短语不可能比它最罕见的组成部分更常见。
    let rank = |t: &String| -> (usize, isize, String) {
        let d = if t.is_ascii() {
            *df.get(t).unwrap_or(&0)
        } else {
            let cs: Vec<char> = t.chars().collect();
            cs.windows(2)
                .map(|w| *df.get(&w.iter().collect::<String>()).unwrap_or(&0))
                .min()
                .unwrap_or(0)
        };
        (d, -(t.chars().count() as isize), t.clone())
    };
    let mut v: Vec<String> = out.into_iter().collect();
    v.sort_by_key(rank);
    v
}

/// 两两比较描述的字面相似度。
///
/// 只比**同一 conflict_domain 内、且真的进了上下文**的那批：不同执行环境是互不
/// 相干的运行时，未加载的副本压根不在选择器里 —— 把它们算进来会报出一堆
/// 用户无法验证也无需处理的「重叠」。这与预算、冲突用的是同一条口径。
pub fn overlap_pairs(out: &Value, o: &OverlapOpts) -> Value {
    struct Item {
        name: String,
        domain: String,
        text: String,
        tokens: BTreeSet<String>,
    }

    let empty = Vec::new();
    let skills = out.get("skills").and_then(|v| v.as_array()).unwrap_or(&empty);

    let mut seen: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut items: Vec<Item> = Vec::new();
    for sk in skills {
        if !b(sk, "loaded") {
            continue;
        }
        let ns = sk.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
        let key = (s(sk, "conflict_domain"), ns.to_string(), s(sk, "name"));
        if !seen.insert(key) {
            continue;
        }
        let name = s(sk, "name");
        let label = if ns.is_empty() { name.clone() } else { format!("{}:{}", ns, name) };
        let text = format!("{} {}", name, s(sk, "description"));
        items.push(Item {
            name: label,
            domain: s(sk, "conflict_domain"),
            tokens: tokenize(&text),
            text,
        });
    }

    // 罕见词优先展示：两个 skill 都提到「文件」说明不了什么，
    // 都提到「webhook」才是线索。df 在**本次比较范围内**统计。
    let mut df: BTreeMap<String, usize> = BTreeMap::new();
    for it in &items {
        for t in &it.tokens {
            *df.entry(t.clone()).or_insert(0) += 1;
        }
    }

    items.sort_by(|x, y| x.name.cmp(&y.name));
    let mut pairs: Vec<Value> = Vec::new();
    for i in 0..items.len() {
        for j in (i + 1)..items.len() {
            let (a, bb) = (&items[i], &items[j]);
            if a.domain != bb.domain {
                continue;
            }
            let inter: BTreeSet<String> =
                a.tokens.intersection(&bb.tokens).cloned().collect();
            let union = a.tokens.len() + bb.tokens.len() - inter.len();
            if union == 0 {
                continue;
            }
            let jac = inter.len() as f64 / union as f64;
            if jac < o.min {
                continue;
            }
            let shared = shared_display(&a.text, &bb.text, &inter, &df);
            pairs.push(json!({
                "a": a.name, "b": bb.name, "domain": a.domain,
                "jaccard": crate::util::pyround(jac, 2),
                "shared": shared.iter().take(6).collect::<Vec<_>>(),
                "shared_total": inter.len(),
            }));
        }
    }
    pairs.sort_by(|x, y| {
        let jx = x["jaccard"].as_f64().unwrap_or(0.0);
        let jy = y["jaccard"].as_f64().unwrap_or(0.0);
        jy.partial_cmp(&jx)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| x["a"].as_str().cmp(&y["a"].as_str()))
            .then_with(|| x["b"].as_str().cmp(&y["b"].as_str()))
    });
    if let Some(n) = o.top {
        pairs.truncate(n);
    }
    Value::Array(pairs)
}

pub fn render_overlap(out: &Value, o: &OverlapOpts) -> String {
    let empty = Vec::new();
    let scope = out
        .get("skills")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty)
        .iter()
        .filter(|x| b(x, "loaded"))
        .count();
    let pairs_v = overlap_pairs(out, o);
    let pairs = pairs_v.as_array().cloned().unwrap_or_default();

    let mut t = String::new();
    t.push_str("Overlap candidates                          [Lexical, review required]\n");
    t.push('\n');
    if pairs.is_empty() {
        t.push_str(&format!(
            "  No pair among {} loaded skills has lexical similarity >= {:.2}.\n",
            scope, o.min
        ));
        t.push('\n');
        t.push_str("  This does not mean there is no semantic competition. Skills with\n");
        t.push_str("  completely different wording can still compete; see the next step below.\n");
    } else {
        for p in &pairs {
            t.push_str(&format!("  {}  ↔  {}\n", s(p, "a"), s(p, "b")));
            let shared: Vec<String> = p["shared"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let total = p["shared_total"].as_u64().unwrap_or(0) as usize;
            let body = if shared.is_empty() {
                "(no complete shared phrase; bigram similarity only)".to_string()
            } else {
                shared.join(" · ")
            };
            // 展示的是接回长串后的说法，条数与 Jaccard 的分子不是一回事，
            // 所以后缀写「字面交集共 N 项」而不是「等 N 个」—— 后者会被
            // 读成「共享词还有 N-6 个没列出来」。
            let suffix = if total <= shared.len() {
                String::new()
            } else {
                format!("   ({} lexical intersections total)", total)
            };
            t.push_str(&format!("    Shared terms  {}{}\n", body, suffix));
            t.push_str(&format!(
                "    Jaccard       {:.2}\n",
                p["jaccard"].as_f64().unwrap_or(0.0)
            ));
            t.push('\n');
        }
        t.push_str("  This is a lexical filter, not a verdict. Semantic competition can\n");
        t.push_str("  occur between skills with completely different wording.\n");
    }
    t.push('\n');
    t.push_str("  To obtain a decision you can act on:\n");
    t.push_str("    · Run /agent-vitals in Claude Code (free; no API key required).\n");
    t.push_str("      Let the model judge the description fields; this is not a regex problem.\n");
    t.push_str("    · overlap --judge (external model) is not implemented yet; see PRODUCT §5.4.\n");
    t.push('\n');
    t.push_str(&format!(
        "  Scope: {} loaded skills, grouped by harness; threshold --min {:.2}\n",
        scope, o.min
    ));
    t
}
