//! 归因签名目录的纯规则层（BETA_1_AUTO_ATTRIBUTION_SPEC §2 L0/L1、§10 第③层）。
//!
//! 只回答两个执行环境无关的问题：**这个模型是谁家的**（L0，`model_vendor`）和
//! **这条记录像是打到了谁的端点**（L1，`route_shape`）。它不回答『谁收的钱』
//! ——`provider_id` 仍由 `agent_vitals_provider::resolve_billing_attribution`
//! 按证据强度决定；这里产出的 `Inferred` 永远不能单独把一批用量判成订阅。
//!
//! 厂商知识全部来自 `assets/attribution_signatures.json`（数据，随版本发布，
//! 不联网）；Python 镜像 `agent_vitals/agent/attribution.py` 读同一份文件，
//! `tests/test_attribution_signatures.py` 钉住两边逐字节同判。

use serde_json::Value;

const SIGNATURES_JSON: &str = include_str!("../../../../assets/attribution_signatures.json");

pub fn signatures() -> Value {
    serde_json::from_str(SIGNATURES_JSON).expect("assets/attribution_signatures.json is valid JSON")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorMatch {
    pub vendor: String,
    /// `vendor/model` 网关式命名——名字本身就说明请求经过了中转。
    pub gateway_named: bool,
}

/// L0：模型名 → 厂商。网关式 `<alias>/<model>` 先按别名表解析前缀；否则按各厂商
/// `model_prefixes` 不区分大小写做前缀匹配。哨兵（`<synthetic>` 等）与未知
/// 前缀返回 `None`——不猜。
pub fn model_vendor(model: &str) -> Option<VendorMatch> {
    model_vendor_in(&signatures(), model)
}

pub fn model_vendor_in(catalog: &Value, model: &str) -> Option<VendorMatch> {
    let model = model.trim();
    if model.is_empty() || is_sentinel(catalog, model) {
        return None;
    }
    let separator = catalog
        .pointer("/gateway_naming/separator")
        .and_then(Value::as_str)
        .unwrap_or("/");
    if let Some((prefix, rest)) = model.split_once(separator) {
        if !rest.is_empty() {
            let alias = prefix.to_ascii_lowercase();
            if let Some(vendor) = catalog
                .pointer("/gateway_naming/aliases")
                .and_then(|a| a.get(&alias))
                .and_then(Value::as_str)
            {
                return Some(VendorMatch { vendor: vendor.to_string(), gateway_named: true });
            }
            // 别名表不认识的前缀（`openrouter/anthropic/claude-…` 这类两级网关名）：
            // 剥掉一层继续判，网关身份保留。
            return model_vendor_in(catalog, rest)
                .map(|m| VendorMatch { vendor: m.vendor, gateway_named: true });
        }
    }
    vendor_by_prefix(catalog, model).map(|vendor| VendorMatch { vendor, gateway_named: false })
}

fn is_sentinel(catalog: &Value, model: &str) -> bool {
    catalog
        .pointer("/sentinels/models")
        .and_then(Value::as_array)
        .is_some_and(|models| models.iter().any(|m| m.as_str() == Some(model)))
}

fn vendor_by_prefix(catalog: &Value, model: &str) -> Option<String> {
    let lower = model.to_ascii_lowercase();
    let vendors = catalog.get("vendors")?.as_object()?;
    // 最长前缀优先：`glm-` 与 `codegeex` 互不包含，但未来若出现包含关系，
    // 长前缀更具体。
    let mut best: Option<(usize, &str)> = None;
    for (vendor, spec) in vendors {
        let Some(prefixes) = spec.get("model_prefixes").and_then(Value::as_array) else { continue };
        for prefix in prefixes.iter().filter_map(Value::as_str) {
            let p = prefix.to_ascii_lowercase();
            if !p.is_empty() && lower.starts_with(&p) && best.map_or(true, |(len, _)| p.len() > len) {
                best = Some((p.len(), vendor.as_str()));
            }
        }
    }
    best.map(|(_, vendor)| vendor.to_string())
}

/// 执行环境的原生厂商（`harness_native_vendor` 表）：执行环境读自家模型，模型名不带服务商前缀。
/// 没有登记的执行环境返回 `None`——不猜。
pub fn harness_native_vendor(harness: &str) -> Option<String> {
    harness_native_vendor_in(&signatures(), harness)
}

pub fn harness_native_vendor_in(catalog: &Value, harness: &str) -> Option<String> {
    catalog.pointer("/harness_native_vendor")?.get(harness)?.as_str().filter(|v| !v.is_empty()).map(str::to_string)
}

/// 原生厂商是 `vendor` 的所有执行环境（`harness_native_vendor` 表的反查）。
pub fn native_harnesses_of(vendor: &str) -> Vec<String> {
    signatures().pointer("/harness_native_vendor")
        .and_then(Value::as_object)
        .map(|table| table.iter()
            .filter(|(harness, native)| !harness.starts_with('_') && native.as_str() == Some(vendor))
            .map(|(harness, _)| harness.clone()).collect())
        .unwrap_or_default()
}

/// 某厂商的模型名前缀（小写）。
pub fn model_prefixes_of(vendor: &str) -> Vec<String> {
    signatures().pointer(&format!("/vendors/{vendor}/model_prefixes"))
        .and_then(Value::as_array)
        .map(|prefixes| prefixes.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).filter(|p| !p.is_empty()).collect())
        .unwrap_or_default()
}

/// 这个模型对该执行环境是不是「自家原生」：**无网关前缀**，且模型厂商就是执行环境的原生厂商。
/// 带前缀（`bigmodel/glm-5.3-flash`）= 第三方云厂商 / 中转；非原生系列（claude-code 下的 `deepseek-*`）
/// = 第三方。两者都返回 false，仍需要用户声明它走哪个中转。
pub fn is_harness_native_model(harness: &str, model: &str) -> bool {
    let Some(native) = harness_native_vendor(harness) else { return false };
    model_vendor(model).is_some_and(|m| !m.gateway_named && m.vendor == native)
}

/// L1：一条记录的请求/响应 ID 形状说明了什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteShape {
    /// 请求 ID 与响应 ID 都命中该厂商的文档格式 → 官方端点（session-native）。
    /// 目前只有声明了 `request_id_pattern` 的厂商（Anthropic）能到这一级。
    OfficialVendor(String),
    /// 响应 ID 形状与模型厂商一致，但分不出官方端点还是透传该形状的中转（inferred）。
    VendorShape(String),
    /// 网关式命名，或响应 ID 是别家/通用形状（如 `chatcmpl-`）→ 经过了中转（inferred）。
    Gateway,
    /// 没有任何可判形状（missing）。
    Unknown,
}

impl RouteShape {
    /// 对应 `agent_vitals_provider::EvidenceBasis::as_str()` 的词表。
    pub fn evidence_basis(&self) -> &'static str {
        match self {
            RouteShape::OfficialVendor(_) => "session-native",
            RouteShape::VendorShape(_) | RouteShape::Gateway => "inferred",
            RouteShape::Unknown => "missing",
        }
    }
}

pub fn route_shape(model: &str, request_id: Option<&str>, message_id: Option<&str>) -> RouteShape {
    route_shape_in(&signatures(), model, request_id, message_id)
}

pub fn route_shape_in(
    catalog: &Value, model: &str, request_id: Option<&str>, message_id: Option<&str>,
) -> RouteShape {
    let Some(vendor) = model_vendor_in(catalog, model) else {
        return RouteShape::Unknown;
    };
    if vendor.gateway_named {
        return RouteShape::Gateway;
    }
    let spec = catalog.pointer(&format!("/vendors/{}", vendor.vendor)).cloned().unwrap_or(Value::Null);
    let request_pattern = spec.get("request_id_pattern").and_then(Value::as_str);
    let message_pattern = spec.get("message_id_pattern").and_then(Value::as_str);
    let message_hit = message_id.is_some_and(|id| matches(message_pattern, id));
    if let Some(request_pattern) = request_pattern {
        let request_hit = request_id.is_some_and(|id| matches(Some(request_pattern), id));
        if request_hit && message_hit {
            return RouteShape::OfficialVendor(vendor.vendor);
        }
        // 该厂商本该给请求 ID 却没有：不是官方端点。有响应 ID 才谈得上“经过中转”。
        return if message_id.is_some() { RouteShape::Gateway } else { RouteShape::Unknown };
    }
    match (message_id, message_hit) {
        (Some(_), true) => RouteShape::VendorShape(vendor.vendor),
        (Some(_), false) => RouteShape::Gateway,
        (None, _) => RouteShape::Unknown,
    }
}

/// 含空白/控制字符的 ID 一律不命中：`$` 在 Rust 是串尾、在 Python 是串尾或末尾
/// 换行前，一个带尾随换行的 ID 会让两边判定分叉（验收审查 iteration 1 #1）。
/// 真实 API 的 ID 从不含这些字符，拒绝它们不损失召回。
fn matches(pattern: Option<&str>, value: &str) -> bool {
    if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    pattern.and_then(|p| regex::Regex::new(p).ok()).is_some_and(|re| re.is_match(value))
}

/// 官方端点主机名 → 厂商（边界感知：子域可以，包含厂商名的无关主机不算）。
pub fn official_endpoint_vendor(harness: &str) -> Option<String> {
    let catalog = signatures();
    let harness = harness.trim().trim_end_matches('.').to_ascii_lowercase();
    let harness = harness.split_once("://").map(|(_, rest)| rest).unwrap_or(&harness);
    let harness = harness.split('/').next().unwrap_or(harness);
    let harness = harness.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map(|(h, _)| h).unwrap_or(harness);
    let vendors = catalog.get("vendors")?.as_object()?;
    for (vendor, spec) in vendors {
        let Some(endpoints) = spec.get("official_endpoints").and_then(Value::as_array) else { continue };
        for endpoint in endpoints.iter().filter_map(Value::as_str) {
            let e = endpoint.to_ascii_lowercase();
            if harness == e || harness.ends_with(&format!(".{e}")) {
                return Some(vendor.clone());
            }
        }
    }
    None
}

/// 该厂商声明的全部官方端点主机名（可能不止一个环境/区域）。
pub fn official_endpoints_of(vendor: &str) -> Vec<String> {
    signatures()
        .pointer(&format!("/vendors/{vendor}/official_endpoints"))
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// 这个主机名是不是该厂商的官方端点（边界感知，含子域；与 `official_endpoint_vendor`
/// 同一套比较规则）。**用来判"配置里的基址是不是中转"**：不是官方端点 ≠ 一定中转，
/// 但"是官方端点"就是官方——这个否定面足够让 L3 的那一问改成一次确认。
pub fn is_official_endpoint(vendor: &str, harness: &str) -> bool {
    let harness = harness.trim().trim_end_matches('.').to_ascii_lowercase();
    if harness.is_empty() {
        return false;
    }
    official_endpoints_of(vendor).iter().any(|endpoint| {
        let e = endpoint.to_ascii_lowercase();
        harness == e || harness.ends_with(&format!(".{e}"))
    })
}

pub fn official_endpoint_of(vendor: &str) -> Option<String> {
    signatures()
        .pointer(&format!("/vendors/{vendor}/official_endpoints/0"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 官方端点判定必须是边界感知的：`api.deepseek.com` 是官方的，
    /// `router.shengsuanyun.com` / `api.deepseek.com.evil.example` 都不是。
    #[test]
    fn official_endpoint_membership_is_boundary_aware() {
        assert!(is_official_endpoint("deepseek", "api.deepseek.com"));
        assert!(is_official_endpoint("deepseek", "API.DeepSeek.com."));
        assert!(is_official_endpoint("deepseek", "beta.api.deepseek.com"));
        assert!(!is_official_endpoint("deepseek", "router.shengsuanyun.com"));
        assert!(!is_official_endpoint("deepseek", "api.deepseek.com.evil.example"));
        assert!(!is_official_endpoint("deepseek", ""));
        assert_eq!(official_endpoints_of("deepseek"), vec!["api.deepseek.com"]);
    }

    #[test]
    fn harness_native_models_have_no_gateway_prefix_and_belong_to_the_harnesses_own_vendor() {
        // 执行环境读自家模型：无前缀（用户 2026-10-01 的观察）
        assert!(is_harness_native_model("claude-code", "claude-sonnet-5-5"));
        assert!(is_harness_native_model("codex", "gpt-5.6-terra"));
        assert!(is_harness_native_model("harness:zcode", "GLM-5.3"), "大小写不敏感");
        assert!(is_harness_native_model("harness:zcode", "glm-5.3-flash"));
        // 第三方云厂商 / 中转给模型加路径前缀
        assert!(!is_harness_native_model("harness:zcode", "bigmodel/glm-5.3-flash"));
        assert!(!is_harness_native_model("codex", "deepseek/deepseek-v4.1-flash"));
        assert!(!is_harness_native_model("codex", "openai/gpt-5.6-luna"), "即使前缀就是自家厂商，带前缀也是经过网关");
        assert!(!is_harness_native_model("claude-code", "anthropic/claude-sonnet-5"));
        // 非原生系列：执行环境读别家的模型 = 第三方路由
        assert!(!is_harness_native_model("claude-code", "deepseek-v4-flash"));
        assert!(!is_harness_native_model("claude-code", "MiniMax-M3"));
        assert!(!is_harness_native_model("claude-code", "glm-5.3-flash"));
        // 没登记原生厂商的执行环境 / 哨兵 / 空：不猜
        assert!(!is_harness_native_model("workbuddy", "hy4-preview-f"));
        assert!(!is_harness_native_model("claude-code", "<synthetic>"));
        assert!(!is_harness_native_model("claude-code", ""));
        assert_eq!(harness_native_vendor("harness:zcode").as_deref(), Some("zhipu-glm"));
        assert_eq!(harness_native_vendor("nope"), None);
        assert!(model_prefixes_of("zhipu-glm").contains(&"glm-".to_string()));
        assert_eq!(native_harnesses_of("zhipu-glm"), vec!["harness:zcode".to_string()]);
        assert_eq!(native_harnesses_of("anthropic"), vec!["claude-code".to_string()]);
        assert!(native_harnesses_of("nobody").is_empty());
    }

    #[test]
    fn catalog_parses_and_every_vendor_has_prefixes_or_endpoints() {
        let catalog = signatures();
        for (vendor, spec) in catalog["vendors"].as_object().unwrap() {
            let prefixes = spec["model_prefixes"].as_array().map_or(0, Vec::len);
            let endpoints = spec["official_endpoints"].as_array().map_or(0, Vec::len);
            assert!(prefixes + endpoints > 0, "{vendor} declares nothing");
            for key in ["request_id_pattern", "message_id_pattern"] {
                if let Some(p) = spec.get(key).and_then(Value::as_str) {
                    regex::Regex::new(p).unwrap_or_else(|e| panic!("{vendor}.{key}: {e}"));
                }
            }
        }
    }

    /// 本机 2026-09 待确认列表里出现过的每一个模型名都必须落到一个厂商。
    #[test]
    fn real_machine_model_names_all_resolve_to_a_vendor() {
        for (model, vendor, gateway) in [
            ("claude-sonnet-5", "anthropic", false), ("claude-opus-5", "anthropic", false),
            ("claude-haiku-4-5-20251001", "anthropic", false), ("anthropic/claude-opus-5", "anthropic", true),
            ("gpt-5.6-luna", "openai", false), ("gpt-6-astra", "openai", false), ("openai/gpt-5.6-sol", "openai", true),
            ("deepseek-v4-flash", "deepseek", false), ("deepseek/deepseek-v4.1-flash", "deepseek", true),
            ("MiniMax-M3", "minimax", false), ("MiniMax-M2.7", "minimax", false),
            ("glm-5.3-flash", "zhipu-glm", false), ("bigmodel/glm-5.3-flash", "zhipu-glm", true),
            ("moonshot/kimi-k3", "moonshot", true), ("hy4-preview-f", "hunyuan", false),
        ] {
            let m = model_vendor(model).unwrap_or_else(|| panic!("{model} unresolved"));
            assert_eq!((m.vendor.as_str(), m.gateway_named), (vendor, gateway), "{model}");
        }
        let two_level = model_vendor("openrouter/anthropic/claude-opus-5").unwrap();
        assert_eq!((two_level.vendor.as_str(), two_level.gateway_named), ("anthropic", true));
        assert_eq!(route_shape("claude-opus-5", Some("req_011Cf5wHSjBXJbBc7FLDugfD"), Some("msg_01ABCDEFGHJKLMNPQRSTUVWX\n")),
            RouteShape::Gateway, "an id with trailing whitespace never counts as official");
        assert_eq!(model_vendor("<synthetic>"), None);
        assert_eq!(model_vendor("fast-model"), None);
        assert_eq!(model_vendor("totally-unknown-model"), None);
    }

    /// §1.2 的真机形状表：Anthropic 两个 ID 都命中才是官方；缺 `req_` 的 claude
    /// 模型是中转；厂商形状一致只到 inferred；`chatcmpl-` 打到 deepseek 模型上是网关。
    #[test]
    fn route_shapes_follow_the_measured_id_formats() {
        let req = Some("req_011Cf5wHSjBXJbBc7FLDugfD");
        assert_eq!(route_shape("claude-opus-5", req, Some("msg_01ABCDEFGHJKLMNPQRSTUVWX")),
            RouteShape::OfficialVendor("anthropic".into()));
        assert_eq!(route_shape("claude-opus-5", None, Some("msg_bd1234567890abcdef")), RouteShape::Gateway);
        assert_eq!(route_shape("anthropic/claude-opus-5", req, Some("msg_01ABCDEFGHJKLMNPQRSTUVWX")), RouteShape::Gateway);
        assert_eq!(route_shape("claude-opus-5", None, None), RouteShape::Unknown);
        assert_eq!(route_shape("MiniMax-M3", None, Some("06eed8a1b2c3d4e5f60718293a4b5c6d")),
            RouteShape::VendorShape("minimax".into()));
        assert_eq!(route_shape("glm-5.3-flash", None, Some("msg_20260915123456789")),
            RouteShape::VendorShape("zhipu-glm".into()));
        assert_eq!(route_shape("deepseek-v4-flash", None, Some("chatcmpl-abc123")), RouteShape::Gateway);
        assert_eq!(route_shape("deepseek-v4-flash", None, None), RouteShape::Unknown);
        assert_eq!(route_shape("<synthetic>", None, Some("09c007aa")), RouteShape::Unknown);
        assert_eq!(RouteShape::OfficialVendor("anthropic".into()).evidence_basis(), "session-native");
        assert_eq!(RouteShape::Gateway.evidence_basis(), "inferred");
        assert_eq!(RouteShape::Unknown.evidence_basis(), "missing");
    }

    #[test]
    fn official_endpoints_are_boundary_aware() {
        assert_eq!(official_endpoint_vendor("https://api.anthropic.com/v1/messages").as_deref(), Some("anthropic"));
        assert_eq!(official_endpoint_vendor("router.cogfoundry.ai").as_deref(), Some("cogfoundry.ai"));
        assert_eq!(official_endpoint_vendor("api.openai.com:443").as_deref(), Some("openai"));
        assert_eq!(official_endpoint_vendor("notapi.openai.com.evil.example"), None);
        assert_eq!(official_endpoint_of("anthropic").as_deref(), Some("api.anthropic.com"));
    }
}
