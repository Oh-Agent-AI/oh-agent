//! Stage A（R4 §5/§7）：Runtime 共享 ingest service —— harnesses → data 的批编排。
//!
//! wire → fact 的**生产者**在各执行环境 `agent_vitals-harnesses/harnesses/<h>/sources/
//! usage_fact.rs`；append/replay/reconcile 的**机制**在
//! `agent_vitals-data::evidence`；本模块是两者之间唯一的接线层：把一批事实
//! 按执行环境分组成文件、经 `FactWriter` 落盘（fact_id exactly-once）、写后重放
//! 自检。CLI（`{claude,codex,dsh}-usage-facts --write`）、未来的 sync_service
//! 与测试都走这一条路——**不得绕过它直捅 writer**，否则 lease/checkpoint
//! （Stage B）收口时会出现第二条写路径。
//!
//! **P0 边界**（与 `data::evidence` 模块头同一份分期表）：这里没有 lease、
//! 没有 intent、没有 SQLite 投影——单进程假设下的 exactly-once 追加 +
//! 崩溃可读。facts 文件布局 = `<data_home>/facts/<harness>.jsonl`（spec §3.4
//! 「UsageFact JSONL」一行一事实；§6 的 13 个月滚动保留是 Stage B 的清理器，
//! 本模块只负责追加语义正确）。
//!
//! **执行环境词表是封闭的**：`FACT_HARNESSES` 与四个 emitter stamp 的 `harness` 值
//! 一一对应（workbuddy 自 spec WORKBUDDY_ONBOARDING §9E.5 E4b 起入表——
//! 它的事实全部 `provider_id: null`，金额面 unresolved，但 token 是真的）。facts 文件名由事实自身的 `harness` 字段决定（调用方传不进文件名，
//! 也就传不进路径穿越）；未知执行环境 → 硬错误，不给「任意 JSON 落任意文件」
//! 留门。
//!
//! ** reconciliation 的分期**：`data::evidence::reconcile_tokens` 对账的是
//! facts vs 投影 DTO（`tokens_by_harness`）——投影在 Stage B 才有权威副本，所以
//! 本模块的对账面当前只有「写后重放自检」（写进去的能原样读回来、计数吻合、
//! 崩溃半行可见）。facts vs DTO 的全量对账挂 Stage B 的 projection 落地。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use agent_vitals_data::evidence::{AppendError, AppendOutcome, FactWriter, replay, retain};
use serde_json::Value;

/// 兼容路径：词表本体在 `core::fact_harnesses`（W3 解环——query 读它不该依赖 ingest）。
pub use crate::core::fact_harnesses::FACT_HARNESSES;

/// 单执行环境 facts 文件路径。未知执行环境 → None（调用方报错，不猜）。
/// manifest 执行环境（`harness:<slug>`；迁移期旧 `plugin:<slug>` 折算到同一 stem）
/// 经 slug 校验后落 `harness-<slug>.jsonl`——路径穿越防护语义保留（slug 词表闸
/// 在 `harness_registry::plugin_facts_stem`，HARNESS_MANIFEST_DSL_SPEC §7.2/§13）；
/// `harness-` 前缀的文件名空间官方执行环境永不占用。
pub fn facts_path(data_home: &Path, harness: &str) -> Option<PathBuf> {
    if !FACT_HARNESSES.contains(&harness) {
        let stem = crate::harness_registry::plugin_facts_stem(harness)?;
        return Some(data_home.join("facts").join(stem));
    }
    Some(data_home.join("facts").join(format!("{harness}.jsonl")))
}

/// 单执行环境的 ingest 结果。`invalid` 不是错误：坏事实跳过并**如实报数**（与
/// `unaccounted_usage` 哨兵同一惯例——发现矛盾报告给上层，不替调用方 abort）。
#[derive(Debug, Default, serde::Serialize)]
pub struct HarnessIngestReport {
    pub harness: String,
    pub facts_path: PathBuf,
    pub appended: usize,
    pub duplicate: usize,
    pub invalid: usize,
    /// 契约层拒绝的具体问题（缺字段名等），最多留 8 条——全部塞进 JSON 会把
    /// 一条坏事实变成一份不可读报告。
    pub invalid_problems: Vec<String>,
    /// 写后重放：文件里的总事实数（含本次与历史）。
    pub total_after: usize,
    /// open 时执行的 crash 尾面修复（半行截断 / 缺封口补 '\n'）——修复后
    /// 追加面干净，残留不会污染后续事实（true = 上次进程死在写入中途，
    /// 本次已恢复）。
    pub repaired_tail: bool,
}

/// 一批事实（可能跨执行环境）的 ingest 结果，按执行环境字典序。
#[derive(Debug, Default, serde::Serialize)]
pub struct IngestReport {
    pub harnesses: Vec<HarnessIngestReport>,
    /// 连 `harness` 都读不出来（非 JSON object / 缺 `harness` 字段）的事实数——
    /// 无法路由到任何执行环境文件，只能报告级计数。与单执行环境内的 `invalid`
    /// 分开：前者连「属于谁」都不知道，后者已落到执行环境、只是契约校验没过。
    #[serde(default)]
    pub unroutable: usize,
    /// unroutable 事实的具体问题（最多留 8 条，同 `invalid_problems`）。
    #[serde(default)]
    pub unroutable_problems: Vec<String>,
}

/// 把一批 UsageFact 事实写入 `<data_home>/facts/<harness>.jsonl`（按事实自身的
/// `harness` 字段分组）。
///
/// 三层错误语义（审查 P2 收口：形状层与执行环境层分开报）：
/// - **非 UsageFact 形状**（非 JSON object / 缺 `harness`）→ `unroutable` 计数
///   跳过，随报告如实上呈——与单执行环境 `invalid` 同一「报告不 abort」惯例；
/// - **`harness` 值不在封闭词表** → `Err`：这是调用方契约破坏（emitter 恒 stamp
///   已知执行环境），且路径安全立场（不给「任意 JSON 落任意文件」留门）不容忍；
/// - **已有文件中间坏行** → `Err`（整个调用失败，**不产生半提交**——分组后
///   逐执行环境写，前面执行环境成功后面失败会留下部分成功；调用方重跑即可，
///   exactly-once 保证不会双计）。
pub fn ingest_facts(data_home: &Path, facts: &[Value]) -> Result<IngestReport, String> {
    // Stage B lease（DoD #3）：JSONL 追加 + 尾面修复 + 索引写是跨进程临界区
    // ——两个并发 ingest 的尾面截断/封口互相踩踏会写坏文件。临界区毫秒级
    // （慢的 fold/emit 在锁外）；被占则等 5s，然后如实报 Held。
    // TTL 60s：临界区含「索引自愈重建」（全量 JSONL 重放，可能秒级）——
    // 2s 的短临界区 TTL 会在重建中途过期被偷（审查发现 4），写一半的索引
    // 会被后来者再 drop 一次（重建幂等，不至于坏账，但白干且有竞态面）。
    // 60s 覆盖最坏重建时长；crash 残留锁最多阻塞到 TTL 到点被偷。
    let _lease = crate::lease::acquire_blocking(
        &data_home.join("facts").join(".ingest.lock"),
        "facts-ingest",
        60_000,
        5_000,
    )
    .map_err(|e| format!("facts ingest lease: {e}"))?;
    // 按执行环境分组——BTreeMap 让报告顺序确定化（同一批输入同一份报告）。
    let mut grouped: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    let mut report = IngestReport::default();
    for fact in facts {
        let Some(harness) = fact.get("harness").and_then(Value::as_str) else {
            // 连路由键都没有：不是 UsageFact 形状 → 计数跳过（不 abort）。
            report.unroutable += 1;
            if report.unroutable_problems.len() < 8 {
                report.unroutable_problems.push(if fact.is_object() {
                    "fact missing `harness` field".to_string()
                } else {
                    "fact is not a JSON object".to_string()
                });
            }
            continue;
        };
        if !FACT_HARNESSES.contains(&harness) && facts_path(data_home, harness).is_none() {
            return Err(format!(
                "unknown harness `{harness}` (known: {FACT_HARNESSES:?} + validated \
                 harness:<slug>) — refusing to invent a facts file"
            ));
        }
        grouped.entry(harness).or_default().push(fact);
    }
    for (harness, batch) in grouped {
        let path = facts_path(data_home, harness)
            .ok_or_else(|| format!("unknown harness `{harness}`"))?;
        let mut r = HarnessIngestReport {
            harness: harness.to_string(),
            facts_path: path.clone(),
            ..Default::default()
        };

        // facts/ 目录由本层负责（data::evidence 的 writer 只建文件不建目录
        // ——机制层不做布局假设，<data_home>/facts 布局是本模块的所有物）。
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut writer = FactWriter::open(&path).map_err(|e| match e {
            // 中间坏行：带着损坏文件继续追加只会让定位更难——整个调用失败，
            // 让调用方先处理损坏（Stage B 的 rebuild 才是修复路径）。
            AppendError::Corrupt { line_no } => format!(
                "{}: corrupt line {line_no} — run `data replay` after Stage B rebuild",
                path.display()
            ),
            AppendError::Io(e) => format!("{}: {e}", path.display()),
            AppendError::Invalid(_) => unreachable!("open() never validates facts"),
        })?;
        // open 是否执行了 crash 尾面修复——如实上报（修复 = 上次进程死在
        // 写入中途，本次已恢复干净追加面）。
        r.repaired_tail = writer.tail_repair().is_some();

        for fact in batch {
            match fact {
                Value::Object(fields) => match writer.append(fields) {
                    Ok((AppendOutcome::Appended, _)) => r.appended += 1,
                    Ok((AppendOutcome::Duplicate, _)) => r.duplicate += 1,
                    Err(AppendError::Invalid(problems)) => {
                        r.invalid += 1;
                        if r.invalid_problems.len() < 8 {
                            r.invalid_problems.push(problems.join("; "));
                        }
                    }
                    Err(AppendError::Corrupt { line_no }) => {
                        return Err(format!(
                            "{}: corrupt line {line_no} mid-ingest",
                            path.display()
                        ));
                    }
                    Err(AppendError::Io(e)) => {
                        return Err(format!("{}: {e}", path.display()));
                    }
                },
                // 分组层已把非 object 吸进 unroutable——到这里必是 object。
                _ => unreachable!("non-object facts are unroutable, filtered at grouping"),

            }
        }

        // 写后重放自检：文件能整读、计数吻合。这一步是「写入成功」的
        // 诚实定义——不重放就报告成功，等于没检查。
        let rep = replay(&path).map_err(|e| match e {
            AppendError::Corrupt { line_no } => {
                format!("{}: corrupt line {line_no} after ingest", path.display())
            }
            AppendError::Io(e) => format!("{}: {e}", path.display()),
            AppendError::Invalid(_) => unreachable!("replay() never validates facts"),
        })?;
        r.total_after = rep.facts.len();
        report.harnesses.push(r);
    }

    // Phase 4.3：旧 `index.sqlite3` 投影已退役——facts JSONL 落盘即完成。
    // SQL 权威库（`agent-vitals.sqlite3`）由 `sync_service::write_flat_facts_to_
    // authority` 在本函数之前独立写入（`sync_facts` 的双写顺序：权威在前、
    // JSONL 在后），不在此处。
    Ok(report)
}

/// "YYYY-MM" − `months_back` 个月（无 chrono 的月算术：年月展平成 12 进制）。
fn month_shift(month: &str, months_back: u32) -> String {
    let y: i64 = month.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(0);
    let m: i64 = month.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(1);
    let total = (y * 12 + m - 1 - months_back as i64).max(0);
    format!("{:04}-{:02}", total / 12, total % 12 + 1)
}

/// v30 配套（发布前拍板 2026-10-01）：facts JSONL 里 `plugin-` 期行一次性重
/// stamp 到 `harness:` 身份——fact_id 与 source_profile 用 domain 的同一
/// `fact_id()` 重算，与 authority 迁移同构。重算后同 id 重复行保留首行
/// （重导已写入的新行优先）。仅重写有变化的文件（原子替换），幂等。
pub fn restamp_manifest_fact_files(data_home: &Path) -> Value {
    let facts_dir = data_home.join("facts");
    let mut report = serde_json::Map::new();
    let Ok(entries) = std::fs::read_dir(&facts_dir) else { return serde_json::Value::Object(report) };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| (n.starts_with("harness-") || n.starts_with("plugin-")) && n.ends_with(".jsonl"))
        .collect();
    names.sort();
    for name in names {
        let path = facts_dir.join(&name);
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let mut restamped = 0usize;
        let mut merged = 0usize;
        let mut seen = std::collections::BTreeSet::new();
        let mut lines = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() { continue; }
            let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) else {
                lines.push(line.to_string()); // 坏行原样保留，交由既有修复路径处理
                continue;
            };
            let profile = value.get("source_profile").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(rest) = profile.strip_prefix("plugin-") {
                let slug = value.get("harness").and_then(|v| v.as_str())
                    .and_then(|h| h.strip_prefix("harness:").or_else(|| h.strip_prefix("plugin:")))
                    .unwrap_or_default().to_string();
                let namespace = value.get("machine_namespace").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let session = value.get("native_session_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let event = value.get("source_event_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let kind = value.get("observation_kind").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let new_profile = format!("harness-{rest}");
                let new_id = agent_vitals_domain::contracts::usage_fact::fact_id(
                    &namespace, &format!("harness:{slug}"), &new_profile, &session, &event, &kind);
                if seen.contains(&new_id) { merged += 1; continue; }
                seen.insert(new_id.clone());
                value["fact_id"] = serde_json::Value::String(new_id);
                value["source_profile"] = serde_json::Value::String(new_profile);
                restamped += 1;
                lines.push(serde_json::to_string(&value).unwrap_or_else(|_| line.to_string()));
            } else {
                if let Some(id) = value.get("fact_id").and_then(|v| v.as_str()) {
                    if !seen.insert(id.to_string()) {
                        merged += 1;
                        continue;
                    }
                }
                lines.push(line.to_string());
            }
        }
        if restamped > 0 || merged > 0 {
            let temporary = facts_dir.join(format!(".restamp-{}-{}", std::process::id(), name));
            if std::fs::write(&temporary, lines.join("\n") + "\n").and_then(|_| std::fs::rename(&temporary, &path)).is_ok() {
                report.insert(name, serde_json::json!({ "restamped": restamped, "merged": merged }));
            }
        }
    }
    serde_json::Value::Object(report)
}

/// E05（spec §13.3）：旧 `plugin-<slug>.jsonl` facts 文件一次性改名为
/// `harness-<slug>.jsonl`。幂等：目标已存在则跳过（不合并、不覆盖，留人工
/// 核对）；slug 不过闸的旧文件如实上报不改。authority 侧 `plugin:` →
/// `harness:` 的行迁移在 schema v29（authority.rs）同批完成。
pub fn migrate_manifest_facts_prefix(data_home: &Path) -> Value {
    let facts_dir = data_home.join("facts");
    let empty = || serde_json::json!({ "renamed": [], "skipped_existing": [], "rejected": [] });
    let Ok(entries) = std::fs::read_dir(&facts_dir) else {
        return empty();
    };
    let mut renamed: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut rejected: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_prefix("plugin-").and_then(|s| s.strip_suffix(".jsonl")) else { continue; };
        if crate::harness_registry::plugin_facts_stem(&format!("harness:{stem}")).is_none() {
            rejected.push(name);
            continue;
        }
        let target = format!("harness-{stem}.jsonl");
        if facts_dir.join(&target).exists() {
            skipped.push(name);
            continue;
        }
        match std::fs::rename(entry.path(), facts_dir.join(&target)) {
            Ok(()) => renamed.push(target),
            Err(_) => rejected.push(name),
        }
    }
    serde_json::json!({ "renamed": renamed, "skipped_existing": skipped, "rejected": rejected })
}

/// Stage C（spec §6）：UsageFact 13 个月滚动保留。对每个执行环境 facts 文件
/// 执行 `retain`（无日期行保留、原子替换、幂等）。调用方负责持有 lease——
/// `sync_facts` 每天首轮在 `.ingest.lock` 内调一次（对权威 JSONL 的重写
/// 是显式维护动作，节流到日粒度，不藏在每次 ingest 里）。
pub fn enforce_retention(data_home: &Path, current_month: &str) -> Result<Value, String> {
    // 迁移先行（幂等）：先把旧行 id/profile 重 stamp 到 harness: 身份（与
    // authority v30 同一拍板），再改文件名，下方按 harness: 推导的路径才能命中。
    let _ = restamp_manifest_fact_files(data_home);
    let _ = migrate_manifest_facts_prefix(data_home);
    // spec §6「UsageFact 13 个月保留」钉死为「保留最近 13 个自然月」
    // （含当月）→ cutoff = current − 12（两端含）。fencepost 常量与
    // authority 侧共享（RETENTION_MONTHS_MINUS_ONE）——两处各持魔法数就是
    // 对账 mismatch 的确定性来源（审查 P1-3）。
    let cutoff = month_shift(
        current_month,
        crate::sql_sync::RETENTION_MONTHS_MINUS_ONE,
    );
    let mut out = serde_json::Map::new();
    let mut harnesses: Vec<String> = FACT_HARNESSES.iter().map(|h| h.to_string()).collect();
    // manifest 执行环境：磁盘驱动（比 registry 扫描更稳——manifest 被删后历史文件
    // 仍要能被清理）；文件名反查过同一 slug 闸（§7.1 #3）。迁移期旧
    // `plugin-<slug>.jsonl` 一并发现并按新 `harness:` 身份纳入清理。
    if let Ok(entries) = std::fs::read_dir(data_home.join("facts")) {
        let mut manifest_harnesses: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let legacy = name.strip_prefix("plugin-");
                let stem = name
                    .strip_prefix("harness-")
                    .or(legacy)?
                    .strip_suffix(".jsonl")?;
                if crate::harness_registry::plugin_facts_stem(&format!("harness:{stem}")).is_some() {
                    Some(format!("harness:{stem}"))
                } else {
                    None
                }
            })
            .collect();
        manifest_harnesses.sort();
        manifest_harnesses.dedup();
        harnesses.append(&mut manifest_harnesses);
    }
    for harness in harnesses {
        let Some(path) = facts_path(data_home, &harness) else {
            continue;
        };
        if !path.exists() {
            continue;
        }
        let rep = retain(&path, &cutoff).map_err(|e| format!("{}: {e}", path.display()))?;
        if rep.dropped > 0 || rep.kept + rep.kept_undated > 0 {
            out.insert(
                harness,
                serde_json::json!({
                    "cutoff_month": cutoff,
                    "kept": rep.kept,
                    "dropped": rep.dropped,
                    "kept_undated": rep.kept_undated,
                }),
            );
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_domain::contracts::usage_fact::build_usage_fact;
    use serde_json::json;

    fn fact(harness: &str, event: &str) -> Value {
        let mut fields = serde_json::Map::new();
        fields.insert("machine_namespace".into(), json!("ns-test"));
        fields.insert("harness".into(), json!(harness));
        fields.insert("source_profile".into(), json!("default"));
        fields.insert("native_session_id".into(), json!("sess-1"));
        fields.insert("source_event_id".into(), json!(event));
        fields.insert("observation_kind".into(), json!("token_count"));
        fields.insert("uncached_input_tokens".into(), json!(100));
        // event_ts_utc 是索引月窗过滤的键（reconcile P1-3）——固定在 2026-09
        // 让测试与月份参数对得上。
        fields.insert("event_ts_utc".into(), json!("2026-09-05T10:00:00.000Z"));
        build_usage_fact(&fields).unwrap()
    }

    fn tmp_home(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "avd-ingest-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn month_shift_arithmetic_is_twelve_base() {
        // 审查 P2：月算术无单测。钉住跨年 / 1 月 / 0 钳制三个边。
        assert_eq!(month_shift("2026-09", 12), "2025-09");
        assert_eq!(month_shift("2026-09", 13), "2025-08");
        assert_eq!(month_shift("2025-01", 1), "2024-12");
        assert_eq!(month_shift("2024-02", 14), "2022-12");
        assert_eq!(month_shift("0000-01", 13), "0000-01", "0 钳制不产生负年");
    }

    #[test]
    fn ingests_are_exactly_once_across_calls() {
        let home = tmp_home("once");
        let facts = vec![fact("codex", "evt-1"), fact("codex", "evt-2")];
        let r1 = ingest_facts(&home, &facts).unwrap();
        assert_eq!(r1.harnesses.len(), 1);
        assert_eq!(r1.harnesses[0].appended, 2);
        assert_eq!(r1.harnesses[0].duplicate, 0);
        assert_eq!(r1.harnesses[0].total_after, 2);

        // 同一批重跑（crash 后重放、双管道）→ 全部 Duplicate，文件不动。
        let r2 = ingest_facts(&home, &facts).unwrap();
        assert_eq!(r2.harnesses[0].appended, 0);
        assert_eq!(r2.harnesses[0].duplicate, 2);
        assert_eq!(r2.harnesses[0].total_after, 2);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn mixed_harnesses_land_in_per_harness_files() {
        let home = tmp_home("harnesses");
        let facts = vec![fact("codex", "e1"), fact("dsh", "e2"), fact("claude-code", "e3")];
        let r = ingest_facts(&home, &facts).unwrap();
        assert_eq!(r.harnesses.len(), 3, "三执行环境三文件，报告按字典序");
        assert_eq!(r.harnesses[0].harness, "claude-code");
        assert_eq!(r.harnesses[1].harness, "codex");
        assert_eq!(r.harnesses[2].harness, "dsh");
        for h in &r.harnesses {
            assert!(h.facts_path.starts_with(home.join("facts")));
            assert_eq!(h.total_after, 1);
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_harness_is_refused_shapes_are_counted() {
        let home = tmp_home("bad");
        // 未知执行环境 → 硬错误（不许凭事实内容发明文件名）。workbuddy 自 E4b 起在
        // 表内，改用一个永不会入表的名字。
        assert!(ingest_facts(&home, &[json!({"harness": "not-a-harness"})]).is_err());
        assert!(FACT_HARNESSES.contains(&"workbuddy"), "E4b：workbuddy 在封闭词表内");
        // 非 object / 缺 harness → unroutable 计数（报告级，不 abort）。
        let r = ingest_facts(&home, &[json!([1, 2]), json!({"foo": 1})]).unwrap();
        assert_eq!(r.unroutable, 2);
        assert_eq!(r.unroutable_problems.len(), 2);
        assert!(r.harnesses.is_empty(), "没有可路由事实就不该开文件");
        // 有 harness 但契约校验不过 → 单执行环境 invalid 计数 + 问题清单。
        let r = ingest_facts(&home, &[json!({"harness": "codex", "junk": true})]).unwrap();
        assert_eq!(r.harnesses[0].invalid, 1);
        assert!(!r.harnesses[0].invalid_problems.is_empty(), "问题清单如实上呈");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn corrupt_existing_file_fails_without_half_write() {
        let home = tmp_home("corrupt");
        let path = facts_path(&home, "codex").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{\"a\": 1}\nGARBAGE\n{\"b\": 2}\n").unwrap();
        let err = ingest_facts(&home, &[fact("codex", "e1")]).unwrap_err();
        assert!(err.contains("corrupt line 2"), "{err}");
        // 文件未被追加（拒绝在损坏上继续写）。
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 3);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn trailing_partial_from_crash_is_reported_and_ingest_continues() {
        let home = tmp_home("crash");
        ingest_facts(&home, &[fact("codex", "e1")]).unwrap();
        let path = facts_path(&home, "codex").unwrap();
        // 模拟 crash 半行：上次进程死在写入中途。
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"fact_id\": \"uf1-trunca");
        std::fs::write(&path, text).unwrap();

        // 尾面在 open 时被修复（截掉半行），append 落在干净表面上，
        // 报告如实标注修复发生。
        let r = ingest_facts(&home, &[fact("codex", "e2")]).unwrap();
        assert_eq!(r.harnesses[0].appended, 1);
        assert!(r.harnesses[0].repaired_tail, "崩溃尾面修复如实上报");
        assert_eq!(r.harnesses[0].total_after, 2, "e2 必须真实可读——旧实现会把它与残行合并吞掉");
        // 再开一次：文件干净，无修复动作。
        let r2 = ingest_facts(&home, &[fact("codex", "e3")]).unwrap();
        assert!(!r2.harnesses[0].repaired_tail);
        assert_eq!(r2.harnesses[0].total_after, 3);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn manifest_fact_files_restamp_to_harness_identity() {
        use agent_vitals_domain::contracts::usage_fact::fact_id;
        let home = tmp_home("restamp");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        let old_line = |event: &str, id: &str| format!(
            "{{\"fact_id\":\"{id}\",\"machine_namespace\":\"m\",\"harness\":\"harness:zcode\",\"source_profile\":\"plugin-abcd\",\"native_session_id\":\"s\",\"source_event_id\":\"{event}\",\"observation_kind\":\"usage\"}}");
        let harness_line = r#"{"fact_id":"uf1-keep","machine_namespace":"m","harness":"harness:zcode","source_profile":"harness-abcd","native_session_id":"s","source_event_id":"e9","observation_kind":"usage"}"#;
        std::fs::write(home.join("facts/plugin-zcode.jsonl"),
            old_line("e1", "uf1-old-a") + "\n" + &old_line("e1", "uf1-old-b") + "\n" + harness_line + "\n").unwrap();
        let report = restamp_manifest_fact_files(&home);
        assert_eq!(report["plugin-zcode.jsonl"]["restamped"], serde_json::json!(1));
        assert_eq!(report["plugin-zcode.jsonl"]["merged"], serde_json::json!(1), "同事件重复行合并");
        let text = std::fs::read_to_string(home.join("facts/plugin-zcode.jsonl")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let expected_id = fact_id("m", "harness:zcode", "harness-abcd", "s", "e1", "usage");
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["fact_id"], serde_json::json!(expected_id));
        assert_eq!(first["source_profile"], serde_json::json!("harness-abcd"));
        assert_eq!(lines[1], harness_line, "harness- 期行原样保留");
        // 幂等：再来一遍无事发生。
        let report = restamp_manifest_fact_files(&home);
        assert!(report.as_object().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn manifest_facts_prefix_migration_is_idempotent_and_honest() {
        let home = tmp_home("prefix-migrate");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        std::fs::write(home.join("facts/plugin-zcode.jsonl"), "{}\n").unwrap();
        std::fs::write(home.join("facts/harness-other.jsonl"), "{}\n").unwrap();
        std::fs::write(home.join("facts/plugin-bad!slug.jsonl"), "{}\n").unwrap();
        let report = migrate_manifest_facts_prefix(&home);
        assert_eq!(report["renamed"], serde_json::json!(["harness-zcode.jsonl"]));
        assert_eq!(report["skipped_existing"], serde_json::json!([]));
        assert_eq!(report["rejected"], serde_json::json!(["plugin-bad!slug.jsonl"]));
        assert!(home.join("facts/harness-zcode.jsonl").exists());
        assert!(!home.join("facts/plugin-zcode.jsonl").exists());
        // 幂等：再来一遍无事发生；同 slug 新旧并存时跳过并如实上报。
        std::fs::write(home.join("facts/plugin-zcode.jsonl"), "{}\n").unwrap();
        let report = migrate_manifest_facts_prefix(&home);
        assert_eq!(report["renamed"], serde_json::json!([]));
        assert_eq!(report["skipped_existing"], serde_json::json!(["plugin-zcode.jsonl"]));
        let _ = std::fs::remove_dir_all(&home);
    }
}
