//! Retired City v3 read model, compiled only for compatibility contract tests.
use std::{collections::BTreeMap, path::{Path,PathBuf}, sync::{Mutex,OnceLock}};
use std::time::Instant;
use rusqlite::Connection;
use serde_json::{Value,json};
use agent_vitals_data::{authority::{AuthorityDb,default_authority_path},session_statistics as stats};
use super::{app_local,session_ref::{load_or_create_salt,session_ref}};

const SEMANTICS: &str = "city-window-v3.1";
struct Watcher { file_id: String, conn: Connection, nonce: String }
static WATCHERS: OnceLock<Mutex<BTreeMap<PathBuf,Watcher>>> = OnceLock::new();
/// Logical snapshot index: ordered session keys and global layout ranks.
/// Pages reuse the ordered session keys and global layout ranks without SQL OFFSET.
struct SnapshotIndex { keys: Vec<String>, layout_order: BTreeMap<String,i64> }
static SNAPSHOTS: OnceLock<Mutex<BTreeMap<(PathBuf,String),SnapshotIndex>>> = OnceLock::new();

fn snapshot_index(home: &Path, context: &str, conn: &Connection, from: i64, to: i64) -> Result<SnapshotIndex,&'static str> {
    let key = (home.to_path_buf(), context.to_string());
    if let Some(cached) = SNAPSHOTS.get_or_init(|| Mutex::new(BTreeMap::new())).lock().map_err(|_| "data_unavailable")?.get(&key) {
        return Ok(SnapshotIndex { keys: cached.keys.clone(), layout_order: cached.layout_order.clone() });
    }
    let ordered = stats::session_order(conn,from,to).map_err(|_| "data_unavailable")?;
    let mut by_first = ordered.iter().map(|(key,first,_)| (first,key.as_str())).collect::<Vec<_>>();
    by_first.sort_unstable();
    let layout_order = by_first.into_iter().enumerate().map(|(index,(_,key))| (key.to_string(), index as i64 + 1)).collect::<BTreeMap<_,_>>();
    let built = SnapshotIndex { keys: ordered.into_iter().map(|(key,_,_)| key).collect(), layout_order };
    let mut cache = SNAPSHOTS.get_or_init(|| Mutex::new(BTreeMap::new())).lock().map_err(|_| "data_unavailable")?;
    if cache.len() >= 8 { cache.clear(); }
    cache.insert(key, SnapshotIndex { keys: built.keys.clone(), layout_order: built.layout_order.clone() });
    Ok(built)
}

/// A retained, non-transactional SQLite connection makes data_version comparable across IPCs.
/// It catches commits that bypass authority_revision, including title/excerpt/catalog edits.
fn watch(home: &Path) -> Result<String,&'static str> {
    let path = default_authority_path(home);
    let metadata = std::fs::metadata(&path).map_err(|_| "data_unavailable")?;
    #[cfg(unix)] let file_id = { use std::os::unix::fs::MetadataExt; format!("{}:{}",metadata.dev(),metadata.ino()) };
    #[cfg(not(unix))] let file_id = format!("{:?}",metadata.created().map_err(|_| "data_unavailable")?);
    let mut watchers = WATCHERS.get_or_init(|| Mutex::new(BTreeMap::new())).lock().map_err(|_| "data_unavailable")?;
    if !watchers.get(&path).is_some_and(|w| w.file_id==file_id) {
        let conn = Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "data_unavailable")?;
        let nonce: String = conn.query_row("SELECT lower(hex(randomblob(16)))",[],|r| r.get(0)).map_err(|_| "data_unavailable")?;
        if watchers.len()>=32 { watchers.clear(); }
        watchers.insert(path.clone(),Watcher { file_id,conn,nonce });
    }
    let watcher = watchers.get(&path).ok_or("data_unavailable")?;
    let version: i64 = watcher.conn.query_row("PRAGMA data_version",[],|r| r.get(0)).map_err(|_| "data_unavailable")?;
    Ok(format!("{}:{version}",watcher.nonce))
}

fn timestamp(ms: i64) -> Result<String,&'static str> {
    jiff::Timestamp::from_millisecond(ms).map(|t|t.to_string()).map_err(|_| "invalid_window")
}

fn log_overview_stage(stage: &str, started: Instant) {
    agent_vitals_runtime_core::core::logging::log_info(
        "city_v3",
        &format!("city_overview_stage stage={stage} elapsed_ms={}", started.elapsed().as_millis()),
    );
}

/// Compatibility implementation used only by the legacy City v3 contract tests.
pub fn read(home: &Path, request: &Value, now: i64) -> Result<Value,&'static str> {
    let operation = request["operation"].as_str().ok_or("invalid_operation")?;
    if !matches!(operation,"overview"|"sessions.page") { return Err("invalid_operation"); }
    let mut allowed=vec!["projection","version","operation"];
    if operation=="overview" { allowed.extend(["windowDays","timezone","calendar_mode","page_size"]); }
    else {
        allowed.extend(["expected_revision","snapshot","context","query_semantics","window"]);
        allowed.extend(match operation {
            "sessions.page"=>vec!["page_size","cursor"],
            _=>vec![],
        });
    }
    if request.as_object().ok_or("invalid_request")?.keys().any(|key| !allowed.contains(&key.as_str())) { return Err("invalid_parameter"); }
    if request.get("page_size").is_some_and(|v|v.as_u64().is_none())
        || request.get("include_excerpts").is_some_and(|v|v.as_bool().is_none())
        || request.get("timezone").is_some_and(|v|v.as_str().is_none()) { return Err("invalid_parameter"); }
    let before = watch(home)?;
    let db = AuthorityDb::open_readonly(&default_authority_path(home)).map_err(|_| "data_unavailable")?;
    db.conn().execute_batch("BEGIN DEFERRED").map_err(|_| "data_unavailable")?;
    let revision = db.revision().map_err(|_| "data_unavailable")?;
    let read_started=Instant::now();
    let salt = load_or_create_salt(home).map_err(|_| "data_unavailable")?;
    let identities=super::app_harnesses::identities(db.conn(),home)?;
    let identity_version=json!(super::app_harnesses::public_identities(&identities));
    let snapshot = session_ref(&salt,&format!("city-v3:{before}:{revision}:{identity_version}"));
    let initial = operation=="overview";
    let (days,from,to,timezone) = if initial {
        let days = request["windowDays"].as_u64().filter(|d| matches!(d,7|30|90|366)).ok_or("invalid_window")?;
        let tz = request["timezone"].as_str().unwrap_or("UTC");
        if request["calendar_mode"].as_str().unwrap_or("rolling")!="rolling" { return Err("unsupported_calendar_mode"); }
        (days,now.checked_sub(days as i64*86_400_000).ok_or("invalid_window")?,now,tz.to_string())
    } else {
        if request["expected_revision"].as_u64()!=Some(revision) || request["snapshot"].as_str()!=Some(&snapshot) { return Err("revision_changed"); }
        if request["query_semantics"].as_str()!=Some(SEMANTICS) { return Err("invalid_query_semantics"); }
        let window=&request["window"];
        let days=window["days"].as_u64().filter(|d|matches!(d,7|30|90|366)).ok_or("invalid_window")?;
        let from=window["from_ms"].as_i64().ok_or("invalid_window")?;
        let to=window["to_ms"].as_i64().ok_or("invalid_window")?;
        if to.checked_sub(from)!=Some(days as i64*86_400_000) || window["calendar_mode"]!="rolling" || window["boundary"]!="half_open" { return Err("invalid_window"); }
        (days,from,to,window["timezone"].as_str().ok_or("invalid_timezone")?.to_string())
    };
    if timezone.len()>100 || jiff::tz::TimeZone::get(&timezone).is_err() { return Err("invalid_timezone"); }
    let end=to.checked_sub(1).ok_or("invalid_window")?;
    let generated=timestamp(now)?;
    let window=json!({"days":days,"from_ms":from,"to_ms":to,"from":timestamp(from)?,"to":timestamp(to)?,
        "timezone":timezone,"calendar_mode":"rolling","boundary":"half_open"});
    let context_tag=session_ref(&salt,&format!("city-context:{snapshot}:{window}:{SEMANTICS}"));
    if !initial && request["context"].as_str()!=Some(&context_tag) { return Err("invalid_context"); }
    let mut result=json!({"protocol":"city:v3","query_semantics":SEMANTICS,"source":"local","data_revision":revision,
        "snapshot":snapshot,"context":context_tag,"generated_at":generated,"window":window});
    match operation {
        "overview"|"sessions.page" => {
            let limit=request["page_size"].as_u64().unwrap_or(200);
            if !(1..=500).contains(&limit) { return Err("invalid_page_size"); }
            let cursor_tag=|offset:usize| session_ref(&salt,&format!("city-cursor:{context_tag}:{offset}:{limit}"));
            let offset=if initial { 0 } else {
                let cursor=request["cursor"].as_str().filter(|s|s.len()<100).ok_or("invalid_cursor")?;
                let (number,signature)=cursor.split_once('.').ok_or("invalid_cursor")?;
                let number=number.parse::<usize>().map_err(|_|"invalid_cursor")?;
                if signature!=cursor_tag(number) { return Err("invalid_cursor"); }
                number
            };
            let stage_started=Instant::now();
            let index=snapshot_index(home,&context_tag,db.conn(),from,end)?;
            if initial { log_overview_stage("snapshot_index",stage_started); }
            let matched=index.keys.len() as u64;
            if offset as u64>matched { return Err("invalid_cursor"); }
            let end_index=(offset+(limit as usize)).min(index.keys.len());
            let page_keys=index.keys.get(offset..end_index).unwrap_or(&[]).to_vec();
            // Page rows are fetched by keyset membership, not SQL OFFSET, so deep pages
            // do not re-group the whole window. Overview stats stay off this path.
            let rows=if page_keys.is_empty() { Vec::new() } else {
                let started=Instant::now();
                let rows=stats::session_page_for_keys(db.conn(),from,end,page_keys.len(),0,Some(&page_keys)).map_err(|_| "data_unavailable")?;
                if initial { log_overview_stage("session_page",started); }
                rows
            };
            let started=Instant::now();
            let models=stats::model_distribution(db.conn(),from,end,Some(&page_keys)).map_err(|_| "data_unavailable")?;
            if initial { log_overview_stage("model_distribution",started); }
            let started=Instant::now();
            let assets=super::city_assets::publish(home,db.conn(),&page_keys)?;
            if initial { log_overview_stage("assets",started); }
            let mut model_groups:BTreeMap<&str,Vec<Value>>=BTreeMap::new();
            for model in &models { if let Some(key)=model["session_key"].as_str() { model_groups.entry(key).or_default().push(model.clone()); } }
            let mut by_key:BTreeMap<&str,&Value>=BTreeMap::new();
            for row in &rows { if let Some(key)=row["session_key"].as_str() { by_key.insert(key,row); } }
            let mut sessions=Vec::new();
            for key in &page_keys {
                let row=by_key.get(key.as_str()).ok_or("data_unavailable")?;
                let mut projected=app_local::projected_session(row,model_groups.get(key.as_str()).map(Vec::as_slice).unwrap_or(&[]),&salt,
                    identities.contains_key(row["harness"].as_str().unwrap_or("")))?;
                projected["layout_order"]=json!(index.layout_order.get(key).copied().unwrap_or(0));
                projected["asset_ref"]=json!(assets.by_session.get(key).ok_or("asset_state_unavailable")?);
                projected["details"]=json!({"state":"unavailable","reason":"load_on_demand"});
                projected["cost_status"]=json!({"state":"unavailable","reason":"load_on_demand","has_unresolved":false});
                sessions.push(projected);
            }
            let next=offset.checked_add(sessions.len()).ok_or("numeric_out_of_range")?;
            result["page"]=json!({"sessions":sessions,"next_cursor":if (next as u64)<matched {Some(format!("{next}.{}",cursor_tag(next)))} else {None},
                "coverage":{"matched":matched,"returned":sessions.len(),"offset":offset,"has_more":(next as u64)<matched,
                    "render_budget":4000,"selection":"window_last_event_desc_session_key_asc","order":"window_last_event_desc_session_key_asc"}});
            if initial { result["harnesses"]=json!(super::app_harnesses::public_identities(&identities)); }
        }
        _=>unreachable!(),
    }
    if watch(home)?!=before { return Err("revision_changed"); }
    if operation=="overview" {
        agent_vitals_runtime_core::core::logging::log_info("city_v3", &format!(
            "city_overview_finished operation=overview window_days={days} outcome=success elapsed_ms={}",
            read_started.elapsed().as_millis()));
    }
    app_local::safe_numbers(&result)?;
    if result.to_string().len()>2_000_000 { return Err("projection_budget_exceeded"); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_and_multiple_currency_estimates_never_get_a_scalar_total() {
        let bucket=|currency:&str,amount:Option<i64>,provider:&str| json!({"provider_id":provider,"billing_mode":"unknown",
            "has_unresolved":true,"pricing_version":"fixture","pricing_source":"fallback_official",
            "tokens":{"total":100},"cost_minor":amount.map(|n|json!({"amount_minor":n,"currency":currency,"basis":"metered_estimate"}))});
        let cost=crate::query::app_harnesses::session_cost_breakdown(&[bucket("USD",Some(10),"one"),bucket("CNY",Some(20),"two")],200).unwrap();
        assert_eq!(cost["cost_minor"],Value::Null);
        assert_eq!(cost["breakdown"].as_array().unwrap().len(),2);
        let partial=crate::query::app_harnesses::session_cost_breakdown(&[bucket("USD",Some(10),"one"),bucket("USD",None,"one")],200).unwrap();
        assert_eq!(partial["cost_minor"],Value::Null);
        assert_eq!(partial["complete"],false);
        assert_eq!(partial["coverage"]["unpriced_tokens"],100);
    }
}
