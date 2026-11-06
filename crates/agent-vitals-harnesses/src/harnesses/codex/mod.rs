//! Codex adapter surfaces.
//!
//! `sessions/` = 会话证据（纯，wasm 可链）。`sources/` = I/O
//! （`#[cfg(feature = "sources")]`——纯构建 / wasm 不编译）：`mod.rs` 是会话
//! I/O（v0.8 Phase D5 把二进制 `src/agent/codex_session.rs` 迁来），
//! `skills.rs` 是 Skill 配置 I/O（E7.6 把二进制 `skills/codex.rs` 的子进程
//! 探测部分迁来）。`skills/` = Skill Surface 的纯计算（协议报文构造/响应
//! 解析/运行时元数据合并，E7.6 从二进制 `skills/codex.rs` 拆出——该文件自己
//! 的模块头早就说清了这条边界，本次只是把设计意图落进 crate 边界）。

pub mod sessions;
pub mod skills;

#[cfg(feature = "sources")]
pub mod sources;
