//! 省钱方案（`agent-vitals plan`）的二进制侧薄封装。
//!
//! 纯计算（`build_plan`）住在 `crates/agent-vitals-domain`（单一真相源，
//! CLI / Python / wasm 共用），这里只 re-export，让 `main.rs` 的
//! `agent::plan::build_plan` 不改一行。与 `cost.rs` 的封装同款——core 是规则的家，
//! 二进制只做 I/O 接线。

pub use agent_vitals_domain::plan::build_plan;
