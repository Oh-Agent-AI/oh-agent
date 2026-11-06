//! 子代理启动事件 —— 从父会话的事件流里提取「什么时候派了谁去干什么」。
//!
//! 为什么是一层独立提取而不是一条规则：启动子代理**不是异常**，不该产生
//! finding。但它是时间线上真正的关键事件（一个 turn 里派出去的活会在别处
//! 烧掉真金白银），而且它是把父会话与子会话连起来的**唯一权威链路**。
//!
//! ## 权威链路为什么在父会话这边
//!
//! 子会话头里的 `parentSession` **不可靠**：真实数据里 e4b0be69 有 19 次
//! subagent 调用，但只有 5 个子会话的 `parentSession` 指向它——另外 14 次是
//! 从上游会话 branch 时抄进日志的历史（见 `util::fork_boundary`），那些子会话
//! 记的是更早那个祖先。反过来，父日志里的 `tool/call name=subagent` →
//! `tool/result` 文本 `started subagent <uuid>` 是这次调用当场的产物，配上
//! post_fork 过滤，数出来的 5 个与 DSH 自己 UI 上显示的 5 个逐个吻合
//! （连 token 数都对得上：4.3M / 1.9M / 5.2M / 4M / 262K）。
//!
//! ## 结果没到 ≠ 这次启动不存在
//!
//! `agent_id` 为 null 表示「调用发生了，但回执还没写进日志」（正在启动、
//! 或日志被截断）。这一行**仍然保留**——把它丢掉等于说这次派活没发生过。

use serde_json::{json, Value};

/// 从 `tool/result` 的文本里抠出 `started subagent <uuid>` 的那个 id。
///
/// 不用正则：这里只需要定位一个固定前缀后面的 UUID 形状，手写扫描比引一个
/// regex 依赖进 core 更划算，也避免了 wasm 体积。
fn agent_id_in(text: &str) -> Option<String> {
    const MARK: &str = "started subagent ";
    let at = text.find(MARK)? + MARK.len();
    let rest = &text[at..];
    let id: String = rest
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
        .collect();
    // UUID 是 36 字符（8-4-4-4-12）。长度不对就是没匹配上，不返回半个 id。
    (id.len() == 36).then_some(id)
}

/// 把一个事件里所有字符串叶子拼起来找标记——`tool/result` 的文本埋在
/// `data.message.content[].content[].text` 里，逐层取太脆（DSH 的形状变过），
/// 拼平了找一个固定前缀更稳。
fn collect_text(v: &Value, out: &mut String) {
    match v {
        Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Array(a) => a.iter().for_each(|x| collect_text(x, out)),
        Value::Object(o) => o.values().for_each(|x| collect_text(x, out)),
        _ => {}
    }
}

/// 子代理启动列表，按发生顺序。每行：
/// `{seq, time, turn, step, call_id, agent_id, description}`。
pub fn subagent_spawns(events: &[Value]) -> Value {
    // 只看分叉之后——分叉前那些是上游会话派的活，属于上游自己那份审计。
    let events = &crate::util::post_fork(events)[..];

    // 第一遍：记下所有 subagent 调用（按 callId 索引，保留发生顺序）。
    let mut order: Vec<String> = Vec::new();
    let mut rows: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("tool/call") {
            continue;
        }
        let data = match e.get("data") {
            Some(d) => d,
            None => continue,
        };
        if data.get("name").and_then(|v| v.as_str()) != Some("subagent") {
            continue;
        }
        let call_id = match data.get("callId").and_then(|v| v.as_str()) {
            Some(c) => c.to_string(),
            None => continue,
        };
        // description 在 arguments 里（原始 JSON 字符串）。解析不出来就给 null，
        // 不猜一个标题——宁可少一列，不编一个。
        let description = data
            .get("arguments")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|a| a.get("description").and_then(|d| d.as_str()).map(str::to_string));
        order.push(call_id.clone());
        rows.insert(
            call_id.clone(),
            json!({
                "seq": e.get("seq").cloned().unwrap_or(Value::Null),
                "time": e.get("time").cloned().unwrap_or(Value::Null),
                "turn": data.get("turn").cloned().unwrap_or(Value::Null),
                "step": data.get("step").cloned().unwrap_or(Value::Null),
                "call_id": call_id,
                "agent_id": Value::Null,
                "description": description.map_or(Value::Null, Value::String),
            }),
        );
    }
    if order.is_empty() {
        return Value::Array(vec![]);
    }

    // 第二遍：把回执里的 agent_id 回填到对应的调用上。
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("tool/result") {
            continue;
        }
        let cid = match e.pointer("/data/message/source/callId").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => continue,
        };
        let Some(row) = rows.get_mut(cid) else { continue };
        let mut text = String::new();
        collect_text(e.get("data").unwrap_or(&Value::Null), &mut text);
        if let Some(id) = agent_id_in(&text) {
            row["agent_id"] = Value::String(id);
        }
    }

    Value::Array(order.into_iter().filter_map(|c| rows.remove(&c)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(seq: i64, turn: i64, cid: &str, desc: &str) -> Value {
        json!({"type": "tool/call", "seq": seq, "time": 1000 + seq,
               "data": {"turn": turn, "step": 1, "callId": cid, "name": "subagent",
                        "arguments": format!("{{\"description\":\"{desc}\",\"prompt\":\"…\"}}")}})
    }
    fn result(seq: i64, cid: &str, id: &str) -> Value {
        json!({"type": "tool/result", "seq": seq, "data": {"message": {
            "source": {"kind": "tool", "callId": cid},
            "content": [{"type": "tool-result", "content": [
                {"type": "text", "text": format!("started subagent {id}")}]}]}}})
    }

    const ID1: &str = "39f63b04-416d-4787-97a5-2963769019d0";
    const ID2: &str = "9cd8d819-f71d-4db1-a3dc-4ba01ad2562d";

    #[test]
    fn pairs_call_with_result_and_keeps_order() {
        let events = vec![
            call(1, 22, "c1", "Translate Rust output"),
            result(2, "c1", ID1),
            call(3, 24, "c2", "Translate doctor.rs"),
            result(4, "c2", ID2),
        ];
        let out = subagent_spawns(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["agent_id"], json!(ID1));
        assert_eq!(rows[0]["turn"], json!(22));
        assert_eq!(rows[0]["description"], json!("Translate Rust output"));
        assert_eq!(rows[1]["agent_id"], json!(ID2));
    }

    /// 回执没到 ≠ 这次启动没发生。行要留着，`agent_id` 给 null。
    #[test]
    fn spawn_without_result_is_kept_with_null_id() {
        let out = subagent_spawns(&[call(1, 5, "c1", "still starting")]);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "没有回执也要保留这一行");
        assert_eq!(rows[0]["agent_id"], Value::Null);
    }

    /// **分叉前派的活属于上游会话。**真实数据里 19 次调用只有最后 5 次是本会话
    /// 派的，其余 14 次是从上游 branch 时抄进来的历史——DSH 自己 UI 也只显示 5 个。
    #[test]
    fn spawns_before_fork_belong_to_upstream() {
        let events = vec![
            call(1, 22, "old", "上游派的活"),
            result(2, "old", ID1),
            json!({"type": "session", "seq": Value::Null, "data": {"seedLength": 4}}),
            call(4, 71, "mine", "本会话派的活"),
            result(5, "mine", ID2),
        ];
        let out = subagent_spawns(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 1, "分叉前那次是上游派的，不该算进本会话");
        assert_eq!(rows[0]["description"], json!("本会话派的活"));
    }

    /// 半个 id 不如没有 id：截断的文本不得产出一个短 uuid。
    #[test]
    fn truncated_id_is_rejected_not_half_returned() {
        assert_eq!(agent_id_in("started subagent 39f63b04-416d"), None);
        assert_eq!(agent_id_in("started subagent "), None);
        assert_eq!(agent_id_in(&format!("noise started subagent {ID1} more")), Some(ID1.to_string()));
    }

    /// 非 subagent 的工具调用一律不进列表。
    #[test]
    fn other_tools_are_ignored() {
        let events = vec![
            json!({"type": "tool/call", "seq": 1, "data": {"callId": "b", "name": "bash",
                   "arguments": "{\"command\":\"ls\"}"}}),
        ];
        assert_eq!(subagent_spawns(&events).as_array().unwrap().len(), 0);
    }
}
