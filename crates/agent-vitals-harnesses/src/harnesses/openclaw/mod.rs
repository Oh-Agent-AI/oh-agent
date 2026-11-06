//! OpenClaw（含 Hermes 的目录发现，两者共用一份解析代码）adapter surface。
//!
//! **Skill-Surface-only 执行环境**：与 `claude_code`/`codex`/`dsh`/`workbuddy`
//! 不同，OpenClaw 没有 Session Surface 证据面（不进
//! `harness_capability.rs::RUNTIME_HARNESS_IDS` 的四个"运行时执行环境"），所以本目录
//! 没有 `sessions/`，只有 `sources/skills.rs`——v0.8 Phase E7.6 从二进制
//! `apps/cli/src/skills/openclaw.rs` 整体迁来（多实例目录发现 + `openclaw
//! skills list --eligible` 子进程探测，I/O 与判断逻辑交织，同 workbuddy.rs
//! 的判断：不拆）。

#[cfg(feature = "sources")]
pub mod sources;
