//! §15.3.1 Canonical JSON——§6.4 事件去重比较与 §10.3/§11.2 fingerprint 哈希
//! 共用的唯一"两个 JSON 是否代表同一个事实"判断。两处各写一份等价判断是仓
//! 库历史上真实出现过的一类 bug（`r2a.rs` 曾为字节对账专门固定过一次键
//! 序），这里只允许有一处实现。
//!
//! 形态：
//! - object 的键按 UTF-8 字节序排序后再序列化；
//! - 整数与浮点不互相退化——`3` 与 `3.0` 是两个不同的值，不做数值归一化
//!   （`serde_json::Value` 本身用 `Number` 分开存，直接透传即可）；
//! - 不允许 `NaN` / `Infinity`——`serde_json::Value` 本身就表示不了它们
//!   （标准 JSON 没有这两个字面量），不需要额外处理；
//! - 序列化不插入多余空白（`serde_json::to_string` 默认就是紧凑格式）。

use serde_json::Value;
use sha2::{Digest, Sha256};

/// 递归地把 object 的键排序，数组/标量原样保留。
fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for k in keys {
                sorted.insert(k.clone(), sort_keys(&map[k]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

/// canonical 形态的字节串——§6.4 去重比较、§10.3/§11.2 fingerprint 哈希都
/// 对这个字符串取值。
pub fn canonical_string(value: &Value) -> String {
    serde_json::to_string(&sort_keys(value)).expect("canonical JSON serialization cannot fail")
}

/// canonical 字符串的 SHA-256 十六进制摘要。
pub fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 两个 `Value` 在 canonical 形态下是否代表同一个事实——§6.4 去重比较用它，
/// 不用 `serde_json::Value` 的默认 `PartialEq`（键序敏感）。
pub fn canonical_eq(a: &Value, b: &Value) -> bool {
    canonical_string(a) == canonical_string(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_order_does_not_affect_canonical_string() {
        let a = serde_json::json!({"b": 1, "a": 2});
        let b = serde_json::json!({"a": 2, "b": 1});
        assert_eq!(canonical_string(&a), canonical_string(&b));
    }

    #[test]
    fn nested_key_order_does_not_affect_canonical_string() {
        let a = serde_json::json!({"outer": {"z": 1, "y": 2}});
        let b = serde_json::json!({"outer": {"y": 2, "z": 1}});
        assert_eq!(canonical_string(&a), canonical_string(&b));
    }

    #[test]
    fn integer_and_float_are_not_normalized_to_equal() {
        // §15.3.1：3 与 3.0 是不同的值，不做数值归一化——这条测试钉住"不要
        // 悄悄加 f64 归一化"这个未来可能出现的"优化"。
        let a = serde_json::json!({"n": 3});
        let b = serde_json::json!({"n": 3.0});
        assert_ne!(canonical_string(&a), canonical_string(&b));
    }

    #[test]
    fn array_order_is_preserved_not_sorted() {
        let a = serde_json::json!([1, 2, 3]);
        let b = serde_json::json!([3, 2, 1]);
        assert_ne!(canonical_string(&a), canonical_string(&b));
    }

    #[test]
    fn canonical_eq_matches_key_reordered_objects() {
        assert!(canonical_eq(&serde_json::json!({"a": 1, "b": 2}), &serde_json::json!({"b": 2, "a": 1})));
        assert!(!canonical_eq(&serde_json::json!({"a": 1}), &serde_json::json!({"a": 2})));
    }

    #[test]
    fn sha256_hex_is_stable_for_the_same_canonical_string() {
        let h1 = sha256_hex("hello");
        let h2 = sha256_hex("hello");
        assert_eq!(h1, h2);
        assert_ne!(h1, sha256_hex("world"));
    }
}
