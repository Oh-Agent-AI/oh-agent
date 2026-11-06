//! v0.9.1 Phase 3.2 接线集成测试：`data-migrate` 的两段导入（存量 JSONL 重放
//! 与 claude ledger 深历史 → `legacy_aggregate`）在**同一个权威库**上按真实
//! 调用顺序走一遍。
//!
//! 钉的是接线层的事实，单测各自钉不到：
//! - 两类 `observation_kind`（实时行级 + legacy 聚合）在同库共存，互不吞——
//!   legacy 身份五元组（`machine_namespace="legacy"` /
//!   `native_session_id="day:{day}"`）与实时事实不重叠，导入不需要也不得
//!   因为「该日已有实时事实」跳过（按日覆盖是查询侧的职责）；
//! - ledger 读侧（`load_claude_ledger_days`：当前月文件 + archive 合并）
//!   → 写侧（`import_claude_ledger_days`）→ 查询侧（`claude_legacy_days`）
//!   三段在同一条数据上对得上账；
//! - 幂等重跑 + ledger 值变 → updated（同源快照刷新语义，见
//!   `legacy_import` 模块头——旧语义「conflict + 永不覆盖」会让 SQL 永远留
//!   着旧快照的数字）。

use std::path::Path;

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::fact_writer_sql::SqlFactWriter;
use agent_vitals_data::legacy_import::{import_claude_ledger_days, load_claude_ledger_days};

fn tmp_root() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "avd-legacy-wiring-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(root.join("facts")).unwrap();
    std::fs::create_dir_all(root.join("state")).unwrap();
    root
}

/// 一条实时行级事实（`token_count`）——形状与真机 emitter 输出一致，不含
/// fact_id（契约层 `build_usage_fact` 派生，导入路径不信任外部 id）。
fn live_fact(event_id: &str, ts: &str) -> serde_json::Value {
    serde_json::json!({
        "harness": "claude-code",
        "machine_namespace": "default",
        "source_profile": "default",
        "native_session_id": "sess-live",
        "source_event_id": event_id,
        "observation_kind": "token_count",
        "event_ts_utc": ts,
        "model_id": "claude-opus-4",
        "uncached_input_tokens": 100,
        "cache_read_tokens": 50,
        "cache_write_tokens": 10,
        "output_tokens": 5,
    })
}

/// ledger 深历史（`{"YYYY-MM-DD": {model: {4 snake 桶 + 4 peak_ 桶}}}`）。
/// `out` 是 2026-07-15 的 output_tokens——参数化是为了「改值再导入」那一步。
fn ledger_json(out_deep: i64) -> serde_json::Value {
    let buckets = |o: i64| {
        serde_json::json!({
            "input_tokens": 1_000, "cache_read_input_tokens": 200,
            "cache_creation_input_tokens": 30, "output_tokens": o,
            "peak_input_tokens": 600, "peak_cache_read_input_tokens": 100,
            "peak_cache_creation_input_tokens": 10, "peak_output_tokens": o / 2,
        })
    };
    serde_json::json!({
        "days": {
            // 当前月的一天——与 jsonl 的实时事实同日（真实形态：当月既有实时
            // 行也有 ledger 快照），导入仍须两行都进库。
            "2026-09-05": {"claude-opus-4": buckets(7)},
            // 深历史一天——jsonl 里没有对应日期（真实形态：原始会话文件已
            // 轮转，ledger 是唯一 store of record）。
            "2026-07-15": {"claude-opus-4": buckets(out_deep)},
        }
    })
}

/// 与 `main.rs::Cmd::DataMigrate` 同款顺序：JSONL 重放 → ledger 导入。
/// 返回两段各自的可观测报告。
fn migrate_pass(
    db: &AuthorityDb,
    root: &Path,
) -> (
    agent_vitals_data::fact_writer_sql::SqlInsertReport,
    agent_vitals_data::legacy_import::LegacyImportReport,
) {
    let jsonl = root.join("facts").join("claude-code.jsonl");
    let state_dir = root.join("state");
    let jsonl_rep = db
        .with_immediate_txn(|conn| {
            SqlFactWriter::new(conn, "run-1", 1_000)?
                .import_facts_jsonl("claude-code", &jsonl)
        })
        .unwrap();
    let days = load_claude_ledger_days(&state_dir).unwrap();
    assert!(
        days.as_object().map(|m| !m.is_empty()).unwrap_or(false),
        "接线前置条件：合并 days 非空才走导入（与 CLI 分支同款门槛）"
    );
    let rep = db
        .with_immediate_txn(|conn| import_claude_ledger_days(conn, "run-1", 1_000, &days))
        .unwrap();
    (jsonl_rep, rep)
}

#[test]
fn data_migrate_two_pass_wiring_is_coexistent_idempotent_and_updatable() {
    let root = tmp_root();
    let jsonl_path = root.join("facts").join("claude-code.jsonl");
    std::fs::write(
        &jsonl_path,
        [
            live_fact("e1", "2026-09-05T10:00:00.000Z").to_string(),
            live_fact("e2", "2026-09-06T11:00:00.000Z").to_string(),
        ]
        .join("\n")
            + "\n",
    )
    .unwrap();
    std::fs::write(
        root.join("state").join("claude-ledger.json"),
        ledger_json(10).to_string(),
    )
    .unwrap();

    let db = AuthorityDb::open(&root.join("av.sqlite3"), 1_000).unwrap();
    db.begin_run("run-1", "migration", 1_000).unwrap();

    // 第一遍：实时 2 行 + legacy 4 行（2 天 × 1 model × base/peak 两行）。
    let (jsonl_rep, rep) = migrate_pass(&db, &root);
    assert_eq!((jsonl_rep.inserted, jsonl_rep.duplicate), (2, 0), "JSONL 重放入实时行");
    assert_eq!(
        (rep.imported, rep.duplicate, rep.updated, rep.conflicts),
        (4, 0, 0, 0),
        "与 jsonl 同日的 ledger 快照也不被跳过"
    );

    let conn = db.conn();
    let kinds: Vec<(String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT observation_kind, COUNT(*) FROM usage_facts GROUP BY observation_kind")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        rows
    };
    assert!(
        kinds.contains(&("token_count".into(), 2)),
        "实时行级事实在库：{kinds:?}"
    );
    assert!(
        kinds.contains(&("legacy_aggregate".into(), 4)),
        "legacy 聚合与实时行共存：{kinds:?}"
    );

    // coverage 降级标记进 data_quality_issues；批跨 2026-07/2026-09 两个月 →
    // 逐月各一条（2026-09-07 审查收口：不再粗化为 "all"，消费方按月降级）。
    let mut keys: Vec<String> = conn
        .prepare(
            "SELECT scope_key FROM data_quality_issues
             WHERE code = 'legacy_aggregate' ORDER BY scope_key",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    keys.sort();
    assert_eq!(keys, vec!["2026-07", "2026-09"], "跨月批逐月写标记");

    // 查询侧读得到深历史（legacy 只走 event_peak=0 的 base 行）。
    let days = agent_vitals_data::authority_query::claude_legacy_days(conn, 0, 4_102_444_800_000)
        .unwrap();
    assert_eq!(
        days["2026-07-15"]["claude-opus-4"]["output_tokens"],
        10,
        "导入的 legacy 行对查询面可见"
    );

    // 第二遍（幂等重跑，真实形态：data-migrate 可重复执行直到全 duplicate）。
    let (jsonl_rep2, rep2) = migrate_pass(&db, &root);
    assert_eq!(
        (jsonl_rep2.inserted, jsonl_rep2.duplicate),
        (0, 2),
        "JSONL 重放全 duplicate"
    );
    assert_eq!(
        (rep2.imported, rep2.duplicate, rep2.updated, rep2.conflicts),
        (0, 4, 0, 0)
    );

    // ledger 值变（全量重折/修复后的滚动投影）→ 同源快照刷新为 updated，
    // SQL 值跟到新值。fixture 的 base 桶与 peak 子桶都由同一参数派生 →
    // base + peak 两行都变（updated=2），2026-09-05 那天没动 → duplicate=2。
    std::fs::write(
        root.join("state").join("claude-ledger.json"),
        ledger_json(555).to_string(),
    )
    .unwrap();
    let (_i, rep3) = migrate_pass(&db, &root);
    assert_eq!(
        (rep3.imported, rep3.duplicate, rep3.updated, rep3.conflicts),
        (0, 2, 2, 0),
        "值变 → updated，不再走 conflict 永不覆盖"
    );
    let out: i64 = conn
        .query_row(
            "SELECT output_tokens FROM usage_facts WHERE source_event_id = '2026-07-15:claude-opus-4:0'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(out, 555, "SQL 快照值跟到 ledger 新值");
    let days2 = agent_vitals_data::authority_query::claude_legacy_days(conn, 0, 4_102_444_800_000)
        .unwrap();
    assert_eq!(
        days2["2026-07-15"]["claude-opus-4"]["output_tokens"], 555,
        "查询面读到的是刷新后的值"
    );

    std::fs::remove_dir_all(root).ok();
}
