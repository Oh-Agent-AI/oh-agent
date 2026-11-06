//! v0.9.1 Phase 2（spec §5.1/§7）：`sync_facts` 的 SQL 权威写入集成。
//!
//! `sync_service.rs` 保留「文件发现 → 差量 → emit」；本模块接手其后半程：
//! **不再写 facts/*.jsonl（JSONL 停写，存量为遗留），改为 SQL 权威写入**：
//! `sync_runs` 批次 → `source_files` upsert → `sessions` upsert →
//! `usage_facts` 写入，全部包在一个 `with_immediate_txn` 里（spec §5.1.4）。
//! 差量指纹改查 `source_files` 表（JSON checkpoint `.ingest-checkpoint.json`
//! 退役——首启时迁移，见 [`migrate_json_checkpoint`]）。
//!
//! **写协议两步分闱**：`AuthorityDb::begin_run`/`finish_run` 是批号观测记录
//! （§3.1 的恢复用），业务写入只经 `with_immediate_txn`。`begin_run` 在事务
//! **之前**落行，与 spec §5.1.4 的「事务内创建 sync_runs」措辞略有出入——
//! 批号先于事务，是为了幂等重跑用同一 run_id、以及 begin 失败时错误独立可见；
//! 真正动业务数据的写入仍在一个立即事务里，绝不半提交。
//!
//! 时钟注入点（Phase 1.5）：`now_ms()` 是本 crate 唯一读 `std::time` 的位置
//! （runtime 允许读时钟，data 不读）——所有 `*_at_ms` 从这里取。
//! `sync_harness_sql` 进入时取一次 `now` 注入全程（一个批次 = 一格时间）；
//! `migrate_json_checkpoint` 完全由调用方注入。模块内无其他 `std::time` 读取。

use std::path::Path;

use agent_vitals_data::authority::{AuthorityDb, AuthorityError};
use agent_vitals_data::fact_writer_sql::SqlFactWriter;
use agent_vitals_domain::source_graph::PARSER_VERSION;
use agent_vitals_domain::workflow::WorkflowEvent;
use rusqlite::OptionalExtension;
use serde_json::Value;

/// 兼容路径：`now_ms` 已下沉到 `core::clock`（W3 解环——events / trust /
/// sources / sessions / query 都只为读个时钟就依赖了 ingest，拆 crate 时
/// 每一条都会成为环）。外部 78 处 `agent_vitals_runtime::sql_sync::now_ms`
/// 照旧可用；runtime 内部一律写 `crate::clock::now_ms`（`tests/module_layering.rs` 钉住）。
pub use crate::core::clock::now_ms;

/// 生成 run_id（幂等重跑 = 同来源同时段同 id；首版用 `{trigger}:{unix_ms}`）。
pub fn new_run_id(trigger: &str) -> String {
    format!("{trigger}:{}", now_ms())
}

/// v0.12：落一份**当前**价格快照及其 catalog provenance。
/// `pricing_version` = `{pricing.json, codex_pricing.json}` 合并对象的
/// `fnv1a64_hex(canonical_json)`——内容指纹，价卡变则版本变。已存在 → 幂等
/// 吸收（返回 `false`）。`data-migrate` / `sync-facts` 每次调用一次，DB 里
/// 总有当前版本 + 历次运行留下的历史版本（Q13：调价日前后重放正确版本，
/// 消费面 `authority::pricing_snapshot_asof`）。
///
/// 库里有每日同步叠加层时一并叠上（覆盖式，见 `domain::cost::sync_overlay`）：
/// app 升级带来新的内置底表时，这里会落一份更新的快照；若不叠叠加层，它会
/// 成为「最新」而把同步到的新卡与改价挤掉，直到下次拉取（最长一天）。
pub fn snapshot_current_pricing(db: &AuthorityDb) -> Result<bool, AuthorityError> {
    let overlay: Option<Value> = db
        .latest_pricing_sync_overlay()?
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let (canon, version) = combined_pricing(overlay.as_ref());
    let catalog_version = format!("bc1-{version}");
    let source_kind = if overlay.is_some() { "embedded-assets+sync-overlay" } else { "embedded-assets" };
    let now = now_ms();
    db.with_immediate_txn(|conn| {
        conn.execute(
            "INSERT INTO provider_catalog_snapshots(
               catalog_version, captured_at_ms, source_kind, snapshot_id, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(catalog_version) DO NOTHING",
            rusqlite::params![catalog_version, now, source_kind, catalog_version, canon],
        )?;
        let changed = conn.execute(
            "INSERT INTO pricing_snapshots(
               pricing_version, captured_at_ms, source_kind, payload_json, catalog_version, billing_template_id)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL)
             ON CONFLICT(pricing_version) DO NOTHING",
            rusqlite::params![version, now, source_kind, canon, catalog_version],
        )?;
        Ok(changed > 0)
    })
}

/// app 拉到新的每日同步叠加层后调用：叠加层原文与「内置底表 + 叠加层」的完整
/// 快照在同一事务里入库。快照形状与 [`snapshot_current_pricing`] 完全一致
/// （`{pricing, codex_pricing}`）——此前公共目录只存了 `pricing.json`，codex 计价
/// 读不到 `codex_pricing`，一开启价格更新之后的 codex 用量就全部算不出金额。
/// 返回是否落了新的价格快照（内容与已有版本相同时幂等返回 `false`）。
pub fn snapshot_with_sync_overlay(
    db: &AuthorityDb,
    overlay: &crate::pricing_catalog::ValidatedSyncOverlay,
) -> Result<bool, AuthorityError> {
    let (canon, version) = combined_pricing(Some(&overlay.overlay));
    let (_, pricing_changed) = db.pricing_sync_overlay_put(
        &overlay.version,
        &overlay.canonical_json,
        &version,
        &canon,
        now_ms(),
    )?;
    Ok(pricing_changed)
}

/// 内置底表（可选叠上同步叠加层）→ `(canonical_json, pricing_version)`。版本是
/// 内容指纹：叠加层没带来任何变化时与纯底表版本相同，重复写入自然幂等。
fn combined_pricing(overlay: Option<&Value>) -> (String, String) {
    let mut pricing = agent_vitals_domain::cost::load_pricing();
    let mut codex = crate::sessions::codex_cost::load_codex_pricing();
    if let Some(overlay) = overlay {
        agent_vitals_domain::cost::sync_overlay::merge_sync_overlay(&mut pricing, &mut codex, overlay);
    }
    let combined = serde_json::json!({ "pricing": pricing, "codex_pricing": codex });
    let mut canon = String::new();
    agent_vitals_domain::source_identity::canonical_json(&combined, &mut canon);
    let version = agent_vitals_domain::source_identity::fnv1a64_hex(canon.as_bytes());
    (canon, version)
}

/// 将升级前价格快照中错误混入的个人订阅声明，迁移为本地、待确认的候选。
/// 公共目录本身绝不回写这些数据，也不自动形成实际账单。
///
/// 旧版把 `catalog_2026_09.subscriptions` 编进 `pricing.json`；升级后只有已
/// 落库的历史快照还保留该线索。本迁移扫描全部快照，产出`pending`候选；只有
/// 用户后续确认才能写入`harness_bills`。此前版本误写的专用 legacy 账单会软删除，
/// 用户手工账单不受影响。
pub fn migrate_legacy_subscription_snapshots(
    db: &AuthorityDb,
    now_ms: i64,
) -> Result<usize, AuthorityError> {
    // 撤回旧版自动账单与写入待确认候选是一个不可分割的迁移动作。任一快照
    // 损坏或写入失败时，必须保留旧状态，不能留下「账单已撤回、候选只写了一半」
    // 的中间态。
    db.with_immediate_txn(|_| migrate_legacy_subscription_snapshots_in_txn(db, now_ms))
}

fn migrate_legacy_subscription_snapshots_in_txn(
    db: &AuthorityDb,
    now_ms: i64,
) -> Result<usize, AuthorityError> {
    db.revoke_legacy_pricing_harness_bills(now_ms)?;
    let mut imported = 0usize;
    for (version, payload) in db.pricing_snapshot_payloads()? {
        let Ok(root) = serde_json::from_str::<Value>(&payload) else { continue };
        let pricing = root.get("pricing").unwrap_or(&root);
        let Some(subscriptions) = pricing
            .pointer("/catalog_2026_09/subscriptions")
            .and_then(Value::as_object)
        else { continue };
        for declaration in subscriptions.values() {
            let (Some(provider), Some(currency), Some(amount), Some(start)) = (
                declaration.get("provider").and_then(Value::as_str),
                declaration.get("currency").and_then(Value::as_str),
                declaration.get("amount_per_month").and_then(Value::as_f64),
                declaration
                    .get("billing_period_start")
                    .or_else(|| declaration.get("reported_at"))
                    .and_then(Value::as_str),
            ) else { continue };
            let Some(first_month) = valid_month_prefix(start) else { continue };
            let Some(amount_minor) = amount_to_minor(amount) else { continue };
            let harness = legacy_subscription_harness(provider);
            let candidate_id = format!(
                "legacy-pricing-candidate:{version}:{harness}:{provider}:{currency}:{amount_minor}:{first_month}"
            );
            if db.billing_import_candidate_put(
                &candidate_id, harness, provider, currency, amount_minor, &first_month,
                &version, now_ms,
            )? {
                imported += 1;
            }
        }
    }
    Ok(imported)
}

fn legacy_subscription_harness(provider: &str) -> &'static str {
    match provider {
        "anthropic" | "minimax" | "zhipu-glm" => "claude-code",
        _ => "unattributed",
    }
}

fn valid_month_prefix(value: &str) -> Option<String> {
    let month: String = value.chars().take(7).collect();
    let bytes = month.as_bytes();
    (bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
        && matches!(month[5..].parse::<u8>().ok(), Some(1..=12)))
        .then_some(month)
}

fn amount_to_minor(amount: f64) -> Option<i64> {
    (amount.is_finite() && amount >= 0.0)
        .then(|| (amount * 100.0).round() as i64)
}

/// 保留窗月数的 fencepost 常量：spec「保留最近 13 个自然月（含当月）」→
/// cutoff = current − 12。**legacy（enforce_retention）与 authority
///（retention_usage_facts）必须同值**——13 vs 12 的窗差会让 §6.3 对账在
/// 13 个月后必然 mismatch（审查 P1-3）。
pub const RETENTION_MONTHS_MINUS_ONE: u32 = 12;

/// `sync_runs.trigger` 词表（spec §3.1）。例行 sync = cli；checkpoint 迁移 =
/// migration（观测/审计用）。
const TRIGGER_SYNC: &str = "cli";
const TRIGGER_MIGRATION: &str = "migration";

/// 当前事实解析器版本；同步差量必须把它和文件指纹一起比较。
///
/// 常量本体住在 `agent_vitals_domain::source_graph::PARSER_VERSION`（P3 下沉：
/// `SourceParser::parser_version` 缺省判定与重放纪律必须同一来源，版本演进的
/// 完整历史注释也在那边）。
pub const fn parser_version() -> i64 {
    agent_vitals_domain::source_graph::PARSER_VERSION
}

/// `finish_run.error_code` 的稳定词（错误细节进 error_detail，code 可机器判）。
const ERR_ALL_FILES_FAILED: &str = "all_files_failed";
const ERR_DB_ERROR: &str = "db_error";
const ERR_MIGRATION: &str = "migration_failed";

/// JSON checkpoint 的 schema 版本号——必须与 `sync_service`（JSONL 版）的
/// `CHECKPOINT_SCHEMA_VERSION` 保持同一值：迁移期两版 checkpoint **读者**不能
/// 对同名叫出不同版本。该常量在 sync_service 是私有，这里显式写明 1。
const CHECKPOINT_SCHEMA_VERSION: u64 = 1;

/// checkpoint 文件名（与 JSONL 版同路径）。
fn checkpoint_path(data_home: &Path) -> std::path::PathBuf {
    data_home.join("facts").join(".ingest-checkpoint.json")
}

/// fact 对象里取 native_session_id（身份四边形之一；`build_usage_fact` 契约
/// 保证非空——filter 空串只是防御，不是语义分支）。
fn native_session_of(fact: &Value) -> Option<&str> {
    fact.get("native_session_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// 一批 facts → 按 `(native_session_id, 归一 profile)` 分组 + 缺身份残组。
///
/// - **profile 参与分组**（审查 P2）：`fact_writer_sql::session_key` 逐事实
///   按 profile 算外键——组内 profile 异构时，第二个事实算出的键与组首
///   upsert 的 sessions 行不同 → 外键炸批。归一规则 = `unwrap_or("default")`
///   （与 writer 的键构造同款），组键含 profile 后逐事实键与组行严格一致。
/// - 返回的 `missing` = 缺 native_session_id 的事实——**调用方记 quality
///   issue + rejected，不得据此造 session**（审查 P2：fallback stem 会留下
///   永无 usage 引用的孤儿会话行）。
type SessionGroups = Vec<(String, String, Vec<Value>)>;

fn group_facts_by_session(facts: &[Value]) -> (SessionGroups, Vec<Value>) {
    let mut groups: Vec<(String, String, Vec<Value>)> = Vec::new();
    let mut missing: Vec<Value> = Vec::new();
    for fact in facts {
        let Some(sid) = native_session_of(fact) else {
            missing.push(fact.clone());
            continue;
        };
        let profile = fact
            .get("source_profile")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string();
        match groups
            .iter_mut()
            .find(|(k, p, _)| *k == sid && *p == profile)
        {
            Some((_, _, v)) => v.push(fact.clone()),
            None => groups.push((sid.to_string(), profile, vec![fact.clone()])),
        }
    }
    (groups, missing)
}

/// JSON checkpoint（`.ingest-checkpoint.json`）→ `source_files` 的一次性
/// 迁移（spec §7 Phase 2：JSON checkpoint 退役）。迁移成功后旧文件**改名
/// 保留**（`.ingest-checkpoint.json.migrated`），不删除（用户可审计）。
/// 幂等：文件不存在 = Ok(0)。文件存在但坏 JSON / schema_version 不匹配 =
/// Ok(0)（整体作废，与 JSONL 版「版本不匹配 → 全量重发」同语义，fact_id 的
/// exactly-once 兜底）。已改名 = 下次 Ok(0)。
///
/// 迁移记录走 `sync_runs`（trigger="migration"）：迁移也是写入，观测在规范里
/// 不缺席。DB 级失败 → 事务整体回退（零写入）+ run 标 failed + Err 上抛；
/// 事务提交成功后才改名（改名失败如实上抛，DB 行已幂等落库可重跑）。
pub fn migrate_json_checkpoint(
    db: &AuthorityDb,
    data_home: &Path,
    now_ms: i64,
) -> Result<usize, AuthorityError> {
    // **持久哨兵**（审查 P1-2）：迁移成功一次即永久标记——否则 sync 结尾
    // save_checkpoint 无条件重建 JSON 文件，下一轮 sync 又「文件存在」→
    // 每 5 分钟产一行 migration run（sync_runs 无界增长 + data-status 失明）。
    let sentinel: Option<String> = db
        .conn()
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'checkpoint_migrated'",
            [],
            |r| r.get(0),
        )
        .ok();
    if sentinel.as_deref() == Some("1") {
        return Ok(0);
    }
    let checkpoint = checkpoint_path(data_home);
    let text = match std::fs::read_to_string(&checkpoint) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let doc: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(0), // 照 JSONL 的宽容语义：坏 JSON = 空
    };
    if doc.get("schema_version").and_then(Value::as_u64) != Some(CHECKPOINT_SCHEMA_VERSION) {
        return Ok(0);
    }
    let Some(files) = doc.get("files").and_then(Value::as_object) else {
        return Ok(0);
    };

    let run_id = new_run_id(TRIGGER_MIGRATION);
    db.begin_run(&run_id, TRIGGER_MIGRATION, now_ms)?;

    let count = match db.with_immediate_txn(|conn| {
        let writer = SqlFactWriter::new(conn, &run_id, now_ms)?;
        let mut n = 0usize;
        for (path_key, entry) in files {
            // 项缺 harness/size/mtime → 不迁：该项在下次差量里会被当「新文件」
            //（source_files 连一行都没有 → dirty → 重 emit），安全侧优先。
            let Some(harness) = entry.get("harness").and_then(Value::as_str) else {
                continue;
            };
            let (Some(size), Some(mtime)) = (
                entry.get("size").and_then(Value::as_u64),
                entry.get("mtime_ns").and_then(Value::as_u64),
            ) else {
                continue;
            };
            // 明文路径不落库：source_id = fnv1a64(路径) 由 writer 层算。
            // checkpoint 里不携带会话信息，native_session_id 不推断（None）。
            writer.upsert_source_file(
                harness,
                std::path::Path::new(path_key),
                size,
                mtime,
                None,
                PARSER_VERSION,
            )?;
            n += 1;
        }
        Ok(n)
    }) {
        Ok(n) => n,
        Err(e) => {
            let msg = format!("{e}");
            let _ = db.finish_run(&run_id, "failed", Some(ERR_MIGRATION), Some(&msg), now_ms);
            return Err(e);
        }
    };

    // 事务提交成功后才改名。DB 行已落库（幂等可重跑），改名只是审计标记
    // 「这过了」——失败如实上抛（Io），下次重跑会再 upsert（幂等）并再试。
    let migrated_path = data_home
        .join("facts")
        .join(".ingest-checkpoint.json.migrated");
    std::fs::rename(&checkpoint, &migrated_path).map_err(AuthorityError::from)?;

    db.conn().execute(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('checkpoint_migrated', '1')",
        [],
    )?;

    db.finish_run(&run_id, "succeeded", None, None, now_ms)?;
    Ok(count)
}

/// SQL 版例行同步的结果形状，与 `sync_service::HarnessSyncReport` 对齐（CLI
/// 渲染复用）。`files_skipped` 由调用方（差量计算侧）填，本模块收到的
/// `dirty` 已经剔除了「指纹未变」的文件，故本模块不产生 skipped；
/// `errors` = 「该文件本轮没进库」的明细，与 JSONL 版的诚实噪声同语义
/// （坏文件每次重试都会再出现）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SqlSyncOutcome {
    pub files_synced: usize,
    pub files_skipped: usize,
    pub inserted: usize,
    pub duplicate: usize,
    pub rejected: usize,
    /// 重复路径的归因状态变更（富集/纠错/冲突收敛）——改喂 ReadMemo 面的
    /// 业务列（评审 P2-1）。
    pub enriched: usize,
    /// workflow 事件本轮实际新插/纠正的行数（评审 P3-2：按插入结果而非输入
    /// 非空判事实性——全重复的 workflow 重放不推 revision）。
    pub workflow_changed: usize,
    /// 任务摘录本轮实际新插的行数（同上）。
    pub excerpts_changed: usize,
    /// 会话标题本轮实际变更的行数（V32：codex/dsh 侧车索引每 tick 重读，
    /// 变更计数保证「无重命名轮」零写入、不推 revision——R3-F4 纪律）。
    pub titles_changed: usize,
    pub errors: Vec<String>,
}

/// 新事实 / 质量问题：`FactsIngested` outbox 的发射条件
/// （RUNTIME_INVALIDATION P0 裁决，不变）。与 [`outcome_is_factual`] 共用
/// 定义点（评审 P3-3：单一判据源，杜绝漂移）。
fn outcome_has_new_facts(outcome: &SqlSyncOutcome) -> bool {
    outcome.inserted > 0 || outcome.rejected > 0
}

/// R3-F4 事实性谓词（revision 推进条件）：新事实之外，归因富集/纠错改喂
/// memo 面的业务列，workflow/excerpt 落库同样是状态变更。路由证据与快照
/// 写入腿在闭包出口处并入（它们是参数不是 outcome）。
fn outcome_is_factual(outcome: &SqlSyncOutcome) -> bool {
    outcome_has_new_facts(outcome)
        || outcome.enriched > 0
        || outcome.workflow_changed > 0
        || outcome.excerpts_changed > 0
        || outcome.titles_changed > 0
}

/// SQL 权威库中的源文件指纹。例行同步用它决定是否需要重解析；没有行就是 dirty。
///
/// 路径只在进程内参与 FNV-1a，SQL 永远只保存 `path_hash`，与 writer 的
/// `upsert_source_file` 完全同源。`None` 不是错误，也不代表文件不存在——它只
/// 表示此前没有一次成功同步把该路径提交到 authority。
pub fn source_file_fingerprint(
    db: &AuthorityDb,
    harness: &str,
    path: &Path,
) -> Result<Option<(u64, u64, i64)>, AuthorityError> {
    let path_hash =
        agent_vitals_domain::source_identity::fnv1a64_hex(path.to_string_lossy().as_bytes());
    db.conn()
        .query_row(
            "SELECT size_bytes, mtime_ns, parser_version FROM source_files
             WHERE harness = ?1 AND path_hash = ?2",
            rusqlite::params![harness, path_hash],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, i64>(1)? as u64,
                    row.get(2)?,
                ))
            },
        )
        .optional()
        .map_err(AuthorityError::from)
}

/// SQL-only batch writer for emitters whose facts span multiple source files
/// (notably Codex). Every successfully emitted source still gets its own
/// `source_files` fingerprint row; facts may share the batch source because
/// their wire format does not preserve a one-file mapping.
pub(crate) struct RuntimeSnapshotWrite<'a> {
    /// 本轮要落库的执行环境实时快照（通常 0 或 1 条；一个执行环境一类）。
    pub snapshots: Vec<RuntimeQuotaSnapshot<'a>>,
    /// schema 升级的一次性回填完成标记。它与本批 source 指纹同一事务提交，
    /// 因而不会在写入失败后错误地阻止下一轮重试。
    pub backfill_marker: Option<&'a str>,
}

/// 类型化的当前状态 + 已生成的兼容投影。
///
/// `payload_json` 可以保留 Codex 的 `has_credits` 等执行环境扩展，但它已经在
/// adapter 内生成；SQL 层只负责原样保存，不通过 JSON 路径提取业务字段。
/// 一条待落库的执行环境实时快照。
///
/// **为什么不是 `&QuotaSnapshot`（Codex 的契约类型）**：2026-09-14 起这条路有第二个
/// 消费方——Claude Pro 的窗口状态（`claude_quota`），它有自己的契约、不该被塞进
/// Codex 的结构体。Runtime 本来就不解析执行环境 wire（职责边界），所以这里只要
/// **已经由 adapter 校验过的** payload 与观察时刻。
#[derive(Clone, Copy)]
pub(crate) struct RuntimeQuotaSnapshot<'a> {
    /// 落 `harness_runtime_snapshots.snapshot_kind`（`codex_quota` / `claude_quota`）。
    pub snapshot_kind: &'a str,
    pub payload_json: &'a str,
    /// 观察时刻（epoch ms）——由执行环境 adapter 从它自己的 wire 时间戳派生。
    pub observed_at_ms: i64,
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_flat_facts_with_sources(
    db: &AuthorityDb,
    harness: &str,
    machine_namespace: &str,
    sources: &[(std::path::PathBuf, (u64, u64))],
    checkpoint_overrides: &std::collections::HashMap<String, crate::source_graph::SourceCheckpointOverride>,
    facts: &[Value],
    workflow_events: &[WorkflowEvent],
    session_excerpts: &[agent_vitals_domain::contracts::workflow::SessionExcerpt],
    route_evidence: Option<&agent_vitals_provider::RouteEvidence>,
    runtime_snapshot: Option<RuntimeSnapshotWrite<'_>>,
    now: i64,
) -> Result<SqlSyncOutcome, String> {
    write_flat_facts_with_sources_and_extension(db, harness, machine_namespace, sources,
        checkpoint_overrides, facts, workflow_events, session_excerpts, &[],
        route_evidence, runtime_snapshot, now, None)
}

/// 会话标题的条件 UPDATE（V32 共用腿）：按
/// `(harness, machine_namespace, native_session_id)` 自然键更新，仅当值真变
/// 时写——codex/dsh 侧车索引每 tick 重读，无变更轮必须零行、不推 revision。
/// 不存在的会话行安静跳过（标题不凭空造会话；无 facts 的索引条目没有楼）。
/// 返回实际变更行数。
fn apply_session_title_updates(
    conn: &rusqlite::Connection,
    harness: &str,
    machine_namespace: &str,
    titles: &[agent_vitals_domain::contracts::workflow::SessionTitle],
) -> Result<usize, AuthorityError> {
    let mut changed = 0;
    for title in titles {
        if title.validate().is_err() {
            continue;
        }
        changed += conn.execute(
            "UPDATE sessions SET title = ?3, title_source = ?4
             WHERE harness = ?1 AND machine_namespace = ?2 AND native_session_id = ?5
               AND deleted_at_ms IS NULL
               AND (title IS NOT ?3 OR title_source IS NOT ?4)",
            rusqlite::params![
                harness,
                machine_namespace,
                title.title,
                title.source,
                title.native_session_id,
            ],
        )?;
    }
    Ok(changed)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn write_flat_facts_with_sources_and_extension(
    db: &AuthorityDb,
    harness: &str,
    machine_namespace: &str,
    sources: &[(std::path::PathBuf, (u64, u64))],
    checkpoint_overrides: &std::collections::HashMap<String, crate::source_graph::SourceCheckpointOverride>,
    facts: &[Value],
    workflow_events: &[WorkflowEvent],
    session_excerpts: &[agent_vitals_domain::contracts::workflow::SessionExcerpt],
    session_titles: &[agent_vitals_domain::contracts::workflow::SessionTitle],
    route_evidence: Option<&agent_vitals_provider::RouteEvidence>,
    runtime_snapshot: Option<RuntimeSnapshotWrite<'_>>,
    now: i64,
    extension: Option<&agent_vitals_data::fact_writer_sql::ExtensionFactContext>,
) -> Result<SqlSyncOutcome, String> {
    let run_id = new_run_id(TRIGGER_SYNC);
    db.begin_run(&run_id, TRIGGER_SYNC, now)
        .map_err(|e| format!("begin_run {run_id}: {e}"))?;

    let mut outcome = SqlSyncOutcome::default();
    // R3-F4（REFRESH_STORM）：事实性裁决与 outbox 压制（下方 inserted/rejected
    // 门）同源——任何事实 / 工作流事件 / 摘录 / 新路由证据 / 快照写入（配额
    // 窗口载荷本身随时间滑动，是用户可见状态）→ 推进 revision；纯簿记轮
    // （仅 checkpoint / last_seen / 心跳）→ 静默提交，不发失效。
    let result: Result<(), AuthorityError> = db.with_immediate_txn_decided(|conn| {
        let writer = SqlFactWriter::new(conn, &run_id, now)?;
        if let Some(route) = route_evidence {
            let evidence_key = format!(
                "codex|{}|{}|{}",
                machine_namespace,
                route.provider_raw.as_deref().unwrap_or(""),
                route.endpoint_host.as_deref().unwrap_or("")
            );
            let evidence_id = format!(
                "route:{}",
                agent_vitals_domain::source_identity::fnv1a64_hex(evidence_key.as_bytes())
            );
            conn.execute(
                "INSERT OR IGNORE INTO route_evidence(
                   evidence_id, harness, machine_namespace, provider_raw, endpoint_host,
                   evidence_basis, observed_at_ms, ingested_run_id)
                 VALUES(?1, 'codex', ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    evidence_id,
                    machine_namespace,
                    route.provider_raw,
                    route.endpoint_host,
                    route.evidence_basis.as_str(),
                    now,
                    run_id,
                ],
            )?;
        }
        for (path, (size_bytes, mtime_ns)) in sources {
            writer.upsert_source_file(harness, path, *size_bytes, *mtime_ns, None, PARSER_VERSION)?;
            // SourceGraph 检查点推进（spec §1.3 / §12）：与事实写入同事务。
            // B1 修复：增量文件的检查点用解析器给出的换行边界 + claude-jsonl-v1，
            // 而非无条件 stat size + FULL_PARSE_V0（后者在 in-flight 半行场景
            // 会让下轮增量从行中间起读、静默丢事实——复跑 B1）。
            let hash = crate::source_graph::path_hash(path);
            let (offset, parser_id) = match checkpoint_overrides.get(&hash) {
                Some(ov) => (ov.byte_offset, ov.parser_id.as_str()),
                None => (Some(*size_bytes), crate::source_graph::FULL_PARSE_V0),
            };
            crate::source_graph::advance_checkpoint(
                conn, harness, &hash,
                offset,
                parser_id,
                *size_bytes, *mtime_ns,
            ).map_err(AuthorityError::from)?;
            outcome.files_synced += 1;
        }
        if let Some(meta_key) = runtime_snapshot
            .as_ref()
            .and_then(|write| write.backfill_marker)
        {
            conn.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?1, '1')",
                [meta_key],
            )?;
        }
        if facts.is_empty()
            && workflow_events.is_empty()
            && session_excerpts.is_empty()
            && session_titles.is_empty()
            // MSRV 1.74：`is_none_or` 稳定于 1.82，这里用 `map_or`。
            && runtime_snapshot.as_ref().map_or(true, |write| write.snapshots.is_empty())
        {
            // 纯簿记短路（R3-F4）：到此只写过 source_files / checkpoint /
            // backfill 标记。backfill 是一次性迁移标记，路由证据是事实性
            // 归因依据——两者任一在场都按事实性提交；否则静默。
            return Ok(((), route_evidence.is_some()
                || runtime_snapshot.as_ref().and_then(|write| write.backfill_marker).is_some()));
        }
        let source_id = writer.upsert_batch_source(harness)?;
        // Route evidence is session-native and belongs to the fact that
        // observed it. Persist its session and source links before inserting
        // usage_facts so the FK trigger can validate every evidence id.
        let mut fact_routes = std::collections::HashSet::new();
        for fact in facts {
            let Some(evidence_id) = fact.get("route_evidence_id").and_then(Value::as_str) else {
                continue;
            };
            if !fact_routes.insert(evidence_id.to_string()) {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO route_evidence(
                   evidence_id, harness, machine_namespace, native_session_id,
                   provider_raw, endpoint_host, evidence_basis, observed_at_ms,
                   source_id, ingested_run_id)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    evidence_id,
                    fact.get("harness").and_then(Value::as_str).unwrap_or(harness),
                    machine_namespace,
                    fact.get("native_session_id").and_then(Value::as_str),
                    fact.get("provider_raw").and_then(Value::as_str),
                    fact.get("endpoint_host").and_then(Value::as_str),
                    fact.get("evidence_basis")
                        .and_then(Value::as_str)
                        .unwrap_or("missing"),
                    now,
                    source_id,
                    run_id,
                ],
            )?;
        }
        if let Some(write) = runtime_snapshot.as_ref() {
            for snapshot in &write.snapshots {
                conn.execute(
                    "INSERT INTO harness_runtime_snapshots(
                         harness, snapshot_kind, payload_json, observed_at_ms, source_id,
                         ingested_run_id, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(harness, snapshot_kind) DO UPDATE SET
                         payload_json = excluded.payload_json,
                         observed_at_ms = excluded.observed_at_ms,
                         source_id = excluded.source_id,
                         ingested_run_id = excluded.ingested_run_id,
                         updated_at_ms = excluded.updated_at_ms
                     WHERE excluded.observed_at_ms >= harness_runtime_snapshots.observed_at_ms",
                    rusqlite::params![
                        harness,
                        snapshot.snapshot_kind,
                        snapshot.payload_json,
                        snapshot.observed_at_ms,
                        source_id,
                        run_id,
                        now,
                    ],
                )?;
            }
        }
        if facts.is_empty() && workflow_events.is_empty() && session_excerpts.is_empty() && session_titles.is_empty() {
            // 能过上面那条短路还到这里 = 本轮有快照写入或 backfill：快照载荷
            // （配额滚动窗口）是用户可见状态，按事实性提交（R3-F4 裁决）。
            return Ok(((), true));
        }
        for fact in facts
            .iter()
            .filter(|fact| fact.get("evidence_basis").and_then(Value::as_str) == Some("conflict"))
        {
            let fact_id = fact
                .get("fact_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            conn.execute(
                "INSERT INTO data_quality_issues(
                     issue_id, scope_type, scope_key, code, severity,
                     first_seen_at_ms, last_seen_at_ms, detail_json)
                 VALUES (?1, 'fact', ?2, 'conflicting_route_evidence', 'warning',
                         ?3, ?3, ?4)
                 ON CONFLICT(scope_type, scope_key, code)
                 DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms,
                               detail_json = excluded.detail_json",
                rusqlite::params![
                    format!("route-conflict:{fact_id}"),
                    fact_id,
                    now,
                    serde_json::to_string(fact).unwrap_or_default(),
                ],
            )?;
        }
        let (groups, missing) = group_facts_by_session(facts);
        for fact in &missing {
            conn.execute(
                "INSERT INTO data_quality_issues(
                     issue_id, scope_type, scope_key, code, severity,
                     first_seen_at_ms, last_seen_at_ms, detail_json)
                 VALUES (?1, 'fact', ?2, 'missing_native_session_id', 'warning',
                         ?3, ?3, ?4)
                 ON CONFLICT(scope_type, scope_key, code)
                 DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms",
                rusqlite::params![
                    format!(
                        "missing_sid:{}",
                        fact.get("fact_id")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                    ),
                    source_id,
                    now,
                    format!("fact 缺 native_session_id：{fact}"),
                ],
            )
            .map_err(AuthorityError::from)?;
            outcome.rejected += 1;
        }
        for (sid, profile, group) in groups {
            writer.upsert_session(harness, machine_namespace, &sid, Some(&profile), now)?;
            let report = writer.insert_facts_with_extension(&group, &source_id, &sid, extension)?;
            outcome.inserted += report.inserted;
            outcome.duplicate += report.duplicate;
            outcome.rejected += report.rejected;
            outcome.enriched += report.enriched;
        }
        if !workflow_events.is_empty() {
            let workflow_report = agent_vitals_data::workflow::insert_events(
                conn,
                workflow_events,
                &source_id,
                &run_id,
                now,
            )?;
            outcome.workflow_changed =
                workflow_report.inserted + workflow_report.corrected;
        }
        // V16：任务意图摘录与 workflow 事件同一事务落库（同 source/run 归因）。
        if !session_excerpts.is_empty() {
            outcome.excerpts_changed = agent_vitals_data::workflow::insert_session_excerpts(
                conn,
                session_excerpts,
                &source_id,
                &run_id,
                now,
            )?;
        }
        // V32：解析产出的会话标题（claude ai-title；事实已先把 sessions 行
        // upsert 好，标题按自然键补上）。侧车索引型标题（codex/dsh）走独立的
        // apply_session_titles 趟，不经此路径。
        if !session_titles.is_empty() {
            outcome.titles_changed =
                apply_session_title_updates(conn, harness, machine_namespace, session_titles)?;
        }
        // 事件总线（spec §1.2）：FactsIngested 与本批事实**同事务**落 outbox——
        // 早于此处返回的空批短路（上方 is_empty 分支）不发射。
        //
        // **全重复重放也不发射**（RUNTIME_INVALIDATION spec §4.1，推翻此前
        // 「全重复也算同步发生过、照发」的决策）：领域消费者对 inserted=0 的
        // 批次本来就 no-op，而那一行 outbox 本身会让事务非空、推进权威 revision，
        // 让「源文件变了但没产出任何新事实」的 tick 照样向展示层发失效。
        // `rejected > 0` 仍发——数据质量问题是 issue 评估器要看的状态变化。
        //
        // R3-F4（REFRESH_STORM，2026-09-23）把同一判据延伸到 revision 本身：
        // 全重复重放此前虽不落 outbox，但事务里的 upsert 心跳行照旧推 revision
        // （P0 时代「事务非空、推进是接受的」口径作废）——现在按簿记静默提交，
        // 终裁见函数尾部的事实性谓词。
        // R3-F4 修订（评审 P2-1/P3-2/P3-3）：outbox 门与事实性终裁共用
        // outcome_has_new_facts / outcome_is_factual——单一判据源。
        if outcome_has_new_facts(&outcome) {
            // 载荷里的 revision = 本事务提交后的值：事务已有行变更，
            // `commit_advancing_revision` 必然 +1（spec §4.1）。
            let revision_after_commit =
                agent_vitals_data::authority::revision_of(conn)? + 1;
            crate::events::insert_outbox(
                conn,
                &crate::events::AppEvent::facts_ingested(
                    harness,
                    &run_id,
                    revision_after_commit,
                    outcome.inserted,
                    outcome.rejected,
                    outcome.duplicate,
                ),
                &run_id,
            )
            .map_err(|e| AuthorityError::Sqlite(
                rusqlite::Error::InvalidParameterName(format!("__event_outbox__:{e}")),
            ))?;
        }
        // R3-F4 事实性终裁：新事实之外补上归因富集（改 memo 面业务列）与
        // workflow/excerpt 实际落库行数；路由证据与快照腿在参数侧并入。
        // 全重复且零富集的重放按簿记静默——upsert 的 last_seen/updated_at
        // 心跳照常落库。
        Ok(((), outcome_is_factual(&outcome)
            || route_evidence.is_some()
            || runtime_snapshot.as_ref().is_some_and(|write| {
                !write.snapshots.is_empty() || write.backfill_marker.is_some()
            })))
    });

    match result {
        Ok(()) => db
            .finish_run(&run_id, "succeeded", None, None, now)
            .map_err(|e| format!("finish_run: {e}"))
            .map(|_| outcome),
        Err(e) => {
            let message = e.to_string();
            let _ = db.finish_run(&run_id, "failed", Some(ERR_DB_ERROR), Some(&message), now);
            Err(message)
        }
    }
}

/// 侧车索引型会话标题（codex `session_index.jsonl` / DSH `workspace.json`）的
/// 独立应用趟（V32）。索引每 tick 重读，与脏文件无关——用户重命名线程后
/// rollout 未变也要能刷标题。纪律：
/// - **先读后写**：全部标题与库内现值一致（含「会话行不存在」）→ 零写事务、
///   零 sync_runs 行（R3-F4：无变更轮不得留痕/推 revision）。
/// - 有变更才 begin_run + 单事务条件 UPDATE；变更行数返回给调用方上报告。
pub(crate) fn apply_session_titles(
    db: &AuthorityDb,
    harness: &str,
    machine_namespace: &str,
    titles: &[agent_vitals_domain::contracts::workflow::SessionTitle],
    now: i64,
) -> Result<usize, String> {
    // 预检：只留 validate 过关且「库里有行、值确有变化」的标题。
    let mut pending: Vec<&agent_vitals_domain::contracts::workflow::SessionTitle> = Vec::new();
    {
        let conn = db.conn();
        let mut stmt = conn
            .prepare(
                "SELECT title, title_source FROM sessions
                 WHERE harness = ?1 AND machine_namespace = ?2 AND native_session_id = ?3
                   AND deleted_at_ms IS NULL",
            )
            .map_err(|e| format!("titles precheck: {e}"))?;
        for title in titles {
            if title.validate().is_err() {
                continue;
            }
            let existing: Option<(Option<String>, Option<String>)> = stmt
                .query_row(
                    rusqlite::params![harness, machine_namespace, title.native_session_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map_err(|e| format!("titles precheck: {e}"))?;
            match existing {
                // 无会话行（索引条目从未被任何事实见过）→ 跳过：标题不凭空造楼。
                None => {}
                Some((t, s)) if t.as_deref() == Some(title.title.as_str())
                    && s.as_deref() == Some(title.source.as_str()) => {}
                Some(_) => pending.push(title),
            }
        }
    }
    if pending.is_empty() {
        return Ok(0);
    }
    let run_id = new_run_id(TRIGGER_SYNC);
    db.begin_run(&run_id, TRIGGER_SYNC, now)
        .map_err(|e| format!("begin_run {run_id}: {e}"))?;
    let result: Result<usize, AuthorityError> = db.with_immediate_txn(|conn| {
        let owned: Vec<agent_vitals_domain::contracts::workflow::SessionTitle> =
            pending.into_iter().cloned().collect();
        apply_session_title_updates(conn, harness, machine_namespace, &owned)
    });
    match result {
        Ok(changed) => db
            .finish_run(&run_id, "succeeded", None, None, now)
            .map_err(|e| format!("finish_run: {e}"))
            .map(|_| changed),
        Err(e) => {
            let message = e.to_string();
            let _ = db.finish_run(&run_id, "failed", Some(ERR_DB_ERROR), Some(&message), now);
            Err(message)
        }
    }
}

/// **迁移期双写的权威侧写入**（spec §6.1 迁移窗口）：调用方（sync_facts）
/// emit 一次，同一批事实既走旧链（ingest_facts，存量读面保鲜）也走本函数
/// （权威库）。`files` = (路径, 指纹, 该文件 facts)——emit 只发生一次，
/// 本函数不做 I/O。
///
/// Phase 3 读路径切换完成、`sql_authority_enabled` 设立后，旧链调用撤除，
/// 本函数成为唯一写入（届时可并入 `sync_harness_sql`）。
pub fn write_facts_to_authority(
    db: &AuthorityDb,
    harness: &str,
    machine_namespace: &str,
    files: &[(std::path::PathBuf, (u64, u64), Vec<Value>)],
    now: i64,
) -> Result<SqlSyncOutcome, String> {
    let run_id = new_run_id(TRIGGER_SYNC);
    db.begin_run(&run_id, TRIGGER_SYNC, now)
        .map_err(|e| format!("begin_run {run_id}: {e}"))?;

    let mut outcome = SqlSyncOutcome::default();
    let result: Result<(), AuthorityError> = db.with_immediate_txn(|conn| {
        let mut writer: Option<SqlFactWriter<'_>> = None;
        for (path, (size_bytes, mtime_ns), facts) in files {
            if writer.is_none() {
                writer = Some(SqlFactWriter::new(conn, &run_id, now)?);
            }
            let w = writer.as_ref().expect("writer 在首次使用前初始化");
            let mut distinct: Vec<&str> = Vec::new();
            for f in facts {
                if let Some(sid) = native_session_of(f) {
                    if !distinct.contains(&sid) {
                        distinct.push(sid);
                    }
                }
            }
            let file_sid: Option<&str> = if distinct.len() == 1 {
                Some(distinct[0])
            } else {
                None
            };
            let source_id =
                w.upsert_source_file(harness, path, *size_bytes, *mtime_ns, file_sid, PARSER_VERSION)?;
            if facts.is_empty() {
                outcome.files_synced += 1;
                continue;
            }
            let (groups, missing) = group_facts_by_session(facts);
            for f in &missing {
                conn.execute(
                    "INSERT INTO data_quality_issues(
                         issue_id, scope_type, scope_key, code, severity,
                         first_seen_at_ms, last_seen_at_ms, detail_json)
                     VALUES (?1, 'fact', ?2, 'missing_native_session_id', 'warning',
                             ?3, ?3, ?4)
                     ON CONFLICT(scope_type, scope_key, code)
                     DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms",
                    rusqlite::params![
                        format!(
                            "missing_sid:{}",
                            f.get("fact_id")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                        ),
                        source_id,
                        now,
                        format!("fact 缺 native_session_id：{}", f),
                    ],
                )
                .map_err(AuthorityError::from)?;
                outcome.rejected += 1;
            }
            for fact in facts.iter().filter(|fact| {
                fact.get("evidence_basis").and_then(Value::as_str) == Some("conflict")
            }) {
                let fact_id = fact
                    .get("fact_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                conn.execute(
                    "INSERT INTO data_quality_issues(
                         issue_id, scope_type, scope_key, code, severity,
                         first_seen_at_ms, last_seen_at_ms, detail_json)
                     VALUES (?1, 'fact', ?2, 'conflicting_route_evidence', 'warning',
                             ?3, ?3, ?4)
                     ON CONFLICT(scope_type, scope_key, code)
                     DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms,
                                   detail_json = excluded.detail_json",
                    rusqlite::params![
                        format!("route-conflict:{fact_id}"),
                        fact_id,
                        now,
                        serde_json::to_string(fact).unwrap_or_default(),
                    ],
                )
                .map_err(AuthorityError::from)?;
            }
            for (sid, profile, group) in groups {
                w.upsert_session(harness, machine_namespace, &sid, Some(&profile), now)?;
                let report = w.insert_facts(&group, &source_id, &sid)?;
                outcome.inserted += report.inserted;
                outcome.duplicate += report.duplicate;
                outcome.rejected += report.rejected;
            }
            outcome.files_synced += 1;
        }
        Ok(())
    });

    match result {
        Ok(()) => {
            db.finish_run(&run_id, "succeeded", None, None, now)
                .map_err(|e| format!("finish_run: {e}"))?;
            Ok(outcome)
        }
        Err(e) => {
            let msg = format!("{e}");
            let _ = db.finish_run(&run_id, "failed", Some(ERR_DB_ERROR), Some(&msg), now);
            Err(msg)
        }
    }
}

/// 迁移期双写的**扁平批次**变体：执行环境 emitter 产出的整批 facts（可能跨
/// 多文件）一次写入。source 落为批次标记行 `{harness}:sync`（批次级 provenance；
/// 会话下钻靠事实自身的 native_session_id）。事务纪律同 write_facts_to_authority。
pub fn write_flat_facts_to_authority(
    db: &AuthorityDb,
    harness: &str,
    machine_namespace: &str,
    facts: &[Value],
    now: i64,
) -> Result<SqlSyncOutcome, String> {
    let run_id = new_run_id(TRIGGER_SYNC);
    db.begin_run(&run_id, TRIGGER_SYNC, now)
        .map_err(|e| format!("begin_run {run_id}: {e}"))?;

    let mut outcome = SqlSyncOutcome::default();
    let result: Result<(), AuthorityError> = db.with_immediate_txn(|conn| {
        let writer = SqlFactWriter::new(conn, &run_id, now)?;
        let source_id = writer.upsert_batch_source(harness)?;
        let (groups, missing) = group_facts_by_session(facts);
        for f in &missing {
            conn.execute(
                "INSERT INTO data_quality_issues(
                     issue_id, scope_type, scope_key, code, severity,
                     first_seen_at_ms, last_seen_at_ms, detail_json)
                 VALUES (?1, 'fact', ?2, 'missing_native_session_id', 'warning',
                         ?3, ?3, ?4)
                 ON CONFLICT(scope_type, scope_key, code)
                 DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms",
                rusqlite::params![
                    format!(
                        "missing_sid:{}",
                        f.get("fact_id")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                    ),
                    source_id,
                    now,
                    format!("fact 缺 native_session_id：{}", f),
                ],
            )
            .map_err(AuthorityError::from)?;
            outcome.rejected += 1;
        }
        for (sid, profile, group) in groups {
            writer.upsert_session(harness, machine_namespace, &sid, Some(&profile), now)?;
            let report = writer.insert_facts(&group, &source_id, &sid)?;
            outcome.inserted += report.inserted;
            outcome.duplicate += report.duplicate;
            outcome.rejected += report.rejected;
        }
        Ok(())
    });

    match result {
        Ok(()) => {
            db.finish_run(&run_id, "succeeded", None, None, now)
                .map_err(|e| format!("finish_run: {e}"))?;
            Ok(outcome)
        }
        Err(e) => {
            let msg = format!("{e}");
            let _ = db.finish_run(&run_id, "failed", Some(ERR_DB_ERROR), Some(&msg), now);
            Err(msg)
        }
    }
}

/// 保留滚动的 cutoff（UTC ms）：`months_back` 个月前的月初 00:00（UTC）。
/// 月算术用 domain 的 civil 表（与 `dsh_days_map` 同源），不引 chrono。
pub fn retention_cutoff_ms(current_month: &str, months_back: u32) -> Option<i64> {
    let (y, m) = (
        current_month.get(0..4)?.parse::<i64>().ok()?,
        current_month.get(5..7)?.parse::<u32>().ok()?,
    );
    let total = (y * 12 + m as i64 - 1 - months_back as i64).max(0);
    agent_vitals_domain::usage::ms_from_civil(total / 12, (total % 12 + 1) as u32, 1, 0, 0, 0)
}

/// 对单执行环境执行 SQL 写入。
///
/// `dirty` = (路径, (size, mtime_ns)) 差集——**调用方算好**（sync_service 的
/// 发现/差量复用不变）；`emit` = 执行环境 emitter（同一函数）。本函数只管后
/// 半程：`sync_runs` 开批 → source_files/sessions/usage_facts 写入 → 收批。
///
/// 协议（spec §5.1.4）：begin_run（trigger="cli"）→ 一个 `with_immediate_txn`
/// 里逐文件「source_files upsert → emit → sessions upsert → insert_facts」→
/// finish_run。
///
/// - **文件级 emit 错误**：只收集进 `errors`、该文件不计 synced、批次不中止
///   ——与 JSONL 版「失败文件不进 checkpoint」的可重试语义完全一致；
/// - **DB 级错误**（upsert/insert 的 SQL 失败）：整批回滚到 0 写入（spec
///   §5.1.4「不许半提交」）→ run 标 failed + Err 上抛；
/// - **全失败**（零文件成交且 errors 非空）：run 标 failed + Err 上抛。
///
/// 批次的时间都取入口处 `now_ms()` 的一次读数（时钟注入点），不重复取。
pub fn sync_harness_sql(
    db: &AuthorityDb,
    data_home: &Path,
    harness: &str,
    machine_namespace: &str,
    dirty: &[(std::path::PathBuf, (u64, u64))],
    emit: impl Fn(&std::path::Path) -> Result<Vec<serde_json::Value>, String>,
) -> Result<SqlSyncOutcome, String> {
    let _ = data_home; // 文件发现/差量在调用方（本函数只吃 dirty 不碰 fs）
    let now = now_ms(); // 时钟注入点：本批所有 `*_at_ms` 用同一次读数
    let run_id = new_run_id(TRIGGER_SYNC);
    db.begin_run(&run_id, TRIGGER_SYNC, now)
        .map_err(|e| format!("begin_run {run_id}: {e}"))?;

    // **emit 在事务外**（审查 P2）：emit 是执行环境日志 I/O + 解析（毫秒到秒
    // 级），关进 BEGIN IMMEDIATE 会把写锁横跨 I/O 持有——并发读被无谓阻塞。
    // 先全部 emit 进内存，事务只包 DB 写入（spec §5.1.4 的事务语义指
    // 「写入原子性」，不要求把源读取也关进去）。文件级 emit 错误收集进
    // errors、不计 synced（重试语义与 JSONL 版一致）。
    let mut emitted: Vec<(std::path::PathBuf, u64, u64, Vec<Value>)> = Vec::new();
    let mut outcome = SqlSyncOutcome::default();
    for (path, (size_bytes, mtime_ns)) in dirty {
        match emit(path) {
            Ok(f) => emitted.push((path.clone(), *size_bytes, *mtime_ns, f)),
            Err(e) => outcome.errors.push(format!("{}: {e}", path.display())),
        }
    }

    let result: Result<(), AuthorityError> = db.with_immediate_txn(|conn| {
        // writer 惰性构造：若所有文件都在 emit 阶段失败（合法错误路径），
        // 一个 DB 写入都不发生——`new()` 的 run 预检不该成为失效点。
        let mut writer: Option<SqlFactWriter<'_>> = None;
        for (path, size_bytes, mtime_ns, facts) in &emitted {
            if writer.is_none() {
                writer = Some(SqlFactWriter::new(conn, &run_id, now)?);
            }
            let w = writer.as_ref().expect("writer 在首次使用前初始化");

            // 源文件 upsert：首见/再看都记录（size/mtime 指纹即下次差量的
            // 「已同步」对照）。native_session_id 从 emit 事实推断：
            // 单一会话带下去（claude/codex/dsh 一文件一会话），无/多会话则
            // None（源文件面的 native id 只是「主会话」提示，非强约束）。
            let mut distinct: Vec<&str> = Vec::new();
            for f in facts {
                if let Some(sid) = native_session_of(f) {
                    if !distinct.contains(&sid) {
                        distinct.push(sid);
                    }
                }
            }
            let file_sid: Option<&str> = if distinct.len() == 1 {
                Some(distinct[0])
            } else {
                None
            };
            let source_id =
                w.upsert_source_file(harness, path, *size_bytes, *mtime_ns, file_sid, PARSER_VERSION)?;

            if facts.is_empty() {
                // 无事实但有源文件 → 仍算 synced（元数据被记录，本批无账）
                outcome.files_synced += 1;
                continue;
            }
            let (groups, missing) = group_facts_by_session(facts);
            // 缺 native_session_id 的事实 → quality issue + rejected，
            // **不造 session**（审查 P2：fallback stem 孤儿会话行）。
            for f in &missing {
                conn.execute(
                    "INSERT INTO data_quality_issues(
                         issue_id, scope_type, scope_key, code, severity,
                         first_seen_at_ms, last_seen_at_ms, detail_json)
                     VALUES (?1, 'fact', ?2, 'missing_native_session_id', 'warning',
                             ?3, ?3, ?4)
                     ON CONFLICT(scope_type, scope_key, code)
                     DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms",
                    rusqlite::params![
                        format!(
                            "missing_sid:{}",
                            f.get("fact_id")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                        ),
                        source_id,
                        now,
                        format!("fact 缺 native_session_id：{}", f),
                    ],
                )
                .map_err(AuthorityError::from)?;
                outcome.rejected += 1;
            }
            for fact in facts.iter().filter(|fact| {
                fact.get("evidence_basis").and_then(Value::as_str) == Some("conflict")
            }) {
                let fact_id = fact
                    .get("fact_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                conn.execute(
                    "INSERT INTO data_quality_issues(
                         issue_id, scope_type, scope_key, code, severity,
                         first_seen_at_ms, last_seen_at_ms, detail_json)
                     VALUES (?1, 'fact', ?2, 'conflicting_route_evidence', 'warning',
                             ?3, ?3, ?4)
                     ON CONFLICT(scope_type, scope_key, code)
                     DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms,
                                   detail_json = excluded.detail_json",
                    rusqlite::params![
                        format!("route-conflict:{fact_id}"),
                        fact_id,
                        now,
                        serde_json::to_string(fact).unwrap_or_default(),
                    ],
                )
                .map_err(AuthorityError::from)?;
            }
            for (sid, profile, group) in groups {
                let sid_ref = sid.as_str();
                let profile_ref = profile.as_str();
                // 会话 upsert：profile 用分组归一值（与 writer 键构造同款
                // 缺省），insert 阶段逐事实键与组行字节一致。
                w.upsert_session(harness, machine_namespace, sid_ref, Some(profile_ref), now)?;
                let report = w.insert_facts(&group, &source_id, sid_ref)?;
                outcome.inserted += report.inserted;
                outcome.duplicate += report.duplicate;
                outcome.rejected += report.rejected;
            }
            outcome.files_synced += 1;
        }
        Ok(())
    });

    match result {
        Ok(_) => {}
        Err(e) => {
            let msg = format!("{e}");
            let _ = db.finish_run(&run_id, "failed", Some(ERR_DB_ERROR), Some(&msg), now);
            return Err(msg);
        }
    }

    if outcome.files_synced == 0 && !outcome.errors.is_empty() {
        let detail = outcome.errors.join("; ");
        db.finish_run(
            &run_id,
            "failed",
            Some(ERR_ALL_FILES_FAILED),
            Some(&detail),
            now,
        )
        .map_err(|e| format!("finish_run {run_id}: {e}"))?;
        return Err(detail);
    }

    db.finish_run(&run_id, "succeeded", None, None, now)
        .map_err(|e| format!("finish_run {run_id}: {e}"))?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_home(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "avr-sqlsync-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn open_db(home: &Path) -> AuthorityDb {
        AuthorityDb::open(&home.join("agent-vitals.sqlite3"), 1_000).unwrap()
    }

    #[test]
    fn extension_link_failure_rolls_back_checkpoint_facts_sessions_and_outbox() {
        use agent_vitals_data::extension_authority::*;
        use agent_vitals_data::fact_writer_sql::ExtensionFactContext;
        let home = tmp_home("extension-atomic");
        let db = open_db(&home);
        let revision = ExtensionRevision { revision_id:"local-zcode".into(),
            slot_type:"harness_manifest".into(), slot_id:"zcode".into(), content_sha256:"a".repeat(64),
            origin:RevisionOrigin::Local, schema_version:1, capabilities:serde_json::json!({}), installed_at_ms:1 };
        let slots = std::collections::BTreeMap::from([
            (("harness_manifest".into(), "zcode".into()), "local-zcode".into())]);
        activate(db.conn(), 0, &[revision], &slots, &"b".repeat(64), ActivationAction::Activate, 1).unwrap();
        let src = home.join("zcode.jsonl");
        let overrides = std::collections::HashMap::new();
        write_flat_facts_with_sources(&db, "harness:zcode", "m", &[(src.clone(), (10, 10))],
            &overrides, &[], &[], &[], None, None, 1_000).unwrap();
        let before = db.revision().unwrap();
        let fact = serde_json::json!({"harness":"harness:zcode", "machine_namespace":"m",
            "source_profile":"default", "native_session_id":"s1", "source_event_id":"e1",
            "observation_kind":"token_count", "event_ts_utc":"2026-09-23T01:02:03Z",
            "model_id":"claude-opus-4", "uncached_input_tokens":100,
            "cache_read_tokens":50, "cache_write_tokens":10, "output_tokens":5});
        let mut context = ExtensionFactContext { generation:0, revision_id:"local-zcode".into(),
            engine_version:"1.4.0".into() };
        assert!(write_flat_facts_with_sources_and_extension(&db, "harness:zcode", "m",
            &[(src.clone(), (99, 99))], &overrides, std::slice::from_ref(&fact),
            &[], &[], &[], None, None, 2_000, Some(&context)).is_err());
        assert_eq!(db.revision().unwrap(), before);
        for table in ["usage_facts", "extension_fact_provenance", "sessions", "event_outbox"] {
            let count: i64 = db.conn().query_row(&format!("SELECT COUNT(*) FROM {table}"), [],
                |row| row.get(0)).unwrap();
            assert_eq!(count, 0, "{table} must not survive a failed source link");
        }
        let checkpoint = crate::source_graph::read_checkpoint(db.conn(), "harness:zcode",
            &crate::source_graph::path_hash(&src)).unwrap().unwrap();
        assert_eq!(checkpoint.byte_offset, Some(10), "failed batch must not advance checkpoint");
        let source: (i64, i64) = db.conn().query_row(
            "SELECT size_bytes,mtime_ns FROM source_files WHERE harness='harness:zcode'", [],
            |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(source, (10, 10));
        context.generation = 1;
        let accepted = write_flat_facts_with_sources_and_extension(&db, "harness:zcode", "m",
            &[(src.clone(), (99, 99))], &overrides, std::slice::from_ref(&fact),
            &[], &[], &[], None, None, 3_000, Some(&context)).unwrap();
        assert_eq!(accepted.inserted, 1);
        assert_eq!(db.revision().unwrap(), before + 1);
        let checkpoint = crate::source_graph::read_checkpoint(db.conn(), "harness:zcode",
            &crate::source_graph::path_hash(&src)).unwrap().unwrap();
        assert_eq!(checkpoint.byte_offset, Some(99));
        for table in ["usage_facts", "extension_fact_provenance", "sessions", "event_outbox"] {
            let count: i64 = db.conn().query_row(&format!("SELECT COUNT(*) FROM {table}"), [],
                |row| row.get(0)).unwrap();
            assert_eq!(count, 1, "{table} commits together on retry");
        }
        drop(db);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn now_ms_is_positive_epoch_millis() {
        assert!(now_ms() > 1_600_000_000_000);
    }

    #[test]
    fn new_run_id_embeds_trigger_and_epoch_millis() {
        let id = new_run_id("cli");
        assert!(id.starts_with("cli:"));
        let suffix = id.rsplit(':').next().unwrap();
        assert!(
            suffix.parse::<i64>().is_ok(),
            "run_id 后缀应为毫秒时间戳: {id}"
        );
        assert!(new_run_id("migration").starts_with("migration:"));
    }

    /// R3-F4（REFRESH_STORM）：revision 只在事实性变更时前进。四个断言族：
    /// - 纯簿记轮（文件 mtime 变化、零事实、无快照）静默提交——revision 不动，
    ///   checkpoint 照常持久化（否则下轮重复解析）；
    /// - 簿记轮幂等：连跑两轮 revision 都不动；
    /// - 事实轮：revision +1 且 FactsIngested 落 outbox（P0 语义保持）；
    /// - 全重复重放：不推 revision、不加 outbox（outbox 压制判据延伸到
    ///   revision 本身；upsert 心跳行照常落库）。
    #[test]
    fn bookkeeping_round_commits_silently_while_facts_advance() {
        let home = tmp_home("f4-silent");
        let db = open_db(&home);
        let r0 = db.revision().unwrap();
        let no_overrides = std::collections::HashMap::new();

        // ① 纯簿记：只有源文件心跳 + checkpoint。
        let src = home.join("sessions").join("a.jsonl");
        let sources = vec![(src.clone(), (123_u64, 456_u64))];
        let outcome = write_flat_facts_with_sources(
            &db, "codex", "m", &sources, &no_overrides,
            &[], &[], &[], None, None, 1_000,
        )
        .unwrap();
        assert_eq!(outcome.files_synced, 1);
        assert_eq!(db.revision().unwrap(), r0, "纯簿记事务不得推进 revision");
        let hash = crate::source_graph::path_hash(&src);
        let checkpoint = crate::source_graph::read_checkpoint(db.conn(), "codex", &hash)
            .unwrap()
            .expect("checkpoint 必须照常持久化");
        assert_eq!(checkpoint.byte_offset, Some(123));

        // ② 再来一轮纯簿记（mtime 变了、仍零事实）：幂等静默。
        write_flat_facts_with_sources(
            &db, "codex", "m", &[(src, (123, 999))], &no_overrides,
            &[], &[], &[], None, None, 2_000,
        )
        .unwrap();
        assert_eq!(db.revision().unwrap(), r0, "簿记轮幂等：revision 仍不动");

        // ③ 事实轮：revision +1，FactsIngested 落 outbox。
        let fact = serde_json::json!({
            "harness": "claude-code", "machine_namespace": "m", "source_profile": "default",
            "native_session_id": "s1", "source_event_id": "e1",
            "observation_kind": "token_count",
            "event_ts_utc": "2026-09-23T01:02:03Z", "model_id": "claude-opus-4",
            "uncached_input_tokens": 100, "cache_read_tokens": 50,
            "cache_write_tokens": 10, "output_tokens": 5,
        });
        let claude_src = home.join("sessions").join("b.jsonl");
        let outcome = write_flat_facts_with_sources(
            &db, "claude-code", "m", &[(claude_src.clone(), (10, 10))], &no_overrides,
            std::slice::from_ref(&fact), &[], &[], None, None, 3_000,
        )
        .unwrap();
        assert_eq!(outcome.inserted, 1);
        assert_eq!(db.revision().unwrap(), r0 + 1, "事实轮必须推进 revision");
        let outbox: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM event_outbox WHERE event_type = 'FactsIngested'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outbox, 1, "事实轮落一条 FactsIngested");

        // ④ 全重复重放：不推 revision、不加 outbox。
        let outcome = write_flat_facts_with_sources(
            &db, "claude-code", "m", &[(claude_src, (10, 20))], &no_overrides,
            std::slice::from_ref(&fact), &[], &[], None, None, 4_000,
        )
        .unwrap();
        assert_eq!(outcome.inserted, 0);
        assert_eq!(outcome.duplicate, 1);
        assert_eq!(db.revision().unwrap(), r0 + 1, "全重复重放按簿记静默");
        let outbox2: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM event_outbox WHERE event_type = 'FactsIngested'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outbox2, 1, "全重复重放不追加 outbox 行");
    }

    /// R3-F4 评审 P3-7 补场景：快照轮与拒收轮都推 revision；富集轮（P2-1）
    /// ——存量事实的 NULL 归因列被重放填上——inserted=0 也必须推 revision，
    /// 否则 ReadMemo 四面会端旧归因直到下一个无关事实轮。
    #[test]
    fn snapshot_rejection_and_enrichment_rounds_advance_revision() {
        let home = tmp_home("f4-extra");
        let db = open_db(&home);
        let no_overrides = std::collections::HashMap::new();
        let r0 = db.revision().unwrap();

        // ① 快照轮（零事实）：配额滚动窗口载荷是用户可见状态 → 推进。
        let src = home.join("q.jsonl");
        let snapshot = RuntimeSnapshotWrite {
            snapshots: vec![RuntimeQuotaSnapshot {
                snapshot_kind: "codex_quota",
                payload_json: "{\"window\":1}",
                observed_at_ms: 7_000,
            }],
            backfill_marker: None,
        };
        write_flat_facts_with_sources(
            &db, "codex", "m", &[(src, (5, 5))], &no_overrides,
            &[], &[], &[], None, Some(snapshot), 5_000,
        )
        .unwrap();
        assert_eq!(db.revision().unwrap(), r0 + 1, "快照写入轮必须推进 revision");

        // ② 拒收轮：缺 native_session_id → rejected>0 → 推进 + outbox。
        let r1 = db.revision().unwrap();
        let bad = serde_json::json!({
            "harness": "claude-code", "machine_namespace": "m", "source_profile": "default",
            "source_event_id": "e-bad", "observation_kind": "token_count",
            "event_ts_utc": "2026-09-23T01:02:03Z", "model_id": "claude-opus-4",
            "uncached_input_tokens": 1, "output_tokens": 1,
        });
        let outcome = write_flat_facts_with_sources(
            &db, "claude-code", "m", &[(home.join("bad.jsonl"), (1, 1))], &no_overrides,
            std::slice::from_ref(&bad), &[], &[], None, None, 6_000,
        )
        .unwrap();
        assert!(outcome.rejected > 0, "缺 native_session_id 必须计拒收");
        assert_eq!(db.revision().unwrap(), r1 + 1, "拒收轮必须推进 revision");

        // ③ 富集轮（P2-1）：先落一条无归因的事实（provider 列 NULL），
        // 再以带 provider_id 的同源事实重放——inserted=0、duplicate=1，
        // 但 COALESCE 富集改了喂 memo 面的业务列 → 必须推 revision。
        let r2 = db.revision().unwrap();
        let base = serde_json::json!({
            "harness": "claude-code", "machine_namespace": "m", "source_profile": "default",
            "native_session_id": "s-enrich", "source_event_id": "e-enrich",
            "observation_kind": "token_count",
            "event_ts_utc": "2026-09-23T01:02:04Z", "model_id": "claude-opus-4",
            "uncached_input_tokens": 7, "cache_read_tokens": 0,
            "cache_write_tokens": 0, "output_tokens": 3,
        });
        write_flat_facts_with_sources(
            &db, "claude-code", "m", &[(home.join("enrich.jsonl"), (1, 1))], &no_overrides,
            std::slice::from_ref(&base), &[], &[], None, None, 7_000,
        )
        .unwrap();
        assert_eq!(db.revision().unwrap(), r2 + 1, "首插轮推进");
        let r3 = db.revision().unwrap();
        let enriched_replay = serde_json::json!({
            "harness": "claude-code", "machine_namespace": "m", "source_profile": "default",
            "native_session_id": "s-enrich", "source_event_id": "e-enrich",
            "observation_kind": "token_count",
            "event_ts_utc": "2026-09-23T01:02:04Z", "model_id": "claude-opus-4",
            "uncached_input_tokens": 7, "cache_read_tokens": 0,
            "cache_write_tokens": 0, "output_tokens": 3,
            "provider_id": "anthropic",
        });
        let outcome = write_flat_facts_with_sources(
            &db, "claude-code", "m", &[(home.join("enrich.jsonl"), (1, 2))], &no_overrides,
            std::slice::from_ref(&enriched_replay), &[], &[], None, None, 8_000,
        )
        .unwrap();
        assert_eq!(outcome.inserted, 0);
        assert_eq!(outcome.duplicate, 1);
        assert!(outcome.enriched > 0, "NULL 归因列被填上必须计 enriched");
        assert_eq!(
            db.revision().unwrap(),
            r3 + 1,
            "富集轮必须推进 revision（memo 面读到的归因变了）"
        );
        let provider: Option<String> = db
            .conn()
            .query_row(
                "SELECT provider_id FROM usage_facts WHERE source_event_id = 'e-enrich'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(provider.as_deref(), Some("anthropic"), "富集确实落库");
    }

    #[test]
    fn current_pricing_snapshot_carries_immutable_catalog_provenance() {
        let home = tmp_home("pricing-catalog");
        let db = open_db(&home);
        assert!(snapshot_current_pricing(&db).unwrap());
        assert!(!snapshot_current_pricing(&db).unwrap());
        let row: (String, String, String) = db.conn().query_row(
            "SELECT p.pricing_version, p.catalog_version, c.snapshot_id
             FROM pricing_snapshots p
             JOIN provider_catalog_snapshots c ON c.catalog_version = p.catalog_version",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(row.1, row.2);
        assert_eq!(row.1, format!("bc1-{}", row.0));
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// 2026-09-29：公共目录旧链路只存 `pricing.json`，快照里没有 `codex_pricing`，
    /// 一开启价格更新之后的 codex 用量全部算不出金额。叠加层链路落的快照必须
    /// 与内置快照同形，并且叠上同步来的新卡。
    #[test]
    fn sync_overlay_snapshot_keeps_codex_pricing_and_adds_synced_cards() {
        let home = tmp_home("pricing-sync-overlay");
        let db = open_db(&home);
        assert!(snapshot_current_pricing(&db).unwrap());
        let raw = br#"{"schema":"agent-vitals-pricing-sync/v1",
            "catalog":{"anthropic":{"currency":"USD","models":{"claude-opus-5-5":{"input_uncached":4,"input_cached":0.2,"output":20}}}},
            "codex_entries":[{"modelPrefix":"gpt-6-luna","speed":"standard","uncachedInputUsdPerMTok":"0.1","cacheReadUsdPerMTok":"0.01","outputUsdPerMTok":"0.5"}]}"#;
        let overlay = crate::pricing_catalog::validate_sync_overlay(raw).unwrap();
        assert!(snapshot_with_sync_overlay(&db, &overlay).unwrap(), "新卡 → 新版本");
        assert!(!snapshot_with_sync_overlay(&db, &overlay).unwrap(), "同一份叠加层重复拉取幂等");

        let (payload, catalog_version, source): (String, String, String) = db.conn().query_row(
            "SELECT payload_json, catalog_version, source_kind FROM pricing_snapshots
             ORDER BY captured_at_ms DESC, rowid DESC LIMIT 1",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        let v: Value = serde_json::from_str(&payload).unwrap();
        assert!(v["codex_pricing"]["entries"].as_array().unwrap().iter()
            .any(|e| e["modelPrefix"] == "gpt-6-luna"), "codex 新卡进了快照");
        assert!(v["codex_pricing"]["entries"].as_array().unwrap().len() > 1, "底表 codex 卡没丢");
        assert_eq!(v["pricing"]["catalog_2026_09"]["providers"]["anthropic"]["models"]["claude-opus-5-5"]["output"], 20);
        assert_eq!(catalog_version, overlay.version, "快照可追溯到生成它的叠加层");
        assert_eq!(source, agent_vitals_data::authority::PRICING_SYNC_OVERLAY_SOURCE);

        // 之后的日常同步（或 app 升级后）写内置快照时叠同一份叠加层：内容相同 → 不产生新版本
        assert!(!snapshot_current_pricing(&db).unwrap());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn migrate_missing_checkpoint_is_ok_zero_without_run() {
        let home = tmp_home("nomig");
        let db = open_db(&home);
        // data_home/facts/.ingest-checkpoint.json 不存在 → Ok(0) 且无任何 run
        assert_eq!(migrate_json_checkpoint(&db, &home, 2_000).unwrap(), 0);
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sync_runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "文件不存在时不产生迁移 run");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn migrate_schema_mismatch_is_noop_and_keeps_file() {
        let home = tmp_home("migsch");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        let cp = home.join("facts/.ingest-checkpoint.json");
        std::fs::write(&cp, r#"{"schema_version":2,"files":{}}"#).unwrap();
        let db = open_db(&home);
        assert_eq!(migrate_json_checkpoint(&db, &home, 2_000).unwrap(), 0);
        assert!(cp.exists(), "版本不符：不迁也不改名");
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM source_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn migrate_malformed_json_is_noop_and_keeps_file() {
        let home = tmp_home("migbad");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        let cp = home.join("facts/.ingest-checkpoint.json");
        std::fs::write(&cp, "{not json").unwrap();
        let db = open_db(&home);
        assert_eq!(migrate_json_checkpoint(&db, &home, 2_000).unwrap(), 0);
        assert!(cp.exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    // ---- 不依赖 fact_writer_sql 的实现（writer 由并行 agent 实现）----

    #[test]
    fn sync_with_no_dirty_files_commits_a_succeeded_cli_run() {
        let home = tmp_home("emptysync");
        let db = open_db(&home);
        let out = sync_harness_sql(&db, &home, "claude-code", "ns-test", &[], |_| Ok(vec![])).unwrap();
        assert_eq!(out.files_synced, 0);
        assert!(out.errors.is_empty());
        let (status, trigger): (String, String) = db
            .conn()
            .query_row(
                "SELECT status, trigger FROM sync_runs ORDER BY started_at_ms DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "succeeded");
        assert_eq!(trigger, "cli");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn sync_with_all_files_erroring_marks_run_failed_and_reports() {
        let home = tmp_home("allfail");
        let db = open_db(&home);
        let dirty = vec![
            (home.join("a.jsonl"), (0u64, 0u64)),
            (home.join("b.jsonl"), (0, 0)),
        ];
        let err = sync_harness_sql(&db, &home, "claude-code", "ns-test", &dirty, |_| {
            Err("boom".to_string())
        })
        .unwrap_err();
        assert!(err.contains("boom"), "错误细节应上抛: {err}");
        let (status, code): (String, Option<String>) = db
            .conn()
            .query_row(
                "SELECT status, error_code FROM sync_runs WHERE trigger = 'cli' LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(code.as_deref(), Some("all_files_failed"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn group_facts_by_session_splits_multi_session_batches() {
        let f1 = serde_json::json!({"native_session_id": "s-a", "source_profile": "default"});
        let f2 = serde_json::json!({"native_session_id": "s-a"});
        let f3 = serde_json::json!({"native_session_id": "s-b"});
        let (groups, missing) = group_facts_by_session(&[f1.clone(), f2.clone(), f3.clone()]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "s-a");
        assert_eq!(groups[0].1, "default", "无 profile 归一为 default");
        assert_eq!(groups[0].2.len(), 2);
        assert_eq!(groups[1].0, "s-b");
        assert!(missing.is_empty());

        // **profile 异构同 sid 拆两组**（审查 P2：组内异构会让逐事实外键
        // 与组行不一致 → 外键炸批）。
        let f4 = serde_json::json!({"native_session_id": "s-a", "source_profile": "other"});
        let (groups2, missing2) = group_facts_by_session(&[f1, f4]);
        assert_eq!(groups2.len(), 2, "profile 异构拆组");
        assert_eq!(groups2[1].1, "other");
        assert!(missing2.is_empty());

        // 缺 native_session_id（防御路径）→ missing 桶，**不造会话**。
        let f5 = serde_json::json!({"native_session_id": ""});
        let (groups3, missing3) = group_facts_by_session(&[f5]);
        assert!(groups3.is_empty());
        assert_eq!(missing3.len(), 1);
    }

    // ---- 端到端：writer 由并行 Agent 实现，未落地前 run 会 panic -- 这里
    // 端到端（writer 已落地，spec §8.2 矩阵）：

    #[test]
    fn migrate_checkpoint_populates_source_files_and_renames_file() {
        let home = tmp_home("mige2e");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        let cp = home.join("facts/.ingest-checkpoint.json");
        std::fs::write(
            &cp,
            r#"{
                "schema_version": 1,
                "machine_namespace": "m1",
                "files": {
                    "/data/claude/a.jsonl": {"size": 1024, "mtime_ns": 100, "harness": "claude-code"},
                    "/data/dsh/b.jsonl":    {"size": 2048, "mtime_ns": 200, "harness": "dsh"}
                }
            }"#,
        )
        .unwrap();
        let db = open_db(&home);
        let n = migrate_json_checkpoint(&db, &home, 5_000).unwrap();
        assert_eq!(n, 2);
        let rows: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM source_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
        assert!(!cp.exists());
        assert!(home.join("facts/.ingest-checkpoint.json.migrated").exists());
        // 迁移 run：succeeded + trigger=migration
        let (status, trigger, _): (String, String, i64) = db
            .conn()
            .query_row(
                "SELECT status, trigger, schema_version FROM sync_runs WHERE trigger = 'migration' LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "succeeded");
        assert_eq!(trigger, "migration");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn migrate_renamed_checkpoint_is_noop_on_second_call() {
        let home = tmp_home("migidem");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        let cp = home.join("facts/.ingest-checkpoint.json");
        std::fs::write(
            &cp,
            r#"{"schema_version":1,"files":{"/x.jsonl":{"size":1,"mtime_ns":1,"harness":"dsh"}}}"#,
        )
        .unwrap();
        let db = open_db(&home);
        assert_eq!(migrate_json_checkpoint(&db, &home, 5_000).unwrap(), 1);
        // 第二次：文件已改名（migrated），不再迁移
        assert_eq!(migrate_json_checkpoint(&db, &home, 6_000).unwrap(), 0);
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM source_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "重复迁移不重复插入");
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// RUNTIME_INVALIDATION spec 验收 9.15：同一批事实重放，第一次落 FactsIngested
    /// 并推进 revision；第二次全重复——不落 outbox 行、FactsIngested 计数不变。
    /// revision 因 `upsert_session.last_observed_at_ms` 仍会前进（源文件确实变过，
    /// 这是诚实的观测更新），本测试钉的是 outbox 面。
    #[test]
    fn all_duplicate_replay_writes_no_facts_ingested_row() {
        use agent_vitals_domain::usage_fact::build_usage_fact;

        let home = tmp_home("replay-dup");
        let db = open_db(&home);
        let mut fields = serde_json::Map::new();
        fields.insert("machine_namespace".into(), serde_json::json!("ns-dup"));
        fields.insert("harness".into(), serde_json::json!("claude-code"));
        fields.insert("source_profile".into(), serde_json::json!("default"));
        fields.insert("native_session_id".into(), serde_json::json!("sess-dup"));
        fields.insert("source_event_id".into(), serde_json::json!("evt-dup"));
        fields.insert("observation_kind".into(), serde_json::json!("assistant-usage"));
        fields.insert("event_ts_utc".into(), serde_json::json!("2026-09-06T10:00:00.000Z"));
        fields.insert("model_raw".into(), serde_json::json!("claude-sonnet-5"));
        fields.insert("uncached_input_tokens".into(), serde_json::json!(10));
        fields.insert("output_tokens".into(), serde_json::json!(4));
        let fact = build_usage_fact(&fields).unwrap();
        let outbox_rows = |db: &agent_vitals_data::authority::AuthorityDb| -> i64 {
            db.conn().query_row(
                "SELECT COUNT(*) FROM event_outbox WHERE event_type = 'FactsIngested'",
                [], |r| r.get(0),
            ).unwrap()
        };

        let no_overrides = std::collections::HashMap::new();
        let write = |now: i64| {
            write_flat_facts_with_sources(
                &db, "claude-code", "ns-dup", &[], &no_overrides,
                std::slice::from_ref(&fact), &[], &[], None, None, now,
            )
        };
        let first = write(1_000).unwrap();
        assert_eq!((first.inserted, first.duplicate), (1, 0));
        assert_eq!(outbox_rows(&db), 1);
        let rev_after_first = db.revision().unwrap();
        assert!(rev_after_first >= 1);
        // 验收 9.2：载荷里的 revision == 提交后的权威 revision。
        let payload: String = db.conn().query_row(
            "SELECT payload_json FROM event_outbox WHERE event_type = 'FactsIngested'", [], |r| r.get(0),
        ).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["revision"].as_u64(), Some(rev_after_first));

        let second = write(2_000).unwrap();
        assert_eq!((second.inserted, second.duplicate), (0, 1));
        assert_eq!(outbox_rows(&db), 1, "all-duplicate replay must not add a FactsIngested row");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn sync_harnesses_wraps_facts_source_session_in_one_transaction() {
        use agent_vitals_domain::usage_fact::build_usage_fact;

        let home = tmp_home("synce2e");
        let db = open_db(&home);
        let mut fields = serde_json::Map::new();
        fields.insert("machine_namespace".into(), serde_json::json!("ns-e2e"));
        fields.insert("harness".into(), serde_json::json!("claude-code"));
        fields.insert("source_profile".into(), serde_json::json!("default"));
        fields.insert("native_session_id".into(), serde_json::json!("sess-1"));
        fields.insert("source_event_id".into(), serde_json::json!("evt-1"));
        fields.insert(
            "observation_kind".into(),
            serde_json::json!("assistant-usage"),
        );
        fields.insert(
            "event_ts_utc".into(),
            serde_json::json!("2026-09-06T10:00:00.000Z"),
        );
        fields.insert("model_raw".into(), serde_json::json!("claude-sonnet-5"));
        fields.insert("uncached_input_tokens".into(), serde_json::json!(10));
        fields.insert("output_tokens".into(), serde_json::json!(4));
        let fact = build_usage_fact(&fields).unwrap();

        let dirty = vec![(home.join("sess-1.jsonl"), (1234u64, 5678u64))];
        let out = sync_harness_sql(&db, &home, "claude-code", "ns-e2e", &dirty, |_| {
            Ok(vec![fact.clone()])
        })
        .unwrap();
        assert_eq!(out.files_synced, 1);
        assert_eq!(out.inserted, 1);
        assert_eq!(out.duplicate, 0);
        assert_eq!(out.errors.len(), 0);

        let src: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM source_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src, 1);
        let sess: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sess, 1);
        let facts: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(facts, 1);

        // run 状态 succeeded
        let status: String = db
            .conn()
            .query_row(
                "SELECT status FROM sync_runs WHERE trigger = 'cli' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "succeeded");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn conflicting_route_fact_creates_quality_issue() {
        use agent_vitals_domain::usage_fact::build_usage_fact;

        let home = tmp_home("routeconflict");
        let db = open_db(&home);
        let mut fields = serde_json::Map::new();
        fields.insert("machine_namespace".into(), serde_json::json!("ns-conflict"));
        fields.insert("harness".into(), serde_json::json!("codex"));
        fields.insert("source_profile".into(), serde_json::json!("default"));
        fields.insert(
            "native_session_id".into(),
            serde_json::json!("sess-conflict"),
        );
        fields.insert("source_event_id".into(), serde_json::json!("evt-conflict"));
        fields.insert("observation_kind".into(), serde_json::json!("token_count"));
        fields.insert(
            "event_ts_utc".into(),
            serde_json::json!("2026-09-06T10:00:00.000Z"),
        );
        fields.insert("model_raw".into(), serde_json::json!("gpt-5.6-sol"));
        fields.insert("provider_id".into(), serde_json::json!("openai"));
        fields.insert("provider_raw".into(), serde_json::json!("openai"));
        fields.insert(
            "endpoint_host".into(),
            serde_json::json!("router.cogfoundry.ai"),
        );
        fields.insert("evidence_basis".into(), serde_json::json!("conflict"));
        fields.insert("billing_mode".into(), serde_json::json!("metered"));
        fields.insert(
            "pricing_basis".into(),
            serde_json::json!("metered_estimate"),
        );
        fields.insert("uncached_input_tokens".into(), serde_json::json!(10));
        fields.insert("output_tokens".into(), serde_json::json!(4));
        let fact = build_usage_fact(&fields).unwrap();
        let fact_id = fact["fact_id"].as_str().unwrap().to_string();
        assert_eq!(fact["evidence_basis"], "conflict");
        let dirty = vec![(home.join("sess-conflict.jsonl"), (1u64, 2u64))];
        sync_harness_sql(&db, &home, "codex", "ns-conflict", &dirty, |_| {
            Ok(vec![fact.clone()])
        })
        .unwrap();
        let issue: (String, String) = db
            .conn()
            .query_row(
                "SELECT scope_key, code FROM data_quality_issues ORDER BY issue_id LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(issue.0, fact_id);
        assert_eq!(issue.1, "conflicting_route_evidence");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn legacy_subscription_snapshot_becomes_pending_candidate_without_billing_user() {
        let home = tmp_home("legacy-subscription");
        let db = open_db(&home);
        let month = crate::clock::current_month_beijing();
        let payload = serde_json::json!({"pricing": {"catalog_2026_09": {
            "subscriptions": {
                "legacy-minimax": {
                    "provider": "minimax", "currency": "CNY", "amount_per_month": 114.0,
                    "reported_at": format!("{month}-01")
                },
                "legacy-glm": {
                    "provider": "zhipu-glm", "currency": "CNY", "amount_per_month": 118.0,
                    "reported_at": format!("{month}-01")
                }
            }
        }}}).to_string();
        db.pricing_snapshot_put("legacy-user-pricing", "legacy", &payload, 1).unwrap();
        db.harness_bill_put(
            "user-glm", "claude-code", "zhipu-glm", &month, "fixed_subscription",
            9_999, "CNY", "user-entry", 1,
        ).unwrap();
        db.harness_bill_put(
            "old-auto-minimax", "claude-code", "minimax", &month, "fixed_subscription",
            11_400, "CNY", "legacy-pricing-catalog", 1,
        ).unwrap();

        assert_eq!(migrate_legacy_subscription_snapshots(&db, 2).unwrap(), 2);
        let rows = db.harness_bills_for_period(&month).unwrap();
        assert!(!rows.iter().any(|(_harness, provider, _basis, _amount, _currency)| provider == "minimax"),
            "unconfirmed legacy declaration must not remain an actual bill: {rows:?}");
        assert!(rows.contains(&(
            "claude-code".to_string(), "zhipu-glm".to_string(),
            "fixed_subscription".to_string(), 9_999, "CNY".to_string(),
        )), "manual local bill must not be overwritten: {rows:?}");
        let candidates = db.pending_billing_import_candidates().unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().all(|(_id, _harness, _provider, _currency, _amount, _start, status)| status == "pending"));
        assert_eq!(migrate_legacy_subscription_snapshots(&db, 3).unwrap(), 0);
        assert_eq!(db.harness_bills_for_period(&month).unwrap(), rows);
        assert_eq!(db.pending_billing_import_candidates().unwrap(), candidates);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn legacy_subscription_migration_rolls_back_revoke_when_candidate_write_fails() {
        let home = tmp_home("legacy-subscription-rollback");
        let db = open_db(&home);
        let month = crate::clock::current_month_beijing();
        let payload = serde_json::json!({"pricing": {"catalog_2026_09": {
            "subscriptions": {
                "legacy-minimax": {
                    "provider": "minimax", "currency": "CNY", "amount_per_month": 114.0,
                    "reported_at": format!("{month}-01")
                }
            }
        }}}).to_string();
        db.pricing_snapshot_put("legacy-user-pricing-rollback", "legacy", &payload, 1).unwrap();
        db.harness_bill_put(
            "old-auto-minimax", "claude-code", "minimax", &month, "fixed_subscription",
            11_400, "CNY", "legacy-pricing-catalog", 1,
        ).unwrap();
        db.conn().execute_batch(
            "CREATE TRIGGER fail_legacy_candidate
             BEFORE INSERT ON billing_import_candidates
             BEGIN SELECT RAISE(ABORT, 'forced candidate failure'); END;",
        ).unwrap();

        assert!(migrate_legacy_subscription_snapshots(&db, 2).is_err());
        let bills = db.harness_bills_for_period(&month).unwrap();
        assert!(bills.iter().any(|(_harness, provider, _basis, amount, _currency)| {
            provider == "minimax" && *amount == 11_400
        }), "failed migration must roll back the legacy-bill revoke: {bills:?}");
        assert!(db.pending_billing_import_candidates().unwrap().is_empty());
        std::fs::remove_dir_all(&home).unwrap();
    }

    /// V32 会话标题（City 楼名）的写入纪律，三个断言族：
    /// - 主写入路径（claude 解析产出）：事实先把 sessions 行 upsert 好，标题
    ///   按自然键补上；同批重放（全 duplicate + 标题未变）titles_changed=0、
    ///   revision 不动（R3-F4：索引/重扫每 tick 重读，无变更轮必须静默）；
    /// - 独立趟（codex/dsh 侧车索引）：标题真变时应用 + 推 revision；无变更
    ///   重跑零写、零 sync_runs 行（REFRESH_STORM：不留每 tick 心跳批次）；
    /// - 索引条目指向不存在的会话 → 安静跳过（标题不凭空造会话/楼）。
    #[test]
    fn session_titles_apply_conditionally_and_stay_silent_without_change() {
        use agent_vitals_domain::contracts::workflow::SessionTitle;
        let home = tmp_home("v32-titles");
        let db = open_db(&home);
        let src = home.join("s.jsonl");
        let overrides = std::collections::HashMap::new();
        let fact = serde_json::json!({"harness":"claude-code", "machine_namespace":"m",
            "source_profile":"default", "native_session_id":"s1", "source_event_id":"e1",
            "observation_kind":"token_count", "event_ts_utc":"2026-09-23T01:02:03Z",
            "model_id":"claude-sonnet-5", "uncached_input_tokens":100,
            "cache_read_tokens":50, "cache_write_tokens":10, "output_tokens":5});
        let title = SessionTitle {
            native_session_id: "s1".to_string(),
            title: "修复菜单栏图标".to_string(),
            source: "claude_ai_title".to_string(),
        };
        // 主写入路径：事实 + 标题同批 → sessions 行带标题。
        let outcome = write_flat_facts_with_sources_and_extension(&db, "claude-code", "m",
            &[(src.clone(), (10, 10))], &overrides, std::slice::from_ref(&fact),
            &[], &[], std::slice::from_ref(&title), None, None, 1_000, None).unwrap();
        assert_eq!(outcome.inserted, 1);
        assert_eq!(outcome.titles_changed, 1);
        let stored: (String, String) = db.conn().query_row(
            "SELECT title, title_source FROM sessions WHERE native_session_id = 's1'", [],
            |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(stored, ("修复菜单栏图标".to_string(), "claude_ai_title".to_string()));
        // 同批重放：事实全 duplicate、标题未变 → titles_changed=0、revision 不动。
        let revision = db.revision().unwrap();
        let replay = write_flat_facts_with_sources_and_extension(&db, "claude-code", "m",
            &[(src.clone(), (10, 10))], &overrides, std::slice::from_ref(&fact),
            &[], &[], std::slice::from_ref(&title), None, None, 2_000, None).unwrap();
        assert_eq!(replay.duplicate, 1);
        assert_eq!(replay.titles_changed, 0);
        assert_eq!(db.revision().unwrap(), revision, "无标题变更的重放不得推 revision");

        // 独立趟：同值重跑 → 0 且不产生新 sync_runs 批次（先读后写纪律）。
        let runs_before: i64 = db.conn().query_row("SELECT COUNT(*) FROM sync_runs", [],
            |row| row.get(0)).unwrap();
        assert_eq!(apply_session_titles(&db, "claude-code", "m",
            std::slice::from_ref(&title), 3_000).unwrap(), 0);
        let runs_after: i64 = db.conn().query_row("SELECT COUNT(*) FROM sync_runs", [],
            |row| row.get(0)).unwrap();
        assert_eq!(runs_before, runs_after, "无变更轮不得留下 sync_runs 批次");
        assert_eq!(db.revision().unwrap(), revision);

        // 独立趟：重命名（codex 侧车索引的典型场景——rollout 未变）→ 应用 + 推 revision。
        let renamed = SessionTitle {
            native_session_id: "s1".to_string(),
            title: "修复菜单栏图标（改名）".to_string(),
            source: "claude_ai_title".to_string(),
        };
        assert_eq!(apply_session_titles(&db, "claude-code", "m",
            std::slice::from_ref(&renamed), 4_000).unwrap(), 1);
        assert_eq!(db.revision().unwrap(), revision + 1);
        let stored: (String, String) = db.conn().query_row(
            "SELECT title, title_source FROM sessions WHERE native_session_id = 's1'", [],
            |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(stored.0, "修复菜单栏图标（改名）");

        // 索引条目指向不存在的会话 → 安静跳过（0 行，无 run，无 revision）。
        let orphan = SessionTitle {
            native_session_id: "never-seen".to_string(),
            title: "幽灵会话".to_string(),
            source: "codex_thread_name".to_string(),
        };
        let revision = db.revision().unwrap();
        assert_eq!(apply_session_titles(&db, "claude-code", "m",
            std::slice::from_ref(&orphan), 5_000).unwrap(), 0);
        assert_eq!(db.revision().unwrap(), revision);
        drop(db);
        std::fs::remove_dir_all(&home).unwrap();
    }
}
