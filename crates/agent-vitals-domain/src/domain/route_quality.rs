//! 模型家族与「执行环境原生模型」判定 —— 「测试」tab v2（被动路线质量分析）的
//! 核心词表。2026-09-20 转向决定：主动探针在 cc-switch 型机器上做不干净
//! （settings.json env 压制进程注入、`--settings` 隔离又逼凭据离开 env-only
//! 红线），默认面改为分析**已记录**的事实——`usage_facts.model_id` 里的实际
//! 模型串本身就是硬证据（anthropic 官方 API 不会返回 deepseek/glm/minimax）。
//!
//! 双语纪律：与 `enrichment` 同款——Rust/Python 断言同一份
//! `fixtures/route_quality/vectors.json`，改词表 = 双语言一起过评审。
//! 词表是**封闭集**：新增家族/执行环境先改这里的测试向量，再改实现
//! （`issue_type` §2.4.2 同款纪律）。

/// 模型家族（封闭集，小写）。`synthetic` 不是模型——claude CLI 在请求失败时
/// 写下的本地占位（402 余额不足等），在路线质量面按「API 错误」单列；
/// `unknown` 是诚实兜底：不认识的串不猜家族。
pub const MODEL_FAMILIES: &[&str] = &[
    "anthropic",
    "openai",
    "deepseek",
    "glm",
    "minimax",
    "gemini",
    "qwen",
    "synthetic",
    "unknown",
];

/// 归一化：去空白、小写、剥厂商前缀（`anthropic/claude-opus-5` →
/// `claude-opus-5`，与 `domain::probe::model_matches` 同一条规则——前缀只是
/// 路由命名，不是模型本体）。
fn normalize(model_id: &str) -> String {
    let lowered = model_id.trim().to_lowercase();
    match lowered.rsplit_once('/') {
        Some((_, base)) if !base.is_empty() => base.to_string(),
        _ => lowered,
    }
}

/// 模型串 → 家族（封闭集成员）。前缀已剥，**前缀匹配**判族：多数厂商是
/// `家族-版本`（`deepseek-v4-pro`），但 Qwen 等存在无横杠版本（`qwen4-max`）
/// ——按「首个 `-` 前段」会漏，改为整串前缀判定（顺序即优先级，chatgpt 先于
/// gpt 防误吞；`o1/o3/o4` 仍按前段精确匹配，避免 `o4x` 之类误判）。
pub fn model_family(model_id: &str) -> &'static str {
    let base = normalize(model_id);
    if base.is_empty() {
        return "unknown";
    }
    if base == "<synthetic>" {
        return "synthetic";
    }
    if let Some(head) = base.split('-').next() {
        if matches!(head, "o1" | "o3" | "o4") {
            return "openai";
        }
    }
    // （前缀, 家族）顺序即优先级——改顺序 = 改判定，测试向量钉住。
    const PREFIXES: &[(&str, &str)] = &[
        ("claude", "anthropic"),
        ("chatgpt", "openai"),
        ("gpt", "openai"),
        ("deepseek", "deepseek"),
        ("glm", "glm"),
        ("minimax", "minimax"),
        ("gemini", "gemini"),
        ("qwen", "qwen"),
    ];
    for (prefix, family) in PREFIXES {
        if base.starts_with(prefix) {
            return family;
        }
    }
    "unknown"
}

/// 执行环境的原生模型家族：执行环境官方渠道只会给出的家族。`claude-code` 的官方
/// 端点只会给 anthropic 系——出现 deepseek/glm 即「确认非官方模型」级证据
/// （模型串来自协议响应，不由我们推断）。返回 `None` = 该执行环境没有声明基准
/// （新执行环境未登记），只做家族展示、不做「非原生」判定。
pub fn harness_native_families(harness: &str) -> Option<&'static [&'static str]> {
    match harness {
        "claude-code" => Some(&["anthropic"]),
        "codex" => Some(&["openai"]),
        // DeepSeek Harness 官方渠道即 deepseek 系；经中转也可能换模型，基准仍成立。
        "dsh" => Some(&["deepseek"]),
        _ => None,
    }
}

/// 单条事实的路线质量标记（封闭集）：`api_error`（synthetic 占位）/
/// `non_native`（执行环境官方不可能给出的家族——注水/降智的硬证据）/
/// `native`（执行环境原生家族内）/ `no_baseline`（执行环境无基准，不做判定）。
pub fn quality_flag(harness: &str, model_id: &str) -> &'static str {
    family_flag(harness, model_family(model_id))
}

/// 家族级标记（聚合层用——族名不是模型串，不能拿 `model_family` 回转）。
/// 与 `quality_flag` 同一判定、同一单一定义点。
pub fn family_flag(harness: &str, family: &str) -> &'static str {
    if family == "synthetic" {
        return "api_error";
    }
    match harness_native_families(harness) {
        Some(native) if native.contains(&family) => "native",
        Some(_) => "non_native",
        None => "no_baseline",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 两侧断言同一份向量（见模块 doc）；这里只钉实现内不变量。
    #[test]
    fn family_returns_are_closed_set_members() {
        for model in [
            "claude-sonnet-5", "anthropic/claude-opus-5", "deepseek-v4-flash",
            "deepseek/deepseek-v4-pro-0813", "glm-5.3-flash[1M]", "MiniMax-M2.7",
            "gpt-5.6-terra", "openai/gpt-5.6-sol", "<synthetic>", "totally-new-model",
            "  ", "",
        ] {
            assert!(
                MODEL_FAMILIES.contains(&model_family(model)),
                "{model} 必须落入封闭集"
            );
        }
    }

    #[test]
    fn vectors_fixture_lockstep() {
        let raw = include_str!("../../../../fixtures/route_quality/vectors.json");
        let cases: serde_json::Value = serde_json::from_str(raw).expect("vectors.json parses");
        for case in cases["cases"].as_array().expect("cases array") {
            let input = case["input"].as_str().expect("input");
            let harness = case["harness"].as_str().expect("harness");
            let expected_family = case["expected_family"].as_str().expect("expected_family");
            let expected_flag = case["expected_flag"].as_str().expect("expected_flag");
            assert_eq!(
                model_family(input), expected_family,
                "family({input:?}) — 向量 id {:?}",
                case["id"]
            );
            assert_eq!(
                quality_flag(harness, input), expected_flag,
                "flag({harness:?}, {input:?}) — 向量 id {:?}",
                case["id"]
            );
        }
    }
}
