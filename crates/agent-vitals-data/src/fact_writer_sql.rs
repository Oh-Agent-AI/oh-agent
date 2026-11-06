//! v0.9.1 Phase 2（spec §5.1）：`usage_facts` 的唯一 SQL 写入口。
//!
//! 接口契约钉死在 `docs/AGENT_VITALS_V0_9_1_IMPLEMENTATION_PLAN.md`
//! Phase 2 节，本文件实现不得改签名。
//!
//! 事务边界：`SqlFactWriter` **不开事务**——调用方用 `with_immediate_txn`
//! 包「upsert sources/sessions + insert_facts」整段（spec §5.1.4），嵌套
//! BEGIN 是 SQLite 错误。
//!
//! 校验纪律（spec §5.1.3）：不合格 candidate 不静默丢，写
//! `data_quality_issues`（scope_type="fact"），合格项才进 `usage_facts`。

use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;

use crate::authority::AuthorityError;

/// 一次 insert_facts 的结果（spec §5.1.4 的可观测结果）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SqlInsertReport {
    pub inserted: usize,
    pub duplicate: usize,
    pub rejected: usize,
    /// 重复路径上的**归因状态变更**行数（REFRESH_STORM R3-F4 评审 P2-1）：
    /// 重分类 UPDATE / 干净重放收敛冲突 / COALESCE 富集把 NULL 归因列填上。
    /// 这些写入不改事实身份（inserted=0），但真的会改喂 ReadMemo 四面
    /// （monthly/daily/calendar/hourly）的 provider/billing 业务列——调用方
    /// 的事实性/revision 谓词必须把它当状态变更计入。
    pub enriched: usize,
}

/// Immutable extension selection pinned before parsing a batch. Duplicate facts
/// keep their original provenance; this context only applies to new inserts.
#[derive(Debug, Clone)]
pub struct ExtensionFactContext {
    pub generation: i64,
    pub revision_id: String,
    pub engine_version: String,
}

/// SQL 事实写入器。绑定 sync_runs 批次与注入时钟。
#[derive(Debug)]
pub struct SqlFactWriter<'a> {
    conn: &'a Connection,
    run_id: String,
    now_ms: i64,
}

/// ISO 事实时间戳 → 是否高峰（1/0）。派生链：`iso_to_ms` → `is_peak_slot`
/// （北京 9-12/14-18 工作日，与 fold 侧 peak_* 桶同一把尺）。解析失败/缺 ts
/// → 0：宁可少算峰值不臆造。（Phase 4.3 从退役的 `store` 模块移来——它此前
/// 与 `iso_to_ms` 分居两处，现在合并到唯一调用点旁。）
pub(crate) fn peak_of(ts: &str) -> i64 {
    match iso_to_ms(ts) {
        Some(ms) => i64::from(agent_vitals_domain::usage::is_peak_slot(ms)),
        None => 0,
    }
}

/// ISO 事实时间戳 → UTC 毫秒。尾部：小数秒任意、Z/z → 偏移 0、±HH:MM →
/// 偏移归一）。格式不齐全 → None（记 invalid，不猜时间）。
pub(crate) fn iso_to_ms(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let y = ts.get(0..4)?.parse::<i64>().ok()?;
    let mo = ts.get(5..7)?.parse::<u32>().ok()?;
    let d = ts.get(8..10)?.parse::<u32>().ok()?;
    let hh = ts.get(11..13)?.parse::<i64>().ok()?;
    let mi = ts.get(14..16)?.parse::<i64>().ok()?;
    let ss = ts.get(17..19)?.parse::<i64>().ok()?;
    if !(1..=12).contains(&mo) || d < 1 {
        return None;
    }
    let mut rest = &ts[19..];
    let mut offset_min: i64 = 0;
    if rest.ends_with('Z') || rest.ends_with('z') {
        rest = &rest[..rest.len() - 1];
    } else if let Some(pos) = rest.rfind(['+', '-']) {
        let (frac, off) = rest.split_at(pos);
        match (
            off.get(1..3).and_then(|s| s.parse::<i64>().ok()),
            off.get(4..6).and_then(|s| s.parse::<i64>().ok()),
            off.len() == 6,
        ) {
            (Some(oh), Some(om), true) => {
                let sign = if off.starts_with('-') { -1 } else { 1 };
                offset_min = sign * (oh * 60 + om);
                rest = frac;
            }
            _ => return None,
        }
    }
    if !rest.is_empty() && !rest.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        return None;
    }
    agent_vitals_domain::usage::ms_from_civil(y, mo, d, hh as u32, mi as u32, ss as u32)
        .map(|ms| ms - offset_min * 60_000)
}

/// r2a 会话键——**长度前缀自定界**（`SessionKey::ledger_key`，域契约的
/// 同一构造）。审查 P1：朴素 `{harness}:{ns}:{profile}:{sid}` 拼接会让
/// `("ab","c")` 与 `("a","bc")` 撞同一个 key（执行环境原生 id 含 `:` 是自由
/// 形状），且 Phase 3 的会话下钻要用 r2a 键重建——必须与全仓同一构造。
/// `upsert_session` 与 `insert_facts` 走同一函数保证外键一致；profile 缺省
/// "default"（与既有 r2a 消费方同款）。
fn session_key(
    harness: &str,
    machine_namespace: &str,
    native_session_id: &str,
    source_profile: Option<&str>,
) -> String {
    agent_vitals_domain::contracts::session_key::SessionKey::new(
        harness,
        native_session_id,
        source_profile.unwrap_or("default"),
        machine_namespace,
    )
    .ledger_key()
}

/// fact 文档逐字读字段（空串视为无；缺失/Null 数值 → 0）。
struct FactReader<'a> {
    obj: &'a serde_json::Map<String, Value>,
}

impl<'a> FactReader<'a> {
    fn s(&self, k: &str) -> Option<&'a str> {
        self.obj
            .get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    }
    fn i(&self, k: &str) -> i64 {
        self.obj.get(k).and_then(Value::as_i64).unwrap_or(0)
    }
}

/// 任意 Value 的稳定摘要 hash（无 fact_id / 连对象都不是时的 scope_key）。
fn stable_hash(v: &Value) -> String {
    agent_vitals_domain::source_identity::fnv1a64_hex(
        serde_json::to_string(v).unwrap_or_default().as_bytes(),
    )
}

impl<'a> SqlFactWriter<'a> {
    /// 绑定连接 + 批次 + 注入时钟。预检 run_id 存在（外键防线前置）。
    pub fn new(conn: &'a Connection, run_id: &str, now_ms: i64) -> Result<Self, AuthorityError> {
        // `ingested_run_id REFERENCES sync_runs` 在 INSERT 时才失败；
        // 前置成显式错误让调用方在写任何事实前就知道 run 不存在。
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_runs WHERE run_id = ?1)",
            rusqlite::params![run_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AuthorityError::Sqlite(
                rusqlite::Error::InvalidParameterName(format!("__run_id_not_found__:{run_id}")),
            ));
        }
        Ok(Self {
            conn,
            run_id: run_id.to_string(),
            now_ms,
        })
    }

    /// source_files upsert。path_hash = fnv1a64(路径)，明文路径不进库。
    /// 返回 source_id = `{harness}:{path_hash}`。首见 INSERT 全量，再见只更新
    /// last_seen_at_ms + (size, mtime) 指纹（含 parser/native 刷新）。
    pub fn upsert_source_file(
        &self,
        harness: &str,
        path: &Path,
        size_bytes: u64,
        mtime_ns: u64,
        native_session_id: Option<&str>,
        parser_version: i64,
    ) -> Result<String, AuthorityError> {
        let path_hash =
            agent_vitals_domain::source_identity::fnv1a64_hex(path.to_string_lossy().as_bytes());
        let source_id = format!("{harness}:{path_hash}");
        self.conn.execute(
            "INSERT INTO source_files(
                 source_id, harness, path_hash, native_session_id,
                 size_bytes, mtime_ns, content_fingerprint, parser_version,
                 first_seen_at_ms, last_seen_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8,?8)
             ON CONFLICT(harness, path_hash) DO UPDATE SET
                 size_bytes = excluded.size_bytes,
                 mtime_ns = excluded.mtime_ns,
                 native_session_id = excluded.native_session_id,
                 parser_version = excluded.parser_version,
                 last_seen_at_ms = excluded.last_seen_at_ms",
            rusqlite::params![
                source_id,
                harness,
                path_hash,
                native_session_id,
                size_bytes as i64,
                mtime_ns as i64,
                parser_version,
                self.now_ms,
            ],
        )?;
        Ok(source_id)
    }

    /// sessions upsert：session_key 键构造与 insert_facts 一致；冲突按
    /// UNIQUE(harness, machine_namespace, native_session_id) 更新 last_observed，
    /// started_at_ms 仅首见写。
    pub fn upsert_session(
        &self,
        harness: &str,
        machine_namespace: &str,
        native_session_id: &str,
        source_profile: Option<&str>,
        last_observed_ms: i64,
    ) -> Result<String, AuthorityError> {
        let key = session_key(harness, machine_namespace, native_session_id, source_profile);
        self.conn.execute(
            "INSERT INTO sessions(
                 session_key, harness, native_session_id, machine_namespace,
                 source_profile, started_at_ms, last_observed_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?6)
             ON CONFLICT(harness, machine_namespace, native_session_id) DO UPDATE SET
                 source_profile = COALESCE(excluded.source_profile, sessions.source_profile),
                 last_observed_at_ms = excluded.last_observed_at_ms",
            rusqlite::params![
                key,
                harness,
                native_session_id,
                machine_namespace,
                source_profile,
                last_observed_ms,
            ],
        )?;
        Ok(key)
    }

    /// 存量迁移（spec §6.2.1）：facts JSONL 重放 → 权威库。**JSONL 是迁移期
    /// 最高保真源**（已清洗、有 fact_id）——同 fact_id 重放全部 duplicate，
    /// 幂等可重跑。JSONL 文件本身注册为 source（来源标记）。整文件一批会
    /// 混多会话 → 按 native_session_id 分组逐批走 `insert_facts`（同一校验
    /// 与幂等路径，不另开第二套写入）。
    /// 必须已在一个事务内（调用方 with_immediate_txn）。
    pub fn import_facts_jsonl(
        &self,
        harness: &str,
        jsonl_path: &Path,
    ) -> Result<SqlInsertReport, AuthorityError> {
        use crate::evidence::replay;
        let rep = replay(jsonl_path).map_err(|e| match e {
            crate::evidence::AppendError::Corrupt { line_no } => {
                AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(format!(
                    "facts jsonl corrupt line {line_no} — 先修源再迁移"
                )))
            }
            crate::evidence::AppendError::Io(e) => AuthorityError::Io(e),
            crate::evidence::AppendError::Invalid(_) => {
                unreachable!("replay() never validates facts")
            }
        })?;

        // JSONL 文件注册为 source（迁移期输入的来源标记；路径哈希入
        // source_files，明文不进库）。
        let meta = std::fs::metadata(jsonl_path).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let source_id = self.upsert_source_file(harness, jsonl_path, size, mtime, None, 1)?;

        // 按 (native_session_id, machine_namespace, source_profile) 分组——
        // insert_facts 逐事实算 session_key 外键，sessions 行必须先以**同键**
        // upsert（迁移路径与 sql_sync 的会话预处理同纪律）。
        let mut groups: std::collections::BTreeMap<
            (String, String, String),
            Vec<serde_json::Value>,
        > = std::collections::BTreeMap::new();
        let mut orphans: Vec<serde_json::Value> = Vec::new();
        for fact in &rep.facts {
            let sid = fact.get("native_session_id").and_then(Value::as_str);
            let ns = fact.get("machine_namespace").and_then(Value::as_str);
            match (sid, ns) {
                (Some(sid), Some(ns)) if !sid.is_empty() => {
                    let profile = fact
                        .get("source_profile")
                        .and_then(Value::as_str)
                        .unwrap_or("default");
                    groups
                        .entry((sid.to_string(), ns.to_string(), profile.to_string()))
                        .or_default()
                        .push(fact.clone());
                }
                _ => orphans.push(fact.clone()),
            }
        }

        let mut report = SqlInsertReport::default();
        for ((sid, ns, profile), group) in groups {
            self.upsert_session(harness, &ns, &sid, Some(&profile), self.now_ms)?;
            // 事实带 `route_evidence_id` 时先落 route_evidence 行（与 sql_sync 的
            // 预插入同纪律），否则 usage_facts 的 FK 触发器会让整个迁移中止——
            // claude-code emitter 自 provider-v1.0-beta.1 起会带这个字段（验收审查
            // iteration 1 #4）。
            self.insert_route_evidence_rows(harness, &ns, &sid, &group, &source_id)?;
            let r = self.insert_facts(&group, &source_id, &sid)?;
            report.inserted += r.inserted;
            report.duplicate += r.duplicate;
            report.rejected += r.rejected;
        }
        // 孤儿（缺 native_session_id）：老 JSONL 版 ingest 允许（native 缺失
        // 不致命），迁移期同样不丢账——它们挂在文件 stem 会话下。
        if !orphans.is_empty() {
            let stem = jsonl_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();
            let r = self.insert_facts(&orphans, &source_id, &stem)?;
            report.inserted += r.inserted;
            report.duplicate += r.duplicate;
            report.rejected += r.rejected;
        }
        Ok(report)
    }

    /// 批次标记 source（`write_flat_facts_to_authority` 用）：跨文件的
    /// 扁平批次没有单一源文件——落一行合成 source（路径 = `/sync/{harness}`，
    /// 经哈希只留指纹）。返回 source_id = `{harness}:{fnv1a64(路径)}`（与
    /// upsert_source_file 同构；**Phase 3 差量/repair 必须排除此类合成行**
    /// ——size/mtime 恒 0，按文件指纹判定会把它们当 vanished 假阳性）。
    pub fn upsert_batch_source(&self, harness: &str) -> Result<String, AuthorityError> {
        self.upsert_source_file(harness, Path::new(&format!("/sync/{harness}")), 0, 0, None, 1)
    }

    /// 事实批写入。每 candidate：契约校验（build_usage_fact 同款）→ 不合格
    /// 写 data_quality_issues（id = fact_invalid:{fact_id 或摘要 hash}），
    /// 合格项 INSERT INTO usage_facts ON CONFLICT DO NOTHING。
    /// 混多 native_session_id → Err（调用方 bug，按批断言）。
    pub fn insert_facts(
        &self,
        facts: &[serde_json::Value],
        source_id: &str,
        native_session_id: &str,
    ) -> Result<SqlInsertReport, AuthorityError> {
        self.insert_facts_with_extension(facts, source_id, native_session_id, None)
    }

    /// Link new facts in the caller's write transaction. A relation failure must
    /// propagate so the caller rolls back facts, checkpoints and invalidations.
    pub fn insert_facts_with_extension(
        &self,
        facts: &[serde_json::Value],
        source_id: &str,
        native_session_id: &str,
        extension: Option<&ExtensionFactContext>,
    ) -> Result<SqlInsertReport, AuthorityError> {
        if let Some(context) = extension {
            if self.conn.is_autocommit() || context.engine_version.is_empty() {
                return Err(AuthorityError::from(rusqlite::Error::InvalidParameterName(
                    "extension facts require a write transaction and engine version".to_string(),
                )));
            }
        }
        let mut report = SqlInsertReport::default();
        for fact in facts {
            let obj = match fact.as_object() {
                Some(o) => o,
                None => {
                    self.write_rejected(
                        &stable_hash(fact),
                        &["candidate must be a JSON object".to_string()],
                    )?;
                    report.rejected += 1;
                    continue;
                }
            };
            // 批内会话断言：事实携带的 native_session_id 必须等于 batch 参数。
            if let Some(sid) = obj
                .get("native_session_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                if sid != native_session_id {
                    return Err(AuthorityError::Sqlite(
                        rusqlite::Error::InvalidParameterName(format!(
                            "__mixed_session_batch__:{sid} != {native_session_id}"
                        )),
                    ));
                }
            }

            let mut problems: Vec<String> = Vec::new();
            let mut doc: Option<Value> = None;
            let mut ts_ms: Option<i64> = None;

            // 1) 契约校验（身份四边形 + token 非负）
            match agent_vitals_domain::usage_fact::build_usage_fact(obj) {
                Ok(d) => {
                    // 2) 时间戳必须可 parse——无时间戳的事实不入账
                    match obj.get("event_ts_utc").and_then(Value::as_str) {
                        Some(ts) if !ts.is_empty() => match iso_to_ms(ts) {
                            Some(ms) => {
                                doc = Some(d);
                                ts_ms = Some(ms);
                            }
                            None => problems.push(format!("unparseable event_ts_utc: `{ts}`")),
                        },
                        _ => problems.push("missing or empty event_ts_utc".to_string()),
                    }
                }
                Err(p) => problems.extend(p),
            }

            let Some(built) = doc else {
                let scope = obj
                    .get("fact_id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| stable_hash(fact));
                self.write_rejected(&scope, &problems)?;
                report.rejected += 1;
                continue;
            };
            let r = FactReader {
                obj: built.as_object().expect("build 产物必为对象"),
            };
            let harness = r.s("harness").unwrap_or_default().to_string();
            let ns = r.s("machine_namespace").unwrap_or_default().to_string();
            let sid = r.s("native_session_id").unwrap_or_default().to_string();
            let profile = r.s("source_profile");
            let skey = session_key(&harness, &ns, &sid, profile);
            let ts_ms = ts_ms.expect("doc 只在事件时间可 parse 时才 Some——此处必有毫秒"); // 见上方校验：doc 非 None 即 ts 已 parse
            let peak = peak_of(r.s("event_ts_utc").unwrap_or_default());
            let model_id = r
                .s("model_id")
                .or_else(|| r.s("model_raw"))
                .map(str::to_string);
            let provider_id = r.s("provider_id").map(str::to_string);
            let provider_raw = r.s("provider_raw").map(str::to_string);
            let billing_source = r.s("billing_source").map(str::to_string);
            let billing_mode = r.s("billing_mode").map(str::to_string);
            let pricing_basis = r.s("pricing_basis").map(str::to_string);
            let billing_template_id = r.s("billing_template_id").map(str::to_string);
            let evidence_basis = r.s("evidence_basis").map(str::to_string);
            let normalization_version = r.s("normalization_version").map(str::to_string);
            let route_evidence_id = r.s("route_evidence_id").map(str::to_string);
            let attribution_version = r.s("attribution_version").map(str::to_string);

            let n = self.conn.execute(
                "INSERT INTO usage_facts(
                     fact_id, harness, machine_namespace, native_session_id, session_key,
                     source_event_id, observation_kind, source_profile,
                     provider_id, provider_raw, billing_source, billing_mode,
                     pricing_basis, billing_template_id, evidence_basis, normalization_version,
                     route_evidence_id, attribution_version,
                     model_id, event_ts_ms, event_peak,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     source_id, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)
                 ON CONFLICT DO NOTHING",
                rusqlite::params![
                    r.s("fact_id").unwrap_or_default(),
                    harness, ns, sid, skey,
                    r.s("source_event_id").unwrap_or_default(),
                    r.s("observation_kind").unwrap_or_default(),
                    r.s("source_profile"),
                    provider_id,
                    provider_raw,
                    billing_source,
                    billing_mode,
                    pricing_basis,
                    billing_template_id,
                    evidence_basis,
                    normalization_version,
                    route_evidence_id,
                    attribution_version,
                    model_id,
                    ts_ms,
                    peak,
                    r.i("uncached_input_tokens"),
                    r.i("cache_read_tokens"),
                    r.i("cache_write_tokens"),
                    r.i("output_tokens"),
                    source_id,
                    self.run_id,
                    self.now_ms,
                    self.now_ms,
                ],
            )?;
            if n == 0 {
                // 第三个分量 = COALESCE 富集是否会真的填上 NULL 归因列
                // （评审 P2-1：这种写入改喂 ReadMemo 面的业务列，必须计入
                // report.enriched，否则全重复重放轮会静默提交、memo 面端旧归因）。
                let (reclassification, attribution_conflict, null_fill): (bool, bool, bool) = self
                    .conn
                    .query_row(
                        "SELECT provider_id, provider_raw, billing_source, billing_mode,
                                pricing_basis, evidence_basis, normalization_version,
                                route_evidence_id, attribution_version
                         FROM usage_facts WHERE fact_id = ?1",
                        rusqlite::params![r.s("fact_id").unwrap_or_default()],
                        |row| {
                            let existing: [Option<String>; 9] = [
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                                row.get(6)?,
                                row.get(7)?,
                                row.get(8)?,
                            ];
                            let incoming = [
                                provider_id.clone(),
                                provider_raw.clone(),
                                billing_source.clone(),
                                billing_mode.clone(),
                                pricing_basis.clone(),
                                evidence_basis.clone(),
                                normalization_version.clone(),
                                route_evidence_id.clone(),
                                attribution_version.clone(),
                            ];
                            // 版本是派生规则的标识，不是竞争证据。版本变化表示
                            // 同源重分类，可在严格白名单内收敛；同版本下才比较
                            // 七个证据字段并保留真实冲突。
                            let reclassification = incoming[6].is_some() && incoming[8].is_some()
                                && (existing[6] != incoming[6] || existing[8] != incoming[8]);
                            let conflict = existing[..6]
                                .iter()
                                .zip(incoming[..6].iter())
                                .any(|(old, new)| old.is_some() && new.is_some() && old != new);
                            let null_fill = existing
                                .iter()
                                .zip(incoming.iter())
                                .any(|(old, new)| old.is_none() && new.is_some());
                            Ok((reclassification, !reclassification && conflict, null_fill))
                        },
                    )
                    .unwrap_or((false, false, false));
                if reclassification {
                    report.enriched += 1;
                    self.conn.execute(
                        "UPDATE usage_facts SET provider_id = ?2, provider_raw = ?3,
                           billing_source = ?4, billing_mode = ?5, pricing_basis = ?6,
                           evidence_basis = ?7, normalization_version = ?8,
                           route_evidence_id = ?9, attribution_version = ?10, updated_at_ms = ?11
                         WHERE fact_id = ?1",
                        rusqlite::params![r.s("fact_id").unwrap_or_default(), provider_id, provider_raw,
                            billing_source, billing_mode, pricing_basis, evidence_basis,
                            normalization_version, route_evidence_id, attribution_version, self.now_ms],
                    )?;
                    self.conn.execute(
                        "UPDATE data_quality_issues SET resolved_at_ms = ?2
                         WHERE scope_key = ?1 AND resolved_at_ms IS NULL",
                        rusqlite::params![format!("attribution_conflict:{}", r.s("fact_id").unwrap_or_default()), self.now_ms],
                    )?;
                } else {
                if attribution_conflict {
                    self.write_rejected(
                        &format!(
                            "attribution_conflict:{}",
                            r.s("fact_id").unwrap_or_default()
                        ),
                        &["provider/billing evidence conflicts with stored fact".to_string()],
                    )?;
                } else {
                    // 干净重发（存量清扫入口）：本次从源重放与存量一致 → 此前记录的
                    // 归因冲突已不可复现，关闭它。真冲突走上一个分支，不会被这里
                    // 误关（REQ-083：不静默抹证据）。幂等：重复重发无副作用。
                    // 由陈旧二进制产生的残留冲突由此自然收敛，不需手工 SQL
                    // （2026-09-12 真机 306 条即此形态）。
                    let resolved = self.conn.execute(
                        "UPDATE data_quality_issues SET resolved_at_ms = ?2
                         WHERE scope_key = ?1 AND resolved_at_ms IS NULL",
                        rusqlite::params![
                            format!(
                                "attribution_conflict:{}",
                                r.s("fact_id").unwrap_or_default()
                            ),
                            self.now_ms
                        ],
                    )?;
                    if resolved > 0 {
                        report.enriched += 1;
                    }
                }
                // A replay may discover stronger provider evidence for an
                // already stored fact. Enrich nullable attribution columns by
                // fact_id without changing the immutable fact identity.
                if null_fill {
                    report.enriched += 1;
                }
                self.conn.execute(
                    "UPDATE usage_facts SET
                       provider_id = COALESCE(provider_id, ?2),
                       provider_raw = COALESCE(provider_raw, ?3),
                       billing_source = COALESCE(billing_source, ?4),
                       billing_mode = COALESCE(billing_mode, ?5),
                       pricing_basis = COALESCE(pricing_basis, ?6),
                       evidence_basis = COALESCE(evidence_basis, ?7),
                       normalization_version = COALESCE(normalization_version, ?8),
                       route_evidence_id = COALESCE(route_evidence_id, ?9),
                       attribution_version = COALESCE(attribution_version, ?10),
                       updated_at_ms = ?11
                     WHERE fact_id = ?1",
                    rusqlite::params![
                        r.s("fact_id").unwrap_or_default(),
                        provider_id,
                        provider_raw,
                        billing_source,
                        billing_mode,
                        pricing_basis,
                        evidence_basis,
                        normalization_version,
                        route_evidence_id,
                        attribution_version,
                        self.now_ms,
                    ],
                )?;
                }
            }
            if n > 0 {
                if let Some(context) = extension {
                    crate::extension_authority::link_fact_in_transaction(
                        self.conn, r.s("fact_id").unwrap_or_default(), context.generation,
                        &context.revision_id, &context.engine_version,
                    ).map_err(|error| match error {
                        crate::extension_authority::ExtensionError::Sql(error) => AuthorityError::from(error),
                        other => AuthorityError::from(rusqlite::Error::InvalidParameterName(format!("{other:?}"))),
                    })?;
                }
                report.inserted += 1
            } else {
                // **payload 冲突可观测（审查 §5.3 收口）**：同 fact_id 已在库
                // 且四桶不同 = 源端更正/漂移——DO NOTHING 会静默保留旧值，
                // 这里落一条质量行让「静默陈旧」浮出来（Phase 3 的更正流
                // 消费此信号；§6.2.5「冲突必须产出 issue」）。
                //
                // 修复（2026-09-07，3.6 agent 范围外发现）：旧实现查询
                // `SELECT raw FROM facts …`——权威库没有 `facts` 表（那是旧
                // index 库 store.rs 的 schema，也没有 raw 列），查询恒报
                // no such table 被 `.ok()` 吞掉 → differs 恒 false，信号
                // 自落地起从未触发过（且无测试覆盖，死信号静默存活）。
                // 现改为对 `usage_facts` 四桶列直读比较——与 INSERT 写入的
                // 正是同一组值，"payload 不同"判定口径不变。
                let stored_differs: Option<bool> = self
                    .conn
                    .query_row(
                        "SELECT uncached_input_tokens, cache_read_tokens,
                                cache_write_tokens, output_tokens
                         FROM usage_facts WHERE fact_id = ?1",
                        rusqlite::params![r.s("fact_id").unwrap_or_default()],
                        |row| {
                            Ok(row.get::<_, i64>(0)? != r.i("uncached_input_tokens")
                                || row.get::<_, i64>(1)? != r.i("cache_read_tokens")
                                || row.get::<_, i64>(2)? != r.i("cache_write_tokens")
                                || row.get::<_, i64>(3)? != r.i("output_tokens"))
                        },
                    )
                    .ok();
                if stored_differs == Some(true) {
                    self.write_rejected(
                        &format!("payload_conflict:{}", r.s("fact_id").unwrap_or_default()),
                        &[
                            "same fact_id, different payload — 源端更正需要显式处理流程"
                                .to_string(),
                        ],
                    )?;
                }
                report.duplicate += 1;
            }
        }
        Ok(report)
    }

    /// 不合格 candidate 写 data_quality_issues（scope_type=fact）。issue_id =
    /// `fact_invalid:{scope_key}`；ON CONFLICT 更新 last_seen_at_ms。
    fn write_rejected(&self, scope_key: &str, problems: &[String]) -> Result<(), AuthorityError> {
        let issue_id = format!("fact_invalid:{scope_key}");
        let detail = serde_json::json!(problems).to_string();
        self.conn.execute(
            "INSERT INTO data_quality_issues(
                 issue_id, scope_type, scope_key, code, severity,
                 first_seen_at_ms, last_seen_at_ms, detail_json)
             VALUES (?1, 'fact', ?2, 'invalid_fact', 'warning', ?3, ?3, ?4)
             ON CONFLICT(issue_id) DO UPDATE SET
                 last_seen_at_ms = excluded.last_seen_at_ms",
            rusqlite::params![issue_id, scope_key, self.now_ms, detail],
        )?;
        Ok(())
    }
}

// 列映射索引：`{harness}:{path_hash}`；`session_key` 用 source_key；
// `ingested_run_id`=run_id；created/updated=now；deleted 恒 NULL。

impl SqlFactWriter<'_> {
    /// 迁移/导入路径的 route_evidence 预插入（镜像 `sql_sync.rs` 同步路径的写法）。
    fn insert_route_evidence_rows(
        &self, harness: &str, machine_namespace: &str, native_session_id: &str,
        facts: &[Value], source_id: &str,
    ) -> Result<(), AuthorityError> {
        let mut seen = std::collections::HashSet::new();
        for fact in facts {
            let Some(evidence_id) = fact.get("route_evidence_id").and_then(Value::as_str) else { continue };
            if !seen.insert(evidence_id.to_string()) { continue; }
            self.conn.execute(
                "INSERT OR IGNORE INTO route_evidence(
                   evidence_id, harness, machine_namespace, native_session_id,
                   provider_raw, endpoint_host, evidence_basis, observed_at_ms,
                   source_id, ingested_run_id)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    evidence_id,
                    fact.get("harness").and_then(Value::as_str).unwrap_or(harness),
                    machine_namespace,
                    native_session_id,
                    fact.get("provider_raw").and_then(Value::as_str),
                    fact.get("endpoint_host").and_then(Value::as_str),
                    fact.get("evidence_basis").and_then(Value::as_str).unwrap_or("missing"),
                    self.now_ms,
                    source_id,
                    self.run_id,
                ],
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avd-ftw-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn open_db(tag: &str) -> (crate::authority::AuthorityDb, std::path::PathBuf) {
        let path = tmp_path(tag);
        let db = crate::authority::AuthorityDb::open(&path, 1_000).unwrap();
        db.begin_run("run-1", "cli", 1_000).unwrap();
        (db, path)
    }

    fn mk_fact(event_id: &str) -> Value {
        json!({
            "harness": "claude-code",
            "machine_namespace": "ns-m",
            "source_profile": "default",
            "native_session_id": "sess-a",
            "source_event_id": event_id,
            "observation_kind": "token_count",
            "event_ts_utc": "2026-09-05T10:00:00.000Z",
            "model_id": "claude-opus-4",
            "uncached_input_tokens": 100,
            "cache_read_tokens": 50,
            "cache_write_tokens": 10,
            "output_tokens": 5,
        })
    }

    /// §5.1.4 单事务：source upsert + session upsert + insert_facts 一次就位。
    fn apply_txn(
        db: &crate::authority::AuthorityDb,
        now_ms: i64,
        session: &str,
        facts: &[Value],
    ) -> Result<(SqlInsertReport, String), AuthorityError> {
        db.with_immediate_txn(|conn| {
            let w = SqlFactWriter::new(conn, "run-1", now_ms)?;
            let src = w.upsert_source_file(
                "claude-code",
                std::path::Path::new("/home/u/raw/cc.jsonl"),
                100,
                1,
                Some(session),
                1,
            )?;
            w.upsert_session("claude-code", "ns-m", session, Some("default"), now_ms)?;
            let report = w.insert_facts(facts, &src, session)?;
            Ok((report, src))
        })
    }

    /// 验收审查 iteration 1 #4：`data-migrate` 走 `import_facts_jsonl`，事实带
    /// `route_evidence_id`（claude-code emitter v1.0-beta.1 起）时必须先落
    /// route_evidence 行，否则 usage_facts 的 FK 触发器让整份迁移中止。
    #[test]
    fn import_jsonl_inserts_route_evidence_before_facts() {
        let (db, path) = open_db("import-route");
        let jsonl = tmp_path("facts").with_extension("jsonl");
        let mut fact = mk_fact("e-route");
        fact["fact_id"] = json!("fact-route-1");
        fact["provider_raw"] = json!("anthropic");
        fact["provider_id"] = json!("anthropic");
        fact["endpoint_host"] = json!("api.anthropic.com");
        fact["evidence_basis"] = json!("session-native");
        fact["pricing_basis"] = json!("route-observed");
        fact["route_evidence_id"] = json!("route:0123456789abcdef");
        std::fs::write(&jsonl, format!("{}\n", fact)).unwrap();
        let report = db.with_immediate_txn(|conn| {
            let w = SqlFactWriter::new(conn, "run-1", 2_000)?;
            w.import_facts_jsonl("claude-code", &jsonl)
        }).unwrap();
        assert_eq!(report.inserted, 1, "{report:?}");
        let (provider_raw, endpoint, basis): (String, String, String) = db.conn().query_row(
            "SELECT provider_raw, endpoint_host, evidence_basis FROM route_evidence WHERE evidence_id = 'route:0123456789abcdef'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!((provider_raw.as_str(), endpoint.as_str(), basis.as_str()), ("anthropic", "api.anthropic.com", "session-native"));
        let _ = std::fs::remove_file(&jsonl);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn replay_of_same_event_is_idempotent_duplicate_is_counted() {
        // 重放幂等：同 fact 只落一行（INSERT ON CONFLICT DO NOTHING），
        // 第二遍必须计 duplicate 而不是 re-insert。
        let (db, path) = open_db("idem");
        let f = mk_fact("e1");
        let (r1, _) = apply_txn(&db, 1_500, "sess-a", std::slice::from_ref(&f)).unwrap();
        assert_eq!((r1.inserted, r1.duplicate, r1.rejected), (1, 0, 0));
        let (r2, _) = apply_txn(&db, 1_600, "sess-a", std::slice::from_ref(&f)).unwrap();
        assert_eq!(r2.inserted, 0, "重放不重插");
        assert_eq!(r2.duplicate, 1);
        let total: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1, "同 fact 只落一行");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn attribution_version_change_reclassifies_without_open_conflict() {
        let (db, path) = open_db("attribution-reclassification");
        let mut original = mk_fact("e-reclass");
        let fields = original.as_object_mut().unwrap();
        fields.insert("provider_id".into(), json!("openai"));
        fields.insert("billing_mode".into(), json!("subscription"));
        fields.insert("pricing_basis".into(), json!("session-provider"));
        fields.insert("evidence_basis".into(), json!("session-native"));
        fields.insert("normalization_version".into(), json!("provider-v0.11"));
        fields.insert("attribution_version".into(), json!("provider-v0.11"));
        apply_txn(&db, 1_500, "sess-a", std::slice::from_ref(&original)).unwrap();
        let mut replay = original.clone();
        let fields = replay.as_object_mut().unwrap();
        fields.insert("provider_id".into(), json!("cogfoundry.ai"));
        fields.insert("billing_mode".into(), json!("metered_estimate"));
        fields.insert("pricing_basis".into(), json!("official-api"));
        fields.insert("normalization_version".into(), json!("provider-v0.12"));
        fields.insert("attribution_version".into(), json!("provider-v0.12"));
        apply_txn(&db, 1_600, "sess-a", std::slice::from_ref(&replay)).unwrap();
        let row: (String, String, i64) = db.conn().query_row(
            "SELECT provider_id, billing_mode, uncached_input_tokens FROM usage_facts", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(row, ("cogfoundry.ai".into(), "metered_estimate".into(), 100));
        let open: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM data_quality_issues WHERE resolved_at_ms IS NULL", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(open, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn same_attribution_version_with_conflicting_evidence_stays_open() {
        let (db, path) = open_db("attribution-conflict");
        let mut original = mk_fact("e-conflict");
        let fields = original.as_object_mut().unwrap();
        fields.insert("provider_id".into(), json!("openai"));
        fields.insert("evidence_basis".into(), json!("session-native"));
        fields.insert("normalization_version".into(), json!("provider-v0.11"));
        fields.insert("attribution_version".into(), json!("provider-v0.11"));
        apply_txn(&db, 1_500, "sess-a", std::slice::from_ref(&original)).unwrap();
        let mut replay = original.clone();
        replay.as_object_mut().unwrap().insert("evidence_basis".into(), json!("config-current"));
        apply_txn(&db, 1_600, "sess-a", std::slice::from_ref(&replay)).unwrap();
        let evidence: String = db.conn().query_row("SELECT evidence_basis FROM usage_facts", [], |r| r.get(0)).unwrap();
        assert_eq!(evidence, "session-native", "true conflict must not silently overwrite evidence");
        let open: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM data_quality_issues WHERE scope_key LIKE 'attribution_conflict:%' AND resolved_at_ms IS NULL", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(open, 1);
        let _ = std::fs::remove_file(path);
    }

    /// 2026-09-12：陈旧二进制产生的残留归因冲突此前**没有出口**——干净重发（本次
    /// 与存量一致）只走 COALESCE 分支，不关闭任何开放记录，真机因此积压 306 条，
    /// 只能手工 SQL 清。本测试钉死新出口：干净重发必须关闭该 fact 已不可复现的
    /// 开放冲突；真冲突（同版本异证据）仍开放，由相邻测试看守。
    #[test]
    fn clean_reemit_resolves_a_stale_conflict() {
        let (db, path) = open_db("attribution-stale-sweep");
        let mut fact = mk_fact("e-stale");
        {
            let f = fact.as_object_mut().unwrap();
            f.insert("provider_id".into(), json!("openai"));
            f.insert("evidence_basis".into(), json!("missing"));
            f.insert("normalization_version".into(), json!("provider-v0.12"));
            f.insert("attribution_version".into(), json!("provider-v0.12"));
        }
        apply_txn(&db, 1_500, "sess-a", std::slice::from_ref(&fact)).unwrap();
        let fact_id: String = db
            .conn()
            .query_row("SELECT fact_id FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        let scope_key = format!("attribution_conflict:{fact_id}");
        // 伪造一条遗留开放冲突（旧二进制写入、新代码尚未清理的形态）。
        db.conn()
            .execute(
                "INSERT INTO data_quality_issues(
                     issue_id, scope_type, scope_key, code, severity,
                     first_seen_at_ms, last_seen_at_ms, detail_json)
                 VALUES (?1, 'fact', ?2, 'invalid_fact', 'warning', 1400, 1400, '[]')",
                rusqlite::params![format!("fact_invalid:{scope_key}"), scope_key],
            )
            .unwrap();
        // 干净重发：与存量逐字段一致。
        apply_txn(&db, 1_600, "sess-a", std::slice::from_ref(&fact)).unwrap();
        let open: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues
                 WHERE scope_key LIKE 'attribution_conflict:%' AND resolved_at_ms IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(open, 0, "干净重发必须关闭已不可复现的遗留冲突");
        let total: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM data_quality_issues", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1, "关闭而非删除：记录保留（REQ-083 不静默抹证据）");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn payload_conflict_signal_fires_on_same_id_different_buckets() {
        // 2026-09-07 修复回归：信号此前查询不存在的 `facts` 表（旧 index 库
        // 的 schema），恒 no-such-table 被 `.ok()` 吞掉 → differs 恒 false，
        // 死信号且无测试覆盖静默存活（3.6 agent 范围外发现）。钉死两个面：
        // 同值重放 → duplicate 但无质量行；同 fact_id 桶值不同（源端更正/
        // 漂移）→ 仍 duplicate（DO NOTHING 保旧值）但必须浮出
        // payload_conflict 质量行。
        let (db, path) = open_db("payload");
        let f = mk_fact("e1");
        let (r1, _) = apply_txn(&db, 1_500, "sess-a", std::slice::from_ref(&f)).unwrap();
        assert_eq!((r1.inserted, r1.duplicate), (1, 0));
        // 同值重放：duplicate，无 payload_conflict 行。
        let (r2, _) = apply_txn(&db, 1_600, "sess-a", std::slice::from_ref(&f)).unwrap();
        assert_eq!((r2.inserted, r2.duplicate), (0, 1));
        let conflicts: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues WHERE scope_key LIKE 'payload_conflict:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(conflicts, 0, "同值重放不是冲突");
        // 同 fact_id（身份六元组未变）、桶值不同：源端更正/漂移。
        let mut g = mk_fact("e1");
        g["output_tokens"] = json!(999);
        let (r3, _) = apply_txn(&db, 1_700, "sess-a", std::slice::from_ref(&g)).unwrap();
        assert_eq!((r3.inserted, r3.duplicate), (0, 1), "DO NOTHING 不覆盖旧值");
        let conflicts: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues WHERE scope_key LIKE 'payload_conflict:%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(conflicts, 1, "四桶不同必须浮出 payload_conflict 信号");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn five_tuple_conflict_is_duplicate_even_with_foreign_fact_id() {
        // UNIQUE(harness,ns,ses,event,kind) 是 second 防线：即使 fact_id 被
        // 外部 hash 规则污染，同五元组也只记一次（不产生罪证双账）。
        let (db, path) = open_db("five");
        let mut f = mk_fact("e1");
        f["fact_id"] = Value::String("borrowed-id".to_string());
        let (r1, _) = apply_txn(&db, 1_500, "sess-a", &[f]).unwrap();
        assert_eq!(r1.inserted, 1);
        let mut g = mk_fact("e1");
        g["fact_id"] = Value::String("another-hash".to_string());
        let (r2, _) = apply_txn(&db, 1_600, "sess-a", &[g]).unwrap();
        assert_eq!(r2.inserted, 0);
        assert_eq!(r2.duplicate, 1, "五元组命中即重复");
        let total: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn source_file_conflict_keeps_first_seen_frozen() {
        // first_seen_at_ms = 历史证据：幂等 upsert 再见只能滚动
        // last_seen，绝不改 first_seen（可复现 checkpoint 语义）。
        let (db, path) = open_db("sc");
        db.with_immediate_txn(|conn| {
            let w1 = SqlFactWriter::new(conn, "run-1", 1_200)?;
            let a = w1.upsert_source_file(
                "claude-code",
                std::path::Path::new("/h/x.jsonl"),
                10,
                11,
                None,
                1,
            )?;
            let w2 = SqlFactWriter::new(conn, "run-1", 8_300)?;
            let b = w2.upsert_source_file(
                "claude-code",
                std::path::Path::new("/h/x.jsonl"),
                20,
                22,
                None,
                1,
            )?;
            assert_eq!(a, b, "同 (harness,path) 必须同 source_id");
            Ok(())
        })
        .unwrap();
        let (first, last): (i64, i64) = db
            .conn()
            .query_row(
                "SELECT first_seen_at_ms, last_seen_at_ms FROM source_files",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(first, 1_200, "first_seen 首次定格");
        assert_eq!(last, 8_300, "last_seen 滚到最近观测");
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM source_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "只建一行");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn session_conflict_updates_last_observed_not_started() {
        // started_at_ms = 首见；last_observed_at_ms = 最近观测。冲突 upsert
        // 只顶 last_observed，首见时钟是历史、不得改写。
        let (db, path) = open_db("sess");
        db.with_immediate_txn(|conn| {
            let w1 = SqlFactWriter::new(conn, "run-1", 2_000)?;
            w1.upsert_session("claude-code", "full-ns", "s9", None, 2_000)?;
            let w2 = SqlFactWriter::new(conn, "run-1", 9_500)?;
            w2.upsert_session("claude-code", "full-ns", "s9", None, 9_500)?;
            Ok(())
        })
        .unwrap();
        let (k, started, last): (String, i64, i64) = db
            .conn()
            .query_row(
                "SELECT session_key, started_at_ms, last_observed_at_ms FROM sessions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            k, "11:claude-code|2:s9|7:default|7:full-ns",
            "profile None → default"
        );
        assert_eq!(started, 2_000, "started 首见定格");
        assert_eq!(last, 9_500, "last_observed 顶到最近");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejected_fact_writes_quality_issue_not_usage_row() {
        // 负 token 是契约违规：不得入 usage_facts（DDL CHECK 兜底前先拦），
        // 必须落 data_quality_issues 可审计（不静默丢）。
        let (db, path) = open_db("rej");
        let mut f = mk_fact("neg");
        f["output_tokens"] = Value::from(-7);
        let (r, _) = apply_txn(&db, 1_500, "sess-a", &[f]).unwrap();
        assert_eq!((r.inserted, r.rejected, r.duplicate), (0, 1, 0));
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "不合格事实不得入 usage_facts");
        let (code, sev): (String, String) = db
            .conn()
            .query_row("SELECT code, severity FROM data_quality_issues", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(code, "invalid_fact");
        assert_eq!(sev, "warning");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn repeated_rejection_updates_same_issue_row() {
        // 同问题连拒两次：issue 行必须只存在一条（ON CONFLICT 更新
        // last_seen），不许无限增行。
        let (db, path) = open_db("accum");
        let mut f = mk_fact("e2");
        f["cache_read_tokens"] = Value::from(-1);
        for now in [1_500, 1_800] {
            let (r, _) = apply_txn(&db, now, "sess-a", std::slice::from_ref(&f)).unwrap();
            assert_eq!(r.rejected, 1);
        }
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM data_quality_issues", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "同事实连拒两次也只一条质量行");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mixed_session_batch_is_an_error_and_rolls_back() {
        // 调用方 bug：一整个 batch 必须属于同一个 native_session_id。
        // 混会话整批报错且事务一致回滚，不允许半入库。
        let (db, path) = open_db("mixed");
        let mut f = mk_fact("e3");
        f["native_session_id"] = Value::from("sess-other");
        let res = apply_txn(&db, 1_500, "sess-a", &[f]);
        assert!(res.is_err(), "混会话必须报错");
        assert!(res
            .unwrap_err()
            .to_string()
            .contains("__mixed_session_batch__"));
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "批错整段事务回滚");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn unparseable_timestamp_rejects_the_fact() {
        // 无时间戳/时间戳不可 parse 的事实不得入账——保存 event_ts_ms 为
        // 猜测值会污染所有时间窗口聚合（spec §4 的时间校验在此落地）。
        let (db, path) = open_db("ts");
        let mut f = mk_fact("ts");
        f["event_ts_utc"] = Value::from("garbage");
        let (r, _) = apply_txn(&db, 1_500, "sess-a", &[f]).unwrap();
        assert_eq!(r.rejected, 1, "不可 parse 的时间戳事实必须 invalid");
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn session_key_is_collision_free_for_colon_bearing_ids() {
        // 审查 P1：朴素拼接让 ("ab","c") 与 ("a","bc") 撞键——长度前缀
        // 自定界（r2a ledger_key）天然无法伪造碰撞。
        let k1 = session_key("codex", "ns", "ab", Some("c"));
        let k2 = session_key("codex", "ns", "a", Some("bc"));
        assert_ne!(k1, k2, "不同字段切分不得撞键：{k1} vs {k2}");
        let k3 = session_key("codex", "ns", "a:b", Some("profile"));
        let k4 = session_key("codex", "ns", "a", Some("profile"));
        assert_ne!(k3, k4);
    }

    #[test]
    fn unknown_run_id_construction_fails() {
        // new() 的外键预检：绑定幽灵 run_id 的 writer 必须在构造期失败，
        // 而不是让 INSERT 打到外键上才报错。
        let (db, path) = open_db("run");
        let err = SqlFactWriter::new(db.conn(), "ghost", 1).unwrap_err();
        assert!(err.to_string().contains("__run_id_not_found__"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn accepted_row_wires_session_source_run_ts_peak() {
        // 抓回归：insert 行必须携带 writer 绑定的 session_key/source_id/
        // run_id，并且 event_ts_ms / event_peak 与既有 store 同一把尺。
        let (db, path) = open_db("wire");
        let (r, src) = apply_txn(&db, 1_500, "sess-a", &[mk_fact("u")]).unwrap();
        assert_eq!(r.inserted, 1);
        let (k, s, run, ts, pk): (String, String, String, i64, i64) = db
            .conn()
            .query_row(
                "SELECT session_key, source_id, ingested_run_id, event_ts_ms, event_peak
             FROM usage_facts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(k, "11:claude-code|6:sess-a|7:default|4:ns-m");
        assert_eq!(s, src);
        assert_eq!(run, "run-1");
        let expect_ms = iso_to_ms("2026-09-05T10:00:00.000Z").unwrap();
        assert_eq!(ts, expect_ms, "event_ts_ms 是 UTC 毫秒");
        let expect_peak = peak_of("2026-09-05T10:00:00.000Z");
        assert_eq!(pk, expect_peak, "event_peak 与 store 同尺");
        std::fs::remove_file(&path).ok();
    }
}
