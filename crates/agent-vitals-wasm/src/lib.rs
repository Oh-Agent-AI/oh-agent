//! Browser wasm entry: pure behavior audit + cost folding over events already
//! in memory.
//!
//! The contract is JSON in / JSON out — the harness serializes the raw session
//! events it has already read from disk into a JSON string, and these functions
//! return the Behavior Finding list / per-model token report as JSON strings.
//! No I/O here, and none possible: `match_behavior` and `usage::token_by_model`
//! are the pure domain crate (crates/agent-vitals-domain). The DSH audit tab folds the
//! same rules as the CLI — never a second copy.

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

/// 事件数组（DSH SessionEvent 的 camelCase 封套）→ Behavior Finding 数组。
///
/// 输入是 `JSON.stringify(events)`，输出是 `JSON.stringify(findings)`。输入不是
/// 合法 JSON 数组时返回 `"[]"`（浏览器侧总会传合法 JSON，这里只是容错，不是
/// 数据源）。`workspace_root` 为空串表示未知——SV605 会退化为纯绝对路径启发式
/// （宁可多报不误放）。
#[wasm_bindgen]
pub fn audit_events(events_json: &str, workspace_root: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let ws = if workspace_root.is_empty() { None } else { Some(workspace_root) };
    // 单事件规则（SV601–610）在前、轨迹级检测（SV611–614）追加在后——tab 与 CLI
    // 跑的是同一份 core 引擎。
    // raw-events → findings 的 DSH shim（phase C 起住 adapter，规则本体仍是 core
    // 的 `match_{behavior,trajectory}_canonical`——从不是第二份拷贝）。
    let mut findings = agent_vitals_harnesses::audit::match_behavior(&events, ws);
    findings.extend(agent_vitals_harnesses::audit::match_trajectory(&events));
    serde_json::to_string(&findings).unwrap_or_else(|_| "[]".to_string())
}

/// 成本账事件数组 → 按模型分桶的 token 报告。
///
/// 与 `audit_events` 同契约：输入 `JSON.stringify(events)`，输出
/// `JSON.stringify(token_by_model(events))`——`{"by_model": {...}, "sequence": [...]}`
/// （snake_case）。CLI 与浏览器 tab 都走同一份 core 折叠（单一真相源）；tab 的
/// 执行环境半份把 usage 事件喂进来，客户端只读投影渲染。
#[wasm_bindgen]
pub fn token_by_model(events_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let report = agent_vitals_domain::usage::token_by_model(&events);
    serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
}

/// 成本账事件数组 → 按 (date, hour) 折叠的 token 桶。
///
/// 与 `token_by_model` / `request_metrics` 同契约：JSON in / JSON out，
/// 浏览器 tab 与 CLI 共用同一份 core 折叠。DSH 审计 tab 的日历视图读这个
/// 投影(逐小时柱形 + 月历热力图);xbar tick 脚本**不**走 wasm(本地 shell
/// 直接读 state/*.json)——避免每次启动 5MB wasm 二进制。
///
/// 输出 schema：
/// ```json
/// { "buckets": [{"date", "hour", "is_peak", 8 桶字段}, ...],
///   "schema_version": 1, "tz_name", "tz_offset_hours", "unreported_fields" }
/// ```
#[wasm_bindgen]
pub fn hour_buckets(events_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let report = agent_vitals_domain::usage::hour_buckets(&events);
    serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
}

/// 成本账事件数组 → 逐请求指标数组（会话健康时间线的数据源）。
///
/// 与 `token_by_model` 是同一个 fold 的两个出口：那边给按模型的总数，这里给
/// 每次请求一行（`request_seq`/`turn`/`step`/`model`/`context_tokens`/
/// `context_window` + 四桶）。时间线需要的是时间序列，聚合值画不出来。
///
/// 输入需**额外包含 `request/context` 事件**（分母 `contextWindow` 的唯一来源）
/// ——执行环境侧 projection 的 `apply` 必须放行这个事件类型，否则每行 `context_window`
/// 都是 `null`，`[上下文]` 视图按 FR-04 整体降级。
#[wasm_bindgen]
pub fn request_metrics(events_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let rows = agent_vitals_domain::usage::request_metrics(&events);
    serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string())
}

/// 常驻上下文构成（FR-04a）：回答「token 都去哪了」的第一层。
///
/// 输入需包含 `request/header`（带 `header.system` / `header.tools`）以及承载
/// `data.source.kind == "skill-catalog"` 的那些事件——技能目录不是专用事件类型，
/// 它挂在 `user/message` / `agent/inbox/spliced` 等多种事件上，执行环境 projection
/// 的 `apply` 必须按 `data.source` 判断而不是按 type 白名单，否则目录永远为 null。
///
/// 输出三项都是 `est_tokens` **估算**，与 `request_metrics` 的 `context_tokens`
/// （provider 计数）不是同一个估算器：实测常驻前缀估算 10,830 对真实 13,959。
/// 展示层必须标注估算、且不得把两者相减后当作精确的分类结果。
#[wasm_bindgen]
pub fn context_composition(events_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let out = agent_vitals_domain::usage::context_composition(&events);
    serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
}

/// 上下文压缩事件（时间线的 ✂ 标记 + FR-04b 的实测浪费量）。
///
/// 输入需包含 `compaction/*` **以及 `turn/start` · `turn/end`**：`compaction/prune`
/// 自身不带 turn，靠 turn 边界顺延；只喂 compaction 事件的话每条 prune 的 turn
/// 都会落成 null（真实日志上验证过这个坑）。
///
/// `prunes[].shadowed_token_count` 是**执行环境实测**的被丢弃 token 数，与
/// `context_composition` 的 est_tokens 估算 provenance 不同，展示层须分开标注。
#[wasm_bindgen]
pub fn compaction_events(events_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let out = agent_vitals_harnesses::compaction::compaction_events(&events);
    serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
}

#[wasm_bindgen]
pub fn subagent_spawns(events_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let out = agent_vitals_domain::subagent::subagent_spawns(&events);
    serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
}

/// FR-04b 结构性浪费：回答"哪些是浪费的""我该怎么办"。规则可直接判定，不
/// 需要历史基线（"相对浪费"——缓存命中率偏低等——继续留在展示层，受 FR-05
/// 约束）。`requests_json` 需要是 `request_metrics` 已经算好的那份输出（同一
/// 批 usage_events），两个检测器共用它来算失败区间的上下文增量。
#[wasm_bindgen]
pub fn structural_waste(events_json: &str, requests_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let requests: Vec<Value> = serde_json::from_str(requests_json).unwrap_or_default();
    let out = agent_vitals_harnesses::waste::detect_structural_waste(&events, &requests);
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

/// Skill 执行审计（backlog T4）：`SkillInvocationEvent[]`——谁在什么时候被什么
/// 方式（`explicit` / `model_selected`）触发、加载成功没有（`loaded` /
/// `failed` / `incomplete`）、花了多久。
///
/// 与 `structural_waste` 同一种二参数契约：`requests_json` 需要是
/// `request_metrics` 已经算好的那份输出（同一批 usage_events）——`request_seq`
/// 靠 `(turn, step)` 精确匹配回那一行，不是"最近的 seq"启发式。
#[wasm_bindgen]
pub fn skill_audit(events_json: &str, requests_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let requests: Vec<Value> = serde_json::from_str(requests_json).unwrap_or_default();
    let out = agent_vitals_domain::skill::skill_invocations(&events, &requests);
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
}

/// T6 — 子 Agent 聚合与覆盖率。`spawns_json` 是 `subagent_spawns` 的输出。
/// 返回 `skill_invocations_enriched` 的结果（enriched invocations + coverage matrix）。
#[wasm_bindgen]
pub fn skill_audit_enriched(events_json: &str, requests_json: &str, spawns_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let requests: Vec<Value> = serde_json::from_str(requests_json).unwrap_or_default();
    let spawns: Vec<Value> = serde_json::from_str(spawns_json).unwrap_or_default();
    let out = agent_vitals_domain::skill::skill_invocations_enriched(&events, &requests, &spawns);
    serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
}

/// 执行时长审计（`DURATION_AUDIT_BACKLOG.md` D1–D3）：通用工具调用耗时 +
/// turn/step 时长 + 审批等待延迟，合并成一次 wasm 调用，与 `skill_audit` 的
/// 单事件数组输入同一种契约。
///
/// **D4（hook 消费）故意不在这里**——`duration::hook_executions` 的执行环境前提
/// （浏览器能不能拿到 `hook/*` 事件）还没有人拿真实会话验证过，在验证通过
/// 之前不接进这条浏览器链路，只在 CLI 侧可用（`hook_executions` 本身已经
/// 就绪，见 `crates/agent-vitals-domain/src/domain/duration.rs` 的模块级警告）。
#[wasm_bindgen]
pub fn duration_audit(events_json: &str) -> String {
    let events: Vec<Value> = serde_json::from_str(events_json).unwrap_or_default();
    let out = json!({
        "tool_calls": agent_vitals_domain::duration::tool_call_durations(&events),
        "turns": agent_vitals_domain::duration::turn_durations(&events),
        "steps": agent_vitals_domain::duration::step_durations(&events),
        "approvals": agent_vitals_domain::duration::approval_latencies(&events),
    });
    serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
}
