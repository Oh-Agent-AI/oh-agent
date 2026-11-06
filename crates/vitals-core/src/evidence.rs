//! §10.1 Evidence——Finding 定位证据所需的最小信息。§4.2 Evidence-first：没
//! 有可定位证据的 Detector 输出是契约错误，`is_well_formed` 是这条纪律的类
//! 型化检查点，Engine 在 Finding Validation 步骤（§12.3）里用它。

use serde::{Deserialize, Serialize};

use crate::event::SourceRef;
use crate::id::EventId;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    pub event_ids: Vec<EventId>,
    /// 短说明，不承担结构化事实（§10.1）。
    pub description: String,
    /// 消费者定位或请求原文用；原始大段日志不得复制进这里（§18.2 Evidence
    /// 最小化——Core 无法强制这条纪律，只能在文档里写清楚）。
    pub source_refs: Vec<SourceRef>,
    pub attributes: serde_json::Value,
}

impl Evidence {
    /// §10.1：`event_ids` 不能为空。
    pub fn is_well_formed(&self) -> bool {
        !self.event_ids.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_ref() -> SourceRef {
        SourceRef {
            source_type: "session_log".to_string(),
            source_id: "session-1".to_string(),
            raw_reference: None,
            raw_ordinal: None,
        }
    }

    #[test]
    fn round_trips_through_json() {
        let ev = Evidence {
            event_ids: vec![EventId::from("evt-1")],
            description: "matched dangerous shell pattern".to_string(),
            source_refs: vec![source_ref()],
            attributes: serde_json::json!({}),
        };
        let json = serde_json::to_value(&ev).unwrap();
        let back: Evidence = serde_json::from_value(json).unwrap();
        assert_eq!(back, ev);
    }

    #[test]
    fn is_well_formed_requires_at_least_one_event_id() {
        let empty = Evidence {
            event_ids: vec![],
            description: String::new(),
            source_refs: vec![],
            attributes: serde_json::json!({}),
        };
        assert!(!empty.is_well_formed());

        let ok = Evidence {
            event_ids: vec![EventId::from("evt-1")],
            description: String::new(),
            source_refs: vec![],
            attributes: serde_json::json!({}),
        };
        assert!(ok.is_well_formed());
    }
}
