//! §11 Replay.

use serde::{Deserialize, Serialize};

use crate::detector::RuleOutcome;
use crate::diagnostic::Diagnostic;
use crate::finding::Finding;
use crate::id::{EventId, FindingId, TrajectoryId};

/// §11.1：存 `event_id`，不内嵌整份 `CanonicalEvent`——一帧一份全量拷贝会让
/// Replay 的内存占用变成输入的整数倍，直接顶到 §17「内存峰值不超过输入
/// 8 倍」的红线。`AuditReport.trajectories`/事件本身已经能在别处查到全量，
/// 消费者按 `event_id` 查表（spec §11.1 patch）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReplayFrame {
    pub index: u64,
    pub event_id: EventId,
    pub trajectory_id: TrajectoryId,
    /// 这一帧"打开"的 Finding——§11.4：只有 Detector 能通过 Evidence 明确
    /// 定位锚点时才写入。v0.5 的 Evidence-first 纪律（§4.2/§10.1）保证每条
    /// Finding 的 evidence 都非空，所以锚点总是存在：定义为该 Finding 全部
    /// evidence event id 中 `(ordinal, id)` 最大的那一个（"证据链条上最后
    /// 发生的那个事件，是这个发现真正成立的时刻"）。"无锚点因此只出现在顶
    /// 层"的分支在 v0.5 里结构性地不会触发——见 `engine.rs` 的组装逻辑。
    pub findings_opened: Vec<FindingId>,
    pub diagnostics: Vec<Diagnostic>,
}

/// §11.2 patch：拆成多段而不是一个不透明串——"20 次运行 fingerprint 完全
/// 一致"（§17）一旦不一致，读者需要知道是哪一段变了：事件、config，还是有
/// 人 bump 了某个 detector 版本忘了说。
///
/// `assigner_id` / `signal_vocabulary_hash` / `detector_versions_hash` 三个
/// 一起覆盖"改变 Engine 构建方式会不会改变输出、指纹却不知道"这类漏洞：
/// - 换一个 `TrajectoryAssigner`（`BySourceSession` → `ByActor`）会改变
///   Trajectory 划分、进而改变门控和 Finding 归属，必须体现在指纹里；
/// - `SignalVocabulary` 的 kind→signal 映射变了，门控判据（§7.4.1）跟着
///   变，同样必须体现；
/// - `detector_versions_hash` 按 **注册顺序**（不是排序后的顺序，那是
///   `ReplayReport.detector_versions` 的展示序）哈希——同一组 Detector 换个
///   注册顺序，`next_finding_seq` 分配 `FindingId` 的顺序会变、报告里每条
///   Finding 的 `id` 因此会变，如果这里按排序后的顺序哈希，两次不同注册顺
///   序的运行会给出**同一个**指纹却产出不同的报告内容，"同一个指纹 ⟹ 同一
///   份报告"这条承诺就是假的。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InputFingerprint {
    pub events_hash: String,
    pub config_hash: String,
    pub detector_versions_hash: String,
    pub assigner_id: String,
    pub signal_vocabulary_hash: String,
    pub engine_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectorVersion {
    pub detector_id: String,
    pub detector_version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NamedRuleOutcome {
    pub detector_id: String,
    pub trajectory_id: TrajectoryId,
    pub outcome: RuleOutcome,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReplayReport {
    pub schema_version: u16,
    pub engine_version: String,
    pub detector_versions: Vec<DetectorVersion>,
    pub input_fingerprint: InputFingerprint,
    pub frames: Vec<ReplayFrame>,
    pub outcomes: Vec<NamedRuleOutcome>,
    pub findings: Vec<Finding>,
    pub diagnostics: Vec<Diagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let frame = ReplayFrame {
            index: 0,
            event_id: EventId::from("evt-1"),
            trajectory_id: TrajectoryId::from("traj-1"),
            findings_opened: vec![],
            diagnostics: vec![],
        };
        let json = serde_json::to_value(&frame).unwrap();
        let back: ReplayFrame = serde_json::from_value(json).unwrap();
        assert_eq!(back, frame);

        let fp = InputFingerprint {
            events_hash: "a".to_string(),
            config_hash: "b".to_string(),
            detector_versions_hash: "c".to_string(),
            assigner_id: "by_source_session".to_string(),
            signal_vocabulary_hash: "d".to_string(),
            engine_version: "0.5.0".to_string(),
        };
        let json = serde_json::to_value(&fp).unwrap();
        let back: InputFingerprint = serde_json::from_value(json).unwrap();
        assert_eq!(back, fp);
    }
}
