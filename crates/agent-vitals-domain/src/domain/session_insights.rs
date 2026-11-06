//! 会话消耗诊断（docs/SESSION_TRACE_DIAGNOSTICS_SPEC.md r6 §4、§6、§7）——
//! `session_trace(output = "insights")` 的纯计算面。
//!
//! 输入是权威库三张标准化表的行投影（助手调用 / workflow 事件 / 安全类
//! findings），输出是一个回合轴 + 三类诊断。**不认识任何执行环境**：执行环境差异
//! 只体现在输入里有没有回合事件、有没有工具结果；缺什么由调用方按执行环境注册表
//! 的能力声明标 `lanes`，本模块不编造。
//!
//! 三条纪律（spec §3、§7）：
//! - **事实与原因分开**：诊断的 `fact` 只放测到的数；`cause` 标原因确定度
//!   （`evidence` / `possible` / `unknown`）。r5 的单一 `evidence_strength`
//!   把「输入增长 3.9 倍」这种事实也标成「较可能」，用户分不清哪部分不确定。
//! - **影响不等于浪费**：`impact` 只有 tokens 与占比；本模块不产任何金额，
//!   名义成本由查询层按价卡另算、只挂在回合与会话上。
//! - **命中率低不等于问题**：本机实测低命中调用里约 28% 有预期内解释
//!   （长空闲后缓存过期、换模型），这些只作说明（`context_notes` / 回合
//!   `notes`），不进诊断清单。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

/// 一次助手调用（`usage_facts` 一行）。
#[derive(Clone, Debug, PartialEq)]
pub struct InsightCall {
    pub ts_ms: i64,
    pub model_id: Option<String>,
    pub cache_read: i64,
    pub cache_write: i64,
    pub uncached_input: i64,
    pub output: i64,
}

impl InsightCall {
    /// 单次输入规模（spec §4）：三个输入桶之和。
    pub fn input(&self) -> i64 {
        self.cache_read + self.cache_write + self.uncached_input
    }
    fn hit_rate(&self) -> Option<f64> {
        let input = self.input();
        (input > 0).then(|| self.cache_read as f64 / input as f64)
    }
}

/// 一条 workflow 事件（`workflow_events` 一行），只保留诊断需要的列。
#[derive(Clone, Debug, PartialEq)]
pub enum InsightEvent {
    TaskStarted { ts_ms: i64 },
    /// outcome ∈ succeeded / failed / cancelled / unknown。
    TaskFinished { ts_ms: i64, outcome: String },
    ToolFinished {
        ts_ms: i64,
        capability_id: Option<String>,
        outcome: String,
        invocation_fingerprint: Option<String>,
        /// 本机库里是否存有该失败的错误摘录（摘录本身不进本模块）。
        has_error_excerpt: bool,
    },
    ModelSwitched { ts_ms: i64 },
}

impl InsightEvent {
    fn ts_ms(&self) -> i64 {
        match self {
            InsightEvent::TaskStarted { ts_ms }
            | InsightEvent::TaskFinished { ts_ms, .. }
            | InsightEvent::ToolFinished { ts_ms, .. }
            | InsightEvent::ModelSwitched { ts_ms } => *ts_ms,
        }
    }
}

/// 一条安全类 finding（SV601–SV605）。`ts_ms` 缺失时不落到任何回合。
#[derive(Clone, Debug, PartialEq)]
pub struct InsightSafety {
    pub ts_ms: Option<i64>,
    pub rule: String,
    pub severity: String,
}

/// 阈值集中定义（spec §7：首发阈值以 §11.1 标注样本校准后定稿）。
#[derive(Clone, Debug, PartialEq)]
pub struct InsightsConfig {
    /// 会话最初几次调用不判未命中（冷启动必然未命中）。
    pub skip_first_calls: usize,
    /// 单次输入规模下限：更小的调用未命中也无足轻重。
    pub min_call_input: i64,
    /// 「低命中」判据：命中率低于此值。
    pub low_hit_rate: f64,
    /// 缓存有效期（默认 5 分钟；按 provider 可配是 §12 待决项）。
    pub cache_ttl_ms: i64,
    /// `hit_rate_drop` 的基线：此前连续 N 次调用……
    pub drop_baseline_calls: usize,
    /// ……命中率都不低于此值。
    pub drop_baseline_hit_rate: f64,
    /// 高未命中区间进清单的下限：未命中输入占会话输入不少于此比例。
    /// （初版是「≥3 次调用 **或** ≥1%」，真机里 codex 一个回合内 3 次小调用就能
    /// 凑出占比 0.09% 的条目——对消耗毫无意义的提示。）
    pub min_uncached_share: f64,
    /// 输入增长：连续回合数下限。
    pub growth_min_steps: usize,
    /// 输入增长：累计增幅下限（倍）。
    pub growth_min_ratio: f64,
    /// 输入增长的「单调」容差：回合峰值不低于区间内已见最大值的这一比例即算延续
    /// （真机峰值有小幅抖动，严格递增会把明显的增长切碎）。
    pub growth_tolerance: f64,
    /// 输入增长：终点峰值的绝对下限（tokens）。真机 20 个样本里 8 个会话有「≥10 回合
    /// ≥3 倍」的增长——上下文随对话累积本就是常态，只有单次输入已经很大时增长才
    /// 值得看。初值，待 §11.1 标注校准。
    pub growth_min_peak: i64,
    /// 同一调用（同调用指纹）失败次数下限。
    pub repeat_same_invocation: usize,
    /// 同一调用的两次失败相隔超过这么多回合，就不算「反复失败」的同一串
    /// （真机有同一命令在第 96 与第 403 回合各失败一次，被合成一条跨 300 回合的诊断）。
    pub repeat_invocation_gap_steps: usize,
    /// 同一工具在 `repeat_tool_window_steps` 个回合内失败次数下限。
    pub repeat_same_tool: usize,
    pub repeat_tool_window_steps: usize,
}

impl Default for InsightsConfig {
    fn default() -> Self {
        InsightsConfig {
            skip_first_calls: 2,
            min_call_input: 10_000,
            low_hit_rate: 0.5,
            cache_ttl_ms: 5 * 60 * 1000,
            drop_baseline_calls: 5,
            drop_baseline_hit_rate: 0.9,
            min_uncached_share: 0.01,
            growth_min_steps: 10,
            growth_min_ratio: 3.0,
            growth_tolerance: 0.9,
            growth_min_peak: 100_000,
            repeat_same_invocation: 2,
            repeat_invocation_gap_steps: 5,
            repeat_same_tool: 3,
            repeat_tool_window_steps: 3,
        }
    }
}

/// 横轴单位：有回合事件时按回合，否则每次助手调用一步（spec §4）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxisUnit {
    Turn,
    AssistantCall,
}

impl AxisUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            AxisUnit::Turn => "turn",
            AxisUnit::AssistantCall => "assistant_call",
        }
    }
}

#[derive(Clone, Debug, Default)]
struct ToolCounts {
    succeeded: i64,
    failed: i64,
    cancelled: i64,
    unknown: i64,
}

#[derive(Clone, Debug)]
struct Step {
    index: usize,
    started_at_ms: i64,
    last_activity_ms: i64,
    /// 这一步里有没有任何测量（调用或事件）；没有就不给 `ended_at_ms`（§6.2 缺键）。
    active: bool,
    outcome: Option<String>,
    idle_before_ms: Option<i64>,
    cache_read: i64,
    cache_write: i64,
    uncached_input: i64,
    output: i64,
    input_peak: i64,
    calls: usize,
    model_ids: Vec<String>,
    tools: ToolCounts,
    notes: BTreeMap<&'static str, usize>,
}

impl Step {
    fn new(index: usize, started_at_ms: i64) -> Step {
        Step {
            index,
            started_at_ms,
            last_activity_ms: started_at_ms,
            active: false,
            outcome: None,
            idle_before_ms: None,
            cache_read: 0,
            cache_write: 0,
            uncached_input: 0,
            output: 0,
            input_peak: 0,
            calls: 0,
            model_ids: Vec::new(),
            tools: ToolCounts::default(),
            notes: BTreeMap::new(),
        }
    }
    fn input(&self) -> i64 {
        self.cache_read + self.cache_write + self.uncached_input
    }
}

/// 单次调用对「高未命中输入」的归类（spec §7.1 表）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum UncachedExplanation {
    PossibleCacheExpiry,
    AfterModelChange,
    HitRateDrop,
    Unexplained,
}

impl UncachedExplanation {
    pub fn as_str(self) -> &'static str {
        match self {
            UncachedExplanation::PossibleCacheExpiry => "possible_cache_expiry",
            UncachedExplanation::AfterModelChange => "after_model_change",
            UncachedExplanation::HitRateDrop => "hit_rate_drop",
            UncachedExplanation::Unexplained => "unexplained",
        }
    }
    /// 预期内解释只作说明，不进诊断清单。
    fn is_expected(self) -> bool {
        matches!(self, UncachedExplanation::PossibleCacheExpiry | UncachedExplanation::AfterModelChange)
    }
}

/// 原因确定度排序：evidence > possible > unknown。
fn cause_rank(cause: &str) -> u8 {
    match cause {
        "evidence" => 0,
        "possible" => 1,
        _ => 2,
    }
}

/// 横轴方案——`build_insights`、`call_steps` 与查询层的本地证据共用一份，落点
/// 规则只写一次（验收发现三处各算各的迟早漂移）。
///
/// - 回合 = [本次 task_started, 下一次 task_started)。
/// - 只有 0–1 个回合起点 → 按调用铺开：一根柱子什么也定位不了（真机常见于执行环境
///   已轮换掉源日志、G6 之前只记了首回合的旧 Claude 会话）。
/// - 首个回合起点之前的调用：过半 → 按调用铺开（真机 6 个 codex 会话有 2,815 次
///   调用落在首个 task_started 之前，按回合画会让 88% 的会话从轴上消失）；否则补一个
///   「首回合之前」的前导步，**不丢任何调用**。
#[derive(Clone, Debug, PartialEq)]
pub struct AxisPlan {
    pub unit: AxisUnit,
    /// 每一步的起点（升序）；按调用铺开时是每次调用的时间。
    pub bounds: Vec<i64>,
    /// 原始回合起点数（去重后）。
    pub turn_starts: usize,
    /// 是否补了「首回合之前」的前导步（回合轴下的第 1 步）。
    pub leading_step: bool,
    /// 按调用铺开的原因：`few_turn_starts` / `most_calls_before_first_turn`。
    pub fallback: Option<&'static str>,
}

impl AxisPlan {
    /// `call_ts` 必须升序。
    pub fn new(call_ts: &[i64], events: &[InsightEvent]) -> AxisPlan {
        let mut starts: Vec<i64> = events
            .iter()
            .filter_map(|e| match e {
                InsightEvent::TaskStarted { ts_ms } => Some(*ts_ms),
                _ => None,
            })
            .collect();
        starts.sort_unstable();
        starts.dedup();
        let per_call = |fallback| AxisPlan {
            unit: AxisUnit::AssistantCall,
            bounds: call_ts.to_vec(),
            turn_starts: starts.len(),
            leading_step: false,
            fallback: Some(fallback),
        };
        if starts.len() <= 1 {
            return per_call("few_turn_starts");
        }
        let before = call_ts.partition_point(|t| *t < starts[0]);
        if before * 2 > call_ts.len() {
            return per_call("most_calls_before_first_turn");
        }
        let turn_starts = starts.len();
        let leading_step = before > 0;
        let mut bounds = Vec::with_capacity(starts.len() + 1);
        if leading_step {
            bounds.push(call_ts[0]);
        }
        bounds.extend(starts);
        AxisPlan { unit: AxisUnit::Turn, bounds, turn_starts, leading_step, fallback: None }
    }

    /// 时间点落在哪一步（0 基）；早于第一步 → `None`。按调用铺开时是「不晚于它的
    /// 最后一次调用」（调用自身请用 `call_steps`，同毫秒调用按序号各占一步）。
    pub fn step_of(&self, ts: i64) -> Option<usize> {
        let pos = self.bounds.partition_point(|b| *b <= ts);
        (pos > 0).then(|| pos - 1)
    }
}

/// 构建会话诊断（`insights` 的 axis / diagnostics / safety 三块；`lanes` 与
/// 名义成本由调用方补）。输入顺序无要求——本函数按时间戳稳定排序。
pub fn build_insights(
    calls: &[InsightCall],
    events: &[InsightEvent],
    safety: &[InsightSafety],
    cfg: &InsightsConfig,
) -> Value {
    let mut calls: Vec<InsightCall> = calls.to_vec();
    calls.sort_by_key(|c| c.ts_ms);
    let mut events: Vec<InsightEvent> = events.to_vec();
    events.sort_by_key(InsightEvent::ts_ms);

    let call_ts: Vec<i64> = calls.iter().map(|c| c.ts_ms).collect();
    let plan = AxisPlan::new(&call_ts, &events);
    let unit = plan.unit;
    let step_of = |ts: i64| plan.step_of(ts);
    let mut steps: Vec<Step> = plan
        .bounds
        .iter()
        .enumerate()
        .map(|(i, ts)| Step::new(i + 1, *ts))
        .collect();
    // AssistantCall 轴下同毫秒的多次调用各占一步：按调用序号直接落点。
    let mut call_step: Vec<Option<usize>> = Vec::with_capacity(calls.len());
    let mut unplaced_calls = 0usize;
    for (i, call) in calls.iter().enumerate() {
        let step = match unit {
            AxisUnit::Turn => step_of(call.ts_ms),
            AxisUnit::AssistantCall => Some(i),
        };
        if step.is_none() {
            unplaced_calls += 1;
        }
        call_step.push(step);
    }

    // ── 回合聚合 ──
    let mut previous_call_ts: Option<i64> = None;
    for (i, call) in calls.iter().enumerate() {
        if let Some(s) = call_step[i] {
            let step = &mut steps[s];
            if step.calls == 0 {
                step.idle_before_ms = previous_call_ts.map(|p| call.ts_ms - p);
            }
            step.calls += 1;
            step.cache_read += call.cache_read;
            step.cache_write += call.cache_write;
            step.uncached_input += call.uncached_input;
            step.output += call.output;
            step.input_peak = step.input_peak.max(call.input());
            step.last_activity_ms = step.last_activity_ms.max(call.ts_ms);
            step.active = true;
            if let Some(model) = call.model_id.as_deref() {
                if !step.model_ids.iter().any(|m| m == model) {
                    step.model_ids.push(model.to_string());
                }
            }
        }
        previous_call_ts = Some(call.ts_ms);
    }
    let mut unplaced_events = 0usize;
    for event in &events {
        let Some(s) = step_of(event.ts_ms()) else {
            if !matches!(event, InsightEvent::TaskStarted { .. }) {
                unplaced_events += 1;
            }
            continue;
        };
        let step = &mut steps[s];
        step.last_activity_ms = step.last_activity_ms.max(event.ts_ms());
        if !matches!(event, InsightEvent::TaskStarted { .. }) {
            step.active = true;
        }
        match event {
            InsightEvent::TaskFinished { outcome, .. } if unit == AxisUnit::Turn => {
                // 一个回合里既有「会话结束」式的 unknown，又有中断的 cancelled
                // 时，取信息量大的那个。
                let rank = |o: &str| match o { "failed" => 3, "cancelled" => 2, "succeeded" => 1, _ => 0 };
                if step.outcome.as_deref().map_or(true, |cur| rank(outcome) > rank(cur)) {
                    step.outcome = Some(outcome.clone());
                }
            }
            InsightEvent::ToolFinished { outcome, .. } => match outcome.as_str() {
                "succeeded" => step.tools.succeeded += 1,
                "failed" => step.tools.failed += 1,
                "cancelled" => step.tools.cancelled += 1,
                _ => step.tools.unknown += 1,
            },
            _ => {}
        }
    }

    let session_input: i64 = calls.iter().map(InsightCall::input).sum();
    let share = |tokens: i64| -> f64 {
        if session_input > 0 { round4(tokens as f64 / session_input as f64) } else { 0.0 }
    };

    // ── 高未命中输入：逐次调用归类 ──
    let switch_ts: Vec<i64> = events
        .iter()
        .filter_map(|e| match e {
            InsightEvent::ModelSwitched { ts_ms } => Some(*ts_ms),
            _ => None,
        })
        .collect();
    let mut low: Vec<(usize, UncachedExplanation)> = Vec::new();
    // 连续低命中段的起点：基线要看「这段下滑开始之前」，否则同一段下滑里除第一
    // 次外，其余调用的基线里全是下滑本身，一律落成 unexplained。
    let mut slump_start: Option<usize> = None;
    for (i, call) in calls.iter().enumerate() {
        let is_low = call.hit_rate().is_some_and(|h| h < cfg.low_hit_rate);
        if !is_low {
            slump_start = None;
        } else if slump_start.is_none() {
            slump_start = Some(i);
        }
        // `i == 0` 恒跳过（下面要读上一次调用）；配置成 0 也不会越界。
        if i < cfg.skip_first_calls.max(1) || call.input() < cfg.min_call_input || !is_low {
            continue;
        }
        let run_start = slump_start.unwrap_or(i);
        let prev = &calls[i - 1];
        let explanation = if call.ts_ms - prev.ts_ms > cfg.cache_ttl_ms {
            UncachedExplanation::PossibleCacheExpiry
        } else if (call.model_id.is_some() && prev.model_id.is_some() && call.model_id != prev.model_id)
            || switch_ts.iter().any(|ts| *ts > prev.ts_ms && *ts <= call.ts_ms)
        {
            UncachedExplanation::AfterModelChange
        } else if run_start >= cfg.drop_baseline_calls
            && calls[run_start - cfg.drop_baseline_calls..run_start]
                .iter()
                .all(|c| c.hit_rate().is_some_and(|h| h >= cfg.drop_baseline_hit_rate))
        {
            UncachedExplanation::HitRateDrop
        } else {
            UncachedExplanation::Unexplained
        };
        if explanation.is_expected() {
            if let Some(s) = call_step[i] {
                *steps[s].notes.entry(explanation.as_str()).or_default() += 1;
            }
        }
        low.push((i, explanation));
    }

    let mut diagnostics: Vec<Value> = Vec::new();

    // 相邻（同回合或相邻回合）的低命中调用合并成区间。
    let mut intervals: Vec<Vec<(usize, UncachedExplanation)>> = Vec::new();
    for item in low.iter().copied() {
        let Some(step) = call_step[item.0] else { continue };
        match intervals.last_mut() {
            Some(last) if call_step[last.last().unwrap().0].is_some_and(|prev| step <= prev + 1) => last.push(item),
            _ => intervals.push(vec![item]),
        }
    }
    for interval in intervals {
        let mut by_explanation: BTreeMap<UncachedExplanation, (usize, i64)> = BTreeMap::new();
        for (i, explanation) in &interval {
            let entry = by_explanation.entry(*explanation).or_default();
            entry.0 += 1;
            entry.1 += calls[*i].cache_write + calls[*i].uncached_input;
        }
        // 区间取占比（调用数）最高的解释；并列时取更「未知」的那个，宁可不替用户
        // 找理由。
        let (&main, _) = by_explanation
            .iter()
            .max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(a.0.cmp(b.0)))
            .expect("interval is non-empty");
        if main.is_expected() {
            continue;
        }
        let listed: Vec<usize> = interval.iter().filter(|(_, e)| !e.is_expected()).map(|(i, _)| *i).collect();
        let uncached: i64 = listed.iter().map(|i| calls[*i].cache_write + calls[*i].uncached_input).sum();
        if share(uncached) < cfg.min_uncached_share {
            continue;
        }
        let from = call_step[interval[0].0].unwrap_or(0) + 1;
        let to = call_step[interval[interval.len() - 1].0].unwrap_or(0) + 1;
        let mut fact = json!({ "calls": listed.len(), "uncached_tokens": uncached });
        if main == UncachedExplanation::HitRateDrop {
            // 基线取这段下滑开始前的 N 次调用（与归类同一口径）。
            let mut first = listed[0];
            while first > 0 && calls[first - 1].hit_rate().is_some_and(|h| h < cfg.low_hit_rate) {
                first -= 1;
            }
            let base = &calls[first.saturating_sub(cfg.drop_baseline_calls)..first];
            let before = mean(base.iter().filter_map(InsightCall::hit_rate));
            // 只平均归为「命中下降」的那些调用（区间里的 unexplained 不掺进来）。
            let after = mean(
                interval.iter().filter(|(_, e)| *e == UncachedExplanation::HitRateDrop).filter_map(|(i, _)| calls[*i].hit_rate()),
            );
            fact["hit_before"] = json!(round4(before));
            fact["hit_after"] = json!(round4(after));
        }
        let notes: Vec<Value> = by_explanation
            .iter()
            .filter(|(e, _)| e.is_expected())
            .map(|(e, (n, _))| json!({ "explanation": e.as_str(), "calls": n }))
            .collect();
        diagnostics.push(json!({
            "kind": "high_uncached_input",
            "steps": { "from": from, "to": to },
            "fact": fact,
            "impact": { "tokens": uncached, "share_of_session_input": share(uncached) },
            "explanation": main.as_str(),
            "cause": "unknown",
            "evidence": [],
            "context_notes": notes,
            "remedy_id": "inspect-uncached-input",
        }));
    }

    // ── 单次输入规模增长 ──
    // 只在回合轴上判：按调用铺开时，一个任务内每次调用都比上一次多带些工具输出，
    // 「逐次增长」是常态（真机 20 个样本里按调用铺开的会话几乎全中）。
    let with_calls: Vec<&Step> = if unit == AxisUnit::Turn {
        steps.iter().filter(|s| s.calls > 0).collect()
    } else {
        Vec::new()
    };
    let mut k = 0usize;
    while k < with_calls.len() {
        let start = k;
        let mut run_max = with_calls[k].input_peak;
        let mut end = k;
        while end + 1 < with_calls.len() && with_calls[end + 1].input_peak as f64 >= cfg.growth_tolerance * run_max as f64 {
            end += 1;
            run_max = run_max.max(with_calls[end].input_peak);
        }
        let first = with_calls[start].input_peak;
        let len = end - start + 1;
        if len >= cfg.growth_min_steps
            && first > 0
            && run_max >= cfg.growth_min_peak
            && run_max as f64 / first as f64 >= cfg.growth_min_ratio
        {
            // 区间终点取达到最大值的那一回合：之后的持平不算「增长」；起点取终点之前
            // 最后一个最低点：之前的平台期不算「增长」（验收：20 个平稳回合 + 一段
            // 增长曾报 from = 1，impact 把平台期也算进去）。
            let peak_at = (start..=end).rev().find(|j| with_calls[*j].input_peak == run_max).unwrap_or(end);
            let low = with_calls[start..=peak_at].iter().map(|s| s.input_peak).min().unwrap_or(first);
            let rise = (start..=peak_at).rev().find(|j| with_calls[*j].input_peak == low).unwrap_or(start);
            let first = with_calls[rise].input_peak;
            let run = &with_calls[rise..=peak_at];
            if run.len() >= cfg.growth_min_steps && first > 0 && run_max as f64 / first as f64 >= cfg.growth_min_ratio {
                let tokens: i64 = run.iter().map(|s| s.input()).sum();
                diagnostics.push(json!({
                    "kind": "input_growth",
                    "steps": { "from": run[0].index, "to": run[run.len() - 1].index },
                    "fact": {
                        "peak_from": first,
                        "peak_to": run_max,
                        "ratio": round2(run_max as f64 / first as f64),
                    },
                    "impact": { "tokens": tokens, "share_of_session_input": share(tokens) },
                    "cause": "unknown",
                    "evidence": [],
                    "context_notes": [],
                    "remedy_id": "review-context-growth",
                }));
            }
        }
        k = end + 1;
    }

    // ── 同一调用重复失败 ──
    struct Failure<'a> { step: usize, capability: Option<&'a str>, fingerprint: Option<&'a str>, excerpt: bool }
    let failures: Vec<Failure> = events
        .iter()
        .filter_map(|e| match e {
            InsightEvent::ToolFinished { ts_ms, capability_id, outcome, invocation_fingerprint, has_error_excerpt }
                if outcome == "failed" =>
            {
                step_of(*ts_ms).map(|step| Failure {
                    step,
                    capability: capability_id.as_deref(),
                    fingerprint: invocation_fingerprint.as_deref(),
                    excerpt: *has_error_excerpt,
                })
            }
            _ => None,
        })
        .collect();
    let mut covered: BTreeSet<usize> = BTreeSet::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut by_fingerprint: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, f) in failures.iter().enumerate() {
        if let Some(fp) = f.fingerprint {
            by_fingerprint.entry(fp).or_default().push(i);
        }
    }
    for members in by_fingerprint.into_values() {
        // 按回合间隔切串：相隔太远的两次失败不是「反复」。
        let mut cluster: Vec<usize> = Vec::new();
        for m in members {
            if let Some(&last) = cluster.last() {
                if failures[m].step > failures[last].step + cfg.repeat_invocation_gap_steps {
                    if cluster.len() >= cfg.repeat_same_invocation {
                        covered.extend(cluster.iter().copied());
                        groups.push(std::mem::take(&mut cluster));
                    } else {
                        cluster.clear();
                    }
                }
            }
            cluster.push(m);
        }
        if cluster.len() >= cfg.repeat_same_invocation {
            covered.extend(cluster.iter().copied());
            groups.push(cluster);
        }
    }
    // 同一工具在短窗口内反复失败（参数不同），作为第二判据。
    let mut by_tool: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, f) in failures.iter().enumerate() {
        if covered.contains(&i) {
            continue;
        }
        if let Some(tool) = f.capability {
            by_tool.entry(tool).or_default().push(i);
        }
    }
    // 贪心扫描出**每一段**达标的窗口（互不重叠）：初版只留一个最大窗口，同一工具
    // 在第 10 与第 200 回合各有一段连续失败时只报了其中一段（验收 finding）。
    for members in by_tool.into_values() {
        let mut i = 0;
        while i < members.len() {
            let mut j = i;
            while j + 1 < members.len()
                && failures[members[j + 1]].step < failures[members[i]].step + cfg.repeat_tool_window_steps
            {
                j += 1;
            }
            if j + 1 - i >= cfg.repeat_same_tool {
                groups.push(members[i..=j].to_vec());
                i = j + 1;
            } else {
                i += 1;
            }
        }
    }
    // 回合范围重叠的组合并成一条：同一段里几个调用各自反复失败，用户要看的是
    // 「这一段在反复失败」，不是 N 条并列的诊断（真机一个 codex 会话的第 1 回合
    // 拆出了 10 条）。
    groups.sort_by_key(|g| g.iter().map(|i| failures[*i].step).min().unwrap_or(0));
    let mut merged: Vec<(Vec<usize>, usize)> = Vec::new(); // (成员, 合并了几组)
    for group in groups {
        let lo = group.iter().map(|i| failures[*i].step).min().unwrap_or(0);
        match merged.last_mut() {
            Some((members, n)) if lo <= members.iter().map(|i| failures[*i].step).max().unwrap_or(0) => {
                members.extend(group);
                *n += 1;
            }
            _ => merged.push((group, 1)),
        }
    }
    for (members, invocations) in merged {
        let steps_hit: BTreeSet<usize> = members.iter().map(|i| failures[*i].step).collect();
        let tokens: i64 = steps_hit.iter().map(|s| steps[*s].input()).sum();
        let excerpt = members.iter().any(|i| failures[*i].excerpt);
        let same_invocation = invocations == 1
            && members.iter().all(|i| failures[*i].fingerprint.is_some())
            && members.iter().map(|i| failures[*i].fingerprint).collect::<BTreeSet<_>>().len() == 1;
        // 出现最多的工具名作代表（并列取字典序小的，保证确定性）。
        let mut tool_counts: BTreeMap<Option<&str>, usize> = BTreeMap::new();
        for i in &members {
            *tool_counts.entry(failures[*i].capability).or_default() += 1;
        }
        let capability = tool_counts.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).and_then(|(k, _)| *k);
        diagnostics.push(json!({
            "kind": "repeated_failure",
            "steps": {
                "from": steps_hit.iter().next().copied().unwrap_or(0) + 1,
                "to": steps_hit.iter().last().copied().unwrap_or(0) + 1,
            },
            "fact": {
                "failures": members.len(),
                "steps_hit": steps_hit.len(),
                "capability_id": capability,
                "same_invocation": same_invocation,
                "groups": invocations,
            },
            "impact": { "tokens": tokens, "share_of_session_input": share(tokens) },
            "cause": if excerpt { "evidence" } else { "unknown" },
            "evidence": if excerpt { json!(["error_excerpt"]) } else { json!([]) },
            "context_notes": [],
            "remedy_id": "inspect-repeated-failure",
        }));
    }

    // 排序（r6 §7.5）：原因确定度优先，同级按占比降序；再按起点稳定。
    diagnostics.sort_by(|a, b| {
        cause_rank(a["cause"].as_str().unwrap_or("")).cmp(&cause_rank(b["cause"].as_str().unwrap_or("")))
            .then(
                b["impact"]["share_of_session_input"].as_f64().unwrap_or(0.0)
                    .partial_cmp(&a["impact"]["share_of_session_input"].as_f64().unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(a["steps"]["from"].as_i64().cmp(&b["steps"]["from"].as_i64()))
    });

    // ── 安全提醒（独立块）──
    let mut rules: BTreeMap<(String, String), BTreeSet<usize>> = BTreeMap::new();
    let mut counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    for hit in safety {
        let key = (hit.rule.clone(), hit.severity.clone());
        *counts.entry(key.clone()).or_default() += 1;
        let entry = rules.entry(key).or_default();
        if let Some(step) = hit.ts_ms.and_then(step_of) {
            entry.insert(step + 1);
        }
    }
    let safety_json = json!({
        "count": safety.len(),
        "critical": safety.iter().filter(|s| s.severity == "critical").count(),
        "rules": rules.into_iter().map(|((rule, severity), steps)| json!({
            "rule": rule,
            "severity": severity,
            "count": counts[&(rule.clone(), severity.clone())],
            "steps": steps.into_iter().collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });

    let steps_json: Vec<Value> = steps.iter().map(|s| step_json(s, unit)).collect();
    json!({
        "schema_version": 1,
        "axis": {
            "unit": unit.as_str(),
            // 回合起点数：unit=assistant_call 时区分「执行环境没有回合」(0) 与「只记到
            // 一个回合」(1)，前端据此说明为什么按调用展示。
            "turn_starts": plan.turn_starts,
            "leading_step": plan.leading_step,
            "fallback": plan.fallback,
            "steps": steps_json,
            "unplaced": { "usage_facts": unplaced_calls, "workflow_events": unplaced_events },
        },
        "session": {
            "calls": calls.len(),
            "input": {
                "cache_read": calls.iter().map(|c| c.cache_read).sum::<i64>(),
                "cache_write": calls.iter().map(|c| c.cache_write).sum::<i64>(),
                "uncached_input": calls.iter().map(|c| c.uncached_input).sum::<i64>(),
            },
            "output": calls.iter().map(|c| c.output).sum::<i64>(),
        },
        "diagnostics": diagnostics,
        "safety": safety_json,
    })
}

/// 把每次调用落到的回合下标（0 基）返回给调用方——查询层按回合分桶计价用。
/// 与 `build_insights` 同一落点规则。
pub fn call_steps(calls: &[InsightCall], events: &[InsightEvent]) -> Vec<Option<usize>> {
    let mut order: Vec<usize> = (0..calls.len()).collect();
    order.sort_by_key(|i| calls[*i].ts_ms);
    let call_ts: Vec<i64> = order.iter().map(|i| calls[*i].ts_ms).collect();
    let plan = AxisPlan::new(&call_ts, events);
    let mut out = vec![None; calls.len()];
    for (rank, i) in order.into_iter().enumerate() {
        out[i] = match plan.unit {
            AxisUnit::AssistantCall => Some(rank),
            AxisUnit::Turn => plan.step_of(calls[i].ts_ms),
        };
    }
    out
}

fn step_json(step: &Step, unit: AxisUnit) -> Value {
    let mut out = json!({
        "index": step.index,
        "started_at_ms": step.started_at_ms,
        "input": {
            "cache_read": step.cache_read,
            "cache_write": step.cache_write,
            "uncached_input": step.uncached_input,
        },
        "output": step.output,
        "input_peak": step.input_peak,
        "calls": step.calls,
        "model_ids": step.model_ids,
        "tools": {
            "succeeded": step.tools.succeeded,
            "failed": step.tools.failed,
            "cancelled": step.tools.cancelled,
            "unknown": step.tools.unknown,
        },
        "notes": step.notes.iter().map(|(k, n)| json!({ "explanation": k, "calls": n })).collect::<Vec<_>>(),
    });
    if step.active {
        out["ended_at_ms"] = json!(step.last_activity_ms);
    }
    if let Some(idle) = step.idle_before_ms {
        out["idle_before_ms"] = json!(idle);
    }
    if step.input() > 0 {
        out["hit_rate"] = json!(round4(step.cache_read as f64 / step.input() as f64));
    }
    if unit == AxisUnit::Turn {
        if let Some(outcome) = &step.outcome {
            out["outcome"] = json!(outcome);
        }
    }
    out
}

fn mean(values: impl Iterator<Item = f64>) -> f64 {
    let (sum, n) = values.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    if n == 0 { 0.0 } else { sum / n as f64 }
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    fn call(ts: i64, model: &str, read: i64, write: i64, unc: i64) -> InsightCall {
        InsightCall { ts_ms: ts, model_id: Some(model.to_string()), cache_read: read, cache_write: write, uncached_input: unc, output: 100 }
    }
    fn started(ts: i64) -> InsightEvent {
        InsightEvent::TaskStarted { ts_ms: ts }
    }
    fn failed(ts: i64, tool: &str, fp: &str, excerpt: bool) -> InsightEvent {
        InsightEvent::ToolFinished {
            ts_ms: ts,
            capability_id: Some(tool.to_string()),
            outcome: "failed".to_string(),
            invocation_fingerprint: Some(fp.to_string()),
            has_error_excerpt: excerpt,
        }
    }
    fn build(calls: &[InsightCall], events: &[InsightEvent]) -> Value {
        build_insights(calls, events, &[], &InsightsConfig::default())
    }
    fn kinds(v: &Value) -> Vec<String> {
        v["diagnostics"].as_array().unwrap().iter().map(|d| d["kind"].as_str().unwrap().to_string()).collect()
    }
    /// 一串健康调用：每回合 3 次、命中 98%。
    fn healthy(turns: usize, base_ts: i64) -> (Vec<InsightCall>, Vec<InsightEvent>) {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        for t in 0..turns {
            let ts = base_ts + t as i64 * 2 * MIN;
            events.push(started(ts));
            for c in 0..3 {
                calls.push(call(ts + 1_000 + c * 1_000, "m", 49_000, 500, 500));
            }
        }
        (calls, events)
    }

    #[test]
    fn calls_land_in_half_open_turn_intervals_and_early_calls_get_a_leading_step() {
        let calls = vec![call(50, "m", 0, 0, 10), call(100, "m", 0, 0, 10), call(199, "m", 0, 0, 10), call(200, "m", 0, 0, 10)];
        let v = build(&calls, &[started(100), started(200)]);
        assert_eq!(v["axis"]["unit"], "turn");
        let steps = v["axis"]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 3, "首回合前的调用进前导步，不丢");
        assert_eq!(steps[0]["calls"], 1);
        assert_eq!(steps[1]["calls"], 2, "边界 100 属于回合 1，199 仍在回合 1");
        assert_eq!(steps[2]["calls"], 1, "边界 200 属于回合 2");
        assert_eq!(v["axis"]["unplaced"]["usage_facts"], 0);
        assert_eq!(call_steps(&calls, &[started(100), started(200)]), vec![Some(0), Some(1), Some(1), Some(2)]);
    }

    #[test]
    fn without_turn_events_each_assistant_call_is_a_step() {
        let calls = vec![call(10, "m", 0, 0, 10), call(10, "m", 0, 0, 20), call(30, "m", 0, 0, 30)];
        let v = build(&calls, &[]);
        assert_eq!(v["axis"]["unit"], "assistant_call");
        let steps = v["axis"]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 3, "同毫秒的两次调用各占一步");
        assert!(steps.iter().all(|s| s["calls"] == 1));
        assert!(steps.iter().all(|s| s.get("outcome").is_none()), "按调用计的轴没有回合结果");
    }

    #[test]
    fn healthy_session_yields_no_diagnostics() {
        let (calls, events) = healthy(20, 1_000_000);
        let v = build(&calls, &events);
        assert!(kinds(&v).is_empty(), "{:?}", v["diagnostics"]);
    }

    #[test]
    fn cold_start_is_not_flagged() {
        let (mut calls, events) = healthy(6, 1_000_000);
        calls[0] = call(calls[0].ts_ms, "m", 0, 40_000, 10_000);
        calls[1] = call(calls[1].ts_ms, "m", 0, 40_000, 10_000);
        let v = build(&calls, &events);
        assert!(kinds(&v).is_empty(), "会话前 2 次调用不判：{:?}", v["diagnostics"]);
    }

    #[test]
    fn low_hit_after_long_idle_is_a_note_not_a_diagnostic() {
        let (mut calls, mut events) = healthy(6, 1_000_000);
        let ts = calls.last().unwrap().ts_ms + 47 * MIN;
        events.push(started(ts));
        calls.push(call(ts + 1_000, "m", 0, 45_000, 5_000));
        calls.push(call(ts + 2_000, "m", 49_000, 500, 500));
        let v = build(&calls, &events);
        assert!(kinds(&v).is_empty(), "{:?}", v["diagnostics"]);
        let last = v["axis"]["steps"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["notes"][0]["explanation"], "possible_cache_expiry");
        assert!(last["idle_before_ms"].as_i64().unwrap() > 46 * MIN);
    }

    #[test]
    fn low_hit_after_model_change_is_a_note_not_a_diagnostic() {
        let (mut calls, events) = healthy(6, 1_000_000);
        let n = calls.len();
        calls[n - 3] = InsightCall { model_id: Some("other".into()), ..call(calls[n - 3].ts_ms, "other", 0, 45_000, 5_000) };
        calls[n - 2].model_id = Some("other".into());
        calls[n - 1].model_id = Some("other".into());
        let v = build(&calls, &events);
        assert!(kinds(&v).is_empty(), "{:?}", v["diagnostics"]);
        let last = v["axis"]["steps"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["notes"][0]["explanation"], "after_model_change");
        assert_eq!(last["model_ids"], json!(["other"]));
    }

    #[test]
    fn unexplained_uncached_interval_is_listed_with_unknown_cause() {
        let (mut calls, events) = healthy(10, 1_000_000);
        // 回合 5–6 的 6 次调用（索引 12..18）命中跌到 20%，间隔短、模型没换，
        // 但此前基线不是连续 ≥90%（插一个 80% 的调用破坏基线）→ unexplained。
        calls[11] = call(calls[11].ts_ms, "m", 40_000, 5_000, 5_000);
        for c in calls.iter_mut().take(18).skip(12) {
            *c = call(c.ts_ms, "m", 10_000, 30_000, 10_000);
        }
        let v = build(&calls, &events);
        let d = &v["diagnostics"][0];
        assert_eq!(d["kind"], "high_uncached_input");
        assert_eq!(d["explanation"], "unexplained");
        assert_eq!(d["cause"], "unknown");
        assert_eq!(d["steps"], json!({"from": 5, "to": 6}));
        assert_eq!(d["fact"]["calls"], 6);
        assert_eq!(d["fact"]["uncached_tokens"], 6 * 40_000);
        assert!(d["impact"].get("estimated_amount").is_none(), "诊断不给金额（r6）");
    }

    #[test]
    fn drop_after_a_stable_baseline_is_classified_as_hit_rate_drop() {
        let (mut calls, events) = healthy(10, 1_000_000);
        for c in calls.iter_mut().take(18).skip(12) {
            *c = call(c.ts_ms, "m", 10_000, 30_000, 10_000);
        }
        let v = build(&calls, &events);
        let d = &v["diagnostics"][0];
        assert_eq!(d["explanation"], "hit_rate_drop");
        assert!(d["fact"]["hit_before"].as_f64().unwrap() >= 0.9);
        assert!(d["fact"]["hit_after"].as_f64().unwrap() < 0.5);
    }

    #[test]
    fn a_single_small_unexplained_miss_is_below_the_listing_threshold() {
        let (mut calls, events) = healthy(40, 1_000_000);
        calls[30] = call(calls[30].ts_ms, "m", 0, 8_000, 3_000);
        let v = build(&calls, &events);
        assert!(kinds(&v).is_empty(), "单次、占比 <1% 的未命中不进清单：{:?}", v["diagnostics"]);
    }

    #[test]
    fn input_growth_over_ten_turns_is_a_fact_with_unknown_cause() {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        for t in 0..14i64 {
            let ts = 1_000_000 + t * 2 * MIN;
            events.push(started(ts));
            let size = if t < 2 { 30_000 } else { 30_000 + (t - 2) * 9_000 };
            calls.push(call(ts + 1_000, "m", size - 100, 50, 50));
        }
        let v = build(&calls, &events);
        let d = v["diagnostics"].as_array().unwrap().iter().find(|d| d["kind"] == "input_growth").expect("growth");
        assert_eq!(d["cause"], "unknown");
        assert_eq!(d["fact"]["peak_from"], 30_000);
        assert_eq!(d["fact"]["peak_to"], 30_000 + 11 * 9_000);
        assert_eq!(d["steps"]["to"], 14);
        assert!(d["fact"]["ratio"].as_f64().unwrap() >= 3.0);
    }

    #[test]
    fn short_or_flat_growth_is_not_listed() {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        for t in 0..8i64 {
            let ts = 1_000_000 + t * 2 * MIN;
            events.push(started(ts));
            calls.push(call(ts + 1_000, "m", 10_000 * (t + 1) - 100, 50, 50));
        }
        assert!(kinds(&build(&calls, &events)).is_empty(), "8 个回合不够 10 个");
    }

    #[test]
    fn growth_below_the_absolute_floor_is_not_listed() {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        for t in 0..14i64 {
            let ts = 1_000_000 + t * 2 * MIN;
            events.push(started(ts));
            calls.push(call(ts + 1_000, "m", 10_000 + t * 5_000, 50, 50));
        }
        assert!(kinds(&build(&calls, &events)).is_empty(), "峰值 7.5 万 < 10 万下限");
    }

    #[test]
    fn a_single_turn_session_is_laid_out_per_call() {
        let calls: Vec<InsightCall> = (0..5).map(|i| call(1_000 + i * 1_000, "m", 0, 0, 10)).collect();
        let v = build(&calls, &[started(500)]);
        assert_eq!(v["axis"]["unit"], "assistant_call");
        assert_eq!(v["axis"]["turn_starts"], 1);
        assert_eq!(v["axis"]["steps"].as_array().unwrap().len(), 5);
        assert_eq!(call_steps(&calls, &[started(500)]), (0..5).map(Some).collect::<Vec<_>>());
    }

    #[test]
    fn same_invocation_failures_far_apart_are_not_one_repeat() {
        let (calls, mut events) = healthy(20, 1_000_000);
        let at = |turn: i64| 1_000_000 + turn * 2 * MIN + 500;
        events.push(failed(at(1), "Bash", "fp", true));
        events.push(failed(at(15), "Bash", "fp", true));
        assert!(kinds(&build(&calls, &events)).is_empty(), "相隔 14 个回合");
        events.push(failed(at(17), "Bash", "fp", true));
        let v = build(&calls, &events);
        assert_eq!(v["diagnostics"][0]["steps"], json!({"from": 16, "to": 18}));
        assert_eq!(v["diagnostics"][0]["fact"]["failures"], 2);
    }

    #[test]
    fn calls_before_the_first_turn_get_a_leading_step_or_a_per_call_axis() {
        // 1 次调用在首回合前、6 次在回合内 → 补前导步，不丢调用。
        let mut calls = vec![call(50, "m", 0, 0, 10)];
        for t in 0..3 { calls.push(call(100 + t, "m", 0, 0, 10)); calls.push(call(200 + t, "m", 0, 0, 10)); }
        let v = build(&calls, &[started(100), started(200)]);
        assert_eq!(v["axis"]["unit"], "turn");
        assert_eq!(v["axis"]["leading_step"], true);
        assert_eq!(v["axis"]["steps"].as_array().unwrap().len(), 3);
        assert_eq!(v["axis"]["steps"][0]["calls"], 1);
        assert_eq!(v["axis"]["unplaced"]["usage_facts"], 0);
        // 过半调用在首回合前 → 按调用铺开。
        let mut calls: Vec<InsightCall> = (0..10).map(|i| call(i, "m", 0, 0, 10)).collect();
        calls.push(call(100, "m", 0, 0, 10));
        calls.push(call(200, "m", 0, 0, 10));
        let v = build(&calls, &[started(100), started(200)]);
        assert_eq!(v["axis"]["unit"], "assistant_call");
        assert_eq!(v["axis"]["fallback"], "most_calls_before_first_turn");
        assert_eq!(v["axis"]["steps"].as_array().unwrap().len(), 12);
    }

    #[test]
    fn every_burst_of_one_tool_is_reported() {
        let (calls, mut events) = healthy(30, 1_000_000);
        let at = |turn: i64| 1_000_000 + turn * 2 * MIN + 500;
        for (turn, fp) in [(2, "a"), (3, "b"), (4, "c"), (20, "d"), (21, "e"), (22, "f")] {
            events.push(failed(at(turn), "Bash", fp, false));
        }
        let v = build(&calls, &events);
        let ranges: Vec<Value> = v["diagnostics"].as_array().unwrap().iter().map(|d| d["steps"].clone()).collect();
        assert_eq!(ranges.len(), 2, "{ranges:?}");
    }

    #[test]
    fn growth_starts_at_the_last_low_point_not_the_flat_lead_in() {
        let mut calls = Vec::new();
        let mut events = Vec::new();
        for t in 0..30i64 {
            let ts = 1_000_000 + t * 2 * MIN;
            events.push(started(ts));
            let size = if t < 15 { 30_000 } else { 30_000 + (t - 14) * 8_000 };
            calls.push(call(ts + 1_000, "m", size - 100, 50, 50));
        }
        let v = build(&calls, &events);
        let d = v["diagnostics"].as_array().unwrap().iter().find(|d| d["kind"] == "input_growth").expect("growth");
        assert_eq!(d["steps"]["from"], 15, "平台期（回合 1–14）不算增长");
        assert_eq!(d["steps"]["to"], 30);
    }

    #[test]
    fn skip_first_calls_zero_does_not_panic() {
        let cfg = InsightsConfig { skip_first_calls: 0, ..InsightsConfig::default() };
        let calls = vec![call(1, "m", 0, 40_000, 10_000), call(2, "m", 0, 40_000, 10_000)];
        let _ = build_insights(&calls, &[], &[], &cfg);
    }

    #[test]
    fn a_step_without_measurements_has_no_end_time() {
        let v = build(&[call(250, "m", 0, 0, 10)], &[started(100), started(200)]);
        assert!(v["axis"]["steps"][0].get("ended_at_ms").is_none(), "回合 1 没有任何测量");
        assert!(v["axis"]["steps"][1].get("ended_at_ms").is_some());
    }

    #[test]
    fn same_invocation_failing_twice_is_repeated_failure_with_evidence() {
        let (calls, mut events) = healthy(6, 1_000_000);
        let t2 = 1_000_000 + 2 * 2 * MIN;
        events.push(failed(t2 + 500, "Bash", "fp-a", true));
        events.push(failed(t2 + 1_500, "Bash", "fp-a", true));
        events.push(failed(t2 + 2_500, "Bash", "fp-b", true));
        let v = build(&calls, &events);
        let d = &v["diagnostics"][0];
        assert_eq!(d["kind"], "repeated_failure");
        assert_eq!(d["fact"]["failures"], 2, "fp-b 是另一个调用，不并入");
        assert_eq!(d["fact"]["same_invocation"], true);
        assert_eq!(d["cause"], "evidence");
        assert_eq!(d["evidence"], json!(["error_excerpt"]));
        assert_eq!(d["steps"], json!({"from": 3, "to": 3}));
        assert_eq!(v["axis"]["steps"][2]["tools"]["failed"], 3);
    }

    #[test]
    fn different_calls_of_one_tool_count_only_inside_the_window() {
        let (calls, mut events) = healthy(10, 1_000_000);
        let at = |turn: i64| 1_000_000 + turn * 2 * MIN + 500;
        // 3 次不同参数的 Bash 失败落在回合 2、3、4（窗口 3 个回合内）→ 进清单；
        // 另 2 次分散在回合 8、10 → 不成组。
        for (turn, fp) in [(1, "a"), (2, "b"), (3, "c"), (7, "d"), (9, "e")] {
            events.push(failed(at(turn), "Bash", fp, false));
        }
        let v = build(&calls, &events);
        let listed: Vec<&Value> = v["diagnostics"].as_array().unwrap().iter().filter(|d| d["kind"] == "repeated_failure").collect();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["fact"]["failures"], 3);
        assert_eq!(listed[0]["fact"]["same_invocation"], false);
        assert_eq!(listed[0]["cause"], "unknown", "没有错误摘录 → 原因未明");
    }

    #[test]
    fn overlapping_failure_groups_merge_into_one_diagnostic() {
        let (calls, mut events) = healthy(6, 1_000_000);
        let t2 = 1_000_000 + 2 * 2 * MIN;
        for (dt, fp) in [(100, "a"), (200, "b"), (300, "a"), (400, "b"), (500, "c"), (600, "c")] {
            events.push(failed(t2 + dt, "Bash", fp, false));
        }
        let v = build(&calls, &events);
        let d = v["diagnostics"].as_array().unwrap();
        assert_eq!(d.len(), 1, "{d:?}");
        assert_eq!(d[0]["fact"]["failures"], 6);
        assert_eq!(d[0]["fact"]["groups"], 3);
        assert_eq!(d[0]["fact"]["same_invocation"], false);
    }

    #[test]
    fn diagnostics_sort_by_cause_then_share() {
        let (mut calls, mut events) = healthy(10, 1_000_000);
        calls[11] = call(calls[11].ts_ms, "m", 40_000, 5_000, 5_000);
        for c in calls.iter_mut().take(18).skip(12) {
            *c = call(c.ts_ms, "m", 10_000, 30_000, 10_000);
        }
        let t8 = 1_000_000 + 8 * 2 * MIN;
        events.push(failed(t8 + 500, "Bash", "fp", true));
        events.push(failed(t8 + 1_500, "Bash", "fp", true));
        let v = build(&calls, &events);
        assert_eq!(kinds(&v), ["repeated_failure", "high_uncached_input"],
            "有错误摘录的排前面，即使占比更小");
    }

    #[test]
    fn interrupt_outcome_wins_over_unknown_session_end() {
        let (calls, mut events) = healthy(3, 1_000_000);
        let t1 = 1_000_000 + 2 * MIN;
        events.push(InsightEvent::TaskFinished { ts_ms: t1 + 1_500, outcome: "cancelled".into() });
        events.push(InsightEvent::TaskFinished { ts_ms: t1 + 1_600, outcome: "unknown".into() });
        let v = build(&calls, &events);
        assert_eq!(v["axis"]["steps"][1]["outcome"], "cancelled");
        assert!(v["axis"]["steps"][0].get("outcome").is_none());
    }

    #[test]
    fn safety_is_counted_separately_and_mapped_to_steps() {
        let (calls, events) = healthy(3, 1_000_000);
        let safety = vec![
            InsightSafety { ts_ms: Some(1_000_000 + 2 * MIN + 10), rule: "SV601".into(), severity: "critical".into() },
            InsightSafety { ts_ms: None, rule: "SV601".into(), severity: "critical".into() },
            InsightSafety { ts_ms: Some(1_000_000 + 10), rule: "SV605".into(), severity: "warning".into() },
        ];
        let v = build_insights(&calls, &events, &safety, &InsightsConfig::default());
        assert_eq!(v["safety"]["count"], 3);
        assert_eq!(v["safety"]["critical"], 2);
        assert_eq!(v["safety"]["rules"][0], json!({"rule": "SV601", "severity": "critical", "count": 2, "steps": [2]}));
        assert!(kinds(&v).is_empty(), "安全提醒不进消耗诊断");
    }
}
