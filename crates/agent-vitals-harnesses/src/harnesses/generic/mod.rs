//! `generic` —— 自描述插件执行环境（HARNESS_MANIFEST_DSL_SPEC）。
//!
//! 第一层按证据面分纯/I-O（与本 crate 其余执行环境同构）：
//! - `manifest.rs`（纯）：manifest 解析 + schema 校验 + 受限正则子集；
//! - `sources/`（I/O，`sources` feature）：文件发现（walkdir + 受限 glob）。
//!
//! recipe 求值（纯，`recipe.rs`）与 Candidate DTO（`candidate.rs`）随后续
//! 任务落地；喉咙（Candidate → UsageFact、billing 锁、provenance）在
//! `agent-vitals-runtime`，不在本 crate——这里只产「候选事实行」。
//!
//! `generic` 是「执行环境」意义上的目录：它没有自己的 wire 格式，它的 wire 是
//! 任意执行环境的 JSONL，由 manifest 声明映射。

pub mod candidate;
pub mod manifest;
pub mod recipe;

#[cfg(feature = "sources")]
pub mod sources;
