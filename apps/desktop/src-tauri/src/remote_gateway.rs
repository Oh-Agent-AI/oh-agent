use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::Manager;
use tokio::sync::{mpsc, watch};
use crate::remote_registry::HostLifecycleEvent;
use crate::remote_transport::{self, RelayConnection};
use crate::remote_sessions::{RemoteSessionBroker, SessionKey, SessionOperationLocks};

#[cfg(test)]
const PROTOCOL: &str = "mecha-net:v1";
#[cfg(test)]
const METHODS: [&str; 4] = ["match.snapshot", "plan.submit", "match.concede", "match.close"];

struct Active {
    app_id: String,
    owner_instance_id: String,
    generic: bool,
    relay: String,
    room_id: String,
    session_id: String,
    capability: crate::remote_protocol::RemoteCapability,
    owner_token: String,
    session_token: String,
    approval_request: Option<Value>,
    stop_request: Option<Value>,
    links: crate::remote_registry::RemoteLinkSpec,
    outbox: mpsc::Sender<String>,
    cancel: watch::Sender<bool>,
}

type State = RemoteSessionBroker<Active, Value>;

fn session_key(app_id: &str, capability: &crate::remote_protocol::RemoteCapability, session_id: &str) -> SessionKey { SessionKey::new(app_id, &capability.id, session_id) }

fn should_freeze_on_stop(policy: crate::remote_registry::HostStopPolicy) -> bool {
    match policy {
        crate::remote_registry::HostStopPolicy::CloseOnly => false,
        crate::remote_registry::HostStopPolicy::FreezeSnapshot => true,
    }
}

pub struct RemoteGateway {
    state: Mutex<State>,
    operations: SessionOperationLocks,
    lifecycle: crate::remote_session_runtime::HostLifecycleWaiters,
}

/// Revokes every session owned by a plugin instance being destroyed. Pending
/// handshakes lose their lifecycle waiter, which makes setup fail and close
/// its just-created relay room; live sessions are removed before async cleanup.
pub(crate) fn close_sessions_for_instance(app: &tauri::AppHandle, owner_instance_id: &str) {
    let gateway = app.state::<RemoteGateway>();
    let (active, starting_hosts) = {
        let mut state = gateway.state.lock().unwrap();
        let keys: Vec<_> = state.active.values().filter(|active| active.owner_instance_id == owner_instance_id)
            .map(|active| session_key(&active.app_id, &active.capability, &active.session_id)).collect();
        let active = keys.into_iter().filter_map(|key| {
            state.forget_snapshot(&key);
            state.active.remove(&key)
        }).collect::<Vec<_>>();
        let tokens: Vec<_> = state.starting_hosts.values().filter(|host| host.owner_instance_id == owner_instance_id)
            .map(|host| host.token.clone()).collect();
        let starting = tokens.into_iter().filter_map(|token| state.finish_host(&token)).collect::<Vec<_>>();
        (active, starting)
    };
    for starting in starting_hosts {
        gateway.lifecycle.remove(&starting.token);
        close_starting_host_session(app, &starting);
    }
    for active in active {
        gateway.lifecycle.remove(&active.session_token);
        active.cancel.send_replace(true);
        close_host_session(app, &active);
        let relay = relay_connection(&active);
        tauri::async_runtime::spawn(async move { let _ = relay.close().await; });
    }
}

impl Default for RemoteGateway {
    fn default() -> Self {
        Self { state: Mutex::new(State::default()), operations: SessionOperationLocks::default(), lifecycle: Default::default() }
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

fn requested_session_id(payload: &Value) -> Option<&str> {
    payload["sessionId"].as_str().filter(|id| valid_id(id))
}

fn requested_owner_instance_id(payload: &Value) -> Result<&str, &'static str> {
    payload["__hostOwnerInstanceId"].as_str().filter(|id| valid_id(id)).ok_or("remote_forbidden")
}

fn relay_connection(active: &Active) -> RelayConnection {
    RelayConnection::new(active.relay.clone(), active.room_id.clone(), active.owner_token.clone())
}

fn remote_link(active: &Active, ticket: &str, player: &str) -> Result<String, &'static str> {
    let mut url = reqwest::Url::parse(&format!("{}{}", active.relay.trim_end_matches('/'), active.links.path)).map_err(|_| "remote_url_invalid")?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair(&active.links.session_param, &active.session_id).append_pair(&active.links.player_param, player)
            .append_pair(&active.links.websocket_param, &relay_connection(active).ws_endpoint(ticket)?);
        if let Some(key) = &active.links.owner_capability_param { query.append_pair(key, &active.capability.id); }
    }
    Ok(url.into())
}

fn invitation_link(active: &Active, invite_id: &str, invite_secret: &str) -> Result<String, &'static str> {
    let mut url = reqwest::Url::parse(&format!("{}{}", active.relay.trim_end_matches('/'), active.links.path)).map_err(|_| "remote_url_invalid")?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair(&active.links.session_param, &active.session_id)
            .append_pair(&active.links.invitation_room_param, &active.room_id)
            .append_pair(&active.links.invitation_id_param, invite_id);
        if let Some(key) = &active.links.invitation_capability_param { query.append_pair(key, &active.capability.id); }
        if let Some(key) = &active.links.invitation_secret_param { query.append_pair(key, invite_secret); }
    }
    if active.links.invitation_secret_param.is_none() { url.set_fragment(Some(invite_secret)); }
    Ok(url.into())
}

fn generic_host_window_label(token: &str) -> String { format!("remote-host-{token}") }

fn host_window_matches(adapter: &crate::remote_registry::AdapterRegistration, label: &str, token: &str) -> bool {
    (adapter.host_window_matches)(label, token)
}

fn create_host_session(app: &tauri::AppHandle, adapter: &crate::remote_registry::AdapterRegistration, app_id: &str, capability: &crate::remote_protocol::RemoteCapability, session_id: &str, token: &str) -> Result<(), &'static str> {
    (adapter.create_host_session)(app, token, app_id, &capability.id, session_id)
}

fn create_generic_host_session(app: &tauri::AppHandle, app_id: &str, capability: &crate::remote_protocol::RemoteCapability, session_id: &str, token: &str) -> Result<(), &'static str> {
    let entry = crate::plugin_host::remote_host_entry(app_id).ok_or("remote_session_unavailable")?;
    let label = generic_host_window_label(token);
    if let Some(view) = app.get_webview_window(&label) { let _ = view.close(); }
    let context = json!({"token":token,"appId":app_id,"capability":capability.id,"sessionId":session_id});
    let script = format!("window.__AV_REMOTE_HOST_CONTEXT__={};", serde_json::to_string(&context).map_err(|_| "remote_unavailable")?);
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(entry.into()))
        .title("Remote Session Host").visible(false).focused(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(&script)
        .build().map_err(|_| "remote_session_unavailable")?;
    Ok(())
}

fn send_host_request(app: &tauri::AppHandle, active: &Active, request: &Value) -> Result<(), &'static str> {
    if !crate::plugin_host::remote_owner_instance_alive(app, &active.app_id, &active.owner_instance_id) { return Err("remote_forbidden"); }
    if active.generic { return send_generic_host_request(app, &active.session_token, &active.app_id, &active.capability.id, &active.session_id, request); }
    let adapter = crate::remote_registry::for_capability(&active.app_id, &active.capability).ok_or("remote_forbidden")?;
    (adapter.send_host_request)(app, &active.session_token, &active.app_id, &active.capability.id, &active.session_id, request)
}

pub(crate) fn send_generic_host_request(app: &tauri::AppHandle, token: &str, app_id: &str, capability_id: &str, session_id: &str, request: &Value) -> Result<(), &'static str> {
    let detail = serde_json::to_string(&json!({"token":token,"appId":app_id,"capability":capability_id,"sessionId":session_id,"request":request})).map_err(|_| "remote_unavailable")?;
    app.get_webview_window(&generic_host_window_label(token)).ok_or("remote_session_unavailable")?
        .eval(format!("window.dispatchEvent(new CustomEvent('__AV_REMOTE_HOST_REQUEST__',{{detail:{detail}}}));"))
        .map_err(|_| "remote_session_unavailable")
}

fn close_host_session(app: &tauri::AppHandle, active: &Active) {
    if active.generic {
        if let Some(view) = app.get_webview_window(&generic_host_window_label(&active.session_token)) { let _ = view.close(); }
        return;
    }
    if let Some(adapter) = crate::remote_registry::for_capability(&active.app_id, &active.capability) {
        (adapter.close_host_session)(app, &active.session_token);
    }
}

fn close_starting_host_session(app: &tauri::AppHandle, starting: &crate::remote_sessions::StartingHost) {
    if starting.generic {
        if let Some(view) = app.get_webview_window(&generic_host_window_label(&starting.token)) { let _ = view.close(); }
    } else if let Some(adapter) = crate::remote_registry::for_identity(&starting.app_id, &starting.capability_id) {
        (adapter.close_host_session)(app, &starting.token);
    }
}

fn generic_host_session_plan(app_id: &str, capability: &crate::remote_protocol::RemoteCapability, profile: &crate::plugin_host::RemoteSessionProfile, payload: &Value, bootstrap: &Value, session_id: &str) -> Result<crate::remote_registry::HostSessionPlan, &'static str> {
    let relay = payload["relay"].as_str().filter(|url| remote_transport::valid_relay_url(url)).ok_or("remote_url_invalid")?.trim_end_matches('/').to_owned();
    let bootstrap_bytes = serde_json::to_vec(bootstrap).map_err(|_| "remote_match_invalid")?;
    if bootstrap_bytes.len() > profile.max_bootstrap_bytes { return Err("remote_match_too_large"); }
    let scope_request = |request_id: &str, method: &str, request_payload: Value| json!({
        "protocol": crate::remote_protocol::PROTOCOL, "appId": app_id, "sessionId": session_id,
        "capability": capability.id, "type": "request", "requestId": request_id, "method": method, "payload": request_payload,
    });
    let create_request = scope_request("bootstrap", &profile.bootstrap_method, bootstrap.clone());
    let approval_request = profile.approval_method.as_ref().map(|method| scope_request("join", method, json!({})));
    let stop_request = profile.stop_method.as_ref().map(|method| scope_request("stop", method, json!({})));
    let links = profile.links.clone();
    let plan_bytes = serde_json::to_vec(&json!({"relay":relay,"create":create_request,"join":approval_request,"freeze":stop_request}))
        .map_err(|_| "remote_match_invalid")?;
    if plan_bytes.len() > 256 * 1024 { return Err("remote_match_too_large"); }
    Ok(crate::remote_registry::HostSessionPlan { relay, create_request, approval_request, stop_request, links })
}

pub(crate) async fn start(app: &tauri::AppHandle, app_id: &str, capability: &crate::remote_protocol::RemoteCapability, payload: &Value) -> Result<Value, &'static str> {
    let adapter = crate::remote_registry::for_capability(app_id, capability).ok_or("remote_forbidden")?;
    start_with_adapter(app, app_id, capability, payload, Some(adapter)).await
}

pub(crate) async fn start_generic(app: &tauri::AppHandle, app_id: &str, capability: &crate::remote_protocol::RemoteCapability, payload: &Value) -> Result<Value, &'static str> {
    if !crate::plugin_host::remote_capability(app_id, &capability.id).is_some_and(|registered| {
        registered.id == capability.id && registered.methods == capability.methods && registered.events == capability.events
    })
        || crate::plugin_host::remote_host_entry(app_id).is_none()
        || crate::plugin_host::remote_session_profile(app_id, &capability.id).is_none() { return Err("remote_forbidden"); }
    let adapter = crate::remote_registry::for_capability(app_id, capability);
    if adapter.is_some_and(|adapter| adapter.wire_policy == crate::remote_registry::WirePolicy::LegacyTyped) { return Err("remote_forbidden"); }
    start_with_adapter(app, app_id, capability, payload, adapter).await
}

async fn start_with_adapter(app: &tauri::AppHandle, app_id: &str, capability: &crate::remote_protocol::RemoteCapability, payload: &Value, adapter: Option<&'static crate::remote_registry::AdapterRegistration>) -> Result<Value, &'static str> {
    let owner_instance_id = requested_owner_instance_id(payload)?.to_owned();
    if !crate::plugin_host::remote_owner_instance_alive(app, app_id, &owner_instance_id) { return Err("plugin_instance_unavailable"); }
    let gateway = app.state::<RemoteGateway>();
    let session_id = secret()?;
    let key = session_key(app_id, capability, &session_id);
    let _operation = gateway.operations.acquire(key.clone()).await;
    let generic = adapter.is_none_or(|adapter| adapter.wire_policy == crate::remote_registry::WirePolicy::AppValidatedOpaque);
    let plan = if generic {
        let profile = crate::plugin_host::remote_session_profile(app_id, &capability.id).ok_or("remote_forbidden")?;
        let bootstrap = crate::plugin_host::prepare_remote_bootstrap(app_id, &capability.id, payload)?;
        if let Some(validate) = adapter.and_then(|adapter| adapter.validate_bootstrap) { validate(payload)?; }
        generic_host_session_plan(app_id, capability, &profile, payload, &bootstrap, &session_id)?
    } else {
        adapter.and_then(|adapter| adapter.prepare_host_session).ok_or("remote_forbidden")?(capability, payload, &session_id)?
    };
    if !remote_transport::valid_relay_url(&plan.relay) { return Err("remote_url_invalid"); }
    let relay = plan.relay.clone();
    let room_id = secret()?;
    let (outbox, outgoing) = crate::remote_session_runtime::connection_channel();
    let active = Active {
        app_id: app_id.to_owned(), owner_instance_id: owner_instance_id.clone(), generic, relay: relay.clone(), room_id, session_id: session_id.clone(), capability: capability.clone(), owner_token: secret()?, session_token: secret()?,
        approval_request: plan.approval_request.clone(), stop_request: plan.stop_request.clone(),
        links: plan.links,
        outbox, cancel: watch::channel(false).0,
    };
    gateway.state.lock().unwrap().begin_host(crate::remote_sessions::StartingHost { app_id: active.app_id.clone(), owner_instance_id: active.owner_instance_id.clone(), capability_id: active.capability.id.clone(), generic: active.generic, token: active.session_token.clone() })?;
    if let Err(error) = gateway.lifecycle.register(&active.session_token) {
        gateway.state.lock().unwrap().finish_host(&active.session_token);
        return Err(error);
    }
    let setup: Result<String, &'static str> = async {
        relay_connection(&active).register(&active.app_id, &active.session_id, &active.capability, &active.owner_token).await?;
        if !crate::plugin_host::remote_owner_instance_alive(app, app_id, &active.owner_instance_id) { return Err("plugin_instance_unavailable"); }
        if active.generic { create_generic_host_session(app, app_id, capability, &active.session_id, &active.session_token)?; }
        else { create_host_session(app, adapter.ok_or("remote_forbidden")?, app_id, capability, &active.session_id, &active.session_token)?; }
        gateway.lifecycle.wait_ready(&active.session_token).await?;
        {
            send_host_request(app, &active, &plan.create_request)?;
        }
        gateway.lifecycle.wait_created(&active.session_token).await?;
        if !crate::plugin_host::remote_owner_instance_alive(app, app_id, &active.owner_instance_id) { return Err("plugin_instance_unavailable"); }
        let pair = relay_connection(&active).pair_owner().await?;
        let mut remote_url = reqwest::Url::parse(&remote_link(&active, &pair.ticket, "owner")?).map_err(|_| "remote_url_invalid")?;
        let access = relay_connection(&active).access_endpoint();
        remote_url.query_pairs_mut().append_pair(&active.links.access_param, &access)
            .append_pair(&active.links.device_param, &pair.device_id);
        if let Some(key) = &active.links.owner_secret_param {
            remote_url.query_pairs_mut().append_pair(key, &pair.reconnect_token);
        } else {
            remote_url.set_fragment(Some(&pair.reconnect_token));
        }
        Ok(remote_url.into())
    }.await;
    let remote_url = match setup {
        Ok(url) => url,
        Err(error) => {
            gateway.state.lock().unwrap().finish_host(&active.session_token);
            gateway.lifecycle.remove(&active.session_token);
            active.cancel.send_replace(true);
            close_host_session(app, &active);
            let _ = relay_connection(&active).close().await;
            return Err(error);
        }
    };
    let context = crate::remote_session_runtime::ConnectionContext {
        app_id: active.app_id.clone(), owner_instance_id: active.owner_instance_id.clone(), generic: active.generic, session_id: active.session_id.clone(), capability: active.capability.clone(),
        session_token: active.session_token.clone(), relay: relay_connection(&active), outbox: active.outbox.clone(),
        cancel: active.cancel.subscribe(),
    };
    if !crate::plugin_host::remote_owner_instance_alive(app, app_id, &active.owner_instance_id) {
        gateway.state.lock().unwrap().finish_host(&active.session_token);
        gateway.lifecycle.remove(&active.session_token);
        active.cancel.send_replace(true);
        close_host_session(app, &active);
        let _ = relay_connection(&active).close().await;
        return Err("plugin_instance_unavailable");
    }
    let token = active.session_token.clone();
    let owner_instance_id = active.owner_instance_id.clone();
    let rejected_active = {
        let mut state = gateway.state.lock().unwrap();
        let promoted = state.promote_host(&token, &owner_instance_id, key.clone(), active);
        if promoted.is_ok() { state.forget_snapshot(&key); }
        promoted.err()
    };
    if let Some(active) = rejected_active {
        gateway.lifecycle.remove(&active.session_token);
        active.cancel.send_replace(true);
        close_host_session(app, &active);
        let _ = relay_connection(&active).close().await;
        return Err("plugin_instance_unavailable");
    }
    tauri::async_runtime::spawn(crate::remote_session_runtime::run(app.clone(), context, outgoing));
    Ok(json!({"ok":true,"sessionId":session_id,"remoteUrl":remote_url,"connection":"connecting"}))
}

pub(crate) async fn control(app: &tauri::AppHandle, app_id: &str, capability: &crate::remote_protocol::RemoteCapability, payload: &Value, action: &str) -> Result<Value, &'static str> {
    let gateway = app.state::<RemoteGateway>();
    let session_id = requested_session_id(payload).ok_or("invalid_request")?;
    let key = session_key(app_id, capability, session_id);
    let _operation = gateway.operations.acquire(key.clone()).await;
    let active = {
        let state = gateway.state.lock().unwrap();
        state.active.get(&key).map(|active| Active {
            app_id: active.app_id.clone(), owner_instance_id: active.owner_instance_id.clone(), generic: active.generic, relay: active.relay.clone(), room_id: active.room_id.clone(), session_id: active.session_id.clone(), capability: active.capability.clone(),
            owner_token: active.owner_token.clone(), session_token: active.session_token.clone(), outbox: active.outbox.clone(), cancel: active.cancel.clone(),
            approval_request: active.approval_request.clone(), stop_request: active.stop_request.clone(),
            links: active.links.clone(),
        })
    }.ok_or("remote_not_active")?;
    let caller_instance_id = requested_owner_instance_id(payload)?;
    if active.owner_instance_id != caller_instance_id { return Err("remote_forbidden"); }
    if !crate::plugin_host::remote_owner_instance_alive(app, app_id, caller_instance_id) {
        close_sessions_for_instance(app, caller_instance_id);
        return Err("remote_forbidden");
    }
    match action {
        "invite" => {
            let invite = relay_connection(&active).invite().await?;
            let url = invitation_link(&active, &invite.id, &invite.secret)?;
            Ok(json!({"ok":true,"inviteUrl":url,"expiresIn":600}))
        }
        "approve" | "revoke" => {
            let device_id = payload["deviceId"].as_str().filter(|id| valid_id(id)).ok_or("invalid_request")?;
            if action == "approve" {
                let pending = relay_connection(&active).pending_devices().await?;
                if !pending["pending"].as_array().is_some_and(|items| items.iter().any(|item| item["deviceId"] == device_id)) { return Err("remote_invite_unavailable"); }
                if let Some(request) = active.approval_request.as_ref() {
                    gateway.lifecycle.reset_joined(&active.session_token)?;
                    send_host_request(app, &active, request)?;
                    if !gateway.lifecycle.wait_joined(&active.session_token).await? { return Err("remote_session_invalid"); }
                }
            }
            relay_connection(&active).set_device_access(action, device_id).await
        }
        "pending" => relay_connection(&active).pending_devices().await,
        _ => Err("invalid_request"),
    }
}

pub(crate) async fn stop(app: &tauri::AppHandle, app_id: &str, capability: &crate::remote_protocol::RemoteCapability, payload: &Value) -> Result<Value, &'static str> {
    let gateway = app.state::<RemoteGateway>();
    let session_id = requested_session_id(payload).ok_or("invalid_request")?;
    let key = session_key(app_id, capability, session_id);
    let _operation = gateway.operations.acquire(key.clone()).await;
    let caller_instance_id = requested_owner_instance_id(payload)?;
    let active_for_stop = { gateway.state.lock().unwrap().active.get(&key).map(|active| Active {
        app_id: active.app_id.clone(), owner_instance_id: active.owner_instance_id.clone(), generic: active.generic, relay: active.relay.clone(), room_id: active.room_id.clone(), session_id: active.session_id.clone(), capability: active.capability.clone(),
        owner_token: active.owner_token.clone(), session_token: active.session_token.clone(), outbox: active.outbox.clone(), cancel: active.cancel.clone(),
        approval_request: active.approval_request.clone(), stop_request: active.stop_request.clone(), links: active.links.clone(),
    }) };
    if active_for_stop.as_ref().is_some_and(|active| active.owner_instance_id != caller_instance_id) { return Err("remote_forbidden"); }
    if active_for_stop.as_ref().is_some_and(|active| !crate::plugin_host::remote_owner_instance_alive(app, app_id, &active.owner_instance_id)) {
        close_sessions_for_instance(app, caller_instance_id);
        return Err("remote_forbidden");
    }
    let adapter = crate::remote_registry::for_capability(app_id, capability);
    let generic = active_for_stop.as_ref().map(|active| active.generic).unwrap_or(adapter.is_none());
    let freeze_on_stop = if generic {
        crate::plugin_host::remote_session_profile(app_id, &capability.id).ok_or("remote_forbidden")?.stop_policy == "freezeSnapshot"
    } else { should_freeze_on_stop((adapter.ok_or("remote_forbidden")?.stop_policy)(capability)) };
    let stop_request = if freeze_on_stop {
        if let Some(active) = active_for_stop.as_ref() {
            gateway.lifecycle.reset_frozen(&active.session_token)?;
            Some(active.stop_request.clone().ok_or("remote_not_supported")?)
        } else { None }
    } else { None };
    if let (Some(request), Some(active)) = (stop_request.as_ref(), active_for_stop.as_ref()) { send_host_request(app, active, request)?; }
    let snapshot = if stop_request.is_some() { Some(gateway.lifecycle.wait_frozen(&active_for_stop.as_ref().ok_or("remote_not_active")?.session_token).await?) } else { None };
    let active = {
        let mut state = gateway.state.lock().unwrap();
        if let Some(value) = snapshot.as_ref() { state.remember_snapshot(key.clone(), value.clone()); }
        if !freeze_on_stop { state.forget_snapshot(&key); }
        state.active.remove(&key)
    };
    if let Some(active) = active {
        gateway.lifecycle.remove(&active.session_token);
        active.cancel.send_replace(true);
        let _ = relay_connection(&active).close().await;
        close_host_session(app, &active);
    }
    let result_snapshot = if freeze_on_stop {
        snapshot.or_else(|| gateway.state.lock().unwrap().snapshots.get(&key).cloned())
    } else { None };
    Ok(json!({"ok":true, "snapshot":result_snapshot}))
}

#[tauri::command]
pub fn remote_host_message(app: tauri::AppHandle, webview: tauri::WebviewWindow, reply: Value) -> Result<(), String> {
    let gateway = app.state::<RemoteGateway>();
    let token = reply["token"].as_str().ok_or("remote_forbidden")?;
    let (starting, active) = {
        let state = gateway.state.lock().unwrap();
        if let Some(starting) = state.starting_host(token) { (Some(starting.clone()), None) }
        else { (None, state.active.values().find(|active| active.session_token == token).map(|active| Active {
            app_id: active.app_id.clone(), owner_instance_id: active.owner_instance_id.clone(), generic: active.generic, relay: active.relay.clone(), room_id: active.room_id.clone(), session_id: active.session_id.clone(), capability: active.capability.clone(),
            owner_token: active.owner_token.clone(), session_token: active.session_token.clone(), outbox: active.outbox.clone(), cancel: active.cancel.clone(),
            approval_request: active.approval_request.clone(), stop_request: active.stop_request.clone(), links: active.links.clone(),
        })) }
    };
    if let Some(starting) = starting {
        if !crate::plugin_host::remote_owner_instance_alive(&app, &starting.app_id, &starting.owner_instance_id) {
            close_sessions_for_instance(&app, &starting.owner_instance_id);
            return Err("remote_forbidden".into());
        }
        let adapter = crate::remote_registry::for_identity(&starting.app_id, &starting.capability_id);
        if starting.generic {
            if webview.label() != generic_host_window_label(&starting.token) { return Err("remote_forbidden".into()); }
        } else if !adapter.is_some_and(|adapter| host_window_matches(adapter, webview.label(), &starting.token)) { return Err("remote_forbidden".into()); }
        let decoded = if starting.generic || adapter.is_some_and(|adapter| adapter.wire_policy == crate::remote_registry::WirePolicy::AppValidatedOpaque) {
            decode_generic_host_reply(&reply, None)
        } else {
            (adapter.ok_or("remote_forbidden").map_err(str::to_owned)?.decode_host_reply)(&reply, "", None)
        };
        match decoded {
            Ok(HostLifecycleEvent::Ready) if gateway.lifecycle.mark_ready(token) => {},
            Ok(HostLifecycleEvent::Created) if gateway.lifecycle.mark_created(token) => {},
            _ => return Err("invalid_message".into()),
        }
        return Ok(());
    }
    let active = active.ok_or("remote_not_active")?;
    if !crate::plugin_host::remote_owner_instance_alive(&app, &active.app_id, &active.owner_instance_id) {
        close_sessions_for_instance(&app, &active.owner_instance_id);
        return Err("remote_forbidden".into());
    }
    let adapter = crate::remote_registry::for_capability(&active.app_id, &active.capability);
    if active.generic {
        if webview.label() != generic_host_window_label(token) { return Err("remote_forbidden".into()); }
    } else if !adapter.is_some_and(|adapter| host_window_matches(adapter, webview.label(), token)) { return Err("remote_forbidden".into()); }
    let event = if active.generic || adapter.is_some_and(|adapter| adapter.wire_policy == crate::remote_registry::WirePolicy::AppValidatedOpaque) {
        decode_generic_host_reply(&reply, Some(&active.capability))
    } else {
        (adapter.ok_or("remote_forbidden").map_err(str::to_owned)?.decode_host_reply)(&reply, &active.session_id, Some(&active.capability))
    }.map_err(str::to_owned)?;
    match event {
        HostLifecycleEvent::Joined(ok) => if gateway.lifecycle.mark_joined(token, ok) { Ok(()) } else { Err("remote_not_active".into()) },
        HostLifecycleEvent::Frozen(snapshot) => if gateway.lifecycle.mark_frozen(token, snapshot) { Ok(()) } else { Err("remote_not_active".into()) },
        HostLifecycleEvent::Message(message) => deliver_host_message(adapter, &active, &message),
        _ => Err("invalid_message".into()),
    }
}

fn deliver_host_message(adapter: Option<&crate::remote_registry::AdapterRegistration>, active: &Active, message: &Value) -> Result<(), String> {
    if active.generic || adapter.is_some_and(|adapter| adapter.wire_policy == crate::remote_registry::WirePolicy::AppValidatedOpaque) {
        crate::remote_protocol::validate_host_message(message, &active.capability).map_err(str::to_owned)?;
    } else {
        let adapter = adapter.ok_or_else(|| "remote_forbidden".to_owned())?;
        if !(adapter.validate_host_message)(message, &active.session_id, &active.capability) { return Err("invalid_message".into()); }
        if !(adapter.validate_host_payload)(message, &active.session_id, &active.capability) { return Err("invalid_message".into()); }
    }
    let text = serde_json::to_string(&crate::remote_protocol::wrap_message(&active.app_id, &active.session_id, &active.capability, message.clone())).map_err(|_| "invalid_message")?;
    if text.len() > 256 * 1024 { return Err("message_too_large".into()); }
    active.outbox.try_send(text).map_err(|_| "remote_backpressure")?;
    Ok(())
}

fn decode_generic_host_reply(reply: &Value, capability: Option<&crate::remote_protocol::RemoteCapability>) -> Result<HostLifecycleEvent, &'static str> {
    match reply["type"].as_str() {
        Some("ready") => Ok(HostLifecycleEvent::Ready),
        Some("created") => Ok(HostLifecycleEvent::Created),
        Some("joined") => reply["ok"].as_bool().map(HostLifecycleEvent::Joined).ok_or("invalid_message"),
        Some("frozen") => {
            let snapshot = reply.get("snapshot").ok_or("invalid_message")?;
            crate::remote_protocol::validate_opaque_snapshot(snapshot, 256 * 1024)?;
            Ok(HostLifecycleEvent::Frozen(snapshot.clone()))
        }
        Some("message") => {
            let message = reply.get("message").ok_or("invalid_message")?;
            let capability = capability.ok_or("invalid_message")?;
            crate::remote_protocol::validate_host_message(message, capability)?;
            Ok(HostLifecycleEvent::Message(message.clone()))
        }
        _ => Err("invalid_message"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mecha_remote_adapter::{valid_frozen_snapshot, validate_host_message, validate_request};

    #[test]
    fn stop_policy_can_skip_freeze_for_non_mecha_adapter() {
        assert!(!should_freeze_on_stop(crate::remote_registry::HostStopPolicy::CloseOnly));
        assert!(should_freeze_on_stop(crate::remote_registry::HostStopPolicy::FreezeSnapshot));
    }

    #[test]
    fn generic_session_plan_uses_a_non_mecha_profile_without_game_assumptions() {
        let capability = crate::remote_protocol::RemoteCapability { id: "island:v1".into(), methods: vec!["island.visit".into()], events: vec![] };
        let profile = crate::plugin_host::RemoteSessionProfile {
            version: 1, bootstrap_method: "visit.bootstrap".into(), approval_method: None, stop_method: None,
            stop_policy: "closeOnly".into(), max_bootstrap_bytes: 1024,
            links: crate::remote_registry::RemoteLinkSpec {
                path: "/island".into(), session_param: "island".into(), player_param: "visitor".into(), websocket_param: "socket".into(),
                access_param: "grant".into(), device_param: "device".into(), owner_secret_param: None,
                invitation_room_param: "room".into(), invitation_id_param: "invite".into(), invitation_secret_param: Some("secret".into()),
                owner_capability_param: None, invitation_capability_param: Some("app".into()),
            },
        };
        let plan = generic_host_session_plan("island", &capability, &profile, &json!({"relay":"https://relay.example"}), &json!({"scene":"opaque"}), "session-1").unwrap();
        assert_eq!(plan.create_request["method"], "visit.bootstrap");
        assert!(plan.approval_request.is_none());
        assert!(plan.stop_request.is_none());
        assert_eq!(plan.links.path, "/island");
        assert_eq!(plan.links.player_param, "visitor");
    }

    #[tokio::test]
    async fn lifecycle_notifications_are_isolated_per_session() {
        let (joined_a, mut joined_a_rx) = watch::channel::<Option<bool>>(None);
        let (_joined_b, mut joined_b_rx) = watch::channel::<Option<bool>>(None);
        let (_frozen_a, mut frozen_a_rx) = watch::channel::<Option<Value>>(None);
        let (frozen_b, mut frozen_b_rx) = watch::channel::<Option<Value>>(None);
        joined_a.send_replace(Some(true));
        frozen_b.send_replace(Some(json!({"sessionId":"b"})));
        assert_eq!(*joined_a_rx.borrow_and_update(), Some(true));
        assert_eq!(*joined_b_rx.borrow_and_update(), None);
        assert_eq!(*frozen_a_rx.borrow_and_update(), None);
        assert_eq!(frozen_b_rx.borrow_and_update().as_ref().unwrap()["sessionId"], "b");
    }

    fn validate_routed_request(app_id: &str, value: &Value, match_id: &str, capability: &crate::remote_protocol::RemoteCapability) -> Result<(), &'static str> {
        let adapter = crate::remote_registry::for_capability(app_id, capability).ok_or("forbidden")?;
        (adapter.validate_request)(value, match_id, capability)
    }

    #[test]
    fn frozen_snapshot_rejects_incomplete_and_wrong_match() {
        let snapshot = json!({"protocol":"mecha-net:v2","ruleset":"mecha-v1.5","matchId":"m1","revision":0});
        assert!(!valid_frozen_snapshot(&snapshot, "m1"));
        assert!(!valid_frozen_snapshot(&snapshot, "other"));
    }

    #[test]
    fn frozen_snapshot_accepts_real_v15_session_and_rejects_truncation() {
        let mut snapshot: Value = serde_json::from_str(include_str!("../tests/fixtures/mecha-sequential-frozen-synthetic.json")).unwrap();
        assert!(valid_frozen_snapshot(&snapshot, "fixture-match"));
        snapshot["commands"] = json!([]);
        assert!(!valid_frozen_snapshot(&snapshot, "fixture-match"));
    }

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
        assert!(remote_transport::valid_relay_url("https://relay.example.com"));
        assert!(!remote_transport::valid_relay_url("http://localhost:8787"));
        assert!(!remote_transport::valid_relay_url("https://user:secret@example.com"));
        assert!(!remote_transport::valid_relay_url("file:///tmp/city"));
    }

    #[test]
    fn session_control_accepts_only_generic_identity() {
        assert_eq!(requested_session_id(&json!({"sessionId":"scene-1"})), Some("scene-1"));
        assert_eq!(requested_session_id(&json!({"matchId":"match-1"})), None);
        assert_eq!(requested_session_id(&json!({"sessionId":"../private","matchId":"match-1"})), None);
    }
    #[test]
    fn staged_deployment_requires_both_peer_binding_and_strict_projection() {
        let capability = crate::remote_protocol::RemoteCapability {
            id: "mecha:v2".into(),
            methods: ["match.snapshot", "deployment.submit", "plan.submit", "match.concede", "match.close"].iter().map(|item| (*item).into()).collect(),
            events: ["match.closed", "match.replaced", "turn.resolved"].iter().map(|item| (*item).into()).collect(),
        };
        let request = json!({"protocol":crate::remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v2","type":"request","requestId":"r1","method":"deployment.submit","peer":{"role":"owner","playerId":"owner"},"payload":{"type":"deployment.submit","protocol":PROTOCOL,"matchId":"m1","playerId":"owner","commandId":"d1","baseRevision":0,"plan":{"revision":0,"placements":[{"mechId":"Assault","pos":{"x":1,"y":8}},{"mechId":"Gunner","pos":{"x":2,"y":8}},{"mechId":"Support","pos":{"x":3,"y":8}}]}}});
        assert_eq!(validate_request(&request, "m1", &capability), Err("invalid_message"), "the v1 adapter stays closed");
        assert_eq!(validate_routed_request("city", &request, "m1", &capability), Ok(()));
        let mut forged = request.clone(); forged["peer"] = json!({"role":"guest","playerId":"guest"});
        assert_eq!(validate_routed_request("city", &forged, "m1", &capability), Err("forbidden"));
        let mut foreign = request.clone(); foreign["payload"]["matchId"] = json!("m2");
        let mut private = request.clone(); private["payload"]["plan"]["placements"][0]["pos"]["secret"] = json!("private");
        assert_eq!(validate_routed_request("city", &private, "m1", &capability), Err("invalid_message"));
        let mut wrong_method = request.clone(); wrong_method["method"] = json!("match.snapshot");
        assert_eq!(validate_routed_request("city", &wrong_method, "m1", &capability), Ok(()));
        let mut legacy = capability.clone(); legacy.id = "mecha:v1".into(); legacy.methods.retain(|m| m != "deployment.submit");
        let mut legacy_request = request.clone(); legacy_request["capability"] = json!("mecha:v1");
        assert_eq!(validate_routed_request("city", &legacy_request, "m1", &legacy), Err("forbidden"));
        let mut widened = capability.clone(); widened.methods.push("plugin_request".into());
        assert_eq!(validate_routed_request("city", &request, "m1", &widened), Err("forbidden"));
        let mut bad_plan = wrong_method; bad_plan["method"] = json!("plan.submit");
        assert_eq!(validate_routed_request("city", &bad_plan, "m1", &capability), Err("invalid_message"));
    }

    #[test]
    fn links_preserve_legacy_v1_and_explicitly_identify_versioned_capabilities() {
        for (id, expected_owner, expected_invite) in [
            ("mecha:v1", None, None),
            ("mecha:v2", Some("mecha:v2"), Some("mecha:v2")),
            ("mecha:v3", Some("mecha:v3"), Some("mecha:v3")),
            ("mecha:v4", Some("mecha:v4"), None),
        ] {
            let active = Active {
                app_id: "city".into(),
                owner_instance_id: "plugin-city-test".into(),
                generic: id == "mecha:v4",
                relay: "https://relay.example.com".into(), room_id: "room1".into(), session_id: "match1".into(),
                capability: crate::remote_protocol::RemoteCapability { id: id.into(), methods: vec![], events: vec![] },
                owner_token: "owner-secret".into(), session_token: "host-secret".into(),
                approval_request: None, stop_request: None,
                links: crate::remote_registry::RemoteLinkSpec { path: "/remote".into(), session_param: "match".into(), player_param: "player".into(), websocket_param: "ws".into(), access_param: "access".into(), device_param: "device".into(), owner_secret_param: None, invitation_room_param: "room".into(), invitation_id_param: "invite".into(), invitation_secret_param: None, owner_capability_param: expected_owner.map(|_| "capability".into()), invitation_capability_param: expected_invite.map(|_| "capability".into()) },
                outbox: mpsc::channel(1).0, cancel: watch::channel(false).0,
            };
            let owner = reqwest::Url::parse(&remote_link(&active, "ticket1", "owner").unwrap()).unwrap();
            let invite = reqwest::Url::parse(&invitation_link(&active, "invite1", "invite-secret").unwrap()).unwrap();
            for (url, expected) in [(&owner, expected_owner), (&invite, expected_invite)] {
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
        assert_eq!(validate_routed_request("city", &request, "m1", &capability), Ok(()));
        for (path, value, expected) in [
            ("/payload/playerId", json!("owner"), "forbidden"),
            ("/payload/matchId", json!("m2"), "forbidden"),
            ("/method", json!("match.concede"), "forbidden"),
            ("/payload/baseRevision", json!(9007199254740992_u64), "invalid_message"),
            ("/payload/type", json!("match.concede"), "invalid_message"),
        ] {
            let mut invalid = request.clone(); *invalid.pointer_mut(path).unwrap() = value;
            assert_eq!(validate_routed_request("city", &invalid, "m1", &capability), Err(expected), "{path}");
        }
        let mut extra = request.clone(); extra["payload"]["private"] = json!("do not forward");
        assert_eq!(validate_routed_request("city", &extra, "m1", &capability), Err("invalid_message"));
        let mut legacy = capability.clone(); legacy.id = "mecha:v2".into();
        legacy.methods.retain(|s| s != "match.concede-v2"); legacy.methods.push("match.concede".into());
        let mut old = request.clone(); old["capability"] = json!("mecha:v2");
        assert_eq!(validate_routed_request("city", &old, "m1", &legacy), Err("forbidden"));
    }

}
