//! §13.2 Diagnostic——可恢复问题进入报告，不能只写 stderr。与 §13.1 的
//! `VitalsError` 是不同的通道：`VitalsError` 让整次 `finalize` 失败，
//! `Diagnostic` 让报告带着"这里有一件事你该知道"继续生成。

use serde::{Deserialize, Serialize};

use crate::id::{EventId, TrajectoryId};

/// §13.2 列出的已知 code——Engine 目前只产生这几种；不是封闭 enum（Detector
/// 作者未来可能需要报告自己的可恢复问题），但这些字符串常量避免拼写漂移。
pub const DUPLICATE_EVENT_IGNORED: &str = "DUPLICATE_EVENT_IGNORED";
pub const DUPLICATE_ORDINAL: &str = "DUPLICATE_ORDINAL";
pub const MISSING_TIMESTAMP: &str = "MISSING_TIMESTAMP";
pub const LOSSY_SOURCE: &str = "LOSSY_SOURCE";
pub const EMPTY_TRAJECTORY: &str = "EMPTY_TRAJECTORY";
pub const FINDING_DEDUPLICATED: &str = "FINDING_DEDUPLICATED";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub event_id: Option<EventId>,
    pub trajectory_id: Option<TrajectoryId>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let d = Diagnostic {
            code: DUPLICATE_EVENT_IGNORED.to_string(),
            message: "duplicate event id evt-1 ignored".to_string(),
            event_id: Some(EventId::from("evt-1")),
            trajectory_id: None,
        };
        let json = serde_json::to_value(&d).unwrap();
        let back: Diagnostic = serde_json::from_value(json).unwrap();
        assert_eq!(back, d);
    }
}
