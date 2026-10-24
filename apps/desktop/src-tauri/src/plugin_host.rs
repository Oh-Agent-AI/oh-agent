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
    #[serde(default)] data_projections: Vec<String>, #[serde(default)] allow_local_exports: bool,
    #[serde(default)] navigation_targets: Vec<String>,
    /// 允许的 plugin.state.* 键（如 flight-profile:v1）；描述表声明即边界（游戏模式 §9）。
    #[serde(default)] state_keys: Vec<String>,
    /// 活动插件要接收的宿主推送（building / squad）。未声明则不投递，不按插件 id 判断。
    #[serde(default)] host_events: Vec<String> }

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
            assert!(plugin.entry.starts_with("plugins/") && plugin.entry.ends_with("/ui/index.html") && !plugin.entry.contains(".."));
        }
        registry
    }).plugins
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

fn valid_tools(namespace: &str, items: &[Tool]) -> bool {
    let mut ids = std::collections::BTreeSet::new();
    // 10 = 8 常规工具 + 游戏模式宿主级退出按钮 + 修复规划入口（均已默认开放；其余插件仍 ≤8）。
    items.len() <= 10 && items.iter().all(|item| {
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

/// PluginHost → City: shared entity channel. Same CustomEvent hook as
/// plugin_command / plugin_invalidate. Keep the name in lockstep with
/// `agent_vitals_runtime::query::city_building::ENTITY_CHANGED_EVENT`.
pub(crate) fn entity_event_script(payload: &serde_json::Value) -> String {
    let channel = agent_vitals_runtime::query::city_building::ENTITY_CHANGED_EVENT;
    format!("window.dispatchEvent(new CustomEvent('{channel}', {{detail: {payload}}}));")
}

/// PluginHost → City: squad IM envelope (v:1). Same host.sock, different event.
pub(crate) fn squad_event_script(payload: &serde_json::Value) -> String {
    let channel = agent_vitals_runtime::query::city_im::SQUAD_EVENT;
    format!("window.dispatchEvent(new CustomEvent('{channel}', {{detail: {payload}}}));")
}

static ENTITY_DELIVERED: OnceLock<Mutex<String>> = OnceLock::new();
static SQUAD_DELIVERED: OnceLock<Mutex<String>> = OnceLock::new();
static ENTITY_BRIDGE: OnceLock<()> = OnceLock::new();

fn subscriber_view_id(app: &tauri::AppHandle, event: &str) -> Option<String> {
    let host = app.state::<PluginHost>();
    let guard = host.0.lock().unwrap();
    let instance = guard.current.as_ref()?;
    if !instance.ready || instance.failed.is_some() || instance.suspended { return None; }
    let subscribed = definitions().iter().find(|plugin| plugin.id == instance.plugin_id)
        .is_some_and(|plugin| plugin.host_events.iter().any(|name| name == event));
    if subscribed { Some(instance.id.clone()) } else { None }
}

fn deliver_entity_event(app: &tauri::AppHandle, payload: &serde_json::Value) -> bool {
    use agent_vitals_runtime::query::city_building::{entity_event_id, is_entity_changed};
    if !is_entity_changed(payload) { return false; }
    let Some(event_id) = entity_event_id(payload) else { return false; };
    {
        let delivered = ENTITY_DELIVERED.get_or_init(|| Mutex::new(String::new())).lock().unwrap();
        if delivered.as_str() == event_id { return true; }
    }
    let Some(id) = subscriber_view_id(app, "building") else { return false; };
    let Some(view) = app.get_webview(&id) else { return false; };
    if view.eval(entity_event_script(payload)).is_err() { return false; }
    *ENTITY_DELIVERED.get_or_init(|| Mutex::new(String::new())).lock().unwrap() = event_id.to_string();
    let kind = payload.get("entity_kind").and_then(Value::as_str).unwrap_or("entity");
    agent_vitals_runtime::logging::log_info("plugin_host", &format!("{kind} event {event_id}"));
    true
}

fn deliver_squad_event(app: &tauri::AppHandle, payload: &serde_json::Value) -> bool {
    use agent_vitals_runtime::query::city_im::{envelope_id, is_squad_envelope};
    if !is_squad_envelope(payload) { return false; }
    let Some(event_id) = envelope_id(payload) else { return false; };
    {
        let delivered = SQUAD_DELIVERED.get_or_init(|| Mutex::new(String::new())).lock().unwrap();
        if delivered.as_str() == event_id { return true; }
    }
    let Some(id) = subscriber_view_id(app, "squad") else { return false; };
    let Some(view) = app.get_webview(&id) else { return false; };
    if view.eval(squad_event_script(payload)).is_err() { return false; }
    *SQUAD_DELIVERED.get_or_init(|| Mutex::new(String::new())).lock().unwrap() = event_id.to_string();
    let kind = payload.get("kind").and_then(Value::as_str).unwrap_or("im");
    agent_vitals_runtime::logging::log_info("plugin_host", &format!("squad {kind} {event_id}"));
    true
}

fn deliver_host_payload(app: &tauri::AppHandle, payload: &serde_json::Value) -> bool {
    if deliver_entity_event(app, payload) { return true; }
    deliver_squad_event(app, payload)
}

fn poll_building_mailbox(app: &tauri::AppHandle) {
    let home = crate::overview::data_home();
    if let Some(payload) = agent_vitals_runtime::query::city_building::read_mailbox(&home) {
        let _ = deliver_entity_event(app, &payload);
    }
    // Preview / reject live on edit.json so persist notify.json is never overwritten.
    if let Some(payload) = agent_vitals_runtime::query::city_building::read_edit_mailbox(&home) {
        let _ = deliver_entity_event(app, &payload);
    }
    // Squad IM is a third mailbox: never overwrite persist or edit.
    if let Some(payload) = agent_vitals_runtime::query::city_im::read_squad_mailbox(&home) {
        let _ = deliver_squad_event(app, &payload);
    }
}

fn start_building_bridge(app: &tauri::AppHandle) {
    if ENTITY_BRIDGE.set(()).is_err() { return; }
    #[cfg(unix)]
    {
        use std::io::{BufRead, BufReader};
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixListener;
        let app = app.clone();
        std::thread::spawn(move || {
            let home = crate::overview::data_home();
            let dir = agent_vitals_runtime::query::city_building::store_dir(&home);
            let _ = std::fs::create_dir_all(&dir);
            let sock = agent_vitals_runtime::query::city_building::socket_path(&home);
            let _ = std::fs::remove_file(&sock);
            match UnixListener::bind(&sock) {
                Ok(listener) => {
                    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
                    agent_vitals_runtime::logging::log_info("plugin_host", "city building host.sock listening");
                    for stream in listener.incoming() {
                        let Ok(stream) = stream else { continue; };
                        let mut line = String::new();
                        if BufReader::new(stream).read_line(&mut line).is_err() { continue; }
                        let Ok(payload) = serde_json::from_str::<Value>(line.trim()) else { continue; };
                        let _ = deliver_host_payload(&app, &payload);
                    }
                }
                Err(error) => {
                    agent_vitals_runtime::logging::log_warn("plugin_host", &format!("city building socket: {error}"));
                }
            }
        });
    }
    #[cfg(not(unix))]
    { let _ = app; }
}

fn start_watchdog(app: &tauri::AppHandle, state: &PluginHost) {
    let mut host = state.0.lock().unwrap();
    if host.watchdog_started { return; }
    host.watchdog_started = true;
    start_building_bridge(app);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let changed = {
            let state = app.state::<PluginHost>();
            let mut host = state.0.lock().unwrap();
            host.current.as_mut().is_some_and(refresh_fault)
        };
        if changed { notify_host(&app); }
        poll_building_mailbox(&app);
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
    if let Some(old) = old { if let Some(view) = app.get_webview(&old.id) {
        agent_vitals_runtime::logging::log_warn("plugin_host", &format!("view.close() [replace] id={}", old.id));
        let _ = view.close();
    } }
    let id = {
        let mut host = state.0.lock().unwrap();
        host.generation += 1;
        let id = format!("plugin-{}-{}", definition.id, host.generation);
        let mut current = Instance { id: id.clone(), plugin_id: definition.id.clone(), command_namespace: definition.command_namespace.clone(), started: Instant::now(), pulse: Instant::now(), ready: false, suspended: false,
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
    let builder = builder.initialization_script(crate::plugin_isolation_probe::OBSERVER);
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
    if let Some(old) = old { if let Some(view) = app.get_webview(&old.id) {
        agent_vitals_runtime::logging::log_warn("plugin_host", &format!("view.close() [plugin_close] id={}", old.id));
        view.close().map_err(|_| "plugin_close_failed")?;
    } }
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
    let changed = message["type"] != "heartbeat";
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
            if !valid_tools(&i.command_namespace, &items) { return Err("plugin_toolbar_invalid".into()); }
            i.items = items; i.revision = revision; i.ready = true; i.pulse = Instant::now();
            note(i, "toolbar_updated");
        }
        Some("command.result") => {
            if !i.pending.as_ref().is_some_and(|(id, _)| message["requestId"] == *id) { return Err("plugin_request_stale".into()); }
            if message["ok"] != true { i.failed = Some("plugin_command_rejected"); }
            note(i, if message["ok"] == true { "command_succeeded" } else { "command_rejected" });
            i.pending = None;
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

#[tauri::command]
pub async fn plugin_request(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, PluginHost>, request: PluginRequestV1) -> Result<PluginResponseV1, String> {
    let (allowed, navigation, state_keys, plugin_id) = {
        let host = state.0.lock().unwrap();
        let i = host.current.as_ref().ok_or("plugin_instance_unavailable")?;
        if i.id != webview.label() || i.failed.is_some() || i.suspended || request.instance_id != i.id {
            return Err("plugin_instance_mismatch".into());
        }
        if let Err(code) = validate_plugin_request(&request) {
            return Ok(plugin_request_error(request.request_id, code, false));
        }
        let definition = definitions().iter().find(|p| p.id == i.plugin_id).ok_or("plugin_unknown")?;
        (definition.data_projections.clone(), definition.navigation_targets.clone(), definition.state_keys.clone(), i.plugin_id.clone())
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::plugin_projections::read_for_plugin(&allowed, &method, &payload, &plugin_id)
    }).await.map_err(|_| "plugin_query_failed".to_string())?;
    let host = state.0.lock().unwrap();
    if !host.current.as_ref().is_some_and(|i| i.id == request.instance_id && i.failed.is_none() && !i.suspended) {
        return Err("plugin_instance_mismatch".into());
    }
    Ok(match result {
        Ok(value) => PluginResponseV1 { version: 1, request_id: request.request_id, ok: true, result: Some(value), error: None },
        Err(code) => plugin_request_error(request.request_id, code, matches!(code, "data_unavailable" | "revision_changed")),
    })
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
}

#[cfg(test)]
mod tests {
    use super::*;
    fn instance() -> Instance {
        Instance { id: "plugin-city-2".into(), plugin_id: "city".into(), command_namespace: "city".into(), started: Instant::now(), pulse: Instant::now(), ready: false, suspended: false,
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
        assert!(valid_tools("city", &tools));
        tools.push(tools[0].clone()); assert!(!valid_tools("city", &tools));
        tools.pop(); tools[0].value = Some("14".into()); assert!(!valid_tools("city", &tools));
    }
    #[test]
    fn namespace_validation_is_not_specific_to_the_first_plugin() {
        let tools: Vec<Tool> = serde_json::from_value(json!([{"id":"refresh","commandId":"metrics.refresh","label":"Refresh","kind":"button","enabled":true}])).unwrap();
        assert!(valid_tools("metrics", &tools));
        assert!(!valid_tools("city", &tools));
        let registry = definitions();
        assert!(!registry.is_empty());
        let city = registry.iter().find(|plugin| plugin.id == "city").unwrap();
        assert!(city.host_events.iter().any(|event| event == "building"));
        assert!(city.host_events.iter().any(|event| event == "squad"));
    }

    #[test]
    fn entity_event_script_is_the_shared_city_custom_event_hook() {
        let payload = json!({
            "type":"CityEntityChanged","schema_version":1,
            "entity_kind":"building","entity_id":"ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "action":"set","revision":3,"event_id":"be_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "asset_ref":"ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","build_event_id":"be_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","kind":"set"
        });
        let script = entity_event_script(&payload);
        assert!(script.contains("__AV_PLUGIN_ENTITY_CHANGED__"));
        assert!(!script.contains("__AV_PLUGIN_BUILDING_CHANGED__"));
        assert!(script.contains("\"entity_kind\":\"building\""));
        assert!(script.contains("ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(script.contains("be_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
        assert!(script.contains("\"revision\":3"));
        let road = json!({"type":"CityEntityChanged","entity_kind":"road","entity_id":"rd_1","action":"set","revision":1,"event_id":"ev_1"});
        assert!(entity_event_script(&road).contains("__AV_PLUGIN_ENTITY_CHANGED__"));
        let preview = json!({"type":"CityEntityChanged","entity_kind":"building","entity_id":"ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"preview","revision":0,"event_id":"ui_preview_1"});
        assert!(entity_event_script(&preview).contains("\"action\":\"preview\""));
        let reject = json!({"type":"CityEntityChanged","entity_kind":"building","entity_id":"ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"reject","revision":1,"event_id":"ui_reject_1"});
        assert!(entity_event_script(&reject).contains("\"action\":\"reject\""));
        let squad = json!({
            "v":1,"id":"evt_1","ts":1761180000,
            "session_id":"sr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "agent_id":"nano","agent_name":"Nano","kind":"claim",
            "payload":{"asset_ref":"ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ttl_sec":90,"expires_at":1761180090}
        });
        let script = squad_event_script(&squad);
        assert!(script.contains("__AV_PLUGIN_SQUAD_EVENT__"));
        assert!(!script.contains("__AV_PLUGIN_ENTITY_CHANGED__"));
        assert!(script.contains("\"kind\":\"claim\""));
        assert_eq!(agent_vitals_runtime::query::city_im::SQUAD_EVENT, "__AV_PLUGIN_SQUAD_EVENT__");
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
