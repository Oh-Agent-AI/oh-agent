//! `explain`：漏斗的 UI（PRODUCT §5.3、ARCHITECTURE §1）。
//!
//! 这条命令回答的不是「有没有问题」，而是**「为什么」和「所以呢」**。每一段
//! 输出都必须落到一个用户能执行的动作 —— 否则它只是把 doctor 的一条诊断换了
//! 个排版重说一遍。
//!
//! 与 scan.py 的 `explain_record()` / `render_explain()` 逐字节对齐。

use serde_json::{json, Map, Value};

use agent_vitals_domain::skills::overlap::{overlap_pairs, OverlapOpts};
use crate::skills::render::{human_last_used, human_tokens};
use crate::util::wrap;
use crate::{b, f, i, s};

const STAGES: [&str; 6] = ["Installed", "Enabled", "Loaded", "Discoverable",
                           "Selected", "Triggered"];

fn glyph(state: &str) -> &'static str {
    match state {
        "true" => "✓",
        "false" => "✕",
        "at_risk" => "⚠",
        "unknown" => "?",
        _ => "·",
    }
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

fn full_name(sk: &Value) -> String {
    match sk.get("namespace").and_then(|v| v.as_str()) {
        Some(ns) if !ns.is_empty() => format!("{}:{}", ns, s(sk, "name")),
        _ => s(sk, "name"),
    }
}

/// 按名字找 skill。**同名多份要全部返回。**
///
/// 只返回一份的话，`explain` 就永远讲不清 shadowing —— 而那正是它最该讲清楚的
/// 一件事。匹配顺序：完整的 `<namespace>:<name>` 优先，其次裸 name。反过来的话，
/// 一个插件叫 `github` 而你想问的是 `gh:github`，会被裸名匹配抢先。
pub fn find_skills<'a>(out: &'a Value, target: &str) -> Vec<&'a Value> {
    let skills = arr(out, "skills");
    let ns_hit: Vec<&Value> = skills
        .iter()
        .filter(|x| {
            x.get("namespace").and_then(|v| v.as_str()).is_some_and(|ns| !ns.is_empty())
                && full_name(x) == target
        })
        .collect();
    if !ns_hit.is_empty() {
        return ns_hit;
    }
    skills.iter().filter(|x| s(x, "name") == target).collect()
}

/// path → (那份被谁盖了的 conflict, 是不是被盖的那一方)
fn shadow_of<'a>(out: &'a Value, path: &str) -> Option<(&'a Value, bool)> {
    for c in arr(out, "conflicts") {
        if s(&c["effective"], "path") == path {
            return Some((c, false));
        }
        for sh in arr(c, "shadowed") {
            if s(sh, "path") == path {
                return Some((c, true));
            }
        }
    }
    None
}

/// Enabled：所属 plugin / harness 配置是否启用。
///
/// **拿不到执行环境配置时是 unknown，不是 false。**把「问不到」渲染成「关着」，
/// 用户会去开一个本来就开着的开关，然后以为自己修好了。
fn enabled_stage(sk: &Value) -> (&'static str, String) {
    let reason = sk.get("loaded_reason").and_then(|v| v.as_str()).unwrap_or("");
    if sk.get("enabled_state").and_then(|v| v.as_bool()) == Some(false) {
        return ("false", "explicitly disabled in harness configuration".into());
    }
    if reason == "plugin-not-enabled" {
        return ("false", "owning plugin is absent from enabledPlugins".into());
    }
    if reason == "plugin-state-unknown" {
        return ("unknown", "harness configuration is unreadable; plugin state is unknown".into());
    }
    if let Some(mode) = reason.strip_prefix("workbuddy-mode-filtered:") {
        return ("false", format!("filtered by welcome mode: {mode}"));
    }
    if reason == "openclaw-config-disabled" {
        return ("false", "disabled in OpenClaw configuration".into());
    }
    let hf = s(sk, "harness_family");
    if sk.get("enabled_state").map(|v| v.is_null()).unwrap_or(true)
        && (hf == "openclaw" || hf == "workbuddy")
    {
        return ("unknown", "this harness has no per-skill enablement interface".into());
    }
    let level = s(sk, "level");
    let fallback = if !level.is_empty() {
        level
    } else if !reason.is_empty() {
        reason.to_string()
    } else {
        "—".to_string()
    };
    ("true", fallback)
}

/// 六级漏斗，每级 `(stage, state, reason)`。
///
/// 一旦某一级是 false，**下游全部记 n/a**：上游已经断了，下游的判断没有意义。
/// 硬给一个 true/false 会让用户去修一个不存在的问题。
pub fn funnel(sk: &Value, out: &Value, at_risk: &[String]) -> Vec<(String, String, String)> {
    let mut rows: Vec<(String, String, String)> =
        vec![("Installed".into(), "true".into(), s(sk, "path"))];

    let stop_from = |rows: &mut Vec<(String, String, String)>, from: usize, why: &str| {
        for st in STAGES.iter().skip(from) {
            rows.push(((*st).into(), "n/a".into(), why.into()));
        }
    };

    let (est, ereason) = enabled_stage(sk);
    rows.push(("Enabled".into(), est.into(), ereason));
    if est == "false" {
        stop_from(&mut rows, 2, "not applicable (disabled)");
        return rows;
    }

    let sh = shadow_of(out, &s(sk, "path"));
    if let Some((c, true)) = sh {
        rows.push(("Loaded".into(), "false".into(),
                   format!("shadowed by the {} level", s(&c["effective"], "level"))));
        stop_from(&mut rows, 3, "not applicable (not loaded)");
        return rows;
    }
    if !b(sk, "loaded") {
        let why = sk.get("loaded_reason").and_then(|v| v.as_str()).unwrap_or("");
        rows.push(("Loaded".into(), "false".into(),
                   if why.is_empty() { "—".into() } else { why.to_string() }));
        stop_from(&mut rows, 3, "not applicable (not loaded)");
        return rows;
    }
    let why = sk.get("loaded_reason").and_then(|v| v.as_str()).unwrap_or("");
    rows.push(("Loaded".into(), "true".into(),
               if why.is_empty() { "—".into() } else { why.to_string() }));

    // Discoverable **永远不取 false**（ARCHITECTURE §1.2）：「超预算后从调用最少
    // 的开始丢弃」是传闻不是实测，我们没有资格断言某一条真的被丢了。
    //
    // 注意这与 skill 记录里的 `discoverable` 字段**不是一回事** —— 那个是
    // OpenClaw 的「文件系统候选」，同名不同义，不能拿来复用。
    let empty = Value::Object(Map::new());
    let bud = out.get("description_budget").unwrap_or(&empty);
    if !(b(sk, "has_name") && b(sk, "has_description")) {
        let mut miss: Vec<&str> = Vec::new();
        if !b(sk, "has_name") {
            miss.push("name");
        }
        if !b(sk, "has_description") {
            miss.push("description");
        }
        rows.push(("Discoverable".into(), "at_risk".into(),
                   format!("frontmatter is missing {}", miss.join(", "))));
    } else if !b(bud, "available") {
        rows.push(("Discoverable".into(), "unknown".into(),
                   "this harness does not expose a description budget".into()));
    } else if at_risk.contains(&s(sk, "name")) {
        rows.push(("Discoverable".into(), "at_risk".into(),
                   format!("budget is exceeded by {} characters; this skill is in the estimated risk band", i(bud, "over_by_chars"))));
    } else {
        rows.push(("Discoverable".into(), "true".into(), "budget is within limit and frontmatter is complete".into()));
    }

    // Selected 没有任何直接数据源。**能给的只有 candidates，不是结论。**
    rows.push(("Selected".into(), "unknown".into(),
               "harness does not expose routing data; only overlap candidates are available".into()));

    let t = out.get("trigger_data").unwrap_or(&empty);
    if !b(t, "available") {
        rows.push(("Triggered".into(), "unknown".into(), "this harness does not expose trigger data".into()));
    } else if i(sk, "usage_count") > 0 {
        // DSH 的 invoked/selected 只是名字列表、没有时间戳：有用过但不知新鲜度，
        // 写「most recent never」就是自相矛盾。
        let last = sk.get("last_used_days_ago").and_then(|v| v.as_f64());
        if last.is_none() {
            rows.push(("Triggered".into(), "true".into(), format!(
                "{} uses; recency unknown", i(sk, "usage_count"))));
        } else {
            rows.push(("Triggered".into(), "true".into(), format!(
                "{} uses; most recent {}", i(sk, "usage_count"),
                human_last_used(last))));
        }
    } else {
        let age = f(sk, "installed_days_ago");
        let gate = t.get("zombie_min_age_days").and_then(|v| v.as_i64()).unwrap_or(14);
        let tail = if age >= gate as f64 {
            String::new()
        } else {
            format!("; younger than {gate} days, insufficient evidence")
        };
        rows.push(("Triggered".into(), "false".into(),
                   format!("zero lifetime triggers (installed {age:.0} days{tail})")));
    }
    rows
}

/// 预算溢出时，处于「估算风险区间」的 skill 名。
///
/// **直接读扫描器给的名单，绝不在这里重算。**重算过一次，因为手上只有被截断到
/// 前 5 条的 longest_descriptions，算出来的条数与 skills_possibly_dropped 对不上
/// —— 同一份报告里两个数互相打架，读者无从判断该信哪个。
pub fn budget_at_risk(out: &Value) -> Vec<String> {
    out.get("description_budget")
        .and_then(|b| b.get("at_risk_skills"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub struct Record {
    pub doc: Value,
    pub states: Vec<(String, String, String)>,
    pub path: String,
    pub name: String,
    pub namespace: Option<String>,
    pub is_shadowed: bool,
    pub conflict: Option<Value>,
    pub blocked_at: Option<String>,
    pub overlap_candidates: Vec<Value>,
}

fn state_of(states: &[(String, String, String)], stage: &str) -> (String, String) {
    states
        .iter()
        .find(|(n, _, _)| n == stage)
        .map(|(_, st, r)| (st.clone(), r.clone()))
        .unwrap_or_default()
}

pub fn explain_record(out: &Value, sk: &Value, at_risk: &[String], min: f64) -> Record {
    let rows = funnel(sk, out, at_risk);
    let blocked = rows.iter().find(|(_, st, _)| st == "false").map(|(n, _, _)| n.clone());
    let full = full_name(sk);
    let bare = s(sk, "name");
    let pairs_v = overlap_pairs(out, &OverlapOpts { min, top: None });
    let pairs: Vec<Value> = pairs_v
        .as_array()
        .map(|a| a.iter().filter(|p| {
            let (a_, b_) = (s(p, "a"), s(p, "b"));
            a_ == bare || b_ == bare || a_ == full || b_ == full
        }).cloned().collect())
        .unwrap_or_default();
    let sh = shadow_of(out, &s(sk, "path"));
    let status = match blocked.as_deref() {
        Some("Enabled") | Some("Loaded") => "NOT IN EFFECT",
        Some("Triggered") => "NEVER TRIGGERED",
        _ => "IN EFFECT",
    };
    let sec = &sk["security"];
    let doc = json!({
        "name": bare.clone(),
        "namespace": sk.get("namespace").cloned().unwrap_or(Value::Null),
        "path": s(sk, "path"),
        "harness": s(sk, "harness_family"),
        "status": status,
        "blocked_at": blocked.clone().map(Value::String).unwrap_or(Value::Null),
        "funnel": rows.iter().map(|(n, st, r)|
            json!({"stage": n, "state": st, "reason": r})).collect::<Vec<_>>(),
        "cost": {
            "tier1_tokens": i(sk, "tier1_tokens"),
            "tier2_core_tokens": i(sk, "tier2_core_tokens"),
            "tier2_refs_tokens": i(sk, "tier2_refs_tokens"),
            "tier2_max_tokens": i(sk, "tier2_max_tokens"),
            "tier2_refs_files": i(sk, "tier2_refs_files"),
            "body_lines": i(sk, "body_lines"),
        },
        "conflict": sh.map(|(c, _)| c.clone()).unwrap_or(Value::Null),
        "is_shadowed": sh.map(|(_, mine)| mine).unwrap_or(false),
        "overlap_candidates": pairs.clone(),
        "security": {
            "max_severity": s(sec, "max_severity"),
            "max_severity_uncited": s(sec, "max_severity_uncited"),
            "all_findings_cited": b(sec, "all_findings_cited"),
            "external_url_count": i(sec, "external_url_count"),
            "findings": sec.get("findings").cloned().unwrap_or(json!([])),
        },
    });
    Record {
        doc,
        states: rows,
        path: s(sk, "path"),
        name: bare,
        namespace: sk.get("namespace").and_then(|v| v.as_str()).map(str::to_string),
        is_shadowed: sh.map(|(_, mine)| mine).unwrap_or(false),
        conflict: sh.map(|(c, _)| c.clone()),
        blocked_at: blocked,
        overlap_candidates: pairs,
    }
}

/// 修复建议，**按省事程度排序**，且每条都要能直接执行。
fn fix_lines(rec: &Record) -> Vec<String> {
    if rec.is_shadowed {
        let c = rec.conflict.as_ref().expect("is_shadowed implies a conflict exists");
        let eff = &c["effective"];
        let me = arr(c, "shadowed")
            .iter()
            .find(|x| s(x, "path") == rec.path)
            .cloned()
            .unwrap_or(Value::Null);
        // 三种关系要说三种话。**相等不能归进「较旧」** —— 两份同时写下的副本说
        // 「你的较旧」是编的，而这一整段的价值就在于「为什么」可信。
        let rel = match i(&me, "mtime").cmp(&i(eff, "mtime")) {
            std::cmp::Ordering::Greater => "The copy you edited is newer but is not effective",
            std::cmp::Ordering::Less => "The effective copy is newer than this copy",
            std::cmp::Ordering::Equal => "Both copies have the same modification time; precedence selects the other copy",
        };
        return vec![
            format!("{rel}."),
            String::new(),
            format!("1. Rename: prefix project-specific skills ({} → <prefix>-{}) to eliminate the conflict",
                    rec.name, rec.name),
            "2. Symlink: for one source of truth, Claude Code follows symlinks \
and loads the same target only once".into(),
            "3. Layer: keep stable cross-project skills in home; keep project-specific skills in version control".into(),
            String::new(),
            "Note: some runtimes have shown both same-named skills in the selector instead of shadowing one. \
If you observe both, runtime behavior may differ from documentation; rename them to avoid ambiguity.".into(),
        ];
    }
    let (enabled, _) = state_of(&rec.states, "Enabled");
    if enabled == "false" {
        return vec![
            "1. Enable it in the harness configuration (Claude Code: enabledPlugins)".into(),
            "2. If unneeded, remove the on-disk copy to avoid future confusion".into(),
        ];
    }
    if enabled == "unknown" {
        return vec![
            "1. Make the harness configuration readable; otherwise this stage remains unknown".into(),
            "   Claude Code requires a readable ~/.claude.json".into(),
        ];
    }
    let (loaded, _) = state_of(&rec.states, "Loaded");
    if loaded == "false" {
        return vec!["1. Move it to a location scanned by this harness (see the reason above)".into()];
    }
    let mut lines: Vec<String> = Vec::new();
    let (disc, disc_reason) = state_of(&rec.states, "Discoverable");
    if disc == "at_risk" {
        if disc_reason.contains("frontmatter") {
            lines.push("1. Add missing frontmatter fields; without description the skill cannot be selected".into());
        } else {
            lines.push("1. Shorten the longest descriptions or disable unneeded skills to get under budget".into());
        }
    }
    let (trig, _) = state_of(&rec.states, "Triggered");
    if trig == "false" {
        lines.push(format!(
            "{}. Check why it was not selected (does the description clearly say when to use it?), \
then disable only if it is unnecessary. This tool never deletes anything automatically.", lines.len() + 1));
    }
    if !rec.overlap_candidates.is_empty() {
        lines.push(format!("{}. It has {} lexically overlapping neighbors; run `agent-vitals overlap` to inspect shared terms",
                           lines.len() + 1, rec.overlap_candidates.len()));
    }
    if lines.is_empty() {
        vec!["All measurable funnel stages pass; there is no actionable fix.".into()]
    } else {
        lines
    }
}

fn days_since_epoch(mtime: i64, now: f64) -> f64 {
    (now - mtime as f64) / 86400.0
}

/// 渲染一份副本。返回文本；`total > 1` 时带「第 N/M 份副本」。
fn print_one(rec: &Record, out: &Value, total: usize, idx: usize, now: f64) -> String {
    let mut w = String::new();
    macro_rules! p {
        ($($t:tt)*) => { w.push_str(&format!($($t)*)); w.push('\n'); };
    }
    let full = match &rec.namespace {
        Some(ns) if !ns.is_empty() => format!("{}:{}", ns, rec.name),
        _ => rec.name.clone(),
    };
    p!("");
    p!("{}{}", full,
       if total > 1 { format!("   (copy {}/{})", idx + 1, total) } else { String::new() });
    p!("{}", "─".repeat(50));
    p!("STATUS   {}", s(&rec.doc, "status"));
    p!("");
    p!("Funnel");
    p!("");
    for (stage, state, reason) in &rec.states {
        p!("  {} {:<16} {}", glyph(state), stage, reason);
    }

    p!("");
    p!("Reason");
    p!("");
    if let Some(c) = &rec.conflict {
        for line in wrap(out.get("precedence_note").and_then(|v| v.as_str()).unwrap_or(""), "  ", None) {
            p!("{}", line);
        }
        p!("");
        // **标出「你问的是哪一份」。**同名两份的路径长得很像，不标的话读者得
        // 逐字符比对才知道自己在看的是生效的那份还是被盖的那份。
        let mark = |path: &str| if path == rec.path { " ← requested copy" } else { "" };
        let eff = &c["effective"];
        p!("  active    {:<10} {}{}", s(eff, "level"), s(eff, "path"), mark(&s(eff, "path")));
        p!("            hash {}  modified {}", s(eff, "hash"),
           human_last_used(Some(days_since_epoch(i(eff, "mtime"), now))));
        for sh in arr(c, "shadowed") {
            p!("  shadowed  {:<10} {}{}", s(sh, "level"), s(sh, "path"), mark(&s(sh, "path")));
            p!("            hash {}  modified {}", s(sh, "hash"),
               human_last_used(Some(days_since_epoch(i(sh, "mtime"), now))));
        }
    } else if let Some(blocked) = &rec.blocked_at {
        let (_, reason) = state_of(&rec.states, blocked);
        for line in wrap(&format!("Blocked at {blocked}: {reason}"), "  ", None) {
            p!("{}", line);
        }
    } else {
        p!("  No blocked stage; all six measurable stages pass.");
    }

    p!("");
    p!("Impact");
    p!("");
    let impact = match rec.blocked_at.as_deref() {
        Some("Enabled") => Some("This skill is not in context; body changes cannot reach the model."),
        Some("Loaded") => Some("This skill body cannot reach the user."),
        Some("Triggered") => Some("It consumes description budget and startup context but has never been invoked."),
        _ => None,
    };
    match impact {
        Some(t) => {
            for line in wrap(t, "  ", None) {
                p!("{}", line);
            }
        }
        None => {
            // 四个桶不能合并：core 每次触发都载入，refs 按需，max 是全读时的上限。
            let c = &rec.doc["cost"];
            p!("  In effect. Cost:");
            p!("    tier1 (resident at startup)      {} tokens",
               human_tokens(Some(i(c, "tier1_tokens"))));
            p!("    tier2 core (loaded per trigger)  {} tokens  ({} lines)",
               human_tokens(Some(i(c, "tier2_core_tokens"))), i(c, "body_lines"));
            p!("    tier2 refs (read on demand)      {} tokens  ({} files)",
               human_tokens(Some(i(c, "tier2_refs_tokens"))), i(c, "tier2_refs_files"));
            p!("    tier2 max (all references read)  {} tokens",
               human_tokens(Some(i(c, "tier2_max_tokens"))));
        }
    }

    if !rec.overlap_candidates.is_empty() {
        p!("");
        p!("Potentially competing neighbors       [Lexical, review required]");
        p!("");
        for pr in rec.overlap_candidates.iter().take(5) {
            let a_ = s(pr, "a");
            let other = if a_ == rec.name || a_ == full { s(pr, "b") } else { a_ };
            let shared: Vec<String> = arr(pr, "shared")
                .iter().take(4).map(|x| x.as_str().unwrap_or("").to_string()).collect();
            p!("  {}   Jaccard {:.2}   shared terms {}", other, f(pr, "jaccard"),
               if shared.is_empty() { "—".to_string() } else { shared.join(" · ") });
        }
    }

    let sec = &rec.doc["security"];
    p!("");
    p!("Security");
    p!("");
    if s(sec, "max_severity") == "none" {
        // **绝不说「这个 skill 是安全的」。**没命中只说明这几条正则没匹配上。
        p!("  No rules matched. This does not prove safety; heuristics have false negatives.");
    } else {
        p!("  Highest severity {} (outside citation-like context: {})",
           s(sec, "max_severity"), s(sec, "max_severity_uncited"));
        for fnd in arr(sec, "findings").iter().take(6) {
            p!("    {:<24} {}:{}  {}{}", s(fnd, "rule"), s(fnd, "where"), i(fnd, "line"),
               s(fnd, "severity"),
               if b(fnd, "cited") { " (citation-like context)" } else { "" });
        }
        for line in wrap("Citation-like context affects sorting only; it does not reduce severity or suppress reporting. \
Open the reported line and review it.", "  ! ", None) {
            p!("{}", line);
        }
    }
    if i(sec, "external_url_count") > 0 {
        p!("  The body contains {} external URLs; third-party content can change at any time.",
           i(sec, "external_url_count"));
    }

    p!("");
    p!("Fixes (easiest first)");
    p!("");
    for line in fix_lines(rec) {
        if line.is_empty() {
            p!("");
            continue;
        }
        // 编号条目的续行缩进到编号之后（"  1. " 宽 5），免得和下一条的编号顶齐
        let chars: Vec<char> = line.chars().collect();
        let numbered = chars.len() > 2 && chars[0].is_ascii_digit() && chars[1] == '.';
        for wl in wrap(&line, "  ", Some(if numbered { "     " } else { "  " })) {
            p!("{}", wl);
        }
    }
    w
}

pub struct ExplainOpts {
    pub name: String,
    pub min: f64,
    pub now: f64,
}

pub enum ExplainOut {
    /// 渲染好的报告
    Text(String),
    /// 找不到那个名字：stderr 文本 + 退出码 1
    NotFound(String),
    /// `--json` 的负载
    Json(Value, usize),
}

pub fn render_explain(out: &Value, o: &ExplainOpts, want_json: bool) -> ExplainOut {
    let matches = find_skills(out, &o.name);
    if matches.is_empty() {
        let mut names: Vec<String> = arr(out, "skills").iter().map(|x| s(x, "name")).collect();
        names.sort();
        names.dedup();
        let needle = o.name.to_lowercase();
        let near: Vec<String> = names
            .into_iter()
            .filter(|n| n.to_lowercase().contains(&needle))
            .take(8)
            .collect();
        let mut msg = format!("No skill named '{}'.\n", o.name);
        if near.is_empty() {
            msg.push_str("Run `agent-vitals list` to see what was discovered.\n");
        } else {
            msg.push_str(&format!("Did you mean: {}\n", near.join(", ")));
        }
        return ExplainOut::NotFound(msg);
    }

    let at_risk = budget_at_risk(out);
    let recs: Vec<Record> = matches
        .iter()
        .map(|sk| explain_record(out, sk, &at_risk, o.min))
        .collect();

    if want_json {
        let payload = Value::Array(recs.iter().map(|r| r.doc.clone()).collect());
        return ExplainOut::Json(payload, recs.len());
    }

    let mut w = String::new();
    for (idx, rec) in recs.iter().enumerate() {
        if idx > 0 {
            w.push('\n');
            w.push_str(&"=".repeat(50));
            w.push('\n');
        }
        w.push_str(&print_one(rec, out, recs.len(), idx, o.now));
    }
    ExplainOut::Text(w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broken_upstream_marks_everything_below_as_na() {
        let sk = json!({
            "path": "/p", "loaded_reason": "plugin-not-enabled", "loaded": false,
            "harness_family": "claude-code", "name": "x",
        });
        let out = json!({"skills": [], "conflicts": []});
        let rows = funnel(&sk, &out, &[]);
        assert_eq!(rows[1].1, "false");
        for (stage, state, _) in rows.iter().skip(2) {
            assert_eq!(state, "n/a", "{stage} 在上游断了之后仍然给了判断");
        }
    }

    #[test]
    fn unreadable_harness_config_is_unknown_not_false() {
        // 渲染成 false，用户会去开一个本来就开着的开关
        let sk = json!({"loaded_reason": "plugin-state-unknown", "harness_family": "claude-code"});
        assert_eq!(enabled_stage(&sk).0, "unknown");
        let off = json!({"loaded_reason": "plugin-not-enabled", "harness_family": "claude-code"});
        assert_eq!(enabled_stage(&off).0, "false");
    }

    #[test]
    fn discoverable_never_takes_false() {
        // ARCHITECTURE §1.2：「超预算后丢弃最少用的」是传闻不是实测
        let sk = json!({
            "path": "/p", "loaded": true, "loaded_reason": "personal", "level": "personal",
            "harness_family": "claude-code", "name": "x",
            "has_name": true, "has_description": true, "usage_count": 0,
            "installed_days_ago": 900.0,
        });
        for bud in [json!({"available": false}),
                    json!({"available": true, "over_by_chars": 500})] {
            let out = json!({"skills": [], "conflicts": [], "description_budget": bud,
                             "trigger_data": {"available": false}});
            let rows = funnel(&sk, &out, &["x".to_string()]);
            let d = rows.iter().find(|(n, _, _)| n == "Discoverable").unwrap();
            assert_ne!(d.1, "false", "{rows:?}");
        }
    }

    #[test]
    fn namespaced_lookup_beats_bare_name() {
        let out = json!({"skills": [
            {"name": "gh", "namespace": Value::Null},
            {"name": "gh", "namespace": "pg"},
        ]});
        let hit = find_skills(&out, "pg:gh");
        assert_eq!(hit.len(), 1);
        assert_eq!(s(hit[0], "namespace"), "pg");
        assert_eq!(find_skills(&out, "gh").len(), 2);
    }
}
