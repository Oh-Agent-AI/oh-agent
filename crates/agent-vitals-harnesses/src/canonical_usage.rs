//! canonical 归一层——把各来源（DSH / Codex / Codex-total）自己折好的桶映射成
//! 一张统一维表（FRESH/TOTAL/cache/reasoning/legacy），让「#6 事件桥」能把不同
//! 执行环境的用量排进同一行。
//!
//! **跨执行环境 wire 归一 = adapter 段**，phase C 从 `domain/usage.rs` 迁进
//! `adapters/canonical_usage.rs`。**生产代码零调用点**（`SOURCE_CODEX` 从来只有
//! 测试在用，`canonical_tokens` 的生产接线是给未做的 #6 事件桥留的）——测试
//! 仍在 `domain/usage.rs::tests`（复用那里的 `reconcile_fixture`），经
//! `crate::canonical_usage::*` 调进来。Python 平行实现 `usage.py` 同名函数。
//!
//! 复用 `token_by_model` / `codex_fold_file`：它们各自已把去重、派生、残差哨兵
//! 做完，canonical 只做「求和 + 归一 + 守卫」，不重新裁决任何一件事。
//!
//! **诚实性契约（每条维）**：量不到 → `null` + 进 `unavailable`，绝不摆 0。
//! 整批没样本 → 全部维 null；某维源字段整批没上报 → 该维 null；来源 schema
//! 本就没有的维（DSH 无 reasoning）→ 恒 null。守卫：任何维 `>= 0`、且
//! `fresh <= total`；累计快照回退 → 不产负数。
//!
//! **delta vs cumulative**：`dsh`/`codex` 形状事件流样本是增量、直接求和；
//! `codex-total` 形状 `total_token_usage` 是累计快照，`canonical_total_delta`
//! 显式做 prev→cur 差分，绝不拿累计当增量。

use serde_json::{json, Map, Value};

use crate::harnesses::codex::sessions::usage::{codex_fold_file, total_signature};
use agent_vitals_domain::usage::{
    token_by_model, SOURCE_CLI, SOURCE_CODEX, SOURCE_DSH_BACKFILL, SOURCE_DSH_LIVE,
    SOURCE_UNSPECIFIED,
};

/// canonical 层的统一维清单（`unavailable` 的取值空间）。顺序固定，Python 侧
/// `usage.py::CANONICAL_DIMS` 逐字节对齐。
pub const CANONICAL_DIMS: [&str; 6] = [
    "fresh_input_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "legacy_total_tokens",
];

/// canonical 层的 shape 标签。shape 由**来源标签**声明该走哪张翻译表，不是由
/// 事件内容猜的——caller 把 dsh 事件标成 codex 是 caller 的 bug，这里只按声明
/// 翻译；标错的结果在 `unavailable` 里诚实可见（零样本 → 全 unavailable）。
pub const SHAPE_DSH: &str = "dsh";
pub const SHAPE_CODEX: &str = "codex";
pub const SHAPE_CODEX_TOTAL: &str = "codex-total";
pub const SHAPE_UNKNOWN: &str = "unknown";

/// 组装一行 canonical 输出。值全为 `Option<i64>`——None 落 `null` 且进
/// `unavailable`，绝不落 0。`unavailable` 顺序 = `CANONICAL_DIMS` 顺序
/// （确定性，两侧逐字节一致依赖这份顺序）。Python 平行实现
/// `usage.py::_canonical_row`。
///
/// 8 个参数（source/shape + 6 维）是「把一条维的可用性契约写死在签名里」——
/// 改成传 `[Option<i64>; 6]` 会丢掉每个位置的语义，还让 Python 镜像更绕。
/// 与 `r2a.rs`/`trajectory.rs` 的同类辅助同款 allow。
#[allow(clippy::too_many_arguments)]
fn canonical_row(
    source: &str,
    shape: &str,
    fresh: Option<i64>,
    total: Option<i64>,
    cache_read: Option<i64>,
    cache_write: Option<i64>,
    reasoning: Option<i64>,
    legacy_total: Option<i64>,
) -> Value {
    let mut cur = Map::new();
    cur.insert("source".to_string(), json!(source));
    cur.insert("shape".to_string(), json!(shape));
    let vals = [fresh, total, cache_read, cache_write, reasoning, legacy_total];
    let mut unavailable = Vec::new();
    for (dim, v) in CANONICAL_DIMS.iter().zip(vals.iter()) {
        match v {
            Some(n) => {
                cur.insert((*dim).to_string(), json!(n));
            }
            None => {
                cur.insert((*dim).to_string(), Value::Null);
                unavailable.push(json!(*dim));
            }
        }
    }
    cur.insert("unavailable".to_string(), Value::Array(unavailable));
    Value::Object(cur)
}

/// DSH 形状 → canonical 行。复用 `token_by_model`（已经做完 post_fork、同
/// (turn, step) 去重、`unreported_fields` 收集）——canonical 只归一，不重折。
///
/// DSH 4 桶：`inputTokens`(=uncached 全价)、`outputTokens`（reasoning 已含在
/// output，不另计）、`cacheReadTokens`、`cacheWriteTokens`。所以
/// FRESH = input、TOTAL = input + output + cacheRead + cacheWrite。
/// `unreported_fields`（fold 自己收集的「执行环境没报的字段名」）决定哪几维落
/// null——naive 是把缺字段的桶按 0 求和完事，那正是 UI 曾经显示「缓存写 0」
/// 一个伪造测量值的形态。
fn canonical_from_dsh(events: &[Value], source: &str) -> Value {
    let tm = token_by_model(events);
    let by_model = tm.get("by_model").and_then(|v| v.as_object());
    let mut fresh = 0i64;
    let mut output = 0i64;
    let mut cache_read = 0i64;
    let mut cache_write = 0i64;
    if let Some(bm) = by_model {
        for b in bm.values() {
            fresh += b.get("uncached_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            output += b.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            cache_read += b.get("cache_read_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
            cache_write += b.get("cache_write_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
        }
    }
    let had_samples = by_model.map(|m| !m.is_empty()).unwrap_or(false);
    if !had_samples {
        // 整批没有 usage 样本 → 全部维 null + 全量 unavailable（不是测到 0）。
        return canonical_row(source, SHAPE_DSH, None, None, None, None, None, None);
    }
    let unreported: Vec<&str> = tm
        .get("unreported_fields")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let input_ok = !unreported.contains(&"inputTokens");
    let output_ok = !unreported.contains(&"outputTokens");
    let cache_read_ok = !unreported.contains(&"cacheReadTokens");
    let cache_write_ok = !unreported.contains(&"cacheWriteTokens");
    // FRESH/TOTAL 依赖两个 headline 量（input/output）；cache_* 缺席只影响
    // 各自维，TOTAL 仍是「测到的全量之和」（DSH 的 cacheWrite 结构上恒 0）。
    let fresh_v = input_ok.then_some(fresh);
    let total_v = (input_ok && output_ok)
        .then_some(fresh + output + cache_read + cache_write);
    let cache_read_v = cache_read_ok.then_some(cache_read);
    let cache_write_v = cache_write_ok.then_some(cache_write);
    // DSH schema 没有 reasoning 维（含在 output 里）→ 恒 null + unavailable。
    canonical_row(source, SHAPE_DSH, fresh_v, total_v, cache_read_v, cache_write_v, None, None)
}

/// Codex 形状 → canonical 行。复用 `codex_fold_file`（读完 `last_token_usage` 的
/// per-turn delta，无效样本已进 unaccounted）——canonical 只归一。
///
/// Codex 5 桶：`uncached_input`/`output`/`cached_input`/`cache_write_input`/
/// `reasoning_output`，其中 `cached + cache_write` 已经是 input 的一部分
/// （wire 的 `input_tokens` 是**总** input，uncached = input − cached −
/// cache_write）。所以 TOTAL = input_tokens + output_tokens =
/// uncached + output + cached + cache_write（reasoning 在 output 里，不另加）；
/// FRESH = uncached（全价 input）；cache_read 映射到 `cached_input`（就是
/// 命中缓存读的那部分 input）。
fn canonical_from_codex(events: &[Value], source: &str) -> Value {
    let fold = codex_fold_file(events);
    let by_model = fold.get("by_model").and_then(|v| v.as_object());
    let mut fresh = 0i64;
    let mut output = 0i64;
    let mut cached = 0i64;
    let mut cache_write = 0i64;
    let mut reasoning = 0i64;
    let mut any = false;
    if let Some(bm) = by_model {
        for speeds in bm.values() {
            if let Some(sp) = speeds.as_object() {
                for bucket in sp.values() {
                    any = true;
                    fresh += bucket.get("uncached_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    output += bucket.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    cached += bucket.get("cached_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    cache_write += bucket.get("cache_write_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    reasoning += bucket.get("reasoning_output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                }
            }
        }
    }
    if !any {
        return canonical_row(source, SHAPE_CODEX, None, None, None, None, None, None);
    }
    // 5 桶来自同一份 last_token_usage，`codex_token_facts` 已保证 uncached>=0、
    // reasoning<=output —— 没有「某维没测到」的中间态，unavailable 为空。
    canonical_row(
        source,
        SHAPE_CODEX,
        Some(fresh),
        Some(fresh + output + cached + cache_write),
        Some(cached),
        Some(cache_write),
        Some(reasoning),
        None,
    )
}

/// Codex `total_token_usage`（每 item 的**累计快照**）→ canonical 行。prev/cur
/// 都是 `total_token_usage` 对象（caller 负责从 `payload.info.total_token_usage`
/// 提取），本函数只做差分，不碰事件流。
///
/// delta 语义（为什么 naive 直接拿 cur 当增量是错的——cc-trace over-read 教训、
/// `codex_fold_file` 的 continuous-dedup 同一条铁律）：
///   - `prev == None`：第一条累计快照，没有基线算不出 delta → fresh/total 为
///     null + unavailable，但 `legacy_total_tokens` 放 raw 累计值（「只有老格式
///     才带的字段」放 legacy 槽，诚实披露，绝不把总量拆成编造的四桶）。
///   - prev 与 cur 签名相同：同一计量复读 → delta 全 0（**测到** 0，不是没测到
///     ——累计没变就是没新开销）。
///   - 任一 delta < 0：累计回退（跨会话/畸形数据）→ 不产负数，fresh/total
///     null + unavailable，raw 累计照放。
///   - 其余：逐字段差分，uncached 从 delta 派生（d_input − d_cached − d_cw），
///     守卫 uncached >= 0、fresh <= total。
pub fn canonical_total_delta(prev: Option<&Value>, cur: &Value, source: &str) -> Value {
    let legacy = cur.get("total_tokens").and_then(|v| v.as_i64());
    let Some(cur_sig) = total_signature(cur) else {
        // 签名缺任一字段 → 连「同一计量复读」都判不了（`codex_fold_file` 对
        // 同样的情况直接放弃去重），canonical 同样不产 delta。
        return canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy);
    };
    let Some(prev_sig) = prev.and_then(total_signature) else {
        // 第一条快照：无基线。
        return canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy);
    };
    if cur_sig == prev_sig {
        // 同一计量复读 → 测到 0。
        return canonical_row(source, SHAPE_CODEX_TOTAL, Some(0), Some(0), Some(0), Some(0), Some(0), legacy);
    }
    // 签名元组：(input, output, cached, cache_write, reasoning, total_tokens)。
    let d = [
        cur_sig.0 - prev_sig.0,
        cur_sig.1 - prev_sig.1,
        cur_sig.2 - prev_sig.2,
        cur_sig.3 - prev_sig.3,
        cur_sig.4 - prev_sig.4,
    ];
    if d.iter().any(|&x| x < 0) {
        // 累计回退 → 不产负数。
        return canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy);
    }
    let d_uncached = d[0] - d[2] - d[3];
    if d_uncached < 0 {
        return canonical_row(source, SHAPE_CODEX_TOTAL, None, None, None, None, None, legacy);
    }
    // TOTAL = d_input + d_output = uncached + output + cached + cache_write。
    let fresh = d_uncached;
    let total = d_uncached + d[1] + d[2] + d[3];
    debug_assert!(fresh <= total, "FRESH 是 TOTAL 的真子集，不可能反超");
    canonical_row(source, SHAPE_CODEX_TOTAL, Some(fresh), Some(total), Some(d[2]), Some(d[3]), Some(d[4]), legacy)
}

/// canonical 归一主入口：`(events, source)` → 一行统一 canonical 计数。
///
/// 来源标签声明 shape（走哪张翻译表）：dsh-live / dsh-backfill / cli /
/// unspecified → dsh；codex → codex。未知来源标签 → shape=unknown、全维
/// unavailable——不摆全零结构冒充「测到了什么」（诚实降级，与
/// `by_source_labels_missing_source_as_unspecified_not_fabricated` 同一条纪律）。
///
/// 调查结论（#4，带证据）：**Codex 事件现在并不进 `token_by_date_model`**。
/// 生产调用点只有 `src/agent/oneline.rs:157`（SOURCE_CLI）与
/// `scripts/agent_vitals/cli.py:1401`（SOURCE_CLI），喂的都是 DSH 形状的
/// `usage_events`（`src/dsh.rs` 只产 DSH 事件）；Codex 走的是完全独立的管线
/// （`main.rs` codex-cost 路径 → `codex_fold_file`/`codex_aggregate_hours`/
/// `codex_cost.rs`），`codex_session.py` 适配器保持 Codex item 原样、任何一层
/// 都没有把它预翻译成 DSH 形状。`SOURCE_CODEX` 因此只有测试在用。canonical
/// 层建好后的接法就是本函数：DSH 事件喂 dsh 形状、Codex 事件喂 codex 形状，
/// 各自归一成同一行——#6 事件桥在此基础上做跨源合并，不再需要任何一层预翻译。
pub fn canonical_tokens(events: &[Value], source: &str) -> Value {
    match source {
        SOURCE_DSH_LIVE | SOURCE_DSH_BACKFILL | SOURCE_CLI | SOURCE_UNSPECIFIED => {
            canonical_from_dsh(events, source)
        }
        SOURCE_CODEX => canonical_from_codex(events, source),
        _ => canonical_row(source, SHAPE_UNKNOWN, None, None, None, None, None, None),
    }
}
