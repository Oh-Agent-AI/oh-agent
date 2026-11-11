//! Same-host plugin face. Installation mechanism never appears in public identities.
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}};
use rusqlite::Connection;
use serde_json::{json, Value};
use agent_vitals_data::authority::{AuthorityDb, default_authority_path};
use agent_vitals_runtime_core::core::extension_objects::ObjectStore;
use agent_vitals_harnesses::generic_manifest;

pub(crate) struct Identity {
    pub name: String,
    pub registration: &'static str,
    pub findings: bool,
    pub diagnostic: Option<&'static str>,
}

pub(crate) fn identities(conn: &Connection, home: &Path) -> Result<BTreeMap<String, Identity>, &'static str> {
    let mut out = BTreeMap::new();
    for id in crate::fact_harnesses::FACT_HARNESSES {
        let name = agent_vitals_domain::harness_capability::harness_profile(id).map(|h| h.display).unwrap_or(id);
        out.insert(id.into(), Identity { name: name.into(), registration: "active", findings: true, diagnostic: None });
    }
    // Select the current object first; never silently substitute an older object
    // or mutable candidate if that current object is corrupt.
    let mut stmt = conn.prepare("SELECT r.slot_id,r.content_sha256,
        EXISTS(SELECT 1 FROM extension_active a JOIN extension_activation_slots s ON s.generation=a.generation
          WHERE s.revision_id=r.revision_id) AS active
        FROM extension_revisions r WHERE r.slot_type='harness_manifest'
        ORDER BY active DESC,r.installed_at_ms DESC,r.revision_id DESC").map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?)))
        .map_err(|_| "data_unavailable")?;
    let store = ObjectStore::open_readonly(&home.join("state/extensions")).ok();
    for row in rows {
        let (slug, hash, active) = row.map_err(|_| "data_unavailable")?;
        if !crate::harness_registry::plugin_slug_ok(&slug) { continue; }
        let id = format!("harness:{slug}");
        if out.contains_key(&id) { continue; }
        let parsed = store.as_ref().and_then(|s| s.load(&hash).ok())
            .and_then(|value| generic_manifest::parse_manifest(value).ok()).filter(|m| m.slug == slug);
        let valid = parsed.is_some();
        let name = parsed.map(|m| m.display_name).filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| slug.clone()).chars().take(100).collect();
        out.insert(id, Identity { name, registration: if active { if valid { "active" } else { "invalid" } } else { "inactive_history" },
            findings: false, diagnostic: if valid { None } else { Some("manifest_metadata_unavailable") } });
    }
    // Historical facts survive uninstall or loss of installation metadata.
    let mut stmt = conn.prepare("SELECT DISTINCT harness FROM usage_facts WHERE deleted_at_ms IS NULL")
        .map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|_| "data_unavailable")?;
    for row in rows {
        let id = row.map_err(|_| "data_unavailable")?;
        if let Some(slug) = id.strip_prefix("harness:").filter(|slug| crate::harness_registry::plugin_slug_ok(slug)) {
            out.entry(id.clone()).or_insert_with(|| Identity { name: slug.into(), registration: "inactive_history",
                findings: false, diagnostic: Some("manifest_metadata_unavailable") });
        }
    }
    Ok(out)
}

pub(crate) fn public_identities(identities: &BTreeMap<String, Identity>) -> Vec<Value> {
    identities.iter().map(|(id, item)| json!({"id":id,"display_name":item.name,
        "capabilities":{"session_statistics":{"available":true},
            "findings":{"available":item.findings,"reason":if item.findings { None } else { Some("findings_not_supported") }}}})).collect()
}

fn snapshot(home: &Path) -> Result<AuthorityDb, &'static str> {
    let db = AuthorityDb::open_readonly(&default_authority_path(home)).map_err(|_| "data_unavailable")?;
    db.conn().execute_batch("BEGIN DEFERRED").map_err(|_| "data_unavailable")?;
    Ok(db)
}

pub fn list(home: &Path) -> Result<Value, &'static str> {
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    Ok(json!({"protocol":"harnesses:v1","data_revision":revision,"harnesses":public_identities(&identities(db.conn(), home)?)}))
}

/// Application-neutral aggregate across every harness. The caller pins the
/// first response's `to_ms` and `data_revision` for repeatable reads. The
/// requested window is half-open `[from_ms, to_ms)` like the session pages.
pub fn usage_summary(home: &Path, days: u16, to_ms: i64, expected_revision: u64) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let inclusive_end = to_ms.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let summary = stats::window_summary(db.conn(), from_ms, inclusive_end).map_err(|_| "data_unavailable")?;
    Ok(json!({"protocol":"usage-summary:v1","data_revision":revision,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},"summary":summary}))
}

/// Application-neutral daily usage buckets across all harnesses. The timezone
/// changes only calendar-day boundaries; counts and token totals remain global
/// aggregates and no session or harness identifiers are returned.
pub fn activity_summary(
    home: &Path,
    days: u16,
    timezone: &str,
    to_ms: i64,
    expected_revision: u64,
) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    if timezone.is_empty() || timezone.len() > 128 { return Err("invalid_timezone"); }
    let tz = jiff::tz::TimeZone::get(timezone).map_err(|_| "invalid_timezone")?;
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }

    let mut date = jiff::Timestamp::from_millisecond(from_ms)
        .map_err(|_| "invalid_window")?.to_zoned(tz.clone()).date();
    let mut boundaries = Vec::with_capacity(days as usize + 2);
    loop {
        let start = date.to_zoned(tz.clone()).map_err(|_| "invalid_timezone")?
            .timestamp().as_millisecond();
        if start >= to_ms { break; }
        let next = date.tomorrow().map_err(|_| "invalid_window")?;
        let end = next.to_zoned(tz.clone()).map_err(|_| "invalid_timezone")?
            .timestamp().as_millisecond();
        boundaries.push(json!({"date":date.to_string(),"from_ms":start.max(from_ms),"to_ms":end.min(to_ms)}));
        if boundaries.len() > 368 { return Err("invalid_window"); }
        date = next;
    }
    let buckets = stats::daily_activity(db.conn(), &json!(boundaries)).map_err(|_| "data_unavailable")?;
    Ok(json!({"protocol":"activity-summary:v1","data_revision":revision,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},"timezone":timezone,"days":buckets}))
}

/// Application-neutral model aggregates for a fixed all-harness usage window.
/// Model identity is independent of priceability; unknown and legacy counts are
/// kept explicit so consumers cannot mistake them for priced model totals.
pub fn model_usage_summary(home: &Path, days: u16, to_ms: i64, expected_revision: u64) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let inclusive_end = to_ms.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let rows = stats::model_distribution(db.conn(), from_ms, inclusive_end, None).map_err(|_| "data_unavailable")?;
    let mut models: BTreeMap<Option<String>, (i64, i64, [i64; 4])> = BTreeMap::new();
    let mut unknown_events = 0i64;
    let mut legacy_events = 0i64;
    for row in rows {
        let model_id = row["model_id"].as_str().filter(|value| valid_model_id(value)).map(str::to_owned);
        let events = row["usage_event_count"].as_i64().ok_or("data_unavailable")?;
        let legacy = row["legacy"] == true;
        let tokens = &row["tokens"];
        let buckets = [
            tokens["uncached_input"].as_i64().ok_or("data_unavailable")?,
            tokens["cache_read"].as_i64().ok_or("data_unavailable")?,
            tokens["cache_write"].as_i64().ok_or("data_unavailable")?,
            tokens["output"].as_i64().ok_or("data_unavailable")?,
        ];
        if model_id.is_none() { unknown_events = unknown_events.checked_add(events).ok_or("numeric_out_of_range")?; }
        if legacy { legacy_events = legacy_events.checked_add(events).ok_or("numeric_out_of_range")?; }
        let aggregate = models.entry(model_id).or_insert((0, 0, [0; 4]));
        aggregate.0 = aggregate.0.checked_add(events).ok_or("numeric_out_of_range")?;
        if legacy { aggregate.1 = aggregate.1.checked_add(events).ok_or("numeric_out_of_range")?; }
        for (total, value) in aggregate.2.iter_mut().zip(buckets) {
            *total = total.checked_add(value).ok_or("numeric_out_of_range")?;
        }
    }
    let models = models.into_iter().map(|(model_id, (events, legacy, tokens))| {
        let input = tokens[0].checked_add(tokens[1]).and_then(|value| value.checked_add(tokens[2]))
            .ok_or("numeric_out_of_range")?;
        let total = input.checked_add(tokens[3]).ok_or("numeric_out_of_range")?;
        Ok(json!({"model_id":model_id,"usage_event_count":events,"legacy_usage_event_count":legacy,
            "tokens":{"uncached_input":tokens[0],"cache_read":tokens[1],"cache_write":tokens[2],
                "input":input,"output":tokens[3],"total":total}}))
    }).collect::<Result<Vec<_>, &'static str>>()?;
    Ok(json!({"protocol":"model-usage:v1","data_revision":revision,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},
        "models":models,"coverage":{"unknown_model_usage_events":unknown_events,
            "legacy_usage_events":legacy_events},"scope":"window","pricing_independent":true}))
}

/// Lifetime time coverage across every non-deleted session, matching the
/// authority source's `all_non_deleted_sessions` denominator.
pub fn time_coverage(home: &Path, expected_revision: u64) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let coverage = stats::time_coverage(db.conn()).map_err(|_| "data_unavailable")?;
    Ok(json!({"protocol":"time-coverage:v1","data_revision":revision,
        "scope":coverage["scope"],"unknown_time_only":coverage["unknown_time_only"],
        "mixed_time":coverage["mixed_time"],"excluded_no_usage":coverage["excluded_no_usage"]}))
}

/// Application-neutral finding counts. The two scopes intentionally use
/// different denominators: current backlog is status-based, while new findings
/// is based on opened-at time in the fixed window. Issue categories and source
/// identifiers never leave this query layer.
pub fn finding_summary(home: &Path, days: u16, to_ms: i64, expected_revision: u64) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let inclusive_end = to_ms.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let identities = identities(db.conn(), home)?;

    let aggregate = |rows: Vec<Value>| -> Result<Vec<Value>, &'static str> {
        let mut counts: BTreeMap<(String, String), i64> = BTreeMap::new();
        for row in rows {
            let harness = row["harness"].as_str().ok_or("data_unavailable")?;
            if !identities.get(harness).is_some_and(|identity| identity.findings) { continue; }
            let severity = row["severity"].as_str().filter(|value| matches!(*value, "critical" | "warning" | "info"))
                .ok_or("data_unavailable")?;
            let count = row["count"].as_i64().filter(|value| *value >= 0).ok_or("data_unavailable")?;
            let total = counts.entry((harness.to_owned(), severity.to_owned())).or_default();
            *total = total.checked_add(count).ok_or("numeric_out_of_range")?;
        }
        Ok(counts.into_iter().map(|((harness_id, severity), count)| json!({"harness_id":harness_id,"severity":severity,"count":count})).collect())
    };

    let backlog = aggregate(stats::finding_counts(db.conn(), from_ms, inclusive_end, "current_backlog")
        .map_err(|_| "data_unavailable")?)?;
    let window_new = aggregate(stats::finding_counts(db.conn(), from_ms, inclusive_end, "window_new")
        .map_err(|_| "data_unavailable")?)?;
    let capabilities = identities.iter().map(|(harness_id, identity)| json!({
        "harness_id":harness_id,
        "available":identity.findings,
        "reason":if identity.findings { Value::Null } else { json!("findings_not_supported") }
    })).collect::<Vec<_>>();
    Ok(json!({
        "protocol":"finding-summary:v1",
        "data_revision":revision,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},
        "current_backlog":backlog,
        "window_new":window_new,
        "capabilities":capabilities
    }))
}

/// Bounded, redacted skill observations across harnesses. Labels are cleaned
/// presentation excerpts; finish outcomes are observations and are not paired
/// with invocations. Inventory is deliberately excluded.
pub fn skill_usage_summary(home: &Path, days: u16, to_ms: i64, expected_revision: u64) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let mut rows = stats::skill_activity(db.conn(), from_ms, to_ms, None).map_err(|_| "data_unavailable")?;
    let ids = identities(db.conn(), home)?;
    rows.retain(|row| ids.contains_key(row["harness"].as_str().unwrap_or("")));
    for row in &mut rows {
        let name = row["skill"].as_str().unwrap_or("");
        let safe = if name.starts_with('/') || name.contains('\\') { None } else {
            agent_vitals_domain::enrichment::make_presentation_excerpt(name, agent_vitals_domain::enrichment::ExcerptRole::UserTurn)
                .map(|value| value.text)
        };
        row["skill"] = json!(safe.unwrap_or_else(|| "<redacted>".to_owned()));
    }
    let truncated = rows.len() > 200;
    rows.truncate(200);
    Ok(json!({"protocol":"skill-usage-summary:v1","data_revision":revision,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},"skills":rows,
        "truncated":truncated,"coverage":"observed_workflow_events_only",
        "outcome_scope":"unpaired_finish_events","inventory_included":false}))
}

/// Fixed event-family summary. It never exposes event IDs, native anchors,
/// arguments, fingerprints or raw errors.
pub fn workflow_activity_summary(home: &Path, days: u16, to_ms: i64, expected_revision: u64) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let mut rows = stats::workflow_activity(db.conn(), from_ms, to_ms, None).map_err(|_| "data_unavailable")?;
    let truncated = rows.len() > 200;
    rows.truncate(200);
    Ok(json!({"protocol":"workflow-activity-summary:v1","data_revision":revision,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},"events":rows,"truncated":truncated,
        "coverage":"observed_workflow_events_only","outcome_scope":"unpaired_events"}))
}

/// Read a bounded generic session detail by a plugin-scoped opaque handle.
/// Excerpts are a separate opt-in and always describe lifetime scope; pricing
/// stays in its own dataset so the caller must explicitly authorize it.
pub fn session_detail(
    home: &Path,
    plugin_id: &str,
    session_handle: &str,
    days: u16,
    to_ms: i64,
    expected_revision: u64,
    include_excerpts: bool,
) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    if plugin_id.is_empty() || plugin_id.len() > 64
        || !plugin_id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
        return Err("invalid_plugin_scope");
    }
    if session_handle.len() != 35 || !session_handle.starts_with("sr_")
        || !session_handle[3..].bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("invalid_session_handle"); }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let inclusive_end = to_ms.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let salt = super::session_ref::load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let scope = format!("app:{plugin_id}:");
    let mut stmt = db.conn().prepare("SELECT session_key FROM sessions WHERE deleted_at_ms IS NULL")
        .map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|_| "data_unavailable")?;
    let mut key = None;
    for row in rows {
        let candidate = row.map_err(|_| "data_unavailable")?;
        if super::session_ref::session_ref(&salt, &format!("{scope}{candidate}")) == session_handle {
            key = Some(candidate);
            break;
        }
    }
    let key = key.ok_or("session_unavailable")?;
    let keys = [key.clone()];
    let rows = stats::session_page_for_keys(db.conn(), from_ms, inclusive_end, 1, 0, Some(&keys))
        .map_err(|_| "data_unavailable")?;
    let row = rows.first().ok_or("session_outside_window")?;
    let models = stats::model_distribution(db.conn(), from_ms, inclusive_end, Some(&keys))
        .map_err(|_| "data_unavailable")?;
    let identities = identities(db.conn(), home)?;
    let mut detail = super::app_local::projected_session(row, &models, &salt,
        identities.contains_key(row["harness"].as_str().unwrap_or("")))?;
    // projected_session is still shared by the legacy City face; typed detail
    // must echo the already-authorized plugin-scoped handle supplied above.
    detail["id"] = json!(session_handle);
    detail["window"] = json!({"days":days,"from_ms":from_ms,"to_ms":to_ms});
    if include_excerpts {
        let excerpts = stats::excerpt_candidates(db.conn(), &keys).map_err(|_| "detail_unavailable")?;
        let excerpts = super::app_local::clean_excerpts(&excerpts);
        let available = !excerpts.is_empty();
        detail["excerpts"] = json!(excerpts);
        detail["excerpt_scope"] = json!("session_lifetime");
        detail["excerpt_availability"] = json!({"available":available,
            "reason":if available { Value::Null } else { json!("no_usable_excerpt_candidates") }});
    }
    Ok(json!({"protocol":"harness-session-detail:v1","data_revision":revision,"session":detail}))
}

/// Currency- and basis-aware cost projection for one plugin-scoped session.
/// It intentionally remains separate from detail and excerpts authorization.
pub fn session_cost(home: &Path, plugin_id: &str, session_handle: &str, days: u16, to_ms: i64,
    expected_revision: u64) -> Result<Value, &'static str> {
    use agent_vitals_data::{authority_query as billing, session_statistics as stats};
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let inclusive_end = to_ms.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let salt = super::session_ref::load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let scope = format!("app:{plugin_id}:");
    let mut stmt = db.conn().prepare("SELECT session_key FROM sessions WHERE deleted_at_ms IS NULL").map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|_| "data_unavailable")?;
    let mut key = None;
    for row in rows {
        let candidate = row.map_err(|_| "data_unavailable")?;
        if super::session_ref::session_ref(&salt, &format!("{scope}{candidate}")) == session_handle { key = Some(candidate); break; }
    }
    let key = key.ok_or("session_unavailable")?;
    let keys = [key.clone()];
    let rows = stats::session_page_for_keys(db.conn(), from_ms, inclusive_end, 1, 0, Some(&keys)).map_err(|_| "data_unavailable")?;
    let row = rows.first().ok_or("session_outside_window")?;
    let total_tokens = row["tokens"]["total"].as_i64().ok_or("data_unavailable")?;
    let buckets = billing::sessions_billing_buckets_with_reference_in_window(db.conn(), &keys, Some((from_ms, inclusive_end)))
        .map_err(|_| "cost_unavailable")?;
    let cost = session_cost_breakdown(buckets.get(&key).map(Vec::as_slice).unwrap_or(&[]), total_tokens)?;
    Ok(json!({"protocol":"session-cost:v1","data_revision":revision,"session_ref":session_handle,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},"cost":cost}))
}

pub(crate) fn session_cost_breakdown(buckets: &[Value], total_tokens: i64) -> Result<Value, &'static str> {
    use agent_vitals_data::authority_query as billing;
    let mut groups: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut covered = 0i64;
    let mut priced = 0i64;
    let mut subscription = 0i64;
    let mut unresolved = false;
    let mut sources = std::collections::BTreeSet::new();
    for bucket in buckets {
        let tokens = bucket["tokens"]["total"].as_i64().ok_or("data_unavailable")?;
        covered = covered.checked_add(tokens).ok_or("numeric_out_of_range")?;
        unresolved |= bucket["has_unresolved"].as_bool().unwrap_or(true);
        if let Some(source) = bucket["pricing_source"].as_str() { sources.insert(source); }
        if bucket["billing_mode"] == "subscription" { subscription = subscription.checked_add(tokens).ok_or("numeric_out_of_range")?; }
        if let Some(amount) = bucket["cost_minor"]["amount_minor"].as_i64() {
            let key = (bucket["cost_minor"]["currency"].as_str().ok_or("data_unavailable")?.to_owned(),
                bucket["cost_minor"]["basis"].as_str().ok_or("data_unavailable")?.to_owned());
            let sum = groups.entry(key).or_default();
            *sum = sum.checked_add(amount).ok_or("numeric_out_of_range")?;
            priced = priced.checked_add(tokens).ok_or("numeric_out_of_range")?;
        }
    }
    if covered > total_tokens { return Err("data_unavailable"); }
    let legacy = total_tokens - covered;
    let unpriced = covered.checked_sub(priced).and_then(|value| value.checked_sub(subscription)).ok_or("data_unavailable")?;
    if groups.len() > 100 { return Err("detail_budget_exceeded"); }
    let mut view = billing::session_cost_view_from_buckets(buckets);
    let complete = legacy == 0 && unpriced == 0;
    if !complete || groups.len() > 1 { view["cost_minor"] = Value::Null; }
    if legacy > 0 { view["status"] = json!("unavailable"); view["reason"] = json!("legacy_aggregate_not_priced"); }
    if unpriced > 0 && priced > 0 { view["status"] = json!("unavailable"); view["reason"] = json!("partially_priced"); }
    view["has_unresolved"] = json!(unresolved || !complete);
    view["complete"] = json!(complete);
    view["coverage"] = json!({"priced_tokens":priced,"subscription_tokens":subscription,"unpriced_tokens":unpriced,"legacy_tokens":legacy});
    view["pricing_sources"] = json!(sources);
    view["breakdown"] = json!(groups.into_iter().map(|((currency, basis), amount_minor)| json!({"currency":currency,"basis":basis,"amount_minor":amount_minor})).collect::<Vec<_>>());
    Ok(view)
}

/// Resolve previously-issued opaque source refs to generic lifecycle state.
/// The private session keys remain inside this query boundary and are never
/// included in the returned DTO.
pub fn session_source_status(
    home: &Path,
    plugin_id: &str,
    stable_refs: &[String],
    days: u16,
    to_ms: i64,
    expected_revision: u64,
) -> Result<Value, &'static str> {
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    if plugin_id.is_empty() || plugin_id.len() > 64
        || !plugin_id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
        return Err("invalid_plugin_scope");
    }
    if stable_refs.len() > 200 || stable_refs.iter().any(|reference| reference.len() != 36
        || !reference.starts_with("srp_") || !reference[4..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        || stable_refs.iter().collect::<std::collections::BTreeSet<_>>().len() != stable_refs.len() {
        return Err("invalid_stable_ref_request");
    }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from_ms = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    // The DTO exposes a half-open [from_ms, to_ms) window. Keep this query
    // aligned with City v3, which passes its inclusive end as to_ms - 1.
    let end_ms = to_ms.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    if stable_refs.is_empty() {
        return Ok(json!({"protocol":"session-source-status:v1","data_revision":revision,
            "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},"sources":[]}));
    }

    let object_store = super::object_store::ObjectStore::open(home, plugin_id).map_err(|_| "stable_ref_unavailable")?;
    let mut matched = std::collections::BTreeMap::<String,(String,Option<i64>)>::new();
    {
        let mut stmt = db.conn().prepare("SELECT session_key,deleted_at_ms FROM sessions ORDER BY session_key")
            .map_err(|_| "data_unavailable")?;
        let mut rows = stmt.query([]).map_err(|_| "data_unavailable")?;
        let mut batch = Vec::with_capacity(500);
        loop {
            while batch.len() < 500 {
                match rows.next().map_err(|_| "data_unavailable")? {
                    Some(row) => batch.push((row.get::<_,String>(0).map_err(|_| "data_unavailable")?,
                        row.get::<_,Option<i64>>(1).map_err(|_| "data_unavailable")?)),
                    None => break,
                }
            }
            if batch.is_empty() { break; }
            let keys = batch.iter().map(|(key,_)| key.clone()).collect::<Vec<_>>();
            let references = object_store.match_stable_source_refs("harness-sessions:v4",&keys,stable_refs)
                .map_err(|_| "stable_ref_unavailable")?;
            for ((source_key,deleted_at),reference) in batch.drain(..).zip(references) {
                if let Some(reference) = reference { matched.insert(reference,(source_key,deleted_at)); }
            }
        }
    }
    let active_keys = matched.values().filter(|(_,deleted_at)| deleted_at.is_none())
        .map(|(key,_)| key.clone()).collect::<Vec<_>>();
    let mut visible = std::collections::BTreeSet::new();
    if !active_keys.is_empty() {
        let mut stmt = db.conn().prepare("SELECT DISTINCT session_key FROM usage_facts
            WHERE deleted_at_ms IS NULL AND event_ts_ms>=?1 AND event_ts_ms<=?2
              AND session_key IN (SELECT value FROM json_each(?3))")
            .map_err(|_| "data_unavailable")?;
        let rows = stmt.query_map(rusqlite::params![from_ms,end_ms,serde_json::to_string(&active_keys).map_err(|_| "data_unavailable")?],
            |row| row.get::<_,String>(0)).map_err(|_| "data_unavailable")?;
        visible = rows.collect::<Result<std::collections::BTreeSet<_>,_>>().map_err(|_| "data_unavailable")?;
    }
    let sources = stable_refs.iter().map(|reference| {
        let state = match matched.get(reference) {
            None => ("missing",None),
            Some((_,Some(_))) => ("deleted",None),
            Some((key,None)) => ("active",Some(visible.contains(key))),
        };
        json!({"stable_ref":reference,"state":state.0,"has_usage_in_window":state.1})
    }).collect::<Vec<_>>();
    Ok(json!({"protocol":"session-source-status:v1","data_revision":revision,
        "window":{"days":days,"from_ms":from_ms,"to_ms":to_ms},"sources":sources}))
}

/// Generic session statistics; no City DTO, task excerpts, raw ids or paths.
pub fn sessions(home: &Path, id: &str, days: u16, now: i64, expected_revision: u64, scope: &str) -> Result<Value, &'static str> {
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    if !identities(db.conn(), home)?.contains_key(id) { return Err("harness_unavailable"); }
    let from = now.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let salt = super::session_ref::load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let mut stmt = db.conn().prepare("SELECT s.session_key,MIN(f.event_ts_ms),MAX(f.event_ts_ms),COUNT(*),
        SUM(f.uncached_input_tokens+f.cache_read_tokens+f.cache_write_tokens),SUM(f.output_tokens)
        FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
        WHERE s.harness=?1 AND f.harness=?1 AND s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL
        AND f.event_ts_ms>=?2 AND f.event_ts_ms<=?3 GROUP BY s.session_key ORDER BY MAX(f.event_ts_ms) DESC,s.session_key LIMIT 500")
        .map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map(rusqlite::params![id,from,now], |r| Ok((r.get::<_, String>(0)?,r.get::<_, i64>(1)?,
        r.get::<_, i64>(2)?,r.get::<_, i64>(3)?,r.get::<_, i64>(4)?,r.get::<_, i64>(5)?))).map_err(|_| "data_unavailable")?;
    let mut sessions = Vec::new();
    for row in rows {
        let (key, first, last, events, input, output) = row.map_err(|_| "data_unavailable")?;
        sessions.push(json!({"id":super::session_ref::session_ref(&salt,&format!("app:{scope}:{key}")),"harness_id":id,
            "first_event_at_ms":first,"last_event_at_ms":last,"event_count":events,
            "tokens":{"input":input,"output":output,"total":input.checked_add(output).ok_or("data_unavailable")?}}));
    }
    let total: i64 = db.conn().query_row("SELECT COUNT(DISTINCT s.session_key) FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
        WHERE s.harness=?1 AND f.harness=?1 AND s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL AND f.event_ts_ms>=?2 AND f.event_ts_ms<=?3",
        rusqlite::params![id,from,now], |r| r.get(0)).map_err(|_| "data_unavailable")?;
    Ok(json!({"protocol":"harness-sessions:v1","data_revision":revision,"harness_id":id,
        "window":{"days":days,"from_ms":from,"to_ms":now},"status":if sessions.is_empty() {"empty"} else {"ready"},
        "coverage":{"total":total,"returned":sessions.len(),"truncated":total>sessions.len() as i64},"sessions":sessions}))
}

/// Read one bounded page from a fixed session window. Unlike `sessions`, this
/// endpoint applies LIMIT/OFFSET after grouping in SQL, so callers can continue
/// past the first 500 sessions without materializing an unbounded result set.
/// `to_ms` is supplied by the first page response on subsequent reads; the
/// revision check pins pages to the same authority-data generation.
#[allow(clippy::too_many_arguments)]
pub fn sessions_page(
    home: &Path,
    id: &str,
    days: u16,
    to_ms: i64,
    expected_revision: u64,
    scope: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, &'static str> {
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    if !(1..=500).contains(&limit) || offset > 4_000 || offset.saturating_add(limit) > 4_000 {
        return Err("invalid_page");
    }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    if !identities(db.conn(), home)?.contains_key(id) { return Err("harness_unavailable"); }

    let total: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM (
            SELECT s.session_key
            FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
            WHERE s.harness=?1 AND f.harness=?1 AND s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL
              AND f.event_ts_ms>=?2 AND f.event_ts_ms<=?3
            GROUP BY s.session_key
        )",
        rusqlite::params![id, from, to_ms],
        |row| row.get(0),
    ).map_err(|_| "data_unavailable")?;
    if offset > usize::try_from(total).map_err(|_| "numeric_out_of_range")? { return Err("invalid_page"); }
    let salt = super::session_ref::load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let mut stmt = db.conn().prepare(
        "SELECT s.session_key,MIN(f.event_ts_ms),MAX(f.event_ts_ms),COUNT(*),
            SUM(f.uncached_input_tokens+f.cache_read_tokens+f.cache_write_tokens),SUM(f.output_tokens)
         FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
         WHERE s.harness=?1 AND f.harness=?1 AND s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL
           AND f.event_ts_ms>=?2 AND f.event_ts_ms<=?3
         GROUP BY s.session_key ORDER BY MAX(f.event_ts_ms) DESC,s.session_key ASC LIMIT ?4 OFFSET ?5",
    ).map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map(rusqlite::params![id, from, to_ms, limit as i64, offset as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?))
    }).map_err(|_| "data_unavailable")?;
    let mut sessions = Vec::new();
    for row in rows {
        let (key, first, last, events, input, output) = row.map_err(|_| "data_unavailable")?;
        sessions.push(json!({"id":super::session_ref::session_ref(&salt,&format!("app:{scope}:{key}")),"harness_id":id,
            "first_event_at_ms":first,"last_event_at_ms":last,"event_count":events,
            "tokens":{"input":input,"output":output,"total":input.checked_add(output).ok_or("data_unavailable")?}}));
    }
    Ok(json!({"protocol":"harness-sessions:v2","data_revision":revision,"harness_id":id,
        "window":{"days":days,"from_ms":from,"to_ms":to_ms},
        "pagination":{"offset":offset,"limit":limit},
        "status":if sessions.is_empty() {"empty"} else {"ready"},
        "coverage":{"total":total,"returned":sessions.len(),
            "truncated":total > (offset as i64).saturating_add(sessions.len() as i64)},
        "sessions":sessions}))
}

/// Generic all-harness session layout page. The output uses an opaque
/// plugin-scoped session reference and only scrubbed, allowlisted session
/// metadata; internal session keys are used only while joining page-local
/// model facts and never leave this function.
pub fn sessions_layout_page(
    home: &Path,
    days: u16,
    to_ms: i64,
    expected_revision: u64,
    scope: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, &'static str> {
    sessions_layout_page_impl(home, days, to_ms, expected_revision, scope, offset, limit, false)
}

/// Same fixed all-harness page with a durable opaque source reference for each row.
/// Only the descriptor-gated `harness-sessions:v4` typed DTO may project that field.
#[allow(clippy::too_many_arguments)]
pub fn sessions_layout_page_with_stable_refs(
    home: &Path,
    days: u16,
    to_ms: i64,
    expected_revision: u64,
    scope: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, &'static str> {
    sessions_layout_page_impl(home, days, to_ms, expected_revision, scope, offset, limit, true)
}

/// All-lifetime session identity directory for bounded migrations and
/// crosswalks. It returns no usage or presentation data and is deliberately
/// separate from the windowed session analytics pages.
pub fn session_identity_page(
    home: &Path,
    expected_revision: u64,
    scope: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, &'static str> {
    const MAX_IDENTITIES: usize = 100_000;
    if !(1..=500).contains(&limit) || offset > MAX_IDENTITIES || offset.saturating_add(limit) > MAX_IDENTITIES {
        return Err("invalid_page");
    }
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let total: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM (
            SELECT s.session_key FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
            WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL GROUP BY s.session_key
        )",
        [],
        |row| row.get(0),
    ).map_err(|_| "data_unavailable")?;
    if offset > usize::try_from(total).map_err(|_| "numeric_out_of_range")? { return Err("invalid_page"); }
    let mut stmt = db.conn().prepare(
        "SELECT s.session_key FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
         WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL
         GROUP BY s.session_key ORDER BY MAX(f.event_ts_ms) DESC,s.session_key LIMIT ?1 OFFSET ?2",
    ).map_err(|_| "data_unavailable")?;
    let keys = stmt.query_map(rusqlite::params![limit as i64, offset as i64], |row| row.get::<_, String>(0))
        .map_err(|_| "data_unavailable")?.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "data_unavailable")?;
    let refs = if keys.is_empty() { Vec::new() } else {
        super::object_store::ObjectStore::open(home, scope)
            .map_err(|_| "stable_ref_unavailable")?
            .stable_source_refs("harness-sessions:v4", &keys, limit)
            .map_err(|_| "stable_ref_unavailable")?
    };
    let salt = super::session_ref::load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let sessions = keys.iter().enumerate().map(|(index, key)| json!({
        "id":super::session_ref::session_ref(&salt, &format!("app:{scope}:{key}")),
        "stable_ref":refs.get(index),
    })).collect::<Vec<_>>();
    Ok(json!({"data_revision":revision,"total":total,"sessions":sessions}))
}

type SessionOrderCacheKey = (PathBuf, u64);
type LifetimeSessionOrderCache = Mutex<BTreeMap<SessionOrderCacheKey, Arc<Vec<String>>>>;

fn lifetime_session_order_cache() -> &'static LifetimeSessionOrderCache {
    static CACHE: OnceLock<LifetimeSessionOrderCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn lifetime_session_keys(home: &Path, revision: u64, conn: &rusqlite::Connection) -> Result<Arc<Vec<String>>, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    let cache_key = (home.to_path_buf(), revision);
    if let Some(keys) = lifetime_session_order_cache().lock().map_err(|_| "data_unavailable")?.get(&cache_key) {
        return Ok(Arc::clone(keys));
    }
    let ordered = stats::session_order(conn, i64::MIN, i64::MAX - 1).map_err(|_| "data_unavailable")?;
    let keys = Arc::new(ordered.into_iter().map(|(key, _, _)| key).collect::<Vec<_>>());
    let byte_size = keys.iter().try_fold(0usize, |total, key| total.checked_add(key.len()))
        .ok_or("numeric_out_of_range")?;
    if byte_size <= 32 * 1024 * 1024 {
        let mut cache = lifetime_session_order_cache().lock().map_err(|_| "data_unavailable")?;
        cache.retain(|(cached_home, _), _| cached_home != home);
        let existing_bytes: usize = cache.values().flat_map(|items| items.iter()).map(String::len).sum();
        if existing_bytes.saturating_add(byte_size) > 32 * 1024 * 1024 { cache.clear(); }
        cache.insert(cache_key, Arc::clone(&keys));
    }
    Ok(keys)
}

/// All-lifetime session layout DTO source. Unlike the analytics-window pages,
/// this fixed generic query has no time predicate and is bounded to 100,000
/// records across revision-pinned pages.
pub fn sessions_lifetime_page(
    home: &Path,
    expected_revision: u64,
    scope: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    const MAX_TOTAL: usize = 100_000;
    if !(1..=500).contains(&limit) || offset > MAX_TOTAL || offset.saturating_add(limit) > MAX_TOTAL {
        return Err("invalid_page");
    }
    let from = i64::MIN;
    let to = i64::MAX;
    let end = to.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let ordered_keys = lifetime_session_keys(home, revision, db.conn())?;
    let total = ordered_keys.len();
    if offset > total { return Err("invalid_page"); }
    let page_keys = ordered_keys.get(offset..offset.saturating_add(limit).min(total)).ok_or("invalid_page")?;
    let rows = stats::session_page_for_keys(db.conn(), from, end, page_keys.len(), 0, Some(page_keys))
        .map_err(|_| "data_unavailable")?;
    let keys = rows.iter().map(|row| row["session_key"].as_str().map(str::to_owned)
        .ok_or("data_unavailable")).collect::<Result<Vec<_>, _>>()?;
    let stable_refs = if keys.is_empty() { Vec::new() } else {
        super::object_store::ObjectStore::open(home, scope)
            .map_err(|_| "stable_ref_unavailable")?
            .stable_source_refs("harness-sessions:v4", &keys, limit)
            .map_err(|_| "stable_ref_unavailable")?
    };
    let model_rows = stats::model_distribution(db.conn(), from, end, Some(&keys))
        .map_err(|_| "data_unavailable")?;
    let mut models_by_key: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for model in &model_rows {
        if let Some(key) = model["session_key"].as_str() { models_by_key.entry(key).or_default().push(model); }
    }
    let identities = identities(db.conn(), home)?;
    let salt = super::session_ref::load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let mut sessions = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let key = row["session_key"].as_str().ok_or("data_unavailable")?;
        let raw_harness = row["harness"].as_str().ok_or("data_unavailable")?;
        let harness = if identities.contains_key(raw_harness) { raw_harness } else { "unknown" };
        let title = row["title"].as_str().and_then(agent_vitals_domain::enrichment::bound_session_title);
        let title_source = if title.is_some() {
            row["title_source"].as_str().filter(|source| matches!(*source,
                "codex_thread_name" | "claude_ai_title" | "dsh_workspace_title" | "zcode_session_title"))
        } else { None };
        let mut model_ids = std::collections::BTreeSet::new();
        let mut unknown_model_events = 0i64;
        let mut legacy_events = 0i64;
        for model in models_by_key.get(key).into_iter().flatten() {
            let events = model["usage_event_count"].as_i64().ok_or("data_unavailable")?;
            if model["legacy"] == true { legacy_events = legacy_events.checked_add(events).ok_or("numeric_out_of_range")?; }
            match model["model_id"].as_str().filter(|id| valid_model_id(id)) {
                Some(id) => { model_ids.insert(id.to_owned()); }
                None => { unknown_model_events = unknown_model_events.checked_add(events).ok_or("numeric_out_of_range")?; }
            }
        }
        let tokens = &row["tokens"];
        sessions.push(json!({
            "id":super::session_ref::session_ref(&salt, &format!("app:{scope}:{key}")),
            "harness_id":harness,
            "title":title,
            "title_source":title_source,
            "window_first_event_at_ms":row["window_first_ms"],
            "window_last_event_at_ms":row["window_last_ms"],
            "window_order":row["layout_order"],
            "lifetime_first_event_at_ms":row["lifetime_first_ms"],
            "lifetime_last_event_at_ms":row["lifetime_last_ms"],
            "event_count":row["usage_event_count"],
            "tokens":{"input":tokens["input"],"output":tokens["output"],"total":tokens["total"],
                "uncached_input":tokens["uncached_input"],"cache_read":tokens["cache_read"],"cache_write":tokens["cache_write"]},
            "model_ids":model_ids,
            "model_coverage":{"unknown_model_usage_events":unknown_model_events,"legacy_usage_events":legacy_events},
            "stable_ref":stable_refs.get(index).ok_or("stable_ref_unavailable")?,
        }));
    }
    Ok(json!({"data_revision":revision,"total":total,"sessions":sessions}))
}

#[allow(clippy::too_many_arguments)]
fn sessions_layout_page_impl(
    home: &Path,
    days: u16,
    to_ms: i64,
    expected_revision: u64,
    scope: &str,
    offset: usize,
    limit: usize,
    include_stable_refs: bool,
) -> Result<Value, &'static str> {
    use agent_vitals_data::session_statistics as stats;
    const MAX_TOTAL: usize = 4_000;
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    if !(1..=500).contains(&limit) || offset > MAX_TOTAL || offset.saturating_add(limit) > MAX_TOTAL {
        return Err("invalid_page");
    }
    let now = agent_vitals_runtime_core::core::clock::now_ms();
    if to_ms > now || to_ms < now.saturating_sub(10 * 60 * 1_000) { return Err("snapshot_expired"); }
    let from = to_ms.checked_sub(i64::from(days) * 86_400_000).ok_or("invalid_window")?;
    let end = to_ms.checked_sub(1).ok_or("invalid_window")?;
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    if revision != expected_revision { return Err("revision_changed"); }
    let identities = identities(db.conn(), home)?;
    let total: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM (
            SELECT s.session_key FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
            WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL
              AND f.event_ts_ms>=?1 AND f.event_ts_ms<?2 GROUP BY s.session_key
        )",
        rusqlite::params![from, to_ms],
        |row| row.get(0),
    ).map_err(|_| "data_unavailable")?;
    let rows = stats::session_page_for_keys(db.conn(), from, end, limit, offset, None)
        .map_err(|_| "data_unavailable")?;
    let keys = rows.iter().map(|row| row["session_key"].as_str().map(str::to_owned)
        .ok_or("data_unavailable")).collect::<Result<Vec<_>, _>>()?;
    let stable_refs = if include_stable_refs {
        let mut store = super::object_store::ObjectStore::open(home, scope)
            .map_err(|_| "stable_ref_unavailable")?;
        store.stable_source_refs("harness-sessions:v4", &keys, limit)
            .map_err(|_| "stable_ref_unavailable")?
    } else { Vec::new() };
    let model_rows = stats::model_distribution(db.conn(), from, end, Some(&keys))
        .map_err(|_| "data_unavailable")?;
    let mut models_by_key: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for model in &model_rows {
        if let Some(key) = model["session_key"].as_str() { models_by_key.entry(key).or_default().push(model); }
    }
    let salt = super::session_ref::load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let mut sessions = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let key = row["session_key"].as_str().ok_or("data_unavailable")?;
        let raw_harness = row["harness"].as_str().ok_or("data_unavailable")?;
        let harness = if identities.contains_key(raw_harness) { raw_harness } else { "unknown" };
        let title = row["title"].as_str().and_then(agent_vitals_domain::enrichment::bound_session_title);
        let source = if title.is_some() {
            row["title_source"].as_str().filter(|source| matches!(*source,
                "codex_thread_name" | "claude_ai_title" | "dsh_workspace_title" | "zcode_session_title"))
        } else { None };
        let mut model_ids = std::collections::BTreeSet::new();
        let mut unknown_model_events = 0i64;
        let mut legacy_events = 0i64;
        for model in models_by_key.get(key).into_iter().flatten() {
            let events = model["usage_event_count"].as_i64().ok_or("data_unavailable")?;
            if model["legacy"] == true { legacy_events = legacy_events.checked_add(events).ok_or("numeric_out_of_range")?; }
            match model["model_id"].as_str().filter(|id| valid_model_id(id)) {
                Some(id) => { model_ids.insert(id.to_owned()); }
                None => { unknown_model_events = unknown_model_events.checked_add(events).ok_or("numeric_out_of_range")?; }
            }
        }
        let tokens = &row["tokens"];
        let mut session = json!({
            "id":super::session_ref::session_ref(&salt, &format!("app:{scope}:{key}")),
            "harness_id":harness,
            "title":title,
            "title_source":source,
            "window_first_event_at_ms":row["window_first_ms"],
            "window_last_event_at_ms":row["window_last_ms"],
            "window_order":row["layout_order"],
            "lifetime_first_event_at_ms":row["lifetime_first_ms"],
            "lifetime_last_event_at_ms":row["lifetime_last_ms"],
            "event_count":row["usage_event_count"],
            "tokens":{
                "input":tokens["input"], "output":tokens["output"], "total":tokens["total"],
                "uncached_input":tokens["uncached_input"], "cache_read":tokens["cache_read"], "cache_write":tokens["cache_write"]
            },
            "model_ids":model_ids,
            "model_coverage":{"unknown_model_usage_events":unknown_model_events,"legacy_usage_events":legacy_events}
        });
        if include_stable_refs { session["stable_ref"] = json!(stable_refs.get(index).ok_or("stable_ref_unavailable")?); }
        sessions.push(session);
    }
    Ok(json!({
        "protocol":"harness-sessions:v3",
        "data_revision":revision,
        "harness_id":null,
        "window":{"days":days,"from_ms":from,"to_ms":to_ms},
        "coverage":{"total":total,"returned":sessions.len(),
            "truncated":total > (offset as i64).saturating_add(sessions.len() as i64)},
        "sessions":sessions
    }))
}

fn valid_model_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b':'))
}

pub fn inventory(home: &Path, days: u16, now: i64) -> Result<Value, &'static str> {
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let db = snapshot(home)?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    let mut items = identities(db.conn(), home)?;
    let (candidates, errors) = crate::harness_registry::scan_plugin_harnesses(home);
    for candidate in candidates {
        items.entry(format!("harness:{}",candidate.slug)).or_insert(Identity { name:candidate.display_name.chars().take(100).collect(),
            registration:"candidate",findings:false,diagnostic:Some("activation_required") });
    }
    // Invalid candidates remain visible to the host for diagnosis, but never
    // expose their path or parser error. Only a validated directory slug is a
    // safe public identifier.
    let invalid_candidates: Vec<Value> = errors.iter().filter_map(|error| {
        let slug = error.manifest_path.parent()?.file_name()?.to_str()?;
        if !crate::harness_registry::plugin_slug_ok(slug) { return None; }
        Some(json!({"id":format!("harness:{slug}"),"display_name":slug,
            "registration_state":"invalid","diagnostic":"manifest_invalid"}))
    }).collect();
    let from = now.checked_sub(i64::from(days)*86_400_000).ok_or("invalid_window")?;
    let mut result = Vec::new();
    for (id, item) in items {
        let (total, window): (i64,i64) = db.conn().query_row("SELECT COUNT(*),COALESCE(SUM(CASE WHEN event_ts_ms>=?2 AND event_ts_ms<=?3 THEN 1 ELSE 0 END),0)
            FROM usage_facts WHERE harness=?1 AND deleted_at_ms IS NULL", rusqlite::params![id,from,now], |r| Ok((r.get(0)?,r.get(1)?)))
            .map_err(|_| "data_unavailable")?;
        result.push(json!({"id":id,"display_name":item.name,"registration_state":item.registration,
            "data_state":if window>0 {"ready"} else if total>0 {"empty_window"} else {"not_ingested"},
            "facts_total":total,"facts_in_window":window,"diagnostic":item.diagnostic}));
    }
    Ok(json!({"data_revision":revision,"observed_at_ms":now,"window_days":days,"harnesses":result,
        "invalid_candidates":invalid_candidates,"health_state":"not_observed"}))
}
