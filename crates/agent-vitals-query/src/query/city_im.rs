//! Squad IM channel (phase 1): envelope v1 + soft claim lock + host.sock fanout.
//!
//! Agents publish only `chat` / `claim` / `release` via MCP `im_publish`.
//! Building MCP tools fanout `preview` / `reject` / `set` / `reset` themselves
//! so Agents do not also call IM to report those writes. Construction notify
//! (`notify.json` / `CityEntityChanged`) is a separate mailbox and is never
//! overwritten by this channel.
//!
//! `get_squad_feed` is intentionally absent. `observe` is in the vocabulary
//! but gated closed: Agents cannot publish it, and the UI default filter is off.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};

use super::city_building::{
    self, resolve_identity, store_dir, try_push_socket, BuildingError, BuildingIdentity,
};

pub const SQUAD_EVENT: &str = "__AV_PLUGIN_SQUAD_EVENT__";
pub const ENVELOPE_V: u64 = 1;
pub const DEFAULT_TTL_SEC: i64 = 90;
pub const MIN_TTL_SEC: i64 = 15;
pub const MAX_TTL_SEC: i64 = 900;
pub const MAX_CHAT_CHARS: usize = 500;
pub const AGENT_PUBLISH_KINDS: &[&str] = &["chat", "claim", "release"];
pub const FANOUT_KINDS: &[&str] = &["preview", "reject", "set", "reset"];
const ALL_KINDS: &[&str] = &[
    "chat", "claim", "release", "preview", "reject", "set", "reset", "observe",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImActor {
    pub agent_id: String,
    pub agent_name: String,
}

impl ImActor {
    pub fn mcp_default() -> Self {
        Self { agent_id: "city-mcp".into(), agent_name: "City MCP".into() }
    }
}

std::thread_local! {
    /// One stdio MCP connection is one client. `initialize.clientInfo.name`
    /// is remembered here so building fanout is not stuck on "City MCP".
    /// Direct library calls (tests, city:v3) leave the default in place.
    static CONNECTION_ACTOR: std::cell::RefCell<ImActor> = std::cell::RefCell::new(ImActor::mcp_default());
}

pub fn connection_actor() -> ImActor {
    CONNECTION_ACTOR.with(|slot| slot.borrow().clone())
}

/// `None` or a blank name restores City MCP. Known client names get a stable
/// display label; anything else is shown as sent, after a light sanitize.
pub fn set_connection_client(name: Option<&str>) {
    let actor = actor_from_client_name(name.unwrap_or(""));
    CONNECTION_ACTOR.with(|slot| *slot.borrow_mut() = actor);
}

pub fn actor_from_client_name(name: &str) -> ImActor {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return ImActor::mcp_default();
    }
    let key = trimmed.to_ascii_lowercase();
    let (id, display): (&str, &str) = match key.as_str() {
        "claude-code" | "claude code" | "claude" => ("claude-code", "Claude Code"),
        "codex" | "codex-cli" | "codex cli" | "openai-codex" => ("codex", "Codex"),
        "cursor" | "cursor-agent" | "cursor-ide" => ("cursor", "Cursor"),
        "gemini" | "gemini-cli" => ("gemini", "Gemini"),
        "windsurf" => ("windsurf", "Windsurf"),
        "zed" => ("zed", "Zed"),
        "dsh" | "deepseek" => ("dsh", "DeepSeek"),
        _ => {
            let id = sanitize_client_id(trimmed);
            let display = sanitize_client_display(trimmed);
            if id.is_empty() || display.is_empty() {
                return ImActor::mcp_default();
            }
            return ImActor { agent_id: id, agent_name: display };
        }
    };
    ImActor { agent_id: id.to_string(), agent_name: display.to_string() }
}

fn sanitize_client_id(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if out.len() >= 64 { break; }
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-') {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() && !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    while out.ends_with('-') { out.pop(); }
    out
}

fn sanitize_client_display(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if out.chars().count() >= 80 { break; }
        if !ch.is_control() { out.push(ch); }
    }
    out.trim().to_string()
}

pub fn squad_mailbox_path(home: &Path) -> PathBuf {
    store_dir(home).join("squad.json")
}

pub fn now_unix_secs() -> i64 {
    crate::clock::now_ms() / 1000
}

fn new_envelope_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let now = crate::clock::now_ms();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("evt_{now:012x}{seq:08x}")
}

fn store_unavailable() -> BuildingError {
    BuildingError::validation(
        "store_unavailable",
        vec![],
        "city building override store is unavailable",
        "retry; the store lives under state/plugins/city-buildings/",
    )
}

fn invalid(rule: &'static str, message: impl Into<String>, fix: impl Into<String>) -> BuildingError {
    BuildingError::validation(rule, vec![], message, fix)
}

pub fn is_squad_kind(kind: &str) -> bool {
    ALL_KINDS.contains(&kind)
}

pub fn is_agent_publish_kind(kind: &str) -> bool {
    AGENT_PUBLISH_KINDS.contains(&kind)
}

/// Host → City IM envelope. Distinct JSON from `CityEntityChanged` so the two
/// cannot overwrite each other's mailbox, but they share `host.sock`.
pub fn envelope(
    session_id: &str,
    actor: &ImActor,
    kind: &str,
    payload: Value,
    ts: i64,
    id: &str,
) -> Value {
    let mut out = Map::new();
    out.insert("v".into(), json!(ENVELOPE_V));
    out.insert("id".into(), json!(id));
    out.insert("ts".into(), json!(ts));
    out.insert("session_id".into(), json!(session_id));
    out.insert("agent_id".into(), json!(actor.agent_id));
    out.insert("agent_name".into(), json!(actor.agent_name));
    out.insert("kind".into(), json!(kind));
    out.insert("payload".into(), payload);
    Value::Object(out)
}

pub fn envelope_id(payload: &Value) -> Option<&str> {
    payload.get("id").and_then(Value::as_str).filter(|s| s.starts_with("evt_") && s.len() > 4 && s.len() <= 80)
}

pub fn is_squad_envelope(payload: &Value) -> bool {
    payload.get("v").and_then(Value::as_u64) == Some(ENVELOPE_V)
        && envelope_id(payload).is_some()
        && payload.get("ts").and_then(Value::as_i64).is_some()
        && payload.get("session_id").and_then(Value::as_str).is_some_and(|s| s.starts_with("sr_") && s.len() == 35)
        && payload.get("agent_id").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && payload.get("agent_name").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && payload.get("kind").and_then(Value::as_str).is_some_and(is_squad_kind)
        && payload.get("payload").map(Value::is_object).unwrap_or(false)
}

pub fn notify_squad_ui(home: &Path, payload: &Value) -> &'static str {
    let _ = city_building::write_named_mailbox(home, "squad.json", payload);
    if try_push_socket(home, payload) { "pushed" } else { "queued" }
}

pub fn read_squad_mailbox(home: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(squad_mailbox_path(home)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn parse_actor(agent_id: &str, agent_name: &str) -> Result<ImActor, BuildingError> {
    let agent_id = agent_id.trim();
    let agent_name = agent_name.trim();
    if agent_id.is_empty() || agent_id.len() > 64
        || !agent_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
    {
        return Err(invalid(
            "invalid_actor",
            "agent_id must be 1–64 ascii letters, digits, or ._: -",
            "pass the calling agent's stable id",
        ));
    }
    if agent_name.is_empty() || agent_name.len() > 80 || agent_name.chars().any(|c| c.is_control()) {
        return Err(invalid(
            "invalid_actor",
            "agent_name is required for display (1–80 chars, no control characters)",
            "pass a short display name; identity remains agent_id",
        ));
    }
    Ok(ImActor { agent_id: agent_id.to_string(), agent_name: agent_name.to_string() })
}

fn clamp_ttl(ttl_sec: Option<i64>) -> Result<i64, BuildingError> {
    let ttl = ttl_sec.unwrap_or(DEFAULT_TTL_SEC);
    if !(MIN_TTL_SEC..=MAX_TTL_SEC).contains(&ttl) {
        return Err(invalid(
            "invalid_ttl",
            format!("ttl_sec must be {MIN_TTL_SEC}–{MAX_TTL_SEC}"),
            format!("omit ttl_sec to use the default {DEFAULT_TTL_SEC}s"),
        ));
    }
    Ok(ttl)
}

fn require_asset_ref(payload: &Value, identity: &BuildingIdentity) -> Result<String, BuildingError> {
    let asset = payload.get("asset_ref").and_then(Value::as_str).unwrap_or("");
    if asset != identity.asset_ref {
        return Err(invalid(
            "asset_mismatch",
            "asset_ref must be this session's building (session auth)",
            "pass get_building.projection.asset_ref for the same session_id",
        ));
    }
    Ok(asset.to_string())
}

fn emit(home: &Path, identity: &BuildingIdentity, actor: &ImActor, kind: &str, payload: Value) -> Value {
    let id = new_envelope_id();
    let ts = now_unix_secs();
    let env = envelope(&identity.session_id, actor, kind, payload, ts, &id);
    let ui = notify_squad_ui(home, &env);
    json!({
        "ok": true,
        "error": Value::Null,
        "envelope": env,
        "notify": {
            "channel": if ui == "pushed" { "host-socket" } else { "mailbox" },
            "ui": ui,
            "event_id": id,
        },
    })
}

/// Best-effort MCP write-path fanout. Never fails the building tool: construction
/// notify already went out on its own mailbox. Payloads include `revision` when
/// known; City UI ignores a stale lower revision for that `asset_ref` (sibling
/// lots stay isolated). Soft claim/release have no revision.
pub fn fanout_building(
    home: &Path,
    identity: &BuildingIdentity,
    actor: &ImActor,
    kind: &str,
    payload: Value,
) -> Option<Value> {
    if !FANOUT_KINDS.contains(&kind) {
        return None;
    }
    let env = envelope(
        &identity.session_id,
        actor,
        kind,
        payload,
        now_unix_secs(),
        &new_envelope_id(),
    );
    let ui = notify_squad_ui(home, &env);
    Some(json!({
        "channel": if ui == "pushed" { "host-socket" } else { "mailbox" },
        "ui": ui,
        "event_id": env.get("id").cloned().unwrap_or(Value::Null),
        "kind": kind,
    }))
}

fn load_claim(
    db: &rusqlite::Connection,
    session_id: &str,
    asset_ref: &str,
) -> Result<Option<(String, String, i64)>, BuildingError> {
    db.query_row(
        "SELECT agent_id, agent_name, expires_at FROM claims WHERE session_id=?1 AND asset_ref=?2",
        params![session_id, asset_ref],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(|_| store_unavailable())
}

fn upsert_claim(
    db: &rusqlite::Connection,
    session_id: &str,
    asset_ref: &str,
    actor: &ImActor,
    expires_at: i64,
    updated_at: i64,
) -> Result<(), BuildingError> {
    db.execute(
        "INSERT INTO claims(session_id, asset_ref, agent_id, agent_name, expires_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id, asset_ref) DO UPDATE SET
            agent_id=excluded.agent_id, agent_name=excluded.agent_name,
            expires_at=excluded.expires_at, updated_at=excluded.updated_at",
        params![session_id, asset_ref, actor.agent_id, actor.agent_name, expires_at, updated_at],
    ).map_err(|_| store_unavailable())?;
    Ok(())
}

fn delete_claim(db: &rusqlite::Connection, session_id: &str, asset_ref: &str) -> Result<usize, BuildingError> {
    db.execute(
        "DELETE FROM claims WHERE session_id=?1 AND asset_ref=?2",
        params![session_id, asset_ref],
    ).map_err(|_| store_unavailable())
}

/// Successful set/reset clears the soft claim (reason `set_won`). Best-effort.
pub fn release_set_won(home: &Path, identity: &BuildingIdentity, actor: &ImActor) {
    let Ok(db) = city_building::open_store(home) else { return; };
    let Ok(Some((holder_id, holder_name, _))) = load_claim(&db, &identity.session_id, &identity.asset_ref) else { return; };
    let _ = delete_claim(&db, &identity.session_id, &identity.asset_ref);
    let holder = ImActor { agent_id: holder_id, agent_name: holder_name };
    let _ = emit(home, identity, &holder, "release", json!({
        "asset_ref": identity.asset_ref,
        "reason": "set_won",
        "cleared_by": actor.agent_id,
    }));
}

pub fn list_active_claims(home: &Path, now_secs: i64) -> Vec<Value> {
    let Ok(db) = city_building::open_store(home) else { return Vec::new(); };
    let Ok(mut stmt) = db.prepare(
        "SELECT session_id, asset_ref, agent_id, agent_name, expires_at, updated_at
         FROM claims WHERE expires_at > ?1 ORDER BY updated_at DESC LIMIT 200",
    ) else { return Vec::new(); };
    let Ok(rows) = stmt.query_map([now_secs], |r| {
        Ok(json!({
            "session_id": r.get::<_, String>(0)?,
            "asset_ref": r.get::<_, String>(1)?,
            "agent_id": r.get::<_, String>(2)?,
            "agent_name": r.get::<_, String>(3)?,
            "expires_at": r.get::<_, i64>(4)?,
            "updated_at": r.get::<_, i64>(5)?,
        }))
    }) else { return Vec::new(); };
    rows.flatten().collect()
}

fn publish_chat(home: &Path, identity: &BuildingIdentity, actor: &ImActor, payload: &Value) -> Result<Value, BuildingError> {
    let text = payload.get("text").and_then(Value::as_str).unwrap_or("").trim();
    if text.is_empty() || text.len() > MAX_CHAT_CHARS || text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(invalid(
            "invalid_chat",
            format!("chat text must be 1–{MAX_CHAT_CHARS} characters"),
            "send payload.text",
        ));
    }
    Ok(emit(home, identity, actor, "chat", json!({ "text": text })))
}

fn publish_claim(home: &Path, identity: &BuildingIdentity, actor: &ImActor, payload: &Value) -> Result<Value, BuildingError> {
    let asset_ref = require_asset_ref(payload, identity)?;
    let ttl = clamp_ttl(payload.get("ttl_sec").and_then(Value::as_i64))?;
    let now = now_unix_secs();
    let expires_at = now.saturating_add(ttl);
    let db = city_building::open_store(home)?;
    let previous = load_claim(&db, &identity.session_id, &asset_ref)?;
    let mut stolen = Value::Null;
    if let Some((holder_id, holder_name, prev_exp)) = previous {
        if holder_id != actor.agent_id {
            let reason = if prev_exp <= now { "ttl" } else { "stolen" };
            let holder = ImActor { agent_id: holder_id, agent_name: holder_name };
            stolen = emit(home, identity, &holder, "release", json!({
                "asset_ref": asset_ref,
                "reason": reason,
                "stolen_by": actor.agent_id,
            }))["envelope"].clone();
        } else if prev_exp <= now {
            let _ = emit(home, identity, actor, "release", json!({
                "asset_ref": asset_ref,
                "reason": "ttl",
            }));
        }
    }
    upsert_claim(&db, &identity.session_id, &asset_ref, actor, expires_at, now)?;
    let mut out = emit(home, identity, actor, "claim", json!({
        "asset_ref": asset_ref,
        "ttl_sec": ttl,
        "expires_at": expires_at,
    }));
    if !stolen.is_null() {
        out["replaced"] = stolen;
    }
    Ok(out)
}

fn publish_release(home: &Path, identity: &BuildingIdentity, actor: &ImActor, payload: &Value) -> Result<Value, BuildingError> {
    let asset_ref = require_asset_ref(payload, identity)?;
    let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("manual");
    if reason != "manual" {
        return Err(invalid(
            "invalid_release",
            "agents may only publish release reason `manual`; ttl/stolen/set_won are server-side",
            "omit reason or pass manual",
        ));
    }
    let db = city_building::open_store(home)?;
    match load_claim(&db, &identity.session_id, &asset_ref)? {
        None => Ok(json!({
            "ok": false,
            "error": {
                "kind": "validation",
                "rule": "no_claim",
                "message": "no active claim on this lot",
                "suggested_fix": "claim the lot first, or wait for an existing claim to expire",
            },
            "envelope": Value::Null,
        })),
        Some((holder_id, _, expires_at)) => {
            let now = now_unix_secs();
            if holder_id != actor.agent_id && expires_at > now {
                Ok(json!({
                    "ok": false,
                    "error": {
                        "kind": "conflict",
                        "rule": "not_holder",
                        "message": "another agent holds this claim; steal it with claim or wait for TTL",
                        "suggested_fix": "publish kind=claim on the same asset_ref to steal",
                    },
                    "envelope": Value::Null,
                }))
            } else {
                let effective = if expires_at <= now { "ttl" } else { "manual" };
                let _ = delete_claim(&db, &identity.session_id, &asset_ref)?;
                Ok(emit(home, identity, actor, "release", json!({
                    "asset_ref": asset_ref,
                    "reason": effective,
                })))
            }
        }
    }
}

/// Agent-facing publish: `kind ∈ {chat,claim,release}` only. Server assigns `id`/`ts`.
pub fn publish(
    home: &Path,
    conn: &rusqlite::Connection,
    session_id: &str,
    actor: &ImActor,
    kind: &str,
    payload: &Value,
) -> Result<Value, BuildingError> {
    if !is_agent_publish_kind(kind) {
        return Err(invalid(
            "kind_forbidden",
            format!("agents may publish only chat, claim, or release (not `{kind}`)"),
            "building preview/set/reset/reject are server-side fanout from City MCP; observe is off",
        ));
    }
    if !payload.is_object() {
        return Err(invalid("invalid_payload", "payload must be a JSON object", "send {text} or {asset_ref,…}"));
    }
    let identity = resolve_identity(home, conn, session_id)?;
    match kind {
        "chat" => publish_chat(home, &identity, actor, payload),
        "claim" => publish_claim(home, &identity, actor, payload),
        "release" => publish_release(home, &identity, actor, payload),
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::{default_authority_path, AuthorityDb};
    use super::super::city_building::{self, ENTITY_ACTION_PREVIEW, ENTITY_ACTION_REJECT};
    use super::super::city_building_inheritance::INHERITANCE_KIT_VERSION;
    use super::super::session_ref::{self, session_ref};

    fn seed() -> (std::path::PathBuf, AuthorityDb, String) {
        let home = std::env::temp_dir().join(format!(
            "av-city-im-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let db = AuthorityDb::open(&default_authority_path(&home), 1_700_000_000_000).unwrap();
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES ('run',1,'cli','succeeded',2)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES ('sess-im', 'codex', 'native-im', 'ns', 1)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                 source_event_id, observation_kind, event_ts_ms, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('fim', 'codex', 'ns', 'native-im', 'sess-im', 'e1', 'assistant-usage', 1, 50000, 0, 0, 50000, 'run', 1, 1)",
            [],
        ).unwrap();
        let salt = session_ref::load_or_create_salt(&home).unwrap();
        (home, db, session_ref(&salt, "sess-im"))
    }

    fn actor(id: &str) -> ImActor {
        ImActor { agent_id: id.into(), agent_name: format!("Name-{id}") }
    }

    fn asset(home: &Path, db: &AuthorityDb, session_id: &str) -> String {
        city_building::get_building(home, db.conn(), session_id).unwrap()["projection"]["asset_ref"]
            .as_str().unwrap().to_string()
    }

    #[test]
    fn envelope_v1_is_flat_kind_with_unix_seconds() {
        let env = envelope(
            "sr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &actor("nano"),
            "chat",
            json!({"text": "hi"}),
            1_761_180_000,
            "evt_test1",
        );
        assert_eq!(env["v"], 1);
        assert_eq!(env["id"], "evt_test1");
        assert_eq!(env["ts"], 1_761_180_000);
        assert_eq!(env["kind"], "chat");
        assert_eq!(env["agent_name"], "Name-nano");
        assert!(env.get("type").is_none());
        assert!(is_squad_envelope(&env));
        assert!(!is_squad_envelope(&json!({"type":"CityEntityChanged","kind":"set"})));
    }

    #[test]
    fn client_info_name_becomes_the_squad_actor() {
        assert_eq!(actor_from_client_name("").agent_name, "City MCP");
        assert_eq!(actor_from_client_name("codex").agent_id, "codex");
        assert_eq!(actor_from_client_name("Codex CLI").agent_name, "Codex");
        assert_eq!(actor_from_client_name("claude-code").agent_name, "Claude Code");
        assert_eq!(actor_from_client_name("cursor").agent_name, "Cursor");
        let custom = actor_from_client_name("Workshop Bot");
        assert_eq!(custom.agent_id, "workshop-bot");
        assert_eq!(custom.agent_name, "Workshop Bot");
        set_connection_client(Some("claude-code"));
        assert_eq!(connection_actor().agent_name, "Claude Code");
        set_connection_client(None);
        assert_eq!(connection_actor().agent_id, "city-mcp");
    }

    #[test]
    fn agents_cannot_publish_preview_set_reset_observe() {
        let (home, db, session_id) = seed();
        for kind in ["preview", "reject", "set", "reset", "observe"] {
            let err = publish(&home, db.conn(), &session_id, &actor("a"), kind, &json!({})).unwrap_err();
            assert_eq!(err.rule, "kind_forbidden", "{kind}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn chat_claim_release_and_steal() {
        let (home, db, session_id) = seed();
        let asset_ref = asset(&home, &db, &session_id);
        let nano = actor("nano");
        let byte = actor("byte");

        let chat = publish(&home, db.conn(), &session_id, &nano, "chat", &json!({"text": "heads up"})).unwrap();
        assert_eq!(chat["ok"], true);
        assert_eq!(chat["envelope"]["kind"], "chat");
        assert_eq!(chat["envelope"]["payload"]["text"], "heads up");
        assert!(chat["envelope"]["id"].as_str().unwrap().starts_with("evt_"));
        assert!(chat["envelope"]["ts"].as_i64().unwrap() > 0);
        let squad = read_squad_mailbox(&home).expect("squad mailbox");
        assert_eq!(squad["kind"], "chat");
        assert!(city_building::read_mailbox(&home).is_none());

        let claimed = publish(&home, db.conn(), &session_id, &nano, "claim", &json!({
            "asset_ref": asset_ref, "ttl_sec": 60
        })).unwrap();
        assert_eq!(claimed["ok"], true);
        assert_eq!(claimed["envelope"]["kind"], "claim");
        assert_eq!(claimed["envelope"]["payload"]["ttl_sec"], 60);
        assert!(claimed["envelope"]["payload"]["expires_at"].as_i64().unwrap() > now_unix_secs());
        let active = list_active_claims(&home, now_unix_secs());
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["agent_id"], "nano");

        let stolen = publish(&home, db.conn(), &session_id, &byte, "claim", &json!({
            "asset_ref": asset_ref
        })).unwrap();
        assert_eq!(stolen["ok"], true);
        assert_eq!(stolen["envelope"]["kind"], "claim");
        assert_eq!(stolen["envelope"]["agent_id"], "byte");
        assert_eq!(stolen["replaced"]["kind"], "release");
        assert_eq!(stolen["replaced"]["payload"]["reason"], "stolen");
        let active = list_active_claims(&home, now_unix_secs());
        assert_eq!(active[0]["agent_id"], "byte");

        let denied = publish(&home, db.conn(), &session_id, &nano, "release", &json!({
            "asset_ref": asset_ref
        })).unwrap();
        assert_eq!(denied["ok"], false);
        assert_eq!(denied["error"]["rule"], "not_holder");

        let released = publish(&home, db.conn(), &session_id, &byte, "release", &json!({
            "asset_ref": asset_ref
        })).unwrap();
        assert_eq!(released["ok"], true);
        assert_eq!(released["envelope"]["payload"]["reason"], "manual");
        assert!(list_active_claims(&home, now_unix_secs()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn set_won_clears_claim_and_does_not_overwrite_persist_mailbox() {
        let (home, db, session_id) = seed();
        let asset_ref = asset(&home, &db, &session_id);
        let nano = actor("nano");
        let _ = publish(&home, db.conn(), &session_id, &nano, "claim", &json!({
            "asset_ref": asset_ref
        })).unwrap();
        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let set = city_building::set_building_model(&home, db.conn(), &session_id, &inheritance, 0).unwrap();
        assert_eq!(set["ok"], true);
        let persist = city_building::read_mailbox(&home).expect("persist mailbox");
        assert_eq!(persist["action"], "set");
        assert_eq!(persist["type"], "CityEntityChanged");
        let squad = read_squad_mailbox(&home).expect("squad after set");
        // Last envelope is the building fanout `set`; set_won release is also on the channel.
        assert!(squad["kind"] == "set" || squad["kind"] == "release");
        assert!(list_active_claims(&home, now_unix_secs()).is_empty());
        assert_eq!(set["notify"]["channel"], "mailbox");
        let edit = city_building::read_edit_mailbox(&home);
        assert!(edit.is_none() || edit.unwrap()["action"] != "set");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn preview_and_reject_fanout_leave_persist_mailbox_intact() {
        let (home, db, session_id) = seed();
        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let set = city_building::set_building_model(&home, db.conn(), &session_id, &inheritance, 0).unwrap();
        assert_eq!(set["ok"], true);
        let persist_event = city_building::read_mailbox(&home).unwrap()["event_id"].clone();

        let pass = city_building::preview_building(&home, db.conn(), &session_id, &inheritance).unwrap();
        assert_eq!(pass["ok"], true);
        assert_eq!(pass["notify"]["action"], ENTITY_ACTION_PREVIEW);
        assert_eq!(city_building::read_mailbox(&home).unwrap()["event_id"], persist_event);
        let squad = read_squad_mailbox(&home).expect("squad preview");
        assert_eq!(squad["kind"], "preview");
        assert_eq!(squad["payload"]["ok"], true);
        assert_eq!(squad["payload"]["asset_ref"], set["projection"]["asset_ref"]);

        let pillar = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {
                "parts_remove": ["podium", "shaft", "roof", "door", "window"],
                "parts_add": [{"id": "pin", "kind": "box", "role": "wall", "at": [0.0, 0.0, 0.0], "size": [0.8, 10.0, 0.8]}]
            }
        });
        let fail = city_building::preview_building(&home, db.conn(), &session_id, &pillar).unwrap();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["notify"]["action"], ENTITY_ACTION_REJECT);
        let squad = read_squad_mailbox(&home).expect("squad reject");
        assert_eq!(squad["kind"], "reject");
        assert_eq!(squad["payload"]["ok"], false);
        assert_eq!(squad["payload"]["rule"], "invalid_model");
        assert_eq!(city_building::read_mailbox(&home).unwrap()["event_id"], persist_event);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn reset_fans_out_kind_reset_not_set() {
        let (home, db, session_id) = seed();
        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let set = city_building::set_building_model(&home, db.conn(), &session_id, &inheritance, 0).unwrap();
        assert_eq!(set["ok"], true);
        let reset = city_building::reset_building(&home, db.conn(), &session_id, 1).unwrap();
        assert_eq!(reset["ok"], true);
        let squad = read_squad_mailbox(&home).expect("squad reset");
        assert_eq!(squad["kind"], "reset");
        assert_eq!(squad["payload"]["ok"], true);
        assert_eq!(squad["payload"]["revision"], 2);
        assert!(squad["payload"]["build_event_id"].as_str().unwrap().starts_with("be_"));
        let persist = city_building::read_mailbox(&home).expect("persist after reset");
        assert_eq!(persist["action"], "reset");
        assert_eq!(persist["type"], "CityEntityChanged");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_auth_rejects_foreign_asset_ref() {
        let (home, db, session_id) = seed();
        let err = publish(&home, db.conn(), &session_id, &actor("nano"), "claim", &json!({
            "asset_ref": "ca_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        })).unwrap_err();
        assert_eq!(err.rule, "asset_mismatch");
        let _ = std::fs::remove_dir_all(&home);
    }
}
