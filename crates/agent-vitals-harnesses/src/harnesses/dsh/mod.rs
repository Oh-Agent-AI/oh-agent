//! DSH adapter surfaces.
//!
//! `sessions/` = 会话证据（纯，wasm 可链）。`sources/` = 定位 / 读取 / 多帧 zstd
//! 解压（I/O + `ruzstd`，`#[cfg(feature = "sources")]`——纯构建 / wasm 不编译）。
//! v0.8 Phase D4 把二进制 `src/dsh.rs`（DSH 会话 JSONL 读取器）整体迁进 `sources`。

pub mod sessions;

#[cfg(feature = "sources")]
pub mod sources;
