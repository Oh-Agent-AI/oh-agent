//! 读侧与服务面域。
//! 读侧与服务面域。


pub mod cost_breakdown;
pub mod app_local;
pub mod app_harnesses;
pub mod decision_matrix;
pub mod export;
pub mod read_gate;
pub mod read_memo;
pub mod session_insights;
pub mod session_ref;
pub mod object_store;
pub mod plugin_events;
pub mod plugin_calls;
pub mod summary;
pub mod trace_service;

pub mod city_assets;
#[cfg(test)]
pub mod city_building;
#[cfg(test)]
pub mod city_im;
#[cfg(test)]
pub mod city_building_catalog;
#[cfg(test)]
pub mod city_building_compliance;
// Design coherence is validated by the trusted TypeScript write adapter.
// Keep Rust's former write-path implementation only for crate parity tests.
#[cfg(test)]
pub mod city_building_design;
#[cfg(test)]
pub mod city_building_inheritance;
// `city:v3` is no longer dispatched by the desktop host. Keep its old contract
// implementation available only to the in-crate regression tests while legacy
// City data migration is being closed out.
#[cfg(test)]
pub mod city_v3;
#[cfg(test)]
mod city_v3_contract_tests;
