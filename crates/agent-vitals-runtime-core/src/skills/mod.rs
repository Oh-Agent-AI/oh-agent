//! Skill Surface 的运行时编排——不是执行环境 wire 解释（`agent-vitals-harnesses` 不
//! 装这个），也不是纯规则计算（`agent-vitals-domain` 不装这个），是"把多个
//! 执行环境的证据跑成一次可靠的体检"这件运行时职责。
//!
//! v0.8 Phase E7.4 迁 `snapshot`（本机快照读写）。E7.5 迁 `scanner`（原
//! `discovery.rs`：目录遍历 + 按执行环境分类 + 逐 skill 记录组装，936 行，本仓库
//! 最复杂的单一函数集）+ `security`（`scanner`/原二进制 `security.rs` 互相
//! 调用对方，必须一起迁，否则出现"库依赖二进制"）+ `inventory`（跨执行环境编排：
//! 调 `harnesses::{codex,openclaw,workbuddy}` 的探测 + `scanner::collect`）——
//! `inventory` 依赖这三个执行环境适配器都已经是库 crate 里的模块（E7.6 的产物），
//! 这正是 E7.5/E7.6 顺序被推翻、必须先做 E7.6 的原因。

pub mod inventory;
pub mod scanner;
pub mod security;
pub mod snapshot;
