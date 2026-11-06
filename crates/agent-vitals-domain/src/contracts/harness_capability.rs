//! harness-capability degradation 表的单一事实来源。
//!
//! 两条执行环境路径（Claude Code 的 SV607/608、WorkBuddy 的 SV604/605）把
//! MeasuredZero 覆盖成 Unavailable 的理由与规则集合，原本埋在各自的 dispatcher
//! 层（`src/agent/claude_session.rs` / `src/agent/workbuddy_session.rs`），core 的
//! `match_behavior_canonical` 无守卫——未来任何直接消费 canonical 的 surface
//! （Tauri 菜单栏 / workbench 接线）都会拿到「结构上读不到维度却报零命中」的
//! 假测量。表在这里下沉：CLI 两个 dispatcher 与未来消费者共用同一个
//! `harness_id → (规则集, 缺失信号, reason)` 映射，漏一条执行环境 = 漏一处 degrade。
//! 共享求值器 `behavior.rs` 不碰这张表——它执行环境无关，特例进共享代码就再难
//! 摘出来（`canonical_audit.py` 的模块文档钉了同一条纪律）。
//!
//! **只覆盖 MeasuredZero**：门控已因 timeline 空给 Unavailable（缺失信号、无需
//! override）或给了 Findings（真命中）时保持原样——override 永不吞真命中。
//!
//! 与 Python `scripts/agent_vitals/agent/harness_capability.py` 逐字节对齐（reason
//! 文案、规则集合、missing 信号），差分测试靠它。

use crate::evidence::{RuleOutcome, Signal};

/// 一个执行环境在 session 分析 runtime 形态（REC §13 四执行环境）下的完整人格声明。
/// 只回答「结构上读不到什么、哪些规则语义不可判、有什么数据层能力」；不回答
/// 「derive 出什么、fidelity 多高」（那是每会话事实，见 v0.6 spec §5.2）。
///
/// 与 Python `scripts/agent_vitals/agent/harness_capability.py` 的 `HARNESSES` 是**双
/// 实现契约**——每种语言内部唯一声明源，跨语言由 `harnesses --json` 的 G1 byte-parity
/// 保持一致（v0.6 spec §5.1bis），不是共享数据文件（typed rule，JSON 化会丢类型，
/// 且 Python ClawHub 分发拿不到 core crate 文件）。
#[derive(Clone, Copy, Debug)]
pub struct HarnessProfile {
    pub id: &'static str,
    /// 菜单/报告短名（`harness_display_name` 的真相源）。
    pub display: &'static str,
    /// 结构性缺席信号（**执行环境级**，全 shape 交集）。排序约定：按 `Signal` 枚举序。
    /// shape/会话级缺席不在此列——那是该 shape 解析器的产出（双层缺席规则，
    /// v0.6 spec §5.2）。
    pub unmeasured_signals: &'static [Signal],
    /// 语义降级（逐条声明）。信号**有**形态、规则能跑出零命中，但零命中不可信。
    pub degraded_rules: &'static [DegradedRule],
    /// 能力**声明**（只声明不证明；实现存在性由消费方二进制的
    /// `HarnessRuntimeRegistration` + 守卫保证——core 不依赖任何文件系统实现）。
    pub session_store: bool,
    /// 日/月折叠的**产出能力**；`None` = 声明缺席（合法状态，不是遗漏）。
    pub fold: Option<FoldOutput>,
    /// 归因面人格（自动归因 §10.6）：判定器读声明，不比执行环境名字。
    pub attribution: AttributionProfile,
}

/// 归因面的执行环境人格（自动归因规格 §10.6）。
///
/// **执行环境强相关的判定事实住在这里，不住在 runtime**：`billing_preview::auto_verdict`
/// 原来写 `harness == "codex"` / `harness != "workbuddy"`——runtime 里出现执行环境名字，就是
/// 把适配器知识漏进了机器层（用户 2026-09-16 指出）。声明搬到 `HarnessProfile` 后，
/// 判定器只做合成，新执行环境接入 = 填一行声明，不改判定器。
///
/// 与其余 `HarnessProfile` 字段同纪律：**只声明不证明**——声明说"该执行环境具备某性质"，
/// 由执行环境适配器的事实产出兑现（`tests/` 与 golden 钉住）。
#[derive(Clone, Copy, Debug)]
pub struct AttributionProfile {
    /// 执行环境在事实里**自报** provider（codex 的 `model_provider`）时，配合账户订阅证据
    /// 即可判「官方订阅」——请求确实打在该厂商后端。claude-code 为 `false`：它没有
    /// 自报 provider，`provider_id` 是从请求 ID 形状推断出来的（§2 L1），不能与
    /// 账户证据合成"订阅覆盖"。
    pub provider_reported_implies_official: bool,
    /// 金额面恒为执行环境自报的积分 / 账单（workbuddy）：既不进按量估算，也不参与订阅
    /// 覆盖判定，更不冒充逐模型 token 重计价（§0 表 E）。
    pub credits_only: bool,
}

impl AttributionProfile {
    /// 最保守的一份：不做任何特殊处理。未知执行环境 fail-closed 到它。
    pub const NEUTRAL: AttributionProfile = AttributionProfile {
        provider_reported_implies_official: false,
        credits_only: false,
    };
}

/// 降级逐条声明——reason 挂在规则上而非执行环境上（一条 reason 盖全部规则撑不过
/// 第二家降级执行环境）。
#[derive(Clone, Copy, Debug)]
pub struct DegradedRule {
    pub code: &'static str,
    /// 该码语义不可判所缺的信号（支持多个）。
    pub missing: &'static [Signal],
    pub reason: &'static str,
}

/// 日/月折叠的产出能力。DshState/EventsScan/Ledger 是应用层实现策略，core 行
/// 不声明；策略与函数入口住在消费方二进制的 `HarnessRuntimeRegistration`。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FoldOutput {
    /// dsh/codex/claude-code：各自价目自算，产出逐模型 token 桶。
    TokenBuckets,
    /// workbuddy 未来：累计执行环境积分账单，绝不冒充逐模型 token 重计价。
    HarnessBillTotals,
}

impl FoldOutput {
    /// `harnesses --json` 与 Python 镜像的序列化词汇——snake_case，与仓库其余
    /// JSON 字段（`billing_source`/`pricing_basis`）同一种命名习惯。
    pub fn as_str(self) -> &'static str {
        match self {
            FoldOutput::TokenBuckets => "token_buckets",
            FoldOutput::HarnessBillTotals => "harness_bill_totals",
        }
    }
}

/// 四个 runtime 执行环境的完整人格声明，顺序即展示顺序（dsh→codex→claude-code→
/// workbuddy，与菜单栏固定三行 + workbuddy 未来第四行一致；数组顺序不是 UI
/// 契约，UI 可自行重排——见 v0.6 spec §6 R1 裁决）。
///
/// `unmeasured_signals` 取自各证据适配器现有的 `is_unavailable`/内联缺席声明
/// （dsh 在 `dsh_evidence.rs` 内联 ~483、codex/claude-code/workbuddy 各自的
/// `is_unavailable` 函数）——M0 是**声明**收拢，行为零变化；M2 才让适配器改
/// 从这里 derive。
pub static HARNESSES: &[HarnessProfile] = &[
    HarnessProfile {
        id: "dsh",
        display: "DeepSeek Harness",
        unmeasured_signals: &[
            Signal::QuotaConsumption,
            Signal::SandboxPolicy,
            Signal::NetworkAccess,
            Signal::UserPrompts,
            Signal::UserCorrections,
        ],
        degraded_rules: &[],
        session_store: true,
        fold: Some(FoldOutput::TokenBuckets),
        attribution: AttributionProfile::NEUTRAL,
    },
    HarnessProfile {
        id: "codex",
        display: "Codex",
        unmeasured_signals: &[
            Signal::StepBoundaries,
            Signal::SandboxPolicy,
            Signal::NetworkAccess,
            Signal::UserCorrections,
        ],
        degraded_rules: &[],
        session_store: true,
        fold: Some(FoldOutput::TokenBuckets),
        // 自报 provider（`model_provider`）+ 账户订阅 → 官方订阅（§2 L2）。
        attribution: AttributionProfile { provider_reported_implies_official: true, credits_only: false },
    },
    HarnessProfile {
        id: "claude-code",
        display: "Claude Code",
        unmeasured_signals: &[
            Signal::ContextWindow,
            Signal::QuotaConsumption,
            Signal::ApprovalDecisions,
            Signal::SandboxModes,
            Signal::SandboxPolicy,
            Signal::NetworkAccess,
            Signal::UserCorrections,
        ],
        degraded_rules: &[
            DegradedRule {
                code: "SV607",
                missing: &[Signal::ToolResults],
                reason: CLAUDE_SV607_608_REASON,
            },
            DegradedRule {
                code: "SV608",
                missing: &[Signal::ToolResults],
                reason: CLAUDE_SV607_608_REASON,
            },
        ],
        session_store: true,
        fold: Some(FoldOutput::TokenBuckets),
        attribution: AttributionProfile::NEUTRAL,
    },
    HarnessProfile {
        id: "workbuddy",
        display: "WorkBuddy",
        // QuotaConsumption 不在此列（2026-09-11 B6）：credit_json 每条目 = 一次配额
        // 消耗观察，分子 measured；分母不可观测由 note 说明。见 workbuddy_evidence.rs。
        // ToolResults / SubagentSpawns 不在此列（E2）：traces 的 function/agent span
        // 可按 `trace.sessionId` 归属，已折进 timeline/coverage。
        unmeasured_signals: &[
            Signal::StepBoundaries,
            Signal::Usage,
            Signal::ContextWindow,
            Signal::SandboxPolicy,
            Signal::Compaction,
            Signal::SkillInvocations,
            Signal::Hooks,
            Signal::UserPrompts,
            Signal::UserCorrections,
        ],
        // SV604/605 的降级行**已移除**（spec §9E.5 E2，2026-09-11）：它的前提「write/
        // edit 只存在于会话匿名的 traces」是 09-02 的分析错误——traces 可按
        // `trace.sessionId` 归属，Edit/Write span 解码后 783/784 带 `file_path`，现已
        // 折进 tool_calls。SV604/605 在 WorkBuddy 上照跑，零命中就是诚实 MeasuredZero。
        degraded_rules: &[],
        // 无 SessionStore（envelope 未知执行环境 → StoreError，v0.6 spec §4）。
        session_store: false,
        // 无日/月折叠机制（会话审计的成本块是执行环境已计费 credit 求和，不重计价）；
        // M4（可选演练）会把这行改成 `Some(HarnessBillTotals)`。
        fold: None,
        // 积分制：金额面是执行环境自报的积分/账单，不进按量与订阅判定（§0 表 E）。
        attribution: AttributionProfile { provider_reported_implies_official: false, credits_only: true },
    },
];

/// 按 id 查找一行。未知 id 返回 `None`——查询路径 fail-open（现状保持），注册
/// 路径 fail-closed（不在 `HARNESSES` 里的 id 任何消费方都查不到，v0.6 spec §5.3
/// 条款 2）。
pub fn harness_profile(harness_id: &str) -> Option<&'static HarnessProfile> {
    HARNESSES.iter().find(|h| h.id == harness_id)
}

/// 归因面人格。**未知执行环境 fail-closed 到 `NEUTRAL`**（不做任何特殊处理）：判定器
/// 拿不到声明时宁可少判，也不按名字猜（自动归因 §10.6）。
pub fn attribution_profile(harness_id: &str) -> AttributionProfile {
    harness_profile(harness_id).map(|h| h.attribution).unwrap_or(AttributionProfile::NEUTRAL)
}

/// `agent-vitals harnesses --json` 的负载——`HARNESSES` 行的忠实序列化，供 G1
/// byte-parity 与 Python `harness_capability.py::harnesses_json` 逐字节对比
/// （v0.6 spec §8 G1）。Signal 用 `format!("{:?}", …)` 序列化（"ToolCalls" 等
/// PascalCase 名），与仓库其余 `evidence_json` 的 `signals` 数组同一种写法。
pub fn harnesses_json() -> serde_json::Value {
    let harnesses: Vec<serde_json::Value> = HARNESSES
        .iter()
        .map(|h| {
            let unmeasured: Vec<String> =
                h.unmeasured_signals.iter().map(|s| format!("{s:?}")).collect();
            let degraded: Vec<serde_json::Value> = h
                .degraded_rules
                .iter()
                .map(|r| {
                    let missing: Vec<String> = r.missing.iter().map(|s| format!("{s:?}")).collect();
                    serde_json::json!({
                        "code": r.code,
                        "missing": missing,
                        "reason": r.reason,
                    })
                })
                .collect();
            serde_json::json!({
                "id": h.id,
                "display": h.display,
                "unmeasured_signals": unmeasured,
                "degraded_rules": degraded,
                "session_store": h.session_store,
                "fold": h.fold.map(FoldOutput::as_str),
                "attribution": {
                    "provider_reported_implies_official": h.attribution.provider_reported_implies_official,
                    "credits_only": h.attribution.credits_only,
                },
            })
        })
        .collect();
    serde_json::json!({ "harnesses": harnesses })
}

/// SV607/608 harness-capability degradation 的 reason。Claude 的 tool_result 没有
/// 原因码词汇——`error_code` 结构性恒 None（绝不伪造原因码，§3），SV607/608 是
/// 原因级检测器（读 error_code，不读 failed），在全 None 上空转出 MeasuredZero
/// 是对「结构上读不到原因」撒谎。与 Python `harness_capability.py` 的
/// `CLAUDE_SV607_608_REASON` 逐字节相同。
pub const CLAUDE_SV607_608_REASON: &str = "claude-code harness capability: tool results carry \
no reason codes (error_code structurally absent); SV607/608 are reason-level detectors and \
cannot discriminate";

/// 把执行环境的结构性缺口如实标注成 Unavailable。未知执行环境 → no-op（DSH/Codex 没有
/// 这种 degrade，它们的 golden 字节零改动）。
///
/// M0 起改成 `HARNESSES` 行查找（原来是 match 臂）——签名与语义不变：只在
/// MeasuredZero→Unavailable 方向翻转，绝不吞 Findings 或既有 Unavailable；未知
/// 执行环境 no-op。行里没有 degraded_rules 的执行环境（dsh/codex）天然是空切片，循环
/// 零次，等价于原 match 的 `_ => return`。
pub fn degrade_rule_outcomes(harness_id: &str, outcomes: &mut [(&'static str, RuleOutcome)]) {
    let Some(profile) = harness_profile(harness_id) else { return };
    for rule in profile.degraded_rules {
        for (code, outcome) in outcomes.iter_mut() {
            if *code == rule.code && matches!(outcome, RuleOutcome::MeasuredZero) {
                *outcome = RuleOutcome::Unavailable {
                    missing: rule.missing.to_vec(),
                    reason: rule.reason.to_string(),
                };
            }
        }
    }
}


#[cfg(test)]
mod tests {

    /// 归因声明是**执行环境人格**的一部分：未知执行环境 fail-closed 到最保守的一份（不做任何
    /// 特殊处理），已注册执行环境按声明生效（codex 自报即官方、workbuddy 恒积分制）。
    #[test]
    fn attribution_profile_declares_the_harness_facts_and_fails_closed() {
        assert!(attribution_profile("codex").provider_reported_implies_official);
        assert!(attribution_profile("workbuddy").credits_only);
        assert!(!attribution_profile("claude-code").provider_reported_implies_official,
            "claude-code has no self-reported provider — its provider_id is inferred from id shapes");
        assert!(!attribution_profile("claude-code").credits_only);
        assert_eq!(attribution_profile("nope").credits_only, AttributionProfile::NEUTRAL.credits_only);
        assert_eq!(attribution_profile("nope").provider_reported_implies_official,
            AttributionProfile::NEUTRAL.provider_reported_implies_official);
    }
    use super::*;

    fn outcomes() -> Vec<(&'static str, RuleOutcome)> {
        vec![
            ("SV601", RuleOutcome::MeasuredZero),
            ("SV604", RuleOutcome::MeasuredZero),
            ("SV605", RuleOutcome::MeasuredZero),
            ("SV607", RuleOutcome::MeasuredZero),
            ("SV608", RuleOutcome::MeasuredZero),
        ]
    }

    fn unavailable_of(o: &RuleOutcome) -> Option<(&[Signal], &str)> {
        match o {
            RuleOutcome::Unavailable { missing, reason } => Some((missing, reason)),
            _ => None,
        }
    }

    #[test]
    fn claude_code_flips_only_measured_zero_sv607_sv608() {
        let mut out = outcomes();
        degrade_rule_outcomes("claude-code", &mut out);
        for (code, outcome) in &out {
            match *code {
                "SV607" | "SV608" => {
                    let (missing, reason) = unavailable_of(outcome).expect("必须 Unavailable");
                    assert_eq!(missing, &[Signal::ToolResults]);
                    assert_eq!(reason, CLAUDE_SV607_608_REASON);
                }
                _ => assert!(matches!(outcome, RuleOutcome::MeasuredZero), "{code} 不得动"),
            }
        }
    }

    #[test]
    fn workbuddy_no_longer_degrades_anything() {
        // E2（2026-09-11）：SV604/605 的降级前提「write/edit 只在匿名 traces」被推翻，
        // 降级行删除。WorkBuddy 现在与 dsh/codex 一样：MeasuredZero 原样保留。
        let mut out = outcomes();
        degrade_rule_outcomes("workbuddy", &mut out);
        for (code, outcome) in &out {
            assert!(matches!(outcome, RuleOutcome::MeasuredZero), "{code} 不得动");
        }
    }

    #[test]
    fn unknown_harness_is_a_no_op() {
        let mut out = outcomes();
        degrade_rule_outcomes("dsh", &mut out);
        for (_, outcome) in &out {
            assert!(matches!(outcome, RuleOutcome::MeasuredZero));
        }
    }

    #[test]
    fn override_never_swallows_findings_or_existing_unavailable() {
        let mut out = vec![
            ("SV607", RuleOutcome::Findings(vec![serde_json::json!({"rule": "SV607"})])),
            ("SV608", RuleOutcome::Unavailable {
                missing: vec![Signal::ToolResults],
                reason: "gate: no evidence".to_string(),
            }),
            ("SV604", RuleOutcome::MeasuredZero),
        ];
        degrade_rule_outcomes("claude-code", &mut out);
        // SV607 的 Findings 保持原样；SV608 已 Unavailable 保持原样（reason 不动）；
        // SV604 不是 claude-code 的 degrade 范围。
        assert!(matches!(out[0].1, RuleOutcome::Findings(_)));
        let (missing, reason) = unavailable_of(&out[1].1).unwrap();
        assert_eq!(reason, "gate: no evidence", "已有 Unavailable 不得被覆盖");
        assert_eq!(missing, &[Signal::ToolResults]);
        assert!(matches!(out[2].1, RuleOutcome::MeasuredZero));
    }

    // ── M0：HARNESSES 行骨架（v0.6 spec §11） ──────────────────────────────

    #[test]
    fn harnesses_row_ids_are_the_four_runtime_harnesses_in_order() {
        let ids: Vec<&str> = HARNESSES.iter().map(|h| h.id).collect();
        assert_eq!(ids, vec!["dsh", "codex", "claude-code", "workbuddy"]);
    }

    #[test]
    fn harness_profile_looks_up_by_id_and_is_none_for_unknown() {
        assert_eq!(harness_profile("claude-code").unwrap().display, "Claude Code");
        assert!(harness_profile("future-harness").is_none());
    }

    #[test]
    fn only_claude_code_declares_degraded_rules() {
        // E2 起 workbuddy 的 SV604/605 降级行删除——只剩 claude-code 的 SV607/608。
        for h in HARNESSES {
            match h.id {
                "dsh" | "codex" | "workbuddy" => {
                    assert!(h.degraded_rules.is_empty(), "{} 不应有降级行", h.id)
                }
                "claude-code" => {
                    let codes: Vec<&str> = h.degraded_rules.iter().map(|r| r.code).collect();
                    assert_eq!(codes, vec!["SV607", "SV608"]);
                }
                other => panic!("未知执行环境 id: {other}"),
            }
        }
    }

    #[test]
    fn only_workbuddy_declares_no_session_store_or_fold() {
        for h in HARNESSES {
            if h.id == "workbuddy" {
                assert!(!h.session_store, "workbuddy 无 SessionStore（§4）");
                assert!(h.fold.is_none(), "workbuddy 无日/月折叠（§4）");
            } else {
                assert!(h.session_store, "{} 应有 SessionStore", h.id);
                assert_eq!(h.fold, Some(FoldOutput::TokenBuckets), "{} 应产 TokenBuckets", h.id);
            }
        }
    }

    #[test]
    fn harnesses_json_shape_is_stable() {
        let j = harnesses_json();
        let harnesses = j["harnesses"].as_array().unwrap();
        assert_eq!(harnesses.len(), 4);
        let dsh = &harnesses[0];
        assert_eq!(dsh["id"], "dsh");
        assert_eq!(dsh["fold"], "token_buckets");
        assert_eq!(dsh["degraded_rules"], serde_json::json!([]));
        let claude = &harnesses[2];
        assert_eq!(claude["id"], "claude-code");
        assert_eq!(claude["degraded_rules"][0]["code"], "SV607");
        assert_eq!(claude["degraded_rules"][0]["missing"], serde_json::json!(["ToolResults"]));
        let wb = &harnesses[3];
        assert_eq!(wb["id"], "workbuddy");
        assert_eq!(wb["session_store"], false);
        assert_eq!(wb["fold"], serde_json::Value::Null);
    }
}
