//! §6.1 ID newtype——同一来源内稳定、可重建的字符串标识（§6.2：不能用本次
//! 进程随机值）。故意不派生 `Default`：一个"空 ID"意外通过编译，比多写几个
//! `From` 实现更危险。

use serde::{Deserialize, Serialize};

macro_rules! id_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_string())
            }
        }
    };
}

id_newtype!(
    /// §6.1：一个 Canonical Event 在其来源内的稳定标识。
    EventId
);
id_newtype!(
    /// §6.2：行为主体；来源无法提供时由 Adapter 生成稳定匿名 ID。
    ActorId
);
id_newtype!(
    /// 目标标识，`CanonicalEvent.goal_id` / `Trajectory.goal_id` 均可选。
    GoalId
);
id_newtype!(
    /// §8.1：一条 Trajectory 的稳定标识。
    TrajectoryId
);
id_newtype!(
    /// §10.2：一条 Finding 的标识——Engine 在 finalize 时分配，Detector 不
    /// 接触这个类型（它只产出 `FindingDraft`，见 `finding.rs`）。
    FindingId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let id = EventId::from("evt-1");
        let json = serde_json::to_value(&id).unwrap();
        assert_eq!(json, serde_json::json!("evt-1"));
        let back: EventId = serde_json::from_value(json).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn ord_is_lexicographic_on_the_inner_string() {
        // Trajectory 的多轨迹（§12.4）与 Finding fingerprint（§10.3，M1）都
        // 依赖 EventId 有一个稳定的、与内容对应的排序——不是插入序。
        let mut ids = vec![EventId::from("b"), EventId::from("a"), EventId::from("c")];
        ids.sort();
        assert_eq!(ids, vec![EventId::from("a"), EventId::from("b"), EventId::from("c")]);
    }

    #[test]
    fn display_matches_inner_string() {
        assert_eq!(ActorId::from("actor-7").to_string(), "actor-7");
    }
}
