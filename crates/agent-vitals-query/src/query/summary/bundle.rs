//! overview/calendar/hourly 投影（桌面托盘与 IPC 面）。

use super::*;

pub fn hourly_distribution(date: &str) -> serde_json::Value {
    let repo = SqlSummaryRepository::new();
    let value = hourly_distribution_memoized(date, &repo, crate::query::read_memo::ReadMemo::global());
    serde_json::Value::clone(&value)
}

/// `hourly_distribution` 的 memo 接线（同 `calendar_month_memoized` 套路）。
pub fn hourly_distribution_memoized(
    date: &str,
    repo: &SqlSummaryRepository,
    memo: &crate::query::read_memo::ReadMemo,
) -> std::sync::Arc<serde_json::Value> {
    let db = repo.open_db();
    let data_home = repo.data_home_path();
    match crate::query::read_memo::ReadVersion::observe(db.as_ref(), &data_home) {
        Some(version) => memo.get_or_compute(
            "hourly_distribution", &data_home, date, &version,
            || hourly_distribution_with_db(date, &db),
        ),
        None => std::sync::Arc::new(hourly_distribution_with_db(date, &db)),
    }
}

fn hourly_distribution_with_db(
    date: &str,
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
) -> serde_json::Value {
    // v0.9.1 Phase 3.5 Tier B：数据源从「today.json + 旧 facts-index + codex
    // fold 三路拼装」整体切换到 SQL 权威库——行级事实本就都在 `usage_facts`
    // （`authority_query::hourly_by_harness` 三执行环境统一），旧 facts-index 是可
    // 丢弃投影，权威读面没有理由绕它再走一遍 JSONL 重建；today.json/fold
    // 是禁读清单成员（spec §5.2），product 读面在此全部退役。
    let bounds = agent_vitals_data::authority_query::beijing_day_bounds_ms(date);
    let by_harness: std::collections::BTreeMap<String, std::collections::BTreeMap<String, i64>> =
        match (db, bounds) {
            (Some(db), Some((start, end))) => {
                agent_vitals_data::authority_query::hourly_by_harness(db.conn(), start, end)
                    .unwrap_or_default()
            }
            _ => Default::default(),
        };
    // 来源标注如实切换：全部来自权威库的行级事实（legacy_aggregate 不进
    // 小时轴——它是日轴账单不是会话证据）。库打不开 = 全执行环境缺席。
    let source = |harness: &str| -> Option<&str> {
        by_harness
            .get(harness)
            .filter(|m| !m.is_empty())
            .map(|_| "sql-facts")
    };
    let mut hours = Vec::with_capacity(24);
    for hh in 0..24 {
        let key = format!("{hh:02}");
        hours.push(serde_json::json!({
            "hour": hh,
            "dsh_tokens": by_harness.get("dsh").and_then(|m| m.get(&key)).copied(),
            "codex_tokens": by_harness.get("codex").and_then(|m| m.get(&key)).copied(),
            "claude_tokens": by_harness.get("claude-code").and_then(|m| m.get(&key)).copied(),
        }));
    }
    serde_json::json!({
        "date": date,
        "harnesses_available": {
            "dsh": source("dsh"),
            "codex": source("codex"),
            "claude": source("claude-code"),
        },
        "hours": hours,
    })
}

/// Token 日历的逐日跨执行环境数据（v0.9 Stage D——日历此前只画 DSH 日轴，
/// 2026-09 实测：DSH 全零月让 57 亿 token 的 claude/codex 用量在日历上
/// 完全不可见，用户看到一片空白）。
///
/// 每天三执行环境各自计量 + 计价，**钱不跨执行环境不跨币合并**（口径各异：DSH
/// 实测、claude relay 估算、codex 等价标价——格子副行分币并列，主行是
/// 托盘 `read_overview` 的 SQL 权威数据面（Phase 4 §5.2：菜单栏不再直读
/// `state/{today,month,claude-ledger}.json`）。开库一次，返回三份与旧 state
/// JSON **同形**的原始数据，供 Tauri 侧的 core 折叠函数（`today_cost` /
/// `month_cost` / `claude_estimates` / `rollup_by_model`）消费——不重写任何
/// 计价。与 `calendar_month` / `hourly_distribution` 同层同源。
pub struct OverviewBundle {
    /// DSH 今日桶（`month.json` days 单日同形：8 桶 + `by_model`）或 None
    /// （今日无 DSH 用量——不是「花了 0」）。
    pub dsh_today: Option<serde_json::Value>,
    /// DSH 当月逐日 map（`month.json` `days` 同形，SQL 北京月窗已过滤）。
    pub dsh_month_days: serde_json::Value,
    /// Claude 当月逐日账（`claude-ledger.json` `days` 同形：
    /// `{date:{model:{input_tokens,cache_read_input_tokens,
    /// cache_creation_input_tokens,output_tokens}}}`，实时事实优先 +
    /// legacy_aggregate 深历史按模型补缺）。
    pub claude_month_days: serde_json::Value,
}

/// bundle 三段的耗时（P3 观测面；供调用方把 bundle 段纳入「最慢段」点名）。
#[derive(Debug, Default, Clone, Copy)]
pub struct BundleTimings {
    pub open_ms: u128,
    pub dsh_sql_ms: u128,
    pub claude_sql_ms: u128,
}

/// 兼容入口：不带计时的既有形状。
pub fn overview_bundle(data_home: &Path) -> OverviewBundle {
    overview_bundle_timed(data_home).0
}

/// 带段级计时的组装入口（P3，收敛调查 §2.4）。
pub fn overview_bundle_timed(data_home: &Path) -> (OverviewBundle, BundleTimings) {
    let today_key = crate::clock::today_beijing();
    let month = crate::clock::current_month_beijing();
    let t_open = std::time::Instant::now();
    let bounds = agent_vitals_data::authority_query::beijing_month_bounds_ms(&month);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    )
    .ok();
    // P3 子计时（收敛调查 §2.4）：SQL 面隔离实测全部亚百毫秒，2.2s 基线的
    // 构成只能靠段级观测定位——open / dsh SQL / claude SQL 三段。
    let open_elapsed = t_open.elapsed();
    crate::core::logging::log_info(
        "read_overview",
        &format!("bundle open 完成，用时 {open_elapsed:?}"),
    );
    let mut timings = BundleTimings { open_ms: open_elapsed.as_millis(), ..Default::default() };
    let (dsh_days, claude_days) = match (&db, bounds) {
        (Some(db), Some((start, end))) => {
            let conn = db.conn();
            let t_sql = std::time::Instant::now();
            let dsh = agent_vitals_data::authority_query::peaked_days_map(conn, "dsh", start, end)
                .unwrap_or_else(|_| json!({}));
            timings.dsh_sql_ms = t_sql.elapsed().as_millis();
            crate::core::logging::log_info(
                "read_overview",
                &format!("bundle dsh_sql 完成，用时 {:?}", t_sql.elapsed()),
            );
            let t_claude = std::time::Instant::now();
            let claude: serde_json::Map<String, serde_json::Value> =
                merged_claude_days(conn, start, end).into_iter().collect();
            timings.claude_sql_ms = t_claude.elapsed().as_millis();
            crate::core::logging::log_info(
                "read_overview",
                &format!("bundle claude_sql 完成，用时 {:?}", t_claude.elapsed()),
            );
            (dsh, serde_json::Value::Object(claude))
        }
        _ => (json!({}), json!({})),
    };
    let dsh_today = dsh_days.get(&today_key).cloned();
    (
        OverviewBundle {
            dsh_today,
            dsh_month_days: dsh_days,
            claude_month_days: claude_days,
        },
        timings,
    )
}

/// token 总量，token 才是跨执行环境可加的量）。返回 `{"month", "days":
/// {date: {...}}}`，无数据日字段缺省为 0/缺键——调用方以
/// `total_tokens == 0` 判定"这天没有用量"。
pub fn calendar_month(month: &str) -> serde_json::Value {
    let repo = SqlSummaryRepository::new();
    let value = calendar_month_memoized(month, &repo, crate::query::read_memo::ReadMemo::global());
    // 调用方（Tauri command / CLI）要 owned Value 序列化；Arc 只在 memo 内共享。
    // 这一次克隆发生在锁外、每次 invoke 一份——可接受；要零拷贝得让 IPC 层直接
    // 序列化 `Arc<Value>`，留给 ReadGate 接线一并做。
    serde_json::Value::clone(&value)
}

/// `calendar_month` 的 memo 接线（RUNTIME_INVALIDATION spec §5.1）：版本 =
/// 权威 revision + 配置指纹；库缺席不进 memo 直接算。`repo`/`memo` 显式传入是
/// 为了测试能用临时库与私有 memo（进程级单例在并行测试里会互相污染）。
pub fn calendar_month_memoized(
    month: &str,
    repo: &SqlSummaryRepository,
    memo: &crate::query::read_memo::ReadMemo,
) -> std::sync::Arc<serde_json::Value> {
    let db = repo.open_db();
    let data_home = repo.data_home_path();
    match crate::query::read_memo::ReadVersion::observe(db.as_ref(), &data_home) {
        Some(version) => memo.get_or_compute(
            "calendar_month",
            &data_home,
            month,
            &version,
            || calendar_month_with_db(month, &db),
        ),
        None => std::sync::Arc::new(calendar_month_with_db(month, &db)),
    }
}

fn calendar_month_with_db(
    month: &str,
    db: &Option<agent_vitals_data::authority::AuthorityDb>,
) -> serde_json::Value {
    use serde_json::Value;
    let mut days: serde_json::Map<String, Value> = serde_json::Map::new();
    fn day_entry<'a>(days: &'a mut serde_json::Map<String, Value>, date: &str) -> &'a mut Value {
        days.entry(date.to_string()).or_insert_with(|| {
            json!({
                "dsh_tokens": 0, "claude_tokens": 0, "codex_tokens": 0,
                "total_tokens": 0,
                "dsh_cost_cny": 0.0, "claude_cost_cny": 0.0,
                "claude_cost_usd": 0.0, "codex_cost_usd": 0.0,
            })
        })
    }

    // v0.9.1 Phase 3.5 Tier B：三执行环境数据源统一为 SQL 权威库（与
    // SqlSummaryRepository::monthly_summary 同一条 fetch_windowed 管线）——
    // month.json/ledger/fold 全部退出 product 读面（spec §5.2 禁读清单）。
    // 计价函数与旧路径共用同一批核心（priced_day/claude_day_cost/
    // codex_cost_report），格子里的数字只换来源不换算法。
    let bounds = agent_vitals_data::authority_query::beijing_month_bounds_ms(month);
    let (dsh_days, by_hour_model, claude_days_map) = fetch_windowed(db, bounds);

    // Q13：月末时点的历史价卡（`monthly_summary` 用同一时点——两者对同月折出
    // 的总额必须相等，见 `PricingCards` doc）。
    let cards = PricingCards::asof(db, bounds.map(|(_, end)| end));
    let pricing = cards.main.clone();

    // DSH：peaked_days_map（8 键含 peak_* + by_model）逐日 priced_day。
    if let Some(dsh) = dsh_days.as_object() {
        for (date, day) in dsh {
            let tokens = dsh_day_tokens(day).total;
            let cost = agent_vitals_domain::cost::priced_day(day, &pricing)
                .unwrap_or_else(|| agent_vitals_domain::cost::bucket_cost(day, &pricing));
            let e = day_entry(&mut days, date);
            e["dsh_tokens"] = json!(tokens);
            e["dsh_cost_cny"] = json!(cost.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0));
        }
    }

    // Claude：merged_claude_days（实时事实优先、legacy_aggregate 深历史按
    // 模型补缺）逐日 claude_day_cost 分币 + 四桶 token。
    for (date, day) in &claude_days_map {
        let mut tokens = 0i64;
        if let Some(models) = day.as_object() {
            for (_m, b) in models {
                let g = |k: &str| b.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
                tokens += g("input_tokens")
                    + g("cache_read_input_tokens")
                    + g("cache_creation_input_tokens")
                    + g("output_tokens");
            }
        }
        let (cny, usd) = agent_vitals_domain::cost::claude_day_cost(day, &pricing)
            .and_then(|r| {
                let t = r.get("currency_totals")?;
                Some((
                    t.get("CNY").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    t.get("USD").and_then(|v| v.as_f64()).unwrap_or(0.0),
                ))
            })
            .unwrap_or((0.0, 0.0));
        let e = day_entry(&mut days, date);
        e["claude_tokens"] = json!(tokens);
        e["claude_cost_cny"] = json!(cny);
        e["claude_cost_usd"] = json!(usd);
    }

    // Codex：SQL 小时桶按日聚合 token；逐日钱走 codex_cost_report 的 days[]
    // （cost_usd，untimed 剩余按 per_model 并——与旧路径同一函数同一守恒）。
    for (hour, models) in by_hour_model
        .as_object()
        .expect("by_hour_model is an object")
    {
        let date = &hour[..hour.len().min(10)];
        let mut tokens = 0i64;
        if let Some(models) = models.as_object() {
            for (_m, speeds) in models {
                if let Some(speeds) = speeds.as_object() {
                    for (_s, b) in speeds {
                        let g = |k: &str| b.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
                        tokens += g("uncached_input_tokens")
                            + g("cached_input_tokens")
                            + g("cache_write_input_tokens")
                            + g("output_tokens")
                            + g("reasoning_output_tokens");
                    }
                }
            }
        }
        let e = day_entry(&mut days, date);
        e["codex_tokens"] =
            json!(e.get("codex_tokens").and_then(|v| v.as_i64()).unwrap_or(0) + tokens);
    }
    let by_model = agent_vitals_harnesses::codex_usage::codex_by_model_from_hours(&by_hour_model, None);
    if let Some(report) = crate::sessions::codex_cost::codex_cost_report(
        &by_hour_model,
        &by_model,
        &serde_json::Value::Null,
        &serde_json::Value::Null,
        &cards.codex,
        false,
    ) {
        if let Some(report_days) = report.get("days").and_then(|v| v.as_array()) {
            for d in report_days {
                let Some(date) = d.get("date").and_then(|v| v.as_str()) else {
                    continue;
                };
                let cost = d.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let e = day_entry(&mut days, date);
                e["codex_cost_usd"] = json!(cost);
            }
        }
    }

    // 格子里的 token 数换回**全量**（`harness_tokens_by_day_all`）：上面三段的 token 是
    // 顺着金额面的聚合取的（排除订阅覆盖），钱照那样算是对的，token 不是——订阅内的
    // token 同样发生过（与 `tokens_by_harness` / `hourly_distribution` 同一条纪律）。
    if let (Some(db), Some((start, end))) = (db, bounds) {
        for (harness, key) in [("dsh", "dsh_tokens"), ("claude-code", "claude_tokens"), ("codex", "codex_tokens")] {
            let Ok(by_day) = agent_vitals_data::authority_query::harness_tokens_by_day_all(db.conn(), harness, start, end)
            else { continue };
            for (date, b) in by_day {
                let e = day_entry(&mut days, &date);
                e[key] = json!(b[0] + b[1] + b[2] + b[3]);
            }
        }
    }
    // total_tokens 最后统一算（三执行环境都已落位）。
    for (_, e) in days.iter_mut() {
        let g = |k: &str| e.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        e["total_tokens"] = json!(g("dsh_tokens") + g("claude_tokens") + g("codex_tokens"));
    }
    json!({ "month": month, "days": Value::Object(days) })
}

/// `codex-cost` 的 SQL 权威面（Tier B 收尾，spec §5.2）：codex 用量从
/// `authority_query::codex_by_hour_model` 读，不再全量 fold `~/.codex` rollout。
/// 与 `calendar_month` / `hourly_distribution` 同层同源（runtime，直连
/// `AuthorityDb`——`budget.rs::evaluate_alert_from_sql` 也是这个模式），CLI 只
/// 调不自己开库。
///
/// 返回 `(merged, note)`：`merged` 与旧 rollout fold 同形
/// （`{by_hour_model, by_model, unaccounted, plan}`）供 `codex_report_from_merged`
/// 直接消费——全窗一次查，视图过滤仍由 `codex_report_from_merged` 的
/// `filter_key` 做。`note` 非 `None` 时 = 库缺失/打不开，CLI 应打 stderr 提示，
/// 避免把「空报告」当成「codex 没花钱」端出去（二进制-only 安装从没跑过
/// `sync-facts` 时就是这个形态）。
///
/// **SQL 面降级（如实记）**：
/// - `unaccounted` = `[]`——rollout fold 独有的残差哨兵（「未消费但含 token
///   字段名的事件」），`usage_facts` 是已清洗事实、无此概念。
/// - `plan` = `{}`：SQL token 聚合不保留可按历史窗口证明的套餐证据，不能把
///   开发者机器上的 Plus 观察值编造成所有安装的默认身份。真实会话解析出的
///   `plan_type` 仍可透传；缺失时总额按量估算并标记待确认。
pub fn codex_merged_from_sql(data_home: &Path) -> (serde_json::Value, Option<String>) {
    let empty = || {
        json!({
            "by_hour_model": {}, "by_model": {},
            "unaccounted": [], "plan": {},
        })
    };
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    // `!exists` 必须在 open 之前判：`AuthorityDb::open` 对缺文件会**建库**
    // （全 DDL），之后就分不清「从没同步」和「同步了但 codex 无用量」。
    let missing = !path.exists();
    let by_hour_model =
        match agent_vitals_data::authority::AuthorityDb::open(&path, crate::clock::now_ms()) {
            Ok(db) => {
                agent_vitals_data::authority_query::codex_by_hour_model(db.conn(), 0, i64::MAX)
                    .unwrap_or_else(|_| json!({}))
            }
            Err(e) => {
                return (
                    empty(),
                    Some(format!(
                        "authority DB at {} could not be opened ({e}); reporting empty codex cost",
                        path.display()
                    )),
                );
            }
        };
    let note = missing.then(|| {
        format!(
            "authority DB not found at {} — run `agent-vitals sync-facts` to populate it; reporting empty codex cost",
            path.display()
        )
    });
    let by_model = agent_vitals_harnesses::codex_usage::codex_by_model_from_hours(&by_hour_model, None);
    (
        json!({
            "by_hour_model": by_hour_model,
            "by_model": by_model,
            "unaccounted": [],
            "plan": {},
        }),
        note,
    )
}

