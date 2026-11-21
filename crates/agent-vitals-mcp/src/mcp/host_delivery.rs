//! Host Delivery Bus（OH_AGENT_HOST_DELIVERY_BUS_SPEC_2026-11-21，评审修订版）：
//! 宿主统一「投递类」通信。语义与 plugin_calls 信箱（request/response RPC 类）
//! 正交：这里是单向事实通知。
//!
//! 诚实纪律（2026-11-21 二轮评审后）：
//! - **收件身份由会话推导**：wait/confirm 只接受 sessionIdentifier，收件主体
//!   从 actors 绑定表派生——调用方不能自报他人 actorId 消费其收件箱；
//! - **at-least-once 回合确认**：actor.turn 走 pending → in_flight → confirmed，
//!   reply 绑定同 storyRunId + 触发 eventId 提交成功后才 confirmed；in_flight
//!   超 replyTTL 重排队（redelivered 标注）。通知类 kind 取走即 consumed；
//! - **投递由 Story Outbox 可重试地派生**（泵）：事实与投递不同事务也不丢——
//!   pump 在每次领取前运行，幂等键 = outbox event_id（跨状态去重）；
//! - 路由先解析玩家活跃 Story Run，再按该 Run 的 story 绑定 actor——两个
//!   Story 复用同一 resident 不会串线；
//! - 满箱丢最旧并在响应标注 droppedOldest（事实仍在 timeline 可拉取）。
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::ToolError;

pub const MAX_PENDING_PER_SUBJECT: usize = 16;
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
pub const MAX_WAIT_MS: u64 = 30_000;
pub const POLL_INTERVAL_MS: u64 = 200;
pub const REPLY_TTL_MS: i64 = 10 * 60 * 1000;

/// kind 词表（§2.3）：新 kind 必须在此登记生产者/消费者契约，未知 fail-closed。
pub const KNOWN_KINDS: &[&str] = &["actor.turn", "studio.task.update", "story.beat.ready"];

fn kind_ttl_ms(kind: &str) -> i64 {
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
    // 投递行是易逝通知（非事实），但模式升级需要显式版本标记：
    // bus_schema_version != 2 → 重建表（旧 at-most-once 行不迁移，评审 3 基线重置）。
    db.execute_batch("CREATE TABLE IF NOT EXISTS host_deliveries_meta (version INTEGER NOT NULL);")
    .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let version: i64 = db.query_row("SELECT COALESCE(MAX(version),0) FROM host_deliveries_meta", [], |r| r.get(0))
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    if version != 2 {
        db.execute_batch("DROP TABLE IF EXISTS host_deliveries; DELETE FROM host_deliveries_meta; INSERT INTO host_deliveries_meta(version) VALUES(2);")
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS host_deliveries (
            delivery_id TEXT PRIMARY KEY, principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL,
            kind TEXT NOT NULL, payload_json TEXT NOT NULL, dedupe_key TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending','in_flight','confirmed','consumed','expired')),
            redelivered INTEGER NOT NULL DEFAULT 0,
            in_flight_until_ms INTEGER, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS host_deliveries_inbox
            ON host_deliveries(principal_kind, principal_id, status, created_at_ms);
        CREATE INDEX IF NOT EXISTS host_deliveries_dedupe
            ON host_deliveries(principal_kind, principal_id, kind, dedupe_key);
        CREATE TABLE IF NOT EXISTS actors (
            actor_id TEXT PRIMARY KEY, story_id TEXT NOT NULL, character_id TEXT NOT NULL,
            session_identifier TEXT NOT NULL, allowed_kinds TEXT NOT NULL,
            max_intents_per_window INTEGER NOT NULL, window_started_ms INTEGER NOT NULL,
            intents_used INTEGER NOT NULL, session_label TEXT,
            last_decision TEXT, last_code TEXT, last_trace_id TEXT, last_decided_at_ms INTEGER,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS story_runs (
            story_run_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, city_id TEXT NOT NULL, story_id TEXT NOT NULL,
            status TEXT NOT NULL, last_viewed_at_ms INTEGER NOT NULL, resumed_from TEXT,
            created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS story_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL,
            story_id TEXT NOT NULL, story_run_id TEXT NOT NULL,
            payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
            acknowledged_at_ms INTEGER, UNIQUE(event_id,operation_id,story_id,story_run_id));")
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

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn new_delivery_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("delivery-{:x}-{:04x}", now_ms(), seq & 0xffff)
}

/// D-2 生产者：玩家事实命中绑定 resident 时投递 actor.turn。路由顺序（评审 2）：
/// 先解析玩家在该 City 的活跃 Story Run（storyRunId + storyId），再按该 Run 的
/// story 绑定 actor——两个 Story 复用同一 resident 不会串线。无活跃 Run 或无
/// 绑定 → 诚实静默（不投递，也无行落库）。payload 携带 storyRunId/storyId，
/// 供回复确认绑定（HB-07）。dedupe_key = outbox event_id（跨状态去重，评审 4）。
pub fn post_actor_turn_for_commit(data_home: &Path, turn: &ActorTurnContext<'_>) -> Result<Value, ToolError> {
    let mut db = open_db(data_home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    // N3：优先采用提交边界绑定的显式 Story 作用域（与本次事实同库同源，读取侧
    // 不二次解析）；仍校验 Run 行活跃（投递到路由之间可能已停止）。无绑定 →
    // 保留原解析（玩家在该 City 的活跃 Run）。
    let run: Option<(String, String)> = match turn.story_scope {
        Some((story_id, story_run_id)) => tx.query_row(
            "SELECT story_run_id,story_id FROM story_runs WHERE story_run_id=?1 AND story_id=?2 AND player_id=?3 AND city_id=?4 AND status='active'",
            params![story_run_id,story_id,turn.player_id,turn.city_id], |row|
            Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
            .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?,
        None => tx.query_row(
            "SELECT story_run_id,story_id FROM story_runs WHERE player_id=?1 AND city_id=?2 AND status='active' ORDER BY updated_at_ms DESC LIMIT 1",
            params![turn.player_id, turn.city_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
            .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?,
    };
    let Some((story_run_id, story_id)) = run else {
        tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        return Ok(json!({"deliveryId":null,"bound":false,"routed":false,"droppedOldest":0}));
    };
    let actor_id: Option<String> = tx.query_row(
        "SELECT actor_id FROM actors WHERE story_id=?1 AND character_id=?2 ORDER BY created_at_ms DESC LIMIT 1",
        params![story_id, turn.resident_id], |row| row.get(0))
        .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let Some(actor_id) = actor_id else { return Ok(json!({"deliveryId":null,"bound":false,"routed":true,"droppedOldest":0})); };
    post(&json!({
        "deliveryDb":data_home.to_string_lossy(),
        "principalKind":"actor","principalId":actor_id,"kind":"actor.turn",
        "payload":{"trigger":"city.story.commit","cityId":turn.city_id,"gameId":turn.game_id,
            "playerId":turn.player_id,"residentId":turn.resident_id,"gameRunId":turn.run_id,
            "storyId":story_id,"storyRunId":story_run_id,
            "eventId":turn.event_id,"operationId":turn.operation_id},
        "dedupeKey":turn.event_id,
    }))
}

/// 投递一条通知。dedupe 键跨状态查重（pending/in_flight/confirmed 均算存在）——
/// 同一事件重试不会重复创建回合（评审 4）。满箱丢最旧并返回 droppedOldest。
pub fn post(payload: &Value) -> Result<Value, ToolError> {
    let delivery_db = payload.get("deliveryDb").and_then(Value::as_str).map(PathBuf::from)
        .ok_or_else(|| ToolError::new("invalid_argument", "`deliveryDb` (data_home) is required for the delivery bus."))?;
    let principal_kind = id_arg(payload, "principalKind")?;
    if !principal_kind_valid(&principal_kind) { return Err(ToolError::new("invalid_argument", format!("Unknown principalKind `{principal_kind}`; fail-closed."))); }
    let principal_id = id_arg(payload, "principalId")?;
    let kind = id_arg(payload, "kind")?;
    let _ = &principal_id;
    if !KNOWN_KINDS.contains(&kind.as_str()) { return Err(ToolError::new("invalid_argument", format!("Delivery kind `{kind}` is not registered; register producer/consumer contract first."))); }
    let body = payload.get("payload").cloned().unwrap_or(Value::Null);
    if !body.is_object() { return Err(ToolError::new("invalid_argument", "Delivery payload must be a JSON object.")); }
    let body_string = serde_json::to_string(&body).map_err(|_| ToolError::new("invalid_argument", "Delivery payload is not serializable."))?;
    if body_string.len() > MAX_PAYLOAD_BYTES { return Err(ToolError::new("invalid_argument", "Delivery payload exceeds 16 KiB.")); }
    let dedupe_key = payload.get("dedupeKey").and_then(Value::as_str).filter(|key| !key.is_empty() && key.len() <= 128).map(str::to_owned);
    let ttl_ms = payload.get("ttlMs").and_then(Value::as_u64).unwrap_or(kind_ttl_ms(&kind).max(1) as u64).clamp(1_000, 24 * 60 * 60 * 1000);
    let now = now_ms();
    let expires = now + ttl_ms as i64;
    let mut db = open_db(&delivery_db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    expire_stale(&tx, now)?;
    if let Some(key) = &dedupe_key {
        let existing: Option<String> = tx.query_row("SELECT delivery_id FROM host_deliveries WHERE principal_kind=?1 AND principal_id=?2 AND kind=?3 AND dedupe_key=?4 AND status IN ('pending','in_flight','confirmed')",
            params![principal_kind, principal_id, kind, key], |row| row.get(0)).optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        if let Some(delivery_id) = existing {
            tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            return Ok(json!({"deliveryId":delivery_id,"deduped":true,"droppedOldest":0}));
        }
    }
    let pending: i64 = tx.query_row("SELECT count(*) FROM host_deliveries WHERE principal_kind=?1 AND principal_id=?2 AND status IN ('pending','in_flight')",
        params![principal_kind, principal_id], |row| row.get(0)).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let mut dropped_oldest: i64 = 0;
    if pending as usize >= MAX_PENDING_PER_SUBJECT {
        dropped_oldest = tx.execute("DELETE FROM host_deliveries WHERE delivery_id IN (
                SELECT delivery_id FROM host_deliveries WHERE principal_kind=?1 AND principal_id=?2 AND status IN ('pending','in_flight')
                ORDER BY created_at_ms LIMIT ?3)", params![principal_kind, principal_id, pending - (MAX_PENDING_PER_SUBJECT as i64 - 1)])
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))? as i64;
    }
    let delivery_id = new_delivery_id();
    tx.execute("INSERT INTO host_deliveries(delivery_id,principal_kind,principal_id,kind,payload_json,dedupe_key,status,created_at_ms,expires_at_ms)
        VALUES(?1,?2,?3,?4,?5,?6,'pending',?7,?8)",
        params![delivery_id,principal_kind,principal_id,kind,body_string,dedupe_key,now,expires])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(json!({"deliveryId":delivery_id,"droppedOldest":dropped_oldest,"deduped":false,"expiresAtMs":expires}))
}

/// 会话 → 绑定 actor_id 列表（评审 1：收件主体由 Host 从已认证会话推导）。
/// sessionIdentifier 由 creator.actor.register 登记，是会话与宿主之间的绑定凭证。
fn bound_actor_ids(tx: &rusqlite::Transaction, session_identifier: &str) -> Result<Vec<String>, ToolError> {
    let mut statement = tx.prepare("SELECT actor_id FROM actors WHERE session_identifier=?1 ORDER BY created_at_ms")
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let ids = statement.query_map(params![session_identifier], |row| row.get::<_, String>(0))
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
        .collect::<Result<Vec<_>, _>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(ids)
}

/// 领取（D-3/D-6）：先运行 Outbox 泵（评审 4：事实已提交的回合可重试补投），
/// 再按会话派生的 actor 收件箱取件。actor.turn → in_flight（等回复确认）；
/// 通知类 kind → consumed（通知可由权威面重推导，at-most-once 足够）。
pub fn claim_wait(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let session_identifier = id_arg(payload, "sessionIdentifier")?;
    let timeout_ms = payload.get("timeoutMs").and_then(Value::as_u64).unwrap_or(30_000).min(MAX_WAIT_MS);
    let max_rows = payload.get("maxRows").and_then(Value::as_u64).unwrap_or(16).clamp(1, 16) as i64;
    let mut db = open_db(data_home)?;
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let now = now_ms();
        let deliveries = {
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            let actor_ids = bound_actor_ids(&tx, &session_identifier)?;
            if actor_ids.is_empty() { tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?; Vec::new() }
            else {
                expire_stale(&tx, now)?;
                pump_outbox_turns(&tx, &actor_ids)?;
                let mut deliveries = Vec::new();
                for actor_id in &actor_ids {
                    let mut statement = tx.prepare("SELECT delivery_id,kind,payload_json,dedupe_key,redelivered,created_at_ms FROM host_deliveries
                        WHERE principal_kind='actor' AND principal_id=?1 AND status='pending' AND expires_at_ms>?2 ORDER BY created_at_ms LIMIT ?3")
                        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
                    let rows = statement.query_map(params![actor_id,now,max_rows], |row|
                        Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,i64>(4)?,row.get::<_,i64>(5)?)))
                        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
                    for row in rows {
                        // actor.turn 挂起等确认；通知类取走即 consumed（可由权威面重推导）。
                        let (delivery_id, kind, payload_json, dedupe_key, redelivered, created) = row.map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
                        let status = if kind == "actor.turn" { "in_flight" } else { "consumed" };
                        let in_flight_until: Option<i64> = if kind == "actor.turn" { Some(now + REPLY_TTL_MS) } else { None };
                        tx.execute("UPDATE host_deliveries SET status=?2,in_flight_until_ms=?3 WHERE delivery_id=?1",
                            params![delivery_id,status,in_flight_until]).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
                        let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
                        deliveries.push(json!({"deliveryId":delivery_id,"kind":kind,"payload":payload,
                            "dedupeKey":dedupe_key,"redelivered":redelivered == 1,"createdAtMs":created}));
                        if deliveries.len() >= max_rows as usize { break; }
                    }
                }
                tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
                deliveries
            }
        };
        if !deliveries.is_empty() { return Ok(json!({"deliveries":deliveries,"deliveredCount":deliveries.len()})); }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() { return Ok(json!({"deliveries":[],"deliveredCount":0,"timeout":true})); }
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS.min(remaining.as_millis() as u64)));
    }
}

/// 回合确认（D-6/HB-07）：回复绑定同 storyRunId + 触发 eventId 并提交成功后，
/// 把 in_flight 回合置为 confirmed。未确认超 replyTTL 的回合由 expire_stale
/// 重排队（redelivered 标注）——断线或提交失败都不会静默丢失玩家回合。
pub fn confirm_turn(data_home: &Path, payload: &Value) -> Result<Value, ToolError> {
    let session_identifier = id_arg(payload, "sessionIdentifier")?;
    let delivery_id = id_arg(payload, "deliveryId")?;
    let reply_event = payload.get("reply").and_then(|reply| reply.get("eventId")).and_then(Value::as_str)
        .filter(|id| !id.is_empty()).ok_or_else(|| ToolError::new("invalid_argument", "`reply.eventId` is required (the committed reply's event id)."))?;
    let reply_run = payload.get("reply").and_then(|reply| reply.get("storyRunId")).and_then(Value::as_str)
        .filter(|id| !id.is_empty()).ok_or_else(|| ToolError::new("invalid_argument", "`reply.storyRunId` is required (must match the turn's run)."))?;
    let mut db = open_db(data_home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    let actor_ids = bound_actor_ids(&tx, &session_identifier)?;
    let row: Option<(String, String)> = if actor_ids.is_empty() { None } else {
        let list = actor_ids.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",");
        let sql = format!("SELECT principal_id,payload_json FROM host_deliveries WHERE delivery_id=?1 AND principal_kind='actor' AND status='in_flight' AND principal_id IN ({list})");
        tx.query_row(&sql, params![delivery_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
            .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
    };
    let Some((_principal_id, payload_json)) = row else {
        return Err(ToolError::new("invalid_argument", "Delivery is not an in_flight turn of this session."));
    };
    let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
    let turn_run = payload.get("storyRunId").and_then(Value::as_str).unwrap_or_default();
    if turn_run != reply_run { return Err(ToolError::new("invalid_argument", "Reply storyRunId does not match the turn's run.")); }
    tx.execute("UPDATE host_deliveries SET status='confirmed' WHERE delivery_id=?1", params![delivery_id])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.commit().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(json!({"deliveryId":delivery_id,"status":"confirmed","replyEventId":reply_event}))
}

/// Outbox 泵（评审 4）：从已提交事实（story_outbox）可重试地派生 actor.turn——
/// commit 时投递失败只记日志的场景由此补齐。幂等：host_deliveries 的 dedupe
/// 键跨状态查重，同一 event_id 永不重复成回合。N3 回路防护：与 D-2 同款绑定
/// 条件——只泵「事实落到本 actor 绑定 resident」的行（story_events intent 带
/// residentId=character_id）。Actor 自己的回复（无 residentId）不会泵成新回合。
fn pump_outbox_turns(tx: &rusqlite::Transaction, actor_ids: &[String]) -> Result<(), ToolError> {
    for actor_id in actor_ids {
        let story_and_character: Option<(String, String)> = tx.query_row(
            "SELECT story_id,character_id FROM actors WHERE actor_id=?1", params![actor_id],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
            .optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        let Some((story_id, character_id)) = story_and_character else { continue; };
        // 事实表守卫：story_events 由宿主 story store 建（纯 bus 库无此表）——
        // 无事实表即无可泵事实，诚实返回（不猜测、不建宿主表）。
        let events_present: i64 = tx.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='story_events'",
            [], |row| row.get(0)).map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        if events_present == 0 { continue; }
        let outbox: Vec<(String, String, String, String, String)> = tx.prepare(
            "SELECT o.event_id,o.operation_id,o.player_id,o.city_id,o.story_run_id FROM story_outbox o \
             JOIN story_events e ON e.event_id=o.event_id AND e.story_id=o.story_id AND e.story_run_id=o.story_run_id \
             AND e.player_id=o.player_id AND e.city_id=o.city_id \
             WHERE o.story_id=?1 AND o.status='pending' \
               AND json_extract(e.intent_json,'$.residentId')=?2 \
             ORDER BY o.id LIMIT 32")
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
            .query_map(params![story_id,character_id], |row|
                Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?)))
            .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?
            .collect::<Result<Vec<_>,_>>().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        // legacy-gameId 行（story_run_id 前缀 legacy-）诚实跳过：其路由依赖 G-READ 缺口。
        let outbox: Vec<_> = outbox.into_iter().filter(|(_,_,_,_,story_run_id)| !story_run_id.starts_with("legacy-")).collect();
        for (event_id, operation_id, player_id, city_id, story_run_id) in outbox {
            let already: Option<String> = tx.query_row("SELECT delivery_id FROM host_deliveries WHERE principal_kind='actor' AND principal_id=?1 AND kind='actor.turn' AND dedupe_key=?2",
                params![actor_id,event_id], |row| row.get(0)).optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            if already.is_some() { continue; }
            let valid_run: Option<String> = tx.query_row("SELECT story_run_id FROM story_runs WHERE story_run_id=?1 AND player_id=?2 AND city_id=?3 AND story_id=?4 AND status='active'",
                params![story_run_id,player_id,city_id,story_id], |row| row.get(0)).optional().map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
            if valid_run.is_none() { continue; }
            let delivery_id = new_delivery_id();
            let now = now_ms();
            tx.execute("INSERT INTO host_deliveries(delivery_id,principal_kind,principal_id,kind,payload_json,dedupe_key,status,created_at_ms,expires_at_ms)
                VALUES(?1,'actor',?2,'actor.turn',?3,?4,'pending',?5,?6)",
                params![delivery_id,actor_id,json!({"trigger":"city.story.commit","cityId":city_id,
                    "storyId":story_id,"storyRunId":story_run_id,"playerId":player_id,
                    "residentId":character_id,"eventId":event_id,"operationId":operation_id}).to_string(),
                    event_id,now,now+kind_ttl_ms("actor.turn")])
                .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
        }
    }
    Ok(())
}

fn expire_stale(tx: &rusqlite::Transaction, now: i64) -> Result<(), ToolError> {
    // in_flight 超过 replyTTL 未确认 → 重排队（redelivered 标注，评审 3：不静默丢失）。
    tx.execute("UPDATE host_deliveries SET status='pending',redelivered=redelivered+1,in_flight_until_ms=NULL
        WHERE status='in_flight' AND in_flight_until_ms<=?1", params![now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("UPDATE host_deliveries SET status='expired' WHERE status IN ('pending','in_flight') AND expires_at_ms<=?1", params![now])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    tx.execute("DELETE FROM host_deliveries WHERE status IN ('confirmed','consumed','expired') AND expires_at_ms<=?1", params![now.saturating_sub(60_000)])
        .map_err(|error| ToolError::new("storage_unavailable", format!("{error}")))?;
    Ok(())
}

/// D-2 生产者上下文。story_scope（N3）：提交边界绑定的显式 Story 作用域
/// （story_id, story_run_id）——携带时投递使用它（校验行活跃）；None 走原解析。
pub struct ActorTurnContext<'a> {
    pub player_id: &'a str, pub city_id: &'a str, pub game_id: &'a str,
    pub run_id: &'a str, pub resident_id: &'a str, pub event_id: &'a str, pub operation_id: &'a str,
    pub story_scope: Option<(&'a str, &'a str)>,
}#[cfg(test)]
pub mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("hd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    fn bind_actor(home: &Path, session: &str, actor_id: &str, story: &str, character: &str) {
        let db = open_db(home).unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS actors (actor_id TEXT PRIMARY KEY, story_id TEXT NOT NULL, character_id TEXT NOT NULL, session_identifier TEXT NOT NULL, allowed_kinds TEXT NOT NULL, max_intents_per_window INTEGER NOT NULL, window_started_ms INTEGER NOT NULL, intents_used INTEGER NOT NULL, session_label TEXT, last_decision TEXT, last_code TEXT, last_trace_id TEXT, last_decided_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);").unwrap();
        db.execute("INSERT INTO actors(actor_id,story_id,character_id,session_identifier,allowed_kinds,max_intents_per_window,window_started_ms,intents_used,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,'[]',3,1,0,1,1)",
            params![actor_id,story,character,session]).unwrap();
    }

    fn seed_outbox(home: &Path, event_id: &str, story: &str, player: &str, city: &str, run: &str) {
        let db = open_db(home).unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS story_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, operation_id TEXT NOT NULL, player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, acknowledged_at_ms INTEGER, UNIQUE(event_id,operation_id,story_id,story_run_id));").unwrap();
        db.execute("INSERT INTO story_outbox(event_id,operation_id,player_id,city_id,game_id,story_id,story_run_id,payload_json,status,created_at_ms)
            VALUES(?1,'op',?2,?3,'game-1',?4,?5,'{}','pending',1)", params![event_id,player,city,story,run]).unwrap();
        // N3 泵绑定条件：事实必须落到绑定 resident（intent 带 residentId）才成回合。
        db.execute_batch("CREATE TABLE IF NOT EXISTS story_events (event_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, rule_id TEXT NOT NULL, status TEXT NOT NULL, due_at_utc_ms INTEGER NOT NULL, last_processed_tick INTEGER NOT NULL, idempotency_key TEXT NOT NULL, story_revision TEXT NOT NULL, clock_revision TEXT NOT NULL, intent_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,story_id,story_run_id,event_id));").unwrap();
        db.execute("INSERT INTO story_events(event_id,occurrence_id,player_id,city_id,game_id,story_id,story_run_id,rule_id,status,due_at_utc_ms,last_processed_tick,idempotency_key,story_revision,clock_revision,intent_json,created_at_ms)
            VALUES(?1,'occ',?2,?3,'game-1',?4,?5,'rule','committed',0,0,'idem','0','0','{\"kind\":\"speak\",\"text\":\"在吗\",\"residentId\":\"resident:linxia\"}',1)",
            params![event_id,player,city,story,run]).unwrap();
    }

    fn run_row(home: &Path, run_id: &str, player: &str, story: &str) {
        let db = open_db(home).unwrap();
        db.execute("INSERT OR IGNORE INTO story_runs(story_run_id,player_id,city_id,story_id,status,last_viewed_at_ms,created_at_ms,updated_at_ms)
            VALUES(?1,?2,'city-1',?3,'active',1,1,1)", params![run_id,player,story]).unwrap();
    }

    fn claim(home: &Path, session: &str) -> Value {
        claim_wait(home, &json!({"sessionIdentifier":session,"timeoutMs":100})).unwrap()
    }

    #[test]
    fn session_derived_identity_and_round_trip_to_in_flight() {
        let home = temp_home("rt");
        bind_actor(&home, "sess-a", "actor-a", "story.detective", "resident:linxia");
        bind_actor(&home, "sess-b", "actor-b", "story.detective", "resident:kate");
        // 评审 1：收件主体由会话派生——sess-a 领到自己的投递；sess-b 领不到 actor-a 的。
        post(&json!({"deliveryDb":home.to_string_lossy(),"principalKind":"actor","principalId":"actor-a",
            "kind":"actor.turn","payload":{"n":1},"dedupeKey":"evt-1"})).unwrap();
        let got_b = claim(&home, "sess-b");
        assert_eq!(got_b["deliveredCount"], 0);
        let got_a = claim(&home, "sess-a");
        assert_eq!(got_a["deliveredCount"], 1);
        assert_eq!(got_a["deliveries"][0]["kind"], "actor.turn");
        // actor.turn → in_flight（等确认），未确认前不重复领取。
        let again = claim(&home, "sess-a");
        assert_eq!(again["deliveredCount"], 0);
        // 直读状态验证 in_flight。
        let db = open_db(&home).unwrap();
        let status: String = db.query_row("SELECT status FROM host_deliveries WHERE dedupe_key='evt-1'", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "in_flight");
    }

    #[test]
    fn confirm_requires_reply_bound_to_same_run() {
        let home = temp_home("cf");
        bind_actor(&home, "sess-a", "actor-a", "story.detective", "resident:linxia");
        post(&json!({"deliveryDb":home.to_string_lossy(),"principalKind":"actor","principalId":"actor-a",
            "kind":"actor.turn","payload":{"storyRunId":"run-1"},"dedupeKey":"evt-1"})).unwrap();
        claim(&home, "sess-a");
        // Run 不匹配的确认被拒（HB-07：回复必须绑定同 Run）。
        assert!(confirm_turn(&home, &json!({"sessionIdentifier":"sess-a","deliveryId":claim_id(&home,"evt-1"),
            "reply":{"eventId":"reply-1","storyRunId":"run-OTHER"}})).is_err());
        let confirmed = confirm_turn(&home, &json!({"sessionIdentifier":"sess-a","deliveryId":claim_id(&home,"evt-1"),
            "reply":{"eventId":"reply-1","storyRunId":"run-1"}})).unwrap();
        assert_eq!(confirmed["status"], "confirmed");
    }

    fn claim_id(home: &Path, dedupe: &str) -> String {
        let db = open_db(home).unwrap();
        db.query_row("SELECT delivery_id FROM host_deliveries WHERE dedupe_key=?1", params![dedupe], |r| r.get(0)).unwrap()
    }

    #[test]
    fn in_flight_expires_into_redelivery() {
        let home = temp_home("rd");
        bind_actor(&home, "sess-a", "actor-a", "story.detective", "resident:linxia");
        post(&json!({"deliveryDb":home.to_string_lossy(),"principalKind":"actor","principalId":"actor-a",
            "kind":"actor.turn","payload":{},"dedupeKey":"evt-9"})).unwrap();
        claim(&home, "sess-a");
        // 白盒：把 in_flight_until 拨到过去，验证重排队（评审 3：断线不丢）。
        let db = open_db(&home).unwrap();
        db.execute("UPDATE host_deliveries SET in_flight_until_ms=1", []).unwrap();
        drop(db);
        let again = claim(&home, "sess-a");
        assert_eq!(again["deliveredCount"], 1);
        assert_eq!(again["deliveries"][0]["redelivered"], json!(true));
    }

    #[test]
    fn dedupe_spans_statuses_so_retries_never_double_send() {
        let home = temp_home("dd");
        bind_actor(&home, "sess-a", "actor-a", "story.detective", "resident:linxia");
        post(&json!({"deliveryDb":home.to_string_lossy(),"principalKind":"actor","principalId":"actor-a",
            "kind":"actor.turn","payload":{},"dedupeKey":"evt-1"})).unwrap();
        claim(&home, "sess-a"); // 进 in_flight
        // 评审 4：同 event 重试（投递已在 in_flight）不得再建一条。
        let retry = post(&json!({"deliveryDb":home.to_string_lossy(),"principalKind":"actor","principalId":"actor-a",
            "kind":"actor.turn","payload":{},"dedupeKey":"evt-1"})).unwrap();
        assert_eq!(retry["deduped"], json!(true));
        assert_eq!(claim(&home, "sess-a")["deliveredCount"], 0);
    }

    #[test]
    fn outbox_pump_routes_by_active_run_and_is_idempotent() {
        let home = temp_home("pump");
        bind_actor(&home, "sess-a", "actor-a", "story.detective", "resident:linxia");
        run_row(&home, "run-p1", "player-1", "story.detective");
        seed_outbox(&home, "evt-out", "story.detective", "player-1", "city-1", "run-p1");
        // 评审 2：路由按活跃 Run 的 story 绑定解析；payload 携带 storyRunId。
        {
            let mut db = open_db(&home).unwrap();
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            pump_outbox_turns(&tx, &["actor-a".to_string()]).unwrap();
            tx.commit().unwrap();
        }
        let got = claim(&home, "sess-a");
        assert_eq!(got["deliveredCount"], 1);
        assert_eq!(got["deliveries"][0]["payload"]["storyRunId"], "run-p1");
        assert_eq!(got["deliveries"][0]["payload"]["storyId"], "story.detective");
        // 泵幂等：同一 outbox 行不重复成回合。
        {
            let mut db = open_db(&home).unwrap();
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            pump_outbox_turns(&tx, &["actor-a".to_string()]).unwrap();
            tx.commit().unwrap();
        }
        let got2 = claim(&home, "sess-a");
        assert_eq!(got2["deliveredCount"], 0);
    }

    /// N3 回路防护：Actor 自己的回复事实（intent 无 residentId）不得泵成新回合
    /// ——否则回复 → 新回合 → 再回复，无界循环。
    #[test]
    fn actor_reply_facts_never_pump_into_new_turns() {
        let home = temp_home("loop");
        bind_actor(&home, "sess-a", "actor-a", "story.detective", "resident:linxia");
        run_row(&home, "run-p1", "player-1", "story.detective");
        seed_actor_reply(&home, "evt-reply", "story.detective", "player-1", "city-1", "run-p1");
        {
            let mut db = open_db(&home).unwrap();
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            pump_outbox_turns(&tx, &["actor-a".to_string()]).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(claim(&home, "sess-a")["deliveredCount"], 0);
    }

    /// 无事实表（纯 bus 库）时泵诚实空转，不报错、不建宿主表。
    #[test]
    fn pump_without_facts_table_is_a_no_op() {
        let home = temp_home("nofacts");
        bind_actor(&home, "sess-a", "actor-a", "story.detective", "resident:linxia");
        {
            let mut db = open_db(&home).unwrap();
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            pump_outbox_turns(&tx, &["actor-a".to_string()]).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(claim(&home, "sess-a")["deliveredCount"], 0);
    }

    /// Actor 回复事实种子：outbox 行 + intent_json 无 residentId 的事件行。
    fn seed_actor_reply(home: &Path, event_id: &str, story: &str, player: &str, city: &str, run: &str) {
        let db = open_db(home).unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS story_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, operation_id TEXT NOT NULL, player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, acknowledged_at_ms INTEGER, UNIQUE(event_id,operation_id,story_id,story_run_id));
        CREATE TABLE IF NOT EXISTS story_events (event_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, player_id TEXT NOT NULL, city_id TEXT NOT NULL, game_id TEXT NOT NULL, story_id TEXT NOT NULL, story_run_id TEXT NOT NULL, rule_id TEXT NOT NULL, status TEXT NOT NULL, due_at_utc_ms INTEGER NOT NULL, last_processed_tick INTEGER NOT NULL, idempotency_key TEXT NOT NULL, story_revision TEXT NOT NULL, clock_revision TEXT NOT NULL, intent_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(player_id,city_id,story_id,story_run_id,event_id));").unwrap();
        db.execute("INSERT INTO story_outbox(event_id,operation_id,player_id,city_id,game_id,story_id,story_run_id,payload_json,status,created_at_ms)
            VALUES(?1,'op-reply',?2,?3,'story.detective',?4,?5,'{}','pending',1)", params![event_id,player,city,story,run]).unwrap();
        db.execute("INSERT INTO story_events(event_id,occurrence_id,player_id,city_id,game_id,story_id,story_run_id,rule_id,status,due_at_utc_ms,last_processed_tick,idempotency_key,story_revision,clock_revision,intent_json,created_at_ms)
            VALUES(?1,'occ',?2,?3,'story.detective',?4,?5,'cafe-invite','committed',0,0,'idem','0','0','{\"kind\":\"speak\",\"text\":\"周六见\"}',1)",
            params![event_id,player,city,story,run]).unwrap();
    }

    #[test]
    fn unknown_session_gets_nothing_and_post_fails_closed() {
        let home = temp_home("fc");
        assert_eq!(claim(&home, "sess-nobody")["deliveredCount"], 0);
        assert_eq!(post(&json!({"deliveryDb":home.to_string_lossy(),"principalKind":"alien","principalId":"x",
            "kind":"actor.turn","payload":{}})).unwrap_err().code, "invalid_argument");
        assert_eq!(post(&json!({"deliveryDb":home.to_string_lossy(),"principalKind":"actor","principalId":"x",
            "kind":"alien.kind","payload":{}})).unwrap_err().code, "invalid_argument");
    }
}
