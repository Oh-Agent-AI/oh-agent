//! Actor 回合闭环（N3，OH_AGENT_NARRATIVE_ENGINE_SPEC §5 + §6 actor_turn.rs）：
//! 回合解析 → 授权重校验 → 快照 → 求值器裁决 → CAS 提交 → 回执。
//!
//! 职责边界（spec §3）：叙事语义（边选择、前置条件、效果）归可信 TS 求值器
//! （narrative_engine，rquickjs 嵌入，nonce 关联）；本模块只做回合授权、预算
//! 闸与事务编排。Rust 不复刻规则，不猜测裁决。
//!
//! 闭环（HB-08）：玩家事实（绑定 resident）→ D-2/泵投递 actor.turn → Agent
//! 领取（creator_actor_turn_wait，会话派生身份）→ 本入口提案（turnId 绑定被
//! 领取回合）→ 求值 → 提交 → 玩家在原 Run 经 G-READ 读到回复。
//!
//! 求值与提交分离点：快照在提交事务外构建，CAS 绑定 evaluatedAtVersion——
//! 状态已变则提交层拒绝（N-04 并发与版本），同 operationId 并发重放经回执
//! 收敛为 already_confirmed（至多一次效果）。
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

use crate::actor_adapter::{actor_row, roll_budget_window};
use crate::creator_store::{database, digest, now_ms, valid_id};
use crate::story_store::{StoryClockAuthorityV1, StoryCommitCommandV1, StoryStateScopeV1};

/// 对白预算：玩家可见回复（≤2000 字符，与 speak 的 schema 闸一致）。
const DIALOGUE_MAX_CHARS: usize = 2_000;

/// commit_story 的确定性错误码 → CommitDecision（与 actor_intent 同语义）：
/// 其余（存储不可用等瞬时故障）以 Err 透传。
const DECISION_CODES: [&str; 4] = [
    "game_storage_revision_conflict", "city_time_revision_conflict",
    "city_time_uncertain", "operation_id_conflict",
];

fn rejected(trace_id: &str, code: &str, diagnostics: Value) -> Value {
    json!({"accepted":false,"code":code,"diagnostics":diagnostics,"traceId":trace_id,
        "operationId":Value::Null,"committedEventIds":[],"newStateVersion":Value::Null,
        "turnStatus":"rejected"})
}

fn id_field(value: &Value, key: &str) -> Result<String, &'static str> {
    value.get(key).and_then(Value::as_str).filter(|id| valid_id(id))
        .map(str::to_string).ok_or("story_argument_invalid")
}

/// 回合行读取：host_deliveries 表由投递总线（MCP 侧 host_delivery）建管——
/// 桌面侧只读。表不存在 → 诚实报"总线未初始化"，不猜测回合。
fn claimed_turn_payload(home: &Path, delivery_id: &str, actor_id: &str) -> Result<Value, &'static str> {
    let db = database(home)?;
    let present: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='host_deliveries'",
        [], |row| row.get(0)).map_err(|_| "creator_store_unavailable")?;
    if present == 0 { return Err("actor_turn_unavailable"); }
    let payload: Option<String> = db.query_row(
        // 授权重校验（spec §5.2）：行必须属于本 actor、kind=actor.turn、
        // in_flight（已由会话派生身份领取）——pending/他人/已确认一律拒绝。
        "SELECT payload_json FROM host_deliveries WHERE delivery_id=?1 AND principal_kind='actor' \
         AND principal_id=?2 AND kind='actor.turn' AND status='in_flight'",
        params![delivery_id, actor_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?;
    let payload = payload.ok_or("actor_turn_not_claimed")?;
    serde_json::from_str(&payload).map_err(|_| "creator_store_unavailable")
}

/// 已提交回执（幂等重放 / 并发收敛）：story_operations 命中即返回
/// already_confirmed——同一提案重放不重评、不重交（至多一次效果）。
fn committed_receipt(home: &Path, player_id: &str, city_id: &str, story_id: &str,
    story_run_id: &str, operation_id: &str) -> Result<Option<Value>, &'static str> {
    let db = database(home)?;
    crate::story_store::migrate_story(&db)?;
    let result: Option<String> = db.query_row(
        "SELECT result_json FROM story_operations WHERE player_id=?1 AND city_id=?2 AND story_id=?3 AND story_run_id=?4 AND operation_id=?5",
        params![player_id,city_id,story_id,story_run_id,operation_id], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?;
    Ok(result.map(|result| {
        let result: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
        json!({"operationId":operation_id,"committedEventIds":[result["eventId"]],
            "newStateVersion":result["storyRevision"],"turnStatus":"already_confirmed"})
    }))
}

/// 预算记账（与 actor_adapter::submit 同语义）：尝试计数含语义拒绝；
/// budget_exhausted 本身不消耗。
fn record_decision(home: &Path, actor_id: &str, decision: &str, code: &str,
    trace_id: &str, intents_used: i64, now: u64) -> Result<(), &'static str> {
    let db = database(home)?;
    crate::actor_adapter::migrate(&db)?;
    db.execute("UPDATE actors SET intents_used=?2,last_decision=?3,last_code=?4,last_trace_id=?5,last_decided_at_ms=?6,updated_at_ms=?6 WHERE actor_id=?1",
        params![actor_id,intents_used,decision,code,trace_id,now as i64])
        .map_err(|_| "creator_store_unavailable")?;
    Ok(())
}

/// event.append 效果的事件身份（来自 Story 内容包）——无则由 operationId 确定性派生。
fn event_identity(effects: &Value, operation_id: &str) -> String {
    effects.as_array()
        .and_then(|items| items.iter().find(|effect| effect.get("op").and_then(Value::as_str) == Some("event.append")))
        .and_then(|effect| effect.get("eventId").and_then(Value::as_str).filter(|id| valid_id(id)))
        .map(str::to_string)
        .unwrap_or_else(|| digest(&format!("narrative-event:{operation_id}")))
}

/// Actor 回合提案入口（MCP 面 creator.actor.propose）：{actorId, deliveryId,
/// proposal:{operationId, edgeId, dialogue}}。对白必填——玩家可见回复（HB-08）。
pub(crate) fn propose(home: &Path, payload: &Value) -> Result<Value, &'static str> {
    let actor_id = id_field(payload, "actorId")?;
    let delivery_id = id_field(payload, "deliveryId")?;
    let proposal = payload.get("proposal").and_then(Value::as_object).ok_or("story_argument_invalid")?;
    let proposal = Value::Object(proposal.clone());
    let operation_id = id_field(&proposal, "operationId")?;
    let edge_id = id_field(&proposal, "edgeId")?;
    let dialogue = proposal.get("dialogue").and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.chars().count() <= DIALOGUE_MAX_CHARS)
        .ok_or("story_argument_invalid")?; // 玩家可见回复必须可呈现
    let now = now_ms();
    let trace_id = digest(&format!("actor-turn-trace:{operation_id}"));
    // 预算闸先于任何求值（fail fast）；窗口滚动与 actor_adapter 同语义。
    {
        let db = database(home)?;
        crate::actor_adapter::migrate(&db)?;
        let window_started: i64 = db.query_row("SELECT window_started_ms FROM actors WHERE actor_id=?1",
            [actor_id.as_str()], |row| row.get(0)).optional()
            .map_err(|_| "creator_store_unavailable")?.ok_or("actor_not_found")?;
        roll_budget_window(&db, actor_id.as_str(), window_started, now)?;
    }
    let row = actor_row(home, actor_id.as_str())?.ok_or("actor_not_found")?;
    if row.intents_used >= row.max_intents_per_window {
        return Ok(json!({"accepted":false,"code":"actor_budget_exhausted",
            "diagnostics":[],"traceId":trace_id,"operationId":Value::Null,
            "committedEventIds":[],"newStateVersion":Value::Null,"turnStatus":"rejected"}));
    }
    // 回合解析 + 授权链：提案绑定被领取的回合（in_flight、归属本 actor），
    // 作用域取回合投递（Host 生产时授权），不采信调用方自报。
    let turn = claimed_turn_payload(home, &delivery_id, actor_id.as_str())?;
    let player_id = id_field(&turn, "playerId")?;
    let city_id = id_field(&turn, "cityId")?;
    let story_id = id_field(&turn, "storyId")?;
    let story_run_id = id_field(&turn, "storyRunId")?;
    let trigger_event = id_field(&turn, "eventId").ok();
    // Run 仍活跃（投递到提交之间可能停止/过期）——宿主权威重校验。
    {
        let db = database(home)?;
        crate::story_registry::migrate(&db)?;
        crate::story_registry::require_active_run(&player_id, &city_id, &story_id, &story_run_id, &db)?;
    }
    // 幂等重放：同 operationId 已提交 → 原回执（already_confirmed）。
    if let Some(receipt) = committed_receipt(home, &player_id, &city_id, &story_id, &story_run_id, &operation_id)? {
        return Ok(receipt);
    }
    // 快照（显式作用域）+ 安装发布的图 → 求值器裁决（nonce 关联）。
    let snapshot = crate::narrative_engine::narrative_snapshot_scoped(
        home, &player_id, &city_id, &story_id, &story_run_id)?;
    let project = crate::story_registry::project_read(home, &json!({"storyId":story_id}))?;
    let graph = project.get("graph").cloned().unwrap_or(Value::Null);
    if !graph.is_object() { return Err("story_graph_unavailable"); }
    let proposal_value = json!({"turnId":delivery_id,"operationId":operation_id,
        "edgeId":edge_id,"dialogue":dialogue});
    let decision = crate::narrative_engine::evaluate_proposal(&graph, &snapshot, &proposal_value)?;
    if decision.get("accepted").and_then(Value::as_bool) != Some(true) {
        // 语义拒绝：诊断透传、零写入（N-02 伪造事实 / 前置不满足均在此拦截）。
        record_decision(home, actor_id.as_str(), "rejected", "narrative_rejected",
            &trace_id, row.intents_used + 1, now)?;
        return Ok(rejected(&trace_id, "narrative_rejected", decision["diagnostics"].clone()));
    }
    // CAS 提交：expected_story_revision 绑定求值版本（N-04：状态已变 → 拒绝），
    // 效果由求值器裁决注入（不从调用方透传），对白以 speak 落信封（玩家可见）。
    let effects = decision.get("effects").cloned().unwrap_or(json!([]));
    let clock = crate::city_runtime::read_clock_at(home, &city_id, now)?;
    if clock.get("uncertainty").is_some() {
        record_decision(home, actor_id.as_str(), "rejected", "city_time_uncertain",
            &trace_id, row.intents_used + 1, now)?;
        return Ok(rejected(&trace_id, "city_time_uncertain", json!([])));
    }
    let command = StoryCommitCommandV1 {
        operation_id: operation_id.clone(),
        event_id: event_identity(&effects, &operation_id),
        player_id: player_id.clone(), city_id: city_id.clone(), game_id: story_id.clone(),
        story_scope: Some(StoryStateScopeV1 { story_id: story_id.clone(), story_run_id: story_run_id.clone() }),
        resident_id: None,
        expected_story_revision: decision["evaluatedAtVersion"].as_str()
            .filter(|v| !v.is_empty()).ok_or("narrative_evaluator_output_invalid")?.to_string(),
        expected_clock_revision: clock["clockRevision"].as_str()
            .ok_or("creator_store_unavailable")?.to_string(),
        intent: json!({"kind":"speak","text":dialogue,"edgeId":edge_id}),
        run_id: story_run_id.clone(),
        rule_set_digest: crate::story_registry::project_content_digest(home, &story_id)?,
        causation_id: trigger_event,
        correlation_id: Some(operation_id.clone()),
        narrative_effects: Some(effects),
    };
    let commit = crate::story_store::commit_story(home, command, StoryClockAuthorityV1 {
        revision: clock["clockRevision"].as_str().ok_or("creator_store_unavailable")?.to_string(),
        tick: clock["tick"].as_u64().ok_or("creator_store_unavailable")?,
        simulation_utc_ms: clock["simulationUtcMs"].as_u64().ok_or("creator_store_unavailable")?,
    });
    match commit {
        Ok(result) => {
            record_decision(home, actor_id.as_str(), "accepted", "", &trace_id,
                row.intents_used + 1, now)?;
            Ok(json!({"accepted":true,"code":Value::Null,"diagnostics":[],
                "operationId":operation_id,
                "committedEventIds":[result["eventId"]],
                "newStateVersion":result["storyRevision"],
                "newCursor":decision["newCursor"],
                "evaluatedAtVersion":decision["evaluatedAtVersion"],
                "turnStatus":"confirmed","traceId":trace_id}))
        }
        Err(code) => {
            // 并发重放收敛：CAS 冲突且同 operationId 已提交 → 原回执（至多一次）。
            if code == "game_storage_revision_conflict" {
                if let Some(receipt) = committed_receipt(home, &player_id, &city_id,
                    &story_id, &story_run_id, &operation_id)? {
                    return Ok(receipt);
                }
            }
            if DECISION_CODES.contains(&code) {
                record_decision(home, actor_id.as_str(), "rejected", code, &trace_id,
                    row.intents_used + 1, now)?;
                Ok(rejected(&trace_id, code, json!([])))
            } else { Err(code) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn home() -> std::path::PathBuf {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!("actor-turn-{}-{}", std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)))
    }

    /// 别名：局部 `home` 绑定会遮蔽同名辅助函数（如"总线未初始化"用例的第二个
    /// 临时目录）——统一走显式别名调用。
    fn fresh_home() -> std::path::PathBuf { home() }

    /// 咖啡馆 Story（spec §1 垂直切片）：邀请边需要好感度 ≥1，效果为好感度 +1、
    /// date_planned 标记、追加事件与游标推进。
    fn setup_cafe_story(home: &Path) -> String {
        let city = crate::creator_cities::create_city(home, "local", "turn-city", "Turn City", 42,
            &json!({"schemaVersion":1,"id":"desert","version":1,"biome":"arid",
            "geography":{"generator":"arid-dunes-v1","parameters":{"dunes":{"duneScale":190,"duneAmplitude":11,"orientationDeg":18}}},
            "visuals":{"themeId":"desert"}})).unwrap();
        crate::story_registry::project_create(home, &json!({"storyId":"story.detective","title":"侦探线",
            "schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"start":"start","nodes":[{"id":"start","kind":"beat"},{"id":"cafe_reply","kind":"beat"}],
                "edges":[{"id":"e-invite","from":"start","to":"cafe_reply",
                    "preconditions":[{"op":"counter.gte","key":"affection","value":1}],
                    "effects":[{"op":"counter.add","key":"affection","value":1},
                        {"op":"flag.set","key":"date_planned","value":true},
                        {"op":"event.append","eventId":"evt-invite-1","ruleId":"cafe-invite"},
                        {"op":"cursor.advance","to":"cafe_reply"}],
                    "eventDependencies":[]}],
                "seed":"seed-turn"},
            "canon":{"characters":[{"id":"resident:linxia","name":"小夏"}]}})).unwrap();
        let checked = crate::story_registry::install_preview(home, &json!({"storyId":"story.detective",
            "targetCityId":city["cityId"],"expectedCityRevision":city["revision"],
            "operationId":"turn-preview"})).unwrap();
        crate::story_registry::install_commit(home, &json!({"previewId":checked["previewId"],
            "operationId":"turn-commit"})).unwrap();
        city["cityId"].as_str().unwrap().to_string()
    }

    /// 双轨 Run 对齐（N3 闭环前提）：city game run（游戏会话，city_runtime 铸
    /// player id）+ 显式 story run（玩家进度，story_registry）。提交边界绑定
    /// story run（commit_at），投递与 G-READ 共用同一作用域解析。
    fn start_session(home: &Path) -> (String, String, String, String) {
        let city_id = setup_cafe_story(home);
        let game_run = crate::city_runtime::start_run(home, "city-instance",
            &json!({"cityId":city_id,"gameId":"game.romance"})).unwrap();
        let player_id = game_run["playerScope"]["playerId"].as_str().unwrap().to_string();
        let game_run_id = game_run["runId"].as_str().unwrap().to_string();
        let story_run = crate::story_registry::run_start(home, &player_id,
            &json!({"cityId":city_id,"storyId":"story.detective"})).unwrap();
        let story_run_id = story_run["storyRunId"].as_str().unwrap().to_string();
        (city_id, game_run_id, story_run_id, player_id)
    }

    fn register_actor(home: &Path, session: &str) -> String {
        crate::actor_adapter::register(home, &json!({"storyId":"story.detective",
            "characterId":"resident:linxia","sessionIdentifier":session,
            "allowedKinds":["speak","invite"],"maxIntentsPerWindow":3,
            "sessionLabel":"N3 闭环会话","operationId":format!("op-{session}")}))
            .unwrap()["actorId"].as_str().unwrap().to_string()
    }

    /// 白盒种玩家状态（好感度 1、版本 0）——等同此前剧情积累。
    fn seed_affection(home: &Path, city_id: &str, story_run_id: &str, player_id: &str, affection: i64) {
        let db = database(home).unwrap();
        crate::story_store::migrate_story(&db).unwrap();
        db.execute("INSERT INTO story_states(player_id,city_id,game_id,story_id,story_run_id,revision,document_json,updated_at_ms)
            VALUES(?1,?2,'story.detective','story.detective',?3,'0',?4,1)",
            params![player_id,city_id,story_run_id,json!({"affection":affection}).to_string()]).unwrap();
    }

    /// 玩家对 resident 说话（真实路径：city_runtime commit → 显式 Story Run 绑定
    /// → D-2 投递 actor.turn）。
    fn player_speak(home: &Path, city_id: &str, game_run_id: &str, operation: &str, text: &str) -> Value {
        let clock = crate::city_runtime::read_clock_at(home, city_id, now_ms()).unwrap();
        crate::city_runtime::commit(home, "city-instance", &json!({
            "runId":game_run_id,"operationId":operation,"eventId":format!("evt-{operation}"),
            "residentId":"resident:linxia","expectedStoryRevision":"0",
            "expectedClockRevision":clock["clockRevision"],
            "intent":{"kind":"speak","text":text,"residentId":"resident:linxia"}})).unwrap()
    }

    fn claim(home: &Path, session: &str) -> Value {
        agent_vitals_mcp::mcp::host_delivery::claim_wait(home,
            &json!({"sessionIdentifier":session,"timeoutMs":100})).unwrap()
    }

    fn propose(home: &Path, actor_id: &str, delivery_id: &str, operation: &str,
        edge: &str, dialogue: &str) -> Result<Value, &'static str> {
        super::propose(home, &json!({"actorId":actor_id,"deliveryId":delivery_id,
            "proposal":{"operationId":operation,"edgeId":edge,"dialogue":dialogue}}))
    }

    #[test]
    fn player_turn_claim_proposal_commit_and_visible_reply_close_the_loop() {
        let home = home();
        let (city_id, game_run_id, story_run_id, player_id) = start_session(&home);
        seed_affection(&home, &city_id, &story_run_id, &player_id, 1);
        let actor_id = register_actor(&home, "sess-n3-loop");
        // 玩家说话 → 显式 Story Run 绑定 → D-2 投递 actor.turn（真实生产路径）。
        player_speak(&home, &city_id, &game_run_id, "op-player-1", "去咖啡馆吧？");
        // Agent 领取（会话派生身份）→ 回合带授权作用域（storyRunId 即 story run）。
        let claimed = claim(&home, "sess-n3-loop");
        assert_eq!(claimed["deliveredCount"], 1);
        let delivery_id = claimed["deliveries"][0]["deliveryId"].as_str().unwrap().to_string();
        assert_eq!(claimed["deliveries"][0]["payload"]["storyRunId"], json!(story_run_id));
        assert_eq!(claimed["deliveries"][0]["payload"]["storyId"], "story.detective");
        // 提案 → 求值器接受（好感度 1 ≥ 1）→ CAS 提交 → 回执。
        let receipt = propose(&home, &actor_id, &delivery_id, "op-reply-1", "e-invite",
            "好啊，周六下午两点，老地方见！").unwrap();
        assert_eq!(receipt["accepted"], json!(true), "evaluator must accept: {receipt}");
        assert_eq!(receipt["turnStatus"], "confirmed");
        assert_eq!(receipt["newCursor"], "cafe_reply");
        assert_eq!(receipt["committedEventIds"][0], "evt-invite-1");
        let committed_event = receipt["committedEventIds"][0].as_str().unwrap().to_string();
        // 效果落盘：好感度 +1、标记、游标推进（求值器白名单效果）。
        let state = crate::story_store::story_state_scoped(&home, &player_id, &city_id,
            "story.detective", &story_run_id).unwrap();
        assert_eq!(state["state"]["affection"], 2);
        assert_eq!(state["state"]["date_planned"], json!(true));
        assert_eq!(state["state"]["cursor"], "cafe_reply");
        // 回复在原 Run 可见（G-READ，经 city run id 解析同一 story run）：
        // 事件 + 对白投影。
        let read = crate::city_runtime::read_story_run(&home, "city-instance",
            &json!({"runId":game_run_id})).unwrap();
        assert_eq!(read["storyRunId"], json!(story_run_id), "G-READ resolves the same story run");
        let read_dialogue = read["dialogue"].as_array().unwrap();
        fn text_of(entry: &Value) -> &str { entry["intent"]["text"].as_str().unwrap_or("") }
        assert!(read_dialogue.iter().any(|entry| text_of(entry) == "好啊，周六下午两点，老地方见！"),
            "reply visible in original run: {read}");
        // 玩家自己的话也在同一 Run（双向闭环）。
        assert!(read_dialogue.iter().any(|entry| text_of(entry) == "去咖啡馆吧？"));
        // 回合确认（reply 绑定同 Run）→ confirmed（D-6 终态）。
        let confirmed = agent_vitals_mcp::mcp::host_delivery::confirm_turn(&home,
            &json!({"sessionIdentifier":"sess-n3-loop","deliveryId":delivery_id,
                "reply":{"eventId":committed_event,"storyRunId":story_run_id}})).unwrap();
        assert_eq!(confirmed["status"], "confirmed");
        // 回执事件行 rule_id 取内容包 ruleId（事件身份对齐 eventDependencies）。
        let db = database(&home).unwrap();
        let rule_id: String = db.query_row("SELECT rule_id FROM story_events WHERE event_id=?1",
            [committed_event.as_str()], |row| row.get(0)).unwrap();
        assert_eq!(rule_id, "cafe-invite");
        // 闭环后预算：一次尝试计入。
        let ctx = crate::actor_adapter::turn_context(&home, &json!({"actorId":actor_id,
            "scope":{"playerId":player_id,"storyRunId":story_run_id}})).unwrap();
        assert_eq!(ctx["budget"]["used"], 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn proposal_requires_a_claimed_turn_of_the_same_actor() {
        let home = home();
        let (city_id, game_run_id, story_run_id, player_id) = start_session(&home);
        seed_affection(&home, &city_id, &story_run_id, &player_id, 1);
        let actor_id = register_actor(&home, "sess-n3-auth");
        player_speak(&home, &city_id, &game_run_id, "op-player-auth", "在吗？");
        // 未知 delivery id → 拒绝（即使总线已初始化）。
        assert_eq!(propose(&home, &actor_id, "delivery-none", "op-1", "e-invite", "hi")
            .unwrap_err(), "actor_turn_not_claimed");
        let claimed = claim(&home, "sess-n3-auth");
        let delivery_id = claimed["deliveries"][0]["deliveryId"].as_str().unwrap().to_string();
        // 他人 actor 领取行 → 拒绝（授权重校验：行归属）。
        let other = register_actor(&home, "sess-n3-other");
        assert_eq!(propose(&home, &other, &delivery_id, "op-steal", "e-invite", "hi")
            .unwrap_err(), "actor_turn_not_claimed");
        // 领取后本 actor 可提交。
        assert_eq!(propose(&home, &actor_id, &delivery_id, "op-own", "e-invite", "在的").unwrap()["accepted"], true);
        // 确认前回合仍在 in_flight（confirm 是显式终步）：新 operationId 的提案
        // 照常进入求值，被推进后的游标诚实拒绝（零写入）。
        let again = propose(&home, &actor_id, &delivery_id, "op-twice", "e-invite", "再发一次").unwrap();
        assert_eq!(again["accepted"], false);
        assert_eq!(again["code"], "narrative_rejected");
        assert!(again["diagnostics"].as_array().unwrap().iter().any(|d| d.as_str().unwrap().contains("cursor")),
            "cursor moved must be diagnosed: {again}");
        // 确认后回合关闭 → 再提案拒绝（actor_turn_not_claimed）。
        agent_vitals_mcp::mcp::host_delivery::confirm_turn(&home, &json!({"sessionIdentifier":"sess-n3-auth",
            "deliveryId":delivery_id,"reply":{"eventId":"evt-reply-auth","storyRunId":story_run_id}})).unwrap();
        assert_eq!(propose(&home, &actor_id, &delivery_id, "op-after", "e-invite", "晚了一步")
            .unwrap_err(), "actor_turn_not_claimed");
        // 全新 home（总线未初始化、actor 白盒登记）→ actor_turn_unavailable。
        let fresh = fresh_home();
        {
            let db = database(&fresh).unwrap();
            crate::actor_adapter::migrate(&db).unwrap();
            db.execute("INSERT INTO actors(actor_id,story_id,character_id,session_identifier,allowed_kinds,max_intents_per_window,window_started_ms,intents_used,created_at_ms,updated_at_ms)
                VALUES('actor-fresh','story.detective','resident:linxia','sess-fresh','[]',3,1,0,1,1)", []).unwrap();
        }
        assert_eq!(propose(&fresh, "actor-fresh", "delivery-y", "op-z", "e-invite", "hi")
            .unwrap_err(), "actor_turn_unavailable");
        std::fs::remove_dir_all(fresh).ok();
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn fabricated_edge_and_unsatisfied_preconditions_are_rejected_without_writes() {
        let home = home();
        let (city_id, game_run_id, story_run_id, player_id) = start_session(&home);
        let actor_id = register_actor(&home, "sess-n3-deny");
        player_speak(&home, &city_id, &game_run_id, "op-player-deny", "在吗？");
        let claimed = claim(&home, "sess-n3-deny");
        let delivery_id = claimed["deliveries"][0]["deliveryId"].as_str().unwrap().to_string();
        // N-02：好感度 0 → 邀请边前置不满足 → 拒绝（诊断透传），零写入。
        let denied = propose(&home, &actor_id, &delivery_id, "op-deny-1", "e-invite", "请我吧").unwrap();
        assert_eq!(denied["accepted"], false);
        assert_eq!(denied["code"], "narrative_rejected");
        assert!(denied["diagnostics"].as_array().unwrap().iter().any(|d| d.as_str().unwrap().contains("preconditions")),
            "diagnostics must explain: {denied}");
        // 伪造 edgeId → 拒绝。
        let fabricated = propose(&home, &actor_id, &delivery_id, "op-deny-2", "e-fake", "跳节点").unwrap();
        assert_eq!(fabricated["accepted"], false);
        // 拒绝零写入：状态未变（无好感度事实），仅玩家 speak 一条事件。
        let denied_state = crate::story_store::story_state_scoped(&home, &player_id, &city_id,
            "story.detective", &story_run_id).unwrap();
        assert!(denied_state["state"].get("affection").is_none(), "no affection writes: {denied_state}");
        let db = database(&home).unwrap();
        let events: i64 = db.query_row("SELECT count(*) FROM story_events WHERE story_run_id=?1",
            [story_run_id.as_str()], |row| row.get(0)).unwrap();
        assert_eq!(events, 1, "only the player's speak event exists");
        drop(db);
        // 白盒补好感度（版本不变）→ 同 delivery 重提案成功（回合仍 in_flight）。
        {
            let db = database(&home).unwrap();
            db.execute("UPDATE story_states SET document_json=?2 WHERE story_run_id=?1",
                params![story_run_id.as_str(),json!({"affection":1}).to_string()]).unwrap();
        }
        let accepted = propose(&home, &actor_id, &delivery_id, "op-retry", "e-invite", "那就周六吧").unwrap();
        assert_eq!(accepted["accepted"], true, "retry after state seed must pass: {accepted}");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn proposal_replay_returns_the_original_receipt() {
        let home = home();
        let (city_id, game_run_id, story_run_id, player_id) = start_session(&home);
        seed_affection(&home, &city_id, &story_run_id, &player_id, 1);
        let actor_id = register_actor(&home, "sess-n3-replay");
        player_speak(&home, &city_id, &game_run_id, "op-player-replay", "在吗？");
        let claimed = claim(&home, "sess-n3-replay");
        let delivery_id = claimed["deliveries"][0]["deliveryId"].as_str().unwrap().to_string();
        let first = propose(&home, &actor_id, &delivery_id, "op-same", "e-invite", "周六见").unwrap();
        assert_eq!(first["accepted"], true);
        let events_after_first: i64 = database(&home).unwrap().query_row(
            "SELECT count(*) FROM story_events WHERE story_run_id=?1", [story_run_id.as_str()], |r| r.get(0)).unwrap();
        // 同 operationId 重放（同载荷）→ already_confirmed，效果至多一次。
        let replay = propose(&home, &actor_id, &delivery_id, "op-same", "e-invite", "周六见").unwrap();
        assert_eq!(replay["turnStatus"], "already_confirmed");
        assert_eq!(replay["committedEventIds"], first["committedEventIds"]);
        let events_after_replay: i64 = database(&home).unwrap().query_row(
            "SELECT count(*) FROM story_events WHERE story_run_id=?1", [story_run_id.as_str()], |r| r.get(0)).unwrap();
        assert_eq!(events_after_replay, events_after_first, "replay must not double-commit");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn proposal_budget_gate_counts_semantic_rejections() {
        let home = home();
        let (city_id, game_run_id, _story_run_id, _player_id) = start_session(&home);
        let actor_id = register_actor(&home, "sess-n3-budget");
        {
            let db = database(&home).unwrap();
            db.execute("UPDATE actors SET max_intents_per_window=1 WHERE actor_id=?1",
                params![actor_id.as_str()]).unwrap();
        }
        player_speak(&home, &city_id, &game_run_id, "op-player-budget", "在吗？");
        let claimed = claim(&home, "sess-n3-budget");
        let delivery_id = claimed["deliveries"][0]["deliveryId"].as_str().unwrap().to_string();
        // 一次语义拒绝计入预算（好感度 0 → narrative_rejected）。
        let denied = propose(&home, &actor_id, &delivery_id, "op-b1", "e-invite", "请我吧").unwrap();
        assert_eq!(denied["accepted"], false);
        assert_eq!(denied["code"], "narrative_rejected");
        // 预算耗尽：fail fast（先于求值），本身不消耗。
        let exhausted = propose(&home, &actor_id, &delivery_id, "op-b2", "e-invite", "再试").unwrap();
        assert_eq!(exhausted["accepted"], false);
        assert_eq!(exhausted["code"], "actor_budget_exhausted");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn stale_snapshot_version_conflicts_at_commit() {
        // N-04：求值与提交之间状态推进 → CAS 拒绝（直接驱动提交步验证版本绑定）。
        let home = home();
        let (city_id, _game_run_id, story_run_id, player_id) = start_session(&home);
        seed_affection(&home, &city_id, &story_run_id, &player_id, 1);
        let snapshot = crate::narrative_engine::narrative_snapshot_scoped(&home, &player_id,
            &city_id, "story.detective", &story_run_id).unwrap();
        let clock = crate::city_runtime::read_clock_at(&home, &city_id, now_ms()).unwrap();
        let clock_revision = clock["clockRevision"].as_str().unwrap().to_string();
        // 版本推进者（另一 operation，CAS 在当前版本）。
        let advance = StoryCommitCommandV1 {
            operation_id: "op-advance".to_string(), event_id: "evt-advance".to_string(),
            player_id: player_id.clone(), city_id: city_id.clone(), game_id: "story.detective".to_string(),
            story_scope: Some(StoryStateScopeV1 { story_id: "story.detective".to_string(), story_run_id: story_run_id.clone() }),
            resident_id: None,
            expected_story_revision: snapshot["stateVersion"].as_str().unwrap().to_string(),
            expected_clock_revision: clock_revision.clone(),
            intent: json!({"kind":"speak","text":"竞争者"}), run_id: story_run_id.clone(),
            rule_set_digest: None, causation_id: None, correlation_id: None, narrative_effects: None,
        };
        crate::story_store::commit_story(&home, advance, StoryClockAuthorityV1 {
            revision: clock_revision.clone(), tick: clock["tick"].as_u64().unwrap(),
            simulation_utc_ms: clock["simulationUtcMs"].as_u64().unwrap(),
        }).unwrap();
        // 过期提案（求值于推进前版本）提交 → CAS 拒绝。
        let stale = StoryCommitCommandV1 {
            operation_id: "op-stale".to_string(), event_id: "evt-stale".to_string(),
            player_id: player_id.clone(), city_id: city_id.clone(), game_id: "story.detective".to_string(),
            story_scope: Some(StoryStateScopeV1 { story_id: "story.detective".to_string(), story_run_id: story_run_id.clone() }),
            resident_id: None,
            expected_story_revision: snapshot["stateVersion"].as_str().unwrap().to_string(),
            expected_clock_revision: clock_revision.clone(),
            intent: json!({"kind":"speak","text":"过期提案","edgeId":"e-invite"}), run_id: story_run_id.clone(),
            rule_set_digest: None, causation_id: None, correlation_id: Some("op-stale".to_string()),
            narrative_effects: Some(json!([
                {"op":"counter.add","key":"affection","value":1},
                {"op":"event.append","eventId":"evt-stale","ruleId":"cafe-invite"},
                {"op":"cursor.advance","to":"cafe_reply"}])),
        };
        let conflict = crate::story_store::commit_story(&home, stale, StoryClockAuthorityV1 {
            revision: clock_revision.clone(), tick: clock["tick"].as_u64().unwrap(),
            simulation_utc_ms: clock["simulationUtcMs"].as_u64().unwrap(),
        });
        assert_eq!(conflict.unwrap_err(), "game_storage_revision_conflict");
        std::fs::remove_dir_all(home).ok();
    }
}
