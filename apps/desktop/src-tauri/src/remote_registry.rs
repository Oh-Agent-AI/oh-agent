use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use crate::remote_protocol::RemoteCapability;

type ControlFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
type ControlHandler = for<'a> fn(&'a tauri::AppHandle, &'a RemoteCapability, &'a str, &'a Value) -> ControlFuture<'a>;

pub struct AdapterRegistration {
    pub app_id: &'static str,
    pub capability_id: &'static str,
    pub control_methods: &'static [&'static str],
    pub supports: fn(&RemoteCapability) -> bool,
    pub control: ControlHandler,
}

fn city_control<'a>(app: &'a tauri::AppHandle, capability: &'a RemoteCapability, method: &'a str, payload: &'a Value) -> ControlFuture<'a> {
    Box::pin(crate::remote_gateway::control_for_city(app, "city", capability, method, payload))
}

static ADAPTERS: &[AdapterRegistration] = &[AdapterRegistration {
    app_id: "city",
    capability_id: "mecha:v1",
    control_methods: &["mecha.remote.start", "mecha.remote.invite", "mecha.remote.approve", "mecha.remote.revoke", "mecha.remote.pending", "mecha.remote.stop"],
    supports: crate::mecha_remote_adapter::supports,
    control: city_control,
}];

pub fn lookup<'a>(registrations: &'a [AdapterRegistration], app_id: &str, method: &str) -> Option<&'a AdapterRegistration> {
    registrations.iter().find(|entry| entry.app_id == app_id && entry.control_methods.contains(&method))
}

pub fn registered(app_id: &str, method: &str) -> Option<&'static AdapterRegistration> {
    lookup(ADAPTERS, app_id, method)
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

    #[test]
    fn registry_scopes_methods_to_the_authorized_application() {
        let registrations = [AdapterRegistration { app_id: "island", capability_id: "island:v1", control_methods: &["island.remote.start"], supports: supports_island, control: island_control }];
        assert!(lookup(&registrations, "island", "island.remote.start").is_some());
        assert!(lookup(&registrations, "city", "island.remote.start").is_none());
        assert!(lookup(&registrations, "island", "plugin_request").is_none());
        assert!(registered("island", "island.remote.start").is_none());
        assert!(registered("city", "mecha.remote.start").is_some());
    }
}
