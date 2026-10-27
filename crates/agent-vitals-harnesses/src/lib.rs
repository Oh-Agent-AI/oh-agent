//! `agent-vitals-harnesses` —— Agent 执行环境的 wire 适配（v0.8 §4 v3.1）。
//! harness 指 Codex/Claude Code 等执行环境，不是 Agent Vitals 插件宿主。
//! 命名边界参见 docs/HOST_HARNESS_TERMINOLOGY.md。
//!
//! 目录第一维按执行环境（`harnesses/<h>/`），第二维分证据面：`sessions/`（会话行为/
//! 轨迹/usage/cost 事实——**纯**，wasm 可链）、`skills/`（SKILL.md 体检——纯）、
//! `sources/`（定位/读取/解压/指纹——I/O，`#[cfg(feature = "sources")]`）。
//! D3（本 crate 由 `agent-vitals-adapters` 改名）只做骨架；`sources/` 与
//! `skills/` 的填充是 D4/D5。
//!
//! **纯（内存输入）**：`sessions/` 与 `skills/` 收到的是已加载好的数据。文件
//! 发现、解码、持久化和进程编排属 `agent-vitals-runtime` / `harnesses/<h>/sources/`。
//!
//! Phase C（B2）起 Codex fold（`codex_usage`）+ 跨执行环境 `canonical_usage` 住这里；
//! **Phase D1** 把 DSH wire 解析（`evidence`/`audit`/`compaction`/`waste`）从
//! `agent-vitals-domain` 迁进 `harnesses/dsh/sessions/`——`domain/` 对执行环境 wire 形状
//! 彻底不知情。

pub mod canonical_usage;
pub mod harnesses;
pub mod skill_discovery;
pub mod workflow_utils;
// v0.10.0：多执行环境「路径 -> CanonicalSession」入口（spec §7 门槛 1 的前提，此前
// 只有 DSH 有）。I/O，随 `dsh_sources` 等同一条 `sources` feature 边界；路径
// 含 `/sources` 是故意的，落进 `io_tokens_only_appear_under_sources` 守卫。
#[cfg(feature = "sources")]
pub mod sources;

#[cfg(feature = "sources")]
pub use sources::canonical_input;
// SourceParser 注册表（spec §5 插件位，P3）：runtime 调度器的唯一执行环境解析入口。
#[cfg(feature = "sources")]
pub use sources::parsers;

// Flat compatibility facade——调用方一个 crate 一个入口。
pub use harnesses::claude_code::sessions::usage as claude_code_usage;
pub use harnesses::claude_code::sessions::evidence as claude_code_evidence;
pub use harnesses::codex::sessions::{evidence as codex_evidence, usage as codex_usage};
pub use harnesses::dsh::sessions::{
    audit, compaction, evidence as dsh_evidence, waste, workflow as dsh_workflow,
};
#[cfg(feature = "sources")]
pub use harnesses::dsh::sources::{decode_zstd_multi_frame, decode_zstd_multi_frame_limited};
pub use harnesses::workbuddy::sessions::evidence as workbuddy_evidence;

// 自描述插件执行环境（HARNESS_MANIFEST_DSL_SPEC）：manifest 校验/受限正则子集、
// recipe 求值与 Candidate DTO 都是纯面；文件发现是 I/O，随 `sources` feature。
// 喉咙（Candidate → UsageFact、billing 锁、provenance）在 runtime。
pub use harnesses::generic::{candidate as generic_candidate, manifest as generic_manifest,
    recipe as generic_recipe};
#[cfg(feature = "sources")]
pub use harnesses::generic::sources::discover as generic_discover;

// D4/D5：执行环境会话读取器（I/O，`sources` feature）。二进制 / runtime 经这些扁平
// 别名取；纯构建 / wasm 关 feature 时它们不存在。
// v0.9 Stage A：UsageFact emitter 归位（R4 §5.2 scope gap）——wire → fact 的
// 生产者从二进制 apps/cli/src/agent/ 迁进各执行环境 sources 层。机制层（writer/
// replay/reconcile）在 agent-vitals-data::evidence，与生产者解耦。
#[cfg(feature = "sources")]
pub use harnesses::{
    claude_code::sources::usage_fact as claude_usage_fact,
    // Claude Pro 的窗口状态（quotaLimits）读取器——与 usage_fact 的字节等价面无关。
    claude_code::sources::quota as claude_quota,
    // 自动归因 A5：账户级证据读取器（白名单键，规格 §7 P1）。
    claude_code::sources::account as claude_account, codex::sources::account as codex_account,
    claude_code::sources as claude_session, codex::sources::usage_fact as codex_usage_fact,
    codex::sources as codex_session, dsh::sources::usage_fact as dsh_usage_fact,
    workbuddy::sources::usage_fact as workbuddy_usage_fact,
    workbuddy::sources::traces as workbuddy_traces,
    dsh::sources as dsh_sources, workbuddy::sources as workbuddy_session,
};
