//! 数据源接入编排域。

pub mod custom_sources;
pub mod harness_registry;
pub mod session_sources;
pub mod source_controls;
// P2/B（HARDENING spec §5.2）：监听根拓扑投影——「该监听哪些目录」的唯一答案，
// 与 ingest 同一份配置派生；desktop 不再自建清单。
pub mod watch_topology;
