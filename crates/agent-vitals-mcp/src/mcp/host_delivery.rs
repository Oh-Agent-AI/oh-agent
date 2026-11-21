//! Host Delivery Bus（OH_AGENT_HOST_DELIVERY_BUS_SPEC_2026-11-21）：宿主统一
//! 「投递类」通信。语义与 plugin_calls 信箱（request/response RPC 类）正交：
//! 这里是单向事实通知，无应答，宿主铸造 delivery_id，取走即 delivered。
//!
//! 诚实纪律：满箱丢最旧并在响应标注 droppedOldest（事实仍在 timeline 可拉取，
//! 推-拉互补）；未知 kind fail-closed；fetch+ack 同一 IMMEDIATE 事务（并发 wait
//! 不重复投递）；TTL 惰性过期（照 expire_runs 模式）。
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::ToolError;

pub const MAX_PENDING_PER_SUBJECT: usize = 16;
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_WAIT_MS: u64 = 30_000;
pub const POLL_INTERVAL_MS: u64 = 200;

/// kind 词表（§2.3）：新 kind 必须在此登记生产者/消费者契约，未知 fail-closed。
pub const KNOWN_KINDS: &[&str] = &["actor.turn", "studio.task.update", "story.beat.ready"];

/// 满箱与 TTL 的 per-kind 策略（统一「丢最旧 + 标注」，§2.2 G1 修订版）。
fn kind_ttl_ms(kind: &str) -> u64 {
    match kind {
        "actor.turn" => 10 * 60 * 1000,
        _ => 24 * 60 * 60 * 1000,
    }
}

fn delivery_db(data_home: &Path) -> Result<PathBuf, ToolError> {
    let directory = data_home.join("state/creator");
    std::fs::create_dir_all(&directory)
        .map_err(|_| ToolError::new("storage_unavailable", "Creator data directory is not writable; delivery bus needs it."))?;
    Ok(directory.join("projects.sqlite"))
}

fn open_db(data_home: &Path) -> Result<rusqlite::Connection, ToolError> {
    let db = rusqlite::Connection::open(delivery_db(data_home)?)
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let _ = db.busy_timeout(std::time::Duration::from_secs(3));
    let _ = db.execute_batch("PRAGMA journal_mode=WAL;");
    ensure_schema(&db)?;
    Ok(db)
}

fn ensure_schema(db: &rusqlite::Connection) -> Result<(), ToolError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS host_deliveries (
            delivery_id TEXT PRIMARY KEY, principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL,
            kind TEXT NOT NULL, payload_json TEXT NOT NULL, dedupe_key TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending','delivered','expired')),
            created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS host_deliveries_inbox
            ON host_deliveries(principal_kind, principal_id, status, created_at_ms);")
    .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))
}

fn principal_kind_valid(kind: &str) -> bool {
    matches!(kind, "player" | "actor" | "studio" | "external-session" | "city-webview")
}

fn id_arg(payload: &Value, key: &str) -> Result<String, ToolError> {
    payload.get(key).and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_')))
        .map(str::to_owned)
        .ok_or_else(|| ToolError::new("invalid_argument", format!("`{key}` is required (1..=128 id chars).")))
}

/// 投递一条通知（D-1）。满箱丢最旧并返回 droppedOldest 数（推-拉互补：被丢的
/// 事实仍可从 timeline/账本拉取）。dedupe_key 幂等：同键 pending 已存在则原样
/// 返回该行，不重复投递。
pub fn post(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let principal_kind = id_arg(payload, "principalKind")?;
    if !principal_kind_valid(&principal_kind) { return Err(ToolError::new("invalid_argument", format!("Unknown principalKind `{principal_kind}`; fail-closed."))); }
    let principal_id = id_arg(payload, "principalId")?;
    let kind = id_arg(payload, "kind")?;
    if !KNOWN_KINDS.contains(&kind.as_str()) { return Err(ToolError::new("invalid_argument", format!("Delivery kind `{kind}` is not registered; register producer/consumer contract first."))); }
    let body = payload.get("payload").cloned().unwrap_or(Value::Null);
    if !body.is_object() { return Err(ToolError::new("invalid_argument", "Delivery payload must be a JSON object.")); }
    let body_string = serde_json::to_string(&body).map_err(|_| ToolError::new("invalid_argument", "Delivery payload is not serializable."))?;
    if body_string.len() > MAX_PAYLOAD_BYTES { return Err(ToolError::new("invalid_argument", "Delivery payload exceeds 16 KiB.")); }
    let dedupe_key = payload.get("dedupeKey").and_then(Value::as_str).filter(|key| !key.is_empty() && key.len() <= 128).map(str::to_owned);
    let ttl_ms = payload.get("ttlMs").and_then(Value::as_u64).unwrap_or(kind_ttl_ms(&kind)).clamp(1_000, 24 * 60 * 60 * 1000);
    let now = now_ms();
    let expires = now + ttl_ms as i64;
    let mut db = open_db(data_home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    expire_stale(&tx, now)?;
    if let Some(key) = &dedupe_key {
        let existing: Option<String> = tx.query_row("SELECT delivery_id FROM host_deliveries WHERE principal_kind=?1 AND principal_id=?2 AND kind=?3 AND dedupe_key=?4 AND status='pending'",
            params![principal_kind, principal_id, kind, key], |row| row.get(0)).optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        if let Some(delivery_id) = existing {
            tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            return Ok(json!({"deliveryId":delivery_id,"deduped":true,"droppedOldest":0}));
        }
    }
    let pending: i64 = tx.query_row("SELECT count(*) FROM host_deliveries WHERE principal_kind=?1 AND principal_id=?2 AND status='pending'",
        params![principal_kind, principal_id], |row| row.get(0)).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let mut dropped_oldest: i64 = 0;
    if pending as usize >= MAX_PENDING_PER_SUBJECT {
        // 丢最旧（推-拉互补）：返回被丢行数，事实仍可从 timeline/账本拉取。
        dropped_oldest = tx.execute("DELETE FROM host_deliveries WHERE delivery_id IN (
                SELECT delivery_id FROM host_deliveries WHERE principal_kind=?1 AND principal_id=?2 AND status='pending'
                ORDER BY created_at_ms LIMIT ?3)", params![principal_kind, principal_id, pending - (MAX_PENDING_PER_SUBJECT as i64 - 1)])
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))? as i64;
    }
    let delivery_id = new_delivery_id()?;
    tx.execute("INSERT INTO host_deliveries(delivery_id,principal_kind,principal_id,kind,payload_json,dedupe_key,status,created_at_ms,expires_at_ms)
        VALUES(?1,?2,?3,?4,?5,?6,'pending',?7,?8)",
        params![delivery_id,principal_kind,principal_id,kind,body_string,dedupe_key,now,expires])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(json!({"deliveryId":delivery_id,"droppedOldest":dropped_oldest,"deduped":false,"expiresAtMs":expires}))
}

/// 长轮询取件（D-1/D-3）：阻塞至该主体出现 pending 投递或超时；读取+标记
/// delivered 在同一 IMMEDIATE 事务内（G3，并发 wait 不重复投递）；超时返回空数组。
pub fn wait(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let principal_kind = id_arg(payload, "principalKind")?;
    if !principal_kind_valid(&principal_kind) { return Err(ToolError::new("invalid_argument", format!("Unknown principalKind `{principal_kind}`; fail-closed."))); }
    let principal_id = id_arg(payload, "principalId")?;
    let timeout_ms = payload.get("timeoutMs").and_then(Value::as_u64).unwrap_or(30_000).min(MAX_WAIT_MS);
    let max_rows = payload.get("maxRows").and_then(Value::as_u64).unwrap_or(16).clamp(1, 16) as i64;
    let kinds_filter: Option<Vec<String>> = payload.get("kinds").and_then(Value::as_array).map(|kinds|
        kinds.iter().filter_map(Value::as_str).map(str::to_owned).collect());
    if let Some(kinds) = &kinds_filter {
        for kind in kinds { if !KNOWN_KINDS.contains(&kind.as_str()) { return Err(ToolError::new("invalid_argument", format!("Delivery kind `{kind}` is not registered."))); } }
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut db = open_db(data_home)?;
    loop {
        let now = now_ms();
        {
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            let deliveries = fetch_and_ack(&tx, &principal_kind, &principal_id, kinds_filter.as_deref(), max_rows, now)?;
            if !deliveries.is_empty() {
                tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
                return Ok(json!({"deliveries":deliveries,"deliveredCount":deliveries.len()}));
            }
            // 无投递：事务提交（含惰性过期清理）后继续等待。
            tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() { return Ok(json!({"deliveries":[],"deliveredCount":0,"timeout":true})); }
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS.min(remaining.as_millis() as u64)));
    }
}

fn fetch_and_ack(tx: &rusqlite::Transaction, principal_kind: &str, principal_id: &str,
    kinds: Option<&[String]>, max_rows: i64, now: i64) -> Result<Vec<Value>, ToolError> {
    expire_stale(tx, now)?;
    let mut sql = "SELECT delivery_id,kind,payload_json,dedupe_key,created_at_ms,expires_at_ms FROM host_deliveries
        WHERE principal_kind=?1 AND principal_id=?2 AND status='pending' AND expires_at_ms>?3".to_string();
    let kinds_filter_on = kinds.is_some();
    if kinds_filter_on { sql.push_str(" AND kind IN (SELECT value FROM json_each(?4))"); }
    sql.push_str(if kinds_filter_on { " ORDER BY created_at_ms LIMIT ?5" } else { " ORDER BY created_at_ms LIMIT ?4" });
    let mut statement = tx.prepare(&sql).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let rows = if kinds_filter_on {
        let kinds_json = serde_json::to_string(kinds.unwrap_or(&Vec::new())).unwrap_or_else(|_| "[]".to_string());
        statement.query_map(params![principal_kind,principal_id,now,kinds_json,max_rows], |row|
            Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,i64>(4)?,row.get::<_,i64>(5)?)))
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
            .collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
    } else {
        statement.query_map(params![principal_kind,principal_id,now,max_rows], |row|
            Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,i64>(4)?,row.get::<_,i64>(5)?)))
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
            .collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
    };
    let mut deliveries = Vec::new();
    for (delivery_id, kind, payload_json, dedupe_key, created, expires) in rows {
        tx.execute("UPDATE host_deliveries SET status='delivered' WHERE delivery_id=?1", params![delivery_id])
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
        deliveries.push(json!({"deliveryId":delivery_id,"kind":kind,"payload":payload,
            "dedupeKey":dedupe_key,"createdAtMs":created,"expiresAtMs":expires}));
    }
    Ok(deliveries)
}

fn expire_stale(tx: &rusqlite::Transaction, now: i64) -> Result<(), ToolError> {
    tx.execute("UPDATE host_deliveries SET status='expired' WHERE status='pending' AND expires_at_ms<=?1", params![now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("DELETE FROM host_deliveries WHERE status IN ('delivered','expired') AND expires_at_ms<=?1", params![now.saturating_sub(60_000)])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn new_delivery_id() -> Result<String, ToolError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(format!("delivery-{:x}-{:04x}", now_ms(), seq & 0xffff))
}

/// actor 绑定查找（D-2 生产者侧）：按 character_id（residentId）找绑定 actor。
/// 返回 (actorId, sessionId)；无绑定 → None（不投递，诚实静默）。
pub fn bound_actor_for_resident(tx: &rusqlite::Transaction, story_id: &str, character_id: &str) -> Result<Option<(String, String)>, ToolError> {
    tx.query_row("SELECT actor_id,session_identifier FROM actors WHERE story_id=?1 AND character_id=?2 ORDER BY created_at_ms DESC LIMIT 1",
        params![story_id,character_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))
}
/// D-2 生产者侧：city.story.commit 命中绑定 resident 时投递 actor.turn。
/// 绑定按 character_id（residentId）查找（resident 命名空间按 canon 全局唯一）；
/// 无绑定 → Ok 诚实静默（不投递，也无行落库）。dedupe_key=event_id。
/// 提交上下文（D-2）：把 commit_at 的身份字段打包成一个参数，避免 8 参函数。
pub struct ActorTurnContext<'a> {
    pub player_id: &'a str, pub city_id: &'a str, pub game_id: &'a str,
    pub run_id: &'a str, pub resident_id: &'a str, pub event_id: &'a str, pub operation_id: &'a str,
}

pub fn post_actor_turn_for_commit(data_home: &Path, turn: &ActorTurnContext<'_>) -> Result<Value, ToolError> {
    let mut db = open_db(data_home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let bound = tx.query_row("SELECT actor_id,session_identifier FROM actors WHERE character_id=?1 ORDER BY created_at_ms DESC LIMIT 1",
        params![turn.resident_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let Some((actor_id, _session)) = bound else { return Ok(json!({"deliveryId":null,"bound":false,"droppedOldest":0})); };
    post(data_home, &json!({
        "principalKind":"actor","principalId":actor_id,"kind":"actor.turn",
        "payload":{"trigger":"city.story.commit","cityId":turn.city_id,"gameId":turn.game_id,
            "playerId":turn.player_id,"residentId":turn.resident_id,"runId":turn.run_id,
            "eventId":turn.event_id,"operationId":turn.operation_id},
        "dedupeKey":turn.event_id,
    }))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("host-delivery-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn post_to(home: &Path, principal: &str, kind: &str, dedupe: Option<&str>, seq: u64) -> Value {
        post(home, &json!({"principalKind":"actor","principalId":principal,"kind":kind,
            "payload":{"seq":seq},"dedupeKey":dedupe})).unwrap()
    }

    #[test]
    fn post_wait_round_trip_marks_delivered_once() {
        let home = temp_home("rt");
        post_to(&home, "actor-1", "actor.turn", None, 1);
        let first = wait(&home, &json!({"principalKind":"actor","principalId":"actor-1","timeoutMs":100})).unwrap();
        assert_eq!(first["deliveredCount"], 1);
        assert_eq!(first["deliveries"][0]["kind"], "actor.turn");
        assert_eq!(first["deliveries"][0]["payload"]["seq"], 1);
        let second = wait(&home, &json!({"principalKind":"actor","principalId":"actor-1","timeoutMs":100})).unwrap();
        assert_eq!(second["deliveredCount"], 0);
        assert_eq!(second["timeout"], json!(true));
    }

    #[test]
    fn full_inbox_drops_oldest_and_reports_count() {
        let home = temp_home("full");
        for seq in 1..=MAX_PENDING_PER_SUBJECT as u64 + 1 { post_to(&home, "actor-2", "actor.turn", None, seq); }
        let last = post_to(&home, "actor-2", "actor.turn", None, 18);
        assert_eq!(last["droppedOldest"], 1); // 逐条溢出逐出 1 条最旧（箱子恒 ≤16）
        let fetched = wait(&home, &json!({"principalKind":"actor","principalId":"actor-2","timeoutMs":100})).unwrap();
        let deliveries = fetched["deliveries"].as_array().unwrap();
        assert_eq!(deliveries.len(), MAX_PENDING_PER_SUBJECT);
        assert_eq!(deliveries[0]["payload"]["seq"], 3); // 最旧两条已被逐出
        assert_eq!(deliveries.last().unwrap()["payload"]["seq"], 18);
    }

    #[test]
    fn dedupe_key_replays_return_existing_row() {
        let home = temp_home("dedupe");
        let first = post_to(&home, "actor-3", "actor.turn", Some("evt-1"), 1);
        let replay = post_to(&home, "actor-3", "actor.turn", Some("evt-1"), 2);
        assert_eq!(first["deliveryId"], replay["deliveryId"]);
        assert_eq!(replay["deduped"], json!(true));
    }

    #[test]
    fn ttl_expires_lazily_on_next_wait() {
        let home = temp_home("ttl");
        post_to(&home, "actor-4", "actor.turn", None, 1);
        // 白盒：把到期时间拨到过去，验证惰性过期（不 sleep）。
        let db = rusqlite::Connection::open(delivery_db(&home).unwrap()).unwrap();
        db.execute("UPDATE host_deliveries SET expires_at_ms=1", []).unwrap();
        drop(db);
        let fetched = wait(&home, &json!({"principalKind":"actor","principalId":"actor-4","timeoutMs":100})).unwrap();
        assert_eq!(fetched["deliveredCount"], 0);
    }

    #[test]
    fn unknown_kind_and_principal_fail_closed() {
        let home = temp_home("failclosed");
        assert_eq!(post(&home, &json!({"principalKind":"alien","principalId":"x","kind":"actor.turn","payload":{}})).unwrap_err().code, "invalid_argument");
        assert_eq!(post(&home, &json!({"principalKind":"actor","principalId":"x","kind":"alien.kind","payload":{}})).unwrap_err().code, "invalid_argument");
        assert_eq!(wait(&home, &json!({"principalKind":"alien","principalId":"x","timeoutMs":100})).unwrap_err().code, "invalid_argument");
    }

    #[test]
    fn subjects_are_isolated() {
        let home = temp_home("iso");
        post_to(&home, "actor-a", "actor.turn", None, 1);
        let other = wait(&home, &json!({"principalKind":"actor","principalId":"actor-b","timeoutMs":100})).unwrap();
        assert_eq!(other["deliveredCount"], 0);
        let own = wait(&home, &json!({"principalKind":"actor","principalId":"actor-a","timeoutMs":100})).unwrap();
        assert_eq!(own["deliveredCount"], 1);
    }
}
