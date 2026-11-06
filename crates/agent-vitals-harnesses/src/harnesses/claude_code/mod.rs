//! Claude Code adapter surfaces.
//!
//! `sessions/` = 会话证据（纯，wasm 可链）。`sources/` = 文件定位 / 读取
//! （I/O，`#[cfg(feature = "sources")]`——纯构建 / wasm 不编译）：`mod.rs` 是
//! 会话 I/O（v0.8 Phase D5 把二进制 `src/agent/claude_session.rs` 迁来），
//! `skills.rs` 是 Skill 配置 I/O（E7.6 迁来）。`skills/` = Skill Surface 的
//! 执行环境配置解释（纯，wasm 可链，E7.6 从二进制 `skills/harness.rs` 拆出）。

pub mod sessions;
pub mod skills;

#[cfg(feature = "sources")]
pub mod sources;
