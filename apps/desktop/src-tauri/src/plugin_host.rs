//! Built-in official UI slot. No dynamic native plugin code or authority access.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, Webview, WebviewBuilder, WebviewUrl};

#[derive(Default)]
pub struct PluginHost(Mutex<HostState>, Mutex<()>);

fn city_asset_webview_authorized(host: &HostState, webview_label: &str) -> bool {
    webview_label.starts_with("plugin-city-") && host.current.as_ref().is_some_and(|instance|
        instance.id == webview_label && instance.plugin_id == "city" && instance.ready && !instance.suspended && instance.failed.is_none())
}

pub(crate) fn creator_asset_protocol_response(app: &tauri::AppHandle, webview_label: &str, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let respond = |status, body: Vec<u8>| {
        tauri::http::Response::builder().status(status)
            .header(tauri::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(tauri::http::header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(tauri::http::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .header(tauri::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(body).unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    };
    let status = |code: tauri::http::StatusCode, message: &'static str| respond(code, message.as_bytes().to_vec());
    if request.method() == tauri::http::Method::OPTIONS { return status(tauri::http::StatusCode::NO_CONTENT, ""); }
    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD {
        return status(tauri::http::StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed");
    }
    if request.uri().host() != Some("localhost") { return status(tauri::http::StatusCode::NOT_FOUND, "not_found"); }
    let mut parts = request.uri().path().split('/').filter(|part| !part.is_empty());
    if parts.next() != Some("v1") { return status(tauri::http::StatusCode::NOT_FOUND, "not_found"); }
    let (Some(release_id), Some(filename), None) = (parts.next(), parts.next(), parts.next()) else {
        return status(tauri::http::StatusCode::NOT_FOUND, "not_found");
    };
    let Some(hash) = filename.strip_suffix(".glb") else { return status(tauri::http::StatusCode::NOT_FOUND, "not_found"); };
    let asset_digest = format!("sha256:{hash}");
    let Some(host_state) = app.try_state::<PluginHost>() else { return status(tauri::http::StatusCode::FORBIDDEN, "permission_denied"); };
    let authorized = city_asset_webview_authorized(&host_state.0.lock().unwrap_or_else(|error| error.into_inner()), webview_label);
    if !authorized { return status(tauri::http::StatusCode::FORBIDDEN, "permission_denied"); }
    match crate::creator_projects::read_city_release_asset(&crate::overview::data_home(), release_id, &asset_digest) {
        Ok(bytes) => {
            let length = bytes.len();
            let body = if request.method() == tauri::http::Method::HEAD { Vec::new() } else { bytes };
            tauri::http::Response::builder().status(tauri::http::StatusCode::OK)
                .header(tauri::http::header::CONTENT_TYPE, "model/gltf-binary")
                .header(tauri::http::header::CONTENT_LENGTH, length)
                .header(tauri::http::header::CACHE_CONTROL, "private, max-age=31536000, immutable")
                .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(tauri::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .body(body).unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
        }
        Err("creator_release_asset_not_found" | "creator_release_not_found") => status(tauri::http::StatusCode::NOT_FOUND, "asset_not_found"),
        Err("creator_store_unavailable") => status(tauri::http::StatusCode::SERVICE_UNAVAILABLE, "asset_unavailable"),
        Err(_) => status(tauri::http::StatusCode::FORBIDDEN, "asset_unavailable"),
    }
}

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
    /// The frontend reports visibility with its diagnostic heartbeat. The view's
    /// health timer keeps running while hidden (background throttling disabled),
    /// so a live hidden page keeps re-declaring; `hidden_since` bounds how long
    /// a hidden declaration may suppress the watchdog after declarations stop.
    page_hidden: bool,
    hidden_since: Option<Instant>,
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
    /// 按方法传输预算（设计 §5.5）：宿主校验描述符声明后统一执行到投递与响应
    /// 路径；未声明的方法保持 64 KiB 默认。描述符是唯一配置点，调用方传入的
    /// 预算只是提示，不是授权。
    #[serde(default)] local_call_budgets: std::collections::BTreeMap<String, TransportBudget>,
    #[serde(default)] remote_capabilities: Vec<crate::remote_protocol::RemoteCapability> }

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransportBudget {
    pub request_bytes: u64,
    pub response_bytes: u64,
}

/// 绝对上限（§5.5）：描述符不能把预算调到 IPC 安全上限之上；下限拒绝无效声明。
const TRANSPORT_BUDGET_MIN_BYTES: u64 = 1024;
const TRANSPORT_BUDGET_MAX_BYTES: u64 = 1024 * 1024;
const TRANSPORT_BUDGET_DEFAULT_BYTES: usize = 64 * 1024;
/// plugin.call.request 信封（kind/callId/method 包装）开销余量。
const CALL_ENVELOPE_SLACK_BYTES: usize = 4 * 1024;

fn transport_budget_for(definition: &PluginDefinition, method: &str) -> (usize, usize) {
    let declared = definition.local_call_budgets.get(method);
    let clamp = |bytes: u64| bytes.clamp(TRANSPORT_BUDGET_MIN_BYTES, TRANSPORT_BUDGET_MAX_BYTES) as usize;
    match declared {
        Some(budget) => (clamp(budget.request_bytes), clamp(budget.response_bytes)),
        None => (TRANSPORT_BUDGET_DEFAULT_BYTES, TRANSPORT_BUDGET_DEFAULT_BYTES),
    }
}

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
            // 按方法传输预算（§5.5）：只允许指向已授予的方法，且不超过 IPC 安全上限。
            for (method, budget) in &plugin.local_call_budgets {
                assert!(local_call_methods.contains(method), "transport budget must target a granted local call: {method}");
                assert!((TRANSPORT_BUDGET_MIN_BYTES..=TRANSPORT_BUDGET_MAX_BYTES).contains(&budget.request_bytes)
                    && (TRANSPORT_BUDGET_MIN_BYTES..=TRANSPORT_BUDGET_MAX_BYTES).contains(&budget.response_bytes),
                    "transport budget for {method} exceeds the IPC safety cap");
            }
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
    // Linux: wry ignores set_bounds for GtkBox-packed children; place the
    // view in the host overlay instead (see plugin_webview_layout).
    #[cfg(target_os = "linux")]
    {
        let geometry = crate::plugin_webview_layout::overlay_child_geometry(bounds.x, bounds.y, bounds.width, bounds.height);
        crate::plugin_webview_layout::linux::set_bounds(view, geometry).inspect_err(|error| {
            agent_vitals_runtime::logging::log_error("plugin_host", &format!("set_bounds failed: {error}"));
        }).map_err(|_| "plugin_layout_failed".into())
    }
    #[cfg(not(target_os = "linux"))]
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
    // A hidden retained view must not fail just for being hidden — but its
    // health timer keeps running while hidden, so the hidden declaration is
    // refreshed every couple of seconds. A stale declaration means the page
    // died while hidden; stop suppressing so the normal checks below fire
    // instead of staying blind forever.
    if i.page_hidden && i.hidden_since.is_some_and(|since| since.elapsed() <= Duration::from_secs(30)) { return false; }
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

fn presence_of(i: &Instance, generation: u64) -> agent_vitals_runtime::query::plugin_calls::ConsumerPresence {
    let hidden_for = i.hidden_since.map(|since| since.elapsed().as_millis() as u64).unwrap_or(0);
    let acceptance = if i.failed.is_some() { "failed" } else if i.suspended { "suspended" } else if i.ready { "ready" } else { "loading" };
    agent_vitals_runtime::query::plugin_calls::ConsumerPresence {
        plugin_id: i.plugin_id.clone(), instance_id: i.id.clone(), generation,
        acceptance: acceptance.into(), fault: i.failed.map(str::to_string),
        pulse_age_ms: i.pulse.elapsed().as_millis() as u64, hidden: i.page_hidden,
        hidden_for_ms: if i.page_hidden { hidden_for } else { 0 },
        in_flight: i.in_flight, ready: i.ready, suspended: i.suspended,
    }
}

fn presence_closed(i: &Instance, generation: u64) -> agent_vitals_runtime::query::plugin_calls::ConsumerPresence {
    let mut presence = presence_of(i, generation);
    presence.acceptance = "closed".into();
    presence.ready = false;
    presence.suspended = false;
    presence
}

fn publish_presence(presence: &agent_vitals_runtime::query::plugin_calls::ConsumerPresence) {
    let home = crate::overview::data_home();
    if let Err(code) = agent_vitals_runtime::query::plugin_calls::publish_consumer(&home, presence) {
        agent_vitals_runtime::logging::log_warn("plugin_host", &format!("consumer presence not recorded code={code}"));
    }
}

fn report_new_fault(presence: &agent_vitals_runtime::query::plugin_calls::ConsumerPresence) {
    let line = agent_vitals_runtime::query::plugin_calls::format_fault_context(presence);
    agent_vitals_runtime::logging::log_warn("plugin_host", &line);
    retain_diagnostic(&line);
    publish_presence(presence);
}

/// Append-only fault/close line under the data home. The temp diagnostics JSON
/// is one current instance and is replaced by the next view; this file is not.
fn retain_diagnostic(line: &str) {
    #[cfg(not(test))]
    {
        let path = crate::overview::data_home().join("logs").join("plugin-faults.jsonl");
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            use std::io::Write;
            let _ = writeln!(file, "{line}");
        }
    }
    #[cfg(test)]
    let _ = line;
}

fn canonical_close_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("snapshot-failed") => "snapshot-failed",
        Some("snapshot-unavailable") => "snapshot-unavailable",
        Some("startup-cancelled") => "startup-cancelled",
        Some("tab-suspend") => "tab-suspend",
        Some("user-close") => "user-close",
        Some("user-leave") => "user-leave",
        _ => "unspecified",
    }
}

/// Suspend keeps a live instance and its playtest claim. A failed instance is
/// destroyed instead, so leaving it frees the single slot and settles the claim.
/// The health snapshot itself does not call close.
fn close_keeps_instance(suspend: Option<bool>, failed: bool) -> bool {
    suspend == Some(true) && !failed
}

#[cfg(test)]
mod close_instance_tests {
    use super::close_keeps_instance;

    #[test]
    fn a_failed_instance_is_destroyed_when_the_user_leaves() {
        assert!(close_keeps_instance(Some(true), false), "a live tab suspend keeps the claim");
        assert!(!close_keeps_instance(Some(true), true), "a health fault cannot stay suspended");
        assert!(!close_keeps_instance(None, false));
        assert!(!close_keeps_instance(Some(false), true));
    }
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
    deliver_host_payload_capped(app, expected_plugin_id, payload, HOST_EVENT_MAX_BYTES)
}

/// `max_bytes`：通用宿主事件保持 64 KiB 安全上限；plugin.call.request 由宿主按
/// 描述符的方法请求预算放宽（§5.5）。
fn deliver_host_payload_capped(app: &tauri::AppHandle, expected_plugin_id: &str, payload: &serde_json::Value, max_bytes: usize) -> bool {
    if !payload.is_object() { return false; }
    let envelope = serde_json::json!({"version":1,"source":"host","payload":payload});
    let Ok(bytes) = serde_json::to_vec(&envelope) else { return false; };
    if bytes.len() > max_bytes { return false; }
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
        // 方法请求预算（§5.5）：宿主按描述符执行；信封包装开销单独留余量。
        let method = call["method"].as_str().unwrap_or_default().to_owned();
        let (request_budget, response_budget) = transport_budget_for(definition, &method);
        let envelope = json!({"kind":"plugin.call.request", "call":call});
        let delivery_limit = request_budget.saturating_add(CALL_ENVELOPE_SLACK_BYTES);
        if deliver_host_payload_capped(app, &plugin_id, &envelope, delivery_limit) { continue; }
        // 超预算的调用必须立即终结而不是释放回队列让调用方干等：写入小错误响应，
        // wait_response 马上拿到 plugin_call_too_large 终态（不得遗留 pending/claimed）。
        let oversize = serde_json::to_vec(&envelope).map(|bytes| bytes.len() > delivery_limit).unwrap_or(true);
        if oversize {
            if let Some(call_id) = call["callId"].as_str() {
                let _ = agent_vitals_runtime::query::plugin_calls::respond_with_budget(
                    &home, &plugin_id, &instance_id, call_id,
                    &json!({"error":{"code":"plugin_call_too_large"}}), response_budget);
            }
            continue;
        }
        // 其余投递失败（无订阅 WebView 等）：保持既有语义——释放回队列等后续 poll。
        for pending in &calls[index..] {
            if let Some(call_id) = pending["callId"].as_str() {
                let _ = agent_vitals_runtime::query::plugin_calls::release_claim(&home, &plugin_id, &instance_id, call_id);
            }
        }
        break;
    }
}

// ── headless creator 语义闸（E5 全量，spec §8.4 路径 2 / §11.6）──
// Studio webview 缺席时，宿主自己 claim 并作答一个**显式窄名单**内的 creator 方法：
// 语义校验由宿主内嵌 city-sdk 闸（embedded_city_sdk，rquickjs/QuickJS，digest 锁步）
// 完成，写路径经 dispatch_as 走与 Studio 完全相同的 preview/commit 管线。语义通过
// → 正常签发 previewId / 落库（validation:"embedded-sdk"，可 commit）；语义失败 →
// 同诊断拒绝。Studio 在场时本臂完全停用（互斥由 mailbox 原子 claim + ready 检查
// 双重保证），信封路径不变（validation:"studio-envelope"）。

/// headless 臂的 mailbox 实例标识（preview 的 instance 绑定与 commit 归属一致）。
const HEADLESS_CREATOR_INSTANCE: &str = "host-headless";

/// headless 臂可作答的方法窄名单：只包含「语义闸可覆盖 + 纯宿主本地」的方法。
/// 视口/City 运行时依赖（layout.save、anchor、publish、playtest 等）**不在名单内**
/// ——headless 绝不假装能做视口能力，让它们继续走 plugin_unavailable 的诚实延迟。
fn headless_creator_methods() -> Vec<String> {
    [
        "creator.city.list",
        "creator.city.read",
        "creator.city.create",
        "creator.city.edit.preview",
        "creator.city.edit.commit",
        "creator.vehicle.preview",
        "creator.vehicle.define",
        "creator.vehicle.inspect",
        "creator.project.commit",
        // 只读/纯本地写：布局目录与项目创建不依赖视口（项目来自已存布局），
        // 是 headless 车辆编辑链的前置；缺了它们 W2 的 2c/2d/2e 根本走不到。
        "creator.layout.list",
        "creator.project.create",
        // 纯本地 store 操作（不需要视口）：空域锚点、typed mount、发布冻结。
        // 它们仍是「结构闸 + 宿主校验」；语义面由 gate 的 scene/game 校验与
        // Studio 的 scene.preview 覆盖，headless 臂不冒充语义通过。
        "creator.city.anchor.upsert",
        "creator.city.anchor.remove",
        "creator.mount.bind",
        "creator.mount.unbind",
        "creator.project.publish",
        "creator.mount.list",
        "creator.project.list",
        "creator.operation.status",
        // V3 PR-7 前半（RFC §12 / §6 [r1] creator 域扩展）：Story 注册表 11 方法 +
        // City Code 安装 3 方法 + Inspect 只读 4 方法。全部「纯宿主本地」：
        // 不依赖视口；写路径经 dispatch_as 与 Studio 在场时走完全相同的
        // preview/commit 管线（CAS、operationId 幂等、预算与错误码一致）；
        // 运行身份固定为稳定本地 principal（LOCAL_CREATOR_OWNER，与 mailbox 臂
        // 同款），绝不接受调用方自报 playerId/instance 归属。
        "creator.code.install.preview",
        "creator.code.install.commit",
        "creator.code.install.list",
        "creator.story.project.create",
        "creator.story.project.read",
        "creator.story.projects.list",
        "creator.actor.register",
        "creator.actor.turn.context",
        "creator.actor.intent.submit",
        "creator.story.install.preview",
        "creator.story.install.commit",
        "creator.story.install.list",
        "creator.story.run.start",
        "creator.story.run.stop",
        "creator.story.run.reset",
        "creator.story.resident.lease.acquire",
        "creator.story.resident.lease.release",
        "creator.game.rules.inspect",
        "creator.story.graph.inspect",
        "creator.story.timeline.inspect",
        "creator.game.intent.simulate",
    ].into_iter().map(str::to_owned).collect()
}

/// Studio webview 是否处于可作答状态（与 subscriber_view 同一判据）。
/// 嵌入式 gate 产物完整性（fail closed）：启动后第一次使用前核对 bundle 实际摘要
/// 与锁文件钉住值；不符则本进程内永久停用 headless 臂（语义闸退回诚实不可用），
/// 绝不带着被篡改/漂移的产物放行写路径。核对结果只记稳定码，不落任何载荷。
fn embedded_gate_integrity_ok() -> bool {
    static VERDICT: OnceLock<bool> = OnceLock::new();
    *VERDICT.get_or_init(|| {
        let lock = crate::embedded_city_sdk::gate_lock();
        let recorded = lock.get("bundleSha256").and_then(Value::as_str).unwrap_or_default();
        let actual = crate::embedded_city_sdk::gate_bundle_digest().strip_prefix("sha256:").unwrap_or_default().to_owned();
        let ok = !recorded.is_empty() && recorded == actual;
        if !ok { agent_vitals_runtime::logging::log_warn("plugin_host", "embedded city-sdk gate digest mismatch; headless arm disabled"); }
        ok
    })
}

fn studio_instance_ready(app: &tauri::AppHandle) -> bool {
    let host = app.state::<PluginHost>();
    let guard = host.0.lock().unwrap_or_else(|error| error.into_inner());
    guard.current.as_ref().is_some_and(|instance| instance.plugin_id == "creator-studio"
        && instance.ready && !instance.suspended && instance.failed.is_none())
}

/// Studio 实例是否存在（不管 ready/suspended）。preview 与 commit 都是实例绑定的：
/// 只要 Studio 在，headless 臂就必须休眠，否则会出现「Studio 签发预览、headless 臂
/// 认领提交」的跨实例配对，宿主只能报 preview_expired/permission_denied。
fn studio_instance_present(app: &tauri::AppHandle) -> bool {
    let host = app.state::<PluginHost>();
    let guard = host.0.lock().unwrap_or_else(|error| error.into_inner());
    guard.current.as_ref().is_some_and(|instance| instance.plugin_id == "creator-studio")
}

/// headless 臂在 Studio 缺席时发布 ready presence：让 MCP 侧保持等待（不快速失败）
/// 而本臂在 500ms 内作答。Studio webview 打开时其自身 presence 发布会覆盖本文件
/// （每插件单文件设计），本函数检测到 Studio ready 即停写。
fn publish_headless_presence_if_studio_absent(home: &std::path::Path, studio_ready: bool) {
    if studio_ready { return; }
    if let Ok(existing) = agent_vitals_runtime::query::plugin_calls::read_consumer(home, "creator-studio") {
        if existing.as_ref().is_some_and(|presence| presence.instance_id == HEADLESS_CREATOR_INSTANCE
            && presence.acceptance == "ready") { return; }
    }
    let presence = agent_vitals_runtime::query::plugin_calls::ConsumerPresence {
        plugin_id: "creator-studio".into(), instance_id: HEADLESS_CREATOR_INSTANCE.into(), generation: 0,
        acceptance: "ready".into(), fault: None, pulse_age_ms: 0, hidden: false, hidden_for_ms: 0,
        in_flight: 0, ready: true, suspended: false,
    };
    if let Err(code) = agent_vitals_runtime::query::plugin_calls::publish_consumer(home, &presence) {
        agent_vitals_runtime::logging::log_warn("plugin_host", &format!("headless presence not recorded code={code}"));
    }
}

/// city.edit.preview Form B（world.set）的 headless 载荷转换：读权威 city 文档 →
/// 嵌入式合并/复验 → requestDigest 信封（与 webview attachValidation 的 Form B
/// 分支逐语义一致，digest 规格同 canonicalJson）。
fn headless_world_edit_payload(home: &std::path::Path, payload: &Value) -> Result<Value, &'static str> {
    let city_id = payload.get("cityId").and_then(Value::as_str).unwrap_or_default().to_owned();
    let base_revision = payload.get("baseRevision").and_then(Value::as_u64).unwrap_or_default();
    let city = crate::creator_cities::read_city(home, city_id.as_str())?;
    let (ok, profile) = crate::creator_projects::embedded_world_edit(&city, base_revision, &payload["operations"])?;
    let request = json!({"cityId": city_id, "baseRevision": base_revision, "profile": profile, "operations": payload["operations"]});
    let request_digest = crate::creator_store::digest(&crate::creator_store::canonical_json(&request).map_err(|_| "creator_city_invalid")?);
    Ok(json!({"cityId": city_id, "baseRevision": base_revision, "profile": profile,
        "operations": payload["operations"],
        "validation": {"schemaVersion": 1, "requestDigest": request_digest, "ok": ok}}))
}

/// creator.city.create 的 headless 载荷转换（与 webview attachValidation 的
/// creator.city.create 分支一致：SDK 语义 + requestDigest over 请求本身）。
fn headless_city_create_payload(home: &std::path::Path, payload: &Value) -> Result<Value, &'static str> {
    let name = payload.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    let seed = payload.get("seed").and_then(Value::as_u64).unwrap_or_default();
    let profile = payload.get("profile").cloned().unwrap_or(Value::Null);
    let ok = crate::creator_projects::embedded_city_create_validation(&name, seed, &profile)?;
    let request = json!({"name": name, "seed": seed, "profile": profile, "operationId": payload.get("operationId").cloned().unwrap_or(Value::Null)});
    let request_digest = crate::creator_store::digest(&crate::creator_store::canonical_json(&request).map_err(|_| "creator_city_invalid")?);
    let _ = home;
    Ok(json!({"name": name, "seed": seed, "profile": request["profile"].clone(),
        "operationId": request["operationId"].clone(),
        "validation": {"schemaVersion": 1, "requestDigest": request_digest, "ok": ok}}))
}

/// headless creator 臂的轮询入口：lib.rs setup 起一个 500ms 循环驱动。
pub(crate) fn poll_headless_creator_calls(app: &tauri::AppHandle) {
    let home = crate::overview::data_home();
    let studio_ready = studio_instance_ready(app);
    // Studio 实例存在即休眠（不只是 ready）：实例绑定的 preview/commit 必须由同一方
    // 完成，否则跨消费者提交会以 preview_expired 失败。
    if studio_instance_present(app) || !embedded_gate_integrity_ok() { return; }
    publish_headless_presence_if_studio_absent(&home, studio_ready);
    let Ok(calls) = agent_vitals_runtime::query::plugin_calls::claim_pending(
        &home, "creator-studio", HEADLESS_CREATOR_INSTANCE, &headless_creator_methods(), 4) else { return; };
    if calls.is_empty() { return; }
    let definition = definitions().iter().find(|plugin| plugin.id == "creator-studio");
    for call in &calls {
        let method = call["method"].as_str().unwrap_or_default().to_owned();
        let Some(call_id) = call["callId"].as_str().map(str::to_owned) else { continue };
        // claim_pending 返回的 payload 已经是 Value（不是 JSON 字符串）：早先按 as_str()
        // 解析会让每次 headless 调用都拿到空对象，dispatch 一律以 creator_request_invalid
        // 拒绝——单测直接传 payload，所以只有真机 W2 才暴露。
        let payload = call.get("payload").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({}));
        let response_budget = definition.map(|definition| transport_budget_for(definition, &method).1)
            .unwrap_or(TRANSPORT_BUDGET_DEFAULT_BYTES);
        let result = answer_headless_call(&home, &method, &payload);
        let response = match result {
            Ok(value) => json!({"ok": true, "result": value}),
            Err(code) => json!({"ok": false, "error": {"code": code}}),
        };
        if let Err(code) = agent_vitals_runtime::query::plugin_calls::respond_with_budget(
            &home, "creator-studio", HEADLESS_CREATOR_INSTANCE, &call_id, &response, response_budget) {
            agent_vitals_runtime::logging::log_warn("plugin_host", &format!("headless response not recorded code={code}"));
        }
    }
}

/// 单个 headless 调用的作答：vehicle 路径直连嵌入式变体（来源标记 embedded-sdk、
/// 语义通过即签发 previewId/落库），city/world 走 dispatch 后注入来源标记，
/// commit/只读方法与 Studio 在场时走同一宿主管线。
fn answer_headless_call(home: &std::path::Path, method: &str, payload: &Value) -> Result<Value, &'static str> {
    let project_id = payload.get("projectId").and_then(Value::as_str).unwrap_or_default().to_owned();
    let base_revision = payload.get("baseRevision").and_then(Value::as_u64).unwrap_or_default();
    match method {
        "creator.vehicle.preview" => {
            let raw_vehicle = if payload.get("vehicle").is_some() { payload["vehicle"].clone() }
                else { flattened_vehicle_payload(payload) };
            let (vehicle, envelope) = crate::creator_projects::embedded_vehicle_validation(&project_id, base_revision, &raw_vehicle)?;
            let mut preview = crate::creator_projects::preview_replace_vehicle_embedded(
                home, HEADLESS_CREATOR_INSTANCE, &project_id, base_revision, &vehicle, &envelope)?;
            // 与 Studio 预览同源的确定性性能预估（city-sdk estimateVehiclePerformanceV1）。
            if preview.get("previewId").is_some() {
                if let Ok(estimate) = crate::creator_projects::embedded_vehicle_estimate(&vehicle) {
                    preview["estimatedPerformance"] = estimate;
                }
            }
            Ok(preview)
        }
        "creator.vehicle.define" => {
            let raw_vehicle = if payload.get("vehicle").is_some() { payload["vehicle"].clone() }
                else { flattened_vehicle_payload(payload) };
            let (vehicle, envelope) = crate::creator_projects::embedded_vehicle_validation(&project_id, base_revision, &raw_vehicle)?;
            let operation_id = payload.get("operationId").and_then(Value::as_str).unwrap_or_default();
            crate::creator_projects::define_vehicle_embedded(home, crate::creator_projects::LOCAL_CREATOR_OWNER,
                &project_id, base_revision, &vehicle, &envelope, operation_id)
        }
        "creator.city.create" | "creator.city.edit.preview" | "creator.city.edit.commit"
        | "creator.city.list" | "creator.city.read" | "creator.vehicle.inspect"
        | "creator.project.commit" | "creator.project.create" | "creator.layout.list"
        | "creator.city.anchor.upsert" | "creator.city.anchor.remove" | "creator.mount.bind"
        | "creator.mount.unbind" | "creator.project.publish" | "creator.mount.list"
        | "creator.project.list" | "creator.operation.status"
        // V3 PR-7 前半：Story 注册表 / City Code 安装 / Inspect 只读——全部直接
        // 路由宿主 dispatch_as（与 Studio 在场时同一管线），无 headless 特例。
        | "creator.code.install.preview" | "creator.code.install.commit" | "creator.code.install.list"
        | "creator.story.project.create" | "creator.story.project.read" | "creator.story.projects.list"
        | "creator.actor.register" | "creator.actor.turn.context" | "creator.actor.intent.submit"
        | "creator.story.install.preview" | "creator.story.install.commit" | "creator.story.install.list"
        | "creator.story.run.start" | "creator.story.run.stop" | "creator.story.run.reset"
        | "creator.story.resident.lease.acquire" | "creator.story.resident.lease.release"
        | "creator.game.rules.inspect" | "creator.story.graph.inspect"
        | "creator.story.timeline.inspect" | "creator.game.intent.simulate" => {
            let transformed = match method {
                "creator.city.edit.preview" => headless_world_edit_payload(home, payload)?,
                "creator.city.create" => headless_city_create_payload(home, payload)?,
                _ => payload.clone(),
            };
            let mut result = crate::creator_projects::dispatch_as(home, crate::creator_projects::LOCAL_CREATOR_OWNER,
                HEADLESS_CREATOR_INSTANCE, method, &transformed)?;
            // 来源记录（E5）：city edit preview/commit 响应显式标注 embedded-sdk；
            // vehicle/game/scene 的标记由 preview/commit 管线自带。
            if matches!(method, "creator.city.edit.preview" | "creator.city.edit.commit") {
                result["validation"] = json!(crate::creator_projects::VALIDATION_SOURCE_EMBEDDED);
            }
            Ok(result)
        }
        _ => Err("creator_method_unavailable"),
    }
}

/// MCP define 面的展平字段 → 完整 profile 候选（camera 交给闸的确定性默认公式）。
fn flattened_vehicle_payload(payload: &Value) -> Value {
    json!({"schemaVersion": 1, "id": payload.get("vehicleId").cloned().unwrap_or(Value::Null),
        "label": payload.get("label").cloned().unwrap_or(Value::Null),
        "modelAssetId": payload.get("modelAssetId").cloned().unwrap_or(Value::Null),
        "flightModel": payload.get("flightModel").cloned().unwrap_or(Value::Null),
        "physics": payload.get("physics").cloned().unwrap_or(Value::Null),
        "bounds": payload.get("bounds").cloned().unwrap_or(Value::Null)})
}

/// lib.rs setup 驱动的 headless 臂循环。与 Studio 的 watchdog 相互独立：
/// watchdog 只在有插件 webview 后启动，而本臂必须在「app 在跑、Studio 从未打开」
/// 时就工作（这正是 headless 场景）。
pub(crate) fn start_headless_creator_tick(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        poll_headless_creator_calls(&app);
    });
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
            let generation = host.generation;
            if let Some(instance) = host.current.as_mut() {
                if refresh_fault(instance) { Some((instance.id.clone(), presence_of(instance, generation))) } else { None }
            } else { None }
        };
        if let Some((instance_id, presence)) = faulted_instance {
            report_new_fault(&presence);
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
            let resumed = {
                let mut host = state.0.lock().unwrap();
                let generation = host.generation;
                host.current.as_mut().filter(|i| i.id == id).map(|i| {
                    if i.suspended { i.suspended = false; i.pulse = Instant::now(); if !i.ready { i.started = Instant::now(); } note(i, "resumed"); }
                    presence_of(i, generation)
                })
            };
            if let Some(presence) = resumed { publish_presence(&presence); }
            return Ok(id);
        }
    }
    if bounds_only { return Err("plugin_instance_unavailable".into()); }
    let (old, old_generation) = {
        let mut host = state.0.lock().unwrap();
        let generation = host.generation;
        (host.current.take(), generation)
    };
    if let Some(old) = old {
        publish_presence(&presence_closed(&old, old_generation));
        crate::remote_gateway::close_sessions_for_instance(&app, &old.id);
        if let Some(view) = app.get_webview(&old.id) {
            agent_vitals_runtime::logging::log_warn("plugin_host", &format!("view.close() [replace] id={}", old.id));
            let _ = view.close();
        }
        // suspend 只是藏起 webview，实例 id 还在，试玩认领继续有效。真正拆掉
        // 之后 City 不会再 finish，claimed 槽位必须在这里收成可恢复的终态。
        settle_destroyed_playtest(&old.plugin_id, &old.id);
    }
    let id = {
        let mut host = state.0.lock().unwrap();
        host.generation += 1;
        let id = format!("plugin-{}-{}", definition.id, host.generation);
        let mut current = Instance { id: id.clone(), plugin_id: definition.id.clone(), command_namespace: definition.command_namespace.clone(), max_toolbar_items: definition.max_toolbar_items, performance_metrics: definition.performance_metrics.clone(), started: Instant::now(), pulse: Instant::now(), ready: false, suspended: false,
            page_hidden: false, hidden_since: None, failed: None, revision: 0, items: Vec::new(), sequence: 0, pending: None, in_flight: 0, busy_until: None, events: Vec::new() };
        note(&mut current, "create_started");
        let presence = presence_of(&current, host.generation);
        host.current = Some(current);
        (id, presence)
    };
    let (id, created) = id;
    publish_presence(&created);
    adopt_opened_playtest(&definition.id, &id);
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
            let reloaded = {
                let mut host = state.0.lock().unwrap();
                let generation = host.generation;
                if let Some(i) = host.current.as_mut().filter(|i| i.id == view.label()) {
                    if payload.event() == tauri::webview::PageLoadEvent::Started && i.ready {
                        i.failed = Some("plugin_reloaded"); note(i, "plugin_reloaded");
                        Some(presence_of(i, generation))
                    } else { note(i, "view_load"); None }
                } else { None }
            };
            if let Some(presence) = reloaded { report_new_fault(&presence); }
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
            let fault = {
                let mut host = state.0.lock().unwrap();
                let generation = host.generation;
                if let Some(current) = host.current.as_mut() {
                    current.failed = Some(code);
                    note(current, code);
                    Some(presence_of(current, generation))
                } else { None }
            };
            if let Some(presence) = fault { report_new_fault(&presence); }
            return Err(code.into());
        }
    };
    // Linux: add_child packs the view into the window's vertical GtkBox
    // beside the host; move it into the host overlay at the requested bounds.
    #[cfg(target_os = "linux")]
    crate::plugin_webview_layout::linux::adopt(&view, crate::plugin_webview_layout::overlay_child_geometry(bounds.x, bounds.y, bounds.width, bounds.height))?;
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
pub async fn plugin_close(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, instance_id: String, suspend: Option<bool>, reason: Option<String>) -> Result<(), String> {
    host_only(&webview)?;
    let _operation = state.1.lock().unwrap();
    let reason = canonical_close_reason(reason.as_deref());
    let entry = {
        let host = state.0.lock().unwrap();
        let generation = host.generation;
        host.current.as_ref().filter(|i| i.id == instance_id).map(|i| presence_of(i, generation))
    };
    agent_vitals_runtime::logging::log_info("plugin_host", &format!(
        "plugin_close entry id={instance_id} suspend={suspend:?} reason={reason} failed={} pulseAgeMs={} hidden={} generation={} ready={} inFlight={}",
        entry.as_ref().and_then(|presence| presence.fault.as_deref()).unwrap_or("none"),
        entry.as_ref().map(|presence| presence.pulse_age_ms).unwrap_or(0),
        entry.as_ref().map(|presence| presence.hidden).unwrap_or(false),
        entry.as_ref().map(|presence| presence.generation).unwrap_or(0),
        entry.as_ref().map(|presence| presence.ready).unwrap_or(false),
        entry.as_ref().map(|presence| presence.in_flight).unwrap_or(0),
    ));
    retain_diagnostic(&format!(
        "plugin_close id={instance_id} suspend={suspend:?} reason={reason} failed={}",
        entry.as_ref().and_then(|presence| presence.fault.as_deref()).unwrap_or("none"),
    ));
    if suspend == Some(true) {
        let suspended = {
            let mut host = state.0.lock().unwrap();
            let generation = host.generation;
            if let Some(i) = host.current.as_mut().filter(|i| i.id == instance_id && close_keeps_instance(Some(true), i.failed.is_some())) {
                i.suspended = true; i.pending = None; note(i, "suspended");
                Some(presence_of(i, generation))
            } else { None }
        };
        if let Some(presence) = suspended {
            publish_presence(&presence);
            if let Some(view) = app.get_webview(&instance_id) {
                let _ = view.eval("window.dispatchEvent(new Event('__AV_PLUGIN_SUSPENDED__'))");
                view.hide().map_err(|_| "plugin_hide_failed")?;
            }
            return Ok(());
        }
    }
    let old = {
        let mut host = state.0.lock().unwrap();
        let generation = host.generation;
        if host.current.as_ref().is_some_and(|i| i.id == instance_id) { Some((host.current.take(), generation)) } else { None }
    };
    if let Some((Some(old), generation)) = old {
        {
            publish_presence(&presence_closed(&old, generation));
            crate::remote_gateway::close_sessions_for_instance(&app, &old.id);
            if let Some(view) = app.get_webview(&old.id) {
                agent_vitals_runtime::logging::log_warn("plugin_host", &format!("view.close() [plugin_close] id={} reason={reason}", old.id));
                view.close().map_err(|_| "plugin_close_failed")?;
            }
            settle_destroyed_playtest(&old.plugin_id, &old.id);
        }
    }
    Ok(())
}

/// 只在 webview 被销毁时调用。suspend 隐藏同一实例，认领仍然有效，不能在这里收口。
fn settle_destroyed_playtest(plugin_id: &str, instance_id: &str) {
    if plugin_id != "city" { return; }
    let home = crate::overview::data_home();
    if let Err(code) = crate::creator_playtest::finalize_retired_city_claim(&home, instance_id) {
        agent_vitals_runtime::logging::log_warn("plugin_host", &format!("playtest retire city={instance_id} failed={code}"));
    }
}

/// 新实例 id 分配之后：Studio 成为既有试玩的继任取消者；City 收掉上一进程留下的认领。
fn adopt_opened_playtest(plugin_id: &str, instance_id: &str) {
    let home = crate::overview::data_home();
    let result = if plugin_id == "creator-studio" {
        crate::creator_playtest::note_current_studio_instance(&home, instance_id).map(|_| ())
    } else if plugin_id == "city" {
        crate::creator_playtest::finalize_playtests_claimed_by_other_cities(&home, instance_id).map(|_| ())
    } else {
        return;
    };
    if let Err(code) = result {
        agent_vitals_runtime::logging::log_warn("plugin_host", &format!("playtest adopt plugin={plugin_id} instance={instance_id} failed={code}"));
    }
}

#[tauri::command]
pub fn plugin_snapshot(webview: Webview, state: tauri::State<'_, PluginHost>) -> Result<Value, String> {
    host_only(&webview)?;
    let (body, fault) = {
        let mut host = state.0.lock().unwrap();
        let generation = host.generation;
        let Some(i) = host.current.as_mut() else { return Ok(Value::Null); };
        let became = refresh_fault(i);
        let fault = if became { Some(presence_of(i, generation)) } else { None };
        let body = json!({"pluginId": i.plugin_id, "instanceId": i.id, "status": if i.failed.is_some() { "failed" } else if i.ready { "ready" } else { "loading" },
            "error": i.failed, "revision": i.revision, "items": i.items, "pending": i.pending.as_ref().map(|(id, _)| id), "events": i.events});
        (body, fault)
    };
    if let Some(presence) = fault { report_new_fault(&presence); }
    Ok(body)
}

#[tauri::command]
pub fn plugin_message(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, message: Value) -> Result<(), String> {
    let kind = message["type"].as_str().unwrap_or("").to_string();
    let hidden_declared = message.get("diagnostic").and_then(|diagnostic| diagnostic.get("hidden")).and_then(Value::as_bool).is_some();
    let changed = kind != "heartbeat" && kind != "plugin.performance";
    let (result, presence, faulted) = {
        let mut host = state.0.lock().unwrap();
        let generation = host.generation;
        let i = host.current.as_mut().ok_or("plugin_instance_unavailable")?;
        let failed_before = i.failed;
        let result = apply_message(i, webview.label(), message);
        let faulted = result.is_ok() && i.failed.is_some() && failed_before.is_none();
        let publish = result.is_ok() && (faulted || kind == "toolbar.update" || (kind == "heartbeat" && hidden_declared));
        let presence = if publish { Some(presence_of(i, generation)) } else { None };
        (result, presence, faulted)
    };
    if let Some(presence) = presence {
        if faulted { report_new_fault(&presence); } else { publish_presence(&presence); }
    }
    if result.is_ok() && changed { notify_host(&app); }
    result
}

fn apply_message(i: &mut Instance, sender: &str, message: Value) -> Result<(), String> {
    if i.id != sender || message["instanceId"] != i.id || message["version"] != 1 { return Err("plugin_instance_mismatch".into()); }
    match message["type"].as_str() {
        Some("heartbeat") => {
            i.pulse = Instant::now();
            if let Some(source) = message["diagnostic"].as_object() {
                    if let Some(hidden) = source.get("hidden").and_then(Value::as_bool) {
                        i.page_hidden = hidden;
                        // Re-arm/clear with every declaration so the watchdog can
                        // tell a live hidden page from a stale hidden flag.
                        i.hidden_since = if hidden { Some(Instant::now()) } else { None };
                    }
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
            log_plugin_performance(&i.plugin_id, &fields);
        }
        Some("code-game.state") => {
            // City 预览状态：唯一落盘路径。字段白名单/范围在
            // creator_code_game::record_preview_state 内校验，这里只做路由。
            crate::creator_code_game::record_preview_state(&crate::overview::data_home(), &message["state"])
                .map_err(|_| "code_game_state_invalid")?;
            i.pulse = Instant::now();
        }
        Some("runtime.error") => {
            i.failed = Some("plugin_runtime_error");
            // 受控错误码（诊断 serving-face 约束）：异常 message/stack 可能带本地
            // 路径、项目内容等用户数据，不落诊断文件。只收保守字符集限定的错误
            // 标识符；其余字段丢弃，而不是截断后入库。
            let name = message["error"]["name"].as_str()
                .filter(|name| !name.is_empty() && name.len() <= 120
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-' | ':' | '#')))
                .map(str::to_owned);
            let detail = name.map_or_else(|| json!({}), |name| json!({ "name": name }));
            if i.events.len() == 100 { i.events.remove(0); }
            i.events.push(json!({"atMs": i.started.elapsed().as_millis() as u64, "code": "plugin_runtime_error", "error": detail}));
            persist_diagnostics(i);
        }
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
    // 12 个维度上限：frame 事件需要 fps/p50/p95/max/draw_calls/triangles/quality/idle/
    // dpr/hidden/window_days/load_id 正好 12 个。多一个就拒绝，保持有界。
    let dimensions = object.get("dimensions").and_then(Value::as_object).filter(|dimensions| dimensions.len() <= 12)
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

/// Unit tests call `apply_message` directly; before this guard those calls wrote
/// synthetic `elapsed_ms=5678` scene records into the user's real `app.log`,
/// where they were indistinguishable from production telemetry. Keep logging
/// out of `cfg(test)` builds; the logger module has its own isolated tests.
fn log_plugin_performance(plugin_id: &str, fields: &str) {
    #[cfg(not(test))]
    {
        agent_vitals_runtime::logging::log_info(
            "plugin_performance",
            &format!("plugin={plugin_id} {fields}"),
        );
    }
    #[cfg(test)]
    let _ = (plugin_id, fields);
}

/// Record a rejected plugin request without its payload. The 2026-11-20 Linux
/// acceptance showed `plugin_instance_mismatch` in the Studio UI and nothing
/// in app.log: the host returned the code and did not name the instance.
fn log_plugin_request_rejected(plugin_id: &str, instance_id: &str, method: &str, request_id: &str, reason: &str) {
    #[cfg(not(test))]
    {
        let safe = |value: &str| !value.is_empty() && value.len() <= 80
            && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
        if [plugin_id, instance_id, method, request_id, reason].iter().copied().all(safe) {
            agent_vitals_runtime::logging::log_info(
                "plugin_request",
                &format!("plugin={plugin_id} instance={instance_id} method={method} request_id={request_id} reason={reason} code=plugin_instance_mismatch"),
            );
        }
    }
    #[cfg(test)]
    let _ = (plugin_id, instance_id, method, request_id, reason);
}

/// Creator catalog reads run from the library effect before `toolbar.update`
/// sets `ready`. A live Studio instance may dispatch those calls. Click-driven
/// export, import, and content dialogs keep their own `ready` checks.
fn studio_creator_dispatch_denial(current: Option<&Instance>, instance_id: &str) -> Option<&'static str> {
    let Some(instance) = current else { return Some("missing"); };
    if instance.plugin_id != "creator-studio" { return Some("plugin"); }
    if instance.id != instance_id { return Some("instance"); }
    if instance.suspended { return Some("suspended"); }
    if instance.failed.is_some() { return Some("failed"); }
    None
}

#[tauri::command]
pub async fn plugin_request(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, request: PluginRequestV1) -> Result<PluginResponseV1, String> {
    let (allowed, navigation, state_keys, typed_data_grants, legacy_data_grants, object_grants, scope_grants, remote_capabilities, local_calls, plugin_id) = {
        let host = state.0.lock().unwrap();
        let i = host.current.as_ref().ok_or("plugin_instance_unavailable")?;
        if i.id != webview.label() || i.failed.is_some() || i.suspended || request.instance_id != i.id {
            let reason = if i.id != webview.label() { "webview" }
                else if i.failed.is_some() { "failed" }
                else if i.suspended { "suspended" }
                else { "instance" };
            log_plugin_request_rejected(&i.plugin_id, &i.id, &request.method, &request.request_id, reason);
            return Err("plugin_instance_mismatch".into());
        }
        if let Err(code) = validate_plugin_request(&request) {
            return Ok(plugin_request_error(request.request_id, code, false));
        }
        let definition = definitions().iter().find(|p| p.id == i.plugin_id).ok_or("plugin_unknown")?;
        (definition.data_projections.clone(), definition.navigation_targets.clone(), definition.state_keys.clone(), definition.typed_data_grants.clone(), definition.legacy_data_grants.clone(), definition.object_grants.clone(), definition.scope_grants.clone(), definition.remote_capabilities.clone(), definition.local_calls.clone(), i.plugin_id.clone())
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
    if crate::creator_city_host::classify_local_call(&method) == Some(crate::creator_city_host::LocalCall::LayoutPublish) {
        let _operation = state.1.lock().unwrap();
        {
            let host = state.0.lock().unwrap();
            if !city_creator_runtime_authorized(&host, &plugin_id, &request.instance_id, &local_calls, &method) {
                return Err("plugin_instance_mismatch".into());
            }
        }
        let result = crate::creator_projects::publish_city_layout_snapshot(&crate::overview::data_home(), &payload);
        return Ok(match result {
            Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
            Err(code) => plugin_request_error(request.request_id, code, matches!(code, "creator_store_unavailable")),
        });
    }
    if crate::creator_city_host::classify_local_call(&method) == Some(crate::creator_city_host::LocalCall::Runtime) {
        if crate::creator_city_host::is_playtest_call(&method) {
            agent_vitals_runtime::logging::log_info("creator_playtest", &format!("plugin_request method={method} instance={}", request.instance_id));
        }
        let _operation = state.1.lock().unwrap();
        {
            let host = state.0.lock().unwrap();
            if !city_creator_runtime_authorized(&host, &plugin_id, &request.instance_id, &local_calls, &method) {
                agent_vitals_runtime::logging::log_warn("creator_playtest", &format!("authorization_denied method={method} instance={}", request.instance_id));
                return Err("plugin_instance_mismatch".into());
            }
        }
        let result = crate::creator_projects::dispatch_city_runtime(&crate::overview::data_home(), &request.instance_id, &method, &payload);
        drop(_operation);
        if crate::creator_city_host::is_playtest_finish(&method) {
            if let Ok(value) = &result {
                let _ = app.emit("app-event", json!({"type":"CreatorPlaytestReturnRequested","runId":value["runId"],
                    "projectId":value["projectId"],"revision":value["revision"],"status":value["status"],"failureCode":value["failureCode"]}));
            }
        }
        return Ok(match result {
            Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
            Err(code) => plugin_request_error(request.request_id, code, matches!(code, "creator_store_unavailable")),
        });
    }
    if method.starts_with("creator.") {
        if plugin_id != "creator-studio" { return Ok(plugin_request_error(request.request_id, "permission_denied", false)); }
        if !local_calls.iter().any(|allowed| allowed == &method) { return Ok(plugin_request_error(request.request_id, "permission_denied", false)); }
        if method == "creator.source.export" || method == "creator.experience.export"
            || crate::creator_city_host::classify_local_call(&method) == Some(crate::creator_city_host::LocalCall::SourceExport) {
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    agent_vitals_runtime::logging::log_warn("creator_export", &format!("request rejected method={method} instance={}", request.instance_id));
                    return Err("plugin_instance_mismatch".into());
                }
            }
            // Logged before the dialog so a click that reaches the host is
            // distinguishable from a click the page never sent. No path.
            agent_vitals_runtime::logging::log_info("creator_export", &format!("request method={method} instance={}", request.instance_id));
            let parent_window = app.get_window("workbench");
            let started = std::time::Instant::now();
            let title = if method == "creator.experience.export" { "选择体验包导出目录" } else { "选择源码导出目录" };
            let selected = match tauri::async_runtime::spawn_blocking(move || {
                let dialog = rfd::FileDialog::new().set_title(title);
                match parent_window {
                    Some(window) => dialog.set_parent(&window).pick_folder(),
                    None => dialog.pick_folder(),
                }
            }).await {
                Ok(value) => value,
                Err(_) => {
                    agent_vitals_runtime::logging::log_warn("creator_export", &format!("picker method={method} result=unavailable elapsedMs={}", started.elapsed().as_millis()));
                    return Ok(plugin_request_error(request.request_id, "creator_export_picker_unavailable", false));
                }
            };
            let elapsed_ms = started.elapsed().as_millis();
            let outcome = crate::creator_source_export::classify_folder_picker(selected.is_some());
            // elapsedMs is a measurement. It does not decide cancel versus a
            // missing dialog, and the line has no path.
            agent_vitals_runtime::logging::log_info("creator_export", &format!("picker method={method} result={outcome} elapsedMs={elapsed_ms}"));
            let Some(parent) = selected else {
                return Ok(plugin_request_error(request.request_id, "creator_export_cancelled", false));
            };
            let _operation = state.1.lock().unwrap();
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let result = if method == "creator.experience.export" {
                crate::creator_experience::export_experience(&crate::overview::data_home(), &parent, &payload)
            } else if crate::creator_city_host::classify_local_call(&method) == Some(crate::creator_city_host::LocalCall::SourceExport) {
                crate::creator_source_export::export_city_source(&crate::overview::data_home(), &parent, &payload)
            } else {
                crate::creator_source_export::export_source(&crate::overview::data_home(), &parent, &payload)
            };
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            return Ok(match result {
                Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
                Err(code) => plugin_request_error(request.request_id, code, matches!(code, "creator_store_unavailable")),
            });
        }
        if method == "creator.content.inspect" {
            if !payload.as_object().is_some_and(|object| object.is_empty()) { return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false)); }
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let selected = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new()
                .add_filter("City 内容包", &["json"]).pick_file()).await.map_err(|_| "content_picker_failed".to_string())?;
            let Some(source) = selected else { return Ok(plugin_request_error(request.request_id, "content_picker_cancelled", false)); };
            let source_for_remember = source.clone();
            let result = tauri::async_runtime::spawn_blocking(move || crate::creator_content_v2::inspect_selected_world_file(&source))
                .await.map_err(|_| "content_inspection_failed".to_string())?;
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            return Ok(match result {
                Ok(mut value) => {
                    let Some(package_id) = value["packageId"].as_str().map(str::to_owned) else { return Ok(plugin_request_error(request.request_id, "content_inspect_invalid", false)); };
                    let Some(version) = value["version"].as_str().map(str::to_owned) else { return Ok(plugin_request_error(request.request_id, "content_inspect_invalid", false)); };
                    let Some(digest) = value["contentDigest"].as_str().map(str::to_owned) else { return Ok(plugin_request_error(request.request_id, "content_inspect_invalid", false)); };
                    match crate::creator_content_install::remember_inspection(&crate::overview::data_home(), &request.instance_id, &source_for_remember, &package_id, &version, &digest) {
                        Ok(token) => { value["inspectionId"] = json!(token);
                            PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None } }
                        Err(code) => plugin_request_error(request.request_id, code, false),
                    }
                }
                Err(code) => plugin_request_error(request.request_id, code, false),
            });
        }
        if method == "creator.content.install" {
            let Some(object) = payload.as_object().filter(|object| object.len() == 1
                && object.keys().all(|key| key == "inspectionId")) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let Some(inspection_id) = object.get("inspectionId").and_then(Value::as_str) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let _operation = state.1.lock().unwrap();
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let home = crate::overview::data_home();
            let claimed = match crate::creator_content_install::claim_inspection(&home, &request.instance_id, inspection_id) {
                Ok(claimed) => claimed,
                Err(code) => return Ok(plugin_request_error(request.request_id, code, false)),
            };
            let result = crate::creator_content_v2::read_selected_world_file(&claimed.source)
                .and_then(|raw| crate::creator_content_install::install_inspected_world(&home, &raw, &claimed.package_id, &claimed.version, &claimed.digest));
            drop(_operation);
            return Ok(match result {
                Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
                Err(code) => plugin_request_error(request.request_id, code, false),
            });
        }
        if matches!(method.as_str(), "creator.content.snapshot.open" | "creator.content.snapshot.read" | "creator.content.snapshot.close") {
            let Some(object) = payload.as_object() else { return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false)); };
            let _operation = state.1.lock().unwrap();
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let home = crate::overview::data_home();
            let result = if method == "creator.content.snapshot.open" && object.len() == 2 {
                match (object.get("packageId").and_then(Value::as_str), object.get("version").and_then(Value::as_str)) {
                    (Some(id), Some(version)) => crate::creator_content_install::open_content_snapshot(&home, &request.instance_id, id, version),
                    _ => Err("creator_request_invalid"),
                }
            } else if method == "creator.content.snapshot.read" && object.len() == 3 {
                match (object.get("snapshotId").and_then(Value::as_str), object.get("path").and_then(Value::as_str), object.get("offset").and_then(Value::as_u64)) {
                    (Some(id), Some(path), Some(offset)) => crate::creator_content_install::read_content_snapshot(&home, &request.instance_id, id, path, offset),
                    _ => Err("creator_request_invalid"),
                }
            } else if method == "creator.content.snapshot.close" && object.len() == 1 {
                match object.get("snapshotId").and_then(Value::as_str) {
                    Some(id) => crate::creator_content_install::close_content_snapshot(&home, &request.instance_id, id),
                    _ => Err("creator_request_invalid"),
                }
            } else { Err("creator_request_invalid") };
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    if method == "creator.content.snapshot.open" {
                        if let Ok(value) = &result {
                            if let Some(id) = value["snapshotId"].as_str() { let _ = crate::creator_content_install::close_content_snapshot(&home, &request.instance_id, id); }
                        }
                    }
                    return Err("plugin_instance_mismatch".into());
                }
            }
            return Ok(match result {
                Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
                Err(code) => plugin_request_error(request.request_id, code, false),
            });
        }
        if method == "creator.content.list" {
            if !payload.as_object().is_some_and(|object| object.is_empty()) { return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false)); }
            let _operation = state.1.lock().unwrap();
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let result = crate::creator_content_install::list_installed(&crate::overview::data_home());
            drop(_operation);
            return Ok(match result {
                Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
                Err(code) => plugin_request_error(request.request_id, code, false),
            });
        }
        if method == "creator.content.uninstall" {
            let Some(object) = payload.as_object().filter(|object| object.len() == 2
                && object.keys().all(|key| matches!(key.as_str(), "packageId" | "version"))) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let Some(package_id) = object.get("packageId").and_then(Value::as_str) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let Some(version) = object.get("version").and_then(Value::as_str) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let _operation = state.1.lock().unwrap();
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let result = crate::creator_content_install::uninstall(&crate::overview::data_home(), package_id, version);
            drop(_operation);
            return Ok(match result {
                Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
                Err(code) => plugin_request_error(request.request_id, code, false),
            });
        }
        if method == "creator.asset.import" {
            let Some(object) = payload.as_object().filter(|object| object.len() == 3
                && object.keys().all(|key| matches!(key.as_str(), "projectId" | "expectedRevision" | "operationId"))) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let Some(project_id) = object.get("projectId").and_then(Value::as_str).map(str::to_owned) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let Some(expected_revision) = object.get("expectedRevision").and_then(Value::as_u64) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let Some(operation_id) = object.get("operationId").and_then(Value::as_str).map(str::to_owned) else {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            };
            let valid_creator_id = |value: &str| !value.is_empty() && value.len() <= 128
                && value.as_bytes()[0].is_ascii_alphanumeric()
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
            if !valid_creator_id(&project_id) || !valid_creator_id(&operation_id) {
                return Ok(plugin_request_error(request.request_id, "creator_request_invalid", false));
            }
            {
                let host = state.0.lock().unwrap();
                if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let selected = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new()
                .add_filter("glTF Binary", &["glb"]).pick_file())
                .await.map_err(|_| "creator_asset_picker_failed".to_string())?;
            let Some(source) = selected else { return Ok(plugin_request_error(request.request_id, "creator_asset_import_cancelled", false)); };
            let result = {
                let _operation = state.1.lock().unwrap();
                {
                    let host = state.0.lock().unwrap();
                    if !host.current.as_ref().is_some_and(|instance| instance.id == request.instance_id && instance.plugin_id == "creator-studio" && instance.ready && !instance.suspended && instance.failed.is_none()) {
                        return Err("plugin_instance_mismatch".into());
                    }
                }
                crate::creator_projects::import_model_asset(&crate::overview::data_home(), crate::creator_projects::LOCAL_CREATOR_OWNER,
                    &project_id, expected_revision, &operation_id, &source)
            };
            return Ok(match result {
                Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
                Err(code) => plugin_request_error(request.request_id, code, matches!(code, "creator_store_unavailable")),
            });
        }
        // Serialize authorization and SQLite commit against plugin_open/close. A
        // switch cannot revoke the instance between this check and the write.
        // `ready` is intentionally not required: the library panel reads the
        // empty catalog before the first toolbar publication.
        let (result, playtest_ack) = {
            let _operation = state.1.lock().unwrap();
            {
                let host = state.0.lock().unwrap();
                if let Some(reason) = studio_creator_dispatch_denial(host.current.as_ref(), &request.instance_id) {
                    log_plugin_request_rejected("creator-studio", &request.instance_id, &method, &request.request_id, reason);
                    return Err("plugin_instance_mismatch".into());
                }
            }
            let instance = request.instance_id.clone();
            let home = crate::overview::data_home();
            let result = crate::creator_projects::dispatch_as(&home, crate::creator_projects::LOCAL_CREATOR_OWNER, &instance, &method, &payload);
            // 邮箱里的 start 必须在拆掉 Studio 之前写成完成。导航事件一发出，
            // 当前 webview 就被换成 City，随后的 plugin.call.respond 不会再到达。
            let playtest_ack = if method == "creator.project.playtest.start" {
                if let Ok(value) = &result {
                    let response_budget = definitions().iter().find(|plugin| plugin.id == "creator-studio")
                        .map(|definition| transport_budget_for(definition, "creator.project.playtest.start").1)
                        .unwrap_or(TRANSPORT_BUDGET_DEFAULT_BYTES);
                    Some(settle_playtest_mailbox(&home, "creator-studio", &instance, &request.request_id, value, response_budget))
                } else { None }
            } else { None };
            (result, playtest_ack)
        };
        if method == "creator.project.playtest.start" {
            if let Ok(value) = &result {
                match &playtest_ack {
                    Some(PlaytestMailboxAck::Committed) | Some(PlaytestMailboxAck::NotMailbox) => {
                        emit_playtest_city_open(&app, &value["runId"]);
                    }
                    // 只有「本实例确有这条 playtest.start claim，但提前写入失败」才记住。
                    // 别人的 claim、别的方法不能借这次成功去打开 City。
                    Some(PlaytestMailboxAck::Uncommitted { call_id }) => {
                        if let Some(run_id) = value["runId"].as_str() {
                            note_unacked_playtest_open(call_id, run_id);
                        }
                    }
                    Some(PlaytestMailboxAck::NotOwned) | None => {}
                }
            }
        }
        return Ok(match result {
            Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
            Err(code) => plugin_request_error(request.request_id, code, matches!(code, "creator_store_unavailable")),
        });
    }
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
        // 响应预算（§5.5）由宿主按描述符的 claimed 方法执行，而不是固定 64 KiB；
        // 超预算时 respond_with_budget 写入小错误响应终结调用。
        let data_home = crate::overview::data_home();
        let claimed_method = agent_vitals_runtime::query::plugin_calls::claimed_call_method(
            &data_home, &plugin_id, &request.instance_id, &call_id).ok().flatten().unwrap_or_default();
        let (_request_budget, response_budget) = {
            let definition = definitions().iter().find(|plugin| plugin.id == plugin_id);
            match definition {
                Some(definition) => transport_budget_for(definition, &claimed_method),
                None => (TRANSPORT_BUDGET_DEFAULT_BYTES, TRANSPORT_BUDGET_DEFAULT_BYTES),
            }
        };
        // Keep the instance lock across the bounded local DB response commit:
        // plugin_open/close cannot replace this owner between validation and delivery.
        let result = agent_vitals_runtime::query::plugin_calls::respond_with_budget(
            &data_home, &plugin_id, &request.instance_id, &call_id, &response_value, response_budget,
        );
        // 应答落盘后再放开实例锁，然后才导航。用的是 dispatch 记下的 runId。
        let deferred_open = if result.is_ok() && response_value.get("ok") == Some(&Value::Bool(true)) {
            take_unacked_playtest_open(&call_id)
        } else { None };
        drop(host);
        if let Some(run_id) = deferred_open {
            emit_playtest_city_open(&app, &json!(run_id));
        }
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

/// 邮箱调用的 requestId 由 app-sdk 固定成 `plugin-call-` + `pc_` + 32 位十六进制。
/// 界面按钮走 `creator-ui:N`，不是邮箱。
fn mailbox_playtest_call_id(request_id: &str) -> Option<&str> {
    let call_id = request_id.strip_prefix("plugin-call-")?;
    let rest = call_id.strip_prefix("pc_")?;
    if rest.len() == 32 && rest.bytes().all(|byte| byte.is_ascii_hexdigit()) { Some(call_id) } else { None }
}

fn valid_playtest_run_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty() && bytes.len() <= 128 && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[derive(Debug)]
enum PlaytestMailboxAck {
    /// 不是邮箱请求。调用方可以马上导航，没有正在等的 MCP。
    NotMailbox,
    /// 本实例 claim 的 playtest.start 已经写成完成。MCP 不必再等 webview。
    Committed,
    /// 本实例拥有这条 playtest.start claim，但写入失败。调用还在，等 webview 再答一次。
    Uncommitted { call_id: String },
    /// 请求号像邮箱调用，但这条 claim 不是本实例的 playtest.start。不要导航，也不要记住。
    NotOwned,
}

/// 把试玩 start 的宿主结果写入已经由本实例 claim 的那一通调用。
/// 只接受方法恰好是 creator.project.playtest.start 的 claim，别的方法原样留着。
fn settle_playtest_mailbox(home: &std::path::Path, plugin_id: &str, instance_id: &str, request_id: &str, result: &Value, response_budget: usize) -> PlaytestMailboxAck {
    let Some(call_id) = mailbox_playtest_call_id(request_id) else { return PlaytestMailboxAck::NotMailbox };
    let owned = agent_vitals_runtime::query::plugin_calls::claimed_call_method(home, plugin_id, instance_id, call_id)
        .ok().flatten();
    if owned.as_deref() != Some("creator.project.playtest.start") {
        return PlaytestMailboxAck::NotOwned;
    }
    let response = json!({"ok": true, "result": result});
    match agent_vitals_runtime::query::plugin_calls::respond_with_budget(
        home, plugin_id, instance_id, call_id, &response, response_budget,
    ) {
        Ok(()) => PlaytestMailboxAck::Committed,
        Err(_) => PlaytestMailboxAck::Uncommitted { call_id: call_id.to_owned() },
    }
}

fn emit_playtest_city_open(app: &tauri::AppHandle, run_id: &Value) {
    let Some(run_id) = run_id.as_str().filter(|id| valid_playtest_run_id(id)) else { return };
    let _ = app.emit("app-event", json!({"type":"CreatorPlaytestOpenCityRequested","runId":run_id}));
}

fn pending_playtest_opens() -> &'static Mutex<std::collections::VecDeque<(String, String)>> {
    static OPENS: OnceLock<Mutex<std::collections::VecDeque<(String, String)>>> = OnceLock::new();
    OPENS.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}

fn note_unacked_playtest_open(call_id: &str, run_id: &str) {
    if mailbox_playtest_call_id(&format!("plugin-call-{call_id}")).is_none() || !valid_playtest_run_id(run_id) { return; }
    let mut queue = pending_playtest_opens().lock().unwrap_or_else(|error| error.into_inner());
    queue.retain(|(id, _)| id != call_id);
    queue.push_back((call_id.to_owned(), run_id.to_owned()));
    while queue.len() > 16 { queue.pop_front(); }
}

fn take_unacked_playtest_open(call_id: &str) -> Option<String> {
    let mut queue = pending_playtest_opens().lock().unwrap_or_else(|error| error.into_inner());
    let index = queue.iter().position(|(id, _)| id == call_id)?;
    queue.remove(index).map(|(_, run_id)| run_id)
}

fn plugin_response_owner_active(host: &HostState, instance_id: &str, plugin_id: &str) -> bool {
    host.current.as_ref().is_some_and(|instance| instance.id == instance_id && instance.plugin_id == plugin_id
        && instance.failed.is_none() && !instance.suspended)
}

fn city_creator_runtime_authorized(host: &HostState, plugin_id: &str, instance_id: &str, local_calls: &[String], method: &str) -> bool {
    plugin_id == "city" && local_calls.iter().any(|allowed| allowed == method)
        && host.current.as_ref().is_some_and(|instance| instance.id == instance_id && instance.plugin_id == "city"
            && instance.ready && !instance.suspended && instance.failed.is_none())
}

#[cfg(test)]
mod plugin_request_tests {
    // 按方法传输预算（§5.5）：描述符是唯一配置点，宿主启动即校验并 clamp 到
    // IPC 安全上限；未声明的方法保持 64 KiB 默认。
    #[test]
    fn transport_budgets_default_clamp_and_validate() {
        let parse = |json: &str| -> Result<PluginRegistry, _> { serde_json::from_str(json) };
        let base = |budgets: &str| format!(r#"{{
            "version": 1,
            "plugins": [{{
                "id": "creator-studio", "name": "Creator Studio",
                "entry": "plugins/CreatorStudio.plugin/ui/index.html",
                "commandNamespace": "creator", "maxToolbarItems": 4,
                "localCalls": ["creator.scene.preview"],
                "localCallBudgets": {budgets}
            }}]
        }}"#);
        // 合法声明：方向、上限内
        let ok = parse(&base(r#"{"creator.scene.preview": {"requestBytes": 393216, "responseBytes": 65536}}"#)).unwrap();
        let (request, response) = transport_budget_for(ok.plugins.first().unwrap(), "creator.scene.preview");
        assert_eq!((request, response), (393216, 65536));
        // 未声明方法回落默认 64 KiB
        let (request, response) = transport_budget_for(ok.plugins.first().unwrap(), "creator.project.read");
        assert_eq!((request, response), (TRANSPORT_BUDGET_DEFAULT_BYTES, TRANSPORT_BUDGET_DEFAULT_BYTES));
        // 超上限：启动校验拒绝（definitions 的 assert 路径不可直调，这里验证解析产物被 clamp）
        let over = parse(&base(r#"{"creator.scene.preview": {"requestBytes": 2097152, "responseBytes": 65536}}"#)).unwrap();
        let (request, _response) = transport_budget_for(over.plugins.first().unwrap(), "creator.scene.preview");
        assert_eq!(request, TRANSPORT_BUDGET_MAX_BYTES as usize, "descriptor values are clamped, trusted only after validation");
        // 未知字段：严格拒绝，防止拼写错误静默失效
        assert!(parse(&base(r#"{"creator.scene.preview": {"requestBytes": 65536, "responsBytes": 65536}}"#)).is_err());
        // budget 指向未授予方法：definitions 校验会拒绝（这里只验证解析层接受、校验层字段存在）
        let stray = parse(&base(r#"{"creator.project.read": {"requestBytes": 65536, "responseBytes": 65536}}"#)).unwrap();
        assert!(stray.plugins.first().unwrap().local_call_budgets.contains_key("creator.project.read"));
    }

    use super::*;

    fn studio_instance(id: &str, ready: bool, suspended: bool, failed: Option<&'static str>) -> Instance {
        let now = Instant::now();
        Instance {
            id: id.into(), plugin_id: "creator-studio".into(), command_namespace: "creator".into(),
            max_toolbar_items: 8, performance_metrics: Vec::new(), started: now, pulse: now,
            ready, suspended, page_hidden: false, hidden_since: None, failed, revision: 0,
            items: Vec::new(), sequence: 0, pending: None, in_flight: 0, busy_until: None, events: Vec::new(),
        }
    }

    #[test]
    fn studio_catalog_dispatch_allows_the_live_instance_before_toolbar_ready() {
        let pending = studio_instance("plugin-creator-studio-1", false, false, None);
        assert!(studio_creator_dispatch_denial(Some(&pending), "plugin-creator-studio-1").is_none(),
            "the library effect reads the catalog before toolbar.update sets ready");
        let ready = studio_instance("plugin-creator-studio-1", true, false, None);
        assert!(studio_creator_dispatch_denial(Some(&ready), "plugin-creator-studio-1").is_none());
        assert_eq!(studio_creator_dispatch_denial(None, "plugin-creator-studio-1"), Some("missing"));
        assert_eq!(studio_creator_dispatch_denial(Some(&pending), "plugin-creator-studio-3"), Some("instance"));
        let mut other = pending;
        other.plugin_id = "city".into();
        assert_eq!(studio_creator_dispatch_denial(Some(&other), "plugin-creator-studio-1"), Some("plugin"));
        let suspended = studio_instance("plugin-creator-studio-1", true, true, None);
        assert_eq!(studio_creator_dispatch_denial(Some(&suspended), "plugin-creator-studio-1"), Some("suspended"));
        let failed = studio_instance("plugin-creator-studio-1", true, false, Some("plugin_command_rejected"));
        assert_eq!(studio_creator_dispatch_denial(Some(&failed), "plugin-creator-studio-1"), Some("failed"));
    }

    /// 邮箱里的 start 在导航之前就要写成完成。界面按钮不是邮箱，不能把别人的
    /// claim 关掉；别的方法、别的实例也写不进去。
    #[test]
    fn mailbox_playtest_start_is_acked_before_city_can_replace_studio() {
        let home = std::env::temp_dir().join(format!("playtest-ack-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&home).unwrap();
        let payload = json!({"releaseId":"release-1"});
        let call_id = agent_vitals_runtime::query::plugin_calls::submit(
            &home, "creator-studio", "creator.project.playtest.start", &payload, 60_000).unwrap();
        let claimed = agent_vitals_runtime::query::plugin_calls::claim_pending(
            &home, "creator-studio", "studio-1", &["creator.project.playtest.start".into()], 4).unwrap();
        assert_eq!(claimed.len(), 1);
        let result = json!({"runId":"playtest-1","releaseId":"release-1","status":"pending"});
        let request_id = format!("plugin-call-{call_id}");
        assert!(matches!(
            settle_playtest_mailbox(&home, "creator-studio", "studio-1", &request_id, &result, 64 * 1024),
            PlaytestMailboxAck::Committed));
        let response = agent_vitals_runtime::query::plugin_calls::wait_response(&home, &call_id, 1_000).unwrap();
        assert_eq!(response["ok"], json!(true));
        assert_eq!(response["result"]["runId"], json!("playtest-1"));
        assert_eq!(
            agent_vitals_runtime::query::plugin_calls::respond(&home, "creator-studio", "studio-1", &call_id, &json!({"ok":true,"result":result.clone()})).unwrap_err(),
            "plugin_call_unavailable");
        let other = agent_vitals_runtime::query::plugin_calls::submit(
            &home, "creator-studio", "creator.project.playtest.start", &payload, 60_000).unwrap();
        agent_vitals_runtime::query::plugin_calls::claim_pending(
            &home, "creator-studio", "studio-1", &["creator.project.playtest.start".into()], 4).unwrap();
        assert!(matches!(
            settle_playtest_mailbox(&home, "creator-studio", "studio-1", "creator-ui:7", &result, 64 * 1024),
            PlaytestMailboxAck::NotMailbox));
        assert_eq!(
            agent_vitals_runtime::query::plugin_calls::claimed_call_method(&home, "creator-studio", "studio-1", &other).unwrap().as_deref(),
            Some("creator.project.playtest.start"));
        let other_request = format!("plugin-call-{other}");
        assert!(matches!(
            settle_playtest_mailbox(&home, "creator-studio", "studio-2", &other_request, &result, 64 * 1024),
            PlaytestMailboxAck::NotOwned));
        assert_eq!(
            agent_vitals_runtime::query::plugin_calls::claimed_call_method(&home, "creator-studio", "studio-1", &other).unwrap().as_deref(),
            Some("creator.project.playtest.start"));
        // 过期后这条 claim 还在，但写不进去：只能记成未完成，不能当成别人的调用。
        let calls_db = rusqlite::Connection::open(home.join("state/plugin-calls/calls.sqlite")).unwrap();
        calls_db.execute("UPDATE plugin_calls SET expires_at_ms=0 WHERE call_id=?1", [&other]).unwrap();
        drop(calls_db);
        match settle_playtest_mailbox(&home, "creator-studio", "studio-1", &other_request, &result, 64 * 1024) {
            PlaytestMailboxAck::Uncommitted { call_id } => assert_eq!(call_id, other),
            other_ack => panic!("expected Uncommitted, got {other_ack:?}"),
        }
        assert_eq!(
            agent_vitals_runtime::query::plugin_calls::claimed_call_method(&home, "creator-studio", "studio-1", &other).unwrap().as_deref(),
            Some("creator.project.playtest.start"));
        let read_id = agent_vitals_runtime::query::plugin_calls::submit(
            &home, "creator-studio", "creator.project.read", &json!({"projectId":"project-1"}), 60_000).unwrap();
        agent_vitals_runtime::query::plugin_calls::claim_pending(
            &home, "creator-studio", "studio-1", &["creator.project.read".into()], 4).unwrap();
        assert!(matches!(
            settle_playtest_mailbox(&home, "creator-studio", "studio-1", &format!("plugin-call-{read_id}"), &result, 64 * 1024),
            PlaytestMailboxAck::NotOwned));
        assert_eq!(
            agent_vitals_runtime::query::plugin_calls::claimed_call_method(&home, "creator-studio", "studio-1", &read_id).unwrap().as_deref(),
            Some("creator.project.read"));
        note_unacked_playtest_open(&call_id, "playtest-deferred");
        assert_eq!(take_unacked_playtest_open(&call_id).as_deref(), Some("playtest-deferred"));
        assert!(take_unacked_playtest_open(&call_id).is_none());
        note_unacked_playtest_open(&call_id, "not a run id");
        assert!(take_unacked_playtest_open(&call_id).is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn creator_assets_are_only_available_from_the_active_city_webview() {
        let host = HostState { current: Some(Instance {
            id:"plugin-city-7".into(),plugin_id:"city".into(),command_namespace:"city".into(),
            max_toolbar_items:11,performance_metrics:Vec::new(),started:Instant::now(),pulse:Instant::now(),
            ready:true,suspended:false,page_hidden:false,hidden_since:None,failed:None,revision:0,items:Vec::new(),sequence:0,pending:None,
            in_flight:0,busy_until:None,events:Vec::new(),
        }), ..HostState::default() };
        assert!(city_asset_webview_authorized(&host, "plugin-city-7"));
        assert!(!city_asset_webview_authorized(&host, "plugin-city-6"));
        assert!(!city_asset_webview_authorized(&host, "plugin-creator-studio-7"));
        let mut suspended = host;
        suspended.current.as_mut().unwrap().suspended = true;
        assert!(!city_asset_webview_authorized(&suspended, "plugin-city-7"));
    }

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
            started:Instant::now(),pulse:Instant::now(),ready:true,suspended:false,page_hidden:false,hidden_since:None,failed:None,revision:0,
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

    #[test]
    fn city_creator_runtime_route_requires_declared_ready_active_city_instance() {
        let host = HostState { current: Some(Instance {
            id:"plugin-city-1".into(),plugin_id:"city".into(),command_namespace:"city".into(),
            max_toolbar_items:11,performance_metrics:Vec::new(),started:Instant::now(),pulse:Instant::now(),
            ready:true,suspended:false,page_hidden:false,hidden_since:None,failed:None,revision:0,items:Vec::new(),sequence:0,pending:None,
            in_flight:0,busy_until:None,events:Vec::new(),
        }), ..HostState::default() };
        let calls = vec!["city.creator.experiences.list".to_owned(), "city.creator.playtest.claim".to_owned()];
        assert!(city_creator_runtime_authorized(&host,"city","plugin-city-1",&calls,"city.creator.experiences.list"));
        assert!(city_creator_runtime_authorized(&host,"city","plugin-city-1",&calls,"city.creator.playtest.claim"));
        assert!(!city_creator_runtime_authorized(&host,"city","plugin-city-old",&calls,"city.creator.experiences.list"));
        assert!(!city_creator_runtime_authorized(&host,"creator-studio","plugin-city-1",&calls,"city.creator.experiences.list"));
        assert!(!city_creator_runtime_authorized(&host,"city","plugin-city-1",&calls,"city.creator.experiences.read"));
        let mut not_ready = host;
        not_ready.current.as_mut().unwrap().ready = false;
        assert!(!city_creator_runtime_authorized(&not_ready,"city","plugin-city-1",&calls,"city.creator.experiences.list"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn headless_home() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("headless-gate-test-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn headless_layout_snapshot(world_revision: &str) -> Value {
        json!({"schemaVersion": 1, "worldRevision": world_revision, "seed": 7, "layout": {
            "schemaVersion": 1, "id": "city-layout-v1-headless", "coordinateSystem": "city-local-m-v1", "anchors": [
                {"id": "road-spawn:a", "kind": "spawn", "capabilities": ["drive"], "geometryRef": "city-road-node:a"},
                {"id": "road-checkpoint:ab", "kind": "zone", "capabilities": ["drive"], "geometryRef": "city-road-edge:ab:midpoint"},
                {"id": "road-checkpoint:bc", "kind": "zone", "capabilities": ["drive"], "geometryRef": "city-road-edge:bc:midpoint"}
            ], "links": [
                {"id": "link-a", "fromAnchorId": "road-spawn:a", "toAnchorId": "road-checkpoint:ab", "capabilities": ["drive"]},
                {"id": "link-b", "fromAnchorId": "road-checkpoint:ab", "toAnchorId": "road-checkpoint:bc", "capabilities": ["drive"]}
            ]}})
    }

    fn dunes_profile() -> Value {
        json!({"schemaVersion": 1, "id": "arid-dunes", "version": 1, "biome": "arid",
            "geography": {"generator": "arid-dunes-v1", "parameters": {"dunes": {"duneScale": 190, "duneAmplitude": 11, "orientationDeg": 18}}},
            "visuals": {"themeId": "desert"}})
    }

    fn valid_vehicle(id: &str) -> Value {
        json!({"schemaVersion": 1, "id": id, "label": "E2E flapper", "modelAssetId": null, "flightModel": "flapping",
            "physics": {"massKg": 300.0, "wingAreaM2": 18.0, "thrustN": 6000.0, "maxSpeedMps": 120.0, "dragCoefficient": 0.1,
                "turnRateRps": 0.9, "climbRateMps": 34.0, "sinkRateMps": 26.0, "flapFrequencyHz": 2.4, "flapAmplitudeRad": 1.1},
            "bounds": {"halfLengthM": 3.6, "halfWidthM": 4.8, "halfHeightM": 1.4}})
    }

    #[test]
    fn headless_arm_creates_city_and_commits_world_edits_with_the_embedded_marker() {
        let home = headless_home();
        let created = answer_headless_call(&home, "creator.city.create",
            &json!({"name": "无头城", "seed": 20261115, "profile": dunes_profile(), "operationId": "op-city-1"})).unwrap();
        let city_id = created["cityId"].as_str().unwrap().to_owned();
        let revision = created["revision"].as_u64().unwrap();
        let preview = answer_headless_call(&home, "creator.city.edit.preview",
            &json!({"cityId": city_id, "baseRevision": revision,
                "operations": [{"op": "world.set", "params": {"shape.family": "lobed", "shape.cores": 3}}]})).unwrap();
        // 语义通过 → 正常签发 previewId，且响应显式记录 embedded-sdk 来源（不再 commitBlocked）。
        assert!(preview["previewId"].as_str().is_some(), "{preview}");
        assert_eq!(preview["validation"], crate::creator_projects::VALIDATION_SOURCE_EMBEDDED);
        let committed = answer_headless_call(&home, "creator.city.edit.commit",
            &json!({"cityId": city_id, "previewId": preview["previewId"], "expectedRevision": revision, "operationId": "op-city-edit-1"})).unwrap();
        assert_eq!(committed["revision"], revision + 1);
        assert_eq!(committed["validation"], crate::creator_projects::VALIDATION_SOURCE_EMBEDDED);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn headless_arm_rejects_semantic_failures_with_the_same_diagnostics_shape() {
        let home = headless_home();
        let created = answer_headless_call(&home, "creator.city.create",
            &json!({"name": "无头城", "seed": 20261115, "profile": dunes_profile(), "operationId": "op-city-1"})).unwrap();
        let city_id = created["cityId"].as_str().unwrap().to_owned();
        let revision = created["revision"].as_u64().unwrap();
        let rejected = answer_headless_call(&home, "creator.city.edit.preview",
            &json!({"cityId": city_id, "baseRevision": revision,
                "operations": [{"op": "world.set", "params": {"shape.cores": 9}}]}));
        // world.set 越界 → 宿主结构闸先行拒绝（world_params_out_of_range），不是静默放行。
        assert_eq!(rejected.unwrap_err(), "world_params_out_of_range");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn headless_arm_defines_and_previews_vehicles_with_embedded_validation() {
        let home = headless_home();
        crate::creator_city_patch::publish_city_layout_snapshot(&home, &headless_layout_snapshot("world-rev-headless")).unwrap();
        let project = crate::creator_projects::create_project_from_city_layout(&home,
            crate::creator_projects::LOCAL_CREATOR_OWNER, "flight-checkpoint", "op-project-headless", "world-rev-headless").unwrap();
        let project_id = project["projectId"].as_str().unwrap().to_owned();
        let vehicle = valid_vehicle("vehicle-headless-1");
        // define：嵌入式语义闸 + 一次性写入（headless define 成为可能）。
        let defined = answer_headless_call(&home, "creator.vehicle.define", &json!({
            "projectId": project_id, "baseRevision": 0, "vehicleId": "vehicle-headless-1",
            "label": vehicle["label"], "flightModel": vehicle["flightModel"],
            "physics": vehicle["physics"], "bounds": vehicle["bounds"], "modelAssetId": null,
            "operationId": "op-vehicle-headless-1"})).unwrap();
        assert_eq!(defined["validation"], crate::creator_projects::VALIDATION_SOURCE_EMBEDDED);
        assert_eq!(defined["revision"], 1);
        // preview：previewId 可签发、来源如实、性能预估与 Studio 同源注入。
        let preview = answer_headless_call(&home, "creator.vehicle.preview", &json!({
            "projectId": project_id, "baseRevision": 1, "vehicle": valid_vehicle("vehicle-headless-2")})).unwrap();
        assert!(preview["previewId"].as_str().is_some(), "{preview}");
        assert_eq!(preview["validation"], crate::creator_projects::VALIDATION_SOURCE_EMBEDDED);
        assert!(preview.get("estimatedPerformance").is_some_and(|value| value.is_object()), "{preview}");
        // preview 可以走 creator.project.commit 提交（headless commit 全链路）。
        let committed = answer_headless_call(&home, "creator.project.commit", &json!({
            "projectId": project_id, "previewId": preview["previewId"], "expectedRevision": 1,
            "operationId": "op-vehicle-commit-headless"})).unwrap();
        assert_eq!(committed["revision"], 2);
        assert_eq!(committed["validation"], crate::creator_projects::VALIDATION_SOURCE_EMBEDDED);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn embedded_vehicle_validation_keeps_semantic_rejections_as_diagnostics() {
        // 无效画像必须作为「语义判负 + 诊断」返回；若信封自检把诊断码/字段判成非法，
        // 调用方会收到 creator_validation_invalid（"信封格式错误"），把真实原因吞掉。
        let raw = json!({"schemaVersion": 1, "id": "vehicle-bad", "label": "", "modelAssetId": null,
            "flightModel": "flapping", "physics": {}, "bounds": {}});
        let (_, envelope) = crate::creator_projects::embedded_vehicle_validation("probe", 0, &raw)
            .expect("a semantic rejection must still produce an envelope");
        assert_eq!(envelope["ok"], false, "{envelope}");
        assert!(!envelope["diagnostics"].as_array().map(Vec::is_empty).unwrap_or(true), "{envelope}");
    }

    #[test]
    fn headless_arm_binds_a_typed_mount_and_publishes_without_a_viewport() {
        let home = headless_home();
        let layout = json!({"schemaVersion": 1, "id": "bind-layout", "coordinateSystem": "city-local-m-v1",
            "anchors": [
                {"id": "spawn-a", "kind": "spawn", "capabilities": ["drive"], "geometryRef": "g:spawn"},
                {"id": "cp-1", "kind": "zone", "capabilities": ["drive"], "geometryRef": "g:1"},
                {"id": "cp-2", "kind": "zone", "capabilities": ["drive"], "geometryRef": "g:2"},
                {"id": "cp-3", "kind": "zone", "capabilities": ["drive"], "geometryRef": "g:3"}
            ],
            "links": [
                {"id": "l1", "fromAnchorId": "spawn-a", "toAnchorId": "cp-1", "capabilities": ["drive"]},
                {"id": "l2", "fromAnchorId": "cp-1", "toAnchorId": "cp-2", "capabilities": ["drive"]},
                {"id": "l3", "fromAnchorId": "cp-2", "toAnchorId": "cp-3", "capabilities": ["drive"]}
            ]});
        crate::creator_city_patch::publish_city_layout_snapshot(&home,
            &json!({"schemaVersion": 1, "worldRevision": "world-rev-bind", "seed": 7, "layout": layout})).unwrap();
        let project = crate::creator_projects::create_project_from_city_layout(&home,
            crate::creator_projects::LOCAL_CREATOR_OWNER, "checkpoint-race", "op-bind-project", "world-rev-bind").unwrap();
        let project_id = project["projectId"].as_str().unwrap().to_owned();
        let bound = answer_headless_call(&home, "creator.mount.bind", &json!({
            "projectId": project_id, "baseRevision": 0, "mountId": "mount-bind-1", "entryAnchorId": "spawn-a",
            "bindings": {"points": ["cp-1", "cp-2", "cp-3"]}, "operationId": "op-bind-1"})).unwrap();
        assert_eq!(bound["revision"], 1, "{bound}");
        assert_eq!(bound["coverage"]["bound"], 3, "{bound}");
        let published = answer_headless_call(&home, "creator.project.publish",
            &json!({"projectId": project_id, "expectedRevision": 1})).unwrap();
        assert!(published["releaseId"].as_str().is_some(), "{published}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// V3 PR-7 前半：headless 臂的 Story 注册表 / City Code 安装 / Inspect 路由。
    /// 语义：Studio 不在场时本臂直接路由宿主 dispatch_as——写路径与 mailbox 臂
    /// 同一管线（CAS/幂等/预算），运行身份固定为 LOCAL_CREATOR_OWNER；名单外的
    /// 视口方法绝不被本臂冒充。
    #[test]
    fn headless_arm_routes_story_registry_code_install_and_inspect_methods() {
        let home = headless_home();
        // 名单：story.* 11 方法 + creator.code.install.* 3 方法 + inspect 4 方法。
        let methods = headless_creator_methods();
        for name in [
            "creator.story.project.create", "creator.story.project.read", "creator.story.projects.list",
            "creator.story.install.preview", "creator.story.install.commit", "creator.story.install.list",
            "creator.story.run.start", "creator.story.run.stop", "creator.story.run.reset",
            "creator.story.resident.lease.acquire", "creator.story.resident.lease.release",
            "creator.code.install.preview", "creator.code.install.commit", "creator.code.install.list",
            "creator.game.rules.inspect", "creator.story.graph.inspect",
            "creator.story.timeline.inspect", "creator.game.intent.simulate",
            "creator.actor.register", "creator.actor.turn.context", "creator.actor.intent.submit",
        ] {
            assert!(methods.iter().any(|method| method == name), "headless arm must claim {name}");
        }
        // 名单外方法（视口依赖）绝不被 headless 臂认领。
        assert!(!methods.iter().any(|method| method == "creator.city.layout.save"));
        // Story 注册表全链路：create → read → install preview/commit → run start。
        let created = answer_headless_call(&home, "creator.story.project.create", &json!({
            "storyId": "story.headless", "title": "无头侦探", "schemaVersion": 1, "storyVersion": "1.0.0",
            "graph": {"nodes": [{"id": "start", "kind": "beat"}, {"id": "clue", "kind": "beat"}],
                "edges": [{"from": "start", "to": "clue"}]},
            "canon": {"characters": []}})).unwrap();
        assert_eq!(created["created"], true, "{created}");
        let read = answer_headless_call(&home, "creator.story.project.read", &json!({"storyId": "story.headless"})).unwrap();
        assert_eq!(read["title"], "无头侦探");
        let city = answer_headless_call(&home, "creator.city.create",
            &json!({"name": "无头城", "seed": 20261115, "profile": dunes_profile(), "operationId": "op-story-city"})).unwrap();
        let city_id = city["cityId"].as_str().unwrap().to_owned();
        let checked = answer_headless_call(&home, "creator.story.install.preview", &json!({
            "storyId": "story.headless", "targetCityId": city_id,
            "expectedCityRevision": city["revision"], "operationId": "op-story-install-preview"})).unwrap();
        assert_eq!(checked["canInstall"], true, "{checked}");
        let committed = answer_headless_call(&home, "creator.story.install.commit", &json!({
            "previewId": checked["previewId"], "operationId": "op-story-install-commit"})).unwrap();
        assert_eq!(committed["status"], "installed", "{committed}");
        let run = answer_headless_call(&home, "creator.story.run.start", &json!({
            "cityId": city_id, "storyId": "story.headless"})).unwrap();
        // Actor 适配器全链路（headless）：register → turn.context → intent.submit。
        // canon 无角色 → 注册拒绝（Canon 先行）；补 canon 后注册成功并出 sessionPrompt。
        let ghost = answer_headless_call(&home, "creator.actor.register", &json!({
            "storyId": "story.headless", "characterId": "resident:ghost", "sessionIdentifier": "codex-ghost",
            "allowedKinds": ["speak"], "maxIntentsPerWindow": 2, "operationId": "op-actor-ghost"}))
            .unwrap_err();
        assert_eq!(ghost, "story_canon_character_missing");
        // canon 更新走 CAS（expectedStoryRevision）；为 actor 注册补齐角色 Canon。
        let canon_write = answer_headless_call(&home, "creator.story.project.create", &json!({
            "storyId": "story.headless", "title": "无头侦探", "schemaVersion": 1, "storyVersion": "1.0.0",
            "expectedStoryRevision": created["revision"],
            "graph": {"nodes": [{"id": "start", "kind": "beat"}, {"id": "clue", "kind": "beat"}],
                "edges": [{"from": "start", "to": "clue"}]},
            "canon": {"characters": [{"id": "resident:linxia", "name": "小夏"}]}})).unwrap();
        let _ = canon_write;
        let registered = answer_headless_call(&home, "creator.actor.register", &json!({
            "storyId": "story.headless", "characterId": "resident:linxia", "sessionIdentifier": "codex-actor-1",
            "allowedKinds": ["speak", "move"], "maxIntentsPerWindow": 3, "operationId": "op-actor-reg"})).unwrap();
        let actor_id = registered["actorId"].as_str().unwrap().to_owned();
        assert!(actor_id.starts_with("actor-"), "{registered}");
        let context = answer_headless_call(&home, "creator.actor.turn.context", &json!({"actorId": actor_id})).unwrap();
        assert_eq!(context["budget"]["max"], 3, "{context}");
        assert!(context["sessionPrompt"].as_str().unwrap().contains("resident:linxia"));
        let submitted = answer_headless_call(&home, "creator.actor.intent.submit", &json!({
            "actorId": actor_id, "intent": {"intentId": "intent-1", "actorId": actor_id,
            "scope": {"kind": "story", "playerId": "local-profile-v1", "cityId": city_id,
            "storyId": "story.headless", "storyRunId": run["storyRunId"]}, "kind": "speak",
            "args": {"text": "你好"}, "expectedRevision": "0"}})).unwrap();
        assert_eq!(submitted["accepted"], true, "{submitted}");
        // 运行身份固定为稳定本地 principal（与 mailbox 臂同款），不接受调用方自报。
        assert_eq!(run["playerId"], crate::creator_projects::LOCAL_CREATOR_OWNER, "{run}");
        assert_eq!(run["restored"], false);
        // Inspect 只读面在 headless 臂可用：graph/timeline 直读注册表与运行时。
        let graph = answer_headless_call(&home, "creator.story.graph.inspect", &json!({"storyId": "story.headless"})).unwrap();
        // 可达/死节点集合按 BTreeSet 字典序输出（确定性），与插入顺序无关。
        assert_eq!(graph["analysis"]["reachable"]["ids"], json!(["clue", "start"]), "{graph}");
        assert_eq!(graph["analysis"]["deadEnds"]["ids"], json!(["clue"]));
        let timeline = answer_headless_call(&home, "creator.story.timeline.inspect",
            &json!({"cityId": city_id, "storyId": "story.headless"})).unwrap();
        assert_eq!(timeline["available"], true, "{timeline}");
        // actor intent 提交的 speak 事件已入时间线（宿主复算/审计的数据面）。
        assert_eq!(timeline["count"], 1, "{timeline}");
        let simulate = answer_headless_call(&home, "creator.game.intent.simulate",
            &json!({"runId": "game-run-missing", "intent": {"kind": "speak", "text": "hi"}})).unwrap();
        assert_eq!(simulate["allowed"], false, "{simulate}");
        assert_eq!(simulate["steps"][0]["code"], "game_run_not_found");
        // 负：未注册项目 → 宿主管线的 not_found（不是 creator_method_unavailable）。
        assert_eq!(answer_headless_call(&home, "creator.game.rules.inspect",
            &json!({"projectId": "project-missing"})).unwrap_err(), "creator_project_not_found");
        // City Code 安装 3 方法：list 直连宿主；形态合法但磁盘不存在的 buildId
        // 带宿主完整性码（密封产物校验链先于安装预检）。
        let listed = answer_headless_call(&home, "creator.code.install.list", &json!({})).unwrap();
        assert_eq!(listed["installations"], json!([]), "{listed}");
        assert_eq!(answer_headless_call(&home, "creator.code.install.preview",
            &json!({"buildId": "0".repeat(64), "targetCityId": city_id, "expectedCityRevision": city["revision"],
                "operationId": "op-code-install"})).unwrap_err(), "game_package_integrity_failed");
        // Run 生命周期收尾：显式 stop 幂等，headless 臂同样可用。
        let stopped = answer_headless_call(&home, "creator.story.run.stop", &json!({"storyRunId": run["storyRunId"]})).unwrap();
        assert_eq!(stopped["status"], "stopped", "{stopped}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn headless_arm_rejects_sdk_semantic_failures_after_the_structural_gate() {        let home = headless_home();
        crate::creator_city_patch::publish_city_layout_snapshot(&home, &headless_layout_snapshot("world-rev-headless-b")).unwrap();
        let project = crate::creator_projects::create_project_from_city_layout(&home,
            crate::creator_projects::LOCAL_CREATOR_OWNER, "flight-checkpoint", "op-project-headless-b", "world-rev-headless-b").unwrap();
        let project_id = project["projectId"].as_str().unwrap().to_owned();
        // 结构硬闸不校验 label 词表——坏 label 必须由嵌入式语义闸（SDK 诊断）拒绝：
        // 结构通过、语义判负 → 信封 ok=false → define 以 creator_preview_invalid 拒绝。
        let mut bad_label = valid_vehicle("vehicle-bad");
        bad_label["label"] = json!("<script>alert(1)</script>");
        let error = answer_headless_call(&home, "creator.vehicle.define", &json!({
            "projectId": project_id, "baseRevision": 0, "vehicleId": "vehicle-bad",
            "label": bad_label["label"], "flightModel": bad_label["flightModel"],
            "physics": bad_label["physics"], "bounds": bad_label["bounds"], "modelAssetId": null,
            "operationId": "op-vehicle-bad"})).unwrap_err();
        assert_eq!(error, "creator_preview_invalid");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn creator_studio_has_the_same_scoped_city_data_grants() {
        let studio = definitions().iter().find(|plugin| plugin.id == "creator-studio").expect("Creator Studio plugin");
        assert_eq!(studio.entry, "plugins/CreatorStudio.plugin/ui/index.html");
        // 视口复用 City 的同一批有界数据集授权（官方内置插件、描述符声明、宿主逐请求校验），
        // 只允许共享的 harnesses 列表，不能恢复已退役的 City 业务投影。
        let city = definitions().iter().find(|plugin| plugin.id == "city").expect("city plugin");
        assert_eq!(studio.data_projections, vec!["harnesses:v1"]);
        assert_eq!(studio.data_projections, city.data_projections);
        assert_eq!(studio.typed_data_grants.keys().collect::<Vec<_>>(), city.typed_data_grants.keys().collect::<Vec<_>>());
        for (dataset, grant) in &studio.typed_data_grants {
            assert!(grant.is_valid(dataset), "Studio typed-data grant must be valid for {dataset}");
        }
        assert_eq!(studio.legacy_data_grants.keys().collect::<Vec<_>>(), city.legacy_data_grants.keys().collect::<Vec<_>>());
        for (dataset, grant) in &studio.legacy_data_grants {
            assert!(grant.is_valid(dataset), "Studio legacy grant must be valid for {dataset}");
        }
        assert_eq!(studio.object_grants, city.object_grants);
        assert_eq!(studio.scope_grants, city.scope_grants);
        assert!(studio.local_calls.iter().any(|method| method == "creator.layout.list"));
        assert!(studio.local_calls.iter().any(|method| method == "creator.project.create"));
        assert!(studio.local_calls.iter().any(|method| method == "creator.project.publish"));
        assert!(studio.local_calls.iter().any(|method| method == "creator.project.playtest.start"));
        assert!(studio.local_calls.iter().any(|method| method == "creator.project.playtest.result"));
        assert!(studio.local_calls.iter().any(|method| method == "creator.project.playtest.cancel"));
        assert!(studio.local_calls.iter().any(|method| method == "creator.project.playtest.return_context"));
        assert!(studio.local_calls.iter().any(|method| method == "creator.project.publication"));
    }

    #[test]
    fn city_registry_declares_sequential_remote_capability() {
        let city = definitions().iter().find(|plugin| plugin.id == "city").expect("city plugin");
        for method in ["city.creator.layout.publish", "city.creator.patch.publish", "city.creator.patch.read", "city.creator.experiences.list", "city.creator.experiences.read", "city.creator.playtest.claim", "city.creator.playtest.finish", "city.world.profile.preview", "city.world.profile.apply"] {
            assert!(city.local_calls.iter().any(|declared| declared == method), "City must declare {method}");
        }
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
            page_hidden: false, hidden_since: None, failed: None, revision: 0, items: Vec::new(), sequence: 0, pending: None, in_flight: 0, busy_until: None, events: Vec::new() }
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
    fn hidden_plugin_does_not_trip_watchdog_and_visible_heartbeat_resumes_checks() {
        let mut i = instance();
        i.ready = true;
        i.page_hidden = true;
        i.hidden_since = Some(Instant::now());
        i.pulse = Instant::now() - Duration::from_secs(60);
        assert!(!refresh_fault(&mut i), "background timer throttling must not mark the plugin failed");
        assert!(i.failed.is_none());

        let message = json!({"version":1,"instanceId":"plugin-city-2","type":"heartbeat","diagnostic":{"hidden":false}});
        assert!(apply_message(&mut i, "plugin-city-2", message).is_ok());
        assert!(!i.page_hidden);
        i.pulse = Instant::now() - Duration::from_secs(6);
        assert!(refresh_fault(&mut i), "a visible plugin with a stale pulse must still fail");
    }
    #[test]
    fn stale_hidden_declaration_stops_suppressing_the_watchdog() {
        let mut i = instance();
        i.ready = true;
        i.page_hidden = true;
        i.hidden_since = Some(Instant::now() - Duration::from_secs(60));
        i.pulse = Instant::now() - Duration::from_secs(10);
        assert!(refresh_fault(&mut i), "a hidden flag that stopped being refreshed must not blind the watchdog forever");
        assert_eq!(i.failed, Some("plugin_unresponsive"));
    }
    #[test]
    fn runtime_error_keeps_controlled_identifier_only() {
        let mut i = instance();
        let message = json!({"version":1,"instanceId":"plugin-city-2","type":"runtime.error","error":{
            "name":"TypeError","message":"cannot read C:\\Users\\me\\secret","stack":"at CityApp (app://city/src/CityApp.tsx:42:7)"
        }});
        assert!(apply_message(&mut i, "plugin-city-2", message).is_ok());
        assert_eq!(i.failed, Some("plugin_runtime_error"));
        // 只有保守字符集限定的错误标识符入库；message/stack 原文永不持久化。
        assert_eq!(i.events.last().unwrap()["error"], json!({"name":"TypeError"}));
        let hostile = json!({"version":1,"instanceId":"plugin-city-2","type":"runtime.error","error":{
            "name":"bad name with 中文 and {braces}"
        }});
        assert!(apply_message(&mut i, "plugin-city-2", hostile).is_ok());
        assert_eq!(i.events.last().unwrap()["error"], json!({}));
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
        too_many["dimensions"] = json!({"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10,"k":11,"l":12,"m":13});
        assert_eq!(performance_fields(&metrics, &too_many), Err("plugin_performance_invalid"));
    }

    #[test]
    fn performance_dimensions_reject_camel_case_keys() {
        // 2026-11-15 之前 scene 用 `windowDays` 驼峰键，被这里静默拒绝，
        // 前端又吞掉错误，于是 app.log 里从来没有真实 scene 记录。
        let message = json!({
            "version":1,"instanceId":"plugin-city-2","type":"plugin.performance",
            "metric":"scene","outcome":"success","elapsedMs":1115,
            "dimensions":{"stage":"model","windowDays":366}
        });
        assert_eq!(performance_fields(&["scene".to_owned()], &message), Err("plugin_performance_invalid"));

        let mut lowercase = message;
        lowercase["dimensions"] = json!({"stage":"model","window_days":366});
        assert!(performance_fields(&["scene".to_owned()], &lowercase).is_ok());
    }

    #[test]
    fn frame_metric_accepts_twelve_bounded_dimensions() {
        let mut message = json!({
            "version":1,"instanceId":"plugin-city-2","type":"plugin.performance",
            "metric":"frame","outcome":"success","elapsedMs":21,
            "dimensions":{
                "fps":60,"p50":16,"p95":21,"max":120,"draw_calls":40,"triangles":900000,
                "quality":2,"idle":false,"dpr":150,"geometries":120,"textures":40,"load_id":"L1abc"
            }
        });
        let metrics = vec!["frame".to_owned()];
        let fields = performance_fields(&metrics, &message).unwrap();
        assert!(fields.contains("metric=frame"));
        assert!(fields.contains("p95"));
        assert!(fields.contains("load_id"));

        message["dimensions"]["extra"] = json!(1);
        assert_eq!(performance_fields(&metrics, &message), Err("plugin_performance_invalid"));
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
