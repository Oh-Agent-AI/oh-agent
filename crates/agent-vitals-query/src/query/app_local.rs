//! Explicit local-presentation projection; never reused by MCP or export.
use std::path::Path;
use agent_vitals_data::authority::{AuthorityDb, default_authority_path};
use agent_vitals_domain::enrichment::{ExcerptRole, make_presentation_excerpt};
use serde_json::{Value, json};
use super::session_ref::{load_or_create_salt, session_ref};

/// City 一次载入的会话上限：366 天窗口内最多 4000 条（岛初始规划 2000 栋、扩展到 4000 栋）。
/// 曾是 500：一年的数据只载入最近 500 条，城市是被截断的半年历史。
pub const SESSION_CAP: usize = 4_000;

/// Resolve `HMAC(app:{plugin_id}:{session_key})` for whichever plugin minted the handle.
/// Authorization is the descriptor (`navigationTargets`), not a plugin-name branch.
/// A handle issued to one plugin does not open under another plugin's id.
pub fn plugin_session_target(data_home: &Path, plugin_id: &str, handle: &str) -> Result<(String, String), &'static str> {
    if !plugin_scope_ok(plugin_id) { return Err("navigation_unavailable"); }
    if handle.len() != 35 || !handle.starts_with("sr_") || !handle[3..].bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid_session_handle"); }
    let db = AuthorityDb::open_readonly(&default_authority_path(data_home)).map_err(|_| "data_unavailable")?;
    let salt = load_or_create_salt(data_home).map_err(|_| "data_unavailable")?;
    let mut stmt = db.conn().prepare("SELECT session_key, harness FROM sessions WHERE deleted_at_ms IS NULL").map_err(|_| "data_unavailable")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|_| "data_unavailable")?;
    let prefix = format!("app:{plugin_id}:");
    for row in rows {
        let (key, harness) = row.map_err(|_| "data_unavailable")?;
        if session_ref(&salt, &format!("{prefix}{key}")) == handle { return Ok((session_ref(&salt, &key), harness)); }
    }
    Err("session_unavailable")
}

fn plugin_scope_ok(plugin_id: &str) -> bool {
    let bytes = plugin_id.as_bytes();
    !bytes.is_empty() && bytes.len() <= 64
        && bytes.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// City projections still mint `app:city:…`. Same resolver, scope `city`.
pub fn city_session_target(data_home: &Path, handle: &str) -> Result<(String, String), &'static str> {
    plugin_session_target(data_home, "city", handle)
}
fn timestamp(ms: i64) -> Result<String, &'static str> {
    jiff::Timestamp::from_millisecond(ms).map(|t| t.to_string()).map_err(|_| "invalid_window")
}

/// Reject unsafe JSON integers instead of silently losing precision in JavaScript.
pub(crate) fn safe_numbers(value: &Value) -> Result<(), &'static str> {
    match value {
        Value::Number(n) if n.as_i64().is_some_and(|n| !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n))
            || n.as_u64().is_some_and(|n| n > 9_007_199_254_740_991) => Err("numeric_out_of_range"),
        Value::Array(items) => { for item in items { safe_numbers(item)?; } Ok(()) }
        Value::Object(items) => { for item in items.values() { safe_numbers(item)?; } Ok(()) }
        _ => Ok(()),
    }
}

pub(crate) fn clean_excerpts(candidates: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for candidate in candidates {
        let role = candidate["role"].as_str().unwrap_or("");
        let Some(role_value) = ExcerptRole::from_wire(role) else { continue };
        if let Some(clean) = make_presentation_excerpt(candidate["text"].as_str().unwrap_or(""), role_value) {
            if clean.text.trim().is_empty() || !seen.insert(clean.text.clone()) { continue; }
            out.push(json!({"role":role,"text":clean.text,"provenance":if clean.provenance.as_str()=="verbatim" {
                candidate["provenance"].as_str().unwrap_or("scrubbed")
            } else { clean.provenance.as_str() },"is_excerpt":true,"scope":"session","excerpt_at":null}));
            if out.len()==2 { break; }
        }
    }
    out
}

pub(crate) fn model_summary(rows: &[Value]) -> Result<Value, &'static str> {
    let models: std::collections::BTreeSet<&str> = rows.iter().filter_map(|row| row["model_id"].as_str()).collect();
    let mut unknown = 0i64;
    let mut legacy = 0i64;
    for row in rows {
        let n = row["usage_event_count"].as_i64().ok_or("data_unavailable")?;
        if row["model_id"].is_null() { unknown = unknown.checked_add(n).ok_or("numeric_out_of_range")?; }
        if row["legacy"]==true { legacy = legacy.checked_add(n).ok_or("numeric_out_of_range")?; }
    }
    Ok(json!({"model_ids":models,"unknown_model_usage_events":unknown,"legacy_usage_events":legacy,
        "scope":"window","pricing_independent":true}))
}

pub(crate) fn projected_session(row: &Value, models: &[Value], salt: &[u8;32], known_harness: bool) -> Result<Value, &'static str> {
    let key = row["session_key"].as_str().ok_or("data_unavailable")?;
    let title = row["title"].as_str().and_then(agent_vitals_domain::enrichment::bound_session_title);
    let source = row["title_source"].as_str().filter(|s| !s.trim().is_empty() && s.len()<=100
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_:-.".contains(&b)));
    Ok(json!({"id":session_ref(salt,&format!("app:city:{key}")),
        "harness":if known_harness { row["harness"].as_str().unwrap_or("unknown") } else { "unknown" },
        "title":title,"title_source":if title.is_some() { source } else { None },
        "title_state":if title.is_some() { "available" } else { "unavailable" },
        "title_reason":if title.is_some() { Value::Null } else { json!("source_title_unavailable") },
        "first_event_at":timestamp(row["window_first_ms"].as_i64().ok_or("data_unavailable")?)?,
        "last_event_at":timestamp(row["window_last_ms"].as_i64().ok_or("data_unavailable")?)?,
        "window_first_event_at":timestamp(row["window_first_ms"].as_i64().ok_or("data_unavailable")?)?,
        "window_last_event_at":timestamp(row["window_last_ms"].as_i64().ok_or("data_unavailable")?)?,
        "lifetime_first_event_at":row["lifetime_first_ms"].as_i64().map(timestamp).transpose()?,
        "lifetime_last_event_at":row["lifetime_last_ms"].as_i64().map(timestamp).transpose()?,
        "layout_order":row["layout_order"],"event_count":row["usage_event_count"],"usage_event_count":row["usage_event_count"],
        "tokens":row["tokens"],"model_ids":model_summary(models)?["model_ids"],"model_coverage":model_summary(models)?}))
}

pub(crate) fn activity(conn: &rusqlite::Connection, from: i64, to_exclusive: i64, timezone: &str) -> Result<Value, &'static str> {
    let tz = jiff::tz::TimeZone::get(timezone).map_err(|_| "invalid_timezone")?;
    let mut date = jiff::Timestamp::from_millisecond(from).map_err(|_| "invalid_window")?.to_zoned(tz.clone()).date();
    let mut boundaries = Vec::new();
    loop {
        let start = date.to_zoned(tz.clone()).map_err(|_| "invalid_timezone")?.timestamp().as_millisecond();
        if start>=to_exclusive { break; }
        let next = date.tomorrow().map_err(|_| "invalid_window")?;
        let end = next.to_zoned(tz.clone()).map_err(|_| "invalid_timezone")?.timestamp().as_millisecond();
        boundaries.push(json!({"date":date.to_string(),"from_ms":start.max(from),"to_ms":end.min(to_exclusive)}));
        if boundaries.len()>368 { return Err("invalid_window"); }
        date = next;
    }
    let days = agent_vitals_data::session_statistics::daily_activity(conn,&json!(boundaries)).map_err(|_| "data_unavailable")?;
    let busiest = days.iter().max_by(|a,b| a["session_count"].as_i64().cmp(&b["session_count"].as_i64())
        .then_with(|| a["tokens"].as_i64().cmp(&b["tokens"].as_i64())).then_with(|| a["date"].as_str().cmp(&b["date"].as_str())));
    Ok(json!({"days":days,"busiest_day":busiest,"timezone":timezone,
        "busiest_order":["active_sessions_desc","tokens_desc","date_desc"],"scope":"all_matching_sessions"}))
}

/// v2 retains inclusive endpoints and its 4000-building compatibility load.
/// SQL work is set-based, including billing and excerpts, independent of building count.
pub fn city_projection(data_home: &Path, days: u16, now: i64) -> Result<Value, &'static str> {
    use agent_vitals_data::{session_statistics as stats, authority_query as billing};
    if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
    let from = now.checked_sub(i64::from(days)*86_400_000).ok_or("invalid_window")?;
    let db = AuthorityDb::open_readonly(&default_authority_path(data_home)).map_err(|_| "data_unavailable")?;
    let salt = load_or_create_salt(data_home).map_err(|_| "data_unavailable")?;
    db.conn().execute_batch("BEGIN DEFERRED").map_err(|_| "data_unavailable")?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    let identities = super::app_harnesses::identities(db.conn(),data_home)?;
    let summary = stats::window_summary(db.conn(),from,now).map_err(|_| "data_unavailable")?;
    let time_coverage = stats::time_coverage(db.conn()).map_err(|_| "data_unavailable")?;
    let models = stats::model_distribution(db.conn(),from,now,None).map_err(|_| "data_unavailable")?;
    let mut rows = stats::session_page(db.conn(),from,now,SESSION_CAP,0).map_err(|_| "data_unavailable")?;
    rows.sort_by(|a,b| a["window_first_ms"].as_i64().cmp(&b["window_first_ms"].as_i64()).then_with(|| a["session_key"].as_str().cmp(&b["session_key"].as_str())));
    let keys: Vec<String> = rows.iter().filter_map(|r| r["session_key"].as_str().map(str::to_string)).collect();
    let buckets = billing::sessions_billing_buckets_with_reference_in_window(db.conn(),&keys,Some((from,now))).map_err(|_| "data_unavailable")?;
    let excerpt_rows = stats::excerpt_candidates(db.conn(),&keys).map_err(|_| "data_unavailable")?;
    let mut models_by_key: std::collections::BTreeMap<&str,Vec<Value>> = std::collections::BTreeMap::new();
    for model in &models { if let Some(key)=model["session_key"].as_str() { models_by_key.entry(key).or_default().push(model.clone()); } }
    let mut excerpts_by_key: std::collections::BTreeMap<&str,Vec<Value>> = std::collections::BTreeMap::new();
    for excerpt in &excerpt_rows { if let Some(key)=excerpt["session_key"].as_str() { excerpts_by_key.entry(key).or_default().push(excerpt.clone()); } }
    let mut sessions = Vec::new();
    for row in rows {
        let key = row["session_key"].as_str().ok_or("data_unavailable")?;
        let mut session = projected_session(&row,models_by_key.get(key).map(Vec::as_slice).unwrap_or(&[]),&salt,
            identities.contains_key(row["harness"].as_str().unwrap_or("")))?;
        let bucket = buckets.get(key).map(Vec::as_slice).unwrap_or(&[]);
        let mut cost = super::city_v3::cost_breakdown(bucket,row["tokens"]["total"].as_i64().ok_or("data_unavailable")?)?;
        if cost["reason"]=="legacy_aggregate_not_priced" { cost["reason"]=json!("legacy-aggregate-not-priced"); }
        session["cost_minor"] = cost["cost_minor"].clone();
        session["cost_breakdown"] = cost["breakdown"].clone();
        session["cost_complete"] = cost["complete"].clone();
        if let Some(reference) = cost.get("reference_prices") { session["cost_reference_prices"] = reference.clone(); }
        session["cost_status"] = json!({"state":cost["status"],"reason":cost["reason"],"has_unresolved":cost["has_unresolved"]});
        session["task_excerpts"] = json!(clean_excerpts(excerpts_by_key.get(key).map(Vec::as_slice).unwrap_or(&[])));
        sessions.push(session);
    }
    let mut grouped = std::collections::BTreeMap::new();
    for finding in stats::finding_counts(db.conn(),from,now,"window_open").map_err(|_| "data_unavailable")? {
        let harness = finding["harness"].as_str().unwrap_or("");
        if identities.get(harness).is_some_and(|id| id.findings) {
            let key = (harness.to_string(),finding["severity"].as_str().unwrap_or("").to_string());
            let n = grouped.entry(key).or_insert(0i64);
            *n = n.checked_add(finding["count"].as_i64().unwrap_or(0)).ok_or("numeric_out_of_range")?;
        }
    }
    let findings: Vec<Value> = grouped.into_iter().map(|((harness,severity),count)| json!({"harness":harness,"severity":severity,"count":count})).collect();
    let result = json!({"protocol":"city:v2","source":"local","data_revision":revision,
        "harnesses":super::app_harnesses::public_identities(&identities),"generated_at":timestamp(now)?,
        "window":{"days":days,"label":format!("最近 {days} 天"),"from":timestamp(from)?,"to":timestamp(now)?,
            "boundary":"closed","timezone":"UTC","calendar_mode":"rolling"},
        "summary":summary,"models":model_summary(&models)?["model_ids"],"model_coverage":model_summary(&models)?,
        "activity":activity(db.conn(),from,now.checked_add(1).ok_or("invalid_window")?,"UTC")?,
        "coverage":{"total":summary["session_count"],"returned":sessions.len(),"truncated":summary["session_count"].as_i64().unwrap_or(0)>sessions.len() as i64,
            "unknown_time":time_coverage["unknown_time_only"].as_i64().unwrap_or(0)+time_coverage["mixed_time"].as_i64().unwrap_or(0),
            "unknown_time_semantics":"compat_any_untimed_fact_all_sessions","time_classification":time_coverage,
            "selection":"window_last_event_desc_session_key_asc","order":"window_first_event_asc_session_key_asc","findings_state":"partial"},
        "status":if sessions.is_empty() {"empty"} else {"ready"},"sessions":sessions,"findings":findings});
    safe_numbers(&result)?;
    if result.to_string().len()>16_777_216 { return Err("projection_budget_exceeded"); }
    Ok(result)
}
