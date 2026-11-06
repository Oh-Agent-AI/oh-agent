//! 事实执行环境封闭词表。
//!
//! W3 从 `ingest::ingest_service` 下沉到 core：`query::export` 只为枚举执行环境就
//! 依赖了写入侧 ingest，拆 crate 时是一条环。词表是全 crate 的底层事实，放 core。

/// 事实执行环境封闭词表（与四个 emitter 的 `harness` stamp 同源；`trace_service::
/// TRACE_HARNESSES` / `reimport_verify::HARNESSES` / `summary::WIRED_HARNESSES` 与本表同步
/// 维护——加执行环境四处一起改）。
pub const FACT_HARNESSES: [&str; 4] = ["claude-code", "codex", "dsh", "workbuddy"];
