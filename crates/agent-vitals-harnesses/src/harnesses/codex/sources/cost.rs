//! Codex 成本计价 —— 把 core 的 `codex_usage` 折叠（5 桶 × 模型 × 小时）变成 USD 费用。
//!
//! 与 DSH 的分工同构：**折叠进 core，计价进 binary**。折叠（`codex_usage.rs`）是纯
//! 规则、零 I/O；计价（本文件）读 `assets/codex_pricing.json`（`include_str!` 内嵌，Python
//! 侧读包内文件）——价格是**业务数据**，不是规则，与 `src/cost.rs` 的 `pricing.json`
//! 同一哲学，且没有 wasm 消费者，所以不进 core。Python 平行实现
//! `packages/agent-vitals-python/agent_vitals/agent/codex_cost.py`，由
//! `both("codex-cost", ...)` 逐字节看守。
//!
//! **计价铁律**（与 cc-trace 的公式逐条对齐，见 `codex_pricing.json` 的 `_doc`）：
//!
//! - **5 桶**：`uncached`·uncachedRate + `cache_read`·cacheReadRate +
//!   `cache_write`·cacheWrite5mRate（Codex 只有一个 cache_write 桶，全部进 5m 档，
//!   1h 恒 0——cc-trace `codex_cache_write_tokens` 同款）；`output`·outputRate。
//!   **reasoning 已计入 output，绝不叠加**。
//! - **speed 是 catalog 的独立行**（不是乘数）：`fast` 行价 = standard 行 ×2 是
//!   catalog 里写死的，不是代码里乘出来的。resolve 时按 `(model, speed)` 匹配。
//! - **长上下文**：官方门槛按单次请求。rollout 只保留聚合桶，无法据此推断附加价；
//!   只有适配器保留并显式标记 `perRequestLongContextEvidence:true` 时才启用对应乘数。
//! - **modelPrefix 最长前缀匹配**：`gpt-5.6-sol` 必须命中 sol 行而不是 `gpt-5.6`
//!   泛化行；`codex-auto-review` 无条目 → unpriced（`priced:false`、token 进
//!   `unpriced_tokens`，诚实上报，绝不按 0 价冒充）。
//! - **USD**：cc-trace 价格表是 USD 权威价，零汇率猜测。与 DSH 的 ¥ 明确区分
//!   （`currency` 字段标到最外层）。
//!
//! **守恒（三轴对账）**：`per_model` 从 `by_model`（完整折叠）计价、`days` 从
//! `by_date_model`（小时聚合回日）计价、`hours` 从 `by_hour_model`（`want_hours`）
//! 计价。无时间戳的样本被时间轴按设计丢弃（与 `usage.rs` 的 untimed 纪律一致）。
//! **per_model 轴先按 (date, model, speed) 逐桶计价、再把 untimed 剩余单独成桶
//! 计价**（见 `codex_cost_report` 的 LC 粒度坑），所以 `sum(days.cost_usd) ==
//! total_cost_usd` 只在全部样本都带时间时精确成立；差异恰好是 untimed 样本的价，
//! 由守恒测试钉死。`hours` 轴用所属日的聚合 LC 判定逐小时计价（乘数线性 →
//! `sum(hours.cost_usd) == sum(days.cost_usd)` 精确对账，today 视图与月视图不会
//! 给出两份价格）。

use std::collections::HashMap;

use jiff::tz::TimeZone;
use jiff::Timestamp;
use serde_json::{json, Map, Value};

pub fn load_codex_pricing() -> Value {
    agent_vitals_domain::cost::load_codex_pricing()
}

fn strip_zero(x: f64) -> String {
    let s = format!("{:.1}", x);
    if s.ends_with(".0") {
        s[..s.len() - 2].to_string()
    } else {
        s
    }
}

/// token 数 → 人类可读：226423948 → 226.4M。与 `cost.rs::format_number` 同 spec。
fn format_number(n: i64) -> String {
    if n >= 1_000_000_000 {
        return strip_zero(n as f64 / 1e9) + "B";
    }
    if n >= 1_000_000 {
        return strip_zero(n as f64 / 1e6) + "M";
    }
    if n >= 1_000 {
        return strip_zero(n as f64 / 1e3) + "K";
    }
    n.to_string()
}

/// 金额 → `$12.34` / `$123.4`。≥100 一位小数否则两位，去尾零。与
/// `cost.rs::format_money` 同一 spec，前缀换成 `$`（USD）。
fn format_usd(x: f64) -> String {
    let s = if x >= 100.0 {
        format!("{:.1}", x)
    } else {
        format!("{:.2}", x)
    };
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    format!("${s}")
}

fn get_i64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// `(model, speed)` → 价格表条目：**最长 modelPrefix 匹配**（`gpt-5.6-sol` 命中
/// sol 行而非 `gpt-5.6` 泛化行）。同长度时先出现的条目赢（catalog 数组序即作者
/// 意图，确定性匹配）。Codex session 的 `model_raw` 可能带 provider 路由前缀
/// （如 `openai/gpt-5.6-sol`），匹配前只剥掉前缀；输出仍保留原始模型名。
/// 找不到 → None（unpriced）。
fn resolve_entry<'a>(model: &str, speed: &str, entries: &'a [Value]) -> Option<&'a Value> {
    agent_vitals_domain::cost::codex_resolve_entry(model, speed, entries)
}

/// longContext 乘数判定。官方门槛属于单次请求，聚合后的小时/日桶不足以提供证据；
/// 没有 `perRequestLongContextEvidence:true` 一律返回 None，避免把累计用量误收为
/// 长上下文附加费。
/// 一个 5 桶对象 × 价格条目 → USD 费用。`reasoning` 桶存在但不参与计价——它已
/// 含在 `output` 里（折叠侧的校验保证 `output >= reasoning`），再乘一次就是双计。
/// `lc`（可选）= 已验证的请求级长上下文乘数；None 时只在条目明确拥有请求级证据时
/// 尝试判定（见 `lc_multipliers`）。
fn price_bucket(bucket: &Value, entry: &Value, lc: Option<(f64, f64)>) -> f64 {
    agent_vitals_domain::cost::codex_price_bucket(bucket, entry, lc)
}

/// 5 桶对象 → `[i64; 5]`（桶序与 `CODEX_TOKEN_FIELDS` 一致）。
fn bucket_fields(bucket: &Value) -> [i64; 5] {
    let mut out = [0i64; 5];
    for (i, f) in crate::codex_usage::CODEX_TOKEN_FIELDS
        .iter()
        .enumerate()
    {
        out[i] = get_i64(bucket, f);
    }
    out
}

fn tokens_object(t: &[i64; 5]) -> Value {
    let mut obj = Map::new();
    for (i, f) in crate::codex_usage::CODEX_TOKEN_FIELDS
        .iter()
        .enumerate()
    {
        obj.insert((*f).to_string(), json!(t[i]));
    }
    Value::Object(obj)
}

/// 窗口分钟数 → 人读标签：300→`5小时`、10080→`每周`、其余 → `Nmin`。与 Codex UI
/// 同款（「5 小时使用限额 / 每周使用限额」）；未知窗口不猜语义，照实显示分钟数。
/// py↔rs 同 spec，文本渲染逐字节对齐（`codex_cost.py::_window_label` 镜像）。
fn window_label(wm: i64) -> String {
    match wm {
        300 => "5小时".to_string(),
        10080 => "每周".to_string(),
        _ => format!("{wm}min"),
    }
}

/// `used_percent` → 人读百分比：固定 3 位小数去尾零（67.0 → 67、67.5 → 67.5）。
/// **不用 Display**——它对小数会走最短表示，与 Python 的 `:g` 在大数/极小值上
/// 分歧；`{:.3}` + 去尾零在两侧完全确定（`codex_cost.py::_pct_text` 镜像）。
fn pct_text(up: f64) -> String {
    let s = format!("{up:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() {
        "0".to_string()
    } else {
        s
    }
}

/// resets_at（Unix 秒）→ 北京时区人读重置时间：今天 → `HH:MM`，否则 →
/// `M月D日 HH:MM`（与 Codex UI 同款：「5 小时使用限额 重置时间：10:03」vs
/// 「每周使用限额 重置时间：2026年9月4日 00:40」）。`today` 参数化以便单测钉住
/// 两个分支；生产路径传 `today_beijing()`。与 `codex_cost.py::_reset_beijing_text_at`
/// 同 spec。日期和偏移由 runtime 的系统 IANA 时区提供。
fn reset_beijing_text_at(resets_at: i64, today: &str, tz: &TimeZone) -> String {
    let zoned = Timestamp::from_second(resets_at)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned(tz.clone());
    let date = zoned.date();
    let (y, m, d) = (date.year(), date.month(), date.day());
    let hhmm = format!("{:02}:{:02}", zoned.hour(), zoned.minute());
    let key = format!("{y:04}-{m:02}-{d:02}");
    if key == today {
        hhmm
    } else {
        format!("{m}月{d}日 {hhmm}")
    }
}

/// plan 块 → 人读一行（None = 无有效套餐，不打印）。数字只格式化不重算——
/// `used_percent` 直接来自日志 rate_limits。**「剩余」= 100 − used**（Codex UI
/// 显示剩余，超限按 0 计——没有负剩余这回事）；重置时间挂北京（今天 → `HH:MM`，
/// 否则 → `M月D日 HH:MM`）。末尾附快照时间戳（ISO 原样）——日志读的是最后一次
/// 写盘时刻，Codex UI 是实时，挂上时间戳诚实标注年龄（拿日志 2% 对 UI 5% 对不上
/// 时看得见原因）。与 `codex_cost.py::_plan_line` 逐字节对齐。
fn plan_line(plan: Option<&Value>, today: &str, tz: &TimeZone) -> Option<String> {
    let plan = plan?.as_object()?;
    let pt = plan.get("plan_type").and_then(|v| v.as_str())?;
    if pt.is_empty() {
        return None;
    }
    let mut parts = vec![format!("{pt}（订阅套餐）")];
    if let Some(limits) = plan.get("limits").and_then(|v| v.as_object()) {
        for (_name, win) in limits {
            let Some(win) = win.as_object() else { continue };
            let Some(up) = win.get("used_percent").and_then(|v| v.as_f64()) else {
                continue;
            };
            let wm = win
                .get("window_minutes")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let remaining = (100.0 - up).max(0.0);
            let mut piece = format!("{} 剩余{}%", window_label(wm), pct_text(remaining));
            if let Some(resets) = win.get("resets_at").and_then(|v| v.as_i64()) {
                piece.push_str(&format!("（重置 {}）", reset_beijing_text_at(resets, today, tz)));
            }
            parts.push(piece);
        }
    }
    if let Some(obs) = plan.get("observed_at").and_then(|v| v.as_str()) {
        parts.push(format!("快照@{obs}"));
    }
    Some(parts.join(" · "))
}

/// 折叠结果 × 价格表 → 结构化成本报告。**这是唯一算价格的地方**——人读文本、
/// `--json`、`--html` 都从这里取数，不是三处各算一遍。
///
/// `by_hour_model` 是折叠的时间轴（小时桶键 `YYYY-MM-DDTHH`）。按日与按小时的
/// 成本都由同一基础费率计算，`want_hours=True` 时输出 `hours` 供 today 视图使用。
///
/// `plan` 是折叠出的配额快照（Value，可为 Null），原样透传到输出——报告不解释
/// 它，展示层自己判「订阅 → 重标价」。
///
/// `None` = 没有任何 token 可计价（空折叠：per_model 空、unpriced 0）。有未计价
/// token 时返回 `Some`（total 0 + unpriced > 0 是「看见了、没价目」的诚实上报）。
///
/// 官方长上下文附加价不能从聚合桶中推断：月/日累计超过阈值均不说明某次请求超过
/// 阈值。当前实现因此报告基础用量价格；以后若 fold 保留每请求证据，可由价格条目
/// 显式启用该项。per_model = 各日期价 + untimed 剩余，所有样本带时间时
/// `sum(days.cost) == total_cost_usd`。
pub fn codex_cost_report(
    by_hour_model: &Value,
    by_model: &Value,
    unaccounted: &Value,
    plan: &Value,
    pricing: &Value,
    want_hours: bool,
) -> Option<Value> {
    let entries = pricing
        .get("entries")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let bm = by_model.as_object()?;

    // ── Pass 0：时间轴聚合 + 日期轴计价 ────────────────────────────────
    // 小时桶先按日聚合（`codex_aggregate_hours`）；
    // 同时记下每个 (model, spd) 的「有日期份额」成本与 token，供 per_model 轴
    // 求 untimed 剩余用。by_date_model 键序 = 聚合的日期升序，days 保持升序。
    let by_date_model = crate::codex_usage::codex_aggregate_hours(by_hour_model);
    let mut dated_cost: HashMap<(String, String), f64> = HashMap::new(); // (model, spd) -> USD 费用（只含有价目桶）
    let mut dated_tokens: HashMap<(String, String), [i64; 5]> = HashMap::new(); // (model, spd) -> [5 桶]
    let mut days: Vec<Value> = Vec::new();
    if let Some(bd) = by_date_model.as_object() {
        for (date, date_map) in bd {
            let Some(date_map) = date_map.as_object() else {
                continue;
            };
            let mut cost: f64 = 0.0;
            let mut toks: i64 = 0;
            for (model, speeds) in date_map {
                let Some(speeds) = speeds.as_object() else {
                    continue;
                };
                for (spd, bucket) in speeds {
                    let facts = bucket_fields(bucket);
                    for f in facts.iter().take(4) {
                        toks += f;
                    }
                    let key = (model.clone(), spd.clone());
                    let dt = dated_tokens.entry(key.clone()).or_insert([0i64; 5]);
                    for (d, f) in dt.iter_mut().zip(facts.iter()) {
                        *d += f;
                    }
                    if let Some(entry) = resolve_entry(model, spd, entries) {
                        let c = price_bucket(bucket, entry, None);
                        cost += c;
                        *dated_cost.entry(key).or_insert(0.0) += c;
                    }
                }
            }
            days.push(json!({
                "date": date,
                "cost_usd": cost,
                "tokens": toks,
            }));
        }
    }

    // ── Pass 0b：小时轴计价（today 视图） ──────────────────────────────
    // 小时桶直接按基础费率计价；小时升序（与 Python 的
    // `sorted(by_hour_model)` 同序——跨文件合并后插入序已升序，再排一次保险）。
    let mut hours: Vec<Value> = Vec::new();
    if want_hours {
        if let Some(bh) = by_hour_model.as_object() {
            let mut hour_keys: Vec<&String> = bh.keys().collect();
            hour_keys.sort();
            for h in hour_keys {
                let Some(hour_map) = bh.get(h).and_then(|v| v.as_object()) else {
                    continue;
                };
                let mut cost: f64 = 0.0;
                let mut toks: i64 = 0;
                for (model, speeds) in hour_map {
                    let Some(speeds) = speeds.as_object() else {
                        continue;
                    };
                    for (spd, bucket) in speeds {
                        let facts = bucket_fields(bucket);
                        for f in facts.iter().take(4) {
                            toks += f;
                        }
                        if let Some(entry) = resolve_entry(model, spd, entries) {
                            cost += price_bucket(bucket, entry, None);
                        }
                    }
                }
                hours.push(json!({
                    "hour": h,
                    "cost_usd": cost,
                    "tokens": toks,
                }));
            }
        }
    }

    // ── Pass 1：per_model / 总价 / 未计价 ──────────────────────────────
    // 遍历顺序 = 折叠的模型首现序（preserve_order 的插入序），与 Python dict 对齐。
    let mut total: f64 = 0.0;
    let mut unpriced: i64 = 0;
    let mut total_tokens = [0i64; 5];
    let mut per_model = Map::new();
    for (model, speeds) in bm {
        let Some(speeds) = speeds.as_object() else {
            continue;
        };
        let mut tokens = [0i64; 5];
        let mut cost: f64 = 0.0;
        let mut all_priced = true;
        let mut speed_names: Vec<String> = Vec::new();
        for (spd, bucket) in speeds {
            let facts = bucket_fields(bucket);
            for (t, f) in tokens.iter_mut().zip(facts.iter()) {
                *t += f;
            }
            if let Some(entry) = resolve_entry(model, spd, entries) {
                let key = (model.clone(), spd.clone());
                let dated = dated_tokens.get(&key).copied().unwrap_or([0i64; 5]);
                // untimed 剩余 = by_model − Σ 各日期桶（fold 保证逐桶 ≥，不会负）。
                let mut untimed = [0i64; 5];
                for i in 0..5 {
                    untimed[i] = facts[i] - dated[i];
                }
                cost += dated_cost.get(&key).copied().unwrap_or(0.0)
                    + price_bucket(&tokens_object(&untimed), entry, None);
            } else {
                // 无价目：token 进 unpriced_tokens，诚实上报——绝不按 0 价冒充。
                all_priced = false;
                unpriced += facts.iter().take(4).sum::<i64>();
            }
            speed_names.push(spd.clone());
        }
        for (t, f) in total_tokens.iter_mut().zip(tokens.iter()) {
            *t += f;
        }
        total += cost;
        per_model.insert(
            model.clone(),
            json!({
                "tokens": tokens_object(&tokens),
                "cost_usd": cost,
                "priced": all_priced,
                // 模型名下可能挂多个 speed 子桶（真实数据只有 standard）；诚实列出
                // 全部 speed，不挑一个代表。
                "speed": speed_names.join(","),
            }),
        );
    }
    if per_model.is_empty() && unpriced == 0 {
        return None;
    }

    let mut out = Map::new();
    out.insert("total_cost_usd".into(), json!(total));
    out.insert("total_tokens".into(), tokens_object(&total_tokens));
    out.insert("per_model".into(), Value::Object(per_model));
    out.insert("days".into(), Value::Array(days));
    out.insert("unpriced_tokens".into(), json!(unpriced));
    out.insert("unaccounted_usage".into(), unaccounted.clone());
    out.insert("plan".into(), plan.clone());
    if want_hours {
        out.insert("hours".into(), Value::Array(hours));
    }
    Some(Value::Object(out))
}

/// 人读文本：harness/月/币种 + 一行总费用 + 每模型一行。纯格式化——数字来自
/// `codex_cost_report` + CLI 的 harness/currency/month 包装（`out` 即 `--json` 输出的
/// 同一个 dict），这里不重算。空报告（None）由调用方处理，不打印假的 `$0` 行。
/// `today` / `tz`：统计时区下的「今天」与时区本身，只用于额度重置时间的人读文本
/// （今天 → `HH:MM`，否则 → `M月D日 HH:MM`）。W3 从 runtime 搬进 harnesses 时改为调用方
/// 传入——harnesses 不读时钟、不读系统时区；runtime 的 `sessions::codex_cost` 薄封装供给。
pub fn render_codex_cost(out: &Value, today: &str, tz: &TimeZone) -> String {
    let currency = out
        .get("currency")
        .and_then(|v| v.as_str())
        .unwrap_or("USD");
    let harness = out.get("harness").and_then(|v| v.as_str());
    let month = out.get("month").and_then(|v| v.as_str());
    let total = out
        .get("total_cost_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let unpriced = out
        .get("unpriced_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let per_model = out
        .get("per_model")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let tt = out
        .get("total_tokens")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut parts = Vec::new();
    if let Some(h) = harness {
        parts.push(format!("harness: {h}\n"));
    }
    if let Some(m) = month {
        parts.push(format!("month: {m}\n"));
    }
    parts.push(format!("currency: {currency}\n"));
    let plan_line = plan_line(out.get("plan"), today, tz);
    if let Some(pl) = &plan_line {
        parts.push(format!("plan: {pl}\n"));
    }
    // reasoning 是 output 的子集，故人读总量只加 4 个独立桶。
    let mut all_tokens: i64 = 0;
    for f in crate::codex_usage::CODEX_TOKEN_FIELDS
        .iter()
        .take(4)
    {
        all_tokens += tt.get(*f).and_then(|x| x.as_i64()).unwrap_or(0);
    }
    // 订阅套餐（plan 存在）时，per-token 美元是「按量标价」不是账单；套餐
    // 缺证据时则是「按量估算，待确认」。两者都不能让用户误读为实际支出。
    let label = if plan_line.is_some() {
        "total cost (按量标价)"
    } else {
        "total cost (按量估算，待确认)"
    };
    let mut line = format!("{label}: {}", format_usd(total));
    if all_tokens > 0 {
        line += &format!(" · total tokens: {}", format_number(all_tokens));
    }
    parts.push(line + "\n");
    // 按折叠的模型首现序展示（per_model 的插入序即 by_model 序）。
    for (model, entry) in &per_model {
        let cost = entry
            .get("cost_usd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let speeds = entry
            .get("speed")
            .and_then(|v| v.as_str())
            .unwrap_or("standard");
        if entry
            .get("priced")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            parts.push(format!("  {model}  {}  ({speeds})\n", format_usd(cost)));
        } else {
            parts.push(format!("  {model}  unpriced  ({speeds})\n"));
        }
    }
    if unpriced > 0 {
        parts.push(format!(
            "另有 {} tokens 模型未计价\n",
            format_number(unpriced)
        ));
    }
    let ua = out
        .get("unaccounted_usage")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for e in &ua {
        let t = e.get("type").and_then(|v| v.as_str()).unwrap_or("?");
        let c = e.get("count").and_then(|v| v.as_i64()).unwrap_or(0);
        let s = e.get("tokens_seen").and_then(|v| v.as_i64()).unwrap_or(0);
        parts.push(format!(
            "未接住 {c} × {t}（看见 {} tokens）\n",
            format_number(s)
        ));
    }
    parts.concat()
}

// ── 默认月 / 今天（系统统计时区）──────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(model_prefix: &str, speed: &str) -> Value {
        json!({
            "modelPrefix": model_prefix,
            "speed": speed,
            "uncachedInputUsdPerMTok": "5",
            "cacheReadUsdPerMTok": "0.5",
            "cacheWrite5mUsdPerMTok": "6.25",
            "cacheWrite1hUsdPerMTok": "10",
            "outputUsdPerMTok": "30",
            "usInferenceMultiplierBps": 10000,
            "longContextThresholdTokens": 272000,
            "longContextInputMultiplierBps": 20000,
            "longContextOutputMultiplierBps": 15000,
            "perRequestLongContextEvidence": true,
        })
    }

    #[test]
    fn resolve_entry_longest_prefix_wins() {
        let entries = serde_json::from_str::<Value>(
            r#"[
            {"modelPrefix":"gpt-5.6","speed":"standard"},
            {"modelPrefix":"gpt-5.6-sol","speed":"standard"}
        ]"#,
        )
        .unwrap();
        let arr = entries.as_array().unwrap();
        let r = resolve_entry("gpt-5.6-sol", "standard", arr).unwrap();
        assert_eq!(r["modelPrefix"], "gpt-5.6-sol");
        let r = resolve_entry("gpt-5.6-terra", "standard", arr).unwrap();
        assert_eq!(r["modelPrefix"], "gpt-5.6");
        let r = resolve_entry("openai/gpt-5.6-sol", "standard", arr).unwrap();
        assert_eq!(r["modelPrefix"], "gpt-5.6-sol");
        // speed 不匹配 → None
        assert!(resolve_entry("gpt-5.6-sol", "fast", arr).is_none());
        // 无条目 → None（unpriced）
        assert!(resolve_entry("codex-auto-review", "standard", arr).is_none());
    }

    #[test]
    fn price_bucket_basic_and_cache_write_goes_to_5m() {
        let e = entry("gpt-5.6-sol", "standard");
        // input_total 必须低于 272000 阈值，否则 longContext 触发——本测试只钉
        // cache_write 进 5m 档 + reasoning 不叠加，不测 longContext。
        let bucket = json!({
            "uncached_input_tokens": 100000,
            "output_tokens": 50000,
            "cached_input_tokens": 100000,
            "cache_write_input_tokens": 50000,
            "reasoning_output_tokens": 5000,
        });
        // input = 0.1M·5 + 0.1M·0.5 + 0.05M·6.25 = 0.5 + 0.05 + 0.3125 = 0.8625
        // output = 0.05M·30 = 1.5   (reasoning 已含，不再叠加)
        // total = 2.3625 USD
        let cost = price_bucket(&bucket, &e, None);
        assert!((cost - 2.3625).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn price_bucket_long_context_multiplies_all_input() {
        let e = entry("gpt-5.6-sol", "standard");
        // input_total 超过 272000 阈值 → input 全桶 ×2、output ×1.5。
        let bucket = json!({
            "uncached_input_tokens": 300000,
            "output_tokens": 100000,
            "cached_input_tokens": 50000,
            "cache_write_input_tokens": 0,
            "reasoning_output_tokens": 0,
        });
        // input = (0.3M·5 + 0.05M·0.5) ·2 = (1.5 + 0.025)·2 = 3.05
        // output = 0.1M·30 ·1.5 = 3·1.5 = 4.5
        // total = 7.55
        let cost = price_bucket(&bucket, &e, None);
        assert!((cost - 7.55).abs() < 1e-9, "got {cost}");
        // 同样比例但低于阈值（input_total 150000 < 272000）：input 不乘 → 0.525 + 3。
        let small = json!({
            "uncached_input_tokens": 100000,
            "output_tokens": 100000,
            "cached_input_tokens": 50000,
            "cache_write_input_tokens": 0,
            "reasoning_output_tokens": 0,
        });
        let cost = price_bucket(&small, &e, None);
        assert!((cost - 3.525).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn price_bucket_long_context_priced_false_skips() {
        // fast 行显式 longContextPriced:false → 即使超阈值也不乘。
        let mut e = entry("gpt-5.6-sol", "fast");
        e.as_object_mut()
            .unwrap()
            .insert("longContextPriced".into(), json!(false));
        let bucket = json!({
            "uncached_input_tokens": 500000,
            "output_tokens": 100000,
            "cached_input_tokens": 0,
            "cache_write_input_tokens": 0,
            "reasoning_output_tokens": 0,
        });
        let cost = price_bucket(&bucket, &e, None);
        // 不过 fast 价格是 10/1/…，这里 entry() 硬编码 standard 价，只测乘数不触发：
        // (0.5M·5 + 0.1M·30)/1e6 = 2.5+3 = 5.5
        assert!((cost - 5.5).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn report_prices_by_model_and_days_and_reconciles() {
        let by_model = json!({
            "gpt-5.6-sol": {
                "standard": {
                    "uncached_input_tokens": 1000000,
                    "output_tokens": 100000,
                    "cached_input_tokens": 500000,
                    "cache_write_input_tokens": 200000,
                    "reasoning_output_tokens": 10000,
                }
            }
        });
        // 时间轴小时桶（统一多桶折叠契约）；报告内先聚合回单日桶再计价。
        let by_hour_model = json!({
            "2026-08-05T00": {
                "gpt-5.6-sol": {
                    "standard": {
                        "uncached_input_tokens": 600000,
                        "output_tokens": 60000,
                        "cached_input_tokens": 300000,
                        "cache_write_input_tokens": 120000,
                        "reasoning_output_tokens": 6000,
                    }
                }
            },
            "2026-08-06T00": {
                "gpt-5.6-sol": {
                    "standard": {
                        "uncached_input_tokens": 400000,
                        "output_tokens": 40000,
                        "cached_input_tokens": 200000,
                        "cache_write_input_tokens": 80000,
                        "reasoning_output_tokens": 4000,
                    }
                }
            }
        });
        let pricing = load_codex_pricing();
        let report = codex_cost_report(
            &by_hour_model,
            &by_model,
            &json!([]),
            &json!(null),
            &pricing,
            false,
        )
        .unwrap();
        // by_date 之和 == by_model → 总价与 days 之和精确相等（守恒）。
        let total = report["total_cost_usd"].as_f64().unwrap();
        let mut day_sum = 0.0;
        for d in report["days"].as_array().unwrap() {
            day_sum += d["cost_usd"].as_f64().unwrap();
        }
        assert!((total - day_sum).abs() < 1e-9);
        let pm = &report["per_model"]["gpt-5.6-sol"];
        assert!(pm["priced"].as_bool().unwrap());
        assert_eq!(pm["speed"], "standard");
        // 没有每请求长上下文证据时，聚合桶不得推断附加费：$7.20。
        assert!((pm["cost_usd"].as_f64().unwrap() - 7.2).abs() < 1e-9);
        assert_eq!(report["days"].as_array().unwrap().len(), 2);
        assert!(report["days"].as_array().unwrap()[0]["date"].as_str() == Some("2026-08-05"));
    }

    #[test]
    fn report_prices_per_day_bucket_not_merged_model_bucket() {
        // 回归（真实 defect）：LC 判定粒度必须是单日桶，不是 by_model 合并桶。两个
        // 日期各自 input_total 200000 < 272000（都不触发 LC），但合并成模型桶后
        // input_total 400000 > 272000。旧实现直接对 by_model 合并桶计价 → 凭空触发
        // LC ×2（4.10 变 6.70），per_model 价高于 days 之和且守恒测试当场红。修正后
        // per_model = Σ 各日期价（无 untimed 时）→ 两边精确相等。
        let day_bucket = json!({
            "uncached_input_tokens": 100000,
            "output_tokens": 50000,
            "cached_input_tokens": 100000,
            "cache_write_input_tokens": 0,
            "reasoning_output_tokens": 0,
        });
        let by_model = json!({
            "gpt-5.6-sol": { "standard": {
                "uncached_input_tokens": 200000,
                "output_tokens": 100000,
                "cached_input_tokens": 200000,
                "cache_write_input_tokens": 0,
                "reasoning_output_tokens": 0,
            } }
        });
        let by_hour_model = json!({
            "2026-08-01T00": { "gpt-5.6-sol": { "standard": day_bucket.clone() } },
            "2026-08-02T00": { "gpt-5.6-sol": { "standard": day_bucket } },
        });
        let pricing = load_codex_pricing();
        let report = codex_cost_report(
            &by_hour_model,
            &by_model,
            &json!([]),
            &json!(null),
            &pricing,
            false,
        )
        .unwrap();
        let total = report["total_cost_usd"].as_f64().unwrap();
        let mut day_sum = 0.0;
        for d in report["days"].as_array().unwrap() {
            day_sum += d["cost_usd"].as_f64().unwrap();
        }
        assert!(
            (total - day_sum).abs() < 1e-9,
            "total {total} != days {day_sum}"
        );
        // 每天按现价 = 0.1M·4 + 0.1M·0.4 + 0.05M·20 = 1.44，两天 2.88。
        assert!((total - 2.88).abs() < 1e-9, "got {total}");
        assert_eq!(report["days"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn report_prices_untimed_remainder_as_its_own_bucket() {
        // by_model 比时间轴（by_hour_model 聚合的日期桶）多出 untimed 份额（无时间
        // 样本被时间轴按设计丢弃）→ per_model = 各日期价 + untimed 剩余单独成桶的价；
        // total == sum(days) + untimed 价精确成立。两个桶各自 input_total 200000 <
        // 272000，谁都不触发 LC——若对合并后的模型桶（400000）判 LC，dated+untimed
        // 都会被多收。
        let by_model = json!({
            "gpt-5.6-sol": { "standard": {
                "uncached_input_tokens": 200000,
                "output_tokens": 100000,
                "cached_input_tokens": 200000,
                "cache_write_input_tokens": 0,
                "reasoning_output_tokens": 0,
            } }
        });
        let by_hour_model = json!({
            "2026-08-01T00": { "gpt-5.6-sol": { "standard": {
                "uncached_input_tokens": 100000,
                "output_tokens": 50000,
                "cached_input_tokens": 100000,
                "cache_write_input_tokens": 0,
                "reasoning_output_tokens": 0,
            } } }
        });
        let pricing = load_codex_pricing();
        let report = codex_cost_report(
            &by_hour_model,
            &by_model,
            &json!([]),
            &json!(null),
            &pricing,
            false,
        )
        .unwrap();
        let total = report["total_cost_usd"].as_f64().unwrap();
        let day_sum = report["days"].as_array().unwrap()[0]["cost_usd"]
            .as_f64()
            .unwrap();
        // dated 1.44 + untimed 1.44 = 2.88；days 只有 1.44。
        assert!((total - 2.88).abs() < 1e-9, "got {total}");
        assert!(
            (total - day_sum - 1.44).abs() < 1e-9,
            "conservation with untimed broken"
        );
    }

    #[test]
    fn report_unpriced_model_surfaces_honestly() {
        let by_model = json!({
            "codex-auto-review": {
                "standard": {
                    "uncached_input_tokens": 5000,
                    "output_tokens": 100,
                    "cached_input_tokens": 0,
                    "cache_write_input_tokens": 0,
                    "reasoning_output_tokens": 0,
                }
            }
        });
        let pricing = load_codex_pricing();
        let report = codex_cost_report(
            &json!({}),
            &by_model,
            &json!([]),
            &json!(null),
            &pricing,
            false,
        )
        .unwrap();
        assert_eq!(report["total_cost_usd"], 0.0);
        assert_eq!(report["unpriced_tokens"], 5100);
        let pm = &report["per_model"]["codex-auto-review"];
        assert_eq!(pm["priced"], false);
    }

    #[test]
    fn report_none_when_nothing_to_price() {
        let pricing = load_codex_pricing();
        assert_eq!(
            codex_cost_report(
                &json!({}),
                &json!({}),
                &json!([]),
                &json!(null),
                &pricing,
                false
            ),
            None
        );
    }

    #[test]
    fn format_usd_spec() {
        assert_eq!(format_usd(9.5), "$9.5");
        assert_eq!(format_usd(0.0964), "$0.1");
        assert_eq!(format_usd(123.4), "$123.4");
        assert_eq!(format_usd(1234.0), "$1234");
        assert_eq!(format_usd(22.38), "$22.38");
        assert_eq!(format_usd(12.0), "$12");
    }

    #[test]
    fn window_label_and_pct_text_are_deterministic() {
        assert_eq!(window_label(300), "5小时");
        assert_eq!(window_label(10080), "每周");
        assert_eq!(window_label(60), "60min");
        // `:g`/Display 在大数/极小值上会分歧——`{:.3}`+去尾零两侧确定。
        assert_eq!(pct_text(67.0), "67");
        assert_eq!(pct_text(67.5), "67.5");
        assert_eq!(pct_text(11.0), "11");
        assert_eq!(pct_text(0.0), "0");
    }

    /// 固定 UTC+8：搬进 harnesses 前这些用例读运行机器的系统时区，换台 UTC 机器就红。
    fn utc8() -> TimeZone {
        TimeZone::fixed(jiff::tz::offset(8))
    }

    #[test]
    fn reset_beijing_text_at_pins_both_branches() {
        // 1787900000 → 2026-08-28 14:53 UTC+8；1788351817 → 2026-09-02 20:23
        // UTC+8（与 codex_cost.py::_reset_beijing_text_at 同 spec）。「今天 → HH:MM、
        // 否则 → M月D日 HH:MM」两个分支各钉一次，与运行当天无关。
        assert_eq!(reset_beijing_text_at(1787900000, "2026-08-28", &utc8()), "14:53");
        assert_eq!(
            reset_beijing_text_at(1787900000, "2026-08-29", &utc8()),
            "8月28日 14:53"
        );
        assert_eq!(reset_beijing_text_at(1788351817, "2026-09-02", &utc8()), "20:23");
        assert_eq!(
            reset_beijing_text_at(1788351817, "2026-09-03", &utc8()),
            "9月2日 20:23"
        );
    }

    #[test]
    fn plan_line_formats_subscription_and_limits() {
        let plan = json!({
            "plan_type": "plus",
            "has_credits": false,
            "limits": {
                "primary": {"used_percent": 67.0, "window_minutes": 300, "resets_at": 1787858552},
                "secondary": {"used_percent": 11.0, "window_minutes": 10080, "resets_at": 1788351817}
            },
            "observed_at": "2026-08-19T..."
        });
        // 重置时间的「今天→HH:MM / 否则→M月D日」分支由 reset_beijing_text_at 单测
        // 钉住；这里不硬编码日期文本（夹具 reset 落在 08-28/09-02，套件在 09-02 跑
        // 时 secondary 恰是「今天」，硬编码日期会随运行日期漂）。钉格式+数字+快照。
        let s = plan_line(Some(&plan), "2000-01-01", &utc8()).unwrap();
        assert!(s.starts_with("plus（订阅套餐） · 5小时 剩余33%"), "{s}");
        assert!(s.contains("每周 剩余89%（重置"), "{s}");
        assert!(s.contains("快照@2026-08-19T..."), "{s}");
        // 无有效 plan_type → None（不打印）；null/缺键同款。
        assert_eq!(plan_line(Some(&json!({"plan_type": ""})), "2000-01-01", &utc8()), None);
        assert_eq!(plan_line(Some(&json!(null)), "2000-01-01", &utc8()), None);
        assert_eq!(plan_line(None, "2000-01-01", &utc8()), None);
    }

    #[test]
    fn report_passes_plan_through() {
        let by_model = json!({
            "gpt-5.6-sol": {
                "standard": {
                    "uncached_input_tokens": 1000,
                    "output_tokens": 500,
                    "cached_input_tokens": 0,
                    "cache_write_input_tokens": 0,
                    "reasoning_output_tokens": 0,
                }
            }
        });
        let plan =
            json!({"plan_type": "plus", "has_credits": false, "observed_at": "2026-08-19T..."});
        let pricing = load_codex_pricing();
        let report =
            codex_cost_report(&json!({}), &by_model, &json!([]), &plan, &pricing, false).unwrap();
        // plan 原样透传，不解释。
        assert_eq!(report["plan"], plan);
        // 没有 plan 时 → null（而非缺失）。
        let r2 = codex_cost_report(
            &json!({}),
            &by_model,
            &json!([]),
            &json!(null),
            &pricing,
            false,
        )
        .unwrap();
        assert!(r2["plan"].is_null());
    }

    #[test]
    fn report_hours_axis_reconciles_with_days_and_uses_date_aggregate_lc() {
        // today 视图（want_hours）：hours 轴与 days 轴精确对账。hour 桶各自
        // input_total 150000 < 272000（单小时不触发 LC），但当日聚合 300000 >
        // 272000 → 两个小时桶都按当日聚合的 LC 乘数计价（乘数线性 →
        // sum(hours) == sum(days)，与 DSH 小时桶同一结构）。
        let hour_bucket = json!({
            "uncached_input_tokens": 150000,
            "output_tokens": 100000,
            "cached_input_tokens": 0,
            "cache_write_input_tokens": 0,
            "reasoning_output_tokens": 0,
        });
        let by_hour_model = json!({
            "2026-08-01T00": { "gpt-5.6-sol": { "standard": hour_bucket.clone() } },
            "2026-08-01T01": { "gpt-5.6-sol": { "standard": hour_bucket } },
        });
        let by_model = json!({
            "gpt-5.6-sol": { "standard": {
                "uncached_input_tokens": 300000,
                "output_tokens": 200000,
                "cached_input_tokens": 0,
                "cache_write_input_tokens": 0,
                "reasoning_output_tokens": 0,
            } }
        });
        let pricing = load_codex_pricing();
        let report = codex_cost_report(
            &by_hour_model,
            &by_model,
            &json!([]),
            &json!(null),
            &pricing,
            true,
        )
        .unwrap();
        // hours 键只在 want_hours 时出现。
        assert!(report.get("hours").is_some());
        let hours = report["hours"].as_array().unwrap();
        assert_eq!(hours.len(), 2);
        // 聚合桶不构成每请求长上下文证据。每小时：0.15M·4 + 0.1M·20 = 2.6。
        let h0 = hours[0]["cost_usd"].as_f64().unwrap();
        assert!((h0 - 2.6).abs() < 1e-9, "got {h0}");
        assert_eq!(hours[0]["hour"], "2026-08-01T00");
        assert_eq!(hours[1]["hour"], "2026-08-01T01");
        // days 轴同样不推断 LC：0.3M·4 + 0.2M·20 = 5.2。
        let day = report["days"].as_array().unwrap()[0]["cost_usd"]
            .as_f64()
            .unwrap();
        assert!((day - 5.2).abs() < 1e-9, "got {day}");
        // 守恒：sum(hours) == sum(days) == total。
        let mut hour_sum = 0.0;
        for h in hours {
            hour_sum += h["cost_usd"].as_f64().unwrap();
        }
        let total = report["total_cost_usd"].as_f64().unwrap();
        assert!(
            (hour_sum - day).abs() < 1e-9,
            "hours {hour_sum} != days {day}"
        );
        assert!(
            (hour_sum - total).abs() < 1e-9,
            "hours {hour_sum} != total {total}"
        );
        // 无 want_hours 时 hours 键必须缺席（--month --json 字节恒等）。
        let r2 = codex_cost_report(
            &by_hour_model,
            &by_model,
            &json!([]),
            &json!(null),
            &pricing,
            false,
        )
        .unwrap();
        assert!(r2.get("hours").is_none());
    }

    #[test]
    fn render_relabels_total_as_按量标价_when_plan_present() {
        let plan = json!({
            "plan_type": "plus",
            "limits": {"primary": {"used_percent": 67.0, "window_minutes": 300, "resets_at": 0}},
            "observed_at": "2026-08-19T..."
        });
        let out = json!({
            "harness": "codex",
            "currency": "USD",
            "month": "2026-08",
            "total_cost_usd": 5.54,
            "total_tokens": {"uncached_input_tokens": 1000000, "output_tokens": 0,
                             "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                             "reasoning_output_tokens": 0},
            "per_model": {},
            "plan": plan,
        });
        let text = render_codex_cost(&out, "2000-01-01", &utc8());
        // 67% → 剩余 33%；重置文本今天分支由 reset_beijing_text_at 单测钉住。
        assert!(
            text.contains("plan: plus（订阅套餐） · 5小时 剩余33%（重置"),
            "{text}"
        );
        assert!(text.contains("快照@2026-08-19T..."), "{text}");
        assert!(text.contains("total cost (按量标价): $5.54"));
        // 无 plan → 旧标签。
        let out2 = json!({
            "harness": "codex", "currency": "USD", "total_cost_usd": 1.0,
            "total_tokens": {"uncached_input_tokens": 1000, "output_tokens": 0,
                             "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                             "reasoning_output_tokens": 0},
            "per_model": {}, "plan": null,
        });
        let text2 = render_codex_cost(&out2, "2000-01-01", &utc8());
        assert!(text2.contains("total cost (按量估算，待确认): $1"));
        assert!(!text2.contains("按量标价"));
    }
}
