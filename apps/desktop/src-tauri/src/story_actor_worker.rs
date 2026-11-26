//! User-started ACP Actor sessions, each confined to one installed Story Run.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}};

use agent_vitals_mcp::mcp::{ToolError, creator_agent_executor::{acp_registry, AcpAgentExecutor}, host_delivery};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::creator_store::{database, digest};

#[derive(Default)]
struct Worker {
    cancel: AtomicBool,
    ready: AtomicBool,
    done: AtomicBool,
    failure: Mutex<Option<&'static str>>,
    character_id: String,
    agent_id: String,
}

type WorkerKey = (PathBuf, String);
fn workers() -> &'static Mutex<HashMap<WorkerKey, Arc<Worker>>> {
    static WORKERS: OnceLock<Mutex<HashMap<WorkerKey, Arc<Worker>>>> = OnceLock::new();
    WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn options(home: &Path) -> Value {
    let agents: Vec<_> = acp_registry(home).into_iter().filter(|entry| !entry.program.is_empty()).take(32)
        .map(|entry| json!({"id":entry.id,"name":if entry.name.is_empty() { entry.id.clone() } else { entry.name }})).collect();
    json!({"agents":agents})
}

fn field<'a>(payload: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    payload[key].as_str().filter(|id| crate::city_runtime::valid_id(id)).ok_or("story_argument_invalid")
}

struct ActorScope {
    city: String,
    story: String,
    run: String,
    owner: String,
}

impl ActorScope {
    fn load(home: &Path, owner: &str, run: &str) -> Result<Self, &'static str> {
        let db = database(home)?;
        crate::story_registry::migrate(&db)?;
        db.query_row("SELECT city_id,story_id FROM story_runs WHERE story_run_id=?1 AND player_id=?2",
            params![run,owner], |row| Ok(Self {
                city:row.get(0)?,story:row.get(1)?,run:run.to_owned(),owner:owner.to_owned(),
            })).optional().map_err(|_| "creator_store_unavailable")?.ok_or("story_run_not_found")
    }

    fn active(&self, home: &Path) -> Result<bool, &'static str> {
        let db = database(home)?;
        match crate::story_registry::require_active_run(&self.owner, &self.city, &self.story, &self.run, &db) {
            Ok(()) => Ok(true),
            Err("story_run_not_active") => Ok(false),
            Err(code) => Err(code),
        }
    }
}

pub(crate) fn status(home: &Path, owner: &str, payload: &Value) -> Result<Value, &'static str> {
    let run = field(payload, "storyRunId")?;
    ActorScope::load(home, owner, run)?;
    let worker = workers().lock().map_err(|_| "creator_store_unavailable")?.get(&(home.to_path_buf(), run.into())).cloned();
    let Some(worker) = worker else {
        let role = host_delivery::managed_actor_role(home, run).map_err(|error| error.code)?;
        return Ok(json!({"state":"idle","characterId":role}));
    };
    let failure = *worker.failure.lock().map_err(|_| "creator_store_unavailable")?;
    let state = if failure.is_some() { "failed" }
        else if worker.done.load(Ordering::Acquire) { "idle" }
        else if worker.cancel.load(Ordering::Relaxed) { "stopping" }
        else if worker.ready.load(Ordering::Acquire) { "ready" } else { "connecting" };
    Ok(json!({"state":state,"code":failure,"characterId":worker.character_id,"agentId":worker.agent_id}))
}

pub(crate) fn cancel(home: &Path, run: &str) {
    if let Ok(registry) = workers().lock() {
        if let Some(worker) = registry.get(&(home.to_path_buf(),run.into())) {
            worker.cancel.store(true, Ordering::Release);
        }
    }
}

pub(crate) fn stop(home: &Path, owner: &str, payload: &Value) -> Result<Value, &'static str> {
    let run = field(payload, "storyRunId")?;
    ActorScope::load(home, owner, run)?;
    cancel(home, run);
    status(home, owner, payload)
}

pub(crate) fn start(home: &Path, owner: &str, payload: &Value) -> Result<Value, &'static str> {
    let run = field(payload, "storyRunId")?;
    let role = field(payload, "characterId")?;
    let agent = field(payload, "agentId")?;
    let scope = ActorScope::load(home, owner, run)?;
    let entry = acp_registry(home).into_iter().find(|entry| entry.id == agent && !entry.program.is_empty()).ok_or("acp_unavailable")?;
    let db = database(home)?;
    let package_digest = crate::story_registry::pinned_run_digest(&db, owner, &scope.city, &scope.story, run)?;
    let raw: String = db.query_row("SELECT canon_json FROM story_installations WHERE city_id=?1 AND story_id=?2 AND content_digest=?3 AND status='installed'",
        params![scope.city,scope.story,package_digest], |row| row.get(0))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("story_release_unavailable")?;
    let canon: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_corrupt")?;
    let character = canon["characters"].as_array().into_iter().flatten()
        .find(|entry| entry["characterId"] == role || entry["id"] == role).ok_or("story_canon_character_missing")?;
    let card = json!({"name":character["displayName"].as_str().or(character["name"].as_str()).unwrap_or(role),
        "backstory":character["backstory"].as_str().unwrap_or("").chars().take(2048).collect::<String>()});

    let key = (home.to_path_buf(), run.to_owned());
    let mut registry = workers().lock().map_err(|_| "creator_store_unavailable")?;
    if registry.get(&key).is_some_and(|worker| !worker.done.load(Ordering::Acquire)) { return Err("actor_session_busy"); }
    if registry.values().filter(|worker| !worker.done.load(Ordering::Acquire)).count() >= 4 {
        return Err("actor_session_limit");
    }
    if host_delivery::managed_actor_role(home, run).map_err(|error| error.code)?
        .is_some_and(|bound| bound != role) {
        return Err("actor_role_already_bound");
    }
    // Stable for reconnects, distinct across Story Runs and characters.
    let session = format!("managed-{}", &digest(&format!("{run}:{role}"))[7..39]);
    let registered = crate::actor_adapter::register_with_canon(home, &json!({
        "storyId":scope.story,"characterId":role,"sessionIdentifier":session,
        "allowedKinds":["speak"],"maxIntentsPerWindow":60,"operationId":session,
    }), Some(&canon))?;
    let actor = field(&registered, "actorId")?.to_owned();
    host_delivery::bind_managed_actor(home, &actor, run, role).map_err(|error| error.code)?;
    let worker = Arc::new(Worker { character_id:role.to_owned(),agent_id:agent.to_owned(), ..Worker::default() });
    let state = worker.clone();
    let home = home.to_path_buf();
    std::thread::Builder::new().name("story-actor".into()).spawn(move || {
        let outcome = AcpAgentExecutor::run_actor_session(entry, &state.cancel, |prompt| {
            let mut first_turn = true;
            let mut prompt_turn = |input: Value| {
                let text = if first_turn {
                    format!("你是故事中的 Actor。保持角色口吻和同一会话内的连续性。每轮结合此前对话判断玩家的意图、可信度和当前关系，比较 eligibleEdges 中的选项，选择最符合角色立场的一条。意图不明时可以选追问或观望，受到施压时可以拒绝（以当轮选项为准）。不要用关键词直接决定路线。对白只写角色会说的话，并与选中的剧情边一致。只输出 JSON 对象 {{\"edgeId\":\"...\",\"dialogue\":\"...\"}}。\n角色卡：{card}\n{input}")
                } else {
                    input.to_string()
                };
                let reply = prompt(text)?;
                first_turn = false;
                Ok(reply)
            };
            state.ready.store(true, Ordering::Release);
            while !state.cancel.load(Ordering::Acquire) && scope.active(&home).map_err(worker_error)? {
                let claims = host_delivery::claim_wait(&home, &json!({"sessionIdentifier":session,"timeoutMs":500,"maxRows":1}))?;
                let delivery = &claims["deliveries"][0];
                let Some(delivery_id) = delivery["deliveryId"].as_str() else { continue; };
                let result = play_turn(&home, &scope, &actor, &session, delivery, &mut prompt_turn, &state.cancel);
                if result.is_err() {
                    let _ = host_delivery::release_managed_turn(&home, &actor, delivery_id);
                    result?;
                }
            }
            Ok(())
        });
        if !state.cancel.load(Ordering::Acquire) {
            if let Err(error) = outcome {
                if let Ok(mut failure) = state.failure.lock() { *failure = Some(error.code); }
            }
        }
        state.done.store(true, Ordering::Release);
    }).map_err(|_| "acp_unavailable")?;
    registry.retain(|_, worker| !worker.done.load(Ordering::Acquire));
    registry.insert(key, worker);
    Ok(json!({"state":"connecting","characterId":role,"agentId":agent}))
}

fn worker_error(code: &'static str) -> ToolError {
    ToolError::new(code, "Managed Actor operation failed.")
}

fn play_turn(home: &Path, scope: &ActorScope, actor: &str, session: &str, delivery: &Value,
    prompt: &mut dyn FnMut(Value) -> Result<String, ToolError>, cancelled: &AtomicBool,
) -> Result<(), ToolError> {
    let delivery_id = field(delivery,"deliveryId").map_err(worker_error)?;
    let target = &delivery["payload"];
    if target["storyRunId"] != scope.run || target["storyId"] != scope.story
        || target["cityId"] != scope.city || target["playerId"] != scope.owner {
        return Err(worker_error("story_run_mismatch"));
    }
    let event_id = field(target,"eventId").map_err(worker_error)?;
    let db = database(home).map_err(worker_error)?;
    let line: String = db.query_row(
        "SELECT json_extract(intent_json,'$.text') FROM story_events
         WHERE event_id=?1 AND player_id=?2 AND city_id=?3 AND story_id=?4 AND story_run_id=?5 AND json_extract(intent_json,'$.kind')='speak'",
        params![event_id,scope.owner,scope.city,scope.story,scope.run], |row| row.get(0),
    ).optional().map_err(|_| worker_error("creator_store_unavailable"))?.ok_or_else(|| worker_error("actor_turn_unavailable"))?;
    drop(db);
    let context = crate::actor_adapter::turn_context(home, &json!({"actorId":actor,
        "scope":{"playerId":scope.owner,"storyRunId":scope.run}})).map_err(worker_error)?;
    let edges = context["evaluatedEdges"].as_array().map(Vec::as_slice).unwrap_or_default();
    let edges = &edges[..edges.len().min(32)];
    if edges.is_empty() { return Err(worker_error("actor_no_eligible_edge")); }
    if cancelled.load(Ordering::Acquire) { return Err(worker_error("acp_cancelled")); }
    let text = prompt(json!({"playerDialogue":line.chars().take(500).collect::<String>(),"eligibleEdges":edges}))?;
    let text = text.trim();
    let body = text.strip_prefix("```json").or_else(|| text.strip_prefix("```")).unwrap_or(text).trim();
    let body = body.strip_suffix("```").unwrap_or(body).trim();
    let reply: Value = serde_json::from_str(body).map_err(|_| worker_error("acp_output_invalid"))?;
    let edge = reply["edgeId"].as_str().filter(|id| edges.iter().any(|option| option["edgeId"].as_str() == Some(*id)))
        .ok_or_else(|| worker_error("acp_output_invalid"))?;
    let dialogue = reply["dialogue"].as_str().filter(|text| !text.trim().is_empty() && text.chars().count() <= 2_000)
        .ok_or_else(|| worker_error("acp_output_invalid"))?;
    if cancelled.load(Ordering::Acquire) { return Err(worker_error("acp_cancelled")); }
    let receipt = crate::actor_turn::propose(home, &json!({"actorId":actor,"deliveryId":delivery_id,
        "proposal":{"operationId":format!("actor-{delivery_id}"),"edgeId":edge,"dialogue":dialogue}})).map_err(worker_error)?;
    if !matches!(receipt["turnStatus"].as_str(), Some("confirmed" | "already_confirmed")) {
        return Err(worker_error("actor_proposal_rejected"));
    }
    host_delivery::confirm_turn(home, &json!({"sessionIdentifier":session,"deliveryId":delivery_id,
        "reply":{"eventId":receipt["committedEventIds"][0],"storyRunId":scope.run}}))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn managed_actor_reuses_acp_sessions_and_commits_distinct_story_routes() {
        let home = std::env::temp_dir().join(crate::creator_store::new_id("story-actor-test").unwrap());
        std::fs::create_dir_all(&home).unwrap();
        let actor_stub = home.join("actor.py");
        std::fs::write(&actor_stub, r#"
import json, sys
turn = 0
previous_edge = None
for line in sys.stdin:
    msg = json.loads(line)
    method = msg["method"]
    if method == "initialize":
        result = {"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}
    elif method == "session/new":
        assert msg["params"]["mcpServers"] == []
        result = {"sessionId":"actor-session","modes":{"currentModeId":"read-only","availableModes":[{"id":"read-only"}]}}
    elif method == "session/prompt":
        assert msg["params"]["sessionId"] == "actor-session"
        prompt = msg["params"]["prompt"][0]["text"]
        if turn == 0:
            assert "角色卡：" in prompt and "小夏" in prompt and "只输出 JSON" in prompt
            turn_input = json.loads(prompt.rsplit("\n", 1)[1])
        else:
            turn_input = json.loads(prompt)
        assert set(turn_input) == {"playerDialogue", "eligibleEdges"}
        options = turn_input["eligibleEdges"]
        assert all(option["title"] and option["description"] for option in options)
        player = turn_input["playerDialogue"]
        if previous_edge == "e-invite":
            expected = {"e-find-clue", "e-protect-clue", "e-back-off"}
            edge, dialogue = "e-find-clue", "画家去了老灯塔。"
        elif previous_edge == "e-verify-intent":
            expected = {"e-verify-share", "e-verify-protect", "e-verify-decline"}
            edge, dialogue = "e-verify-protect", "你可以先去看看我店里的旧画签。"
        else:
            expected = {"e-invite", "e-verify-intent", "e-decline"}
            if "公开" in player:
                edge, dialogue = "e-decline", "我不会告诉你他的去向。"
            elif "咖啡馆" in player:
                edge, dialogue = "e-invite", "好啊，去咖啡馆吧。"
            else:
                edge, dialogue = "e-verify-intent", "你为什么想找他？"
        assert {option["edgeId"] for option in options} == expected
        previous_edge = edge
        assert "storyRunId" not in prompt and "playerId" not in prompt
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"actor-session","update":{
            "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":json.dumps({"edgeId":edge,"dialogue":dialogue})}}}}),flush=True)
        turn += 1
        result = {"stopReason":"end_turn"}
    else:
        continue
    print(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":result}),flush=True)
"#).unwrap();
        let live = std::env::var("OH_STORY_TEST_MANAGED_ACP").ok();
        let agent = if let Some(command) = &live {
            json!({"id":"test-actor","name":"Test Actor","command":command,"args":[]})
        } else {
            json!({"id":"test-actor","name":"Test Actor","command":"python3","args":[actor_stub]})
        };
        std::fs::write(home.join("acp-agents.json"), json!({"agents":[agent]}).to_string()).unwrap();
        let owner = crate::creator_projects::LOCAL_CREATOR_OWNER;
        let studio = |method: &str, payload: Value| crate::creator_projects::dispatch_as(&home, owner, "studio-test", method, &payload);
        let city = |method: &str, payload: Value| crate::creator_projects::dispatch_city_runtime(&home, "city-test", method, &payload);
        let story: Value = serde_json::from_str(include_str!("../tests/fixtures/story-missing-painter-synthetic.json")).unwrap();
        studio("creator.story.project.create", story).unwrap();
        let profile = json!({"schemaVersion":1,"id":"desert","version":1,"biome":"arid",
            "geography":{"generator":"arid-dunes-v1","parameters":{"dunes":{"duneScale":190,"duneAmplitude":11,"orientationDeg":18}}},
            "visuals":{"themeId":"desert"}});
        let city_created = crate::creator_cities::create_city(&home, owner, "managed-city","测试 City",22,&profile).unwrap();
        let city_id = &city_created["cityId"];
        let install = studio("creator.story.install.preview", json!({"storyId":"story.detective",
            "targetCityId":city_id,"expectedCityRevision":city_created["revision"],"operationId":"managed-install-preview"})).unwrap();
        studio("creator.story.install.commit", json!({"previewId":install["previewId"],"operationId":"managed-install"})).unwrap();
        let story_run = studio("creator.story.run.start", json!({"cityId":city_id,"storyId":"story.detective"})).unwrap();
        let game = city("city.game.run.start", json!({"cityId":city_id,"gameId":"story.detective","storyRunId":story_run["storyRunId"]})).unwrap();
        let mut run = json!({"runId":game["runId"],"storyRunId":story_run["storyRunId"]});
        let routes: &[&[(&str, &str)]] = &[
            &[("小夏，一起去咖啡馆坐坐吧？","cafe_reply"),
              ("他失踪前，你在柜台旁看着他把一封没寄出的信交给我，里面夹着半张蓝色船票。信还在我这里。我只想确认他平安，会替他保密。你知道他去了哪里吗？","ending")],
            &[("听说那位画家失踪了，你知道他去了哪里吗？","verify"),
              ("我只是看过他的画，很担心，但我不认识他，也没有可以证明来意的东西。有别的线索可以核实吗？","leads")],
            &[("把画家的地址给我，我要公开他的行踪。你不告诉我，我就去你店里闹。","refused")],
        ];
        for (route, turns) in routes.iter().enumerate() {
            let run_id = &run["runId"];
            let story_run_id = &run["storyRunId"];
            let authority = json!({"storyRunId":story_run_id});
            assert_eq!(status(&home, "another-owner", &authority).unwrap_err(), "story_run_not_found");
            let response = studio("creator.story.actor.start", json!({"storyRunId":story_run_id,"characterId":"resident:linxia","agentId":"test-actor"})).unwrap();
            assert_eq!(response["state"],"connecting");
            let deadline = Instant::now() + Duration::from_secs(if live.is_some() { 90 } else { 10 });
            let wait_for = |ready: &dyn Fn() -> bool| {
                while !ready() {
                    let state = studio("creator.story.actor.status", authority.clone()).unwrap();
                    assert_ne!(state["state"],"failed","{state}");
                    assert!(Instant::now() < deadline, "{state}");
                    std::thread::sleep(Duration::from_millis(50));
                }
            };
            wait_for(&|| studio("creator.story.actor.status",authority.clone()).unwrap()["state"] == "ready");
            let snapshot = || city("city.story.run.read", json!({"runId":run_id})).unwrap();
            for (index, (line, beat)) in turns.iter().enumerate() {
                let clock = city("city.time.read",json!({"cityId":city_id})).unwrap();
                let event = format!("managed-event-{route}-{index}");
                city("city.story.commit", json!({"runId":run_id,
                    "operationId":format!("managed-op-{route}-{index}"),"eventId":event,
                    "expectedStoryRevision":snapshot()["storyRevision"],"expectedClockRevision":clock["clockRevision"],
                    "residentId":"resident:linxia","intent":{"kind":"speak","residentId":"resident:linxia","text":line}})).unwrap();
                wait_for(&|| snapshot()["dialogue"].as_array().unwrap().iter().any(|entry| entry["replyToEventId"] == event));
                let result = snapshot();
                assert_eq!(result["state"]["cursor"], *beat, "{result}");
                let reply = result["dialogue"].as_array().unwrap().iter().find(|entry| entry["replyToEventId"] == event).unwrap();
                let matches_clue = reply["intent"]["text"].as_str().unwrap().contains("灯塔");
                assert_eq!(matches_clue, *beat == "ending", "{reply}");
                eprintln!("Actor route {route}, turn {index}, beat {beat}: {}", reply["intent"]["text"]);
            }
            let ending = snapshot();
            assert_eq!(ending["dialogue"].as_array().unwrap().len(), turns.len() * 2);
            assert_eq!(ending["state"]["clue_found"] == true, route == 0);
            let action = if route + 1 < routes.len() { "restart" } else { "finish" };
            let completed = city("city.story.playtest.complete", json!({"runId":run_id,"action":action})).unwrap();
            wait_for(&|| studio("creator.story.actor.status",authority.clone()).unwrap()["state"] == "idle");
            run = completed;
        }
        std::fs::remove_dir_all(home).ok();
    }
}
