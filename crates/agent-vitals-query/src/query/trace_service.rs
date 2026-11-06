//! `trace_service`——v0.10.0 的 TraceGraph 服务层（spec §7 v0.10.0 门槛 4）。
//!
//! 两层职责：
//! 1. **memo**：进程级 `Arc<RwLock<HashMap<ledger_key, MemoEntry>>>`，60s TTL，
//!    按 home（`data_home`）键控——同进程多个消费面（CLI / Tauri IPC / MCP）命中
//!    同一份图，避免每次全量重算。命中路径返回 `Arc<TraceGraph>`——**锁内不得
//!    深拷贝**（2026-09-05 工作台 tab 卡顿事故：锁内深拷贝几 MB JSON 把并发命令
//!    串行卡在锁上；spec §10.3 性能形状纪律点名别改回去）。
//! 2. **失效**：TTL 之外，用 `usage_facts` 表的 `(COUNT(*), MAX(rowid)) WHERE
//!    session_key = ?` 计数器对比——**不是 `MAX(fact_id)`**（那是
//!    `"uf1-" + fnv1a64_hex` 哈希，字典序 MAX 不随新写入变化，memo 会永不失效；
//!    spec §7 门槛 4 的两个陷阱之一，守卫测试
//!    `new_fact_invalidates_memo_even_when_hash_sorts_lower` 钉住）。
//!
//! memo 键是 `SessionKey::ledger_key()`（长度前缀自定界，全仓同一构造——
//! `fact_writer_sql::session_key` 的注释写明朴素拼接会撞键）。
//!
//! I/O 归属：本模块在 runtime（不是 harnesses），允许碰文件系统与 SQLite——与
//! `mcp::AuthorityHandle` 同层。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use agent_vitals_domain::contracts::session_key::SessionKey;
use agent_vitals_domain::contracts::source_identity::{canonical_json, fnv1a64_hex};
use agent_vitals_domain::contracts::trace_graph::{
    BranchState, TraceGraph, TraceNode, TraceNodeType, TraceStatus,
};
use agent_vitals_domain::domain::trace::build_trace_graph;
use serde_json::{json, Value};

/// spec §7 门槛 4：60s TTL。
pub const MEMO_TTL: Duration = Duration::from_secs(60);

/// 执行环境封闭词表（spec §2.5.1；与 `ingest_service::FACT_HARNESSES` 同表——那边是
/// 数组常量，这里只需要 contains 语义；workbuddy 自 E4b 起入表，它的会话
/// 图节点来自 traces 的 generation span 事实）。
pub const TRACE_HARNESSES: &[&str] = &["claude-code", "codex", "dsh", "workbuddy"];

/// 一份 memo 条目：图 + 产生它时的输入快照指纹（`(COUNT, MAX(rowid))`）+
/// 挂载时间。
struct MemoEntry {
    graph: Arc<TraceGraph>,
    fact_counter: (i64, Option<i64>),
    cached_at: Instant,
}

/// 单个 data_home 的 memo 库：ledger_key -> 条目。
type HomeStore = RwLock<HashMap<String, MemoEntry>>;

/// 进程级 memo，按 `data_home` 键控（同一台机器上可能有多个 data_home）。
/// 值是 `Arc<HomeStore>`：外层 Mutex 只在「取/插 per-home 库」瞬间持有，
/// **绝不跨构建持有**（review P3：否则新会话的构建会在全局锁上把所有 home
/// 串行化）。
static MEMO: OnceLock<Mutex<HashMap<PathBuf, Arc<HomeStore>>>> = OnceLock::new();

fn memo_store() -> &'static Mutex<HashMap<PathBuf, Arc<HomeStore>>> {
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `(COUNT(*), MAX(rowid)) WHERE session_key = ?`——变更检测计数器。
/// `MAX(rowid)` 是物理插入顺序，新写入必然（对自增 rowid）单调不减且通常
/// 严格增大；COUNT 抓删除。两个一起才能同时抓住「追加」与「retention 清理」。
fn fact_counter(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> Result<(i64, Option<i64>), String> {
    conn.query_row(
        "SELECT COUNT(*), MAX(rowid) FROM usage_facts WHERE session_key = ?1 AND deleted_at_ms IS NULL",
        rusqlite::params![session_key],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?)),
    )
    .map_err(|e| format!("usage_facts counter query: {e}"))
}

/// memo 层的会话查找失败原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceLookupError {
    /// harness 不在 `TRACE_HARNESSES` 词表里。
    UnknownHarness(String),
    /// 权威库打不开 / 不存在 / schema 不符。
    AuthorityUnavailable(String),
    /// session_key 在 `sessions` 表里没有行（引用了已删除的会话）。
    SessionNotFound,
    /// SQL 执行失败。
    Query(String),
    /// 底层会话文件读取失败（`canonical_input::CanonicalInputError` 的转发）。
    SourceUnavailable(String),
}

impl std::fmt::Display for TraceLookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TraceLookupError::UnknownHarness(h) => {
                write!(f, "unknown harness `{h}` (trace harnesses: {})", TRACE_HARNESSES.join("/"))
            }
            TraceLookupError::AuthorityUnavailable(e) => write!(f, "authority unavailable: {e}"),
            TraceLookupError::SessionNotFound => write!(f, "session not found in authority"),
            TraceLookupError::Query(e) => write!(f, "authority query: {e}"),
            TraceLookupError::SourceUnavailable(e) => write!(f, "session source unavailable: {e}"),
        }
    }
}

/// 从 `sessions` 表取 `(harness, native_session_id, source_profile,
/// machine_namespace)`——`SessionKey` 四元组的全量。缺失的
/// `source_profile` 回退 `"default"`（与 `fact_writer_sql::session_key` 同款）。
fn session_row(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> Result<Option<(String, String, String, String)>, TraceLookupError> {
    conn.query_row(
        "SELECT harness, native_session_id, COALESCE(source_profile, 'default'), machine_namespace
         FROM sessions WHERE session_key = ?1",
        rusqlite::params![session_key],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(TraceLookupError::Query(other.to_string())),
    })
}

/// 在受控执行环境目录中定位 `key` 的源文件。返回的路径只在本模块内部使用，绝不
/// 进入 MCP/CLI JSON；这保留 authority DB 不持久化原始路径的隐私边界，同时让
/// `session_ref` 成为真正可下钻的公共标识。
fn source_paths_for_session(
    harness_home: &Path,
    dsh_root: &Path,
    key: &SessionKey,
) -> Result<Vec<PathBuf>, TraceLookupError> {
    // W3：各执行环境「怎么在根下找到这个会话的源」来自 harnesses 的会话执行环境注册表。
    let harness = agent_vitals_harnesses::sources::session_harnesses::session_harness(&key.harness_kind)
        .ok_or_else(|| TraceLookupError::UnknownHarness(key.harness_kind.clone()))?;
    let roots = agent_vitals_harnesses::sources::session_harnesses::HarnessRoots {
        user_home: harness_home,
        dsh_home: Some(dsh_root),
    };
    let paths = (harness.session_sources)(&roots, &key.native_id);
    if paths.is_empty() {
        return Err(TraceLookupError::SourceUnavailable(
            "no matching source remains under this harness's configured directory".to_string(),
        ));
    }
    Ok(paths)
}

/// 从显式根目录建立一份 canonical session。这一可注入入口供测试使用；生产
/// `canonical_for_local_session` 只从 HOME / DSH_HOME 的固定执行环境目录调用它。
pub fn canonical_for_session_from_roots(
    harness_home: &Path,
    dsh_root: &Path,
    key: &SessionKey,
) -> Result<agent_vitals_domain::contracts::evidence::CanonicalSession, TraceLookupError> {
    let paths = source_paths_for_session(harness_home, dsh_root, key)?;
    agent_vitals_harnesses::canonical_input::canonical_session_for_paths(
        &paths,
        &key.harness_kind,
        key.native_id.clone(),
    )
    .map_err(|e| TraceLookupError::SourceUnavailable(e.to_string()))
}

/// 生产入口：`session_ref` 先被解析为 `SessionKey`，再只在当前用户三执行环境的
/// 固定数据目录扫描。找不到源（已清理、移动、权限失效）是显式
/// `SourceUnavailable`，绝不能悄悄拿 SQL token 事实伪造一张完整执行图。
pub fn canonical_for_local_session(
    key: &SessionKey,
) -> Result<agent_vitals_domain::contracts::evidence::CanonicalSession, TraceLookupError> {
    let harness_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| TraceLookupError::SourceUnavailable("HOME is not configured".to_string()))?;
    let dsh_root = crate::home::dsh_home().ok_or_else(|| {
        TraceLookupError::SourceUnavailable("DSH_HOME and HOME are not configured".to_string())
    })?;
    canonical_for_session_from_roots(&harness_home, &dsh_root, key)
}

/// SQL 身份到源文件的受控反查在 `canonical_for_local_session` 完成；本函数仍
/// 只负责 canonical → TraceGraph 的 memo/失效和 SQL fact 拼接，保持可测试的
/// 职责边界。
#[derive(Debug)]
struct UsageFactRef {
    fact_id: String,
    model_id: Option<String>,
    event_ts_ms: i64,
    uncached_input_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    output_tokens: i64,
}

fn stable_id(value: &Value) -> String {
    let mut out = String::new();
    canonical_json(value, &mut out);
    fnv1a64_hex(out.as_bytes())
}

/// 权威库中该会话全部实时 usage fact。排序只为 deterministic graph identity，
/// **不是**执行顺序：TraceGraph 的 usage scope 不声称这些 token events 与
/// canonical tool/turn 有因果 parent（没有证据就留空）。
fn usage_facts_for_session(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> Result<Vec<UsageFactRef>, TraceLookupError> {
    let mut stmt = conn
        .prepare(
            "SELECT fact_id, model_id, event_ts_ms,
                    uncached_input_tokens, cache_read_tokens,
                    cache_write_tokens, output_tokens
             FROM usage_facts
             WHERE session_key = ?1
               AND observation_kind != 'legacy_aggregate'
               AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL
             ORDER BY fact_id",
        )
        .map_err(|e| TraceLookupError::Query(e.to_string()))?;
    let rows = stmt
        .query_map(rusqlite::params![session_key], |r| {
            Ok(UsageFactRef {
                fact_id: r.get(0)?,
                model_id: r.get(1)?,
                event_ts_ms: r.get(2)?,
                uncached_input_tokens: r.get(3)?,
                cache_read_tokens: r.get(4)?,
                cache_write_tokens: r.get(5)?,
                output_tokens: r.get(6)?,
            })
        })
        .map_err(|e| TraceLookupError::Query(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| TraceLookupError::Query(e.to_string()))
}

/// 把 SQL authority 的可计量事实接入 canonical trace。
///
/// 这里**不**按相近时间把 fact 硬挂到 assistant turn/tool call：不同执行环境的
/// token 事件和工具事件没有一条跨执行环境可靠的 join 规则。每个 fact 因此成为
/// 独立 `usage` scope 的 ModelInvocation，有真实 `fact_id`；其 parent 缺席是
/// 已知、可见的因果缺口，不是被时间猜测掩盖。
fn attach_usage_facts(
    mut graph: TraceGraph,
    facts: Vec<UsageFactRef>,
    cost_minor: Option<Value>,
) -> TraceGraph {
    let mut token_total = 0i64;
    let mut models = std::collections::BTreeSet::new();
    let mut by_model = std::collections::BTreeMap::<String, (usize, i64)>::new();
    for (ordinal, fact) in facts.iter().enumerate() {
        let total = fact.uncached_input_tokens
            + fact.cache_read_tokens
            + fact.cache_write_tokens
            + fact.output_tokens;
        token_total += total;
        let model = fact
            .model_id
            .clone()
            .unwrap_or_else(|| "<unknown>".to_string());
        models.insert(model.clone());
        let model_totals = by_model.entry(model).or_default();
        model_totals.0 += 1;
        model_totals.1 += total;
        let mut values = std::collections::BTreeMap::new();
        values.insert(
            "uncached_input_tokens".to_string(),
            fact.uncached_input_tokens as f64,
        );
        values.insert(
            "cache_read_tokens".to_string(),
            fact.cache_read_tokens as f64,
        );
        values.insert(
            "cache_write_tokens".to_string(),
            fact.cache_write_tokens as f64,
        );
        values.insert("output_tokens".to_string(), fact.output_tokens as f64);
        values.insert("total_tokens".to_string(), total as f64);
        graph.nodes.push(TraceNode {
            node_id: stable_id(&json!({
                "kind": "usage_fact_node",
                "session_key": graph.session_key.to_json(),
                "fact_id": fact.fact_id,
            })),
            scope: "usage".to_string(),
            ordinal: ordinal as u64,
            native: format!("usage-{}", ordinal),
            node_type: TraceNodeType::ModelInvocation,
            fact_id: fact.fact_id.clone(),
            evidence_ref: format!("uf1:{}", fact.fact_id),
            parent_node_id: None,
            branch_state: BranchState::Live,
            // `event_ts_ms` 按权威库契约已是毫秒，这里仍然过一遍具名归一：
            // `TraceNode.started_at_ms` 的契约是毫秒，而它有**两个**写入方
            // （此处与 `domain/trace.rs`，后者的输入是执行环境各自定单位的
            // `TimelineEntry.time`）。让两个写入方都调同一个归一函数，契约才是
            // 被强制的；只归一一个，另一个的正确性就靠运气。函数幂等，对已是
            // 毫秒的输入零行为变化。
            started_at_ms: Some(agent_vitals_domain::domain::util::to_epoch_ms(fact.event_ts_ms)),
            ended_at_ms: Some(agent_vitals_domain::domain::util::to_epoch_ms(fact.event_ts_ms)),
            // usage fact 是一次被成功清洗入权威库的计量观察；它不代表整个
            // assistant turn 成功，只代表该模型调用的用量记录可用。
            status: Some(TraceStatus::Ok),
            provenance: agent_vitals_domain::evidence::Provenance::Measured,
            values,
            metadata: json!({"model_id": fact.model_id}),
        });
    }

    let known_tool_durations: Vec<i64> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type == TraceNodeType::ToolCall)
        .filter_map(|node| match (node.started_at_ms, node.ended_at_ms) {
            (Some(start), Some(end)) if end >= start => Some(end - start),
            _ => None,
        })
        .collect();
    let tool_nodes: Vec<&TraceNode> = graph
        .nodes
        .iter()
        .filter(|node| node.node_type == TraceNodeType::ToolCall)
        .collect();
    let failed_tool_call_count = tool_nodes
        .iter()
        .any(|node| node.status.is_some())
        .then(|| {
            tool_nodes
                .iter()
                .filter(|node| node.status == Some(TraceStatus::Error))
                .count()
        });
    graph.metrics = json!({
        "model_invocation_count": facts.len(),
        "token_total": token_total,
        "model_ids": models.into_iter().collect::<Vec<_>>(),
        "by_model": by_model.into_iter().map(|(model_id, (invocation_count, token_total))| {
            json!({
                "model_id": model_id,
                "invocation_count": invocation_count,
                "token_total": token_total,
            })
        }).collect::<Vec<_>>(),
        "tool_call_count": tool_nodes.len(),
        "failed_tool_call_count": failed_tool_call_count,
        "known_tool_duration_ms": (!known_tool_durations.is_empty()).then(|| known_tool_durations.iter().sum::<i64>()),
        "cost_minor": cost_minor,
    });
    graph.coverage.total_nodes = graph.nodes.len() as u32;
    graph.input_fingerprint = stable_id(&json!({
        "canonical": graph.input_fingerprint,
        "usage_fact_ids": facts.iter().map(|fact| &fact.fact_id).collect::<Vec<_>>(),
    }));
    graph
}

fn build_fresh(
    canonical: &agent_vitals_domain::contracts::evidence::CanonicalSession,
    key: &SessionKey,
    conn: &rusqlite::Connection,
) -> Result<TraceGraph, TraceLookupError> {
    let graph = build_trace_graph(canonical, key.clone());
    let facts = usage_facts_for_session(conn, &key.ledger_key())?;
    let cost_minor =
        agent_vitals_data::authority_query::session_cost_minor(conn, &key.ledger_key())
            .map_err(|e| TraceLookupError::Query(e.to_string()))?
            .map(|value| value.to_json());
    Ok(attach_usage_facts(graph, facts, cost_minor))
}

/// memo 查询入口：传入会话的 `CanonicalSession`（调用方已通过文件枚举读出），
/// 返回 memo 命中的 `Arc<TraceGraph>` 或新算后回填的 `Arc<TraceGraph>`。
///
/// `fact_counter_current` 是调用方此刻在权威库里读到的计数器——由本函数内部
/// 自己查（`conn` 传入），保证「构建 → 回填」之间没有第二个写者穿插时计数器
/// 与图一致。
pub fn trace_graph_for_canonical(
    data_home: &Path,
    key: &SessionKey,
    canonical: &agent_vitals_domain::contracts::evidence::CanonicalSession,
    conn: &rusqlite::Connection,
) -> Result<Arc<TraceGraph>, TraceLookupError> {
    let ledger = key.ledger_key();
    let current = fact_counter(conn, &ledger).map_err(TraceLookupError::Query)?;

    // 外层锁只到「拿到 per-home 库的 Arc」为止——构建（可能毫秒级）不在
    // 任何全局锁内。
    let store = {
        let mut stores = memo_store().lock().expect("memo store poisoned");
        Arc::clone(stores.entry(data_home.to_path_buf()).or_default())
    };
    {
        let guard = store.read().expect("memo entry lock poisoned");
        if let Some(entry) = guard.get(&ledger) {
            if entry.fact_counter == current && entry.cached_at.elapsed() < MEMO_TTL {
                return Ok(Arc::clone(&entry.graph));
            }
        }
    }

    // 构建（`build_trace_graph` 是 O(节点数) 纯函数），回填只在 per-home 写锁内
    // 做赋值。
    //
    // 已知边界（review P2，按 spec 接受）：TTL 内若同一会话的 CanonicalSession
    // 内容变化但 fact 计数器不变（新增 turn 不产新 fact 的场景），命中路径
    // 返回的是旧图——失效键是 spec §7 门槛 4 钦定的 (COUNT, MAX(rowid))，
    // 消费方传入新 canonical 时以「计数器未变 = 事实面未变」为准。
    let graph = Arc::new(build_fresh(canonical, key, conn)?);
    let mut guard = store.write().expect("memo entry lock poisoned");
    guard.insert(
        ledger,
        MemoEntry {
            graph: Arc::clone(&graph),
            fact_counter: current,
            cached_at: Instant::now(),
        },
    );
    Ok(graph)
}

/// 便捷入口：从权威库读会话四元组（供调用方拼 `SessionKey` 用）。
pub fn session_key_for(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> Result<SessionKey, TraceLookupError> {
    match session_row(conn, session_key)? {
        None => Err(TraceLookupError::SessionNotFound),
        Some((harness, native_id, profile, ns)) => {
            Ok(SessionKey::new(&harness, &native_id, &profile, &ns))
        }
    }
}

/// V16 锚点报告——**本地呈现层专属**（CLI `trace-anchors`）：给定 session_key，
/// 返回该会话 workflow 事件的锚点坐标（native_event_id + 行号/偏移 hints +
/// 错误分类）与任务意图摘录。不注册进 MCP 工具面（锚点=「去哪找原文」的地图，
/// 有网 agent 不该拿到）；不解析路径（现场路径解析归本模块其余入口）。缺
/// V16 数据的旧行如实缺席——不编造坐标。
pub fn session_anchor_report(
    conn: &rusqlite::Connection,
    session_key: &str,
) -> Result<serde_json::Value, rusqlite::Error> {
    let mut anchors = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT event_type, capability_id, outcome, error_code, error_class,
                    native_event_id, source_line, source_byte_offset
             FROM workflow_events
             WHERE session_key = ?1 AND event_ts_ms IS NOT NULL
             ORDER BY event_ts_ms",
        )?;
        let rows = stmt.query_map(rusqlite::params![session_key], |row| {
            // `?` 不能出现在 json! 宏参数里——先读局部再构造。
            let event_type: String = row.get(0)?;
            let capability_id: Option<String> = row.get(1)?;
            let outcome: String = row.get(2)?;
            let error_code: Option<String> = row.get(3)?;
            let error_class: Option<String> = row.get(4)?;
            let native_event_id: Option<String> = row.get(5)?;
            let source_line: Option<i64> = row.get(6)?;
            let source_byte_offset: Option<i64> = row.get(7)?;
            Ok(serde_json::json!({
                "event_type": event_type,
                "capability_id": capability_id,
                "outcome": outcome,
                "error_code": error_code,
                "error_class": error_class,
                "native_event_id": native_event_id,
                "source_line": source_line,
                "source_byte_offset": source_byte_offset,
            }))
        })?;
        for row in rows {
            anchors.push(row?);
        }
    }
    let mut excerpts = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT role, excerpt, provenance, native_event_id
             FROM session_excerpts WHERE session_key = ?1 ORDER BY ordinal",
        )?;
        let rows = stmt.query_map(rusqlite::params![session_key], |row| {
            let role: String = row.get(0)?;
            let excerpt: String = row.get(1)?;
            let provenance: String = row.get(2)?;
            let native_event_id: String = row.get(3)?;
            Ok(serde_json::json!({
                "role": role,
                "excerpt": excerpt,
                "provenance": provenance,
                "native_event_id": native_event_id,
            }))
        })?;
        for row in rows {
            excerpts.push(row?);
        }
    }
    Ok(serde_json::json!({
        "anchors": anchors,
        "excerpts": excerpts,
    }))
}

/// 测试与调试辅助：清空某 data_home 的 memo（生产代码不调用——失效由
/// TTL + 计数器驱动，不靠手动清）。
pub fn clear_memo(data_home: &Path) {
    let mut stores = memo_store().lock().expect("memo store poisoned");
    stores.remove(data_home);
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_harnesses::dsh_evidence::build_dsh_evidence;
    use serde_json::json;

    fn tmp_data_home(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "agent-vitals-trace-svc-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 内存 SQLite + 最小 schema（sessions + usage_facts + pricing_snapshots）——不依赖
    /// `AuthorityDb::open_readonly`（那要求真实库文件 + schema 校验），这里只
    /// 测 memo/计数器逻辑，不测权威库打开路径（那是 mcp 层测试的职责）。
    fn mem_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                session_key TEXT PRIMARY KEY, harness TEXT NOT NULL,
                native_session_id TEXT NOT NULL, machine_namespace TEXT NOT NULL,
                source_profile TEXT);
             CREATE TABLE usage_facts (
                session_key TEXT NOT NULL, fact_id TEXT NOT NULL,
                harness TEXT NOT NULL DEFAULT 'dsh', provider_id TEXT,
                model_id TEXT, event_ts_ms INTEGER,
                uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                event_peak INTEGER NOT NULL DEFAULT 0,
                observation_kind TEXT NOT NULL DEFAULT 'assistant-usage',
                deleted_at_ms INTEGER);
             CREATE TABLE pricing_snapshots (
                captured_at_ms INTEGER NOT NULL,
                pricing_version TEXT NOT NULL,
                payload_json TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn seed_session(conn: &rusqlite::Connection, harness: &str, sid: &str) -> SessionKey {
        let key = SessionKey::new(harness, sid, "default", "ns-test");
        conn.execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, source_profile, machine_namespace)
             VALUES (?1, ?2, ?3, 'default', 'ns-test')",
            rusqlite::params![key.ledger_key(), harness, sid],
        )
        .unwrap();
        key
    }

    fn insert_fact(conn: &rusqlite::Connection, session_key: &str, fact_id: &str) {
        conn.execute(
            "INSERT INTO usage_facts(session_key, fact_id, event_ts_ms) VALUES (?1, ?2, 1)",
            rusqlite::params![session_key, fact_id],
        )
        .unwrap();
    }

    fn sample_canonical(sid: &str) -> agent_vitals_domain::contracts::evidence::CanonicalSession {
        let events = vec![
            json!({"type": "turn/start", "seq": 1, "time": 1000, "data": {"turn": 1}}),
            json!({"type": "turn/end", "seq": 2, "time": 1001, "data": {"turn": 1, "reason": {"kind": "ok"}}}),
        ];
        build_dsh_evidence(events, Vec::new(), None, sid.to_string()).canonical
    }

    #[test]
    fn memo_hits_within_ttl_and_same_counter() {
        let home = tmp_data_home("hit");
        let conn = mem_conn();
        let key = seed_session(&conn, "dsh", "s1");
        let canonical = sample_canonical("s1");

        let g1 = trace_graph_for_canonical(&home, &key, &canonical, &conn).unwrap();
        let g2 = trace_graph_for_canonical(&home, &key, &canonical, &conn).unwrap();
        assert!(
            Arc::ptr_eq(&g1, &g2),
            "TTL 内 + 计数器未变必须命中同一份 Arc——命中路径不得深拷贝"
        );
    }

    #[test]
    fn new_fact_invalidates_memo_even_when_hash_sorts_lower() {
        // spec §7 门槛 4 的守卫测试：fact_id 是哈希，字典序 MAX 不随新写入
        // 变化——用「先插一个哈希'大'的 fact，命中 memo；再插一个哈希'小'的
        // fact」的序列，断言 memo 必须失效。如果有人把计数器改回 MAX(fact_id)，
        // 这条测试当场红。
        let home = tmp_data_home("invalid");
        let conn = mem_conn();
        let key = seed_session(&conn, "dsh", "s1");
        let ledger = key.ledger_key();

        // 两个 fact_id：ffff…（字典序大）先插；0000…（字典序小）后插。
        insert_fact(&conn, &ledger, "uf1-ffffffffffffffff");
        let canonical = sample_canonical("s1");
        let g1 = trace_graph_for_canonical(&home, &key, &canonical, &conn).unwrap();

        insert_fact(&conn, &ledger, "uf1-0000000000000000");
        let g2 = trace_graph_for_canonical(&home, &key, &canonical, &conn).unwrap();

        assert!(
            !Arc::ptr_eq(&g1, &g2),
            "新 fact 写入后 memo 必须失效——即使新 fact_id 的字典序更小"
        );
    }

    #[test]
    fn deleted_fact_also_invalidates_memo_via_count() {
        let home = tmp_data_home("del");
        let conn = mem_conn();
        let key = seed_session(&conn, "dsh", "s1");
        let ledger = key.ledger_key();

        insert_fact(&conn, &ledger, "uf1-aaaaaaaaaaaaaaaa");
        let canonical = sample_canonical("s1");
        let g1 = trace_graph_for_canonical(&home, &key, &canonical, &conn).unwrap();

        conn.execute(
            "DELETE FROM usage_facts WHERE fact_id = 'uf1-aaaaaaaaaaaaaaaa'",
            [],
        )
        .unwrap();
        let g2 = trace_graph_for_canonical(&home, &key, &canonical, &conn).unwrap();
        assert!(
            !Arc::ptr_eq(&g1, &g2),
            "retention 删除也要失效——COUNT 抓删除，MAX(rowid) 抓追加"
        );
    }

    #[test]
    fn different_data_homes_have_independent_memos() {
        let home_a = tmp_data_home("a");
        let home_b = tmp_data_home("b");
        let conn = mem_conn();
        let key = seed_session(&conn, "dsh", "s1");
        let canonical = sample_canonical("s1");

        let ga = trace_graph_for_canonical(&home_a, &key, &canonical, &conn).unwrap();
        let gb = trace_graph_for_canonical(&home_b, &key, &canonical, &conn).unwrap();
        assert!(
            !Arc::ptr_eq(&ga, &gb),
            "按 data_home 键控——不同 home 的 memo 独立"
        );
    }

    /// V16 锚点报告（CLI `trace-anchors` 的数据面）：形状、时间序、缺证据
    /// 字段的 null 呈现、摘录按 ordinal 排序——以及「不带锚点的旧行如实
    /// 缺席」（不编造坐标）。验收 F-B：新公开面必须有库内测试。
    #[test]
    fn session_anchor_report_shapes_orders_and_degrades_honestly() {
        use agent_vitals_data::authority::AuthorityDb;
        use agent_vitals_domain::contracts::workflow::{SessionExcerpt, WorkflowEvent};
        use agent_vitals_domain::contracts::session_key::SessionKey;
        let path = std::env::temp_dir().join(format!(
            "av-anchors-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("anchor-test", "cli", 1).unwrap();
        let session_key = SessionKey::new("claude-code", "anc-s1", "default", "ns").ledger_key();
        let with_anchor = WorkflowEvent {
            event_id: "workflow:anc:1".to_string(),
            session_key: Some(session_key.clone()),
            event_ts_ms: 200,
            event_type: "tool_finished".to_string(),
            capability_kind: Some("tool".to_string()),
            capability_id: Some("Bash".to_string()),
            capability_version: None,
            outcome: "failed".to_string(),
            duration_ms: None,
            error_fingerprint: None,
            invocation_fingerprint: None,
            error_code: None,
            error_class: None,
            error_excerpt: Some("Error: boom".to_string()),
            args_excerpt: None,
            request_bytes: None,
            result_bytes: Some(42),
            native_event_id: Some("call_1".to_string()),
            source_line: Some(3),
            source_byte_offset: Some(533),
        };
        let mut without_anchor = with_anchor.clone();
        without_anchor.event_id = "workflow:anc:0".to_string();
        without_anchor.event_ts_ms = 100;
        without_anchor.outcome = "unknown".to_string();
        without_anchor.error_excerpt = None;
        without_anchor.result_bytes = None;
        without_anchor.native_event_id = None;
        without_anchor.source_line = None;
        without_anchor.source_byte_offset = None;
        let excerpt = SessionExcerpt {
            session_key: session_key.clone(),
            ordinal: 0,
            role: "user_first".to_string(),
            excerpt: "帮我修登录页".to_string(),
            provenance: "verbatim".to_string(),
            native_event_id: "u1".to_string(),
        };
        db.with_immediate_txn(|conn| {
            let source_id = agent_vitals_data::fact_writer_sql::SqlFactWriter::new(conn, "anchor-test", 1)?
                .upsert_batch_source("claude-code")?;
            agent_vitals_data::workflow::insert_events(
                conn, &[with_anchor, without_anchor], &source_id, "anchor-test", 2)?;
            agent_vitals_data::workflow::insert_session_excerpts(
                conn, std::slice::from_ref(&excerpt), &source_id, "anchor-test", 2)
        }).unwrap();
        let report = session_anchor_report(db.conn(), &session_key).unwrap();
        let anchors = report["anchors"].as_array().unwrap();
        let excerpts = report["excerpts"].as_array().unwrap();
        assert_eq!(anchors.len(), 2);
        // 时间升序：无锚点的旧行（ts=100）在前，锚点字段如实为 null。
        // 报告面只含坐标与分类（error_code/class）；摘录文本在 excerpts 组——
        // 锚点表不重复携带（分层：坐标归 anchors，内容归 excerpts）。
        assert_eq!(anchors[0]["native_event_id"], serde_json::Value::Null);
        assert_eq!(anchors[0]["source_line"], serde_json::Value::Null);
        assert_eq!(anchors[1]["native_event_id"], json!("call_1"));
        assert_eq!(anchors[1]["source_line"], json!(3));
        assert_eq!(anchors[1]["source_byte_offset"], json!(533));
        assert_eq!(anchors[1]["outcome"], json!("failed"));
        assert_eq!(excerpts.len(), 1);
        assert_eq!(excerpts[0]["role"], json!("user_first"));
        assert_eq!(excerpts[0]["excerpt"], json!("帮我修登录页"));
        // 不存在的会话：空报告而非错误（诚实缺席）。
        let missing = session_anchor_report(db.conn(), "no|such|key|here").unwrap();
        assert!(missing["anchors"].as_array().unwrap().is_empty());
        assert!(missing["excerpts"].as_array().unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }

    #[test]
    fn session_key_for_reads_the_authority_row() {
        let conn = mem_conn();
        let expected = seed_session(&conn, "claude-code", "abc");
        let got = session_key_for(&conn, &expected.ledger_key()).unwrap();
        assert_eq!(got, expected);
        assert_eq!(
            session_key_for(&conn, "3|nope|7|default|7|ns-test").unwrap_err(),
            TraceLookupError::SessionNotFound
        );
    }

    #[test]
    fn unknown_harness_is_rejected_at_the_service_layer_too() {
        // 服务层自己也拒一遍（双保险）：TRACE_HARNESSES 与 ingest 的 FACT_HARNESSES
        // 同表，新增执行环境必须两处同步。
        assert_eq!(TRACE_HARNESSES.len(), crate::core::fact_harnesses::FACT_HARNESSES.len());
        for h in crate::core::fact_harnesses::FACT_HARNESSES {
            assert!(TRACE_HARNESSES.contains(&h), "{h} in FACT_HARNESSES but not TRACE_HARNESSES");
        }
    }

    #[test]
    fn usage_facts_are_traceable_model_nodes_with_complete_metrics() {
        let home = tmp_data_home("usage-metrics");
        let conn = mem_conn();
        let key = seed_session(&conn, "dsh", "s1");
        let ledger = key.ledger_key();
        conn.execute(
            "INSERT INTO usage_facts(
                session_key, fact_id, model_id, event_ts_ms,
                uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens
             ) VALUES (?1, 'uf1-a', 'gpt-test', 1234, 11, 2, 3, 4)",
            rusqlite::params![ledger],
        )
        .unwrap();

        let graph = trace_graph_for_canonical(&home, &key, &sample_canonical("s1"), &conn).unwrap();
        let node = graph
            .nodes
            .iter()
            .find(|node| node.fact_id == "uf1-a")
            .expect("每条 SQL usage fact 都必须有一个可下钻节点");
        assert_eq!(node.node_type, TraceNodeType::ModelInvocation);
        assert_eq!(node.evidence_ref, "uf1:uf1-a");
        assert_eq!(
            node.parent_node_id, None,
            "没有因果证据不得按时间臆造 parent"
        );
        assert_eq!(node.values.get("total_tokens"), Some(&20.0));
        assert_eq!(graph.metrics["model_invocation_count"], 1);
        assert_eq!(graph.metrics["token_total"], 20);
        assert_eq!(
            graph.metrics["by_model"],
            json!([{
                "model_id": "gpt-test", "invocation_count": 1, "token_total": 20
            }])
        );
        assert_eq!(
            graph.metrics["cost_minor"],
            Value::Null,
            "没有价卡必须诚实为空，不得伪造零成本"
        );
    }

    #[test]
    fn controlled_source_lookup_resolves_all_three_harnesses_without_exposing_paths() {
        let root = tmp_data_home("source-lookup");
        let dsh_root = root.join("dsh");
        let claude = root.join(".claude/projects/demo/claude-s1.jsonl");
        let codex = root.join(".codex/sessions/2026/rollout-a.jsonl");
        // 目录名故意与 header id 不同：反查必须以 DSH header 为权威，不能把
        // 可移动路径的末段当作 SessionKey。
        let dsh = dsh_root.join("sessions/demo/moved-directory/session.jsonl");
        for path in [&claude, &codex, &dsh] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        }
        std::fs::write(&claude, concat!(
            r#"{"type":"user","uuid":"u","timestamp":"2026-01-01T00:00:00.000Z","message":{"id":"u","content":"hi"}}"#, "\n",
            r#"{"type":"assistant","uuid":"a","timestamp":"2026-01-01T00:00:01.000Z","message":{"id":"a","content":"ok"}}"#,
        )).unwrap();
        std::fs::write(
            &codex,
            concat!(
                r#"{"type":"session_meta","payload":{"session_id":"codex-s1"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
            ),
        )
        .unwrap();
        std::fs::write(
            &dsh,
            r#"{"type":"session","version":0,"id":"dsh-s1","cwd":"/tmp"}"#,
        )
        .unwrap();

        for key in [
            SessionKey::new("claude-code", "claude-s1", "default", "ns"),
            SessionKey::new("codex", "codex-s1", "default", "ns"),
            SessionKey::new("dsh", "dsh-s1", "default", "ns"),
        ] {
            let canonical = canonical_for_session_from_roots(&root, &dsh_root, &key).unwrap();
            assert_eq!(canonical.meta.harness_id, key.harness_kind);
            assert_eq!(canonical.meta.session_id, key.native_id);
        }

        let missing = match canonical_for_session_from_roots(
            &root,
            &dsh_root,
            &SessionKey::new("dsh", "gone", "default", "ns"),
        ) {
            Ok(_) => panic!("missing source must not produce a fake canonical session"),
            Err(error) => error,
        };
        assert!(matches!(missing, TraceLookupError::SourceUnavailable(_)));
    }
}
