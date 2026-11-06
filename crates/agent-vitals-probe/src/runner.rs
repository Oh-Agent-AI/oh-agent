//! 探针 runner：job 生命周期 + consent/预算守卫 + 成对交错调度。
//!
//! P1（WORKBENCH_TEST_TAB_SPEC §11）：L0 身份探针、三级判定（domain::probe）、
//! job 单向状态机（data::probe）。预算 P1 是**探针次数硬上限**（budget_max_probes）
//! ——货币估算列刻意 NULL（价卡接线属 P2；不编造金额是不编数纪律的正向应用）。
//! 成对模式按 A/B/A/B 交错执行，消除时段性服务端波动。

use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::probe::{
    self, ProbeRoute, ProbeRun,
};
use agent_vitals_domain::probe::{combine_l0_paired, evaluate_l0_single};
use rusqlite::Connection;
use serde_json::{Value, json};

use crate::credentials::resolve as resolve_credential;
use crate::l0::{ProbeError, run_identity_probe};

pub const RULE_VERSION: &str = "l0-identity-v1";
pub const BUILTIN_SUITE_ID: &str = "l0-identity";
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);

/// P1 预算语义：探针次数硬上限（超过 → budget_stopped 终态并停止发起新探针；
/// 已完成的探针照常入库）。
pub const DEFAULT_MAX_PROBES: usize = 12;

#[derive(Debug)]
pub struct RunConfig {
    pub route_a: String,
    pub route_b: Option<String>,
    pub repeats: usize,
    pub max_probes: usize,
    /// claude 可执行文件；None = $AGENT_VITALS_CLAUDE_BIN 或 PATH 上的 `claude`。
    pub claude_bin: Option<PathBuf>,
}

/// resolve claude binary：env 覆盖 → PATH。
pub fn resolve_claude_bin(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        if path.exists() {
            return Ok(path.to_path_buf());
        }
        return Err(format!("claude binary not found at {}", path.display()));
    }
    if let Some(path) = std::env::var_os("AGENT_VITALS_CLAUDE_BIN") {
        let path = PathBuf::from(path);
        if !path.exists() {
            return Err(format!(
                "$AGENT_VITALS_CLAUDE_BIN points to a missing path: {}",
                path.display()
            ));
        }
        return Ok(path);
    }
    Ok(PathBuf::from("claude"))
}

fn ensure_builtin_suite(conn: &Connection, now_ms: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO probe_suites(suite_id, version, kind, manifest_ref, manifest_sha256, rule_version, created_at_ms)
         VALUES (?1, '1', 'l0_identity', 'builtin://l0-identity', ?2, ?3, ?4)",
        rusqlite::params![
            BUILTIN_SUITE_ID,
            // builtin 套件没有 manifest 文件，此列存的是规则指纹（fnv1a64）
            // 而非真 sha256——真 manifest 接入（L1 题库）时换算法定义并迁移。
            agent_vitals_domain::source_identity::fnv1a64_hex(RULE_VERSION.as_bytes()),
            RULE_VERSION,
            now_ms
        ],
    )
    .map_err(|error| format!("ensure builtin suite: {error}"))?;
    Ok(())
}

fn load_route(conn: &Connection, route_id: &str, now_ms: i64) -> Result<ProbeRoute, String> {
    let Some(route) = probe::get_route(conn, route_id).map_err(|e| e.to_string())? else {
        return Err(format!("route '{route_id}' not found (see `probe routes-add`)"));
    };
    if route.consent_granted_at_ms.is_none() {
        // 政策：consent 为 NULL 的路线不得发起——错误里给动作，不给绕过。
        return Err(format!(
            "route '{}' has no consent — run `agent-vitals probe consent --route-id {route_id}` first (发起即代表请求将经过该路线的中转商)",
            route.label
        ));
    }
    let _ = now_ms;
    Ok(route)
}

/// 执行一次完整 run。返回 run_id（调用方用于 status/report）。
#[allow(clippy::too_many_arguments)]
pub fn execute(db: &AuthorityDb, config: &RunConfig, now_ms: i64) -> Result<String, String> {
    if config.repeats == 0 {
        return Err("--repeats must be >= 1".to_string());
    }
    let conn = db.conn();
    ensure_builtin_suite(conn, now_ms)?;
    let route_a = load_route(conn, &config.route_a, now_ms)?;
    let route_b = match &config.route_b {
        Some(id) => Some(load_route(conn, id, now_ms)?),
        None => None,
    };
    let claude_bin = resolve_claude_bin(config.claude_bin.as_deref())?;

    let run_id = format!("probe:{}", agent_vitals_domain::source_identity::fnv1a64_hex(
        format!("{}|{:?}|{}|{}", config.route_a, config.route_b, config.repeats, now_ms).as_bytes(),
    ));
    let run = ProbeRun {
        run_id: run_id.clone(),
        mode: if route_b.is_some() { "paired" } else { "single" }.to_string(),
        route_a_id: route_a.route_id.clone(),
        route_b_id: route_b.as_ref().map(|route| route.route_id.clone()),
        suite_id: BUILTIN_SUITE_ID.to_string(),
        n_repeats: config.repeats as i64,
        status: "queued".to_string(),
        currency: None,          // P1：货币估算待价卡接线（P2），不编造
        cost_budget_minor: None, // 同上
        cost_estimated_minor: None,
        started_at_ms: None,
        finished_at_ms: None,
    };
    probe::create_run(conn, &run, now_ms).map_err(|e| e.to_string())?;
    if !probe::transition_run(conn, &run_id, "queued", "running", now_ms).map_err(|e| e.to_string())? {
        return Err(format!("run {run_id} could not start (state race)"));
    }

    // 成对交错：A/B/A/B…（单路就是 A 重复）。
    let mut schedule: Vec<(&ProbeRoute, i64)> = Vec::new();
    for repeat in 0..config.repeats as i64 {
        schedule.push((&route_a, repeat));
        if let Some(route_b) = route_b.as_ref() {
            schedule.push((route_b, repeat));
        }
    }

    let mut reports: Vec<Value> = Vec::new();
    let mut launched = 0usize;
    let mut failures = 0usize;
    for (route, repeat) in schedule {
        if launched >= config.max_probes {
            probe::transition_run(conn, &run_id, "running", "budget_stopped", now_ms)
                .map_err(|e| e.to_string())?;
            break;
        }
        launched += 1;
        /// 失败载荷：消息 + 是否超时（避免对错误文本做字符串匹配分类）。
        struct ProbeFailure(String, bool);
        let outcome_result = route
            .credential_ref
            .as_deref()
            .map(|reference| {
                resolve_credential(reference, &route.harness_kind)
                    .map_err(|message| ProbeFailure(message, false))
            })
            .unwrap_or_else(|| {
                // 无 credential_ref = 官方直连（走 claude CLI 自身登录态）。
                Ok(crate::credentials::LaunchCredential {
                    base_url: route.endpoint_base_url.clone(),
                    auth_token: String::new(),
                })
            })
            .and_then(|credential| {
                let effective_base = credential
                    .base_url
                    .as_deref()
                    .or(route.endpoint_base_url.as_deref());
                // 有效端点入混杂记录（验收 finding 4）：官方直连臂的有效端点
                // 必须是 None（env 已摘干净），中转臂是显式 URL——对照的可信
                // 度依赖这个字段可审计。
                let token: Option<&str> = if route.credential_ref.is_some() {
                    if credential.auth_token.is_empty() {
                        None
                    } else {
                        Some(credential.auth_token.as_str())
                    }
                } else {
                    None // 官方直连：不注入 token，CLI 用自身登录态
                };
                // 守卫先于 spawn（复审 finding B）：credential_ref 指向的变量
                // set-but-empty 时不得真的发起未认证请求再事后记错误。
                let result = if route.credential_ref.is_some() && token.is_none() {
                    Err(ProbeFailure(
                        ProbeError::Spawn("empty credential token".to_string()).to_string(),
                        false,
                    ))
                } else {
                    run_identity_probe(
                        &claude_bin,
                        effective_base,
                        token,
                        &route.model_requested,
                        PROBE_TIMEOUT,
                    )
                    .map_err(|error| {
                        ProbeFailure(error.to_string(), matches!(error, ProbeError::Timeout))
                    })
                };
                result.map(|outcome| (outcome, effective_base.map(str::to_string)))
                // credential（含 token 借用）在此闭包结束处统一 Drop——即用即弃。
            });
        let result_id = format!("{run_id}:{}:{repeat}", route.route_id);
        match outcome_result {
            Ok((outcome, effective_base)) => {
                let mut single = evaluate_l0_single(&outcome.observation, RULE_VERSION);
                single["route"] = json!(route.route_id);
                single["repeat"] = json!(repeat);
                single["wall_ms"] = json!(outcome.wall_ms);
                // probe 会话 → sessions 行的关联是 P2 接线（探针会话随正常 sync
                // 入库后由 native id 反查）；P1 落 NULL 防 FK 违例，native id 进
                // evidence 保可溯。
                single["native_session_id"] = json!(outcome.observation.native_session_id);
                single["effective_base_url_present"] = json!(effective_base.is_some());
                if let Some(base) = &effective_base {
                    single["confounders"] = json!([{
                        "kind": "route_endpoint",
                        "base_url_harness": base.split('/').find(|s| s.contains('.')).unwrap_or("unparsed"),
                        "note": "中转臂的显式端点（官方直连臂此字段缺席 = env 已摘干净）",
                    }]);
                }
                // 网关拒绝（如中转 402）时 claude 以退出码 0 写合成错误消息——
                // 这不是成功探针：outcome 记 error，摘要进 evidence（resolved 已
                // 被 l0 解析层按缺席处理，不会产 confirmed_mismatch 误报）。
                let outcome_label = if outcome.api_error_excerpt.is_some() { "error" } else { "pass" };
                if let Some(excerpt) = &outcome.api_error_excerpt {
                    single["api_error_excerpt"] = json!(excerpt);
                }
                reports.push(single.clone());
                probe::insert_result(
                    conn, &result_id, &run_id, &route.route_id, "identity-echo", repeat, outcome_label,
                    &route.model_requested, outcome.observation.resolved_model.as_deref(),
                    outcome.observation.usage, &single.to_string(),
                    None,
                )
                .map_err(|e| e.to_string())?;
            }
            Err(ProbeFailure(message, timed_out)) => {
                failures += 1;
                let evidence = json!({
                    "route": route.route_id, "repeat": repeat,
                    "probe_error": message,
                });
                probe::insert_result(
                    conn, &result_id, &run_id, &route.route_id, "identity-echo", repeat,
                    if timed_out { "timeout" } else { "error" },
                    &route.model_requested, None, None, &evidence.to_string(), None,
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    // 单路与成对同一合并规则（worst-of）——首报告取样是序依赖 bug（验收
    // finding 3：探针 1 匹配 + 探针 2 硬换模型曾被静默吸收）。零报告也走
    // 同一函数（空集 → underpowered），不手搓兜底 JSON。
    let combined = combine_l0_paired(&reports, RULE_VERSION);
    probe::put_verdict(
        conn,
        &format!("{run_id}:verdict"),
        &run_id,
        combined.get("verdict").and_then(Value::as_str).unwrap_or("underpowered"),
        &combined.get("statistic_json").unwrap_or(&Value::Null).to_string(),
        &combined.get("evidence_chain_json").unwrap_or(&Value::Null).to_string(),
        &combined.get("confounders_json").unwrap_or(&Value::Null).to_string(),
        RULE_VERSION,
        now_ms,
    )
    .map_err(|e| e.to_string())?;

    // 终态：全部失败 → failed；budget_stopped 已迁移则不再覆盖（状态机单向）。
    let current = probe::get_run(conn, &run_id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("run {run_id} vanished"))?;
    if current.status == "running" {
        let terminal = if failures == launched && launched > 0 { "failed" } else { "completed" };
        probe::transition_run(conn, &run_id, "running", terminal, now_ms)
            .map_err(|e| e.to_string())?;
    }
    Ok(run_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::l0::STREAM;

    fn test_db(tag: &str) -> (AuthorityDb, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "av-probe-runner-{}-{tag}.sqlite3",
            std::process::id()
        ));
        let db = AuthorityDb::open(&path, 1).unwrap();
        (db, path)
    }

    fn cleanup(path: &std::path::PathBuf) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }

    fn fake_claude() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("av-runner-claude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude");
        std::fs::write(&script, format!("#!/bin/sh\ncat <<'EOF'\n{STREAM}EOF\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
        }
        script
    }

    fn seed_route(conn: &Connection, route_id: &str, model: &str, consent: bool) {
        probe::put_route(
            conn,
            &ProbeRoute {
                route_id: route_id.to_string(),
                label: format!("label-{route_id}"),
                harness_kind: "claude-code".to_string(),
                endpoint_base_url: None,
                credential_ref: None, // 无引用 = 官方直连（CLI 登录态）——测试不碰真凭据
                model_requested: model.to_string(),
                consent_granted_at_ms: consent.then_some(1),
            },
            1,
        )
        .unwrap();
    }

    #[test]
    fn run_without_consent_is_refused_with_actionable_error() {
        let (db, path) = test_db("consent");
        seed_route(db.conn(), "rt1", "claude-sonnet-5", false);
        let error = execute(
            &db,
            &RunConfig {
                route_a: "rt1".into(), route_b: None, repeats: 1,
                max_probes: 4, claude_bin: Some(fake_claude()),
            },
            100,
        )
        .expect_err("无 consent 必须拒绝");
        assert!(error.contains("probe consent --route-id rt1"), "错误必须给动作：{error}");
        drop(db);
        cleanup(&path);
    }

    #[test]
    fn single_run_end_to_end_with_fake_claude() {
        let (db, path) = test_db("single");
        let conn = db.conn();
        seed_route(conn, "rt1", "claude-sonnet-5", true);
        let run_id = execute(
            &db,
            &RunConfig {
                route_a: "rt1".into(), route_b: None, repeats: 2,
                max_probes: 4, claude_bin: Some(fake_claude()),
            },
            100,
        )
        .unwrap();
        let report = probe::run_report(conn, &run_id).unwrap().unwrap();
        assert_eq!(report["run"]["status"], json!("completed"));
        assert_eq!(report["results"].as_array().unwrap().len(), 2);
        assert_eq!(report["verdict"]["verdict"], json!("no_signal"));
        assert_eq!(report["verdict"]["rule_version"], json!(RULE_VERSION));
        // requested 被 runner 显式覆盖为路线档案值（解析器占位不生效）。
        assert_eq!(report["results"][0]["requested_model"], json!("claude-sonnet-5"));
        drop(db);
        cleanup(&path);
    }

    #[test]
    fn paired_run_interleaves_and_budget_stops() {
        let (db, path) = test_db("paired");
        let conn = db.conn();
        seed_route(conn, "a", "claude-sonnet-5", true);
        seed_route(conn, "b", "claude-sonnet-5", true);
        // repeats=3 → 计划 6 次探针；max=2 → 第 3 次起 budget_stopped。
        let run_id = execute(
            &db,
            &RunConfig {
                route_a: "a".into(), route_b: Some("b".into()), repeats: 3,
                max_probes: 2, claude_bin: Some(fake_claude()),
            },
            100,
        )
        .unwrap();
        let report = probe::run_report(conn, &run_id).unwrap().unwrap();
        assert_eq!(report["run"]["status"], json!("budget_stopped"), "预算终态不得被 completed 覆盖");
        assert_eq!(report["results"].as_array().unwrap().len(), 2, "只发起了 2 次");
        // 交错顺序：第 1 次 route a、第 2 次 route b。
        assert_eq!(report["results"][0]["route_id"], json!("a"));
        assert_eq!(report["results"][1]["route_id"], json!("b"));
        drop(db);
        cleanup(&path);
    }
}
