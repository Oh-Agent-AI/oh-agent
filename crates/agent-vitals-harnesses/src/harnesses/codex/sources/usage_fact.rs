//! v0.7 Stage 2：Codex static fold → UsageFact emitter（Rust 镜像）。
//!
//! 镜像 `scripts/agent_vitals/agent/codex_usage_fact.py` 的 Python 端实现，走
//! `agent_vitals_domain::usage_fact::build_usage_fact` 同一契约函数。Python↔Rust
//! byte-parity 钉测：同一批 rollout 两侧 stdout 字节相等。
//!
//! spec §2.3「发射集 == fold 的 by_model 消费集，是构造出来的」：本模块不重抄
//! codex wire-shape 解释，而是驱动 core `codex_usage::CodexFoldState`（Stage 2
//! commit 1 的共享 per-`token_count` 观察者）逐事件 `apply`，按返回的判别出口
//! 发射。emitter 只补 fold 不管的两件事：
//!
//! 1. **byte_offset**（§3.3）：derived `source_event_id` 需要行首在逻辑 JSONL
//!    字节流里的位置。明文 rollout 下它也是原文件偏移；`.zst` 下它是完整解压后
//!    JSONL 的偏移，不能直接作为压缩文件 seek 位置。core `CodexFoldState` 只吃
//!    `&Value`、不含行号；所以这里在解析字节上做一次带偏移的逐字节切分，换行语义
//!    复刻 `util::split_lines`（只认 \\n / \\r\\n / \\r，末段无换行也消费）。
//! 2. **native_session_id 解析**（§3.4）：逻辑 session_id（`session_meta`）→
//!    `path.stem` 兜底。
//!
//! 发射域 = 本次传入的 rollout 路径集；`source_event_id` 按 **rollout stem 命名
//! 空间**（不是逻辑 session）去重——同物理 rollout 的 byte-identical 复本只保留
//! 一条 + duplicate attempt，异 stem 永不误合并（§3.5.3 / §6.8 / §6.9，
//! 2026-09-03 拍板）。degraded 文件（空 / 含坏 JSON 行）镜像 codex-cost 按零
//! 事件处理、计进 `malformed`；I/O 错误向上抛（CLI 层 exit 2，镜像 claude）。
//!
//! derived-id 原语（canonical/FNV）来自 core `source_identity`（Claude/Codex/
//! DSH observer/UsageFact ID 共用的同一份，不许长第二份）。

//! v0.9 Stage A：从 apps/cli/src/agent/ 归位本执行环境 sources 层（R4 §5.2 scope gap）。
//! CLI 命令经 `agent_vitals_harnesses::codex_usage_fact` re-export 走同一实现，
//! 字节行为零改动（差分 + golden 钉住）。

use std::collections::{HashMap, HashSet};
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};

use agent_vitals_provider::{resolve_billing_attribution, RouteEvidence};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::codex_usage::{CodexFoldState, CodexTokenOutcome};
use crate::harnesses::claude_code::sources::usage_fact::{SKIP, UNATTRIBUTED, UNREADABLE};
use agent_vitals_domain::evidence::QuotaSnapshot;
use agent_vitals_domain::source_identity::{canonical_json, fnv1a64_hex};
use agent_vitals_domain::usage_fact::build_usage_fact;
use agent_vitals_domain::workflow::WorkflowEvent;

const HARNESS: &str = "codex";

/// 文件末尾才构造事实行：流式解析期间只保留这些小的中间量，不保留 `Value`
/// 树——这是「内存不随文件大小增长」的关键。
type FactSeed = (
    usize,
    [i64; 5],
    String,
    Option<String>,
    String,
    Option<String>,
    Option<RouteEvidence>,
);
const OBSERVATION_KIND: &str = "assistant-usage";

/// `codex_rollouts_to_usage_facts` 的 Rust 返回类型——镜像 Python
/// `codex_usage_fact.UsageFactEmitResult`。`malformed` = 本次发射域里 degraded
/// 的**文件**数（codex 的降级是整份：一处坏 JSON 即整份不可读；这类文件贡献零
/// 事件）。coverage 的 `fact_rows` 派生 = `facts.len()`（to_payload_value 里算），
/// 这里不重复存。
#[derive(Debug)]
pub struct UsageFactEmitResult {
    pub facts: Vec<Value>,
    pub workflow_events: Vec<WorkflowEvent>,
    /// 与同一次事实发射共享同一状态机得出的当前配额快照；它不是 UsageFact，
    /// 由 runtime 单独写入 `harness_runtime_snapshots`。这是跨执行环境契约类型，
    /// Runtime 不应重新解释 Codex wire 字段。
    pub quota_snapshot: Option<QuotaSnapshot>,
    /// 面向既有工作台/MCP 的 Codex JSON 投影。序列化在 adapter 内完成，
    /// Runtime 只把它作为不透明 payload 持久化，避免 `Option<Value>` 穿过
    /// adapter → runtime 边界。
    pub quota_snapshot_payload_json: Option<String>,
    pub attempts: HashMap<String, i64>,
    pub total_token_count_events: i64,
    pub skip_rows: i64,
    pub malformed: i64,
}

fn rollout_source_stem(path: &Path) -> String {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or_default();
    name.strip_suffix(".jsonl.zst")
        .or_else(|| name.strip_suffix(".jsonl"))
        .unwrap_or_else(|| path.file_stem().and_then(|s| s.to_str()).unwrap_or_default())
        .to_string()
}

fn route_evidence_from(value: &Value) -> Option<RouteEvidence> {
    let object = value.as_object()?;
    let route = object
        .get("route")
        .and_then(Value::as_object)
        .unwrap_or(object);
    let provider_raw = route
        .get("provider_id")
        .or_else(|| route.get("provider_raw"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let endpoint = route
        .get("endpoint_host")
        .or_else(|| route.get("base_url"))
        .or_else(|| route.get("endpoint"))
        .and_then(Value::as_str)
        .and_then(|raw| {
            let without_scheme = raw.split_once("//").map(|(_, rest)| rest).unwrap_or(raw);
            let harness = without_scheme.split('/').next().unwrap_or(without_scheme);
            let harness = harness
                .rsplit_once(':')
                .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
                .map(|(harness, _)| harness)
                .unwrap_or(harness);
            (!harness.is_empty()).then(|| harness.to_string())
        });
    if provider_raw.is_none() && endpoint.is_none() {
        return None;
    }
    let evidence_basis = if let (Some(raw), Some(harness)) = (&provider_raw, &endpoint) {
        let normalized = agent_vitals_provider::normalize_provider(Some(raw), Some(harness));
        let raw_is_known = matches!(
            raw.to_ascii_lowercase().as_str(),
            "openai" | "cogfoundry.ai"
        );
        let harness_lower = harness.to_ascii_lowercase();
        let harness_lower = harness_lower.trim_end_matches('.');
        let endpoint_is_known = harness_lower == "api.openai.com"
            || harness_lower.ends_with(".api.openai.com")
            || harness_lower == "cogfoundry.ai"
            || harness_lower.ends_with(".cogfoundry.ai");
        if raw_is_known
            && (!endpoint_is_known || normalized.as_deref() != Some(&raw.to_ascii_lowercase()))
        {
            agent_vitals_provider::EvidenceBasis::Conflict
        } else {
            agent_vitals_provider::EvidenceBasis::SessionNative
        }
    } else {
        agent_vitals_provider::EvidenceBasis::SessionNative
    };
    Some(RouteEvidence {
        provider_raw,
        endpoint_host: endpoint,
        evidence_basis,
    })
}

fn route_evidence_id(native_session_id: &str, route: &RouteEvidence) -> String {
    let key = format!(
        "{}|{}|{}|{}",
        native_session_id,
        route.provider_raw.as_deref().unwrap_or(""),
        route.endpoint_host.as_deref().unwrap_or(""),
        route.evidence_basis.as_str()
    );
    format!("route:{}", fnv1a64_hex(key.as_bytes()))
}

/// spec §3.3：`rollout_source_id(:path.stem) + byte_offset + fnv1a64(canonical_row)`。
///
/// `byte_offset` 只在单个物理 rollout 文件内唯一——命名空间必须是 **stem** 而非
/// 逻辑 session（同一逻辑 session 的两份续接 rollout 可能都有 offset 0 且同形，
/// 按 session 命名会误判跨文件重复、少算一笔，2026-09-03 修订）。row hash =
/// 两端一致的 canonical JSON 的 FNV-1a（canonical/FNV 原语在 core
/// `source_identity`，与 claude/DSH 共用——见模块 docstring）。
fn derived_event_id(rollout_source_id: &str, byte_offset: usize, rec: &Value) -> String {
    let mut canonical = String::new();
    canonical_json(rec, &mut canonical);
    format!(
        "{}:{}:{}",
        rollout_source_id,
        byte_offset,
        fnv1a64_hex(canonical.as_bytes())
    )
}

/// Consumed 事件 → UsageFact dict（`build_usage_fact` 输出）。None → builder 防御
/// 性拒绝（`bad_id` 哨兵——builder 是唯一校验方，不许绕开它自证身份合法）。
///
/// token 映射（§3.1/§3.2，决策 A）：core `facts: [i64; 5]` = fold 的 5 桶
/// `(uncached, output, cached, cache_write, reasoning)`；uncached → input、
/// cached → cache_read、cache_write → cache_write、output → output（reasoning
/// ⊆ output，**绝不叠加** facts[4]——叠加即双计）。5→4 逐字段与 Python
/// `_consumed_to_usage_fact` 一致。
#[allow(clippy::too_many_arguments)]
fn consumed_to_usage_fact(
    facts: &[i64; 5],
    model: &str,
    event_ts_utc: &Option<String>,
    source_event_id: &str,
    native_session_id: &str,
    machine_namespace: &str,
    source_profile: &str,
    model_provider: Option<&str>,
    route: Option<&RouteEvidence>,
) -> Option<Value> {
    let mut fields = Map::new();
    fields.insert("machine_namespace".into(), json!(machine_namespace));
    fields.insert("harness".into(), json!(HARNESS));
    fields.insert("source_profile".into(), json!(source_profile));
    fields.insert("native_session_id".into(), json!(native_session_id));
    fields.insert("source_event_id".into(), json!(source_event_id));
    fields.insert("observation_kind".into(), json!(OBSERVATION_KIND));
    // codex token_count 无原生 id → 恒 derived-hash（§3.3，不存在 native 态）。
    fields.insert("identity_basis".into(), json!("derived-hash"));
    // event_ts_utc = Consumed 携带的顶层 timestamp 回退 payload.timestamp 原样
    // 串（fold 已算好，emitter 不重抄）；真无时间戳 → None。
    fields.insert("event_ts_utc".into(), json!(event_ts_utc));
    // time_basis 与 identity_basis 解耦（Stage 1c 原则）：事件带原生时间戳 →
    // "native"；真无时间戳 → None（诚实「无观测时间」，不冒充 estimated）。
    fields.insert(
        "time_basis".into(),
        if event_ts_utc.is_some() {
            json!("native")
        } else {
            Value::Null
        },
    );
    // last_token_usage 是 per-request 增量；复读快照已在 §3.5.2 消解，绝不把
    // 累计 total_token_usage 当 delta 发。
    fields.insert("source_usage_semantics".into(), json!("delta"));
    let attribution = resolve_billing_attribution(model_provider, route);
    fields.insert("model_raw".into(), json!(model));
    fields.insert("provider_raw".into(), json!(attribution.provider_raw));
    fields.insert(
        "endpoint_host".into(),
        json!(route.and_then(|r| r.endpoint_host.clone())),
    );
    fields.insert("provider_id".into(), json!(attribution.provider_id));
    fields.insert(
        "route_evidence_id".into(),
        route
            .map(|r| json!(route_evidence_id(native_session_id, r)))
            .unwrap_or(Value::Null),
    );
    fields.insert("billing_source".into(), json!(attribution.provider_id));
    fields.insert(
        "billing_mode".into(),
        json!(attribution.billing_mode.as_str()),
    );
    fields.insert("pricing_basis".into(), json!(attribution.pricing_basis));
    fields.insert(
        "evidence_basis".into(),
        json!(attribution.evidence_basis.as_str()),
    );
    // v0.12：归因重放以版本作为同源重分类门控。旧 v0.11 存量在重放时
    // 可安全收敛为当前派生归属；同版本的竞争证据仍由 writer 报冲突。
    fields.insert("normalization_version".into(), json!("provider-v0.12"));
    fields.insert("attribution_version".into(), json!("provider-v0.12"));
    fields.insert("uncached_input_tokens".into(), json!(facts[0]));
    fields.insert("cache_read_tokens".into(), json!(facts[2]));
    fields.insert("cache_write_tokens".into(), json!(facts[3]));
    fields.insert("output_tokens".into(), json!(facts[1]));
    build_usage_fact(&fields).ok()
}

/// 增量续读检查点（per rollout）：文件身份 + 可安全续读的 offset + 折叠游标 +
/// 归属游标。**只在 facts 事务提交成功后落盘**（见 ingest sync_service）；
/// 丢失/损坏的 checkpoint 只让该文件退化为全量，不会漏计（重读产生 duplicate）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CodexResumeState {
    /// 绝对字节偏移，且一定落在行边界之后（`LineStats::complete_bytes`）。
    pub offset: u64,
    pub size: u64,
    pub dev: u64,
    pub ino: u64,
    pub session_id: Option<String>,
    pub model_provider: Option<String>,
    pub provider: Option<String>,
    pub route: Option<RouteEvidence>,
    /// `CodexFoldState::cursor_json()`。
    pub fold: Value,
}

/// `(size, dev, ino)`；非 unix 平台 dev/ino 恒 0（仍按 size/offset 续读，
/// 截断由 `offset <= size` 判）。
fn file_identity(path: &Path) -> Option<(u64, u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((meta.len(), meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        Some((meta.len(), 0, 0))
    }
}


/// 整批 rollout 文件 → `UsageFactEmitResult`。
///
/// 与 Python `codex_rollouts_to_usage_facts` 字节等价：
/// - `paths`：一个或多个 rollout 文件。facts 按传入文件序、文件内行序。
/// - 发射域 = `paths`；`source_event_id`（stem 命名空间）跨文件去重：同 stem 的
///   byte-identical 复本（live/archive 双收）只保留一条 + duplicate attempt；异
///   stem 永不共享 offset 命名空间、绝不误合并（§6.8/§6.9）。
/// - attempts/coverage 镜像 spec §4：Repeat（复读）不 emit 也不计；skip /
///   unreadable / unattributed 各计一次；Consumed 里 builder 拒绝 → bad_id。
///   `total_token_count_events = skip + unreadable + unattributed + fact + duplicate
///   + bad_id`（每次非 Repeat 的 token_count）。
/// - degraded 文件（空 / 含坏 JSON 行）贡献零事件、`malformed` +1。I/O 错误（不可
///   读）向上抛（CLI 层 exit 2，镜像 claude-usage-facts）。
/// - 不写盘。诊断 CLI 与未来 writer 共用此函数。
pub fn codex_rollouts_to_usage_facts(
    paths: &[PathBuf],
    machine_namespace: &str,
    source_profile: &str,
) -> Result<UsageFactEmitResult, String> {
    codex_rollouts_to_usage_facts_with_route(paths, machine_namespace, source_profile, None)
}

/// Variant used by Runtime when a current Codex route hint is available.
pub fn codex_rollouts_to_usage_facts_with_route(
    paths: &[PathBuf],
    machine_namespace: &str,
    source_profile: &str,
    route: Option<&RouteEvidence>,
) -> Result<UsageFactEmitResult, String> {
    codex_rollouts_to_usage_facts_with_resume_and_route(
        paths,
        machine_namespace,
        source_profile,
        &HashMap::new(),
        route,
    )
    .map(|(result, _)| result)
}

/// 带增量检查点的变体：`resumes` 里身份匹配且 `offset <= size` 的文件从
/// `offset` 续读，其余全量。返回 `(结果, 更新后的检查点)`——调用方必须在
/// **事实落库成功后**才保存后者（先写检查点后写库 = 崩溃即丢事实）。
pub fn codex_rollouts_to_usage_facts_with_resume(
    paths: &[PathBuf],
    machine_namespace: &str,
    source_profile: &str,
    resumes: &HashMap<PathBuf, CodexResumeState>,
) -> Result<(UsageFactEmitResult, HashMap<PathBuf, CodexResumeState>), String> {
    codex_rollouts_to_usage_facts_with_resume_and_route(paths, machine_namespace, source_profile, resumes, None)
}

pub fn codex_rollouts_to_usage_facts_with_resume_and_route(
    paths: &[PathBuf], machine_namespace: &str, source_profile: &str,
    resumes: &HashMap<PathBuf, CodexResumeState>, _route_hint: Option<&RouteEvidence>,
) -> Result<(UsageFactEmitResult, HashMap<PathBuf, CodexResumeState>), String> {
    let mut updated: HashMap<PathBuf, CodexResumeState> = HashMap::new();
    let mut facts: Vec<Value> = Vec::new();
    let mut attempts: HashMap<String, i64> = HashMap::new();
    attempts.insert(SKIP.to_string(), 0);
    attempts.insert(UNREADABLE.to_string(), 0);
    attempts.insert(UNATTRIBUTED.to_string(), 0);
    let mut total = 0i64; // total_token_count_events（每次非 Repeat 的 token_count）
    let mut skip_rows = 0i64;
    let mut duplicate = 0i64;
    let mut bad_id = 0i64;
    let mut malformed = 0i64;
    let mut seen: HashSet<String> = HashSet::new();
    let mut folds: Vec<Value> = Vec::new();
    for p in paths {
        let stem = rollout_source_stem(p);
        let is_zst = p.to_string_lossy().ends_with(".jsonl.zst");
        let identity = file_identity(p);
        // zstd 的 offset 是解压流语义，不能拿压缩文件的 seek 位置续读：保持
        // 全量（压缩 rollout 通常 MB 级）。
        let resume = if is_zst {
            None
        } else {
            identity.and_then(|(size, dev, ino)| {
                resumes.get(p).filter(|state| {
                    state.offset > 0
                        && state.offset <= size
                        && state.dev == dev
                        && state.ino == ino
                })
            })
        };
        let base_offset = resume.map(|state| state.offset).unwrap_or(0);
        let mut native_session_id = resume
            .and_then(|state| state.session_id.clone())
            .unwrap_or_else(|| stem.clone());
        let mut model_provider = resume.and_then(|state| state.model_provider.clone());
        let mut current_route = resume.and_then(|state| state.route.clone());
        let mut current_provider = resume.and_then(|state| state.provider.clone());
        let mut local_seen: HashSet<String> = HashSet::new();
        let mut seeds: Vec<FactSeed> = Vec::new();
        let mut local_total = 0i64;
        let mut local_skip = 0i64;
        let mut local_duplicate = 0i64;
        let mut local_attempts: HashMap<&'static str, i64> = HashMap::new();
        local_attempts.insert(SKIP, 0);
        local_attempts.insert(UNREADABLE, 0);
        local_attempts.insert(UNATTRIBUTED, 0);
        let mut state = CodexFoldState::new();
        if let Some(resume) = resume {
            state.restore_cursor(&resume.fold);
        }
        let mut degraded = false;

        // 逐行处理，**不再把整份 rollout 读进内存**（2026-11-11 事故：2 GB
        // 文件每 30–60 s 全量解析，单轮 high-water 16 GB）。所有计数先记在
        // 本文件的局部变量里：旧语义是「一行坏 JSON = 整份零事件」，只有文件
        // 完整解析成功才合并进全局计数（否则 seen/attempts 会被半份文件污染）。
        let mut apply_line = |offset: u64, raw: &[u8]| -> bool {
            let text = String::from_utf8_lossy(raw);
            if text.trim().is_empty() {
                return true;
            }
            let item: Value = match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(_) => {
                    degraded = true;
                    return false;
                }
            };

            // §3.4：session_meta 的 session_id（键在即用，null 不退回 .id），
            // 后出现的有效值覆盖前值（fork 续接文件的历史语义）。
            if item.get("type").and_then(Value::as_str) == Some("session_meta") {
                if let Some(payload) = item.get("payload").and_then(Value::as_object) {
                    let sid = if payload.contains_key("session_id") {
                        payload.get("session_id")
                    } else {
                        payload.get("id")
                    };
                    if let Some(sid) = sid.and_then(Value::as_str) {
                        native_session_id = sid.to_string();
                    }
                    if model_provider.is_none() {
                        if let Some(provider) =
                            payload.get("model_provider").and_then(Value::as_str)
                        {
                            model_provider = Some(provider.to_string());
                        }
                    }
                }
            } else if model_provider.is_none() {
                if let Some(provider) = item
                    .pointer("/payload/thread_settings/model_provider_id")
                    .and_then(Value::as_str)
                {
                    model_provider = Some(provider.to_string());
                }
            }

            // 归属状态在**消费本事件之前**推进——与 route_states_before /
            // provider_states_before 的「同 offset 含本事件更新」一致。
            let payload = item.get("payload");
            let is_route_payload = item.get("type").and_then(Value::as_str)
                == Some("session_meta")
                || payload
                    .and_then(|v| v.get("type"))
                    .and_then(Value::as_str)
                    == Some("route_changed");
            let explicit = if is_route_payload {
                payload.and_then(route_evidence_from)
            } else {
                payload
                    .and_then(|v| v.get("thread_settings"))
                    .and_then(route_evidence_from)
            };
            if explicit.is_some() {
                current_route = explicit;
            }
            if item.get("type").and_then(Value::as_str) == Some("session_meta") {
                if let Some(provider) = payload
                    .and_then(|v| v.get("model_provider"))
                    .and_then(Value::as_str)
                {
                    current_provider = Some(provider.to_string());
                }
            }
            if let Some(provider) = payload
                .and_then(|v| v.get("thread_settings"))
                .and_then(|v| v.get("model_provider_id"))
                .and_then(Value::as_str)
            {
                current_provider = Some(provider.to_string());
            }

            match state.apply(&item) {
                CodexTokenOutcome::NotTokenCount | CodexTokenOutcome::Repeat => {}
                CodexTokenOutcome::Skip => {
                    local_total += 1;
                    *local_attempts.get_mut(SKIP).unwrap() += 1;
                    local_skip += 1;
                }
                CodexTokenOutcome::Unreadable => {
                    local_total += 1;
                    *local_attempts.get_mut(UNREADABLE).unwrap() += 1;
                    local_skip += 1;
                }
                CodexTokenOutcome::Unattributed => {
                    local_total += 1;
                    *local_attempts.get_mut(UNATTRIBUTED).unwrap() += 1;
                    local_skip += 1;
                }
                CodexTokenOutcome::Consumed {
                    facts: f,
                    model,
                    event_ts_utc,
                } => {
                    local_total += 1;
                    let source_event_id = derived_event_id(&stem, offset as usize, &item);
                    if seen.contains(&source_event_id) || local_seen.contains(&source_event_id)
                    {
                        local_duplicate += 1;
                        local_skip += 1;
                    } else {
                        local_seen.insert(source_event_id.clone());
                        let provider_at_event =
                            current_provider.clone().or_else(|| model_provider.clone());
                        seeds.push((
                            offset as usize,
                            f,
                            model,
                            event_ts_utc,
                            source_event_id,
                            provider_at_event,
                            current_route.clone(),
                        ));
                    }
                }
            }
            true
        };

        let stats = if is_zst {
            // 多帧流式解压：内存 = 一帧窗口 + 单行缓冲，不再整份解压。
            let file =
                std::fs::File::open(p).map_err(|e| format!("read {}: {}", p.display(), e))?;
            let reader = match super::jsonl::MultiFrameZstdReader::new(file) {
                Ok(reader) => reader,
                Err(_) => {
                    malformed += 1;
                    continue;
                }
            };
            super::jsonl::for_each_line(
                reader,
                super::jsonl::DEFAULT_MAX_LINE_BYTES,
                &mut apply_line,
            )
        } else {
            let mut file =
                std::fs::File::open(p).map_err(|e| format!("read {}: {}", p.display(), e))?;
            if base_offset > 0 {
                file.seek(SeekFrom::Start(base_offset))
                    .map_err(|e| format!("seek {}: {}", p.display(), e))?;
            }
            super::jsonl::for_each_line_from(
                std::io::BufReader::with_capacity(256 * 1024, file),
                base_offset,
                super::jsonl::DEFAULT_MAX_LINE_BYTES,
                &mut apply_line,
            )
        }
        .map_err(|e| format!("read {}: {}", p.display(), e))?;

        // 空文件 = missing-header；坏行/超长行 = 整份降级（旧语义）。zstd 的
        // 解压失败已在上面 `continue`。
        if degraded || stats.oversized > 0 || stats.bytes == 0 {
            malformed += 1;
            continue;
        }

        total += local_total;
        skip_rows += local_skip;
        duplicate += local_duplicate;
        for (key, value) in local_attempts {
            *attempts.get_mut(key).unwrap() += value;
        }
        seen.extend(local_seen);

        // facts 在文件末尾才构造：native_session_id 可能被后续 session_meta
        // 覆盖（fork 语义），而事实行要带最终 id。
        for (offset, f, model, event_ts_utc, source_event_id, provider_at_event, route_at_event) in
            seeds
        {
            let _ = offset;
            match consumed_to_usage_fact(
                &f,
                &model,
                &event_ts_utc,
                &source_event_id,
                &native_session_id,
                machine_namespace,
                source_profile,
                provider_at_event.as_deref(),
                route_at_event.as_ref(),
            ) {
                Some(fact) => facts.push(fact),
                None => {
                    bad_id += 1;
                    skip_rows += 1;
                }
            }
        }
        if !is_zst {
        if let Some((size, dev, ino)) = identity {
            // 只有走到这里（完整解析、未降级）才允许推进检查点。offset 用
            // `complete_bytes`：文件以无换行残行结尾时停在残行行首，下一轮
            // 重读该行（重复事实由 fact_id 去重），不会把写了一半的行跳过。
            updated.insert(
                p.clone(),
                CodexResumeState {
                    offset: stats.complete_bytes,
                    size,
                    dev,
                    ino,
                    session_id: Some(native_session_id.clone()),
                    model_provider: model_provider.clone(),
                    provider: current_provider.clone(),
                    route: current_route.clone(),
                    fold: state.cursor_json(),
                },
            );
        }
        }
        folds.push(state.finish());
    }
    if duplicate > 0 {
        attempts.insert("duplicate".to_string(), duplicate);
    }
    if bad_id > 0 {
        attempts.insert("bad_id".to_string(), bad_id);
    }
    let quota_payload = crate::codex_usage::codex_merge_folds(&folds)
        .get("plan")
        .cloned()
        .filter(|plan| !plan.is_null());
    let (quota_snapshot, quota_snapshot_payload_json) = quota_payload
        .and_then(|payload| {
            let contract = crate::codex_usage::quota_snapshot_contract(&payload)?;
            let payload_json = serde_json::to_string(&payload).ok()?;
            Some((contract, payload_json))
        })
        .map_or((None, None), |(contract, payload_json)| {
            (Some(contract), Some(payload_json))
        });
    Ok((UsageFactEmitResult {
        facts,
        workflow_events: paths
            .iter()
            .map(|path| super::workflow::codex_file_to_workflow_events(path, machine_namespace, source_profile))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect(),
        quota_snapshot,
        quota_snapshot_payload_json,
        attempts,
        total_token_count_events: total,
        skip_rows,
        malformed,
    }, updated))
}

/// CLI `--json` 输出的完整 payload——键序与 Python `cli.py` 的
/// `codex-usage-facts` handler 的 payload dict 插入序逐键一致：
/// machine_namespace, source_profile, facts, attempts, coverage, malformed。
/// attempts/coverage 子对象同样按 Python dict 插入序显式构造（HashMap 无序）。
pub fn to_payload_value(
    result: &UsageFactEmitResult,
    machine_namespace: &str,
    source_profile: &str,
) -> Value {
    let mut out = Map::new();
    out.insert("machine_namespace".to_string(), json!(machine_namespace));
    out.insert("source_profile".to_string(), json!(source_profile));
    out.insert("facts".to_string(), json!(result.facts));
    let mut attempts_obj = Map::new();
    for k in [SKIP, UNREADABLE, UNATTRIBUTED] {
        attempts_obj.insert(
            k.to_string(),
            json!(result.attempts.get(k).copied().unwrap_or(0)),
        );
    }
    if result.attempts.get("duplicate").is_some_and(|v| *v > 0) {
        attempts_obj.insert("duplicate".to_string(), json!(result.attempts["duplicate"]));
    }
    if result.attempts.get("bad_id").is_some_and(|v| *v > 0) {
        attempts_obj.insert("bad_id".to_string(), json!(result.attempts["bad_id"]));
    }
    out.insert("attempts".to_string(), Value::Object(attempts_obj));
    let mut cov = Map::new();
    cov.insert(
        "total_token_count_events".to_string(),
        json!(result.total_token_count_events),
    );
    cov.insert("fact_rows".to_string(), json!(result.facts.len()));
    cov.insert("skip_rows".to_string(), json!(result.skip_rows));
    out.insert("coverage".to_string(), Value::Object(cov));
    out.insert("malformed".to_string(), json!(result.malformed));
    Value::Object(out)
}

/// 人读摘要——逐行镜像 Python handler 的 print（含 `Attempts:` 行的 dict repr：
/// `{'skip': 3, 'unreadable': 0, ...}`，键单引号、逗号+空格）。诊断面不是 parity
/// 测试面，但保持双语言同源，免得两套人读输出漂移。
pub fn to_human_summary(
    result: &UsageFactEmitResult,
    source_paths: &[PathBuf],
    machine_namespace: &str,
    source_profile: &str,
) -> String {
    let paths: Vec<String> = source_paths
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    let mut attempts_parts: Vec<String> = Vec::new();
    for k in [SKIP, UNREADABLE, UNATTRIBUTED] {
        attempts_parts.push(format!(
            "'{}': {}",
            k,
            result.attempts.get(k).copied().unwrap_or(0)
        ));
    }
    if result.attempts.get("duplicate").is_some_and(|v| *v > 0) {
        attempts_parts.push(format!("'duplicate': {}", result.attempts["duplicate"]));
    }
    if result.attempts.get("bad_id").is_some_and(|v| *v > 0) {
        attempts_parts.push(format!("'bad_id': {}", result.attempts["bad_id"]));
    }
    format!(
        "Source: {}\nMachine namespace: {}\nSource profile: {}\nFacts: {} \
         (total_token_count_events={}, skip={})\nAttempts: {{{}}}\n",
        paths.join(", "),
        machine_namespace,
        source_profile,
        result.facts.len(),
        result.total_token_count_events,
        result.skip_rows,
        attempts_parts.join(", "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    static TEMP_DIR_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn line(rec: serde_json::Value) -> String {
        format!("{}\n", serde_json::to_string(&rec).unwrap())
    }

    fn temp_dir() -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "av-codex-usage-fact-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            TEMP_DIR_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    /// 一条消费形 token_count 的最小 rollout：session_meta（逻辑 sid）+
    /// turn_context（model 游标）+ 两个 token_count（第二个带真实 rate_limits 浮点）。
    fn rollout_lines() -> Vec<String> {
        vec![
            line(json!({"type":"session_meta","payload":{"session_id":"ses-abc123"}})),
            line(
                json!({"timestamp":"2026-09-03T00:00:00.000Z","type":"turn_context",
                        "payload":{"model":"gpt-5-codex","speed":"high"}}),
            ),
            line(json!({"type":"event_msg","payload":{"type":"token_count",
                        "timestamp":"2026-09-03T01:02:03.000Z",
                        "rate_limits":{"primary":{"used_percent":67.0}},
                        "info":{"total_token_usage":{"total_tokens":100},
                                "last_token_usage":{"input_tokens":100,"cached_input_tokens":30,
                                                    "cache_write_input_tokens":10,"output_tokens":40,
                                                    "reasoning_output_tokens":15}}}})),
            line(json!({"type":"event_msg","payload":{"type":"token_count",
                        "timestamp":"2026-09-03T01:02:05.000Z",
                        "info":{"total_token_usage":{"total_tokens":200},
                                "last_token_usage":{"input_tokens":150,"output_tokens":25,
                                                    "reasoning_output_tokens":5}}}})),
        ]
    }

    #[test]
    fn emits_typed_quota_contract_and_opaque_compat_projection() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-quota.jsonl");
        let rows = [
            line(json!({
                "type": "session_meta",
                "payload": {"session_id": "ses-quota"}
            })),
            line(json!({
                "timestamp": "2026-09-13T01:02:03.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "rate_limits": {
                        "plan_type": "plus",
                        "credits": {"has_credits": true},
                        "primary": {
                            "used_percent": 67.0,
                            "window_minutes": 10080,
                            "resets_at": 1780000000
                        }
                    },
                    "info": {
                        "total_token_usage": {"total_tokens": 100},
                        "last_token_usage": {
                            "input_tokens": 100,
                            "output_tokens": 40
                        }
                    }
                }
            })),
        ];
        std::fs::write(&p, rows.join("")).unwrap();

        let result = codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default")
            .unwrap();
        let snapshot = result.quota_snapshot.expect("typed quota contract");
        assert_eq!(snapshot.plan.as_deref(), Some("plus"));
        assert_eq!(snapshot.observed_at, "2026-09-13T01:02:03.000Z");
        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].used_percent, 67.0);
        assert_eq!(snapshot.windows[0].window_minutes, 10080);
        assert_eq!(snapshot.windows[0].resets_at_ms, 1_780_000_000_000);

        let payload_json = result
            .quota_snapshot_payload_json
            .expect("compatibility payload");
        let payload: Value = serde_json::from_str(&payload_json).unwrap();
        assert_eq!(payload["plan_type"], "plus");
        assert_eq!(payload["has_credits"], true);
        assert_eq!(payload["limits"]["primary"]["used_percent"], 67.0);
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn emits_consumed_with_decision_a_mapping_and_derived_identity() {
        // 验收 1/2/4 的 Rust 侧前置：Consumed → 5→4 映射（reasoning ⊆ output 不
        // 叠加）、identity_basis=derived-hash、source_event_id 含 stem+offset+hash、
        // native_session_id 从 session_meta 解析。
        let tmp = temp_dir();
        let p = tmp.join("rollout-sol.jsonl");
        std::fs::write(&p, rollout_lines().join("")).unwrap();
        let r =
            codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default").unwrap();
        assert_eq!(r.facts.len(), 2, "两次非复读 token_count → 2 fact");
        assert_eq!(r.total_token_count_events, 2);
        assert_eq!(r.skip_rows, 0);
        assert_eq!(r.malformed, 0);
        assert_eq!(r.attempts.get("bad_id"), None);
        let f0 = &r.facts[0];
        assert_eq!(f0.get("harness").and_then(Value::as_str), Some("codex"));
        assert_eq!(
            f0.get("native_session_id").and_then(Value::as_str),
            Some("ses-abc123")
        );
        assert_eq!(
            f0.get("identity_basis").and_then(Value::as_str),
            Some("derived-hash")
        );
        assert_eq!(
            f0.get("model_raw").and_then(Value::as_str),
            Some("gpt-5-codex")
        );
        assert_eq!(f0.get("time_basis").and_then(Value::as_str), Some("native"));
        // 5→4（决策 A）：uncached=input−cached−cw=60；reasoning 15 已在 output 内，
        // 绝不再叠。
        assert_eq!(
            f0.get("uncached_input_tokens").and_then(Value::as_i64),
            Some(60)
        );
        assert_eq!(
            f0.get("cache_read_tokens").and_then(Value::as_i64),
            Some(30)
        );
        assert_eq!(
            f0.get("cache_write_tokens").and_then(Value::as_i64),
            Some(10)
        );
        assert_eq!(f0.get("output_tokens").and_then(Value::as_i64), Some(40));
        // derived id = <stem>:<offset>:<16hex>（行首偏移：0 号 session_meta 行后，
        // token_count 是第 3 行、offset 落在其行首）。
        let sid = f0
            .get("source_event_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(
            sid.starts_with("rollout-sol:"),
            "derived id 应含 stem：{sid}"
        );
        assert!(
            !sid.contains('.') && sid.len() > "rollout-sol:0:".len() + 16,
            "derived id 带 16 hex hash：{sid}"
        );
        // fact_id 跨两 fact 唯一
        let fa = r.facts[0]
            .get("fact_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let fb = r.facts[1]
            .get("fact_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert_ne!(fa, fb);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn session_route_evidence_overrides_current_hint_per_rollout() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-cog.jsonl");
        let mut rows = rollout_lines();
        rows[0] = line(json!({
            "type": "session_meta",
            "payload": {
                "session_id": "ses-cog",
                "model_provider": "custom",
                "route": {"provider_id": "cogfoundry.ai", "endpoint_host": "router.cogfoundry.ai"}
            }
        }));
        std::fs::write(&p, rows.join("")).unwrap();
        let current = RouteEvidence {
            provider_raw: Some("custom".into()),
            endpoint_host: Some("router.other.example".into()),
            evidence_basis: agent_vitals_provider::EvidenceBasis::ConfigCurrent,
        };
        let result = codex_rollouts_to_usage_facts_with_route(
            std::slice::from_ref(&p),
            "ns-test",
            "default",
            Some(&current),
        )
        .unwrap();
        assert_eq!(result.facts.len(), 2);
        assert_eq!(result.facts[0]["provider_id"], "cogfoundry.ai");
        assert_eq!(result.facts[0]["evidence_basis"], "session-native");
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn custom_session_without_route_ignores_current_config_hint() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-cog.jsonl");
        let mut lines = rollout_lines();
        lines[0] = line(json!({
            "type": "session_meta",
            "payload": {"session_id": "ses-cog", "model_provider": "custom"}
        }));
        std::fs::write(&p, lines.join("")).unwrap();
        let route = RouteEvidence {
            provider_raw: Some("custom".into()),
            endpoint_host: Some("router.cogfoundry.ai".into()),
            evidence_basis: agent_vitals_provider::EvidenceBasis::ConfigCurrent,
        };
        let result = codex_rollouts_to_usage_facts_with_route(
            std::slice::from_ref(&p),
            "ns-test",
            "default",
            Some(&route),
        )
        .unwrap();
        assert!(result.facts[0]["provider_id"].is_null());
        assert_eq!(result.facts[0]["billing_mode"], "metered");
        assert_eq!(result.facts[0]["pricing_basis"], "metered_estimate");
        assert_eq!(result.facts[0]["evidence_basis"], "missing");
    }

    #[test]
    fn route_changed_reassigns_later_token_facts() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-switch.jsonl");
        let token = |ts: &str, total: i64| {
            line(json!({"type":"event_msg","payload":{"type":"token_count",
                "timestamp":ts,"info":{"total_token_usage":{"total_tokens":total},
                "last_token_usage":{"input_tokens":100,"output_tokens":10}}}}))
        };
        let rows = [
            line(
                json!({"type":"session_meta","payload":{"session_id":"ses-switch",
                "model_provider":"custom","route":{"provider_id":"cogfoundry.ai",
                "endpoint_host":"router.cogfoundry.ai"}}}),
            ),
            line(
                json!({"type":"turn_context","payload":{"model":"gpt-5.6-sol","speed":"standard"}}),
            ),
            token("2026-09-03T01:00:00.000Z", 110),
            line(json!({"type":"event_msg","payload":{"type":"route_changed",
                "provider_raw":"custom","provider_id":"openai","endpoint_host":"api.openai.com"}})),
            token("2026-09-03T01:01:00.000Z", 220),
        ];
        std::fs::write(&p, rows.join("")).unwrap();
        let result =
            codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default").unwrap();
        assert_eq!(result.facts.len(), 2);
        assert_eq!(result.facts[0]["provider_id"], "cogfoundry.ai");
        assert_eq!(result.facts[1]["provider_id"], "openai");
        assert_ne!(
            result.facts[0]["route_evidence_id"],
            result.facts[1]["route_evidence_id"]
        );
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn conflicting_session_route_is_marked_conflict() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-conflict.jsonl");
        let mut rows = rollout_lines();
        rows[0] = line(
            json!({"type":"session_meta","payload":{"session_id":"ses-conflict",
            "model_provider":"openai","route":{"provider_id":"openai",
            "endpoint_host":"router.cogfoundry.ai"}}}),
        );
        std::fs::write(&p, rows.join("")).unwrap();
        let result =
            codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default").unwrap();
        assert_eq!(result.facts[0]["evidence_basis"], "conflict");
        assert_eq!(result.facts[0]["billing_mode"], "metered");
        assert_eq!(result.facts[0]["pricing_basis"], "metered_estimate");
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn known_provider_with_unknown_endpoint_is_marked_conflict() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-unknown-endpoint.jsonl");
        let mut rows = rollout_lines();
        rows[0] = line(
            json!({"type":"session_meta","payload":{"session_id":"ses-evil",
            "model_provider":"openai","route":{"provider_id":"openai",
            "endpoint_host":"evil.example.com"}}}),
        );
        std::fs::write(&p, rows.join("")).unwrap();
        let result =
            codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default").unwrap();
        assert_eq!(result.facts[0]["evidence_basis"], "conflict");
        assert_eq!(result.facts[0]["pricing_basis"], "metered_estimate");
        assert_eq!(result.facts[0]["billing_mode"], "metered");
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn official_endpoint_trailing_dot_remains_session_native() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-openai-dot.jsonl");
        let mut rows = rollout_lines();
        rows[0] = line(
            json!({"type":"session_meta","payload":{"session_id":"ses-dot",
            "model_provider":"openai","route":{"provider_id":"openai",
            "endpoint_host":"api.openai.com."}}}),
        );
        std::fs::write(&p, rows.join("")).unwrap();
        let result =
            codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default").unwrap();
        assert_eq!(result.facts[0]["evidence_basis"], "session-native");
        assert_eq!(result.facts[0]["pricing_basis"], "session-provider");
        std::fs::remove_dir_all(tmp).ok();
    }

    #[test]
    fn rescan_same_file_stable_fact_and_source_event_ids() {
        // 验收 6.7（同一文件重复读取稳定）：两次读取 → 同 fact_id / 同 source_event_id。
        let tmp = temp_dir();
        let p = tmp.join("rollout-sol.jsonl");
        std::fs::write(&p, rollout_lines().join("")).unwrap();
        let r1 =
            codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default").unwrap();
        let r2 = codex_rollouts_to_usage_facts(&[p], "ns-test", "default").unwrap();
        let get = |r: &UsageFactEmitResult| -> Vec<(String, String)> {
            r.facts
                .iter()
                .map(|f| {
                    (
                        f.get("source_event_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        f.get("fact_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    )
                })
                .collect()
        };
        assert_eq!(
            get(&r1),
            get(&r2),
            "重扫同文件 derived id + fact_id 必须稳定"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn same_stem_two_sources_dedups_live_archive() {
        // 验收 6.9：同 stem、byte-identical 的双收（live/archive）→ 1 fact +
        // duplicate attempt。
        let tmp = temp_dir();
        let live = tmp.join("live");
        let arch = tmp.join("archived");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&arch).unwrap();
        let bytes = rollout_lines().join("");
        std::fs::write(live.join("rollout-sol.jsonl"), &bytes).unwrap();
        std::fs::write(arch.join("rollout-sol.jsonl"), &bytes).unwrap();
        let paths = vec![
            live.join("rollout-sol.jsonl"),
            arch.join("rollout-sol.jsonl"),
        ];
        let r = codex_rollouts_to_usage_facts(&paths, "ns-test", "default").unwrap();
        assert_eq!(r.facts.len(), 2, "同 stem 双收：复本行 dedup，fact 不翻倍");
        assert_eq!(r.attempts.get("duplicate").copied().unwrap_or(0), 2);
        assert_eq!(r.skip_rows, 2);
        assert_eq!(
            r.total_token_count_events, 4,
            "四次非复读 token_count（每份 2）"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn compressed_rollout_emits_facts_and_dedups_with_plain_copy() {
        let tmp = temp_dir();
        let plain = tmp.join("rollout-zstd.jsonl");
        let compressed = tmp.join("rollout-zstd.jsonl.zst");
        let bytes = rollout_lines().join("");
        std::fs::write(&plain, &bytes).unwrap();
        let mut compressed_bytes = Vec::new();
        ruzstd::encoding::compress(
            bytes.as_bytes(),
            &mut compressed_bytes,
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        std::fs::write(&compressed, compressed_bytes).unwrap();

        let result = codex_rollouts_to_usage_facts(
            &[plain, compressed], "ns-test", "default").unwrap();
        assert_eq!(result.malformed, 0);
        assert_eq!(result.facts.len(), 2);
        assert_eq!(result.attempts.get("duplicate"), Some(&2));
        assert!(result.facts.iter().all(|fact| fact["source_event_id"]
            .as_str().unwrap_or_default().starts_with("rollout-zstd:")));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn cross_stem_same_json_two_facts_never_merge() {
        // 验收 6.8：同形同 offset 但不同 stem → 各发一条，绝不误合并。
        let tmp = temp_dir();
        let a = tmp.join("rollout-a.jsonl");
        let b = tmp.join("rollout-b.jsonl");
        let bytes = rollout_lines().join("");
        std::fs::write(&a, &bytes).unwrap();
        std::fs::write(&b, &bytes).unwrap();
        let r = codex_rollouts_to_usage_facts(&[a, b], "ns-test", "default").unwrap();
        assert_eq!(
            r.facts.len(),
            4,
            "两 stem 各 2 fact，不因同形同 offset 合并"
        );
        assert_eq!(r.attempts.get("duplicate"), None);
        // 无 session_meta 无关——这里 session_meta 在，但两文件 stem 兜底不同
        let sids: std::collections::HashSet<String> = r
            .facts
            .iter()
            .map(|f| {
                f.get("source_event_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert_eq!(
            sids.len(),
            4,
            "四条 source_event_id 全唯一（stem 命名空间隔离）"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn degraded_file_counts_malformed_and_no_facts() {
        // codex-cost 同款降级：坏 JSON 行 → 整份 malformed + 零事实（不 abort）。
        let tmp = temp_dir();
        let good = tmp.join("rollout-ok.jsonl");
        let bad = tmp.join("rollout-bad.jsonl");
        std::fs::write(&good, rollout_lines().join("")).unwrap();
        std::fs::write(&bad, "{not json}\n").unwrap();
        let r = codex_rollouts_to_usage_facts(&[good, bad], "ns-test", "default").unwrap();
        assert_eq!(r.facts.len(), 2, "好文件照发");
        assert_eq!(r.malformed, 1, "坏文件整份降级 → malformed=1");
        std::fs::remove_dir_all(&tmp).ok();
    }
    /// 增量续读：只处理追加的尾部，且尾部事实的 offset 身份与全量解析一致。
    /// 同时锁定「session_meta/turn_context 不在尾部也要恢复会话与模型」——
    /// 这是折叠游标存在的理由。
    #[test]
    fn resume_reads_only_the_appended_tail_with_restored_cursor() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-resume.jsonl");
        let lines = rollout_lines();
        std::fs::write(&p, lines[..3].join("")).unwrap();
        let empty = std::collections::HashMap::new();
        let (first, states) =
            codex_rollouts_to_usage_facts_with_resume(std::slice::from_ref(&p), "ns-test", "default", &empty)
                .unwrap();
        assert_eq!(first.facts.len(), 1);
        let state = states.get(&p).expect("checkpoint written").clone();
        assert!(state.offset > 0);

        std::fs::OpenOptions::new()
            .append(true)
            .open(&p)
            .unwrap()
            .write_all(lines[3].as_bytes())
            .unwrap();
        let (tail, _) = codex_rollouts_to_usage_facts_with_resume(
            std::slice::from_ref(&p),
            "ns-test",
            "default",
            &states,
        )
        .unwrap();
        assert_eq!(tail.facts.len(), 1, "only the appended line produces a fact");
        assert_eq!(
            tail.facts[0].get("native_session_id").and_then(Value::as_str),
            Some("ses-abc123"),
            "session_meta was in the prefix; resume must restore it"
        );
        assert_eq!(
            tail.facts[0].get("model_raw").and_then(Value::as_str),
            Some("gpt-5-codex"),
            "turn_context cursor must survive the resume"
        );

        let (full, _) =
            codex_rollouts_to_usage_facts_with_resume(std::slice::from_ref(&p), "ns-test", "default", &empty)
                .unwrap();
        assert_eq!(full.facts.len(), 2);
        assert_eq!(
            tail.facts[0].get("source_event_id"),
            full.facts[1].get("source_event_id"),
            "resumed fact must keep the absolute byte-offset identity"
        );
        std::fs::remove_dir_all(tmp).ok();
    }

    /// 文件被截断/替换到 offset 之前：检查点必须失效，退化为全量，绝不能从
    /// 旧的尾部偏移继续读（否则事实永久缺失）。
    #[test]
    fn resume_falls_back_to_full_parse_when_the_file_truncates() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-truncate.jsonl");
        let lines = rollout_lines();
        std::fs::write(&p, lines.join("")).unwrap();
        let empty = std::collections::HashMap::new();
        let (_, states) =
            codex_rollouts_to_usage_facts_with_resume(std::slice::from_ref(&p), "ns-test", "default", &empty)
                .unwrap();
        std::fs::write(&p, lines[0].as_bytes()).unwrap();
        let (after, _) = codex_rollouts_to_usage_facts_with_resume(
            std::slice::from_ref(&p),
            "ns-test",
            "default",
            &states,
        )
        .unwrap();
        assert_eq!(after.malformed, 0);
        assert!(after.facts.is_empty(), "truncated file must be re-read from zero");
        std::fs::remove_dir_all(tmp).ok();
    }


    /// 多帧 zstd rollout：逐帧流式解压后与明文走同一条解析路径，事实数一致。
    #[test]
    fn zstd_multi_frame_rollout_yields_the_same_facts() {
        let tmp = temp_dir();
        let p = tmp.join("rollout-zstd.jsonl.zst");
        let lines = rollout_lines();
        let mut frames: Vec<u8> = Vec::new();
        for chunk in [lines[..2].join(""), lines[2..].join("")] {
            ruzstd::encoding::compress(
                chunk.as_bytes(),
                &mut frames,
                ruzstd::encoding::CompressionLevel::Fastest,
            );
        }
        std::fs::write(&p, frames).unwrap();
        let r =
            codex_rollouts_to_usage_facts(std::slice::from_ref(&p), "ns-test", "default").unwrap();
        assert_eq!(r.facts.len(), 2);
        assert_eq!(r.malformed, 0);
        std::fs::remove_dir_all(tmp).ok();
    }


}
