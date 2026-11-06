//! `SummaryRepository` 的 daily/monthly 装配（本域的正当核心）。

use super::*;

#[derive(Default)]
/// v0.9.1 Phase 3.1（`AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md`
/// §5.2）：`SummaryRepository` 的 SQL 权威库实现——`usage_facts` 取代
/// month.json/ledger/codex fold 作为读源。**计价规则一个字不改**：DSH 走
/// `dsh_harness_amount`/`dsh_provider_amount`/`dsh_tokens`/`dsh_day_tokens`
/// （无缝复用，它们本就只认 `{total,peak_total}`/`{date:day}` 这两种
/// `Value` 形状，不关心谁产出的），codex/claude 走上面拆出来的
/// `_from_hours`/`_from_days` 核心——三条计价管线
/// 完全同源，唯一的区别是 [`agent_vitals_data::authority_query`] 从
/// `usage_facts` 反查出同形状的输入，而不是解析 JSON 文件/折叠 rollout。
///
/// **权威库打不开（损坏/新版本）时不 panic、也不报错**——`SummaryRepository`
/// 的 trait 签名不带 `Result`（Stage 0 定的形状，Phase 3 沿用），这里退化
/// 成"这个窗口的三个执行环境都没有数据"，与 JSON 路径在 month.json 缺失时的
/// 行为一致（每个执行环境的 `_from_hours`/`_from_days` 核心函数本来就把"空
/// 输入"处理成 Unavailable，不是本结构体重新发明的分支）。真正的损坏诊断
/// 走 `data doctor`/`data status`，不是这条查询路径的职责。
pub struct SqlSummaryRepository {
    /// `None` = 生产路径，库位置来自 `crate::home::data_home()`（进程
    /// `AGENT_VITALS_HOME`）。`Some` = 参数化：Tauri `read_overview_at(dh)`
    /// 组装入口与临时库单测显式指定库根，不受进程 env 影响——ZST 时代
    /// 「组装入口传进来的 dh 被内部忽略、预算卡永远在真机库上跑」是本次
    /// 会话 Tier B 收尾连续 4 次实现失败的根因。
    data_home: Option<std::path::PathBuf>,
}

impl SqlSummaryRepository {
    /// 生产构造：库根 = `crate::home::data_home()`。
    pub fn new() -> Self {
        Self::default()
    }

    /// 参数化构造：显式库根（Tauri 组装入口 / 临时库单测）。
    pub fn at(data_home: impl Into<std::path::PathBuf>) -> Self {
        Self {
            data_home: Some(data_home.into()),
        }
    }

    /// 只读打开（RUNTIME_INVALIDATION spec §5.2）：不跑 DDL、不跑
    /// `repair_issue_timestamp_units`、不取 WAL 写锁；库缺席 / schema 不匹配都
    /// 返回 `None`，**绝不建库**——与「权威库不自愈」（v0.9.1 §维护）同纪律。
    /// `SqlSummaryRepository` 只服务查询面，这是它开库的唯一方式；11 个调用点
    /// （calendar_month / monthly_summary / daily_summary / hourly_distribution /
    /// codex_quota_snapshot / claude_quota_status / unresolved_billing_groups 等）
    /// 全部是读，改这一处即可让它们统一获得只读保护，不必逐点改。
    pub fn open_db_ro(&self) -> Option<agent_vitals_data::authority::AuthorityDb> {
        let data_home = self.data_home_path();
        let path = agent_vitals_data::authority::default_authority_path(&data_home);
        agent_vitals_data::authority::AuthorityDb::open_readonly(&path).ok()
    }

    /// 兼容别名：本 repository 上的 `open_db()` 一律只读（见 [`Self::open_db_ro`]）。
    /// 保留旧名是为了不动 11 个既有调用点的措辞；新代码直接写 `open_db_ro`。
    pub fn open_db(&self) -> Option<agent_vitals_data::authority::AuthorityDb> {
        self.open_db_ro()
    }

    /// 本 repository 的 data_home（参数化优先，否则进程级 `home::data_home()`）。
    pub fn data_home_path(&self) -> std::path::PathBuf {
        self.data_home.clone().unwrap_or_else(crate::home::data_home)
    }
}

impl SqlSummaryRepository {
    /// `monthly_summary` 经 memo（RUNTIME_INVALIDATION spec §5.1，同 `calendar_month_memoized`
    /// 套路）：`day_freshness` / `claude_provider_amounts_from_sql` 都在 `monthly_summary`
    /// 内部调用，没有独立 IPC 入口，因此在这一层缓存就覆盖了它们——不需要各自的 memo。
    pub fn monthly_summary_json_memoized(
        &self,
        query: &MonthlySummaryQuery,
        memo: &crate::query::read_memo::ReadMemo,
    ) -> std::sync::Arc<serde_json::Value> {
        let data_home = self.data_home_path();
        let db = self.open_db();
        match crate::query::read_memo::ReadVersion::observe(db.as_ref(), &data_home) {
            Some(version) => memo.get_or_compute(
                "monthly_summary", &data_home, &query.month, &version,
                || self.monthly_summary(query).to_json(),
            ),
            None => std::sync::Arc::new(self.monthly_summary(query).to_json()),
        }
    }

    /// `daily_summary` 经 memo；`params` = date（唯一影响结果的输入，日期本身即
    /// 规范化字符串）。
    pub fn daily_summary_json_memoized(
        &self,
        query: &DailySummaryQuery,
        memo: &crate::query::read_memo::ReadMemo,
    ) -> std::sync::Arc<serde_json::Value> {
        let data_home = self.data_home_path();
        let db = self.open_db();
        match crate::query::read_memo::ReadVersion::observe(db.as_ref(), &data_home) {
            Some(version) => memo.get_or_compute(
                "daily_summary", &data_home, &query.date, &version,
                || self.daily_summary(query).to_json(),
            ),
            None => std::sync::Arc::new(self.daily_summary(query).to_json()),
        }
    }
}

impl SummaryRepository for SqlSummaryRepository {
    fn monthly_summary(&self, query: &MonthlySummaryQuery) -> MonthlySummary {
        let db = self.open_db();
        let bounds = agent_vitals_data::authority_query::beijing_month_bounds_ms(&query.month);
        let (dsh_days, by_hour_model, claude_days_map) = fetch_windowed(&db, bounds);

        // Q13（spec §5.3）：按查询月的月末时点选历史价卡版本，不拿今天的卡
        // 重算历史。库无第二份快照时 == 当前嵌入卡（no-op）。
        let cards = PricingCards::asof(&db, bounds.map(|(_, end)| end));
        let pricing = cards.main.clone();
        let latest_day = dsh_days
            .as_object()
            .and_then(|m| m.keys().next_back().cloned());
        let dsh_cost = match dsh_days.as_object() {
            Some(m) if !m.is_empty() => {
                Some(agent_vitals_domain::cost::month_cost(&dsh_days, &pricing))
            }
            _ => None,
        };
        let mut by_harness = BTreeMap::new();
        by_harness.insert(
            "dsh".to_string(),
            dsh_harness_amount(dsh_cost.clone(), latest_day.as_deref()),
        );
        let (codex_amount, codex_tk) = codex_harness_amount_provider_safe(
            &db, bounds, &by_hour_model, None, &cards,
        );
        by_harness.insert("codex".to_string(), codex_amount);
        let (claude_amount, claude_tk) =
            claude_harness_amount_with_tokens_from_days(&claude_days_map, &cards);
        by_harness.insert("claude-code".to_string(), claude_amount);
        let (wb_amount, wb_tk) = workbuddy_harness_amount_with_tokens(&db, bounds);
        by_harness.insert("workbuddy".to_string(), wb_amount);
        // legacy 兜底标记的消费方（degrade_claude_freshness_if_legacy_backed）：
        // 被聚合兜底的月份 claude 侧降为 Partial，必须在 aggregate_freshness
        // 之前生效，聚合新鲜度才能反映它。
        if let Some(db) = &db {
            if let Some(claude_entry) = by_harness.get_mut("claude-code") {
                degrade_claude_freshness_if_legacy_backed(db.conn(), &query.month, claude_entry);
            }
        }

        let mut tokens_by_harness = BTreeMap::new();
        tokens_by_harness.insert("dsh".to_string(), dsh_tokens(Some(&dsh_days), &query.month));
        tokens_by_harness.insert("codex".to_string(), codex_tk);
        tokens_by_harness.insert("claude-code".to_string(), claude_tk);
        tokens_by_harness.insert("workbuddy".to_string(), wb_tk);
        restore_full_harness_tokens(&db, bounds, &mut tokens_by_harness);
        // 插件执行环境 tokens（zcode 接入收尾）：处理量可见、金额不入（L0 纪律）。
        for (label, tk) in plugin_tokens_by_harness(&self.data_home_path(), &db, bounds) {
            tokens_by_harness.insert(label, tk);
        }

        let mut by_provider = BTreeMap::new();
        by_provider.insert(
            "dsh/deepseek-official".to_string(),
            dsh_provider_amount(dsh_cost, latest_day.as_deref()),
        );
        by_provider.extend(codex_provider_amounts_from_sql(
            &db, bounds, None, &by_hour_model, &cards,
        ));
        by_provider.extend(claude_provider_amounts_from_sql(&db, bounds, &claude_days_map, &cards));
        // 月费两条来源，**声明优先**：价目表 `catalog_2026_09.subscriptions`（随版本
        // 更新）与用户在「明确计费方式」里声明的订阅（权威库、可撤销）。`declared`
        // 只取一次，两条路径共用同一份，价目表那条据此跳过同 provider 的重复摊。
        let declared = match &db {
            Some(db) => declared_subscription_fees(db, &query.month),
            None => Vec::new(),
        };
        apply_subscription_fees(&mut by_provider, &query.month, &cards, &declared);
        apply_declared_subscription_fees(&mut by_provider, &query.month, &declared);
        // Phase 2.8：用户显式录入的执行环境账单（WorkBuddy 积分 / 中转对账单…）→
        // by_provider 对应条目的 basis 桶（`data harness-bill set`）。
        if let Some(db) = &db {
            apply_harness_bills(&mut by_provider, db, &query.month);
        }

        let freshness = aggregate_freshness(&by_harness);
        let last_observed_at = freshness.last_observed_at.clone();
        MonthlySummary {
            month: query.month.clone(),
            by_harness,
            tokens_by_harness,
            by_provider,
            coverage: agent_vitals_data::projection::CoverageStatus {
                measured_fields: WIRED_HARNESSES.len() as u64,
                total_fields: (WIRED_HARNESSES.len() + NOT_YET_WIRED_HARNESSES.len()) as u64,
                denominator_version: 1,
            },
            freshness,
            excluded_harnesses: excluded_harnesses(),
            last_observed_at,
        }
    }

    fn daily_summary(&self, query: &DailySummaryQuery) -> DailySummary {
        let db = self.open_db();
        let bounds = agent_vitals_data::authority_query::beijing_day_bounds_ms(&query.date);
        let (dsh_days, by_hour_model, claude_days_map) = fetch_windowed(&db, bounds);
        let day_value = dsh_days.get(&query.date).cloned();

        // Q13：按该日的日末时点选历史价卡（月查询用月末——同一 asof 原语）。
        let cards = PricingCards::asof(&db, bounds.map(|(_, end)| end));
        let pricing = cards.main.clone();
        let cost = day_value.as_ref().map(|d| {
            agent_vitals_domain::cost::priced_day(d, &pricing)
                .unwrap_or_else(|| agent_vitals_domain::cost::bucket_cost(d, &pricing))
        });
        let mut by_harness = BTreeMap::new();
        by_harness.insert(
            "dsh".to_string(),
            dsh_harness_amount(
                cost.clone(),
                day_value.as_ref().map(|_| query.date.as_str()),
            ),
        );
        let (codex_amount, codex_tk) = codex_harness_amount_provider_safe(
            &db, bounds, &by_hour_model, Some(&query.date), &cards,
        );
        by_harness.insert("codex".to_string(), codex_amount);
        let (claude_amount, claude_tk) =
            claude_harness_amount_with_tokens_from_days(&claude_days_map, &cards);
        by_harness.insert("claude-code".to_string(), claude_amount);
        let (wb_amount, wb_tk) = workbuddy_harness_amount_with_tokens(&db, bounds);
        by_harness.insert("workbuddy".to_string(), wb_amount);
        // 日粒度的降级标记按「该日所属月」查（标记是 month scope 的）。
        if let Some(db) = &db {
            let month_of_date: String = query.date.chars().take(7).collect();
            if let Some(claude_entry) = by_harness.get_mut("claude-code") {
                degrade_claude_freshness_if_legacy_backed(db.conn(), &month_of_date, claude_entry);
            }
        }

        let mut tokens_by_harness = BTreeMap::new();
        tokens_by_harness.insert(
            "dsh".to_string(),
            day_value.as_ref().map(dsh_day_tokens).unwrap_or_default(),
        );
        tokens_by_harness.insert("codex".to_string(), codex_tk);
        tokens_by_harness.insert("claude-code".to_string(), claude_tk);
        tokens_by_harness.insert("workbuddy".to_string(), wb_tk);
        restore_full_harness_tokens(&db, bounds, &mut tokens_by_harness);
        // 插件执行环境 tokens（zcode 接入收尾）：与 monthly 同款——处理量可见、金额不入。
        for (label, tk) in plugin_tokens_by_harness(&self.data_home_path(), &db, bounds) {
            tokens_by_harness.insert(label, tk);
        }

        let mut by_provider = BTreeMap::new();
        by_provider.insert(
            "dsh/deepseek-official".to_string(),
            dsh_provider_amount(cost, day_value.as_ref().map(|_| query.date.as_str())),
        );
        by_provider.extend(codex_provider_amounts_from_sql(
            &db, bounds, Some(&query.date), &by_hour_model, &cards,
        ));
        by_provider.extend(claude_provider_amounts_from_sql(&db, bounds, &claude_days_map, &cards));

        let freshness = aggregate_freshness(&by_harness);
        let last_observed_at = freshness.last_observed_at.clone();
        DailySummary {
            date: query.date.clone(),
            by_harness,
            tokens_by_harness,
            by_provider,
            coverage: agent_vitals_data::projection::CoverageStatus {
                measured_fields: WIRED_HARNESSES.len() as u64,
                total_fields: (WIRED_HARNESSES.len() + NOT_YET_WIRED_HARNESSES.len()) as u64,
                denominator_version: 1,
            },
            freshness,
            excluded_harnesses: excluded_harnesses(),
            last_observed_at,
        }
    }

    /// SQL 权威实现：逐 wired 执行环境跑 `authority_query::coverage_status`
    /// （三维分母 v1，见该函数 doc）。窗口 = 该月的北京毫秒边界；库打不开
    /// 或窗口非法 → 三维全 0（诚实「测不到覆盖」，不是满覆盖）。
    fn coverage_status(&self, month: &str) -> BTreeMap<String, CoverageStatus> {
        let db = self.open_db();
        let bounds = agent_vitals_data::authority_query::beijing_month_bounds_ms(month);
        let mut out = BTreeMap::new();
        for harness in WIRED_HARNESSES {
            let (measured, total) = match (&db, bounds) {
                (Some(db), Some((start, end))) => {
                    agent_vitals_data::coverage::status(db, harness, start, end)
                        .map(|s| (s.measured_fields, s.total_fields))
                        .unwrap_or((0, 3))
                }
                _ => (0, 3),
            };
            out.insert(
                (*harness).to_string(),
                CoverageStatus {
                    measured_fields: measured,
                    total_fields: total,
                    denominator_version:
                        agent_vitals_data::authority_query::COVERAGE_DENOMINATOR_VERSION,
                },
            );
        }
        out
    }
}

