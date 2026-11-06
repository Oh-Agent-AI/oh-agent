//! 把「扫到的东西」变成「一份报告」—— 纯数据变换，不碰文件系统、不碰进程。
//!
//! 从 main.rs 拆出来的理由不是行数，是**复用**：`doctor` / `explain` 要的
//! 是同一份报告的不同切面，不是各自再算一遍。算两遍就会有两套口径，
//! 而这个程序最重要的一条口径（磁盘 ≠ 上下文）恰恰最容易在第二遍里走样。
//!
//! 边界：输入全部是已经采集好的证据（skills、运行时探测结果、执行环境配置），
//! 输出是一个 `Value` 加几个供摘要行用的计数。**这里不做任何 I/O** ——
//! 于是它可以被任何命令调用，也可以在测试里直接喂构造好的输入。
//!
//! `diff` 与 `redact` 不在这里：它们是对成品报告的后处理，顺序由调用方决定
//! （必须先 diff 后 redact —— 反过来会拿脱敏后的名字去比对基线）。

use std::path::PathBuf;

use serde_json::{json, Map, Value};

use agent_vitals_domain::skills::analysis;
use agent_vitals_runtime::skills::scanner::group_by_key;
use agent_vitals_harnesses::harnesses::claude_code::skills::HarnessConfig;
use agent_vitals_runtime::skills::inventory::Inventory;
use crate::util::{norm, pyround};
use crate::{b, i, s};

/// 输出 JSON 的 schema 版本。**与工具版本无关**：工具可以升版而 schema 不变。
///
/// 兼容性策略见 ARCHITECTURE §2.3：字段只增不删不改语义，破坏性变更升主版本。
///
/// 「1.0」是第一个带版本号的版本。在它之前的输出没有版本字段，而那段时间
/// schema 改过好几次 —— **没有版本号的 schema 等于没有契约**。
pub const SCHEMA_VERSION: &str = "1.0";

/// 报告的输入只有两样：命令行给的口径，和采集阶段问到的事实。
///
/// **不接受任何「顺手算好的中间量」**——那会让同一个数存在两个来源，
/// 而这个程序最容易出错的地方正是同一件事被算了两遍。
pub struct ReportInput<'a> {
    pub harness: &'a str,
    pub all: bool,
    pub budget: i64,
    pub zombie_age: i64,
    pub split_threshold: i64,
    pub home_n: &'a str,
    pub inv: &'a Inventory,
    pub cfg: &'a HarnessConfig,
}

/// 报告本体，外加摘要行需要的几个计数。
///
/// 这些计数**不从 doc 里再解析一遍**：它们在组装过程中已经算出来了，
/// 回头去 `doc["structure"]["oversized"].len()` 取一次等于把同一件事
/// 表达两遍，schema 一改就断。
pub struct Report {
    pub doc: Value,
    pub disk: usize,
    pub loaded: usize,
    pub tier1_total: i64,
    pub trigger_available: bool,
    pub oversized: usize,
    pub flagged: usize,
    pub all_cited: usize,
}

pub fn build(inp: &ReportInput) -> Report {
    let inv = inp.inv;
    let cfg = inp.cfg;
    let skills = &inv.skills[..];

    let loaded: Vec<&Value> = skills.iter().filter(|s| b(s, "loaded")).collect();
    // 预算和冲突只看真的进上下文的那批。这是本程序最重要的一条口径。
    //
    // 但 OpenClaw 要放宽一档：它的 loaded 需要运行时证实，探测不到时全是
    // false，若按 loaded 取范围，整个 OpenClaw 实例会从冲突与预算分析里
    // 消失 —— 用户看到的是「没问题」，而不是「没证实」。所以对它取
    // discoverable。这条差异只在真的装了 OpenClaw 时显形，语料里没有实例，
    // 两种写法恒等，golden 抓不到；是真机差分发现的。
    let analysis_candidates: Vec<&Value> = skills
        .iter()
        .filter(|x| b(x, "loaded")
            || (s(x, "harness_family") == "openclaw" && b(x, "discoverable")))
        .collect();
    let scope: Vec<Value> = if inp.all {
        skills.to_vec()
    } else {
        analysis_candidates.iter().map(|x| (*x).clone()).collect()
    };

    // ── 同名 skill 的副本 ─────────────────────────────────
    // 按 (conflict_domain, namespace, name) 去重：插件里的 skill 有命名空间
    // 隔离，跨执行环境是独立运行时。判定逻辑在 analysis::conflicts。
    let groups = group_by_key(&scope);
    let conflicts = analysis::conflicts(&scope, &groups);

    // unique：每组取**首次出现**的那一份，与 Python 的 v[0] 一致
    let unique: Vec<&Value> = groups.iter().map(|(_, idxs)| &scope[idxs[0]]).collect();
    let tier1_total: i64 = unique.iter().map(|v| i(v, "tier1_tokens")).sum();

    // ── 描述预算 ─────────────────────────────────────────
    let budget_report = analysis::budget(&unique, inp.harness, inp.all, inp.budget);

    // ── 触发数据 ─────────────────────────────────────────
    let (trigger_report, trigger_available) = analysis::trigger(
        &loaded,
        cfg.usage.len(),
        cfg.usage.is_empty(),
        inp.harness,
        inp.zombie_age,
        inv.dsh_evidence.as_ref(),
        inv.dsh_evidence_path.as_deref(),
    );

    // ── 结构：谁该拆 ─────────────────────────────────────
    let (structure, oversized_count) =
        analysis::structure(&loaded, &analysis_candidates, inp.split_threshold);

    // ── 安全汇总 ─────────────────────────────────────────
    let (security_report, flagged_count, all_cited_count) = analysis::security(skills);

    // ── 组装 ─────────────────────────────────────────────
    let mut enabled_sorted: Vec<String> = cfg
        .enabled
        .as_ref()
        .map(|s| s.iter().cloned().collect())
        .unwrap_or_default();
    enabled_sorted.sort();

    let mut skills_sorted: Vec<&Value> = skills.iter().collect();
    skills_sorted.sort_by_key(|x| (!b(x, "loaded"), -i(x, "tier1_tokens")));

    // ── 按执行环境的分项 ─────────────────────────────────────
    // dsh 触发证据的可用性与 trigger_dsh 的判定同口径：有证据且未 degraded 才算
    // available。degraded 与 trigger_dsh 一样按字符串读（键存在但值为 null 不算
    // degraded）；harness_summaries 不重新解释证据，只接收这个布尔。
    let dsh_trigger_available = inv
        .dsh_evidence
        .as_ref()
        .map(|e| e.get("degraded").and_then(|d| d.as_str()).is_none())
        .unwrap_or(false);
    let harness_summaries = analysis::harness_summaries(
        skills,
        cfg.usage.is_empty(),
        inv.codex.available,
        inv.openclaw.iter().any(|r| r.available),
        inp.budget,
        dsh_trigger_available,
    );

    let mut out = Map::new();
    // 放在最前：解析方应当先读到它，再决定怎么读其余字段
    out.insert("schema_version".into(), json!(SCHEMA_VERSION));
    out.insert("scanned_roots".into(), json!(inv.scanned_roots));
    out.insert("harness_selection".into(), json!(inp.harness));
    out.insert("harness_summaries".into(), Value::Object(harness_summaries));
    out.insert("openclaw_runtime".into(), json!(inv.openclaw.iter().map(|r| json!({
        "available": r.available,
        "source": "openclaw skills list --eligible --json",
        "skills": r.skills,
        "errors": r.errors,
        "instance_id": r.instance_id,
    })).collect::<Vec<_>>()));
    // 扫描过程中读不了的 skill。**必须显式出现**，不能静默丢掉 ——
    // 缺一项的报告有价值，少一项却不说的报告会误导清点。
    out.insert("unreadable_skills".into(), json!(inv.unreadable));
    out.insert("total_skills_on_disk".into(), json!(skills.len()));
    out.insert("loaded_skills".into(), json!(loaded.len()));
    out.insert("unique_skills".into(), json!(unique.len()));
    out.insert(
        "plugin_state".into(),
        json!({
            "harness_config_read": cfg.present,
            "enabled_plugins": enabled_sorted,
            "note": "Disabled plugin copies remain on disk but do not enter context or count toward the budget. \
When harness_config_read=false, plugin state is unknown and copies are treated as not loaded.",
        }),
    );
    out.insert("codex_runtime".into(), json!({
        "available": inv.codex.available,
        "source": "codex app-server skills/list",
        // 探测**跑了但失败**时仍要报 cwd —— 那是「我在哪个工作目录问的」，
        // 恰恰是排查线索。只有压根没跑（禁用 / 未选中）才是 null。
        // 这条差异在 golden 里永远不显形：那里探测一直是禁用的。
        "cwd": if inv.codex.cwd.is_empty() { Value::Null }
               else { json!(inv.codex.cwd) },
        "catalog_skills": inv.codex.skills.len(),
        "errors": inv.codex.errors,
        "note": "When available=true, Codex discovery, scope, enabled state, interface, and dependencies \
come from the official app-server. No public per-skill trigger-count API is available.",
    }));
    out.insert("workbuddy_discovery".into(), json!({
        "source": "manifest-selected top-level packages resolved in plugins/cache/workbuddy-builtin",
        "user_root": norm(&PathBuf::from(inp.home_n).join(".workbuddy/skills")),
        "builtin_root": norm(&PathBuf::from(inp.home_n)
            .join(".workbuddy/plugins/marketplaces/workbuddy-builtin")),
        "cache_root": norm(&PathBuf::from(inp.home_n)
            .join(".workbuddy/plugins/cache/workbuddy-builtin")),
        "excluded_roots": ["~/.workbuddy/connectors-marketplace (catalog only)",
                           "non-top-level builtin-plugin content such as role definitions under experts/"],
        "welcome_mode": inv.workbuddy.welcome_mode.clone().map(Value::String).unwrap_or(Value::Null),
        // 证据而非判决：带标记的包照常计入，只是把标记如实报出来
        "orphaned_packages": inv.workbuddy.orphaned_packages,
        "top_level_manifest_packages": inv.workbuddy.package_count,
        "skill_roots_from_manifest": inv.workbuddy.root_count,
        "enabled_state": "mode-filtered manifest evidence; no public per-skill runtime API",
        "trigger_data": "not-available",
    }));
    let oc_catalog: Vec<(Option<String>, usize)> = inv
        .openclaw
        .iter()
        .filter(|r| r.available)
        .map(|r| (r.instance_id.clone(), r.skills.len()))
        .collect();
    let oc_instances = analysis::openclaw_instances(skills, &oc_catalog);
    out.insert("openclaw_instances".into(), Value::Object(oc_instances));
    out.insert("description_budget".into(), Value::Object(budget_report));
    out.insert("trigger_data".into(), Value::Object(trigger_report));
    out.insert("structure".into(), Value::Object(structure));
    out.insert("security".into(), Value::Object(security_report));
    out.insert("tier1_total_tokens".into(), json!(tier1_total));
    out.insert(
        "tier1_pct_of_200k".into(),
        json!(pyround(tier1_total as f64 / 200000.0 * 100.0, 2)),
    );
    out.insert("conflicts".into(), Value::Array(conflicts));
    out.insert("precedence_note".into(), json!(
        "Overrides are compared only within one harness. Claude Code: enterprise > personal > project > plugin; \
OpenClaw: workspace > project > personal > managed. Plugin skills \
are isolated by <plugin>:<name>, so equal bare names are not conflicts."));
    out.insert("cross_harness_note".into(), json!(
        "Harnesses do not share context. Use harness_summaries or --harness for one runtime; do not \
interpret top-level Tier1 or description-budget values as a cross-harness total."));
    out.insert(
        "skills".into(),
        Value::Array(skills_sorted.into_iter().cloned().collect()),
    );

    Report {
        doc: Value::Object(out),
        disk: skills.len(),
        loaded: loaded.len(),
        tier1_total,
        trigger_available,
        oversized: oversized_count,
        flagged: flagged_count,
        all_cited: all_cited_count,
    }
}
