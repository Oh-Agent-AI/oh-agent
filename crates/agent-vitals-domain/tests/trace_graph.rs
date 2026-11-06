//! `domain::trace::build_trace_graph` 的 canonical-fixture 测试——与
//! `tests/behavior_rules.rs` 同一个理由迁到集成测试：经
//! `agent_vitals_harnesses::dsh_evidence::build_dsh_evidence` 造 `CanonicalSession`
//! fixture，跨 crate 传 domain 类型的 inline lib test 会撞
//! `multiple versions of crate`。

use agent_vitals_domain::contracts::session_key::SessionKey;
use agent_vitals_domain::contracts::trace_graph::{BranchState, TraceEdgeType, TraceNodeType, TraceStatus};
use agent_vitals_domain::domain::trace::build_trace_graph;
use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
use agent_vitals_domain::evidence::CanonicalSession;
use serde_json::{json, Value};

fn tool_call(seq: i64, time: i64, name: &str, call_id: &str, turn: i64) -> Value {
    json!({
        "type": "tool/call", "seq": seq, "time": time,
        "data": {"name": name, "arguments": "{}", "callId": call_id, "turn": turn},
    })
}

fn tool_result(seq: i64, time: i64, call_id: &str, error_code: Option<&str>) -> Value {
    // DSH 的 `result_code` 读 `data.error.code`（嵌套对象），不是 `data.error`
    // 本身——见 `harnesses/dsh/sessions/evidence.rs::result_code`。
    json!({
        "type": "tool/result", "seq": seq, "time": time,
        "data": {"callId": call_id, "error": error_code.map(|c| json!({"code": c}))},
    })
}

fn turn_start(seq: i64, time: i64, turn: i64) -> Value {
    json!({"type": "turn/start", "seq": seq, "time": time, "data": {"turn": turn}})
}

fn turn_end(seq: i64, time: i64, turn: i64, reason: &str) -> Value {
    json!({
        "type": "turn/end", "seq": seq, "time": time,
        "data": {"turn": turn, "reason": {"kind": reason}},
    })
}

fn synth_session(events: Vec<Value>) -> CanonicalSession {
    build_dsh_evidence(events, Vec::new(), Some("/tmp/proj".to_string()), "s1".to_string()).canonical
}

fn key() -> SessionKey {
    SessionKey::new("dsh", "s1", "default", "ns-test")
}

/// 量级护栏：遍历一段 JSON，凡**纪元类** `_ms` 键的值都必须 `>= 1e11`。
///
/// **为什么需要它**：本仓已经出过两次同类缺陷——`issue_instances.opened_at_ms`
/// 与 `TraceNode.started_at_ms`——两次形状完全一样：**值看着像时间戳，其实差
/// 1000 倍**（秒被当毫秒）。精确值断言挡不住它：夹具用的合成小值（1000/1001）
/// 本身就不真实，所以秒与毫秒在测试里永远显不出差别。**只有量级断言能自动挡住。**
///
/// 时长类键（`*_duration_ms` / `elapsed` / `latency`）排除——`duration_ms = 12`
/// 是对的，不是漂移。`<= 0` 的值跳过（`None`/零值不表达时间）。
fn assert_epoch_ms_magnitude(value: &Value, path: &str) {
    const MIN_EPOCH_MS: i64 = 100_000_000_000; // 1e11：秒与毫秒的分界
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let child = format!("{path}.{k}");
                let is_epoch = k.ends_with("_ms")
                    && !k.contains("duration")
                    && !k.contains("elapsed")
                    && !k.contains("latency")
                    && !k.contains("window_minutes");
                if is_epoch {
                    if let Some(n) = v.as_i64() {
                        if n > 0 {
                            assert!(
                                n >= MIN_EPOCH_MS,
                                "{child} = {n} 是秒级量级；`_ms` 契约要求毫秒（>= 1e11）"
                            );
                        }
                    }
                }
                assert_epoch_ms_magnitude(v, &child);
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                assert_epoch_ms_magnitude(v, &format!("{path}[{i}]"));
            }
        }
        _ => {}
    }
}

/// 护栏自检：**先证明它会响**。一个只报绿的护栏等于没有护栏——本仓对此有
/// 明确纪律（"干净哨兵只有在它上层的每层都宽松时才有意义"）。
#[test]
fn epoch_ms_guardrail_fires_on_seconds_and_stays_quiet_on_milliseconds() {
    // 秒级量级 → 必须 panic
    let seconds = json!({"started_at_ms": 1_788_449_204i64});
    let fired = std::panic::catch_unwind(|| assert_epoch_ms_magnitude(&seconds, "probe")).is_err();
    assert!(fired, "护栏必须对秒级值报警，否则它挡不住任何东西");

    // 毫秒 → 安静
    assert_epoch_ms_magnitude(&json!({"started_at_ms": 1_788_449_204_000i64}), "probe");

    // 时长键不参与判定（12ms 是合法的）
    assert_epoch_ms_magnitude(&json!({"duration_ms": 12i64, "elapsed_ms": 3i64}), "probe");

    // 嵌套结构也要走到
    let nested = json!({"a": [{"b": {"ended_at_ms": 1_788_449_204i64}}]});
    assert!(
        std::panic::catch_unwind(|| assert_epoch_ms_magnitude(&nested, "probe")).is_err(),
        "护栏必须递归进数组/对象"
    );
}

/// 端点级护栏：真实量级夹具 → 整张 TraceGraph 序列化后，所有纪元 `_ms` 值都是毫秒。
#[test]
fn serialized_trace_graph_has_no_seconds_magnitude_timestamps() {
    let base = 1_700_000_000_000i64; // 真实毫秒量级
    let g = build_trace_graph(
        &synth_session(vec![
            turn_start(1, base, 1),
            tool_call(2, base + 1, "bash", "c1", 1),
            tool_result(3, base + 2, "c1", Some("permission_denied")),
            tool_call(4, base + 3, "read", "c2", 1),
            turn_end(5, base + 4, 1, "ok"),
        ]),
        key(),
    );
    assert_epoch_ms_magnitude(&g.to_json(), "graph");
}

#[test]
fn deterministic_same_input_twice_produces_identical_graph() {
    let events = vec![
        turn_start(1, 1000, 1),
        tool_call(2, 1001, "read", "c1", 1),
        tool_result(3, 1002, "c1", None),
        turn_end(4, 1003, 1, "ok"),
    ];
    let s1 = synth_session(events.clone());
    let s2 = synth_session(events);
    let g1 = build_trace_graph(&s1, key());
    let g2 = build_trace_graph(&s2, key());
    assert_eq!(g1.to_json(), g2.to_json(), "同一输入必须产出字节相同的图");
    assert_eq!(g1.graph_id, g2.graph_id);
    assert_eq!(g1.input_fingerprint, g2.input_fingerprint);
}

#[test]
fn nodes_are_sorted_by_seq_not_by_declaration_or_time() {
    // turn/start seq=1，但把 tool_call 的 seq 故意设得比 turn 大，验证排序
    // 跟着 seq 走，不是「turns 先于 tool_calls」这种硬编码分组。
    let events = vec![
        turn_start(1, 1000, 1),
        tool_call(5, 999, "read", "c1", 1), // time 比 turn 早，但 seq 更大
        tool_result(6, 1002, "c1", None),
        turn_end(7, 1003, 1, "ok"),
    ];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    // 权威顺序按 (scope, ordinal)，ordinal 源自 seq：turn(seq=1) 排第一，
    // tool_call(seq=5) 排第二——即便 tool_call 的 started_at_ms 更早。
    assert_eq!(g.nodes[0].node_type, TraceNodeType::AssistantTurn);
    assert_eq!(g.nodes[0].ordinal, 0);
    assert_eq!(g.nodes[1].node_type, TraceNodeType::ToolCall);
    assert_eq!(g.nodes[1].ordinal, 1);
    assert!(g.nodes[0].started_at_ms.unwrap() > g.nodes[1].started_at_ms.unwrap());
}

#[test]
fn tool_call_gets_turn_as_parent_and_a_control_flow_edge() {
    let events = vec![
        turn_start(1, 1000, 1),
        tool_call(2, 1001, "read", "c1", 1),
        tool_result(3, 1002, "c1", None),
        turn_end(4, 1003, 1, "ok"),
    ];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    let turn_node = g.nodes.iter().find(|n| n.node_type == TraceNodeType::AssistantTurn).unwrap();
    let call_node = g.nodes.iter().find(|n| n.node_type == TraceNodeType::ToolCall).unwrap();
    assert_eq!(call_node.parent_node_id.as_deref(), Some(turn_node.node_id.as_str()));
    assert_eq!(g.edges.len(), 1);
    assert_eq!(g.edges[0].from_node_id, turn_node.node_id);
    assert_eq!(g.edges[0].to_node_id, call_node.node_id);
    assert_eq!(g.edges[0].edge_type, TraceEdgeType::ControlFlow);
    assert_eq!(g.coverage.missing_parent, 0);
}

#[test]
fn tool_call_with_unresolvable_turn_counts_as_missing_parent_not_zero() {
    // turn=99 从未出现过 turn/start——「有 turn 号但解析不出节点」是真实
    // 缺失，必须计入 missing_parent，不能悄悄挂 None 假装没发生。
    let events = vec![
        tool_call(1, 1000, "read", "c1", 99),
        tool_result(2, 1001, "c1", None),
    ];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    let call_node = g.nodes.iter().find(|n| n.node_type == TraceNodeType::ToolCall).unwrap();
    assert_eq!(call_node.parent_node_id, None);
    assert_eq!(g.coverage.missing_parent, 1);
    assert_eq!(g.edges.len(), 0);
}

#[test]
fn tool_result_error_propagates_to_tool_call_node_status() {
    // 时间用**真实量级**的毫秒（1.7e12），不是 1000/1001 这类合成小值。
    // 合成小值落在 `util::to_epoch_ms` 的秒/毫秒阈值（1e11）之下，会被当成秒
    // 放大 1000 倍——本测试断言的是**状态传播**，不该被单位归一干扰。
    // 顺带：夹具不真实正是这条单位缺陷长期没被发现的原因。
    let base = 1_700_000_000_000i64;
    let events = vec![
        turn_start(1, base, 1),
        tool_call(2, base + 1, "bash", "c1", 1),
        tool_result(3, base + 2, "c1", Some("permission_denied")),
        turn_end(4, base + 3, 1, "ok"),
    ];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    let call_node = g.nodes.iter().find(|n| n.node_type == TraceNodeType::ToolCall).unwrap();
    assert_eq!(call_node.status, Some(TraceStatus::Error));
    assert_eq!(call_node.ended_at_ms, Some(base + 2));
    assert_eq!(g.coverage.missing_status, 0);
}

/// `TraceNode.started_at_ms` / `ended_at_ms` 的契约是**毫秒**，而
/// `TimelineEntry.time` 的单位由各执行环境适配器各自决定——Claude 的构造器明写
/// 「`parse_iso` → 秒」，Codex 与 DSH 是毫秒。真机实测（2026-09-13）：
/// claude-code 节点 `1788449204` 当毫秒读是 1970-01-21，codex 节点
/// `1789132709000` 当毫秒读才是对的。
///
/// 本测试钉住边界归一：**秒级输入经 `build_trace_graph` 出来必须是毫秒**，
/// 且与毫秒级输入落在同一个月内（不是相差 1000 倍）。
#[test]
fn trace_node_timestamps_are_normalized_to_milliseconds() {
    let seconds = 1_788_449_204i64; // Claude Code：parse_iso → 秒
    let millis = 1_789_132_709_000i64; // Codex / DSH：已是毫秒

    let gs = build_trace_graph(
        &synth_session(vec![
            turn_start(1, seconds, 1),
            tool_call(2, seconds + 1, "bash", "c1", 1),
            tool_result(3, seconds + 2, "c1", None),
            turn_end(4, seconds + 3, 1, "ok"),
        ]),
        key(),
    );
    let gm = build_trace_graph(
        &synth_session(vec![
            turn_start(1, millis, 1),
            tool_call(2, millis + 1, "bash", "c1", 1),
            tool_result(3, millis + 2, "c1", None),
            turn_end(4, millis + 3, 1, "ok"),
        ]),
        key(),
    );

    let call_s = gs.nodes.iter().find(|n| n.node_type == TraceNodeType::ToolCall).unwrap();
    let call_m = gm.nodes.iter().find(|n| n.node_type == TraceNodeType::ToolCall).unwrap();

    // 秒级输入被放大到毫秒——不是原样透传
    assert_eq!(call_s.started_at_ms, Some((seconds + 1) * 1000));
    // 毫秒级输入原样通过
    assert_eq!(call_m.started_at_ms, Some(millis + 1));

    // 两者归一后同量级：任何按 `_ms` 字段分桶的消费方都不能把它们放进 1970
    let a = call_s.started_at_ms.unwrap();
    let b = call_m.started_at_ms.unwrap();
    assert!((b - a).abs() < 90 * 86_400_000, "归一后应落在同一季度内，实际差 {}ms", (b - a).abs());
}

#[test]
fn tool_call_without_matching_result_has_no_status_and_counts_as_missing() {
    // turn_end 补全，让 turn 节点自己有 status——这条测试只想验证 tool_call
    // 缺 result 时的行为，不该被「turn 也没结束」这个无关缺失干扰断言。
    let events = vec![
        turn_start(1, 1000, 1),
        tool_call(2, 1001, "bash", "c1", 1),
        turn_end(3, 1002, 1, "ok"),
    ];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    let call_node = g.nodes.iter().find(|n| n.node_type == TraceNodeType::ToolCall).unwrap();
    assert_eq!(call_node.status, None, "没有 tool_result 时不得冒充 ok/error");
    assert_eq!(g.coverage.missing_status, 1, "只有 tool_call 这一个节点缺 status");
}

#[test]
fn turn_end_error_reason_sets_error_status() {
    let events = vec![turn_start(1, 1000, 1), turn_end(2, 1001, 1, "error")];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    let turn_node = g.nodes.iter().find(|n| n.node_type == TraceNodeType::AssistantTurn).unwrap();
    assert_eq!(turn_node.status, Some(TraceStatus::Error));
}

#[test]
fn empty_session_yields_empty_graph_not_a_crash() {
    let session = synth_session(vec![]);
    let g = build_trace_graph(&session, key());
    assert!(g.nodes.is_empty());
    assert!(g.edges.is_empty());
    assert_eq!(g.coverage.total_nodes, 0);
    assert_eq!(g.coverage.missing_parent, 0);
}

#[test]
fn values_map_is_deterministic_and_carries_tool_call_count() {
    let events = vec![
        turn_start(1, 1000, 1),
        tool_call(2, 1001, "read", "c1", 1),
        tool_result(3, 1002, "c1", None),
        tool_call(4, 1003, "write", "c2", 1),
        tool_result(5, 1004, "c2", None),
        turn_end(6, 1005, 1, "ok"),
    ];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    let turn_node = g.nodes.iter().find(|n| n.node_type == TraceNodeType::AssistantTurn).unwrap();
    assert_eq!(turn_node.values.get("tool_call_count"), Some(&2.0));
}

#[test]
fn branch_state_defaults_live_and_unmetered_nodes_is_zero_for_v0_10_0() {
    // 诚实性边界 2（trace_graph.rs 头注）：CanonicalSession 目前只装得下
    // 一条已选定路径，v0.10.0 尚无信号区分废弃分支，所以恒 Live——这条测试
    // 钉住「不伪造 Abandoned」，同时钉住这不是遗漏（有意为之）。
    let events = vec![turn_start(1, 1000, 1), turn_end(2, 1001, 1, "ok")];
    let session = synth_session(events);
    let g = build_trace_graph(&session, key());
    assert!(g.nodes.iter().all(|n| matches!(n.branch_state, BranchState::Live)));
    assert_eq!(g.coverage.unmetered_nodes, 0);
}

#[test]
fn node_id_is_stable_across_two_builds_of_the_same_session() {
    let events = vec![turn_start(1, 1000, 1), tool_call(2, 1001, "read", "c1", 1)];
    let session = synth_session(events);
    let g1 = build_trace_graph(&session, key());
    let g2 = build_trace_graph(&session, key());
    for (a, b) in g1.nodes.iter().zip(g2.nodes.iter()) {
        assert_eq!(a.node_id, b.node_id, "node_id 必须是同输入下的稳定哈希");
    }
}

#[test]
fn different_session_key_changes_node_id_but_not_graph_shape() {
    // node_id 的种子含 session_key（防止跨会话撞键），但图的结构（节点数/
    // 排序/coverage）不该随 session_key 变化——只有 id 字符串本身会变。
    let events = vec![turn_start(1, 1000, 1), tool_call(2, 1001, "read", "c1", 1)];
    let session = synth_session(events);
    let g1 = build_trace_graph(&session, key());
    let other_key = SessionKey::new("dsh", "s1", "default", "ns-OTHER");
    let g2 = build_trace_graph(&session, other_key);
    assert_eq!(g1.nodes.len(), g2.nodes.len());
    assert_ne!(g1.nodes[0].node_id, g2.nodes[0].node_id);
    assert_ne!(g1.graph_id, g2.graph_id);
}
