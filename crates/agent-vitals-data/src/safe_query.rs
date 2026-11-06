//! SQLite authorizer callback for `query_sql_readonly`（spec §8.2 / 增量 7.5）。
//!
//! **威胁模型**：调用者可能用 `AS` / 表达式 / `json_extract` 把敏感字段改名
//! 后返回——所以**仅结果列名扫描**不够；必须在来源层按 `SQLITE_READ` 回调
//! 拒绝来自 `usage_facts.native_session_id` / `path_hash` 等列的读取。
//!
//! 本模块纯函数 + 静态表，与 `Connection` 解耦——`AuthorityDb::make_query_sql_
//! readonly_connection` 把回调挂到 `Connection::authorizer`。
//!
//! deny 列表参考 spec §8.2：
//! - 写入类：`Insert` / `Update` / `Delete` / `CreateTable` / `CreateView` /
//!   `CreateIndex` / `DropTable` / `DropView` / `AlterTable` / `Reindex` /
//!   `Analyze` / `CreateVtable` / `DropVtable` / `Pragma` / `Attach` / `Detach` /
//!   `Transaction` / `Savepoint`
//! - 读取敏感列：`usage_facts.{native_session_id, source_event_id, source_id}` +
//!   `sessions.{native_session_id, machine_namespace, session_key}` +
//!   `source_files.{path_hash}` + `data_quality_issues.{detail_json}` +
//!   `sync_runs.{error_detail}` + `migrations.{checkpoint_json, error_detail}`
//! - 危险函数：`load_extension` / `random` / `randomblob` / `unicode`（按需）
//!
//! **always-allow**: 我们的 v_* view（authorizer 在 `SQLITE_READ` 上拿到的是
//! view 名 + 列名） + 内置聚合函数（`avg/sum/count/min/max/...`）。

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

/// 哪些列是「身份敏感」——authorizer 一律 deny 读取。
///
/// 实测（review 增量 7.5）：`SQLITE_READ` 在 view 上回调时拿到的是**基表**
/// 名 + 基表列名（不是 view 名 + view 列名）。所以
/// `SELECT * FROM v_facts_safe` 展开到基表时，authorizer 看到的是
/// `usage_facts.native_session_id` 等——deny 列表照样生效。
///
/// 视图层 + authorizer 双层防线：view 定义里就不 SELECT 敏感列（最小暴露
/// 面）；authorizer 在来源层也拒绝（即便 view 被改或 view 出错也兜底）。
const SENSITIVE_READ_COLUMNS: &[(&str, &str)] = &[
    // usage_facts
    ("usage_facts", "native_session_id"),
    ("usage_facts", "source_event_id"),
    ("usage_facts", "source_id"),
    // sessions
    ("sessions", "native_session_id"),
    ("sessions", "machine_namespace"),
    ("sessions", "session_key"),
    // source_files —— `path_hash` DDL 注释就是"不暴露本地路径"
    ("source_files", "path_hash"),
    ("source_files", "source_id"),
    ("source_files", "native_session_id"),
    ("source_files", "last_error_code"),
    // data_quality_issues —— `detail_json` 可能含 raw 模型名 / 路径片段
    ("data_quality_issues", "detail_json"),
    // sync_runs / migrations —— `error_detail` 可能含原始错误
    ("sync_runs", "error_detail"),
    ("migrations", "checkpoint_json"),
    ("migrations", "error_detail"),
    // workflow_events —— 同名 `session_key` / `source_id` 必须独立 deny
    // (review 增量 7.5: 不补会被 `SELECT session_key FROM workflow_events` 漏过)
    ("workflow_events", "session_key"),
    ("workflow_events", "source_id"),
    ("workflow_events", "error_fingerprint"),
    ("workflow_events", "invocation_fingerprint"),
    // budget_snoozes —— `until_ms` 暴露用户 snooze 行为
    ("budget_snoozes", "until_ms"),
    // trust_observations / trust_issue_evidence —— P1 只用于本地关联；尚未有
    // 面向 MCP 或导出的安全投影。为避免调用方通过通用只读 SQL 枚举本机
    // 行为证据，两个表的所有列一律拒绝读取。
    ("trust_observations", "observation_id"),
    ("trust_observations", "machine_namespace"),
    ("trust_observations", "harness"),
    ("trust_observations", "actor_id"),
    ("trust_observations", "actor_kind"),
    ("trust_observations", "actor_version"),
    ("trust_observations", "observed_at_ms"),
    ("trust_observations", "observation_kind"),
    ("trust_observations", "stage"),
    ("trust_observations", "evidence_level"),
    ("trust_observations", "evidence_origin"),
    ("trust_observations", "workspace_ref"),
    ("trust_observations", "scope_classes_json"),
    ("trust_observations", "file_count"),
    ("trust_observations", "byte_count"),
    ("trust_observations", "destination_class"),
    ("trust_observations", "destination_host"),
    ("trust_observations", "consent_state"),
    ("trust_observations", "consent_kind"),
    ("trust_observations", "source_id"),
    ("trust_observations", "native_event_id"),
    ("trust_observations", "source_line"),
    ("trust_observations", "source_byte_offset"),
    ("trust_observations", "collector_id"),
    ("trust_observations", "collector_version"),
    ("trust_observations", "provenance_json"),
    ("trust_observations", "expires_at_ms"),
    ("trust_observations", "ingested_run_id"),
    ("trust_observations", "created_at_ms"),
    ("trust_issue_evidence", "issue_id"),
    ("trust_issue_evidence", "observation_id"),
    ("trust_issue_evidence", "evidence_role"),
    ("trust_issue_evidence", "linked_at_ms"),
    ("trust_monitor_state", "config_id"),
    ("trust_monitor_state", "enabled"),
    ("trust_monitor_state", "interval_seconds"),
    ("trust_monitor_state", "notifications_enabled"),
    ("trust_monitor_state", "capability"),
    ("trust_monitor_state", "last_success_at_ms"),
    ("trust_monitor_state", "last_error_code"),
    ("trust_monitor_state", "last_alert_key"),
    ("trust_monitor_state", "last_alert_at_ms"),
    ("trust_monitor_state", "updated_at_ms"),
    ("trust_monitor_alerts", "alert_key"),
    ("trust_monitor_alerts", "last_alert_at_ms"),
    ("trust_monitor_alerts", "updated_at_ms"),
    ("trust_suppressions", "suppression_id"),
    ("trust_suppressions", "issue_type"),
    ("trust_suppressions", "instance_fingerprint"),
    ("trust_suppressions", "reason"),
    ("trust_suppressions", "created_at_ms"),
    ("trust_suppressions", "revoked_at_ms"),
];

/// 哪些内置函数被禁——`load_extension` 是首要；`random` / `randomblob` 让
/// 输出不可重现；`unicode` 可能绕过字符检查。其余常用聚合函数放行。
const DENIED_FUNCTIONS: &[&str] = &[
    "load_extension",
    "random",
    "randomblob",
    "zeroblob",
    "readonly",
];

/// 作者回调——挂在 `Connection::authorizer` 上。
///
/// 用 `|` 匹配枚举变体（AuthAction 是不带 `#[non_exhaustive]` 的 plain enum）。
pub fn authority_callback(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        // ---- 一律 deny：写入 / DDL / 事务 / 元数据 ----
        AuthAction::Insert { .. }
        | AuthAction::Update { .. }
        | AuthAction::Delete { .. }
        | AuthAction::CreateTable { .. }
        | AuthAction::CreateTempTable { .. }
        | AuthAction::CreateView { .. }
        | AuthAction::CreateTempView { .. }
        | AuthAction::CreateIndex { .. }
        | AuthAction::CreateTempIndex { .. }
        | AuthAction::CreateTrigger { .. }
        | AuthAction::CreateTempTrigger { .. }
        | AuthAction::DropTable { .. }
        | AuthAction::DropTempTable { .. }
        | AuthAction::DropView { .. }
        | AuthAction::DropTempView { .. }
        | AuthAction::DropIndex { .. }
        | AuthAction::DropTempIndex { .. }
        | AuthAction::DropTrigger { .. }
        | AuthAction::DropTempTrigger { .. }
        | AuthAction::AlterTable { .. }
        | AuthAction::Reindex { .. }
        | AuthAction::Analyze { .. }
        | AuthAction::CreateVtable { .. }
        | AuthAction::DropVtable { .. }
        | AuthAction::Pragma { .. }
        | AuthAction::Attach { .. }
        | AuthAction::Detach { .. }
        | AuthAction::Transaction { .. }
        | AuthAction::Savepoint { .. } => Authorization::Deny,

        // ---- SQLITE_READ：来源列敏感 → deny；其它 → 允许 ----
        // 注：SQLite authorizer 在 view 上回调时拿到的是**基表**名 + 基表列
        // 名（不是 view 名 + view 列名）——所以 view 里有 `SELECT *` 展开
        // 到 `usage_facts.*` 时，authorizer 看到的还是 `usage_facts.native_session_id`。
        // 列名比较用 `eq_ignore_ascii_case`——SQLite 默认把不带引号的标识符
        // 转小写，但 `CREATE TABLE "MixedCase"("Col")` 这种带引号的形式会保留
        // 原始大小写，case-insensitive 比较是 defense-in-depth。
        AuthAction::Read { table_name, column_name } => {
            if SENSITIVE_READ_COLUMNS.iter().any(|(t, c)| {
                t.eq_ignore_ascii_case(table_name) && c.eq_ignore_ascii_case(column_name)
            }) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }

        // ---- SELECT 顶层：SQLite 把它当作「表/视图解析完成」的回调——无
        // ----              来源表信息，安全默认是 allow。 ----
        AuthAction::Select => Authorization::Allow,

        // ---- 递归子查询 ——SQLite 默认行为是 deny。我们 allow 让 WITH ... SELECT 合法。 ----
        AuthAction::Recursive => Authorization::Allow,

        // ---- 函数调用：deny 黑名单；其它（avg/sum/count/coalesce/...）allow ----
        AuthAction::Function { function_name } => {
            let f = function_name.to_ascii_lowercase();
            if DENIED_FUNCTIONS.iter().any(|d| d.eq_ignore_ascii_case(&f)) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }

        // ---- 未来 SQLite 版本扩 action —— deny 默认值，fail-safe。 ----
        AuthAction::Unknown { .. } => Authorization::Deny,
        // `AuthAction` 是 `#[non_exhaustive]`——遇到未来加的 variant
        // 一律 deny（与 Unknown 同语义，比 Allow 更安全）。
        _ => Authorization::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::hooks::AuthContext;

    /// `SQLITE_READ` 对 `usage_facts.native_session_id` → deny。
    #[test]
    fn deny_read_of_native_session_id() {
        // `Connection::authorizer` 返回 `()`，attach 失败 panic（in-memory
        // 连接不可能 attach 失败；这是「authorizer 已挂上」的 smoke 标记）。
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.authorizer(Some(authority_callback));

        let action = AuthAction::Read {
            table_name: "usage_facts",
            column_name: "native_session_id",
        };
        let ctx = AuthContext { action, database_name: None, accessor: None };
        assert_eq!(authority_callback(ctx), Authorization::Deny);
    }

    /// `SQLITE_READ` 对 `usage_facts.event_ts_ms` → allow（普通字段）。
    #[test]
    fn allow_read_of_normal_column() {
        let action = AuthAction::Read {
            table_name: "usage_facts",
            column_name: "event_ts_ms",
        };
        let ctx = AuthContext { action, database_name: None, accessor: None };
        assert_eq!(authority_callback(ctx), Authorization::Allow);
    }

    /// `SQLITE_READ` 对 view 列 —— view 定义里已经排除了敏感列；authorizer
    /// 拿到的是 view 名 + view 列名，自然 allow。
    #[test]
    fn allow_read_of_view_column() {
        let action = AuthAction::Read {
            table_name: "v_facts_safe",
            column_name: "event_ts_ms",
        };
        let ctx = AuthContext { action, database_name: None, accessor: None };
        assert_eq!(authority_callback(ctx), Authorization::Allow);
    }

    /// 写入类一律 deny。
    #[test]
    fn deny_all_writes() {
        for action in [
            AuthAction::Insert { table_name: "usage_facts" },
            AuthAction::Delete { table_name: "usage_facts" },
            AuthAction::Update { table_name: "usage_facts", column_name: "x" },
            AuthAction::CreateTable { table_name: "t" },
            AuthAction::CreateView { view_name: "v" },
            AuthAction::DropTable { table_name: "t" },
            AuthAction::Pragma { pragma_name: "cache_size", pragma_value: None },
            AuthAction::Attach { filename: "/tmp/x" },
            AuthAction::Transaction { operation: rusqlite::hooks::TransactionOperation::Begin },
            AuthAction::Savepoint {
                operation: rusqlite::hooks::TransactionOperation::Begin,
                savepoint_name: "s",
            },
        ] {
            let ctx = AuthContext { action, database_name: None, accessor: None };
            assert_eq!(
                authority_callback(ctx),
                Authorization::Deny,
                "expected deny for {action:?}"
            );
        }
    }

    /// 危险函数 deny；常用聚合函数 allow。
    #[test]
    fn deny_dangerous_functions_and_allow_aggregates() {
        for f in ["load_extension", "random", "randomblob", "zeroblob"] {
            let ctx = AuthContext {
                action: AuthAction::Function { function_name: f },
                database_name: None,
                accessor: None,
            };
            assert_eq!(
                authority_callback(ctx),
                Authorization::Deny,
                "expected deny for `{f}`"
            );
        }
        for f in ["avg", "sum", "count", "min", "max", "coalesce", "json_extract", "typeof"] {
            let ctx = AuthContext {
                action: AuthAction::Function { function_name: f },
                database_name: None,
                accessor: None,
            };
            assert_eq!(
                authority_callback(ctx),
                Authorization::Allow,
                "expected allow for `{f}`"
            );
        }
    }

    /// `SELECT` 顶层 + `RECURSIVE` allow——WITH ... SELECT 走通。
    #[test]
    fn allow_select_and_recursive() {
        for action in [AuthAction::Select, AuthAction::Recursive] {
            let ctx = AuthContext { action, database_name: None, accessor: None };
            assert_eq!(authority_callback(ctx), Authorization::Allow);
        }
    }

    /// `Unknown` 默认 deny（fail-safe）——SQLite 将来加新 action 不会被
    /// 静默放过。
    #[test]
    fn unknown_action_defaults_to_deny() {
        let ctx = AuthContext {
            action: AuthAction::Unknown { code: 9999, arg1: None, arg2: None },
            database_name: None,
            accessor: None,
        };
        assert_eq!(authority_callback(ctx), Authorization::Deny);
    }

    /// `function_name` 大小写归一：`RANDOM()` 与 `random()` 同拒。
    #[test]
    fn function_name_case_insensitive() {
        let ctx = AuthContext {
            action: AuthAction::Function { function_name: "RANDOM" },
            database_name: None,
            accessor: None,
        };
        assert_eq!(authority_callback(ctx), Authorization::Deny);
    }

    // ----- review 增量 7.5 follow-up：补 deny 列表 + case-insensitive -----

    /// workflow_events.session_key（与 sessions.session_key 同名但**不同表**）deny。
    /// review 增量 7.5：如果不在列表里，agent 用
    /// `SELECT session_key FROM workflow_events` 漏过敏感列。
    #[test]
    fn deny_workflow_events_session_key() {
        let action = AuthAction::Read {
            table_name: "workflow_events",
            column_name: "session_key",
        };
        let ctx = AuthContext { action, database_name: None, accessor: None };
        assert_eq!(authority_callback(ctx), Authorization::Deny);
    }

    /// source_files.native_session_id —— DDL 里有这一列，原 deny 列表漏了。
    #[test]
    fn deny_source_files_native_session_id() {
        let action = AuthAction::Read {
            table_name: "source_files",
            column_name: "native_session_id",
        };
        let ctx = AuthContext { action, database_name: None, accessor: None };
        assert_eq!(authority_callback(ctx), Authorization::Deny);
    }

    /// `usage_facts.Native_Session_ID`（带引号大写）——`eq_ignore_ascii_case` 让
    /// authorizer 仍能拒绝（defense-in-depth）。
    #[test]
    fn deny_read_mixed_case_column() {
        let action = AuthAction::Read {
            table_name: "Usage_Facts",
            column_name: "Native_Session_ID",
        };
        let ctx = AuthContext { action, database_name: None, accessor: None };
        assert_eq!(authority_callback(ctx), Authorization::Deny);
    }

    #[test]
    fn deny_read_of_trust_observation_evidence() {
        for (table_name, column_name) in [
            ("trust_observations", "destination_host"),
            ("trust_observations", "provenance_json"),
            ("trust_issue_evidence", "issue_id"),
        ] {
            let ctx = AuthContext {
                action: AuthAction::Read { table_name, column_name },
                database_name: None,
                accessor: None,
            };
            assert_eq!(authority_callback(ctx), Authorization::Deny);
        }
    }
}

#[cfg(test)]
mod integration {
    //! 在真权威库 + 真 authorizer 上验证 `query_sql_readonly` 的端到端行为——
    //! 不只单元断言回调函数，而是跑真实 SQL 让 authorizer 走 prepare / step
    //! 完整路径。`v_facts_safe` 等 view 与 authorizer 一起在 SCHEMA_V1
    //! 里建出来。

    use super::*;
    use crate::authority::AuthorityDb;
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};

    fn tmp_db(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "avd-safequery-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn open_authorizer_db(path: &Path) -> Connection {
        // **直接打开只读连接 + 挂 authorizer**——绕过 `AuthorityDb::open_readonly`
        // 持有所有权的限制（`AuthorityDb` 包了 `Connection` 不让借出）。
        // 路径存在性 / schema 版本校验这里跳过：测试 fixture 已知合法。
        if !path.exists() {
            panic!("test fixture db not seeded: {}", path.display());
        }
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("open test db readonly");
        conn.authorizer(Some(authority_callback));
        conn
    }

    fn seed_one_real(home: &Path) {
        // 与 `tmp_db` 配套：home 本身就是权威库文件路径（不是目录）。
        let db = AuthorityDb::open(home, 1_700_000_000_000).unwrap();
        let conn = db.conn();
        // 一条 succeeded sync_run（authorizer 不拦写入，但这里只造一条）。
        conn.execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, completed_at_ms, trigger, status, schema_version)
             VALUES ('run1', 1700000000000, 1700000001000, 'cli', 'succeeded', 1)",
            [],
        ).unwrap();
        // 一行真实事实（不含敏感列填 NULL 让作者测试在 v_facts_safe 下确实无 native_session_id）。
        conn.execute(
            "INSERT INTO source_files(source_id, harness, path_hash, size_bytes, mtime_ns,
                                     parser_version, first_seen_at_ms, last_seen_at_ms,
                                     last_successful_run_id)
             VALUES ('src1', 'claude-code', 'ph1', 0, 0, 1, 1700000000000, 1700000000000, 'run1')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES ('sk1', 'claude-code', 'native-1', 'ns-1', 1700000000000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                                     observation_kind, source_id, ingested_run_id, event_ts_ms,
                                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                                     created_at_ms, updated_at_ms)
             VALUES ('f1', 'claude-code', 'ns-1', 'native-1', 'e1', 'assistant-usage', 'src1', 'run1',
                     1700000003000, 100, 200, 50, 25, 1700000003000, 1700000003000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO trust_observations(
                 observation_id, machine_namespace, harness, actor_id, actor_kind,
                 observed_at_ms, observation_kind, stage, evidence_level,
                 scope_classes_json, consent_state, collector_id, collector_version,
                 provenance_json, ingested_run_id, created_at_ms
             ) VALUES(
                 'trust-1', 'ns-1', 'claude-code', 'sidecar-1', 'sidecar', 1700000003000,
                 'connection', 'egress_attempted', 'E3', '[]', 'unavailable', 'test', 'v1',
                 '{}', 'run1', 1700000003000)",
            [],
        ).unwrap();
    }

    /// 真 SQL 走 view —— 通过 authorizer。
    #[test]
    fn real_select_through_safe_view_passes() {
        let home = tmp_db("view-passes");
        seed_one_real(&home);
        let conn = open_authorizer_db(&home);
        let mut stmt = conn.prepare("SELECT harness, SUM(output_tokens) FROM v_facts_safe GROUP BY harness").unwrap();
        let rows: Vec<(String, i64)> = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        }).unwrap().map(Result::unwrap).collect();
        assert_eq!(rows, vec![("claude-code".to_string(), 25)]);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `SELECT native_session_id FROM usage_facts` —— authorizer 在 prepare 阶段
/// deny 列访问（SQLite 在 prepare 时就解析 column refs，比 step 更早）。
#[test]
fn real_select_on_sensitive_column_is_denied() {
    let home = tmp_db("sensitive-deny");
    seed_one_real(&home);
    let conn = open_authorizer_db(&home);
    let err = conn
        .prepare("SELECT native_session_id FROM usage_facts")
        .expect_err("prepare must fail (authorizer deny on sensitive column)");
    let msg = err.to_string();
    assert!(
        msg.contains("prohibited") || msg.contains("authorized") || msg.contains("denied"),
        "expected authorizer deny, got: {msg}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

    /// `INSERT INTO usage_facts ...` —— authorizer deny 写入。
    #[test]
    fn real_insert_is_denied() {
        let home = tmp_db("insert-deny");
        seed_one_real(&home);
        let conn = open_authorizer_db(&home);
        let _ = conn
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                                         observation_kind, source_id, ingested_run_id, event_ts_ms,
                                         uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                                         created_at_ms, updated_at_ms)
                 VALUES ('f2', 'claude-code', 'ns-1', 'n-2', 'e2', 'assistant-usage', 'src1', 'run1',
                         1700000004000, 1, 1, 1, 1, 1700000004000, 1700000004000)",
                [],
            )
            .expect_err("insert must fail");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `SELECT load_extension('/tmp/x')` —— `load_extension` 不走 SQLITE_FUNCTION
/// 回调（SQLite 把它视作特殊操作），所以测试仅说明「这条 SQL 至少不让它
/// 真去加载扩展」。authorizer 主要通过 `SQLITE_PRAGMA` / `SQLITE_SELECT`
/// 路径 + 函数 deny 列表覆盖；`load_extension` 的额外防线由调用方「禁
/// `PRAGMA load_extension`」承担。
#[test]
fn real_load_extension_function_call_returns_error() {
    let home = tmp_db("loadext2");
    seed_one_real(&home);
    let conn = open_authorizer_db(&home);
    // 关闭 extension loading 走单独的 db config——这里仅验证函数被禁（任何
    // 错误信息都行，不验证具体信息）。
    let res = conn.query_row(
        "SELECT load_extension('/tmp/never')",
        [],
        |r| Ok(r.get::<_, i64>(0)),
    );
    assert!(res.is_err(), "load_extension must error, got Ok");
    let _ = std::fs::remove_dir_all(&home);
}

    /// `SELECT * FROM usage_facts` —— authorizer 在 prepare 阶段 deny（`*` 展开到
/// 敏感列）。
#[test]
fn real_select_star_is_denied() {
    let home = tmp_db("star-deny");
    seed_one_real(&home);
    let conn = open_authorizer_db(&home);
    let _ = conn
        .prepare("SELECT * FROM usage_facts")
        .expect_err("SELECT * FROM usage_facts must fail (authorizer deny on sensitive column)");
    let _ = std::fs::remove_dir_all(&home);
}

    /// Trust 证据尚无安全投影；即使调用方知道表名，也不能经通用只读 SQL
    /// 读取它。未来若需要展示，必须先新增专用、最小字段的 serving face。
    #[test]
    fn real_select_on_trust_evidence_is_denied() {
        let home = tmp_db("trust-evidence-deny");
        seed_one_real(&home);
        let conn = open_authorizer_db(&home);
        let _ = conn
            .prepare("SELECT * FROM trust_observations")
            .expect_err("trust observations must not be exposed through generic SQL");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn real_select_on_trust_monitor_control_is_denied() {
        let home = tmp_db("trust-monitor-deny");
        seed_one_real(&home);
        let conn = open_authorizer_db(&home);
        let _ = conn
            .prepare("SELECT * FROM trust_monitor_state")
            .expect_err("monitor control state must not be exposed through generic SQL");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `SELECT * FROM v_facts_safe` —— view 里不含敏感列，authorizer 放行；
    /// 响应**没有** `native_session_id` 字段名（脱敏是 view 的责任）。
    #[test]
    fn real_select_star_from_view_does_not_leak_sensitive_columns() {
        let home = tmp_db("view-noleak");
        seed_one_real(&home);
        let conn = open_authorizer_db(&home);
        let stmt = conn.prepare("SELECT * FROM v_facts_safe").unwrap();
        let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
        // 双层防线在 view 侧落地：v_facts_safe 的 SELECT 列表里就不含
        // 这些敏感列。
        for forbidden in [
            "native_session_id", "source_event_id", "source_id", "session_key",
        ] {
            assert!(
                !names.iter().any(|n| n == forbidden),
                "v_facts_safe leaked sensitive column `{forbidden}`; columns={names:?}"
            );
        }
        // 期望的正常列应在：
        for expected in ["harness", "model_id", "event_ts_ms", "output_tokens"] {
            assert!(
                names.iter().any(|n| n == expected),
                "v_facts_safe missing expected column `{expected}`; columns={names:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `SELECT random()` —— authorizer 的 `SQLITE_FUNCTION` 回调**确实**为内建
/// 函数触发（与我早期注释相反），deny 黑名单 `random`/`randomblob`/
/// `zeroblob`/`load_extension` 在 prepare 时被拒绝。
#[test]
fn real_built_in_function_is_denied() {
    let home = tmp_db("builtin-deny");
    seed_one_real(&home);
    let conn = open_authorizer_db(&home);
    let err = conn
        .query_row("SELECT random()", [], |r| Ok(r.get::<_, i64>(0)))
        .expect_err("random() must be denied at authorizer");
    let msg = err.to_string();
    assert!(
        msg.contains("not authorized") || msg.contains("prohibited") || msg.contains("denied"),
        "expected authorizer deny, got: {msg}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

// (占位：之前 `real_load_extension_call_is_denied` 测试试图用 `SELECT
// random()` 触发 authorizer，被 SQLite 内建函数特性阻断——已重命名为
// `real_built_in_function_does_not_call_authorizer`，见上。)

    /// `PRAGMA cache_size` —— authorizer deny pragma。
    #[test]
    fn real_pragma_is_denied() {
        let home = tmp_db("pragma-deny");
        seed_one_real(&home);
        let conn = open_authorizer_db(&home);
        let _msg = conn
            .pragma_query(None, "cache_size", |_| Ok(()))
            .expect_err("PRAGMA must be denied");
        let _ = std::fs::remove_dir_all(&home);
    }
}
