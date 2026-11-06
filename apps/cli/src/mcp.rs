//! Data MCP stdio 传输层（`docs/AGENT_VITALS_DATA_MCP_SPEC.md` §5.2 / §6.4）：
//! JSON-RPC 2.0 编解码 + method dispatch + 进程生命周期。**只做协议帧**——
//! 工具逻辑、envelope、错误码在 `agent_vitals_runtime::mcp`。
//!
//! 线协议（spec §6.4，M0 D1 冻结值）：
//! - protocol version `2025-06-18`（支持 `structuredContent`）。
//! - 逐行 JSON framing（`\n` 分隔，UTF-8，单条消息不跨行）。`stdout` 只出
//!   协议帧，日志走 `stderr`。
//! - 方法集：`initialize` / `notifications/initialized` / `tools/list` /
//!   `tools/call` / `ping`。`initialize` 之前只接受 `initialize`。
//! - 业务错误（库缺失 / 超时 / …）走 `tools/call` 结果的 `isError: true` +
//!   envelope 内 `error`，**不塞 JSON-RPC error**（否则客户端拿不到
//!   warnings/coverage）。协议层错误（未知方法 / 参数缺失）才用 JSON-RPC error。
//! - stdin EOF / 写 `stdout` 失败 → 冲刷 `stderr` + 退出 0。单连接串行。

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use agent_vitals_runtime::mcp;

const PROTOCOL_VERSION: &str = "2025-06-18";
/// `serverInfo.name` is display metadata for clients and logs. It is not an
/// auth credential. The binary name stays `agent-vitals`.
const SERVER_NAME: &str = "Oh Agent MCP";

/// `agent-vitals data-mcp serve` 的入口。永不返回（stdin EOF → exit 0）。
pub fn serve(allow_local_writes: bool) -> ! {
    let data_home = agent_vitals_runtime::home::data_home();
    // 生命周期横幅，不是问题——保留原样直出 stderr（外部 MCP harness 常年就是
    // 这么认这个进程活没活的），同时落一条 info 到文件（本机侧的进程存活
    // 记录，此前完全没有）。
    let banner = format!(
        "data-mcp: serving on stdio (protocol {PROTOCOL_VERSION}, data_home {})",
        data_home.display()
    );
    eprintln!("{banner}");
    agent_vitals_runtime::logging::log_info("data-mcp", &banner);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    run_loop_with_permissions(stdin.lock(), stdout.lock(), &data_home, allow_local_writes);
    eprintln!("data-mcp: stdin closed, exiting");
    agent_vitals_runtime::logging::log_info("data-mcp", "stdin closed, exiting");
    std::process::exit(0);
}

/// 传输循环——读一行 JSON-RPC → 处理 → 写一帧，直到 `reader` EOF 或写失败。
/// 拆出来是为了让 `#[cfg(test)]` 用内存 reader/writer 驱动（`serve` 只是它 +
/// 真 stdio + `exit(0)`）。
#[cfg(test)]
pub(crate) fn run_loop(reader: impl BufRead, mut out: impl Write, data_home: &std::path::Path) {
    run_loop_with_permissions(reader, &mut out, data_home, false);
}

pub(crate) fn run_loop_with_permissions(
    reader: impl BufRead,
    mut out: impl Write,
    data_home: &std::path::Path,
    allow_local_writes: bool,
) {
    let mut initialized = false;
    mcp::note_mcp_client(None);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                agent_vitals_runtime::logging::log_warn("data-mcp", &format!("stdin read error: {e}"));
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                write_frame(&mut out, &rpc_error(Value::Null, -32700, format!("parse error: {e}")));
                continue;
            }
        };

        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        let id = msg.get("id").cloned();

        // notification（无 id）：`notifications/initialized` 记状态，其余静默忽略。
        let Some(id) = id else {
            if method == "notifications/initialized" {
                initialized = true;
            }
            continue;
        };

        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

        let response = if method == "initialize" {
            initialized = true;
            mcp::note_mcp_client(client_info_name(&params));
            handle_initialize(id)
        } else if method == "ping" {
            rpc_ok(id, json!({}))
        } else if !initialized {
            rpc_error(id, -32002, "received request before `initialize`")
        } else {
            match method {
                "tools/list" => handle_tools_list(id),
                "tools/call" => handle_tools_call(id, &params, data_home, allow_local_writes),
                other => rpc_error(id, -32601, format!("method not found: {other}")),
            }
        };
        if !write_frame(&mut out, &response) {
            break; // 客户端断开（写 stdout 失败）→ 干净退出。
        }
    }

    mcp::note_mcp_client(None);
    let _ = out.flush();
}

fn client_info_name(params: &Value) -> Option<&str> {
    params.get("clientInfo").and_then(|info| info.get("name")).and_then(Value::as_str).filter(|name| !name.trim().is_empty())
}

fn handle_initialize(id: Value) -> Value {
    rpc_ok(
        id,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
        }),
    )
}

fn handle_tools_list(id: Value) -> Value {
    let tools: Vec<Value> = mcp::tool_specs()
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
                "outputSchema": t.output_schema,
            })
        })
        .collect();
    rpc_ok(id, json!({ "tools": tools }))
}

fn handle_tools_call(id: Value, params: &Value, data_home: &std::path::Path, allow_local_writes: bool) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return rpc_error(id, -32602, "tools/call requires a string `name`");
    };
    if !mcp::tool_specs().iter().any(|t| t.name == name) {
        return rpc_error(id, -32602, format!("unknown tool: {name}"));
    }
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

    let started = std::time::Instant::now();
    let (structured, is_error) = match mcp::dispatch_with_permissions(name, &args, data_home, allow_local_writes) {
        Ok(envelope) => (envelope, false),
        Err(err) => {
            agent_vitals_runtime::logging::log_warn(
                "data-mcp",
                &format!("tool {name} error [{}]: {}", err.code, err.message),
            );
            (mcp::error_envelope(&err), true)
        }
    };
    // 审计旁路（EVENT_BUS spec §5 McpToolInvoked）：**同步内联、帧构造之前**
    // （独立验证勘正的诚实边界）：失败只留 stderr、绝不影响协议帧；但写库最坏
    // 付一次 busy_timeout（5s）尾延迟——serve 单连接串行 + 本地 WAL 亚毫秒写，
    // 当前可接受；多连接/远程库化时移后台线程是既定演进项。库不存在则跳过
    // （**不建库**：serve 在未同步机器上必须照常工作）。
    audit_tool_call(data_home, name, &args, started.elapsed().as_millis() as i64, !is_error);
    let text = serde_json::to_string_pretty(&structured).unwrap_or_default();
    rpc_ok(
        id,
        json!({
            "content": [{ "type": "text", "text": text }],
            "structuredContent": structured,
            "isError": is_error,
        }),
    )
}

fn rpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// 写一帧 + flush。返回 false = 写失败（客户端断开）。
fn write_frame(out: &mut impl Write, v: &Value) -> bool {
    let line = serde_json::to_string(v).unwrap_or_else(|_| "{}".into());
    out.write_all(line.as_bytes()).is_ok()
        && out.write_all(b"\n").is_ok()
        && out.flush().is_ok()
}

/// MCP 审计批次：serve 进程 × 权威库各一条（该库首个 tools/call 时 begin_run，
/// 之后复用）——`event_outbox.ingested_run_id` 的批次归属沿 trust-audit 的
/// per-invocation run 先例，但按进程聚合，sync_runs 不随调用量增长。**按库
/// 路径键控**（而非单例 OnceLock）：测试进程会驱动多个临时库，单例会让
/// run_id 漂到别人的库上、触发外键拒绝。
static MCP_AUDIT_RUNS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, String>>,
> = std::sync::OnceLock::new();

/// 进程内调用序号（McpToolInvoked 的 correlation_id 与 event_id 唯一性材料）。
static MCP_AUDIT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn audit_tool_call(
    data_home: &std::path::Path,
    tool: &str,
    args: &Value,
    latency_ms: i64,
    ok: bool,
) {
    use agent_vitals_runtime::events::{insert_outbox, AppEvent};
    let db_path = agent_vitals_data::authority::default_authority_path(data_home);
    if !db_path.exists() {
        return; // 未同步机器：无库可写，审计静默跳过（不建库）
    }
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open(
        &db_path,
        agent_vitals_runtime::sql_sync::now_ms(),
    ) else {
        agent_vitals_runtime::logging::log_warn("data-mcp", "audit skipped (authority open failed)");
        return;
    };
    let run_id = {
        let runs = MCP_AUDIT_RUNS.get_or_init(|| {
            std::sync::Mutex::new(std::collections::HashMap::new())
        });
        let mut runs = runs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(id) = runs.get(&db_path) {
            id.clone()
        } else {
            let id = format!(
                "mcp-audit:{}-{}",
                std::process::id(),
                agent_vitals_runtime::sql_sync::now_ms()
            );
            // **成功才缓存**（独立验证发现）：失败时把 id 留在 map 里，外键会让
            // 本进程后续每次审计 insert 都失败——审计粘性失效到重启。不缓存则
            // 下一个 tools/call 重试开批次。
            match db.begin_run(&id, "mcp-audit", agent_vitals_runtime::sql_sync::now_ms()) {
                Ok(()) => { runs.insert(db_path, id.clone()); id }
                Err(e) => {
                    agent_vitals_runtime::logging::log_warn("data-mcp", &format!("audit run begin failed: {e}"));
                    return;
                }
            }
        }
    };
    // 参数只入指纹：**canonical JSON**（递归键排序、Python parity 钉测的
    // canonical_json）→ fnv1a64。原始参数可能含 agents 传来的敏感值，禁令与
    // TrustObservation 同源（spec §4.1）。独立验证抓过这里的坑：本 crate 全线
    // 开着 serde_json 的 preserve_order，to_string 按客户端键序序列化——同参数
    // 不同键序会得出不同指纹；指纹是持久化数据，canonical 必须一次做对。
    let mut canonical = String::new();
    agent_vitals_domain::source_identity::canonical_json(args, &mut canonical);
    let fingerprint = agent_vitals_domain::source_identity::fnv1a64_hex(canonical.as_bytes());
    // 调用序号（进程内单调）进 correlation_id：同毫秒、同参数、同延迟的两次
    // 调用否则会同 event_id 被 INSERT OR IGNORE 静默吞掉——访问日志不允许少计
    // （独立验证发现）；顺带给消费方一个进程内顺序信号。
    let seq = MCP_AUDIT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let event = AppEvent::mcp_tool_invoked(
        tool,
        &format!("fnv1a64:{fingerprint}"),
        latency_ms,
        ok,
        seq,
    );
    if let Err(e) = db.with_immediate_txn(|conn| insert_outbox(conn, &event, &run_id)
        .map_err(|e| agent_vitals_data::authority::AuthorityError::Sqlite(
            rusqlite::Error::InvalidParameterName(format!("__audit__:{e}"))))) {
        agent_vitals_runtime::logging::log_warn("data-mcp", &format!("audit emit failed: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 把一串请求喂给 `run_loop`，返回逐帧解析的响应。
    fn drive(reqs: &[Value], data_home: &std::path::Path) -> Vec<Value> {
        let input = reqs
            .iter()
            .map(|r| serde_json::to_string(r).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let mut out: Vec<u8> = Vec::new();
        run_loop(Cursor::new(input.into_bytes()), &mut out, data_home);
        // stdout 纪律：每行必须是合法 JSON（M18「stdout 无非协议帧」）。
        String::from_utf8(out)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("every stdout line is a JSON frame"))
            .collect()
    }

    fn init() -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} })
    }

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avmcp-tx-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn seed_empty_db(home: &std::path::Path) {
        std::fs::create_dir_all(home).unwrap();
        let path = agent_vitals_data::authority::default_authority_path(home);
        agent_vitals_data::authority::AuthorityDb::open(&path, 1_700_000_000_000).unwrap();
    }

    /// 审计旁路（EVENT_BUS spec §5 McpToolInvoked）：外部 tools/call 在 outbox
    /// 落一条审计事件——工具/延迟/成败/参数指纹俱全，**原始参数绝不入库**；
    /// 批次按进程×库一条；未同步（无库）的 home 不建库也不落事件。
    #[test]
    fn tools_call_emits_mcp_audit_event_without_raw_args() {
        let home = tmp_home("audit");
        seed_empty_db(&home);
        let reqs = [
            init(),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
                "name": "sessions_search",
                "arguments": { "from": "2099-01-01", "to": "2099-01-02",
                                "needle": "SECRETVALUE-should-never-persist" },
            }}),
        ];
        let out = drive(&reqs, &home);
        assert!(out.len() >= 2);
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&home),
            1_700_000_000_000,
        ).unwrap();
        // 第二次 tools/call（同工具）：钉「批次按进程聚合」——per-invocation 实现会
        // 在这里翻成 2 条 run（独立验证指出的弱断言）。
        // 第二个 drive = 新连接（新 run_loop）：**先 initialize 再调用**——协议层
        // 会拒绝未初始化的 tools/call，那到不了 dispatch 也不会有审计。
        let out_more = drive(
            &[init(), json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "sessions_search",
                            "arguments": { "from": "2099-01-01", "to": "2099-01-02" } },
            })],
            &home,
        );
        assert_eq!(out_more.len(), 2);
        let rows: Vec<(String, String)> = db
            .conn()
            .prepare(
                "SELECT producer, payload_json FROM event_outbox \
                 WHERE event_type = 'McpToolInvoked' ORDER BY rowid",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2, "两次调用两条审计事件");
        for (producer, payload) in &rows {
            assert_eq!(producer, "mcp-serve", "producer 固定 mcp-serve");
            assert!(payload.contains("sessions_search"), "payload 带工具名: {payload}");
            assert!(payload.contains("fnv1a64:"), "payload 带参数指纹: {payload}");
            assert!(payload.contains("\"latency_ms\""), "payload 带延迟: {payload}");
            assert!(payload.contains("\"ok\":"), "payload 带成败（值如实，可为 false）: {payload}");
        }
        // 原文泄漏扫全表（不只审计行——任何事件行都不该带上参数原文）。
        let all_payloads: String = db.conn().prepare(
            "SELECT group_concat(payload_json) FROM event_outbox",
        ).unwrap().query_row([], |r| r.get(0)).unwrap();
        assert!(!all_payloads.contains("SECRETVALUE"), "原始参数绝不入库");
        // 两次调用的 correlation_id（调用序号）必须互不相同——event_id 唯一性的
        // 直接观测（独立验证 minor #4：同毫秒同参数不得互吞）。
        let correlations: Vec<String> = db.conn().prepare(
            "SELECT correlation_id FROM event_outbox WHERE event_type = 'McpToolInvoked' ORDER BY rowid",
        ).unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        assert_ne!(correlations[0], correlations[1], "调用序号必须单调");
        let audit_runs: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM sync_runs WHERE trigger = 'mcp-audit'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(audit_runs, 1, "批次按进程×库恰好一条（两次调用后仍是 1）");

        // 无库 home：不建库、不落事件（serve 在未同步机器必须照常工作）。
        let bare = tmp_home("audit-bare");
        std::fs::create_dir_all(&bare).unwrap();
        let out2 = drive(&reqs, &bare);
        assert!(out2.len() >= 2, "协议帧照常返回");
        assert!(!agent_vitals_data::authority::default_authority_path(&bare).exists(),
            "审计不得顺手建库");
        drop(db);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn initialize_reports_protocol_and_tools_capability() {
        let home = tmp_home("init");
        let out = drive(&[init()], &home);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["jsonrpc"], "2.0");
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[0]["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(out[0]["result"]["capabilities"]["tools"].is_object());
        assert!(out[0]["result"]["capabilities"].get("resources").is_none());
        assert_eq!(out[0]["result"]["serverInfo"]["name"], "Oh Agent MCP");
    }

    #[test]
    fn request_before_initialize_is_rejected() {
        let home = tmp_home("preinit");
        let out = drive(
            &[json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" })],
            &home,
        );
        assert_eq!(out[0]["error"]["code"], -32002);
    }

    #[test]
    fn ping_works_before_and_after_initialize() {
        let home = tmp_home("ping");
        let out = drive(
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }),
                init(),
                json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }),
            ],
            &home,
        );
        assert_eq!(out[0]["result"], json!({}));
        assert_eq!(out[2]["result"], json!({}));
    }

    #[test]
    fn tools_list_carries_schemas() {
        let home = tmp_home("list");
        let out = drive(
            &[init(), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })],
            &home,
        );
        let tools = out[1]["result"]["tools"].as_array().unwrap();
        let ds = tools.iter().find(|t| t["name"] == "data_status").unwrap();
        assert!(ds["description"].as_str().unwrap().len() > 20);
        assert_eq!(ds["inputSchema"]["type"], "object");
        assert_eq!(ds["inputSchema"]["additionalProperties"], json!(false));
        assert!(ds["outputSchema"].is_object());
    }

    #[test]
    fn unknown_method_is_jsonrpc_method_not_found() {
        let home = tmp_home("unknown");
        let out = drive(
            &[init(), json!({ "jsonrpc": "2.0", "id": 2, "method": "frobnicate" })],
            &home,
        );
        assert_eq!(out[1]["error"]["code"], -32601);
    }

    #[test]
    fn parse_error_yields_32700_with_null_id() {
        let home = tmp_home("parse");
        let mut out: Vec<u8> = Vec::new();
        run_loop(Cursor::new(b"{ not json\n".to_vec()), &mut out, &home);
        let frame: Value = serde_json::from_str(String::from_utf8(out).unwrap().trim()).unwrap();
        assert_eq!(frame["error"]["code"], -32700);
        assert_eq!(frame["id"], Value::Null);
    }

    #[test]
    fn tools_call_data_status_on_missing_db_is_business_error_not_jsonrpc_error() {
        let home = tmp_home("call-missing"); // no DB seeded
        let out = drive(
            &[
                init(),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": { "name": "data_status", "arguments": {} } }),
            ],
            &home,
        );
        // 成功的 JSON-RPC 响应，但 isError:true + envelope 里 error（spec §6.4）。
        assert!(out[1]["result"].is_object());
        assert!(out[1].get("error").is_none());
        assert_eq!(out[1]["result"]["isError"], true);
        assert_eq!(
            out[1]["result"]["structuredContent"]["error"]["code"],
            "database_missing"
        );
    }

    #[test]
    fn tools_call_data_status_on_empty_db_returns_envelope() {
        let home = tmp_home("call-empty");
        seed_empty_db(&home);
        let out = drive(
            &[
                init(),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": { "name": "data_status", "arguments": {} } }),
            ],
            &home,
        );
        let sc = &out[1]["result"]["structuredContent"];
        assert_eq!(out[1]["result"]["isError"], false);
        assert_eq!(sc["schema_version"], "1");
        assert_eq!(sc["timezone"], agent_vitals_runtime::clock::statistics_timezone_name());
        assert_eq!(sc["authority_state"], "candidate");
        assert_eq!(sc["data"]["facts"], 0);
        // content 文本块与 structuredContent 同源（spec §6.4）。
        let text = out[1]["result"]["content"][0]["text"].as_str().unwrap();
        let reparsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(&reparsed, sc);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tools_call_unknown_tool_is_invalid_params() {
        let home = tmp_home("call-unknown");
        let out = drive(
            &[
                init(),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": { "name": "nope", "arguments": {} } }),
            ],
            &home,
        );
        assert_eq!(out[1]["error"]["code"], -32602);
    }

    #[test]
    fn tools_call_with_unknown_argument_is_business_error() {
        let home = tmp_home("call-badarg");
        seed_empty_db(&home);
        let out = drive(
            &[
                init(),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                        "params": { "name": "data_status", "arguments": { "x": 1 } } }),
            ],
            &home,
        );
        assert_eq!(out[1]["result"]["isError"], true);
        assert_eq!(
            out[1]["result"]["structuredContent"]["error"]["code"],
            "invalid_argument"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn notifications_are_absorbed_without_a_frame() {
        let home = tmp_home("notif");
        let out = drive(
            &[
                init(),
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                json!({ "jsonrpc": "2.0", "method": "notifications/something-else" }),
                json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" }),
            ],
            &home,
        );
        // 2 帧：initialize 的响应 + ping 的响应；两个 notification 无响应。
        assert_eq!(out.len(), 2);
        assert_eq!(out[1]["id"], 9);
    }
}
