//! recipe 提取语义（HARNESS_MANIFEST_DSL_SPEC §4）。
//!
//! **纯模块**：输入是已解析的一条源记录（`serde_json::Value`）与生效映射，
//! 输出三态 `LineVerdict`。无 I/O、无时钟——golden parity 的前提。
//!
//! ## discriminator（§4.3）
//!
//! 行型成员判据 = **主数量槽位有效路径的父容器是 JSON object**（该行携带
//! usage 记账块的形状标记）。刻意的取舍：
//! - 容器缺失 → `skip(not_target_record)`——无账可记的行（失败请求、
//!   非 usage 行），不是坏行；
//! - 容器在而主数量缺失/null/类型错 → `invalid`——schema drift 必须显式
//!   报告，不许伪装成 skip。
//!
//! 判据是「父容器对象」而不是主 token 数字本身（§4.3「不得仅等价于主
//! token 路径存在」）：数字存在与否是 required-shape 检查，归属 invalid。
//!
//! ## 三 recipe 的算术（§4.1）
//!
//! - `request-usage-anthropic-v1`：input 已是非缓存输入，原样入桶；
//! - `request-usage-openai-total-input-v1`：total 含 cached，受控减法
//!   `uncached = total − (cache_read ?? 0)`，负数 → `invalid`；
//! - `request-usage-four-bucket-v1`：四桶均为增量，原样入桶。
//!
//! `source_usage_semantics` 三者均为 `delta`（逐请求增量）；`observation_kind`
//! 与官方 emitter 同词表（`token_count`）。

use serde_json::Value;

use super::candidate::CandidateUsageV1;
use super::manifest::PluginManifest;

/// 语义槽位（与 `manifest::OVERRIDE_SLOTS` 字符串一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Slot {
    EventTs,
    ModelRaw,
    ProviderRaw,
    UncachedInputTokens,
    TotalInputTokens,
    CacheReadTokens,
    CacheWriteTokens,
    OutputTokens,
    ProviderRequestId,
}

impl Slot {
    pub fn as_str(&self) -> &'static str {
        match self {
            Slot::EventTs => "event_ts",
            Slot::ModelRaw => "model_raw",
            Slot::ProviderRaw => "provider_raw",
            Slot::UncachedInputTokens => "uncached_input_tokens",
            Slot::TotalInputTokens => "total_input_tokens",
            Slot::CacheReadTokens => "cache_read_tokens",
            Slot::CacheWriteTokens => "cache_write_tokens",
            Slot::OutputTokens => "output_tokens",
            Slot::ProviderRequestId => "provider_request_id",
        }
    }

    pub fn from_manifest_str(s: &str) -> Option<Slot> {
        Some(match s {
            "event_ts" => Slot::EventTs,
            "model_raw" => Slot::ModelRaw,
            "provider_raw" => Slot::ProviderRaw,
            "uncached_input_tokens" => Slot::UncachedInputTokens,
            "total_input_tokens" => Slot::TotalInputTokens,
            "cache_read_tokens" => Slot::CacheReadTokens,
            "cache_write_tokens" => Slot::CacheWriteTokens,
            "output_tokens" => Slot::OutputTokens,
            "provider_request_id" => Slot::ProviderRequestId,
            _ => return None,
        })
    }
}

/// recipe 静态定义：固化默认路径、可覆写槽位、token 算术与语义 stamp
/// （§4.1「每个 recipe 必须固化」清单）。版本在 id 里（`-v1`）。
pub struct RecipeDef {
    pub id: &'static str,
    /// 主数量槽位：行型判据与必填检查都挂在它上面。
    pub main_slot: Slot,
    /// 语义槽位默认路径（zcode 这类执行环境用 overrides 改指向）。
    pub defaults: &'static [(Slot, &'static str)],
    /// 允许 overrides 改写的槽位（§4.2：不能改 token 算术与行型判据本身）。
    pub overridable: &'static [Slot],
    pub source_usage_semantics: &'static str,
    pub observation_kind: &'static str,
    /// 算术形态（openai-total-input 的受控减法标记）。
    pub subtract_cache_read_from_main: bool,
}

const ANTHROPIC_DEFAULTS: &[(Slot, &str)] = &[
    (Slot::EventTs, "timestamp"),
    (Slot::ModelRaw, "model"),
    (Slot::UncachedInputTokens, "usage.input_tokens"),
    (Slot::CacheReadTokens, "usage.cache_read_input_tokens"),
    (Slot::CacheWriteTokens, "usage.cache_creation_input_tokens"),
    (Slot::OutputTokens, "usage.output_tokens"),
];

const TOTAL_INPUT_DEFAULTS: &[(Slot, &str)] = &[
    (Slot::EventTs, "timestamp"),
    (Slot::ModelRaw, "model"),
    (Slot::TotalInputTokens, "usage.prompt_tokens"),
    (Slot::CacheReadTokens, "usage.cache_read_input_tokens"),
    (Slot::OutputTokens, "usage.output_tokens"),
];

const FOUR_BUCKET_DEFAULTS: &[(Slot, &str)] = &[
    (Slot::EventTs, "timestamp"),
    (Slot::ModelRaw, "model"),
    (Slot::UncachedInputTokens, "usage.input_tokens"),
    (Slot::CacheReadTokens, "usage.cache_read_tokens"),
    (Slot::CacheWriteTokens, "usage.cache_write_tokens"),
    (Slot::OutputTokens, "usage.output_tokens"),
];

const ALL_SLOTS: [Slot; 9] = [
    Slot::EventTs,
    Slot::ModelRaw,
    Slot::ProviderRaw,
    Slot::UncachedInputTokens,
    Slot::TotalInputTokens,
    Slot::CacheReadTokens,
    Slot::CacheWriteTokens,
    Slot::OutputTokens,
    Slot::ProviderRequestId,
];

pub fn recipe_def(id: &str) -> Option<&'static RecipeDef> {
    const ANTHROPIC: RecipeDef = RecipeDef {
        id: "request-usage-anthropic-v1",
        main_slot: Slot::UncachedInputTokens,
        defaults: ANTHROPIC_DEFAULTS,
        overridable: &ALL_SLOTS,
        source_usage_semantics: "delta",
        observation_kind: "token_count",
        subtract_cache_read_from_main: false,
    };
    const TOTAL_INPUT: RecipeDef = RecipeDef {
        id: "request-usage-openai-total-input-v1",
        main_slot: Slot::TotalInputTokens,
        defaults: TOTAL_INPUT_DEFAULTS,
        overridable: &ALL_SLOTS,
        source_usage_semantics: "delta",
        observation_kind: "token_count",
        subtract_cache_read_from_main: true,
    };
    const FOUR_BUCKET: RecipeDef = RecipeDef {
        id: "request-usage-four-bucket-v1",
        main_slot: Slot::UncachedInputTokens,
        defaults: FOUR_BUCKET_DEFAULTS,
        overridable: &ALL_SLOTS,
        source_usage_semantics: "delta",
        observation_kind: "token_count",
        subtract_cache_read_from_main: false,
    };
    match id {
        "request-usage-anthropic-v1" => Some(&ANTHROPIC),
        "request-usage-openai-total-input-v1" => Some(&TOTAL_INPUT),
        "request-usage-four-bucket-v1" => Some(&FOUR_BUCKET),
        _ => None,
    }
}

/// 三态裁决（§4.3）。`excerpt` 是记录序列化的前 ~120 字符（脱敏截断沿用
/// 既有 redaction 惯例，最多 8 条进报告——条数上限由喉咙管）。
#[derive(Debug, Clone, PartialEq)]
pub enum LineVerdict {
    Emit(CandidateUsageV1),
    Skip { reason: &'static str },
    Invalid { code: String, excerpt: String },
}

/// manifest overrides 与 recipe 的合约检查（§4.2）：只能改 `overridable`
/// 声明的槽位。返回 Ok(()) 或 `overrides.<slot>` 形态的问题。
pub fn check_overrides(def: &RecipeDef, manifest: &PluginManifest) -> Result<(), String> {
    for key in manifest.overrides.keys() {
        let Some(slot) = Slot::from_manifest_str(key) else {
            return Err(format!("overrides.{key}: 未知槽位"));
        };
        if !def.overridable.contains(&slot) {
            return Err(format!(
                "overrides.{key}: recipe `{}` 不允许覆写该槽位",
                def.id
            ));
        }
    }
    Ok(())
}

/// 生效映射：默认路径 + manifest overrides。
pub fn effective_path(def: &RecipeDef, manifest: &PluginManifest, slot: Slot) -> String {
    if let Some(path) = manifest.overrides.get(slot.as_str()) {
        return path.clone();
    }
    def.defaults
        .iter()
        .find(|(s, _)| *s == slot)
        .map(|(_, p)| p.to_string())
        .unwrap_or_default()
}

/// 点路径取值：缺失 → `Value::Null`（类型统一，调用方按 null 处理）。
/// 空路径短路返回 Null——`"".split('.')` 会产生 `[""]`，否则记录里的 `""`
/// 键（JSON 合法）会向无默认的槽位（provider_raw 等）静默泄漏值。
pub fn dotted_get<'a>(record: &'a Value, path: &str) -> &'a Value {
    if path.is_empty() {
        return &Value::Null;
    }
    let mut cur = record;
    for seg in path.split('.') {
        match cur.get(seg) {
            Some(v) => cur = v,
            None => return &Value::Null,
        }
    }
    cur
}

/// token 值提取：bool 不当整数（Python isinstance 陷阱的两语言共同防线）；
/// 非整数 / 越界 → None（调用方判 invalid）。负数返回 Some(负值)，由调用方
/// 区分 negative_token_count 与 arithmetic_negative。
fn token_value(v: &Value) -> Option<Option<i64>> {
    match v {
        Value::Null => Some(None),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(Some(i))
            } else if let Some(u) = n.as_u64() {
                // > i64::MAX 的 u64：越界。
                if u <= i64::MAX as u64 {
                    Some(Some(u as i64))
                } else {
                    None
                }
            } else {
                None // 浮点
            }
        }
        _ => None, // 字符串/bool/对象/数组
    }
}

fn is_bool(v: &Value) -> bool {
    matches!(v, Value::Bool(_))
}

/// §4.4：event_key 值的 canonical encoding——类型标记 + 长度前缀 +
/// `event_key.paths` 固定顺序。字符串长度前缀是 **UTF-8 字节数**
/// （`str::len`）；Python twin 必须用 `len(s.encode("utf-8"))`，不是码点数。
/// 任一路径缺失/null/浮点/对象/数组 → None（调用方判 invalid）。
pub fn canonical_event_key(
    manifest: &PluginManifest,
    record: &Value,
) -> Option<String> {
    let mut out = String::new();
    for path in &manifest.event_key_paths {
        let v = dotted_get(record, path);
        match v {
            Value::String(s) => out.push_str(&format!("s{}:{};", s.len(), s)),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    let d = i.to_string();
                    out.push_str(&format!("i{}:{};", d.len(), d));
                } else {
                    let u = n.as_u64()?;
                    let d = u.to_string();
                    out.push_str(&format!("i{}:{};", d.len(), d));
                }
            }
            Value::Bool(b) => out.push_str(&format!("b1:{};", if *b { "1" } else { "0" })),
            _ => return None, // 缺失/null/对象/数组 → invalid
        }
    }
    Some(out)
}

/// 单行提取主入口（§4.3 三态）。
pub fn extract_line(
    def: &RecipeDef,
    manifest: &PluginManifest,
    record: &Value,
) -> LineVerdict {
    let invalid = |code: &str, record: &Value| LineVerdict::Invalid {
        code: code.to_string(),
        excerpt: truncate_excerpt(record),
    };

    // discriminator：主数量槽位有效路径的父容器必须是 object。
    let main_path = effective_path(def, manifest, def.main_slot);
    let parent_path = match main_path.rsplit_once('.') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    };
    let parent_ok = if parent_path.is_empty() {
        record.is_object()
    } else {
        dotted_get(record, &parent_path).is_object()
    };
    if !parent_ok {
        return LineVerdict::Skip {
            reason: "not_target_record",
        };
    }

    // required-shape：主数量（§4.3「容器在而必填缺失 = invalid」）。
    let Some(main_opt) = token_value(dotted_get(record, &main_path)) else {
        if is_bool(dotted_get(record, &main_path)) {
            return invalid("type_mismatch", record);
        }
        return invalid("token_type_mismatch", record);
    };
    let Some(main_qty) = main_opt else {
        return invalid("required_field_missing", record);
    };
    if main_qty < 0 {
        return invalid("negative_token_count", record);
    }

    // event_ts：字符串 + 显式 offset（复用 domain::parse_iso，不引第二份解析）。
    let ts_val = dotted_get(record, &effective_path(def, manifest, Slot::EventTs));
    let Some(ts_str) = ts_val.as_str() else {
        return if ts_val.is_null() {
            invalid("required_field_missing", record)
        } else {
            invalid("type_mismatch", record)
        };
    };
    let Some((secs, explicit)) = agent_vitals_domain::domain::budget::parse_iso(ts_str) else {
        return invalid("bad_timestamp", record);
    };
    if !explicit {
        return invalid("timestamp_without_offset", record);
    }
    // 闰秒拒绝（parse_iso 会把 :60 当 60 秒吞掉，这里显式拦）。
    let ss: i64 = ts_str[17..19].parse().unwrap_or(0);
    if ss > 59 {
        return invalid("leap_second_timestamp", record);
    }

    // model_raw：非空字符串。
    let model_val = dotted_get(record, &effective_path(def, manifest, Slot::ModelRaw));
    let Some(model_raw) = model_val.as_str().filter(|s| !s.is_empty()) else {
        return invalid("required_field_missing", record);
    };

    // 其余 token 桶：可选，给了就必须是合法非负整数。
    let mut buckets: [(Slot, Option<i64>); 4] = [
        (Slot::UncachedInputTokens, None),
        (Slot::CacheReadTokens, None),
        (Slot::CacheWriteTokens, None),
        (Slot::OutputTokens, None),
    ];
    for (slot, slot_val) in buckets.iter_mut() {
        let path = effective_path(def, manifest, *slot);
        if path.is_empty() {
            continue;
        }
        let raw = dotted_get(record, &path);
        if raw.is_null() {
            continue;
        }
        let Some(v) = token_value(raw) else {
            return if is_bool(raw) {
                invalid("type_mismatch", record)
            } else {
                invalid("token_type_mismatch", record)
            };
        };
        let Some(n) = v else {
            return invalid("required_field_missing", record);
        };
        if n < 0 {
            return invalid("negative_token_count", record);
        }
        *slot_val = Some(n);
    }

    // 算术：openai-total-input 的受控减法。
    let cache_read = buckets[1].1;
    let uncached;
    match def.main_slot {
        Slot::TotalInputTokens => {
            let cr = cache_read.unwrap_or(0);
            let diff = main_qty.checked_sub(cr);
            match diff {
                Some(d) if d >= 0 => uncached = Some(d),
                _ => return invalid("arithmetic_negative", record),
            }
        }
        _ => uncached = buckets[0].1,
    }

    // event_key → source_event_id。
    let Some(source_event_id) = canonical_event_key(manifest, record) else {
        return invalid("event_key_missing", record);
    };

    let provider_raw = dotted_get(record, &effective_path(def, manifest, Slot::ProviderRaw))
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let provider_request_id = dotted_get(
        record,
        &effective_path(def, manifest, Slot::ProviderRequestId),
    )
    .as_str()
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string());

    LineVerdict::Emit(CandidateUsageV1 {
        event_ts_utc_ms: secs.saturating_mul(1000),
        source_event_id,
        model_raw: model_raw.to_string(),
        provider_raw,
        uncached_input_tokens: uncached,
        cache_read_tokens: cache_read,
        cache_write_tokens: buckets[2].1,
        output_tokens: buckets[3].1,
        provider_request_id,
    })
}

/// 脱敏截断（~120 字符，spec §6.5）：序列化失败按字面量兜底。
fn truncate_excerpt(record: &Value) -> String {
    let raw = serde_json::to_string(record).unwrap_or_else(|_| "<unserializable>".into());
    raw.chars().take(120).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harnesses::generic::manifest::parse_manifest;
    use serde_json::json;

    /// zcode 试点 manifest（附录 B 的 recipe 版，映射 providerMetadata 原生块）。
    fn zcode_manifest() -> PluginManifest {
        parse_manifest(json!({
            "manifest_version": 1,
            "slug": "zcode",
            "display": { "name": "ZCode" },
            "discovery": { "roots": ["~/r"], "include": ["*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": { "from": "filename", "pattern": "^s_(?P<id>.+)\\.jsonl$" },
            "recipe": "request-usage-anthropic-v1",
            "overrides": {
                "event_ts": "completedAt",
                "model_raw": "model.modelId",
                "provider_raw": "model.providerId",
                "uncached_input_tokens": "response.providerMetadata.anthropic.usage.input_tokens",
                "cache_read_tokens": "response.providerMetadata.anthropic.usage.cache_read_input_tokens",
                "output_tokens": "response.providerMetadata.anthropic.usage.output_tokens",
                "provider_request_id": "requestId"
            },
            "event_key": { "paths": ["requestId", "attempt"] }
        })).unwrap()
    }

    fn zcode_row(input: i64, cache_read: i64) -> Value {
        json!({
            "requestId": "658f3c85",
            "attempt": 1,
            "completedAt": "2026-09-19T15:18:41.337Z",
            "durationMs": 25648,
            "model": { "modelId": "GLM-5.3", "providerId": "builtin:bigmodel-coding-plan" },
            "response": {
                "usage": { "inputTokens": input + cache_read, "cacheReadTokens": cache_read },
                "providerMetadata": { "anthropic": { "usage": {
                    "input_tokens": input, "cache_read_input_tokens": cache_read,
                    "output_tokens": 1568
                }}}
            }
        })
    }

    #[test]
    fn zcode_row_emits_candidate_with_native_anthropic_buckets() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        check_overrides(def, &m).unwrap();
        match extract_line(def, &m, &zcode_row(886, 403_776)) {
            LineVerdict::Emit(c) => {
                assert_eq!(c.event_ts_utc_ms, 1_789_831_121_000, "显式 Z → UTC 毫秒");
                assert_eq!(c.model_raw, "GLM-5.3");
                assert_eq!(c.provider_raw.as_deref(), Some("builtin:bigmodel-coding-plan"));
                assert_eq!(c.uncached_input_tokens, Some(886), "原生块即非缓存输入");
                assert_eq!(c.cache_read_tokens, Some(403_776));
                assert_eq!(c.output_tokens, Some(1568));
                assert_eq!(c.source_event_id, "s8:658f3c85;i1:1;");
            }
            other => panic!("应 emit，得到 {other:?}"),
        }
    }

    #[test]
    fn no_usage_block_is_skip_not_invalid() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        // 中止请求行：容器（providerMetadata.anthropic.usage 的父链）缺。
        let aborted = json!({ "requestId": "x", "attempt": 1,
            "completedAt": "2026-09-19T15:18:41Z", "error": "aborted" });
        assert_eq!(
            extract_line(def, &m, &aborted),
            LineVerdict::Skip { reason: "not_target_record" }
        );
    }

    #[test]
    fn usage_container_without_main_quantity_is_invalid_not_skip() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        let mut row = zcode_row(886, 10);
        row["response"]["providerMetadata"]["anthropic"]["usage"]
            .as_object_mut().unwrap().remove("input_tokens");
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "required_field_missing"),
            other => panic!("schema drift 须 invalid，得到 {other:?}"),
        }
    }

    #[test]
    fn bool_is_never_an_integer() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        let mut row = zcode_row(886, 10);
        row["response"]["providerMetadata"]["anthropic"]["usage"]["input_tokens"] = json!(true);
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "type_mismatch"),
            other => panic!("bool 不是整数：{other:?}"),
        }
    }

    #[test]
    fn timestamp_rules_without_offset_and_leap_second() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        let mut row = zcode_row(1, 0);
        row["completedAt"] = json!("2026-09-19T15:18:41");
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "timestamp_without_offset"),
            other => panic!("{other:?}"),
        }
        let mut row = zcode_row(1, 0);
        row["completedAt"] = json!("2026-09-19T15:18:60Z");
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "leap_second_timestamp"),
            other => panic!("{other:?}"),
        }
        let mut row = zcode_row(1, 0);
        row["completedAt"] = json!("not-a-time");
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "bad_timestamp"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn negative_and_out_of_range_tokens_are_invalid() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        let row = zcode_row(-1, 0);
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "negative_token_count"),
            other => panic!("{other:?}"),
        }
        // u64 越过 i64::MAX → token_type_mismatch（越界）。
        let mut row = zcode_row(1, 0);
        row["response"]["providerMetadata"]["anthropic"]["usage"]["output_tokens"] =
            json!(9_223_372_036_854_775_808u64);
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "token_type_mismatch"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn event_key_missing_paths_are_invalid() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        let mut row = zcode_row(1, 0);
        row.as_object_mut().unwrap().remove("attempt");
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "event_key_missing"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn openai_total_input_recipe_subtracts_cache_read() {
        let m = parse_manifest(json!({
            "manifest_version": 1, "slug": "t", "display": { "name": "T" },
            "discovery": { "roots": ["~/r"], "include": ["*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": { "from": "filename", "pattern": "^s_(?P<id>.+)\\.jsonl$" },
            "recipe": "request-usage-openai-total-input-v1",
            "overrides": {
                "event_ts": "ts", "model_raw": "model",
                "total_input_tokens": "usage.prompt_tokens",
                "cache_read_tokens": "usage.cache_read_input_tokens",
                "output_tokens": "usage.completion_tokens"
            },
            "event_key": { "paths": ["id"] }
        })).unwrap();
        let def = recipe_def(&m.recipe).unwrap();
        let row = json!({ "id": "e1", "ts": "2026-09-19T00:00:00+08:00", "model": "m",
            "usage": { "prompt_tokens": 500, "cache_read_input_tokens": 300,
                       "completion_tokens": 20 } });
        match extract_line(def, &m, &row) {
            LineVerdict::Emit(c) => {
                assert_eq!(c.uncached_input_tokens, Some(200), "500 − 300 受控减法");
                assert_eq!(c.cache_read_tokens, Some(300));
            }
            other => panic!("{other:?}"),
        }
        // 减出负数 → arithmetic_negative。
        let bad = json!({ "id": "e2", "ts": "2026-09-19T00:00:00+08:00", "model": "m",
            "usage": { "prompt_tokens": 100, "cache_read_input_tokens": 300 } });
        match extract_line(def, &m, &bad) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "arithmetic_negative"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn four_bucket_recipe_maps_as_is() {
        let m = parse_manifest(json!({
            "manifest_version": 1, "slug": "t", "display": { "name": "T" },
            "discovery": { "roots": ["~/r"], "include": ["*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": { "from": "filename", "pattern": "^s_(?P<id>.+)\\.jsonl$" },
            "recipe": "request-usage-four-bucket-v1",
            "event_key": { "paths": ["id"] }
        })).unwrap();
        let def = recipe_def(&m.recipe).unwrap();
        let row = json!({ "id": "e1", "timestamp": "2026-09-19T00:00:00Z", "model": "m",
            "usage": { "input_tokens": 10, "cache_read_tokens": 20,
                       "cache_write_tokens": 30, "output_tokens": 40 } });
        match extract_line(def, &m, &row) {
            LineVerdict::Emit(c) => {
                assert_eq!(c.uncached_input_tokens, Some(10));
                assert_eq!(c.cache_write_tokens, Some(30));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn override_on_slot_recipe_disallows_is_refused() {
        let m = zcode_manifest();
        let def = recipe_def("request-usage-anthropic-v1").unwrap();
        // P0 三个 recipe 均允许全槽位覆写——结构性检查存在但当前不约束。
        check_overrides(def, &m).unwrap();
        // 未知槽位字符串在 manifest 层已拒绝；这里只钉 recipe 端的防线还在。
        let mut m2 = zcode_manifest();
        m2.overrides.insert("future_slot".to_string(), "x.y".to_string());
        assert!(check_overrides(def, &m2).is_err());
    }

    #[test]
    fn candidate_json_field_order_is_stable() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        let c = match extract_line(def, &m, &zcode_row(886, 403_776)) {
            LineVerdict::Emit(c) => c,
            other => panic!("{other:?}"),
        };
        let s = serde_json::to_string(&c.to_json()).unwrap();
        assert_eq!(
            s,
            "{\"event_ts_utc_ms\":1789831121000,\"source_event_id\":\"s8:658f3c85;i1:1;\",\
             \"model_raw\":\"GLM-5.3\",\"provider_raw\":\"builtin:bigmodel-coding-plan\",\
             \"uncached_input_tokens\":886,\"cache_read_tokens\":403776,\
             \"cache_write_tokens\":null,\"output_tokens\":1568,\
             \"provider_request_id\":\"658f3c85\"}",
            "golden parity 的字节契约"
        );
    }

    #[test]
    fn excerpt_is_truncated_to_120_chars() {
        let m = zcode_manifest();
        let def = recipe_def(&m.recipe).unwrap();
        let mut row = zcode_row(1, 0);
        row["completedAt"] = json!(12345);
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { excerpt, .. } => {
                assert!(excerpt.chars().count() <= 120);
                assert!(excerpt.starts_with('{'));
            }
            other => panic!("{other:?}"),
        }
    }
}

#[cfg(test)]
mod parity_and_edge_tests {
    use super::*;
    use crate::harnesses::generic::manifest::parse_manifest;
    use serde_json::json;

    fn four_bucket() -> (PluginManifest, &'static RecipeDef) {
        let m = parse_manifest(json!({
            "manifest_version": 1, "slug": "t", "display": { "name": "T" },
            "discovery": { "roots": ["~/r"], "include": ["*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": { "from": "filename", "pattern": "^s_(?P<id>.+)\\.jsonl$" },
            "recipe": "request-usage-four-bucket-v1",
            "event_key": { "paths": ["id"] }
        })).unwrap();
        let def = recipe_def(&m.recipe).unwrap();
        (m, def)
    }

    #[test]
    fn empty_key_in_record_never_leaks_into_pathless_slots() {
        // openai-total-input 的 cache_write_tokens / anthropic 的 provider_raw
        // 无默认路径；记录里的 `""` 键不得凭空填充它们。
        let m = parse_manifest(json!({
            "manifest_version": 1, "slug": "t", "display": { "name": "T" },
            "discovery": { "roots": ["~/r"], "include": ["*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": { "from": "filename", "pattern": "^s_(?P<id>.+)\\.jsonl$" },
            "recipe": "request-usage-openai-total-input-v1",
            "overrides": {
                "event_ts": "ts", "model_raw": "model",
                "total_input_tokens": "usage.prompt_tokens",
                "output_tokens": "usage.completion_tokens"
            },
            "event_key": { "paths": ["id"] }
        })).unwrap();
        let def = recipe_def(&m.recipe).unwrap();
        let row = json!({ "": 777, "id": "e1", "ts": "2026-09-19T00:00:00Z",
            "model": "m", "usage": { "prompt_tokens": 5, "completion_tokens": 1 } });
        match extract_line(def, &m, &row) {
            LineVerdict::Emit(c) => {
                assert_eq!(c.cache_write_tokens, None, "空路径短路，不许吃 `\"\"` 键");
                assert_eq!(c.cache_read_tokens, None);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn unicode_event_key_uses_utf8_byte_length() {
        let m = parse_manifest(json!({
            "manifest_version": 1, "slug": "t", "display": { "name": "T" },
            "discovery": { "roots": ["~/r"], "include": ["*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": { "from": "filename", "pattern": "^s_(?P<id>.+)\\.jsonl$" },
            "recipe": "request-usage-four-bucket-v1",
            "event_key": { "paths": ["id"] }
        })).unwrap();
        let def = recipe_def(&m.recipe).unwrap();
        // "会" 是 3 字节：s3:会;
        let row = json!({ "id": "会", "timestamp": "2026-09-19T00:00:00Z", "model": "m",
            "usage": { "input_tokens": 1 } });
        match extract_line(def, &m, &row) {
            LineVerdict::Emit(c) => assert_eq!(c.source_event_id, "s3:会;"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parity_edge_cases_float_string_and_over_u64() {
        let (m, def) = four_bucket();
        // 浮点 token：拒绝（serde_json/Python json 都是 float）。
        let row = json!({ "id": "e", "timestamp": "2026-09-19T00:00:00Z", "model": "m",
            "usage": { "input_tokens": 1.5 } });
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "token_type_mismatch"),
            other => panic!("{other:?}"),
        }
        // 字符串 token：拒绝。
        let row = json!({ "id": "e", "timestamp": "2026-09-19T00:00:00Z", "model": "m",
            "usage": { "input_tokens": "12" } });
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "token_type_mismatch"),
            other => panic!("{other:?}"),
        }
        // 2^64 及一切超大整数：serde_json 解析为 f64（Number 不再是整数）→
        // token_type_mismatch。Python twin 必须显式复刻该拒绝（json.loads 会
        // 给精确 int），这是双拍 fixtures 要钉的头号分歧。
        let row = json!({ "id": "e", "timestamp": "2026-09-19T00:00:00Z", "model": "m",
            "usage": { "input_tokens": 18446744073709551616.0 } });
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "token_type_mismatch"),
            other => panic!("{other:?}"),
        }
        // event_key 值是浮点 → invalid。
        let row = json!({ "id": 1.5, "timestamp": "2026-09-19T00:00:00Z", "model": "m",
            "usage": { "input_tokens": 1 } });
        match extract_line(def, &m, &row) {
            LineVerdict::Invalid { code, .. } => assert_eq!(code, "event_key_missing"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn usage_container_of_wrong_shape_is_skip_and_top_level_main_degenerates() {
        let (m, def) = four_bucket();
        // 容器存在但不是 object（显式 null / 数组）：当前规则 = skip（非目标行）。
        // 规格修订会把这条钉进 §4.3——本测试就是规则的可执行版本。
        for bad in [json!(null), json!([1, 2]), json!("x")] {
            let row = json!({ "id": "e", "timestamp": "2026-09-19T00:00:00Z",
                "model": "m", "usage": bad });
            assert_eq!(
                extract_line(def, &m, &row),
                LineVerdict::Skip { reason: "not_target_record" }
            );
        }
    }
}
