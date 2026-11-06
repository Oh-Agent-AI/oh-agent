//! Harness-owned wire interpretation, grouped first by harness and then surface.

pub mod claude_code;
pub mod codex;
pub mod dsh;
// 自描述插件执行环境（HARNESS_MANIFEST_DSL_SPEC）：wire 是任意执行环境的 JSONL，
// 映射由 manifest 声明；I/O 面在 `generic/sources`（`sources` feature）。
pub mod generic;
pub mod openclaw;
pub mod workbuddy;
