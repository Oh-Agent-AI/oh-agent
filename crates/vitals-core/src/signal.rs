//! §7.1 Signal——具名、类型化的证据通道标识。通用 Core 不内置 `ToolCalls`
//! 等 Agent 专属枚举（那是 `agent-vitals-domain::evidence::Signal` 的领域私有
//! 概念），改用稳定字符串 newtype，命名规范 `<domain>.<signal>`。
//!
//! # 开放字符串的代价，和为什么这里有 `SignalVocabulary`
//!
//! 现有实现的 `Signal` 是闭合的 20 变体 enum，拼写错误是编译错误。换成
//! `SignalId(String)` 后，把 `agent.tool_calls` 写成 `agent.toolcalls`
//! 不会有任何报错——它只会让引用它的规则在运行期**静默变成 Unavailable**，
//! 报告看上去完全正常，这是三态契约里最难发现的一种破坏方式（spec §7.1 补
//! 丁）。
//!
//! `SignalVocabulary` 一次注册同时回答两个问题，不是两张表：
//!
//! 1. **拼写保护**（§7.1）：Detector 的 `requirement()` / `enhances` 引用的
//!    `SignalId` 必须在词表里，否则 `build()` 报 `UnknownSignal` 硬错误；
//! 2. **门控判据**（§7.4.1）：这条信号在事件流上由哪些 `CanonicalEvent.kind`
//!    构成"可消费证据"——Engine 的 requirement gate 数的是这个，不是
//!    `CoverageCounts`（那是 M0 已经交付的报告轴，见 `coverage.rs`）。
//!
//! 两者合一是有意的：如果分成两张表，"注册了信号但没声明任何 kind"这种半
//! 完成状态会悄悄通过拼写检查、又在门控里永远 Unavailable——诚实，但只有
//! 合一才能让这个状态在 API 上*可见*（`register` 的第二个参数摆在那里，
//! 传空迭代器是显式选择，不是遗漏）。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::VitalsError;

/// Core 保留前缀——Domain 不得注册这个前缀下的名字。
pub const RESERVED_PREFIX: &str = "vitals.";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SignalId(pub String);

impl SignalId {
    /// §7.1：非空、仅 `[a-z0-9_.]`、至少一个 `.`、不以 `.` 起止。
    pub fn validate(&self) -> Result<(), VitalsError> {
        let s = self.0.as_str();
        let ok = !s.is_empty()
            && !s.starts_with('.')
            && !s.ends_with('.')
            && s.contains('.')
            && s.chars().all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '.'));
        if ok {
            Ok(())
        } else {
            Err(VitalsError::InvalidSignalId { signal_id: self.0.clone() })
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_reserved(&self) -> bool {
        self.0.starts_with(RESERVED_PREFIX)
    }
}

impl From<&str> for SignalId {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl From<String> for SignalId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl std::fmt::Display for SignalId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Domain 在 Engine builder 阶段登记的信号词表。`vitals.*` 前缀恒在词表内，
/// 不需要（也不允许）注册。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignalVocabulary {
    /// signal_id → 该信号在事件流上可读的 `CanonicalEvent.kind` 集合。
    kinds: BTreeMap<SignalId, BTreeSet<String>>,
}

impl SignalVocabulary {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个 Domain 信号，声明它在事件流上对应哪些 `kind`。`kinds` 允许
    /// 为空——"这条信号存在，只是这个执行环境目前没有任何 kind 能满足它"，比
    /// 干脆不注册更诚实：不注册会在 `build()` 就地报 `UnknownSignal`，注册
    /// 但空 kind 会在运行期诚实报 `Unavailable`，两者是不同的失败面，不应
    /// 该被合并。
    pub fn register(&mut self, signal: SignalId, kinds: impl IntoIterator<Item = String>) -> Result<(), VitalsError> {
        signal.validate()?;
        if signal.is_reserved() {
            return Err(VitalsError::ReservedSignalId { signal_id: signal.0 });
        }
        self.kinds.entry(signal).or_default().extend(kinds);
        Ok(())
    }

    /// `vitals.*` 恒返回 `true`；其余信号看是否被显式注册过（哪怕 kind 集
    /// 合是空的——"注册过但没有 kind"和"根本没注册过"是两件事，前者过
    /// `contains`、后者不过）。
    pub fn contains(&self, signal: &SignalId) -> bool {
        signal.is_reserved() || self.kinds.contains_key(signal)
    }

    /// §7.4.1：这个 event kind 是否喂给了这条信号——Engine 的门控判据用它
    /// 数"可消费事件"，不读 `CoverageCounts`。
    pub fn kind_feeds_signal(&self, signal: &SignalId, kind: &str) -> bool {
        self.kinds.get(signal).is_some_and(|ks| ks.contains(kind))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let id = SignalId::from("agent.tool_calls");
        let json = serde_json::to_value(&id).unwrap();
        let back: SignalId = serde_json::from_value(json).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn validate_rejects_malformed_ids() {
        for bad in ["", ".agent", "agent.", "agent", "Agent.ToolCalls", "agent.tool calls"] {
            assert!(SignalId::from(bad).validate().is_err(), "expected `{bad}` to be rejected");
        }
        assert!(SignalId::from("agent.tool_calls").validate().is_ok());
    }

    #[test]
    fn vocabulary_rejects_reserved_prefix() {
        let mut vocab = SignalVocabulary::new();
        let err = vocab.register(SignalId::from("vitals.event"), Vec::new()).unwrap_err();
        assert!(matches!(err, VitalsError::ReservedSignalId { .. }));
    }

    #[test]
    fn vocabulary_rejects_malformed_id_before_reserved_check() {
        let mut vocab = SignalVocabulary::new();
        let err = vocab.register(SignalId::from("not-dotted"), Vec::new()).unwrap_err();
        assert!(matches!(err, VitalsError::InvalidSignalId { .. }));
    }

    #[test]
    fn contains_is_true_for_reserved_prefix_without_registration() {
        let vocab = SignalVocabulary::new();
        assert!(vocab.contains(&SignalId::from("vitals.diagnostic")));
        assert!(!vocab.contains(&SignalId::from("agent.tool_calls")));
    }

    #[test]
    fn contains_is_true_after_registration_even_with_empty_kinds() {
        let mut vocab = SignalVocabulary::new();
        vocab.register(SignalId::from("agent.tool_calls"), Vec::new()).unwrap();
        assert!(vocab.contains(&SignalId::from("agent.tool_calls")));
        assert!(!vocab.contains(&SignalId::from("agent.tool_results")));
    }

    #[test]
    fn kind_feeds_signal_reflects_registered_kinds_only() {
        let mut vocab = SignalVocabulary::new();
        vocab.register(SignalId::from("agent.tool_calls"), vec!["agent.tool_call".to_string()]).unwrap();
        assert!(vocab.kind_feeds_signal(&SignalId::from("agent.tool_calls"), "agent.tool_call"));
        assert!(!vocab.kind_feeds_signal(&SignalId::from("agent.tool_calls"), "agent.tool_result"));
        // 注册过但空 kind 集合的信号：拼写保护通过，门控判据永远 false。
        vocab.register(SignalId::from("agent.approvals"), Vec::new()).unwrap();
        assert!(!vocab.kind_feeds_signal(&SignalId::from("agent.approvals"), "anything"));
    }

    #[test]
    fn registering_the_same_signal_twice_merges_kinds() {
        let mut vocab = SignalVocabulary::new();
        vocab.register(SignalId::from("agent.tool_calls"), vec!["a".to_string()]).unwrap();
        vocab.register(SignalId::from("agent.tool_calls"), vec!["b".to_string()]).unwrap();
        assert!(vocab.kind_feeds_signal(&SignalId::from("agent.tool_calls"), "a"));
        assert!(vocab.kind_feeds_signal(&SignalId::from("agent.tool_calls"), "b"));
    }
}
