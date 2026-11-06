//! Shared read-side session aggregates. No plugin identity, handles or presentation text.
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use crate::authority::AuthorityError;

pub fn token_buckets(values: [i64; 4]) -> Result<Value, AuthorityError> {
    let input = values[0].checked_add(values[1]).and_then(|n| n.checked_add(values[2]))
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let total = input.checked_add(values[3]).ok_or(rusqlite::Error::InvalidQuery)?;
    if values.iter().any(|n| *n < 0) { return Err(rusqlite::Error::InvalidQuery.into()); }
    Ok(json!({"uncached_input":values[0],"cache_read":values[1],"cache_write":values[2],
        "input":input,"output":values[3],"total":total}))
}

/// Inclusive endpoints; callers of half-open protocols convert their end to end-1.
pub fn window_summary(conn: &Connection, from: i64, to: i64) -> Result<Value, AuthorityError> {
    let (sessions, events, a, b, c, d): (i64,i64,i64,i64,i64,i64) = conn.query_row(
        "SELECT COUNT(DISTINCT f.session_key),COUNT(*),COALESCE(SUM(f.uncached_input_tokens),0),
        COALESCE(SUM(f.cache_read_tokens),0),COALESCE(SUM(f.cache_write_tokens),0),COALESCE(SUM(f.output_tokens),0)
        FROM usage_facts f JOIN sessions s ON s.session_key=f.session_key
        WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL AND f.event_ts_ms>=?1 AND f.event_ts_ms<=?2",
        params![from,to], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    Ok(json!({"session_count":sessions,"usage_event_count":events,"tokens":token_buckets([a,b,c,d])?}))
}

pub fn time_coverage(conn: &Connection) -> Result<Value, AuthorityError> {
    let (unknown, mixed, no_usage): (i64,i64,i64) = conn.query_row(
        "WITH counts AS (SELECT s.session_key,COUNT(f.fact_id) AS facts,COUNT(f.event_ts_ms) AS timed
        FROM sessions s LEFT JOIN usage_facts f ON f.session_key=s.session_key AND f.deleted_at_ms IS NULL
        WHERE s.deleted_at_ms IS NULL GROUP BY s.session_key)
        SELECT COALESCE(SUM(facts>0 AND timed=0),0),COALESCE(SUM(timed>0 AND timed<facts),0),
        COALESCE(SUM(facts=0),0) FROM counts", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    Ok(json!({"scope":"all_non_deleted_sessions","unknown_time_only":unknown,"mixed_time":mixed,
        "excluded_no_usage":no_usage}))
}

/// Model existence is independent of priceability and legacy status.
pub fn model_distribution(conn: &Connection, from: i64, to: i64, keys: Option<&[String]>) -> Result<Vec<Value>, AuthorityError> {
    let keys = keys.map(serde_json::to_string).transpose().map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt = conn.prepare("SELECT f.session_key,f.model_id,f.observation_kind='legacy_aggregate',COUNT(*),
        SUM(f.uncached_input_tokens),SUM(f.cache_read_tokens),SUM(f.cache_write_tokens),SUM(f.output_tokens)
        FROM usage_facts f JOIN sessions s ON s.session_key=f.session_key
        WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL AND f.event_ts_ms>=?1 AND f.event_ts_ms<=?2
        AND (?3 IS NULL OR f.session_key IN (SELECT value FROM json_each(?3)))
        GROUP BY f.session_key,f.model_id,f.observation_kind='legacy_aggregate' ORDER BY f.session_key,f.model_id")?;
    let rows = stmt.query_map(params![from,to,keys], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,
        r.get::<_,bool>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (key, model, legacy, count, a,b,c,d) = row?;
        out.push(json!({"session_key":key,"model_id":model.filter(|s| !s.trim().is_empty() && s!="<unknown>"),
            "legacy":legacy,"usage_event_count":count,"tokens":token_buckets([a,b,c,d])?}));
    }
    Ok(out)
}

pub fn session_page(conn: &Connection, from: i64, to: i64, limit: usize, offset: usize) -> Result<Vec<Value>, AuthorityError> {
    session_page_for_keys(conn,from,to,limit,offset,None)
}

/// Window membership in last-event order. City v3 pages slice this instead of `OFFSET` so
/// later pages do not re-group every matching session. `first` is the layout_order key.
pub fn session_order(conn: &Connection, from: i64, to: i64) -> Result<Vec<(String, i64, i64)>, AuthorityError> {
    let mut stmt = conn.prepare("SELECT s.session_key,MIN(f.event_ts_ms),MAX(f.event_ts_ms)
        FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
        WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL AND f.event_ts_ms>=?1 AND f.event_ts_ms<=?2
        GROUP BY s.session_key ORDER BY MAX(f.event_ts_ms) DESC,s.session_key")?;
    let rows = stmt.query_map(params![from,to], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?)))?;
    rows.collect::<Result<Vec<_>,_>>().map_err(Into::into)
}

pub fn session_page_for_keys(conn: &Connection, from: i64, to: i64, limit: usize, offset: usize, keys: Option<&[String]>) -> Result<Vec<Value>, AuthorityError> {
    let keys = keys.map(serde_json::to_string).transpose().map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt = conn.prepare("WITH page AS (SELECT s.session_key,s.harness,s.title,s.title_source,
        MIN(f.event_ts_ms) AS first,MAX(f.event_ts_ms) AS last,COUNT(*) AS events,
        ROW_NUMBER() OVER (ORDER BY MIN(f.event_ts_ms),s.session_key) AS layout_order,
        SUM(f.uncached_input_tokens) AS a,SUM(f.cache_read_tokens) AS b,SUM(f.cache_write_tokens) AS c,SUM(f.output_tokens) AS d
        FROM sessions s JOIN usage_facts f ON f.session_key=s.session_key
        WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL AND f.event_ts_ms>=?1 AND f.event_ts_ms<=?2
        AND (?5 IS NULL OR s.session_key IN (SELECT value FROM json_each(?5)))
        GROUP BY s.session_key ORDER BY last DESC,s.session_key LIMIT ?3 OFFSET ?4),
        lifetime AS (SELECT f.session_key,MIN(f.event_ts_ms) AS first,MAX(f.event_ts_ms) AS last
        FROM usage_facts f JOIN page p ON p.session_key=f.session_key WHERE f.deleted_at_ms IS NULL GROUP BY f.session_key)
        SELECT p.session_key,p.harness,p.title,p.title_source,p.first,p.last,p.events,p.a,p.b,p.c,p.d,l.first,l.last,p.layout_order
        FROM page p JOIN lifetime l ON l.session_key=p.session_key ORDER BY p.last DESC,p.session_key")?;
    let rows = stmt.query_map(params![from,to,limit as i64,offset as i64,keys], |r| Ok((
        r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,
        r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?,
        r.get::<_,i64>(9)?,r.get::<_,i64>(10)?,r.get::<_,Option<i64>>(11)?,r.get::<_,Option<i64>>(12)?,r.get::<_,i64>(13)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (key,harness,title,source,first,last,events,a,b,c,d,lfirst,llast,layout_order) = row?;
        out.push(json!({"session_key":key,"harness":harness,"title":title,"title_source":source,
            "window_first_ms":first,"window_last_ms":last,"lifetime_first_ms":lfirst,"lifetime_last_ms":llast,
            "usage_event_count":events,"layout_order":layout_order,"tokens":token_buckets([a,b,c,d])?}));
    }
    Ok(out)
}

/// Bounded candidates for local presentation. Filter/dedup before taking the final excerpt limit.
pub fn excerpt_candidates(conn: &Connection, keys: &[String]) -> Result<Vec<Value>, AuthorityError> {
    let keys = serde_json::to_string(keys).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut stmt = conn.prepare("WITH candidates AS (SELECT session_key,role,excerpt,provenance,
        ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY CASE role WHEN 'user_first' THEN 0 ELSE 1 END,ordinal DESC) AS n
        FROM session_excerpts WHERE session_key IN (SELECT value FROM json_each(?1)) AND role IN ('user_first','user_turn'))
        SELECT session_key,role,substr(excerpt,1,512),provenance FROM candidates WHERE n<=32 ORDER BY session_key,n")?;
    let rows = stmt.query_map([keys], |r| Ok(json!({"session_key":r.get::<_,String>(0)?,"role":r.get::<_,String>(1)?,
        "text":r.get::<_,String>(2)?,"provenance":r.get::<_,String>(3)?})))?;
    rows.collect::<Result<Vec<_>,_>>().map_err(Into::into)
}

/// Registered finding scopes can reuse this aggregate without exposing instance text or arguments.
pub fn finding_counts(conn: &Connection, from: i64, to: i64, scope: &str) -> Result<Vec<Value>, AuthorityError> {
    let mut stmt = conn.prepare("SELECT harness,severity,issue_type,COUNT(*) FROM issue_instances
        WHERE ((?3='current_backlog' AND status IN ('open','later'))
        OR (?3='window_new' AND opened_at_ms>=?1 AND opened_at_ms<=?2)
        OR (?3='window_open' AND status IN ('open','later') AND opened_at_ms>=?1 AND opened_at_ms<=?2))
        AND severity IN ('critical','warning','info') GROUP BY harness,severity,issue_type ORDER BY harness,severity,issue_type")?;
    let rows = stmt.query_map(params![from,to,scope], |r| Ok(json!({"harness":r.get::<_,String>(0)?,
        "severity":r.get::<_,String>(1)?,"category":r.get::<_,String>(2)?,"count":r.get::<_,i64>(3)?})))?;
    rows.collect::<Result<Vec<_>,_>>().map_err(Into::into)
}

pub fn daily_activity(conn: &Connection, boundaries: &Value) -> Result<Vec<Value>, AuthorityError> {
    let mut stmt = conn.prepare("SELECT json_extract(day.value,'$.date'),COUNT(DISTINCT f.session_key),COUNT(f.fact_id),
        COALESCE(SUM(f.uncached_input_tokens),0),COALESCE(SUM(f.cache_read_tokens),0),
        COALESCE(SUM(f.cache_write_tokens),0),COALESCE(SUM(f.output_tokens),0)
        FROM json_each(?1) day JOIN usage_facts f ON f.event_ts_ms>=json_extract(day.value,'$.from_ms')
        AND f.event_ts_ms<json_extract(day.value,'$.to_ms') JOIN sessions s ON s.session_key=f.session_key
        WHERE s.deleted_at_ms IS NULL AND f.deleted_at_ms IS NULL GROUP BY day.key ORDER BY day.key")?;
    let rows = stmt.query_map([boundaries.to_string()], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,
        r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (date,sessions,events,a,b,c,d) = row?;
        out.push(json!({"date":date,"session_count":sessions,"event_count":events,"tokens":token_buckets([a,b,c,d])?["total"]}));
    }
    Ok(out)
}

/// Observed skill carriers, not installed inventory or inferred successful calls.
/// Inner join provides harness ownership; unanchored events cannot be assigned to a district.
pub fn skill_activity(conn: &Connection, from: i64, to: i64, harness: Option<&str>) -> Result<Vec<Value>, AuthorityError> {
    let mut stmt=conn.prepare("SELECT s.harness,substr(w.capability_id,1,512),
        SUM(CASE WHEN w.event_type='skill_invoked' THEN 1 ELSE 0 END),
        COUNT(DISTINCT CASE WHEN w.event_type='skill_invoked' THEN w.session_key END),
        MAX(CASE WHEN w.event_type='skill_invoked' THEN w.event_ts_ms END),
        SUM(CASE WHEN w.event_type='skill_finished' THEN 1 ELSE 0 END),
        SUM(CASE WHEN w.event_type='skill_finished' AND w.outcome='failed' THEN 1 ELSE 0 END),
        SUM(CASE WHEN w.event_type='skill_finished' AND w.outcome='succeeded' THEN 1 ELSE 0 END)
        FROM workflow_events w JOIN sessions s ON s.session_key=w.session_key
        WHERE w.event_type IN ('skill_invoked','skill_finished') AND w.event_ts_ms>=?1 AND w.event_ts_ms<?2
          AND (?3 IS NULL OR s.harness=?3) AND w.capability_id IS NOT NULL
        GROUP BY s.harness,w.capability_id
        ORDER BY 3 DESC,s.harness,w.capability_id LIMIT 201")?;
    let rows=stmt.query_map(params![from,to,harness],|r|Ok(json!({"harness":r.get::<_,String>(0)?,
        "skill":r.get::<_,String>(1)?,"invocations":r.get::<_,i64>(2)?,"sessions":r.get::<_,i64>(3)?,
        "last_invoked_at_ms":r.get::<_,Option<i64>>(4)?,"finished_events":r.get::<_,i64>(5)?,
        "failed_events":r.get::<_,i64>(6)?,"succeeded_events":r.get::<_,i64>(7)?})))?;
    Ok(rows.collect::<Result<Vec<_>,_>>()?)
}

/// Bounded event-family totals. Finishes are observations, never inferred paired outcomes.
pub fn workflow_activity(conn: &Connection, from: i64, to: i64, harness: Option<&str>) -> Result<Vec<Value>, AuthorityError> {
    let mut stmt=conn.prepare("SELECT s.harness,w.event_type,COUNT(*),COUNT(DISTINCT w.session_key),
        MAX(w.event_ts_ms),SUM(CASE WHEN w.outcome='failed' THEN 1 ELSE 0 END)
        FROM workflow_events w JOIN sessions s ON s.session_key=w.session_key
        WHERE w.event_ts_ms>=?1 AND w.event_ts_ms<?2 AND (?3 IS NULL OR s.harness=?3)
        AND s.deleted_at_ms IS NULL
        AND w.event_type IN ('task_started','task_finished','skill_invoked','skill_finished',
            'tool_invoked','tool_finished','model_switched','approval_denied')
        GROUP BY s.harness,w.event_type ORDER BY s.harness,w.event_type LIMIT 201")?;
    let rows=stmt.query_map(params![from,to,harness],|r|Ok(json!({"harness":r.get::<_,String>(0)?,
        "event_type":r.get::<_,String>(1)?,"events":r.get::<_,i64>(2)?,"sessions":r.get::<_,i64>(3)?,
        "last_event_at_ms":r.get::<_,i64>(4)?,"failed_events":r.get::<_,i64>(5)?})))?;
    Ok(rows.collect::<Result<Vec<_>,_>>()?)
}
