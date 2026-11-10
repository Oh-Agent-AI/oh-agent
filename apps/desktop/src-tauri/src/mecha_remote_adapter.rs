use serde_json::Value;
use crate::remote_registry::{AdapterRegistration, ControlFuture, HostLifecycleEvent, HostSessionPlan, HostStopPolicy, RemoteLinkSpec, WirePolicy};
use crate::remote_protocol::{self, RemoteCapability};
use tauri::Manager;

#[path = "mecha_remote_projection.rs"]
pub(crate) mod projection;

const PROTOCOL: &str = "mecha-net:v1";
const APP_ID: &str = "city";
const SEQUENTIAL_PROTOCOL: &str = "mecha-net:v2";
const METHODS: [&str; 4] = ["match.snapshot", "plan.submit", "match.concede", "match.close"];
const EVENTS: [&str; 3] = ["match.closed", "match.replaced", "turn.resolved"];
// Deployment is a distinct capability; never broaden the v1 contract.
const DEPLOYMENT_METHODS: [&str; 5] = ["match.snapshot", "deployment.submit", "plan.submit", "match.concede", "match.close"];
// v3 replaces the unsafe, unversioned concession rather than widening v1/v2.
const SAFE_METHODS: [&str; 5] = ["match.snapshot", "deployment.submit", "plan.submit", "match.concede-v2", "match.close"];
// v4 is the command-stream handoff; it deliberately has no plan or concede methods.
const SEQUENTIAL_METHODS: [&str; 3] = ["sequential.snapshot", "sequential.command.submit", "city.snapshot"];

fn host_window_label(token: &str) -> String { format!("mecha-remote-{token}") }

fn create_host_session(app: &tauri::AppHandle, token: &str, app_id: &str, capability: &str, session_id: &str) -> Result<(), &'static str> {
    let label = host_window_label(token);
    if let Some(view) = app.get_webview_window(&label) { let _ = view.close(); }
    let script = format!("window.__AV_REMOTE_HOST_CONTEXT__={};", serde_json::to_string(&serde_json::json!({"token":token,"appId":app_id,"capability":capability,"sessionId":session_id})).map_err(|_| "remote_unavailable")?);
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("plugins/AgentCity.plugin/ui/remote.html?sessionHost=1".into()))
        .title("Agent City MatchSession").visible(false).focused(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(&script)
        .build().map_err(|_| "remote_session_unavailable")?;
    Ok(())
}

fn send_host_request(app: &tauri::AppHandle, token: &str, app_id: &str, capability: &str, session_id: &str, request: &Value) -> Result<(), &'static str> {
    let detail = serde_json::to_string(&serde_json::json!({"token":token,"appId":app_id,"capability":capability,"sessionId":session_id,"request":request})).map_err(|_| "remote_unavailable")?;
    app.get_webview_window(&host_window_label(token)).ok_or("remote_session_unavailable")?
        .eval(format!("window.dispatchEvent(new CustomEvent('__AV_REMOTE_HOST_REQUEST__',{{detail:{detail}}}));"))
        .map_err(|_| "remote_session_unavailable")
}

fn close_host_session(app: &tauri::AppHandle, token: &str) {
    if let Some(view) = app.get_webview_window(&host_window_label(token)) { let _ = view.close(); }
}

fn host_window_matches(label: &str, token: &str) -> bool { label == host_window_label(token) }

fn decode_host_reply(reply: &Value, match_id: &str, capability: Option<&RemoteCapability>) -> Result<HostLifecycleEvent, &'static str> {
    match reply["type"].as_str() {
        Some("ready") => Ok(HostLifecycleEvent::Ready),
        Some("created") => Ok(HostLifecycleEvent::Created),
        Some("joined") => reply["ok"].as_bool().map(HostLifecycleEvent::Joined).ok_or("invalid_message"),
        Some("frozen") if capability.is_some_and(supports_sequential) && reply["snapshot"]["ok"] == true
            && valid_frozen_snapshot(&reply["snapshot"]["snapshot"], match_id) =>
                Ok(HostLifecycleEvent::Frozen(reply["snapshot"]["snapshot"].clone())),
        Some("message") => reply.get("message").cloned().map(HostLifecycleEvent::Message).ok_or("invalid_message"),
        _ => Err("invalid_message"),
    }
}

fn prepare_host_session(capability: &RemoteCapability, payload: &Value, match_id: &str) -> Result<HostSessionPlan, &'static str> {
    let relay = payload["relay"].as_str().filter(|url| crate::remote_transport::valid_relay_url(url)).ok_or("remote_url_invalid")?.trim_end_matches('/').to_owned();
    let arena = &payload["arena"];
    let state = &payload["state"];
    let valid = if supports_safe_concede(capability) {
        projection::valid_start_deployment(arena, state) || projection::valid_start(arena, state)
    } else if supports_deployment(capability) {
        projection::valid_start_deployment(arena, state)
    } else if supports(capability) {
        projection::valid_start(arena, state)
    } else { false };
    if !valid { return Err("remote_match_invalid"); }
    let (create_request, join_request, freeze_request) = (
        serde_json::json!({"protocol":PROTOCOL,"type":"request","requestId":"create-session","method":"match.create","payload":{"config":{"matchId":match_id,"mode":"pve","arena":arena,"state":state,"players":[{"playerId":"owner","side":"A","role":"host"}]}}}),
        Some(serde_json::json!({"protocol":PROTOCOL,"type":"request","requestId":"join-session","method":"match.join","payload":{"matchId":match_id,"playerId":"guest"}})),
        None,
    );
    let body = serde_json::json!({"relay":relay,"create":create_request,"join":join_request,"freeze":freeze_request});
    if serde_json::to_vec(&body).map_err(|_| "remote_match_invalid")?.len() > 256 * 1024 { return Err("remote_match_too_large"); }
    let owner_capability_param = (capability.id != "mecha:v1").then_some("capability");
    let invitation_capability_param = matches!(capability.id.as_str(), "mecha:v2" | "mecha:v3").then_some("capability");
    let links = RemoteLinkSpec {
        path: "/remote".into(), session_param: "match".into(), player_param: "player".into(), websocket_param: "ws".into(), access_param: "access".into(), device_param: "device".into(),
        owner_secret_param: None, invitation_room_param: "room".into(), invitation_id_param: "invite".into(), invitation_secret_param: None,
        owner_capability_param: owner_capability_param.map(str::to_owned), invitation_capability_param: invitation_capability_param.map(str::to_owned),
    };
    Ok(HostSessionPlan { relay, create_request, approval_request: join_request, stop_request: freeze_request, links })
}

pub(crate) fn valid_frozen_snapshot(value: &Value, match_id: &str) -> bool {
    value["protocol"] == "mecha-net:v2" && value["ruleset"] == "mecha-v1.5" && value["matchId"] == match_id
        && value["revision"].as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
        && value["initial"]["revision"].as_u64().zip(value["commands"].as_array()).and_then(|(revision, commands)| revision.checked_add(commands.len() as u64)) == value["revision"].as_u64()
        && value.get("enemyPolicy").is_none_or(|policy| policy == "baup" || policy == "scripted")
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= 256 * 1024)
        && projection::valid_start_sequential(&serde_json::json!({"initial":value["initial"],"placements":value["placements"],"commands":value["commands"]}))
}

fn city_control<'a>(app: &'a tauri::AppHandle, capability: &'a RemoteCapability, method: &'a str, payload: &'a Value) -> ControlFuture<'a> {
    Box::pin(dispatch_control(app, capability, method, payload))
}

async fn dispatch_control(app: &tauri::AppHandle, capability: &RemoteCapability, method: &str, payload: &Value) -> Result<Value, &'static str> {
    match method {
        "mecha.remote.start" | "mecha.remote.start-deployment" | "mecha.remote.start-v3" | "mecha.remote.start-sequential" => crate::remote_gateway::start(app, APP_ID, capability, payload).await,
        "mecha.remote.invite" => crate::remote_gateway::control(app, APP_ID, capability, payload, "invite").await,
        "mecha.remote.approve" => crate::remote_gateway::control(app, APP_ID, capability, payload, "approve").await,
        "mecha.remote.revoke" => crate::remote_gateway::control(app, APP_ID, capability, payload, "revoke").await,
        "mecha.remote.pending" => crate::remote_gateway::control(app, APP_ID, capability, payload, "pending").await,
        "mecha.remote.stop" | "mecha.remote.stop-sequential" | "mecha.remote.stop-deployment" | "mecha.remote.stop-v3" => crate::remote_gateway::stop(app, APP_ID, capability, payload).await,
        _ => Err("invalid_request"),
    }
}

static CONTROL_REGISTRATIONS: &[AdapterRegistration] = &[
    AdapterRegistration { app_id: "city", capability_id: "mecha:v1", control_methods: &["mecha.remote.start", "mecha.remote.invite", "mecha.remote.approve", "mecha.remote.revoke", "mecha.remote.pending", "mecha.remote.stop"], supports, control: city_control, validate_request: validate_routed_request, session_protocol, validate_host_message, validate_host_payload, create_host_session, send_host_request, close_host_session, host_window_matches, decode_host_reply, status_event: "mecha-remote-status", prepare_host_session: Some(prepare_host_session), validate_bootstrap: None, stop_policy, wire_policy: WirePolicy::LegacyTyped },
    AdapterRegistration { app_id: "city", capability_id: "mecha:v2", control_methods: &["mecha.remote.start-deployment", "mecha.remote.stop-deployment"], supports: supports_deployment, control: city_control, validate_request: validate_routed_request, session_protocol, validate_host_message, validate_host_payload, create_host_session, send_host_request, close_host_session, host_window_matches, decode_host_reply, status_event: "mecha-remote-status", prepare_host_session: Some(prepare_host_session), validate_bootstrap: None, stop_policy, wire_policy: WirePolicy::LegacyTyped },
    AdapterRegistration { app_id: "city", capability_id: "mecha:v3", control_methods: &["mecha.remote.start-v3", "mecha.remote.stop-v3"], supports: supports_safe_concede, control: city_control, validate_request: validate_routed_request, session_protocol, validate_host_message, validate_host_payload, create_host_session, send_host_request, close_host_session, host_window_matches, decode_host_reply, status_event: "mecha-remote-status", prepare_host_session: Some(prepare_host_session), validate_bootstrap: None, stop_policy, wire_policy: WirePolicy::LegacyTyped },
    AdapterRegistration { app_id: "city", capability_id: "mecha:v4", control_methods: &["mecha.remote.start-sequential", "mecha.remote.stop-sequential"], supports: supports_sequential, control: city_control, validate_request: validate_routed_request, session_protocol, validate_host_message, validate_host_payload, create_host_session, send_host_request, close_host_session, host_window_matches, decode_host_reply, status_event: "mecha-remote-status", prepare_host_session: None, validate_bootstrap: None, stop_policy, wire_policy: WirePolicy::AppValidatedOpaque },
];

pub(crate) fn control_registrations() -> &'static [AdapterRegistration] { CONTROL_REGISTRATIONS }

pub fn supports(capability: &RemoteCapability) -> bool {
    capability.id == "mecha:v1" && capability.is_valid()
        && capability.methods.len() == METHODS.len() && METHODS.iter().all(|method| capability.allows_method(method))
        && capability.events.len() == EVENTS.len() && EVENTS.iter().all(|event| capability.allows_event(event))
}

fn validate_identity(value: &Value, match_id: &str) -> Result<(), &'static str> {
    let player = value["peer"]["playerId"].as_str().filter(|id| matches!(*id, "owner" | "guest")).ok_or("forbidden")?;
    if value["peer"]["role"] != player || value["payload"]["matchId"] != match_id || value["payload"]["playerId"] != player { return Err("forbidden"); }
    Ok(())
}

struct MechaAdapter<'a>(&'a RemoteCapability);

impl remote_protocol::RemoteAdapter for MechaAdapter<'_> {
    fn app_id(&self) -> &str { "city" }
    fn capability(&self) -> &RemoteCapability { self.0 }
    fn validate_payload(&self, value: &Value, match_id: &str) -> Result<(), &'static str> {
        if !value["method"].as_str().is_some_and(|method| METHODS.contains(&method)) { return Err("invalid_message"); }
        validate_identity(value, match_id)
    }
}

pub fn validate_request(value: &Value, match_id: &str, capability: &RemoteCapability) -> Result<(), &'static str> {
    remote_protocol::route_request(&MechaAdapter(capability), value, match_id)
}

pub(crate) fn supports_deployment(capability: &RemoteCapability) -> bool {
    capability.id == "mecha:v2" && capability.is_valid()
        && capability.methods.len() == DEPLOYMENT_METHODS.len() && DEPLOYMENT_METHODS.iter().all(|method| capability.allows_method(method))
        && capability.events.len() == EVENTS.len() && EVENTS.iter().all(|event| capability.allows_event(event))
}

struct DeploymentAdapter<'a>(&'a RemoteCapability);
impl remote_protocol::RemoteAdapter for DeploymentAdapter<'_> {
    fn app_id(&self) -> &str { "city" }
    fn capability(&self) -> &RemoteCapability { self.0 }
    fn validate_payload(&self, value: &Value, match_id: &str) -> Result<(), &'static str> {
        validate_identity(value, match_id)?;
        if value["method"] == "deployment.submit" && value["peer"]["role"] != "owner" { return Err("forbidden"); }
        Ok(())
    }
}

pub(crate) fn validate_deployment_request(value: &Value, match_id: &str, capability: &RemoteCapability) -> Result<(), &'static str> {
    if !supports_deployment(capability) { return Err("forbidden"); }
    remote_protocol::route_request(&DeploymentAdapter(capability), value, match_id)
}

pub(crate) fn supports_safe_concede(capability: &RemoteCapability) -> bool {
    capability.id == "mecha:v3" && capability.is_valid()
        && capability.methods.len() == SAFE_METHODS.len() && SAFE_METHODS.iter().all(|method| capability.allows_method(method))
        && capability.events.len() == EVENTS.len() && EVENTS.iter().all(|event| capability.allows_event(event))
}

pub(crate) fn validate_safe_request(value: &Value, match_id: &str, capability: &RemoteCapability) -> Result<(), &'static str> {
    if !supports_safe_concede(capability) { return Err("forbidden"); }
    remote_protocol::route_request(&DeploymentAdapter(capability), value, match_id)
}

pub(crate) fn supports_sequential(capability: &RemoteCapability) -> bool {
    capability.id == "mecha:v4" && capability.is_valid()
        && capability.methods.len() == SEQUENTIAL_METHODS.len() && SEQUENTIAL_METHODS.iter().all(|method| capability.allows_method(method))
        && capability.events.is_empty()
}

fn stop_policy(_: &RemoteCapability) -> HostStopPolicy { HostStopPolicy::FreezeSnapshot }

/// The desktop session bridge carries the negotiated game protocol separately
/// from the relay envelope. v1.5 uses its own command-stream protocol inside
/// the trusted host WebView; the outer relay protocol remains app-remote:v1.
pub(crate) fn session_protocol(capability: &RemoteCapability) -> &'static str {
    if supports_sequential(capability) { SEQUENTIAL_PROTOCOL } else { PROTOCOL }
}

pub(crate) fn validate_sequential_request(value: &Value, match_id: &str, capability: &RemoteCapability) -> Result<(), &'static str> {
    if !supports_sequential(capability) { return Err("forbidden"); }
    if value["payload"]["matchId"] != match_id { return Err("forbidden"); }
    if !value["method"].as_str().is_some_and(|method| SEQUENTIAL_METHODS.contains(&method)) { return Err("invalid_message"); }
    Ok(())
}

pub(crate) fn validate_sequential_host_message(value: &Value, match_id: &str) -> bool {
    value["protocol"] == SEQUENTIAL_PROTOCOL && value["type"] == "response"
        && value["requestId"].as_str().is_some_and(valid_id)
        && value["result"]["snapshot"]["matchId"].as_str().is_none_or(|id| id == match_id)
}

/// Game-specific remote request policy. The generic gateway only owns framing,
/// byte limits and delivery; this adapter owns method and game payload rules.
pub(crate) fn validate_routed_request(value: &Value, match_id: &str, capability: &RemoteCapability) -> Result<(), &'static str> {
    if supports(capability) {
        validate_request(value, match_id, capability)?;
    } else if supports_deployment(capability) {
        if value["method"] == "deployment.submit" {
            validate_deployment_request(value, match_id, capability)?;
            if !projection::valid_submit_deployment(&value["payload"]) { return Err("invalid_message"); }
            return Ok(());
        }
        validate_deployment_request(value, match_id, capability)?;
    } else if supports_safe_concede(capability) {
        validate_safe_request(value, match_id, capability)?;
        if value["method"] == "deployment.submit" && !projection::valid_submit_deployment(&value["payload"]) { return Err("invalid_message"); }
        if value["method"] == "match.concede-v2" && !projection::valid_submit_concede(&value["payload"]) { return Err("invalid_message"); }
    } else if supports_sequential(capability) {
        validate_sequential_request(value, match_id, capability)?;
    } else { return Err("forbidden"); }
    if value["method"] == "plan.submit" && !projection::valid_submit_plan(&value["payload"]) { return Err("invalid_message"); }
    Ok(())
}

pub(crate) fn validate_host_message(value: &Value, match_id: &str, capability: &RemoteCapability) -> bool {
    if supports_sequential(capability) {
        validate_sequential_host_message(value, match_id)
    } else {
        validate_host_message_legacy(value, match_id, capability)
    }
}

pub(crate) fn validate_host_payload(value: &Value, match_id: &str, capability: &RemoteCapability) -> bool {
    supports_sequential(capability) || if supports_deployment(capability) || supports_safe_concede(capability) {
        projection::valid_outbound_with_deployment(value, match_id)
    } else {
        projection::valid_outbound(value, match_id)
    }
}

fn validate_host_message_legacy(value: &Value, match_id: &str, capability: &RemoteCapability) -> bool {
    if value["protocol"] != PROTOCOL { return false; }
    match value["type"].as_str() {
        Some("response") => value["requestId"].as_str().is_some_and(valid_id),
        Some("event") => {
            let Some(event) = value["event"]["type"].as_str() else { return false; };
            if !capability.allows_event(event) { return false; }
            match event {
                "match.closed" => value["event"]["matchId"] == match_id,
                "match.replaced" => value["event"]["snapshot"]["matchId"] == match_id,
                "turn.resolved" => value["event"]["result"]["matchId"] == match_id,
                _ => false,
            }
        }
        _ => false,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capability() -> RemoteCapability {
        RemoteCapability { id: "mecha:v1".into(), methods: METHODS.iter().map(|item| (*item).into()).collect(), events: EVENTS.iter().map(|item| (*item).into()).collect() }
    }

    #[test]
    fn mecha_stop_policy_preserves_freeze_snapshot() {
        assert_eq!(stop_policy(&capability()), HostStopPolicy::FreezeSnapshot);
    }

    #[test]
    fn sequential_capability_requires_exact_methods_and_v2_protocol() {
        let cap = RemoteCapability { id: "mecha:v4".into(), methods: SEQUENTIAL_METHODS.iter().map(|item| (*item).into()).collect(), events: vec![] };
        assert!(supports_sequential(&cap));
        assert_eq!(session_protocol(&cap), SEQUENTIAL_PROTOCOL);
        let request = json!({"payload":{"matchId":"m1"},"method":"sequential.snapshot"});
        assert_eq!(validate_sequential_request(&request, "m1", &cap), Ok(()));
        assert_eq!(validate_sequential_request(&request, "other", &cap), Err("forbidden"));
        let mut widened = cap.clone();
        widened.methods.push("plan.submit".into());
        assert!(!supports_sequential(&widened));
        assert_eq!(session_protocol(&capability()), PROTOCOL);
        assert!(validate_sequential_host_message(&json!({"protocol":"mecha-net:v2","type":"response","requestId":"r1","result":{"snapshot":{"matchId":"m1"}}}), "m1"));
        assert!(!validate_sequential_host_message(&json!({"protocol":"mecha-net:v1","type":"response","requestId":"r1"}), "m1"));
    }

    #[test]
    fn host_lifecycle_reply_decoding_is_adapter_owned_and_session_bound() {
        let sequential = RemoteCapability { id: "mecha:v4".into(), methods: SEQUENTIAL_METHODS.iter().map(|item| (*item).into()).collect(), events: vec![] };
        assert_eq!(decode_host_reply(&json!({"type":"ready"}), "", None), Ok(HostLifecycleEvent::Ready));
        assert_eq!(decode_host_reply(&json!({"type":"created"}), "", None), Ok(HostLifecycleEvent::Created));
        assert_eq!(decode_host_reply(&json!({"type":"joined","ok":true}), "m1", Some(&sequential)), Ok(HostLifecycleEvent::Joined(true)));
        assert_eq!(decode_host_reply(&json!({"type":"joined"}), "m1", Some(&sequential)), Err("invalid_message"));
        let frozen: Value = serde_json::from_str(include_str!("../tests/fixtures/mecha-sequential-frozen-synthetic.json")).unwrap();
        let reply = json!({"type":"frozen","snapshot":{"ok":true,"snapshot":frozen}});
        assert!(matches!(decode_host_reply(&reply, "fixture-match", Some(&sequential)), Ok(HostLifecycleEvent::Frozen(_))));
        assert_eq!(decode_host_reply(&reply, "other", Some(&sequential)), Err("invalid_message"));
    }

    #[test]
    fn host_start_plan_owns_mecha_payload_and_link_policy() {
        let data: Value = serde_json::from_str(include_str!("../tests/remote_gateway_projection_fixture.json")).unwrap();
        let plan = prepare_host_session(&capability(), &json!({"relay":"https://relay.example.com","arena":data["arena"],"state":data["state"]}), "m1").unwrap();
        assert_eq!(plan.create_request["protocol"], PROTOCOL);
        assert_eq!(plan.create_request["payload"]["config"]["matchId"], "m1");
        assert_eq!(plan.create_request["payload"]["config"]["mode"], "pve");
        assert!(plan.approval_request.is_some());
        assert!(plan.stop_request.is_none());
        assert_eq!(plan.links.path, "/remote");
        assert_eq!(plan.links.owner_capability_param, None);

        let mut invalid = json!({"relay":"http://localhost:8787","arena":data["arena"],"state":data["state"]});
        assert_eq!(prepare_host_session(&capability(), &invalid, "m2").err(), Some("remote_url_invalid"));
        invalid["relay"] = json!("https://relay.example.com");
        invalid["state"]["unknown"] = json!(true);
        assert_eq!(prepare_host_session(&capability(), &invalid, "m2").err(), Some("remote_match_invalid"));
    }

    #[test]
    fn registered_contract_cannot_expand_the_adapter() {
        let mut cap = capability();
        assert!(supports(&cap));
        cap.methods.push("plugin_request".into());
        assert!(!supports(&cap));
        assert_eq!(validate_request(&json!({"protocol":remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v1","type":"request","requestId":"r1","method":"plugin_request","peer":{"role":"owner","playerId":"owner"},"payload":{"matchId":"m1","playerId":"owner"}}), "m1", &cap), Err("invalid_message"));
    }

    #[test]
    fn payload_identity_must_match_authenticated_peer() {
        let cap = capability();
        let mut request = json!({"protocol":remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v1","type":"request","requestId":"r1","method":"match.snapshot","peer":{"role":"owner","playerId":"owner"},"payload":{"matchId":"m1","playerId":"owner"}});
        assert_eq!(validate_request(&request, "m1", &cap), Ok(()));
        request["payload"]["playerId"] = json!("guest");
        assert_eq!(validate_request(&request, "m1", &cap), Err("forbidden"));
        request["peer"]["role"] = json!("guest");
        assert_eq!(validate_request(&request, "m1", &cap), Err("forbidden"));
    }

    #[test]
    fn event_must_be_declared_and_match_session() {
        let mut cap = capability();
        let event = json!({"protocol":PROTOCOL,"type":"event","event":{"type":"match.closed","matchId":"m1"}});
        assert!(validate_host_message(&event, "m1", &cap));
        assert!(!validate_host_message(&event, "m2", &cap));
        cap.events.clear();
        assert!(!validate_host_message(&event, "m1", &cap));
    }
    #[test]
    fn prepared_deployment_capability_is_versioned_and_owner_bound() {
        let cap = RemoteCapability { id: "mecha:v2".into(), methods: DEPLOYMENT_METHODS.iter().map(|item| (*item).into()).collect(), events: EVENTS.iter().map(|item| (*item).into()).collect() };
        assert!(supports_deployment(&cap));
        assert!(!supports(&cap), "v2 must not silently expand the production v1 adapter");
        let request = json!({"protocol":remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v2","type":"request","requestId":"r1","method":"deployment.submit","peer":{"role":"owner","playerId":"owner"},"payload":{"matchId":"m1","playerId":"owner"}});
        assert_eq!(validate_deployment_request(&request, "m1", &cap), Ok(()));
        assert_eq!(validate_request(&request, "m1", &cap), Err("invalid_message"));
        for (path, value) in [
            ("/sessionId", json!("m2")), ("/capability", json!("mecha:v1")), ("/appId", json!("other")),
            ("/payload/matchId", json!("m2")), ("/payload/playerId", json!("guest")),
            ("/peer/role", json!("guest")), ("/peer/playerId", json!("guest")),
        ] {
            let mut forged = request.clone(); *forged.pointer_mut(path).unwrap() = value;
            assert_eq!(validate_deployment_request(&forged, "m1", &cap), Err("forbidden"), "{path}");
        }
        let mut guest = request.clone(); guest["peer"] = json!({"role":"guest","playerId":"guest"}); guest["payload"]["playerId"] = json!("guest");
        assert_eq!(validate_deployment_request(&guest, "m1", &cap), Err("forbidden"));
        guest["method"] = json!("match.snapshot");
        assert_eq!(validate_deployment_request(&guest, "m1", &cap), Ok(()));
        let mut widened = cap.clone(); widened.methods.push("plugin_request".into());
        assert!(!supports_deployment(&widened));
        assert_eq!(validate_deployment_request(&request, "m1", &widened), Err("forbidden"));
        assert!(!supports_deployment(&capability()));
    }

    #[test]
    fn safe_concession_is_isolated_and_identity_bound() {
        let cap = RemoteCapability { id: "mecha:v3".into(), methods: SAFE_METHODS.iter().map(|item| (*item).into()).collect(), events: EVENTS.iter().map(|item| (*item).into()).collect() };
        let mut request = json!({"protocol":remote_protocol::PROTOCOL,"appId":"city","sessionId":"m1","capability":"mecha:v3","type":"request","requestId":"r1","method":"match.concede-v2","peer":{"role":"guest","playerId":"guest"},"payload":{"matchId":"m1","playerId":"guest"}});
        assert!(supports_safe_concede(&cap));
        assert_eq!(validate_safe_request(&request, "m1", &cap), Ok(()));
        request["payload"]["playerId"] = json!("owner");
        assert_eq!(validate_safe_request(&request, "m1", &cap), Err("forbidden"));
        request["payload"]["playerId"] = json!("guest");
        request["method"] = json!("match.concede");
        assert_eq!(validate_safe_request(&request, "m1", &cap), Err("forbidden"));
        request["method"] = json!("deployment.submit");
        assert_eq!(validate_safe_request(&request, "m1", &cap), Err("forbidden"));
        let mut widened = cap.clone();
        widened.methods.push("plugin_request".into());
        assert!(!supports_safe_concede(&widened));
        assert!(!supports_safe_concede(&capability()));
    }

}
