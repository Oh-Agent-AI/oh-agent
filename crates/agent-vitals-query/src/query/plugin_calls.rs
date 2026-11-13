//! Descriptor-neutral, bounded local request/reply mailbox for built-in plugins.
//!
//! This module stores opaque envelopes only. The host must authorize methods
//! against the active plugin descriptor before claiming or delivering a call.
//!
//! 传输预算（设计 AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION §5.5）：默认 64 KiB
//! 保持历史行为；需要更大载荷的调用方经 `call_with_budgets`/`submit_with_budget`
//! 传入宿主 clamp 后的按方法预算。响应超预算时终结调用（写入小错误响应），
//! 不遗留 claimed 等待超时。
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const MAX_CALL_BYTES: usize = 64 * 1024;
const MAX_PENDING_PER_PLUGIN: i64 = 64;
const MAX_CALL_RECORDS_PER_PLUGIN: i64 = 256;
const MAX_CALL_RECORDS_TOTAL: i64 = 4096;
const MAX_TTL_MS: u64 = 120_000;
const MAX_PAGE: usize = 16;

fn valid_token(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|byte| byte.is_ascii_alphanumeric()
        || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn open(home: &Path) -> Result<Connection, &'static str> {
    let dir = home.join("state/plugin-calls");
    std::fs::create_dir_all(&dir).map_err(|_| "plugin_call_store_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "plugin_call_store_unavailable")?;
    }
    let path = dir.join("calls.sqlite");
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| "plugin_call_store_unavailable")?;
    db.busy_timeout(Duration::from_secs(2)).map_err(|_| "plugin_call_store_unavailable")?;
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS plugin_calls(
            call_id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            method TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','claimed','completed')),
            claimed_instance TEXT,
            response TEXT
        );
        CREATE INDEX IF NOT EXISTS plugin_calls_pending ON plugin_calls(plugin_id,status,created_at_ms);")
        .map_err(|_| "plugin_call_store_unavailable")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "plugin_call_store_unavailable")?;
    }
    Ok(db)
}

fn now_ms() -> Result<i64, &'static str> {
    let value = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "plugin_call_clock_invalid")?.as_millis();
    i64::try_from(value).map_err(|_| "plugin_call_clock_invalid")
}

fn new_id() -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "plugin_call_id_unavailable")?;
    Ok(format!("pc_{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

/// Submit an opaque call. The caller must use a method declared by the target
/// plugin; the receiving host independently checks that descriptor grant.
pub fn submit(home: &Path, plugin_id: &str, method: &str, payload: &Value, ttl_ms: u64) -> Result<String, &'static str> {
    submit_with_budget(home, plugin_id, method, payload, ttl_ms, MAX_CALL_BYTES)
}

/// 按方法传输预算的提交变体（§5.5）：request_max_bytes 由宿主 clamp 后传入。
pub fn submit_with_budget(home: &Path, plugin_id: &str, method: &str, payload: &Value, ttl_ms: u64, request_max_bytes: usize) -> Result<String, &'static str> {
    if !valid_token(plugin_id, 64) || !valid_token(method, 96) || !payload.is_object()
        || ttl_ms == 0 || ttl_ms > MAX_TTL_MS { return Err("plugin_call_invalid"); }
    let encoded = serde_json::to_string(payload).map_err(|_| "plugin_call_invalid")?;
    if encoded.len() > request_max_bytes { return Err("plugin_call_too_large"); }
    let now = now_ms()?;
    let expires = now.checked_add(ttl_ms as i64).ok_or("plugin_call_invalid")?;
    let db = open(home)?;
    let tx = db.unchecked_transaction().map_err(|_| "plugin_call_store_unavailable")?;
    tx.execute("DELETE FROM plugin_calls WHERE expires_at_ms<?1", [now]).map_err(|_| "plugin_call_store_unavailable")?;
    let pending: i64 = tx.query_row("SELECT count(*) FROM plugin_calls WHERE plugin_id=?1 AND status IN ('pending','claimed')", [plugin_id], |row| row.get(0))
        .map_err(|_| "plugin_call_store_unavailable")?;
    if pending >= MAX_PENDING_PER_PLUGIN { return Err("plugin_call_capacity"); }
    let retained: i64 = tx.query_row("SELECT count(*) FROM plugin_calls WHERE plugin_id=?1", [plugin_id], |row| row.get(0))
        .map_err(|_| "plugin_call_store_unavailable")?;
    let total: i64 = tx.query_row("SELECT count(*) FROM plugin_calls", [], |row| row.get(0))
        .map_err(|_| "plugin_call_store_unavailable")?;
    if retained >= MAX_CALL_RECORDS_PER_PLUGIN || total >= MAX_CALL_RECORDS_TOTAL { return Err("plugin_call_capacity"); }
    let id = new_id()?;
    tx.execute("INSERT INTO plugin_calls(call_id,plugin_id,method,payload,created_at_ms,expires_at_ms,status)
        VALUES(?1,?2,?3,?4,?5,?6,'pending')", params![id,plugin_id,method,encoded,now,expires])
        .map_err(|_| "plugin_call_store_unavailable")?;
    tx.commit().map_err(|_| "plugin_call_store_unavailable")?;
    Ok(id)
}

/// Claim a bounded page of pending calls using only methods authorized by the
/// active descriptor. Claiming is atomic so two host pollers cannot duplicate work.
pub fn claim_pending(home: &Path, plugin_id: &str, instance_id: &str, allowed_methods: &[String], limit: usize) -> Result<Vec<Value>, &'static str> {
    if !valid_token(plugin_id, 64) || !valid_token(instance_id, 128) || allowed_methods.len() > 128
        || !(1..=MAX_PAGE).contains(&limit) { return Err("plugin_call_invalid"); }
    if allowed_methods.iter().any(|method| !valid_token(method, 96)) { return Err("plugin_call_invalid"); }
    let now = now_ms()?;
    let mut db = open(home)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| "plugin_call_store_unavailable")?;
    tx.execute("DELETE FROM plugin_calls WHERE expires_at_ms<?1", [now]).map_err(|_| "plugin_call_store_unavailable")?;
    let mut statement = tx.prepare("SELECT call_id,method,payload FROM plugin_calls WHERE plugin_id=?1 AND status='pending' AND expires_at_ms>=?2 ORDER BY created_at_ms,call_id LIMIT ?3")
        .map_err(|_| "plugin_call_store_unavailable")?;
    let rows = statement.query_map(params![plugin_id,now,limit as i64], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))
        .map_err(|_| "plugin_call_store_unavailable")?;
    let candidates = rows.collect::<Result<Vec<_>,_>>().map_err(|_| "plugin_call_store_unavailable")?;
    drop(statement);
    let mut out = Vec::new();
    for (id,method,body) in candidates {
        if !allowed_methods.iter().any(|allowed| allowed == &method) { continue; }
        let changed = tx.execute("UPDATE plugin_calls SET status='claimed',claimed_instance=?1 WHERE call_id=?2 AND status='pending' AND expires_at_ms>=?3",
            params![instance_id,id,now]).map_err(|_| "plugin_call_store_unavailable")?;
        if changed != 1 { continue; }
        let payload = serde_json::from_str::<Value>(&body).map_err(|_| "plugin_call_store_unavailable")?;
        out.push(json!({"callId":id,"method":method,"payload":payload}));
    }
    tx.commit().map_err(|_| "plugin_call_store_unavailable")?;
    Ok(out)
}

/// Complete a call only from the instance that claimed it.
pub fn respond(home: &Path, plugin_id: &str, instance_id: &str, call_id: &str, response: &Value) -> Result<(), &'static str> {
    respond_with_budget(home, plugin_id, instance_id, call_id, response, MAX_CALL_BYTES)
}

/// 按方法响应预算的完成变体（§5.5）：响应超预算时终结调用——写入小错误响应
/// 让 wait_response 立即拿到终态（而不是让 claimed 挂到过期），并向宿主返回
/// plugin_call_too_large 以便调用方改用分块或更小载荷。
pub fn respond_with_budget(home: &Path, plugin_id: &str, instance_id: &str, call_id: &str, response: &Value, response_max_bytes: usize) -> Result<(), &'static str> {
    if !valid_token(plugin_id, 64) || !valid_token(instance_id, 128) || !valid_token(call_id, 64) || !response.is_object() {
        return Err("plugin_call_invalid");
    }
    let encoded = serde_json::to_string(response).map_err(|_| "plugin_call_invalid")?;
    if encoded.len() > response_max_bytes {
        let db = open(home)?;
        let error_response = json!({"error":{"code":"plugin_call_too_large"}}).to_string();
        db.execute("UPDATE plugin_calls SET status='completed',response=?1 WHERE call_id=?2 AND plugin_id=?3 AND claimed_instance=?4 AND status='claimed'",
            params![error_response,call_id,plugin_id,instance_id])
            .map_err(|_| "plugin_call_store_unavailable")?;
        return Err("plugin_call_too_large");
    }
    let now = now_ms()?;
    let db = open(home)?;
    let changed = db.execute("UPDATE plugin_calls SET status='completed',response=?1 WHERE call_id=?2 AND plugin_id=?3
        AND claimed_instance=?4 AND status='claimed' AND expires_at_ms>=?5", params![encoded,call_id,plugin_id,instance_id,now])
        .map_err(|_| "plugin_call_store_unavailable")?;
    if changed == 1 { Ok(()) } else { Err("plugin_call_unavailable") }
}

/// 宿主按方法执行响应预算（§5.5）前的查询：被本实例 claim 且未完成调用的方法名。
pub fn claimed_call_method(home: &Path, plugin_id: &str, instance_id: &str, call_id: &str) -> Result<Option<String>, &'static str> {
    if !valid_token(plugin_id, 64) || !valid_token(instance_id, 128) || !valid_token(call_id, 64) {
        return Err("plugin_call_invalid");
    }
    let db = open(home)?;
    let row: Option<String> = db.query_row(
        "SELECT method FROM plugin_calls WHERE call_id=?1 AND plugin_id=?2 AND claimed_instance=?3 AND status='claimed'",
        params![call_id, plugin_id, instance_id], |row| row.get(0)).optional().map_err(|_| "plugin_call_store_unavailable")?;
    Ok(row)
}

/// Return a call to the queue when host delivery failed before it reached the
/// WebView. It remains claimable only by a later poll of an authorized host.
pub fn release_claim(home: &Path, plugin_id: &str, instance_id: &str, call_id: &str) -> Result<(), &'static str> {
    if !valid_token(plugin_id, 64) || !valid_token(instance_id, 128) || !valid_token(call_id, 64) {
        return Err("plugin_call_invalid");
    }
    let db = open(home)?;
    db.execute("UPDATE plugin_calls SET status='pending',claimed_instance=NULL WHERE call_id=?1 AND plugin_id=?2
        AND claimed_instance=?3 AND status='claimed'", params![call_id,plugin_id,instance_id])
        .map_err(|_| "plugin_call_store_unavailable")?;
    Ok(())
}

/// Make calls claimed by a replaced WebView available to the current one.
pub fn release_orphaned_claims(home: &Path, plugin_id: &str, active_instance_id: &str) -> Result<(), &'static str> {
    if !valid_token(plugin_id, 64) || !valid_token(active_instance_id, 128) { return Err("plugin_call_invalid"); }
    let db = open(home)?;
    db.execute("UPDATE plugin_calls SET status='pending',claimed_instance=NULL WHERE plugin_id=?1
        AND status='claimed' AND claimed_instance<>?2", params![plugin_id,active_instance_id])
        .map_err(|_| "plugin_call_store_unavailable")?;
    Ok(())
}

/// Return a response when ready; None means the call is still outstanding or expired.
pub fn response(home: &Path, call_id: &str) -> Result<Option<Value>, &'static str> {
    if !valid_token(call_id, 64) { return Err("plugin_call_invalid"); }
    let db = open(home)?;
    read_response(&db, call_id)
}

fn read_response(db: &Connection, call_id: &str) -> Result<Option<Value>, &'static str> {
    let now = now_ms()?;
    let row: Option<(String,Option<String>)> = db.query_row("SELECT status,response FROM plugin_calls WHERE call_id=?1 AND expires_at_ms>=?2", params![call_id,now],
        |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| "plugin_call_store_unavailable")?;
    match row {
        None => Err("plugin_call_expired"),
        Some((status,Some(body))) if status == "completed" => serde_json::from_str(&body).map(Some).map_err(|_| "plugin_call_store_unavailable"),
        Some(_) => Ok(None),
    }
}

/// Wait synchronously on the local MCP worker for one bounded call result.
pub fn wait_response(home: &Path, call_id: &str, timeout_ms: u64) -> Result<Value, &'static str> {
    if !valid_token(call_id, 64) || timeout_ms == 0 || timeout_ms > MAX_TTL_MS { return Err("plugin_call_invalid"); }
    let db = open(home)?;
    let started = std::time::Instant::now();
    loop {
        if let Some(value) = read_response(&db, call_id)? { return Ok(value); }
        if started.elapsed() >= Duration::from_millis(timeout_ms) { return Err("plugin_call_timeout"); }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Submit then await one descriptor-authorized plugin method. Callers choose
/// the registered plugin/method; the host remains the final authorization gate.
pub fn call(home: &Path, plugin_id: &str, method: &str, payload: &Value, timeout_ms: u64) -> Result<Value, &'static str> {
    let call_id = submit(home, plugin_id, method, payload, timeout_ms)?;
    wait_response(home, &call_id, timeout_ms)
}

/// 按方法传输预算的提交+等待变体（§5.5）：request 预算在提交时执行，
/// response 预算由宿主 respond 侧执行（见 respond_with_budget）。
pub fn call_with_budgets(home: &Path, plugin_id: &str, method: &str, payload: &Value, timeout_ms: u64,
    request_max_bytes: usize) -> Result<Value, &'static str> {
    let call_id = submit_with_budget(home, plugin_id, method, payload, timeout_ms, request_max_bytes)?;
    wait_response(home, &call_id, timeout_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("plugin-calls-test-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 默认 64 KiB：超预算请求拒绝。
    #[test]
    fn oversize_request_is_rejected_at_default_budget() {
        let home = home();
        let payload = json!({"blob": "A".repeat(MAX_CALL_BYTES + 1)});
        assert_eq!(submit(&home, "city", "city.ping", &payload, 60_000).unwrap_err(), "plugin_call_too_large");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 按方法预算放宽后同负载可入箱；响应侧超预算终结调用（写小错误响应）
    /// 而不是遗留 claimed 挂到过期。
    #[test]
    fn budget_override_allows_large_request_and_oversize_response_terminates() {
        let home = home();
        let payload = json!({"blob": "A".repeat(70_000)});
        submit_with_budget(&home, "city", "city.ping", &payload, 60_000, 128 * 1024).unwrap();
        let call_id: String = {
            let db = open(&home).unwrap();
            db.query_row("SELECT call_id FROM plugin_calls WHERE plugin_id='city' AND status='pending'", [], |row| row.get(0)).unwrap()
        };
        // claim 后以超预算响应完成 → 写入小错误响应并终结
        claim_pending(&home, "city", "inst-1", &["city.ping".into()], 4).unwrap();
        let oversize_response = json!({"blob": "B".repeat(70_000)});
        assert_eq!(respond_with_budget(&home, "city", "inst-1", &call_id, &oversize_response, 64 * 1024).unwrap_err(), "plugin_call_too_large");
        // 调用已终结（completed），wait_response 拿到错误响应而不是挂到超时
        let result = wait_response(&home, &call_id, 2_000).unwrap();
        assert_eq!(result["error"]["code"], "plugin_call_too_large");
        let _ = std::fs::remove_dir_all(&home);
    }
}
