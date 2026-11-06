//! `TraceGraph` —— v0.10.0 的核心契约（spec §2.1 / §2.1.1 / §2.1.2）。
//!
//! 这是把一次会话变成「一张可下钻的图」的类型层：一份会话跑完适配器流水线
//! 产出的 `CanonicalSession`（`contracts::evidence`）之后，`domain::trace`
//! 里的纯函数把它**投影**成 `TraceGraph`——图节点/边引用 `CanonicalSession`
//! 已经算好的观测，本模块不解析任何执行环境 wire 事件（`contracts_module_stays_
//! vocabulary_only` 的边界同样约束这里：只放词表，不放算法）。
//!
//! **诚实性边界（读代码前必读）**：以下三个字段目前只能给出诚实的占位值，
//! 不是漏做，是 `CanonicalSession` 现有形状还没有对应的信号——冒充比留白
//! 更糟（`evidence.rs`「adapter 不得用读不到的东西刷覆盖」同一条纪律）：
//!
//! 1. 纯 builder 只构造 canonical evidence 节点：`fact_id` 留空、
//!    `evidence_ref` 为可重放的 canonical 坐标。运行时 `trace_service` 再把
//!    authority 中存在的每条 `UsageFact` 加成 `ModelInvocation` 节点（其
//!    `fact_id` 非空）。两层不混：domain 不依赖 SQL，也绝不根据时间猜测某个
//!    tool/turn 对应哪一条 fact。
//! 2. `TraceNode::branch_state` 目前恒为 `Live`。`CanonicalSession` 的时间线
//!    是适配器"抽取"阶段已经选好的一条路径（`populate_timelines` 只填这一条），
//!    还没有把 `leafUuid`/`isSidechain`/`thread_rolled_back`/`seedLength`
//!    这类线性化信号带进 `TimelineEntry`；`Live` 是对"当前 CanonicalSession
//!    只装得下一条路径"这一事实的诚实转述，不是"废弃分支已排除"的断言。
//!    真正的分支检测要等这些信号进了 `CanonicalSession` 才能做（v0.10.0
//!    Phase 2 的候选工作项）。
//! 3. subagent 多编号空间（`scope != "main"`）本模块的构建函数暂不产出——
//!    `CanonicalSession` 当前形状把一次会话（含其子代理片段）折成一份单一
//!    的时间线集合，没有单独的子代理编号空间可读。`scope` 字段恒为 `"main"`。

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{json, Value};

use crate::contracts::evidence::Provenance;
use crate::contracts::session_key::SessionKey;

// ────────────────────────── 节点/边类型：封闭词表 ──────────────────────────

/// spec §2.1：`user_task / assistant_turn / model_invocation / tool_call /
/// subagent / compaction / retry / outcome / model_change`。九项闭集，新增
/// 变体必须先改 spec——这是本仓库反复强调的纪律（`issue_type` §2.4.2 同款）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum TraceNodeType {
    UserTask,
    AssistantTurn,
    ModelInvocation,
    ToolCall,
    Subagent,
    Compaction,
    Retry,
    Outcome,
    /// Pi 单会话实测 4 模型 5 次切换，W1 需按模型族分别计算并排除切换边界
    /// （spec §2.4.1）——v0.10.0 的三执行环境（claude-code/codex/dsh）目前没有
    /// 单会话内切换模型的已知场景，此变体先占位，构建函数暂不产出。
    ModelChange,
}

impl TraceNodeType {
    pub fn as_str(self) -> &'static str {
        match self {
            TraceNodeType::UserTask => "user_task",
            TraceNodeType::AssistantTurn => "assistant_turn",
            TraceNodeType::ModelInvocation => "model_invocation",
            TraceNodeType::ToolCall => "tool_call",
            TraceNodeType::Subagent => "subagent",
            TraceNodeType::Compaction => "compaction",
            TraceNodeType::Retry => "retry",
            TraceNodeType::Outcome => "outcome",
            TraceNodeType::ModelChange => "model_change",
        }
    }
}

impl fmt::Display for TraceNodeType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// spec §2.1：`causal / temporal / data_flow / control_flow`。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TraceEdgeType {
    Causal,
    Temporal,
    DataFlow,
    ControlFlow,
}

impl TraceEdgeType {
    pub fn as_str(self) -> &'static str {
        match self {
            TraceEdgeType::Causal => "causal",
            TraceEdgeType::Temporal => "temporal",
            TraceEdgeType::DataFlow => "data_flow",
            TraceEdgeType::ControlFlow => "control_flow",
        }
    }
}

/// spec §2.1：`ok / error / timeout / cancelled / unknown`。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TraceStatus {
    Ok,
    Error,
    Timeout,
    Cancelled,
    Unknown,
}

impl TraceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TraceStatus::Ok => "ok",
            TraceStatus::Error => "error",
            TraceStatus::Timeout => "timeout",
            TraceStatus::Cancelled => "cancelled",
            TraceStatus::Unknown => "unknown",
        }
    }
}

/// spec §2.1.1：废弃分叉的去处。`Live` = 在 `CanonicalSession` 选定的路径上；
/// `Abandoned` = 已确认是用户放弃的分支（v0.10.0 尚无信号来源，构建函数不产
/// 这个值，见模块顶部诚实性边界第 2 条）；`Unknown` = 有分支信号但线性化算法
/// 无法判定（同样是未来工作）。三态齐备是为了不让「有信号但没实现」与
/// 「压根没有信号」混成一种沉默。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BranchState {
    Live,
    Abandoned,
    Unknown,
}

impl BranchState {
    pub fn as_str(self) -> &'static str {
        match self {
            BranchState::Live => "live",
            BranchState::Abandoned => "abandoned",
            BranchState::Unknown => "unknown",
        }
    }
}

fn provenance_json(p: Provenance) -> Value {
    match p {
        Provenance::Measured => json!({"kind": "measured"}),
        Provenance::Derived { from } => json!({"kind": "derived", "from": from}),
        Provenance::Estimated { estimator } => json!({"kind": "estimated", "estimator": estimator}),
        Provenance::Lossy { kind } => {
            let k = match kind {
                crate::contracts::evidence::LossKind::Truncated { hint } => {
                    json!({"kind": "truncated", "hint": hint})
                }
                crate::contracts::evidence::LossKind::Hashed => json!({"kind": "hashed"}),
                crate::contracts::evidence::LossKind::Redacted => json!({"kind": "redacted"}),
            };
            json!({"kind": "lossy", "loss": k})
        }
    }
}

// ────────────────────────── TraceNode / TraceEdge ──────────────────────────

/// spec §2.1 + §2.1.1。字段顺序即 JSON 序列化键序（`to_json`），与
/// `SessionKey::to_json` 同一条纪律：键序是字节一致的一部分，不能重排。
#[derive(Clone, Debug)]
pub struct TraceNode {
    /// `fnv1a64_hex(canonical_json(...))`——稳定主键，仅用于幂等；不是 join 键
    /// （见模块顶部「不得自造 join 键」的澄清）。
    pub node_id: String,
    /// 编号空间：主会话 `"main"` / 子代理。v0.10.0 恒为 `"main"`（诚实性边界 3）。
    pub scope: String,
    /// 权威执行顺序；scope 内严格递增，跨 scope 不可比。**不得用于跨 scope 比较**。
    pub ordinal: u64,
    /// 执行环境原生事件 id（Seq|Uuid|CallId|TurnId）——跨 scope join 只走它。
    pub native: String,
    pub node_type: TraceNodeType,
    /// 引用的 `UsageFact.fact_id`；canonical evidence 节点为空，运行时追加的
    /// `model_invocation` 节点必须填真实 fact id（见模块顶部诚实性边界 1）。
    pub fact_id: String,
    /// 引用的 evidence_ref；canonical 节点是稳定的 opaque 坐标，SQL fact 节点
    /// 是 `uf1:<fact_id>`。空串只允许表示执行环境确实没有该证据。
    pub evidence_ref: String,
    pub parent_node_id: Option<String>,
    /// v0.10.0 恒为 `Live`（诚实性边界 2）。
    pub branch_state: BranchState,
    /// 仅用于展示与时间分桶，**不参与排序**。
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub status: Option<TraceStatus>,
    pub provenance: Provenance,
    /// 量值；缺的键不出现（不是填 0/null）——`BTreeMap` 保证键序确定。
    pub values: BTreeMap<String, f64>,
    pub metadata: Value,
}

impl TraceNode {
    pub fn to_json(&self) -> Value {
        json!({
            "node_id": self.node_id,
            "scope": self.scope,
            "ordinal": self.ordinal,
            "native": self.native,
            "node_type": self.node_type.as_str(),
            "fact_id": self.fact_id,
            "evidence_ref": self.evidence_ref,
            "parent_node_id": self.parent_node_id,
            "branch_state": self.branch_state.as_str(),
            "started_at_ms": self.started_at_ms,
            "ended_at_ms": self.ended_at_ms,
            "status": self.status.map(TraceStatus::as_str),
            "provenance": provenance_json(self.provenance),
            "values": Value::Object(
                self.values.iter().map(|(k, v)| (k.clone(), json!(v))).collect()
            ),
            "metadata": self.metadata.clone(),
        })
    }
}

/// spec §2.1。字段顺序即 JSON 键序。
#[derive(Clone, Debug)]
pub struct TraceEdge {
    pub edge_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub fact_id: String,
    pub evidence_ref: String,
    pub edge_type: TraceEdgeType,
    pub provenance: Provenance,
}

impl TraceEdge {
    pub fn to_json(&self) -> Value {
        json!({
            "edge_id": self.edge_id,
            "from_node_id": self.from_node_id,
            "to_node_id": self.to_node_id,
            "fact_id": self.fact_id,
            "evidence_ref": self.evidence_ref,
            "edge_type": self.edge_type.as_str(),
            "provenance": provenance_json(self.provenance),
        })
    }
}

// ────────────────────────── TraceCoverage ──────────────────────────

/// spec §2.1 + §2.1.2：三个缺失计数原样呈现，**不设单值 `coverage_ratio`**——
/// 一个 0..1 的比率会诱导跨会话求平均，本仓库的纪律是「部分覆盖必须打标，
/// 不得按精确值聚合」。若 UI 需要一个概览数字，必须在展示层现算、
/// display-only，且不得进任何聚合查询（本类型不提供这样的方法，逼调用方
/// 现算而不是缓存一个会漂移的比率）。
#[derive(Clone, Copy, Debug, Default)]
pub struct TraceCoverage {
    pub missing_parent: u32,
    pub missing_time: u32,
    pub missing_status: u32,
    /// `branch_state != live` 的节点数——废弃分叉计入这里，不归零。
    pub unmetered_nodes: u32,
    pub total_nodes: u32,
    pub total_edges: u32,
}

impl TraceCoverage {
    pub fn to_json(&self) -> Value {
        json!({
            "missing_parent": self.missing_parent,
            "missing_time": self.missing_time,
            "missing_status": self.missing_status,
            "unmetered_nodes": self.unmetered_nodes,
            "total_nodes": self.total_nodes,
            "total_edges": self.total_edges,
        })
    }
}

// ────────────────────────── TraceGraph ──────────────────────────

/// spec §2.1。一份会话的确定性轨迹图。`nodes` 按 `(scope, ordinal)` 升序排列
/// ——`domain::trace::build_trace_graph` 保证这个不变量，本类型自己不重排
/// （构建后是不可变快照）。
#[derive(Clone, Debug)]
pub struct TraceGraph {
    pub schema_version: u16,
    /// `fnv1a64_hex(canonical_json(...))`——由 session_key + 输入指纹派生，
    /// 见 `input_fingerprint`。
    pub graph_id: String,
    pub session_key: SessionKey,
    /// v0.10.0 恒为 `None`——task/goal 三分法（spec §2.1.1）里唯一映射进
    /// `TraceNode.task_id` 的是 "task = turn"（Codex 语义），但那需要按
    /// turn 逐节点填，不是图级别单值；图级别的 `task_id` 目前没有信号来源。
    pub task_id: Option<String>,
    pub nodes: Vec<TraceNode>,
    pub edges: Vec<TraceEdge>,
    pub coverage: TraceCoverage,
    /// 会话级只读指标。由 runtime 在 authority facts 存在时补齐；没有价格或
    /// 没有事实时相应字段明确为 null/缺席，绝不伪造零成本或零调用。
    pub metrics: Value,
    /// 输入的指纹——同一 `CanonicalSession` 重放必须产出同一指纹（幂等/缓存
    /// 失效判定的锚点之一，配合 `trace_service` 的 memo 层）。
    pub input_fingerprint: String,
}

pub const TRACE_GRAPH_SCHEMA_VERSION: u16 = 2;

impl TraceGraph {
    pub fn to_json(&self) -> Value {
        json!({
            "schema_version": self.schema_version,
            "graph_id": self.graph_id,
            "session_key": self.session_key.to_json(),
            "task_id": self.task_id,
            "nodes": self.nodes.iter().map(TraceNode::to_json).collect::<Vec<_>>(),
            "edges": self.edges.iter().map(TraceEdge::to_json).collect::<Vec<_>>(),
            "coverage": self.coverage.to_json(),
            "metrics": self.metrics,
            "input_fingerprint": self.input_fingerprint,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_type_as_str_round_trips_all_nine_variants() {
        // 九项闭集，逐个断言而不是漏检——新增/删除变体必须在这里立刻炸。
        let all = [
            (TraceNodeType::UserTask, "user_task"),
            (TraceNodeType::AssistantTurn, "assistant_turn"),
            (TraceNodeType::ModelInvocation, "model_invocation"),
            (TraceNodeType::ToolCall, "tool_call"),
            (TraceNodeType::Subagent, "subagent"),
            (TraceNodeType::Compaction, "compaction"),
            (TraceNodeType::Retry, "retry"),
            (TraceNodeType::Outcome, "outcome"),
            (TraceNodeType::ModelChange, "model_change"),
        ];
        for (variant, s) in all {
            assert_eq!(variant.as_str(), s);
        }
    }

    #[test]
    fn coverage_to_json_has_no_ratio_field() {
        // 守 §2.1.2 的「不设单值 coverage_ratio」——回归测试：字段集合固定
        // 为六个计数，不能悄悄多出一个比率字段。
        let cov = TraceCoverage::default();
        let v = cov.to_json();
        let obj = v.as_object().unwrap();
        assert_eq!(
            obj.len(),
            6,
            "TraceCoverage 序列化必须恰好六个字段：{obj:?}"
        );
        assert!(!obj.contains_key("coverage_ratio"));
    }

    #[test]
    fn trace_node_values_missing_key_does_not_appear() {
        let node = TraceNode {
            node_id: "n1".into(),
            scope: "main".into(),
            ordinal: 0,
            native: "call_1".into(),
            node_type: TraceNodeType::ToolCall,
            fact_id: String::new(),
            evidence_ref: String::new(),
            parent_node_id: None,
            branch_state: BranchState::Live,
            started_at_ms: None,
            ended_at_ms: None,
            status: None,
            provenance: Provenance::Measured,
            values: BTreeMap::new(),
            metadata: Value::Null,
        };
        let v = node.to_json();
        let values = v.get("values").unwrap().as_object().unwrap();
        assert!(values.is_empty(), "缺的键不出现，不是填 0/null");
    }
}
