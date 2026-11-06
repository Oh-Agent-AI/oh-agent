//! 计费声明的保存前影响预览（计费主链规格 §5.5）。
//!
//! 三组数字、同一谓词：`moved`（会被移出按量估算的事实）、`kept`（同
//! 服务商/期间内**未**命中作用域（任何执行环境）、继续按量估算的事实）、`pending`（命中但
//! 证据为 `conflict`、既不移出也不归因的事实）。事实选择来自
//! `authority::billing_declaration_fact_selection`——与重算归因同一条 `WHERE`；
//! 金额来自 `mcp::cost_breakdown::price_fact_selection`——与 MCP `cost_breakdown`
//! 同一条计价路径。这里没有第二套 SQL，也没有第二套价格查询。

use agent_vitals_data::authority::{AuthorityDb, ConflictEvidence};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::query::cost_breakdown::{price_fact_selection, WindowResult};

/// 非 `official_subscription` 的关系在 Beta 不改变金额：预览仍返回三组数字，
/// 但 `moved` 的金额恒空并带 `changes_amounts: false`，UI 必须照实显示。
pub fn declaration_impact_preview(
    db: &AuthorityDb, provider_id: &str, relationship_kind: &str,
    effective_start: &str, effective_end: Option<&str>, scopes: &[(&str, &str)],
) -> Value {
    // 默认覆盖规则（官方订阅不受模型清单限制）先于一切计算，预览与重算同口径。
    let official_api = db.billing_official_api_declared(provider_id).unwrap_or(false);
    let (effective_scopes, native) = agent_vitals_data::authority::default_coverage(relationship_kind, scopes, official_api);
    let scopes = effective_scopes.as_slice();
    let counts = match db.billing_declaration_impact_preview_for_kind(
        provider_id, relationship_kind, effective_start, effective_end, scopes, None,
    ) {
        Ok(counts) => counts,
        Err(error) => return json!({ "status": "unavailable", "reason": error.to_string() }),
    };
    let priced = |scopes: &[(&str, &str)]| -> Result<WindowResult, String> {
        let selection = agent_vitals_data::authority::billing_declaration_fact_selection_with(
            provider_id, effective_start, effective_end, scopes, None, ConflictEvidence::Exclude, native,
        );
        price_fact_selection(db.conn(), &selection.where_sql, &selection.params, &[])
            .map_err(|error| error.message)
    };
    let moved = match priced(scopes) {
        Ok(result) => result,
        Err(reason) => return json!({ "status": "unavailable", "reason": reason }),
    };
    let all = match priced(&[]) {
        Ok(result) => result,
        Err(reason) => return json!({ "status": "unavailable", "reason": reason }),
    };
    let changes_amounts = relationship_kind == "official_subscription";
    let kept_amounts = subtract_amounts(&all.amounts, &moved.amounts);
    json!({
        "status": "ok",
        "provider_id": provider_id, "relationship_kind": relationship_kind,
        "effective_start": effective_start, "effective_end": effective_end,
        "scopes": scopes.iter().map(|(kind, value)| json!({ "scope_kind": kind, "scope_value": value })).collect::<Vec<_>>(),
        "changes_amounts": changes_amounts,
        "moved": {
            "fact_count": counts.fact_count,
            "session_count": counts.session_count,
            "tokens": counts.total_tokens,
            "unpriced_tokens": moved.unresolved_tokens,
            "amounts": if changes_amounts { moved.amounts.clone() } else { Vec::new() },
            "estimated_amounts": moved.amounts,
        },
        "kept": {
            "tokens": all.total_tokens.saturating_sub(counts.total_tokens),
            "unpriced_tokens": all.unresolved_tokens.saturating_sub(moved.unresolved_tokens),
            "amounts": kept_amounts,
        },
        "pending": {
            "fact_count": counts.conflict_fact_count,
            "tokens": counts.conflict_tokens,
            "reasons": if counts.conflict_fact_count > 0 { vec!["route-evidence-conflict"] } else { Vec::new() },
        },
        "first_event_ts_ms": counts.first_event_ts_ms,
        "last_event_ts_ms": counts.last_event_ts_ms,
    })
}

/// 「确认计费方式」面板的数据源（规格 §5.2 / B1）：`summary::unresolved_billing_groups_in`
/// 的组 + 同一批事实的分币估算金额。金额来自 `price_fact_selection` 跑
/// `SQL_UNRESOLVED_BILLING_FACT_WHERE`（与组 SQL 共享的谓词），按组键
/// `(harness, provider, model, evidence_basis, pricing_basis)` 归并、不跨币种相加。
/// 排序：有金额的组按 `amount_minor` 降序，无价卡的组按 tokens 降序排在其后。
pub fn confirmation_groups(db: &AuthorityDb, month: &str) -> Value {
    confirmation_groups_with(db, month, &account_evidence_by_harness(), &endpoint_evidence_by_harness())
}

/// 账户证据由调用方注入（测试不读真实 HOME）。
pub fn confirmation_groups_with(
    db: &AuthorityDb, month: &str,
    accounts: &std::collections::BTreeMap<String, agent_vitals_provider::AccountEvidence>,
    endpoints: &std::collections::BTreeMap<String, agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence>,
) -> Value {
    let mut report = crate::summary::unresolved_billing_groups_in(db, month);
    if report["status"] != json!("ok") {
        return report;
    }
    let Some((start, end)) = agent_vitals_data::authority_query::beijing_month_bounds_ms(month) else {
        return report;
    };
    let priced = match price_fact_selection(
        db.conn(),
        agent_vitals_data::authority_query::SQL_UNRESOLVED_BILLING_FACT_WHERE,
        &[rusqlite::types::Value::Integer(start), rusqlite::types::Value::Integer(end)],
        &[],
    ) {
        Ok(priced) => priced,
        Err(error) => {
            report["pricing_status"] = json!({ "status": "unavailable", "reason": error.message });
            return report;
        }
    };
    let mut amounts: BTreeMap<String, BTreeMap<(String, String), i64>> = BTreeMap::new();
    let mut unpriced: BTreeMap<String, (i64, Option<String>)> = BTreeMap::new();
    for row in &priced.rows {
        let key = row["key"].as_object().map(|key| format!(
            "{}|{}|{}|{}|{}|{month}",
            key["harness"].as_str().unwrap_or(""),
            key["provider"].as_str().unwrap_or("<unknown>"),
            key["model"].as_str().unwrap_or("<unknown>"),
            key["evidence_basis"].as_str().unwrap_or("missing"),
            key["pricing_basis"].as_str().unwrap_or("unavailable"),
        )).unwrap_or_default();
        match row.get("amount").filter(|amount| !amount.is_null()) {
            Some(amount) => {
                *amounts.entry(key).or_default().entry(amount_key(amount)).or_insert(0)
                    += amount["amount_minor"].as_i64().unwrap_or(0);
            }
            None => {
                let slot = unpriced.entry(key).or_insert((0, None));
                slot.0 += row["tokens"]["total"].as_i64().unwrap_or(0);
                if slot.1.is_none() {
                    slot.1 = row["unresolved_reason"].as_str().map(ToOwned::to_owned);
                }
            }
        }
    }
    let Some(groups) = report["groups"].as_array_mut() else { return report; };
    for group in groups.iter_mut() {
        let id = group["group_id"].as_str().unwrap_or("").to_owned();
        let estimated = amounts.remove(&id).unwrap_or_default().into_iter()
            .map(|((currency, basis), amount_minor)| json!({
                "amount_minor": amount_minor, "currency": currency, "basis": basis,
            })).collect::<Vec<_>>();
        let (unpriced_tokens, reason) = unpriced.remove(&id).unwrap_or((0, None));
        group["estimated_amounts"] = json!(estimated);
        group["unpriced_tokens"] = json!(unpriced_tokens);
        group["unresolved_reason"] = json!(reason);
        group.as_object_mut().map(|object| object.remove("estimated_cost_minor"));
    }
    groups.sort_by(|a, b| {
        let amount = |group: &Value| group["estimated_amounts"].as_array()
            .and_then(|rows| rows.iter().filter_map(|row| row["amount_minor"].as_i64()).max());
        let tokens = |group: &Value| group["tokens"].as_i64().unwrap_or(0);
        match (amount(a), amount(b)) {
            (Some(x), Some(y)) => y.cmp(&x).then_with(|| tokens(b).cmp(&tokens(a))),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => tokens(b).cmp(&tokens(a)),
        }
    });
    // E 类：workbuddy 是积分制，不是货币——不进待确认列表（规格 §0 表 E）。
    // 积分制执行环境（workbuddy）不进金额面：这是**执行环境声明**，不是名字比较——
    // `AttributionProfile::credits_only` 住在 `HarnessProfile`（§10.6），判定器只读声明。
    groups.retain(|group| {
        let harness = group["harness"].as_str().unwrap_or("");
        !agent_vitals_domain::harness_capability::attribution_profile(harness).credits_only
            && group["tokens"].as_i64().unwrap_or(0) > 0
    });
    for group in groups.iter_mut() {
        let mut verdict = auto_verdict(group, accounts, endpoints);
        fill_timeline_splits(db, group, &mut verdict, start);
        group["auto_verdict"] = verdict;
    }
    let clusters = clusters_of(groups);
    report["clusters"] = json!(clusters);
    report
}

/// 账户级证据（L2）：每个执行环境读一次白名单字段；文件缺失 → 无证据。
fn account_evidence_by_harness() -> std::collections::BTreeMap<String, agent_vitals_provider::AccountEvidence> {
    let mut out = std::collections::BTreeMap::new();
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return out; };
    if let Some(e) = agent_vitals_harnesses::claude_account::read_claude_account(&home) {
        out.insert(e.harness.clone(), e);
    }
    if let Some(e) = agent_vitals_harnesses::codex_account::read_codex_account(&home) {
        out.insert(e.harness.clone(), e);
    }
    out
}

/// 本机所有执行环境的端点/配置证据（A12、§10.2 层②）。读取器在
/// `agent-vitals-harnesses::sources::endpoint_evidence`——判定器不认识任何执行环境的文件格式，
/// 只吃中立结构；每个执行环境读不到就是没有条目（不猜）。
fn endpoint_evidence_by_harness() -> std::collections::BTreeMap<String, agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence> {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        return Default::default();
    };
    agent_vitals_harnesses::sources::endpoint_evidence::read_all(&home)
}

/// 证据里已能说明「走的是官方路由」的 basis（与 `workbench.js::BILLING_ROUTE_KNOWN_OFFICIAL` 同表）。
///
/// 门槛是 **≥ `SessionNative`**（规格 §2/§4）：`account-time-bound`(6) 与
/// `config-time-bound`(5) 都比会话级证据弱，曾经把它们也算作"官方路由"——那等于
/// 「配置文件里写着官方」直接产出一键订阅判定。今天没有 emitter 产这两种 basis，
/// 所以是潜在洞；一旦配置源写入器落地就会立刻编造归属（验收审查 iteration 3 #3）。
const ROUTE_KNOWN_OFFICIAL: [&str; 2] = ["explicit-official-route", "session-native"];

/// 程序判定（规格 §2 阶梯的合成，§5.1 三态）。只用事实里已有的 provider/evidence、
/// 目录里的 L0 厂商和白名单账户证据；`inferred` 永远到不了 determined。
fn auto_verdict(
    group: &Value, accounts: &std::collections::BTreeMap<String, agent_vitals_provider::AccountEvidence>,
    endpoints: &std::collections::BTreeMap<String, agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence>,
) -> Value {
    use agent_vitals_provider::PlanKind;
    let harness = group["harness"].as_str().unwrap_or("");
    let provider = group["provider_id"].as_str().filter(|p| *p != "<unknown>").map(str::to_string);
    let model = group["model_id"].as_str().unwrap_or("");
    let evidence = group["evidence_basis"].as_str().unwrap_or("missing");
    let vendor = agent_vitals_domain::attribution::model_vendor(model);
    let vendor_name = vendor.as_ref().map(|v| v.vendor.clone());
    let gateway_named = vendor.as_ref().is_some_and(|v| v.gateway_named);
    // 配置面证据（跨执行环境，A12）：会话日志**不记**端点，只有启动配置记（各执行环境读哪个文件
    // 见 `agent_vitals_harnesses::sources::endpoint_evidence`）。配置里的端点都不是该模型厂商的
    // 官方端点 → 请求经中转。强度 `config-current`(4) 低于会话级，所以它只能把
    // 「官方还是中转」这一问变成一次**确认**，永远不能单独判 determined。
    use agent_vitals_harnesses::sources::endpoint_evidence::model_tail;
    let endpoint = endpoints.get(harness);
    let config_source = endpoint.map(|e| e.source.clone());
    let live_endpoint_hostnames: Vec<String> = endpoint.map(|e| e.endpoint_hostnames.clone()).unwrap_or_default();
    // 时间线证据（`config-time-bound`，cc-switch 的 provider 表）：这批事实的时间窗
    // `[first, last]` 与每个中转的建立时刻比——**建立晚于窗口末尾的中转从候选里剔掉**
    // （它那时不存在，这批用量不可能经它；2026-09-17：胜算云 09-11 深夜才建，09-09 的
    // 395 次 gpt-5.6-sol 被当前 config.toml 建议成了胜算云）。建立时刻落在窗口**中间**
    // 的标 `partial`——组是按模型聚的、不按时间切，前半段不可能、后半段可能，判定器
    // 不替用户切，只把切点带出去（`tokens_before` 在 `confirmation_groups_with` 用库补）。
    let first_ts = group["first_event_at_ms"].as_i64();
    let last_ts = group["last_event_at_ms"].as_i64();
    let timeline = endpoint.map(|e| e.timeline.as_slice()).unwrap_or(&[]);
    let config_timeline: Vec<Value> = timeline.iter().map(|r| {
        let relation = match (r.created_at_ms, first_ts, last_ts) {
            (Some(created), _, Some(last)) if created > last => "excluded",
            (Some(created), Some(first), Some(last)) if created > first && created <= last => "partial",
            (Some(_), _, _) => "possible",
            (None, _, _) => "unknown",
        };
        json!({
            "endpoint_host": r.endpoint_host, "label": r.label, "created_at_ms": r.created_at_ms,
            "is_current": r.is_current, "active_at_ms": r.active_at_ms, "relation": relation,
            "relay_label": agent_vitals_harnesses::sources::endpoint_evidence::relay_label_of(&r.endpoint_host),
        })
    }).collect();
    let excluded_harnesses: Vec<&str> = config_timeline.iter()
        .filter(|t| t["relation"] == json!("excluded"))
        .filter_map(|t| t["endpoint_host"].as_str()).collect();
    // 历史条目只在**没有会话级官方证据**时才补进候选：官方形状的用量（provider 自报 +
    // session-native）不因为 cc-switch 里配置过中转就多一条 conflict。剔除则无条件——
    // 当前配置指向一个当时不存在的端点，对官方用量同样不构成矛盾。
    let timeline_applies = !(provider.is_some() && ROUTE_KNOWN_OFFICIAL.contains(&evidence));
    let mut all_endpoint_hostnames: Vec<String> = live_endpoint_hostnames.iter()
        .filter(|h| !excluded_harnesses.contains(&h.as_str())).cloned().collect();
    let mut timeline_added = false;
    if timeline_applies {
        for t in &config_timeline {
            let (Some(h), Some(rel)) = (t["endpoint_host"].as_str(), t["relation"].as_str()) else { continue };
            if rel != "excluded" && !all_endpoint_hostnames.iter().any(|x| x == h) {
                all_endpoint_hostnames.push(h.to_string());
                timeline_added = true;
            }
        }
        all_endpoint_hostnames.sort();
        all_endpoint_hostnames.dedup();
    }
    let live_harness_excluded = endpoint.and_then(|e| e.endpoint_host.as_deref())
        .is_some_and(|h| excluded_harnesses.contains(&h));
    // **厂商未知时"官方端点"无从谈起**：`official_for_vendor` 恒 false，会把配置里的每个
    // 端点都算成中转——连 `api.anthropic.com` 也能被当成中转名写进声明（验收审查 iteration 7 #1）。
    let vendor_known = vendor_name.is_some();
    let official_for_vendor = |h: &str| {
        vendor_name.as_deref()
            .is_some_and(|v| agent_vitals_domain::attribution::is_official_endpoint(v, h))
    };
    // 逐模型端点：键先精确匹配，再按"最后一段"匹配（配置常带厂商前缀、事实常是上游裸名）。
    let per_model: Option<(String, String)> = endpoint.and_then(|e| {
        e.model_endpoints.iter().find(|(k, _)| k.as_str() == model)
            .or_else(|| e.model_endpoints.iter().find(|(k, _)| model_tail(k) == model_tail(model)))
            .map(|(k, v)| (k.clone(), v.clone()))
    });
    let model_endpoint_host = per_model.as_ref().map(|(_, v)| v.clone());
    let (config_relay, config_relay_multiple, config_relay_ambiguous) = if !vendor_known {
        (None, false, false)
    } else if let Some(single) = model_endpoint_host.clone() {
        if official_for_vendor(&single) { (None, false, false) } else { (Some(single), false, false) }
    } else if endpoint.is_some_and(|e| e.per_model_config) {
        // **逐模型配置里没有这条模型 → 这条模型没有端点证据**。执行环境级列表在逐模型配置里
        // 不是"这个执行环境的端点"，而是"某些模型的端点"，拿它给别的模型下结论就是上一轮那个
        // 类别错误（验收审查 iteration 9 #1：`hy3`/`glm-5.2` 这类没进配置表的模型会被
        // 说成"经中转（api.minimaxi.com）"）。
        (None, false, false)
    } else {
        let relays: Vec<&String> = all_endpoint_hostnames.iter().filter(|h| !official_for_vendor(h)).collect();
        let official = all_endpoint_hostnames.len() - relays.len();
        if all_endpoint_hostnames.len() == 1 && relays.len() == 1 {
            (relays.first().map(|h| (*h).clone()), false, false)
        } else if official == 0 && relays.len() > 1 {
            (None, true, false)
        } else if official > 0 && !relays.is_empty() {
            (None, false, true)
        } else {
            (None, false, false)
        }
    };
    // 第二路配置证据（用户 2026-09-16 实测指出）：**官方端点不带厂商 id，中转才需要**。
    // **作用域必须跟着配置的形状走**：逐模型配置（workbuddy/pi）里"某个模型的 id 带前缀"
    // 只是那个模型的事——同一条文件里 `deepseek/…` 与裸 `MiniMax-M3` 并存，拿前者当执行环境级
    // 信号会把 MiniMax 说成经中转（验收审查 iteration 8 #1）。执行环境级配置（claude/codex/dsh，
    // 一套映射管全部请求）才是对全执行环境的陈述。
    let config_gateway_named = endpoint.map(|e| {
        if e.per_model_config {
            // 这条模型自己有没有逐模型条目、且它的 id 带前缀。
            // 前缀只是"像中转"的信号；它指向的端点若就是该厂商的官方端点，则官方端点说了算
            // （验收审查 iteration 9 #2：`minimax/MiniMax-M3 → api.minimaxi.com` 不该判中转）。
            per_model.as_ref().is_some_and(|(key, harness)| key.contains('/') && !official_for_vendor(harness))
        } else {
            !e.gateway_named_models.is_empty()
        }
    }).unwrap_or(false) && vendor_known;
    let relay_evidence = config_relay.is_some() || config_relay_multiple || config_gateway_named;
    // 展示用的端点必须是**判定实际用的那一个**（逐模型优先），否则行面会说
    // "经中转（api.minimaxi.com）"而按钮写着另一个名字（验收审查 iteration 8 #2）。
    let config_endpoint_host = model_endpoint_host.clone().or_else(|| {
        // 逐模型配置没有"执行环境级端点"可言——没有条目就**什么都不显示**，不拿第一个配置的
        // 端点冒充（验收审查 iteration 9 #3）。当前端点被时间线剔除时同样不显示它——
        // 行面写着一个当时不存在的端点就是在说假话；剩下唯一候选时显示那个。
        if live_harness_excluded {
            config_relay.clone()
        } else {
            endpoint.filter(|e| !e.per_model_config).and_then(|e| e.endpoint_host.clone())
        }
    });
    let mut basis: Vec<String> = Vec::new();
    // `conflict` = 执行环境自报的 provider 与会话级路由证据指的不是同一家。这样的事实本身
    // 就没有归因（emitter 写 `provider_id=null` / `metered_estimate`），判定器更不能拿它
    // 产 `determined`：规格 §2「Conflict 单列，不归因」、不变量 P3「冲突不吞」。
    // 曾经它落进 provider_reported 分支，codex 的冲突事实 + `auth_mode=chatgpt`
    // 就成了「一键确认 ChatGPT 订阅」，只是写入侧另有一道 ConflictEvidence::Exclude
    // 兜住钱（验收审查 iteration 3 #1）。
    if evidence == "conflict" {
        return json!({
            "model_vendor": vendor_name, "gateway_named": gateway_named,
            "route_state": "conflict", "route_basis": evidence,
            "billing_party": null, "config_endpoint": config_endpoint_host, "config_source": config_source,
            "billing_mode": null, "relationship_kind": null,
            "plan": null, "state": "needs_input", "question": null,
            "basis": ["route.conflict"],
        });
    }
    let route_state = if provider.is_some() && ROUTE_KNOWN_OFFICIAL.contains(&evidence) {
        basis.push(format!("route.{evidence}"));
        // 官方形状与会话级证据是**推断**出来的端点，配置是直接说的：中转代理 Anthropic
        // 时会原样保留 `req_01…`/`msg_01…` 形状，于是两者可能同时成立。不改变判定
        // （不该用弱证据推翻强证据），但必须把矛盾摆出来——P5「冲突不吞」。
        if relay_evidence {
            basis.push("config.endpoint.conflict".to_string());
        }
        "official"
    } else if relay_evidence {
        if config_relay.is_some() {
            basis.push("config.endpoint".to_string());
        }
        if config_relay_multiple {
            basis.push("config.endpoint.multiple".to_string());
        }
        if config_gateway_named {
            basis.push("config.gateway_named".to_string());
        }
        "relay_config"
    } else if provider.is_some() {
        basis.push("harness.provider_reported".to_string());
        "provider_reported"
    } else if gateway_named {
        basis.push("model.gateway_named".to_string());
        "gateway"
    } else if evidence == "inferred" && vendor_name.is_some() {
        basis.push("response_id.vendor_shape".to_string());
        "vendor_shape"
    } else {
        "unknown"
    };
    // 混合配置（官方与中转并存）不构成中转断言，但必须留下痕迹——不说也不能装作没看见。
    if config_relay_ambiguous {
        basis.push("config.endpoint.ambiguous".to_string());
    }
    // 时间线痕迹：剔除了谁、谁只覆盖后半段、候选里有没有历史条目——都要在依据里可见。
    if !excluded_harnesses.is_empty() {
        basis.push("config.timeline.excluded".to_string());
    }
    if config_timeline.iter().any(|t| t["relation"] == json!("partial")) {
        basis.push("config.timeline.partial".to_string());
    }
    if timeline_added {
        basis.push("config.timeline".to_string());
    }
    // 网关式命名与配置指向的中转：计费方都不是模型厂商。
    let billing_party = if route_state == "relay_config" {
        // 经中转时付款方是中转，**绝不能落回执行环境自报的模型厂商**（验收审查 iteration 5 #2：
        // 旧写法 `provider.clone().or_else(…)` 先命中 provider，行里就会出现
        // "经中转 · 计费方=minimax" 这种自相矛盾的标签）。认不出注册域（IP / 公共后缀）
        // 或说不出是哪一家时留空，让用户在弹窗里写。
        config_relay.as_deref().and_then(agent_vitals_harnesses::sources::endpoint_evidence::relay_label_of)
    } else {
        provider.clone().or_else(|| if route_state == "gateway" { None } else { vendor_name.clone() })
    };
    let account = accounts.get(harness).filter(|a| Some(&a.vendor) == billing_party.as_ref());
    let mut plan = json!(null);
    let (state, relationship_kind, billing_mode) = match (route_state, account.map(|a| a.plan_kind)) {
        ("official", Some(PlanKind::Subscription)) => {
            let a = account.unwrap();
            basis.push(format!("account.{}", a.plan_label.clone().unwrap_or_else(|| "subscription".into())));
            plan = json!({ "label": a.plan_label, "channel": a.billing_channel, "anchor_date": a.anchor_date, "source": a.source });
            ("determined", Some("official_subscription"), Some("subscription"))
        }
        ("official", Some(PlanKind::ApiKey)) => {
            basis.push("account.api_key".to_string());
            ("determined", Some("official_api"), Some("metered"))
        }
        // codex：rollout 自报 openai + 账户 chatgpt 登录 → 请求走 ChatGPT 后端，按套餐计。
        // 自报 provider + 账户订阅 → 官方订阅：**只有声明了这条性质的执行环境**才走
        // （codex 的 `model_provider`），不是 `harness == "codex"` 的名字判断。
        ("provider_reported", Some(PlanKind::Subscription))
            if agent_vitals_domain::harness_capability::attribution_profile(harness).provider_reported_implies_official => {
            let a = account.unwrap();
            basis.push(format!("account.{}", a.plan_label.clone().unwrap_or_else(|| "subscription".into())));
            plan = json!({ "label": a.plan_label, "channel": a.billing_channel, "anchor_date": a.anchor_date, "source": a.source });
            ("determined", Some("official_subscription"), Some("subscription"))
        }
        ("official", _) | ("provider_reported", _) => ("one_question", None, None),
        ("gateway", _) | ("vendor_shape", _) | ("relay_config", _) => ("one_question", None, Some("metered")),
        _ => ("needs_input", None, None),
    };
    let question = match (state, route_state) {
        ("one_question", "official") | ("one_question", "provider_reported") => json!("billing_mode"),
        ("one_question", _) => json!("route"),
        _ => json!(null),
    };
    json!({
        "model_vendor": vendor_name,
        "gateway_named": gateway_named,
        "route_state": route_state,
        "route_basis": evidence,
        "billing_party": billing_party,
        // 配置证据原样带出，UI 才能说清"配置指向哪"（不是我们猜的）。
        "config_endpoint": config_endpoint_host,
        "config_source": config_source,
        // 时间线（cc-switch）：每个配置过的中转与这批事实时间窗的关系；`partial` 条目的
        // `tokens_before` / `facts_before` 由 `confirmation_groups_with` 用库补上。
        "config_timeline": config_timeline,
        "billing_mode": billing_mode,
        "relationship_kind": relationship_kind,
        "plan": plan,
        "state": state,
        "question": question,
        "basis": basis,
    })
}

/// `partial` 的时间线条目：数出这组里**早于该中转建立时刻**的事实（它们不可能经它）。
/// 谓词与组 SQL 共享 `SQL_UNRESOLVED_BILLING_FACT_WHERE`（同一批事实），只把窗口末尾换成
/// 建立时刻。查不到就留 null，不冒充 0。
fn fill_timeline_splits(db: &AuthorityDb, group: &Value, verdict: &mut Value, month_start_ms: i64) {
    let Some(entries) = verdict["config_timeline"].as_array_mut() else { return };
    for entry in entries.iter_mut() {
        if entry["relation"] != json!("partial") {
            continue;
        }
        let Some(cutoff) = entry["created_at_ms"].as_i64() else { continue };
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(f.uncached_input_tokens + f.cache_read_tokens + f.cache_write_tokens + f.output_tokens), 0)
             FROM usage_facts f WHERE {} AND f.harness = ?3 AND COALESCE(f.provider_id, '<unknown>') = ?4
               AND COALESCE(f.model_id, '<unknown>') = ?5 AND COALESCE(f.evidence_basis, 'missing') = ?6
               AND COALESCE(f.pricing_basis, 'unavailable') = ?7",
            agent_vitals_data::authority_query::SQL_UNRESOLVED_BILLING_FACT_WHERE,
        );
        let row: Result<(i64, i64), _> = db.conn().query_row(&sql, rusqlite::params![
            month_start_ms, cutoff,
            group["harness"].as_str().unwrap_or(""),
            group["provider_id"].as_str().unwrap_or("<unknown>"),
            group["model_id"].as_str().unwrap_or("<unknown>"),
            group["evidence_basis"].as_str().unwrap_or("missing"),
            group["pricing_basis"].as_str().unwrap_or("unavailable"),
        ], |r| Ok((r.get(0)?, r.get(1)?)));
        if let Ok((facts, tokens)) = row {
            entry["facts_before"] = json!(facts);
            entry["tokens_before"] = json!(tokens);
        }
    }
}

/// 簇级 `config_timeline`：成员各自的关系合并成一个。**说"整行排除"必须对每个成员都
/// 成立**——只有全体成员都是 `excluded` 才保留 `excluded`；只要有一个成员证明过排除
/// （`excluded` 或 `partial`），簇级至少是 `partial`（这一行确有一部分 token 排除了该
/// 中转，即使不是全部）；都没有排除证据（`possible`/时间未知）才落 `possible`。
/// `tokens_before` 求和。此前"取最弱"（possible > partial > excluded）会把
/// `excluded` 与 `possible` 合并成 `possible`，把已经证明排除的那部分 token 的信号
/// 整个抹掉——落地前用两个模型合一簇、其中一个对候选中转 excluded、另一个 possible
/// 的场景钉住（`merge_timeline_keeps_partial_exclusion_visible`）。
fn merge_timeline(into: &mut Value, from: &Value) {
    let Some(from_rows) = from.as_array() else { return };
    let has_exclusion = |rel: &str| rel == "excluded" || rel == "partial";
    let merge_relation = |er: &str, fr: &str| -> &'static str {
        if er == "excluded" && fr == "excluded" {
            "excluded"
        } else if has_exclusion(er) || has_exclusion(fr) {
            "partial"
        } else {
            "possible"
        }
    };
    let mut rows: Vec<Value> = into.as_array().cloned().unwrap_or_default();
    for f in from_rows {
        let harness = f["endpoint_host"].clone();
        match rows.iter_mut().find(|r| r["endpoint_host"] == harness) {
            Some(existing) => {
                let (er, fr) = (existing["relation"].as_str().unwrap_or(""), f["relation"].as_str().unwrap_or(""));
                existing["relation"] = json!(merge_relation(er, fr));
                for key in ["tokens_before", "facts_before"] {
                    if let (Some(a), Some(b)) = (existing[key].as_i64(), f[key].as_i64()) {
                        existing[key] = json!(a + b);
                    } else if f[key].is_i64() {
                        existing[key] = f[key].clone();
                    }
                }
            }
            None => rows.push(f.clone()),
        }
    }
    *into = json!(rows);
}

/// 列表行 = `harness × 计费方/厂商 × route_state × 判定状态`；模型折进 `models[]`，
/// 数字求和、金额按币种归并。
fn clusters_of(groups: &[Value]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: BTreeMap<String, Value> = BTreeMap::new();
    // 每个簇里出现过的 `config_endpoint` 集合：成员们不一致时簇级不能沿用第一个的
    // （验收审查 iteration 10 #1：簇级聚合会把小组级正确的差异抹平，行面就替另一条模型
    // 声称一个它没用过的端点）。`None` 与具体值都算不同的成员值。
    let mut endpoints_seen: BTreeMap<String, std::collections::BTreeSet<Option<String>>> = BTreeMap::new();
    for group in groups {
        let v = &group["auto_verdict"];
        // 行主键 = `harness × (计费方 or 厂商) × route_state × 判定状态 × 日期`（规格 §5.1）。
        // 空位补上 `model_vendor`：网关行的 `billing_party` 恒空，只按它分组会把
        // anthropic 与 deepseek 的网关模型并成一行、再用第一组的厂商当整行标签
        // （验收审查 iteration 3 #4）。
        let party = v["billing_party"].as_str()
            .or_else(|| v["model_vendor"].as_str())
            .unwrap_or("<unknown>");
        let key = format!(
            "{}|{}|{}|{}|{}|{}",
            group["harness"].as_str().unwrap_or(""),
            party,
            v["route_state"].as_str().unwrap_or("unknown"),
            v["state"].as_str().unwrap_or("needs_input"),
            group["effective_start"].as_str().unwrap_or(""),
            group["effective_end"].as_str().unwrap_or(""),
        );
        let entry = by_key.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            json!({
                "cluster_id": key,
                "harness": group["harness"], "billing_party": v["billing_party"], "model_vendor": v["model_vendor"],
                "provider_id": group["provider_id"], "evidence_basis": group["evidence_basis"],
                "pricing_basis": group["pricing_basis"],
                "effective_start": group["effective_start"], "effective_end": group["effective_end"],
                "auto_verdict": v.clone(),
                "models": [], "group_ids": [], "tokens": 0, "session_count": 0, "unpriced_tokens": 0,
                "estimated_amounts": [],
            })
        });
        entry["models"].as_array_mut().unwrap().push(json!({
            "model_id": group["model_id"], "tokens": group["tokens"], "session_count": group["session_count"],
            "estimated_amounts": group["estimated_amounts"], "group_id": group["group_id"],
        }));
        entry["group_ids"].as_array_mut().unwrap().push(group["group_id"].clone());
        if entry["group_ids"].as_array().map(|g| g.len()).unwrap_or(0) > 1 {
            let from = v["config_timeline"].clone();
            merge_timeline(&mut entry["auto_verdict"]["config_timeline"], &from);
        }
        endpoints_seen.entry(key.clone()).or_default()
            .insert(v["config_endpoint"].as_str().map(ToOwned::to_owned));
        for field in ["tokens", "session_count", "unpriced_tokens"] {
            let sum = entry[field].as_i64().unwrap_or(0) + group[field].as_i64().unwrap_or(0);
            entry[field] = json!(sum);
        }
        let mut amounts: BTreeMap<(String, String), i64> = entry["estimated_amounts"].as_array().unwrap().iter()
            .map(|row| (amount_key(row), row["amount_minor"].as_i64().unwrap_or(0))).collect();
        for row in group["estimated_amounts"].as_array().into_iter().flatten() {
            *amounts.entry(amount_key(row)).or_insert(0) += row["amount_minor"].as_i64().unwrap_or(0);
        }
        entry["estimated_amounts"] = json!(amounts.into_iter().map(|((currency, basis), amount_minor)| json!({
            "amount_minor": amount_minor, "currency": currency, "basis": basis,
        })).collect::<Vec<_>>());
    }
    let mut clusters: Vec<Value> = order.into_iter().filter_map(|k| by_key.remove(&k)).collect();
    // 簇级展示字段只在该簇**成员一致**时才沿用第一个的：不一致时留空并记一条依据，
    // 让行面说"这些模型配置的端点不一样"，而不是替它们挑一个。
    for cluster in clusters.iter_mut() {
        let id = cluster["cluster_id"].as_str().unwrap_or("").to_string();
        let seen = endpoints_seen.remove(&id).unwrap_or_default();
        if seen.len() > 1 {
            cluster["auto_verdict"]["config_endpoint"] = json!(null);
            if let Some(basis) = cluster["auto_verdict"]["basis"].as_array_mut() {
                basis.retain(|b| !b.as_str().unwrap_or("").starts_with("config.endpoint"));
                basis.push(json!("config.endpoint.mixed"));
            }
        }
    }
    // 程序已判定的置顶（一键确认清掉最多），其余按金额降序，无价卡按 tokens。
    clusters.sort_by(|a, b| {
        let rank = |c: &Value| match c["auto_verdict"]["state"].as_str() {
            Some("determined") => 0, Some("one_question") => 1, _ => 2,
        };
        let amount = |c: &Value| c["estimated_amounts"].as_array()
            .and_then(|rows| rows.iter().filter_map(|row| row["amount_minor"].as_i64()).max()).unwrap_or(-1);
        let tokens = |c: &Value| c["tokens"].as_i64().unwrap_or(0);
        rank(a).cmp(&rank(b)).then_with(|| amount(b).cmp(&amount(a))).then_with(|| tokens(b).cmp(&tokens(a)))
    });
    clusters
}

/// 按 `(currency, basis)` 逐槽相减，永不跨币种；负数说明两次选择不是子集关系，
/// 属于谓词漂移，钳到 0 并不掩盖——`kept.tokens` 会同时暴露。
fn subtract_amounts(all: &[Value], moved: &[Value]) -> Vec<Value> {
    let mut slots: BTreeMap<(String, String), i64> = BTreeMap::new();
    for row in all {
        let key = amount_key(row);
        *slots.entry(key).or_insert(0) += row.get("amount_minor").and_then(Value::as_i64).unwrap_or(0);
    }
    for row in moved {
        let key = amount_key(row);
        *slots.entry(key).or_insert(0) -= row.get("amount_minor").and_then(Value::as_i64).unwrap_or(0);
    }
    slots.into_iter().map(|((currency, basis), amount_minor)| json!({
        "amount_minor": amount_minor.max(0), "currency": currency, "basis": basis,
    })).collect()
}

fn amount_key(row: &Value) -> (String, String) {
    (
        row.get("currency").and_then(Value::as_str).unwrap_or("").to_owned(),
        row.get("basis").and_then(Value::as_str).unwrap_or("").to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("avr-billing-preview-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_codex_fact(db: &AuthorityDb, fact_id: &str, model: &str, event_ts_ms: i64, uncached: i64, output: i64) {
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 13) ON CONFLICT(run_id) DO NOTHING", [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis,
                 evidence_basis, billing_mode, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES (?1, 'codex', 'm', 'sess', ?1, 'token_count', 'openai', ?2, ?3, 0, 'metered_estimate',
                 'session-native', 'metered', ?4, 0, 0, ?5, 'run', 1, 1)",
            rusqlite::params![fact_id, model, event_ts_ms, uncached, output],
        ).unwrap();
    }

    fn amounts_of(rows: &[Value], billing_mode: &str) -> BTreeMap<(String, String), i64> {
        let mut out = BTreeMap::new();
        for row in rows {
            if row["key"]["billing_mode"] != json!(billing_mode) { continue; }
            let Some(amount) = row.get("amount").filter(|a| !a.is_null()) else { continue; };
            *out.entry(amount_key(amount)).or_insert(0) += amount["amount_minor"].as_i64().unwrap();
        }
        out
    }

    /// 规格 R5：预览「移出估算」的金额 == 重算后 MCP `cost_breakdown` 从按量桶里
    /// 消失、进入 `subscription` 桶的那部分——同一谓词、同一计价路径；且预览不写任何行。
    ///
    /// 2026-10-01 语义变更：官方订阅默认覆盖「该执行环境下该服务商」的全部模型，声明里列的模型清单
    /// 不再限制它（否则每个新模型都要用户回来补声明）。所以声明只列 `gpt-5.6-sol` 时，
    /// `gpt-5.6-luna` 也一起移出估算，`kept` 为空；曾断言「清单外的模型留在 kept」。
    #[test]
    fn preview_moved_amounts_equal_cost_breakdown_subscription_bucket_after_recalc() {
        let home = temp_home("r5");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (month_start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-08").unwrap();
        let noon = month_start + 12 * 3_600_000;
        let snapshot = json!({
            "pricing": agent_vitals_domain::cost::load_pricing(),
            "codex_pricing": crate::sessions::codex_cost::load_codex_pricing(),
        }).to_string();
        db.pricing_snapshot_put("v-test", "test", &snapshot, month_start - 1_000).unwrap();
        seed_codex_fact(&db, "f-move-a", "gpt-5.6-sol", noon, 1_000_000, 100_000);
        seed_codex_fact(&db, "f-move-b", "gpt-5.6-sol", noon + 3_600_000, 500_000, 50_000);
        seed_codex_fact(&db, "f-keep", "gpt-5.6-luna", noon + 7_200_000, 700_000, 70_000);

        let scopes = [("model", "gpt-5.6-sol")];
        let preview = declaration_impact_preview(
            &db,"openai", "official_subscription", "2026-08", Some("2026-08"), &scopes,
        );
        assert_eq!(preview["status"], json!("ok"), "{preview}");
        assert_eq!(preview["changes_amounts"], json!(true));
        assert_eq!(preview["moved"]["fact_count"], json!(3), "官方订阅默认覆盖整个服务商：luna 也移出");
        assert_eq!(preview["moved"]["tokens"], json!(2_420_000));
        assert_eq!(preview["kept"]["tokens"], json!(0));
        assert_eq!(preview["pending"]["fact_count"], json!(0));
        let moved_amounts = preview["moved"]["amounts"].as_array().unwrap();
        assert_eq!(moved_amounts.len(), 1, "one currency, one basis: {moved_amounts:?}");
        assert_eq!(moved_amounts[0]["currency"], json!("USD"));
        let moved_usd = moved_amounts[0]["amount_minor"].as_i64().unwrap();
        assert!(moved_usd > 0);
        let kept_usd = preview["kept"]["amounts"].as_array().and_then(|rows| rows.first())
            .and_then(|row| row["amount_minor"].as_i64()).unwrap_or(0);
        assert_eq!(kept_usd, 0, "没有什么留在按量桶里");
        assert_eq!(db.conn().query_row(
            "SELECT COUNT(*) FROM billing_declaration_revisions", [], |row| row.get::<_, i64>(0),
        ).unwrap(), 0, "preview must not persist anything");

        let breakdown_args = json!({"from": "2026-08-01", "to": "2026-08-31"});
        let before = crate::query::cost_breakdown::run(&breakdown_args, &home).unwrap();
        let before_rows = before["data"]["breakdown"].as_array().unwrap().clone();
        let before_metered: i64 = amounts_of(&before_rows, "metered").values().sum();
        assert_eq!(before_metered, moved_usd + kept_usd, "preview moved + kept == whole metered window");

        db.billing_declaration_revision_save(
            "rev-r5", "decl-r5", None,"openai", "official_subscription",
            None, None, None, "2026-08", Some("2026-08"), None, None, &scopes, 2,
        ).unwrap();
        db.billing_recalculation_enqueue("job-r5", "decl-r5", "rev-r5", 3).unwrap();
        assert!(db.billing_recalculation_run("job-r5", 4).unwrap());
        drop(db);

        let after = crate::query::cost_breakdown::run(&breakdown_args, &home).unwrap();
        let after_rows = after["data"]["breakdown"].as_array().unwrap().clone();
        let after_metered: i64 = amounts_of(&after_rows, "metered").values().sum();
        assert_eq!(after_metered, kept_usd, "what stays metered is exactly the preview's kept amount");
        assert_eq!(before_metered - after_metered, moved_usd, "what left the metered bucket is exactly the preview's moved amount");
        let subscription_tokens: i64 = after_rows.iter()
            .filter(|row| row["key"]["billing_mode"] == json!("subscription"))
            .map(|row| row["tokens"]["total"].as_i64().unwrap()).sum();
        assert_eq!(subscription_tokens, 2_420_000);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 规格 R3（2026-09-16 修订）：待确认组带分币估算金额、按金额降序；**任意关系**
    /// 的确认都让组消失（已回答；非订阅写 user_declared，金额仍不变——D02），撤销后
    /// 组立即回来（撤销不需要重算）。
    #[test]
    fn confirmation_groups_price_close_on_any_relation_and_reopen_on_revoke() {
        let home = temp_home("r3");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (month_start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-08").unwrap();
        let noon = month_start + 12 * 3_600_000;
        let snapshot = json!({
            "pricing": agent_vitals_domain::cost::load_pricing(),
            "codex_pricing": crate::sessions::codex_cost::load_codex_pricing(),
        }).to_string();
        db.pricing_snapshot_put("v-test", "test", &snapshot, month_start - 1_000).unwrap();
        seed_codex_fact(&db, "f-small", "gpt-5.6-luna", noon, 100_000, 10_000);
        seed_codex_fact(&db, "f-big", "gpt-5.6-sol", noon + 60_000, 2_000_000, 200_000);

        let report = confirmation_groups(&db, "2026-08");
        assert_eq!(report["status"], json!("ok"), "{report}");
        let groups = report["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["model_id"], json!("gpt-5.6-sol"), "largest amount first");
        assert_eq!(groups[0]["estimated_amounts"][0]["currency"], json!("USD"));
        assert!(groups[0]["estimated_amounts"][0]["amount_minor"].as_i64().unwrap()
            > groups[1]["estimated_amounts"][0]["amount_minor"].as_i64().unwrap());
        assert_eq!(groups[0]["effective_start"], json!("2026-08"));
        assert_eq!(groups[0]["effective_end"], json!("2026-08"));
        assert!(groups[0].get("estimated_cost_minor").is_none());

        let scopes = [("model", "gpt-5.6-sol")];
        // 2026-09-16 起**任意关系种类**都关掉自己的组（确认＝已回答），不再只有订阅：
        // official_api 的重算写 user_declared 归因——金额排除谓词不认它（数字不变，
        // D02），待确认组谓词认它（行关掉）。此前"只有订阅关组"的真机后果：确认
        // 经中转后行永远留在待确认里。
        db.billing_declaration_revision_save(
            "rev-api", "decl-api", None,"openai", "official_api",
            None, None, None, "2026-08", Some("2026-08"), None, None, &scopes, 2,
        ).unwrap();
        db.billing_recalculation_enqueue("job-api", "decl-api", "rev-api", 3).unwrap();
        assert!(db.billing_recalculation_run("job-api", 4).unwrap());
        let after_api = confirmation_groups(&db, "2026-08");
        assert_eq!(after_api["groups"].as_array().unwrap().len(), 1,
            "确认官方 API 也把组关掉（已回答），只剩未回答的 luna");
        assert_eq!(after_api["groups"][0]["model_id"], json!("gpt-5.6-luna"));

        assert!(db.billing_declaration_revision_revoke("rev-api-revoke", "decl-api", "rev-api", 5).unwrap());
        assert_eq!(confirmation_groups(&db, "2026-08")["groups"].as_array().unwrap().len(), 2,
            "撤销官方 API 后组重新打开（MAX 修订变 revoked，无需重算）");

        db.billing_declaration_revision_save(
            "rev-sub", "decl-sub", None,"openai", "official_subscription",
            None, None, None, "2026-08", Some("2026-08"), None, None, &scopes, 6,
        ).unwrap();
        db.billing_recalculation_enqueue("job-sub", "decl-sub", "rev-sub", 7).unwrap();
        assert!(db.billing_recalculation_run("job-sub", 8).unwrap());
        let after = confirmation_groups(&db, "2026-08");
        // 官方订阅默认覆盖整个服务商（2026-10-01）：声明只列 sol，luna 也一并回答了，组全部关掉。
        // 曾断言「只剩未回答的 luna」——那正是新模型总要用户回来补声明的缺陷。
        let remaining = after["groups"].as_array().unwrap();
        assert_eq!(remaining.len(), 0, "{after}");

        assert!(db.billing_declaration_revision_revoke("rev-sub-revoke", "decl-sub", "rev-sub", 9).unwrap());
        assert_eq!(confirmation_groups(&db, "2026-08")["groups"].as_array().unwrap().len(), 2,
            "revoke restores the group without a recalculation job");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 规格 §5.1 三态：官方路由 + 账户订阅 → determined（一键确认）；厂商形状
    /// inferred → one_question(route)；codex 自报 openai + chatgpt 登录 → determined；
    /// workbuddy 不进列表；程序已判定的簇置顶。
    #[test]
    fn auto_verdict_states_and_clusters() {
        use agent_vitals_provider::{AccountEvidence, EvidenceBasis, PlanKind};
        let home = temp_home("verdict");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (month_start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-08").unwrap();
        let noon = month_start + 12 * 3_600_000;
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 14)", [],
        ).unwrap();
        let insert = |fact: &str, harness: &str, provider: Option<&str>, model: &str, evidence: &str, pricing: &str, ts: i64| {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                     billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 'sess', ?1, 'token_count', ?3, ?4, ?5, 0, ?6, ?7, 'metered', 1000, 0, 0, 10, 'run', 1, 1)",
                rusqlite::params![fact, harness, provider, model, ts, pricing, evidence],
            ).unwrap();
        };
        insert("f-claude-official", "claude-code", Some("anthropic"), "claude-opus-5", "session-native", "route-observed", noon);
        insert("f-claude-minimax", "claude-code", None, "MiniMax-M3", "inferred", "metered_estimate", noon + 1);
        insert("f-claude-gateway", "claude-code", None, "anthropic/claude-opus-5", "inferred", "metered_estimate", noon + 2);
        insert("f-codex-openai", "codex", Some("openai"), "gpt-5.6-sol", "missing", "metered_estimate", noon + 3);
        insert("f-codex-custom", "codex", None, "gpt-5.6-luna", "missing", "metered_estimate", noon + 4);
        insert("f-workbuddy", "workbuddy", None, "hy4-preview-f", "missing", "metered_estimate", noon + 5);
        let mut accounts = std::collections::BTreeMap::new();
        accounts.insert("claude-code".to_string(), AccountEvidence {
            harness: "claude-code".into(), vendor: "anthropic".into(), plan_kind: PlanKind::Subscription,
            plan_label: Some("Claude Pro".into()), billing_channel: Some("apple_subscription".into()),
            anchor_date: Some("2025-07-20".into()), evidence_basis: EvidenceBasis::AccountTimeBound, source: "test".into(),
        });
        accounts.insert("codex".to_string(), AccountEvidence {
            harness: "codex".into(), vendor: "openai".into(), plan_kind: PlanKind::Subscription,
            plan_label: Some("ChatGPT".into()), billing_channel: None, anchor_date: None,
            evidence_basis: EvidenceBasis::AccountTimeBound, source: "test".into(),
        });
        let report = confirmation_groups_with(&db, "2026-08", &accounts, &Default::default());
        assert_eq!(report["status"], json!("ok"), "{report}");
        let groups = report["groups"].as_array().unwrap();
        assert!(groups.iter().all(|g| g["harness"] != json!("workbuddy")), "credits harness must not be pending");
        let verdict_of = |model: &str| groups.iter().find(|g| g["model_id"] == json!(model)).unwrap()["auto_verdict"].clone();
        let claude = verdict_of("claude-opus-5");
        assert_eq!(claude["state"], json!("determined"));
        assert_eq!(claude["relationship_kind"], json!("official_subscription"));
        assert_eq!(claude["plan"]["label"], json!("Claude Pro"));
        assert_eq!(claude["plan"]["anchor_date"], json!("2025-07-20"));
        let minimax = verdict_of("MiniMax-M3");
        assert_eq!((minimax["state"].clone(), minimax["question"].clone(), minimax["model_vendor"].clone()),
            (json!("one_question"), json!("route"), json!("minimax")));
        assert_eq!(verdict_of("anthropic/claude-opus-5")["route_state"], json!("gateway"));
        let codex = verdict_of("gpt-5.6-sol");
        assert_eq!((codex["state"].clone(), codex["route_state"].clone()), (json!("determined"), json!("provider_reported")));
        let custom = verdict_of("gpt-5.6-luna");
        assert_eq!(custom["state"], json!("needs_input"));
        let clusters = report["clusters"].as_array().unwrap();
        assert!(clusters.len() >= 4, "{clusters:?}");
        assert_eq!(clusters[0]["auto_verdict"]["state"], json!("determined"), "determined clusters come first");
        assert!(clusters.iter().all(|c| c["harness"] != json!("workbuddy")));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 验收审查 iteration 3 列的未覆盖面：`conflict` 必须单列不归因（规格 §2/P3）；
    /// 官方路由 + API key → determined/official_api；官方路由但**没有**账户证据 →
    /// one_question/billing_mode（不能默认订阅）；账户厂商与该行计费方不一致时不套用；
    /// 零 token 组不进列表；网关行按厂商拆簇、簇内数字是各模型之和。
    #[test]
    fn auto_verdict_covers_conflict_api_key_and_cluster_arithmetic() {
        use agent_vitals_provider::{AccountEvidence, EvidenceBasis, PlanKind};
        let home = temp_home("verdict2");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (month_start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-08").unwrap();
        let noon = month_start + 12 * 3_600_000;
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 14)", [],
        ).unwrap();
        let insert = |fact: &str, harness: &str, provider: Option<&str>, model: &str, evidence: &str,
                      pricing: &str, uncached: i64, output: i64, ts: i64| {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                     billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 'sess', ?1, 'token_count', ?3, ?4, ?5, 0, ?6, ?7, 'metered', ?8, 0, 0, ?9, 'run', 1, 1)",
                rusqlite::params![fact, harness, provider, model, ts, pricing, evidence, uncached, output],
            ).unwrap();
        };
        // 冲突事实：执行环境自报 openai，但会话路由证据指向别家（emitter 真会这么写）。
        insert("f-conflict", "codex", Some("openai"), "gpt-5.6-sol", "conflict", "metered_estimate", 1000, 10, noon);
        // 官方路由 + API key 账户 → 官方 API 按量（determined，不是订阅）。换一个执行环境：
        // claude-code 的账户是订阅，套不上 ApiKey 分支。
        insert("f-apikey", "dsh", Some("anthropic"), "claude-haiku-4-5", "session-native", "route-observed", 1000, 10, noon + 1);
        // 官方路由 + 无账户证据 → 只能问计费方式。
        insert("f-no-account", "claude-code", Some("minimax"), "MiniMax-M3", "session-native", "route-observed", 1000, 10, noon + 2);
        // 两个 anthropic 官方模型 → 同一簇，数字相加。
        insert("f-opus", "claude-code", Some("anthropic"), "claude-opus-5", "session-native", "route-observed", 2000, 20, noon + 3);
        insert("f-sonnet", "claude-code", Some("anthropic"), "claude-sonnet-5", "session-native", "route-observed", 3000, 30, noon + 4);
        // 网关式命名、两个不同厂商 → 必须拆成两簇（billing_party 都为空）。
        insert("f-gw-anthropic", "claude-code", None, "anthropic/claude-opus-5", "inferred", "metered_estimate", 4000, 40, noon + 5);
        insert("f-gw-zhipu", "claude-code", None, "openrouter/glm-5.3-flash", "inferred", "metered_estimate", 5000, 50, noon + 6);
        // 零 token 组不进列表。
        insert("f-zero", "claude-code", None, "gpt-5.6-luna", "missing", "metered_estimate", 0, 0, noon + 7);
        // 弱于会话级的证据不能当「官方路由」：`account-time-bound`(6) / `config-time-bound`(5)
        // 都低于 §2 要求的 `SessionNative`。谁把它们放回 `ROUTE_KNOWN_OFFICIAL`，这两行就会从
        // 「问计费方式」变成一键订阅（验收审查 iteration 4 #3）。
        insert("f-config-bound", "claude-code", Some("anthropic"), "claude-opus-4-1", "config-time-bound", "route-observed", 1000, 10, noon + 8);
        insert("f-account-bound", "claude-code", Some("anthropic"), "claude-3-7-sonnet", "account-time-bound", "route-observed", 1000, 10, noon + 9);
        let mut accounts = std::collections::BTreeMap::new();
        // claude-code 的账户是 anthropic 订阅；minimax 那行没有账户证据，不套用。
        accounts.insert("claude-code".to_string(), AccountEvidence {
            harness: "claude-code".into(), vendor: "anthropic".into(), plan_kind: PlanKind::Subscription,
            plan_label: Some("Claude Pro".into()), billing_channel: None, anchor_date: Some("2025-07-20".into()),
            evidence_basis: EvidenceBasis::AccountTimeBound, source: "test".into(),
        });
        // 官方路由 + API key 账户 → 官方 API 按量：这是"API key 不是订阅"的唯一出处。
        accounts.insert("dsh".to_string(), AccountEvidence {
            harness: "dsh".into(), vendor: "anthropic".into(), plan_kind: PlanKind::ApiKey,
            plan_label: None, billing_channel: None, anchor_date: None,
            evidence_basis: EvidenceBasis::AccountTimeBound, source: "test".into(),
        });
        // codex 登录的是 openai 但事实是冲突：既不能 determined，也不能拿到 ChatGPT 套餐。
        accounts.insert("codex".to_string(), AccountEvidence {
            harness: "codex".into(), vendor: "openai".into(), plan_kind: PlanKind::Subscription,
            plan_label: Some("ChatGPT".into()), billing_channel: None, anchor_date: None,
            evidence_basis: EvidenceBasis::AccountTimeBound, source: "test".into(),
        });
        let report = confirmation_groups_with(&db, "2026-08", &accounts, &Default::default());
        let groups = report["groups"].as_array().unwrap();
        assert!(!groups.iter().any(|g| g["model_id"] == json!("gpt-5.6-luna")), "zero-token group must not be pending");
        let verdict_of = |model: &str| groups.iter().find(|g| g["model_id"] == json!(model)).unwrap()["auto_verdict"].clone();
        let conflict = verdict_of("gpt-5.6-sol");
        assert_eq!((conflict["state"].clone(), conflict["route_state"].clone(), conflict["billing_party"].clone()),
            (json!("needs_input"), json!("conflict"), json!(null)),
            "conflict evidence must be neither determined nor attributed to a billing party: {conflict}");
        assert_eq!(conflict["plan"], json!(null));
        assert_eq!(conflict["basis"], json!(["route.conflict"]));
        let api_key = verdict_of("claude-haiku-4-5");
        assert_eq!((api_key["state"].clone(), api_key["relationship_kind"].clone(), api_key["billing_mode"].clone()),
            (json!("determined"), json!("official_api"), json!("metered")),
            "an official route with an API-key account is official API, never a subscription: {api_key}");
        for model in ["claude-opus-4-1", "claude-3-7-sonnet"] {
            let weak = verdict_of(model);
            assert_eq!(weak["state"], json!("one_question"),
                "evidence weaker than session-native must never produce a determined verdict: {model} -> {weak}");
            assert_ne!(weak["route_state"], json!("official"), "{model} must not count as an official route");
        }
        let no_account = verdict_of("MiniMax-M3");
        assert_eq!((no_account["state"].clone(), no_account["question"].clone()),
            (json!("one_question"), json!("billing_mode")),
            "official route without account evidence must ask, never default to subscription");
        let clusters = report["clusters"].as_array().unwrap();
        let gateway: Vec<&Value> = clusters.iter()
            .filter(|c| c["auto_verdict"]["route_state"] == json!("gateway")).collect();
        assert_eq!(gateway.len(), 2, "gateway rows split by model_vendor: {clusters:?}");
        let vendors: Vec<&Value> = gateway.iter().map(|c| &c["model_vendor"]).collect();
        assert!(vendors.contains(&&json!("anthropic")) && vendors.contains(&&json!("zhipu-glm")), "{vendors:?}");
        // 同一簇：数字与模型清单是各模型之和 / 之并。
        let claude_family = clusters.iter()
            .find(|c| c["models"].as_array().unwrap().iter().any(|m| m["model_id"] == json!("claude-opus-5")))
            .unwrap();
        assert_eq!(claude_family["models"].as_array().unwrap().len(), 2, "same-vendor official rows fold into one cluster");
        assert_eq!(claude_family["group_ids"].as_array().unwrap().len(), 2);
        let model_tokens: i64 = claude_family["models"].as_array().unwrap().iter()
            .map(|m| m["tokens"].as_i64().unwrap()).sum();
        assert_eq!(claude_family["tokens"], json!(model_tokens), "cluster tokens are the sum of its models");
        // 金额按 (currency, basis) 逐槽相加，与逐模型之和一致。
        let mut expected: std::collections::BTreeMap<(String, String), i64> = std::collections::BTreeMap::new();
        for model in claude_family["models"].as_array().unwrap() {
            for row in model["estimated_amounts"].as_array().unwrap() {
                let key = (row["currency"].as_str().unwrap().to_string(), row["basis"].as_str().unwrap().to_string());
                *expected.entry(key).or_insert(0) += row["amount_minor"].as_i64().unwrap();
            }
        }
        let merged: std::collections::BTreeMap<(String, String), i64> = claude_family["estimated_amounts"].as_array().unwrap().iter()
            .map(|row| ((row["currency"].as_str().unwrap().to_string(), row["basis"].as_str().unwrap().to_string()),
                        row["amount_minor"].as_i64().unwrap())).collect();
        assert_eq!(merged, expected, "cluster amounts merge per currency+basis");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A12（端点/配置证据）：claude-code 的会话日志**不记**端点，只有 `~/.claude/settings.json`
    /// 的 `ANTHROPIC_BASE_URL` 记。基址不是该厂商官方端点 → 判 `relay_config`：计费方是
    /// 中转的注册域、依据 `config.endpoint`、状态仍是 `one_question`（config-current 只有
    /// 强度 4，只能把"官方还是中转"变成一次确认，永远不能单独判 determined）。基址**是**
    /// 官方端点时不能凭空造出中转。
    #[test]
    fn relay_config_endpoint_is_evidence_not_a_verdict() {
        use agent_vitals_provider::{AccountEvidence, EvidenceBasis};
        let home = temp_home("relay");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (month_start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-08").unwrap();
        let noon = month_start + 12 * 3_600_000;
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 14)", [],
        ).unwrap();
        let insert = |fact: &str, harness: &str, model: &str, evidence: &str, ts: i64| {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                     billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 'm', 'sess', ?1, 'token_count', NULL, ?3, ?4, 0, 'metered_estimate', ?5, 'metered', 1000, 0, 0, 10, 'run', 1, 1)",
                rusqlite::params![fact, harness, model, ts, evidence],
            ).unwrap();
        };
        insert("f-relay", "claude-code", "deepseek-v4-flash", "inferred", noon);
        insert("f-official-endpoint", "claude-code", "deepseek-v4-pro", "inferred", noon + 1);
        // 官方形状（执行环境 provider + session-native）与"配置指向中转"可以同时成立——
        // 中转代理 Anthropic 时会原样保留 req_01/msg_01 形状。
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                 billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f-official-shape', 'claude-code', 'm', 'sess', 'f-official-shape', 'token_count',
                     'anthropic', 'claude-opus-5', ?1, 0, 'route-observed', 'session-native', 'metered', 1000, 0, 0, 10, 'run', 1, 1)",
            rusqlite::params![noon + 2],
        ).unwrap();
        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert("claude-code".to_string(), agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence {
            harness: "claude-code".to_string(),
            base_url: Some("https://router.shengsuanyun.com/api".to_string()),
            endpoint_host: Some("router.shengsuanyun.com".to_string()),
            endpoint_hostnames: vec!["router.shengsuanyun.com".to_string()],
            model_endpoints: Default::default(),
            per_model_config: false,
            provider_name: None,
            gateway_named_models: vec!["deepseek/deepseek-v4-pro-0813".to_string()],
            timeline: Vec::new(),
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source: "~/.claude/settings.json env".to_string(),
        });
        let accounts: std::collections::BTreeMap<String, AccountEvidence> = std::collections::BTreeMap::new();
        let report = confirmation_groups_with(&db, "2026-08", &accounts, &endpoints);
        let groups = report["groups"].as_array().unwrap();
        let verdict_of = |model: &str| groups.iter().find(|g| g["model_id"] == json!(model)).unwrap()["auto_verdict"].clone();
        let relay = verdict_of("deepseek-v4-flash");
        assert_eq!(relay["route_state"], json!("relay_config"), "{relay}");
        assert_eq!(relay["billing_party"], json!("shengsuanyun.com"), "billing party is the relay's registrable domain");
        assert_eq!(relay["config_endpoint"], json!("router.shengsuanyun.com"));
        assert_eq!(relay["state"], json!("one_question"), "config-current can never determine on its own");
        assert_eq!(relay["question"], json!("route"));
        assert_eq!(relay["billing_mode"], json!("metered"));
        assert!(relay["basis"].as_array().unwrap().contains(&json!("config.endpoint")), "{relay}");
        // 官方形状与会话级证据都压不过配置：判定不变（强证据不被弱证据推翻），
        // 但矛盾必须以 `config.endpoint.conflict` 出现在依据里（P5 冲突不吞）。
        let official_shape = verdict_of("claude-opus-5");
        assert_eq!(official_shape["route_state"], json!("official"), "strong evidence is not overridden by config: {official_shape}");
        assert!(official_shape["basis"].as_array().unwrap().contains(&json!("config.endpoint.conflict")), "{official_shape}");
        assert_eq!(official_shape["config_endpoint"], json!("router.shengsuanyun.com"));
        // 配置里列了多个端点（workbuddy 本机就配了三个）：只说"里面有中转"，不替用户挑一个
        // ——计费方留空、依据记 `config.endpoint.multiple`（验收审查 iteration 5 #5）。
        let multi = agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence {
            harness: "claude-code".to_string(),
            base_url: Some("https://a.example-relay.com/x".to_string()),
            endpoint_host: Some("a.example-relay.com".to_string()),
            endpoint_hostnames: vec!["a.example-relay.com".to_string(), "b.example-relay.com".to_string()],
            model_endpoints: Default::default(),
            per_model_config: false,
            provider_name: None,
            gateway_named_models: Vec::new(),
            timeline: Vec::new(),
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source: "test".to_string(),
        };
        let mut multi_endpoints = std::collections::BTreeMap::new();
        multi_endpoints.insert("claude-code".to_string(), multi);
        let multi_report = confirmation_groups_with(&db, "2026-08", &accounts, &multi_endpoints);
        let multi_verdict = multi_report["groups"].as_array().unwrap().iter()
            .find(|g| g["model_id"] == json!("deepseek-v4-flash")).unwrap()["auto_verdict"].clone();
        assert_eq!(multi_verdict["route_state"], json!("relay_config"), "{multi_verdict}");
        assert_eq!(multi_verdict["billing_party"], json!(null), "never pick one of several configured relays");
        assert!(multi_verdict["basis"].as_array().unwrap().contains(&json!("config.endpoint.multiple")), "{multi_verdict}");
        // 验收审查 iteration 7 #1：**厂商未知时"官方端点"无从谈起**——不能把配置里的
        // 每个端点都算成中转（旧写法会把 `api.anthropic.com` 说成中转名并写进声明）。
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                 billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f-unknown-vendor', 'claude-code', 'm', 'sess', 'f-unknown-vendor', 'token_count',
                     NULL, 'llama-4-70b', ?1, 0, 'metered_estimate', 'missing', 'metered', 1000, 0, 0, 10, 'run', 1, 1)",
            rusqlite::params![noon + 4],
        ).unwrap();
        let unknown = confirmation_groups_with(&db, "2026-08", &accounts, &endpoints)["groups"]
            .as_array().unwrap().iter()
            .find(|g| g["model_id"] == json!("llama-4-70b")).unwrap()["auto_verdict"].clone();
        assert_eq!(unknown["route_state"], json!("unknown"),
            "an unrecognised model vendor makes 'official endpoint' undefined — no relay claim: {unknown}");
        assert_eq!(unknown["billing_party"], json!(null));
        assert!(!unknown["basis"].as_array().unwrap().contains(&json!("config.endpoint")), "{unknown}");
        // 经中转时计费方是中转，**不能落回执行环境自报的模型厂商**（验收审查 iteration 5 #2：
        // 旧写法会产出"经中转 · 计费方=minimax"这种自相矛盾的行）。
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                 observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                 billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                 ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f-reported-relay', 'claude-code', 'm', 'sess', 'f-reported-relay', 'token_count',
                     'minimax', 'MiniMax-M3', ?1, 0, 'metered_estimate', 'missing', 'metered', 1000, 0, 0, 10, 'run', 1, 1)",
            rusqlite::params![noon + 3],
        ).unwrap();
        let reported = confirmation_groups_with(&db, "2026-08", &accounts, &endpoints)["groups"]
            .as_array().unwrap().iter()
            .find(|g| g["model_id"] == json!("MiniMax-M3")).unwrap()["auto_verdict"].clone();
        assert_eq!(reported["route_state"], json!("relay_config"), "{reported}");
        assert_eq!(reported["billing_party"], json!("shengsuanyun.com"),
            "the payer is the relay, never the harness-reported model vendor: {reported}");
        // 验收审查 iteration 7 #2：官方与中转**混着配**时不猜也不装作没看见——留依据、不给断言。
        let mixed = agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence {
            harness: "claude-code".to_string(),
            base_url: Some("https://api.minimaxi.com/v1".to_string()),
            endpoint_host: Some("api.minimaxi.com".to_string()),
            endpoint_hostnames: vec!["api.minimaxi.com".to_string(), "alpha-relay.example".to_string()],
            model_endpoints: Default::default(),
            per_model_config: false,
            provider_name: None,
            gateway_named_models: Vec::new(),
            timeline: Vec::new(),
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source: "test".to_string(),
        };
        let mut mixed_endpoints = std::collections::BTreeMap::new();
        mixed_endpoints.insert("claude-code".to_string(), mixed);
        let mixed_verdict = confirmation_groups_with(&db, "2026-08", &accounts, &mixed_endpoints)["groups"]
            .as_array().unwrap().iter()
            .find(|g| g["model_id"] == json!("MiniMax-M3")).unwrap()["auto_verdict"].clone();
        assert_ne!(mixed_verdict["route_state"], json!("relay_config"),
            "an official and a relay endpoint side by side is not a relay assertion: {mixed_verdict}");
        assert!(mixed_verdict["basis"].as_array().unwrap().contains(&json!("config.endpoint.ambiguous")), "{mixed_verdict}");
        // 验收审查 iteration 7 #2 的另一半：**逐模型**端点优先于执行环境级列表（workbuddy/pi 的形状）。
        // 夹具配一个**真实可达**的执行环境：只有 pi/workbuddy 会产出 `model_endpoints` +
        // `per_model_config: true`（claude/codex/dsh 恒为执行环境级），而 workbuddy 被
        // `credits_only` 摘掉，所以用 pi（它没有注册人格 → NEUTRAL，正好也走通用路径）。
        // 配置侧的键全是带前缀的（真机 pi store 也有）；"裸 id"出现在**事实**侧
        // （`f-pi-deepseek` 是 `deepseek-v4-flash`），用来钉最后一段匹配。
        insert("f-pi-deepseek", "pi", "deepseek-v4-flash", "inferred", noon + 5);
        insert("f-pi-orphan", "pi", "deepseek-v4-flash-0731", "inferred", noon + 6);
        insert("f-pi-minimax", "pi", "MiniMax-M3", "inferred", noon + 7);
        insert("f-pi-deepseek-pro", "pi", "deepseek/deepseek-v4-pro-0813", "inferred", noon + 8);
        let per_model = agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence {
            harness: "pi".to_string(),
            base_url: Some("https://api.minimaxi.com/v1".to_string()),
            endpoint_host: Some("api.minimaxi.com".to_string()),
            // 真机 workbuddy 文件里就是三个端点（含官方与两个中转）。
            endpoint_hostnames: vec!["api.minimaxi.com".to_string(), "beta-router.shengsuanyun.com".to_string(),
                "router.shengsuanyun.com".to_string()],
            model_endpoints: [
                // 带前缀的键 + **官方**端点：前缀不该把官方端点说成中转（iteration 9 #2）。
                ("minimax/MiniMax-M3".to_string(), "api.minimaxi.com".to_string()),
                ("deepseek/deepseek-v4-flash".to_string(), "beta-router.shengsuanyun.com".to_string()),
                ("deepseek/deepseek-v4-pro-0813".to_string(), "router.shengsuanyun.com".to_string()),
            ].into_iter().collect(),
            per_model_config: true,
            // read_pi 恒会填 provider 名（`Some(first key)`），夹具照它写。
            provider_name: Some("openai-codex".to_string()),
            // 真机形状：`observe_model` 会把**每个**带 `/` 的 id 收进来，而上面三条
            // `model_endpoints` 的键就是那三个 id —— 所以能产出那些端点的文件必然产出
            // 这三条。这条列表**不是**对全执行环境的陈述，拿它给 MiniMax 下结论就是
            // iteration 8 #1 抓到的缺陷（`per_model_config` 下判定器根本不读它）。
            gateway_named_models: vec![
                "deepseek/deepseek-v4-flash".to_string(),
                "deepseek/deepseek-v4-pro-0813".to_string(),
                "minimax/MiniMax-M3".to_string(),
            ],
            timeline: Vec::new(),
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source: "test".to_string(),
        };
        let mut pm_endpoints = std::collections::BTreeMap::new();
        pm_endpoints.insert("pi".to_string(), per_model);
        let pm_report = confirmation_groups_with(&db, "2026-08", &accounts, &pm_endpoints);
        let pm_groups = pm_report["groups"].as_array().unwrap();
        let report_cluster_of = |report: &Value, harness: &str, model: &str| -> Value {
            report["clusters"].as_array().unwrap().iter()
                .find(|c| c["harness"] == json!(harness)
                    && c["models"].as_array().is_some_and(|ms| ms.iter().any(|m| m["model_id"] == json!(model))))
                .cloned().unwrap()
        };
        let pi_verdict = |model: &str| pm_groups.iter()
            .find(|g| g["harness"] == json!("pi") && g["model_id"] == json!(model)).unwrap()["auto_verdict"].clone();
        let minimax = pi_verdict("MiniMax-M3");
        assert_ne!(minimax["route_state"], json!("relay_config"),
            "the per-model endpoint for MiniMax is its official one: {minimax}");
        assert_eq!(minimax["config_endpoint"], json!("api.minimaxi.com"),
            "the displayed endpoint is the one the verdict used: {minimax}");
        // 事实里的模型名是上游裸名、配置里的键带前缀 → 按最后一段匹配（真机就是这个形状）。
        let deepseek = pi_verdict("deepseek-v4-flash");
        assert_eq!(deepseek["route_state"], json!("relay_config"), "{deepseek}");
        assert_eq!(deepseek["billing_party"], json!("shengsuanyun.com"),
            "the per-model endpoint names the relay exactly: {deepseek}");
        assert_eq!(deepseek["config_endpoint"], json!("beta-router.shengsuanyun.com"),
            "the displayed endpoint must be the per-model one, not the first configured harness: {deepseek}");
        // 验收审查 iteration 9 #1/#3：配置表里**没有**这条模型时，逐模型配置对它就毫无证据——
        // 不能拿"某些模型的端点"下结论，也不能把第一个配置的端点冒充成它的（`hy3`/`glm-5.2`
        // 这类模型在真机就是这样）。
        // 验收审查 iteration 10 #1：簇级字段只在成员一致时才敢沿用第一个的。两条 deepseek
        // 模型各自配了不同中转（beta-router / router），它们的组判定都对，但**簇**不能
        // 拿第一个的端点当作整行的。
        let pi_relay_cluster = report_cluster_of(&pm_report, "pi", "deepseek/deepseek-v4-pro-0813");
        assert_eq!(pi_relay_cluster["auto_verdict"]["config_endpoint"], json!(null),
            "a cluster whose members use different endpoints must not display one of them: {pi_relay_cluster}");
        assert!(pi_relay_cluster["auto_verdict"]["basis"].as_array().unwrap()
            .contains(&json!("config.endpoint.mixed")), "{pi_relay_cluster}");
        let orphan = pi_verdict("deepseek-v4-flash-0731");
        assert_ne!(orphan["route_state"], json!("relay_config"),
            "a model absent from a per-model config has no endpoint evidence: {orphan}");
        assert_eq!(orphan["config_endpoint"], json!(null),
            "never display another model's endpoint as this one's: {orphan}");
        assert!(orphan["basis"].as_array().unwrap().is_empty() || !orphan["basis"].as_array().unwrap().iter().any(|b| b.as_str().unwrap_or("").starts_with("config.")),
            "{orphan}");
        // 配置是整个执行环境一份的（这是"当前配置"的语义，不是逐条的），所以同一执行环境下
        // 另一个 deepseek 组同样是 relay_config——这正是我们要的：它不逐模型乱猜。
        assert_eq!(verdict_of("deepseek-v4-pro")["route_state"], json!("relay_config"));
        // 反过来：基址就是该厂商的官方端点时，不能凭空造出中转（同库换一份配置重跑）。
        let official = agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence {
            harness: "claude-code".to_string(),
            base_url: Some("https://api.deepseek.com".to_string()),
            endpoint_host: Some("api.deepseek.com".to_string()),
            endpoint_hostnames: vec!["api.deepseek.com".to_string()],
            model_endpoints: Default::default(),
            per_model_config: false,
            provider_name: None,
            gateway_named_models: Vec::new(),
            timeline: Vec::new(),
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source: "~/.claude/settings.json env".to_string(),
        };
        let mut official_endpoints = std::collections::BTreeMap::new();
        official_endpoints.insert("claude-code".to_string(), official);
        // 只有前缀证据、没有基址：仍判经中转，但**说不出哪一家**（不猜），计费方留空，
        // 等用户在弹窗里写（用户 2026-09-16：官方不带厂商 id，中转才需要）。
        let prefix_only = agent_vitals_harnesses::sources::endpoint_evidence::EndpointEvidence {
            harness: "claude-code".to_string(),
            base_url: None,
            endpoint_host: None,
            endpoint_hostnames: Vec::new(),
            model_endpoints: Default::default(),
            per_model_config: false,
            provider_name: None,
            gateway_named_models: vec!["deepseek/deepseek-v4.1-flash".to_string()],
            timeline: Vec::new(),
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source: "~/.claude/settings.json env".to_string(),
        };
        let mut prefix_endpoints = std::collections::BTreeMap::new();
        prefix_endpoints.insert("claude-code".to_string(), prefix_only);
        let prefix_report = confirmation_groups_with(&db, "2026-08", &accounts, &prefix_endpoints);
        let prefix_verdict = prefix_report["groups"].as_array().unwrap().iter()
            .find(|g| g["model_id"] == json!("deepseek-v4-flash")).unwrap()["auto_verdict"].clone();
        assert_eq!(prefix_verdict["route_state"], json!("relay_config"), "{prefix_verdict}");
        assert_eq!(prefix_verdict["billing_party"], json!(null), "an unnamed relay is never invented");
        assert_eq!(prefix_verdict["basis"], json!(["config.gateway_named"]));
        assert_eq!(prefix_verdict["state"], json!("one_question"));
        let official_report = confirmation_groups_with(&db, "2026-08", &accounts, &official_endpoints);
        let official_groups = official_report["groups"].as_array().unwrap();
        let official_verdict = official_groups.iter()
            .find(|g| g["model_id"] == json!("deepseek-v4-pro")).unwrap()["auto_verdict"].clone();
        assert_eq!(official_verdict["route_state"], json!("vendor_shape"), "an official endpoint never fabricates a relay: {official_verdict}");
        assert_eq!(official_verdict["billing_party"], json!("deepseek"));
        assert!(!official_verdict["basis"].as_array().unwrap().contains(&json!("config.endpoint")));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn kept_amounts_subtract_per_currency_and_basis_only() {
        let all = vec![
            json!({"amount_minor": 1000, "currency": "USD", "basis": "metered_estimate"}),
            json!({"amount_minor": 500, "currency": "CNY", "basis": "metered_estimate"}),
        ];
        let moved = vec![json!({"amount_minor": 300, "currency": "USD", "basis": "metered_estimate"})];
        let kept = subtract_amounts(&all, &moved);
        assert_eq!(kept, vec![
            json!({"amount_minor": 500, "currency": "CNY", "basis": "metered_estimate"}),
            json!({"amount_minor": 700, "currency": "USD", "basis": "metered_estimate"}),
        ]);
    }

    /// 2026-09-17 真机事故的回归（cc-switch 时间线，`config-time-bound`）：codex 的
    /// `custom` 会话在日志层分不出胜算云与 cogfoundry（rollout 只记 `model_provider =
    /// "custom"`，两家在 cc-switch 里都叫 shengsuanyun），当前 `config.toml` 指向胜算云，
    /// 整月 `custom` 用量就全被建议成胜算云——其中 09-09 的 395 次 gpt-5.6-sol（官方价估
    /// ¥736）胜算云账单上一条都没有。cc-switch 的 `providers.created_at` 给出硬下界：
    /// 胜算云那条 09-11 23:43 才建。钉住三件事：
    /// 1. 整组早于建立时刻（09-09~10 的 luna）→ 胜算云**剔除**、剩下唯一候选 cogfoundry
    ///    成为计费方，行面不再显示一个当时不存在的端点；
    /// 2. 建立时刻落在组的时间窗中间（sol：09-09 三条 + 09-12 一条）→ 标 `partial`，
    ///    `tokens_before` 数出前半段（判定器不替用户切，只把切点带出去）；
    /// 3. 官方形状的用量（provider 自报 + session-native）不因为 cc-switch 里配置过中转
    ///    就多一条 conflict——但当前配置指向的中转若当时不存在，原有的
    ///    `config.endpoint.conflict` 也不再出现。
    #[test]
    fn ccswitch_timeline_excludes_relays_created_after_the_facts() {
        let home = temp_home("ccswitch-timeline");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        let db = AuthorityDb::open(&path, 1).unwrap();
        let (month_start, _) = agent_vitals_data::authority_query::beijing_month_bounds_ms("2026-09").unwrap();
        let at = |day: i64, hour: i64| month_start + (day - 1) * 86_400_000 + hour * 3_600_000;
        // 真机：胜算云（网关）created_at = 2026-09-11 23:43:36 北京时间。
        let ssy_created = at(11, 23) + 43 * 60_000 + 36_000;
        let cog_created = at(8, 18) + 20 * 60_000;
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
             VALUES ('run', 1, 'cli', 'succeeded', 13) ON CONFLICT(run_id) DO NOTHING", [],
        ).unwrap();
        let custom = |fact_id: &str, model: &str, ts: i64, tokens: i64| {
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, source_event_id,
                     observation_kind, provider_id, model_id, event_ts_ms, event_peak, pricing_basis, evidence_basis,
                     billing_mode, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES (?1, 'codex', 'm', 'sess', ?1, 'token_count', NULL, ?2, ?3, 0, 'metered_estimate', 'missing',
                     'metered', ?4, 0, 0, 0, 'run', 1, 1)",
                rusqlite::params![fact_id, model, ts, tokens],
            ).unwrap();
        };
        custom("luna-0909", "openai/gpt-5.6-luna", at(9, 11), 1000);
        custom("luna-0910", "openai/gpt-5.6-luna", at(10, 15), 1000);
        custom("sol-0909-a", "openai/gpt-5.6-sol", at(9, 11), 1000);
        custom("sol-0909-b", "openai/gpt-5.6-sol", at(9, 12), 1000);
        custom("sol-0909-c", "openai/gpt-5.6-sol", at(9, 13), 1000);
        custom("sol-0912", "openai/gpt-5.6-sol", at(12, 10), 100);
        // 官方形状（ChatGPT 订阅路径）：provider 自报 openai + session-native，09-09。
        seed_codex_fact(&db, "official-0909", "gpt-5.6-luna", at(9, 9), 500, 5);

        use agent_vitals_harnesses::sources::endpoint_evidence::{EndpointEvidence, RelayRecord};
        use agent_vitals_provider::{AccountEvidence, EvidenceBasis};
        let mut endpoints = std::collections::BTreeMap::new();
        endpoints.insert("codex".to_string(), EndpointEvidence {
            harness: "codex".to_string(),
            // 当前 config.toml 指向胜算云（同步那一刻的配置）。
            base_url: Some("https://router.shengsuanyun.com/api/v1".to_string()),
            endpoint_host: Some("router.shengsuanyun.com".to_string()),
            endpoint_hostnames: vec!["router.shengsuanyun.com".to_string()],
            model_endpoints: Default::default(),
            per_model_config: false,
            provider_name: None,
            gateway_named_models: Vec::new(),
            timeline: vec![
                RelayRecord { endpoint_host: "router.cogfoundry.ai".to_string(), label: "DeepSeek".to_string(),
                    created_at_ms: Some(cog_created), is_current: false, active_at_ms: vec![at(9, 15)] },
                RelayRecord { endpoint_host: "router.shengsuanyun.com".to_string(), label: "胜算云（网关）".to_string(),
                    created_at_ms: Some(ssy_created), is_current: true, active_at_ms: vec![at(12, 15)] },
            ],
            evidence_basis: EvidenceBasis::ConfigCurrent,
            source: "~/.codex/config.toml + ~/.cc-switch/cc-switch.db".to_string(),
        });
        let accounts: std::collections::BTreeMap<String, AccountEvidence> = std::collections::BTreeMap::new();
        let report = confirmation_groups_with(&db, "2026-09", &accounts, &endpoints);
        let groups = report["groups"].as_array().unwrap();
        let verdict_of = |model: &str| groups.iter().find(|g| g["model_id"] == json!(model)).unwrap()["auto_verdict"].clone();
        let relation = |v: &Value, harness: &str| v["config_timeline"].as_array().unwrap().iter()
            .find(|t| t["endpoint_host"] == json!(harness)).cloned().expect("timeline entry");

        // 1. 整组早于胜算云建立 → 剔除；cogfoundry 成为唯一候选与计费方。
        let luna = verdict_of("openai/gpt-5.6-luna");
        assert_eq!(relation(&luna, "router.shengsuanyun.com")["relation"], json!("excluded"), "{luna}");
        assert_eq!(relation(&luna, "router.cogfoundry.ai")["relation"], json!("possible"));
        assert_eq!(luna["route_state"], json!("relay_config"));
        assert_eq!(luna["billing_party"], json!("cogfoundry.ai"), "the surviving relay is the billing party: {luna}");
        assert_eq!(luna["config_endpoint"], json!("router.cogfoundry.ai"),
            "never display the excluded live endpoint as if these facts went through it");
        let basis = luna["basis"].as_array().unwrap();
        assert!(basis.contains(&json!("config.timeline.excluded")) && basis.contains(&json!("config.timeline")), "{basis:?}");
        assert!(!basis.contains(&json!("config.endpoint.multiple")), "one candidate left → not multiple: {basis:?}");

        // 2. 建立时刻落在窗口中间 → partial，前半段的 3 条 / 3000 tokens 数出来；两家都是候选。
        let sol = verdict_of("openai/gpt-5.6-sol");
        let ssy = relation(&sol, "router.shengsuanyun.com");
        assert_eq!(ssy["relation"], json!("partial"), "{sol}");
        assert_eq!(ssy["facts_before"], json!(3));
        assert_eq!(ssy["tokens_before"], json!(3000));
        assert_eq!(sol["billing_party"], json!(null), "two candidates → the judge does not pick: {sol}");
        let basis = sol["basis"].as_array().unwrap();
        assert!(basis.contains(&json!("config.endpoint.multiple")) && basis.contains(&json!("config.timeline.partial")), "{basis:?}");

        // 3. 官方形状：时间线不补候选（无 `config.timeline`），且当前配置的中转当时不存在 →
        //    不再报 `config.endpoint.conflict`。
        let official = verdict_of("gpt-5.6-luna");
        assert_eq!(official["route_state"], json!("official"));
        let basis = official["basis"].as_array().unwrap();
        assert!(!basis.contains(&json!("config.endpoint.conflict")), "{basis:?}");
        assert!(!basis.contains(&json!("config.timeline")), "{basis:?}");
        assert!(basis.contains(&json!("config.timeline.excluded")), "the exclusion itself stays visible: {basis:?}");

        // 簇级：luna 与 sol 的 route_state/计费方不同，本就分簇；簇的 config_timeline 与成员一致。
        let clusters = report["clusters"].as_array().unwrap();
        let luna_cluster = clusters.iter().find(|c| c["billing_party"] == json!("cogfoundry.ai")).expect("luna cluster");
        assert_eq!(relation(&luna_cluster["auto_verdict"], "router.shengsuanyun.com")["relation"], json!("excluded"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 2026-09-17 数据分析师视角审查发现的问题：旧版"取最弱"（possible > partial >
    /// excluded）会在同簇多模型场景下把已经证明的排除信号整个抹掉——模型甲对候选中转
    /// A 全部 tokens 都排除（excluded），模型乙对 A 没有排除证据（possible），旧逻辑
    /// 合并成 `possible`，等于向用户谎称"这一行对 A 完全没有排除证据"，而实际上甲那
    /// 部分 token 确实证明过排除。正确的合并：只有全体成员都排除才敢说整行 `excluded`；
    /// 只要有一个成员证明过排除就至少是 `partial`（行里确有一部分被排除，不是全部）；
    /// 都没有排除证据才是 `possible`。
    #[test]
    fn merge_timeline_keeps_partial_exclusion_visible() {
        let mut into = json!([
            { "endpoint_host": "router.a.com", "relation": "excluded", "tokens_before": 3000, "facts_before": 3 },
        ]);
        let from = json!([{ "endpoint_host": "router.a.com", "relation": "possible" }]);
        merge_timeline(&mut into, &from);
        let rows = into.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["relation"], json!("partial"),
            "excluded+possible must not collapse to possible — that erases a proven exclusion: {rows:?}");
        assert_eq!(rows[0]["tokens_before"], json!(3000), "possible 一侧没有 tokens_before，求和保留已知一侧");

        // 全体都排除 → 对整行成立才敢说 excluded；tokens_before 累加。
        let mut both_excluded = json!([
            { "endpoint_host": "router.a.com", "relation": "excluded", "tokens_before": 3000, "facts_before": 3 },
        ]);
        let more_excluded = json!([{ "endpoint_host": "router.a.com", "relation": "excluded", "tokens_before": 500, "facts_before": 1 }]);
        merge_timeline(&mut both_excluded, &more_excluded);
        let rows = both_excluded.as_array().unwrap();
        assert_eq!(rows[0]["relation"], json!("excluded"));
        assert_eq!(rows[0]["tokens_before"], json!(3500));

        // excluded + partial → partial（partial 本身已经是"部分排除"，与 excluded 合并
        // 不会变得比 partial 更弱）。
        let mut with_partial = json!([
            { "endpoint_host": "router.a.com", "relation": "excluded", "tokens_before": 3000, "facts_before": 3 },
        ]);
        let partial = json!([{ "endpoint_host": "router.a.com", "relation": "partial", "tokens_before": 100, "facts_before": 1 }]);
        merge_timeline(&mut with_partial, &partial);
        assert_eq!(with_partial.as_array().unwrap()[0]["relation"], json!("partial"));

        // 都没有排除证据 → possible。
        let mut both_possible = json!([{ "endpoint_host": "router.a.com", "relation": "possible" }]);
        merge_timeline(&mut both_possible, &json!([{ "endpoint_host": "router.a.com", "relation": "possible" }]));
        assert_eq!(both_possible.as_array().unwrap()[0]["relation"], json!("possible"));
    }
}
