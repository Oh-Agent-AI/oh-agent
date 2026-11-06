//! 会话身份四元组 `SessionKey` 与行为规则集版本 `ENGINE_VERSION`。
//!
//! W8（2026-09-24）：这两项原住 `contracts/r2a.rs`——R2a SessionStore 契约的一部分。
//! SessionStore（分页 / cursor / envelope 版本矩阵 / StoreError）随
//! `runtime::sessions::r2a_store` 一起删除；`SessionKey` 早已是全仓通用的身份
//! 类型（workflow / trace / issues / 桌面 overview 都在用），`ENGINE_VERSION`
//! 是桌面诊断面报告的规则集版本，所以原样搬到这里继续存活。

use serde_json::{json, Value};

/// 引擎（core 规则）版本。语义：findings/coverage 三态规则集版本；规则语义变更才
/// 换版本（设计 §2.2）。与 crate 版本号解耦，专指 R2a 规则集。
pub const ENGINE_VERSION: &str = "1";

/// `SessionKey` 四元组（设计 §1.1）。harness_kind + native_id 已在同一 namespace 内
/// 去重；source_profile 与 machine_namespace 把跨工作区/跨机器碰撞拆开。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub harness_kind: String,
    pub native_id: String,
    pub source_profile: String,
    pub machine_namespace: String,
}

impl SessionKey {
    pub fn new(
        harness_kind: &str,
        native_id: &str,
        source_profile: &str,
        machine_namespace: &str,
    ) -> Self {
        SessionKey {
            harness_kind: harness_kind.to_string(),
            native_id: native_id.to_string(),
            source_profile: source_profile.to_string(),
            machine_namespace: machine_namespace.to_string(),
        }
    }

    /// 序列化形状 —— **键序是字节一致的一部分，不能重排**（设计 §1.1 标「推断」，
    /// 此处定为 harness_kind → native_id → source_profile → machine_namespace）。
    pub fn to_json(&self) -> Value {
        json!({
            "harness_kind": self.harness_kind,
            "native_id": self.native_id,
            "source_profile": self.source_profile,
            "machine_namespace": self.machine_namespace,
        })
    }

    /// 反序列化 —— 四个分量任一缺失/非 string → None（无法归入任何 SessionKey，
    /// 设计 §1.2「session_id 与 id 双缺 → 该 rollout 无法归入任何 SessionKey」）。
    pub fn from_json(v: &Value) -> Option<SessionKey> {
        Some(SessionKey {
            harness_kind: v.get("harness_kind")?.as_str()?.to_string(),
            native_id: v.get("native_id")?.as_str()?.to_string(),
            source_profile: v.get("source_profile")?.as_str()?.to_string(),
            machine_namespace: v.get("machine_namespace")?.as_str()?.to_string(),
        })
    }

    /// 自定界 ledger key（四段）。复刻 `takeover::session_key` 的长度前缀方案，
    /// 多一段 source_profile：裸拼接会让 `("ab","c")` 与 `("a","bc")` 撞同一个
    /// key，长度前缀天然无法伪造碰撞。
    pub fn ledger_key(&self) -> String {
        fn seg(s: &str) -> String {
            format!("{}:{s}", s.len())
        }
        format!(
            "{}|{}|{}|{}",
            seg(&self.harness_kind),
            seg(&self.native_id),
            seg(&self.source_profile),
            seg(&self.machine_namespace),
        )
    }

    /// Parse the length-prefixed ledger key emitted by [`ledger_key`].
    ///
    /// This stays in the vocabulary contract so data writers can materialize
    /// the session foreign key without knowing any harness-specific log shape.
    pub fn from_ledger_key(raw: &str) -> Option<SessionKey> {
        let mut rest = raw;
        let mut parts = Vec::with_capacity(4);
        for index in 0..4 {
            let colon = rest.find(':')?;
            let length = rest[..colon].parse::<usize>().ok()?;
            let content = &rest[colon + 1..];
            if content.len() < length {
                return None;
            }
            let (part, remainder) = content.split_at(length);
            parts.push(part.to_string());
            if index < 3 {
                rest = remainder.strip_prefix('|')?;
            } else if !remainder.is_empty() {
                return None;
            }
        }
        Some(SessionKey::new(&parts[0], &parts[1], &parts[2], &parts[3]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_key_json_order_is_fixed() {
        let k = SessionKey::new("codex", "s1", "/repo", "ns-abc");
        let v = k.to_json();
        assert_eq!(
            v.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["harness_kind", "native_id", "source_profile", "machine_namespace"]
        );
        assert_eq!(v["harness_kind"], "codex");
        assert_eq!(v["native_id"], "s1");
        assert_eq!(v["source_profile"], "/repo");
        assert_eq!(v["machine_namespace"], "ns-abc");
        // 往返一致
        assert_eq!(SessionKey::from_json(&v), Some(k));
    }

    #[test]
    fn session_key_from_json_missing_component_is_none() {
        assert_eq!(SessionKey::from_json(&json!({"harness_kind": "codex"})), None);
        assert_eq!(SessionKey::from_json(&json!({"harness_kind": 1, "native_id": "s",
            "source_profile": "/r", "machine_namespace": "ns"})), None);
    }

    #[test]
    fn session_key_ledger_key_roundtrips_length_prefixed_segments() {
        let key = SessionKey::new("dsh|harness", "session:1", "profile", "机器");
        assert_eq!(SessionKey::from_ledger_key(&key.ledger_key()), Some(key));
        assert_eq!(SessionKey::from_ledger_key("4:only"), None);
        assert_eq!(SessionKey::from_ledger_key("1:a|1:b|1:c|1:d|extra"), None);
    }

    #[test]
    fn session_key_ledger_key_is_self_delimiting_four_seg() {
        let k = SessionKey::new("codex", "s1", "/repo", "ns-abc");
        assert_eq!(k.ledger_key(), "5:codex|2:s1|5:/repo|6:ns-abc");
        // 长度前缀消除拼接歧义
        let a = SessionKey::new("ab", "c", "d", "e");
        let b = SessionKey::new("a", "bc", "d", "e");
        assert_ne!(a.ledger_key(), b.ledger_key());
        // 字段含分隔符也不撞
        let c = SessionKey::new("a|b", "c", "d", "e");
        let d = SessionKey::new("a", "b|c", "d", "e");
        assert_ne!(c.ledger_key(), d.ledger_key());
    }
}
