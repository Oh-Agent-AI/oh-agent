//! Vitals Core —— harness-agnostic behavioral audit runtime
//! （`docs/VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md`）。
//!
//! # 现状（M0–M3 已完成，接入生产）
//!
//! `CanonicalEvent` / `Signal` / `Coverage` / `Provenance` / `Trajectory` /
//! `Detector` / `Evidence` / `Finding` / `Replay` / `VitalsEngine` 全部已实
//! 现（README.md 的 30 秒示例、`tests/golden_replay.rs` 的五个 fixture、
//! `tests/pipeline.rs` 都在跑真实的端到端管线，不是骨架）。**已接入现有
//! CLI**：`agent-vitals-domain` 依赖这个 crate（`compatibility/` 桥接层），
//! `behavior.rs`/`trajectory.rs` 的 SV601–SV614 全部十四条规则的
//! `detect_svNNN` 生产入口都委托这里的 `VitalsEngine`，原判定逻辑保留成
//! `detect_svNNN_legacy` 作自动回退——不是并行存在两条从不交汇的路径，是
//! 真正在跑的生产代码。见 README.md「Migration notes」一节。
//!
//! 参见 spec §19（M0–M4 交付阶段）与 §20（Definition of Done）了解逐项验
//! 收状态——M4（文档/性能基线/golden fixture）也已完成，`PERFORMANCE.md`
//! 记录了基线数据。
//!
//! # 边界纪律（§4.1 / §5.2，`tests/dependency_boundary.rs` 钉住）
//!
//! - 本 crate 的公开类型、模块名不出现 Codex / DSH / Skill / Investment /
//!   IBKR 等领域词——领域内容只能通过 `CanonicalEvent::kind` /
//!   `CanonicalEvent::attributes` 承载，Core 不解释这些值（§4.1）。
//! - 本 crate 不依赖 `agent-vitals-domain` / `agent-vitals-harnesses` / `agent-vitals-wasm` / 二进制 /
//!   `apps/desktop/src-tauri`（§5.2 单向依赖：只能反过来）。
//! - 本 crate 不读文件、不读环境变量、不访问网络、不启动子进程（§18.1）。

pub mod canonical;
pub mod coverage;
pub mod detector;
pub mod diagnostic;
pub mod engine;
pub mod error;
pub mod evidence;
pub mod event;
pub mod finding;
pub mod id;
pub mod provenance;
pub mod replay;
pub mod report;
pub mod signal;
pub mod trajectory;
