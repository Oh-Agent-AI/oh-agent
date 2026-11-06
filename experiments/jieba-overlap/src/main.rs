//! jieba 分词 vs 字符 bigram：三种配方在同一份真实语料上的对比。
//!
//! 见 docs/ENGINEERING.md ADR-002。这个实验存在的意义不是「证明结论对」，
//! 而是让结论**可被推翻** —— 换一份中文占比更高的语料再跑一次即可。

use jieba_rs::Jieba;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// 与 scan.py 的 `_STOP_EN` 一致。挡的是真正没有区分度的功能词。
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

fn cjk_ratio(t: &str) -> f64 {
    let n = t.chars().count();
    if n == 0 { return 0.0; }
    t.chars().filter(|c| is_cjk(*c)).count() as f64 / n as f64
}

/// 当前实现（scan.py / overlap.rs）口径的**近似复刻**，用于并排对比。
///
/// **不是生产实现本身** —— 那个在主 crate 里且未导出。两者在同一份语料上
/// ≥0.25 的对数是 13 vs 11，差异来自分隔符与名字拼接的细节。要权威数字请跑
/// `agent-vitals overlap --json`；这里要的是「换个分词器会怎样」的同条件对比。
///
/// **停用字不在分词前删。**删了之后「在线文档」会变成「线文档」；改为只丢弃
/// 两个字都是虚词的 bigram。
fn tokenize_bigram(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let lower = text.to_lowercase();
    for w in lower.split(|c: char| !c.is_alphanumeric() && !is_cjk(c)) {
        if w.is_empty() || w.chars().any(is_cjk) { continue; }
        if w.chars().count() > 1 && !STOP_EN.contains(&w) {
            out.insert(w.to_string());
        }
    }
    // CJK 连续段 → 相邻二元组
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut BTreeSet<String>| {
        let cs: Vec<char> = run.chars().collect();
        for pair in cs.windows(2) {
            if STOP_ZH.contains(pair[0]) && STOP_ZH.contains(pair[1]) { continue; }
            out.insert(pair.iter().collect());
        }
        run.clear();
    };
    for c in lower.chars() {
        if is_cjk(c) { run.push(c); } else if !run.is_empty() { flush(&mut run, &mut out); }
    }
    if !run.is_empty() { flush(&mut run, &mut out); }
    out
}

fn tokenize_jieba(j: &Jieba, text: &str, tags: &BTreeSet<&str>) -> BTreeSet<String> {
    j.tag(text, true)
        .into_iter()
        .filter(|t| tags.contains(t.tag))
        .map(|t| t.word.to_lowercase())
        .filter(|w| w.chars().count() > 1 && !STOP_EN.contains(&w.as_str()))
        .collect()
}

fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    let i = a.intersection(b).count();
    if i == 0 { return 0.0; }
    i as f64 / a.union(b).count() as f64
}

fn overlap_coef(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    let i = a.intersection(b).count();
    if i == 0 { return 0.0; }
    i as f64 / a.len().min(b.len()) as f64
}

fn load(path: &str) -> Vec<(String, String)> {
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("读不了 {path}：{e}（先跑一次 --json 产出语料）"));
    let doc: Value = serde_json::from_str(&raw).expect("不是合法 JSON");
    let mut seen = BTreeMap::new();
    for s in doc["skills"].as_array().expect("缺 skills") {
        if s["loaded"].as_bool() != Some(true) { continue; }
        let d = s["description"].as_str().unwrap_or("");
        if d.is_empty() { continue; }
        // 按 (namespace, name) 去重：同一个 skill 的多份副本只算一次
        let key = format!("{}:{}", s["namespace"].as_str().unwrap_or(""),
                          s["name"].as_str().unwrap_or(""));
        seen.entry(key).or_insert_with(|| {
            (s["name"].as_str().unwrap_or("").to_string(), d.to_string())
        });
    }
    seen.into_values().collect()
}

fn count_at(items: &[(String, String)], toks: &[BTreeSet<String>], min: f64) -> usize {
    let mut n = 0;
    for i in 0..items.len() {
        for k in (i + 1)..items.len() {
            if jaccard(&toks[i], &toks[k]) >= min { n += 1; }
        }
    }
    n
}

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "/tmp/ov.json".into());
    let items = load(&path);

    println!("语料：{} 个已加载且有描述的 skill（{}）\n", items.len(), path);

    // ── 1. jieba 给英文打什么词性 ───────────────────────────
    let t_init = std::time::Instant::now();
    let j = Jieba::new();
    let init_ms = t_init.elapsed().as_secs_f64() * 1000.0;
    println!("== 1. 词性标注实况 ==");
    for probe in [
        "Create, read, edit Word .docx documents and templates.",
        "创建各类在线文档，管理知识库空间",
    ] {
        let tags: Vec<String> = j.tag(probe, true).into_iter()
            .map(|t| format!("{}/{}", t.word, t.tag)).collect();
        println!("  {probe}\n    {}\n", tags.join(" "));
    }
    println!("  → 英文一律 `eng`。只留 v/vn/n/nz 会把英文描述整段丢掉。\n");

    // ── 2. 三种配方 ────────────────────────────────────────
    let vn: BTreeSet<&str> = ["v", "vn", "n", "nz"].into_iter().collect();
    let vn_eng: BTreeSet<&str> =
        ["v", "vn", "n", "nz", "eng", "nr", "ns", "nt", "l", "i"].into_iter().collect();

    let t_bi = std::time::Instant::now();
    let bi: Vec<_> = items.iter().map(|(n, d)| tokenize_bigram(&format!("{n} {d}"))).collect();
    let bi_ms = t_bi.elapsed().as_secs_f64() * 1000.0;

    let t_a = std::time::Instant::now();
    let ja: Vec<_> = items.iter()
        .map(|(n, d)| tokenize_jieba(&j, &format!("{n} {d}"), &vn)).collect();
    let ja_ms = t_a.elapsed().as_secs_f64() * 1000.0;

    let jb: Vec<_> = items.iter()
        .map(|(n, d)| tokenize_jieba(&j, &format!("{n} {d}"), &vn_eng)).collect();

    println!("== 2. 三种配方，同一份语料 ==");
    println!("  {:<28} {:>8} {:>8} {:>10} {:>10}", "配方", "空集", "均词数", "≥0.25 对", "分词耗时");
    let row = |name: &str, t: &[BTreeSet<String>], ms: f64| {
        let empty = t.iter().filter(|x| x.is_empty()).count();
        let avg: f64 = t.iter().map(|x| x.len()).sum::<usize>() as f64 / t.len() as f64;
        println!("  {:<28} {:>8} {:>8.1} {:>10} {:>9.1}ms",
                 name, empty, avg, count_at(&items, t, 0.25), ms);
    };
    row("当前实现（字符 bigram）", &bi, bi_ms);
    row("提案原版（只留 v/n）", &ja, ja_ms);
    row("jieba + 保留 eng", &jb, ja_ms);
    println!();

    // ── 3. 中文子集：jieba 的收益全在这里 ────────────────────
    let cn: Vec<usize> = (0..items.len())
        .filter(|&i| cjk_ratio(&items[i].1) > 1.0 / 3.0).collect();
    println!("== 3. 中文为主的 {} 个 skill 单独比 ==", cn.len());
    let mut rows: Vec<(f64, f64, &str, &str)> = Vec::new();
    for (x, &i) in cn.iter().enumerate() {
        for &k in cn.iter().skip(x + 1) {
            let (a, b) = (jaccard(&bi[i], &bi[k]), jaccard(&jb[i], &jb[k]));
            if a > 0.0 || b > 0.0 {
                rows.push((a, b, &items[i].0, &items[k].0));
            }
        }
    }
    rows.sort_by(|p, q| q.1.partial_cmp(&p.1).unwrap());
    println!("  {:<26} {:<26} {:>8} {:>8}", "skill A", "skill B", "bigram", "jieba");
    for (a, b, x, y) in rows.iter().take(8) {
        println!("  {:<26} {:<26} {:>8.3} {:>8.3}{}", x, y, a, b,
                 if *b >= 0.25 && *a < 0.25 { "  ← jieba 才看得到" } else { "" });
    }
    println!("  ≥0.25：bigram {} 对 · jieba {} 对",
             rows.iter().filter(|r| r.0 >= 0.25).count(),
             rows.iter().filter(|r| r.1 >= 0.25).count());
    println!();

    // ── 4. 重叠系数：是误报发生器，不是漏报修复 ──────────────
    println!("== 4. 重叠系数 vs Jaccard（当前口径下）==");
    let mut promoted: Vec<(f64, f64, &str, &str, usize, usize)> = Vec::new();
    for i in 0..items.len() {
        for k in (i + 1)..items.len() {
            let (a, b) = (&bi[i], &bi[k]);
            if a.is_empty() || b.is_empty() { continue; }
            let (jc, ov) = (jaccard(a, b), overlap_coef(a, b));
            if ov >= 0.5 && jc < 0.25 {
                promoted.push((ov, jc, &items[i].0, &items[k].0, a.len(), b.len()));
            }
        }
    }
    promoted.sort_by(|p, q| q.0.partial_cmp(&p.0).unwrap());
    println!("  重叠 ≥0.5 但 Jaccard <0.25（Jaccard 完全看不到的）：{} 对", promoted.len());
    for (ov, jc, x, y, la, lb) in promoted.iter().take(6) {
        println!("    {:<24} ↔ {:<24} 重叠 {:.2} / Jaccard {:.2}  （词数 {}/{}）",
                 x, y, ov, jc, la, lb);
    }
    println!("  → 词数悬殊的那几对是「短描述写得笼统」，不是路由竞争。");
    println!();

    // ── 5. 成本 ────────────────────────────────────────────
    println!("== 5. 成本 ==");
    println!("  Jieba::new() 加载词典  {:.1} ms  ← 每次进程启动都要付", init_ms);
    println!("  （对照：整次扫描 30–70 ms，见 ADR-002 §9.3）");
    println!("  缓解办法：语料里没有 CJK 就别初始化 —— 纯英文用户零成本。");
}
