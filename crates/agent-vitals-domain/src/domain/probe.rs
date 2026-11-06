//! 探针判定的纯逻辑层（「测试」tab / V17 probe 面）。
//!
//! 权威定义：`docs/v1.0.0/WORKBENCH_TEST_TAB_SPEC.md` §4（判定哲学）与
//! `SCHEMA_V16_V17_ENRICHMENT_PROBE_SPEC.md` §4（probe_verdicts 词表）。
//! 本模块只做确定性判定推导——不做 I/O、不读时钟（dependency_budget 纪律），
//! 统计与证据的产出形状（statistic_json / evidence_chain_json / confounders_json）
//! 在这里定形，runner 只负责喂数据。
//!
//! 诚实性规则（naive 实现为什么是错的）：
//!
//! 1. **别名展开（日期后缀）算匹配，tier 变体不算**。resolved 常带日期后缀
//!    （`claude-sonnet-5-20260815`）或提供方限定前缀（`anthropic/x`）——逐字
//!    比较会把正常响应判成注水；但 `-flash`/`-sol` 这类字母 tier 标记是**不同
//!    模型**，静默按匹配处理会把注水变 no_signal。规则全文见 `model_matches`。
//! 2. **resolved 缺席不是证据**。探针跑完但协议里读不到 resolved model →
//!    `no_signal`（带原因），绝不默认"一致"也不默认"可疑"。
//! 3. **判定必须可反驳**。evidence_chain 记录"什么证据会改变结论"（如
//!    "resolved 字段被中转改写可伪造一致——L1 行为对照才是否定性证据"），
//!    让读者知道判定强度的边界。
//! 4. **scrub 纪律沿用**：evidence_json 只放协议字段与计数，绝不放完整回复
//!    文本（B 类合成数据虽放开存，但证据链要的是可核对的字段，不是转写）。

use serde_json::{Value, json};

// ────────────────────────── 判定词表（与 probe_verdicts CHECK 同步） ──────────────────────────

/// 五值闭集（authority `probe_verdicts.verdict` CHECK 的镜像；同步由
/// data 层 probe 存储测试钉住）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum ProbeVerdict {
    ConfirmedMismatch,
    SuspectedDegradation,
    NoSignal,
    Underpowered,
    InconclusiveConfounded,
}

impl ProbeVerdict {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProbeVerdict::ConfirmedMismatch => "confirmed_mismatch",
            ProbeVerdict::SuspectedDegradation => "suspected_degradation",
            ProbeVerdict::NoSignal => "no_signal",
            ProbeVerdict::Underpowered => "underpowered",
            ProbeVerdict::InconclusiveConfounded => "inconclusive_confounded",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "confirmed_mismatch" => ProbeVerdict::ConfirmedMismatch,
            "suspected_degradation" => ProbeVerdict::SuspectedDegradation,
            "no_signal" => ProbeVerdict::NoSignal,
            "underpowered" => ProbeVerdict::Underpowered,
            "inconclusive_confounded" => ProbeVerdict::InconclusiveConfounded,
            _ => return None,
        })
    }

    pub const fn variant_count() -> usize {
        5
    }
}

// ────────────────────────── L0 观察 → 判定 ──────────────────────────

/// 一次 L0 身份探针的观察结果（runner 从 `claude -p --output-format stream-json`
/// 的事件流里抽取；字段缺失 = 执行环境/中转没给，保持 `None`）。
#[derive(Clone, Debug, PartialEq)]
pub struct L0Observation {
    /// 路线档案里声明的请求模型（别名形态）。
    pub requested_model: String,
    /// 协议事件里报告的 resolved model（init/assistant/result 事件的 `model` 字段）。
    pub resolved_model: Option<String>,
    /// 四桶 usage（uncached_input, cache_read, cache_write, output）。
    pub usage: Option<(i64, i64, i64, i64)>,
    /// 会话 id（探针自己也是执行环境会话——回填 probe_results.session_key 的原料）。
    pub native_session_id: Option<String>,
}

/// 前缀展开后剩余部分是否「日期形」：空、或 `-` + 纯数字/连字符
/// （`-20260815`、`-2024-08-06`）。字母 tier 标记（`-flash`/`-mini`/`-air`/
/// `-sol`/`-luna`）**不是**日期——tier 变体是不同模型，静默按匹配处理会把
/// 注水变 no_signal（验收 e2e 实锤：requested sonnet-5 vs resolved
/// sonnet-5-flash 曾被误判 matched）。
fn date_shaped_suffix(remainder: &str) -> bool {
    if remainder.is_empty() {
        return true;
    }
    let Some(stripped) = remainder.strip_prefix('-') else {
        return false;
    };
    // 全为数字/连字符，且数字位数 ≥6：真日期段（20260815 / 2024-08-06）满足，
    // 版本尾（-6 / -4）不满足——opus-4 与 opus-4-6 是不同模型（验收案例）。
    let digits = stripped.chars().filter(|c| c.is_ascii_digit()).count();
    digits >= 6 && stripped.chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// 归一化比较。三步（规则 1 的完整版；两轮实机/验收实锤过缺口）：
/// 1. 去空白、小写；
/// 2. 剥提供方限定段（最后一个 `/` 之前——`anthropic/x` → `x`；本机中转
///    加限定前缀曾致全线误报 mismatch）；
/// 3. 等值，或**一侧是另一侧前缀且剩余为日期形后缀**（`-20260815`）。
///    tier 字母后缀不算匹配——那是换了模型。
fn model_matches(requested: &str, resolved: &str) -> (bool, String, String) {
    let norm = |value: &str| {
        let lowered = value.trim().to_ascii_lowercase();
        match lowered.rsplit_once('/') {
            Some((_, base)) if !base.is_empty() => base.to_string(),
            _ => lowered,
        }
    };
    let request = norm(requested);
    let result = norm(resolved);
    let matched = request == result
        || (result.starts_with(request.as_str())
            && date_shaped_suffix(&result[request.len()..]))
        || (request.starts_with(result.as_str())
            && date_shaped_suffix(&request[result.len()..]));
    (matched, request, result)
}

/// 单路线 L0 判定（纯函数）。产出 verdict + 三段 JSON（statistic/evidence/
/// confounders——形状与 `probe_verdicts` 三列一一对应）。
pub fn evaluate_l0_single(observation: &L0Observation, rule_version: &str) -> Value {
    let mut evidence: Vec<Value> = Vec::new();
    let mut confounders: Vec<Value> = Vec::new();
    let verdict;
    match observation.resolved_model.as_deref() {
        None => {
            verdict = ProbeVerdict::NoSignal;
            evidence.push(json!({
                "kind": "resolved_model_absent",
                "note": "协议事件未携带 model 字段——无身份证据，不默认一致也不默认可疑",
            }));
        }
        Some(resolved) => {
            let (matched, request_norm, resolved_norm) =
                model_matches(&observation.requested_model, resolved);
            evidence.push(json!({
                "kind": "model_identity",
                "requested": observation.requested_model,
                "resolved": resolved,
                "requested_normalized": request_norm,
                "resolved_normalized": resolved_norm,
                "alias_prefix_rule": true,
                "matched": matched,
            }));
            if !matched {
                verdict = ProbeVerdict::ConfirmedMismatch;
                evidence.push(json!({
                    "kind": "rebuttal",
                    "note": "可反驳路径：中转可改写响应 model 字段伪造一致；L1 行为对照是否定性证据",
                }));
            } else {
                verdict = ProbeVerdict::NoSignal;
                evidence.push(json!({
                    "kind": "rebuttal",
                    "note": "身份一致不排除能力注水（effort 调低/thinking 剥离不在本探针覆盖内）——升级需 L1",
                }));
                confounders.push(json!({
                    "kind": "identity_only",
                    "note": "L0 身份探针只覆盖 resolved==requested；行为面证据缺位",
                }));
            }
        }
    }
    if let Some(usage) = observation.usage {
        let (input, cache_read, cache_write, output) = usage;
        evidence.push(json!({
            "kind": "usage_four_buckets",
            "uncached_input_tokens": input,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "output_tokens": output,
        }));
    }
    json!({
        "verdict": verdict.as_str(),
        "rule_version": rule_version,
        "statistic_json": json!({
            "probe": "l0_identity",
            "n": 1,
            "note": "L0 单次无统计量——statistic 位如实说明，不造 p 值",
        }),
        "evidence_chain_json": evidence,
        "confounders_json": confounders,
    })
}

/// 合并（worst-of，单路与成对同一规则）：任一报告 confirmed 即 confirmed，
/// 否则任一 no_signal 即 no_signal，否则 underpowered。P1 只产
/// confirmed/no_signal/underpowered 三值——`suspected_degradation` 需要 L1
/// 行为统计、`inconclusive_confounded` 需要混杂标记（RTT/时段），两者都随
/// tab P2 落地（词表五值齐备是为了 schema 不再动，不是为了现在就产）。
pub fn combine_l0_paired(single_reports: &[Value], rule_version: &str) -> Value {
    let verdicts: Vec<&str> = single_reports
        .iter()
        .filter_map(|report| report.get("verdict").and_then(Value::as_str))
        .collect();
    let verdict = if verdicts.contains(&"confirmed_mismatch") {
        ProbeVerdict::ConfirmedMismatch
    } else if verdicts.contains(&"no_signal") {
        ProbeVerdict::NoSignal
    } else {
        ProbeVerdict::Underpowered
    };
    json!({
        "verdict": verdict.as_str(),
        "rule_version": rule_version,
        "statistic_json": json!({
            "probe": "l0_identity_paired",
            "n_reports": single_reports.len(),
            "note": "worst-of 合并；配对置换检验属 L1 统计层（P2），此处不造显著性",
        }),
        "evidence_chain_json": single_reports,
        "confounders_json": [json!({
            "kind": "not_behavioral",
            "note": "L0 合并仍非行为对照；suspected_degradation 需要 L1 统计证据",
        })],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_vocabulary_is_the_five_value_closed_set() {
        let all = [
            (ProbeVerdict::ConfirmedMismatch, "confirmed_mismatch"),
            (ProbeVerdict::SuspectedDegradation, "suspected_degradation"),
            (ProbeVerdict::NoSignal, "no_signal"),
            (ProbeVerdict::Underpowered, "underpowered"),
            (ProbeVerdict::InconclusiveConfounded, "inconclusive_confounded"),
        ];
        assert_eq!(all.len(), ProbeVerdict::variant_count());
        for (variant, wire) in all {
            assert_eq!(variant.as_str(), wire);
            assert_eq!(ProbeVerdict::from_wire(wire), Some(variant));
        }
        assert_eq!(ProbeVerdict::from_wire("definitely_watered"), None);
    }

    #[test]
    fn alias_prefix_is_a_match_not_a_mismatch() {
        // 规则 1：日期后缀是常态，逐字比较会把正常响应全判成注水。
        let observation = L0Observation {
            requested_model: "claude-sonnet-5".to_string(),
            resolved_model: Some("claude-sonnet-5-20260815".to_string()),
            usage: Some((12, 0, 0, 5)),
            native_session_id: Some("s-1".to_string()),
        };
        let report = evaluate_l0_single(&observation, "stat-v1");
        assert_eq!(report["verdict"], json!("no_signal"));
        assert_eq!(report["evidence_chain_json"][0]["matched"], json!(true));
    }

    #[test]
    fn tier_variant_suffixes_are_not_matches() {
        // 验收 e2e 实锤的假阴性洞：字母 tier 标记是不同模型。
        for (requested, resolved) in [
            ("claude-sonnet-5", "claude-sonnet-5-flash"),
            ("claude-opus-4-6", "claude-opus-4"),
            ("gpt-5.6", "openai/gpt-5.6-sol"),
        ] {
            let observation = L0Observation {
                requested_model: requested.to_string(),
                resolved_model: Some(resolved.to_string()),
                usage: None,
                native_session_id: None,
            };
            let report = evaluate_l0_single(&observation, "stat-v1");
            assert_ne!(
                report["verdict"],
                serde_json::json!("no_signal"),
                "tier 变体必须判 mismatch：{requested} vs {resolved}"
            );
            assert_eq!(report["evidence_chain_json"][0]["matched"], serde_json::json!(false));
        }
        // 日期后缀仍是匹配（别名的合法展开形态）。
        for (requested, resolved) in [
            ("claude-sonnet-5", "claude-sonnet-5-20260815"),
            ("gpt-4o", "openai/gpt-4o-2024-08-06"),
        ] {
            let observation = L0Observation {
                requested_model: requested.to_string(),
                resolved_model: Some(resolved.to_string()),
                usage: None,
                native_session_id: None,
            };
            let report = evaluate_l0_single(&observation, "stat-v1");
            assert_eq!(report["verdict"], serde_json::json!("no_signal"), "{requested} vs {resolved}");
        }
    }

    #[test]
    fn provider_qualified_prefix_is_stripped_before_comparing() {
        // 实机首跑案例（2026-09-19，官方直连路线经本机中转）：resolved 带
        // `anthropic/` 限定前缀——同模型，不是注水。
        let observation = L0Observation {
            requested_model: "claude-sonnet-5".to_string(),
            resolved_model: Some("anthropic/claude-sonnet-5".to_string()),
            usage: None,
            native_session_id: None,
        };
        let report = evaluate_l0_single(&observation, "stat-v1");
        assert_eq!(report["verdict"], json!("no_signal"), "限定前缀必须剥掉再比");
        assert_eq!(report["evidence_chain_json"][0]["matched"], json!(true));
        // 家族真换了：basename 也不同 → 照样 confirmed。
        let swapped = L0Observation {
            requested_model: "claude-sonnet-5".to_string(),
            resolved_model: Some("deepseek/deepseek-v4-pro".to_string()),
            usage: None,
            native_session_id: None,
        };
        let report = evaluate_l0_single(&swapped, "stat-v1");
        assert_eq!(report["verdict"], json!("confirmed_mismatch"));
    }

    #[test]
    fn resolved_differs_from_requested_is_confirmed_with_rebuttal() {
        let observation = L0Observation {
            requested_model: "claude-sonnet-5".to_string(),
            resolved_model: Some("claude-haiku-4-5".to_string()),
            usage: None,
            native_session_id: None,
        };
        let report = evaluate_l0_single(&observation, "stat-v1");
        assert_eq!(report["verdict"], json!("confirmed_mismatch"));
        let chain = report["evidence_chain_json"].as_array().unwrap();
        assert!(chain.iter().any(|item| item["kind"] == json!("rebuttal")));
    }

    #[test]
    fn absent_resolved_model_is_no_signal_not_defaulted() {
        // 规则 2：缺席不是证据。
        let observation = L0Observation {
            requested_model: "claude-sonnet-5".to_string(),
            resolved_model: None,
            usage: None,
            native_session_id: None,
        };
        let report = evaluate_l0_single(&observation, "stat-v1");
        assert_eq!(report["verdict"], json!("no_signal"));
        assert!(report["evidence_chain_json"][0]["kind"] == json!("resolved_model_absent"));
    }

    #[test]
    fn paired_combination_is_worst_of() {
        let mut ok = evaluate_l0_single(
            &L0Observation {
                requested_model: "m".to_string(),
                resolved_model: Some("m-20260101".to_string()),
                usage: None,
                native_session_id: None,
            },
            "stat-v1",
        );
        ok["route"] = json!("A");
        let mut bad = evaluate_l0_single(
            &L0Observation {
                requested_model: "m".to_string(),
                resolved_model: Some("other-model".to_string()),
                usage: None,
                native_session_id: None,
            },
            "stat-v1",
        );
        bad["route"] = json!("B");
        let combined = combine_l0_paired(&[ok, bad], "stat-v1");
        assert_eq!(combined["verdict"], json!("confirmed_mismatch"));
        assert_eq!(combined["statistic_json"]["n_reports"], json!(2));
    }

    #[test]
    fn reports_never_carry_reply_text() {
        // 规则 4：证据链只有协议字段与计数。
        let observation = L0Observation {
            requested_model: "m".to_string(),
            resolved_model: Some("m".to_string()),
            usage: Some((1, 2, 3, 4)),
            native_session_id: Some("s".to_string()),
        };
        let report = evaluate_l0_single(&observation, "stat-v1");
        let text = report.to_string();
        assert!(!text.contains("reply"), "证据链不得携带回复文本");
        assert!(text.contains("usage_four_buckets"));
    }
}
