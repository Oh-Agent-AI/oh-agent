//! §14.4 迁移规则的 `vitals_core::detector::Detector` 实现——family①
//! （SV601–610，`behavior.rs`）与 family④（SV611–614，`trajectory.rs`）全部
//! 在此。每个 Detector 只做两件事：判定逻辑与老 `detect_svNNN` 完全相同
//! （同一个正则/同一套过滤条件，避免重新写一份制造 drift——正则/常量能
//! `pub(crate)` 复用的都直接复用，见各文件顶部说明）；把 legacy 展示字段
//! （`rule`/`category`/`tool_name`……）写进 `FindingDraft.attributes`，供
//! `compatibility::findings::vitals_report_to_legacy_findings` 原样取出。

pub mod sv601;
pub mod sv602;
pub mod sv603;
pub mod sv604;
pub mod sv605;
pub mod sv606;
pub mod sv607;
pub mod sv608;
pub mod sv609;
pub mod sv610;
pub mod sv611;
pub mod sv612;
pub mod sv613;
pub mod sv614;

pub use sv601::Sv601Detector;
pub use sv602::Sv602Detector;
pub use sv603::Sv603Detector;
pub use sv604::Sv604Detector;
pub use sv605::Sv605Detector;
pub use sv606::Sv606Detector;
pub use sv607::Sv607Detector;
pub use sv608::Sv608Detector;
pub use sv609::Sv609Detector;
pub use sv610::Sv610Detector;
pub use sv611::Sv611Detector;
pub use sv612::Sv612Detector;
pub use sv613::Sv613Detector;
pub use sv614::Sv614Detector;
