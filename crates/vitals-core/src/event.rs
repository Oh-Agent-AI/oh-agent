//! §6 Canonical Event——不同执行环境的离散事件被翻译成的唯一形状。Core 不解释
//! `kind` / `attributes` 的内容（§4.1 Domain-free），只对它们做结构性校验。

use serde::{Deserialize, Serialize};

use crate::error::VitalsError;
use crate::id::{ActorId, EventId, GoalId};
use crate::provenance::Provenance;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CanonicalEvent {
    pub schema_version: u16,
    pub id: EventId,
    pub actor_id: ActorId,
    pub goal_id: Option<GoalId>,
    /// 领域定义的事件类型，Core 只做非空校验（§6.2）。
    pub kind: String,
    /// Adapter 对当前审计输入分配的严格递增顺序——权威执行顺序（§6.3）。
    pub ordinal: u64,
    /// 允许缺失；缺失不等于 `0`（§6.2）。只用于展示和时间窗口，不参与排序。
    pub occurred_at_ms: Option<i64>,
    /// 必须为 JSON object（§6.2，`validate()` 校验）。
    pub attributes: serde_json::Value,
    /// 事件的可选结果，不强制所有行为都有反馈（§6.2）。
    pub outcome: Option<serde_json::Value>,
    pub source: SourceRef,
    /// 描述 Canonical Event 本身如何获得——不是事件内容的 provenance。
    pub provenance: Provenance,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SourceRef {
    pub source_type: String,
    pub source_id: String,
    /// 文件路径、blob ID 或其他可追溯引用，允许脱敏（§6.2）。
    pub raw_reference: Option<String>,
    pub raw_ordinal: Option<u64>,
}

impl CanonicalEvent {
    /// §6.5 单事件本地校验（硬错误）。跨事件的规则——重复 ID、schema major
    /// 是否被当前 Engine 支持——需要看"别的事件"或"Engine 配置"，属于 M1 的
    /// Engine 职责，不在这里。
    pub fn validate(&self) -> Result<(), VitalsError> {
        if self.id.as_str().is_empty() {
            return Err(VitalsError::InvalidEvent {
                event_id: None,
                reason: "event id must not be empty".to_string(),
            });
        }
        if self.actor_id.as_str().is_empty() {
            return Err(VitalsError::InvalidEvent {
                event_id: Some(self.id.clone()),
                reason: "actor id must not be empty".to_string(),
            });
        }
        if self.kind.is_empty() {
            return Err(VitalsError::InvalidEvent {
                event_id: Some(self.id.clone()),
                reason: "kind must not be empty".to_string(),
            });
        }
        if !self.attributes.is_object() {
            return Err(VitalsError::InvalidEvent {
                event_id: Some(self.id.clone()),
                reason: "attributes must be a JSON object".to_string(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(kind: &str, attributes: serde_json::Value) -> CanonicalEvent {
        CanonicalEvent {
            schema_version: 1,
            id: EventId::from("evt-1"),
            actor_id: ActorId::from("actor-1"),
            goal_id: None,
            kind: kind.to_string(),
            ordinal: 0,
            occurred_at_ms: None,
            attributes,
            outcome: None,
            source: SourceRef {
                source_type: "session_log".to_string(),
                source_id: "session-1".to_string(),
                raw_reference: None,
                raw_ordinal: None,
            },
            provenance: Provenance::Measured,
        }
    }

    #[test]
    fn round_trips_through_json() {
        let event = sample("agent.tool_call", serde_json::json!({"name": "bash"}));
        let json = serde_json::to_value(&event).unwrap();
        let back: CanonicalEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, event);
    }

    #[test]
    fn validate_accepts_well_formed_event() {
        let event = sample("agent.tool_call", serde_json::json!({}));
        assert!(event.validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_id() {
        let mut event = sample("agent.tool_call", serde_json::json!({}));
        event.id = EventId::from("");
        let err = event.validate().unwrap_err();
        assert!(matches!(err, VitalsError::InvalidEvent { event_id: None, .. }));
    }

    #[test]
    fn validate_rejects_empty_actor() {
        let mut event = sample("agent.tool_call", serde_json::json!({}));
        event.actor_id = ActorId::from("");
        assert!(event.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_kind() {
        let event = sample("", serde_json::json!({}));
        assert!(event.validate().is_err());
    }

    #[test]
    fn validate_rejects_non_object_attributes() {
        // §6.2：attributes 必须是 JSON object——数组/标量都不行。
        let event = sample("agent.tool_call", serde_json::json!([1, 2, 3]));
        assert!(event.validate().is_err());
    }

    #[test]
    fn occurred_at_ms_missing_is_not_zero() {
        // §6.2：缺失不等于 0——回归的是"用 unwrap_or(0) 悄悄伪造时间戳"这类
        // bug；这里只断言默认状态确实是 None，不是某个哨兵数字。
        let event = sample("agent.tool_call", serde_json::json!({}));
        assert_eq!(event.occurred_at_ms, None);
    }
}
