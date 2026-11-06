//! Agent 行为与成本审计子面：会话执行审计（behavior，吃 core 的轨迹/证据规则）
//! 与成本折叠（cost = DSH ¥、codex_usage_fact/claude_usage_fact/dsh_usage_fact =
//! v0.7 UsageFact 发射器）。
//!
//! 计算本体在 core crate（agent_vitals_domain），本子树只做 I/O 接线与 CLI 适配；
//! wasm 与 CLI 都包同一份 core，绝不在这里长第二份规则。
//!
//! v0.9 Stage 0.3（`docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md` §6）：
//! `codex_cost`/`behavior`/`discovery`（DSH 专用）/`codex_session_audit`/
//! `r2a_store` 全部迁进了 `agent_vitals_runtime::sessions`；`claude_cost.rs`
//! 只搬走了其中的 ledger 只读取值路径（`claude_ledger_day_tokens` 等），
//! fold 引擎本体仍在这里（行级原语已下沉 `agent_vitals_harnesses::claude_code_usage`）。
//!
//! v0.9 Stage A（R4 §5.2 scope gap 收口）：UsageFact 发射器
//! `{claude,codex,dsh}_usage_fact` 归位各执行环境 `agent-vitals-harnesses` 的
//! sources 层（`harnesses/<h>/sources/usage_fact.rs`）——wire → fact 的生产者
//! 不再由 CLI 拥有；这里 re-export 同一模块，CLI 命令路径不变。
//! 本子树现在只剩 CLI 独有的 I/O 接线：成本折叠（`cost`/`claude_cost`）、
//! CLI 展示助手（`oneline`/`plan`）、执行环境能力注册表（`harness_runtime_
//! registration`）。

pub mod claude_cost;
pub mod cost;
pub mod harness_runtime_registration;
pub mod oneline;
pub mod plan;

pub use agent_vitals_harnesses::{claude_usage_fact, codex_usage_fact, dsh_usage_fact};
