use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager, WebviewWindow};

fn label(preview_id: &str) -> String { format!("code-preview-{preview_id}") }

pub(crate) fn open_pending(app: &AppHandle, now: u64) {
    let home = crate::overview::data_home();
    let request = match crate::creator_code_game::request_preview_window(&home, now) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(error) => {
            agent_vitals_runtime::logging::log_warn("code_preview", error);
            return;
        }
    };
    if let Err(error) = open(app, &home, &request) {
        agent_vitals_runtime::logging::log_warn("code_preview", error);
    }
}

fn open(app: &AppHandle, home: &Path, request: &Value) -> Result<(), &'static str> {
    let preview_id = request.get("previewId").and_then(Value::as_str).ok_or("preview_request_invalid")?;
    let window_label = label(preview_id);
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let mut source = request.get("source").cloned().ok_or("preview_source_unavailable")?;
    if source.get("synthetic").and_then(Value::as_bool) != Some(true) {
        let city_id = source.get("cityId").and_then(Value::as_str).ok_or("preview_source_unavailable")?;
        let city = match source.get("cityRevision").and_then(Value::as_u64) {
            Some(revision) => crate::creator_cities::read_city_revision(home, city_id, revision)?,
            None => crate::creator_cities::read_city(home, city_id)?,
        };
        source["seed"] = json!(city["seed"]);
        source["profile"] = city["profile"].clone();
        if let Some(patch) = city.get("planPatch") { source["planPatch"] = patch.clone(); }
    }
    let bootstrap = serde_json::to_string(&json!({"previewId":preview_id,"source":source})).map_err(|_| "preview_request_invalid")?;
    let script = format!("window.__AV_CODE_PREVIEW_ID__={};window.__AV_PLUGIN_INSTANCE__={};window.__AV_CODE_PREVIEW_BOOT__={};",
        serde_json::to_string(preview_id).map_err(|_| "preview_request_invalid")?,
        serde_json::to_string(&window_label).map_err(|_| "preview_request_invalid")?, bootstrap);
    tauri::WebviewWindowBuilder::new(app, &window_label,
        tauri::WebviewUrl::App("plugins/AgentCity.plugin/ui/preview.html".into()))
        .title("Code Game Preview")
        .inner_size(1100.0, 760.0)
        .incognito(true)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(&script)
        .build().map_err(|_| "preview_window_unavailable")?;
    Ok(())
}

#[tauri::command]
pub async fn code_game_preview_request(window: WebviewWindow, request: Value) -> Result<Value, String> {
    let preview_id = request.get("previewId").and_then(Value::as_str).ok_or("preview_request_invalid")?;
    if window.label() != label(preview_id) { return Err("preview_instance_mismatch".into()); }
    let command = request.get("command").and_then(Value::as_str).ok_or("preview_request_invalid")?;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let home = crate::overview::data_home();
    match command {
        "plugin_request" => {
            let call = args.get("request").cloned().ok_or("preview_request_invalid")?;
            let method = call.get("method").and_then(Value::as_str).ok_or("preview_request_invalid")?;
            let payload = call.get("payload").cloned().unwrap_or_else(|| json!({}));
            let result = match method {
                "city.game.run.start" => crate::city_runtime::start_preview_run(&home, preview_id, &payload),
                "city.time.read" => crate::city_runtime::read_preview_clock(&home, preview_id, &payload),
                // Story 读走 Preview Fork（隔离 Spec §7.3）；preview 域不路由正式
                // story 写入——RFC §13 第 3 条：PR-4 前保持失败关闭。
                "city.story.read" => crate::city_runtime::read_preview_story(&home, preview_id, &payload),
                "city.code.preview.next" | "city.code.preview.read" | "city.code.preview.close" | "city.game.run.stop" =>
                    crate::creator_projects::dispatch_city_runtime(&home, preview_id, method, &payload),
                _ => Err("preview_method_unavailable"),
            };
            match result {
                Ok(value) => Ok(json!({"version":1,"requestId":call["requestId"],"ok":true,"result":value})),
                Err(code) => Ok(json!({"version":1,"requestId":call["requestId"],"ok":false,"error":{"code":code}})),
            }
        }
        "plugin_message" => {
            let message = args.get("message").cloned().ok_or("preview_request_invalid")?;
            match message.get("type").and_then(Value::as_str) {
                Some("code-game.state") => {
                    let mut state = message.get("state").cloned().ok_or("code_game_state_invalid")?;
                    state["previewId"] = json!(preview_id);
                    crate::creator_code_game::record_preview_state(&home, &state).map_err(|_| "code_game_state_invalid".to_string())?;
                    Ok(json!({"ok":true}))
                }
                Some("plugin.performance") => Ok(json!({"ok":true})),
                _ => Err("preview_message_unavailable".into()),
            }
        }
        _ => Err("preview_command_unavailable".into()),
    }
}

fn close(home: &Path, preview_id: &str) {
    let _ = crate::city_runtime::stop_preview_runs(home, preview_id);
    let Ok(status) = crate::creator_code_game::studio_status_for(home, preview_id) else { return; };
    if !matches!(status.get("status").and_then(Value::as_str), Some("finished" | "error")) {
        let _ = crate::creator_code_game::record_preview_state(home, &json!({"status":"finished","previewId":preview_id,
            "gameId":status["gameId"],"buildId":status["buildId"],"runId":status["runId"],"reason":"preview_window_closed"}));
    }
}

pub(crate) fn close_for_window(window_label: &str) {
    let Some(preview_id) = window_label.strip_prefix("code-preview-") else { return; };
    close(&crate::overview::data_home(), preview_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("code-preview-close-{name}-{}-{}", crate::creator_store::now_ms(), std::process::id()))
    }

    #[test]
    fn closing_a_queued_preview_makes_it_terminal_and_prevents_reopen() {
        let home = home("queued");
        let preview_id = "preview-close-queued";
        let directory = home.join("state/creator/code-games/previews").join(preview_id);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("request.json"), serde_json::to_vec(&json!({"requestId":"request-1","previewId":preview_id,
            "buildId":"a".repeat(64),"seed":7,"source":{"cityId":"city:preview-fixture","synthetic":true},"status":"queued","createdAtMs":1})).unwrap()).unwrap();
        close(&home, preview_id);
        assert_eq!(crate::creator_code_game::studio_status_for(&home, preview_id).unwrap()["status"], "finished");
        assert!(crate::creator_code_game::request_preview_window(&home, 20_000).unwrap().is_none());
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn story_evidence_uses_the_requested_preview_not_the_latest_one() {
        let home = home("story");
        let older = crate::city_runtime::start_preview_run(&home, "preview-story-older", &json!({"cityId":"city:one","gameId":"game.test"})).unwrap();
        let newer = crate::city_runtime::start_preview_run(&home, "preview-story-newer", &json!({"cityId":"city:one","gameId":"game.test"})).unwrap();
        for (preview_id, run) in [("preview-story-older", &older), ("preview-story-newer", &newer)] {
            crate::creator_code_game::record_preview_state(&home, &json!({"status":"running","previewId":preview_id,
                "gameId":"game.test","runId":run["runId"]})).unwrap();
        }
        let evidence = crate::creator_projects::dispatch_as(&home, "local-profile-v1", "studio-test", "creator.code.story",
            &json!({"previewId":"preview-story-older"})).unwrap();
        assert_eq!(evidence["available"], true);
        assert_eq!(evidence["runId"], older["runId"]);
        assert_ne!(evidence["runId"], newer["runId"]);
        std::fs::remove_dir_all(home).ok();
    }

    #[test]
    fn closing_starting_preview_stops_run_even_without_published_run_id() {
        let home = home("starting");
        let preview_id = "preview-close-starting";
        let run = crate::city_runtime::start_preview_run(&home, preview_id, &json!({"cityId":"city:one","gameId":"game.test"})).unwrap();
        crate::creator_code_game::record_preview_state(&home, &json!({"status":"starting","previewId":preview_id,"gameId":"game.test"})).unwrap();
        close(&home, preview_id);
        let db = crate::creator_store::database(&home).unwrap();
        let status: String = db.query_row("SELECT status FROM city_game_runs WHERE run_id=?1", [run["runId"].as_str().unwrap()], |row| row.get(0)).unwrap();
        assert_eq!(status, "stopped");
        assert_eq!(crate::creator_code_game::studio_status_for(&home, preview_id).unwrap()["status"], "finished");
        std::fs::remove_dir_all(home).ok();
    }
}
