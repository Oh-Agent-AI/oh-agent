use serde_json::Value;
use serde::Deserialize;
use std::future::Future;
use std::pin::Pin;
use crate::remote_protocol::RemoteCapability;

pub(crate) type ControlFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
pub(crate) type ControlHandler = for<'a> fn(&'a tauri::AppHandle, &'a RemoteCapability, &'a str, &'a Value) -> ControlFuture<'a>;
pub(crate) type RequestValidator = fn(&Value, &str, &RemoteCapability) -> Result<(), &'static str>;
pub(crate) type ProtocolSelector = fn(&RemoteCapability) -> &'static str;
pub(crate) type MessageValidator = fn(&Value, &str, &RemoteCapability) -> bool;
pub(crate) type HostSessionCreate = fn(&tauri::AppHandle, &str, &str, &str, &str) -> Result<(), &'static str>;
pub(crate) type HostSessionSend = fn(&tauri::AppHandle, &str, &str, &str, &str, &Value) -> Result<(), &'static str>;
pub(crate) type HostSessionClose = fn(&tauri::AppHandle, &str);
pub(crate) type HostWindowMatches = fn(&str, &str) -> bool;
#[derive(Debug, PartialEq)]
pub(crate) enum HostLifecycleEvent { Ready, Created, Joined(bool), Frozen(Value), Message(Value) }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WirePolicy { LegacyTyped, AppValidatedOpaque }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostStopPolicy {
    #[allow(dead_code)] // Reserved for registered adapters whose stop flow has no resumable host state.
    CloseOnly,
    #[allow(dead_code)] // Legacy Rust adapters remain available to test baselines only.
    FreezeSnapshot,
}
pub(crate) type HostStopPolicySelector = fn(&RemoteCapability) -> HostStopPolicy;
pub(crate) type HostReplyDecoder = fn(&Value, &str, Option<&RemoteCapability>) -> Result<HostLifecycleEvent, &'static str>;
pub(crate) type BootstrapValidator = fn(&Value) -> Result<(), &'static str>;
#[derive(Clone)]
pub(crate) struct HostSessionPlan {
    pub relay: String,
    pub create_request: Value,
    /// Optional application-specific check before an invited peer is approved.
    /// Read-only visitor sessions may omit this check.
    pub approval_request: Option<Value>,
    /// Optional application-specific state capture before the generic session closes.
    pub stop_request: Option<Value>,
    pub links: RemoteLinkSpec,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteLinkSpec {
    pub path: String,
    pub session_param: String,
    pub player_param: String,
    pub websocket_param: String,
    pub access_param: String,
    pub device_param: String,
    pub owner_secret_param: Option<String>,
    pub invitation_room_param: String,
    pub invitation_id_param: String,
    pub invitation_secret_param: Option<String>,
    pub owner_capability_param: Option<String>,
    pub invitation_capability_param: Option<String>,
}
pub(crate) type HostSessionPlanner = fn(&RemoteCapability, &Value, &str) -> Result<HostSessionPlan, &'static str>;

pub(crate) struct AdapterRegistration {
    pub app_id: &'static str,
    pub capability_id: &'static str,
    pub control_methods: &'static [&'static str],
    pub supports: fn(&RemoteCapability) -> bool,
    pub control: ControlHandler,
    pub validate_request: RequestValidator,
    pub session_protocol: ProtocolSelector,
    pub validate_host_message: MessageValidator,
    pub validate_host_payload: MessageValidator,
    pub create_host_session: HostSessionCreate,
    pub send_host_request: HostSessionSend,
    pub close_host_session: HostSessionClose,
    pub host_window_matches: HostWindowMatches,
    pub decode_host_reply: HostReplyDecoder,
    pub status_event: &'static str,
    /// Legacy game adapters may plan old wire formats; generic sessions use the shared bootstrap planner.
    pub prepare_host_session: Option<HostSessionPlanner>,
    /// Optional trusted-data projection gate; this must not validate game rules.
    pub validate_bootstrap: Option<BootstrapValidator>,
    pub stop_policy: HostStopPolicySelector,
    /// New adapters route the generic outer envelope and validate their own payloads in the app layer.
    pub wire_policy: WirePolicy,
}

pub(crate) fn lookup<'a>(registrations: &'a [AdapterRegistration], app_id: &str, capabilities: &[RemoteCapability], method: &str) -> Option<&'a AdapterRegistration> {
    registrations.iter().find(|entry| {
        entry.app_id == app_id && entry.control_methods.contains(&method)
            && capabilities.iter().any(|capability| capability.id == entry.capability_id && (entry.supports)(capability))
    })
}

pub fn registered(app_id: &str, capabilities: &[RemoteCapability], method: &str) -> Option<&'static AdapterRegistration> {
    crate::remote_adapter_manifest::registered(app_id, capabilities, method)
}

pub(crate) fn for_capability(app_id: &str, capability: &RemoteCapability) -> Option<&'static AdapterRegistration> {
    crate::remote_adapter_manifest::for_capability(app_id, capability)
}

pub(crate) fn for_identity(app_id: &str, capability_id: &str) -> Option<&'static AdapterRegistration> {
    crate::remote_adapter_manifest::for_identity(app_id, capability_id)
}

impl AdapterRegistration {
    pub async fn dispatch(&self, app: &tauri::AppHandle, capability: &RemoteCapability, method: &str, payload: &Value) -> Result<Value, &'static str> {
        if capability.id != self.capability_id || !self.control_methods.contains(&method) || !(self.supports)(capability) {
            return Err("remote_forbidden");
        }
        (self.control)(app, capability, method, payload).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supports_island(capability: &RemoteCapability) -> bool { capability.id == "island:v1" && capability.is_valid() }
    fn island_control<'a>(_: &'a tauri::AppHandle, _: &'a RemoteCapability, _: &'a str, _: &'a Value) -> ControlFuture<'a> {
        Box::pin(async { Ok(serde_json::json!({"synthetic":true})) })
    }
    fn island_request(_: &Value, _: &str, _: &RemoteCapability) -> Result<(), &'static str> { Ok(()) }
    fn island_protocol(_: &RemoteCapability) -> &'static str { "island:v1" }
    fn island_message(_: &Value, _: &str, _: &RemoteCapability) -> bool { true }
    fn island_create(_: &tauri::AppHandle, _: &str, _: &str, _: &str, _: &str) -> Result<(), &'static str> { Ok(()) }
    fn island_send(_: &tauri::AppHandle, _: &str, _: &str, _: &str, _: &str, _: &Value) -> Result<(), &'static str> { Ok(()) }
    fn island_close(_: &tauri::AppHandle, _: &str) {}
    fn island_window_matches(label: &str, token: &str) -> bool { label == format!("island-{token}") }
    fn island_decode(_: &Value, _: &str, _: Option<&RemoteCapability>) -> Result<HostLifecycleEvent, &'static str> { Err("invalid_message") }
    fn island_stop_policy(_: &RemoteCapability) -> HostStopPolicy { HostStopPolicy::CloseOnly }

    #[test]
    fn registry_scopes_methods_to_the_authorized_application() {
        let registrations = [AdapterRegistration { app_id: "island", capability_id: "island:v1", control_methods: &["island.remote.start"], supports: supports_island, control: island_control, validate_request: island_request, session_protocol: island_protocol, validate_host_message: island_message, validate_host_payload: island_message, create_host_session: island_create, send_host_request: island_send, close_host_session: island_close, host_window_matches: island_window_matches, decode_host_reply: island_decode, status_event: "island-remote-status", prepare_host_session: None, validate_bootstrap: None, stop_policy: island_stop_policy, wire_policy: WirePolicy::AppValidatedOpaque }];
        let island = [RemoteCapability { id: "island:v1".into(), methods: vec!["island.scene".into()], events: vec![] }];
        let registration = lookup(&registrations, "island", &island, "island.remote.start").unwrap();
        assert_eq!((registration.session_protocol)(&island[0]), "island:v1");
        assert_eq!((registration.stop_policy)(&island[0]), HostStopPolicy::CloseOnly);
        assert_eq!((registration.validate_request)(&serde_json::json!({}), "scene-1", &island[0]), Ok(()));
        assert!((registration.validate_host_message)(&serde_json::json!({}), "scene-1", &island[0]));
        assert!((registration.validate_host_payload)(&serde_json::json!({}), "scene-1", &island[0]));
        assert!((registration.host_window_matches)("island-pending-host", "pending-host"));
        assert!(lookup(&registrations, "city", &island, "island.remote.start").is_none());
        assert!(lookup(&registrations, "island", &island, "plugin_request").is_none());
        assert!(registered("island", &[], "island.remote.start").is_none());
        let capabilities = [
            RemoteCapability { id: "mecha:v1".into(), methods: ["match.snapshot", "plan.submit", "match.concede", "match.close"].into_iter().map(str::to_owned).collect(), events: ["match.closed", "match.replaced", "turn.resolved"].into_iter().map(str::to_owned).collect() },
            RemoteCapability { id: "mecha:v4".into(), methods: ["sequential.snapshot", "sequential.command.submit", "city.snapshot"].into_iter().map(str::to_owned).collect(), events: vec![] },
        ];
        assert_eq!(registered("city", &capabilities, "mecha.remote.start").unwrap().capability_id, "mecha:v1");
        assert_eq!(registered("city", &capabilities, "mecha.remote.start-sequential").unwrap().capability_id, "mecha:v4");
        assert_eq!(registered("city", &capabilities, "mecha.remote.stop").unwrap().capability_id, "mecha:v1");
        assert_eq!(registered("city", &capabilities, "mecha.remote.stop-sequential").unwrap().capability_id, "mecha:v4");
        assert!(registered("other", &capabilities, "mecha.remote.start-sequential").is_none());
        assert!(registered("city", &[], "mecha.remote.start-sequential").is_none());
    }
}
