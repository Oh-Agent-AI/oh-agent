use serde_json::Value;
use crate::remote_protocol::{self, RemoteCapability};

const PROTOCOL: &str = "mecha-net:v1";
const METHODS: [&str; 4] = ["match.snapshot", "plan.submit", "match.concede", "match.close"];
const EVENTS: [&str; 3] = ["match.closed", "match.replaced", "turn.resolved"];

pub fn supports(capability: &RemoteCapability) -> bool {
    capability.id == "mecha:v1" && capability.is_valid()
        && capability.methods.len() == METHODS.len() && METHODS.iter().all(|method| capability.allows_method(method))
        && capability.events.len() == EVENTS.len() && EVENTS.iter().all(|event| capability.allows_event(event))
}

struct MechaAdapter<'a>(&'a RemoteCapability);

impl remote_protocol::RemoteAdapter for MechaAdapter<'_> {
    fn app_id(&self) -> &str { "city" }
    fn capability(&self) -> &RemoteCapability { self.0 }
    fn validate_payload(&self, value: &Value, match_id: &str) -> Result<(), &'static str> {
        if !value["method"].as_str().is_some_and(|method| METHODS.contains(&method)) { return Err("invalid_message"); }
        let player = value["peer"]["playerId"].as_str().filter(|id| matches!(*id, "owner" | "guest")).ok_or("forbidden")?;
        if value["peer"]["role"] != player || value["payload"]["matchId"] != match_id || value["payload"]["playerId"] != player { return Err("forbidden"); }
        Ok(())
    }
}

pub fn validate_request(value: &Value, match_id: &str, capability: &RemoteCapability) -> Result<(), &'static str> {
    remote_protocol::route_request(&MechaAdapter(capability), value, match_id)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

pub fn validate_host_message(value: &Value, match_id: &str, capability: &RemoteCapability) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn capability() -> RemoteCapability {
        RemoteCapability { id: "mecha:v1".into(), methods: METHODS.iter().map(|item| (*item).into()).collect(), events: EVENTS.iter().map(|item| (*item).into()).collect() }
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
}
