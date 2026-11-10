//! Explicit, feature-gated local probe. Never starts runtime watchers or opens authority data.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, Webview, WebviewBuilder, WebviewUrl, WebviewWindowBuilder};

const HOST: &str = "workbench";
const CITY: &str = "isolation-city-1";
const RESTART: &str = "isolation-city-2";

#[derive(Clone)]
struct ProbeState(Arc<Mutex<ProbeData>>);

struct ProbeData {
    started: Instant,
    host_pulse: Option<Instant>,
    city_pulses: BTreeMap<String, Instant>,
    ready: BTreeSet<String>,
    codes: BTreeSet<String>,
    request_count: u64,
    events: Vec<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Frame {
    asset: String,
    line: u32,
    column: u32,
}

fn record(state: &ProbeState, view: &str, code: &str, frames: Vec<Frame>) {
    let mut data = state.0.lock().unwrap();
    data.codes.insert(code.to_owned());
    let at_ms = data.started.elapsed().as_millis() as u64;
    if data.events.len() == 200 { data.events.remove(0); }
    data.events.push(json!({ "at_ms": at_ms, "instance_id": view, "code": code, "frames": frames }));
}

#[tauri::command]
fn isolation_probe_event(webview: Webview, state: tauri::State<'_, ProbeState>, code: String, frames: Option<Vec<Frame>>) -> Result<(), String> {
    let label = webview.label();
    if ![HOST, CITY, RESTART].contains(&label) && !label.starts_with("plugin-city-") { return Err("probe_sender_unavailable".into()); }
    if code == "heartbeat" {
        let mut data = state.0.lock().unwrap();
        if label == HOST { data.host_pulse = Some(Instant::now()); }
        else { data.city_pulses.insert(label.to_owned(), Instant::now()); }
        return Ok(());
    }
    if !["ui_ready", "runtime_error", "unhandled_rejection", "host_navigation_alive", "host_exit_navigation_alive", "window_seven_ready", "cinema_started", "cinema_stopped", "stale_rejected", "formal_unresponsive", "formal_reload", "formal_disposed", "formal_settings_clicked", "formal_window_changed", "formal_settings_closed", "formal_reset_clicked", "mecha_fixture_ready", "mecha_board_ready", "mecha_render_stalled", "mecha_hold_risk", "mecha_hold_cancelled", "mecha_hold_confirmed", "mecha_turn_resolved", "mecha_seed_initial_74031", "mecha_seed_input", "mecha_seed_apply_clicked", "mecha_seed_stored", "mecha_seed_applied", "mecha_exited", "mecha_all_hold", "v15_board_ready", "v15_deployed", "v15_moved", "v15_undo", "v15_recovered"].contains(&code.as_str()) {
        return Err("probe_code_unavailable".into());
    }
    if code == "ui_ready" { state.0.lock().unwrap().ready.insert(label.to_owned()); }
    let frames = frames.unwrap_or_default().into_iter().take(5).filter(|frame| {
        frame.asset.len() <= 100 && frame.asset.ends_with(".js")
            && frame.asset.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
            && frame.line > 0 && frame.column > 0
    }).collect();
    record(&state, label, &code, frames);
    Ok(())
}

#[tauri::command]
async fn plugin_request(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, ProbeState>, plugin_host: tauri::State<'_, crate::plugin_host::PluginHost>, request: crate::plugin_host::PluginRequestV1) -> Result<crate::plugin_host::PluginResponseV1, String> {
    let sender = webview.label().to_owned();
    let formal_v15 = std::env::args().any(|arg| arg == "--plugin-formal-v15-probe" || arg == "--plugin-formal-v15-resume" || arg == "--plugin-formal-v15-status-probe" || arg == "--plugin-formal-v15-status-resume") && sender.starts_with("plugin-city-")
        && matches!(request.method.as_str(), "plugin.state.read" | "plugin.state.write")
        && matches!(request.payload["key"].as_str(), Some("mecha-replays:v1" | "mecha-checkpoint:v1"));
    if ![CITY, RESTART].contains(&sender.as_str()) && !formal_v15 { return Err("probe_sender_unavailable".into()); }
    let request_id = {
        let mut data = state.0.lock().unwrap();
        data.request_count += 1;
        format!("request-{}", data.request_count)
    };
    record(&state, &sender, &format!("{request_id}:request_started"), Vec::new());
    let result = crate::plugin_host::plugin_request(app, webview, plugin_host, request).await;
    let code = if result.is_ok() { "request_succeeded" } else { "request_rejected" };
    record(&state, &sender, &format!("{request_id}:{code}"), Vec::new());
    result
}

pub(crate) const OBSERVER: &str = r#"
(() => {
  window.__CITY_ISOLATION_FIXTURE__ = true;
  const send = (code, frames = []) => {
    const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
    if (invoke) void invoke('isolation_probe_event', {code, frames}).catch(() => {});
  };
  const frames = (error) => [...String(error?.stack ?? '').matchAll(/assets\/([A-Za-z0-9_.-]+\.js):(\d+):(\d+)/g)]
    .slice(0, 5).map(match => ({asset: match[1], line: Number(match[2]), column: Number(match[3])}));
  addEventListener('error', event => send('runtime_error', frames(event.error)));
  addEventListener('unhandledrejection', event => send('unhandled_rejection', frames(event.reason)));
  let ready = false;
  let seven = false;
  let cinema = false;
  const faults = new Set();
  setInterval(() => {
    send('heartbeat');
    const host = document.querySelector('.sidebar .nav-item');
    const cityApp = document.querySelector('.city-app');
    const city = document.querySelector('.city-summary-trigger');
    const summary = city?.textContent?.trim() ?? '';
    if (!ready && (host || cityApp || ((summary.startsWith('3 会话') || summary.startsWith('3 sessions')) && window.__CITY_ISOLATION_FAULTS__))) {
      ready = true; send('ui_ready');
    }
    if (!seven && (summary.startsWith('2 会话') || summary.startsWith('2 sessions'))) { seven = true; send('window_seven_ready'); }
    const playing = [...document.querySelectorAll('.plugin-toolbar button')].some(b=>b.textContent==='停止航拍');
    if (playing && !cinema) { cinema = true; send('cinema_started'); }
    if (!playing && cinema) { cinema = false; send('cinema_stopped'); }
    const fault = document.querySelector('.plugin-fallback[role=alert] p')?.textContent;
    if (fault && !faults.has(fault)) {
      faults.add(fault);
      if (fault === 'plugin_unresponsive') send('formal_unresponsive');
      if (fault === 'plugin_reloaded') send('formal_reload');
    }
  }, 150);
})();
"#;

fn host_script() -> String {
    // Host UI uses synthetic fixtures. Only probe events go through native IPC here.
    let preview = include_str!("../../ui-dev/public/tauri-mock.js")
        .replace("if (window.__TAURI__) return;", "")
        .replace("window.__TAURI__ = {", "window.__ISOLATION_PREVIEW__ = {");
    format!(r#"
const nativeInvoke = window.__TAURI__.core.invoke;
{preview}
const previewInvoke = window.__ISOLATION_PREVIEW__.core.invoke;
window.__TAURI__.core.invoke = (command, args) => command === 'isolation_probe_event' || command.startsWith('plugin_') ? nativeInvoke(command, args) : previewInvoke(command, args);
window.__TAURI__.event.listen = window.__ISOLATION_PREVIEW__.event.listen;
{OBSERVER}
"#)
}

fn create_city(app: &tauri::AppHandle, state: &ProbeState, label: &str) -> Result<Webview, String> {
    record(state, label, "create_started", Vec::new());
    let page_state = state.clone();
    let view = app.get_window(HOST).ok_or("probe_host_missing")?.add_child(
        crate::plugin_host::apply_plugin_webview_platform(app,
            WebviewBuilder::new(label, WebviewUrl::App("plugins/AgentCity.plugin/ui/index.html".into())))
            .initialization_script(OBSERVER)
            .on_page_load(move |view, payload| {
                let code = match payload.event() { tauri::webview::PageLoadEvent::Started => "load_started", tauri::webview::PageLoadEvent::Finished => "load_finished" };
                record(&page_state, view.label(), code, Vec::new());
            }),
        tauri::LogicalPosition::new(190.0, 48.0), tauri::LogicalSize::new(910.0, 712.0),
    ).map_err(|_| "probe_view_create_failed")?;
    record(state, label, "create_succeeded", Vec::new());
    Ok(view)
}

fn wait_until(state: &ProbeState, code: &str, predicate: impl Fn(&ProbeData) -> bool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if predicate(&state.0.lock().unwrap()) { return Ok(()); }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err(code.into())
}

fn host_alive(data: &ProbeData) -> bool {
    data.host_pulse.is_some_and(|pulse| pulse.elapsed() < Duration::from_millis(800))
}

#[allow(unexpected_cfgs)]
fn renderer_pid(view: &Webview) -> Result<i32, String> {
    use objc::{msg_send, sel, sel_impl};
    let (tx, rx) = std::sync::mpsc::channel();
    view.with_webview(move |platform| {
        let view = platform.inner() as *mut objc::runtime::Object;
        let supported: bool = unsafe { msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)] };
        let pid: i32 = if supported { unsafe { msg_send![view, _webProcessIdentifier] } } else { 0 };
        let _ = tx.send(pid);
    }).map_err(|_| "probe_pid_query_failed")?;
    rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "probe_pid_query_timeout".to_owned())
}

fn exercise(app: &tauri::AppHandle, state: &ProbeState) -> Result<Value, String> {
    wait_until(state, "host_boot_timeout", |data| data.ready.contains(HOST))?;
    formal_exercise(app, state)?;
    let city = create_city(app, state, CITY)?;
    wait_until(state, "city_boot_timeout", |data| data.ready.contains(CITY))?;
    let host = app.get_webview(HOST).ok_or("probe_host_missing")?;
    let host_pid = renderer_pid(&host)?;
    let city_pid = renderer_pid(&city)?;
    record(state, CITY, "process_identity_checked", Vec::new());
    if host_pid <= 1 || city_pid <= 1 { return Err("renderer_pid_unavailable".into()); }
    if host_pid == city_pid { return Err("renderer_process_shared".into()); }
    if city_pid == std::process::id() as i32 { return Err("renderer_identity_conflict".into()); }

    city.eval("window.__CITY_ISOLATION_FAULTS__.runtimeError()").map_err(|_| "fault_injection_failed")?;
    wait_until(state, "runtime_error_not_captured", |data| data.events.iter().any(|e| e["instance_id"] == CITY && e["code"] == "runtime_error"))?;
    city.eval("window.__CITY_ISOLATION_FAULTS__.rejection()").map_err(|_| "fault_injection_failed")?;
    wait_until(state, "rejection_not_captured", |data| data.events.iter().any(|e| e["instance_id"] == CITY && e["code"] == "unhandled_rejection"))?;
    city.eval("window.__TAURI__.core.invoke('plugin_request', {request:{version:1,instanceId:'stale',requestId:'probe-invalid',method:'data.read',payload:{}}}).catch(() => {})").map_err(|_| "fault_injection_failed")?;
    wait_until(state, "request_error_not_captured", |data| data.events.iter().any(|event| event["code"].as_str().unwrap_or("").ends_with(":request_rejected")))?;
    record(state, CITY, "hang_injected", Vec::new());
    city.eval("window.__CITY_ISOLATION_FAULTS__.hang()").map_err(|_| "fault_injection_failed")?;
    std::thread::sleep(Duration::from_millis(1800));
    // A single timer sample is not a responsiveness challenge. Require fresh
    // heartbeats within the same bounded wait used for other async probe stages.
    wait_until(state, "host_blocked_by_plugin_hang", host_alive)?;
    if state.0.lock().unwrap().city_pulses.get(CITY).is_some_and(|pulse| pulse.elapsed() < Duration::from_millis(800)) {
        return Err("plugin_hang_not_observed".into());
    }
    record(state, CITY, "unresponsive_detected", Vec::new());
    host.eval("document.querySelector('.sidebar .nav-item').click(); setTimeout(() => window.__TAURI__.core.invoke('isolation_probe_event', {code:'host_navigation_alive'}), 50)")
        .map_err(|_| "host_navigation_failed")?;
    wait_until(state, "host_navigation_timeout", |data| data.codes.contains("host_navigation_alive"))?;
    // PID was read from this probe's own WKWebView and checked against its host.
    let status = std::process::Command::new("/bin/kill").args(["-TERM", &city_pid.to_string()]).status().map_err(|_| "renderer_termination_failed")?;
    if !status.success() { return Err("renderer_termination_failed".into()); }
    record(state, CITY, "renderer_terminated", Vec::new());
    std::thread::sleep(Duration::from_millis(600));
    host.eval("document.querySelector('.sidebar .nav-item').click(); setTimeout(()=>{if(document.querySelector('.header-actions')) window.__TAURI__.core.invoke('isolation_probe_event',{code:'host_exit_navigation_alive'});},50)")
        .map_err(|_| "host_exit_navigation_failed")?;
    wait_until(state, "host_affected_by_plugin_exit", |data| data.codes.contains("host_exit_navigation_alive"))?;
    city.close().map_err(|_| "probe_view_close_failed")?;
    record(state, CITY, "instance_disposed", Vec::new());
    let restarted = create_city(app, state, RESTART)?;
    wait_until(state, "city_restart_timeout", |data| data.ready.contains(RESTART))?;
    let restarted_pid = renderer_pid(&restarted)?;
    if restarted_pid <= 1 || restarted_pid == host_pid { return Err("restart_process_not_isolated".into()); }
    record(state, RESTART, "restart_succeeded", Vec::new());
    Ok(json!({ "host_renderer_pid": host_pid, "city_renderer_pid": city_pid, "restarted_renderer_pid": restarted_pid,
        "independent_renderer": true, "host_alive_after_hang": true, "host_alive_after_exit": true, "city_restarted": true,
        "formal_plugin_toolbar": true, "formal_runtime_recovery": true, "stale_message_rejected": true,
        "formal_hang_recovery": true, "formal_renderer_exit_recovery": true }))
}

fn formal_exercise(app: &tauri::AppHandle, state: &ProbeState) -> Result<(), String> {
    let host = app.get_webview(HOST).ok_or("probe_host_missing")?;
    host.eval("document.querySelectorAll('.sidebar .nav-item')[1].click()").map_err(|_| "formal_navigation_failed")?;
    wait_until(state, "formal_city_boot_timeout", |data| data.ready.contains("plugin-city-1"))?;
    let city = app.get_webview("plugin-city-1").ok_or("formal_city_missing")?;
    if renderer_pid(&host)? == renderer_pid(&city)? { return Err("formal_renderer_shared".into()); }
    std::thread::sleep(Duration::from_millis(600));
    // Window selection moved out of the host toolbar and into City settings.
    // Open the overflow through the host UI, then operate the settings in the child view.
    host.eval(r#"(() => { const timer=setInterval(()=>{
        const toolbar=document.querySelector('.plugin-toolbar');
        const settings=[...(toolbar?.querySelectorAll('button') ?? [])].find(b=>b.textContent==='城市设置');
        if(settings && !settings.disabled) { clearInterval(timer); settings.click(); void window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_settings_clicked'}); return; }
        const more=toolbar?.querySelector('button[aria-expanded="false"]'); if(more) more.click();
    },50); setTimeout(()=>clearInterval(timer),10000); })()"#).map_err(|_| "formal_settings_failed")?;
    wait_until(state, "formal_settings_click_timeout", |data| data.codes.contains("formal_settings_clicked"))?;
    city.eval(r#"(() => { const timer=setInterval(()=>{
        const picker=document.querySelector('dialog[open] #city-window');
        if(picker && !picker.disabled) { clearInterval(timer); picker.value='7'; picker.dispatchEvent(new Event('change',{bubbles:true})); void window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_window_changed'}); }
    },50); setTimeout(()=>clearInterval(timer),10000); })()"#).map_err(|_| "formal_window_command_failed")?;
    wait_until(state, "formal_window_control_timeout", |data| data.codes.contains("formal_window_changed"))?;
    wait_until(state, "formal_projection_window_timeout", |data| data.codes.contains("window_seven_ready"))?;
    city.eval(r#"(() => { const dialog=document.querySelector('dialog[open][aria-label="城市设置"]');
        const close=dialog?.querySelector('button[aria-label="关闭城市设置"]');
        if(close) { close.click(); void window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_settings_closed'}); }
    })()"#).map_err(|_| "formal_settings_close_failed")?;
    wait_until(state, "formal_settings_close_timeout", |data| data.codes.contains("formal_settings_closed"))?;
    host.eval("(() => { const timer=setInterval(()=>{const b=[...document.querySelectorAll('.plugin-toolbar button')].find(b=>b.textContent==='重置视角');if(b&&!b.disabled){clearInterval(timer);b.click();void window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_reset_clicked'});}},50);setTimeout(()=>clearInterval(timer),10000);})()")
        .map_err(|_| "formal_reset_failed")?;
    wait_until(state, "formal_reset_timeout", |data| data.codes.contains("formal_reset_clicked"))?;
    std::thread::sleep(Duration::from_millis(600));
    host.eval("(() => { const timer=setInterval(()=>{const b=[...document.querySelectorAll('.plugin-toolbar button')].find(b=>b.textContent==='航拍');if(b&&!b.disabled){clearInterval(timer);b.click();}},50);setTimeout(()=>clearInterval(timer),10000);})()")
        .map_err(|_| "formal_cinema_failed")?;
    wait_until(state, "formal_cinema_start_timeout", |data| data.codes.contains("cinema_started"))?;
    host.eval("(() => { const timer=setInterval(()=>{const b=[...document.querySelectorAll('.plugin-toolbar button')].find(b=>b.textContent==='停止航拍');if(b&&!b.disabled){clearInterval(timer);b.click();}},50);setTimeout(()=>clearInterval(timer),10000);})()")
        .map_err(|_| "formal_cinema_failed")?;
    wait_until(state, "formal_cinema_stop_timeout", |data| data.codes.contains("cinema_stopped"))?;
    city.eval("window.__CITY_ISOLATION_FAULTS__.runtimeError()").map_err(|_| "formal_fault_failed")?;
    std::thread::sleep(Duration::from_millis(1000));
    host.eval("if(document.querySelector('.plugin-fallback[role=alert]')) document.querySelector('.plugin-fallback button').click();")
        .map_err(|_| "formal_retry_failed")?;
    wait_until(state, "formal_retry_timeout", |data| data.ready.contains("plugin-city-2"))?;
    let next = app.get_webview("plugin-city-2").ok_or("formal_retry_missing")?;
    next.eval("window.__TAURI__.core.invoke('plugin_message',{message:{version:1,instanceId:'plugin-city-1',type:'toolbar.update',revision:999,items:[]}}).catch(()=>window.__TAURI__.core.invoke('isolation_probe_event',{code:'stale_rejected'}))")
        .map_err(|_| "formal_stale_test_failed")?;
    wait_until(state, "formal_stale_not_rejected", |data| data.codes.contains("stale_rejected"))?;
    next.eval("window.__CITY_ISOLATION_FAULTS__.hang()").map_err(|_| "formal_hang_failed")?;
    wait_until(state, "formal_hang_not_detected", |data| data.codes.contains("formal_unresponsive"))?;
    host.eval("document.querySelector('.plugin-fallback button').click()").map_err(|_| "formal_retry_failed")?;
    wait_until(state, "formal_hang_retry_timeout", |data| data.ready.contains("plugin-city-3"))?;
    let crash_view = app.get_webview("plugin-city-3").ok_or("formal_retry_missing")?;
    let crash_pid = renderer_pid(&crash_view)?;
    if crash_pid <= 1 || crash_pid == renderer_pid(&host)? || crash_pid == std::process::id() as i32 { return Err("formal_renderer_identity_conflict".into()); }
    let status = std::process::Command::new("/bin/kill").args(["-TERM", &crash_pid.to_string()]).status().map_err(|_| "formal_renderer_termination_failed")?;
    if !status.success() { return Err("formal_renderer_termination_failed".into()); }
    wait_until(state, "formal_exit_not_detected", |data| data.codes.contains("formal_reload"))?;
    host.eval("document.querySelector('.plugin-fallback button').click()").map_err(|_| "formal_retry_failed")?;
    wait_until(state, "formal_exit_retry_timeout", |data| data.ready.contains("plugin-city-4"))?;
    host.eval("document.querySelector('.sidebar .nav-item').click()").map_err(|_| "formal_navigation_failed")?;
    std::thread::sleep(Duration::from_millis(700));
    if app.get_webview("plugin-city-4").is_none() { return Err("formal_suspended_instance_missing".into()); }
    let snapshot = crate::plugin_host::plugin_snapshot(host.clone(), app.state())?;
    if !snapshot["events"].as_array().is_some_and(|events| events.iter().any(|event| event["code"] == "suspended")) {
        return Err("formal_instance_not_suspended".into());
    }
    record(state, HOST, "formal_instance_suspended", Vec::new());
    host.eval("document.querySelectorAll('.sidebar .nav-item')[1].click()").map_err(|_| "formal_navigation_failed")?;
    std::thread::sleep(Duration::from_millis(700));
    let snapshot = crate::plugin_host::plugin_snapshot(host.clone(), app.state())?;
    if snapshot["instanceId"] != "plugin-city-4" { return Err("formal_instance_not_reused".into()); }
    if !snapshot["events"].as_array().is_some_and(|events| events.iter().any(|event| event["code"] == "resumed")) {
        return Err("formal_instance_not_resumed".into());
    }
    record(state, HOST, "formal_instance_reused", Vec::new());
    host.eval("window.__TAURI__.core.invoke('plugin_close',{instanceId:'plugin-city-4'}).then(()=>window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_disposed'}))")
        .map_err(|_| "formal_dispose_failed")?;
    wait_until(state, "formal_dispose_timeout", |data| data.codes.contains("formal_disposed"))?;
    if app.get_webview("plugin-city-4").is_some() { return Err("formal_instance_not_disposed".into()); }
    record(state, HOST, "formal_plugin_flow_passed", Vec::new());
    Ok(())
}

// Separate opt-in probe: a standalone City child WebView with synthetic fixtures.
// This does not exercise the formally registered plugin or access the authority DB.
fn mecha_exercise(app: &tauri::AppHandle, state: &ProbeState) -> Result<Value, String> {
    wait_until(state, "host_boot_timeout", |data| data.ready.contains(HOST))?;
    let script = format!(r#"{OBSERVER}
        window.__AV_PLUGIN_LOCALE__='zh-Hans';
        localStorage.setItem('city.seed','4196523069');
        (() => {{
            const send=(code)=>void window.__TAURI__.core.invoke('isolation_probe_event',{{code}});
            let phase=0;
            const timer=setInterval(()=>{{
                if(phase===0) {{
                    const settings=[...document.querySelectorAll('.city-local-toolbar button')].find(b=>b.textContent==='城市设置');
                    if(settings && !settings.disabled) {{ phase=1; send('mecha_fixture_ready'); settings.click(); }}
                }} else if(phase===1) {{
                    const entry=[...document.querySelectorAll('dialog[open] .city-game-entry button')].find(b=>b.textContent==='机甲战棋');
                    if(entry && !entry.disabled) {{ phase=2; entry.click(); }}
                }} else if(phase===2 && document.querySelector('.mecha-turn-summary')) {{
                    phase=3; clearInterval(timer); send('mecha_board_ready');
                }}
            }},100);
            setTimeout(()=>clearInterval(timer),160000);
        }})();
    "#);
    let city = app.get_window(HOST).ok_or("probe_host_missing")?.add_child(
        crate::plugin_host::apply_plugin_webview_platform(app,
            WebviewBuilder::new(CITY, WebviewUrl::App("plugins/AgentCity.plugin/ui/index.html?fixtureSessions=30".into())))
            .initialization_script(&script),
        tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(1100.0, 700.0),
    ).map_err(|_| "mecha_view_create_failed")?;
    let wait = |code: &str, event: &str| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            if state.0.lock().unwrap().codes.contains(event) { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(code.to_owned())
    };
    wait("mecha_fixture_timeout", "mecha_fixture_ready")?;
    wait("mecha_board_timeout", "mecha_board_ready")?;
    verify_mecha_actions(&city, state, false)?;
    city.close().map_err(|_| "mecha_view_close_failed")?;
    Ok(json!({ "standalone_city_webview": true, "fixture_sessions_requested": 30, "seed_configured": 4196523069u64,
        "hold_risk": 12, "hold_cancelled": true, "hold_confirmed": true, "building_hp_after": "68/80" }))
}

// Isolated, opt-in v1.5 smoke test: a packaged WKWebView with synthetic City data.
// This deliberately uses the preview checkpoint store, not real plugin data.
fn v15_script(status: bool) -> String {
    format!(r#"{OBSERVER}
        window.__AV_PLUGIN_LOCALE__='zh-Hans';
        localStorage.setItem('city.seed','4196523069');
        window.confirm=()=>true;
        (()=>{{
          const send=code=>void window.__TAURI__.core.invoke('isolation_probe_event',{{code}});
          const find=text=>[...document.querySelectorAll('[data-mecha-v15] button')].find(b=>b.textContent.trim()===text);
          const choose=(select,value)=>{{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,value);select.dispatchEvent(new Event('change',{{bubbles:true}}));}};
          let phase=0, unit=0, cells=[];
          const statusMode={status};
          const resumed=sessionStorage.getItem('v15-probe-reload')==='1';
          const timer=setInterval(()=>{{
            if(phase===0) {{const b=[...document.querySelectorAll('.city-local-toolbar button')].find(x=>x.textContent==='城市设置');if(b&&!b.disabled){{phase=1;b.click();}}}}
            else if(phase===1) {{const b=[...document.querySelectorAll('dialog[open] .city-game-entry button')].find(x=>x.textContent==='机甲战棋');if(b&&!b.disabled){{phase=2;b.click();}}}}
            else if(phase===2 && document.querySelector('[data-mecha-v15]')) {{send('v15_board_ready');phase=resumed?20:3;}}
            else if(phase===3) {{
              const discard=find('删除并新开'); if(discard&&!discard.disabled){{discard.click();return;}}
              const select=document.querySelector('#v15-cell');
              if(select&&!select.disabled&&select.options.length>3){{phase=4;}}
            }}
            else if(phase===4) {{const card=document.querySelectorAll('.mecha-v15-roster button')[unit];if(card&&!card.disabled){{card.click();phase=5;}}}}
            else if(phase===5) {{const select=document.querySelector('#v15-cell');if(select&&!select.disabled){{const cell=[...select.options].map(o=>o.value).find(value=>value&&!cells.includes(value));if(cell){{cells[unit]=cell;choose(select,cell);phase=6;}}}}}}
            else if(phase===6) {{const b=find('放置');if(b&&!b.disabled){{b.click();unit++;phase=unit<3?4:7;}}}}
            else if(phase===7) {{const b=find('确认部署');if(b&&!b.disabled){{b.click();phase=8;}}}}
            else if(phase===8) {{const action=document.querySelector('#v15-action'),select=document.querySelector('#v15-cell');if(action&&!action.disabled&&select&&!select.disabled&&select.options.length>1){{send('v15_deployed');if(statusMode){{clearInterval(timer);}}else{{choose(select,select.options[1].value);phase=9;}}}}}}
            else if(phase===9) {{const b=find('移动');if(b&&!b.disabled){{b.click();phase=10;}}}}
            else if(phase===10) {{const b=find('撤销移动');if(b&&!b.disabled){{send('v15_moved');b.click();phase=11;}}}}
            else if(phase===11) {{const action=document.querySelector('#v15-action'),undo=find('撤销移动');if(action&&!action.disabled&&undo&&undo.disabled){{send('v15_undo');sessionStorage.setItem('v15-probe-reload','1');phase=12;location.reload();}}}}
            else if(phase===20) {{const b=find('恢复对局');if(b&&!b.disabled){{b.click();phase=21;}}}}
            else if(phase===21) {{const action=document.querySelector('#v15-action');if(action&&!action.disabled){{send('v15_recovered');sessionStorage.removeItem('v15-probe-reload');clearInterval(timer);}}}}
          }},100);
          setTimeout(()=>clearInterval(timer),180000);
        }})();
    "#)
}

fn v15_exercise(app: &tauri::AppHandle, state: &ProbeState) -> Result<Value, String> {
    wait_until(state, "host_boot_timeout", |data| data.ready.contains(HOST))?;
    let script = v15_script(false);
    let city = app.get_window(HOST).ok_or("probe_host_missing")?.add_child(
        crate::plugin_host::apply_plugin_webview_platform(app,
            WebviewBuilder::new(CITY, WebviewUrl::App("plugins/AgentCity.plugin/ui/index.html?fixtureSessions=30&mechaV15=1".into())))
            .initialization_script(&script),
        tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(1100.0, 700.0),
    ).map_err(|_| "v15_view_create_failed")?;
    for (event, timeout) in [("v15_board_ready", "v15_board_timeout"), ("v15_deployed", "v15_deploy_timeout"),
        ("v15_moved", "v15_move_timeout"), ("v15_undo", "v15_undo_timeout"), ("v15_recovered", "v15_recovery_timeout")] {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline && !state.0.lock().unwrap().codes.contains(event) { std::thread::sleep(Duration::from_millis(100)); }
        if !state.0.lock().unwrap().codes.contains(event) { return Err(timeout.into()); }
    }
    city.close().map_err(|_| "v15_view_close_failed")?;
    Ok(json!({"standalone_city_webview":true,"fixture_sessions":30,"deployment":true,"move":true,"undo":true,"reload_recovery":true,"checkpoint_backend":"indexeddb"}))
}

// Registered-plugin probe: only the mecha state key is permitted, and its data
// root must be an explicitly configured, isolated temporary directory.
fn formal_v15_exercise(app: &tauri::AppHandle, state: &ProbeState, resume: bool, status: bool) -> Result<Value, String> {
    let root = std::env::var_os("AGENT_VITALS_HOME").ok_or("v15_isolated_home_required")?;
    let root = std::fs::canonicalize(root).map_err(|_| "v15_isolated_home_required")?;
    let temp = std::fs::canonicalize(std::env::temp_dir()).map_err(|_| "v15_isolated_home_required")?;
    if !root.starts_with(&temp) || root == temp { return Err("v15_isolated_home_required".into()); }
    wait_until(state, "host_boot_timeout", |data| data.ready.contains(HOST))?;
    let host = app.get_webview(HOST).ok_or("probe_host_missing")?;
    host.eval("[...document.querySelectorAll('.sidebar .nav-item')].find(b=>b.textContent.trim()==='City')?.click()").map_err(|_| "formal_navigation_failed")?;
    wait_until(state, "formal_city_boot_timeout", |data| data.ready.contains("plugin-city-1"))?;
    let city = app.get_webview("plugin-city-1").ok_or("formal_city_missing")?;
    if status {
        city.eval("const u=new URL(location.href);u.searchParams.set('mechaStatus','prism_warden');history.replaceState(null,'',u.toString())")
            .map_err(|_| "v15_status_query_failed")?;
    }
    host.eval(r#"(() => { const timer=setInterval(()=>{
      const toolbar=document.querySelector('.plugin-toolbar');
      const b=[...(toolbar?.querySelectorAll('button') ?? [])].find(x=>['城市设置','City settings'].includes(x.textContent));
      if(b&&!b.disabled){clearInterval(timer);b.click();void window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_settings_clicked'});}
      else toolbar?.querySelector('button[aria-expanded="false"]')?.click();
    },50);setTimeout(()=>clearInterval(timer),10000);})()"#).map_err(|_| "formal_settings_failed")?;
    wait_until(state, "formal_settings_click_timeout", |data| data.codes.contains("formal_settings_clicked"))?;
    let mut script = v15_script(status).replace("let phase=0, unit=0, cells=[];", "let phase=1, unit=0, cells=[];")
        .replace("sessionStorage.setItem('v15-probe-reload','1');phase=12;location.reload();", "phase=12;clearInterval(timer);");
    if resume { script = script.replace("phase=resumed?20:3;", "phase=20;"); }
    city.eval(format!("sessionStorage.removeItem('v15-probe-reload'); {script}")).map_err(|_| "v15_entry_failed")?;
    let events: &[&str] = if resume { &["v15_board_ready", "v15_recovered"] } else if status { &["v15_board_ready", "v15_deployed"] } else { &["v15_board_ready", "v15_deployed", "v15_moved", "v15_undo"] };
    for event in events {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline && !state.0.lock().unwrap().codes.contains(*event) { std::thread::sleep(Duration::from_millis(100)); }
        if !state.0.lock().unwrap().codes.contains(*event) { return Err(format!("{event}_timeout")); }
    }
    let allowed = vec!["mecha-checkpoint:v1".to_owned()];
    let payload = json!({"key":"mecha-checkpoint:v1"});
    let checkpoint = crate::plugin_state::handle(&allowed, &root, "city", "plugin.state.read", &payload).map_err(str::to_owned)?;
    let checkpoint_revision = checkpoint["value"]["revision"].as_u64().unwrap_or(0);
    let raw = checkpoint["value"]["raw"].as_str().ok_or("v15_checkpoint_missing")?;
    let record: Value = serde_json::from_str(raw).map_err(|_| "v15_checkpoint_invalid")?;
    let archive: Value = serde_json::from_str(record["archive"].as_str().ok_or("v15_checkpoint_invalid")?).map_err(|_| "v15_checkpoint_invalid")?;
    let commands = archive["replay"]["entries"].as_array().ok_or("v15_checkpoint_invalid")?;
    if status {
        if archive["schema"] != "mecha-sequential-bundle:v2" || archive["opening"]["encounter"]["speciesId"] != "prism_warden" || archive["opening"]["encounter"]["statusRules"] != "mecha-status-encounter:v1" || checkpoint_revision < 1 || !commands.is_empty() {
            return Err("v15_status_checkpoint_mismatch".into());
        }
    } else if checkpoint_revision < 3 || commands.len() != 2 || commands[0]["command"]["kind"] != "move" || commands[1]["command"]["kind"] != "undo" {
        return Err("v15_checkpoint_mismatch".into());
    }
    host.eval("window.__TAURI__.core.invoke('plugin_close',{instanceId:'plugin-city-1'}).then(()=>window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_disposed'}))").map_err(|_| "formal_dispose_failed")?;
    wait_until(state, "formal_dispose_timeout", |data| data.codes.contains("formal_disposed"))?;
    Ok(json!({"registered_plugin":true,"synthetic_fixture":true,"deployment":!resume,"move":!resume && !status,"undo":!resume && !status,"restart_recovery":resume,"checkpoint_backend":"host_sqlite","checkpoint_schema":archive["schema"],"status_species":if status { Some("prism_warden") } else { None },"checkpoint_commands":commands.len()}))
}

// The same deterministic turn assertions are used in the standalone and registered plugin views.
fn verify_mecha_actions(city: &Webview, state: &ProbeState, formal: bool) -> Result<(), String> {
    let wait = |code: &str, event: &str| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            if state.0.lock().unwrap().codes.contains(event) { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(code.to_owned())
    };
    // The registered plugin's default three-session fixture has a mixed opening
    // suggestion. Explicitly change all three actions to wait before checking risk.
    if formal {
        city.eval(r#"(() => {
            let index=0, selected=false;
            const timer=setInterval(()=>{
                const cards=[...document.querySelectorAll('.mecha-pack li')];
                if(cards.length!==3) return;
                if(index===3) {
                    if(cards.every(card=>card.querySelector('.mecha-card-action')?.textContent==='待机')) {
                        clearInterval(timer); void window.__TAURI__.core.invoke('isolation_probe_event',{code:'mecha_all_hold'});
                    }
                    return;
                }
                if(!selected) { const button=cards[index].querySelector('button'); if(button && !button.disabled) { button.click(); selected=true; } }
                else {
                    const hold=[...document.querySelectorAll('.mecha-selected-actions > .mecha-actions > button')].find(b=>b.textContent==='待机');
                    if(hold && !hold.disabled) { hold.click(); index++; selected=false; }
                }
            },150); setTimeout(()=>clearInterval(timer),160000);
        })()"#).map_err(|_| "formal_mecha_hold_command_failed")?;
        wait("formal_mecha_all_hold_timeout", "mecha_all_hold")?;
    }
    // Leave the synthetic board visible briefly for optional window-only evidence.
    std::thread::sleep(Duration::from_secs(3));
    let action_script = r#"(() => {
        const send=(code)=>void window.__TAURI__.core.invoke('isolation_probe_event',{code});
        let phase=0;
        let resumeAt=0;
        const timer=setInterval(()=>{
            if(Date.now()<resumeAt) return;
            const confirm=document.querySelector('.mecha-hold-confirm');
            if(phase===0) {
                const submit=document.querySelector('.mecha-submit-primary');
                if(submit && !submit.disabled) { phase=1; submit.click(); resumeAt=Date.now()+3000; }
            } else if(phase===1 && confirm?.textContent.includes('预计建筑损失 EXPECTED_RISK')) {
                send('mecha_hold_risk');
                const cancel=[...confirm.querySelectorAll('button')].find(b=>b.textContent==='返回修改');
                if(cancel) { phase=2; cancel.click(); }
            } else if(phase===2 && !confirm) {
                send('mecha_hold_cancelled'); phase=3;
                document.querySelector('.mecha-submit-primary')?.click();
            } else if(phase===3 && confirm?.textContent.includes('预计建筑损失 EXPECTED_RISK')) {
                const proceed=[...confirm.querySelectorAll('button')].find(b=>b.textContent==='继续提交');
                if(proceed && !proceed.disabled) { phase=4; proceed.click(); send('mecha_hold_confirmed'); }
            } else if(phase===4) {
                const skip=[...document.querySelectorAll('.mecha-battle-controls button')].find(b=>b.textContent==='跳过演出');
                if(skip) skip.click();
                if(document.querySelector('.mecha-resource')?.textContent.includes('EXPECTED_HP')) {
                    clearInterval(timer); send('mecha_turn_resolved');
                }
            }
        },100);
        setTimeout(()=>clearInterval(timer),160000);
    })()"#.replace("EXPECTED_RISK", if formal { "3" } else { "12" })
        .replace("EXPECTED_HP", if formal { "29/32" } else { "68/80" });
    city.eval(&action_script).map_err(|_| "mecha_action_failed")?;
    wait("mecha_hold_risk_timeout", "mecha_hold_risk")?;
    wait("mecha_hold_cancel_timeout", "mecha_hold_cancelled")?;
    wait("mecha_hold_confirm_timeout", "mecha_hold_confirmed")?;
    wait("mecha_turn_resolution_timeout", "mecha_turn_resolved")?;
    std::thread::sleep(Duration::from_secs(3));
    Ok(())
}

// Uses the registered host/plugin lifecycle, with the probe-only observer forcing
// fixture projections. No real authority requests are permitted by this probe's
// plugin_request handler for registered instances.
fn formal_mecha_exercise(app: &tauri::AppHandle, state: &ProbeState, interactive: bool) -> Result<Value, String> {
    wait_until(state, "host_boot_timeout", |data| data.ready.contains(HOST))?;
    let host = app.get_webview(HOST).ok_or("probe_host_missing")?;
    host.eval("document.querySelectorAll('.sidebar .nav-item')[1].click()")
        .map_err(|_| "formal_navigation_failed")?;
    wait_until(state, "formal_city_boot_timeout", |data| data.ready.contains("plugin-city-1"))?;
    let city = app.get_webview("plugin-city-1").ok_or("formal_city_missing")?;
    host.eval(r#"(() => { const timer=setInterval(()=>{
        const toolbar=document.querySelector('.plugin-toolbar');
        const settings=[...(toolbar?.querySelectorAll('button') ?? [])].find(b=>['城市设置','City settings'].includes(b.textContent));
        if(settings && !settings.disabled) { clearInterval(timer); settings.click(); void window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_settings_clicked'}); return; }
        const more=toolbar?.querySelector('button[aria-expanded="false"]'); if(more) more.click();
    },50); setTimeout(()=>clearInterval(timer),10000); })()"#).map_err(|_| "formal_settings_failed")?;
    wait_until(state, "formal_settings_click_timeout", |data| data.codes.contains("formal_settings_clicked"))?;
    let entry_script = r#"(() => {
        const send=(code)=>void window.__TAURI__.core.invoke('isolation_probe_event',{code});
        let phase=0, resumeAt=0;
        const timer=setInterval(()=>{
            if(Date.now()<resumeAt) return;
            const dialog=document.querySelector('dialog[open][aria-label="城市设置"]') ?? document.querySelector('dialog[open][aria-label="City settings"]');
            const input=dialog?.querySelector('#city-seed');
            if(phase===0 && input && !input.disabled && input.value==='74031' && localStorage.getItem('city.seed')==='74031' && window.__CITY_ISOLATION_FIXTURE__ && ['演示','Demo'].includes(document.querySelector('.city-coverage-badge')?.textContent)) {
                send('mecha_seed_initial_74031');
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'4196523069');
                input.dispatchEvent(new Event('input',{bubbles:true})); phase=1; send('mecha_seed_input');
            } else if(phase===1 && input?.value==='4196523069') {
                const apply=[...dialog.querySelectorAll('button')].find(b=>['应用种子','Apply seed'].includes(b.textContent));
                if(apply && !apply.disabled) { send('mecha_seed_apply_clicked'); apply.click(); phase=2; resumeAt=Date.now()+1500; }
            } else if(phase===2 && localStorage.getItem('city.seed')==='4196523069') {
                send('mecha_seed_stored'); phase=3;
            } else if(phase===3 && window.__CITY_ISOLATION_FIXTURE__ && localStorage.getItem('city.seed')==='4196523069' && ['演示','Demo'].includes(document.querySelector('.city-coverage-badge')?.textContent)) {
                const entry=[...(dialog?.querySelectorAll('.city-game-entry button') ?? [])].find(b=>['机甲战棋','Mecha tactics'].includes(b.textContent));
                if(entry && !entry.disabled) { send('mecha_seed_applied'); phase=4; entry.click(); }
            } else if(phase===4 && document.querySelector('.mecha-turn-summary')) {
                clearInterval(timer); send('mecha_board_ready');
            }
        },100); setTimeout(()=>clearInterval(timer),160000);
    })()"#;
    let entry_script = if interactive {
        entry_script.replace("let phase=0, resumeAt=0;", "let phase=3, resumeAt=0, frameStart=null, frameDeadline=0;")
            .replace("clearInterval(timer); send('mecha_board_ready');\n            }\n        },100); setTimeout(()=>clearInterval(timer),160000);", r#"phase=5; frameDeadline=Date.now()+15000;
            } else if(phase===5) {
                const elapsed=window.__AV_CITY_PROBE__?.()?.scene?.camera?.elapsed;
                const canvas=document.querySelector('canvas');
                if(Number.isFinite(elapsed) && frameStart===null) frameStart=elapsed;
                if(frameStart!==null && elapsed-frameStart>=0.2 && canvas?.width>0 && canvas?.height>0) {
                    clearInterval(timer); send('mecha_board_ready');
                } else if(Date.now()>=frameDeadline) {
                    clearInterval(timer); send('mecha_render_stalled');
                }
            }
        },100); setTimeout(()=>clearInterval(timer),160000);"#)
    } else { entry_script.to_owned() };
    city.eval(&entry_script).map_err(|_| "formal_mecha_entry_failed")?;
    let wait = |code: &str, event: &str| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            if state.0.lock().unwrap().codes.contains(event) { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(code.to_owned())
    };
    wait("formal_mecha_seed_timeout", "mecha_seed_applied")?;
    if !interactive { wait("formal_mecha_initial_seed_timeout", "mecha_seed_initial_74031")?; }
    if interactive {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            let data = state.0.lock().unwrap();
            if data.codes.contains("mecha_render_stalled") { return Err("formal_mecha_render_stalled".into()); }
            if data.codes.contains("mecha_board_ready") { break; }
            drop(data);
            if Instant::now() >= deadline { return Err("formal_mecha_board_timeout".into()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        return Ok(json!({ "registered_plugin": true, "fixture_source_badge": true, "seed_saved": 4196523069u64,
            "render_clock_advanced": true, "visual_verification_required": true, "automated_acceptance": false }));
    }
    wait("formal_mecha_board_timeout", "mecha_board_ready")?;
    verify_mecha_actions(&city, state, true)?;
    city.eval(r#"(() => {
        const exit=[...document.querySelectorAll('.mecha-battle-controls button')].find(b=>b.textContent==='退出战斗');
        if(exit) exit.click();
        const timer=setInterval(()=>{if(!document.querySelector('.mecha-overlay')) {
            clearInterval(timer); void window.__TAURI__.core.invoke('isolation_probe_event',{code:'mecha_exited'});
        }},100); setTimeout(()=>clearInterval(timer),10000);
    })()"#).map_err(|_| "formal_mecha_exit_failed")?;
    wait("formal_mecha_exit_timeout", "mecha_exited")?;
    host.eval("window.__TAURI__.core.invoke('plugin_close',{instanceId:'plugin-city-1'}).then(()=>window.__TAURI__.core.invoke('isolation_probe_event',{code:'formal_disposed'}))")
        .map_err(|_| "formal_dispose_failed")?;
    wait_until(state, "formal_dispose_timeout", |data| data.codes.contains("formal_disposed"))?;
    if app.get_webview("plugin-city-1").is_some() { return Err("formal_instance_not_disposed".into()); }
    Ok(json!({ "registered_plugin": true, "fixture_source_badge": true, "seed_saved": 4196523069u64,
        "hold_risk": 3, "hold_cancelled": true, "hold_confirmed": true, "building_hp_after": "29/32",
        "battle_exit": true, "plugin_disposed": true }))
}

pub fn report_argument() -> Option<PathBuf> {
    if let Some(report) = std::env::var_os("AGENT_VITALS_ISOLATION_REPORT") {
        return Some(PathBuf::from(report));
    }
    let args: Vec<String> = std::env::args().collect();
    args.windows(2).find(|pair| ["--plugin-isolation-probe", "--plugin-mecha-probe", "--plugin-v15-probe", "--plugin-formal-v15-probe", "--plugin-formal-v15-resume", "--plugin-formal-v15-status-probe", "--plugin-formal-v15-status-resume", "--plugin-formal-mecha-probe", "--plugin-formal-mecha-interactive"].contains(&pair[0].as_str())).map(|pair| PathBuf::from(&pair[1]))
}

pub fn run(report: PathBuf, mut context: tauri::Context<tauri::Wry>) {
    let mecha = std::env::args().any(|arg| arg == "--plugin-mecha-probe");
    let v15 = std::env::args().any(|arg| arg == "--plugin-v15-probe");
    let formal_v15 = std::env::args().any(|arg| arg == "--plugin-formal-v15-probe" || arg == "--plugin-formal-v15-resume");
    let resume_v15 = std::env::args().any(|arg| arg == "--plugin-formal-v15-resume");
    let formal_v15_status = std::env::args().any(|arg| arg == "--plugin-formal-v15-status-probe" || arg == "--plugin-formal-v15-status-resume");
    let resume_v15_status = std::env::args().any(|arg| arg == "--plugin-formal-v15-status-resume");
    let interactive = std::env::args().any(|arg| arg == "--plugin-formal-mecha-interactive");
    let interactive_en = interactive && std::env::args().any(|arg| arg == "--mecha-fixture-en");
    let formal_mecha = interactive || std::env::args().any(|arg| arg == "--plugin-formal-mecha-probe");
    let state = ProbeState(Arc::new(Mutex::new(ProbeData { started: Instant::now(), host_pulse: None, city_pulses: BTreeMap::new(),
        ready: BTreeSet::new(), codes: BTreeSet::new(), request_count: 0, events: Vec::new() })));
    let setup_state = state.clone();
    context.config_mut().app.windows.clear();
    tauri::Builder::default().manage(state).manage(crate::plugin_host::PluginHost::default())
        .invoke_handler(tauri::generate_handler![isolation_probe_event, plugin_request,
            crate::plugin_host::plugin_open, crate::plugin_host::plugin_close, crate::plugin_host::plugin_snapshot,
            crate::plugin_host::plugin_command, crate::plugin_host::plugin_message,
            crate::plugin_host::plugin_invalidate])
        .setup(move |app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let page_state = setup_state.clone();
            // Incognito probe host only: force an English fixture when requested.
            let host_initialization = if interactive_en {
                format!("localStorage.setItem('agent-vitals.language', 'en');\n{}", host_script())
            } else { host_script() };
            WebviewWindowBuilder::new(app, HOST, WebviewUrl::App("index.html".into()))
                .title("Oh Agent · plugin isolation probe").inner_size(1100.0, 760.0)
                .incognito(true).initialization_script(host_initialization)
                .on_page_load(move |view, payload| {
                    let code = match payload.event() { tauri::webview::PageLoadEvent::Started => "load_started", tauri::webview::PageLoadEvent::Finished => "load_finished" };
                    record(&page_state, view.label(), code, Vec::new());
                }).build()?;
            let app = app.handle().clone();
            let state = setup_state.clone();
            std::thread::spawn(move || {
                let result = if formal_mecha { formal_mecha_exercise(&app, &state, interactive) } else if formal_v15_status { formal_v15_exercise(&app, &state, resume_v15_status, true) } else if formal_v15 { formal_v15_exercise(&app, &state, resume_v15, false) } else if v15 { v15_exercise(&app, &state) } else if mecha { mecha_exercise(&app, &state) } else { exercise(&app, &state) };
                let (status, code, checks) = match result {
                    Ok(checks) if interactive => ("needs_visual_check", "manual_fixture_needs_visual_check".to_owned(), checks),
                    Ok(checks) => ("passed", "probe_complete".to_owned(), checks),
                    Err(code) => ("failed", code, Value::Null),
                };
                record(&state, HOST, &code, Vec::new());
                let plugin_diagnostics = app.get_webview(HOST).and_then(|view|
                    crate::plugin_host::plugin_snapshot(view, app.state()).ok());
                let report_data = json!({ "schema": "plugin-isolation-probe/v1", "status": status, "code": code,
                    "native_process_pid": std::process::id(), "requested_fixture_locale": if interactive_en { "en" } else { "host_preference" },
                    "host_data": "synthetic_preview", "city_data": if formal_mecha || formal_v15 || formal_v15_status { "registered_plugin_synthetic_fixture" } else if mecha || v15 { "synthetic_fixture_requested_30_sessions" } else { "native_rust_fixture" },
                    "checks": checks, "plugin_diagnostics": plugin_diagnostics, "events": state.0.lock().unwrap().events });
                let saved = std::fs::OpenOptions::new().write(true).create_new(true).open(&report)
                    .and_then(|mut file| file.write_all(serde_json::to_string_pretty(&report_data).unwrap().as_bytes()));
                if saved.is_err() { eprintln!("plugin isolation report write failed"); }
                if !interactive || status != "needs_visual_check" || saved.is_err() {
                    app.exit(if status == "passed" && saved.is_ok() { 0 } else { 1 });
                }
            });
            Ok(())
        }).run(context).expect("plugin isolation probe setup failed");
}
