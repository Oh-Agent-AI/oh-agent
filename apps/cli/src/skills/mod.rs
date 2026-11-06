//! Skill Vitals 静态体检子面——**CLI 展示层**：doctor / diff / explain /
//! redact / render / report，读已经扫描好的记录渲染成文字/JSON。
//!
//! 扫描本身（`discovery.rs`/`inventory.rs`/`security.rs`）v0.8 Phase E7.5
//! 迁进 `agent-vitals-runtime::skills::{scanner,inventory,security}`；执行环境
//! 适配器（codex / openclaw / workbuddy / harness 的配置解释与探测）E7.6 迁进
//! `agent-vitals-harnesses::harnesses::<h>::{skills,sources::skills}`。本子树现在
//! 只剩"调 runtime service → 渲染"的 CLI 层，没有自己的扫描/编排逻辑。
//!
//! 与 `agent/` 的边界：**「skill 体检」是静态资产审计**（本子树），**「skill
//! 执行」是会话内审计**（core 的 `skill.rs`，经
//! `agent_vitals_runtime::sessions::behavior` 折叠）——
//! 两者都叫 skill，但一个是扫描器、一个是轨迹检测器，永远不该混在一个子树里
//! （分类守卫测试 tests/test_classification.py 钉住这条边界）。

pub mod diff;
pub mod doctor;
pub mod explain;
pub mod redact;
pub mod render;
pub mod report;
