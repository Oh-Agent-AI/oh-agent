//! Descriptor-scoped, application-neutral typed data reads for built-in plugins.
//!
//! This endpoint exposes only fixed typed dataset DTO versions. Callers cannot
//! name tables, provide SQL/JSON paths, choose arbitrary filters, or access logs.
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{collections::BTreeSet, path::Path};

const DATASET: &str = "harness-sessions:v1";
const DATASET_V2: &str = "harness-sessions:v2";
const DATASET_V3: &str = "harness-sessions:v3";
const DATASET_V4: &str = "harness-sessions:v4";
const DATASET_V5: &str = "harness-sessions:v5";
const SESSION_IDENTITIES_V1: &str = "harness-session-identities:v1";
const USAGE_SUMMARY_V1: &str = "usage-summary:v1";
const ACTIVITY_SUMMARY_V1: &str = "activity-summary:v1";
const MODEL_USAGE_V1: &str = "model-usage:v1";
const TIME_COVERAGE_V1: &str = "time-coverage:v1";
const FINDING_SUMMARY_V1: &str = "finding-summary:v1";
const SKILL_USAGE_V1: &str = "skill-usage-summary:v1";
const WORKFLOW_ACTIVITY_V1: &str = "workflow-activity-summary:v1";
const SESSION_DETAIL_V1: &str = "harness-session-detail:v1";
const SESSION_EXCERPTS_V1: &str = "session-excerpts:v1";
const SESSION_COST_V1: &str = "session-cost:v1";
const SESSION_SOURCE_STATUS_V1: &str = "session-source-status:v1";
const CITY_LEGACY_STORE_V1: &str = "city-legacy-store:v1";
const CITY_ASSET_CROSSWALK_V1: &str = "city-asset-crosswalk:v1";
const MAX_ROWS: usize = 500;
const MAX_TOTAL_ROWS: usize = 4_000;
const MAX_SESSION_CATALOG_ROWS: usize = 100_000;
const MAX_BYTES: usize = 256 * 1024;
const FIELDS: &[&str] = &[
    "session.id",
    "session.harness_id",
    "session.first_event_at_ms",
    "session.last_event_at_ms",
    "session.event_count",
    "session.tokens.input",
    "session.tokens.output",
    "session.tokens.total",
];
const FIELDS_V3: &[&str] = &[
    "session.id", "session.harness_id", "session.title", "session.title_source",
    "session.window_first_event_at_ms", "session.window_last_event_at_ms", "session.window_order",
    "session.lifetime_first_event_at_ms", "session.lifetime_last_event_at_ms",
    "session.event_count", "session.tokens.input", "session.tokens.output", "session.tokens.total",
    "session.tokens.uncached_input", "session.tokens.cache_read", "session.tokens.cache_write",
    "session.model_ids", "session.model_coverage",
];
const FIELDS_V4: &[&str] = &[
    "session.id", "session.harness_id", "session.title", "session.title_source",
    "session.window_first_event_at_ms", "session.window_last_event_at_ms", "session.window_order",
    "session.lifetime_first_event_at_ms", "session.lifetime_last_event_at_ms",
    "session.event_count", "session.tokens.input", "session.tokens.output", "session.tokens.total",
    "session.tokens.uncached_input", "session.tokens.cache_read", "session.tokens.cache_write",
    "session.model_ids", "session.model_coverage", "session.stable_ref",
];
const FIELDS_V5: &[&str] = &[
    "session.id", "session.harness_id", "session.title", "session.title_source",
    "session.lifetime_first_event_at_ms", "session.lifetime_last_event_at_ms",
    "session.event_count", "session.tokens.input", "session.tokens.output", "session.tokens.total",
    "session.tokens.uncached_input", "session.tokens.cache_read", "session.tokens.cache_write",
    "session.model_ids", "session.model_coverage", "session.stable_ref",
];
const SESSION_IDENTITY_FIELDS: &[&str] = &["session.id", "session.stable_ref"];
const USAGE_SUMMARY_FIELDS: &[&str] = &[
    "summary.session_count", "summary.usage_event_count", "summary.tokens.input",
    "summary.tokens.output", "summary.tokens.total", "summary.tokens.uncached_input",
    "summary.tokens.cache_read", "summary.tokens.cache_write",
];
const ACTIVITY_SUMMARY_FIELDS: &[&str] = &[
    "activity.date", "activity.session_count", "activity.event_count", "activity.tokens",
];
const MODEL_USAGE_FIELDS: &[&str] = &[
    "model.model_id", "model.usage_event_count", "model.legacy_usage_event_count",
    "model.tokens.input", "model.tokens.output", "model.tokens.total",
    "model.tokens.uncached_input", "model.tokens.cache_read", "model.tokens.cache_write",
    "coverage.unknown_model_usage_events", "coverage.legacy_usage_events", "scope", "pricing_independent",
];
const TIME_COVERAGE_FIELDS: &[&str] = &[
    "coverage.scope", "coverage.unknown_time_only", "coverage.mixed_time", "coverage.excluded_no_usage",
];
const FINDING_SUMMARY_FIELDS: &[&str] = &[
    "findings.current_backlog.harness_id", "findings.current_backlog.severity", "findings.current_backlog.count",
    "findings.window_new.harness_id", "findings.window_new.severity", "findings.window_new.count",
    "capabilities.harness_id", "capabilities.available", "capabilities.reason",
];
const SKILL_USAGE_FIELDS: &[&str] = &["skill.harness_id", "skill.label", "skill.invocations", "skill.sessions",
    "skill.last_invoked_at_ms", "skill.finished_events", "skill.failed_events", "skill.succeeded_events"];
const WORKFLOW_ACTIVITY_FIELDS: &[&str] = &["event.harness_id", "event.event_type", "event.count", "event.sessions",
    "event.last_event_at_ms", "event.failed_events"];
const SESSION_DETAIL_FIELDS: &[&str] = &["session.id", "session.harness_id", "session.title", "session.title_source",
    "session.first_event_at", "session.last_event_at", "session.window_first_event_at", "session.window_last_event_at",
    "session.lifetime_first_event_at", "session.lifetime_last_event_at", "session.event_count", "session.tokens.input",
    "session.tokens.output", "session.tokens.total", "session.tokens.uncached_input", "session.tokens.cache_read",
    "session.tokens.cache_write", "session.model_ids", "session.model_coverage"];
const SESSION_EXCERPT_FIELDS: &[&str] = &["excerpt.role", "excerpt.text", "excerpt.provenance", "excerpt.is_excerpt",
    "excerpt.scope", "excerpt.excerpt_at"];
const SESSION_COST_FIELDS: &[&str] = &["cost.status", "cost.reason", "cost.has_unresolved", "cost.complete", "cost.cost_minor",
    "cost.coverage", "cost.pricing_versions", "cost.reference_prices", "cost.pricing_sources", "cost.breakdown"];
const SESSION_SOURCE_STATUS_FIELDS: &[&str] = &["source.stable_ref", "source.state", "source.has_usage_in_window"];

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TypedDataGrant {
    pub fields: Vec<String>,
    #[serde(default)]
    pub window_days: Vec<u16>,
    pub max_rows: usize,
    #[serde(default = "default_max_total_rows")]
    pub max_total_rows: usize,
    pub max_bytes: usize,
}

/// One-time, bounded export of City's legacy asset/building stores for a
/// resumable local migration. This is a source DTO grant, not a City projection.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyExportGrant {
    pub max_rows: usize,
    pub max_bytes: usize,
}

impl LegacyExportGrant {
    pub(crate) fn is_valid(&self, dataset_id: &str) -> bool {
        ((dataset_id == CITY_LEGACY_STORE_V1 && (1..=500).contains(&self.max_rows))
            || (dataset_id == CITY_ASSET_CROSSWALK_V1 && (1..=4_000).contains(&self.max_rows)))
            && (1024..=1024 * 1024).contains(&self.max_bytes)
    }
}

fn read_city_asset_crosswalk(
    grants: &std::collections::BTreeMap<String, LegacyExportGrant>,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
) -> Result<Value, &'static str> {
    if !exact_keys(payload, &["dataset", "version", "assetRefs", "sourceRevision", "dataRevision"])
        || payload["dataset"].as_str() != Some("city-asset-crosswalk")
        || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let grant = grants.get(CITY_ASSET_CROSSWALK_V1)
        .filter(|grant| grant.is_valid(CITY_ASSET_CROSSWALK_V1)).ok_or("typed_data_denied")?;
    let asset_refs = payload["assetRefs"].as_array()
        .filter(|refs| !refs.is_empty() && refs.len() <= grant.max_rows)
        .ok_or("typed_data_query_denied")?.iter()
        .map(|value| value.as_str().map(str::to_owned).ok_or("typed_data_invalid_request"))
        .collect::<Result<Vec<_>, _>>()?;
    let source_revision = payload["sourceRevision"].as_str()
        .filter(|value| value.len() == 129 && value.as_bytes()[64] == b'.'
            && value.bytes().enumerate().all(|(index, byte)| index == 64 || byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        .ok_or("typed_data_invalid_request")?;
    let data_revision = current_revision(home, payload["dataRevision"].clone())?;
    let result = agent_vitals_runtime::query::city_assets::legacy_asset_crosswalk(
        home, plugin_id, &asset_refs, source_revision, data_revision,
    )?;
    bounded_result(result, grant.max_bytes)
}

pub(crate) fn read_legacy_city_store_for_plugin(
    grants: &std::collections::BTreeMap<String, LegacyExportGrant>,
    home: &Path,
    payload: &Value,
) -> Result<Value, &'static str> {
    if !(exact_keys(payload, &["dataset", "version", "cursor", "limit"])
        || exact_keys(payload, &["dataset", "version", "cursor", "limit", "source"]))
        || payload["dataset"].as_str() != Some("city-legacy-store")
        || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let grant = grants.get(CITY_LEGACY_STORE_V1)
        .filter(|grant| grant.is_valid(CITY_LEGACY_STORE_V1))
        .ok_or("typed_data_denied")?;
    let cursor = match &payload["cursor"] {
        Value::Null => None,
        Value::String(value) if value.len() <= 180 => Some(value.as_str()),
        _ => return Err("typed_data_invalid_request"),
    };
    let limit = payload["limit"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=grant.max_rows).contains(value)).ok_or("typed_data_query_denied")?;
    let page = if let Some(source) = payload.get("source").and_then(Value::as_str) {
        agent_vitals_runtime::query::city_assets::legacy_export_dataset_page(home, source, cursor, limit)?
    } else if payload.get("source").is_some() {
        return Err("typed_data_invalid_request");
    } else {
        agent_vitals_runtime::query::city_assets::legacy_export_page(home, cursor, limit)?
    };
    let result = serde_json::to_value(page).map_err(|_| "typed_data_source_invalid")?;
    if serde_json::to_vec(&result).map_err(|_| "typed_data_source_invalid")?.len() > grant.max_bytes {
        return Err("typed_data_too_large");
    }
    Ok(result)
}

/// Single typed-data service entry point for the authenticated plugin host.
/// The host passes descriptor grants but does not branch on a dataset's source
/// or know City migration details.
pub(crate) fn read_authorized_for_plugin(
    grants: &std::collections::BTreeMap<String, TypedDataGrant>,
    legacy_grants: &std::collections::BTreeMap<String, LegacyExportGrant>,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() == Some("city-asset-crosswalk") {
        return read_city_asset_crosswalk(legacy_grants, home, plugin_id, payload);
    }
    if payload["dataset"].as_str() == Some("city-legacy-store") {
        read_legacy_city_store_for_plugin(legacy_grants, home, payload)
    } else {
        read_for_plugin(grants, home, plugin_id, payload)
    }
}

fn default_max_total_rows() -> usize { MAX_ROWS }

impl TypedDataGrant {
    pub(crate) fn is_valid(&self, dataset_id: &str) -> bool {
        let allowed_fields = match dataset_id {
            DATASET | DATASET_V2 => FIELDS,
            DATASET_V3 => FIELDS_V3,
            DATASET_V4 => FIELDS_V4,
            DATASET_V5 => FIELDS_V5,
            SESSION_IDENTITIES_V1 => SESSION_IDENTITY_FIELDS,
            USAGE_SUMMARY_V1 => USAGE_SUMMARY_FIELDS,
            ACTIVITY_SUMMARY_V1 => ACTIVITY_SUMMARY_FIELDS,
            MODEL_USAGE_V1 => MODEL_USAGE_FIELDS,
            TIME_COVERAGE_V1 => TIME_COVERAGE_FIELDS,
            FINDING_SUMMARY_V1 => FINDING_SUMMARY_FIELDS,
            SKILL_USAGE_V1 => SKILL_USAGE_FIELDS,
            WORKFLOW_ACTIVITY_V1 => WORKFLOW_ACTIVITY_FIELDS,
            SESSION_DETAIL_V1 => SESSION_DETAIL_FIELDS,
            SESSION_EXCERPTS_V1 => SESSION_EXCERPT_FIELDS,
            SESSION_COST_V1 => SESSION_COST_FIELDS,
            SESSION_SOURCE_STATUS_V1 => SESSION_SOURCE_STATUS_FIELDS,
            _ => return false,
        };
        if dataset_id == SESSION_IDENTITIES_V1 || dataset_id == DATASET_V5 {
            let fields = if dataset_id == SESSION_IDENTITIES_V1 { SESSION_IDENTITY_FIELDS } else { FIELDS_V5 };
            return !self.fields.is_empty()
                && (dataset_id != SESSION_IDENTITIES_V1 || self.fields.len() == SESSION_IDENTITY_FIELDS.len())
                && self.fields.len() <= fields.len()
                && self.fields.iter().all(|field| fields.contains(&field.as_str()))
                && self.fields.iter().collect::<BTreeSet<_>>().len() == self.fields.len()
                && self.window_days.is_empty()
                && (1..=500).contains(&self.max_rows)
                && (self.max_rows..=MAX_SESSION_CATALOG_ROWS).contains(&self.max_total_rows)
                && (1024..=MAX_BYTES).contains(&self.max_bytes);
        }
        (dataset_id == DATASET || dataset_id == DATASET_V2 || dataset_id == DATASET_V3 || dataset_id == DATASET_V4
            || dataset_id == USAGE_SUMMARY_V1 || dataset_id == ACTIVITY_SUMMARY_V1
            || dataset_id == MODEL_USAGE_V1 || dataset_id == TIME_COVERAGE_V1 || dataset_id == FINDING_SUMMARY_V1
            || dataset_id == SKILL_USAGE_V1 || dataset_id == WORKFLOW_ACTIVITY_V1
            || dataset_id == SESSION_DETAIL_V1 || dataset_id == SESSION_EXCERPTS_V1 || dataset_id == SESSION_COST_V1
            || dataset_id == SESSION_SOURCE_STATUS_V1)
            && !self.fields.is_empty()
            && self.fields.len() <= allowed_fields.len()
            && self.fields.iter().all(|field| allowed_fields.contains(&field.as_str()))
            && self.fields.iter().collect::<BTreeSet<_>>().len() == self.fields.len()
            && !self.window_days.is_empty()
            && self.window_days.len() <= 4
            && self.window_days.iter().all(|days| matches!(days, 7 | 30 | 90 | 366))
            && self.window_days.iter().collect::<BTreeSet<_>>().len() == self.window_days.len()
            && (1..=MAX_ROWS).contains(&self.max_rows)
            && (self.max_rows..=if dataset_id == DATASET_V2 || dataset_id == DATASET_V3 || dataset_id == DATASET_V4 { MAX_TOTAL_ROWS } else { MAX_ROWS })
                .contains(&self.max_total_rows)
            && (1024..=MAX_BYTES).contains(&self.max_bytes)
    }
}

fn read_session_identities(
    grant: &TypedDataGrant,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("harness-session-identities")
        || payload["version"].as_u64() != Some(1)
        || !exact_keys(payload, &["dataset", "version", "fields", "query"]) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array()
        .filter(|fields| !fields.is_empty() && fields.len() <= SESSION_IDENTITY_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let mut selected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str().ok_or("typed_data_invalid_request")?;
        if !SESSION_IDENTITY_FIELDS.contains(&field) || !grant.fields.iter().any(|allowed| allowed == field) {
            return Err("typed_data_field_denied");
        }
        if selected.iter().any(|existing| existing == field) { return Err("typed_data_invalid_request"); }
        selected.push(field.to_owned());
    }
    let query = &payload["query"];
    if !exact_keys(query, &["offset", "limit", "dataRevision"]) { return Err("typed_data_invalid_request"); }
    let offset = query["offset"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= grant.max_total_rows).ok_or("typed_data_query_denied")?;
    let limit = query["limit"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=grant.max_rows).contains(value)).ok_or("typed_data_query_denied")?;
    if offset.saturating_add(limit) > grant.max_total_rows
        || (offset > 0 && query["dataRevision"].is_null()) {
        return Err("typed_data_query_denied");
    }
    let revision = agent_vitals_runtime::query::app_harnesses::list(home)?["data_revision"]
        .as_u64().ok_or("data_unavailable")?;
    if !query["dataRevision"].is_null() && query["dataRevision"].as_u64() != Some(revision) {
        return Err("revision_changed");
    }
    let source = agent_vitals_runtime::query::app_harnesses::session_identity_page(
        home, revision, plugin_id, offset, limit,
    )?;
    let rows = source["sessions"].as_array().ok_or("typed_data_source_invalid")?;
    let sessions = rows.iter().map(|row| {
        let mut out = Map::new();
        if selected.iter().any(|field| field == "session.id") {
            out.insert("id".to_owned(), row["id"].clone());
        }
        if selected.iter().any(|field| field == "session.stable_ref") {
            out.insert("stable_ref".to_owned(), row["stable_ref"].clone());
        }
        Value::Object(out)
    }).collect::<Vec<_>>();
    let total = source["total"].as_u64().ok_or("typed_data_source_invalid")?;
    bounded_result(json!({
        "schema":SESSION_IDENTITIES_V1,
        "dataRevision":revision,
        "pagination":{"offset":offset,"limit":limit},
        "coverage":{"total":total,"returned":sessions.len(),
            "truncated":total>(offset as u64).saturating_add(sessions.len() as u64)},
        "sessions":sessions
    }), grant.max_bytes)
}

fn read_sessions_lifetime(
    grant: &TypedDataGrant,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("harness-sessions")
        || payload["version"].as_u64() != Some(5)
        || !exact_keys(payload, &["dataset", "version", "fields", "query"]) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array()
        .filter(|fields| !fields.is_empty() && fields.len() <= FIELDS_V5.len())
        .ok_or("typed_data_invalid_request")?;
    let selected = validate_fields(fields, FIELDS_V5, &grant.fields)?;
    let query = &payload["query"];
    if !exact_keys(query, &["offset", "limit", "dataRevision"]) { return Err("typed_data_invalid_request"); }
    let offset = query["offset"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= grant.max_total_rows).ok_or("typed_data_query_denied")?;
    let limit = query["limit"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=grant.max_rows).contains(value)).ok_or("typed_data_query_denied")?;
    if offset.saturating_add(limit) > grant.max_total_rows || (offset > 0 && query["dataRevision"].is_null()) {
        return Err("typed_data_query_denied");
    }
    let revision = current_revision(home, query["dataRevision"].clone())?;
    let source = agent_vitals_runtime::query::app_harnesses::sessions_lifetime_page(
        home, revision, plugin_id, offset, limit,
    )?;
    let rows = source["sessions"].as_array().ok_or("typed_data_source_invalid")?;
    let output_rows = rows.iter().map(|row| project_session_v3(row, &selected)).collect::<Result<Vec<_>, _>>()?;
    let total = source["total"].as_u64().ok_or("typed_data_source_invalid")?;
    bounded_result(json!({
        "schema":DATASET_V5,
        "dataRevision":revision,
        "harnessId":Value::Null,
        "pagination":{"offset":offset,"limit":limit},
        "coverage":{"total":total,"returned":output_rows.len(),
            "truncated":total>(offset as u64).saturating_add(output_rows.len() as u64)},
        "sessions":output_rows
    }), grant.max_bytes)
}

fn read_usage_summary(
    grant: &TypedDataGrant,
    home: &Path,
    payload: &Value,
) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("usage-summary") || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= USAGE_SUMMARY_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let mut selected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str().ok_or("typed_data_invalid_request")?;
        if !USAGE_SUMMARY_FIELDS.contains(&field) || !grant.fields.iter().any(|allowed| allowed == field) {
            return Err("typed_data_field_denied");
        }
        if selected.iter().any(|existing| existing == field) { return Err("typed_data_invalid_request"); }
        selected.push(field.to_owned());
    }
    let query = &payload["query"];
    if !exact_keys(query, &["windowDays", "toMs", "dataRevision"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() {
        return Err("typed_data_invalid_request");
    }
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let index = agent_vitals_runtime::query::app_harnesses::list(home)?;
    let current_revision = index["data_revision"].as_u64().ok_or("data_unavailable")?;
    let revision = if query["dataRevision"].is_null() { current_revision }
        else { query["dataRevision"].as_u64().filter(|value| *value == current_revision).ok_or("revision_changed")? };
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = agent_vitals_runtime::query::app_harnesses::usage_summary(home, days, to_ms, revision)?;
    let summary = &source["summary"];
    let mut projected = Map::new();
    for field in selected {
        let value = match field.as_str() {
            "summary.session_count" => summary.get("session_count"),
            "summary.usage_event_count" => summary.get("usage_event_count"),
            "summary.tokens.input" => summary.get("tokens").and_then(|tokens| tokens.get("input")),
            "summary.tokens.output" => summary.get("tokens").and_then(|tokens| tokens.get("output")),
            "summary.tokens.total" => summary.get("tokens").and_then(|tokens| tokens.get("total")),
            "summary.tokens.uncached_input" => summary.get("tokens").and_then(|tokens| tokens.get("uncached_input")),
            "summary.tokens.cache_read" => summary.get("tokens").and_then(|tokens| tokens.get("cache_read")),
            "summary.tokens.cache_write" => summary.get("tokens").and_then(|tokens| tokens.get("cache_write")),
            _ => return Err("typed_data_field_denied"),
        }.ok_or("typed_data_source_invalid")?;
        set_nested(&mut projected, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
    }
    bounded_result(json!({
        "schema":USAGE_SUMMARY_V1,
        "dataRevision":revision,
        "windowDays":days,
        "window":{"fromMs":source["window"]["from_ms"],"toMs":source["window"]["to_ms"]},
        "summary":projected
    }), grant.max_bytes)
}

fn read_activity_summary(
    grant: &TypedDataGrant,
    home: &Path,
    payload: &Value,
) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("activity-summary") || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= ACTIVITY_SUMMARY_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let mut selected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str().ok_or("typed_data_invalid_request")?;
        if !ACTIVITY_SUMMARY_FIELDS.contains(&field) || !grant.fields.iter().any(|allowed| allowed == field) {
            return Err("typed_data_field_denied");
        }
        if selected.iter().any(|existing| existing == field) { return Err("typed_data_invalid_request"); }
        selected.push(field.to_owned());
    }
    let query = &payload["query"];
    if !exact_keys(query, &["windowDays", "timezone", "toMs", "dataRevision"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() {
        return Err("typed_data_invalid_request");
    }
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let timezone = query["timezone"].as_str().filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or("typed_data_invalid_request")?;
    let index = agent_vitals_runtime::query::app_harnesses::list(home)?;
    let current_revision = index["data_revision"].as_u64().ok_or("data_unavailable")?;
    let revision = if query["dataRevision"].is_null() { current_revision }
        else { query["dataRevision"].as_u64().filter(|value| *value == current_revision).ok_or("revision_changed")? };
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = agent_vitals_runtime::query::app_harnesses::activity_summary(home, days, timezone, to_ms, revision)?;
    let source_days = source["days"].as_array().ok_or("typed_data_source_invalid")?;
    if source_days.len() > grant.max_rows { return Err("typed_data_too_large"); }
    let output_days = source_days.iter().map(|day| {
        let mut projected = Map::new();
        for field in &selected {
            let value = match field.as_str() {
                "activity.date" => day.get("date"),
                "activity.session_count" => day.get("session_count"),
                "activity.event_count" => day.get("event_count"),
                "activity.tokens" => day.get("tokens"),
                _ => return Err("typed_data_field_denied"),
            }.ok_or("typed_data_source_invalid")?;
            set_nested(&mut projected, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
        }
        Ok(Value::Object(projected))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    bounded_result(json!({
        "schema":ACTIVITY_SUMMARY_V1,
        "dataRevision":revision,
        "windowDays":days,
        "window":{"fromMs":source["window"]["from_ms"],"toMs":source["window"]["to_ms"]},
        "timezone":source["timezone"],
        "days":output_days
    }), grant.max_bytes)
}

fn read_model_usage(
    grant: &TypedDataGrant,
    home: &Path,
    payload: &Value,
) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("model-usage") || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= MODEL_USAGE_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let selected = validate_fields(fields, MODEL_USAGE_FIELDS, &grant.fields)?;
    let query = &payload["query"];
    if !exact_keys(query, &["windowDays", "toMs", "dataRevision"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() {
        return Err("typed_data_invalid_request");
    }
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let revision = current_revision(home, query["dataRevision"].clone())?;
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = agent_vitals_runtime::query::app_harnesses::model_usage_summary(home, days, to_ms, revision)?;
    let models = source["models"].as_array().ok_or("typed_data_source_invalid")?;
    if models.len() > grant.max_rows { return Err("typed_data_too_large"); }
    let output_models = models.iter().map(|model| {
        let mut projected = Map::new();
        for field in &selected {
            if !field.starts_with("model.") { continue; }
            let value = match field.as_str() {
                "model.model_id" => model.get("model_id"),
                "model.usage_event_count" => model.get("usage_event_count"),
                "model.legacy_usage_event_count" => model.get("legacy_usage_event_count"),
                "model.tokens.input" => model.get("tokens").and_then(|tokens| tokens.get("input")),
                "model.tokens.output" => model.get("tokens").and_then(|tokens| tokens.get("output")),
                "model.tokens.total" => model.get("tokens").and_then(|tokens| tokens.get("total")),
                "model.tokens.uncached_input" => model.get("tokens").and_then(|tokens| tokens.get("uncached_input")),
                "model.tokens.cache_read" => model.get("tokens").and_then(|tokens| tokens.get("cache_read")),
                "model.tokens.cache_write" => model.get("tokens").and_then(|tokens| tokens.get("cache_write")),
                _ => return Err("typed_data_field_denied"),
            }.ok_or("typed_data_source_invalid")?;
            set_nested(&mut projected, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
        }
        Ok(Value::Object(projected))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    let mut coverage = Map::new();
    for field in &selected {
        let value = match field.as_str() {
            "coverage.unknown_model_usage_events" => source["coverage"].get("unknown_model_usage_events"),
            "coverage.legacy_usage_events" => source["coverage"].get("legacy_usage_events"),
            "scope" => source.get("scope"),
            "pricing_independent" => source.get("pricing_independent"),
            _ => continue,
        }.ok_or("typed_data_source_invalid")?;
        if field.starts_with("coverage.") {
            set_nested(&mut coverage, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
        }
    }
    let mut result = json!({
        "schema":MODEL_USAGE_V1,"dataRevision":revision,"windowDays":days,
        "window":{"fromMs":source["window"]["from_ms"],"toMs":source["window"]["to_ms"]},
        "models":output_models,"coverage":coverage
    });
    let object = result.as_object_mut().ok_or("typed_data_source_invalid")?;
    if selected.iter().any(|field| field == "scope") { object.insert("scope".into(), source["scope"].clone()); }
    if selected.iter().any(|field| field == "pricing_independent") {
        object.insert("pricingIndependent".into(), source["pricing_independent"].clone());
    }
    bounded_result(result, grant.max_bytes)
}

fn read_time_coverage(grant: &TypedDataGrant, home: &Path, payload: &Value) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("time-coverage") || payload["version"].as_u64() != Some(1)
        || !exact_keys(&payload["query"], &["dataRevision"]) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= TIME_COVERAGE_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let selected = validate_fields(fields, TIME_COVERAGE_FIELDS, &grant.fields)?;
    let revision = current_revision(home, payload["query"]["dataRevision"].clone())?;
    let source = agent_vitals_runtime::query::app_harnesses::time_coverage(home, revision)?;
    let mut coverage = Map::new();
    for field in selected {
        let value = match field.as_str() {
            "coverage.scope" => source.get("scope"),
            "coverage.unknown_time_only" => source.get("unknown_time_only"),
            "coverage.mixed_time" => source.get("mixed_time"),
            "coverage.excluded_no_usage" => source.get("excluded_no_usage"),
            _ => return Err("typed_data_field_denied"),
        }.ok_or("typed_data_source_invalid")?;
        set_nested(&mut coverage, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
    }
    bounded_result(json!({"schema":TIME_COVERAGE_V1,"dataRevision":revision,"coverage":coverage}), grant.max_bytes)
}

fn read_finding_summary(grant: &TypedDataGrant, home: &Path, payload: &Value) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("finding-summary") || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= FINDING_SUMMARY_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let selected = validate_fields(fields, FINDING_SUMMARY_FIELDS, &grant.fields)?;
    let query = &payload["query"];
    if !exact_keys(query, &["windowDays", "toMs", "dataRevision"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() {
        return Err("typed_data_invalid_request");
    }
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let revision = current_revision(home, query["dataRevision"].clone())?;
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = agent_vitals_runtime::query::app_harnesses::finding_summary(home, days, to_ms, revision)?;
    let project_rows = |array: &str, prefix: &str| -> Result<Vec<Value>, &'static str> {
        let source_rows = source[array].as_array().ok_or("typed_data_source_invalid")?;
        if source_rows.len() > grant.max_rows { return Err("typed_data_too_large"); }
        source_rows.iter().map(|row| {
            let mut projected = Map::new();
            for field in &selected {
                let Some(rest) = field.strip_prefix(prefix) else { continue; };
                let key = rest.rsplit('.').next().ok_or("typed_data_field_denied")?;
                let value = row.get(key).ok_or("typed_data_source_invalid")?;
                set_nested(&mut projected, &rest.split('.').collect::<Vec<_>>(), value.clone())?;
            }
            Ok(Value::Object(projected))
        }).collect()
    };
    let project_capabilities = || -> Result<Vec<Value>, &'static str> {
        let rows = source["capabilities"].as_array().ok_or("typed_data_source_invalid")?;
        if rows.len() > grant.max_rows { return Err("typed_data_too_large"); }
        rows.iter().map(|row| {
            let mut projected = Map::new();
            for field in &selected {
                let Some(rest) = field.strip_prefix("capabilities.") else { continue; };
                let key = rest.rsplit('.').next().ok_or("typed_data_field_denied")?;
                let value = row.get(key).ok_or("typed_data_source_invalid")?;
                set_nested(&mut projected, &rest.split('.').collect::<Vec<_>>(), value.clone())?;
            }
            Ok(Value::Object(projected))
        }).collect()
    };
    bounded_result(json!({
        "schema":FINDING_SUMMARY_V1,"dataRevision":revision,"windowDays":days,
        "window":{"fromMs":source["window"]["from_ms"],"toMs":source["window"]["to_ms"]},
        "current_backlog":project_rows("current_backlog", "findings.current_backlog.")?,
        "window_new":project_rows("window_new", "findings.window_new.")?,
        "capabilities":project_capabilities()?
    }), grant.max_bytes)
}

fn read_skill_or_workflow(grant: &TypedDataGrant, home: &Path, payload: &Value, skills: bool) -> Result<Value, &'static str> {
    let (dataset, schema, allowed, source_key, prefix) = if skills {
        ("skill-usage-summary", SKILL_USAGE_V1, SKILL_USAGE_FIELDS, "skills", "skill.")
    } else {
        ("workflow-activity-summary", WORKFLOW_ACTIVITY_V1, WORKFLOW_ACTIVITY_FIELDS, "events", "event.")
    };
    if payload["dataset"].as_str() != Some(dataset) || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= allowed.len())
        .ok_or("typed_data_invalid_request")?;
    let selected = validate_fields(fields, allowed, &grant.fields)?;
    let query = &payload["query"];
    if !exact_keys(query, &["windowDays", "toMs", "dataRevision"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() { return Err("typed_data_invalid_request"); }
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let revision = current_revision(home, query["dataRevision"].clone())?;
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = if skills {
        agent_vitals_runtime::query::app_harnesses::skill_usage_summary(home, days, to_ms, revision)?
    } else {
        agent_vitals_runtime::query::app_harnesses::workflow_activity_summary(home, days, to_ms, revision)?
    };
    let rows = source[source_key].as_array().ok_or("typed_data_source_invalid")?;
    if rows.len() > grant.max_rows { return Err("typed_data_too_large"); }
    let output = rows.iter().map(|row| {
        let mut projected = Map::new();
        for field in &selected {
            let Some(key) = field.strip_prefix(prefix) else { continue; };
            let source_key = match key {
                "harness_id" => "harness",
                "label" => "skill",
                "count" => "events",
                "failed_events" if !skills => "failed_events",
                value => value,
            };
            let value = row.get(source_key).ok_or("typed_data_source_invalid")?;
            projected.insert(key.to_owned(), value.clone());
        }
        Ok(Value::Object(projected))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    let mut response = json!({"schema":schema,"dataRevision":revision,"windowDays":days,
        "window":{"fromMs":source["window"]["from_ms"],"toMs":source["window"]["to_ms"]},source_key:output,
        "truncated":source["truncated"],"coverage":source["coverage"],"outcomeScope":source["outcome_scope"]});
    if skills { response["inventoryIncluded"] = source["inventory_included"].clone(); }
    bounded_result(response, grant.max_bytes)
}

fn read_session_detail(grant: &TypedDataGrant, excerpt_grant: Option<&TypedDataGrant>, home: &Path,
    plugin_id: &str, payload: &Value, excerpts: bool) -> Result<Value, &'static str> {
    let (dataset, schema, allowed) = if excerpts {
        ("session-excerpts", SESSION_EXCERPTS_V1, SESSION_EXCERPT_FIELDS)
    } else { ("harness-session-detail", SESSION_DETAIL_V1, SESSION_DETAIL_FIELDS) };
    if payload["dataset"].as_str() != Some(dataset) || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= allowed.len())
        .ok_or("typed_data_invalid_request")?;
    let selected = validate_fields(fields, allowed, &grant.fields)?;
    let query = &payload["query"];
    if !exact_keys(query, &["sessionRef", "windowDays", "toMs", "dataRevision"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() { return Err("typed_data_invalid_request"); }
    let handle = query["sessionRef"].as_str().filter(|value| value.len() == 35 && value.starts_with("sr_")
        && value[3..].bytes().all(|byte| byte.is_ascii_hexdigit())).ok_or("typed_data_invalid_request")?;
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let revision = current_revision(home, query["dataRevision"].clone())?;
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    if excerpts && excerpt_grant.is_none() { return Err("typed_data_denied"); }
    let source = agent_vitals_runtime::query::app_harnesses::session_detail(home, plugin_id, handle, days, to_ms,
        revision, excerpts)?;
    let mut projected = Map::new();
    if excerpts {
        let excerpt_grant = excerpt_grant.filter(|grant| grant.is_valid(SESSION_EXCERPTS_V1)).ok_or("typed_data_denied")?;
        let rows = source["session"]["excerpts"].as_array().ok_or("typed_data_source_invalid")?;
        if rows.len() > excerpt_grant.max_rows { return Err("typed_data_too_large"); }
        let output = rows.iter().map(|row| {
            let mut item = Map::new();
            for field in &selected {
                let key = field.strip_prefix("excerpt.").ok_or("typed_data_field_denied")?;
                let value = row.get(key).ok_or("typed_data_source_invalid")?;
                item.insert(key.to_owned(), value.clone());
            }
            Ok(Value::Object(item))
        }).collect::<Result<Vec<_>, &'static str>>()?;
        projected.insert("excerpts".into(), json!(output));
        projected.insert("excerptScope".into(), json!("session_lifetime"));
        projected.insert("excerptAvailability".into(), source["session"]["excerpt_availability"].clone());
    } else {
        for field in selected {
            let key = field.strip_prefix("session.").ok_or("typed_data_field_denied")?;
            let value = if let Some(token_field) = key.strip_prefix("tokens.") {
                source["session"]["tokens"].get(token_field)
            } else {
                source["session"].get(if key == "harness_id" { "harness" } else { key })
            }.ok_or("typed_data_source_invalid")?;
            let path = field.split('.').skip(1).collect::<Vec<_>>();
            set_nested(&mut projected, &path, value.clone())?;
        }
        if projected.contains_key("id") { projected.insert("id".into(), json!(handle)); }
    }
    let response = if excerpts {
        json!({"schema":schema,"dataRevision":revision,"windowDays":days,
            "window":{"fromMs":source["session"]["window"]["from_ms"],"toMs":source["session"]["window"]["to_ms"]},
            "sessionRef":handle,"excerpts":projected["excerpts"],"excerptScope":projected["excerptScope"],
            "excerptAvailability":projected["excerptAvailability"]})
    } else {
        json!({"schema":schema,"dataRevision":revision,"windowDays":days,
            "window":{"fromMs":source["session"]["window"]["from_ms"],"toMs":source["session"]["window"]["to_ms"]},
            "sessionRef":handle,"session":projected,"costDataset":"session-cost:v1","costAvailable":false})
    };
    bounded_result(response, grant.max_bytes.min(if excerpts { excerpt_grant.unwrap().max_bytes } else { grant.max_bytes }))
}

fn read_session_cost(grant: &TypedDataGrant, home: &Path, plugin_id: &str, payload: &Value) -> Result<Value, &'static str> {
    if payload["dataset"].as_str() != Some("session-cost") || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= SESSION_COST_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let selected = validate_fields(fields, SESSION_COST_FIELDS, &grant.fields)?;
    let query = &payload["query"];
    if !exact_keys(query, &["sessionRef", "windowDays", "toMs", "dataRevision"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() { return Err("typed_data_invalid_request"); }
    let handle = query["sessionRef"].as_str().filter(|value| value.len() == 35 && value.starts_with("sr_")
        && value[3..].bytes().all(|byte| byte.is_ascii_hexdigit())).ok_or("typed_data_invalid_request")?;
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let revision = current_revision(home, query["dataRevision"].clone())?;
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = agent_vitals_runtime::query::app_harnesses::session_cost(home, plugin_id, handle, days, to_ms, revision)?;
    let mut cost = Map::new();
    for field in selected {
        let key = field.strip_prefix("cost.").ok_or("typed_data_field_denied")?;
        let value = source["cost"].get(key).ok_or("typed_data_source_invalid")?;
        cost.insert(key.to_owned(), value.clone());
    }
    bounded_result(json!({"schema":SESSION_COST_V1,"dataRevision":revision,"windowDays":days,
        "window":{"fromMs":source["window"]["from_ms"],"toMs":source["window"]["to_ms"]},
        "sessionRef":handle,"cost":cost}), grant.max_bytes)
}

fn validate_fields(fields: &[Value], allowed: &[&str], granted: &[String]) -> Result<Vec<String>, &'static str> {
    let mut selected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str().ok_or("typed_data_invalid_request")?;
        if !allowed.contains(&field) || !granted.iter().any(|allowed| allowed == field) { return Err("typed_data_field_denied"); }
        if selected.iter().any(|existing| existing == field) { return Err("typed_data_invalid_request"); }
        selected.push(field.to_owned());
    }
    Ok(selected)
}

fn current_revision(home: &Path, requested: Value) -> Result<u64, &'static str> {
    let index = agent_vitals_runtime::query::app_harnesses::list(home)?;
    let current = index["data_revision"].as_u64().ok_or("data_unavailable")?;
    if requested.is_null() { Ok(current) }
    else { requested.as_u64().filter(|value| *value == current).ok_or("revision_changed") }
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}

fn valid_harness_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
}

fn set_nested(object: &mut Map<String, Value>, path: &[&str], value: Value) -> Result<(), &'static str> {
    if path.len() == 1 {
        object.insert(path[0].to_owned(), value);
        return Ok(());
    }
    let child = object.entry(path[0].to_owned()).or_insert_with(|| Value::Object(Map::new()));
    let nested = child.as_object_mut().ok_or("typed_data_contract_invalid")?;
    set_nested(nested, &path[1..], value)
}

fn project_session(row: &Value, fields: &[String]) -> Result<Value, &'static str> {
    let mut out = Map::new();
    for field in fields {
        let value = match field.as_str() {
            "session.id" => row.get("id"),
            "session.harness_id" => row.get("harness_id"),
            "session.first_event_at_ms" => row.get("first_event_at_ms"),
            "session.last_event_at_ms" => row.get("last_event_at_ms"),
            "session.event_count" => row.get("event_count"),
            "session.tokens.input" => row.get("tokens").and_then(|v| v.get("input")),
            "session.tokens.output" => row.get("tokens").and_then(|v| v.get("output")),
            "session.tokens.total" => row.get("tokens").and_then(|v| v.get("total")),
            _ => return Err("typed_data_field_denied"),
        }.ok_or("typed_data_source_invalid")?;
        set_nested(&mut out, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
    }
    Ok(Value::Object(out))
}

fn bounded_result(value: Value, max_bytes: usize) -> Result<Value, &'static str> {
    let bytes = serde_json::to_vec(&value).map_err(|_| "typed_data_unavailable")?;
    if bytes.len() > max_bytes { return Err("typed_data_too_large"); }
    Ok(value)
}

fn project_session_v3(row: &Value, fields: &[String]) -> Result<Value, &'static str> {
    let mut out = Map::new();
    for field in fields {
        let value = match field.as_str() {
            "session.id" => row.get("id"),
            "session.harness_id" => row.get("harness_id"),
            "session.title" => row.get("title"),
            "session.title_source" => row.get("title_source"),
            "session.window_first_event_at_ms" => row.get("window_first_event_at_ms"),
            "session.window_last_event_at_ms" => row.get("window_last_event_at_ms"),
            "session.window_order" => row.get("window_order"),
            "session.lifetime_first_event_at_ms" => row.get("lifetime_first_event_at_ms"),
            "session.lifetime_last_event_at_ms" => row.get("lifetime_last_event_at_ms"),
            "session.event_count" => row.get("event_count"),
            "session.tokens.input" => row.get("tokens").and_then(|v| v.get("input")),
            "session.tokens.output" => row.get("tokens").and_then(|v| v.get("output")),
            "session.tokens.total" => row.get("tokens").and_then(|v| v.get("total")),
            "session.tokens.uncached_input" => row.get("tokens").and_then(|v| v.get("uncached_input")),
            "session.tokens.cache_read" => row.get("tokens").and_then(|v| v.get("cache_read")),
            "session.tokens.cache_write" => row.get("tokens").and_then(|v| v.get("cache_write")),
            "session.model_ids" => row.get("model_ids"),
            "session.model_coverage" => row.get("model_coverage"),
            "session.stable_ref" => row.get("stable_ref"),
            _ => return Err("typed_data_field_denied"),
        }.ok_or("typed_data_source_invalid")?;
        set_nested(&mut out, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
    }
    Ok(Value::Object(out))
}

fn read_session_source_status(
    grant: &TypedDataGrant,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
) -> Result<Value, &'static str> {
    if !exact_keys(payload, &["dataset", "version", "fields", "query"])
        || payload["dataset"].as_str() != Some("session-source-status") || payload["version"].as_u64() != Some(1) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= SESSION_SOURCE_STATUS_FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let mut selected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str().ok_or("typed_data_invalid_request")?;
        if !SESSION_SOURCE_STATUS_FIELDS.contains(&field) || !grant.fields.iter().any(|allowed| allowed == field) {
            return Err("typed_data_field_denied");
        }
        if selected.iter().any(|existing| existing == field) { return Err("typed_data_invalid_request"); }
        selected.push(field.to_owned());
    }
    if !selected.iter().any(|field| field == "source.stable_ref") { return Err("typed_data_invalid_request"); }
    let query = &payload["query"];
    if !exact_keys(query, &["windowDays", "toMs", "dataRevision", "references"])
        || query["toMs"].is_null() != query["dataRevision"].is_null() {
        return Err("typed_data_invalid_request");
    }
    let references = query["references"].as_array()
        .filter(|refs| refs.len() <= grant.max_rows && refs.len() <= 200)
        .ok_or("typed_data_query_denied")?;
    let mut stable_refs = Vec::with_capacity(references.len());
    for reference in references {
        let reference = reference.as_str().filter(|value| value.len() == 36 && value.starts_with("srp_")
            && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit())).ok_or("typed_data_invalid_request")?;
        if stable_refs.iter().any(|existing| existing == reference) { return Err("typed_data_invalid_request"); }
        stable_refs.push(reference.to_owned());
    }
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let current_revision = agent_vitals_runtime::query::app_harnesses::list(home)?["data_revision"].as_u64().ok_or("data_unavailable")?;
    let revision = if query["dataRevision"].is_null() { current_revision }
        else { query["dataRevision"].as_u64().filter(|value| *value == current_revision).ok_or("revision_changed")? };
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = agent_vitals_runtime::query::app_harnesses::session_source_status(
        home, plugin_id, &stable_refs, days, to_ms, revision,
    )?;
    let rows = source["sources"].as_array().ok_or("typed_data_source_invalid")?;
    let projected = rows.iter().map(|row| {
        let mut out = Map::new();
        for field in &selected {
            let value = match field.as_str() {
                "source.stable_ref" => row.get("stable_ref"),
                "source.state" => row.get("state"),
                "source.has_usage_in_window" => row.get("has_usage_in_window"),
                _ => return Err("typed_data_field_denied"),
            }.ok_or("typed_data_source_invalid")?;
            set_nested(&mut out, &field.split('.').skip(1).collect::<Vec<_>>(), value.clone())?;
        }
        Ok(Value::Object(out))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    bounded_result(json!({"schema":SESSION_SOURCE_STATUS_V1,"dataRevision":revision,"windowDays":days,
        "window":{"fromMs":source["window"]["from_ms"],"toMs":source["window"]["to_ms"]},"sources":projected}), grant.max_bytes)
}

fn read_sessions_v3(
    grant: &TypedDataGrant,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
    stable_refs: bool,
) -> Result<Value, &'static str> {
    let (version, dataset, allowed_fields) = if stable_refs { (4, DATASET_V4, FIELDS_V4) }
        else { (3, DATASET_V3, FIELDS_V3) };
    if !exact_keys(payload, &["dataset", "version", "fields", "query"])
        || payload["dataset"].as_str() != Some("harness-sessions") || payload["version"].as_u64() != Some(version) {
        return Err("typed_data_invalid_request");
    }
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= allowed_fields.len())
        .ok_or("typed_data_invalid_request")?;
    let mut selected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str().ok_or("typed_data_invalid_request")?;
        if !allowed_fields.contains(&field) || !grant.fields.iter().any(|allowed| allowed == field) { return Err("typed_data_field_denied"); }
        if selected.iter().any(|existing| existing == field) { return Err("typed_data_invalid_request"); }
        selected.push(field.to_owned());
    }
    let include_stable_ref = stable_refs && selected.iter().any(|field| field == "session.stable_ref");
    let query = &payload["query"];
    if !exact_keys(query, &["windowDays", "offset", "limit", "toMs", "dataRevision"]) { return Err("typed_data_invalid_request"); }
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok())
        .filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let offset = query["offset"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= grant.max_total_rows).ok_or("typed_data_query_denied")?;
    let limit = query["limit"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=grant.max_rows).contains(value)).ok_or("typed_data_query_denied")?;
    if offset.saturating_add(limit) > grant.max_total_rows
        || query["toMs"].is_null() != query["dataRevision"].is_null()
        || (offset > 0 && (query["toMs"].is_null() || query["dataRevision"].is_null())) {
        return Err("typed_data_query_denied");
    }
    let revision = agent_vitals_runtime::query::app_harnesses::list(home)?["data_revision"].as_u64().ok_or("data_unavailable")?;
    if !query["dataRevision"].is_null() && query["dataRevision"].as_u64() != Some(revision) { return Err("revision_changed"); }
    let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
        else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
    let source = if include_stable_ref {
        agent_vitals_runtime::query::app_harnesses::sessions_layout_page_with_stable_refs(
            home, days, to_ms, revision, plugin_id, offset, limit,
        )?
    } else {
        agent_vitals_runtime::query::app_harnesses::sessions_layout_page(
            home, days, to_ms, revision, plugin_id, offset, limit,
        )?
    };
    let rows = source["sessions"].as_array().ok_or("typed_data_source_invalid")?;
    let output_rows = rows.iter().map(|row| project_session_v3(row, &selected)).collect::<Result<Vec<_>, _>>()?;
    let total = source["coverage"]["total"].as_u64().ok_or("typed_data_source_invalid")?;
    let from_ms = source["window"]["from_ms"].as_i64().ok_or("typed_data_source_invalid")?;
    let to_ms = source["window"]["to_ms"].as_i64().ok_or("typed_data_source_invalid")?;
    bounded_result(json!({
        "schema":dataset,
        "dataRevision":revision,
        "harnessId":Value::Null,
        "windowDays":days,
        "window":{"fromMs":from_ms,"toMs":to_ms},
        "pagination":{"offset":offset,"limit":limit},
        "coverage":{"total":total,"returned":output_rows.len(),"truncated":total>(offset as u64).saturating_add(output_rows.len() as u64)},
        "sessions":output_rows
    }), grant.max_bytes)
}

/// Read an authorized, fixed dataset. The descriptor is the sole source of
/// available datasets, field IDs, query windows and resource caps.
pub(crate) fn read_for_plugin(
    grants: &std::collections::BTreeMap<String, TypedDataGrant>,
    home: &Path,
    plugin_id: &str,
    payload: &Value,
) -> Result<Value, &'static str> {
    if !exact_keys(payload, &["dataset", "version", "fields", "query"]) { return Err("typed_data_invalid_request"); }
    if payload["dataset"].as_str() == Some("usage-summary") {
        let grant = grants.get(USAGE_SUMMARY_V1).filter(|grant| grant.is_valid(USAGE_SUMMARY_V1)).ok_or("typed_data_denied")?;
        return read_usage_summary(grant, home, payload);
    }
    if payload["dataset"].as_str() == Some("activity-summary") {
        let grant = grants.get(ACTIVITY_SUMMARY_V1).filter(|grant| grant.is_valid(ACTIVITY_SUMMARY_V1)).ok_or("typed_data_denied")?;
        return read_activity_summary(grant, home, payload);
    }
    if payload["dataset"].as_str() == Some("model-usage") {
        let grant = grants.get(MODEL_USAGE_V1).filter(|grant| grant.is_valid(MODEL_USAGE_V1)).ok_or("typed_data_denied")?;
        return read_model_usage(grant, home, payload);
    }
    if payload["dataset"].as_str() == Some("time-coverage") {
        let grant = grants.get(TIME_COVERAGE_V1).filter(|grant| grant.is_valid(TIME_COVERAGE_V1)).ok_or("typed_data_denied")?;
        return read_time_coverage(grant, home, payload);
    }
    if payload["dataset"].as_str() == Some("finding-summary") {
        let grant = grants.get(FINDING_SUMMARY_V1).filter(|grant| grant.is_valid(FINDING_SUMMARY_V1)).ok_or("typed_data_denied")?;
        return read_finding_summary(grant, home, payload);
    }
    if payload["dataset"].as_str() == Some("skill-usage-summary") {
        let grant = grants.get(SKILL_USAGE_V1).filter(|grant| grant.is_valid(SKILL_USAGE_V1)).ok_or("typed_data_denied")?;
        return read_skill_or_workflow(grant, home, payload, true);
    }
    if payload["dataset"].as_str() == Some("workflow-activity-summary") {
        let grant = grants.get(WORKFLOW_ACTIVITY_V1).filter(|grant| grant.is_valid(WORKFLOW_ACTIVITY_V1)).ok_or("typed_data_denied")?;
        return read_skill_or_workflow(grant, home, payload, false);
    }
    if payload["dataset"].as_str() == Some("harness-session-detail") {
        let grant = grants.get(SESSION_DETAIL_V1).filter(|grant| grant.is_valid(SESSION_DETAIL_V1)).ok_or("typed_data_denied")?;
        return read_session_detail(grant, None, home, plugin_id, payload, false);
    }
    if payload["dataset"].as_str() == Some("session-excerpts") {
        let grant = grants.get(SESSION_EXCERPTS_V1).filter(|grant| grant.is_valid(SESSION_EXCERPTS_V1)).ok_or("typed_data_denied")?;
        return read_session_detail(grant, Some(grant), home, plugin_id, payload, true);
    }
    if payload["dataset"].as_str() == Some("session-cost") {
        let grant = grants.get(SESSION_COST_V1).filter(|grant| grant.is_valid(SESSION_COST_V1)).ok_or("typed_data_denied")?;
        return read_session_cost(grant, home, plugin_id, payload);
    }
    if payload["dataset"].as_str() == Some("session-source-status") {
        let grant = grants.get(SESSION_SOURCE_STATUS_V1).filter(|grant| grant.is_valid(SESSION_SOURCE_STATUS_V1)).ok_or("typed_data_denied")?;
        return read_session_source_status(grant, home, plugin_id, payload);
    }
    if payload["dataset"].as_str() == Some("harness-session-identities") {
        let grant = grants.get(SESSION_IDENTITIES_V1)
            .filter(|grant| grant.is_valid(SESSION_IDENTITIES_V1)).ok_or("typed_data_denied")?;
        return read_session_identities(grant, home, plugin_id, payload);
    }
    if payload["dataset"].as_str() != Some("harness-sessions") {
        return Err("typed_data_unavailable");
    }
    let version = payload["version"].as_u64().ok_or("typed_data_unavailable")?;
    if version == 5 {
        let grant = grants.get(DATASET_V5).filter(|grant| grant.is_valid(DATASET_V5)).ok_or("typed_data_denied")?;
        return read_sessions_lifetime(grant, home, plugin_id, payload);
    }
    let (dataset_key, is_v2) = match version {
        1 => (DATASET, false),
        2 => (DATASET_V2, true),
        3 => {
            let grant = grants.get(DATASET_V3).filter(|grant| grant.is_valid(DATASET_V3)).ok_or("typed_data_denied")?;
            return read_sessions_v3(grant, home, plugin_id, payload, false);
        }
        4 => {
            let grant = grants.get(DATASET_V4).filter(|grant| grant.is_valid(DATASET_V4)).ok_or("typed_data_denied")?;
            return read_sessions_v3(grant, home, plugin_id, payload, true);
        }
        _ => return Err("typed_data_unavailable"),
    };
    let grant = grants.get(dataset_key).filter(|grant| grant.is_valid(dataset_key)).ok_or("typed_data_denied")?;
    let fields = payload["fields"].as_array().filter(|fields| !fields.is_empty() && fields.len() <= FIELDS.len())
        .ok_or("typed_data_invalid_request")?;
    let mut selected = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str().ok_or("typed_data_invalid_request")?;
        if !FIELDS.contains(&field) || !grant.fields.iter().any(|allowed| allowed == field) { return Err("typed_data_field_denied"); }
        if selected.iter().any(|existing| existing == field) { return Err("typed_data_invalid_request"); }
        selected.push(field.to_owned());
    }
    let query = &payload["query"];
    let query_keys = if is_v2 { &["harnessId", "windowDays", "offset", "limit", "toMs", "dataRevision"][..] }
        else { &["harnessId", "windowDays", "offset", "limit"][..] };
    if !exact_keys(query, query_keys) { return Err("typed_data_invalid_request"); }
    let harness = query["harnessId"].as_str().filter(|value| valid_harness_id(value)).ok_or("typed_data_invalid_request")?;
    let days = query["windowDays"].as_u64().and_then(|value| u16::try_from(value).ok()).filter(|value| grant.window_days.contains(value)).ok_or("typed_data_query_denied")?;
    let offset = query["offset"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= if is_v2 { grant.max_total_rows } else { MAX_ROWS }).ok_or("typed_data_query_denied")?;
    let limit = query["limit"].as_u64().and_then(|value| usize::try_from(value).ok())
        .filter(|value| (1..=grant.max_rows).contains(value)).ok_or("typed_data_query_denied")?;
    if is_v2 && offset.saturating_add(limit) > grant.max_total_rows { return Err("typed_data_query_denied"); }
    if is_v2 && (query["toMs"].is_null() != query["dataRevision"].is_null()
        || (offset > 0 && (query["toMs"].is_null() || query["dataRevision"].is_null()))) {
        return Err("typed_data_query_denied");
    }

    let index = agent_vitals_runtime::query::app_harnesses::list(home)?;
    let revision = index["data_revision"].as_u64().ok_or("data_unavailable")?;
    if is_v2 {
        if !query["dataRevision"].is_null()
            && query["dataRevision"].as_u64() != Some(revision) { return Err("revision_changed"); }
        let to_ms = if query["toMs"].is_null() { agent_vitals_runtime::core::clock::now_ms() }
            else { query["toMs"].as_i64().ok_or("typed_data_invalid_request")? };
        let source = agent_vitals_runtime::query::app_harnesses::sessions_page(
            home, harness, days, to_ms, revision, plugin_id, offset, limit,
        )?;
        let rows = source["sessions"].as_array().ok_or("typed_data_source_invalid")?;
        let output_rows = rows.iter().map(|row| project_session(row, &selected)).collect::<Result<Vec<_>, _>>()?;
        let total = source["coverage"]["total"].as_u64().ok_or("typed_data_source_invalid")?;
        let truncated = source["coverage"]["truncated"].as_bool().ok_or("typed_data_source_invalid")?;
        bounded_result(json!({
            "schema": DATASET_V2,
            "dataRevision": revision,
            "harnessId": harness,
            "windowDays": days,
            "window": {"fromMs": source["window"]["from_ms"], "toMs": source["window"]["to_ms"]},
            "pagination": {"offset": offset, "limit": limit},
            "coverage": {"total": total, "returned": output_rows.len(), "truncated": truncated},
            "sessions": output_rows,
        }), grant.max_bytes)
    } else {
        let source = agent_vitals_runtime::query::app_harnesses::sessions(
            home, harness, days, agent_vitals_runtime::core::clock::now_ms(), revision, plugin_id,
        )?;
        let rows = source["sessions"].as_array().ok_or("typed_data_source_invalid")?;
        let output_rows = rows.iter().skip(offset).take(limit).map(|row| project_session(row, &selected)).collect::<Result<Vec<_>, _>>()?;
        let total = source["coverage"]["total"].as_u64().ok_or("typed_data_source_invalid")?;
        let page_end = (offset as u64).saturating_add(output_rows.len() as u64);
        let truncated = total > page_end;
        bounded_result(json!({
            "schema": DATASET,
            "dataRevision": revision,
            "harnessId": harness,
            "windowDays": days,
            "pagination": {"offset": offset, "limit": limit},
            "coverage": {"total": total, "returned": output_rows.len(), "truncated": truncated},
            "sessions": output_rows,
        }), grant.max_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        home: std::path::PathBuf,
        now: i64,
    }

    impl Fixture {
        fn new(session_count: usize) -> Self {
            static FIXTURE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let home = std::env::temp_dir().join(format!("typed-data-{}-{}-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
                session_count, FIXTURE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            let now = agent_vitals_runtime::core::clock::now_ms();
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&home), now).unwrap();
            db.begin_run("typed-data-fixture", "test", now).unwrap();
            for index in 0..session_count {
                let key = format!("synthetic-session-{index:04}");
                let timestamp = now - index as i64 * 1_000;
                let title = if index == 0 { "Session sk-1234567890abcdefghijklmnopqrst".to_owned() }
                    else if index == 1 { "😀".repeat(200) } else { format!("Session {index}") };
                db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms,title,title_source)
                    VALUES(?1,'codex',?1,'synthetic-machine',?2,?3,'codex_thread_name')", rusqlite::params![key, timestamp, title]).unwrap();
                db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,
                    source_event_id,observation_kind,event_ts_ms,uncached_input_tokens,output_tokens,model_id,ingested_run_id,created_at_ms,updated_at_ms)
                    VALUES(?1,'codex','synthetic-machine',?2,?2,?1,'delta',?3,10,5,'test-model','typed-data-fixture',?4,?4)",
                    rusqlite::params![format!("synthetic-fact-{index:04}"), key, timestamp, now]).unwrap();
            }
            drop(db);
            Self { home, now }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    fn grant() -> TypedDataGrant {
        TypedDataGrant {
            fields: FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366],
            max_rows: 500,
            max_total_rows: 500,
            max_bytes: 256 * 1024,
        }
    }

    fn grant_v2() -> TypedDataGrant {
        TypedDataGrant { max_total_rows: 4_000, ..grant() }
    }

    fn grant_v3() -> TypedDataGrant {
        TypedDataGrant { fields: FIELDS_V3.iter().map(|field| (*field).to_owned()).collect(), max_total_rows: 4_000, ..grant() }
    }

    fn grant_v4() -> TypedDataGrant {
        TypedDataGrant { fields: FIELDS_V4.iter().map(|field| (*field).to_owned()).collect(), max_total_rows: 4_000, ..grant() }
    }

    fn grant_usage_summary() -> TypedDataGrant {
        TypedDataGrant { fields: USAGE_SUMMARY_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 1, max_total_rows: 1, max_bytes: 16_384 }
    }

    fn grant_activity_summary() -> TypedDataGrant {
        TypedDataGrant { fields: ACTIVITY_SUMMARY_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 368, max_total_rows: 368, max_bytes: 65_536 }
    }

    fn grant_model_usage() -> TypedDataGrant {
        TypedDataGrant { fields: MODEL_USAGE_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 500, max_total_rows: 500, max_bytes: 256 * 1024 }
    }

    fn grant_time_coverage() -> TypedDataGrant {
        TypedDataGrant { fields: TIME_COVERAGE_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 1, max_total_rows: 1, max_bytes: 16_384 }
    }

    fn grant_finding_summary() -> TypedDataGrant {
        TypedDataGrant { fields: FINDING_SUMMARY_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 500, max_total_rows: 500, max_bytes: 65_536 }
    }

    fn grant_skill_usage() -> TypedDataGrant {
        TypedDataGrant { fields: SKILL_USAGE_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 200, max_total_rows: 200, max_bytes: 65_536 }
    }

    fn grant_workflow_activity() -> TypedDataGrant {
        TypedDataGrant { fields: WORKFLOW_ACTIVITY_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 200, max_total_rows: 200, max_bytes: 65_536 }
    }

    fn grant_session_source_status() -> TypedDataGrant {
        TypedDataGrant { fields: SESSION_SOURCE_STATUS_FIELDS.iter().map(|field| (*field).to_owned()).collect(),
            window_days: vec![7, 30, 90, 366], max_rows: 200, max_total_rows: 200, max_bytes: 32_768 }
    }

    fn legacy_export_grant() -> LegacyExportGrant {
        LegacyExportGrant { max_rows: 500, max_bytes: 1024 * 1024 }
    }

    fn request() -> Value {
        json!({"dataset":"harness-sessions","version":1,
            "fields":["session.id","session.tokens.total"],
            "query":{"harnessId":"codex","windowDays":30,"offset":0,"limit":100}})
    }

    #[test]
    fn typed_reader_uses_synthetic_authority_data_with_scope_pagination_and_caps() {
        let fixture = Fixture::new(12);
        let mut city_grant = grant();
        city_grant.max_rows = 3;
        let grants = [(DATASET.to_owned(), city_grant)].into_iter().collect();
        let mut input = request();
        input["query"]["limit"] = json!(2);
        let city_page = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(city_page["schema"], DATASET);
        assert_eq!(city_page["harnessId"], "codex");
        assert_eq!(city_page["pagination"], json!({"offset":0,"limit":2}));
        assert_eq!(city_page["coverage"], json!({"total":12,"returned":2,"truncated":true}));
        assert_eq!(city_page["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(city_page["sessions"][0]["tokens"]["total"], 15);
        assert!(!city_page.to_string().contains("synthetic-session"));
        assert!(!city_page.to_string().contains("synthetic-machine"));

        input["query"]["offset"] = json!(2);
        let next_page = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(next_page["pagination"]["offset"], 2);
        assert_eq!(next_page["sessions"].as_array().unwrap().len(), 2);
        assert_ne!(city_page["sessions"][0]["id"], next_page["sessions"][0]["id"]);

        let other_plugin = read_for_plugin(&grants, &fixture.home, "island", &input).unwrap();
        assert_ne!(next_page["sessions"][0]["id"], other_plugin["sessions"][0]["id"],
            "session references are scoped to the requesting built-in plugin");

        let mut tight_grant = grant();
        tight_grant.max_bytes = 1024;
        let tight_grants = [(DATASET.to_owned(), tight_grant)].into_iter().collect();
        input["fields"] = Value::Array(FIELDS.iter().map(|field| Value::String((*field).to_owned())).collect());
        input["query"]["offset"] = json!(0);
        input["query"]["limit"] = json!(12);
        assert_eq!(read_for_plugin(&tight_grants, &fixture.home, "city", &input), Err("typed_data_too_large"));
        assert!(fixture.now > 0);
    }

    #[test]
    fn typed_dataset_contract_is_bounded_and_unambiguous() {
        assert!(grant().is_valid(DATASET));
        assert!(!grant().is_valid("another-dataset:v1"));
        let mut invalid = grant(); invalid.fields.push("session.raw_log".into());
        assert!(!invalid.is_valid(DATASET));
        assert!(grant_session_source_status().is_valid(SESSION_SOURCE_STATUS_V1));
        assert!(grant_skill_usage().is_valid(SKILL_USAGE_V1));
        assert!(grant_workflow_activity().is_valid(WORKFLOW_ACTIVITY_V1));
        let mut invalid = grant(); invalid.max_rows = MAX_ROWS + 1;
        assert!(!invalid.is_valid(DATASET));
        let mut invalid = grant(); invalid.window_days.push(30);
        assert!(!invalid.is_valid(DATASET));
    }

    #[test]
    fn source_status_typed_read_returns_only_requested_opaque_source_states() {
        let fixture = Fixture::new(2);
        let refs = {
            let mut store = agent_vitals_runtime::query::object_store::ObjectStore::open(&fixture.home, "city").unwrap();
            store.stable_source_refs("harness-sessions:v4", &["synthetic-session-0000".into(), "synthetic-session-0001".into()], 200).unwrap()
        };
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&fixture.home), fixture.now).unwrap();
        db.conn().execute("UPDATE usage_facts SET event_ts_ms=?1 WHERE session_key='synthetic-session-0000'",
            [fixture.now - 31 * 86_400_000]).unwrap();
        db.conn().execute("UPDATE sessions SET deleted_at_ms=?1 WHERE session_key='synthetic-session-0001'", [fixture.now]).unwrap();
        drop(db);
        let grants = [(SESSION_SOURCE_STATUS_V1.to_owned(), grant_session_source_status())].into_iter().collect();
        let payload = json!({"dataset":"session-source-status","version":1,
            "fields":SESSION_SOURCE_STATUS_FIELDS,
            "query":{"windowDays":30,"toMs":fixture.now,"dataRevision":agent_vitals_runtime::query::app_harnesses::list(&fixture.home).unwrap()["data_revision"],
                "references":[refs[0],refs[1],"srp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}});
        let result = read_for_plugin(&grants, &fixture.home, "city", &payload).unwrap();
        assert_eq!(result["schema"], SESSION_SOURCE_STATUS_V1);
        assert_eq!(result["sources"][0]["stable_ref"], refs[0]);
        assert_eq!(result["sources"][0]["state"], "active");
        assert_eq!(result["sources"][0]["has_usage_in_window"], false);
        assert_eq!(result["sources"][1]["state"], "deleted");
        assert_eq!(result["sources"][1]["has_usage_in_window"], Value::Null);
        assert_eq!(result["sources"][2]["state"], "missing");
        assert!(!result.to_string().contains("synthetic-session"));
        assert_eq!(read_for_plugin(&std::collections::BTreeMap::new(), &fixture.home, "city", &payload), Err("typed_data_denied"));
        let mut duplicate = payload.clone();
        duplicate["query"]["references"] = json!([refs[0],refs[0]]);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &duplicate), Err("typed_data_invalid_request"));
        let mut identityless = payload.clone();
        identityless["fields"] = json!(["source.state"]);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &identityless), Err("typed_data_invalid_request"));
    }

    #[test]
    fn skill_workflow_typed_reads_are_redacted_revision_pinned_and_descriptor_scoped() {
        let fixture = Fixture::new(1);
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&fixture.home), fixture.now).unwrap();
        for (id, event_type, capability, outcome) in [
            ("typed-skill-invoke", "skill_invoked", Some("/Users/private/.agent/secret-skill"), "unknown"),
            ("typed-skill-finish", "skill_finished", Some("/Users/private/.agent/secret-skill"), "failed"),
            ("typed-tool-finish", "tool_finished", Some("private-tool"), "failed"),
        ] {
            db.conn().execute("INSERT INTO workflow_events(event_id,session_key,event_ts_ms,event_type,capability_kind,capability_id,outcome,ingested_run_id,created_at_ms)
                VALUES(?1,'synthetic-session-0000',?2,?3,'skill',?4,?5,'typed-data-fixture',?6)",
                rusqlite::params![id, fixture.now - 100, event_type, capability, outcome, fixture.now]).unwrap();
        }
        drop(db);
        let grants = [(SKILL_USAGE_V1.to_owned(), grant_skill_usage()),
            (WORKFLOW_ACTIVITY_V1.to_owned(), grant_workflow_activity())].into_iter().collect();
        let mut skill_request = json!({"dataset":"skill-usage-summary","version":1,
            "fields":SKILL_USAGE_FIELDS,"query":{"windowDays":30,"toMs":null,"dataRevision":null}});
        let skill = read_for_plugin(&grants, &fixture.home, "city", &skill_request).unwrap();
        assert_eq!(skill["schema"], SKILL_USAGE_V1);
        assert_eq!(skill["skills"][0]["label"], "<redacted>");
        assert_eq!(skill["skills"][0]["invocations"], 1);
        assert_eq!(skill["skills"][0]["failed_events"], 1);
        assert_eq!(skill["inventoryIncluded"], false);
        assert!(!skill.to_string().contains("/Users/private"));
        assert!(!skill.to_string().contains("typed-skill"));

        let workflow_request = json!({"dataset":"workflow-activity-summary","version":1,
            "fields":WORKFLOW_ACTIVITY_FIELDS,"query":{"windowDays":30,"toMs":skill["window"]["toMs"],"dataRevision":skill["dataRevision"]}});
        let workflow = read_for_plugin(&grants, &fixture.home, "city", &workflow_request).unwrap();
        assert_eq!(workflow["schema"], WORKFLOW_ACTIVITY_V1);
        assert_eq!(workflow["events"].as_array().unwrap().len(), 3);
        assert_eq!(workflow["events"].as_array().unwrap().iter().find(|row| row["event_type"] == "tool_finished").unwrap()["failed_events"], 1);
        assert!(!workflow.to_string().contains("typed-tool-finish"));
        assert!(!workflow.to_string().contains("private-tool"));

        skill_request["fields"] = json!(["skill.raw_capability_id"]);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &skill_request), Err("typed_data_field_denied"));
        assert_eq!(read_for_plugin(&std::collections::BTreeMap::new(), &fixture.home, "city", &workflow_request), Err("typed_data_denied"));
    }

    #[test]
    fn skill_usage_typed_read_marks_the_descriptor_row_cap_as_truncated() {
        let fixture = Fixture::new(1);
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&fixture.home), fixture.now).unwrap();
        for index in 0..201 {
            db.conn().execute("INSERT INTO workflow_events(event_id,session_key,event_ts_ms,event_type,capability_kind,capability_id,outcome,ingested_run_id,created_at_ms)
                VALUES(?1,'synthetic-session-0000',?2,'skill_invoked','skill',?3,'unknown','typed-data-fixture',?4)",
                rusqlite::params![format!("skill-event-{index:03}"), fixture.now - 100, format!("skill-{index:03}"), fixture.now]).unwrap();
        }
        drop(db);
        let grant = grant_skill_usage();
        let grants = [(SKILL_USAGE_V1.to_owned(), grant)].into_iter().collect();
        let input = json!({"dataset":"skill-usage-summary","version":1,"fields":["skill.label","skill.invocations"],
            "query":{"windowDays":30,"toMs":null,"dataRevision":null}});
        let response = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(response["skills"].as_array().unwrap().len(), 200);
        assert_eq!(response["truncated"], true);
        assert!(!response.to_string().contains("skill-event"));
        assert!(!response.to_string().contains("skill-200"));
    }

    #[test]
    fn typed_session_detail_and_excerpts_use_separate_grants_and_preserve_session_scope() {
        let fixture = Fixture::new(1);
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&fixture.home), fixture.now).unwrap();
        db.conn().execute("UPDATE usage_facts SET event_ts_ms=?1 WHERE session_key='synthetic-session-0000'", [fixture.now - 1_000]).unwrap();
        db.conn().execute("INSERT INTO session_excerpts(session_key,ordinal,role,excerpt,provenance,ingested_run_id)
            VALUES('synthetic-session-0000',1,'user_first','A bounded synthetic task excerpt','scrubbed','typed-data-fixture')", []).unwrap();
        drop(db);
        let revision = agent_vitals_runtime::query::app_harnesses::list(&fixture.home).unwrap()["data_revision"].as_u64().unwrap();
        let page = agent_vitals_runtime::query::app_harnesses::sessions_page(&fixture.home, "codex", 30, fixture.now,
            revision, "city", 0, 10).unwrap();
        let session_ref = page["sessions"][0]["id"].as_str().unwrap();
        let raw_detail = agent_vitals_runtime::query::app_harnesses::session_detail(&fixture.home, "city", session_ref, 30, fixture.now, revision, false).unwrap();
        assert!(raw_detail["session"].get("window").is_some());
        assert!(raw_detail["session"].get("id").is_some());
        assert!(raw_detail["session"].get("harness").is_some());
        assert!(raw_detail["session"]["tokens"].get("total").is_some());
        let mut grants = std::collections::BTreeMap::new();
        grants.insert(SESSION_DETAIL_V1.into(), TypedDataGrant { fields: SESSION_DETAIL_FIELDS.iter().map(|field| (*field).into()).collect(),
            window_days: vec![7,30,90,366], max_rows:1, max_total_rows:1, max_bytes:65_536 });
        let detail_request = json!({"dataset":"harness-session-detail","version":1,
            "fields":["session.id","session.harness_id","session.tokens.total"],
            "query":{"sessionRef":session_ref,"windowDays":30,"toMs":fixture.now,"dataRevision":revision}});
        let detail = read_for_plugin(&grants, &fixture.home, "city", &detail_request).unwrap();
        assert_eq!(detail["schema"], SESSION_DETAIL_V1);
        assert_eq!(detail["sessionRef"], session_ref);
        assert_eq!(detail["session"]["id"], session_ref);
        assert_eq!(detail["session"]["tokens"]["total"], 15);
        assert!(detail["session"].get("excerpts").is_none());
        assert_eq!(detail["costDataset"], "session-cost:v1");
        assert_eq!(detail["costAvailable"], false);

        let excerpt_request = json!({"dataset":"session-excerpts","version":1,
            "fields":SESSION_EXCERPT_FIELDS,"query":detail_request["query"]});
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &excerpt_request), Err("typed_data_denied"));
        grants.insert(SESSION_EXCERPTS_V1.into(), TypedDataGrant { fields: SESSION_EXCERPT_FIELDS.iter().map(|field| (*field).into()).collect(),
            window_days: vec![7,30,90,366], max_rows:2, max_total_rows:2, max_bytes:16_384 });
        let excerpts = read_for_plugin(&grants, &fixture.home, "city", &excerpt_request).unwrap();
        assert_eq!(excerpts["schema"], SESSION_EXCERPTS_V1);
        assert_eq!(excerpts["excerptScope"], "session_lifetime");
        assert_eq!(excerpts["excerpts"][0]["role"], "user_first");
        assert!(!excerpts.to_string().contains("synthetic-session-0000"));
        assert!(!excerpts.to_string().contains("synthetic-machine"));

        grants.insert(SESSION_COST_V1.into(), TypedDataGrant { fields: SESSION_COST_FIELDS.iter().map(|field| (*field).into()).collect(),
            window_days: vec![7,30,90,366], max_rows:1, max_total_rows:1, max_bytes:65_536 });
        let cost_request = json!({"dataset":"session-cost","version":1,
            "fields":["cost.status","cost.has_unresolved","cost.complete","cost.coverage","cost.breakdown"],
            "query":detail_request["query"]});
        let cost = read_for_plugin(&grants, &fixture.home, "city", &cost_request).unwrap();
        assert_eq!(cost["schema"], SESSION_COST_V1);
        assert_eq!(cost["sessionRef"], session_ref);
        assert!(cost["cost"]["breakdown"].is_array());
        assert!(cost["cost"]["coverage"].get("legacy_tokens").is_some());
        assert!(!cost.to_string().contains("synthetic-session-0000"));
    }

    #[test]
    fn typed_read_rejects_unauthorized_datasets_fields_and_query_shapes() {
        let grants = [(DATASET.to_owned(), grant())].into_iter().collect();
        let mut input = request();
        input["fields"] = json!(["session.raw_log"]);
        assert_eq!(read_for_plugin(&grants, Path::new("."), "city", &input), Err("typed_data_field_denied"));
        input = request(); input["query"]["table"] = json!("sessions");
        assert_eq!(read_for_plugin(&grants, Path::new("."), "city", &input), Err("typed_data_invalid_request"));
        input = request(); input["query"]["windowDays"] = json!(365);
        assert_eq!(read_for_plugin(&grants, Path::new("."), "city", &input), Err("typed_data_query_denied"));
        input = request(); input["query"]["offset"] = json!(501);
        assert_eq!(read_for_plugin(&grants, Path::new("."), "city", &input), Err("typed_data_query_denied"));
        input = request(); input["query"]["limit"] = json!(501);
        assert_eq!(read_for_plugin(&grants, Path::new("."), "city", &input), Err("typed_data_query_denied"));
        input = request(); input["dataset"] = json!("raw-sql");
        assert_eq!(read_for_plugin(&grants, Path::new("."), "city", &input), Err("typed_data_unavailable"));
        assert_eq!(read_for_plugin(&std::collections::BTreeMap::new(), Path::new("."), "city", &request()), Err("typed_data_denied"));
    }

    #[test]
    fn typed_read_projects_only_declared_fields_and_enforces_bytes() {
        let row = json!({"id":"sr_opaque","harness_id":"codex","event_count":3,
            "first_event_at_ms":100,"last_event_at_ms":200,"tokens":{"input":7,"output":5,"total":12},
            "title":"must not appear"});
        let projected = project_session(&row, &["session.id".into(),"session.tokens.total".into()]).unwrap();
        assert_eq!(projected, json!({"id":"sr_opaque","tokens":{"total":12}}));
        assert_eq!(bounded_result(json!({"payload":"too long"}), 4), Err("typed_data_too_large"));
    }

    #[test]
    fn v2_pages_beyond_500_with_fixed_window_and_revision() {
        let fixture = Fixture::new(620);
        let grants = [(DATASET_V2.to_owned(), grant_v2())].into_iter().collect();
        let mut input = json!({"dataset":"harness-sessions","version":2,
            "fields":["session.id","session.last_event_at_ms"],
            "query":{"harnessId":"codex","windowDays":30,"offset":0,"limit":500,"toMs":null,"dataRevision":null}});
        let first = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(first["schema"], DATASET_V2);
        assert_eq!(first["sessions"].as_array().unwrap().len(), 500);
        assert_eq!(first["coverage"]["total"], 620);
        assert_eq!(first["coverage"]["truncated"], true);
        assert_eq!(first["pagination"]["offset"], 0);

        input["query"]["offset"] = json!(500);
        input["query"]["toMs"] = first["window"]["toMs"].clone();
        input["query"]["dataRevision"] = first["dataRevision"].clone();
        let second = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(second["sessions"].as_array().unwrap().len(), 120);
        assert_eq!(second["coverage"]["returned"], 120);
        assert_eq!(second["coverage"]["truncated"], false);
        assert_eq!(second["window"], first["window"], "continuation reuses the original time window");
        assert_ne!(first["sessions"][499]["id"], second["sessions"][0]["id"]);

        input["query"]["dataRevision"] = json!(first["dataRevision"].as_u64().unwrap() + 1);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("revision_changed"));
    }

    #[test]
    fn v2_rejects_pages_outside_budget_and_expired_snapshots() {
        let fixture = Fixture::new(1);
        let grants = [(DATASET_V2.to_owned(), grant_v2())].into_iter().collect();
        let mut input = json!({"dataset":"harness-sessions","version":2,
            "fields":["session.id"],
            "query":{"harnessId":"codex","windowDays":30,"offset":3_500,"limit":500,"toMs":null,"dataRevision":null}});
        input["query"]["offset"] = json!(3_501);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_query_denied"));
        input["query"]["offset"] = json!(500);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_query_denied"));
        input["query"]["offset"] = json!(0);
        input["query"]["toMs"] = json!(fixture.now - 11 * 60 * 1_000);
        input["query"]["dataRevision"] = agent_vitals_runtime::query::app_harnesses::list(&fixture.home).unwrap()["data_revision"].clone();
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("snapshot_expired"));
    }

    #[test]
    fn v3_returns_only_scrubbed_session_layout_fields_and_pages_all_harnesses() {
        let fixture = Fixture::new(620);
        let grants = [(DATASET_V3.to_owned(), grant_v3())].into_iter().collect();
        let mut input = json!({"dataset":"harness-sessions","version":3,
            "fields":["session.id","session.harness_id","session.title","session.title_source",
                "session.window_first_event_at_ms","session.window_last_event_at_ms","session.window_order","session.tokens.total",
                "session.model_ids","session.model_coverage"],
            "query":{"windowDays":30,"offset":0,"limit":500,"toMs":null,"dataRevision":null}});
        let first = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(first["schema"], DATASET_V3);
        assert_eq!(first["harnessId"], Value::Null);
        assert_eq!(first["sessions"].as_array().unwrap().len(), 500);
        assert_eq!(first["coverage"]["total"], 620);
        assert_eq!(first["sessions"][0]["harness_id"], "codex");
        assert_eq!(first["sessions"][0]["title_source"], "codex_thread_name");
        assert!(first["sessions"][0]["title"].as_str().unwrap().contains("Session"));
        assert_eq!(first["sessions"][0]["window_order"], 620);
        assert!(!first.to_string().contains("sk-1234567890abcdefghijklmnopqrst"));
        assert_eq!(first["sessions"][0]["model_ids"], json!(["test-model"]));
        assert_eq!(first["sessions"][0]["model_coverage"]["unknown_model_usage_events"], 0);
        assert_eq!(first["sessions"][1]["title"].as_str().unwrap().chars().count(), 200);
        assert!(!first.to_string().contains("synthetic-session"));

        input["query"]["offset"] = json!(500);
        input["query"]["toMs"] = first["window"]["toMs"].clone();
        input["query"]["dataRevision"] = first["dataRevision"].clone();
        let second = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(second["sessions"].as_array().unwrap().len(), 120);
        assert_eq!(second["window"], first["window"]);
        assert_ne!(first["sessions"][499]["id"], second["sessions"][0]["id"]);
    }

    #[test]
    fn v3_rejects_ungranted_fields_and_non_fixed_query_shapes() {
        let grants = [(DATASET_V3.to_owned(), grant_v3())].into_iter().collect();
        let mut input = json!({"dataset":"harness-sessions","version":3,"fields":["session.id"],
            "query":{"windowDays":30,"offset":0,"limit":100,"toMs":null,"dataRevision":null}});
        input["fields"] = json!(["session.raw_key"]);
        let fixture = Fixture::new(1);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_field_denied"));
        input["fields"] = json!(["session.id"]);
        input["query"]["filterSql"] = json!("select * from sessions");
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_invalid_request"));
    }

    #[test]
    fn v4_stable_source_reference_is_field_granted_durable_and_not_minted_unless_requested() {
        let fixture = Fixture::new(3);
        let mut input = json!({"dataset":"harness-sessions","version":4,
            "fields":["session.id","session.stable_ref"],
            "query":{"windowDays":30,"offset":0,"limit":100,"toMs":null,"dataRevision":null}});
        assert_eq!(read_for_plugin(&std::collections::BTreeMap::new(), &fixture.home, "city", &input), Err("typed_data_denied"));
        let mut restricted = grant_v4();
        restricted.fields.retain(|field| field != "session.stable_ref");
        let restricted_grants = [(DATASET_V4.to_owned(), restricted)].into_iter().collect();
        assert_eq!(read_for_plugin(&restricted_grants, &fixture.home, "city", &input), Err("typed_data_field_denied"));

        let no_ref_grants = [(DATASET_V4.to_owned(), grant_v4())].into_iter().collect();
        input["fields"] = json!(["session.id"]);
        read_for_plugin(&no_ref_grants, &fixture.home, "city", &input).unwrap();
        assert!(!fixture.home.join("state/plugin-objects/city/objects.sqlite").exists(),
            "v4 requests without the granted stable_ref field must not mint references");

        input["fields"] = json!(["session.id","session.stable_ref"]);
        let first = read_for_plugin(&no_ref_grants, &fixture.home, "city", &input).unwrap();
        let reference = first["sessions"][0]["stable_ref"].as_str().unwrap().to_owned();
        assert!(reference.starts_with("srp_") && reference.len()==36);
        std::fs::remove_file(fixture.home.join(".mcp-session-salt")).unwrap();
        let second = read_for_plugin(&no_ref_grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(second["sessions"][0]["stable_ref"], reference);
        assert_ne!(second["sessions"][0]["id"], first["sessions"][0]["id"],
            "durable source refs must survive ordinary session_ref salt rotation");
    }

    #[test]
    fn usage_summary_is_all_harness_aggregate_with_a_pinned_window_and_field_projection() {
        let fixture = Fixture::new(2);
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&fixture.home), fixture.now).unwrap();
        db.conn().execute("INSERT INTO sessions(session_key,harness,native_session_id,machine_namespace,last_observed_at_ms,title,title_source)
            VALUES('other-harness-session','claude_code','other-harness-session','synthetic-machine',?1,'private title','claude_ai_title')",
            [fixture.now]).unwrap();
        db.conn().execute("INSERT INTO usage_facts(fact_id,harness,machine_namespace,native_session_id,session_key,
            source_event_id,observation_kind,event_ts_ms,uncached_input_tokens,output_tokens,model_id,ingested_run_id,created_at_ms,updated_at_ms)
            VALUES('other-harness-fact','claude_code','synthetic-machine','other-harness-session','other-harness-session',
            'other-harness-fact','delta',?1,20,7,'private-model','typed-data-fixture',?1,?1)", [fixture.now]).unwrap();
        drop(db);
        let grants = [(USAGE_SUMMARY_V1.to_owned(), grant_usage_summary())].into_iter().collect();
        let mut input = json!({"dataset":"usage-summary","version":1,
            "fields":["summary.session_count","summary.usage_event_count","summary.tokens.total"],
            "query":{"windowDays":30,"toMs":null,"dataRevision":null}});
        let first = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(first["schema"], USAGE_SUMMARY_V1);
        assert_eq!(first["windowDays"], 30);
        assert_eq!(first["window"]["toMs"].as_i64().unwrap() - first["window"]["fromMs"].as_i64().unwrap(), 30 * 86_400_000);
        assert_eq!(first["summary"], json!({"session_count":3,"usage_event_count":3,"tokens":{"total":57}}));
        assert!(!first.to_string().contains("claude_code"));
        assert!(!first.to_string().contains("private"));

        input["query"]["toMs"] = first["window"]["toMs"].clone();
        input["query"]["dataRevision"] = first["dataRevision"].clone();
        let pinned = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(pinned, first, "pinned reads return the same fixed-window projection");
        input["query"]["dataRevision"] = json!(first["dataRevision"].as_u64().unwrap() + 1);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("revision_changed"));
    }

    #[test]
    fn usage_summary_rejects_ungranted_fields_and_arbitrary_query_keys() {
        let fixture = Fixture::new(1);
        let mut restricted = grant_usage_summary();
        restricted.fields = vec!["summary.session_count".into()];
        let grants = [(USAGE_SUMMARY_V1.to_owned(), restricted)].into_iter().collect();
        let mut input = json!({"dataset":"usage-summary","version":1,"fields":["summary.session_count"],
            "query":{"windowDays":30,"toMs":null,"dataRevision":null}});
        input["fields"] = json!(["summary.tokens.total"]);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_field_denied"));
        input["fields"] = json!(["summary.session_count"]);
        input["query"]["harnessId"] = json!("codex");
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_invalid_request"));
        input["query"].as_object_mut().unwrap().remove("harnessId");
        input["query"]["toMs"] = json!(fixture.now);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_invalid_request"));
    }

    #[test]
    fn activity_summary_is_bounded_timezone_aware_and_field_projected() {
        let fixture = Fixture::new(2);
        let grants = [(ACTIVITY_SUMMARY_V1.to_owned(), grant_activity_summary())].into_iter().collect();
        let input = json!({"dataset":"activity-summary","version":1,
            "fields":["activity.date","activity.session_count","activity.event_count","activity.tokens"],
            "query":{"windowDays":30,"timezone":"America/New_York","toMs":null,"dataRevision":null}});
        let first = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(first["schema"], ACTIVITY_SUMMARY_V1);
        assert_eq!(first["timezone"], "America/New_York");
        assert_eq!(first["windowDays"], 30);
        assert_eq!(first["days"].as_array().unwrap().len(), 1);
        assert_eq!(first["days"][0]["session_count"], 2);
        assert_eq!(first["days"][0]["event_count"], 2);
        assert!(first["days"][0]["tokens"].is_number());
        assert!(!first.to_string().contains("synthetic-session"));
        assert!(!first.to_string().contains("codex"));

        let mut pinned_input = input.clone();
        pinned_input["query"]["toMs"] = first["window"]["toMs"].clone();
        pinned_input["query"]["dataRevision"] = first["dataRevision"].clone();
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &pinned_input).unwrap(), first);

        pinned_input["query"]["timezone"] = json!("not/a-timezone");
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &pinned_input), Err("invalid_timezone"));
        pinned_input["query"]["timezone"] = json!("UTC");
        pinned_input["query"]["extra"] = json!(true);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &pinned_input), Err("typed_data_invalid_request"));
    }

    #[test]
    fn model_usage_preserves_unknown_legacy_coverage_and_never_adds_prices() {
        let fixture = Fixture::new(1);
        let grants = [(MODEL_USAGE_V1.to_owned(), grant_model_usage())].into_iter().collect();
        let input = json!({"dataset":"model-usage","version":1,
            "fields":["model.model_id","model.usage_event_count","model.legacy_usage_event_count","model.tokens.total",
                "coverage.unknown_model_usage_events","coverage.legacy_usage_events","scope","pricing_independent"],
            "query":{"windowDays":30,"toMs":null,"dataRevision":null}});
        let result = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(result["schema"], MODEL_USAGE_V1);
        assert_eq!(result["models"][0]["model_id"], "test-model");
        assert_eq!(result["models"][0]["usage_event_count"], 1);
        assert_eq!(result["models"][0]["tokens"]["total"], 15);
        assert_eq!(result["scope"], "window");
        assert_eq!(result["pricingIndependent"], true);
        assert!(result.get("prices").is_none());
        assert!(!result.to_string().contains("synthetic-session"));

        let mut pinned = input.clone();
        pinned["query"]["toMs"] = result["window"]["toMs"].clone();
        pinned["query"]["dataRevision"] = result["dataRevision"].clone();
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &pinned).unwrap(), result);
        pinned["query"]["dataRevision"] = json!(result["dataRevision"].as_u64().unwrap() + 1);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &pinned), Err("revision_changed"));
    }

    #[test]
    fn time_coverage_keeps_lifetime_scope_and_rejects_ungranted_fields() {
        let fixture = Fixture::new(1);
        let grants = [(TIME_COVERAGE_V1.to_owned(), grant_time_coverage())].into_iter().collect();
        let mut input = json!({"dataset":"time-coverage","version":1,
            "fields":["coverage.scope","coverage.unknown_time_only","coverage.mixed_time","coverage.excluded_no_usage"],
            "query":{"dataRevision":null}});
        let first = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(first["schema"], TIME_COVERAGE_V1);
        assert_eq!(first["coverage"]["scope"], "all_non_deleted_sessions");
        assert_eq!(first["coverage"]["unknown_time_only"], 0);
        input["query"]["dataRevision"] = first["dataRevision"].clone();
        let pinned = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(pinned, first);
        input["fields"] = json!(["coverage.raw_keys"]);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &input), Err("typed_data_field_denied"));
    }

    #[test]
    fn finding_summary_projects_distinct_scopes_and_drops_issue_metadata() {
        let fixture = Fixture::new(1);
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&fixture.home), fixture.now).unwrap();
        for (id, issue_type, fingerprint, status, severity, opened) in [
            ("private-old", "private-category", "private-fingerprint-old", "open", "warning", fixture.now - 40 * 86_400_000),
            ("private-new-closed", "private-category", "private-fingerprint-new", "closed", "critical", fixture.now - 1_000),
        ] {
            db.conn().execute("INSERT INTO issue_instances(issue_id,machine_namespace,harness,issue_type,instance_fingerprint,status,
                severity,evaluator_id,evaluator_version,evidence_fingerprint,opened_at_ms,metadata_json)
                VALUES(?1,'private-machine','codex',?2,?3,?4,?5,'private-evaluator','1','private-evidence',?6,'{\"private\":true}')",
                rusqlite::params![id,issue_type,fingerprint,status,severity,opened]).unwrap();
        }
        drop(db);
        let grants = [(FINDING_SUMMARY_V1.to_owned(), grant_finding_summary())].into_iter().collect();
        let input = json!({"dataset":"finding-summary","version":1,
            "fields":["findings.current_backlog.harness_id","findings.current_backlog.severity","findings.current_backlog.count",
                "findings.window_new.harness_id","findings.window_new.severity","findings.window_new.count",
                "capabilities.harness_id","capabilities.available","capabilities.reason"],
            "query":{"windowDays":30,"toMs":null,"dataRevision":null}});
        let result = read_for_plugin(&grants, &fixture.home, "city", &input).unwrap();
        assert_eq!(result["schema"], FINDING_SUMMARY_V1);
        assert_eq!(result["current_backlog"], json!([{"harness_id":"codex","severity":"warning","count":1}]));
        assert_eq!(result["window_new"], json!([{"harness_id":"codex","severity":"critical","count":1}]));
        assert_eq!(result["capabilities"][0]["available"], true);
        for forbidden in ["private-old", "private-new-closed", "private-category", "private-fingerprint", "private-evidence", "private-machine"] {
            assert!(!result.to_string().contains(forbidden));
        }

        let mut pinned = input.clone();
        pinned["query"]["toMs"] = result["window"]["toMs"].clone();
        pinned["query"]["dataRevision"] = result["dataRevision"].clone();
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &pinned).unwrap(), result);
        pinned["query"]["extra"] = json!(true);
        assert_eq!(read_for_plugin(&grants, &fixture.home, "city", &pinned), Err("typed_data_invalid_request"));
    }

    #[test]
    fn city_legacy_export_is_descriptor_gated_and_rejects_changed_pinned_sources() {
        let fixture = Fixture::new(0);
        let grants = [(CITY_LEGACY_STORE_V1.to_owned(), legacy_export_grant())].into_iter().collect();
        let registry_path = fixture.home.join("state/plugins/city-assets/registry.sqlite");
        std::fs::create_dir_all(registry_path.parent().unwrap()).unwrap();
        let db = rusqlite::Connection::open(&registry_path).unwrap();
        db.execute_batch("CREATE TABLE assets(asset_ref TEXT PRIMARY KEY,key_hash TEXT,state TEXT NOT NULL);
            CREATE TABLE save_refs(save_id TEXT NOT NULL,asset_ref TEXT NOT NULL,PRIMARY KEY(save_id,asset_ref));
            INSERT INTO assets VALUES('ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','hash-a','present');
            INSERT INTO assets VALUES('ca_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','hash-b','orphaned');
            INSERT INTO save_refs VALUES('city-primary','ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            INSERT INTO save_refs VALUES('city-archive','ca_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');").unwrap();
        drop(db);

        let request = json!({"dataset":"city-legacy-store","version":1,"cursor":null,"limit":1,"source":"registry.save_refs"});
        assert_eq!(read_legacy_city_store_for_plugin(&std::collections::BTreeMap::new(), &fixture.home, &request), Err("typed_data_denied"));
        let first = read_legacy_city_store_for_plugin(&grants, &fixture.home, &request).unwrap();
        assert_eq!(first["schema"], "city-legacy-export:v1");
        assert_eq!(first["records"].as_array().unwrap().len(), 1);
        assert_eq!(first["records"][0]["source"], "registry.save_refs");
        let cursor = first["nextCursor"].as_str().unwrap().to_owned();

        let db = rusqlite::Connection::open(&registry_path).unwrap();
        db.execute("INSERT INTO save_refs VALUES('city-third','ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')", []).unwrap();
        drop(db);
        let next = json!({"dataset":"city-legacy-store","version":1,"cursor":cursor,"limit":1,"source":"registry.save_refs"});
        assert_eq!(read_legacy_city_store_for_plugin(&grants, &fixture.home, &next), Err("legacy_export_changed"));

        let mut invalid = request.clone();
        invalid["query"] = json!({});
        assert_eq!(read_legacy_city_store_for_plugin(&grants, &fixture.home, &invalid), Err("typed_data_invalid_request"));
        let too_many = json!({"dataset":"city-legacy-store","version":1,"cursor":null,"limit":501});
        assert_eq!(read_legacy_city_store_for_plugin(&grants, &fixture.home, &too_many), Err("typed_data_query_denied"));
    }
}
