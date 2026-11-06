//! `summary` 域的目录化拆分（2026-09-23，纯机械移动零语义变化）：本 mod.rs
//! 保留共享原语与对外的完整 re-export——**所有既有调用点（CLI/MCP/sync/
//! export/桌面/q_acceptance）零改动**。子模块按职责分居：
//! - `harness_amounts` — 按执行环境的金额/provider 折叠与 unresolved 下钻（执行环境
//!   知识的住所；未来执行环境注册制的接缝在 `harness_amounts` 内）
//! - `subscriptions` — 订阅费/声明费/harness bills 的计费政策应用
//! - `quotas` — codex/claude 配额快照（产品特性）
//! - `bundle` — overview/calendar/hourly 投影（桌面与 IPC 面）
//! - `repository` — `SummaryRepository` 的 daily/monthly 装配
//! - `tests` — 原内联测试整体迁入（41% 的文件体量）
//!
//! `codex_home()` 迁 `core/home.rs`（路径助手的正当住所）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use agent_vitals_data::projection::{
    BillingBasis, CoverageStatus, DailySummary, Freshness, FreshnessState, HarnessAmount,
    MonthlySummary,
};
use agent_vitals_data::repository::{DailySummaryQuery, MonthlySummaryQuery, SummaryRepository};
use serde_json::json;

use agent_vitals_domain::cost::BillingMode;
use agent_vitals_domain::data_contract::HarnessTokens;

use crate::clock::{today_beijing, yesterday_beijing};

/// Stage 0 的执行环境接线状态：真正读数据的 vs. 还没接的。四执行环境全接完后
/// `NOT_YET_WIRED_HARNESSES` 与 `PERMANENTLY_EXCLUDED_HARNESSES` 都为空——`excluded_harnesses`
/// 是空集（DTO 语义「已知存在但本版本不产出数据」：现在没有这样的执行环境）。
/// 与 `ingest_service::FACT_HARNESSES` 同表（`wired_harnesses_match_fact_harnesses` 钉住）。
const WIRED_HARNESSES: &[&str] = &["claude-code", "codex", "dsh", "workbuddy"];
const NOT_YET_WIRED_HARNESSES: &[&str] = &[];
const PERMANENTLY_EXCLUDED_HARNESSES: &[&str] = &[];

fn excluded_harnesses() -> BTreeSet<String> {
    NOT_YET_WIRED_HARNESSES
        .iter()
        .chain(PERMANENTLY_EXCLUDED_HARNESSES)
        .map(|s| s.to_string())
        .collect()
}

/// v0.9.1 Q13（spec §5.3「价格历史重放」）：一次查询窗口用的价卡组。
///
/// SQL 权威读路径按**查询窗口的时间点**选价卡版本——历史月用当时的卡，不拿
/// 今天的卡重算历史（`authority::pricing_snapshot_asof`）。库里没有 `≤` 该时
/// 点的快照（查询早于第一次 sync）→ 退回当前嵌入卡。**「只有一份快照」时
/// `asof` 恒返回那一份、与 `load_pricing()` 逐字节相同**——所以本接线对当前
/// 真机数据是 no-op，只有真实调价 + 重新 sync 落下第二份快照后才分叉。
///
/// **粒度 = 窗口级**（月查询用月末毫秒、日查询用日末毫秒），不是逐日：
/// `calendar_month` 与 `monthly_summary` 必须对同一个月折出相等的总额
/// （`usage.rs` 的 `token_by_date_model` 对账纪律），两者用不同 asof 粒度会
/// 在调价月破坏这条等式。调价发生在月中时整月按月末卡计价——逐日重放是
/// 独立后续项（plan 已记「非 blocker」）。
pub struct PricingCards {
    /// `assets/pricing.json` 形状（DSH / claude 计价 + 订阅声明 + billing_modes）。
    pub main: serde_json::Value,
    /// `assets/codex_pricing.json` 形状（codex per-model USD 卡）。
    pub codex: serde_json::Value,
}

impl PricingCards {
    /// 当前嵌入价卡。历史查询无快照可依、以及 legacy 读路径全都用这个。
    ///
    /// 用户补的卡（`price_overrides`）在这里盖上去——**读取时合并**，写进快照会
    /// 被下一次价目表更新冲掉。数据根用与 `SqlSummaryRepository::new()` 同一个
    /// 全局解析（测试靠 `with_home` 隔离）。
    pub fn current() -> Self {
        Self {
            main: crate::price_overrides::merged_main(&crate::home::data_home()),
            codex: crate::sessions::codex_cost::load_codex_pricing(),
        }
    }

    /// `at_ms` 时点有效的历史价卡快照；库不可读 / 无更早快照 / 快照形状不认
    /// → [`Self::current`]（绝不拿更晚的版本冒充历史，`pricing_snapshot_asof`
    /// 已保证这点；这里只处理「一份都没有」的回退）。
    pub fn asof(
        db: &Option<agent_vitals_data::authority::AuthorityDb>,
        at_ms: Option<i64>,
    ) -> Self {
        let (Some(db), Some(at)) = (db.as_ref(), at_ms) else {
            return Self::current();
        };
        let Ok(Some(payload)) = db.pricing_snapshot_asof(at) else {
            return Self::current();
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&payload) else {
            return Self::current();
        };
        match (v.get("pricing"), v.get("codex_pricing")) {
            (Some(main), Some(codex)) => {
                // 用户补的卡也要盖在**快照**上：绝大多数月份查询走的是快照分支
                // （有价卡快照就用它），只在 `current()` 合并等于用户补的卡对
                // 当月不生效——而那恰恰是用户补卡时想看效果的月份。
                let mut main = main.clone();
                let mut codex = codex.clone();
                // 每日同步叠加层只补这份历史快照里当时没有的卡（新模型发布到价卡
                // 上线之间的用量）；已有的卡保持快照当时的价——厂商调价不改写历史。
                if let Some(overlay) = db
                    .latest_pricing_sync_overlay()
                    .ok()
                    .flatten()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                {
                    agent_vitals_domain::cost::sync_overlay::fill_missing_from_sync_overlay(
                        &mut main, &mut codex, &overlay,
                    );
                }
                // 旧快照里 deepseek-official 没有币种标签 → 补上（见函数文档）；否则那些月份的
                // DeepSeek 用量整体被判 no-price-card。
                agent_vitals_domain::cost::sync_overlay::backfill_provider_currency(
                    &mut main,
                    &agent_vitals_domain::cost::load_pricing(),
                );
                crate::price_overrides::apply_to_main(&mut main, &crate::home::data_home());
                Self { main, codex }
            }
            // 老快照只存了一半 → 整体退当前卡，不半用（半用会让 DSH 按历史卡、
            // codex 按当前卡，跨执行环境总额失去单一时点语义）。
            _ => Self::current(),
        }
    }
}

/// `YYYY-MM-DD` 日键 → 新鲜度（今天/昨天 = Fresh，更早 = Stale）。Stage 0 的
/// 近似口径（§8.5）：Partial 需要「源本身还活着吗」的信号，Stage B 才有。
/// `last_observed_at` 统一 `{day}T00:00:00Z`——汇总层聚合按字符串序取最大，
/// 各执行环境必须同格式，字典序才等价于时间序。
fn day_freshness(day_key: &str) -> Freshness {
    let state = if day_key == today_beijing() || day_key == yesterday_beijing() {
        FreshnessState::Fresh
    } else {
        FreshnessState::Stale
    };
    Freshness {
        state,
        last_observed_at: Some(format!("{day_key}T00:00:00Z")),
    }
}

/// 汇总层的新鲜度 = **最新被观测到的执行环境**的新鲜度。汇总回答的是「这份数据
/// 最近还有没有在更新」，单看某一个执行环境会在另一个执行环境更新得更晚时谎报过期
/// /谎报新鲜。全部执行环境都 Unavailable（`last_observed_at=None`，不变式 3
/// 保证 Unavailable 必带 None）→ 汇总 Unavailable。
fn aggregate_freshness(by_harness: &BTreeMap<String, HarnessAmount>) -> Freshness {
    by_harness
        .values()
        .filter(|h| h.freshness.last_observed_at.is_some())
        .max_by_key(|h| h.freshness.last_observed_at.clone())
        .map(|h| h.freshness.clone())
        .unwrap_or_else(Freshness::unavailable)
}

mod bundle;
mod harness_amounts;
mod quotas;
mod repository;
mod subscriptions;
#[cfg(test)]
mod tests;

pub use bundle::{
    BundleTimings, OverviewBundle, calendar_month, calendar_month_memoized,
    codex_merged_from_sql, hourly_distribution, hourly_distribution_memoized,
    overview_bundle, overview_bundle_timed,
};
pub use harness_amounts::{
    merged_claude_days_for_tests, unresolved_billing_groups,
    unresolved_billing_groups_in, unresolved_detail,
};
pub use quotas::{claude_quota_status, codex_quota_snapshot};
pub(crate) use quotas::HARNESS_PROVIDER_MAP;

// 测试面：tests.rs 只 `use super::*`，两个测试直测的私有项经此可见
//（lib 构建不引入）。
#[cfg(test)]
pub(crate) use harness_amounts::codex_unresolved_rows;
pub use crate::home::codex_home;
pub use repository::SqlSummaryRepository;

// 跨子模块共享的内部项经本层中转（子模块只 `use super::*`，看不见兄弟的
// 名字空间）：执行环境折叠产物给 bundle/repository，计费政策应用给 repository。
pub(crate) use harness_amounts::{
    claude_harness_amount_with_tokens_from_days, codex_harness_amount_provider_safe, plugin_tokens_by_harness,
    codex_provider_amounts_from_sql,
    dsh_day_tokens, dsh_harness_amount, dsh_provider_amount, dsh_tokens,
    degrade_claude_freshness_if_legacy_backed, fetch_windowed, merged_claude_days,
    restore_full_harness_tokens, workbuddy_harness_amount_with_tokens,
    claude_provider_amounts_from_sql,
};
pub(crate) use subscriptions::{
    apply_declared_subscription_fees, apply_harness_bills, apply_subscription_fees,
    declared_subscription_fees,
};
