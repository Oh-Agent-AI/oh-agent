//! §7.4 Detector Requirement + §9 Detector trait/AuditContext + §9.3
//! RuleOutcome.

use serde::{Deserialize, Serialize};

use crate::coverage::Coverage;
use crate::error::VitalsError;
use crate::event::CanonicalEvent;
use crate::finding::{Finding, FindingDraft};
use crate::signal::SignalId;
use crate::trajectory::Trajectory;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SignalRequirement {
    All(Vec<SignalId>),
    Any(Vec<SignalId>),
}

impl SignalRequirement {
    pub fn signals(&self) -> &[SignalId] {
        match self {
            SignalRequirement::All(s) | SignalRequirement::Any(s) => s,
        }
    }
}

/// §9.2：Detector 在 `detect()` 里能看到的一切。不提供文件系统、网络、时钟
/// 或随机数——那些不在这个结构体里，不是靠约定不用。`events` 是**这条
/// trajectory 自己的事件**（已按 §6.3 排好序），不是整个审计输入的全部事件
/// ——v0.5 一个 Event 只属于一条 Trajectory（§8.4），Detector 不需要、也不
/// 应该看见别的 trajectory 的事件。
///
/// **已知限制，v0.5 没有解决**：`coverage` **不是** trajectory-scoped 的——
/// 它是 `AuditInput.coverage` 原样传下来的同一份引用，一次 `audit()` 调用
/// 里所有 trajectory 的 `AuditContext` 都拿到同一个 `Coverage`。§7.4.1 的门
/// 控（"这条信号有没有可消费事件"）不受影响，它读的是 `events`（已经按
/// trajectory 切好），不读 `coverage`；但 Detector 自己如果在 `detect()`
/// 里读 `ctx.coverage` 做展示或置信度调整，在**单 trajectory** 输入下没问
/// 题（`agent-vitals-domain` 现在的每次 Engine 调用都只喂一个 session、只产
/// 生一条 trajectory），一旦真的有多 trajectory 输入（比如用 `ByActor` 分
/// 组、或者跨来源合并审计），每条 trajectory 看到的 `coverage` 其实是"整
/// 个输入的证据密度"，不是"这条 trajectory 自己的"——数字可能来自另一个
/// Actor 的证据。`Coverage` 是调用方提供的不透明值，Engine 没有办法自动按
/// trajectory 拆分它；真正的修法是让 `AuditInput` 允许调用方按 trajectory
/// 提供 coverage（一次 API 形状变更），v0.5 没有做，先把这条边界写清楚。
pub struct AuditContext<'a> {
    pub trajectory: &'a Trajectory,
    pub events: &'a [CanonicalEvent],
    pub coverage: &'a Coverage,
    pub config: &'a serde_json::Value,
}

/// §9.1：`id + version` 是 Replay 确定性的一部分。相同 `id` 不允许注册多个
/// 版本——Engine builder 校验这条（`DuplicateDetector`），Trait 本身不能。
pub trait Detector: Send + Sync {
    fn id(&self) -> &str;
    fn version(&self) -> &str;
    fn requirement(&self) -> SignalRequirement;

    fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError>;
}

/// §9.3：Engine 对每条规则、在每条 trajectory 上，必须产出且只能产出这三种
/// 之一。这里的 `Findings` 持有已经完成 id/fingerprint 分配的 `Finding`
/// （不是 Detector 返回的 `FindingDraft`）——这是 Engine 完成 Finding
/// Validation + Fingerprint/Dedup 之后的产物，与 `AuditReport`/`ReplayReport`
/// 里出现的形状是同一份。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RuleOutcome {
    Findings(Vec<Finding>),
    MeasuredZero,
    Unavailable { missing: Vec<SignalId>, reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signals_unwraps_either_variant() {
        let all = SignalRequirement::All(vec![SignalId::from("agent.tool_calls")]);
        let any = SignalRequirement::Any(vec![SignalId::from("agent.approvals")]);
        assert_eq!(all.signals(), &[SignalId::from("agent.tool_calls")]);
        assert_eq!(any.signals(), &[SignalId::from("agent.approvals")]);
    }

    #[test]
    fn round_trips_through_json() {
        let req = SignalRequirement::All(vec![SignalId::from("agent.tool_calls")]);
        let json = serde_json::to_value(&req).unwrap();
        let back: SignalRequirement = serde_json::from_value(json).unwrap();
        assert_eq!(back, req);

        let outcome = RuleOutcome::Unavailable {
            missing: vec![SignalId::from("agent.tool_calls")],
            reason: "no consumable evidence".to_string(),
        };
        let json = serde_json::to_value(&outcome).unwrap();
        let back: RuleOutcome = serde_json::from_value(json).unwrap();
        assert_eq!(back, outcome);
    }
}
