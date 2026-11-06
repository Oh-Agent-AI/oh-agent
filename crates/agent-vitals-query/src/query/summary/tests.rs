

use super::*;

/// zcode 执行环境接入收尾（2026-09-23）：插件执行环境 tokens 可见性 + 零漂移守卫。
/// harnesses.d 是机器本地配置——空 data_home 下扫描为空，monthly/daily 输出与
/// 接入前逐字节一致（golden 双世界钉的是同一性质）。
#[test]
fn plugin_tokens_by_harness_lists_installed_and_stays_silent_when_absent() {
    use agent_vitals_data::repository::SummaryRepository;
    let dir = std::env::temp_dir().join(format!(
        "av-plugin-tk-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    let data_home = dir.join("dh");
    let user_home = dir.join("home");
    std::fs::create_dir_all(data_home.join("harnesses.d/zcode")).unwrap();
    std::fs::create_dir_all(user_home.join("rollout")).unwrap();
    std::fs::write(
        data_home.join("harnesses.d/zcode/manifest.json"),
        r#"{"manifest_version":1,"slug":"zcode","display":{"name":"ZCode"},
            "discovery":{"roots":["{HOME}/rollout"],"include":["*.jsonl"]},
            "source":{"format":"jsonl"},
            "session":{"from":"filename","pattern":"^model-io-sess_(?P<id>.+)\\.jsonl$"},
            "recipe":"request-usage-four-bucket-v1",
            "event_key":{"paths":["requestId","attempt"]},
            "billing":{"policy":"lock:metered_estimate"},
            "overrides":{"event_ts":"completedAt","model_raw":"model.modelId",
              "uncached_input_tokens":"u.input_tokens","cache_read_tokens":"u.cache_read_input_tokens",
              "cache_write_tokens":"u.cache_write_input_tokens","output_tokens":"u.output_tokens",
              "provider_request_id":"requestId"}}"#.replace("{HOME}", user_home.to_str().unwrap()),
    )
    .unwrap();
    std::fs::write(
        user_home.join("rollout/model-io-sess_tk1.jsonl"),
        concat!("{", r#""requestId":"r1","attempt":1,"completedAt":"2026-09-23T05:39:16.711Z","model":{"modelId":"GLM-5.3"},"u":{"input_tokens":10,"cache_read_input_tokens":20,"cache_write_input_tokens":0,"output_tokens":3}"#, "}\n"),
    )
    .unwrap();

    // Candidate discovery is not activation: confirm through the real lifecycle first.
    let manifest = data_home.join("harnesses.d/zcode/manifest.json");
    let preview = agent_vitals_ingest::ingest::local_manifest_install::local_manifest_install(
        &manifest, "ns-tk", &data_home, &user_home, &[], None).unwrap();
    agent_vitals_ingest::ingest::local_manifest_install::local_manifest_install(
        &manifest, "ns-tk", &data_home, &user_home, &[], preview["preview_sha256"].as_str()).unwrap();
    // 走正式 ingest（exactly-once + authority 落库），再验 tokens 可见性。
    let results = agent_vitals_ingest::plugin_ingest::ingest_installed("ns-tk", &data_home, &user_home);
    assert_eq!(results.len(), 1, "恰一个已装 manifest: {results:?}");
    let (slug, res) = &results[0];
    assert_eq!(slug, "zcode", "首条必须是成功条目而非 manifest 错误: {res:?}");
    let payload = res.as_ref().expect("ingest 成功");
    let appended = payload["ingest"]["harnesses"][0]["appended"].as_i64();
    assert_eq!(appended, Some(1), "首装一条：{payload}");
    let _ = appended;

    let repo = SqlSummaryRepository::at(&data_home);
    let monthly = repo.monthly_summary(&MonthlySummaryQuery { month: "2026-09".into() });
    let tk = monthly.tokens_by_harness.get("harness:zcode")
        .expect("插件执行环境 tokens 必须可见（L0 处理量纪律）");
    assert_eq!(tk.total, 33, "10+20+0+3");
    assert_eq!(tk.uncached_input, 10);
    assert_eq!(tk.cache_read, 20);
    assert!(!monthly.by_harness.contains_key("harness:zcode"),
        "金额面不入（billing 声明前 L0 纪律）");

    // 幂等重放：duplicate 吸收，tokens 不变。
    let _ = agent_vitals_ingest::plugin_ingest::ingest_installed("ns-tk", &data_home, &user_home);
    let monthly2 = repo.monthly_summary(&MonthlySummaryQuery { month: "2026-09".into() });
    assert_eq!(monthly2.tokens_by_harness.get("harness:zcode").unwrap().total, 33);

    // 零漂移守卫：无 harnesses.d 的 data_home → 插件面静默缺席。
    let bare = dir.join("bare");
    std::fs::create_dir_all(&bare).unwrap();
    let repo_bare = SqlSummaryRepository::at(&bare);
    let m_bare = repo_bare.monthly_summary(&MonthlySummaryQuery { month: "2026-09".into() });
    assert!(!m_bare.tokens_by_harness.contains_key("harness:zcode"));

    let _ = std::fs::remove_dir_all(&dir);
}
use serde_json::json;

fn with_home<F: FnOnce()>(f: F) {
    let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("avr-summary-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let prev = std::env::var("AGENT_VITALS_HOME").ok();
    std::env::set_var("AGENT_VITALS_HOME", &dir);
    f();
    match prev {
        Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
        None => std::env::remove_var("AGENT_VITALS_HOME"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn codex_unresolved_rows_read_the_two_layer_by_model_shape() {
    // 真实形状（codex_by_model_from_hours 产物）：model → speed → 桶对象，
    // 桶键 = CODEX_TOKEN_FIELDS（cached_input_tokens 而非 cache_read——
    // 审查 P1-1 的错键名在这里被钉死）。
    use agent_vitals_harnesses::codex_usage::codex_by_model_from_hours;
    let by_hour = json!({
        "2026-09-05T10:00:00.000Z": {
            "gpt-5.3-mystery": {
                "standard": {"uncached_input_tokens": 100, "output_tokens": 20,
                             "cached_input_tokens": 300, "cache_write_input_tokens": 5,
                             "reasoning_output_tokens": 0}
            }
        }
    });
    let by_model = codex_by_model_from_hours(&by_hour, None);
    let priced: std::collections::HashSet<String> = Default::default();
    let rows = codex_unresolved_rows(&by_model, &priced);
    assert_eq!(rows.len(), 1, "未计价模型必须浮出——单层/错键读法这里恒空");
    assert_eq!(rows[0]["model"], json!("gpt-5.3-mystery"));
    assert_eq!(rows[0]["reason"], json!("no-price-card"));
    assert_eq!(rows[0]["tokens"], json!(425), "5 桶之和 = 100+20+300+5+0");
    // priced 模型不进下钻。
    let mut priced2 = std::collections::HashSet::new();
    priced2.insert("gpt-5.3-mystery".to_string());
    assert!(codex_unresolved_rows(&by_model, &priced2).is_empty());
}

#[test]
fn unresolved_detail_flags_unrouted_models_from_sql() {
    with_home(|| {
        // no-card 模型（真机 GLM 无价卡同款）：SQL 事实有量、无路由/无卡。
        let db = seed_authority_db();
        let ts = agent_vitals_data::authority_query::beijing_day_bounds_ms("2026-09-02")
            .unwrap()
            .0
            + 12 * 3_600_000;
        seed_fact(
            &db,
            "glm-unpriced",
            "claude-code",
            Some("glm-5.3-flash"),
            "message",
            ts,
            0,
            1_000,
            2_000,
            0,
            100,
        );
        seed_fact(
            &db,
            "synthetic-zero",
            "claude-code",
            Some("<synthetic>"),
            "message",
            ts,
            0,
            0,
            0,
            0,
            0,
        );
        drop(db);
        let detail = unresolved_detail("2026-09");
        let found = detail
            .as_object()
            .unwrap()
            .iter()
            .flat_map(|(_, rows)| rows.as_array().unwrap().iter())
            .find(|r| r["model"] == json!("glm-5.3-flash"))
            .unwrap_or_else(|| panic!("expected glm row, got {detail}"));
        assert_eq!(found["tokens"], json!(3_100));
        // 0-token 哨兵行不进下钻。
        let synthetic = detail
            .as_object()
            .unwrap()
            .iter()
            .flat_map(|(_, rows)| rows.as_array().unwrap().iter())
            .find(|r| r["model"] == json!("<synthetic>"));
        assert!(synthetic.is_none(), "0-token 行不进下钻，got {detail}");
    });
}

#[test]
fn unresolved_billing_groups_carries_real_scope_and_excludes_subscriptions() {
    with_home(|| {
        let db = seed_authority_db();
        let ts = agent_vitals_data::authority_query::beijing_day_bounds_ms("2026-09-02")
            .unwrap().0 + 12 * 3_600_000;
        seed_fact(&db, "group-unknown", "codex", Some("gpt-mystery"), "token_count", ts, 0, 100, 20, 0, 5);
        // seed_fact 不写 session_key，故此行同时钉住 native-session fallback。
        seed_fact(&db, "group-legacy", "codex", Some("gpt-legacy"), "legacy_aggregate", ts, 0, 9_000, 0, 0, 0);
        seed_fact(&db, "group-subscription", "codex", Some("gpt-plan"), "token_count", ts, 0, 900, 0, 0, 0);
        db.conn().execute(
            "UPDATE usage_facts SET billing_mode = 'subscription', pricing_basis = 'subscription' WHERE fact_id = 'group-subscription'", []
        ).unwrap();
        let groups = unresolved_billing_groups("2026-09");
        assert_eq!(groups["status"], json!("ok"));
        let rows = groups["groups"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["harness"], json!("codex"));
        assert_eq!(rows[0]["model_id"], json!("gpt-mystery"));
        assert_eq!(rows[0]["tokens"], json!(125));
        assert_eq!(rows[0]["session_count"], json!(1));
        assert!(rows[0]["estimated_cost_minor"].is_null(), "no amount may be invented before historical price aggregation");
    });
}

/// **任意关系种类都能把自己的组关掉，撤销后重开**（2026-09-16 真机缺口）：
/// 确认「经中转」（third_party）此前既不入队重算、组谓词也只认 subscription_covered
/// ——声明存下了、行却永远留在待确认里。现在重算为非订阅关系写 `user_declared`
/// 归因行（金额不变，D02），组谓词认它；撤销后 MAX 修订变 revoked，组回来。
#[test]
fn declared_relations_of_any_kind_close_their_group_until_revoked() {
    with_home(|| {
        let db = seed_authority_db();
        let ts = agent_vitals_data::authority_query::beijing_day_bounds_ms("2026-09-02")
            .unwrap().0 + 12 * 3_600_000;
        seed_fact(&db, "group-relay", "codex", Some("gpt-relay"), "token_count", ts, 0, 100, 20, 0, 5);
        db.billing_declaration_revision_save(
            "rev-relay", "decl-relay", None,"shengsuanyun.com", "third_party",
            None, None, None, "2026-09-01", None, None, None,
            &[("provider", "unresolved"), ("model", "gpt-relay")], 1,
        ).unwrap();
        db.billing_recalculation_enqueue("job-relay", "decl-relay", "rev-relay", 2).unwrap();
        assert!(db.billing_recalculation_run("job-relay", 3).unwrap());

        let rows = unresolved_billing_groups("2026-09")["groups"].as_array().unwrap().clone();
        assert!(
            rows.iter().all(|row| row["model_id"] != json!("gpt-relay")),
            "确认经中转后该组必须从待确认里消失（user_declared 也算已回答）",
        );

        assert!(db.billing_declaration_revision_revoke("rev-relay-revoke", "decl-relay", "rev-relay", 4).unwrap());
        let rows = unresolved_billing_groups("2026-09")["groups"].as_array().unwrap().clone();
        assert!(
            rows.iter().any(|row| row["model_id"] == json!("gpt-relay")),
            "撤销后组重新打开（MAX 修订是 revoked）",
        );
    });
}

/// 组装层：monthly summary 的 by_provider 必含三个执行环境的 provider 条目、
/// 不含 workbuddy（excluded 检查双向成立）、contract_violations 为空、
/// by_harness 与 by_provider 互不串扰。
/// 当前月的 Beijing 毫秒时点（月首中午，安全在窗内）——转 SQL 后
/// 各测试种 fact 用同一个。
fn current_month_noon_ms() -> i64 {
    let m = crate::clock::current_month_beijing();
    agent_vitals_data::authority_query::beijing_month_bounds_ms(&m)
        .unwrap()
        .0
        + 12 * 3_600_000
}

#[test]
fn monthly_summary_fills_by_provider_without_contract_violations() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let ts = current_month_noon_ms();
        let db = seed_authority_db();
        seed_fact(
            &db,
            "d1",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            ts,
            0,
            1_000_000,
            0,
            0,
            100_000,
        );
        seed_fact(
            &db,
            "x1",
            "codex",
            Some("gpt-5.6-sol"),
            "token_count",
            ts,
            0,
            800_000,
            200_000,
            50_000,
            80_000,
        );
        seed_fact(
            &db,
            "c1",
            "claude-code",
            Some("claude-opus-5"),
            "message",
            ts,
            0,
            1_000_000,
            0,
            0,
            100_000,
        );
        drop(db);
        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        assert!(
            summary.contract_violations().is_empty(),
            "{:?}",
            summary.contract_violations()
        );
        assert!(
            summary.by_provider.contains_key("dsh/deepseek-official"),
            "{:?}",
            summary.by_provider.keys()
        );
        assert!(summary.by_provider.contains_key("codex/openai")
            || summary.by_provider.contains_key("codex/<unknown>"),
            "Codex facts without provider evidence must remain unresolved: {:?}",
            summary.by_provider.keys());
        // DSH 条目与执行环境条目同额同档（同一 provider 镜像）。
        let dsh_harness = &summary.by_harness["dsh"];
        let dsh_prov = &summary.by_provider["dsh/deepseek-official"];
        assert_eq!(dsh_harness.amounts_by_basis, dsh_prov.amounts_by_basis);
        // excluded 执行环境不得出现在 by_provider（键的执行环境部分）。
        assert!(summary
            .by_provider
            .keys()
            .all(|k| k.split('/').next() != Some("workbuddy")));
        // by_provider 的条目不回灌 total_summable（总额仍只按 by_harness 算，
        // 否则同一笔钱进两次——month.json 三倍计数事故的结构镜像）。
        let via_harness = summary.total_summable();
        let harness_only_sum: f64 = summary
            .by_harness
            .values()
            .map(|h| {
                h.amounts_by_basis
                    .iter()
                    .filter(|(b, _)| b.summable_into_total())
                    .map(|(_, v)| v)
                    .sum::<f64>()
            })
            .sum();
        assert_eq!(via_harness, harness_only_sum);
    });
}

/// 干净安装回归：公共目录只提供原厂价卡，不能自动注入任何用户月费；
/// 有价卡的未确认用量仍须按量估算并标记待确认。
#[test]
fn public_catalog_never_injects_user_subscription_fees() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let db = seed_authority_db();
        seed_fact(
            &db,
            "c1",
            "claude-code",
            Some("claude-opus-5"),
            "message",
            current_month_noon_ms(),
            0,
            1_000_000,
            0,
            0,
            100_000,
        );
        drop(db);
        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        assert!(
            summary.contract_violations().is_empty(),
            "{:?}",
            summary.contract_violations()
        );
        let anthropic = &summary.by_provider["claude-code/anthropic"];
        assert!(anthropic
            .amounts_by_basis
            .contains_key(&BillingBasis::MeteredEstimate));
        assert!(anthropic.has_unresolved);
        assert!(!anthropic.amounts_by_basis.contains_key(&BillingBasis::FixedSubscription));
        assert!(!summary.by_provider.contains_key("claude-code/zhipu-glm"),
                "公共目录不得给新安装补建个人GLM月费");
        // 账期过滤：2020-01 早于一切 period_start → 无任何订阅条目被补建。
        let old = SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery {
            month: "2020-01".to_string(),
        });
        assert!(!old.by_provider.contains_key("claude-code/anthropic"));
        assert!(!old.by_provider.contains_key("claude-code/zhipu-glm"));
        // FixedSubscription 可汇总：月度总额现在含订阅费（spec §4「固定
        // 订阅可以按口径汇总」——总额首次等于真实月支出）。
        assert!(BillingBasis::FixedSubscription.summable_into_total());
        let summable = old.total_summable();
        assert_eq!(summable, 0.0, "2020-01 无任何数据，总额不含月费");
    });
}

/// 日粒度**不摊**订阅费（月费不是日发生额）。干净安装的 Anthropic
/// 用量按量估算、待确认，且没有 FixedSubscription。
#[test]
fn subscription_fees_never_leak_into_daily() {
    with_home(|| {
        let day = "2026-09-02";
        let ts = agent_vitals_data::authority_query::beijing_day_bounds_ms(day)
            .unwrap()
            .0
            + 12 * 3_600_000;
        let db = seed_authority_db();
        seed_fact(
            &db,
            "c1",
            "claude-code",
            Some("claude-opus-5"),
            "message",
            ts,
            0,
            1_000_000,
            0,
            0,
            100_000,
        );
        drop(db);
        let daily = SqlSummaryRepository::new().daily_summary(&DailySummaryQuery {
            date: day.to_string(),
        });
        assert!(
            daily.contract_violations().is_empty(),
            "{:?}",
            daily.contract_violations()
        );
        let anthropic = &daily.by_provider["claude-code/anthropic"];
        assert!(anthropic
            .amounts_by_basis
            .contains_key(&BillingBasis::MeteredEstimate));
        assert!(anthropic.has_unresolved);
        assert!(
            !anthropic
                .amounts_by_basis
                .contains_key(&BillingBasis::FixedSubscription),
            "订阅月费不得摊进日账: {:?}",
            anthropic.amounts_by_basis
        );
    });
}

/// 审查 #2 的端到端回归——`dsh_tokens` 对**单日对象**（daily_summary 传
/// `day_value`）不得再返回恒零：此前按 {date: day} map 的窗口过滤对字段
/// 名键永假，「今日 tokens」的 DSH 贡献静默归零（假零）。by_model-only
/// 变形日（跨零点切片）也要经 by_model 回退计入。
#[test]
fn dsh_tokens_daily_path_is_not_structurally_zero() {
    let day = json!({
        "by_model": {"deepseek-v4-flash": {
            "uncached_input_tokens": 1_000_000, "output_tokens": 100_000,
            "cache_read_tokens": 250_000, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        }},
        "cache_read_tokens": 0, "cache_write_tokens": 0,
        "output_tokens": 0, "uncached_input_tokens": 0,
    });
    // 日度路径：单日对象直接进（无窗口过滤语义）。
    let tk = dsh_day_tokens(&day);
    assert_eq!(tk.total, 1_350_000, "by_model-only 变形日不得计零");
    // 月度路径：{date: day} map，变形日在窗口内。
    let days = json!({ "2026-09-05": day });
    let month_tk = dsh_tokens(Some(&days), "2026-09");
    assert_eq!(month_tk.total, 1_350_000);
}

/// 上一条测的是私有函数；这条钉住**实际调用点**
/// （`SqlSummaryRepository::daily_summary`）——`CODE_REVIEW_V0_9_STAGE_
/// A_D_KPI_BILLING.md` 头部 bug #2 的完整回归：`dsh_day_tokens` 造出来
/// 之后没有一条测试真的走 `daily_summary` 这条公开路径去断言 DSH 的
/// `tokens_by_harness` 非零，调用点因此漏改，恒零一直没被抓到。
#[test]
fn daily_summary_reports_nonzero_dsh_tokens_for_a_real_day() {
    with_home(|| {
        let day = crate::clock::today_beijing();
        let ts = agent_vitals_data::authority_query::beijing_day_bounds_ms(&day)
            .unwrap()
            .0
            + 3_600_000;
        let db = seed_authority_db();
        seed_fact(
            &db,
            "d1",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            ts,
            0,
            1_000_000,
            250_000,
            0,
            100_000,
        );
        drop(db);
        let daily = SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: day });
        let dsh_tk = &daily.tokens_by_harness["dsh"];
        assert_eq!(dsh_tk.total, 1_350_000, "DSH 今日 token 不得假零");
        assert_eq!(dsh_tk.uncached_input, 1_000_000);
    });
}

/// 0.6b 落地的回归——DSH 的 `compute_month` 对"本月有 day 但 token 全
/// 0"返回 `Some({total: 0,})`。修之前直接进 MeteredActual=0 + Stale
/// 分支，前端渲染成「实测 0.00 + 过期 YYYY-MM-DD」——数字看着像"测到
/// 零"、实则是"本月没真实 token 入账"，违反 spec §0.1。修：total=0
/// 时不入 MeteredActual、保留 freshness；前端自然走到「无可计金额 +
/// 过期 · 最后观测 YYYY-MM-DD」。
#[test]
fn dsh_zero_token_day_does_not_render_as_metered_actual_zero() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        // 有 day（观测到）但四桶全 0（MeasuredZero，不是 Unavailable）。
        let db = seed_authority_db();
        seed_fact(
            &db,
            "d0",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            current_month_noon_ms(),
            0,
            0,
            0,
            0,
            0,
        );
        drop(db);
        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        let dsh = &summary.by_harness["dsh"];
        // total=0 → 不入 MeteredActual（金额表留空）+ freshness 照报（day
        // 存在 = 测到日，不是 Unavailable）。
        assert!(
            dsh.amounts_by_basis.is_empty(),
            "got {:?}",
            dsh.amounts_by_basis
        );
        assert!(!dsh.has_unresolved);
        assert!(dsh.freshness.last_observed_at.is_some());
        assert_ne!(dsh.freshness.state, FreshnessState::Unavailable);
    });
}

/// 接线结构（真机）：三执行环境全进 `by_harness`、不进 `excluded_harnesses`；汇总
/// 新鲜度 = 最新被观测到的执行环境（不是硬编码 dsh）；非 summable 的金额
/// （codex/claude 的 MeteredEstimate）
/// 不得混进 `total_summable`——可汇总总额必须恰好等于各执行环境 summable
/// 档之和，估算与诊断价再大也不出现。
#[test]
fn monthly_summary_wires_all_harnesses_without_leaking_into_total() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let ts = current_month_noon_ms();
        let db = seed_authority_db();
        // 三执行环境各一笔：dsh 出 MeteredActual（summable），codex 出
        // MeteredEstimate（非 summable），claude 同样为 MeteredEstimate。
        seed_fact(
            &db,
            "d1",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            ts,
            0,
            1_000_000,
            0,
            0,
            100_000,
        );
        seed_fact(
            &db,
            "x1",
            "codex",
            Some("gpt-5.6-sol"),
            "token_count",
            ts,
            0,
            800_000,
            200_000,
            50_000,
            80_000,
        );
        seed_fact(
            &db,
            "c1",
            "claude-code",
            Some("deepseek-v4-flash"),
            "message",
            ts,
            0,
            1_000_000,
            0,
            0,
            100_000,
        );
        drop(db);
        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        assert!(
            summary.contract_violations().is_empty(),
            "{:?}",
            summary.contract_violations()
        );
        assert!(summary.by_harness.contains_key("codex"));
        assert!(summary.by_harness.contains_key("dsh"));
        assert!(summary.by_harness.contains_key("claude-code"));
        assert!(summary.by_harness.contains_key("workbuddy"));
        assert!(!summary.excluded_harnesses.contains("codex"));
        assert!(!summary.excluded_harnesses.contains("claude-code"));
        // E4b：四执行环境全接线，excluded 是空集。
        assert_eq!(summary.excluded_harnesses, BTreeSet::new());
        // 汇总新鲜度 = 执行环境里最新的 last_observed_at（字典序=时间序，两处
        // 格式统一 `YYYY-MM-DDT00:00:00Z`）。
        let max_harness = summary
            .by_harness
            .values()
            .filter_map(|h| h.freshness.last_observed_at.clone())
            .max();
        assert_eq!(summary.freshness.last_observed_at, max_harness);
        // spec §4 汇总纪律：总额只收 summable 三档（estimate/诊断价不入）。
        let harness_summable = summary
            .by_harness
            .values()
            .map(|h| {
                h.amounts_by_basis
                    .iter()
                    .filter(|(b, _)| b.summable_into_total())
                    .map(|(_, v)| v)
                    .sum::<f64>()
            })
            .sum::<f64>();
        assert_eq!(summary.total_summable(), harness_summable);
    });
}

#[test]
fn month_with_data_sums_as_metered_actual() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let day = crate::clock::today_beijing();
        let ts = agent_vitals_data::authority_query::beijing_day_bounds_ms(&day)
            .unwrap()
            .0
            + 3_600_000;
        let db = seed_authority_db();
        seed_fact(
            &db,
            "d1",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            ts,
            0,
            1_000_000,
            0,
            0,
            100_000,
        );
        drop(db);
        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        assert!(
            summary.contract_violations().is_empty(),
            "{:?}",
            summary.contract_violations()
        );
        let dsh = &summary.by_harness["dsh"];
        assert_eq!(dsh.freshness.state, FreshnessState::Fresh);
        assert!(dsh
            .amounts_by_basis
            .contains_key(&BillingBasis::MeteredActual));
        assert!(summary.total_summable() > 0.0);
    });
}

// ── SqlSummaryRepository（Phase 3.1）────────────────────────────────

/// 每次都在一个**保证干净**的库上开始——`with_home` 的目录清理是尽力而为
/// （`let _ = remove_dir_all`，失败不追责），残留的 `agent-vitals.sqlite3`
/// 会让下一个测试的 `fact_id`（PRIMARY KEY，全表唯一，不分执行环境）撞车；
/// 显式先删库文件（含 WAL/SHM 旁路文件）比依赖目录级清理更可靠。
fn seed_authority_db() -> agent_vitals_data::authority::AuthorityDb {
    let data_home = crate::home::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap()
}

/// 四张执行环境词表必须同表（加执行环境一处漏改就是「事实进得来、汇总看不见」）。
#[test]
fn wired_harnesses_match_fact_harnesses() {
    let mut wired: Vec<&str> = WIRED_HARNESSES.to_vec();
    wired.sort_unstable();
    let mut facts: Vec<&str> = crate::core::fact_harnesses::FACT_HARNESSES.to_vec();
    facts.sort_unstable();
    assert_eq!(wired, facts);
    for (harness, _) in HARNESS_PROVIDER_MAP {
        assert!(WIRED_HARNESSES.contains(harness), "{harness} in HARNESS_PROVIDER_MAP but not wired");
    }
}

/// E4b（spec WORKBUDDY_ONBOARDING §9E.5）：WorkBuddy 进 `by_harness`/`tokens_by_harness`
/// 但**只有 token、没有金额**——事实 `provider_id: null`（三轨请求级不可判，
/// §2.1），`amounts_by_basis` 必空、`has_unresolved` 必真、不进 `by_provider`；
/// 四桶原样出现在 `tokens_by_harness`（真桶非零，不再是 §7.2 的「恒 0 冒充」）。
/// 月/日两个窗口同一契约，`contract_violations` 为空。
#[test]
fn workbuddy_row_carries_tokens_but_never_money() {
    with_home(|| {
        let day = crate::clock::today_beijing();
        let month = crate::clock::current_month_beijing();
        let ts = agent_vitals_data::authority_query::beijing_day_bounds_ms(&day)
            .unwrap()
            .0
            + 3_600_000;
        let db = seed_authority_db();
        // 与 fixtures/workbuddy traces 的 s1 两条 generation 同数：
        // (12000-8000, 8000, 0, 300) + (15000-11000, 11000, 0, 450)。
        seed_fact(&db, "wb1", "workbuddy", Some("custom-local:MiniMax-M3"), "assistant-usage",
            ts, 0, 4_000, 8_000, 0, 300);
        seed_fact(&db, "wb2", "workbuddy", Some("hy3"), "assistant-usage",
            ts + 60_000, 0, 4_000, 11_000, 0, 450);
        drop(db);
        let repo = SqlSummaryRepository::new();
        let monthly = repo.monthly_summary(&MonthlySummaryQuery { month });
        let daily = repo.daily_summary(&DailySummaryQuery { date: day });
        assert!(monthly.contract_violations().is_empty(), "{:?}", monthly.contract_violations());
        assert!(daily.contract_violations().is_empty(), "{:?}", daily.contract_violations());
        for (label, wb, tk, by_provider) in [
            ("monthly", &monthly.by_harness["workbuddy"], &monthly.tokens_by_harness["workbuddy"],
             &monthly.by_provider),
            ("daily", &daily.by_harness["workbuddy"], &daily.tokens_by_harness["workbuddy"],
             &daily.by_provider),
        ] {
            assert!(wb.amounts_by_basis.is_empty(), "{label}: 金额面必须为空");
            assert!(wb.has_unresolved, "{label}");
            assert_eq!(wb.unresolved_reason.as_deref(), Some("billing-route-unknown"), "{label}");
            assert_eq!(wb.freshness.state, FreshnessState::Fresh, "{label}");
            assert_eq!(tk.uncached_input, 8_000, "{label}");
            assert_eq!(tk.cache_read, 19_000, "{label}");
            assert_eq!(tk.cache_write, 0, "{label}");
            assert_eq!(tk.output, 750, "{label}");
            assert_eq!(tk.total, 27_750, "{label}");
            assert!(
                !by_provider.keys().any(|k| k.starts_with("workbuddy/")),
                "{label}: provider null 的事实没有 harness/provider 键可挂"
            );
        }
        // 没有事实的执行环境照旧 Unavailable + 零 token（不是 workbuddy 抢了别人的桶）。
        assert_eq!(monthly.by_harness["dsh"].freshness.state, FreshnessState::Unavailable);
        assert_eq!(monthly.tokens_by_harness["dsh"].total, 0);
        // total_summable 不受影响（没有钱进来）。
        assert_eq!(monthly.total_summable(), 0.0);
    });
}

/// RUNTIME_INVALIDATION spec 验收 9.10 / 9.11 / 9.12：`calendar_month` 经 memo——
/// 同版本重复读零计算；权威写（revision 前进）、补卡文件变更（配置指纹）、
/// 不同月份（params）各自 miss；被持有的旧 Arc 不被就地修改。
#[test]
fn calendar_month_memo_hits_on_same_version_and_misses_on_every_input_change() {
    use crate::query::read_memo::ReadMemo;
    let dir = std::env::temp_dir().join(format!(
        "avr-cal-memo-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(dir.join("state")).unwrap();
    let path = agent_vitals_data::authority::default_authority_path(&dir);
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap();
    let month = "2026-09";
    let (start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms(month).unwrap();
    let seed = |db: &agent_vitals_data::authority::AuthorityDb, fact_id: &str, ts: i64, out: i64| {
        db.with_immediate_txn(|c| {
            c.execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('run', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING", [])?;
            c.execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                     event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'dsh', 'm', 'sess', ?1, 'assistant-usage', NULL, 'deepseek-chat', ?2,
                     1, 10, 0, 0, ?3, 'run', 1, 1)",
                rusqlite::params![fact_id, ts, out],
            )?;
            Ok(())
        }).unwrap();
    };
    seed(&db, "f1", start + 3_600_000, 5);
    drop(db);

    let repo = SqlSummaryRepository::at(&dir);
    let memo = ReadMemo::with_capacity(8);
    let first = calendar_month_memoized(month, &repo, &memo);
    let second = calendar_month_memoized(month, &repo, &memo);
    assert!(std::sync::Arc::ptr_eq(&first, &second), "same version must hit");
    assert_eq!(memo.stats().hits, 1);
    assert_eq!(memo.stats().misses, 1);
    let tokens_before = first["days"].as_object().unwrap().values()
        .map(|d| d["dsh_tokens"].as_i64().unwrap_or(0)).sum::<i64>();
    assert_eq!(tokens_before, 15);

    // 9.12：另一个月份是另一条目。
    let _ = calendar_month_memoized("2026-08", &repo, &memo);
    assert_eq!(memo.stats().misses, 2);

    // 9.11：权威写 → revision 前进 → miss；旧 Arc 不变。
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, 2).unwrap();
    seed(&db, "f2", start + 7_200_000, 7);
    drop(db);
    let third = calendar_month_memoized(month, &repo, &memo);
    assert!(!std::sync::Arc::ptr_eq(&first, &third));
    assert_eq!(memo.stats().misses, 3);
    let tokens_after = third["days"].as_object().unwrap().values()
        .map(|d| d["dsh_tokens"].as_i64().unwrap_or(0)).sum::<i64>();
    assert_eq!(tokens_after, 32);
    assert_eq!(
        first["days"].as_object().unwrap().values()
            .map(|d| d["dsh_tokens"].as_i64().unwrap_or(0)).sum::<i64>(),
        15, "a held Arc must not change under the caller"
    );

    // 9.12（文件输入）：补卡文件变更 → 配置指纹变 → 同 revision 也 miss。
    let _ = calendar_month_memoized(month, &repo, &memo);
    assert_eq!(memo.stats().misses, 3, "sanity: still hitting before the file changes");
    std::fs::write(
        dir.join("state").join("pricing-overrides.json"),
        r#"{"cards":{"deepseek":{"deepseek-chat":{"currency":"CNY","input":99,"output":99}}}}"#,
    ).unwrap();
    let _ = calendar_month_memoized(month, &repo, &memo);
    assert_eq!(memo.stats().misses, 4, "price-card override must invalidate the memo");

    let _ = std::fs::remove_dir_all(&dir);
}

#[allow(clippy::too_many_arguments)]
fn seed_fact(
    db: &agent_vitals_data::authority::AuthorityDb,
    fact_id: &str,
    harness: &str,
    model_id: Option<&str>,
    observation_kind: &str,
    event_ts_ms: i64,
    event_peak: i64,
    u: i64,
    cr: i64,
    cw: i64,
    o: i64,
) {
    db.conn()
        .execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING",
            [],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                 event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                 output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'm', 'sess', ?1, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'run', 1, 1)",
            rusqlite::params![
                fact_id, harness, observation_kind, model_id, event_ts_ms, event_peak, u, cr, cw, o
            ],
        )
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
fn seed_provider_fact(
    db: &agent_vitals_data::authority::AuthorityDb,
    fact_id: &str,
    harness: &str,
    provider_id: &str,
    model_id: &str,
    event_ts_ms: i64,
    u: i64,
    cr: i64,
    cw: i64,
    o: i64,
) {
    db.conn()
        .execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('provider-run', 1, 'cli', 'succeeded', 1)
             ON CONFLICT(run_id) DO NOTHING",
            [],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO usage_facts(
                 fact_id, harness, machine_namespace, native_session_id,
                 source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                 event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                 output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'm', 'provider-session', ?1, 'token_count', ?3, ?4,
                     ?5, ?5, ?6, ?7, ?8, ?9, 'provider-run', 1, 1)",
            rusqlite::params![fact_id, harness, provider_id, model_id, event_ts_ms, u, cr, cw, o],
        )
        .unwrap();
}

#[test]
fn custom_codex_summary_keeps_fair_market_estimate_out_of_total() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let db = seed_authority_db();
        seed_provider_fact(
            &db,
            "custom-codex-1",
            "codex",
            "cogfoundry.ai",
            "gpt-5.6-sol",
            current_month_noon_ms(),
            1_000_000,
            0,
            0,
            100_000,
        );
        drop(db);

        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        let custom = summary
            .by_provider
            .get("codex/cogfoundry.ai")
            .expect("custom provider must remain visible in the read model");
        let estimate = custom
            .amounts_by_basis
            .get(&BillingBasis::MeteredEstimate)
            .copied()
            .unwrap_or(0.0);
        assert!(estimate > 0.0, "custom route estimate was dropped: {custom:?}");
        assert!(custom.has_unresolved);
        assert_eq!(custom.pricing_method.as_deref(), Some("fair-market-fallback"));
        assert_ne!(custom.evidence_basis.as_deref(), Some("session-native"));
        assert!(!custom
            .amounts_by_basis
            .contains_key(&BillingBasis::ApiEquivalent));
        assert_eq!(summary.total_summable(), 0.0);
    });
}

#[test]
fn custom_codex_mixed_provider_rows_stay_separate() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let db = seed_authority_db();
        let ts = current_month_noon_ms();
        seed_provider_fact(
            &db,
            "custom-codex-mixed",
            "codex",
            "cogfoundry.ai",
            "gpt-5.6-sol",
            ts,
            500_000,
            100_000,
            0,
            50_000,
        );
        seed_provider_fact(
            &db,
            "openai-codex-mixed",
            "codex",
            "openai",
            "gpt-5.6-sol",
            ts,
            500_000,
            100_000,
            0,
            50_000,
        );
        drop(db);

        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        let custom = summary.by_provider.get("codex/cogfoundry.ai").unwrap();
        let openai = summary.by_provider.get("codex/openai").unwrap();
        assert!(custom.has_unresolved);
        assert!(custom
            .amounts_by_basis
            .contains_key(&BillingBasis::MeteredEstimate));
        assert!(openai
            .amounts_by_basis
            .contains_key(&BillingBasis::MeteredEstimate));
        assert!(openai.has_unresolved);
        assert!(!custom
            .amounts_by_basis
            .contains_key(&BillingBasis::ApiEquivalent));
    });
}

#[test]
fn custom_codex_without_model_card_remains_visible_as_unpriced() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let db = seed_authority_db();
        seed_provider_fact(
            &db,
            "custom-codex-no-card",
            "codex",
            "cogfoundry.ai",
            "gpt-unknown-no-card",
            current_month_noon_ms(),
            1_000_000,
            0,
            0,
            10_000,
        );
        drop(db);

        let summary =
            SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery { month });
        let custom = summary.by_provider.get("codex/cogfoundry.ai").unwrap();
        assert!(custom.amounts_by_basis.is_empty());
        assert!(custom.has_unresolved);
        assert_eq!(
            custom.unresolved_reason.as_deref(),
            Some("provider-specific-card-unavailable")
        );
    });
}

#[test]
fn codex_quota_snapshot_reads_authority_without_a_rollout_fallback() {
    with_home(|| {
        let db = seed_authority_db();
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('quota-run', 1, 'cli', 'succeeded', 2)",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO harness_runtime_snapshots(
                     harness, snapshot_kind, payload_json, observed_at_ms,
                     ingested_run_id, updated_at_ms)
                 VALUES ('codex', 'codex_quota', ?1, 2, 'quota-run', 2)",
                rusqlite::params![
                    r#"{"plan_type":"plus","has_credits":false,"observed_at":"2026-09-13T00:00:00Z"}"#
                ],
            )
            .unwrap();
        drop(db);
        let snapshot = codex_quota_snapshot(std::path::Path::new("/missing-rollouts"))
            .expect("SQL snapshot must be readable without raw rollout files");
        assert_eq!(snapshot["plan_type"], "plus");
        assert_eq!(snapshot["has_credits"], false);
    });
}

/// Phase 2.8：`data harness-bill set` 录入的行进 `by_provider` 的 basis 桶。
/// 找不到条目就新建（WorkBuddy 从不产 usage_fact），有就叠加；跨币不相加。
#[test]
fn apply_harness_bills_folds_user_entered_rows_into_by_provider() {
    with_home(|| {
        let db = seed_authority_db();
        db.harness_bill_put(
            "wb:wb:2026-09:harness_billed:",
            "workbuddy",
            "workbuddy",
            "2026-09",
            "harness_billed",
            21_500,
            "CNY",
            "credit_json",
            1,
        )
        .unwrap();
        // 另一档进已存在的 provider 条目（叠加，不覆盖）。
        db.harness_bill_put(
            "wb:wb:2026-09:fixed_subscription:",
            "workbuddy",
            "workbuddy",
            "2026-09",
            "fixed_subscription",
            5_000,
            "CNY",
            "",
            1,
        )
        .unwrap();

        let mut by_provider: BTreeMap<String, HarnessAmount> = BTreeMap::new();
        apply_harness_bills(&mut by_provider, &db, "2026-09");

        let e = by_provider.get("workbuddy/workbuddy").expect("新建条目");
        assert_eq!(e.currency.as_deref(), Some("CNY"));
        assert!(!e.has_unresolved);
        assert_eq!(
            e.amounts_by_basis
                .get(&agent_vitals_domain::data_contract::BillingBasis::HarnessBilled),
            Some(&215.0)
        );
        assert_eq!(
            e.amounts_by_basis
                .get(&agent_vitals_domain::data_contract::BillingBasis::FixedSubscription),
            Some(&50.0)
        );

        // 别的月份不串。
        let mut other: BTreeMap<String, HarnessAmount> = BTreeMap::new();
        apply_harness_bills(&mut other, &db, "2026-08");
        assert!(other.is_empty());
    });
}

/// 2026-09-16 真机缺口：用户在「明确计费方式」里填的订阅月费在**任何一个数字上**
/// 都不出现——`apply_subscription_fees` 只枚举价目表 `catalog_2026_09.subscriptions`，
/// 内置价目表没有这一节、设置页也只能写价卡与归属。这条链把声明的月费接进
/// `by_provider` 的 `FixedSubscription` 档，也就是概况「订阅月费」那一行。
#[test]
fn declared_subscription_fees_reach_by_provider_and_stop_on_revoke() {
    with_home(|| {
        let db = seed_authority_db();
        db.billing_declaration_revision_save(
            "rev-pro",
            "decl-pro",
            None,
            "anthropic",
            "official_subscription",
            Some("Claude Pro"),
            Some(2_000),
            Some("USD"),
            "2025-07-20",
            None,
            None,
            None,
            &[],
            1,
        )
        .unwrap();

        let declared = declared_subscription_fees(&db, "2026-09");
        assert_eq!(declared.len(), 1);
        assert_eq!(declared[0].amount, 20.0, "2000 minor = 20.00");
        assert_eq!(declared[0].start_month, "2025-07");

        let mut by_provider: BTreeMap<String, HarnessAmount> = BTreeMap::new();
        apply_declared_subscription_fees(&mut by_provider, "2026-09", &declared);
        let entry = by_provider.get("claude-code/anthropic").expect("月费条目");
        assert_eq!(
            entry.amounts_by_basis.get(&BillingBasis::FixedSubscription),
            Some(&20.0)
        );
        assert_eq!(entry.currency.as_deref(), Some("USD"));

        // 账期：订阅生效前的月份不摊（不得凭空造出订阅前的支出）。
        let mut earlier: BTreeMap<String, HarnessAmount> = BTreeMap::new();
        apply_declared_subscription_fees(&mut earlier, "2025-06", &declared);
        assert!(earlier.is_empty(), "订阅生效前不得摊月费");

        // 撤销：软删当前态行 → 月费立即消失（不需要第二条撤销路径）。
        assert!(db
            .billing_declaration_revision_revoke("rev-pro-revoke", "decl-pro", "rev-pro", 2)
            .unwrap());
        assert!(
            declared_subscription_fees(&db, "2026-09").is_empty(),
            "撤销后不得再摊月费"
        );
    });
}

/// 三条「不该摊」：金额未声明（弹窗允许勾「金额暂不清楚」）、非订阅关系
/// （组织承担只记录关系、不改金额，§3 事实 1）、以及订阅已到期。
#[test]
fn declared_subscription_fees_skip_incomplete_other_kind_and_ended_rows() {
    with_home(|| {
        let db = seed_authority_db();
        db.billing_declaration_revision_save(
            "rev-nomoney",
            "decl-nomoney",
            None,
            "anthropic",
            "official_subscription",
            None,
            None,
            None,
            "2025-07-20",
            None,
            None,
            None,
            &[],
            1,
        )
        .unwrap();
        db.billing_declaration_revision_save(
            "rev-org",
            "decl-org",
            None,
            "openai",
            "organization",
            None,
            Some(9_900),
            Some("CNY"),
            "2025-01-01",
            None,
            None,
            None,
            &[],
            1,
        )
        .unwrap();
        db.billing_declaration_revision_save(
            "rev-ended",
            "decl-ended",
            None,
            "openai",
            "official_subscription",
            None,
            Some(2_000),
            Some("USD"),
            "2025-01-10",
            Some("2026-03-05"),
            None,
            None,
            &[],
            1,
        )
        .unwrap();

        // 月费按**查询月**解析：这条到期声明在 2026-02 仍适用、2026-09 已不适用。
        let declared = declared_subscription_fees(&db, "2026-02");
        assert_eq!(declared.len(), 1, "只有 ended 那条是 2026-02 的合格订阅月费");
        assert_eq!(declared[0].provider, "openai");
        assert_eq!(declared[0].end_month.as_deref(), Some("2026-03"));
        assert!(
            declared_subscription_fees(&db, "2026-09").is_empty(),
            "到期后的月份不再产出月费"
        );

        let mut in_range: BTreeMap<String, HarnessAmount> = BTreeMap::new();
        apply_declared_subscription_fees(&mut in_range, "2026-02", &declared);
        assert!(in_range.contains_key("codex/openai"), "结束月之前照常摊");

        let mut after_end: BTreeMap<String, HarnessAmount> = BTreeMap::new();
        apply_declared_subscription_fees(&mut after_end, "2026-04", &declared);
        assert!(after_end.is_empty(), "到期后继续收月费是编造");
    });
}

/// **双计守卫**：待确认组按模型组切，同一订阅常被分两次声明（M3 一组、M2.7 一组），
/// 两条声明各带 ¥44——不去重就是 ¥88/月。一个 harness+provider 只摊一次，留最早生效的。
#[test]
fn duplicate_provider_subscription_declarations_charge_one_fee() {
    with_home(|| {
        let db = seed_authority_db();
        for (rev, decl, model, ts) in [
            ("rev-dup-a", "decl-dup-a", "MiniMax-M3", 1),
            ("rev-dup-b", "decl-dup-b", "MiniMax-M2.7", 2),
        ] {
            db.billing_declaration_revision_save(
                rev, decl, None,"minimax", "official_subscription",
                Some("MiniMax"), Some(4_400), Some("CNY"), "2026-06-01", None, None, None,
                &[("model", model)], ts,
            ).unwrap();
        }
        let declared = declared_subscription_fees(&db, "2026-09");
        assert_eq!(declared.len(), 1, "同一 harness+provider 的两条订阅声明只摊一次");
        let mut by_provider: BTreeMap<String, HarnessAmount> = BTreeMap::new();
        apply_declared_subscription_fees(&mut by_provider, "2026-09", &declared);
        let entry = by_provider.get("claude-code/minimax").expect("月费条目");
        assert_eq!(
            entry.amounts_by_basis.get(&BillingBasis::FixedSubscription),
            Some(&44.0),
            "44 元一份，不是两份 88",
        );
    });
}

/// 去重的占坑必须放在合格性检查**之后**：「金额暂不清楚」的声明（无金额）若先占坑，
/// 会把后来带真实金额的同服务商声明挡掉——月费凭空消失（比双计更糟，因为无声）。
#[test]
fn amountless_declaration_does_not_block_a_later_priced_one() {
    with_home(|| {
        let db = seed_authority_db();
        // 先声明的一条没填金额（弹窗允许勾「金额暂不清楚」）。
        db.billing_declaration_revision_save(
            "rev-noamt", "decl-noamt", None,"minimax",
            "official_subscription", Some("MiniMax"), None, None,
            "2026-05-01", None, None, None, &[("model", "MiniMax-M3")], 1,
        ).unwrap();
        // 后声明的同服务商一条带了真实金额。
        db.billing_declaration_revision_save(
            "rev-priced", "decl-priced", None,"minimax",
            "official_subscription", Some("MiniMax"), Some(4_400), Some("CNY"),
            "2026-06-01", None, None, None, &[("model", "MiniMax-M2.7")], 2,
        ).unwrap();
        let declared = declared_subscription_fees(&db, "2026-09");
        assert_eq!(declared.len(), 1, "无金额的声明不占坑");
        assert_eq!(declared[0].amount, 44.0, "带金额的那条生效");
    });
}

/// **改价不追溯**（§3.4）：10 月把 ¥44 改成 ¥49，7–9 月仍按 ¥44 摊——修订链按月取价，
/// 后续修订只从**声明那个月**起改价；首修订允许回溯（订阅费自始就在付）。
#[test]
fn price_amendment_prices_from_the_amended_month_not_retroactively() {
    with_home(|| {
        let june = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-06").unwrap().0;
        let october = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-10").unwrap().0;
        let db = seed_authority_db();
        db.billing_declaration_revision_save(
            "rev-p1", "decl-price", None,"minimax",
            "official_subscription", Some("MiniMax"), Some(4_400), Some("CNY"),
            "2026-06-01", None, None, None, &[], june + 1,
        ).unwrap();
        db.billing_declaration_revision_save(
            "rev-p2", "decl-price", Some("rev-p1"),"minimax",
            "official_subscription", Some("MiniMax"), Some(4_900), Some("CNY"),
            // 修订的适用范围**沿用原起点**（覆盖不断档）；新价格从声明月起。
            "2026-06-01", None, None, None, &[], october + 86_400_000,
        ).unwrap();

        let sep = declared_subscription_fees(&db, "2026-09");
        assert_eq!(sep.len(), 1);
        assert_eq!(sep[0].amount, 44.0, "9 月仍是旧价：改价不重写历史");
        let oct = declared_subscription_fees(&db, "2026-10");
        assert_eq!(oct[0].amount, 49.0, "10 月起按新价");
        assert!(declared_subscription_fees(&db, "2026-05").is_empty(), "订阅前不摊");
    });
}

/// **退订＝带结束日的修订**（§3.4）：过去的月照摊（那些月真付过钱），到期后停。
/// 区别于撤销（写错了 → 全链作废，任何月份都不摊）。
#[test]
fn end_date_amendment_keeps_history_and_stops_after_end() {
    with_home(|| {
        let june = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-06").unwrap().0;
        let november = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-11").unwrap().0;
        let db = seed_authority_db();
        db.billing_declaration_revision_save(
            "rev-e1", "decl-end", None,"minimax",
            "official_subscription", Some("MiniMax"), Some(4_400), Some("CNY"),
            "2026-06-01", None, None, None, &[], june + 1,
        ).unwrap();
        db.billing_declaration_revision_save(
            "rev-e2", "decl-end", Some("rev-e1"),"minimax",
            "official_subscription", Some("MiniMax"), Some(4_400), Some("CNY"),
            "2026-06-01", Some("2026-11-20"), None, None, &[], november + 86_400_000,
        ).unwrap();

        assert_eq!(declared_subscription_fees(&db, "2026-09")[0].amount, 44.0, "退订前的月照摊");
        assert_eq!(declared_subscription_fees(&db, "2026-11")[0].amount, 44.0, "结束月当月仍摊");
        assert!(declared_subscription_fees(&db, "2026-12").is_empty(), "到期后停");
    });
}

/// **接线**测试（不只是函数）：声明的月费必须出现在 `monthly_summary` 的 DTO 上，
/// 因为概况「订阅月费」那一行读的就是它。函数单测只能证明算法对，证明不了它被
/// 调用——2026-09-16 的真机缺口正是「算法不存在」，只钉函数会漏掉这一类。
#[test]
fn monthly_summary_spreads_a_declared_subscription_fee_into_the_dto() {
    with_home(|| {
        let db = seed_authority_db();
        db.billing_declaration_revision_save(
            "rev-dto",
            "decl-dto",
            None,
            "anthropic",
            "official_subscription",
            Some("Claude Pro"),
            Some(2_000),
            Some("USD"),
            "2025-07-20",
            None,
            None,
            None,
            &[],
            1,
        )
        .unwrap();
        drop(db);
        let summary = SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery {
            month: "2026-09".to_string(),
        });
        let entry = summary
            .by_provider
            .get("claude-code/anthropic")
            .expect("月费条目");
        assert_eq!(
            entry.amounts_by_basis.get(&BillingBasis::FixedSubscription),
            Some(&20.0)
        );
        assert_eq!(
            summary.total_actual_spend().get("USD"),
            Some(&20.0),
            "实际支出的 USD 桶必须含这笔月费"
        );
    });
}

#[test]
fn apply_harness_bills_never_labels_mixed_cny_usd_as_single_currency() {
    with_home(|| {
        let db = seed_authority_db();
        db.harness_bill_put(
            "mixed:2026-09:harness_billed",
            "workbuddy",
            "gateway",
            "2026-09",
            "harness_billed",
            21_500,
            "CNY",
            "credit_json",
            1,
        )
        .unwrap();
        db.harness_bill_put(
            "mixed:2026-09:fixed_subscription",
            "workbuddy",
            "gateway",
            "2026-09",
            "fixed_subscription",
            2_000,
            "USD",
            "invoice",
            1,
        )
        .unwrap();
        // A later CNY row must not re-claim CNY after the conflict.
        db.harness_bill_put(
            "mixed:2026-09:api_equivalent",
            "workbuddy",
            "gateway",
            "2026-09",
            "api_equivalent",
            5_000,
            "CNY",
            "estimate",
            1,
        )
        .unwrap();

        let mut by_provider = BTreeMap::new();
        apply_harness_bills(&mut by_provider, &db, "2026-09");

        let e = by_provider.get("workbuddy/gateway").expect("provider entry");
        assert_eq!(e.currency, None);
        assert!(e.has_unresolved);
        assert!(e.amounts_by_basis.is_empty(), "mixed money must not be summed");
    });
}

/// 2026-09-07 审查收口（模型级合并）：同日「A 有实时行 + B 只有 legacy
/// 聚合」时，整日替换会把 B 无标记丢掉——按 (日, 模型) 选源（实时赢、
/// 异模型互补）才是既不双计也不漏的结构。
#[test]
fn merged_claude_days_keeps_legacy_models_missing_from_realtime() {
    with_home(|| {
        let db = seed_authority_db();
        let (start, end) =
            agent_vitals_data::authority_query::beijing_day_bounds_ms("2026-08-11").unwrap();
        // legacy 聚合：A=100、B=200（event_peak=0 的 base 行）。
        seed_fact(
            &db,
            "lg-a",
            "claude-code",
            Some("model-a"),
            "legacy_aggregate",
            start + 1_000,
            0,
            100,
            0,
            0,
            0,
        );
        seed_fact(
            &db,
            "lg-b",
            "claude-code",
            Some("model-b"),
            "legacy_aggregate",
            start + 2_000,
            0,
            200,
            0,
            0,
            0,
        );
        // 实时行只覆盖 A（B 的会话文件已轮转的场景）。
        seed_fact(
            &db,
            "rt-a",
            "claude-code",
            Some("model-a"),
            "assistant-usage",
            start + 3_000,
            0,
            50,
            0,
            0,
            0,
        );
        let merged = merged_claude_days(db.conn(), start, end);
        drop(db);
        let day = &merged["2026-08-11"];
        assert_eq!(
            day["model-a"]["input_tokens"],
            json!(50),
            "同模型实时行赢，不与 legacy 相加"
        );
        assert_eq!(
            day["model-b"]["input_tokens"],
            json!(200),
            "实时缺席的模型保留 legacy 聚合，不随整日被丢弃"
        );
    });
}

/// 2026-09-07 审查收口（标记消费方）：legacy 兜底月份的 claude 条目
/// freshness 必须降为 Partial——降级标记此前只写不读，spec §6.2.3
/// 「查询方据此降级」没有消费方，聚合兜底的月份照常渲染 Fresh。
#[test]
fn legacy_backed_month_degrades_claude_freshness_to_partial() {
    with_home(|| {
        let month = crate::clock::current_month_beijing();
        let day = crate::clock::today_beijing();
        let db = seed_authority_db();
        let (start, _) =
            agent_vitals_data::authority_query::beijing_day_bounds_ms(&day).unwrap();
        seed_fact(
            &db,
            "rt-a",
            "claude-code",
            Some("claude-opus-5"),
            "assistant-usage",
            start + 1_000,
            0,
            10,
            0,
            0,
            1,
        );
        db.conn()
            .execute(
                "INSERT INTO data_quality_issues(issue_id, scope_type, scope_key, code,
                     severity, first_seen_at_ms, last_seen_at_ms, detail_json)
                 VALUES ('legacy_aggregate:x', 'month', ?1, 'legacy_aggregate',
                         'info', 1, 1, '{}')",
                rusqlite::params![month],
            )
            .unwrap();
        drop(db);
        let repo = SqlSummaryRepository::new();
        let summary = repo.monthly_summary(&MonthlySummaryQuery {
            month: month.clone(),
        });
        let claude = &summary.by_harness["claude-code"];
        assert_eq!(
            claude.freshness.state,
            FreshnessState::Partial,
            "被 legacy 标记覆盖的月份 claude 侧不得渲染 Fresh"
        );
        assert!(
            claude.freshness.last_observed_at.is_some(),
            "Partial 保留 last_observed_at（观测过，只是部分是聚合兜底）"
        );
        // 其他执行环境不受 claude 的标记影响。
        assert_eq!(
            summary.by_harness["codex"].freshness.state,
            FreshnessState::Unavailable
        );
    });
}

#[test]
fn sql_repository_reports_unavailable_with_no_facts() {
    with_home(|| {
        let repo = SqlSummaryRepository::new();
        let summary = repo.monthly_summary(&MonthlySummaryQuery {
            month: "2020-01".to_string(),
        });
        assert!(
            summary.contract_violations().is_empty(),
            "{:?}",
            summary.contract_violations()
        );
        for harness in WIRED_HARNESSES {
            assert_eq!(
                summary.by_harness[*harness].freshness.state,
                FreshnessState::Unavailable,
                "harness={harness}"
            );
            assert!(
                summary.by_harness[*harness].amounts_by_basis.is_empty(),
                "harness={harness}"
            );
        }
        assert!(!summary.excluded_harnesses.contains("dsh"));
        // E4b：workbuddy 不再 excluded——它有 token 数据面（金额仍 unresolved）。
        assert!(!summary.excluded_harnesses.contains("workbuddy"));
        assert!(summary.excluded_harnesses.is_empty());
        assert_eq!(summary.coverage.measured_fields, 4);

        let daily = repo.daily_summary(&DailySummaryQuery {
            date: "2020-01-01".to_string(),
        });
        assert!(
            daily.contract_violations().is_empty(),
            "{:?}",
            daily.contract_violations()
        );
        assert_eq!(
            daily.by_harness["dsh"].freshness.state,
            FreshnessState::Unavailable
        );
    });
}

#[test]
fn sql_repository_rejects_a_malformed_window_without_a_guess() {
    with_home(|| {
        let repo = SqlSummaryRepository::new();
        // 格式非法（不是 YYYY-MM/YYYY-MM-DD）不能编数字——`beijing_month_
        // bounds_ms`/`beijing_day_bounds_ms` 返回 None，退化路径与"这个
        // 窗口没有任何事实"完全一样：诚实的 Unavailable，不是 panic。
        let summary = repo.monthly_summary(&MonthlySummaryQuery {
            month: "2026-9".to_string(),
        });
        assert_eq!(
            summary.by_harness["dsh"].freshness.state,
            FreshnessState::Unavailable
        );
        let daily = repo.daily_summary(&DailySummaryQuery {
            date: "not-a-date".to_string(),
        });
        assert_eq!(
            daily.by_harness["dsh"].freshness.state,
            FreshnessState::Unavailable
        );
    });
}

/// codex 侧：真实事实只带 `model_raw`、无 speed 维度——`codex_by_hour_
/// model` 恒填 "standard"（真机也从未观测到别的值，见模块头 `_note`）。
/// 缺少用户计费声明时按量估算并保持 unresolved。
#[test]
fn sql_repository_codex_day_reports_unconfirmed_metered_estimate() {
    with_home(|| {
        let day = crate::clock::today_beijing();
        let (start_ms, _) =
            agent_vitals_data::authority_query::beijing_day_bounds_ms(&day).unwrap();
        let db = seed_authority_db();
        seed_fact(
            &db,
            "f1",
            "codex",
            Some("gpt-5.6-sol"),
            "token_count",
            start_ms + 3_600_000,
            0,
            800_000,
            200_000,
            50_000,
            80_000,
        );
        drop(db);

        let sql_daily =
            SqlSummaryRepository::new().daily_summary(&DailySummaryQuery { date: day });
        assert!(
            sql_daily.contract_violations().is_empty(),
            "{:?}",
            sql_daily.contract_violations()
        );
        let codex = &sql_daily.by_harness["codex"];
        assert!(codex.has_unresolved, "missing provider evidence must not be priced as OpenAI: {codex:?}");
        assert!(sql_daily.tokens_by_harness["codex"].total > 0);
    });
}

// ─────────── v0.9.1 Q13：价格历史重放（spec §5.3） ───────────

/// 库里没有任何快照（或时点为 None）→ [`PricingCards::asof`] 退回当前嵌
/// 入卡，逐字节相同。这是「二进制-only 安装从没 sync 过」和「查询早于第
/// 一次 sync」的常态，绝不能因为拿不到快照就报错或算零。
#[test]
fn pricing_cards_asof_falls_back_to_current_when_no_snapshot() {
    with_home(|| {
        let cur = PricingCards::current();
        assert_eq!(PricingCards::asof(&None, Some(1)).main, cur.main);
        assert_eq!(PricingCards::asof(&None, None).main, cur.main);

        let db = seed_authority_db();
        // 快照表为空 → asof 任何时点都退当前卡。
        let got = PricingCards::asof(&Some(db), Some(crate::clock::now_ms()));
        assert_eq!(got.main, cur.main);
        assert_eq!(got.codex, cur.codex);
    });
}

/// 调价后查历史月：`monthly_summary` 必须用**当时的**价卡，不拿今天的卡
/// 重算历史。构造两份快照（早=便宜、近=当前），断言 2 个月前的 DSH 金额
/// 按便宜卡折算。
#[test]
fn monthly_summary_replays_historical_pricing_snapshot() {
    with_home(|| {
        let past = "2026-07"; // 早于当前月（2026-09）
        let (p_start, p_end) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(past).unwrap();
        let db = seed_authority_db();
        // 1M uncached、全 off-peak（event_peak=0）、deepseek-v4-flash。
        seed_fact(
            &db,
            "j1",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            p_start + 12 * 3_600_000,
            0,
            1_000_000,
            0,
            0,
            0,
        );

        // 早快照：uncached off_peak 砍到 0.5（当前卡是 1.5）。captured 在
        // 7 月开始之前 → asof(7 月末) 命中它。
        let mut cheap = agent_vitals_domain::cost::load_pricing();
        cheap["providers"]["deepseek-official"]["models"]["deepseek-v4-flash"]
            ["input_uncached"]["off_peak"] = json!(0.5);
        let snap_old = json!({
            "pricing": cheap,
            "codex_pricing": crate::sessions::codex_cost::load_codex_pricing(),
        })
        .to_string();
        db.pricing_snapshot_put("v-old", "test", &snap_old, p_start - 1_000)
            .unwrap();
        // 近快照 = 当前卡，captured 在「现在」→ 只对当前/未来月生效。
        let snap_now = json!({
            "pricing": agent_vitals_domain::cost::load_pricing(),
            "codex_pricing": crate::sessions::codex_cost::load_codex_pricing(),
        })
        .to_string();
        db.pricing_snapshot_put("v-now", "test", &snap_now, crate::clock::now_ms())
            .unwrap();
        drop(db);

        let s = SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery {
            month: past.to_string(),
        });
        let dsh = &s.by_harness["dsh"];
        let metered = dsh
            .amounts_by_basis
            .get(&BillingBasis::MeteredActual)
            .copied()
            .expect("DSH 按量档");
        // 便宜卡：1.0M * 0.5/M ≈ ¥0.5；当前卡会是 ¥1.5。
        assert!(
            (metered - 0.5).abs() < 0.02,
            "历史月按便宜快照计价，得 {metered}（当前卡会是 ~1.5）"
        );
        let _ = p_end;
    });
}

/// Q13 的对账不变式：`calendar_month`（按日轴）与 `monthly_summary`
/// （按执行环境轴）对同一个历史月、在价格重放下，DSH 月度金额仍必须相等
/// （`usage.rs` 的 `token_by_date_model` 纪律——两条轴一份能力）。
#[test]
fn calendar_and_monthly_agree_on_dsh_under_pricing_replay() {
    with_home(|| {
        let past = "2026-06";
        let (p_start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(past).unwrap();
        let db = seed_authority_db();
        seed_fact(
            &db,
            "a",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            p_start + 5 * 86_400_000 + 3_600_000,
            0,
            600_000,
            0,
            0,
            40_000,
        );
        seed_fact(
            &db,
            "b",
            "dsh",
            Some("deepseek-v4-flash"),
            "turn",
            p_start + 18 * 86_400_000 + 3_600_000,
            0,
            400_000,
            0,
            0,
            20_000,
        );
        let mut cheap = agent_vitals_domain::cost::load_pricing();
        cheap["providers"]["deepseek-official"]["models"]["deepseek-v4-flash"]
            ["input_uncached"]["off_peak"] = json!(0.4);
        cheap["providers"]["deepseek-official"]["models"]["deepseek-v4-flash"]["output"]
            ["off_peak"] = json!(1.2);
        let snap = json!({
            "pricing": cheap,
            "codex_pricing": crate::sessions::codex_cost::load_codex_pricing(),
        })
        .to_string();
        db.pricing_snapshot_put("v-old", "test", &snap, p_start - 1_000)
            .unwrap();
        drop(db);

        let monthly = SqlSummaryRepository::new().monthly_summary(&MonthlySummaryQuery {
            month: past.to_string(),
        });
        let monthly_dsh = monthly.by_harness["dsh"]
            .amounts_by_basis
            .get(&BillingBasis::MeteredActual)
            .copied()
            .expect("DSH 按量档");

        let cal = calendar_month(past);
        let cal_dsh: f64 = cal["days"]
            .as_object()
            .unwrap()
            .values()
            .map(|d| d["dsh_cost_cny"].as_f64().unwrap_or(0.0))
            .sum();

        assert!(
            (monthly_dsh - cal_dsh).abs() < 0.01,
            "日轴合计 {cal_dsh} 必须 == 执行环境轴 {monthly_dsh}（重放下也不例外）"
        );
        // 且确实用了便宜卡：1.0M*0.4 + 60K*1.2 = 0.4 + 0.072 = 0.472。
        assert!(monthly_dsh < 1.0, "便宜快照生效，得 {monthly_dsh}");
    });
}

/// RUNTIME_INVALIDATION spec 验收 9.10-9.12：`monthly_summary` / `daily_summary` /
/// `hourly_distribution` 各自经 memo——同版本命中、不同参数各自 miss、revision
/// 前进后 miss 并拿到新结果。三个入口共用一个临时库和一套 seed 逻辑。
#[test]
fn monthly_daily_hourly_summaries_are_memoized_by_version_and_params() {
    use crate::query::read_memo::ReadMemo;
    use agent_vitals_data::repository::{DailySummaryQuery, MonthlySummaryQuery};
    let dir = std::env::temp_dir().join(format!(
        "avr-mdh-memo-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(dir.join("state")).unwrap();
    let path = agent_vitals_data::authority::default_authority_path(&dir);
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap();
    let month = "2026-09";
    let date = "2026-09-10";
    let (start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms(month).unwrap();
    db.with_immediate_txn(|c| {
        c.execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING", [])?;
        c.execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                 event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                 output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f1', 'dsh', 'm', 'sess', 'f1', 'assistant-usage', NULL, 'deepseek-chat',
                 ?1, 1, 10, 0, 0, 5, 'run', 1, 1)",
            rusqlite::params![start + 3_600_000],
        )?;
        Ok(())
    }).unwrap();
    drop(db);

    let repo = SqlSummaryRepository::at(&dir);
    let memo = ReadMemo::with_capacity(8);

    // monthly_summary
    let m1 = repo.monthly_summary_json_memoized(&MonthlySummaryQuery { month: month.into() }, &memo);
    let m2 = repo.monthly_summary_json_memoized(&MonthlySummaryQuery { month: month.into() }, &memo);
    assert!(std::sync::Arc::ptr_eq(&m1, &m2), "same month, same version: hit");
    let m_other = repo.monthly_summary_json_memoized(&MonthlySummaryQuery { month: "2026-08".into() }, &memo);
    assert!(!std::sync::Arc::ptr_eq(&m1, &m_other), "different month: independent entry");

    // daily_summary
    let d1 = repo.daily_summary_json_memoized(&DailySummaryQuery { date: date.into() }, &memo);
    let d2 = repo.daily_summary_json_memoized(&DailySummaryQuery { date: date.into() }, &memo);
    assert!(std::sync::Arc::ptr_eq(&d1, &d2), "same date, same version: hit");
    let d_other = repo.daily_summary_json_memoized(&DailySummaryQuery { date: "2026-09-11".into() }, &memo);
    assert!(!std::sync::Arc::ptr_eq(&d1, &d_other), "different date: independent entry");

    // hourly_distribution
    let h1 = hourly_distribution_memoized(date, &repo, &memo);
    let h2 = hourly_distribution_memoized(date, &repo, &memo);
    assert!(std::sync::Arc::ptr_eq(&h1, &h2), "same date, same version: hit");
    let h_other = hourly_distribution_memoized("2026-09-11", &repo, &memo);
    assert!(!std::sync::Arc::ptr_eq(&h1, &h_other), "different date: independent entry");

    let d1_snapshot = (*d1).clone();
    let misses_before = memo.stats().misses;

    // revision 前进 → 三个入口各自 miss，旧 Arc 不变。
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, 2).unwrap();
    db.with_immediate_txn(|c| {
        c.execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                 source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                 event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                 output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f2', 'dsh', 'm', 'sess', 'f2', 'assistant-usage', NULL, 'deepseek-chat',
                 ?1, 1, 10, 0, 0, 7, 'run', 1, 1)",
            rusqlite::params![start + 7_200_000],
        )?;
        Ok(())
    }).unwrap();
    drop(db);

    let m3 = repo.monthly_summary_json_memoized(&MonthlySummaryQuery { month: month.into() }, &memo);
    let d3 = repo.daily_summary_json_memoized(&DailySummaryQuery { date: date.into() }, &memo);
    let h3 = hourly_distribution_memoized(date, &repo, &memo);
    assert!(!std::sync::Arc::ptr_eq(&m1, &m3));
    assert!(!std::sync::Arc::ptr_eq(&d1, &d3));
    assert!(!std::sync::Arc::ptr_eq(&h1, &h3));
    assert_eq!(memo.stats().misses, misses_before + 3);
    // held Arcs 不被就地修改：d1 的内容与「第二次写入前」的快照逐字节相等。
    assert_eq!(*d1, d1_snapshot, "the Arc held from before the write must not mutate");

    let _ = std::fs::remove_dir_all(&dir);
}


/// RUNTIME_INVALIDATION spec 验收 9.14：`open_db_ro`（经 `open_db`）在库缺席时
/// 返回 `None` 且**不建库文件**——与 v0.9.1「权威库不自愈」同纪律；旧的
/// `AuthorityDb::open`（读写）会在这种情况下悄悄建一个空库，这正是要避免的。
#[test]
fn open_db_ro_returns_none_without_creating_the_file() {
    let dir = std::env::temp_dir().join(format!(
        "avr-open-ro-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let repo = SqlSummaryRepository::at(&dir);
    assert!(repo.open_db_ro().is_none());
    let path = agent_vitals_data::authority::default_authority_path(&dir);
    assert!(!path.exists(), "a read must never create the authority database");
    let _ = std::fs::remove_dir_all(&dir);
}
