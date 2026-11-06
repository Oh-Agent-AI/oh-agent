//! §7.3 Coverage——沿用 `agent-vitals-domain::evidence::CoverageCounts` 的四桶
//! 计数语义（measured / derived / lossy / unmetered），移植进通用 crate、以
//! `SignalId` 为键。`ratio()` 的语义不变：`total == 0` 时必须是 `None`，
//! 不能输出 `0.0`——`Unavailable` 不得被序列化为零（§4.3）的数值版本。
//!
//! **`Coverage` 本身不是 §7.4.1 的门控判据**：门控读的是"该信号有几个可消
//! 费事件"，不是这里的计数——`unmetered` 尤其不能参与门控，它的定义就是
//! "已知发生过、但除此之外一无所知"，把它算进"有证据"会让检测器在读不到内
//! 容的事件上空转。这个判据本身（`SignalEvidence` / consumable_events）属
//! 于 Engine（M1），`Coverage` 在 M0 只是报告轴的类型定义。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::signal::SignalId;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoverageCounts {
    pub measured: u64,
    pub derived: u64,
    pub lossy: u64,
    /// 已知发生过、但除此之外一无所知——分母里"承重"的一项：适配器不能靠
    /// "读不到就不算"来偷偷刷高自己的覆盖率。
    pub unmetered: u64,
}

impl CoverageCounts {
    pub fn total(&self) -> u64 {
        self.measured + self.derived + self.lossy + self.unmetered
    }

    /// `(measured + derived) / total`；`total == 0` 时 `None`。
    pub fn ratio(&self) -> Option<f64> {
        let total = self.total();
        if total == 0 {
            None
        } else {
            Some((self.measured + self.derived) as f64 / total as f64)
        }
    }
}

/// 一份审计输入里，每条信号各自的覆盖情况。未显式 `set` 过的信号查询时返回
/// 全零 `CoverageCounts`（等价于"这条信号完全没见过"，`ratio()` 仍是
/// `None`）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Coverage(BTreeMap<SignalId, CoverageCounts>);

impl Coverage {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, signal: &SignalId) -> CoverageCounts {
        self.0.get(signal).copied().unwrap_or_default()
    }

    pub fn set(&mut self, signal: SignalId, counts: CoverageCounts) {
        self.0.insert(signal, counts);
    }

    pub fn signals(&self) -> impl Iterator<Item = &SignalId> {
        self.0.keys()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_is_none_when_total_is_zero() {
        assert_eq!(CoverageCounts::default().ratio(), None);
    }

    #[test]
    fn ratio_counts_measured_and_derived_only() {
        let c = CoverageCounts { measured: 3, derived: 1, lossy: 1, unmetered: 5 };
        // (3+1) / (3+1+1+5) = 4/10
        assert_eq!(c.ratio(), Some(0.4));
    }

    #[test]
    fn unset_signal_reads_as_all_zero_not_missing() {
        let cov = Coverage::new();
        assert_eq!(cov.get(&SignalId::from("agent.tool_calls")), CoverageCounts::default());
    }

    #[test]
    fn round_trips_through_json() {
        let mut cov = Coverage::new();
        cov.set(
            SignalId::from("agent.tool_calls"),
            CoverageCounts { measured: 4, derived: 0, lossy: 0, unmetered: 1 },
        );
        let json = serde_json::to_value(&cov).unwrap();
        let back: Coverage = serde_json::from_value(json).unwrap();
        assert_eq!(back, cov);
    }
}
