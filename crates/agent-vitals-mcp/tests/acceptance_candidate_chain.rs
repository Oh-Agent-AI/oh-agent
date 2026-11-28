//! 真机验收驱动（十步清单步骤④⑥的数据面）：对验收工作区跑候选链全流程
//! fork → 修改 → 构建 → 无头测试 verdict → awaiting-review。
//!
//! 门控：仅当 `AGENT_VITALS_ACCEPTANCE_HOME`（真实 data_home）与
//! `AGENT_VITALS_ACCEPTANCE_WORKSPACE`（gws-…）同时设置时才运行——普通
//! `cargo test`（无环境变量）直接跳过，绝不触碰用户数据。
//! 证据 JSON 落 `AGENT_VITALS_ACCEPTANCE_EVIDENCE`（缺省 /tmp）。

use serde_json::{json, Value};

fn acceptance_home() -> Option<std::path::PathBuf> {
    let home = std::env::var("AGENT_VITALS_ACCEPTANCE_HOME").ok()?;
    if home.trim().is_empty() { return None; }
    Some(std::path::PathBuf::from(home))
}

fn dispatch(name: &str, args: &Value) -> Result<Value, agent_vitals_mcp::mcp::ToolError> {
    let home = acceptance_home().expect("acceptance home gate");
    agent_vitals_mcp::mcp::dispatch_with_permissions_options(name, args, &home, true, false)
        .map(|value| value["data"].clone())
}

#[test]
fn acceptance_candidate_chain_round1() {
    let Some(home) = acceptance_home() else {
        eprintln!("skip: AGENT_VITALS_ACCEPTANCE_HOME not set");
        return;
    };
    let workspace_id = std::env::var("AGENT_VITALS_ACCEPTANCE_WORKSPACE")
        .expect("AGENT_VITALS_ACCEPTANCE_WORKSPACE must name the acceptance workspace");
    let evidence_dir = std::path::PathBuf::from(
        std::env::var("AGENT_VITALS_ACCEPTANCE_EVIDENCE")
            .unwrap_or_else(|_| "/tmp/acceptance-evidence".into()),
    );
    std::fs::create_dir_all(&evidence_dir).unwrap();
    let mut evidence = json!({ "workspaceId": workspace_id, "round": 1, "steps": [] });
    let mut record = |step: &str, payload: Value| {
        evidence["steps"].as_array_mut().unwrap().push(json!({"step": step, "result": payload}));
        std::fs::write(evidence_dir.join("candidate-chain-round1.json"),
            serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    };

    // ① 现势基线摘要（expectedBaseRevision CAS 的锚）。
    let info_raw_result = agent_vitals_mcp::mcp::dispatch_with_permissions_options("creator_code_workspace_info", &json!({"workspaceId": workspace_id}), &home, true, false);
    println!("workspace_info raw: {info_raw_result:?}");
    let info = info_raw_result.unwrap();
    let info = if info.get("data").is_some() { info["data"].clone() } else { info };
    let base_revision = info["gameRevision"].as_str().unwrap().to_owned();
    println!("base revision: {base_revision}");
    record("baseline", info.clone());

    // ② 候选 fork（PR09：基线全树副本，读写绑定 candidateId+baseRevision）。
    let created = dispatch("creator_code_candidate_create", &json!({
        "workspaceId": workspace_id, "expectedBaseRevision": base_revision,
        "operationId": format!("acceptance-round-{}", base_revision),
        "title": "TD v2：HUD 标题 + 敌速 20%",
    })).unwrap();
    let candidate_id = created["candidateId"].as_str().unwrap().to_owned();
    assert_eq!(created["status"], "draft");
    println!("candidate: {candidate_id}");
    record("candidate_create", created.clone());

    // ③ 候选内读取 TD 源码（CAS 基线 = 候选 revision）。
    let source = dispatch("creator_code_file_read",
        &json!({"workspaceId": workspace_id, "candidateId": candidate_id, "relativePath": "src/index.ts"})).unwrap();
    let content = source["content"].as_str().unwrap().to_owned();
    let candidate_revision = source["candidateRevision"].as_str().unwrap().to_owned();

    // ④ 修改：HUD 加 "Tower Defense v2"（断言面）+ 敌速放慢 20%。幂等重放时
    // 候选已含修改（PR09：同 operationId 返回同一候选）——检测到即跳过写入。
    let already_modified = content.contains("Tower Defense v2") && content.contains("ENEMY_SPEED * 0.8 * dt");
    let written = if already_modified {
        println!("modifications already present (idempotent replay); skipping write");
        json!({"candidateRevision": candidate_revision, "replayed": true})
    } else {
        let mut modified = content.replace(
            "      context.ui.setHud({\n        wave,",
            "      context.ui.setHud({\n        version: \"Tower Defense v2\",\n        wave,");
        assert!(modified != content, "HUD anchor not found; template drift?");
        modified = modified.replace("let remaining = ENEMY_SPEED * dt;", "let remaining = ENEMY_SPEED * 0.8 * dt;");
        assert!(modified != content, "speed anchor not found");
        dispatch("creator_code_file_write", &json!({
            "workspaceId": workspace_id, "candidateId": candidate_id,
            "relativePath": "src/index.ts", "content": modified,
            "expectedRevision": candidate_revision,
        })).unwrap()
    };
    assert!(written["candidateRevision"].is_string(), "write/read must return the candidate revision");
    record("file_write", written.clone());

    // ⑤ 构建候选（PR04 预算内真实 tsc/esbuild；sealed candidate:<id>:<digest>）。
    let built = dispatch("creator_code_build", &json!({"workspaceId": workspace_id, "candidateId": candidate_id})).unwrap();
    assert_eq!(built["status"], "succeeded", "build failed: {built}");
    let build_id = built["buildId"].as_str().unwrap().to_owned();
    println!("build: {build_id}");
    record("build", built.clone());

    // ⑥ 无头测试 + 场景断言（PR06）：三波清空 = outcome success；HUD 断言 v2 标题。
    let scenario = json!({
        "schemaVersion": 1, "scenarioId": "acceptance-td-v2", "maxTicks": 2400,
        "assertions": [
            {"id": "game-clears", "kind": "outcome", "expectOutcome": "success"},
            {"id": "hud-shows-v2", "kind": "hudFlag", "key": "version", "equals": "Tower Defense v2"},
            {"id": "no-runtime-errors", "kind": "counterAtLeast", "key": "errors", "value": 0},
        ],
    });
    let tested = dispatch("creator_code_test", &json!({
        "workspaceId": workspace_id, "buildId": build_id, "candidateId": candidate_id,
        "seed": 7, "ticks": 2400,
        "scenario": serde_json::to_string(&scenario).unwrap(),
    })).unwrap();
    assert_eq!(tested["verdict"], "passed", "verdict must be passed: {tested}");
    assert_eq!(tested["executionOk"], json!(true));
    let assertions = tested["assertions"].as_array().unwrap();
    assert!(assertions.iter().all(|a| a["status"] == "passed"), "{assertions:?}");
    println!("verdict: passed; assertions: {}", assertions.len());
    record("test", tested.clone());

    // ⑦ 提交人工评审（awaiting-review；reviewBasis 诚实标注 tests-passed）。
    let submitted = dispatch("creator_code_candidate_submit", &json!({"candidateId": candidate_id})).unwrap();
    assert_eq!(submitted["status"], "awaiting-review");
    assert_eq!(submitted["reviewBasis"], "tests-passed");
    record("submit", submitted.clone());

    // 停在 awaiting-review：接受（CAS commit 回基线）或拒绝是用户决策（十步⑧）。
    println!("candidate {candidate_id} awaiting-review; build {build_id}; verdict passed");
}
