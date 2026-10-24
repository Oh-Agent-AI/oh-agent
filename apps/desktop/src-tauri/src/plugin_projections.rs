//! Official projection handlers; business dispatch does not belong to PluginHost.
use serde_json::Value;

pub fn session_target(plugin_id: &str, payload: &Value) -> Result<(String, String), &'static str> {
    let handle = payload["handle"].as_str().ok_or("invalid_session_handle")?;
    // Scope is the plugin that received the handle (`app:{plugin_id}:`), not a City special case.
    // PluginHost already requires `navigationTargets` to include `session` before this runs.
    agent_vitals_runtime::query::app_local::plugin_session_target(&crate::overview::data_home(), plugin_id, handle)
}

#[cfg(test)]
pub fn read(allowed: &[String], method: &str, payload: &Value) -> Result<Value, &'static str> {
    read_for_plugin(allowed, method, payload, "host-test")
}

pub fn read_for_plugin(allowed: &[String], method: &str, payload: &Value, plugin_id: &str) -> Result<Value, &'static str> {
    if matches!(method, "harnesses.list" | "harnesses.sessions") {
        if payload["version"].as_u64() != Some(1) { return Err("unsupported_version"); }
        if !allowed.iter().any(|key| key == "harnesses:v1") { return Err("projection_denied"); }
        let home = crate::overview::data_home();
        if method == "harnesses.list" { return agent_vitals_runtime::query::app_harnesses::list(&home); }
        let id = payload["harness_id"].as_str().ok_or("harness_unavailable")?;
        let days = payload["windowDays"].as_u64().filter(|n| matches!(n, 7 | 30 | 90 | 366)).ok_or("invalid_window")?;
        let revision = payload["data_revision"].as_u64().ok_or("revision_required")?;
        return agent_vitals_runtime::query::app_harnesses::sessions(&home, id, days as u16,
            agent_vitals_runtime::core::clock::now_ms(), revision, plugin_id);
    }
    if method != "data.read" { return Err("method_unavailable"); }
    let name = payload["projection"].as_str().ok_or("projection_unavailable")?;
    let version = payload["version"].as_u64().ok_or("projection_unavailable")?;
    let key = format!("{name}:v{version}");
    if !allowed.contains(&key) { return Err("projection_denied"); }
    match key.as_str() {
        "city-settings:v1" => city_settings(payload),
        "city:v3" => agent_vitals_runtime::query::city_v3::read(&crate::overview::data_home(), payload,
            agent_vitals_runtime::core::clock::now_ms()),
        "city:v2" => {
            let days = payload["windowDays"].as_u64().ok_or("invalid_window")?;
            if !matches!(days, 7 | 30 | 90 | 366) { return Err("invalid_window"); }
            agent_vitals_runtime::query::app_local::city_projection(&crate::overview::data_home(), days as u16,
                agent_vitals_runtime::core::clock::now_ms())
        }
        _ => Err("projection_unavailable"),
    }
}

fn city_settings(payload: &Value) -> Result<Value, &'static str> {
    city_settings_at(&crate::overview::data_home(), payload)
}

fn city_settings_at(data_home: &std::path::Path, payload: &Value) -> Result<Value, &'static str> {
    let path = data_home.join("state/plugins/city.json");
    match payload["action"].as_str() {
        Some("read") => {
            let seed = match std::fs::read(&path) {
                Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_err(|_| "state_unavailable")?["seed"].as_u64(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match std::fs::read(data_home.join("state/city-seed.json")) {
                        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().and_then(|value| value["seed"].as_u64()),
                        Err(_) => None,
                    }
                }
                Err(_) => return Err("state_unavailable"),
            };
            Ok(serde_json::json!({"seed": seed.filter(|n| *n > 0 && *n <= u32::MAX as u64)}))
        }
        Some("write") => {
            let seed = payload["seed"].as_u64().filter(|n| *n > 0 && *n <= u32::MAX as u64).ok_or("invalid_seed")?;
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "state_unavailable")?;
            let temp = path.with_extension("tmp");
            std::fs::write(&temp, serde_json::json!({"seed": seed}).to_string()).map_err(|_| "state_unavailable")?;
            std::fs::rename(&temp, &path).map_err(|_| "state_unavailable")?;
            Ok(serde_json::json!({"seed": seed}))
        }
        _ => Err("invalid_settings_action"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn projections_are_explicitly_scoped_and_windows_bounded() {
        assert_eq!(read(&[], "data.read", &json!({"projection":"city","version":1,"windowDays":30})), Err("projection_denied"));
        assert_eq!(read(&["city:v2".into()], "sql", &json!({})), Err("method_unavailable"));
        assert_eq!(read(&["city:v2".into()], "data.read", &json!({"projection":"city","version":2,"windowDays":65566})), Err("invalid_window"));
        assert_eq!(read_for_plugin(&[], "data.read", &json!({"projection":"city","version":3,"operation":"overview","windowDays":30}), "other-plugin"), Err("projection_denied"));
        // Declaring the projection is the grant. The plugin id is not a second gate.
        assert_ne!(read_for_plugin(&["city:v3".into()], "data.read", &json!({"projection":"city","version":3,"operation":"overview","windowDays":30}), "other-plugin"), Err("projection_denied"));
        assert_eq!(read(&[], "harnesses.list", &json!({"version":1})), Err("projection_denied"));
        assert_eq!(read(&["harnesses:v1".into()], "harnesses.list", &json!({"version":2})), Err("unsupported_version"));
    }

    #[test]
    fn plugin_seed_state_preserves_legacy_and_rejects_invalid_writes() {
        let dir = std::env::temp_dir().join(format!("city-state-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(dir.join("state")).unwrap();
        std::fs::write(dir.join("state/city-seed.json"), r#"{"seed":123}"#).unwrap();
        assert_eq!(city_settings_at(&dir, &json!({"action":"read"})).unwrap()["seed"], 123);
        assert_eq!(city_settings_at(&dir, &json!({"action":"write","seed":42})).unwrap()["seed"], 42);
        assert_eq!(city_settings_at(&dir, &json!({"action":"write","seed":0})), Err("invalid_seed"));
        assert_eq!(city_settings_at(&dir, &json!({"action":"read"})).unwrap()["seed"], 42);
        assert_eq!(std::fs::read_to_string(dir.join("state/city-seed.json")).unwrap(), r#"{"seed":123}"#);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
