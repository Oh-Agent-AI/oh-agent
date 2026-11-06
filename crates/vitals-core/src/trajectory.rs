//! §8 Trajectory——一份连续行为在事件流上的最小生命周期模型。§8.1 的类型和
//! §8.3 的合法状态转移是 M0 交付；§8.2 的 `TrajectoryAssigner` trait 及内置
//! 的 `BySourceSession`/`ByActor` 是 M1（Engine 才有"逐事件分配"的编排上下
//! 文）。

use serde::{Deserialize, Serialize};

use crate::error::VitalsError;
use crate::event::CanonicalEvent;
use crate::id::{ActorId, EventId, GoalId, TrajectoryId};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrajectoryStatus {
    Open,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trajectory {
    pub schema_version: u16,
    pub id: TrajectoryId,
    pub actor_id: ActorId,
    pub goal_id: Option<GoalId>,
    pub event_ids: Vec<EventId>,
    pub status: TrajectoryStatus,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub attributes: serde_json::Value,
}

impl Trajectory {
    /// §8.3：`不存在 → open`。
    pub fn open(id: TrajectoryId, actor_id: ActorId, goal_id: Option<GoalId>, schema_version: u16) -> Self {
        Trajectory {
            schema_version,
            id,
            actor_id,
            goal_id,
            event_ids: Vec::new(),
            status: TrajectoryStatus::Open,
            started_at_ms: None,
            ended_at_ms: None,
            attributes: serde_json::json!({}),
        }
    }

    /// §8.3：`open → append`。`closed → append` 是硬错误，不做隐式修复
    /// （不重开、不静默丢弃）。
    pub fn append(&mut self, event_id: EventId, occurred_at_ms: Option<i64>) -> Result<(), VitalsError> {
        if self.status != TrajectoryStatus::Open {
            return Err(VitalsError::InvalidTrajectory {
                trajectory_id: self.id.clone(),
                reason: "cannot append to a closed trajectory".to_string(),
            });
        }
        if self.started_at_ms.is_none() {
            self.started_at_ms = occurred_at_ms;
        }
        self.event_ids.push(event_id);
        Ok(())
    }

    /// §8.3：`open → close`。已 closed 再次 close 同样是硬错误——v0.5 不支持
    /// reopen（§8.3 明写不允许 `closed → reopen`）。
    pub fn close(&mut self, ended_at_ms: Option<i64>) -> Result<(), VitalsError> {
        if self.status != TrajectoryStatus::Open {
            return Err(VitalsError::InvalidTrajectory {
                trajectory_id: self.id.clone(),
                reason: "trajectory is already closed".to_string(),
            });
        }
        self.status = TrajectoryStatus::Closed;
        self.ended_at_ms = ended_at_ms;
        Ok(())
    }
}

/// §8.2：v0.5 不提供通用 Builder 组合器，只提供一个明确接口——一个 Event
/// 决定自己归入哪条 Trajectory，不看别的事件。
///
/// `id()`——同 `Detector::id()` 的理由：`VitalsEngine` 换一个 assigner
/// （比如从 `BySourceSession` 换成 `ByActor`）会改变 Trajectory 的划分方式，
/// 进而改变门控、Finding 归属，是真实会改变输出内容的一个"配置维度"，必须
/// 能被 `input_fingerprint` 捕捉到（§62：assigner 换了、指纹却不变，"同一
/// 个指纹保证同一份报告"这条承诺就是假的）。
pub trait TrajectoryAssigner: Send + Sync {
    fn id(&self) -> &str;
    fn assign(&self, event: &CanonicalEvent) -> Result<TrajectoryId, VitalsError>;
}

/// §8.2 内置：一份来源 session 对应一条 trajectory。§14.2 兼容桥默认用它，
/// 保证一份现有 session 对应一条 trajectory。
///
/// key 是 `source_type` + `source_id`，不是单独的 `source_id`——只用
/// `source_id` 分组时，两个**不同来源**的会话只要碰巧用了同一个
/// `source_id`（比如都叫 `"session-1"`，这在跨来源合并审计——同时喂
/// Codex 和 DSH 的事件——时完全可能发生），就会被并成同一条 Trajectory；
/// `source_type` 参与 key 至少把"同一来源内 id 冲突"和"跨来源 id 恰好撞
/// 上"这两类风险分开，后者的概率因此低得多。这不是唯一的防线——Engine 在
/// 组装 Trajectory 时还会硬性校验同一条 Trajectory 里的事件 `actor_id`
/// 必须一致，真正撞上时是报错，不是静默把两个 Actor 的证据混进一条
/// Trajectory（见 `engine.rs::run_pipeline` 的 Trajectory Assignment 步骤）。
pub struct BySourceSession;

impl TrajectoryAssigner for BySourceSession {
    fn id(&self) -> &str {
        "by_source_session"
    }
    fn assign(&self, event: &CanonicalEvent) -> Result<TrajectoryId, VitalsError> {
        Ok(TrajectoryId::from(format!("{}:{}", event.source.source_type, event.source.source_id)))
    }
}

/// §8.2 内置：按行为主体分组，不看事件的来源 session。
pub struct ByActor;

impl TrajectoryAssigner for ByActor {
    fn id(&self) -> &str {
        "by_actor"
    }
    fn assign(&self, event: &CanonicalEvent) -> Result<TrajectoryId, VitalsError> {
        Ok(TrajectoryId::from(event.actor_id.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened() -> Trajectory {
        Trajectory::open(TrajectoryId::from("traj-1"), ActorId::from("actor-1"), None, 1)
    }

    #[test]
    fn round_trips_through_json() {
        let mut traj = opened();
        traj.append(EventId::from("evt-1"), Some(1000)).unwrap();
        let json = serde_json::to_value(&traj).unwrap();
        let back: Trajectory = serde_json::from_value(json).unwrap();
        assert_eq!(back, traj);
    }

    #[test]
    fn open_starts_with_no_events_and_open_status() {
        let traj = opened();
        assert_eq!(traj.status, TrajectoryStatus::Open);
        assert!(traj.event_ids.is_empty());
        assert_eq!(traj.started_at_ms, None);
    }

    #[test]
    fn append_records_first_occurred_at_ms_and_keeps_it_on_later_appends() {
        let mut traj = opened();
        traj.append(EventId::from("evt-1"), Some(1000)).unwrap();
        traj.append(EventId::from("evt-2"), Some(2000)).unwrap();
        assert_eq!(traj.event_ids, vec![EventId::from("evt-1"), EventId::from("evt-2")]);
        assert_eq!(traj.started_at_ms, Some(1000));
    }

    #[test]
    fn append_after_close_is_a_hard_error() {
        let mut traj = opened();
        traj.close(Some(5000)).unwrap();
        let err = traj.append(EventId::from("evt-1"), Some(1000)).unwrap_err();
        assert!(matches!(err, VitalsError::InvalidTrajectory { .. }));
    }

    #[test]
    fn close_after_close_is_a_hard_error_not_a_reopen() {
        let mut traj = opened();
        traj.close(Some(5000)).unwrap();
        let err = traj.close(Some(6000)).unwrap_err();
        assert!(matches!(err, VitalsError::InvalidTrajectory { .. }));
        // 状态和 ended_at_ms 不因为失败的第二次 close 被改写。
        assert_eq!(traj.ended_at_ms, Some(5000));
    }

    fn sample_event(source_id: &str, actor_id: &str) -> CanonicalEvent {
        use crate::event::SourceRef;
        use crate::provenance::Provenance;

        CanonicalEvent {
            schema_version: 1,
            id: EventId::from("evt-1"),
            actor_id: ActorId::from(actor_id),
            goal_id: None,
            kind: "agent.tool_call".to_string(),
            ordinal: 0,
            occurred_at_ms: None,
            attributes: serde_json::json!({}),
            outcome: None,
            source: SourceRef {
                source_type: "session_log".to_string(),
                source_id: source_id.to_string(),
                raw_reference: None,
                raw_ordinal: None,
            },
            provenance: Provenance::Measured,
        }
    }

    #[test]
    fn by_source_session_groups_by_source_id_not_actor() {
        let a = sample_event("session-1", "actor-a");
        let b = sample_event("session-1", "actor-b");
        assert_eq!(BySourceSession.assign(&a).unwrap(), BySourceSession.assign(&b).unwrap());
    }

    #[test]
    fn by_actor_groups_by_actor_not_source_session() {
        let a = sample_event("session-1", "actor-a");
        let b = sample_event("session-2", "actor-a");
        assert_eq!(ByActor.assign(&a).unwrap(), ByActor.assign(&b).unwrap());

        let c = sample_event("session-1", "actor-c");
        assert_ne!(ByActor.assign(&a).unwrap(), ByActor.assign(&c).unwrap());
    }
}
