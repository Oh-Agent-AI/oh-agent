//! 执行时长审计（Duration Audit，`docs/audit-dashboard/DURATION_AUDIT_BACKLOG.md`
//! D1）—— 把 `skill.rs` 里"`callId` 配对 `tool/call`↔`tool/result`、算
//! `duration_ms`"这段逻辑推广到所有工具，不再局限于 `name=="skill"`。
//!
//! 与 `skill.rs` 的两点不同：
//! 1. **不按工具名过滤**——这里要的是"所有工具调用花了多久"，不是某一个
//!    工具，所以没有 explicit/model_selected 两条路径，只有一条通用的
//!    `tool/call` ↔ `tool/result` 配对。
//! 2. **不解析 `arguments`**——`tool_name` 直接来自 `tool/call.data.name`，不像
//!    `skill.rs` 那样还要从 `arguments` 原始 JSON 字符串里再抠一层技能名。
//!
//! 没有 `callId` 的调用**整条跳过**——这不是"耗时未知"，是这条数据在结构上
//! 就配不了对；与"有 `callId` 但等不到 `tool/result`"（`duration_ms` 缺失、
//! `load_status` 落 `incomplete`，一起进 `missing_fields`）是两种不同性质的
//! 缺失，不能混在一起处理。
//!
//! `turn`/`step` 复用 `trajectory::coord_map`（与 `skill.rs` 同一份坐标表），
//! 不重新扫一遍 `turn/start`・`step/start` 边界。

use serde_json::{json, Value};

use crate::evidence::{Coverage, Signal};

/// `tool/result` 是否报告了失败——同 `skill.rs::tool_result_failed`，两种独立
/// 信号都要看，缺一不可：顶层 `data.error`（六码基础设施错误）与
/// `data.message.content[].isError`（工具自己报告的语义失败）。
fn tool_result_failed(data: &Value) -> bool {
    if data.get("error").is_some_and(|e| !e.is_null()) {
        return true;
    }
    data.pointer("/message/content").and_then(|v| v.as_array()).is_some_and(|items| {
        items.iter().any(|it| it.get("isError").and_then(|v| v.as_bool()) == Some(true))
    })
}

/// `(turn, step)` —— 通过 `coord_map` 顺延求出；`seq` 缺失/畸形给 `null`。
fn coords_for(seq: &Value, map: &std::collections::HashMap<i64, (Value, Value, Value)>) -> (Value, Value) {
    let (turn, step, _) = seq
        .as_i64()
        .and_then(|s| map.get(&s).cloned())
        .unwrap_or((Value::Null, Value::Null, Value::Null));
    (turn, step)
}

/// 一次 `tool/call` 等结果回填的暂存态。
struct PendingCall {
    tool_name: Option<String>,
    seq: Value,
    time: Value,
    has_result: bool,
    result_time: Value,
    failed: bool,
}

/// 事件流 → `ToolCallDuration[]`，按 `seq` 升序。所有带 `callId` 的 `tool/call`
/// 都进来，不按工具名过滤。
pub fn tool_call_durations(events: &[Value]) -> Value {
    // 只看分叉之后——同一条纪律，见 skill.rs/subagent.rs/usage.rs 模块注释。
    let events = &crate::util::post_fork(events)[..];
    let coords = crate::trajectory::coord_map(events);

    // 第一遍：记下所有 tool/call（按 callId 索引，保留发生顺序）。
    let mut order: Vec<String> = Vec::new();
    let mut by_call: std::collections::HashMap<String, PendingCall> = std::collections::HashMap::new();
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("tool/call") {
            continue;
        }
        let Some(data) = e.get("data") else { continue };
        // 没有 callId 就没法配对——结构上就配不了对，整条跳过，不是"耗时未知"
        // （那是有 callId 但等不到结果的 incomplete 状态，见模块注释）。
        let Some(call_id) = data.get("callId").and_then(|v| v.as_str()) else { continue };
        order.push(call_id.to_string());
        by_call.insert(
            call_id.to_string(),
            PendingCall {
                tool_name: data.get("name").and_then(|v| v.as_str()).map(str::to_string),
                seq: e.get("seq").cloned().unwrap_or(Value::Null),
                time: e.get("time").cloned().unwrap_or(Value::Null),
                has_result: false,
                result_time: Value::Null,
                failed: false,
            },
        );
    }
    // 第二遍：把回执配对回去——结果没到 ≠ 这次调用没发生，见模块注释。
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("tool/result") {
            continue;
        }
        let Some(cid) = e.pointer("/data/message/source/callId").and_then(|v| v.as_str()) else { continue };
        let Some(call) = by_call.get_mut(cid) else { continue };
        call.has_result = true;
        call.result_time = e.get("time").cloned().unwrap_or(Value::Null);
        call.failed = e.get("data").is_some_and(tool_result_failed);
    }

    let mut rows: Vec<Value> = Vec::new();
    for cid in order {
        let Some(call) = by_call.remove(&cid) else { continue };
        let (turn, step) = coords_for(&call.seq, &coords);

        let mut missing: Vec<&'static str> = Vec::new();
        if call.tool_name.is_none() {
            missing.push("tool_name");
        }
        if turn.is_null() {
            missing.push("turn");
        }
        if step.is_null() {
            missing.push("step");
        }

        let load_status = if !call.has_result {
            "incomplete"
        } else if call.failed {
            "failed"
        } else {
            "loaded"
        };

        let duration_ms = call
            .has_result
            .then(|| call.time.as_i64().zip(call.result_time.as_i64()))
            .flatten()
            .map(|(a, b)| b - a);
        if duration_ms.is_none() {
            missing.push("duration_ms");
        }

        rows.push(json!({
            "call_id": cid,
            "tool_name": call.tool_name.map_or(Value::Null, Value::String),
            "load_status": load_status,
            "duration_ms": duration_ms.map_or(Value::Null, |n| json!(n)),
            "seq": call.seq,
            "turn": turn,
            "step": step,
            "missing_fields": missing,
        }));
    }

    rows.sort_by_key(|r| r["seq"].as_i64().unwrap_or(i64::MAX));
    Value::Array(rows)
}

/// `turn/end.data.reason.kind`（`"completed"`/`"error"`）。缺失给 `null`——
/// 不是"正常结束"的默认值，是没有这个字段。
fn ended_reason(data: &Value) -> Value {
    data.pointer("/reason/kind").and_then(|v| v.as_str()).map_or(Value::Null, |s| json!(s))
}

struct PendingTurn {
    seq_start: Value,
    time_start: Value,
    has_end: bool,
    seq_end: Value,
    time_end: Value,
    ended_reason: Value,
}

/// `turn/start` ↔ `turn/end`，按 `data.turn` 配对 → `TurnDuration[]`，按
/// turn 升序。只有 start 没有 end（会话在这个 turn 中途结束/被截断）→
/// `duration_ms: null`，`load_status` 标 `incomplete`——不是"这个 turn 没有
/// 发生"，行照留。
pub fn turn_durations(events: &[Value]) -> Value {
    let events = &crate::util::post_fork(events)[..];

    let mut order: Vec<i64> = Vec::new();
    let mut by_turn: std::collections::HashMap<i64, PendingTurn> = std::collections::HashMap::new();
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("turn/start") {
            continue;
        }
        let Some(turn) = e.pointer("/data/turn").and_then(|v| v.as_i64()) else { continue };
        order.push(turn);
        by_turn.insert(
            turn,
            PendingTurn {
                seq_start: e.get("seq").cloned().unwrap_or(Value::Null),
                time_start: e.get("time").cloned().unwrap_or(Value::Null),
                has_end: false,
                seq_end: Value::Null,
                time_end: Value::Null,
                ended_reason: Value::Null,
            },
        );
    }
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("turn/end") {
            continue;
        }
        let Some(turn) = e.pointer("/data/turn").and_then(|v| v.as_i64()) else { continue };
        let Some(pending) = by_turn.get_mut(&turn) else { continue };
        pending.has_end = true;
        pending.seq_end = e.get("seq").cloned().unwrap_or(Value::Null);
        pending.time_end = e.get("time").cloned().unwrap_or(Value::Null);
        pending.ended_reason = e.get("data").map_or(Value::Null, ended_reason);
    }

    let mut rows: Vec<Value> = Vec::new();
    for turn in order {
        let Some(p) = by_turn.remove(&turn) else { continue };

        let mut missing: Vec<&'static str> = Vec::new();
        let duration_ms = p
            .has_end
            .then(|| p.time_start.as_i64().zip(p.time_end.as_i64()))
            .flatten()
            .map(|(a, b)| b - a);
        if duration_ms.is_none() {
            missing.push("duration_ms");
        }
        if p.ended_reason.is_null() {
            missing.push("ended_reason");
        }

        rows.push(json!({
            "turn": turn,
            "duration_ms": duration_ms.map_or(Value::Null, |n| json!(n)),
            "seq_start": p.seq_start,
            "seq_end": p.seq_end,
            "ended_reason": p.ended_reason,
            "load_status": if p.has_end { "loaded" } else { "incomplete" },
            "missing_fields": missing,
        }));
    }
    rows.sort_by_key(|r| r["turn"].as_i64().unwrap_or(i64::MAX));
    Value::Array(rows)
}

struct PendingStep {
    seq_start: Value,
    time_start: Value,
    has_end: bool,
    seq_end: Value,
    time_end: Value,
}

/// `step/start` ↔ `step/end`，按 `(turn, step)` 配对 → `StepDuration[]`，按
/// `(turn, step)` 升序。同 `turn_durations`：只有 start 没有 end → `incomplete`。
pub fn step_durations(events: &[Value]) -> Value {
    let events = &crate::util::post_fork(events)[..];

    let mut order: Vec<(i64, i64)> = Vec::new();
    let mut by_step: std::collections::HashMap<(i64, i64), PendingStep> = std::collections::HashMap::new();
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("step/start") {
            continue;
        }
        let Some(turn) = e.pointer("/data/turn").and_then(|v| v.as_i64()) else { continue };
        let Some(step) = e.pointer("/data/step").and_then(|v| v.as_i64()) else { continue };
        order.push((turn, step));
        by_step.insert(
            (turn, step),
            PendingStep {
                seq_start: e.get("seq").cloned().unwrap_or(Value::Null),
                time_start: e.get("time").cloned().unwrap_or(Value::Null),
                has_end: false,
                seq_end: Value::Null,
                time_end: Value::Null,
            },
        );
    }
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("step/end") {
            continue;
        }
        let Some(turn) = e.pointer("/data/turn").and_then(|v| v.as_i64()) else { continue };
        let Some(step) = e.pointer("/data/step").and_then(|v| v.as_i64()) else { continue };
        let Some(pending) = by_step.get_mut(&(turn, step)) else { continue };
        pending.has_end = true;
        pending.seq_end = e.get("seq").cloned().unwrap_or(Value::Null);
        pending.time_end = e.get("time").cloned().unwrap_or(Value::Null);
    }

    let mut rows: Vec<Value> = Vec::new();
    for (turn, step) in order {
        let Some(p) = by_step.remove(&(turn, step)) else { continue };

        let mut missing: Vec<&'static str> = Vec::new();
        let duration_ms = p
            .has_end
            .then(|| p.time_start.as_i64().zip(p.time_end.as_i64()))
            .flatten()
            .map(|(a, b)| b - a);
        if duration_ms.is_none() {
            missing.push("duration_ms");
        }

        rows.push(json!({
            "turn": turn,
            "step": step,
            "duration_ms": duration_ms.map_or(Value::Null, |n| json!(n)),
            "seq_start": p.seq_start,
            "seq_end": p.seq_end,
            "load_status": if p.has_end { "loaded" } else { "incomplete" },
            "missing_fields": missing,
        }));
    }
    rows.sort_by_key(|r| (r["turn"].as_i64().unwrap_or(i64::MAX), r["step"].as_i64().unwrap_or(i64::MAX)));
    Value::Array(rows)
}

struct PendingApproval {
    tool_name: Value,
    turn: Value,
    step: Value,
    seq: Value,
    time: Value,
    has_decided: bool,
    decided_time: Value,
    outcome: Value,
}

/// `approval/asked` ↔ `approval/decided`，按事件的 **`id`** 配对——**不是**
/// `callId`（`approval/asked.data.callId` 是可选字段；按它配对会把大量审批
/// 错误地标成"孤立"或配对到错误的调用上，`fixtures/dsh/README.md` 已经踩过
/// 这个坑）→ `ApprovalLatency[]`，按 seq 升序。
///
/// 只有 `asked` 没有 `decided`（人一直没处理，或会话在等待中结束）→
/// `wait_ms: null`，`status` 落 `"pending"`——这是与 `incomplete` 不同的第三
/// 种状态：`incomplete` 暗示"本该有结果但配对失败"，`pending` 是"确实还没
/// 决定"，两者对用户的含义不同。
pub fn approval_latencies(events: &[Value]) -> Value {
    let events = &crate::util::post_fork(events)[..];
    let coords = crate::trajectory::coord_map(events);

    let mut order: Vec<String> = Vec::new();
    let mut by_id: std::collections::HashMap<String, PendingApproval> = std::collections::HashMap::new();
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("approval/asked") {
            continue;
        }
        let Some(data) = e.get("data") else { continue };
        let Some(id) = data.get("id").and_then(|v| v.as_str()) else { continue };
        let seq = e.get("seq").cloned().unwrap_or(Value::Null);
        let (turn, step) = coords_for(&seq, &coords);
        order.push(id.to_string());
        by_id.insert(
            id.to_string(),
            PendingApproval {
                tool_name: data.get("toolName").and_then(|v| v.as_str()).map_or(Value::Null, |s| json!(s)),
                turn,
                step,
                seq,
                time: e.get("time").cloned().unwrap_or(Value::Null),
                has_decided: false,
                decided_time: Value::Null,
                outcome: Value::Null,
            },
        );
    }
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("approval/decided") {
            continue;
        }
        let Some(data) = e.get("data") else { continue };
        let Some(id) = data.get("id").and_then(|v| v.as_str()) else { continue };
        let Some(pending) = by_id.get_mut(id) else { continue };
        pending.has_decided = true;
        pending.decided_time = e.get("time").cloned().unwrap_or(Value::Null);
        pending.outcome = data.get("outcome").and_then(|v| v.as_str()).map_or(Value::Null, |s| json!(s));
    }

    let mut rows: Vec<Value> = Vec::new();
    for id in order {
        let Some(p) = by_id.remove(&id) else { continue };

        let mut missing: Vec<&'static str> = Vec::new();
        if p.tool_name.is_null() {
            missing.push("tool_name");
        }
        if p.turn.is_null() {
            missing.push("turn");
        }
        if p.step.is_null() {
            missing.push("step");
        }

        let wait_ms = p
            .has_decided
            .then(|| p.time.as_i64().zip(p.decided_time.as_i64()))
            .flatten()
            .map(|(a, b)| b - a);
        if wait_ms.is_none() {
            missing.push("wait_ms");
        }
        if p.has_decided && p.outcome.is_null() {
            missing.push("outcome");
        }

        rows.push(json!({
            "id": id,
            "tool_name": p.tool_name,
            "wait_ms": wait_ms.map_or(Value::Null, |n| json!(n)),
            "outcome": p.outcome,
            "status": if p.has_decided { "decided" } else { "pending" },
            "turn": p.turn,
            "step": p.step,
            "seq": p.seq,
            "missing_fields": missing,
        }));
    }
    rows.sort_by_key(|r| r["seq"].as_i64().unwrap_or(i64::MAX));
    Value::Array(rows)
}

/// hook/result 抽取（D4）——`durationMs` 是 harness 自己算好写进日志的，
/// **不需要**跟 `hook/invoked` 配对去减两次时间戳：`durationMs` 已经是排队
/// +执行的总时长，`hook/invoked.time` 到 `hook/result.time` 的墙钟差是另一
/// 个数字（两者含义不同，混用会把"harness 自报的执行耗时"偷换成"两条日志
/// 间隔"）。所以 `hook/invoked` 完全不用读——`hook/result` 自己就带了
/// `handlerId`/`point`/`decision`/`durationMs` 这些字段
/// （`fixtures/dsh/README.md` 记的关联键确实是 `handlerId`，但这里不做
/// 配对，直接从 `result` 一侧取数）。
///
/// 顺带给出 `decision`（`pass`/`deny`/其它）的分布计数——这是
/// `GOVERNANCE_BACKLOG.md` 提到的"不需要基线就能用"的信号。
///
/// ⚠️ **D4 的执行环境前提尚未验证**：`integrations/dsh-client/src/harness/index.ts` 的
/// `RELEVANT_TYPES` 目前没有收 `hook/*`（见
/// `docs/audit-dashboard/DURATION_AUDIT_BACKLOG.md` D4）。这个函数在 CLI 侧
/// （`src/dsh.rs` 的 `EXECUTION_EVENT_TYPES` 已经收了 `hook/*`，`behavior`
/// 子命令能喂给它真实数据）立即可用；但"执行环境能不能看到 hook 事件"没有任何
/// 证据——D6 的执行环境投影**故意不**把 `hook/*` 加进 `RELEVANT_TYPES`，直到有
/// 人拿真实会话实测过，不能按"只是加个过滤条件"的成本估进排期。
pub fn hook_executions(events: &[Value]) -> Value {
    let events = &crate::util::post_fork(events)[..];
    let coords = crate::trajectory::coord_map(events);

    let mut rows: Vec<Value> = Vec::new();
    // BTreeMap 而不是 HashMap——序列化要按 key 字典序稳定输出，byte-for-byte
    // 差分测试才能钉住一个确定的字符串。
    let mut decision_counts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();

    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("hook/result") {
            continue;
        }
        let Some(data) = e.get("data") else { continue };
        // handlerId 是这条路径的身份锚点——没有就没法区分是哪个 hook。
        let Some(handler_id) = data.get("handlerId").and_then(|v| v.as_str()) else { continue };

        let seq = e.get("seq").cloned().unwrap_or(Value::Null);
        let (turn, _step) = coords_for(&seq, &coords);

        let point = data.get("point").and_then(|v| v.as_str()).map_or(Value::Null, |s| json!(s));
        let decision = data.get("decision").and_then(|v| v.as_str()).map_or(Value::Null, |s| json!(s));
        let duration_ms = data.get("durationMs").and_then(|v| v.as_i64());

        let mut missing: Vec<&'static str> = Vec::new();
        if point.is_null() {
            missing.push("point");
        }
        if decision.is_null() {
            missing.push("decision");
        }
        if duration_ms.is_none() {
            missing.push("duration_ms");
        }
        if turn.is_null() {
            missing.push("turn");
        }

        let decision_key = decision.as_str().unwrap_or("missing").to_string();
        *decision_counts.entry(decision_key).or_insert(0) += 1;

        rows.push(json!({
            "handler_id": handler_id,
            "point": point,
            "decision": decision,
            "duration_ms": duration_ms.map_or(Value::Null, |n| json!(n)),
            "turn": turn,
            "seq": seq,
            "missing_fields": missing,
        }));
    }

    rows.sort_by_key(|r| r["seq"].as_i64().unwrap_or(i64::MAX));
    json!({
        "executions": rows,
        "decision_counts": decision_counts,
    })
}

/// P3 group③（docs/RUNTIME_EVIDENCE_CONTRACT.md §17，duration）：五路执行
/// 时长审计各自依赖一个信号——`tool_calls`→`ToolCalls`、`turns`→
/// `TurnBoundaries`、`steps`→`StepBoundaries`、`approvals`→
/// `ApprovalDecisions`、`hooks`→`Hooks`。跟 group①（SV601-610）同一种情况:
/// 五路输出目前都是数组,`[]` 既可能是"这份日志没有这类事件"(该
/// unavailable),也可能是"有这类事件但配不成对"(真的 measured-zero,比如
/// tool_call_durations 里没有 callId 的调用整条跳过)——这两者现在混在
/// 一起看不出来。这里不改五个函数各自的配对逻辑,只是对着已经算好的
/// `duration` JSON + coverage 补一层判断,只加不改。
pub fn duration_coverage(duration: &Value, coverage: &Coverage) -> Value {
    const SPECS: [(&str, Signal); 5] = [
        ("tool_calls", Signal::ToolCalls),
        ("turns", Signal::TurnBoundaries),
        ("steps", Signal::StepBoundaries),
        ("approvals", Signal::ApprovalDecisions),
        ("hooks", Signal::Hooks),
    ];
    let mut map = serde_json::Map::new();
    for (key, signal) in SPECS {
        let total = coverage.get(signal).total();
        let entry = if total == 0 {
            json!({
                "status": "unavailable",
                "missing": [format!("{signal:?}")],
                "reason": "no evidence for required signal(s) in this session",
            })
        } else {
            // hooks 是嵌套形状 {"executions": [...], "decision_counts": {...}}，
            // 其余四路是裸数组——记录数从各自的形状里取，不能一律当裸数组处理。
            let count = if key == "hooks" {
                duration
                    .get(key)
                    .and_then(|v| v.get("executions"))
                    .and_then(|v| v.as_array())
                    .map_or(0, |a| a.len())
            } else {
                duration.get(key).and_then(|v| v.as_array()).map_or(0, |a| a.len())
            };
            if count == 0 {
                json!({"status": "measured_zero"})
            } else {
                json!({"status": "measured", "count": count})
            }
        };
        map.insert(key.to_string(), entry);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(seq: i64, time: i64, turn: i64, step: i64, cid: &str, name: &str) -> Value {
        json!({"type": "tool/call", "seq": seq, "time": time,
               "data": {"turn": turn, "step": step, "callId": cid, "name": name,
                        "arguments": "{}"}})
    }
    fn call_no_name(seq: i64, time: i64, cid: &str) -> Value {
        json!({"type": "tool/call", "seq": seq, "time": time, "data": {"callId": cid}})
    }
    fn result_ok(seq: i64, time: i64, cid: &str) -> Value {
        json!({"type": "tool/result", "seq": seq, "time": time,
               "data": {"message": {"source": {"kind": "tool", "callId": cid},
                                     "content": [{"type": "tool-result", "isError": false}]}}})
    }
    fn result_semantic_error(seq: i64, time: i64, cid: &str) -> Value {
        json!({"type": "tool/result", "seq": seq, "time": time,
               "data": {"message": {"source": {"kind": "tool", "callId": cid},
                                     "content": [{"type": "tool-result", "isError": true}]}}})
    }
    fn result_infra_error(seq: i64, time: i64, cid: &str) -> Value {
        json!({"type": "tool/result", "seq": seq, "time": time,
               "data": {"message": {"source": {"kind": "tool", "callId": cid}, "content": []},
                        "error": {"name": "TimeoutError", "code": "TOOL_TIMEOUT"}}})
    }

    /// 通用工具（非 skill）也要算出耗时——D1 存在的理由就是不再局限于
    /// `name=="skill"`。
    #[test]
    fn computes_duration_for_any_tool_not_just_skill() {
        let events = vec![call(19, 1000, 4, 1, "c1", "bash"), result_ok(20, 1018, "c1")];
        let out = tool_call_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r["tool_name"], json!("bash"));
        assert_eq!(r["load_status"], json!("loaded"));
        assert_eq!(r["duration_ms"], json!(18));
        assert_eq!(r["turn"], json!(4));
        assert_eq!(r["step"], json!(1));
        assert_eq!(r["call_id"], json!("c1"));
        assert_eq!(r["missing_fields"], json!([]));
    }

    /// 顶层 `data.error`（基础设施错误，六码之一）算失败。
    #[test]
    fn infra_error_is_failed() {
        let events = vec![call(1, 1000, 1, 1, "c1", "bash"), result_infra_error(2, 1005, "c1")];
        let out = tool_call_durations(&events);
        assert_eq!(out[0]["load_status"], json!("failed"));
    }

    /// `message.content[].isError`（工具自己报告的语义失败）同样算失败。
    #[test]
    fn semantic_error_is_failed() {
        let events = vec![call(1, 1000, 1, 1, "c1", "bash"), result_semantic_error(2, 1005, "c1")];
        let out = tool_call_durations(&events);
        assert_eq!(out[0]["load_status"], json!("failed"));
    }

    /// 结果没到 ≠ 这次调用没发生——行照留，`load_status` 落 `incomplete`，
    /// `duration_ms` 是真的缺失，进 `missing_fields`。
    #[test]
    fn without_result_is_kept_as_incomplete() {
        let events = vec![call(1, 1000, 7, 2, "c1", "bash")];
        let out = tool_call_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "没有回执也要保留这一行");
        assert_eq!(rows[0]["load_status"], json!("incomplete"));
        assert_eq!(rows[0]["duration_ms"], Value::Null);
        assert!(rows[0]["missing_fields"].as_array().unwrap().iter().any(|f| f == "duration_ms"));
    }

    /// 没有 `callId` 的调用整条跳过——结构上就配不了对，不是"耗时未知"。
    #[test]
    fn call_without_call_id_is_skipped_entirely() {
        let events = vec![json!({"type": "tool/call", "seq": 1, "time": 1000,
                                  "data": {"name": "bash"}})];
        assert_eq!(tool_call_durations(&events).as_array().unwrap().len(), 0);
    }

    /// `tool/call.data.name` 缺失：行照留（`call_id` 是身份锚点），
    /// `tool_name` 进 `missing_fields`，不猜一个名字。
    #[test]
    fn missing_tool_name_keeps_row_with_missing_field() {
        let events = vec![call_no_name(1, 1000, "c1")];
        let out = tool_call_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["tool_name"], Value::Null);
        assert_eq!(rows[0]["call_id"], json!("c1"));
        assert!(rows[0]["missing_fields"].as_array().unwrap().iter().any(|f| f == "tool_name"));
    }

    /// 分叉前发生的调用属于上游会话——同一条纪律，见 skill.rs/subagent.rs。
    #[test]
    fn calls_before_fork_belong_to_upstream() {
        let events = vec![
            call(1, 1000, 1, 1, "old", "bash"),
            result_ok(2, 1010, "old"),
            json!({"type": "session", "seq": Value::Null, "data": {"seedLength": 3}}),
            call(4, 1000, 9, 1, "mine", "bash"),
            result_ok(5, 1005, "mine"),
        ];
        let out = tool_call_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "分叉前那次是上游触发的，不该算进本会话");
        assert_eq!(rows[0]["call_id"], json!("mine"));
    }

    /// 不同工具混排也要保持整体按 seq 升序——证明确实没有按工具名过滤
    /// （skill/bash/subagent 都进来）。
    #[test]
    fn mixed_tools_sort_by_seq() {
        let events = vec![
            call(19, 1000, 4, 1, "c2", "subagent"),
            result_ok(20, 1010, "c2"),
            call(5, 1000, 1, 1, "c1", "bash"),
            result_ok(6, 1010, "c1"),
        ];
        let out = tool_call_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let seqs: Vec<i64> = rows.iter().map(|r| r["seq"].as_i64().unwrap()).collect();
        assert_eq!(seqs, vec![5, 19]);
        assert_eq!(rows[0]["tool_name"], json!("bash"));
        assert_eq!(rows[1]["tool_name"], json!("subagent"));
    }

    #[test]
    fn empty_input_gives_empty_output() {
        assert_eq!(tool_call_durations(&[]), Value::Array(vec![]));
    }

    /// Python `json.dumps(tool_call_durations(events), ensure_ascii=False,
    /// separators=(",", ":"))` 的逐字节对照——两侧各钉一次才是真差分（同
    /// `skill.rs::python_rust_byte_for_byte_parity` 的理由，见该测试注释）。
    #[test]
    fn python_rust_byte_for_byte_parity() {
        let events = vec![
            // 没有 callId 就没法配对，也没有 turn/step——incomplete + 三项缺失。
            json!({"type": "tool/call", "seq": 5, "time": 1000, "data": {"callId": "c2"}}),
            call(19, 1_750_000_020_000, 4, 1, "c1", "bash"),
            result_ok(20, 1_750_000_020_018, "c1"),
        ];
        assert_eq!(
            serde_json::to_string(&tool_call_durations(&events)).unwrap(),
            r#"[{"call_id":"c2","tool_name":null,"load_status":"incomplete","duration_ms":null,"seq":5,"turn":null,"step":null,"missing_fields":["tool_name","turn","step","duration_ms"]},{"call_id":"c1","tool_name":"bash","load_status":"loaded","duration_ms":18,"seq":19,"turn":4,"step":1,"missing_fields":[]}]"#
        );
    }

    // ── D2: turn_durations ───────────────────────────────────────────────

    fn turn_start(seq: i64, time: i64, turn: i64) -> Value {
        json!({"type": "turn/start", "seq": seq, "time": time, "data": {"turn": turn}})
    }
    fn turn_end(seq: i64, time: i64, turn: i64, kind: &str) -> Value {
        json!({"type": "turn/end", "seq": seq, "time": time,
               "data": {"turn": turn, "reason": {"kind": kind}}})
    }

    #[test]
    fn turn_duration_computes_from_start_end_pair() {
        let events = vec![turn_start(10, 1000, 3), turn_end(16, 1500, 3, "completed")];
        let out = turn_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["turn"], json!(3));
        assert_eq!(rows[0]["duration_ms"], json!(500));
        assert_eq!(rows[0]["seq_start"], json!(10));
        assert_eq!(rows[0]["seq_end"], json!(16));
        assert_eq!(rows[0]["ended_reason"], json!("completed"));
        assert_eq!(rows[0]["load_status"], json!("loaded"));
    }

    /// 只有 start 没有 end——会话在这个 turn 中途结束/被截断，行照留，标
    /// `incomplete`，不是"这个 turn 没有发生"。
    #[test]
    fn turn_without_end_is_kept_as_incomplete() {
        let out = turn_durations(&[turn_start(20, 2000, 4)]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "没有 turn/end 也要保留这一行");
        assert_eq!(rows[0]["load_status"], json!("incomplete"));
        assert_eq!(rows[0]["duration_ms"], Value::Null);
        assert_eq!(rows[0]["ended_reason"], Value::Null);
        let missing = rows[0]["missing_fields"].as_array().unwrap();
        assert!(missing.iter().any(|f| f == "duration_ms"));
        assert!(missing.iter().any(|f| f == "ended_reason"));
    }

    #[test]
    fn turn_end_reason_error_is_captured_not_normalized_to_completed() {
        let events = vec![turn_start(10, 1000, 3), turn_end(11, 1010, 3, "error")];
        assert_eq!(turn_durations(&events)[0]["ended_reason"], json!("error"));
    }

    #[test]
    fn turn_durations_sort_by_turn_number() {
        let events = vec![
            turn_start(20, 2000, 4), turn_end(23, 2300, 4, "completed"),
            turn_start(10, 1000, 3), turn_end(16, 1500, 3, "completed"),
        ];
        let out = turn_durations(&events);
        let turns: Vec<i64> = out.as_array().unwrap().iter().map(|r| r["turn"].as_i64().unwrap()).collect();
        assert_eq!(turns, vec![3, 4]);
    }

    #[test]
    fn turn_durations_empty_input_gives_empty_output() {
        assert_eq!(turn_durations(&[]), Value::Array(vec![]));
    }

    #[test]
    fn turn_durations_python_rust_byte_for_byte_parity() {
        let events = vec![
            turn_start(10, 1000, 3),
            turn_end(16, 1500, 3, "completed"),
            turn_start(20, 2000, 4),
        ];
        assert_eq!(
            serde_json::to_string(&turn_durations(&events)).unwrap(),
            r#"[{"turn":3,"duration_ms":500,"seq_start":10,"seq_end":16,"ended_reason":"completed","load_status":"loaded","missing_fields":[]},{"turn":4,"duration_ms":null,"seq_start":20,"seq_end":null,"ended_reason":null,"load_status":"incomplete","missing_fields":["duration_ms","ended_reason"]}]"#
        );
    }

    // ── D2: step_durations ───────────────────────────────────────────────

    fn step_start(seq: i64, time: i64, turn: i64, step: i64) -> Value {
        json!({"type": "step/start", "seq": seq, "time": time, "data": {"turn": turn, "step": step}})
    }
    fn step_end(seq: i64, time: i64, turn: i64, step: i64) -> Value {
        json!({"type": "step/end", "seq": seq, "time": time, "data": {"turn": turn, "step": step}})
    }

    #[test]
    fn step_duration_computes_from_start_end_pair() {
        let events = vec![step_start(11, 1100, 3, 1), step_end(15, 1400, 3, 1)];
        let out = step_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["turn"], json!(3));
        assert_eq!(rows[0]["step"], json!(1));
        assert_eq!(rows[0]["duration_ms"], json!(300));
        assert_eq!(rows[0]["load_status"], json!("loaded"));
    }

    #[test]
    fn step_without_end_is_kept_as_incomplete() {
        let out = step_durations(&[step_start(21, 2100, 4, 1)]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["load_status"], json!("incomplete"));
        assert!(rows[0]["missing_fields"].as_array().unwrap().iter().any(|f| f == "duration_ms"));
    }

    /// 同一个 step 编号在不同 turn 里重复出现（turn 1 step 1、turn 2 step 1）
    /// 必须各自独立配对，不能按 step 单独当 key 混在一起。
    #[test]
    fn step_number_resets_per_turn_and_does_not_collide() {
        let events = vec![
            step_start(2, 1002, 1, 1), step_end(4, 1004, 1, 1),
            step_start(7, 1007, 2, 1), step_end(9, 1009, 2, 1),
        ];
        let out = step_durations(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 2, "(turn=1,step=1) 与 (turn=2,step=1) 是两个不同的 key");
    }

    #[test]
    fn step_durations_sort_by_turn_then_step() {
        let events = vec![
            step_start(7, 1007, 2, 1), step_end(9, 1009, 2, 1),
            step_start(2, 1002, 1, 1), step_end(4, 1004, 1, 1),
        ];
        let out = step_durations(&events);
        let keys: Vec<(i64, i64)> = out.as_array().unwrap().iter()
            .map(|r| (r["turn"].as_i64().unwrap(), r["step"].as_i64().unwrap())).collect();
        assert_eq!(keys, vec![(1, 1), (2, 1)]);
    }

    #[test]
    fn step_durations_empty_input_gives_empty_output() {
        assert_eq!(step_durations(&[]), Value::Array(vec![]));
    }

    #[test]
    fn step_durations_python_rust_byte_for_byte_parity() {
        let events = vec![
            step_start(11, 1100, 3, 1),
            step_end(15, 1400, 3, 1),
            step_start(21, 2100, 4, 1),
        ];
        assert_eq!(
            serde_json::to_string(&step_durations(&events)).unwrap(),
            r#"[{"turn":3,"step":1,"duration_ms":300,"seq_start":11,"seq_end":15,"load_status":"loaded","missing_fields":[]},{"turn":4,"step":1,"duration_ms":null,"seq_start":21,"seq_end":null,"load_status":"incomplete","missing_fields":["duration_ms"]}]"#
        );
    }

    // ── D3: approval_latencies ───────────────────────────────────────────

    fn asked(seq: i64, time: i64, id: &str, tool_name: &str) -> Value {
        json!({"type": "approval/asked", "seq": seq, "time": time,
               "data": {"id": id, "toolName": tool_name, "reason": "escalation"}})
    }
    fn decided(seq: i64, time: i64, id: &str, outcome: &str) -> Value {
        json!({"type": "approval/decided", "seq": seq, "time": time,
               "data": {"id": id, "outcome": outcome}})
    }

    #[test]
    fn approval_latency_computes_wait_ms_from_id_pairing() {
        let events = vec![turn_start(10, 1000, 3), asked(12, 1200, "a1", "bash"), decided(13, 1210, "a1", "allowed-once")];
        let out = approval_latencies(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["wait_ms"], json!(10));
        assert_eq!(rows[0]["outcome"], json!("allowed-once"));
        assert_eq!(rows[0]["status"], json!("decided"));
        assert_eq!(rows[0]["tool_name"], json!("bash"));
        assert_eq!(rows[0]["turn"], json!(3));
    }

    /// 关联键是 **`id`**，不是 `callId`——`asked` 事件即便完全没有 `callId`
    /// 字段也要能正常配对（`fixtures/dsh/README.md` 明确点过这个坑）。
    #[test]
    fn pairs_by_id_not_callid() {
        let asked_no_callid = json!({"type": "approval/asked", "seq": 1, "time": 1000,
            "data": {"id": "a1", "toolName": "bash", "reason": "x"}});
        let events = vec![asked_no_callid, decided(2, 1010, "a1", "rejected")];
        let out = approval_latencies(&events);
        assert_eq!(out[0]["wait_ms"], json!(10));
        assert_eq!(out[0]["outcome"], json!("rejected"));
    }

    /// 只有 asked 没有 decided：`status` 落 `pending`，不是 `incomplete`——
    /// 这是"确实还没决定"，不是"配对失败"，`outcome` 不进 `missing_fields`
    /// （还没决定，outcome 本来就不该有）。
    #[test]
    fn asked_without_decided_is_pending_not_incomplete() {
        let out = approval_latencies(&[asked(20, 2000, "a2", "write_file")]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "没有决定也要保留这一行");
        assert_eq!(rows[0]["status"], json!("pending"));
        assert_eq!(rows[0]["wait_ms"], Value::Null);
        assert_eq!(rows[0]["outcome"], Value::Null);
        assert!(!rows[0]["missing_fields"].as_array().unwrap().iter().any(|f| f == "outcome"),
                "还没决定，不该显示成'outcome 缺失'——那是配对失败才有的语义");
    }

    #[test]
    fn approval_latencies_sort_by_seq() {
        let events = vec![asked(20, 2000, "a2", "x"), asked(12, 1200, "a1", "y")];
        let out = approval_latencies(&events);
        let seqs: Vec<i64> = out.as_array().unwrap().iter().map(|r| r["seq"].as_i64().unwrap()).collect();
        assert_eq!(seqs, vec![12, 20]);
    }

    #[test]
    fn approval_latencies_empty_input_gives_empty_output() {
        assert_eq!(approval_latencies(&[]), Value::Array(vec![]));
    }

    #[test]
    fn approval_latencies_python_rust_byte_for_byte_parity() {
        let events = vec![
            turn_start(10, 1000, 3),
            asked(12, 1200, "a1", "bash"),
            decided(13, 1210, "a1", "allowed-once"),
            asked(20, 2000, "a2", "write_file"),
        ];
        assert_eq!(
            serde_json::to_string(&approval_latencies(&events)).unwrap(),
            r#"[{"id":"a1","tool_name":"bash","wait_ms":10,"outcome":"allowed-once","status":"decided","turn":3,"step":null,"seq":12,"missing_fields":["step"]},{"id":"a2","tool_name":"write_file","wait_ms":null,"outcome":null,"status":"pending","turn":3,"step":null,"seq":20,"missing_fields":["step","wait_ms"]}]"#
        );
    }

    // ── D4: hook_executions ──────────────────────────────────────────────

    fn hook_result(seq: i64, time: i64, handler_id: &str, point: Option<&str>, decision: Option<&str>, duration_ms: Option<i64>) -> Value {
        let mut data = serde_json::Map::new();
        data.insert("handlerId".into(), json!(handler_id));
        if let Some(p) = point {
            data.insert("point".into(), json!(p));
        }
        if let Some(d) = decision {
            data.insert("decision".into(), json!(d));
        }
        if let Some(ms) = duration_ms {
            data.insert("durationMs".into(), json!(ms));
        }
        json!({"type": "hook/result", "seq": seq, "time": time, "data": Value::Object(data)})
    }

    #[test]
    fn extracts_duration_directly_from_result_no_pairing_needed() {
        let events = vec![
            turn_start(1, 1000, 1),
            hook_result(9, 1009, "h1", Some("PreToolUse"), Some("pass"), Some(12)),
        ];
        let out = hook_executions(&events);
        let rows = out["executions"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["handler_id"], json!("h1"));
        assert_eq!(rows[0]["point"], json!("PreToolUse"));
        assert_eq!(rows[0]["decision"], json!("pass"));
        assert_eq!(rows[0]["duration_ms"], json!(12));
        assert_eq!(rows[0]["turn"], json!(1));
        assert_eq!(rows[0]["missing_fields"], json!([]));
    }

    #[test]
    fn missing_handler_id_is_skipped_entirely() {
        let events = vec![hook_result(1, 1000, "", None, None, None)];
        // 空字符串仍是字符串——用真正缺 handlerId 键的事件测跳过。
        let bad = json!({"type": "hook/result", "seq": 1, "time": 1000, "data": {"point": "PreToolUse"}});
        assert_eq!(hook_executions(&[bad]).as_object().unwrap()["executions"].as_array().unwrap().len(), 0);
        // 有 handlerId（即便是空串）的仍然保留，证明门槛只卡"这个 key 存不存在"。
        assert_eq!(hook_executions(&events)["executions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn missing_point_decision_duration_go_to_missing_fields() {
        let events = vec![hook_result(1, 1000, "h1", None, None, None)];
        let out = hook_executions(&events);
        let row = &out["executions"][0];
        assert_eq!(row["point"], Value::Null);
        assert_eq!(row["decision"], Value::Null);
        assert_eq!(row["duration_ms"], Value::Null);
        let missing = row["missing_fields"].as_array().unwrap();
        for f in ["point", "decision", "duration_ms"] {
            assert!(missing.iter().any(|m| m == f), "missing_fields 应含 {f}");
        }
    }

    #[test]
    fn decision_counts_tally_by_actual_string_value() {
        let events = vec![
            hook_result(1, 1000, "h1", None, Some("pass"), Some(1)),
            hook_result(2, 1000, "h2", None, Some("pass"), Some(1)),
            hook_result(3, 1000, "h3", None, Some("deny"), Some(1)),
        ];
        let counts = &hook_executions(&events)["decision_counts"];
        assert_eq!(counts["pass"], json!(2));
        assert_eq!(counts["deny"], json!(1));
    }

    /// turn 走 coord_map 顺延——hook/result 自己没带 turn 时，仍要能从此前
    /// 观察到的 turn/start 顺延出来，不是必须自带。
    #[test]
    fn turn_falls_back_to_coord_map_when_not_carried() {
        let events = vec![turn_start(1, 1000, 5), hook_result(9, 1009, "h1", None, None, None)];
        assert_eq!(hook_executions(&events)["executions"][0]["turn"], json!(5));
    }

    #[test]
    fn hook_executions_empty_input_gives_empty_output() {
        let out = hook_executions(&[]);
        assert_eq!(out["executions"], json!([]));
        assert_eq!(out["decision_counts"], json!({}));
    }

    #[test]
    fn hook_executions_python_rust_byte_for_byte_parity() {
        let events = vec![
            turn_start(1, 1000, 1),
            hook_result(9, 1009, "h1", Some("PreToolUse"), Some("pass"), Some(12)),
            hook_result(15, 1015, "h2", None, Some("deny"), None),
        ];
        assert_eq!(
            serde_json::to_string(&hook_executions(&events)).unwrap(),
            r#"{"executions":[{"handler_id":"h1","point":"PreToolUse","decision":"pass","duration_ms":12,"turn":1,"seq":9,"missing_fields":[]},{"handler_id":"h2","point":null,"decision":"deny","duration_ms":null,"turn":1,"seq":15,"missing_fields":["point","duration_ms"]}],"decision_counts":{"deny":1,"pass":1}}"#
        );
    }

    #[test]
    fn duration_coverage_is_unavailable_for_every_signal_on_empty_session() {
        let duration = json!({"tool_calls": [], "turns": [], "steps": [], "approvals": [],
                               "hooks": {"executions": [], "decision_counts": {}}});
        let cov = Coverage::new();
        let out = duration_coverage(&duration, &cov);
        for key in ["tool_calls", "turns", "steps", "approvals", "hooks"] {
            assert_eq!(out[key]["status"], json!("unavailable"), "{key} 零覆盖应该 unavailable");
        }
    }

    #[test]
    fn duration_coverage_distinguishes_measured_zero_from_unavailable() {
        // ToolCalls 有覆盖但 tool_call_durations 折出空数组(比如全没 callId)
        // → measured_zero,不是 unavailable。
        let duration = json!({"tool_calls": [], "turns": [], "steps": [], "approvals": [],
                               "hooks": {"executions": [], "decision_counts": {}}});
        let mut cov = Coverage::new();
        cov.set(Signal::ToolCalls, crate::evidence::CoverageCounts { measured: 3, ..Default::default() });
        let out = duration_coverage(&duration, &cov);
        assert_eq!(out["tool_calls"]["status"], json!("measured_zero"));
        assert_eq!(out["turns"]["status"], json!("unavailable"));
    }

    #[test]
    fn duration_coverage_measured_with_count_for_populated_arrays_and_nested_hooks() {
        let duration = json!({
            "tool_calls": [{"a": 1}, {"a": 2}], "turns": [], "steps": [], "approvals": [],
            "hooks": {"executions": [{"a": 1}], "decision_counts": {"pass": 1}},
        });
        let mut cov = Coverage::new();
        cov.set(Signal::ToolCalls, crate::evidence::CoverageCounts { measured: 2, ..Default::default() });
        cov.set(Signal::Hooks, crate::evidence::CoverageCounts { measured: 1, ..Default::default() });
        let out = duration_coverage(&duration, &cov);
        assert_eq!(out["tool_calls"], json!({"status": "measured", "count": 2}));
        assert_eq!(out["hooks"], json!({"status": "measured", "count": 1}));
    }
}
