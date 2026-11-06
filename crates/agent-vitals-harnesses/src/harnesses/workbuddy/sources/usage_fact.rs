//! WorkBuddy traces → `UsageFact`（spec §9E.5 E4a/E4b）。两个入口：
//! - `workbuddy_traces_to_usage_facts(root)`——全量（CLI `workbuddy-usage-facts`
//!   的只读诊断面，Python 逐字节镜像）；
//! - `workbuddy_trace_file_to_usage_facts(path)`——单文件（E4b `sync_service` 的
//!   例行 ingest 面：一个 trace 文件 = 一个 source_id，dirty 才喂）。
//!
//! 两者共用 `emit_trace`：全量 = 按路径序对每个文件调单文件入口再拼接（测试钉
//! 这条等式，两侧都钉）。
//!
//! **源**：generation span 解码后的 `usage`（OpenAI 兼容格式）+ 逐调用 `model`——
//! E1 的读取层已经把二次编码解开、只留 `usages`/`model`。**每个 generation span 恰好
//! 一条 usage**（真机 5,067/5,067），所以 `source_event_id = spanId` 是原生身份
//! （`identity_basis: native`），不需要 Codex 那种字节偏移派生 id。
//!
//! **桶映射**（与 Codex 同形，`codex/sources/usage_fact.rs` 决策 A）：
//! `uncached = prompt − cached`、`cache_read = cached`、`cache_write = 0`（OpenAI 格式
//! 无此桶——`source_usage_semantics` 仍是 `delta`，每 span 一次独立调用）、
//! `output = completion`（OpenAI 的 completion **已含** reasoning，绝不叠加）。
//!
//! **归属**：`resolve_billing_attribution(None, None)`——WorkBuddy 的轨道（平台积分 /
//! 自配 key / 限免）是请求级且本机不可判（spec §2.1），所以 provider/route 一律不填：
//! `provider_id: null`、`pricing_basis: metered_estimate`、`evidence_basis: missing`，
//! `data-unresolved` 归入 billing-route-unknown。**不解析 `model` 前缀**（`custom-local:`
//! 不代表轨道，§2.1），**不把 models.json 当 RouteEvidence**（即便传入也是 ConfigCurrent
//! → 仍 unresolved，resolver 已内置这份保守）。
//!
//! **未归属 trace（无 `trace.sessionId`）按 Codex 先例计 `attempts.unattributed`，不发
//! 事实**——`native_session_id` 是身份必填字段，编一个就是编 session。
//!
//! Python 镜像 `agent/workbuddy_usage_fact.py`，逐字节对齐（`tests/test_workbuddy_usage_fact.py`）。

use std::collections::HashMap;
use std::path::Path;

use agent_vitals_domain::usage_fact::build_usage_fact;
use agent_vitals_provider::resolve_billing_attribution;
use serde_json::{json, Map, Value};

use agent_vitals_domain::source_identity::fnv1a64_hex;
use agent_vitals_domain::contracts::session_key::SessionKey;
use agent_vitals_domain::workflow::WorkflowEvent;

use super::traces::{
    read_workbuddy_trace_file, read_workbuddy_traces, SpanSummary, TraceSummary,
};

const HARNESS: &str = "workbuddy";
const OBSERVATION_KIND: &str = "assistant-usage";
/// attempts 词表——与 Codex 同键（`to_payload_value` 固定输出前三个）。
pub const SKIP: &str = "skip";
pub const UNREADABLE: &str = "unreadable";
pub const UNATTRIBUTED: &str = "unattributed";

/// 镜像 Python `workbuddy_usage_fact.UsageFactEmitResult`。`malformed` = degraded
/// 的 trace **文件**数（不是 JSON / 无 `trace` 对象）。
#[derive(Debug)]
pub struct UsageFactEmitResult {
    pub facts: Vec<Value>,
    pub workflow_events: Vec<WorkflowEvent>,
    pub attempts: HashMap<String, i64>,
    /// 全部 generation span 数（归属 + 未归属）。恒等式：`total = fact + skip +
    /// unreadable + unattributed + bad_id`——每个 span 恰落一个桶（decode_failed 先判，
    /// 再判无 usage，再判无 sessionId）。function span 的解码失败不在此计（不是用量事件）。
    pub total_generation_spans: i64,
    pub skip_rows: i64,
    pub malformed: i64,
}

fn workflow_time(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let (seconds, _) = agent_vitals_domain::domain::budget::parse_iso(value)?;
    let fraction_ms = value
        .split_once('.')
        .and_then(|(_, rest)| rest.split_once(['Z', '+', '-']).map(|(digits, _)| digits))
        .unwrap_or("")
        .chars()
        .take(3)
        .collect::<String>();
    let fraction_ms = if fraction_ms.is_empty() {
        0
    } else {
        let mut padded = fraction_ms;
        while padded.len() < 3 { padded.push('0'); }
        padded.parse::<i64>().ok()?
    };
    seconds.checked_mul(1000)?.checked_add(fraction_ms)
}

fn workflow_label(value: &str) -> String {
    if !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
    {
        value.to_string()
    } else {
        format!("fnv1a64:{:}", fnv1a64_hex(value.as_bytes()))
    }
}

fn workflow_error(value: Option<&str>) -> Option<String> {
    value.map(|error| format!("fnv1a64:{:}", fnv1a64_hex(error.as_bytes())))
}

fn workflow_outcome(status: Option<&str>, error: Option<&str>) -> &'static str {
    if error.is_some() { return "failed"; }
    match status.unwrap_or("").to_ascii_lowercase().as_str() {
        "ok" | "success" | "succeeded" | "completed" | "complete" => "succeeded",
        "error" | "failed" | "failure" => "failed",
        "cancelled" | "canceled" | "aborted" => "cancelled",
        _ => "unknown",
    }
}

#[allow(clippy::too_many_arguments)]
fn workflow_event(
    event_id: String,
    session_key: String,
    event_ts_ms: Option<i64>,
    event_type: &str,
    capability_kind: Option<&str>,
    capability_id: Option<String>,
    outcome: &str,
    duration_ms: Option<i64>,
    error_fingerprint: Option<String>,
    invocation_fingerprint: Option<String>,
) -> Option<WorkflowEvent> {
    let event = WorkflowEvent {
        event_id,
        session_key: Some(session_key),
        event_ts_ms: event_ts_ms?,
        event_type: event_type.to_string(),
        capability_kind: capability_kind.map(str::to_string),
        capability_id,
        capability_version: None,
        outcome: outcome.to_string(),
        duration_ms: duration_ms.filter(|value| *value >= 0),
        error_fingerprint,
        invocation_fingerprint,
        // V16 富化字段：workbuddy 源无结构化错误码证据，不猜、不填。
        error_code: None,
        error_class: None,
        error_excerpt: None,
        args_excerpt: None,
        request_bytes: None,
        result_bytes: None,
        native_event_id: None,
        source_line: None,
        source_byte_offset: None,
    };
    event.validate().ok().map(|_| event)
}

fn workflow_from_trace(
    trace: &TraceSummary,
    machine_namespace: &str,
    source_profile: &str,
) -> Vec<WorkflowEvent> {
    let Some(native_session_id) = trace.session_id.as_deref() else { return Vec::new() };
    let session_key = SessionKey::new("workbuddy", native_session_id, source_profile, machine_namespace).ledger_key();
    let mut events = Vec::new();
    let mut models = agent_vitals_domain::session_semantics::ModelSwitchTracker::default();
    for span in &trace.spans {
        let span_id = if span.span_id.is_empty() { "<missing-span>" } else { span.span_id.as_str() };
        let event_hash = |kind: &str| format!(
            "workflow:workbuddy:{:}",
            fnv1a64_hex(format!("{}|{}|{}", trace.trace_id, span_id, kind).as_bytes())
        );
        let started = workflow_time(span.started_at.as_deref());
        let ended = workflow_time(span.ended_at.as_deref());
        let outcome = workflow_outcome(span.status.as_deref(), span.error.as_deref());
        let error = workflow_error(span.error.as_deref());

        if span.kind == "agent" && span.parent_id.is_none() {
            if let Some(event) = workflow_event(
                event_hash("task_started"), session_key.clone(), started, "task_started",
                None, None, "unknown", None, None, None,
            ) { events.push(event); }
            if let Some(event) = workflow_event(
                event_hash("task_finished"), session_key.clone(), ended.or(started), "task_finished",
                None, None, outcome, span.duration_ms, error, None,
            ) { events.push(event); }
            continue;
        }

        if span.kind == "agent" && (span.agent_name.is_some() || span.name.starts_with("skill")) {
            let name = span.agent_name.as_deref().unwrap_or(&span.name);
            let skill = workflow_label(name);
            if let Some(event) = workflow_event(
                event_hash("skill_invoked"), session_key.clone(), started, "skill_invoked",
                Some("skill"), Some(skill.clone()), "unknown", None, None,
                Some(format!("fnv1a64:{:}", fnv1a64_hex(skill.as_bytes()))),
            ) { events.push(event); }
            if let Some(event) = workflow_event(
                event_hash("skill_finished"), session_key.clone(), ended.or(started), "skill_finished",
                Some("skill"), Some(skill), outcome, span.duration_ms, error.clone(), None,
            ) { events.push(event); }
        }

        if span.kind == "function" || span.kind == "custom" {
            let name = span.tool_name.as_deref().or_else(|| (!span.name.is_empty()).then_some(span.name.as_str()));
            if let Some(name) = name {
                let tool = workflow_label(name);
                let invocation = Some(format!("fnv1a64:{:}", fnv1a64_hex(tool.as_bytes())));
                if let Some(event) = workflow_event(
                    event_hash("tool_invoked"), session_key.clone(), started, "tool_invoked",
                    Some("tool"), Some(tool.clone()), "unknown", None, None, invocation.clone(),
                ) { events.push(event); }
                if let Some(event) = workflow_event(
                    event_hash("tool_finished"), session_key.clone(), ended.or(started), "tool_finished",
                    Some("tool"), Some(tool), outcome, span.duration_ms, error, invocation,
                ) { events.push(event); }
            }
        }

        for usage in &span.usages {
            let Some(model) = usage.model.as_deref() else { continue };
            let model = workflow_label(model);
            if models.observe(&model) {
                if let Some(event) = workflow_event(
                    event_hash("model_switched"), session_key.clone(), started, "model_switched",
                    Some("model"), Some(model), "succeeded", None, None, None,
                ) { events.push(event); }
            }
        }
    }
    events
}
fn span_to_usage_fact(
    span: &SpanSummary,
    native_session_id: &str,
    machine_namespace: &str,
    source_profile: &str,
) -> Option<Value> {
    let u = span.usages.first()?;
    let attribution = resolve_billing_attribution(None, None);
    let uncached = (u.prompt_tokens - u.cached_tokens).max(0);
    let mut fields = Map::new();
    fields.insert("machine_namespace".into(), json!(machine_namespace));
    fields.insert("harness".into(), json!(HARNESS));
    fields.insert("source_profile".into(), json!(source_profile));
    fields.insert("native_session_id".into(), json!(native_session_id));
    fields.insert("source_event_id".into(), json!(span.span_id));
    fields.insert("observation_kind".into(), json!(OBSERVATION_KIND));
    // spanId 是执行环境原生 id——不像 Codex 的 token_count 要靠字节偏移派生。
    fields.insert("identity_basis".into(), json!("native"));
    // span.startedAt 原样 ISO 毫秒串；缺失 → None（诚实无观测时间）。
    fields.insert("event_ts_utc".into(), json!(span.started_at));
    fields.insert(
        "time_basis".into(),
        if span.started_at.is_some() { json!("native") } else { Value::Null },
    );
    fields.insert("source_usage_semantics".into(), json!("delta"));
    fields.insert("model_raw".into(), json!(u.model));
    fields.insert("provider_raw".into(), json!(attribution.provider_raw));
    fields.insert("endpoint_host".into(), Value::Null);
    fields.insert("provider_id".into(), json!(attribution.provider_id));
    fields.insert("route_evidence_id".into(), Value::Null);
    fields.insert("billing_source".into(), json!(attribution.provider_id));
    fields.insert("billing_mode".into(), json!(attribution.billing_mode.as_str()));
    fields.insert("pricing_basis".into(), json!(attribution.pricing_basis));
    fields.insert("evidence_basis".into(), json!(attribution.evidence_basis.as_str()));
    fields.insert("normalization_version".into(), json!("provider-v0.11"));
    fields.insert("attribution_version".into(), json!("provider-v0.11"));
    fields.insert("uncached_input_tokens".into(), json!(uncached));
    fields.insert("cache_read_tokens".into(), json!(u.cached_tokens));
    fields.insert("cache_write_tokens".into(), json!(0));
    fields.insert("output_tokens".into(), json!(u.completion_tokens));
    build_usage_fact(&fields).ok()
}

fn bump(attempts: &mut HashMap<String, i64>, key: &str) {
    *attempts.entry(key.to_string()).or_insert(0) += 1;
}

/// 一个 trace 的全部 generation span → facts / attempts。`session_id = None` 的 trace
/// 全部计 unattributed。
fn emit_trace(
    tr: &TraceSummary,
    machine_namespace: &str,
    source_profile: &str,
    out: &mut UsageFactEmitResult,
) {
    for span in &tr.spans {
        if span.kind != "generation" {
            continue;
        }
        out.total_generation_spans += 1;
        if span.decode_failed {
            // toolOutput 解不开（真机 4 例全是空串）→ unreadable，不是 skip。
            bump(&mut out.attempts, UNREADABLE);
            continue;
        }
        if span.usages.is_empty() {
            // 取消/进行中（toolOutput null）或解码后无 usage → 跳过，不是失败。
            bump(&mut out.attempts, SKIP);
            out.skip_rows += 1;
            continue;
        }
        let Some(sid) = tr.session_id.as_deref() else {
            bump(&mut out.attempts, UNATTRIBUTED);
            continue;
        };
        match span_to_usage_fact(span, sid, machine_namespace, source_profile) {
            Some(f) => out.facts.push(f),
            None => bump(&mut out.attempts, "bad_id"),
        }
    }
}

/// `<workbuddy_root>/traces/**` → `UsageFactEmitResult`。facts 按 trace 文件路径序、
/// span 原序。不写盘。root 不存在 / traces 目录不存在 → Err（CLI exit 2，与其他
/// 执行环境的 usage-facts 同款：源不可读不冒充 0 事实）。
pub fn workbuddy_traces_to_usage_facts(
    root: &Path,
    machine_namespace: &str,
    source_profile: &str,
) -> Result<UsageFactEmitResult, String> {
    if !root.is_dir() {
        return Err(format!("{}: not a directory", root.display()));
    }
    if !super::traces::workbuddy_traces_root(root).is_dir() {
        return Err(format!("{}: no traces/ directory", root.display()));
    }
    let read = read_workbuddy_traces(root);
    let mut out = UsageFactEmitResult {
        facts: Vec::new(),
        workflow_events: Vec::new(),
        attempts: HashMap::new(),
        total_generation_spans: 0,
        skip_rows: 0,
        malformed: read.degraded.len() as i64,
    };
    // 与读取层同一顺序：先归属（按 session 键序、trace 路径序），后未归属。为了
    // 与 Python 的「按文件路径序」逐字节一致，这里重新按路径合并排序。
    let mut all: Vec<&TraceSummary> = read
        .by_session
        .values()
        .flatten()
        .chain(read.unattributed.iter())
        .collect();
    all.sort_by(|a, b| a.path.to_string_lossy().cmp(&b.path.to_string_lossy()));
    for tr in all {
        emit_trace(tr, machine_namespace, source_profile, &mut out);
        out.workflow_events
            .extend(workflow_from_trace(tr, machine_namespace, source_profile));
    }
    Ok(out)
}

#[allow(clippy::items_after_test_module)]
#[cfg(test)]
mod tests {
    use super::{workflow_from_trace, workflow_time};
    use crate::harnesses::workbuddy::sources::traces::{SpanSummary, SpanUsage, TraceSummary};
    use std::path::PathBuf;

    fn span(kind: &str, name: &str, span_id: &str) -> SpanSummary {
        SpanSummary {
            span_id: span_id.to_string(),
            parent_id: None,
            name: name.to_string(),
            kind: kind.to_string(),
            started_at: Some("2026-08-31T09:00:30.123Z".to_string()),
            ended_at: Some("2026-08-31T09:00:31.456Z".to_string()),
            duration_ms: Some(1333),
            status: Some("ok".to_string()),
            error: None,
            tool_name: (kind == "function").then(|| name.to_string()),
            file_path: None,
            usages: Vec::new(),
            agent_name: None,
            decode_failed: false,
        }
    }

    #[test]
    fn workflow_timestamp_keeps_milliseconds() {
        assert_eq!(workflow_time(Some("1970-01-01T00:00:01.234Z")), Some(1234));
        assert_eq!(workflow_time(Some("not-a-time")), None);
    }

    #[test]
    fn trace_workflow_is_redacted_and_has_task_tool_and_model_events() {
        let mut root = span("agent", "cli", "root");
        root.parent_id = None;
        let tool = span("function", "Bash", "tool");
        let mut generation = span("generation", "generation", "generation");
        generation.usages = vec![SpanUsage {
            model: Some("custom-local:secret-model".to_string()),
            prompt_tokens: 1,
            cached_tokens: 0,
            completion_tokens: 1,
            reasoning_tokens: 0,
        }];
        let mut generation2 = span("generation", "generation", "generation-2");
        generation2.usages = vec![SpanUsage {
            model: Some("custom-local:other-model".to_string()),
            prompt_tokens: 1,
            cached_tokens: 0,
            completion_tokens: 1,
            reasoning_tokens: 0,
        }];
        let trace = TraceSummary {
            trace_id: "trace-1".to_string(),
            path: PathBuf::from("/Users/private/trace.json"),
            name: Some("private name".to_string()),
            session_id: Some("s1".to_string()),
            started_at: root.started_at.clone(),
            ended_at: root.ended_at.clone(),
            spans: vec![root, tool, generation, generation2],
            decode_failures: 0,
        };
        let events = workflow_from_trace(&trace, "machine", "default");
        assert!(events.iter().any(|event| event.event_type == "task_started"));
        assert!(events.iter().any(|event| event.event_type == "task_finished"));
        assert!(events.iter().any(|event| event.event_type == "tool_invoked"));
        assert!(events.iter().any(|event| event.event_type == "tool_finished"));
        assert!(events.iter().any(|event| event.event_type == "model_switched"));
        assert!(events.iter().all(|event| event.validate().is_ok()));
        let debug = format!("{events:?}");
        assert!(!debug.contains("/Users/private"));
        assert!(!debug.contains("secret-model"));
    }
}

/// 单个 trace 文件 → `UsageFactEmitResult`（E4b 同步管线的 emit 面）。文件读不了 /
/// 不是 trace 形状 → Err（与 claude/dsh 的逐文件 emitter 同款：sync 把它记进该文件
/// 的 errors、不写指纹、下次重试）。`malformed` 恒 0——单文件路径上「坏文件」就是
/// Err，不是计数。
pub fn workbuddy_trace_file_to_usage_facts(
    path: &Path,
    machine_namespace: &str,
    source_profile: &str,
) -> Result<UsageFactEmitResult, String> {
    let tr = read_workbuddy_trace_file(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = UsageFactEmitResult {
        facts: Vec::new(),
        workflow_events: Vec::new(),
        attempts: HashMap::new(),
        total_generation_spans: 0,
        skip_rows: 0,
        malformed: 0,
    };
    emit_trace(&tr, machine_namespace, source_profile, &mut out);
    out.workflow_events = workflow_from_trace(&tr, machine_namespace, source_profile);
    Ok(out)
}

/// `--json` 载荷，键序 = Python handler 的 dict 序。
pub fn to_payload_value(
    result: &UsageFactEmitResult,
    machine_namespace: &str,
    source_profile: &str,
) -> Value {
    let mut out = Map::new();
    out.insert("machine_namespace".into(), json!(machine_namespace));
    out.insert("source_profile".into(), json!(source_profile));
    out.insert("facts".into(), json!(result.facts));
    let mut attempts_obj = Map::new();
    for k in [SKIP, UNREADABLE, UNATTRIBUTED] {
        attempts_obj.insert(k.into(), json!(result.attempts.get(k).copied().unwrap_or(0)));
    }
    if result.attempts.get("bad_id").is_some_and(|v| *v > 0) {
        attempts_obj.insert("bad_id".into(), json!(result.attempts["bad_id"]));
    }
    out.insert("attempts".into(), Value::Object(attempts_obj));
    let mut cov = Map::new();
    cov.insert("total_generation_spans".into(), json!(result.total_generation_spans));
    cov.insert("fact_rows".into(), json!(result.facts.len()));
    cov.insert("skip_rows".into(), json!(result.skip_rows));
    out.insert("coverage".into(), Value::Object(cov));
    out.insert("malformed".into(), json!(result.malformed));
    Value::Object(out)
}

/// 人读摘要，逐行镜像 Python handler 的 print。
pub fn to_human_summary(
    result: &UsageFactEmitResult,
    root: &Path,
    machine_namespace: &str,
    source_profile: &str,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    for k in [SKIP, UNREADABLE, UNATTRIBUTED] {
        parts.push(format!("'{}': {}", k, result.attempts.get(k).copied().unwrap_or(0)));
    }
    if result.attempts.get("bad_id").is_some_and(|v| *v > 0) {
        parts.push(format!("'bad_id': {}", result.attempts["bad_id"]));
    }
    format!(
        "Source: {}\nMachine namespace: {}\nSource profile: {}\nFacts: {} \
         (total_generation_spans={}, skip={})\nAttempts: {{{}}}\n",
        root.display(),
        machine_namespace,
        source_profile,
        result.facts.len(),
        result.total_generation_spans,
        result.skip_rows,
        parts.join(", "),
    )
}
