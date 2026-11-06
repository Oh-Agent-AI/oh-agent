//! §13.1 硬错误——Engine 遇到这些必须以 `Err` 返回，不能吞掉，也不能降级成
//! §13.2 的 Diagnostic（两者是不同的通道：Diagnostic 是"可恢复、报告继续
//! 生成"，这里是"整次 finalize/build 失败"）。
//!
//! M0 只交付类型本身。`ConflictingDuplicate` / `DuplicateDetector` /
//! `DetectorFailed` / `Serialization` 目前没有调用方——Engine 是 M1 的交付
//! 物——提前把完整枚举定下来，是为了不在 M1 回头改这个类型的字段集（那本身
//! 就是一次 breaking change，§15.2）。
//!
//! `UnknownSignal` / `InvalidSignalId` / `ReservedSignalId` 三个变体是 spec
//! 补丁引入的（§7.1）：`SignalId` 是开放字符串 newtype，拼写错误不能是运行
//! 期静默的 Unavailable，必须是构建期硬错误——这三个变体就是那条防线的类型
//! 落点。

use serde::{Deserialize, Serialize};

use crate::id::{EventId, TrajectoryId};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
pub enum VitalsError {
    #[error("unsupported schema version: found {found}, supported {supported}")]
    UnsupportedSchema { found: u16, supported: u16 },

    #[error("invalid event {event_id:?}: {reason}")]
    InvalidEvent { event_id: Option<EventId>, reason: String },

    #[error("conflicting duplicate event id {event_id}")]
    ConflictingDuplicate { event_id: EventId },

    #[error("invalid trajectory {trajectory_id}: {reason}")]
    InvalidTrajectory { trajectory_id: TrajectoryId, reason: String },

    #[error("invalid finding from detector {detector_id}: {reason}")]
    InvalidFinding { detector_id: String, reason: String },

    #[error("duplicate detector id {detector_id}")]
    DuplicateDetector { detector_id: String },

    #[error("detector {detector_id} failed: {reason}")]
    DetectorFailed { detector_id: String, reason: String },

    #[error("serialization failed: {reason}")]
    Serialization { reason: String },

    /// §7.1 patch：某个 Detector 的 `requirement()` / `enhances` 引用了未在
    /// `SignalVocabulary` 注册的 `SignalId`。构建期硬错误，绝不允许它在运行
    /// 期悄悄退化成"这条规则 Unavailable"——那样和拼写正确但证据缺失的情况
    /// 在报告里完全无法区分。
    #[error("detector {detector_id} requires unregistered signal `{signal_id}`")]
    UnknownSignal { detector_id: String, signal_id: String },

    /// §7.1：`SignalId` 格式非法——非空、仅 `[a-z0-9_.]`、至少一个 `.`、
    /// 不以 `.` 起止。
    #[error("invalid signal id `{signal_id}`: must be non-empty, lowercase ascii, dot-separated, and not start or end with '.'")]
    InvalidSignalId { signal_id: String },

    /// §7.1：`vitals.` 前缀由 Core 预置，Domain 不得注册。
    #[error("signal id `{signal_id}` uses the reserved `vitals.` prefix")]
    ReservedSignalId { signal_id: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let err = VitalsError::InvalidTrajectory {
            trajectory_id: TrajectoryId::from("traj-1"),
            reason: "cannot append to a closed trajectory".to_string(),
        };
        let json = serde_json::to_value(&err).unwrap();
        let back: VitalsError = serde_json::from_value(json).unwrap();
        assert_eq!(back, err);
    }

    #[test]
    fn display_message_is_stable() {
        let err = VitalsError::UnknownSignal {
            detector_id: "no_progress_loop".to_string(),
            signal_id: "agent.toolcalls".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "detector no_progress_loop requires unregistered signal `agent.toolcalls`"
        );
    }
}
