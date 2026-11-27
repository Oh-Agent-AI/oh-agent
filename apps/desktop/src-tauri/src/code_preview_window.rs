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
    handle_preview_request(&crate::overview::data_home(), window.label(), &request)
}

/// 命令面守卫矩阵的同步形态（S-0 Top5-② 的可测面）：label↔previewId 配对、
/// 顶层 command allowlist、method/type allowlist 与宿主派发全部在这一个函数里，
/// async 命令入口只做 webview label 的接线，不承载任何判断。
fn handle_preview_request(home: &Path, window_label: &str, request: &Value) -> Result<Value, String> {
    let preview_id = request.get("previewId").and_then(Value::as_str).ok_or("preview_request_invalid")?;
    if window_label != label(preview_id) { return Err("preview_instance_mismatch".into()); }
    let command = request.get("command").and_then(Value::as_str).ok_or("preview_request_invalid")?;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    match command {
        "plugin_request" => {
            let call = args.get("request").cloned().ok_or("preview_request_invalid")?;
            let method = call.get("method").and_then(Value::as_str).ok_or("preview_request_invalid")?;
            let payload = call.get("payload").cloned().unwrap_or_else(|| json!({}));
            let result = match method {
                "city.game.run.start" => crate::city_runtime::start_preview_run(home, preview_id, &payload),
                "city.time.read" => crate::city_runtime::read_preview_clock(home, preview_id, &payload),
                // Story 读走 Preview Fork（隔离 Spec §7.3）；preview 域不路由正式
                // story 写入——RFC §13 第 3 条：PR-4 前保持失败关闭。
                "city.story.read" => crate::city_runtime::read_preview_story(home, preview_id, &payload),
                "city.code.preview.next" | "city.code.preview.read" | "city.code.preview.close" | "city.game.run.stop" =>
                    crate::creator_projects::dispatch_city_runtime(home, preview_id, method, &payload),
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
                    crate::creator_code_game::record_preview_state(home, &state).map_err(|_| "code_game_state_invalid".to_string())?;
                    Ok(json!({"ok":true}))
                }
                // PR05 City Snapshot Test 的导出面：真实 City 的 Code 预览把渲染端
                // 物化的 CityWorldSnapshotV4 序列化上报，宿主三重绑定身份后有界落盘
                // （creator_code_game::store_city_test_snapshot）。宿主不重算快照，
                // 拒绝细节按稳定码记日志，webview 只回信封级错误码。
                Some("city.snapshot.export") => {
                    let snapshot_json = message.get("snapshotJson").and_then(Value::as_str).unwrap_or_default();
                    match crate::creator_code_game::store_city_test_snapshot(home, preview_id, snapshot_json) {
                        Ok(receipt) => Ok(json!({"ok":true,"receipt":receipt})),
                        Err(code) => {
                            agent_vitals_runtime::logging::log_warn("code_preview",
                                &format!("city snapshot export rejected code={code}"));
                            Err("code_game_snapshot_invalid".into())
                        }
                    }
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

    /// S-0 Top5-②（V3_S0_CI_AUDIT §2 P1-2a）：preview 实例配对守卫——请求携带的
    /// previewId 必须与调用窗口 label 配对，跨窗口伪造一律 preview_instance_mismatch。
    #[test]
    fn preview_command_rejects_window_label_and_preview_id_mismatch() {
        let home = home("mismatch");
        let request = json!({"previewId":"preview-b","command":"plugin_request",
            "args":{"request":{"requestId":"forged-1","method":"city.time.read","payload":{"cityId":"city:one"}}}});
        // 窗口 A 提交 previewId=B 的请求：拒绝（隔离 Spec 的核心防线）。
        assert_eq!(handle_preview_request(&home, "code-preview-a", &request).unwrap_err(), "preview_instance_mismatch");
        // 合法配对（label = "code-preview-" + previewId，即 code-preview-preview-b）
        // 不再报该错误，且请求真正到达宿主（预览时钟读面返回结构化结果）。
        let paired = handle_preview_request(&home, "code-preview-preview-b", &request).unwrap();
        assert_eq!(paired["ok"], true, "{paired}");
        assert_eq!(paired["requestId"], "forged-1");
        // 缺 previewId / 非字符串 → 形状拒绝。
        assert_eq!(handle_preview_request(&home, "code-preview-a", &json!({"command":"plugin_request"})).unwrap_err(), "preview_request_invalid");
        assert_eq!(handle_preview_request(&home, "code-preview-preview-b", &json!({"previewId":7,"command":"plugin_request"})).unwrap_err(), "preview_request_invalid");
        std::fs::remove_dir_all(home).ok();
    }

    /// S-0 Top5-②（V3_S0_CI_AUDIT §2 P1-2b）：三层 allowlist 守卫矩阵——顶层
    /// command、plugin_request 的 method、plugin_message 的 type 全部窄名单，
    /// 伪造一律显式拒绝；正常路径回显 requestId 的信封形状保持不变。
    #[test]
    fn preview_plugin_surface_is_allowlisted_per_command_type_and_method() {
        let home = home("allowlist");
        // 顶层 command 不在名单 → preview_command_unavailable。
        let unknown_command = json!({"previewId":"preview-a","command":"other","args":{}});
        assert_eq!(handle_preview_request(&home, "code-preview-preview-a", &unknown_command).unwrap_err(), "preview_command_unavailable");
        // method 不在名单 → ok:false 信封携带 preview_method_unavailable（伪造 story 写入）。
        let forged_method = json!({"previewId":"preview-a","command":"plugin_request",
            "args":{"request":{"requestId":"forged-2","method":"city.story.commit","payload":{"runId":"game-run-1"}}}});
        let denied = handle_preview_request(&home, "code-preview-preview-a", &forged_method).unwrap();
        assert_eq!(denied["ok"], false, "{denied}");
        assert_eq!(denied["error"]["code"], "preview_method_unavailable");
        assert_eq!(denied["requestId"], "forged-2");
        // plugin_message type 不在名单 → preview_message_unavailable。
        let forged_message = json!({"previewId":"preview-a","command":"plugin_message",
            "args":{"message":{"type":"code-game.debug","state":{}}}});
        assert_eq!(handle_preview_request(&home, "code-preview-preview-a", &forged_message).unwrap_err(), "preview_message_unavailable");
        // 正常路径：plugin_request（city.time.read）回显 requestId 且信封形如宿主约定；
        // plugin_message（plugin.performance）直接 ok:true。
        let normal = handle_preview_request(&home, "code-preview-preview-a", &json!({"previewId":"preview-a","command":"plugin_request",
            "args":{"request":{"requestId":"normal-1","method":"city.time.read","payload":{"cityId":"city:one"}}}})).unwrap();
        assert_eq!(normal["version"], 1, "{normal}");
        assert_eq!(normal["ok"], true);
        assert_eq!(normal["requestId"], "normal-1");
        assert_eq!(normal["result"]["cityId"], "city:one");
        let performance = handle_preview_request(&home, "code-preview-preview-a", &json!({"previewId":"preview-a","command":"plugin_message",
            "args":{"message":{"type":"plugin.performance"}}})).unwrap();
        assert_eq!(performance["ok"], true);
        std::fs::remove_dir_all(home).ok();
    }

    /// PR05：city.snapshot.export 窄面——配对预览上报真实 City 快照，宿主三重绑定
    /// 身份后落盘（broker 服务臂据此回执）；未配对窗口进不了消息面，装载别的
    /// City 的窗口按源绑定拒绝（与 code-game.state 同款信封级稳定码）。
    #[test]
    fn city_snapshot_export_flows_through_the_preview_message_surface() {
        let home = home("snapshot-export");
        let db = crate::creator_store::database(&home).unwrap();
        db.execute("INSERT INTO creator_cities(city_id,revision,document_json,created_at_ms,updated_at_ms) VALUES('city:pr05',7,'{}',1,1)", []).unwrap();
        let request_directory = home.join("state/creator/code-games/previews/preview-snap-win");
        std::fs::create_dir_all(&request_directory).unwrap();
        std::fs::write(request_directory.join("request.json"), serde_json::to_vec(&json!({"previewId":"preview-snap-win","buildId":"a","source":{"cityId":"city:pr05","cityRevision":7}})).unwrap()).unwrap();
        let digest = crate::creator_store::bytes_digest(b"city-pr05-world");
        let snapshot = json!({"schemaVersion":4,"header":{"schemaVersion":1,"cityId":"city:pr05","cityRevision":7,"snapshotDigest":digest,"seed":7},"terrain":{"format":"heightfield-tiles-v1","tiles":[]}}).to_string();
        let accepted = handle_preview_request(&home, "code-preview-preview-snap-win", &json!({"previewId":"preview-snap-win","command":"plugin_message",
            "args":{"message":{"type":"city.snapshot.export","snapshotJson":snapshot}}})).unwrap();
        assert_eq!(accepted["ok"], true);
        assert_eq!(accepted["receipt"]["snapshotDigest"], json!(digest));
        assert!(home.join("state/creator/code-games/city-snapshots/city:pr05-7.json").exists());
        // label ≠ previewId 的伪造窗口根本进不了消息面。
        let forged = handle_preview_request(&home, "code-preview-preview-other", &json!({"previewId":"preview-snap-win","command":"plugin_message",
            "args":{"message":{"type":"city.snapshot.export","snapshotJson":snapshot}}}));
        assert_eq!(forged.unwrap_err(), "preview_instance_mismatch");
        // 装载别的 City 的窗口上报这座 City 的快照 → 源绑定拒绝。
        let other_directory = home.join("state/creator/code-games/previews/preview-snap-win2");
        std::fs::create_dir_all(&other_directory).unwrap();
        std::fs::write(other_directory.join("request.json"), serde_json::to_vec(&json!({"previewId":"preview-snap-win2","buildId":"a","source":{"cityId":"city:other","cityRevision":7}})).unwrap()).unwrap();
        let mismatched = handle_preview_request(&home, "code-preview-preview-snap-win2", &json!({"previewId":"preview-snap-win2","command":"plugin_message",
            "args":{"message":{"type":"city.snapshot.export","snapshotJson":snapshot}}}));
        assert_eq!(mismatched.unwrap_err(), "code_game_snapshot_invalid");
        std::fs::remove_dir_all(home).ok();
    }
}
