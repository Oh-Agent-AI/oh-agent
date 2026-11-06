//! Stable cross-harness contracts.
//!
//! These modules define identities and serialized fact shapes. They do not
//! interpret a harness wire format and must remain free of I/O.

pub mod evidence;
pub mod billing;
pub mod harness_capability;
pub mod session_key;
pub mod source_identity;
pub mod trace_graph;
pub mod usage_fact;
pub mod workflow;
