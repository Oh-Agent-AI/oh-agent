//! REFRESH_STORM R2-F3 等价钉子：`budget_profiles_status_from_parts`
//! （桌面 assembly 复用 memoized monthly + shared_daily 的路径）与
//! `budget_profiles_status_sql_at`（CLI / MCP / 独立调用的全量现算路径）
//! 对同一权威库快照输出**逐字节相等**。拆分只允许改变「部件由谁供给」，
//! 不允许改变计算本身——输入错接由类型系统排除（Monthly/Daily/Profile
//! 三种部件类型互不兼容），本测试钉住的是计算体搬运零漂移。

use std::path::PathBuf;

fn tmp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "av-f3-{}-{tag}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn budget_profiles_from_parts_matches_sql_at() {
    let home = tmp_home("equiv");
    let path = agent_vitals_data::authority::default_authority_path(&home);
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap();
    db.begin_run("run", "cli", 1).unwrap();
    // 双 profile（与产品默认同形的 estimate/confirmed），让输出带真实行数与
    // 限额计算；空表时 rows 为空的等价没有区分度。
    db.budget_profile_set("estimate", "CNY", 200_000, Some(20_000), 8_000, 1)
        .unwrap();
    db.budget_profile_set("confirmed", "USD", 10_000, None, 7_000, 1)
        .unwrap();
    let today = agent_vitals_runtime::core::clock::today_beijing();
    let month = today[..7].to_string();
    let day_start =
        agent_vitals_data::authority_query::beijing_day_bounds_ms(&today)
            .unwrap()
            .0;
    // 当月多执行环境 token 事实：by_provider / coverage / daily 与 monthly 的差异
    // 让「部件错接」即使绕过类型检查也会改变输出。
    for (id, harness, model, u, o) in [
        ("f1", "claude-code", "claude-sonnet-4-6", 1_000_000i64, 200_000i64),
        ("f2", "claude-code", "claude-opus-4-8", 500_000, 80_000),
        ("f3", "dsh", "glm-4.7", 2_000_000, 300_000),
    ] {
        db.conn()
            .execute(
                "INSERT OR IGNORE INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 's1', ?1, 'turn', NULL, ?3, ?4, ?4, ?5, 0, 0, ?6, 'run', 1, 1)",
                rusqlite::params![id, harness, model, day_start + 1000, u, o],
            )
            .unwrap();
    }

    // 全量现算路径（内部自取 summary / daily / profiles）。
    let via_sql = agent_vitals_runtime::billing::budget::budget_profiles_status_sql_at(&home, &month)
        .expect("有库有 profile，sql_at 必须 Some");
    assert_eq!(
        via_sql["profiles"].as_array().map(Vec::len),
        Some(2),
        "结构下限：两个 profile 行，防止空输出假等价"
    );
    assert_eq!(via_sql["month"].as_str(), Some(month.as_str()));

    // from_parts：部件与 sql_at 同源（assembly 路径喂的是 memoized 的同形部件）。
    let profiles = {
        let db_ro = agent_vitals_data::authority::AuthorityDb::open_readonly(&path).unwrap();
        db_ro.budget_profiles_get().unwrap()
    };
    let (summary, daily) = {
        use agent_vitals_data::repository::SummaryRepository;
        let repo =
            agent_vitals_runtime::query::summary::SqlSummaryRepository::at(&home);
        repo.open_db().expect("库在，readonly open 必须成功");
        (
            repo.monthly_summary(&agent_vitals_data::repository::MonthlySummaryQuery {
                month: month.clone(),
            }),
            repo.daily_summary(&agent_vitals_data::repository::DailySummaryQuery {
                date: today.clone(),
            }),
        )
    };
    let via_parts =
        agent_vitals_runtime::billing::budget::budget_profiles_status_from_parts(
            &home,
            &month,
            profiles,
            &summary,
            &daily,
        )
        .expect("部件齐全，from_parts 必须 Some");

    assert_eq!(
        serde_json::to_string(&via_sql).unwrap(),
        serde_json::to_string(&via_parts).unwrap(),
        "from_parts（assembly 复用路径）与 sql_at（全量现算）必须逐字节等价"
    );
}
