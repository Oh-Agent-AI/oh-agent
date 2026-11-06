//! Codex 单会话审计组合 —— `codex-session` 子命令的数据层。
//!
//! `codex-cost` 在折叠时把会话身份立刻丢弃（聚合进 `by_hour_model`/`by_model`），
//! `codex-evidence` 逐 rollout 文件给出处但不含成本。本模块把两半拼回一个
//! **逻辑 session**（按 `session_id` 分组，跨文件 resume 合并）：
//!
//! - **逐 session 成本**：逐文件 `codex_fold_file` → `codex_merge_folds` →
//!   `codex_cost_report`（`want_hours` 给出小时轴时间线）。与 `codex-cost`
//!   完全同一条折叠→计价路径，只是把文件集限定为该 session 的。
//! - **出处覆盖并集**：把该 session 所有文件的 items concat 成一条，交
//!   `build_codex_evidence` 一次折叠——`derive_coverage` 对全部 item 计数，
//!   任一文件覆盖即覆盖，并集 by construction（无需手工并）。
//! - **会话元数据**（model / cli_version / history_mode / workspace_roots）取
//!   路径序最后一个文件（同 per-file 内 latest-wins 的「当前状态」惯例——
//!   resume 会话的续写文件落在更新路径里）。
//!
//! **时间跨度无现成字段**：Codex rollout 只有逐行顶层 `timestamp`（ISO UTC），
//! 本模块用每文件首/末行时间戳界定，跨文件取 min/max。
//!
//! 全是既有纯函数的组合，**无新规则**；Rust 与 Python 镜像
//! `scripts/agent_vitals/agent/codex_session_audit.py` 逐字节对齐，由
//! `tests/test_cli_matrix.py::both()` 差分看守。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::cost::{codex_cost_report, load_codex_pricing};
use super::{codex_rollout_files, read_codex_session_log, read_session_index};
use crate::codex_evidence::{build_codex_evidence, codex_evidence_json, CodexEvidence};
use crate::codex_usage::{codex_hour_of, codex_merge_folds};

/// 一份 rollout 文件对 `codex-session` 有用的全部信息。degraded 文件（不可读/
/// 非 JSON/空）→ items 空 + 时间戳 None，但**仍按文件名兜底的 session_id
/// 参与分组**（同 `codex-evidence` 的 §14.4 back-fill——session 永远可指认，
/// 绝不把缺席当成 0 条真数据）。
struct FileInfo {
    path: PathBuf,
    session_id: String,
    history_mode: Option<String>,
    cli_version: Option<String>,
    model: Option<String>,
    workspace_roots: Vec<String>,
    first: Option<String>,
    last: Option<String>,
    items: Vec<Value>,
}

fn item_ts(item: &Value) -> Option<String> {
    item.get("timestamp").and_then(|v| v.as_str()).map(str::to_owned)
}

/// 最后一个 token_count 事件的 `info.model_context_window`（事件序即时间序，最后
/// 看见的赢——同 plan 的「最后看见的赢」惯例）。Codex 无逐 turn 上下文峰值，上下文
/// 窗口是报告里能诚实给出的「模型上下文上限」。与 Python 侧同序遍历逐字节对齐。
fn context_window_of(items: &[Value]) -> Option<i64> {
    let mut found = None;
    for item in items {
        let payload = item.get("payload");
        let ptype = payload
            .and_then(|p| p.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if ptype != "token_count" {
            continue;
        }
        if let Some(info) = payload.and_then(|p| p.get("info")).and_then(|v| v.as_object()) {
            if let Some(w) = info.get("model_context_window").and_then(|v| v.as_i64()) {
                found = Some(w);
            }
        }
    }
    found
}

/// 薄封装 core 共享求值器（v0.6 harness-contract spec §7-C，M1）——三份
/// dispatcher 的公共部分塌缩进 `canonical_audit::audit_projection`。Codex
/// 行上没有 `degraded_rules`（`harness_capability::HARNESSES`），"codex" 走 no-op
/// 分支，与塌缩前从不调用 degrade 的行为等价。
fn audit_projection(evidence: &CodexEvidence) -> Value {
    agent_vitals_domain::canonical_audit::audit_projection(&evidence.canonical, "codex")
}

fn quota_trajectory_of(items: &[Value]) -> Value {
    let mut samples: Vec<(f64, Option<String>, Option<i64>)> = Vec::new();
    for item in items {
        let payload = item.get("payload");
        if payload.and_then(|p| p.get("type")).and_then(|v| v.as_str()) != Some("token_count") { continue; }
        let primary = payload.and_then(|p| p.get("rate_limits")).and_then(|v| v.get("primary"));
        let Some(used) = primary.and_then(|p| p.get("used_percent")).and_then(|v| v.as_f64()) else { continue; };
        samples.push((used, item_ts(item), primary.and_then(|p| p.get("resets_at")).and_then(|v| v.as_i64())));
    }
    let Some(first) = samples.first() else { return Value::Null; };
    let last = samples.last().expect("non-empty");
    let (comparable, reason) = if first.2 != last.2 { (false, Some("reset_window_changed")) }
        else if last.0 < first.0 { (false, Some("used_percent_decreased")) } else { (true, None) };
    json!({"scope":"primary", "samples": samples.len(),
        "first":{"used_percent":first.0,"observed_at":first.1},
        "last":{"used_percent":last.0,"observed_at":last.1},
        "consumed_percent": if comparable { json!(last.0-first.0) } else { Value::Null },
        "resets_at":last.2,"comparable":comparable,"reason":reason})
}

fn permission_trajectory_of(items: &[Value]) -> Value {
    let mut effective: Option<String> = None;
    let mut dangerous_turns: HashSet<String> = HashSet::new();
    let mut dangerous_no_turn = 0u64;
    let mut transitions: Vec<Value> = Vec::new();
    for item in items {
        if item.get("type").and_then(|v| v.as_str()) != Some("turn_context") { continue; }
        let Some(payload) = item.get("payload") else { continue; };
        // 真实线格式（01a029cb/01a050f5 实测）active_permission_profile 是
        // object {"id": ...}，不是 string——只认 string 会把 observed/effective
        // 全读成 null、轨迹死透（修复前真机报告权限列全空）。两态都认（同
        // sandbox_policy 先例），effective 按 last-seen 推进（null 档=保持上一档）。
        let observed = payload.get("active_permission_profile").and_then(|v| {
            if let Some(s) = v.as_str() { Some(s) } else { v.get("id").and_then(|x| x.as_str()) }
        }).map(str::to_owned);
        if observed.is_some() { effective = observed.clone(); }
        let sandbox = payload.get("sandbox_policy").and_then(|v| {
            if let Some(s) = v.as_str() { Some(s) } else { v.get("type").and_then(|x| x.as_str()) }
        }).map(str::to_owned);
        let approval = payload.get("approval_policy").and_then(|v| v.as_str()).map(str::to_owned);
        let turn = payload.get("turn_id").and_then(|v| v.as_str()).map(str::to_owned);
        // dangerous 按 **distinct turn** 计：同一 turn 的多次 turn_context 会
        // 重复计（per-event 把少数几个危险 turn 数成几十条——01a050f5 实报 43）。
        // 无 turn_id 的事件无从去重，退化为按事件计。
        if effective.as_deref() == Some(":danger-full-access") || sandbox.as_deref() == Some("danger-full-access") {
            match &turn {
                Some(t) => { dangerous_turns.insert(t.clone()); }
                None => { dangerous_no_turn += 1; }
            }
        }
        let state = json!({"turn":turn,"observed_profile":observed,"effective_profile":effective,"sandbox":sandbox,"approval":approval});
        let changed = transitions.last().map_or(true, |p| p["effective_profile"] != state["effective_profile"] || p["sandbox"] != state["sandbox"] || p["approval"] != state["approval"]);
        if changed { transitions.push(state); }
    }
    json!({"dangerous_turns":dangerous_no_turn + dangerous_turns.len() as u64,"transitions":transitions})
}

fn turn_ends_of(evidence: &CodexEvidence) -> Value {
    let mut clean=0u64; let mut error=0u64; let mut incomplete=0u64; let mut codes=Map::new();
    for entry in &evidence.canonical.turns.entries {
        let obs=&entry.observation;
        if obs.end_seq.is_none() { incomplete+=1; }
        else if obs.end_reason_kind.as_deref()==Some("error") { error+=1; if let Some(code)=&obs.end_error_code { let n=codes.get(code).and_then(|v|v.as_u64()).unwrap_or(0)+1; codes.insert(code.clone(),json!(n)); } }
        else { clean+=1; }
    }
    json!({"total":evidence.canonical.turns.entries.len(),"clean":clean,"error":error,"incomplete":incomplete,"codes":codes})
}

fn effort_of(items: &[Value]) -> Value {
    let mut values:Vec<String>=Vec::new(); let mut summary:Option<String>=None;
    for item in items { let p=item.get("payload"); if p.and_then(|v|v.get("type")).and_then(|v|v.as_str())!=Some("thread_settings_applied") {continue;} let Some(s)=p.and_then(|v|v.get("thread_settings")) else{continue;}; if let Some(v)=s.get("reasoning_effort").and_then(|v|v.as_str()){values.push(v.to_string())}; if let Some(v)=s.get("reasoning_summary").and_then(|v|v.as_str()){summary=Some(v.to_string())}; }
    let effective=values.last().cloned(); let changed=values.iter().collect::<std::collections::HashSet<_>>().len()>1;
    json!({"effective":effective,"reasoning_effort":values.last().cloned(),"reasoning_summary":summary,"changed":changed})
}

fn tool_output_bytes_of(items: &[Value]) -> Value {
    let mut stdout=0u64;let mut stderr=0u64;let mut commands=0u64;let mut top:Vec<Value>=Vec::new();
    for item in items { let p=item.get("payload"); if p.and_then(|v|v.get("type")).and_then(|v|v.as_str())!=Some("item_completed"){continue;} let Some(it)=p.and_then(|v|v.get("item"))else{continue;};if it.get("type").and_then(|v|v.as_str())!=Some("CommandExecution"){continue;}let out=it.get("stdout").and_then(|v|v.as_str()).unwrap_or("");let err=it.get("stderr").and_then(|v|v.as_str()).unwrap_or("");let ob=out.len() as u64;let eb=err.len() as u64;stdout+=ob;stderr+=eb;commands+=1;top.push(json!({"turn":p.and_then(|v|v.get("turn_id")).and_then(|v|v.as_str()),"tool":"bash","stdout_bytes":ob})); }
    top.sort_by(|a,b|b["stdout_bytes"].as_u64().cmp(&a["stdout_bytes"].as_u64())); top.truncate(5);
    json!({"stdout":stdout,"stderr":stderr,"commands":commands,"top":top})
}

fn turn_timeline_of(items: &[Value], audit: &Value) -> Value {
    let mut refs: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    for finding in audit.get("findings").and_then(|v| v.as_array()).into_iter().flatten() {
        if let (Some(seq), Some(rule)) = (finding.get("seq").and_then(|v| v.as_i64()), finding.get("rule").and_then(|v| v.as_str())) {
            refs.entry(seq).or_default().push(rule.to_string());
        }
    }
    let mut events = Vec::new();
    for (source_order, item) in items.iter().enumerate() {
        let Some(payload) = item.get("payload") else { continue; };
        let top = item.get("type").and_then(|v| v.as_str()); let kind = payload.get("type").and_then(|v| v.as_str());
        let summary = if top == Some("turn_context") { Some("权限上下文") }
            else if kind == Some("task_started") { Some("turn 开始") }
            else if kind == Some("task_complete") { Some(if payload.get("error").map_or(true, |v| v.is_null()) { "turn 完成" } else { "turn error" }) }
            else if kind == Some("item_completed") && payload.get("item").and_then(|v|v.get("type")).and_then(|v|v.as_str()) == Some("CommandExecution") { Some("命令执行") }
            else if kind == Some("token_count") { Some("用量 / 配额快照") } else { None };
        if let Some(summary) = summary { events.push(json!({"source_order":source_order,"turn":payload.get("turn_id").and_then(|v|v.as_str()),"kind":kind.or(top),"summary":summary,"rule_refs":refs.get(&(source_order as i64)).cloned().unwrap_or_default(),"hour":codex_hour_of(item),"ts":item.get("timestamp").and_then(|v|v.as_str())})); }
    }
    json!(events)
}

/// 单个源文件 → 它所属的逻辑 session_id。R2a SessionStore 的增量缓存
/// （W8 起是 `ingest::findings_eval`）用它判定"内容变了的文件属于哪个 session"——代价只
/// 落在这一个文件上（`file_info` 的一次解析），不是重新扫全部 rollout 文件。
pub fn codex_session_id_of(path: &Path) -> String {
    file_info(path).session_id
}

fn file_info(path: &Path) -> FileInfo {
    let parsed = read_codex_session_log(path);
    let items: Vec<Value> = parsed
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let session_id = parsed
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string()
        });
    FileInfo {
        path: path.to_path_buf(),
        session_id,
        history_mode: parsed.get("history_mode").and_then(|v| v.as_str()).map(str::to_owned),
        cli_version: parsed.get("cli_version").and_then(|v| v.as_str()).map(str::to_owned),
        model: parsed.get("model").and_then(|v| v.as_str()).map(str::to_owned),
        workspace_roots: parsed
            .get("workspace_roots")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|r| r.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        first: items.first().and_then(item_ts),
        last: items.last().and_then(item_ts),
        items,
    }
}

/// `codex-session --list`：所有逻辑 session 的行摘要（id/标题/模型/文件数/时间
/// 跨度），按「末行时间戳降序（最新在前），平局按 session_id 升序」排序。
/// 末行时间戳为空的 session 排最后（无时间样本是最老）。
///
/// 与 Python `codex_session_audit.py::codex_session_list` 逐字节对齐。键序是
/// 字节一致的一部分，不能重排。
pub fn codex_session_list(home: &Path) -> Value {
    let index = read_session_index(home);
    let mut by_session: BTreeMap<String, Vec<FileInfo>> = BTreeMap::new();
    // codex_rollout_files 返回全局路径序；分组内 push 保持该序，`last` 即路径序
    // 最后一个文件（「当前状态」惯例）。
    for path in codex_rollout_files(home) {
        let info = file_info(&path);
        by_session.entry(info.session_id.clone()).or_default().push(info);
    }
    let mut sessions: Vec<Value> = by_session
        .into_iter()
        .map(|(sid, files)| {
            let current = files.last().expect("group is non-empty");
            let first = files.iter().filter_map(|f| f.first.clone()).min();
            let last = files.iter().filter_map(|f| f.last.clone()).max();
            json!({
                "session_id": sid,
                "title": index.get(&sid).cloned(),
                "model": current.model,
                "cli_version": current.cli_version,
                "history_mode": current.history_mode,
                "files": files.len(),
                "first": first,
                "last": last,
            })
        })
        .collect();
    // 末行时间戳降序；null（无时间）按最老排。比较器对 (last, session_id) 全序，
    // 稳定与否不影响结果。
    sessions.sort_by(|a, b| {
        let al = a["last"].as_str().unwrap_or("");
        let bl = b["last"].as_str().unwrap_or("");
        bl.cmp(al).then_with(|| {
            a["session_id"]
                .as_str()
                .unwrap_or("")
                .cmp(b["session_id"].as_str().unwrap_or(""))
        })
    });
    json!({ "harness": "codex", "currency": "USD", "sessions": sessions })
}

/// `codex-session` 单会话深挖：逐 session 成本 + 出处覆盖并集。`None` = 没有
/// 任何 rollout 文件属于该 session_id（调用方报「session not found」）。
///
/// 与 Python `codex_session_audit.py::codex_session_audit_json` 逐字节对齐。
pub fn codex_session_audit_json(home: &Path, session_id: &str) -> Option<Value> {
    codex_session_audit_json_for_files(home, session_id, &codex_rollout_files(home))
}

/// 同 [`codex_session_audit_json`]，但只解析调用方给的候选文件（仍按 session_id
/// 过滤，候选多给无害）。
///
/// W8：同步后的 findings 评估器（`ingest::findings_eval`）每个 tick 都要跑，
/// 若沿用「扫全部 rollout 再过滤」，每个有变化的会话都付一次全量解析——正是
/// CLAUDE.md 记的 codex 全量 fold 卡顿事故形状。评估器按文件名里的 session uuid
/// 预筛同会话的 live/archived 兄弟文件再调这里。候选必须是 `codex_rollout_files`
/// 同一全局路径序（「最后一个文件 = 当前状态」依赖它）。
pub fn codex_session_audit_json_for_files(
    home: &Path,
    session_id: &str,
    candidates: &[PathBuf],
) -> Option<Value> {
    let index = read_session_index(home);
    let mut files: Vec<FileInfo> = Vec::new();
    for path in candidates {
        let info = file_info(path);
        if info.session_id == session_id {
            files.push(info);
        }
    }
    if files.is_empty() {
        return None;
    }
    // 分组内路径序（codex_rollout_files 已全局排，push 保序）。
    let current = files.last().expect("non-empty");

    // ── 逐 session 成本：折叠 → 合并 → 计价（codex-cost 同一条路径）──────
    let mut all_items: Vec<Value> = Vec::new();
    let mut fold_folds: Vec<Value> = Vec::new();
    for f in &files {
        all_items.extend(f.items.iter().cloned());
        fold_folds.push(crate::codex_usage::codex_fold_file(&f.items));
    }
    // 上下文窗口必须在 all_items 被 build_codex_evidence 消耗之前读（最后看见的
    // token_count.info.model_context_window 赢）。
    let context_window = context_window_of(&all_items);
    let merged = codex_merge_folds(&fold_folds);
    let pricing = load_codex_pricing();
    let plan = merged["plan"].clone();
    let cost_report = codex_cost_report(
        &merged["by_hour_model"],
        &merged["by_model"],
        &merged["unaccounted"],
        &plan,
        &pricing,
        true,
    )
    .unwrap_or_else(|| {
        // 空折叠：全零结构（同 main.rs `codex_report_from_merged` 的兜底——调用方
        // 要的是「没有数据」而不是「崩了」，unaccounted/plan 必须透传）。
        let mut tt = Map::new();
        for f in crate::codex_usage::CODEX_TOKEN_FIELDS {
            tt.insert(f.to_string(), json!(0));
        }
        let mut base = Map::new();
        base.insert("total_cost_usd".into(), json!(0));
        base.insert("total_tokens".into(), Value::Object(tt));
        base.insert("per_model".into(), Value::Object(Map::new()));
        base.insert("days".into(), Value::Array(vec![]));
        base.insert("unpriced_tokens".into(), json!(0));
        base.insert("unaccounted_usage".into(), merged["unaccounted"].clone());
        base.insert("plan".into(), plan);
        base.insert("hours".into(), Value::Array(vec![]));
        Value::Object(base)
    });

    // ── 出处：concat 全部 items → 一次 build（覆盖 = 跨文件并集）──────────
    let evidence = build_codex_evidence(
        all_items.clone(),
        session_id.to_string(),
        index.get(session_id).cloned(),
        current.history_mode.clone(),
        current.cli_version.clone(),
        current.workspace_roots.clone(),
        current.model.clone(),
    );
    let ev = codex_evidence_json(&evidence);
    let audit = audit_projection(&evidence);

    let first = files.iter().filter_map(|f| f.first.clone()).min();
    let last_ts = files.iter().filter_map(|f| f.last.clone()).max();

    let mut out = Map::new();
    out.insert("harness".into(), json!("codex"));
    out.insert("currency".into(), json!("USD"));
    out.insert("session_id".into(), json!(session_id));
    out.insert("title".into(), index.get(session_id).cloned().into());
    out.insert("model".into(), current.model.clone().into());
    out.insert("cli_version".into(), current.cli_version.clone().into());
    out.insert("history_mode".into(), current.history_mode.clone().into());
    out.insert("workspace_roots".into(), json!(current.workspace_roots));
    out.insert(
        "files".into(),
        json!(files
            .iter()
            .map(|f| f.path.to_string_lossy().to_string())
            .collect::<Vec<_>>()),
    );
    out.insert("context_window".into(), context_window.map_or(Value::Null, |w| json!(w)));
    out.insert("date_span".into(), json!({ "first": first, "last": last_ts }));
    out.insert("audit".into(), audit.clone());
    out.insert("quota_trajectory".into(), quota_trajectory_of(&all_items));
    out.insert("permission_transitions".into(), permission_trajectory_of(&all_items));
    out.insert("turn_ends".into(), turn_ends_of(&evidence));
    out.insert("effort".into(), effort_of(&all_items));
    out.insert("tool_output_bytes".into(), tool_output_bytes_of(&all_items));
    out.insert("turn_timeline".into(), turn_timeline_of(&all_items, &audit));
    out.insert("cost_report".into(), cost_report);
    out.insert("coverage".into(), ev["coverage"].clone());
    out.insert("signals".into(), ev["signals"].clone());
    out.insert("attempts".into(), ev["attempts"].clone());
    out.insert("notes".into(), ev["notes"].clone());
    Some(Value::Object(out))
}

/// `codex-session --list` 的人读呈现——从 `codex_session_list` 输出的同一个
/// Value 上读（形状唯一来源），Python 侧 `codex_session_audit.py::_render_list`
/// 逐字节对齐这一份。缺席的字段一律 `-`（诚实缺失，不编造），行宽固定 28。
pub fn render_codex_session_list(out: &Value) -> String {
    let mut s = String::from("harness: codex\n");
    let sessions = out
        .get("sessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    s.push_str(&format!("sessions: {}\n\n", sessions.len()));
    for row in &sessions {
        let sid = row.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
        let title = row.get("title").and_then(|v| v.as_str()).unwrap_or("-");
        let model = row.get("model").and_then(|v| v.as_str()).unwrap_or("-");
        let files = row.get("files").and_then(|v| v.as_u64()).unwrap_or(0);
        let first = row.get("first").and_then(|v| v.as_str()).unwrap_or("-");
        let last = row.get("last").and_then(|v| v.as_str()).unwrap_or("-");
        s.push_str(&format!(
            "{sid:<28}  {title}  {model}  {files} files  {first} → {last}\n"
        ));
    }
    s
}

/// `codex-session` 单会话深挖的人读呈现——与 `codex_session_audit_json` 的
/// 输出同一形状来源，Python 侧 `codex_session_audit.py::_render_audit` 逐字节
/// 对齐这一份。覆盖/信号/残差哨兵是最下面三行——终端里只看概要，详情在
/// `--json` 或 `--html`。
pub fn render_codex_session(out: &Value) -> String {
    let dash = |v: Option<&str>| v.unwrap_or("-").to_string();
    let mut s = String::from("harness: codex\n");
    s.push_str(&format!("session_id: {}\n", out["session_id"].as_str().unwrap_or("")));
    s.push_str(&format!("title: {}\n", dash(out.get("title").and_then(|v| v.as_str()))));
    s.push_str(&format!("model: {}\n", dash(out.get("model").and_then(|v| v.as_str()))));
    s.push_str(&format!("cli_version: {}\n", dash(out.get("cli_version").and_then(|v| v.as_str()))));
    s.push_str(&format!("history_mode: {}\n", dash(out.get("history_mode").and_then(|v| v.as_str()))));
    let roots: Vec<&str> = out
        .get("workspace_roots")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|r| r.as_str()).collect())
        .unwrap_or_default();
    s.push_str(&format!(
        "workspace_roots: {}\n",
        if roots.is_empty() { "-".to_string() } else { roots.join(", ") }
    ));
    s.push_str(&format!(
        "files: {}\n",
        out.get("files").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)
    ));
    let span_first = out
        .get("date_span")
        .and_then(|v| v.get("first"))
        .and_then(|v| v.as_str())
        .unwrap_or("-");
    let span_last = out
        .get("date_span")
        .and_then(|v| v.get("last"))
        .and_then(|v| v.as_str())
        .unwrap_or("-");
    s.push_str(&format!("span: {span_first} → {span_last}\n"));
    if let Some(cr) = out.get("cost_report") {
        let cost = cr.get("total_cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
        s.push_str(&format!("total_cost_usd: {cost:.2}\n"));
        let mut tt_parts: Vec<String> = Vec::new();
        if let Some(tt) = cr.get("total_tokens").and_then(|v| v.as_object()) {
            for (f, v) in tt {
                tt_parts.push(format!("{f}={}", v.as_i64().unwrap_or(0)));
            }
        }
        s.push_str(&format!("total_tokens: {}\n", tt_parts.join(" ")));
        s.push_str(&format!(
            "unpriced_tokens: {}\n",
            cr.get("unpriced_tokens").and_then(|v| v.as_i64()).unwrap_or(0)
        ));
    }
    s.push_str(&format!(
        // 分母是执行环境可用信号数，不是 19——结构缺口（available=false）任何会话
        // 都为零，算进分母只会把「9/19」这种数字弄成永远到不了的满分。
        "coverage: {}/{} available signals\n",
        out.get("signals").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
        out.get("coverage").and_then(|v| v.as_object()).map(|m| {
            m.values()
                .filter(|c| c.as_object().is_some_and(|o| o.get("available").and_then(|v| v.as_bool()) != Some(false)))
                .count()
        }).unwrap_or(0)
    ));
    s.push_str(&format!(
        "notes: {}\n",
        out.get("notes").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)
    ));
    s
}

/// `codex-session --html`：独立模板 codex_session.html（套 DSH 审计 tab 版式，
/// 不是 calendar.html——那是日历看板）。只内联本 session 的审计 JSON 单块
/// `<script id="agent-vitals-data-codex-session">`。JSON 经 `</script`/`<!--`
/// 转义。与 Python `codex_session_audit.py::_render_codex_session_html` 同构
/// （HTML 文件不参与差分，只需等价可解析的页面）。
pub fn render_codex_session_html(output_path: &Path, out: &Value) {
    const TEMPLATE: &str = include_str!("../../../../../../assets/templates/codex_session.html");
    let json_text = serde_json::to_string(out).unwrap_or_default();
    let safe = json_text
        .replace("</script", "<\\/script")
        .replace("<!--", "<\\!--");
    let inject = format!(
        "<script id=\"agent-vitals-data-codex-session\" type=\"application/json\">{safe}</script>"
    );
    let html = TEMPLATE.replacen("</head>", &format!("{inject}\n</head>"), 1);
    if let Some(parent) = output_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(output_path, html).is_err() {
        eprintln!("failed to write {}", output_path.display());
        std::process::exit(2);
    }
}
