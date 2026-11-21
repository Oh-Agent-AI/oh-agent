use serde_json::{json, Value};
use std::path::PathBuf;

/// Generic creator dispatch runner for acceptance journeys:
/// `creator_call <data_home> <method> [payload_json] [--session]`
/// `--session` routes through the creator_session/task dispatch face instead of
/// the creator studio face. Prints the response JSON or the ToolError code.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: creator_call <data_home> <method> [payload_json] [--session]");
        std::process::exit(2);
    }
    let home = PathBuf::from(&args[1]);
    let method = args[2].clone();
    let session_face = args.iter().any(|a| a == "--session");
    let payload: Value = args
        .iter()
        .skip(3)
        .find(|a| !a.starts_with("--"))
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| json!({}));
    let result = if session_face {
        if method.starts_with("creator.task") || method.starts_with("creator_task") {
            let dotted = match method.as_str() {
        "creator_task_claim" => "creator.task.claim",
        "creator_task_list_open" => "creator.task.list_open",
        "creator_task_submit_result" => "creator.task.submit_result",
        other => other,
    };
    agent_vitals_mcp::mcp::creator_session::task_dispatch(&home, dotted, &payload)
        } else {
            agent_vitals_mcp::mcp::creator_session::session_dispatch(&home, &method, &payload)
        }
    } else {
        agent_vitals_mcp::mcp::dispatch_with_permissions(&method, &payload, &home, true)
    };
    match result {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default()),
        Err(error) => {
            eprintln!("error {} {}", error.code, error.message);
            std::process::exit(1);
        }
    }
}
