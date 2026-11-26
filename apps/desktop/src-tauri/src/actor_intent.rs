//! Actor Intent 管线（RFC V3 §3.2 统一执行链 + §12.2 公共仲裁，S-5/PR-5）：
//! Intent → 校验 Schema → Scope → 活跃 Run → 公共动作租约 → Clock 读 → CAS 提交
//! （State+Event+Outbox 一事务）→ 公共位置写入 → 租约闭环。
//!
//! 契约要点：
//! - 只放行 `StateScopeV1` 的 **story 私有子集**（§3.5.1）；game 子集走既有
//!   `city_runtime::commit`（runId 绑定）路径，公共/未知子集 fail-closed。
//! - 公共动作（args 携带 residentId+locationRef，或 kind=move——其 schema 强制
//!   携带二者）先取 `ResidentActivityLeaseV1` 租约：先到者持租约即天然有序
//!   （§12.2 的 (simulationUtcMs, intentId) 确定性排序由租约互斥具体化），
//!   异 holder 得 `resident_activity_busy` + 持有方 traceId；同 holder 重取=续期。
//! - 信封字段（RFC §3.2）：ruleSetDigest = Story 项目内容摘要（Graph/Canon 即该
//!   Story 的规则集；无项目行 → "none"）、causationId = sourceEventIds 首个、
//!   correlationId = intentId。
//! - 幂等：intentId 兼作 commit 的 operationId；eventId/traceId 由 intentId 确定性
//!   派生，同 intentId+同载荷重放命中 commit 回执并逐字段返回原 CommitDecision；
//!   同 intentId 换载荷被回执哈希冲突拦截（`operation_id_conflict`）。
//! - 失败语义（V3-09）双层契约：schema 层畸形请求（无法可信派生 traceId）按宿主
//!   惯例以 Err 码拒绝；语义仲裁拒绝（scope/Run/租约/时钟/提交冲突）不写
//!   State/Event/Outbox 并返回 `{accepted:false, code, traceId}`；瞬时/提交后冲突
//!   （公共位置 CAS）以 Err 透传，同 intentId 重试经回执收敛（效果至多一次）；
//!   租约释放幂等且在所有提交后路径执行，崩溃残留由 story_registry 惰性过期兜底
//!   （已落地）。
//! - LLM/会话管理不进事务：本模块是管线本身，Actor 适配器是后续 PR。
//!
//! dispatch 已接线（creator_city_host 分类器 + dispatch_city_runtime 臂）；模块级
//! dead_code 允许沿 story_store 先例承载尚未被全部消费的 API 面。
#![allow(dead_code)]
use serde_json::{json, Value};
use std::path::Path;
use crate::creator_store::{canonical_json, database, digest, now_ms, only_keys, valid_id};

/// AgentIntentV1.kind 白名单（RFC §3.2）。
const INTENT_KINDS: [&str; 6] = ["speak", "move", "interact", "invite", "give", "quest.action"];
/// intent args 预算（硬约束：≤8KiB canonical 字节）。
const ARGS_BUDGET_BYTES: usize = 8 * 1024;
/// sourceEventIds 有界（causationId 取首个，其余保留为载荷证据）。
const MAX_SOURCE_EVENT_IDS: usize = 16;
/// 无规则关联时的规则摘要占位（RFC §3.2 ruleSetDigest 必填）。
const NO_RULESET_DIGEST: &str = "none";

/// 确定性拒绝码集合：作为 CommitDecision（accepted=false + code）返回——调用方
/// 重读权威快照后以**新 intentId** 重评重试；不在此集合的错误（存储不可用等瞬时
/// 故障、公共位置 CAS 冲突）以 Err 透传，同 intentId 重试经回执幂等收敛。
const DECISION_CODES: [&str; 12] = [
    "intent_schema_invalid", "intent_args_budget_exceeded", "intent_scope_invalid",
    "story_run_not_found", "story_run_mismatch", "story_run_not_active",
    "resident_activity_busy", "city_time_uncertain", "game_actor_intent_denied",
    "game_storage_revision_conflict", "city_time_revision_conflict", "operation_id_conflict",
];

fn rejected(trace_id: &str, code: &str) -> Value {
    json!({"accepted":false,"code":code,"traceId":trace_id})
}

/// Err 码分派：确定性拒绝码 → CommitDecision；其余透传（可重试）。
fn as_decision_or_err(trace_id: &str, code: &'static str) -> Result<Value, &'static str> {
    if DECISION_CODES.contains(&code) { Ok(rejected(trace_id, code)) } else { Err(code) }
}

fn id_field(intent: &Value, key: &str) -> Result<String, &'static str> {
    intent.get(key).and_then(Value::as_str).filter(|id| valid_id(id)).map(str::to_string).ok_or("intent_schema_invalid")
}

/// kind 的必填 args 字段（schema 层第一道闸；store 校验器是非空第二道闸）。
fn required_args(kind: &str) -> &'static [&'static str] {
    match kind {
        "speak" => &["text"],
        "move" => &["residentId", "locationRef"],
        "interact" => &["targetId"],
        "invite" => &["residentId", "targetId"],
        "give" => &["targetId", "itemId"],
        "quest.action" => &["actionId"],
        _ => &[],
    }
}

fn require_args(kind: &str, args: &Value) -> Result<(), &'static str> {
    for key in required_args(kind) {
        let value = args.get(*key).ok_or("intent_schema_invalid")?;
        if *key == "text" {
            let text = value.as_str().ok_or("intent_schema_invalid")?;
            if text.is_empty() || text.chars().count() > 2_000 { return Err("intent_schema_invalid"); }
        } else if !value.as_str().is_some_and(valid_id) {
            return Err("intent_schema_invalid");
        }
    }
    Ok(())
}

/// validate_intent 的产出（避免过长元组签名的命名结构）。
struct ValidatedIntent {
    intent_id: String,
    kind: String,
    args: Value,
    expected_revision: String,
    source_event_ids: Vec<String>,
    scope: Value,
}

/// RFC §3.2 AgentIntentV1 schema 校验：精确顶层键、kind 白名单、args 对象有界
/// （≤8KiB canonical、无原型污染键、kind 不可被 args 覆写）、语义 id 字段合法、
/// sourceEventIds 有界且逐项合法。actorId 只校验不透传：事件信封的 actorId 由
/// 提交主体（scope 持有方 player）落库，不接受调用方自报身份。
fn validate_intent(intent: &Value) -> Result<ValidatedIntent, &'static str> {
    if intent.as_object().is_none_or(|object| !only_keys(object,
        &["intentId", "actorId", "scope", "kind", "args", "expectedRevision", "sourceEventIds"])) {
        return Err("intent_schema_invalid");
    }
    let intent_id = id_field(intent, "intentId")?;
    id_field(intent, "actorId")?;
    let kind = intent.get("kind").and_then(Value::as_str)
        .filter(|kind| INTENT_KINDS.contains(kind)).ok_or("intent_schema_invalid")?.to_string();
    let args = intent.get("args").filter(|value| value.is_object()).ok_or("intent_schema_invalid")?;
    if args.as_object().is_some_and(|map| map.keys().any(|key|
        matches!(key.as_str(), "kind" | "__proto__" | "constructor" | "prototype"))) {
        return Err("intent_schema_invalid");
    }
    if canonical_json(args).map_err(|_| "intent_schema_invalid")?.len() > ARGS_BUDGET_BYTES {
        return Err("intent_args_budget_exceeded");
    }
    // 语义字段（无论 kind 是否要求）一律必须合法 id：公共路径触发与命令载荷之前的统一闸。
    for key in ["residentId", "locationRef", "targetId", "itemId", "actionId"] {
        if let Some(value) = args.get(key) {
            if !value.as_str().is_some_and(valid_id) { return Err("intent_schema_invalid"); }
        }
    }
    require_args(&kind, args)?;
    let expected_revision = id_field(intent, "expectedRevision")?;
    let mut source_event_ids = Vec::new();
    if let Some(ids) = intent.get("sourceEventIds") {
        let ids = ids.as_array().filter(|ids| !ids.is_empty() && ids.len() <= MAX_SOURCE_EVENT_IDS)
            .ok_or("intent_schema_invalid")?;
        for id in ids {
            source_event_ids.push(id.as_str().filter(|id| valid_id(id)).ok_or("intent_schema_invalid")?.to_string());
        }
    }
    Ok(ValidatedIntent {
        intent_id, kind, args: args.clone(), expected_revision, source_event_ids,
        scope: intent.get("scope").cloned().ok_or("intent_schema_invalid")?,
    })
}

/// 公共动作判定（§12.2：影响 cityId+residentId 公共位置/活动）：args 同时携带
/// 合法 residentId 与 locationRef——kind=move 的 schema 强制二者，故 move 恒为
/// 公共动作；其余 kind 携带二者同样走租约+公共写入路径。
fn public_action(args: &Value) -> Option<(String, String)> {
    let resident = args.get("residentId").and_then(Value::as_str).filter(|id| valid_id(id))?;
    let location = args.get("locationRef").and_then(Value::as_str).filter(|id| valid_id(id))?;
    Some((resident.to_string(), location.to_string()))
}

/// 租约闭环（四条释放路径的「正常完成/取消拒绝」二条，RFC §12.2）：幂等释放，
/// 失败静默——崩溃残留由 story_registry 惰性过期兜底，不产生永久 busy。
fn release_lease(home: &Path, city_id: &str, resident_id: Option<&str>, trace_id: &str) {
    if let Some(resident_id) = resident_id {
        let _ = crate::story_registry::lease_release(home, &json!({
            "cityId": city_id, "residentId": resident_id, "traceId": trace_id}));
    }
}

/// 公共 NPC 位置权威写入（租约内）：读当前权威行取 CAS 基线后写公共 scope；
/// write_resident_state 的按值幂等保证重放不重复推进 revision。
fn apply_public_location(home: &Path, city_id: &str, resident_id: &str, location_ref: &str) -> Result<Value, &'static str> {
    let current = crate::story_store::read_resident_state(home, city_id, resident_id)?;
    let revision = current["revision"].as_str().ok_or("creator_store_unavailable")?;
    crate::story_store::write_resident_state(home,
        &json!({"kind":"city-resident-public","cityId":city_id,"residentId":resident_id}), location_ref, revision)
}

/// 统一执行链入口（RFC §3.2）：接收 Intent → 校验 → 租约 → CAS 提交 → 信封 →
/// 租约闭环，返回 CommitDecisionV1 形状的 Value（accepted/code/committedEventIds/
/// newRevision/traceId；busy 时附 holderTraceId 可解释诊断）。瞬时故障以 Err 透传。
pub(crate) fn submit_intent(home: &Path, intent: &Value) -> Result<Value, &'static str> {
    let validated = validate_intent(intent)?;
    let ValidatedIntent { intent_id, kind, args, expected_revision, source_event_ids, scope: scope_value } = validated;
    // traceId 由 intentId 确定性派生（有界）：重放返回原 trace，租约审计跨重试一致。
    let trace_id = digest(&format!("intent-trace:{intent_id}"));
    // Scope（§3.5.1 判别联合）：只放行 story 私有子集；私有子集之间互不可见由
    // story_store 四元组寻址承担，公共/未知子集 fail-closed。
    let (player_id, city_id, story_id, story_run_id) = match crate::story_store::parse_state_scope(&scope_value) {
        Ok(crate::story_store::StateScopeV1::Story { player_id, city_id, story_id, story_run_id, .. }) =>
            (player_id, city_id, story_id, story_run_id),
        _ => return Ok(rejected(&trace_id, "intent_scope_invalid")),
    };
    // 活跃 Run（story_registry 权威查询）：scope 四元组必须精确命中 active/paused Run。
    {
        let db = database(home)?;
        crate::story_registry::migrate(&db)?;
        if let Err(code) = crate::story_registry::require_active_run(&player_id, &city_id, &story_id, &story_run_id, &db) {
            return as_decision_or_err(&trace_id, code);
        }
    }
    // 公共动作租约：先到者持租约即有序；异 holder → busy + 持有方 traceId（不写任何事实）。
    let public = public_action(&args);
    let mut lease_held: Option<String> = None;
    if let Some((resident_id, _)) = public.as_ref() {
        let acquire = crate::story_registry::lease_acquire(home, &json!({
            "cityId": city_id, "residentId": resident_id, "holderScope": scope_value,
            "holderIntentId": intent_id, "traceId": trace_id}))?;
        if acquire.get("acquired").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({"accepted":false,"code":"resident_activity_busy",
                "holderTraceId":acquire["holderTraceId"],"traceId":trace_id}));
        }
        lease_held = Some(resident_id.clone());
    }
    // Clock 权威读（§3.1）：回拨不确定即拒绝（decision 码），不提交。
    let clock = match crate::city_runtime::read_clock_at(home, &city_id, now_ms()) {
        Ok(clock) => clock,
        Err(code) => {
            release_lease(home, &city_id, lease_held.as_deref(), &trace_id);
            return as_decision_or_err(&trace_id, code);
        }
    };
    if clock.get("uncertainty").is_some() {
        release_lease(home, &city_id, lease_held.as_deref(), &trace_id);
        return Ok(rejected(&trace_id, "city_time_uncertain"));
    }
    let clock_revision = clock["clockRevision"].as_str().ok_or("creator_store_unavailable")?.to_string();
    let tick = clock["tick"].as_u64().ok_or("creator_store_unavailable")?;
    let simulation_utc_ms = clock["simulationUtcMs"].as_u64().ok_or("creator_store_unavailable")?;
    // 信封字段：ruleSetDigest = Story 项目内容摘要（无规则关联 → "none"）。
    let rule_set_digest = crate::story_registry::project_content_digest(home, &story_id)?
        .unwrap_or_else(|| NO_RULESET_DIGEST.to_string());
    // Intent → StoryCommitCommandV1：intentId 兼作 operationId（回执幂等），eventId
    // 由 intentId 确定性派生（重放哈希稳定）；args 并入 intent 顶层（kind 不可覆写），
    // legacy speak/invite 投影（dialogue 文本、type=intent.kind）继续成立；game_id 列
    // 仅承载 story 身份，寻址一律走显式 story_scope（RFC §3.5）。
    let mut command_intent = serde_json::Map::new();
    command_intent.insert("kind".to_string(), json!(kind));
    if let Some(map) = args.as_object() {
        for (key, value) in map { command_intent.insert(key.clone(), value.clone()); }
    }
    let command = crate::story_store::StoryCommitCommandV1 {
        operation_id: intent_id.clone(),
        event_id: digest(&format!("intent-event:{intent_id}")),
        player_id: player_id.clone(), city_id: city_id.clone(), game_id: story_id.clone(),
        story_scope: Some(crate::story_store::StoryStateScopeV1 {
            story_id: story_id.clone(), story_run_id: story_run_id.clone() }),
        resident_id: args.get("residentId").and_then(Value::as_str).filter(|id| valid_id(id)).map(str::to_string),
        expected_story_revision: expected_revision,
        expected_clock_revision: clock_revision.clone(),
        intent: Value::Object(command_intent),
        run_id: story_run_id,
        rule_set_digest: Some(rule_set_digest),
        causation_id: source_event_ids.first().cloned(),
        correlation_id: Some(intent_id),
        // Intent 管线（PR-5/S-5）不做叙事求值——legacy kind 规则保持不变；
        // 求值器裁决效果只由 actor_turn 裁决链注入（N3）。
        narrative_effects: None,
    };
    // CAS 提交（State+Event+Outbox+回执 一事务）。
    let commit = crate::story_store::commit_story(home, command, crate::story_store::StoryClockAuthorityV1 {
        revision: clock_revision, tick, simulation_utc_ms });
    match commit {
        Ok(result) => {
            // 公共动作：租约内写公共权威行（按值幂等）；公共 CAS 冲突以 Err 透传
            // （事件已提交、效果至多一次，重试经回执收敛）。
            let public_error = match public.as_ref() {
                Some((resident_id, location_ref)) => apply_public_location(home, &city_id, resident_id, location_ref).err(),
                None => None,
            };
            release_lease(home, &city_id, lease_held.as_deref(), &trace_id);
            if let Some(code) = public_error { return Err(code); }
            Ok(json!({"accepted":true,
                "committedEventIds":[result["eventId"]],
                "newRevision":result["storyRevision"],"traceId":trace_id}))
        }
        Err(code) => {
            // 拒绝/冲突：零部分写入（commit_story 预写闸先于任何 INSERT），释放租约
            // 并保留审计（V3-09）；确定性拒绝码折算为 CommitDecision。
            release_lease(home, &city_id, lease_held.as_deref(), &trace_id);
            as_decision_or_err(&trace_id, code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creator_store::database;
    use rusqlite::params;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PLAYER: &str = "local-profile-v1";

    fn home() -> std::path::PathBuf {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!("actor-intent-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)))
    }

    fn create_city(home: &Path, operation: &str) -> Value {
        let profile = json!({"schemaVersion":1,"id":"desert","version":1,"biome":"arid",
            "geography":{"generator":"arid-dunes-v1","parameters":{"dunes":{"duneScale":190,"duneAmplitude":11,"orientationDeg":18}}},
            "visuals":{"themeId":"desert"}});
        crate::creator_cities::create_city(home, "local", operation, "Story City", 42, &profile).unwrap()
    }

    fn install(home: &Path, city: &Value, story_id: &str, seed: &str, operation: &str) {
        crate::story_registry::project_create(home, &json!({"storyId":story_id,"title":"侦探线","schemaVersion":1,"storyVersion":"1.0.0",
            "graph":{"nodes":[],"seed":seed},"canon":{"characters":[]}})).unwrap();
        let checked = crate::story_registry::install_preview(home, &json!({"storyId":story_id,"targetCityId":city["cityId"],
            "expectedCityRevision":city["revision"],"operationId":format!("{operation}-preview")})).unwrap();
        assert_eq!(checked["canInstall"], true, "preview should allow install: {checked}");
        crate::story_registry::install_commit(home, &json!({"previewId":checked["previewId"],"operationId":format!("{operation}-commit")})).unwrap();
    }

    fn start_run(home: &Path, city: &Value, story_id: &str) -> Value {
        crate::story_registry::run_start(home, PLAYER, &json!({"cityId":city["cityId"],"storyId":story_id})).unwrap()
    }

    fn story_scope(city: &Value, story_id: &str, story_run_id: &str) -> Value {
        json!({"kind":"story","playerId":PLAYER,"cityId":city["cityId"],"storyId":story_id,"storyRunId":story_run_id})
    }

    fn intent(city: &Value, story_id: &str, story_run_id: &str, intent_id: &str, kind: &str, args: Value) -> Value {
        json!({"intentId":intent_id,"actorId":"agent-1","scope":story_scope(city, story_id, story_run_id),
            "kind":kind,"args":args,"expectedRevision":"0"})
    }

    fn move_intent(city: &Value, story_id: &str, story_run_id: &str, intent_id: &str, location: &str) -> Value {
        intent(city, story_id, story_run_id, intent_id, "move",
            json!({"residentId":"resident:linxia","locationRef":location}))
    }

    fn event_count(home: &Path, player: &str, city: &Value, story_id: &str, story_run_id: &str) -> usize {
        crate::story_store::story_event_envelopes_scoped(home, player, city["cityId"].as_str().unwrap(), story_id, story_run_id, 100)
            .unwrap().len()
    }

    fn lease_event_kinds(home: &Path) -> Vec<String> {
        let db = database(home).unwrap();
        crate::story_registry::migrate(&db).unwrap();
        let kinds: Vec<String> = db.prepare("SELECT kind FROM resident_activity_lease_events ORDER BY created_at_ms").unwrap()
            .query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<Result<_, _>>().unwrap();
        kinds
    }

    #[test]
    fn move_intent_commits_envelope_writes_public_location_and_releases_lease() {
        let home = home();
        let city = create_city(&home, "city-a");
        install(&home, &city, "story.detective", "seed-a", "install-a");
        let run = start_run(&home, &city, "story.detective");
        let run_id = run["storyRunId"].as_str().unwrap().to_string();
        let project = crate::story_registry::project_read(&home, &json!({"storyId":"story.detective"})).unwrap();
        let mut request = move_intent(&city, "story.detective", &run_id, "intent-move-1", "place:cafe");
        request["sourceEventIds"] = json!(["event-cause-0", "event-cause-1"]);
        let decision = submit_intent(&home, &request).unwrap();
        assert_eq!(decision["accepted"], true);
        assert_eq!(decision["committedEventIds"].as_array().unwrap().len(), 1);
        assert!(!decision["newRevision"].as_str().unwrap().is_empty());
        assert!(decision["traceId"].as_str().unwrap().starts_with("sha256:"));
        // 公共权威行落位（§12.2：公共 NPC 状态归 cityId+residentId）。
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["locationRef"], "place:cafe");
        assert_ne!(resident["revision"], "0");
        // 信封字段读回（RFC §3.2）：ruleSetDigest=Story 内容摘要、causationId=首个
        // sourceEventId、correlationId=intentId、scope=story 子集、type=intent.kind。
        let envelopes = crate::story_store::story_event_envelopes_scoped(&home, PLAYER,
            city["cityId"].as_str().unwrap(), "story.detective", &run_id, 10).unwrap();
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0]["eventId"], decision["committedEventIds"][0]);
        assert_eq!(envelopes[0]["type"], "move");
        assert_eq!(envelopes[0]["scope"]["kind"], "story");
        assert_eq!(envelopes[0]["scope"]["storyId"], "story.detective");
        assert_eq!(envelopes[0]["scope"]["storyRunId"], run_id);
        assert_eq!(envelopes[0]["ruleSetDigest"], project["contentDigest"]);
        assert_eq!(envelopes[0]["causationId"], "event-cause-0");
        assert_eq!(envelopes[0]["correlationId"], "intent-move-1");
        assert_eq!(envelopes[0]["payload"]["locationRef"], "place:cafe");
        // move 的私有状态零变更（公共位置权威在 city_resident_state）。
        let state = crate::story_store::story_state_scoped(&home, PLAYER,
            city["cityId"].as_str().unwrap(), "story.detective", &run_id).unwrap();
        assert_eq!(state["state"], json!({}));
        // 提交后租约闭环：审计含 released，行状态 released；另一 Story 可立即获得。
        assert_eq!(lease_event_kinds(&home), vec!["released".to_string()]);
        let db = database(&home).unwrap();
        crate::story_registry::migrate(&db).unwrap();
        let lease_status: String = db.query_row("SELECT status FROM resident_activity_leases WHERE city_id=?1 AND resident_id=?2",
            [city["cityId"].as_str().unwrap(), "resident:linxia"], |row| row.get(0)).unwrap();
        drop(db);
        assert_eq!(lease_status, "released");
        install(&home, &city, "story.romance", "seed-b", "install-b");
        let romance_run = start_run(&home, &city, "story.romance");
        let acquired = crate::story_registry::lease_acquire(&home, &json!({"cityId":city["cityId"],"residentId":"resident:linxia",
            "holderScope":story_scope(&city, "story.romance", romance_run["storyRunId"].as_str().unwrap()),
            "holderIntentId":"intent-romance","traceId":"trace-romance"})).unwrap();
        assert_eq!(acquired["acquired"], true);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn intent_rejects_schema_gaps_without_any_writes() {
        let home = home();
        let city = create_city(&home, "city-a");
        install(&home, &city, "story.detective", "seed-a", "install-a");
        let run = start_run(&home, &city, "story.detective");
        let run_id = run["storyRunId"].as_str().unwrap().to_string();
        // 双层契约：schema 层畸形请求（无法可信派生 traceId）按宿主惯例以 Err 码
        // 拒绝；语义仲裁拒绝（scope/run/租约/时钟/提交冲突）才是 CommitDecision。
        // kind 白名单外拒绝。
        let unknown_kind = intent(&city, "story.detective", &run_id, "intent-x1", "delete-city", json!({}));
        assert_eq!(submit_intent(&home, &unknown_kind).unwrap_err(), "intent_schema_invalid");
        // args 缺必填字段（move 必须 residentId+locationRef）。
        let missing_args = intent(&city, "story.detective", &run_id, "intent-x2", "move", json!({"residentId":"resident:linxia"}));
        assert_eq!(submit_intent(&home, &missing_args).unwrap_err(), "intent_schema_invalid");
        // args 覆写 kind / 原型污染键拒绝。
        let shadow = intent(&city, "story.detective", &run_id, "intent-x3", "move",
            json!({"residentId":"resident:linxia","locationRef":"place:cafe","kind":"delete-city"}));
        assert_eq!(submit_intent(&home, &shadow).unwrap_err(), "intent_schema_invalid");
        let polluted = intent(&city, "story.detective", &run_id, "intent-x4", "interact",
            json!({"targetId":"place:cafe","__proto__":{}}));
        assert_eq!(submit_intent(&home, &polluted).unwrap_err(), "intent_schema_invalid");
        // args 超预算（8KiB）拒绝。
        let oversized = intent(&city, "story.detective", &run_id, "intent-x5", "interact",
            json!({"targetId":"place:cafe","pad":"x".repeat(ARGS_BUDGET_BYTES + 1)}));
        assert_eq!(submit_intent(&home, &oversized).unwrap_err(), "intent_args_budget_exceeded");
        // sourceEventIds：空数组、超界、非法项拒绝。
        let overbound = json!((0..MAX_SOURCE_EVENT_IDS + 1).map(|index| format!("event-{index}")).collect::<Vec<_>>());
        for bad_ids in [json!([]), overbound, json!(["bad id!"])] {
            let mut request = intent(&city, "story.detective", &run_id, "intent-x6", "speak", json!({"text":"hi"}));
            request["sourceEventIds"] = bad_ids;
            assert_eq!(submit_intent(&home, &request).unwrap_err(), "intent_schema_invalid");
        }
        // 顶层未知键 / 缺 intentId / 非法 expectedRevision 拒绝。
        let mut extra = intent(&city, "story.detective", &run_id, "intent-x7", "speak", json!({"text":"hi"}));
        extra["state"] = json!({"affection":99});
        assert_eq!(submit_intent(&home, &extra).unwrap_err(), "intent_schema_invalid");
        let no_id = json!({"actorId":"agent-1","scope":story_scope(&city, "story.detective", &run_id),
            "kind":"speak","args":{"text":"hi"},"expectedRevision":"0"});
        assert_eq!(submit_intent(&home, &no_id).unwrap_err(), "intent_schema_invalid");
        // 全部拒绝路径零写入：无事件、无公共行、无租约。
        assert_eq!(event_count(&home, PLAYER, &city, "story.detective", &run_id), 0);
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["revision"], "0");
        assert!(lease_event_kinds(&home).is_empty());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn intent_rejects_non_story_scopes_and_run_gaps() {
        let home = home();
        let city = create_city(&home, "city-a");
        install(&home, &city, "story.detective", "seed-a", "install-a");
        let run = start_run(&home, &city, "story.detective");
        let run_id = run["storyRunId"].as_str().unwrap().to_string();
        let city_id = city["cityId"].as_str().unwrap().to_string();
        // scope 判别联合：公共子集 / game 子集 / 未知 kind 一律 fail-closed（§3.5.1）。
        for (scope, label) in [
            (json!({"kind":"city-resident-public","cityId":city_id,"residentId":"resident:linxia"}), "public"),
            (json!({"kind":"game","playerId":PLAYER,"cityId":city_id,"gameId":"game.romance"}), "game"),
            (json!({"kind":"story-v2","playerId":PLAYER,"cityId":city_id}), "unknown"),
        ] {
            let request = json!({"intentId":format!("intent-scope-{label}"),"actorId":"agent-1","scope":scope,
                "kind":"speak","args":{"text":"hi"},"expectedRevision":"0"});
            let decision = submit_intent(&home, &request).unwrap();
            assert_eq!(decision["accepted"], false, "{label} scope must be rejected");
            assert_eq!(decision["code"], "intent_scope_invalid", "{label} scope must be rejected");
        }
        // 无活跃 Run：story 已安装但未 start。
        let no_run = intent(&city, "story.detective", "story-run-missing", "intent-no-run", "speak", json!({"text":"hi"}));
        assert_eq!(submit_intent(&home, &no_run).unwrap()["code"], "story_run_not_found");
        // Run 存在但 scope 四元组不匹配（storyId 换成未安装 Story）→ mismatch。
        let mismatched = intent(&city, "story.romance", &run_id, "intent-mismatch", "speak", json!({"text":"hi"}));
        assert_eq!(submit_intent(&home, &mismatched).unwrap()["code"], "story_run_mismatch");
        // Run 显式停止后提交 → not_active（V3-18：停止是显式生命周期变更）。
        crate::story_registry::run_stop(&home, &json!({"storyRunId":run_id})).unwrap();
        let stopped = intent(&city, "story.detective", &run_id, "intent-stopped", "speak", json!({"text":"hi"}));
        assert_eq!(submit_intent(&home, &stopped).unwrap()["code"], "story_run_not_active");
        assert_eq!(event_count(&home, PLAYER, &city, "story.detective", &run_id), 0);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn two_stories_moving_same_resident_serialize_through_lease_and_loser_is_rejected() {
        let home = home();
        let city = create_city(&home, "city-a");
        install(&home, &city, "story.detective", "seed-a", "install-a");
        install(&home, &city, "story.romance", "seed-b", "install-b");
        let detective_run = start_run(&home, &city, "story.detective");
        let romance_run = start_run(&home, &city, "story.romance");
        let detective_run_id = detective_run["storyRunId"].as_str().unwrap().to_string();
        let romance_run_id = romance_run["storyRunId"].as_str().unwrap().to_string();
        // 侦探线先持租约（模拟其公共动作已在执行中）：先到者持租约即天然有序。
        crate::story_registry::lease_acquire(&home, &json!({"cityId":city["cityId"],"residentId":"resident:linxia",
            "holderScope":story_scope(&city, "story.detective", &detective_run_id),
            "holderIntentId":"intent-detective-flight","traceId":"trace-detective"})).unwrap();
        // 恋爱线同刻提交同 NPC 的另一地点 move → busy + 持有方 traceId（V3-19）。
        let loser = move_intent(&city, "story.romance", &romance_run_id, "intent-romance-move", "place:park");
        let decision = submit_intent(&home, &loser).unwrap();
        assert_eq!(decision["accepted"], false);
        assert_eq!(decision["code"], "resident_activity_busy");
        assert_eq!(decision["holderTraceId"], "trace-detective");
        assert!(decision.get("newRevision").is_none());
        // 拒绝零写入：恋爱线无事件行，公共权威行不存在（V3-05：不存在同时两地）。
        assert_eq!(event_count(&home, PLAYER, &city, "story.romance", &romance_run_id), 0);
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["revision"], "0");
        assert!(resident.get("locationRef").is_none());
        // 侦探线释放（终态）→ 恋爱线同 intentId 重试成功：同一权威序列中位置单一。
        crate::story_registry::lease_release(&home, &json!({"cityId":city["cityId"],
            "residentId":"resident:linxia","traceId":"trace-detective"})).unwrap();
        let retried = submit_intent(&home, &loser).unwrap();
        assert_eq!(retried["accepted"], true);
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["locationRef"], "place:park");
        assert_eq!(event_count(&home, PLAYER, &city, "story.romance", &romance_run_id), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn intent_replay_is_idempotent_and_payload_change_conflicts() {
        let home = home();
        let city = create_city(&home, "city-a");
        install(&home, &city, "story.detective", "seed-a", "install-a");
        let run = start_run(&home, &city, "story.detective");
        let run_id = run["storyRunId"].as_str().unwrap().to_string();
        let request = move_intent(&city, "story.detective", &run_id, "intent-move-1", "place:cafe");
        let first = submit_intent(&home, &request).unwrap();
        assert_eq!(first["accepted"], true);
        // 同 intentId+同载荷重放：逐字段返回原 CommitDecision（V3-09 至多一次效果）。
        let replay = submit_intent(&home, &request).unwrap();
        assert_eq!(replay, first);
        assert_eq!(event_count(&home, PLAYER, &city, "story.detective", &run_id), 1);
        // 公共位置按值幂等：重放不推进 revision。
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["locationRef"], "place:cafe");
        let revision_after_first = resident["revision"].clone();
        // 同 intentId 换载荷 → 回执哈希冲突，确定性拒绝。
        let changed = move_intent(&city, "story.detective", &run_id, "intent-move-1", "place:park");
        let decision = submit_intent(&home, &changed).unwrap();
        assert_eq!(decision["accepted"], false);
        assert_eq!(decision["code"], "operation_id_conflict");
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["revision"], revision_after_first);
        assert_eq!(event_count(&home, PLAYER, &city, "story.detective", &run_id), 1);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn crashed_holder_lease_expires_lazily_and_next_intent_proceeds() {
        let home = home();
        let city = create_city(&home, "city-a");
        install(&home, &city, "story.detective", "seed-a", "install-a");
        install(&home, &city, "story.romance", "seed-b", "install-b");
        let romance_run = start_run(&home, &city, "story.romance");
        let romance_run_id = romance_run["storyRunId"].as_str().unwrap().to_string();
        // 持有方崩溃模拟：租约残留、无人释放——回拨 expires_at_ms 模拟时钟推进。
        crate::story_registry::lease_acquire(&home, &json!({"cityId":city["cityId"],"residentId":"resident:linxia",
            "holderScope":story_scope(&city, "story.detective", "story-run-crashed"),
            "holderIntentId":"intent-crashed","traceId":"trace-crashed"})).unwrap();
        let db = database(&home).unwrap();
        db.execute("UPDATE resident_activity_leases SET expires_at_ms=0 WHERE city_id=?1 AND resident_id=?2",
            [city["cityId"].as_str().unwrap(), "resident:linxia"]).unwrap();
        drop(db);
        // 下一个 Intent 的仲裁路径惰性回收过期租约（V3-19 r3：不产生永久 busy，
        // 回收产生 resident_activity_busy_expired 等价审计行）并正常获租提交。
        let next = move_intent(&city, "story.romance", &romance_run_id, "intent-after-crash", "place:park");
        let decision = submit_intent(&home, &next).unwrap();
        assert_eq!(decision["accepted"], true, "expired lease must be recycled lazily: {decision}");
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["locationRef"], "place:park");
        let kinds = lease_event_kinds(&home);
        assert!(kinds.contains(&"expired".to_string()), "lazy expiry must leave audit: {kinds:?}");
        assert!(kinds.contains(&"released".to_string()));
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn rule_set_digest_falls_back_to_none_without_a_story_project() {
        let home = home();
        let city = create_city(&home, "city-a");
        // 降级路径：Run 行存在但 Story 项目行缺席（先于规则关联的事实）——
        // 直接落 Run 行构造该形态，ruleSetDigest 落 "none"。
        let db = database(&home).unwrap();
        crate::story_registry::migrate(&db).unwrap();
        db.execute("INSERT INTO story_runs(story_run_id,player_id,city_id,story_id,status,last_viewed_at_ms,resumed_from,created_at_ms,updated_at_ms)
            VALUES ('story-run-orph',?1,?2,'story.ghost','active',1,NULL,1,1)", params![PLAYER, city["cityId"].as_str().unwrap()]).unwrap();
        drop(db);
        let request = intent(&city, "story.ghost", "story-run-orph", "intent-orph", "speak", json!({"text":"Where were you?"}));
        let decision = submit_intent(&home, &request).unwrap();
        assert_eq!(decision["accepted"], true);
        let envelopes = crate::story_store::story_event_envelopes_scoped(&home, PLAYER,
            city["cityId"].as_str().unwrap(), "story.ghost", "story-run-orph", 10).unwrap();
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0]["ruleSetDigest"], "none");
        assert!(envelopes[0].get("causationId").is_none(), "无 sourceEventIds 时 causationId 按可选语义省略");
        assert_eq!(envelopes[0]["correlationId"], "intent-orph");
        assert_eq!(envelopes[0]["type"], "speak");
        // speak 的私有事实：dialogue 投影继续成立（legacy 形状兼容）。
        let dialogue = crate::story_store::story_dialogue_scoped(&home, PLAYER,
            city["cityId"].as_str().unwrap(), "story.ghost", "story-run-orph", 10).unwrap();
        assert_eq!(dialogue.len(), 1);
        assert_eq!(dialogue[0]["intent"]["text"], "Where were you?");
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn private_kinds_commit_without_public_side_effects() {
        let home = home();
        let city = create_city(&home, "city-a");
        install(&home, &city, "story.detective", "seed-a", "install-a");
        let run = start_run(&home, &city, "story.detective");
        let run_id = run["storyRunId"].as_str().unwrap().to_string();
        // interact 携带 residentId（无 locationRef）：私有交互不触发公共仲裁路径。
        let interact = intent(&city, "story.detective", &run_id, "intent-interact", "interact",
            json!({"targetId":"place:cafe","residentId":"resident:linxia"}));
        let decision = submit_intent(&home, &interact).unwrap();
        assert_eq!(decision["accepted"], true);
        assert!(lease_event_kinds(&home).is_empty(), "无公共动作不得产生租约审计");
        let resident = crate::story_store::read_resident_state(&home, city["cityId"].as_str().unwrap(), "resident:linxia").unwrap();
        assert_eq!(resident["revision"], "0");
        // speak + invite：既有私有规则效果经 Intent 管线保持（affection+1）。
        let speak_revision = decision["newRevision"].as_str().unwrap().to_string();
        let mut invite = intent(&city, "story.detective", &run_id, "intent-invite", "invite",
            json!({"residentId":"resident:linxia","targetId":"place:beach"}));
        invite["expectedRevision"] = json!(speak_revision);
        let invited = submit_intent(&home, &invite).unwrap();
        assert_eq!(invited["accepted"], true);
        let state = crate::story_store::story_state_scoped(&home, PLAYER,
            city["cityId"].as_str().unwrap(), "story.detective", &run_id).unwrap();
        assert_eq!(state["state"]["affection"], 1);
        // quest.action：零私有变更、事件即事实。
        let quest_revision = invited["newRevision"].as_str().unwrap().to_string();
        let mut quest = intent(&city, "story.detective", &run_id, "intent-quest", "quest.action",
            json!({"actionId":"quest.clue.found"}));
        quest["expectedRevision"] = json!(quest_revision);
        assert_eq!(submit_intent(&home, &quest).unwrap()["accepted"], true);
        let state = crate::story_store::story_state_scoped(&home, PLAYER,
            city["cityId"].as_str().unwrap(), "story.detective", &run_id).unwrap();
        assert_eq!(state["state"]["affection"], 1);
        assert_eq!(event_count(&home, PLAYER, &city, "story.detective", &run_id), 3);
        std::fs::remove_dir_all(home).ok();
    }
}
