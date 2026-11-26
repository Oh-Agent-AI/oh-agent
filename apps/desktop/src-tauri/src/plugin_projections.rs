//! Official projection handlers; business dispatch does not belong to PluginHost.
use serde_json::Value;

pub fn session_target(plugin_id: &str, payload: &Value) -> Result<(String, String), &'static str> {
    let handle = payload["handle"].as_str().ok_or("invalid_session_handle")?;
    // Scope is the plugin that received the handle (`app:{plugin_id}:`), not a City special case.
    // PluginHost already requires `navigationTargets` to include `session` before this runs.
    agent_vitals_runtime::query::app_local::plugin_session_target(&crate::overview::data_home(), plugin_id, handle)
}

/// Versioned, non-game projection handlers used when a trusted plugin bundles
/// local display data into an opaque remote gameplay bootstrap.
pub(crate) fn prepare_remote_projection(plugin_id: &str, projection_id: &str, value: &Value) -> Result<Value, &'static str> {
    #[cfg(not(test))]
    let _ = (plugin_id, value);
    match projection_id {
        // Compatibility/parity test baselines only. Production City display
        // projections are created and validated by the trusted TS adapter.
        #[cfg(test)]
        "city-remote-display:v2" if plugin_id == "city" => crate::city_remote_display_projection::prepare_remote_display(value),
        #[cfg(test)]
        "city-dream:v1" if plugin_id == "city" => crate::city_dream_projection::prepare_candidate_envelope(value),
        _ => Err("projection_denied"),
    }
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
    // Key is the projection contract from `dataProjections`. The caller's id only scopes storage.
    // No registered data.read projections yet; harnesses.* are dispatched above.
    let _ = key;
    Err("projection_unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn projections_are_explicitly_scoped_and_windows_bounded() {
        assert_eq!(read(&[], "data.read", &json!({"projection":"city","version":1,"windowDays":30})), Err("projection_denied"));
        assert_eq!(read(&["city:v2".into()], "sql", &json!({})), Err("method_unavailable"));
        assert_eq!(read(&["city:v2".into()], "data.read", &json!({"projection":"city","version":2,"windowDays":30})), Err("projection_unavailable"));
        assert_eq!(read_for_plugin(&[], "data.read", &json!({"projection":"city","version":3,"operation":"overview","windowDays":30}), "other-plugin"), Err("projection_denied"));
        // The retired City projection is unavailable even if a stale descriptor still names it.
        assert_eq!(read_for_plugin(&["city:v3".into()], "data.read", &json!({"projection":"city","version":3,"operation":"overview","windowDays":30}), "other-plugin"), Err("projection_unavailable"));
        assert_eq!(read(&[], "harnesses.list", &json!({"version":1})), Err("projection_denied"));
        assert_eq!(read(&["harnesses:v1".into()], "harnesses.list", &json!({"version":2})), Err("unsupported_version"));
    }

}
