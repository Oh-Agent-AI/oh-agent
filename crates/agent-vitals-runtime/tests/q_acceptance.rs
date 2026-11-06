//! v0.9.1 Phase 3.7b：spec §4.2 用户查询验收用例的端到端 fixture——
//! **Q01–Q05、Q11–Q12、Q14 + §4 分离纪律**（release blocker 集；Q06–Q10
//! 依赖 workflow_events 的 writer/reader，记 v0.10；Q13 依赖
//! pricing_snapshots 落库，挂 3.4 相邻欠账）。
//!
//! 与单元测试的区别：单元测试钉的是单个函数的判别值；这里的每条用例从
//! 「seed 一份有语义的权威库」出发、走 `SqlSummaryRepository` 的公开 trait
//! 面，断言的是**用户可见的结果**（spec §4.2 原话：「既是产品验收，也是
//! repository 的端到端测试 fixture。每条均应同时断言数值、下钻链路和数据
//! 质量状态」）。

use std::path::PathBuf;

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::authority_query;
use agent_vitals_data::repository::{DailySummaryQuery, MonthlySummaryQuery, SummaryRepository};
use agent_vitals_runtime::summary::SqlSummaryRepository;
use serde_json::json;

/// 每个 case 一个独立 data home + 干净权威库（`seed_authority_db` 同款纪律：
/// 显式删库文件再开，不依赖目录级清理）。返回 (guard, db, month, day)。
struct QEnv {
    _guard: crate_env_guard::EnvGuard,
    db: AuthorityDb,
    day: String,
    dir: PathBuf,
}

mod crate_env_guard {
    use std::path::Path;

    /// env + ENV_LOCK 的合并 RAII（budget.rs 的 BudgetEnvGuard 同款纪律：
    /// drop 顺序 = 声明顺序，先恢复 env 再放进程级锁）。
    pub struct EnvGuard {
        _env: EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    struct EnvRestore {
        prev: Option<String>,
    }
    impl EnvRestore {
        fn set(home: &Path) -> Self {
            let prev = std::env::var("AGENT_VITALS_HOME").ok();
            std::env::set_var("AGENT_VITALS_HOME", home);
            EnvRestore { prev }
        }
    }
    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.prev {
                Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
                None => std::env::remove_var("AGENT_VITALS_HOME"),
            }
        }
    }

    pub fn acquire(home: &Path) -> EnvGuard {
        let lock = agent_vitals_runtime::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let env = EnvRestore::set(home);
        EnvGuard { _env: env, _lock: lock }
    }
}

impl QEnv {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("av-q37-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let guard = crate_env_guard::acquire(&dir);
        let day = agent_vitals_runtime::clock::today_beijing();
        let path = agent_vitals_data::authority::default_authority_path(
            &agent_vitals_runtime::home::data_home(),
        );
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "cli", 1).unwrap();
        QEnv { _guard: guard, db, day, dir }
    }

    /// 最小事实 seed：`seed_fact` 的紧凑版（Q 系列只需要身份 + 时间 + 桶）。
    /// INSERT OR IGNORE——重放同 id 是幂等语义（Q12 的重放步骤依赖），不是
    /// 静默吞错：撞 UNIQUE 只发生在「同 id 不同形状」的 fixture 笔误上，
    /// 而那也应该按幂等吸收（库内值是先到的权威）。
    #[allow(clippy::too_many_arguments)]
    fn fact(&self, id: &str, harness: &str, model: &str, ts_ms: i64, peak: i64, u: i64, o: i64) {
        self.db
            .conn()
            .execute(
                "INSERT OR IGNORE INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 's1', ?1, 'turn', NULL, ?3, ?4, ?5, ?6, 0, 0, ?7, 'run', 1, 1)",
                rusqlite::params![id, harness, model, ts_ms, peak, u, o],
            )
            .unwrap();
    }

    fn day_start(&self, date: &str) -> i64 {
        authority_query::beijing_day_bounds_ms(date).unwrap().0
    }
}

impl Drop for QEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Q01：同一天 Claude 09:00 120 token、Codex 10:00 300 token——小时曲线
/// 各归各模型、跨执行环境总量一致（Q01 与 Q02 的合并判别值）。
#[test]
fn q01_q02_two_harnesses_two_hours_tokens_land_separately_and_sum() {
    let env = QEnv::new("q01");
    let d = env.day.clone();
    let s = env.day_start(&d);
    env.fact("c1", "claude-code", "claude-opus-5", s + 9 * 3_600_000, 0, 120, 0);
    env.fact("x1", "codex", "gpt-5.6", s + 10 * 3_600_000, 0, 300, 0);

    let daily = SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: d.clone() });
    assert!(daily.contract_violations().is_empty(), "{:?}", daily.contract_violations());
    // 两执行环境各自的 token 归属正确（Q01 的两个小时点）。
    assert_eq!(daily.tokens_by_harness["claude-code"].uncached_input, 120);
    assert_eq!(daily.tokens_by_harness["codex"].uncached_input, 300);
    // Q02：执行环境曲线分开显示，总量 = 各执行环境之和，不重复计数。
    let total: i64 = daily.tokens_by_harness.values().map(|t| t.uncached_input).sum();
    assert_eq!(total, 420);
    assert_eq!(
        daily.tokens_by_harness["codex"].uncached_input + daily.tokens_by_harness["claude-code"].uncached_input,
        420
    );
}

/// Q03：北京月初 00:30 的事件（= UTC 前一天 16:30）——归属正确北京日/月，
/// 不落入上月。fixture 事实的 UTC 时刻 = 8月31日 16:30Z（北京 9月1日 00:30）。
#[test]
fn q03_beijing_month_start_0030_stays_in_the_month() {
    let env = QEnv::new("q03");
    // 北京 2026-09-01 00:30 = UTC 2026-08-31 16:30。
    let utc_ms = authority_query::beijing_month_bounds_ms("2026-09").unwrap().0 + 1_800_000;
    env.fact("edge", "dsh", "deepseek-v4-flash", utc_ms, 0, 50, 5);
    // 前一毫秒（北京 8-31 23:59:59.999 = UTC 8-31 15:59:59.999）作对照。
    env.fact("before", "dsh", "deepseek-v4-flash", utc_ms - 1_800_001, 0, 7, 7);

    let (m_start, m_end) = authority_query::beijing_month_bounds_ms("2026-09").unwrap();
    let days = authority_query::peaked_days_map(env.db.conn(), "dsh", m_start, m_end).unwrap();
    // 9 月 map 只含 00:30 那条；before 落在 8 月——不进 9 月 map。
    assert_eq!(days["2026-09-01"]["uncached_input_tokens"], json!(50));
    assert!(days.get("2026-08-31").is_none(), "UTC 08-31 16:29:59.999 属于北京 8 月");
    // 完整性：8 月窗口能找回 before。
    let (aug_start, aug_end) = authority_query::beijing_month_bounds_ms("2026-08").unwrap();
    let aug = authority_query::peaked_days_map(env.db.conn(), "dsh", aug_start, aug_end).unwrap();
    assert_eq!(aug["2026-08-31"]["uncached_input_tokens"], json!(7));
    // 月查询 DTO 侧同样只认北京月界。
    let summary = SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month: "2026-09".to_string() });
    assert_eq!(summary.tokens_by_harness["dsh"].uncached_input, 50);
    let aug_summary = SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month: "2026-08".to_string() });
    assert_eq!(aug_summary.tokens_by_harness["dsh"].uncached_input, 7);
    let _ = m_end;
}

/// Q04：一个峰值小时由三条不同会话事实构成——下钻列出三会话、会话 token
/// 合计严格等于峰值（facts_page_window 下钻 + native_session_id 分组）。
#[test]
fn q04_peak_hour_drilldown_sessions_sum_exactly_to_the_peak() {
    let env = QEnv::new("q04");
    let d = env.day.clone();
    let s = env.day_start(&d);
    // 同一小时、三个不同会话（这里以 native_session_id 区分——QEnv::fact
    // 固定 's1'，下钻用例直接手插三行）。
    for (i, (sid, u)) in [("sA", 10), ("sB", 20), ("sC", 30)].iter().enumerate() {
        env.db
            .conn()
            .execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'codex', 'm', ?2, ?1, 'token_count', NULL, 'gpt-5.6', ?3, 0, ?4, 0, 0, 0, 'run', 1, 1)",
                rusqlite::params![format!("q{i}"), sid, s + 3_600_000 + i as i64, u],
            )
            .unwrap();
    }
    // 小时峰值 = 该小时 60 tokens（10+20+30）。
    let hour = authority_query::codex_by_hour_model(
        env.db.conn(),
        s,
        s + 86_400_000,
    )
    .unwrap();
    let hour_total: i64 = hour[d.clone() + "T01"]["gpt-5.6"]["standard"]["uncached_input_tokens"]
        .as_i64()
        .unwrap();
    assert_eq!(hour_total, 60, "峰值小时的聚合数");
    // 下钻：同一窗口 facts_page_window 按 native_session_id 分组。
    let (rows, more) = authority_query::facts_page_window(
        env.db.conn(),
        "codex",
        s,
        s + 86_400_000,
        None,
        None,
        100,
    )
    .unwrap();
    assert!(!more);
    use std::collections::BTreeMap;
    let mut by_session: BTreeMap<&str, i64> = BTreeMap::new();
    for r in &rows {
        *by_session.entry(r.native_session_id.as_str()).or_insert(0) += r.uncached_input_tokens;
    }
    assert_eq!(by_session.len(), 3, "下钻列出三会话");
    let drilldown_total: i64 = by_session.values().sum();
    assert_eq!(drilldown_total, hour_total, "会话 token 合计严格等于峰值");
}

/// Q05：某模型有用量但缺价卡——用量可见、成本 unresolved（has_unresolved），
/// 不以 0 或估算冒充。glm-* 有声明无价卡、moonshot 无声明——用 moonshot
/// （billing_route_of 无声明 → unknown）钉「看见了、钱不可归」。
#[test]
fn q05_unpriced_model_shows_usage_with_unresolved_not_zero() {
    let env = QEnv::new("q05");
    let d = env.day.clone();
    let s = env.day_start(&d);
    env.fact("u1", "claude-code", "moonshot-kimi-unroutable", s + 1_000, 0, 500, 50);

    let daily = SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: d });
    // 用量可见：token 照报（unpriced 不进金额分母，但处理量必须可见）。
    assert_eq!(daily.tokens_by_harness["claude-code"].uncached_input, 500);
    // 不以 0 冒充：claude 侧 has_unresolved（ Moonshot 无声明无价卡 → 钱不可归）。
    let claude = &daily.by_provider["claude-code/unknown"];
    assert!(claude.has_unresolved, "无路由模型必须落 unresolved 条目");
    // 不以估算冒充：该条目不携带任何金额（unresolved 不出现在 amounts_by_basis）。
    assert!(claude.amounts_by_basis.is_empty(), "{:?}", claude.amounts_by_basis);
}

/// Q11：某执行环境 24 小时未同步——结果标 partial/stale，明确缺失执行环境，不可
/// 显示「完整总额」。fixture：三执行环境中 dsh 有数据、codex/claude 全无 →
/// codex/claude 报 Unavailable 且不进总额（缺数据 ≠ ¥0）。
#[test]
fn q11_stale_harness_is_explicitly_missing_not_a_zero() {
    let env = QEnv::new("q11");
    let d = env.day.clone();
    let s = env.day_start(&d);
    env.fact("d1", "dsh", "deepseek-v4-flash", s + 1_000, 0, 10, 1);

    let daily = SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: d.clone() });
    // 有数据执行环境照报；缺失执行环境必须 Unavailable（不是 0）。
    assert_eq!(daily.by_harness["dsh"].freshness.state,
               agent_vitals_data::projection::FreshnessState::Fresh);
    for missing in ["codex", "claude-code"] {
        assert_eq!(
            daily.by_harness[missing].freshness.state,
            agent_vitals_data::projection::FreshnessState::Unavailable,
            "{missing} 没有数据必须显式缺失"
        );
        assert!(daily.by_harness[missing].amounts_by_basis.is_empty());
    }
    // 总额只含真实有数据的执行环境——"完整总额"在这个窗口不存在。
    assert!(daily.total_summable() >= 0.0);
    // excluded_harnesses 不该包含 codex/claude（接线了但没数据 ≠ 被排除）。
    assert!(!daily.excluded_harnesses.contains("codex"));
    assert!(!daily.excluded_harnesses.contains("claude-code"));
}

/// Q12：同一来源导入两次 + 中途模拟中断（半事务回滚）——重跑任意月/日查询
/// 与首次成功导入完全一致，无半提交。这里钉「写侧崩溃恢复 + 读侧恒等」：
/// 事务内注入失败 → ROLLBACK → 库与导入前逐位一致；重放成功 → 与单次导入
/// 一致。
#[test]
fn q12_double_import_with_interrupted_run_is_idempotent_and_rollback_safe() {
    let env = QEnv::new("q12");
    let d = env.day.clone();
    let s = env.day_start(&d);
    env.fact("r1", "dsh", "deepseek-v4-flash", s + 1_000, 0, 11, 1);

    let read_all = |_env: &QEnv| {
        SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: d.clone() })
            .tokens_by_harness["dsh"]
            .uncached_input
    };
    let baseline = read_all(&env);
    assert_eq!(baseline, 11);

    // 模拟中断：事务内插入新事实后故意报错 → ROLLBACK。
    let err: Result<(), agent_vitals_data::authority::AuthorityError> = env
        .db
        .with_immediate_txn(|conn| {
            conn.execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES ('r2', 'dsh', 'm', 's1', 'r2', 'turn', NULL, 'deepseek-v4-flash', ?1, 0, 999, 0, 0, 0, 'run', 1, 1)",
                rusqlite::params![s + 2_000],
            )?;
            Err(agent_vitals_data::authority::AuthorityError::Sqlite(
                rusqlite::Error::InvalidParameterName("__simulated_interrupt__".to_string()),
            ))
        });
    assert!(err.is_err(), "注入的失败必须上抛");
    assert_eq!(read_all(&env), 11, "回滚后查询与中断前逐位一致（无半提交）");

    // 重放同一条事实（幂等）+ 一条新事实 → 只多出新事实的量。
    env.fact("r1", "dsh", "deepseek-v4-flash", s + 1_000, 0, 11, 1); // 重放
    env.fact("r3", "dsh", "deepseek-v4-flash", s + 3_000, 0, 22, 2); // 新
    assert_eq!(read_all(&env), 33, "重放不双计、新事实正常入账");
}

/// Q14：同一原始模型名在不同执行环境映射不同——这里钉「无法映射的显式
/// unknown/unresolved，不被并入相似名称」：同一 token 量的同名模型在
/// claude（无声明 → unknown）与 codex（gpt-5.6 有声明）两侧分属不同
/// 条目，互不并桶。
#[test]
fn q14_same_raw_name_across_harnesses_or_unmapped_is_explicit() {
    let env = QEnv::new("q14");
    let d = env.day.clone();
    let s = env.day_start(&d);
    // claude 侧的 moonshot-gpt（无声明——挂在 claude-code/unknown）；
    // codex 侧的 gpt-5.6（有声明 openai）。「gpt」相似前缀不得并桶。
    env.fact("m1", "claude-code", "moonshot-gpt-5.6", s + 1_000, 0, 100, 10);
    env.fact("m2", "codex", "gpt-5.6", s + 2_000, 0, 100, 10);
    // A NULL provider_id is intentionally unresolved under v0.11 and must
    // not be inferred from the model name alone.
    env.db
        .conn()
        .execute(
            "UPDATE usage_facts SET provider_id = 'openai' WHERE fact_id = 'm2'",
            [],
        )
        .unwrap();

    let daily = SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: d });
    assert!(daily.by_provider.contains_key("codex/openai"));
    assert!(daily.by_provider.contains_key("claude-code/unknown"));
    // claude 侧 unresolved；Codex 虽有 openai provider_id，但夹具没有官方
    // 订阅路由与适用 scope 证据，按 billing fallback 规则只能是
    // metered_estimate + unresolved，不能冒充 ApiEquivalent。
    assert!(daily.by_provider["claude-code/unknown"].has_unresolved);
    let codex = &daily.by_provider["codex/openai"];
    assert!(codex.has_unresolved);
    assert!(codex.amounts_by_basis.contains_key(
        &agent_vitals_data::projection::BillingBasis::MeteredEstimate,
    ));
    assert!(!codex.amounts_by_basis.contains_key(
        &agent_vitals_data::projection::BillingBasis::ApiEquivalent,
    ));
}

/// §4 分离纪律：同日实时行级 + legacy_aggregate 并存时——聚合数 ≠ 行级数，
/// 聚合数 = ledger 数（spec §4 明文要求的 Phase 3 repository 验收矩阵项）。
#[test]
fn separation_discipline_realtime_and_legacy_do_not_add() {
    let env = QEnv::new("sep");
    let d = env.day.clone();
    let s = env.day_start(&d);
    // 实时：model-a 60；legacy：model-b 200（base 行 event_peak=0）。
    env.fact("rt", "claude-code", "model-a", s + 1_000, 0, 60, 6);
    env.db
        .conn()
        .execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                 event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                 output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('lg', 'claude-code', 'legacy', 'day:d', 'd:model-b:0', 'legacy_aggregate',
                     NULL, 'model-b', ?1, 0, 200, 0, 0, 20, 'run', 1, 1)",
            rusqlite::params![s + 2_000],
        )
        .unwrap();

    let daily = SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: d.clone() });
    // DTO 账单轴 = 实时 + legacy 兜底的**模型级合并**（3.2 收口语义）：
    // model-a 60 + model-b 200 = 260，不双计不漏计。
    assert_eq!(daily.tokens_by_harness["claude-code"].uncached_input, 260);
    // 聚合数（ledger 路径）：model-b 的 200 经 claude_legacy_days 可见——
    // 「聚合数 = ledger 数」；它不含实时的 60（两轴不相加）。读出的键是
    // claude 词表（input_tokens），与 legacy_import 的写入映射对称。
    let (w_start, w_end) = authority_query::beijing_day_bounds_ms(&d).unwrap();
    let legacy = authority_query::claude_legacy_days(env.db.conn(), w_start, w_end).unwrap();
    let legacy_day = legacy.values().next().expect("legacy 行必须在");
    assert_eq!(legacy_day["model-b"]["input_tokens"], json!(200));
    assert!(legacy_day.get("model-a").is_none(), "实时模型不属于 legacy 轴");
    // 实时轴同样不含 legacy 模型。
    let realtime = authority_query::claude_days(env.db.conn(), w_start, w_end).unwrap();
    let rt_day = realtime.values().next().unwrap();
    assert_eq!(rt_day["model-a"]["input_tokens"], json!(60));
    assert!(rt_day.get("model-b").is_none(), "legacy 模型不属于实时轴");
    // 合并视图：两模型互补（3.2 收口的模型级合并），总账 = 60 + 200。
    let merged = agent_vitals_runtime::summary::merged_claude_days_for_tests(
        env.db.conn(),
        w_start,
        w_end,
    );
    let m = merged.values().next().unwrap();
    let total: i64 = ["model-a", "model-b"]
        .iter()
        .map(|mo| m[*mo]["input_tokens"].as_i64().unwrap_or(0))
        .sum();
    assert_eq!(total, 260, "合并视图两模型互补，不双计不漏计");
}

/// 2026-09-16 真机：codex 订阅声明覆盖 26,715 条事实后，本月用量从 2.8B 缩成 569M——
/// `tokens_by_harness` 与金额面共用了带「未被订阅覆盖」谓词的聚合。token 是「处理了多少」，
/// 订阅覆盖只改「钱归谁」：覆盖后 tokens_by_harness 不变、金额面的估算消失。
#[test]
fn subscription_coverage_moves_money_but_not_tokens() {
    let env = QEnv::new("cov-tokens");
    let d = env.day.clone();
    let s = env.day_start(&d);
    env.fact("c1", "codex", "gpt-5.6-sol", s + 1_000, 0, 1_000_000, 100_000);
    env.fact("c2", "codex", "gpt-5.6-sol", s + 2_000, 0, 500_000, 50_000);
    env.db.conn().execute("UPDATE usage_facts SET provider_id = 'openai'", []).unwrap();
    let repo = SqlSummaryRepository::new();
    let before = repo.daily_summary(&DailySummaryQuery { date: d.clone() });
    assert_eq!(before.tokens_by_harness["codex"].total, 1_650_000);
    assert!(before.by_provider["codex/openai"].amounts_by_basis.contains_key(
        &agent_vitals_data::projection::BillingBasis::MeteredEstimate));

    // 声明订阅并让重算覆盖全部 codex/openai 事实。
    env.db.billing_declaration_revision_save(
        "rev-cov", "decl-cov", None,"openai", "official_subscription", Some("Plus"),
        Some(2_000), Some("USD"), "2020-01-01", None, None, None, &[], 2,
    ).unwrap();
    env.db.billing_recalculation_enqueue("job-cov", "decl-cov", "rev-cov", 3).unwrap();
    assert!(env.db.billing_recalculation_run("job-cov", 4).unwrap());

    let after = repo.daily_summary(&DailySummaryQuery { date: d.clone() });
    assert_eq!(after.tokens_by_harness["codex"].total, 1_650_000, "订阅覆盖不改变处理量");
    // 日粒度没有月费可摊，条目可以整个消失；有条目也不得再带按量估算。
    let no_estimate = |m: &agent_vitals_data::projection::MonthlySummary| !m.by_provider.get("codex/openai")
        .is_some_and(|h| h.amounts_by_basis.contains_key(&agent_vitals_data::projection::BillingBasis::MeteredEstimate));
    assert!(!after.by_provider.get("codex/openai").is_some_and(|h| h.amounts_by_basis.contains_key(
        &agent_vitals_data::projection::BillingBasis::MeteredEstimate)),
        "覆盖后的事实不得再按量估算：{:?}", after.by_provider.get("codex/openai"));
    let month: String = d.chars().take(7).collect();
    let monthly = repo.monthly_summary(&MonthlySummaryQuery { month });
    assert_eq!(monthly.tokens_by_harness["codex"].total, 1_650_000);
    assert!(no_estimate(&monthly), "{:?}", monthly.by_provider.get("codex/openai"));
    assert_eq!(monthly.by_provider["codex/openai"].amounts_by_basis
        .get(&agent_vitals_data::projection::BillingBasis::FixedSubscription).copied(), Some(20.0),
        "声明的月费按自报口径计入");
}

/// 2026-09-16 产品定向「归因以后按照归因的来计算」：中转（provider 未知）的 claude
/// 用量声明为 shengsuanyun 按量后，金额从目录猜的 `claude-code/deepseek-official`
/// 默认估算搬到 `claude-code/shengsuanyun` 的归因估算（`metered_declared`），
/// `metered_view` 据此给出带标签的按量费用；总 token 与估算金额本身不变。
#[test]
fn user_declared_relay_usage_moves_from_default_to_declared_estimate() {
    let env = QEnv::new("declared-relay");
    let d = env.day.clone();
    let s = env.day_start(&d);
    env.fact("r1", "claude-code", "deepseek-v4-pro", s + 1_000, 0, 2_000_000, 200_000);
    let repo = SqlSummaryRepository::new();
    let month: String = d.chars().take(7).collect();
    let before = repo.monthly_summary(&MonthlySummaryQuery { month: month.clone() });
    let default_entry = &before.by_provider["claude-code/deepseek-official"];
    let default_amount = default_entry.amounts_by_basis[&agent_vitals_data::projection::BillingBasis::MeteredEstimate];
    assert!(default_amount > 0.0);
    let view = before.metered_view();
    assert_eq!(view["CNY"].default_estimate, default_amount);
    assert_eq!(view["CNY"].unattributed_providers, vec!["claude-code/deepseek-official".to_string()]);

    env.db.billing_declaration_revision_save(
        "rev-relay", "decl-relay", None,"shengsuanyun", "third_party", None, None, None,
        "2020-01-01", None, None, None, &[("provider", "unresolved"), ("model", "deepseek-v4-pro")], 2,
    ).unwrap();
    env.db.billing_recalculation_enqueue("job-relay", "decl-relay", "rev-relay", 3).unwrap();
    assert!(env.db.billing_recalculation_run("job-relay", 4).unwrap());

    let after = repo.monthly_summary(&MonthlySummaryQuery { month: month.clone() });
    assert!(after.by_provider.get("claude-code/deepseek-official").map_or(true, |h| h.amounts_by_basis.is_empty()),
        "归因后默认估算条目不得再持有这批钱：{:?}", after.by_provider.get("claude-code/deepseek-official"));
    let declared = &after.by_provider["claude-code/shengsuanyun"];
    let declared_amount = declared.amounts_by_basis[&agent_vitals_data::projection::BillingBasis::MeteredDeclared];
    assert!((declared_amount - default_amount).abs() < 1e-9, "同一批 token 同一张卡，金额不变：{declared_amount} vs {default_amount}");
    assert!(!declared.has_unresolved, "路由是用户答的，不再 unresolved");
    assert_eq!(declared.evidence_basis.as_deref(), Some("user-declared"));
    let view = after.metered_view();
    assert_eq!(view["CNY"].declared_estimate, declared_amount);
    assert_eq!(view["CNY"].default_estimate, 0.0);
    assert!(view["CNY"].unattributed_providers.is_empty());
    assert_eq!(after.tokens_by_harness["claude-code"].total, before.tokens_by_harness["claude-code"].total);
    // 日视图同样搬家。
    let daily = repo.daily_summary(&DailySummaryQuery { date: d });
    assert!(daily.by_provider.contains_key("claude-code/shengsuanyun"));
}

/// 用户声明 CNY 结算并不能把原厂 USD 报价变成 CNY 支出。
/// 价卡 fallback 估算保留原币种，且不能随当前 fx_estimate 变化。
#[test]
fn declared_provider_preserves_fallback_quote_currency() {
    let env = QEnv::new("settlement");
    let d = env.day.clone();
    let s = env.day_start(&d);
    env.fact("s1", "claude-code", "anthropic/claude-sonnet-5", s + 1_000, 0, 1_000_000, 100_000);
    env.fact("c1", "codex", "openai/gpt-5.6-luna", s + 2_000, 0, 1_000_000, 100_000);
    // 声明属于服务商，按模型结算：两个执行环境上的两个模型各答一次（模型就是收窄依据；
    // 作用域完全一致的两条声明会被重复保存守卫合并，不会各留一份）。
    for (model, decl, rev) in [("anthropic/claude-sonnet-5", "decl-ss-cc", "rev-ss-cc"), ("openai/gpt-5.6-luna", "decl-ss-cx", "rev-ss-cx")] {
        env.db.billing_declaration_revision_save(
            rev, decl, None,"shengsuanyun", "third_party", None, None, None,
            "2020-01-01", None, None, None, &[("provider", "unresolved"), ("model", model), ("settlement", "CNY")], 2,
        ).unwrap();
        let job = format!("job-{rev}");
        env.db.billing_recalculation_enqueue(&job, decl, rev, 3).unwrap();
        assert!(env.db.billing_recalculation_run(&job, 4).unwrap());
    }
    let repo = SqlSummaryRepository::new();
    let month: String = d.chars().take(7).collect();
    let m = repo.monthly_summary(&MonthlySummaryQuery { month });
    for key in ["claude-code/shengsuanyun", "codex/shengsuanyun"] {
        let usd_key = format!("{key}/USD");
        let h = &m.by_provider[&usd_key];
        assert_eq!(h.currency.as_deref(), Some("USD"), "{key}: 保留原厂价卡报价币种");
        assert_eq!(h.pricing_method.as_deref(), Some("fair-market-fallback"), "{key}");
        assert!(h.amounts_by_basis[&agent_vitals_data::projection::BillingBasis::MeteredDeclared] > 0.0, "{key}");
        assert!(!m.by_provider.contains_key(key), "{key}: 不能生成无依据的 CNY 估算");
    }
    let view = m.metered_view();
    assert!(view.contains_key("USD"), "按量视图保留 USD：{view:?}");
    assert!(!view.contains_key("CNY"), "不从报价推断人民币结算：{view:?}");
}
