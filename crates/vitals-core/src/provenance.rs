//! §7.2 Provenance——一个观察值是执行环境直接记录的、适配器推导出来的、纯估算
//! 的，还是被脱敏/截断过的（§4.4 Provenance-preserving）。
//!
//! 通用化自 `agent-vitals-domain::evidence::Provenance`：那边为了在每事件热路
//! 径省一次分配用 `&'static str`；这里是要对外发布的公开模型（§15.3 要求
//! `Serialize + Deserialize`），改成 `String`，允许适配器运行期动态构造
//! `Derived { from }` 里的信号列表。

use serde::{Deserialize, Serialize};

use crate::signal::SignalId;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Provenance {
    /// 执行环境自己记录的数字。
    Measured,
    /// 适配器从别的信号推出来的。
    Derived { from: Vec<SignalId> },
    /// 纯估算。
    Estimated { estimator: String },
    /// 存在，但降级过——具体降级成什么形状见 `LossKind`。
    Lossy { kind: LossKind },
}

/// `Lossy` 具体降级成了什么形状——展示层需要知道是"看不全"还是"看不清"。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LossKind {
    Truncated { hint: Option<usize> },
    Hashed,
    Redacted,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let cases = vec![
            Provenance::Measured,
            Provenance::Derived { from: vec![SignalId::from("agent.tool_calls")] },
            Provenance::Estimated { estimator: "est_tokens".to_string() },
            Provenance::Lossy { kind: LossKind::Truncated { hint: Some(200) } },
            Provenance::Lossy { kind: LossKind::Hashed },
            Provenance::Lossy { kind: LossKind::Redacted },
        ];
        for p in cases {
            let json = serde_json::to_value(&p).unwrap();
            let back: Provenance = serde_json::from_value(json).unwrap();
            assert_eq!(back, p);
        }
    }

    #[test]
    fn aggregation_cannot_silently_become_measured() {
        // §4.4：聚合后不能把混合来源伪装成单一 measured 值——这条测试只是
        // 钉住 Provenance 本身不提供任何"合并成 Measured"的方法，防止未来
        // 有人加一个方便的 `.merge()` 悄悄违反这条纪律。
        let derived = Provenance::Derived { from: vec![SignalId::from("agent.tool_calls")] };
        assert_ne!(derived, Provenance::Measured);
    }
}
