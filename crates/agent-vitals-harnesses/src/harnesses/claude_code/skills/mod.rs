//! Claude Code 的执行环境配置解释——**纯**（wasm 可链）。v0.8 Phase E7.6 从
//! `apps/cli/src/skills/harness.rs` 拆出（原文件的 `read_harness_config` 真读
//! `~/.claude.json`，是 I/O，留在 `sources/skills.rs`；这里只认已经读进内存
//! 的 `serde_json::Value`）。
//!
//! 不变量 12 的实现所在：**拿不到就报 unavailable，绝不用装机时间或 mtime
//! 代替触发数。**缺一列的报告有价值，编一列的没有。

use std::collections::HashSet;

use serde_json::{Map, Value};

pub struct HarnessConfig {
    /// None = 读不到配置，**不是**「读到了但没启用任何插件」。
    /// 两者在报告里的含义完全不同。Python 版这里曾经用 `{}` 表示读不到，
    /// 于是降级分支永远走不到，插件分支拿着 None 直接崩掉整次扫描。
    /// Rust 里 `Option` 让这个区分变成编译期的事 —— 这正是选 Rust 的理由之一。
    pub enabled: Option<HashSet<String>>,
    pub usage: Map<String, Value>,
    pub present: bool,
}

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Null => false,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `~/.claude.json` 已经解析成 `Value` 之后的解释——是不是文件、读不读得到、
/// JSON 合不合法，都是调用方（`sources/skills.rs::read_harness_config`）的事。
pub fn parse_harness_config(doc: &Value) -> HarnessConfig {
    let mut enabled: HashSet<String> = HashSet::new();
    let mut found_key = false;
    let mut absorb = |v: Option<&Value>| match v {
        Some(Value::Object(o)) => {
            found_key = true;
            for (k, on) in o {
                if is_truthy(on) {
                    enabled.insert(k.clone());
                }
            }
        }
        Some(Value::Array(a)) => {
            found_key = true;
            for x in a {
                if let Some(s) = x.as_str() {
                    enabled.insert(s.to_string());
                }
            }
        }
        _ => {}
    };

    absorb(doc.get("enabledPlugins"));
    if let Some(Value::Object(projects)) = doc.get("projects") {
        for proj in projects.values() {
            if proj.is_object() {
                absorb(proj.get("enabledPlugins"));
            }
        }
    }

    let usage = match doc.get("skillUsage") {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    };

    HarnessConfig {
        enabled: Some(if found_key { enabled } else { HashSet::new() }),
        usage,
        present: true,
    }
}

fn to_count(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Value::String(s) => s.trim().parse::<i64>().unwrap_or(0),
        Value::Bool(b) => *b as i64,
        _ => 0,
    }
}

/// skillUsage 的键可能是裸名，也可能是 `<plugin>:<skill>`。
///
/// 裸名回退可能撞上同名的其他 skill，这是已知的精度上限。
/// 没有记录时匹配键必须是 None —— **不得伪造成匹配上了**。
pub fn lookup_usage(
    usage: &Map<String, Value>,
    name: &str,
    namespace: Option<&str>,
) -> (i64, Option<f64>, Option<String>) {
    let mut keys: Vec<String> = Vec::new();
    if let Some(ns) = namespace {
        keys.push(format!("{}:{}", ns, name));
    }
    keys.push(name.to_string());

    for k in keys {
        match usage.get(&k) {
            Some(Value::Object(o)) => {
                let count = o.get("usageCount").map_or(0, to_count);
                let last = o.get("lastUsedAt").and_then(|v| v.as_f64());
                return (count, last, Some(k));
            }
            // Python 的 isinstance(v, int)：浮点数不算，字符串不算
            Some(v @ Value::Number(_)) if v.is_i64() || v.is_u64() => {
                return (to_count(v), None, Some(k));
            }
            Some(Value::Bool(b)) => return (*b as i64, None, Some(k)),
            _ => {}
        }
    }
    (0, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    // 期望值来自 tests/test_characterization.py::TestLookupUsage

    #[test]
    fn namespaced_key_preferred() {
        let u = m(json!({"tool": {"usageCount": 1}, "plug:tool": {"usageCount": 9}}));
        assert_eq!(
            lookup_usage(&u, "tool", Some("plug")),
            (9, None, Some("plug:tool".into()))
        );
    }

    #[test]
    fn bare_fallback() {
        let u = m(json!({"tool": {"usageCount": 4}}));
        assert_eq!(
            lookup_usage(&u, "tool", Some("plug")),
            (4, None, Some("tool".into()))
        );
    }

    #[test]
    fn plain_integer_form() {
        let u = m(json!({"tool": 7}));
        assert_eq!(lookup_usage(&u, "tool", None), (7, None, Some("tool".into())));
    }

    #[test]
    fn last_used_at_passed_through() {
        let u = m(json!({"tool": {"usageCount": 2, "lastUsedAt": 1700000000000i64}}));
        let (c, last, k) = lookup_usage(&u, "tool", None);
        assert_eq!(c, 2);
        assert_eq!(last, Some(1700000000000.0));
        assert_eq!(k, Some("tool".into()));
    }

    #[test]
    fn missing_returns_none_key() {
        assert_eq!(lookup_usage(&Map::new(), "tool", None), (0, None, None));
    }

    #[test]
    fn absent_or_null_count_is_zero() {
        assert_eq!(lookup_usage(&m(json!({"t": {}})), "t", None).0, 0);
        assert_eq!(lookup_usage(&m(json!({"t": {"usageCount": null}})), "t", None).0, 0);
    }

    #[test]
    fn unexpected_type_is_skipped() {
        assert_eq!(lookup_usage(&m(json!({"t": "nope"})), "t", None), (0, None, None));
    }

    #[test]
    fn parse_harness_config_reads_enabled_plugins_and_usage() {
        let doc = json!({
            "enabledPlugins": {"a": true, "b": false},
            "projects": {"/x": {"enabledPlugins": {"c": true}}},
            "skillUsage": {"a": {"usageCount": 3}},
        });
        let cfg = parse_harness_config(&doc);
        assert!(cfg.present);
        let enabled = cfg.enabled.expect("found enabledPlugins key");
        assert!(enabled.contains("a"));
        assert!(!enabled.contains("b"), "falsy value must not be enabled");
        assert!(enabled.contains("c"), "project-scoped enabledPlugins must merge in");
        assert_eq!(cfg.usage.get("a").and_then(|v| v.get("usageCount")), Some(&json!(3)));
    }

    #[test]
    fn parse_harness_config_no_enabled_plugins_key_is_empty_not_none() {
        // found_key=false → Some(空集合)，不是 None——「读到了但没有这个键」与
        // 「读不到文件」在报告里含义不同，None 留给 read_harness_config 的 I/O 分支。
        let cfg = parse_harness_config(&json!({}));
        assert_eq!(cfg.enabled, Some(HashSet::new()));
    }
}
