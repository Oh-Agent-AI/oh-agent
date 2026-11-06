//! 价卡层：金额类型（`money`）、价目目录校验（`pricing_catalog`）与用户价卡
//! 覆盖（`price_overrides`）。
//!
//! W3 从 `billing/` 拆出：billing 里其余模块（预算、预览、价格发现）要读
//! `query::summary`，而 query / sessions 计价又要读价卡——两者同居一个模块时
//! `billing ↔ query` 是一条环。价卡本身不依赖本 crate 任何模块，放在 query 之下；
//! `billing::{money,…}` 保留为兼容路径。

pub mod money;
pub mod price_overrides;
pub mod quote_variants;
pub mod pricing_catalog;
