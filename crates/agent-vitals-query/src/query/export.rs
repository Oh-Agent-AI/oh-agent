//! Stage C（spec §6）双写路径 × v0.9.1 Phase 3.6：数据源从 `facts/*.jsonl` 切到
//! **SQL 权威库**（`agent_vitals_data::authority::AuthorityDb`）。
//!
//! spec §9 对导出的要求原文：「`data export private` 是显式授权的私有导出；
//! `data export redacted` 重写身份字段，**二者均从 SQL 查询生成**」——与 §7
//! Phase 4「停写 JSONL」同向：JSONL 停写后再从它导出，导出件就会漏掉 SQL 独有
//! 的行（`legacy_aggregate` 历史聚合，§6.2.3）。所以源头必须是权威库，这不是
//! 两个可选数据源里的一个。
//!
//! spec §6 的双路径令**不变**：「私有 trace 与脱敏 export 必须是不同写路径，
//! 不能由一个 `redacted: bool` 决定」——两个独立函数、各自开自己的事务截面、
//! 写各自的输出目录，脱敏路径绝不消费私有路径的产物。唯一的共享面是下方纯映射
//! helper（[`row_to_fields`]：列→键对照表只有一份）——抄第二份才是双账；身份
//! 政策（原样 vs 伪名化）完全住在各自的函数体里，审一个函数就知道一条路径的
//! 隐私面。
//!
//! ## 「私有导出 = 完整面」的语义随方向变更（固有代价，不做无损伪装）
//!
//! 权威库存的是清洗后的**折叠列**（`fact_writer_sql::insert_facts` 是正向折
//! 叠），JSONL 里 ingest 时的元数据字段——`identity_basis` / `time_basis` /
//! `source_usage_semantics` / `normalization_version` / `provider_raw` /
//! `source_revision` / `adapter_version` / `event_tz_basis` / `turn` / `step` /
//! `call_id`——没有对应列，不再出现在导出里。这些字段的取证需求回执行环境原始日志
//! （spec §1.1：JSONL 降级为迁移/导出输入，执行环境日志才是 raw source）。反向收
//! 益：`legacy_aggregate` 行只存在于 SQL，导出面反而比 JSONL 全。
//!
//! `identity_basis` 缺失**不影响 fact_id 正确性**：`usage_fact::fact_id` 的哈
//! 希基是六元组身份字段（machine_namespace / harness / source_profile /
//! native_session_id / source_event_id / observation_kind），`identity_basis`
//! 只是随文档存储的声明。**导出时显式剥掉这个键**（[`strip_unrecoverable_keys`]，
//! 2026-09-07 审查 F1）：builder 会缺省补 `"native"`，而真机语料里 codex 事实
//! 恒为 `derived-hash`（token_count 无原生 id）、claude/DSH 的 fallback 行也是
//! ——导出虚构的 `native` 等于把 §2.1「hash fallback 必须显式标注」的要求静默
//! 翻转，比缺键严重。剥键后回灌仍幂等（重放时 builder 重新补缺省，不在哈希基）。
//!
//! ## 列 → JSON 键映射表（全仓唯一一份）
//!
//! | `usage_facts` 列 | 导出键 | 说明 |
//! |---|---|---|
//! | `fact_id` | `fact_id` | 由身份六元组复算：private 下与库内值相等（身份未动），redacted 下按伪名身份重 stamp |
//! | `harness` | `harness` | |
//! | `machine_namespace` | `machine_namespace` | redacted 伪名化 |
//! | `native_session_id` | `native_session_id` | redacted 伪名化 |
//! | `source_event_id` | `source_event_id` | redacted 伪名化（审查 P1：claude 侧是原生 message.uuid，全局稳定标识） |
//! | `observation_kind` | `observation_kind` | `legacy_aggregate` 行同样导出 |
//! | `source_profile` | `source_profile` | redacted 非空伪名化；NULL/空 → Err（契约必填身份，契约门写入路径不可能落这种行） |
//! | `model_id` | `model_raw` | 三个 emitter 只填 `model_raw`，writer 折叠进 `model_id` 列（`fact_writer_sql.rs` 的 `model_id().or_else(model_raw())`）——反向不可分辨，按 emitter 原键名回填 |
//! | `provider_id` | `provider_id` | writer 同样折叠了 `billing_source`，反向不可分辨，按列名回填；NULL 不出键 |
//! | `event_ts_ms` | `event_ts_utc` | 反算 `YYYY-MM-DDTHH:MM:SS.mmmZ`（[`event_ts_utc_from_ms`]）；NULL 不出键。**保真度说明**（2026-09-07 审查 F2）：亚秒精度在 ingest 时已被 writer 的 `iso_to_ms` 截断（毫秒列只存整秒倍数），此格式仅与 DSH 的 `rfc3339_ms_z` 逐字节同形——codex 的 `.404Z` 导出为 `.000Z`、claude 的无毫秒格式补 `.000`；峰谷/归日/月窗不受影响，回灌得同毫秒，但与 JSONL 时代导出件 diff 时每行 ts 都会不同 |
//! | 四个 token 列 | 四个 token 键 | `uncached_input_tokens` / `cache_read_tokens` / `cache_write_tokens` / `output_tokens` 原样 |
//! | `event_peak` | （不出键） | `store::peak_of(event_ts_utc)` 纯函数可复算——导出不另存派生值 |
//! | `session_key` / `source_id` / `ingested_run_id` / `created_at_ms` / `updated_at_ms` / `deleted_at_ms` | （不出键） | SQL 侧 provenance/簿记列，不属于 UsageFact 词表 |
//!
//! 「不存在的键不要伪造」：SQL 没有的列不出键，重建时由 `build_usage_fact`
//! 统一补 `null`（与「缺失 ≠ 0」的契约同语义——null 是「这个执行环境没有这项证据」）。
//!
//! ## 锁语义：不再拿 `facts/.ingest.lock`
//!
//! JSONL 时代的锁防的是「并发 ingest 的尾面修复/追加进行中读到非原子截面」。
//! SQL 读的一致性由事务承担：`BEGIN DEFERRED`（rusqlite 的
//! `Connection::unchecked_transaction`）在本事务首条读语句上固定快照——WAL
//! 模式下 reader
//! 不阻塞 writer，三执行环境逐 harness 查询都在同一事务里 = 同一截面。ingest 侧走
//! `BEGIN IMMEDIATE`、按 run 整批提交，「导出中途 ingest 提交半批」在快照语义
//! 下要么整体在快照建立前（可见）要么整体在快照后（不可见），不存在半批可见
//! ——所以不需要文件锁，旧 lease 代码随之删除。`ingest_service` 的
//! ingest/rebuild/reconcile 仍拿那把锁，那是它们的**写**面需求，与读快照无关。
//!
//! 副作用说明：权威库不存在时 `AuthorityDb::open` 会建一个空库——与 Phase 3
//! 其他 SQL 读路径（`summary::SqlSummaryRepository`）同语义，不是本模块发明的
//! 分支；空库导出 = 空输出、零报错（spec §9 的导出是显式授权命令，操作者对
//! 「库里有什么」有 `data status` 这个前置诊断面）。

use std::path::Path;

use agent_vitals_domain::source_identity::fnv1a64_hex;
use agent_vitals_domain::usage_fact::build_usage_fact;
use serde_json::{Map, Value, json};

/// 导出列清单（与模块头映射表一一对应）。新增列 = 新增映射行 + 重审 redacted
/// 的身份白名单，不是顺手加个字段。
const EXPORT_COLUMNS: &str = "fact_id, harness, machine_namespace, native_session_id, \
     source_event_id, observation_kind, source_profile, provider_id, provider_raw, \
     billing_source, billing_mode, pricing_basis, billing_template_id, evidence_basis, normalization_version, \
     route_evidence_id, attribution_version, model_id, event_ts_ms, uncached_input_tokens, \
     cache_read_tokens, cache_write_tokens, output_tokens";

/// 打开权威库（注入时钟，本 crate 不读时钟的纪律由 `sql_sync::now_ms` 承担）。
fn open_authority(
    data_home: &Path,
) -> Result<agent_vitals_data::authority::AuthorityDb, String> {
    agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    )
    .map_err(|e| format!("authority open: {e}"))
}

/// 单执行环境行 → 契约字段映射（[`row_to_fields`] 的查询包装）。行序 = `fact_id`
/// 字典序：主键唯一、与插入时序无关，保证同库两次导出字节一致（确定性是
/// redacted 对账的前提，不是审美）。软删除行（`deleted_at_ms` 非空）不导出
/// ——spec §5.4，见模块头。
fn harness_rows(conn: &rusqlite::Connection, harness: &str) -> Result<Vec<Map<String, Value>>, String> {
    let sql = format!(
        "SELECT {EXPORT_COLUMNS} FROM usage_facts \
         WHERE harness = ?1 AND deleted_at_ms IS NULL ORDER BY fact_id"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("authority query ({harness}): {e}"))?;
    let mut rows = stmt
        .query(rusqlite::params![harness])
        .map_err(|e| format!("authority query ({harness}): {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("authority read ({harness}): {e}"))?
    {
        out.push(row_to_fields(row)?);
    }
    Ok(out)
}

/// 一行 `usage_facts` → `build_usage_fact` 输入字段集（映射表见模块头）。
fn row_to_fields(r: &rusqlite::Row<'_>) -> Result<Map<String, Value>, String> {
    let get_s = |col: &str| -> Result<String, String> {
        r.get(col).map_err(|e| format!("authority column {col}: {e}"))
    };
    let get_opt = |col: &str| -> Result<Option<String>, String> {
        r.get(col).map_err(|e| format!("authority column {col}: {e}"))
    };
    let fact_id: String = get_s("fact_id")?;
    let ns = get_s("machine_namespace")?;
    let sid = get_s("native_session_id")?;
    let evt = get_s("source_event_id")?;
    let kind = get_s("observation_kind")?;
    let harness = get_s("harness")?;
    // source_profile 是契约必填身份（IDENTITY_INPUT_FIELDS 六元组之一）：NULL
    // 行无法重建合法 UsageFact。契约门写入路径（insert_facts / legacy_import）
    // 落不了这种行；真出现 = 有人绕过了门——如实报错点名 fact_id，不静默丢行
    // （「导出不丢账」与 writer 侧「不静默丢 candidate」是同一条纪律）。
    let profile = get_opt("source_profile")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("authority row {}: source_profile missing/empty — 契约必填身份，禁止导出无身份行", fact_id))?;

    let mut fields = Map::new();
    fields.insert("machine_namespace".into(), json!(ns));
    fields.insert("harness".into(), json!(harness));
    fields.insert("source_profile".into(), json!(profile));
    fields.insert("native_session_id".into(), json!(sid));
    fields.insert("source_event_id".into(), json!(evt));
    fields.insert("observation_kind".into(), json!(kind));
    // model_id 列是 writer 的折叠结果（model_id 优先、model_raw 兜底），反向
    // 不可分辨——按 emitter 原键名 model_raw 回填（模块头映射表）。
    if let Some(m) = get_opt("model_id")?.filter(|s| !s.is_empty()) {
        fields.insert("model_raw".into(), json!(m));
    }
    if let Some(p) = get_opt("provider_id")?.filter(|s| !s.is_empty()) {
        fields.insert("provider_id".into(), json!(p));
    }
    for key in ["provider_raw", "billing_source", "billing_mode", "pricing_basis", "billing_template_id", "evidence_basis", "normalization_version", "route_evidence_id", "attribution_version"] {
        if let Some(v) = get_opt(key)?.filter(|s| !s.is_empty()) {
            fields.insert(key.to_string(), json!(v));
        }
    }
    // event_ts_ms 是 writer 对 event_ts_utc 的正向 parse；契约门写入路径必填
    // 可 parse 时间，NULL 行理论上不存在（防御：不出键，不编时间）。
    let ts_ms: Option<i64> = r
        .get("event_ts_ms")
        .map_err(|e| format!("authority column event_ts_ms: {e}"))?;
    if let Some(ms) = ts_ms {
        fields.insert("event_ts_utc".into(), json!(event_ts_utc_from_ms(ms)));
    }
    // 四桶列 NOT NULL DEFAULT 0：直接取值。「真实 0」与「缺失」在 SQL 侧已
    // 被折叠成同一个 0——这是列式权威的固有形状，导出如实呈现。
    for key in [
        "uncached_input_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "output_tokens",
    ] {
        let v: i64 = r
            .get(key)
            .map_err(|e| format!("authority column {key}: {e}"))?;
        fields.insert(key.to_string(), json!(v));
    }
    Ok(fields)
}

/// epoch 毫秒 → `YYYY-MM-DDTHH:MM:SS.mmmZ`。emitter 原格式（DSH
/// `usage_fact.rs::rfc3339_ms_z` 的同一公式：纯整数 `div_euclid`/`rem_euclid`，
/// 日期走 domain 的 civil 表）——那个 fn 是 harnesses 的私有项，本 crate 引用不到；
/// 这里按同一公式重写，格式由映射测试钉死，writer 的 `iso_to_ms` 可解析回同
/// 一毫秒（正向/反向闭环）。
fn event_ts_utc_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = agent_vitals_domain::util::civil_from_unix_secs(secs, 0);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        tod / 3600,
        (tod / 60) % 60,
        tod % 60,
        millis
    )
}

/// 稳定伪名：同输入同输出、不可反推（fnv1a64 的安全用途边界——它不是密码
/// 学哈希，这里的威胁模型是「导出件接收方不该直接读到原始标识符」，不是
/// 「对抗蓄意逆向」；威胁更高时该整段不导出）。
fn pseudonym(prefix: &str, raw: &str) -> String {
    format!("{}-{}", prefix, &fnv1a64_hex(raw.as_bytes())[..12])
}

/// 脱敏导出的身份重写：四个可辨识字段规范化为稳定伪名，其余字段（token 桶、
/// 模型、时间）原样保留——脱敏导出的分析价值在这些字段上。
///
/// **白名单维护纪律**（承旧实现的审查 P1/P2 注）：以上四个是手工枚举的「可
/// 辨识字段」。未来某 emitter 开始填 `session_key_ref`/`provider_request_id`/
/// `account_ref` 等（当前无生产者），就是新的泄漏面——增字段时必须对照
/// `USAGE_FACT_FIELDS` 重审本函数与模块头的映射表。
fn pseudonymize_identity(fields: &mut Map<String, Value>) {
    for (key, prefix) in [
        ("machine_namespace", "ns"),
        ("native_session_id", "sess"),
        ("source_profile", "profile"),
        ("source_event_id", "evt"),
    ] {
        if let Some(v) = fields.get(key).and_then(Value::as_str) {
            if !v.is_empty() {
                fields.insert(key.to_string(), json!(pseudonym(prefix, v)));
            }
        }
    }
}

/// 一执行环境的多行文档写成 `<harness>.jsonl`（一行一个 JSON 对象，末行带换行）。
fn write_lines(dst: &Path, lines: &[String]) -> Result<(), String> {
    let mut text = lines.join("\n");
    if !lines.is_empty() {
        text.push('\n');
    }
    std::fs::write(dst, text).map_err(|e| format!("{}: {e}", dst.display()))
}

/// 私有导出：权威库快照的完整面（身份可读）。
///
/// 每行经 `build_usage_fact` 重建——契约层补齐 `USAGE_FACT_FIELDS` 全键（SQL
/// 侧没有的键置 null）并复算 `fact_id`。身份字段未动，复算结果与库内值一致
/// （round-trip 测试钉住这个相等性），所以导出件可以直接回灌
/// `import_facts_jsonl` 幂等重放——私有导出兼任权威库的人读备份。
pub fn export_private(data_home: &Path, out_dir: &Path) -> Result<usize, String> {
    let db = open_authority(data_home)?;
    std::fs::create_dir_all(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    // 只读快照事务（锁语义见模块头）：BEGIN DEFERRED + 三执行环境同事务。
    let tx = db
        .conn()
        .unchecked_transaction()
        .map_err(|e| format!("authority snapshot: {e}"))?;
    let mut files = 0usize;
    for harness in crate::core::fact_harnesses::FACT_HARNESSES {
        let fields = harness_rows(&tx, harness)?;
        if fields.is_empty() {
            // 旧行为沿用：无数据的执行环境不出文件（JSONL 时代 = 该执行环境文件不存在）。
            continue;
        }
        let mut lines = Vec::with_capacity(fields.len());
        for f in &fields {
            let mut doc = build_usage_fact(f).map_err(|p| {
                format!("authority row (harness {harness}): {p:?} — 库内存在契约不可重建的行，先查 data_quality_issues")
            })?;
            strip_unrecoverable_keys(&mut doc);
            lines.push(doc.to_string());
        }
        let dst = out_dir.join(format!("{harness}.jsonl"));
        write_lines(&dst, &lines)?;
        files += 1;
    }
    if files == 0 {
        // 空库导出 = 零字节文件 + exit 0，操作者极易当成成功备份（3.6 审查
        // F3：迁移期一台没跑过 sync/migrate 的机器上恰好会踩）。不报错——
        // 空库导空件语义上没错——但必须喊一声。
        eprintln!(
            "warning: authority DB holds 0 facts for all harnesses — export is empty; \
             run 'sync-facts' / 'data-migrate' first if this is unexpected"
        );
    }
    tx.commit()
        .map_err(|e| format!("authority snapshot commit: {e}"))?;
    Ok(files)
}

/// 导出前剥掉「SQL 不携带、契约层却会补出非空缺省值」的键。目前只有
/// `identity_basis`：builder 缺省填 `"native"`，而真机语料里 codex 事实恒为
/// `derived-hash`（token_count 无原生 id）、claude/DSH 的 fallback 行也是
/// ——导出一份虚构的 `native` 比不出这个键严重得多（§2.1 要求 hash fallback
/// 必须显式标注，导出路径不得静默翻转）。剥掉后回灌仍幂等：重放路径
/// `build_usage_fact` 会重新补缺省，`identity_basis` 不在 fact_id 哈希基里。
fn strip_unrecoverable_keys(doc: &mut Value) {
    if let Some(obj) = doc.as_object_mut() {
        obj.remove("identity_basis");
    }
}

/// 脱敏导出：同一 SQL 读法（但各自开自己的事务截面）→ 重导身份（namespace/
/// 会话/路径/**原生事件 id** 四个可辨识字段规范化为稳定伪名）→ 经
/// `build_usage_fact` 重算 fact_id（身份字段变了，fact_id 必须跟着契约层重
/// stamp——导出件的一致性由契约层背书，不是手改字符串）→ 写出。与
/// [`export_private`] 各自读各自的截面、写各自的目录，绝不共用中间产物。
pub fn export_redacted(data_home: &Path, out_dir: &Path) -> Result<(usize, usize), String> {
    let db = open_authority(data_home)?;
    std::fs::create_dir_all(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let tx = db
        .conn()
        .unchecked_transaction()
        .map_err(|e| format!("authority snapshot: {e}"))?;
    let mut files = 0usize;
    let mut total = 0usize;
    for harness in crate::core::fact_harnesses::FACT_HARNESSES {
        let fields = harness_rows(&tx, harness)?;
        if fields.is_empty() {
            continue;
        }
        let mut lines = Vec::with_capacity(fields.len());
        for mut f in fields {
            pseudonymize_identity(&mut f);
            let mut doc = build_usage_fact(&f).map_err(|p| {
                format!("authority row (harness {harness}): {p:?} — 脱敏重建失败，先查 data_quality_issues")
            })?;
            strip_unrecoverable_keys(&mut doc);
            lines.push(doc.to_string());
        }
        let dst = out_dir.join(format!("{harness}.jsonl"));
        write_lines(&dst, &lines)?;
        files += 1;
        total += lines.len();
    }
    tx.commit()
        .map_err(|e| format!("authority snapshot commit: {e}"))?;
    Ok((files, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// V16 出口收口钉子（2026-09-19 政策）：导出列清单**结构性排除** excerpt
    /// 类与锚点字段（workflow 富化九列、session_excerpts 全表）。导出面只读
    /// `usage_facts` 的既定列——新增列必须走「新增映射行 + 重审 redacted 身份
    /// 白名单」的评审流程（模块头映射表纪律），而不是顺手扩这里。本测试的
    /// 作用：谁把 excerpt/anchor 字段加进 EXPORT_COLUMNS 或让导出读到
    /// session_excerpts，这里立刻炸（spec §6 的逐面投影表）。
    #[test]
    fn export_surface_structurally_excludes_excerpt_and_anchor_fields() {
        // spec §6 口径：excerpt 类与锚点字段不出**任何**导出面；error_code/
        // error_class/task_profile/reasoning_effert 属「未来若进导出需按面分别
        // 决策」的列（redacted 可留、private 原样），不进本钉子的禁列清单——
        // 钉子只钉结构性禁止的东西，别把未来要评审的决策提前焊死。
        for forbidden in [
            "error_excerpt", "args_excerpt", "native_event_id", "source_line",
            "source_byte_offset", "session_excerpts",
        ] {
            assert!(
                !EXPORT_COLUMNS.contains(forbidden),
                "EXPORT_COLUMNS 不得包含 V16 excerpt/锚点字段：{forbidden}"
            );
        }
        // 导出查询只从 usage_facts 取数——整个模块不得读 session_excerpts 表
        //（FROM 或 JOIN）。needle 运行时拼接：字面量写死会被 include_str! 的
        // 自扫描匹配到自己。
        let module_source = include_str!("export.rs");
        for joiner in ["FROM", "JOIN"] {
            let needle = [joiner, "session_excerpts"].join(" ");
            assert!(
                !module_source.contains(&needle),
                "导出模块不得以 {joiner} 读取 session_excerpts 表"
            );
        }
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avd-export-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn open_db(home: &Path) -> agent_vitals_data::authority::AuthorityDb {
        agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(home),
            1_000,
        )
        .unwrap()
    }

    /// 真实 emitter 形状的 codex 事实（经契约层 build，与生产双写一致）。
    fn mk_fact(event_id: &str) -> Value {
        let mut fields = serde_json::Map::new();
        fields.insert("machine_namespace".into(), json!("my-secret-ns"));
        fields.insert("harness".into(), json!("codex"));
        fields.insert("source_profile".into(), json!("--Users-admin-project--"));
        fields.insert("native_session_id".into(), json!("sess-abcdef"));
        // 真实形状：claude 侧是原生 message.uuid（审查 P1——良性字面量
        // 抓不住泄漏）；codex 侧同为全局稳定的事件 id。
        fields.insert(
            "source_event_id".into(),
            json!(format!("msg_{event_id}01abc2def3ghi4jkl5mno6pqr7stu8vwx")),
        );
        fields.insert("observation_kind".into(), json!("token_count"));
        fields.insert("event_ts_utc".into(), json!("2026-09-05T10:00:00.000Z"));
        // emitter 只填 model_raw（writer 折叠进 model_id 列，见 fact_writer_sql）。
        fields.insert("model_raw".into(), json!("glm-4.6"));
        fields.insert("uncached_input_tokens".into(), json!(100));
        fields.insert("cache_read_tokens".into(), json!(50));
        fields.insert("cache_write_tokens".into(), json!(10));
        fields.insert("output_tokens".into(), json!(5));
        build_usage_fact(&fields).unwrap()
    }

    /// 生产双写路径（`sync` 的扁平批次变体）入权威库——测试不走手写 INSERT，
    /// 保证库内形状与真实 ingest 完全一致（形状来源纪律：先读产生方）。
    fn seed(home: &Path, harness: &str, ns: &str, facts: &[Value]) {
        let db = open_db(home);
        let r = agent_vitals_ingest::sql_sync::write_flat_facts_to_authority(&db, harness, ns, facts, 1_500)
            .unwrap();
        assert_eq!(r.inserted, facts.len(), "种子事实必须全部入库");
    }

    fn read_lines(path: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn private_export_field_mapping_round_trips_authority_columns() {
        let home = tmp("mapping");
        let out = home.join("out-private");
        let fact = mk_fact("A");
        seed(&home, "codex", "my-secret-ns", std::slice::from_ref(&fact));

        assert_eq!(export_private(&home, &out).unwrap(), 1);
        let doc = read_lines(&out.join("codex.jsonl")).remove(0);

        // 逐字段对照模块头映射表。
        assert_eq!(doc["machine_namespace"], json!("my-secret-ns"), "身份原样");
        assert_eq!(doc["harness"], json!("codex"));
        assert_eq!(doc["source_profile"], json!("--Users-admin-project--"));
        assert_eq!(doc["native_session_id"], json!("sess-abcdef"));
        assert_eq!(doc["source_event_id"], fact["source_event_id"]);
        assert_eq!(doc["observation_kind"], json!("token_count"));
        // model_id 列 → model_raw 键（emitter 原键名回填）。
        assert_eq!(doc["model_raw"], json!("glm-4.6"));
        assert!(doc.get("model_id").is_none() || doc["model_id"].is_null());
        // event_ts_utc 由 event_ts_ms 反算，emitter 原格式（毫秒定宽 + Z）。
        assert_eq!(doc["event_ts_utc"], json!("2026-09-05T10:00:00.000Z"));
        // 四桶原样。
        assert_eq!(doc["uncached_input_tokens"], json!(100));
        assert_eq!(doc["cache_read_tokens"], json!(50));
        assert_eq!(doc["cache_write_tokens"], json!(10));
        assert_eq!(doc["output_tokens"], json!(5));
        // 身份未动 → 契约层复算的 fact_id 与库内值相等（回灌幂等的前提）。
        assert_eq!(doc["fact_id"], fact["fact_id"]);
        // SQL 不存 identity_basis → 剥键而非导出 builder 的 "native" 缺省
        // （真机 codex 事实恒为 derived-hash，虚构 native 是把必须显式的
        // hash-fallback 声明静默翻转——3.6 审查 F1）。缺省值不影响 fact_id
        // （哈希基是六元组身份，见模块头）。
        assert!(
            doc.get("identity_basis").is_none(),
            "identity_basis 必须剥掉，不得导出虚构的 native 缺省"
        );
        assert_eq!(doc["schema_version"], json!(1));
        // 「不存在的键不要伪造」+ 契约层补 null：SQL 侧没有的词表键 = null。
        assert_eq!(doc["turn"], Value::Null);
        assert_eq!(doc["provider_id"], Value::Null);
        // SQL 侧 provenance/簿记列不进导出。session_key 列（r2a ledger 键值）
        // 不出——契约词表里的 session_key_ref 是「引用」，置 null 不伪造。
        assert_eq!(doc["session_key_ref"], Value::Null);
        assert_eq!(doc["session_key_orphan"], Value::Null);
        let text = serde_json::to_string(&doc).unwrap();
        for banned in [
            "ingested_run_id",
            "created_at_ms",
            "updated_at_ms",
            "deleted_at_ms",
            "event_peak",
        ] {
            assert!(!text.contains(banned), "导出不应含 SQL 簿记列 {banned}: {text}");
        }
        // 无数据执行环境不出文件（旧行为沿用）。
        assert!(!out.join("claude-code.jsonl").exists());
        assert!(!out.join("dsh.jsonl").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn event_ts_utc_backfill_parses_back_to_the_same_millisecond() {
        // 反算公式与 writer 正向 parse 必须闭环：任何毫秒反算出的 ISO 串喂回
        // `ms_from_civil` 得到同一毫秒（负 ms 也在内——epoch 前的事实不该炸）。
        for ms in [0_i64, 1, 999, 1_000, 1_783_000_000_123, -1, -86_400_000] {
            let iso = event_ts_utc_from_ms(ms);
            assert_eq!(iso.len(), 24, "{iso}");
            let (y, mo, d) = agent_vitals_domain::util::civil_from_unix_secs(ms.div_euclid(1000), 0);
            let hh = ms.div_euclid(1000).rem_euclid(86_400) / 3600;
            let mi = ms.div_euclid(1000).rem_euclid(3600) / 60;
            let ss = ms.div_euclid(1000).rem_euclid(60);
            let back = agent_vitals_domain::usage::ms_from_civil(y, mo, d, hh as u32, mi as u32, ss as u32)
                .unwrap()
                + ms.rem_euclid(1000);
            assert_eq!(back, ms, "{iso} 应解析回 {ms}");
            let (py, pm, pd) = (
                iso.get(0..4).unwrap().parse::<i64>().unwrap(),
                iso.get(5..7).unwrap().parse::<u32>().unwrap(),
                iso.get(8..10).unwrap().parse::<u32>().unwrap(),
            );
            assert_eq!((py, pm, pd), (y, mo, d), "{iso}");
            assert_eq!(&iso[10..11], "T");
            assert!(iso.ends_with('Z'), "{iso}");
            assert_eq!(&iso[19..23], format!(".{:03}", ms.rem_euclid(1000)));
        }
    }

    #[test]
    fn soft_deleted_rows_are_not_exported() {
        // spec §5.4：软删除 = 用户撤销，任何导出件都不得再携带（JSONL 时代没有
        // 删除概念，这是 authority 语义下的新行为）。
        let home = tmp("softdel");
        let f1 = mk_fact("B");
        let f2 = mk_fact("C");
        seed(&home, "codex", "my-secret-ns", &[f1.clone(), f2.clone()]);
        let db = open_db(&home);
        let del = db.with_immediate_txn(|conn| {
            Ok(conn.execute(
                "UPDATE usage_facts SET deleted_at_ms = 2000 WHERE fact_id = ?1",
                rusqlite::params![f1["fact_id"].as_str().unwrap()],
            )?)
        });
        assert_eq!(del.unwrap(), 1);

        let out = home.join("out");
        assert_eq!(export_private(&home, &out).unwrap(), 1);
        let docs = read_lines(&out.join("codex.jsonl"));
        assert_eq!(docs.len(), 1, "软删除行不出现在私有导出");
        assert_eq!(docs[0]["fact_id"], f2["fact_id"]);

        // 脱敏路径同样过滤，且连伪名形态也不出现（伪名确定性 → 可精确比对）。
        let out_r = home.join("out-r");
        let (files, total) = export_redacted(&home, &out_r).unwrap();
        assert_eq!((files, total), (1, 1));
        let text = std::fs::read_to_string(out_r.join("codex.jsonl")).unwrap();
        assert!(
            !text.contains(&pseudonym("evt", f1["source_event_id"].as_str().unwrap())),
            "被删除事实的事件伪名也不得出现：{text}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn legacy_aggregate_rows_are_exported() {
        // legacy_aggregate 只存在于 SQL（§6.2.3）——切 SQL 源后导出面反而比
        // JSONL 全，这正是方向带来的反向收益。
        let home = tmp("legacy");
        let db = open_db(&home);
        db.begin_run("run-lg", "migration", 1_000).unwrap();
        let days = json!({
            "2026-05-05": {
                "glm-4.6": {
                    "input_tokens": 10,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "output_tokens": 2,
                    "peak_input_tokens": 3,
                }
            }
        });
        let rep = db.with_immediate_txn(|conn| {
            agent_vitals_data::legacy_import::import_claude_ledger_days(
                conn,
                "run-lg",
                1_100,
                &days,
            )
        });
        assert_eq!(rep.unwrap().imported, 2, "base + peak 两行");

        let out = home.join("out");
        assert_eq!(export_private(&home, &out).unwrap(), 1);
        let docs = read_lines(&out.join("claude-code.jsonl"));
        assert_eq!(docs.len(), 2);
        let base = docs
            .iter()
            .find(|d| d["source_event_id"].as_str().unwrap().ends_with(":0"))
            .unwrap();
        assert_eq!(base["observation_kind"], json!("legacy_aggregate"));
        assert_eq!(base["machine_namespace"], json!("legacy"));
        assert_eq!(base["source_profile"], json!("ledger"));
        // 聚合行的 model_id 列来自 ledger 的 model 键 → 同样回填 model_raw。
        assert_eq!(base["model_raw"], json!("glm-4.6"));
        // 北京午时 04:00Z，反算回 ms 定宽格式。
        assert_eq!(base["event_ts_utc"], json!("2026-05-05T04:00:00.000Z"));
        assert_eq!(base["uncached_input_tokens"], json!(10));
        assert_eq!(base["output_tokens"], json!(2));

        // 脱敏路径照常工作：legacy 的保留字面量（ns "legacy"/profile "ledger"）
        // 也必须伪名化——它们是机器标识，不是无害词。
        let out_r = home.join("out-r");
        let (_, total) = export_redacted(&home, &out_r).unwrap();
        assert_eq!(total, 2);
        let text = std::fs::read_to_string(out_r.join("claude-code.jsonl")).unwrap();
        assert!(!text.contains("\":\"legacy\""), "{text}");
        assert!(!text.contains("\":\"ledger\""), "{text}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn redacted_fact_id_is_the_contract_restamp_of_pseudonymized_identity() {
        // crux：脱敏重建出的字段集必须满足 builder 的必填校验，且 fact_id =
        // 对伪名化身份手工调 build_usage_fact 的产物。全文档相等是比「fact_id
        // 相等」更强的断言——它同时钉住字段集、哈希基与度量字段原样。
        let home = tmp("restamp");
        let fact = mk_fact("D");
        seed(&home, "codex", "my-secret-ns", std::slice::from_ref(&fact));

        let out = home.join("out-r");
        let (files, total) = export_redacted(&home, &out).unwrap();
        assert_eq!((files, total), (1, 1));
        let doc = read_lines(&out.join("codex.jsonl")).remove(0);

        // 手工伪名化（与 pseudonymize_identity 同一白名单），喂 builder。
        let mut manual = serde_json::Map::new();
        manual.insert(
            "machine_namespace".into(),
            json!(pseudonym("ns", "my-secret-ns")),
        );
        manual.insert("harness".into(), json!("codex"));
        manual.insert(
            "source_profile".into(),
            json!(pseudonym("profile", "--Users-admin-project--")),
        );
        manual.insert(
            "native_session_id".into(),
            json!(pseudonym("sess", "sess-abcdef")),
        );
        manual.insert(
            "source_event_id".into(),
            json!(pseudonym("evt", fact["source_event_id"].as_str().unwrap())),
        );
        manual.insert("observation_kind".into(), json!("token_count"));
        manual.insert("event_ts_utc".into(), json!("2026-09-05T10:00:00.000Z"));
        manual.insert("model_raw".into(), json!("glm-4.6"));
        manual.insert("uncached_input_tokens".into(), json!(100));
        manual.insert("cache_read_tokens".into(), json!(50));
        manual.insert("cache_write_tokens".into(), json!(10));
        manual.insert("output_tokens".into(), json!(5));
        let mut expected = build_usage_fact(&manual).unwrap();
        // 导出侧剥 identity_basis（见 strip_unrecoverable_keys）——期望产物
        // 同步剥掉，全文档相等才对得上。
        if let Some(obj) = expected.as_object_mut() {
            obj.remove("identity_basis");
        }

        assert_eq!(
            doc, expected,
            "导出件必须逐字节等于契约层对伪名身份的重建产物"
        );
        assert_ne!(doc["fact_id"], fact["fact_id"], "身份变了，fact_id 必须重 stamp");
        assert!(doc["fact_id"].as_str().unwrap().starts_with("uf1-"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn redaction_is_stable_across_runs_and_private_path_keeps_identity() {
        let home = tmp("stable");
        let fact = mk_fact("E");
        seed(&home, "codex", "my-secret-ns", std::slice::from_ref(&fact));
        let out_priv = home.join("out-private");
        let out_r1 = home.join("r1");
        let out_r2 = home.join("r2");

        // 私有路径：身份可读（私有 trace 的完整面）。
        assert_eq!(export_private(&home, &out_priv).unwrap(), 1);
        let priv_text = std::fs::read_to_string(out_priv.join("codex.jsonl")).unwrap();
        assert!(priv_text.contains("my-secret-ns"));
        assert!(priv_text.contains("Users-admin-project"));
        assert!(priv_text.contains("sess-abcdef"));

        // 脱敏路径：四个身份字段全部伪名化，度量字段原样；两次导出字节一致
        // （同库同快照 + fact_id 序 + fnv1a64 稳定性）。
        let (files, total) = export_redacted(&home, &out_r1).unwrap();
        assert_eq!((files, total), (1, 1));
        export_redacted(&home, &out_r2).unwrap();
        let red1 = std::fs::read_to_string(out_r1.join("codex.jsonl")).unwrap();
        let red2 = std::fs::read_to_string(out_r2.join("codex.jsonl")).unwrap();
        assert_eq!(red1, red2, "同输入同伪名——重跑导出件可互相对账");
        assert!(!red1.contains("my-secret-ns"), "{red1}");
        assert!(!red1.contains("Users-admin-project"), "{red1}");
        assert!(!red1.contains("sess-abcdef"), "{red1}");
        assert!(!red1.contains("msg_E01abc"), "{red1}");
        assert!(red1.contains("\"uncached_input_tokens\":100"), "{red1}");
        assert!(red1.contains("\"fact_id\":\"uf1-"), "{red1}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn empty_authority_exports_nothing_without_error() {
        let home = tmp("empty");
        let out_p = home.join("out-p");
        let out_r = home.join("out-r");
        assert_eq!(export_private(&home, &out_p).unwrap(), 0);
        assert_eq!(export_redacted(&home, &out_r).unwrap(), (0, 0));
        let produced: Vec<_> = std::fs::read_dir(&out_p)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        assert!(produced.is_empty(), "空库 = 空输出：{produced:?}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
