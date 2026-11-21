//! Actor 适配器（V3 PR-5 尾巴，docs/OH_AGENT_ACTOR_ADAPTER_SPEC_2026-11-21.md）：
//! 宿主铸造 actor 身份、预算闸、事实落地读面与 actor 提交闸。Actor 的本质是
//! "会话第一句话的提示词"——register/turn.context 返回确定性合成的 sessionPrompt。
//!
//! 数据边界（用户指令 2026-11-21）：宿主保留极少数据——身份行 + 预算计数 +
//! last-decision 四列，仅此而已。**不存**对话历史、Prompt、LLM 输出原文、
//! 模型/API 凭据、会话路径、actor 目标表、actor 任务表；会话记忆、目标管理、
//! 任务拆解全部归外部 coding agent 宿主自持（Codex/Claude 的 thread 能力），
//! 宿主零模型调用。`turn.context` 是事实落地读面（新 thread 冷启动对齐），
//! 不是对话记忆。
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{canonical_json, database, new_id, now_ms, valid_id};

const BUDGET_WINDOW_MS: u64 = 3_600_000;
const ACTOR_KINDS_V1: [&str; 6] = ["speak", "move", "interact", "invite", "give", "quest.action"];
const MAX_RECENT_EVENTS: usize = 16;
const SESSION_PROMPT_MAX_BYTES: usize = 8 * 1024;
const CANON_SLICE_MAX_BYTES: usize = 4 * 1024;

pub(crate) fn migrate(db: &Connection) -> Result<(), &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS actors (
        actor_id TEXT PRIMARY KEY, story_id TEXT NOT NULL, character_id TEXT NOT NULL,
        session_identifier TEXT NOT NULL, allowed_kinds TEXT NOT NULL,
        max_intents_per_window INTEGER NOT NULL, window_started_ms INTEGER NOT NULL,
        intents_used INTEGER NOT NULL, session_label TEXT,
        last_decision TEXT, last_code TEXT, last_trace_id TEXT, last_decided_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        UNIQUE(story_id, session_identifier, character_id)
    );").map_err(|_| "creator_store_unavailable")
}

/// session_identifier 白名单：ASCII 字母数字与 `_ - : .`——`/` 与 `\` 不在
/// 白名单，文件系统路径天然被拒（AGENTS.md 分发面不携带本机路径）。
fn valid_session_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

/// canon_json 内是否含该角色：canon 是创作者有界对象（≤64KiB），允许单角色
/// 形状（顶层 characterId）或多角色集合（任意层级的 characterId 成员）。
fn canon_contains_character(canon: &Value, character_id: &str) -> bool {
    match canon {
        Value::String(text) => text == character_id,
        Value::Object(object) => {
            // 两种键并存：narrative-sdk CharacterCanonV1 用 characterId；
            // story_registry 测试/创作者形态用 id。匹配任一即视为命中。
            if ["characterId", "id"].iter().any(|key| object.get(*key).and_then(Value::as_str) == Some(character_id)) { return true; }
            object.values().any(|value| canon_contains_character(value, character_id))
        }
        Value::Array(items) => items.iter().any(|value| canon_contains_character(value, character_id)),
        _ => false,
    }
}

struct ActorRow {
    story_id: String,
    character_id: String,
    session_identifier: String,
    allowed_kinds: String,
    max_intents_per_window: i64,
    intents_used: i64,
}

fn actor_row(home: &Path, actor_id: &str) -> Result<Option<ActorRow>, &'static str> {
    if !valid_id(actor_id) { return Err("story_argument_invalid"); }
    let db = database(home)?;
    migrate(&db)?;
    db.query_row("SELECT story_id,character_id,session_identifier,allowed_kinds,max_intents_per_window,intents_used FROM actors WHERE actor_id=?1",
        [actor_id],
        |row| Ok(ActorRow {
            story_id: row.get::<_, String>(0)?, character_id: row.get::<_, String>(1)?,
            session_identifier: row.get::<_, String>(2)?, allowed_kinds: row.get::<_, String>(3)?,
            max_intents_per_window: row.get::<_, i64>(4)?, intents_used: row.get::<_, i64>(5)?,
        }))
        .optional().map_err(|_| "creator_store_unavailable")
}

/// 窗口滚动：now 越过窗口起点 + 1h → 重置计数（确定性、测试可用任意 now）。
fn roll_budget_window(db: &Connection, actor_id: &str, window_started_ms: i64, now: u64) -> Result<bool, &'static str> {
    if (now as i64).saturating_sub(window_started_ms) < BUDGET_WINDOW_MS as i64 { return Ok(false); }
    let changed = db.execute("UPDATE actors SET intents_used=0,window_started_ms=?2,updated_at_ms=?2 WHERE actor_id=?1 AND window_started_ms=?3",
        params![actor_id,now as i64,window_started_ms]).map_err(|_| "creator_store_unavailable")?;
    Ok(changed == 1)
}

fn allowed_kinds_of(row: &ActorRow) -> Result<Vec<String>, &'static str> {
    serde_json::from_str::<Vec<String>>(&row.allowed_kinds).map_err(|_| "creator_store_unavailable")
}

/// 注册：宿主铸造 actor 身份。双幂等——operationId 由调用方纪律保证；
/// 身份幂等：同 (story,session,character) 返回既有 actor 行，预算/窗口延续
/// （堵"重注册 = 刷预算"）。Canon 先行：canon 缺该角色拒绝（story_canon_character_missing）。
pub(crate) fn register(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let story_id = payload.get("storyId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let character_id = payload.get("characterId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let session_identifier = payload.get("sessionIdentifier").and_then(Value::as_str).filter(|id| valid_session_identifier(id)).ok_or("story_argument_invalid")?;
    let allowed_kinds = payload.get("allowedKinds").and_then(Value::as_array)
        .filter(|kinds| !kinds.is_empty() && kinds.len() <= 6
            && kinds.iter().all(|kind| ACTOR_KINDS_V1.contains(&kind.as_str().unwrap_or(""))))
        .ok_or("story_argument_invalid")?;
    let max_intents = payload.get("maxIntentsPerWindow").and_then(Value::as_u64)
        .filter(|max| (1..=200).contains(max)).ok_or("story_argument_invalid")?;
    let session_label = payload.get("sessionLabel").and_then(Value::as_str)
        .filter(|label| !label.is_empty() && label.len() <= 128 && !label.contains('/')).unwrap_or("");
    let operation_id = payload.get("operationId").and_then(Value::as_str)
        .filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let now = now_ms();
    let mut db = database(home)?;
    crate::story_registry::migrate(&db)?;
    migrate(&db)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "creator_store_unavailable")?;
    // 身份幂等先于铸造：同 (story,session,character) 返回既有 actor，预算延续。
    let existing: Option<String> = tx.query_row("SELECT actor_id FROM actors WHERE story_id=?1 AND session_identifier=?2 AND character_id=?3",
        params![story_id,session_identifier,character_id], |row| row.get::<_, String>(0)).optional().map_err(|_| "creator_store_unavailable")?;
    if let Some(actor_id) = existing {
        let (used, max, window_started) = tx.query_row("SELECT intents_used,max_intents_per_window,window_started_ms FROM actors WHERE actor_id=?1",
            [&actor_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))
            .map_err(|_| "creator_store_unavailable")?;
        tx.commit().map_err(|_| "creator_store_unavailable")?;
        return Ok(json!({"actorId":actor_id,"storyId":story_id,"characterId":character_id,
            "sessionIdentifier":session_identifier,"existing":true,
            "budget":{"used":used,"max":max,"windowResetsAtMs":window_started.saturating_add(BUDGET_WINDOW_MS as i64)}}));
    }
    let _ = operation_id;
    let canon = crate::story_registry::project_canon(home, story_id)?;
    let canon = canon.ok_or("story_project_not_found")?;
    if !canon_contains_character(&canon, character_id) { return Err("story_canon_character_missing"); }
    let actor_id = new_id("actor-")?;
    let kinds_json = canonical_json(&Value::Array(allowed_kinds.clone())).map_err(|_| "story_argument_invalid")?;
    tx.execute("INSERT INTO actors(actor_id,story_id,character_id,session_identifier,allowed_kinds,max_intents_per_window,window_started_ms,intents_used,session_label,last_decision,last_code,last_trace_id,last_decided_at_ms,created_at_ms,updated_at_ms)
        VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,NULL,NULL,NULL,NULL,?9,?9)",
        params![actor_id,story_id,character_id,session_identifier,kinds_json,max_intents as i64,now as i64,session_label,now as i64])
        .map_err(|_| "creator_store_unavailable")?;
    tx.commit().map_err(|_| "creator_store_unavailable")?;
    let kinds: Vec<String> = allowed_kinds.iter().map(|kind| kind.as_str().unwrap_or("").to_string()).collect();
    let prompt = session_prompt(&canon, character_id, &kinds, max_intents, 0, &json!({"beats":[],"start":"","deadEnds":[]}));
    Ok(json!({"actorId":actor_id,"storyId":story_id,"characterId":character_id,
        "sessionIdentifier":session_identifier,"existing":false,
        "budget":{"used":0,"max":max_intents,"windowResetsAtMs":now as i64 + BUDGET_WINDOW_MS as i64},
        "sessionPrompt":prompt}))
}

/// 事实落地读面：Canon 节选 + 活跃 Run 摘要 + 最近事件 + eligibleBeats 菜单 +
/// 确定性 sessionPrompt。只读；新 thread 冷启动对齐用，不是对话记忆。
pub(crate) fn turn_context(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let actor_id = payload.get("actorId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    // 评审 P1-b：三类事实查询必须绑定 Host 授权的运行作用域（player/run），
    // 否则同 Story 多玩家/多周目的事件互相污染 eligibleBeats 依赖判定。
    // 作用域由 Host 对 story_runs 行校验授权（player 匹配 + 属于本 story + 活跃），
    // 不采信调用方自报的归属。
    let scope = payload.get("scope").and_then(Value::as_object)
        .ok_or("actor_context_scope_required")?;
    let scope_player = scope.get("playerId").and_then(Value::as_str).filter(|id| valid_id(id))
        .ok_or("actor_context_scope_invalid")?;
    let scope_run = scope.get("storyRunId").and_then(Value::as_str).filter(|id| valid_id(id))
        .ok_or("actor_context_scope_invalid")?;
    let now = now_ms();
    let window_started = row_window_started(home, actor_id)?;
    {
        let db = database(home)?;
        roll_budget_window(&db, actor_id, window_started, now)?;
    }
    let row = actor_row(home, actor_id)?.ok_or("actor_not_found")?;
    let used = row.intents_used;
    let max = row.max_intents_per_window;
    let story = crate::story_registry::project_read(home, &json!({"storyId":row.story_id}))?;
    let canon = story.get("canon").cloned().unwrap_or(Value::Null);
    let canon_slice = truncate_json(&canon, CANON_SLICE_MAX_BYTES);
    let db = database(home)?;
    let run_row: (String, String, String) = db.query_row(
        "SELECT player_id,status,city_id FROM story_runs WHERE story_run_id=?1 AND story_id=?2 AND player_id=?3 AND status IN ('active','paused')",
        params![scope_run,row.story_id,scope_player], |row|
        Ok((row.get(0)?,row.get(1)?,row.get(2)?)))
        .optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("story_run_not_found")?;
    let (run_player, run_status, run_city) = run_row;
    let committed = committed_event_ids(home, &row.story_id, &run_player, scope_run, &run_city)?;
    let graph = story.get("graph").cloned().unwrap_or(Value::Null);
    let eligible = eligible_beats(&graph, &committed);
    let runs = run_summaries(home, &row.story_id, &run_player, scope_run)?;
    let recent = recent_events(home, &row.story_id, &run_player, scope_run)?;
    let allowed = allowed_kinds_of(&row)?;
    let budget = json!({"used":used,"max":max,"windowResetsAtMs":window_started + BUDGET_WINDOW_MS as i64});
    let prompt = session_prompt(&canon_slice, &row.character_id, &allowed, max as u64, used as u64, &eligible);
    Ok(json!({"actorId":actor_id,"storyId":row.story_id,"characterId":row.character_id,
        "sessionIdentifier":row.session_identifier,"budget":budget,
        "scope":{"playerId":run_player,"cityId":run_city,"storyRunId":scope_run,"runStatus":run_status},
        "canon":canon_slice,"runs":runs,"recentEvents":recent,"eligibleBeats":eligible,
        "sessionPrompt":prompt}))
}

/// actor 提交闸：预算 → kind 白名单 → scope 分派（私有委托管线 / 公共走租约）
/// → last-decision 覆盖 + 预算扣减。语义裁决（知识/规则）归管线与宿主复算，
/// 本闸只做身份/预算/绑定检查。预算计数在过闸后递增（含语义拒绝的尝试），
/// budget_exhausted 本身不消耗。
pub(crate) fn submit(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let actor_id = payload.get("actorId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let intent = payload.get("intent").filter(|value| value.is_object()).ok_or("story_argument_invalid")?;
    let now = now_ms();
    let window_started = row_window_started(home, actor_id)?;
    {
        let db = database(home)?;
        roll_budget_window(&db, actor_id, window_started, now)?;
    }
    let row = actor_row(home, actor_id)?.ok_or("actor_not_found")?;
    let (decision, code) = if row.intents_used >= row.max_intents_per_window {
        ("rejected", "actor_budget_exhausted".to_string())
    } else {
        let kind = intent.get("kind").and_then(Value::as_str).unwrap_or("");
        let allowed = allowed_kinds_of(&row)?;
        if !allowed.contains(&kind.to_string()) { ("rejected", "intent_kind_not_allowed".to_string()) }
        else {
            let scope = intent.get("scope").cloned().unwrap_or(Value::Null);
            let scope_kind = scope.get("kind").and_then(Value::as_str).unwrap_or("");
            let outcome: Result<Value, String> = match scope_kind {
                // 私有 kind：委托管线。绑定隔离：intent.scope.storyId 必须等于
                // actor 绑定的 story（AA-09）；活跃 Run 校验在管线内。
                "story" => {
                    let scope_story = scope.get("storyId").and_then(Value::as_str).unwrap_or("");
                    if scope_story != row.story_id { Err("story_binding_mismatch".to_string()) }
                    else {
                        // 底层双层契约（V3-09）：语义仲裁拒绝走 Ok({accepted:false,code})。
                        // 适配器必须保留裁决——不得把业务拒绝报告为 accepted（评审 P1-a）。
                        crate::actor_intent::submit_intent(home, intent)
                            .map_err(|code| code.to_string())
                            .and_then(|receipt| {
                                if receipt.get("accepted").and_then(Value::as_bool) == Some(false) {
                                    Err(receipt.get("code").and_then(Value::as_str).unwrap_or("story_rejected").to_string())
                                } else { Ok(json!({"committed":receipt})) }
                            })
                    }
                }
                // 公共 move：租约（actor 持有，ADR-03 扩展）→ write_resident_state。
                // 本期不落 story_events（边界如实，见报告）。
                "city-resident-public" if kind == "move" => public_move(home, actor_id, intent, &scope)
                    .map(|(value, _)| value)
                    .map_err(|code| code.to_string()),
                _ => Err("intent_scope_invalid".to_string()),
            };
            match outcome {
                Ok(_) => ("accepted", String::new()),
                Err(code) => ("rejected", code),
            }
        }
    };
    let trace_id = new_id("actor-turn-")?;
    let used_after = if code == "actor_budget_exhausted" { row.intents_used } else { row.intents_used + 1 };
    let db = database(home)?;
    migrate(&db)?;
    db.execute("UPDATE actors SET intents_used=?2,last_decision=?3,last_code=?4,last_trace_id=?5,last_decided_at_ms=?6,updated_at_ms=?6 WHERE actor_id=?1",
        params![actor_id,used_after,decision,code,trace_id,now as i64])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(json!({"accepted":decision=="accepted",
        "code":if code.is_empty() { Value::Null } else { json!(code) },
        "traceId":trace_id,"actorId":actor_id,"intentsUsed":used_after,
        "budgetMax":row.max_intents_per_window}))
}

fn row_window_started(home: &Path, actor_id: &str) -> Result<i64, &'static str> {
    let db = database(home)?;
    migrate(&db)?;
    db.query_row("SELECT window_started_ms FROM actors WHERE actor_id=?1", [actor_id],
        |row| row.get::<_, i64>(0)).optional().map_err(|_| "creator_store_unavailable")?
        .ok_or("actor_not_found")
}

/// 公共 move：租约（actor 持有，ADR-03 扩展）→ write_resident_state。
/// 本期不落 story_events（边界如实）；审计由 lease_events 覆盖。
fn public_move(home: &Path, actor_id: &str, intent: &Value, scope: &Value) -> Result<(Value, String), &'static str> {
    let city_id = scope.get("cityId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let resident_id = scope.get("residentId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let location_ref = intent.get("args").and_then(|args| args.get("locationRef")).and_then(Value::as_str)
        .filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let intent_id = intent.get("intentId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("story_argument_invalid")?;
    let trace_id = new_id("actor-move-")?;
    let lease = crate::story_registry::lease_acquire(home, &json!({"cityId":city_id,"residentId":resident_id,
        "holderActorId":actor_id,"holderIntentId":intent_id,"traceId":trace_id}))?;
    if lease.get("acquired").and_then(Value::as_bool) != Some(true) {
        return Err("resident_activity_busy");
    }
    let revision = resident_state_revision(home, city_id, resident_id)?;
    let state = crate::story_store::write_resident_state(home,
        &json!({"kind":"city-resident-public","cityId":city_id,"residentId":resident_id}),
        location_ref, &revision)?;
    Ok((json!({"moved":true,"residentState":state,"lease":lease}), String::new()))
}

fn resident_state_revision(home: &Path, city_id: &str, resident_id: &str) -> Result<String, &'static str> {
    let db = database(home)?;
    crate::story_store::migrate_city_resident_state(&db)?;
    db.query_row("SELECT revision FROM city_resident_state WHERE city_id=?1 AND resident_id=?2",
        params![city_id,resident_id], |row| row.get::<_, String>(0))
        .optional().map_err(|_| "creator_store_unavailable")
        .map(|value| value.unwrap_or_else(|| "0".to_string()))
}


fn committed_event_ids(home: &Path, story_id: &str, player_id: &str, story_run_id: &str, city_id: &str) -> Result<Vec<String>, &'static str> {
    let db = database(home)?;
    let mut statement = db.prepare("SELECT DISTINCT event_id FROM story_events WHERE story_id=?1 AND player_id=?2 AND story_run_id=?3 AND city_id=?4 LIMIT 512")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![story_id,player_id,story_run_id,city_id], |row| row.get::<_, String>(0))
        .map_err(|_| "creator_store_unavailable")?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")
}

fn run_summaries(home: &Path, story_id: &str, player_id: &str, story_run_id: &str) -> Result<Value, &'static str> {
    let db = database(home)?;
    crate::story_registry::migrate(&db)?;
    let mut statement = db.prepare("SELECT story_run_id,player_id,status,last_viewed_at_ms FROM story_runs WHERE story_id=?1 AND player_id=?2 AND story_run_id=?3 AND status IN ('active','paused')")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![story_id,player_id,story_run_id], |row|
        Ok(json!({"storyRunId":row.get::<_, String>(0)?,"playerId":row.get::<_, String>(1)?,
            "status":row.get::<_, String>(2)?,"lastViewedAtMs":row.get::<_, Option<i64>>(3)?})))
        .map_err(|_| "creator_store_unavailable")?;
    let runs: Vec<Value> = rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?;
    Ok(Value::Array(runs))
}

fn recent_events(home: &Path, story_id: &str, player_id: &str, story_run_id: &str) -> Result<Value, &'static str> {
    let db = database(home)?;
    let mut statement = db.prepare("SELECT event_id,rule_id,created_at_ms FROM story_events WHERE story_id=?1 AND player_id=?2 AND story_run_id=?3 ORDER BY created_at_ms DESC LIMIT ?4")
        .map_err(|_| "creator_store_unavailable")?;
    let rows = statement.query_map(params![story_id,player_id,story_run_id, MAX_RECENT_EVENTS as i64], |row|
        Ok(json!({"eventId":row.get::<_, String>(0)?,"ruleId":row.get::<_, String>(1)?,
            "createdAtMs":row.get::<_, i64>(2)?})))
        .map_err(|_| "creator_store_unavailable")?;
    let events: Vec<Value> = rows.collect::<Result<Vec<_>, _>>().map_err(|_| "creator_store_unavailable")?;
    Ok(Value::Array(events))
}

/// 剧情触发第一层（spec §6.1）：图可达 + 因果存在性的宿主最小实现。
/// preconditions 的完整求值（ConditionV2）留 ADR-01 求值器——菜单条目如实标注
/// "unevaluated"，提交时宿主重验因果与可确定子集。
fn eligible_beats(graph: &Value, committed: &[String]) -> Value {
    let empty = Vec::new();
    let edges = graph.get("edges").and_then(Value::as_array).unwrap_or(&empty);
    let nodes = graph.get("nodes").and_then(Value::as_array).unwrap_or(&empty);
    let start = graph.get("start").and_then(Value::as_str).unwrap_or("").to_string();
    let mut adjacency: std::collections::BTreeMap<&str, Vec<(&str, Vec<&str>)>> = std::collections::BTreeMap::new();
    for edge in edges {
        let from = edge.get("from").and_then(Value::as_str).unwrap_or("");
        let to = edge.get("to").and_then(Value::as_str).unwrap_or("");
        let deps: Vec<&str> = edge.get("eventDependencies").and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        adjacency.entry(from).or_default().push((to, deps));
    }
    // 结构 BFS（忽略前置——菜单如实标注每条边的因果满足状态；前置求值留 ADR-01）。
    // start 缺失的图（部分创作者形态）优雅降级：视为全部 from 节点可达。
    let mut reachable = std::collections::BTreeSet::new();
    if start.is_empty() {
        for from in adjacency.keys() { reachable.insert(*from); }
    } else {
        reachable.insert(start.as_str());
        let mut queue = vec![start.as_str()];
        while let Some(node) = queue.pop() {
            if let Some(neighbors) = adjacency.get(node) {
                for (to, _) in neighbors { if reachable.insert(to) { queue.push(to); } }
            }
        }
    }
    let mut beats = Vec::new();
    for (from, neighbors) in &adjacency {
        for (to, deps) in neighbors {
            let missing: Vec<&str> = deps.iter().filter(|dep| !committed.contains(&dep.to_string())).cloned().collect();
            beats.push(json!({"edgeId":format!("{from}->{to}"),"fromNode":from,"toNode":to,
                "fromNodeReachable":reachable.contains(from),"eventDependencies":deps,
                "missingDependencies":missing,"preconditions":"unevaluated"}));
        }
    }
    let dead_ends: Vec<&Value> = nodes.iter().filter(|node| {
        let id = node.get("id").and_then(Value::as_str).unwrap_or("");
        !adjacency.contains_key(id)
    }).collect();
    json!({"beats":beats,"start":start,"deadEnds":dead_ends,"nodeCount":nodes.len()})
}

/// 会话首句提示词（spec §5）：确定性纯函数——同输入逐字节一致（测试钉住）。
/// 组成：身份卡（canon）+ 能力边界 + 事实摘要 + 工具用法 + 边界声明。
/// ≤8KiB：canon 先截断（4KiB），最终超限在字符边界截断并附标注。
fn session_prompt(canon_slice: &Value, character_id: &str, allowed_kinds: &[String], max: u64, used: u64, eligible: &Value) -> String {
    let canon_text = serde_json::to_string(canon_slice).unwrap_or_else(|_| "{}".to_string());
    let beats_text = serde_json::to_string(eligible).unwrap_or_else(|_| "[]".to_string());
    let full = format!(
        "你是 City 中的角色 {character_id}。以下是你的身份卡与行动规则。\n\
         [身份/Canon]\n{canon_text}\n\
         [可提交的 Intent 种类] {}\n\
         [预算] 本窗口已用 {used}/{max}\n\
         [当前可触发的剧情边（含前置与因果状态）]\n{beats_text}\n\
         [提交方式] 调用 MCP 工具 creator_actor_intent_submit，intent 字段为 \
         {{intentId, actorId, scope, kind, args, expectedRevision}}；每轮先重读 \
         creator_actor_turn_context 对齐事实——本提示词只是身份/规则卡，不是对话记忆。\n\
         [边界] 会话内目标、任务与多轮记忆由你的 agent 宿主自持；宿主只裁决事实。",
        allowed_kinds.join(", "));
    truncate_str(&full, SESSION_PROMPT_MAX_BYTES)
}

fn truncate_str(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes { return text.to_string(); }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) { end -= 1; }
    format!("{}…[truncated at {max_bytes} bytes]", &text[..end])
}

fn truncate_json(value: &Value, max_bytes: usize) -> Value {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    if text.len() <= max_bytes { return value.clone(); }
    Value::String(truncate_str(&text, max_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home() -> std::path::PathBuf {
        static NEXT_ID: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        std::env::temp_dir().join(format!("actor-adapter-{}-{}", std::process::id(),
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)))
    }

    /// 注册一个绑定 story 的 actor（story 项目含 canon 角色 resident:linxia）。
    fn insert_run(home: &Path, run_id: &str, player_id: &str, story_id: &str) {
        let db = database(home).unwrap();
        crate::story_registry::migrate(&db).unwrap();
        db.execute("INSERT INTO story_runs(story_run_id,player_id,city_id,story_id,status,last_viewed_at_ms,created_at_ms,updated_at_ms)
            VALUES(?1,?2,'city-1',?3,'active',1,1,1)", params![run_id,player_id,story_id]).unwrap();
    }

    fn seed_story_event(home: &Path, story_id: &str, player_id: &str, run_id: &str, event_id: &str) {
        let db = database(home).unwrap();
        crate::story_registry::migrate(&db).unwrap();
        db.execute("INSERT INTO story_events(event_id,occurrence_id,player_id,city_id,game_id,story_id,story_run_id,rule_id,status,due_at_utc_ms,last_processed_tick,idempotency_key,story_revision,clock_revision,intent_json,created_at_ms)
            VALUES(?1,'occ',?2,'city-1','game-1',?3,?4,'rule','scheduled',0,0,?5,'0','0','{}',1)",
            params![event_id,player_id,story_id,run_id,format!("idem-{event_id}")]).unwrap();
    }

    fn setup_story(home: &Path) -> Value {
        crate::story_registry::project_create(home, &json!({"storyId":"story.detective","title":"侦探线",
            "schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"start":"start","nodes":[{"id":"start","kind":"beat"},{"id":"clue","kind":"beat"}],
                "edges":[{"from":"start","to":"clue","eventDependencies":["evt-date"]}],
                "seed":"seed-a"},
            "canon":{"characters":[{"id":"resident:linxia","name":"小夏"}]}})).unwrap()
    }

    fn register_actor(home: &Path, session: &str, operation: &str) -> Value {
        super::register(home, &json!({"storyId":"story.detective","characterId":"resident:linxia",
            "sessionIdentifier":session,"allowedKinds":["speak","invite","move"],
            "maxIntentsPerWindow":3,"sessionLabel":"小夏驱动会话","operationId":operation})).unwrap()
    }

    #[test]
    fn register_mints_identity_and_is_idempotent_by_session() {
        let home = home();
        setup_story(&home);
        let first = register_actor(&home, "codex-thread-abc", "op-1");
        assert_eq!(first["existing"], false);
        assert!(first["actorId"].as_str().unwrap().starts_with("actor-"));
        assert!(first["sessionPrompt"].as_str().unwrap().contains("resident:linxia"));
        // 身份幂等：同 (story,session,character) 重注册 → 同 actor，预算延续。
        let replay = register_actor(&home, "codex-thread-abc", "op-2");
        assert_eq!(replay["existing"], true);
        assert_eq!(replay["actorId"], first["actorId"]);
        assert_eq!(replay["budget"]["used"], 0);
        // Canon 缺角色拒绝（对既有 canon 注册未定义的角色）。
        assert_eq!(super::register(&home, &json!({"storyId":"story.detective","characterId":"resident:ghost",
            "sessionIdentifier":"codex-thread-ghost","allowedKinds":["speak"],"maxIntentsPerWindow":1,
            "operationId":"op-ghost"})).unwrap_err(), "story_canon_character_missing");
        // 路径/超长 identifier 拒绝。
        assert_eq!(super::register(&home, &json!({"storyId":"story.detective","characterId":"resident:linxia",
            "sessionIdentifier":"/Users/x/thread","allowedKinds":["speak"],"maxIntentsPerWindow":1,
            "operationId":"op-path"})).unwrap_err(), "story_argument_invalid");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn turn_context_projects_facts_and_computes_eligible_beats() {
        let home = home();
        setup_story(&home);
        let actor = register_actor(&home, "codex-thread-ctx", "op-ctx");
        let actor_id = actor["actorId"].as_str().unwrap();
        insert_run(&home, "story-run-ctx", "player-1", "story.detective");
        // 评审 P1-b：缺 scope fail-closed（不采信无作用域的事实聚合）。
        assert_eq!(turn_context(&home, &json!({"actorId":actor_id})).unwrap_err(), "actor_context_scope_required");
        let ctx = turn_context(&home, &json!({"actorId":actor_id,
            "scope":{"playerId":"player-1","storyRunId":"story-run-ctx"}})).unwrap();
        assert_eq!(ctx["budget"]["used"], 0);
        assert_eq!(ctx["budget"]["max"], 3);
        assert_eq!(ctx["canon"]["characters"][0]["id"], "resident:linxia");
        assert_eq!(ctx["eligibleBeats"]["start"], "start");
        assert_eq!(ctx["eligibleBeats"]["beats"][0]["missingDependencies"][0], "evt-date");
        assert_eq!(ctx["scope"]["playerId"], "player-1");
        // sessionPrompt 确定性：两次合成逐字节一致。
        let again = turn_context(&home, &json!({"actorId":actor_id,
            "scope":{"playerId":"player-1","storyRunId":"story-run-ctx"}})).unwrap();
        assert_eq!(ctx["sessionPrompt"], again["sessionPrompt"]);
        // 未知 actor 拒绝。
        assert_eq!(turn_context(&home, &json!({"actorId":"actor-missing",
            "scope":{"playerId":"player-1","storyRunId":"story-run-ctx"}})).unwrap_err(), "actor_not_found");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn turn_context_scope_is_host_authorized_and_player_isolated() {
        let home = home();
        setup_story(&home);
        let actor = register_actor(&home, "codex-thread-iso", "op-iso");
        let actor_id = actor["actorId"].as_str().unwrap();
        insert_run(&home, "story-run-p1", "player-1", "story.detective");
        insert_run(&home, "story-run-p2", "player-2", "story.detective");
        // 他人 Run 的作用域被 Host 拒绝（player 不匹配 run 行——Host 授权不采信自报）。
        assert_eq!(turn_context(&home, &json!({"actorId":actor_id,
            "scope":{"playerId":"player-2","storyRunId":"story-run-p1"}})).unwrap_err(), "story_run_not_found");
        // 未知 Run 拒绝。
        assert_eq!(turn_context(&home, &json!({"actorId":actor_id,
            "scope":{"playerId":"player-1","storyRunId":"story-run-none"}})).unwrap_err(), "story_run_not_found");
        // 玩家 B 的事实不得进入玩家 A 的上下文（跨玩家隔离，评审 P1-b）。
        seed_story_event(&home, "story.detective", "player-2", "story-run-p2", "evt-b");
        let ctx = turn_context(&home, &json!({"actorId":actor_id,
            "scope":{"playerId":"player-1","storyRunId":"story-run-p1"}})).unwrap();
        let committed_view = ctx["eligibleBeats"].to_string();
        assert!(!committed_view.contains("evt-b"), "player-2 事件泄漏进 player-1 上下文: {committed_view}");
        let recent_view = ctx["recentEvents"].to_string();
        assert!(!recent_view.contains("evt-b"), "player-2 事件泄漏进 recentEvents: {recent_view}");
        // 玩家自己的事实可见（recentEvents 直接列出事件 id）。
        seed_story_event(&home, "story.detective", "player-1", "story-run-p1", "evt-a");
        let ctx_own = turn_context(&home, &json!({"actorId":actor_id,
            "scope":{"playerId":"player-1","storyRunId":"story-run-p1"}})).unwrap();
        assert!(ctx_own["recentEvents"].to_string().contains("evt-a"));
        assert!(!ctx_own["recentEvents"].to_string().contains("evt-b"));
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn submit_budget_gate_and_kind_allowlist_close_before_any_write() {
        let home = home();
        setup_story(&home);
        let actor = register_actor(&home, "codex-thread-budget", "op-budget");
        let actor_id = actor["actorId"].as_str().unwrap();
        let intent = |id: &str| json!({"actorId":actor_id,"intent":{"intentId":id,
            "actorId":actor_id,"scope":{"kind":"story","playerId":"local-profile-v1","cityId":"city-x",
            "storyId":"story.detective","storyRunId":"story-run-x"},"kind":"speak","args":{"text":"hi"},
            "expectedRevision":"0"}});
        // max=3：前 3 次过闸（语义拒绝不计零写入——尝试计数），第 4 次 budget_exhausted。
        let mut last = Value::Null;
        for index in 0..3 { last = submit(&home, &json!({"actorId":actor_id,"intent":intent(&format!("i-{index}"))})).unwrap(); }
        assert_eq!(last["intentsUsed"], 3);
        let exhausted = submit(&home, &json!({"actorId":actor_id,"intent":intent("i-3")})).unwrap();
        assert_eq!(exhausted["accepted"], false);
        assert_eq!(exhausted["code"], "actor_budget_exhausted");
        assert_eq!(exhausted["intentsUsed"], 3);
        // kind 不在 allowedKinds（move 在词表但未注册允许）。
        let actor2 = register_actor(&home, "codex-thread-kinds", "op-kinds");
        let actor2_id = actor2["actorId"].as_str().unwrap();
        let result = submit(&home, &json!({"actorId":actor2_id,"intent":json!({"intentId":"i-give",
            "actorId":actor2_id,"scope":{"kind":"story","playerId":"local-profile-v1","cityId":"city-x",
            "storyId":"story.detective","storyRunId":"story-run-x"},"kind":"give","args":{},
            "expectedRevision":"0"})})).unwrap();
        assert_eq!(result["code"], "intent_kind_not_allowed");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn submit_private_intent_binds_to_actor_story_and_public_move_uses_actor_lease() {
        let home = home();
        setup_story(&home);
        // 目标玩家 Run 先存在（私有 Intent 落目标玩家 scope）：装 story 到 City、起 Run。
        let city = crate::creator_cities::create_city(&home, "local", "actor-city-create", "Actor City", 42,
            &json!({"schemaVersion":1,"id":"desert","version":1,"biome":"arid",
            "geography":{"generator":"arid-dunes-v1","parameters":{"dunes":{"duneScale":190,"duneAmplitude":11,"orientationDeg":18}}},
            "visuals":{"themeId":"desert"}})).unwrap();
        let checked = crate::story_registry::install_preview(&home, &json!({"storyId":"story.detective",
            "targetCityId":city["cityId"],"expectedCityRevision":city["revision"],
            "operationId":"actor-city-preview"})).unwrap();
        crate::story_registry::install_commit(&home, &json!({"previewId":checked["previewId"],
            "operationId":"actor-city-commit"})).unwrap();
        crate::story_registry::run_start(&home, "local-profile-v1", &json!({"cityId":city["cityId"],
            "storyId":"story.detective"})).unwrap();
        let actor = register_actor(&home, "codex-thread-bind", "op-bind");
        let actor_id = actor["actorId"].as_str().unwrap();
        // 绑定隔离：scope.storyId 不匹配 → 拒绝。
        let mismatch = json!({"actorId":actor_id,"intent":{"intentId":"i-mismatch","actorId":actor_id,
            "scope":{"kind":"story","playerId":"local-profile-v1","cityId":city["cityId"],
            "storyId":"story.other","storyRunId":"run-x"},"kind":"speak","args":{"text":"hi"},
            "expectedRevision":"0"}});
        let decision = submit(&home, &mismatch).unwrap();
        assert_eq!(decision["accepted"], false);
        // 公共 move：租约 actor 持有 → resident_state 写入；第二次同位置幂等。
        let public_move_intent = json!({"actorId":actor_id,"intent":{"intentId":"i-move-1","actorId":actor_id,
            "scope":{"kind":"city-resident-public","cityId":city["cityId"],"residentId":"resident:linxia"},
            "kind":"move","args":{"locationRef":"place:cafe"},"expectedRevision":"0"}});
        let first_move = submit(&home, &public_move_intent).unwrap();
        assert_eq!(first_move["accepted"], true);
        let second_move = submit(&home, &public_move_intent).unwrap();
        assert_eq!(second_move["accepted"], true);
        std::fs::remove_dir_all(home).ok();
    }
}
