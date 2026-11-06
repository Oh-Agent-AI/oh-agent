//! v0.9.1 SQL 权威库 Tauri IPC 薄壳（`docs/AGENT_VITALS_V0_9_1_SQL_AUTHORITY_MIGRATION_SPEC.md` §6）。
//!
//! 历史：本文件 v0.8 起是 R2a SessionStore 的 IPC 壳（jsonl 重放路径）。v0.9.1
//! 起 sessions 数据唯一来源是 SQL 权威库 `agent-vitals.sqlite3`（schema v2），
//! CLI 切到 `mcp::dispatch("sessions_search" | "session_detail", ...)`（PR #2），
//! 本文件随之切到 spawn 新 CLI。**src-tauri 是独立 workspace，import 不到
//! 二进制 crate 的模块**——所以 `sessions list` / `sessions read` 与 tick 的
//! `oneline` 同款：spawn `agent-vitals` 二进制，stdout 就是 MCP envelope 的
//! `structuredContent`（与 `tools/call` 同源），stderr 是类型化错误 JSON。
//! 这是「不长第二份拷贝」的唯一路径（CLAUDE.md 写右边界：计算在执行环境，
//! 浏览器/前端只渲染投影）。
//!
//! IPC 面只做参数翻译与 spawn：
//!   · `sessions_list(day, harness_kind, page_size, cursor) -> Result<Value, Value>`
//!   · `sessions_read(session_ref, page_size?, cursor?) -> Result<Value, Value>`
//!   · `sessions_findings() -> Result<Value, Value>` —— spawn `sessions findings`：
//!     先同步（行为 findings 由同步后的 `ingest::findings_eval` 增量评估），再读
//!     权威库 issue 分组。W8（2026-09-24）起不再经 r2a_store（已删除）。
//! 错误码原样透传：`not-found` / `permission` / `stale-revision` /
//! `schema-mismatch` / `source-unavailable` / `cancelled`。二进制缺失/ spawn 失败
//! 这类**基础设施失败**也用 `cancelled`（code 集固定，不另造新码）。
//!
//! 三个命令都是 **async + `spawn_blocking`**：冷启动的权威库打开（SQLite readonly
//! handle，sub-second 即可）虽不如旧 r2a_store 慢，但仍是阻塞 I/O，且与 `data-status`
//! 预热、用户点击可能并发——`StoreBuildLock` 把同一时刻的冷构造串行化，后到的
//! 拿不到锁就 await，避免两份并发打开各算一份。

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::cli_process::cli_command;
use crate::overview::data_home;
use crate::resolve_binary;

/// R2a 冷构建的 app 内串行锁。`sessions_*` 都是 spawn CLI 子进程，后台预热与
/// 用户点击可能并发各起一个——两份冷构建互抢 I/O、双倍付冷启动钱。原子写
/// （temp+rename）防的是「读半截 cache」，这把锁防的是「重复冷构建」：后到的
/// 构建等在锁外，前一个写完 cache 再进，直接走命中快路径。
#[derive(Clone)]
pub struct StoreBuildLock(pub Arc<Mutex<()>>);

const ISSUE_DEFAULT_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Default L0 window required by REQ-073.  The lower edge is a rolling
/// thirty-day boundary; the authority layer still applies the configured
/// statistics timezone when it assigns each returned Issue to a day bucket.
/// Keep the upper edge just after `now` so an Issue written during this read
/// cannot be omitted by the exclusive SQL bound.
fn issue_default_window() -> (i64, i64) {
    let now = agent_vitals_runtime::sql_sync::now_ms();
    (now.saturating_sub(ISSUE_DEFAULT_WINDOW_MS), now.saturating_add(1))
}

impl StoreBuildLock {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(())))
    }

    pub(crate) fn acquire(&self) -> std::sync::MutexGuard<'_, ()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn error_value(code: &str, message: &str) -> Value {
    json!({ "error": { "code": code, "message": message } })
}

fn no_binary() -> Value {
    error_value(
        "cancelled",
        "agent-vitals binary not found (set AGENT_VITALS_BIN, add it to PATH, or place it in the app's Contents/Resources/bin/)",
    )
}

/// 北京日期 `YYYY-MM-DD`（与 `overview::today_beijing` 同口径，但纯函数版
/// 便于单测）。不引 `chrono` / `time`——直接调 std 即可，单测里 stub。
fn beijing_today_yyyy_mm_dd() -> String {
    agent_vitals_runtime::clock::today_system()
}

/// `sessions list` 的 argv（纯函数，供单测钉住 IPC→CLI 参数映射）。参数集对齐
/// 新 CLI SessionsAction::List 的扁平签名（apps/cli/src/main.rs:750-775）：
///   --day | --month 必其一（IPC 这里传 day/month，None 时兜底为今天北京日期——
///   CLI 的 mutex 不允许两个都缺，新 SessionsAction 在「无 day 无 month」时报
///   "exactly one of --day / --month is required"，IPC 替前端拍今天的默认值）；
///   --harness-kind 可选（filter chip 透传）；--page-size 可选（缺省 50，二进制兜底）；
///   --cursor 可选（透传 mcp::sessions_search 的不透明 cursor 串）。
///
/// **day vs month**：前端 month picker 选了 2026-08 → IPC 透传 `month: "2026-08"`
/// → CLI 走 `--month` 路径，返回该月全部会话。day 模式返回单日窗口（按小时聚合）。
/// 同传两个时优先 month（更粗、user 主动选的）——这条排序按前端语义定，单测钉死。
///
/// **旧 CLI 不再接受的 flag**：`--from` / `--to` / `--query` / `--hour`
/// / `--min-tokens`——这些维度 r2a_store 没实现，与权威库 sessions_search 输入
/// schema 对齐后已删。前端想用这些维度时需先扩 mcp::sessions_search 的 args
/// schema，再回来加 IPC 参数；目前工作台只用到 day / month / harness_kind / model / provider /
/// page_size / cursor。
#[allow(clippy::too_many_arguments)]
fn list_args(
    day: &Option<String>,
    month: &Option<String>,
    date_from: &Option<String>,
    date_to: &Option<String>,
    harness_kind: &Option<String>,
    model: &Option<String>,
    provider: &Option<String>,
    page_size: Option<usize>,
    cursor: &Option<String>,
    order: &Option<String>,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "sessions".into(),
        "list".into(),
        "--json".into(),
    ];
    // month 优先 day：用户主动从 month picker 选了某月，意图是「该月全部」，
    // day 单窗口只是默认兜底。前端 day picker 选日期时只发 day、month picker
    // 选月时只发 month——同传两个是 IPC bug，这层用 month 兜住不报错。
    // 两个都 None → 今天北京日期（保持 v0.9.1 旧契约：开 tab 直接看到当天）。
    if let (Some(from), Some(to)) = (date_from.clone(), date_to.clone()) {
        a.push("--from-date".into());
        a.push(from);
        a.push("--to-date".into());
        a.push(to);
    } else if let Some(m) = month.clone() {
        a.push("--month".into());
        a.push(m);
    } else {
        let d = day.clone().unwrap_or_else(beijing_today_yyyy_mm_dd);
        a.push("--day".into());
        a.push(d);
    }
    if let Some(h) = harness_kind {
        a.push("--harness-kind".into());
        a.push(h.clone());
    }
    if let Some(m) = model {
        a.push("--model".into());
        a.push(m.clone());
    }
    if let Some(p) = provider {
        a.push("--provider".into());
        a.push(p.clone());
    }
    if let Some(p) = page_size {
        a.push("--page-size".into());
        a.push(p.to_string());
    }
    if let Some(c) = cursor {
        a.push("--cursor".into());
        a.push(c.clone());
    }
    // 排序只收白名单：`oldest`（City 一年窗口从最老数据开始分页）。默认
    // token 降序不传参——保持既有 argv 字节序，golden/契约不受影响；非法值
    // 在 sessions_list 入口就被拒，这里只处理合法的两种。
    if order.as_deref() == Some("oldest") {
        a.push("--order".into());
        a.push("oldest".into());
    }
    a
}

/// `sessions findings` 的 argv（纯函数，供单测钉住 IPC→CLI 参数映射）。无参数——
/// rollup 恒是全源聚合，跟 list 的 filter/cursor 无关。
fn findings_args() -> Vec<String> {
    vec!["sessions".into(), "findings".into(), "--json".into()]
}

/// `sessions read` 的 argv。session_ref 是 MCP HMAC 不透明串（`sr_<32hex>`），
/// 由 list 行的 `data.sessions[].session_ref` 拿——不是原生 session_key（也不该
/// 是：HMAC 把 native_session_id / machine_namespace 屏蔽到 IPC 之外，避免前
/// 端读到 §5.1 里钉死的 PII）。分页参数只接受有界 page size 与不透明
/// cursor，并透传给 CLI；权威库的 revision 仍写在 envelope 的
/// `authority_revision` 字段里，不需要 IPC 额外携带。
fn read_args(session_ref: &str, page_size: Option<usize>, cursor: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "sessions".into(),
        "read".into(),
        "--session-ref".into(),
        session_ref.to_string(),
    ];
    if let Some(size) = page_size {
        args.push("--page-size".into());
        args.push(size.to_string());
    }
    if let Some(value) = cursor {
        args.push("--cursor".into());
        args.push(value.to_string());
    }
    args.push("--json".into());
    args
}

// ── 「测试」tab（V17 探针面）：三条读命令 + 异步 run 全部 spawn CLI——
// runner 逻辑不进桌面进程（与 sessions 同一条分层纪律）。run 是分钟级长
// 任务：起线程跑 CLI、单槽记住最近结果，前端用 ticket 轮询 probe_run_result
// （job 轮询模式；billing recalculation 先例）。凭据经 CLI 子进程 env 直传，
// 桌面进程从头到尾不碰 token。

/// 最近 N 次 run 的终态（环形；复审计论的单槽会在「重载页面后旧线程晚到」
/// 时让新 ticket 永远 running——缓冲多条让晚到的旧结果也能被对上号）。
static PROBE_RESULTS: std::sync::Mutex<std::collections::VecDeque<(u64, Value)>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
const PROBE_RESULT_KEEP: usize = 8;

fn probe_command(args: &[String]) -> Option<Command> {
    let mut command = cli_command(crate::resolve_binary()?);
    command.args(args);
    command.env("AGENT_VITALS_HOME", crate::overview::data_home());
    Some(command)
}

fn probe_error(message: &str) -> Value {
    serde_json::json!({ "error": { "code": "cancelled", "message": message } })
}

#[tauri::command]
pub async fn probe_routes_list() -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let args: Vec<String> = ["probe", "routes", "--json"].iter().map(|s| s.to_string()).collect();
        let Some(mut command) = probe_command(&args) else {
            return Err(probe_error("agent-vitals binary not found"));
        };
        let out = command.output().map_err(|e| probe_error(&e.to_string()))?;
        if !out.status.success() {
            return Err(probe_error(&String::from_utf8_lossy(&out.stderr)));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| probe_error(&e.to_string()))
    })
    .await
    .map_err(|e| probe_error(&e.to_string()))?
}

/// 「测试」tab v2 默认面（2026-09-20 转向）：被动路线质量报告。读侧聚合，
/// 不发任何探针请求——spawn CLI `routes-quality --json`，与 probe 命令同款
/// AGENT_VITALS_HOME 钉死。
#[tauri::command]
pub async fn routes_quality(days: u32) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<String> = vec![
            "routes-quality".to_string(),
            "--json".to_string(),
            "--days".to_string(),
            days.to_string(),
        ];
        let Some(mut command) = probe_command(&args) else {
            return Err(probe_error("agent-vitals binary not found"));
        };
        let out = command.output().map_err(|e| probe_error(&e.to_string()))?;
        if !out.status.success() {
            return Err(probe_error(&String::from_utf8_lossy(&out.stderr)));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| probe_error(&e.to_string()))
    })
    .await
    .map_err(|e| probe_error(&e.to_string()))?
}

/// 当前生效路线提示（白名单读 settings；「测试」tab 主动测试的默认对象）。
#[tauri::command]
pub async fn probe_current_hint() -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(|| {
        let args: Vec<String> = ["probe", "current", "--json"].iter().map(|s| s.to_string()).collect();
        let Some(mut command) = probe_command(&args) else {
            return Err(probe_error("agent-vitals binary not found"));
        };
        let out = command.output().map_err(|e| probe_error(&e.to_string()))?;
        if !out.status.success() {
            return Err(probe_error(&String::from_utf8_lossy(&out.stderr)));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| probe_error(&e.to_string()))
    })
    .await
    .map_err(|e| probe_error(&e.to_string()))?
}

/// 启动一次探针 run（异步）：立即返回 ticket，前端轮询 probe_run_result。
/// `model` 仅配合 route_a == "current"（当前路线测试的用户可改模型）。
#[tauri::command]
pub async fn probe_run_start(
    route_a: String,
    route_b: Option<String>,
    model: Option<String>,
    repeats: usize,
    max_probes: usize,
) -> Result<Value, Value> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static TICKET: AtomicU64 = AtomicU64::new(0);
    let ticket = TICKET.fetch_add(1, Ordering::SeqCst);
    std::thread::spawn(move || {
        let mut args: Vec<String> = vec![
            "probe".into(), "run".into(), "--route-a".into(), route_a,
            "--repeats".into(), repeats.to_string(),
            "--max-probes".into(), max_probes.to_string(),
        ];
        if let Some(route_b) = &route_b {
            args.push("--route-b".into());
            args.push(route_b.clone());
        }
        if let Some(model) = &model {
            args.push("--model".into());
            args.push(model.clone());
        }
        let Some(mut command) = probe_command(&args) else {
            if let Ok(mut queue) = PROBE_RESULTS.lock() {
                queue.push_back((ticket, serde_json::json!({
                    "ticket": ticket, "state": "error",
                    "message": "agent-vitals binary not found",
                })));
            }
            return;
        };
        let outcome = command
            .output()
            .ok()
            .map(|out| {
                let report: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
                if out.status.success() {
                    serde_json::json!({ "ticket": ticket, "state": "completed", "report": report })
                } else {
                    serde_json::json!({
                        "ticket": ticket, "state": "error",
                        "message": String::from_utf8_lossy(&out.stderr).to_string(),
                    })
                }
            })
            .unwrap_or_else(|| serde_json::json!({
                "ticket": ticket, "state": "error", "message": "spawn failed",
            }));
        if let Ok(mut queue) = PROBE_RESULTS.lock() {
            if queue.len() >= PROBE_RESULT_KEEP {
                queue.pop_front();
            }
            queue.push_back((ticket, outcome));
        }
    });
    Ok(serde_json::json!({ "ticket": ticket, "state": "running" }))
}

#[tauri::command]
pub async fn probe_run_result(ticket: u64) -> Result<Value, Value> {
    let guard = PROBE_RESULTS.lock().unwrap();
    match guard.iter().find(|(kept, _)| *kept == ticket) {
        Some((_, value)) => Ok(value.clone()),
        None => Ok(serde_json::json!({ "ticket": ticket, "state": "running" })),
    }
}

#[tauri::command]
pub async fn probe_report(run_id: String) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<String> = ["probe", "report", "--run-id", &run_id]
            .iter().map(|s| s.to_string()).collect();
        let Some(mut command) = probe_command(&args) else {
            return Err(probe_error("agent-vitals binary not found"));
        };
        let out = command.output().map_err(|e| probe_error(&e.to_string()))?;
        if !out.status.success() {
            return Err(probe_error(&String::from_utf8_lossy(&out.stderr)));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| probe_error(&e.to_string()))
    })
    .await
    .map_err(|e| probe_error(&e.to_string()))?
}

/// spawn 二进制并解析 stdout。非零退出 → 若 stderr 是 `{"error":…}` 形状则原样
/// 透传（类型化错误码不丢）；否则包成 `cancelled`。spawn/解析失败 → `cancelled`。
fn run_json(mut cmd: Command) -> Result<Value, Value> {
    let out = cmd
        .output()
        .map_err(|e| error_value("cancelled", &e.to_string()))?;
    if !out.status.success() {
        if let Ok(v) = serde_json::from_slice::<Value>(&out.stderr) {
            if v.get("error").is_some() {
                return Err(v);
            }
        }
        return Err(error_value(
            "cancelled",
            &String::from_utf8_lossy(&out.stderr),
        ));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| error_value("cancelled", &e.to_string()))
}

/// list_sessions：day/month/harness/page_size/cursor → mcp::sessions_search envelope。
/// async：spawn_blocking 把 CLI 子进程丢到阻塞线程池，主线程继续收托盘事件，
/// 详见模块头注释。
///
/// **参数扁平**（day / month / harness_kind / model / provider / page_size / cursor 七件）是 Tauri
/// IPC 契约的一部分——`workbench.js` 的 invoke 调用面就是这五个扁平参数，
/// 改成结构体要连带改前端调用面。5 个参数本就在 lint 阈值内。
///
/// month 是工作台 picker 的扩展（v0.9.1 旧契约只发 day，修「点 tab 只看到今
/// 天、上个月会话看不到」的 bug）：前端从 `<input type="month">` 读到
/// `YYYY-MM` 字符串透传。两个都给时 store.rs `list_args` 优先 month（更粗、
/// 用户主动选择）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sessions_list(
    state: tauri::State<'_, StoreBuildLock>,
    day: Option<String>,
    month: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    harness_kind: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    page_size: Option<usize>,
    cursor: Option<String>,
    order: Option<String>,
) -> Result<Value, Value> {
    if let Some(value) = order.as_deref() {
        if value != "oldest" && value != "tokens" {
            return Err(error_value("invalid-argument", "sessions list order must be \"oldest\" or \"tokens\""));
        }
    }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else {
            return Err(no_binary());
        };
        let args = list_args(&day, &month, &date_from, &date_to, &harness_kind, &model, &provider, page_size, &cursor, &order);
        let mut cmd = cli_command(&bin);
        cmd.args(&args);
        // 与 tick 同款：显式钉死 AGENT_VITALS_HOME，权威库 / salt / 状态文件都
        // 落在 app 自己的数据根，不依赖子进程继承的环境。
        cmd.env("AGENT_VITALS_HOME", data_home());
        run_json(cmd)
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// read_session：session_ref（HMAC）→ 完整 mcp::session_detail envelope。
/// async：与 sessions_list 同锁同池子（`StoreBuildLock` + `spawn_blocking`）。
///
/// **session_ref 是不透明串**（`sr_<32hex>`），来自 list 行的
/// `data.sessions[].session_ref`。前端不再持有 native_session_id / harness_kind /
/// machine_namespace——HMAC 把 PII 屏蔽到 IPC 边界外，是 §5.1 的核心约束之一
/// （spec §0.3「数据面 PII 边界」）。
#[tauri::command]
pub async fn sessions_read(
    state: tauri::State<'_, StoreBuildLock>,
    session_ref: String,
    page_size: Option<usize>,
    cursor: Option<String>,
) -> Result<Value, Value> {
    if let Some(size) = page_size {
        if !(1..=1000).contains(&size) {
            return Err(error_value("invalid-argument", "session detail page size out of range"));
        }
    }
    if let Some(value) = cursor.as_deref() {
        if value.is_empty() || value.len() > 4096 {
            return Err(error_value("invalid-argument", "session detail cursor is unsafe"));
        }
    }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else {
            return Err(no_binary());
        };
        let args = read_args(&session_ref, page_size, cursor.as_deref());
        let mut cmd = cli_command(&bin);
        cmd.args(&args);
        cmd.env("AGENT_VITALS_HOME", data_home());
        run_json(cmd)
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// aggregate_findings：跨会话 findings 汇总（workbench「Findings」页）。纯聚合在
/// core + 二进制（`sessions findings --json`），IPC 只做 spawn + 透传，与
/// `sessions_list` 同款。async：见模块头注释。
#[tauri::command]
pub async fn sessions_findings(
    state: tauri::State<'_, StoreBuildLock>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else {
            return Err(no_binary());
        };
        let mut cmd = cli_command(&bin);
        cmd.args(findings_args());
        cmd.env("AGENT_VITALS_HOME", data_home());
        run_json(cmd)
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// User-initiated Trust/Egress historical scan.  It deliberately shells out to
/// the one CLI implementation so the desktop cannot grow a second scanner.
#[tauri::command]
pub async fn trust_audit(
    harness: String,
    state: tauri::State<'_, StoreBuildLock>,
) -> Result<Value, Value> {
    if harness.len() > 32 || !harness.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')) {
        return Err(error_value("cancelled", "invalid trust audit profile id"));
    }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else { return Err(no_binary()); };
        let mut cmd = cli_command(&bin);
        cmd.args(["trust", "audit", "--harness", &harness, "--json"]);
        cmd.env("AGENT_VITALS_HOME", data_home());
        run_json(cmd)
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// Read the bounded, redacted Trust evidence projection from the local
/// authority. Unlike trust_audit this command never scans client directories.
#[tauri::command]
pub async fn trust_evidence_read(
    harness: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
    state: tauri::State<'_, StoreBuildLock>,
) -> Result<Value, Value> {
    if let Some(value) = harness.as_deref() {
        if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')) {
            return Err(error_value("invalid-argument", "invalid trust evidence harness"));
        }
    }
    let limit = limit.unwrap_or(200);
    if !(1..=500).contains(&limit) { return Err(error_value("invalid-argument", "trust evidence limit out of range")); }
    if cursor.as_ref().is_some_and(|value| value.is_empty() || value.len() > 320 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))) {
        return Err(error_value("invalid-argument", "trust evidence cursor is invalid"));
    }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else { return Err(no_binary()); };
        let limit_text = limit.to_string();
        let mut cmd = cli_command(&bin);
        cmd.args(["trust", "evidence", "--limit", &limit_text, "--json"]);
        if let Some(harness) = harness.as_deref() { cmd.args(["--harness", harness]); }
        if let Some(cursor) = cursor.as_deref() { cmd.args(["--cursor", cursor]); }
        cmd.env("AGENT_VITALS_HOME", data_home());
        run_json(cmd)
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// User-initiated coverage inventory. It only checks known client root
/// directories for existence; it neither opens their files nor emits Findings.
#[tauri::command]
pub async fn trust_discover(
    state: tauri::State<'_, StoreBuildLock>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else { return Err(no_binary()); };
        let mut cmd = cli_command(&bin);
        cmd.args(["trust", "discover", "--json"]);
        cmd.env("AGENT_VITALS_HOME", data_home());
        run_json(cmd)
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// One explicit low-privilege process snapshot for unattributed local-agent
/// behavior. It is intentionally not a daemon, notification trigger, or
/// network blocker.
#[tauri::command]
pub async fn trust_runtime_snapshot(
    state: tauri::State<'_, StoreBuildLock>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else { return Err(no_binary()); };
        let mut cmd = cli_command(&bin);
        cmd.args(["trust", "monitor", "snapshot", "--json"]);
        cmd.env("AGENT_VITALS_HOME", data_home());
        let raw = run_json(cmd)?;
        Ok(safe_trust_runtime_snapshot(&raw))
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

fn safe_trust_runtime_snapshot(raw: &Value) -> Value {
    let capability = match raw.get("capability").and_then(Value::as_str) {
        Some("macos_lsof_partial") => "macos_lsof_partial",
        Some("runtime_sensor_unavailable_on_this_platform") => "runtime_sensor_unavailable_on_this_platform",
        Some("lsof_unavailable") => "lsof_unavailable",
        Some("lsof_no_visible_output") => "lsof_no_visible_output",
        Some("lsof_invalid_output") => "lsof_invalid_output",
        _ => "unavailable",
    };
    let count = |key: &str| safe_matrix_count(raw.get(key), 1_000_000_000).unwrap_or(0);
    json!({
        "capability": capability,
        "candidate_processes": count("candidate_processes"),
        "observations": count("observations"),
        "inserted": count("inserted"),
        "duplicate": count("duplicate"),
        "findings_upserted": count("findings_upserted"),
        "notification_candidates": count("notification_candidates"),
        "evidence_links_added": count("evidence_links_added"),
    })
}

/// Trust hot-plug review surface. Agent-facing MCP can only stage proposals;
/// these UI commands perform the explicit user decision and are not MCP tools.
#[tauri::command]
pub fn trust_profile_list() -> Result<Value, Value> {
    agent_vitals_runtime::mcp::trust_profiles::run_list(&data_home())
        .map_err(|error| error_value("trust_profile_unavailable", &error.message))
}

#[tauri::command]
pub fn trust_profile_validate(manifest: Value) -> Result<Value, Value> {
    agent_vitals_runtime::mcp::trust_profiles::run_validate(
        &serde_json::json!({"manifest": manifest}), &data_home(),
    ).map_err(|error| error_value("trust_profile_invalid", &error.message))
}

#[tauri::command]
pub fn trust_profile_stage(manifest: Value, proposal_note: Option<String>) -> Result<Value, Value> {
    agent_vitals_runtime::mcp::trust_profiles::run_stage(
        &serde_json::json!({"manifest": manifest, "proposal_note": proposal_note}),
        &data_home(), true,
    ).map_err(|error| error_value("trust_profile_stage_failed", &error.message))
}

#[tauri::command]
pub fn trust_profile_proposal_status() -> Result<Value, Value> {
    agent_vitals_runtime::mcp::trust_profiles::run_status(&data_home())
        .map_err(|error| error_value("trust_profile_unavailable", &error.message))
}

#[tauri::command]
pub fn trust_profile_approve(slug: String, manifest_hash: String) -> Result<Value, Value> {
    agent_vitals_runtime::mcp::trust_profiles::approve_staged(&data_home(), &slug, &manifest_hash)
        .map_err(|error| error_value("trust_profile_approval_failed", &error))
}

#[tauri::command]
pub fn trust_profile_reject(slug: String, manifest_hash: String) -> Result<Value, Value> {
    agent_vitals_runtime::mcp::trust_profiles::reject_staged(&data_home(), &slug, &manifest_hash)
        .map_err(|error| error_value("trust_profile_rejection_failed", &error))
}

#[tauri::command]
pub fn trust_profile_revoke(slug: String, manifest_hash: String) -> Result<Value, Value> {
    agent_vitals_runtime::mcp::trust_profiles::revoke_approved(&data_home(), &slug, &manifest_hash)
        .map_err(|error| error_value("trust_profile_revoke_failed", &error))
}

#[tauri::command]
pub fn trust_suppression_create(
    issue_type: String,
    instance_fingerprint: Option<String>,
    reason: String,
) -> Result<Value, Value> {
    if !matches!(issue_type.as_str(), "SV701" | "SV702" | "SV703" | "SV704" | "SV705" | "SV706" | "SV707" | "SV708" | "SV709" | "SV710") {
        return Err(error_value("invalid_trust_suppression", "unknown Trust Finding type"));
    }
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let id = format!("trust-suppression-{}-{}", issue_type, now_ms);
    let path = agent_vitals_data::authority::default_authority_path(&data_home());
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms)
        .map_err(|_| error_value("authority_unavailable", "authority database unavailable"))?;
    db.trust_suppression_set(&id, &issue_type, instance_fingerprint.as_deref(), &reason, now_ms)
        .map_err(|error| error_value("invalid_trust_suppression", &error.to_string()))?;
    Ok(serde_json::json!({"status":"saved", "suppression_id":id}))
}

#[tauri::command]
pub fn trust_suppression_revoke(suppression_id: String) -> Result<Value, Value> {
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let path = agent_vitals_data::authority::default_authority_path(&data_home());
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms)
        .map_err(|_| error_value("authority_unavailable", "authority database unavailable"))?;
    let revoked = db.trust_suppression_revoke(&suppression_id, now_ms)
        .map_err(|error| error_value("invalid_trust_suppression", &error.to_string()))?;
    Ok(serde_json::json!({"status": if revoked {"revoked"} else {"not_found"}, "suppression_id":suppression_id}))
}

#[tauri::command]
pub fn trust_suppression_list() -> Result<Value, Value> {
    let path = agent_vitals_data::authority::default_authority_path(&data_home());
    let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
        .map_err(|_| error_value("authority_unavailable", "authority database unavailable"))?;
    let mut stmt = db.conn().prepare(
        "SELECT suppression_id, issue_type, reason, created_at_ms, revoked_at_ms
         FROM trust_suppressions ORDER BY created_at_ms DESC",
    ).map_err(|error| error_value("trust_suppression_unavailable", &error.to_string()))?;
    let rows = stmt.query_map([], |row| Ok(serde_json::json!({
        "suppression_id": row.get::<_, String>(0)?, "issue_type": row.get::<_, String>(1)?,
        "reason": row.get::<_, String>(2)?, "created_at_ms": row.get::<_, i64>(3)?,
        "revoked_at_ms": row.get::<_, Option<i64>>(4)?,
    }))).map_err(|error| error_value("trust_suppression_unavailable", &error.to_string()))?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error_value("trust_suppression_unavailable", &error.to_string()))?;
    Ok(serde_json::json!({"status":"ok", "suppressions":rows}))
}

/// issues 投影一行都没有 = 首次引导（库刚建/从未跑过 findings）。这不是
/// 「缓存冷」——是数据根本不存在，此时放行一次 evaluator 刷新，否则全新
/// 安装的要一直空到用户自己找到「重载」按钮。有数据（哪怕陈旧）则恒 false。
fn issues_projection_empty(db: &agent_vitals_data::authority::AuthorityDb) -> bool {
    agent_vitals_data::issues::issues_projection_count(db.conn()).unwrap_or(0) == 0
}

/// §1.6 的刷新判定（纯函数，可测）：显式 refresh 恒刷；否则仅投影全空时引导。
fn should_refresh_evaluator(refresh: bool, bootstrap_needed: bool) -> bool {
    refresh || bootstrap_needed
}

/// v0.11 Issues projection. Reads the authority tables directly; the legacy
/// evaluator refresh (CLI spawn, cold cache scans session logs) only runs on
/// `refresh=true` (the 重载 button) or first-run bootstrap when the issues
/// projection is completely empty — WORKBENCH_FINDINGS_TAB_SPEC §1.6：
/// 首屏只读 authority，重路径只在显式请求。
#[tauri::command]
pub async fn sessions_issues(
    state: tauri::State<'_, StoreBuildLock>,
    page_size: Option<usize>,
    cursor: Option<String>,
    refresh: Option<bool>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let mut refreshed = false;
        let path = agent_vitals_data::authority::default_authority_path(&data_home());
        let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
            .map_err(|e| error_value("authority_unavailable", &e.to_string()))?;
        // 引导只在首页读取（cursor 为空）放行：分页与状态迁移后的快速刷新
        // 都不再触发。`refreshed` 记的是「CLI 真跑成功过」，失败不冒充。
        let bootstrap_needed = cursor.is_none() && issues_projection_empty(&db);
        if should_refresh_evaluator(refresh.unwrap_or(false), bootstrap_needed) {
            if let Some(bin) = resolve_binary() {
                let mut cmd = cli_command(bin);
                cmd.args(findings_args());
                cmd.env("AGENT_VITALS_HOME", data_home());
                if run_json(cmd).is_ok() {
                    refreshed = true;
                }
            }
        }
        let path = agent_vitals_data::authority::default_authority_path(&data_home());
        let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
            .map_err(|e| error_value("authority_unavailable", &e.to_string()))?;
        let budget_group = agent_vitals_runtime::budget::budget_status_sql_at(
            &data_home(), &crate::overview::current_month_beijing(),
        ).filter(|budget| matches!(budget["level"].as_str(), Some("warn" | "exceeded")))
            .map(|budget| budget_issue_group(&budget));
        let (from_ms, to_ms) = issue_default_window();
        let requested_page_size = page_size.unwrap_or(50).clamp(1, 500);
        // 预算组是只读的合成行，必须在分页前为它预留一个槽位；否则默认
        // page_size=50 会返回 51 行，且 next_cursor 与实际展示数失配。
        let source_page_size = if cursor.is_none() && budget_group.is_some() && requested_page_size > 1 {
            requested_page_size - 1
        } else {
            requested_page_size
        };
        let all_groups = agent_vitals_data::issues::issue_groups_with_sources(
            db.conn(), Some(from_ms), Some(to_ms), usize::MAX, None,
        ).map_err(|e| error_value("authority_query", &e.to_string()))?;
        let groups = agent_vitals_data::issues::issue_groups_with_sources(
            db.conn(), Some(from_ms), Some(to_ms), source_page_size, cursor.as_deref(),
        ).map_err(|e| error_value("authority_query", &e.to_string()))?;
        let all_rows = all_groups["groups"].as_array().cloned().unwrap_or_default();
        let mut rows = groups["groups"].as_array().cloned().unwrap_or_default();
        let budget_added = budget_group.is_some();
        let next_cursor = if cursor.is_none() && requested_page_size == 1 && budget_group.is_some() {
            // 单项页无法同时容纳预算合成行和第一条来源组；先返回预算组，
            // 下一页从来源组 offset=0 开始，避免丢失或重复来源组。
            rows = budget_group.clone().into_iter().collect();
            (all_groups["total_groups"].as_u64().unwrap_or(0) > 0).then(|| "0".to_string())
        } else {
            if cursor.is_none() {
                if let Some(budget) = budget_group.clone() { rows.push(budget); }
            }
            groups["next_cursor"].as_str().map(String::from)
        };
        let mut all_rows_with_budget = all_rows;
        if budget_added {
            all_rows_with_budget.push(budget_group.clone().expect("budget_group is present"));
        }
        let count = |severity: &str| all_rows_with_budget.iter().filter(|v| v["severity"] == severity).count();
        let rules = issue_group_rollup(&all_rows_with_budget);
        let sessions_with: usize = all_rows_with_budget.iter().map(|v| v["sessions"].as_u64().unwrap_or(0) as usize).sum();
        let total_groups = all_groups["total_groups"].as_u64().unwrap_or(0) + u64::from(budget_added);
        Ok(serde_json::json!({
            "totals": { "issues": total_groups, "findings": groups["source_issue_count"], "critical": count("critical"), "warning": count("warning"), "info": count("info"), "sessions": sessions_with, "sessions_total": sessions_with },
            "rules": rules, "issues": rows, "findings": [], "source": "unified_issue_groups",
            "next_cursor": next_cursor, "refreshed": refreshed, "source_projection_count": all_groups["source_projection_count"].as_u64().unwrap_or(0) + u64::from(budget_added)
        }))
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

// React Findings does not consume `sessions_issues`: that legacy DTO contains
// source/detail samples and issue identities intended for the old DOM surface.
// This projection is a versioned, allow-listed serving face.  It is deliberately
// read-only and never exposes issue/session/source/run identifiers or free-form
// metadata across the Rust → JS boundary.
fn safe_findings_rule(value: &str) -> String {
    const KNOWN: &[&str] = &[
        "PRICE_COVERAGE", "ROUTE_UNCONFIRMED", "BUDGET_THRESHOLD", "DATA_SOURCE_FAILURE",
        "BILLING_CONFIRMATION", "USAGE_GROWTH", "QUOTA_WINDOW", "DATA_QUALITY",
    ];
    if KNOWN.contains(&value) {
        return value.to_string();
    }
    let is_sv = value.starts_with("SV")
        && value.len() <= 8
        && value[2..].chars().all(|ch| ch.is_ascii_digit());
    if is_sv { value.to_string() } else { "OTHER".to_string() }
}

fn safe_findings_harness(value: &str) -> String {
    if let Some(slug) = value.strip_prefix("harness:").or_else(|| value.strip_prefix("plugin:")) {
        if agent_vitals_runtime::harness_registry::plugin_slug_ok(slug) {
            return value.to_string();
        }
        return "generic".to_string();
    }
    if value.len() <= 32
        && !value.is_empty()
        && value.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '-'))
    {
        value.to_string()
    } else {
        "generic".to_string()
    }
}

fn safe_findings_severity(value: &str) -> &'static str {
    match value { "critical" => "critical", "warning" => "warning", "info" => "info", _ => "unknown" }
}

fn safe_findings_action_kind(source_kind: &str, rule: &str) -> &'static str {
    if rule.starts_with("SV") { return "behavior"; }
    match source_kind {
        "billing_candidate" | "billing_group" => "billing",
        "budget" => "budget",
        "source_failure" => "source",
        "usage_growth" => "usage",
        "probe" => "probe",
        _ => "other",
    }
}

fn safe_findings_evidence_class(value: &str) -> &'static str {
    let lower = value.to_ascii_lowercase();
    if lower.contains("egress") || lower.contains("storage") || lower.contains("network") { "egress" }
    else if lower.contains("billing") || lower.contains("price") || lower.contains("route") { "billing" }
    else if lower.contains("source") || lower.contains("quality") { "data_source" }
    else if lower.contains("trust") || lower.contains("workspace") || lower.contains("repository") { "trust" }
    else if lower.contains("usage") || lower.contains("growth") { "usage" }
    else if lower.contains("behavior") || lower.starts_with("sv") { "behavior" }
    else { "generic" }
}

fn safe_non_negative(row: &Value, key: &str) -> Option<u64> {
    row.get(key).and_then(Value::as_u64)
}

fn safe_findings_sample_enum<'a>(value: Option<&Value>, allowed: &'a [&'a str]) -> Option<&'a str> {
    let candidate = value.and_then(Value::as_str)?;
    allowed.iter().find(|item| **item == candidate).copied()
}

fn safe_findings_sample_count(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|count| *count <= 1_000_000_000)
}

/// Project the small amount of evidence context that is useful on the
/// Findings page without crossing the raw issue/sample boundary.  In
/// particular, this never copies `issue_id`, `evidence`, `detail`, paths,
/// commands, session keys, or arbitrary metadata into the renderer.
fn safe_findings_sample(
    item: &Value, group_ref: &str, index: usize, first_seen_at_ms: u64, last_seen_at_ms: u64,
) -> Value {
    let object = item.as_object();
    let metadata = object
        .and_then(|value| value.get("metadata"))
        .and_then(Value::as_object);
    let evidence_level = safe_findings_sample_enum(
        metadata.and_then(|value| value.get("evidence_level")),
        &["E0", "E1", "E2", "E3", "E4", "E5"],
    );
    let stage = safe_findings_sample_enum(
        metadata.and_then(|value| value.get("stage")),
        &["read_observed", "package_observed", "credential_observed", "egress_attempted", "egress_transmitted", "remote_accepted"],
    );
    let evidence_origin = safe_findings_sample_enum(
        metadata.and_then(|value| value.get("evidence_origin")),
        &["local_artifact", "client_state_claim", "runtime_process_metadata", "network_metadata", "verified_receipt", "unknown_legacy"],
    );
    let confidence = safe_findings_sample_enum(
        metadata.and_then(|value| value.get("confidence")),
        &["high", "medium", "low"],
    );
    let destination_class = safe_findings_sample_enum(
        metadata.and_then(|value| value.get("destination_class")),
        &["vendor_api", "object_storage", "telemetry", "eval", "model_api", "unknown"],
    );
    let scope_classes = metadata
        .and_then(|value| value.get("scope_classes"))
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str)
            .filter(|value| value.len() <= 64 && !value.is_empty() && value.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '-')))
            .take(16).map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    let observed_first_at_ms = metadata
        .and_then(|value| value.get("first_observed_at_ms"))
        .and_then(Value::as_u64)
        .filter(|value| *value >= first_seen_at_ms && *value <= last_seen_at_ms)
        .unwrap_or(first_seen_at_ms);
    let observed_last_at_ms = metadata
        .and_then(|value| value.get("last_observed_at_ms"))
        .and_then(Value::as_u64)
        .filter(|value| *value >= observed_first_at_ms && *value <= last_seen_at_ms)
        .unwrap_or(observed_first_at_ms);
    let sample_key = format!("{group_ref}\0sample\0{}", index + 1);
    let sample_ref = format!("fnv1a64:{}", agent_vitals_domain::source_identity::fnv1a64_hex(sample_key.as_bytes()));
    json!({
        "available": object.is_some_and(|value| !value.is_empty()),
        "reference": sample_ref,
        "observed_first_at_ms": observed_first_at_ms,
        "observed_last_at_ms": observed_last_at_ms,
        "evidence_level": evidence_level,
        "stage": stage,
        "evidence_origin": evidence_origin,
        "scope_classes": scope_classes,
        "observation_count": safe_findings_sample_count(metadata.and_then(|value| value.get("observation_count"))),
        "file_count": safe_findings_sample_count(metadata.and_then(|value| value.get("file_count"))),
        "byte_count": safe_findings_sample_count(metadata.and_then(|value| value.get("byte_count"))),
        "destination_class": destination_class,
        "confidence": confidence,
    })
}

fn safe_findings_group(row: &Value) -> Option<Value> {
    let group_ref = row.get("group_id").and_then(Value::as_str)?;
    if !group_ref.starts_with("fnv1a64:") || group_ref.len() != 24
        || !group_ref[8..].chars().all(|ch| ch.is_ascii_hexdigit())
    { return None; }
    let raw_rule = row.get("rule").and_then(Value::as_str).unwrap_or("OTHER");
    let rule = safe_findings_rule(raw_rule);
    let source_kind = row.get("source_kind").and_then(Value::as_str).unwrap_or("behavior");
    let action_kind = safe_findings_action_kind(source_kind, &rule);
    let evidence_class = safe_findings_evidence_class(row.get("evidence_class").and_then(Value::as_str).unwrap_or(""));
    let status = row.get("status_rollup").and_then(Value::as_object)?;
    let count = |name: &str| status.get(name).and_then(Value::as_u64).unwrap_or(0);
    let count_total = safe_non_negative(row, "count")?;
    let first = safe_non_negative(row, "first_seen_at_ms")?;
    let last = safe_non_negative(row, "last_seen_at_ms")?;
    let sessions = safe_non_negative(row, "sessions_count")?;
    if first > last || count_total > 1_000_000_000 || sessions > 1_000_000_000 {
        return None;
    }
    let samples = row.get("sample_evidence").and_then(Value::as_array).map(|items| {
        items.iter().take(3).enumerate().map(|(index, item)| safe_findings_sample(
            item, group_ref, index, first, last,
        )).collect::<Vec<_>>()
    }).unwrap_or_default();
    // Legacy source projections mark their remedy as diagnostic-only because
    // they never exposed a safe UI action.  The React serving face keeps the
    // distinction explicit: billing/budget/source groups are actionable
    // categories, while behavior/probe/usage groups remain read-only facts.
    let action_capable = matches!(action_kind, "billing" | "budget" | "source");
    let read_only = !action_capable;
    Some(json!({
        "group_id": group_ref,
        "rule": rule,
        "harness": safe_findings_harness(row.get("harness").and_then(Value::as_str).unwrap_or("generic")),
        "action_kind": action_kind,
        "evidence_class": evidence_class,
        "count": count_total,
        "first_seen_at_ms": first,
        "last_seen_at_ms": last,
        "severity": safe_findings_severity(row.get("severity").and_then(Value::as_str).unwrap_or("unknown")),
        "status_rollup": {"open": count("open"), "later": count("later"), "acknowledged": count("acknowledged"), "resolved": count("resolved"), "not_applicable": count("not_applicable")},
        "sessions_count": sessions,
        "sample_evidence": samples,
        "read_only": read_only,
        "manual_follow_up": action_capable,
    }))
}

fn safe_findings_report(raw: &Value) -> Value {
    let groups: Vec<Value> = raw.get("groups").and_then(Value::as_array).map(|items| items.iter().filter_map(safe_findings_group).collect()).unwrap_or_default();
    let mut rules: BTreeMap<String, (String, String, u64, u64)> = BTreeMap::new();
    let mut critical = 0u64;
    let mut warning = 0u64;
    let mut info = 0u64;
    let mut sessions = 0u64;
    for group in &groups {
        let rule = group["rule"].as_str().unwrap_or("OTHER").to_string();
        let severity = group["severity"].as_str().unwrap_or("unknown").to_string();
        let hits = group["count"].as_u64().unwrap_or(0);
        let group_sessions = group["sessions_count"].as_u64().unwrap_or(0);
        sessions = sessions.saturating_add(group_sessions);
        match severity.as_str() { "critical" => critical += 1, "warning" => warning += 1, "info" => info += 1, _ => {} }
        let entry = rules.entry(rule.clone()).or_insert((severity.clone(), group["action_kind"].as_str().unwrap_or("other").to_string(), 0, 0));
        entry.2 = entry.2.saturating_add(hits);
        entry.3 = entry.3.saturating_add(group_sessions);
        if severity == "critical" { entry.0 = severity; }
    }
    let page_rule_rows: Vec<Value> = rules.into_iter().map(|(rule, (severity, category, hits, group_sessions))| json!({
        "rule": rule, "severity": severity, "category": category, "hits": hits, "sessions": group_sessions
    })).collect();
    let summary_rule_rows = raw.get("summary_rules").and_then(Value::as_array).map(|rows| rows.iter().filter_map(|row| {
        let raw_rule = row.get("rule").and_then(Value::as_str).unwrap_or("OTHER");
        let rule = safe_findings_rule(raw_rule);
        let category = match row.get("category").and_then(Value::as_str).unwrap_or("other") {
            "behavior" => "behavior", "billing" => "billing", "budget" => "budget", "source" => "source",
            "usage" => "usage", "probe" => "probe", _ => "other",
        };
        let severity = safe_findings_severity(row.get("severity").and_then(Value::as_str).unwrap_or("unknown"));
        let hits = row.get("hits").and_then(Value::as_u64)?;
        let group_sessions = row.get("sessions").and_then(Value::as_u64)?;
        Some(json!({ "rule": rule, "severity": severity, "category": category, "hits": hits.min(1_000_000_000), "sessions": group_sessions.min(1_000_000_000) }))
    }).collect::<Vec<_>>());
    let rule_rows = summary_rule_rows.filter(|rows| !rows.is_empty()).unwrap_or(page_rule_rows);
    let next_cursor = raw.get("next_cursor").and_then(Value::as_str).filter(|value| value.chars().all(|ch| ch.is_ascii_digit())).map(str::to_string);
    let total_groups = raw.get("total_groups").and_then(Value::as_u64).unwrap_or(groups.len() as u64);
    let critical = raw.get("summary_critical").and_then(Value::as_u64).unwrap_or(critical);
    let warning = raw.get("summary_warning").and_then(Value::as_u64).unwrap_or(warning);
    let info = raw.get("summary_info").and_then(Value::as_u64).unwrap_or(info);
    let sessions = raw.get("summary_sessions").and_then(Value::as_u64).unwrap_or(sessions);
    json!({
        "schema_version": "agent-vitals-findings/v1",
        "status": "ok",
        "totals": {"issues": total_groups, "findings": raw.get("source_issue_count").and_then(Value::as_u64).unwrap_or(0), "critical": critical, "warning": warning, "info": info, "sessions": sessions, "sessions_total": sessions},
        "rules": rule_rows, "issues": groups, "next_cursor": next_cursor, "refreshed": false,
    })
}

/// Versioned safe serving face for the React Findings page.  The legacy
/// `sessions_issues` command remains for the old DOM surface; this command is
/// the only allowed React source and never crosses raw samples or identifiers.
#[tauri::command]
pub async fn findings_groups_safe(
    state: tauri::State<'_, StoreBuildLock>,
    page_size: Option<usize>,
    cursor: Option<String>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let path = agent_vitals_data::authority::default_authority_path(&data_home());
        let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
            .map_err(|e| error_value("authority_unavailable", &e.to_string()))?;
        let (from_ms, to_ms) = issue_default_window();
        let raw = agent_vitals_data::issues::issue_groups_with_sources(
            db.conn(), Some(from_ms), Some(to_ms), page_size.unwrap_or(50).clamp(1, 100), cursor.as_deref(),
        ).map_err(|e| error_value("authority_query", &e.to_string()))?;
        Ok(safe_findings_report(&raw))
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

fn budget_issue_group(budget: &Value) -> Value {
    let month = budget["month"].as_str().unwrap_or("<unknown>");
    let level = budget["level"].as_str().unwrap_or("warn");
    let key = format!("budget\0{month}\0{level}");
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let severity = if level == "exceeded" { "critical" } else { "warning" };
    json!({
        "group_id": format!("fnv1a64:{}", agent_vitals_domain::source_identity::fnv1a64_hex(key.as_bytes())),
        "source_kind": "budget", "rule": "BUDGET_THRESHOLD", "harness": "all",
        "object": month, "evidence_class": "budget", "bucket": month,
        "count": 1, "first_seen_at_ms": now_ms, "last_seen_at_ms": now_ms,
        "severity": severity, "status_rollup": {"open": 1, "later": 0, "acknowledged": 0, "resolved": 0, "not_applicable": 0},
        "sessions_count": 0, "sample_evidence": [{"level": level, "month": month,
            "ratio_bp": budget["ratio_bp"], "monthly_cny_minor": budget["monthly_cny_minor"],
            "metered_cny_minor": budget["metered_cny_minor"]}],
        "remedy": {"remedy_id": "review-budget-or-snooze", "diagnostic_only": true},
        "actionability": if level == "exceeded" { 1.0 } else { 0.8 },
        "time": now_ms, "evidence": "budget", "tool_name": "budget",
        "category": "budget", "hits": 1, "sessions": 0,
        "read_only": true
    })
}

/// 「发现」tab ②模型 × Harness 对比的决策面数据（WORKBENCH_FINDINGS_TAB_SPEC
/// §3.2/§5.2）。只读 authority SQL + 计价管线（复用 cost_breakdown 单一价格
/// 事实源），无 CLI spawn（§1.6 性能预算）。
#[tauri::command]
pub async fn decision_matrix(month: Option<String>) -> Result<Value, Value> {
    let month = month.unwrap_or_else(crate::overview::current_month_beijing);
    tauri::async_runtime::spawn_blocking(move || {
        agent_vitals_runtime::decision_matrix::decision_matrix(&data_home(), &month)
            .map_err(|e| error_value("decision_matrix_unavailable", &e))
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

fn safe_matrix_text(value: &str, max_chars: usize) -> String {
    let segments_are_ids = value.split('/').count() <= 2
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '<')
                && segment.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '@' | '+' | '<' | '>'))
        });
    if value.is_empty()
        || value.chars().count() > max_chars
        || value.chars().any(char::is_control)
        || value.starts_with('/')
        || value.contains('\\')
        || value.starts_with("file:")
        || value.as_bytes().get(1).is_some_and(|ch| *ch == b':' && value.as_bytes()[0].is_ascii_alphabetic())
        || value.contains("://")
        || value.contains("..")
        || !segments_are_ids
    {
        "<unknown>".to_string()
    } else {
        value.to_string()
    }
}

fn safe_matrix_ratio(value: Option<&Value>) -> Option<f64> {
    let value = value?.as_f64()?;
    value.is_finite().then_some(value).filter(|value| (0.0..=1.0).contains(value))
}

fn safe_matrix_count(value: Option<&Value>, max: u64) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|value| *value <= max)
}

fn safe_matrix_amount(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    let amount_minor = safe_matrix_count(row.get("amount_minor"), 1_000_000_000_000_000)?;
    let currency = row.get("currency").and_then(Value::as_str)?;
    let currency = if currency.len() <= 12 && currency.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_') {
        currency.to_string()
    } else {
        "<unknown>".to_string()
    };
    let basis = match row.get("basis").and_then(Value::as_str).unwrap_or("other") {
        "metered_actual" | "metered_estimate" | "fixed_subscription" | "api_equivalent" => row["basis"].as_str().unwrap_or("other").to_string(),
        _ => "other".to_string(),
    };
    Some(json!({"amount_minor": amount_minor, "currency": currency, "basis": basis}))
}

fn safe_matrix_session(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    let session_ref = row.get("session_ref").and_then(Value::as_str)?;
    if !safe_matrix_session_ref(session_ref) { return None; }
    let first = safe_matrix_count(row.get("span_first_ms"), 4_102_444_800_000)?;
    let last = safe_matrix_count(row.get("span_last_ms"), 4_102_444_800_000)?;
    if first > last { return None; }
    Some(json!({
        "session_ref": session_ref,
        "span_first_ms": first,
        "span_last_ms": last,
        "tokens_total": safe_matrix_count(row.get("tokens_total"), 1_000_000_000_000_000).unwrap_or(0),
        "failures": safe_matrix_count(row.get("failures"), 1_000_000_000).unwrap_or(0),
    }))
}

fn safe_matrix_session_ref(value: &str) -> bool {
    value.starts_with("sr_") && value.len() <= 128 && value[3..].chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn safe_matrix_row(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    let harness = safe_findings_harness(row.get("harness").and_then(Value::as_str).unwrap_or("generic"));
    let model = safe_matrix_text(row.get("model_id").and_then(Value::as_str).unwrap_or("<unknown>"), 128);
    let provider = safe_matrix_text(row.get("provider_id").and_then(Value::as_str).unwrap_or("<unknown>"), 128);
    let tokens = row.get("tokens").and_then(Value::as_object)?;
    let token_value = |key: &str| safe_matrix_count(tokens.get(key), 1_000_000_000_000_000).unwrap_or(0);
    let amounts = row.get("amounts").and_then(Value::as_array).map(|items| items.iter().take(8).filter_map(safe_matrix_amount).collect::<Vec<_>>()).unwrap_or_default();
    let top_sessions = row.get("top_sessions").and_then(Value::as_array).map(|items| items.iter().take(3).filter_map(safe_matrix_session).collect::<Vec<_>>()).unwrap_or_default();
    let harness_behavior = row.get("harness_behavior").and_then(Value::as_object).map(|items| {
        items.iter().filter_map(|(rule, count)| {
            if matches!(rule.as_str(), "SV607" | "SV608" | "SV610") {
                Some((rule.clone(), json!(safe_matrix_count(Some(count), 1_000_000_000).unwrap_or(0))))
            } else { None }
        }).collect::<serde_json::Map<_, _>>()
    }).unwrap_or_default();
    let limit_pressure = row.get("limit_pressure").and_then(|value| {
        let pressure = value.as_object()?;
        let hits = safe_matrix_count(pressure.get("hits"), 1_000_000_000)?;
        let per_session = pressure.get("per_session").and_then(|value| value.as_f64()).filter(|value| value.is_finite() && *value >= 0.0 && *value <= 1_000_000.0);
        Some(json!({"hits": hits, "per_session": per_session}))
    });
    Some(json!({
        "harness": harness,
        "model_id": model,
        "provider_id": provider,
        "sessions": safe_matrix_count(row.get("sessions"), 1_000_000_000).unwrap_or(0),
        "tokens": {"uncached_input": token_value("uncached_input"), "cache_read": token_value("cache_read"), "cache_write": token_value("cache_write"), "output": token_value("output"), "total": token_value("total")},
        "cache_hit_ratio": safe_matrix_ratio(row.get("cache_hit_ratio")),
        "has_subscription": row.get("has_subscription").and_then(Value::as_bool).unwrap_or(false),
        "waste_rate": safe_matrix_ratio(row.get("waste_rate")),
        "amounts": amounts,
        "top_sessions": top_sessions,
        "harness_behavior": harness_behavior,
        "limit_pressure": limit_pressure,
        "cost_provider_unresolved": row.get("cost_provider_unresolved").and_then(Value::as_bool).unwrap_or(false),
    }))
}

fn safe_matrix_summary(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    let kind = match row.get("kind").and_then(Value::as_str)? {
        "cost_outlier" | "marathon" | "currency_split" => row["kind"].as_str()?.to_string(),
        _ => return None,
    };
    let mut out = serde_json::Map::new();
    out.insert("kind".to_string(), json!(kind));
    if let Some(currency) = row.get("currency").and_then(Value::as_str) { out.insert("currency".to_string(), json!(safe_matrix_text(currency, 12))); }
    if let Some(outlier) = row.get("outlier").and_then(safe_matrix_summary_combo) { out.insert("outlier".to_string(), outlier); }
    if let Some(control) = row.get("control").and_then(safe_matrix_summary_combo) { out.insert("control".to_string(), control); }
    for key in ["ratio_vs_control", "saving_pct", "span_hours"] {
        if let Some(number) = row.get(key).and_then(Value::as_f64).filter(|number| number.is_finite() && *number >= 0.0 && *number <= 1_000_000.0) { out.insert(key.to_string(), json!(number)); }
    }
    for key in ["saving_minor", "tokens_total", "failures"] {
        if let Some(number) = safe_matrix_count(row.get(key), 1_000_000_000_000_000) { out.insert(key.to_string(), json!(number)); }
    }
    if let Some(combo) = row.get("combo").and_then(|combo| {
        let combo = combo.as_object()?;
        Some(json!({"harness": safe_findings_harness(combo.get("harness").and_then(Value::as_str).unwrap_or("generic")), "model_id": safe_matrix_text(combo.get("model_id").and_then(Value::as_str).unwrap_or("<unknown>"), 128)}))
    }) { out.insert("combo".to_string(), combo); }
    if let Some(session_ref) = row.get("session_ref").and_then(Value::as_str).filter(|value| safe_matrix_session_ref(value)) { out.insert("session_ref".to_string(), json!(session_ref)); }
    if let Some(currencies) = row.get("currencies").and_then(Value::as_array) {
        out.insert("currencies".to_string(), json!(currencies.iter().filter_map(|value| value.as_str()).take(8).map(|value| safe_matrix_text(value, 12)).collect::<Vec<_>>()));
    }
    if let Some(by_currency) = row.get("by_currency").and_then(Value::as_object) {
        let safe = by_currency.iter().take(8).map(|(currency, value)| {
            let value = value.as_object();
            (safe_matrix_text(currency, 12), json!({"combos": safe_matrix_count(value.and_then(|item| item.get("combos")), 1_000_000_000).unwrap_or(0), "tokens": safe_matrix_count(value.and_then(|item| item.get("tokens")), 1_000_000_000_000_000).unwrap_or(0)}))
        }).collect::<serde_json::Map<_, _>>();
        out.insert("by_currency".to_string(), Value::Object(safe));
    }
    Some(Value::Object(out))
}

fn safe_matrix_summary_combo(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    Some(json!({
        "harness": safe_findings_harness(row.get("harness").and_then(Value::as_str).unwrap_or("generic")),
        "model_id": safe_matrix_text(row.get("model_id").and_then(Value::as_str).unwrap_or("<unknown>"), 128),
        "provider_id": safe_matrix_text(row.get("provider_id").and_then(Value::as_str).unwrap_or("<unknown>"), 128),
        "per_session_minor": safe_matrix_count(row.get("per_session_minor"), 1_000_000_000_000_000).unwrap_or(0),
        "cache_hit_ratio": safe_matrix_ratio(row.get("cache_hit_ratio")),
        "uncached_tokens": safe_matrix_count(row.get("uncached_tokens"), 1_000_000_000_000_000).unwrap_or(0),
    }))
}

fn safe_decision_matrix(raw: &Value) -> Value {
    let rows = raw.get("rows").and_then(Value::as_array).map(|items| items.iter().take(500).filter_map(safe_matrix_row).collect::<Vec<_>>()).unwrap_or_default();
    let findings_summary = raw.get("findings_summary").and_then(Value::as_array).map(|items| items.iter().take(4).filter_map(safe_matrix_summary).collect::<Vec<_>>()).unwrap_or_default();
    let mut limitations = vec!["waste_rate_unavailable", "harness_behavior_harness_level", "amounts_currency_separated", "fingerprint_link_deferred"];
    for note in raw.get("notes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if note.contains("贡献会话列表不可用") && !limitations.contains(&"top_sessions_unavailable") { limitations.push("top_sessions_unavailable"); }
        if note.contains("计价管线不可用") && !limitations.contains(&"pricing_unavailable") { limitations.push("pricing_unavailable"); }
    }
    json!({
        "schema_version": "agent-vitals-decision-matrix/v1",
        "status": "ok",
        "month": safe_matrix_text(raw.get("month").and_then(Value::as_str).unwrap_or("<unknown>"), 7),
        "rows": rows,
        "findings_summary": findings_summary,
        "limitations": limitations,
    })
}

/// Versioned, allow-listed decision matrix for React. The runtime matrix is
/// already read-only SQL, but this serving face strips notes, native session
/// keys, and any future free-form fields before crossing into the renderer.
#[tauri::command]
pub async fn decision_matrix_safe(month: Option<String>) -> Result<Value, Value> {
    let month = month.unwrap_or_else(crate::overview::current_month_beijing);
    tauri::async_runtime::spawn_blocking(move || {
        let raw = agent_vitals_runtime::decision_matrix::decision_matrix(&data_home(), &month)
            .map_err(|e| error_value("decision_matrix_unavailable", &e))?;
        Ok(safe_decision_matrix(&raw))
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// User-owned Issue state transition. This command only changes the Issue
/// lifecycle in the authority DB; it never edits a harness file or executes a
/// remedy. "acknowledged" is deliberately distinct from "closed".
#[tauri::command]
pub async fn issue_transition(
    state: tauri::State<'_, StoreBuildLock>,
    issue_id: String,
    to_status: String,
    reason: Option<String>,
) -> Result<Value, Value> {
    if issue_id.trim().is_empty() || !matches!(to_status.as_str(), "later" | "acknowledged" | "resolved" | "not_applicable" | "closed" | "wontfix" | "open") {
        return Err(error_value("invalid_issue_transition", "invalid issue id or target status"));
    }
    let reason = reason.unwrap_or_else(|| "user action".to_string());
    if reason.chars().count() > 512 {
        return Err(error_value("invalid_issue_transition", "reason is too long"));
    }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let path = agent_vitals_data::authority::default_authority_path(&data_home());
        let db = agent_vitals_data::authority::AuthorityDb::open(&path, agent_vitals_runtime::sql_sync::now_ms())
            .map_err(|e| error_value("authority_unavailable", &e.to_string()))?;
        let now_ms = agent_vitals_runtime::sql_sync::now_ms();
        let evidence = format!("user-action:{to_status}");
        let input_fingerprint = format!("user-transition:{issue_id}:{to_status}:{reason}");
        let transition_id = db.with_immediate_txn(|conn| {
            agent_vitals_data::issues::transition_issue(
                conn, &issue_id, &to_status, now_ms, &reason, "user",
                &evidence, "user", "v1.0.0", &input_fingerprint,
            ).map_err(agent_vitals_data::authority::AuthorityError::Sqlite)
        }).map_err(|e| error_value("issue_transition_failed", &e.to_string()))?;
        Ok(json!({"status": "ok", "issue_id": issue_id, "to_status": to_status,
            "transition_id": transition_id, "objective_resolution": matches!(to_status.as_str(), "closed" | "resolved")}))
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

#[tauri::command]
pub async fn issue_groups_list(
    state: tauri::State<'_, StoreBuildLock>,
    page_size: Option<usize>,
    cursor: Option<String>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let path = agent_vitals_data::authority::default_authority_path(&data_home());
        let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
            .map_err(|e| error_value("authority_unavailable", &e.to_string()))?;
        let (from_ms, to_ms) = issue_default_window();
        agent_vitals_data::issues::issue_groups_with_sources(
            db.conn(), Some(from_ms), Some(to_ms), page_size.unwrap_or(50), cursor.as_deref(),
        ).map_err(|e| error_value("authority_query", &e.to_string()))
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

#[tauri::command]
pub async fn issue_group_instances(
    state: tauri::State<'_, StoreBuildLock>,
    group_id: String,
    page_size: Option<usize>,
    cursor: Option<String>,
) -> Result<Value, Value> {
    if group_id.trim().is_empty() { return Err(error_value("invalid_issue_group", "group_id is required")); }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let path = agent_vitals_data::authority::default_authority_path(&data_home());
        let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
            .map_err(|e| error_value("authority_unavailable", &e.to_string()))?;
        agent_vitals_data::issues::issue_group_instances(
            db.conn(), &group_id, page_size.unwrap_or(50), cursor.as_deref(),
        ).map_err(|e| error_value("authority_query", &e.to_string()))
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

#[tauri::command]
pub async fn issue_instance_read(
    state: tauri::State<'_, StoreBuildLock>,
    issue_id: String,
) -> Result<Value, Value> {
    if issue_id.trim().is_empty() { return Err(error_value("invalid_issue", "issue_id is required")); }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let path = agent_vitals_data::authority::default_authority_path(&data_home());
        let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
            .map_err(|e| error_value("authority_unavailable", &e.to_string()))?;
        let detail = agent_vitals_data::issues::issue_instance(db.conn(), &issue_id)
            .map_err(|e| error_value("authority_query", &e.to_string()))?;
        Ok(json!({"status": "ok", "issue": detail}))
    }).await.map_err(|e| error_value("cancelled", &e.to_string()))?
}

#[allow(clippy::let_and_return)]
fn issue_group_rollup(issues: &[Value]) -> Vec<Value> {
    let mut by_rule: BTreeMap<String, (String, Option<String>, usize, BTreeSet<String>)> = BTreeMap::new();
    for (index, issue) in issues.iter().enumerate() {
        let rule = issue["rule"].as_str().unwrap_or("unknown").to_string();
        let severity = issue["severity"].as_str().unwrap_or("info").to_string();
        let category = issue["category"].as_str().map(str::to_string);
        let sessions = issue["sessions"].as_u64().unwrap_or(0) as usize;
        let entry = by_rule.entry(rule).or_insert_with(|| (severity.clone(), category.clone(), 0, BTreeSet::new()));
        if issue_severity_rank(&severity) > issue_severity_rank(&entry.0) {
            entry.0 = severity;
        }
        entry.2 += issue["hits"].as_u64().unwrap_or(1) as usize;
        // `sessions` 是每个组内的去重数量；不能用同一组的 0..n
        // 作为全局键，否则不同组会互相覆盖，摘要会低估受影响会话数。
        let group_id = issue["group_id"].as_str().unwrap_or("unknown");
        entry.3.extend((0..sessions).map(|n| format!("{group_id}:{n}:{index}")));
    }
    let rows = by_rule.into_iter().map(|(rule, (severity, category, hits, sessions))| {
        serde_json::json!({
            "rule": rule, "severity": severity, "category": category,
            "hits": hits, "sessions": sessions.len(),
        })
    }).collect();
    rows
}

fn issue_severity_rank(value: &str) -> u8 {
    match value {
        "critical" => 3,
        "warning" => 2,
        "info" => 1,
        _ => 0,
    }
}

// ── Skill 体检 tab（WORKBENCH_SKILL_HEALTH_TAB_SPEC §5）────────────────
//
// 取数路径是一次子进程：`agent-vitals doctor --harness <h|all> --json - --with-report
// --no-snapshot [--self-root …] [--budget …]`。载荷 = 现有 doctor --json 形状
// （diagnostics + not_assessed + report），桌面端只在其中**追加** `desktop_meta`
// （generated_at_ms / from_cache / harness）——字段只增不改，前端据此画「扫描于
// hh:mm · 可能过期」，CLI 合同不被污染。
//
// 纪律（spec §3.6）：扫描是文件系统遍历 + 可能拉起 codex app-server，秒级开销，
// **不进总览的并发命令批**；只在 tab 首次打开（用户点「开始扫描」）/ 点「重新
// 扫描」时跑；结果进程内缓存（与 `codex_merged_cached` 同款 Arc + 时间戳形状）。
// 一次只有一个扫描子进程，运行中的 pid 存在 state 里供取消（kill 子进程）。

/// Skill 体检的进程内状态：最近一次成功载荷缓存 + 运行中子进程 pid。
/// `Clone` 与 `StoreBuildLock` 同款：clone 的是 Arc，状态全局一份。
#[derive(Clone, Default)]
pub struct SkillsScanState(Arc<SkillsScanInner>);

#[derive(Default)]
struct SkillsScanInner {
    cached: Mutex<Option<SkillsDoctorCache>>,
    running_pid: Mutex<Option<u32>>,
}

pub struct SkillsDoctorCache {
    payload: Arc<Value>,
    harness: String,
    self_root: Option<String>,
    budget: Option<i64>,
    generated_at_ms: i64,
}

impl SkillsScanState {
    pub fn new() -> Self {
        Self::default()
    }

    fn inner(&self) -> &SkillsScanInner {
        &self.0
    }

    fn cache_hit(
        &self,
        harness: &str,
        self_root: &Option<String>,
        budget: &Option<i64>,
    ) -> Option<(Arc<Value>, i64)> {
        let g = self.inner().cached.lock().unwrap_or_else(|e| e.into_inner());
        let c = g.as_ref()?;
        let same = c.harness == harness
            && c.self_root == *self_root
            && c.budget == *budget;
        same.then(|| (c.payload.clone(), c.generated_at_ms))
    }

    /// watch-only 消费者的失效入口（P2 watcher）：skills 安装根发生文件
    /// 变更时清掉进程内 doctor 报告缓存——下一次前端刷新必然重扫，而不是
    /// 命中可能已过期的快路径。只清 `cached`，运行中的子进程不受影响。
    pub fn invalidate(&self) {
        let mut g = self.inner().cached.lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }

    fn store(&self, cache: SkillsDoctorCache) -> Arc<Value> {
        let arc = cache.payload.clone();
        *self.inner().cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(cache);
        arc
    }
}

/// `doctor` 子进程的 argv（纯函数，供单测钉住 IPC→CLI 参数映射，与
/// `list_args` 同一纪律）。`--no-snapshot` 恒带：桌面每次刷新若都写快照，
/// 30 份轮换会把 `diff` 的基线冲掉（spec §3.6）；「存为快照」是显式动作
/// （`skills_snapshot_save`）。
fn doctor_args(harness: &str, self_root: &Option<String>, budget: &Option<i64>) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "doctor".into(),
        "--harness".into(),
        harness.into(),
        "--json".into(),
        "-".into(),
        "--with-report".into(),
        "--no-snapshot".into(),
    ];
    if let Some(sr) = self_root {
        if !sr.trim().is_empty() {
            a.push("--self-root".into());
            a.push(sr.clone());
        }
    }
    if let Some(b) = budget {
        a.push("--budget".into());
        a.push(b.to_string());
    }
    a
}

/// doctor 退出码语义（README「CI」契约）：0 = 无发现、1 = **有发现**（不是
/// 错误）、2 = 工具自身错误。前端把 2 渲染成红色 notice 并原样带 stderr 首行，
/// 绝不冒充「没有发现」（spec §7）。
fn doctor_exit_error(status: std::process::ExitStatus, stderr: &str) -> Option<Value> {
    let code = status.code().unwrap_or(2);
    if code <= 1 {
        return None;
    }
    let first = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    Some(error_value(
        "cancelled",
        &format!("agent-vitals doctor failed (exit {code}): {first}"),
    ))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// doctor 子进程的 Command。**stdio 必须显式管道 —— 这是真机空-stdout 事故的修复**：
/// `Command::spawn()` 默认让子进程**继承父进程**的 stdin/stdout/stderr，而
/// `Child::wait_with_output()` 只收集显式管道的流。GUI app 经 `open` 启动后
/// stdout 是 launchd 的黑洞，doctor 的整份报告被写进去，wait_with_output 只
/// 收到 0 字节（exit Some(0)、stderr 空）。`run_json` 用 `.output()`（默认
/// 管道）从未踩过；本路径必须 spawn（取消要拿 pid），所以管道要自己声明。
/// stdin 钉死 null：doctor 不读输入，别让它有机会挂在父进程的终端上。
/// Windows 上 `cli_command` 另加 `CREATE_NO_WINDOW`：管道只解决
/// `wait_with_output` 收得到字节，解决不了控制台窗口闪一下。
fn doctor_command(bin: &Path, args: &[String], home: &Path) -> Command {
    let mut cmd = cli_command(bin);
    cmd.args(args)
        .env("AGENT_VITALS_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Skill 体检取数：一次 doctor 子进程拿 SV 诊断 + 扫描报告（spec §5.1）。
/// 命中缓存（同 harness/self-root/budget）直接返回，`desktop_meta.from_cache=true`；
/// `force=true`（重新扫描按钮）忽略缓存。
#[tauri::command]
pub async fn skills_doctor_report(
    state: tauri::State<'_, StoreBuildLock>,
    scan: tauri::State<'_, SkillsScanState>,
    harness: Option<String>,
    self_root: Option<String>,
    budget: Option<i64>,
    force: Option<bool>,
) -> Result<Value, Value> {
    let harness = harness.unwrap_or_else(|| "all".into());
    let self_root = self_root.filter(|s| !s.trim().is_empty());
    if !force.unwrap_or(false) {
        if let Some((payload, at)) = scan.cache_hit(&harness, &self_root, &budget) {
            let mut v = (*payload).clone();
            v["desktop_meta"] = json!({
                "generated_at_ms": at, "from_cache": true, "harness": harness,
            });
            return Ok(v);
        }
    }
    let lock = state.inner().clone();
    let scan = scan.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else {
            return Err(no_binary());
        };
        let args = doctor_args(&harness, &self_root, &budget);
        let mut cmd = doctor_command(&bin, &args, &data_home());
        let child = cmd.spawn().map_err(|e| error_value("cancelled", &e.to_string()))?;
        *scan.inner().running_pid.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
        let out = child.wait_with_output();
        *scan.inner().running_pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let out = out.map_err(|e| error_value("cancelled", &e.to_string()))?;
        if let Some(err) = doctor_exit_error(out.status, &String::from_utf8_lossy(&out.stderr)) {
            return Err(err);
        }
        let mut payload: Value = serde_json::from_slice(&out.stdout).map_err(|e| {
            // 退出码 0/1 但 stdout 不是合法 JSON：把排障需要的现场全部带上 ——
            // 实际解析到的二进制（resolve_binary 的候选不止一处）、退出码、
            // stdout 字节数、stderr 首行。只回一句 serde 的「EOF at column 0」
            // 会把「stdout 为空」这个最重要的事实藏掉。
            let stderr_head = String::from_utf8_lossy(&out.stderr);
            let stderr_head = stderr_head.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            error_value(
                "cancelled",
                &format!(
                    "doctor 输出解析失败（bin: {}，exit: {:?}，stdout {} 字节，stderr 首行: {}）：{}",
                    bin.display(),
                    out.status.code(),
                    out.stdout.len(),
                    if stderr_head.is_empty() { "（空）" } else { stderr_head },
                    e,
                ),
            )
        })?;
        let generated_at_ms = now_ms();
        payload["desktop_meta"] = json!({
            "generated_at_ms": generated_at_ms, "from_cache": false, "harness": harness,
        });
        let arc = scan.store(SkillsDoctorCache {
            payload: Arc::new(payload.clone()),
            harness,
            self_root,
            budget,
            generated_at_ms,
        });
        Ok((*arc).clone())
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// 取消正在跑的扫描（spec §7「扫描中…可取消」）：kill 子进程。返回是否真有
/// 子进程被杀（前端据此决定要不要复位 UI）。
#[tauri::command]
pub async fn skills_scan_cancel(scan: tauri::State<'_, SkillsScanState>) -> Result<bool, Value> {
    // State::inner() 返回 &SkillsScanState；包装的内部状态走 .0（Arc）。
    let pid = scan
        .0
        .running_pid
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let Some(pid) = pid else { return Ok(false) };
    let killed = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    Ok(killed)
}

/// Skill 体检的两项可选设置（spec §10 v1-4）：agent-vitals 自身 skill 目录
/// （透传 `--self-root`；不填就照扫，靠 cited 排序 —— 不做按名字豁免）与
/// 描述预算覆盖（高级；空 = CLI 默认）。落 `<AGENT_VITALS_HOME>/desktop/
/// skills-scan.json`，与其它桌面设置同款：用户显式保存，子进程每次透传。
fn skills_settings_path() -> std::path::PathBuf {
    data_home().join("desktop").join("skills-scan.json")
}

#[tauri::command]
pub fn skills_scan_settings() -> Value {
    match std::fs::read(skills_settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(json!({
            "self_root": "", "budget": null,
        })),
        Err(_) => json!({ "self_root": "", "budget": null }),
    }
}

#[tauri::command]
pub fn save_skills_scan_settings(self_root: String, budget: Option<i64>) -> Result<Value, Value> {
    let path = skills_settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| error_value("cancelled", &e.to_string()))?;
    }
    // budget ≤ 0 会算出负百分比垃圾（CLI 的 non_negative 同款守卫），拒绝。
    if let Some(b) = budget {
        if b <= 0 {
            return Err(error_value("invalid_budget", "budget must be a positive integer"));
        }
    }
    let doc = json!({ "self_root": self_root.trim(), "budget": budget });
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap_or_default())
        .map_err(|e| error_value("cancelled", &e.to_string()))?;
    Ok(json!({ "status": "saved", "path": path.to_string_lossy() }))
}

/// `agent-vitals snapshot` 的 argv。快照落 `<AGENT_VITALS_HOME>/snapshots`，
/// 与 CLI 完全共用目录与 keep 语义（spec §3.6）。
fn snapshot_args() -> Vec<String> {
    vec!["snapshot".into()]
}

/// 「存为快照」：显式动作（与恒带 --no-snapshot 的扫描分开）。快照本身是
/// 未脱敏本机基线，CLI 输出可能包含绝对路径、用户名和 skill 描述；这些内容
/// 不属于 WebView 合同，因此成功回执只返回状态和“不上传”事实。
#[tauri::command]
pub async fn skills_snapshot_save(
    state: tauri::State<'_, StoreBuildLock>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else {
            return Err(no_binary());
        };
        let mut cmd = cli_command(&bin);
        cmd.args(snapshot_args());
        cmd.env("AGENT_VITALS_HOME", data_home());
        let out = cmd
            .output()
            .map_err(|_| error_value("storage_failed", "snapshot process could not be started"))?;
        if !out.status.success() {
            return Err(error_value("storage_failed", "snapshot command failed"));
        }
        Ok(skills_snapshot_saved_receipt())
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

fn skills_snapshot_saved_receipt() -> Value {
    json!({ "status": "saved", "upload_performed": false })
}

fn safe_skill_diff_label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty()
        || text.len() > 160
        || text.chars().any(|ch| ch.is_control())
        || text.starts_with('/')
        || text.starts_with('~')
        || text.contains('/')
        || text.contains("\\")
        || text.contains("://")
        || text.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    Some(text.to_string())
}

fn safe_skill_diff_identity(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let harness = safe_skill_diff_label(object.get("harness"))?;
    let name = safe_skill_diff_label(object.get("name"))?;
    let mut output = serde_json::Map::new();
    output.insert("harness".into(), Value::String(harness));
    output.insert("name".into(), Value::String(name));
    if let Some(namespace) = safe_skill_diff_label(object.get("namespace")) {
        output.insert("namespace".into(), Value::String(namespace));
    }
    if let Some(instance_id) = safe_skill_diff_label(object.get("instance_id")) {
        output.insert("instance_id".into(), Value::String(instance_id));
    }
    Some(Value::Object(output))
}

fn safe_skill_diff_number(value: Option<&Value>, max: i64) -> Option<Value> {
    let number = value?.as_i64()?;
    (number.unsigned_abs() <= max as u64).then_some(Value::Number(number.into()))
}

fn safe_skill_diff_nonnegative_number(value: Option<&Value>, max: i64) -> Option<Value> {
    let number = value?.as_i64()?;
    (number >= 0 && number <= max).then_some(Value::Number(number.into()))
}

const SKILL_DIFF_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

fn read_skill_diff_output<R: Read>(mut reader: R) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((SKILL_DIFF_OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > SKILL_DIFF_OUTPUT_LIMIT;
    if truncated {
        bytes.truncate(SKILL_DIFF_OUTPUT_LIMIT);
    }
    Ok((bytes, truncated))
}

fn safe_skill_diff_report(raw: &Value) -> Option<Value> {
    let object = raw.as_object()?;
    let mut output = serde_json::Map::new();
    output.insert("schema_version".into(), Value::String("skills-diff-v1".into()));
    output.insert("baseline_available".into(), Value::Bool(true));
    let mut dropped_rows = 0usize;
    let mut truncated = false;
    let mut invalid_optional = false;
    for key in ["added_skills", "removed_skills"] {
        let rows = object.get(key)?.as_array()?;
        truncated |= rows.len() > 256;
        let safe_rows: Vec<Value> = rows.iter().take(256).filter_map(safe_skill_diff_identity).collect();
        dropped_rows = dropped_rows.saturating_add(rows.len().saturating_sub(safe_rows.len()));
        output.insert(key.into(), Value::Array(safe_rows));
    }
    let usage = object.get("usage_delta")?.as_array()?;
    truncated |= usage.len() > 256;
    let safe_usage: Vec<Value> = usage.iter().take(256).filter_map(|row| {
        let mut safe = safe_skill_diff_identity(row)?.as_object()?.clone();
        let object = row.as_object()?;
        safe.insert("delta".into(), safe_skill_diff_number(object.get("delta"), 1_000_000)?);
        safe.insert("now".into(), safe_skill_diff_nonnegative_number(object.get("now"), 1_000_000)?);
        Some(Value::Object(safe))
    }).collect();
    dropped_rows = dropped_rows.saturating_add(usage.len().saturating_sub(safe_usage.len()));
    output.insert("usage_delta".into(), Value::Array(safe_usage));
    let newly = object.get("newly_judgeable")?.as_array()?;
    truncated |= newly.len() > 256;
    let safe_newly: Vec<Value> = newly.iter().take(256).filter_map(|row| {
        let mut safe = safe_skill_diff_identity(row)?.as_object()?.clone();
        let object = row.as_object()?;
        for key in ["usage_count", "installed_days_ago"] {
            if let Some(number) = safe_skill_diff_nonnegative_number(object.get(key), 100_000) {
                safe.insert(key.into(), number);
            } else if object.get(key).is_some() {
                invalid_optional = true;
            }
        }
        let verdict = object.get("verdict").and_then(Value::as_str);
        if matches!(verdict, Some("zombie") | Some("alive")) {
            safe.insert("verdict".into(), Value::String(verdict.unwrap().into()));
        }
        Some(Value::Object(safe))
    }).collect();
    dropped_rows = dropped_rows.saturating_add(newly.len().saturating_sub(safe_newly.len()));
    output.insert("newly_judgeable".into(), Value::Array(safe_newly));
    let overlaps = object.get("new_overlap_candidates")?.as_array()?;
    truncated |= overlaps.len() > 256;
    let safe_overlaps: Vec<Value> = overlaps.iter().take(256).filter_map(|pair| {
        let pair = pair.as_array()?;
        if pair.len() != 2 { return None; }
        Some(Value::Array(vec![
            Value::String(safe_skill_diff_label(pair.first())?),
            Value::String(safe_skill_diff_label(pair.get(1))?),
        ]))
    }).collect();
    dropped_rows = dropped_rows.saturating_add(overlaps.len().saturating_sub(safe_overlaps.len()));
    output.insert("new_overlap_candidates".into(), Value::Array(safe_overlaps));
    let security = object.get("new_security_findings")?.as_array()?;
    truncated |= security.len() > 256;
    let safe_security: Vec<Value> = security.iter().take(256).filter_map(|row| {
        let object = row.as_object()?;
        let skill = safe_skill_diff_label(object.get("skill"))?;
        let rule = safe_skill_diff_label(object.get("rule"))?;
        let line = safe_skill_diff_nonnegative_number(object.get("line"), 1_000_000)?;
        Some(json!({"skill": skill, "rule": rule, "line": line}))
    }).collect();
    dropped_rows = dropped_rows.saturating_add(security.len().saturating_sub(safe_security.len()));
    output.insert("new_security_findings".into(), Value::Array(safe_security));
    if let Some(delta) = safe_skill_diff_number(object.get("budget_delta_chars"), 100_000_000) {
        output.insert("budget_delta_chars".into(), delta);
    }
    if let Some(values) = object.get("budget_pct_then_now").and_then(Value::as_array) {
        let safe_values: Vec<Value> = values.iter().take(2).filter_map(|value| {
            if value.is_null() { return Some(Value::Null); }
            let number = value.as_f64()?;
            (number.is_finite() && number.abs() <= 100_000.0).then_some(json!(number))
        }).collect();
        if safe_values.len() == 2 { output.insert("budget_pct_then_now".into(), Value::Array(safe_values)); }
        else { invalid_optional = true; }
    }
    if let Some(values) = object.get("loaded_then_now").and_then(Value::as_array) {
        let safe_values: Vec<Value> = values.iter().take(2).filter_map(|value| safe_skill_diff_nonnegative_number(Some(value), 1_000_000)).collect();
        if safe_values.len() == 2 { output.insert("loaded_then_now".into(), Value::Array(safe_values)); }
        else { invalid_optional = true; }
    }
    output.insert("summary".into(), json!({
        "added": output.get("added_skills").and_then(Value::as_array).map_or(0, Vec::len),
        "removed": output.get("removed_skills").and_then(Value::as_array).map_or(0, Vec::len),
        "usage_changed": output.get("usage_delta").and_then(Value::as_array).map_or(0, Vec::len),
        "newly_judgeable": output.get("newly_judgeable").and_then(Value::as_array).map_or(0, Vec::len),
        "new_overlap_candidates": output.get("new_overlap_candidates").and_then(Value::as_array).map_or(0, Vec::len),
        "new_security_findings": output.get("new_security_findings").and_then(Value::as_array).map_or(0, Vec::len),
    }));
    output.insert("dropped_rows".into(), json!(dropped_rows));
    output.insert("truncated".into(), Value::Bool(truncated));
    output.insert("status".into(), Value::String(if truncated || dropped_rows > 0 || invalid_optional { "partial" } else { "ok" }.into()));
    Some(Value::Object(output))
}

/// 「与上次快照对比」：`agent-vitals diff --json -`（无文件参数 → CLI 自动回退
/// 最新快照；`-` → diff_vs_baseline 块写 stdout）。无基线时 CLI exit 2 且
/// stderr 只映射为受控错误码；路径、文件名和原始 CLI 输出不进入 WebView。
/// 没有快照是前置条件缺失，不冒充「没有变化」（render_diff 的规矩，spec §6.6）。
#[tauri::command]
pub async fn skills_diff_latest(
    state: tauri::State<'_, StoreBuildLock>,
) -> Result<Value, Value> {
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else {
            return Err(no_binary());
        };
        let mut cmd = cli_command(&bin);
        cmd.args(vec!["diff", "--json", "-"]);
        cmd.env("AGENT_VITALS_HOME", data_home())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|_| error_value("process_unavailable", "Skill 对比进程无法启动"))?;
        let stdout = child.stdout.take().ok_or_else(|| error_value("process_unavailable", "Skill 对比输出不可读取"))?;
        let stdout_reader = std::thread::spawn(move || read_skill_diff_output(stdout));
        let (stdout_bytes, stdout_truncated) = stdout_reader
            .join()
            .map_err(|_| error_value("process_unavailable", "Skill 对比输出读取失败"))?
            .map_err(|_| error_value("process_unavailable", "Skill 对比输出读取失败"))?;
        if stdout_truncated {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error_value("output_too_large", "Skill 对比结果超过本机安全上限"));
        }
        let status = child
            .wait()
            .map_err(|_| error_value("process_unavailable", "Skill 对比进程状态不可读取"))?;
        if !status.success() {
            return Err(error_value("diff_unavailable", "没有可比较的本机 Skill 快照"));
        }
        let raw: Value = serde_json::from_slice(&stdout_bytes)
            .map_err(|_| error_value("diff_unavailable", "Skill 对比结果不可读取"))?;
        safe_skill_diff_report(&raw)
            .ok_or_else(|| error_value("diff_unavailable", "Skill 对比结果格式不可用"))
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

/// 「导出脱敏 JSON」第一步：弹保存对话框拿目标路径（同步命令，与设置页
/// `export_diagnostic_package` 同款）。取消 → `{"status":"cancelled"}`，前端
/// 视为 no-op。
#[tauri::command]
pub fn skills_export_pick_path() -> Value {
    let Some(path) = rfd::FileDialog::new()
        .set_file_name("agent-vitals-skills-redacted.json")
        .save_file()
    else {
        return json!({ "status": "cancelled" });
    };
    json!({ "status": "picked", "path": path.to_string_lossy() })
}

/// 「导出脱敏 JSON」第二步：重跑一次 doctor，恒带 `--redact --redact-names`，把脱敏
/// 载荷写到用户选的路径。与
/// 设置页脱敏诊断包同一纪律：用户主动保存、不自动上传。
#[tauri::command]
pub async fn skills_export_redacted(
    state: tauri::State<'_, StoreBuildLock>,
    path: String,
    self_root: Option<String>,
) -> Result<Value, Value> {
    if path.trim().is_empty() {
        return Err(error_value("invalid_path", "path is required"));
    }
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else {
            return Err(no_binary());
        };
        let sr = self_root.filter(|s| !s.trim().is_empty());
        let mut args = doctor_args("all", &sr, &None);
        args.push("--redact".into());
        args.push("--redact-names".into());
        let mut cmd = cli_command(&bin);
        cmd.args(&args);
        cmd.env("AGENT_VITALS_HOME", data_home());
        let out = cmd
            .output()
            .map_err(|e| error_value("cancelled", &e.to_string()))?;
        if let Some(err) = doctor_exit_error(out.status, &String::from_utf8_lossy(&out.stderr)) {
            return Err(err);
        }
        // 载荷原样落盘（stdout 就是完整 JSON；doctor exit 0/1 的 stdout 相同）
        std::fs::write(&path, &out.stdout)
            .map_err(|e| error_value("cancelled", &e.to_string()))?;
        Ok(json!({"status": "saved", "path": path, "upload_performed": false}))
    })
    .await
    .map_err(|e| error_value("cancelled", &e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_snapshot_receipt_never_contains_cli_output_or_path() {
        let receipt = skills_snapshot_saved_receipt();
        assert_eq!(receipt, json!({ "status": "saved", "upload_performed": false }));
        assert!(receipt.get("output").is_none());
        assert!(receipt.get("path").is_none());
    }

    #[test]
    fn skills_diff_projection_drops_paths_and_marks_partial_rows() {
        let raw = json!({
            "baseline_file": "/Users/Admin/.agent-vitals/snapshots/private.json",
            "added_skills": [{"harness": "claude-code", "name": "safe-skill", "namespace": null, "instance_id": null}, {"harness": "claude-code", "name": "/Users/Admin/private-skill"}],
            "removed_skills": [],
            "usage_delta": [],
            "newly_judgeable": [],
            "new_overlap_candidates": [],
            "new_security_findings": [{"skill": "safe-skill", "rule": "SV501", "where": "/Users/Admin/SKILL.md", "line": 12}],
            "budget_delta_chars": 4,
            "budget_pct_then_now": [1.0, 2.0],
            "loaded_then_now": [1, 2],
        });
        let projected = safe_skill_diff_report(&raw).expect("safe diff projection");
        assert_eq!(projected["status"], "partial");
        assert_eq!(projected["dropped_rows"], 1);
        assert!(projected.get("baseline_file").is_none());
        assert!(projected["new_security_findings"][0].get("where").is_none());
        assert!(!projected.to_string().contains("/Users/Admin"));

        for unsafe_name in ["file:///Users/Admin/private", "C:/Users/Admin/private", "relative/path", "skill /Users/Admin/private"] {
            let raw = json!({
                "added_skills": [{"harness": "claude-code", "name": unsafe_name}],
                "removed_skills": [], "usage_delta": [], "newly_judgeable": [],
                "new_overlap_candidates": [], "new_security_findings": [],
            });
            let projected = safe_skill_diff_report(&raw).expect("safe diff projection");
            assert_eq!(projected["status"], "partial");
            assert_eq!(projected["dropped_rows"], 1);
        }
    }

    #[test]
    fn safe_findings_projection_is_allowlisted_and_drops_nested_sensitive_values() {
        let raw = json!({
            "group_id": "fnv1a64:0123456789abcdef",
            "source_kind": "billing_candidate",
            "rule": "PRICE_COVERAGE",
            "harness": "minimax-code",
            "object": "/Users/Admin/project/private.rs",
            "evidence_class": "billing",
            "count": 1,
            "first_seen_at_ms": 10,
            "last_seen_at_ms": 20,
            "severity": "warning",
            "status_rollup": {"open": 1, "later": 0, "acknowledged": 0, "resolved": 0, "not_applicable": 0},
            "sessions_count": 1,
            "sample_evidence": [{"issue_id": "fnv1a64:aaaaaaaaaaaaaaaa", "source_id": "source-secret", "run_id": "run-secret", "detail": {"path": "/private", "token": "secret"}}],
            "remedy": {"remedy_id": "diagnostic-only", "diagnostic_only": true},
            "nested_detail_json": {"session_key": "native-secret", "command": "tar private"},
        });
        let projected = safe_findings_group(&raw).expect("valid safe group");
        let object = projected.as_object().expect("object projection");
        let keys: BTreeSet<&str> = object.keys().map(String::as_str).collect();
        let expected: BTreeSet<&str> = [
            "group_id", "rule", "harness", "action_kind", "evidence_class", "count",
            "first_seen_at_ms", "last_seen_at_ms", "severity", "status_rollup",
            "sessions_count", "sample_evidence", "read_only", "manual_follow_up",
        ].into_iter().collect();
        assert_eq!(keys, expected);
        let serialized = projected.to_string();
        for secret in ["private.rs", "source-secret", "run-secret", "native-secret", "tar private", "secret"] {
            assert!(!serialized.contains(secret), "sensitive value leaked: {secret}");
        }
        assert_eq!(projected["sample_evidence"][0]["available"], true);
        assert!(projected["sample_evidence"][0]["reference"].as_str().unwrap().starts_with("fnv1a64:"));
        assert_eq!(projected["sample_evidence"][0]["observed_first_at_ms"], 10);
        assert_eq!(projected["sample_evidence"][0]["evidence_level"], Value::Null);
        assert_eq!(projected["sample_evidence"][0]["scope_classes"], json!([]));
        assert_eq!(projected["action_kind"], "billing");
    }

    #[test]
    fn safe_findings_projection_degrades_unknown_enums_to_bounded_values() {
        let raw = json!({
            "group_id": "fnv1a64:0123456789abcdef", "source_kind": "unknown-source",
            "rule": "evil\nrule", "harness": "/private/path", "evidence_class": "command --token",
            "count": 1, "first_seen_at_ms": 1, "last_seen_at_ms": 1, "severity": "evil",
            "status_rollup": {}, "sessions_count": 0, "sample_evidence": [],
            "remedy": {"diagnostic_only": true},
        });
        let projected = safe_findings_group(&raw).expect("safe group remains visible");
        assert_eq!(projected["rule"], "OTHER");
        assert_eq!(projected["harness"], "generic");
        assert_eq!(projected["evidence_class"], "generic");
        assert_eq!(projected["severity"], "unknown");
        assert_eq!(projected["action_kind"], "other");
    }

    #[test]
    fn safe_findings_report_keeps_paginated_summary_stable_and_sanitized() {
        let raw = json!({
            "groups": [], "total_groups": 101, "source_issue_count": 77,
            "summary_critical": 4, "summary_warning": 9, "summary_info": 2,
            "summary_sessions": 33,
            "summary_rules": [
                {"rule": "SV709", "severity": "critical", "category": "behavior", "hits": 14, "sessions": 8},
                {"rule": "evil/path", "severity": "warning", "category": "private", "hits": 99_999_999_999u64, "sessions": 7},
            ],
        });
        let projected = safe_findings_report(&raw);
        assert_eq!(projected["totals"]["issues"], 101);
        assert_eq!(projected["totals"]["critical"], 4);
        assert_eq!(projected["totals"]["sessions"], 33);
        assert_eq!(projected["rules"][0]["rule"], "SV709");
        assert_eq!(projected["rules"][1]["rule"], "OTHER");
        assert_eq!(projected["rules"][1]["category"], "other");
        assert_eq!(projected["rules"][1]["hits"], 1_000_000_000u64);
        assert!(!projected.to_string().contains("evil/path"));
    }

    #[test]
    fn safe_findings_projection_exposes_only_bounded_evidence_context() {
        let raw = json!({
            "group_id": "fnv1a64:0123456789abcdef", "source_kind": "behavior",
            "rule": "SV709", "harness": "plugin:zcode", "evidence_class": "egress",
            "count": 2, "first_seen_at_ms": 10, "last_seen_at_ms": 30,
            "severity": "critical", "status_rollup": {}, "sessions_count": 1,
            "sample_evidence": [{"issue_id": "native-secret", "evidence": "secret command",
                "metadata": {"stage": "egress_attempted", "evidence_level": "E3",
                    "evidence_origin": "network_metadata", "confidence": "high",
                    "destination_class": "object_storage", "scope_classes": ["git_history", "/private/path"],
                    "observation_count": 2, "file_count": 4, "byte_count": 1234,
                    "first_observed_at_ms": 10, "last_observed_at_ms": 30,
                    "native_event_id": "native-secret"}}],
        });
        let projected = safe_findings_group(&raw).expect("valid safe group");
        let sample = &projected["sample_evidence"][0];
        assert_eq!(sample["evidence_level"], "E3");
        assert_eq!(sample["stage"], "egress_attempted");
        assert_eq!(sample["destination_class"], "object_storage");
        assert_eq!(sample["scope_classes"], json!(["git_history"]));
        assert_eq!(sample["observation_count"], 2);
        assert_eq!(sample["file_count"], 4);
        assert_eq!(sample["byte_count"], 1234);
        let serialized = sample.to_string();
        for secret in ["native-secret", "secret command", "/private/path"] {
            assert!(!serialized.contains(secret), "evidence context leaked: {secret}");
        }
    }

    #[test]
    fn safe_findings_projection_preserves_dynamic_plugin_harnesses_and_rejects_bad_ranges() {
        let plugin = json!({
            "group_id": "fnv1a64:0123456789abcdef", "source_kind": "behavior",
            "rule": "SV709", "harness": "plugin:zcode", "evidence_class": "egress",
            "count": 1, "first_seen_at_ms": 10, "last_seen_at_ms": 20,
            "severity": "critical", "status_rollup": {}, "sessions_count": 1,
            "sample_evidence": [],
        });
        assert_eq!(safe_findings_group(&plugin).expect("valid plugin group")["harness"], "plugin:zcode");

        let invalid_range = json!({
            "group_id": "fnv1a64:0123456789abcdef", "source_kind": "behavior",
            "rule": "SV709", "harness": "plugin:../escape", "evidence_class": "egress",
            "count": 1, "first_seen_at_ms": 20, "last_seen_at_ms": 10,
            "severity": "critical", "status_rollup": {}, "sessions_count": 1,
            "sample_evidence": [],
        });
        assert!(safe_findings_group(&invalid_range).is_none());
    }

    #[test]
    fn safe_decision_matrix_projection_is_versioned_and_drops_native_fields() {
        let raw = json!({
            "month": "2026-09",
            "rows": [{
                "harness": "plugin:zcode", "model_id": "/Users/Admin/private", "provider_id": "https://evil.example",
                "sessions": 2, "tokens": {"uncached_input": 10, "cache_read": 20, "cache_write": 0, "output": 4, "total": 34},
                "cache_hit_ratio": 0.6667, "has_subscription": false, "waste_rate": null,
                "amounts": [{"amount_minor": 100, "currency": "CNY", "basis": "metered_estimate", "secret": "/private"}],
                "top_sessions": [{"session_ref": "sr_0123456789", "session_key": "native-session-secret", "span_first_ms": 10, "span_last_ms": 20, "tokens_total": 34, "failures": 1}],
                "harness_behavior": {"SV610": 2, "EVIL": 99}, "limit_pressure": null,
                "cost_provider_unresolved": false, "path": "/Users/Admin/private",
            }],
            "findings_summary": [{"kind": "marathon", "currency": "C:/Users/Admin/private", "session_ref": "sr_0123456789", "span_hours": 25.0, "tokens_total": 34, "failures": 1, "combo": {"harness": "plugin:zcode", "model_id": "file:/tmp/secret", "native": "/private"}}],
            "notes": ["贡献会话列表不可用（session_ref salt：/private/path）", "raw note secret"],
        });
        let projected = safe_decision_matrix(&raw);
        assert_eq!(projected["schema_version"], "agent-vitals-decision-matrix/v1");
        assert_eq!(projected["rows"][0]["harness"], "plugin:zcode");
        assert_eq!(projected["rows"][0]["model_id"], "<unknown>");
        assert_eq!(projected["rows"][0]["provider_id"], "<unknown>");
        assert_eq!(projected["rows"][0]["harness_behavior"]["SV610"], 2);
        assert!(projected["rows"][0]["harness_behavior"].get("EVIL").is_none());
        assert!(projected.to_string().contains("top_sessions"));
        for secret in ["native-session-secret", "/Users/Admin/private", "raw note secret", "secret"] {
            assert!(!projected.to_string().contains(secret), "matrix secret leaked: {secret}");
        }
        assert!(projected["limitations"].as_array().unwrap().iter().any(|item| item == "top_sessions_unavailable"));
        assert_eq!(projected["findings_summary"][0]["currency"], "<unknown>");
        assert_eq!(projected["findings_summary"][0]["combo"]["model_id"], "<unknown>");
    }

    #[test]
    fn safe_runtime_snapshot_projection_drops_internal_notification_keys() {
        let raw = json!({
            "capability": "macos_lsof_partial", "candidate_processes": 2, "observations": 3,
            "inserted": 3, "duplicate": 0, "findings_upserted": 1,
            "notification_candidates": 1, "evidence_links_added": 2,
            "notification_keys": ["trust_internal_instance_secret"],
            "path": "/Users/Admin/private", "command": "agent --token secret",
        });
        let projected = safe_trust_runtime_snapshot(&raw);
        assert_eq!(projected["capability"], "macos_lsof_partial");
        assert_eq!(projected["observations"], 3);
        assert!(projected.get("notification_keys").is_none());
        for secret in ["trust_internal_instance_secret", "/Users/Admin/private", "agent --token secret"] {
            assert!(!projected.to_string().contains(secret), "runtime snapshot secret leaked: {secret}");
        }
    }

    /// list_args 字段集是 v0.9.1 收口后的精简版：旧 CLI 用的 `--model` / `--from`
    /// / `--to` / `--query` 已删（权威库 sessions_search 不收这四件；list_args 模块头
    /// 注释解释为什么）。本测试盯住「只能出这四个 flag + day/month 兜底」，防 PR 后
    /// 有人手快把旧 flag 加回来。
    ///
    /// 「空 filter」分支今天北京日期不是字面常量——拆成两条：(a) 全字段用显式
    /// day 字面量钉住 argv 顺序；(b) `day/month: None` 分支断言「`--day` 始终在场、
    /// 值是 YYYY-MM-DD」，不锁具体日期（系统时钟会让这条用例 false-fail）。
    #[test]
    fn list_args_full() {
        let some = &Some("x".to_string());
        assert_eq!(
            list_args(some, &None, some, &None, &Some("x".to_string()), &None, &None, Some(7), &Some("c".to_string()), &None),
            vec!["sessions", "list", "--json",
                 "--day", "x", "--harness-kind", "x", "--page-size", "7",
                 "--cursor", "c"]
        );
    }

    /// `order=oldest`：City 一年窗口从最老会话开始分页的 argv 面。默认
    /// （None / "tokens"）不出现 `--order`——既有调用方的 argv 字节序不变。
    #[test]
    fn list_args_order_oldest_opt_in() {
        let none = &None;
        assert_eq!(
            list_args(&None, &None, &Some("2026-07-04".into()), &Some("2026-10-02".into()), none, none, none, Some(496), &None, &Some("oldest".into())),
            vec!["sessions", "list", "--json",
                 "--from-date", "2026-07-04", "--to-date", "2026-10-02",
                 "--page-size", "496", "--order", "oldest"]
        );
        assert_eq!(
            list_args(&None, &None, &Some("2026-07-04".into()), &Some("2026-10-02".into()), none, none, none, Some(496), &None, &Some("tokens".into())),
            vec!["sessions", "list", "--json",
                 "--from-date", "2026-07-04", "--to-date", "2026-10-02",
                 "--page-size", "496"]
        );
    }

    /// `month` 模式：用户从前端 month picker 选了一个月 → IPC 透传 `month` →
    /// argv 必须有 `--month YYYY-MM`，没有 `--day`。这是修「工作台会话 tab 只
    /// 看得到今天」的关键——month 是 day 的替代窗口，不是补充。
    #[test]
    fn list_args_month_mode_emits_month_flag_only() {
        assert_eq!(
            list_args(&None, &Some("2026-08".to_string()), &None, &None, &None, &None, &None, None, &None, &None),
            vec!["sessions", "list", "--json", "--month", "2026-08"]
        );
    }

    /// month + day 同传：month 优先（更粗、用户主动选择；day 是默认兜底）。
    /// 这条排序锁住 IPC bug 容错面——前端若哪天误传两个，行为可预测。
    #[test]
    fn list_args_month_takes_precedence_over_day() {
        assert_eq!(
            list_args(
                &Some("2026-08-15".to_string()),
                &Some("2026-08".to_string()),
                &None, &None, &None, &None, &None, None, &None, &None,
            ),
            vec!["sessions", "list", "--json",
                 "--month", "2026-08"]
        );
    }

    /// month 模式 + 其它过滤：harness-kind / page-size / cursor 仍可叠加。
    /// 钉住「month 不是全替换、是个独立的窗口选择」。
    #[test]
    fn list_args_month_with_filters() {
        assert_eq!(
            list_args(
                &None,
                &Some("2026-08".to_string()),
                &None, &None, &Some("dsh".to_string()), &None, &None,
                Some(100), &None, &None,
            ),
            vec!["sessions", "list", "--json",
                 "--month", "2026-08",
                 "--harness-kind", "dsh",
                 "--page-size", "100"]
        );
    }

    /// `day: None` 且 `month: None` → argv 必须含 `--day` + YYYY-MM-DD 字串
    /// （兜底为今天）。CLI 拒绝「无 day 无 month」（mutex 不允许两个都缺）；
    /// IPC 不替前端报错而是补一个今天的 `--day` —— 这一行是契约面。
    #[test]
    fn list_args_default_day_is_today() {
        let a = list_args(&None, &None, &None, &None, &None, &None, &None, None, &None, &None);
        // 第一段固定
        assert_eq!(&a[0..3], &["sessions", "list", "--json"]);
        // --day 必须紧跟固定段（位置由 list_args 保证）
        assert_eq!(a[3], "--day");
        // 值是 YYYY-MM-DD 格式（不锁具体日期——系统时钟会让这条用例 false-fail）
        let d = &a[4];
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
        for c in d.chars() {
            assert!(c.is_ascii_digit() || c == '-', "non-digit/dash in day: {d}");
        }
    }

    /// 单测自己用的常量时钟：让 `list_args_default_day_is_today_clock_pinned` 不依赖
    /// 真实系统时间（避免跨日 CI 抖动）。当前 list_args 内部直接调 std time；这
    /// 里**只**断言「今天日期格式正确」（不锁字面量），跨日仍绿。
    #[test]
    fn beijing_today_returns_yyyy_mm_dd_format() {
        let d = beijing_today_yyyy_mm_dd();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
        // YYYY 部分应是 2020~2099 区间（现实日期范围）
        let y: i32 = d[0..4].parse().expect("year must parse");
        assert!((2020..=2099).contains(&y), "year out of expected range: {y}");
    }

    #[test]
    fn issue_default_window_is_a_rolling_thirty_day_range() {
        let (from, to) = issue_default_window();
        assert!(to > from);
        assert_eq!(to - from, ISSUE_DEFAULT_WINDOW_MS.saturating_add(1));
        assert!(to <= agent_vitals_runtime::sql_sync::now_ms().saturating_add(2));
    }

    /// read argv：固定段（session_ref 必带 + 无 revision flag）。
    /// session_ref 是 HMAC 不透明串，原生 session_key 在 v0.9.1 不再穿过 IPC
    /// 边界——前端不应再持有 native_session_id / machine_namespace（PII）。
    #[test]
    fn read_args_is_fixed() {
        assert_eq!(
            read_args("sr_abcdef1234567890", None, None),
            vec!["sessions", "read", "--session-ref", "sr_abcdef1234567890",
                 "--json"]
        );
    }

    #[test]
    fn read_args_forwards_detail_pagination() {
        assert_eq!(
            read_args("sr_abcdef1234567890", Some(200), Some("opaque-next")),
            vec![
                "sessions", "read", "--session-ref", "sr_abcdef1234567890",
                "--page-size", "200", "--cursor", "opaque-next", "--json"
            ]
        );
    }

    /// findings argv：固定段，无参数（rollup 恒全源聚合，跟 filter/cursor 无关）。
    #[test]
    fn findings_args_is_fixed() {
        assert_eq!(findings_args(), vec!["sessions", "findings", "--json"]);
    }

    /// §1.6（P1.1）：首屏有数据不得触发 evaluator（纯 authority 读）；
    /// 「重载」按钮（refresh=true）恒刷；投影全空（零发现的全新安装）时
    /// 每个首页读取放行一次刷新——有数据即停，零数据用户每个 app 会话
    /// 一次，是引导的诚实代价而非无限重试。
    #[test]
    fn evaluator_refresh_only_on_explicit_or_bootstrap() {
        assert!(!should_refresh_evaluator(false, false), "首屏有数据不得触发 evaluator");
        assert!(should_refresh_evaluator(true, false), "重载按钮恒刷");
        assert!(should_refresh_evaluator(false, true), "投影全空的首次引导放行");
        assert!(should_refresh_evaluator(true, true));
    }

    /// 错误形状：`cancelled` 的 message 明确（二进制缺失是基础设施失败，不是
    /// 会话源的缺列）。
    #[test]
    fn no_binary_error_shape_is_typed() {
        assert_eq!(
            no_binary(),
            json!({"error": {"code": "cancelled",
                             "message": "agent-vitals binary not found (set AGENT_VITALS_BIN, \
                                         add it to PATH, or place it in the app's \
                                         Contents/Resources/bin/)"}})
        );
    }

    /// doctor 的 Command 必须显式管道 stdout/stderr。行为断言：spawn() 默认
    /// 继承父进程三流，`wait_with_output` 只收集显式管道 —— 不显式声明的话
    /// 这条测试拿到空 stdout（真机上就是那份「EOF at column 0」事故）。
    /// Command 没有公开的 stdio 读取器，只能这样钉行为。
    #[test]
    fn doctor_command_pipes_output_so_wait_with_output_sees_it() {
        let mut cmd = doctor_command(
            Path::new("/bin/echo"),
            &["doctor-payload-marker".to_string()],
            Path::new("/tmp"),
        );
        let out = cmd
            .spawn()
            .expect("spawn echo")
            .wait_with_output()
            .expect("wait_with_output");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim_end(),
            "doctor-payload-marker",
            "stdout 未被管道捕获 —— doctor_command 丢了 Stdio::piped()"
        );
    }

    /// doctor argv：固定段（harness + stdout + with-report + no-snapshot）。
    /// `--with-report` 是「一次扫描同时拿 SV 码与 harness_summaries」的前提
    /// （spec §5.2）；`--no-snapshot` 恒带，桌面刷新不许把 diff 基线冲掉
    /// （spec §3.6）。
    #[test]
    fn doctor_args_is_fixed() {
        assert_eq!(
            doctor_args("all", &None, &None),
            vec!["doctor", "--harness", "all", "--json", "-", "--with-report", "--no-snapshot"]
        );
        assert_eq!(
            doctor_args("claude-code",
                        &Some("/tmp/self".to_string()), &Some(20000)),
            vec!["doctor", "--harness", "claude-code", "--json", "-", "--with-report",
                 "--no-snapshot", "--self-root", "/tmp/self", "--budget", "20000"]
        );
    }

    /// doctor 退出码：0/1 都不是错误（1 = 有发现，README「CI」契约）；2 起
    /// 才是工具自身错误，且 message 带 stderr 首行（spec §7：原样带 stderr，
    /// 不冒充「没有发现」）。
    #[cfg(unix)]
    #[test]
    fn doctor_exit_error_only_from_exit_two() {
        use std::os::unix::process::ExitStatusExt;
        // from_raw 的参数是 wait status：退出码 N 要左移 8 位（低 8 位是信号）。
        let ok = std::process::ExitStatus::from_raw(0);
        let findings = std::process::ExitStatus::from_raw(1 << 8);
        let tool_error = std::process::ExitStatus::from_raw(2 << 8);
        assert_eq!(doctor_exit_error(ok, "boom"), None);
        assert_eq!(doctor_exit_error(findings, "boom"), None, "exit 1 是有发现，不是错误");
        let err = doctor_exit_error(tool_error, "warning: x\nerror: bad config\n")
            .expect("exit 2 must be an error");
        assert_eq!(err["error"]["code"], "cancelled");
        let msg = err["error"]["message"].as_str().unwrap();
        assert!(msg.contains("exit 2") && msg.contains("warning: x"), "{msg}");
    }

    /// run_json 成功路径：spawn 真实子进程 → stdout 是 JSON → 原样解析。IPC
    /// 薄壳的全部行为就是「spawn 二进制 + 解析 stdout + 透传错误」，这三条用例
    /// 钉住 spawn/解析这一层——参数翻译（上面两条）对了、spawn/解析不对，前端点得
    /// 再准也拿不到数据。
    #[test]
    fn run_json_parses_success_stdout() {
        let mut cmd = Command::new("echo");
        cmd.arg("{\"a\":1}");
        assert_eq!(run_json(cmd), Ok(json!({"a": 1})));
    }

    /// 非零退出 + stderr 是类型化错误 JSON → 原样透传（错误码不丢、不被包成
    /// cancelled）。这依赖 spawn 的退出码 + stderr——正是真实二进制报
    /// `not-found` / `source-unavailable` 的路径。
    #[test]
    fn run_json_passes_through_typed_stderr() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c",
                  "echo '{\"error\":{\"code\":\"not-found\",\"message\":\"m\"}}' \
                   >&2; exit 2"]);
        assert_eq!(run_json(cmd),
                   Err(json!({"error": {"code": "not-found", "message": "m"}})));
    }

    /// 非零退出 + stderr **不是** `{"error":…}` 形状 → 包成 cancelled（code 集固定，
    /// 不另造新码），message 带原始 stderr，不能丢成空的。
    #[test]
    fn run_json_wraps_non_json_stderr_as_cancelled() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo plain-failure >&2; exit 1"]);
        match run_json(cmd) {
            Err(v) => {
                assert_eq!(v["error"]["code"], "cancelled");
                assert_eq!(v["error"]["message"], "plain-failure\n");
            }
            Ok(_) => panic!("non-zero exit must be an Err"),
        }
    }

    /// spawn 本身失败（二进制不存在）→ cancelled（基础设施失败，不是会话源的
    /// 缺列——§6.3-7 的 code 集固定）。
    #[test]
    fn run_json_spawn_failure_is_cancelled() {
        let cmd = Command::new("definitely-not-a-real-binary-xyz");
        match run_json(cmd) {
            Err(v) => assert_eq!(v["error"]["code"], "cancelled"),
            Ok(_) => panic!("missing binary must be an Err"),
        }
    }

    #[test]
    fn budget_issue_group_is_read_only_and_severity_tracks_level() {
        let warn = budget_issue_group(&json!({
            "month": "2026-09", "level": "warn", "ratio_bp": 8000,
            "monthly_cny_minor": 1000, "metered_cny_minor": 800,
        }));
        assert_eq!(warn["rule"], "BUDGET_THRESHOLD");
        assert_eq!(warn["severity"], "warning");
        assert_eq!(warn["read_only"], true);
        let exceeded = budget_issue_group(&json!({"month":"2026-09", "level":"exceeded"}));
        assert_eq!(exceeded["severity"], "critical");
    }

    #[test]
    fn issue_rule_rollup_does_not_overwrite_sessions_from_other_groups() {
        let rows = vec![
            json!({"group_id": "g1", "rule": "SV610", "severity": "warning", "hits": 2, "sessions": 2}),
            json!({"group_id": "g2", "rule": "SV610", "severity": "warning", "hits": 3, "sessions": 3}),
        ];
        let rollup = issue_group_rollup(&rows);
        assert_eq!(rollup[0]["hits"], 5);
        assert_eq!(rollup[0]["sessions"], 5);
    }

    #[test]
    fn issue_rule_rollup_keeps_highest_severity() {
        let rows = vec![
            json!({"group_id": "g1", "rule": "DATA_SOURCE_FAILURE", "severity": "warning", "hits": 1, "sessions": 1}),
            json!({"group_id": "g2", "rule": "DATA_SOURCE_FAILURE", "severity": "critical", "hits": 1, "sessions": 1}),
        ];
        let rollup = issue_group_rollup(&rows);
        assert_eq!(rollup[0]["severity"], "critical");
    }
}
