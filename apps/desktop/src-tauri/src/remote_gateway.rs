use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, watch};
use crate::mecha_remote_adapter::{validate_request, validate_host_message, supports_sequential, validate_sequential_request, validate_sequential_host_message};
use crate::remote_transport::{self, RelayConnection};
use crate::remote_sessions::{SessionKey, SessionStore};

#[path = "remote_gateway_projection.rs"]
mod projection;

const SESSION_VIEW: &str = "mecha-remote-session";
const PROTOCOL: &str = "mecha-net:v1";
#[cfg(test)]
const METHODS: [&str; 4] = ["match.snapshot", "plan.submit", "match.concede", "match.close"];

struct Active {
    relay: String,
    room_id: String,
    match_id: String,
    capability: crate::remote_protocol::RemoteCapability,
    owner_token: String,
    session_token: String,
    outbox: mpsc::Sender<String>,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct State { active: SessionStore<Active>, starting_token: Option<String> }

// A single shared slot prevents v1, v2 and v3 sessions from being started concurrently.
fn session_key() -> SessionKey { SessionKey::new("city", "mecha:v1") }

pub struct RemoteGateway {
    state: Mutex<State>,
    operation: tokio::sync::Mutex<()>,
    ready: watch::Sender<bool>,
    created: watch::Sender<bool>,
    joined: watch::Sender<Option<bool>>,
}

impl Default for RemoteGateway {
    fn default() -> Self {
        let (ready, _) = watch::channel(false);
        let (created, _) = watch::channel(false);
        let (joined, _) = watch::channel(None);
        Self { state: Mutex::new(State::default()), operation: tokio::sync::Mutex::new(()), ready, created, joined }
    }
}

fn secret() -> Result<String, &'static str> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "remote_unavailable")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

fn valid_relay(value: &str) -> bool {
    reqwest::Url::parse(value).ok().is_some_and(|url| url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none())
}

fn relay_connection(active: &Active) -> RelayConnection {
    RelayConnection { relay: active.relay.clone(), room_id: active.room_id.clone(), owner_token: active.owner_token.clone() }
}

fn endpoint(active: &Active, operation: &str) -> String { relay_connection(active).endpoint(operation) }

async fn post(active: &Active, operation: &str, body: Value) -> Result<Value, &'static str> {
    relay_connection(active).post(operation, body).await
}

fn remote_link(active: &Active, ticket: &str, player: &str) -> Result<String, &'static str> {
    let mut url = reqwest::Url::parse(&format!("{}/remote", active.relay.trim_end_matches('/'))).map_err(|_| "remote_url_invalid")?;
    url.query_pairs_mut().append_pair("match", &active.match_id).append_pair("player", player)
        .append_pair("ws", &relay_connection(active).ws_endpoint(ticket)?);
    if matches!(active.capability.id.as_str(), "mecha:v2" | "mecha:v3") { url.query_pairs_mut().append_pair("capability", &active.capability.id); }
    Ok(url.into())
}

fn invitation_link(active: &Active, invite_id: &str, invite_secret: &str) -> Result<String, &'static str> {
    let mut url = reqwest::Url::parse(&format!("{}/remote", active.relay.trim_end_matches('/'))).map_err(|_| "remote_url_invalid")?;
    url.query_pairs_mut().append_pair("match", &active.match_id).append_pair("room", &active.room_id).append_pair("invite", invite_id);
    if matches!(active.capability.id.as_str(), "mecha:v2" | "mecha:v3") { url.query_pairs_mut().append_pair("capability", &active.capability.id); }
    url.set_fragment(Some(invite_secret));
    Ok(url.into())
}

async fn create_session(app: &tauri::AppHandle, token: &str) -> Result<(), &'static str> {
    if let Some(view) = app.get_webview_window(SESSION_VIEW) { let _ = view.close(); }
    let script = format!("window.__AV_MECHA_SESSION_TOKEN__={};", serde_json::to_string(token).map_err(|_| "remote_unavailable")?);
    tauri::WebviewWindowBuilder::new(app, SESSION_VIEW, tauri::WebviewUrl::App("plugins/AgentCity.plugin/ui/remote.html?sessionHost=1".into()))
        .title("Agent City MatchSession").visible(false).focused(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(&script)
        .build().map_err(|_| "remote_session_unavailable")?;
    Ok(())
}

fn eval_session(app: &tauri::AppHandle, active: &Active, request: &Value) -> Result<(), &'static str> {
    let detail = serde_json::to_string(&json!({"token":active.session_token,"request":request})).map_err(|_| "remote_unavailable")?;
    app.get_webview_window(SESSION_VIEW).ok_or("remote_session_unavailable")?
        .eval(format!("window.dispatchEvent(new CustomEvent('__AV_MECHA_REMOTE_REQUEST__',{{detail:{detail}}}));"))
        .map_err(|_| "remote_session_unavailable")
}

// Deployment needs authenticated session binding and a strict payload projection.
fn validate_staged_deployment_request(value: &Value, match_id: &str, capability: &crate::remote_protocol::RemoteCapability) -> Result<(), &'static str> {
    crate::mecha_remote_adapter::validate_deployment_request(value, match_id, capability)?;
    if value["method"] != "deployment.submit" || !projection::valid_submit_deployment(&value["payload"]) { return Err("invalid_message"); }
    Ok(())
}

fn validate_routed_request(value: &Value, match_id: &str, capability: &crate::remote_protocol::RemoteCapability) -> Result<(), &'static str> {
    if crate::mecha_remote_adapter::supports(capability) {
        validate_request(value, match_id, capability)?;
    } else if crate::mecha_remote_adapter::supports_deployment(capability) {
        if value["method"] == "deployment.submit" {
            return validate_staged_deployment_request(value, match_id, capability);
        }
        crate::mecha_remote_adapter::validate_deployment_request(value, match_id, capability)?;
    } else if crate::mecha_remote_adapter::supports_safe_concede(capability) {
        crate::mecha_remote_adapter::validate_safe_request(value, match_id, capability)?;
        if value["method"] == "deployment.submit" && !projection::valid_submit_deployment(&value["payload"]) { return Err("invalid_message"); }
        if value["method"] == "match.concede-v2" && !projection::valid_submit_concede(&value["payload"]) { return Err("invalid_message"); }
    } else if supports_sequential(capability) {
        validate_sequential_request(value, match_id, capability)?;
    } else { return Err("forbidden"); }
    if value["method"] == "plan.submit" && !projection::valid_submit_plan(&value["payload"]) { return Err("invalid_message"); }
    Ok(())
}

fn outbound(active: &Active, mut value: Value) -> Value {
    value["protocol"] = json!(crate::remote_protocol::PROTOCOL);
    value["appId"] = json!("city");
    value["sessionId"] = json!(active.match_id);
    value["capability"] = json!(active.capability.id);
    value
}

fn respond_to_session(_app: &tauri::AppHandle, active: &Active, request: &Value, code: &str) {
    if !request["requestId"].as_str().is_some_and(valid_id) { return; }
    let value = outbound(active, json!({"type":"response","requestId":request["requestId"],"result":{"ok":false,"error":{"code":code}}}));
    if let Ok(text) = serde_json::to_string(&value) { let _ = active.outbox.try_send(text); }
}

async fn run_connection(app: tauri::AppHandle, mut active: Active, ready: watch::Sender<bool>) {
    let (outbox, outgoing) = mpsc::channel::<String>(32);
    active.outbox = outbox.clone();
    {
        let gateway = app.state::<RemoteGateway>();
        let mut state = gateway.state.lock().unwrap();
        if state.active.get_mut(&session_key()).is_some_and(|current| current.match_id == active.match_id) {
            state.active.get_mut(&session_key()).unwrap().outbox = outbox;
        }
    }
    let relay = relay_connection(&active);
    let cancel = active.cancel.subscribe();
    let status_app = app.clone();
    let status_match = active.match_id.clone();
    remote_transport::run(relay, outgoing, cancel, move |value| {
        if value["type"] != "request" { return; }
        if let Err(code) = validate_routed_request(&value, &active.match_id, &active.capability) {
            respond_to_session(&app, &active, &value, code);
            return;
        }
        let request = json!({"protocol":crate::mecha_remote_adapter::session_protocol(&active.capability),"type":"request","requestId":value["requestId"],"method":value["method"],"payload":value["payload"]});
        if eval_session(&app, &active, &request).is_err() {
            respond_to_session(&app, &active, &value, "remote_session_unavailable");
        }
    }, move |status| {
        let _ = status_app.emit("mecha-remote-status", json!({"status":status,"matchId":status_match}));
    }).await;
    drop(ready);
}

async fn start(app: &tauri::AppHandle, capability: &crate::remote_protocol::RemoteCapability, payload: &Value) -> Result<Value, &'static str> {
    let gateway = app.state::<RemoteGateway>();
    let _operation = gateway.operation.lock().await;
    if gateway.state.lock().unwrap().active.get(&session_key()).is_some() { return Err("remote_already_active"); }
    let relay = payload["relay"].as_str().filter(|url| valid_relay(url)).ok_or("remote_url_invalid")?.trim_end_matches('/').to_owned();
    let arena = &payload["arena"];
    let state = &payload["state"];
    if serde_json::to_vec(&json!({"arena":arena,"state":state})).map_err(|_| "remote_match_invalid")?.len() > 256 * 1024 { return Err("remote_match_too_large"); }
    let valid = if crate::mecha_remote_adapter::supports_safe_concede(capability) {
        projection::valid_start_deployment(arena, state) || projection::valid_start(arena, state)
    } else if crate::mecha_remote_adapter::supports_deployment(capability) {
        projection::valid_start_deployment(arena, state)
    } else if crate::mecha_remote_adapter::supports(capability) {
        projection::valid_start(arena, state)
    } else { false };
    if !valid { return Err("remote_match_invalid"); }
    let room_id = secret()?;
    let match_id = secret()?;
    let active = Active {
        relay: relay.clone(), room_id, match_id: match_id.clone(), capability: capability.clone(), owner_token: secret()?, session_token: secret()?,
        outbox: mpsc::channel(1).0, cancel: watch::channel(false).0,
    };
    gateway.ready.send_replace(false);
    gateway.created.send_replace(false);
    gateway.state.lock().unwrap().starting_token = Some(active.session_token.clone());
    let setup: Result<String, &'static str> = async {
        post(&active, "register", json!({"protocol":crate::remote_protocol::PROTOCOL,"appId":"city","sessionId":match_id,"capability":active.capability,"ownerToken":active.owner_token})).await?;
        let mut ready = gateway.ready.subscribe();
        create_session(app, &active.session_token).await?;
        tokio::time::timeout(Duration::from_secs(20), ready.wait_for(|value| *value)).await.map_err(|_| "remote_session_unavailable")?
            .map_err(|_| "remote_session_unavailable")?;
        let mut created = gateway.created.subscribe();
        {
            let view = app.get_webview_window(SESSION_VIEW).ok_or("remote_session_unavailable")?;
            let detail = serde_json::to_string(&json!({"token":active.session_token,"request":{
                "protocol":PROTOCOL,"type":"request","requestId":"create-session","method":"match.create",
                "payload":{"config":{"matchId":match_id,"mode":"pve","arena":arena,"state":state,"players":[{"playerId":"owner","side":"A","role":"host"}]}}
            }})).map_err(|_| "remote_unavailable")?;
            view.eval(format!("window.dispatchEvent(new CustomEvent('__AV_MECHA_REMOTE_REQUEST__',{{detail:{detail}}}));")).map_err(|_| "remote_session_unavailable")?;
        }
        tokio::time::timeout(Duration::from_secs(10), created.wait_for(|value| *value)).await.map_err(|_| "remote_session_unavailable")?
            .map_err(|_| "remote_session_unavailable")?;
        let pair = post(&active, "access", json!({"action":"pair","role":"owner"})).await?;
        let ticket = pair["ticket"].as_str().ok_or("remote_unavailable")?;
        let mut remote_url = reqwest::Url::parse(&remote_link(&active, ticket, "owner")?).map_err(|_| "remote_url_invalid")?;
        let access = endpoint(&active, "access");
        remote_url.query_pairs_mut().append_pair("access", &access)
            .append_pair("device", pair["deviceId"].as_str().ok_or("remote_unavailable")?);
        remote_url.set_fragment(Some(pair["reconnectToken"].as_str().ok_or("remote_unavailable")?));
        Ok(remote_url.into())
    }.await;
    gateway.state.lock().unwrap().starting_token = None;
    let remote_url = match setup {
        Ok(url) => url,
        Err(error) => {
            if let Some(view) = app.get_webview_window(SESSION_VIEW) { let _ = view.close(); }
            let _ = post(&active, "close", json!({})).await;
            return Err(error);
        }
    };
    let ready_sender = gateway.ready.clone();
    let running = Active {
        relay: active.relay.clone(), room_id: active.room_id.clone(), match_id: active.match_id.clone(), capability: active.capability.clone(),
        owner_token: active.owner_token.clone(), session_token: active.session_token.clone(), outbox: active.outbox.clone(), cancel: active.cancel.clone(),
    };
    gateway.state.lock().unwrap().active.insert(session_key(), active)?;
    tauri::async_runtime::spawn(run_connection(app.clone(), running, ready_sender));
    Ok(json!({"ok":true,"matchId":match_id,"remoteUrl":remote_url,"connection":"connecting"}))
}

async fn start_sequential(app: &tauri::AppHandle, capability: &crate::remote_protocol::RemoteCapability, payload: &Value) -> Result<Value, &'static str> {
    let gateway = app.state::<RemoteGateway>();
    let _operation = gateway.operation.lock().await;
    if gateway.state.lock().unwrap().active.get(&session_key()).is_some() { return Err("remote_already_active"); }
    let relay = payload["relay"].as_str().filter(|url| valid_relay(url)).ok_or("remote_url_invalid")?.trim_end_matches('/').to_owned();
    let opening = &payload["opening"];
    if !opening.is_object() || serde_json::to_vec(opening).map_err(|_| "remote_match_invalid")?.len() > 256 * 1024
        || !projection::valid_start_sequential(opening) { return Err("remote_match_invalid"); }
    let room_id = secret()?;
    let match_id = secret()?;
    let active = Active {
        relay: relay.clone(), room_id, match_id: match_id.clone(), capability: capability.clone(), owner_token: secret()?, session_token: secret()?,
        outbox: mpsc::channel(1).0, cancel: watch::channel(false).0,
    };
    gateway.ready.send_replace(false);
    gateway.created.send_replace(false);
    gateway.state.lock().unwrap().starting_token = Some(active.session_token.clone());
    let setup: Result<String, &'static str> = async {
        post(&active, "register", json!({"protocol":crate::remote_protocol::PROTOCOL,"appId":"city","sessionId":match_id,"capability":active.capability,"ownerToken":active.owner_token})).await?;
        let mut ready = gateway.ready.subscribe();
        create_session(app, &active.session_token).await?;
        tokio::time::timeout(Duration::from_secs(20), ready.wait_for(|value| *value)).await.map_err(|_| "remote_session_unavailable")?
            .map_err(|_| "remote_session_unavailable")?;
        let mut created = gateway.created.subscribe();
        {
            let view = app.get_webview_window(SESSION_VIEW).ok_or("remote_session_unavailable")?;
            let detail = serde_json::to_string(&json!({"token":active.session_token,"request":{
                "protocol":crate::mecha_remote_adapter::session_protocol(capability),"type":"request","requestId":"create-session","method":"match.create",
                "payload":{"config":{"matchId":match_id,"ruleset":"mecha-v1.5","initial":opening["initial"],"placements":opening["placements"],"commands":opening["commands"].clone()}}
            }})).map_err(|_| "remote_unavailable")?;
            view.eval(format!("window.dispatchEvent(new CustomEvent('__AV_MECHA_REMOTE_REQUEST__',{{detail:{detail}}}));")).map_err(|_| "remote_session_unavailable")?;
        }
        tokio::time::timeout(Duration::from_secs(10), created.wait_for(|value| *value)).await.map_err(|_| "remote_session_unavailable")?
            .map_err(|_| "remote_session_unavailable")?;
        let pair = post(&active, "access", json!({"action":"pair","role":"owner"})).await?;
        let ticket = pair["ticket"].as_str().ok_or("remote_unavailable")?;
        let mut remote_url = reqwest::Url::parse(&remote_link(&active, ticket, "owner")?).map_err(|_| "remote_url_invalid")?;
        let access = endpoint(&active, "access");
        remote_url.query_pairs_mut().append_pair("access", &access)
            .append_pair("device", pair["deviceId"].as_str().ok_or("remote_unavailable")?);
        remote_url.set_fragment(Some(pair["reconnectToken"].as_str().ok_or("remote_unavailable")?));
        Ok(remote_url.into())
    }.await;
    gateway.state.lock().unwrap().starting_token = None;
    let remote_url = match setup {
        Ok(url) => url,
        Err(error) => {
            if let Some(view) = app.get_webview_window(SESSION_VIEW) { let _ = view.close(); }
            let _ = post(&active, "close", json!({})).await;
            return Err(error);
        }
    };
    let ready_sender = gateway.ready.clone();
    let running = Active {
        relay: active.relay.clone(), room_id: active.room_id.clone(), match_id: active.match_id.clone(), capability: active.capability.clone(),
        owner_token: active.owner_token.clone(), session_token: active.session_token.clone(), outbox: active.outbox.clone(), cancel: active.cancel.clone(),
    };
    gateway.state.lock().unwrap().active.insert(session_key(), active)?;
    tauri::async_runtime::spawn(run_connection(app.clone(), running, ready_sender));
    Ok(json!({"ok":true,"matchId":match_id,"remoteUrl":remote_url,"connection":"connecting"}))
}

async fn control(app: &tauri::AppHandle, payload: &Value, action: &str) -> Result<Value, &'static str> {
    let gateway = app.state::<RemoteGateway>();
    let _operation = gateway.operation.lock().await;
    let active = {
        let state = gateway.state.lock().unwrap();
        state.active.get(&session_key()).map(|active| Active {
            relay: active.relay.clone(), room_id: active.room_id.clone(), match_id: active.match_id.clone(), capability: active.capability.clone(),
            owner_token: active.owner_token.clone(), session_token: active.session_token.clone(), outbox: active.outbox.clone(), cancel: active.cancel.clone(),
        })
    }.ok_or("remote_not_active")?;
    match action {
        "invite" => {
            let result = post(&active, "access", json!({"action":"invite"})).await?;
            let invite_id = result["inviteId"].as_str().ok_or("remote_unavailable")?;
            let invite_secret = result["inviteSecret"].as_str().ok_or("remote_unavailable")?;
            let url = invitation_link(&active, invite_id, invite_secret)?;
            Ok(json!({"ok":true,"inviteUrl":url,"expiresIn":600}))
        }
        "approve" | "revoke" => {
            let device_id = payload["deviceId"].as_str().filter(|id| valid_id(id)).ok_or("invalid_request")?;
            if action == "approve" {
                let pending = post(&active, "access", json!({"action":"pending"})).await?;
                if !pending["pending"].as_array().is_some_and(|items| items.iter().any(|item| item["deviceId"] == device_id)) { return Err("remote_invite_unavailable"); }
                gateway.joined.send_replace(None);
                let mut joined = gateway.joined.subscribe();
                let request = json!({"protocol":PROTOCOL,"type":"request","requestId":"join-session","method":"match.join","payload":{"matchId":active.match_id,"playerId":"guest"}});
                eval_session(app, &active, &request)?;
                let outcome = tokio::time::timeout(Duration::from_secs(10), joined.wait_for(|value| value.is_some())).await
                    .map_err(|_| "remote_session_unavailable")?.map_err(|_| "remote_session_unavailable")?;
                if *outcome != Some(true) { return Err("remote_match_invalid"); }
            }
            post(&active, "access", json!({"action":action,"deviceId":device_id})).await
        }
        "pending" => post(&active, "access", json!({"action":"pending"})).await,
        _ => Err("invalid_request"),
    }
}

pub async fn control_for_city(app: &tauri::AppHandle, plugin_id: &str, capability: &crate::remote_protocol::RemoteCapability, method: &str, payload: &Value) -> Result<Value, &'static str> {
    if plugin_id != "city" { return Err("remote_forbidden"); }
    let authorized = match method {
        "mecha.remote.start-deployment" => crate::mecha_remote_adapter::supports_deployment(capability),
        "mecha.remote.start-v3" => crate::mecha_remote_adapter::supports_safe_concede(capability),
        "mecha.remote.start-sequential" => crate::mecha_remote_adapter::supports_sequential(capability),
        "mecha.remote.stop" => crate::mecha_remote_adapter::supports_stop(capability),
        _ => crate::mecha_remote_adapter::supports(capability),
    };
    if !authorized { return Err("remote_forbidden"); }
    match method {
        "mecha.remote.start" | "mecha.remote.start-deployment" | "mecha.remote.start-v3" => start(app, capability, payload).await,
        "mecha.remote.start-sequential" => start_sequential(app, capability, payload).await,
        "mecha.remote.invite" => control(app, payload, "invite").await,
        "mecha.remote.approve" => control(app, payload, "approve").await,
        "mecha.remote.revoke" => control(app, payload, "revoke").await,
        "mecha.remote.pending" => control(app, payload, "pending").await,
        "mecha.remote.stop" => {
            let gateway = app.state::<RemoteGateway>();
            let _operation = gateway.operation.lock().await;
            let active = gateway.state.lock().unwrap().active.remove(&session_key());
            if let Some(active) = active {
                active.cancel.send_replace(true);
                let _ = post(&active, "close", json!({})).await;
            }
            if let Some(view) = app.get_webview_window(SESSION_VIEW) { let _ = view.close(); }
            Ok(json!({"ok":true}))
        }
        _ => Err("invalid_request"),
    }
}

#[tauri::command]
pub fn remote_mecha_message(app: tauri::AppHandle, webview: tauri::WebviewWindow, reply: Value) -> Result<(), String> {
    if webview.label() != SESSION_VIEW { return Err("remote_forbidden".into()); }
    let gateway = app.state::<RemoteGateway>();
    let state = gateway.state.lock().unwrap();
    if reply["type"] == "ready" || reply["type"] == "created" {
        if !state.starting_token.as_deref().is_some_and(|token| reply["token"].as_str() == Some(token)) { return Err("remote_forbidden".into()); }
        if reply["type"] == "ready" { gateway.ready.send_replace(true); } else { gateway.created.send_replace(true); }
        return Ok(());
    }
    let active = state.active.get(&session_key()).ok_or("remote_not_active")?;
    if reply["token"] != active.session_token { return Err("remote_forbidden".into()); }
    if reply["type"] == "joined" {
        let ok = reply["ok"].as_bool().ok_or("invalid_message")?;
        gateway.joined.send_replace(Some(ok));
        return Ok(());
    }
    if reply["type"] != "message" { return Err("invalid_message".into()); }
    let message = &reply["message"];
    if supports_sequential(&active.capability) {
        if !validate_sequential_host_message(message, &active.match_id) { return Err("invalid_message".into()); }
    } else if !validate_host_message(message, &active.match_id, &active.capability) { return Err("invalid_message".into()); }
    let text = serde_json::to_string(&outbound(active, message.clone())).map_err(|_| "invalid_message")?;
    if text.len() > 256 * 1024 { return Err("message_too_large".into()); }
    let valid = if supports_sequential(&active.capability) { true } else if crate::mecha_remote_adapter::supports_deployment(&active.capability) || crate::mecha_remote_adapter::supports_safe_concede(&active.capability) {
        projection::valid_outbound_with_deployment(message, &active.match_id)
    } else { projection::valid_outbound(message, &active.match_id) };
    if !valid { return Err("invalid_message".into()); }
    active.outbox.try_send(text).map_err(|_| "remote_backpressure")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_match_requests_reach_the_session() {
        let mut request = json!({"protocol":crate::remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v1","type":"request","requestId":"r1","method":"match.snapshot","peer":{"role":"owner","playerId":"owner"},"payload":{"matchId":"m1","playerId":"owner"}});
        let capability = crate::remote_protocol::RemoteCapability { id: "mecha:v1".into(), methods: METHODS.iter().map(|item| (*item).into()).collect(), events: vec![] };
        assert_eq!(validate_request(&request, "m1", &capability), Ok(()));
        assert_eq!(validate_request(&request, "other", &capability), Err("forbidden"));
        request["method"] = json!("plugin_request");
        assert_eq!(validate_request(&request, "m1", &capability), Err("forbidden"));
    }

    #[test]
    fn outbound_messages_cannot_cross_matches_or_skip_the_protocol() {
        let response = json!({"protocol":PROTOCOL,"type":"response","requestId":"r1","result":{"ok":true}});
        let capability = crate::remote_protocol::RemoteCapability { id: "mecha:v1".into(), methods: vec![], events: vec!["match.closed".into()] };
        assert!(validate_host_message(&response, "m1", &capability));
        assert!(!validate_host_message(&json!({"type":"response","requestId":"r1"}), "m1", &capability));
        assert!(!validate_host_message(&json!({"protocol":PROTOCOL,"type":"event","event":{"type":"match.closed","matchId":"other"}}), "m1", &capability));
    }

    #[test]
    fn only_public_https_relays_are_accepted() {
        assert!(valid_relay("https://relay.example.com"));
        assert!(!valid_relay("http://localhost:8787"));
        assert!(!valid_relay("https://user:secret@example.com"));
        assert!(!valid_relay("file:///tmp/city"));
    }
    #[test]
    fn staged_deployment_requires_both_peer_binding_and_strict_projection() {
        let capability = crate::remote_protocol::RemoteCapability {
            id: "mecha:v2".into(),
            methods: ["match.snapshot", "deployment.submit", "plan.submit", "match.concede", "match.close"].iter().map(|item| (*item).into()).collect(),
            events: ["match.closed", "match.replaced", "turn.resolved"].iter().map(|item| (*item).into()).collect(),
        };
        let request = json!({"protocol":crate::remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v2","type":"request","requestId":"r1","method":"deployment.submit","peer":{"role":"owner","playerId":"owner"},"payload":{"type":"deployment.submit","protocol":PROTOCOL,"matchId":"m1","playerId":"owner","commandId":"d1","baseRevision":0,"plan":{"revision":0,"placements":[{"mechId":"Assault","pos":{"x":1,"y":8}},{"mechId":"Gunner","pos":{"x":2,"y":8}},{"mechId":"Support","pos":{"x":3,"y":8}}]}}});
        assert_eq!(validate_staged_deployment_request(&request, "m1", &capability), Ok(()));
        assert_eq!(validate_request(&request, "m1", &capability), Err("invalid_message"), "the v1 adapter stays closed");
        assert_eq!(validate_routed_request(&request, "m1", &capability), Ok(()));
        let mut forged = request.clone(); forged["peer"] = json!({"role":"guest","playerId":"guest"});
        assert_eq!(validate_staged_deployment_request(&forged, "m1", &capability), Err("forbidden"));
        assert_eq!(validate_routed_request(&forged, "m1", &capability), Err("forbidden"));
        let mut foreign = request.clone(); foreign["payload"]["matchId"] = json!("m2");
        assert_eq!(validate_staged_deployment_request(&foreign, "m1", &capability), Err("forbidden"));
        let mut private = request.clone(); private["payload"]["plan"]["placements"][0]["pos"]["secret"] = json!("private");
        assert_eq!(validate_staged_deployment_request(&private, "m1", &capability), Err("invalid_message"));
        assert_eq!(validate_routed_request(&private, "m1", &capability), Err("invalid_message"));
        let mut wrong_method = request.clone(); wrong_method["method"] = json!("match.snapshot");
        assert_eq!(validate_staged_deployment_request(&wrong_method, "m1", &capability), Err("invalid_message"));
        assert_eq!(validate_routed_request(&wrong_method, "m1", &capability), Ok(()));
        let mut legacy = capability.clone(); legacy.id = "mecha:v1".into(); legacy.methods.retain(|m| m != "deployment.submit");
        let mut legacy_request = request.clone(); legacy_request["capability"] = json!("mecha:v1");
        assert_eq!(validate_routed_request(&legacy_request, "m1", &legacy), Err("forbidden"));
        let mut widened = capability.clone(); widened.methods.push("plugin_request".into());
        assert_eq!(validate_routed_request(&request, "m1", &widened), Err("forbidden"));
        let mut bad_plan = wrong_method; bad_plan["method"] = json!("plan.submit");
        assert_eq!(validate_routed_request(&bad_plan, "m1", &capability), Err("invalid_message"));
    }

    #[test]
    fn links_preserve_legacy_v1_and_explicitly_identify_v2() {
        for (id, expected) in [("mecha:v1", None), ("mecha:v2", Some("mecha:v2")), ("mecha:v3", Some("mecha:v3"))] {
            let active = Active {
                relay: "https://relay.example.com".into(), room_id: "room1".into(), match_id: "match1".into(),
                capability: crate::remote_protocol::RemoteCapability { id: id.into(), methods: vec![], events: vec![] },
                owner_token: "owner-secret".into(), session_token: "host-secret".into(),
                outbox: mpsc::channel(1).0, cancel: watch::channel(false).0,
            };
            let owner = reqwest::Url::parse(&remote_link(&active, "ticket1", "owner").unwrap()).unwrap();
            let invite = reqwest::Url::parse(&invitation_link(&active, "invite1", "invite-secret").unwrap()).unwrap();
            for url in [&owner, &invite] {
                let pairs: Vec<_> = url.query_pairs().collect();
                assert_eq!(pairs.iter().find(|(key, _)| key == "capability").map(|(_, value)| value.as_ref()), expected);
                assert!(pairs.iter().any(|(key, value)| key == "match" && value == "match1"));
                assert!(!url.as_str().contains("owner-secret") && !url.as_str().contains("host-secret"));
            }
            assert_eq!(invite.fragment(), Some("invite-secret"));
            assert!(owner.fragment().is_none());
        }
    }

    #[test]
    fn safe_concede_requires_exact_projection_peer_and_capability() {
        let capability = crate::remote_protocol::RemoteCapability {
            id: "mecha:v3".into(),
            methods: ["match.snapshot", "deployment.submit", "plan.submit", "match.concede-v2", "match.close"].iter().map(|s| (*s).into()).collect(),
            events: ["match.closed", "match.replaced", "turn.resolved"].iter().map(|s| (*s).into()).collect(),
        };
        let request = json!({"protocol":crate::remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v3","type":"request","requestId":"r1","method":"match.concede-v2","peer":{"role":"guest","playerId":"guest"},"payload":{"type":"match.concede-v2","protocol":PROTOCOL,"matchId":"m1","playerId":"guest","commandId":"c1","baseRevision":3}});
        assert_eq!(validate_routed_request(&request, "m1", &capability), Ok(()));
        for (path, value, expected) in [
            ("/payload/playerId", json!("owner"), "forbidden"),
            ("/payload/matchId", json!("m2"), "forbidden"),
            ("/method", json!("match.concede"), "forbidden"),
            ("/payload/baseRevision", json!(9007199254740992_u64), "invalid_message"),
            ("/payload/type", json!("match.concede"), "invalid_message"),
        ] {
            let mut invalid = request.clone(); *invalid.pointer_mut(path).unwrap() = value;
            assert_eq!(validate_routed_request(&invalid, "m1", &capability), Err(expected), "{path}");
        }
        let mut extra = request.clone(); extra["payload"]["private"] = json!("do not forward");
        assert_eq!(validate_routed_request(&extra, "m1", &capability), Err("invalid_message"));
        let mut legacy = capability.clone(); legacy.id = "mecha:v2".into();
        legacy.methods.retain(|s| s != "match.concede-v2"); legacy.methods.push("match.concede".into());
        let mut old = request.clone(); old["capability"] = json!("mecha:v2");
        assert_eq!(validate_routed_request(&old, "m1", &legacy), Err("forbidden"));
    }

}
