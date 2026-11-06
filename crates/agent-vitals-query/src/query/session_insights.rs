//! 会话消耗诊断的查询面（SESSION_TRACE_DIAGNOSTICS_SPEC r6 §5、§6、§8.5、§10）。
//!
//! 两个入口，**出口等级不同**，不得互相借数据：
//!
//! - [`session_insights`]：`session_trace(output = "insights")` 的数据体——回合轴、
//!   三类诊断、安全提醒计数、泳道可用性、名义成本。经 MCP 供出，所以只含
//!   计数、token、模型 id、工具名、规则码（§10 允许清单）；错误/参数摘录、
//!   指纹原值、findings 的 evidence 文本一律不进。
//! - [`session_trace_evidence`]：**本地呈现层专属**（桌面检查器的「错误摘要」
//!   「逐次调用」「命令摘要」）。含摘录，不注册为 MCP 工具——与
//!   `trace_service::session_anchor_report` 同一信任域（CLAUDE.md「出口收口」）。
//!
//! 计算全部在 `agent_vitals_domain::session_insights`；本模块只做 SQL 投影与计价。
//! 只读权威库，不读执行环境源文件——源日志轮换后诊断照样可用。

use std::collections::BTreeMap;

use agent_vitals_data::authority_query::billing_bucket_usage_json;
use agent_vitals_domain::session_insights::{
    build_insights, call_steps, AxisPlan, InsightCall, InsightEvent, InsightSafety, InsightsConfig,
};
use agent_vitals_domain::session_semantics::fingerprint;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// 进「安全提醒」块的规则：危险命令与敏感路径写入（shell / sensitive-fs 两类）。
/// 审批类（SV609/610/614）与轨迹类（SV611/613）不在其中——前者是权限配置
/// 状态、后者与「重复失败」诊断同源，放进安全块只会淹没真正的危险操作。
pub const SAFETY_RULES: [&str; 5] = ["SV601", "SV602", "SV603", "SV604", "SV605"];

struct CallRow {
    call: InsightCall,
    provider_id: Option<String>,
    peak: bool,
    pricing_version: Option<String>,
}

fn load_calls(conn: &Connection, session_key: &str) -> rusqlite::Result<Vec<CallRow>> {
    // 走 `usage_facts_session_time`（部分索引，谓词必须带 deleted_at_ms IS NULL）。
    let mut stmt = conn.prepare(
        "SELECT f.event_ts_ms, f.model_id, f.cache_read_tokens, f.cache_write_tokens,
                f.uncached_input_tokens, f.output_tokens, f.provider_id, f.event_peak,
                (SELECT pricing_version FROM pricing_snapshots
                 WHERE captured_at_ms <= f.event_ts_ms
                 ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1)
         FROM usage_facts f
         WHERE f.session_key = ?1 AND f.deleted_at_ms IS NULL
           AND f.event_ts_ms IS NOT NULL AND f.observation_kind != 'legacy_aggregate'
         ORDER BY f.event_ts_ms, f.fact_id",
    )?;
    let rows = stmt.query_map(params![session_key], |r| {
        Ok(CallRow {
            call: InsightCall {
                ts_ms: r.get(0)?,
                model_id: r.get(1)?,
                cache_read: r.get(2)?,
                cache_write: r.get(3)?,
                uncached_input: r.get(4)?,
                output: r.get(5)?,
            },
            provider_id: r.get(6)?,
            peak: r.get::<_, i64>(7)? != 0,
            pricing_version: r.get(8)?,
        })
    })?;
    rows.collect()
}

struct EventRows {
    events: Vec<InsightEvent>,
    tool_finished: usize,
    tool_known: usize,
    /// 仍是工具名级旧指纹的失败行（源日志已被执行环境清理、无法重放纠正）。
    legacy_fingerprints: usize,
}

/// 能力名进 insights 前的最后一道：像路径的（含 `/`，如 codex 的 `/bin/zsh`）只留
/// 末段——§10 禁止路径出 MCP。`vendor/model` 形状的能力名在工具位不存在。
fn capability_label(value: Option<String>) -> Option<String> {
    value.map(|v| match v.rsplit_once('/') {
        Some((_, tail)) if !tail.is_empty() => tail.to_string(),
        _ => v,
    })
}

/// PARSER_VERSION 6 之前的调用指纹只编码工具名。源日志还在的会话已被重放纠正；
/// 源日志已被执行环境清理的会话永远停在旧值——把它当「同一调用」会把「Bash 失败过
/// 两次」报成「同一调用重复失败」（验收：7,296 行、124 个会话）。识别出来当作未知。
fn is_tool_level_fingerprint(fp: &str, capability: Option<&str>) -> bool {
    let Some(cap) = capability else { return false };
    ["claude", "codex"].iter().any(|tag| fp == fingerprint(&format!("{tag}-tool:{cap}")))
}

fn load_events(conn: &Connection, session_key: &str) -> rusqlite::Result<EventRows> {
    let mut stmt = conn.prepare(
        "SELECT event_ts_ms, event_type, capability_id, outcome, invocation_fingerprint,
                error_excerpt IS NOT NULL
         FROM workflow_events
         WHERE session_key = ?1
           AND event_type IN ('task_started', 'task_finished', 'tool_finished', 'model_switched')
         ORDER BY event_ts_ms, event_id",
    )?;
    let mut out = EventRows { events: Vec::new(), tool_finished: 0, tool_known: 0, legacy_fingerprints: 0 };
    let mut rows = stmt.query(params![session_key])?;
    while let Some(r) = rows.next()? {
        let ts_ms: i64 = r.get(0)?;
        let event_type: String = r.get(1)?;
        let outcome: String = r.get(3)?;
        let event = match event_type.as_str() {
            "task_started" => InsightEvent::TaskStarted { ts_ms },
            "task_finished" => InsightEvent::TaskFinished { ts_ms, outcome },
            "model_switched" => InsightEvent::ModelSwitched { ts_ms },
            _ => {
                out.tool_finished += 1;
                if outcome != "unknown" {
                    out.tool_known += 1;
                }
                let raw_capability: Option<String> = r.get(2)?;
                let mut invocation: Option<String> = r.get(4)?;
                if invocation.as_deref().is_some_and(|fp| is_tool_level_fingerprint(fp, raw_capability.as_deref())) {
                    if outcome == "failed" {
                        out.legacy_fingerprints += 1;
                    }
                    invocation = None;
                }
                InsightEvent::ToolFinished {
                    ts_ms,
                    capability_id: capability_label(raw_capability),
                    outcome,
                    invocation_fingerprint: invocation,
                    has_error_excerpt: r.get(5)?,
                }
            }
        };
        out.events.push(event);
    }
    Ok(out)
}

/// `issue_instances.session_key` 存的是**原生会话 id**（findings_eval 按
/// `session.native_id` 写入），不是 ledger key——按 ledger key 查会恒为 0 条
/// （真机 6079 条全是原生 id）。这里按 (执行环境, 原生 id) 查，并兼容将来改写成
/// ledger key 的行。
fn safety_filter(conn: &Connection, session_key: &str) -> rusqlite::Result<(String, String, String)> {
    let (harness, native): (String, String) = conn
        .query_row(
            "SELECT harness, native_session_id FROM sessions WHERE session_key = ?1",
            params![session_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or_default();
    let placeholders = SAFETY_RULES.iter().map(|r| format!("'{r}'")).collect::<Vec<_>>().join(",");
    Ok((harness, native, placeholders))
}

fn load_safety(conn: &Connection, session_key: &str) -> rusqlite::Result<Vec<InsightSafety>> {
    let (harness, native, placeholders) = safety_filter(conn, session_key)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT issue_type, severity, json_extract(metadata_json, '$.time')
         FROM issue_instances
         WHERE harness = ?1 AND session_key IN (?2, ?3) AND issue_type IN ({placeholders})
         ORDER BY issue_type, opened_at_ms"
    ))?;
    let rows = stmt.query_map(params![harness, native, session_key], |r| {
        Ok(InsightSafety { rule: r.get(0)?, severity: r.get(1)?, ts_ms: r.get::<_, Option<i64>>(2)? })
    })?;
    rows.collect()
}

/// 泳道可用性（spec §6.3）：能不能画只看数据；画不了的原因来自执行环境能力。
fn lane(total: usize, known: usize, empty_reason: &str) -> Value {
    if total == 0 {
        return json!({ "state": "unavailable", "reason": empty_reason });
    }
    let coverage = known as f64 / total as f64;
    if coverage >= 0.95 {
        json!({ "state": "available", "coverage": round4(coverage) })
    } else if known > 0 {
        json!({ "state": "partial", "coverage": round4(coverage) })
    } else {
        // 事件在，但结果一个都没记（如 Codex Legacy 线格式的工具输出不带成败）。
        json!({ "state": "unavailable", "reason": "not_recorded_by_harness" })
    }
}

/// 会话里一个工具结果都没有时的原因。manifest 执行环境（`harness:*`，走 DSL 适配；
/// 迁移期旧 `plugin:*` 同判）目前不产 workflow 事件；原生执行环境没有就是这次
/// 会话恰好没用工具。
fn tools_empty_reason(harness: &str) -> &'static str {
    if harness.starts_with("harness:") || harness.starts_with("plugin:") { "not_ingested" } else { "no_data_in_session" }
}

/// 名义成本（spec §4、§8.5）：每组（回合 × 执行环境 × 模型 × provider × 峰谷 × 价格快照）
/// 按官方价卡估算，**不扣订阅**（名义 = 官方标价折算，与 `metered_*` 不相加），
/// 含输出。计价函数与会话成本分桶同一个（`metered_estimate_minor` +
/// `billing_bucket_usage_json`）。无价卡的调用不计 0：`coverage` 标 partial。
/// 计价分组键：(回合下标, 模型, provider, 峰时, 价格快照版本)。
type PriceGroupKey = (usize, String, Option<String>, bool, Option<String>);

struct NominalAccumulator {
    groups: BTreeMap<PriceGroupKey, [i64; 4]>,
}

/// 币种 → 最小货币单位金额。
type Money = BTreeMap<String, i64>;

/// 计价结果：每回合（金额, 是否部分未计价）、会话合计、会话是否部分未计价、
/// 逐回合未计价 token 四桶之和（无快照/无价卡导致 None 的组，WASTE S1）。
struct Priced {
    per_step: BTreeMap<usize, (Money, bool)>,
    session: Money,
    session_partial: bool,
    unpriced: BTreeMap<usize, i64>,
}

fn price_groups(
    conn: &Connection,
    harness: &str,
    acc: &NominalAccumulator,
) -> rusqlite::Result<Priced> {
    let mut snapshots: BTreeMap<String, Option<Value>> = BTreeMap::new();
    let sync_overlay: Option<Value> = agent_vitals_data::authority::latest_pricing_sync_overlay(conn)?
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let mut per_step: BTreeMap<usize, (Money, bool)> = BTreeMap::new();
    let mut unpriced: BTreeMap<usize, i64> = BTreeMap::new();
    for ((step, model, provider, peak, version), tokens) in &acc.groups {
        let snapshot = match version {
            Some(version) => {
                if !snapshots.contains_key(version) {
                    let payload: Option<String> = conn
                        .query_row(
                            "SELECT payload_json FROM pricing_snapshots WHERE pricing_version = ?1",
                            params![version],
                            |r| r.get(0),
                        )
                        .optional()?;
                    // 每日同步叠加层只补这份历史快照当时没有的卡；已有价不动。
                    let snapshot = payload.and_then(|p| serde_json::from_str::<Value>(&p).ok()).map(|mut snap| {
                        if let Some(overlay) = &sync_overlay {
                            agent_vitals_domain::cost::sync_overlay::fill_missing_in_snapshot(&mut snap, overlay);
                        }
                        snap
                    });
                    snapshots.insert(version.clone(), snapshot);
                }
                snapshots[version].as_ref()
            }
            None => None,
        };
        let usage = billing_bucket_usage_json(harness, model, provider.as_deref(), *peak, *tokens);
        let money = snapshot.and_then(|s| agent_vitals_domain::cost::metered_estimate_minor(harness, &usage, s));
        let entry = per_step.entry(*step).or_insert_with(|| (Money::new(), false));
        match money {
            Some(m) => *entry.0.entry(m.currency).or_default() += m.amount_minor,
            None if tokens.iter().any(|t| *t > 0) => {
                entry.1 = true;
                // 与 affected_input_tokens 同基：三桶输入（不含 output），同屏
                // 相邻的两个 token 数必须统计同一宇宙（评审 P3-4）。
                *unpriced.entry(*step).or_default() += tokens[0] + tokens[1] + tokens[2];
            }
            None => {}
        }
    }
    let mut session = Money::new();
    let mut session_partial = false;
    for (money, partial) in per_step.values() {
        for (currency, amount) in money {
            *session.entry(currency.clone()).or_default() += amount;
        }
        session_partial |= *partial;
    }
    Ok(Priced { per_step, session, session_partial, unpriced })
}

/// WASTE S1（spec §4.1 修订版）：单会话失败区间成本暴露——对 repeated_failure
/// 命中回合的既有名义计价做区间聚合。**不是浪费金额**：affected_input_tokens 含
/// 正常工作；金额是名义口径（官方标价、不扣订阅、含输出），逐组取整规则与回合
/// 展示一致，因此不保证与会话名义成本可相加。跨币分栏不相加；未计价 token
/// 如实单列，绝不按 0 价入金额。
/// reason 词表故意收窄为 no_pricing_snapshot|no_price_card（评审 P3-3 记录）：
/// 本管线 basis 钉死 nominal、不碰路由/订阅，spec 词表的 route_unresolved/
/// subscription_covered 在此不可达；桥接闭集同款收窄，未来扩展须同改两处。
fn failure_exposure_json(
    from_step: usize,
    to_step: usize,
    affected_input_tokens: i64,
    per_step: &BTreeMap<usize, (Money, bool)>,
    unpriced: &BTreeMap<usize, i64>,
    any_unversioned: bool,
) -> Value {
    let mut amounts: Money = Money::new();
    let mut unpriced_tokens: i64 = 0;
    let mut any_partial = false;
    for step in from_step.saturating_sub(1)..to_step {
        if let Some((money, partial)) = per_step.get(&step) {
            any_partial |= *partial;
            for (currency, amount) in money {
                *amounts.entry(currency.clone()).or_default() += amount;
            }
        }
        if let Some(tokens) = unpriced.get(&step) {
            unpriced_tokens += tokens;
        }
    }
    let (coverage, reason) = if amounts.is_empty() {
        // 无任何可用金额（区间无计价组，或组全部未计价）→ 不可用并给原因。
        ("unavailable", if any_unversioned { "no_pricing_snapshot" } else { "no_price_card" })
    } else if any_partial || unpriced_tokens > 0 {
        ("partial", "")
    } else {
        ("full", "")
    };
    json!({
        "affected_input_tokens": affected_input_tokens,
        "nominal_amounts": amounts.iter().map(|(currency, amount)| json!({
            "amount_minor": amount, "currency": currency, "billing_basis": "nominal",
        })).collect::<Vec<_>>(),
        "coverage": coverage,
        "unpriced_tokens": unpriced_tokens,
        "granularity": "affected-turns",
        "reason": if reason.is_empty() { Value::Null } else { json!(reason) },
        "disclaimer": "相关回合含正常工作；不是浪费、可节省额或实付账单",
    })
}

fn money_json(money: &Money, partial: bool) -> Option<Value> {
    (!money.is_empty()).then(|| {
        json!({
            "amounts": money.iter().map(|(currency, amount)| json!({ "amount_minor": amount, "currency": currency })).collect::<Vec<_>>(),
            "coverage": if partial { "partial" } else { "full" },
            "basis": "nominal",
        })
    })
}

/// `session_trace(output = "insights")` 的 data。`harness` 取自 `sessions.harness`。
pub fn session_insights(conn: &Connection, session_key: &str, harness: &str) -> rusqlite::Result<Value> {
    let calls = load_calls(conn, session_key)?;
    let events = load_events(conn, session_key)?;
    let safety = load_safety(conn, session_key)?;
    let plain: Vec<InsightCall> = calls.iter().map(|c| c.call.clone()).collect();
    let mut data = build_insights(&plain, &events.events, &safety, &InsightsConfig::default());

    // 名义成本：按回合分组计价挂到回合上；会话合计另按会话级分组计价（不是回合
    // 金额之和——每组各自取整会累积误差，小于半分的组还会被抹成 0），且覆盖所有
    // 调用（含落不到任何回合的）。诊断不带金额（r6）。
    let steps = call_steps(&plain, &events.events);
    let mut acc = NominalAccumulator { groups: BTreeMap::new() };
    let mut session_acc = NominalAccumulator { groups: BTreeMap::new() };
    for (row, step) in calls.iter().zip(steps.iter()) {
        let session_key_group = (
            usize::MAX,
            row.call.model_id.clone().unwrap_or_else(|| "<unknown>".to_string()),
            row.provider_id.clone(),
            row.peak,
            row.pricing_version.clone(),
        );
        let totals = session_acc.groups.entry(session_key_group).or_insert([0; 4]);
        totals[0] += row.call.uncached_input;
        totals[1] += row.call.cache_read;
        totals[2] += row.call.cache_write;
        totals[3] += row.call.output;
        let Some(step) = step else { continue };
        let key = (
            *step,
            row.call.model_id.clone().unwrap_or_else(|| "<unknown>".to_string()),
            row.provider_id.clone(),
            row.peak,
            row.pricing_version.clone(),
        );
        let tokens = acc.groups.entry(key).or_insert([0; 4]);
        tokens[0] += row.call.uncached_input;
        tokens[1] += row.call.cache_read;
        tokens[2] += row.call.cache_write;
        tokens[3] += row.call.output;
    }
    let Priced { per_step, unpriced, .. } = price_groups(conn, harness, &acc)?;
    let any_unversioned = calls.iter().any(|c| c.pricing_version.is_none());
    let Priced { session: session_money, session_partial, .. } = price_groups(conn, harness, &session_acc)?;
    if let Some(steps_json) = data["axis"]["steps"].as_array_mut() {
        for (i, step) in steps_json.iter_mut().enumerate() {
            if let Some((money, partial)) = per_step.get(&i) {
                if let Some(v) = money_json(money, *partial) {
                    step["nominal_cost"] = v;
                }
            }
        }
    }
    match money_json(&session_money, session_partial) {
        Some(v) => data["session"]["nominal_cost"] = v,
        None if !calls.is_empty() => {
            // 缺金额时说清原因（§8.5「暂无可用计价依据」）。
            let reason = if calls.iter().any(|c| c.pricing_version.is_none()) { "no_pricing_snapshot" } else { "no_price_card" };
            data["session"]["nominal_cost_reason"] = json!(reason);
        }
        None => {}
    }
    // WASTE S1（r8 有限例外）：仅 repeated_failure 挂失败区间成本暴露——
    // 措辞与降级由契约钉住；其余诊断仍不带金额。
    if let Some(list) = data["diagnostics"].as_array_mut() {
        for item in list.iter_mut() {
            if item.get("kind").and_then(Value::as_str) != Some("repeated_failure") {
                continue;
            }
            let (from, to) = (
                item["steps"]["from"].as_u64().unwrap_or(0) as usize,
                item["steps"]["to"].as_u64().unwrap_or(0) as usize,
            );
            if from == 0 || to == 0 {
                continue;
            }
            let tokens = item["impact"]["tokens"].as_i64().unwrap_or(0);
            // reason 用区间级证据（评审 P3-2）：区间内的组全部有版本 → 无价卡；
            // 区间含无版本组 → 无快照；区间完全没有组 → 回退会话级判定
            // （失败模型调用整行缺失的现实，spec §1 已承认）。
            let mut range_has_groups = false;
            let mut range_unversioned = false;
            for (key, _) in acc.groups.range((
                std::ops::Bound::Included((from.saturating_sub(1), String::new(), None, false, None)),
                std::ops::Bound::Unbounded,
            )) {
                if key.0 >= to {
                    break;
                }
                range_has_groups = true;
                if key.4.is_none() {
                    range_unversioned = true;
                }
            }
            let reason_unversioned = if range_has_groups { range_unversioned } else { any_unversioned };
            item["failure_exposure"] = failure_exposure_json(from, to, tokens, &per_step, &unpriced, reason_unversioned);
        }
    }
    data["quality"] = json!({ "legacy_fingerprints": events.legacy_fingerprints });

    data["lanes"] = json!({
        "consumption": lane(calls.len(), calls.len(), "no_data_in_session"),
        "tools": lane(events.tool_finished, events.tool_known, tools_empty_reason(harness)),
    });
    data["harness"] = json!(harness);
    Ok(data)
}

/// **本地呈现层专属**（不进 MCP、不进导出）：检查器需要的原始证据——
/// 区间内每次失败的错误/参数摘录、逐次调用、安全提醒的命令摘要。
/// `from`/`to` 为 1 基回合号（含两端），与 `insights.axis.steps[].index` 同一坐标。
pub fn session_trace_evidence(conn: &Connection, session_key: &str, from: usize, to: usize) -> rusqlite::Result<Value> {
    session_trace_evidence_with(conn, session_key, from, to, true)
}

/// `include_calls = false`：只要失败与安全提醒（检查器的安全视图跨整个会话，逐次
/// 调用可能上万条，没有必要搬）。
pub fn session_trace_evidence_with(conn: &Connection, session_key: &str, from: usize, to: usize, include_calls: bool) -> rusqlite::Result<Value> {
    let calls = load_calls(conn, session_key)?;
    let events = load_events(conn, session_key)?;
    let plain: Vec<InsightCall> = calls.iter().map(|c| c.call.clone()).collect();
    let steps = call_steps(&plain, &events.events);
    let in_range = |step: Option<usize>| step.is_some_and(|s| s + 1 >= from && s < to);

    let mut calls_out = Vec::new();
    for (row, step) in calls.iter().zip(steps.iter()) {
        if !include_calls || !in_range(*step) {
            continue;
        }
        let c = &row.call;
        calls_out.push(json!({
            "step": step.map(|s| s + 1),
            "ts_ms": c.ts_ms,
            "model_id": c.model_id,
            "input": { "cache_read": c.cache_read, "cache_write": c.cache_write, "uncached_input": c.uncached_input },
            "output": c.output,
        }));
    }

    // 回合落点与 insights 同一规则（`AxisPlan`，domain 里只有一份）。
    let call_ts: Vec<i64> = plain.iter().map(|c| c.ts_ms).collect();
    let plan = AxisPlan::new(&call_ts, &events.events);
    let step_of = |ts: i64| plan.step_of(ts);

    let mut stmt = conn.prepare(
        "SELECT event_ts_ms, capability_id, outcome, invocation_fingerprint, error_excerpt, args_excerpt
         FROM workflow_events
         WHERE session_key = ?1 AND event_type = 'tool_finished' AND outcome = 'failed'
         ORDER BY event_ts_ms, event_id",
    )?;
    let mut failures = Vec::new();
    let mut rows = stmt.query(params![session_key])?;
    while let Some(r) = rows.next()? {
        let ts: i64 = r.get(0)?;
        let step = step_of(ts);
        if !in_range(step) {
            continue;
        }
        let raw_capability: Option<String> = r.get(1)?;
        // 旧的工具名级指纹不是「同一调用」的证据（与 insights 同一规则，验收 finding）。
        let key: Option<String> = r.get::<_, Option<String>>(3)?
            .filter(|fp| !is_tool_level_fingerprint(fp, raw_capability.as_deref()));
        failures.push(json!({
            "step": step.map(|s| s + 1),
            "ts_ms": ts,
            "capability_id": capability_label(raw_capability),
            // 分组键只在本地面出现，供检查器把「同一调用」的几次失败归到一起。
            "invocation_key": key,
            "error_excerpt": r.get::<_, Option<String>>(4)?,
            "args_excerpt": r.get::<_, Option<String>>(5)?,
        }));
    }

    let (harness, native, placeholders) = safety_filter(conn, session_key)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT issue_type, severity, json_extract(metadata_json, '$.time'),
                json_extract(metadata_json, '$.evidence'), json_extract(metadata_json, '$.tool_name')
         FROM issue_instances
         WHERE harness = ?1 AND session_key IN (?2, ?3) AND issue_type IN ({placeholders})
         ORDER BY opened_at_ms"
    ))?;
    let mut safety = Vec::new();
    let mut rows = stmt.query(params![harness, native, session_key])?;
    while let Some(r) = rows.next()? {
        let ts: Option<i64> = r.get(2)?;
        safety.push(json!({
            "rule": r.get::<_, String>(0)?,
            "severity": r.get::<_, String>(1)?,
            "step": ts.and_then(step_of).map(|s| s + 1),
            "tool": r.get::<_, Option<String>>(4)?,
            "summary": r.get::<_, Option<String>>(3)?,
        }));
    }

    Ok(json!({
        "steps": { "from": from, "to": to },
        "calls": calls_out,
        "failures": failures,
        "safety": safety,
        "local_only": true,
    }))
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// 桌面检查器的入口（**本地呈现层专属**）：`session_ref` → 本机权威库只读打开 →
/// [`session_trace_evidence`]。不经 MCP dispatch，也不注册为 MCP 工具（spec §10）。
/// 错误只给出类别，不回显引用或路径。
pub fn session_trace_evidence_for_ref(
    data_home: &std::path::Path,
    session_ref: &str,
    from: usize,
    to: usize,
    include_calls: bool,
) -> Result<Value, String> {
    // 逐次调用有量的上限；不带调用时（安全视图）允许跨整个会话。
    if from == 0 || to < from || (include_calls && to - from > 5_000) {
        return Err("invalid_argument: step range".to_string());
    }
    let salt = super::session_ref::load_or_create_salt(data_home).map_err(|e| format!("{}: session salt", e.code))?;
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
        .map_err(|_| "authority_unavailable".to_string())?;
    let keys = agent_vitals_data::authority_query::all_session_keys(db.conn())
        .map_err(|_| "internal_error: session keys".to_string())?;
    let session_key = super::session_ref::resolve(&salt, session_ref, keys)
        .ok_or_else(|| "invalid_argument: unknown session_ref".to_string())?;
    session_trace_evidence_with(db.conn(), &session_key, from, to, include_calls).map_err(|_| "internal_error: evidence query".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn money(entries: &[(&str, i64)]) -> Money {
        entries.iter().map(|(c, a)| (c.to_string(), *a)).collect()
    }

    /// WASTE S1：failure_exposure 的三态、跨币分栏与未计价单列。
    #[test]
    fn failure_exposure_full_partial_unavailable_and_currencies() {
        let mut per_step = BTreeMap::new();
        per_step.insert(5usize, (money(&[("CNY", 1200), ("USD", 340)]), false));
        per_step.insert(6usize, (money(&[("CNY", 800)]), true));
        let mut unpriced = BTreeMap::new();
        unpriced.insert(6usize, 9000i64);

        // 全覆盖：from/to 命中且无未计价。
        let v = failure_exposure_json(6, 6, 150000, &per_step, &BTreeMap::new(), false);
        assert_eq!(v["coverage"], "full");
        assert_eq!(v["unpriced_tokens"], 0);
        assert_eq!(v["reason"], serde_json::Value::Null);
        assert_eq!(v["granularity"], "affected-turns");
        assert_eq!(v["disclaimer"], "相关回合含正常工作；不是浪费、可节省额或实付账单");
        let amounts = v["nominal_amounts"].as_array().unwrap();
        assert_eq!(amounts.len(), 2, "跨币分栏");
        assert!(amounts.iter().any(|a| a["currency"] == "CNY" && a["amount_minor"] == 1200 && a["billing_basis"] == "nominal"));

        // 部分：混入未计价回合 → partial + unpriced_tokens 单列，不按 0 价入金额。
        let v = failure_exposure_json(6, 7, 230000, &per_step, &unpriced, false);
        assert_eq!(v["coverage"], "partial");
        assert_eq!(v["unpriced_tokens"], 9000);
        let amounts = v["nominal_amounts"].as_array().unwrap();
        assert!(amounts.iter().any(|a| a["currency"] == "USD" && a["amount_minor"] == 340));

        // 区间外无数据 → unavailable + 原因（无快照优先于无价卡）。
        let v = failure_exposure_json(40, 41, 0, &per_step, &unpriced, true);
        assert_eq!(v["coverage"], "unavailable");
        assert_eq!(v["reason"], "no_pricing_snapshot");
        let v = failure_exposure_json(40, 41, 0, &per_step, &unpriced, false);
        assert_eq!(v["reason"], "no_price_card");
        // 金额缺席时 nominal_amounts 必为空数组，不是 0。
        assert_eq!(v["nominal_amounts"].as_array().unwrap().len(), 0);
    }


    use agent_vitals_domain::session_insights::{build_insights, InsightCall, InsightEvent, InsightsConfig};

    /// remedy 目录只有一份（`agent_vitals_data::issues::remedy_for`，Findings 页在用）：
    /// domain 诊断产出的 remedy_id 必须与目录对 kind 的映射一致。
    #[test]
    fn diagnostic_remedy_ids_come_from_the_shared_catalog() {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        for t in 0..14i64 {
            let ts = 1_000_000 + t * 120_000;
            events.push(InsightEvent::TaskStarted { ts_ms: ts });
            let size = 30_000 + t * 9_000;
            let (read, write) = if (6..=8).contains(&t) { (1_000, size) } else { (size - 100, 50) };
            for k in 0..3 {
                calls.push(InsightCall { ts_ms: ts + 1_000 + k * 1_000, model_id: Some("m".into()), cache_read: read, cache_write: write, uncached_input: 50, output: 10 });
            }
            if t == 10 {
                for k in 0..2 {
                    events.push(InsightEvent::ToolFinished { ts_ms: ts + 500 + k, capability_id: Some("Bash".into()), outcome: "failed".into(), invocation_fingerprint: Some("fp".into()), has_error_excerpt: true });
                }
            }
        }
        let v = build_insights(&calls, &events, &[], &InsightsConfig::default());
        let diags = v["diagnostics"].as_array().unwrap();
        let kinds: std::collections::BTreeSet<&str> = diags.iter().map(|d| d["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds.len(), 3, "fixture 应覆盖三类诊断：{kinds:?}");
        for d in diags {
            let kind = d["kind"].as_str().unwrap();
            assert_eq!(d["remedy_id"].as_str().unwrap(), agent_vitals_data::issues::remedy_for(kind).remedy_id, "{kind}");
        }
    }
}
