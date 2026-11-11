//! Built-in official UI slot. No dynamic native plugin code or authority access.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Manager, Webview, WebviewBuilder, WebviewUrl};

#[derive(Default)]
pub struct PluginHost(Mutex<HostState>, Mutex<()>);

// Wry's child attachment uses the raw window NSView. A WebviewWindow may
// replace its contentView when creating the host; verify the child actually
// belongs to the displayed window before trusting WebKit visibility/rAF.
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
fn ensure_native_attachment(app: &tauri::AppHandle, view: &Webview) -> Result<(), String> {
    use objc::{msg_send, sel, sel_impl};
    let window = app.get_window("workbench").ok_or("plugin_window_unavailable")?;
    let native = window.ns_window().map_err(|_| "plugin_window_unavailable")? as usize;
    let app = app.clone();
    let id = view.label().to_owned();
    view.with_webview(move |platform| {
        let child = platform.inner() as *mut objc::runtime::Object;
        // CSS only covers committed page pixels. WebKit can expose its own
        // under-page fill while resizing; use the public macOS 12+ property.
        unsafe {
            let supports_fill: bool = msg_send![child, respondsToSelector: sel!(setUnderPageBackgroundColor:)];
            if supports_fill {
                let color: *mut objc::runtime::Object = msg_send![objc::class!(NSColor),
                    colorWithSRGBRed: 22.0_f64 / 255.0 green: 40.0_f64 / 255.0 blue: 61.0_f64 / 255.0 alpha: 1.0_f64];
                let _: () = msg_send![child, setUnderPageBackgroundColor: color];
            }
        }
        let window = native as *mut objc::runtime::Object;
        let attached: *mut objc::runtime::Object = unsafe { msg_send![child, window] };
        let repaired = attached != window;
        if repaired {
            unsafe {
                let content: *mut objc::runtime::Object = msg_send![window, contentView];
                let _: () = msg_send![child, removeFromSuperview];
                let _: () = msg_send![content, addSubview: child];
            }
        }
        let attached: *mut objc::runtime::Object = unsafe { msg_send![child, window] };
        let hidden: bool = unsafe { msg_send![child, isHiddenOrHasHiddenAncestor] };
        let visible: bool = unsafe { msg_send![window, isVisible] };
        let state = app.state::<PluginHost>();
        if let Some(i) = state.0.lock().unwrap().current.as_mut().filter(|i| i.id == id) {
            i.events.push(json!({"atMs": i.started.elapsed().as_millis() as u64,
                "code": "native_attachment", "state": {"attached": attached == window,
                "repaired": repaired, "hiddenAncestor": hidden, "windowVisible": visible}}));
            if i.events.len() > 100 { i.events.remove(0); }
        };
    }).map_err(|_| "plugin_attachment_failed".to_owned())
}

#[cfg(not(target_os = "macos"))]
fn ensure_native_attachment(_: &tauri::AppHandle, _: &Webview) -> Result<(), String> { Ok(()) }

#[derive(Default)]
struct HostState {
    generation: u64,
    current: Option<Instance>,
    watchdog_started: bool,
}

struct Instance {
    id: String,
    plugin_id: String,
    command_namespace: String,
    max_toolbar_items: usize,
    performance_metrics: Vec<String>,
    started: Instant,
    pulse: Instant,
    ready: bool,
    suspended: bool,
    failed: Option<&'static str>,
    revision: u64,
    items: Vec<Tool>,
    sequence: u64,
    pending: Option<(String, Instant)>,
    /// Authorized host round-trips currently in flight. A long `plugin_request`
    /// is liveness, not a hang — the JS heartbeat queue sits behind that IPC.
    in_flight: u32,
    /// Plugin-declared sync-work budget. Heartbeat `busyMs` (capped 15s) holds
    /// the 5s pulse so first-frame compile / vehicle prep can finish honestly.
    busy_until: Option<Instant>,
    events: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDefinition { id: String, name: String, entry: String, command_namespace: String,
    #[serde(default = "default_max_toolbar_items")] max_toolbar_items: usize,
    #[serde(default)] performance_metrics: Vec<String>,
    #[serde(default)] remote_host_entry: Option<String>,
    #[serde(default)] remote_sessions: std::collections::BTreeMap<String, RemoteSessionProfile>,
    #[serde(default)] remote_projection_grants: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default)] remote_projection_passthrough: Vec<String>,
    #[serde(default)] typed_data_grants: std::collections::BTreeMap<String, crate::typed_data::TypedDataGrant>,
    #[serde(default)] legacy_data_grants: std::collections::BTreeMap<String, crate::typed_data::LegacyExportGrant>,
    #[serde(default)] object_grants: std::collections::BTreeMap<String, agent_vitals_runtime::query::object_store::ObjectGrant>,
    #[serde(default)] scope_grants: std::collections::BTreeMap<String, agent_vitals_runtime::query::object_store::ScopeGrant>,
    #[serde(default)] data_projections: Vec<String>, #[serde(default)] allow_local_exports: bool,
    #[serde(default)] navigation_targets: Vec<String>,
    /// 允许的 plugin.state.* 键（如 flight-profile:v1）；描述表声明即边界（游戏模式 §9）。
    #[serde(default)] state_keys: Vec<String>,
    /// 活动插件可接收的通用宿主事件通道。未声明则不投递，不按插件 id 判断。
    #[serde(default)] host_events: Vec<String>,
    /// 本机 request/reply 能力白名单。Host 只转发 opaque payload，不解释业务字段。
    #[serde(default)] local_calls: Vec<String>,
    #[serde(default)] remote_capabilities: Vec<crate::remote_protocol::RemoteCapability> }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSessionProfile {
    pub version: u16,
    pub bootstrap_method: String,
    #[serde(default)] pub approval_method: Option<String>,
    #[serde(default)] pub stop_method: Option<String>,
    pub stop_policy: String,
    pub max_bootstrap_bytes: usize,
    pub links: crate::remote_registry::RemoteLinkSpec,
}

fn default_max_toolbar_items() -> usize { 10 }

fn valid_performance_metric(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-'))
}

impl RemoteSessionProfile {
    fn is_valid(&self, capability: &crate::remote_protocol::RemoteCapability) -> bool {
        let method = |value: &str| !value.is_empty() && value.len() <= 80
            && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'));
        let link = &self.links;
        let query_key = |value: &str| !value.is_empty() && value.len() <= 32
            && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let owner_keys = [Some(link.session_param.as_str()), Some(link.player_param.as_str()), Some(link.websocket_param.as_str()), Some(link.access_param.as_str()), Some(link.device_param.as_str()), link.owner_secret_param.as_deref(), link.owner_capability_param.as_deref()];
        let owner_keys: Vec<_> = owner_keys.into_iter().flatten().collect();
        let invite_keys = [Some(link.session_param.as_str()), Some(link.invitation_room_param.as_str()), Some(link.invitation_id_param.as_str()), link.invitation_secret_param.as_deref(), link.invitation_capability_param.as_deref()];
        let invite_keys: Vec<_> = invite_keys.into_iter().flatten().collect();
        let methods = [Some(self.bootstrap_method.as_str()), self.approval_method.as_deref(), self.stop_method.as_deref()];
        let methods: Vec<_> = methods.into_iter().flatten().collect();
        self.version == 1 && method(&self.bootstrap_method)
            && self.approval_method.as_deref().is_none_or(method)
            && self.stop_method.as_deref().is_none_or(method)
            && self.stop_policy == if self.stop_method.is_some() { "freezeSnapshot" } else { "closeOnly" }
            && self.max_bootstrap_bytes > 0 && self.max_bootstrap_bytes <= 256 * 1024
            && link.path.starts_with('/') && !link.path.starts_with("//") && link.path.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-'))
            && [link.session_param.as_str(), link.player_param.as_str(), link.websocket_param.as_str(), link.access_param.as_str(), link.device_param.as_str(), link.invitation_room_param.as_str(), link.invitation_id_param.as_str()].iter().all(|key| query_key(key))
            && [link.owner_secret_param.as_deref(), link.invitation_secret_param.as_deref(), link.owner_capability_param.as_deref(), link.invitation_capability_param.as_deref()].iter().flatten().all(|key| query_key(key))
            && owner_keys.iter().all(|key| query_key(key)) && owner_keys.iter().collect::<std::collections::BTreeSet<_>>().len() == owner_keys.len()
            && invite_keys.iter().all(|key| query_key(key)) && invite_keys.iter().collect::<std::collections::BTreeSet<_>>().len() == invite_keys.len()
            && methods.iter().collect::<std::collections::BTreeSet<_>>().len() == methods.len()
            && capability.is_valid()
    }
}

#[derive(Deserialize)]
struct PluginRegistry { version: u16, plugins: Vec<PluginDefinition> }

fn definitions() -> &'static [PluginDefinition] {
    static REGISTRY: OnceLock<PluginRegistry> = OnceLock::new();
    &REGISTRY.get_or_init(|| {
        let registry: PluginRegistry = serde_json::from_str(include_str!("../../plugins.json")).expect("official plugin registry");
        assert_eq!(registry.version, 1);
        let mut ids = std::collections::BTreeSet::new();
        for plugin in &registry.plugins {
            assert!(!plugin.id.is_empty() && plugin.id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') && ids.insert(&plugin.id));
            assert!(!plugin.name.is_empty() && !plugin.command_namespace.is_empty());
            assert!((1..=20).contains(&plugin.max_toolbar_items), "invalid plugin toolbar item limit");
            let mut performance_metrics = std::collections::BTreeSet::new();
            assert!(plugin.performance_metrics.len() <= 16 && plugin.performance_metrics.iter().all(|metric|
                valid_performance_metric(metric) && performance_metrics.insert(metric)), "invalid plugin performance metric grant");
            assert!(plugin.entry.starts_with("plugins/") && plugin.entry.ends_with("/ui/index.html") && !plugin.entry.contains(".."));
            if let Some(entry) = &plugin.remote_host_entry {
                assert!(entry.starts_with("plugins/") && entry.ends_with("/ui/remote.html") && !entry.contains(".."));
            }
            let mut capabilities = std::collections::BTreeSet::new();
            for capability in &plugin.remote_capabilities {
                assert!(capability.is_valid() && capabilities.insert(&capability.id));
            }
            for (capability_id, profile) in &plugin.remote_sessions {
                let capability = plugin.remote_capabilities.iter().find(|capability| capability.id == *capability_id)
                    .expect("remote session profile capability must be declared");
                assert!(profile.is_valid(capability), "invalid trusted remote session profile");
            }
            for (capability_id, projections) in &plugin.remote_projection_grants {
                assert!(plugin.remote_capabilities.iter().any(|capability| &capability.id == capability_id));
                assert!(!projections.is_empty());
                let mut unique = std::collections::BTreeSet::new();
                assert!(projections.iter().all(|projection| (plugin.data_projections.contains(projection) || plugin.remote_projection_passthrough.contains(projection))
                    && !projection.is_empty() && projection.len() <= 80
                    && projection.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
                    && unique.insert(projection)));
            }
            let mut passthrough_unique = std::collections::BTreeSet::new();
            assert!(plugin.remote_projection_passthrough.iter().all(|projection| {
                !projection.is_empty() && projection.len() <= 80
                    && projection.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
                    && passthrough_unique.insert(projection)
                    && plugin.remote_projection_grants.values().any(|grants| grants.contains(projection))
            }));
            for (dataset_id, grant) in &plugin.typed_data_grants {
                assert!(grant.is_valid(dataset_id), "invalid trusted typed-data grant");
            }
            for (dataset_id, grant) in &plugin.legacy_data_grants {
                assert!(grant.is_valid(dataset_id), "invalid trusted legacy data export grant");
            }
            for (object_type, grant) in &plugin.object_grants {
                assert!(grant.validate_for(object_type).is_ok(), "invalid trusted typed-object grant");
            }
            for (scope_type, grant) in &plugin.scope_grants {
                assert!(grant.validate_for(scope_type, &plugin.object_grants).is_ok(), "invalid trusted typed-object scope grant");
            }
            let mut local_call_methods = std::collections::BTreeSet::new();
            assert!(plugin.local_calls.len() <= 128 && plugin.local_calls.iter().all(|method| {
                !method.is_empty() && method.len() <= 96
                    && method.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
                    && local_call_methods.insert(method)
            }), "invalid trusted local-call grant");
        }
        registry
    }).plugins
}

/// Returns a trusted built-in plugin asset path for the generic remote host.
/// The path comes only from the packaged plugin registry, never from IPC data.
pub(crate) fn remote_host_entry(plugin_id: &str) -> Option<String> {
    definitions().iter().find(|plugin| plugin.id == plugin_id).and_then(|plugin| plugin.remote_host_entry.clone())
}

/// A packaged, versioned host-session contract. It supplies only transport
/// lifecycle and link shape; application payloads stay opaque to Rust.
pub(crate) fn remote_session_profile(plugin_id: &str, capability_id: &str) -> Option<RemoteSessionProfile> {
    let plugin = definitions().iter().find(|plugin| plugin.id == plugin_id)?;
    let capability = plugin.remote_capabilities.iter().find(|capability| capability.id == capability_id)?;
    let profile = plugin.remote_sessions.get(capability_id)?;
    profile.is_valid(capability).then(|| profile.clone())
}

/// Exact capability descriptors are grants from the packaged built-in plugin registry.
pub(crate) fn remote_capability(plugin_id: &str, capability_id: &str) -> Option<crate::remote_protocol::RemoteCapability> {
    definitions().iter().find(|plugin| plugin.id == plugin_id)?
        .remote_capabilities.iter().find(|capability| capability.id == capability_id && capability.is_valid()).cloned()
}

/// A remote host remains bound to the exact built-in plugin instance that
/// started it. Suspended tabs retain their instance; failed or replaced ones
/// lose authority immediately.
pub(crate) fn remote_owner_instance_alive(app: &tauri::AppHandle, plugin_id: &str, instance_id: &str) -> bool {
    let host = app.state::<PluginHost>();
    let alive = host.0.lock().unwrap().current.as_ref().is_some_and(|instance| {
        instance.id == instance_id && instance.plugin_id == plugin_id && instance.failed.is_none()
    });
    alive
}

fn attach_remote_owner(payload: &Value, instance_id: &str) -> Result<Value, &'static str> {
    let mut payload = payload.clone();
    let object = payload.as_object_mut().ok_or("remote_forbidden")?;
    object.insert("__hostOwnerInstanceId".into(), Value::String(instance_id.to_owned()));
    Ok(payload)
}

/// Enforces descriptor-scoped projection grants and generic resource limits
/// before a bootstrap enters the relay. App projections marked passthrough are
/// already produced and validated by their trusted TypeScript adapter.
pub(crate) fn prepare_remote_bootstrap(plugin_id: &str, capability_id: &str, payload: &Value) -> Result<Value, &'static str> {
    let plugin = definitions().iter().find(|plugin| plugin.id == plugin_id).ok_or("remote_forbidden")?;
    let bootstrap = payload.get("bootstrap").filter(|value| value.is_object()).ok_or("remote_match_invalid")?;
    let mut sanitized = bootstrap.clone();
    if let Some(projections) = bootstrap.get("projections") {
        let values = projections.as_array().ok_or("projection_denied")?;
        let allowed = plugin.remote_projection_grants.get(capability_id).map(Vec::as_slice).unwrap_or(&[]);
        let mut seen = std::collections::BTreeSet::new();
        let mut output = Vec::with_capacity(values.len());
        let mut declared = Vec::with_capacity(values.len());
        for projection in values {
            let object = projection.as_object().filter(|object| object.len() == 2 && object.contains_key("id") && object.contains_key("value")).ok_or("projection_denied")?;
            let id = object.get("id").and_then(Value::as_str).ok_or("projection_denied")?;
            if !allowed.iter().any(|grant| grant == id) || !seen.insert(id.to_owned()) { return Err("projection_denied"); }
            declared.push((id, object.get("value").ok_or("projection_denied")?));
        }
        for (id, candidate) in declared {
            let value = if plugin.remote_projection_passthrough.iter().any(|projection| projection == id) {
                // The trusted TypeScript application adapter owns this payload's
                // business contract. Rust enforces descriptor grant and overall
                // bootstrap bounds, then treats the projection as opaque.
                if !candidate.is_object() { return Err("projection_denied"); }
                candidate.clone()
            } else {
                crate::plugin_projections::prepare_remote_projection(plugin_id, id, candidate)?
            };
            output.push(serde_json::json!({"id":id,"value":value}));
        }
        sanitized["projections"] = Value::Array(output);
    }
    let bytes = serde_json::to_vec(&sanitized).map_err(|_| "remote_match_invalid")?;
    if bytes.len() > 256 * 1024 { return Err("remote_match_too_large"); }
    Ok(sanitized)
}

/// Linux WebKitGTK: `.incognito(true)` makes wry ignore the shared WebContext
/// and build an ephemeral one. tauri-runtime-wry then skips custom-protocol
/// registration (those schemes are already marked on the host context), so the
/// child loads `tauri://localhost/…` with no handler and WebKit shows
/// "The URL can't be shown". The host later maps a failed `set_bounds` / boot
/// timeout onto `plugin_layout_failed`.
///
/// A dedicated data directory gives the plugin its own WebContext so protocols
/// are registered, and incognito stays off so that context is actually used
/// (retries reuse it). macOS WKWebView does not have this skip, so it keeps
/// the non-persistent store.
pub(crate) fn apply_plugin_webview_platform(app: &tauri::AppHandle, builder: WebviewBuilder<tauri::Wry>) -> WebviewBuilder<tauri::Wry> {
    #[cfg(target_os = "linux")]
    {
        let dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir()).join("plugin-webview");
        if let Err(error) = std::fs::create_dir_all(&dir) {
            agent_vitals_runtime::logging::log_warn("plugin_host", &format!("plugin webview data dir: {error}"));
        }
        builder.data_directory(dir).incognito(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        builder.incognito(true)
    }
}

fn set_plugin_bounds(view: &Webview, bounds: &Bounds) -> Result<(), String> {
    view.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
    }).map_err(|error| {
        agent_vitals_runtime::logging::log_error("plugin_host", &format!("set_bounds failed: {error}"));
        "plugin_layout_failed".into()
    })
}

fn native_create_failure_code(error: &tauri::Error) -> &'static str {
    match error {
        tauri::Error::AssetNotFound(_) => "plugin_assets_missing",
        tauri::Error::WebviewLabelAlreadyExists(_) => "plugin_instance_conflict",
        tauri::Error::InvalidWindowHandle | tauri::Error::WindowNotFound => "plugin_parent_unavailable",
        tauri::Error::Runtime(_) => "plugin_webview_create_failed",
        _ => "plugin_create_failed",
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    id: String,
    command_id: String,
    label: String,
    kind: String,
    enabled: bool,
    #[serde(default)]
    placement: Option<String>,
    value: Option<String>,
    #[serde(default)]
    options: Vec<Choice>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Choice { value: String, label: String }

#[derive(Deserialize)]
pub struct Bounds { x: f64, y: f64, width: f64, height: f64 }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequestV1 {
    pub(crate) version: u16,
    pub(crate) instance_id: String,
    pub(crate) request_id: String,
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) payload: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResponseV1 {
    pub(crate) version: u16,
    pub(crate) request_id: String,
    pub(crate) ok: bool,
    pub(crate) result: Option<Value>,
    pub(crate) error: Option<PluginRequestErrorV1>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequestErrorV1 {
    pub(crate) code: &'static str,
    pub(crate) retryable: bool,
}

fn plugin_request_error(request_id: String, code: &'static str, retryable: bool) -> PluginResponseV1 {
    PluginResponseV1 {
        version: 1,
        request_id,
        ok: false,
        result: None,
        error: Some(PluginRequestErrorV1 { code, retryable }),
    }
}

fn validate_plugin_request(request: &PluginRequestV1) -> Result<(), &'static str> {
    if request.version != 1 { return Err("unsupported_version"); }
    if request.request_id.is_empty() || request.request_id.len() > 64
        || request.method.is_empty() || request.method.len() > 100 || !request.payload.is_object() {
        return Err("invalid_request");
    }
    Ok(())
}

fn valid_bounds(bounds: &Bounds) -> bool {
    [bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|v| v.is_finite())
        && bounds.x >= 0.0 && bounds.y >= 0.0 && bounds.width >= 1.0 && bounds.height >= 1.0
}

fn host_only(view: &Webview) -> Result<(), String> {
    if view.label() == "workbench" { Ok(()) } else { Err("plugin_host_only".into()) }
}

/// P0 layout sync instrumentation: records jsToRxMs / rxToSetMs per bounds update.
fn note_layout_sync(instance: &mut Instance, js_to_rx_ms: u64, rx_to_set_ms: u64, seq: u64) {
    if instance.events.len() == 100 { instance.events.remove(0); }
    instance.events.push(json!({
        "atMs": instance.started.elapsed().as_millis() as u64,
        "code": "layout_sync",
        "jsToRxMs": js_to_rx_ms,
        "rxToSetMs": rx_to_set_ms,
        "seq": seq,
    }));
    persist_diagnostics(instance);
}

fn note(instance: &mut Instance, code: &str) {
    if instance.events.len() == 100 { instance.events.remove(0); }
    instance.events.push(json!({"atMs": instance.started.elapsed().as_millis() as u64, "code": code,
        "requestId": instance.pending.as_ref().map(|(id, _)| id)}));
    persist_diagnostics(instance);
}

fn persist_diagnostics(instance: &Instance) {
    // Bounded local technical state only; never serialize message payloads/data.
    let report = json!({"instanceId": instance.id, "ready": instance.ready,
        "pulseAgeMs": instance.pulse.elapsed().as_millis() as u64, "events": instance.events});
    if let Ok(bytes) = serde_json::to_vec(&report) {
        let _ = std::fs::write(std::env::temp_dir().join("agent-vitals-plugin-diagnostics.json"), bytes);
    }
}

fn valid_tools(namespace: &str, max_items: usize, items: &[Tool]) -> bool {
    let mut ids = std::collections::BTreeSet::new();
    items.len() <= max_items && items.iter().all(|item| {
        !item.id.is_empty() && item.id.len() <= 64 && ids.insert(&item.id)
            && item.command_id.starts_with(&format!("{namespace}.")) && item.command_id.len() <= 64
            && !item.label.is_empty() && item.label.len() <= 100
            && (item.kind == "button" || (item.kind == "select" && !item.options.is_empty()
                && item.options.len() <= 8 && item.options.iter().all(|o| o.value.len() <= 32 && o.label.len() <= 100)
                && item.options.iter().any(|o| Some(&o.value) == item.value.as_ref())))
    })
}

fn refresh_fault(i: &mut Instance) -> bool {
    if i.suspended { return false; }
    if i.failed.is_some() { return false; }
    if i.in_flight > 0 { return false; }
    if i.busy_until.is_some_and(|until| Instant::now() < until) { return false; }
    let fault = if !i.ready && i.started.elapsed() > Duration::from_secs(15) { Some("plugin_boot_timeout") }
        else if i.ready && i.pulse.elapsed() > Duration::from_secs(5) { Some("plugin_unresponsive") }
        else if i.pending.as_ref().is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(5)) { Some("plugin_command_timeout") }
        else { None };
    if let Some(code) = fault { i.failed = Some(code); note(i, code); return true; }
    false
}

fn begin_activity(host: &PluginHost, id: &str) {
    let mut guard = host.0.lock().unwrap();
    if let Some(i) = guard.current.as_mut().filter(|i| i.id == id) {
        i.in_flight = i.in_flight.saturating_add(1);
        i.pulse = Instant::now();
    }
}

struct ActivityGuard { app: tauri::AppHandle, id: String }
impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let host = self.app.state::<PluginHost>();
        let mut guard = host.0.lock().unwrap();
        if let Some(i) = guard.current.as_mut().filter(|i| i.id == self.id) {
            i.in_flight = i.in_flight.saturating_sub(1);
            i.pulse = Instant::now();
        }
    }
}

fn notify_host(app: &tauri::AppHandle) {
    if let Some(view) = app.get_webview("workbench") {
        let _ = view.eval("window.dispatchEvent(new Event('__AV_PLUGIN_STATUS__'))");
    }
}

const HOST_EVENT_MAX_BYTES: usize = 64 * 1024;
const HOST_EVENT_DEDUPE_CAPACITY: usize = 256;
static HOST_EVENTS_DELIVERED: OnceLock<Mutex<std::collections::VecDeque<String>>> = OnceLock::new();
static HOST_EVENT_CURSORS: OnceLock<Mutex<std::collections::BTreeMap<String, (String, i64)>>> = OnceLock::new();

fn subscriber_view(app: &tauri::AppHandle, event: &str) -> Option<(String, String)> {
    let host = app.state::<PluginHost>();
    let guard = host.0.lock().unwrap();
    let instance = guard.current.as_ref()?;
    if !instance.ready || instance.failed.is_some() || instance.suspended { return None; }
    let subscribed = definitions().iter().find(|plugin| plugin.id == instance.plugin_id)
        .is_some_and(|plugin| plugin.host_events.iter().any(|name| name == event));
    if subscribed { Some((instance.id.clone(), instance.plugin_id.clone())) } else { None }
}

fn deliver_host_payload(app: &tauri::AppHandle, expected_plugin_id: &str, payload: &serde_json::Value) -> bool {
    if !payload.is_object() { return false; }
    let envelope = serde_json::json!({"version":1,"source":"host","payload":payload});
    let Ok(bytes) = serde_json::to_vec(&envelope) else { return false; };
    if bytes.len() > HOST_EVENT_MAX_BYTES { return false; }
    let digest = {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(expected_plugin_id.as_bytes());
        hasher.update([0]);
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    };
    let Some((id, plugin_id)) = subscriber_view(app, "plugin.event") else { return false; };
    if plugin_id != expected_plugin_id { return false; }
    let Some(view) = app.get_webview(&id) else { return false; };
    let delivered = HOST_EVENTS_DELIVERED.get_or_init(|| Mutex::new(std::collections::VecDeque::new()));
    let mut delivered = delivered.lock().unwrap();
    if delivered.iter().any(|previous| previous == &digest) { return true; }
    let Ok(encoded_envelope) = serde_json::to_string(&envelope) else { return false; };
    let Ok(js_string) = serde_json::to_string(&encoded_envelope) else { return false; };
    let script = format!("window.dispatchEvent(new CustomEvent('__AV_PLUGIN_EVENT__', {{detail: JSON.parse({js_string})}}));");
    if view.eval(script).is_err() { return false; }
    delivered.push_back(digest);
    if delivered.len() > HOST_EVENT_DEDUPE_CAPACITY { delivered.pop_front(); }
    agent_vitals_runtime::logging::log_info("plugin_host", "generic plugin event delivered");
    true
}

/// Poll the generic plugin-scoped local event port. A new WebView instance
/// starts at the high-water mark and never replays another instance's queue.
fn poll_plugin_event_queue(app: &tauri::AppHandle) {
    let Some((instance_id, plugin_id)) = subscriber_view(app, "plugin.event") else { return; };
    let home = crate::overview::data_home();
    let cursors = HOST_EVENT_CURSORS.get_or_init(|| Mutex::new(std::collections::BTreeMap::new()));
    let mut cursors = cursors.lock().unwrap();
    let cursor = cursors.entry(plugin_id.clone()).or_insert_with(|| {
        (instance_id.clone(), agent_vitals_runtime::query::plugin_events::latest_cursor(&home, &plugin_id).unwrap_or(0))
    });
    if cursor.0 != instance_id {
        cursor.0 = instance_id.clone();
        cursor.1 = agent_vitals_runtime::query::plugin_events::latest_cursor(&home, &plugin_id).unwrap_or(cursor.1);
    }
    let Ok(events) = agent_vitals_runtime::query::plugin_events::page_after(&home, &plugin_id, cursor.1, 64) else { return; };
    for event in events {
        if !deliver_host_payload(app, &plugin_id, &event.payload) { break; }
        cursor.1 = event.sequence;
    }
}

/// Deliver only descriptor-authorized pending local calls to the current
/// plugin instance. The request store and event envelope are app-neutral.
fn poll_plugin_call_queue(app: &tauri::AppHandle) {
    let Some((instance_id, plugin_id)) = subscriber_view(app, "plugin.event") else { return; };
    let Some(definition) = definitions().iter().find(|plugin| plugin.id == plugin_id) else { return; };
    if definition.local_calls.is_empty() { return; }
    let home = crate::overview::data_home();
    let _ = agent_vitals_runtime::query::plugin_calls::release_orphaned_claims(&home, &plugin_id, &instance_id);
    let Ok(calls) = agent_vitals_runtime::query::plugin_calls::claim_pending(
        &home, &plugin_id, &instance_id, &definition.local_calls, 8,
    ) else { return; };
    for (index, call) in calls.iter().enumerate() {
        if !deliver_host_payload(app, &plugin_id, &json!({"kind":"plugin.call.request", "call":call})) {
            for pending in &calls[index..] {
                if let Some(call_id) = pending["callId"].as_str() {
                    let _ = agent_vitals_runtime::query::plugin_calls::release_claim(&home, &plugin_id, &instance_id, call_id);
                }
            }
            break;
        }
    }
}

fn start_watchdog(app: &tauri::AppHandle, state: &PluginHost) {
    let mut host = state.0.lock().unwrap();
    if host.watchdog_started { return; }
    host.watchdog_started = true;
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let faulted_instance = {
            let state = app.state::<PluginHost>();
            let mut host = state.0.lock().unwrap();
            if let Some(instance) = host.current.as_mut() {
                if refresh_fault(instance) { Some(instance.id.clone()) } else { None }
            } else { None }
        };
        if let Some(instance_id) = faulted_instance {
            crate::remote_gateway::close_sessions_for_instance(&app, &instance_id);
            notify_host(&app);
        }
        poll_plugin_event_queue(&app);
        poll_plugin_call_queue(&app);
    });
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command arguments are the stable frontend IPC surface.
pub async fn plugin_open(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, plugin_id: String, bounds: Bounds, restart: bool, instance_id: Option<String>, locale: Option<String>, bounds_only: Option<bool>, js_ts: Option<f64>, seq: Option<u64>) -> Result<String, String> {
    let t_rx_instant = std::time::Instant::now();
    let t_rx_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    host_only(&webview)?;
    let bounds_only = bounds_only.unwrap_or(false);
    if bounds_only && (restart || instance_id.is_none()) { return Err("plugin_instance_mismatch".into()); }
    let definition = definitions().iter().find(|plugin| plugin.id == plugin_id).ok_or("plugin_unknown")?;
    // Unspecified locale follows the system language; unsupported systems fall back to English.
    let locale = match locale.as_deref() {
        Some("zh-Hans") => "zh-Hans",
        Some("en") => "en",
        _ => match crate::system_ui_language() {
            crate::NativeUiLanguage::Chinese => "zh-Hans",
            crate::NativeUiLanguage::English => "en",
        },
    };
    let _operation = state.1.lock().unwrap();
    start_watchdog(&app, &state);
    if !app.asset_resolver().iter().any(|(key, _)| key.trim_start_matches('/') == definition.entry) {
        return Err("plugin_assets_missing".into());
    }
    if ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|v| v.is_finite())
        || bounds.x < 0.0 || bounds.y < 0.0 || bounds.width < 1.0 || bounds.height < 1.0 {
        return Err("plugin_bounds_invalid".into());
    }
    let current_id = {
        let host = state.0.lock().unwrap();
        if !restart {
            if host.current.as_ref().is_some_and(|i| i.plugin_id != plugin_id) { return Err("plugin_instance_mismatch".into()); }
            if instance_id.as_ref().is_some_and(|id| !host.current.as_ref().is_some_and(|i| &i.id == id)) { return Err("plugin_instance_mismatch".into()); }
            host.current.as_ref().map(|i| i.id.clone())
        } else { None }
    };
    // Never hold the state lock while scheduling native main-thread operations.
    if let Some(id) = current_id {
        if let Some(view) = app.get_webview(&id) {
            if bounds_only && state.0.lock().unwrap().current.as_ref().is_some_and(|i| i.suspended || i.failed.is_some()) {
                return Err("plugin_instance_unavailable".into());
            }
            set_plugin_bounds(&view, &bounds)?;
            // P0: record layout sync timing on the hot bounds-only path.
            // js_ts is an epoch-ms timestamp from the frontend (performance.timeOrigin + performance.now()).
            if bounds_only {
                let rx_to_set = t_rx_instant.elapsed().as_millis() as u64;
                let js_to_rx = js_ts
                    .map(|ts| t_rx_epoch.saturating_sub(ts as u64))
                    .unwrap_or(0);
                if let Some(i) = state.0.lock().unwrap().current.as_mut() {
                    note_layout_sync(i, js_to_rx, rx_to_set, seq.unwrap_or(0));
                }
                return Ok(id);
            }
            view.show().map_err(|error| {
                agent_vitals_runtime::logging::log_error("plugin_host", &format!("show failed: {error}"));
                "plugin_layout_failed"
            })?;
            ensure_native_attachment(&app, &view)?;
            let _ = view.eval(format!("window.__AV_PLUGIN_LOCALE__ = '{}'; window.dispatchEvent(new Event('__AV_PLUGIN_LOCALE_CHANGED__'));", locale));
            let _ = view.eval("window.dispatchEvent(new Event('__AV_PLUGIN_RESUMED__'))");
            if let Some(i) = state.0.lock().unwrap().current.as_mut() {
                if i.suspended { i.suspended = false; i.pulse = Instant::now(); if !i.ready { i.started = Instant::now(); } note(i, "resumed"); }
            }
            return Ok(id);
        }
    }
    if bounds_only { return Err("plugin_instance_unavailable".into()); }
    let old = state.0.lock().unwrap().current.take();
    if let Some(old) = old {
        crate::remote_gateway::close_sessions_for_instance(&app, &old.id);
        if let Some(view) = app.get_webview(&old.id) {
            agent_vitals_runtime::logging::log_warn("plugin_host", &format!("view.close() [replace] id={}", old.id));
            let _ = view.close();
        }
    }
    let id = {
        let mut host = state.0.lock().unwrap();
        host.generation += 1;
        let id = format!("plugin-{}-{}", definition.id, host.generation);
        let mut current = Instance { id: id.clone(), plugin_id: definition.id.clone(), command_namespace: definition.command_namespace.clone(), max_toolbar_items: definition.max_toolbar_items, performance_metrics: definition.performance_metrics.clone(), started: Instant::now(), pulse: Instant::now(), ready: false, suspended: false,
            failed: None, revision: 0, items: Vec::new(), sequence: 0, pending: None, in_flight: 0, busy_until: None, events: Vec::new() };
        note(&mut current, "create_started");
        host.current = Some(current);
        id
    };
    let initialization = format!("window.__AV_PLUGIN_INSTANCE__ = {}; window.__AV_PLUGIN_LOCALE__ = '{}';", serde_json::to_string(&id).unwrap(), locale);
    let allow_local_exports = definition.allow_local_exports;
    let builder = apply_plugin_webview_platform(&app, WebviewBuilder::new(&id, WebviewUrl::App(definition.entry.clone().into()))
        // Resize white flash: the WebView's own NSView background must match
        // the City theme's dark surface, not the system default white.
        .background_color(tauri::utils::config::Color(22, 40, 61, 255))
        // An active child shares a window with the host WebView. WebKit's
        // inactive scheduling must not suspend its health timer/first frame.
        // Leaving the tab hides/pauses the retained instance.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled))
        .initialization_script(initialization)
        .on_download(move |view, event| {
            if let tauri::webview::DownloadEvent::Requested { url, destination } = event {
                if !allow_local_exports || url.scheme() != "blob" { return false; }
                let valid = view.app_handle().state::<PluginHost>().0.lock().unwrap().current.as_ref()
                    .is_some_and(|i| i.id == view.label() && i.failed.is_none());
                if !valid { return false; }
                let filename = destination.file_name().and_then(|n| n.to_str()).unwrap_or("plugin-export");
                // rfd 0.15's synchronous macOS path starts a sheet and then
                // runModal when parented; keep the tested non-sheet dialog path.
                let Some(path) = rfd::FileDialog::new().set_file_name(filename).save_file() else { return false; };
                // The native modal can outlive the requesting plugin instance.
                let valid = view.app_handle().state::<PluginHost>().0.lock().unwrap().current.as_ref()
                    .is_some_and(|i| i.id == view.label() && i.failed.is_none());
                if !valid { return false; }
                *destination = path;
            }
            true
        })
        .on_page_load(|view, payload| {
            let state = view.app_handle().state::<PluginHost>();
            let mut host = state.0.lock().unwrap();
            if let Some(i) = host.current.as_mut().filter(|i| i.id == view.label()) {
                if payload.event() == tauri::webview::PageLoadEvent::Started && i.ready {
                    i.failed = Some("plugin_reloaded"); note(i, "plugin_reloaded");
                } else { note(i, "view_load"); }
            }
        });
    #[cfg(all(feature = "plugin-isolation-probe", target_os = "macos"))]
    let builder = if std::env::args().any(|arg| arg == "--mecha-v15-local-test") {
        builder.initialization_script("window.__AV_V15_LOCAL_TEST__ = true;")
    } else {
        builder.initialization_script(crate::plugin_isolation_probe::OBSERVER)
    };
    // The interactive fixture starts with a fixed seed instead of rebuilding the
    // synthetic city after the WebView has already loaded.
    #[cfg(all(feature = "plugin-isolation-probe", target_os = "macos"))]
    let builder = if std::env::args().any(|arg| arg == "--plugin-formal-v15-probe" || arg == "--plugin-formal-v15-resume" || arg == "--plugin-formal-v15-status-probe" || arg == "--plugin-formal-v15-status-resume") {
        let status_setup = std::env::args().any(|arg| arg == "--plugin-formal-v15-status-probe" || arg == "--plugin-formal-v15-status-resume");
        let script = if status_setup {
            "localStorage.setItem('city.seed', '4196523069'); window.__AV_PLUGIN_LOCALE__ = 'zh-Hans'; window.__AV_V15_PROBE__ = true; const statusUrl = new URL(location.href); statusUrl.searchParams.set('mechaStatus', 'prism_warden'); history.replaceState(null, '', statusUrl.toString());"
        } else {
            "localStorage.setItem('city.seed', '4196523069'); window.__AV_PLUGIN_LOCALE__ = 'zh-Hans'; window.__AV_V15_PROBE__ = true;"
        };
        builder.initialization_script(script)
    } else if std::env::args().any(|arg| arg == "--plugin-formal-mecha-interactive") {
        builder.initialization_script("localStorage.setItem('city.seed', '4196523069');")
    } else if std::env::args().any(|arg| arg == "--plugin-formal-mecha-probe") {
        // Distinct, synthetic initial seed: the automatic probe must exercise a
        // real change rather than merely applying the value already in storage.
        builder.initialization_script("localStorage.setItem('city.seed', '74031');")
    } else { builder };
    agent_vitals_runtime::logging::log_info("plugin_host", &format!("add_child id={id} entry={}", definition.entry));
    let result = app.get_window("workbench").ok_or("plugin_window_unavailable")?.add_child(
        builder,
        tauri::LogicalPosition::new(bounds.x, bounds.y), tauri::LogicalSize::new(bounds.width, bounds.height),
    );
    let view = match result {
        Ok(view) => view,
        Err(error) => {
            let code = native_create_failure_code(&error);
            agent_vitals_runtime::logging::log_error("plugin_host", &format!("native child WebView creation failed ({code}): {error}"));
            if let Some(current) = state.0.lock().unwrap().current.as_mut() {
                current.failed = Some(code);
                note(current, code);
            }
            return Err(code.into());
        }
    };
    ensure_native_attachment(&app, &view)?;
    let _ = view.set_focus();
    Ok(id)
}

/// P1: lightweight bounds-only command — no asset check, no watchdog, no show(),
/// no eval, no operation lock. Synchronous (reduces scheduling hops vs async).
#[tauri::command]
pub fn plugin_set_bounds(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, PluginHost>,
    instance_id: String,
    bounds: Bounds,
    seq: Option<u64>,
) -> Result<(), String> {
    host_only(&webview)?;
    if !valid_bounds(&bounds) { return Err("plugin_bounds_invalid".into()); }
    let current_id = {
        let host = state.0.lock().unwrap();
        let instance = host.current.as_ref().ok_or("plugin_instance_mismatch")?;
        if instance.id != instance_id { return Err("plugin_instance_mismatch".into()); }
        if instance.suspended || instance.failed.is_some() { return Err("plugin_instance_unavailable".into()); }
        instance.id.clone()
    };
    if let Some(view) = app.get_webview(&current_id) {
        let t_start = std::time::Instant::now();
        set_plugin_bounds(&view, &bounds)?;
        let rx_to_set = t_start.elapsed().as_millis() as u64;
        if let Some(i) = state.0.lock().unwrap().current.as_mut() {
            note_layout_sync(i, 0, rx_to_set, seq.unwrap_or(0));
        }
        Ok(())
    } else {
        Err("plugin_instance_mismatch".into())
    }
}

#[tauri::command]
pub async fn plugin_close(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, instance_id: String, suspend: Option<bool>) -> Result<(), String> {
    host_only(&webview)?;
    let _operation = state.1.lock().unwrap();
    agent_vitals_runtime::logging::log_info("plugin_host", &format!("plugin_close entry id={instance_id} suspend={suspend:?}"));
    if suspend == Some(true) {
        let valid = {
            let mut host = state.0.lock().unwrap();
            if let Some(i) = host.current.as_mut().filter(|i| i.id == instance_id && i.failed.is_none()) {
                i.suspended = true; i.pending = None; note(i, "suspended"); true
            } else { false }
        };
        if valid {
            if let Some(view) = app.get_webview(&instance_id) {
                let _ = view.eval("window.dispatchEvent(new Event('__AV_PLUGIN_SUSPENDED__'))");
                view.hide().map_err(|_| "plugin_hide_failed")?;
            }
            return Ok(());
        }
    }
    let old = {
        let mut host = state.0.lock().unwrap();
        if host.current.as_ref().is_some_and(|i| i.id == instance_id) { host.current.take() } else { None }
    };
    if let Some(old) = old {
        crate::remote_gateway::close_sessions_for_instance(&app, &old.id);
        if let Some(view) = app.get_webview(&old.id) {
            agent_vitals_runtime::logging::log_warn("plugin_host", &format!("view.close() [plugin_close] id={}", old.id));
            view.close().map_err(|_| "plugin_close_failed")?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_snapshot(webview: Webview, state: tauri::State<'_, PluginHost>) -> Result<Value, String> {
    host_only(&webview)?;
    let mut host = state.0.lock().unwrap();
    let Some(i) = host.current.as_mut() else { return Ok(Value::Null); };
    refresh_fault(i);
    Ok(json!({"pluginId": i.plugin_id, "instanceId": i.id, "status": if i.failed.is_some() { "failed" } else if i.ready { "ready" } else { "loading" },
        "error": i.failed, "revision": i.revision, "items": i.items, "pending": i.pending.as_ref().map(|(id, _)| id), "events": i.events}))
}

#[tauri::command]
pub fn plugin_message(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, message: Value) -> Result<(), String> {
    let changed = message["type"] != "heartbeat" && message["type"] != "plugin.performance";
    let mut host = state.0.lock().unwrap();
    let i = host.current.as_mut().ok_or("plugin_instance_unavailable")?;
    let result = apply_message(i, webview.label(), message);
    drop(host);
    if result.is_ok() && changed { notify_host(&app); }
    result
}

fn apply_message(i: &mut Instance, sender: &str, message: Value) -> Result<(), String> {
    if i.id != sender || message["instanceId"] != i.id || message["version"] != 1 { return Err("plugin_instance_mismatch".into()); }
    match message["type"].as_str() {
        Some("heartbeat") => {
            i.pulse = Instant::now();
            if let Some(source) = message["diagnostic"].as_object() {
                let mut fields = serde_json::Map::new();
                for key in ["hidden", "focused", "firstFrame", "contextLost", "loopScheduled", "modelApplied", "engineMissing", "frameAgeMs", "width", "height", "busyMs"] {
                    if let Some(value) = source.get(key).filter(|v| v.is_boolean() || v.as_u64().is_some_and(|n| n <= 86_400_000)) {
                        fields.insert(key.into(), value.clone());
                    }
                }
                if let Some(ms) = source.get("busyMs").and_then(|value| value.as_u64()) {
                    let budget = Duration::from_millis(ms.min(15_000));
                    i.busy_until = if budget.is_zero() { None } else { Some(Instant::now() + budget) };
                }
                if i.events.len() == 100 { i.events.remove(0); }
                i.events.push(json!({"atMs": i.started.elapsed().as_millis() as u64, "code": "runtime_state", "state": fields}));
                persist_diagnostics(i);
            }
        }
        Some("toolbar.update") => {
            let revision = message["revision"].as_u64().ok_or("plugin_revision_invalid")?;
            if revision <= i.revision { return Err("plugin_revision_stale".into()); }
            let items: Vec<Tool> = serde_json::from_value(message["items"].clone()).map_err(|_| "plugin_toolbar_invalid")?;
            if !valid_tools(&i.command_namespace, i.max_toolbar_items, &items) { return Err("plugin_toolbar_invalid".into()); }
            i.items = items; i.revision = revision; i.ready = true; i.pulse = Instant::now();
            note(i, "toolbar_updated");
        }
        Some("command.result") => {
            if !i.pending.as_ref().is_some_and(|(id, _)| message["requestId"] == *id) { return Err("plugin_request_stale".into()); }
            if message["ok"] != true { i.failed = Some("plugin_command_rejected"); }
            note(i, if message["ok"] == true { "command_succeeded" } else { "command_rejected" });
            i.pending = None;
        }
        Some("plugin.performance") => {
            let fields = performance_fields(&i.performance_metrics, &message)?;
            i.pulse = Instant::now();
            agent_vitals_runtime::logging::log_info("plugin_performance", &format!("plugin={} {fields}", i.plugin_id));
        }
        Some("runtime.error") => { i.failed = Some("plugin_runtime_error"); note(i, "plugin_runtime_error"); }
        _ => return Err("plugin_message_unavailable".into()),
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_command(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, instance_id: String, command_id: String, value: Option<String>) -> Result<String, String> {
    host_only(&webview)?;
    let (id, request) = {
        let mut host = state.0.lock().unwrap();
        let i = host.current.as_mut().ok_or("plugin_instance_unavailable")?;
        if i.id != instance_id || !i.ready || i.suspended || i.failed.is_some() || i.pending.is_some() { return Err("plugin_command_unavailable".into()); }
        let tool = i.items.iter().find(|t| t.command_id == command_id && t.enabled).ok_or("plugin_command_unavailable")?;
        if tool.kind == "select" && !tool.options.iter().any(|o| Some(&o.value) == value.as_ref()) { return Err("plugin_value_invalid".into()); }
        i.sequence += 1;
        let request = format!("request-{}", i.sequence);
        i.pending = Some((request.clone(), Instant::now())); note(i, "command_started");
        (i.id.clone(), request)
    };
    let envelope = json!({"version": 1, "instanceId": id, "requestId": request, "commandId": command_id, "value": value});
    app.get_webview(&id).ok_or("plugin_view_unavailable")?.eval(format!(
        "window.dispatchEvent(new CustomEvent('__AV_PLUGIN_COMMAND__', {{detail: {envelope}}}));"
    )).map_err(|_| "plugin_delivery_failed")?;
    Ok(request)
}

#[tauri::command]
pub fn plugin_invalidate(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, instance_id: String) -> Result<(), String> {
    host_only(&webview)?;
    let host = state.0.lock().unwrap();
    let i = host.current.as_ref().ok_or("plugin_instance_unavailable")?;
    if i.id != instance_id || i.failed.is_some() { return Err("plugin_instance_mismatch".into()); }
    app.get_webview(&i.id).ok_or("plugin_view_unavailable")?.eval("window.dispatchEvent(new Event('__AV_PLUGIN_INVALIDATED__'));")
        .map_err(|_| "plugin_delivery_failed".into())
}

fn performance_fields(allowed_metrics: &[String], message: &Value) -> Result<String, &'static str> {
    let object = message.as_object().filter(|object| object.len() == 7
        && ["version", "instanceId", "type", "metric", "outcome", "elapsedMs", "dimensions"].iter().all(|key| object.contains_key(*key)))
        .ok_or("plugin_performance_invalid")?;
    let metric = object.get("metric").and_then(Value::as_str).filter(|metric| allowed_metrics.iter().any(|allowed| allowed == metric))
        .ok_or("plugin_performance_denied")?;
    let outcome = object.get("outcome").and_then(Value::as_str)
        .filter(|outcome| matches!(*outcome, "success" | "partial" | "failed" | "cancelled"))
        .ok_or("plugin_performance_invalid")?;
    let elapsed = object.get("elapsedMs").and_then(Value::as_u64).filter(|ms| *ms <= 86_400_000)
        .ok_or("plugin_performance_invalid")?;
    let dimensions = object.get("dimensions").and_then(Value::as_object).filter(|dimensions| dimensions.len() <= 8)
        .ok_or("plugin_performance_invalid")?;
    let mut safe_dimensions = serde_json::Map::new();
    for (key, value) in dimensions {
        if !valid_performance_metric(key) || key.len() > 32 { return Err("plugin_performance_invalid"); }
        let safe = match value {
            Value::Bool(_) => value.clone(),
            Value::Number(number) if number.as_u64().is_some_and(|n| n <= 86_400_000) => value.clone(),
            Value::String(text) if !text.is_empty() && text.len() <= 40
                && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')) => value.clone(),
            _ => return Err("plugin_performance_invalid"),
        };
        safe_dimensions.insert(key.clone(), safe);
    }
    let dimensions = serde_json::to_string(&safe_dimensions).map_err(|_| "plugin_performance_invalid")?;
    Ok(format!("metric={metric} outcome={outcome} elapsed_ms={elapsed} dimensions={dimensions}"))
}

#[tauri::command]
pub async fn plugin_request(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, request: PluginRequestV1) -> Result<PluginResponseV1, String> {
    let (allowed, navigation, state_keys, typed_data_grants, legacy_data_grants, object_grants, scope_grants, remote_capabilities, plugin_id) = {
        let host = state.0.lock().unwrap();
        let i = host.current.as_ref().ok_or("plugin_instance_unavailable")?;
        if i.id != webview.label() || i.failed.is_some() || i.suspended || request.instance_id != i.id {
            return Err("plugin_instance_mismatch".into());
        }
        if let Err(code) = validate_plugin_request(&request) {
            return Ok(plugin_request_error(request.request_id, code, false));
        }
        let definition = definitions().iter().find(|p| p.id == i.plugin_id).ok_or("plugin_unknown")?;
        (definition.data_projections.clone(), definition.navigation_targets.clone(), definition.state_keys.clone(), definition.typed_data_grants.clone(), definition.legacy_data_grants.clone(), definition.object_grants.clone(), definition.scope_grants.clone(), definition.remote_capabilities.clone(), i.plugin_id.clone())
    };
    begin_activity(&state, &request.instance_id);
    let _activity = ActivityGuard { app: app.clone(), id: request.instance_id.clone() };
    if request.method == "ui.open-session" {
        if !navigation.iter().any(|n| n == "session") { return Ok(plugin_request_error(request.request_id, "navigation_denied", false)); }
        let payload = request.payload.clone();
        let target = tauri::async_runtime::spawn_blocking(move || crate::plugin_projections::session_target(&plugin_id, &payload))
            .await.map_err(|_| "plugin_query_failed".to_string())?;
        let host = state.0.lock().unwrap();
        if !host.current.as_ref().is_some_and(|i| i.id == request.instance_id && i.failed.is_none() && !i.suspended) { return Err("plugin_instance_mismatch".into()); }
        let (session_ref, harness_kind) = match target { Ok(value) => value, Err(code) => return Ok(plugin_request_error(request.request_id, code, false)) };
        drop(host);
        crate::focus_session_target(&app, crate::WorkbenchTarget::SessionDetail { session_ref, harness_kind });
        return Ok(PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(json!({"opened": true})), error: None });
    }
    let method = request.method.clone();
    let payload = request.payload.clone();
    if let Some(action) = method.strip_prefix("remote.session.") {
        let scoped_payload = attach_remote_owner(&payload, &request.instance_id).map_err(str::to_owned)?;
        let capability_id = scoped_payload["capabilityId"].as_str().ok_or_else(|| "remote_forbidden".to_owned())?;
        let capability = remote_capabilities.iter().find(|capability| capability.id == capability_id && capability.is_valid()).ok_or_else(|| "remote_forbidden".to_owned())?;
        let adapter = crate::remote_registry::for_capability(&plugin_id, capability);
        let result = match action {
            "start" => match adapter {
                Some(adapter) if adapter.wire_policy == crate::remote_registry::WirePolicy::LegacyTyped => crate::remote_gateway::start(&app, &plugin_id, capability, &scoped_payload).await,
                _ => crate::remote_gateway::start_generic(&app, &plugin_id, capability, &scoped_payload).await,
            },
            "stop" => crate::remote_gateway::stop(&app, &plugin_id, capability, &scoped_payload).await,
            "invite" => crate::remote_gateway::control(&app, &plugin_id, capability, &scoped_payload, "invite").await,
            "approve" => crate::remote_gateway::control(&app, &plugin_id, capability, &scoped_payload, "approve").await,
            "revoke" => crate::remote_gateway::control(&app, &plugin_id, capability, &scoped_payload, "revoke").await,
            "pending" => crate::remote_gateway::control(&app, &plugin_id, capability, &scoped_payload, "pending").await,
            _ => return Ok(plugin_request_error(request.request_id, "remote_forbidden", false)),
        };
        let host = state.0.lock().unwrap();
        if !host.current.as_ref().is_some_and(|i| i.id == request.instance_id && i.failed.is_none() && !i.suspended) {
            return Err("plugin_instance_mismatch".into());
        }
        return Ok(match result {
            Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
            Err(code) => plugin_request_error(request.request_id, code, matches!(code, "remote_unavailable" | "remote_session_unavailable")),
        });
    }
    if let Some(definition) = definitions().iter().find(|p| p.id == plugin_id) {
        if let Some(adapter) = crate::remote_registry::registered(&plugin_id, &definition.remote_capabilities, &method) {
            let dispatch_payload = attach_remote_owner(&payload, &request.instance_id).map_err(str::to_owned)?;
            let capability = definition.remote_capabilities.iter().find(|cap| cap.id == adapter.capability_id);
            let result = match capability {
                Some(capability) => adapter.dispatch(&app, capability, &method, &dispatch_payload).await,
                None => Err("remote_forbidden"),
            };
            let host = state.0.lock().unwrap();
            if !host.current.as_ref().is_some_and(|i| i.id == request.instance_id && i.failed.is_none() && !i.suspended) {
                return Err("plugin_instance_mismatch".into());
            }
            return Ok(match result {
                Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
                Err(code) => plugin_request_error(request.request_id, code, matches!(code, "remote_unavailable" | "remote_session_unavailable")),
            });
        }
    }
    // 通用本地状态端口（游戏模式 §9）：文件操作在阻塞线程执行，响应送达前复验实例。
    if matches!(method.as_str(), "plugin.state.read" | "plugin.state.write") {
        let keys = state_keys;
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::plugin_state::handle(&keys, &crate::overview::data_home(), &plugin_id, &method, &payload)
        }).await.map_err(|_| "plugin_query_failed".to_string())?;
        let host = state.0.lock().unwrap();
        if !host.current.as_ref().is_some_and(|i| i.id == request.instance_id && i.failed.is_none() && !i.suspended) {
            return Err("plugin_instance_mismatch".into());
        }
        return Ok(match result {
            Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
            Err(code) => plugin_request_error(request.request_id, code, matches!(code, "state_unavailable" | "revision_conflict")),
        });
    }
    if method == "typed-data.read" {
        let grants = typed_data_grants;
        let legacy_grants = legacy_data_grants;
        let typed_data_plugin_id = plugin_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::typed_data::read_authorized_for_plugin(&grants, &legacy_grants,
                &crate::overview::data_home(), &typed_data_plugin_id, &payload)
        }).await.map_err(|_| "plugin_query_failed".to_string())?;
        let host = state.0.lock().unwrap();
        if !host.current.as_ref().is_some_and(|i| i.id == request.instance_id && i.failed.is_none() && !i.suspended) {
            return Err("plugin_instance_mismatch".into());
        }
        return Ok(match result {
            Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
            Err(code) => plugin_request_error(request.request_id, code, matches!(code, "data_unavailable" | "revision_changed" | "legacy_export_changed")),
        });
    }
    if method == "typed-object.request" {
        let grants = object_grants;
        let typed_object_plugin_id = plugin_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::typed_objects::request_for_plugin(&grants, &scope_grants, &crate::overview::data_home(), &typed_object_plugin_id, &payload)
        }).await.map_err(|_| "plugin_query_failed".to_string())?;
        let host = state.0.lock().unwrap();
        if !plugin_response_owner_active(&host, &request.instance_id, &plugin_id) {
            return Err("plugin_instance_mismatch".into());
        }
        return Ok(match result {
            Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
            Err(code) => plugin_request_error(request.request_id, code,
                matches!(code, "storage_unavailable" | "revision_conflict" | "idempotency_capacity")),
        });
    }
    if method == "plugin.call.respond" {
        if payload.as_object().is_none_or(|object| object.len() != 2)
            || payload["callId"].as_str().is_none()
            || !payload["response"].is_object() {
            return Ok(plugin_request_error(request.request_id, "plugin_call_invalid", false));
        }
        let call_id = payload["callId"].as_str().unwrap_or_default().to_owned();
        let response_value = payload["response"].clone();
        let host = state.0.lock().unwrap();
        if !plugin_response_owner_active(&host, &request.instance_id, &plugin_id) {
            return Err("plugin_instance_mismatch".into());
        }
        // Keep the instance lock across the bounded local DB response commit:
        // plugin_open/close cannot replace this owner between validation and delivery.
        let result = agent_vitals_runtime::query::plugin_calls::respond(
            &crate::overview::data_home(), &plugin_id, &request.instance_id, &call_id, &response_value,
        );
        return Ok(match result {
            Ok(()) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(json!({"accepted":true})), error: None },
            Err(code) => plugin_request_error(request.request_id, code, matches!(code, "plugin_call_store_unavailable")),
        });
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::plugin_projections::read_for_plugin(&allowed, &method, &payload, &plugin_id)
    }).await.map_err(|_| "plugin_query_failed".to_string())?;
    let host = state.0.lock().unwrap();
    if !host.current.as_ref().is_some_and(|i| i.id == request.instance_id && i.failed.is_none() && !i.suspended) {
        return Err("plugin_instance_mismatch".into());
    }
    let response = match result {
        Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
        Err(code) => {
            plugin_request_error(request.request_id, code, matches!(code, "data_unavailable" | "revision_changed"))
        }
    };
    Ok(response)
}

fn plugin_response_owner_active(host: &HostState, instance_id: &str, plugin_id: &str) -> bool {
    host.current.as_ref().is_some_and(|instance| instance.id == instance_id && instance.plugin_id == plugin_id
        && instance.failed.is_none() && !instance.suspended)
}

#[cfg(test)]
mod plugin_request_tests {
    use super::*;

    #[test]
    fn generic_request_envelope_uses_shared_camel_case_contract() {
        let request = PluginRequestV1 {
            version: 1,
            instance_id: "plugin-city-1".into(),
            request_id: "request-1".into(),
            method: "data.read".into(),
            payload: json!({"projection":"city","windowDays":30}),
        };
        assert_eq!(request.version, 1);
        assert_eq!(request.method, "data.read");
        assert!(request.payload.is_object());
        let encoded = serde_json::to_value(&request).expect("serialize request");
        assert_eq!(encoded["version"], 1);
        assert_eq!(encoded["instanceId"], "plugin-city-1");
        assert_eq!(encoded["requestId"], "request-1");
        assert_eq!(encoded["method"], "data.read");
        assert_eq!(encoded["payload"]["projection"], "city");
        let response = PluginResponseV1 {
            version: 1,
            request_id: request.request_id,
            ok: false,
            result: None,
            error: Some(PluginRequestErrorV1 { code: "provider_unavailable", retryable: true }),
        };
        assert_eq!(response.version, 1);
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().map(|error| error.code), Some("provider_unavailable"));
        let encoded = serde_json::to_value(response).expect("serialize response");
        assert_eq!(encoded["requestId"], "request-1");
        assert_eq!(encoded["error"]["code"], "provider_unavailable");
        assert_eq!(encoded["error"]["retryable"], true);
    }

    #[test]
    fn protocol_errors_use_the_versioned_response_envelope() {
        for (request, code) in [
            (PluginRequestV1 { version: 2, instance_id: "plugin-city-1".into(), request_id: "request-2".into(), method: "data.read".into(), payload: json!({}) }, "unsupported_version"),
            (PluginRequestV1 { version: 1, instance_id: "plugin-city-1".into(), request_id: "request-3".into(), method: String::new(), payload: json!({}) }, "invalid_request"),
        ] {
            assert_eq!(validate_plugin_request(&request), Err(code));
            let expected_request_id = request.request_id.clone();
            let response = plugin_request_error(request.request_id, code, false);
            let encoded = serde_json::to_value(response).expect("serialize protocol error");
            assert_eq!(encoded["version"], 1);
            assert_eq!(encoded["requestId"], expected_request_id);
            assert_eq!(encoded["ok"], false);
            assert_eq!(encoded["error"]["code"], code);
            assert_eq!(encoded["error"]["retryable"], false);
        }
    }

    #[test]
    fn typed_object_response_is_dropped_after_owner_instance_replacement_or_failure() {
        let mut host = HostState { current: Some(Instance {
            id:"plugin-city-new".into(),plugin_id:"city".into(),command_namespace:"city".into(),
            max_toolbar_items:11,
            performance_metrics:vec!["scene".into(),"data-load".into()],
            started:Instant::now(),pulse:Instant::now(),ready:true,suspended:false,failed:None,revision:0,
            items:Vec::new(),sequence:0,pending:None,in_flight:0,busy_until:None,events:Vec::new(),
        }), ..HostState::default() };
        assert!(plugin_response_owner_active(&host,"plugin-city-new","city"));
        assert!(!plugin_response_owner_active(&host,"plugin-city-old","city"));
        assert!(!plugin_response_owner_active(&host,"plugin-city-new","other-app"));
        host.current.as_mut().unwrap().failed = Some("plugin_unresponsive");
        assert!(!plugin_response_owner_active(&host,"plugin-city-new","city"));
        host.current.as_mut().unwrap().failed = None;
        host.current.as_mut().unwrap().suspended = true;
        assert!(!plugin_response_owner_active(&host,"plugin-city-new","city"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn city_registry_declares_sequential_remote_capability() {
        let city = definitions().iter().find(|plugin| plugin.id == "city").expect("city plugin");
        assert_eq!(remote_host_entry("city").as_deref(), Some("plugins/AgentCity.plugin/ui/remote.html"));
        assert_eq!(remote_host_entry("unregistered").as_deref(), None);
        let usage = city.typed_data_grants.get("harness-sessions:v1").expect("typed session usage grant");
        assert!(usage.is_valid("harness-sessions:v1"));
        let usage_v2 = city.typed_data_grants.get("harness-sessions:v2").expect("typed session page grant");
        assert!(usage_v2.is_valid("harness-sessions:v2"));
        let usage_summary = city.typed_data_grants.get("usage-summary:v1").expect("typed usage summary grant");
        assert!(usage_summary.is_valid("usage-summary:v1"));
        for dataset in ["harness-sessions:v3", "activity-summary:v1", "model-usage:v1", "time-coverage:v1", "finding-summary:v1",
            "skill-usage-summary:v1", "workflow-activity-summary:v1", "harness-session-detail:v1",
            "session-excerpts:v1", "session-cost:v1", "session-source-status:v1"] {
            assert!(city.typed_data_grants.get(dataset).is_some_and(|grant| grant.is_valid(dataset)),
                "City must declare a valid generic typed-data grant for {dataset}");
        }
        let legacy_export = city.legacy_data_grants.get("city-legacy-store:v1").expect("City legacy asset migration grant");
        assert!(legacy_export.is_valid("city-legacy-store:v1"));
        let asset_crosswalk = city.legacy_data_grants.get("city-asset-crosswalk:v1").expect("City legacy asset crosswalk grant");
        assert!(asset_crosswalk.is_valid("city-asset-crosswalk:v1"));
        let object = city.object_grants.get("city.building-kit:v1").expect("typed object grant");
        assert!(object.validate_for("city.building-kit:v1").is_ok());
        assert!(object.allow_aliases && object.operations.iter().any(|op| op == "readAlias"));
        assert!(object.operations.contains(&"create".to_owned()) && object.operations.contains(&"commit".to_owned()));
        let asset = city.object_grants.get("city.asset:v1").expect("generic City asset identity grant");
        assert!(asset.validate_for("city.asset:v1").is_ok());
        assert!(asset.allow_aliases && asset.operations.contains(&"attachAlias".to_owned()));
        assert!(asset.operations.contains(&"list".to_owned()));
        let scope = city.scope_grants.get("city.save:v1").expect("typed object scope grant");
        assert!(scope.validate_for("city.save:v1", &city.object_grants).is_ok());
        assert!(scope.object_types.contains(&"city.asset:v1".to_owned()));
        assert!(!city.object_grants.contains_key("other.type:v1"));
        assert!(!usage.fields.iter().any(|field| field.contains("title") || field.contains("log") || field.contains("path")));
        let capability = city.remote_capabilities.iter().find(|capability| capability.id == "mecha:v4").expect("sequential capability");
        assert!(crate::mecha_remote_adapter::supports_sequential(capability));
        assert!(city.remote_projection_grants.get("mecha:v4").is_some_and(|grants| grants.len() == 1 && grants[0] == "city-remote-display:v2"));
        assert!(city.remote_projection_passthrough.iter().any(|projection| projection == "city-remote-display:v2"));
        assert!(!city.data_projections.iter().any(|projection| projection == "city-remote-display:v2"), "City display projection must not dispatch through a Rust business handler");
        let profile = remote_session_profile("city", "mecha:v4").expect("generic session profile");
        assert_eq!(profile.bootstrap_method, "session.bootstrap");
        assert_eq!(profile.stop_policy, "freezeSnapshot");
        let dream = remote_capability("city", "city-dream:v1").expect("Dream snapshot-only capability");
        assert_eq!(dream.methods, ["dream.snapshot"]);
        assert!(dream.events.is_empty(), "Dream host does not declare events it never emits");
        let dream_profile = remote_session_profile("city", "city-dream:v1").expect("Dream lifecycle profile");
        assert_eq!(dream_profile.bootstrap_method, "dream.bootstrap");
        assert_eq!(dream_profile.stop_policy, "closeOnly");
        assert!(dream_profile.approval_method.is_none() && dream_profile.stop_method.is_none());
        assert_eq!(dream_profile.links.session_param, "publication");
        assert_eq!(dream_profile.links.invitation_room_param, "room");
        assert_eq!(dream_profile.links.invitation_id_param, "invite");
        assert_eq!(dream_profile.links.invitation_secret_param, None, "invite secret must stay in URL fragment");
        assert_eq!(dream_profile.links.invitation_capability_param.as_deref(), Some("capability"));
        assert_eq!(city.remote_projection_grants.get("city-dream:v1").map(Vec::as_slice), Some(["city-dream:v1".to_owned()].as_slice()));
        assert_eq!(city.remote_projection_passthrough, ["city-dream:v1", "city-remote-display:v2"]);
        assert!(!city.data_projections.iter().any(|projection| projection == "city-dream:v1"), "Dream projection must not dispatch through a Rust business handler");
    }

    #[test]
    fn generic_profile_supports_non_mecha_close_only_apps_and_link_shapes() {
        let capability = crate::remote_protocol::RemoteCapability { id: "island:v1".into(), methods: vec!["island.visit".into()], events: vec!["island.changed".into()] };
        let profile = RemoteSessionProfile {
            version: 1,
            bootstrap_method: "visit.bootstrap".into(),
            approval_method: None,
            stop_method: None,
            stop_policy: "closeOnly".into(),
            max_bootstrap_bytes: 64 * 1024,
            links: crate::remote_registry::RemoteLinkSpec {
                path: "/island".into(), session_param: "island".into(), player_param: "visitor".into(), websocket_param: "socket".into(),
                access_param: "grant".into(), device_param: "device".into(), owner_secret_param: Some("ownerKey".into()),
                invitation_room_param: "room".into(), invitation_id_param: "invitation".into(), invitation_secret_param: Some("secret".into()),
                owner_capability_param: Some("appCapability".into()), invitation_capability_param: Some("appCapability".into()),
            },
        };
        assert!(profile.is_valid(&capability));
        assert_eq!(profile.links.path, "/island");
        assert_eq!(profile.stop_policy, "closeOnly");
        let mut invalid = profile.clone();
        invalid.links.path = "https://evil.example/island".into();
        assert!(!invalid.is_valid(&capability));
        let mut duplicate_method = profile.clone();
        duplicate_method.approval_method = Some(duplicate_method.bootstrap_method.clone());
        assert!(!duplicate_method.is_valid(&capability));
    }

    #[test]
    fn remote_owner_instance_is_injected_by_the_host_and_overwrites_caller_claims() {
        let caller = json!({"capabilityId":"mecha:v4","__hostOwnerInstanceId":"forged"});
        let bound = attach_remote_owner(&caller, "plugin-city-9").unwrap();
        assert_eq!(bound["__hostOwnerInstanceId"], "plugin-city-9");
        assert_eq!(caller["__hostOwnerInstanceId"], "forged");
        assert!(attach_remote_owner(&json!("not-an-object"), "plugin-city-9").is_err());
    }

    #[test]
    fn remote_bootstrap_rejects_projections_without_an_exact_capability_grant() {
        let payload = json!({"bootstrap":{"projections":[{"id":"city-dream:v1","value":{}}]}});
        assert_eq!(prepare_remote_bootstrap("city", "mecha:v4", &payload), Err("projection_denied"));
        assert_eq!(prepare_remote_bootstrap("city", "mecha:v1", &payload), Err("projection_denied"));
        assert_eq!(prepare_remote_bootstrap("unregistered", "mecha:v4", &payload), Err("remote_forbidden"));
    }

    #[test]
    fn remote_bootstrap_rejects_duplicate_projection_envelopes() {
        let payload = json!({"bootstrap":{"projections":[
            {"id":"city-remote-display:v2","value":{}},
            {"id":"city-remote-display:v2","value":{}}
        ]}});
        assert_eq!(prepare_remote_bootstrap("city", "mecha:v4", &payload), Err("projection_denied"));
    }

    #[test]
    fn dream_bootstrap_uses_granted_opaque_object_passthrough() {
        let projection = json!({
            "schema": "dream-city-gzip:v1",
            "plainBytes": 123,
            "data": "H4sIAAAAAAAA",
            "adapterMetadata": {"version": 1}
        });
        let payload = json!({"bootstrap":{"projections":[{"id":"city-dream:v1","value":projection}]}});
        let prepared = prepare_remote_bootstrap("city", "city-dream:v1", &payload).unwrap();
        assert_eq!(prepared["projections"][0]["id"], "city-dream:v1");
        assert_eq!(prepared["projections"][0]["value"], projection, "Rust must forward the trusted TS adapter envelope without rewriting app fields");

        let non_object = json!({"bootstrap":{"projections":[{"id":"city-dream:v1","value":"opaque scalars are not accepted"}]}});
        assert_eq!(prepare_remote_bootstrap("city", "city-dream:v1", &non_object), Err("projection_denied"));

        let too_large = json!({"bootstrap":{"projections":[{"id":"city-dream:v1","value":{"blob":"x".repeat(256 * 1024)}}]}});
        assert_eq!(prepare_remote_bootstrap("city", "city-dream:v1", &too_large), Err("remote_match_too_large"));
    }

    #[test]
    fn mecha_city_display_uses_granted_opaque_object_passthrough() {
        let projection = json!({"schema":"remote-city-display:v2","seed":7,"model":{"opaque":true},"layout":{"opaque":true}});
        let payload = json!({"bootstrap":{"projections":[{"id":"city-remote-display:v2","value":projection}]}});
        let prepared = prepare_remote_bootstrap("city", "mecha:v4", &payload).unwrap();
        assert_eq!(prepared["projections"][0]["value"], projection);
        assert_eq!(prepare_remote_bootstrap("city", "city-dream:v1", &payload), Err("projection_denied"));
        let scalar = json!({"bootstrap":{"projections":[{"id":"city-remote-display:v2","value":null}]}});
        assert_eq!(prepare_remote_bootstrap("city", "mecha:v4", &scalar), Err("projection_denied"));
    }

    fn instance() -> Instance {
        Instance { id: "plugin-city-2".into(), plugin_id: "city".into(), command_namespace: "city".into(), max_toolbar_items:11, performance_metrics:vec!["scene".into(),"data-load".into()], started: Instant::now(), pulse: Instant::now(), ready: false, suspended: false,
            failed: None, revision: 0, items: Vec::new(), sequence: 0, pending: None, in_flight: 0, busy_until: None, events: Vec::new() }
    }
    #[test]
    fn fault_deadlines_are_independent_of_frontend_polling_and_sticky() {
        let mut suspended = instance();
        suspended.suspended = true;
        suspended.started = Instant::now() - Duration::from_secs(60);
        suspended.pulse = suspended.started;
        assert!(!refresh_fault(&mut suspended));
        let mut i = instance();
        i.ready = true; i.pulse = Instant::now() - Duration::from_secs(6);
        assert!(refresh_fault(&mut i));
        assert_eq!(i.failed, Some("plugin_unresponsive"));
        i.pulse = Instant::now();
        assert!(!refresh_fault(&mut i));
        assert_eq!(i.failed, Some("plugin_unresponsive"));
        assert_eq!(i.events.len(), 1);
        let mut loading = instance();
        loading.started = Instant::now() - Duration::from_secs(16);
        assert!(refresh_fault(&mut loading));
        assert_eq!(loading.failed, Some("plugin_boot_timeout"));
        let mut pending = instance();
        pending.ready = true;
        pending.pending = Some(("request-1".into(), Instant::now() - Duration::from_secs(6)));
        assert!(refresh_fault(&mut pending));
        assert_eq!(pending.failed, Some("plugin_command_timeout"));
    }
    #[test]
    fn in_flight_host_work_and_busy_budget_are_liveness_not_hangs() {
        let mut i = instance();
        i.ready = true;
        i.pulse = Instant::now() - Duration::from_secs(6);
        i.in_flight = 1;
        assert!(!refresh_fault(&mut i), "an in-flight plugin_request must not count as plugin_unresponsive");
        i.in_flight = 0;
        i.busy_until = Some(Instant::now() + Duration::from_secs(8));
        assert!(!refresh_fault(&mut i), "a declared busy budget holds the 5s pulse");
        i.busy_until = Some(Instant::now() - Duration::from_millis(1));
        assert!(refresh_fault(&mut i));
        assert_eq!(i.failed, Some("plugin_unresponsive"));
        let mut loading = instance();
        loading.started = Instant::now() - Duration::from_secs(16);
        loading.in_flight = 1;
        assert!(!refresh_fault(&mut loading), "boot timeout waits while the plugin is inside a host request");
    }
    #[test]
    fn heartbeat_busy_ms_is_capped_and_refreshes_pulse() {
        let mut i = instance();
        i.ready = true;
        assert!(apply_message(&mut i, "plugin-city-2", json!({"version":1,"instanceId":"plugin-city-2","type":"heartbeat","diagnostic":{"busyMs":60_000}})).is_ok());
        let until = i.busy_until.expect("busy budget");
        assert!(until > Instant::now() + Duration::from_secs(10));
        assert!(until <= Instant::now() + Duration::from_secs(15));
        i.pulse = Instant::now() - Duration::from_secs(6);
        assert!(!refresh_fault(&mut i));
    }
    #[test]
    fn performance_message_uses_descriptor_grants_and_bounded_dimensions() {
        let message = json!({
            "version":1,"instanceId":"plugin-city-2","type":"plugin.performance",
            "metric":"data-load","outcome":"success","elapsedMs":1234,
            "dimensions":{"attempt_count":1,"window_days":366,"fallback":"none","page_returned":500}
        });
        let metrics = vec!["data-load".to_owned()];
        let fields = performance_fields(&metrics, &message).unwrap();
        assert!(fields.contains("metric=data-load"));
        assert!(fields.contains("outcome=success"));
        assert!(fields.contains("elapsed_ms=1234"));
        let mut ungranted = message.clone();
        ungranted["metric"] = json!("secret.metric");
        assert_eq!(performance_fields(&metrics, &ungranted), Err("plugin_performance_denied"));
        let mut private_value = message.clone();
        private_value["dimensions"]["path"] = json!("/Users/private/session.json");
        assert_eq!(performance_fields(&metrics, &private_value), Err("plugin_performance_invalid"));
        let mut oversized = message.clone();
        oversized["dimensions"]["large"] = json!(86_400_001_u64);
        assert_eq!(performance_fields(&metrics, &oversized), Err("plugin_performance_invalid"));
        let mut too_many = message.clone();
        too_many["dimensions"] = json!({"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9});
        assert_eq!(performance_fields(&metrics, &too_many), Err("plugin_performance_invalid"));
    }

    #[test]
    fn generic_performance_message_updates_pulse_for_any_registered_plugin() {
        let message = json!({
            "version":1,"instanceId":"plugin-city-2","type":"plugin.performance",
            "metric":"scene","outcome":"success","elapsedMs":5678,"dimensions":{"stage":"first_frame"}
        });
        let mut i = instance();
        i.pulse = Instant::now() - Duration::from_secs(6);
        assert!(apply_message(&mut i, "plugin-city-2", message.clone()).is_ok());
        assert!(i.pulse > Instant::now() - Duration::from_secs(1));
        let mut metrics = instance();
        metrics.plugin_id = "metrics".into();
        metrics.performance_metrics = vec!["scene".into()];
        assert!(apply_message(&mut metrics, "plugin-city-2", message).is_ok());
    }

    #[test]
    fn rejects_old_instances_revisions_and_request_results() {
        let mut i = instance();
        let update = json!({"version":1,"instanceId":"plugin-city-2","type":"toolbar.update","revision":1,"items":[]});
        assert!(apply_message(&mut i, "plugin-city-1", update.clone()).is_err());
        assert!(!i.ready);
        assert!(apply_message(&mut i, "plugin-city-2", update.clone()).is_ok());
        assert!(i.ready);
        assert!(apply_message(&mut i, "plugin-city-2", update).is_err());
        i.pending = Some(("request-2".into(), Instant::now()));
        assert!(apply_message(&mut i, "plugin-city-2", json!({"version":1,"instanceId":"plugin-city-2","type":"command.result","requestId":"request-1","ok":true})).is_err());
        assert!(i.pending.is_some());
        assert!(apply_message(&mut i, "plugin-city-2", json!({"version":1,"instanceId":"plugin-city-2","type":"command.result","requestId":"request-2","ok":false})).is_ok());
        assert_eq!(i.failed, Some("plugin_command_rejected"));
        assert_eq!(i.events.last().unwrap()["requestId"], "request-2");
    }
    #[test]
    fn toolbar_rejects_duplicates_and_unknown_selected_value() {
        let mut tools: Vec<Tool> = serde_json::from_value(json!([{"id":"window","commandId":"city.window","label":"Window","kind":"select","enabled":true,"value":"30","options":[{"value":"30","label":"30 days"}]}])).unwrap();
        assert!(valid_tools("city", 11, &tools));
        tools.push(tools[0].clone()); assert!(!valid_tools("city", 11, &tools));
        tools.pop(); tools[0].value = Some("14".into()); assert!(!valid_tools("city", 11, &tools));
    }
    #[test]
    fn descriptor_toolbar_limit_allows_game_entry_without_namespace_special_cases() {
        let tools: Vec<Tool> = (0..11).map(|n| serde_json::from_value(json!({
            "id": format!("tool-{n}"), "commandId": format!("city.tool-{n}"),
            "label": "Tool", "kind": "button", "enabled": true
        })).unwrap()).collect();
        assert!(valid_tools("city", 11, &tools));
        let mut too_many = tools.clone();
        too_many.push(serde_json::from_value(json!({"id":"extra","commandId":"city.extra","label":"Extra","kind":"button","enabled":true})).unwrap());
        assert!(!valid_tools("city", 11, &too_many));
        let other: Vec<Tool> = (0..11).map(|n| serde_json::from_value(json!({
            "id": format!("tool-{n}"), "commandId": format!("metrics.tool-{n}"),
            "label": "Tool", "kind": "button", "enabled": true
        })).unwrap()).collect();
        assert!(valid_tools("metrics", 10, &other[..10]));
        assert!(!valid_tools("metrics", 10, &other));
        assert!(valid_tools("metrics", 11, &other));
    }
    #[test]
    fn namespace_validation_is_not_specific_to_the_first_plugin() {
        let tools: Vec<Tool> = serde_json::from_value(json!([{"id":"refresh","commandId":"metrics.refresh","label":"Refresh","kind":"button","enabled":true}])).unwrap();
        assert!(valid_tools("metrics", 10, &tools));
        assert!(!valid_tools("city", 10, &tools));
        let registry = definitions();
        assert!(!registry.is_empty());
        let city = registry.iter().find(|plugin| plugin.id == "city").unwrap();
        assert_eq!(city.host_events, vec!["plugin.event".to_owned()]);
    }

    #[test]
    fn native_create_failures_map_to_stable_non_sensitive_categories() {
        assert_eq!(native_create_failure_code(&tauri::Error::AssetNotFound("private/path".into())), "plugin_assets_missing");
        assert_eq!(native_create_failure_code(&tauri::Error::WebviewLabelAlreadyExists("private-label".into())), "plugin_instance_conflict");
        assert_eq!(native_create_failure_code(&tauri::Error::InvalidWindowHandle), "plugin_parent_unavailable");
        assert_eq!(native_create_failure_code(&tauri::Error::WindowNotFound), "plugin_parent_unavailable");
        let private = tauri::Error::Io(std::io::Error::other("/Users/private/secret"));
        assert_eq!(native_create_failure_code(&private), "plugin_create_failed");
        assert!(!native_create_failure_code(&private).contains("/Users"));
    }
}
