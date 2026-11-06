//! 执行环境无关的会话语义——所有执行环境适配器共用的一份规则。
//!
//! 此前这些规则在 `agent-vitals-harnesses` 里按执行环境各写一份：`fingerprint` /
//! `safe_label` 在 dsh 有逐字相同的私有副本，「模型切换」在四个执行环境各有一段
//! `previous_model` 比较，调用指纹的公式在 claude / codex 各写一遍，Claude 的
//! 「回合从哪开始」更是在 evidence（SV612、调用树）与 workflow（消耗诊断）两处
//! 各有一个**结论不同**的判据——同一会话在两个视图里回合数对不上
//! （SESSION_TRACE_DIAGNOSTICS_SPEC r6 P0「口径先于诊断」）。
//!
//! 分工：执行环境只做 wire 翻译（这条原生记录是「新请求 / 中断 / 都不是」，参数
//! 在哪个字段），语义（新请求开回合、中断记取消、指纹怎么算、何为切换）在这里
//! 定一次。本模块不认识任何执行环境名；`harness_tag` 只是调用方给的指纹命名空间。

use serde_json::Value;

use crate::contracts::evidence::TimeSpan;
use crate::contracts::source_identity::{canonical_json, fnv1a64_hex};
use crate::domain::util::to_epoch_ms;

/// 单向指纹（`fnv1a64:<hex>`）。只用于去重/分组键，原文不可还原。
pub fn fingerprint(value: &str) -> String {
    format!("fnv1a64:{}", fnv1a64_hex(value.as_bytes()))
}

/// 能力标识：普通名字原样保留；任何像自由文本的值（路径、命令、提示词）一律
/// 哈希，畸形的执行环境载荷不能借能力名把原文带进权威表。
pub fn safe_label(value: &str) -> String {
    if !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
    {
        value.to_string()
    } else {
        fingerprint(value)
    }
}

/// ISO-8601 → epoch 毫秒（保留毫秒小数；秒级时间戳补零）。
pub fn iso_to_epoch_ms(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let (seconds, _) = crate::domain::budget::parse_iso(value)?;
    let fraction = value
        .split_once('.')
        .and_then(|(_, rest)| rest.find(['Z', '+', '-']).map(|i| &rest[..i]))
        .unwrap_or("");
    let mut digits = fraction.chars().take(3).collect::<String>();
    if digits.chars().any(|c| !c.is_ascii_digit()) {
        return None;
    }
    while digits.len() < 3 {
        digits.push('0');
    }
    let fraction_ms = if digits.is_empty() { 0 } else { digits.parse::<i64>().ok()? };
    seconds.checked_mul(1000)?.checked_add(fraction_ms)
}

/// 执行环境状态字 → 闭合词表 succeeded / failed / cancelled / unknown。
/// 「没看到失败」不折算成成功：认不出的状态一律 unknown。
pub fn outcome(status: Option<&str>, error_present: bool) -> &'static str {
    if error_present {
        return "failed";
    }
    match status.unwrap_or("").to_ascii_lowercase().as_str() {
        "ok" | "success" | "succeeded" | "completed" | "complete" | "applied" => "succeeded",
        "error" | "failed" | "failure" => "failed",
        "cancelled" | "canceled" | "aborted" => "cancelled",
        _ => "unknown",
    }
}

/// 会话跨度 = **喂进这份证据的所有原生记录**的时间 min/max。
///
/// 语义按 `docs/v1.0.0/OBSERVED_SPAN_IMPLEMENTATION_PLAN.md` §3.1 的 D1–D4：
///
/// - **D1** 取**实测事件时间**，不是会话头声明的范围——头部可能被轮转/截断，
///   实测值才是"这份日志里真的有什么"。
/// - **D2** **0 条记录 → `None`**，**绝不返回 `(0,0)`**：后者会被下游读成
///   1970-01-01，正是本仓反复栽过的「把缺失渲染成零」。1 条 → `start == end`
///   （合法——"这一刻有记录"）。
/// - **D3** 一律过 `to_epoch_ms`：Claude 与 WorkBuddy 的 `parse_iso` 出**秒**，
///   DSH 出**毫秒**，Codex 出毫秒。调用方只负责把字段取出来，单位归一只在这一处。
/// - **D4** 只取**原生记录**的时间戳，不含合成的 `ordinal` 序数——序数不是时间，
///   拿它当时间就是把"我们排的序"冒充成"观测到的时间"。
///
/// **跨度跟随调用方的记录集合**：调用方喂的是分叉后的事件，跨度就是分叉后的。
/// 这是有意的——跨度描述「**这份证据是从什么算出来的**」，不是「执行环境磁盘上有什么」。
pub fn session_span(times: impl IntoIterator<Item = i64>) -> Option<TimeSpan> {
    let mut iter = times.into_iter().map(to_epoch_ms);
    let first = iter.next()?;
    let mut start_ms = first;
    let mut end_ms = first;
    for value in iter {
        start_ms = start_ms.min(value);
        end_ms = end_ms.max(value);
    }
    Some(TimeSpan { start_ms, end_ms })
}

/// 调用指纹 = 工具名 + 规范化参数（`workflow_events.invocation_fingerprint`）。
///
/// 此前各执行环境只编码工具名，「同一调用重复失败」退化成「同一工具失败过两次」
/// ——真机 claude 的 119 组「重复失败」里多数是不同命令。参数经
/// `canonical_json` 规范化（键序无关）后只以哈希出现；缺参数时退回工具名级，
/// 不编造区分度。`harness_tag` 是指纹命名空间（不同执行环境的同名工具不互相碰撞）。
pub fn invocation_fingerprint(harness_tag: &str, name: &str, args: Option<&Value>) -> String {
    match args {
        Some(args) if !args.is_null() => {
            let mut canonical = String::new();
            canonical_json(args, &mut canonical);
            fingerprint(&format!("{harness_tag}-tool:{name}:{canonical}"))
        }
        _ => fingerprint(&format!("{harness_tag}-tool:{name}")),
    }
}

/// 模型切换：同一会话里，本次调用的模型与上一次**已知**模型不同。首个模型
/// 不算切换；缺模型的记录不打断比较（不把「没写模型」当成换了模型）。
#[derive(Clone, Debug, Default)]
pub struct ModelSwitchTracker {
    previous: Option<String>,
}

impl ModelSwitchTracker {
    /// 观察一次模型；返回 `true` 表示发生了切换。
    pub fn observe(&mut self, model: &str) -> bool {
        let switched = self.previous.as_deref().is_some_and(|previous| previous != model);
        self.previous = Some(model.to_string());
        switched
    }
}

/// 执行环境把一条用户侧原生记录翻译成的回合信号。什么算「新请求」是 wire 知识
/// （归执行环境）；信号怎么变成回合边界是语义（归本模块）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserTurnSignal {
    /// 用户向助手提的新请求：开新回合。
    Request,
    /// 用户中断当前回合：当前回合记为已取消（每回合至多一次）。
    Interrupt,
    /// 其余（执行环境回灌、注入、工具结果……）：不影响回合。
    Other,
}

/// 回合状态机的一步输出。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnTransition {
    /// 开了一个新回合（`first` = 会话的第一个回合）。
    Opened { first: bool },
    /// 当前回合被取消。
    Cancelled,
    None,
}

/// 回合 = 从一个 `Request` 到下一个 `Request` 之前（SESSION_TRACE_DIAGNOSTICS_SPEC §4）。
/// 会话第一个 `Request` 之前的中断不属于任何回合。
#[derive(Clone, Debug, Default)]
pub struct TurnTracker {
    turns: usize,
    cancelled: bool,
}

impl TurnTracker {
    pub fn observe(&mut self, signal: UserTurnSignal) -> TurnTransition {
        match signal {
            UserTurnSignal::Request => {
                self.turns += 1;
                self.cancelled = false;
                TurnTransition::Opened { first: self.turns == 1 }
            }
            UserTurnSignal::Interrupt if self.turns > 0 && !self.cancelled => {
                self.cancelled = true;
                TurnTransition::Cancelled
            }
            _ => TurnTransition::None,
        }
    }
    /// 已开过的回合数。
    pub fn turns(&self) -> usize {
        self.turns
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// **D2 是这段代码最要紧的一条**：没有记录时必须是 `None`，
    /// 绝不能是 `(0,0)`——后者会被日桶/时间窗读成 1970-01-01。
    /// 本仓已经因为"把缺失渲染成零"栽过（`issue_instances` 的 1970 日桶）。
    #[test]
    fn no_records_yields_none_not_zero_span() {
        assert_eq!(session_span(std::iter::empty()), None);
        assert_eq!(session_span(Vec::<i64>::new()), None);
    }

    /// 单条记录 → `start == end`（合法："这一刻有记录"），不是 None。
    #[test]
    fn single_record_gives_a_zero_length_span() {
        let span = session_span([1_788_449_204i64]).expect("span");
        assert_eq!(span.start_ms, 1_788_449_204_000);
        assert_eq!(span.end_ms, span.start_ms);
    }

    /// 真机取值：Claude 的 `parse_iso` 出**秒**，DSH 出**毫秒**。
    /// 归一后必须同量级——这是 D3。
    #[test]
    fn seconds_and_milliseconds_normalize_to_the_same_magnitude() {
        let claude = session_span([1_788_449_204i64]).expect("claude");
        let dsh = session_span([1_789_132_709_000i64]).expect("dsh");
        assert!(claude.start_ms >= 100_000_000_000, "秒级输入必须被放大到毫秒");
        assert!(dsh.start_ms >= 100_000_000_000);
        let gap = (dsh.start_ms - claude.start_ms).abs();
        assert!(gap < 90 * 86_400_000, "归一后应落在同一季度内，实际差 {gap}ms");
    }

    /// min/max 取对，且 `start <= end` 恒成立（防取反）。
    #[test]
    fn start_is_min_and_end_is_max_regardless_of_input_order() {
        let times = [1_788_449_300_000i64, 1_788_449_100_000, 1_788_449_200_000];
        let span = session_span(times).expect("span");
        assert_eq!(span.start_ms, 1_788_449_100_000);
        assert_eq!(span.end_ms, 1_788_449_300_000);
        assert!(span.start_ms <= span.end_ms);
        // 逆序输入结果相同
        let reversed = session_span([1_788_449_200_000i64, 1_788_449_100_000, 1_788_449_300_000]).expect("span");
        assert_eq!(reversed.start_ms, span.start_ms);
        assert_eq!(reversed.end_ms, span.end_ms);
    }

    #[test]
    fn invocation_fingerprint_is_key_order_independent_and_argument_sensitive() {
        let a = invocation_fingerprint("claude", "Bash", Some(&json!({"command": "npm test", "timeout": 5})));
        let b = invocation_fingerprint("claude", "Bash", Some(&json!({"timeout": 5, "command": "npm test"})));
        let c = invocation_fingerprint("claude", "Bash", Some(&json!({"command": "ls"})));
        let other_harness = invocation_fingerprint("codex", "Bash", Some(&json!({"command": "npm test", "timeout": 5})));
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, other_harness, "执行环境命名空间隔离");
        assert!(!a.contains("npm"), "指纹不携带参数原文");
        assert_eq!(
            invocation_fingerprint("codex", "bash", None),
            fingerprint("codex-tool:bash"),
            "缺参数退回工具名级（与历史指纹一致）"
        );
    }

    #[test]
    fn model_switch_ignores_the_first_model_and_repeats() {
        let mut t = ModelSwitchTracker::default();
        assert!(!t.observe("a"));
        assert!(!t.observe("a"));
        assert!(t.observe("b"));
        assert!(!t.observe("b"));
    }

    #[test]
    fn turn_tracker_cancels_at_most_once_per_turn_and_never_before_the_first() {
        let mut t = TurnTracker::default();
        assert_eq!(t.observe(UserTurnSignal::Interrupt), TurnTransition::None, "首回合之前的中断不属于任何回合");
        assert_eq!(t.observe(UserTurnSignal::Request), TurnTransition::Opened { first: true });
        assert_eq!(t.observe(UserTurnSignal::Other), TurnTransition::None);
        assert_eq!(t.observe(UserTurnSignal::Interrupt), TurnTransition::Cancelled);
        assert_eq!(t.observe(UserTurnSignal::Interrupt), TurnTransition::None);
        assert_eq!(t.observe(UserTurnSignal::Request), TurnTransition::Opened { first: false });
        assert_eq!(t.observe(UserTurnSignal::Interrupt), TurnTransition::Cancelled);
        assert_eq!(t.turns(), 2);
    }

    #[test]
    fn outcome_maps_to_the_closed_vocabulary() {
        assert_eq!(outcome(Some("Completed"), false), "succeeded");
        assert_eq!(outcome(Some("aborted"), false), "cancelled");
        assert_eq!(outcome(Some("weird"), false), "unknown");
        assert_eq!(outcome(Some("ok"), true), "failed");
    }
}
