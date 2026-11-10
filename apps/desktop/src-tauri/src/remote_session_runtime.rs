use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Emitter;
use tokio::sync::{mpsc, watch};

use crate::remote_protocol::{self, RemoteCapability};
use crate::remote_transport::{self, RelayConnection};

const MAX_OUTBOUND_MESSAGES: usize = 32;

struct SessionWaiters {
    ready: watch::Sender<bool>,
    created: watch::Sender<bool>,
    joined: watch::Sender<Option<bool>>,
    frozen: watch::Sender<Option<Value>>,
}

/// Token-scoped host lifecycle handshakes shared by adapters. The gateway
/// validates host identity and decodes replies; this registry owns only waits.
#[derive(Default)]
pub(crate) struct HostLifecycleWaiters {
    sessions: Mutex<HashMap<String, SessionWaiters>>,
}

impl HostLifecycleWaiters {
    pub fn register(&self, token: &str) -> Result<(), &'static str> {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(token) { return Err("remote_already_active"); }
        sessions.insert(token.to_owned(), SessionWaiters {
            ready: watch::channel(false).0, created: watch::channel(false).0,
            joined: watch::channel(None).0, frozen: watch::channel(None).0,
        });
        Ok(())
    }

    pub fn remove(&self, token: &str) { self.sessions.lock().unwrap().remove(token); }
    pub fn mark_ready(&self, token: &str) -> bool { if let Some(waiters) = self.sessions.lock().unwrap().get(token) { waiters.ready.send_replace(true); true } else { false } }
    pub fn mark_created(&self, token: &str) -> bool { if let Some(waiters) = self.sessions.lock().unwrap().get(token) { waiters.created.send_replace(true); true } else { false } }
    pub fn mark_joined(&self, token: &str, joined: bool) -> bool { if let Some(waiters) = self.sessions.lock().unwrap().get(token) { waiters.joined.send_replace(Some(joined)); true } else { false } }
    pub fn mark_frozen(&self, token: &str, snapshot: Value) -> bool { if let Some(waiters) = self.sessions.lock().unwrap().get(token) { waiters.frozen.send_replace(Some(snapshot)); true } else { false } }

    fn receiver<T: Clone>(&self, token: &str, select: impl FnOnce(&SessionWaiters) -> watch::Receiver<T>) -> Result<watch::Receiver<T>, &'static str> {
        self.sessions.lock().unwrap().get(token).map(select).ok_or("remote_not_active")
    }

    async fn wait<T: Clone>(mut receiver: watch::Receiver<T>, ready: impl Fn(&T) -> bool, seconds: u64) -> Result<T, &'static str> {
        tokio::time::timeout(std::time::Duration::from_secs(seconds), receiver.wait_for(ready)).await
            .map_err(|_| "remote_session_unavailable")?.map(|value| value.clone()).map_err(|_| "remote_session_unavailable")
    }

    pub async fn wait_ready(&self, token: &str) -> Result<(), &'static str> {
        let receiver = self.receiver(token, |waiters| waiters.ready.subscribe())?;
        Self::wait(receiver, |ready| *ready, 20).await.map(|_| ())
    }
    pub async fn wait_created(&self, token: &str) -> Result<(), &'static str> {
        let receiver = self.receiver(token, |waiters| waiters.created.subscribe())?;
        Self::wait(receiver, |created| *created, 10).await.map(|_| ())
    }
    pub fn reset_joined(&self, token: &str) -> Result<(), &'static str> {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(token).ok_or("remote_not_active")?.joined.send_replace(None);
        Ok(())
    }
    pub async fn wait_joined(&self, token: &str) -> Result<bool, &'static str> {
        let receiver = self.receiver(token, |waiters| waiters.joined.subscribe())?;
        Self::wait(receiver, |joined| joined.is_some(), 10).await?.ok_or("remote_session_unavailable")
    }
    pub fn reset_frozen(&self, token: &str) -> Result<(), &'static str> {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(token).ok_or("remote_not_active")?.frozen.send_replace(None);
        Ok(())
    }
    pub async fn wait_frozen(&self, token: &str) -> Result<Value, &'static str> {
        let receiver = self.receiver(token, |waiters| waiters.frozen.subscribe())?;
        Self::wait(receiver, |snapshot| snapshot.is_some(), 10).await?.ok_or("remote_session_unavailable")
    }
}

/// The same bounded channel is created before session registration, so requests
/// that arrive while the websocket task is starting cannot land in a stale queue.
pub(crate) fn connection_channel() -> (mpsc::Sender<String>, mpsc::Receiver<String>) {
    mpsc::channel(MAX_OUTBOUND_MESSAGES)
}

pub(crate) struct ConnectionContext {
    pub app_id: String,
    pub owner_instance_id: String,
    pub generic: bool,
    pub session_id: String,
    pub capability: RemoteCapability,
    pub session_token: String,
    pub relay: RelayConnection,
    pub outbox: mpsc::Sender<String>,
    pub cancel: watch::Receiver<bool>,
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

fn respond(context: &ConnectionContext, request: &Value, code: &str) {
    if !request["requestId"].as_str().is_some_and(valid_request_id) { return; }
    let app_id = if context.generic { context.app_id.as_str() } else {
        let Some(adapter) = crate::remote_registry::for_capability(&context.app_id, &context.capability) else { return; };
        adapter.app_id
    };
    let message = remote_protocol::wrap_message(app_id, &context.session_id, &context.capability,
        json!({"type":"response","requestId":request["requestId"],"result":{"ok":false,"error":{"code":code}}}));
    if let Ok(text) = serde_json::to_string(&message) { let _ = context.outbox.try_send(text); }
}

pub(crate) async fn run(app: tauri::AppHandle, context: ConnectionContext, outgoing: mpsc::Receiver<String>) {
    let adapter = if context.generic { None } else { crate::remote_registry::for_capability(&context.app_id, &context.capability) };
    if !context.generic && adapter.is_none() { return; }
    let session_context = context;
    let status_app = app.clone();
    let app_id = session_context.app_id.clone();
    let session_id = session_context.session_id.clone();
    let generic = session_context.generic;
    remote_transport::run(session_context.relay.clone(), outgoing, session_context.cancel.clone(), move |value| {
        if value["type"] != "request" { return; }
        if !crate::plugin_host::remote_owner_instance_alive(&app, &session_context.app_id, &session_context.owner_instance_id) {
            respond(&session_context, &value, "remote_forbidden");
            crate::remote_gateway::close_sessions_for_instance(&app, &session_context.owner_instance_id);
            return;
        }
        let request = if session_context.generic {
                if let Err(code) = remote_protocol::validate_request(&value, &session_context.app_id, &session_context.session_id, &session_context.capability) {
                    respond(&session_context, &value, code);
                    return;
                }
                value.clone()
        } else {
            let Some(adapter) = adapter else { return; };
            match adapter.wire_policy {
                crate::remote_registry::WirePolicy::AppValidatedOpaque => {
                    if let Err(code) = remote_protocol::validate_request(&value, &session_context.app_id, &session_context.session_id, &session_context.capability) {
                        respond(&session_context, &value, code);
                        return;
                    }
                    value.clone()
                }
                crate::remote_registry::WirePolicy::LegacyTyped => {
                if let Err(code) = (adapter.validate_request)(&value, &session_context.session_id, &session_context.capability) {
                    respond(&session_context, &value, code);
                    return;
                }
                let protocol = (adapter.session_protocol)(&session_context.capability);
                json!({"protocol":protocol,"type":"request","requestId":value["requestId"],"method":value["method"],"payload":value["payload"]})
                }
            }
        };
        let sent = if session_context.generic {
            crate::remote_gateway::send_generic_host_request(&app, &session_context.session_token, &session_context.app_id, &session_context.capability.id, &session_context.session_id, &request)
        } else {
            adapter.map_or(Err("remote_forbidden"), |adapter| (adapter.send_host_request)(&app, &session_context.session_token, &session_context.app_id, &session_context.capability.id, &session_context.session_id, &request))
        };
        if sent.is_err() {
            respond(&session_context, &value, "remote_session_unavailable");
        }
    }, move |status| {
        let event = if generic { "remote-session-status" } else { adapter.map_or("remote-session-status", |adapter| adapter.status_event) };
        let _ = status_app.emit(event, json!({"appId":app_id,"status":status,"sessionId":session_id}));
    }).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn host_lifecycle_waiters_are_isolated_by_token() {
        let lifecycle = HostLifecycleWaiters::default();
        lifecycle.register("token-a").unwrap();
        lifecycle.register("token-b").unwrap();
        lifecycle.mark_ready("token-a");
        assert!(lifecycle.wait_ready("token-a").await.is_ok());
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), lifecycle.wait_ready("token-b")).await.is_err());
        lifecycle.mark_joined("token-b", true);
        assert!(lifecycle.wait_joined("token-b").await.unwrap());
        lifecycle.mark_frozen("token-b", json!({"sessionId":"session-b"}));
        assert_eq!(lifecycle.wait_frozen("token-b").await.unwrap()["sessionId"], "session-b");
        lifecycle.remove("token-a");
        assert_eq!(lifecycle.wait_ready("token-a").await, Err("remote_not_active"));
        assert!(!lifecycle.mark_ready("token-a"));
    }

    #[tokio::test]
    async fn host_lifecycle_registration_rejects_duplicate_tokens_and_cleans_up() {
        let lifecycle = HostLifecycleWaiters::default();
        lifecycle.register("token").unwrap();
        assert_eq!(lifecycle.register("token"), Err("remote_already_active"));
        lifecycle.remove("token");
        assert!(lifecycle.register("token").is_ok());
    }

    #[test]
    fn startup_messages_remain_in_the_runtime_connection_queue() {
        let (outbox, mut outgoing) = connection_channel();
        outbox.try_send("queued-during-startup".into()).unwrap();
        assert_eq!(outgoing.try_recv().unwrap(), "queued-during-startup");
    }

    fn context() -> (ConnectionContext, mpsc::Receiver<String>) {
        let (outbox, receiver) = mpsc::channel(2);
        (ConnectionContext {
            app_id: "city".into(), owner_instance_id: "plugin-city-test".into(), generic: false, session_id: "match-7".into(),
            capability: RemoteCapability { id: "mecha:v1".into(), methods: ["match.snapshot", "plan.submit", "match.concede", "match.close"].into_iter().map(str::to_owned).collect(), events: ["match.closed", "match.replaced", "turn.resolved"].into_iter().map(str::to_owned).collect() },
            session_token: "host-token".into(),
            relay: RelayConnection::new("https://relay.example".into(), "room".into(), "secret".into()),
            outbox, cancel: watch::channel(false).0.subscribe(),
        }, receiver)
    }

    #[test]
    fn request_error_response_is_scoped_to_the_registered_session() {
        let (context, mut receiver) = context();
        respond(&context, &json!({"requestId":"r1"}), "forbidden");
        let response: Value = serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
        assert_eq!(response["appId"], "city");
        assert_eq!(response["sessionId"], "match-7");
        assert_eq!(response["capability"], "mecha:v1");
        assert_eq!(response["requestId"], "r1");
        assert_eq!(response["result"]["error"]["code"], "forbidden");
    }

    #[test]
    fn invalid_request_ids_do_not_enter_the_outbox() {
        let (context, mut receiver) = context();
        respond(&context, &json!({"requestId":""}), "forbidden");
        assert!(receiver.try_recv().is_err());
    }
}
