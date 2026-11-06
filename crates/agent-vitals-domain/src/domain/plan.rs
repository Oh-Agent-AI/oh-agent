//! 省钱方案 —— 把 scan 报告派生为量化、排序、诚实的动作清单（`agent-vitals plan`）。
//!
//! 这是「诊断 → 治疗方案」的机器化：`SKILL.md` §4 的 Recommended disposition
//! （Keep · revise · merge · disable/delete after confirmation）从散文变成可对账的
//! 数据。与 `scripts/agent_vitals/agent/plan.py` 逐字节一致，由 `test_cli_matrix.py`
//! 的 `both()` 差分看守（同一 fixture 下 Python/Rust 同数字另有
//! `tests/test_plan_lockstep.py` 交叉锁定）。
//!
//! ## 诚实性规则（naive 实现为什么是错的）
//!
//! 1. **`savings_per_event` 永远是测量值**（token，直接抄报告字段），不是估算。
//! 2. **`events_per_month` 只在真有"每月"数字时填** —— 只有用户 `--startup-rate`
//!    明确提供（估算，不是测量）。`usage_count` 是**终身累计**（`trigger_data` 的
//!    `counts_are` 明写 lifetime cumulative），**绝不**冒充每月数 —— 拿终身数
//!    除以或直接当成"每月"，正是 CLAUDE.md「缺列有用、编造有害」要拦的误标。
//!    终身数单独暴露为 `measured_lifetime_triggers`，语义诚实。
//! 3. **`diagnosis_refs` 只引用 doctor 真实会发的 SV 码**（与 `doctor.py::diagnose`
//!    同条件）：量不到的维度给 `[]`，绝不编一个码。
//! 4. 方案是**提案**：risk 排序只是建议阅读顺序（低风险快赢在前），决定权留给人。
//!    `SKILL.md` 交互规则「Never delete or disable a skill unless the user explicitly
//!    asks」不变。
//!
//! 全整数算术（median 用下中位数 `(n-1)/2`，与 Python `(n-1)//2` 一致），输出无
//! float；排序确定性由「risk 升序 → savings 降序（null 殿后）→ skill 名升序」保证，
//! 同 key 用稳定排序回到构造顺序。

use serde_json::{json, Value};

const DEFAULT_SPLIT_THRESHOLD: i64 = 6000;

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn i64_of(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

fn bool_of(v: &Value) -> bool {
    v.as_bool().unwrap_or(false)
}

fn f64_of(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn opt_i64(v: &Value) -> Option<i64> {
    v.as_i64()
}

/// 顶层 helper：把 Option<i64> 折成 JSON null / number。
fn num_or_null(x: Option<i64>) -> Value {
    match x {
        Some(n) => json!(n),
        None => Value::Null,
    }
}

/// 按 name 查 skills[]，**优先 loaded 副本**（同一名字在影子场景会出现多份）。
/// 两趟：先收 loaded，再补非 loaded。找不到返回 None —— 调用方把「查不到」与
/// 「测到 0」区分开：查不到 → null（没测到，不假装 0），测到 0 → 0。
fn skill_lookup(skills: &[Value]) -> std::collections::HashMap<&str, &Value> {
    let mut m = std::collections::HashMap::new();
    for sk in skills {
        let name = sk.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if !name.is_empty() && !m.contains_key(name) && bool_of(sk.get("loaded").unwrap_or(&Value::Null)) {
            m.insert(name, sk);
        }
    }
    for sk in skills {
        let name = sk.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if !name.is_empty() && !m.contains_key(name) {
            m.insert(name, sk);
        }
    }
    m
}

/// 把 scan 报告派生为省钱方案。`startup_rate` 是用户估算的每月启动次数
/// （`--startup-rate`），只有它能让 per-startup 项填上 `events_per_month`。
pub fn build_plan(report: &Value, startup_rate: Option<i64>) -> Value {
    let harness = s(report.get("harness_selection").unwrap_or(&Value::Null));

    // —— 各源区块（缺区一律当 unavailable / 空，绝不给假数据）——
    let trigger = report.get("trigger_data").unwrap_or(&Value::Null);
    let trigger_available = bool_of(trigger.get("available").unwrap_or(&Value::Null));
    let zombie_min_age = i64_of(trigger.get("zombie_min_age_days").unwrap_or(&Value::Null));
    let zombie_candidates = trigger.get("zombie_candidates").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[]);

    let structure = report.get("structure").unwrap_or(&Value::Null);
    let split_threshold = i64_of(structure.get("split_threshold_tokens").unwrap_or(&Value::Null));
    let split_threshold = if split_threshold > 0 { split_threshold } else { DEFAULT_SPLIT_THRESHOLD };
    let oversized = structure.get("oversized").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[]);

    // budget 状态只看 over_by_chars / pct_used 两个数：unavailable 时二者缺席归 0 →
    // trim 项 `diagnosis_refs` 空，正好不编码。
    let over_by = i64_of(report.pointer("/description_budget/over_by_chars").unwrap_or(&Value::Null));
    let pct_used = f64_of(report.pointer("/description_budget/pct_used").unwrap_or(&Value::Null));
    let budget_refs: Vec<&str> = if over_by > 0 {
        vec!["SV002"]
    } else if pct_used >= 85.0 {
        vec!["SV001"]
    } else {
        vec![]
    };

    let conflicts = report.get("conflicts").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[]);
    let skills = report.get("skills").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[]);
    let by_name = skill_lookup(skills);

    let mut items: Vec<Value> = Vec::new();

    // —— disable-zombie：零触发的已装 skill，删掉每个启动都省 tier1 ——
    // 只有 trigger 证据 available 才生成；unavailable 报不了 0 次，宁可不生成。
    if trigger_available {
        for (idx, z) in zombie_candidates.iter().enumerate() {
            let name = s(z.get("name").unwrap_or(&Value::Null));
            let tier1 = i64_of(z.get("tier1_tokens").unwrap_or(&Value::Null));
            items.push(json!({
                "id": format!("disable-zombie:{idx}"),
                "kind": "disable-zombie",
                "skill": name,
                "risk": "low",
                "savings_per_event": { "tokens": tier1, "unit": "tokens", "per": "startup" },
                "events_per_month": num_or_null(startup_rate),
                "measured_lifetime_triggers": json!(0),
                "diagnosis_refs": ["SV201"],
                "rationale": format!(
                    "0 lifetime triggers and >= {zombie_min_age} days installed; disabling removes {tier1} resident tokens per startup."
                ),
            }));
        }
    }

    // —— split-oversized：SKILL.md 主体超阈值，拆进 references 每次触发省差价 ——
    for (idx, o) in oversized.iter().enumerate() {
        let name = s(o.get("name").unwrap_or(&Value::Null));
        let core = i64_of(o.get("tier2_core_tokens").unwrap_or(&Value::Null));
        let saved = (core - split_threshold).max(0);
        let lifetime = by_name.get(name.as_str())
            .and_then(|sk| opt_i64(sk.get("usage_count").unwrap_or(&Value::Null)));
        items.push(json!({
            "id": format!("split-oversized:{idx}"),
            "kind": "split-oversized",
            "skill": name,
            "risk": "medium",
            "savings_per_event": { "tokens": saved, "unit": "tokens", "per": "trigger" },
            // usage_count 是终身数，绝不填进 events_per_month —— 那是月数。
            "events_per_month": Value::Null,
            "measured_lifetime_triggers": num_or_null(lifetime),
            "diagnosis_refs": ["SV301"],
            "rationale": format!(
                "SKILL.md is {core} tokens (split threshold {split_threshold}); moving non-essential body to on-demand references saves {saved} tokens per trigger."
            ),
        }));
    }

    // —— trim-description：loaded skill 的 tier1 高于 loaded 中位数，压到中位数 ——
    // 中位数是**测量锚**（不是拍脑袋的目标）；无 loaded skill 时中位数无定义 → 整块跳过。
    let mut loaded_tier1: Vec<i64> = skills.iter()
        .filter(|sk| bool_of(sk.get("loaded").unwrap_or(&Value::Null)))
        .filter_map(|sk| sk.get("tier1_tokens").and_then(|v| v.as_i64()))
        .collect();
    loaded_tier1.sort_unstable();
    if let Some(&median) = loaded_tier1.get((loaded_tier1.len().saturating_sub(1)) / 2) {
        let mut idx = 0usize;
        for sk in skills {
            if !bool_of(sk.get("loaded").unwrap_or(&Value::Null)) {
                continue;
            }
            let tier1 = i64_of(sk.get("tier1_tokens").unwrap_or(&Value::Null));
            if tier1 <= median {
                continue;
            }
            let name = s(sk.get("name").unwrap_or(&Value::Null));
            let saved = tier1 - median;
            items.push(json!({
                "id": format!("trim-description:{idx}"),
                "kind": "trim-description",
                "skill": name,
                "risk": "low",
                "savings_per_event": { "tokens": saved, "unit": "tokens", "per": "startup" },
                "events_per_month": num_or_null(startup_rate),
                "measured_lifetime_triggers": Value::Null,
                "diagnosis_refs": budget_refs.clone(),
                "rationale": format!(
                    "Description is {tier1} tokens, above the median {median} of your loaded skills; shortening to the median saves {saved} resident tokens per startup."
                ),
            }));
            idx += 1;
        }
    }

    // —— resolve-shadow：conflict 一致性项，没有可测的 token 收益，诚实不给 savings ——
    for (idx, c) in conflicts.iter().enumerate() {
        let name = s(c.get("name").unwrap_or(&Value::Null));
        let kind = s(c.get("kind").unwrap_or(&Value::Null));
        let (refs, rationale): (Vec<&str>, String) = match kind.as_str() {
            "shadowed_newer" => (
                vec!["SV101"],
                "A newer copy is shadowed by an older effective copy (SV101); resolve which is authoritative. No measured token saving.".to_string(),
            ),
            "redundant" => (
                vec!["SV102"],
                "Two copies have identical content (SV102); remove the duplicate. No measured token saving.".to_string(),
            ),
            "intentional_override" => (
                vec!["SV103"],
                "A deliberate override is in effect (SV103); listed for visibility, no action required. No measured token saving.".to_string(),
            ),
            _ => (vec![], format!("Conflict kind {kind}; no standard action. No measured token saving.")),
        };
        items.push(json!({
            "id": format!("resolve-shadow:{idx}"),
            "kind": "resolve-shadow",
            "skill": name,
            "risk": "medium",
            "savings_per_event": Value::Null,
            "events_per_month": Value::Null,
            "measured_lifetime_triggers": Value::Null,
            "diagnosis_refs": refs,
            "rationale": rationale,
        }));
    }

    // —— 确定性排序：风险低的快赢在前；同风险比 savings 量；null 殿后；再按名 ——
    let risk_rank = |r: &str| match r {
        "low" => 0u8,
        "medium" => 1,
        _ => 2,
    };
    items.sort_by(|a, b| {
        risk_rank(&s(a.get("risk").unwrap_or(&Value::Null)))
            .cmp(&risk_rank(&s(b.get("risk").unwrap_or(&Value::Null))))
            .then_with(|| {
                let ta = a.get("savings_per_event").and_then(|v| v.get("tokens")).and_then(|v| v.as_i64());
                let tb = b.get("savings_per_event").and_then(|v| v.get("tokens")).and_then(|v| v.as_i64());
                match (ta, tb) {
                    (Some(x), Some(y)) => y.cmp(&x),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            })
            .then_with(|| {
                s(a.get("skill").unwrap_or(&Value::Null))
                    .cmp(&s(b.get("skill").unwrap_or(&Value::Null)))
            })
    });

    // —— summary：只给 item 数与 top 3，绝不汇总 token —— per-startup 与 per-trigger
    //    单位不可通约，相加就是拿不同度量拼一个假总数。
    let item_count = items.len();
    let savings_items = items.iter()
        .filter(|it| it.get("savings_per_event").map(|v| !v.is_null()).unwrap_or(false))
        .count();
    let top_3: Vec<String> = items.iter().take(3)
        .filter_map(|it| it.get("id").and_then(|v| v.as_str()).map(|x| x.to_string()))
        .collect();

    // 顶层 diagnosis_refs：全 items 的并集，排序去重。
    let mut all_refs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for it in &items {
        if let Some(list) = it.get("diagnosis_refs").and_then(|v| v.as_array()) {
            for r in list {
                if let Some(x) = r.as_str() {
                    all_refs.insert(x.to_string());
                }
            }
        }
    }

    json!({
        "schema_version": "plan/1.0",
        "harness_selection": harness,
        "startup_rate_per_month": num_or_null(startup_rate),
        "diagnosis_refs": all_refs.iter().collect::<Vec<_>>(),
        "items": items,
        "summary": {
            "item_count": item_count,
            "savings_items": savings_items,
            "top_3_moves": top_3,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_report() -> Value {
        json!({
            "schema_version": "1.0",
            "harness_selection": "claude-code",
            "description_budget": {"available": true, "over_by_chars": 0, "pct_used": 90},
            "trigger_data": {"available": true, "zombie_min_age_days": 14,
                "zombie_candidates": [{"name": "z1", "tier1_tokens": 100}]},
            "structure": {"split_threshold_tokens": 6000,
                "oversized": [{"name": "b1", "tier2_core_tokens": 9000}]},
            "conflicts": [{"name": "c1", "kind": "shadowed_newer", "severity": "high"}],
            "skills": [
                {"name": "z1", "loaded": true, "usage_count": 0, "tier1_tokens": 100, "description_chars": 40},
                {"name": "b1", "loaded": true, "usage_count": 12, "tier1_tokens": 50, "description_chars": 60},
                {"name": "n1", "loaded": true, "usage_count": 5, "tier1_tokens": 30, "description_chars": 30},
                {"name": "n2", "loaded": true, "usage_count": 2, "tier1_tokens": 40, "description_chars": 30}
            ]
        })
    }

    /// 完整报告 + startup_rate=30：loaded tier1 [100,50,30,40] → 排序 [30,40,50,100]，
    /// 下中位数 idx1=40。期望顺序（risk 升序 → savings 降序 → 名升序）：
    /// disable-zombie:0 z1(100) → trim:0 z1(60) → trim:1 b1(10) → split:0 b1(3000)
    /// → resolve-shadow:0 c1(null)。pct_used=90 且 over_by=0 → budget 状态 SV001。
    #[test]
    fn build_plan_full_report() {
        let p = build_plan(&full_report(), Some(30));
        assert_eq!(p["schema_version"], "plan/1.0");
        assert_eq!(p["harness_selection"], "claude-code");
        assert_eq!(p["startup_rate_per_month"], 30);

        let items = p["items"].as_array().unwrap();
        assert_eq!(items.len(), 5);
        let kinds: Vec<&str> = items.iter().map(|it| it["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["disable-zombie", "trim-description", "trim-description",
                           "split-oversized", "resolve-shadow"]);
        assert_eq!(items[0]["id"], "disable-zombie:0");
        assert_eq!(items[0]["skill"], "z1");
        assert_eq!(items[0]["risk"], "low");
        assert_eq!(items[0]["savings_per_event"]["tokens"], 100);
        assert_eq!(items[0]["events_per_month"], 30);
        assert_eq!(items[0]["measured_lifetime_triggers"], 0);
        assert_eq!(items[0]["diagnosis_refs"], json!(["SV201"]));

        // trim-description:0 z1 省 100-40=60；diagnosis_refs 由 budget 状态定：
        // pct_used=90 → SV001（over_by=0 不发 SV002）。
        assert_eq!(items[1]["savings_per_event"]["tokens"], 60);
        assert_eq!(items[1]["diagnosis_refs"], json!(["SV001"]));
        assert_eq!(items[2]["savings_per_event"]["tokens"], 10);

        // split-oversized:0 省 9000-6000=3000，events_per_month 恒 null（终身数不冒充
        // 月数），终身触发数 12 单独暴露。
        assert_eq!(items[3]["savings_per_event"]["tokens"], 3000);
        assert!(items[3]["events_per_month"].is_null());
        assert_eq!(items[3]["measured_lifetime_triggers"], 12);
        assert_eq!(items[3]["diagnosis_refs"], json!(["SV301"]));

        // resolve-shadow:0 无 savings 声称。
        assert!(items[4]["savings_per_event"].is_null());
        assert_eq!(items[4]["diagnosis_refs"], json!(["SV101"]));

        assert_eq!(p["summary"]["item_count"], 5);
        assert_eq!(p["summary"]["savings_items"], 4);
        assert_eq!(p["summary"]["top_3_moves"],
                   json!(["disable-zombie:0", "trim-description:0", "trim-description:1"]));
        assert_eq!(p["diagnosis_refs"], json!(["SV001", "SV101", "SV201", "SV301"]));
    }

    /// trigger 证据不可用 → 绝不生成 disable-zombie（报不了 0 次就不报）。
    #[test]
    fn build_plan_no_trigger_never_fabricates_zombies() {
        let mut r = full_report();
        r["trigger_data"] = json!({"available": false, "zombie_candidates": []});
        let p = build_plan(&r, None);
        assert!(p["items"].as_array().unwrap().iter()
            .all(|it| it["kind"] != "disable-zombie"));
    }

    /// 无 loaded skill → 中位数无定义 → 无 trim-description。
    #[test]
    fn build_plan_no_loaded_skills_no_trim() {
        let mut r = full_report();
        for sk in r["skills"].as_array_mut().unwrap() {
            sk["loaded"] = json!(false);
        }
        let p = build_plan(&r, None);
        assert!(p["items"].as_array().unwrap().iter()
            .all(|it| it["kind"] != "trim-description"));
    }

    /// oversized 的 usage_count 测到 0 → lifetime 是 0（不是 null）；events 仍是 null。
    #[test]
    fn build_plan_oversized_zero_usage_measured() {
        let mut r = full_report();
        r["skills"][1]["usage_count"] = json!(0);
        let p = build_plan(&r, None);
        let sp = p["items"].as_array().unwrap().iter()
            .find(|it| it["kind"] == "split-oversized").unwrap();
        assert_eq!(sp["measured_lifetime_triggers"], 0);
        assert!(sp["events_per_month"].is_null());
    }

    /// oversized name 在 skills[] 查不到 → lifetime 是 null（没测到不假装 0）。
    #[test]
    fn build_plan_oversized_name_missing_events_null() {
        let mut r = full_report();
        r["structure"]["oversized"] = json!([{"name": "ghost", "tier2_core_tokens": 9000}]);
        let p = build_plan(&r, None);
        let sp = p["items"].as_array().unwrap().iter()
            .find(|it| it["kind"] == "split-oversized").unwrap();
        assert!(sp["measured_lifetime_triggers"].is_null());
    }

    /// 不传 startup_rate → per-startup 项 events_per_month 恒 null，顶层也是 null。
    #[test]
    fn build_plan_startup_rate_null_when_not_given() {
        let p = build_plan(&full_report(), None);
        assert!(p["startup_rate_per_month"].is_null());
        for it in p["items"].as_array().unwrap() {
            if it["kind"] == "disable-zombie" || it["kind"] == "trim-description" {
                assert!(it["events_per_month"].is_null());
            }
        }
    }

    /// budget unavailable → trim 项 diagnosis_refs 空（不编码）。
    #[test]
    fn build_plan_trim_refs_empty_when_budget_unavailable() {
        let mut r = full_report();
        r["description_budget"] = json!({"available": false});
        let p = build_plan(&r, None);
        let trims: Vec<_> = p["items"].as_array().unwrap().iter()
            .filter(|it| it["kind"] == "trim-description").collect();
        assert!(!trims.is_empty());
        for it in trims {
            assert_eq!(it["diagnosis_refs"], json!([]));
        }
    }

    /// 确定性：同输入跑两次，输出逐字节相同。
    #[test]
    fn build_plan_deterministic() {
        let a = serde_json::to_string(&build_plan(&full_report(), Some(30))).unwrap();
        let b = serde_json::to_string(&build_plan(&full_report(), Some(30))).unwrap();
        assert_eq!(a, b);
    }
}
