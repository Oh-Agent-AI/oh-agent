//! §12 Engine API——builder（§12.1）、ingest/finalize/audit（§12.2）、pipeline
//! （§12.3）都在这里。
//!
//! # 与 spec 字面 snippet 的一处偏差（有意的）
//!
//! §12.2 的示意代码把 `config` 放进 `AuditInput`，§12.1 的 builder 又有
//! `.with_config(config)`——两处字面读都成立时会有歧义（引擎级默认配置 vs
//! 每次调用的配置）。这里选后者：`config` 只活在 `AuditInput`（每次
//! `finalize`/`audit` 调用提供），builder 不提供 `.with_config`。理由：
//! §11.3 说"调用方必须将其作为显式 config 输入，并纳入 input fingerprint"
//! ——"调用方"、"输入"都是调用时的语言，不是构建时的；且同一个 Engine
//! （同一组 detector/assigner/vocabulary）在不同调用之间换阈值重跑是完全合
//! 理的场景，不应该逼着调用方重新 build 一个引擎。

use std::collections::{BTreeMap, BTreeSet};

use crate::canonical::{canonical_eq, canonical_string, sha256_hex};
use crate::coverage::Coverage;
use crate::detector::{AuditContext, Detector, RuleOutcome, SignalRequirement};
use crate::diagnostic::{self, Diagnostic};
use crate::error::VitalsError;
use crate::event::CanonicalEvent;
use crate::finding::{compute_fingerprint, Finding};
use crate::id::{EventId, FindingId, TrajectoryId};
use crate::replay::{DetectorVersion, InputFingerprint, NamedRuleOutcome, ReplayFrame, ReplayReport};
use crate::report::AuditReport;
use crate::signal::SignalVocabulary;
use crate::trajectory::{BySourceSession, Trajectory, TrajectoryAssigner};

/// §12.2：批处理便捷入口的载荷。`detectors`/`assigner`/`vocabulary` 属于
/// Engine 的身份（builder 阶段固定），不在这里——见模块顶部的偏差说明。
pub struct AuditInput {
    pub events: Vec<CanonicalEvent>,
    pub coverage: Coverage,
    pub config: serde_json::Value,
}

pub struct VitalsEngineBuilder {
    assigner: Option<Box<dyn TrajectoryAssigner>>,
    detectors: Vec<Box<dyn Detector>>,
    vocabulary: SignalVocabulary,
    engine_version: String,
    schema_version: u16,
}

impl Default for VitalsEngineBuilder {
    fn default() -> Self {
        Self {
            assigner: None,
            detectors: Vec::new(),
            vocabulary: SignalVocabulary::new(),
            engine_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version: 1,
        }
    }
}

impl VitalsEngineBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_assigner(mut self, assigner: impl TrajectoryAssigner + 'static) -> Self {
        self.assigner = Some(Box::new(assigner));
        self
    }

    pub fn with_detector(mut self, detector: impl Detector + 'static) -> Self {
        self.detectors.push(Box::new(detector));
        self
    }

    /// §7.1：登记一个 Domain 信号，声明它对应哪些 `CanonicalEvent.kind`。
    pub fn with_signal(
        mut self,
        signal: crate::signal::SignalId,
        kinds: impl IntoIterator<Item = String>,
    ) -> Result<Self, VitalsError> {
        self.vocabulary.register(signal, kinds)?;
        Ok(self)
    }

    pub fn with_engine_version(mut self, version: impl Into<String>) -> Self {
        self.engine_version = version.into();
        self
    }

    pub fn with_schema_version(mut self, version: u16) -> Self {
        self.schema_version = version;
        self
    }

    /// §9.1：相同 `id` 不允许注册多个 Detector；§7.1：每个 Detector 的
    /// `requirement()` 引用的信号必须已在词表登记，否则 `UnknownSignal`
    /// 硬错误——绝不允许降级为运行期 Unavailable。两条检查都在这里做一次，
    /// 不是每次 `finalize` 都重新算。
    pub fn build(self) -> Result<VitalsEngine, VitalsError> {
        let mut seen_ids = BTreeSet::new();
        for d in &self.detectors {
            if !seen_ids.insert(d.id().to_string()) {
                return Err(VitalsError::DuplicateDetector { detector_id: d.id().to_string() });
            }
        }
        for d in &self.detectors {
            for sig in d.requirement().signals() {
                if !self.vocabulary.contains(sig) {
                    return Err(VitalsError::UnknownSignal {
                        detector_id: d.id().to_string(),
                        signal_id: sig.as_str().to_string(),
                    });
                }
            }
        }
        Ok(VitalsEngine {
            assigner: self.assigner.unwrap_or_else(|| Box::new(BySourceSession)),
            detectors: self.detectors,
            vocabulary: self.vocabulary,
            engine_version: self.engine_version,
            schema_version: self.schema_version,
            buffered_events: Vec::new(),
        })
    }
}

pub struct VitalsEngine {
    assigner: Box<dyn TrajectoryAssigner>,
    detectors: Vec<Box<dyn Detector>>,
    vocabulary: SignalVocabulary,
    engine_version: String,
    schema_version: u16,
    buffered_events: Vec<CanonicalEvent>,
}

impl VitalsEngine {
    pub fn builder() -> VitalsEngineBuilder {
        VitalsEngineBuilder::new()
    }

    /// §4.6 Batch-first, streaming-compatible：逐条校验并缓冲。权威结果只
    /// 在 `finalize` 后产生——`ingest` 本身不排序、不去重、不跑 Detector。
    pub fn ingest(&mut self, event: CanonicalEvent) -> Result<(), VitalsError> {
        event.validate()?;
        if event.schema_version > self.schema_version {
            return Err(VitalsError::UnsupportedSchema { found: event.schema_version, supported: self.schema_version });
        }
        self.buffered_events.push(event);
        Ok(())
    }

    /// 跑完 §12.3 的整条 pipeline，清空缓冲区。
    pub fn finalize(&mut self, coverage: Coverage, config: serde_json::Value) -> Result<AuditReport, VitalsError> {
        let events = std::mem::take(&mut self.buffered_events);
        run_pipeline(
            events,
            &self.detectors,
            self.assigner.as_ref(),
            &self.vocabulary,
            &coverage,
            &config,
            &self.engine_version,
            self.schema_version,
        )
    }

    /// §12.2 的批处理便捷入口：`ingest` 全部事件后立即 `finalize`。
    ///
    /// 失败时不污染引擎已有状态：`ingest` 单独调用时，一次失败只丢那一条
    /// 事件、不影响之前已经成功 ingest 的（这是流式场景要的语义——事件流里
    /// 一条坏事件不该抹掉之前收到的一切）。但 `audit()` 承诺的是"这批要么
    /// 整批生效、要么这次调用像没发生过"——批中间某条校验失败时，前面已经
    /// 悄悄 push 进 `buffered_events` 的那些不能留下：不清理的话，下一次
    /// 调用（不管是另一次 `audit()` 还是独立的 `ingest`/`finalize` 序列）
    /// 会把这批失败请求的残留事件一起带进去，产出一份掺了别的调用的数据的
    /// 报告——`finalize()` 已经在失败前用 `take()` 清空过 buffer，`audit()`
    /// 的失败路径必须有同等的清理，两个失败路径的事务语义不能不一致。回退
    /// 到调用前的 `baseline` 长度而不是清空到 0：如果调用方在这次 `audit()`
    /// 之前已经用 `ingest()` 攒了一些事件（合法的流式用法），这次批失败不
    /// 该连那些也吃掉。
    pub fn audit(&mut self, input: AuditInput) -> Result<AuditReport, VitalsError> {
        let baseline = self.buffered_events.len();
        for event in input.events {
            if let Err(e) = self.ingest(event) {
                self.buffered_events.truncate(baseline);
                return Err(e);
            }
        }
        self.finalize(input.coverage, input.config)
    }
}

/// §7.4.1：这条信号在 `events` 里有几个可消费事件——门控判据，不读
/// `Coverage`。
fn consumable_events(events: &[CanonicalEvent], vocabulary: &SignalVocabulary, signal: &crate::signal::SignalId) -> u64 {
    events.iter().filter(|e| vocabulary.kind_feeds_signal(signal, &e.kind)).count() as u64
}

/// §7.4：`All` 任一无可消费证据则整条 missing；`Any` 全部无可消费证据才
/// missing；requirement 信号列表为空视为满足（"允许执行"）。
fn requirement_missing(
    requirement: &SignalRequirement,
    events: &[CanonicalEvent],
    vocabulary: &SignalVocabulary,
) -> Vec<crate::signal::SignalId> {
    match requirement {
        SignalRequirement::All(sigs) => {
            sigs.iter().filter(|s| consumable_events(events, vocabulary, s) == 0).cloned().collect()
        }
        SignalRequirement::Any(sigs) => {
            if sigs.is_empty() {
                return Vec::new();
            }
            let all_missing = sigs.iter().all(|s| consumable_events(events, vocabulary, s) == 0);
            if all_missing {
                sigs.clone()
            } else {
                Vec::new()
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_pipeline(
    events: Vec<CanonicalEvent>,
    detectors: &[Box<dyn Detector>],
    assigner: &dyn TrajectoryAssigner,
    vocabulary: &SignalVocabulary,
    coverage: &Coverage,
    config: &serde_json::Value,
    engine_version: &str,
    schema_version: u16,
) -> Result<AuditReport, VitalsError> {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();

    // ── ID Deduplication（§6.4）──
    let mut by_id: BTreeMap<String, CanonicalEvent> = BTreeMap::new();
    for event in events {
        let key = event.id.as_str().to_string();
        match by_id.get(&key) {
            None => {
                by_id.insert(key, event);
            }
            Some(existing) => {
                let existing_json = serde_json::to_value(existing).map_err(|e| VitalsError::Serialization { reason: e.to_string() })?;
                let incoming_json = serde_json::to_value(&event).map_err(|e| VitalsError::Serialization { reason: e.to_string() })?;
                if canonical_eq(&existing_json, &incoming_json) {
                    diagnostics.push(Diagnostic {
                        code: diagnostic::DUPLICATE_EVENT_IGNORED.to_string(),
                        message: format!("duplicate event id {key} ignored (identical content)"),
                        event_id: Some(event.id.clone()),
                        trajectory_id: None,
                    });
                } else {
                    return Err(VitalsError::ConflictingDuplicate { event_id: event.id.clone() });
                }
            }
        }
    }

    // ── Deterministic Ordering（§6.3：ordinal ASC → id ASC）──
    let mut unique_events: Vec<CanonicalEvent> = by_id.into_values().collect();
    unique_events.sort_by(|a, b| a.ordinal.cmp(&b.ordinal).then_with(|| a.id.cmp(&b.id)));

    for w in unique_events.windows(2) {
        if w[0].ordinal == w[1].ordinal {
            diagnostics.push(Diagnostic {
                code: diagnostic::DUPLICATE_ORDINAL.to_string(),
                message: format!("ordinal {} shared by {} and {}", w[0].ordinal, w[0].id, w[1].id),
                event_id: Some(w[1].id.clone()),
                trajectory_id: None,
            });
        }
        // 见下方独立循环里对 MISSING_TIMESTAMP / LOSSY_SOURCE 的处理——不在
        // windows(2) 里一起做，是因为它们是逐事件属性，不是相邻对属性，混在
        // 一起会让最后一个事件被漏检。
    }
    for event in &unique_events {
        if event.occurred_at_ms.is_none() {
            diagnostics.push(Diagnostic {
                code: diagnostic::MISSING_TIMESTAMP.to_string(),
                message: format!("event {} has no occurred_at_ms", event.id),
                event_id: Some(event.id.clone()),
                trajectory_id: None,
            });
        }
        if let crate::provenance::Provenance::Lossy { .. } = &event.provenance {
            diagnostics.push(Diagnostic {
                code: diagnostic::LOSSY_SOURCE.to_string(),
                message: format!("event {} has lossy provenance", event.id),
                event_id: Some(event.id.clone()),
                trajectory_id: None,
            });
        }
    }

    let event_ordinal: BTreeMap<String, u64> =
        unique_events.iter().map(|e| (e.id.as_str().to_string(), e.ordinal)).collect();

    // ── Trajectory Assignment + Close（§8.2/§8.3；§8.4：v0.5 一个 Event 只
    //    属于一条 Trajectory）──
    let mut trajectories: BTreeMap<TrajectoryId, Trajectory> = BTreeMap::new();
    let mut event_trajectory: BTreeMap<String, TrajectoryId> = BTreeMap::new();
    let mut last_seen_ms: BTreeMap<TrajectoryId, i64> = BTreeMap::new();
    for event in &unique_events {
        let traj_id = assigner.assign(event)?;
        trajectories
            .entry(traj_id.clone())
            .or_insert_with(|| Trajectory::open(traj_id.clone(), event.actor_id.clone(), event.goal_id.clone(), schema_version));
        let traj = trajectories.get_mut(&traj_id).expect("just inserted or already present");
        // §8.1：一条 Trajectory 有且只有一个 `actor_id`——它是"这是谁的连续
        // 行为"这件事的定义，不是展示字段。内置的 `BySourceSession` 只按
        // `source.source_id` 分组，不看 `actor_id`；两个不同 Actor 的事件如
        // 果恰好落到同一个 source_id（跨来源合并审计时完全可能），第一条事
        // 件的 actor 会被当成整条 Trajectory 的身份，其余 actor 的事件却被
        // 悄悄并进来——报告会声称"这是 Actor A 的行为"，内容却混了 Actor B
        // 的证据。宁可在这里硬拒绝，也不让这种静默合并流进 Finding。
        if traj.actor_id != event.actor_id {
            return Err(VitalsError::InvalidTrajectory {
                trajectory_id: traj_id,
                reason: format!(
                    "event {} has actor_id `{}` but this trajectory belongs to actor_id `{}` — the TrajectoryAssigner grouped events from two different actors into one trajectory",
                    event.id, event.actor_id, traj.actor_id
                ),
            });
        }
        traj.append(event.id.clone(), event.occurred_at_ms)?;
        if let Some(ms) = event.occurred_at_ms {
            last_seen_ms.insert(traj_id.clone(), ms);
        }
        event_trajectory.insert(event.id.as_str().to_string(), traj_id);
    }
    // §4.6 Batch-first：finalize 是权威结果的产生点，所有 trajectory 在这里
    // 统一 close（v0.5 不支持跨 finalize 调用保持 open，§3.2 明确排除
    // trajectory reopen）。
    for traj in trajectories.values_mut() {
        let ended_at_ms = last_seen_ms.get(&traj.id).copied();
        traj.close(ended_at_ms)?;
    }

    let mut events_by_trajectory: BTreeMap<TrajectoryId, Vec<CanonicalEvent>> = BTreeMap::new();
    for event in &unique_events {
        let traj_id = event_trajectory.get(event.id.as_str()).cloned().expect("assigned above");
        events_by_trajectory.entry(traj_id).or_default().push(event.clone());
    }

    // ── Signal Requirement Gate + Detector Evaluation（§7.4/§9）──
    let mut all_outcomes: Vec<NamedRuleOutcome> = Vec::new();
    let mut all_findings: Vec<Finding> = Vec::new();
    let mut seen_fingerprints: BTreeSet<String> = BTreeSet::new();
    let mut next_finding_seq: u64 = 0;

    for (traj_id, traj_events) in &events_by_trajectory {
        let trajectory = trajectories.get(traj_id).expect("trajectory created during assignment");
        // §17 性能基线曾经卡在这里：Finding Validation 对每条 evidence
        // event_id 都做过 `trajectory.event_ids.contains(eid)`——`Vec::contains`
        // 是 O(trajectory 大小) 线性扫描，乘上"findings 数 × 每条 evidence 的
        // event_id 数"，在大会话上退化成事实上的 O(n²)（100k 输入实测 6.3s，
        // 远超 §17 目标的 1s）。这个集合只依赖 trajectory，跟哪个 detector
        // 跑无关，提到 detector 循环外面按 trajectory 建一次，查询降到
        // O(log n)。
        let trajectory_event_ids: BTreeSet<&EventId> = trajectory.event_ids.iter().collect();
        for detector in detectors {
            let missing = requirement_missing(&detector.requirement(), traj_events, vocabulary);
            let outcome = if !missing.is_empty() {
                RuleOutcome::Unavailable {
                    missing,
                    reason: "no consumable evidence for required signal(s) in this trajectory".to_string(),
                }
            } else {
                let ctx = AuditContext { trajectory, events: traj_events, coverage, config };
                let drafts = detector
                    .detect(&ctx)
                    .map_err(|e| VitalsError::DetectorFailed { detector_id: detector.id().to_string(), reason: e.to_string() })?;
                if drafts.is_empty() {
                    RuleOutcome::MeasuredZero
                } else {
                    let mut findings = Vec::with_capacity(drafts.len());
                    for draft in drafts {
                        // ── Finding Validation（§10.1）──
                        if draft.evidence.is_empty() || draft.evidence.iter().any(|e| !e.is_well_formed()) {
                            return Err(VitalsError::InvalidFinding {
                                detector_id: detector.id().to_string(),
                                reason: "finding has no evidence".to_string(),
                            });
                        }
                        for ev in &draft.evidence {
                            for eid in &ev.event_ids {
                                if !trajectory_event_ids.contains(eid) {
                                    return Err(VitalsError::InvalidFinding {
                                        detector_id: detector.id().to_string(),
                                        reason: format!("evidence references event {eid} outside its own trajectory"),
                                    });
                                }
                            }
                        }

                        // evidence event_ids 按 (ordinal, id) 规范化（§12.4：
                        // "evidence event IDs：ordinal、event ID"）。
                        let mut evidence = draft.evidence;
                        for ev in &mut evidence {
                            ev.event_ids.sort_by(|a, b| {
                                let oa = event_ordinal.get(a.as_str()).copied().unwrap_or(u64::MAX);
                                let ob = event_ordinal.get(b.as_str()).copied().unwrap_or(u64::MAX);
                                oa.cmp(&ob).then_with(|| a.cmp(b))
                            });
                        }

                        // ── Fingerprint / Dedup（§10.3）──
                        let fingerprint =
                            compute_fingerprint(detector.id(), detector.version(), &draft.kind, traj_id, &evidence, config);
                        if !seen_fingerprints.insert(fingerprint.clone()) {
                            diagnostics.push(Diagnostic {
                                code: diagnostic::FINDING_DEDUPLICATED.to_string(),
                                message: format!("fingerprint {fingerprint} already reported in this report"),
                                event_id: None,
                                trajectory_id: Some(traj_id.clone()),
                            });
                            continue;
                        }

                        next_finding_seq += 1;
                        findings.push(Finding {
                            schema_version,
                            id: FindingId::from(format!("finding-{next_finding_seq}")),
                            detector_id: detector.id().to_string(),
                            detector_version: detector.version().to_string(),
                            kind: draft.kind,
                            severity: draft.severity,
                            confidence: draft.confidence,
                            trajectory_id: traj_id.clone(),
                            evidence,
                            summary: draft.summary,
                            attributes: draft.attributes,
                            fingerprint,
                        });
                    }
                    RuleOutcome::Findings(findings)
                }
            };
            if let RuleOutcome::Findings(fs) = &outcome {
                all_findings.extend(fs.clone());
            }
            all_outcomes.push(NamedRuleOutcome { detector_id: detector.id().to_string(), trajectory_id: traj_id.clone(), outcome });
        }
    }

    // ── 输出排序（§12.4）──
    all_outcomes.sort_by(|a, b| a.detector_id.cmp(&b.detector_id).then_with(|| a.trajectory_id.cmp(&b.trajectory_id)));
    all_findings.sort_by(|a, b| {
        a.severity.cmp(&b.severity).then_with(|| a.trajectory_id.cmp(&b.trajectory_id)).then_with(|| a.fingerprint.cmp(&b.fingerprint))
    });

    let ordinal_of = |eid: &EventId| event_ordinal.get(eid.as_str()).copied().unwrap_or(u64::MAX);
    diagnostics.sort_by(|a, b| {
        let oa = a.event_id.as_ref().map(ordinal_of).unwrap_or(u64::MAX);
        let ob = b.event_id.as_ref().map(ordinal_of).unwrap_or(u64::MAX);
        oa.cmp(&ob).then_with(|| a.code.cmp(&b.code))
    });

    // ── Replay Assembly（§11）──
    // §11.4：无锚点的 Finding 只出现在顶层——v0.5 的 Evidence-first 纪律
    // （evidence 非空已由 Finding Validation 保证）意味着这里永远能算出锚
    // 点，所以每条 Finding 都会被分到某一帧；这不是巧合，是 §4.2 的直接推论。
    let mut findings_by_anchor: BTreeMap<String, Vec<FindingId>> = BTreeMap::new();
    for finding in &all_findings {
        let anchor = finding
            .evidence
            .iter()
            .flat_map(|e| e.event_ids.iter())
            .max_by(|a, b| ordinal_of(a).cmp(&ordinal_of(b)).then_with(|| a.cmp(b)))
            .cloned();
        if let Some(anchor) = anchor {
            findings_by_anchor.entry(anchor.as_str().to_string()).or_default().push(finding.id.clone());
        }
    }
    let mut diagnostics_by_event: BTreeMap<String, Vec<Diagnostic>> = BTreeMap::new();
    for d in &diagnostics {
        if let Some(eid) = &d.event_id {
            diagnostics_by_event.entry(eid.as_str().to_string()).or_default().push(d.clone());
        }
    }

    let frames: Vec<ReplayFrame> = unique_events
        .iter()
        .enumerate()
        .map(|(index, event)| {
            let key = event.id.as_str().to_string();
            ReplayFrame {
                index: index as u64,
                event_id: event.id.clone(),
                trajectory_id: event_trajectory.get(&key).cloned().expect("assigned above"),
                findings_opened: findings_by_anchor.get(&key).cloned().unwrap_or_default(),
                diagnostics: diagnostics_by_event.get(&key).cloned().unwrap_or_default(),
            }
        })
        .collect();

    // ── Input Fingerprint（§11.2 patch：拆段；§62 补丁：assigner/vocabulary
    //    也算进去，见 InputFingerprint 文档）──
    let events_json: Vec<serde_json::Value> =
        unique_events.iter().map(|e| serde_json::to_value(e).expect("CanonicalEvent always serializes")).collect();
    let events_hash = sha256_hex(&canonical_string(&serde_json::Value::Array(events_json)));
    let config_hash = sha256_hex(&canonical_string(config));
    // 指纹哈希用**注册顺序**（detectors 切片本来的顺序），不是排序后的顺
    // 序——注册顺序决定 FindingId 怎么分配（下面的 `next_finding_seq`），
    // 换个顺序报告内容会变，指纹必须能感知到。展示用的
    // `ReplayReport.detector_versions` 单独按 detector_id 排序，互不影响。
    let registration_order_json: Vec<serde_json::Value> = detectors
        .iter()
        .map(|d| serde_json::json!({"detector_id": d.id(), "detector_version": d.version()}))
        .collect();
    let detector_versions_hash = sha256_hex(&canonical_string(&serde_json::Value::Array(registration_order_json)));
    let mut detector_versions: Vec<DetectorVersion> = detectors
        .iter()
        .map(|d| DetectorVersion { detector_id: d.id().to_string(), detector_version: d.version().to_string() })
        .collect();
    detector_versions.sort_by(|a, b| a.detector_id.cmp(&b.detector_id));
    let signal_vocabulary_hash = sha256_hex(&canonical_string(
        &serde_json::to_value(vocabulary).expect("SignalVocabulary always serializes"),
    ));
    let input_fingerprint = InputFingerprint {
        events_hash,
        config_hash,
        detector_versions_hash,
        assigner_id: assigner.id().to_string(),
        signal_vocabulary_hash,
        engine_version: engine_version.to_string(),
    };

    let sorted_trajectories: Vec<Trajectory> = trajectories.into_values().collect();

    let replay = ReplayReport {
        schema_version,
        engine_version: engine_version.to_string(),
        detector_versions,
        input_fingerprint: input_fingerprint.clone(),
        frames,
        outcomes: all_outcomes.clone(),
        findings: all_findings.clone(),
        diagnostics: diagnostics.clone(),
    };

    Ok(AuditReport {
        schema_version,
        engine_version: engine_version.to_string(),
        input_fingerprint,
        trajectories: sorted_trajectories,
        outcomes: all_outcomes,
        findings: all_findings,
        replay,
        diagnostics,
    })
}
