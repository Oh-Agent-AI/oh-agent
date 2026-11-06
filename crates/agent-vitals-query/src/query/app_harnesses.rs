//! Same-host plugin face. Installation mechanism never appears in public identities.
use std::{collections::BTreeMap, path::Path};
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
