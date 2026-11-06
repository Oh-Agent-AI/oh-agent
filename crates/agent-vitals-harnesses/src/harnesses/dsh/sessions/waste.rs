//! FR-04b 结构性浪费识别 —— 回答"哪些是浪费的"与"我该怎么办"。
//!
//! **结构性浪费**是规则可直接判定、不需要历史基线的浪费模式（PRD FR-04b）；
//! 与"相对浪费"（缓存命中率偏低等，需要基线才能判断）是两回事，混进来会破坏
//! FR-05 的"无基线不告警"原则。这个模块只做前者。
//!
//! V2 覆盖两种模式：
//!
//! 1. **重复工具结果**：同一个调用（同名 + 同参数）在不同 turn 里反复得到
//!    完全相同的结果。第一次是必要的工作，后续每一次都是纯浪费——`waste_tokens`
//!    按 `est_tokens(内容) × (次数 − 1)` 计。
//! 2. **失败重试的上下文增量**：连续 ≥3 次工具失败之后，上下文实际增长了多少
//!    （通过 `request_metrics` 前后两次请求的 `context_tokens` 差值衡量）——
//!    这是失败重试**真正付出的代价**，不是次数本身。
//!
//! 一条明确排除的候选：`compaction::compaction_events` 的 `prune`。查过真实
//! 日志（session-e4b0be69）的 10 次 prune 具体剪了什么——全部是 turn 3 到
//! turn 60 里互不相同的一次性内容，不是重复读取。那是上下文正常老化被清理，
//! 不是浪费；把它标成"结构性浪费"会让用户觉得系统在冤枉自己的正常行为。

use std::collections::HashMap;

use serde_json::Value;

use super::evidence::tool_invocation;
use agent_vitals_domain::util::{est_tokens, find_next_request, find_request};

const MIN_REPEAT_TURNS: usize = 2; // 至少跨 2 个不同 turn 才算"重复"，同一 turn 内多次调用不算
const MIN_FAILED_RESULTS: usize = 3; // 与 trajectory.rs 的 SV613b 阈值一致（概念对齐，各自独立扫描）

fn or_null(v: Option<i64>) -> Value {
    v.map_or(Value::Null, |n| serde_json::json!(n))
}

/// 从工具参数（原始 JSON 字符串或已解析对象拍平后的文本）里挑一个人能看懂的
/// "目标"标签，用于建议文案。按常见字段名优先取值，取不到就截断原始文本。
/// 纯展示用途，取不到不算错误。
fn extract_target(args_text: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<Value>(args_text) {
        for key in ["path", "file_path", "url", "command", "pattern"] {
            if let Some(s) = parsed.get(key).and_then(|v| v.as_str()) {
                return s.chars().take(60).collect();
            }
        }
    }
    args_text.chars().take(60).collect()
}

/// 事件里能拿到的 `(turn, step, seq, time, call_id)`——都是事件自带字段，
/// 不需要 `Coords` 顺延：`tool/call`/`tool/result` 在真实日志里 100% 自带
/// turn/step，`tool/call` 100% 自带 callId。
fn coords_of(event: &Value) -> (Value, Value, Value, Value, Value) {
    (
        event.pointer("/data/turn").and_then(|v| v.as_i64()).map_or(Value::Null, |n| serde_json::json!(n)),
        event.pointer("/data/step").and_then(|v| v.as_i64()).map_or(Value::Null, |n| serde_json::json!(n)),
        or_null(event.get("seq").and_then(|v| v.as_i64())),
        or_null(event.get("time").and_then(|v| v.as_i64())),
        Value::Null,
    )
}

/// 重复工具结果：同一个 (工具名, 参数) 在 ≥2 个不同 turn 里得到完全相同的结果。
///
/// 相关性判定分两层：先按 `(tool_name, args)` 分组（模型问了同一个问题），再要求
/// 结果内容也逐字节相同（真的是重复劳动，不是同一请求换了个答案）。只按输出内容
/// 分组会把"两次都读到空文件"这种巧合也算进来，语义上站不住。
///
/// 真实日志（session-e4b0be69）验证：796 个不同 (工具, 内容) 组合，0 组重复——
/// 这份日志是正经的开发会话，没有病态重复读取。检测器在干净数据上不该报假阳性，
/// 这条本身就是负向测试。
pub fn detect_duplicate_tool_results(events: &[Value]) -> Vec<Value> {
    // callId -> (tool_name, args_text)
    let mut calls: HashMap<String, (String, String)> = HashMap::new();
    for event in events {
        if !event.is_object() {
            continue;
        }
        let Some((name, args)) = tool_invocation(event) else { continue };
        if let Some(call_id) = event.pointer("/data/callId").and_then(|v| v.as_str()) {
            calls.insert(call_id.to_string(), (name.to_string(), args));
        }
    }

    // (tool_name, args, content) -> occurrences [(turn, seq, time, step, call_id)]
    type Occ = (Value, Value, Value, Value, String);
    let mut groups: HashMap<(String, String, String), Vec<Occ>> = HashMap::new();

    for event in events {
        if !event.is_object() || event.get("type").and_then(|v| v.as_str()) != Some("tool/result") {
            continue;
        }
        let Some(call_id) = event.pointer("/data/message/source/callId").and_then(|v| v.as_str())
        else {
            continue;
        };
        let Some((name, args)) = calls.get(call_id) else { continue };
        let Some(content) = event.pointer("/data/message/content") else { continue };
        let content_text = serde_json::to_string(content).unwrap_or_default();
        let (turn, step, seq, time, _) = coords_of(event);
        groups
            .entry((name.clone(), args.clone(), content_text))
            .or_default()
            .push((turn, seq, time, step, call_id.to_string()));
    }

    let mut out = Vec::new();
    // HashMap 迭代顺序不确定 —— 按第一次出现的 seq 排序，保证跨平台确定性
    // （与 trajectory.rs 的 SV614a 按 callId 排序是同一条纪律）。
    let mut sorted: Vec<_> = groups.into_iter().collect();
    sorted.sort_by_key(|(_, occs)| occs[0].1.as_i64().unwrap_or(i64::MAX));

    for ((tool_name, args, content_text), occs) in sorted {
        let distinct_turns: std::collections::HashSet<i64> =
            occs.iter().filter_map(|o| o.0.as_i64()).collect();
        if distinct_turns.len() < MIN_REPEAT_TURNS {
            continue;
        }
        let turn_min = distinct_turns.iter().min().copied();
        let turn_max = distinct_turns.iter().max().copied();
        let waste_tokens = est_tokens(&content_text) * (occs.len() as i64 - 1);
        let target = extract_target(&args);
        let (turn, seq, time, step, call_id) = occs[0].clone();

        let evidence = match (turn_min, turn_max) {
            (Some(a), Some(b)) if a != b => format!(
                "{tool_name} 结果在 T{a}–T{b} 内容相同（重复 {} 次）",
                occs.len()
            ),
            _ => format!("{tool_name} 结果重复出现 {} 次，内容相同", occs.len()),
        };

        out.push(serde_json::json!({
            "rule": "SV-COST-01",
            "severity": "info",
            "category": "cost",
            "tool_name": tool_name,
            "evidence": evidence,
            "seq": seq,
            "time": time,
            "turn": turn,
            "step": step,
            "call_id": json_or_null_str(&call_id),
            "evidence_recency": "log",
            "waste_tokens": waste_tokens,
            "suggestion": format!(
                "确认是否需要在每个 turn 重新调用「{tool_name}」处理「{target}」；如果内容不会变化，可以只调用一次并复用结果。"
            ),
        }));
    }
    out
}

fn json_or_null_str(s: &str) -> Value {
    if s.is_empty() { Value::Null } else { serde_json::json!(s) }
}

/// 失败重试的上下文增量：连续 ≥3 次工具失败之后，上下文实际增长了多少。
///
/// 增量是**真正付出的代价**，不是失败次数本身——次数已经由 SV613 报了。这里
/// 用 `request_metrics` 里失败发生前后两次请求的 `context_tokens` 差值衡量：
/// 失败结果被塞回上下文、模型往复重试，这段增量此后一直占着位置直到被压缩。
///
/// `requests` 必须是 `usage::request_metrics` 的输出（同一批 usage_events）；
/// 找不到匹配的请求行（该 turn/step 没有 usage 样本）时跳过——不拿其他 turn
/// 的数字硬凑，AC-08 要求"缺一不得展示"，数据层同一条纪律。
pub fn detect_failure_run_waste(events: &[Value], requests: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut run: Vec<(i64, i64, i64, i64, String)> = Vec::new(); // (turn, step, seq, time, code)

    let flush = |run: &mut Vec<(i64, i64, i64, i64, String)>, out: &mut Vec<Value>| {
        if run.len() >= MIN_FAILED_RESULTS {
            emit_failure_waste(run, requests, out);
        }
        run.clear();
    };

    for event in events {
        if !event.is_object() || event.get("type").and_then(|v| v.as_str()) != Some("tool/result") {
            continue;
        }
        let code = event.pointer("/data/error/code").and_then(|v| v.as_str());
        match code {
            Some(code) => {
                let turn = event.pointer("/data/turn").and_then(|v| v.as_i64());
                let step = event.pointer("/data/step").and_then(|v| v.as_i64());
                let seq = event.get("seq").and_then(|v| v.as_i64());
                let time = event.get("time").and_then(|v| v.as_i64());
                if let (Some(turn), Some(step), Some(seq), Some(time)) = (turn, step, seq, time) {
                    run.push((turn, step, seq, time, code.to_string()));
                }
            }
            None => flush(&mut run, &mut out),
        }
    }
    flush(&mut run, &mut out);
    out
}

fn emit_failure_waste(
    run: &[(i64, i64, i64, i64, String)],
    requests: &[Value],
    out: &mut Vec<Value>,
) {
    let (start_turn, start_step, start_seq, start_time, first_code) = &run[0];
    let (end_turn, ..) = run[run.len() - 1];

    let Some(r_start) = find_request(requests, *start_turn, *start_step) else { return };
    let Some(start_seq_n) = r_start["request_seq"].as_i64() else { return };
    let Some(r_after) = find_next_request(requests, start_seq_n) else { return };

    let (Some(before), Some(after)) =
        (r_start["context_tokens"].as_i64(), r_after["context_tokens"].as_i64())
    else {
        return; // 缺分子——诚实跳过，不拿 null 参与算术
    };
    let waste_tokens = after - before;
    if waste_tokens <= 0 {
        return; // 没有净增长就不是浪费，不倒扣出一个负数
    }

    let evidence = if end_turn != *start_turn {
        format!(
            "连续 {} 次工具失败（首个 {first_code}），T{start_turn}–T{end_turn} 期间上下文增长 {waste_tokens} token",
            run.len()
        )
    } else {
        format!(
            "连续 {} 次工具失败（首个 {first_code}），T{start_turn} 期间上下文增长 {waste_tokens} token",
            run.len()
        )
    };

    out.push(serde_json::json!({
        "rule": "SV-COST-02",
        "severity": "info",
        "category": "cost",
        "tool_name": Value::Null,
        "evidence": evidence,
        "seq": start_seq,
        "time": start_time,
        "turn": start_turn,
        "step": start_step,
        "call_id": Value::Null,
        "evidence_recency": "log",
        "waste_tokens": waste_tokens,
        "suggestion": "检查失败原因（工具参数、权限或环境问题）；重试前先确认根因，避免同一错误被反复携带进后续上下文。",
    }));
}

/// 两个检测器的合集，按 seq 排序追加——与 `match_behavior`/`match_trajectory`
/// 的追加顺序同一条纪律（字节序稳定）。
pub fn detect_structural_waste(events: &[Value], requests: &[Value]) -> Vec<Value> {
    // 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    // branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    // 对同一笔钱/同一批行为重复计数（见 util::fork_boundary 的实测数据）。
    let events = &agent_vitals_domain::util::post_fork(events)[..];
    let mut out = Vec::new();
    out.extend(detect_duplicate_tool_results(events));
    out.extend(detect_failure_run_waste(events, requests));
    out.sort_by_key(|f| f["seq"].as_i64().unwrap_or(i64::MAX));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool_call(name: &str, args: &str, turn: i64, step: i64, call_id: &str, seq: i64) -> Value {
        json!({"type":"tool/call","seq":seq,"time":1000+seq,
              "data":{"turn":turn,"step":step,"callId":call_id,"name":name,"arguments":args}})
    }

    fn tool_result(call_id: &str, turn: i64, step: i64, content: Value, seq: i64) -> Value {
        json!({"type":"tool/result","seq":seq,"time":1000+seq,
              "data":{"turn":turn,"step":step,
                      "message":{"source":{"kind":"tool","callId":call_id},"content":content}}})
    }

    fn tool_result_err(call_id: &str, turn: i64, step: i64, code: &str, seq: i64) -> Value {
        json!({"type":"tool/result","seq":seq,"time":1000+seq,
              "data":{"turn":turn,"step":step,
                      "message":{"source":{"kind":"tool","callId":call_id},"content":[]},
                      "error":{"name":"E","code":code}}})
    }

    /// 同一份 config.yaml 在 T1/T2/T3 读到完全相同的内容 → 报一条，浪费按
    /// (次数-1) × 内容 token 计（第一次是必要工作）。
    #[test]
    fn duplicate_across_turns_reports_once_with_n_minus_one_waste() {
        let content = json!([{"type":"text","text":"key: value\nother: 1"}]);
        let events = vec![
            tool_call("read", r#"{"path":"config.yaml"}"#, 1, 1, "c1", 1),
            tool_result("c1", 1, 1, content.clone(), 2),
            tool_call("read", r#"{"path":"config.yaml"}"#, 2, 1, "c2", 3),
            tool_result("c2", 2, 1, content.clone(), 4),
            tool_call("read", r#"{"path":"config.yaml"}"#, 3, 1, "c3", 5),
            tool_result("c3", 3, 1, content.clone(), 6),
        ];
        let out = detect_duplicate_tool_results(&events);
        assert_eq!(out.len(), 1);
        let f = &out[0];
        assert_eq!(f["rule"], json!("SV-COST-01"));
        assert_eq!(f["tool_name"], json!("read"));
        assert_eq!(f["turn"], json!(1), "锚点是第一次出现");
        let one_copy = est_tokens("[{\"type\":\"text\",\"text\":\"key: value\\nother: 1\"}]");
        assert_eq!(f["waste_tokens"], json!(one_copy * 2), "3 次出现，浪费 = 2 份多余拷贝");
        assert!(f["suggestion"].as_str().unwrap().contains("config.yaml"),
               "建议文案要点名具体目标，不是空泛的\"优化上下文\"");
    }

    /// 同一 turn 内调用两次不算"重复"——PRD 的例子是跨 turn 反复读，同一 turn
    /// 内连续两次更像是同一个工作单元里的正常校验，不该被扣上浪费的帽子。
    #[test]
    fn same_turn_repeat_does_not_count() {
        let content = json!([{"type":"text","text":"x"}]);
        let events = vec![
            tool_call("read", r#"{"path":"a"}"#, 1, 1, "c1", 1),
            tool_result("c1", 1, 1, content.clone(), 2),
            tool_call("read", r#"{"path":"a"}"#, 1, 2, "c2", 3),
            tool_result("c2", 1, 2, content, 4),
        ];
        assert_eq!(detect_duplicate_tool_results(&events), Vec::<Value>::new());
    }

    /// 参数不同、结果碰巧一样（比如两次都读到空文件）不算重复——分组键必须
    /// 同时看参数和内容，只看内容会把巧合当成浪费。
    #[test]
    fn same_content_different_args_does_not_count() {
        let empty = json!([{"type":"text","text":""}]);
        let events = vec![
            tool_call("read", r#"{"path":"a.txt"}"#, 1, 1, "c1", 1),
            tool_result("c1", 1, 1, empty.clone(), 2),
            tool_call("read", r#"{"path":"b.txt"}"#, 2, 1, "c2", 3),
            tool_result("c2", 2, 1, empty, 4),
        ];
        assert_eq!(detect_duplicate_tool_results(&events), Vec::<Value>::new());
    }

    /// 内容不同不算重复——同一个文件被读了两次但内容变了（比如中途被 edit
    /// 过），这是正常工作流程，不是浪费。
    #[test]
    fn different_content_does_not_count() {
        let events = vec![
            tool_call("read", r#"{"path":"a"}"#, 1, 1, "c1", 1),
            tool_result("c1", 1, 1, json!([{"type":"text","text":"v1"}]), 2),
            tool_call("read", r#"{"path":"a"}"#, 2, 1, "c2", 3),
            tool_result("c2", 2, 1, json!([{"type":"text","text":"v2"}]), 4),
        ];
        assert_eq!(detect_duplicate_tool_results(&events), Vec::<Value>::new());
    }

    /// 真实场景的负向测试：不同 (工具,参数) 各自只出现一次——干净数据上
    /// 检测器不该报任何东西（真实日志 796 组、0 重复，这是同一条纪律的单测版）。
    #[test]
    fn no_false_positives_on_all_distinct_calls() {
        let events = vec![
            tool_call("read", r#"{"path":"a"}"#, 1, 1, "c1", 1),
            tool_result("c1", 1, 1, json!([{"type":"text","text":"1"}]), 2),
            tool_call("read", r#"{"path":"b"}"#, 2, 1, "c2", 3),
            tool_result("c2", 2, 1, json!([{"type":"text","text":"2"}]), 4),
        ];
        assert_eq!(detect_duplicate_tool_results(&events), Vec::<Value>::new());
    }

    /// 失败区间的上下文增量：连续 3 次失败之后，紧接着的下一次请求上下文
    /// 涨了多少——这是真正付出的代价，不是失败次数本身。
    #[test]
    fn failure_run_waste_measures_context_growth_across_the_boundary() {
        let events = vec![
            tool_result_err("c1", 5, 2, "FS_NOT_OBSERVED", 10),
            tool_result_err("c2", 5, 2, "FS_NOT_OBSERVED", 11),
            tool_result_err("c3", 5, 2, "FS_NOT_OBSERVED", 12),
        ];
        let requests = vec![
            json!({"request_seq":1,"turn":5,"step":1,"context_tokens":1000}),
            json!({"request_seq":2,"turn":5,"step":2,"context_tokens":1200}),
            json!({"request_seq":3,"turn":5,"step":3,"context_tokens":1900}),
        ];
        let out = detect_failure_run_waste(&events, &requests);
        assert_eq!(out.len(), 1);
        let f = &out[0];
        assert_eq!(f["rule"], json!("SV-COST-02"));
        assert_eq!(f["waste_tokens"], json!(700), "1900 - 1200，不是失败次数");
        assert_eq!(f["turn"], json!(5));
        assert_eq!(f["step"], json!(2), "锚点是失败区间的起点");
    }

    /// 不足阈值（<3 次）不报——与 SV613b 的连续失败阈值概念对齐。
    #[test]
    fn failure_run_below_threshold_is_not_reported() {
        let events = vec![
            tool_result_err("c1", 1, 1, "X", 1),
            tool_result_err("c2", 1, 1, "X", 2),
        ];
        let requests = vec![
            json!({"request_seq":1,"turn":1,"step":1,"context_tokens":100}),
            json!({"request_seq":2,"turn":1,"step":2,"context_tokens":900}),
        ];
        assert_eq!(detect_failure_run_waste(&events, &requests), Vec::<Value>::new());
    }

    /// 找不到匹配的请求行（该 turn/step 没有 usage 样本）就跳过——不拿其他
    /// turn 的数字硬凑一个假的增量。AC-08"缺一不得展示"，数据层同一条纪律。
    #[test]
    fn failure_run_without_matching_request_row_is_skipped() {
        let events = vec![
            tool_result_err("c1", 99, 1, "X", 1),
            tool_result_err("c2", 99, 1, "X", 2),
            tool_result_err("c3", 99, 1, "X", 3),
        ];
        let requests = vec![json!({"request_seq":1,"turn":1,"step":1,"context_tokens":100})];
        assert_eq!(detect_failure_run_waste(&events, &requests), Vec::<Value>::new());
    }

    /// 上下文没有净增长（甚至下降，比如恰好在此期间发生了 compaction）就不算
    /// 浪费——不倒扣出一个负数当"浪费"。
    #[test]
    fn failure_run_with_no_context_growth_is_skipped() {
        let events = vec![
            tool_result_err("c1", 1, 1, "X", 1),
            tool_result_err("c2", 1, 1, "X", 2),
            tool_result_err("c3", 1, 1, "X", 3),
        ];
        let requests = vec![
            json!({"request_seq":1,"turn":1,"step":1,"context_tokens":5000}),
            json!({"request_seq":2,"turn":1,"step":2,"context_tokens":1000}), // 压缩发生在这之间
        ];
        assert_eq!(detect_failure_run_waste(&events, &requests), Vec::<Value>::new());
    }

    /// 真实数据回归：session-e4b0be69 的失败串在 turn 70 step 2。`context_tokens`
    /// 是 `uncachedInputTokens + cacheReadTokens`（不是只有 uncached——这个坑我
    /// 自己手算时就踩过一次：只用 inputTokens 算出 2092，漏了 cacheReadTokens，
    /// 跑真实管线才发现真实值是 1964。这条把真实数字钉成回归用例，用完整口径。
    #[test]
    fn failure_run_waste_matches_real_session_regression() {
        let events = vec![
            tool_result_err("c1", 70, 2, "FS_NOT_OBSERVED", 440338),
            tool_result_err("c2", 70, 2, "FS_NOT_OBSERVED", 440340),
            tool_result_err("c3", 70, 2, "FS_NOT_OBSERVED", 440342),
            tool_result_err("c4", 70, 2, "FS_NOT_OBSERVED", 440344),
            tool_result_err("c5", 70, 2, "FS_NOT_OBSERVED", 440346),
        ];
        // context_tokens = inputTokens + cacheReadTokens：681893+1664=683557，683985+1536=685521
        let requests = vec![
            json!({"request_seq":1,"turn":70,"step":1,"context_tokens":681_742}),
            json!({"request_seq":2,"turn":70,"step":2,"context_tokens":683_557}),
            json!({"request_seq":3,"turn":70,"step":3,"context_tokens":685_521}),
        ];
        let out = detect_failure_run_waste(&events, &requests);
        assert_eq!(out[0]["waste_tokens"], json!(1964));
    }

    #[test]
    fn empty_input_gives_empty_output() {
        assert_eq!(detect_structural_waste(&[], &[]), Vec::<Value>::new());
    }

    /// Python `json.dumps(detect_structural_waste(events, requests),
    /// ensure_ascii=False, separators=(",", ":"))` 的逐字节对照——两侧各钉
    /// 一次才是真差分（同一条纪律见 `request_metrics_python_rust_byte_for_byte_parity`）。
    #[test]
    fn structural_waste_python_rust_byte_for_byte_parity() {
        let content = json!([{"type":"text","text":"key: value\nother: 1"}]);
        let events = vec![
            tool_call("read", r#"{"path":"config.yaml"}"#, 1, 1, "c1", 1),
            tool_result("c1", 1, 1, content.clone(), 2),
            tool_call("read", r#"{"path":"config.yaml"}"#, 2, 1, "c2", 3),
            tool_result("c2", 2, 1, content.clone(), 4),
            tool_call("read", r#"{"path":"config.yaml"}"#, 3, 1, "c3", 5),
            tool_result("c3", 3, 1, content, 6),
            tool_result_err("c4", 70, 2, "FS_NOT_OBSERVED", 440338),
            tool_result_err("c5", 70, 2, "FS_NOT_OBSERVED", 440340),
            tool_result_err("c6", 70, 2, "FS_NOT_OBSERVED", 440342),
        ];
        let requests = vec![
            json!({"request_seq":1,"turn":70,"step":1,"context_tokens":681584}),
            json!({"request_seq":2,"turn":70,"step":2,"context_tokens":681893}),
            json!({"request_seq":3,"turn":70,"step":3,"context_tokens":683985}),
        ];
        assert_eq!(
            serde_json::to_string(&detect_structural_waste(&events, &requests)).unwrap(),
            r#"[{"rule":"SV-COST-01","severity":"info","category":"cost","tool_name":"read","evidence":"read 结果在 T1–T3 内容相同（重复 3 次）","seq":2,"time":1002,"turn":1,"step":1,"call_id":"c1","evidence_recency":"log","waste_tokens":28,"suggestion":"确认是否需要在每个 turn 重新调用「read」处理「config.yaml」；如果内容不会变化，可以只调用一次并复用结果。"},{"rule":"SV-COST-02","severity":"info","category":"cost","tool_name":null,"evidence":"连续 3 次工具失败（首个 FS_NOT_OBSERVED），T70 期间上下文增长 2092 token","seq":440338,"time":441338,"turn":70,"step":2,"call_id":null,"evidence_recency":"log","waste_tokens":2092,"suggestion":"检查失败原因（工具参数、权限或环境问题）；重试前先确认根因，避免同一错误被反复携带进后续上下文。"}]"#
        );
    }
}
