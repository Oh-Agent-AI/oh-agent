//! WorkBuddy adapter surfaces.
//!
//! `sessions/` = 会话证据（纯，wasm 可链）。`sources/` = I/O
//! （`#[cfg(feature = "sources")]`——纯构建 / wasm 不编译）：`mod.rs` 是会话
//! I/O（v0.8 Phase D5 把二进制 `src/agent/workbuddy_session.rs` 迁来），
//! `skills.rs` 是 Skill 配置 I/O（E7.6 把二进制 `skills/workbuddy.rs` 整体
//! 迁来——marketplace.json 解析与 welcomeMode 日志取证含路径穿越防护，
//! I/O 与判断逻辑交织较深，不像 `security.rs`/`harness.rs` 那样拆，同 D6 把
//! `state.rs`/`budget.rs`/`takeover.rs` 整体搬进 runtime 的先例）。

pub mod sessions;

#[cfg(feature = "sources")]
pub mod sources;
