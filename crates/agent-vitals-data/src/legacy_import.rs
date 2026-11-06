//! v0.9.1 Phase 3.2（spec §6.2.3）：**legacy_aggregate 导入**——claude ledger
//! 深历史进权威库。
//!
//! 背景结论（R4 §5.2a，实测定案）：claude 客户端会压缩/轮转会话文件，历史行
//! 物理消失后 ledger 里仍有账——**claude 深历史不可从现文件重放，ledger 是
//! 这部分账的 store of record**。按 spec §6.2.3，把 ledger 的逐日 by_model
//! 作为 `observation_kind=legacy_aggregate` 的记录导入，并标记 coverage 降级
//! （`data_quality_issues` 写 `legacy_aggregate` code），**不伪造为行级
//! 事实**。
//!
//! 存储形状：ledger 的一个 (day, model) 聚合拆 **两行** `usage_facts`——
//! `event_peak=0` 行取 4 个基础桶键（全量），`event_peak=1` 行取同名 `peak_`
//! 前缀键（峰值子桶）。`observation_kind="legacy_aggregate"`，
//! `native_session_id="day:{day}"`，`source_event_id="{day}:{model}:{peak}"`，
//! `event_ts_ms` = 统计日 12:00 的 UTC ms（日内代表点；小时分布查询按
//! observation_kind 排除本类行——查询面契约）。
//!
//! 幂等：fact_id 由契约层身份字段派生，同键重跑 = 幂等吸收；ledger 日桶
//! 变化（同键不同值）→ **更新既有 legacy 行的四桶 + updated_at_ms**、计入
//! report.updated——ledger 是 `claude_sync` 每次**全量重建**的滚动投影，同键
//! 值合法地会变（FOLD_SCHEMA_VERSION 2→3 的全量重折就是实例），且这些月份
//! 往往原始 JSONL 已轮转、ledger 是唯一 store of record，「永不覆盖」= SQL
//! 永远留着旧快照的数字，静默且不可纠正。§6.2.5「旧 JSON 永不覆盖更具体的
//! SQL fact」保护的是**实时行级事实不被 legacy 聚合覆盖**，不是 legacy-vs-
//! legacy 的同源快照刷新——旧 JSON 覆盖更具体的 SQL fact 的前提是两者来源
//! 不同，这里更新的是同一来源的旧快照。跨 kind 冲突路径在身份契约下不存在
//! （observation_kind 同时在 UNIQUE 键与 fact_id 派生输入里），保留为防御
//! （真出现 = 有人绕过契约层手写了同 fact_id 的行）→ 写
//! `data_quality_issues`（code="legacy_aggregate_conflict"）。导入批结束时
//! 按**实际生成 legacy 行的月份逐月**写 coverage 降级标记
//! （code="legacy_aggregate"、scope_type="month"、scope_key=该月；2026-09-07
//! 审查收口：不再粗化为跨月批一条 "all"——消费方必须能回答「这个月是否被
//! 聚合兜底」），查询方据此把涉及月份的处理降级，不把聚合当可重放的
//! 逐行事实。
//!
//! **事实身份委托 `contracts::usage_fact::build_usage_fact`**——fact_id 由
//! 六元身份字段（machine_namespace/harness/source_profile/native_session_id/
//! source_event_id/observation_kind）哈希派生，与全仓同一把尺；build 会覆盖
//! 任何外部传入的 fact_id。token 非负也在构造器内校验（负值 → 问题清单 →
//! 记 invalid_fact issue，不吞）。
//!
//! machine_namespace 用保留值 "legacy"：本 crate 不依赖 runtime（真实机器
//! ns 住在 `takeover.rs::machine_namespace`），importer 拿不到真实值。数据
//! home 是机器级的，一库一机没有混淆，固定键保证幂等键稳定。
//! source_profile 恒 "ledger"（聚合跨轮转后不知道日桶来自哪些 profile，
//! 不硬造一个真实 profile）。

use std::collections::BTreeSet;
use std::path::Path;

use jiff::{civil::Date, tz::TimeZone, ToSpan};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value, json};

use crate::authority::AuthorityError;

/// ledger model 桶的 4 型 snake → `usage_facts` 四桶列名。与
/// `claude_cost.rs::SNAKE_KEYS` 语义一一对应（`input_tokens` 是 uncached
/// 输入——Anthropic API 该字段不含缓存读/写；`cache_creation_input_tokens`
/// = 缓存写入）。峰值行取同名 `peak_` 前缀。
const LEDGER_BUCKET_KEYS: [(&str, &str); 4] = [
    ("input_tokens", "uncached_input_tokens"),
    ("cache_read_input_tokens", "cache_read_tokens"),
    ("cache_creation_input_tokens", "cache_write_tokens"),
    ("output_tokens", "output_tokens"),
];

const LEGACY_HARNESS: &str = "claude-code";
const LEGACY_NS: &str = "legacy";
const LEGACY_PROFILE: &str = "ledger";
const LEGACY_KIND: &str = "legacy_aggregate";

/// 一次 legacy 导入的报告。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LegacyImportReport {
    /// 导入的聚合行数（(day, model, peak) 粒度）。
    pub imported: usize,
    /// 幂等吸收（同 fact_id 已在库且值一致）。
    pub duplicate: usize,
    /// 同键不同值且既有行同为 legacy_aggregate → UPDATE 四桶 + updated_at_ms
    /// （ledger 是全量重建的滚动投影，同源快照刷新，见模块注释）。
    pub updated: usize,
    /// 跨 kind 防御分支：既有行的 observation_kind 不是 legacy_aggregate（身份
    /// 契约下不可能出现）→ 写 data_quality_issues，不覆盖也不吸收。
    pub conflicts: usize,
    /// 拒入行数（非法日期/负 token/桶形状错——写 data_quality_issues 的
    /// 同时计数，2026-09-07 审查收口：此前 rejected 恒 0 而 issues 有行，
    /// 迁移摘要与质量面互相矛盾）。
    pub rejected: usize,
}

/// 导入 claude ledger 聚合（当前月文件 + month-archive 的 days）为
/// `usage_facts` 的 `legacy_aggregate` 记录。
///
/// `days` 形状 = `{"YYYY-MM-DD": {"<model>": {4 snake 桶 + 4 peak_ 桶}}}`
/// （claude-ledger.json / claude-ledger-archive.json 的 days 原样切片）。
/// 调用方负责从 ledger/archive 组装（本函数纯：只碰给到的 days）。
///
/// 事务：调用方 `with_immediate_txn` 包整段（与 fact_writer_sql 同纪律）。
/// run_id 必须已存在（`ingested_run_id` 外键；调用方先 `AuthorityDb::begin_run`）。
pub fn import_claude_ledger_days(
    conn: &Connection,
    run_id: &str,
    now_ms: i64,
    days: &serde_json::Value,
) -> Result<LegacyImportReport, AuthorityError> {
    let mut report = LegacyImportReport::default();
    let Some(days) = days.as_object() else {
        // 非对象 days（调用方传错形状）→ 空导入、不编任何 fact。空转不硬错：
        // 空导入本身就是诚实的「这一批没有可导入的日桶」，不是损坏。
        return Ok(report);
    };
    // coverage 标记按「**实际生成一行 legacy 行**的月份」收集：一个月的行全坏
    // （负 token / 非法日期）却还要它打降级标记，是扩大化的假信号。
    let mut months: BTreeSet<String> = BTreeSet::new();

    for (day, models) in days {
        let Some(noon_ms) = parse_day_noon_ms(day) else {
            write_invalid_issue(
                conn,
                now_ms,
                day,
                vec![format!("day key `{day}` 不是可解析的 YYYY-MM-DD 民历日期")],
            )?;
            continue;
        };
        let Some(models) = models.as_object() else {
            write_invalid_issue(
                conn,
                now_ms,
                day,
                vec![format!("day `{day}` 的值不是对象（坏日整日拒入）")],
            )?;
            continue;
        };
        for (model, buckets) in models {
            let Some(buckets) = buckets.as_object() else {
                write_invalid_issue(
                    conn,
                    now_ms,
                    &format!("{day}:{model}"),
                    vec![format!("model `{model}` 的桶不是对象，拒入")],
                )?;
                continue;
            };
            // 每个 (day, model) 拆两行：peak=1（`peak_` 前缀桶）与 peak=0
            // （基础桶）。ledger 若缺 peak_ 子键（旧账），peak 行四桶=0——
            // 表示「该模型峰值子桶未量测」，诚实而非伪造。
            for peak in [0i64, 1i64] {
                match build_legacy_fact(day, model, peak, noon_ms, buckets) {
                    Ok(fact) => {
                        match touch_fact(conn, run_id, now_ms, &fact)? {
                            ImportOutcome::Inserted => report.imported += 1,
                            ImportOutcome::Duplicate => report.duplicate += 1,
                            ImportOutcome::Updated => report.updated += 1,
                            ImportOutcome::Conflict => report.conflicts += 1,
                        }
                        months.insert(day[..7].to_string());
                    }
                    Err(problems) => {
                        write_invalid_issue(
                            conn,
                            now_ms,
                            &format!("{day}:{model}:{peak}"),
                            problems,
                        )?;
                        // 拒入行计入 rejected（2026-09-07 审查收口：此前只写
                        // issue 不计数，checkpoint 的 rejected 键只剩 JSONL
                        // 侧的数，迁移摘要与 issues 面互相矛盾）。
                        report.rejected += 1;
                        if peak == 0 {
                            // base（全量）行都过不了校验 → 同一对里的 peak 子行
                            // 就成了没有主体的孤儿子集（peak ⊆ base，子集不能脱离
                            // 主体存在）。整个对跳过去，不让「只有峰值子行」的空壳
                            // 进库——查询面按 base 对账会拿到对不上的残量。
                            break;
                        }
                    }
                }
            }
        }
    }

    if !months.is_empty() {
        mark_coverage_degradation(conn, now_ms, &months)?;
    }
    Ok(report)
}

/// 由 (day, model, peak, 当日统计时区午时 UTC ms, 桶) 构造一条 legacy 事实。
/// 身份字段全部在此确定；`build_usage_fact` 派生出 fact_id 并覆盖任何外部
/// 传入的 fact_id——此处不重复生成身份哈希。
fn build_legacy_fact(
    day: &str,
    model: &str,
    peak: i64,
    noon_ms: i64,
    buckets: &Map<String, Value>,
) -> Result<LegacyFact, Vec<String>> {
    let mut fields: Map<String, Value> = Map::new();
    fields.insert("machine_namespace".into(), json!(LEGACY_NS));
    fields.insert("harness".into(), json!(LEGACY_HARNESS));
    fields.insert("source_profile".into(), json!(LEGACY_PROFILE));
    fields.insert("native_session_id".into(), json!(format!("day:{day}")));
    fields.insert("source_event_id".into(), json!(format!("{day}:{model}:{peak}")));
    fields.insert("observation_kind".into(), json!(LEGACY_KIND));
    fields.insert("event_ts_utc".into(), json!(format!("{day}T04:00:00Z")));
    fields.insert("model_id".into(), json!(model));

    let mut bucket = [0i64; 4];
    for (i, (src_key, dst_key)) in LEDGER_BUCKET_KEYS.iter().enumerate() {
        let key = if peak == 1 {
            format!("peak_{src_key}")
        } else {
            (*src_key).to_string()
        };
        let v = buckets.get(key.as_str()).and_then(Value::as_i64).unwrap_or(0);
        bucket[i] = v;
        fields.insert((*dst_key).into(), json!(v));
    }
    let doc = agent_vitals_domain::usage_fact::build_usage_fact(&fields)?;
    Ok(LegacyFact { doc, bucket, noon_ms, peak })
}

/// 一条待导入的 legacy 行。
struct LegacyFact {
    doc: Value,
    /// [uncached, cache_read, cache_write, output]——幂等比较基准。
    bucket: [i64; 4],
    /// 统计日 12:00 的 UTC 毫秒（构造期由 day 解析出）。
    noon_ms: i64,
    /// event_peak 的 0/1：`{day}:{model}:{peak}` 的尾字段本身。
    peak: i64,
}

impl LegacyFact {
    fn fact_id(&self) -> &str {
        self.doc["fact_id"].as_str().expect("build_usage_fact 必产 fact_id")
    }
}

/// 幂等/更新/冲突落库返回态。
enum ImportOutcome {
    Inserted,
    Duplicate,
    Updated,
    Conflict,
}

/// 幂等/更新/冲突判定 + 落库。
/// - fact_id 不在库 → INSERT → Inserted。
/// - fact_id 在库且四桶一致 → Duplicate（幂等吸收，无写入）。
/// - fact_id 在库、四桶值变、既有行同为 legacy_aggregate → **UPDATE 四桶 +
///   updated_at_ms** → Updated。ledger 是 `claude_sync` 每次**全量重建**的
///   滚动投影，同键值合法地会变（FOLD_SCHEMA_VERSION 2→3 的全量重折就是
///   实例），且这些月份往往原始 JSONL 已轮转、ledger 是唯一 store of
///   record——不更新就是「旧快照永占 SQL」的静默不可纠正分歧。§6.2.5「旧
///   JSON 永不覆盖更具体的 SQL fact」保护的是**实时行级事实不被 legacy
///   聚合覆盖**（两者来源不同），不适用于 legacy-vs-legacy 的同源快照刷新。
/// - 既有行是别的 observation_kind → 写 `legacy_aggregate_conflict`
///   issue（scope_type="fact"）→ Conflict。这条路径在身份契约下不存在
///   （observation_kind 同时在 UNIQUE 五元组与 fact_id 派生输入里），纯防御：
///   真出现 = 有人绕过契约层手写了同 fact_id 的行，必须浮出来——既不当
///   update 静默改写，也不当 duplicate 吸收。
fn touch_fact(
    conn: &Connection,
    run_id: &str,
    now_ms: i64,
    fact: &LegacyFact,
) -> Result<ImportOutcome, AuthorityError> {
    let fact_id = fact.fact_id();
    let existing: Option<(String, [i64; 4])> = conn
        .query_row(
            "SELECT observation_kind, uncached_input_tokens, cache_read_tokens,
                    cache_write_tokens, output_tokens
             FROM usage_facts WHERE fact_id = ?1",
            rusqlite::params![fact_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    [r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?],
                ))
            },
        )
        .optional()?;
    match existing {
        None => {
            let n = conn.execute(
                "INSERT INTO usage_facts(
                     fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, source_profile, model_id, event_ts_ms, event_peak,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                rusqlite::params![
                    fact_id,
                    LEGACY_HARNESS,
                    LEGACY_NS,
                    fact.doc["native_session_id"].as_str().unwrap_or_default(),
                    fact.doc["source_event_id"].as_str().unwrap_or_default(),
                    LEGACY_KIND,
                    LEGACY_PROFILE,
                    fact.doc["model_id"].as_str().unwrap_or_default(),
                    fact.noon_ms,
                    fact.peak,
                    fact.bucket[0],
                    fact.bucket[1],
                    fact.bucket[2],
                    fact.bucket[3],
                    run_id,
                    now_ms,
                    now_ms,
                ],
            )?;
            // 同事务已 SELECT 确认 fact_id 不存在；0 行 = 唯一五元组被占（身份
            // 契约下的对撞），诚实上抛，不静默当 duplicate。
            if n == 0 {
                return Err(AuthorityError::Sqlite(
                    rusqlite::Error::InvalidParameterName(format!(
                        "__legacy_import_unexpected_noop__:{fact_id}"
                    )),
                ));
            }
            Ok(ImportOutcome::Inserted)
        }
        Some((_kind, old)) if old == fact.bucket => Ok(ImportOutcome::Duplicate),
        Some((kind, _old)) if kind == LEGACY_KIND => {
            let n = conn.execute(
                "UPDATE usage_facts
                 SET uncached_input_tokens = ?1, cache_read_tokens = ?2,
                     cache_write_tokens = ?3, output_tokens = ?4, updated_at_ms = ?5,
                     ingested_run_id = ?6
                 WHERE fact_id = ?7",
                rusqlite::params![
                    fact.bucket[0],
                    fact.bucket[1],
                    fact.bucket[2],
                    fact.bucket[3],
                    now_ms,
                    run_id,
                    fact_id,
                ],
            )?;
            // 同事务刚 SELECT 到该行；0 行 = 契约外并发写入，诚实上抛。
            if n == 0 {
                return Err(AuthorityError::Sqlite(
                    rusqlite::Error::InvalidParameterName(format!(
                        "__legacy_import_update_noop__:{fact_id}"
                    )),
                ));
            }
            Ok(ImportOutcome::Updated)
        }
        Some((kind, old)) => {
            write_conflict_issue(conn, now_ms, fact, old, &kind)?;
            Ok(ImportOutcome::Conflict)
        }
    }
}

/// 跨 kind 防御分支 → `legacy_aggregate_conflict` issue。身份契约下不可能
/// 触发；detail 携带既有 kind + 桶值 + 本次桶值，供人工排查契约外写入。
fn write_conflict_issue(
    conn: &Connection,
    now_ms: i64,
    fact: &LegacyFact,
    existing: [i64; 4],
    existing_kind: &str,
) -> Result<(), AuthorityError> {
    let detail = json!({
        "harness": LEGACY_HARNESS,
        "observation_kind": LEGACY_KIND,
        "fact_id": fact.fact_id(),
        "existing_kind": existing_kind,
        "existing_buckets": bucket_map(existing),
        "incoming_buckets": bucket_map(fact.bucket),
        "note": "同 fact_id 已有非 legacy_aggregate 行——身份契约下不可能（observation_kind 在 fact_id 派生输入里），疑似契约外写入；按 spec §6.2.5 旧 JSON 永不覆盖更具体的 SQL fact，既有行保持不动",
    });
    write_issue(
        conn,
        &format!("legacy_aggregate_conflict:{}", fact.fact_id()),
        "fact",
        fact.fact_id(),
        "legacy_aggregate_conflict",
        "warning",
        now_ms,
        &detail,
    )
}

/// 未入库候选（负桶 / 非法 day 等）→ code="invalid_fact" 的 issue，词汇与
/// fact_writer_sql 一致——不静默吞掉问题行。
fn write_invalid_issue(
    conn: &Connection,
    now_ms: i64,
    scope_key: &str,
    problems: Vec<String>,
) -> Result<(), AuthorityError> {
    let detail = json!({
        "harness": LEGACY_HARNESS,
        "observation_kind": LEGACY_KIND,
        "problems": problems,
        "note": "legacy ledger 导入时该候选未通过契约校验（token 负值 / 非法 day key），未入库",
    });
    write_issue(
        conn,
        &format!("legacy_invalid:{scope_key}"),
        "fact",
        scope_key,
        "invalid_fact",
        "warning",
        now_ms,
        &detail,
    )
}

/// coverage 降级标记（查询方据此降 coverage）：批内月份数唯一 → scope_key=
/// 月份；跨月 → "all"（单一批只写一条）。ON CONFLICT 只推 last_seen_at，
/// first_seen 稳定——它记录该 scope 第一次有 legacy import 的时间。
fn mark_coverage_degradation(
    conn: &Connection,
    now_ms: i64,
    months: &BTreeSet<String>,
) -> Result<(), AuthorityError> {
    // 逐月写标记（2026-09-07 审查收口：旧实现跨月批粗化为 scope_key="all"，
    // 消费方因此无法回答「这个月是否被聚合兜底」——current month 有实时行
    // 也被连带标进 all，过度标注与漏标注都不可取）。UNIQUE(scope_type,
    // scope_key, code) 保证重跑幂等吸收。
    for month in months {
        let detail = json!({
            "harness": LEGACY_HARNESS,
            "observation_kind": LEGACY_KIND,
            "months": [month],
            "note": "claude-ledger 深历史以 legacy 聚合导入：底层会话文件已轮转/压缩，无法从现存 raw 源重放；本 scope 的 coverage 应作降级标注（spec §6.2.3）",
        });
        write_issue(
            conn,
            &format!("legacy_aggregate:{month}"),
            "month",
            month,
            "legacy_aggregate",
            "info",
            now_ms,
            &detail,
        )?;
    }
    Ok(())
}

fn bucket_map(b: [i64; 4]) -> Value {
    json!({
        "uncached_input_tokens": b[0],
        "cache_read_tokens": b[1],
        "cache_write_tokens": b[2],
        "output_tokens": b[3],
    })
}

/// `data_quality_issues` 统一 upsert：语义 = (scope_type, scope_key, code)。
/// 重见只刷 last_seen + 更新 detail，first_seen 稳定。
///
/// 8 个参数越过 clippy 的 7 上限，但这是列与值的平铺映射（issue 全列一网打
/// 尽），拆成 struct 反而多一层转换；该函数是私有统一写点，聚使用方有数。
#[allow(clippy::too_many_arguments)]
fn write_issue(
    conn: &Connection,
    issue_id: &str,
    scope_type: &str,
    scope_key: &str,
    code: &str,
    severity: &str,
    now_ms: i64,
    detail: &Value,
) -> Result<(), AuthorityError> {
    conn.execute(
        "INSERT INTO data_quality_issues(
             issue_id, scope_type, scope_key, code, severity,
             first_seen_at_ms, last_seen_at_ms, detail_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(scope_type, scope_key, code) DO UPDATE SET
             last_seen_at_ms = excluded.last_seen_at_ms,
             detail_json = excluded.detail_json",
        rusqlite::params![issue_id, scope_type, scope_key, code, severity, now_ms, now_ms, detail.to_string()],
    )?;
    Ok(())
}

/// "YYYY-MM-DD" → 北京日 12:00 的 UTC 毫秒。合法民历日才 Some（02-30 在
/// 统计时区由 `TZ`（或 OS 时区）决定，日期校验由 Jiff 完成。
fn parse_day_noon_ms(day: &str) -> Option<i64> {
    if day.len() != 10 || !day.is_ascii() {
        return None;
    }
    let (y, mo, d) = (
        day.get(0..4)?.parse::<i64>().ok()?,
        day.get(5..7)?.parse::<u32>().ok()?,
        day.get(8..10)?.parse::<u32>().ok()?,
    );
    let date = Date::new(y.try_into().ok()?, mo.try_into().ok()?, d.try_into().ok()?).ok()?;
    let timezone = std::env::var("TZ")
        .ok()
        .map(|value| value.trim_start_matches(':').to_string())
        .filter(|name| !name.is_empty())
        .and_then(|name| TimeZone::get(&name).ok())
        .unwrap_or_else(TimeZone::system);
    date.to_zoned(timezone)
        .ok()?
        .timestamp()
        .checked_add(12.hours())
        .ok()
        .map(|timestamp| timestamp.as_millisecond())
}

/// 读取 claude ledger 的文件并合并 days。**当前月文件优先**：archive 是滚动
/// 前旧值，同名日以 `claude-ledger.json` 里的最新为准。返回 `{"YYYY-MM-DD":
/// {"<model>": {…}}}` 形状。缺文件 → 空对象；文件存在但非 JSON / 顶层非对象
/// → Err（坏文件必须浮出来）。
pub fn load_claude_ledger_days(state_dir: &Path) -> Result<serde_json::Value, AuthorityError> {
    let mut merged: Map<String, Value> = Map::new();
    if let Some(archive) = read_ledger_json(state_dir, "claude-ledger-archive.json")? {
        if let Some(months) = archive.get("months").and_then(Value::as_object) {
            for entry in months.values() {
                if let Some(days) = entry.get("days").and_then(Value::as_object) {
                    for (d, v) in days {
                        merged.insert(d.clone(), v.clone());
                    }
                }
            }
        }
    }
    if let Some(current) = read_ledger_json(state_dir, "claude-ledger.json")? {
        if let Some(days) = current.get("days").and_then(Value::as_object) {
            for (d, v) in days {
                merged.insert(d.clone(), v.clone());
            }
        }
    }
    Ok(Value::Object(merged))
}

/// claude ledger 的 `unaccounted` 池（`{model: {4 型 snake 桶}}`）——cost-state
/// 累计基线减去逐行事实和的**无日期**残差（`claude_cost.py::_rebuild_days`：
/// 压缩/截断丢失了逐行 ts 证据的早期历史，「不知道何时发生的，不能假装知道」）。
/// 缺文件 / 缺键 → `{}`。归档文件不带 `unaccounted`（残差是当前 fold 的产物），
/// 只读 `claude-ledger.json`。
pub fn load_claude_ledger_unaccounted(state_dir: &Path) -> Result<serde_json::Value, AuthorityError> {
    match read_ledger_json(state_dir, "claude-ledger.json")? {
        Some(v) => Ok(v.get("unaccounted").cloned().unwrap_or_else(|| json!({}))),
        None => Ok(json!({})),
    }
}

/// **裁决（v0.9.1 Phase 4，spec §5.4）**：ledger 的无日期残差**不进 `usage_facts`**
/// ——它没有日期，编一个北京日就是 fabrication。也不能静默丢（§5.4「无日期或
/// 质量异常事实不能静默删除，必须先标记」）。折中：`data-migrate` 时把整个残差
/// 池汇总成**一条 `data_quality_issues`**（`code='undated_residual'`），逐模型
/// token 数写进 `detail_json`。作用：① `data-status`/`data-unresolved` 可见；
/// ② SQL vs ledger 对账（Phase 4.1）的 token 缺口 = 这条残差，显式可解释，不是
/// 神秘 mismatch。返回残差 token 总量（0 = 无残差，不写 issue）。幂等
/// （`ON CONFLICT` 刷新 detail + last_seen）。
pub fn import_claude_ledger_unaccounted(
    conn: &Connection,
    now_ms: i64,
    unaccounted: &serde_json::Value,
) -> Result<u64, AuthorityError> {
    let Some(models) = unaccounted.as_object() else {
        return Ok(0);
    };
    let bucket = |m: &Value, k: &str| -> i64 {
        m.get(k).and_then(Value::as_i64).unwrap_or(0)
    };
    let mut by_model: Map<String, Value> = Map::new();
    let mut total: i64 = 0;
    for (model, t4) in models {
        let sum: i64 = LEDGER_BUCKET_KEYS
            .iter()
            .map(|(snake, _)| bucket(t4, snake).max(0))
            .sum();
        if sum > 0 {
            by_model.insert(model.clone(), json!(sum));
            total += sum;
        }
    }
    if total <= 0 {
        return Ok(0);
    }
    let detail = json!({
        "harness": LEGACY_HARNESS,
        "by_model_tokens": by_model,
        "total_tokens": total,
        "source": "claude-ledger.json::unaccounted",
        "note": "cost-state 累计基线减去逐行事实和的无日期残差（压缩/截断丢失逐行 ts 证据的早期历史）。裁决（Phase 4/§5.4）：不编日期塞进 usage_facts，记为覆盖缺口——SQL vs ledger 对账的 token 差 = 此值。",
    });
    write_issue(
        conn,
        "undated_residual:claude-ledger",
        "source",
        "claude-ledger.json#unaccounted",
        "undated_residual",
        "info",
        now_ms,
        &detail,
    )?;
    Ok(total as u64)
}

/// 读 ledger/archive 文件。缺失 → Ok(None)；存在但非法 JSON / 顶层非对象 →
/// Err。
fn read_ledger_json(state_dir: &Path, name: &str) -> Result<Option<Value>, AuthorityError> {
    let path = state_dir.join(name);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AuthorityError::Io(e)),
    };
    let v: Value = serde_json::from_slice(&raw).map_err(|e| {
        AuthorityError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{}: 非合法 JSON ({e})", path.display()),
        ))
    })?;
    if !v.is_object() {
        return Err(AuthorityError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{} 顶层不是对象", path.display()),
        )));
    }
    Ok(Some(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::AuthorityDb;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avd-legacy-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn import_writes_two_rows_per_model_and_is_idempotent() {
        let root = tmp_dir("shape");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let days = json!({
            "2026-05-05": {
                "model-a": {
                    "input_tokens": 10_000,
                    "cache_read_input_tokens": 2_000,
                    "cache_creation_input_tokens": 500,
                    "output_tokens": 1_000,
                    "peak_input_tokens": 6_000,
                    "peak_cache_read_input_tokens": 1_000,
                    "peak_cache_creation_input_tokens": 200,
                    "peak_output_tokens": 400,
                },
                "no-peak-model": {
                    "input_tokens": 50,
                    "cache_read_input_tokens": 10,
                    "cache_creation_input_tokens": 0,
                    "output_tokens": 7,
                },
            }
        });
        let report = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &days))
            .unwrap();
        assert_eq!(report.imported, 4, "两个 model × 2 行（base+peak）");
        assert_eq!(report.duplicate, 0);
        assert_eq!(report.conflicts, 0);

        let conn = db.conn();

        // base 行形状。
        type BaseRow = (
            String, String, String, String, String, String, String,
            i64, i64, i64, i64, i64, i64,
        );
        let row: BaseRow =
            conn.query_row(
                "SELECT harness, machine_namespace, source_profile, native_session_id,
                        source_event_id, observation_kind, model_id, event_peak,
                        event_ts_ms, uncached_input_tokens, cache_read_tokens,
                        cache_write_tokens, output_tokens
                 FROM usage_facts WHERE source_event_id = '2026-05-05:model-a:0'",
                [],
                |r| {
                    Ok((
                        r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                        r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                        r.get(10)?, r.get(11)?, r.get(12)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "claude-code");
        assert_eq!(row.1, "legacy");
        assert_eq!(row.2, "ledger");
        assert_eq!(row.3, "day:2026-05-05");
        assert_eq!(row.4, "2026-05-05:model-a:0");
        assert_eq!(row.5, "legacy_aggregate");
        assert_eq!(row.6, "model-a");
        assert_eq!(row.7, 0, "base 行 event_peak=0");
        assert_eq!(
            row.8,
            parse_day_noon_ms("2026-05-05").unwrap()
        );
        assert_eq!((row.9, row.10, row.11, row.12), (10_000, 2_000, 500, 1_000));

        // peak=1 行：四桶取 peak_ 前缀子桶。注意 —— 顺序不分。
        let peak_row = conn
            .query_row(
                "SELECT event_peak, uncached_input_tokens, cache_read_tokens,
                        cache_write_tokens, output_tokens
                 FROM usage_facts WHERE source_event_id = '2026-05-05:model-a:1'",
                [],
                |r| Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                )),
            )
            .unwrap();
        assert_eq!((peak_row.0, peak_row.1, peak_row.2, peak_row.3, peak_row.4),
                   (1, 6_000, 1_000, 200, 400));

        // 无 peak 键的 model：peak 行全 0。
        let no_peak = conn
            .query_row(
                "SELECT uncached_input_tokens, cache_read_tokens,
                        cache_write_tokens, output_tokens
                 FROM usage_facts WHERE source_event_id = '2026-05-05:no-peak-model:1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(no_peak, (0, 0, 0, 0));

        // fact_id === 身份字段可复算。
        let stored_id: String = conn
            .query_row(
                "SELECT fact_id FROM usage_facts WHERE source_event_id='2026-05-05:model-a:0'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let recomputed = agent_vitals_domain::usage_fact::fact_id(
            "legacy", "claude-code", "ledger", "day:2026-05-05",
            "2026-05-05:model-a:0", "legacy_aggregate",
        );
        assert_eq!(stored_id, recomputed);

        // 幂等：原样重跑 → 全 duplicate，无新行，coverage 标记仍一条。
        let report2 = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &days))
            .unwrap();
        assert_eq!((report2.imported, report2.duplicate, report2.conflicts), (0, 4, 0));
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM usage_facts WHERE observation_kind='legacy_aggregate'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 4);
        let marks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues WHERE code='legacy_aggregate'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marks, 1, "coverage 标记同 key 幂等 ON CONFLICT 不叠加");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn invalid_peak_row_leaves_base_imported_without_orphan_peak() {
        // 审查钉测：base（peak=0）行校验通过、peak 行失败（负 peak token）
        // 时——base 照常入账，peak 行拒入且不留孤儿。查询面按「base 全量 −
        // peak 子集」拆价，peak 缺失 = 该模型峰值子桶未量测（诚实），不是
        // 对账残量。
        let root = tmp_dir("peak-orphan");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let days = json!({
            "2026-09-01": {"m1": {
                "input_tokens": 100, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 10,
                "peak_input_tokens": -5, "peak_cache_read_input_tokens": 0,
                "peak_cache_creation_input_tokens": 0, "peak_output_tokens": 0}}
        });
        let report = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &days))
            .unwrap();
        assert_eq!(report.imported, 1, "仅 base 行入账");
        let peaks: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM usage_facts WHERE source_event_id LIKE '%:1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(peaks, 0, "peak 行被拒，无孤儿");
    }

    #[test]
    fn import_value_change_updates_legacy_row_then_rerun_is_duplicate() {
        // Phase 3.2 审查修复：旧语义（同键不同值 → conflict + 永不覆盖）让
        // SQL 永远留着旧快照——ledger 是 claude_sync 全量重建的滚动投影，同
        // (day, model, peak) 键的桶值合法地会变（FOLD_SCHEMA_VERSION 2→3 的
        // 全量重折就是实例），且这些月份的原始 JSONL 已轮转、ledger 是唯一
        // store of record，冲突不更新 = 静默且不可纠正的分歧。同 kind 的值
        // 变 → 更新为新值并计 updated。
        let root = tmp_dir("conflict");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let v1 = json!({
            "2026-09-01": {"m1": {
                "input_tokens": 100, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 10}}
        });
        db.with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &v1)).unwrap();
        // 同 (day, m1, 0) 的 output_tokens 变了：更新既有行为新值，计 updated。
        let v2 = json!({
            "2026-09-01": {"m1": {
                "input_tokens": 100, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 999}}
        });
        let rep = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run", 2_000, &v2))
            .unwrap();
        assert_eq!(
            (rep.imported, rep.duplicate, rep.updated, rep.conflicts),
            (0, 1, 1, 0),
            "peak=1 行未变 dup；peak=0 行值变 → updated"
        );
        let (out, upd): (i64, i64) = db
            .conn()
            .query_row(
                "SELECT output_tokens, updated_at_ms FROM usage_facts
                 WHERE source_event_id='2026-09-01:m1:0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(out, 999, "同 kind 同源快照 → SQL 值随 ledger 刷新");
        assert_eq!(upd, 2_000, "updated_at_ms 滚到本次导入时钟，created 稳定");

        // 更新路径的审计痕迹（2026-09-07 审查收口）：ingested_run_id 必须滚
        // 到本次 run（last-writer 溯源——事后能回答「这行最后一次被哪次导入
        // 改写」，否则 UPDATE 后仍指向首跑 run，值与溯源脱节）。
        db.begin_run("run-2", "migration", 4_000).unwrap();
        let v3 = json!({
            "2026-09-01": {"m1": {
                "input_tokens": 100, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 555}}
        });
        db.with_immediate_txn(|c| import_claude_ledger_days(c, "run-2", 5_000, &v3))
            .unwrap();
        let (rid, out2): (String, i64) = db
            .conn()
            .query_row(
                "SELECT ingested_run_id, output_tokens FROM usage_facts
                 WHERE source_event_id='2026-09-01:m1:0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rid.as_str(), out2), ("run-2", 555), "UPDATE 刷新 ingested_run_id");

        // 更新后原样重跑（最新值 v3、同 run-2）→ 全 duplicate（幂等），不再
        // 产生 updated。
        let rep2 = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run-2", 6_000, &v3))
            .unwrap();
        assert_eq!(
            (rep2.imported, rep2.duplicate, rep2.updated, rep2.conflicts),
            (0, 2, 0, 0)
        );
        let issues: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(issues, 1, "更新路径只留 coverage 降级标记，无 conflict issue");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn cross_kind_row_is_conflict_not_update() {
        // 防御分支：observation_kind 不同的既有行（身份契约下不可能——
        // kind 在 fact_id 派生输入里）不走 update 静默改写，也不当 duplicate
        // 吸收，而是写 legacy_aggregate_conflict issue 浮出来（§6.2.5 保护
        // 「非 legacy 来源的更具体 SQL fact 不被旧 JSON 覆盖」的那条真边界）。
        let root = tmp_dir("crosskind");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let days = json!({
            "2026-09-01": {"m1": {
                "input_tokens": 100, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 10}}
        });
        // 以本批 legacy 行的 fact_id 手写一条别的 kind 的行（绕过契约层）。
        let borrowed_id = agent_vitals_domain::usage_fact::fact_id(
            "legacy",
            "claude-code",
            "ledger",
            "day:2026-09-01",
            "2026-09-01:m1:0",
            "legacy_aggregate",
        );
        db.conn()
            .execute(
                "INSERT INTO usage_facts(
                     fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, source_profile, model_id, event_ts_ms, event_peak,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1,'claude-code','legacy','day:2026-09-01','2026-09-01:m1:0',
                     'token_count','default','m1',0,0,7,0,0,0,'run',1,1)",
                rusqlite::params![borrowed_id],
            )
            .unwrap();
        let rep = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run", 2_000, &days))
            .unwrap();
        assert_eq!(rep.updated, 0, "跨 kind 不走 update");
        assert_eq!(rep.conflicts, 1, "契约外写入必须浮出来");
        assert_eq!(rep.imported, 1, "peak=1 行照常入账，批不被中断");
        let out: i64 = db
            .conn()
            .query_row(
                "SELECT uncached_input_tokens FROM usage_facts WHERE fact_id = ?1",
                rusqlite::params![borrowed_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(out, 7, "既有行保持不动");
        let n: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues WHERE code='legacy_aggregate_conflict'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn empty_days_imports_nothing() {
        let root = tmp_dir("empty");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let days = json!({});
        let rep = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &days))
            .unwrap();
        assert_eq!(rep, LegacyImportReport::default());
        let n: i64 = db.conn().query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0)).unwrap();
        let m: i64 = db.conn().query_row("SELECT COUNT(*) FROM data_quality_issues", [], |r| r.get(0)).unwrap();
        assert_eq!((n, m), (0, 0), "空导入不落事实、不落降级标记");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn negative_token_and_invalid_day_rejected_with_issues() {
        let root = tmp_dir("neg");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let days = json!({
            "2026-09-02": {"bad-model": {
                "input_tokens": -5, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 0}}
        });
        let rep = db
            .with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &days))
            .unwrap();
        assert_eq!(rep.imported, 0, "负值桶不落库");
        let (code, sev): (String, String) = db
            .conn()
            .query_row(
                "SELECT code, severity FROM data_quality_issues WHERE code='invalid_fact'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((code.as_str(), sev.as_str()), ("invalid_fact", "warning"));

        // 非法 day "2026-13-40" 也以 invalid_fact 拒入。
        let bad_day = json!({
            "2026-13-40": {"m2": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                    "cache_creation_input_tokens": 0, "output_tokens": 0}}
        });
        db.with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &bad_day)).unwrap();
        let bad_rows: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM usage_facts WHERE source_event_id LIKE '2026-13-40:%'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(bad_rows, 0);
        let bad_issue: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM data_quality_issues WHERE scope_key='2026-13-40'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(bad_issue, 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn coverage_mark_single_month_batch_uses_month_as_key() {
        let root = tmp_dir("cov1");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let days = json!({
            "2026-05-31": {"m": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 1}}
        });
        db.with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &days)).unwrap();
        let (issue, st, key, code, sev): (String, String, String, String, String) = db
            .conn()
            .query_row(
                "SELECT issue_id, scope_type, scope_key, code, severity
                 FROM data_quality_issues WHERE code='legacy_aggregate'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(issue, "legacy_aggregate:2026-05");
        assert_eq!((code.as_str(), sev.as_str()), ("legacy_aggregate", "info"));
        assert_eq!(st, "month");
        assert_eq!(key, "2026-05");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn coverage_marks_each_month_when_batch_straddles_months() {
        let root = tmp_dir("covall");
        let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
        db.begin_run("run", "migration", 1_000).unwrap();
        let days = json!({
            "2026-08-31": {"m": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 1}},
            "2026-09-15": {"m": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 1}}
        });
        db.with_immediate_txn(|c| import_claude_ledger_days(c, "run", 1_000, &days)).unwrap();
        // 2026-09-07 审查收口：跨月批从粗化 scope_key='all' 改为**逐月**写
        // 标记——消费方（SqlSummaryRepository 的 freshness 降级）必须能回答
        // 「这个月是否被聚合兜底」，'all' 会让有实时行的当月被连带标进去。
        let mut keys: Vec<String> = db
            .conn()
            .prepare(
                "SELECT scope_key FROM data_quality_issues
                 WHERE code='legacy_aggregate' ORDER BY scope_key",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        keys.sort();
        assert_eq!(keys, vec!["2026-08", "2026-09"], "跨月批 → 逐月标记");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn load_prefers_current_ledger_over_archive_same_day() {
        let dir = tmp_dir("load");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("claude-ledger.json"),
            json!({
                "days": {
                    "2026-09-01": {"cur": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                             "cache_creation_input_tokens": 0, "output_tokens": 10}},
                    "2026-09-02": {"only-current": {"input_tokens": 2, "cache_read_input_tokens": 0,
                                                      "cache_creation_input_tokens": 0, "output_tokens": 20}},
                },
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("claude-ledger-archive.json"),
            json!({
                "months": {
                    "2026-08": {"days": {"2026-08-31": {"aug": {
                        "input_tokens": 8, "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0, "output_tokens": 80}}}},
                    "2026-09": {"days": {"2026-09-01": {"stale-model": {
                        "input_tokens": 9, "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0, "output_tokens": 999}}}},
                },
            })
            .to_string(),
        )
        .unwrap();
        let merged = load_claude_ledger_days(&dir).unwrap();
        let days = merged.as_object().unwrap();
        assert_eq!(days["2026-09-01"]["cur"]["output_tokens"], 10, "同日当前月文件优先");
        assert!(days["2026-09-01"].get("stale-model").is_none());
        assert_eq!(days["2026-08-31"]["aug"]["output_tokens"], 80);
        assert!(days.contains_key("2026-09-02"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn load_missing_files_yields_empty_days() {
        let dir = tmp_dir("missing");
        let days = load_claude_ledger_days(&dir).unwrap();
        assert_eq!(days, json!({}));
        assert_eq!(load_claude_ledger_unaccounted(&dir).unwrap(), json!({}));
        std::fs::remove_dir_all(dir).ok();
    }

    /// 裁决（Phase 4/§5.4）：ledger 的 `unaccounted` 无日期残差不进
    /// `usage_facts`（不编日期），记为**一条** `undated_residual` issue，
    /// 逐模型 token 写 detail。幂等：再跑刷新 detail、不新增行。总量为 0 →
    /// 不写 issue。
    #[test]
    fn unaccounted_residual_becomes_one_coverage_gap_issue_not_facts() {
        let dir = tmp_dir("unacc");
        let db = crate::authority::AuthorityDb::open(
            &crate::authority::default_authority_path(&dir),
            1,
        )
        .unwrap();
        let unacc = json!({
            "MiniMax-M3": {
                "input_tokens": 1_650_000, "cache_read_input_tokens": 76_341_316,
                "cache_creation_input_tokens": 0, "output_tokens": 285_264,
            },
            "MiniMax-M2": {
                "input_tokens": 334_923, "cache_read_input_tokens": 6_289,
                "cache_creation_input_tokens": 0, "output_tokens": 104_765,
            },
            "all-zero-model": {
                "input_tokens": 0, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 0,
            },
        });
        let want_total: i64 = 1_650_000 + 76_341_316 + 285_264 + 334_923 + 6_289 + 104_765;
        let recorded = db
            .with_immediate_txn(|c| import_claude_ledger_unaccounted(c, 5_000, &unacc))
            .unwrap();
        assert_eq!(recorded as i64, want_total);

        let conn = db.conn();
        // 恰一条 issue，code = undated_residual。
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues WHERE code = 'undated_residual'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        // usage_facts 一行都没写（残差不编造成事实）。
        let facts: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(facts, 0, "残差绝不进 usage_facts");
        // detail 里逐模型 + 总量，全零模型不出现。
        let detail: String = conn
            .query_row(
                "SELECT detail_json FROM data_quality_issues WHERE code = 'undated_residual'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let d: Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(d["total_tokens"].as_i64().unwrap(), want_total);
        assert!(d["by_model_tokens"].get("all-zero-model").is_none());
        assert_eq!(d["by_model_tokens"]["MiniMax-M2"].as_i64().unwrap(), 445_977);

        // 幂等：再跑 → 仍一条。
        db.with_immediate_txn(|c| import_claude_ledger_unaccounted(c, 6_000, &unacc)).unwrap();
        let n2: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM data_quality_issues WHERE code = 'undated_residual'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n2, 1);

        // 空池 → 不写 issue。
        assert_eq!(
            db.with_immediate_txn(|c| import_claude_ledger_unaccounted(c, 7_000, &json!({})))
                .unwrap(),
            0
        );
        std::fs::remove_dir_all(dir).ok();
    }
}
