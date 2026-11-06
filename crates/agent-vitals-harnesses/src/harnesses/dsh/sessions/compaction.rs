//! 上下文压缩事件 —— 时间线的 ✂ 标记，以及 FR-04b 结构性浪费的**实测**来源。
//!
//! 真实日志（session-e4b0be69）里是**两种不同机制**，不能混成一个概念：
//!
//! | 事件 | 载荷 | 含义 |
//! |---|---|---|
//! | `compaction/start` · `end` | `{compactionId, turn}` | 一次完整压缩的起止 |
//! | `compaction/summary` | `{compactionId, summary}` | 压缩产出的摘要正文 |
//! | `compaction/prune` | `{shadowedRange, shadowedSeqs, shadowedTokenCount}` | **增量剪除被遮蔽的内容** |
//!
//! `prune` 是这里最有价值的一条：`shadowedTokenCount` 是**执行环境自己算出来的被丢弃
//! token 数**——不是我们的 `est_tokens` 估算，是 harness 的测量值。FR-04b 要回答
//! 「哪些是浪费的」，与其自己写重复内容检测器再估算量级，不如直接用这个实测值。
//! 两者 provenance 不同，展示层必须分开标注（`context_composition` 那边是估算）。
//!
//! 实测形态：10 次 prune 全部落在 turn 85（同一次爆发），合计 33,099 token；
//! 而 turn 85 正是上下文峰值所在（799,841 / 1,000,000 = 80.0%）。完整压缩发生在
//! 两个 turn 之后的 turn 87。这条因果链是时间线要讲的故事，所以 turn 必须给准。

use serde_json::{Value, json};

use agent_vitals_domain::coords::Coords;

fn or_null(v: Option<i64>) -> Value {
    match v {
        Some(n) => json!(n),
        None => Value::Null,
    }
}

/// 事件流 → 压缩事件的结构化视图。
///
/// 输出：
/// ```text
/// {
///   "compactions": [{compaction_id, start_seq, start_time, turn, end_seq, has_summary}],
///   "prunes":      [{seq, time, turn, shadowed_token_count, shadowed_seq_count}],
///   "pruned_tokens_total": i64,
///   "prunes_without_token_count": i64
/// }
/// ```
///
/// **`pruned_tokens_total` 只累加真正上报了 `shadowedTokenCount` 的那些**，没上报
/// 的计入 `prunes_without_token_count` 单独暴露——与 `unreported_fields` 同一条
/// 纪律：缺口要看得见，但不能让一条畸形事件把整个有用的数字毁掉（那样就从
/// 「部分已知」退化成「完全未知」，反而更差）。
///
/// `turn`：`compaction/start` · `end` 自带；`prune` 不带，从 `turn/start` 顺延
/// （与 finding 坐标同一套 `Coords` 语义，turn 外为 null）。实测 10 次 prune
/// 顺延出来都是 turn 85，与它们紧邻的上下文峰值一致。
pub fn compaction_events(events: &[Value]) -> Value {
    // 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    // branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    // 对同一笔钱/同一批行为重复计数（见 util::fork_boundary 的实测数据）。
    let events = &agent_vitals_domain::util::post_fork(events)[..];
    let mut compactions: Vec<Value> = Vec::new();
    let mut prunes: Vec<Value> = Vec::new();
    let mut pruned_total: i64 = 0;
    let mut missing_count: i64 = 0;
    let mut coords = Coords::default();

    for event in events {
        if !event.is_object() {
            continue;
        }
        coords.observe(event);
        let Some(etype) = event.get("type").and_then(|v| v.as_str()) else { continue };
        if !etype.starts_with("compaction/") {
            continue;
        }
        let seq = event.get("seq").and_then(|v| v.as_i64());
        let time = event.get("time").and_then(|v| v.as_i64());
        let (turn, _step, _call_id) = coords.resolve(event);
        let id = event
            .pointer("/data/compactionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        match etype {
            "compaction/prune" => {
                let count = event
                    .pointer("/data/shadowedTokenCount")
                    .and_then(|v| v.as_i64());
                match count {
                    Some(n) => pruned_total += n,
                    None => missing_count += 1,
                }
                let seq_count = event
                    .pointer("/data/shadowedSeqs")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len() as i64);
                prunes.push(json!({
                    "seq": or_null(seq),
                    "time": or_null(time),
                    "turn": turn,
                    // 执行环境上报的实测值（不是 est_tokens 估算）；缺则 null。
                    "shadowed_token_count": or_null(count),
                    "shadowed_seq_count": or_null(seq_count),
                }));
            }
            "compaction/start" => {
                compactions.push(json!({
                    "compaction_id": id.map_or(Value::Null, Value::String),
                    "start_seq": or_null(seq),
                    "start_time": or_null(time),
                    "turn": turn,
                    "end_seq": Value::Null,
                    "has_summary": false,
                }));
            }
            "compaction/summary" | "compaction/end" => {
                // 按 compactionId 回填到对应的 start 上；找不到（只有 end 没有
                // start，例如日志被截断）就不硬造一条——宁缺勿造。
                let target = compactions.iter_mut().rev().find(|c| {
                    id.is_some() && c["compaction_id"].as_str() == id.as_deref()
                });
                if let Some(c) = target {
                    if let Some(obj) = c.as_object_mut() {
                        if etype == "compaction/end" {
                            obj.insert("end_seq".to_string(), or_null(seq));
                        } else {
                            obj.insert("has_summary".to_string(), json!(true));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    json!({
        "compactions": compactions,
        "prunes": prunes,
        "pruned_tokens_total": pruned_total,
        "prunes_without_token_count": missing_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// start/summary/end 按 compactionId 归并成一条；prune 单独成行并汇总。
    #[test]
    fn compaction_groups_by_id_and_sums_prunes() {
        let events = [
            json!({"type":"turn/start","seq":1,"time":1001,"data":{"turn":85}}),
            json!({"type":"compaction/prune","seq":2,"time":1002,"data":{
                "shadowedRange":{"start":10,"end":10},"shadowedSeqs":[10],
                "shadowedTokenCount":3367}}),
            json!({"type":"compaction/prune","seq":3,"time":1003,"data":{
                "shadowedRange":{"start":20,"end":21},"shadowedSeqs":[20,21],
                "shadowedTokenCount":2469}}),
            json!({"type":"turn/end","seq":4,"time":1004,"data":{"turn":85}}),
            json!({"type":"turn/start","seq":5,"time":1005,"data":{"turn":87}}),
            json!({"type":"compaction/start","seq":6,"time":1006,"data":{"compactionId":"c1","turn":87}}),
            json!({"type":"compaction/summary","seq":7,"time":1007,"data":{"compactionId":"c1","summary":[]}}),
            json!({"type":"compaction/end","seq":8,"time":1008,"data":{"compactionId":"c1","turn":87}}),
        ];
        let out = compaction_events(&events);

        assert_eq!(out["pruned_tokens_total"], json!(3367 + 2469));
        assert_eq!(out["prunes_without_token_count"], json!(0));
        let prunes = out["prunes"].as_array().unwrap();
        assert_eq!(prunes.len(), 2);
        // prune 不自带 turn —— 从 turn/start 顺延出 85
        assert_eq!(prunes[0]["turn"], json!(85), "prune 的 turn 靠顺延");
        assert_eq!(prunes[1]["shadowed_seq_count"], json!(2));

        let comps = out["compactions"].as_array().unwrap();
        assert_eq!(comps.len(), 1, "start/summary/end 归并成一条，不是三条");
        assert_eq!(comps[0]["compaction_id"], json!("c1"));
        assert_eq!(comps[0]["turn"], json!(87), "compaction/start 自带 turn");
        assert_eq!(comps[0]["end_seq"], json!(8));
        assert_eq!(comps[0]["has_summary"], json!(true));
    }

    /// Python `json.dumps(compaction_events(events), ensure_ascii=False,
    /// separators=(",", ":"))` 的逐字节对照。两侧各钉一次才是真差分——只钉这边
    /// 的话 Python 单方面改了输出仍会全绿（这条只硬编码字符串，不跑 Python）。
    #[test]
    fn compaction_python_rust_byte_for_byte_parity() {
        let events = [
            json!({"type":"turn/start","seq":1,"time":1001,"data":{"turn":85}}),
            json!({"type":"compaction/prune","seq":2,"time":1002,"data":{
                "shadowedRange":{"start":10,"end":10},"shadowedSeqs":[10],
                "shadowedTokenCount":3367}}),
            json!({"type":"compaction/prune","seq":3,"time":1003,"data":{
                "shadowedRange":{"start":20,"end":21},"shadowedSeqs":[20,21],
                "shadowedTokenCount":2469}}),
            json!({"type":"turn/end","seq":4,"time":1004,"data":{"turn":85}}),
            json!({"type":"turn/start","seq":5,"time":1005,"data":{"turn":87}}),
            json!({"type":"compaction/start","seq":6,"time":1006,"data":{"compactionId":"c1","turn":87}}),
            json!({"type":"compaction/summary","seq":7,"time":1007,"data":{"compactionId":"c1","summary":[]}}),
            json!({"type":"compaction/end","seq":8,"time":1008,"data":{"compactionId":"c1","turn":87}}),
        ];
        assert_eq!(
            serde_json::to_string(&compaction_events(&events)).unwrap(),
            r#"{"compactions":[{"compaction_id":"c1","start_seq":6,"start_time":1006,"turn":87,"end_seq":8,"has_summary":true}],"prunes":[{"seq":2,"time":1002,"turn":85,"shadowed_token_count":3367,"shadowed_seq_count":1},{"seq":3,"time":1003,"turn":85,"shadowed_token_count":2469,"shadowed_seq_count":2}],"pruned_tokens_total":5836,"prunes_without_token_count":0}"#
        );
    }

    /// 缺 `shadowedTokenCount` 的 prune：不计入合计，单独暴露计数。
    ///
    /// 两种错误做法都要避免：①当 0 累加（把「没上报」伪造成「剪掉了 0」）；
    /// ②让整个合计变 null（一条畸形事件把其余 9 条的有用信息也毁掉，
    /// 从「部分已知」退化成「完全未知」，反而更差）。
    #[test]
    fn compaction_prune_missing_token_count_is_surfaced_not_summed() {
        let events = [
            json!({"type":"compaction/prune","seq":1,"data":{"shadowedTokenCount":100}}),
            json!({"type":"compaction/prune","seq":2,"data":{"shadowedSeqs":[5]}}), // 缺 count
        ];
        let out = compaction_events(&events);
        assert_eq!(out["pruned_tokens_total"], json!(100), "只累加上报了的");
        assert_eq!(out["prunes_without_token_count"], json!(1), "缺口必须可见");
        assert_eq!(out["prunes"][1]["shadowed_token_count"], Value::Null, "缺则 null，不是 0");
    }

    /// 只有 end 没有 start（日志被截断）：不硬造一条 compaction。
    #[test]
    fn compaction_orphan_end_does_not_fabricate_a_record() {
        let events = [
            json!({"type":"compaction/end","seq":1,"data":{"compactionId":"ghost","turn":9}}),
        ];
        let out = compaction_events(&events);
        assert_eq!(out["compactions"], json!([]), "没有 start 就没有这次压缩，宁缺勿造");
    }

    /// 无压缩事件：空列表 + 合计 0（「读全了，确实没发生压缩」）。
    #[test]
    fn compaction_absent_gives_empty_not_null() {
        let out = compaction_events(&[json!({"type":"tool/call","seq":1,"data":{}})]);
        assert_eq!(out["compactions"], json!([]));
        assert_eq!(out["prunes"], json!([]));
        assert_eq!(out["pruned_tokens_total"], json!(0));
    }
}
