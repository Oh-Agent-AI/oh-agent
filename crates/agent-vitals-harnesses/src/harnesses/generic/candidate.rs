//! `CandidateUsageV1` —— recipe/DSL/adapter 三条提取路径的共同输出 DTO
//! （HARNESS_MANIFEST_DSL_SPEC §9.1）。
//!
//! **纯模块**。Candidate 是版本化的内部契约，**不接受外部 `fact_id`**：
//! 身份由 runtime 喉咙经 `build_usage_fact` 统一计算。字段名刻意与
//! `USAGE_FACT_FIELDS` 的 token 四桶/模型归属同形，喉咙组装 fields map 时
//! 不需要翻译。
//!
//! 与外部记录的边界（§9.1）：`event_ts` 必须带显式 offset 的 RFC3339（解析
//! 后统一为 UTC 毫秒；无 offset / 闰秒 / 越界在提取层判 invalid，不进本
//! 结构）；token 桶只接受非负整数（bool 不当整数）；缺失（None）与真实 0
//! 必须可区分——gap 语义下沉到 `build_usage_fact` 的 null 字段。

use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateUsageV1 {
    /// 解析自 `event_ts` 槽位：显式 offset 的 RFC3339 → UTC 毫秒（截断到秒，
    /// 与 `parse_iso` 共享解析器——不引入第二份时间解析）。
    pub event_ts_utc_ms: i64,
    /// §4.4 event_key 的 canonical encoding 产物（类型标记 + 长度前缀 +
    /// 固定顺序）；不是 fact_id。
    pub source_event_id: String,
    pub model_raw: String,
    pub provider_raw: Option<String>,
    pub uncached_input_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub provider_request_id: Option<String>,
}

impl CandidateUsageV1 {
    /// golden/CLI 报告用的规范化 JSON。字段序固定（preserve_order +
    /// 逐键插入），Rust/Python 双侧字节一致的前提。
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::Value::Object({
            let mut m = serde_json::Map::new();
            m.insert("event_ts_utc_ms".to_string(), json!(self.event_ts_utc_ms));
            m.insert("source_event_id".to_string(), json!(self.source_event_id));
            m.insert("model_raw".to_string(), json!(self.model_raw));
            m.insert(
                "provider_raw".to_string(),
                self.provider_raw
                    .as_ref()
                    .map(|s| json!(s))
                    .unwrap_or(serde_json::Value::Null),
            );
            for (k, v) in [
                ("uncached_input_tokens", self.uncached_input_tokens),
                ("cache_read_tokens", self.cache_read_tokens),
                ("cache_write_tokens", self.cache_write_tokens),
                ("output_tokens", self.output_tokens),
            ] {
                m.insert(
                    k.to_string(),
                    v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null),
                );
            }
            m.insert(
                "provider_request_id".to_string(),
                self.provider_request_id
                    .as_ref()
                    .map(|s| json!(s))
                    .unwrap_or(serde_json::Value::Null),
            );
            m
        })
    }
}
