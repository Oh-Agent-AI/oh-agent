//! `build_trace_graph`——v0.10.0 的核心纯函数（spec §2.1 / §2.1.1 / §6.1 「v0.9
//! 锚点」同一条纪律：种子是已落地的 `CanonicalSession`，本模块不重新解析任何
//! 执行环境 wire 形状，也不做任何 I/O（domain crate 的边界，见
//! `tests/dependency_budget.rs`）。
//!
//! **不是每执行环境一份**（与 spec §6.2 字面列出的 `harnesses/<h>/sessions/trace.rs`
//! 有意的一处偏离，理由记在这里）：`CanonicalSession` 本身就是执行环境中立的
//! 投影——`behavior.rs`/`trajectory.rs` 的 SV601–614 已经证明"harness-neutral
//! 输入 + 一份纯函数"这个模式在三执行环境上是可行且必须保持字节确定性的（spec
//! §3「v0.9 锚点」明写"直接复用 SV 规则的种子，不重写"）。给同一类输入的
//! 三份"harness-specific trace.rs"必须逐字节产出相同结果，那就不是三份代码，
//! 是一份代码的三次粘贴——本函数直接是 `CanonicalSession -> TraceGraph`
//! 的单一实现，`agent-vitals-harnesses` 侧只需要（未来）传对 `harness_id` + `session_key`。
//!
//! **门槛对照（spec §7 v0.10.0）**：
//! 1. 输入源唯一 = `&CanonicalSession`，不读 raw event —— 本函数签名就是这个承诺；
//! 2. 缺失关系不得补造 —— coverage 的三个计数 + `unmetered_nodes` 如实统计，
//!    `parent_node_id`/`status`/`started_at_ms` 缺失时留 `None`；
//! 6. 节点排序走 `(scope, ordinal)`，不按 `started_at_ms`——见 `assign_ordinals`。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::contracts::evidence::{CanonicalSession, Provenance, TimelineEntry};
use crate::contracts::session_key::SessionKey;
use crate::contracts::source_identity::{canonical_json, fnv1a64_hex};
use crate::contracts::trace_graph::{
    BranchState, TraceCoverage, TraceEdge, TraceEdgeType, TraceGraph, TraceNode, TraceNodeType,
    TraceStatus, TRACE_GRAPH_SCHEMA_VERSION,
};
use crate::domain::util::to_epoch_ms;

fn stable_id(seed: &Value) -> String {
    let mut buf = String::new();
    canonical_json(seed, &mut buf);
    fnv1a64_hex(buf.as_bytes())
}

/// 把 canonical timeline 的时间戳归一到**毫秒**，供 `_ms` 契约字段使用。
///
/// 为什么必须在**这里**归一：`TimelineEntry.time` 的单位由各执行环境适配器各自
/// 决定——Claude 的 timeline 构造器明写「`parse_iso` → **秒**」
/// （`harnesses/claude_code/sessions/evidence.rs`），Codex 与 DSH 是毫秒。而
/// `TraceNode.started_at_ms` 的契约注释声明它「用于展示与时间分桶」，名字又带
/// `_ms`。真机实测（2026-09-13）：claude-code 节点是 `1788449204`（当毫秒 →
/// 1970-01-21），codex 节点是 `1789132709000`（当毫秒 → 2026-09-11 正确）。
///
/// 与 `issue_instances.opened_at_ms` 是**同一根因、同一纪律**：单位在缝上断，
/// 修在边界上的**单一具名函数**，不在每个适配器里各写各的 `*1000`
/// （`docs/v1.0.0/ISSUE_OPENED_AT_MS_UNIT_DRIFT.md` §5.1/§7）。
///
/// 当前没有消费方按这两个字段分桶（`project_timeline_series` 用 `ordinal`），
/// 所以这是**潜在**缺陷而非现行故障——但契约说了它可用于分桶，就得让它成立。
fn entry_ms(value: Option<i64>) -> Option<i64> {
    value.map(to_epoch_ms)
}

/// 一个尚未定序的候选节点：先把 turns + tool_calls 两条 timeline 的条目都
/// 转成这个中立形状，再统一按 `(seq, timeline_priority, entry.ordinal)`
/// 排序、赋真正的 `ordinal`——两条 timeline 各自的内部顺序不能直接决定
/// 图里的全局顺序，必须先合并再排。
struct Candidate {
    seq: Option<i64>,
    /// 同一 `seq` 下的决胜位——turn 在其子 tool_call 之前（叙事顺序，且
    /// 两者永远不共享同一个 seq 值时这个字段不起作用，只在真机撞 seq 时
    /// 生效，是确定性 tie-break 不是随意选择）。
    timeline_priority: u8,
    /// adapter 已经赋好的、单条 timeline 内的稳定位置——用作最终决胜位，
    /// 不是本函数发明的顺序（该字段本就是 `CanonicalSession` 构造时定死的）。
    entry_ordinal: usize,
    native: String,
    node_type: TraceNodeType,
    started_at_ms: Option<i64>,
    ended_at_ms: Option<i64>,
    status: Option<TraceStatus>,
    provenance: Provenance,
    values: BTreeMap<String, f64>,
    metadata: Value,
    /// turn 号——tool_call 节点靠它找父节点；turn 节点自己的 turn 号也存这里
    /// （用来给 tool_call 反查时对照）。
    turn_no: Option<i64>,
    is_turn_root: bool,
}

fn turn_status(end_reason_kind: &Option<String>) -> Option<TraceStatus> {
    match end_reason_kind.as_deref() {
        None => None,
        Some("error") => Some(TraceStatus::Error),
        Some(_) => Some(TraceStatus::Ok),
    }
}

/// `failed` 是执行环境报的通用是/否信号（不是所有执行环境都有——DSH 恒 `None`，只报
/// `error_code`；Claude Code 的 `is_error` 是这种）；`error_code` 是原因级信号
/// （DSH 报这个）。两个字段哪个有值都算「有失败信号」——两者都缺时才是真的
/// 「不知道」，不能因为其中一个字段是这个执行环境的空档就冒充没失败。
fn tool_result_status(failed: Option<bool>, error_code: &Option<String>) -> Option<TraceStatus> {
    if error_code.is_some() || failed == Some(true) {
        return Some(TraceStatus::Error);
    }
    match failed {
        Some(false) => Some(TraceStatus::Ok),
        _ => None,
    }
}

fn turn_candidates(session: &CanonicalSession) -> Vec<Candidate> {
    session
        .turns
        .entries
        .iter()
        .map(|e: &TimelineEntry<_>| {
            let obs = &e.observation;
            let mut values = BTreeMap::new();
            values.insert("tool_call_count".to_string(), obs.sig.len() as f64);
            Candidate {
                seq: e.seq,
                timeline_priority: 0, // turns 先于同 seq 的 tool_call
                entry_ordinal: e.ordinal,
                native: format!("turn-{}", obs.turn),
                node_type: TraceNodeType::AssistantTurn,
                started_at_ms: entry_ms(e.time),
                ended_at_ms: entry_ms(obs.end_time),
                status: turn_status(&obs.end_reason_kind),
                provenance: e.provenance,
                values,
                metadata: json!({
                    "end_error_code": obs.end_error_code,
                }),
                turn_no: Some(obs.turn),
                is_turn_root: true,
            }
        })
        .collect()
}

fn tool_call_candidates(session: &CanonicalSession) -> Vec<Candidate> {
    // call_id -> 对应的 tool_result entry（同 call_id 理论上只有一个 result；
    // 真机若出现重复，取第一个——不是本函数要检测的异常，交给行为规则层）。
    let mut result_by_call: BTreeMap<&str, &TimelineEntry<_>> = BTreeMap::new();
    for r in &session.tool_results.entries {
        if let Some(cid) = r.call_id.as_deref() {
            result_by_call.entry(cid).or_insert(r);
        }
    }

    session
        .tool_calls
        .entries
        .iter()
        .enumerate()
        .map(|(idx, e): (usize, &TimelineEntry<_>)| {
            let obs = &e.observation;
            let matched_result = e.call_id.as_deref().and_then(|cid| result_by_call.get(cid));
            let (ended_at_ms, status) = match matched_result {
                Some(r) => (
                    entry_ms(r.time),
                    tool_result_status(r.observation.failed, &r.observation.error_code),
                ),
                None => (None, None),
            };
            // 无 call_id 时的合成 fallback：只用于图内去重与展示定位，**不是
            // join 键**（spec §2.1「跨 scope join 只走 native」的 native 指
            // 执行环境原生 id；合成 id 永不参与跨 scope 关联）。
            let native = e.call_id.clone().unwrap_or_else(|| {
                format!(
                    "tool-call-seq-{}-{idx}",
                    e.seq.map_or_else(|| "none".to_string(), |s| s.to_string())
                )
            });
            Candidate {
                seq: e.seq,
                timeline_priority: 1,
                entry_ordinal: e.ordinal,
                native,
                node_type: TraceNodeType::ToolCall,
                started_at_ms: entry_ms(e.time),
                ended_at_ms,
                status,
                provenance: e.provenance,
                values: BTreeMap::new(),
                metadata: json!({"name": obs.name}),
                turn_no: e.turn,
                is_turn_root: false,
            }
        })
        .collect()
}

/// spec §7 门槛 6：`(scope, ordinal)` 才是权威顺序，`started_at_ms` 只用于
/// 展示。排序键 = `(seq 是否缺失, seq 值, timeline_priority, entry_ordinal)`——
/// 全部来自输入已有的字段，不引入 mtime / 数组扫描顺序。
fn sort_candidates(mut cands: Vec<Candidate>) -> Vec<Candidate> {
    cands.sort_by(|a, b| {
        let a_key = (
            a.seq.is_none(),
            a.seq.unwrap_or(i64::MAX),
            a.timeline_priority,
            a.entry_ordinal,
        );
        let b_key = (
            b.seq.is_none(),
            b.seq.unwrap_or(i64::MAX),
            b.timeline_priority,
            b.entry_ordinal,
        );
        a_key.cmp(&b_key)
    });
    cands
}

/// `CanonicalSession` → `TraceGraph`（spec §2.1）。`session_key` 由调用方提供
/// ——`CanonicalSession::SessionMeta` 不携带 `source_profile`/`machine_namespace`
/// （那是 ingest 层的 `SessionKey` 四元组的另外两段，`trace_service` 从 SQL
/// 会话行读得到，纯函数层不该假装自己知道）。
pub fn build_trace_graph(session: &CanonicalSession, session_key: SessionKey) -> TraceGraph {
    let turns = turn_candidates(session);
    let tool_calls = tool_call_candidates(session);

    let mut all: Vec<Candidate> = Vec::with_capacity(turns.len() + tool_calls.len());
    all.extend(turns);
    all.extend(tool_calls);
    let sorted = sort_candidates(all);

    // 先建 node_id + turn_no -> node_id 映射（turn 节点），再回填 tool_call
    // 的 parent_node_id——两趟遍历是因为 parent 必须引用已经算好 node_id 的
    // turn 节点，顺序不可颠倒。
    let harness_id = session.meta.harness_id;
    let mut nodes: Vec<TraceNode> = Vec::with_capacity(sorted.len());
    let mut turn_node_id_by_no: BTreeMap<i64, String> = BTreeMap::new();

    for (ordinal, c) in sorted.iter().enumerate() {
        let node_id = stable_id(&json!({
            "harness": harness_id,
            "session_key": session_key.to_json(),
            "scope": "main",
            "ordinal": ordinal as u64,
            "native": c.native,
            "node_type": c.node_type.as_str(),
        }));
        if c.is_turn_root {
            if let Some(t) = c.turn_no {
                turn_node_id_by_no
                    .entry(t)
                    .or_insert_with(|| node_id.clone());
            }
        }
        nodes.push(TraceNode {
            node_id,
            scope: "main".to_string(),
            ordinal: ordinal as u64,
            native: c.native.clone(),
            node_type: c.node_type,
            fact_id: String::new(),
            // canonical timeline 本身就是非用量节点的可重放证据；值是 opaque
            // 坐标而非执行环境原生 id，避免把 native id 当跨节点 join 键泄露出去。
            evidence_ref: format!(
                "ce1-{}",
                stable_id(&json!({
                    "harness": harness_id,
                    "session_key": session_key.to_json(),
                    "scope": "main",
                    "ordinal": ordinal,
                    "native": c.native,
                    "node_type": c.node_type.as_str(),
                }))
            ),
            parent_node_id: None, // 第二趟回填
            branch_state: BranchState::Live,
            started_at_ms: c.started_at_ms,
            ended_at_ms: c.ended_at_ms,
            status: c.status,
            provenance: c.provenance,
            values: c.values.clone(),
            metadata: c.metadata.clone(),
        });
    }

    let mut missing_parent: u32 = 0;
    let mut edges: Vec<TraceEdge> = Vec::new();
    for (i, c) in sorted.iter().enumerate() {
        if c.is_turn_root {
            continue; // turn 节点本身无 parent，不是「期望有但缺」
        }
        let Some(turn_no) = c.turn_no else {
            continue; // 未归属任何 turn——按设计如此，不是缺失（TurnObservation 文档同款）
        };
        match turn_node_id_by_no.get(&turn_no) {
            Some(parent_id) => {
                nodes[i].parent_node_id = Some(parent_id.clone());
                let edge_id = stable_id(&json!({
                    "from": parent_id, "to": nodes[i].node_id, "edge_type": "control_flow",
                }));
                edges.push(TraceEdge {
                    edge_id,
                    from_node_id: parent_id.clone(),
                    to_node_id: nodes[i].node_id.clone(),
                    fact_id: String::new(),
                    // edge 的依据是 child canonical event；它可由同一输入重放。
                    evidence_ref: nodes[i].evidence_ref.clone(),
                    edge_type: TraceEdgeType::ControlFlow,
                    provenance: nodes[i].provenance,
                });
            }
            None => {
                // turn 号在事件流里出现过，但没有对应的 turn 节点——真实的
                // 解析失败，不是「不归任何 turn」，必须计入 coverage。
                missing_parent += 1;
            }
        }
    }

    // spec §2.1：missing_time = started_at_ms **或** ended_at_ms 缺失（一个节点
    // 最多计 1）。不能写成 AND——只有起止都缺才计会漏报「有开始没结束」的
    // 未闭合节点，恰好是诚实性要浮出来的那种（review P1 修正）。
    let missing_time = nodes
        .iter()
        .filter(|n| n.started_at_ms.is_none() || n.ended_at_ms.is_none())
        .count() as u32;
    let missing_status = nodes.iter().filter(|n| n.status.is_none()).count() as u32;
    let unmetered_nodes = nodes
        .iter()
        .filter(|n| !matches!(n.branch_state, BranchState::Live))
        .count() as u32;

    let coverage = TraceCoverage {
        missing_parent,
        missing_time,
        missing_status,
        unmetered_nodes,
        total_nodes: nodes.len() as u32,
        total_edges: edges.len() as u32,
    };

    let graph_id = stable_id(&json!({
        "kind": "trace_graph", "harness": harness_id, "session_key": session_key.to_json(),
    }));
    let fingerprint_seed: Vec<Value> = nodes
        .iter()
        .map(|n| json!([n.native, n.ordinal, n.node_type.as_str()]))
        .collect();
    let input_fingerprint = stable_id(&Value::Array(fingerprint_seed));

    TraceGraph {
        schema_version: TRACE_GRAPH_SCHEMA_VERSION,
        graph_id,
        session_key,
        task_id: None, // spec §2.1.1 三分法：图级别目前没有信号来源（见 trace_graph.rs 头注）
        nodes,
        edges,
        coverage,
        metrics: json!({
            "model_invocation_count": null,
            "token_total": null,
            "tool_call_count": session.tool_calls.entries.len(),
            "failed_tool_call_count": null,
            "known_tool_duration_ms": null,
            "cost_minor": null,
        }),
        input_fingerprint,
    }
}

// 单测（含用 `agent_vitals_harnesses::dsh_evidence::build_dsh_evidence` 造真实
// `CanonicalSession` fixture 的那批）搬到 `tests/trace_graph.rs`——原因与
// `tests/behavior_rules.rs` 头注同源：跨 crate 传 domain 类型的 inline lib
// test 若同时依赖 `agent-vitals-harnesses`（[dev-dependencies]），会在
// `cargo test --lib` 时撞「multiple versions of crate」，因为 harnesses crate
// 自己又反向依赖 domain。集成测试（`tests/` 下独立编译单元）不受影响。

// ────────────────────────── timeline_series 投影 ──────────────────────────

/// `TraceGraph → timeline_series`（spec §2.1.2：几何**不得新写第二份**，本函数
/// 只做数据准备——产出喂既有 `buildGeometry`
/// （`apps/desktop/src-tauri/ui/timeline.js`）的 spec 形状。形状以该文件
/// `buildGeometry` docstring 为准，不从记忆抄）：
///
/// ```js
/// spec = {
///   points: [{ ordinal, task_id?, values: { name: number|null } }],  // 按 ordinal 升序
///   events: [{ ordinal, kind, label?, severity?, targetId? }],
///   series: [{ name, label?, cumulative? }],
/// }
/// ```
///
/// 两层语义（spec §2.1.2 继承的几何不变量）：
/// - **曲线**：`AssistantTurn` 节点的 `values`——v0.10.0 只有 `tool_call_count`
///   一条序列（TraceGraph 当前唯一的量值，事实链接是诚实性边界 1）；
/// - **事件标记**：`ToolCall` 节点成为第二图层——曲线可抽稀、事件**永不**
///   参与（`eventsIn === eventsOut` 由几何层钉着）。
///
/// `linearization` 是投影参数不是图属性（spec §2.1.1）——v0.10.0 的图只装得下
/// 一条已选定路径（诚实性边界 2），所以 `AllRecorded` 在本函数**报错**而不是
/// 静默按 LeafPath 画：有参数没数据必须浮出来，这正是两态 API 的意义。
pub fn project_timeline_series(
    graph: &TraceGraph,
    linearization: crate::contracts::evidence::Linearization,
) -> Result<Value, &'static str> {
    use crate::contracts::evidence::Linearization;
    if matches!(linearization, Linearization::AllRecorded) {
        // v0.10.0 的 CanonicalSession 只承载 adapter 选定的一条路径；请求
        // AllRecorded 是在向一个不存在的数据面要数据——诚实拒绝，不是降级画。
        return Err(
            "linearization=AllRecorded is not available: the TraceGraph carries only the \
             adapter-selected path (branch_state is Live for every node; abandoned branches \
             have no signal source yet)",
        );
    }

    // buildGeometry 的 docstring 钉着事件定位规则：「定位不到 ordinal 的事件 →
    // 跳过（不画在猜的位置）」——事件要被画出来，其 ordinal 必须命中某个 point。
    // 所以事件锚定到**父 turn 的 point ordinal**（曲线样本），不是 tool_call
    // 自己的节点 ordinal（那不是曲线样本，事件会被几何层静默丢弃）。
    let point_ordinal_by_node: std::collections::HashMap<&str, u64> = graph
        .nodes
        .iter()
        .filter(|n| n.node_type == TraceNodeType::AssistantTurn)
        .map(|n| (n.node_id.as_str(), n.ordinal))
        .collect();

    let mut points: Vec<Value> = Vec::new();
    let mut events: Vec<Value> = Vec::new();
    // 父 turn 解析不了的 tool_call：不能进 `events`（会被几何层丢掉 = 静默
    // 失踪，违反 eventsIn===eventsOut 的输入端责任），也不能编一个位置。落到
    // 显式的 `unplaced_events` 计数——unaccounted sentinel 同一形状：不完整
    // 必须可见。
    let mut unplaced_events: u32 = 0;

    for n in &graph.nodes {
        match n.node_type {
            TraceNodeType::AssistantTurn => {
                // values 缺键不出现——tool_call_count 恒有（构建函数保证），
                // 这里仍然按"有才放"写，防未来加键时把缺键静默成 0。
                let mut values = serde_json::Map::new();
                for (k, v) in &n.values {
                    values.insert(k.clone(), json!(v));
                }
                points.push(json!({
                    "ordinal": n.ordinal,
                    "task_id": n.native,   // turn 节点的 native 就是 turn-N（三分法：task=turn）
                    "values": Value::Object(values),
                }));
            }
            TraceNodeType::ToolCall => {
                let anchor = n
                    .parent_node_id
                    .as_deref()
                    .and_then(|pid| point_ordinal_by_node.get(pid));
                let Some(&ordinal) = anchor else {
                    unplaced_events += 1;
                    continue;
                };
                let is_error = matches!(n.status, Some(TraceStatus::Error));
                let name = n.metadata.get("name").and_then(Value::as_str).unwrap_or("");
                events.push(json!({
                    "ordinal": ordinal,
                    "kind": if is_error { "risk" } else { "tool" },
                    "label": name,
                    "severity": if is_error { "critical" } else { "info" },
                    "targetId": n.node_id,
                }));
            }
            _ => {}
        }
    }

    // series 清单从实际点里收（与 buildGeometry 的 seriesNames 缺省路径一致，
    // 但显式声明是形状契约——消费方不必反推）。BTreeSet 保键序确定。
    let mut series_names: std::collections::BTreeSet<&str> = Default::default();
    for p in &points {
        if let Some(obj) = p.get("values").and_then(Value::as_object) {
            for k in obj.keys() {
                series_names.insert(k.as_str());
            }
        }
    }
    let series: Vec<Value> = series_names
        .iter()
        .map(|name| json!({ "name": name, "cumulative": false }))
        .collect();

    Ok(json!({
        "linearization": "leaf",           // 显式声明（spec §2.1.1：不是默认值，是选择）
        "points": points,                  // 图节点已按 (scope, ordinal) 排序，直接继承
        "events": events,
        "series": series,
        // 未能锚定到任何曲线样本的 tool_call 数——消费方必须展示（unaccounted
        // sentinel 语义：不完整可见，绝不静默）。
        "unplaced_events": unplaced_events,
    }))
}

#[cfg(test)]
mod tests_project_timeline_series {
    use super::*;

    /// AllRecorded 必须报错而不是静默按 leaf 画——v0.10.0 图里只有一条路径，
    /// 骗用户"画了全部记录"就是 §8「不伪造」红线的呈现侧版本。
    #[test]
    fn all_recorded_is_rejected_not_silently_drawn_as_leaf() {
        let graph = TraceGraph {
            schema_version: TRACE_GRAPH_SCHEMA_VERSION,
            graph_id: "g".into(),
            session_key: SessionKey::new("dsh", "s", "p", "ns"),
            task_id: None,
            nodes: vec![],
            edges: vec![],
            coverage: TraceCoverage::default(),
            metrics: json!({}),
            input_fingerprint: "f".into(),
        };
        assert!(project_timeline_series(
            &graph,
            crate::contracts::evidence::Linearization::AllRecorded
        )
        .is_err());
    }

    #[test]
    fn empty_graph_projects_to_empty_spec_with_explicit_leaf() {
        let graph = TraceGraph {
            schema_version: TRACE_GRAPH_SCHEMA_VERSION,
            graph_id: "g".into(),
            session_key: SessionKey::new("dsh", "s", "p", "ns"),
            task_id: None,
            nodes: vec![],
            edges: vec![],
            coverage: TraceCoverage::default(),
            metrics: json!({}),
            input_fingerprint: "f".into(),
        };
        let v =
            project_timeline_series(&graph, crate::contracts::evidence::Linearization::LeafPath)
                .unwrap();
        assert_eq!(v["linearization"], json!("leaf"));
        assert_eq!(v["points"], json!([]));
        assert_eq!(v["events"], json!([]));
        assert_eq!(v["series"], json!([]));
    }

    #[test]
    fn tool_call_nodes_become_events_never_points() {
        // 两层语义的钉子：事件层一个不丢（几何层 eventsIn===eventsOut 的输入端
        // 责任在这），同时事件节点不出现在 points 里冒充曲线样本。
        let mut values = std::collections::BTreeMap::new();
        values.insert("tool_call_count".to_string(), 3.0);
        let turn_node = TraceNode {
            node_id: "t1".into(),
            scope: "main".into(),
            ordinal: 0,
            native: "turn-1".into(),
            node_type: TraceNodeType::AssistantTurn,
            fact_id: String::new(),
            evidence_ref: String::new(),
            parent_node_id: None,
            branch_state: BranchState::Live,
            started_at_ms: Some(1000),
            ended_at_ms: Some(1001),
            status: Some(TraceStatus::Ok),
            provenance: Provenance::Measured,
            values,
            metadata: json!({}),
        };
        let call_node = TraceNode {
            node_id: "c1".into(),
            scope: "main".into(),
            ordinal: 1,
            native: "call_1".into(),
            node_type: TraceNodeType::ToolCall,
            fact_id: String::new(),
            evidence_ref: String::new(),
            parent_node_id: Some("t1".into()),
            branch_state: BranchState::Live,
            started_at_ms: Some(1001),
            ended_at_ms: None,
            status: None,
            provenance: Provenance::Measured,
            values: std::collections::BTreeMap::new(),
            metadata: json!({"name": "read"}),
        };
        let graph = TraceGraph {
            schema_version: TRACE_GRAPH_SCHEMA_VERSION,
            graph_id: "g".into(),
            session_key: SessionKey::new("dsh", "s", "p", "ns"),
            task_id: None,
            nodes: vec![turn_node, call_node],
            edges: vec![],
            coverage: TraceCoverage::default(),
            metrics: json!({}),
            input_fingerprint: "f".into(),
        };
        let v =
            project_timeline_series(&graph, crate::contracts::evidence::Linearization::LeafPath)
                .unwrap();
        let points = v["points"].as_array().unwrap();
        let events = v["events"].as_array().unwrap();
        assert_eq!(points.len(), 1, "只有 turn 节点进曲线层");
        assert_eq!(points[0]["values"]["tool_call_count"], json!(3.0));
        assert_eq!(points[0]["task_id"], json!("turn-1"));
        assert_eq!(events.len(), 1, "tool_call 一个不丢");
        assert_eq!(
            events[0]["ordinal"],
            json!(0),
            "事件锚定到父 turn 的 point ordinal——不是自己的节点 ordinal"
        );
        assert_eq!(events[0]["kind"], json!("tool")); // status=None 不是 error，不冒充风险
        assert_eq!(events[0]["label"], json!("read"));
        assert_eq!(events[0]["targetId"], json!("c1"));
        assert_eq!(
            v["series"],
            json!([{"name": "tool_call_count", "cumulative": false}])
        );
        assert_eq!(v["unplaced_events"], json!(0));
    }

    #[test]
    fn error_status_tool_call_is_marked_risk_not_tool() {
        // 有父 turn（可锚定）的 error tool_call 才会进 events——orphan 走
        // unplaced（另一条测试钉）。这里要测的是 kind/severity 的标记。
        let turn_node = TraceNode {
            node_id: "t1".into(),
            scope: "main".into(),
            ordinal: 0,
            native: "turn-1".into(),
            node_type: TraceNodeType::AssistantTurn,
            fact_id: String::new(),
            evidence_ref: String::new(),
            parent_node_id: None,
            branch_state: BranchState::Live,
            started_at_ms: Some(1000),
            ended_at_ms: None,
            status: None,
            provenance: Provenance::Measured,
            values: std::collections::BTreeMap::new(),
            metadata: json!({}),
        };
        let call_node = TraceNode {
            node_id: "c1".into(),
            scope: "main".into(),
            ordinal: 1,
            native: "call_1".into(),
            node_type: TraceNodeType::ToolCall,
            fact_id: String::new(),
            evidence_ref: String::new(),
            parent_node_id: Some("t1".into()),
            branch_state: BranchState::Live,
            started_at_ms: Some(1001),
            ended_at_ms: None,
            status: Some(TraceStatus::Error),
            provenance: Provenance::Measured,
            values: std::collections::BTreeMap::new(),
            metadata: json!({"name": "bash"}),
        };
        let graph = TraceGraph {
            schema_version: TRACE_GRAPH_SCHEMA_VERSION,
            graph_id: "g".into(),
            session_key: SessionKey::new("dsh", "s", "p", "ns"),
            task_id: None,
            nodes: vec![turn_node, call_node],
            edges: vec![],
            coverage: TraceCoverage::default(),
            metrics: json!({}),
            input_fingerprint: "f".into(),
        };
        let v =
            project_timeline_series(&graph, crate::contracts::evidence::Linearization::LeafPath)
                .unwrap();
        let events = v["events"].as_array().unwrap();
        assert_eq!(events[0]["kind"], json!("risk"));
        assert_eq!(events[0]["severity"], json!("critical"));
    }
}

#[cfg(test)]
mod tests_project_timeline_series_unplaced {
    use super::*;

    /// 父 turn 解析不了的 tool_call 不能静默消失——不进 events（会被几何层
    /// 丢弃 = 违反 eventsIn===eventsOut 的输入端责任），进 unplaced_events
    /// 计数。unaccounted sentinel 的呈现侧镜像。
    #[test]
    fn orphan_tool_call_goes_to_unplaced_count_not_silently_dropped() {
        let call_node = TraceNode {
            node_id: "c1".into(),
            scope: "main".into(),
            ordinal: 0,
            native: "call_1".into(),
            node_type: TraceNodeType::ToolCall,
            fact_id: String::new(),
            evidence_ref: String::new(),
            parent_node_id: None, // 无父节点 = 无法锚定
            branch_state: BranchState::Live,
            started_at_ms: Some(1001),
            ended_at_ms: None,
            status: Some(TraceStatus::Error),
            provenance: Provenance::Measured,
            values: std::collections::BTreeMap::new(),
            metadata: json!({"name": "bash"}),
        };
        let graph = TraceGraph {
            schema_version: TRACE_GRAPH_SCHEMA_VERSION,
            graph_id: "g".into(),
            session_key: SessionKey::new("dsh", "s", "p", "ns"),
            task_id: None,
            nodes: vec![call_node],
            edges: vec![],
            coverage: TraceCoverage::default(),
            metrics: json!({}),
            input_fingerprint: "f".into(),
        };
        let v =
            project_timeline_series(&graph, crate::contracts::evidence::Linearization::LeafPath)
                .unwrap();
        assert_eq!(
            v["events"].as_array().unwrap().len(),
            0,
            "不进 events——锚不了位置就绝不编位置"
        );
        assert_eq!(v["unplaced_events"], json!(1), "但计数必须可见，绝不静默");
    }
}
