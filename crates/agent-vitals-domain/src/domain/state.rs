//! 状态写链的**纯合并规则** —— `scripts/agent_vitals/agent/state.py` 的
//! `_merge_buckets` / `_merge_model_buckets` / `rotate_today` / `merge_today` /
//! `merge_month` / `_archive_days` 的 Rust 镜像。单一真相源：所有读改写逻辑
//! 在这里，二进制 `src/agent/state.rs` 只做 I/O（读文件 → 调这里 → 原子写回）。
//!
//! 四个状态文件、四种写入语义（与 `state.py` 头部文档逐条对应）：
//!
//!   oneline.json / alert.json  单次审计快照，原地**覆盖**，不是历史。
//!   today.json                 当日 24 小时桶的**累计**聚合（同一小时多会话累加）。
//!   month.json                 **只保存当前自然月**逐日聚合；跨月日子迁进归档。
//!   month-archive.json         跨月归档，逐日**替换**（迁移幂等）；对已归档月的
//!                              回填是**累加**（新证据不能覆盖已有数据）。
//!
//! 不变量（2026-08 三个真机事故各自用测试钉死，改数字 = 两边一起改）：
//!
//!   · month.json 里每个 token 只被记一次，归属它自己的日期，由 `merge_month`
//!     独家负责 —— `rotate_today` 只做「清空当日累加器换新日期」，**绝不**把旧
//!     桶搬进 month.json。历史上 rotate 也搬（`_move_today_to_month`），导致
//!     2026-08 月账 3 倍虚增（¥1733 → ¥2386）。见 `rotate_today_state` 注释。
//!   · 迁移先于落新数据（逐日替换幂等）——保证「同一天只存在于一个文件里」，
//!     崩溃重跑不重复计数。
//!   · 回填累计时 `prev` 必须来自**迁移写完之后**的归档：若同一天既被迁移又被
//!     回填（跨月后重跑上个月的 oneline），prev 缺一次就丢一天已记账目 —— 与
//!     Python `merge_month` 在 `if old_days:` 里二次 `_read(archive)` 同一点。
//!
//! 时间全部由调用方注入（`today_key` / `current` / `now_iso`），本模块不含时钟；
//! 逐字节一致性由 `tests/test_state_write_chain.py`（Python 侧钉数值）+ 二进制
//! `#[cfg(test)]`（Rust 侧钉同一组数）+ `CliMatrix` 差分（同一 HOME 跑两边、
//! `generated_at`/`archived_at` 打码）三层锁住。

use serde_json::{json, Map, Value};

/// `state.py::SCHEMA_VERSION`。写链里每个文件都带。
pub const SCHEMA_VERSION: &str = "1.0.0";

/// 8 个 token 桶字段 —— 与 `usage.rs::hour_buckets` 单条 row / `_merge_buckets`
/// 的 `FIELDS` 同一清单。顺序无关紧要（落盘前递归 sort_keys），但字段名是契约。
const BUCKET_FIELDS: [&str; 8] = [
    "uncached_input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "peak_uncached_input_tokens",
    "peak_output_tokens",
    "peak_cache_read_tokens",
    "peak_cache_write_tokens",
];

/// 空桶 —— Python 每次 `setdefault` 新建一个 `{8 字段全 0}` 字面量。这里每次
/// 新建（不共享可变对象），与 Python 的语义一致。
fn zero_bucket() -> Value {
    let mut m = Map::new();
    for f in BUCKET_FIELDS {
        m.insert(f.to_string(), json!(0));
    }
    Value::Object(m)
}

/// 复刻 Python `str(x)` 对桶 key 的渲染 —— `_merge_buckets` 的
/// `k = str(nb.get(key_field))`。`None` → `"None"`（Python `str(None)`），
/// Bool → `True`/`False`，Number 走 serde Display（与 Python `str(float)` 同
/// 最短可往返算法），String 原样。
fn py_str_key(v: Option<&Value>) -> String {
    match v {
        None => "None".to_string(),
        Some(Value::Bool(b)) => {
            if *b {
                "True".to_string()
            } else {
                "False".to_string()
            }
        }
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// 复刻 Python `str(date_str)[:7]` —— 取前 7 个**字符**（不是字节），出 `YYYY-MM`。
pub fn month_key_of(date_str: &str) -> String {
    date_str.chars().take(7).collect()
}

/// 复刻 `_merge_buckets(existing, new_buckets, key_field)`。
///
/// 两个字段是**故意解耦**的：`if nb.get("date") is None: continue` 只看 `date`
/// （缺时间戳的样本不进日历），`k = str(nb.get(key_field))` 用另一个字段当 key
/// （today 用 `hour`、month 用 `date`）。所以一个 bucket 缺 `key_field` 会以
/// `"None"` 为 key 落进同一个桶，而缺 `date` 会被整条跳过 —— 别自作聪明把两处
/// 合并成一个判断，Python 就是这么写的，改语义会让差分翻红。
pub fn merge_buckets(existing: Option<&Value>, new_buckets: &Value, key_field: &str) -> Value {
    let mut out = existing
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let rows: &[Value] = match new_buckets.as_array() {
        Some(a) => a,
        None => &[],
    };
    for nb in rows {
        let date = nb.get("date");
        if date.is_none() || date.is_some_and(Value::is_null) {
            continue;
        }
        let k = py_str_key(nb.get(key_field));
        let Some(obj) = out.as_object_mut() else {
            continue;
        };
        let cur = obj.entry(k).or_insert_with(zero_bucket);
        for f in BUCKET_FIELDS {
            let add = nb.get(f).and_then(Value::as_i64).unwrap_or(0);
            // `cur.get(f, 0) + (nb.get(f) or 0)`：现有值 + 新值；字段缺失 /
            // null / 0 都按 0。token 恒为整数，浮点字段两边会分叉 —— 那是
            // 「文件里混进浮点 token」的病态输入，不在任何夹具里。
            let cur_v = cur.get(f).and_then(Value::as_i64).unwrap_or(0);
            cur[f] = json!(cur_v + add);
        }
    }
    out
}

/// 复刻 `_merge_model_buckets(existing, by_model)`。
///
/// **不复用** `merge_buckets`：那边 `date` 缺失整条跳过的逻辑是给 hour_buckets
/// 行（缺时间戳不进日历）准备的；按模型的行根本没有 `date` 字段，套用会把
/// 每一行都当「时间缺失」整批跳过。按模型直接 `(by_model or {}).items()`。
pub fn merge_model_buckets(existing: Option<&Value>, by_model: &Value) -> Value {
    let mut out = existing
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(obj) = by_model.as_object() {
        for (model, b) in obj {
            let Some(target) = out.as_object_mut() else {
                continue;
            };
            let cur = target.entry(model.clone()).or_insert_with(zero_bucket);
            for f in BUCKET_FIELDS {
                let add = b.get(f).and_then(Value::as_i64).unwrap_or(0);
                let cur_v = cur.get(f).and_then(Value::as_i64).unwrap_or(0);
                cur[f] = json!(cur_v + add);
            }
        }
    }
    out
}

/// 把一个 source 的 `{model: 8桶}` 合进 `day["by_source"][source]`（键不存在则
/// 建）——与 `merge_model_buckets` 同一语义，只多一层 source 键。单独提出来
/// 是因为 `merge_buckets` 只读 8 个 token 字段、不碰 by_model 也不碰 by_source，
/// 所以 by_source 要像 by_model 一样在 merge_buckets 之外单独折（`merge_month_body`
/// 的当前月与历史月回填两处都调它）。
fn merge_source_into_day(day: &mut Value, source: &str, models: &Value) {
    let prev = day
        .get("by_source")
        .and_then(Value::as_object)
        .and_then(|b| b.get(source))
        .cloned();
    let nb = merge_model_buckets(prev.as_ref(), models);
    if let Some(obj) = day.as_object_mut() {
        let entry = obj.entry("by_source".to_string()).or_insert_with(|| json!({}));
        entry[source] = nb;
    }
}

/// 把 month.json 的**逐日** by_source（`days[date]["by_source"] = {source: {model: 8桶}}`）
/// 折平成 `{source: {model: 8桶}}`——给 `state by-source` / 日历按来源合计用。
///
/// 逐日结构在 month.json 里是对的（按天归位、随天一起归档），但「本月各来源
/// 各自贡献多少」需要在展示侧按天折平；不折平的话，诊断「同一批被喂了几次」
/// 就要肉眼跨所有天求和。
pub fn rollup_by_source(month_json: &Value) -> Value {
    let mut out = Map::new();
    let Some(days) = month_json.get("days").and_then(Value::as_object) else {
        return Value::Object(out);
    };
    for day in days.values() {
        let Some(bs) = day.get("by_source").and_then(Value::as_object) else {
            continue;
        };
        for (source, models) in bs {
            let Some(models) = models.as_object() else {
                continue;
            };
            for (model, buckets) in models {
                let src_entry = out.entry(source.clone()).or_insert_with(|| json!({}));
                // serde_json 的 Value 没有 entry —— 先 as_object_mut 拿 Map。
                let m_entry = if let Some(obj) = src_entry.as_object_mut() {
                    obj.entry(model.clone()).or_insert_with(zero_bucket)
                } else {
                    continue;
                };
                for f in BUCKET_FIELDS {
                    let add = buckets.get(f).and_then(Value::as_i64).unwrap_or(0);
                    let cur_v = m_entry.get(f).and_then(Value::as_i64).unwrap_or(0);
                    m_entry[f] = json!(cur_v + add);
                }
            }
        }
    }
    Value::Object(out)
}

/// 把 month.json 的**逐日** by_model（`days[date]["by_model"] = {model: 8桶}`）
/// 折平成 `{model: 8桶}`——v0.7 spec §3「按 provider/model 月成本」视图的输入：
/// 零新数据、零新持久化，纯粹把已有的逐日 by_model 折平成月度粒度再喂给既有
/// `cost::cost_report`。与 `rollup_by_source` 同一折法，只是不带 source 那层键
/// ——直接复用 `merge_model_buckets` 而不是像 `rollup_by_source` 那样手写循环。
pub fn rollup_by_model(month_json: &Value) -> Value {
    let mut out = json!({});
    let Some(days) = month_json.get("days").and_then(Value::as_object) else {
        return out;
    };
    for day in days.values() {
        let Some(by_model) = day.get("by_model") else {
            continue;
        };
        out = merge_model_buckets(Some(&out), by_model);
    }
    out
}

/// 复刻 `rotate_today(now=...)` 的纯函数一半：旧日期 ≠ 新日期时，把 today.json
/// **整体替换**成「空桶 + 新日期 + rotated_from」；否则不动。
///
/// **不搬旧数据进 month.json** —— 那是 `merge_month` 的独家职责（2026-08 的
/// 3 倍虚增事故：rotate 搬一遍 + merge_month 按桶自带 date 记一遍 + 手跑 oneline
/// 又一遍，每天正好 3 倍，¥1733 → ¥2386）。这里只清空当日累加器。
///
/// 返回 `Some(新内容)` = 发生过 rotate（调用方负责原子写回）；`None` = 无需滚动。
/// 注意整文件替换意味着旧文件里日期之外的其他 key 一并丢弃 —— 与 Python 重建
/// 整个 dict 一致。
pub fn rotate_today_state(existing: &Value, today_key: &str, now_iso: &str) -> Option<Value> {
    let old = existing.get("date");
    if let Some(old) = old {
        if py_str_key(Some(old)) != today_key {
            return Some(json!({
                "schema_version": SCHEMA_VERSION,
                "date": today_key,
                "buckets": {},
                "generated_at": now_iso,
                "rotated_from": old,
            }));
        }
    }
    None
}

/// 复刻 `merge_today` 在 `rotate_today()` 之后的合并体。`existing` 必须是
/// **rotate 之后**的 today.json 内容（同一天或新空桶）。
///
/// 两道关键防御（都是真机事故换来的，见 `state.py::merge_today` 长注释）：
///
///   · **先按 date 过滤再按 hour 折叠** —— `merge_buckets(..., "hour")` 完全不
///     看 date，一次 oneline 审计任意一份日志，若其事件落在 21/22 点，不管哪
///     一天的 21/22 点都会被塞进今天。先把不属于今天的桶滤掉。
///   · `dated and not todays → 丢弃 by_model` 是**兜底**不是主防线 —— 它只能
///     挡「整段都不是今天」，挡不住「整段里只有一部分是今天」（跨日长会话 +
///     compact，hour 桶被滤成只剩今天 245,760 token、整段 by_model 却是
///     17,596,160，差 70 倍）。真正的正确性来自调用方传对切片。没有任何带日期
///     的桶时**保留** by_model —— 宁可收进可能不该收的账，也不能把真 today 的
///     数据（恰好没测到时间戳）误判成「不是今天」丢掉。
pub fn merge_today_state(
    existing: &Value,
    hb: &Value,
    by_model: Option<&Value>,
    today_key: &str,
    now_iso: &str,
) -> Value {
    let rows: Vec<Value> = hb
        .get("buckets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let dated: Vec<Value> = rows
        .iter()
        .filter(|b| !b.get("date").map_or(true, |d| d.is_null()))
        .cloned()
        .collect();
    let todays: Vec<Value> = dated
        .iter()
        .filter(|b| b.get("date").and_then(Value::as_str) == Some(today_key))
        .cloned()
        .collect();
    let mut by_model = by_model.cloned();
    if by_model.is_some() && !dated.is_empty() && todays.is_empty() {
        by_model = None;
    }

    let mut out = existing.clone();
    let merged = merge_buckets(existing.get("buckets"), &Value::Array(todays), "hour");
    out["buckets"] = merged;
    if let Some(bm) = &by_model {
        out["by_model"] = merge_model_buckets(existing.get("by_model"), bm);
    }
    out["schema_version"] = json!(SCHEMA_VERSION);
    out["generated_at"] = json!(now_iso);
    out["date"] = json!(today_key);
    out
}

/// 复刻 `merge_month` 第 ① 步的 dict 推导：existing `days` 里不属于当前月的日子。
/// 纯筛分，不写文件 —— 二进制拿到结果先 `add_days_to_archive`（迁移，替换语义）。
pub fn stale_days(existing: &Value, current: &str) -> Value {
    let mut out = Map::new();
    if let Some(days) = existing.get("days").and_then(Value::as_object) {
        for (d, b) in days {
            if month_key_of(d) != current {
                out.insert(d.clone(), b.clone());
            }
        }
    }
    Value::Object(out)
}

/// `merge_month` 合并体的产物：新的 month.json 内容 + 需要**累加**进归档的回填日。
pub struct MonthMergeBody {
    /// 新的 month.json 全文（含 schema_version / generated_at / month）。
    pub month_json: Value,
    /// `{date: 已与归档已有天数累计的 day}` —— 历史月回填，二进制写归档用。
    pub backfill_days: Value,
}

/// 复刻 `merge_month` 的主体（第 ② 步以后）。`archive` 必须是**已经写入 stale
/// 迁移之后**的归档内容 —— Python 在 `if old_days:` 里是二次 `_read(archive)`，
/// 这时归档里已经含刚迁入的旧月日子；如果回填时拿迁移前的归档当 `prev`，跨月后
/// 重跑上个月的 oneline 会把「刚迁走的完整一天」当成不存在，只回填本次新量，
/// 已记账目静默丢失（这是 `merge_month` 头注释里「先迁旧月、再落新数据」顺序
/// 保证的「同一天只存在于一个文件里」的另一半）。
pub fn merge_month_body(
    existing: &Value,
    hb: &Value,
    by_date_model: Option<&Value>,
    current: &str,
    now_iso: &str,
    archive: &Value,
) -> MonthMergeBody {
    let mut existing = existing.clone();

    // ① 把 month.json 里不属于当前月的日子滤掉（真正的迁移写回由二进制做，
    //    这里只算 stale 并清理 existing —— 与 Python `if stale:` 块同序）。
    let stale = stale_days(&existing, current);
    if stale.as_object().is_some_and(|m| !m.is_empty()) {
        if let Some(days) = existing.get("days").and_then(Value::as_object) {
            let kept: Map<String, Value> = days
                .iter()
                .filter(|(d, _)| month_key_of(d) == current)
                .map(|(d, b)| (d.clone(), b.clone()))
                .collect();
            existing["days"] = Value::Object(kept);
        }
    }

    // ② 新数据按各自日期折叠 —— `_merge_buckets({}, hb.buckets, key_field="date")`
    //    （`get("buckets", [])` —— 缺 key 按空数组折叠）。
    let empty = json!({});
    let hb_buckets = hb.get("buckets").unwrap_or(&empty);
    let mut merged = merge_buckets(None, hb_buckets, "date");
    if let Some(bdm) = by_date_model.and_then(Value::as_object) {
        for (date_key, bm) in bdm {
            // `token_by_date_model` 的 by_source 轴是顶层并列键，不是日期——
            // 跳过，单独按「日期 → source → 模型」折（见下）。不跳的话它会被
            // 当成某一天，merge_model_buckets 会把 `{date: {source: {model}}}`
            // 整段塞进 by_model，月账直接错一个量级。
            if date_key == "by_source" {
                continue;
            }
            // `if not by_model: continue` —— 空对象 / null 跳过。
            let empty = bm.as_object().map_or(true, |m| m.is_empty());
            if empty {
                continue;
            }
            if !merged
                .as_object()
                .is_some_and(|m| m.contains_key(date_key))
            {
                let Some(m) = merged.as_object_mut() else {
                    continue;
                };
                m.insert(date_key.clone(), zero_bucket());
            }
            let day_bm = merged.get(date_key).and_then(|d| d.get("by_model"));
            let nb = merge_model_buckets(day_bm, bm);
            merged[date_key]["by_model"] = nb;
        }
        // by_source 也折进 merged，让下面的 cur/old 分流统一携带它 —— 与
        // by_model 同一套语义（合并、日期缺桶补零桶），只多一层 source 键。
        let bs = bdm.get("by_source").and_then(Value::as_object);
        if let Some(bs) = bs {
            for (date_key, sources) in bs {
                let Some(sources) = sources.as_object() else { continue };
                if !merged
                    .as_object()
                    .is_some_and(|m| m.contains_key(date_key))
                {
                    let Some(m) = merged.as_object_mut() else {
                        continue;
                    };
                    m.insert(date_key.clone(), zero_bucket());
                }
                let Some(day) = merged.get_mut(date_key) else {
                    continue;
                };
                for (src, models) in sources {
                    merge_source_into_day(day, src, models);
                }
            }
        }
    }

    // ③ 拆当前月 / 历史月。**当前月一律按真实时间算**，不读 month.json 的 month
    //    字段（那个是写入时刻盖的戳，跨月后会和 days 实际内容不一致 —— 真实事故：
    //    9 月的 month.json 还留着 8 月日子，month 却写着 "2026-09"）。
    let mut cur_days = Map::new();
    let mut old_days = Map::new();
    if let Some(m) = merged.as_object() {
        for (d, b) in m {
            if month_key_of(d) == current {
                cur_days.insert(d.clone(), b.clone());
            } else {
                old_days.insert(d.clone(), b.clone());
            }
        }
    }

    // ④ cur_days 折进 existing["days"]（date 折叠）；by_model 单独折（merge_buckets
    //    只读 8 个 token 字段，不碰 by_model，所以得另走一遍）。
    let cur_rows: Vec<Value> = cur_days
        .iter()
        .map(|(d, b)| {
            let mut row = b.clone();
            row["date"] = json!(d);
            row
        })
        .collect();
    existing["days"] = merge_buckets(existing.get("days"), &Value::Array(cur_rows), "date");
    for (d, b) in &cur_days {
        if let Some(bm) = b.get("by_model") {
            let day_bm = existing
                .get("days")
                .and_then(|days| days.get(d))
                .and_then(|day| day.get("by_model"));
            let nb = merge_model_buckets(day_bm, bm);
            existing["days"][d]["by_model"] = nb;
        }
        // by_source 与 by_model 一样在 merge_buckets 之外单独折 ——
        // merge_buckets 只读 8 个 token 字段，会把 by_source 丢回 new_day。
        if let Some(bs) = b.get("by_source").and_then(Value::as_object) {
            if let Some(day) = existing.get_mut("days").and_then(|days| days.get_mut(d)) {
                for (src, models) in bs {
                    merge_source_into_day(day, src, models);
                }
            }
        }
    }

    // ⑤ 历史月回填：累加进归档里已有的那一天，而不是替换 —— 本次输入是「新测到
    //    的量」，不是那天的完整累计。`prev` 来自迁移后的归档（见本函数头注释）。
    let mut rebuilt = Map::new();
    if !old_days.is_empty() {
        for (d, b) in &old_days {
            let prev = archive
                .get("months")
                .and_then(Value::as_object)
                .and_then(|m| m.get(&month_key_of(d)))
                .and_then(|e| e.get("days"))
                .and_then(Value::as_object)
                .and_then(|dm| dm.get(d))
                .cloned();
            let mut acc = match &prev {
                Some(p) => {
                    let mut row = p.clone();
                    row["date"] = json!(d);
                    merge_buckets(None, &Value::Array(vec![row]), "date")
                }
                None => json!({}),
            };
            let mut row = b.clone();
            row["date"] = json!(d);
            acc = merge_buckets(Some(&acc), &Value::Array(vec![row]), "date");
            let has_bm = b.get("by_model").is_some()
                || prev.as_ref().and_then(|p| p.get("by_model")).is_some();
            if has_bm {
                let p_bm = prev.as_ref().and_then(|p| p.get("by_model"));
                let b_bm = b.get("by_model");
                let nb = merge_model_buckets(
                    p_bm,
                    b_bm.filter(|v| !v.is_null()).unwrap_or(&json!({})),
                );
                acc[d]["by_model"] = nb;
            }
            // by_source 的回填也是累加（prev 的 source 桶 ∪ 本次的），不是替换——
            // 同一天被回填两次，两个来源各留各的键。
            let has_bs = b.get("by_source").is_some()
                || prev.as_ref().and_then(|p| p.get("by_source")).is_some();
            if has_bs {
                let p_bs = prev.as_ref().and_then(|p| p.get("by_source"));
                let b_bs = b.get("by_source");
                if let Some(day) = acc.get_mut(d) {
                    if let Some(bs) = p_bs.and_then(Value::as_object) {
                        for (src, models) in bs {
                            merge_source_into_day(day, src, models);
                        }
                    }
                    if let Some(bs) = b_bs.and_then(Value::as_object) {
                        for (src, models) in bs {
                            merge_source_into_day(day, src, models);
                        }
                    }
                }
            }
            rebuilt.insert(d.clone(), acc.get(d).cloned().unwrap_or_else(zero_bucket));
        }
    }

    existing["schema_version"] = json!(SCHEMA_VERSION);
    existing["generated_at"] = json!(now_iso);
    existing["month"] = json!(current);

    MonthMergeBody {
        month_json: existing,
        backfill_days: Value::Object(rebuilt),
    }
}

/// 复刻 `_archive_days`：把 `days_by_date`（`{date: day}`）写进归档，**逐日替换**
/// 而非累加。迁移幂等 —— 写完归档还没来得及从 month.json 删掉就崩溃，重跑得到
/// 同样结果，不会把那天算两遍。
///
/// 返回新的归档全文（调用方负责原子写回）。空输入原样返回（Python 直接 `return`）。
pub fn add_days_to_archive(archive: &Value, days_by_date: &Value, now_iso: &str) -> Value {
    let days_obj = match days_by_date.as_object() {
        Some(d) if !d.is_empty() => d,
        _ => return archive.clone(),
    };
    let mut out = archive.clone();
    if out.get("months").is_none() {
        out["months"] = json!({});
    }
    for (date_str, day) in days_obj {
        let m = month_key_of(date_str);
        let Some(months) = out["months"].as_object_mut() else {
            continue;
        };
        let entry = months.entry(m).or_insert_with(|| json!({"days": {}}));
        entry["days"][date_str] = day.clone();
        entry["archived_at"] = json!(now_iso);
    }
    out["schema_version"] = json!(SCHEMA_VERSION);
    out
}

// ────────────────────────── 纯函数单测 ──────────────────────────
// 与 `tests/test_state_write_chain.py` 钉同一组数值，docstring 互相指认。
// 改数字 = 两边一起改；任何一边单独漂移，另一侧的测试就失去参照。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_buckets_accumulates_same_key_and_skips_undated() {
        // 对应 Python `_merge_buckets_accumulates_same_key_and_skips_undated`：
        // 同 hour 两次审计累加；缺 date 的样本整条跳过；缺 hour 的样本以 "None"
        // 为 key 落进同一桶（Python `str(None)`）。
        let hb = json!({
            "buckets": [
                {"date": "2026-08-28", "hour": 21,
                 "uncached_input_tokens": 100, "output_tokens": 10,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 200, "peak_output_tokens": 20,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                {"date": "2026-08-28", "hour": 21,
                 "uncached_input_tokens": 50, "output_tokens": 5,
                 "cache_read_tokens": 0, "cache_write_tokens": 0,
                 "peak_uncached_input_tokens": 50, "peak_output_tokens": 5,
                 "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                {"hour": 22, "uncached_input_tokens": 999},          // 缺 date → 跳过
                {"date": "2026-08-28", "uncached_input_tokens": 7},  // 缺 hour → key "None"
            ],
        });
        let out = merge_buckets(None, hb.get("buckets").unwrap(), "hour");
        let obj = out.as_object().unwrap();
        assert_eq!(obj["21"]["uncached_input_tokens"], 150);
        assert_eq!(obj["21"]["output_tokens"], 15);
        assert_eq!(obj["21"]["peak_uncached_input_tokens"], 250);
        assert_eq!(obj["None"]["uncached_input_tokens"], 7);
        assert_eq!(obj.len(), 2); // "22" 没进来（date 缺失整条跳过）
    }

    #[test]
    fn merge_buckets_merges_into_existing() {
        // 对应 Python `_merge_buckets_merges_into_existing`：existing 有值，
        // 再折一批按 key 累加，未触达的 key 保留。
        let existing = json!({"9": {"uncached_input_tokens": 100, "output_tokens": 1,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 100, "peak_output_tokens": 1,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0}});
        let new = json!({"buckets": [
            {"date": "2026-08-28", "hour": 9, "uncached_input_tokens": 30},
        ]});
        let out = merge_buckets(Some(&existing), new.get("buckets").unwrap(), "hour");
        let obj = out.as_object().unwrap();
        assert_eq!(obj["9"]["uncached_input_tokens"], 130);
        assert_eq!(obj["9"]["output_tokens"], 1); // 新行缺的字段按 0 加
        assert_eq!(obj.len(), 1);
    }

    #[test]
    fn merge_model_buckets_accumulates_per_model() {
        // 对应 Python `_merge_model_buckets_accumulates_per_model`：按模型累加
        // 8 字段；existing=None 时从空建；b 缺字段按 0。
        let bm = json!({
            "deepseek-v4-flash": {
                "uncached_input_tokens": 1000, "output_tokens": 100,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 2000, "peak_output_tokens": 200,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            },
        });
        let out = merge_model_buckets(None, &bm);
        let obj = out.as_object().unwrap();
        assert_eq!(obj["deepseek-v4-flash"]["uncached_input_tokens"], 1000);
        assert_eq!(obj["deepseek-v4-flash"]["peak_output_tokens"], 200);
        assert_eq!(obj.len(), 1);
        // 再折一次 → 累加
        let out2 = merge_model_buckets(Some(&out), &bm);
        assert_eq!(out2["deepseek-v4-flash"]["uncached_input_tokens"], 2000);
    }

    #[test]
    fn rotate_today_state_replaces_on_date_change_only() {
        // 对应 Python `rotate_today` 语义：旧日期 ≠ 新日期 → 整文件替换成
        // 空桶 + rotated_from；同一天 → None（不动）。
        let same = json!({"date": "2026-08-28", "buckets": {"21": {}}});
        assert!(rotate_today_state(&same, "2026-08-28", "t0").is_none());

        let old = json!({"date": "2026-08-27", "buckets": {"21": {"uncached_input_tokens": 5}}});
        let rotated = rotate_today_state(&old, "2026-08-28", "t0").unwrap();
        assert_eq!(rotated["date"], "2026-08-28");
        assert_eq!(rotated["rotated_from"], "2026-08-27");
        assert_eq!(rotated["buckets"], json!({}));
        assert_eq!(rotated["generated_at"], "t0");
        // 整文件替换：旧桶丢弃（rotate 不搬 month，见 merge_month 独占注释）
        assert!(rotated.get("buckets").unwrap().as_object().unwrap().is_empty());
    }

    #[test]
    fn merge_today_filters_by_date_then_folds_by_hour() {
        // 对应 Python `merge_today` 的「先按 date 过滤再按 hour 折叠」：
        // 桶里混着昨天 21 点，today_key 是今天 → 昨天的 21 点不进 today.json
        //（真机复现：北京时间 15:10 看日历，热力图却有 21/22 点 —— 物理上
        // 不可能，一天还没过完）。
        let hb = json!({
            "buckets": [
                {"date": "2026-08-28", "hour": 9, "uncached_input_tokens": 100},
                {"date": "2026-08-27", "hour": 21, "uncached_input_tokens": 999},
            ],
        });
        let existing = json!({});
        let out = merge_today_state(&existing, &hb, None, "2026-08-28", "t0");
        let buckets = out["buckets"].as_object().unwrap();
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets["9"]["uncached_input_tokens"], 100);
        assert_eq!(out["date"], "2026-08-28");
        assert_eq!(out["schema_version"], SCHEMA_VERSION);
        assert_eq!(out["generated_at"], "t0");
        // by_model 未传 → 不写该字段
        assert!(out.get("by_model").is_none());
    }

    #[test]
    fn merge_today_drops_by_model_when_nothing_today_but_keeps_when_no_dated() {
        // 对应 Python 的两道防御：
        //   · 有带日期的桶但一个都不属于今天 → 丢弃 by_model（兜底，不写假账）。
        //   · 没有任何带日期的桶 → 保留 by_model（不能把真 today 但恰好没测到
        //     时间戳的数据误判成「不是今天」）。
        let hb_other_day = json!({"buckets": [
            {"date": "2026-08-27", "hour": 9, "uncached_input_tokens": 1},
        ]});
        let bm = json!({"deepseek-v4-flash": {"uncached_input_tokens": 100}});
        let out = merge_today_state(&json!({}), &hb_other_day, Some(&bm), "2026-08-28", "t0");
        assert!(out.get("by_model").is_none());

        let hb_undated = json!({"buckets": [
            {"hour": 9, "uncached_input_tokens": 1},
        ]});
        let out2 = merge_today_state(&json!({}), &hb_undated, Some(&bm), "2026-08-28", "t0");
        assert_eq!(out2["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 100);
    }

    #[test]
    fn stale_days_filters_non_current_month() {
        // 对应 Python `merge_month` 第 ① 步推导：当前月是 2026-09 → 8 月日子
        // 是 stale 迁移候选，9 月日子留在 month.json。
        let existing = json!({
            "days": {
                "2026-08-31": {"uncached_input_tokens": 1},
                "2026-09-01": {"uncached_input_tokens": 2},
                "2026-08-30": {"uncached_input_tokens": 3},
            },
        });
        let stale = stale_days(&existing, "2026-09");
        let obj = stale.as_object().unwrap();
        assert_eq!(obj.len(), 2);
        assert!(obj.contains_key("2026-08-31"));
        assert!(obj.contains_key("2026-08-30"));
        assert!(!obj.contains_key("2026-09-01"));
    }

    #[test]
    fn merge_month_migrates_then_merges_current() {
        // 对应 Python `merge_month` 主路径：existing 里 8 月 30 日迁走；新数据
        // 9 月 1 日折进 days；month 字段 = 真实当前月（不读文件里盖的戳）。
        let existing = json!({
            "month": "2026-08",   // 盖的旧戳 —— 不按它过滤
            "days": {
                "2026-08-30": {"uncached_input_tokens": 10, "output_tokens": 1,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 10, "peak_output_tokens": 1,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
            },
        });
        let hb = json!({"buckets": [
            {"date": "2026-09-01", "hour": 9, "uncached_input_tokens": 100},
            {"date": "2026-09-01", "hour": 10, "uncached_input_tokens": 50},
        ]});
        let bdm = json!({
            "2026-09-01": {"deepseek-v4-flash": {
                "uncached_input_tokens": 150, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 150, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0}},
        });
        let body = merge_month_body(&existing, &hb, Some(&bdm), "2026-09", "t0", &json!({}));
        let mj = body.month_json.as_object().unwrap();
        assert_eq!(mj["month"], "2026-09");
        let days = mj["days"].as_object().unwrap();
        assert_eq!(days.len(), 1); // 8-30 迁走了
        assert_eq!(days["2026-09-01"]["uncached_input_tokens"], 150);
        assert_eq!(days["2026-09-01"]["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 150);
        assert!(body.backfill_days.as_object().unwrap().is_empty());
    }

    #[test]
    fn merge_month_backfills_accumulate_onto_migrated_prev() {
        // 对应 Python `merge_month` 的 `if old_days:` 回填：归档已有 08-30 的
        // 完整一天（刚被迁移进来），新数据又报 08-30 的量 → 累加而不是替换。
        // 这里模拟「迁移后的归档」，即 `archive` 已含 08-30 —— 二进制保证这个
        // 顺序（先写 stale 迁移、再拿新归档算回填），Python 是二次 `_read`。
        let archive = json!({
            "months": {
                "2026-08": {"days": {
                    "2026-08-30": {"uncached_input_tokens": 10, "output_tokens": 1,
                        "cache_read_tokens": 0, "cache_write_tokens": 0,
                        "peak_uncached_input_tokens": 10, "peak_output_tokens": 1,
                        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0},
                }},
            },
        });
        let existing = json!({"days": {}});
        let hb = json!({"buckets": [
            {"date": "2026-08-30", "hour": 9, "uncached_input_tokens": 5},
        ]});
        let body = merge_month_body(&existing, &hb, None, "2026-09", "t0", &archive);
        let bf = body.backfill_days.as_object().unwrap();
        assert_eq!(bf.len(), 1);
        let day = bf["2026-08-30"].as_object().unwrap();
        assert_eq!(day["uncached_input_tokens"], 15); // 10（已归档）+ 5（新量）
        // month.json 里 8 月日子不该出现（回填只进归档）
        assert_eq!(body.month_json["days"].as_object().unwrap().len(), 0);
    }

    /// per-source 拆账进月账：同一批会话喂两次（两个来源标签），
    /// `days[date].by_source` 必须保留两个来源行——诊断「同一批被喂了几次」靠
    /// 的就是并存的来源键；主桶累加（总量翻倍）但 by_source 各来源行各一份，
    /// 这正是「只见翻倍总数 → 一眼看出哪两个来源」的差。
    #[test]
    fn merge_month_keeps_by_source_rows_per_source() {
        let existing = json!({"days": {}});
        let hb = json!({"buckets": [
            {"date": "2026-09-01", "hour": 9, "uncached_input_tokens": 100},
        ]});
        let day_bm = json!({"pro": {
            "uncached_input_tokens": 100, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 100, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0}});
        let bdm = json!({
            "2026-09-01": day_bm.clone(),
            "by_source": {"2026-09-01": {"dsh-live": day_bm.clone()}},
        });
        let body = merge_month_body(&existing, &hb, Some(&bdm), "2026-09", "t0", &json!({}));
        let days = body.month_json["days"].as_object().unwrap();
        assert_eq!(days.len(), 1, "by_source 键不能被当成日期塞进 days");
        let bs = days["2026-09-01"]["by_source"].as_object().unwrap();
        assert!(bs.contains_key("dsh-live"));
        assert_eq!(bs["dsh-live"]["pro"]["uncached_input_tokens"], 100);

        // 同一天再喂一次，来源不同 → 两个来源行并存，不是互相覆盖。
        let bdm2 = json!({
            "2026-09-01": day_bm.clone(),
            "by_source": {"2026-09-01": {"cli": day_bm.clone()}},
        });
        let body2 = merge_month_body(&body.month_json, &hb, Some(&bdm2), "2026-09", "t1", &json!({}));
        let days2 = body2.month_json["days"].as_object().unwrap();
        let bs2 = days2["2026-09-01"]["by_source"].as_object().unwrap();
        assert!(bs2.contains_key("dsh-live"));
        assert!(bs2.contains_key("cli"));
        assert_eq!(bs2["dsh-live"]["pro"]["uncached_input_tokens"], 100);
        assert_eq!(bs2["cli"]["pro"]["uncached_input_tokens"], 100);
        assert_eq!(days2["2026-09-01"]["uncached_input_tokens"], 200);
    }

    #[test]
    fn rollup_by_source_flattens_per_day_rows() {
        // 逐日 by_source 折平成 source → 模型 —— `state by-source` 读 month.json
        // 全靠它；跨天同一来源必须累加。
        let month = json!({
            "days": {
                "2026-09-01": {"by_source": {"cli": {"pro": {"uncached_input_tokens": 100}}}},
                "2026-09-02": {"by_source": {"cli": {"pro": {"uncached_input_tokens": 50}}}},
            },
        });
        let out = rollup_by_source(&month);
        assert_eq!(out["cli"]["pro"]["uncached_input_tokens"], 150);
    }

    #[test]
    fn rollup_by_model_flattens_per_day_rows() {
        // 逐日 by_model 折平成模型 → 8桶——v0.7 spec §3「按 provider/model
        // 月成本」视图读 month.json 全靠它；跨天同一模型必须累加。与
        // rollup_by_source 同一份夹具形状，只是不带 source 那层键。
        let month = json!({
            "days": {
                "2026-09-01": {"by_model": {"pro": {"uncached_input_tokens": 100}}},
                "2026-09-02": {"by_model": {"pro": {"uncached_input_tokens": 50}}},
            },
        });
        let out = rollup_by_model(&month);
        assert_eq!(out["pro"]["uncached_input_tokens"], 150);
    }

    #[test]
    fn rollup_by_model_empty_days_is_empty_object() {
        // 没有 by_model 的老月份 → 空对象，不摆全零结构（与 by_model_report
        // 的「两个键都空」诚实降级一致）。
        assert_eq!(rollup_by_model(&json!({"days": {}})), json!({}));
        assert_eq!(rollup_by_model(&json!({})), json!({}));
    }

    #[test]
    fn add_days_to_archive_replaces_per_day() {
        // 对应 Python `_archive_days`：逐日替换（幂等），同一天重写不累加；
        // 每次写入更新该月的 archived_at 与顶层 schema_version。
        let archive = json!({
            "months": {
                "2026-08": {"days": {
                    "2026-08-30": {"uncached_input_tokens": 1},
                }, "archived_at": "old"},
            },
        });
        let days = json!({
            "2026-08-30": {"uncached_input_tokens": 99},
            "2026-08-31": {"uncached_input_tokens": 2},
        });
        let out = add_days_to_archive(&archive, &days, "t1");
        let months = out["months"].as_object().unwrap();
        assert_eq!(months["2026-08"]["days"]["2026-08-30"]["uncached_input_tokens"], 99); // 替换
        assert_eq!(months["2026-08"]["days"]["2026-08-31"]["uncached_input_tokens"], 2);
        assert_eq!(months["2026-08"]["archived_at"], "t1");
        assert_eq!(out["schema_version"], SCHEMA_VERSION);
        assert_eq!(out["months"].as_object().unwrap().len(), 1); // 只动了 2026-08
    }

    #[test]
    fn month_key_of_takes_first_seven_chars() {
        // 对应 Python `str(date_str)[:7]`（字符切片，非字节）。
        assert_eq!(month_key_of("2026-08-30"), "2026-08");
        assert_eq!(month_key_of("2026-8-1"), "2026-8-");
    }
}
