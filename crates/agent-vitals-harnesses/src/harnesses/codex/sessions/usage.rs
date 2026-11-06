//! Codex 成本折叠 —— 把 Codex rollout 的 `token_count` 事件折成「5 桶 × 模型 × 日期」。
//!
//! DSH 的 `usage.rs::token_by_model` 是给 DeepSeek token-meter 的折叠；Codex 的线格式
//! 与计价维度都不同，不能复用同一个折叠：DSH 的 4 桶（input/output/cacheRead/
//! cacheWrite）+ peak/off-peak 是模型无关的，Codex 的 5 桶按 `payload.info` 的
//! `last_token_usage` 读，计价还要 speed 维度。这是 cc-trace 研究 §D 显式 defer 的
//! 一块新能力，不是给 DSH 的成本引擎套 Codex 壳。
//!
//! 折叠语义的**正确性铁律**（实测本机 51 份 rollout，见 `codex-corpus-facts` 记忆）：
//!
//! - **读 `last_token_usage`，不是 `total_token_usage`**：`total` 是累计、`last` 是
//!   本 turn 增量（`total[i] − total[i−1]`）。拿 total 折叠会把整段会话反复加进桶里。
//! - **`uncached = input − cached − cache_write`（派生，不直接读）**；`input_tokens` /
//!   `output_tokens` 是必填（缺键 → 无效），cached / cache_write / reasoning 缺省 0
//!   （cc-trace 的 `integer_or_zero` 同款）。`output >= reasoning` 必须成立——reasoning
//!   **已计入 output**，绝不把 reasoning 加在 output 之上（那是双计）。
//! - **去重是必须的**：11575 个 token_count 事件里有 **366 个连续重复的
//!   `total_token_usage` 签名**（两种形态：整段复读 `last==total`、清零复读 `last`
//!   全 0 + 一个假的 `total_tokens`）。cc-trace 用 `last_total_signature` 跳过同签名的
//!   后续事件。累计总量单调不减，所以**连续去重 = 完全去重**——签名相同就 continue，
//!   不折叠、不算 unaccounted（同一计量的复读不是残差）。
//! - **model 不在 token_count 事件里**：来自 `turn_context.payload.model`（游标），
//!   token_count 归到最近一次 turn_context 的 model。首个 turn_context 之前的
//!   token_count 无法归属 → 进 `unaccounted`（残差哨兵：看见了 token、没接住）。
//! - **speed 也来自游标**：`turn_context.payload.service_tier` / `thread_settings/
//!   service_tier` 或 `thread_settings_applied` 的 `thread_settings/service_tier`，
//!   `default|standard → standard`、`fast|priority → fast`。实测 service_tier 全为 null
//!   → 恒 standard，但折叠**保留** speed 解析并按 (model, speed) 分桶——真实数据不
//!   命中 fast，命中就是未来的不同计费，不能静默并进 standard 桶（同「窄进宽出，
//!   绝不静默漏算」纪律）。没看到 service_tier 时默认 standard（cc-trace 同款）。
//! - **时间轴（小时桶，统一多桶折叠契约）**：从事件的顶层 `timestamp`（回退
//!   `payload.timestamp`）取 `YYYY-MM-DDTHH` 小时键——不是「codex 天生只有天」，是
//!   统一范式要求补全小时桶（DSH 的 `token_by_date_model` 也是小时粒度，两个执行环境
//!   遵循同一套多桶逻辑：按时间切 = 小时 → 天 → 月，按 session 切 = `by_model`）。
//!   无时间的事件仍折进 `by_model`，但**不产生小时桶**（未知时间不能算进任何一小时
//!   ——与 `usage.rs::token_by_date_model` 对无时间样本同一条纪律）。因此
//!   `sum(by_hour_model) == by_model − 无时间样本的量`；全部带时间时两者精确相等，
//!   这正是守恒测试断言的形式。`codex_aggregate_hours` 把小时聚合回日期——hour
//!   折叠 → date 聚合 → 按日计价是**必须的投影**，不是便利（longContext 判定粒度
//!   锚定在单日聚合桶，见 `codex_cost.rs`）。
//! - **plan / 配额状态来自 token_count 的 `rate_limits`**：`plan_type` /
//!   `credits.has_credits` / `primary|secondary.{used_percent, window_minutes,
//!   resets_at}`。**即使 `info` 为 null 也读**——真实语料里 info:null 的事件仍带
//!   rate_limits，配额是独立于 token 计量的状态。`plan_type` 非空字符串才算有效
//!   （否则该事件不更新配额快照）；`primary`/`secondary` 只收三字段、缺啥补啥。
//!   `observed_at` = 事件时间戳（无时间戳不更新——merge 要靠它排序选「最新」）。
//!   `plan_type`/`has_credits`/`observed_at` 单文件内**最后看见的赢**（事件序即时间
//!   序），跨文件 `codex_merge_folds` 取 `observed_at` 最大者（平手先见者赢）。但
//!   **`limits` 是「最后看见的**非空**限额」**——真实语料里出现过 primary/secondary
//!   全 null 的降级快照（2026-08-27 18:18 事件，只有 plan_type + limit_id），若
//!   「最后看见」直接覆盖，配额条会凭空消失（正是用户要的功能）。所以 limits 单独
//!   一个游标：新事件没带限额时，保留上一次的非空限额（跨事件、跨文件都保留）。
//!   输出 `plan: null` = 整份文件没见过有效 rate_limits。plan 是**当前状态快照**，
//!   不是日期桶——`--month` 过滤不碰它。
//!
//! `codex_fold_file`（单文件有序流）与 `codex_merge_folds`（跨文件求和）都输出同一
//! 形状：`{by_hour_model, by_model, unaccounted, plan}`。小时升序、模型/速度按首现序
//! （与 Python dict 的插入序对齐，两侧 JSON 逐字节相同靠的是这份一致）。Python 平行
//! 实现见 `scripts/agent_vitals/agent/codex_usage.py`，差分由
//! `tests/test_cli_matrix.py::both()` 与 characterization 钉死。

use agent_vitals_domain::evidence::{QuotaSnapshot, QuotaWindow};
use serde_json::{Map, Value, json};

/// Codex 5 桶字段名（输出顺序 = 桶序）。`uncached_input_tokens` 是派生字段，其余
/// 四个直接来自 `last_token_usage`。
pub const CODEX_TOKEN_FIELDS: [&str; 5] = [
    "uncached_input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
];

/// 从 `last_token_usage` 折出 5 桶。`None` = 无效（缺 input/output、`uncached < 0`、
/// `reasoning > output`）——交给调用方进残差哨兵，绝不把假数字折进桶。
pub fn codex_token_facts(last: &Value) -> Option<[i64; 5]> {
    if !last.is_object() {
        return None;
    }
    let input = last.get("input_tokens").and_then(|v| v.as_i64())?;
    let output = last.get("output_tokens").and_then(|v| v.as_i64())?;
    let cached = last.get("cached_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
    let cache_write = last.get("cache_write_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
    let reasoning = last.get("reasoning_output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
    let uncached = input - cached - cache_write;
    if uncached < 0 || reasoning > output {
        return None;
    }
    Some([uncached, output, cached, cache_write, reasoning])
}

/// `total_token_usage` 的 6 字段签名（去重键）。缺任一字段 → None（这种 total 没法
/// 判定「同一计量复读」，就不去重，交给下游的 last 校验兜底）。
///
/// `pub(crate)`：canonical 归一层（`usage.rs::canonical_total_delta`）要用同一份
/// 签名判定「prev/cur 是同一计量复读还是新的累计」，不能在 canonical 侧再写一份
/// 字段清单——那正是「一份谓词抄了十二遍」教训的又一例。
pub(crate) fn total_signature(total: &Value) -> Option<(i64, i64, i64, i64, i64, i64)> {
    Some((
        total.get("input_tokens")?.as_i64()?,
        total.get("output_tokens")?.as_i64()?,
        total.get("cached_input_tokens")?.as_i64()?,
        total.get("cache_write_input_tokens")?.as_i64()?,
        total.get("reasoning_output_tokens")?.as_i64()?,
        total.get("total_tokens")?.as_i64()?,
    ))
}

/// 事件的时间戳 → `YYYY-MM-DDTHH` 北京小时桶键（统一多桶折叠：时间轴小时粒度，
/// 与 DSH `usage.rs::hour_buckets` 同一条纪律——**北京时间**小时，不是 UTC）。
///
/// Codex 事件时间戳是 UTC ISO 串（实测全带 `Z` 后缀）。统一契约要求小时桶与
/// DSH 同为北京时间（东八区固定 +8、无夏令时）：否则日历把 UTC 小时当北京
/// 小时渲染（今天 08:59 的消费显示成「00:00」），且 `--today` 按北京日前缀
/// 过滤会把北京凌晨 0-7 点的消费整块丢掉。顶层 `timestamp` 回退
/// `payload.timestamp`；不是合法小时时间戳、或日历上不存在的日期（如 02-30）
/// → None（未知时间，不编造）。
///
/// `pub`：`codex-session` 的 turn_timeline 事件用它把事件对齐到小时桶（§6 数据
/// 准备归执行环境适配器，浏览器只做字典查表，不再算一遍北京时间）。小时桶键是唯一
/// 真相，不能让二进制侧长第二份换算。
pub fn codex_hour_of(event: &Value) -> Option<String> {
    let ts = event
        .get("timestamp")
        .and_then(|v| v.as_str())
        .or_else(|| event.pointer("/payload/timestamp").and_then(|v| v.as_str()))?;
    let b = ts.as_bytes();
    if b.len() < 13
        || !b[..4].iter().all(|c| c.is_ascii_digit())
        || b[4] != b'-'
        || !b[5..7].iter().all(|c| c.is_ascii_digit())
        || b[7] != b'-'
        || !b[8..10].iter().all(|c| c.is_ascii_digit())
        || b[10] != b'T'
        || !b[11..13].iter().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let (y, m, d, hh) = (
        parse_i64(&ts[0..4]),
        parse_u32(&ts[5..7]),
        parse_u32(&ts[8..10]),
        parse_i64(&ts[11..13]),
    );
    let days = agent_vitals_domain::usage::days_from_civil(y, m, d);
    // 日历有效性 round-trip：02-30 之类不存在的日期在 civil/days 两方向都
    // 是 Hinnant 的无定义输入，round-trip 不还原 → 不编造小时键。
    if civil_date_from_days(days) != format!("{:04}-{:02}-{:02}", y, m, d) {
        return None;
    }
    let total = days * 24 + hh + BEIJING_OFFSET_HOURS;
    let bj_days = total.div_euclid(24);
    let bj_hour = total.rem_euclid(24);
    Some(format!("{}T{:02}", civil_date_from_days(bj_days), bj_hour))
}

/// 东八区固定偏移。中国自 1991 年起全境 UTC+8、无夏令时（与 DSH `usage.rs`
/// 的 `tz_offset_hours: 8` 同口径）。
const BEIJING_OFFSET_HOURS: i64 = 8;

fn parse_i64(s: &str) -> i64 {
    // 结构校验已保证 s 是纯数字（长度 ≤4），parse 不会失败。
    s.parse().unwrap_or(0)
}

fn parse_u32(s: &str) -> u32 {
    s.parse().unwrap_or(0)
}

/// 与 `usage.rs::civil_date_from_days` 同实现（Hinnant），此处是 `pub(crate)`
/// 访问同一函数的薄包装，避免重复一份算法。
fn civil_date_from_days(days: i64) -> String {
    agent_vitals_domain::usage::civil_date_from_days(days)
}

/// 事件的时间戳**原始字符串**（顶层 `timestamp` 回退 `payload.timestamp`）。None =
/// 无时间戳——配额快照没有可排序的 observed_at，就不更新（保持上一份）。
fn event_timestamp(event: &Value) -> Option<String> {
    event
        .get("timestamp")
        .and_then(|v| v.as_str())
        .or_else(|| event.pointer("/payload/timestamp").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

/// `payload.rate_limits` → `plan` 块。`plan_type` 非空字符串才算有效（`limit_id`
/// 之类不构成套餐身份）；`primary`/`secondary` 只收 `{used_percent, window_minutes,
/// resets_at}` 三字段、缺啥补啥、非法类型跳过该键；`observed_at` 由调用方传事件
/// 时间戳。None = 无效 rate_limits（plan_type 缺失/空）——不更新配额快照。
fn plan_from_rate_limits(rl: &Value, observed_at: &str) -> Option<Value> {
    let rl = rl.as_object()?;
    let plan_type = rl.get("plan_type").and_then(|v| v.as_str()).unwrap_or("");
    if plan_type.is_empty() {
        return None;
    }
    let mut has_credits = false;
    if let Some(credits) = rl.get("credits").and_then(|v| v.as_object()) {
        if let Some(hc) = credits.get("has_credits").and_then(|v| v.as_bool()) {
            has_credits = hc;
        }
    }
    let mut limits = Map::new();
    for name in ["primary", "secondary"] {
        let Some(win) = rl.get(name).and_then(|v| v.as_object()) else { continue };
        let mut entry = Map::new();
        if let Some(up) = win.get("used_percent") {
            // used_percent 的真实值恒是 float（67.0），但 JSON 里整数也可能出现；
            // 先试整数再试 float，与 Python 侧 `int → int / float → float` 同序，
            // 否则两侧 `67` vs `67.0` 序列化不同（逐字节差分当场红）。
            if let Some(i) = up.as_i64() {
                entry.insert("used_percent".into(), json!(i));
            } else if let Some(f) = up.as_f64() {
                entry.insert("used_percent".into(), json!(f));
            }
        }
        if let Some(wm) = win.get("window_minutes").and_then(|v| v.as_i64()) {
            entry.insert("window_minutes".into(), json!(wm));
        }
        if let Some(ra) = win.get("resets_at").and_then(|v| v.as_i64()) {
            entry.insert("resets_at".into(), json!(ra));
        }
        if !entry.is_empty() {
            limits.insert(name.into(), Value::Object(entry));
        }
    }
    let mut plan = Map::new();
    plan.insert("plan_type".into(), json!(plan_type));
    plan.insert("has_credits".into(), json!(has_credits));
    if !limits.is_empty() {
        plan.insert("limits".into(), Value::Object(limits));
    }
    plan.insert("observed_at".into(), json!(observed_at));
    Some(Value::Object(plan))
}

/// 校验从权威库读取的 Codex 配额快照仍符合本 adapter 的输出契约。
///
/// 快照是由本模块从 `rate_limits` 生成的，Runtime 不应重新解释执行环境字段；
/// 这里保留最小的执行环境身份校验，坏 payload 只能降级为 unavailable，不能
/// 被读面当作通用额度或零值继续传播。
pub fn validate_quota_snapshot(snapshot: &Value) -> Option<Value> {
    quota_snapshot_contract(snapshot)?;
    Some(snapshot.clone())
}

/// 把 Codex adapter 的兼容 JSON 快照映射为执行环境无关的配额契约。
///
/// `has_credits` 等 Codex 扩展仍留在原始快照中；跨执行环境消费者只依赖
/// `QuotaSnapshot` 的计划标签、完整窗口和观测时间。缺少窗口字段时保留
/// plan-only 快照，和当前 Codex 降级输出的语义一致。
pub fn quota_snapshot_contract(snapshot: &Value) -> Option<QuotaSnapshot> {
    let plan_type = snapshot.get("plan_type").and_then(Value::as_str)?;
    if plan_type.is_empty() {
        return None;
    }
    let observed_at = snapshot.get("observed_at").and_then(Value::as_str)?;
    if observed_at.is_empty() {
        return None;
    }
    let mut windows = Vec::new();
    for name in ["primary", "secondary"] {
        let Some(window) = snapshot.pointer(&format!("/limits/{name}")) else { continue };
        let Some(used_percent) = window.get("used_percent").and_then(Value::as_f64) else { continue };
        let Some(window_minutes) = window
            .get("window_minutes")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
        else { continue };
        let Some(resets_at_ms) = window
            .get("resets_at")
            .and_then(Value::as_i64)
            .and_then(|value| value.checked_mul(1_000))
        else { continue };
        windows.push(QuotaWindow {
            plan: plan_type.to_string(),
            used_percent,
            window_minutes,
            resets_at_ms,
        });
    }
    let contract = QuotaSnapshot {
        plan: Some(plan_type.to_string()),
        windows,
        observed_at: observed_at.to_string(),
    };
    contract.validate().ok()?;
    Some(contract)
}

/// 把新事件的 plan 与上一次 plan 合并：**新事件没带 `limits`、上一次带了 → 把上一次
/// 的非空限额带过来**（降级快照不抹掉配额条），canonical 键序重建
/// (plan_type, has_credits, limits, observed_at)。新事件自带 limits 或上一次没有 →
/// 原样返回。纯函数，与 Python 侧 `codex_usage.py::_combine_plan` 逐字节对齐。
fn combine_plan(new_p: &Value, prev: &Value) -> Value {
    if new_p.get("limits").is_some() {
        return new_p.clone();
    }
    let Some(prev_limits) = prev.get("limits") else { return new_p.clone() };
    if prev_limits.is_null() {
        return new_p.clone();
    }
    let plan_type = new_p.get("plan_type").cloned().unwrap_or(Value::Null);
    let has_credits = new_p.get("has_credits").cloned().unwrap_or(Value::Null);
    let observed_at = new_p.get("observed_at").cloned().unwrap_or(Value::Null);
    let mut plan = Map::new();
    plan.insert("plan_type".into(), plan_type);
    plan.insert("has_credits".into(), has_credits);
    plan.insert("limits".into(), prev_limits.clone());
    plan.insert("observed_at".into(), observed_at);
    Value::Object(plan)
}

/// `default|standard → standard`、`fast|priority → fast`，其余 → None（未知档位不猜，
/// 保持当前 speed——不是把未知档位静默降级成 standard）。
fn normalize_speed(tier: &str) -> Option<&'static str> {
    match tier {
        "default" | "standard" => Some("standard"),
        "fast" | "priority" => Some("fast"),
        _ => None,
    }
}

/// 从一个 payload 里读 service_tier → 归一化 speed。`payload.service_tier` 优先，
/// 回退 `thread_settings/service_tier`（cc-trace 的两处 pointer 同款）。
fn speed_from_payload(payload: &Value) -> Option<&'static str> {
    if let Some(t) = payload.get("service_tier").and_then(|v| v.as_str()) {
        if let Some(s) = normalize_speed(t) {
            return Some(s);
        }
    }
    payload
        .pointer("/thread_settings/service_tier")
        .and_then(|v| v.as_str())
        .and_then(normalize_speed)
}

/// 把一个 5 桶对象折进 `map[model][speed]`。桶对象存在则按位累加，不存在则按
/// `CODEX_TOKEN_FIELDS` 的桶序新建（键序是字节一致的一部分，不能重排）。
fn add_bucket(map: &mut Map<String, Value>, model: &str, speed: &str, facts: &[i64; 5]) {
    let speed_map = map
        .entry(model.to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("bucket map value is an object");
    let bucket = speed_map
        .entry(speed.to_string())
        .or_insert_with(|| {
            json!({
                "uncached_input_tokens": 0,
                "output_tokens": 0,
                "cached_input_tokens": 0,
                "cache_write_input_tokens": 0,
                "reasoning_output_tokens": 0,
            })
        });
    let obj = bucket.as_object_mut().expect("bucket is an object");
    for (i, field) in CODEX_TOKEN_FIELDS.iter().enumerate() {
        let cur = obj.get(*field).and_then(|v| v.as_i64()).unwrap_or(0);
        obj.insert((*field).to_string(), json!(cur + facts[i]));
    }
}

/// 把一个 5 桶对象读回 `[i64; 5]`（合并跨文件的桶时用）。
fn bucket_to_array(bucket: &Value) -> [i64; 5] {
    let mut out = [0i64; 5];
    for (i, field) in CODEX_TOKEN_FIELDS.iter().enumerate() {
        out[i] = bucket.get(*field).and_then(|v| v.as_i64()).unwrap_or(0);
    }
    out
}

/// 残差哨兵：给 `unaccounted` 里某个 type 累加 (count, tokens_seen)。
/// `tokens_seen` = 该事件 total_token_usage 里的 total_tokens（总能看到的大数），
/// 让展示层知道「看见了多大的用量、没接住」。
fn bump_unaccounted(
    unaccounted: &mut std::collections::BTreeMap<String, (i64, i64)>,
    ttype: &str,
    total_tokens: i64,
) {
    let e = unaccounted.entry(ttype.to_string()).or_insert((0, 0));
    e.0 += 1;
    e.1 += total_tokens;
}

/// 单条 `token_count` 事件的折合出口（spec §2.3 / §4 判别表）。fold 与
/// UsageFact emitter 共用同一份 per-event 判别——emitter 绝不能另起一套
/// wire-shape 解释（Stage 1 R1 教训）。判别与 fold 的 by_model 消费集一一对应：
///
/// | 变体 | fold 判别 | emitter 行为 |
/// |---|---|---|
/// | `NotTokenCount` | 非 token_count 事件（turn_context / thread_settings / …） | 不计数 |
/// | `Skip` | token_count 但 `info` 非 dict / null | skip attempt，不发 fact |
/// | `Repeat` | 连续 total 签名复读（同一计量复读） | 不 emit、不计 attempt |
/// | `Unreadable` | `last_token_usage` 无效（`codex_token_facts` None） | unreadable attempt |
/// | `Unattributed` | model 游标为空（首个 turn_context 之前） | unattributed attempt |
/// | `Consumed` | 折进 by_model（可 emit） | fact；附 5 桶 + 归属 model + 原始时间戳 |
///
/// `Consumed` 携带 `event_ts_utc`（顶层 `timestamp` 回退 `payload.timestamp` 的
/// **原样串**；无时间戳 → None）——emitter 不重抄一遍时间戳回退逻辑。时间轴小时
/// 键由 `codex_hour_of` 在 apply 内算；emitter 只要原始时间戳、不需要小时桶。
#[derive(Debug, PartialEq)]
pub enum CodexTokenOutcome {
    NotTokenCount,
    Skip,
    Repeat,
    Unreadable,
    Unattributed,
    Consumed {
        facts: [i64; 5],
        model: String,
        event_ts_utc: Option<String>,
    },
}

/// 单文件 codex 折叠的**共享 per-`token_count` 观察者**（spec §2.3）：把
/// `codex_fold_file` 曾经的内联状态（model/speed 游标、`last_total_sig` 去重、
/// plan 快照、两份桶、unaccounted 残差）提出来，暴露逐事件 `apply`。fold 与
/// emitter 驱动**同一份状态机**，「emit 集 == by_model 消费集」是构造出来的，
/// 不是事后对齐的。
///
/// 这是 Stage 2 的 byte-neutral refactor：`codex_fold_file` 退成薄驱动
/// （new → 逐事件 apply → finish），输出与重构前逐字节一致——零漂移由 golden
/// 15/15 + `test_cli_matrix::both("codex-cost")` 差分看守。Python 镜像见
/// `codex_usage.py::CodexFoldState`。
pub struct CodexFoldState {
    model: Option<String>,
    speed: &'static str,
    last_total_sig: Option<(i64, i64, i64, i64, i64, i64)>,
    plan: Option<Value>,
    by_hour_model: std::collections::BTreeMap<String, Map<String, Value>>,
    by_model: Map<String, Value>,
    unaccounted: std::collections::BTreeMap<String, (i64, i64)>,
}

impl Default for CodexFoldState {
    /// 每文件一份干净折叠状态（`speed: "standard"` 是 fold 的默认档，不是
    /// 从某 harness 读来的值——clippy `new_without_default`：唯一构造路径走 new）。
    fn default() -> Self {
        Self::new()
    }
}

impl CodexFoldState {
    pub fn new() -> Self {
        Self {
            model: None,
            speed: "standard",
            last_total_sig: None,
            plan: None,
            by_hour_model: std::collections::BTreeMap::new(),
            by_model: Map::new(),
            unaccounted: std::collections::BTreeMap::new(),
        }
    }

    /// 逐事件推进折叠。判别出口（`CodexTokenOutcome`）只对 token_count 事件有
    /// 意义；turn_context / thread_settings_applied 只更新游标、返回
    /// `NotTokenCount`。token_count 分支**逐字节对应**重构前的 `codex_fold_file`
    /// 内联体：配额快照即使 `info` 为 null 也读（配额独立于 token 计量），
    /// `info` 非对象/null 是 skip（不是残差），复读签名先于 last 校验（累计单调
    /// 不减 → 连续去重 = 完全去重），`total_tokens` 只喂残差哨兵。
    pub fn apply(&mut self, event: &Value) -> CodexTokenOutcome {
        if !event.is_object() {
            return CodexTokenOutcome::NotTokenCount;
        }
        let ttype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ttype {
            "turn_context" => {
                if let Some(p) = event.get("payload") {
                    if let Some(m) = p.get("model").and_then(|v| v.as_str()) {
                        self.model = Some(m.to_string());
                    }
                    if let Some(s) = speed_from_payload(p) {
                        self.speed = s;
                    }
                }
                CodexTokenOutcome::NotTokenCount
            }
            "event_msg" => {
                let payload = event.get("payload");
                let ptype = payload
                    .and_then(|p| p.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match ptype {
                    "thread_settings_applied" => {
                        if let Some(p) = payload {
                            if let Some(s) = speed_from_payload(p) {
                                self.speed = s;
                            }
                        }
                        CodexTokenOutcome::NotTokenCount
                    }
                    "token_count" => {
                        let Some(payload) = payload else {
                            return CodexTokenOutcome::NotTokenCount;
                        };
                        // 配额状态从 token_count 读——**即使 `info` 为 null 也读**
                        // （真实语料里 info:null 的事件仍带 rate_limits，配额是独立
                        // 于 token 计量的状态）。plan_type/has_credits/observed_at 最后
                        // 看见的赢（事件序即时间序）；`limits` 走 combine_plan 保留
                        // 上一次非空限额——降级快照（primary/secondary 全 null，真实
                        // 语料 08-27 出过）不该抹掉配额条。时间戳只取一次，原样串喂
                        // Consumed（emitter 的 event_ts_utc）。
                        let event_ts_utc = event_timestamp(event);
                        if let Some(rl) = payload.get("rate_limits") {
                            if let Some(ts) = event_ts_utc.as_deref() {
                                if let Some(p) = plan_from_rate_limits(rl, ts) {
                                    self.plan = Some(match self.plan.take() {
                                        Some(prev) => combine_plan(&p, &prev),
                                        None => p,
                                    });
                                }
                            }
                        }
                        // `info` 必须真是对象：键存在但值为 `null`（真实语料 08-19 出过）
                        // 意味着这个事件**没有任何 token 字段**，不是「看见了没接住」，
                        // 不该进残差哨兵——Python 侧 `isinstance(info, dict)` 直接跳过，
                        // 这里用 `as_object()` 对齐：缺键和 null 都等价判 Skip，绝不在
                        // 二者之间产生 Py↔Rust 分歧。
                        let Some(info) = payload.get("info").and_then(|v| v.as_object()) else {
                            return CodexTokenOutcome::Skip;
                        };
                        let total = info.get("total_token_usage");
                        // 去重：同一计量复读（total 签名不变）→ Repeat。累计总量单调
                        // 不减，连续去重 = 完全去重（实测 366 处重复签名都是连续成对）。
                        // 签名先于 last 校验更新：复读事件即便 last 无效也按 Repeat 处理
                        // （与重构前 `continue` 落在同一点）。
                        if let Some(total) = total {
                            if let Some(sig) = total_signature(total) {
                                if self.last_total_sig == Some(sig) {
                                    return CodexTokenOutcome::Repeat;
                                }
                                self.last_total_sig = Some(sig);
                            }
                        }
                        let total_tokens = total
                            .and_then(|t| t.get("total_tokens"))
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        let Some(last) = info.get("last_token_usage") else {
                            bump_unaccounted(&mut self.unaccounted, "token_count_invalid_last_usage", total_tokens);
                            return CodexTokenOutcome::Unreadable;
                        };
                        let Some(facts) = codex_token_facts(last) else {
                            bump_unaccounted(&mut self.unaccounted, "token_count_invalid_last_usage", total_tokens);
                            return CodexTokenOutcome::Unreadable;
                        };
                        let Some(m) = self.model.clone() else {
                            // 首个 turn_context 之前：看见了 token、没模型可归。
                            bump_unaccounted(&mut self.unaccounted, "token_count_before_turn_context", total_tokens);
                            return CodexTokenOutcome::Unattributed;
                        };
                        if let Some(h) = codex_hour_of(event) {
                            let hour_map = self.by_hour_model.entry(h).or_default();
                            add_bucket(hour_map, &m, self.speed, &facts);
                        }
                        add_bucket(&mut self.by_model, &m, self.speed, &facts);
                        CodexTokenOutcome::Consumed { facts, model: m, event_ts_utc }
                    }
                    _ => CodexTokenOutcome::NotTokenCount,
                }
            }
            _ => CodexTokenOutcome::NotTokenCount,
        }
    }

    /// 折叠收尾：`by_hour_model` 小时升序（BTreeMap 迭代序）、`unaccounted` 按
    /// type 名升序排成数组、`plan` 取快照或 null。**与原 `codex_fold_file` 尾部
    /// 逐字节一致**——键序是字节一致的一部分，不能重排。
    pub fn finish(self) -> Value {
        let mut hour_out = Map::new();
        for (h, hour_map) in self.by_hour_model {
            hour_out.insert(h, Value::Object(hour_map));
        }
        let unaccounted_out: Vec<Value> = self
            .unaccounted
            .iter()
            .map(|(t, (count, tokens_seen))| {
                json!({"type": t, "count": count, "tokens_seen": tokens_seen})
            })
            .collect();
        json!({
            "by_hour_model": Value::Object(hour_out),
            "by_model": Value::Object(self.by_model),
            "unaccounted": Value::Array(unaccounted_out),
            "plan": self.plan.unwrap_or(Value::Null),
        })
    }
}

/// 单文件有序折叠：把一份 rollout 的原始条目流折成 `{by_hour_model, by_model,
/// unaccounted, plan}`。纯函数，不碰文件系统——I/O 在适配器层，这里只吃 `events`。
///
/// 薄驱动：`CodexFoldState::new()` → 逐事件 `apply` → `finish()`。输出与重构前
/// 逐字节一致（spec §2.3 byte-neutral refactor；golden + `both("codex-cost")`
/// 差分证零漂移）。
///
/// 输出顺序：小时升序（BTreeMap）、模型/速度按首现序（Map 插入序）、`unaccounted`
/// 按 type 名升序。这些顺序是字节一致的一部分。
pub fn codex_fold_file(events: &[Value]) -> Value {
    let mut state = CodexFoldState::new();
    for event in events {
        state.apply(event);
    }
    state.finish()
}

/// 跨文件合并：把多个 `codex_fold_file` 的结果逐桶求和。纯函数。
///
/// 顺序确定性（字节一致的一部分）：`by_hour_model` 的小时**全局升序**（先收集全部
/// 小时排序，再按序遍历——跨文件时插入序不可靠：先 fold 的文件小时可能晚于后 fold
/// 的）；每个小时内、每个模型内、速度按**跨文件首现序**（按 folds 顺序遍历）。
/// `by_model` 按 folds 顺序、模型/速度首现序。`unaccounted` 按 type 名升序求和。
/// `plan` 取 `observed_at` 最大者（各会话的配额快照不同，选「最新」的那个；平手
/// 先见者赢——按 folds 顺序，确定性）；`limits` 单独取「最后看见的非空限额」——
/// 最新快照是降级形态（primary/secondary 全 null）时不抹掉配额条（见
/// `combine_plan`，与单文件折叠同一语义）。
pub fn codex_merge_folds(folds: &[Value]) -> Value {
    let mut all_hours: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for fold in folds {
        if let Some(by_hour) = fold.get("by_hour_model").and_then(|v| v.as_object()) {
            all_hours.extend(by_hour.keys().cloned());
        }
    }

    let mut by_hour_out: Map<String, Value> = Map::new();
    for h in &all_hours {
        let mut hour_map: Map<String, Value> = Map::new();
        for fold in folds {
            let Some(by_hour) = fold.get("by_hour_model").and_then(|v| v.as_object()) else {
                continue;
            };
            let Some(models) = by_hour.get(h).and_then(|v| v.as_object()) else {
                continue;
            };
            for (m, speeds) in models {
                let Some(speeds) = speeds.as_object() else { continue };
                for (spd, bucket) in speeds {
                    add_bucket(&mut hour_map, m, spd, &bucket_to_array(bucket));
                }
            }
        }
        by_hour_out.insert(h.clone(), Value::Object(hour_map));
    }

    let mut by_model: Map<String, Value> = Map::new();
    for fold in folds {
        let Some(bm) = fold.get("by_model").and_then(|v| v.as_object()) else {
            continue;
        };
        for (m, speeds) in bm {
            let Some(speeds) = speeds.as_object() else { continue };
            for (spd, bucket) in speeds {
                add_bucket(&mut by_model, m, spd, &bucket_to_array(bucket));
            }
        }
    }

    let mut unaccounted: std::collections::BTreeMap<String, (i64, i64)> =
        std::collections::BTreeMap::new();
    for fold in folds {
        let Some(ua) = fold.get("unaccounted").and_then(|v| v.as_array()) else {
            continue;
        };
        for e in ua {
            let t = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let c = e.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
            let s = e.get("tokens_seen").and_then(|v| v.as_i64()).unwrap_or(0);
            let entry = unaccounted.entry(t.to_string()).or_insert((0, 0));
            entry.0 += c;
            entry.1 += s;
        }
    }

    let unaccounted_out: Vec<Value> = unaccounted
        .iter()
        .map(|(t, (count, tokens_seen))| {
            json!({"type": t, "count": count, "tokens_seen": tokens_seen})
        })
        .collect();
    // plan_type/has_credits/observed_at 取 observed_at 最大者；`limits` 单独取
    // 「最后看见的**非空**限额」（limits_plan 里带 limits 的那份）——与单文件折叠
    // 同一语义：某文件的最后一次快照是降级形态（primary/secondary 全 null）时，
    // 别把别的文件带来的配额条抹掉。最后 combine_plan 把二者合一。
    let mut plan_out: Option<Value> = None;
    let mut limits_plan: Option<Value> = None;
    for fold in folds {
        let Some(p) = fold.get("plan") else { continue };
        if p.is_null() {
            continue;
        }
        let oa = p.get("observed_at").and_then(|v| v.as_str()).unwrap_or("");
        let is_latest = match &plan_out {
            None => true,
            Some(cur) => {
                let na = oa;
                let oa_cur = cur.get("observed_at").and_then(|v| v.as_str()).unwrap_or("");
                na > oa_cur
            }
        };
        if is_latest {
            plan_out = Some(p.clone());
        }
        if let Some(limits) = p.get("limits") {
            if !limits.is_null() {
                let limits_is_latest = match &limits_plan {
                    None => true,
                    Some(cur) => {
                        let oa_cur = cur.get("observed_at").and_then(|v| v.as_str()).unwrap_or("");
                        oa > oa_cur
                    }
                };
                if limits_is_latest {
                    limits_plan = Some(p.clone());
                }
            }
        }
    }
    let plan_final = match (plan_out, limits_plan) {
        (Some(p), Some(lp)) => Some(combine_plan(&p, &lp)),
        (Some(p), None) => Some(p),
        _ => None,
    };
    json!({
        "by_hour_model": Value::Object(by_hour_out),
        "by_model": Value::Object(by_model),
        "unaccounted": Value::Array(unaccounted_out),
        "plan": plan_final.unwrap_or(Value::Null),
    })
}

/// 时间轴小时桶 → 日期桶：`by_hour_model`（{hour:{model:{speed:桶}}}）逐小时求和
/// 折回 `by_date_model`（{date:{model:{speed:桶}}}）。小时键 `YYYY-MM-DDTHH` 取前
/// 10 位成日期；日期升序（BTreeMap，输入小时升序时与 Python 插入序一致）。
///
/// **longContext 判定的粒度锚点**：`codex_cost_report` 按**单日聚合桶**判 LC
/// （"这一次请求的上下文超窗"按日看），不按小时桶——小时桶拆开会把一日的大请求
/// 摊薄成不触发的小桶（踩过的坑：合并桶又会让多日小请求累加成假超窗）。所以
/// hour 折叠 → date 聚合 → 按日计价是必须的投影，不是可选的便利。
pub fn codex_aggregate_hours(by_hour_model: &Value) -> Value {
    let mut date_out: std::collections::BTreeMap<String, Map<String, Value>> =
        std::collections::BTreeMap::new();
    if let Some(bh) = by_hour_model.as_object() {
        for (h, hour_map) in bh {
            if h.len() < 10 {
                continue;
            }
            let date = h[..10].to_string();
            let Some(hour_map) = hour_map.as_object() else { continue };
            let date_map = date_out.entry(date).or_default();
            for (m, speeds) in hour_map {
                let Some(speeds) = speeds.as_object() else { continue };
                for (spd, bucket) in speeds {
                    add_bucket(date_map, m, spd, &bucket_to_array(bucket));
                }
            }
        }
    }
    let mut out = Map::new();
    for (d, dm) in date_out {
        out.insert(d, Value::Object(dm));
    }
    Value::Object(out)
}

/// 时间轴投影 → 模型轴投影：`by_hour_model`（{hour:{model:{speed:桶}}}）逐桶求和
/// 折回 `by_model`（{model:{speed:桶}}）。模型/速度按**跨小时首现序**（小时已升序，
/// 逐小时插入即首现序），与 `codex_fold_file` 的模型轴同一约定。
///
/// `prefix`（可选）按小时键前缀过滤：`--today` 传 `YYYY-MM-DD`、`--month` 传
/// `YYYY-MM`（小时键 `YYYY-MM-DDTHH` 用 `starts_with` 匹配）。
///
/// 踩过的坑：`codex-cost --month` 过滤时间轴后，by_model 必须**重算**——过滤掉了
/// 哪些小时，模型轴就必须同样丢掉那些 token，否则 per_model 里残留被过滤时间的
/// 用量，days 与 per_model 对不上（守恒测试红）。一开始想当然拿 `codex_merge_folds`
/// 把过滤后的时间轴 "折回去"，但 merge 的 by_model **只读各 fold 的 `by_model`
/// 字段**、从不读时间轴，传 `{"by_model": {}}` 得到的是空模型轴——整份月报告静默
/// 变全零（per_model 空 + unpriced 0 → 返回 None → 全零兜底），一个「看不见的错」。
/// 重算不是新数据：`by_model == Σ 各小时桶`（同一折叠的两投影，usage.rs 时间轴
/// 守恒同款纪律），无时间样本没有小时桶、被过滤按设计丢弃。
pub fn codex_by_model_from_hours(by_hour_model: &Value, prefix: Option<&str>) -> Value {
    let mut by_model: Map<String, Value> = Map::new();
    if let Some(bh) = by_hour_model.as_object() {
        for (h, hour_map) in bh {
            if let Some(prefix) = prefix {
                if !h.starts_with(prefix) {
                    continue;
                }
            }
            let Some(hour_map) = hour_map.as_object() else { continue };
            for (m, speeds) in hour_map {
                let Some(speeds) = speeds.as_object() else { continue };
                for (spd, bucket) in speeds {
                    add_bucket(&mut by_model, m, spd, &bucket_to_array(bucket));
                }
            }
        }
    }
    Value::Object(by_model)
}

/// `sessions navigation` 的 Codex 今日 token：`codex_aggregate_hours` 的日期桶
/// （{date:{model:{speed:桶}}}）→ 当日 5 桶全模型/全速度求和（spec §5.2
/// `basis="events"`，与 codex-cost 的 days[].tokens 同一求和口径）。None =
/// 该日没有 token 事件被折入（「测不出」，不是 0——「今天没跑」与「今天没测到」
/// 是两个词；零会话的真零由调用方按 store 判，见 `r2a_store` 注释）。
pub fn codex_day_tokens(by_date_model: &Value, day_key: &str) -> Option<i64> {
    let day_map = by_date_model.get(day_key)?.as_object()?;
    let mut total: i64 = 0;
    for speeds in day_map.values() {
        let Some(speeds) = speeds.as_object() else { continue };
        for bucket in speeds.values() {
            total += bucket_to_array(bucket).iter().sum::<i64>();
        }
    }
    Some(total)
}

/// 折叠残差哨兵：`unaccounted` 条目（`{type, count, tokens_seen}` 列表）的
/// `tokens_seen` 总和。>0 → 有 token 看见了没接住，当日数可能是下界 →
/// coverage=partial（spec §5.2；全时段残差，当日粒度不重算）。
pub fn unaccounted_tokens_seen(unaccounted: &Value) -> i64 {
    let Some(entries) = unaccounted.as_array() else { return 0 };
    entries
        .iter()
        .filter_map(|e| e.get("tokens_seen").and_then(Value::as_i64))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_count_line(ts: &str, model_total: (i64, i64, i64, i64, i64, i64), last: (i64, i64, i64, i64, i64, i64)) -> Value {
        let (ti, to, tc, tw, tr, tt) = model_total;
        let (li, lo, lc, lw, lr, lt) = last;
        serde_json::json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": ti, "output_tokens": to,
                        "cached_input_tokens": tc, "cache_write_input_tokens": tw,
                        "reasoning_output_tokens": tr, "total_tokens": tt,
                    },
                    "last_token_usage": {
                        "input_tokens": li, "output_tokens": lo,
                        "cached_input_tokens": lc, "cache_write_input_tokens": lw,
                        "reasoning_output_tokens": lr, "total_tokens": lt,
                    },
                    "model_context_window": 258400,
                }
            }
        })
    }

    fn turn_context_line(model: &str, ts: &str) -> Value {
        serde_json::json!({
            "timestamp": ts,
            "type": "turn_context",
            "payload": {"model": model, "service_tier": null},
        })
    }

    fn bucket_of(v: &Value, model: &str, speed: &str) -> Value {
        v.get("by_model").unwrap().get(model).unwrap().get(speed).unwrap().clone()
    }

    #[test]
    fn token_facts_derives_uncached_and_validates() {
        let last = serde_json::json!({
            "input_tokens": 100, "output_tokens": 10,
            "cached_input_tokens": 30, "cache_write_input_tokens": 5,
            "reasoning_output_tokens": 3, "total_tokens": 110,
        });
        assert_eq!(codex_token_facts(&last), Some([65, 10, 30, 5, 3]));
        // reasoning > output → 无效
        let bad = serde_json::json!({
            "input_tokens": 100, "output_tokens": 10, "reasoning_output_tokens": 12,
        });
        assert_eq!(codex_token_facts(&bad), None);
        // cached + cache_write > input → uncached 为负 → 无效
        let bad2 = serde_json::json!({
            "input_tokens": 100, "output_tokens": 10, "cached_input_tokens": 200,
        });
        assert_eq!(codex_token_facts(&bad2), None);
        // 缺 input/output（必填）→ 无效
        assert_eq!(codex_token_facts(&serde_json::json!({"output_tokens": 1})), None);
        // 缺可选桶 → 缺省 0
        let missing = serde_json::json!({"input_tokens": 100, "output_tokens": 10});
        assert_eq!(codex_token_facts(&missing), Some([100, 10, 0, 0, 0]));
    }

    #[test]
    fn fold_file_splits_by_model_and_date() {
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z"),
            token_count_line(
                "2026-08-05T10:00:01Z",
                (20413, 128, 11008, 0, 0, 20541),
                (20413, 128, 11008, 0, 0, 20541),
            ),
            token_count_line(
                "2026-08-05T10:00:02Z",
                (45995, 242, 31232, 0, 14, 46237),
                (25582, 114, 20224, 0, 14, 25696),
            ),
            turn_context_line("gpt-5.6-terra", "2026-08-06T09:00:00Z"),
            token_count_line(
                "2026-08-06T09:00:01Z",
                (1000, 50, 200, 0, 5, 1050),
                (1000, 50, 200, 0, 5, 1050),
            ),
        ];
        let out = codex_fold_file(&events);
        // by_hour_model[hour][model][speed] 的 5 桶（时间轴小时粒度，**北京时间**
        // 键：UTC 08-05T10 → 北京 08-05T18、UTC 08-06T09 → 北京 08-06T17）。
        let sol_d5 = &out["by_hour_model"]["2026-08-05T18"]["gpt-5.6-sol"]["standard"];
        // uncached = input − cached − cache_write（本样例 cache_write 恰为 0；
        // 用变量保留下「派生公式」的字面形状，而不是把 −0 折叠掉）。
        let cache_write = 0;
        assert_eq!(sol_d5["uncached_input_tokens"], json!(45995 - 31232 - cache_write));
        assert_eq!(sol_d5["output_tokens"], json!(242));
        assert_eq!(sol_d5["cached_input_tokens"], json!(31232));
        assert_eq!(sol_d5["reasoning_output_tokens"], json!(14));
        // by_model 跨日期求和：sol 在 08-05 折叠进 1 桶
        let sol = bucket_of(&out, "gpt-5.6-sol", "standard");
        assert_eq!(sol["uncached_input_tokens"], json!(45995 - 31232));
        assert_eq!(sol["output_tokens"], json!(242));
        let terra = bucket_of(&out, "gpt-5.6-terra", "standard");
        assert_eq!(terra["uncached_input_tokens"], json!(800));
        // 守恒：by_hour_model 各小时之和 == by_model。两边各跑一遍 5 桶求和再比，
        // 不拿模型名当字段名查。
        let by_model = out["by_model"].as_object().unwrap();
        let mut sum: std::collections::HashMap<&str, i64> = Default::default();
        for date_map in out["by_hour_model"].as_object().unwrap().values() {
            for speeds in date_map.as_object().unwrap().values() {
                for bucket in speeds.as_object().unwrap().values() {
                    for (i, f) in CODEX_TOKEN_FIELDS.iter().enumerate() {
                        *sum.entry(*f).or_insert(0) += bucket_to_array(bucket)[i];
                    }
                }
            }
        }
        let mut bm_sum: std::collections::HashMap<&str, i64> = Default::default();
        for speeds in by_model.values() {
            for bucket in speeds.as_object().unwrap().values() {
                for (i, f) in CODEX_TOKEN_FIELDS.iter().enumerate() {
                    *bm_sum.entry(*f).or_insert(0) += bucket_to_array(bucket)[i];
                }
            }
        }
        for (f, expected) in sum {
            assert_eq!(bm_sum.get(f).copied().unwrap_or(0), expected,
                       "reconciliation for {f}");
        }
        assert!(out["unaccounted"].as_array().unwrap().is_empty());
    }

    #[test]
    fn fold_file_dedups_identical_total_signatures() {
        // 两种真实复读形态：整段复读（last==total）与清零复读（last 全 0 + 假 total）。
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z"),
            // 真事件：total (100,10,0,0,0,110)，last 增量 (100,10,...)
            token_count_line(
                "2026-08-05T10:00:01Z",
                (100, 10, 0, 0, 0, 110),
                (100, 10, 0, 0, 0, 110),
            ),
            // 整段复读：total 签名不变 → 跳过
            token_count_line(
                "2026-08-05T10:00:02Z",
                (100, 10, 0, 0, 0, 110),
                (100, 10, 0, 0, 0, 110),
            ),
            // 清零复读：total 签名仍不变，last 全 0 + 假 total → 跳过
            token_count_line(
                "2026-08-05T10:00:03Z",
                (100, 10, 0, 0, 0, 110),
                (0, 0, 0, 0, 0, 12345),
            ),
        ];
        let out = codex_fold_file(&events);
        let sol = bucket_of(&out, "gpt-5.6-sol", "standard");
        assert_eq!(sol["uncached_input_tokens"], json!(100));
        assert_eq!(sol["output_tokens"], json!(10));
        assert!(out["unaccounted"].as_array().unwrap().is_empty());
    }

    #[test]
    fn fold_file_reports_unaccounted_before_turn_context() {
        let events = vec![
            token_count_line(
                "2026-08-05T10:00:01Z",
                (100, 10, 0, 0, 0, 110),
                (100, 10, 0, 0, 0, 110),
            ),
        ];
        let out = codex_fold_file(&events);
        assert!(out["by_model"].as_object().unwrap().is_empty());
        let ua = out["unaccounted"].as_array().unwrap();
        assert_eq!(ua.len(), 1);
        assert_eq!(ua[0]["type"], json!("token_count_before_turn_context"));
        assert_eq!(ua[0]["count"], json!(1));
        assert_eq!(ua[0]["tokens_seen"], json!(110));
    }

    #[test]
    fn fold_file_reports_invalid_last_usage() {
        // total 有效签名（去重不拦），但 last 里 reasoning > output → 无效
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z"),
            serde_json::json!({
                "timestamp": "2026-08-05T10:00:01Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 100, "output_tokens": 10,
                            "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                            "reasoning_output_tokens": 3, "total_tokens": 110,
                        },
                        "last_token_usage": {
                            "input_tokens": 100, "output_tokens": 5,
                            "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                            "reasoning_output_tokens": 9, "total_tokens": 110,
                        },
                    }
                }
            }),
        ];
        let out = codex_fold_file(&events);
        assert!(out["by_model"].as_object().unwrap().is_empty());
        let ua = out["unaccounted"].as_array().unwrap();
        assert_eq!(ua[0]["type"], json!("token_count_invalid_last_usage"));
        assert_eq!(ua[0]["tokens_seen"], json!(110));
    }

    #[test]
    fn fold_file_skips_token_count_with_null_info() {
        // 真实语料（2026-08-19 rollout）里 `info` 是 JSON `null`：事件没有任何 token
        // 字段，不是「看见了没接住」，不能进残差哨兵——Py↔Rust 在这条上曾分歧
        // （Rust 把 null 当「有 info」继续走 → 误报 invalid_last_usage；Python 的
        // `isinstance(info, dict)` 直接跳过）。缺键与 null 必须等价跳过。
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-19T02:46:39Z"),
            serde_json::json!({
                "timestamp": "2026-08-19T02:46:40.474Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": null,
                    "rate_limits": {"limit_id": "premium"},
                }
            }),
            serde_json::json!({
                "timestamp": "2026-08-19T02:46:41Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                }
            }),
        ];
        let out = codex_fold_file(&events);
        assert!(out["by_model"].as_object().unwrap().is_empty());
        assert!(out["unaccounted"].as_array().unwrap().is_empty());
        // info:null 的事件虽带 rate_limits，但只有 limit_id（无 plan_type）→ 不是
        // 有效套餐快照，plan 保持 null。
        assert!(out["plan"].is_null());
    }

    #[test]
    fn fold_file_tracks_plan_from_rate_limits() {
        // 真实语料形态：token_count 的 payload.rate_limits 带 plan_type / credits /
        // primary / secondary。plan 块 = 最后看见的有效快照（含 observed_at）。
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-27T23:00:00Z"),
            serde_json::json!({
                "timestamp": "2026-08-27T23:29:09.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 100, "output_tokens": 10,
                            "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                            "reasoning_output_tokens": 0, "total_tokens": 110,
                        },
                        "last_token_usage": {
                            "input_tokens": 100, "output_tokens": 10,
                            "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                            "reasoning_output_tokens": 0, "total_tokens": 110,
                        },
                    },
                    "rate_limits": {
                        "limit_id": "codex", "limit_name": null,
                        "primary":   {"used_percent": 67.0, "window_minutes": 300,   "resets_at": 1787858552},
                        "secondary": {"used_percent": 11.0, "window_minutes": 10080, "resets_at": 1788351817},
                        "credits": {"has_credits": false, "unlimited": false, "balance": "0"},
                        "individual_limit": null, "spend_control_reached": null,
                        "plan_type": "plus", "rate_limit_reached_type": null,
                    },
                }
            }),
        ];
        let out = codex_fold_file(&events);
        let plan = out["plan"].as_object().unwrap();
        assert_eq!(plan["plan_type"], "plus");
        assert_eq!(plan["has_credits"], false);
        assert_eq!(plan["observed_at"], "2026-08-27T23:29:09.000Z");
        let p = plan["limits"]["primary"].as_object().unwrap();
        assert_eq!(p["used_percent"], 67.0);
        assert_eq!(p["window_minutes"], 300);
        assert_eq!(p["resets_at"], 1787858552);
        let s = plan["limits"]["secondary"].as_object().unwrap();
        assert_eq!(s["used_percent"], 11.0);
        assert_eq!(s["window_minutes"], 10080);
        // token 本身照常折叠（plan 是独立状态，不影响桶）
        assert_eq!(bucket_of(&out, "gpt-5.6-sol", "standard")["uncached_input_tokens"], json!(100));
    }

    #[test]
    fn quota_snapshot_validation_stays_in_codex_adapter() {
        let valid = json!({
            "plan_type": "plus",
            "has_credits": false,
            "observed_at": "2026-08-27T23:29:09Z",
            "limits": {
                "primary": {
                    "used_percent": 67.0,
                    "window_minutes": 300,
                    "resets_at": 1787858552,
                }
            }
        });
        assert_eq!(validate_quota_snapshot(&valid), Some(valid.clone()));
        let contract = quota_snapshot_contract(&valid).expect("generic quota contract");
        assert_eq!(contract.plan.as_deref(), Some("plus"));
        assert_eq!(contract.windows.len(), 1);
        assert_eq!(contract.windows[0].resets_at_ms, 1_787_858_552_000);
        assert_eq!(validate_quota_snapshot(&json!({"plan_type": ""})), None);
        assert_eq!(validate_quota_snapshot(&json!({"has_credits": false})), None);
    }

    #[test]
    fn fold_file_plan_last_seen_wins_within_file() {
        // 单文件内配额快照「最后看见的赢」：先 plus 后 pro，observed_at 更新。
        let tc = |ts: &str| {
            serde_json::json!({
                "timestamp": ts,
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": null,
                    "rate_limits": {"plan_type": "plus",
                        "primary": {"used_percent": 10.0, "window_minutes": 300, "resets_at": 1}},
                }
            })
        };
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-01T00:00:00Z"),
            tc("2026-08-01T00:00:01Z"),
            serde_json::json!({
                "timestamp": "2026-08-01T00:00:02Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": null,
                    "rate_limits": {"plan_type": "pro",
                        "primary": {"used_percent": 42.0, "window_minutes": 300, "resets_at": 2}},
                }
            }),
        ];
        let out = codex_fold_file(&events);
        assert_eq!(out["plan"]["plan_type"], "pro");
        assert_eq!(out["plan"]["observed_at"], "2026-08-01T00:00:02Z");
        assert_eq!(out["plan"]["limits"]["primary"]["used_percent"], 42.0);
    }

    #[test]
    fn merge_picks_plan_with_latest_observed_at() {
        // 跨文件合并选「最新快照」：A 的 observed_at 晚于 B → 合并后是 A 的。
        let fold_a = codex_fold_file(&[
            turn_context_line("m1", "2026-08-01T00:00:00Z"),
            serde_json::json!({
                "timestamp": "2026-08-01T00:00:01Z",
                "type": "event_msg",
                "payload": {"type": "token_count", "info": null,
                    "rate_limits": {"plan_type": "plus",
                        "primary": {"used_percent": 90.0, "window_minutes": 300, "resets_at": 9}}},
            }),
        ]);
        let fold_b = codex_fold_file(&[
            turn_context_line("m1", "2026-08-05T00:00:00Z"),
            serde_json::json!({
                "timestamp": "2026-08-05T00:00:01Z",
                "type": "event_msg",
                "payload": {"type": "token_count", "info": null,
                    "rate_limits": {"plan_type": "plus",
                        "primary": {"used_percent": 20.0, "window_minutes": 300, "resets_at": 5}}},
            }),
        ]);
        // fold 顺序打乱（B 先 A 后）也选 observed_at 最大者，不靠数组序。
        let merged = codex_merge_folds(&[fold_b, fold_a]);
        assert_eq!(merged["plan"]["observed_at"], "2026-08-05T00:00:01Z");
        assert_eq!(merged["plan"]["limits"]["primary"]["used_percent"], 20.0);
        // 没有 plan 的 fold 不干扰：全 null → plan null
        let empty = codex_fold_file(&[turn_context_line("m1", "2026-08-01T00:00:00Z")]);
        let merged2 = codex_merge_folds(&[empty]);
        assert!(merged2["plan"].is_null());
    }

    #[test]
    fn null_limits_snapshot_keeps_last_known_limits() {
        // 真实 defect 回归（2026-08-27 18:18 事件）：带限额的快照之后来一个
        // primary/secondary 全 null 的降级快照（只有 plan_type + limit_id），
        // observed_at 前进但 **limits 保留上一次的**——「最后看见」直接覆盖会把
        // 配额条抹掉，正是用户要的功能静默消失。
        let with_limits = serde_json::json!({
            "timestamp": "2026-08-27T14:22:51Z",
            "type": "event_msg",
            "payload": {"type": "token_count", "info": null,
                "rate_limits": {"plan_type": "plus",
                    "primary":   {"used_percent": 2.0, "window_minutes": 300,   "resets_at": 1787858552},
                    "secondary": {"used_percent": 1.0, "window_minutes": 10080, "resets_at": 1788351817}}},
        });
        let degraded = serde_json::json!({
            "timestamp": "2026-08-27T18:18:02.963Z",
            "type": "event_msg",
            "payload": {"type": "token_count", "info": null,
                "rate_limits": {"limit_id": "premium", "plan_type": "plus",
                    "primary": null, "secondary": null}},
        });
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-27T14:00:00Z"),
            with_limits,
            degraded,
        ];
        let out = codex_fold_file(&events);
        let plan = out["plan"].as_object().unwrap();
        assert_eq!(plan["observed_at"], "2026-08-27T18:18:02.963Z"); // observed_at 前进
        assert_eq!(plan["plan_type"], "plus");                       // plan_type 保持最新
        assert_eq!(plan["limits"]["primary"]["used_percent"], 2.0);  // limits 保留
        assert_eq!(plan["limits"]["primary"]["window_minutes"], 300);
        assert_eq!(plan["limits"]["secondary"]["used_percent"], 1.0);
    }

    #[test]
    fn merge_keeps_limits_from_an_older_fold_when_latest_is_degraded() {
        // 跨文件同一语义：A 带限额（observed_at 16:00），B 是降级快照
        // （observed_at 18:00，无 limits）→ 合并后 plan_type/observed_at 取 B 的，
        // limits 取 A 的。
        let fold_a = codex_fold_file(&[
            turn_context_line("m1", "2026-08-01T00:00:00Z"),
            serde_json::json!({
                "timestamp": "2026-08-01T16:00:00Z",
                "type": "event_msg",
                "payload": {"type": "token_count", "info": null,
                    "rate_limits": {"plan_type": "plus",
                        "primary": {"used_percent": 33.0, "window_minutes": 300, "resets_at": 3}}},
            }),
        ]);
        let fold_b = codex_fold_file(&[
            turn_context_line("m1", "2026-08-01T00:00:00Z"),
            serde_json::json!({
                "timestamp": "2026-08-01T18:00:00Z",
                "type": "event_msg",
                "payload": {"type": "token_count", "info": null,
                    "rate_limits": {"limit_id": "premium", "plan_type": "pro",
                        "primary": null, "secondary": null}},
            }),
        ]);
        let merged = codex_merge_folds(&[fold_a, fold_b]);
        assert_eq!(merged["plan"]["observed_at"], "2026-08-01T18:00:00Z");
        assert_eq!(merged["plan"]["plan_type"], "pro");          // 最新的 plan_type
        assert_eq!(merged["plan"]["limits"]["primary"]["used_percent"], 33.0); // A 的限额
    }

    #[test]
    fn fold_file_tracks_speed_cursor() {
        // 没有 service_tier → 默认 standard；thread_settings_applied 切 fast 后，
        // 后面的 token_count 落进 fast 子桶。
        let events = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z"),
            token_count_line(
                "2026-08-05T10:00:01Z",
                (100, 10, 0, 0, 0, 110),
                (100, 10, 0, 0, 0, 110),
            ),
            serde_json::json!({
                "timestamp": "2026-08-05T10:00:02Z",
                "type": "event_msg",
                "payload": {"type": "thread_settings_applied", "thread_settings": {"service_tier": "fast"}},
            }),
            token_count_line(
                "2026-08-05T10:00:03Z",
                (200, 20, 0, 0, 0, 220),
                (100, 10, 0, 0, 0, 110),
            ),
        ];
        let out = codex_fold_file(&events);
        let speeds = out["by_model"]["gpt-5.6-sol"].as_object().unwrap();
        assert!(speeds.contains_key("standard"));
        assert!(speeds.contains_key("fast"));
        assert_eq!(speeds["standard"]["uncached_input_tokens"], json!(100));
        assert_eq!(speeds["fast"]["uncached_input_tokens"], json!(100));
    }

    #[test]
    fn fold_file_drops_untimed_from_time_but_keeps_by_model() {
        // 无时间事件（timestamp 缺失/非 YYYY-MM-DDTHH）：by_model 有、by_hour_model 没有。
        let mut e = token_count_line(
            "2026-08-05T10:00:01Z",
            (100, 10, 0, 0, 0, 110),
            (100, 10, 0, 0, 0, 110),
        );
        e.as_object_mut().unwrap().remove("timestamp");
        let events = vec![turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z"), e];
        let out = codex_fold_file(&events);
        assert!(out["by_hour_model"].as_object().unwrap().is_empty());
        let sol = bucket_of(&out, "gpt-5.6-sol", "standard");
        assert_eq!(sol["uncached_input_tokens"], json!(100));
    }

    #[test]
    fn merge_folds_sums_and_sorts_dates_globally() {
        // fold A 日期 08-05、fold B 日期 08-01：合并后日期必须升序 08-01, 08-05。
        let fa = codex_fold_file(&[turn_context_line("m1", "2026-08-05T00:00:00Z"),
            token_count_line("2026-08-05T00:00:01Z", (10, 1, 0, 0, 0, 11), (10, 1, 0, 0, 0, 11))]);
        let fb = codex_fold_file(&[turn_context_line("m1", "2026-08-01T00:00:00Z"),
            token_count_line("2026-08-01T00:00:01Z", (20, 2, 0, 0, 0, 22), (20, 2, 0, 0, 0, 22))]);
        let merged = codex_merge_folds(&[fa, fb]);
        let hours: Vec<&str> = merged["by_hour_model"].as_object().unwrap().keys().map(String::as_str).collect();
        // 小时键是北京时间：UTC 08-05T00/08-01T00 → 北京同日 T08。
        assert_eq!(hours, vec!["2026-08-01T08", "2026-08-05T08"]);
        let bm = merged["by_model"]["m1"]["standard"].as_object().unwrap();
        assert_eq!(bm["uncached_input_tokens"], json!(30));
        assert_eq!(bm["output_tokens"], json!(3));
    }

    #[test]
    fn by_model_from_hours_reprojects_and_reconciles() {
        // 回归（真实 defect）：codex-cost --month 过滤时间轴后，旧代码拿
        // codex_merge_folds 折回 by_model——但 merge 只读 fold 的 by_model 字段、
        // 不读时间轴，得到空模型轴，整份月报告静默变全零。本测试钉住
        // 重算：全部样本带时间时 by_model_from_hours == merge 的 by_model。
        let events = vec![
            turn_context_line("gpt-5.6-terra", "2026-07-15T09:00:00Z"),
            token_count_line("2026-07-15T09:00:01Z", (100, 20, 30, 5, 2, 155), (100, 20, 30, 5, 2, 155)),
            turn_context_line("gpt-5.6-luna", "2026-07-15T09:01:00Z"),
            token_count_line("2026-07-15T09:01:01Z", (200, 50, 60, 10, 5, 320), (200, 50, 60, 10, 5, 320)),
            turn_context_line("gpt-5.6-sol", "2026-08-01T00:00:00Z"),
            token_count_line("2026-08-01T00:00:01Z", (100, 10, 40, 10, 2, 160), (100, 10, 40, 10, 2, 160)),
        ];
        let fold = codex_fold_file(&events);
        // 全部带时间 → 无 untimed → 两投影严格相等（键序也一致：跨小时首现序
        // terra → luna → sol，与 merge 的 fold 首现序相同）。
        let reproj = codex_by_model_from_hours(&fold["by_hour_model"], None);
        assert_eq!(reproj, fold["by_model"]);
        assert_eq!(
            reproj.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"],
        );

        // 月份过滤后重算（prefix 过滤）：只有 07 的 terra/luna（08 的 sol 被丢），
        // 模型轴随之缩小。
        let jul = codex_by_model_from_hours(&fold["by_hour_model"], Some("2026-07"));
        assert_eq!(jul["gpt-5.6-terra"], fold["by_model"]["gpt-5.6-terra"]);
        assert_eq!(jul["gpt-5.6-luna"], fold["by_model"]["gpt-5.6-luna"]);
        assert!(jul.get("gpt-5.6-sol").is_none(), "过滤掉的日期必须从模型轴消失");
    }

    #[test]
    fn by_model_from_hours_drops_untimed_samples() {
        // 无时间样本（timestamp 缺失）只有 by_model 有、by_hour_model 没有：
        // 过滤重算时它按设计被丢弃（无时间可归），不会出现在重算结果里。
        let mut e = token_count_line(
            "2026-08-05T10:00:01Z",
            (100, 10, 0, 0, 0, 110),
            (100, 10, 0, 0, 0, 110),
        );
        e.as_object_mut().unwrap().remove("timestamp");
        let fold = codex_fold_file(&[
            turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z"),
            e,
        ]);
        assert!(!fold["by_model"].as_object().unwrap().is_empty());
        assert!(fold["by_hour_model"].as_object().unwrap().is_empty());
        let reproj = codex_by_model_from_hours(&fold["by_hour_model"], None);
        assert!(reproj.as_object().unwrap().is_empty());
    }

    #[test]
    fn aggregate_hours_merges_to_dates_and_preserves_order() {
        // 小时桶 → 日期桶：同一小时聚合、不同小时按日归并，日期升序。这是
        // codex_cost_report 的 LC 判定粒度锚点（单日聚合桶判 longContext）。
        let by_hour = json!({
            "2026-08-05T10": {
                "gpt-5.6-sol": {
                    "standard": {
                        "uncached_input_tokens": 100, "output_tokens": 10,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    }
                }
            },
            "2026-08-05T11": {
                "gpt-5.6-sol": {
                    "standard": {
                        "uncached_input_tokens": 50, "output_tokens": 5,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    }
                }
            },
            "2026-08-06T09": {
                "gpt-5.6-terra": {
                    "standard": {
                        "uncached_input_tokens": 200, "output_tokens": 20,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    }
                }
            },
        });
        let agg = codex_aggregate_hours(&by_hour);
        let obj = agg.as_object().unwrap();
        // 日期升序：08-05 先于 08-06。
        let keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["2026-08-05", "2026-08-06"]);
        // 08-05 的两个小时桶合并：uncached 100+50=150。
        let d5 = &obj["2026-08-05"]["gpt-5.6-sol"]["standard"];
        assert_eq!(d5["uncached_input_tokens"], json!(150));
        assert_eq!(d5["output_tokens"], json!(15));
        // 非对象 / 空输入 → 空对象。
        assert!(codex_aggregate_hours(&json!(null)).as_object().unwrap().is_empty());
        assert!(codex_aggregate_hours(&json!({})).as_object().unwrap().is_empty());
    }

    #[test]
    fn hour_of_converts_utc_to_beijing_hours() {
        // 统一多桶折叠契约（docs/UNIFIED_COST_VIEW.md）：时间轴小时桶是**北京**
        // 时间（+8 固定、无夏令时），与 DSH `usage.rs::hour_buckets` 同一条纪律。
        // 此前小时键直接用 UTC 前缀——日历把 UTC 小时当北京小时渲染，且 `--today`
        // 按北京日前缀过滤会把北京凌晨 0-7 点的消费整块丢掉。真机复现
        // 2026-08-29：UTC 00:59 的一次消费显示成「00:00」（实际是北京 08:59）。
        let ev = |ts: &str| serde_json::json!({"timestamp": ts, "type": "event_msg"});
        // 同日 +8。
        assert_eq!(codex_hour_of(&ev("2026-08-25T00:00:00Z")), Some("2026-08-25T08".into()));
        assert_eq!(codex_hour_of(&ev("2026-08-25T15:59:00Z")), Some("2026-08-25T23".into()));
        // 跨日进位。
        assert_eq!(codex_hour_of(&ev("2026-08-25T16:00:00Z")), Some("2026-08-26T00".into()));
        assert_eq!(codex_hour_of(&ev("2026-08-25T23:00:00Z")), Some("2026-08-26T07".into()));
        // 跨年进位。
        assert_eq!(codex_hour_of(&ev("2026-12-31T23:00:00Z")), Some("2027-01-01T07".into()));
        // 真机回归：UTC 08-29T00:59 → 北京 08-29T08（修前错误落在 T00）。
        assert_eq!(
            codex_hour_of(&ev("2026-08-29T00:59:47.055Z")),
            Some("2026-08-29T08".into())
        );
        // 非法结构 / 日历上不存在的日期 / 缺时间戳 → None（未知时间，不编造）。
        assert_eq!(codex_hour_of(&ev("not-a-date")), None);
        assert_eq!(codex_hour_of(&ev("2026-02-30T10:00:00Z")), None);
        assert_eq!(codex_hour_of(&serde_json::json!({"type": "event_msg"})), None);
        // 顶层 `timestamp` 回退 `payload.timestamp`。
        assert_eq!(
            codex_hour_of(&serde_json::json!({
                "type": "event_msg",
                "payload": {"timestamp": "2026-08-25T00:00:00Z"}
            })),
            Some("2026-08-25T08".into())
        );
    }

    #[test]
    fn codex_day_tokens_sums_all_models_and_speeds_of_the_day() {
        // by_date_model = codex_aggregate_hours 的输出形状：{date:{model:{speed:桶}}}。
        // 桶 = 5 字段（uncached_input/output/cached_input/cache_write/reasoning）。
        let by_date = serde_json::json!({
            "2026-08-31": {
                "deepseek-v4-flash": {
                    "standard": {
                        "uncached_input_tokens": 1000, "output_tokens": 200,
                        "cached_input_tokens": 300, "cache_write_input_tokens": 40,
                        "reasoning_output_tokens": 10,
                    },
                    "high": {
                        "uncached_input_tokens": 500, "output_tokens": 100,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    },
                },
                "deepseek-v4-pro": {
                    "standard": {
                        "uncached_input_tokens": 7, "output_tokens": 3,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    },
                },
            },
            "2026-08-30": {
                "deepseek-v4-flash": {
                    "standard": {
                        "uncached_input_tokens": 99999, "output_tokens": 0,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    },
                },
            },
        });
        // 2026-08-31 全模型全速度求和：1550+600+10 = 2160。
        assert_eq!(codex_day_tokens(&by_date, "2026-08-31"), Some(2160));
        // 别的日互不影响。
        assert_eq!(codex_day_tokens(&by_date, "2026-08-30"), Some(99999));
        // 该日没有桶 → None（「测不出」，不是 0 —— 零会话真零在调用方判）。
        assert_eq!(codex_day_tokens(&by_date, "2026-09-01"), None);
        // 非对象输入 → None。
        assert_eq!(codex_day_tokens(&serde_json::json!({"2026-08-31": "x"}), "2026-08-31"), None);
        assert_eq!(codex_day_tokens(&serde_json::json!([]), "2026-08-31"), None);
    }

    #[test]
    fn unaccounted_tokens_seen_sums_sentinel_entries() {
        // 空/缺键 → 0。
        assert_eq!(unaccounted_tokens_seen(&serde_json::json!([])), 0);
        assert_eq!(unaccounted_tokens_seen(&serde_json::json!({"a": 1})), 0);
        let ua = serde_json::json!([
            {"type": "token_count_invalid_last_usage", "count": 2, "tokens_seen": 1200},
            {"type": "token_count_before_turn_context", "count": 1, "tokens_seen": 300},
        ]);
        assert_eq!(unaccounted_tokens_seen(&ua), 1500);
        // 缺 tokens_seen 的条目按 0 计，不崩。
        let partial = serde_json::json!([
            {"type": "x", "count": 1, "tokens_seen": 100},
            {"type": "y", "count": 1},
        ]);
        assert_eq!(unaccounted_tokens_seen(&partial), 100);
    }

    #[test]
    fn state_apply_exposes_fold_outcome_per_token_count() {
        // 共享观察者（spec §2.3）的判别出口必须与 fold 的 by_model 消费集一一对应：
        // valid → Consumed、复读 → Repeat、首 turn_context 前 → Unattributed、
        // reasoning>output → Unreadable、info null → Skip。这是 emitter 分类的依据
        // （spec §4 判别表），钉死防止 apply 与 fold 漂移。
        // 状态独立：before-turn-context 的 token_count 只喂 sig、不折叠。
        let mut st_un = CodexFoldState::new();
        let before = token_count_line(
            "2026-08-05T10:00:01Z",
            (100, 10, 0, 0, 0, 110),
            (100, 10, 0, 0, 0, 110),
        );
        assert_eq!(st_un.apply(&before), CodexTokenOutcome::Unattributed);

        let mut st = CodexFoldState::new();
        assert_eq!(
            st.apply(&turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z")),
            CodexTokenOutcome::NotTokenCount
        );
        let e1 = token_count_line(
            "2026-08-05T10:00:01Z",
            (100, 10, 0, 0, 0, 110),
            (100, 10, 0, 0, 0, 110),
        );
        match st.apply(&e1) {
            CodexTokenOutcome::Consumed { facts, model, event_ts_utc } => {
                assert_eq!(facts, [100, 10, 0, 0, 0]);
                assert_eq!(model, "gpt-5.6-sol");
                assert_eq!(event_ts_utc.as_deref(), Some("2026-08-05T10:00:01Z"));
            }
            other => panic!("expected Consumed, got {other:?}"),
        }
        // 同一 total 签名复读 → Repeat。
        let e2 = token_count_line(
            "2026-08-05T10:00:02Z",
            (100, 10, 0, 0, 0, 110),
            (0, 0, 0, 0, 0, 12345),
        );
        assert_eq!(st.apply(&e2), CodexTokenOutcome::Repeat);
        // reasoning > output → Unreadable。
        let bad = serde_json::json!({
            "timestamp": "2026-08-05T10:00:03Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 100, "output_tokens": 10,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 12, "total_tokens": 110,
                    },
                    "last_token_usage": {
                        "input_tokens": 100, "output_tokens": 5,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 9, "total_tokens": 110,
                    },
                }
            }
        });
        assert_eq!(st.apply(&bad), CodexTokenOutcome::Unreadable);
        // info null → Skip（不进残差哨兵）。
        let info_null = serde_json::json!({
            "timestamp": "2026-08-05T10:00:04Z",
            "type": "event_msg",
            "payload": {"type": "token_count", "info": null, "rate_limits": {"limit_id": "premium"}},
        });
        assert_eq!(st.apply(&info_null), CodexTokenOutcome::Skip);
        // 薄驱动恒等：逐事件 apply + finish == codex_fold_file（byte-neutral 门）。
        let stream = vec![
            turn_context_line("gpt-5.6-sol", "2026-08-05T10:00:00Z"),
            e1, e2, bad, info_null,
        ];
        let mut st2 = CodexFoldState::new();
        for ev in &stream {
            st2.apply(ev);
        }
        assert_eq!(st2.finish(), codex_fold_file(&stream));
    }
}
