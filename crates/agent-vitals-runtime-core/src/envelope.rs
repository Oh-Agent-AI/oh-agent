//! MCP / 查询共用的「工具协议」层：envelope 顶层契约（spec §6）、稳定错误码
//! [`ToolError`]（spec §11）、只读 [`AuthorityHandle`]、freshness 与 revision、
//! [`ToolSpec`]。
//!
//! W3 从 `mcp/mod.rs` 原样下沉（不改逻辑）：`mcp::cost_breakdown` /
//! `mcp::session_ref` 被 query 与 billing 复用，它们又 `use super::{ToolError, …}`，
//! 于是 query、billing 只为一个错误类型就依赖了整个出口层 mcp，形成环。
//! 本模块只依赖 `core`（时钟、`sql_authority` 标记）与 data crate。
//! `mcp::*` 经 glob re-export 保留全部旧路径。

use std::path::{Path, PathBuf};

use agent_vitals_data::authority::{AuthorityDb, AuthorityError};
use jiff::Timestamp;
use rusqlite::Connection;
use serde_json::{json, Value};

/// spec §6：MCP envelope 的顶层版本。结构变化时 bump。
pub const ENVELOPE_SCHEMA_VERSION: &str = "1";
/// spec §6：查询语义版本——查询**含义**（不是结构）变化时手动 bump。
pub const QUERY_SEMANTICS: &str = "2026-09-07";


// ─────────────────────────── 错误 ───────────────────────────

/// spec §11 稳定错误码 + 安全描述（详细诊断写 `stderr`，不进响应）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code, "message": self.message })
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

/// [`AuthorityDb::open_readonly`] 的 typed 错误 → spec §11 码。
pub fn map_open_error(e: AuthorityError) -> ToolError {
    match e {
        AuthorityError::MissingFile => ToolError::new(
            "database_missing",
            "authority DB does not exist — run `agent-vitals sync-facts` first",
        ),
        AuthorityError::Corrupt => ToolError::new(
            "database_unreadable",
            "authority DB is corrupt or not a SQLite file — run `agent-vitals data-status`, keep the file for diagnosis",
        ),
        AuthorityError::NewerSchema { found, supported } => ToolError::new(
            "schema_too_new",
            format!("authority schema v{found} is newer than supported v{supported} — upgrade agent-vitals / the MCP client"),
        ),
        AuthorityError::OlderSchema { found } => ToolError::new(
            "schema_migration_required",
            format!("authority schema v{found} is older than supported — run the matching product migration"),
        ),
        other => ToolError::new("internal_error", other.to_string()),
    }
}

// ─────────────────────────── 只读句柄 ───────────────────────────

/// 只读打开的权威库 + envelope 元数据来源。非 `data_status` 的工具都从这里
/// 取 conn（`data_status` 是 doctor 工具，自管低层连接以便在损坏时仍能报告）。
pub struct AuthorityHandle {
    db: AuthorityDb,
    data_home: PathBuf,
}

impl AuthorityHandle {
    pub fn open(data_home: &Path) -> Result<Self, ToolError> {
        let path = agent_vitals_data::authority::default_authority_path(data_home);
        let db = AuthorityDb::open_readonly(&path).map_err(map_open_error)?;
        Ok(Self { db, data_home: data_home.to_path_buf() })
    }

    pub fn conn(&self) -> &Connection {
        self.db.conn()
    }

    /// Typed read helpers may need the AuthorityDb API while still using the
    /// same validated read-only connection.
    pub fn db(&self) -> &AuthorityDb {
        &self.db
    }

    /// spec §6.1 `authority_state`（库已能打开，故只在 `enabled` / `candidate`
    /// 二选一——`unavailable` 只发生在打不开时，那种情况根本到不了这里）。
    pub fn authority_state(&self) -> &'static str {
        authority_state_for(&self.data_home)
    }
}

pub fn authority_state_for(data_home: &Path) -> &'static str {
    if crate::sql_authority::is_enabled(data_home) {
        "enabled"
    } else {
        "candidate"
    }
}

// ─────────────────────────── envelope（spec §6） ───────────────────────────

/// spec §6：所有成功工具返回的顶层结构。工具只负责组装 `coverage` / `warnings`
/// / `data`，元数据（schema 版本、`authority_revision`、`freshness`）在这里从
/// `conn` 统一读——保证每个工具的 envelope 形状逐字节一致。
///
/// `max_observed_at_ms`：本次查询窗口内命中事实的最大 `event_ts_ms`（spec
/// §6.1）——带时间窗的工具传窗口内的 MAX；`data_status` 这类无窗工具传
/// `None`，则退回全库 MAX。
pub fn build_envelope(
    conn: &Connection,
    authority_state: &str,
    max_observed_at_ms: Option<i64>,
    coverage: Value,
    warnings: Vec<Value>,
    data: Value,
) -> Value {
    json!({
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "data_version": {
            "authority_schema": schema_version(conn),
            "query_semantics": QUERY_SEMANTICS,
        },
        "authority_state": authority_state,
        "authority_revision": authority_revision(conn, max_observed_at_ms),
        "generated_at": ms_to_rfc3339_beijing(crate::clock::now_ms()),
        "timezone": crate::clock::statistics_timezone_name(),
        "coverage": coverage,
        "freshness": freshness(conn),
        "warnings": warnings,
        "data": data,
    })
}

/// spec §6.1 `coverage`：不依赖时间覆盖的工具（如 `data_status`）用这个。
pub fn coverage_not_applicable() -> Value {
    json!({ "status": "not_applicable", "missing_harnesses": [] })
}

/// spec §6.4.1 `as_of_run_id` 三态。共享给所有带时间窗的工具，防止各写一份漂移。
/// - 没传 → `Ok(())`，不检查；
/// - 传了 == 当前最新成功 run → `Ok(())`；
/// - 传了、存在、但 != 最新（drift）→ push `snapshot_drift` warning，`Ok(())`（返回当前数据）；
/// - 传了但从没这个 run（或一次成功同步都没有）→ `Err(invalid_argument)`。
pub fn check_as_of_run_id(
    conn: &Connection,
    args: &Value,
    warnings: &mut Vec<Value>,
) -> Result<(), ToolError> {
    let Some(req) = args.get("as_of_run_id").and_then(Value::as_str) else {
        return Ok(());
    };
    let current: Option<String> = conn
        .query_row(
            "SELECT run_id FROM sync_runs WHERE status='succeeded'
             ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    match current {
        None => Err(ToolError::new(
            "invalid_argument",
            format!("as_of_run_id `{req}` requested but no successful sync run exists yet"),
        )),
        Some(cur) if cur == req => Ok(()),
        Some(cur) => {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sync_runs WHERE run_id = ?1)",
                    rusqlite::params![req],
                    |r| r.get(0),
                )
                .unwrap_or(false);
            if exists {
                warnings.push(json!({
                    "code": "snapshot_drift",
                    "message": format!(
                        "as_of_run_id={req} but current is {cur} — strict cross-tool consistency not yet enforced (M2)"
                    ),
                    "requested": req,
                    "current": cur,
                }));
                Ok(())
            } else {
                Err(ToolError::new(
                    "invalid_argument",
                    format!("as_of_run_id `{req}` is not present in this authority DB"),
                ))
            }
        }
    }
}

/// `check_as_of_run_id` 的 `pub` 包装——CLI 二进制侧在自家工具（如
/// `sessions list` / `data daily`）实现 `as_of_run_id` 守门时复用同一段
/// 三态逻辑，避免各写一份漂移（spec §6.4.1）。内部 MCP 工具仍走
/// `pub(super)` 版以保留 module 边界。
pub fn check_as_of_run_id_pub(
    conn: &Connection,
    args: &Value,
    warnings: &mut Vec<Value>,
) -> Result<(), ToolError> {
    check_as_of_run_id(conn, args, warnings)
}

/// 业务错误的 envelope 形状（spec §6.4：`tools/call` 结果 `isError: true` +
/// envelope 内 `error`——**不塞 JSON-RPC error**）。库打不开时组不出完整
/// envelope，这里给一个最小可用形状：`authority_state=unavailable` + `error`。
pub fn error_envelope(err: &ToolError) -> Value {
    json!({
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "data_version": { "authority_schema": Value::Null, "query_semantics": QUERY_SEMANTICS },
        "authority_state": "unavailable",
        "authority_revision": Value::Null,
        "generated_at": ms_to_rfc3339_beijing(crate::clock::now_ms()),
        "timezone": crate::clock::statistics_timezone_name(),
        "coverage": { "status": "unavailable", "missing_harnesses": [] },
        "freshness": { "last_successful_sync_at": Value::Null, "stale_harnesses": [] },
        "warnings": [],
        "data": Value::Null,
        "error": err.to_json(),
    })
}

pub fn schema_version(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = 'schema_version'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|s| s.parse().ok())
    .unwrap_or(0)
}

/// spec §6.1 `authority_revision`：本次答案基于哪一批已提交数据。
/// = 最近一次 `sync_runs.status='succeeded'` 的 run + 其提交时间 +
/// 查询窗口内（或全库）事实的 `MAX(event_ts_ms)`。
///
/// **S4 fix（增量 1 review）**：`max_observed_at` SQL 必须 `WHERE
/// observation_kind != 'legacy_aggregate'`——legacy 是聚合兜底行，
/// `event_ts_ms` 是北京日 12:00 代表点；混进去会把 `max_observed_at`
/// 推到 `covered_to` 之后，破坏 spec §6.1「本次答案基于哪一批已提交
/// 数据」的不变量。这条过滤与 `per_harness_breakdown` / `hourly_by_harness` 同。
pub fn authority_revision(conn: &Connection, max_observed_at_ms: Option<i64>) -> Value {
    let last = conn
        .query_row(
            "SELECT run_id, COALESCE(completed_at_ms, started_at_ms)
             FROM sync_runs WHERE status = 'succeeded'
             ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    let max_observed = max_observed_at_ms.or_else(|| {
        conn.query_row(
            "SELECT MAX(event_ts_ms) FROM usage_facts
             WHERE deleted_at_ms IS NULL
               AND observation_kind != 'legacy_aggregate'",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    });
    match last {
        Some((run_id, committed_ms)) => json!({
            "last_completed_run_id": run_id,
            "committed_at": ms_to_rfc3339_beijing(committed_ms),
            "max_observed_at": max_observed.map(ms_to_rfc3339_beijing),
        }),
        // 从没有一次成功同步——诚实报 null，不编造一个 revision。
        None => Value::Null,
    }
}

/// `data_status` 及所有标准 envelope 的活跃数据新鲜度阈值。它回答的是「该
/// 执行环境最近一条实时 usage 事实是否已超过一天」；最近一次扫描时间另由
/// `data.by_harness.*.last_seen_at` 表示，二者不能混为一谈。
pub const FRESHNESS_STALE_AFTER_MS: i64 = 24 * 60 * 60 * 1_000;

/// 返回存在于实时事实或扫描源中的执行环境，且其最后一条实时 usage fact 已超过
/// 24 小时（没有任何实时事实同样视为 stale）。顺序由 SQL 固定为 harness 升序，
/// 以保证 CLI / MCP envelope 可逐字节对账。
pub fn stale_harnesses(conn: &Connection, now_ms: i64) -> Vec<String> {
    let mut stmt = match conn.prepare(
        "SELECT harness, MAX(event_ts_ms) AS last_fact_at_ms
         FROM usage_facts
         WHERE deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate'
         GROUP BY harness
         UNION
         SELECT harness, NULL
         FROM source_files
         WHERE harness NOT IN (
           SELECT DISTINCT harness FROM usage_facts
           WHERE deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate'
         )
         ORDER BY harness",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.flatten()
        .filter_map(|(harness, last_fact_at_ms)| {
            (last_fact_at_ms
                .map(|at| now_ms.saturating_sub(at) > FRESHNESS_STALE_AFTER_MS)
                .unwrap_or(true))
            .then_some(harness)
        })
        .collect()
}

/// 桌面工作台「发现」tab 新鲜度条的数据面（WORKBENCH_FINDINGS_TAB_SPEC
/// §4.8/§5.4）。与 MCP envelope 的 `freshness` 同源同形 —— 桌面只要这一格，
/// 不必取整个 envelope，也不在 desktop 里复述那条 stale SQL（口径唯一）。
pub fn data_freshness_report(conn: &Connection) -> Value {
    freshness(conn)
}

/// spec §6 `freshness`。`stale_harnesses` 由最新实时事实折成显式状态，避免只把
/// 原始 `covered_to` 留给每个 consumer 自己计算而发生口径漂移。
pub fn freshness(conn: &Connection) -> Value {
    let last = conn
        .query_row(
            "SELECT MAX(COALESCE(completed_at_ms, started_at_ms))
             FROM sync_runs WHERE status = 'succeeded'",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten();
    json!({
        "last_successful_sync_at": last.map(ms_to_rfc3339_beijing),
        "stale_harnesses": stale_harnesses(conn, crate::clock::now_ms()),
    })
}

/// epoch ms → RFC 3339，使用系统统计时区（spec §6.3）。供应商价格时间
/// 仍由价格快照的事件绝对时间决定，不读取这个显示时区。
pub fn ms_to_rfc3339_beijing(ms: i64) -> String {
    Timestamp::from_millisecond(ms)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned(crate::clock::statistics_timezone())
        .strftime("%Y-%m-%dT%H:%M:%S%.3f%:z")
        .to_string()
}

// ─────────────────────────── 工具注册表 ───────────────────────────

/// `tools/list` 的一条：名字 + 描述 + JSON Schema（spec §6.4）。描述是英文
/// （面向 MCP 客户端 / Agent，与 CLI `--help` 同纪律）。
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub output_schema: Value,
}

#[cfg(test)]
mod error_envelope_tests {
    use super::*;

    // W3：随 `map_open_error` 从 mcp/mod.rs 的 tests 一起搬来。
    #[test]
    fn map_open_error_covers_stable_codes() {
        assert_eq!(map_open_error(AuthorityError::MissingFile).code, "database_missing");
        assert_eq!(map_open_error(AuthorityError::Corrupt).code, "database_unreadable");
        assert_eq!(
            map_open_error(AuthorityError::NewerSchema { found: 2, supported: 1 }).code,
            "schema_too_new"
        );
        assert_eq!(
            map_open_error(AuthorityError::OlderSchema { found: 0 }).code,
            "schema_migration_required"
        );
    }
    #[test]
    fn error_envelope_uses_envelope_schema_version_constant() {
        // S3 fix: 与 `build_envelope` 同源——bump 常量时成功/错误路径同时变。
        let env = error_envelope(&ToolError::new("database_missing", "x"));
        assert_eq!(env["schema_version"], ENVELOPE_SCHEMA_VERSION);
    }
}
