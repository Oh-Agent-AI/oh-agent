//! v0.9.1（SQL Authority Migration，spec §3/§7 Phase 1）：**SQLite 单一运行时
//! 权威库**——`<data_home>/agent-vitals.sqlite3`。
//!
//! 与旧 `store`（index.sqlite3）的本质区别（spec §1.1 不可变决策）：
//! - 本库是**运行时权威数据源**，不是可重建投影；「删库 → 从 JSONL 重建」
//!   不再是正常恢复方式。损坏 → 如实报错，恢复 = 用户备份 + 执行环境原始日志
//!   重放（§7 Phase 1），恢复不了就报 coverage 缺口，绝不静默回落另一本账。
//! - `facts/*.jsonl` 降级为迁移/导出输入；执行环境日志是不可信输入，必须经
//!   清洗校验才能进 `usage_facts`。
//! - 所有写入走 `BEGIN IMMEDIATE` 事务 + `sync_runs` 记录；running 批次在
//!   下次 open 时标 interrupted（§3.1）。
//!
//! **时钟纪律**：本 crate 不读时钟（dependency_budget 禁 chrono/time，且
//! 「事实自带事件时间」的同款纪律）——所有 `*_at_ms` 由调用方（runtime）
//! 注入。规格的 `CHECK`/`UNIQUE`/部分索引逐条照搬 spec §3，DDL 是 spec 的
//! 镜像，改动必须两处同步 + 递增 [`SCHEMA_VERSION`]。
//!
//! Phase 1 范围：DDL + migration runner + 事务帮助器 + sync_runs。写入端
//! （SQL writer）与查询端（SqlSummaryRepository）是 Phase 2/3。

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use agent_vitals_domain::billing::{BillingTemplateKind, PricingSource};

use crate::safe_query::authority_callback;

/// 当前 DDL 版本。spec §3 的表结构变更递增；`migrations` 表（§3.5）记录的
/// 是**数据迁移**（legacy import 等），与 DDL 版本刻意分开。
///
/// v2（`harness_runtime_snapshots`）走 `MIGRATE_V1_TO_V2` 升级。增量 7.5 的 4 个
/// 脱敏只读 view（`v_facts_safe` / …）是**版本无关**的只读加法：`VIEWS_V1`
/// 在每次 open 用 `CREATE VIEW IF NOT EXISTS` 幂等重建，不占版本号。
// v31 is an internal-development breaking rename: host columns become harness.
// Existing host-column databases must be rebuilt, never silently reinterpreted.
pub const SCHEMA_VERSION: i64 = 33;

/// 权威库默认路径：`<data_home>/agent-vitals.sqlite3`（spec §3）。
/// 旧 `index.sqlite3` 是独立的遗留投影；本函数不导入、解释或删除它。
pub fn default_authority_path(data_home: &Path) -> PathBuf {
    data_home.join("agent-vitals.sqlite3")
}

/// 每日同步叠加层在 `provider_catalog_snapshots` / `pricing_snapshots` 里的来源标记。
pub const PRICING_SYNC_OVERLAY_SOURCE: &str = "public-sync-overlay";

/// 最近一次入库的同步叠加层原文。自由函数版本给只拿得到 `Connection` 的查询
/// 用（历史回补在 `authority_query` 里按会话计价时需要它）。
pub fn latest_pricing_sync_overlay(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT payload_json FROM provider_catalog_snapshots
         WHERE source_kind = ?1
         ORDER BY captured_at_ms DESC, catalog_version DESC LIMIT 1",
        rusqlite::params![PRICING_SYNC_OVERLAY_SOURCE],
        |r| r.get(0),
    )
    .optional()
}

/// `harness_bills_for_period` 的一行：`(harness, provider_id, billing_basis,
/// amount_minor, currency)`。`amount_minor` 是最小货币单位整数——金额从不
/// 以浮点入库（spec §5.3），折算在展示层。
pub type HarnessBillRow = (String, String, String, i64, String);
pub type HarnessBillDetailRow = (String, String, String, String, i64, String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustMonitorState {
    pub enabled: bool,
    /// R6a 知情同意标记（v27）：legacy_default / default / user / dismissed。
    pub enabled_source: String,
    pub interval_seconds: i64,
    pub notifications_enabled: bool,
    pub capability: String,
    pub last_success_at_ms: Option<i64>,
    pub last_error_code: Option<String>,
    pub last_alert_key: Option<String>,
    pub last_alert_at_ms: Option<i64>,
    pub updated_at_ms: i64,
}

/// 用户计费声明的一行：关系本身和付款/账单分开建模。金额可未知，不能以
/// `harness_bills` 的实付金额或公开价卡来填充。
/// `(declaration_id, provider_id, relationship_kind, subscription_name, amount_minor, currency,
/// effective_start, effective_end, source_candidate_id)`——**没有执行环境**：声明属于服务商账号，
/// 按模型使用结算，执行环境只是用量的来源壳（见 [`ALL_HARNESSES`]）。
pub type BillingDeclarationRow = (
    String, String, String, Option<String>, Option<i64>, Option<String>,
    String, Option<String>, Option<String>,
);

/// 能把声明收窄到一部分用量的作用域种类。`provider=unresolved`（「服务商为空」的事实）与 `settlement`
/// （结算币种）不是收窄，只是匹配方式 / 声明属性。
fn is_narrowing_scope(kind: &str) -> bool {
    matches!(kind, "account" | "route" | "model" | "session")
}

/// 「服务商未知」的答复却没有任何收窄作用域 = 对**所有执行环境、所有服务商为空**的用量的兜底声明。
/// 声明不再绑执行环境之后，执行环境不再替它兜住边界，所以这类声明既不允许写入、也不匹配任何事实
/// （见 [`billing_declaration_fact_selection_with`]）：模型（或路由 / 账户 / 会话）是这类答复唯一的收窄依据。
fn is_unbounded_unresolved(scopes: &[(&str, &str)]) -> bool {
    scopes.iter().any(|(kind, value)| *kind == "provider" && *value == "unresolved")
        && !scopes.iter().any(|(kind, _)| is_narrowing_scope(kind))
}

/// `billing_declarations.harness` / `billing_declaration_revisions.harness` 的**固定值**。
///
/// 计费声明是服务商账号上的关系（订阅、API Key、中转），结算按「服务商 + 模型」，与用量是从哪个执行环境
/// 来的无关——同一个 GLM Lite 套餐在 Claude Code 和 ZCode 里是同一份，同一个中转账号在 Claude Code
/// 和 Codex 里也是同一个账号。曾经声明按 `(执行环境, 服务商)` 切分，同一服务商在每个执行环境各留一份，
/// 生效期还会各自漂移，匹配时也要额外开「账号级」补丁。
///
/// 该列因旧库的 `NOT NULL` 保留，只写这个常量、**任何谓词都不读它**——想把执行环境重新当成匹配条件，
/// 必须先改这条文档。需要收窄用声明的作用域（account / route / model / session）。
pub const ALL_HARNESSES: &str = "*";
/// 声明修订的稳定读取行。修订为追加记录，绝不覆盖先前用户输入。
pub type BillingDeclarationRevisionRow = (
    String,
    String,
    i64,
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);
/// 修订的一项可选作用范围：`account`、`route`、`model` 或 `session`。
pub type BillingDeclarationScopeRow = (String, String, String);
pub type BillingRecalculationJobRow = (
    String, String, String, String, i64, Option<i64>, Option<i64>, Option<String>, Option<String>,
);
pub type BillingRecalculationResultRow = (String, String, i64, i64, i64, Option<i64>, Option<i64>, i64);
/// [`AuthorityDb::billing_apply_active_declarations`] 的回执：看了几条有效修订、
/// 新写了几行归因。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BillingApplyReport {
    pub revisions: usize,
    pub attributed: usize,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BillingDeclarationImpactPreview {
    pub fact_count: i64,
    pub session_count: i64,
    pub total_tokens: i64,
    pub first_event_ts_ms: Option<i64>,
    pub last_event_ts_ms: Option<i64>,
    /// 命中范围内 `evidence_basis = 'conflict'` 的事实：用户声明不得吞掉已知相反
    /// 证据（执行计划 E207），它们既不归因也不算「移出」，预览单列为「仍待确认」。
    pub conflict_fact_count: i64,
    pub conflict_tokens: i64,
}

pub const BILLING_DECLARATION_FACT_FROM: &str =
    "FROM usage_facts f LEFT JOIN route_evidence r ON r.evidence_id = f.route_evidence_id";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictEvidence {
    /// 正常选择：排除 `conflict` 证据的事实。
    Exclude,
    /// 只选 `conflict` 证据的事实（预览的「仍待确认」桶）。
    Only,
}

/// Normalize a declaration boundary to an inclusive Beijing calendar date.
/// Existing Beta rows may contain `YYYY-MM`; keep reading them as the first or
/// last day of that month while new UI writes use `YYYY-MM-DD`.
pub fn billing_boundary_date(value: &str, end: bool) -> Option<String> {
    let bytes = value.as_bytes();
    let valid_digits = |mut range: std::ops::Range<usize>| {
        range.all(|index| bytes.get(index).is_some_and(|byte| byte.is_ascii_digit()))
    };
    if value.len() == 10 && bytes.get(4) == Some(&b'-') && bytes.get(7) == Some(&b'-')
        && valid_digits(0..4) && valid_digits(5..7) && valid_digits(8..10)
    {
        let month = value[5..7].parse::<u32>().ok()?;
        let day = value[8..10].parse::<u32>().ok()?;
        let year = value[0..4].parse::<i32>().ok()?;
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let days = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if leap => 29,
            2 => 28,
            _ => return None,
        };
        return (day >= 1 && day <= days).then(|| value.to_owned());
    }
    if value.len() != 7 || bytes.get(4) != Some(&b'-') || !valid_digits(0..4) || !valid_digits(5..7) {
        return None;
    }
    let month = value[5..7].parse::<u32>().ok()?;
    let year = value[0..4].parse::<i32>().ok()?;
    if !(1..=12).contains(&month) { return None; }
    if !end { return Some(format!("{value}-01")); }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    Some(format!("{value}-{day:02}"))
}

pub fn valid_billing_boundary(value: &str) -> bool {
    billing_boundary_date(value, false).is_some()
}

/// `(fact_count, session_count, total_tokens, first_event_ts_ms, last_event_ts_ms)`。
type PreviewAggregate = (i64, i64, i64, Option<i64>, Option<i64>);

pub struct BillingDeclarationFactSelection {
    pub where_sql: String,
    pub params: Vec<rusqlite::types::Value>,
}

/// 声明命中事实的**唯一**选择谓词。预览、重算归因与运行时计价三处都从这里拿
/// `WHERE`，所以「预览说会移出的」与「重算真正归因的」不可能是两个集合。
///
/// 规则：provider 相等（**不看执行环境**，见 [`ALL_HARNESSES`]）；事实有时间戳且落在 `effective_start..=effective_end`
/// 的北京时间自然日内；旧月份边界兼容展开为该月首日/末日。执行环境自报
/// `billing_mode='subscription'` 的事实不参与（它们本来
/// 就不按量）；已被其他 saved 声明覆盖的事实不重复移出；作用域按 kind 取交集、
/// 同 kind 取并集；`window` 只用于展示口径的额外时间窗。
pub fn billing_declaration_fact_selection(
    provider_id: &str, effective_start: &str, effective_end: Option<&str>,
    scopes: &[(&str, &str)], window: Option<(i64, i64)>, conflicts: ConflictEvidence,
) -> BillingDeclarationFactSelection {
    billing_declaration_fact_selection_with(provider_id, effective_start, effective_end, scopes, window, conflicts, false)
}

/// [`billing_declaration_fact_selection`] 加一个开关：`account_level` 为真时，声明按**账号级**匹配——
/// 订阅是账号的一份套餐，不是某个执行环境的（GLM Lite 在 Claude Code 和 ZCode 里用的是同一份）。
///
/// 账号级匹配 B = 任何执行环境上：`provider_id` 等于声明的服务商，**或** 服务商为空、模型无网关前缀、
/// 且该执行环境的原生厂商就是这个服务商（ZCode 的 `GLM-5.3`、Codex 的 `gpt-5.6-terra`：没有路由证据，
/// 但显然是执行环境自家官方路由）。模型前缀与执行环境原生厂商来自数据文件，只接受安全字符，用 `substr`
/// 比较而不是 LIKE，避免 `_` `%` 被当通配符。
///
/// - 普通官方订阅：只用 B。
/// - 带 `("provider","unresolved")` 的官方订阅（MiniMax lite / GLM Lite）：A（用户对「服务商未知的
///   这些模型」的显式作答，受模型范围限制）**并上** B。
/// - 其余声明（按量 / 中转 / 官方 API）：服务商 + 范围，同样**不看执行环境**。
///
/// 开关由 [`default_coverage`] 决定，预览 / 重算 / 持续套用三处共用。
#[allow(clippy::too_many_arguments)]
pub fn billing_declaration_fact_selection_with(
    provider_id: &str, effective_start: &str, effective_end: Option<&str>,
    scopes: &[(&str, &str)], window: Option<(i64, i64)>, conflicts: ConflictEvidence,
    account_level: bool,
) -> BillingDeclarationFactSelection {
    use rusqlite::types::Value;
    let start_date = billing_boundary_date(effective_start, false)
        .unwrap_or_else(|| effective_start.to_owned());
    let end_date = effective_end.and_then(|end| billing_boundary_date(end, true));
    let mut params: Vec<Value> = vec![
        Value::Text(provider_id.to_owned()),
        Value::Text(start_date),
        end_date.map_or(Value::Null, Value::Text),
    ];
    // 「服务商未知」的组：事实的 provider_id 为 NULL，用户在声明里补的
    // `provider_id` 是他给出的答案，不是事实上已有的值。作用域
    // `("provider", "unresolved")` 把匹配条件从 `= ?2` 换成 `IS NULL`，
    // 声明本身仍记录用户选的服务商（计费主链规格 v1.2 §5.3a）。
    let provider_unresolved = scopes.iter()
        .any(|(kind, value)| *kind == "provider" && *value == "unresolved");
    // 无收窄的「服务商未知」声明（旧库里留下的兜底声明）：宁可不匹配，也不去吞所有执行环境上的未归属用量。
    if is_unbounded_unresolved(scopes) {
        return BillingDeclarationFactSelection { where_sql: "0 = 1".to_owned(), params: Vec::new() };
    }
    // A：显式匹配——服务商相等；「服务商未知」的组改成服务商为空（模型范围负责收窄）。**不看执行环境**。
    let harness_bound = if provider_unresolved {
        "f.provider_id IS NULL AND ?1 IS NOT NULL"
    } else {
        "f.provider_id = ?1"
    };
    // B：账号级匹配。
    let account_condition = || -> String {
        use agent_vitals_domain::attribution::{model_prefixes_of, native_harnesses_of};
        let safe = |text: &str, extra: &[char]| text.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || extra.contains(&c));
        let prefixes: Vec<String> = model_prefixes_of(provider_id).into_iter().filter(|p| safe(p, &['-', '.'])).collect();
        let harnesses: Vec<String> = native_harnesses_of(provider_id).into_iter().filter(|h| safe(h, &['-', '.', ':', '_'])).collect();
        if prefixes.is_empty() || harnesses.is_empty() {
            return "f.provider_id = ?1".to_string();
        }
        let alternatives = prefixes.iter()
            .map(|p| format!("substr(lower(f.model_id), 1, {}) = '{}'", p.len(), p))
            .collect::<Vec<_>>().join(" OR ");
        let harness_list = harnesses.iter().map(|h| format!("'{h}'")).collect::<Vec<_>>().join(", ");
        format!("(f.provider_id = ?1 OR (f.provider_id IS NULL AND f.harness IN ({harness_list}) AND f.model_id IS NOT NULL AND instr(f.model_id, '/') = 0 AND ({alternatives})))")
    };
    let mut where_sql = String::new();
    where_sql.push_str("
           AND strftime('%Y-%m-%d', f.event_ts_ms / 1000, 'unixepoch', '+8 hours') >= ?2
           AND (?3 IS NULL OR strftime('%Y-%m-%d', f.event_ts_ms / 1000, 'unixepoch', '+8 hours') <= ?3)
           AND COALESCE(f.billing_mode, 'unknown') != 'subscription'
           AND NOT EXISTS (SELECT 1 FROM billing_fact_attributions ba
               JOIN billing_declaration_revisions br ON br.revision_id = ba.revision_id
               JOIN billing_recalculation_jobs bj ON bj.job_id = ba.job_id AND bj.status = 'succeeded'
               WHERE ba.fact_id = f.fact_id AND ba.attribution_kind = 'subscription_covered'
                 AND br.revision_number = (SELECT MAX(br2.revision_number)
                   FROM billing_declaration_revisions br2
                   LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
                   WHERE br2.declaration_id = br.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
                 AND br.change_kind = 'saved')",
    );
    where_sql.push_str(match conflicts {
        ConflictEvidence::Exclude => " AND COALESCE(f.evidence_basis, 'missing') != 'conflict'",
        ConflictEvidence::Only => " AND COALESCE(f.evidence_basis, 'missing') = 'conflict'",
    });
    if let Some((start_ms, end_ms)) = window {
        params.push(Value::Integer(start_ms));
        params.push(Value::Integer(end_ms));
        where_sql.push_str(&format!(
            " AND f.event_ts_ms >= ?{} AND f.event_ts_ms < ?{}", params.len() - 1, params.len(),
        ));
    }
    let mut scope_and = String::new();
    for (kind, column) in [
        ("account", "r.account_ref"), ("route", "f.route_evidence_id"),
        ("model", "f.model_id"), ("session", "f.session_key"),
    ] {
        let values = scopes.iter().filter(|(scope_kind, _)| *scope_kind == kind)
            .map(|(_, value)| *value).collect::<Vec<_>>();
        if values.is_empty() { continue; }
        let placeholders = values.iter().map(|value| {
            params.push(Value::Text((*value).to_owned()));
            format!("?{}", params.len())
        }).collect::<Vec<_>>().join(", ");
        scope_and.push_str(&format!(" AND {column} IN ({placeholders})"));
    }
    let matched = if !account_level {
        format!("({harness_bound}){scope_and}")
    } else if !provider_unresolved {
        format!("({}){scope_and}", account_condition())
    } else {
        // A（显式作答：服务商未知的事实，受模型范围限制）∪ B（账号级官方路由，不受模型范围限制）
        format!("((({harness_bound}){scope_and}) OR ({}))", account_condition())
    };
    let where_sql = format!("f.deleted_at_ms IS NULL AND f.event_ts_ms IS NOT NULL AND {matched}{where_sql}");
    BillingDeclarationFactSelection { where_sql, params }
}
/// **官方订阅的默认覆盖**：订阅声明的模型清单不应是要逐个维护的白名单——Anthropic / OpenAI
/// 每发一个新模型，用户都得回来补一遍声明（真机：`claude-sonnet-5-5` 因不在清单里，175M token
/// 成了「归属不明」）。所以官方订阅默认覆盖「该执行环境下该服务商」的全部模型，模型范围不再限制。
///
/// 只在三个条件**同时**成立时才去掉模型范围，否则原样返回：
/// 1. 关系是 `official_subscription`；
/// 2. 范围里没有 `("provider", "unresolved")`——那类声明是用户对「服务商未知」的事实作答，
///    靠模型名识别（MiniMax lite / GLM Lite），去掉模型限制会把执行环境下所有未知服务商的事实
///    都错判成这个订阅；
/// 3. 同执行环境同服务商没有官方 API 声明——两种声明并存时，同一个 provider 下的用量可能是订阅
///    也可能是 API Key，应用无从区分，不替用户猜，保持显式模型清单。
///
/// 账户 / 路由 / 会话范围照旧生效（用户主动收窄的意图不能被默认规则抹掉）。预览、重算、持续套用
/// 三处必须都经过这一个函数，否则「预览命中的事实集合 = 重算会归因的集合」就破了。
pub fn attribution_scopes<'a>(
    relationship_kind: &str, scopes: &[(&'a str, &'a str)], official_api_declared: bool,
) -> Vec<(&'a str, &'a str)> {
    default_coverage(relationship_kind, scopes, official_api_declared).0
}

/// 默认覆盖的完整结果：(有效范围, 是否账号级)。
///
/// - 范围：官方订阅且没有 `provider=unresolved`、也没有官方 API 声明 → 去掉模型范围（见 [`attribution_scopes`]）。
/// - 账号级：官方订阅、没有官方 API 声明、且用户没有用路由 / 账户 / 会话范围主动收窄 → 为真。
///   订阅是账号的套餐，覆盖该服务商在任何执行环境上的官方路由（见 [`billing_declaration_fact_selection_with`]）。
///   用户主动收窄过的声明，意图不能被默认规则抹掉。
pub fn default_coverage<'a>(
    relationship_kind: &str, scopes: &[(&'a str, &'a str)], official_api_declared: bool,
) -> (Vec<(&'a str, &'a str)>, bool) {
    let provider_unresolved = scopes.iter().any(|(kind, value)| *kind == "provider" && *value == "unresolved");
    let narrowed = scopes.iter().any(|(kind, _)| matches!(*kind, "route" | "account" | "session"));
    let subscription_default = relationship_kind == "official_subscription" && !official_api_declared;
    let effective = if subscription_default && !provider_unresolved {
        scopes.iter().copied().filter(|(kind, _)| *kind != "model").collect()
    } else {
        scopes.to_vec()
    };
    (effective, subscription_default && !narrowed)
}

type BillingDeclarationRevisionSnapshot = (
    i64, String, String, String, Option<String>, Option<i64>, Option<String>, String,
    Option<String>, Option<String>, Option<String>,
);
/// 旧版本发现、尚未被用户确认的订阅候选：`(id, harness, provider, currency,
/// amount_minor, period_start, status)`。候选不构成实际付款。
pub type BillingImportCandidateRow = (String, String, String, String, i64, String, String);

type BillingTemplateRow = (String, Option<String>, String, String, i64, Option<i64>);
type OutcomeMeasurementRow = (String, String, String, Option<i64>, Option<String>, String);

/// 权威库错误。`Corrupt` **不再自愈**——恢复路径是「用户备份 + 原始日志
/// 重放」，静默删库重建会把权威库变成可被悄悄替换的第二本账（spec §1.1.3
/// 的反面教材）。
#[derive(Debug)]
pub enum AuthorityError {
    Sqlite(rusqlite::Error),
    /// 库的 schema 版本比本二进制新——升级二进制，不降级重建。
    NewerSchema {
        found: i64,
        supported: i64,
    },
    Io(std::io::Error),
    /// `open_readonly` 专用（spec §9.3：只读取数面不建库）——文件不存在。
    /// 与 `open` 的「不存在则建库」刻意相反：只读消费者遇到缺库必须如实报
    /// 错，不能悄悄造一个空库端出 facts=0。
    MissingFile,
    /// `open_readonly` 专用——不是 SQLite 文件 / 文件损坏 / 半建库
    /// （`schema_meta` 读不出）。
    Corrupt,
    /// `open_readonly` 专用——库的 schema 版本比本二进制旧，需要产品迁移。
    /// （`open` 里这条走 `__unsupported_legacy_version__` 防御分支；只读面
    /// 单列一个 typed 变体，供错误码映射成 `schema_migration_required`。）
    OlderSchema {
        found: i64,
    },
}

impl From<rusqlite::Error> for AuthorityError {
    fn from(e: rusqlite::Error) -> Self {
        AuthorityError::Sqlite(e)
    }
}

impl From<std::io::Error> for AuthorityError {
    fn from(e: std::io::Error) -> Self {
        AuthorityError::Io(e)
    }
}

impl std::fmt::Display for AuthorityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthorityError::Sqlite(e) => write!(f, "authority sqlite: {e}"),
            AuthorityError::NewerSchema { found, supported } => write!(
                f,
                "authority schema v{found} is newer than supported v{supported} — 升级二进制"
            ),
            AuthorityError::Io(e) => write!(f, "authority io: {e}"),
            AuthorityError::MissingFile => write!(f, "authority db file does not exist"),
            AuthorityError::Corrupt => {
                write!(f, "authority db is not readable (not a SQLite file, corrupt, or half-built)")
            }
            AuthorityError::OlderSchema { found } => write!(
                f,
                "authority schema v{found} is older than supported v{SCHEMA_VERSION} — run product migration"
            ),
        }
    }
}

/// spec §3 全量 DDL（v1）。`executescript` 一次成库；幂等性由「只在空/低版
/// 本库上执行」保证，不用 IF NOT EXISTS（有版本闸后重复执行是 bug，静默
/// 跳过反而掩盖它）。
const SCHEMA_V1: &str = r#"
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  trigger TEXT NOT NULL,                 -- cli | tray | migration | repair | maintenance
  status TEXT NOT NULL,                  -- running | succeeded | failed | cancelled
  schema_version INTEGER NOT NULL,
  error_code TEXT,
  error_detail TEXT
);

CREATE TABLE source_files (
  source_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  path_hash TEXT NOT NULL,                -- 不暴露本地路径
  native_session_id TEXT,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  content_fingerprint TEXT,
  parser_version INTEGER NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  last_successful_run_id TEXT REFERENCES sync_runs(run_id),
  last_error_code TEXT,
  -- SourceGraph 检查点（v24，SOURCE_GRAPH spec §5.1）
  byte_offset INTEGER,                    -- 增量续读位置；NULL = 首见/不支持
  parser_id TEXT,                         -- 解析器身份（"claude-jsonl" 等）
  dirty INTEGER NOT NULL DEFAULT 0,       -- 脏标记（watch/tick 填、调度器清）
  UNIQUE(harness, path_hash)
);

CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  machine_namespace TEXT NOT NULL,
  source_profile TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  last_observed_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  title TEXT,                               -- v32：会话标题（City 楼名等本地展示面；NULL = 无标题证据）
  title_source TEXT,                        -- v32：受审计的本机标题来源枚举
  UNIQUE(harness, machine_namespace, native_session_id)
);

CREATE TABLE usage_facts (
  fact_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  machine_namespace TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  session_key TEXT REFERENCES sessions(session_key),
  source_event_id TEXT NOT NULL,
  observation_kind TEXT NOT NULL,
  source_profile TEXT,
  provider_id TEXT,
  model_id TEXT,
  event_ts_ms INTEGER,
  event_peak INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (uncached_input_tokens >= 0),
  CHECK (cache_read_tokens >= 0),
  CHECK (cache_write_tokens >= 0),
  CHECK (output_tokens >= 0),
  UNIQUE(harness, machine_namespace, native_session_id, source_event_id, observation_kind)
);

CREATE INDEX usage_facts_harness_time
  ON usage_facts(harness, event_ts_ms) WHERE deleted_at_ms IS NULL;
CREATE INDEX usage_facts_session_time
  ON usage_facts(session_key, event_ts_ms) WHERE deleted_at_ms IS NULL;
CREATE INDEX usage_facts_provider_model_time
  ON usage_facts(provider_id, model_id, event_ts_ms) WHERE deleted_at_ms IS NULL;
CREATE INDEX usage_facts_event_time
  ON usage_facts(event_ts_ms) WHERE deleted_at_ms IS NULL;

CREATE TABLE harness_bills (
  bill_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  billing_period TEXT NOT NULL,           -- YYYY-MM
  billing_basis TEXT NOT NULL,            -- fixed_subscription | harness_billed | metered_actual
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  source_id TEXT REFERENCES source_files(source_id),
  evidence_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(harness, provider_id, billing_period, billing_basis, evidence_ref)
);

CREATE TABLE pricing_snapshots (
  pricing_version TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE budget_config (
  config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
  monthly_cny_minor INTEGER,
  daily_cny_minor INTEGER,
  warning_ratio_bp INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE budget_snoozes (
  snooze_id INTEGER PRIMARY KEY CHECK (snooze_id = 1),
  until_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE data_quality_issues (
  issue_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,               -- source | session | fact | month
  scope_key TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  detail_json TEXT NOT NULL,
  UNIQUE(scope_type, scope_key, code)
);

CREATE TABLE migrations (
  migration_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  status TEXT NOT NULL,
  source_version TEXT NOT NULL,
  target_version TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  error_detail TEXT
);

CREATE TABLE workflow_events (
  event_id TEXT PRIMARY KEY,
  session_key TEXT REFERENCES sessions(session_key),
  event_ts_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,               -- task_started | task_finished | skill_invoked |
                                          -- skill_finished | tool_invoked | tool_finished |
                                          -- model_switched | approval_denied
  capability_kind TEXT,                   -- skill | tool | model
  capability_id TEXT,                     -- Skill/tool/model 的稳定标识
  capability_version TEXT,
  outcome TEXT NOT NULL,                  -- succeeded | failed | cancelled | unknown
  duration_ms INTEGER,
  error_fingerprint TEXT,                 -- 脱敏、稳定的错误分类/指纹
  invocation_fingerprint TEXT,            -- 脱敏调用指纹，用于识别重复重试
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX workflow_events_session_time
  ON workflow_events(session_key, event_ts_ms);
CREATE INDEX workflow_events_capability_time
  ON workflow_events(capability_kind, capability_id, event_ts_ms);
CREATE INDEX workflow_events_error_time
  ON workflow_events(error_fingerprint, event_ts_ms)
  WHERE error_fingerprint IS NOT NULL;

-- v2：非账务但面向产品展示的执行环境实时状态。不能塞进 usage_facts（不是用量），
-- 也不能继续由 UI 直接读执行环境日志；payload 保留来源的完整、脱敏 JSON 形状。
CREATE TABLE harness_runtime_snapshots (
  harness TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,            -- 目前：codex_quota
  payload_json TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(harness, snapshot_kind)
);
"#;

const MIGRATE_V1_TO_V2: &str = r#"
CREATE TABLE harness_runtime_snapshots (
  harness TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(harness, snapshot_kind)
);
"#;

const SCHEMA_V3_ADD: &str = r#"
ALTER TABLE usage_facts ADD COLUMN provider_raw TEXT;
ALTER TABLE usage_facts ADD COLUMN billing_source TEXT;
ALTER TABLE usage_facts ADD COLUMN billing_mode TEXT;
ALTER TABLE usage_facts ADD COLUMN pricing_basis TEXT;
ALTER TABLE usage_facts ADD COLUMN evidence_basis TEXT;
ALTER TABLE usage_facts ADD COLUMN normalization_version TEXT;
ALTER TABLE usage_facts ADD COLUMN route_evidence_id TEXT;
ALTER TABLE usage_facts ADD COLUMN attribution_version TEXT;

CREATE TABLE route_evidence (
  evidence_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  machine_namespace TEXT NOT NULL,
  native_session_id TEXT,
  provider_raw TEXT,
  endpoint_host TEXT,
  account_ref TEXT,
  plan_type TEXT,
  quota_window TEXT,
  evidence_basis TEXT NOT NULL,
  observed_at_ms INTEGER,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id)
);
CREATE INDEX route_evidence_session ON route_evidence(harness, machine_namespace, native_session_id);
CREATE TRIGGER usage_facts_route_evidence_insert_fk
BEFORE INSERT ON usage_facts
WHEN NEW.route_evidence_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM route_evidence WHERE evidence_id = NEW.route_evidence_id)
BEGIN
  SELECT RAISE(ABORT, 'usage_facts.route_evidence_id does not reference route_evidence');
END;
CREATE TRIGGER usage_facts_route_evidence_update_fk
BEFORE UPDATE OF route_evidence_id ON usage_facts
WHEN NEW.route_evidence_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM route_evidence WHERE evidence_id = NEW.route_evidence_id)
BEGIN
  SELECT RAISE(ABORT, 'usage_facts.route_evidence_id does not reference route_evidence');
END;

CREATE TABLE issue_instances (
  issue_id TEXT PRIMARY KEY,
  machine_namespace TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_key TEXT,
  issue_type TEXT NOT NULL,
  instance_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  metadata_json TEXT NOT NULL,
  UNIQUE(machine_namespace, issue_type, instance_fingerprint)
);

CREATE TABLE issue_status_transitions (
  transition_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issue_instances(issue_id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  transitioned_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  UNIQUE(issue_id, transition_id)
);
CREATE INDEX issue_transitions_issue_time ON issue_status_transitions(issue_id, transitioned_at_ms, transition_id);
"#;

// v0.12：计费合同、catalog 和金额测量都必须版本化。所有对历史 facts 的新
// 关联均可空：迁移绝不凭当前模板猜测旧 session 的合同。
const SCHEMA_V4_ADD: &str = r#"
ALTER TABLE usage_facts ADD COLUMN billing_template_id TEXT;
ALTER TABLE pricing_snapshots ADD COLUMN catalog_version TEXT;
ALTER TABLE pricing_snapshots ADD COLUMN billing_template_id TEXT;

CREATE TABLE provider_catalog_snapshots (
  catalog_version TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL
);

CREATE TABLE billing_templates (
  billing_template_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_ref TEXT,
  template_kind TEXT NOT NULL,
  pricing_source TEXT NOT NULL,
  effective_from_ms INTEGER NOT NULL,
  effective_to_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  CHECK (effective_to_ms IS NULL OR effective_to_ms >= effective_from_ms)
);
CREATE INDEX billing_templates_provider_window
  ON billing_templates(provider_id, account_ref, effective_from_ms, effective_to_ms);

CREATE TABLE billing_template_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  billing_template_id TEXT NOT NULL REFERENCES billing_templates(billing_template_id),
  catalog_version TEXT REFERENCES provider_catalog_snapshots(catalog_version),
  captured_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(billing_template_id, catalog_version, snapshot_id)
);
CREATE INDEX billing_template_snapshots_template_time
  ON billing_template_snapshots(billing_template_id, captured_at_ms);

CREATE TABLE outcome_measurements (
  measurement_id TEXT PRIMARY KEY,
  fact_set_fingerprint TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  basis TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT,
  measured_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  CHECK ((amount_minor IS NULL AND currency IS NULL) OR (amount_minor IS NOT NULL AND currency IS NOT NULL))
);

CREATE TABLE savings_records (
  savings_id TEXT PRIMARY KEY,
  measurement_id TEXT NOT NULL REFERENCES outcome_measurements(measurement_id),
  billing_template_snapshot_id TEXT REFERENCES billing_template_snapshots(snapshot_id),
  pricing_version TEXT REFERENCES pricing_snapshots(pricing_version),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  savings_basis TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (savings_basis IN ('estimated', 'actual', 'realized'))
);
CREATE INDEX savings_records_measurement ON savings_records(measurement_id);

CREATE TRIGGER usage_facts_billing_template_insert_fk
BEFORE INSERT ON usage_facts
WHEN NEW.billing_template_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM billing_templates WHERE billing_template_id = NEW.billing_template_id)
BEGIN
  SELECT RAISE(ABORT, 'usage_facts.billing_template_id does not reference billing_templates');
END;
CREATE TRIGGER usage_facts_billing_template_update_fk
BEFORE UPDATE OF billing_template_id ON usage_facts
WHEN NEW.billing_template_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM billing_templates WHERE billing_template_id = NEW.billing_template_id)
BEGIN
  SELECT RAISE(ABORT, 'usage_facts.billing_template_id does not reference billing_templates');
END;
"#;

// `data_status` 的未决 provider 归因使用相关子查询。只索引未解决的问题，
// 使查询谓词命中索引，又不为历史审计记录增加索引成本。
const SCHEMA_V5_ADD: &str = r#"
CREATE INDEX IF NOT EXISTS data_quality_issues_open_code_scope
  ON data_quality_issues(code, scope_key)
  WHERE resolved_at_ms IS NULL;
"#;

// SQLite cannot add REFERENCES constraints to existing columns. These triggers
// make the nullable v0.12 provenance columns fail closed on every write.
const SCHEMA_V6_ADD: &str = r#"
CREATE TRIGGER pricing_snapshots_catalog_insert_fk
BEFORE INSERT ON pricing_snapshots
WHEN NEW.catalog_version IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM provider_catalog_snapshots WHERE catalog_version = NEW.catalog_version)
BEGIN
  SELECT RAISE(ABORT, 'pricing_snapshots.catalog_version does not reference provider_catalog_snapshots');
END;
CREATE TRIGGER pricing_snapshots_catalog_update_fk
BEFORE UPDATE OF catalog_version ON pricing_snapshots
WHEN NEW.catalog_version IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM provider_catalog_snapshots WHERE catalog_version = NEW.catalog_version)
BEGIN
  SELECT RAISE(ABORT, 'pricing_snapshots.catalog_version does not reference provider_catalog_snapshots');
END;
CREATE TRIGGER pricing_snapshots_template_insert_fk
BEFORE INSERT ON pricing_snapshots
WHEN NEW.billing_template_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM billing_templates WHERE billing_template_id = NEW.billing_template_id)
BEGIN
  SELECT RAISE(ABORT, 'pricing_snapshots.billing_template_id does not reference billing_templates');
END;
CREATE TRIGGER pricing_snapshots_template_update_fk
BEFORE UPDATE OF billing_template_id ON pricing_snapshots
WHEN NEW.billing_template_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM billing_templates WHERE billing_template_id = NEW.billing_template_id)
BEGIN
  SELECT RAISE(ABORT, 'pricing_snapshots.billing_template_id does not reference billing_templates');
END;
"#;

// v1.0：旧公共价表中的个人订阅不是付款凭证。升级时保留为待确认候选，
// 必须由用户接受后才写入 harness_bills / FixedSubscription。
const SCHEMA_V7_ADD: &str = r#"
CREATE TABLE billing_import_candidates (
  candidate_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  billing_period_start TEXT NOT NULL,
  source_pricing_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  UNIQUE(provider_id, currency, amount_minor, billing_period_start, source_pricing_version)
);
CREATE INDEX billing_import_candidates_status ON billing_import_candidates(status, provider_id);
"#;

// v1.0：计费关系是用户声明，不是付款记录，也不能寄居在公共价格目录。
const SCHEMA_V8_ADD: &str = r#"
CREATE TABLE billing_declarations (
  declaration_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  relationship_kind TEXT NOT NULL CHECK (relationship_kind IN (
    'official_subscription', 'official_api', 'third_party', 'organization', 'unknown'
  )),
  subscription_name TEXT,
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT,
  effective_start TEXT NOT NULL,
  effective_end TEXT,
  source_candidate_id TEXT UNIQUE REFERENCES billing_import_candidates(candidate_id),
  evidence_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK ((amount_minor IS NULL AND currency IS NULL) OR
         (amount_minor IS NOT NULL AND currency IS NOT NULL AND trim(currency) <> '')),
  CHECK (effective_end IS NULL OR effective_end >= effective_start)
);
CREATE INDEX billing_declarations_active_scope
  ON billing_declarations(harness, provider_id, effective_start, effective_end)
  WHERE deleted_at_ms IS NULL;
"#;

// v1.0：声明当前态可供读取，但每次保存与撤销必须追加一个不可变修订；范围
// 是用户提供的附加证据，不能修改原始事实或推断未选中的历史记录。
const SCHEMA_V9_ADD: &str = r#"
CREATE TABLE billing_declaration_revisions (
  revision_id TEXT PRIMARY KEY,
  declaration_id TEXT NOT NULL REFERENCES billing_declarations(declaration_id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('saved', 'revoked')),
  supersedes_revision_id TEXT UNIQUE REFERENCES billing_declaration_revisions(revision_id),
  harness TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  relationship_kind TEXT NOT NULL CHECK (relationship_kind IN (
    'official_subscription', 'official_api', 'third_party', 'organization', 'unknown'
  )),
  subscription_name TEXT,
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT,
  effective_start TEXT NOT NULL,
  effective_end TEXT,
  source_candidate_id TEXT REFERENCES billing_import_candidates(candidate_id),
  evidence_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  CHECK ((amount_minor IS NULL AND currency IS NULL) OR
         (amount_minor IS NOT NULL AND currency IS NOT NULL AND trim(currency) <> '')),
  CHECK (effective_end IS NULL OR effective_end >= effective_start),
  UNIQUE(declaration_id, revision_number)
);
CREATE TABLE billing_declaration_scopes (
  revision_id TEXT NOT NULL REFERENCES billing_declaration_revisions(revision_id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'route', 'model', 'session')),
  scope_value TEXT NOT NULL CHECK (trim(scope_value) <> ''),
  PRIMARY KEY(revision_id, scope_kind, scope_value)
);
CREATE INDEX billing_declaration_revisions_current
  ON billing_declaration_revisions(declaration_id, revision_number DESC);
CREATE INDEX billing_declaration_scopes_lookup
  ON billing_declaration_scopes(scope_kind, scope_value, revision_id);
"#;

const SCHEMA_V10_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS billing_recalculation_jobs (
  job_id TEXT PRIMARY KEY,
  declaration_id TEXT NOT NULL REFERENCES billing_declarations(declaration_id),
  revision_id TEXT NOT NULL REFERENCES billing_declaration_revisions(revision_id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  requested_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  error_code TEXT,
  error_detail TEXT,
  UNIQUE(revision_id)
);
CREATE INDEX IF NOT EXISTS billing_recalculation_jobs_status
  ON billing_recalculation_jobs(status, requested_at_ms);
"#;

const SCHEMA_V11_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS billing_recalculation_results (
  job_id TEXT PRIMARY KEY REFERENCES billing_recalculation_jobs(job_id),
  revision_id TEXT NOT NULL REFERENCES billing_declaration_revisions(revision_id),
  fact_count INTEGER NOT NULL CHECK (fact_count >= 0),
  session_count INTEGER NOT NULL CHECK (session_count >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  first_event_ts_ms INTEGER,
  last_event_ts_ms INTEGER,
  published_at_ms INTEGER NOT NULL
);
"#;

const SCHEMA_V12_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS billing_fact_attributions (
  fact_id TEXT NOT NULL REFERENCES usage_facts(fact_id),
  revision_id TEXT NOT NULL REFERENCES billing_declaration_revisions(revision_id),
  job_id TEXT NOT NULL REFERENCES billing_recalculation_jobs(job_id),
  attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('subscription_covered', 'user_declared')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(fact_id, revision_id)
);
CREATE INDEX IF NOT EXISTS billing_fact_attributions_revision
  ON billing_fact_attributions(revision_id, fact_id);

-- v1.0 budget profiles: keep the legacy single CNY row readable while allowing
-- independent estimate/confirmed budgets and an explicit currency per profile.
CREATE TABLE IF NOT EXISTS budget_profiles (
  profile_id TEXT PRIMARY KEY CHECK (profile_id IN ('estimate', 'confirmed')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  monthly_minor INTEGER NOT NULL CHECK (monthly_minor > 0),
  daily_minor INTEGER,
  warning_ratio_bp INTEGER NOT NULL CHECK (warning_ratio_bp BETWEEN 0 AND 10000),
  updated_at_ms INTEGER NOT NULL
);
"#;

const SCHEMA_V13_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS budget_profiles (
  profile_id TEXT PRIMARY KEY CHECK (profile_id IN ('estimate', 'confirmed')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  monthly_minor INTEGER NOT NULL CHECK (monthly_minor > 0),
  daily_minor INTEGER,
  warning_ratio_bp INTEGER NOT NULL CHECK (warning_ratio_bp BETWEEN 0 AND 10000),
  updated_at_ms INTEGER NOT NULL
);
"#;

// v14（计费主链 v1.2「明确计费方式」）：作用域词表加 `provider`，唯一合法值
// `unresolved`——「服务商未知」的组（事实 provider_id 为 NULL）由用户补上服务商，
// 声明记录他选的服务商，作用域让预览/重算只命中 NULL-provider 的事实。SQLite 改
// 不了 CHECK，只能重建表；行原样搬迁，索引重建。
const SCHEMA_V14_ADD: &str = r#"
CREATE TABLE billing_declaration_scopes_v14 (
  revision_id TEXT NOT NULL REFERENCES billing_declaration_revisions(revision_id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'route', 'model', 'session', 'provider')),
  scope_value TEXT NOT NULL CHECK (trim(scope_value) <> ''),
  PRIMARY KEY(revision_id, scope_kind, scope_value)
);
INSERT INTO billing_declaration_scopes_v14(revision_id, scope_kind, scope_value)
  SELECT revision_id, scope_kind, scope_value FROM billing_declaration_scopes;
DROP INDEX IF EXISTS billing_declaration_scopes_lookup;
DROP TABLE billing_declaration_scopes;
ALTER TABLE billing_declaration_scopes_v14 RENAME TO billing_declaration_scopes;
CREATE INDEX billing_declaration_scopes_lookup
  ON billing_declaration_scopes(scope_kind, scope_value, revision_id);
"#;

/// v15：作用域表再放开一个 kind——`settlement`（结算币种，声明属性而非匹配条件）。
/// 与 v14 同款重建：scopes 没有被别的表引用，DROP + RENAME 安全。
const SCHEMA_V15_ADD: &str = r#"
CREATE TABLE billing_declaration_scopes_v15 (
  revision_id TEXT NOT NULL REFERENCES billing_declaration_revisions(revision_id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'route', 'model', 'session', 'provider', 'settlement')),
  scope_value TEXT NOT NULL CHECK (trim(scope_value) <> ''),
  PRIMARY KEY(revision_id, scope_kind, scope_value)
);
INSERT INTO billing_declaration_scopes_v15(revision_id, scope_kind, scope_value)
  SELECT revision_id, scope_kind, scope_value FROM billing_declaration_scopes;
DROP INDEX IF EXISTS billing_declaration_scopes_lookup;
DROP TABLE billing_declaration_scopes;
ALTER TABLE billing_declaration_scopes_v15 RENAME TO billing_declaration_scopes;
CREATE INDEX billing_declaration_scopes_lookup
  ON billing_declaration_scopes(scope_kind, scope_value, revision_id);
"#;

/// v16（内容富化 + 源锚点：docs/v1.0.0/SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md §2，
/// DDL 镜像同步进 SQL 权威库 spec §3.8）。workflow_events 补错误分类/摘录/尺寸/
/// 锚点九列（词表 = domain crate `enrichment::ErrorClass` 的十值闭集），usage_facts
/// 补 `reasoning_effort` 证据位（effort 被静默调低的被动证据，执行环境报了才填），
/// sessions 补 `probe_run_ref`（探针会话标记，成本视图过滤键）与任务画像占位，
/// 新表 `session_excerpts` 承载任务意图三段式文本（提取算法 = domain
/// `enrichment::make_excerpt`，Python 镜像 + 共享向量锁步）。
///
/// **为什么不是一条 `SCHEMA_V16_ADD` batch**：v16 是 v9 以来第一个 ALTER-加列式
/// 增量，而 `stale_v9_stamp_with_later_tables_upgrades_idempotently` 钉住的不变量
/// 要求增量能在「版本戳陈旧、表已是新形状」的库上重跑——SQLite 没有
/// `ADD COLUMN IF NOT EXISTS`，加列逐条以 `pragma_table_info` 守卫、建表/索引用
/// `IF NOT EXISTS`，幂等由此保证。生产路径行为不变（新库逐列本就缺失）。
/// 旧行新列 NULL = 未富化（源日志重摄取前不得当 0/空串呈现）。出口投影
/// （MCP / data-export-redacted）不因本迁移放宽一个字节——excerpt 类字段与
/// 锚点不出这两个面（2026-09-19 数据留存与出口政策）。
const SCHEMA_V16_COLUMN_DDLS: &[(&str, &str)] = &[
    ("workflow_events", "error_code TEXT"),
    (
        "workflow_events",
        "error_class TEXT CHECK (error_class IS NULL OR error_class IN (\n    'transport','rate_limit','auth','schema_violation','method_not_found',\n    'timeout','parse','tool_policy','context_overflow','unknown'))",
    ),
    ("workflow_events", "error_excerpt TEXT"),
    ("workflow_events", "args_excerpt TEXT"),
    ("workflow_events", "request_bytes INTEGER"),
    ("workflow_events", "result_bytes INTEGER"),
    ("workflow_events", "native_event_id TEXT"),
    ("workflow_events", "source_line INTEGER"),
    ("workflow_events", "source_byte_offset INTEGER"),
    ("usage_facts", "reasoning_effort TEXT"),
    ("sessions", "probe_run_ref TEXT"),
    ("sessions", "task_profile TEXT"),
    (
        "sessions",
        "task_profile_basis TEXT CHECK (task_profile_basis IS NULL OR task_profile_basis IN ('rule_toolmix','user_label','local_model'))",
    ),
];

const SCHEMA_V16_CREATE: &str = r#"
CREATE TABLE IF NOT EXISTS session_excerpts (
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user_first','user_turn','assistant_final','subagent_task')),
  excerpt TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('verbatim','truncated','scrubbed')),
  native_event_id TEXT,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  PRIMARY KEY(session_key, ordinal, role)
);
CREATE INDEX IF NOT EXISTS session_excerpts_session
  ON session_excerpts(session_key, ordinal);
CREATE INDEX IF NOT EXISTS workflow_events_error_class_time
  ON workflow_events(error_class, event_ts_ms) WHERE error_class IS NOT NULL;
"#;

/// 幂等应用 v16 增量（见 [`SCHEMA_V16_COLUMN_DDLS`] 的说明）。列已存在则跳过，
/// 表/索引 `IF NOT EXISTS`——在陈旧版本戳的新形状库上重跑不炸。
fn apply_schema_v16(conn: &Connection) -> Result<(), rusqlite::Error> {
    for (table, column_ddl) in SCHEMA_V16_COLUMN_DDLS {
        let column = column_ddl.split_whitespace().next().unwrap_or_default();
        // 只把「查无此列」当缺失；真错误（锁/损坏）原样上抛——吞掉会以误导性的
        // duplicate column 晚爆（Step2 验收 nit）。
        let present = match conn.query_row(
            &format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}'"),
            [],
            |_| Ok(true),
        ) {
            Ok(present) => present,
            Err(rusqlite::Error::QueryReturnedNoRows) => false,
            Err(error) => return Err(error),
        };
        if !present {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column_ddl};"))?;
        }
    }
    conn.execute_batch(SCHEMA_V16_CREATE)
}

/// v17（探针面五表：docs/v1.0.0/SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md §4，
/// 镜像同步进 SQL 权威库 spec §3.9）。与 v16 不同，v17 **全是建表**、无加列——
/// 全部 `IF NOT EXISTS` 即天然幂等（陈旧版本戳 + 新形状表重放不炸），无需
/// pragma 守卫。纪律要点：凭据永不入库（`credential_ref` 是 'ccswitch:<row>' /
/// 'env:VAR' 引用）；题面/判据/canary 串留文件系统（`manifest_ref` + sha256，
/// 机密待遇）；`consent_granted_at_ms` 为 NULL 时路线不得发起请求；四桶与
/// usage_facts 同名同义（探针会话两路记账必须对得上，spec §10-7）；金额一律
/// `*_minor + currency` 分币种。runner 与「测试」tab UI 属后续迭代（spec §13
/// P2），本迁移只落数据层。
const SCHEMA_V17_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS probe_routes (
  route_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  harness_kind TEXT NOT NULL CHECK (harness_kind IN ('claude-code','codex')),
  endpoint_base_url TEXT,
  credential_ref TEXT,
  model_requested TEXT NOT NULL,
  consent_granted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(label, harness_kind)
);
CREATE TABLE IF NOT EXISTS probe_suites (
  suite_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('l0_identity','l0_capability','l1_canary')),
  manifest_ref TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(suite_id, version)
);
CREATE TABLE IF NOT EXISTS probe_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('single','paired')),
  route_a_id TEXT NOT NULL REFERENCES probe_routes(route_id),
  route_b_id TEXT REFERENCES probe_routes(route_id),
  suite_id TEXT NOT NULL REFERENCES probe_suites(suite_id),
  n_repeats INTEGER NOT NULL CHECK (n_repeats >= 1),
  interleave_seed INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','budget_stopped')),
  currency TEXT,
  cost_budget_minor INTEGER,
  cost_estimated_minor INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  lease_owner TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_results (
  result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES probe_runs(run_id),
  route_id TEXT NOT NULL REFERENCES probe_routes(route_id),
  task_id TEXT NOT NULL,
  repeat_idx INTEGER NOT NULL CHECK (repeat_idx >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail','error','timeout')),
  uncached_input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  turns INTEGER,
  wall_ms INTEGER,
  ttft_ms INTEGER,
  requested_model TEXT NOT NULL,
  resolved_model TEXT,
  reasoning_effort_requested TEXT,
  reasoning_effort_reported TEXT,
  thinking_blocks INTEGER,
  context_accepted_tokens INTEGER,
  error_code TEXT,
  evidence_json TEXT NOT NULL,
  session_key TEXT REFERENCES sessions(session_key),
  UNIQUE(run_id, route_id, task_id, repeat_idx)
);
CREATE INDEX IF NOT EXISTS probe_results_run
  ON probe_results(run_id, route_id);
CREATE TABLE IF NOT EXISTS probe_verdicts (
  verdict_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES probe_runs(run_id),
  verdict TEXT NOT NULL CHECK (verdict IN (
    'confirmed_mismatch','suspected_degradation','no_signal','underpowered','inconclusive_confounded')),
  statistic_json TEXT NOT NULL,
  evidence_chain_json TEXT NOT NULL,
  confounders_json TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  decided_at_ms INTEGER NOT NULL,
  UNIQUE(run_id)
);
"#;

/// v18：Finding 2.0 的本地信任观察面。它只存已脱敏的行为增量与本地锚点；
/// 不存工作区路径、文件名清单、代码/消息、请求体、凭据或签名 URL。
const SCHEMA_V18_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS trust_observations (
  observation_id TEXT PRIMARY KEY,
  machine_namespace TEXT NOT NULL,
  harness TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('main','sidecar','helper','extension','unknown')),
  actor_version TEXT,
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  observation_kind TEXT NOT NULL CHECK (observation_kind IN (
    'file_scope','package','credential','connection','outbound_bytes','remote_ack','consent_state','retry')),
  stage TEXT NOT NULL CHECK (stage IN (
    'read_observed','package_observed','credential_observed','egress_attempted','egress_transmitted','remote_accepted')),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('E0','E1','E2','E3','E4','E5')),
  workspace_ref TEXT,
  scope_classes_json TEXT NOT NULL,
  file_count INTEGER CHECK (file_count IS NULL OR file_count >= 0),
  byte_count INTEGER CHECK (byte_count IS NULL OR byte_count >= 0),
  destination_class TEXT CHECK (destination_class IS NULL OR destination_class IN (
    'vendor_api','object_storage','telemetry','eval','model_api','unknown')),
  destination_host TEXT,
  consent_state TEXT NOT NULL CHECK (consent_state IN ('enabled','disabled','unavailable','ambiguous')),
  source_id TEXT REFERENCES source_files(source_id),
  native_event_id TEXT,
  source_line INTEGER CHECK (source_line IS NULL OR source_line >= 0),
  source_byte_offset INTEGER CHECK (source_byte_offset IS NULL OR source_byte_offset >= 0),
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= observed_at_ms),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trust_observations_harness_time
  ON trust_observations(harness, observed_at_ms);
CREATE INDEX IF NOT EXISTS trust_observations_actor_time
  ON trust_observations(machine_namespace, actor_id, observed_at_ms);
CREATE INDEX IF NOT EXISTS trust_observations_expiry
  ON trust_observations(expires_at_ms) WHERE expires_at_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS trust_issue_evidence (
  issue_id TEXT NOT NULL REFERENCES issue_instances(issue_id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES trust_observations(observation_id) ON DELETE CASCADE,
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('supporting','contradicting','context')),
  linked_at_ms INTEGER NOT NULL CHECK (linked_at_ms >= 0),
  PRIMARY KEY(issue_id, observation_id, evidence_role)
);
CREATE INDEX IF NOT EXISTS trust_issue_evidence_observation
  ON trust_issue_evidence(observation_id, issue_id);
"#;

/// v19：显式 Trust 监测控制面。它只记录开关、能力和类型化错误状态；不记录
/// 权限原文、进程名、路径、网络端点或通知正文。
const SCHEMA_V19_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS trust_monitor_state (
  config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 5 AND 3600),
  notifications_enabled INTEGER NOT NULL CHECK (notifications_enabled IN (0,1)),
  capability TEXT NOT NULL CHECK (capability IN ('not_started','available','partial','unavailable')),
  last_success_at_ms INTEGER CHECK (last_success_at_ms IS NULL OR last_success_at_ms >= 0),
  last_error_code TEXT,
  last_alert_key TEXT,
  last_alert_at_ms INTEGER CHECK (last_alert_at_ms IS NULL OR last_alert_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);
INSERT OR IGNORE INTO trust_monitor_state(
  config_id, enabled, interval_seconds, notifications_enabled, capability, updated_at_ms
) VALUES (1, 0, 30, 0, 'not_started', 0);
"#;

/// v20：consent 的状态必须带有明确的开关维度；旧 observation 保留为 NULL，
/// 只能产生 unavailable/非 critical 结论，不能回填猜测。
const SCHEMA_V20_ADD: &str = r#"
ALTER TABLE trust_observations ADD COLUMN consent_kind TEXT CHECK (
  consent_kind IS NULL OR consent_kind IN ('indexing','telemetry','improvement','privacy','other_declared')
);
CREATE INDEX IF NOT EXISTS trust_observations_consent
  ON trust_observations(consent_kind, consent_state, observed_at_ms);
"#;

/// v21：通知冷却按稳定 Finding key 分桶。旧的单行状态字段保留作向后兼容，
/// 但不能让两个不同 Finding 互相抑制。
const SCHEMA_V21_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS trust_monitor_alerts (
  alert_key TEXT PRIMARY KEY,
  last_alert_at_ms INTEGER NOT NULL CHECK (last_alert_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);
CREATE TABLE IF NOT EXISTS trust_suppressions (
  suppression_id TEXT PRIMARY KEY,
  issue_type TEXT NOT NULL,
  instance_fingerprint TEXT,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
);
CREATE INDEX IF NOT EXISTS trust_suppressions_lookup
  ON trust_suppressions(issue_type, instance_fingerprint, revoked_at_ms);
"#;

/// v22：证据来源是结构化的可信度输入。历史行只能标记为
/// `unknown_legacy`；不能把没有来源信息的旧记录升级成远端确认。
const SCHEMA_V22_ADD: &str = r#"
ALTER TABLE trust_observations ADD COLUMN evidence_origin TEXT NOT NULL DEFAULT 'unknown_legacy' CHECK (evidence_origin IN (
  'local_artifact','client_state_claim','runtime_process_metadata','network_metadata','verified_receipt','unknown_legacy'
));
"#;

/// v23：事件总线的事务性 outbox（AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC §4.2）。
/// 事件行与它描述的状态变更**同事务**写入；投递进度按 `(event_id, consumer_id)`
/// 反连接计算——刻意不用 outbox 行上的单一 `delivered` 位：消费者注册面随进程
/// 不同（CLI 一组、桌面一组），一个进程置位会让另一个进程的消费者永远看不到。
/// `harness` 列可空：执行环境域事件（FactsIngested 等）携带，全局事件（计时器等）为
/// NULL；`delete_imported_harness_data` 据此级联清理。
const SCHEMA_V23_ADD: &str = r#"
CREATE TABLE IF NOT EXISTS event_outbox (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL CHECK (schema_version >= 1),
  occurred_at_ms  INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  harness            TEXT,
  correlation_id  TEXT,
  producer        TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms   INTEGER NOT NULL CHECK (created_at_ms >= 0)
);
CREATE INDEX IF NOT EXISTS event_outbox_pending
  ON event_outbox(created_at_ms, event_id);
CREATE TABLE IF NOT EXISTS event_deliveries (
  event_id        TEXT NOT NULL,
  consumer_id     TEXT NOT NULL,
  delivered_at_ms INTEGER NOT NULL CHECK (delivered_at_ms >= 0),
  last_error      TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms INTEGER,
  PRIMARY KEY (event_id, consumer_id)
);
"#;

/// v24：SourceGraph 检查点列（AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC §5.1）。
/// `byte_offset` 是增量解析的续读位置——只由解析成功的事务推进；`parser_id`
/// 标识哪个 SourceParser 负责此文件；`dirty` 是脏标记（watch 事件/tick 填、
/// 调度器清）。三列都可空：旧文件在首次被 SourceGraph 路径处理前是 NULL。
const SCHEMA_V24_ADD: &str = r#"
ALTER TABLE source_files ADD COLUMN byte_offset INTEGER;
ALTER TABLE source_files ADD COLUMN parser_id TEXT;
ALTER TABLE source_files ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
"#;

fn ensure_schema_v24(conn: &Connection) -> Result<(), AuthorityError> {
    let has_byte_offset: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('source_files') WHERE name = 'byte_offset'",
        [], |row| row.get::<_, i64>(0),
    )? > 0;
    if !has_byte_offset { conn.execute_batch(SCHEMA_V24_ADD)?; }
    Ok(())
}

/// v25：事件投递的死信/重试列（EVENT_SYSTEM_ARCHITECTURE_ANALYSIS 缺口 1）。
const SCHEMA_V25_ADD: &str = r#"
ALTER TABLE event_deliveries ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_deliveries ADD COLUMN next_retry_at_ms INTEGER;
"#;

fn ensure_schema_v25(conn: &Connection) -> Result<(), AuthorityError> {
    let has_retry: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('event_deliveries') WHERE name = 'retry_count'",
        [], |row| row.get::<_, i64>(0),
    )? > 0;
    if !has_retry { conn.execute_batch(SCHEMA_V25_ADD)?; }
    Ok(())
}

/// `schema_meta` 里权威 revision 标量的键（RUNTIME_INVALIDATION spec §4.1）。
pub const AUTHORITY_REVISION_KEY: &str = "authority_revision";

/// v26：权威 revision 标量——每个**改了业务状态**的写事务提交时 +1
/// （`commit_advancing_revision`）。它是失效信号与读侧 memo 的唯一时钟：
/// 不是表结构变更，但仍升 SCHEMA_VERSION——旧二进制的写事务不推进它，
/// 混装（老 CLI + 新 app）会让 memo 静默陈旧；升版让老二进制以
/// `NewerSchema` 拒绝而不是悄悄写错（spec §4.1「宁可响亮失败」）。
fn ensure_schema_v26(conn: &Connection) -> Result<(), AuthorityError> {
    conn.execute(
        "INSERT OR IGNORE INTO schema_meta(key, value) VALUES(?1, '0')",
        rusqlite::params![AUTHORITY_REVISION_KEY],
    )?;
    Ok(())
}

/// v27（REFRESH_STORM R6a）：`trust_monitor_state.enabled_source` 标记列——
/// trust 默认开启 rollout 的知情同意基座。四态：`legacy_default`（迁移前
/// 存量库，待询问）/ `default`（R6c 翻转后的全新库出厂值）/ `user`（用户
/// 显式保存过，任何迁移永不覆写）/ `dismissed`（询问被「稍后」，永不再问
/// 且保持关）。本版**不翻默认**：fresh 种子行与存量行都是 `legacy_default`
/// + enabled=0；翻默认是 R6c（前置：§7.5 24h soak），届时只改种子行。
///
/// v30（发布前拍板 2026-10-01：未正式发布，不做老 id 兼容）：把 manifest 执行环境
/// 的旧 `plugin-` 期 fact_id 一次性重 stamp 到 `harness:` 身份。标记 = source_profile
/// 仍为 `plugin-` 前缀（v29 只折算了 harness 列）。同事件新 id 已存在（重导先写
/// 入）时删除旧行保留新行；provenance 子行先随迁再改父键。幂等：无标记行即空转。
fn ensure_schema_v30(conn: &Connection) -> Result<(), AuthorityError> {
    // 事实行改 fact_id 牵动子表（billing_fact_attributions /
    // extension_fact_provenance）。立即 FK 校验下「先子后父」任一顺序都会
    // 中途违约——事务内延迟到 COMMIT 统一校验，子表父表同批改。
    conn.execute_batch("PRAGMA defer_foreign_keys=ON")?;
    let mut statement = conn.prepare(
        "SELECT fact_id, machine_namespace, harness, source_profile, native_session_id, source_event_id, observation_kind
         FROM usage_facts WHERE source_profile LIKE 'plugin-%'",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?,
        ))
    })?.collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (old_id, namespace, harness, profile, session, event, kind) in rows {
        let slug = harness.strip_prefix("harness:").map(str::to_string).unwrap_or_else(|| harness.clone());
        let new_harness = format!("harness:{slug}");
        let rest = profile.strip_prefix("plugin-").map(str::to_string).unwrap_or_else(|| profile.clone());
        let new_profile = format!("harness-{rest}");
        let new_id = agent_vitals_domain::contracts::usage_fact::fact_id(
            &namespace, &new_harness, &new_profile, &session, &event, &kind,
        );
        if new_id == old_id { continue; }
        // 事件级 UNIQUE(harness,ns,session,event,kind) 保证同事件的「新 id 行」
        // 不可能与旧行共存（重导在新 key 下直接被拒）——所以这里只需 UPDATE；
        // 若仍撞 fact_id 主键（异事件哈希碰撞），事务失败整体回滚，响亮报错。
        conn.execute(
            "UPDATE extension_fact_provenance SET fact_id=?1 WHERE fact_id=?2",
            rusqlite::params![new_id, old_id])?;
        conn.execute(
            "UPDATE billing_fact_attributions SET fact_id=?1 WHERE fact_id=?2",
            rusqlite::params![new_id, old_id])?;
        let changed = conn.execute(
            "UPDATE usage_facts SET fact_id=?1, source_profile=?2 WHERE fact_id=?3",
            rusqlite::params![new_id, new_profile, old_id])?;
        if changed != 1 { return Err(AuthorityError::Sqlite(rusqlite::Error::QueryReturnedNoRows)); }
    }
    Ok(())
}

/// v33（City 概览性能）：`usage_facts` 增加按事件时间查询的部分索引——纯加性，
/// 幂等重跑安全。索引只改变访问路径，不改变范围、分桶、去重或 token 求和语义。
fn ensure_schema_v33(conn: &Connection) -> Result<(), AuthorityError> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS usage_facts_event_time\n             ON usage_facts(event_ts_ms) WHERE deleted_at_ms IS NULL;",
    )?;
    Ok(())
}

/// v32（City 楼名）：`sessions` 加 `title` / `title_source` 两列——纯加性，
/// 无数据迁移。列存在性用 pragma 守卫（同 `apply_schema_v16` 的纪律：只把
/// 「查无此列」当缺失，真错误上抛），幂等重跑安全。
fn ensure_schema_v32(conn: &Connection) -> Result<(), AuthorityError> {
    for (table, column_ddl) in [
        ("sessions", "title TEXT"),
        ("sessions", "title_source TEXT"),
    ] {
        let column = column_ddl.split_whitespace().next().unwrap_or_default();
        let present = match conn.query_row(
            &format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}'"),
            [],
            |_| Ok(true),
        ) {
            Ok(present) => present,
            Err(rusqlite::Error::QueryReturnedNoRows) => false,
            Err(error) => return Err(error.into()),
        };
        if !present {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column_ddl};"))?;
        }
    }
    Ok(())
}

fn ensure_schema_v27(conn: &Connection) -> Result<(), AuthorityError> {
    let has_source: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('trust_monitor_state') WHERE name = 'enabled_source'",
        [], |row| row.get::<_, i64>(0),
    )? > 0;
    if !has_source {
        conn.execute_batch(
            "ALTER TABLE trust_monitor_state ADD COLUMN enabled_source TEXT NOT NULL DEFAULT 'legacy_default';",
        )?;
    }
    Ok(())
}

/// 读权威 revision（缺行按 0——只读连接打开一个从未被 v26 writer 打开过的
/// 库时会遇到；writer 的 `open` 总会先补行）。
pub fn revision_of(conn: &Connection) -> Result<u64, AuthorityError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = ?1",
            rusqlite::params![AUTHORITY_REVISION_KEY],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|v| v.parse().ok()).unwrap_or(0))
}

/// 一次写事务的起点标记：`BEGIN IMMEDIATE` + 记下事务前的 `total_changes()`。
/// 与 [`commit_advancing_revision`] 成对——用 SQL 函数而非 rusqlite API
/// （0.31 没有 `Connection::total_changes`，不为此升依赖）。
#[derive(Clone, Copy, Debug)]
pub struct TxnMark {
    changes_before: i64,
}

pub fn begin_immediate(conn: &Connection) -> rusqlite::Result<TxnMark> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let changes_before: i64 = conn.query_row("SELECT total_changes()", [], |r| r.get(0))?;
    Ok(TxnMark { changes_before })
}

/// 提交写事务；事务内**有行被改**才推进 revision（spec §4.1「空事务不推进」）。
/// `total_changes()` 不计 `INSERT OR IGNORE` 被吸收的行与纯 SELECT，所以「查后
/// 无事可做」的路径提交后 revision 不动——这是 REVIEW G2「无变化 tick 零发射」
/// 在核心层成立的前提。回滚路径不经此处。
pub fn commit_advancing_revision(conn: &Connection, mark: TxnMark) -> rusqlite::Result<()> {
    let changes_after: i64 = conn.query_row("SELECT total_changes()", [], |r| r.get(0))?;
    if changes_after > mark.changes_before {
        conn.execute(
            "UPDATE schema_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ?1",
            rusqlite::params![AUTHORITY_REVISION_KEY],
        )?;
    }
    conn.execute_batch("COMMIT")
}

fn ensure_schema_v20(conn: &Connection) -> Result<(), AuthorityError> {
    let has_consent_kind: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('trust_observations') WHERE name = 'consent_kind'",
        [], |row| row.get::<_, i64>(0),
    )? > 0;
    if !has_consent_kind {
        conn.execute_batch(SCHEMA_V20_ADD)?;
    } else {
        conn.execute_batch("CREATE INDEX IF NOT EXISTS trust_observations_consent ON trust_observations(consent_kind, consent_state, observed_at_ms);")?;
    }
    Ok(())
}

fn ensure_schema_v22(conn: &Connection) -> Result<(), AuthorityError> {
    let has_evidence_origin: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('trust_observations') WHERE name = 'evidence_origin'",
        [], |row| row.get::<_, i64>(0),
    )? > 0;
    if !has_evidence_origin { conn.execute_batch(SCHEMA_V22_ADD)?; }
    Ok(())
}

/// 增量 7.5：v1 base 表之上的 4 个脱敏只读 view。`CREATE VIEW IF NOT EXISTS`
/// 幂等——在 `ensure_schema` 的「version == SCHEMA_VERSION」分支上执行。
/// **不**进 `SCHEMA_V1` 主 DDL，避免『v1 库必须重跑 SCHEMA_V1 才能拿 view』
/// 这种不必要的迁移负担。
const VIEWS_V1: &str = r#"
CREATE VIEW IF NOT EXISTS v_facts_safe AS
  SELECT fact_id, harness, observation_kind, source_profile,
         provider_id, provider_raw, billing_source, billing_mode,
         pricing_basis, billing_template_id, evidence_basis, normalization_version,
         route_evidence_id, attribution_version,
         model_id, event_ts_ms, event_peak,
         uncached_input_tokens, cache_read_tokens,
         cache_write_tokens, output_tokens,
         ingested_run_id, created_at_ms, updated_at_ms, deleted_at_ms
  FROM usage_facts;
CREATE VIEW IF NOT EXISTS v_sessions_safe AS
  SELECT session_key, harness, source_profile,
         started_at_ms, ended_at_ms, last_observed_at_ms, deleted_at_ms
  FROM sessions;
CREATE VIEW IF NOT EXISTS v_data_quality_safe AS
  SELECT issue_id, scope_type, scope_key, code, severity,
         first_seen_at_ms, last_seen_at_ms, resolved_at_ms
  FROM data_quality_issues;
CREATE VIEW IF NOT EXISTS v_sync_runs_safe AS
  SELECT run_id, started_at_ms, completed_at_ms, trigger, status,
         schema_version, error_code
  FROM sync_runs;
"#;

/// v0.9.1 Phase 3.4：`budget_config` 单行（config_id=1）的 typed 视图。
/// 金额一律**最小货币单位整数**（纪律 2「金额不落浮点」——展示层再换算）；
/// `warning_ratio_bp` 是万分比（8000 = 80%，seed 时由 config.toml 的
/// `warn_at_ratio: 0.8` × 10000 得来）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetConfig {
    pub monthly_cny_minor: i64,
    pub daily_cny_minor: i64,
    pub warning_ratio_bp: i64,
    pub updated_at_ms: i64,
}

/// v1.0 的双预算配置。`estimate` 与 `confirmed` 是两个互斥口径，不能用
/// 一个金额字段代替；currency 明确绑定到每个口径，避免 USD 静默进入 CNY。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetProfile {
    pub profile_id: String,
    pub currency: String,
    pub monthly_minor: i64,
    pub daily_minor: Option<i64>,
    pub warning_ratio_bp: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HarnessImportedDataDeletion {
    pub facts: usize,
    pub sessions: usize,
    pub source_files: usize,
    pub trust_observations: usize,
    pub route_evidence: usize,
    pub session_excerpts: usize,
}

/// 权威库连接。**非 Sync**（rusqlite `Connection` 语义同旧 store）；每线程
/// 自开。open 时：`foreign_keys=ON`（spec §3 前言）+ WAL + `busy_timeout`
/// + DDL 版本闸 + 中断批次清扫（§3.1）。
#[derive(Debug)]
pub struct AuthorityDb {
    conn: Connection,
}

impl AuthorityDb {
    /// 打开（不存在则建库 + 全量 DDL）。**损坏不自愈**——`Corrupt` 上抛，
    /// 恢复路径在模块头。
    pub fn open(db_path: &Path, now_ms: i64) -> Result<Self, AuthorityError> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir).map_err(AuthorityError::Io)?;
        }
        let conn = Connection::open(db_path)?;
        // 损坏库在第一个语句就会炸——先探一下（PRAGMA 是最便宜的语句），
        // 把 sqlite 的 "not a database"/"malformed" 归为 Corrupt 语义由调用
        // 方走恢复流程，而不是当成普通 Sqlite 错误继续写。
        // busy_timeout 必须先于 journal_mode：WAL 切换本身要拿锁——并发
        // open（托盘 tick + CLI）时先设 journal_mode 会直接 BUSY 报错
        // （审查 P1-1 的触发面之一）。
        conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::ensure_schema(&conn, now_ms)?;
        crate::issues::repair_issue_timestamp_units(&conn)?;
        Ok(Self { conn })
    }

    /// **只读取数面**（Data MCP `data-mcp serve`，spec §9.3）：`SQLITE_OPEN_READ_ONLY`——
    /// 不建库、不跑 DDL、不 migration、不清扫中断批次。缺文件 / 损坏 / schema
    /// 版本不符各返回 typed 错误，供调用方映射成 spec §11 的稳定错误码
    /// （`database_missing` / `database_unreadable` / `schema_too_new` /
    /// `schema_migration_required`）。
    ///
    /// 与 [`Self::open`] 的「不存在则建库」刻意相反：只读消费者遇到缺库/损坏
    /// 必须如实报错——在 `sql_authority_enabled` 下，一个被悄悄新建的空库
    /// 端出 facts=0 会被读成「没花钱」（spec §5.3 / 1.7 的灾难态）。
    pub fn open_readonly(db_path: &Path) -> Result<Self, AuthorityError> {
        if !db_path.exists() {
            return Err(AuthorityError::MissingFile);
        }
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|_| AuthorityError::Corrupt)?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
        // 损坏 / 非 SQLite / 半建库探测：`schema_meta` 读不出就不是我们的库。
        // （`PRAGMA integrity_check` 更彻底但慢——留给 `data_status` 自己跑，
        // 它是 doctor 工具，其余工具在这一步 fail-fast 即可。）
        let found: i64 = match conn.query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |r| r.get::<_, String>(0),
        ) {
            Ok(s) => s.parse().map_err(|_| AuthorityError::Corrupt)?,
            Err(_) => return Err(AuthorityError::Corrupt),
        };
        match found.cmp(&SCHEMA_VERSION) {
            std::cmp::Ordering::Equal => Ok(Self { conn }),
            std::cmp::Ordering::Greater => Err(AuthorityError::NewerSchema {
                found,
                supported: SCHEMA_VERSION,
            }),
            std::cmp::Ordering::Less => Err(AuthorityError::OlderSchema { found }),
        }
    }

    /// **只读 + authorizer 守护的连接**（增量 7.5 `query_sql_readonly` 专用）——
    /// `SQLITE_OPEN_READ_ONLY` + 挂 SQLite `sqlite3_set_authorizer` 回调，按
    /// 来源表 + 来源列拒绝敏感字段（spec §8.2 P1-5：作者层拒绝是第一层防线，
    /// 结果列名扫描仅第二层）。
    ///
    /// **不在 v1 兼容承诺内**：仅 `mcp-internal` 构建调用；公开构建不挂这个
    /// 工具。Caller 必须在执行前/后 close this connection。
    pub fn make_query_sql_readonly_connection(
        db_path: &Path,
    ) -> Result<Connection, AuthorityError> {
        if !db_path.exists() {
            return Err(AuthorityError::MissingFile);
        }
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|_| AuthorityError::Corrupt)?;
        conn.busy_timeout(std::time::Duration::from_millis(3_000))?;
        // 用 raw connection 挂 authorizer——`rusqlite::Connection::authorizer`
        // 接受 `FnMut(AuthContext) -> Authorization + Send + RefUnwindSafe + 'static`。
        conn.authorizer(Some(authority_callback));
        Ok(conn)
    }

    fn ensure_schema(conn: &Connection, now_ms: i64) -> Result<(), AuthorityError> {
        // Legacy branches commit v27 first. Only the common final transaction
        // may advertise v28; an interrupted additive migration stays at v27.
        const SCHEMA_VERSION: i64 = 27;
        // 版本行在 SCHEMA_V1 里随全量 DDL 一起建——这里只**读**：schema_meta
        // 表不存在 = 全新库（None）。不能先无条件建表再跑全量 DDL（后者会
        // 撞 already exists）。
        let meta_exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        let version: Option<i64> = if meta_exists {
            conn.query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| v.parse().ok())
        } else {
            None
        };
        let legacy_host_columns: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('usage_facts') WHERE name = 'host')",
            [], |row| row.get(0),
        )?;
        if legacy_host_columns {
            return Err(AuthorityError::OlderSchema { found: version.unwrap_or(0) });
        }
        match version {
            Some(v) if v > super::authority::SCHEMA_VERSION => {
                return Err(AuthorityError::NewerSchema {
                    found: v,
                    supported: super::authority::SCHEMA_VERSION,
                })
            }
            // 幂等升级带：27（旧分支提交点）..=当前版本都走加性尾事务——v29
            // 曾漏掉「上一发布版本 28」，导致现网 28 库掉进 unsupported 分支。
            Some(v) if (SCHEMA_VERSION..=super::authority::SCHEMA_VERSION).contains(&v) => {
                // 增量 7.5：脱敏只读 view（`query_sql_readonly` 的来源层屏障）。
                // 版本无关的只读加法——`CREATE VIEW IF NOT EXISTS` 幂等。
                conn.execute_batch(SCHEMA_V18_ADD)?;
                conn.execute_batch(SCHEMA_V19_ADD)?;
                conn.execute_batch(SCHEMA_V21_ADD)?;
                ensure_schema_v22(conn)?;
                conn.execute_batch(SCHEMA_V23_ADD)?;
                ensure_schema_v24(conn)?;
                ensure_schema_v25(conn)?;
                ensure_schema_v26(conn)?;
                ensure_schema_v27(conn)?;
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(25) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                // 版本戳直接盖到 SCHEMA_VERSION，故本臂必须含 25→当前的全部迁移
                //（v26 revision 标量 + v27 enabled_source 列）。
                let migration = ensure_schema_v26(conn).and_then(|_| ensure_schema_v27(conn));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(26) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = ensure_schema_v27(conn);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(17) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V18_ADD)
                    .and_then(|_| conn.execute_batch(SCHEMA_V19_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(18) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V19_ADD);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(19) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = ensure_schema_v20(conn).and_then(|()| conn.execute_batch(SCHEMA_V21_ADD).map_err(AuthorityError::from));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(20) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V21_ADD);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(21) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = ensure_schema_v22(conn);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(24) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = ensure_schema_v25(conn);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(23) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = ensure_schema_v24(conn);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(22) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V23_ADD)
                    .map_err(crate::authority::AuthorityError::from);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(16) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V17_ADD);
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(15) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = apply_schema_v16(conn).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(14) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V15_ADD).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(13) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V14_ADD).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(12) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V13_ADD).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(11) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V12_ADD).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(10) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V11_ADD).and_then(|()| conn.execute_batch(SCHEMA_V12_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(9) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V10_ADD).and_then(|()| conn.execute_batch(SCHEMA_V11_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V12_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(8) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V9_ADD).and_then(|()| conn.execute_batch(SCHEMA_V10_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V11_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V12_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(7) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V8_ADD).and_then(|()| conn.execute_batch(SCHEMA_V9_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V10_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V11_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V12_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(6) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V7_ADD).and_then(|()| conn.execute_batch(SCHEMA_V8_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V9_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V10_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V11_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V12_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute(
                            "UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
                            rusqlite::params![SCHEMA_VERSION.to_string()],
                        )?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(5) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V6_ADD).and_then(|()| conn.execute_batch(SCHEMA_V7_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V8_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V9_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V10_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V11_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V12_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute(
                            "UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
                            rusqlite::params![SCHEMA_VERSION.to_string()],
                        )?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(error.into());
                    }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(4) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V5_ADD).and_then(|()| conn.execute_batch(SCHEMA_V6_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V7_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V8_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V9_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V10_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V11_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V12_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V13_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V14_ADD)).and_then(|()| conn.execute_batch(SCHEMA_V15_ADD)).and_then(|()| apply_schema_v16(conn)).and_then(|()| conn.execute_batch(SCHEMA_V17_ADD));
                match migration {
                    Ok(()) => {
                        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'", rusqlite::params![SCHEMA_VERSION.to_string()])?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error.into()); }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(3) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V4_ADD);
                match migration {
                    Ok(()) => {
                        if let Err(error) = conn.execute_batch(SCHEMA_V5_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V6_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V7_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V8_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V9_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V10_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V11_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V12_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V13_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V14_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V15_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = apply_schema_v16(conn) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V17_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        conn.execute(
                            "UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
                            rusqlite::params![SCHEMA_VERSION.to_string()],
                        )?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(error.into());
                    }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(2) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(SCHEMA_V3_ADD);
                match migration {
                    Ok(()) => {
                        if let Err(error) = conn.execute_batch(SCHEMA_V4_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V5_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V6_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V7_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V8_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V9_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V10_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V11_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V12_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V13_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V14_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V15_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = apply_schema_v16(conn) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V17_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        conn.execute(
                            "UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
                            rusqlite::params![SCHEMA_VERSION.to_string()],
                        )?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(error.into());
                    }
                }
                conn.execute_batch("DROP VIEW IF EXISTS v_facts_safe;")?;
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(1) => {
                conn.execute_batch("BEGIN IMMEDIATE")?;
                let migration = conn.execute_batch(MIGRATE_V1_TO_V2);
                match migration {
                    Ok(()) => {
                        if let Err(error) = conn.execute_batch(SCHEMA_V3_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V4_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V5_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V6_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V7_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V8_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V9_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V10_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V11_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V12_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V13_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V14_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V15_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = apply_schema_v16(conn) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        if let Err(error) = conn.execute_batch(SCHEMA_V17_ADD) {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Err(error.into());
                        }
                        conn.execute(
                            "UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
                            rusqlite::params![SCHEMA_VERSION.to_string()],
                        )?;
                        conn.execute_batch("COMMIT")?;
                    }
                    Err(error) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(error.into());
                    }
                }
                conn.execute_batch(VIEWS_V1)?;
            }
            Some(old) => {
                return Err(AuthorityError::Sqlite(
                    rusqlite::Error::InvalidParameterName(format!(
                        "__unsupported_legacy_version__:{old}"
                    )),
                ));
            }
            None => {
                // 空库：若已有业务表（无版本行的半建库——创建中断残留），
                // 视为损坏：建库流程必须事务化完成，半建状态不可信。
                let has_tables: bool = conn
                    .query_row(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table'
                         AND name IN ('usage_facts','sync_runs','sessions')",
                        [],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if has_tables {
                    return Err(AuthorityError::Sqlite(
                        rusqlite::Error::InvalidParameterName(
                            "__corrupt_partial_schema__".to_string(),
                        ),
                    ));
                }
                conn.execute_batch("BEGIN IMMEDIATE")?;
                conn.execute_batch(SCHEMA_V1)?;
                conn.execute_batch(SCHEMA_V3_ADD)?;
                conn.execute_batch(SCHEMA_V4_ADD)?;
                conn.execute_batch(SCHEMA_V5_ADD)?;
                conn.execute_batch(SCHEMA_V6_ADD)?;
                conn.execute_batch(SCHEMA_V7_ADD)?;
                conn.execute_batch(SCHEMA_V8_ADD)?;
                conn.execute_batch(SCHEMA_V9_ADD)?;
                conn.execute_batch(SCHEMA_V10_ADD)?;
                conn.execute_batch(SCHEMA_V11_ADD)?;
                conn.execute_batch(SCHEMA_V12_ADD)?;
                conn.execute_batch(SCHEMA_V13_ADD)?;
                conn.execute_batch(SCHEMA_V14_ADD)?;
                conn.execute_batch(SCHEMA_V15_ADD)?;
                apply_schema_v16(conn)?;
                conn.execute_batch(SCHEMA_V17_ADD)?;
                // 增量 7.5：新建库时同步加 4 个脱敏只读 view（spec §8.2 P1-5）。
                conn.execute_batch(VIEWS_V1)?;
                conn.execute(
                    "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?1)",
                    rusqlite::params![SCHEMA_VERSION.to_string()],
                )?;
                conn.execute_batch("COMMIT")?;
                let _ = now_ms; // v1 建库本身不写业务时间戳（版本行是元数据）
            }
        }
        // v18/v19 都只有 `CREATE ... IF NOT EXISTS`。历史分支在升级 V1–V17
        // 后会把 version 直接盖到当前值，故在同一 writer open 内补一次；这也
        // 修复崩溃恰好发生在旧版链已提交、增量表尚未执行时留下的陈旧版本戳。
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let upgrade = (|| -> Result<(), AuthorityError> {
        conn.execute_batch(SCHEMA_V18_ADD)?;
        conn.execute_batch(SCHEMA_V19_ADD)?;
        ensure_schema_v20(conn)?;
        conn.execute_batch(SCHEMA_V21_ADD)?;
        ensure_schema_v22(conn)?;
        conn.execute_batch(SCHEMA_V23_ADD)?;
        ensure_schema_v24(conn)?;
        ensure_schema_v25(conn)?;
        ensure_schema_v26(conn)?;
        ensure_schema_v27(conn)?;
        conn.execute_batch(crate::extension_authority::SCHEMA_V28_ADD)?;
        // v29（HARNESS_MANIFEST_DSL_SPEC §13.3）：harness 字符串契约迁移 `plugin:` →
        // `harness:`。幂等 UPDATE，只改 harness 列、不触碰任何其他事实字段；facts
        // 文件改名由 ingest 层 `migrate_manifest_facts_prefix` 配套完成（迁移
        // 期间读写两侧都双认新旧前缀，见 harness_registry/source_controls）。
        conn.execute_batch(
            "UPDATE usage_facts SET harness = 'harness:' || substr(harness, 8) WHERE harness LIKE 'plugin:%';",
        )?;
        ensure_schema_v30(conn)?;
        ensure_schema_v32(conn)?;
        ensure_schema_v33(conn)?;
        conn.execute("UPDATE schema_meta SET value = ?1 WHERE key = 'schema_version'",
            rusqlite::params![super::authority::SCHEMA_VERSION.to_string()])?;
        Ok(())
        })();
        match upgrade {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(error) => { let _ = conn.execute_batch("ROLLBACK"); return Err(error); }
        }
        // 中断批次清扫（§3.1）：任何 running 的批次在下次 open 时标
        // interrupted——它是观测记录，不是可恢复状态（恢复靠幂等重跑）。
        conn.execute(
            "UPDATE sync_runs SET status = 'cancelled',
                 error_code = COALESCE(error_code, 'interrupted'),
                 completed_at_ms = COALESCE(completed_at_ms, ?1)
             WHERE status = 'running'",
            rusqlite::params![now_ms],
        )?;
        Ok(())
    }

    /// 开启一个同步批次（§3.1 sync_runs）。`run_id` 由调用方生成（幂等重跑
    /// 用同一 id 时是「重跑恢复」语义，不是新批次）。
    pub fn begin_run(
        &self,
        run_id: &str,
        trigger: &str,
        now_ms: i64,
    ) -> Result<(), AuthorityError> {
        self.conn.execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES (?1, ?2, ?3, 'running', ?4)
             ON CONFLICT(run_id) DO UPDATE SET
                 started_at_ms = excluded.started_at_ms,
                 status = 'running',
                 error_code = NULL,
                 error_detail = NULL",
            rusqlite::params![run_id, now_ms, trigger, SCHEMA_VERSION],
        )?;
        Ok(())
    }

    /// 结束批次。status ∈ succeeded | failed | cancelled（§3.1 词表）。
    pub fn finish_run(
        &self,
        run_id: &str,
        status: &str,
        error_code: Option<&str>,
        error_detail: Option<&str>,
        now_ms: i64,
    ) -> Result<(), AuthorityError> {
        self.conn.execute(
            "UPDATE sync_runs SET status = ?2, completed_at_ms = ?3,
                 error_code = ?4, error_detail = ?5
             WHERE run_id = ?1",
            rusqlite::params![run_id, status, now_ms, error_code, error_detail],
        )?;
        Ok(())
    }

    /// 保留滚动（spec §5.4）：物理清理 13 个自然月前的 usage_facts 行。
    /// `cutoff_iso_prefix` = "YYYY-MM"（event_ts_ms 由调用方换成 ISO 前缀
    /// 比较不便——这里直接收 UTC 毫秒下界 `cutoff_ms`：event_ts_ms < cutoff
    /// 的行删除）。无日期（event_ts_ms NULL）与 deleted 行的清理走显式
    /// 修复流程（spec §5.4「不能静默删除」），本函数不碰。
    pub fn retention_usage_facts(&self, cutoff_ms: i64) -> Result<usize, AuthorityError> {
        Ok(self.conn.execute(
            "DELETE FROM usage_facts WHERE event_ts_ms IS NOT NULL AND event_ts_ms < ?1",
            rusqlite::params![cutoff_ms],
        )?)
    }

    /// V16：`session_excerpts` 随会话活跃月滚动（spec §7）——会话最后活跃时刻
    /// 早于 cutoff 时该会话的摘录整组删除。与 `retention_usage_facts` 同一趟
    /// 跑（同一 cutoff），不另起定时；会话行本身不动（软删除语义归 delete 面）。
    pub fn retention_session_excerpts(&self, cutoff_ms: i64) -> Result<usize, AuthorityError> {
        Ok(self.conn.execute(
            "DELETE FROM session_excerpts WHERE session_key IN (
                 SELECT session_key FROM sessions WHERE last_observed_at_ms < ?1)",
            rusqlite::params![cutoff_ms],
        )?)
    }

    /// v23：事件 outbox 的保留清理（EVENT_BUS spec §4.2 实施勘正版）。
    ///
    /// 事件体保留 7 天；**投递记录随事件走**——`event_deliveries` 是反连接的
    /// 去重账本，事件还活着时删它的 delivery 会让反连接重新发现该事件 =
    /// 重投递（原 spec 写的「deliveries 独立保留 30 天」是重投递陷阱，勘正）。
    /// 因此顺序固定：先扫孤儿 delivery（事件已亡）→ 再删到期事件的 delivery →
    /// 最后删事件本体，全程一事务。
    pub fn retention_event_outbox(&self, now_ms: i64) -> Result<usize, AuthorityError> {
        // 差异化保留（ARCHITECTURE_ANALYSIS 缺口 2）：审计面 90 天、计费关键
        // 30 天、高频事实 7 天。每个事件按自身类型决定保留期——审计事件
        // （McpToolInvoked）是安全合规面，7 天太短。
        self.with_immediate_txn(|conn| {
            let orphans = conn.execute(
                "DELETE FROM event_deliveries WHERE event_id NOT IN
                   (SELECT event_id FROM event_outbox)",
                [],
            )?;
            let expired = conn.execute(
                "DELETE FROM event_deliveries WHERE event_id IN
                   (SELECT event_id FROM event_outbox WHERE
                     created_at_ms < ?1 - CASE event_type
                       WHEN 'McpToolInvoked' THEN 90 * 86400000
                       WHEN 'DeclarationSaved' THEN 30 * 86400000
                       WHEN 'PriceCardSaved' THEN 30 * 86400000
                       ELSE 7 * 86400000 END)",
                rusqlite::params![now_ms],
            )?;
            let events = conn.execute(
                "DELETE FROM event_outbox WHERE
                   created_at_ms < ?1 - CASE event_type
                     WHEN 'McpToolInvoked' THEN 90 * 86400000
                     WHEN 'DeclarationSaved' THEN 30 * 86400000
                     WHEN 'PriceCardSaved' THEN 30 * 86400000
                     ELSE 7 * 86400000 END",
                rusqlite::params![now_ms],
            )?;
            Ok(orphans + expired + events)
        })
    }

    /// V18：按每条 Observation 自己的过期时间清理高频、短保留的信任证据。
    /// `trust_issue_evidence` 由外键级联删除；Issue 本身保留为历史结论，后续
    /// correlator 可据「证据已过期」重新评价，而不在 retention 中绕过状态机。
    pub fn retention_trust_observations(&self, now_ms: i64) -> Result<usize, AuthorityError> {
        self.with_immediate_txn(|conn| {
            Ok(conn.execute(
                "DELETE FROM trust_observations
                 WHERE expires_at_ms IS NOT NULL AND expires_at_ms < ?1",
                rusqlite::params![now_ms],
            )?)
        })
    }

    /// 删除一个执行环境由本 App 导入的可见数据。事实和会话采用既有软删除语义，
    /// 使历史计费归因外键仍完整；来源指纹被物理删除，恢复读取后才会重新导入。
    /// 不触及用户手工账单、计费声明、价格快照或任何其他执行环境。
    pub fn delete_imported_harness_data(
        &self, harness: &str, now_ms: i64,
    ) -> Result<HarnessImportedDataDeletion, AuthorityError> {
        self.with_immediate_txn(|conn| {
            let facts = conn.execute(
                "UPDATE usage_facts SET deleted_at_ms = ?2, updated_at_ms = ?2
                 WHERE harness = ?1 AND deleted_at_ms IS NULL",
                rusqlite::params![harness, now_ms],
            )?;
            let sessions = conn.execute(
                "UPDATE sessions SET deleted_at_ms = ?2
                 WHERE harness = ?1 AND deleted_at_ms IS NULL",
                rusqlite::params![harness, now_ms],
            )?;
            conn.execute(
                "DELETE FROM workflow_events WHERE session_key IN (SELECT session_key FROM sessions WHERE harness = ?1)
                   OR source_id IN (SELECT source_id FROM source_files WHERE harness = ?1)",
                [harness],
            )?;
            conn.execute("DELETE FROM harness_runtime_snapshots WHERE harness = ?1", [harness])?;
            // Trust observation 通过 source_id 间接引用 source_files，必须在源指纹
            // 清理前先删；关联表由 observation 的 ON DELETE CASCADE 清理。
            let trust_observations = conn.execute(
                "DELETE FROM trust_observations WHERE harness = ?1",
                [harness],
            )?;
            // Task excerpts are a separate projection keyed by session_key;
            // deleting sessions alone would leave user-visible task text behind.
            let session_excerpts = conn.execute(
                "DELETE FROM session_excerpts WHERE session_key IN
                   (SELECT session_key FROM sessions WHERE harness = ?1)",
                [harness],
            )?;
            // route_evidence 是导入的路由证据；清除其 ID 后再删行，避免已软
            // 删除的事实留下悬挂证据引用。
            conn.execute("UPDATE usage_facts SET route_evidence_id = NULL WHERE harness = ?1", [harness])?;
            let route_evidence = conn.execute("DELETE FROM route_evidence WHERE harness = ?1", [harness])?;
            // 已软删除的事实不再保留源文件关联，避免 source_files 外键阻碍
            // 指纹清理，也避免已删除数据继续关联可推断的来源元数据。
            conn.execute("UPDATE usage_facts SET source_id = NULL WHERE harness = ?1", [harness])?;
            let source_files = conn.execute("DELETE FROM source_files WHERE harness = ?1", [harness])?;
            // 事件 outbox 的执行环境域行随执行环境数据一起清（含投递记录）——已删除
            // 数据的 FactsIngested 不该再驱动任何消费者（spec §4.2 级联）。
            conn.execute(
                "DELETE FROM event_deliveries WHERE event_id IN
                   (SELECT event_id FROM event_outbox WHERE harness = ?1)",
                [harness],
            )?;
            conn.execute("DELETE FROM event_outbox WHERE harness = ?1", [harness])?;
            Ok(HarnessImportedDataDeletion {
                facts, sessions, source_files, trust_observations, route_evidence, session_excerpts,
            })
        })
    }

    /// Read the explicit Trust monitor control state. The row is seeded by the
    /// schema migration, but a missing row still degrades to an unavailable
    /// state instead of silently enabling monitoring.
    pub fn trust_monitor_state_get(&self) -> Result<Option<TrustMonitorState>, AuthorityError> {
        let result = self.conn.query_row(
            "SELECT enabled, interval_seconds, notifications_enabled, capability,
                    last_success_at_ms, last_error_code, last_alert_key,
                    last_alert_at_ms, updated_at_ms, enabled_source
             FROM trust_monitor_state WHERE config_id = 1",
            [],
            |row| Ok(TrustMonitorState {
                enabled: row.get::<_, i64>(0)? != 0,
                interval_seconds: row.get(1)?,
                notifications_enabled: row.get::<_, i64>(2)? != 0,
                capability: row.get(3)?,
                last_success_at_ms: row.get(4)?, last_error_code: row.get(5)?,
                last_alert_key: row.get(6)?, last_alert_at_ms: row.get(7)?, updated_at_ms: row.get(8)?,
                enabled_source: row.get(9)?,
            }),
        );
        match result {
            Ok(state) => Ok(Some(state)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn trust_monitor_state_set(
        &self, enabled: bool, interval_seconds: i64, notifications_enabled: bool, now_ms: i64,
    ) -> Result<(), AuthorityError> {
        if !(5..=3600).contains(&interval_seconds) || now_ms < 0 {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid_trust_monitor_config".to_string(),
            )));
        }
        self.conn.execute(
            "INSERT INTO trust_monitor_state(
                config_id, enabled, interval_seconds, notifications_enabled,
                capability, updated_at_ms, enabled_source)
             VALUES (1, ?1, ?2, ?3, 'not_started', ?4, 'user')
             ON CONFLICT(config_id) DO UPDATE SET
                enabled = excluded.enabled, interval_seconds = excluded.interval_seconds,
                notifications_enabled = excluded.notifications_enabled,
                capability = 'not_started', last_success_at_ms = NULL,
                last_error_code = NULL, updated_at_ms = excluded.updated_at_ms,
                enabled_source = 'user'",
            rusqlite::params![enabled as i64, interval_seconds, notifications_enabled as i64, now_ms],
        )?;
        Ok(())
    }

    /// R6a（REFRESH_STORM，v27）：询问条幅的「稍后」——dismiss 后永不再问，
    /// enabled 保持原值（真要开仍可从设置页显式打开，那会置回 `user`）。
    pub fn trust_monitor_dismiss(&self) -> Result<(), AuthorityError> {
        self.conn.execute(
            "UPDATE trust_monitor_state SET enabled_source = 'dismissed' WHERE config_id = 1",
            [],
        )?;
        Ok(())
    }

    pub fn trust_monitor_record_result(
        &self, capability: &str, success_at_ms: Option<i64>, error_code: Option<&str>, now_ms: i64,
    ) -> Result<(), AuthorityError> {
        if !matches!(capability, "not_started" | "available" | "partial" | "unavailable")
            || now_ms < 0 || success_at_ms.is_some_and(|value| value < 0)
        {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid_trust_monitor_result".to_string(),
            )));
        }
        self.conn.execute(
            "UPDATE trust_monitor_state SET capability = ?1, last_success_at_ms = ?2,
                    last_error_code = ?3, updated_at_ms = ?4 WHERE config_id = 1",
            rusqlite::params![capability, success_at_ms, error_code, now_ms],
        )?;
        Ok(())
    }

    /// Claim a notification key with a cooldown. Returns false when the same
    /// finding family was already delivered recently, making restart/retry
    /// behavior idempotent without storing notification text.
    pub fn trust_monitor_claim_alert(
        &self, key: &str, now_ms: i64, cooldown_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if key.is_empty() || key.len() > 128 || now_ms < 0 || cooldown_ms < 0 {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid_trust_monitor_alert".to_string(),
            )));
        }
        let cutoff_ms = now_ms.saturating_sub(cooldown_ms);
        let previous = self.conn.query_row(
            "SELECT last_alert_at_ms FROM trust_monitor_alerts WHERE alert_key = ?1",
            [key], |row| row.get::<_, i64>(0),
        ).optional()?;
        if previous.is_some_and(|at| at > cutoff_ms) {
            return Ok(false);
        }
        self.conn.execute(
            "INSERT INTO trust_monitor_alerts(alert_key, last_alert_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?2)
             ON CONFLICT(alert_key) DO UPDATE SET last_alert_at_ms = excluded.last_alert_at_ms,
             updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![key, now_ms],
        )?;
        // Keep the legacy summary fields populated for old UI builds.  They are
        // informational only; the table above is the source of cooldown truth.
        self.conn.execute(
            "UPDATE trust_monitor_state SET last_alert_key = ?1, last_alert_at_ms = ?2,
                    updated_at_ms = ?2 WHERE config_id = 1",
            rusqlite::params![key, now_ms],
        )?;
        Ok(true)
    }

    pub fn trust_suppression_active(
        &self, issue_type: &str, instance_fingerprint: Option<&str>,
    ) -> Result<bool, AuthorityError> {
        let active: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM trust_suppressions
             WHERE issue_type = ?1 AND revoked_at_ms IS NULL
               AND (instance_fingerprint IS NULL OR instance_fingerprint = ?2)",
            rusqlite::params![issue_type, instance_fingerprint], |row| row.get(0),
        )?;
        Ok(active > 0)
    }

    pub fn trust_suppression_set(
        &self, suppression_id: &str, issue_type: &str, instance_fingerprint: Option<&str>,
        reason: &str, now_ms: i64,
    ) -> Result<(), AuthorityError> {
        if suppression_id.is_empty() || suppression_id.len() > 128 || issue_type.is_empty()
            || reason.is_empty() || reason.len() > 500 || now_ms < 0
        {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid_trust_suppression".to_string(),
            )));
        }
        self.conn.execute(
            "INSERT INTO trust_suppressions(suppression_id, issue_type, instance_fingerprint, reason, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(suppression_id) DO UPDATE SET issue_type=excluded.issue_type,
             instance_fingerprint=excluded.instance_fingerprint, reason=excluded.reason,
             revoked_at_ms=NULL",
            rusqlite::params![suppression_id, issue_type, instance_fingerprint, reason, now_ms],
        )?;
        Ok(())
    }

    pub fn trust_suppression_revoke(&self, suppression_id: &str, now_ms: i64) -> Result<bool, AuthorityError> {
        if suppression_id.is_empty() || now_ms < 0 {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid_trust_suppression".to_string(),
            )));
        }
        Ok(self.conn.execute(
            "UPDATE trust_suppressions SET revoked_at_ms = ?2
             WHERE suppression_id = ?1 AND revoked_at_ms IS NULL",
            rusqlite::params![suppression_id, now_ms],
        )? == 1)
    }

    // ─────── v0.9.1 Phase 3.4：budget_config / budget_snoozes 显式管理 API
    // （spec §5.3「账单和预算配置为显式管理 API」；单行表 config_id/snooze_id
    // 恒 1，upsert 语义）。金额全是 minor 整数；判断在消费方，全整数比较。

    /// 读预算配置。None = 从未配置（消费方决定回落默认或报 no_budget）。
    pub fn budget_config_get(&self) -> Result<Option<BudgetConfig>, AuthorityError> {
        let r = self.conn.query_row(
            "SELECT monthly_cny_minor, daily_cny_minor, warning_ratio_bp, updated_at_ms
             FROM budget_config WHERE config_id = 1",
            [],
            |r| {
                Ok(BudgetConfig {
                    monthly_cny_minor: r.get(0)?,
                    daily_cny_minor: r.get(1)?,
                    warning_ratio_bp: r.get(2)?,
                    updated_at_ms: r.get(3)?,
                })
            },
        );
        match r {
            Ok(c) => Ok(Some(c)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// 写预算配置（单行 upsert）。`updated_at_ms` 由调用方注入（时钟纪律）。
    pub fn budget_config_set(
        &self,
        monthly_cny_minor: i64,
        daily_cny_minor: i64,
        warning_ratio_bp: i64,
        now_ms: i64,
    ) -> Result<(), AuthorityError> {
        self.conn.execute(
            "INSERT INTO budget_config(config_id, monthly_cny_minor, daily_cny_minor,
                 warning_ratio_bp, updated_at_ms)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(config_id) DO UPDATE SET
                 monthly_cny_minor = excluded.monthly_cny_minor,
                 daily_cny_minor = excluded.daily_cny_minor,
                 warning_ratio_bp = excluded.warning_ratio_bp,
                 updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![monthly_cny_minor, daily_cny_minor, warning_ratio_bp, now_ms],
        )?;
        Ok(())
    }

    /// 读取 v1.0 双预算配置，固定按 profile_id 排序，便于各消费面稳定对拍。
    pub fn budget_profiles_get(&self) -> Result<Vec<BudgetProfile>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT profile_id, currency, monthly_minor, daily_minor,
                    warning_ratio_bp, updated_at_ms
             FROM budget_profiles ORDER BY profile_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(BudgetProfile {
                profile_id: r.get(0)?, currency: r.get(1)?, monthly_minor: r.get(2)?,
                daily_minor: r.get(3)?, warning_ratio_bp: r.get(4)?, updated_at_ms: r.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// 写入一个预算口径。金额和币种均在数据库约束下落库；同一 profile 幂等覆盖。
    pub fn budget_profile_set(
        &self,
        profile_id: &str,
        currency: &str,
        monthly_minor: i64,
        daily_minor: Option<i64>,
        warning_ratio_bp: i64,
        now_ms: i64,
    ) -> Result<(), AuthorityError> {
        if !matches!(profile_id, "estimate" | "confirmed") {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "unsupported budget profile".to_string(),
            )));
        }
        if currency.len() != 3 || !currency.is_ascii() || monthly_minor <= 0
            || daily_minor.is_some_and(|v| v <= 0)
            || !(0..=10_000).contains(&warning_ratio_bp)
        {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid budget profile".to_string(),
            )));
        }
        self.conn.execute(
            "INSERT INTO budget_profiles(profile_id, currency, monthly_minor, daily_minor,
                 warning_ratio_bp, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(profile_id) DO UPDATE SET
                 currency = excluded.currency, monthly_minor = excluded.monthly_minor,
                 daily_minor = excluded.daily_minor,
                 warning_ratio_bp = excluded.warning_ratio_bp,
                 updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![profile_id, currency, monthly_minor, daily_minor, warning_ratio_bp, now_ms],
        )?;
        Ok(())
    }

    /// Remove a user-configured budget profile. Removing the estimate profile
    /// means "no estimate budget"; it does not alter usage facts, history, or
    /// the separately-owned confirmed profile.
    pub fn budget_profile_delete(&self, profile_id: &str) -> Result<bool, AuthorityError> {
        if profile_id != "estimate" {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "only estimate budget can be disabled".to_string(),
            )));
        }
        Ok(self.conn.execute(
            "DELETE FROM budget_profiles WHERE profile_id = ?1",
            rusqlite::params![profile_id],
        )? > 0)
    }

    /// 读 snooze（`until_ms`）。None = 从未设置；已过期的不清除（判断在
    /// 消费方——「过期自动失效」与 Python 链 `now >= until` 同语义），返回
    /// 原值让消费方比较，避免这里读时钟。
    pub fn budget_snooze_get(&self) -> Result<Option<i64>, AuthorityError> {
        self.conn
            .query_row(
                "SELECT until_ms FROM budget_snoozes WHERE snooze_id = 1",
                [],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other.into()),
            })
    }

    /// 写 snooze（单行 upsert）。`until_ms` = 毫秒时间戳（调用方由 ISO 解析）。
    pub fn budget_snooze_set(&self, until_ms: i64, now_ms: i64) -> Result<(), AuthorityError> {
        self.conn.execute(
            "INSERT INTO budget_snoozes(snooze_id, until_ms, updated_at_ms)
             VALUES (1, ?1, ?2)
             ON CONFLICT(snooze_id) DO UPDATE SET
                 until_ms = excluded.until_ms, updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![until_ms, now_ms],
        )?;
        Ok(())
    }

    /// 清除 snooze（物理删单行——「撤销」不是「设为过去」，删了就是干净状态）。
    pub fn budget_snooze_clear(&self) -> Result<(), AuthorityError> {
        self.conn
            .execute("DELETE FROM budget_snoozes WHERE snooze_id = 1", [])?;
        Ok(())
    }

    // ─────── v0.9.1 Phase 2.8：pricing_snapshots（spec §5.3 价格快照）───────
    // 历史查询以记录的 pricing version 重放，不能用当前价卡覆盖历史解释
    // （§5.3）。一个 version 的内容不可变：`pricing_version` 是 payload 的
    // 内容指纹，同指纹 = 同 payload = 幂等吸收（DO NOTHING）。

    /// 落一份价格快照。`pricing_version` 由调用方按 payload 内容派生
    /// （`fnv1a64_hex(canonical_json)`）。已存在 → DO NOTHING（内容不可变）。
    pub fn pricing_snapshot_put(
        &self,
        pricing_version: &str,
        source_kind: &str,
        payload_json: &str,
        captured_at_ms: i64,
    ) -> Result<bool, AuthorityError> {
        self.pricing_snapshot_put_with_provenance(
            pricing_version, source_kind, payload_json, captured_at_ms, None, None,
        )
    }

    /// 落一份不可变价格快照，并显式关联其 catalog／模板证据。通用旧入口
    /// 保持无归属兼容；新的计费接入必须使用这个入口，触发器会拒绝孤儿引用。
    #[allow(clippy::too_many_arguments)]
    pub fn pricing_snapshot_put_with_provenance(
        &self,
        pricing_version: &str,
        source_kind: &str,
        payload_json: &str,
        captured_at_ms: i64,
        catalog_version: Option<&str>,
        billing_template_id: Option<&str>,
    ) -> Result<bool, AuthorityError> {
        let changed = self.conn.execute(
            "INSERT INTO pricing_snapshots(pricing_version, captured_at_ms, source_kind, payload_json, catalog_version, billing_template_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(pricing_version) DO NOTHING",
            rusqlite::params![pricing_version, captured_at_ms, source_kind, payload_json, catalog_version, billing_template_id],
        )?;
        Ok(changed > 0)
    }

    /// 某 version 的 payload（历史重放入口）。
    pub fn pricing_snapshot_get(
        &self,
        pricing_version: &str,
    ) -> Result<Option<String>, AuthorityError> {
        Ok(self
            .conn
            .query_row(
                "SELECT payload_json FROM pricing_snapshots WHERE pricing_version = ?1",
                rusqlite::params![pricing_version],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    /// 所有历史价格快照，按捕获时间升序。迁移读取旧版嵌入价表中的用户声明
    /// 时使用；调用方必须把提取出的个人数据写入本地表，不能重新塞回公共目录。
    pub fn pricing_snapshot_payloads(&self) -> Result<Vec<(String, String)>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT pricing_version, payload_json FROM pricing_snapshots
             ORDER BY captured_at_ms ASC, pricing_version ASC",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// `captured_at_ms` 最新的快照 `(version, captured_at_ms)`，或 None（从未落）。
    pub fn pricing_snapshot_latest(&self) -> Result<Option<(String, i64)>, AuthorityError> {
        Ok(self
            .conn
            .query_row(
                "SELECT pricing_version, captured_at_ms FROM pricing_snapshots
                 ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?)
    }

    /// `captured_at_ms <= at_ms` 里最新的一份——「按事件时间点选价卡版本」
    /// （Q13：调价日前后分别用正确版本）。没有更早的快照 → None（不拿更晚的
    /// 版本冒充历史）。
    pub fn pricing_snapshot_asof(&self, at_ms: i64) -> Result<Option<String>, AuthorityError> {
        Ok(self
            .conn
            .query_row(
                "SELECT payload_json FROM pricing_snapshots
                 WHERE captured_at_ms <= ?1
                 ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1",
                rusqlite::params![at_ms],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    pub fn pricing_snapshot_count(&self) -> Result<i64, AuthorityError> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM pricing_snapshots", [], |r| r.get(0))?)
    }

    // ─────── v0.12：billing catalog/template snapshots ────────────────────

    /// 写入 catalog 快照。`catalog_version` 和 `snapshot_id` 都是不可变身份；
    /// 相同 version 的不同 payload 是调用方错误，不能静默改写历史计费解释。
    pub fn provider_catalog_snapshot_put(
        &self,
        catalog_version: &str,
        snapshot_id: &str,
        source_kind: &str,
        payload_json: &str,
        captured_at_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if catalog_version.is_empty() || snapshot_id.is_empty() || source_kind.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "catalog_version, snapshot_id, and source_kind are required".to_string(),
            )
            .into());
        }
        let existing: Option<(String, String)> = self.conn.query_row(
            "SELECT snapshot_id, payload_json FROM provider_catalog_snapshots WHERE catalog_version = ?1",
            rusqlite::params![catalog_version],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        if let Some((existing_id, existing_payload)) = existing {
            if existing_id == snapshot_id && existing_payload == payload_json {
                return Ok(false);
            }
            return Err(rusqlite::Error::InvalidParameterName(
                "catalog_version already names a different immutable snapshot".to_string(),
            ).into());
        }
        self.conn.execute(
            "INSERT INTO provider_catalog_snapshots(
               catalog_version, captured_at_ms, source_kind, snapshot_id, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![catalog_version, captured_at_ms, source_kind, snapshot_id, payload_json],
        )?;
        Ok(true)
    }

    /// 原子写入公共 catalog 与其价格快照。两张表必须作为一个版本一起出现；
    /// 任一步违反不可变身份或外键约束，事务整体回滚，旧有效版本保持可读。
    #[allow(clippy::too_many_arguments)]
    pub fn pricing_catalog_snapshot_put(
        &self,
        catalog_version: &str,
        snapshot_id: &str,
        source_kind: &str,
        payload_json: &str,
        captured_at_ms: i64,
        billing_template_id: Option<&str>,
    ) -> Result<(bool, bool), AuthorityError> {
        let mark = begin_immediate(&self.conn)?;
        let result = (|| {
            let catalog_changed = self.provider_catalog_snapshot_put(
                catalog_version,
                snapshot_id,
                source_kind,
                payload_json,
                captured_at_ms,
            )?;
            let pricing_changed = self.pricing_snapshot_put_with_provenance(
                catalog_version,
                source_kind,
                payload_json,
                captured_at_ms,
                Some(catalog_version),
                billing_template_id,
            )?;
            Ok::<_, AuthorityError>((catalog_changed, pricing_changed))
        })();
        match result {
            Ok(changed) => {
                commit_advancing_revision(&self.conn, mark)?;
                Ok(changed)
            }
            Err(error) => {
                let _ = self.conn.execute("ROLLBACK", []);
                Err(error)
            }
        }
    }

    /// 每日同步叠加层入库：叠加层原文进 `provider_catalog_snapshots`（来源
    /// [`PRICING_SYNC_OVERLAY_SOURCE`]），「底表 + 叠加层」合并出的完整快照进
    /// `pricing_snapshots` 并以 `catalog_version` 引用它——「这份价格快照由哪份
    /// 叠加层生成」可追溯。两行同一事务：只落其一会让下次同步读到的叠加层与
    /// 实际计价用的快照对不上。
    ///
    /// 为什么叠加层也存库而不是存成本地文件：权威库是唯一数据源，历史回补
    /// （只补缺卡）要在查询里读它，备份/导出也天然带上它。
    pub fn pricing_sync_overlay_put(
        &self,
        overlay_version: &str,
        overlay_json: &str,
        pricing_version: &str,
        merged_payload_json: &str,
        captured_at_ms: i64,
    ) -> Result<(bool, bool), AuthorityError> {
        let mark = begin_immediate(&self.conn)?;
        let result = (|| {
            let overlay_changed = self.provider_catalog_snapshot_put(
                overlay_version,
                overlay_version,
                PRICING_SYNC_OVERLAY_SOURCE,
                overlay_json,
                captured_at_ms,
            )?;
            let pricing_changed = self.pricing_snapshot_put_with_provenance(
                pricing_version,
                PRICING_SYNC_OVERLAY_SOURCE,
                merged_payload_json,
                captured_at_ms,
                Some(overlay_version),
                None,
            )?;
            Ok::<_, AuthorityError>((overlay_changed, pricing_changed))
        })();
        match result {
            Ok(changed) => {
                commit_advancing_revision(&self.conn, mark)?;
                Ok(changed)
            }
            Err(error) => {
                let _ = self.conn.execute("ROLLBACK", []);
                Err(error)
            }
        }
    }

    /// 最近一次入库的同步叠加层原文（没有则 `None`）。
    pub fn latest_pricing_sync_overlay(&self) -> Result<Option<String>, AuthorityError> {
        Ok(latest_pricing_sync_overlay(&self.conn)?)
    }

    /// 落入一个模板定义。更新合同必须使用新的 template id；这里不接受覆盖。
    #[allow(clippy::too_many_arguments)]
    pub fn billing_template_put(
        &self,
        billing_template_id: &str,
        provider_id: &str,
        account_ref: Option<&str>,
        template_kind: &str,
        pricing_source: &str,
        effective_from_ms: i64,
        effective_to_ms: Option<i64>,
        created_at_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if billing_template_id.is_empty() || provider_id.is_empty()
            || BillingTemplateKind::parse(template_kind).is_none()
            || PricingSource::parse(pricing_source).is_none()
            || effective_to_ms.is_some_and(|end| end < effective_from_ms) {
            return Err(rusqlite::Error::InvalidParameterName(
                "invalid immutable billing template".to_string(),
            ).into());
        }
        let existing: Option<BillingTemplateRow> = self.conn.query_row(
            "SELECT provider_id, account_ref, template_kind, pricing_source, effective_from_ms, effective_to_ms
             FROM billing_templates WHERE billing_template_id = ?1",
            rusqlite::params![billing_template_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).optional()?;
        if let Some(existing) = existing {
            let expected = (provider_id.to_string(), account_ref.map(str::to_string),
                template_kind.to_string(), pricing_source.to_string(), effective_from_ms, effective_to_ms);
            if existing == expected {
                return Ok(false);
            }
            return Err(rusqlite::Error::InvalidParameterName(
                "billing_template_id already names a different immutable template".to_string(),
            ).into());
        }
        let changed = self.conn.execute(
            "INSERT INTO billing_templates(
               billing_template_id, provider_id, account_ref, template_kind, pricing_source,
               effective_from_ms, effective_to_ms, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(billing_template_id) DO NOTHING",
            rusqlite::params![billing_template_id, provider_id, account_ref, template_kind,
                pricing_source, effective_from_ms, effective_to_ms, created_at_ms],
        )?;
        Ok(changed > 0)
    }

    /// 保存模板在一个 catalog 版本下的冻结形态，供历史金额重放使用。
    pub fn billing_template_snapshot_put(
        &self,
        snapshot_id: &str,
        billing_template_id: &str,
        catalog_version: Option<&str>,
        payload_json: &str,
        captured_at_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if snapshot_id.is_empty() || billing_template_id.is_empty() || payload_json.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "template snapshot id, template id, and payload are required".to_string(),
            ).into());
        }
        let existing: Option<(String, Option<String>, String)> = self.conn.query_row(
            "SELECT billing_template_id, catalog_version, payload_json
             FROM billing_template_snapshots WHERE snapshot_id = ?1",
            rusqlite::params![snapshot_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        if let Some(existing) = existing {
            let expected = (billing_template_id.to_string(), catalog_version.map(str::to_string), payload_json.to_string());
            if existing == expected {
                return Ok(false);
            }
            return Err(rusqlite::Error::InvalidParameterName(
                "snapshot_id already names a different immutable template snapshot".to_string(),
            ).into());
        }
        let changed = self.conn.execute(
            "INSERT INTO billing_template_snapshots(
               snapshot_id, billing_template_id, catalog_version, captured_at_ms, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(snapshot_id) DO NOTHING",
            rusqlite::params![snapshot_id, billing_template_id, catalog_version, captured_at_ms, payload_json],
        )?;
        Ok(changed > 0)
    }

    /// 写入一份可复算的 outcome measurement。相同 ID 只能重放完全相同的
    /// 证据，不允许以新算法或新金额覆盖历史 measurement。
    #[allow(clippy::too_many_arguments)]
    pub fn outcome_measurement_put(
        &self,
        measurement_id: &str,
        fact_set_fingerprint: &str,
        algorithm_version: &str,
        basis: &str,
        amount_minor: Option<i64>,
        currency: Option<&str>,
        measured_at_ms: i64,
        payload_json: &str,
    ) -> Result<bool, AuthorityError> {
        if measurement_id.is_empty() || fact_set_fingerprint.is_empty() || algorithm_version.is_empty()
            || !matches!(basis, "estimated" | "actual" | "realized")
            || amount_minor.is_some_and(|amount| amount < 0)
            || (amount_minor.is_some() != currency.is_some())
            || currency.is_some_and(str::is_empty) || payload_json.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "invalid outcome measurement".to_string(),
            ).into());
        }
        let existing: Option<OutcomeMeasurementRow> = self.conn.query_row(
            "SELECT fact_set_fingerprint, algorithm_version, basis, amount_minor, currency, payload_json
             FROM outcome_measurements WHERE measurement_id = ?1",
            rusqlite::params![measurement_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).optional()?;
        if let Some(existing) = existing {
            let expected = (fact_set_fingerprint.to_string(), algorithm_version.to_string(), basis.to_string(),
                amount_minor, currency.map(str::to_string), payload_json.to_string());
            if existing == expected {
                return Ok(false);
            }
            return Err(rusqlite::Error::InvalidParameterName(
                "measurement_id already names a different immutable outcome".to_string(),
            ).into());
        }
        let changed = self.conn.execute(
            "INSERT INTO outcome_measurements(
               measurement_id, fact_set_fingerprint, algorithm_version, basis, amount_minor,
               currency, measured_at_ms, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![measurement_id, fact_set_fingerprint, algorithm_version, basis,
                amount_minor, currency, measured_at_ms, payload_json],
        )?;
        Ok(changed > 0)
    }

    /// 写入 Savings 记录。estimated 永远不能被写作 actual/realized；后两者
    /// 必须引用同口径 measurement，防止 API 价差伪装成已实现节省。
    #[allow(clippy::too_many_arguments)]
    pub fn savings_record_put(
        &self,
        savings_id: &str,
        measurement_id: &str,
        billing_template_snapshot_id: Option<&str>,
        pricing_version: Option<&str>,
        amount_minor: i64,
        currency: &str,
        savings_basis: &str,
        created_at_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if savings_id.is_empty() || measurement_id.is_empty() || amount_minor < 0 || currency.is_empty()
            || !matches!(savings_basis, "estimated" | "actual" | "realized") {
            return Err(rusqlite::Error::InvalidParameterName("invalid savings record".to_string()).into());
        }
        let measurement_basis: Option<String> = self.conn.query_row(
            "SELECT basis FROM outcome_measurements WHERE measurement_id = ?1",
            rusqlite::params![measurement_id], |r| r.get(0),
        ).optional()?;
        let Some(measurement_basis) = measurement_basis else {
            return Err(rusqlite::Error::InvalidParameterName("savings measurement does not exist".to_string()).into());
        };
        if savings_basis != "estimated" && measurement_basis != savings_basis {
            return Err(rusqlite::Error::InvalidParameterName(
                "actual or realized savings require an equally evidenced measurement".to_string(),
            ).into());
        }
        let existing = self.conn.query_row(
            "SELECT measurement_id, billing_template_snapshot_id, pricing_version,
                    amount_minor, currency, savings_basis
             FROM savings_records WHERE savings_id = ?1",
            rusqlite::params![savings_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        ).optional()?;
        if let Some(existing) = existing {
            let incoming = (measurement_id.to_string(), billing_template_snapshot_id.map(str::to_string),
                pricing_version.map(str::to_string), amount_minor, currency.to_string(), savings_basis.to_string());
            if existing == incoming {
                return Ok(false);
            }
            return Err(rusqlite::Error::InvalidParameterName(
                "savings_id already names a different immutable savings record".to_string(),
            ).into());
        }
        let changed = self.conn.execute(
            "INSERT INTO savings_records(
               savings_id, measurement_id, billing_template_snapshot_id, pricing_version,
               amount_minor, currency, savings_basis, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(savings_id) DO NOTHING",
            rusqlite::params![savings_id, measurement_id, billing_template_snapshot_id,
                pricing_version, amount_minor, currency, savings_basis, created_at_ms],
        )?;
        Ok(changed > 0)
    }

    // ─────── v0.9.1 Phase 2.8：harness_bills（spec §5.3 显式管理 API）───────
    // 执行环境自身账单（WorkBuddy 积分、订阅月费、中转对账单…）——**不是**从我们
    // 的价卡派生，由用户显式录入，更新必须验证币种/账期/金额范围（§5.3）。

    /// 录一条执行环境账单。`bill_id` = `{harness}:{provider}:{period}:{basis}:{evidence_ref}`
    /// 的稳定构造（调用方给），同键 upsert（更正金额）。`amount_minor` 最小
    /// 货币单位整数（¥1.00 = 100）。校验：period `YYYY-MM`、basis 五档之一、
    /// amount_minor ≥ 0、currency 非空——不合格 `Err`（不猜不默认）。
    ///
    /// `evidence_ref` 是 `&str` 而不是 `Option`——空串就是"没有凭证引用"，**绝不存
    /// NULL**：SQLite 的 UNIQUE 里 NULL 互不相等，NULL 的 evidence_ref 会让
    /// `ON CONFLICT` 落空、同一 bill_id 第二次录入撞 PRIMARY KEY 报错而不是 upsert
    /// （`bill_id` 构造里的 `{evidence_ref}` 段同样是空串，两侧对齐）。
    #[allow(clippy::too_many_arguments)]
    pub fn harness_bill_put(
        &self,
        bill_id: &str,
        harness: &str,
        provider_id: &str,
        billing_period: &str,
        billing_basis: &str,
        amount_minor: i64,
        currency: &str,
        evidence_ref: &str,
        now_ms: i64,
    ) -> Result<(), AuthorityError> {
        let bad =
            |m: &str| AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(m.to_string()));
        if billing_period.len() != 7
            || billing_period.as_bytes()[4] != b'-'
            || !billing_period[..4].bytes().all(|c| c.is_ascii_digit())
            || !billing_period[5..].bytes().all(|c| c.is_ascii_digit())
        {
            return Err(bad("billing_period must be YYYY-MM"));
        }
        if !matches!(
            billing_basis,
            "fixed_subscription"
                | "harness_billed"
                | "metered_actual"
                | "metered_estimate"
                | "api_equivalent"
        ) {
            return Err(bad("billing_basis not in the five-basis vocabulary"));
        }
        if amount_minor < 0 {
            return Err(bad("amount_minor must be >= 0"));
        }
        if currency.len() != 3 || !currency.bytes().all(|c| c.is_ascii_uppercase()) {
            return Err(bad("currency must be a three-letter uppercase code"));
        }
        self.conn.execute(
            "INSERT INTO harness_bills(bill_id, harness, provider_id, billing_period, billing_basis,
                 amount_minor, currency, evidence_ref, created_at_ms, updated_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
             ON CONFLICT(harness, provider_id, billing_period, billing_basis, evidence_ref) DO UPDATE SET
                 amount_minor = excluded.amount_minor, currency = excluded.currency,
                 updated_at_ms = excluded.updated_at_ms, deleted_at_ms = NULL",
            rusqlite::params![
                bill_id, harness, provider_id, billing_period, billing_basis,
                amount_minor, currency, evidence_ref, now_ms
            ],
        )?;
        Ok(())
    }

    /// 某账期的所有活账单行 `(harness, provider_id, basis, amount_minor, currency)`。
    pub fn harness_bills_for_period(
        &self,
        billing_period: &str,
    ) -> Result<Vec<HarnessBillRow>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT harness, provider_id, billing_basis, amount_minor, currency FROM harness_bills
             WHERE billing_period = ?1 AND deleted_at_ms IS NULL
             ORDER BY harness, provider_id, billing_basis",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![billing_period], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 带稳定 bill_id/evidence 的账单明细，供设置页更正或 soft-delete；
    /// 汇总仍使用上面的五列投影，避免把内部 id 扩散到旧 DTO。
    pub fn harness_bill_details_for_period(
        &self, billing_period: &str,
    ) -> Result<Vec<HarnessBillDetailRow>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT bill_id, harness, provider_id, billing_basis, amount_minor, currency, evidence_ref
             FROM harness_bills WHERE billing_period = ?1 AND deleted_at_ms IS NULL
             ORDER BY harness, provider_id, billing_basis, bill_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![billing_period], |r| Ok((
            r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
        )))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// soft delete（查询默认过滤 `deleted_at_ms IS NULL`）。
    pub fn harness_bill_delete(&self, bill_id: &str, now_ms: i64) -> Result<bool, AuthorityError> {
        let n = self.conn.execute(
            "UPDATE harness_bills SET deleted_at_ms = ?2 WHERE bill_id = ?1 AND deleted_at_ms IS NULL",
            rusqlite::params![bill_id, now_ms],
        )?;
        Ok(n > 0)
    }

    pub fn harness_bill_count(&self) -> Result<i64, AuthorityError> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM harness_bills WHERE deleted_at_ms IS NULL",
            [],
            |r| r.get(0),
        )?)
    }

    /// 写入或更正本地计费声明。声明从不创建 `harness_bills`，也不改写 facts。
    #[allow(clippy::too_many_arguments)]
    pub fn billing_declaration_put(
        &self, declaration_id: &str, provider_id: &str, relationship_kind: &str,
        subscription_name: Option<&str>, amount_minor: Option<i64>, currency: Option<&str>,
        effective_start: &str, effective_end: Option<&str>, source_candidate_id: Option<&str>,
        evidence_ref: Option<&str>, now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        // "Still uncertain" is a review decision, not a billing relationship.
        // Keep its candidate pending instead of publishing a misleading revision.
        let valid_kind = matches!(relationship_kind,
            "official_subscription" | "official_api" | "third_party" | "organization");
        let valid_amount = match (amount_minor, currency) {
            (None, None) => true,
            (Some(amount), Some(currency)) => amount >= 0 && !currency.trim().is_empty(),
            _ => false,
        };
        if declaration_id.is_empty() || provider_id.is_empty() || !valid_kind
            || !valid_amount || !valid_billing_boundary(effective_start)
            || effective_end.is_some_and(|end| {
                !valid_billing_boundary(end)
                    || billing_boundary_date(end, true) < billing_boundary_date(effective_start, false)
            })
        {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid billing declaration".to_string(),
            )));
        }
        if let Some(candidate_id) = source_candidate_id {
            // 候选是某个执行环境配置里发现的线索（执行环境只是证据来源）；声明属于服务商，只比对服务商。
            let candidate = self.conn.query_row(
                "SELECT provider_id, status FROM billing_import_candidates WHERE candidate_id = ?1",
                rusqlite::params![candidate_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            ).optional()?;
            if !matches!(candidate, Some((ref candidate_provider, ref status))
                if candidate_provider == provider_id && status == "accepted")
            {
                return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                    "billing declaration candidate must be accepted and match the provider".to_string(),
                )));
            }
        }
        let changed = self.conn.execute(
            "INSERT INTO billing_declarations(
                 declaration_id, harness, provider_id, relationship_kind, subscription_name,
                 amount_minor, currency, effective_start, effective_end, source_candidate_id,
                 evidence_ref, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
             ON CONFLICT(declaration_id) DO UPDATE SET
               harness = excluded.harness, provider_id = excluded.provider_id,
               relationship_kind = excluded.relationship_kind,
               subscription_name = excluded.subscription_name, amount_minor = excluded.amount_minor,
               currency = excluded.currency, effective_start = excluded.effective_start,
               effective_end = excluded.effective_end, source_candidate_id = excluded.source_candidate_id,
               evidence_ref = excluded.evidence_ref, updated_at_ms = excluded.updated_at_ms,
               deleted_at_ms = NULL",
            rusqlite::params![declaration_id, ALL_HARNESSES, provider_id, relationship_kind,
                subscription_name, amount_minor, currency, effective_start, effective_end,
                source_candidate_id, evidence_ref, now_ms],
        )?;
        Ok(changed > 0)
    }

    /// 活跃声明的稳定读取顺序；金额缺失保持 `None`，不以 0 或价卡代替。
    /// 有效声明里记录的结算币种：`provider` → 币种。来自当前 saved 修订的
    /// `settlement` 作用域行（按量/中转声明的结算币）；同服务商多条按修订创建时间取最新。
    pub fn declared_settlement_currencies(&self) -> Result<std::collections::BTreeMap<String, String>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT bd.provider_id, s.scope_value
             FROM billing_declarations bd
             JOIN billing_declaration_revisions br ON br.declaration_id = bd.declaration_id
             JOIN billing_recalculation_jobs bj ON bj.revision_id = br.revision_id AND bj.status = 'succeeded'
             JOIN billing_declaration_scopes s ON s.revision_id = br.revision_id
             WHERE bd.deleted_at_ms IS NULL AND br.change_kind = 'saved'
               AND s.scope_kind = 'settlement'
               AND br.revision_number = (SELECT MAX(br2.revision_number)
                   FROM billing_declaration_revisions br2
                   LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
                   WHERE br2.declaration_id = bd.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
             ORDER BY br.created_at_ms",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = std::collections::BTreeMap::new();
        for row in rows {
            let (provider, currency) = row?;
            out.insert(provider, currency);
        }
        Ok(out)
    }

    /// 该服务商的用量最多出现在哪个执行环境（事实数最多；并列取字典序小的）。没有用量 → `None`。
    ///
    /// 只用于**展示归位**：账号级的月费（订阅）不属于任何执行环境，但汇总的 `by_provider` 键是
    /// `执行环境/服务商`，需要给它挑一个落点，选用量最集中的那个，月费就和该服务商的用量排在一起。
    /// 不参与任何匹配或计价。
    pub fn dominant_harness_of_provider(&self, provider_id: &str) -> Result<Option<String>, AuthorityError> {
        Ok(self.conn.query_row(
            "SELECT harness FROM usage_facts WHERE provider_id = ?1 AND deleted_at_ms IS NULL
             GROUP BY harness ORDER BY COUNT(*) DESC, harness LIMIT 1",
            rusqlite::params![provider_id], |row| row.get(0),
        ).optional()?)
    }

    pub fn billing_declarations(&self) -> Result<Vec<BillingDeclarationRow>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT declaration_id, provider_id, relationship_kind, subscription_name,
                    amount_minor, currency, effective_start, effective_end, source_candidate_id
             FROM billing_declarations WHERE deleted_at_ms IS NULL
             ORDER BY provider_id, effective_start, declaration_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((
            r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
            r.get(7)?, r.get(8)?,
        )))?.collect::<Result<Vec<_>, _>>().map_err(AuthorityError::from);
        rows
    }

    /// 释放被**已撤销**声明占住的旧资产候选。
    ///
    /// `billing_declarations.source_candidate_id` 上有 UNIQUE 约束，而 SQLite 的
    /// UNIQUE **对软删行照样生效**——撤销只置 `deleted_at_ms` 的话，那张候选就被一条
    /// 看不见的行永久锁住，用户再也声明不了它。2026-09-16 真机就是这个：撤销
    /// claude-code/anthropic 后重新声明同一张旧套餐记录 →
    /// `保存失败：authority sqlite: UNIQUE constraint failed:
    /// billing_declarations.source_candidate_id`。
    ///
    /// **撤销是不再生效，不是放弃这张候选**，所以候选回到 `pending`（可以重新确认，
    /// 也可以走「这不是我的套餐」→ dismissed，那是另一条路）。声明侧的溯源不丢：
    /// `billing_declaration_revisions.source_candidate_id` 没有 UNIQUE、逐条留痕，
    /// 撤销修订本身就是带着它写进去的。
    fn release_revoked_candidate_claims(&self, candidate_id: &str) -> Result<(), AuthorityError> {
        self.conn.execute(
            "UPDATE billing_declarations SET source_candidate_id = NULL
             WHERE source_candidate_id = ?1 AND deleted_at_ms IS NOT NULL",
            rusqlite::params![candidate_id],
        )?;
        // 只有在**没有**有效声明还占着它时才放回 pending——保存路径也会先经过这里，
        // 若一条有效声明仍持有该候选，把它翻成 pending 就制造了上面说的分裂态。
        self.conn.execute(
            "UPDATE billing_import_candidates SET status = 'pending', resolved_at_ms = NULL
             WHERE candidate_id = ?1 AND status = 'accepted'
               AND NOT EXISTS (SELECT 1 FROM billing_declarations bd
                   WHERE bd.source_candidate_id = ?1 AND bd.deleted_at_ms IS NULL)",
            rusqlite::params![candidate_id],
        )?;
        Ok(())
    }

    /// 保存一个追加式声明修订。作用范围只能缩小到已指定的账户、路由、模型或
    /// 会话；空范围表示仅由声明本身的执行环境/provider/有效期约束，绝不扩大历史。
    #[allow(clippy::too_many_arguments)]
    pub fn billing_declaration_revision_save(
        &self, revision_id: &str, declaration_id: &str, supersedes_revision_id: Option<&str>,
        provider_id: &str, relationship_kind: &str, subscription_name: Option<&str>,
        amount_minor: Option<i64>, currency: Option<&str>, effective_start: &str,
        effective_end: Option<&str>, source_candidate_id: Option<&str>, evidence_ref: Option<&str>,
        scopes: &[(&str, &str)], now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        let valid_kind = matches!(relationship_kind,
            "official_subscription" | "official_api" | "third_party" | "organization");
        let valid_amount = match (amount_minor, currency) {
            (None, None) => true,
            (Some(amount), Some(value)) => amount >= 0 && !value.trim().is_empty(),
            _ => false,
        };
        // `settlement` 不是匹配条件，是声明的**结算币种**（按量/中转声明没有月费栏，
        // 而 `amount_minor`/`currency` 成对的 CHECK 不允许只填币种）。与
        // `provider=unresolved` 同一类「挂在作用域表上的声明属性」；选择谓词只认
        // account/route/model/session/provider，其余 kind 自动忽略。
        let valid_scope = |kind: &str, value: &str| {
            (matches!(kind, "account" | "route" | "model" | "session") && !value.trim().is_empty())
                || (kind == "provider" && value == "unresolved")
                || (kind == "settlement" && matches!(value, "CNY" | "USD"))
        };
        if revision_id.is_empty() || declaration_id.is_empty() || provider_id.is_empty()
            || !valid_kind || !valid_amount || !valid_billing_boundary(effective_start)
            || effective_end.is_some_and(|end| {
                !valid_billing_boundary(end)
                    || billing_boundary_date(end, true) < billing_boundary_date(effective_start, false)
            })
            || scopes.iter().any(|(kind, value)| !valid_scope(kind, value))
        {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid billing declaration revision".to_string(),
            )));
        }
        let mut seen_scopes = std::collections::HashSet::new();
        if scopes.iter().any(|(kind, value)| !seen_scopes.insert((*kind, *value))) {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "duplicate billing declaration scope".to_string(),
            )));
        }
        if is_unbounded_unresolved(scopes) {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "a provider=unresolved declaration needs a model, route, account or session scope".to_string(),
            )));
        }
        let mark = begin_immediate(&self.conn)?;
        let result = (|| -> Result<bool, AuthorityError> {
            let exists: Option<i64> = self.conn.query_row(
                "SELECT 1 FROM billing_declaration_revisions WHERE revision_id = ?1",
                rusqlite::params![revision_id], |row| row.get(0),
            ).optional()?;
            if exists.is_some() {
                return Ok(false);
            }
            if let Some(candidate_id) = source_candidate_id {
                // 撤销过的声明不该继续占着这张候选（见 `release_revoked_candidate_claims`）：
                // 先释放它，再按「一张候选只归一条**有效**声明」的约束往下走。
                self.release_revoked_candidate_claims(candidate_id)?;
                let candidate = self.conn.query_row(
                    "SELECT provider_id, status FROM billing_import_candidates WHERE candidate_id = ?1",
                    rusqlite::params![candidate_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                ).optional()?;
                let Some((candidate_provider, status)) = candidate else {
                    return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "billing declaration candidate must be accepted and match the provider".to_string(),
                    )));
                };
                if candidate_provider != provider_id
                    || !matches!(status.as_str(), "pending" | "accepted")
                {
                    return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "billing declaration candidate must be pending/accepted and match the provider".to_string(),
                    )));
                }
                // 同一张候选被两条**有效**声明同时占用是约束本身要挡的（一张旧套餐记录
                // 只对应一条声明）。这里先判一次只为把话说清楚——不然用户看到的是裸的
                // `UNIQUE constraint failed: billing_declarations.source_candidate_id`。
                let claimed: Option<String> = self.conn.query_row(
                    "SELECT declaration_id FROM billing_declarations
                     WHERE source_candidate_id = ?1 AND deleted_at_ms IS NULL AND declaration_id <> ?2
                     LIMIT 1",
                    rusqlite::params![candidate_id, declaration_id], |row| row.get(0),
                ).optional()?;
                if claimed.is_some() {
                    return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "this legacy package record is already used by another live declaration; revoke that one first".to_string(),
                    )));
                }
                if status == "pending" {
                    self.conn.execute(
                        "UPDATE billing_import_candidates
                         SET status = 'accepted', resolved_at_ms = ?2, updated_at_ms = ?2
                         WHERE candidate_id = ?1 AND status = 'pending'",
                        rusqlite::params![candidate_id, now_ms],
                    )?;
                }
            }
            let previous: Option<(String, i64)> = self.conn.query_row(
                "SELECT revision_id, revision_number FROM billing_declaration_revisions
                 WHERE declaration_id = ?1 ORDER BY revision_number DESC LIMIT 1",
                rusqlite::params![declaration_id], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            // 重复保存守卫：新声明（没有前一修订）与某条**现行**声明在服务商 / 关系 / 套餐 / 金额 / 币种 /
            // 起止 / 作用域上完全一致 → 不再新建（连点两次保存曾留下两条一模一样的 minimax 声明，各自又
            // 归因了同一批 3192 条事实）。返回 `false`（与「修订已存在」同一个幂等语义）。
            if previous.is_none() && source_candidate_id.is_none()
                && self.billing_identical_live_declaration(
                    provider_id, relationship_kind, subscription_name, amount_minor, currency,
                    effective_start, effective_end, scopes,
                )?
            {
                return Ok(false);
            }
            let revision_number = match previous {
                Some((ref current, number)) if supersedes_revision_id == Some(current.as_str()) => number + 1,
                Some(_) => return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                    "billing declaration revision must supersede the current revision".to_string(),
                ))),
                None if supersedes_revision_id.is_none() => 1,
                None => return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                    "first billing declaration revision cannot supersede another revision".to_string(),
                ))),
            };
            self.conn.execute(
                "INSERT INTO billing_declarations(
                     declaration_id, harness, provider_id, relationship_kind, subscription_name,
                     amount_minor, currency, effective_start, effective_end, source_candidate_id,
                     evidence_ref, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
                 ON CONFLICT(declaration_id) DO UPDATE SET
                   harness = excluded.harness, provider_id = excluded.provider_id,
                   relationship_kind = excluded.relationship_kind, subscription_name = excluded.subscription_name,
                   amount_minor = excluded.amount_minor, currency = excluded.currency,
                   effective_start = excluded.effective_start, effective_end = excluded.effective_end,
                   source_candidate_id = excluded.source_candidate_id, evidence_ref = excluded.evidence_ref,
                   updated_at_ms = excluded.updated_at_ms, deleted_at_ms = NULL",
                rusqlite::params![declaration_id, ALL_HARNESSES, provider_id, relationship_kind,
                    subscription_name, amount_minor, currency, effective_start, effective_end,
                    source_candidate_id, evidence_ref, now_ms],
            )?;
            self.conn.execute(
                "INSERT INTO billing_declaration_revisions(
                     revision_id, declaration_id, revision_number, change_kind, supersedes_revision_id,
                     harness, provider_id, relationship_kind, subscription_name, amount_minor, currency,
                     effective_start, effective_end, source_candidate_id, evidence_ref, created_at_ms)
                 VALUES (?1, ?2, ?3, 'saved', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                rusqlite::params![revision_id, declaration_id, revision_number, supersedes_revision_id,
                    ALL_HARNESSES, provider_id, relationship_kind, subscription_name, amount_minor, currency,
                    effective_start, effective_end, source_candidate_id, evidence_ref, now_ms],
            )?;
            for (scope_kind, scope_value) in scopes {
                self.conn.execute(
                    "INSERT INTO billing_declaration_scopes(revision_id, scope_kind, scope_value)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![revision_id, scope_kind, scope_value],
                )?;
            }
            Ok(true)
        })();
        match result {
            Ok(changed) => { commit_advancing_revision(&self.conn, mark)?; Ok(changed) }
            Err(error) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(error) }
        }
    }

    /// 是否已有一条现行声明与给定内容完全一致（见 [`Self::billing_declaration_revision_save`] 的重复保存守卫）。
    #[allow(clippy::too_many_arguments)]
    fn billing_identical_live_declaration(
        &self, provider_id: &str, relationship_kind: &str, subscription_name: Option<&str>,
        amount_minor: Option<i64>, currency: Option<&str>, effective_start: &str,
        effective_end: Option<&str>, scopes: &[(&str, &str)],
    ) -> Result<bool, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT br.revision_id FROM billing_declarations bd
             JOIN billing_declaration_revisions br ON br.declaration_id = bd.declaration_id
             WHERE bd.deleted_at_ms IS NULL AND bd.provider_id = ?1 AND bd.relationship_kind = ?2
               AND IFNULL(bd.subscription_name, '') = IFNULL(?3, '')
               AND IFNULL(bd.amount_minor, -1) = IFNULL(?4, -1) AND IFNULL(bd.currency, '') = IFNULL(?5, '')
               AND bd.effective_start = ?6 AND IFNULL(bd.effective_end, '') = IFNULL(?7, '')
               AND br.change_kind = 'saved'
               AND br.revision_number = (SELECT MAX(x.revision_number)
                   FROM billing_declaration_revisions x WHERE x.declaration_id = bd.declaration_id)",
        )?;
        let candidates = stmt.query_map(
            rusqlite::params![provider_id, relationship_kind, subscription_name, amount_minor, currency,
                effective_start, effective_end],
            |row| row.get::<_, String>(0),
        )?.collect::<Result<Vec<_>, _>>()?;
        let wanted: std::collections::BTreeSet<(String, String)> = scopes.iter()
            .map(|(kind, value)| (kind.to_string(), value.to_string())).collect();
        for revision_id in candidates {
            let existing: std::collections::BTreeSet<(String, String)> = self.billing_declaration_scopes(&revision_id)?
                .into_iter().map(|(_, kind, value)| (kind, value)).collect();
            if existing == wanted {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 撤销不删除声明历史：追加 `revoked` 修订，复制最近范围，并使当前态失效。
    pub fn billing_declaration_revision_revoke(
        &self, revision_id: &str, declaration_id: &str, supersedes_revision_id: &str, now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if revision_id.is_empty() || declaration_id.is_empty() || supersedes_revision_id.is_empty() {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid billing declaration revoke".to_string(),
            )));
        }
        let mark = begin_immediate(&self.conn)?;
        let result = (|| -> Result<bool, AuthorityError> {
            let exists: Option<i64> = self.conn.query_row(
                "SELECT 1 FROM billing_declaration_revisions WHERE revision_id = ?1",
                rusqlite::params![revision_id], |row| row.get(0),
            ).optional()?;
            if exists.is_some() { return Ok(false); }
            let prior: Option<BillingDeclarationRevisionSnapshot> = self.conn.query_row(
                "SELECT revision_number, harness, provider_id, relationship_kind, subscription_name,
                        amount_minor, currency, effective_start, effective_end, source_candidate_id, evidence_ref
                 FROM billing_declaration_revisions
                 WHERE revision_id = ?1 AND declaration_id = ?2 AND change_kind = 'saved'",
                rusqlite::params![supersedes_revision_id, declaration_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                    row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?)),
            ).optional()?;
            let Some((number, harness, provider_id, relationship_kind, subscription_name, amount_minor, currency,
                effective_start, effective_end, source_candidate_id, evidence_ref)) = prior else {
                return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                    "billing declaration revoke must supersede the active revision".to_string(),
                )));
            };
            // 撤销要释放它占的旧资产候选；下面写撤销修订时会把 `source_candidate_id`
            // 移进参数列表，所以先留一份。
            let revoked_candidate_id = source_candidate_id.clone();
            let current: Option<String> = self.conn.query_row(
                "SELECT revision_id FROM billing_declaration_revisions WHERE declaration_id = ?1
                 ORDER BY revision_number DESC LIMIT 1", rusqlite::params![declaration_id], |row| row.get(0),
            ).optional()?;
            if current.as_deref() != Some(supersedes_revision_id) {
                return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                    "billing declaration revoke must supersede the current revision".to_string(),
                )));
            }
            self.conn.execute(
                "INSERT INTO billing_declaration_revisions(
                     revision_id, declaration_id, revision_number, change_kind, supersedes_revision_id,
                     harness, provider_id, relationship_kind, subscription_name, amount_minor, currency,
                     effective_start, effective_end, source_candidate_id, evidence_ref, created_at_ms)
                 VALUES (?1, ?2, ?3, 'revoked', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                rusqlite::params![revision_id, declaration_id, number + 1, supersedes_revision_id,
                    harness, provider_id, relationship_kind, subscription_name, amount_minor, currency,
                    effective_start, effective_end, source_candidate_id, evidence_ref, now_ms],
            )?;
            self.conn.execute(
                "INSERT INTO billing_declaration_scopes(revision_id, scope_kind, scope_value)
                 SELECT ?1, scope_kind, scope_value FROM billing_declaration_scopes WHERE revision_id = ?2",
                rusqlite::params![revision_id, supersedes_revision_id],
            )?;
            self.conn.execute(
                "UPDATE billing_declarations SET deleted_at_ms = ?2, updated_at_ms = ?2
                 WHERE declaration_id = ?1 AND deleted_at_ms IS NULL",
                rusqlite::params![declaration_id, now_ms],
            )?;
            // 撤销必须**释放**它占的旧资产候选——`source_candidate_id` 上的 UNIQUE 对软删
            // 行照样生效，只置 `deleted_at_ms` 会把那张候选永久锁在一条看不见的行上
            // （见 `release_revoked_candidate_claims` 的注释）。
            if let Some(candidate_id) = revoked_candidate_id.as_deref() {
                self.release_revoked_candidate_claims(candidate_id)?;
            }
            Ok(true)
        })();
        match result {
            Ok(changed) => { commit_advancing_revision(&self.conn, mark)?; Ok(changed) }
            Err(error) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(error) }
        }
    }

    pub fn billing_declaration_revisions(
        &self, declaration_id: &str,
    ) -> Result<Vec<BillingDeclarationRevisionRow>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT revision_id, declaration_id, revision_number, change_kind, supersedes_revision_id,
                    harness, provider_id, relationship_kind, subscription_name, amount_minor, currency,
                    effective_start, effective_end, source_candidate_id, evidence_ref, created_at_ms
             FROM billing_declaration_revisions WHERE declaration_id = ?1 ORDER BY revision_number",
        )?;
        let rows = stmt.query_map(rusqlite::params![declaration_id], |row| Ok((
            row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
            row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?,
            row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?,
        )))?.collect::<Result<Vec<_>, _>>().map_err(AuthorityError::from);
        rows
    }

    pub fn billing_declaration_scopes(
        &self, revision_id: &str,
    ) -> Result<Vec<BillingDeclarationScopeRow>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT revision_id, scope_kind, scope_value FROM billing_declaration_scopes
             WHERE revision_id = ?1 ORDER BY scope_kind, scope_value",
        )?;
        let rows = stmt.query_map(rusqlite::params![revision_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?.collect::<Result<Vec<_>, _>>().map_err(AuthorityError::from);
        rows
    }

    /// 只读计算声明修订将触及哪些事实；不写任何派生结果。`window` 只给
    /// 「本月涉及」一类展示用；预览与重算（`None`）都走声明自己的有效期。
    pub fn billing_declaration_impact_preview(
        &self, revision_id: &str, window: Option<(i64, i64)>,
    ) -> Result<BillingDeclarationImpactPreview, AuthorityError> {
        let revision: Option<(String, String, String, Option<String>, String)> = self.conn.query_row(
            "SELECT provider_id, effective_start, change_kind, effective_end, relationship_kind
             FROM billing_declaration_revisions WHERE revision_id = ?1",
            rusqlite::params![revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        let Some((provider_id, effective_start, change_kind, effective_end, relationship_kind)) = revision else {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "unknown billing declaration revision".to_string(),
            )));
        };
        if change_kind == "revoked" {
            return Ok(BillingDeclarationImpactPreview::default());
        }
        let scopes = self.billing_declaration_scopes(revision_id)?;
        let scope_refs = scopes.iter()
            .map(|(_, kind, value)| (kind.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        self.billing_declaration_impact_preview_for_kind(
            &provider_id, &relationship_kind, &effective_start, effective_end.as_deref(), &scope_refs, window,
        )
    }

    /// Preview a prospective declaration before it is persisted. This is the
    /// dry-run counterpart to `billing_declaration_impact_preview`: the UI can
    /// show the affected facts/sessions/tokens before accepting a candidate,
    /// without creating a saved revision or changing candidate status.
    ///
    /// 与 [`Self::billing_declaration_matching_fact_ids`] 共用
    /// [`billing_declaration_fact_selection`]——预览命中的事实集合就是重算会归因的
    /// 集合，这是计费主链规格 R1 钉住的不变量（此前预览按前端传入的统计月窗口、
    /// 重算按全历史，两者对不上）。
    pub fn billing_declaration_impact_preview_for(
        &self, provider_id: &str, effective_start: &str,
        effective_end: Option<&str>, scopes: &[(&str, &str)], window: Option<(i64, i64)>,
    ) -> Result<BillingDeclarationImpactPreview, AuthorityError> {
        self.billing_declaration_impact_preview_native(provider_id, effective_start, effective_end, scopes, window, false)
    }

    #[allow(clippy::too_many_arguments)]
    fn billing_declaration_impact_preview_native(
        &self, provider_id: &str, effective_start: &str,
        effective_end: Option<&str>, scopes: &[(&str, &str)], window: Option<(i64, i64)>, native: bool,
    ) -> Result<BillingDeclarationImpactPreview, AuthorityError> {
        if window.is_some_and(|(start, end)| end <= start) {
            return Ok(BillingDeclarationImpactPreview::default());
        }
        let aggregate = |conflicts: ConflictEvidence| -> Result<PreviewAggregate, AuthorityError> {
            let selection = billing_declaration_fact_selection_with(
                provider_id, effective_start, effective_end, scopes, window, conflicts, native,
            );
            let sql = format!(
                "SELECT COUNT(*), COUNT(DISTINCT f.session_key),
                        COALESCE(SUM(f.uncached_input_tokens + f.cache_read_tokens
                            + f.cache_write_tokens + f.output_tokens), 0),
                        MIN(f.event_ts_ms), MAX(f.event_ts_ms)
                 {BILLING_DECLARATION_FACT_FROM} WHERE {}",
                selection.where_sql,
            );
            Ok(self.conn.query_row(
                &sql, rusqlite::params_from_iter(selection.params.iter()),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )?)
        };
        let (fact_count, session_count, total_tokens, first, last) = aggregate(ConflictEvidence::Exclude)?;
        let (conflict_fact_count, _, conflict_tokens, _, _) = aggregate(ConflictEvidence::Only)?;
        Ok(BillingDeclarationImpactPreview {
            fact_count, session_count, total_tokens,
            first_event_ts_ms: first, last_event_ts_ms: last,
            conflict_fact_count, conflict_tokens,
        })
    }

    /// 该服务商是否存在**生效中**的官方 API 声明（最新修订是 `saved`），**不分执行环境**：
    /// 官方订阅是账号级的，API Key 同样可能在任何执行环境上使用，两者并存时用量无从区分，
    /// 默认覆盖规则让位给显式范围，见 [`default_coverage`]。
    pub fn billing_official_api_declared(&self, provider_id: &str) -> Result<bool, AuthorityError> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (
                 SELECT 1 FROM billing_declarations bd
                 JOIN billing_declaration_revisions br ON br.declaration_id = bd.declaration_id
                 WHERE bd.deleted_at_ms IS NULL AND br.provider_id = ?1
                   AND br.relationship_kind = 'official_api' AND br.change_kind = 'saved'
                   AND br.revision_number = (SELECT MAX(x.revision_number)
                       FROM billing_declaration_revisions x WHERE x.declaration_id = bd.declaration_id))",
            rusqlite::params![provider_id], |row| row.get::<_, i64>(0),
        )? != 0)
    }

    /// 带关系种类的前瞻预览：先经 [`attribution_scopes`] 再算，与重算 / 持续套用同口径。
    #[allow(clippy::too_many_arguments)] // SQL 投影参数天然展开；收拢结构体反而遮蔽与 _native 的参数对应
    pub fn billing_declaration_impact_preview_for_kind(
        &self, provider_id: &str, relationship_kind: &str, effective_start: &str,
        effective_end: Option<&str>, scopes: &[(&str, &str)], window: Option<(i64, i64)>,
    ) -> Result<BillingDeclarationImpactPreview, AuthorityError> {
        let (effective, native) = default_coverage(relationship_kind, scopes, self.billing_official_api_declared(provider_id)?);
        self.billing_declaration_impact_preview_native(provider_id, effective_start, effective_end, &effective, window, native)
    }

    fn billing_declaration_matching_fact_ids(&self, revision_id: &str) -> Result<Vec<String>, AuthorityError> {
        self.billing_declaration_matching_fact_ids_since(revision_id, None)
    }

    /// 同一条选择谓词，外加「只看 `created_at_ms >= since` 入库的事实」——增量套用
    /// （[`Self::billing_apply_active_declarations`]）用它避免每轮同步全表扫 N 遍。
    /// `since = None` 就是重算 job 的全历史口径。
    fn billing_declaration_matching_fact_ids_since(
        &self, revision_id: &str, since_created_at_ms: Option<i64>,
    ) -> Result<Vec<String>, AuthorityError> {
        let revision: (String, String, Option<String>, String) = self.conn.query_row(
            "SELECT provider_id, effective_start, effective_end, relationship_kind FROM billing_declaration_revisions WHERE revision_id = ?1 AND change_kind = 'saved'",
            rusqlite::params![revision_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let scopes = self.billing_declaration_scopes(revision_id)?;
        let scope_refs = scopes.iter()
            .map(|(_, kind, value)| (kind.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        // 与预览同一个有效范围（默认覆盖规则），否则「预览命中 = 重算归因」的不变量就破了。
        let (effective, native) = default_coverage(&revision.3, &scope_refs, self.billing_official_api_declared(&revision.0)?);
        let mut selection = billing_declaration_fact_selection_with(
            &revision.0, &revision.1, revision.2.as_deref(), &effective, None,
            ConflictEvidence::Exclude, native,
        );
        if let Some(since) = since_created_at_ms {
            selection.params.push(rusqlite::types::Value::Integer(since));
            selection.where_sql.push_str(&format!(" AND f.created_at_ms >= ?{}", selection.params.len()));
        }
        let sql = format!(
            "SELECT f.fact_id {BILLING_DECLARATION_FACT_FROM} WHERE {} ORDER BY f.fact_id",
            selection.where_sql,
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(selection.params.iter()), |row| row.get(0))?;
        rows.collect::<Result<Vec<String>, _>>().map_err(AuthorityError::from)
    }

    /// 修订 → 归因种类：订阅移出按量估算（`subscription_covered`），其余只记「用户已答」
    /// （`user_declared`，D02 不改金额）。重算 job 与增量套用共用，不许各写一份 CASE。
    fn billing_attribution_kind_of(&self, revision_id: &str) -> Result<String, AuthorityError> {
        Ok(self.conn.query_row(
            "SELECT CASE WHEN relationship_kind = 'official_subscription' THEN 'subscription_covered' ELSE 'user_declared' END
             FROM billing_declaration_revisions WHERE revision_id = ?1",
            rusqlite::params![revision_id], |row| row.get(0),
        )?)
    }

    /// **声明是持续生效的规则，不是一次性物化**（2026-09-16 真机）：用户声明了
    /// anthropic 订阅「持续有效」、shengsuanyun 中转「持续有效」，重算 job 只给保存
    /// 那一刻已入库的事实写归因行；之后 `sync-facts` 同步进来的每个新会话都没有
    /// 归因行 → 待确认面板按「无归因行」把同一组再弹一遍，用户以为声明没保存、
    /// 又声明一遍（库里 shengsuanyun 重复到 7 条）。
    ///
    /// 这里在每轮同步末尾把**当前有效**的修订（声明未软删、最新修订 `saved`、其
    /// 重算 job 已 `succeeded`——规则已建立）套用到该修订上次归因之后入库的事实。
    /// 谓词与预览/重算是同一条 `billing_declaration_fact_selection`，只多一个
    /// `created_at_ms` 水位；归因行挂在该修订原来的 job 上（`UNIQUE(revision_id)`
    /// 一修订一 job，job 就是「这条规则」的句柄），`created_at_ms` 记录本次套用时间。
    /// 幂等：`ON CONFLICT DO NOTHING`，水位重叠只会白查不会双写。
    ///
    /// 顺序：订阅修订先于其他——选择谓词只排除 `subscription_covered`，同执行环境同
    /// provider 的订阅与按量声明本不该重叠，但若用户两边都声明了，订阅先占位、按量
    /// 只拿剩下的（与保存顺序无关，结果确定）。
    ///
    /// 有 `effective_end` 的声明照旧到期即止（谓词按事件日界定）；开放期声明覆盖
    /// 之后的事实正是「持续有效」的定义——这条明确取代计费主链规格 §3「事实 3」里
    /// 「retry 会把之后同步进来的事实扫进订阅覆盖」的顾虑：那是 bug 的描述，不是
    /// 需求。
    pub fn billing_apply_active_declarations(
        &self, now_ms: i64,
    ) -> Result<BillingApplyReport, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT br.revision_id, j.job_id, j.completed_at_ms
             FROM billing_declarations bd
             JOIN billing_declaration_revisions br ON br.declaration_id = bd.declaration_id
             JOIN billing_recalculation_jobs j ON j.revision_id = br.revision_id
             WHERE bd.deleted_at_ms IS NULL
               AND br.change_kind = 'saved'
               AND br.revision_number = (SELECT MAX(br2.revision_number)
                   FROM billing_declaration_revisions br2
                   LEFT JOIN billing_recalculation_jobs bj2 ON bj2.revision_id = br2.revision_id AND bj2.status = 'succeeded'
                   WHERE br2.declaration_id = bd.declaration_id AND (br2.change_kind = 'revoked' OR bj2.job_id IS NOT NULL))
               AND j.status = 'succeeded'
             ORDER BY (br.relationship_kind = 'official_subscription') DESC, br.created_at_ms, br.revision_id",
        )?;
        let active: Vec<(String, String, Option<i64>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        let mut report = BillingApplyReport::default();
        for (revision_id, job_id, completed_at_ms) in active {
            // 水位 = 该修订最近一次归因写入时间；从未命中过事实的修订退到 job 完成时间。
            // `>=` 而非 `>`：同一毫秒内入库的事实宁可重查一次，也不能漏。
            let last_applied: Option<i64> = self.conn.query_row(
                "SELECT MAX(created_at_ms) FROM billing_fact_attributions WHERE revision_id = ?1",
                rusqlite::params![revision_id], |row| row.get(0),
            )?;
            // 默认覆盖规则改变了这类修订的选择谓词（不再受模型清单限制），水位之前入库、
            // 却从未被匹配过的新模型事实要补算一次：对这类修订回到 0，之后用标记保证只做一次。
            let catch_up = self.billing_default_scope_needs_catchup(&revision_id)?;
            let since = if catch_up { 0 } else { last_applied.or(completed_at_ms).unwrap_or(0) };
            let fact_ids = self.billing_declaration_matching_fact_ids_since(&revision_id, Some(since))?;
            report.revisions += 1;
            if fact_ids.is_empty() {
                if catch_up { self.billing_mark_default_scope_catchup(&revision_id)?; }
                continue;
            }
            let kind = self.billing_attribution_kind_of(&revision_id)?;
            let mark = begin_immediate(&self.conn)?;
            let inserted = (|| -> Result<usize, rusqlite::Error> {
                let mut n = 0;
                for fact_id in &fact_ids {
                    n += self.conn.execute(
                        "INSERT INTO billing_fact_attributions(fact_id, revision_id, job_id, attribution_kind, created_at_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(fact_id, revision_id) DO NOTHING",
                        rusqlite::params![fact_id, revision_id, job_id, kind, now_ms],
                    )?;
                }
                commit_advancing_revision(&self.conn, mark)?;
                Ok(n)
            })();
            match inserted {
                Ok(n) => report.attributed += n,
                Err(error) => {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
            }
            if catch_up { self.billing_mark_default_scope_catchup(&revision_id)?; }
        }
        Ok(report)
    }

    /// 这条修订的有效范围是否因「默认覆盖规则」而与保存的范围不同、且还没补算过。
    fn billing_default_scope_needs_catchup(&self, revision_id: &str) -> Result<bool, AuthorityError> {
        let key = format!("billing_default_scope_catchup:v2:{revision_id}");
        let done: Option<String> = self.conn.query_row(
            "SELECT value FROM schema_meta WHERE key = ?1", rusqlite::params![key], |row| row.get(0),
        ).optional()?;
        if done.is_some() { return Ok(false); }
        let (provider_id, kind): (String, String) = self.conn.query_row(
            "SELECT provider_id, relationship_kind FROM billing_declaration_revisions WHERE revision_id = ?1",
            rusqlite::params![revision_id], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let scopes = self.billing_declaration_scopes(revision_id)?;
        let scope_refs = scopes.iter().map(|(_, k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>();
        let (effective, native) = default_coverage(&kind, &scope_refs, self.billing_official_api_declared(&provider_id)?);
        Ok(effective.len() != scope_refs.len() || native)
    }

    fn billing_mark_default_scope_catchup(&self, revision_id: &str) -> Result<(), AuthorityError> {
        self.conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
            rusqlite::params![format!("billing_default_scope_catchup:v2:{revision_id}")],
        )?;
        Ok(())
    }

    pub fn billing_recalculation_enqueue(
        &self, job_id: &str, declaration_id: &str, revision_id: &str, now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if job_id.is_empty() || declaration_id.is_empty() || revision_id.is_empty() {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName("invalid recalculation job".to_string())));
        }
        let valid: Option<String> = self.conn.query_row(
            "SELECT change_kind FROM billing_declaration_revisions WHERE revision_id = ?1 AND declaration_id = ?2",
            rusqlite::params![revision_id, declaration_id], |row| row.get(0),
        ).optional()?;
        if valid.as_deref() != Some("saved") {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName("recalculation requires a saved declaration revision".to_string())));
        }
        let changed = self.conn.execute(
            "INSERT INTO billing_recalculation_jobs(job_id, declaration_id, revision_id, status, requested_at_ms)
             VALUES (?1, ?2, ?3, 'queued', ?4) ON CONFLICT(revision_id) DO NOTHING",
            rusqlite::params![job_id, declaration_id, revision_id, now_ms],
        )?;
        Ok(changed > 0)
    }

    pub fn billing_recalculation_set_status(
        &self, job_id: &str, status: &str, error_code: Option<&str>, error_detail: Option<&str>, now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if !matches!(status, "running" | "succeeded" | "failed" | "cancelled") {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName("invalid recalculation status".to_string())));
        }
        let changed = self.conn.execute(
            "UPDATE billing_recalculation_jobs SET status = ?2,
                 started_at_ms = CASE WHEN ?2 = 'running' THEN COALESCE(started_at_ms, ?5) ELSE started_at_ms END,
                 completed_at_ms = CASE WHEN ?2 IN ('succeeded', 'failed', 'cancelled') THEN ?5 ELSE completed_at_ms END,
                 error_code = ?3, error_detail = ?4 WHERE job_id = ?1 AND status IN ('queued', 'running')",
            rusqlite::params![job_id, status, error_code, error_detail, now_ms],
        )?;
        Ok(changed > 0)
    }

    /// 失败或取消的任务可由用户显式重试；成功任务不回退，避免重试按钮
    /// 改写已经发布的结果版本。任务 id 保持不变，结果快照仍可追溯。
    pub fn billing_recalculation_retry(
        &self, job_id: &str, now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        let changed = self.conn.execute(
            "UPDATE billing_recalculation_jobs SET status = 'queued',
                 completed_at_ms = NULL, error_code = NULL, error_detail = NULL,
                 requested_at_ms = ?2
             WHERE job_id = ?1 AND status IN ('failed', 'cancelled')",
            rusqlite::params![job_id, now_ms],
        )?;
        Ok(changed > 0)
    }

    /// 应用重启时恢复任务队列：把上次进程中断的 running 任务标为失败，
    /// 再返回仍待执行的 queued 任务，由执行环境启动 worker。只改变任务状态，
    /// 不触碰事实、结果快照或归因表。
    pub fn billing_recalculation_recover(
        &self, now_ms: i64,
    ) -> Result<Vec<String>, AuthorityError> {
        self.conn.execute(
            "UPDATE billing_recalculation_jobs SET status = 'failed',
                 completed_at_ms = ?1, error_code = COALESCE(error_code, 'interrupted'),
                 error_detail = COALESCE(error_detail, 'worker interrupted by app restart')
             WHERE status = 'running'",
            rusqlite::params![now_ms],
        )?;
        let mut stmt = self.conn.prepare(
            "SELECT job_id FROM billing_recalculation_jobs
             WHERE status = 'queued' ORDER BY requested_at_ms, job_id",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<Result<Vec<String>, _>>().map_err(AuthorityError::from)
    }

    pub fn billing_recalculation_job(
        &self, job_id: &str,
    ) -> Result<Option<BillingRecalculationJobRow>, AuthorityError> {
        Ok(self.conn.query_row(
            "SELECT job_id, declaration_id, revision_id, status, requested_at_ms, started_at_ms,
                    completed_at_ms, error_code, error_detail FROM billing_recalculation_jobs WHERE job_id = ?1",
            rusqlite::params![job_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
        ).optional()?)
    }

    /// 返回尚未成功发布结果的任务，供工作台在重启后显示可恢复状态。
    /// 成功任务不进入此列表，旧结果仍通过 billing_recalculation_result 可查。
    pub fn billing_recalculation_jobs_needing_attention(
        &self,
    ) -> Result<Vec<BillingRecalculationJobRow>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT job_id, declaration_id, revision_id, status, requested_at_ms, started_at_ms,
                    completed_at_ms, error_code, error_detail
             FROM billing_recalculation_jobs
             WHERE status IN ('queued', 'running', 'failed', 'cancelled')
             ORDER BY requested_at_ms, job_id",
        )?;
        let rows = stmt.query_map([], |row| Ok((
            row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
            row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?,
        )))?;
        rows.collect::<Result<Vec<BillingRecalculationJobRow>, _>>().map_err(AuthorityError::from)
    }

    /// 执行一个只读聚合型重算任务并原子发布结果快照；原始 facts 与旧结果不变。
    pub fn billing_recalculation_run(
        &self, job_id: &str, now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        let job = self.billing_recalculation_job(job_id)?;
        let Some((_, _, revision_id, status, _, _, _, _, _)) = job else { return Ok(false); };
        if status != "queued" { return Ok(false); }
        if !self.billing_recalculation_set_status(job_id, "running", None, None, now_ms)? {
            return Ok(false);
        }
        let preview = match self.billing_declaration_impact_preview(&revision_id, None) {
            Ok(value) => value,
            Err(error) => {
                self.billing_recalculation_set_status(job_id, "failed", Some("preview_failed"), Some("impact preview failed"), now_ms)?;
                return Err(error);
            }
        };
        let fact_ids = match self.billing_declaration_matching_fact_ids(&revision_id) {
            Ok(fact_ids) => fact_ids,
            Err(error) => {
                let detail = error.to_string();
                let _ = self.billing_recalculation_set_status(
                    job_id, "failed", Some("fact_match_failed"), Some(&detail), now_ms,
                );
                return Err(error);
            }
        };
        let attribution_kind = match self.billing_attribution_kind_of(&revision_id) {
            Ok(kind) => kind,
            Err(error) => {
                let detail = error.to_string();
                let _ = self.billing_recalculation_set_status(
                    job_id, "failed", Some("attribution_kind_failed"), Some(&detail), now_ms,
                );
                return Err(error);
            }
        };
        let mark = match begin_immediate(&self.conn) {
            Ok(mark) => mark,
            Err(error) => {
                let detail = error.to_string();
                let _ = self.billing_recalculation_set_status(
                    job_id, "failed", Some("transaction_start_failed"), Some(&detail), now_ms,
                );
                return Err(error.into());
            }
        };
        let transaction_result = (|| -> Result<(), rusqlite::Error> {
            self.conn.execute(
                "INSERT INTO billing_recalculation_results(
                     job_id, revision_id, fact_count, session_count, total_tokens,
                     first_event_ts_ms, last_event_ts_ms, published_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(job_id) DO UPDATE SET published_at_ms = excluded.published_at_ms",
                rusqlite::params![job_id, revision_id, preview.fact_count, preview.session_count,
                    preview.total_tokens, preview.first_event_ts_ms, preview.last_event_ts_ms, now_ms],
            )?;
            for fact_id in fact_ids {
                self.conn.execute(
                    "INSERT INTO billing_fact_attributions(fact_id, revision_id, job_id, attribution_kind, created_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(fact_id, revision_id) DO NOTHING",
                    rusqlite::params![fact_id, revision_id, job_id, attribution_kind, now_ms],
                )?;
            }
            self.conn.execute(
                "UPDATE billing_recalculation_jobs SET status = 'succeeded', completed_at_ms = ?2
                 WHERE job_id = ?1 AND status = 'running'", rusqlite::params![job_id, now_ms],
            )?;
            commit_advancing_revision(&self.conn, mark)?;
            Ok(())
        })();
        match transaction_result {
            Ok(()) => Ok(true),
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                let detail = error.to_string();
                let _ = self.billing_recalculation_set_status(
                    job_id, "failed", Some("transaction_failed"), Some(&detail), now_ms,
                );
                Err(error.into())
            }
        }
    }

    pub fn billing_recalculation_result(
        &self, job_id: &str,
    ) -> Result<Option<BillingRecalculationResultRow>, AuthorityError> {
        Ok(self.conn.query_row(
            "SELECT job_id, revision_id, fact_count, session_count, total_tokens,
                    first_event_ts_ms, last_event_ts_ms, published_at_ms
             FROM billing_recalculation_results WHERE job_id = ?1",
            rusqlite::params![job_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        ).optional()?)
    }

    /// 幂等写入一个待确认的旧订阅候选。相同候选不会重复；候选永远不写入
    /// `harness_bills`，必须由上层获得用户确认后另走明确账单写入。
    #[allow(clippy::too_many_arguments)]
    pub fn billing_import_candidate_put(
        &self,
        candidate_id: &str,
        harness: &str,
        provider_id: &str,
        currency: &str,
        amount_minor: i64,
        billing_period_start: &str,
        source_pricing_version: &str,
        now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if candidate_id.is_empty() || harness.is_empty() || provider_id.is_empty()
            || currency.trim().is_empty() || amount_minor < 0
            || billing_period_start.len() != 7 || source_pricing_version.is_empty()
        {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "invalid billing import candidate".to_string(),
            )));
        }
        let changed = self.conn.execute(
            "INSERT INTO billing_import_candidates(
                 candidate_id, harness, provider_id, currency, amount_minor, billing_period_start,
                 source_pricing_version, status, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)
             ON CONFLICT(candidate_id) DO NOTHING",
            rusqlite::params![candidate_id, harness, provider_id, currency, amount_minor,
                billing_period_start, source_pricing_version, now_ms],
        )?;
        Ok(changed > 0)
    }

    pub fn pending_billing_import_candidates(
        &self,
    ) -> Result<Vec<BillingImportCandidateRow>, AuthorityError> {
        Ok(self.billing_import_candidates()?.into_iter()
            .filter(|row| row.6 == "pending").collect())
    }

    /// 所有旧资产候选（含用户已决定项）。已决定项仍需可见，才能提供可核对
    /// 的回执与撤销入口；它们不参与同步生成或实际支出计算。
    pub fn billing_import_candidates(
        &self,
    ) -> Result<Vec<BillingImportCandidateRow>, AuthorityError> {
        let mut stmt = self.conn.prepare(
            "SELECT candidate_id, harness, provider_id, currency, amount_minor, billing_period_start, status
             FROM billing_import_candidates
             ORDER BY provider_id, billing_period_start, candidate_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
            r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
        )))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 用户对旧资产候选作出的本地决定。`accepted` 只确认“这是我的套餐
    /// 声明”，并不创建付款/账单；`dismissed` 表示该候选不属于当前用户。
    /// 两种决定都不可再被后续同步重新变回 pending。
    pub fn billing_import_candidate_resolve(
        &self,
        candidate_id: &str,
        status: &str,
        now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        if !matches!(status, "accepted" | "dismissed") {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
                "billing candidate status must be accepted or dismissed".to_string(),
            )));
        }
        Ok(self.conn.execute(
            "UPDATE billing_import_candidates
             SET status = ?2, updated_at_ms = ?3, resolved_at_ms = ?3
             WHERE candidate_id = ?1 AND status = 'pending'",
            rusqlite::params![candidate_id, status, now_ms],
        )? > 0)
    }

    /// 用户主动撤销刚才的候选决定，恢复为待确认。同步不会调用该方法，故不会
    /// 擅自推翻用户决定；撤销同样不涉及付款或账单。
    pub fn billing_import_candidate_reopen(
        &self,
        candidate_id: &str,
        now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        // 被一条**有效**声明占着的候选不能单独「重新打开」：候选回到 pending、声明却
        // 还活着，之后任何对这张候选的新声明都撞「already used by another live
        // declaration」，而待确认面板又拿它再问一遍（2026-09-16 真机：anthropic
        // 候选 pending + decl 有效，用户被卡在两个面之间）。要重来就撤销那条声明——
        // 撤销路径会顺手把候选放回 pending（`release_revoked_candidate_claims`）。
        if let Some(holder) = self.live_declaration_holding_candidate(candidate_id)? {
            return Err(AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(format!(
                "this legacy package record is the basis of live declaration {holder}; revoke that declaration instead of reopening the record"
            ))));
        }
        Ok(self.conn.execute(
            "UPDATE billing_import_candidates
             SET status = 'pending', updated_at_ms = ?2, resolved_at_ms = NULL
             WHERE candidate_id = ?1 AND status IN ('accepted', 'dismissed')",
            rusqlite::params![candidate_id, now_ms],
        )? > 0)
    }

    fn live_declaration_holding_candidate(&self, candidate_id: &str) -> Result<Option<String>, AuthorityError> {
        Ok(self.conn.query_row(
            "SELECT declaration_id FROM billing_declarations
             WHERE source_candidate_id = ?1 AND deleted_at_ms IS NULL LIMIT 1",
            rusqlite::params![candidate_id], |row| row.get(0),
        ).optional()?)
    }

    /// 候选状态与声明占用的**一致性自愈**：被有效声明占着的候选按定义就是
    /// `accepted`。历史上「重新打开」不看声明就把候选翻回 pending，留下
    /// 「候选待确认 + 声明有效」的分裂态；例行同步在这里把它们收回来。只动
    /// pending→accepted 这一向（accepted→pending 是撤销声明的事，不在这里猜）。
    pub fn reconcile_candidate_claims(&self, now_ms: i64) -> Result<usize, AuthorityError> {
        Ok(self.conn.execute(
            "UPDATE billing_import_candidates
             SET status = 'accepted', updated_at_ms = ?1, resolved_at_ms = ?1
             WHERE status = 'pending' AND EXISTS (
                 SELECT 1 FROM billing_declarations bd
                 WHERE bd.source_candidate_id = billing_import_candidates.candidate_id
                   AND bd.deleted_at_ms IS NULL)",
            rusqlite::params![now_ms],
        )?)
    }

    /// 将先前错误自动导入的旧价表账单撤回。仅匹配专用 evidence 标签，绝不
    /// 触碰用户手工录入的账单。
    pub fn revoke_legacy_pricing_harness_bills(&self, now_ms: i64) -> Result<usize, AuthorityError> {
        Ok(self.conn.execute(
            "UPDATE harness_bills SET deleted_at_ms = ?1
             WHERE evidence_ref = 'legacy-pricing-catalog' AND deleted_at_ms IS NULL",
            rusqlite::params![now_ms],
        )?)
    }

    /// `BEGIN IMMEDIATE` 事务帮助器：闭包成功 → COMMIT，Err → ROLLBACK 后
    /// 原样上抛。**所有业务写入都必须走这里**（spec §5.1.4——事务边界是
    /// 写入协议的一部分，不是调用方的自由裁量）。
    pub fn with_immediate_txn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, AuthorityError>,
    ) -> Result<T, AuthorityError> {
        let mark = begin_immediate(&self.conn)?;
        match f(&self.conn) {
            Ok(v) => {
                commit_advancing_revision(&self.conn, mark)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// R3-F4（REFRESH_STORM）：簿记事务——闭包在事务内自行裁决「本轮是否
    /// 事实性」并随值返回。事实性 false → COMMIT **不经** `commit_advancing_
    /// revision`（revision 不动），行照常持久化：checkpoint / source_files
    /// last_seen / 快照心跳必须落库（否则下轮重复解析、孤儿误判），但纯
    /// 簿记不是业务状态变更，不得向展示层发失效（「文件变了但零新事实」的
    /// 唤醒轮此前照样推 revision、发 Invalidated）。事实性判据与 outbox 的
    /// FactsIngested 压制谓词同源（sql_sync 统一计算，见 `write_flat_facts_
    /// with_sources` 尾部）；revision 行唯一写者纪律不变——静默路径不写
    /// revision 行（revision_guard 的 only-writer 测试覆盖）。
    ///
    /// **不变量（F4 验收评审穷举确认）**：outbox 发射 ⟹ inserted>0 ∨ rejected>0
    /// ⟹ 必有真实行写入 ⟹ total_changes>0 ⟹ +1 必发生——即 FactsIngested 载荷
    /// 里的 `revision_after_commit = 当前 + 1` 在任何可达路径上都不谎报；
    /// 反向的「谓词说事实性、total_changes 说零」组合（路由证据全吸收 / 快照
    /// 全被时间守卫排除，且 sources 为空）在两个生产调用方下不可达。
    pub fn with_immediate_txn_decided<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<(T, bool), AuthorityError>,
    ) -> Result<T, AuthorityError> {
        let mark = begin_immediate(&self.conn)?;
        match f(&self.conn) {
            Ok((value, advance)) => {
                if advance {
                    commit_advancing_revision(&self.conn, mark)?;
                } else {
                    self.conn.execute_batch("COMMIT")?;
                }
                Ok(value)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// 权威 revision（spec §4.1）：每个改了业务状态的写事务提交时 +1。
    pub fn revision(&self) -> Result<u64, AuthorityError> {
        revision_of(&self.conn)
    }

    /// 只读连接访问（查询面在 Phase 3 接 repository；Phase 2 的 writer 也
    /// 走 with_immediate_txn——这个 getter 仅供测试与迁移框架）。
    /// 读取一份执行环境实时快照；调用方负责反序列化，并把损坏 payload 当数据质量
    /// 问题而不是回落读取原始日志。
    pub fn runtime_snapshot_get(
        &self,
        harness: &str,
        snapshot_kind: &str,
    ) -> Result<Option<(String, i64)>, AuthorityError> {
        self.conn
            .query_row(
                "SELECT payload_json, observed_at_ms FROM harness_runtime_snapshots
                 WHERE harness = ?1 AND snapshot_kind = ?2",
                rusqlite::params![harness, snapshot_kind],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(AuthorityError::from)
    }

    /// 写入一份执行环境实时快照（`codex_quota` 之外的第二类消费方：Claude Pro 的
    /// 窗口状态）。
    ///
    /// **只让更新的快照覆盖旧的**（`WHERE excluded.observed_at_ms >= ...`）——
    /// 与 Codex 那条同一条纪律：扫描是跨文件取最新，但不同批次到达顺序不保证，
    /// 没有这个守卫就会出现"旧观察覆盖新观察"，而窗口状态恰恰是**越新越准**的
    /// 东西（重置时刻会往后推）。
    ///
    /// 返回是否真的写入（`false` = 已有更新的观察，本次忽略）。
    pub fn runtime_snapshot_upsert(
        &self,
        harness: &str,
        snapshot_kind: &str,
        payload_json: &str,
        observed_at_ms: i64,
        now_ms: i64,
    ) -> Result<bool, AuthorityError> {
        let changed = self.conn.execute(
            "INSERT INTO harness_runtime_snapshots(
                 harness, snapshot_kind, payload_json, observed_at_ms, source_id,
                 ingested_run_id, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5)
             ON CONFLICT(harness, snapshot_kind) DO UPDATE SET
                 payload_json = excluded.payload_json,
                 observed_at_ms = excluded.observed_at_ms,
                 updated_at_ms = excluded.updated_at_ms
             WHERE excluded.observed_at_ms >= harness_runtime_snapshots.observed_at_ms",
            rusqlite::params![harness, snapshot_kind, payload_json, observed_at_ms, now_ms],
        )?;
        Ok(changed > 0)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn legacy_host_columns_require_rebuild_without_mutating_data() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO schema_meta VALUES ('schema_version', '30');
            CREATE TABLE usage_facts (host TEXT);
            INSERT INTO usage_facts VALUES ('codex');").unwrap();
        assert!(matches!(super::AuthorityDb::ensure_schema(&conn, 1),
            Err(super::AuthorityError::OlderSchema { found: 30 })));
        let retained: String = conn.query_row("SELECT host FROM usage_facts", [], |row| row.get(0)).unwrap();
        assert_eq!(retained, "codex");
    }

    /// R6a（REFRESH_STORM，v27）：enabled_source 四态的迁移不变量——
    /// 全新/迁移库种子 `legacy_default`；显式保存置 `user` 且重开库（迁移重跑）
    /// 不覆写；dismiss 置 `dismissed` 且不被后续 record_result 心跳冲掉。
    #[test]
    fn trust_monitor_enabled_source_migration_tri_state() {
        let dir = std::env::temp_dir().join(format!(
            "av-v27-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.sqlite3");
        {
            let db = AuthorityDb::open(&path, 1).unwrap();
            let state = db.trust_monitor_state_get().unwrap().expect("seed row");
            assert_eq!(state.enabled_source, "legacy_default", "R6a 未翻默认：种子必须 legacy_default");
            assert!(!state.enabled, "R6a 未翻默认：enabled 保持 0");
            db.trust_monitor_state_set(true, 30, false, 2).unwrap();
            assert_eq!(db.trust_monitor_state_get().unwrap().unwrap().enabled_source, "user");
            db.trust_monitor_record_result("partial", Some(3), None, 3).unwrap();
            assert_eq!(db.trust_monitor_state_get().unwrap().unwrap().enabled_source, "user",
                "传感心跳不得覆写 user");
        }
        // 重开（迁移/补跑链重执行）：user 保持。
        {
            let db = AuthorityDb::open(&path, 4).unwrap();
            assert_eq!(db.trust_monitor_state_get().unwrap().unwrap().enabled_source, "user",
                "迁移不得覆写显式选择");
            db.trust_monitor_dismiss().unwrap();
            assert_eq!(db.trust_monitor_state_get().unwrap().unwrap().enabled_source, "dismissed");
            db.trust_monitor_record_result("partial", Some(5), None, 5).unwrap();
            assert_eq!(db.trust_monitor_state_get().unwrap().unwrap().enabled_source, "dismissed",
                "dismissed 同样不被心跳覆写");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    fn tmp_db(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "avd-authority-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn empty_install_creates_full_schema_and_stamps_version() {
        let db = tmp_db("fresh");
        {
            let a = AuthorityDb::open(&db, 1_000).unwrap();
            // 全部表存在。
            let tables: Vec<String> = a
                .conn()
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect();
            for t in [
                "schema_meta",
                "sync_runs",
                "source_files",
                "sessions",
                "usage_facts",
                "harness_bills",
                "pricing_snapshots",
                "budget_config",
                "budget_snoozes",
                "data_quality_issues",
                "migrations",
                "workflow_events",
                "harness_runtime_snapshots",
                "route_evidence",
                "issue_instances",
                "issue_status_transitions",
                "provider_catalog_snapshots",
                "billing_templates",
                "billing_template_snapshots",
                "billing_import_candidates",
                "outcome_measurements",
                "savings_records",
                "billing_declarations",
                "billing_declaration_revisions",
                "billing_declaration_scopes",
                "billing_recalculation_jobs",
                "billing_recalculation_results",
                "billing_fact_attributions",
                "trust_observations",
                "trust_issue_evidence",
                "trust_monitor_state",
                "trust_monitor_alerts",
                "trust_suppressions",
            ] {
                assert!(tables.iter().any(|x| x == t), "缺表 {t}: {tables:?}");
            }
            // 重复 open 幂等（版本已 stamp）。
            drop(a);
        }
        let a2 = AuthorityDb::open(&db, 2_000).unwrap();
        let ver: String = a2
            .conn()
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ver, SCHEMA_VERSION.to_string());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn interrupted_running_batches_are_swept_on_open() {
        let db = tmp_db("sweep");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        a.begin_run("run-1", "tray", 1_000).unwrap();
        a.begin_run("run-2", "cli", 1_100).unwrap();
        a.finish_run("run-2", "succeeded", None, None, 1_200)
            .unwrap();
        drop(a);
        // 模拟 crash：run-1 停在 running。重新 open → 清扫为 cancelled。
        let a2 = AuthorityDb::open(&db, 9_000).unwrap();
        let (status, code): (String, Option<String>) = a2
            .conn()
            .query_row(
                "SELECT status, error_code FROM sync_runs WHERE run_id = 'run-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "cancelled");
        assert_eq!(code.as_deref(), Some("interrupted"));
        // succeeded 批次不受清扫影响。
        let s2: String = a2
            .conn()
            .query_row(
                "SELECT status FROM sync_runs WHERE run_id = 'run-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(s2, "succeeded");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v1_database_migrates_to_current_schema() {
        let db = tmp_db("v1-to-v2");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES('schema_version', '1')",
            [],
        )
        .unwrap();
        conn.execute_batch("DROP TABLE harness_runtime_snapshots;")
            .unwrap();
        conn.execute_batch("COMMIT;").unwrap();
        drop(conn);

        let upgraded = AuthorityDb::open(&db, 2_000).unwrap();
        let version: String = upgraded
            .conn()
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let exists: i64 = upgraded
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'harness_runtime_snapshots'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v15_database_upgrades_to_v16_with_null_enrichment_columns() {
        // 手工搭一个 v15 库（SCHEMA_V1 + V3..V15、版本行钉 15——即 None 建库分支
        // 的完整前缀），插入旧形状的 workflow_events 行后升级：新列必须全 NULL
        // （NULL = 未富化，不是 0/空串——spec §0 的不编数纪律），CHECK 词表立即生效。
        let db = tmp_db("v15-to-v16");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        for batch in [
            SCHEMA_V3_ADD, SCHEMA_V4_ADD, SCHEMA_V5_ADD, SCHEMA_V6_ADD, SCHEMA_V7_ADD,
            SCHEMA_V8_ADD, SCHEMA_V9_ADD, SCHEMA_V10_ADD, SCHEMA_V11_ADD, SCHEMA_V12_ADD,
            SCHEMA_V13_ADD, SCHEMA_V14_ADD, SCHEMA_V15_ADD,
        ] {
            conn.execute_batch(batch).unwrap();
        }
        conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES('schema_version', '15')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('run-v15', 1, 'test', 'succeeded', 15)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES('sess-v15', 'claude-code', 'native-1', 'ns', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, outcome, ingested_run_id, created_at_ms)
             VALUES('evt-v15', 'sess-v15', 1, 'tool_finished', 'failed', 'run-v15', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key, source_event_id, observation_kind, event_ts_ms, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES('fact-v15', 'claude-code', 'ns', 'native-1', 'sess-v15', 'evt-1', 'message', 1, 'run-v15', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute_batch("COMMIT;").unwrap();
        drop(conn);

        let upgraded = AuthorityDb::open(&db, 2_000).unwrap();
        let version: String = upgraded
            .conn()
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());

        // 旧行新列全 NULL——「未富化」既不是 0 也不是空串。三表逐一断言（spec §10-3
        // 的抽查口径）：workflow_events 九列、sessions 三列、usage_facts.reasoning_effort。
        let all_null_events: i64 = upgraded
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM workflow_events WHERE event_id = 'evt-v15'
                 AND error_code IS NULL AND error_class IS NULL AND error_excerpt IS NULL
                 AND args_excerpt IS NULL AND native_event_id IS NULL AND request_bytes IS NULL
                 AND result_bytes IS NULL AND source_line IS NULL AND source_byte_offset IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(all_null_events, 1, "workflow_events 九个新列必须全 NULL");
        let all_null_session: i64 = upgraded
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE session_key = 'sess-v15'
                 AND probe_run_ref IS NULL AND task_profile IS NULL AND task_profile_basis IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(all_null_session, 1, "sessions 三个新列必须全 NULL");
        let effort: Option<String> = upgraded
            .conn()
            .query_row(
                "SELECT reasoning_effort FROM usage_facts WHERE fact_id = 'fact-v15'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(effort.is_none(), "reasoning_effort 必须为 NULL（执行环境未报）");

        // CHECK 词表：闭集外拒绝、闭集内放行。
        let rejected = upgraded.conn().execute(
            "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, outcome, ingested_run_id, created_at_ms, error_class)
             VALUES('evt-bad', 'sess-v15', 2, 'tool_finished', 'failed', 'run-v15', 2, 'bogus')",
            [],
        );
        assert!(rejected.is_err(), "error_class 闭集外必须被 CHECK 拒绝");
        upgraded
            .conn()
            .execute(
                "INSERT INTO workflow_events(event_id, session_key, event_ts_ms, event_type, outcome, ingested_run_id, created_at_ms, error_class)
                 VALUES('evt-ok', 'sess-v15', 3, 'tool_finished', 'failed', 'run-v15', 3, 'rate_limit')",
                [],
            )
            .unwrap();

        // session_excerpts：role/provenance 词表生效。
        upgraded
            .conn()
            .execute(
                "INSERT INTO session_excerpts(session_key, ordinal, role, excerpt, provenance, ingested_run_id)
                 VALUES('sess-v15', 0, 'user_first', '帮我修登录页', 'verbatim', 'run-v15')",
                [],
            )
            .unwrap();
        let bad_role = upgraded.conn().execute(
            "INSERT INTO session_excerpts(session_key, ordinal, role, excerpt, provenance, ingested_run_id)
             VALUES('sess-v15', 1, 'bogus', 'x', 'verbatim', 'run-v15')",
            [],
        );
        assert!(bad_role.is_err(), "role 闭集外必须被 CHECK 拒绝");

        // 其余新列逐表点名（pragma_table_info）。
        for (table, column) in [
            ("workflow_events", "error_excerpt"),
            ("workflow_events", "result_bytes"),
            ("usage_facts", "reasoning_effort"),
            ("sessions", "probe_run_ref"),
            ("sessions", "task_profile_basis"),
        ] {
            let present: i64 = upgraded
                .conn()
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(present, 1, "{table}.{column} 必须存在");
        }
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v16_stale_stamp_recreates_probe_tables_idempotently() {
        // 建一个 v17 库后删掉五张探针表、把版本戳拨回 16——重开走 Some(16)
        // 分支：IF NOT EXISTS 重建五表，幂等不炸（stale-stamp 不变量的 V17 版）。
        let db = tmp_db("v16-to-v17");
        {
            let seeded = AuthorityDb::open(&db, 1).unwrap();
            let conn = seeded.conn();
            conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
            conn.execute_batch(
                "DROP TABLE probe_verdicts; DROP INDEX IF EXISTS probe_results_run;
                 DROP TABLE probe_results; DROP TABLE probe_runs;
                 DROP TABLE probe_suites; DROP TABLE probe_routes;
                 UPDATE schema_meta SET value = '16' WHERE key = 'schema_version';",
            ).unwrap();
            conn.execute_batch("COMMIT;").unwrap();
            drop(seeded);
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        for table in ["probe_routes", "probe_suites", "probe_runs", "probe_results", "probe_verdicts"] {
            let present: i64 = upgraded.conn().query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table], |r| r.get(0),
            ).unwrap();
            assert_eq!(present, 1, "{table} 必须被重建");
        }
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v17_stale_stamp_recreates_trust_tables_idempotently() {
        // v17 已是 Findings 2.0 的上一版；即使升级中断留下了陈旧戳，重开
        // 也必须仅补建 v18 两表，不改变已有业务数据。
        let db = tmp_db("v17-to-v18");
        {
            let seeded = AuthorityDb::open(&db, 1).unwrap();
            seeded.conn().execute_batch(
                "DROP TABLE trust_issue_evidence;
                 DROP TABLE trust_observations;
                 UPDATE schema_meta SET value = '17' WHERE key = 'schema_version';",
            ).unwrap();
            drop(seeded);
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        for table in ["trust_observations", "trust_issue_evidence"] {
            let present: i64 = upgraded.conn().query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table], |r| r.get(0),
            ).unwrap();
            assert_eq!(present, 1, "{table} 必须被重建");
        }
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v18_upgrade_seeds_trust_monitor_off_and_alert_claim_is_idempotent() {
        let db = tmp_db("v18-to-v19");
        {
            let seeded = AuthorityDb::open(&db, 1).unwrap();
            seeded.conn().execute_batch(
                "DROP TABLE trust_monitor_state;
                 UPDATE schema_meta SET value = '18' WHERE key = 'schema_version';",
            ).unwrap();
            drop(seeded);
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let state = upgraded.trust_monitor_state_get().unwrap().unwrap();
        assert!(!state.enabled);
        assert_eq!(state.interval_seconds, 30);
        assert!(!state.notifications_enabled);
        assert_eq!(state.capability, "not_started");

        upgraded.trust_monitor_state_set(true, 5, true, 10).unwrap();
        upgraded.trust_monitor_record_result("available", Some(11), None, 12).unwrap();
        let state = upgraded.trust_monitor_state_get().unwrap().unwrap();
        assert!(state.enabled && state.notifications_enabled);
        assert_eq!(state.last_success_at_ms, Some(11));
        assert!(upgraded.trust_monitor_claim_alert("trust-runtime-v1", 20, 100).unwrap());
        assert!(!upgraded.trust_monitor_claim_alert("trust-runtime-v1", 50, 100).unwrap());
        assert!(upgraded.trust_monitor_claim_alert("trust-runtime-v1", 121, 100).unwrap());
        assert!(upgraded.trust_monitor_claim_alert("another-family", 122, 100).unwrap());
        upgraded.trust_suppression_set("sup-1", "SV709", Some("trust_instance"), "user review", 123).unwrap();
        assert!(upgraded.trust_suppression_active("SV709", Some("trust_instance")).unwrap());
        assert!(!upgraded.trust_suppression_active("SV709", Some("other_instance")).unwrap());
        assert!(upgraded.trust_suppression_revoke("sup-1", 124).unwrap());
        assert!(!upgraded.trust_suppression_active("SV709", Some("trust_instance")).unwrap());
        assert!(upgraded.trust_monitor_state_set(false, 60, false, 123).is_ok());
        assert!(!upgraded.trust_monitor_state_get().unwrap().unwrap().enabled);
        assert!(upgraded.trust_monitor_state_set(true, 4, false, 124).is_err());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v21_upgrade_marks_existing_trust_evidence_as_unknown_legacy() {
        let db = tmp_db("v21-to-v22-evidence-origin");
        {
            let seeded = AuthorityDb::open(&db, 1).unwrap();
            seeded.conn().execute_batch(
                "ALTER TABLE trust_observations DROP COLUMN evidence_origin;
                 UPDATE schema_meta SET value = '21' WHERE key = 'schema_version';",
            ).unwrap();
            drop(seeded);
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let origin: String = upgraded.conn().query_row(
            "SELECT dflt_value FROM pragma_table_info('trust_observations') WHERE name = 'evidence_origin'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(origin, "'unknown_legacy'");
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let _ = std::fs::remove_file(&db);
    }

    /// v22 → v23：事件 outbox 两表在既有库上建立，版本推进；新库直接就有。
    #[test]
    fn v22_upgrade_creates_event_outbox_tables() {
        let db = tmp_db("v22-to-v23-event-outbox");
        {
            let seeded = AuthorityDb::open(&db, 1).unwrap();
            seeded.conn().execute_batch(
                "DROP TABLE event_outbox;
                 DROP TABLE IF EXISTS event_deliveries;
                 UPDATE schema_meta SET value = '22' WHERE key = 'schema_version';",
            ).unwrap();
            drop(seeded);
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let tables: i64 = upgraded.conn().query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'
             AND name IN ('event_outbox', 'event_deliveries')",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(tables, 2, "两张事件表都必须建立");
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let _ = std::fs::remove_file(&db);
    }

    /// 事件级联（spec §4.2）：删除执行环境导入数据时，该执行环境的 outbox 行与投递
    /// 记录一起清，不留「已删除数据的事实还在驱动消费者」的悬空。
    #[test]
    fn delete_imported_harness_data_cascades_event_outbox() {
        let db = tmp_db("delete-cascades-events");
        let seeded = AuthorityDb::open(&db, 1).unwrap();
        seeded.begin_run("run-e", "cli", 1).unwrap();
        seeded.conn().execute_batch(
            "INSERT INTO event_outbox(event_id, event_type, schema_version, occurred_at_ms,
                 harness, producer, payload_json, ingested_run_id, created_at_ms)
             VALUES ('e1', 'FactsIngested', 1, 1, 'zcode', 'sync_service', '{}', 'run-e', 1),
                    ('e2', 'FactsIngested', 1, 1, 'claude-code', 'sync_service', '{}', 'run-e', 1);
             INSERT INTO event_deliveries(event_id, consumer_id, delivered_at_ms)
             VALUES ('e1', 'price-reconcile', 2), ('e2', 'price-reconcile', 2);",
        ).unwrap();
        seeded.delete_imported_harness_data("zcode", 3).unwrap();
        let harness_events: i64 = seeded.conn().query_row(
            "SELECT COUNT(*) FROM event_outbox WHERE harness = 'zcode'", [], |r| r.get(0),
        ).unwrap();
        let other_events: i64 = seeded.conn().query_row(
            "SELECT COUNT(*) FROM event_outbox WHERE harness = 'claude-code'", [], |r| r.get(0),
        ).unwrap();
        let dangling: i64 = seeded.conn().query_row(
            "SELECT COUNT(*) FROM event_deliveries d
             WHERE NOT EXISTS (SELECT 1 FROM event_outbox o WHERE o.event_id = d.event_id)",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!((harness_events, other_events, dangling), (0, 1, 0),
            "执行环境事件清空、他执行环境保留、投递记录无悬挂");
        let _ = std::fs::remove_file(&db);
    }

    /// outbox 保留清理的三个判别点（迭代 3，spec §4.2 勘正版）：
    /// ① 到期事件随其 delivery 一起清；② 活事件的 delivery **永不独死**（反连接
    /// 重投递陷阱）；③ 孤儿 delivery（事件已亡）被扫。
    #[test]
    fn retention_event_outbox_never_deletes_delivery_of_live_event() {
        let path = tmp_db("outbox-retention");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run-r", "cli", 1).unwrap();
        let now: i64 = 10_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        db.conn().execute_batch(&format!(
            "INSERT INTO event_outbox(event_id, event_type, schema_version, occurred_at_ms,
                 producer, payload_json, ingested_run_id, created_at_ms)
             VALUES ('old', 'FactsIngested', 1, 0, 'sync_service', '{{}}', 'run-r', {}),
                    ('live', 'FactsIngested', 1, {n}, 'sync_service', '{{}}', 'run-r', {n}),
                    ('live2', 'FactsIngested', 1, {n}, 'sync_service', '{{}}', 'run-r', {n});
             INSERT INTO event_deliveries(event_id, consumer_id, delivered_at_ms)
             VALUES ('old', 'c1', 1), ('live', 'c1', 1),
                    ('live2', 'c1', 1), ('orphan', 'c1', 1);",
            now - 8 * day, n = now,
        )).unwrap();
        let deleted = db.retention_event_outbox(now + day).unwrap();
        assert!(deleted >= 3, "old 事件 + 其 delivery + 孤儿 delivery 都要删: {deleted}");
        let live_delivery: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM event_deliveries WHERE event_id = 'live'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(live_delivery, 1, "活事件的 delivery 必须存活——删了就是重投递");
        let live_events: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM event_outbox", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(live_events, 2, "未到期事件保留");
        assert_eq!(db.retention_event_outbox(now + day).unwrap(), 0, "幂等");
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    /// v23 → v24：source_files 获得三个检查点列（byte_offset / parser_id / dirty），
    /// 既有库升级；新库直接就有；默认值正确（NULL/NULL/0）。
    #[test]
    fn v23_upgrade_adds_source_graph_checkpoint_columns() {
        let db = tmp_db("v23-to-v24-source-graph");
        {
            let seeded = AuthorityDb::open(&db, 1).unwrap();
            seeded.begin_run("run-sg", "cli", 1).unwrap();
            seeded.conn().execute_batch(
                "ALTER TABLE source_files DROP COLUMN byte_offset;
                 ALTER TABLE source_files DROP COLUMN parser_id;
                 ALTER TABLE source_files DROP COLUMN dirty;
                 UPDATE schema_meta SET value = '23' WHERE key = 'schema_version';",
            ).unwrap();
            drop(seeded);
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let cols: i64 = upgraded.conn().query_row(
            "SELECT COUNT(*) FROM pragma_table_info('source_files')
             WHERE name IN ('byte_offset', 'parser_id', 'dirty')",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(cols, 3, "三个检查点列都必须建立");
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let dirty_default: String = upgraded.conn().query_row(
            "SELECT COALESCE(dflt_value,'0')
             FROM pragma_table_info('source_files') WHERE name = 'dirty'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(dirty_default, "0", "dirty 默认值 0");
        let _ = std::fs::remove_file(&db);
    }

    /// v24 → v25：event_deliveries 获得重试列。
    #[test]
    fn v24_upgrade_adds_event_retry_columns() {
        let path = tmp_db("v24-to-v25-event-retry");
        {
            let seeded = AuthorityDb::open(&path, 1).unwrap();
            seeded.conn().execute_batch(
                "ALTER TABLE event_deliveries DROP COLUMN retry_count;
                 ALTER TABLE event_deliveries DROP COLUMN next_retry_at_ms;
                 UPDATE schema_meta SET value = '24' WHERE key = 'schema_version';",
            ).unwrap();
            drop(seeded);
        }
        let upgraded = AuthorityDb::open(&path, 2).unwrap();
        let cols: i64 = upgraded.conn().query_row(
            "SELECT COUNT(*) FROM pragma_table_info('event_deliveries')
             WHERE name IN ('retry_count', 'next_retry_at_ms')",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(cols, 2, "两个重试列都必须建立");
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn v17_pure_replay_with_tables_present_is_a_noop() {
        // 表已存在 + 陈旧戳 16：IF NOT EXISTS 纯重放（v9 幂等不变量的 V17 补钉——
        // 上一个测试盖的是"表被删后重建"，本测试盖"表都在时空跑"）。
        let db = tmp_db("v17-replay");
        {
            let seeded = AuthorityDb::open(&db, 1).unwrap();
            seeded.conn().execute(
                "UPDATE schema_meta SET value = '16' WHERE key = 'schema_version'",
                [],
            ).unwrap();
            drop(seeded);
        }
        let reopened = AuthorityDb::open(&db, 2).unwrap();
        let version: String = reopened.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        // 纯重放不炸也不重复建表：probe 表各恰好一份（sqlite_master 计数 = 1）。
        for table in ["probe_routes", "probe_suites", "probe_runs", "probe_results", "probe_verdicts"] {
            let count: i64 = reopened.conn().query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table], |r| r.get(0),
            ).unwrap();
            assert_eq!(count, 1);
        }
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn probe_tables_enforce_vocabularies_fk_order_and_uniqueness() {
        // 词表闭集（harness_kind/kind/mode/status/outcome/verdict）、FK 顺序
        // （run 依赖 route+suite）、verdict 每 run 唯一、consent 语义位可 NULL。
        let db = tmp_db("v17-vocab");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        let conn = authority.conn();
        // FK 顺序：没有 route 就建 run → 必须被拒。
        let bad_fk = conn.execute_batch(
            "INSERT INTO probe_runs(run_id, mode, route_a_id, suite_id, n_repeats, status, created_at_ms)
             VALUES('r0','paired','no-route','no-suite',1,'queued',1)",
        );
        assert!(bad_fk.is_err(), "run 必须依赖已存在的 route/suite");
        // 合法链路：route（未授权，consent NULL 是合法存储态——发起请求由
        // runner 层拒，不是库层）→ suite → run → result → verdict。
        conn.execute_batch(
            "INSERT INTO probe_routes(route_id, label, harness_kind, model_requested, created_at_ms, updated_at_ms)
             VALUES('rt1','官方直连','claude-code','claude-sonnet-5',1,1);
             INSERT INTO probe_suites(suite_id, version, kind, manifest_ref, manifest_sha256, rule_version, created_at_ms)
             VALUES('l0','1','l0_identity','probe/suites/l0/1/manifest.toml','deadbeef','stat-v1',1);
             INSERT INTO probe_runs(run_id, mode, route_a_id, suite_id, n_repeats, interleave_seed, status, currency, cost_budget_minor, created_at_ms)
             VALUES('run1','paired','rt1','l0',3,42,'running','USD',500,1);
             INSERT INTO probe_results(result_id, run_id, route_id, task_id, repeat_idx, outcome,
                 requested_model, resolved_model, evidence_json, session_key)
             VALUES('res1','run1','rt1','identity-echo',0,'pass','claude-sonnet-5','claude-sonnet-5','{}',NULL);",
        ).unwrap();
        // 词表拒绝：verdict 闭集外 / mode 闭集外 / outcome 闭集外 / kind 闭集外。
        for sql in [
            "INSERT INTO probe_verdicts(verdict_id, run_id, verdict, statistic_json, evidence_chain_json, confounders_json, rule_version, decided_at_ms)
             VALUES('v-bad','run1','definitely_watered','{}','[]','{}','stat-v1',1)",
            "INSERT INTO probe_runs(run_id, mode, route_a_id, suite_id, n_repeats, status, created_at_ms)
             VALUES('r-bad','trio','rt1','l0',1,'queued',1)",
            "INSERT INTO probe_results(result_id, run_id, route_id, task_id, repeat_idx, outcome, requested_model, evidence_json)
             VALUES('res-bad','run1','rt1','t',0,'skipped','m','{}')",
            "INSERT INTO probe_suites(suite_id, version, kind, manifest_ref, manifest_sha256, rule_version, created_at_ms)
             VALUES('l2','1','l2_public','x','y','z',1)",
        ] {
            assert!(conn.execute_batch(sql).is_err(), "闭集外必须被拒：{sql}");
        }
        // verdict 每 run 唯一：第二条同 run 必须被拒。
        conn.execute_batch(
            "INSERT INTO probe_verdicts(verdict_id, run_id, verdict, statistic_json, evidence_chain_json, confounders_json, rule_version, decided_at_ms)
             VALUES('v1','run1','suspected_degradation','{}','[]','{}','stat-v1',2);",
        ).unwrap();
        let dup = conn.execute_batch(
            "INSERT INTO probe_verdicts(verdict_id, run_id, verdict, statistic_json, evidence_chain_json, confounders_json, rule_version, decided_at_ms)
             VALUES('v2','run1','no_signal','{}','[]','{}','stat-v1',3)",
        );
        assert!(dup.is_err(), "每个 run 只允许一条 verdict");
        // results 的 (run_id, route_id, task_id, repeat_idx) 唯一：同槽重插被拒。
        let dup_result = conn.execute_batch(
            "INSERT INTO probe_results(result_id, run_id, route_id, task_id, repeat_idx, outcome, requested_model, evidence_json)
             VALUES('res-dup','run1','rt1','identity-echo',0,'fail','claude-sonnet-5','{}')",
        );
        assert!(dup_result.is_err(), "同 (run,route,task,repeat) 槽位不得重复");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn fresh_database_carries_v16_enrichment_schema() {
        // 新建库直接带 V16（None 分支链尾）——不依赖任何升级路径。
        let db = tmp_db("fresh-v16");
        let opened = AuthorityDb::open(&db, 1_000).unwrap();
        let tables: i64 = opened
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_excerpts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
        let index: i64 = opened
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'workflow_events_error_class_time'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(index, 1);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v33_database_adds_event_time_index_and_plan_uses_it() {
        let db = tmp_db("v33-event-index");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        let version: String = authority.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let mut statement = authority.conn().prepare(
            "EXPLAIN QUERY PLAN SELECT f.fact_id FROM usage_facts f
             WHERE f.deleted_at_ms IS NULL AND f.event_ts_ms >= ?1 AND f.event_ts_ms < ?2",
        ).unwrap();
        let plan: Vec<String> = statement.query_map(rusqlite::params![1, 2], |row| row.get::<_, String>(3))
            .unwrap().collect::<Result<_, _>>().unwrap();
        drop(statement);
        assert!(plan.iter().any(|line| line.contains("USING INDEX usage_facts_event_time")), "plan: {plan:?}");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v32_database_migrates_to_event_time_index_idempotently() {
        let db = tmp_db("v32-to-v33");
        {
            let current = AuthorityDb::open(&db, 1).unwrap();
            current.conn().execute_batch(
                "DROP INDEX IF EXISTS usage_facts_event_time;
                 UPDATE schema_meta SET value = '32' WHERE key = 'schema_version';",
            ).unwrap();
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let index: i64 = upgraded.conn().query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'usage_facts_event_time'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(index, 1);
        drop(upgraded);
        let reopened = AuthorityDb::open(&db, 3).unwrap();
        let version: String = reopened.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v6_database_migrates_candidates_and_billing_declarations() {
        let db = tmp_db("v6-to-v8");
        {
            let current = AuthorityDb::open(&db, 1).unwrap();
            current.conn().execute_batch(
                "DROP TABLE billing_fact_attributions;
                 DROP TABLE billing_recalculation_results;
                 DROP TABLE billing_recalculation_jobs;
                 DROP TABLE billing_declaration_scopes;
                 DROP TABLE billing_declaration_revisions;
                 DROP TABLE billing_declarations;
                 DROP TABLE billing_import_candidates;
                 UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';",
            ).unwrap();
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        assert!(upgraded.billing_import_candidate_put(
            "candidate", "claude-code", "minimax", "CNY", 11_400, "2026-09", "legacy", 3,
        ).unwrap());
        assert_eq!(upgraded.pending_billing_import_candidates().unwrap().len(), 1);
        assert!(upgraded.billing_import_candidate_resolve("candidate", "accepted", 4).unwrap());
        assert!(upgraded.billing_declaration_put(
            "decl","minimax", "official_subscription", None,
            Some(11_400), Some("CNY"), "2026-09", None, Some("candidate"), None, 5,
        ).unwrap());
        assert_eq!(upgraded.billing_declarations().unwrap().len(), 1);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v8_database_adds_immutable_declaration_revision_tables() {
        let db = tmp_db("v8-to-v9");
        {
            let current = AuthorityDb::open(&db, 1).unwrap();
            current.conn().execute_batch(
                "DROP TABLE billing_fact_attributions;
                 DROP TABLE billing_recalculation_results;
                 DROP TABLE billing_recalculation_jobs;
                 DROP TABLE billing_declaration_scopes;
                 DROP TABLE billing_declaration_revisions;
                 UPDATE schema_meta SET value = '8' WHERE key = 'schema_version';",
            ).unwrap();
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let scope_table: String = upgraded.conn().query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'billing_declaration_scopes'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(scope_table, "billing_declaration_scopes");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn stale_v9_stamp_with_later_tables_upgrades_idempotently() {
        let db = tmp_db("stale-v9");
        {
            let current = AuthorityDb::open(&db, 1).unwrap();
            current.conn().execute(
                "UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'",
                [],
            ).unwrap();
        }
        let upgraded = AuthorityDb::open(&db, 2).unwrap();
        let version: String = upgraded.conn().query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        assert_eq!(upgraded.billing_recalculation_result("missing").unwrap(), None);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_import_candidate_decision_never_creates_a_bill() {
        let db = tmp_db("candidate-decision");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.billing_import_candidate_put(
            "candidate", "claude-code", "minimax", "CNY", 11_400, "2026-09", "legacy", 1,
        ).unwrap();
        assert!(authority.billing_import_candidate_resolve("candidate", "accepted", 2).unwrap());
        assert!(authority.pending_billing_import_candidates().unwrap().is_empty());
        assert_eq!(authority.billing_import_candidates().unwrap()[0].6, "accepted",
            "the resolved state remains available for a persistent receipt and undo");
        assert_eq!(authority.harness_bill_count().unwrap(), 0,
            "a package declaration is not a payment record");
        assert!(!authority.billing_import_candidate_resolve("candidate", "dismissed", 3).unwrap(),
            "a resolved candidate cannot be silently rewritten by sync");
        let status: String = authority.conn().query_row(
            "SELECT status FROM billing_import_candidates WHERE candidate_id = 'candidate'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(status, "accepted");
        assert!(authority.billing_import_candidate_reopen("candidate", 4).unwrap());
        assert_eq!(authority.pending_billing_import_candidates().unwrap().len(), 1,
            "only an explicit user action can restore a pending candidate");
        assert!(!authority.billing_import_candidate_reopen("candidate", 5).unwrap());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_declaration_is_separate_from_bills_and_allows_unknown_amount() {
        let db = tmp_db("billing-declaration");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        assert!(authority.billing_declaration_put(
            "decl-unknown","openai", "official_subscription", Some("Plus"),
            None, None, "2026-09", None, None, Some("user:declared"), 2,
        ).unwrap());
        assert!(authority.billing_declaration_put(
            "decl-paid-contract","anthropic", "official_subscription", Some("Pro"),
            Some(2_000), Some("USD"), "2026-09", Some("2026-12"), None, None, 3,
        ).unwrap());
        let rows = authority.billing_declarations().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "decl-paid-contract");
        assert_eq!(rows[0].4, Some(2_000));
        assert_eq!(rows[1].0, "decl-unknown");
        assert_eq!(rows[1].4, None, "unknown contract amount must remain unknown");
        assert_eq!(authority.harness_bill_count().unwrap(), 0,
            "a billing declaration must not masquerade as a payment record");
        assert!(authority.billing_declaration_put(
            "bad","openai", "official_subscription", None,
            Some(100), None, "2026-09", None, None, None, 4,
        ).is_err(), "amount without a currency is invalid");
        assert!(authority.billing_declaration_put(
            "bad-month","openai", "official_subscription", None,
            None, None, "2026-99", None, None, None, 4,
        ).is_err(), "malformed period must not pass a length-only check");
        authority.billing_import_candidate_put(
            "candidate", "claude-code", "anthropic", "USD", 2_000, "2026-09", "legacy", 4,
        ).unwrap();
        assert!(authority.billing_declaration_put(
            "wrong-candidate","openai", "official_subscription", None,
            None, None, "2026-09", None, Some("candidate"), None, 4,
        ).is_err(), "candidate must belong to the declaration harness/provider and be accepted");
        authority.billing_import_candidate_resolve("candidate", "accepted", 5).unwrap();
        assert!(authority.billing_declaration_put(
            "candidate-declaration","anthropic", "official_subscription", None,
            Some(2_000), Some("USD"), "2026-09", None, Some("candidate"), None, 6,
        ).unwrap());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_revision_accepts_pending_candidate_atomically() {
        let db = tmp_db("billing-candidate-atomic");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.billing_import_candidate_put(
            "pending-ok", "codex", "openai", "CNY", 1_990, "2026-09", "uat", 1,
        ).unwrap();
        assert!(authority.billing_declaration_revision_save(
            "revision-from-pending", "declaration-from-pending", None,"openai", "official_subscription", Some("Plus"),
            Some(1_990), Some("CNY"), "2026-09", None, Some("pending-ok"),
            Some("candidate:pending-ok"), &[], 2,
        ).unwrap());
        assert_eq!(authority.billing_import_candidates().unwrap()[0].6, "accepted");
        assert_eq!(authority.billing_declaration_revisions("declaration-from-pending").unwrap()[0].13,
            Some("pending-ok".to_string()));

        authority.billing_import_candidate_put(
            "pending-fail", "codex", "openai", "CNY", 2_990, "2026-09", "uat", 3,
        ).unwrap();
        assert!(authority.billing_declaration_revision_save(
            "revision-from-pending-fail", "declaration-from-pending-fail", None,"openai", "official_subscription", None, None, None,
            "2026-09", None, Some("pending-fail"), None,
            &[("model", "gpt-5"), ("model", "gpt-5")], 4,
        ).is_err());
        let status: String = authority.conn().query_row(
            "SELECT status FROM billing_import_candidates WHERE candidate_id = 'pending-fail'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(status, "pending", "a failed revision must roll candidate acceptance back");
        let _ = std::fs::remove_file(&db);
    }

    /// 2026-09-16 真机：撤销一条挂过旧资产候选的声明之后，那张候选被一条看不见的软删行
    /// 永久占住，重新声明同一张候选直接失败：
    /// `保存失败：authority sqlite: UNIQUE constraint failed: billing_declarations.source_candidate_id`。
    /// 根因是 `source_candidate_id` 上的 UNIQUE **对软删行照样生效**。撤销必须释放它，
    /// 候选回到 pending（撤销是不再生效，不是放弃这张候选）。
    #[test]
    fn revoking_a_declaration_releases_its_legacy_candidate_for_reuse() {
        let db = tmp_db("billing-revoke-releases-candidate");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority
            .billing_import_candidate_put(
                "cand-reuse", "claude-code", "anthropic", "USD", 2_000, "2025-07", "uat", 1,
            )
            .unwrap();
        assert!(authority
            .billing_declaration_revision_save(
                "rev-1", "decl-1", None,"anthropic", "official_subscription",
                Some("Claude Pro"), Some(2_000), Some("USD"), "2025-07-20", None,
                Some("cand-reuse"), None, &[], 2,
            )
            .unwrap());
        assert_eq!(authority.billing_import_candidates().unwrap()[0].6, "accepted");

        assert!(authority
            .billing_declaration_revision_revoke("rev-1-revoke", "decl-1", "rev-1", 3)
            .unwrap());
        assert_eq!(
            authority.billing_import_candidates().unwrap()[0].6,
            "pending",
            "撤销只是不再生效，不是放弃候选：候选必须回到 pending",
        );

        // 用户的原始动作：撤销之后重新声明同一张旧套餐记录——必须成功。
        assert!(
            authority
                .billing_declaration_revision_save(
                    "rev-2", "decl-2", None,"anthropic", "official_subscription",
                    Some("Claude Pro"), Some(2_000), Some("USD"), "2025-07-20", None,
                    Some("cand-reuse"), None, &[], 4,
                )
                .unwrap(),
            "撤销后同一张候选必须可以重新声明",
        );

        // 但**有效**声明仍然只认一张候选（约束本意），且错误要说得清——不能让用户再看到
        // 裸的 UNIQUE 串。
        authority
            .billing_import_candidate_put(
                "cand-taken", "codex", "openai", "CNY", 1_000, "2026-09", "uat", 5,
            )
            .unwrap();
        assert!(authority
            .billing_declaration_revision_save(
                "rev-taken-1", "decl-taken-1", None,"openai", "official_subscription",
                None, Some(1_000), Some("CNY"), "2026-09", None, Some("cand-taken"), None, &[], 6,
            )
            .unwrap());
        let error = authority
            .billing_declaration_revision_save(
                "rev-taken-2", "decl-taken-2", None,"openai", "official_subscription",
                None, Some(1_000), Some("CNY"), "2026-09", None, Some("cand-taken"), None, &[], 7,
            )
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("already used by another live declaration"),
            "同一张候选被两条有效声明占用时要给人话而不是裸 UNIQUE 串：{error}",
        );
        let _ = std::fs::remove_file(&db);
    }

    /// 保存路径自愈历史脏数据：**旧版本撤销**留下「软删行仍占着候选」的记录，升级后
    /// 也必须能重新声明——真机上用户正是被这种行卡住的（撤销发生在修复之前）。
    #[test]
    fn saving_heals_a_candidate_claim_left_by_an_older_revoke() {
        let db = tmp_db("billing-heal-stale-candidate");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority
            .billing_import_candidate_put(
                "cand-stale", "claude-code", "anthropic", "USD", 2_000, "2025-07", "uat", 1,
            )
            .unwrap();
        assert!(authority
            .billing_declaration_revision_save(
                "rev-stale", "decl-stale", None,"anthropic",
                "official_subscription", None, Some(2_000), Some("USD"), "2025-07-20", None,
                Some("cand-stale"), None, &[], 2,
            )
            .unwrap());
        // 复现旧版本的撤销：只置 `deleted_at_ms`，没有释放 `source_candidate_id`。
        authority
            .conn()
            .execute(
                "UPDATE billing_declarations SET deleted_at_ms = 3 WHERE declaration_id = 'decl-stale'",
                [],
            )
            .unwrap();
        assert!(
            authority
                .billing_declaration_revision_save(
                    "rev-heal", "decl-heal", None,"anthropic",
                    "official_subscription", None, Some(2_000), Some("USD"), "2025-07-20", None,
                    Some("cand-stale"), None, &[], 4,
                )
                .unwrap(),
            "历史脏数据必须在保存路径上自愈，否则升级后用户仍然卡住",
        );
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_declaration_revisions_are_scoped_immutable_and_revocable() {
        let db = tmp_db("billing-declaration-revisions");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        assert!(authority.billing_declaration_revision_save(
            "revision-1", "declaration", None,"openai", "official_subscription",
            Some("Plus"), None, None, "2026-09", None, None, Some("user:declared"),
            &[("route", "official-desktop"), ("model", "gpt-5.6-sol")], 2,
        ).unwrap());
        assert_eq!(authority.billing_declaration_revisions("declaration").unwrap().len(), 1);
        assert_eq!(authority.billing_declaration_scopes("revision-1").unwrap(), vec![
            ("revision-1".to_string(), "model".to_string(), "gpt-5.6-sol".to_string()),
            ("revision-1".to_string(), "route".to_string(), "official-desktop".to_string()),
        ]);
        assert_eq!(authority.harness_bill_count().unwrap(), 0,
            "a scoped declaration remains distinct from a payment record");
        assert!(authority.billing_declaration_revision_save(
            "revision-2", "declaration", Some("revision-1"),"openai",
            "official_subscription", Some("Plus"), None, None, "2026-10", None, None,
            Some("user:corrected"), &[("account", "personal")], 3,
        ).unwrap());
        let revisions = authority.billing_declaration_revisions("declaration").unwrap();
        assert_eq!(revisions.len(), 2);
        assert_eq!(revisions[0].2, 1);
        assert_eq!(revisions[0].11, "2026-09", "old revision remains intact");
        assert_eq!(revisions[1].2, 2);
        assert_eq!(revisions[1].11, "2026-10");
        assert!(authority.billing_declaration_revision_save(
            "bad-branch", "declaration", Some("revision-1"),"openai",
            "official_subscription", None, None, None, "2026-10", None, None, None, &[], 4,
        ).is_err(), "a stale revision cannot silently form a second current branch");
        assert!(authority.billing_declaration_revision_revoke(
            "revision-3", "declaration", "revision-2", 5,
        ).unwrap());
        assert!(authority.billing_declarations().unwrap().is_empty(),
            "revoke makes only the current materialization inactive, not history disappear");
        let revisions = authority.billing_declaration_revisions("declaration").unwrap();
        assert_eq!(revisions.len(), 3);
        assert_eq!(revisions[2].3, "revoked");
        assert_eq!(authority.billing_declaration_scopes("revision-3").unwrap(), vec![
            ("revision-3".to_string(), "account".to_string(), "personal".to_string()),
        ], "revoke carries the revoked revision's exact scope for auditability");
        assert!(!authority.billing_declaration_revision_revoke(
            "revision-3", "declaration", "revision-2", 6,
        ).unwrap(), "replaying the same revoke is idempotent");
        assert_eq!(authority.harness_bill_count().unwrap(), 0);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn invalid_or_duplicate_declaration_scopes_do_not_create_revisions() {
        let db = tmp_db("billing-declaration-invalid-scopes");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        assert!(authority.billing_declaration_revision_save(
            "invalid", "declaration", None,"openai", "official_api", None,
            None, None, "2026-09", None, None, None,
            &[("model", "gpt-5"), ("model", "gpt-5")], 2,
        ).is_err());
        assert!(authority.billing_declaration_revisions("declaration").unwrap().is_empty());
        assert!(authority.billing_declarations().unwrap().is_empty());
        assert!(authority.billing_declaration_revision_save(
            "invalid-kind", "declaration", None,"openai", "official_api", None,
            None, None, "2026-09", None, None, None, &[("harness", "codex")], 3,
        ).is_err());
        assert!(authority.billing_declaration_revisions("declaration").unwrap().is_empty());
        let _ = std::fs::remove_file(&db);
    }

    /// 「服务商未知」的组（事实 `provider_id IS NULL`）：声明记录用户选的服务商，
    /// 作用域 `provider=unresolved` 让预览与重算只命中 NULL-provider 的事实，
    /// 不会把同执行环境里已知 provider 的事实一起吞掉；反之普通声明也不会碰到它们。
    #[test]
    fn provider_unresolved_scope_targets_null_provider_facts_only() {
        let db = tmp_db("billing-provider-unresolved");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.conn().execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('pu-run', 1, 'test', 'succeeded', 13);
             INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 session_key, observation_kind, provider_id, model_id, event_ts_ms, evidence_basis, billing_mode,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES('f-null-a', 'claude-code', 'm', 'n1', 'e1', NULL, 'assistant-usage', NULL, 'glm-5', 1000, 'missing', NULL, 10, 0, 0, 0, 'pu-run', 1, 1),
                   ('f-null-b', 'claude-code', 'm', 'n2', 'e2', NULL, 'assistant-usage', NULL, 'glm-5', 2000, 'missing', NULL, 20, 0, 0, 0, 'pu-run', 1, 1),
                   ('f-known', 'claude-code', 'm', 'n3', 'e3', NULL, 'assistant-usage', 'zhipu-glm', 'glm-5', 3000, 'session-native', 'metered', 40, 0, 0, 0, 'pu-run', 1, 1);",
        ).unwrap();
        let scopes = [("provider", "unresolved"), ("model", "glm-5")];
        let preview = authority.billing_declaration_impact_preview_for("zhipu-glm", "1970-01-01", Some("1970-12-31"), &scopes, None,
        ).unwrap();
        assert_eq!((preview.fact_count, preview.total_tokens), (2, 30), "{preview:?}");
        let plain = authority.billing_declaration_impact_preview_for("zhipu-glm", "1970-01-01", Some("1970-12-31"), &[("model", "glm-5")], None,
        ).unwrap();
        assert_eq!((plain.fact_count, plain.total_tokens), (1, 40), "plain declaration only sees the known-provider fact");
        authority.billing_declaration_revision_save(
            "pu-rev", "pu-decl", None,"zhipu-glm", "official_subscription",
            None, None, None, "1970-01-01", Some("1970-12-31"), None, None, &scopes, 2,
        ).unwrap();
        authority.billing_recalculation_enqueue("pu-job", "pu-decl", "pu-rev", 3).unwrap();
        assert!(authority.billing_recalculation_run("pu-job", 4).unwrap());
        let attributed: Vec<String> = authority.conn().prepare(
            "SELECT fact_id FROM billing_fact_attributions WHERE job_id = 'pu-job' ORDER BY fact_id",
        ).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        // 订阅是账号级的（2026-10-01）：provider 明确为 zhipu-glm 的 f-known 也属于这份 GLM 订阅；
        // 显式作答（provider=unresolved + 模型清单）仍只针对 NULL-provider 的 f-null-*（见上面的预览）。
        assert_eq!(attributed, vec!["f-known".to_string(), "f-null-a".to_string(), "f-null-b".to_string()]);
        assert!(authority.billing_declaration_revision_save(
            "bad-rev", "bad-decl", None,"zhipu-glm", "official_api",
            None, None, None, "1970-01-01", Some("1970-12-31"), None, None, &[("provider", "anything")], 5,
        ).is_err(), "provider scope only accepts the literal `unresolved`");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_boundaries_accept_exact_dates_and_legacy_months() {
        assert_eq!(billing_boundary_date("2026-08-14", false).as_deref(), Some("2026-08-14"));
        assert_eq!(billing_boundary_date("2026-08-14", true).as_deref(), Some("2026-08-14"));
        assert_eq!(billing_boundary_date("2026-08", false).as_deref(), Some("2026-08-01"));
        assert_eq!(billing_boundary_date("2026-08", true).as_deref(), Some("2026-08-31"));
        assert!(billing_boundary_date("2026-02-30", false).is_none());
        assert!(billing_boundary_date("2026-08-00", false).is_none());
    }

    #[test]
    fn billing_declaration_impact_preview_matches_scope_intersection() {
        let db = tmp_db("billing-impact-preview");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.conn().execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('preview-run', 1, 'test', 'succeeded', 9);
             INSERT INTO route_evidence(evidence_id, harness, machine_namespace, native_session_id,
                 endpoint_host, account_ref, evidence_basis, ingested_run_id)
             VALUES('route-a', 'codex', 'machine', 'session-a', 'official', 'personal', 'test', 'preview-run'),
                   ('route-b', 'codex', 'machine', 'session-b', 'other', 'personal', 'test', 'preview-run');
             INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES('session-a-key', 'codex', 'session-a', 'machine', 1000),
                   ('session-b-key', 'codex', 'session-b', 'machine', 3000);
             INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 session_key, observation_kind, provider_id, model_id, event_ts_ms, route_evidence_id,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES('fact-1', 'codex', 'machine', 'session-a', 'event-1', 'session-a-key', 'assistant-usage', 'openai', 'model-a', 1000, 'route-a', 10, 0, 0, 0, 'preview-run', 1, 1),
                   ('fact-2', 'codex', 'machine', 'session-a', 'event-2', 'session-a-key', 'assistant-usage', 'openai', 'model-b', 2000, 'route-a', 20, 0, 0, 0, 'preview-run', 1, 1),
                   ('fact-3', 'codex', 'machine', 'session-b', 'event-3', 'session-b-key', 'assistant-usage', 'openai', 'model-a', 3000, 'route-b', 30, 0, 0, 0, 'preview-run', 1, 1);",
        ).unwrap();
        assert_eq!(authority.billing_declaration_impact_preview_for("openai", "1970-01", Some("1970-12"),
            &[("route", "route-a"), ("model", "model-a")], Some((0, 4_000)),
        ).unwrap(), BillingDeclarationImpactPreview {
            fact_count: 1, session_count: 1, total_tokens: 10,
            first_event_ts_ms: Some(1000), last_event_ts_ms: Some(1000),
            conflict_fact_count: 0, conflict_tokens: 0,
        });
        assert_eq!(authority.conn().query_row(
            "SELECT COUNT(*) FROM billing_declaration_revisions", [], |row| row.get::<_, i64>(0),
        ).unwrap(), 0, "prospective preview must not persist a revision");
        authority.billing_declaration_revision_save(
            "preview-revision", "preview-declaration", None,"openai", "official_api",
            None, None, None, "1970-01", Some("1970-12"), None, Some("test"),
            &[("route", "route-a"), ("model", "model-a")], 2,
        ).unwrap();
        assert_eq!(authority.billing_declaration_impact_preview(
            "preview-revision", Some((0, 4_000)),
        ).unwrap(), BillingDeclarationImpactPreview {
            fact_count: 1, session_count: 1, total_tokens: 10,
            first_event_ts_ms: Some(1000), last_event_ts_ms: Some(1000),
            conflict_fact_count: 0, conflict_tokens: 0,
        });
        assert_eq!(authority.harness_bill_count().unwrap(), 0);
        authority.billing_recalculation_enqueue("preview-job", "preview-declaration", "preview-revision", 3).unwrap();
        assert!(authority.billing_recalculation_run("preview-job", 4).unwrap());
        let attribution: String = authority.conn().query_row(
            "SELECT fact_id FROM billing_fact_attributions WHERE job_id = 'preview-job'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(attribution, "fact-1");
        assert_eq!(authority.harness_bill_count().unwrap(), 0);
        let _ = std::fs::remove_file(&db);
    }

    /// 计费主链规格 R1：预览命中的事实集合 == 重算归因的事实集合（同一谓词）。
    /// 夹具故意放三种不该被移出的事实：`conflict` 证据（E207，单列为仍待确认）、
    /// 已被另一条 saved 声明覆盖的事实（不重复移出）、执行环境自报 subscription 的
    /// 事实（本来就不按量）。此前预览按前端传的统计月窗口、重算按全历史，
    /// 「保存前显示的作用范围」与实际写入对不上。
    #[test]
    fn preview_and_recalculation_select_the_same_facts() {
        let db = tmp_db("billing-preview-equals-recalc");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.conn().execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('r1-run', 1, 'test', 'succeeded', 13);
             INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES('s1', 'codex', 'n1', 'machine', 1000), ('s2', 'codex', 'n2', 'machine', 3000),
                    ('s3', 'codex', 'n3', 'machine', 3500);
             INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 session_key, observation_kind, provider_id, model_id, event_ts_ms, evidence_basis, billing_mode,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES('f-move-1', 'codex', 'machine', 'n1', 'e1', 's1', 'assistant-usage', 'openai', 'model-a', 1000, 'session-native', 'metered', 10, 0, 0, 0, 'r1-run', 1, 1),
                   ('f-move-2', 'codex', 'machine', 'n2', 'e2', 's2', 'assistant-usage', 'openai', 'model-a', 3000, NULL, NULL, 30, 0, 0, 0, 'r1-run', 1, 1),
                   ('f-other-model', 'codex', 'machine', 'n1', 'e3', 's1', 'assistant-usage', 'openai', 'model-b', 2000, 'session-native', 'metered', 20, 0, 0, 0, 'r1-run', 1, 1),
                   ('f-conflict', 'codex', 'machine', 'n1', 'e4', 's1', 'assistant-usage', 'openai', 'model-a', 2500, 'conflict', 'metered', 7, 0, 0, 0, 'r1-run', 1, 1),
                   ('f-covered', 'codex', 'machine', 'n3', 'e5', 's3', 'assistant-usage', 'openai', 'model-a', 3500, 'session-native', 'metered', 50, 0, 0, 0, 'r1-run', 1, 1),
                   ('f-native-sub', 'codex', 'machine', 'n2', 'e6', 's2', 'assistant-usage', 'openai', 'model-a', 3600, 'session-native', 'subscription', 90, 0, 0, 0, 'r1-run', 1, 1);",
        ).unwrap();
        authority.billing_declaration_revision_save(
            "other-rev", "other-decl", None,"openai", "official_subscription",
            None, None, None, "1970-01", Some("1970-01"), None, None, &[("session", "s3")], 2,
        ).unwrap();
        authority.billing_recalculation_enqueue("other-job", "other-decl", "other-rev", 2).unwrap();
        assert!(authority.billing_recalculation_run("other-job", 2).unwrap());
        let covered: Vec<String> = authority.conn().prepare(
            "SELECT fact_id FROM billing_fact_attributions WHERE job_id = 'other-job'",
        ).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(covered, vec!["f-covered".to_string()]);

        let scopes = [("model", "model-a")];
        let preview = authority.billing_declaration_impact_preview_for("openai", "1970-01", Some("1970-12"), &scopes, None,
        ).unwrap();
        assert_eq!(preview.fact_count, 2, "{preview:?}");
        assert_eq!(preview.total_tokens, 40);
        assert_eq!(preview.session_count, 2);
        assert_eq!(preview.conflict_fact_count, 1);
        assert_eq!(preview.conflict_tokens, 7);

        // 本测试验证「模型范围」在预览与重算里同口径，所以用会受模型清单限制的 third_party：
        // official_subscription 现在默认覆盖整个服务商（见 `attribution_scopes`），不再受清单限制。
        authority.billing_declaration_revision_save(
            "r1-rev", "r1-decl", None,"openai", "third_party",
            None, None, None, "1970-01", Some("1970-12"), None, None, &scopes, 3,
        ).unwrap();
        assert_eq!(
            authority.billing_declaration_impact_preview("r1-rev", None).unwrap(), preview,
            "revision-level preview must equal the prospective preview for the same range",
        );
        assert_eq!(
            authority.billing_declaration_matching_fact_ids("r1-rev").unwrap(),
            vec!["f-move-1".to_string(), "f-move-2".to_string()],
        );
        authority.billing_recalculation_enqueue("r1-job", "r1-decl", "r1-rev", 4).unwrap();
        assert!(authority.billing_recalculation_run("r1-job", 5).unwrap());
        let attributed: Vec<String> = authority.conn().prepare(
            "SELECT fact_id FROM billing_fact_attributions WHERE job_id = 'r1-job' ORDER BY fact_id",
        ).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(attributed, vec!["f-move-1".to_string(), "f-move-2".to_string()]);
        let result = authority.billing_recalculation_result("r1-job").unwrap().unwrap();
        assert_eq!((result.2, result.3, result.4), (2, 2, 40), "published snapshot == preview");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_recalculation_job_is_idempotent_and_has_explicit_receipt() {
        let db = tmp_db("billing-recalculation-job");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.billing_declaration_revision_save(
            "revision-job", "declaration-job", None,"openai", "official_api",
            None, None, None, "2026-09", None, None, None, &[], 1,
        ).unwrap();
        assert!(authority.billing_recalculation_enqueue("job-1", "declaration-job", "revision-job", 2).unwrap());
        assert!(!authority.billing_recalculation_enqueue("job-2", "declaration-job", "revision-job", 3).unwrap());
        assert_eq!(authority.billing_recalculation_job("job-1").unwrap().unwrap().3, "queued");
        assert!(authority.billing_recalculation_run("job-1", 4).unwrap());
        assert_eq!(authority.billing_recalculation_job("job-1").unwrap().unwrap().3, "succeeded");
        assert_eq!(authority.billing_recalculation_result("job-1").unwrap().unwrap().2, 0);
        assert!(!authority.billing_recalculation_run("job-1", 5).unwrap());
        assert!(!authority.billing_recalculation_enqueue("job-3", "declaration-job", "revision-job", 6).unwrap(),
            "one revision cannot create a second recalculation job");
        authority.billing_declaration_revision_save(
            // 与上面那条起始月不同：完全一致的声明会被重复保存守卫挡掉（不新建修订）。
            "revision-job-2", "declaration-job-2", None,"openai", "official_api",
            None, None, None, "2026-08", None, None, None, &[], 7,
        ).unwrap();
        assert!(authority.billing_recalculation_enqueue("job-failed", "declaration-job-2", "revision-job-2", 8).unwrap());
        assert!(authority.billing_recalculation_set_status("job-failed", "running", None, None, 9).unwrap());
        assert!(authority.billing_recalculation_set_status("job-failed", "failed", Some("worker_failed"), Some("worker unavailable"), 10).unwrap());
        let job = authority.billing_recalculation_job("job-failed").unwrap().unwrap();
        assert_eq!(job.3, "failed");
        assert_eq!(job.5, Some(9));
        assert_eq!(job.6, Some(10));
        assert_eq!(job.7.as_deref(), Some("worker_failed"));
        assert!(!authority.billing_recalculation_set_status("job-failed", "succeeded", None, None, 11).unwrap());
        assert!(authority.billing_recalculation_retry("job-failed", 12).unwrap());
        let retried = authority.billing_recalculation_job("job-failed").unwrap().unwrap();
        assert_eq!(retried.3, "queued");
        assert_eq!(retried.6, None);
        assert_eq!(retried.7, None);
        assert!(!authority.billing_recalculation_retry("job-1", 13).unwrap(),
            "成功任务不可回退为 queued");
        let queued = authority.billing_recalculation_recover(14).unwrap();
        assert_eq!(queued, vec!["job-failed".to_string()]);
        assert!(authority.billing_recalculation_set_status("job-failed", "running", None, None, 15).unwrap());
        assert_eq!(authority.billing_recalculation_recover(16).unwrap(), Vec::<String>::new());
        assert_eq!(authority.billing_recalculation_job("job-failed").unwrap().unwrap().3, "failed");
        assert_eq!(authority.billing_recalculation_jobs_needing_attention().unwrap().len(), 1);
        let _ = std::fs::remove_file(&db);
    }

    /// 2026-09-16 真机：anthropic 订阅声明「持续有效」，重算 job 只覆盖了保存前的
    /// 22,196 条事实；当晚新会话同步进来 49 条 claude-opus-5 事实没有归因行，待确认
    /// 面板把同一组再弹一遍。修复：同步末尾把当前有效声明套用到水位之后的新事实。
    #[test]
    fn active_declarations_apply_to_facts_synced_after_the_recalculation() {
        let db = tmp_db("billing-apply-active");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        let day = |d: i64| 1_757_000_000_000 + d * 86_400_000; // 2025-09 附近的北京日
        let insert = |id: &str, provider: Option<&str>, model: &str, ts: i64, created: i64| {
            authority.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, provider_id, model_id, event_ts_ms, evidence_basis,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'claude-code', 'm', ?1, ?1, 'assistant-usage', ?2, ?3, ?4, 'missing',
                     10, 0, 0, 0, 'apply-run', ?5, ?5)",
                rusqlite::params![id, provider, model, ts, created],
            ).unwrap();
        };
        authority.conn().execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('apply-run', 1, 'test', 'succeeded', 13);",
        ).unwrap();
        // 保存前已入库的事实 → 重算 job 覆盖。
        insert("f-old", Some("anthropic"), "claude-opus-5", day(1), 100);
        authority.billing_declaration_revision_save(
            "rev-sub", "decl-sub", None,"anthropic", "official_subscription",
            Some("Claude Pro"), Some(2_000), Some("USD"), "2025-07-20", None, None, None,
            &[("model", "claude-opus-5")], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-sub", "decl-sub", "rev-sub", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-sub", 400).unwrap());
        // 「计费方待定」的中转声明（provider=unresolved），同样持续有效。
        insert("g-old", None, "deepseek/deepseek-v4.1-flash", day(1), 100);
        authority.billing_declaration_revision_save(
            "rev-relay", "decl-relay", None,"shengsuanyun", "third_party",
            None, None, None, "2025-09-01", None, None, None,
            &[("provider", "unresolved"), ("model", "deepseek/deepseek-v4.1-flash")], 500,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-relay", "decl-relay", "rev-relay", 600).unwrap();
        assert!(authority.billing_recalculation_run("job-relay", 700).unwrap());
        let count = |kind: &str| -> i64 {
            authority.conn().query_row(
                "SELECT COUNT(*) FROM billing_fact_attributions WHERE attribution_kind = ?1",
                [kind], |row| row.get(0),
            ).unwrap()
        };
        assert_eq!((count("subscription_covered"), count("user_declared")), (1, 1));

        // 之后同步进来的新会话：同 scope 的新事实 + 同服务商的新模型 + 一个别的 provider。
        // 官方订阅默认覆盖整个服务商：`claude-opus-6` 虽然不在声明的模型清单里，也属于订阅覆盖
        // （曾断言「scope 外模型不动」——那正是每个新模型都要用户回来补声明的缺陷）。
        insert("f-new", Some("anthropic"), "claude-opus-5", day(3), 1_000);
        insert("f-other-model", Some("anthropic"), "claude-opus-6", day(3), 1_000);
        insert("g-new", None, "deepseek/deepseek-v4.1-flash", day(3), 1_000);
        insert("h-known", Some("deepseek-official"), "deepseek/deepseek-v4.1-flash", day(3), 1_000);
        let report = authority.billing_apply_active_declarations(2_000).unwrap();
        assert_eq!(report, BillingApplyReport { revisions: 2, attributed: 3 }, "{report:?}");
        let attributed: Vec<(String, String, String)> = authority.conn().prepare(
            "SELECT fact_id, job_id, attribution_kind FROM billing_fact_attributions WHERE created_at_ms = 2000 ORDER BY fact_id",
        ).unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(attributed, vec![
            ("f-new".to_string(), "job-sub".to_string(), "subscription_covered".to_string()),
            ("f-other-model".to_string(), "job-sub".to_string(), "subscription_covered".to_string()),
            ("g-new".to_string(), "job-relay".to_string(), "user_declared".to_string()),
        ], "新事实挂在该修订原来的 job 上；官方订阅覆盖同服务商的新模型；别的 provider 不动");

        // 幂等：再跑一轮零新增。
        assert_eq!(authority.billing_apply_active_declarations(3_000).unwrap(),
            BillingApplyReport { revisions: 2, attributed: 0 });

        // 撤销中转声明后，它不再套用新事实（订阅照常）。
        authority.billing_declaration_revision_revoke("rev-relay-revoke", "decl-relay", "rev-relay", 3_500).unwrap();
        insert("f-later", Some("anthropic"), "claude-opus-5", day(5), 4_000);
        insert("g-later", None, "deepseek/deepseek-v4.1-flash", day(5), 4_000);
        let report = authority.billing_apply_active_declarations(5_000).unwrap();
        assert_eq!(report, BillingApplyReport { revisions: 1, attributed: 1 }, "{report:?}");
        let g_later: i64 = authority.conn().query_row(
            "SELECT COUNT(*) FROM billing_fact_attributions WHERE fact_id = 'g-later'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(g_later, 0, "撤销后的声明不再是规则");

        // 有 effective_end 的声明到期即止：期外事实不套用。
        authority.billing_declaration_revision_save(
            "rev-bounded", "decl-bounded", None,"openai", "official_subscription",
            Some("Plus"), Some(2_000), Some("USD"), "2025-09-01", Some("2025-09-03"), None, None, &[], 6_000,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-bounded", "decl-bounded", "rev-bounded", 6_100).unwrap();
        assert!(authority.billing_recalculation_run("job-bounded", 6_200).unwrap());
        authority.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, provider_id, model_id, event_ts_ms, uncached_input_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('c-late', 'codex', 'm', 'c-late', 'c-late', 'token_count', 'openai', 'gpt-5.6-luna', ?1, 10,
                 'apply-run', 7000, 7000)",
            rusqlite::params![day(40)],
        ).unwrap();
        let report = authority.billing_apply_active_declarations(8_000).unwrap();
        assert_eq!(report.attributed, 0, "期外事实不得被扫进订阅覆盖：{report:?}");
        let _ = std::fs::remove_file(&db);
    }

    fn default_scope_fixture(name: &str) -> (std::path::PathBuf, AuthorityDb) {
        let db = tmp_db(name);
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.conn().execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('dflt-run', 1, 'test', 'succeeded', 13);",
        ).unwrap();
        (db, authority)
    }

    fn put_fact(authority: &AuthorityDb, id: &str, harness: &str, provider: Option<&str>, model: &str, created: i64) {
        authority.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, provider_id, model_id, event_ts_ms, evidence_basis,
                 uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'm', ?1, ?1, 'assistant-usage', ?3, ?4, 1757086400000, 'missing',
                 10, 0, 0, 0, 'dflt-run', ?5, ?5)",
            rusqlite::params![id, harness, provider, model, created],
        ).unwrap();
    }

    fn covered(authority: &AuthorityDb, fact: &str) -> bool {
        authority.conn().query_row(
            "SELECT COUNT(*) FROM billing_fact_attributions WHERE fact_id = ?1", [fact], |r| r.get::<_, i64>(0),
        ).unwrap() > 0
    }

    /// 声明不再绑执行环境之后，「服务商未知」的答复若没有任何收窄范围，就是对所有执行环境、所有未归属用量的
    /// 兜底声明（真机：claude-code 2.46 万、codex 1.72 万、WorkBuddy 3874 条服务商为空的事实都会被吞）。
    /// 所以写入时拒绝，旧库里留下的这类声明则不匹配任何事实。
    #[test]
    fn an_unresolved_provider_answer_without_a_narrowing_scope_is_not_allowed() {
        let (db, authority) = default_scope_fixture("billing-unbounded-unresolved");
        put_fact(&authority, "u-claude", "claude-code", None, "m-a", 100);
        put_fact(&authority, "u-codex", "codex", None, "m-b", 100);
        let save = |id: &str, scopes: &[(&str, &str)]| authority.billing_declaration_revision_save(
            &format!("rev-{id}"), &format!("decl-{id}"), None, "shengsuanyun", "third_party",
            None, None, None, "2025-07-20", None, None, None, scopes, 200,
        );
        // 只有 unresolved（加结算币种）→ 拒绝；任何一种收窄作用域都可以
        assert!(save("bare", &[("provider", "unresolved")]).is_err());
        assert!(save("settle-only", &[("provider", "unresolved"), ("settlement", "CNY")]).is_err());
        assert!(save("model", &[("provider", "unresolved"), ("model", "m-a")]).unwrap());
        assert!(save("session", &[("provider", "unresolved"), ("session", "s-1")]).unwrap());
        // 旧库里已经存在的无收窄声明：选择谓词恒假，宁可不匹配也不吞用量
        let selection = billing_declaration_fact_selection(
            "shengsuanyun", "2025-07-20", None, &[("provider", "unresolved")], None, ConflictEvidence::Exclude,
        );
        assert_eq!(selection.where_sql, "0 = 1");
        let preview = authority.billing_declaration_impact_preview_for(
            "shengsuanyun", "2025-07-20", None, &[("provider", "unresolved")], None,
        ).unwrap();
        assert_eq!(preview.fact_count, 0);
        // 带模型范围的只命中该模型，不会顺带吞 u-codex
        authority.billing_recalculation_enqueue("job-model", "decl-model", "rev-model", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-model", 400).unwrap());
        assert!(covered(&authority, "u-claude") && !covered(&authority, "u-codex"));
        let _ = std::fs::remove_file(&db);
    }

    /// 同一次操作提交两次曾留下两条一模一样的声明（各自又归因了同一批事实）。内容完全一致就不再新建；
    /// 起止、金额、关系种类、作用域任何一项不同都是另一条声明。
    #[test]
    fn saving_an_identical_declaration_twice_keeps_one() {
        let (db, authority) = default_scope_fixture("billing-duplicate-save");
        let save = |id: &str, kind: &str, start: &str, scopes: &[(&str, &str)]| authority.billing_declaration_revision_save(
            &format!("rev-{id}"), &format!("decl-{id}"), None, "minimax", kind,
            None, None, None, start, None, None, None, scopes, 200,
        ).unwrap();
        let scopes = [("provider", "unresolved"), ("model", "MiniMax-M3"), ("settlement", "CNY")];
        assert!(save("a", "official_api", "2026-09-01", &scopes));
        assert!(!save("b", "official_api", "2026-09-01", &scopes), "完全一致 → 不新建");
        // 作用域顺序不同也是同一份
        let shuffled = [("settlement", "CNY"), ("model", "MiniMax-M3"), ("provider", "unresolved")];
        assert!(!save("c", "official_api", "2026-09-01", &shuffled));
        // 任何一项不同都是新的声明
        assert!(save("d", "official_api", "2026-09-02", &scopes), "起始日不同");
        assert!(save("e", "third_party", "2026-09-01", &scopes), "关系种类不同");
        assert!(save("f", "official_api", "2026-09-01", &[("provider", "unresolved"), ("model", "MiniMax-M2.7"), ("settlement", "CNY")]), "模型不同");
        let live = authority.billing_declarations().unwrap();
        assert_eq!(live.len(), 4, "{live:?}");
        // 被挡掉的那次没有留下任何修订
        let revisions: i64 = authority.conn().query_row(
            "SELECT COUNT(*) FROM billing_declaration_revisions WHERE declaration_id IN ('decl-b', 'decl-c')", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(revisions, 0);
        // 撤销后同样内容可以重新声明
        authority.billing_declaration_revision_revoke("rev-revoke-a", "decl-a", "rev-a", 300).unwrap();
        assert!(save("g", "official_api", "2026-09-01", &scopes), "撤销过的声明不再占位");
        let _ = std::fs::remove_file(&db);
    }

    /// 用户要求（2026-10-01）：Anthropic 发新模型不该要求我们发版或用户回来补声明。
    /// 真机：Claude Pro 声明只列了 sonnet-5 / opus-5，`claude-sonnet-5-5` 的 175M token 成了「归属不明」，
    /// 而它的事实早已带着 `provider_id = anthropic`（官方端点证据）。
    /// 用户要求（2026-10-01）：计费绑定在服务商上、按模型使用结算，执行环境只是壳。
    /// 真机里同一个中转账号（shengsuanyun）在 Claude Code 与 Codex 各留一份声明、生效期还各自漂移；
    /// 现在一份声明就够：不看执行环境，任何执行环境上归到该服务商的事实都属于这个账号。
    /// 账号级月费要在 `执行环境/服务商` 键下挑一个落点：用量最集中的执行环境；没有用量则没有落点。
    #[test]
    fn the_dominant_harness_of_a_provider_is_where_its_account_level_fee_is_shown() {
        let (db, authority) = default_scope_fixture("billing-dominant-harness");
        put_fact(&authority, "d1", "codex", Some("relay-x"), "m", 1);
        put_fact(&authority, "d2", "claude-code", Some("relay-x"), "m", 1);
        put_fact(&authority, "d3", "claude-code", Some("relay-x"), "m", 1);
        put_fact(&authority, "d4", "codex", Some("other"), "m", 1);
        assert_eq!(authority.dominant_harness_of_provider("relay-x").unwrap().as_deref(), Some("claude-code"));
        assert_eq!(authority.dominant_harness_of_provider("other").unwrap().as_deref(), Some("codex"));
        assert_eq!(authority.dominant_harness_of_provider("never-used").unwrap(), None);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_billing_declaration_belongs_to_the_provider_not_to_a_harness() {
        let (db, authority) = default_scope_fixture("billing-provider-level");
        put_fact(&authority, "f-claude", "claude-code", Some("shengsuanyun"), "claude-sonnet-5", 100);
        put_fact(&authority, "f-codex", "codex", Some("shengsuanyun"), "gpt-5.6-sol", 100);
        put_fact(&authority, "f-other", "claude-code", Some("minimax"), "MiniMax-M3", 100);
        authority.billing_declaration_revision_save(
            "rev-gw", "decl-gw", None, "shengsuanyun", "third_party",
            None, None, None, "2025-07-20", None, None, None,
            &[("settlement", "CNY")], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-gw", "decl-gw", "rev-gw", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-gw", 400).unwrap());
        assert!(covered(&authority, "f-claude"));
        assert!(covered(&authority, "f-codex"), "同一个服务商账号在另一个执行环境上的用量属于同一份声明");
        assert!(!covered(&authority, "f-other"), "别的服务商不受影响");
        // 预览与重算同一个谓词：不再有「按执行环境」的数
        let preview = authority.billing_declaration_impact_preview("rev-gw", None).unwrap();
        assert_eq!(preview.fact_count, 2);
        // 结算币种按服务商记，不带执行环境
        let settlement = authority.declared_settlement_currencies().unwrap();
        assert_eq!(settlement.get("shengsuanyun").map(String::as_str), Some("CNY"));
        assert!(settlement.keys().all(|key| !key.contains('/')), "{settlement:?}");
        // 存储里的执行环境列是固定占位，没有任何谓词读它；列表行也不再暴露执行环境
        let stored: Vec<String> = authority.conn().prepare("SELECT DISTINCT harness FROM billing_declarations")
            .unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(stored, vec![ALL_HARNESSES.to_string()]);
        let revisions: Vec<String> = authority.conn().prepare("SELECT DISTINCT harness FROM billing_declaration_revisions")
            .unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(revisions, vec![ALL_HARNESSES.to_string()]);
        let _ = std::fs::remove_file(&db);
    }

    /// 「服务商未知」的事实靠模型名认账（MiniMax lite / GLM Lite）：模型是结算依据，执行环境不是。
    #[test]
    fn an_unresolved_provider_answer_matches_the_model_on_any_harness() {
        let (db, authority) = default_scope_fixture("billing-unresolved-any-harness");
        put_fact(&authority, "f-a", "claude-code", None, "MiniMax-M3", 100);
        put_fact(&authority, "f-b", "codex", None, "MiniMax-M3", 100);
        put_fact(&authority, "f-c", "claude-code", None, "some-other-model", 100);
        authority.billing_declaration_revision_save(
            "rev-mm", "decl-mm", None, "minimax", "third_party",
            None, None, None, "2025-07-20", None, None, None,
            &[("provider", "unresolved"), ("model", "MiniMax-M3")], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-mm", "decl-mm", "rev-mm", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-mm", 400).unwrap());
        assert!(covered(&authority, "f-a") && covered(&authority, "f-b"));
        assert!(!covered(&authority, "f-c"), "模型范围仍然收窄：没答过的模型不会被顺带归过来");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn official_subscription_covers_new_models_of_the_same_provider_by_default() {
        let (db, authority) = default_scope_fixture("billing-default-scope");
        put_fact(&authority, "f-listed", "claude-code", Some("anthropic"), "claude-sonnet-5", 100);
        authority.billing_declaration_revision_save(
            "rev-pro", "decl-pro", None,"anthropic", "official_subscription",
            Some("Claude Pro"), Some(2_000), Some("USD"), "2025-07-20", None, None, None,
            &[("model", "claude-sonnet-5")], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-pro", "decl-pro", "rev-pro", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-pro", 400).unwrap());
        // 重算之后才出现的新模型；以及一个「水位之前入库、从未被匹配过」的新模型事实（历史补算）。
        put_fact(&authority, "f-old-new-model", "claude-code", Some("anthropic"), "claude-sonnet-5-5", 250);
        put_fact(&authority, "f-later-new-model", "claude-code", Some("anthropic"), "claude-opus-5-5", 5_000);
        // 别的服务商的事实不能被覆盖；同服务商别的执行环境属于同一个账号，会被覆盖
        put_fact(&authority, "f-other-provider", "claude-code", Some("minimax"), "MiniMax-M3", 5_000);
        put_fact(&authority, "f-other-harness", "codex", Some("anthropic"), "claude-sonnet-5-5", 5_000);
        let report = authority.billing_apply_active_declarations(6_000).unwrap();
        assert_eq!(report.attributed, 3, "{report:?}");
        assert!(covered(&authority, "f-old-new-model"), "历史补算：水位之前入库的新模型事实也要被覆盖");
        assert!(covered(&authority, "f-later-new-model"));
        assert!(!covered(&authority, "f-other-provider"));
        // 订阅是账号级的：别的执行环境上、服务商明确为 anthropic 的事实同样属于这份 Claude Pro
        assert!(covered(&authority, "f-other-harness"), "账号级订阅覆盖该服务商在任何执行环境上的官方路由");
        // 补算只做一次：再跑不新增，也不重复写。
        assert_eq!(authority.billing_apply_active_declarations(7_000).unwrap().attributed, 0);
        let _ = std::fs::remove_file(&db);
    }

    /// 预览命中的事实集合必须等于重算 / 持续套用会归因的集合（计费主链规格 R1）。
    #[test]
    fn preview_matches_the_default_scope_used_by_recalculation() {
        let (db, authority) = default_scope_fixture("billing-default-scope-preview");
        put_fact(&authority, "p1", "claude-code", Some("anthropic"), "claude-sonnet-5", 100);
        put_fact(&authority, "p2", "claude-code", Some("anthropic"), "claude-sonnet-5-5", 100);
        let scopes = [("model", "claude-sonnet-5")];
        let raw = authority.billing_declaration_impact_preview_for("anthropic", "2025-07-20", None, &scopes, None).unwrap();
        let kind = authority.billing_declaration_impact_preview_for_kind("anthropic", "official_subscription", "2025-07-20", None, &scopes, None).unwrap();
        assert_eq!((raw.fact_count, kind.fact_count), (1, 2), "按模型清单只命中 1 条；官方订阅默认覆盖命中 2 条");
        let relay = authority.billing_declaration_impact_preview_for_kind("anthropic", "third_party", "2025-07-20", None, &scopes, None).unwrap();
        assert_eq!(relay.fact_count, 1, "非官方订阅（中转）仍按模型清单");
        let _ = std::fs::remove_file(&db);
    }

    /// 例外 1：`provider=unresolved` 的订阅声明（MiniMax lite / GLM Lite 那类）靠模型名识别「服务商未知」的事实，
    /// 去掉模型限制会把执行环境下所有未知服务商的事实都错判成这个订阅。
    #[test]
    fn unresolved_provider_subscriptions_keep_their_model_list() {
        let (db, authority) = default_scope_fixture("billing-default-scope-unresolved");
        put_fact(&authority, "u-listed", "claude-code", None, "MiniMax-M3", 100);
        authority.billing_declaration_revision_save(
            "rev-mm", "decl-mm", None,"minimax", "official_subscription",
            Some("MiniMax lite"), Some(4_400), Some("CNY"), "2025-07-20", None, None, None,
            &[("provider", "unresolved"), ("model", "MiniMax-M3")], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-mm", "decl-mm", "rev-mm", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-mm", 400).unwrap());
        put_fact(&authority, "u-unrelated", "claude-code", None, "deepseek/deepseek-v4.1-flash", 5_000);
        authority.billing_apply_active_declarations(6_000).unwrap();
        assert!(!covered(&authority, "u-unrelated"), "未知服务商的其他模型不能被 MiniMax 订阅吞掉");
        let _ = std::fs::remove_file(&db);
    }

    /// 例外 2：同执行环境同服务商还有官方 API 声明时，订阅 / API Key 无从区分，不替用户猜。
    #[test]
    fn a_coexisting_official_api_declaration_keeps_the_explicit_model_list() {
        let (db, authority) = default_scope_fixture("billing-default-scope-api");
        put_fact(&authority, "a-listed", "claude-code", Some("anthropic"), "claude-sonnet-5", 100);
        authority.billing_declaration_revision_save(
            "rev-api", "decl-api", None,"anthropic", "official_api",
            None, None, None, "2025-07-20", None, None, None, &[], 150,
        ).unwrap();
        authority.billing_declaration_revision_save(
            "rev-pro2", "decl-pro2", None,"anthropic", "official_subscription",
            Some("Claude Pro"), Some(2_000), Some("USD"), "2025-07-20", None, None, None,
            &[("model", "claude-sonnet-5")], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-pro2", "decl-pro2", "rev-pro2", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-pro2", 400).unwrap());
        put_fact(&authority, "a-new", "claude-code", Some("anthropic"), "claude-sonnet-5-5", 5_000);
        authority.billing_apply_active_declarations(6_000).unwrap();
        assert!(!covered(&authority, "a-new"), "订阅与 API 并存：新模型保持待确认，不自动算订阅覆盖");
        let _ = std::fs::remove_file(&db);
    }

    /// 用户观察（2026-10-01）：执行环境读自家模型，模型名不带服务商前缀；第三方云厂商 / 中转才加
    /// `provider/` 路径前缀。所以 ZCode 的 `GLM-5.3`、Codex 的 `gpt-5.6-terra` 即使没有路由证据
    /// （`provider_id` 为 NULL），也是执行环境自家官方路由——官方订阅默认覆盖它们；而带前缀的、
    /// 以及执行环境读别家系列的（claude-code 下的 deepseek）都是第三方，不能被吞掉。
    #[test]
    fn official_subscription_also_covers_native_models_that_lack_a_provider() {
        let (db, authority) = default_scope_fixture("billing-default-scope-native");
        // 真机分布：ZCode 的 GLM（provider 为空）、Codex 的 gpt（少量为空）
        put_fact(&authority, "z-native", "harness:zcode", None, "GLM-5.3", 100);
        put_fact(&authority, "z-native-lower", "harness:zcode", None, "glm-5.3-flash", 100);
        put_fact(&authority, "z-gateway", "harness:zcode", None, "bigmodel/glm-5.3-flash", 100);
        put_fact(&authority, "z-foreign-family", "harness:zcode", None, "deepseek-v4-flash", 100);
        put_fact(&authority, "x-native-null", "codex", None, "gpt-5.6-terra", 100);
        put_fact(&authority, "x-prefixed-own-vendor", "codex", None, "openai/gpt-5.6-luna", 100);
        put_fact(&authority, "x-relay-family", "codex", None, "deepseek/deepseek-v4.1-flash", 100);
        put_fact(&authority, "c-foreign-family", "claude-code", None, "deepseek-v4-flash", 100);
        put_fact(&authority, "c-glm-via-claude", "claude-code", None, "glm-5.3-flash", 100);
        authority.billing_declaration_revision_save(
            "rev-glm", "decl-glm", None,"zhipu-glm", "official_subscription",
            Some("GLM Lite"), Some(11_800), Some("CNY"), "2025-07-20", None, None, None, &[], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-glm", "decl-glm", "rev-glm", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-glm", 400).unwrap());
        authority.billing_declaration_revision_save(
            "rev-plus", "decl-plus", None,"openai", "official_subscription",
            Some("ChatGPT Plus"), Some(2_000), Some("USD"), "2025-07-20", None, None, None, &[], 210,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-plus", "decl-plus", "rev-plus", 310).unwrap();
        assert!(authority.billing_recalculation_run("job-plus", 410).unwrap());
        authority.billing_apply_active_declarations(6_000).unwrap();
        for id in ["z-native", "z-native-lower", "x-native-null"] {
            assert!(covered(&authority, id), "{id}：执行环境原生模型，服务商为空也应被官方订阅覆盖");
        }
        for id in ["z-gateway", "z-foreign-family", "x-prefixed-own-vendor", "x-relay-family", "c-foreign-family", "c-glm-via-claude"] {
            assert!(!covered(&authority, id), "{id}：带前缀 / 非原生系列是第三方路由，不能被默认覆盖吞掉");
        }
        // 预览与重算同口径（带 native 开关）
        let preview = authority.billing_declaration_impact_preview_for_kind("zhipu-glm", "official_subscription", "2025-07-20", None, &[], None,
        ).unwrap();
        assert_eq!(preview.fact_count, 0, "已经被覆盖的事实不再重复计入预览");
        let _ = std::fs::remove_file(&db);
    }

    /// 用户（2026-10-01）：订阅属于账号，不属于执行环境——GLM Lite 在 Claude Code 里声明，ZCode 也在用这份套餐。
    #[test]
    fn a_subscription_declared_on_one_harness_covers_the_providers_native_models_on_another() {
        let (db, authority) = default_scope_fixture("billing-account-level");
        put_fact(&authority, "z-native", "harness:zcode", None, "GLM-5.3", 100);
        put_fact(&authority, "z-gateway", "harness:zcode", None, "bigmodel/glm-5.3-flash", 100);
        put_fact(&authority, "x-glm-on-codex", "codex", None, "glm-5.3", 100);
        put_fact(&authority, "c-listed", "claude-code", None, "glm-5.3-flash", 100);
        put_fact(&authority, "c-unlisted", "claude-code", None, "glm-5.4", 100);
        authority.billing_declaration_revision_save(
            "rev-glm2", "decl-glm2", None,"zhipu-glm", "official_subscription",
            Some("GLM Lite"), Some(11_800), Some("CNY"), "2025-07-20", None, None, None,
            &[("provider", "unresolved"), ("model", "glm-5.3-flash")], 200,
        ).unwrap();
        authority.billing_recalculation_enqueue("job-glm2", "decl-glm2", "rev-glm2", 300).unwrap();
        assert!(authority.billing_recalculation_run("job-glm2", 400).unwrap());
        authority.billing_apply_active_declarations(6_000).unwrap();
        assert!(covered(&authority, "z-native"), "ZCode 的原生 GLM 属于同一份 GLM Lite（账号级）");
        assert!(covered(&authority, "c-listed"), "原来的显式作答（Claude Code 下列出的模型）照旧");
        assert!(!covered(&authority, "c-unlisted"), "显式作答不自动扩到清单外的未知服务商模型");
        assert!(!covered(&authority, "z-gateway"), "带前缀 = 第三方路由");
        assert!(!covered(&authority, "x-glm-on-codex"), "别的执行环境上服务商未知的 GLM 模型不是原生，显式作答不跨执行环境");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn attribution_scopes_only_drops_model_scopes_for_plain_official_subscriptions() {
        let scopes = [("model", "m1"), ("route", "r1"), ("account", "a1")];
        assert_eq!(attribution_scopes("official_subscription", &scopes, false), vec![("route", "r1"), ("account", "a1")], "账户 / 路由范围保留");
        assert_eq!(attribution_scopes("official_subscription", &scopes, true), scopes.to_vec(), "有官方 API 声明时让位");
        assert_eq!(attribution_scopes("third_party", &scopes, false), scopes.to_vec());
        assert_eq!(attribution_scopes("official_api", &scopes, false), scopes.to_vec());
        let unresolved = [("provider", "unresolved"), ("model", "m1")];
        assert_eq!(attribution_scopes("official_subscription", &unresolved, false), unresolved.to_vec());
    }

    /// 2026-09-16 真机：anthropic 候选被有效声明 decl 占着，用户点了「重新打开」→ 候选回
    /// pending、声明照旧有效 → 待确认再问一遍，而任何新声明都撞「already used by
    /// another live declaration」。候选被有效声明占着就是 accepted；重新打开必须指向撤销声明。
    #[test]
    fn candidate_held_by_live_declaration_cannot_be_reopened_and_heals_to_accepted() {
        let db = tmp_db("billing-candidate-claim-consistency");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.billing_import_candidate_put(
            "cand-held", "claude-code", "anthropic", "USD", 2_000, "2025-07", "uat", 1,
        ).unwrap();
        assert!(authority.billing_declaration_revision_save(
            "rev-held", "decl-held", None,"anthropic", "official_subscription",
            Some("Claude Pro"), Some(2_000), Some("USD"), "2025-07-20", None, Some("cand-held"), None, &[], 2,
        ).unwrap());
        let status = |id: &str| -> String {
            authority.conn().query_row(
                "SELECT status FROM billing_import_candidates WHERE candidate_id = ?1", [id], |r| r.get(0),
            ).unwrap()
        };
        assert_eq!(status("cand-held"), "accepted");
        let err = authority.billing_import_candidate_reopen("cand-held", 3).unwrap_err().to_string();
        assert!(err.contains("decl-held") && err.contains("revoke"), "{err}");
        assert_eq!(status("cand-held"), "accepted", "拒绝重新打开不得半改状态");

        // 复现旧版本留下的分裂态：候选 pending、声明仍有效 → 自愈回 accepted。
        authority.conn().execute(
            "UPDATE billing_import_candidates SET status = 'pending' WHERE candidate_id = 'cand-held'", [],
        ).unwrap();
        assert_eq!(authority.reconcile_candidate_claims(4).unwrap(), 1);
        assert_eq!(status("cand-held"), "accepted");
        assert_eq!(authority.reconcile_candidate_claims(5).unwrap(), 0, "幂等");

        // 第二条新声明再引用同一张候选：保存路径的 release 不得把它翻回 pending。
        let err = authority.billing_declaration_revision_save(
            "rev-dup", "decl-dup", None,"anthropic", "official_subscription",
            None, Some(2_000), Some("USD"), "2025-07-20", None, Some("cand-held"), None, &[], 6,
        ).unwrap_err().to_string();
        assert!(err.contains("another live declaration"), "{err}");
        assert_eq!(status("cand-held"), "accepted");

        // 撤销声明才释放候选；释放后可重新打开/重新声明。
        assert!(authority.billing_declaration_revision_revoke("rev-held-revoke", "decl-held", "rev-held", 7).unwrap());
        assert_eq!(status("cand-held"), "pending");
        assert_eq!(authority.reconcile_candidate_claims(8).unwrap(), 0, "没有有效声明占着，不得把它翻回 accepted");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn uncertain_candidate_stays_pending_without_a_declaration() {
        let db = tmp_db("billing-uncertain-candidate");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.billing_import_candidate_put(
            "cand-uncertain", "codex", "openai", "USD", 2_000, "2026-09", "test", 1,
        ).unwrap();
        assert!(authority.billing_declaration_revision_save(
            "rev-uncertain", "decl-uncertain", None,"openai", "unknown",
            None, None, None, "2026-09-01", None, Some("cand-uncertain"), None, &[], 2,
        ).is_err());
        let status: String = authority.conn().query_row(
            "SELECT status FROM billing_import_candidates WHERE candidate_id = 'cand-uncertain'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(status, "pending");
        assert_eq!(authority.billing_declaration_revisions("decl-uncertain").unwrap().len(), 0);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_recalculation_failure_after_running_is_terminal_and_retryable() {
        let db = tmp_db("billing-recalculation-transaction-failure");
        let authority = AuthorityDb::open(&db, 1).unwrap();
        authority.billing_declaration_revision_save(
            "revision-transaction-failure", "declaration-transaction-failure", None,"openai", "official_api", None, None, None, "2026-09", None,
            None, None, &[], 1,
        ).unwrap();
        assert!(authority.billing_recalculation_enqueue(
            "job-transaction-failure", "declaration-transaction-failure",
            "revision-transaction-failure", 2,
        ).unwrap());
        authority.conn().execute_batch("DROP TABLE billing_recalculation_results").unwrap();

        assert!(authority.billing_recalculation_run("job-transaction-failure", 3).is_err());
        let failed = authority.billing_recalculation_job("job-transaction-failure").unwrap().unwrap();
        assert_eq!(failed.3, "failed");
        assert_eq!(failed.7.as_deref(), Some("transaction_failed"));
        assert_eq!(failed.6, Some(3));
        assert!(authority.billing_recalculation_retry("job-transaction-failure", 4).unwrap());
        assert_eq!(authority.billing_recalculation_job("job-transaction-failure").unwrap().unwrap().3, "queued");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v2_database_migrates_to_current_schema_and_preserves_facts() {
        let db = tmp_db("v2-to-v3");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute_batch("INSERT INTO schema_meta(key, value) VALUES('schema_version', '2');")
            .unwrap();
        conn.execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('migration-fixture', 1, 'migration', 'succeeded', 2);
             INSERT INTO usage_facts(
               fact_id, harness, machine_namespace, native_session_id, source_event_id,
               observation_kind, uncached_input_tokens, cache_read_tokens,
               cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES('fact-preserve', 'codex', 'ns', 'session', 'event', 'assistant-usage',
                    11, 22, 33, 44, 'migration-fixture', 1, 1);",
        )
        .unwrap();
        conn.execute_batch("COMMIT;").unwrap();
        drop(conn);

        let upgraded = AuthorityDb::open(&db, 2_000).unwrap();
        let version: String = upgraded
            .conn()
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        let index_exists: i64 = upgraded
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'data_quality_issues_open_code_scope'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(index_exists, 1, "missing data-status correlation index");
        for column in [
            "provider_raw",
            "billing_source",
            "billing_mode",
            "pricing_basis",
            "evidence_basis",
            "normalization_version",
            "route_evidence_id",
            "attribution_version",
            "billing_template_id",
        ] {
            let found: i64 = upgraded
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('usage_facts') WHERE name = ?1",
                    [column],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "missing migrated column {column}");
        }
        let preserved: (i64, i64, i64, i64, i64) = upgraded
            .conn()
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(uncached_input_tokens), 0),
                        COALESCE(SUM(cache_read_tokens), 0),
                        COALESCE(SUM(cache_write_tokens), 0),
                        COALESCE(SUM(output_tokens), 0)
                 FROM usage_facts WHERE fact_id = 'fact-preserve'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(preserved, (1, 11, 22, 33, 44));
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn v3_database_migrates_to_v4_without_assigning_historical_templates() {
        let db = tmp_db("v3-to-v4");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute_batch(SCHEMA_V3_ADD).unwrap();
        conn.execute_batch("INSERT INTO schema_meta(key, value) VALUES('schema_version', '3');")
            .unwrap();
        conn.execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES('migration-fixture', 1, 'migration', 'succeeded', 3);
             INSERT INTO usage_facts(
               fact_id, harness, machine_namespace, native_session_id, source_event_id,
               observation_kind, uncached_input_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES('fact-v3', 'codex', 'ns', 'session', 'event', 'assistant-usage',
                    88, 'migration-fixture', 1, 1);",
        ).unwrap();
        conn.execute_batch("COMMIT;").unwrap();
        drop(conn);

        let upgraded = AuthorityDb::open(&db, 2_000).unwrap();
        let template_id: Option<String> = upgraded.conn().query_row(
            "SELECT billing_template_id FROM usage_facts WHERE fact_id = 'fact-v3'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(template_id, None);
        for table in ["provider_catalog_snapshots", "billing_templates", "billing_template_snapshots",
            "outcome_measurements", "savings_records"] {
            let found: i64 = upgraded.conn().query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table], |r| r.get(0),
            ).unwrap();
            assert_eq!(found, 1, "missing v4 table {table}");
        }
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_catalog_and_template_snapshots_are_immutable_and_referential() {
        let db = tmp_db("billing-snapshots");
        let authority = AuthorityDb::open(&db, 1_000).unwrap();
        assert!(authority.provider_catalog_snapshot_put(
            "catalog-1", "bc1-abc", "official", "{\"providers\":[]}", 1_000,
        ).unwrap());
        assert!(!authority.provider_catalog_snapshot_put(
            "catalog-1", "bc1-abc", "official", "{\"providers\":[]}", 2_000,
        ).unwrap());
        assert!(authority.provider_catalog_snapshot_put(
            "catalog-1", "bc1-other", "official", "{}", 2_000,
        ).is_err());
        assert!(authority.billing_template_put(
            "template-1", "openai", Some("acct-hash"), "metered_api", "official", 0, None, 1_000,
        ).unwrap());
        assert!(!authority.billing_template_put(
            "template-1", "openai", Some("acct-hash"), "metered_api", "official", 0, None, 2_000,
        ).unwrap());
        assert!(authority.billing_template_put(
            "template-1", "openai", Some("acct-hash"), "custom", "official", 0, None, 2_000,
        ).is_err());
        assert!(authority.billing_template_put(
            "template-invalid", "openai", None, "subscription", "official", 0, None, 1_000,
        ).is_err());
        assert!(authority.billing_template_snapshot_put(
            "bts1-abc", "template-1", Some("catalog-1"), "{\"kind\":\"metered_api\"}", 1_000,
        ).unwrap());
        assert!(authority.billing_template_snapshot_put(
            "bts1-abc", "template-1", Some("catalog-1"), "{}", 2_000,
        ).is_err());
        assert!(authority.billing_template_snapshot_put(
            "bad", "missing", Some("catalog-1"), "{}", 1_000,
        ).is_err());
        assert!(authority.conn().execute(
            "INSERT INTO pricing_snapshots(pricing_version, captured_at_ms, source_kind, payload_json, catalog_version)
             VALUES ('bad-catalog', 1, 'test', '{}', 'missing')", [],
        ).is_err());
        assert!(authority.conn().execute(
            "INSERT INTO pricing_snapshots(pricing_version, captured_at_ms, source_kind, payload_json, billing_template_id)
             VALUES ('bad-template', 1, 'test', '{}', 'missing')", [],
        ).is_err());
        assert_eq!(authority.conn().execute(
            "INSERT INTO pricing_snapshots(pricing_version, captured_at_ms, source_kind, payload_json, catalog_version, billing_template_id)
             VALUES ('priced-template', 1, 'test', '{}', 'catalog-1', 'template-1')", [],
        ).unwrap(), 1);
        assert!(authority.pricing_snapshot_put_with_provenance(
            "api-priced-template", "test", "{}", 2_000, Some("catalog-1"), Some("template-1"),
        ).unwrap());
        assert!(authority.pricing_snapshot_put_with_provenance(
            "api-orphan", "test", "{}", 2_000, Some("missing"), None,
        ).is_err());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn savings_cannot_upgrade_an_estimate_to_actual_or_realized() {
        let db = tmp_db("savings-evidence");
        let authority = AuthorityDb::open(&db, 1_000).unwrap();
        assert!(authority.outcome_measurement_put(
            "outcome-est", "facts-1", "cost-v1", "estimated", Some(123), Some("USD"), 1_000, "{}",
        ).unwrap());
        assert!(authority.savings_record_put(
            "saving-est", "outcome-est", None, None, 123, "USD", "estimated", 1_000,
        ).unwrap());
        assert!(authority.savings_record_put(
            "saving-actual", "outcome-est", None, None, 123, "USD", "actual", 1_000,
        ).is_err());
        assert!(authority.outcome_measurement_put(
            "outcome-actual", "facts-2", "invoice-v1", "actual", Some(456), Some("USD"), 2_000, "{}",
        ).unwrap());
        assert!(authority.savings_record_put(
            "saving-actual", "outcome-actual", None, None, 456, "USD", "actual", 2_000,
        ).unwrap());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn corrupted_database_is_reported_not_deleted() {
        // 与旧 store 的关键差异：损坏 → 报错走恢复流程，绝不静默删库重建。
        let db = tmp_db("corrupt");
        std::fs::write(&db, b"NOT A SQLITE DATABASE AT ALL____garbage").unwrap();
        let err = AuthorityDb::open(&db, 1_000).unwrap_err();
        assert!(
            matches!(err, AuthorityError::Sqlite(_)),
            "损坏必须以 Sqlite 错误上抛（不自愈），got {err:?}"
        );
        // 文件原样保留（用户备份/取证）。
        assert!(db.exists());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn partial_schema_from_interrupted_creation_is_rejected() {
        let db = tmp_db("partial");
        // 模拟建库中途死掉：有业务表但没有版本行。
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE usage_facts (fact_id TEXT PRIMARY KEY);")
            .unwrap();
        drop(conn);
        let err = AuthorityDb::open(&db, 1_000).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("__corrupt_partial_schema__"), "got {msg}");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn newer_schema_is_rejected_not_downgraded() {
        let db = tmp_db("newer");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta VALUES('schema_version', '99');",
            )
            .unwrap();
        }
        let err = AuthorityDb::open(&db, 1_000).unwrap_err();
        assert!(
            matches!(err, AuthorityError::NewerSchema { found: 99, .. }),
            "got {err:?}"
        );
        let _ = std::fs::remove_file(&db);
    }

    // ── open_readonly（Data MCP 只读取数面，spec §9.3）────────────────

    #[test]
    fn open_readonly_missing_file_is_typed() {
        let db = tmp_db("ro-missing");
        assert!(matches!(
            AuthorityDb::open_readonly(&db).unwrap_err(),
            AuthorityError::MissingFile
        ));
        // 缺文件时**不建库**（与 `open` 的关键区别）。
        assert!(!db.exists());
    }

    #[test]
    fn open_readonly_opens_a_valid_db_and_forbids_writes() {
        let db = tmp_db("ro-valid");
        AuthorityDb::open(&db, 1_000).unwrap(); // 先正常建库
        let ro = AuthorityDb::open_readonly(&db).unwrap();
        // 只读连接：写语句必须失败。
        let write = ro
            .conn()
            .execute("INSERT INTO schema_meta(key, value) VALUES('x','y')", []);
        assert!(write.is_err(), "read-only connection must reject writes");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn open_readonly_reports_corrupt_for_garbage_and_half_built() {
        let garbage = tmp_db("ro-garbage");
        std::fs::write(&garbage, b"NOT A SQLITE DATABASE").unwrap();
        assert!(matches!(
            AuthorityDb::open_readonly(&garbage).unwrap_err(),
            AuthorityError::Corrupt
        ));
        let _ = std::fs::remove_file(&garbage);

        let half = tmp_db("ro-half");
        rusqlite::Connection::open(&half)
            .unwrap()
            .execute_batch("CREATE TABLE usage_facts (fact_id TEXT PRIMARY KEY);")
            .unwrap();
        assert!(matches!(
            AuthorityDb::open_readonly(&half).unwrap_err(),
            AuthorityError::Corrupt
        ));
        let _ = std::fs::remove_file(&half);
    }

    #[test]
    fn existing_v1_db_picks_up_safe_views_on_reopen() {
        // 增量 7.5：v1 库已存在的情况下，再开一次应该把 v_*_safe view
        // 幂等加进去（review 增量 7.5：migrate 路径不阻塞）。
        let path = tmp_db("v1-views");
        let db = AuthorityDb::open(&path, 1_000).unwrap();
        // 先关掉 + 重新打开。
        drop(db);
        let db2 = AuthorityDb::open(&path, 1_001).unwrap();
        let n: i64 = db2
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='view' AND name IN ('v_facts_safe', 'v_sessions_safe', 'v_data_quality_safe', 'v_sync_runs_safe')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 4, "v_*_safe views 应在二次 open 时被幂等加进去");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn open_readonly_distinguishes_newer_and_older_schema() {
        let newer = tmp_db("ro-newer");
        rusqlite::Connection::open(&newer)
            .unwrap()
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta VALUES('schema_version', '99');",
            )
            .unwrap();
        assert!(matches!(
            AuthorityDb::open_readonly(&newer).unwrap_err(),
            AuthorityError::NewerSchema { found: 99, .. }
        ));
        let _ = std::fs::remove_file(&newer);

        let older = tmp_db("ro-older");
        rusqlite::Connection::open(&older)
            .unwrap()
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta VALUES('schema_version', '0');",
            )
            .unwrap();
        assert!(matches!(
            AuthorityDb::open_readonly(&older).unwrap_err(),
            AuthorityError::OlderSchema { found: 0 }
        ));
        let _ = std::fs::remove_file(&older);
    }

    #[test]
    fn retention_deletes_only_dated_rows_older_than_cutoff() {
        let db = tmp_db("retention");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        a.begin_run("run-1", "cli", 1_000).unwrap();
        a.with_immediate_txn(|conn| {
            // 三行：旧（< cutoff）、新（≥ cutoff）、无日期（§5.4 不静默删）。
            for (rid, ts) in [
                ("f-old", Some(500_i64)),
                ("f-new", Some(9_999_i64)),
                ("f-nodate", None),
            ] {
                conn.execute(
                    "INSERT INTO usage_facts(fact_id, harness, machine_namespace,
                         native_session_id, source_event_id, observation_kind,
                         event_ts_ms, ingested_run_id, created_at_ms, updated_at_ms)
                     VALUES (?1,'dsh','ns','s',?1,'token_count',?2,'run-1',1,1)",
                    rusqlite::params![rid, ts],
                )
                .unwrap();
            }
            Ok(())
        })
        .unwrap();
        let n = a.retention_usage_facts(5_000).unwrap();
        assert_eq!(n, 1, "只删 event_ts_ms < cutoff 的行");
        let left: i64 = a
            .conn()
            .query_row("SELECT COUNT(*) FROM usage_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 2, "新行与无日期行保留");
        // 幂等：再跑删 0 行。
        assert_eq!(a.retention_usage_facts(5_000).unwrap(), 0);
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn delete_imported_harness_data_is_scoped_and_reimportable() {
        let path = tmp_db("delete-imported-harness");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.conn().execute_batch(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES ('run', 1, 'test', 'succeeded', 12);
             INSERT INTO source_files(source_id, harness, path_hash, size_bytes, mtime_ns, parser_version, first_seen_at_ms, last_seen_at_ms) VALUES
               ('source-codex', 'codex', 'c', 1, 1, 1, 1, 1), ('source-dsh', 'dsh', 'd', 1, 1, 1, 1, 1);
             INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms) VALUES
               ('session-codex', 'codex', 'c', 'm', 1), ('session-dsh', 'dsh', 'd', 'm', 1);
             INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key, source_event_id, observation_kind, source_id, ingested_run_id, created_at_ms, updated_at_ms) VALUES
               ('fact-codex', 'codex', 'm', 'c', 'session-codex', 'e1', 'usage', 'source-codex', 'run', 1, 1),
               ('fact-dsh', 'dsh', 'm', 'd', 'session-dsh', 'e2', 'usage', 'source-dsh', 'run', 1, 1);
             INSERT INTO trust_observations(
                 observation_id, machine_namespace, harness, actor_id, actor_kind,
                 observed_at_ms, observation_kind, stage, evidence_level,
                 scope_classes_json, consent_state, collector_id, collector_version,
                 provenance_json, ingested_run_id, created_at_ms
             ) VALUES
               ('trust-codex', 'm', 'codex', 'actor-codex', 'sidecar', 1, 'package',
                'package_observed', 'E1', '[]', 'unavailable', 'test', 'v1', '{}', 'run', 1),
               ('trust-dsh', 'm', 'dsh', 'actor-dsh', 'sidecar', 1, 'package',
                'package_observed', 'E1', '[]', 'unavailable', 'test', 'v1', '{}', 'run', 1);"
        ).unwrap();
        db.conn().execute(
            "INSERT INTO route_evidence(
                evidence_id, harness, machine_namespace, native_session_id,
                evidence_basis, observed_at_ms, ingested_run_id
             ) VALUES ('route-codex', 'codex', 'm', 'c', 'test', 1, 'run')",
            [],
        ).unwrap();
        db.conn().execute(
            "UPDATE usage_facts SET route_evidence_id = 'route-codex' WHERE fact_id = 'fact-codex'",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO session_excerpts(session_key, ordinal, role, excerpt, provenance, ingested_run_id)
             VALUES ('session-codex', 0, 'user_first', 'redacted', 'scrubbed', 'run')",
            [],
        ).unwrap();
        db.harness_bill_put("bill-dsh", "dsh", "deepseek", "2026-09", "metered_actual", 100, "CNY", "user:receipt", 2).unwrap();
        assert_eq!(db.delete_imported_harness_data("codex", 3).unwrap(), HarnessImportedDataDeletion { facts: 1, sessions: 1, source_files: 1, trust_observations: 1, route_evidence: 1, session_excerpts: 1 });
        let (codex_live, dsh_live, sources): (i64, i64, i64) = db.conn().query_row(
            "SELECT SUM(harness = 'codex' AND deleted_at_ms IS NULL), SUM(harness = 'dsh' AND deleted_at_ms IS NULL), COUNT(*) FROM usage_facts", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!((codex_live, dsh_live, sources), (0, 1, 2));
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM source_files WHERE harness = 'codex'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM session_excerpts WHERE session_key = 'session-codex'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM route_evidence WHERE harness = 'codex'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM trust_observations WHERE harness = 'dsh'", [], |r| r.get::<_, i64>(0)).unwrap(), 1, "other harness trust observations remain");
        assert_eq!(db.harness_bill_count().unwrap(), 1, "manual bills are not imported source data");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn retention_trust_observations_expires_evidence_links_only() {
        let path = tmp_db("trust-retention");
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "test", 1).unwrap();
        db.with_immediate_txn(|conn| {
            conn.execute_batch(
                "INSERT INTO trust_observations(
                    observation_id, machine_namespace, harness, actor_id, actor_kind,
                    observed_at_ms, observation_kind, stage, evidence_level,
                    scope_classes_json, consent_state, collector_id, collector_version,
                    provenance_json, expires_at_ms, ingested_run_id, created_at_ms
                 ) VALUES
                    ('expired', 'machine', 'zcode', 'actor', 'sidecar', 1, 'package',
                     'package_observed', 'E1', '[]', 'unavailable', 'test', 'v1', '{}', 2, 'run', 1),
                    ('live', 'machine', 'zcode', 'actor', 'sidecar', 1, 'package',
                     'package_observed', 'E1', '[]', 'unavailable', 'test', 'v1', '{}', NULL, 'run', 1);",
            )?;
            let issue_id = crate::issues::upsert_issue(conn, &crate::issues::IssueInput {
                machine_namespace: "machine", harness: "zcode", session_key: None,
                issue_type: "SV702", instance_fingerprint: "trust-retention", status: "open",
                severity: "warning", evaluator_id: "trust", evaluator_version: "v1",
                evidence_fingerprint: "evidence", opened_at_ms: 1, metadata_json: "{}",
            })?;
            conn.execute(
                "INSERT INTO trust_issue_evidence(issue_id, observation_id, evidence_role, linked_at_ms)
                 VALUES(?1, 'expired', 'supporting', 1)",
                [issue_id],
            )?;
            Ok(())
        }).unwrap();
        assert_eq!(db.retention_trust_observations(3).unwrap(), 1);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM trust_observations", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM trust_issue_evidence", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM issue_instances", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(db.retention_trust_observations(3).unwrap(), 0, "重复清理必须幂等");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn immediate_txn_rolls_back_on_error() {
        let db = tmp_db("txn");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        a.begin_run("run-1", "cli", 1_000).unwrap();
        let err: Result<(), AuthorityError> = a.with_immediate_txn(|conn| {
            conn.execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run-2', 1000, 'cli', 'running', 1)",
                [],
            )
            .map_err(AuthorityError::from)?;
            Err(AuthorityError::Sqlite(
                rusqlite::Error::InvalidParameterName("boom".to_string()),
            ))
        });
        assert!(err.is_err());
        let n: i64 = a
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sync_runs WHERE run_id = 'run-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "回滚后不得有半提交残留");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn budget_config_crud_roundtrip_and_overwrite() {
        let db = tmp_db("bcfg");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        assert!(a.budget_config_get().unwrap().is_none(), "新库无配置");
        a.budget_config_set(60_000, 3_000, 8_000, 2_000).unwrap();
        let c = a.budget_config_get().unwrap().expect("seed 后有配置");
        assert_eq!(
            (
                c.monthly_cny_minor,
                c.daily_cny_minor,
                c.warning_ratio_bp,
                c.updated_at_ms
            ),
            (60_000, 3_000, 8_000, 2_000)
        );
        // upsert 覆盖 + updated_at_ms 滚动（第二次 set 的时钟是 3_000）。
        a.budget_config_set(61_000, 3_100, 9_000, 3_000).unwrap();
        let c2 = a.budget_config_get().unwrap().unwrap();
        assert_eq!(
            (
                c2.monthly_cny_minor,
                c2.daily_cny_minor,
                c2.warning_ratio_bp,
                c2.updated_at_ms
            ),
            (61_000, 3_100, 9_000, 3_000)
        );
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn budget_profiles_keep_estimate_and_confirmed_currencies_separate() {
        let db = tmp_db("budget-profiles");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        a.budget_profile_set("estimate", "CNY", 60_000, Some(3_000), 8_000, 2_000).unwrap();
        a.budget_profile_set("confirmed", "USD", 10_000, None, 9_000, 3_000).unwrap();
        assert_eq!(a.budget_profiles_get().unwrap(), vec![
            BudgetProfile {
                profile_id: "confirmed".into(), currency: "USD".into(), monthly_minor: 10_000,
                daily_minor: None, warning_ratio_bp: 9_000, updated_at_ms: 3_000,
            },
            BudgetProfile {
                profile_id: "estimate".into(), currency: "CNY".into(), monthly_minor: 60_000,
                daily_minor: Some(3_000), warning_ratio_bp: 8_000, updated_at_ms: 2_000,
            },
        ]);
        assert!(a.budget_profile_set("estimate", "CN", 1, None, 8_000, 4_000).is_err());
        assert!(a.budget_profile_set("estimate", "USD", 0, None, 8_000, 4_000).is_err());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn deleting_estimate_budget_preserves_confirmed_profile() {
        let db = tmp_db("budget-disable");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        a.budget_profile_set("estimate", "CNY", 60_000, None, 8_000, 2_000).unwrap();
        a.budget_profile_set("confirmed", "USD", 10_000, None, 8_000, 2_000).unwrap();
        assert!(a.budget_profile_delete("estimate").unwrap());
        assert!(!a.budget_profile_delete("estimate").unwrap());
        assert_eq!(a.budget_profiles_get().unwrap().len(), 1);
        assert_eq!(a.budget_profiles_get().unwrap()[0].profile_id, "confirmed");
        assert!(a.budget_profile_delete("confirmed").is_err());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn budget_snooze_set_get_clear() {
        let db = tmp_db("bsnz");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        assert!(a.budget_snooze_get().unwrap().is_none());
        a.budget_snooze_set(9_999, 1_000).unwrap();
        assert_eq!(a.budget_snooze_get().unwrap(), Some(9_999));
        a.budget_snooze_set(8_888, 2_000).unwrap();
        assert_eq!(a.budget_snooze_get().unwrap(), Some(8_888), "upsert 覆盖");
        a.budget_snooze_clear().unwrap();
        assert!(a.budget_snooze_get().unwrap().is_none(), "clear 后干净");
        // clear 再 clear 幂等。
        a.budget_snooze_clear().unwrap();
        let _ = std::fs::remove_file(&db);
    }

    /// Phase 2.8：`pricing_snapshots` 写入方——同 version 幂等（内容不可变）、
    /// `asof` 按事件时间点选最新的更早版本、`latest` 取最新捕获。
    #[test]
    fn pricing_snapshots_put_get_asof_latest() {
        let db = tmp_db("pxsnap");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        assert_eq!(a.pricing_snapshot_count().unwrap(), 0);
        assert!(a.pricing_snapshot_latest().unwrap().is_none());
        assert!(
            a.pricing_snapshot_asof(9_999).unwrap().is_none(),
            "无更早版本 → None"
        );

        assert!(a
            .pricing_snapshot_put("v-aug", "embedded-assets", "{\"m\":1}", 1_000)
            .unwrap());
        assert!(
            !a.pricing_snapshot_put("v-aug", "embedded-assets", "{\"m\":1}", 5_000)
                .unwrap(),
            "同 version 再写 → DO NOTHING（内容不可变）"
        );
        assert!(a
            .pricing_snapshot_put("v-sep", "embedded-assets", "{\"m\":2}", 3_000)
            .unwrap());
        assert_eq!(a.pricing_snapshot_count().unwrap(), 2);

        assert_eq!(
            a.pricing_snapshot_get("v-sep").unwrap().as_deref(),
            Some("{\"m\":2}")
        );
        assert_eq!(
            a.pricing_snapshot_latest().unwrap(),
            Some(("v-sep".into(), 3_000))
        );
        // asof 调价前 → 用旧版本；调价后 → 新版本；更早 → None。
        assert_eq!(
            a.pricing_snapshot_asof(2_000).unwrap().as_deref(),
            Some("{\"m\":1}")
        );
        assert_eq!(
            a.pricing_snapshot_asof(4_000).unwrap().as_deref(),
            Some("{\"m\":2}")
        );
        assert!(a.pricing_snapshot_asof(500).unwrap().is_none());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn pricing_catalog_snapshot_put_rolls_back_both_tables_on_failure() {
        let db = tmp_db("pxsnap-atomic");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        let result = a.pricing_catalog_snapshot_put(
            "public-v1",
            "public-v1",
            "public-maintainer-https",
            "{\"providers\":{}}",
            2_000,
            Some("missing-template"),
        );
        assert!(result.is_err());
        assert_eq!(a.pricing_snapshot_count().unwrap(), 0);
        assert_eq!(
            a.conn()
                .query_row(
                    "SELECT COUNT(*) FROM provider_catalog_snapshots",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        let _ = std::fs::remove_file(&db);
    }

    /// Phase 2.8：`harness_bills` 写入方——校验四项（period/basis/amount/currency）、
    /// 同键 upsert（更正金额，deleted 复活）、`for_period` 只回活行、soft delete。
    #[test]
    fn harness_bill_put_validates_and_upserts() {
        let db = tmp_db("hbill");
        let a = AuthorityDb::open(&db, 1_000).unwrap();
        assert_eq!(a.harness_bill_count().unwrap(), 0);

        // 四项校验——每条都必须 Err（不猜、不默认）。
        assert!(
            a.harness_bill_put("x", "wb", "wb", "2026-9", "harness_billed", 100, "CNY", "", 1)
                .is_err(),
            "period 非 YYYY-MM"
        );
        assert!(
            a.harness_bill_put("x", "wb", "wb", "2026-09", "credits", 100, "CNY", "", 1)
                .is_err(),
            "basis 不在五档词表"
        );
        assert!(
            a.harness_bill_put("x", "wb", "wb", "2026-09", "harness_billed", -1, "CNY", "", 1)
                .is_err(),
            "amount_minor < 0"
        );
        assert!(
            a.harness_bill_put("x", "wb", "wb", "2026-09", "harness_billed", 100, "  ", "", 1)
                .is_err(),
            "currency 空"
        );
        assert!(
            a.harness_bill_put("x", "wb", "wb", "2026-09", "harness_billed", 100, "cny", "", 1)
                .is_err(),
            "currency 必须是三位大写代码"
        );

        // 正常录入 + 同键 upsert 更正金额。
        a.harness_bill_put(
            "b1",
            "workbuddy",
            "workbuddy",
            "2026-09",
            "harness_billed",
            21_500,
            "CNY",
            "credit_json",
            1_000,
        )
        .unwrap();
        assert_eq!(a.harness_bill_count().unwrap(), 1);
        a.harness_bill_put(
            "b1",
            "workbuddy",
            "workbuddy",
            "2026-09",
            "harness_billed",
            30_000,
            "CNY",
            "credit_json",
            2_000,
        )
        .unwrap();
        assert_eq!(
            a.harness_bill_count().unwrap(),
            1,
            "同 (harness,provider,period,basis,evidence) → upsert 不新增"
        );

        // evidence_ref 空串同样能 upsert（不撞 PRIMARY KEY）。
        a.harness_bill_put(
            "b2:",
            "wb2",
            "wb2",
            "2026-09",
            "harness_billed",
            500,
            "CNY",
            "",
            1,
        )
        .unwrap();
        a.harness_bill_put(
            "b2:",
            "wb2",
            "wb2",
            "2026-09",
            "harness_billed",
            700,
            "CNY",
            "",
            2,
        )
        .unwrap();
        assert_eq!(
            a.harness_bill_count().unwrap(),
            2,
            "空 evidence 也 upsert 而非新增/报错"
        );
        a.harness_bill_delete("b2:", 9).unwrap();

        let rows = a.harness_bills_for_period("2026-09").unwrap();
        assert_eq!(
            rows,
            vec![(
                "workbuddy".to_string(),
                "workbuddy".to_string(),
                "harness_billed".to_string(),
                30_000,
                "CNY".to_string()
            )]
        );
        assert!(a.harness_bills_for_period("2026-08").unwrap().is_empty());

        // soft delete → for_period 不再回它；重复 delete 返回 false。
        assert!(a.harness_bill_delete("b1", 3_000).unwrap());
        assert!(!a.harness_bill_delete("b1", 4_000).unwrap());
        assert!(a.harness_bills_for_period("2026-09").unwrap().is_empty());
        assert_eq!(a.harness_bill_count().unwrap(), 0);

        // upsert 到已 soft-deleted 的键 → 复活（deleted_at_ms = NULL）。
        a.harness_bill_put(
            "b1",
            "workbuddy",
            "workbuddy",
            "2026-09",
            "harness_billed",
            12_000,
            "CNY",
            "credit_json",
            5_000,
        )
        .unwrap();
        assert_eq!(a.harness_bill_count().unwrap(), 1, "同键再录 → 复活");
        let _ = std::fs::remove_file(&db);
    }

    // ---- 权威 revision（RUNTIME_INVALIDATION spec §4.1 / 验收 9.1 9.5 9.16）----

    #[test]
    fn revision_starts_at_zero_and_advances_only_on_real_changes() {
        let db = tmp_db("revision-basic");
        let a = AuthorityDb::open(&db, 1).unwrap();
        assert_eq!(a.revision().unwrap(), 0);
        // 有行被改 → +1
        a.with_immediate_txn(|c| {
            c.execute("INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES('r1',1,'cli','running',26)", [])?;
            Ok(())
        }).unwrap();
        assert_eq!(a.revision().unwrap(), 1);
        // 空事务（只 SELECT）→ 不推进
        a.with_immediate_txn(|c| {
            let _: i64 = c.query_row("SELECT COUNT(*) FROM sync_runs", [], |r| r.get(0))?;
            Ok(())
        }).unwrap();
        assert_eq!(a.revision().unwrap(), 1);
        // INSERT OR IGNORE 被吸收 → 不推进（total_changes 不计被忽略的行）
        a.with_immediate_txn(|c| {
            c.execute("INSERT OR IGNORE INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES('r1',1,'cli','running',26)", [])?;
            Ok(())
        }).unwrap();
        assert_eq!(a.revision().unwrap(), 1);
        // 回滚 → 不推进
        let failed: Result<(), AuthorityError> = a.with_immediate_txn(|c| {
            c.execute("INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES('r2',1,'cli','running',26)", [])?;
            Err(AuthorityError::Corrupt)
        });
        assert!(failed.is_err());
        assert_eq!(a.revision().unwrap(), 1);
        let n: i64 = a.conn().query_row("SELECT COUNT(*) FROM sync_runs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "rollback must undo the row as before");
        // 记账单语句（自动提交）不经 helper → 不推进
        a.begin_run("r3", "cli", 5).unwrap();
        assert_eq!(a.revision().unwrap(), 1);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn revision_is_readable_from_readonly_connection_and_survives_reopen() {
        let db = tmp_db("revision-ro");
        {
            let a = AuthorityDb::open(&db, 1).unwrap();
            a.with_immediate_txn(|c| {
                c.execute("INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES('r1',1,'cli','running',26)", [])?;
                Ok(())
            }).unwrap();
        }
        let ro = AuthorityDb::open_readonly(&db).unwrap();
        assert_eq!(ro.revision().unwrap(), 1);
        // writer 重开：迁移尾部 INSERT OR IGNORE 不重置计数
        let a = AuthorityDb::open(&db, 2).unwrap();
        assert_eq!(a.revision().unwrap(), 1);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn migration_v25_to_v26_inserts_revision_row_idempotently() {
        let db = tmp_db("revision-migrate");
        {
            // 造一个 v26 库再把版本戳回 25 且删掉 revision 行，模拟 v25 writer 留下的库。
            let a = AuthorityDb::open(&db, 1).unwrap();
            a.conn().execute("UPDATE schema_meta SET value = '25' WHERE key = 'schema_version'", []).unwrap();
            a.conn().execute("DELETE FROM schema_meta WHERE key = ?1", rusqlite::params![AUTHORITY_REVISION_KEY]).unwrap();
        }
        let a = AuthorityDb::open(&db, 2).unwrap();
        let version: String = a.conn().query_row("SELECT value FROM schema_meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        assert_eq!(a.revision().unwrap(), 0);
        drop(a);
        let a = AuthorityDb::open(&db, 3).unwrap();
        let rows: i64 = a.conn().query_row("SELECT COUNT(*) FROM schema_meta WHERE key = ?1", rusqlite::params![AUTHORITY_REVISION_KEY], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn billing_hand_rolled_write_paths_advance_revision() {
        let db = tmp_db("revision-billing");
        let a = AuthorityDb::open(&db, 1).unwrap();
        let r0 = a.revision().unwrap();
        assert!(a.billing_declaration_revision_save(
            "rev-a", "decl-a", None,"openai", "official_subscription", Some("Plus"),
            Some(1_990), Some("CNY"), "2026-09", None, None, None, &[], 2,
        ).unwrap());
        let r1 = a.revision().unwrap();
        assert_eq!(r1, r0 + 1, "declaration save is a hand-rolled BEGIN IMMEDIATE path");
        // 同 revision_id 重放：查后无事可做 → 不推进
        assert!(!a.billing_declaration_revision_save(
            "rev-a", "decl-a", None,"openai", "official_subscription", Some("Plus"),
            Some(1_990), Some("CNY"), "2026-09", None, None, None, &[], 3,
        ).unwrap());
        assert_eq!(a.revision().unwrap(), r1);
        assert!(a.billing_declaration_revision_revoke("rev-revoke", "decl-a", "rev-a", 4).unwrap());
        assert_eq!(a.revision().unwrap(), r1 + 1, "revoke path advances too");
        let _ = std::fs::remove_file(&db);
    }

}
