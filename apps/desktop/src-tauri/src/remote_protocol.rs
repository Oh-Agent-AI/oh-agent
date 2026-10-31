use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL: &str = "app-remote:v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapability {
    pub id: String,
    pub methods: Vec<String>,
    pub events: Vec<String>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b':' | b'_' | b'-' | b'.'))
}

impl RemoteCapability {
    pub fn is_valid(&self) -> bool {
        identifier(&self.id) && !self.methods.is_empty() && self.methods.len() <= 32 && self.events.len() <= 32
            && self.methods.iter().all(|method| identifier(method)) && self.events.iter().all(|event| identifier(event))
            && self.methods.iter().collect::<std::collections::BTreeSet<_>>().len() == self.methods.len()
            && self.events.iter().collect::<std::collections::BTreeSet<_>>().len() == self.events.len()
    }

    pub fn allows_method(&self, method: &str) -> bool { self.methods.iter().any(|item| item == method) }
    pub fn allows_event(&self, event: &str) -> bool { self.events.iter().any(|item| item == event) }
}

pub trait RemoteAdapter {
    fn app_id(&self) -> &str;
    fn capability(&self) -> &RemoteCapability;
    fn validate_payload(&self, value: &Value, session_id: &str) -> Result<(), &'static str>;
}

pub fn route_request(adapter: &impl RemoteAdapter, value: &Value, session_id: &str) -> Result<(), &'static str> {
    validate_request(value, adapter.app_id(), session_id, adapter.capability())?;
    adapter.validate_payload(value, session_id)
}

pub fn validate_request(value: &Value, app_id: &str, session_id: &str, capability: &RemoteCapability) -> Result<(), &'static str> {
    if value["protocol"] != PROTOCOL || value["type"] != "request"
        || !value["requestId"].as_str().is_some_and(identifier)
        || !value["payload"].is_object() { return Err("invalid_message"); }
    if value["appId"] != app_id || value["sessionId"] != session_id || value["capability"] != capability.id { return Err("forbidden"); }
    if !value["method"].as_str().is_some_and(|method| capability.allows_method(method)) { return Err("forbidden"); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct IslandAdapter(RemoteCapability);

    impl RemoteAdapter for IslandAdapter {
        fn app_id(&self) -> &str { "island" }
        fn capability(&self) -> &RemoteCapability { &self.0 }
        fn validate_payload(&self, value: &Value, _: &str) -> Result<(), &'static str> {
            if value["payload"]["visitor"] == "allowed" { Ok(()) } else { Err("forbidden") }
        }
    }

    #[test]
    fn capabilities_are_scoped_to_registered_app_session_and_method() {
        let cap = RemoteCapability { id: "island:v1".into(), methods: vec!["island.visit".into()], events: vec!["island.changed".into()] };
        let message = json!({"protocol":PROTOCOL,"type":"request","appId":"island","sessionId":"s1","capability":"island:v1","requestId":"r1","method":"island.visit","payload":{}});
        assert!(cap.is_valid());
        assert_eq!(validate_request(&message, "island", "s1", &cap), Ok(()));
        assert_eq!(validate_request(&message, "city", "s1", &cap), Err("forbidden"));
        assert_eq!(validate_request(&message, "island", "s2", &cap), Err("forbidden"));
        let mut forged = message.clone();
        forged["method"] = json!("plugin_request");
        assert_eq!(validate_request(&forged, "island", "s1", &cap), Err("forbidden"));
        let adapter = IslandAdapter(cap.clone());
        let mut allowed = message.clone();
        allowed["payload"]["visitor"] = json!("allowed");
        assert_eq!(route_request(&adapter, &allowed, "s1"), Ok(()));
        assert_eq!(route_request(&adapter, &message, "s1"), Err("forbidden"));
        assert_eq!(route_request(&adapter, &allowed, "s2"), Err("forbidden"));
        assert!(cap.allows_event("island.changed"));
        assert!(!cap.allows_event("match.replaced"));
    }
}
