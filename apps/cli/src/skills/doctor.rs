//! `doctor`：把事实翻成「原因 → 影响 → 行动」（PRODUCT §5.1、ARCHITECTURE §5）。
//!
//! 扫描器只负责事实，这一层负责判断。它**不重新测量任何东西** —— 所有数字都
//! 从扫描输出里取，否则同一个数会有两个来源，而两个来源迟早会给出两个答案。
//!
//! 与 scan.py 的 `diagnose()` / `render_doctor()` 逐字节对齐（tests/test_doctor.py
//! 的 `TestBothImplementationsRenderIdentically`）。

use serde_json::{json, Map, Value};

use agent_vitals_domain::skills::overlap::{overlap_pairs, OverlapOpts};
use crate::skills::render::{human_tokens, last_used_text, lifecycle_status, DEFAULT_DORMANT_DAYS};
use crate::util::{run_id, wrap};
use crate::{b, f, i, s};

pub const DEFAULT_OVERLAP_MIN: f64 = 0.25;

fn severity_rank(sev: &str) -> u8 {
    match sev {
        "critical" => 0,
        "warning" => 1,
        _ => 2,
    }
}

fn glyph(sev: &str) -> &'static str {
    match sev {
        "critical" => "✕",
        "warning" => "⚠",
        _ => "·",
    }
}

/// 安全规则名 → 诊断码。**必须覆盖
/// agent_vitals_domain::skills::security_rules::rule_names() 的每一条**：
/// 扫描器里有、这张表里没有的规则会在 doctor 里**静默消失** —— 一条命中了却
/// 不出现在诊断里的规则，比没有这条规则更糟。下面的 `#[cfg(test)]` 钉住全覆盖。
pub const SECURITY_CODES: &[(&str, &str, &str)] = &[
    ("adversarial_instruction", "SV501", "PROMPT_INJECTION_PATTERN"),
    ("pipe_to_shell", "SV502", "PIPE_TO_SHELL"),
    ("base64_exec", "SV503", "BASE64_EXEC"),
    ("raw_ip_fetch", "SV504", "RAW_IP_FETCH"),
    ("hardcoded_secret", "SV505", "HARDCODED_SECRET"),
    ("credential_env_read", "SV506", "CREDENTIAL_READ"),
    ("obfuscated_exec", "SV507", "OBFUSCATED_EXEC"),
    ("password_archive", "SV508", "PASSWORD_PROTECTED_ARCHIVE"),
];

/// 安全命中的原始严重度 → 诊断严重度。critical 保持 critical；high/medium 都是
/// warning（「会造成损害」）。**info 不用于安全**：info 的定义是「仅供参考」，
/// 而任何一条安全命中都需要人打开看一眼。
fn security_severity(worst: &str) -> &'static str {
    match worst {
        "critical" => "critical",
        _ => "warning",
    }
}

/// 本次**不评估**的诊断码，以及为什么。
///
/// 这张表要打印出来。少一条诊断而不说，读者会把「没报」读成「没有」—— 与 §7.2
/// 「缺一列的报告有价值，编一列的没有」是同一条规矩。
pub const NOT_ASSESSED: &[(&str, &str, &str)] = &[
    ("SV003", "DESCRIPTION_TOO_LONG",
     "There is no defensible threshold. What counts as long depends on the harness and total skill count."),
    ("SV104", "PLUGIN_NOT_ENABLED",
     "A disabled plugin is normal, not a defect; it is counted under not loaded."),
    ("SV203", "ORPHANED_USAGE_RECORD",
     "Renaming breaks trigger history and cannot be distinguished from deletion (open PRODUCT §10 question)."),
    ("SV302", "HIGH_METADATA_COST", "Same as SV003: no defensible threshold."),
    ("SV402", "OVERLAP_CONFIRMED", "Requires an in-harness or --judge semantic decision; not implemented yet."),
];

/// 一条诊断。`caveats` 不是可选项（ARCHITECTURE §5.1）：带已知系统性偏差的
/// 结论，偏差必须与结论同屏。没有 caveat 就传空 vec，不能省。
fn diag(
    code: &str,
    name: &str,
    severity: &str,
    impact: String,
    recommendation: String,
    caveats: Vec<String>,
    evidence: Value,
) -> Value {
    json!({
        "code": code, "name": name, "severity": severity, "skill": Value::Null,
        "evidence": evidence, "impact": impact,
        "recommendation": recommendation, "caveats": caveats,
    })
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

/// 把扫描输出翻成诊断列表。纯函数：只读 out，不碰文件系统。
pub fn diagnose(out: &Value, split_threshold: i64, overlap_min: f64) -> Vec<Value> {
    let mut ds: Vec<Value> = Vec::new();
    let empty = Value::Object(Map::new());
    let skills = arr(out, "skills");
    let loaded: Vec<&Value> = skills.iter().filter(|x| b(x, "loaded")).collect();
    let bud = out.get("description_budget").unwrap_or(&empty);
    let trig_block = out.get("trigger_data").unwrap_or(&empty);
    let trig = b(trig_block, "available");

    // ── 预算 ──────────────────────────────────────────────
    let mut budget_caveats: Vec<String> = Vec::new();
    if let Some(n) = bud.get("note").and_then(|v| v.as_str()) {
        budget_caveats.push(n.to_string());
    }
    if b(bud, "excludes_builtin_skills") {
        budget_caveats.push(
            "This number excludes built-in skills bundled in the CLI without a SKILL.md on disk; actual usage is higher.".into());
    }
    if b(bud, "available") {
        let over = i(bud, "over_by_chars");
        let pct = f(bud, "pct_used");
        if over > 0 {
            let workaround = bud
                .get("workaround")
                .and_then(|v| v.as_str())
                .map(|w| format!("Immediate workaround: {w}. "))
                .unwrap_or_default();
            ds.push(diag(
                "SV002", "DESCRIPTION_BUDGET_OVERFLOW", "critical",
                "The description budget is exceeded; some skills may be silently omitted without an error.".into(),
                format!("{workaround}Durable fix: shorten the longest descriptions or disable unneeded skills."),
                budget_caveats,
                json!({
                    "used_chars": bud.get("used_chars"),
                    "budget_chars": bud.get("budget_chars"),
                    "over_by_chars": bud.get("over_by_chars"),
                    "scope": bud.get("scope"),
                    "counted_skills": bud.get("counted_skills"),
                    "skills_possibly_dropped": bud.get("skills_possibly_dropped"),
                    "longest_descriptions": arr(bud, "longest_descriptions"),
                }),
            ));
        } else if pct >= 85.0 {
            ds.push(diag(
                "SV001", "DESCRIPTION_BUDGET_WARNING", "warning",
                format!("The description budget is {}% used and close to overflowing.", fmt1(pct)),
                "Shorten the longest descriptions now, before troubleshooting an overflow.".into(),
                budget_caveats,
                json!({
                    // **与 SV002 同构。**少了 scope / counted_skills 时渲染层
                    // 会把缺失当成 0 打出「0 skills」—— 把「这条证据里没带」
                    // 说成「数过了，是零个」。证据不全就补证据。
                    "used_chars": bud.get("used_chars"),
                    "budget_chars": bud.get("budget_chars"),
                    "pct_used": bud.get("pct_used"),
                    "scope": bud.get("scope"),
                    "counted_skills": bud.get("counted_skills"),
                    "longest_descriptions": arr(bud, "longest_descriptions"),
                }),
            ));
        }
    }

    // ── 覆盖 ──────────────────────────────────────────────
    // 顺序必须与 Python 的 dict 字面量一致：shadowed_newer → intentional_override
    // → redundant。同严重度的两条会靠 code 再排一次，但严重度不同的靠这里定序。
    let kinds: [(&str, &str, &str, &str, &str, &str); 3] = [
        ("shadowed_newer", "SV101", "SKILL_SHADOWED_NEWER", "critical",
         "The copy you edited is not effective: the shadowed copy is newer than the active copy.",
         "Move the change to the effective copy or remove the obsolete duplicate."),
        ("intentional_override", "SV103", "SKILL_SHADOWED_OVERRIDE", "warning",
         "Multiple copies share the same name; the higher-priority newer copy is effective.",
         "Confirm that this override is intentional; otherwise remove the extra copy."),
        ("redundant", "SV102", "SKILL_SHADOWED_REDUNDANT", "info",
         "Multiple same-named copies have identical content and are redundant.",
         "Remove any redundant copy without changing behavior."),
    ];
    let precedence = out.get("precedence_note").and_then(|v| v.as_str());
    for (kind, code, name, sev, impact, rec) in kinds {
        let hits: Vec<&Value> = arr(out, "conflicts").iter().filter(|c| s(c, "kind") == kind).collect();
        if hits.is_empty() {
            continue;
        }
        ds.push(diag(
            code, name, sev, impact.into(), rec.into(),
            precedence.map(|p| vec![p.to_string()]).unwrap_or_default(),
            json!({"count": hits.len(), "conflicts": hits}),
        ));
    }

    // ── frontmatter ──────────────────────────────────────
    let structure = out.get("structure").unwrap_or(&empty);
    let missing = arr(structure, "missing_frontmatter");
    if !missing.is_empty() {
        ds.push(diag(
            "SV105", "INVALID_FRONTMATTER", "warning",
            "A skill missing name or description cannot be selected reliably.".into(),
            "Add name and description to its frontmatter.".into(),
            vec![],
            json!({"count": missing.len(), "skills": missing}),
        ));
    }

    // ── 使用 ──────────────────────────────────────────────
    // **零触发的前提是「问得到」**。没有触发数据时这一整段不出现，而不是出现
    // 一个「0 个僵尸」—— 后者读起来像「查过了，很健康」。
    let zombie_gate = trig_block
        .get("zombie_min_age_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(14);
    if trig {
        let zc = arr(trig_block, "zombie_candidates");
        let too_new = arr(trig_block, "too_new_to_judge");
        if !zc.is_empty() {
            let mut caveats = vec![
                "Trigger counts are lifetime totals, not a rolling 30-day window.".to_string(),
                "Zero triggers can also mean budget pressure or poor selection; those are SV002 / SV401 issues, \
not proof that a skill should be removed.".to_string(),
            ];
            if !too_new.is_empty() {
                caveats.push(format!(
                    "Another {} skills are younger than {} days and are not judged due to insufficient evidence.",
                    too_new.len(), zombie_gate));
            }
            ds.push(diag(
                "SV201", "ZERO_TRIGGER", "warning",
                format!("{} skills are at least {} days old and have zero lifetime triggers, consuming budget and startup context.",
                        zc.len(), zombie_gate),
                "Use explain to see why each skill was not selected; disable it only after confirming it is unnecessary. \
This tool never deletes anything automatically.".into(),
                caveats,
                json!({"count": zc.len(), "too_new_count": too_new.len(),
                       "zombie_min_age_days": zombie_gate, "skills": zc}),
            ));
        }
        let mut dormant: Vec<&&Value> = loaded
            .iter()
            .filter(|x| lifecycle_status(x, true, zombie_gate, DEFAULT_DORMANT_DAYS) == "dormant")
            .collect();
        if !dormant.is_empty() {
            dormant.sort_by(|a, c| {
                f(c, "last_used_days_ago")
                    .partial_cmp(&f(a, "last_used_days_ago"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            ds.push(diag(
                "SV202", "DORMANT_SKILL", "warning",
                format!("{} skills were used before but have not triggered for more than {} days.",
                        dormant.len(), DEFAULT_DORMANT_DAYS),
                "Prior use is evidence of value; check whether a newer skill is competing before removing it.".into(),
                vec!["Dormant means not used recently. Seasonal tasks such as tax filing or releases can appear here normally.".into()],
                json!({
                    "count": dormant.len(), "dormant_days": DEFAULT_DORMANT_DAYS,
                    "skills": dormant.iter().map(|x| json!({
                        "name": s(x, "name"),
                        "last_used_days_ago": x.get("last_used_days_ago"),
                        "usage_count": x.get("usage_count"),
                    })).collect::<Vec<_>>(),
                }),
            ));
        }
    }

    // ── 成本 ──────────────────────────────────────────────
    let oversized = arr(structure, "oversized");
    if !oversized.is_empty() {
        ds.push(diag(
            "SV301", "HIGH_TRIGGER_COST", "warning",
            format!("{} skills have SKILL.md bodies over {} tokens; this core is loaded on every trigger.",
                    oversized.len(), split_threshold),
            "Move on-demand material to references/ and keep only the decision path in the core body.".into(),
            vec![
                "The criterion is tier2_core_tokens, not line count; density can vary by more than 4x.".into(),
                "Splitting lowers average core cost and can increase worst-case max cost; name the metric that improved.".into(),
            ],
            json!({"count": oversized.len(), "split_threshold_tokens": split_threshold,
                   "skills": oversized}),
        ));
        // 又大又没人用 —— 两个信号叠加才值得单独提一条
        if trig {
            let zombie_names: Vec<String> = arr(trig_block, "zombie_candidates")
                .iter().map(|z| s(z, "name")).collect();
            let both: Vec<&Value> = oversized
                .iter()
                .filter(|o| zombie_names.contains(&s(o, "name")))
                .collect();
            if !both.is_empty() {
                ds.push(diag(
                    "SV303", "EXPENSIVE_AND_UNUSED", "warning",
                    format!("{} skills exceed the split threshold and have zero lifetime triggers.", both.len()),
                    "Review these first because they have the weakest measured cost-to-use ratio.".into(),
                    vec!["As with SV201, zero triggers do not prove uselessness; the skill may never have been selected.".into()],
                    json!({"count": both.len(), "skills": both}),
                ));
            }
        }
    }

    // ── 路由 ──────────────────────────────────────────────
    let pairs_v = overlap_pairs(out, &OverlapOpts { min: overlap_min, top: None });
    let pairs = pairs_v.as_array().cloned().unwrap_or_default();
    if !pairs.is_empty() {
        ds.push(diag(
            "SV401", "OVERLAP_CANDIDATE", "warning",
            format!("{} skill pairs have highly overlapping wording and may compete for the same requests.", pairs.len()),
            "Run `agent-vitals overlap` to inspect shared terms; for an actionable judgment, run /agent-vitals \
in Claude Code and let the model read the descriptions.".into(),
            vec!["This is a lexical filter, not a verdict. Skills with different wording can still compete, \
so false negatives are more common than false positives.".into()],
            json!({"count": pairs.len(), "min_jaccard": overlap_min,
                   "pairs": pairs.iter().take(10).collect::<Vec<_>>()}),
        ));
    }

    // ── 安全 ──────────────────────────────────────────────
    // 按诊断码聚合，而不是按 skill：读者要的是「有没有 pipe_to_shell」，
    // 每一条命中都带 skill + 文件 + 行号，因为**打开那一行看一眼才是防线**。
    let security = out.get("security").unwrap_or(&empty);
    let mut by_code: Vec<(String, String, Vec<Value>)> = Vec::new();
    for sk in arr(security, "flagged") {
        for fnd in arr(sk, "findings") {
            let rule = s(fnd, "rule");
            let (code, cname) = SECURITY_CODES
                .iter()
                .find(|(r, _, _)| *r == rule)
                .map(|(_, c, n)| (c.to_string(), n.to_string()))
                .unwrap_or_else(|| ("SV500".into(), "UNMAPPED_SECURITY_RULE".into()));
            let hit = json!({
                "skill": s(sk, "name"), "path": sk.get("path"), "loaded": sk.get("loaded"),
                "rule": rule, "severity": s(fnd, "severity"), "cited": b(fnd, "cited"),
                "where": fnd.get("where"), "line": fnd.get("line"), "match": fnd.get("match"),
            });
            match by_code.iter_mut().find(|(c, _, _)| *c == code) {
                Some(e) => e.2.push(hit),
                None => by_code.push((code, cname, vec![hit])),
            }
        }
    }
    by_code.sort_by(|a, c| a.0.cmp(&c.0)); // Python: sorted(hits_by_code.items())
    for (code, cname, hits) in &by_code {
        let worst = ["critical", "high", "medium"]
            .into_iter()
            .find(|lvl| hits.iter().any(|h| s(h, "severity") == *lvl))
            .unwrap_or("medium");
        // cited 那段解释**只在真有 cited 命中时**出现。一段完全相同的三行说明
        // 在报告里重复五遍，读者会开始跳过它 —— 而它恰恰是不该被跳过的那一段。
        let mut caveats = vec!["Heuristic rules: a match does not prove malware, and no match does not prove safety.".to_string()];
        if hits.iter().any(|h| b(h, "cited")) {
            caveats.push("Findings marked as citation-like context are only sorted differently; severity is not reduced and \
reporting is not suppressed. 'For example,' or an unmatched quote can fool this hint, so it is not a safety verdict.".into());
        }
        ds.push(diag(
            code, cname, security_severity(worst),
            format!("{} findings (highest severity: {}).", hits.len(), worst),
            "Open every reported line and review it manually.".into(),
            caveats,
            json!({"count": hits.len(), "hits": hits.iter().take(20).collect::<Vec<_>>()}),
        ));
    }

    // ── 执行环境能力 ──────────────────────────────────────────
    let mut lacking: Vec<&str> = Vec::new();
    if !b(bud, "available") {
        lacking.push("description budget");
    }
    if !trig {
        lacking.push("trigger data");
    }
    if !b(out.get("plugin_state").unwrap_or(&empty), "harness_config_read") {
        lacking.push("load-state evidence");
    }
    if !lacking.is_empty() {
        ds.push(diag(
            "SV901", "CAPABILITY_UNAVAILABLE", "info",
            format!("This harness does not provide: {}. Related judgments are omitted rather than treated as zero.", lacking.join(", ")),
            "Only Claude Code provides these fields through ~/.claude.json; their absence on another harness is not a failure.".into(),
            vec!["Unavailable is not zero. Rendering the former as the latter would turn an unmeasured value into a decision.".into()],
            json!({"unavailable": lacking, "harness_selection": out.get("harness_selection")}),
        ));
    }

    let unreadable = arr(out, "unreadable_skills");
    if !unreadable.is_empty() {
        ds.push(diag(
            "SV902", "SKILL_UNREADABLE", "warning",
            format!("{} SKILL.md files are unreadable and are excluded from all statistics above.", unreadable.len()),
            "Check permissions and encoding; the inventory is incomplete until these files can be read.".into(),
            vec!["This directly affects the denominators for budget, conflict, and zombie analysis.".into()],
            json!({"count": unreadable.len(),
                   "skills": unreadable.iter().take(20).collect::<Vec<_>>()}),
        ));
    }

    // Python: ds.sort(key=lambda d: (SEVERITY_RANK[severity], code)) —— 稳定排序
    ds.sort_by(|a, c| {
        (severity_rank(&s(a, "severity")), s(a, "code"))
            .cmp(&(severity_rank(&s(c, "severity")), s(c, "code")))
    });
    ds
}

/// Python 的 `"%.1f" % x`。
fn fmt1(x: f64) -> String {
    format!("{x:.1}")
}

/// Python 的 `"%s" % float`（即 `repr(float)`）。
///
/// Rust 的 `f64::to_string()` 把 14500.0 打成 `14500`，Python 打成 `14500.0` ——
/// 这一个字符就能让差分测试变红。整数值补上 `.0`。
fn py_float(x: f64) -> String {
    let t = x.to_string();
    if t.contains('.') || t.contains('e') || t.contains("inf") || t.contains("NaN") {
        t
    } else {
        format!("{t}.0")
    }
}

/// Python 的 `"{:,}".format(n)`。
fn comma(n: i64) -> String {
    let neg = n < 0;
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (digits.len() - idx) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if neg { format!("-{out}") } else { out }
}

/// 未加载的原因分布。
///
/// 未知的 reason **原样显示**，不并进「其他」—— 新增一种加载原因时，它应当在
/// 报告里跳出来，而不是被一个兜底桶吸收掉。
fn not_loaded_breakdown(skills: &[Value]) -> Vec<(String, usize)> {
    let label = |r: &str| -> String {
        match r {
            "plugin-not-enabled" => "plugin disabled".into(),
            "plugin-state-unknown" => "plugin state unknown".into(),
            "unknown-location" => "unclassified location".into(),
            "openclaw-config-disabled" => "disabled in config".into(),
            "openclaw-config-enabled-runtime-unverified" => "runtime unverified".into(),
            "openclaw-discoverable-runtime-unverified" => "runtime unverified".into(),
            "openclaw-cli-not-eligible" => "runtime ineligible".into(),
            other if other.starts_with("workbuddy-mode-filtered") => "mode filtered".into(),
            other => other.to_string(),
        }
    };
    let mut counts: Vec<(String, usize)> = Vec::new();
    for sk in skills {
        if b(sk, "loaded") {
            continue;
        }
        let raw = sk.get("loaded_reason").and_then(|v| v.as_str()).unwrap_or("unknown");
        let k = label(if raw.is_empty() { "unknown" } else { raw });
        match counts.iter_mut().find(|(n, _)| *n == k) {
            Some(e) => e.1 += 1,
            None => counts.push((k, 1)),
        }
    }
    // Python: sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    counts.sort_by(|a, c| (std::cmp::Reverse(a.1), &a.0).cmp(&(std::cmp::Reverse(c.1), &c.0)));
    counts
}

pub struct DoctorOpts {
    pub split_threshold: i64,
    pub min: f64,
    pub version: &'static str,
}

/// `doctor` 的呈现。遵守 PRODUCT §5.1 的三条渲染纪律。
pub fn render_doctor(out: &Value, o: &DoctorOpts) -> String {
    let ds = diagnose(out, o.split_threshold, o.min);
    let empty = Value::Object(Map::new());
    let bud = out.get("description_budget").unwrap_or(&empty);
    let trig_block = out.get("trigger_data").unwrap_or(&empty);
    let skills = arr(out, "skills");

    let mut w = String::new();
    macro_rules! p {
        ($($t:tt)*) => { w.push_str(&format!($($t)*)); w.push('\n'); };
    }

    p!("Agent Vitals {} · run {}", o.version, run_id(out));
    p!("{}", "─".repeat(50));
    p!("Harness    {}", out.get("harness_selection").and_then(|v| v.as_str()).unwrap_or("?"));
    p!("        trigger data {} · load evidence {} · description budget {}",
       if b(trig_block, "available") { "✓" } else { "—" },
       if b(out.get("plugin_state").unwrap_or(&empty), "harness_config_read") { "✓" } else { "—" },
       if b(bud, "available") { "✓" } else { "—" });
    p!("");
    p!("Skills  {} on disk → {} loaded",
       out.get("total_skills_on_disk").and_then(|v| v.as_i64()).unwrap_or(0),
       out.get("loaded_skills").and_then(|v| v.as_i64()).unwrap_or(0));
    let breakdown = not_loaded_breakdown(skills);
    if !breakdown.is_empty() {
        p!("        not loaded: {}",
           breakdown.iter().map(|(k, n)| format!("{k} {n}"))
               .collect::<Vec<_>>().join(" · "));
    }

    // 变化段在结论**之前**（PRODUCT §5.1）。这是 diff 进入用户路径的方式。
    if let Some(d) = out.get("diff_vs_baseline") {
        if let Some(e) = d.get("error").and_then(|v| v.as_str()) {
            p!("");
            p!("Changes  {}", e);
        } else {
            p!("");
            p!("Changes since {}",
               d.get("baseline_file").and_then(|v| v.as_str()).unwrap_or(""));
            let tn = arr(d, "loaded_then_now");
            let (then, now) = (
                tn.first().and_then(|v| v.as_i64()).unwrap_or(0),
                tn.get(1).and_then(|v| v.as_i64()).unwrap_or(0),
            );
            p!("  loaded {} → {}  ·  + {} skills · − {} skills",
               then, now, arr(d, "added_skills").len(), arr(d, "removed_skills").len());
            let pc = arr(d, "budget_pct_then_now");
            if let (Some(pt), Some(pn)) = (
                pc.first().and_then(|v| v.as_f64()),
                pc.get(1).and_then(|v| v.as_f64()),
            ) {
                p!("  description budget  {}% → {}%{}", fmt1(pt), fmt1(pn),
                   if i(bud, "over_by_chars") > 0 { "  ⚠ overflow" } else { "" });
            }
            if !arr(d, "newly_judgeable").is_empty() {
                p!("  {} skills crossed the age gate and are judged for the first time",
                   arr(d, "newly_judgeable").len());
            }
            if !arr(d, "new_security_findings").is_empty() {
                p!("  {} new security findings", arr(d, "new_security_findings").len());
            }
        }
    }

    for (sev, title) in [("critical", "CRITICAL"), ("warning", "WARNING"), ("info", "INFO")] {
        let group: Vec<&Value> = ds.iter().filter(|x| s(x, "severity") == sev).collect();
        if group.is_empty() {
            continue;
        }
        p!("");
        p!("{} — {} findings", title, group.len());
        for x in group {
            p!("");
            for line in wrap(&s(x, "impact"), &format!("  {} {}  ", glyph(sev), s(x, "code")), None) {
                p!("{}", line);
            }
            for line in evidence_lines(x) {
                p!("           {}", line);
            }
            for line in wrap(&s(x, "recommendation"), "           → ", None) {
                p!("{}", line);
            }
            for c in arr(x, "caveats") {
                for line in wrap(c.as_str().unwrap_or(""), "           ! ", None) {
                    p!("{}", line);
                }
            }
        }
    }

    // 纪律 1：描述预算（chars）与启动上下文（tokens）必须**分开两段**。
    // v0.1 把它们并排，用户第一眼读成「上下文用掉 91%」—— 虚报预算危机会让人
    // 去做无用功，比不报更糟。
    p!("");
    p!("Description budget");
    if b(bud, "available") {
        // 纪律 3：没超就正常报一句百分比，不渲染成问题。
        p!("  {} / {} chars ({}%)  ·  {}, {} skills",
           comma(i(bud, "used_chars")), comma(i(bud, "budget_chars")),
           fmt1(f(bud, "pct_used")),
           s(bud, "scope"), i(bud, "counted_skills"));
        // 纪律 2：预算数字永远与「不含内置 skill」同屏。省掉这条 caveat，
        // 结论会从高估**翻转成低估**。
        if b(bud, "excludes_builtin_skills") {
            p!("  ! Excludes built-in skills bundled in the CLI; actual usage is higher");
        }
        p!("  ! The threshold varies by harness version; override it with --budget");
    } else {
        p!("  Unavailable — this harness does not expose it, or its config is unreadable");
        p!("  ! Unavailable does not mean zero characters used");
    }

    p!("");
    p!("Startup context (tier1)");
    p!("  approx. {} tokens  ·  approx. {}% of 200k   [estimated]",
       comma(i(out, "tier1_total_tokens")),
       format!("{:.2}", f(out, "tier1_pct_of_200k")));

    let sec = out.get("security").unwrap_or(&empty);
    p!("");
    p!("Security");
    if i(sec, "flagged_count") > 0 {
        p!("  {} skills have findings · {} critical",
           i(sec, "flagged_count"), i(sec, "critical_count"));
        if i(sec, "all_cited_count") > 0 {
            p!("  {} have findings only in citation-like context (sorting hint only; review required)",
               i(sec, "all_cited_count"));
        }
    } else {
        p!("  No rules matched.");
    }
    // **绝不输出「这个 skill 是安全的」。**没有命中只说明这几条正则没匹配上。
    p!("  ! Heuristic rules: a match does not prove malware, and no match does not prove safety.");

    p!("");
    p!("Not assessed");
    for (code, name, why) in NOT_ASSESSED {
        for line in wrap(&format!("{name} —— {why}"), &format!("  {code} "), None) {
            p!("{}", line);
        }
    }

    p!("");
    p!("Next steps");
    p!("  agent-vitals list                 See which skills are actually in context");
    if ds.iter().any(|x| s(x, "code") == "SV401") {
        p!("  agent-vitals overlap              Inspect potentially competing pairs");
    }
    p!("  Run /agent-vitals in Claude Code  Let the model judge descriptions semantically");
    // 快照那几行由 agent_vitals_runtime::skills::snapshot::doctor_snapshot 在这之后追加 —— **它必须在写盘
    // 成功之后才说自己存了**，所以不能在这里预先打。
    w
}

/// 每条诊断的证据行。**只从 evidence 里取，不重新算。**
fn evidence_lines(d: &Value) -> Vec<String> {
    let e = d.get("evidence").cloned().unwrap_or(Value::Null);
    let code = s(d, "code");
    match code.as_str() {
        "SV001" | "SV002" => {
            let used = i(&e, "used_chars");
            let budget = i(&e, "budget_chars");
            let pct = match e.get("pct_used").and_then(|v| v.as_f64()) {
                Some(p) => fmt1(p),
                // Python: e.get("pct_used", round(used/budget*100, 1))
                None => py_float(crate::util::pyround(used as f64 / budget as f64 * 100.0, 1)),
            };
            let scope = e.get("scope").and_then(|v| v.as_str()).unwrap_or("loaded-only");
            let scope = if scope.is_empty() { "loaded-only" } else { scope };
            let mut lines = vec![format!("{} / {} chars ({}%)  ·  {}, {} skills",
                comma(used), comma(budget), pct, scope, i(&e, "counted_skills"))];
            let dropped = i(&e, "skills_possibly_dropped");
            if dropped > 0 {
                lines.push(format!("Descriptions for approx. {dropped} skills may have been silently omitted"));
            }
            let longest = arr(&e, "longest_descriptions");
            let joined = longest.iter().take(3)
                .map(|x| format!("{} {}", s(x, "name"), i(x, "chars")))
                .collect::<Vec<_>>().join(", ");
            if !joined.is_empty() {
                lines.push(format!("Longest: {joined}"));
            }
            lines
        }
        "SV101" | "SV102" | "SV103" => {
            let cs = arr(&e, "conflicts");
            let mut lines = Vec::new();
            for c in cs.iter().take(5) {
                lines.push(s(c, "name"));
                let eff = &c["effective"];
                lines.push(format!("  active    {:<10} {}", s(eff, "level"), s(eff, "path")));
                for sh in arr(c, "shadowed") {
                    lines.push(format!("  shadowed  {:<10} {}", s(sh, "level"), s(sh, "path")));
                }
            }
            let n = i(&e, "count") as usize;
            if n > 5 {
                lines.push(format!("… and {} more", n - 5));
            }
            lines
        }
        "SV105" => arr(&e, "skills").iter().take(5).map(|x| format!(
            "{} (name={} description={})", s(x, "name"),
            if b(x, "has_name") { "✓" } else { "✗" },
            if b(x, "has_description") { "✓" } else { "✗" })).collect(),
        "SV201" | "SV303" => arr(&e, "skills").iter().take(5).map(|x| format!(
            "{}  installed {:.0} days  tier1 {}", s(x, "name"),
            f(x, "installed_days_ago"),
            human_tokens(x.get("tier1_tokens").and_then(|v| v.as_i64())))).collect(),
        "SV202" => arr(&e, "skills").iter().take(5).map(|x| format!(
            "{}  {}  {} uses total", s(x, "name"),
            last_used_text(i(x, "usage_count"),
                           x.get("last_used_days_ago").and_then(|v| v.as_f64())),
            i(x, "usage_count"))).collect(),
        "SV301" => arr(&e, "skills").iter().take(5).map(|x| format!(
            "{}  core {} / max {}  ({} lines)", s(x, "name"),
            human_tokens(Some(i(x, "tier2_core_tokens"))),
            human_tokens(Some(i(x, "tier2_max_tokens"))),
            i(x, "body_lines"))).collect(),
        "SV401" => arr(&e, "pairs").iter().take(5).map(|p| format!(
            "{} ↔ {}  Jaccard {:.2}", s(p, "a"), s(p, "b"), f(p, "jaccard"))).collect(),
        c if c.starts_with("SV5") => {
            // 同一个 skill 在磁盘上有多份副本时，每份都会独立命中，打印出来是
            // **一模一样的两行**，看着像重复输出的 bug。合并成 ×N，副本数不丢。
            let mut order: Vec<(String, String, i64, String, bool)> = Vec::new();
            let mut counts: Vec<usize> = Vec::new();
            for h in arr(&e, "hits") {
                let k = (s(h, "skill"), s(h, "where"), i(h, "line"), s(h, "severity"), b(h, "cited"));
                match order.iter().position(|x| *x == k) {
                    Some(idx) => counts[idx] += 1,
                    None => { order.push(k); counts.push(1); }
                }
            }
            order.iter().zip(counts.iter()).take(5).map(|(k, n)| format!(
                "{}  {}:{}  {}{}{}", k.0, k.1, k.2, k.3,
                if k.4 { " (citation-like context)" } else { "" },
                if *n > 1 { format!("  ×{n} copies") } else { String::new() })).collect()
        }
        "SV902" => arr(&e, "skills").iter().take(5).map(|x| s(x, "path")).collect(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_security_rule_has_a_code() {
        // 扫描器有、诊断码表没有的规则，命中后会在 doctor 里静默消失 ——
        // 比没有这条规则更糟。加规则时必须同时加码。
        let rules = agent_vitals_domain::skills::security_rules::rule_names();
        for r in &rules {
            assert!(SECURITY_CODES.iter().any(|(n, _, _)| n == r),
                    "安全规则 {r} 没有诊断码，命中后会静默消失");
        }
        for (n, _, _) in SECURITY_CODES {
            assert!(rules.contains(n), "诊断码映射里的 {n} 没有对应规则，永远不会触发");
        }
    }

    #[test]
    fn codes_are_unique() {
        let mut codes: Vec<&str> = SECURITY_CODES.iter().map(|(_, c, _)| *c).collect();
        codes.sort_unstable();
        let n = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), n, "诊断码撞号");
    }

    #[test]
    fn comma_matches_python_format() {
        assert_eq!(comma(0), "0");
        assert_eq!(comma(999), "999");
        assert_eq!(comma(1000), "1,000");
        assert_eq!(comma(15231), "15,231");
        assert_eq!(comma(1234567), "1,234,567");
    }
}

// ── CI 闸门（ARCHITECTURE §6.2、PRODUCT §5.6）─────────────
//
// 退出码是**对外的正式接口**，不是随手挑的数：
//
//   0   无达到 --fail-on 阈值的发现
//   1   存在达到或超过阈值的发现
//   2   工具自身错误
//
// v0.1 用 `1 = warning` 有坑：1 是 shell 世界默认的泛化失败码，用户随手
// `agent-vitals && echo ok` 会因一条 warning 直接红，很快就有人加 `|| true` ——
// 那等于关掉整个机制。口径对齐 shellcheck / eslint。

pub const EXIT_OK: i32 = 0;
pub const EXIT_FINDINGS: i32 = 1;
pub const EXIT_TOOL_ERROR: i32 = 2;

/// 一条诊断涉及的对象集合，用来判断「这条是不是新出现的」。
///
/// **不按诊断码逐个写规则。**递归收集 evidence 里所有 name / skill 值即可：
/// 同一个码换了个 skill 就是新的一条，而聚合类的码（预算、能力缺失）没有对象
/// 名，集合为空 —— 它们只在**码本身**是新的时候才算新。这样加新诊断码不需要
/// 同步改这里，也就不会漏。
fn diag_instances(d: &Value) -> Vec<String> {
    fn walk(o: &Value, found: &mut Vec<String>) {
        match o {
            Value::Object(m) => {
                for (k, v) in m {
                    match (k.as_str(), v.as_str()) {
                        ("name", Some(x)) | ("skill", Some(x)) if !x.is_empty() => {
                            if !found.contains(&x.to_string()) {
                                found.push(x.to_string());
                            }
                        }
                        _ => walk(v, found),
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    walk(v, found);
                }
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    if let Some(e) = d.get("evidence") {
        walk(e, &mut found);
    }
    found.sort();
    found
}

fn diag_key(d: &Value) -> (String, Vec<String>) {
    (s(d, "code"), diag_instances(d))
}

pub struct GateOpts {
    pub fail_on: String,
    pub ignore: Vec<String>,
}

pub struct GateResult {
    pub code: i32,
    pub kept: usize,
    pub worst: Option<&'static str>,
    pub ignored_hit: Vec<String>,
    pub not_new: usize,
}

/// 算 CI 闸门。
///
/// `--new-only` 比的是**两份扫描各自算出的诊断**，不是「现在有几个问题」。
/// PRODUCT §5.6 的原话：关键是这个 PR 新增了什么。一个仓库存量 40 条 warning，
/// 按存量卡门只会被立刻加上 `|| true`。
pub fn gate(diagnostics: &[Value], o: &GateOpts, baseline: Option<&[Value]>) -> GateResult {
    let mut kept: Vec<&Value> = Vec::new();
    let mut ignored_hit: Vec<String> = Vec::new();
    for d in diagnostics {
        let code = s(d, "code");
        if o.ignore.contains(&code) {
            if !ignored_hit.contains(&code) {
                ignored_hit.push(code);
            }
            continue;
        }
        kept.push(d);
    }
    ignored_hit.sort();

    let mut not_new = 0usize;
    if let Some(base) = baseline {
        let old: Vec<(String, Vec<String>)> = base.iter().map(diag_key).collect();
        let mut fresh = Vec::new();
        for d in kept {
            if old.contains(&diag_key(d)) {
                not_new += 1;
            } else {
                fresh.push(d);
            }
        }
        kept = fresh;
    }

    let worst_rank = kept.iter().map(|d| severity_rank(&s(d, "severity"))).min();
    let worst = worst_rank.map(|r| match r {
        0 => "critical",
        1 => "warning",
        _ => "info",
    });
    let code = if o.fail_on == "none" {
        EXIT_OK
    } else {
        let limit = match o.fail_on.as_str() {
            "critical" => 0u8,
            "warning" => 1,
            _ => 2,
        };
        if worst_rank.map(|r| r <= limit).unwrap_or(false) { EXIT_FINDINGS } else { EXIT_OK }
    };
    GateResult { code, kept: kept.len(), worst, ignored_hit, not_new }
}

/// 闸门结论。**被忽略的码必须打印出来** —— 一个绿灯不能藏着抑制项。
pub fn render_gate(diagnostics: &[Value], o: &GateOpts, baseline: Option<&[Value]>)
    -> (String, i32)
{
    let r = gate(diagnostics, o, baseline);
    let mut w = String::new();
    macro_rules! p {
        ($($t:tt)*) => { w.push_str(&format!($($t)*)); w.push('\n'); };
    }
    p!("");
    p!("CI gate");
    if o.fail_on == "none" {
        p!("  --fail-on none: never fail on any finding (exit code is always 0)");
    } else {
        p!("  threshold --fail-on {}  ·  {} counted  ·  exit code {}", o.fail_on, r.kept, r.code);
        if r.kept > 0 {
            p!("  highest severity {}", r.worst.unwrap_or("info"));
        }
    }
    if baseline.is_some() {
        p!("  --new-only: {} findings identical to the baseline are not counted (only this run's additions are considered)", r.not_new);
    }
    if !o.ignore.is_empty() {
        // 忽略了什么必须显性化。一个不说自己忽略了什么的绿灯，与「没有问题」
        // 在读者眼里是同一个东西。
        let mut ig = o.ignore.clone();
        ig.sort();
        ig.dedup();
        p!("  --ignore {}{}", ig.join(","),
           if r.ignored_hit.is_empty() {
               " (no matches this run)".to_string()
           } else {
               format!(" (matched {})", r.ignored_hit.join(","))
           });
    }
    (w, r.code)
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use serde_json::json;

    fn d(code: &str, sev: &str, names: &[&str]) -> Value {
        json!({
            "code": code, "severity": sev,
            "evidence": {"skills": names.iter().map(|n| json!({"name": n}))
                                       .collect::<Vec<_>>()},
        })
    }
    fn opts(f: &str) -> GateOpts {
        GateOpts { fail_on: f.into(), ignore: vec![] }
    }

    #[test]
    fn threshold_and_exit_codes() {
        let ds = vec![d("SV502", "critical", &["a"]), d("SV301", "warning", &["b"])];
        assert_eq!(gate(&ds, &opts("critical"), None).code, EXIT_FINDINGS);
        assert_eq!(gate(&ds, &opts("warning"), None).code, EXIT_FINDINGS);
        assert_eq!(gate(&ds, &opts("none"), None).code, EXIT_OK);
        // 对照：只剩 warning 时默认阈值放行 —— 否则上面几条可能靠「恒返回 1」通过
        let only_warn = vec![d("SV301", "warning", &["b"])];
        assert_eq!(gate(&only_warn, &opts("critical"), None).code, EXIT_OK);
    }

    #[test]
    fn a_new_instance_of_the_same_code_counts_as_new() {
        // 只按「码有没有出现过」比的话，已经有 pipe_to_shell 的仓库再引入一条
        // 新的会被放行 —— 那正是 CI 最该拦的情况。
        let base = vec![d("SV502", "critical", &["a"])];
        let now = vec![d("SV502", "critical", &["a"]), d("SV502", "critical", &["b"])];
        let r = gate(&now, &opts("critical"), Some(&base));
        assert_eq!(r.code, EXIT_FINDINGS);
        assert_eq!(r.not_new, 1);
        assert_eq!(r.kept, 1);
    }

    #[test]
    fn pre_existing_findings_do_not_fail() {
        let base = vec![d("SV502", "critical", &["a"])];
        let now = vec![d("SV502", "critical", &["a"])];
        assert_eq!(gate(&now, &opts("critical"), Some(&base)).code, EXIT_OK);
    }

    #[test]
    fn ignore_is_reported_even_when_it_matches_nothing() {
        let ds = vec![d("SV502", "critical", &["a"])];
        let o = GateOpts { fail_on: "critical".into(), ignore: vec!["SV999".into()] };
        let (t, code) = render_gate(&ds, &o, None);
        assert_eq!(code, EXIT_FINDINGS);
        assert!(t.contains("(no matches this run)"), "{t}");
    }
}
