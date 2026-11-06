//! v0.7 Stage 1：Claude Code 原始 session JSONL → UsageFact emitter（Rust 镜像）。
//!
//! 镜像 `scripts/agent_vitals/agent/claude_usage_fact.py` 的 Python 端实现，
//! 走 `agent_vitals_domain::usage_fact::build_usage_fact` 同一契约函数。
//! Python↔Rust byte-parity 钉测：同一 JSONL 两侧 stdout 字节相等。
//!
//! Stage 1 commit 1（extractor 重构 + golden 零漂移）先落地 fold 侧的字节
//! 不变；commit 2b 落地本模块 Rust 镜像 + parity 钉测；**Stage 1c**（外部
//! 代码审核后修复提交）把 R1 §3.2/§9 的验收契约补全：message.id → 顶层 uuid
//! → offset+canonical-hash fallback 的事件身份链、source_event_id 去重 +
//! duplicate attempt、provider/model 归属不再硬编码 DeepSeek（只留
//! `model_raw`）、time_basis 与 identity_basis 解耦、CLI 无隐式 state 写。
//! 本模块的 `parse_claude_usage_row` 同时被 claude_cost.rs 的 fold
//! `apply_record` 消费（Rust 端单一 row parser，镜像 Python `_apply_record`）。

//! v0.9 Stage A：从 apps/cli/src/agent/ 归位本执行环境 sources 层（R4 §5.2 scope gap）。
//! CLI 命令经 `agent_vitals_harnesses::claude_usage_fact` re-export 走同一实现；行级
//! 原语（`day_from_iso_ts`/`ms_from_iso_ts`/`row_tokens`/键表）下沉纯层
//! `harnesses/claude_code/sessions/usage.rs`，fold 与 emitter 仍共享同一 extractor。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::harnesses::claude_code::sessions::usage::{day_from_iso_ts, ms_from_iso_ts, row_tokens};
use agent_vitals_domain::attribution::{official_endpoint_of, route_shape, RouteShape};
use agent_vitals_domain::source_identity::{canonical_json, fnv1a64_hex};
use agent_vitals_domain::usage::is_peak_slot;
use agent_vitals_domain::usage_fact::build_usage_fact;
use agent_vitals_domain::workflow::WorkflowEvent;

// P0 哨兵常量——与 Python `claude_usage_fact.py` 同源字节。
// pub(crate)：claude_cost.rs 的 fold `apply_record` 消费本模块 parser 时，
// 按 reason 字面量匹配，须能看见这些常量。
pub const SKIP: &str = "skip";
pub const UNREADABLE: &str = "unreadable";
pub const UNATTRIBUTED: &str = "unattributed";
const OBSERVATION_KIND: &str = "assistant-usage";

/// `claude_jsonl_to_usage_facts` 的 Rust 返回类型——`tests/test_claude_usage_fact.py`
/// 对应 `UsageFactEmitResult` NamedTuple。`malformed` 留作未来软失败版（当前
/// I/O 坏行抛异常，不计入 malformed 字段）。
#[derive(Debug)]
pub struct UsageFactEmitResult {
    pub facts: Vec<Value>,
    pub workflow_events: Vec<WorkflowEvent>,
    /// V16 任务意图摘录（user_first/user_turn/assistant_final/subagent_task）。
    /// 不进 `--json` payload（CLI 输出面与 Python 字节镜像不含它），只随
    /// sync 管线落 `session_excerpts` 表。
    pub session_excerpts: Vec<agent_vitals_domain::contracts::workflow::SessionExcerpt>,
    /// V32 会话标题（ai-title 记录）。同上：只随 sync 管线落 `sessions.title`，
    /// 不进 CLI 输出面。
    pub session_titles: Vec<agent_vitals_domain::contracts::workflow::SessionTitle>,
    pub attempts: HashMap<String, i64>,
    pub total_rows: i64,
    pub skip_rows: i64,
    pub malformed: i64,
}

/// §3.2 fallback 事件身份：`stable_source_identity + byte_offset +
/// normalized_row_hash`。byte_offset 是行首在原文件的字节位置（不以行号
/// 替代）；row hash = canonical JSON 的 FNV-1a。与 Python `_derived_event_id`
/// 字节一致。canonical/FNV 原语在 core `source_identity`（Claude/Codex/DSH/
/// UsageFact ID 共享，不许本模块长第二份）。同一文件重复读取稳定（checkpoint
/// resume 从 from_byte 续读时，已折行的 offset 不变，fact-id 集合与 full
/// replay 一致）。
fn derived_event_id(native_session_id: &str, byte_offset: usize, rec: &Value) -> String {
    let mut canonical = String::new();
    canonical_json(rec, &mut canonical);
    format!(
        "{}:{}:{}",
        native_session_id,
        byte_offset,
        fnv1a64_hex(canonical.as_bytes())
    )
}

/// `parse_claude_usage_row` 的 Rust 镜像——单条 JSON record → `Ok(Observation)`
/// 或 `Err(reason)`。与 Python `parse_claude_usage_row` 字段映射逐字段一致。
///
/// Sentinel reason 与 Python 同名字面量（`"skip"` / `"unreadable"` /
/// `"unattributed"`），保证 attempt 计数跨语言字节相等。fold 的
/// `apply_record` 与 emitter 共用本函数（R1「共享 extractor」——两端一个
/// row parser，不允许第二套 wire-shape 解释）。
pub fn parse_claude_usage_row(
    rec: &Value,
    native_session_id: &str,
    machine_namespace: &str,
    source_profile: &str,
) -> Result<Observation, &'static str> {
    let obj = match rec.as_object() {
        Some(o) => o,
        None => return Err(SKIP),
    };
    let rtype = obj.get("type").and_then(Value::as_str).unwrap_or("");
    if rtype != "assistant" {
        return Err(SKIP);
    }
    let msg = match obj.get("message").and_then(Value::as_object) {
        Some(m) => m,
        None => return Err(SKIP),
    };
    let usage = match msg.get("usage") {
        Some(u @ Value::Object(_)) if !u.as_object().unwrap().is_empty() => u,
        _ => return Err(SKIP),
    };
    let model = match msg.get("model").and_then(Value::as_str) {
        Some(m) if !m.is_empty() => m,
        _ => return Err(UNREADABLE),
    };
    // 复用 fold 的 `row_tokens`（claude_cost.rs，R1「共享 extractor」commit
    // d0ec2f2）——两态都认、全形优先，fold 与 emitter 不得各自解释 usage 形状。
    // 缺失 / 非数 → None → UNREADABLE（corpus 值全非负 int；负值/超宽等病理
    // 输入 Python 任意精度与 Rust as_u64 的分歧面见 row_tokens 注释，不追平）。
    let Some([in_t, cr_t, cw_t, out_t]) = row_tokens(usage) else {
        return Err(UNREADABLE);
    };
    let ts = obj.get("timestamp").and_then(Value::as_str).unwrap_or("");
    // 只校验 ts 可归日（mirror Python：day 解析失败 → UNATTRIBUTED）。
    let Some(day) = day_from_iso_ts(ts) else {
        return Err(UNATTRIBUTED);
    };
    // ms/peak：fold 面 tail_days 峰谷归位。ms 解析失败（day_from_iso_ts 认过的
    // 字符串上理论上不该发生，防御性兜底）→ peak=false，同 `usage::is_peak`
    // 的「缺 time 不臆造高峰」纪律。
    let ms = ms_from_iso_ts(ts);
    let peak = ms.is_some_and(is_peak_slot);
    // 原生事件身份（Stage 1c §3.2/§9 补全）：message.id → 顶层 uuid。真机
    // assistant 行的 uuid 位于**顶层**（与 message.id 并存）；只认 message.id
    // 会让缺 message.id 但有 uuid 的行被错降级成 derived。offset+hash fallback
    // 由文件级迭代器补（需要行字节偏移 + 原始 record）——本 parse 是纯
    // record→result 映射、不掺 I/O，fold 调用它也不受影响。
    let native = msg
        .get("id")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| obj.get("uuid").and_then(Value::as_str).map(String::from));
    let (identity_basis, source_event_id) = match native {
        Some(id) => ("native", id),
        None => ("derived-hash", String::new()),
    };
    let request_id = obj.get("requestId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    let message_id = msg.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    Ok(Observation {
        native_session_id: native_session_id.to_string(),
        machine_namespace: machine_namespace.to_string(),
        source_profile: source_profile.to_string(),
        ts_iso: ts.to_string(),
        day,
        ms,
        peak,
        model: model.to_string(),
        input_tokens: in_t,
        cache_read_tokens: cr_t,
        cache_write_tokens: cw_t,
        output_tokens: out_t,
        source_event_id,
        identity_basis: identity_basis.to_string(),
        observation_kind: OBSERVATION_KIND.to_string(),
        request_id,
        message_id,
    })
}

/// 单条有效 assistant usage row 的最小事实单元——镜像 Python
/// `ClaudeUsageObservation`。fold（claude_cost.rs `apply_record`）与 emitter
/// 共用本结构：fold 读 `day`/`model`/token 4 桶/`peak`，emitter 读
/// `source_event_id`/`identity_basis` 等身份字段。UsageFact 事实行用原始
/// `ts_iso` 作 event_ts_utc、不物化归日/峰谷（那是物化视图派生，spec §2.1）。
///
/// `source_event_id`：message.id / 顶层 uuid 原生 id；两者都缺时为空串、
/// `identity_basis="derived-hash"`，由文件级迭代器填 offset+hash fallback。
#[derive(Debug, Clone)]
pub struct Observation {
    pub native_session_id: String,
    pub machine_namespace: String,
    pub source_profile: String,
    pub ts_iso: String,
    pub day: String,
    /// 镜像 Python NamedTuple 的 `ms`（epoch ms）。fold 只用已算好的 `peak`，
    /// ms 本身不被消费——保留是为了与 Python Observation 逐字段同构。
    #[allow(dead_code)]
    pub ms: Option<i64>,
    pub peak: bool,
    pub model: String,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub source_event_id: String,
    pub identity_basis: String,
    pub observation_kind: String,
    /// 顶层 `requestId`（Anthropic 官方端点为 `req_01…`）与 `message.id`——
    /// L1 路由证据的原料（自动归因规格 §1.2）。缺场即 None，不猜。
    pub request_id: Option<String>,
    pub message_id: Option<String>,
}

impl Observation {
    fn to_usage_fact(&self) -> Option<Value> {
        // 防御：source_event_id 空（本不该——iter 已给 derived-hash 补
        // fallback；保留 `bad_id` 哨兵是因为 builder 是唯一校验方，不许绕开
        // 它自证身份合法）→ None。
        if self.source_event_id.is_empty() {
            return None;
        }
        let mut fields = Map::new();
        fields.insert("machine_namespace".into(), json!(self.machine_namespace));
        fields.insert("harness".into(), json!("claude-code"));
        fields.insert("source_profile".into(), json!(self.source_profile));
        fields.insert("native_session_id".into(), json!(self.native_session_id));
        fields.insert("source_event_id".into(), json!(self.source_event_id));
        fields.insert("observation_kind".into(), json!(self.observation_kind));
        fields.insert("identity_basis".into(), json!(self.identity_basis));
        fields.insert("event_ts_utc".into(), json!(self.ts_iso));
        // time_basis 与 identity_basis 解耦（Stage 1c）：fact 只在原生 ts 可归日
        // 时发射（否则 unattributed skip），事件时间证据恒为原生。
        fields.insert("time_basis".into(), json!("native"));
        fields.insert("source_usage_semantics".into(), json!("delta"));
        // L1 路由证据（自动归因规格 §1.2/§2）：从模型名**不**推计费方，但每条记录
        // 自带的请求/响应 ID 形状是路由证据——`req_01…`+`msg_01…` 同时命中 =
        // Anthropic 官方端点（session-native，计费方 anthropic、按量、route-observed）；
        // 响应 ID 只与模型厂商形状一致或是网关式命名 = inferred（计费方仍未知，
        // 用户按厂商答一次「官方端点还是中转」）；什么都没有 = missing（现状）。
        // attribution_version 升到 v1.0-beta.1：fact_writer_sql 见版本变化按重分类
        // 路径改写存量事实，而不是把 missing→session-native 记成 attribution_conflict。
        let shape = route_shape(&self.model, self.request_id.as_deref(), self.message_id.as_deref());
        // 计费方仍由 `resolve_billing_attribution` 一个判定器决定（A4）：官方形状 →
        // 会话级 RouteEvidence 喂给它，得到 provider/pricing_basis；非官方形状不构造
        // RouteEvidence（provider_raw 留空——一个非空的 raw 会经 normalize_provider
        // 变成 provider_id，把"厂商形状一致"冒充成"计费方已定"）。
        let (provider_raw, endpoint_host, provider_id, pricing_basis) = match &shape {
            RouteShape::OfficialVendor(vendor) => {
                let route = agent_vitals_provider::RouteEvidence {
                    provider_raw: Some(vendor.clone()),
                    endpoint_host: official_endpoint_of(vendor),
                    evidence_basis: agent_vitals_provider::EvidenceBasis::SessionNative,
                };
                let attribution = agent_vitals_provider::resolve_billing_attribution(None, Some(&route));
                (route.provider_raw.clone(), route.endpoint_host.clone(), attribution.provider_id, attribution.pricing_basis)
            }
            _ => (None, None, None, "metered_estimate".to_string()),
        };
        let evidence_basis = shape.evidence_basis();
        let route_evidence_id = if matches!(shape, RouteShape::Unknown) {
            Value::Null
        } else {
            let shape_key = match &shape {
                RouteShape::OfficialVendor(v) => format!("official:{v}"),
                RouteShape::VendorShape(v) => format!("vendor-shape:{v}"),
                RouteShape::Gateway => "gateway".to_string(),
                RouteShape::Unknown => String::new(),
            };
            let key = format!(
                "claude-code|{}|{}|{}|{}|{}",
                self.native_session_id, shape_key,
                provider_raw.as_deref().unwrap_or(""), endpoint_host.as_deref().unwrap_or(""), evidence_basis,
            );
            json!(format!("route:{}", fnv1a64_hex(key.as_bytes())))
        };
        fields.insert("provider_raw".into(), json!(provider_raw));
        fields.insert("endpoint_host".into(), json!(endpoint_host));
        fields.insert("provider_id".into(), json!(provider_id));
        fields.insert("billing_source".into(), json!(provider_id));
        fields.insert("billing_mode".into(), json!("metered"));
        fields.insert("pricing_basis".into(), json!(pricing_basis));
        fields.insert("evidence_basis".into(), json!(evidence_basis));
        fields.insert("route_evidence_id".into(), route_evidence_id);
        fields.insert("normalization_version".into(), json!("provider-v0.11"));
        fields.insert("attribution_version".into(), json!("provider-v1.0-beta.1"));
        // provider/model 归属（Stage 1c）：只保留原始证据 `model_raw`。DATA_PLANE
        // §2.1「raw 值不可改；规范化 id 由带版本的映射产生」——没有 resolver 就
        // 不填 model_id/model_normalized/provider_id/provider_raw/normalization_version
        // （序列化为 None），绝不用单一真机 provider 硬编码冒充真值。
        fields.insert("model_raw".into(), json!(self.model));
        fields.insert("uncached_input_tokens".into(), json!(self.input_tokens));
        fields.insert("cache_read_tokens".into(), json!(self.cache_read_tokens));
        fields.insert("cache_write_tokens".into(), json!(self.cache_write_tokens));
        fields.insert("output_tokens".into(), json!(self.output_tokens));
        build_usage_fact(&fields).ok()
    }
}

/// 整份 Claude JSONL → `UsageFactEmitResult`。
///
/// 与 Python `claude_jsonl_to_usage_facts` 字节等价：
/// - facts 顺序按 record 顺序；
/// - 每条 Observation 的 source_event_id 已解析：原生 id（message.id/顶层
///   uuid），或 derived offset+hash fallback（§3.2，Stage 1c 补全）；
/// - 同一 session 重复 source_event_id 只保留一个 fact、计 duplicate attempt
///   （§3.4，不加 ordinal 掩盖重复）；
/// - attempts 键集合 = `{"skip","unreadable","unattributed"}` + 可选
///   `"duplicate"`（重复）/ `"bad_id"`（builder 防御性拒绝）；
/// - total_rows / skip_rows 计数按 record 顺序（cost-state 不算 usage 但算
///   total_rows，因为它被读了）；
/// - malformed 恒 0（commit 1 既有 I/O 行为：坏行抛异常）。
///
/// 行切分镜像 Python `_read_suffix`（claude_cost.py）的字节级语义：按 `\n`
/// 切完整行、剥尾 `\r`、空行跳过；**末行无换行符不消费**（写入方可能写到
/// 一半，与 fold 尾读续折同款「绝不拼半截」）。`BufRead::lines()` 会把无换行
/// 结尾的末段当成一行——与 Python 语义分叉，故不用它。行首字节偏移在整份
/// 读取下即绝对文件偏移，直接喂给 derived fallback。
/// 增量版：从 `from_offset` 续读到 EOF，只解析新行。
/// 返回 (facts, new_offset)——new_offset 是最后完整换行后的位置（spec §5.2）。
/// 尾部不完整行（写了一半的 in-flight JSON）留给下轮，不报错。
/// **差分门验收**：同一文件 full-parse 与 incremental-parse 产出的 fact 集
/// 必须逐条 fact_id 一致（`agent-vitals-runtime` 的 source_graph 差分测试钉住）。
/// 增量版：从 `from_offset` 续读到 EOF，只解析新行（spec §5.2）。
/// 返回 (facts, new_offset)；new_offset 是换行边界。
/// 差分门（runtime source_graph）钉住 fact_id 一致性（含 derived-hash 路径）。
pub fn claude_jsonl_to_usage_facts_incremental(
    path: &Path,
    machine_namespace: &str,
    source_profile: &str,
    native_session_id: &str,
    from_offset: u64,
) -> Result<(Vec<Value>, u64), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("open {}: {}", path.display(), e))?;
    let file_len = file.metadata()
        .map_err(|e| format!("stat {}: {}", path.display(), e))?
        .len();
    if from_offset >= file_len {
        return Ok((Vec::new(), from_offset)); // 无增量
    }
    file.seek(SeekFrom::Start(from_offset))
        .map_err(|e| format!("seek {}: {}", path.display(), e))?;
    let mut buf = Vec::with_capacity((file_len - from_offset) as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;

    // 停在最后完整换行：尾部不完整行是 in-flight writer，留给下轮。
    let last_newline = buf.iter().rposition(|&b| b == b'\n');
    let Some(last_nl) = last_newline else {
        return Ok((Vec::new(), from_offset)); // 没有完整行，全部留给下轮
    };
    let complete = &buf[..=last_nl];
    let new_offset = from_offset + (last_nl + 1) as u64;

    // 解析（复用 parse_claude_usage_row 的逐行循环，但 start 从 0 计——
    // 行首偏移已在全文件坐标系里，derived_event_id 的 line_offset 需要加上
    // from_offset 基准才能与全量版一致）。
    let mut facts = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut start = 0usize;
    for (i, b) in complete.iter().enumerate() {
        if *b != b'\n' { continue; }
        let line = &complete[start..i];
        let line_offset = start + from_offset as usize; // 全文件坐标
        let mut line = line;
        if line.ends_with(b"\r") { line = &line[..line.len() - 1]; }
        start = i + 1;
        if line.is_empty() { continue; }
        let text = String::from_utf8_lossy(line);
        let rec: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue, // 增量模式：坏行跳过（不报错——全量版已在首
                                // 轮报过或行本身就是不完整的中间态）
        };
        match parse_claude_usage_row(&rec, native_session_id, machine_namespace, source_profile) {
            Ok(mut obs) => {
                if obs.identity_basis == "derived-hash" && obs.source_event_id.is_empty() {
                    obs.source_event_id = derived_event_id(native_session_id, line_offset, &rec);
                }
                if seen.contains(&obs.source_event_id) { continue; }
                seen.insert(obs.source_event_id.clone());
                if let Some(fact) = obs.to_usage_fact() {
                    facts.push(fact);
                }
            }
            Err(_) => continue, // 增量模式：非 usage 行跳过
        }
    }
    Ok((facts, new_offset))
}

/// 全量版：整个 JSONL 文件从头解析。与 Python 逐字节 parity（golden 覆盖）。
/// 产 UsageFactEmitResult（facts + attempts + coverage + workflow_events + excerpts）。
pub fn claude_jsonl_to_usage_facts(
    path: &Path,
    machine_namespace: &str,
    source_profile: &str,
    native_session_id: &str,
) -> Result<UsageFactEmitResult, String> {
    let data = std::fs::read(path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    let mut facts = Vec::new();
    let mut attempts: HashMap<String, i64> = HashMap::new();
    attempts.insert(SKIP.to_string(), 0);
    attempts.insert(UNREADABLE.to_string(), 0);
    attempts.insert(UNATTRIBUTED.to_string(), 0);
    let mut seen: HashSet<String> = HashSet::new();
    let mut duplicate = 0i64;
    let mut bad_id = 0i64;
    let mut total_rows = 0i64;
    let mut skip_rows = 0i64;
    let mut start = 0usize;
    for (i, b) in data.iter().enumerate() {
        if *b != b'\n' {
            continue;
        }
        let line_offset = start; // 行首绝对字节偏移（整份从 0 读）
        let mut line = &data[start..i];
        if line.ends_with(b"\r") {
            line = &line[..line.len() - 1];
        }
        start = i + 1;
        if line.is_empty() {
            continue;
        }
        total_rows += 1;
        // Python `json.loads(..., errors="replace")` → `String::from_utf8_lossy`
        // 同款：坏 UTF-8 字节替换而非报错（正常 JSONL 都是合法 UTF-8，此路
        // 只是防御镜像）。
        let text = String::from_utf8_lossy(line);
        let rec: Value = serde_json::from_str(&text).map_err(|e| {
            format!("non-json line in {} at row {}: {}", path.display(), total_rows, e)
        })?;
        match parse_claude_usage_row(&rec, native_session_id, machine_namespace, source_profile) {
            Ok(mut obs) => {
                if obs.identity_basis == "derived-hash" && obs.source_event_id.is_empty() {
                    obs.source_event_id =
                        derived_event_id(native_session_id, line_offset, &rec);
                }
                if seen.contains(&obs.source_event_id) {
                    // §3.4 重复 native event id → duplicate attempt，只留一个 fact。
                    duplicate += 1;
                    skip_rows += 1;
                    continue;
                }
                seen.insert(obs.source_event_id.clone());
                match obs.to_usage_fact() {
                    Some(fact) => facts.push(fact),
                    None => {
                        // 防御性 bad_id 哨兵（identity 校验被 builder 拒绝）
                        bad_id += 1;
                        skip_rows += 1;
                    }
                }
            }
            Err(reason) => {
                *attempts.entry(reason.to_string()).or_insert(0) += 1;
                skip_rows += 1;
            }
        }
    }
    if duplicate > 0 {
        attempts.insert("duplicate".to_string(), duplicate);
    }
    if bad_id > 0 {
        attempts.insert("bad_id".to_string(), bad_id);
    }
    // V16：workflow 富化与任务意图摘录同一次读取产出（分开口会双读整个文件）。
    // V32：会话标题同趟带出（ai-title 也在同一份记录流里）。
    let (workflow_events, session_excerpts, session_titles) = super::workflow::claude_file_to_workflow_events(
        path, machine_namespace, source_profile, native_session_id,
    )?;
    Ok(UsageFactEmitResult {
        facts,
        workflow_events,
        session_excerpts,
        session_titles,
        attempts,
        total_rows,
        skip_rows,
        malformed: 0,
    })
}

/// CLI `--json` 输出的完整 payload——键序与 Python
/// `scan.py claude-usage-facts --json -`（`cli.py::claude-usage-facts` handler
/// 的 `facts_out` dict 插入序）逐键一致：native_session_id, machine_namespace,
/// source_profile, facts, attempts, coverage, malformed。attempts/coverage 子
/// 对象同样按 Python dict 的插入序显式构造（HashMap 自身无序，不能直接序列化）。
pub fn to_payload_value(
    result: &UsageFactEmitResult,
    native_session_id: &str,
    machine_namespace: &str,
    source_profile: &str,
) -> Value {
    let mut out = Map::new();
    out.insert("native_session_id".to_string(), json!(native_session_id));
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
    cov.insert("total_rows".to_string(), json!(result.total_rows));
    cov.insert("fact_rows".to_string(), json!(result.facts.len()));
    cov.insert("skip_rows".to_string(), json!(result.skip_rows));
    out.insert("coverage".to_string(), Value::Object(cov));
    out.insert("malformed".to_string(), json!(result.malformed));
    Value::Object(out)
}

/// 人读摘要——逐行镜像 Python handler 的 print（含 `Attempts:` 行的 dict repr：
/// `{'skip': 3, 'unreadable': 0, ...}`，键单引号、逗号+空格）。诊断面不是
/// parity 测试面，但保持双语言同源字节，免得两套人读输出漂移。
pub fn to_human_summary(
    result: &UsageFactEmitResult,
    source_path: &Path,
    native_session_id: &str,
    machine_namespace: &str,
    source_profile: &str,
) -> String {
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
        "Source: {}\nNative session id: {}\nMachine namespace: {}\nSource profile: {}\n\
         Facts: {} (rows={}, skip={})\nAttempts: {{{}}}\n",
        source_path.display(),
        native_session_id,
        machine_namespace,
        source_profile,
        result.facts.len(),
        result.total_rows,
        result.skip_rows,
        attempts_parts.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEMP_DIR_NONCE: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);

    fn line(rec: serde_json::Value) -> String {
        format!("{}\n", serde_json::to_string(&rec).unwrap())
    }

    fn temp_dir() -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "av-claude-usage-fact-test-{}-{}-{}",
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

    #[test]
    fn parse_assistant_with_id_marks_native() {
        let obs = parse_claude_usage_row(
            &json!({
                "type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
                "message": {
                    "id": "msg_x", "model": "deepseek-v4-flash",
                    "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                              "cache_creation_input_tokens": 0, "output_tokens": 0}
                }
            }),
            "sid", "ns", "default",
        )
        .unwrap();
        assert_eq!(obs.source_event_id, "msg_x");
        assert_eq!(obs.identity_basis, "native");
        assert_eq!(obs.day, "2026-09-02");
        // day/ms/peak 面已填充（fold 的 tail_days 消费它们，见 claude_cost.rs）
        assert!(obs.ms.is_some(), "ts 可解析 → ms 应非 None");
    }

    #[test]
    fn uuid_top_level_used_when_no_message_id() {
        // Stage 1c：缺 message.id 但有顶层 uuid → 原生（不再是 derived）。
        // 真机 assistant 行 uuid 位于顶层。
        let obs = parse_claude_usage_row(
            &json!({
                "type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
                "uuid": "uuid_1",
                "message": {"model": "m",
                            "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                      "cache_creation_input_tokens": 0, "output_tokens": 0}}
            }),
            "sid", "ns", "default",
        )
        .unwrap();
        assert_eq!(obs.source_event_id, "uuid_1");
        assert_eq!(obs.identity_basis, "native");
    }

    #[test]
    fn message_id_takes_priority_over_uuid() {
        let obs = parse_claude_usage_row(
            &json!({
                "type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
                "uuid": "uuid_9",
                "message": {"id": "msg_x", "model": "m",
                            "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                      "cache_creation_input_tokens": 0, "output_tokens": 0}}
            }),
            "sid", "ns", "default",
        )
        .unwrap();
        assert_eq!(obs.source_event_id, "msg_x");
        assert_eq!(obs.identity_basis, "native");
    }

    #[test]
    fn parse_cost_state_returns_skip() {
        let r = parse_claude_usage_row(
            &json!({"type": "cost-state", "modelUsage": {}}),
            "sid", "ns", "default",
        );
        assert_eq!(r.unwrap_err(), SKIP);
    }

    #[test]
    fn parse_no_message_id_marks_derived_hash() {
        // parse 层（无 I/O）：两者都缺 → source_event_id 空 + derived-hash；
        // offset+hash fallback 由文件级迭代器补（emitter_dedups/derived 测试见下）。
        let obs = parse_claude_usage_row(
            &json!({
                "type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
                "message": {"model": "m",
                            "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                      "cache_creation_input_tokens": 0, "output_tokens": 0}}
            }),
            "sid", "ns", "default",
        )
        .unwrap();
        assert_eq!(obs.source_event_id, "");
        assert_eq!(obs.identity_basis, "derived-hash");
        assert!(obs.to_usage_fact().is_none(),
                "derived-hash + 空 source_event_id → 防御性 bad_id，不在 parse 层发射");
    }

    #[test]
    fn parse_bad_ts_returns_unattributed() {
        let r = parse_claude_usage_row(
            &json!({
                "type": "assistant", "timestamp": "bogus",
                "message": {"model": "m",
                            "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                      "cache_creation_input_tokens": 0, "output_tokens": 0}}
            }),
            "sid", "ns", "default",
        );
        assert_eq!(r.unwrap_err(), UNATTRIBUTED);
    }

    #[test]
    fn parse_no_model_returns_unreadable() {
        let r = parse_claude_usage_row(
            &json!({
                "type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
                "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                      "cache_creation_input_tokens": 0, "output_tokens": 0}}
            }),
            "sid", "ns", "default",
        );
        assert_eq!(r.unwrap_err(), UNREADABLE);
    }

    #[test]
    fn parse_short_keys_shape_also_accepted() {
        // Python `test_short_keys_shape_also_accepted` 的镜像：row_tokens 嗅两态
        // ——短键（真机 0 命中但仍认）也走 Observation。commit 1 前 Rust fold 已
        // 认短键（differential 过 sess2），emitter 复用同一 row_tokens 后行为一致。
        let obs = parse_claude_usage_row(
            &json!({
                "type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
                "message": {"id": "msg_short", "model": "m",
                            "usage": {"input": 1, "cache_read": 2,
                                      "cache_creation": 3, "output": 4}}
            }),
            "sid", "ns", "default",
        )
        .unwrap();
        assert_eq!(obs.input_tokens, 1);
        assert_eq!(obs.cache_read_tokens, 2);
        assert_eq!(obs.cache_write_tokens, 3);
        assert_eq!(obs.output_tokens, 4);
        assert_eq!(obs.source_event_id, "msg_short");
    }

    #[test]
    fn emitter_dedups_duplicate_and_counts_attempt() {
        // §3.4：同一 session 重复相同 native event id → 只保留一个 fact +
        // duplicate attempt。
        let tmp = temp_dir();
        let p = tmp.join("sid.jsonl");
        std::fs::write(
            &p,
            [
                line(json!({"type":"assistant","timestamp":"2026-09-02T03:00:00.000Z",
                            "message":{"id":"msg_dup","model":"m",
                                       "usage":{"input_tokens":1,"cache_read_input_tokens":0,
                                                "cache_creation_input_tokens":0,"output_tokens":0}}})),
                line(json!({"type":"assistant","timestamp":"2026-09-02T04:00:00.000Z",
                            "message":{"id":"msg_dup","model":"m",
                                       "usage":{"input_tokens":1,"cache_read_input_tokens":0,
                                                "cache_creation_input_tokens":0,"output_tokens":0}}})),
            ]
            .join(""),
        )
        .unwrap();
        let r = claude_jsonl_to_usage_facts(&p, "ns", "default", "sid").unwrap();
        assert_eq!(r.facts.len(), 1, "重复 id 只保留一个 fact");
        assert_eq!(r.attempts.get("duplicate").copied().unwrap_or(0), 1);
        assert_eq!(r.skip_rows, 1);
        assert_eq!(r.attempts.get("bad_id"), None, "防御性 bad_id 不该触发");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn emitter_derived_fallback_emits_fact_not_bad_id() {
        // §6.1 验收 4：message.id 与 uuid 都缺 → 稳定 fallback 也产 fact，
        // 绝不把合法 usage 行当 bad_id 丢掉。derived id 带 byte offset + hash。
        let tmp = temp_dir();
        let p = tmp.join("sid.jsonl");
        std::fs::write(
            &p,
            line(json!({"type":"assistant","timestamp":"2026-09-02T03:00:00.000Z",
                        "message":{"model":"m",
                                   "usage":{"input_tokens":1,"cache_read_input_tokens":0,
                                            "cache_creation_input_tokens":0,"output_tokens":0}}})),
        )
        .unwrap();
        let r = claude_jsonl_to_usage_facts(&p, "ns", "default", "sid").unwrap();
        assert_eq!(r.facts.len(), 1, "derived fallback 必须产 fact");
        assert_eq!(r.attempts.get("bad_id"), None, "fallback 后不该再走 bad_id");
        let f = &r.facts[0];
        assert_eq!(f.get("identity_basis").and_then(Value::as_str), Some("derived-hash"));
        let sid = f.get("source_event_id").and_then(Value::as_str).unwrap_or("");
        // sid-1975m 形式的 <native_session_id>:<byte_offset>:<16 hex row hash>
        assert!(sid.starts_with("sid:0:"), "derived id 应含 byte offset 0：{sid}");
        assert_eq!(sid.len(), 3 + 1 + 1 + 1 + 16, "sid:0:<16hex>");
        // provider/model 归属：只留 model_raw，model_id/provider_id 不硬编码。
        assert_eq!(f.get("model_raw").and_then(Value::as_str), Some("m"));
        assert_eq!(f.get("provider_id").and_then(Value::as_str), None,
                   "provider_id 不许硬编码 DeepSeek（Stage 1c）");
        assert_eq!(f.get("model_id").and_then(Value::as_str), None);
        assert_eq!(f.get("time_basis").and_then(Value::as_str), Some("native"),
                   "time_basis 独立于 identity_basis——derived 事件也有原生 ts");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn end_to_end_real_world_three_sessions() {
        // 复用 commit 6421f2a 的真机数字：每份 1 cost-state + 4 assistant
        // 行，cache_read 合计 66.6M（spec §5 后段点名数字）。
        let rows = |sid_start: i64, baseline: i64, per: i64| -> Vec<String> {
            vec![
                line(json!({
                    "type": "cost-state", "timestamp": "2026-09-01T18:00:00.000Z",
                    "startTime": sid_start,
                    "modelUsage": {"deepseek-v4-flash": {
                        "inputTokens": 0, "outputTokens": 0,
                        "cacheReadInputTokens": baseline,
                        "cacheCreationInputTokens": 0,
                        "webSearchRequests": 0, "costUSD": 0.0}},
                    "hasUnknownModelCost": false
                })),
                line(json!({
                    "type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
                    "message": {"id": "msg_3h", "model": "deepseek-v4-flash",
                                "usage": {"input_tokens": 0, "cache_read_input_tokens": per,
                                          "cache_creation_input_tokens": 0, "output_tokens": 0}}
                })),
                line(json!({
                    "type": "assistant", "timestamp": "2026-09-02T05:00:00.000Z",
                    "message": {"id": "msg_5h", "model": "deepseek-v4-flash",
                                "usage": {"input_tokens": 0, "cache_read_input_tokens": per,
                                          "cache_creation_input_tokens": 0, "output_tokens": 0}}
                })),
                line(json!({
                    "type": "assistant", "timestamp": "2026-09-02T07:00:00.000Z",
                    "message": {"id": "msg_7h", "model": "deepseek-v4-flash",
                                "usage": {"input_tokens": 0, "cache_read_input_tokens": per,
                                          "cache_creation_input_tokens": 0, "output_tokens": 0}}
                })),
                line(json!({
                    "type": "assistant", "timestamp": "2026-09-02T09:00:00.000Z",
                    "message": {"id": "msg_9h", "model": "deepseek-v4-flash",
                                "usage": {"input_tokens": 0, "cache_read_input_tokens": per,
                                          "cache_creation_input_tokens": 0, "output_tokens": 0}}
                })),
            ]
        };
        let tmp = temp_dir();
        // 2279b7b0: baseline 38.7M, rows 5.7M (1.5+1.5+1.5+1.2M)
        let p1 = tmp.join("2279b7b0.jsonl");
        std::fs::write(&p1, rows(1_788_192_000_000, 38_700_000, 1_425_000).join("")).unwrap();
        // 753e080a: baseline 137.1M, rows 44.9M (4 × 11.225M)
        let p2 = tmp.join("753e080a.jsonl");
        std::fs::write(&p2, rows(1_788_235_200_000, 137_100_000, 11_225_000).join("")).unwrap();
        // b695a35f: baseline 88.3M, rows 16.0M (4 × 4.0M)
        let p3 = tmp.join("b695a35f.jsonl");
        std::fs::write(&p3, rows(1_788_170_400_000, 88_300_000, 4_000_000).join("")).unwrap();
        // 合并三份
        let mut all_facts: Vec<Value> = Vec::new();
        let mut total_rows = 0i64;
        let mut skip_rows = 0i64;
        let mut total_attempts: HashMap<String, i64> = HashMap::new();
        for (p, sid) in [(&p1, "2279b7b0"), (&p2, "753e080a"), (&p3, "b695a35f")] {
            let r = claude_jsonl_to_usage_facts(p, "ns-test", "default", sid).unwrap();
            all_facts.extend(r.facts);
            total_rows += r.total_rows;
            skip_rows += r.skip_rows;
            for (k, v) in &r.attempts {
                *total_attempts.entry(k.clone()).or_insert(0) += v;
            }
        }
        assert_eq!(total_rows, 15, "3 份 × (1 cost-state + 4 assistant) = 15");
        assert_eq!(all_facts.len(), 12);
        assert_eq!(skip_rows, 3, "15 行 − 12 fact = 3 skip（全为 cost-state）");
        assert_eq!(total_attempts.get(SKIP).copied().unwrap_or(0), 3);
        assert_eq!(total_attempts.get("duplicate"), None, "真机语料无重复 id");
        assert_eq!(total_attempts.get("bad_id"), None);
        // 合计 cache_read tokens = 66.6M
        let cr_total: i64 = all_facts.iter()
            .map(|f| f.get("cache_read_tokens").and_then(Value::as_i64).unwrap_or(0))
            .sum();
        assert_eq!(cr_total, 66_600_000,
                   "spec §5 后段点名：1.5+1.5+1.5+1.2 + 11.225×4 + 4.0×4 = 66.6M cache_read");
        // 每条 fact identity_basis=native（每条都有 msg_id）
        assert!(all_facts.iter().all(|f| f.get("identity_basis")
                                     .and_then(Value::as_str) == Some("native")));
        // fact_id 跨三会话唯一
        let ids: Vec<String> = all_facts.iter()
            .map(|f| f.get("fact_id").and_then(Value::as_str).unwrap_or("").to_string())
            .collect();
        assert_eq!(ids.len(), 12);
        let unique: HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), 12);
        std::fs::remove_dir_all(&tmp).ok();
    }

    // ── 防误用 ────────────────────────────────────────────────────
    // `Map` import 保留表明本模块对 serde_json::Map 的依赖（避免下游
    // 误删 use 后引入未使用的类型）。
    #[allow(dead_code)]
    fn _map_type_kept(_: Map<String, Value>) {}
    #[test]
    fn map_type_kept() {
        _map_type_kept(Map::new());
    }
}
