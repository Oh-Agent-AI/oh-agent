//! 宿主侧规则复算器（City SDK V3 S-6b，RFC §8 S-6 / §9 V3-16 的最小可验收路径）。
//!
//! 语义权威是 `packages/agent-vitals-city-sdk/src/runtime.ts` 的 TS 规则求值器
//! （`createRun`/`dispatch` 子集）。本模块把它逐语义镜像为宿主侧纯函数，供
//! `creator_playtest::finish_playtest` 对 client 自报 evidence 做独立裁决：
//! 完全一致 → 注记 host-verified；不一致 → 注记 hostDisagreement 供审计；
//! 输入非法或规则含复算器不支持的形状 → Err，绝不猜测（fail closed）。
//!
//! 镜像子集（与 TS dispatch 一致）：
//! - 事件：`run.started`（tick 0 恰好一次）、`zone.entered`（来自轨迹）、
//!   `timer.expired`（宿主计时器到点，先于同 tick 的输入事件）。
//! - 守卫：`counter.eq`（字面量或参数引用）、`counter.eqEventIndex`（只对输入事件成立）。
//! - 动作：`counter.add`（带 max 预算，越界按 TS 语义整步回滚并停机）、`timer.start`
//!   （参数形态只接受 timeLimitTicks → 使用传入的 time_limit_ticks）、`hud.hint`
//!   （提示不影响 verdict）、`run.finish`（定格 outcome）。
//! - 参数引用一律解析 `integerParameters[P].default`；调用方负责把选中 mount 的
//!   parameterOverrides 合并进 default（等价 TS 的 overrides ?? default 次序）。
//!
//! 与 TS 的两处有意分歧，都是收紧、不放松：
//! 1. `item.collected` 节点 → Err。TS 支持它，但宿主复算轨迹（ReplayEventV1）没有
//!    该事件源；City 可视运行时本身也拒绝 item.collected 包（creatorMiniGame.ts 的
//!    plan 闸），所以 Err 不会误伤合法试玩证据。
//! 2. 轨迹事件耗尽后按 (due, id) 序继续触发剩余计时器。这不是新语义：TS 的 run 由
//!    调用方逐 tick 驱动，client 的规则 run 在最后一条轨迹事件之后仍继续空转到终局
//!    （超时失败就是这样产生的），宿主复算补上这些无输入的虚拟步才能重现同一 verdict。
use serde_json::Value;
use std::collections::BTreeMap;

/// 轨迹事件条数上限（与 TS step 的 inputs ≤ 64 同源）。
pub const MAX_REPLAY_EVENTS: usize = 64;
/// 轨迹 tick 上限（对齐 creator_playtest 的 MAX_PLAYTEST_TICKS 证据预算）。
pub const MAX_REPLAY_TICKS: u64 = 2_000_000;

/// 复算轨迹里的单条输入事件（TS PlayerRuleInputV1 的 zone.entered 子集）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayEventV1 {
    pub slot: String,
    pub event_index: u64,
    pub at_tick: u64,
}

/// 宿主复算结论：定格 outcome（None = 未定格，与 TS snapshot().outcome 的 null 同义）
/// 加全部声明计数器的终值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayVerdict {
    pub outcome: Option<&'static str>,
    pub counters: BTreeMap<String, i64>,
}

/// TS runtime 的 RULE_ID / content.ts 的 IDENTIFIER（三处同一条正则）：
/// /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
fn valid_rule_id(value: &str) -> bool {
    let mut chars = value.chars();
    if !matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric()) { return false; }
    value.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn has_only_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

/// 有界整数（content.ts 的 integer(value, min, max)：安全整数且落在闭区间）。
fn integer_in(value: Option<&Value>, min: i64, max: i64) -> Result<i64, &'static str> {
    value.and_then(Value::as_i64).filter(|value| (min..=max).contains(value)).ok_or("rule_replay_rules_invalid")
}

/// 参数引用解析：integerParameters[P].default（默认值本身受 [0, 1e6] 有界约束）。
/// 未声明或形态不对 → Err（TS 在运行时对此抛错并回滚整步；宿主在解析期就拒绝，
/// 不给坏包出宿主 verdict 的机会）。
fn parameter_default(parameters: Option<&serde_json::Map<String, Value>>, name: &str) -> Result<i64, &'static str> {
    let spec = parameters.and_then(|parameters| parameters.get(name)).and_then(Value::as_object)
        .filter(|spec| spec.len() == 3 && has_only_keys(spec, &["min", "max", "default"]))
        .ok_or("rule_replay_rules_invalid")?;
    let min = integer_in(spec.get("min"), 0, 1_000_000)?;
    let max = integer_in(spec.get("max"), 0, 1_000_000)?;
    let default = integer_in(spec.get("default"), 0, 1_000_000)?;
    if min > max || default < min || default > max { return Err("rule_replay_rules_invalid"); }
    Ok(default)
}

/// 解析轨迹 JSON（evidence 的可选 trace 字段与 replay 共用同一限制）：
/// 数组 ≤ MAX_REPLAY_EVENTS，每条恰有 kind/slot/eventIndex/atTick 四键，kind 必须是
/// zone.entered，slot 满足 RULE_ID，eventIndex/atTick 有界，且 atTick 非降序——
/// TS 的合法 run 由连续 step 组成，乱序 tick 的轨迹不可能是合法运行的投影。
pub fn parse_trace(value: &Value) -> Result<Vec<ReplayEventV1>, &'static str> {
    const TRACE_INVALID: &str = "rule_replay_trace_invalid";
    let entries = value.as_array().ok_or(TRACE_INVALID)?;
    if entries.len() > MAX_REPLAY_EVENTS { return Err(TRACE_INVALID); }
    let mut trace = Vec::with_capacity(entries.len());
    let mut previous_tick = 0u64;
    for entry in entries {
        let object = entry.as_object().ok_or(TRACE_INVALID)?;
        if object.len() != 4 || !has_only_keys(object, &["kind", "slot", "eventIndex", "atTick"]) { return Err(TRACE_INVALID); }
        if object.get("kind").and_then(Value::as_str) != Some("zone.entered") { return Err(TRACE_INVALID); }
        let slot = object.get("slot").and_then(Value::as_str).filter(|slot| valid_rule_id(slot)).ok_or(TRACE_INVALID)?;
        let event_index = object.get("eventIndex").and_then(Value::as_u64).filter(|index| *index <= u32::MAX as u64).ok_or(TRACE_INVALID)?;
        let at_tick = object.get("atTick").and_then(Value::as_u64).filter(|tick| *tick <= MAX_REPLAY_TICKS).ok_or(TRACE_INVALID)?;
        if at_tick < previous_tick { return Err(TRACE_INVALID); }
        previous_tick = at_tick;
        trace.push(ReplayEventV1 { slot: slot.to_owned(), event_index, at_tick });
    }
    Ok(trace)
}

struct CounterSpec { initial: i64, ceiling: i64 }
enum GuardOp { Eq(i64), EqEventIndex }
struct Guard { counter: String, op: GuardOp }
enum OnEvent { RunStarted, ZoneEntered { slot: String }, TimerExpired { timer_id: String } }
enum ReplayAction {
    CounterAdd { counter: String, amount: i64 },
    TimerStart { timer_id: String, duration: i64 },
    HudHint,
    Finish(&'static str),
}
struct ReplayNode { on: OnEvent, guards: Vec<Guard>, actions: Vec<ReplayAction> }
struct ReplayPack { counters: BTreeMap<String, CounterSpec>, nodes: Vec<ReplayNode> }

/// 解析规则包（release 冻结快照的 game 对象：rules.counters/nodes + slots +
/// integerParameters）。镜像 content.ts validateMiniGamePack + runtime.ts compileRules
/// 对该子集的全部形状/预算约束；任何越出镜像子集的形状 → Err。
fn parse_pack(rules: &Value, time_limit_ticks: u64) -> Result<ReplayPack, &'static str> {
    const RULES_INVALID: &str = "rule_replay_rules_invalid";
    let pack = rules.as_object().ok_or(RULES_INVALID)?;
    // compileRules：schema_unsupported —— 只支持 version 1。
    if pack.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || pack.get("rulesVersion").and_then(Value::as_u64) != Some(1) { return Err(RULES_INVALID); }
    let graph = pack.get("rules").and_then(Value::as_object).filter(|graph| graph.len() == 2 && has_only_keys(graph, &["counters", "nodes"]))
        .ok_or(RULES_INVALID)?;
    let counters_json = graph.get("counters").and_then(Value::as_object).ok_or(RULES_INVALID)?;
    let nodes_json = graph.get("nodes").and_then(Value::as_array).ok_or(RULES_INVALID)?;
    // 规则预算（compileRules）：计数器 ≤ 32、节点 ≤ 128、每节点动作 ≤ 16、守卫 ≤ 8。
    if counters_json.len() > 32 || nodes_json.len() > 128 { return Err(RULES_INVALID); }
    let slots = pack.get("slots").and_then(Value::as_object);
    if let Some(slots) = slots {
        if slots.len() > 32 { return Err(RULES_INVALID); }
    }
    let parameters = pack.get("integerParameters").and_then(Value::as_object);
    if let Some(parameters) = parameters {
        if parameters.len() > 32 { return Err(RULES_INVALID); }
        // 参数表本身全部按 content.ts 的有界形态校验一遍，引用解析才可信。
        for name in parameters.keys() {
            if !valid_rule_id(name) { return Err(RULES_INVALID); }
            parameter_default(Some(parameters), name).map(|_| ())?;
        }
    }
    let mut counters = BTreeMap::new();
    for (name, spec) in counters_json {
        if !valid_rule_id(name) { return Err(RULES_INVALID); }
        let object = spec.as_object().filter(|object| object.len() == 2 && has_only_keys(object, &["initial", "max"])).ok_or(RULES_INVALID)?;
        let initial = integer_in(object.get("initial"), 0, 1_000_000_000)?;
        // max 支持字面量或参数引用（content.ts）：字面量 [0, 1e9] 且 initial ≤ max；
        // 引用必须指向已声明参数，解析为该参数的有效默认值（调用方已合并 override）。
        let max_value = object.get("max").ok_or(RULES_INVALID)?;
        let ceiling = match max_value.as_i64() {
            Some(literal) if (0..=1_000_000_000).contains(&literal) && initial <= literal => literal,
            Some(_) => return Err(RULES_INVALID),
            None => {
                let reference = max_value.as_object().filter(|object| object.len() == 1)
                    .and_then(|object| object.get("parameter")).and_then(Value::as_str)
                    .filter(|name| valid_rule_id(name)).ok_or(RULES_INVALID)?;
                parameter_default(parameters, reference)?
            }
        };
        counters.insert(name.to_owned(), CounterSpec { initial, ceiling });
    }
    let mut nodes = Vec::with_capacity(nodes_json.len());
    for node_json in nodes_json {
        let object = node_json.as_object().ok_or(RULES_INVALID)?;
        // 节点键 ⊆ {id, on, when, actions}（when 可选），id/on/actions 必填；
        // id 只参与校验（唯一性/形状由上游 SDK 闸保证），复算不需要留存。
        if !(3..=4).contains(&object.len()) || !has_only_keys(object, &["id", "on", "when", "actions"])
            || !object.contains_key("id") || !object.contains_key("on") || !object.contains_key("actions") { return Err(RULES_INVALID); }
        object.get("id").and_then(Value::as_str).filter(|id| valid_rule_id(id)).ok_or(RULES_INVALID)?;
        let event = object.get("on").and_then(Value::as_object).ok_or(RULES_INVALID)?;
        let on = match event.get("type").and_then(Value::as_str) {
            // item.collected 显式不在宿主复算词表内（见模块头分歧 1）。
            Some("run.started") if event.len() == 1 => OnEvent::RunStarted,
            Some("zone.entered") if event.len() == 2 && event.contains_key("slot") => {
                let slot = event.get("slot").and_then(Value::as_str).filter(|slot| valid_rule_id(slot)).ok_or(RULES_INVALID)?;
                let kind = slots.and_then(|slots| slots.get(slot)).and_then(Value::as_object)
                    .and_then(|slot| slot.get("kind")).and_then(Value::as_str);
                if kind != Some("zone") { return Err(RULES_INVALID); }
                OnEvent::ZoneEntered { slot: slot.to_owned() }
            }
            Some("timer.expired") if event.len() == 2 && event.contains_key("timerId") => {
                let timer_id = event.get("timerId").and_then(Value::as_str).filter(|id| valid_rule_id(id)).ok_or(RULES_INVALID)?;
                OnEvent::TimerExpired { timer_id: timer_id.to_owned() }
            }
            _ => return Err(RULES_INVALID),
        };
        let guards_json: &[Value] = match object.get("when") {
            None => &[],
            Some(when) => when.as_array().filter(|guards| guards.len() <= 8).ok_or(RULES_INVALID)?,
        };
        let mut guards = Vec::with_capacity(guards_json.len());
        for guard_json in guards_json {
            let guard = guard_json.as_object().ok_or(RULES_INVALID)?;
            let counter = guard.get("counter").and_then(Value::as_str).filter(|name| valid_rule_id(name))
                .filter(|name| counters.contains_key(*name)).ok_or(RULES_INVALID)?.to_owned();
            let op = match guard.get("op").and_then(Value::as_str) {
                // counter.eq：字面量 [0, 1e9] 或已声明参数引用（content.ts 同款校验）。
                Some("counter.eq") => {
                    if guard.len() != 3 || !guard.contains_key("value") { return Err(RULES_INVALID); }
                    let value = guard.get("value").ok_or(RULES_INVALID)?;
                    let target = match value.as_i64() {
                        Some(literal) if (0..=1_000_000_000).contains(&literal) => literal,
                        Some(_) => return Err(RULES_INVALID),
                        None => {
                            let reference = value.as_object().filter(|object| object.len() == 1)
                                .and_then(|object| object.get("parameter")).and_then(Value::as_str)
                                .filter(|name| valid_rule_id(name)).ok_or(RULES_INVALID)?;
                            parameter_default(parameters, reference)?
                        }
                    };
                    GuardOp::Eq(target)
                }
                // counter.eqEventIndex：只允许挂在玩家输入事件节点上（content.ts 同款）。
                Some("counter.eqEventIndex") if guard.len() == 2 && matches!(on, OnEvent::ZoneEntered { .. }) => GuardOp::EqEventIndex,
                _ => return Err(RULES_INVALID),
            };
            guards.push(Guard { counter, op });
        }
        let actions_json = object.get("actions").and_then(Value::as_array).filter(|actions| actions.len() <= 16).ok_or(RULES_INVALID)?;
        let mut actions = Vec::with_capacity(actions_json.len());
        for action_json in actions_json {
            let action = action_json.as_object().ok_or(RULES_INVALID)?;
            let parsed = match action.get("op").and_then(Value::as_str) {
                Some("counter.add") if action.len() == 3 && action.contains_key("counter") && action.contains_key("amount") => {
                    let counter = action.get("counter").and_then(Value::as_str).filter(|name| valid_rule_id(name))
                        .filter(|name| counters.contains_key(*name)).ok_or(RULES_INVALID)?.to_owned();
                    let amount = integer_in(action.get("amount"), -1_000_000, 1_000_000)?;
                    ReplayAction::CounterAdd { counter, amount }
                }
                // 参数形态的 durationTicks 只接受 timeLimitTicks（模块头的镜像边界）：
                // 计时器时长即宿主解析出的有效时限，其它参数名一律 Err 不猜。
                Some("timer.start") if action.len() == 3 && action.contains_key("timerId") && action.contains_key("durationTicks") => {
                    let timer_id = action.get("timerId").and_then(Value::as_str).filter(|id| valid_rule_id(id)).ok_or(RULES_INVALID)?.to_owned();
                    let duration_value = action.get("durationTicks").ok_or(RULES_INVALID)?;
                    let duration = match duration_value.as_i64() {
                        Some(literal) if (1..=1_000_000).contains(&literal) => literal,
                        Some(_) => return Err(RULES_INVALID),
                        None => {
                            if duration_value.as_object().map(|object| object.len()) != Some(1)
                                || duration_value.get("parameter").and_then(Value::as_str) != Some("timeLimitTicks") { return Err(RULES_INVALID); }
                            time_limit_ticks as i64
                        }
                    };
                    ReplayAction::TimerStart { timer_id, duration }
                }
                Some("hud.hint") if action.len() == 2 && action.contains_key("text") => {
                    // 提示文本不影响 verdict；只校验 TS 的 160 字符预算以保持同构。
                    let _text = action.get("text").and_then(Value::as_str).filter(|text| text.chars().count() <= 160).ok_or(RULES_INVALID)?;
                    ReplayAction::HudHint
                }
                Some("run.finish") if action.len() == 2 => {
                    let outcome = match action.get("outcome").and_then(Value::as_str) {
                        Some("success") => "success",
                        Some("failure") => "failure",
                        _ => return Err(RULES_INVALID),
                    };
                    ReplayAction::Finish(outcome)
                }
                _ => return Err(RULES_INVALID),
            };
            actions.push(parsed);
        }
        nodes.push(ReplayNode { on, guards, actions });
    }
    Ok(ReplayPack { counters, nodes })
}

enum DispatchEvent<'a> { RunStarted, TimerExpired(&'a str), ZoneEntered(&'a ReplayEventV1) }

/// TS dispatch 的镜像：按节点序扫描，匹配 + outcome 未定格 + 守卫全过才执行动作；
/// run.finish 定格 outcome 并终止该节点的动作循环，后续节点全部跳过。
fn dispatch(pack: &ReplayPack, counters: &mut BTreeMap<String, i64>, timers: &mut BTreeMap<String, u64>,
    outcome: &mut Option<&'static str>, tick: u64, event: &DispatchEvent) -> Result<(), ()> {
    for node in &pack.nodes {
        let matches = match (&node.on, event) {
            (OnEvent::RunStarted, DispatchEvent::RunStarted) => true,
            (OnEvent::TimerExpired { timer_id }, DispatchEvent::TimerExpired(fired)) => timer_id == fired,
            (OnEvent::ZoneEntered { slot }, DispatchEvent::ZoneEntered(input)) => slot == &input.slot,
            _ => false,
        };
        if !matches || outcome.is_some() { continue; }
        if !node.guards.iter().all(|guard| {
            let value = counters.get(&guard.counter).copied().unwrap_or(0);
            match &guard.op {
                GuardOp::Eq(target) => value == *target,
                // TS：eqEventIndex 对 run.started/timer.expired 恒假，只对输入事件成立。
                GuardOp::EqEventIndex => matches!(event, DispatchEvent::ZoneEntered(input) if value == input.event_index as i64),
            }
        }) { continue; }
        for action in &node.actions {
            match action {
                ReplayAction::CounterAdd { counter, amount } => {
                    let ceiling = pack.counters[counter].ceiling;
                    let value = counters[counter] + amount;
                    // TS：越界抛 "rule counter budget exceeded"，整步回滚后停机。
                    if !(0..=ceiling).contains(&value) { return Err(()); }
                    counters.insert(counter.clone(), value);
                }
                ReplayAction::TimerStart { timer_id, duration } => {
                    // TS：duration < 1 抛 "invalid timer duration"，同样整步回滚。
                    if *duration < 1 { return Err(()); }
                    timers.insert(timer_id.clone(), tick.saturating_add(*duration as u64));
                }
                // TS 记入有界 hints；verdict 不含提示，无需留存。
                ReplayAction::HudHint => {}
                ReplayAction::Finish(result) => { *outcome = Some(result); break; }
            }
        }
    }
    Ok(())
}

/// 取 (due, id) 序下最早的计时器：跨 step 是 due 序，同 step 内是 id 序
/// （TS 的 sort(localeCompare) 对 ASCII 标识符等价于字典序）。
fn next_timer(timers: &BTreeMap<String, u64>) -> Option<(String, u64)> {
    timers.iter().min_by(|a, b| (a.1, a.0).cmp(&(b.1, b.0))).map(|(id, due)| (id.clone(), *due))
}

pub fn replay_rules(rules: &Value, trace: &[ReplayEventV1], time_limit_ticks: u64) -> Result<ReplayVerdict, &'static str> {
    // 公开纯函数的防御边界：与 parse_trace 同一限制（调用方可能直接构造切片）。
    if trace.len() > MAX_REPLAY_EVENTS { return Err("rule_replay_trace_invalid"); }
    let mut previous_tick = 0u64;
    for event in trace {
        if event.at_tick > MAX_REPLAY_TICKS || event.at_tick < previous_tick { return Err("rule_replay_trace_invalid"); }
        previous_tick = event.at_tick;
    }
    let pack = parse_pack(rules, time_limit_ticks)?;
    Ok(simulate(&pack, trace))
}

fn simulate(pack: &ReplayPack, trace: &[ReplayEventV1]) -> ReplayVerdict {
    let mut counters: BTreeMap<String, i64> = pack.counters.iter().map(|(name, spec)| (name.clone(), spec.initial)).collect();
    let mut timers: BTreeMap<String, u64> = BTreeMap::new();
    let mut outcome: Option<&'static str> = None;
    // TS 把「run.started + 同 tick 输入 + 到点计时器」都算进 step 0 的事务：违规时
    // 整步回滚到 step 前的状态并停机，所以 tick 0 组的检查点在 run.started 之前取。
    let mut checkpoint = (counters.clone(), outcome);
    if dispatch(pack, &mut counters, &mut timers, &mut outcome, 0, &DispatchEvent::RunStarted).is_err() {
        return ReplayVerdict { outcome: checkpoint.1, counters: checkpoint.0 };
    }
    let mut index = 0usize;
    while index < trace.len() && outcome.is_none() {
        let group_tick = trace[index].at_tick;
        let mut group_end = index;
        while group_end < trace.len() && trace[group_end].at_tick == group_tick { group_end += 1; }
        checkpoint = (counters.clone(), outcome);
        // 到点计时器先于同 tick 的输入事件（TS step 内 timers 先于 inputs）。
        while outcome.is_none() {
            let Some((timer_id, due)) = next_timer(&timers).filter(|(_, due)| *due <= group_tick) else { break };
            timers.remove(&timer_id);
            if dispatch(pack, &mut counters, &mut timers, &mut outcome, due, &DispatchEvent::TimerExpired(&timer_id)).is_err() {
                return ReplayVerdict { outcome: checkpoint.1, counters: checkpoint.0 };
            }
        }
        while index < group_end && outcome.is_none() {
            let event = &trace[index];
            index += 1;
            if dispatch(pack, &mut counters, &mut timers, &mut outcome, group_tick, &DispatchEvent::ZoneEntered(event)).is_err() {
                return ReplayVerdict { outcome: checkpoint.1, counters: checkpoint.0 };
            }
        }
    }
    // 轨迹之后的虚拟步（模块头分歧 2）：client 的规则 run 在最后一条事件后继续空转到
    // 终局，剩余计时器按 (due, id) 序触发；违规回滚到轨迹末状态并停机。
    let end_checkpoint = (counters.clone(), outcome);
    while outcome.is_none() {
        let Some((timer_id, due)) = next_timer(&timers) else { break };
        timers.remove(&timer_id);
        if dispatch(pack, &mut counters, &mut timers, &mut outcome, due, &DispatchEvent::TimerExpired(&timer_id)).is_err() {
            return ReplayVerdict { outcome: end_checkpoint.1, counters: end_checkpoint.0 };
        }
    }
    ReplayVerdict { outcome, counters }
}

/// 宿主 verdict 与客户端自报 evidence 是否逐项一致（outcome + 全部计数器）。
/// 客户端快照含全部声明计数器（creatorMiniGame.ts 直接展开 state.counters），
/// 键集不同或任一值不同都算分歧——不做子集匹配，不猜。
pub fn verdict_matches_evidence(verdict: &ReplayVerdict, evidence: &Value) -> bool {
    let client_outcome = evidence.get("outcome").and_then(Value::as_str);
    if verdict.outcome != client_outcome { return false; }
    let Some(client_counters) = evidence.get("counters").and_then(Value::as_object) else { return false; };
    if client_counters.len() != verdict.counters.len() { return false; }
    // 复算不变量保证计数器非负（initial ≥ 0 且 add 结果被夹在 [0, ceiling]）。
    verdict.counters.iter().all(|(name, value)| {
        client_counters.get(name).and_then(Value::as_u64) == Some(*value as u64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// checkpoint-race 形状的规则包（creatorTemplates.ts 的字面量结构）。
    fn race_pack() -> Value {
        json!({
            "schemaVersion": 1, "rulesVersion": 1,
            "slots": {"points": {"kind": "zone", "min": 3, "max": 8}},
            "integerParameters": {
                "timeLimitTicks": {"min": 60, "max": 36000, "default": 2700},
                "gateTarget": {"min": 3, "max": 8, "default": 3}
            },
            "rules": {
                "counters": {"next": {"initial": 0, "max": {"parameter": "gateTarget"}}},
                "nodes": [
                    {"id": "start-timer", "on": {"type": "run.started"},
                        "actions": [{"op": "timer.start", "timerId": "timeout", "durationTicks": {"parameter": "timeLimitTicks"}}]},
                    {"id": "advance", "on": {"type": "zone.entered", "slot": "points"},
                        "when": [{"op": "counter.eqEventIndex", "counter": "next"}],
                        "actions": [{"op": "counter.add", "counter": "next", "amount": 1}]},
                    {"id": "finish", "on": {"type": "zone.entered", "slot": "points"},
                        "when": [{"op": "counter.eq", "counter": "next", "value": {"parameter": "gateTarget"}}],
                        "actions": [{"op": "run.finish", "outcome": "success"}]},
                    {"id": "timeout", "on": {"type": "timer.expired", "timerId": "timeout"},
                        "actions": [{"op": "run.finish", "outcome": "failure"}]}
                ]
            }
        })
    }

    fn event(slot: &str, event_index: u64, at_tick: u64) -> ReplayEventV1 {
        ReplayEventV1 { slot: slot.to_owned(), event_index, at_tick }
    }

    fn counters_value(expected: &[(&str, i64)]) -> BTreeMap<String, i64> {
        expected.iter().map(|(name, value)| (name.to_string(), *value)).collect()
    }

    #[test]
    fn three_gates_in_order_finish_success() {
        let trace = vec![event("points", 0, 100), event("points", 1, 200), event("points", 2, 300)];
        let verdict = replay_rules(&race_pack(), &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, Some("success"));
        assert_eq!(verdict.counters, counters_value(&[("next", 3)]));
    }

    #[test]
    fn partial_gates_then_timeout_fail_with_matching_counters() {
        // 少一门 + 超时：轨迹耗尽后剩余计时器按 (due,id) 触发 → failure（分歧 2 语义）。
        let trace = vec![event("points", 0, 100), event("points", 1, 200)];
        let verdict = replay_rules(&race_pack(), &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, Some("failure"));
        assert_eq!(verdict.counters, counters_value(&[("next", 2)]));
    }

    #[test]
    fn empty_trace_still_times_out() {
        let verdict = replay_rules(&race_pack(), &[], 2700).unwrap();
        assert_eq!(verdict.outcome, Some("failure"));
        assert_eq!(verdict.counters, counters_value(&[("next", 0)]));
    }

    #[test]
    fn settled_outcome_ignores_later_events() {
        // 第 3 门成功定格后，后续事件（乃至更晚的超时）一律忽略。
        let trace = vec![event("points", 0, 100), event("points", 1, 200), event("points", 2, 300), event("points", 2, 400)];
        let verdict = replay_rules(&race_pack(), &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, Some("success"));
        assert_eq!(verdict.counters, counters_value(&[("next", 3)]));
    }

    #[test]
    fn out_of_order_gate_does_not_advance_until_its_index_matches() {
        // counter.eqEventIndex：乱序门（index 3）不推进计数器，也不触发 finish；
        // 之后 index 归位时继续推进并在第 3 门定格 success。
        let trace = vec![event("points", 0, 100), event("points", 3, 150), event("points", 1, 200), event("points", 2, 300)];
        let verdict = replay_rules(&race_pack(), &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, Some("success"));
        assert_eq!(verdict.counters, counters_value(&[("next", 3)]));
        // 只推进到 next=2 的乱序轨迹最终超时失败。
        let trace = vec![event("points", 0, 100), event("points", 3, 150), event("points", 1, 200)];
        let verdict = replay_rules(&race_pack(), &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, Some("failure"));
        assert_eq!(verdict.counters, counters_value(&[("next", 2)]));
    }

    #[test]
    fn timer_fires_before_the_event_on_the_same_tick() {
        // TS step 内 timers 先于 inputs：时限 tick 上的进门事件被定格的 failure 吞掉。
        let trace = vec![event("points", 0, 2700)];
        let verdict = replay_rules(&race_pack(), &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, Some("failure"));
        assert_eq!(verdict.counters, counters_value(&[("next", 0)]));
    }

    #[test]
    fn counter_budget_violation_rolls_back_the_whole_tick_group() {
        // max 字面量 2 的三连推进（分 tick）：第 3 次 add 越界 → 该 tick 组整体回滚，
        // 计数器停在前一组的 2（TS 抛错回滚 step 并停机的镜像）。
        let mut pack = race_pack();
        pack["rules"]["counters"]["next"]["max"] = json!(2);
        let trace = vec![event("points", 0, 100), event("points", 1, 200), event("points", 2, 300)];
        let verdict = replay_rules(&pack, &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, None);
        assert_eq!(verdict.counters, counters_value(&[("next", 2)]));
        // 同 tick 三连推进共享一个回滚组：第 3 次 add 越界把同组前两次推进一并撤掉。
        let trace = vec![event("points", 0, 300), event("points", 1, 300), event("points", 2, 300)];
        let verdict = replay_rules(&pack, &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, None);
        assert_eq!(verdict.counters, counters_value(&[("next", 0)]));
    }

    #[test]
    fn collect_one_shape_without_timer_verifies_literal_finish_threshold() {
        // collect-one 模板：无计时器、finish 守卫是字面量阈值；单事件即成功定格。
        let pack = json!({
            "schemaVersion": 1, "rulesVersion": 1,
            "slots": {"targets": {"kind": "zone", "min": 1, "max": 1}},
            "integerParameters": {},
            "rules": {
                "counters": {"found": {"initial": 0, "max": 1}},
                "nodes": [
                    {"id": "collect", "on": {"type": "zone.entered", "slot": "targets"},
                        "actions": [{"op": "counter.add", "counter": "found", "amount": 1}]},
                    {"id": "finish", "on": {"type": "zone.entered", "slot": "targets"},
                        "when": [{"op": "counter.eq", "counter": "found", "value": 1}],
                        "actions": [{"op": "run.finish", "outcome": "success"}]}
                ]
            }
        });
        let verdict = replay_rules(&pack, &[event("targets", 0, 42)], 0).unwrap();
        assert_eq!(verdict.outcome, Some("success"));
        assert_eq!(verdict.counters, counters_value(&[("found", 1)]));
    }

    #[test]
    fn hud_hint_actions_are_accepted_without_touching_the_verdict() {
        let mut pack = race_pack();
        pack["rules"]["nodes"][1]["actions"].as_array_mut().unwrap()
            .insert(0, json!({"op": "hud.hint", "text": "gate reached"}));
        let trace = vec![event("points", 0, 100), event("points", 1, 200), event("points", 2, 300)];
        let verdict = replay_rules(&pack, &trace, 2700).unwrap();
        assert_eq!(verdict.outcome, Some("success"));
        assert_eq!(verdict.counters, counters_value(&[("next", 3)]));
    }

    #[test]
    fn unsupported_shapes_fail_closed() {
        let trace = vec![event("points", 0, 100), event("points", 1, 200), event("points", 2, 300)];
        // 规则侧：不支持的 action op / 事件类型 / 守卫 op / 版本 / 未声明引用 → Err。
        let mut pack = race_pack();
        pack["rules"]["nodes"][1]["actions"][0]["op"] = json!("score.add");
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        let mut pack = race_pack();
        pack["rules"]["nodes"][3]["on"]["type"] = json!("item.collected");
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        let mut pack = race_pack();
        pack["rules"]["nodes"][1]["when"][0]["op"] = json!("counter.gte");
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        let mut pack = race_pack();
        pack["schemaVersion"] = json!(2);
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        let mut pack = race_pack();
        pack["rules"]["counters"]["next"]["max"] = json!({"parameter": "undeclared"});
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        let mut pack = race_pack();
        pack["rules"]["nodes"][1]["when"][0]["counter"] = json!("missing");
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        let mut pack = race_pack();
        pack["rules"]["nodes"][3]["actions"][0]["durationTicks"] = json!({"parameter": "raceLength"});
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        let mut pack = race_pack();
        pack["slots"]["points"]["kind"] = json!("item");
        assert!(replay_rules(&pack, &trace, 2700).is_err());
        // 轨迹侧：超界 / 乱序 tick / 非法 kind / 非法 slot → Err。
        let overflow: Vec<ReplayEventV1> = (0..=MAX_REPLAY_EVENTS).map(|index| event("points", index as u64, index as u64)).collect();
        assert!(replay_rules(&race_pack(), &overflow, 2700).is_err());
        assert!(replay_rules(&race_pack(), &[event("points", 0, 300), event("points", 1, 200)], 2700).is_err());
        assert!(replay_rules(&race_pack(), &[event("points", 0, MAX_REPLAY_TICKS + 1)], 2700).is_err());
        let bad_kind = json!([{"kind": "item.collected", "slot": "points", "eventIndex": 0, "atTick": 1}]);
        assert!(parse_trace(&bad_kind).is_err());
        let bad_slot = json!([{"kind": "zone.entered", "slot": "bad slot!", "eventIndex": 0, "atTick": 1}]);
        assert!(parse_trace(&bad_slot).is_err());
        let extra_key = json!([{"kind": "zone.entered", "slot": "points", "eventIndex": 0, "atTick": 1, "extra": 1}]);
        assert!(parse_trace(&extra_key).is_err());
    }

    #[test]
    fn verdict_matches_evidence_requires_exact_outcome_and_counter_set() {
        let verdict = ReplayVerdict { outcome: Some("success"), counters: counters_value(&[("next", 3)]) };
        assert!(verdict_matches_evidence(&verdict, &json!({"outcome": "success", "counters": {"next": 3}})));
        assert!(!verdict_matches_evidence(&verdict, &json!({"outcome": "failure", "counters": {"next": 3}})));
        assert!(!verdict_matches_evidence(&verdict, &json!({"outcome": "success", "counters": {"next": 2}})));
        // 键集不同（客户端多报/漏报计数器）都算分歧，不做子集匹配。
        assert!(!verdict_matches_evidence(&verdict, &json!({"outcome": "success", "counters": {"next": 3, "extra": 1}})));
        // 未定格（null outcome）的 verdict 与客户端 null 同样逐项比对。
        assert!(verdict_matches_evidence(&ReplayVerdict { outcome: None, counters: counters_value(&[("next", 0)]) },
            &json!({"outcome": null, "counters": {"next": 0}})));
    }
}
