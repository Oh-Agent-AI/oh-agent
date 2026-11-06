//! 分析层：从已采集的 skill 记录算出报告里的各个块。
//!
//! **纯函数，不碰文件系统、不起子进程。**输入是采集好的记录，输出是一个
//! 报告块。这条边界是刻意的 —— 分析规则是这个项目真正沉淀下来的东西
//! （ENGINEERING §1.5 称之为 Diagnostic Knowledge），它应当能脱离采集
//! 单独读、单独测、单独移植。
//!
//! 本模块由 main.rs 拆出。**只移动不改写** —— 拆分期间任何一行行为变化
//! 都会被 11 份 golden 逐字节抓住，这正是先建 golden 再重构的意义。

use serde_json::{json, Map, Value};

use crate::domain::util::{b, chars, i, pyround, s};
use crate::domain::skills::ranking::{conflict_rank, level_rank, severity_rank,
                                      CODEX_FALLBACK_DESC_BUDGET};

/// 同名 skill 的副本。
pub fn conflicts(scope: &[Value], groups: &[(String, Vec<usize>)]) -> Vec<Value> {
// ── 同名 skill 的副本 ─────────────────────────────────
// 按 (namespace, name) 去重：插件里的 skill 有命名空间隔离，
// discord:access 和 telegram:access 不是冲突。


let mut conflicts: Vec<Value> = Vec::new();
for (_, idxs) in groups {
    if idxs.len() < 2 {
        continue;
    }
    let mut ranked: Vec<&Value> = idxs.iter().map(|&i| &scope[i]).collect();
    ranked.sort_by_key(|x| level_rank(x)); // 稳定排序
    let winner = ranked[0];
    let losers = &ranked[1..];

    let mut hashes: Vec<String> = ranked.iter().map(|x| s(x, "content_hash")).collect();
    hashes.sort();
    hashes.dedup();
    let identical = hashes.len() == 1;

    let (kind, severity) = if identical {
        ("redundant", "low")
    } else {
        // Python 的 max() 返回**第一个**最大值；Rust 的 max_by_key 返回最后一个。
        // 这里显式取第一个，否则并列时选到的副本不同，报告里的路径就变了。
        let mut newer = losers[0];
        for l in losers.iter().skip(1) {
            if i(l, "mtime") > i(newer, "mtime") {
                newer = l;
            }
        }
        if i(newer, "mtime") > i(winner, "mtime") {
            ("shadowed_newer", "high")
        } else {
            ("intentional_override", "medium")
        }
    };

    conflicts.push(json!({
        "harness": s(winner, "harness_family"),
        "instance_id": winner.get("instance_id").cloned().unwrap_or(Value::Null),
        "conflict_domain": s(winner, "conflict_domain"),
        "name": s(winner, "name"),
        "kind": kind,
        "severity": severity,
        "effective": {
            "level": s(winner, "level"),
            "path": s(winner, "path"),
            "hash": s(winner, "content_hash"),
            "mtime": i(winner, "mtime"),
        },
        "shadowed": losers.iter().map(|x| json!({
            "level": s(x, "level"),
            "path": s(x, "path"),
            "hash": s(x, "content_hash"),
            "mtime": i(x, "mtime"),
        })).collect::<Vec<_>>(),
    }));
}
conflicts.sort_by_key(|c| conflict_rank(&s(c, "severity")));
    conflicts
}

/// 结构：谁该拆。返回 (报告块, oversized 计数)。
pub fn structure(
    loaded: &[&Value],
    analysis_candidates: &[&Value],
    split_threshold: i64,
) -> (Map<String, Value>, usize) {
// ── 结构：谁该拆 ─────────────────────────────────────
// 判据是 token 不是行数。实测同一库内密度能差 4 倍以上，
// 按行数给拆分建议会把结论给反（不变量 6）。
// **只有 oversized 用 analysis_candidates**，其余三项仍按 loaded。
// 这种不对称容易在移植时被"顺手抹平"：拆分建议要覆盖 OpenClaw 那批
// 未经运行时证实的 skill（它们的成本是真实的），而缺 frontmatter、
// 已拆分、数据语料三项讲的是"已经在上下文里的东西长什么样"。
let mut oversized: Vec<&&Value> = analysis_candidates
    .iter()
    .filter(|s| i(s, "tier2_core_tokens") > split_threshold)
    .collect();
oversized.sort_by_key(|s| -i(s, "tier2_core_tokens"));

let mut already_split: Vec<&&Value> = loaded.iter().collect();
already_split.sort_by_key(|s| -i(s, "tier2_refs_tokens"));

let mut corpus: Vec<&&Value> = loaded.iter().collect();
corpus.sort_by_key(|s| -i(s, "data_corpus_bytes"));

let mut structure = Map::new();
structure.insert("split_threshold_tokens".into(), json!(split_threshold));
structure.insert(
    "criterion".into(),
    json!("tier2_core_tokens (SKILL.md body); line count is reference only"),
);
structure.insert(
    "oversized".into(),
    json!(oversized
        .iter()
        .map(|s_| json!({
            "name": s(s_, "name"), "path": s(s_, "path"),
            "tier2_core_tokens": i(s_, "tier2_core_tokens"),
            "tier2_refs_tokens": i(s_, "tier2_refs_tokens"),
            "tier2_max_tokens": i(s_, "tier2_max_tokens"),
            "body_lines": i(s_, "body_lines"),
            "tokens_per_line": pyround(
                i(s_, "tier2_core_tokens") as f64 / i(s_, "body_lines").max(1) as f64, 1),
            "pct_of_200k_if_fully_read": pyround(
                i(s_, "tier2_max_tokens") as f64 / 200000.0 * 100.0, 2),
        }))
        .collect::<Vec<_>>()),
);
structure.insert(
    "missing_frontmatter".into(),
    json!(loaded
        .iter()
        .filter(|s_| !(b(s_, "has_name") && b(s_, "has_description")))
        .map(|s_| json!({
            "name": s(s_, "name"), "path": s(s_, "path"),
            "has_name": b(s_, "has_name"), "has_description": b(s_, "has_description"),
        }))
        .collect::<Vec<_>>()),
);
structure.insert(
    "already_split".into(),
    json!(already_split
        .iter()
        .filter(|s_| i(s_, "tier2_refs_tokens") > 0)
        .map(|s_| json!({
            "name": s(s_, "name"),
            "core": i(s_, "tier2_core_tokens"),
            "refs": i(s_, "tier2_refs_tokens"),
            "refs_files": i(s_, "tier2_refs_files"),
            "max": i(s_, "tier2_max_tokens"),
        }))
        .collect::<Vec<_>>()),
);
structure.insert(
    "large_data_corpus".into(),
    json!(corpus
        .iter()
        .filter(|s_| i(s_, "data_corpus_bytes") > 1048576)
        .map(|s_| json!({
            "name": s(s_, "name"),
            "files": i(s_, "data_corpus_files"),
            "mb": pyround(i(s_, "data_corpus_bytes") as f64 / 1048576.0, 1),
        }))
        .collect::<Vec<_>>()),
);
structure.insert("note".into(), json!(
    "oversized is based on core, which is always loaded on trigger. max in already_split \
is the full-read cost; splitting lowers average cost, not worst-case cost. \
large_data_corpus contains searchable Markdown corpora and is excluded from tier2; \
the report should mention its size only."));
    let n = oversized.len();
    (structure, n)
}

/// 安全汇总。返回 (报告块, flagged 条数, 全部命中疑似引用语境的条数)。
pub fn security(skills: &[Value]) -> (Map<String, Value>, usize, usize) {
// ── 安全汇总 ─────────────────────────────────────────
// 所有有命中的都上报，cited 与否只决定排序先后，不决定是否出现（不变量 4）。
let sev = |x: &Value, k: &str| -> String { s(&x["security"], k) };
let mut flagged: Vec<&Value> = skills
    .iter()
    .filter(|x| sev(x, "max_severity") != "none")
    .collect();
flagged.sort_by_key(|x| {
    (
        severity_rank(&sev(x, "max_severity_uncited")),
        severity_rank(&sev(x, "max_severity")),
        !b(x, "loaded"),
    )
});

let mut security_report = Map::new();
security_report.insert("flagged_count".into(), json!(flagged.len()));
security_report.insert(
    "critical_count".into(),
    json!(flagged.iter().filter(|x| sev(x, "max_severity") == "critical").count()),
);
security_report.insert(
    "critical_uncited_count".into(),
    json!(flagged
        .iter()
        .filter(|x| sev(x, "max_severity_uncited") == "critical")
        .count()),
);
security_report.insert(
    "all_cited_count".into(),
    json!(flagged
        .iter()
        .filter(|x| x["security"]["all_findings_cited"].as_bool() == Some(true))
        .count()),
);
security_report.insert(
    "fetches_external_count".into(),
    json!(skills
        .iter()
        .filter(|x| x["security"]["external_url_count"].as_i64().unwrap_or(0) > 0)
        .count()),
);
security_report.insert(
    "with_scripts_count".into(),
    json!(skills
        .iter()
        .filter(|x| !x["security"]["exec_scripts"]
            .as_array()
            .map_or(true, |a| a.is_empty()))
        .count()),
);
security_report.insert(
    "flagged".into(),
    json!(flagged
        .iter()
        .take(30)
        .map(|x| json!({
            "name": s(x, "name"), "path": s(x, "path"), "loaded": b(x, "loaded"),
            "severity": sev(x, "max_severity"),
            "severity_uncited": sev(x, "max_severity_uncited"),
            "all_findings_cited": x["security"]["all_findings_cited"],
            "findings": x["security"]["findings"],
        }))
        .collect::<Vec<_>>()),
);
security_report.insert("note".into(), json!(
    "These are heuristic findings, not proof of malicious behavior, and false negatives \
are possible. The scanner's own files are excluded. cited=true only means the match \
looks like a quotation, example, or defensive explanation; it affects ordering only \
and never lowers severity or suppresses reporting. This hint is easy to bypass by \
adding 'For example,' or an unmatched quote on the same line, so it must never be \
treated as a safety verdict. Every finding includes a line number and requires manual review."));
    let n = flagged.len();
    let cited = flagged
        .iter()
        .filter(|x| x["security"]["all_findings_cited"].as_bool() == Some(true))
        .count();
    (security_report, n, cited)
}

/// 描述预算。返回 (报告块, 供摘要行用的可用性)。
///
/// **Claude Code / Codex 专有。**默认的多执行环境模式下不给总数 —— 把互不共享
/// 的上下文加起来没有意义，只会被误读。
pub fn budget(
    unique: &[&Value],
    harness: &str,
    all_scope: bool,
    budget: i64,
) -> Map<String, Value> {
// ── 描述预算 ─────────────────────────────────────────
// Claude Code 把 name+description 拼成列表注入系统提示，有硬预算。
// 超出后静默丢弃描述（据报从调用最少的开始），无告警。
// Codex 没有 SLASH_COMMAND_TOOL_CHAR_BUDGET，用实测的回退值；
// 且它的列表里还带 path，字符数要一并算进去。
let is_codex_budget = harness == "codex";
let is_dsh_budget = harness == "dsh";
let effective_budget = if is_codex_budget { CODEX_FALLBACK_DESC_BUDGET } else { budget };
let desc_chars: i64 = unique
    .iter()
    .map(|v| {
        (chars(v, "description")
            + chars(v, "name")
            + 4
            + if is_codex_budget { chars(v, "path") + 1 } else { 0 }) as i64
    })
    .sum();
let over = desc_chars - effective_budget;

let mut longest: Vec<&&Value> = unique.iter().collect();
longest.sort_by_key(|v| -(chars(v, "description") as i64)); // 稳定

// 「超预算后从调用最少的开始丢弃」是**传闻不是实测**，所以这里给的只是一个
// 按描述长度排出来的风险区间，不是「这几条被丢了」的判定。
//
// 区间的**名单和条数出自同一次累加**。曾经只报条数，`explain` 想标出
// 「这一条在风险区间里」就得自己再算一遍 —— 而它手上只有被截断到前 5 条的
// longest_descriptions，口径立刻就对不上（一个说 2 条，一个说 4 条）。
let mut at_risk_skills: Vec<String> = Vec::new();
if over > 0 {
    let mut acc = 0i64;
    for v in &longest {
        at_risk_skills.push(s(v, "name").to_string());
        acc += chars(v, "description") as i64;
        if acc >= over {
            break;
        }
    }
}
let at_risk = at_risk_skills.len();

let longest_descriptions: Vec<Value> = longest
    .iter()
    .take(5)
    .map(|v| json!({"name": s(v, "name"), "chars": chars(v, "description")}))
    .collect();

let mut budget_report = Map::new();
// 描述预算是 Claude Code / Codex 专有的。默认的多执行环境模式下**不给总数** ——
// 把互不共享的上下文加起来没有意义，只会被误读（见 cross_harness_note）。
budget_report.insert(
    "available".into(),
    json!(harness == "claude-code" || harness == "codex"),
);
budget_report.insert(
    "scope".into(),
    json!(if all_scope { "all-on-disk" } else { "loaded-only" }),
);
budget_report.insert("counted_skills".into(), json!(unique.len()));
budget_report.insert("budget_chars".into(), json!(effective_budget));
budget_report.insert("used_chars".into(), json!(desc_chars));
budget_report.insert(
    "pct_used".into(),
    if effective_budget != 0 {
        json!(pyround(desc_chars as f64 / effective_budget as f64 * 100.0, 1))
    } else {
        Value::Null
    },
);
budget_report.insert("over_by_chars".into(), json!(over.max(0)));
budget_report.insert("skills_possibly_dropped".into(), json!(at_risk));
budget_report.insert("at_risk_skills".into(), json!(at_risk_skills));
budget_report.insert("longest_descriptions".into(), json!(longest_descriptions));
budget_report.insert("excludes_builtin_skills".into(), json!(true));
budget_report.insert(
    "policy".into(),
    json!(if is_codex_budget {
        "Codex initial skill list: at most 2% of model context, or 8000 chars \
when context is unknown"
    } else if is_dsh_budget {
        "DSH catalogDescriptionMaxLength (default 500) per-description truncation"
    } else {
        "Claude Code SLASH_COMMAND_TOOL_CHAR_BUDGET"
    }),
);
budget_report.insert("note".into(), json!(if is_codex_budget {
    "The official Codex calculation includes name, description, and path. skills/list \
does not expose the current model context window, so this report uses the official \
8,000-character fallback. Codex shortens descriptions first, then omits skills with \
a warning if the limit is still exceeded."
} else if is_dsh_budget {
    "no global description budget: DSH truncates each description at \
catalogDescriptionMaxLength (default 500) instead of concatenating them into one \
budgeted list. The truncation threshold is deployment-configurable and read from \
runtime evidence; never hardcode 500."
} else {
    "Claude Code budget semantics vary by version. This value comes from the environment \
or the 15,000-character default and excludes built-in skills without a SKILL.md on disk."
}));
budget_report.insert(
    "workaround".into(),
    if is_codex_budget { Value::Null } else { json!("SLASH_COMMAND_TOOL_CHAR_BUDGET=30000") },
);

// 预算不可用时把每一个数字都置空。**不是留着旧值** ——
// 这是 Claude Code 专属的配置与阈值，其他执行环境没有等价、可验证的口径，
// 留一个看似合理的数字比留 null 危险得多（不变量 12）。
if budget_report["available"] != json!(true) {
    for k in ["counted_skills", "budget_chars", "used_chars", "pct_used",
              "over_by_chars", "skills_possibly_dropped", "excludes_builtin_skills",
              "workaround"] {
        budget_report.insert(k.into(), Value::Null);
    }
    budget_report.insert("scope".into(), json!("not-available"));
    budget_report.insert("at_risk_skills".into(), json!([]));
    budget_report.insert("longest_descriptions".into(), json!([]));
}
    budget_report
}

/// 触发数据。返回 (报告块, 是否可用)。
///
/// 只有 Claude Code 有（`~/.claude.json -> skillUsage`）。**拿不到时范围为空**
/// —— 不能拿「没有记录」当「零触发」，那会把所有 skill 报成僵尸。
pub fn trigger(
    loaded: &[&Value],
    usage_len: usize,
    usage_empty: bool,
    harness: &str,
    zombie_age: i64,
    dsh_evidence: Option<&Value>,
    dsh_evidence_path: Option<&str>,
) -> (Map<String, Value>, bool) {
    if harness == "dsh" {
        let report = trigger_dsh(loaded, zombie_age, dsh_evidence, dsh_evidence_path);
        let available = report.get("available").and_then(|v| v.as_bool()) == Some(true);
        return (report, available);
    }
// ── 触发数据 ─────────────────────────────────────────
// 触发数据只有 Claude Code 有（~/.claude.json -> skillUsage）。
let trigger_available = harness == "claude-code" && !usage_empty;
// 拿不到触发数据时范围为空 —— 不能拿「没有记录」当「零触发」，
// 那会把所有 skill 报成僵尸（不变量 12）。
let empty_scope: Vec<&Value> = Vec::new();
let trigger_scope: &[&Value] = if trigger_available { loaded } else { &empty_scope };
let zombies: Vec<&&Value> = trigger_scope
    .iter()
    .filter(|s| {
        i(s, "usage_count") == 0
            && s.get("installed_days_ago").and_then(|v| v.as_f64()).unwrap_or(0.0)
                >= zombie_age as f64
    })
    .collect();
let too_new: Vec<&&Value> = trigger_scope
    .iter()
    .filter(|s| {
        i(s, "usage_count") == 0
            && s.get("installed_days_ago").and_then(|v| v.as_f64()).unwrap_or(0.0)
                < zombie_age as f64
    })
    .collect();

let mut zsorted = zombies.clone();
zsorted.sort_by_key(|x| -i(x, "tier1_tokens"));
let mut nsorted = too_new.clone();
nsorted.sort_by(|a, b| {
    let (x, y) = (
        a.get("installed_days_ago").and_then(|v| v.as_f64()).unwrap_or(0.0),
        b.get("installed_days_ago").and_then(|v| v.as_f64()).unwrap_or(0.0),
    );
    x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
});

let mut trigger_report = Map::new();
trigger_report.insert("available".into(), json!(trigger_available));
trigger_report.insert("source".into(), json!("~/.claude.json -> skillUsage"));
trigger_report.insert("entries_in_harness_record".into(), json!(usage_len));
trigger_report.insert(
    "counts_are".into(),
    json!("lifetime cumulative, not last-30-days"),
);
trigger_report.insert("zombie_min_age_days".into(), json!(zombie_age));
trigger_report.insert(
    "zombie_candidates".into(),
    json!(zsorted
        .iter()
        .map(|x| json!({
            "name": s(x, "name"), "path": s(x, "path"),
            "installed_days_ago": x.get("installed_days_ago").cloned().unwrap_or(Value::Null),
            "tier1_tokens": i(x, "tier1_tokens"),
        }))
        .collect::<Vec<_>>()),
);
trigger_report.insert(
    "too_new_to_judge".into(),
    json!(nsorted
        .iter()
        .map(|x| json!({
            "name": s(x, "name"),
            "installed_days_ago": x.get("installed_days_ago").cloned().unwrap_or(Value::Null),
        }))
        .collect::<Vec<_>>()),
);
trigger_report.insert("note".into(), json!(format!(
    "Zero triggers are actionable only after {} installed days. Do not classify \
too_new_to_judge entries as zombies.",
    zombie_age
)));
    (trigger_report, trigger_available)
}

/// DSH 的触发证据（A9）：换源到会话日志，口径与 claude-code 的 skillUsage 不同。
///
/// skillUsage 是终身累计计数；DSH 会话日志把触发证据拆成**用户显式调用**
/// （skill-invocation）与**模型选中加载**（tool/call name="skill"）两类，所以
/// 零触发可以分解成「从未被选中」与「从未被调用」。拿不到证据（未设环境变量 /
/// degraded）一律 unavailable，**绝不报 0 次**——报 0 次会伪造出假的 SV201。
fn trigger_dsh(
    loaded: &[&Value],
    zombie_age: i64,
    dsh_evidence: Option<&Value>,
    dsh_evidence_path: Option<&str>,
) -> Map<String, Value> {
    let source = match dsh_evidence_path {
        Some(p) => format!("AGENT_VITALS_DSH_SESSION_LOG -> {}", p),
        None => "AGENT_VITALS_DSH_SESSION_LOG (not set)".to_string(),
    };
    let degraded = dsh_evidence.and_then(|e| e.get("degraded")).and_then(|d| d.as_str());

    let mut invoked_map = Map::new();
    let mut selected_map = Map::new();
    let mut never_selected: Vec<String> = Vec::new();
    let mut never_invoked: Vec<String> = Vec::new();

    let (available, evidence, counts_are, note): (bool, String, String, String) =
        match (dsh_evidence, degraded) {
            (None, _) => (
                false,
                "none".to_string(),
                "unavailable: no session-log evidence".to_string(),
                "No DSH session-log evidence is available; trigger data is \
reported unavailable, never a fabricated zero count."
                    .to_string(),
            ),
            (Some(_), Some(reason)) => (
                false,
                format!("degraded:{}", reason),
                "unavailable: session log degraded".to_string(),
                format!(
                    "DSH session-log evidence is degraded ({}); trigger data is \
reported unavailable, never a fabricated zero count.",
                    reason
                ),
            ),
            (Some(ev), None) => {
                let mut names: Vec<String> = loaded.iter().map(|x| s(x, "name")).collect();
                names.sort();
                names.dedup();
                let invoked = ev.get("invoked").and_then(|v| v.as_array());
                let selected = ev.get("selected").and_then(|v| v.as_array());
                for name in &names {
                    let ic = invoked
                        .map(|l| l.iter().filter(|x| x.as_str() == Some(name.as_str())).count() as i64)
                        .unwrap_or(0);
                    let sc = selected
                        .map(|l| l.iter().filter(|x| x.as_str() == Some(name.as_str())).count() as i64)
                        .unwrap_or(0);
                    invoked_map.insert(name.clone(), json!(ic));
                    selected_map.insert(name.clone(), json!(sc));
                    if sc == 0 {
                        never_selected.push(name.clone());
                    }
                    if ic == 0 {
                        never_invoked.push(name.clone());
                    }
                }
                (
                    true,
                    "session-log".to_string(),
                    "session-log invocation and selection events (not lifetime skillUsage)".to_string(),
                    "Zero triggers decompose into never-selected vs never-invoked: \
the session log separates user-explicit invocation \
(skill-invocation) from model-selected load (tool/call name=skill)."
                        .to_string(),
                )
            }
        };

    // never_triggered = 「既没被选中、也没被调用」，是 never_selected 与
    // never_invoked 的**交集**——只有从未以任何形式进入上下文的 skill 才算零触发，
    // 这是僵尸判定的最终输入（`never_selected` 里的 skill 可能被显式调用过，
    // `never_invoked` 里的可能被模型选中加载过，单独看都不是「从没被用过」）。
    // 拿不到证据时是空列表：available=false 时上面两个列表本来就是空，交集自然空。
    let never_triggered: Vec<String> = if available {
        never_selected
            .iter()
            .filter(|n| never_invoked.contains(n))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };

    let mut report = Map::new();
    report.insert("available".into(), json!(available));
    report.insert("source".into(), json!(source));
    report.insert("evidence".into(), json!(evidence));
    report.insert("counts_are".into(), json!(counts_are));
    report.insert("zombie_min_age_days".into(), json!(zombie_age));
    report.insert("invoked_counts".into(), json!(invoked_map));
    report.insert("selected_counts".into(), json!(selected_map));
    report.insert("never_selected".into(), json!(never_selected));
    report.insert("never_invoked".into(), json!(never_invoked));
    report.insert("never_triggered".into(), json!(never_triggered));
    report.insert("note".into(), json!(note));
    report
}

/// 按执行环境的分项。
///
/// **上下文属于各自执行环境**，不能把 Codex、Claude Code 等的数值相加后当成
/// 一个窗口 —— 这与顶层预算在多执行环境模式下报 not-available 是同一条理由。
///
/// `budget_chars` 是 claude-code 侧生效的描述预算（CLI `--budget`，含默认值）；
/// `dsh_trigger_available` 由调用方从 DSH 会话日志证据算出（有证据且未 degraded），
/// 本函数不重复解释证据。
///
/// `description_budget`（字符串状态）之后追加了 `description_budget_detail`
/// （逐执行环境数字）：多执行环境模式下顶层预算恒不可用（分母不同的量相加就是编造），
/// 而按执行环境给出自己的 used/budget 是**并列不是合并** —— 每个执行环境一条、各用
/// 各的分母。没有预算的执行环境 `available:false` 且数字全 null，绝不冒充 0。
pub fn harness_summaries(
    skills: &[Value],
    usage_empty: bool,
    codex_available: bool,
    openclaw_available: bool,
    budget_chars: i64,
    dsh_trigger_available: bool,
) -> Map<String, Value> {
let mut harness_summaries = Map::new();
for family in ["claude-code", "codex", "openclaw", "hermes", "workbuddy", "dsh"] {
    let harness_skills: Vec<&Value> = skills
        .iter()
        .filter(|x| s(x, "harness_family") == family)
        .collect();
    let harness_loaded: Vec<&&Value> = harness_skills.iter().filter(|x| b(x, "loaded")).collect();
    let harness_discoverable: Vec<&&Value> =
        harness_skills.iter().filter(|x| b(x, "discoverable")).collect();
    let summary_scope: &Vec<&&Value> = if family == "openclaw" {
        &harness_discoverable
    } else {
        &harness_loaded
    };

    // 按 (instance_id, namespace, name) 分组，组内取优先级最高的那份
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<&Value>> = Default::default();
    for x in summary_scope.iter() {
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            x.get("instance_id").and_then(|v| v.as_str()).unwrap_or(""),
            s(x, "namespace"),
            s(x, "name")
        );
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(x);
    }
    let harness_unique: Vec<&Value> = order
        .iter()
        .filter_map(|k| {
            let mut g = groups.get(k)?.clone();
            g.sort_by_key(|x| level_rank(x)); // 稳定排序
            g.first().copied()
        })
        .collect();

    // 这个执行环境**有没有运行时证据可拿**。
    //
    // Claude Code / Hermes / WorkBuddy 压根没有逐 skill 的运行时接口可问，
    // Codex 与 OpenClaw 有但可能探测失败。两种情况下面两个计数都必须是
    // **null 而不是 0** —— 0 读起来是「问到了，是零个」，真相是「问不到」。
    let runtime_evidence = match family {
        "codex" => codex_available,
        "openclaw" => openclaw_available,
        _ => false,
    };

    // 「有几个 unique skill 拿到了运行时证据」。**按组内任一副本算**：
    // 证据属于 skill，不属于某一份副本 —— Codex 按路径匹配，可能只标中
    // 被遮蔽的那份，此时说「没有证据」是错的。
    let mut verified_keys: Vec<String> = summary_scope
        .iter()
        .filter(|x| b(x, "runtime_verified"))
        .map(|x| {
            format!(
                "{}\u{0}{}\u{0}{}",
                x.get("instance_id").and_then(|v| v.as_str()).unwrap_or(""),
                s(x, "namespace"),
                s(x, "name")
            )
        })
        .collect();
    verified_keys.sort();
    verified_keys.dedup();

    // 逐执行环境预算明细。口径与 `budget()` 同一套：name+description+4（Codex 另加
    // path+1，它的列表带路径），分母是**该执行环境自己的**（claude-code 可配置 /
    // Codex 官方 8k 回退），只在本执行环境的 unique 集上累加 —— 不与任何其他执行环境
    // 相加。没有预算口径的执行环境（openclaw 的「可配」无实测分母、dsh 逐条截断、
    // workbuddy/hermes 无此概念）available=false、数字全 null。
    let budget_detail = if family == "claude-code" || (family == "codex" && codex_available) {
        let is_codex = family == "codex";
        let denom = if is_codex { CODEX_FALLBACK_DESC_BUDGET } else { budget_chars };
        let used: i64 = harness_unique
            .iter()
            .map(|v| {
                (chars(v, "description")
                    + chars(v, "name")
                    + 4
                    + if is_codex { chars(v, "path") + 1 } else { 0 }) as i64
            })
            .sum();
        json!({
            "available": true,
            "source": if is_codex { "official-estimate" } else { "configurable" },
            "budget_chars": denom,
            "used_chars": used,
            "pct_used": if denom != 0 {
                json!(pyround(used as f64 / denom as f64 * 100.0, 1))
            } else { Value::Null },
            "counted_skills": harness_unique.len(),
        })
    } else {
        json!({
            "available": false,
            "source": if family == "openclaw" { "configurable" } else { "not-available" },
            "budget_chars": Value::Null,
            "used_chars": Value::Null,
            "pct_used": Value::Null,
            "counted_skills": Value::Null,
        })
    };

    harness_summaries.insert(
        family.into(),
        json!({
            "skills_on_disk": harness_skills.len(),
            "discoverable_skills": harness_discoverable.len(),
            "runtime_verified_loaded_skills": if runtime_evidence {
                json!(harness_skills.iter()
                    .filter(|x| b(x, "runtime_verified") && b(x, "loaded")).count())
            } else { Value::Null },
            "runtime_verified_unique_skills": if runtime_evidence {
                json!(verified_keys.len())
            } else { Value::Null },
            "unique_discoverable_skills": harness_unique.len(),
            "tier1_total_tokens": harness_unique.iter().map(|x| i(x, "tier1_tokens")).sum::<i64>(),
            "description_budget": if family == "claude-code" { "available" }
                else if family == "codex" && codex_available { "official-estimate" }
                else if family == "openclaw" { "configurable" }
                else { "not-available" },
            "description_budget_detail": budget_detail,
            "trigger_data": if (family == "claude-code" && !usage_empty)
                || (family == "dsh" && dsh_trigger_available) { "available" }
                else { "not-available" },
        }),
    );
}
    harness_summaries
}

/// OpenClaw 逐实例汇总。
///
/// `runtime_catalog_skills` 在探测不到时是 **null 而不是 0** ——
/// 「问不到」与「问到了，是零个」在报告里含义完全不同（不变量 12）。
pub fn openclaw_instances(
    skills: &[Value],
    runtime_catalog: &[(Option<String>, usize)],
) -> Map<String, Value> {
let mut oc_instances = Map::new();
let mut instance_ids: Vec<String> = skills
    .iter()
    .filter(|x| s(x, "harness_family") == "openclaw")
    .filter_map(|x| x.get("instance_id").and_then(|v| v.as_str()).map(String::from))
    .collect();
instance_ids.sort();
instance_ids.dedup();
for id in instance_ids {
    let inst: Vec<&Value> = skills
        .iter()
        .filter(|x| s(x, "harness_family") == "openclaw"
            && x.get("instance_id").and_then(|v| v.as_str()) == Some(id.as_str()))
        .collect();
    let disc: Vec<&&Value> = inst.iter().filter(|x| b(x, "discoverable")).collect();
    let mut names: Vec<String> = disc
        .iter()
        .map(|x| format!("{}\u{0}{}", s(x, "namespace"), s(x, "name")))
        .collect();
    names.sort();
    names.dedup();
    let rt = runtime_catalog
        .iter()
        .find(|(iid, _)| iid.as_deref() == Some(id.as_str()));
    oc_instances.insert(id.clone(), json!({
        "instance_root": inst.iter().find_map(|x| x.get("instance_root")
            .filter(|v| !v.is_null()).cloned()).unwrap_or(Value::Null),
        "config_path": inst.iter().find_map(|x| x.get("config_path")
            .filter(|v| !v.is_null()).cloned()).unwrap_or(Value::Null),
        "skills_on_disk": inst.len(),
        "discoverable_skills": disc.len(),
        "unique_discoverable_skills": names.len(),
        "explicitly_disabled": disc.iter()
            .filter(|x| x.get("enabled_state") == Some(&json!(false))).count(),
        "enabled_unknown": disc.iter()
            .filter(|x| x.get("enabled_state").map_or(true, |v| v.is_null())).count(),
        "runtime_verified": disc.iter().filter(|x| b(x, "runtime_verified")).count(),
        // 探测不到时是 null，**不是 0** —— 「问不到」与「问到了，是零个」
        // 在报告里含义完全不同（不变量 12）。
        "runtime_catalog_skills": rt.map(|(_, n)| json!(n)).unwrap_or(Value::Null),
        "runtime_semantics": if rt.is_some() {
            "eligible/model-visible metadata; full SKILL.md body load unknown"
        } else {
            "filesystem candidates; runtime unavailable"
        },
        "tier1_candidate_tokens": disc.iter().map(|x| i(x, "tier1_tokens")).sum::<i64>(),
    }));
}
    oc_instances
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `never_triggered` 是 `never_selected ∩ never_invoked`，**不是**它们俩的并集
    /// 也不是单独某一个。Rust 曾经漏掉这个字段 —— 它在 Python 里有、Rust 里 0 处，
    /// `differential` 之所以绿只是因为 DSH 的触发数据从没进过 golden。这条钉住
    /// 交集的判别语义：被显式调用过（在 invoked 里）或被模型选中过（在 selected 里）
    /// 的 skill 都不算「零触发」。
    #[test]
    fn never_triggered_is_the_intersection_not_either_list() {
        let skills = [
            json!({"name": "a"}),
            json!({"name": "b"}),
            json!({"name": "c"}),
            json!({"name": "d"}),
        ];
        let loaded: Vec<&Value> = skills.iter().collect();
        let evidence = json!({"invoked": ["a"], "selected": ["b"]});

        let report = trigger_dsh(&loaded, 14, Some(&evidence), Some("/tmp/s.jsonl"));

        assert_eq!(report.get("available"), Some(&json!(true)));
        // never_selected：没被模型选中 —— b 被选中，排除
        assert_eq!(report.get("never_selected"), Some(&json!(["a", "c", "d"])));
        // never_invoked：没被显式调用 —— a 被调用，排除
        assert_eq!(report.get("never_invoked"), Some(&json!(["b", "c", "d"])));
        // 交集：只有 c、d 两者都不是 —— 这才是「从没被用过」
        assert_eq!(report.get("never_triggered"), Some(&json!(["c", "d"])));
    }

    /// 拿不到证据时 `never_triggered` 是空列表（不是 null，也不是全集）。这个
    /// 三元组与 available=false 时 never_selected/never_invoked 本来就空，交集
    /// 自然空 —— 若把它写成 null 或全集，报告又会把「问不到」读成「零个」或
    /// 「全部僵尸」。
    #[test]
    fn never_triggered_is_empty_when_unavailable() {
        let report = trigger_dsh(&[], 14, None, None);
        assert_eq!(report.get("available"), Some(&json!(false)));
        assert_eq!(report.get("never_selected"), Some(&json!([])));
        assert_eq!(report.get("never_invoked"), Some(&json!([])));
        assert_eq!(report.get("never_triggered"), Some(&json!([])));
    }
}
