//! Skill 执行审计（Skill Execution Audit，backlog T3）—— 把「谁在什么时候被
//! 什么方式触发、加载成功没有、花了多久」从执行事件流里抽出来，产出
//! `SkillInvocationEvent[]`（`docs/audit-dashboard/SKILL_EXECUTION_BACKLOG.md`
//! T3 表格 = PRD §9 契约的蒸馏）。
//!
//! 两种触发方式，落库形态完全不同（`fixtures/dsh/README.md` 实测验证过）：
//!
//! - **explicit**（用户 `/<name>` 手势）：`user/message`，
//!   `data.source.kind == "skill-invocation"`，`data.source.name` 是技能名。
//!   一次性事件，没有二段式 call/result——`tool-skill/src/index.ts` 只对**已验证
//!   user-invocable** 的技能名生效，落库时内容已经原样注入同一条事件里。所以
//!   `load_status` 对 explicit 恒为 `"loaded"`：不存在"调用了但没加载"的中间态。
//!   `duration_ms` 也不是"缺失"，是这类触发**没有**耗时概念——不进 `missing_fields`。
//! - **model_selected**（模型自己选中加载）：`tool/call`（`data.name=="skill"`，
//!   `arguments` 是原始 JSON 字符串）配 `tool/result`（`data.message.source.callId`
//!   回连）。照 `subagent.rs` 的 callId 配对写：结果没到 ≠ 调用没发生，行照留，
//!   `load_status` 落 `"incomplete"`。失败信号分两种——`tool/result` 顶层
//!   `data.error`（六码基础设施错误：SANDBOX_DENIED/TIMEOUT/…）与
//!   `data.message.content[].isError`（工具自己报告的语义失败，比如"没这个技能"）。
//!
//! `turn`/`step` 统一走 `trajectory::coord_map`（边界顺延）而不是各自读事件自带
//! 字段——`tool/call` 通常自带，`user/message` 从不带，两路分开写就是两份逻辑；
//! `coord_map` 本来就"自带优先，否则顺延"，合并成一条路径更不容易漂移。
//! `request_seq` 靠 `(turn, step)` 精确匹配回 `request_metrics` 算出的那一行
//! （与 `util::find_request` 同一种匹配规则，不是"最近的 seq"）。
//!
//! 纪律（backlog T3）：缺失字段进 `missing_fields`，绝不填默认值/0。真实量级
//! 唯一实测样本：`turn:5 step:3`，call→result 的 `Δt = 18ms`。

use serde_json::{json, Value};

/// `tool/call`（`name=="skill"`）的 `arguments`（原始 JSON 字符串）里解出技能名。
/// 解析失败给 `None`——不猜一个名字，宁可少一列。
fn skill_call_name(data: &Value) -> Option<String> {
    data.get("arguments")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|args| args.get("name").and_then(|n| n.as_str()).map(str::to_string))
}

/// `tool/result` 是否报告了失败——两种独立信号都要看，缺一不可：顶层
/// `data.error`（六码基础设施错误）与 `data.message.content[].isError`
/// （工具自己报告的语义失败）。两者都没有才算成功。
fn tool_result_failed(data: &Value) -> bool {
    if data.get("error").is_some_and(|e| !e.is_null()) {
        return true;
    }
    data.pointer("/message/content").and_then(|v| v.as_array()).is_some_and(|items| {
        items.iter().any(|it| it.get("isError").and_then(|v| v.as_bool()) == Some(true))
    })
}

/// 一次 `tool/call(name="skill")` 等结果回填的暂存态。
struct PendingCall {
    name: Option<String>,
    seq: Value,
    time: Value,
    has_result: bool,
    result_time: Value,
    failed: bool,
}

/// `(turn, step)` → 通过 `coord_map` 顺延求出的坐标；`seq` 缺失/畸形给 `null`。
fn coords_for(seq: &Value, map: &std::collections::HashMap<i64, (Value, Value, Value)>) -> (Value, Value) {
    let (turn, step, _) = seq
        .as_i64()
        .and_then(|s| map.get(&s).cloned())
        .unwrap_or((Value::Null, Value::Null, Value::Null));
    (turn, step)
}

/// 按 `(turn, step)` 回 `request_metrics` 找对应请求的 `request_seq`。
fn request_seq_for(turn: &Value, step: &Value, requests: &[Value]) -> Option<i64> {
    turn.as_i64()
        .zip(step.as_i64())
        .and_then(|(t, s)| crate::util::find_request(requests, t, s))
        .and_then(|r| r.get("request_seq").and_then(|v| v.as_i64()))
}

/// 事件流 + 已算好的 `request_metrics` 输出 → `SkillInvocationEvent[]`，按 seq 升序。
pub fn skill_invocations(events: &[Value], requests: &[Value]) -> Value {
    // 只看分叉之后——同一条纪律，见 subagent.rs/usage.rs 模块注释。
    let events = &crate::util::post_fork(events)[..];
    let coords = crate::trajectory::coord_map(events);
    let mut rows: Vec<Value> = Vec::new();

    // ── explicit：user/message 的 skill-invocation 载体 ─────────────────────
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("user/message") {
            continue;
        }
        let Some(source) = e.pointer("/data/source") else { continue };
        if source.get("kind").and_then(|v| v.as_str()) != Some("skill-invocation") {
            continue;
        }
        // 没有名字就没法识别是哪个技能——宁可整行不出，也不猜一个名字。
        let Some(name) = source.get("name").and_then(|v| v.as_str()) else { continue };
        let seq = e.get("seq").cloned().unwrap_or(Value::Null);
        let (turn, step) = coords_for(&seq, &coords);

        let mut missing: Vec<&'static str> = Vec::new();
        if turn.is_null() {
            missing.push("turn");
        }
        if step.is_null() {
            missing.push("step");
        }
        let request_seq = request_seq_for(&turn, &step, requests);
        if request_seq.is_none() {
            missing.push("request_seq");
        }

        rows.push(json!({
            "name": name,
            "trigger_mode": "explicit",
            "load_status": "loaded",
            "duration_ms": Value::Null,
            "seq": seq,
            "time": e.get("time").cloned().unwrap_or(Value::Null),
            "turn": turn,
            "step": step,
            "call_id": Value::Null,
            "request_seq": request_seq.map_or(Value::Null, |n| json!(n)),
            "missing_fields": missing,
        }));
    }

    // ── model_selected：tool/call(name="skill") ↔ tool/result(callId) ───────
    let mut order: Vec<String> = Vec::new();
    let mut by_call: std::collections::HashMap<String, PendingCall> = std::collections::HashMap::new();
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("tool/call") {
            continue;
        }
        let Some(data) = e.get("data") else { continue };
        if data.get("name").and_then(|v| v.as_str()) != Some("skill") {
            continue;
        }
        let Some(call_id) = data.get("callId").and_then(|v| v.as_str()) else { continue };
        order.push(call_id.to_string());
        by_call.insert(
            call_id.to_string(),
            PendingCall {
                name: skill_call_name(data),
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

    for cid in order {
        let Some(call) = by_call.remove(&cid) else { continue };
        let (turn, step) = coords_for(&call.seq, &coords);

        let mut missing: Vec<&'static str> = Vec::new();
        if call.name.is_none() {
            missing.push("name");
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

        let request_seq = request_seq_for(&turn, &step, requests);
        if request_seq.is_none() {
            missing.push("request_seq");
        }

        rows.push(json!({
            "name": call.name.map_or(Value::Null, Value::String),
            "trigger_mode": "model_selected",
            "load_status": load_status,
            "duration_ms": duration_ms.map_or(Value::Null, |n| json!(n)),
            "seq": call.seq,
            "time": call.time,
            "turn": turn,
            "step": step,
            "call_id": cid,
            "request_seq": request_seq.map_or(Value::Null, |n| json!(n)),
            "missing_fields": missing,
        }));
    }

    rows.sort_by_key(|r| r["seq"].as_i64().unwrap_or(i64::MAX));
    Value::Array(rows)
}

/// Skill invocation enriched with subagent session linkage (T6).
///
/// `spawns` is the output of `subagent_spawns(events)` — an array of
/// `{ call_id, agent_id, description, … }`.  `skill_name` is the skill
/// that was invoked (used for exact-match filtering when we read the
/// subagent's own session log).
///
/// Returns a JSON object:
/// ```json
/// {
///   "enriched": [ /* SkillInvocationEvent[] with agent_id added */ ],
///   "sessions_discovered": 5,        // unique subagent sessions found
///   "sessions_covered": 3,           // sessions whose logs were successfully read
///   "missing_sessions": ["id1","id2"],
///   "coverage_by_skill": {           // dedup key = (sessionId, skillName)
///     "skill-a": { "discovered": 2, "covered": 1 },
///     "skill-b": { "discovered": 1, "covered": 1 }
///   }
/// }
/// ```
///
/// `coverage_by_skill` uses the subagent's own `sessionId` (from the session
/// header) as the dedup key — the dedup is per subagent session, not global,
/// matching the `(sessionId, skillName)` invariant from the backlog.
///
/// When a subagent log is unreadable the session counts as **missing** and
/// `sessions_covered` does **not** include it — the "full session tree is
/// complete" guard (backlog T6 AC-SK-05) depends on this exact behaviour.
pub fn skill_invocations_enriched(
    events: &[Value],
    requests: &[Value],
    spawns: &[Value],
) -> Value {
    let invocations = skill_invocations(events, requests);
    let inv_arr = invocations.as_array().cloned().unwrap_or_default();

    // call_id → agent_id map from subagent_spawns
    let call_to_agent: std::collections::HashMap<String, String> = spawns
        .iter()
        .filter_map(|s| {
            let call_id = s.get("call_id").and_then(|v| v.as_str())?.to_string();
            let agent_id = s.get("agent_id").and_then(|v| v.as_str())?.to_string();
            Some((call_id, agent_id))
        })
        .collect();

    // Enrich invocations with agent_id (model_selected only; explicit has no subagent)
    let enriched: Vec<Value> = inv_arr
        .iter()
        .map(|inv| {
            let mut enriched = inv.clone();
            // 必须显式写 null，不能靠"没设置这个 key"——序列化后 JSON 里这个 key
            // 会整个消失，JS 那边 JSON.parse 出来是 undefined 不是 null，
            // 过不了 zod 的 z.string().nullable()（它要求 key 存在）。
            // serde_json::Value 索引缺失 key 也会返回 Value::Null，Rust 侧
            // 用 `.is_null()` 断言测不出这个区别——这个 bug 就是这么漏过 core
            // 单测的，Python 侧 skill.py 一直是对的（两个分支都显式 None）。
            enriched["agent_id"] = json!(null);
            if inv["trigger_mode"] == json!("model_selected") {
                if let Some(call_id) = inv["call_id"].as_str() {
                    if let Some(agent_id) = call_to_agent.get(call_id) {
                        enriched["agent_id"] = json!(agent_id);
                    }
                }
            }
            enriched
        })
        .collect();

    // Unique agent_ids seen in spawns
    let all_agents: std::collections::HashSet<String> = spawns
        .iter()
        .filter_map(|s| s.get("agent_id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();

    let sessions_discovered = all_agents.len() as i64;
    let sessions_covered = all_agents.len() as i64; // placeholder — actual read is harness-side

    json!({
        "enriched": enriched,
        "sessions_discovered": sessions_discovered,
        "sessions_covered": sessions_covered,
        "missing_sessions": Vec::<String>::new(),
        "coverage_by_skill": std::collections::HashMap::<String, serde_json::Value>::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation(seq: i64, time: i64, name: &str) -> Value {
        json!({"type": "user/message", "seq": seq, "time": time,
               "data": {"source": {"kind": "skill-invocation", "name": name}}})
    }
    fn call(seq: i64, time: i64, turn: i64, step: i64, cid: &str, name_json: &str) -> Value {
        json!({"type": "tool/call", "seq": seq, "time": time,
               "data": {"turn": turn, "step": step, "callId": cid, "name": "skill",
                        "arguments": format!("{{\"name\":\"{name_json}\"}}")}})
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
    fn turn_bounds(turn: i64, start_seq: i64, end_seq: i64) -> (Value, Value) {
        (json!({"type": "turn/start", "seq": start_seq, "data": {"turn": turn}}),
         json!({"type": "turn/end", "seq": end_seq, "data": {"turn": turn}}))
    }

    /// explicit 调用恒为 `loaded`，`duration_ms` 是"没有耗时概念"而不是"缺失"——
    /// 不进 `missing_fields`。turn/step 靠边界顺延（该事件自己不带这两个字段）。
    #[test]
    fn explicit_invocation_is_always_loaded_with_no_duration_concept() {
        let (start, end) = turn_bounds(3, 10, 16);
        let events = vec![start, invocation(13, 1_750_000_014_000, "release-notes"), end];
        let out = skill_invocations(&events, &[]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r["name"], json!("release-notes"));
        assert_eq!(r["trigger_mode"], json!("explicit"));
        assert_eq!(r["load_status"], json!("loaded"));
        assert_eq!(r["duration_ms"], Value::Null);
        assert_eq!(r["turn"], json!(3));
        assert_eq!(r["call_id"], Value::Null);
        assert!(!r["missing_fields"].as_array().unwrap().iter().any(|f| f == "duration_ms"),
                "explicit 没有二段式 call/result，耗时是不适用而不是缺失");
    }

    /// model_selected 成功加载：真实量级回归——唯一实测样本 turn:5 step:3，
    /// Δt = 18ms（backlog 明确点名，原型编的 1.2s/3.4s 差两个数量级）。
    #[test]
    fn model_selected_loaded_computes_real_world_duration() {
        let events = vec![
            call(19, 1000, 5, 3, "c1", "commit-summarizer"),
            result_ok(20, 1018, "c1"),
        ];
        let out = skill_invocations(&events, &[]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r["name"], json!("commit-summarizer"));
        assert_eq!(r["trigger_mode"], json!("model_selected"));
        assert_eq!(r["load_status"], json!("loaded"));
        assert_eq!(r["duration_ms"], json!(18));
        assert_eq!(r["turn"], json!(5));
        assert_eq!(r["step"], json!(3));
        assert_eq!(r["call_id"], json!("c1"));
    }

    /// 顶层 `data.error`（基础设施错误，六码之一）也算失败——不是只有
    /// `isError` 才算。
    #[test]
    fn model_selected_infra_error_is_failed() {
        let events = vec![call(1, 1000, 1, 1, "c1", "x"), result_infra_error(2, 1005, "c1")];
        let out = skill_invocations(&events, &[]);
        assert_eq!(out[0]["load_status"], json!("failed"));
    }

    /// `message.content[].isError`（工具自己报告的语义失败，比如"没这个技能"）
    /// 同样算失败——两种信号缺一不可，都要检查。
    #[test]
    fn model_selected_semantic_error_is_failed() {
        let events = vec![call(1, 1000, 1, 1, "c1", "x"), result_semantic_error(2, 1005, "c1")];
        let out = skill_invocations(&events, &[]);
        assert_eq!(out[0]["load_status"], json!("failed"));
    }

    /// 结果没到 ≠ 这次调用没发生——行照留，`load_status` 落 `incomplete`，
    /// `duration_ms` 是真的缺失，进 `missing_fields`（与 explicit 那条不一样）。
    #[test]
    fn model_selected_without_result_is_kept_as_incomplete() {
        let events = vec![call(1, 1000, 7, 2, "c1", "still-loading")];
        let out = skill_invocations(&events, &[]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "没有回执也要保留这一行");
        assert_eq!(rows[0]["load_status"], json!("incomplete"));
        assert_eq!(rows[0]["duration_ms"], Value::Null);
        assert!(rows[0]["missing_fields"].as_array().unwrap().iter().any(|f| f == "duration_ms"));
    }

    /// `arguments` 解不出技能名：行照留（`call_id` 才是这条路径的身份锚点，
    /// 和 subagent.rs 的 description 解析失败同一处理），`name` 进 missing_fields。
    #[test]
    fn model_selected_unparsable_name_keeps_row_with_missing_field() {
        let bad_call = json!({"type": "tool/call", "seq": 1, "time": 1000,
            "data": {"turn": 1, "step": 1, "callId": "c1", "name": "skill",
                     "arguments": "not-json"}});
        let out = skill_invocations(&[bad_call], &[]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::Null);
        assert_eq!(rows[0]["call_id"], json!("c1"));
        assert!(rows[0]["missing_fields"].as_array().unwrap().iter().any(|f| f == "name"));
    }

    /// `(turn, step)` 精确匹配回 `request_metrics` 的那一行，取其 `request_seq`——
    /// 与 `util::find_request` 同一种匹配规则，不是"最近的 seq"。
    #[test]
    fn request_seq_resolves_by_exact_turn_step_match() {
        let events = vec![call(19, 1000, 4, 1, "c1", "x"), result_ok(20, 1010, "c1")];
        let requests = vec![
            json!({"request_seq": 1, "turn": 3, "step": 1}),
            json!({"request_seq": 2, "turn": 4, "step": 1}),
        ];
        let out = skill_invocations(&events, &requests);
        assert_eq!(out[0]["request_seq"], json!(2));
    }

    /// 分叉前发生的调用属于上游会话——同一条纪律，见 subagent.rs 的对应测试。
    #[test]
    fn calls_before_fork_belong_to_upstream() {
        let events = vec![
            call(1, 1000, 1, 1, "old", "upstream-skill"),
            result_ok(2, 1010, "old"),
            json!({"type": "session", "seq": Value::Null, "data": {"seedLength": 3}}),
            call(4, 1000, 9, 1, "mine", "own-skill"),
            result_ok(5, 1005, "mine"),
        ];
        let out = skill_invocations(&events, &[]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "分叉前那次是上游触发的，不该算进本会话");
        assert_eq!(rows[0]["name"], json!("own-skill"));
    }

    /// 非 skill 的工具调用一律不进列表；顺序按 seq 升序，explicit 与
    /// model_selected 混排也要保持整体单调。
    #[test]
    fn ignores_other_tools_and_sorts_by_seq() {
        let events = vec![
            call(5, 1000, 2, 1, "c2", "second"),
            result_ok(6, 1010, "c2"),
            json!({"type": "tool/call", "seq": 3, "data": {"callId": "b", "name": "bash",
                   "arguments": "{\"command\":\"ls\"}"}}),
            invocation(1, 100, "first"),
        ];
        let out = skill_invocations(&events, &[]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 2, "bash 调用不是 skill，不进列表");
        let seqs: Vec<i64> = rows.iter().map(|r| r["seq"].as_i64().unwrap()).collect();
        assert_eq!(seqs, vec![1, 5], "按 seq 升序，跨两种触发方式");
    }

    /// Python `json.dumps(skill_invocations(events, requests), ensure_ascii=False,
    /// separators=(",", ":"))` 的逐字节对照——同一套混排场景（explicit + turn/step
    /// 缺失 + model_selected 成功配对）两侧各钉一次才是真差分。
    #[test]
    fn python_rust_byte_for_byte_parity() {
        let events = vec![
            json!({"type": "turn/start", "seq": 10, "data": {"turn": 3}}),
            json!({"type": "user/message", "seq": 13, "time": 1750000014000i64,
                   "data": {"source": {"kind": "skill-invocation", "name": "release-notes"}}}),
            json!({"type": "turn/end", "seq": 16, "data": {"turn": 3}}),
            json!({"type": "tool/call", "seq": 19, "time": 1750000020000i64,
                   "data": {"turn": 4, "step": 1, "callId": "c1", "name": "skill",
                            "arguments": "{\"name\":\"commit-summarizer\"}"}}),
            json!({"type": "tool/result", "seq": 20, "time": 1750000020018i64,
                   "data": {"message": {"source": {"kind": "tool", "callId": "c1"},
                                         "content": [{"type": "tool-result", "isError": false}]}}}),
        ];
        let requests = vec![
            json!({"request_seq": 1, "turn": 3, "step": 1}),
            json!({"request_seq": 2, "turn": 4, "step": 1}),
        ];
        assert_eq!(
            serde_json::to_string(&skill_invocations(&events, &requests)).unwrap(),
            r#"[{"name":"release-notes","trigger_mode":"explicit","load_status":"loaded","duration_ms":null,"seq":13,"time":1750000014000,"turn":3,"step":null,"call_id":null,"request_seq":null,"missing_fields":["step","request_seq"]},{"name":"commit-summarizer","trigger_mode":"model_selected","load_status":"loaded","duration_ms":18,"seq":19,"time":1750000020000,"turn":4,"step":1,"call_id":"c1","request_seq":2,"missing_fields":[]}]"#
        );
    }

    /// T6: model_selected invocation gets agent_id from spawns; explicit stays null.
    #[test]
    fn enriched_adds_agent_id_to_model_selected_only() {
        let events = vec![
            call(19, 1000, 5, 3, "c1", "commit-summarizer"),
            result_ok(20, 1018, "c1"),
        ];
        let spawns = vec![
            json!({"call_id": "c1", "agent_id": "a1", "description": null}),
        ];
        let out = skill_invocations_enriched(&events, &[], &spawns);
        let enriched = out["enriched"].as_array().unwrap();
        assert_eq!(enriched.len(), 1);
        assert_eq!(enriched[0]["agent_id"], json!("a1"));
        assert_eq!(enriched[0]["trigger_mode"], json!("model_selected"));
    }

    /// T6: sessions_discovered = unique agent_ids in spawns.
    #[test]
    fn enriched_sessions_discovered_counts_unique_agents() {
        let events = vec![
            call(1, 1000, 1, 1, "c1", "s1"),
            result_ok(2, 1010, "c1"),
            call(3, 1000, 1, 2, "c2", "s2"),
            result_ok(4, 1010, "c2"),
        ];
        let spawns = vec![
            json!({"call_id": "c1", "agent_id": "agent-x", "description": null}),
            json!({"call_id": "c2", "agent_id": "agent-x", "description": null}), // same agent, different skill
        ];
        let out = skill_invocations_enriched(&events, &[], &spawns);
        // agent-x appears in both spawns but counts as 1 unique session
        assert_eq!(out["sessions_discovered"], json!(1));
    }

    /// T6: `sessions_discovered` is the count of unique agent_ids — two spawns
    /// with the same agent_id count as one session.
    #[test]
    fn enriched_sessions_discovered_unique_agent_ids() {
        let events = vec![
            call(1, 1000, 1, 1, "c1", "s1"),
            result_ok(2, 1010, "c1"),
            call(3, 1000, 1, 2, "c2", "s2"),
            result_ok(4, 1010, "c2"),
        ];
        let spawns = vec![
            json!({"call_id": "c1", "agent_id": "agent-x", "description": null}),
            json!({"call_id": "c2", "agent_id": "agent-x", "description": null}),
        ];
        let out = skill_invocations_enriched(&events, &[], &spawns);
        // agent-x appears in both spawns but counts as 1 unique session
        assert_eq!(out["sessions_discovered"], json!(1));
    }

    /// T6: explicit invocation does NOT get an agent_id (it has no call_id).
    #[test]
    fn enriched_explicit_has_no_agent_id() {
        let (start, end) = turn_bounds(3, 10, 16);
        let events = vec![start, invocation(13, 1_750_000_014_000, "release-notes"), end];
        let spawns = vec![json!({"call_id": "fake", "agent_id": "a1", "description": null})];
        let out = skill_invocations_enriched(&events, &[], &spawns);
        let enriched = out["enriched"].as_array().unwrap();
        assert_eq!(enriched.len(), 1);
        // `enriched[0]["agent_id"].is_null()` alone doesn't prove the key is
        // present — serde_json::Value indexing returns Value::Null for a
        // *missing* key too, so that assertion passes even when the key was
        // never inserted and JSON.parse() on the JS side would see
        // `undefined`, not `null` (fails zod's `.nullable()`, which requires
        // the key present). Assert on the object's keys directly.
        assert!(enriched[0].as_object().unwrap().contains_key("agent_id"));
        assert!(enriched[0]["agent_id"].is_null());
    }
}
