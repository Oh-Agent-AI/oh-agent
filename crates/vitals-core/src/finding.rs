//! §10.2 Finding + §10.3 Fingerprint.
//!
//! `FindingDraft` is what a `Detector` returns (§9.1)：Engine assigns `id`
//! and `fingerprint` during finalize, so Detector authors never construct
//! those two fields themselves — spec §9 只给出 `Detector::detect` 的返回
//! 类型是 `Vec<FindingDraft>`，没有单独给出这个类型的字段集；这里按"`Finding`
//! 减去 Engine 独有的两个字段"补全，是唯一不引入歧义的读法：Draft 携带的信
//! 息必须恰好是 Detector 能知道、且 fingerprint 计算需要的那些。

use serde::{Deserialize, Serialize};

use crate::canonical::{canonical_string, sha256_hex};
use crate::evidence::Evidence;
use crate::id::{FindingId, TrajectoryId};

/// 三级严重度，沿用现有 `agent-vitals-domain` 的 critical/warning/info 三分。
/// 派生 `Ord` 按声明顺序：`Critical < Warning < Info`，升序排列即"最严重的
/// 排在最前"——§12.4 "findings：severity rank" 的具体含义。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Severity {
    Critical,
    Warning,
    Info,
}

/// Detector 的产出（§9.1）。不含 `id` / `fingerprint`——两者都需要
/// `detector_id` / `detector_version` / `trajectory_id` / `config`，这些是
/// Engine 才知道的上下文（`AuditContext` 只把 `trajectory`/`config` 借给
/// Detector 读，不要求它自己拼 fingerprint）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FindingDraft {
    pub kind: String,
    pub severity: Severity,
    pub confidence: Option<f32>,
    pub evidence: Vec<Evidence>,
    pub summary: String,
    pub attributes: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub schema_version: u16,
    pub id: FindingId,
    pub detector_id: String,
    pub detector_version: String,
    pub kind: String,
    pub severity: Severity,
    pub confidence: Option<f32>,
    pub trajectory_id: TrajectoryId,
    pub evidence: Vec<Evidence>,
    pub summary: String,
    pub attributes: serde_json::Value,
    pub fingerprint: String,
}

/// §10.3：由 `detector_id` / `detector_version` / `kind` / `trajectory_id` /
/// 排序后的 evidence event id / 影响判定的 detector config 生成——**不**含
/// 生成时间、随机 ID、summary 文案、展示顺序、本机绝对路径。
///
/// `evidence` 参数在哈希前按 event id 排序去重：Detector 完全可能在多条
/// Evidence 里重复引用同一个 event，或者以任意顺序构造 evidence 列表，那些
/// 都不该改变 fingerprint（§4.5 Deterministic-first）。
pub fn compute_fingerprint(
    detector_id: &str,
    detector_version: &str,
    kind: &str,
    trajectory_id: &TrajectoryId,
    evidence: &[Evidence],
    config: &serde_json::Value,
) -> String {
    let mut event_ids: Vec<&str> = evidence.iter().flat_map(|e| e.event_ids.iter()).map(|id| id.as_str()).collect();
    event_ids.sort_unstable();
    event_ids.dedup();
    let payload = serde_json::json!({
        "detector_id": detector_id,
        "detector_version": detector_version,
        "kind": kind,
        "trajectory_id": trajectory_id.as_str(),
        "evidence_event_ids": event_ids,
        "config": config,
    });
    sha256_hex(&canonical_string(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::SourceRef;
    use crate::id::EventId;

    fn evidence(ids: &[&str]) -> Vec<Evidence> {
        vec![Evidence {
            event_ids: ids.iter().map(|s| EventId::from(*s)).collect(),
            description: String::new(),
            source_refs: vec![SourceRef {
                source_type: "session_log".to_string(),
                source_id: "session-1".to_string(),
                raw_reference: None,
                raw_ordinal: None,
            }],
            attributes: serde_json::json!({}),
        }]
    }

    #[test]
    fn severity_ranks_critical_first() {
        let mut xs = vec![Severity::Info, Severity::Critical, Severity::Warning];
        xs.sort();
        assert_eq!(xs, vec![Severity::Critical, Severity::Warning, Severity::Info]);
    }

    #[test]
    fn fingerprint_is_stable_for_the_same_logical_inputs() {
        let traj = TrajectoryId::from("traj-1");
        let cfg = serde_json::json!({"threshold": 3});
        let a = compute_fingerprint("no_progress_loop", "1", "repetition", &traj, &evidence(&["e1", "e2"]), &cfg);
        let b = compute_fingerprint("no_progress_loop", "1", "repetition", &traj, &evidence(&["e1", "e2"]), &cfg);
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_is_insensitive_to_evidence_order_and_duplicates() {
        let traj = TrajectoryId::from("traj-1");
        let cfg = serde_json::json!({});
        let ordered = compute_fingerprint("d", "1", "k", &traj, &evidence(&["e1", "e2"]), &cfg);
        let reordered = compute_fingerprint("d", "1", "k", &traj, &evidence(&["e2", "e1"]), &cfg);
        let duplicated = compute_fingerprint("d", "1", "k", &traj, &evidence(&["e1", "e1", "e2"]), &cfg);
        assert_eq!(ordered, reordered);
        assert_eq!(ordered, duplicated);
    }

    #[test]
    fn fingerprint_changes_when_config_changes() {
        // §10.3："影响判定的 detector config" 参与哈希——阈值变了，同一段证
        // 据应该被认成不同的 finding 身份（下一份报告不会误判成"同一条"）。
        let traj = TrajectoryId::from("traj-1");
        let a = compute_fingerprint("d", "1", "k", &traj, &evidence(&["e1"]), &serde_json::json!({"threshold": 3}));
        let b = compute_fingerprint("d", "1", "k", &traj, &evidence(&["e1"]), &serde_json::json!({"threshold": 5}));
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_does_not_depend_on_key_order_in_config() {
        let traj = TrajectoryId::from("traj-1");
        let a = compute_fingerprint("d", "1", "k", &traj, &evidence(&["e1"]), &serde_json::json!({"a": 1, "b": 2}));
        let b = compute_fingerprint("d", "1", "k", &traj, &evidence(&["e1"]), &serde_json::json!({"b": 2, "a": 1}));
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_changes_when_trajectory_differs() {
        let cfg = serde_json::json!({});
        let a = compute_fingerprint("d", "1", "k", &TrajectoryId::from("traj-1"), &evidence(&["e1"]), &cfg);
        let b = compute_fingerprint("d", "1", "k", &TrajectoryId::from("traj-2"), &evidence(&["e1"]), &cfg);
        assert_ne!(a, b);
    }

    #[test]
    fn round_trips_through_json() {
        let f = Finding {
            schema_version: 1,
            id: FindingId::from("finding-1"),
            detector_id: "no_progress_loop".to_string(),
            detector_version: "1".to_string(),
            kind: "repetition".to_string(),
            severity: Severity::Warning,
            confidence: Some(0.9),
            trajectory_id: TrajectoryId::from("traj-1"),
            evidence: evidence(&["e1"]),
            summary: "repeated the same action 3 times with no progress".to_string(),
            attributes: serde_json::json!({}),
            fingerprint: "deadbeef".to_string(),
        };
        let json = serde_json::to_value(&f).unwrap();
        let back: Finding = serde_json::from_value(json).unwrap();
        assert_eq!(back, f);
    }
}
