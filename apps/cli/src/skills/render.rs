//! 呈现层：把证据渲染成人能读的表（PRODUCT §5）。
//!
//! **这一层不做测量，只做呈现与判断。**所有数字来自扫描输出的同一份 JSON，
//! 两个实现渲染出的字节必须一致 —— 差分测试因此覆盖到终端输出，而不只是
//! JSON（`tests/test_render.py`）。

use serde_json::Value;

pub const DEFAULT_DORMANT_DAYS: i64 = 30;

/// 生命周期：active / occasional / dormant / zombie / too-new / unknown。
///
/// **执行环境没有触发数据时一律 unknown**，不是 zombie —— 零触发与「问不到」是
/// 两件事，混起来会让用户删掉一个其实天天在用的 skill（不变量 12）。
pub fn lifecycle_status(
    skill: &Value,
    trigger_available: bool,
    zombie_age: i64,
    dormant_days: i64,
) -> &'static str {
    if !trigger_available {
        return "unknown";
    }
    let uses = skill.get("usage_count").and_then(|v| v.as_i64()).unwrap_or(0);
    if uses == 0 {
        return match skill.get("installed_days_ago").and_then(|v| v.as_f64()) {
            // 零触发必须先过年龄闸：今早刚装的说明不了任何事（不变量 9）
            Some(age) if age >= zombie_age as f64 => "zombie",
            Some(_) => "too-new",
            None => "unknown",
        };
    }
    match skill.get("last_used_days_ago").and_then(|v| v.as_f64()) {
        // 有触发数但没有时间戳：能说的只有「用过」，不能推断新鲜度
        None => "occasional",
        Some(d) if d <= 7.0 => "active",
        Some(d) if d <= dormant_days as f64 => "occasional",
        Some(_) => "dormant",
    }
}

/// LOAD 与 STATUS 必须分列（PRODUCT §5.2）。
///
/// 前者是**加载状态**，后者是**使用生命周期**，两者正交：一个 skill 完全
/// 可以既 shadowed 又 active —— 生效的那份在被用、你改的那份没生效。
/// 挤成一列会把它显示成 shadowed 并**隐藏使用数据**，而那恰恰是最该被
/// 看见的情况。
pub fn load_state(skill: &Value, shadowed: &[String]) -> &'static str {
    let path = skill.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if shadowed.iter().any(|p| p == path) {
        return "shadowed";
    }
    if skill.get("loaded").and_then(|v| v.as_bool()) == Some(true) {
        return "loaded";
    }
    let reason = skill.get("loaded_reason").and_then(|v| v.as_str()).unwrap_or("");
    if reason.starts_with("other-harness") {
        return "other-harness";
    }
    if reason.contains("not-enabled") || reason.contains("disabled") || reason.contains("filtered")
    {
        return "disabled";
    }
    "unknown"
}

pub fn human_tokens(n: Option<i64>) -> String {
    match n {
        None => "—".to_string(),
        Some(v) if v >= 1000 => format!("{:.1}k", v as f64 / 1000.0),
        Some(v) => v.to_string(),
    }
}

pub fn human_last_used(days: Option<f64>) -> String {
    match days {
        None => "never".to_string(),
        Some(d) if d < 1.0 => format!("{}h ago", ((d * 24.0) as i64).max(1)),
        Some(d) => format!("{}d ago", d as i64),
    }
}

/// LAST USED 单元格文本：0 次是 never；有用过但没时间戳是 unknown。
///
/// DSH 的 invoked/selected 只是名字列表、没有时间戳，所以会出现「usage_count
/// 非零但 last_used_days_ago 为 None」——此时写「never」就是自相矛盾（明明
/// 用过却说从没被用过），写 unknown 才是诚实降级。Python 平行实现见
/// `scripts/agent_vitals/skills/lifecycle.py::last_used_text`。
pub fn last_used_text(uses: i64, last: Option<f64>) -> String {
    if uses == 0 {
        return human_last_used(None);
    }
    match last {
        None => "unknown".to_string(),
        Some(_) => human_last_used(last),
    }
}

pub struct ListOpts {
    pub unused: bool,
    pub shadowed: bool,
    pub stale: Option<i64>,
    pub sort: String,
    pub top: Option<usize>,
}

struct Row {
    name: String,
    load: &'static str,
    status: Option<&'static str>,
    uses: Option<i64>,
    last: Option<f64>,
    core: Option<i64>,
    max: Option<i64>,
    shown: bool,
}

/// 与 render_list 同源的行数据，供 `--json` 输出。
pub fn list_rows(out: &Value, o: &ListOpts) -> Value {
    let rows = build_rows(out, o);
    Value::Array(rows.iter().map(|r| serde_json::json!({
        "name": r.name, "load": r.load, "status": r.status,
        "uses": r.uses, "last": r.last, "core": r.core, "max": r.max,
    })).collect())
}

pub fn render_list(out: &Value, o: &ListOpts) -> String {
    let rows = build_rows(out, o);
    render_rows(out, o, &rows)
}

fn build_rows(out: &Value, o: &ListOpts) -> Vec<Row> {
    let trigger_available = out
        .pointer("/trigger_data/available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let zombie_age = out
        .pointer("/trigger_data/zombie_min_age_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(14);
    let dormant = o.stale.unwrap_or(DEFAULT_DORMANT_DAYS);

    let mut shadowed: Vec<String> = Vec::new();
    if let Some(cs) = out.get("conflicts").and_then(|v| v.as_array()) {
        for c in cs {
            if let Some(list) = c.get("shadowed").and_then(|v| v.as_array()) {
                for x in list {
                    if let Some(p) = x.get("path").and_then(|v| v.as_str()) {
                        shadowed.push(p.to_string());
                    }
                }
            }
        }
    }

    let empty = Vec::new();
    let skills = out.get("skills").and_then(|v| v.as_array()).unwrap_or(&empty);
    let mut rows: Vec<Row> = skills
        .iter()
        .map(|s| {
            let load = load_state(s, &shadowed);
            // **未加载的 skill 不谈使用生命周期。**它没进上下文，"zombie" 或
            // "too-new" 对它没有意义 —— 那是用一个生命周期词去解释一件加载
            // 状态的事。shadowed **要**显示使用数据，理由见 load_state。
            let shown = load == "loaded" || load == "shadowed";
            Row {
                name: s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                load,
                status: if shown {
                    Some(lifecycle_status(s, trigger_available, zombie_age, dormant))
                } else {
                    None
                },
                uses: if shown && trigger_available {
                    s.get("usage_count").and_then(|v| v.as_i64())
                } else {
                    None
                },
                last: if shown && trigger_available {
                    s.get("last_used_days_ago").and_then(|v| v.as_f64())
                } else {
                    None
                },
                core: s.get("tier2_core_tokens").and_then(|v| v.as_i64()),
                max: s.get("tier2_max_tokens").and_then(|v| v.as_i64()),
                shown,
            }
        })
        .collect();

    if o.unused {
        rows.retain(|r| matches!(r.status, Some("zombie") | Some("dormant")));
    }
    if o.shadowed {
        rows.retain(|r| r.load == "shadowed");
    }

    // **先按 LOAD 分组，再按排序键。**真正进了上下文的那批必须在最前面 ——
    // 否则一堆未启用的大块头会把唯一生效的那个顶到屏幕外。
    let load_rank = |l: &str| match l {
        "loaded" => 0,
        "shadowed" => 1,
        "disabled" => 2,
        "other-harness" => 3,
        "unknown" => 4,
        _ => 9,
    };
    match o.sort.as_str() {
        "usage" => rows.sort_by_key(|r| (load_rank(r.load), -(r.uses.unwrap_or(0)))),
        "name" => rows.sort_by(|a, b| {
            load_rank(a.load)
                .cmp(&load_rank(b.load))
                .then_with(|| a.name.cmp(&b.name))
        }),
        _ => rows.sort_by_key(|r| (load_rank(r.load), -(r.core.unwrap_or(0)))),
    }
    if let Some(n) = o.top {
        rows.truncate(n);
    }

    rows
}

fn render_rows(out: &Value, o: &ListOpts, rows: &[Row]) -> String {
    let trigger_available = out
        .pointer("/trigger_data/available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let zombie_age = out
        .pointer("/trigger_data/zombie_min_age_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(14);
    let dormant = o.stale.unwrap_or(DEFAULT_DORMANT_DAYS);

    if rows.is_empty() {
        return "No matching skills.\n".to_string();
    }

    let w = rows.iter().map(|r| r.name.chars().count()).max().unwrap_or(4).max(4);
    let mut s = String::new();
    s.push_str(&pad("NAME", w));
    s.push_str(&format!(
        "  {:<10} {:<11} {:>6}  {:<10} {:>7} {:>7}\n",
        "LOAD", "STATUS", "USES", "LAST USED", "CORE", "MAX"
    ));
    s.push_str(&"─".repeat(w + 58));
    s.push('\n');
    for r in rows {
        s.push_str(&pad(&r.name, w));
        s.push_str(&format!(
            "  {:<10} {:<11} {:>6}  {:<10} {:>7} {:>7}\n",
            r.load,
            r.status.unwrap_or("—"),
            r.uses.map(|v| v.to_string()).unwrap_or_else(|| "—".into()),
            if r.shown && trigger_available {
                last_used_text(r.uses.unwrap_or(0), r.last)
            } else {
                "—".into()
            },
            human_tokens(r.core),
            human_tokens(r.max)
        ));
    }
    let loaded = rows.iter().filter(|r| r.load == "loaded").count();
    // **阈值必须显示在末行**：没有阈值的状态词无法解释也无法复现（§6.1）
    s.push('\n');
    s.push_str(&format!(
        "{} loaded · {} not loaded  ·  thresholds dormant={}d zombie={}d{}\n",
        loaded,
        rows.len() - loaded,
        dormant,
        zombie_age,
        if trigger_available {
            ""
        } else {
            "  ·  trigger data unavailable; STATUS is unknown"
        }
    ));
    s
}

/// 按**字符数**左对齐补空格。
///
/// 不能用 `{:<w$}` —— Rust 的格式宽度按字符计，而 Python 的 `%-*s` 也按
/// 字符计，两者一致；但显示宽度在 CJK 名字上都会偏。这里保持与 Python
/// 相同的字符计口径，让两个实现渲染出的字节一致。
fn pad(s: &str, w: usize) -> String {
    let n = s.chars().count();
    let mut out = s.to_string();
    if n < w {
        out.push_str(&" ".repeat(w - n));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_trigger_data_means_unknown_not_zombie() {
        // 零触发与「问不到」是两件事
        let s = json!({"usage_count": 0, "installed_days_ago": 900.0});
        assert_eq!(lifecycle_status(&s, false, 14, 30), "unknown");
        assert_eq!(lifecycle_status(&s, true, 14, 30), "zombie");
    }

    #[test]
    fn zero_use_passes_the_age_gate_first() {
        let fresh = json!({"usage_count": 0, "installed_days_ago": 1.0});
        assert_eq!(lifecycle_status(&fresh, true, 14, 30), "too-new");
    }

    #[test]
    fn used_but_no_timestamp_is_occasional_not_active() {
        // 有触发数但没时间戳：能说的只有「用过」
        let s = json!({"usage_count": 5});
        assert_eq!(lifecycle_status(&s, true, 14, 30), "occasional");
    }

    #[test]
    fn last_used_cell_text_distinguishes_never_unknown_and_real() {
        // 0 次 → never；有用过但没时间戳 → unknown（DSH 的 invoked/selected 只是
        // 名字列表，此时写 never 就是自相矛盾）；有时间戳 → 人类可读的 ago。
        assert_eq!(last_used_text(0, None), "never");
        assert_eq!(last_used_text(0, Some(2.0)), "never"); // 0 次且带时间，仍按 0 次
        assert_eq!(last_used_text(1, None), "unknown");
        assert_eq!(last_used_text(1, Some(2.0)), "2d ago");
    }

    #[test]
    fn freshness_boundaries() {
        let mk = |d: f64| json!({"usage_count": 1, "last_used_days_ago": d});
        assert_eq!(lifecycle_status(&mk(7.0), true, 14, 30), "active");
        assert_eq!(lifecycle_status(&mk(7.1), true, 14, 30), "occasional");
        assert_eq!(lifecycle_status(&mk(30.0), true, 14, 30), "occasional");
        assert_eq!(lifecycle_status(&mk(30.1), true, 14, 30), "dormant");
    }

    #[test]
    fn shadowed_beats_loaded() {
        let s = json!({"loaded": true, "path": "/a"});
        assert_eq!(load_state(&s, &["/a".to_string()]), "shadowed");
        assert_eq!(load_state(&s, &[]), "loaded");
    }

    #[test]
    fn token_and_time_formatting() {
        assert_eq!(human_tokens(Some(999)), "999");
        assert_eq!(human_tokens(Some(1000)), "1.0k");
        assert_eq!(human_tokens(None), "—");
        assert_eq!(human_last_used(None), "never");
        assert_eq!(human_last_used(Some(0.5)), "12h ago");
        assert_eq!(human_last_used(Some(3.7)), "3d ago");
    }
}
