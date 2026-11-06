//! agent-vitals-probe ——「测试」tab 的 runner 面（WORKBENCH_TEST_TAB_SPEC §6）。
//!
//! 分层：判定纯逻辑在 `agent-vitals-domain::probe`（对拍/词表测试钉住），
//! 存储在 `agent-vitals-data::probe`（单向状态机 + consent 首见保留测试钉住），
//! 本 crate 只做进程编排、发起期凭据（内存直传即用即弃）与成对交错调度。
//! P1 范围：L0 身份探针；L1 金丝雀与统计判定随 tab P2。

pub mod credentials;
pub mod current_route;
pub mod discover;
pub mod l0;
pub mod runner;
