//! 成本计算的二进制侧薄封装。
//!
//! 纯计算（`cost_report`/`cost_block`/`priced_day`/`load_pricing`）住在
//! `crates/agent-vitals-domain`（单一真相源，CLI / Python / Tauri 菜单栏共用），
//! 这里只 re-export，让既有调用点（`main.rs` 的 `agent::cost::*`）不改一行。
//! （v0.9 Stage 0.3：`behavior.rs` 本身已搬进
//! `agent_vitals_runtime::sessions::behavior`，它现在直接读
//! `agent_vitals_domain::cost::*`，不再经这层转发——`cost_series` 因此从这份
//! re-export 列表里删掉，没有第二个消费者。）

pub use agent_vitals_domain::cost::{cost_block, cost_report, load_pricing};
