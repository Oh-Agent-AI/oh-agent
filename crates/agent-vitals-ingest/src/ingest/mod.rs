//! 同步与入库域。


pub mod engine;
pub mod extension_installer;
pub mod findings_eval;
pub mod ingest_service;
pub mod local_manifest_install;
pub mod local_manifest_lifecycle;
pub mod manifest_recompute;
pub mod vendor_manifest_install;
/// 兼容路径：writer lease 是基础设施（sources / billing 也要拿锁），W3 下沉到 `core::lease`。
pub use crate::core::lease;
pub mod plugin_ingest;
pub mod reimport_verify;
pub mod scheduler;
// 自看护（REVIEW P4，G5）：读自身 CPU、超阈值持续一段时间就把 watcher 冷却
// 指数拉长。与 `watch` 同级——它是 watch 触发路径的节流阀，不是 watch 内部
// 机制，watcher 关闭时（feature 关闭/无根）也一样能读 CPU、一样能生效。
pub mod self_monitor;
/// 兼容路径：SQL 权威开关只是 data_home 下的一个标记文件，W3 下沉到 `core`。
pub use crate::core::sql_authority;
pub mod sql_sync;
pub mod sync_control;
pub mod sync_service;
// P2 watcher（spec §9-P2）：文件事件 → 去抖 → 唤醒 tick + watch-only 消费者。
pub mod watch;
