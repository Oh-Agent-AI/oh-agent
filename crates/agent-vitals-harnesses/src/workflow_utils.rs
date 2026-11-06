//! 兼容入口：这些执行环境无关的 helper 已下沉到
//! `agent_vitals_domain::session_semantics`（此前 dsh 还有一份逐字相同的私有副本）。
//! 保留本模块只为不改动既有 `crate::workflow_utils::*` 调用点；新代码直接用 domain 路径。

pub use agent_vitals_domain::session_semantics::{
    fingerprint, iso_to_epoch_ms, outcome, safe_label, session_span,
};
