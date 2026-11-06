//! 会话级成本折叠 —— 把 usage 事件按当时活跃的模型分桶。
//!
//! 与 `behavior` 模块（SV601–610 风险规则）是两条正交的审计维度：风险规则
//! 输出 finding 列表，这里输出 `{"by_model": {...}, "sequence": [...]}`。
//! 浏览器 tab 经 wasm 与 CLI 共用这一份引擎 —— never a second copy。
//!
//! 折叠语义与 DSH token-meter（packages/llm/token-meter/src/usage-projection.ts
//! 的 tokenUsageProjectionDefinition）完全一致，并已用真实日志对账：各桶之和
//! == tokenUsage 投影累计值（94997694 会话 180577354/498735/712320/0 逐字节
//! 一致）。Python 平行实现见 `scripts/agent_vitals/agent/usage.py`，差分防护在本文件
//! 的 parity 测试与 `tests/test_cli_matrix.py` 的双实现逐字节比较。
//!
//! 三个关键语义（为什么这样实现，对应共性缺陷）：
//! - **按模型分桶**：request/header 的 config.model 会在会话中途变化（真实日志
//!   出现过 pro → flash → pro），`tokenUsage` 投影只有全会话累计、没有模型维度
//!   ——拿一个模型价算整段账会错 3 倍。
//! - **同 (turn, step) 去重**：usage chunk 先到、assistant/message 后到是同一
//!   step 的两份 sample，只计最后一份；替换时从**原归属模型**减掉旧值——否则
//!   双计会让分桶之和超过真实累计。
//! - **无活跃模型归 unknown**：老日志无 request/header 时宁缺勿造，落进
//!   `"unknown"` 桶由展示层标「未计价」，绝不臆造一个模型。
//!
//! 每个桶除四个全量字段外还带四个 `peak_*` 子字段——落在北京高峰时段
//! （**周一至周五** 9–12、14–18 点；周末全天为空闲）的部分，由触发这份贡献的
//! 事件自己的 `time` 字段判定。
//! 这不是为了展示"高峰用了多少"这件事本身，而是让展示层能算出**真实发生的
//! 费用**（按每笔请求实际的时段计价），而不是过去那种"给空闲价和高峰价两个
//! 数，猜不出你半夜发的请求该按哪个算"的区间估算——旧版本注释说"累计桶无法
//! 重建每笔请求的时刻"，那是折叠时把 `time` 直接扔掉的自我实现，不是数据不
//! 存在。

use serde_json::{Map, Value, json};

use crate::evidence::{Coverage, Signal};
use crate::source_identity::{canonical_json, fnv1a64_hex}; // §3.3 身份哈希原语（与 claude/codex/UsageFact ID 同一边界）

/// 同一模型名在一次会话里被两家供应商服务过时的标记。故意用一个不可能是
/// 真实供应商名的字符串：它不会命中 `priced_providers` 白名单，于是自动
/// 落进「不计价」——不需要计价方再认一个特殊分支。
pub const AMBIGUOUS_PROVIDER: &str = "__ambiguous__";

/// usage 样本的**来源**标签（per-source 拆账的键）。跨会话 fold 的
/// `by_source` 轴按它分桶：2026-08「日历 ¥2386 vs 按 session 重算 ¥1733」
/// 的账目对不上，根因是同一批会话被喂了多次——给每次喂入标一个来源，
/// 就能一眼看出「同一个量在 by_source 里出现了几行」，而不是只见总量翻倍。
///
/// **来源只能来自 fold 调用方的显式标注**（事件本身没有来源字段，也不能在
/// 展示层猜）：oneline 喂 → `cli`，watcher 增量 → `dsh-live`，历史补扫 →
/// `dsh-backfill`，Codex 导入 → `codex`。调用方确实不知道时用
/// `SOURCE_UNSPECIFIED`——这是诚实的标签，不是编造。
pub const SOURCE_DSH_LIVE: &str = "dsh-live";
pub const SOURCE_DSH_BACKFILL: &str = "dsh-backfill";
pub const SOURCE_CODEX: &str = "codex";
pub const SOURCE_CLI: &str = "cli";
pub const SOURCE_UNSPECIFIED: &str = "unspecified";

/// usage sample 的四个字段名（日志里的 camelCase），顺序与四桶对齐。
const SAMPLE_FIELDS: [&str; 4] =
    ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

/// 从 usage sample 取四桶。字段映射与 token-meter `bucketsFrom` 完全一致
/// （reasoning 已含在 outputTokens，不重复计）。
///
/// 缺字段仍按 0 累加——这是**求和**的正确语义，且四桶之和必须与 DSH 的
/// `tokenUsage` 逐字节相等（已对账的不变量，不能动）。但「求和按 0」不等于
/// 「测到了 0」：`seen` 收集**真正出现过**的字段名，由 `token_by_model` 折成
/// `unreported_fields`，让展示层能写「未上报」而不是「0」。
///
/// 有实测依据：真实会话（session-e4b0be69）的 1398 个 usage 样本（720 条
/// `assistant/chunk` + 678 条 `assistant/message`）里 `cacheWriteTokens`
/// **一次都没出现过**，`cacheReadTokens` 出现 1348 次。原来缺字段直接落 0，
/// UI 于是显示「缓存写 0」——一个被伪造出来的测量值。这与「harness 能力缺失时
/// 降级、绝不臆造」是同一条纪律：缺列的报告有用，编造列的没用。
///
/// （早先这条注释写的是「679 个样本」——那个数只数了 `assistant/message`
/// 一种类型，漏了 `assistant/chunk`；发现于事后核对真实日志时，已更正。）
fn buckets_from(usage: &Value, seen: &mut [bool; 4]) -> [i64; 4] {
    let mut out = [0i64; 4];
    for (i, key) in SAMPLE_FIELDS.iter().enumerate() {
        if let Some(n) = usage.get(key).and_then(|v| v.as_i64()) {
            seen[i] = true;
            out[i] = n;
        }
    }
    out
}

const BEIJING_OFFSET_SECS: i64 = 8 * 3600;

/// Unix ms → 北京时间小时数 [0,24)。中国自 1991 年起全境固定 UTC+8、无夏令时，
/// 这是精确换算，不是近似。
fn beijing_hour(time_ms: i64) -> i32 {
    let secs = time_ms.div_euclid(1000) + BEIJING_OFFSET_SECS;
    (secs.rem_euclid(86_400) / 3600) as i32
}

/// Unix ms → 北京时间星期几（周一=0 … 周日=6）。
///
/// 1970-01-01 是星期四（以周一=0 计即 3），所以 `(天数 + 3) % 7`。用纯整数算，
/// 不引日期库——`div_euclid`/`rem_euclid` 保证 1970 年之前的负时间戳也对。
fn beijing_weekday(time_ms: i64) -> i64 {
    let secs = time_ms.div_euclid(1000) + BEIJING_OFFSET_SECS;
    (secs.div_euclid(86_400) + 3).rem_euclid(7)
}

/// 高峰时段：北京时间**周一至周五**的 9–12 点、14–18 点（左闭右开）。
/// 其余一切时间（含周六周日全天）都是空闲时段，空闲价 = 高峰价的一半。
///
/// **周末那一条以前漏了**，代价是精确的 2 倍：真实账单对照（2026-08-23 周日
/// 14:45 那次会话）我们算 ¥1.0308372、官方收 ¥0.5154186，正好 ×2.0000——
/// 29 次请求的 token 数逐位吻合，只有时段判错。而且这条从来没被真实账单验证
/// 过：上一次对账的会话跑在 21–22 点，全程落在空闲时段，走的根本不是这个
/// 分支，所以碰巧对上了。
///
/// `pub`（不是 `pub(crate)`）：v0.6.x 前置热修（2026-09-03）起，二进制侧
/// `src/agent/claude_cost.rs` 也要用它给 claude ledger 的逐行 usage 判峰谷
/// ——"哪些时刻算高峰"是单一谓词，core 与二进制都读同一个函数，不重写第二份
/// （同 `evidence.rs` 的 usage 谓词纪律）。
pub fn is_peak_slot(time_ms: i64) -> bool {
    if beijing_weekday(time_ms) > 4 {
        return false; // 周六(5)、周日(6) 全天空闲
    }
    let hour = beijing_hour(time_ms);
    (9..12).contains(&hour) || (14..18).contains(&hour)
}

/// 事件是否落在高峰时段。缺 `time`（老日志/畸形事件）保守按空闲算——峰值单价
/// 更高，宁可少算费用也不要凭空安一个「高峰」时刻上去（不臆造）。
fn is_peak(event: &Value) -> bool {
    match event.get("time").and_then(|v| v.as_i64()) {
        Some(ms) => is_peak_slot(ms),
        None => false,
    }
}

/// 登记"这个模型名这次是哪家供应商服务的"——三种取值（缺场/唯一确定/
/// 两家服务过同一模型名→AMBIGUOUS）的判定见 `token_by_model` 里
/// `request/header` 分支原本的详细注释。抽成函数是因为 `compaction/summary`
/// 现在也带自己的 model/provider，需要走同一套判定，两处各写一份迟早分叉。
fn record_provider(providers: &mut Map<String, Value>, model: &str, provider: Option<&str>) {
    match providers.get(model) {
        None => {
            providers.insert(model.to_string(), provider.map(|p| json!(p)).unwrap_or(Value::Null));
        }
        Some(prev) => {
            if prev.as_str() != Some(AMBIGUOUS_PROVIDER) && prev.as_str() != provider {
                providers.insert(model.to_string(), json!(AMBIGUOUS_PROVIDER));
            }
        }
    }
}

/// 分桶相加。`sign=-1` 用于替换语义（从原归属模型减掉旧值）。`peak` 决定这份
/// 贡献是否也叠进 `peak_*` 子桶——四个基础桶始终是全量（空闲+高峰），
/// `peak_*` 只是其中高峰时段的子集，off-peak 由展示层用 全量 − peak 推出，
/// 不另开一份容易和全量对不上的独立字段。
fn add_buckets(by_model: &mut Map<String, Value>, model: &str, b: [i64; 4], sign: i64, peak: bool) {
    let entry = by_model.entry(model.to_string()).or_insert_with(|| json!({
        "uncached_input_tokens": 0i64,
        "output_tokens": 0i64,
        "cache_read_tokens": 0i64,
        "cache_write_tokens": 0i64,
        "peak_uncached_input_tokens": 0i64,
        "peak_output_tokens": 0i64,
        "peak_cache_read_tokens": 0i64,
        "peak_cache_write_tokens": 0i64,
    }));
    if let Some(obj) = entry.as_object_mut() {
        let mut fields: Vec<(&str, i64)> = vec![
            ("uncached_input_tokens", b[0]),
            ("output_tokens", b[1]),
            ("cache_read_tokens", b[2]),
            ("cache_write_tokens", b[3]),
        ];
        if peak {
            fields.extend([
                ("peak_uncached_input_tokens", b[0]),
                ("peak_output_tokens", b[1]),
                ("peak_cache_read_tokens", b[2]),
                ("peak_cache_write_tokens", b[3]),
            ]);
        }
        for (key, v) in fields {
            if let Some(cur) = obj.get_mut(key) {
                if let Some(n) = cur.as_i64() {
                    *cur = json!(n + sign * v);
                }
            }
        }
    }
}

/// 残差哨兵递归深度/列表元素上限——与 Python `usage_shaped_tokens` 同一组
/// 数字，理由见那边的文档：给到 6 层是留余量，同时避免在
/// `compaction/summary.rawOutput` 这类大对象上无界递归。
const SHAPE_SCAN_MAX_DEPTH: u8 = 6;
const SHAPE_SCAN_MAX_ITEMS: usize = 32;

/// 在一份 payload 里找**我们认识的** usage 字段，返回它们的和；没有则 `None`。
///
/// Python 平行实现 `usage.py::usage_shaped_tokens` 有完整的设计说明——这是
/// 「残差哨兵」的判据，只认 `SAMPLE_FIELDS` 这四个名字（就是折叠自己会读的
/// 那四个），故意不做宽泛的"看起来像某种用量"匹配，否则会在 `maxTokens`、
/// `shadowedTokenCount` 这类配置/统计字段上误报。**只用于留候选 + 报警，
/// 绝不用于计价**——计价必须走 `usage_sample` 的显式白名单，机器负责发现，
/// 人负责归类。
///
/// `pub`——`src/dsh.rs` 的 `is_usage_event`（DSH adapter 的"哪些事件保留进
/// usage_events"过滤器）需要用**同一个**判据做"结构看着像 usage 就留下"
/// 的宽进兜底，不能在 adapter 层再实现一份（那正是这次漏算 bug 的成因：
/// adapter 层的白名单比折叠层的白名单更早生效，折叠层的哨兵因此永远看
/// 不到被 adapter 挡在外面的事件）。
pub fn usage_shaped_tokens(node: &Value, depth: u8) -> Option<i64> {
    if depth > SHAPE_SCAN_MAX_DEPTH {
        return None;
    }
    let mut total: Option<i64> = None;
    match node {
        Value::Object(map) => {
            for (key, value) in map {
                if SAMPLE_FIELDS.contains(&key.as_str()) {
                    if let Some(n) = value.as_i64() {
                        total = Some(total.unwrap_or(0) + n);
                        continue;
                    }
                }
                if let Some(sub) = usage_shaped_tokens(value, depth + 1) {
                    total = Some(total.unwrap_or(0) + sub);
                }
            }
        }
        Value::Array(items) => {
            for value in items.iter().take(SHAPE_SCAN_MAX_ITEMS) {
                if let Some(sub) = usage_shaped_tokens(value, depth + 1) {
                    total = Some(total.unwrap_or(0) + sub);
                }
            }
        }
        _ => {}
    }
    total
}

/// 把 `compactionId` 映射成一个跟真实 turn 不冲突的负数——当 compaction 的
/// `(turn, step)` 去重身份。Python 平行实现 `_compaction_identity` 有完整的
/// 设计说明（compaction 不属于任何 turn，伪造一个会跟真实样本抢 dedup 槽）。
///
/// 用 FNV-1a 而不是密码学哈希：这个值只用作进程内的 dedup 身份，从不写进
/// 任何输出（`request_metrics` 对应行的 turn/step 显式置 null），不需要
/// 跨语言字节相同，也不需要抗碰撞到密码学强度——避免给这个 core crate
/// （wasm 也要编译）新增依赖。
fn compaction_identity(compaction_id: Option<&str>) -> (i64, i64) {
    const STEP: i64 = 0;
    match compaction_id {
        Some(id) if !id.is_empty() => {
            let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
            for b in id.as_bytes() {
                hash ^= *b as u64;
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
            (-1 - ((hash % (1u64 << 30)) as i64), STEP)
        }
        _ => (-1, STEP),
    }
}

/// 一份样本自带的模型归属——`(model, provider)`，两者各自可能缺场。
/// 目前只有 `compaction/summary` 会产出 `Some`，见 `usage_sample` 文档。
type ModelOverride = Option<(Option<String>, Option<String>)>;
/// `usage_sample` 的返回类型——`(turn, step, usage, model_override)`。
type UsageSample<'a> = (i64, i64, &'a Value, ModelOverride);

/// usage 事件 → (turn, step, usage, model_override)。非 usage 事件返回 None。
///
/// `model_override` 是 `Some((model, provider))`——大多数事件类型没有自己的
/// 模型信息，调用方沿用从 `request/header` 追踪的"当前激活模型"（`None`）；
/// `compaction/summary` 例外，它自带 `data.model`/`data.provider`（真实实测：
/// 会话主体用 pro/flash 混合，但 compaction 走的是
/// `deepseek-v4-flash`/`deepseek-official`，跟当时激活的模型不是同一个）
/// ——不能落进"当前激活模型"，那会把这笔钱记错供应商/模型。
///
/// `assistant/chunk` 仅当 `data.chunk.type == "usage"`；`assistant/message`
/// 仅当 `data.usage` 存在；`compaction/summary` 仅当 `data.usage` 是对象
/// （没有 turn/step，用 `compaction_identity` 代替）；缺 turn/step 视为畸形
/// usage 事件，跳过。
fn usage_sample(event: &Value) -> Option<UsageSample<'_>> {
    let etype = event.get("type").and_then(|v| v.as_str())?;
    let data = event.get("data").and_then(|v| v.as_object())?;
    if etype == "assistant/chunk" {
        let chunk = data.get("chunk").and_then(|v| v.as_object())?;
        if chunk.get("type").and_then(|v| v.as_str()) != Some("usage") {
            return None;
        }
        let turn = data.get("turn").and_then(|v| v.as_i64())?;
        let step = data.get("step").and_then(|v| v.as_i64())?;
        let usage = chunk.get("usage")?;
        return Some((turn, step, usage, None));
    }
    if etype == "assistant/message" {
        if !data.contains_key("usage") {
            return None;
        }
        let turn = data.get("turn").and_then(|v| v.as_i64())?;
        let step = data.get("step").and_then(|v| v.as_i64())?;
        let usage = data.get("usage")?;
        return Some((turn, step, usage, None));
    }
    if etype == "compaction/summary" {
        let usage = data.get("usage").filter(|v| v.is_object())?;
        let (turn, step) = compaction_identity(data.get("compactionId").and_then(|v| v.as_str()));
        let model = data.get("model").and_then(|v| v.as_str()).map(String::from);
        let provider = data.get("provider").and_then(|v| v.as_str()).map(String::from);
        return Some((turn, step, usage, Some((model, provider))));
    }
    None
}

/// P3 group②（docs/RUNTIME_EVIDENCE_CONTRACT.md §17，cost fold）：这族函数
/// （`token_by_model`/`request_metrics`/`context_composition`/
/// `src/cost.rs::cost_report`）依赖 `Signal::Usage`。**不新造一套裁决逻辑**——
/// 这族函数从很早就有自己的一套"不编造"纪律：零样本时 `by_model` 是 `{}`、
/// `unreported_fields` 是 `[]`（不对"执行环境不报某字段"下断言）、
/// `cost_report` 直接返回 `None`。这些早就是 §10 三态契约里
/// "measured-zero vs unavailable" 的实现，只是没有挂 `Signal` 这个词汇。
/// 这个函数把两者正式挂钩，给 §17.1 "coverage-matrix golden" 这类跨规则族
/// 的一致性检查用——**这里没有第三个"findings"态**：cost fold 不产出
/// 离散的 finding，只有"有没有 Usage 证据"这一件事，"有证据但折出空结果"
/// 在这族函数里是同一个条件（零样本 ⇔ 零覆盖），不是两个可分的状态。
pub fn usage_signal_status(coverage: &Coverage) -> Value {
    let counts = coverage.get(Signal::Usage);
    if counts.total() == 0 {
        json!({
            "status": "unavailable",
            "missing": ["Usage"],
            "reason": "no evidence for required signal(s) in this session",
        })
    } else {
        json!({"status": "measured", "sample_count": counts.total()})
    }
}

/// 可续折叠的折叠状态（`RUNTIME_EVIDENCE_CONTRACT.md` §10.2「checkpoint 是
/// 一个值,不是进程」）。
///
/// 只捕获**跨 turn 延续**的状态。`last` 同 step 去重槽**不在里面**：turn 边界
/// 之后第一条 usage 事件必是新 turn，不可能命中前缀最后那条的 (turn, step)——
/// 契约原文：「mid-turn 的 checkpoint 需要序列化替换状态；boundary 处不需要」。
/// 这就是 `usage_fold_resume` 只保证在 **turn 边界**切分时与 `token_by_model`
/// 逐字节一致的原因。
///
/// 各字段对应 `token_by_model` 折叠的跨 turn 变量：`by_model`/`providers`/
/// `sequence`/`active` 是累计或游标，天然跨调用；`seen`/`samples` 决定「执行环境
/// 未上报字段」的断言（0 个样本不下断言）；`unaccounted` 是残差哨兵，逐事件
/// 累计。没有 serde derive——core 不引 serde 宏，checkpoint 序列化走手写的
/// `to_json`/`from_json`（`usage_fold_checkpoint_json`/`usage_fold_resume_json`）。
#[derive(Debug, Clone)]
pub struct UsageFoldState {
    pub by_model: Map<String, Value>,
    pub providers: Map<String, Value>,
    pub active: Option<String>,
    pub sequence: Vec<String>,
    /// 真正出现过的 usage 字段（见 `buckets_from`）。
    pub seen: [bool; 4],
    /// 0 个样本时不对「未上报」下任何断言。
    pub samples: u64,
    /// 残差哨兵：类型 → (条数, 漏算 token)（见 `usage_shaped_tokens`）。用
    /// BTreeMap 而不是 HashMap——输出按类型名排序，与 Python 的
    /// `sorted(unaccounted.items())` 对齐，保证确定性。
    pub unaccounted: std::collections::BTreeMap<String, (u64, i64)>,
}

impl Default for UsageFoldState {
    fn default() -> Self {
        UsageFoldState {
            by_model: Map::new(),
            providers: Map::new(),
            active: None,
            sequence: Vec::new(),
            seen: [false; 4],
            samples: 0,
            unaccounted: std::collections::BTreeMap::new(),
        }
    }
}

/// 把一段**分叉之后**的事件折进状态——`token_by_model` / `usage_fold_checkpoint`
/// / `usage_fold_resume` 共用的内层循环。
///
/// `last` 同 step 去重槽是函数内局部量，每次从 `None` 起：checkpoint 建立时槽
/// 本为空；resume 的后缀从 turn 边界开始，第一条 usage 必是新 turn，不会命中
/// checkpoint 里最后的槽（§10.2）。**增量折叠绝不另写一条"快路"**——必须与全量
/// 重折逐字节相同，所以它们共用同一个 `usage_fold_into`。
fn usage_fold_into(state: &mut UsageFoldState, events: &[Value]) {
    // 同 step 去重槽 —— 不跨调用延续（见 UsageFoldState 文档）。
    let mut last: Option<(i64, i64, [i64; 4], String, bool)> = None;

    for event in events {
        if !event.is_object() {
            continue;
        }
        if event.get("type").and_then(|v| v.as_str()) == Some("request/header") {
            let model = event
                .pointer("/data/header/config/model")
                .and_then(|v| v.as_str());
            let Some(model) = model else { continue };
            // 供应商与模型是**两个维度**：真实会话里同一份日志既有
            // provider=deepseek-official 的 flash，也有 provider=shengsuanyun 的
            // pro——两家的价目表不同，只按模型名计价会把一家的用量按另一家的价
            // 算（实测把胜算云的 3.5M token 按 DeepSeek 官方价算出了 ¥1.66）。
            //
            // 三种取值必须分开，否则会把「老日志没这个字段」和「两家都服务过
            // 这个模型」混为一谈：
            //   - Null       = 所有 header 都没上报 provider（老日志）→ 计价方
            //                  沿用默认表，保持既有行为；
            //   - "…"        = 唯一确定的供应商 → 按白名单判断能不能计价；
            //   - AMBIGUOUS  = 同一模型名被两家服务过 → 我们无法判断哪些 token
            //                  属于哪家，猜一个等于替用户编一次归属，拒绝计价。
            let provider = event
                .pointer("/data/header/config/provider")
                .and_then(|v| v.as_str());
            record_provider(&mut state.providers, model, provider);
            if state.active.as_deref() != Some(model) {
                state.sequence.push(model.to_string());
            }
            state.active = Some(model.to_string());
            continue;
        }
        let Some((turn, step, usage, model_override)) = usage_sample(event) else {
            // 残差哨兵：这条事件没被接住，但 payload 里有我们认得的 token
            // 字段 → 记下来。见 `usage_shaped_tokens` 的文档：哨兵只报警，
            // 不计价，归类由人来做。
            if let Some(data) = event.get("data") {
                if let Some(tokens_seen) = usage_shaped_tokens(data, 0) {
                    let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("(unknown)");
                    let entry = state.unaccounted.entry(etype.to_string()).or_insert((0u64, 0i64));
                    entry.0 += 1;
                    entry.1 += tokens_seen;
                }
            }
            continue;
        };
        state.samples += 1;
        let buckets = buckets_from(usage, &mut state.seen);
        let model = if let Some((Some(m), provider)) = &model_override {
            // 这份样本自带模型归属（目前只有 compaction/summary）——不能
            // 沿用"当前激活模型"，见 `usage_sample` 文档。
            record_provider(&mut state.providers, m, provider.as_deref());
            m.clone()
        } else {
            state.active.clone().unwrap_or_else(|| "unknown".to_string())
        };
        let peak = is_peak(event);
        match &last {
            Some((lt, ls, lb, lmodel, lpeak)) if *lt == turn && *ls == step => {
                if *lb == buckets && *lpeak == peak {
                    continue;
                }
                add_buckets(&mut state.by_model, lmodel, *lb, -1, *lpeak);
                add_buckets(&mut state.by_model, &model, buckets, 1, peak);
                last = Some((turn, step, buckets, model, peak));
            }
            _ => {
                add_buckets(&mut state.by_model, &model, buckets, 1, peak);
                last = Some((turn, step, buckets, model, peak));
            }
        }
    }
}

/// 折叠状态 → `token_by_model` 的输出形状。
pub fn usage_fold_render(state: &UsageFoldState) -> Value {
    // 一个样本都没有时返回空列表：没有数据就不做「执行环境不报这个字段」的断言。
    let unreported: Vec<&str> = if state.samples > 0 {
        SAMPLE_FIELDS.iter().enumerate().filter(|(i, _)| !state.seen[*i]).map(|(_, k)| *k).collect()
    } else {
        Vec::new()
    };

    // `unaccounted_usage` 是 `unreported_fields` 的**对偶**：后者说「执行环境
    // 从没报过这个字段」，前者说「执行环境报了 token，但我们没接住」。在证据
    // 模型里它就是 `Signal::Usage` 的 `unmetered` 计数——`evidence.rs` 的
    // 那句注释精确预言了这个 bug：「适配器不能靠"读不到就不算"来偷偷刷高
    // 自己的覆盖率」。
    let unaccounted_usage: Vec<Value> = state
        .unaccounted
        .iter()
        .map(|(t, (count, tokens_seen))| {
            json!({"type": t, "count": count, "tokens_seen": tokens_seen})
        })
        .collect();

    json!({
        "by_model": Value::Object(state.by_model.clone()),
        "providers": Value::Object(state.providers.clone()),
        "sequence": state.sequence.clone(),
        "unreported_fields": unreported,
        "unaccounted_usage": unaccounted_usage,
    })
}

/// 事件流（**分叉之后**）→ 可序列化的 checkpoint。
///
/// 调用方负责先 `post_fork`：分叉边界只由日志头第一个 `session` 事件的
/// `seedLength` 决定（`util::fork_boundary`），对 append-only 日志是一次性
/// 稳定的，不必每个 checkpoint 重算；而且 resume 时后缀里没有 session 头，
/// 重算会得到 None（= 不过滤），与「前缀已滤、后缀无分叉事件」一致。
pub fn usage_fold_checkpoint(events: &[Value]) -> UsageFoldState {
    let mut state = UsageFoldState::default();
    usage_fold_into(&mut state, events);
    state
}

/// checkpoint + 后续事件 → 输出。
///
/// §10.2 契约：`fold(events[0..n]) == fold_resume(checkpoint@k, events[k..n])`
/// 对任何 **turn 边界** k 成立。`events` 必须是分叉之后、且从 turn 边界开始的
/// 后缀——mid-turn 切分需要序列化 `last` 替换状态，这个 checkpoint 不携带。
pub fn usage_fold_resume(state: &UsageFoldState, events: &[Value]) -> Value {
    let mut st = state.clone();
    usage_fold_into(&mut st, events);
    usage_fold_render(&st)
}

/// checkpoint 的 JSON 形态（watcher/持久化用）。
///
/// 手写序列化，不引 serde derive。只落跨 turn 状态；`seen` 折成 `Vec<bool>`
/// 以便 JSON 表达（长度恒 4）。`unaccounted` 每条存 `[count, tokens_seen]`，
/// 与 Python 镜像的 `[count, tokens_seen]` 列表逐字节对齐。
pub fn usage_fold_checkpoint_json(state: &UsageFoldState) -> Value {
    let seen: Vec<bool> = state.seen.to_vec();
    let unaccounted: Map<String, Value> = state
        .unaccounted
        .iter()
        .map(|(t, (count, tokens_seen))| {
            (t.clone(), json!([count, tokens_seen]))
        })
        .collect();
    json!({
        "by_model": Value::Object(state.by_model.clone()),
        "providers": Value::Object(state.providers.clone()),
        "active": state.active,
        "sequence": state.sequence.clone(),
        "seen": seen,
        "samples": state.samples,
        "unaccounted": Value::Object(unaccounted),
    })
}

/// JSON checkpoint → 折叠状态（`usage_fold_checkpoint_json` 的逆）。
pub fn usage_fold_resume_from_json(value: &Value) -> UsageFoldState {
    let mut state = UsageFoldState::default();
    if let Some(obj) = value.as_object() {
        state.by_model = obj
            .get("by_model")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        state.providers = obj
            .get("providers")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        state.active = obj
            .get("active")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(seq) = obj.get("sequence").and_then(|v| v.as_array()) {
            state.sequence = seq.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
        }
        if let Some(seen) = obj.get("seen").and_then(|v| v.as_array()) {
            for (i, v) in seen.iter().enumerate().take(4) {
                if let Some(true) = v.as_bool() {
                    state.seen[i] = true;
                }
            }
        }
        if let Some(n) = obj.get("samples").and_then(|v| v.as_u64()) {
            state.samples = n;
        }
        if let Some(u) = obj.get("unaccounted").and_then(|v| v.as_object()) {
            for (t, v) in u {
                if let Some(arr) = v.as_array() {
                    if let (Some(count), Some(tokens_seen)) =
                        (arr.first().and_then(|x| x.as_u64()), arr.get(1).and_then(|x| x.as_i64()))
                    {
                        state.unaccounted.insert(t.clone(), (count, tokens_seen));
                    }
                }
            }
        }
    }
    state
}

/// 事件流 → `{"by_model": {...}, "sequence": [...]}`。
///
/// 纯函数、确定性：同一事件流重放结果逐字节一致。非 object 条目跳过；
/// request/header 设活跃模型（sequence 相邻去重，保留「切回」信息）；
/// usage 事件折进当前模型；无 request/header 时归 `"unknown"` 桶。
///
/// 实现就是 `usage_fold_checkpoint` + `usage_fold_resume`：**增量折叠必须与
/// 全量重折逐字节相同**，所以增量绝不是另一条快路，而是同一个纯函数作用在
/// 更多事件上（`usage_fold_resume`）。这就是 §10.2 的
/// `fold(events[0..n]) == fold_resume(checkpoint@k, events[k..n])`——全量折叠
/// 与可续折叠由构造保证相等，差分测试钉住这条契约。
pub fn token_by_model(events: &[Value]) -> Value {
    // 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    // branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    // 对同一笔钱/同一批行为重复计数（见 util::fork_boundary 的实测数据）。
    let events = &crate::util::post_fork(events)[..];
    let state = usage_fold_checkpoint(events);
    usage_fold_resume(&state, &[])
}

/// usage sample 的单个字段：在场取值，缺席取 `None`。
///
/// 与 `buckets_from` 的「缺字段按 0」是**两种正确语义**，不是不一致：那边在做
/// 求和（四桶之和必须与 DSH `tokenUsage` 逐字节相等，是已对账的不变量），求和
/// 里缺项当 0 是对的；这里在做逐请求的**测量值**，缺项落 0 就是把「执行环境没报」
/// 伪造成「测到 0」——正是 `unreported_fields` 当初要修的那个缺陷。
fn opt_i64(usage: &Value, key: &str) -> Option<i64> {
    usage.get(key).and_then(|v| v.as_i64())
}

/// `Option<i64>` → JSON（`None` 落 `null`，不落 0）。
fn or_null(v: Option<i64>) -> Value {
    match v {
        Some(n) => json!(n),
        None => Value::Null,
    }
}

/// 逐相邻槽的一条 usage 观察（Python `usage.py::DshUsageObservation` 的镜像，
/// v0.7 Stage 3 Commit 1）——`request_metrics`（展示）与 UsageFact emitter
/// （Commit 2，事实）的**共享观测**。
///
/// 槽语义与聚合 fold 同款：**相邻 run**（`last` 同 (turn, step) 比较），不是全
/// 文件 HashMap 去重——非相邻的同 (turn, step) 重现是两个独立槽。字段分两组：
///
/// - **槽身份（开槽即固化、shadow 永不覆盖）**：`is_compaction`/`turn`/`step`/
///   `compaction_id` 定义这个槽是谁（compaction 的 turn/step 置 None——内部去重
///   用 `compaction_identity` 的负号哈希是实现细节，不泄漏成真实 turn 号）；
///   `identity_basis`/`source_event_id`/`first_sample_seq`/
///   `first_sample_identity_hash` 是**身份形成的唯一边界**（R3 拍板）：观察者在该
///   槽**第一个**被消费的 usage 样本到达时（开槽）按 §3.3 三段公式算好并冻结，
///   shadow 一律不覆盖——无 compactionId 的 compaction 折进固定负号槽，相邻后续
///   同槽样本会让支配样本变化，若身份 hash 取支配样本 canonical 行，append 一条
///   shadow 后 hash/fact_id 就变（v3 的错，v4 拍板改）。
/// - **支配样本 value（shadow 可覆盖）**：shadow（chunk 后的 message、双 chunk
///   后到者、相邻同槽 compaction 重现）覆盖 `seq`/`time`/`model_raw`/
///   `provider_raw`/`context_window`/`context_tokens`/四桶/`is_peak`——每份 sample
///   都按**那一刻**的 active 游标重判 model/provider（§3.4，与 fold 的「后到
///   重判」一致），不缓存成槽建立时的值。
///
/// `source_event_id` 由 observer 直接携带（Commit 2 emitter 只消费、绝不重读日志
/// 复算）。`first_sample_identity_hash` 仅无 compactionId 的 compaction 非 None。
#[derive(Debug, Clone)]
pub struct DshUsageObservation {
    // 槽身份——开槽即固化，shadow 永不覆盖
    pub is_compaction: bool,
    pub turn: Option<i64>,             // 真实 turn；compaction 槽 = None（不泄漏内部负号哈希）
    pub step: Option<i64>,             // 真实 step；compaction 槽 = None
    pub compaction_id: Option<String>, // 原生 data.compactionId（str 非空）；非 compaction = None
    pub identity_basis: String,        // §3.3："native" iff compaction 有原生 id，否则 "derived-hash"
    pub source_event_id: String, // §3.3 三段公式：request:derived:… / compaction:<id> / compaction:derived:<hash>
    pub first_sample_seq: Option<i64>, // 槽首个被消费 usage 样本的 seq（append 稳定锚）
    pub first_sample_identity_hash: Option<String>, // 仅无 id compaction：开槽样本 canonical 行 hash；其余 None
    // 支配样本 value——shadow 可覆盖（开槽时 == 开槽样本本身）
    pub seq: Option<i64>,
    pub time: Option<i64>,
    // §3.4：普通 = 支配样本那一刻的 active config.model/provider；compaction = 自带
    // data.model/provider（非空 str）否则回落 active。只允许原始字符串或 None。
    pub model_raw: Option<String>,
    pub provider_raw: Option<String>,
    pub context_window: Option<i64>,
    pub context_tokens: Option<i64>,
    pub uncached_input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub is_peak: Option<bool>,
}

/// §3.4 model_raw/provider_raw 判定：self（样本自带，仅 compaction 有）**非空**
/// 取 self，否则回落那一刻的 active 游标。Python `usage.py::_resolve_raw` 的镜像。
///
/// 空串是退化值、不是 str 缺失，不冒充证据——`usage_sample` 在 data.model="" 时给
/// `Some("")`，空串两侧都回落 active。这条同时收敛了 Python 渲染真值语义与 Rust
/// `match Some(m) => m` 的**历史分歧**（Rust 过去把空串当模型名、Python 回落
/// active）：现在两侧同一谓词，request_metrics 的 model 列才逐字节一致。
fn resolve_raw(self_val: Option<String>, active_val: Option<String>) -> Option<String> {
    match self_val {
        Some(s) if !s.is_empty() => Some(s),
        _ => active_val,
    }
}

/// §3.3 canonical 行 hash 的 hex——serde_json Value → canonical JSON 字节 → FNV-1a
/// hex。原语在 `crate::source_identity`（与 claude/codex/UsageFact ID 同一边界，
/// 本文件不长第二份 canonical/FNV）。
fn canonical_row_hex(row: Value) -> String {
    let mut canonical = String::new();
    canonical_json(&row, &mut canonical);
    fnv1a64_hex(canonical.as_bytes())
}

/// 逐相邻槽产出 [`DshUsageObservation`]（Python `usage.py::dsh_usage_observations`
/// 的镜像）——从 `request_metrics` 原循环抽出的**共享逐槽 observer**。
///
/// 原循环丢弃了 provider 与首样本身份，正是「UsageFact 不能消费它」的根因。
/// v4（R3 拍板）：身份形成的**唯一边界**在开槽——observer 在该槽第一个样本到达时
/// 按 §3.3 三段公式算好并冻结 `source_event_id`/`identity_basis`/`first_sample_seq`
/// /`first_sample_identity_hash`（`source_event_id` 直接带在 observation 上，Commit
/// 2 emitter 只消费、绝不重读日志复算）；相邻 shadow 只替换 value 字段，身份字段
/// 原样保留，结构性保证「append 一条 shadow 不改写旧 fact_id 的身份输入」。
/// **`token_by_model` 的聚合 fold 不接 observer**、继续走 `usage_fold_checkpoint`；
/// 观察者与聚合 fold 是两条**已 reconcile** 的路径（四桶之和相等由测试钉死）。
/// active 游标（config.model/config.provider）推进谓词与 fold 的 active +
/// `record_provider` 一致：config.model 为 str 才推进 model，provider 原样
/// str-or-None。
pub fn dsh_usage_observations(events: &[Value]) -> Vec<DshUsageObservation> {
    // 只看分叉之后的事件——见 token_by_model 的同条注释。
    let events = &crate::util::post_fork(events)[..];
    let mut observations: Vec<DshUsageObservation> = Vec::new();
    let mut active_model: Option<String> = None;
    let mut active_provider: Option<String> = None;
    let mut window: Option<i64> = None; // request/context 的 contextWindow 游标
    let mut last_key: Option<(i64, i64)> = None; // 同 (turn, step) 相邻槽去重

    for event in events {
        if !event.is_object() {
            continue;
        }
        match event.get("type").and_then(|v| v.as_str()) {
            Some("request/header") => {
                if let Some(m) =
                    event.pointer("/data/header/config/model").and_then(|v| v.as_str())
                {
                    active_model = Some(m.to_string());
                    active_provider = event
                        .pointer("/data/header/config/provider")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                continue;
            }
            Some("request/context") => {
                // 缺 contextWindow 时保留上一次的值，不清空——一次畸形事件不该让
                // 后面所有请求都失去分母。
                if let Some(w) = event.pointer("/data/contextWindow").and_then(|v| v.as_i64()) {
                    window = Some(w);
                }
                continue;
            }
            _ => {}
        }
        if !event.get("data").is_some_and(|d| d.is_object()) {
            continue;
        }
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let data_obj = event.get("data").expect("上面 is_object 已保证").clone();
        let Some((turn, step, usage, model_override)) = usage_sample(event) else { continue };
        // compaction 的 (turn, step) 是内部去重用的哈希身份，不是真实存在的
        // turn 号——观察者这一槽必须诚实写 None（见 `DshUsageObservation`）；
        // 去重键仍用内部 (turn, step)，与 fold 的相邻同槽判断同款。
        let is_compaction = etype == "compaction/summary";

        // 样本自带 model/provider（§3.4 的 self 半边）：仅 compaction 有，且已由
        // `usage_sample` 判成 Option（可能含空串退化值）。
        let (compaction_id, model_self, provider_self) = if is_compaction {
            let cid = event
                .get("data")
                .and_then(|d| d.get("compactionId"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let (m, p) = match &model_override {
                Some((m, p)) => (m.clone(), p.clone()),
                None => (None, None),
            };
            (cid, m, p)
        } else {
            (None, None, None)
        };

        let first_seq = event.get("seq").and_then(|v| v.as_i64());
        let time_ms = event.get("time").and_then(|v| v.as_i64());
        let uncached = opt_i64(usage, "inputTokens");
        let cache_read = opt_i64(usage, "cacheReadTokens");
        let out_tok = opt_i64(usage, "outputTokens");
        let cache_write = opt_i64(usage, "cacheWriteTokens");
        // 两项都在场才给 context_tokens；少一项整行留空。
        let context_tokens = match (uncached, cache_read) {
            (Some(a), Some(b)) => Some(a + b),
            _ => None,
        };
        // 支配样本 value 的"当时那一刻"解析：§3.4 每次重判，不缓存成槽建立时的值。
        let model_raw = resolve_raw(model_self, active_model.clone());
        let provider_raw = resolve_raw(provider_self, active_provider.clone());

        if last_key == Some((turn, step)) {
            // 后到者覆盖（与 token_by_model 的替换语义一致）：只替换 value 字段，
            // 槽身份/身份固化字段（struct 里不写即不动）原样保留——append 一条
            // shadow 不改写旧 fact_id 的身份输入。
            if let Some(slot) = observations.last_mut() {
                slot.seq = first_seq;
                slot.time = time_ms;
                slot.model_raw = model_raw;
                slot.provider_raw = provider_raw;
                slot.context_window = window;
                slot.context_tokens = context_tokens;
                slot.uncached_input_tokens = uncached;
                slot.output_tokens = out_tok;
                slot.cache_read_tokens = cache_read;
                slot.cache_write_tokens = cache_write;
                slot.is_peak = time_ms.map(|_| is_peak(event));
            }
            continue;
        }

        // ── 开槽：身份形成的唯一边界（§3.3 三段公式，一律此刻算好并冻结）──
        let (identity_basis, source_event_id, first_hash) = if is_compaction {
            match &compaction_id {
                // 有 compactionId：compaction_id 是执行环境原生标识 → native 身份，无
                // hash。
                Some(cid) => ("native", format!("compaction:{}", cid), None),
                // 无 compactionId：对开槽样本 canonical 行算 hash 并冻结。首样本
                // 重塑事件 {type, time, data}，seq 为整数才追加（hash 对象永不带
                // null 键——Python 序列化成 "null" / Rust 序列化成 null 都会字节分叉）。
                None => {
                    let mut row = Map::new();
                    row.insert("type".to_string(), json!(etype));
                    row.insert(
                        "time".to_string(),
                        event.get("time").cloned().unwrap_or(Value::Null),
                    );
                    row.insert("data".to_string(), data_obj);
                    if let Some(s) = first_seq {
                        row.insert("seq".to_string(), json!(s));
                    }
                    let hash = canonical_row_hex(Value::Object(row));
                    (
                        "derived-hash",
                        format!("compaction:derived:{}", hash),
                        Some(hash),
                    )
                }
            }
        } else {
            // 普通请求：canonical 身份元组 {turn, step}，seq 为整数才追加、None 就
            // 整体省略该键。first_sample_seq 本身就是冻结值，但为统一存固化字段。
            let mut row = Map::new();
            row.insert("turn".to_string(), json!(turn));
            row.insert("step".to_string(), json!(step));
            if let Some(s) = first_seq {
                row.insert("seq".to_string(), json!(s));
            }
            let id = canonical_row_hex(Value::Object(row));
            ("derived-hash", format!("request:derived:{}", id), None)
        };

        observations.push(DshUsageObservation {
            is_compaction,
            turn: if is_compaction { None } else { Some(turn) },
            step: if is_compaction { None } else { Some(step) },
            compaction_id,
            identity_basis: identity_basis.to_string(),
            source_event_id,
            first_sample_seq: first_seq,
            first_sample_identity_hash: first_hash,
            seq: first_seq,
            time: time_ms,
            model_raw,
            provider_raw,
            context_window: window,
            context_tokens,
            uncached_input_tokens: uncached,
            output_tokens: out_tok,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            // 这笔请求是否落在北京高峰时段。时间戳缺失时为 None——不是 false
            // （"没测到"不等于"不在高峰"）。
            is_peak: time_ms.map(|_| is_peak(event)),
        });
        last_key = Some((turn, step));
    }
    observations
}

/// 逐请求指标（PRD §9.3 RequestMetric）——与 `token_by_model` 是**同一个 fold
/// 的两个出口**，区别只在保留分辨率：那边把每个样本折进按模型的总数，这里保留
/// 每次请求自己的一行。会话健康时间线上的每个点都来自它。
///
/// 自 v0.7 Commit 1 起，本函数是 `dsh_usage_observations` 之上的**薄渲染**：
/// 逐槽抽取（usage_sample、active 游标、后到者覆盖、compaction 折叠）全部移进
/// 共享 observer（UsageFact emitter 需要的 provider 游标与开槽身份固化，展示层
/// 不需要）。输出 byte 不变由表征/对账测试与 goldens 钉住。
///
/// 为什么必须同源而不是另写一份：同 (turn, step) 的 usage chunk 先到、
/// assistant/message 后到是同一次请求的两份 sample，只算最后一份。两处各写一遍
/// 去重迟早分叉，所以共用 `usage_sample` 与同一套「后到者覆盖」语义，并由
/// `request_metrics_reconciles_with_token_by_model` 钉死不变量：
/// **逐请求四桶之和 == `token_by_model` 四桶之和**。
///
/// 三条诚实性约定（与本仓「缺列不编列」同一条纪律）：
/// - 缺字段落 `null` 不落 0（见 `opt_i64`）。
/// - `context_tokens` 只在它求和的每一项都在场时才非空。真实会话
///   （session-e4b0be69）687 个请求点里有 13 个缺 `cacheReadTokens`，这 13 点
///   就该在图上留缺口；拿部分和硬凑出一个偏低的占用，比缺口更有害。
/// - **不输出逐请求的 `compacted` 布尔列**：压缩事件类型已确认（见 `compaction.rs`），
///   但它是独立于请求的一类事件（同一 turn 内没有对应哪个具体 request），不该硬塞成
///   每行一个 true/false。真正的压缩视图是 `compaction_events()` 单独的输出。
///
/// `context_window` 取自 `request/context` 事件的 `data.contextWindow`，按
/// 「最近一次上报」向后生效——真实日志里它一个会话只出现 5 次（每次模型切换
/// 各一次），不是每请求一次，所以不能按请求去找，只能沿用最近值。
pub fn request_metrics(events: &[Value]) -> Value {
    // request_metrics 自 v0.7 Commit 1 起是共享 observer 之上的薄渲染：逐槽抽取
    // （usage_sample / active 游标 / 后到者覆盖 / compaction 折叠 / §3.3 身份与
    // §3.4 model_raw 解析）全在 `dsh_usage_observations`，这里把每个观察折成展示
    // 行；model 列直接渲染 observer 的 `model_raw`。输出 byte 不变。
    let mut out: Vec<Value> = Vec::new();
    for o in dsh_usage_observations(events) {
        out.push(json!({
            "request_seq": 0i64, // 去重后统一回填，见下
            "seq": or_null(o.seq),
            "time": or_null(o.time),
            "turn": or_null(o.turn),
            "step": or_null(o.step),
            "model": o.model_raw.clone().unwrap_or_else(|| "unknown".to_string()),
            "context_window": or_null(o.context_window),
            "context_tokens": or_null(o.context_tokens),
            "uncached_input_tokens": or_null(o.uncached_input_tokens),
            "output_tokens": or_null(o.output_tokens),
            "cache_read_tokens": or_null(o.cache_read_tokens),
            "cache_write_tokens": or_null(o.cache_write_tokens),
            // 这笔请求是否落在北京高峰时段。**规则留在 core，价格留给调用方**：
            // 展示层要画逐请求费用曲线，就必须知道每笔按高峰价还是空闲价算；
            // 让浏览器自己重算一遍 `is_peak` 就是这条规则的第四份拷贝。
            // 时间戳缺失时为 null——不是 false（"没测到"不等于"不在高峰"）。
            "is_peak": match o.is_peak {
                Some(b) => json!(b),
                None => Value::Null,
            },
        }));
    }

    // request_seq 在去重之后才有意义：它是「第几个请求点」，不是「第几个样本」。
    for (i, row) in out.iter_mut().enumerate() {
        if let Some(obj) = row.as_object_mut() {
            obj.insert("request_seq".to_string(), json!(i as i64 + 1));
        }
    }

    Value::Array(out)
}

/// 常驻上下文构成（PRD FR-04a，回答「token 都去哪了」的第一层）。
///
/// 返回**每次请求都要重发的那段前缀**的分类估算：
///
/// | 类别 | 来源 | 性质 |
/// |---|---|---|
/// | `system_tokens` | `request/header.data.header.system` | 实测文本 → est_tokens 估算 |
/// | `tools_tokens` | `request/header.data.header.tools`（序列化后） | 同上 |
/// | `catalog_tokens` | `source.kind == "skill-catalog"` 的 `entries[].name + description` | 同上 |
///
/// `catalog_names` 是 `catalog_tokens` 的逐条拆分（T1，PRD FR-SK-02/AC-SK-01 的数据源）：
/// `[{name, tokens}]`。**故意不带 description 原文**——FR-SK-09 要求导出不含未脱敏
/// 内容，description 是内容，一旦进投影就会跟着 `--redact` 之外的路径流进导出；
/// 逐 skill「目录 Token」只需要 `tokens` 这个数，不需要原文佐证。
///
/// **这三个数与 `request_metrics` 的 `context_tokens` 不是同一个估算器，不能相加
/// 相等，也不能相减去凑「其余」而不加说明。** 真实会话实测：首次请求的常驻前缀
/// est_tokens = 10,830，而 provider 报的 `uncached + cacheRead` = 13,959，差的
/// 3,129 是首条用户消息与消息封套开销。所以本函数只给**常驻部分的分类**与
/// `estimator` 标注，剩下多少由展示层用 provider 计数自己减——减出来的差额必须
/// 标成「未分类」而不是某个具体类别，否则就是把估算误差伪装成测量结果。
///
/// 缺源事件时给 `null` 而不是 0：日志里从没出现过 `skill-catalog` 事件，与
/// 「发布了一个空目录」是两回事，展示层要能写「未知」而不是「0 个技能」。
/// 与 `unreported_fields` 是同一条纪律。
///
/// 「最近一次发布覆盖前一次」——目录会在会话中途重新发布，当前状态是最后那次
/// （与 binary 侧 `dsh.rs` 的 catalog 语义一致）。`request/header` 同理：模型
/// 切换会重发，system/tools 取最近一次。
pub fn context_composition(events: &[Value]) -> Value {
    // 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    // branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    // 对同一笔钱/同一批行为重复计数（见 util::fork_boundary 的实测数据）。
    let events = &crate::util::post_fork(events)[..];
    let mut system: Option<i64> = None;
    let mut tools: Option<i64> = None;
    let mut catalog: Option<i64> = None;
    let mut entries: Option<i64> = None;
    let mut names: Option<Vec<Value>> = None;

    for event in events {
        if !event.is_object() {
            continue;
        }
        if event.get("type").and_then(|v| v.as_str()) == Some("request/header") {
            if let Some(s) = event.pointer("/data/header/system").and_then(|v| v.as_str()) {
                system = Some(crate::util::est_tokens(s));
            }
            // tools 是数组，按序列化后的文本估——模型看到的就是这份 JSON。
            if let Some(t) = event.pointer("/data/header/tools") {
                if !t.is_null() {
                    let text = serde_json::to_string(t).unwrap_or_default();
                    tools = Some(crate::util::est_tokens(&text));
                }
            }
            continue;
        }
        // 技能目录挂在多种事件的 data.source 上（不是专用事件类型），
        // 真实会话里出现在 user/message、agent/inbox/spliced 等等。
        let Some(source) = event.pointer("/data/source") else { continue };
        if source.get("kind").and_then(|v| v.as_str()) != Some("skill-catalog") {
            continue;
        }
        let Some(list) = source.get("entries").and_then(|v| v.as_array()) else { continue };
        let mut sum = 0i64;
        let mut this_names = Vec::with_capacity(list.len());
        for entry in list {
            let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let desc = entry.get("description").and_then(|v| v.as_str()).unwrap_or("");
            // name 与 description 拼起来估：与 Python 侧同一口径。
            let tokens = crate::util::est_tokens(&format!("{name}{desc}"));
            sum += tokens;
            this_names.push(json!({"name": name, "tokens": tokens}));
        }
        catalog = Some(sum);
        entries = Some(list.len() as i64);
        names = Some(this_names);
    }

    // 三项都缺就没有「常驻合计」可言——不拿 0 当合计。
    let resident_total = match (system, tools, catalog) {
        (None, None, None) => Value::Null,
        _ => json!(system.unwrap_or(0) + tools.unwrap_or(0) + catalog.unwrap_or(0)),
    };

    json!({
        "system_tokens": or_null(system),
        "tools_tokens": or_null(tools),
        "catalog_tokens": or_null(catalog),
        "catalog_entries": or_null(entries),
        "catalog_names": names.map(Value::Array).unwrap_or(Value::Null),
        "resident_total": resident_total,
        // 展示层据此标注「估算」，并且**不得**把它与 provider 的 context_tokens
        // 直接相减后当作精确的分类结果。
        "estimator": "est_tokens",
    })
}

/// 分叉前那段被排除掉的用量——**只为把话说清楚而存在**。
///
/// 主输出（`token_by_model` 等）已经把分叉前的事件滤掉了，这是正确的：审计回答
/// 的是「这个会话干了什么」。但金额会因此显著变小（实测 ¥1113.66 → ¥433.30），
/// 不给出被排除的量，用户会以为数据坏了。
///
/// 返回 `Value::Null` 表示这个会话根本没有分叉——**不是返回一个全零的结构**，
/// 「没分叉」和「分叉了但上游没花钱」是两回事。
pub fn pre_fork_usage(events: &[Value]) -> Value {
    let Some(b) = crate::util::fork_boundary(events) else {
        return Value::Null;
    };
    let before: Vec<Value> = events
        .iter()
        .filter(|e| e.get("seq").and_then(|v| v.as_i64()).is_some_and(|q| q < b))
        .cloned()
        .collect();
    if before.is_empty() {
        return Value::Null;
    }
    // 这里**不能**走 token_by_model —— 它自己会先 post_fork，把这批全滤掉。
    // 直接调内部折叠。
    let mut fake = before;
    // 追加一个哨兵边界，让内部的 post_fork 认为「分叉在最开头」，从而全量保留。
    fake.insert(0, serde_json::json!({"type": "session/end-seed", "seq": -1, "data": {}}));
    let mut out = token_by_model(&fake);
    if let Some(o) = out.as_object_mut() {
        o.insert("boundary_seq".to_string(), serde_json::json!(b));
    }
    out
}

/// `days_since_1970` → ISO `YYYY-MM-DD`。
///
/// Howard Hinnant 的 civil_from_days 算法（http://howardhinnant.github.io/
/// date_algorithms.html#civil_from_days），public domain。**不引 chrono**
/// ——CLAUDE.md §「no third-party supply chain at scan time」，统计折叠这层
/// 必须是 stdlib-only；引 chrono 就破例了。算法纯整数 ~10 行，且已用
/// 2026-08-25 = days 20690 等价对过。
pub fn civil_date_from_days(days: i64) -> String {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// `YYYY-MM-DD` → 1970-01-01 起的天数（Hinnant `days_from_civil`，public domain）。
/// `civil_date_from_days` 的逆；`codex_usage::codex_hour_of` 要把 UTC 时间戳加
/// 8 小时折成北京小时键，先拿它把 `YYYY-MM-DD` 归到天数、再跨日进位。**不引
/// chrono**，理由同 `civil_date_from_days`。非法日期（如 02-30）也会给一个
/// 数值（Hinnant 对非真实日期无定义）——调用方用 round-trip 校验挡掉。
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m as i64 + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// 民历日期时刻（UTC，逐字段已从 ISO 字符串切出）→ epoch 毫秒，**校验真实
/// 日期**（`days_from_civil` 对非法日期无定义，如 02-30——这里用
/// `civil_date_from_days` 往返比对挡掉）。`pub`：v0.6.x 前置热修
/// （2026-09-03）起，二进制侧 `src/agent/claude_cost.rs` 的 `ms_from_iso_ts`
/// 复用它给 claude 逐行 usage 判峰谷（`is_peak_slot` 要精确的北京小时+
/// 星期，不只是日期）——Python 镜像用 `date(y,mo,d)` 的构造失败做同一件事。
pub fn ms_from_civil(y: i64, mo: u32, d: u32, hh: u32, mm: u32, ss: u32) -> Option<i64> {
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    if civil_date_from_days(days) != format!("{y:04}-{mo:02}-{d:02}") {
        return None; // 往返不一致 → 输入本来就不是一个真实存在的日期
    }
    Some((days * 86_400 + hh as i64 * 3600 + mm as i64 * 60 + ss as i64) * 1000)
}

/// 事件流 → 按 `(date, hour)` 折叠到 token 桶。Python 平行实现见
/// `scripts/agent_vitals/agent/usage.py::hour_buckets`，差分防护在本文件的
/// `hour_buckets_*` 测试 + `tests/test_cli_matrix.py` 的双二进制逐字节比较。
///
/// 与 `token_by_model` / `request_metrics` 是**同一次 fold 的三个出口**：
/// 那两个按模型 / 按请求折，这里按小时折。三者共用 `usage_sample` +
/// `buckets_from` + `is_peak`，去重 / peak 语义必须一致 —— 任一处改了
/// 同 `(turn, step)` 处理而另两处没改，对账立刻红。
///
/// 不变量（测试钉死）：
/// - 全桶 4+4 字段之和 == `token_by_model` 按模型聚合后求和；
/// - `(date, hour)` 是**去重后**的聚合粒度，不受 chunk/message 顺序影响；
/// - 跨午夜事件按各自 `event.time` 归属，不归到 session 开始那天；
/// - 时间戳缺失的样本落 `(None, None)` 桶（JSON 里 `"date": null` /
///   `"hour": null`），**不**进任何 `(date, hour)` 桶 —— 避免被算成
///   1970-01-01。
///
/// 输出 schema：
/// ```json
/// {
///   "buckets": [
///     {"date": "2026-08-25", "hour": 14, "is_peak": true,
///      "uncached_input_tokens": ..., ..., "peak_uncached_input_tokens": ...}
///   ],
///   "schema_version": 1,
///   "tz_name": "Asia/Shanghai (UTC+8 fixed, no DST)",
///   "tz_offset_hours": 8,
///   "unreported_fields": [...]
/// }
/// ```
/// 同 (turn, step) 去重槽：(turn, step, date, hour, 4 基础桶, is_peak)。
/// clippy::type_complexity 要求命名 —— 裸元组类型超过它的复杂度阈值。
type HourBucketDedupSlot = (i64, i64, Option<String>, Option<i32>, [i64; 4], bool);

pub fn hour_buckets(events: &[Value]) -> Value {
    // 只看分叉之后的事件——见 token_by_model 的同条注释
    let events = &crate::util::post_fork(events)[..];

    // (date_str, hour) → 8 桶 dict。缺 time 的样本落 (None, None)。
    // 用 Vec 而不是 HashMap 是为了**确定性**输出：按 seq 处理顺序保留
    // 首次出现 key 的位置，最终展平时按 (date, hour) 排序 —— 与 Python
    // 端的 list.sort 行为对齐（bytes-level）。
    let mut bucket_keys: Vec<(Option<String>, Option<i32>)> = Vec::new();
    let mut buckets_map: std::collections::HashMap<(Option<String>, Option<i32>), [i64; 8]> =
        std::collections::HashMap::new();

    let mut last: Option<HourBucketDedupSlot> = None;
    let mut seen: [bool; 4] = [false; 4];
    let mut samples: u64 = 0;

    for event in events {
        if !event.is_object() {
            continue;
        }
        // request/header 跳过 —— hour_buckets 不按模型分桶,但保留这段逻辑
        // 让循环路径与 token_by_model 一致(防御性)。
        if event.get("type").and_then(|v| v.as_str()) == Some("request/header") {
            continue;
        }
        let Some((turn, step, usage, _model_override)) = usage_sample(event) else { continue };
        samples += 1;
        let add_buckets = buckets_from(usage, &mut seen);
        let time_ms = event.get("time").and_then(|v| v.as_i64());
        let peak = time_ms.map(is_peak_slot).unwrap_or(false);

        let (date_str, hour) = match time_ms {
            Some(ms) => {
                let secs = ms.div_euclid(1000) + BEIJING_OFFSET_SECS;
                let days = secs.div_euclid(86_400);
                (Some(civil_date_from_days(days)), Some(beijing_hour(ms)))
            }
            None => (None, None),
        };

        let key = (date_str.clone(), hour);
        if !buckets_map.contains_key(&key) {
            bucket_keys.push(key.clone());
        }

        // 同 step 去重时需要**先**把旧贡献从原 hour 桶扣掉,**再**把新贡献
        // 加到当前 hour 桶 —— 这是 token_by_model 的同 step 替换语义,
        // 两边必须一致(否则累加会双计)。Rust 借用检查不允许在持有一个
        // entry() 句柄的同时再 get_mut 另一个 key,所以把"扣旧"和"加新"
        // 分两步,中间 drop 借用。
        let is_dedup = matches!(&last, Some((lt, ls, _, _, _, _)) if *lt == turn && *ls == step);
        let old_buckets = if is_dedup {
            let (lt, ls, ld, lh, lb, lpeak) = last.as_ref().expect("checked above");
            debug_assert_eq!(*lt, turn);
            debug_assert_eq!(*ls, step);
            let lkey = (ld.clone(), *lh);
            // 扣除旧贡献后立即 drop 借用,然后再加新贡献
            if let Some(lentry) = buckets_map.get_mut(&lkey) {
                for i in 0..4 {
                    lentry[i] -= lb[i];
                }
                if *lpeak {
                    for i in 0..4 {
                        lentry[4 + i] -= lb[i];
                    }
                }
            }
            Some(*lb)
        } else {
            None
        };

        let entry = buckets_map.entry(key).or_insert([0i64; 8]);
        let _ = old_buckets; // 显式 drop 旧 borrow
        for i in 0..4 {
            entry[i] += add_buckets[i];
        }
        if peak {
            for i in 0..4 {
                entry[4 + i] += add_buckets[i];
            }
        }
        last = Some((turn, step, date_str, hour, add_buckets, peak));
    }

    // 排序 + 展平：unknown (None, None) 桶沉底 —— 与 Python list.sort 的
    // (date is None, date, hour) key 一致。
    bucket_keys.sort_by(|a, b| {
        let a_is_none = a.0.is_none();
        let b_is_none = b.0.is_none();
        b_is_none
            .cmp(&a_is_none)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });

    let mut rows: Vec<Value> = Vec::with_capacity(bucket_keys.len());
    for key in &bucket_keys {
        let b = buckets_map.get(key).copied().unwrap_or([0i64; 8]);
        let (date_str, hour) = key;
        let is_peak = match (date_str, hour) {
            (None, _) => Value::Null,
            (Some(_), _) => {
                // 任一 peak_* > 0 → 整桶标 peak(单一粒度,不是逐字段)
                Value::Bool(b[4] != 0 || b[5] != 0 || b[6] != 0 || b[7] != 0)
            }
        };
        rows.push(json!({
            "date": date_str,
            "hour": hour,
            "is_peak": is_peak,
            "uncached_input_tokens": b[0],
            "output_tokens": b[1],
            "cache_read_tokens": b[2],
            "cache_write_tokens": b[3],
            "peak_uncached_input_tokens": b[4],
            "peak_output_tokens": b[5],
            "peak_cache_read_tokens": b[6],
            "peak_cache_write_tokens": b[7],
        }));
    }

    // 一个样本都没有时返回空 unreported —— 与 token_by_model 同条纪律
    let unreported: Vec<&str> = if samples > 0 {
        SAMPLE_FIELDS
            .iter()
            .enumerate()
            .filter(|(i, _)| !seen[*i])
            .map(|(_, k)| *k)
            .collect()
    } else {
        Vec::new()
    };

    json!({
        "buckets": rows,
        "schema_version": 1,
        "tz_name": "Asia/Shanghai (UTC+8 fixed, no DST)",
        "tz_offset_hours": 8,
        "unreported_fields": unreported,
    })
}

type DateModelDedupSlot = (i64, i64, Option<String>, String, [i64; 4], bool);

/// `token_by_model` 的模型维 × `hour_buckets` 的日期维 → `{date: {model: 八桶}}`。
///
/// **为什么这是第三个出口，而不是让调用方自己拼**：日历按天展示、DSH 审计
/// 按 session 展示，两者是**同一份用量的两个投影**，同一个月的 token 总数与
/// 成本必须相等。按 session 折用 `token_by_model`（无日期维），按天折用
/// `hour_buckets`（无模型维）——可是「某天花了多少钱」需要**同时**有日期和
/// 模型（pro 与 flash 差 3 倍价），两个投影各缺一半，拼不出来。过去的做法是
/// 把整段 session 的 `by_model` 记到「今天」，跨零点的会话和历史回填因此都
/// 记错日子（实测 2026-08 的月度成本因此偏差 4 倍）。
///
/// 去重语义（同 `(turn, step)` 先扣旧归属再加新归属）与 `token_by_model` /
/// `hour_buckets` **逐字节一致**——三个出口共用 `usage_sample` + `buckets_from`
/// + `is_peak`，任何一处改了去重而另两处没改，对账立刻红。
///
/// 时间戳缺失的样本**不产生日期桶**（与 `hour_buckets` 把它们落进
/// `(None, None)`、日历渲染时滤掉是同一条纪律：未知时间不能算进任何一天）。
/// 因此本函数的总量 = `token_by_model` 的总量 − 无时间戳样本的量；语料里
/// 全部样本都带 time 时两者精确相等，这正是对账测试断言的形式。
pub fn token_by_date_model(events: &[Value], source: &str) -> Value {
    // 只看分叉之后的事件——见 token_by_model 的同条注释
    let events = &crate::util::post_fork(events)[..];

    // 输出顺序必须确定：date 升序、模型按首次出现顺序。用 BTreeMap 管日期
    // （天然有序），模型侧用 Vec 记首现顺序 —— 与 Python 端 dict 的插入序
    // 一致，两侧 JSON 才能逐字节相同。
    let mut day_model_keys: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    let mut acc: std::collections::HashMap<(String, String), [i64; 8]> =
        std::collections::HashMap::new();

    // by_source 轴：`{date: {source: {model: 8桶}}}`（date 优先，与主输出同
    // 日期空间，`merge_month` 才能按日期归位/归档）。与主输出**同一次循环**
    // 累计、同 (turn, step) 去重（扣旧加新都落在同一个 source 键上），保证
    // by_source 各 source 之和 == 主输出总量——按来源拆的账和按日期拆的账是
    // 同一份用量，不是各算各的。
    let mut src_day_keys: std::collections::BTreeMap<
        String,
        std::collections::BTreeMap<String, Vec<String>>,
    > = std::collections::BTreeMap::new();
    let mut src_acc: std::collections::HashMap<(String, String, String), [i64; 8]> =
        std::collections::HashMap::new();

    let mut active: Option<String> = None;
    let mut last: Option<DateModelDedupSlot> = None;
    let mut seen: [bool; 4] = [false; 4];

    for event in events {
        if !event.is_object() {
            continue;
        }
        if event.get("type").and_then(|v| v.as_str()) == Some("request/header") {
            if let Some(model) = event
                .pointer("/data/header/config/model")
                .and_then(|v| v.as_str())
            {
                active = Some(model.to_string());
            }
            continue;
        }
        let Some((turn, step, usage, model_override)) = usage_sample(event) else { continue };
        let add = buckets_from(usage, &mut seen);
        let time_ms = event.get("time").and_then(|v| v.as_i64());
        let date_str = time_ms.map(|ms| {
            let secs = ms.div_euclid(1000) + BEIJING_OFFSET_SECS;
            civil_date_from_days(secs.div_euclid(86_400))
        });
        let peak = time_ms.map(is_peak_slot).unwrap_or(false);
        // 同 token_by_model：自带模型归属的样本（目前只有 compaction/summary）
        // 不沿用"当前激活模型"。
        let model = match &model_override {
            Some((Some(m), _)) => m.clone(),
            _ => active.clone().unwrap_or_else(|| "unknown".to_string()),
        };

        // 同 step 去重：先把旧归属从它自己的 (date, model) 桶扣掉。借用检查
        // 不允许同时持两个 entry 句柄，所以扣旧/加新分两步（与 hour_buckets
        // 里同一处的处理方式一致）。
        if matches!(&last, Some((lt, ls, _, _, _, _)) if *lt == turn && *ls == step) {
            let (_, _, ld, lmodel, lb, lpeak) = last.as_ref().expect("checked above");
            if let Some(ldate) = ld {
                if let Some(entry) = acc.get_mut(&(ldate.clone(), lmodel.clone())) {
                    for i in 0..4 {
                        entry[i] -= lb[i];
                    }
                    if *lpeak {
                        for i in 0..4 {
                            entry[4 + i] -= lb[i];
                        }
                    }
                }
                // 旧归属同样从 source 桶扣掉——一次调用只喂一个 source，扣旧加新
                // 都在同一个 source 键上，净结果等于新值。
                if let Some(entry) = src_acc.get_mut(&(
                    ldate.clone(),
                    source.to_string(),
                    lmodel.clone(),
                )) {
                    for i in 0..4 {
                        entry[i] -= lb[i];
                    }
                    if *lpeak {
                        for i in 0..4 {
                            entry[4 + i] -= lb[i];
                        }
                    }
                }
            }
        }

        if let Some(d) = &date_str {
            let models = day_model_keys.entry(d.clone()).or_default();
            if !models.iter().any(|m| m == &model) {
                models.push(model.clone());
            }
            let entry = acc.entry((d.clone(), model.clone())).or_insert([0i64; 8]);
            for i in 0..4 {
                entry[i] += add[i];
            }
            if peak {
                for i in 0..4 {
                    entry[4 + i] += add[i];
                }
            }

            // 同一份贡献记进 source 桶。只记带日期的样本——主输出对无时间戳
            // 样本本来就不产生日期桶，source 轴与它保持同一口径。
            let src_models = src_day_keys
                .entry(d.clone())
                .or_default()
                .entry(source.to_string())
                .or_default();
            if !src_models.iter().any(|m| m == &model) {
                src_models.push(model.clone());
            }
            let sentry = src_acc
                .entry((d.clone(), source.to_string(), model.clone()))
                .or_insert([0i64; 8]);
            for i in 0..4 {
                sentry[i] += add[i];
            }
            if peak {
                for i in 0..4 {
                    sentry[4 + i] += add[i];
                }
            }
        }
        last = Some((turn, step, date_str, model, add, peak));
    }

    let mut out = serde_json::Map::new();
    for (date_str, models) in &day_model_keys {
        let mut day = serde_json::Map::new();
        for model in models {
            let b = acc
                .get(&(date_str.clone(), model.clone()))
                .copied()
                .unwrap_or([0i64; 8]);
            day.insert(model.clone(), bucket_json8(&b));
        }
        out.insert(date_str.clone(), Value::Object(day));
    }
    // by_source：date 升序、source 按首现顺序（一次调用只喂一个 source，所以
    // 每日期下恒一个 source 键，但结构保持通用）、模型按首现顺序。
    let mut src_out = serde_json::Map::new();
    for (date_str, sources) in &src_day_keys {
        let mut src_day = serde_json::Map::new();
        for (source_name, models) in sources {
            let mut sm = serde_json::Map::new();
            for model in models {
                let b = src_acc
                    .get(&(date_str.clone(), source_name.clone(), model.clone()))
                    .copied()
                    .unwrap_or([0i64; 8]);
                sm.insert(model.clone(), bucket_json8(&b));
            }
            src_day.insert(source_name.clone(), Value::Object(sm));
        }
        src_out.insert(date_str.clone(), Value::Object(src_day));
    }
    // 只在有带日期样本时插 by_source 键——无样本/全无时间戳时输出仍是空对象
    // `{}`（与 `token_by_date_model_drops_untimed_samples` 钉的语义一致），
    // 不摆一个空 source 结构出来冒充「测到了什么」。
    if !src_out.is_empty() {
        out.insert("by_source".into(), Value::Object(src_out));
    }
    Value::Object(out)
}

/// 8 桶 → JSON 对象字面量。`token_by_date_model` 的主输出与 by_source 轴共用，
/// 保证两个轴同一份桶字段清单，不允许各自拼一份。
fn bucket_json8(b: &[i64; 8]) -> Value {
    json!({
        "uncached_input_tokens": b[0],
        "output_tokens": b[1],
        "cache_read_tokens": b[2],
        "cache_write_tokens": b[3],
        "peak_uncached_input_tokens": b[4],
        "peak_output_tokens": b[5],
        "peak_cache_read_tokens": b[6],
        "peak_cache_write_tokens": b[7],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::CoverageCounts;
    // canonical 归一层 phase C 迁进 `adapters/canonical_usage.rs`；这些测试
    // 复用本模块的 `reconcile_fixture`，留原处、经 crate 根 re-export 调进来。
    use agent_vitals_harnesses::canonical_usage::{
        canonical_tokens, canonical_total_delta, CANONICAL_DIMS,
    };

    #[test]
    fn ms_from_civil_matches_python_oracle_and_feeds_is_peak_slot() {
        // 2026-08-31 09:30 北京（周一）= 2026-08-31T01:30:00Z。与 Python
        // 侧手算 ms 交叉核对（scripts 里跑过同样的输入）。
        let ms = ms_from_civil(2026, 8, 31, 1, 30, 0).unwrap();
        assert_eq!(ms, 1_788_139_800_000);
        assert!(is_peak_slot(ms));
        // 同日 22:00 北京 = 14:00Z，空闲。
        let ms_off = ms_from_civil(2026, 8, 31, 14, 0, 0).unwrap();
        assert!(!is_peak_slot(ms_off));
        // 非法日期（2 月 30 日不存在）→ None，不是"给个数字将就"。
        assert!(ms_from_civil(2026, 2, 30, 0, 0, 0).is_none());
        // 越界小时/分/秒 → None。
        assert!(ms_from_civil(2026, 8, 31, 24, 0, 0).is_none());
        assert!(ms_from_civil(2026, 8, 31, 0, 60, 0).is_none());
        assert!(ms_from_civil(2026, 8, 31, 0, 0, 60).is_none());
    }

    #[test]
    fn usage_signal_status_unavailable_when_usage_signal_has_zero_coverage() {
        let cov = Coverage::new();
        let status = usage_signal_status(&cov);
        assert_eq!(status["status"], json!("unavailable"));
        assert_eq!(status["missing"], json!(["Usage"]));
    }

    #[test]
    fn usage_signal_status_measured_when_usage_signal_has_coverage() {
        let mut cov = Coverage::new();
        cov.set(Signal::Usage, CoverageCounts { measured: 3, ..Default::default() });
        let status = usage_signal_status(&cov);
        assert_eq!(status, json!({"status": "measured", "sample_count": 3}));
    }

    /// 同 (turn, step) 的 usage chunk 先到、message 后到：只计 message，不双计。
    #[test]
    fn usage_dedup_same_step_replaced_by_message() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{"config":{"model":"m"}}}}),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300}}}}),
            json!({"type":"assistant/message","seq":3,"data":{"turn":1,"step":1,"usage":{"inputTokens":1200,"outputTokens":250,"cacheReadTokens":300}}}),
        ];
        let out = token_by_model(&events);
        // 事件无 time 字段 → is_peak 保守判 false，peak_* 全 0。
        assert_eq!(
            out["by_model"]["m"],
            json!({
                "uncached_input_tokens":1200,"output_tokens":250,"cache_read_tokens":300,"cache_write_tokens":0,
                "peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0,
            })
        );
        assert_eq!(out["sequence"], json!(["m"]));
    }

    /// 模型切换保留「切回」信息：pro → flash → pro 的 sequence 是 3 个元素。
    #[test]
    fn usage_sequence_preserves_switch_back() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{"config":{"model":"a"}}}}),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1}}}}),
            json!({"type":"request/header","seq":3,"data":{"header":{"config":{"model":"b"}}}}),
            json!({"type":"assistant/chunk","seq":4,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1}}}}),
            json!({"type":"request/header","seq":5,"data":{"header":{"config":{"model":"a"}}}}),
            json!({"type":"assistant/chunk","seq":6,"data":{"turn":3,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1}}}}),
            // 相邻重复不推进序列
            json!({"type":"request/header","seq":7,"data":{"header":{"config":{"model":"a"}}}}),
        ];
        let out = token_by_model(&events);
        assert_eq!(out["sequence"], json!(["a", "b", "a"]));
        assert_eq!(out["by_model"]["a"]["uncached_input_tokens"], json!(2));
        assert_eq!(out["by_model"]["b"]["uncached_input_tokens"], json!(1));
    }

    /// 高峰/空闲按事件自己的 time 精确判定，不是猜的区间。北京 10:00（峰值）
    /// 与 20:00（空闲，18 点后）各出一条 usage，验证 peak_* 只累计峰值那条，
    /// 全量字段仍是两条之和——off-peak 由展示层拿 全量−peak 推出。
    #[test]
    fn usage_peak_hour_attributed_from_event_time() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1704074400000i64,"data":{"header":{"config":{"model":"m"}}}}),
            // 2024-01-01 10:00:00 北京时间（[9,12) 高峰）
            json!({"type":"assistant/chunk","seq":2,"time":1704074400000i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":10}}}}),
            // 2024-01-01 20:00:00 北京时间（18 点后，空闲）
            json!({"type":"assistant/chunk","seq":3,"time":1704110400000i64,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":50,"outputTokens":5}}}}),
        ];
        let out = token_by_model(&events);
        let bucket = &out["by_model"]["m"];
        assert_eq!(bucket["uncached_input_tokens"], json!(150), "全量 = 峰值 100 + 空闲 50");
        assert_eq!(bucket["output_tokens"], json!(15), "全量 = 峰值 10 + 空闲 5");
        assert_eq!(bucket["peak_uncached_input_tokens"], json!(100), "只有 10 点那条算峰值");
        assert_eq!(bucket["peak_output_tokens"], json!(10));
    }

    /// 无 request/header 的 usage 归 unknown 桶，不臆造模型。
    #[test]
    fn usage_no_header_goes_to_unknown() {
        let events = [
            json!({"type":"assistant/chunk","seq":1,"data":{"turn":9,"step":9,"chunk":{"type":"usage","usage":{"inputTokens":7}}}}),
        ];
        let out = token_by_model(&events);
        assert_eq!(out["by_model"]["unknown"]["uncached_input_tokens"], json!(7));
        assert_eq!(out["sequence"], json!([]));
    }

    /// 非 object 条目与缺 turn/step 的畸形 usage 事件跳过。
    #[test]
    fn usage_non_object_and_malformed_skipped() {
        let events = [
            json!("not-an-object"),
            json!(7),
            json!({"type":"assistant/chunk","seq":1,"data":{"chunk":{"type":"usage","usage":{"inputTokens":7}}}}), // 缺 turn/step
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"text","text":"x"}}}), // 非 usage
        ];
        let out = token_by_model(&events);
        // unreported_fields 为空：一个 usage 样本都没有，就不对「执行环境不报某字段」
        // 下断言——没有数据时不做判断，与 harness 能力缺失时「缺列不编列」同一条纪律。
        //
        // 但 seq:1 那条**残差哨兵能看到**：它有真实的 `inputTokens:7`，只是
        // 缺 turn/step 没法进正式折叠——这正是哨兵存在的意义（见
        // `usage_shaped_tokens` 文档）：以前这种事件会无声消失，现在会在
        // `unaccounted_usage` 里报出来，即使它"看起来"是认识的类型。
        assert_eq!(out, json!({
            "by_model": {}, "providers": {}, "sequence": [], "unreported_fields": [],
            "unaccounted_usage": [{"type": "assistant/chunk", "count": 1, "tokens_seen": 7}],
        }));
    }

    #[test]
    fn usage_shaped_tokens_finds_nested_fields() {
        let node = json!({"data": {"usage": {"inputTokens": 100, "outputTokens": 20}}});
        assert_eq!(usage_shaped_tokens(&node, 0), Some(120));
    }

    #[test]
    fn usage_shaped_tokens_ignores_unknown_field_names() {
        // maxTokens/shadowedTokenCount 不在 SAMPLE_FIELDS 里——不能把配置/
        // 统计字段误当成用量，否则哨兵会在每条 compaction/start 上假报警。
        let node = json!({"maxTokens": 8192, "shadowedTokenCount": 12345});
        assert_eq!(usage_shaped_tokens(&node, 0), None);
    }

    #[test]
    fn usage_shaped_tokens_bare_scalar_is_none() {
        assert_eq!(usage_shaped_tokens(&json!("just a string"), 0), None);
        assert_eq!(usage_shaped_tokens(&json!(42), 0), None);
        assert_eq!(usage_shaped_tokens(&Value::Null, 0), None);
    }

    fn compaction_event(compaction_id: Option<&str>) -> Value {
        json!({
            "type": "compaction/summary", "seq": 1, "time": 1_787_813_784_275i64,
            "data": {
                "compactionId": compaction_id,
                "sourceCommandId": "cmd-1",
                "model": "deepseek-v4-flash",
                "provider": "deepseek-official",
                "usage": {"inputTokens": 462, "outputTokens": 3520, "cacheReadTokens": 245760},
            },
        })
    }

    /// 真实回归：DSH 的 `compaction/summary` 带真实 usage（实测这份数字：
    /// inputTokens 462 / outputTokens 3520 / cacheReadTokens 245760）且自带
    /// model/provider，但没有 turn/step（compaction 由 `sourceCommandId`
    /// 触发，不属于任何 turn），过去被 `usage_sample` 的类型白名单和
    /// turn/step 校验双重挡在外面，用户在菜单栏上肉眼发现"今天有消耗但
    /// 日历是 0"才暴露。
    #[test]
    fn token_by_model_counts_compaction_usage() {
        let events = [compaction_event(Some("c1"))];
        let out = token_by_model(&events);
        assert_eq!(out["unaccounted_usage"], json!([]));
        assert_eq!(out["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], json!(462));
        assert_eq!(out["by_model"]["deepseek-v4-flash"]["output_tokens"], json!(3520));
        assert_eq!(out["by_model"]["deepseek-v4-flash"]["cache_read_tokens"], json!(245760));
    }

    /// compaction 自带 model/provider，不能沿用 request/header 追踪的
    /// "当前激活模型"——真实实测：会话主体用 pro，compaction 走的是
    /// flash/deepseek-official，两者是不同的供应商价目表。
    #[test]
    fn compaction_model_overrides_currently_active_model() {
        let events = [
            json!({"type":"request/header","seq":0,"time":1,
                   "data":{"header":{"config":{"model":"deepseek-v4-pro","provider":"shengsuanyun"}}}}),
            compaction_event(Some("c1")),
        ];
        let out = token_by_model(&events);
        let by_model = out["by_model"].as_object().unwrap();
        assert_eq!(by_model.keys().collect::<Vec<_>>(), vec!["deepseek-v4-flash"],
            "compaction 不该被记进'当前激活'的 pro,必须用它自己的 flash");
        assert_eq!(out["providers"]["deepseek-v4-flash"], json!("deepseek-official"));
        assert_eq!(out["providers"]["deepseek-v4-pro"], json!("shengsuanyun"));
    }

    /// 同一个 compactionId 出现两次（真实撞见过：一次 compaction 被 fork
    /// 复制进 4 个会话文件）——"同 (turn,step) 值相同则跳过"分支应该只算
    /// 一次，不是两次。
    #[test]
    fn same_compaction_id_deduped_across_fork_copies() {
        let ev = compaction_event(Some("same-id"));
        let mut ev2 = ev.clone();
        ev2["seq"] = json!(2);
        let out = token_by_model(&[ev, ev2]);
        assert_eq!(out["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], json!(462),
            "同一个 compactionId 重复出现，token 不能翻倍");
    }

    /// 不同 compactionId 必须落进独立的去重槽——不能因为哈希映射到同一个
    /// 身份而互相覆盖，导致只剩最后一次的量。
    #[test]
    fn different_compaction_ids_do_not_collide() {
        let mut ev1 = compaction_event(Some("id-1"));
        ev1["data"]["usage"]["inputTokens"] = json!(100);
        let mut ev2 = compaction_event(Some("id-2"));
        ev2["data"]["usage"]["inputTokens"] = json!(200);
        let out = token_by_model(&[ev1, ev2]);
        assert_eq!(out["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], json!(300),
            "两次不同的 compaction 都应该被计入，不能互相覆盖");
    }

    #[test]
    fn missing_compaction_id_does_not_crash() {
        let out = token_by_model(&[compaction_event(None)]);
        assert!(out["by_model"]["deepseek-v4-flash"].is_object());
    }

    /// compaction 的 (turn, step) 是内部去重用的哈希身份，不是真实存在的
    /// turn 号——报给调用方的行必须诚实写 null，不能把去重实现细节泄漏成
    /// 一个看起来像真实 turn 的负数。
    #[test]
    fn request_metrics_reports_turn_and_step_as_null_for_compaction() {
        let rows = request_metrics(&[compaction_event(Some("c1"))]);
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["turn"], Value::Null);
        assert_eq!(rows[0]["step"], Value::Null);
        assert_eq!(rows[0]["model"], json!("deepseek-v4-flash"));
    }

    #[test]
    fn token_by_date_model_attributes_compaction_to_its_own_date_and_model() {
        let out = token_by_date_model(&[compaction_event(Some("c1"))], SOURCE_UNSPECIFIED);
        // 1787813784275 ms → 2026-08-27（北京时间），与真实那次 compact 一致。
        assert_eq!(out["2026-08-27"]["deepseek-v4-flash"]["uncached_input_tokens"], json!(462));
    }

    /// `compaction/start`/`compaction/end` 没有 usage 字段——不该被
    /// `usage_sample` 接住，也不该触发哨兵（它们的 payload 里根本没有
    /// `SAMPLE_FIELDS` 那四个名字）。
    #[test]
    fn compaction_start_and_end_without_usage_are_not_accounted_or_sentinelled() {
        let events = [
            json!({"type":"compaction/start","seq":1,"time":1,
                   "data":{"compactionId":"c1","sourceCommandId":"cmd-1"}}),
            json!({"type":"compaction/end","seq":2,"time":2,
                   "data":{"compactionId":"c1","sourceCommandId":"cmd-1"}}),
        ];
        let out = token_by_model(&events);
        assert_eq!(out["by_model"], json!({}));
        assert_eq!(out["unaccounted_usage"], json!([]));
    }

    /// Python `json.dumps(token_by_model(events), ensure_ascii=False, separators=(",", ":"))`
    /// 对同一事件流（见本文件 docstring 提到的平行实现）的逐字节对照 —— 键序、
    /// 值、序列全部一致。期望串在 Python 侧生成后硬编码于此，Python 一改这里就红。
    #[test]
    fn token_by_model_python_rust_byte_for_byte_parity() {
        let events = [
            json!({"type":"user/message","seq":1,"time":1,"data":{"turn":0,"step":0}}),
            json!({"type":"request/header","seq":2,"time":2,"data":{"header":{"config":{"model":"deepseek/deepseek-v4-pro-0813"}}}}),
            json!({"type":"assistant/chunk","seq":3,"time":3,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300}}}}),
            json!({"type":"assistant/chunk","seq":4,"time":4,"data":{"turn":1,"step":1,"chunk":{"type":"text","text":"你好"}}}),
            json!({"type":"assistant/message","seq":5,"time":5,"data":{"turn":1,"step":1,"usage":{"inputTokens":1200,"outputTokens":250,"cacheReadTokens":300}}}),
            json!({"type":"request/header","seq":6,"time":6,"data":{"header":{"config":{"model":"deepseek/deepseek-v4-flash"}}}}),
            json!({"type":"assistant/chunk","seq":7,"time":7,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500,"outputTokens":50}}}}),
            json!({"type":"request/header","seq":8,"time":8,"data":{"header":{"config":{"model":"deepseek/deepseek-v4-pro-0813"}}}}),
            json!({"type":"assistant/chunk","seq":9,"time":9,"data":{"turn":3,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":700,"cacheReadTokens":20}}}}),
        ];
        let out = token_by_model(&events);
        // 事件 time 都是 1–9（unix ms，北京时间 1970-01-01 08:00:00 附近）→
        // 落在 [8,9) 点，不在任何高峰区间，peak_* 全 0。
        assert_eq!(
            serde_json::to_string(&out).unwrap(),
            r#"{"by_model":{"deepseek/deepseek-v4-pro-0813":{"uncached_input_tokens":1900,"output_tokens":250,"cache_read_tokens":320,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"deepseek/deepseek-v4-flash":{"uncached_input_tokens":500,"output_tokens":50,"cache_read_tokens":0,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},"providers":{"deepseek/deepseek-v4-pro-0813":null,"deepseek/deepseek-v4-flash":null},"sequence":["deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro-0813"],"unreported_fields":["cacheWriteTokens"],"unaccounted_usage":[]}"#
        );
    }

    // ── resumable fold（§10.2 契约：fold(0..n) == fold_resume(checkpoint@k, k..n)）──

    /// 解析 fixtures/dsh/resume.jsonl（每行一个 JSON 对象事件）。
    fn read_resume_fixture() -> Vec<Value> {
        let raw = include_str!("../../../../fixtures/dsh/resume.jsonl");
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("fixture line must parse"))
            .collect()
    }

    /// §10.2 契约正文：`fold(events[0..n]) == fold_resume(checkpoint@k, events[k..n])`
    /// 对任何 **turn 边界** k 成立（k=0 和 k=n 是平凡边界，也一起钉住）。
    ///
    /// 实测依据（fixtures/dsh/resume.jsonl）：resume 后缀从 turn/start 开始——
    /// 第一条 usage 是新 turn，不会命中 checkpoint 里最后一条的同 (turn, step)
    /// 替换槽，所以 `last` 去重槽可以不进 checkpoint。这就是把 `last` 留在
    /// `usage_fold_into` 局部、而不是塞进 `UsageFoldState` 的等价性证明。
    #[test]
    fn usage_fold_resume_equals_full_fold_at_turn_boundaries() {
        let events = read_resume_fixture();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("turn/start"))
                .count(),
            3,
            "fixture 必须是 3 个 turn（覆盖切回 + 同 step 替换 + 哨兵）"
        );
        let full = token_by_model(&events);
        let mut boundaries = vec![0usize, events.len()];
        for (i, e) in events.iter().enumerate() {
            if e.get("type").and_then(|v| v.as_str()) == Some("turn/start") {
                boundaries.push(i);
            }
        }
        boundaries.sort_unstable();
        assert!(boundaries.len() >= 3, "need multiple turn boundaries");
        for k in boundaries {
            let checkpoint = usage_fold_checkpoint(&events[..k]);
            let resumed = usage_fold_resume(&checkpoint, &events[k..]);
            assert_eq!(resumed, full, "resume at k={k} must equal full fold");
        }
    }

    /// Python `json.dumps(usage_fold_resume(usage_fold_checkpoint(events[:6]),
    /// events[6:]), ensure_ascii=False, separators=(",", ":"))` 的逐字节对照。
    /// 期望串在 Python 侧生成后硬编码于此（同
    /// `token_by_model_python_rust_byte_for_byte_parity` 的模式），Python 一改
    /// 这里就红。
    ///
    /// k=6 是 turn 2 的起点：前缀折出 pro（turn1 的净结果 1200），后缀折入
    /// flash → 回 pro（切回）→ compaction 的模型覆盖 → turn3 同 step 替换
    /// （3000 被 3100 顶掉）→ 缺 turn/step 的残差哨兵。所有跨 turn 路径都经过
    /// 这里——任何一处 Python↔Rust 漂移都会让这个字符串不等。数值也钉住：
    /// pro=4300/250/1300、flash=2000/500/100、compaction=462/3520/245760、
    /// peak_* 全 0（事件全在非高峰）、哨兵 assistant/message 86 tokens。
    #[test]
    fn usage_fold_resume_python_rust_byte_for_byte_parity() {
        let events = read_resume_fixture();
        let checkpoint = usage_fold_checkpoint(&events[..6]);
        let resumed = usage_fold_resume(&checkpoint, &events[6..]);
        assert_eq!(
            serde_json::to_string(&resumed).unwrap(),
            r#"{"by_model":{"deepseek/deepseek-v4-pro-0813":{"uncached_input_tokens":4300,"output_tokens":250,"cache_read_tokens":1300,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"deepseek/deepseek-v4-flash":{"uncached_input_tokens":2000,"output_tokens":500,"cache_read_tokens":100,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"deepseek-v4-flash":{"uncached_input_tokens":462,"output_tokens":3520,"cache_read_tokens":245760,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},"providers":{"deepseek/deepseek-v4-pro-0813":"shengsuanyun","deepseek/deepseek-v4-flash":"deepseek-official","deepseek-v4-flash":"deepseek-official"},"sequence":["deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro-0813"],"unreported_fields":["cacheWriteTokens"],"unaccounted_usage":[{"type":"assistant/message","count":1,"tokens_seen":86}]}"#
        );
    }

    /// checkpoint 序列化往返不丢状态：to_json → from_json → 同一 render 输出。
    /// `active` 是「下一 turn 会继承的模型」，最容易被序列化丢掉——单独断言。
    #[test]
    fn usage_fold_checkpoint_json_round_trips() {
        let events = read_resume_fixture();
        let checkpoint = usage_fold_checkpoint(&events);
        let json = usage_fold_checkpoint_json(&checkpoint);
        let restored = usage_fold_resume_from_json(&json);
        assert_eq!(usage_fold_render(&restored), usage_fold_render(&checkpoint));
        assert_eq!(restored.active, checkpoint.active);
        assert_eq!(restored.samples, checkpoint.samples);
        assert_eq!(restored.unaccounted, checkpoint.unaccounted);
    }

    /// Python `usage_fold_checkpoint_json` 输出的逐字节对照——watcher 将来可能
    /// 把 checkpoint 落盘、让 Rust 与 Python 进程互读，序列化格式必须锁死
    /// （`seen` 是 `_SAMPLE_FIELDS` 顺序的 4 个 bool；`unaccounted` 每条是
    /// `[count, tokens_seen]` 列表；`by_model` 保插入序）。
    #[test]
    fn usage_fold_checkpoint_json_python_rust_byte_for_byte_parity() {
        let events = read_resume_fixture();
        let json = usage_fold_checkpoint_json(&usage_fold_checkpoint(&events));
        assert_eq!(
            serde_json::to_string(&json).unwrap(),
            r#"{"by_model":{"deepseek/deepseek-v4-pro-0813":{"uncached_input_tokens":4300,"output_tokens":250,"cache_read_tokens":1300,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"deepseek/deepseek-v4-flash":{"uncached_input_tokens":2000,"output_tokens":500,"cache_read_tokens":100,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"deepseek-v4-flash":{"uncached_input_tokens":462,"output_tokens":3520,"cache_read_tokens":245760,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},"providers":{"deepseek/deepseek-v4-pro-0813":"shengsuanyun","deepseek/deepseek-v4-flash":"deepseek-official","deepseek-v4-flash":"deepseek-official"},"active":"deepseek/deepseek-v4-pro-0813","sequence":["deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro-0813"],"seen":[true,true,true,false],"samples":6,"unaccounted":{"assistant/message":[1,86]}}"#
        );
    }

    /// 「字段从未上报」必须与「字段上报了 0」区分开——这两者以前都落成 `0`，
    /// UI 于是把「执行环境根本不报缓存写入」显示成「缓存写 0」，一个伪造的测量值。
    ///
    /// 实测依据：真实会话 session-e4b0be69 的 1398 个 usage 样本里
    /// `cacheWriteTokens` 一次都没出现，`cacheReadTokens` 出现 1348 次——
    /// 「缺席」在真实数据里是常态，不是边缘情况。
    #[test]
    fn usage_unreported_field_is_not_a_measured_zero() {
        let header = json!({"type":"request/header","seq":1,"data":{"header":{"config":{"model":"m"}}}});

        // ① 执行环境从不上报 cacheWrite/cacheRead → 两者都进 unreported_fields
        let absent = [
            header.clone(),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":2}}}}),
        ];
        let out = token_by_model(&absent);
        assert_eq!(out["unreported_fields"], json!(["cacheReadTokens", "cacheWriteTokens"]));
        assert_eq!(out["by_model"]["m"]["cache_write_tokens"], json!(0), "求和仍按 0——四桶之和必须与 tokenUsage 相等");

        // ② 执行环境显式上报 0 → 不算未上报，`0` 是一个真实测量值
        let explicit_zero = [
            header.clone(),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0}}}}),
        ];
        let out = token_by_model(&explicit_zero);
        assert_eq!(out["unreported_fields"], json!([]), "上报了 0 就是测到了 0，不能算未上报");

        // ③ 只要出现过一次就算已上报——673 次缺席 + 1 次出现，仍是「报了」
        let sometimes = [
            header,
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":10}}}}),
            json!({"type":"assistant/chunk","seq":3,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":10,"cacheReadTokens":5}}}}),
        ];
        let out = token_by_model(&sometimes);
        assert_eq!(out["unreported_fields"], json!(["outputTokens", "cacheWriteTokens"]));
    }

    // ── request_metrics（逐请求分辨率）────────────────────────────────────

    /// 一次请求一行，含定位（turn/step/seq/time）、模型与分母。
    ///
    /// 这些字段以前**全都存在于事件流、却被 fold 丢掉了**：`usage_sample` 早就
    /// 在读 turn/step（只为去重），`request/header` 的 seq/time 也在手上。会话
    /// 健康时间线做不出来不是因为没数据，是因为没有出口。
    #[test]
    fn request_metrics_emits_one_row_per_request_with_coordinates() {
        let events = [
            json!({"type":"request/context","seq":1,"time":1001,"data":{"provider":"p","model":"m","contextWindow":1000000}}),
            json!({"type":"request/header","seq":2,"time":1002,"data":{"header":{"config":{"model":"m"}}}}),
            json!({"type":"assistant/chunk","seq":3,"time":1003,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300,"cacheWriteTokens":0}}}}),
            json!({"type":"assistant/chunk","seq":4,"time":1004,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":2000,"outputTokens":50,"cacheReadTokens":700,"cacheWriteTokens":0}}}}),
        ];
        let out = request_metrics(&events);
        let rows = out.as_array().unwrap();
        assert_eq!(rows.len(), 2, "两次请求两行");
        assert_eq!(rows[0]["request_seq"], json!(1));
        assert_eq!(rows[0]["turn"], json!(1));
        assert_eq!(rows[0]["step"], json!(1));
        assert_eq!(rows[0]["seq"], json!(3));
        assert_eq!(rows[0]["time"], json!(1003));
        assert_eq!(rows[0]["model"], json!("m"));
        assert_eq!(rows[0]["context_window"], json!(1000000), "分母来自 request/context");
        assert_eq!(rows[0]["context_tokens"], json!(1300), "1000 未命中 + 300 命中");
        assert_eq!(rows[1]["request_seq"], json!(2));
        assert_eq!(rows[1]["context_tokens"], json!(2700));
        // 分母只上报一次，对后续请求继续有效
        assert_eq!(rows[1]["context_window"], json!(1000000));
    }

    /// 缺字段落 `null`，不落 0；`context_tokens` 缺任一加数就整行留空。
    ///
    /// 实测依据：真实会话 687 个请求点里 13 个缺 `cacheReadTokens`。给这 13 点
    /// 用「只有未命中输入」凑一个偏低的占用，画出来的曲线会在这些点莫名塌陷，
    /// 比直接留缺口更有害——FR-04 规定的降级正由此触发。
    #[test]
    fn request_metrics_missing_field_is_null_not_zero() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{"config":{"model":"m"}}}}),
            // 缺 cacheReadTokens
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200}}}}),
        ];
        let rows = request_metrics(&events);
        let row = &rows[0];
        assert_eq!(row["cache_read_tokens"], Value::Null, "执行环境没报就是 null，不是 0");
        assert_eq!(row["cache_write_tokens"], Value::Null);
        assert_eq!(row["context_tokens"], Value::Null, "缺一个加数，整行留空而不是拿部分和硬凑");
        assert_eq!(row["uncached_input_tokens"], json!(1000), "在场的字段照常给值");
    }

    /// 无 request/context 时分母为 null——不拿任何默认窗口顶替。
    #[test]
    fn request_metrics_absent_context_window_is_null() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{"config":{"model":"m"}}}}),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":10,"cacheReadTokens":5}}}}),
        ];
        let rows = request_metrics(&events);
        assert_eq!(rows[0]["context_window"], Value::Null, "没有分母就是没有，不臆造 128K");
        assert_eq!(rows[0]["context_tokens"], json!(15), "分子照常可算");
    }

    /// 不输出逐请求的 `compacted` 布尔列——压缩事件类型已确认（见 `compaction.rs`），
    /// 但它独立于请求，不该硬塞成每行一个 true/false；真正的压缩视图是
    /// `compaction_events()` 单独的输出。
    #[test]
    fn request_metrics_omits_per_request_compacted_field() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{"config":{"model":"m"}}}}),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1}}}}),
        ];
        let rows = request_metrics(&events);
        // 压缩视图独立存在于 compaction::compaction_events，不塞进逐请求的一列。
        assert!(rows[0].get("compacted").is_none(), "压缩是独立事件，不是逐请求布尔列");
    }

    /// 模型切换：每行归属当时活跃的模型，分母随 request/context 更新。
    #[test]
    fn request_metrics_attributes_model_per_request() {
        let events = [
            json!({"type":"request/context","seq":1,"data":{"contextWindow":1000000}}),
            json!({"type":"request/header","seq":2,"data":{"header":{"config":{"model":"pro"}}}}),
            json!({"type":"assistant/chunk","seq":3,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":10,"cacheReadTokens":1}}}}),
            json!({"type":"request/context","seq":4,"data":{"contextWindow":128000}}),
            json!({"type":"request/header","seq":5,"data":{"header":{"config":{"model":"flash"}}}}),
            json!({"type":"assistant/chunk","seq":6,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":20,"cacheReadTokens":2}}}}),
        ];
        let rows = request_metrics(&events);
        assert_eq!(rows[0]["model"], json!("pro"));
        assert_eq!(rows[0]["context_window"], json!(1000000));
        assert_eq!(rows[1]["model"], json!("flash"));
        assert_eq!(rows[1]["context_window"], json!(128000), "窗口随切换变化时必须跟着变");
    }

    /// 无 request/header 归 unknown 桶，与 token_by_model 一致，不臆造模型。
    #[test]
    fn request_metrics_no_header_is_unknown() {
        let events = [
            json!({"type":"assistant/chunk","seq":1,"data":{"turn":9,"step":9,"chunk":{"type":"usage","usage":{"inputTokens":7}}}}),
        ];
        let rows = request_metrics(&events);
        assert_eq!(rows[0]["model"], json!("unknown"));
    }

    /// **同源不变量**：逐请求四桶之和 == `token_by_model` 四桶之和。
    ///
    /// 这是 `request_metrics` 与 `token_by_model` 必须共用同一套去重语义的证明。
    /// 任何一边改了去重（比如把「后到者覆盖」改成「首个胜出」）都会让这条红。
    /// 真实会话 session-e4b0be69 上也对过：1398 个样本去重成 687 个请求点，
    /// 四桶之和 226,424,711 / 685,754 / 50,073,856 / 0 两侧完全一致。
    #[test]
    fn request_metrics_reconciles_with_token_by_model() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{"config":{"model":"pro"}}}}),
            // 同 (1,1)：chunk 先到、message 后到 —— 只算后者
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300,"cacheWriteTokens":0}}}}),
            json!({"type":"assistant/message","seq":3,"data":{"turn":1,"step":1,"usage":{"inputTokens":1200,"outputTokens":250,"cacheReadTokens":300,"cacheWriteTokens":0}}}),
            json!({"type":"request/header","seq":4,"data":{"header":{"config":{"model":"flash"}}}}),
            json!({"type":"assistant/chunk","seq":5,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500,"outputTokens":50,"cacheReadTokens":0,"cacheWriteTokens":0}}}}),
            json!({"type":"assistant/chunk","seq":6,"data":{"turn":3,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":700,"outputTokens":10,"cacheReadTokens":20,"cacheWriteTokens":0}}}}),
        ];
        let rows = request_metrics(&events);
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 3, "4 个样本去重成 3 个请求点");

        let sum = |key: &str| -> i64 {
            rows.iter().map(|r| r[key].as_i64().unwrap_or(0)).sum()
        };
        let agg = token_by_model(&events);
        let agg_sum = |key: &str| -> i64 {
            agg["by_model"]
                .as_object()
                .unwrap()
                .values()
                .map(|m| m[key].as_i64().unwrap_or(0))
                .sum()
        };
        for key in ["uncached_input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] {
            assert_eq!(sum(key), agg_sum(key), "{key} 逐请求之和必须等于按模型之和");
        }
        assert_eq!(sum("uncached_input_tokens"), 2400, "1200(替换后) + 500 + 700");
    }

    /// Python `json.dumps(request_metrics(events), ensure_ascii=False,
    /// separators=(",", ":"))` 的逐字节对照——键序、null 位置、值全部一致。
    /// 期望串在 Python 侧生成后硬编码于此。**注意这条只钉 Rust**：它不跑
    /// Python，所以 Python 侧必须有 `tests/test_characterization.py::
    /// TestRequestMetrics::test_byte_for_byte_matches_rust` 钉同一个串，
    /// 两侧各钉一次才是真差分（只钉一侧的话另一侧单方面改动仍然全绿）。
    ///
    /// 第二行故意缺 `cacheReadTokens`：验证 `cache_read_tokens` 与
    /// `context_tokens` 双双落 `null` 而不是 0，且两侧对 null 的序列化一致。
    #[test]
    fn request_metrics_python_rust_byte_for_byte_parity() {
        let events = [
            json!({"type":"request/context","seq":1,"time":1001,"data":{"provider":"p","model":"m","contextWindow":1000000}}),
            json!({"type":"request/header","seq":2,"time":1002,"data":{"header":{"config":{"model":"m"}}}}),
            json!({"type":"assistant/chunk","seq":3,"time":1003,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300}}}}),
            json!({"type":"assistant/chunk","seq":4,"time":1004,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":2000,"outputTokens":50}}}}),
        ];
        assert_eq!(
            serde_json::to_string(&request_metrics(&events)).unwrap(),
            r#"[{"request_seq":1,"seq":3,"time":1003,"turn":1,"step":1,"model":"m","context_window":1000000,"context_tokens":1300,"uncached_input_tokens":1000,"output_tokens":200,"cache_read_tokens":300,"cache_write_tokens":null,"is_peak":false},{"request_seq":2,"seq":4,"time":1004,"turn":2,"step":1,"model":"m","context_window":1000000,"context_tokens":null,"uncached_input_tokens":2000,"output_tokens":50,"cache_read_tokens":null,"cache_write_tokens":null,"is_peak":false}]"#
        );
    }

    // ── context_composition（FR-04a 常驻上下文构成）────────────────────────

    /// 三类都来自真实事件：system/tools 取自 request/header，catalog 取自
    /// data.source.kind == "skill-catalog"（不是专用事件类型）。
    #[test]
    fn context_composition_classifies_resident_prefix() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{
                "config":{"model":"m"},
                "system":"You are an AI agent.",
                "tools":[{"name":"bash","description":"Run a shell command"}]
            }}}),
            json!({"type":"user/message","seq":2,"data":{"source":{
                "kind":"skill-catalog","form":"catalog",
                "entries":[{"name":"a","description":"skill a does things"},
                           {"name":"b","description":"skill b"}]
            }}}),
        ];
        let out = context_composition(&events);
        assert_eq!(out["system_tokens"], json!(crate::util::est_tokens("You are an AI agent.")));
        assert_eq!(out["catalog_entries"], json!(2));
        let expect_catalog = crate::util::est_tokens("askill a does things")
            + crate::util::est_tokens("bskill b");
        assert_eq!(out["catalog_tokens"], json!(expect_catalog));
        assert_eq!(
            out["catalog_names"],
            json!([
                {"name": "a", "tokens": crate::util::est_tokens("askill a does things")},
                {"name": "b", "tokens": crate::util::est_tokens("bskill b")},
            ]),
            "逐条拆分只带 name + tokens，不带 description 原文"
        );
        assert_eq!(out["estimator"], json!("est_tokens"));
        // 合计 = 三项之和
        let total = out["system_tokens"].as_i64().unwrap()
            + out["tools_tokens"].as_i64().unwrap()
            + out["catalog_tokens"].as_i64().unwrap();
        assert_eq!(out["resident_total"], json!(total));
    }

    /// Python `json.dumps(context_composition(events), ensure_ascii=False,
    /// separators=(",", ":"))` 的逐字节对照。两侧各钉一次才是真差分——见
    /// `request_metrics_python_rust_byte_for_byte_parity` 的同款说明。
    ///
    /// `tools_tokens` 特别容易分叉：它估的是**序列化后的 JSON 文本**，
    /// Python 必须用 `separators=(",", ":")`（紧凑，无空格）才能与 Rust 的
    /// `serde_json::to_string` 一致。默认的 `json.dumps` 会在 `, ` 和 `: ` 里
    /// 多出空格，字符数变多、估算值随之偏大——这条断言就是钉这个的。
    #[test]
    fn context_composition_python_rust_byte_for_byte_parity() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{
                "config":{"model":"m"},
                "system":"You are an AI agent.",
                "tools":[{"name":"bash","description":"Run a shell command"}]
            }}}),
            json!({"type":"user/message","seq":2,"data":{"source":{
                "kind":"skill-catalog","form":"catalog",
                "entries":[{"name":"a","description":"skill a does things"},
                           {"name":"b","description":"skill b"}]
            }}}),
        ];
        assert_eq!(
            serde_json::to_string(&context_composition(&events)).unwrap(),
            r#"{"system_tokens":6,"tools_tokens":15,"catalog_tokens":8,"catalog_entries":2,"catalog_names":[{"name":"a","tokens":6},{"name":"b","tokens":2}],"resident_total":29,"estimator":"est_tokens"}"#
        );
    }

    /// 「最近一次发布覆盖前一次」：目录中途重发，当前状态是最后那次，
    /// 不是历次累加（累加会把同一批技能算两遍）。
    #[test]
    fn context_composition_catalog_last_publication_wins() {
        let events = [
            json!({"type":"user/message","seq":1,"data":{"source":{
                "kind":"skill-catalog","entries":[
                    {"name":"a","description":"x"},{"name":"b","description":"y"},
                    {"name":"c","description":"z"}]}}}),
            json!({"type":"agent/inbox/spliced","seq":2,"data":{"source":{
                "kind":"skill-catalog","entries":[{"name":"a","description":"x"}]}}}),
        ];
        let out = context_composition(&events);
        assert_eq!(out["catalog_entries"], json!(1), "取最后一次发布，不累加");
        assert_eq!(out["catalog_tokens"], json!(crate::util::est_tokens("ax")));
        assert_eq!(
            out["catalog_names"],
            json!([{"name": "a", "tokens": crate::util::est_tokens("ax")}]),
            "取最后一次发布，不累加"
        );
    }

    /// 源事件从未出现 → `null` 而不是 0。
    ///
    /// 「日志里没有 skill-catalog 事件」与「发布了一个空目录」是两回事：前者是
    /// 未知，后者是测到了 0。混成同一个 0，UI 就会写「0 个技能」——一个伪造的
    /// 测量值，与 `unreported_fields` 当初修的是同一类缺陷。
    #[test]
    fn context_composition_absent_source_is_null_not_zero() {
        let out = context_composition(&[]);
        assert_eq!(out["system_tokens"], Value::Null);
        assert_eq!(out["tools_tokens"], Value::Null);
        assert_eq!(out["catalog_tokens"], Value::Null);
        assert_eq!(out["catalog_entries"], Value::Null);
        assert_eq!(out["catalog_names"], Value::Null, "没见过 catalog 事件时是 null，不是空数组");
        assert_eq!(out["resident_total"], Value::Null, "三项全缺时不给 0 当合计");

        // 只有 header 没有 catalog：catalog 仍是 null，但合计按已知项给出
        let partial = [json!({"type":"request/header","seq":1,"data":{"header":{
            "system":"abc","tools":[]
        }}})];
        let out = context_composition(&partial);
        assert_eq!(out["catalog_tokens"], Value::Null);
        assert!(out["resident_total"].as_i64().is_some(), "有已知项就给合计");
    }

    /// T1 隐私决策：`catalog_names` 只出 `{name, tokens}`，description 原文绝不
    /// 出现在输出的任何位置——一旦进投影就会跟着走通用导出路径，FR-SK-09 要求
    /// 导出不含未脱敏内容。这里故意塞一个包含敏感词的 description，断言序列化
    /// 后的整个 JSON 字符串里都找不到它。
    #[test]
    fn context_composition_catalog_names_excludes_description_text() {
        let events = [json!({"type":"user/message","seq":1,"data":{"source":{
            "kind":"skill-catalog","entries":[
                {"name":"a","description":"contains SECRET_TOKEN_ABC123 in the text"}]}}})];
        let out = context_composition(&events);
        let serialized = serde_json::to_string(&out).unwrap();
        assert!(
            !serialized.contains("SECRET_TOKEN_ABC123"),
            "description 原文不得出现在 context_composition 的任何输出字段里"
        );
        assert_eq!(
            out["catalog_names"],
            json!([{"name": "a", "tokens": crate::util::est_tokens("acontains SECRET_TOKEN_ABC123 in the text")}])
        );
    }

    /// 模型切换会重发 request/header —— system/tools 取最近一次。
    #[test]
    fn context_composition_header_last_wins() {
        let events = [
            json!({"type":"request/header","seq":1,"data":{"header":{"system":"short","tools":[]}}}),
            json!({"type":"request/header","seq":2,"data":{"header":{
                "system":"a much longer system prompt than the first one","tools":[]}}}),
        ];
        let out = context_composition(&events);
        assert_eq!(
            out["system_tokens"],
            json!(crate::util::est_tokens("a much longer system prompt than the first one"))
        );
    }

    /// 高峰只在**周一至周五**的 9–12、14–18 点；周末全天空闲。
    ///
    /// 这条是真实账单打出来的回归：2026-08-23（周日）14:45 那次会话，29 次请求
    /// 的 token 数与 DeepSeek 账单逐位吻合，金额却正好 ×2.0000——因为原来的
    /// `is_peak` 只看小时不看星期，把周日下午判成了高峰，而每一档 peak 恰好是
    /// off_peak 的两倍。更隐蔽的是它**从来没被真实账单验证过**：在这之前唯一
    /// 对过账的会话跑在 21–22 点，全程走空闲分支，碰巧对上了。
    #[test]
    fn peak_requires_weekday_not_just_hour() {
        // 北京时间的确定性时间戳（见函数注释里的换算）。
        const FRI_10: i64 = 1787277600000; // 2026-08-21 周五 10:00
        const SAT_10: i64 = 1787364000000; // 2026-08-22 周六 10:00
        const SUN_14: i64 = 1787464800000; // 2026-08-23 周日 14:00
        const MON_15: i64 = 1787554800000; // 2026-08-24 周一 15:00
        const MON_20: i64 = 1787572800000; // 2026-08-24 周一 20:00

        // 星期换算本身先钉住（周一=0 … 周日=6）
        assert_eq!(beijing_weekday(FRI_10), 4);
        assert_eq!(beijing_weekday(SAT_10), 5);
        assert_eq!(beijing_weekday(SUN_14), 6);
        assert_eq!(beijing_weekday(MON_15), 0);

        assert!(is_peak_slot(FRI_10), "周五 10 点在高峰窗口内");
        assert!(is_peak_slot(MON_15), "周一 15 点在高峰窗口内");
        // **回归点**：同样是 10 点/14 点，周末必须是空闲。
        assert!(!is_peak_slot(SAT_10), "周六全天空闲，即使落在 9–12 内");
        assert!(!is_peak_slot(SUN_14), "周日全天空闲——真实账单打出来的那条");
        // 工作日但在窗口外，仍是空闲（上一次对账碰巧走的就是这条路）。
        assert!(!is_peak_slot(MON_20), "周一 20 点在窗口外");
    }

    /// 星期换算是**纯算术**，不是查表，也没有写死任何一个具体周末。
    ///
    /// Rust 侧没有日期库可以当参照，所以证明方式换成「滚动日历不变量」：从一个
    /// 已知锚点出发，往后每加一天星期就 +1 并按 7 取模，连续 200 年不许漂移。
    /// 闰年、世纪边界（2000 是闰年、2100 不是）全都跨过——算法根本不做日历
    /// 运算，只在绝对秒数上做整除，这些情况对它不存在。
    ///
    /// 与 Python 侧那条「逐日对照标准库 1970→2100」互补：那边证明绝对正确性，
    /// 这边证明无漂移；两者由 `test_cli_matrix.py` 的逐字节差分绑在一起。
    #[test]
    fn weekday_is_arithmetic_not_a_hardcoded_table() {
        const DAY_MS: i64 = 86_400_000;
        const MON_15: i64 = 1787554800000; // 锚点：2026-08-24 周一 15:00 北京
        assert_eq!(beijing_weekday(MON_15), 0, "锚点必须是周一");

        // 往后 200 年逐日推进，星期必须严格 +1 mod 7。
        for k in 0..(365 * 200) {
            let expected = k % 7;
            assert_eq!(
                beijing_weekday(MON_15 + k * DAY_MS),
                expected,
                "第 {k} 天星期漂移了——说明换算里混进了日历假设"
            );
        }
        // 往前也一样（负方向 + 1970 之前的负时间戳）。
        for k in 1..(365 * 60) {
            let expected = (((-k) % 7) + 7) % 7;
            assert_eq!(beijing_weekday(MON_15 - k * DAY_MS), expected, "倒推第 {k} 天错了");
        }
        // 同一天内任何时刻星期不变（含跨 UTC 日界的边缘）。
        for h in 0..24 {
            assert_eq!(beijing_weekday(MON_15 - 15 * 3_600_000 + h * 3_600_000), 0);
        }
    }

    /// 非 object 与畸形样本跳过；空输入给空数组（不是 null）。
    #[test]
    fn request_metrics_skips_malformed_and_returns_array() {
        let events = [
            json!("not-an-object"),
            json!({"type":"assistant/chunk","seq":1,"data":{"chunk":{"type":"usage","usage":{"inputTokens":7}}}}), // 缺 turn/step
        ];
        assert_eq!(request_metrics(&events), json!([]));
        assert_eq!(request_metrics(&[]), json!([]));
    }

    // ──────────────────────── dsh_usage_observations ────────────────────────
    //
    // Commit 1 的共享 observer。字段分两组：槽身份/身份固化字段（identity_basis /
    // source_event_id / first_sample_seq / first_sample_identity_hash / compaction_id，
    // 开槽即固化、shadow 永不覆盖）与支配样本 value（shadow 可覆盖，含 §3.4
    // model_raw/provider_raw）。Python `usage.py` 侧 TestDshUsageObservations 有同款
    // 断言——source_event_id 的 canonical hash 用**同一个字面量**钉在两语言测试里，
    // 任一端的身份行构造漂移（seq 键该省没省、time/data 键该带没带）当场红。

    /// 开槽样本锚定 `first_sample_seq` 与 `source_event_id`——同 (turn, step) 的
    /// shadow（chunk 后到 message）只更新支配样本 value，身份（first_sample_seq +
    /// 已冻结的 source_event_id）不随支配样本走（spec §3.3「append shadow 不改写
    /// 身份输入」在 seq 元组与 fact_id 上的镜像）。observer 直接携带最终
    /// source_event_id（Commit 2 emitter 只消费、不复算）。
    #[test]
    fn observer_first_sample_seq_is_opening_sample_not_governing() {
        let events = [
            json!({"type":"assistant/chunk","seq":10,"time":1001,"data":{"turn":1,"step":1,
                   "chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300}}}}),
            json!({"type":"assistant/message","seq":11,"time":1002,"data":{"turn":1,"step":1,
                   "usage":{"inputTokens":1200,"outputTokens":250,"cacheReadTokens":300}}}),
        ];
        let obs = dsh_usage_observations(&events);
        assert_eq!(obs.len(), 1, "两份同槽样本 = 一个请求点");
        assert_eq!(obs[0].first_sample_seq, Some(10), "锚定开槽样本 seq，不是支配样本 11");
        assert_eq!(obs[0].seq, Some(11), "value 侧仍指向支配样本");
        assert_eq!(obs[0].uncached_input_tokens, Some(1200), "value 用后到者");
        assert_eq!(obs[0].output_tokens, Some(250));
        assert_eq!(obs[0].identity_basis, "derived-hash");
        assert_eq!(obs[0].source_event_id, "request:derived:2e4298cf1c7ad82a",
                   "普通槽身份 = fnv1a64(canonical{{turn,step,seq:开槽 seq 10}})，observer 直接携带");
        assert!(!obs[0].is_compaction);
        assert_eq!(obs[0].turn, Some(1));
        assert_eq!(obs[0].step, Some(1));
        assert_eq!(obs[0].model_raw, None, "无 header 则无 active 证据");
        assert_eq!(obs[0].first_sample_identity_hash, None, "仅无 id compaction 有 hash");
    }

    /// 相邻槽去重是相邻 run（fold 同款 last-key）：同 (turn, step) 非相邻重现
    /// （中间隔着别的槽）是**两个独立槽**，各锚自己的开槽样本（first_sample_seq 与
    /// source_event_id 各异）——若当同一槽，append 的 shadow 会跨越大段时间改写
    /// 首份样本的身份。
    #[test]
    fn observer_non_adjacent_same_turn_step_is_two_slots() {
        let events = [
            json!({"type":"assistant/chunk","seq":2,"time":1,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000}}}}),
            json!({"type":"assistant/chunk","seq":3,"time":2,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500}}}}),
            json!({"type":"assistant/chunk","seq":4,"time":3,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":800}}}}),
        ];
        let obs = dsh_usage_observations(&events);
        assert_eq!(obs.len(), 3);
        assert_eq!(obs[0].first_sample_seq, Some(2));
        assert_eq!(obs[1].first_sample_seq, Some(3));
        assert_eq!(obs[2].first_sample_seq, Some(4), "非相邻重现独立开槽");
        assert_eq!(obs[2].uncached_input_tokens, Some(800));
        assert_ne!(obs[0].source_event_id, obs[2].source_event_id,
                  "同 (1,1) 非相邻两槽各自 derived-hash 身份（first_sample_seq 不同）");
    }

    /// compaction 槽折进负号身份槽，turn/step 诚实置 None（内部去重哈希不泄漏成
    /// 真实 turn 号）；有原生 compactionId → native 身份 + 无 hash；自带
    /// model/provider（str 非空）优先 → model_raw/provider_raw 取 self、不取 active
    /// （§3.4 compaction 分支），source_event_id 是 `compaction:<id>`。
    #[test]
    fn observer_compaction_with_id_is_native_with_self_evidence() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1,
                   "data":{"header":{"config":{"model":"deepseek-v4-pro","provider":"shengsuanyun"}}}}),
            json!({"type":"compaction/summary","seq":2,"time":1_787_813_784_275i64,
                   "data":{"compactionId":"c1","sourceCommandId":"cmd-1",
                           "model":"deepseek-v4-flash","provider":"deepseek-official",
                           "usage":{"inputTokens":462,"outputTokens":3520,"cacheReadTokens":245760}}}),
        ];
        let obs = dsh_usage_observations(&events);
        assert_eq!(obs.len(), 1);
        assert!(obs[0].is_compaction);
        assert_eq!(obs[0].turn, None);
        assert_eq!(obs[0].step, None);
        assert_eq!(obs[0].compaction_id.as_deref(), Some("c1"));
        assert_eq!(obs[0].identity_basis, "native", "compactionId 是执行环境原生标识");
        assert_eq!(obs[0].source_event_id, "compaction:c1");
        assert_eq!(obs[0].first_sample_identity_hash, None, "有 id 无 hash");
        assert_eq!(obs[0].model_raw.as_deref(), Some("deepseek-v4-flash"),
                   "§3.4：自带 model（非空）优先于 active 的 deepseek-v4-pro");
        assert_eq!(obs[0].provider_raw.as_deref(), Some("deepseek-official"));
        assert_eq!(obs[0].first_sample_seq, Some(2));
    }

    /// §3.3 的冻结场景：**无 compactionId** 的 compaction 折进固定负号槽 (-1, 0)
    /// ——任何相邻第二份无 id compaction 都会落进**同一槽**替换支配样本。observer
    /// 在开槽样本算好并冻结 `first_sample_identity_hash`（canonical 行 hash，本测试
    /// 用**字面量**钉住——Python `usage.py` 侧断言同值，任一端的身份行构造漂移当场
    /// 红），shadow 只更新 value。prefix-only（只有开槽样本）与 full（+shadow）身份
    /// 逐字相同 = append 稳定。
    #[test]
    fn observer_no_id_compaction_fixed_slot_shadow_freezes_first_sample() {
        let opening = json!({"type":"compaction/summary","seq":5,"time":1001,
                             "data":{"sourceCommandId":"cmd-1","model":"m1","provider":"p1",
                                     "usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":5}}});
        let shadow = json!({"type":"compaction/summary","seq":6,"time":1002,
                            "data":{"sourceCommandId":"cmd-1","model":"m1","provider":"p1",
                                    "usage":{"inputTokens":200,"outputTokens":20,"cacheReadTokens":5}}});
        let obs = dsh_usage_observations(&[opening.clone(), shadow]);
        assert_eq!(obs.len(), 1, "两份同 (-1,0) 相邻样本 = 一个槽");
        assert_eq!(obs[0].first_sample_seq, Some(5), "身份锚在开槽样本 seq 5");
        assert_eq!(obs[0].first_sample_identity_hash.as_deref(), Some("c71a9fe6db364b69"),
                   "无 id compaction hash = 开槽样本重塑事件（{{type,time,data}}+seq5）canonical 行的 fnv1a64 hex");
        assert_eq!(obs[0].source_event_id, "compaction:derived:c71a9fe6db364b69");
        assert_eq!(obs[0].seq, Some(6), "value 侧指向支配样本 seq 6");
        assert_eq!(obs[0].uncached_input_tokens, Some(200), "value 用后到者");
        assert_eq!(obs[0].compaction_id, None);
        assert_eq!(obs[0].identity_basis, "derived-hash");
        assert_eq!(obs[0].turn, None);
        assert_eq!(obs[0].step, None);
        // prefix-only 与 full 身份逐字相同——append shadow 不改写旧 fact_id。
        let prefix = dsh_usage_observations(&[opening]);
        assert_eq!(prefix[0].source_event_id, obs[0].source_event_id);
        assert_eq!(prefix[0].first_sample_identity_hash, obs[0].first_sample_identity_hash);
        assert_eq!(prefix[0].first_sample_seq, obs[0].first_sample_seq);
    }

    /// 每份支配样本都按**那一刻**的 active 游标重判 model_raw/provider_raw，不缓存
    /// 成槽建立时的值——header 若在 chunk/message 之间切换，governing 落在新模型上
    /// （§3.4 + fold「后到重判」一致），而身份（source_event_id/first_sample_seq）
    /// 仍锚开槽样本、逐字不变。
    #[test]
    fn observer_governing_sample_rejudges_active_cursor() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1,
                   "data":{"header":{"config":{"model":"pro","provider":"p1"}}}}),
            json!({"type":"assistant/chunk","seq":2,"time":2,
                   "data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000}}}}),
            json!({"type":"request/header","seq":3,"time":3,
                   "data":{"header":{"config":{"model":"flash","provider":"p2"}}}}),
            json!({"type":"assistant/message","seq":4,"time":4,
                   "data":{"turn":1,"step":1,"usage":{"inputTokens":1200}}}),
        ];
        let obs = dsh_usage_observations(&events);
        assert_eq!(obs.len(), 1);
        assert_eq!(obs[0].first_sample_seq, Some(2), "身份仍锚开槽样本 seq 2");
        assert_eq!(obs[0].source_event_id, "request:derived:d000f644afcc1839");
        assert_eq!(obs[0].model_raw.as_deref(), Some("flash"), "governing 那一刻的 active 游标");
        assert_eq!(obs[0].provider_raw.as_deref(), Some("p2"));
        assert_eq!(obs[0].uncached_input_tokens, Some(1200));
        // 只有开槽样本的 prefix：value 落在当时 pro/p1，但身份逐字不变。
        let prefix = dsh_usage_observations(&events[..2]);
        assert_eq!(prefix[0].source_event_id, obs[0].source_event_id);
        assert_eq!(prefix[0].model_raw.as_deref(), Some("pro"));
        assert_eq!(obs[0].model_raw.as_deref(), Some("flash"),
                   "shadow 只更新 value，身份字段原样");
    }

    /// §3.3 seq=None 确定性降级：真实样本恒带整型 seq，这条纯属防御。first_sample_seq
    /// 为 None 时 canonical 身份 dict **整体省略 seq 键**（只 hash {turn, step}）——
    /// Python 序列化成 "None" / Rust 序列化成 "null" 都会字节分叉或 id 不稳定。普通
    /// 请求与无 id compaction 共用同一条「整数才追加 seq」分支，两分支都在此钉字面量。
    #[test]
    fn observer_seq_none_omits_seq_key() {
        // 普通请求：message 无顶层 seq → 身份 hash 只含 {turn:1, step:1}。
        let normal = [
            json!({"type":"assistant/message","time":1,"data":{"turn":1,"step":1,
                   "usage":{"inputTokens":1200}}}),
        ];
        let obs = dsh_usage_observations(&normal);
        assert_eq!(obs[0].first_sample_seq, None);
        assert_eq!(obs[0].source_event_id, "request:derived:5c5b05e3d3ff0a96",
                   "hash 对象是 {{step:1,turn:1}}（无 seq 键），不是含 null 的 seq");
        // 无 id compaction 同款：首样本无 seq → identity_row 不带 seq 键。
        let nocid = [
            json!({"type":"compaction/summary","time":1001,
                   "data":{"sourceCommandId":"cmd-1","model":"m1","provider":"p1",
                           "usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":5}}}),
        ];
        let obs2 = dsh_usage_observations(&nocid);
        assert_eq!(obs2[0].first_sample_seq, None);
        assert_eq!(obs2[0].first_sample_identity_hash.as_deref(), Some("f54d0f50212df43d"));
        assert_eq!(obs2[0].source_event_id, "compaction:derived:f54d0f50212df43d");
    }

    /// §3.4 model_raw/provider_raw 解析：compaction 自带 data.model 为空串（退化值，
    /// 不是 str 缺失）时回落当时 active 游标，不把 "" 当模型名——Python 真值渲染
    /// 与 Rust `Some(m) => m` 的**历史分歧**（Rust 过去把空串当模型名）在此收敛为
    /// 同一谓词。
    #[test]
    fn observer_empty_self_model_falls_back_to_active() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1,
                   "data":{"header":{"config":{"model":"pro","provider":"p1"}}}}),
            json!({"type":"compaction/summary","seq":2,"time":1001,
                   "data":{"sourceCommandId":"cmd-1","model":"","provider":"",
                           "usage":{"inputTokens":100}}}),
        ];
        let obs = dsh_usage_observations(&events);
        assert_eq!(obs.len(), 1);
        assert_eq!(obs[0].identity_basis, "derived-hash", "空 compactionId = derived");
        assert_eq!(obs[0].model_raw.as_deref(), Some("pro"), "空串回落 active，不把 '' 当模型名");
        assert_eq!(obs[0].provider_raw.as_deref(), Some("p1"));
    }

    // ──────────────────────── hour_buckets ────────────────────────
    //
    // 与 Python 侧 TestHourBuckets 同款锁步（两边各钉一份；任一侧动了都会红）。
    // 北京时间戳对照表（周二 = 工作日分支）：
    //   06:30 = 早空闲, 9-12/14-18 之外
    //   09:30 = 早高峰, 14:30 = 下午高峰
    //   23:50 → 00:10 = 跨午夜(落到不同日期)
    //   14:30 周六 = 工作日 14 点是高峰,周六全天空闲

    /// 空输入 → 空桶数组 + 元信息(不臆造零桶,与 token_by_model 同条纪律)。
    #[test]
    fn hour_buckets_empty_returns_empty_array() {
        let out = hour_buckets(&[]);
        assert_eq!(out["buckets"], json!([]));
        assert_eq!(out["schema_version"], json!(1));
        assert_eq!(out["tz_name"], json!("Asia/Shanghai (UTC+8 fixed, no DST)"));
        assert_eq!(out["tz_offset_hours"], json!(8));
        assert_eq!(out["unreported_fields"], json!([]));
    }

    /// 单笔高峰样本：4 基础 + 4 peak_* 都该有数,is_peak=true。
    /// 2026-08-25(周二) 14:30 北京 = peak 时段。
    #[test]
    fn hour_buckets_peak_sample_populates_both() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1787639400000i64,"data":{"header":{"config":{"model":"pro"}}}}),
            json!({"type":"assistant/chunk","seq":2,"time":1787639400000i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300,"cacheWriteTokens":50}}}}),
        ];
        let out = hour_buckets(&events);
        let buckets = out["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 1);
        let b = &buckets[0];
        assert_eq!(b["date"], json!("2026-08-25"));
        assert_eq!(b["hour"], json!(14));
        assert_eq!(b["is_peak"], json!(true));
        assert_eq!(b["uncached_input_tokens"], json!(1000));
        assert_eq!(b["output_tokens"], json!(200));
        assert_eq!(b["cache_read_tokens"], json!(300));
        assert_eq!(b["cache_write_tokens"], json!(50));
        assert_eq!(b["peak_uncached_input_tokens"], json!(1000));
        assert_eq!(b["peak_output_tokens"], json!(200));
        assert_eq!(b["peak_cache_read_tokens"], json!(300));
        assert_eq!(b["peak_cache_write_tokens"], json!(50));
    }

    /// 空闲样本：基础桶有数,peak_* 全 0,is_peak=false。
    #[test]
    fn hour_buckets_off_peak_keeps_peak_subbuckets_zero() {
        // 2026-08-25 06:30 北京 = 早空闲
        let events = [
            json!({"type":"request/header","seq":1,"time":1787610600000i64,"data":{"header":{"config":{"model":"pro"}}}}),
            json!({"type":"assistant/chunk","seq":2,"time":1787610600000i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500,"outputTokens":100}}}}),
        ];
        let out = hour_buckets(&events);
        let b = &out["buckets"][0];
        assert_eq!(b["hour"], json!(6));
        assert_eq!(b["is_peak"], json!(false));
        assert_eq!(b["peak_uncached_input_tokens"], json!(0));
        assert_eq!(b["peak_output_tokens"], json!(0));
    }

    /// **周六下午 14 点也是空闲**——漏这条规则按真实账单对照会精确 ×2
    /// (2026-08-23 周日 14:45 那次会话语义缺陷源)。
    #[test]
    fn hour_buckets_weekend_peak_hour_is_off_peak() {
        // 2026-08-29(周六) 14:30 北京
        let events = [
            json!({"type":"request/header","seq":1,"time":1787985000000i64,"data":{"header":{"config":{"model":"pro"}}}}),
            json!({"type":"assistant/chunk","seq":2,"time":1787985000000i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200}}}}),
        ];
        let out = hour_buckets(&events);
        let b = &out["buckets"][0];
        assert_eq!(b["date"], json!("2026-08-29"));
        assert_eq!(b["hour"], json!(14));
        assert_eq!(b["is_peak"], json!(false), "周六全天 = 空闲");
    }

    /// 跨午夜：23:50 → 00:10 各自归属日期。
    #[test]
    fn hour_buckets_cross_midnight_keeps_own_date() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1787673000000i64,"data":{"header":{"config":{"model":"pro"}}}}),
            // 周二 23:50 北京
            json!({"type":"assistant/chunk","seq":2,"time":1787673000000i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":10}}}}),
            // 周三 00:10 北京
            json!({"type":"assistant/chunk","seq":3,"time":1787674200000i64,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":200,"outputTokens":20}}}}),
        ];
        let out = hour_buckets(&events);
        let buckets = out["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0]["date"], json!("2026-08-25"));
        assert_eq!(buckets[0]["hour"], json!(23));
        assert_eq!(buckets[0]["uncached_input_tokens"], json!(100));
        assert_eq!(buckets[1]["date"], json!("2026-08-26"));
        assert_eq!(buckets[1]["hour"], json!(0));
        assert_eq!(buckets[1]["uncached_input_tokens"], json!(200));
    }

    /// 同 (turn, step) 后到者覆盖：跨小时替换也要把旧贡献从原 hour 扣掉。
    #[test]
    fn hour_buckets_same_step_dedup_replaces() {
        let ts_14 = 1787639400000i64;  // 周二 14:30
        let ts_15 = ts_14 + 3600 * 1000; // +1h → 周二 15:30(高峰)
        let events = [
            json!({"type":"request/header","seq":1,"time":ts_14,"data":{"header":{"config":{"model":"pro"}}}}),
            // 14 点 chunk → 14 点桶 +1000
            json!({"type":"assistant/chunk","seq":2,"time":ts_14,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":100}}}}),
            // 15 点 message 覆盖 → 15 点桶 +1200, 14 点桶 -1000
            json!({"type":"assistant/message","seq":3,"time":ts_15,"data":{"turn":1,"step":1,"usage":{"inputTokens":1200,"outputTokens":120}}}),
        ];
        let out = hour_buckets(&events);
        let buckets = out["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 2);
        let b14 = buckets.iter().find(|b| b["hour"] == json!(14)).unwrap();
        let b15 = buckets.iter().find(|b| b["hour"] == json!(15)).unwrap();
        assert_eq!(b14["uncached_input_tokens"], json!(0),
                   "chunk 的贡献被替换走");
        assert_eq!(b14["output_tokens"], json!(0));
        assert_eq!(b15["uncached_input_tokens"], json!(1200));
        assert_eq!(b15["output_tokens"], json!(120));
    }

    /// time 缺失 → (None, None) 桶,**不**混入任何 (date, hour) 桶。
    /// 避免下游 7 天合计把它算成 1970-01-01。
    #[test]
    fn hour_buckets_missing_time_is_unknown_bucket() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1001,"data":{"header":{"config":{"model":"pro"}}}}),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500,"outputTokens":50}}}}),
        ];
        let out = hour_buckets(&events);
        let buckets = out["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 1);
        let b = &buckets[0];
        assert_eq!(b["date"], json!(null));
        assert_eq!(b["hour"], json!(null));
        assert_eq!(b["is_peak"], json!(null));
        assert_eq!(b["uncached_input_tokens"], json!(500));
    }

    /// **同源不变量**：所有 bucket 的 4 基础桶之和 == token_by_model 的 4 桶之和。
    /// 证明 hour_buckets 与 token_by_model 共用同 step 去重 / 折叠逻辑。
    #[test]
    fn hour_buckets_reconciles_with_token_by_model() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1787639400000i64,"data":{"header":{"config":{"model":"pro"}}}}),
            // 同 (1,1) → 只算后到
            json!({"type":"assistant/chunk","seq":2,"time":1787639400000i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300,"cacheWriteTokens":0}}}}),
            json!({"type":"assistant/message","seq":3,"time":1787639400001i64,"data":{"turn":1,"step":1,"usage":{"inputTokens":1200,"outputTokens":250,"cacheReadTokens":300,"cacheWriteTokens":0}}}),
            // 切到空闲时段
            json!({"type":"assistant/chunk","seq":4,"time":1787610600000i64,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500,"outputTokens":50}}}}),
        ];
        let hb = hour_buckets(&events);
        let tm = token_by_model(&events);
        for (i, key) in ["uncached_input_tokens","output_tokens","cache_read_tokens","cache_write_tokens"].iter().enumerate() {
            let hour_total: i64 = hb["buckets"].as_array().unwrap().iter()
                .map(|b| b[key].as_i64().unwrap_or(0)).sum();
            let model_total: i64 = tm["by_model"].as_object().unwrap().values()
                .map(|m| m[key].as_i64().unwrap_or(0)).sum();
            assert_eq!(hour_total, model_total,
                "{key}: hour_buckets 之和 ({hour_total}) 必须等于 token_by_model 按模型聚合 ({model_total})");
            // 4 桶位与 4 SAMPLE_FIELDS 一致(0/1/2/3)
            let _ = i;
        }
    }

    /// 事件流：跨零点 + 中途换模型 + 同 (turn,step) 跨日替换。
    /// 三个出口的对账测试共用它，保证断言的是同一份"难"输入。
    fn reconcile_fixture() -> Vec<Value> {
        vec![
            json!({"type":"request/header","seq":1,"time":1787673000000i64,"data":{"header":{"config":{"model":"pro"}}}}),
            // 8/25 23:50
            json!({"type":"assistant/chunk","seq":2,"time":1787673000000i64,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":1000,"outputTokens":100,"cacheReadTokens":50,"cacheWriteTokens":0}}}}),
            // 同 (1,1) 但落到 8/26 00:10 —— 必须把 8/25 的贡献扣掉再记到 8/26
            json!({"type":"assistant/message","seq":3,"time":1787674200000i64,"data":{"turn":1,"step":1,"usage":{"inputTokens":1200,"outputTokens":120,"cacheReadTokens":60,"cacheWriteTokens":0}}}),
            // 换模型，仍在 8/26
            json!({"type":"request/header","seq":4,"time":1787674200000i64,"data":{"header":{"config":{"model":"flash"}}}}),
            json!({"type":"assistant/chunk","seq":5,"time":1787674200000i64,"data":{"turn":2,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500,"outputTokens":50}}}}),
        ]
    }

    /// **日历（按天）与 DSH 审计（按 session）必须算出同一个总量。**
    ///
    /// 这两者是同一份用量的两个投影，不是两个各自算钱的地方：DSH 插件按
    /// session 折（`token_by_model`），日历按时间折（`token_by_date_model`）。
    /// 过去没有任何东西强制它们相等——真实事故里日历报 ¥2386 而按 session
    /// 重算是 ¥1733，靠人工对账才发现。这条测试就是那条缺失的不变量。
    ///
    /// 全部样本都带 time 时两者必须**精确相等**（无时间戳样本按设计只会
    /// 出现在 `token_by_model` 一侧，见 `token_by_date_model` 的文档注释）。
    #[test]
    fn token_by_date_model_reconciles_with_token_by_model() {
        let events = reconcile_fixture();
        let by_date = token_by_date_model(&events, SOURCE_UNSPECIFIED);
        let by_model = token_by_model(&events);

        // by_source 是顶层并列键，不是日期——对账时显式跳过，不许把它的
        // 对象值当日期桶累加（那样会静默得 0，把「对不上」藏起来）。
        let date_keys = by_date
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| k.as_str() != "by_source")
            .cloned()
            .collect::<Vec<_>>();

        for key in [
            "uncached_input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ] {
            let date_total: i64 = date_keys
                .iter()
                .flat_map(|k| {
                    by_date[k]
                        .as_object()
                        .unwrap()
                        .values()
                        .map(|b| b[key].as_i64().unwrap_or(0))
                })
                .sum();
            let model_total: i64 = by_model["by_model"]
                .as_object()
                .unwrap()
                .values()
                .map(|m| m[key].as_i64().unwrap_or(0))
                .sum();
            assert_eq!(
                date_total, model_total,
                "{key}: 按天折 ({date_total}) 必须等于按 session 折 ({model_total})\
                 ——日历与 DSH 审计是同一份用量的两个投影"
            );
            // by_source 各 source 之和必须等于主输出——按来源拆的账和按日期
            // 拆的账是同一份用量（per-source 拆账的基础不变量）。
            let source_total: i64 = by_date["by_source"]
                .as_object()
                .unwrap()
                .values()
                .flat_map(|srcs| {
                    srcs.as_object().unwrap().values().flat_map(|sm| {
                        sm.as_object().unwrap().values().map(|b| b[key].as_i64().unwrap_or(0))
                    })
                })
                .sum();
            assert_eq!(
                source_total, date_total,
                "{key}: by_source 各 source 之和 ({source_total}) 必须等于主输出 ({date_total})\
                 ——按来源拆账不能变成另一份用量"
            );
        }
    }

    /// 三个出口两两对账：`hour_buckets`（只有日期维）与
    /// `token_by_date_model`（日期×模型）在总量上也必须一致——否则日历的
    /// 热力图格子和它自己的成本数字会对不上。
    #[test]
    fn token_by_date_model_reconciles_with_hour_buckets_per_date() {
        let events = reconcile_fixture();
        let by_date = token_by_date_model(&events, SOURCE_UNSPECIFIED);
        let hb = hour_buckets(&events);

        for key in [
            "uncached_input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
        ] {
            // 逐日对账，不只是总量——总量相等但分配到错误日期是这次真实
            // 事故的形态（by_model 被整段记到"今天"），只查总和会漏掉。
            // by_source 是顶层并列键，不是日期，显式跳过。
            for (date_str, day) in by_date
                .as_object()
                .unwrap()
                .iter()
                .filter(|(d, _)| d.as_str() != "by_source")
            {
                let date_total: i64 = day
                    .as_object()
                    .unwrap()
                    .values()
                    .map(|b| b[key].as_i64().unwrap_or(0))
                    .sum();
                let hour_total: i64 = hb["buckets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|b| b["date"].as_str() == Some(date_str.as_str()))
                    .map(|b| b[key].as_i64().unwrap_or(0))
                    .sum();
                assert_eq!(
                    date_total, hour_total,
                    "{date_str} {key}: 按 (日期,模型) 折 ({date_total}) 必须等于 \
                     hour_buckets 该日之和 ({hour_total})"
                );
            }
        }
    }

    /// 跨零点的同 (turn, step) 替换必须把旧日期的贡献扣干净——否则一笔请求
    /// 会同时算进两天，正是"总量对但分配错"的那类 bug。
    #[test]
    fn token_by_date_model_cross_midnight_replacement_debits_the_old_date() {
        let events = reconcile_fixture();
        let out = token_by_date_model(&events, SOURCE_UNSPECIFIED);
        // seq 2 的 1000 已被 seq 3 替换走 → 8/25 归零
        assert_eq!(
            out["2026-08-25"]["pro"]["uncached_input_tokens"]
                .as_i64()
                .unwrap(),
            0,
            "被替换掉的旧日期贡献必须扣光"
        );
        assert_eq!(
            out["2026-08-26"]["pro"]["uncached_input_tokens"]
                .as_i64()
                .unwrap(),
            1200
        );
        assert_eq!(
            out["2026-08-26"]["flash"]["uncached_input_tokens"]
                .as_i64()
                .unwrap(),
            500
        );
    }

    /// Python `json.dumps(token_by_date_model(events), ensure_ascii=False,
    /// separators=(",", ":"))` 的逐字节对照——键序（日期升序、模型按首现
    /// 顺序）、值全部一致。期望串在 Python 侧生成后硬编码于此，任何一侧
    /// 改了折叠语义或输出顺序这里立刻红。
    ///
    /// **这条测试是这次架构修正的落点**：日历（按天）和 DSH 审计（按
    /// session）是同一个能力的两个投影，此前按天那一维只有 Python 一份
    /// 实现、掉在双实现差分之外；状态栏要接 Rust-Tauri，这一维必须和其他
    /// 折叠一样受差分保护。
    #[test]
    fn token_by_date_model_python_rust_byte_for_byte_parity() {
        let events = reconcile_fixture();
        let out = token_by_date_model(&events, SOURCE_UNSPECIFIED);
        assert_eq!(
            serde_json::to_string(&out).unwrap(),
            r#"{"2026-08-25":{"pro":{"uncached_input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},"2026-08-26":{"pro":{"uncached_input_tokens":1200,"output_tokens":120,"cache_read_tokens":60,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"flash":{"uncached_input_tokens":500,"output_tokens":50,"cache_read_tokens":0,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},"by_source":{"2026-08-25":{"unspecified":{"pro":{"uncached_input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}}},"2026-08-26":{"unspecified":{"pro":{"uncached_input_tokens":1200,"output_tokens":120,"cache_read_tokens":60,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"flash":{"uncached_input_tokens":500,"output_tokens":50,"cache_read_tokens":0,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}}}}}"#
        );
    }

    /// 无时间戳的样本不产生日期桶（与 `hour_buckets` 的 (None,None) 桶
    /// 被日历滤掉是同一条纪律）——**这是上面那条精确相等的唯一例外来源**，
    /// 显式钉住，免得以后有人"顺手"把它归到某一天。
    #[test]
    fn token_by_date_model_drops_untimed_samples() {
        let events = [
            json!({"type":"request/header","seq":1,"time":1001,"data":{"header":{"config":{"model":"pro"}}}}),
            json!({"type":"assistant/chunk","seq":2,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":500,"outputTokens":50}}}}),
        ];
        let out = token_by_date_model(&events, SOURCE_UNSPECIFIED);
        assert!(
            out.as_object().unwrap().is_empty(),
            "无时间戳样本不能被塞进任何一天"
        );
        // 但 token_by_model 仍然记着它 —— 两者的差额只能来自这里
        let tm = token_by_model(&events);
        assert_eq!(
            tm["by_model"]["pro"]["uncached_input_tokens"].as_i64().unwrap(),
            500
        );
    }

    /// **per-source 拆账的演示断言**：同一批会话被喂两次（两个来源），by_source
    /// 必须区分两次来源/计数，而不仅仅是总量翻倍。2026-08「日历 ¥2386 vs 按
    /// session 重算 ¥1733」的根因就是同一批会话被喂了多次——by_source 里能看到
    /// 两个来源行、每行各一份计数，一眼就能定位「这个量被记了两次」，而不是只见
    /// 一个翻倍的总数。
    ///
    /// 每次 `token_by_date_model` 调用只喂一个来源；「喂两次」在调用侧表现为
    /// 两次调用各带一个标签，再由 `merge_month` 按日期折进同一份月账。这里在
    /// 折叠层直接把两次折叠的结果合并，断言每个来源的贡献都被独立记下。
    #[test]
    fn by_source_distinguishes_same_batch_fed_twice() {
        let events = reconcile_fixture();
        let first = token_by_date_model(&events, SOURCE_DSH_LIVE);
        let second = token_by_date_model(&events, SOURCE_CLI);

        // 每个来源各有一行、各自一份完整计数（不是加起来翻倍成一个数）。
        assert_eq!(
            first["by_source"]["2026-08-26"]["dsh-live"]["pro"]["uncached_input_tokens"]
                .as_i64()
                .unwrap(),
            1200
        );
        assert_eq!(
            second["by_source"]["2026-08-26"]["cli"]["pro"]["uncached_input_tokens"]
                .as_i64()
                .unwrap(),
            1200,
            "同一批喂两次：两个来源行各带一份完整计数，by_source 不能把两次合并成一个翻倍值"
        );
        // 两行来源标签不同 —— 诊断「重复喂」就靠这个键。
        assert!(first["by_source"]["2026-08-26"].as_object().unwrap().contains_key("dsh-live"));
        assert!(second["by_source"]["2026-08-26"].as_object().unwrap().contains_key("cli"));
    }

    /// 调用方没给来源标签时的**诚实降级**：fold 收 `"unspecified"` 标签——是
    /// 明确标注「未知来源」，不是编造一个看起来真实的来源名。绝不能把缺标签的
    /// 样本凭空安到 `cli`/`dsh-live` 头上，否则「重复喂」诊断就会被一个假的
    /// 来源键污染。
    #[test]
    fn by_source_labels_missing_source_as_unspecified_not_fabricated() {
        let events = reconcile_fixture();
        let out = token_by_date_model(&events, SOURCE_UNSPECIFIED);
        let sources = out["by_source"]["2026-08-26"].as_object().unwrap();
        assert!(sources.contains_key("unspecified"));
        assert!(!sources.contains_key("cli"));
        assert!(!sources.contains_key("dsh-live"));
    }

    // ---- canonical 归一层（吸收项 #1）----

    /// canonical 从 DSH 形状归一：FRESH = 全价 input、TOTAL = 4 桶之和；
    /// `cacheWriteTokens` 整批没上报（reconcile_fixture 的 chunk/message 都没带它，
    /// 真实语料同样如此）→ cache_write 维必须 null + unavailable，不能折成 0
    /// 冒充「测到 0」。DSH schema 没有 reasoning 维 → 恒 unavailable。
    /// 注意本 fixture 里 `cacheWriteTokens` 是**显式报了 0** 的（`buckets_from`
    /// 对 `Some(0)` 照样置 seen）——所以 cache_write = 0 是「测到的 0」不是
    /// 「没测到」；真实语料里它从不出现在 payload，才会落 null。legacy 槽只
    /// 给 codex-total 形状，DSH 形状恒 null → 也进 unavailable。
    #[test]
    fn canonical_dsh_measures_fresh_and_total() {
        let events = reconcile_fixture();
        let out = canonical_tokens(&events, SOURCE_CLI);
        assert_eq!(out["source"], json!("cli"));
        assert_eq!(out["shape"], json!("dsh"));
        // input = 1200 + 500 = 1700；output = 120 + 50 = 170；cacheRead = 60；
        // cacheWrite 显式报了 0 → 测到 0（不加 0 是 clippy identity_op 的纪律，
        // 测到 0 的事实由下一行的 json!(0) 断言钉住）。
        assert_eq!(out["fresh_input_tokens"], json!(1700));
        assert_eq!(out["total_tokens"], json!(1700 + 170 + 60));
        assert_eq!(out["cache_read_tokens"], json!(60));
        assert_eq!(out["cache_write_tokens"], json!(0));
        assert_eq!(out["reasoning_tokens"], Value::Null);
        assert_eq!(out["legacy_total_tokens"], Value::Null);
        assert_eq!(
            out["unavailable"],
            json!(["reasoning_tokens", "legacy_total_tokens"])
        );
    }

    /// 整批没有 usage 样本 → 全部维 null + 全量 unavailable。naive 会在这里
    /// 输出一个全零行，把「没证据」伪装成「花了 0 token」。
    #[test]
    fn canonical_dsh_zero_samples_is_all_unavailable() {
        let out = canonical_tokens(&[], SOURCE_DSH_LIVE);
        assert_eq!(out["shape"], json!("dsh"));
        for dim in CANONICAL_DIMS.iter() {
            assert_eq!(out[dim], Value::Null, "{dim} 无样本必须 null");
        }
        assert_eq!(out["unavailable"], json!(CANONICAL_DIMS));
    }

    /// 未知来源标签 → shape=unknown、全维 unavailable——不摆全零结构冒充
    /// 「测到了什么」（与 `by_source` 的 unspecified 诚实降级同一条纪律）。
    #[test]
    fn canonical_unknown_source_is_all_unavailable() {
        let events = reconcile_fixture();
        let out = canonical_tokens(&events, "some-future-source");
        assert_eq!(out["source"], json!("some-future-source"));
        assert_eq!(out["shape"], json!("unknown"));
        assert_eq!(out["fresh_input_tokens"], Value::Null);
        assert_eq!(out["total_tokens"], Value::Null);
        assert_eq!(out["unavailable"], json!(CANONICAL_DIMS));
    }

    /// canonical 从 Codex 形状归一：FRESH = uncached（全价 input）、TOTAL =
    /// input + output = uncached + output + cached + cache_write（reasoning 在
    /// output 里不另加）、cache_read 映射到 cached_input、reasoning 单独成维。
    #[test]
    fn canonical_codex_measures_fresh_and_total() {
        let events = [
            json!({"type":"turn_context","payload":{"model":"codex-1"}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{
                "last_token_usage":{"input_tokens":100,"output_tokens":30,
                                    "cached_input_tokens":40,"cache_write_input_tokens":10,
                                    "reasoning_output_tokens":5}}}}),
        ];
        let out = canonical_tokens(&events, SOURCE_CODEX);
        assert_eq!(out["source"], json!("codex"));
        assert_eq!(out["shape"], json!("codex"));
        // uncached = 100 - 40 - 10 = 50。
        assert_eq!(out["fresh_input_tokens"], json!(50));
        assert_eq!(out["total_tokens"], json!(50 + 30 + 40 + 10));
        assert_eq!(out["cache_read_tokens"], json!(40));
        assert_eq!(out["cache_write_tokens"], json!(10));
        assert_eq!(out["reasoning_tokens"], json!(5));
        // 5 桶同一份 last_token_usage 全测到；legacy 槽只给 codex-total 形状，
        // codex 形状恒 null → 唯一 unavailable 项。
        assert_eq!(out["unavailable"], json!(["legacy_total_tokens"]));
    }

    /// 第一条累计快照：没有基线算不出 delta → fresh/total null + unavailable，
    /// 但 raw 累计值放 `legacy_total_tokens`（「只有老格式才带的字段」进 legacy
    /// 槽，诚实披露，绝不把总量拆成编造的四桶）。
    #[test]
    fn canonical_total_delta_first_snapshot_legacy_only() {
        let cur = json!({"input_tokens":100,"output_tokens":30,
                         "cached_input_tokens":40,"cache_write_input_tokens":10,
                         "reasoning_output_tokens":5,"total_tokens":130});
        let out = canonical_total_delta(None, &cur, SOURCE_CODEX);
        assert_eq!(out["shape"], json!("codex-total"));
        assert_eq!(out["fresh_input_tokens"], Value::Null);
        assert_eq!(out["total_tokens"], Value::Null);
        assert_eq!(out["legacy_total_tokens"], json!(130));
        assert_eq!(
            out["unavailable"],
            json!(["fresh_input_tokens","total_tokens","cache_read_tokens",
                   "cache_write_tokens","reasoning_tokens"])
        );
    }

    /// 同一计量复读（prev 与 cur 签名相同）→ delta 全 0。这是**测到** 0（累计
    /// 没变就是没新开销），不是没测到——与 `codex_fold_file` 的 continuous-dedup
    /// 是同一语义，只是这里把 0 显式还给了调用方。
    #[test]
    fn canonical_total_delta_repeated_snapshot_is_measured_zero() {
        let cur = json!({"input_tokens":100,"output_tokens":30,
                         "cached_input_tokens":40,"cache_write_input_tokens":10,
                         "reasoning_output_tokens":5,"total_tokens":130});
        let out = canonical_total_delta(Some(&cur), &cur, SOURCE_CODEX);
        assert_eq!(out["shape"], json!("codex-total"));
        assert_eq!(out["fresh_input_tokens"], json!(0));
        assert_eq!(out["total_tokens"], json!(0));
        assert_eq!(out["reasoning_tokens"], json!(0));
        assert_eq!(out["unavailable"], json!([]));
        assert_eq!(out["legacy_total_tokens"], json!(130));
    }

    /// prev→cur 差分：uncached 从 delta 派生（d_input − d_cached − d_cw），
    /// TOTAL = d_input + d_output。守卫 fresh <= total。
    #[test]
    fn canonical_total_delta_measures_the_delta() {
        let prev = json!({"input_tokens":100,"output_tokens":30,
                          "cached_input_tokens":40,"cache_write_input_tokens":10,
                          "reasoning_output_tokens":5,"total_tokens":130});
        let cur = json!({"input_tokens":160,"output_tokens":50,
                         "cached_input_tokens":60,"cache_write_input_tokens":20,
                         "reasoning_output_tokens":8,"total_tokens":210});
        let out = canonical_total_delta(Some(&prev), &cur, SOURCE_CODEX);
        // d_input=60, d_output=20, d_cached=20, d_cw=10, d_reasoning=3
        // d_uncached = 60 - 20 - 10 = 30。
        assert_eq!(out["fresh_input_tokens"], json!(30));
        assert_eq!(out["total_tokens"], json!(30 + 20 + 20 + 10));
        assert_eq!(out["cache_read_tokens"], json!(20));
        assert_eq!(out["cache_write_tokens"], json!(10));
        assert_eq!(out["reasoning_tokens"], json!(3));
        assert_eq!(out["unavailable"], json!([]));
    }

    /// 累计回退（cur 的 input 比 prev 小——跨会话/畸形数据）→ 不产负数，
    /// fresh/total null + unavailable，raw 累计照放。clamp 到 0 同样是编造：
    /// 负 delta 是异常信号，不是可以安全地归零的量。
    #[test]
    fn canonical_total_delta_cumulative_regression_is_unavailable_not_negative() {
        let prev = json!({"input_tokens":100,"output_tokens":30,
                          "cached_input_tokens":40,"cache_write_input_tokens":10,
                          "reasoning_output_tokens":5,"total_tokens":130});
        let cur = json!({"input_tokens":80,"output_tokens":40,
                         "cached_input_tokens":30,"cache_write_input_tokens":5,
                         "reasoning_output_tokens":2,"total_tokens":120});
        let out = canonical_total_delta(Some(&prev), &cur, SOURCE_CODEX);
        assert_eq!(out["fresh_input_tokens"], Value::Null);
        assert_eq!(out["total_tokens"], Value::Null);
        assert_eq!(out["legacy_total_tokens"], json!(120));
        assert!(out["unavailable"].as_array().unwrap().contains(&json!("total_tokens")));
    }

    /// 守卫跨形状成立：FRESH 是 TOTAL 的真子集、任何维 >= 0。dsh 与 codex 两套
    /// 形状各验一遍（累计差分的守卫在 `canonical_total_delta_measures_the_delta`
    /// 已由 `debug_assert` + 值断言钉住）。
    #[test]
    fn canonical_fresh_never_exceeds_total() {
        let dsh = canonical_tokens(&reconcile_fixture(), SOURCE_CLI);
        let f = dsh["fresh_input_tokens"].as_i64().unwrap();
        let t = dsh["total_tokens"].as_i64().unwrap();
        assert!(0 <= f && f <= t, "dsh: 0 <= fresh({f}) <= total({t})");

        let codex_events = [
            json!({"type":"turn_context","payload":{"model":"codex-1"}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{
                "last_token_usage":{"input_tokens":100,"output_tokens":30,
                                    "cached_input_tokens":40,"cache_write_input_tokens":10,
                                    "reasoning_output_tokens":5}}}}),
        ];
        let codex = canonical_tokens(&codex_events, SOURCE_CODEX);
        let f = codex["fresh_input_tokens"].as_i64().unwrap();
        let t = codex["total_tokens"].as_i64().unwrap();
        assert!(0 <= f && f <= t, "codex: 0 <= fresh({f}) <= total({t})");
    }

    /// Python `json.dumps(canonical_tokens(events, source), ensure_ascii=False,
    /// separators=(",", ":"))` 的逐字节对照——键序（source/shape → 六维 →
    /// unavailable）、null 与 unavailable 顺序全部一致。期望串在 Python 侧生成后
    /// 硬编码于此，任何一侧改了归一语义或输出顺序这里立刻红。Python 侧
    /// `tests/test_canonical_cost.py` 断言同一个串，双向锁死。
    #[test]
    fn canonical_tokens_python_rust_byte_for_byte_parity() {
        let events = reconcile_fixture();
        let out = canonical_tokens(&events, SOURCE_CLI);
        assert_eq!(
            serde_json::to_string(&out).unwrap(),
            r#"{"source":"cli","shape":"dsh","fresh_input_tokens":1700,"total_tokens":1930,"cache_read_tokens":60,"cache_write_tokens":0,"reasoning_tokens":null,"legacy_total_tokens":null,"unavailable":["reasoning_tokens","legacy_total_tokens"]}"#
        );
    }
}
