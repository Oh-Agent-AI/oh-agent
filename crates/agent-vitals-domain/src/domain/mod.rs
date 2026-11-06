//! Cross-harness Agent Vitals computations.
//!
//! Phase A changes ownership and navigation only. `usage` and `cost` still
//! contain known harness-era compatibility seams; their semantic split belongs
//! to Phase C and is guarded by the existing parity and golden suites.

pub mod attribution;
pub mod behavior;
pub mod budget;
pub mod canonical_audit;
pub mod coords;
pub mod cost;
pub mod data_contract;
pub mod detectors;
pub mod duration;
pub mod enrichment;
pub mod findings;
pub mod fx;
pub mod mcp;
pub mod plan;
pub mod probe;
pub mod route_quality;
// 会话消耗诊断（SESSION_TRACE_DIAGNOSTICS_SPEC r6）：回合轴 + 三类诊断的纯计算。
pub mod session_insights;
// 执行环境无关的会话语义（指纹、能力名、回合/模型切换状态机）：各执行环境适配器共用一份。
pub mod session_semantics;
pub mod skill;
pub mod skills;
// SourceGraph 纯策略面（AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC §4-§6，
// P3 从 runtime 下沉）：checkpoint 投影 + classify 软硬判定 + SourceParser
// 插件位契约——确定性策略住 domain（AGENTS.md 纪律），执行环境实现在 harnesses。
pub mod source_graph;
pub mod state;
pub mod subagent;
pub mod takeover;
pub mod trace;
pub mod trajectory;
pub mod trust;
pub mod usage;
pub mod util;
pub mod catalog_index;
