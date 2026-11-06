//! Stage B P2（spec §4）：`BillingContext`——计费声明的**类型化视图**。
//!
//! 声明本体来自调用方提供的本地用户快照；公共`pricing.json`不再内置套餐。
//! 本模块不做第二份解析、不发明第二套口径词汇——装配走
//! `agent_vitals_domain::cost::declared_subscriptions` 同一读取器，产出的
//! 每一笔金额都落 `data_contract::BillingBasis` 既有五档（FixedSubscription
//! 是订阅月费的唯一档位，spec §4"只能按周期单列"）。
//!
//! `UserProfile`（预算、可计量范围等用户偏好）在消费方真实需要之前保持
//! 不实现——spec §4 的词表已在 `BillingBasis`/`HarnessAmount` 落位，加一个
//! 没有消费方的结构只会制造第二个"真相源"的幻觉。

use serde_json::Value;

/// 一条用户声明的固定订阅（spec §4 fixed subscription 行）。
#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredSubscription {
    /// billing_source（`by_provider` 键的后半段，如 `glm` / `minimax`）。
    pub provider: String,
    /// 月费金额（声明口径；金额缺失的声明进不了这个结构——`declared_
    /// subscriptions` 只收 `amount_per_month` 在场的行）。
    pub amount_per_month: f64,
    /// 币种；**缺失不是错误但是违规**（`violations` 报）——分币分栏纪律
    /// （ATTRIBUTABLE_WASTE §6：跨币永不相加）要求每笔金额可分栏。
    pub currency: Option<String>,
}

/// 用户计费声明的类型化快照。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BillingContext {
    pub subscriptions: Vec<DeclaredSubscription>,
}

impl BillingContext {
    /// 从 pricing.json 装配（委托 domain 同一读取器，**不二解价格**）。
    pub fn from_pricing(pricing: &Value) -> Self {
        // domain 元组序：(provider, currency, amount, period_start)。currency
        // 在读取器里缺省 "CNY"——声明层不产无币种条目；violations 的
        // 「无币种」违规在本读取器下不会触发（防御性保留）。
        let subscriptions = agent_vitals_domain::cost::declared_subscriptions(pricing)
            .into_iter()
            .map(|(provider, currency, amount, _period)| DeclaredSubscription {
                provider,
                amount_per_month: amount,
                currency: Some(currency),
            })
            .collect();
        Self { subscriptions }
    }

    /// 声明完整性违规清单（报告式，不 panic）：
    /// - 金额无币种 → 跨币分栏纪律受损（最常见的声明疏漏）；
    /// - 非正金额 → 摊销与利用率倍数的分母语义坏掉。
    pub fn violations(&self) -> Vec<String> {
        let mut out = Vec::new();
        for s in &self.subscriptions {
            if s.currency.is_none() {
                out.push(format!(
                    "subscription `{}` has amount_per_month={} without currency — 跨币分栏无法落位",
                    s.provider, s.amount_per_month
                ));
            }
            if s.amount_per_month <= 0.0 {
                out.push(format!(
                    "subscription `{}` has non-positive amount_per_month={}",
                    s.provider, s.amount_per_month
                ));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn assembles_from_the_single_declaration_source() {
        let pricing = json!({
            "catalog_2026_09": {
                "subscriptions": {
                    "_doc": {"donotmatch": true},
                    "glm-coding-lite": {
                        "provider": "glm", "amount_per_month": 118.0,
                        "currency": "CNY", "billing_period_start": "2026-09-03"
                    },
                    "claude-pro": {
                        "provider": "anthropic", "amount_per_month": 20.0,
                        "currency": "USD"
                    }
                }
            }
        });
        let ctx = BillingContext::from_pricing(&pricing);
        assert_eq!(ctx.subscriptions.len(), 2, "_ 前缀 doc 行不进声明");
        assert!(ctx.violations().is_empty());
        let glm = ctx
            .subscriptions
            .iter()
            .find(|s| s.provider == "glm")
            .unwrap();
        assert_eq!(glm.amount_per_month, 118.0);
        assert_eq!(glm.currency.as_deref(), Some("CNY"));
    }

    #[test]
    fn missing_currency_defaults_to_cny_nonpositive_is_violation() {
        let pricing = json!({
            "catalog_2026_09": {
                "subscriptions": {
                    "bad": {"provider": "x", "amount_per_month": 0.0}
                }
            }
        });
        let ctx = BillingContext::from_pricing(&pricing);
        // 读取器缺省 CNY（跨币分栏在源头就成立）——本路径只产「非正金额」违规。
        assert_eq!(ctx.subscriptions[0].currency.as_deref(), Some("CNY"));
        assert_eq!(ctx.violations().len(), 1, "{:?}", ctx.violations());
    }
}
