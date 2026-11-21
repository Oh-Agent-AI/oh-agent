use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: creator_codex_smoke <data_home> <projectId> <expectedRevision> [goal]");
        std::process::exit(2);
    }
    let home = PathBuf::from(&args[1]);
    let project_id = &args[2];
    let expected_revision: u64 = args[3].parse().expect("expectedRevision must be an integer");
    let goal = args.get(4).map(String::as_str).unwrap_or("Review the current project and propose one small improvement.");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let operation = |kind: &str| format!("smoke-{kind}-{now}");
    let result = (|| -> Result<Value, String> {
        let session = agent_vitals_mcp::mcp::creator_session::session_dispatch(&home, "creator.session.open", &json!({"agentId":"creator-smoke","projectId":project_id})).map_err(|error| error.code.to_owned())?;
        let session_id = session["sessionId"].as_str().ok_or("sessionId missing")?;
        let created = agent_vitals_mcp::mcp::creator_session::task_dispatch(&home, "creator.task.create", &json!({
            "sessionId":session_id,"goal":goal,"humanRequest":goal,
            "artifact":{"kind":"creator-project","projectId":project_id,"expectedRevision":expected_revision},
            "acceptanceCriteria":[
                {"criterionId":"agent-preview","description":"Host generated Preview required","requiredEvidenceKind":"preview"},
                {"criterionId":"manual-review","description":"Human acceptance required","requiredEvidenceKind":"human-note"}
            ],"operationId":operation("goal"),
        })).map_err(|error| error.code.to_owned())?;
        let task_id = created["taskId"].as_str().ok_or("taskId missing")?;
        agent_vitals_mcp::mcp::creator_session::task_dispatch(&home, "creator.task.plan.submit", &json!({
            "taskId":task_id,"expectedPlanRevision":1,"expectedArtifactRevision":expected_revision,
            "steps":[
                {"stepId":"review-goal","title":"Review goal and scope","kind":"analysis"},
                {"stepId":"validate-preview","title":"Generate a real Preview","kind":"validation"},
                {"stepId":"human-review","title":"Human review","kind":"review"}
            ],"operationId":operation("plan"),
        })).map_err(|error| error.code.to_owned())?;
        agent_vitals_mcp::mcp::creator_session::task_dispatch(&home, "creator.task.plan.approve", &json!({
            "taskId":task_id,"planRevision":1,"expectedArtifactRevision":expected_revision,"operationId":operation("approve"),
        })).map_err(|error| error.code.to_owned())?;
        agent_vitals_mcp::mcp::creator_session::task_dispatch(&home, "creator.task.execute", &json!({
            "taskId":task_id,"expectedPlanRevision":1,"expectedArtifactRevision":expected_revision,
            "operationId":operation("execute"),"timeoutMs":120_000,
        })).map_err(|error| error.code.to_owned())
    })();
    match result {
        Ok(value) => println!("{}", json!({"phase":value["phase"],"taskId":value["taskId"],"proposedChangeSetId":value["proposedChangeSetId"]})),
        Err(code) => {
            eprintln!("smoke failed: {code}");
            std::process::exit(1);
        }
    }
}
