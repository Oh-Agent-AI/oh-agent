//! §14 Agent Vitals 兼容桥（docs/VITALS_CORE_V0_5_IMPLEMENTATION_SPEC.md）。
//!
//! 两条纯函数——不重新读原始日志（§21 止损线第 5 条）：
//! - `canonical_session::canonical_session_to_vitals`：现有 `CanonicalSession`
//!   的五条 timeline → `vitals_core::event::CanonicalEvent`（§14.2）；
//! - `findings::vitals_report_to_legacy_findings`：`vitals_core::report::
//!   AuditReport` → 现有 12 键 legacy finding JSON（§14.3）。
//!
//! 加两条：§14.4 生产切换（第 7 步"旧入口改为兼容 shim"）的落点。
//! `behavior.rs`/`trajectory.rs` 里 `detect_svNNN` 的新实现全部调用其中一
//! 个；原判定逻辑没有删，改名 `detect_svNNN_legacy` 留作回退（见各自模块的
//! 调用点注释）。

pub mod canonical_session;
pub mod findings;

pub use canonical_session::CompatibilityError;

use vitals_core::coverage::Coverage;
use vitals_core::detector::Detector;
use vitals_core::engine::{AuditInput, VitalsEngine};
use vitals_core::signal::SignalId;

use crate::evidence::CanonicalSession;

/// 投影 → 建 Engine（单 detector + 它需要的信号）→ audit → 投影回 legacy
/// JSON 的通用链路，两条 family 共用。`config` 是 §11.3 说的"调用方必须显
/// 式提供、纳入 input fingerprint 的东西"——SV605 需要工作区根就是走这个
/// 口子（`{"workspace_root": ...}`），不是往 `AuditContext` 加专用字段（那
/// 会是 §4.1 Domain-free 边界上的一个洞：`workspace_root` 对"某条规则要用
/// cwd 判断路径"这件事是通用的，不是 Agent 专属概念，但也没必要为一条规则
/// 单独扩展 Core 的 context 形状）。返回 `None` 意味着链路上某一步失败（见
/// `run_single_rule` 文档）——调用方一律退到对应的 `detect_svNNN_legacy`。
fn run_pipeline<D: Detector + 'static>(
    session: &CanonicalSession,
    detector: D,
    signal_kinds: &[(&'static str, &'static str)],
    config: serde_json::Value,
) -> Option<(vitals_core::report::AuditReport, Vec<serde_json::Value>, std::collections::BTreeMap<String, u64>)> {
    let events = canonical_session::canonical_session_to_vitals(session).ok()?;
    // 后面 `events` 被 `audit()` 消费掉之前，先存一份 event_id → ordinal 映
    // 射——这是每个 `CanonicalEvent` 在 `canonical_session_to_vitals` 里被赋
    // 的、与旧 `entry.ordinal` 同一数值空间的下标。family①（SV601–610）用
    // 它重建 `__ord`；family④ 不需要，见 `run_single_rule` 文档。
    let ordinal_by_event: std::collections::BTreeMap<String, u64> =
        events.iter().map(|e| (e.id.as_str().to_string(), e.ordinal)).collect();

    let mut builder = VitalsEngine::builder().with_detector(detector);
    for (signal, kind) in signal_kinds {
        builder = builder.with_signal(SignalId::from(*signal), vec![(*kind).to_string()]).ok()?;
    }
    let mut engine = builder.build().ok()?;

    let report = engine.audit(AuditInput { events, coverage: Coverage::new(), config }).ok()?;
    let out = findings::vitals_report_to_legacy_findings(&report).ok()?;
    Some((report, out, ordinal_by_event))
}

/// family④（SV611–614，`trajectory.rs`）专用入口。`flatten_trajectory` 按
/// 规则码顺序**逐条 concat**，不读任何私有排序键——不需要、也不该往输出里
/// 塞任何 `vitals_report_to_legacy_findings` 之外的东西，塞了就是一个会直
/// 接泄漏进最终 CLI JSON 的额外键（§4.7 "现有 JSON key 不删除、不改义"，
/// 这条反过来也不允许平白多一个）。
///
/// # 为什么会返回 `None`（理论上不可达，但调用方必须当作外部输入处理）
///
/// `canonical_session_to_vitals` 的 `CanonicalEvent::validate()`、
/// `SignalVocabulary::register`、`VitalsEngine::build()`、`engine.audit()`
/// 任一环节失败。按当前实现，这些环节全部只处理桥接层自己构造出的、已知
/// 良构的数据（词表用字面量注册，事件 id/actor/kind/attributes 全部由
/// `base_event` 保证合法）——但调用方（真实会话日志）终究是外部输入，
/// `unwrap` 在这里等于拿一条规则的失败去打断整条 `agent-vitals behavior`
/// 命令，比"退回旧实现算一次"贵得多。`None` 时调用方一律退到
/// `detect_svNNN_legacy`，不吞错、不裸猜——旧实现本来就一直在维护，退回去
/// 不是降级成"没做完的路"，是退到另一条同样正确、只是更慢暴露不出这次抽象
/// 红利的路。
pub fn run_single_rule<D: Detector + 'static>(
    session: &CanonicalSession,
    detector: D,
    signal_kinds: &[(&'static str, &'static str)],
) -> Option<Vec<serde_json::Value>> {
    run_single_rule_with_config(session, detector, signal_kinds, serde_json::json!({}))
}

/// 同 `run_single_rule`，显式传 `config`（见 `run_pipeline` 文档）。
pub fn run_single_rule_with_config<D: Detector + 'static>(
    session: &CanonicalSession,
    detector: D,
    signal_kinds: &[(&'static str, &'static str)],
    config: serde_json::Value,
) -> Option<Vec<serde_json::Value>> {
    run_pipeline(session, detector, signal_kinds, config).map(|(_, out, _)| out)
}

/// family①（SV601–610，`behavior.rs`）专用入口——同 `run_single_rule`，多一
/// 步：把私有排序键 `__ord` 补回每条 finding。
///
/// # 为什么 family① 需要它、family④ 不需要
///
/// `flatten()`（`behavior.rs`）把**同一个事件流里所有规则**的 finding 合并
/// 排序时，读的是每条 finding JSON 上的 `__ord`（旧 `make_finding` 塞的、
/// "这条 finding 锚定的事件在 post_fork 执行流里的下标"）。切换期间不是所
/// 有规则都走新路径——SV602–610 仍然是 `make_finding` 产出、带着真实
/// `__ord`；新路径的 `vitals_report_to_legacy_findings` 不产这个键（它是通
/// 用输出桥，`__ord` 是"切换期间部分规则还没切"这个阶段性状态的兼容负债，
/// 不该混进一份到处复用的纯函数里），如果不补，`f.get(ORD_KEY).unwrap_or(
/// u64::MAX)` 会把它排到**最后**，不管实际发生在事件流哪个位置——这正是
/// 切完 SV601 后 `python_rust_byte_for_byte_parity`/
/// `flatten_preserves_event_then_rule_order_without_leaking_ord_key` 两个既
/// 有回归测试变红的原因：那两个是**多规则混排**夹具，单规则的
/// `sv601_parity.rs` 测的是 `vitals_report_to_legacy_findings` 本身，从没
/// 经过 `flatten()`，没抓到。
///
/// 等 SV602–610 全部切完（`make_finding`/`__ord` 整体退役），这个函数和
/// `run_single_rule` 合并回一个。
pub fn run_single_family1_rule<D: Detector + 'static>(
    session: &CanonicalSession,
    detector: D,
    signal_kinds: &[(&'static str, &'static str)],
) -> Option<Vec<serde_json::Value>> {
    run_single_family1_rule_with_config(session, detector, signal_kinds, serde_json::json!({}))
}

/// 同 `run_single_family1_rule`，显式传 `config`（见 `run_pipeline` 文档；
/// SV605 用它传工作区根）。
pub fn run_single_family1_rule_with_config<D: Detector + 'static>(
    session: &CanonicalSession,
    detector: D,
    signal_kinds: &[(&'static str, &'static str)],
    config: serde_json::Value,
) -> Option<Vec<serde_json::Value>> {
    let (report, mut out, ordinal_by_event) = run_pipeline(session, detector, signal_kinds, config)?;

    // `vitals_report_to_legacy_findings` 现在按 `report.outcomes` 里
    // `Findings(Vec<Finding>)` 自身的 push 顺序产出结果（§14.3 顶部文档的
    // 那次修正——之前这里跟 frame 顺序绑得太紧，SV613 的组合命中场景下两者
    // 会不一致）。这里必须重走**同一条**遍历（outcomes → Findings，同样的
    // 顺序），逐条算出每个 Finding 自己的锚点 ordinal——不能再假设它等于
    // frame 顺序，两者已经是两件独立的事：frame 顺序是"这份 Replay 里事件
    // 发生的顺序"，这里的顺序是"detect() 把 finding push 进 Vec 的顺序"，
    // `__ord` 只服务于后者（`flatten()` 会再按 `__ord` 把它排回时间序，
    // family① 本来就要这个效果）。锚点算法与 Engine 内部一致：一条
    // Finding 的锚点 = 它 evidence 里 ordinal 最大的那个事件（§11.4）。
    let anchor_ordinals: Vec<u64> = report
        .outcomes
        .iter()
        .filter_map(|named_outcome| match &named_outcome.outcome {
            vitals_core::detector::RuleOutcome::Findings(findings) => Some(findings),
            _ => None,
        })
        .flatten()
        .map(|finding| {
            finding
                .evidence
                .iter()
                .flat_map(|ev| ev.event_ids.iter())
                .filter_map(|id| ordinal_by_event.get(id.as_str()).copied())
                .max()
                .unwrap_or(u64::MAX)
        })
        .collect();

    if out.len() != anchor_ordinals.len() {
        // 形状对不上是本函数自己的 bug，不能硬凑一份可能排错序的结果。
        return None;
    }
    for (value, ordinal) in out.iter_mut().zip(anchor_ordinals) {
        let obj = value.as_object_mut()?;
        obj.insert("__ord".to_string(), serde_json::json!(ordinal));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::{Coverage as EvidenceCoverage, Provenance, SessionMeta, SignalSet, Timeline, TimelineEntry, ToolCallObservation};
    use vitals_core::detector::{AuditContext, SignalRequirement};
    use vitals_core::error::VitalsError;
    use vitals_core::finding::{FindingDraft, Severity};

    fn empty_session() -> CanonicalSession {
        CanonicalSession {
            meta: SessionMeta { session_id: "s1".to_string(), harness_id: "dsh", workspace_roots: vec![], model: None, span: None },
            signals: SignalSet::EMPTY,
            coverage: EvidenceCoverage::new(),
            attempts: vec![],
            notes: vec![],
            tool_calls: Timeline::new(),
            tool_results: Timeline::new(),
            approvals: Timeline::new(),
            sandbox_modes: Timeline::new(),
            turns: Timeline::new(),
        }
    }

    struct NoopDetector;
    impl Detector for NoopDetector {
        fn id(&self) -> &str {
            "noop"
        }
        fn version(&self) -> &str {
            "1"
        }
        fn requirement(&self) -> SignalRequirement {
            SignalRequirement::All(vec![])
        }
        fn detect(&self, _ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
            Ok(Vec::new())
        }
    }

    fn tool_call_entry(name: &str, args: &str, seq: i64, ordinal: usize) -> TimelineEntry<ToolCallObservation> {
        TimelineEntry {
            observation: ToolCallObservation { name: name.to_string(), args_text: args.to_string() },
            provenance: Provenance::Measured,
            seq: Some(seq),
            time: Some(1000 + seq),
            turn: None,
            step: None,
            call_id: None,
            ordinal,
        }
    }

    /// 每次调用都命中一次，用来喂进 `Sv601Detector` 之外的通用测试。
    struct AlwaysFiresDetector;
    impl Detector for AlwaysFiresDetector {
        fn id(&self) -> &str {
            "always_fires"
        }
        fn version(&self) -> &str {
            "1"
        }
        fn requirement(&self) -> SignalRequirement {
            SignalRequirement::All(vec![])
        }
        fn detect(&self, ctx: &AuditContext) -> Result<Vec<FindingDraft>, VitalsError> {
            Ok(ctx
                .events
                .iter()
                .map(|e| FindingDraft {
                    kind: "probe".to_string(),
                    severity: Severity::Info,
                    confidence: None,
                    evidence: vec![vitals_core::evidence::Evidence {
                        event_ids: vec![e.id.clone()],
                        description: String::new(),
                        source_refs: vec![],
                        attributes: serde_json::json!({}),
                    }],
                    summary: String::new(),
                    attributes: serde_json::json!({"rule": "PROBE"}),
                })
                .collect())
        }
    }

    #[test]
    fn run_single_rule_returns_none_when_a_signal_kind_pair_is_malformed() {
        // 证明 `detect_svNNN` 的 `.unwrap_or_else(|| detect_svNNN_legacy(s))`
        // 回退真的会被触发——不是死代码。格式非法的 signal id 逼 `with_signal`
        // 失败，这是唯一能从外部低成本制造 `None` 的路径。
        let session = empty_session();
        assert_eq!(run_single_rule(&session, NoopDetector, &[("not-dotted", "some.kind")]), None);
        assert_eq!(run_single_family1_rule(&session, NoopDetector, &[("not-dotted", "some.kind")]), None);
    }

    #[test]
    fn run_single_rule_returns_some_empty_vec_on_a_well_formed_empty_session() {
        let mut session = empty_session();
        session.tool_calls.entries.push(tool_call_entry("bash", "ls", 1, 0));
        assert_eq!(run_single_rule(&session, NoopDetector, &[("agent.tool_calls", "agent.tool_call")]), Some(Vec::new()));
    }

    #[test]
    fn run_single_rule_never_adds_the_ord_key() {
        // family④ 的回归护栏：`flatten_trajectory` 不读、不该有这个键。
        let mut session = empty_session();
        session.tool_calls.entries.push(tool_call_entry("bash", "ls", 1, 3));
        let out = run_single_rule(&session, AlwaysFiresDetector, &[("agent.tool_calls", "agent.tool_call")]).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].get("__ord").is_none(), "family④ 输出不该带 __ord: {:?}", out[0]);
    }

    #[test]
    fn run_single_family1_rule_adds_ord_matching_the_anchor_events_ordinal() {
        let mut session = empty_session();
        session.tool_calls.entries.push(tool_call_entry("bash", "ls", 7, 42));
        let out = run_single_family1_rule(&session, AlwaysFiresDetector, &[("agent.tool_calls", "agent.tool_call")]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["__ord"], serde_json::json!(42), "__ord 必须等于锚点事件的 ordinal（42），不是别的数");
    }

    #[test]
    fn run_single_family1_rule_ord_values_sort_findings_into_true_chronological_order() {
        // 这正是 `flatten()` 依赖的性质：即便 Detector 按别的顺序把 finding
        // 放进 Vec，`__ord` 也必须能把它们排回真实发生顺序。
        let mut session = empty_session();
        session.tool_calls.entries.push(tool_call_entry("bash", "a", 1, 10));
        session.tool_calls.entries.push(tool_call_entry("bash", "b", 2, 20));
        let out = run_single_family1_rule(&session, AlwaysFiresDetector, &[("agent.tool_calls", "agent.tool_call")]).unwrap();
        let ords: Vec<u64> = out.iter().map(|v| v["__ord"].as_u64().unwrap()).collect();
        assert_eq!(ords, vec![10, 20]);
    }
}
