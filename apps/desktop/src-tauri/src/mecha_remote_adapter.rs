use serde_json::Value;
use crate::remote_protocol::{self, RemoteCapability};

const PROTOCOL: &str = "mecha-net:v1";
const METHODS: [&str; 4] = ["match.snapshot", "plan.submit", "match.concede", "match.close"];
const EVENTS: [&str; 3] = ["match.closed", "match.replaced", "turn.resolved"];
// Deployment is a distinct capability; never broaden the v1 contract.
const DEPLOYMENT_METHODS: [&str; 5] = ["match.snapshot", "deployment.submit", "plan.submit", "match.concede", "match.close"];
// v3 replaces the unsafe, unversioned concession rather than widening v1/v2.
const SAFE_METHODS: [&str; 5] = ["match.snapshot", "deployment.submit", "plan.submit", "match.concede-v2", "match.close"];

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
