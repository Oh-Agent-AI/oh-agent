//! 和上一次扫描对比。
//!
//! 本工具自己规定「装不够 N 天的不算僵尸，2–3 周后复查」，但复查时没人记得
//! 基线。这个模块就是让那条建议闭环的。

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::skills::doctor::DEFAULT_OVERLAP_MIN;
use agent_vitals_domain::skills::overlap::{overlap_pairs, OverlapOpts};
use crate::util::read_lossy;

/// 复刻 Python 的 `OSError` 文本形态：`[Errno 2] No such file or directory: '<path>'`。
///
/// 不能只写「打不开」—— 权限不足、路径是目录、符号链接成环，用户看到的是
/// 同一句话，排查时等于没说。错误信息的价值全在于它区分了什么。
fn io_reason(p: &std::path::Path) -> String {
    match std::fs::File::open(p) {
        Ok(_) => "unknown".to_string(),
        Err(e) => {
            let code = e.raw_os_error().map(|c| format!("[Errno {}] ", c)).unwrap_or_default();
            let kind = match e.kind() {
                std::io::ErrorKind::NotFound => "No such file or directory".to_string(),
                std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
                _ => e.to_string(),
            };
            format!("{}{}: '{}'", code, kind, p.display())
        }
    }
}

/// 比对用的键：`(harness, instance_id, namespace, name)`。
///
/// **不能只用 name。**同名 skill 在两个执行环境里不是同一个，插件里的
/// `<plugin>:<name>` 也各自独立 —— 只按名字建键会把它们并成一条，diff 于是
/// 把「A 执行环境删了一个、B 执行环境加了一个」报成「没变化」。
/// 这与 `plugin_identity` 那次「版本号被当成命名空间」是同一类错误：
/// 去重键取粗了，不同的东西被并成一个。
type Key = (String, String, String, String);

fn key_of(s: &Value) -> Key {
    let harness = s
        .get("harness_family")
        .and_then(|v| v.as_str())
        .or_else(|| s.get("harness").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    // Python 侧把 None 归一成空串再逐字段比较；这里必须同口径，否则两个实现
    // 的 added_skills 顺序会不一样。
    let instance = s.get("instance_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let namespace = s.get("namespace").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    (harness, instance, namespace, name)
}

fn entry_of(s: &Value) -> Value {
    // 有名字段，不是裸数组：裸数组会让脱敏把执行环境名当成 skill 名收录并全文
    // 替换（见 tests/test_diff_end_to_end.py::TestRedactionDoesNotEatTheHarnessName）。
    json!({
        "harness": s.get("harness_family").cloned()
                 .or_else(|| s.get("harness").cloned()).unwrap_or(Value::Null),
        "instance_id": s.get("instance_id").cloned().unwrap_or(Value::Null),
        "namespace": s.get("namespace").and_then(|v| v.as_str()).unwrap_or(""),
        "name": s.get("name").cloned().unwrap_or(Value::Null),
    })
}

fn loaded_map(d: &Value) -> HashMap<Key, Value> {
    let mut out = HashMap::new();
    if let Some(arr) = d.get("skills").and_then(|v| v.as_array()) {
        for s in arr {
            if s.get("loaded").and_then(|v| v.as_bool()) == Some(true) {
                out.insert(key_of(s), s.clone());
            }
        }
    }
    out
}

/// 一份文档里的重叠对，`(a, b)` 已按字典序归一。
fn overlap_keys(doc: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let v = overlap_pairs(doc, &OverlapOpts { min: DEFAULT_OVERLAP_MIN, top: None });
    if let Some(arr) = v.as_array() {
        for p in arr {
            let a = p.get("a").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let b = p.get("b").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let k = if a <= b { (a, b) } else { (b, a) };
            if !out.contains(&k) {
                out.push(k);
            }
        }
    }
    out
}

fn usage_of(s: &Value) -> i64 {
    s.get("usage_count").and_then(|v| v.as_i64()).unwrap_or(0)
}

fn days_of(s: &Value) -> f64 {
    s.get("installed_days_ago")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

fn sec_keys(d: &Value) -> Vec<(String, String, String, i64)> {
    let mut out = Vec::new();
    let flagged = d
        .get("security")
        .and_then(|v| v.get("flagged"))
        .and_then(|v| v.as_array());
    if let Some(list) = flagged {
        for s in list {
            let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(fs) = s.get("findings").and_then(|v| v.as_array()) {
                for f in fs {
                    let k = (
                        name.clone(),
                        f.get("rule").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        f.get("where").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        f.get("line").and_then(|v| v.as_i64()).unwrap_or(0),
                    );
                    if !out.contains(&k) {
                        out.push(k);
                    }
                }
            }
        }
    }
    out
}

pub fn diff_against(prev_path: &Path, now: &Value) -> Value {
    let text = match read_lossy(prev_path) {
        Some(t) => t,
        None => {
            return json!({
                "error": format!("Cannot read baseline file {}: {}",
                                 prev_path.display(), io_reason(prev_path))
            })
        }
    };
    let prev: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "error": format!("Cannot read baseline file {}: {}", prev_path.display(), e)
            })
        }
    };

    // **合法 JSON ≠ 一份扫描记录。**不校验的话，`{"skills": "not-a-list"}`
    // 会被当成「基线里有 0 个 skill」，于是当前每一个 skill 都被报成新增 ——
    // 一个静默且完全错误的结论。宁可拒绝，也不要编一份对比出来。
    if !prev.get("skills").map(|v| v.is_array()).unwrap_or(false) {
        return json!({
            "error": format!("Baseline file {} is not a scan report \
(missing a `skills` array)", prev_path.display())
        });
    }

    let a = loaded_map(&prev);
    let b = loaded_map(now);

    let empty = Map::new();
    let pb = prev
        .get("description_budget")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);
    let nb = now
        .get("description_budget")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);

    // 键是四元组，`sort()` 即逐字段字典序 —— 与 Python 的 `_sorted_keys`
    // 同口径（把 None 归一成空串后逐字段比较）。
    let mut both: Vec<&Key> = a.keys().filter(|k| b.contains_key(*k)).collect();
    both.sort();

    // 这三处的字段**必须与 Python 的 dict 字面量同名同序**：harness / instance_id
    // / namespace 曾经在 Rust 侧整个缺失，而 diff 从不进 golden，没有测试抓到。
    fn ident(v: &Value) -> (Value, Value, String) {
        (
            v.get("harness_family").cloned().or_else(|| v.get("harness").cloned())
                .unwrap_or(Value::Null),
            v.get("instance_id").cloned().unwrap_or(Value::Null),
            v.get("namespace").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        )
    }

    let mut used_more: Vec<Value> = Vec::new();
    for k in &both {
        let delta = usage_of(&b[*k]) - usage_of(&a[*k]);
        if delta != 0 {
            let (harness, instance, ns) = ident(&b[*k]);
            used_more.push(json!({
                "name": k.3, "harness": harness, "instance_id": instance, "namespace": ns,
                "delta": delta, "now": usage_of(&b[*k]),
            }));
        }
    }
    // 稳定排序：增量相同的按名字保持已排好的顺序
    used_more.sort_by_key(|x| -x["delta"].as_i64().unwrap_or(0));

    let gate = prev
        .get("trigger_data")
        .and_then(|v| v.get("zombie_min_age_days"))
        .and_then(|v| v.as_f64())
        .unwrap_or(14.0);

    // 上次太新不能判、这次够岁数了的 —— 这批才是新的僵尸判定对象
    let newly_judgeable: Vec<Value> = both
        .iter()
        .filter(|k| days_of(&a[*k]) < gate && gate <= days_of(&b[*k]))
        .map(|k| {
            let (harness, instance, ns) = ident(&b[*k]);
            json!({
                "name": k.3, "harness": harness, "instance_id": instance, "namespace": ns,
                "usage_count": usage_of(&b[*k]),
                "installed_days_ago": b[*k].get("installed_days_ago").cloned()
                    .unwrap_or(Value::Null),
                "verdict": if usage_of(&b[*k]) == 0 { "zombie" } else { "alive" },
            })
        })
        .collect();

    // 新增的字面重叠对。**只报新增的** —— 老的那些在上次报告里已经出现过，
    // 重报一遍会把「这次多出来什么」淹掉，而 diff 只该回答后者。
    let prev_ov = overlap_keys(&prev);
    let mut new_pairs: Vec<(String, String)> = overlap_keys(now)
        .into_iter()
        .filter(|k| !prev_ov.contains(k))
        .collect();
    new_pairs.sort();

    let prev_keys = sec_keys(&prev);
    let mut new_sec: Vec<_> = sec_keys(now)
        .into_iter()
        .filter(|k| !prev_keys.contains(k))
        .collect();
    new_sec.sort();

    let mut added: Vec<&Key> = b.keys().filter(|k| !a.contains_key(*k)).collect();
    added.sort();
    let mut removed: Vec<&Key> = a.keys().filter(|k| !b.contains_key(*k)).collect();
    removed.sort();
    let added: Vec<Value> = added.iter().map(|k| entry_of(&b[*k])).collect();
    let removed: Vec<Value> = removed.iter().map(|k| entry_of(&a[*k])).collect();

    let mut out = Map::new();
    out.insert("baseline_file".into(), json!(prev_path.to_string_lossy()));
    out.insert("added_skills".into(), json!(added));
    out.insert("removed_skills".into(), json!(removed));
    out.insert("usage_delta".into(), Value::Array(used_more));
    out.insert("newly_judgeable".into(), Value::Array(newly_judgeable));
    // **两边都没有预算数据时是 null，不是 0。**`num()` 把 null 折成 0，于是
    // `--harness all`（默认执行环境）下会报出一个「预算没变化」的结论，而真相是
    // 「这个执行环境根本没有预算这个概念」。Python 侧同一处曾因此 None - None 崩溃。
    let budget_delta = match (pb.get("used_chars").and_then(|v| v.as_i64()),
                              nb.get("used_chars").and_then(|v| v.as_i64())) {
        (Some(before), Some(after)) => json!(after - before),
        _ => Value::Null,
    };
    out.insert("budget_delta_chars".into(), budget_delta);
    out.insert(
        "budget_pct_then_now".into(),
        json!([
            pb.get("pct_used").cloned().unwrap_or(Value::Null),
            nb.get("pct_used").cloned().unwrap_or(Value::Null)
        ]),
    );
    out.insert("loaded_then_now".into(), json!([a.len(), b.len()]));
    out.insert(
        "new_overlap_candidates".into(),
        json!(new_pairs.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()),
    );
    out.insert(
        "new_security_findings".into(),
        Value::Array(
            new_sec
                .into_iter()
                .map(|(s, r, w, l)| json!({"skill": s, "rule": r, "where": w, "line": l}))
                .collect(),
        ),
    );
    out.insert(
        "note".into(),
        json!("usage_delta is the trigger-count change between scans. newly_judgeable contains \
skills that were too new before but now meet the age gate."),
    );
    Value::Object(out)
}
