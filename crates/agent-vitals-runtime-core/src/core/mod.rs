//! 平台原语（crate 根，无领域归属，被所有子目录依赖）。

pub mod clock;
pub mod fact_harnesses;
pub mod home;
pub mod lease;
pub mod logging;
pub mod retention;
pub mod sql_authority;
pub mod state;
pub mod fx_settings;
pub mod statistics_timezone;
pub mod takeover;
pub mod extension_objects;
