//! Claude Pro 的窗口状态读取器：`quotaLimits`。
//!
//! **为什么需要它**：决策卡里 Codex 那一行有正向余量（rollout 的 `rate_limits`
//! → `used_percent`），Claude Pro 一直是前端硬编码的一句「无法读取剩余额度」。
//! 真机核对（2026-09-14，249 个会话文件 / 757MB）后确认数据的真实边界：
//!
//! - **永远没有正向余量**。全部 42 条 `quotaLimits` 事件都是 `status:"rejected"`，
//!   字段里不存在 `used_percent` —— Claude Code 只在**被拒绝的那一刻**写这条记录。
//!   所以「剩余 X%」是编的，不得显示（`ROUTE_UNIT_COST_DECISION_SPEC` §8.3.2）。
//! - **重置时刻是有的**。42 条**全部**带 `resetsAt`（Unix 秒）与 `rateLimitType`
//!   （`five_hour` 38 条 / `seven_day` 4 条）。据此能给出三态里唯一有证据的那一态：
//!   `exhausted until R` →「已耗尽 · HH:MM 重置」。此前仓库里**没有任何**读取器
//!   （唯一的 `resets_at` 读取器是 Codex 的），所以那句话不是"数据读不到"，是"没接"。
//!
//! **扫描窗口为什么是 7 天**：`seven_day` 是最长的窗口。若最近的拒绝事件早于 7 天，
//! 则五小时窗与七天窗都早已重置——那时状态本就该是 `unknown`，再往前扫不会改变
//! 结论。7 天同时把扫描量从 757MB 压到 ~175MB（真机实测：近 7 天 175MB / 近 2 天
//! 79MB / 全部 757MB），且每行先做一次 `contains` 预筛，只有命中行才进 JSON 解析。
//!
//! **不碰 facts 的字节等价面**：本模块与 `usage_fact.rs` 的 emitter 完全独立——
//! 那条 Python↔Rust 逐字节锁步钉的是 UsageFact 事实行，窗口状态是旁路，不进那条链。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 只读最近这些天内改动过的会话文件（理由见模块 doc）。
pub const QUOTA_SCAN_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// `rateLimitType` 的已知取值。未知值照样保存（前向兼容），但状态机会拒绝它。
const WINDOW_FIVE_HOUR: &str = "five_hour";
const WINDOW_SEVEN_DAY: &str = "seven_day";

/// 已由本模块校验的窗口状态快照。
///
/// `status` 只有 `"rejected"` 是已观察到的取值；未知状态**不产出快照**（宁可不显示，
/// 也不猜一个「还剩多少」）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeQuotaSnapshot {
    /// 事件时刻（原始 RFC3339 字符串，与执行环境日志逐字一致）。
    pub observed_at: String,
    /// 该时刻的 Unix 秒——用于跨文件比「哪条更新」。
    pub observed_at_secs: i64,
    /// 窗口重置时刻（Unix 秒）。三态里 `exhausted until R` 的 R。
    pub resets_at: i64,
    /// `five_hour` / `seven_day`。
    pub rate_limit_type: String,
    pub is_using_overage: bool,
    pub unified_rate_limit_fallback_available: bool,
    pub overage_disabled_reason: Option<String>,
}

impl ClaudeQuotaSnapshot {
    /// 落库用的 payload。键名与执行环境字段同形（`resets_at` 用蛇形，与 Codex 的
    /// 快照约定一致），并保留两个 overage 字段供排障——它们是**证据**，不是结论。
    pub fn payload_json(&self) -> String {
        json!({
            "status": "rejected",
            "resets_at": self.resets_at,
            "rate_limit_type": self.rate_limit_type,
            "observed_at": self.observed_at,
            "is_using_overage": self.is_using_overage,
            "unified_rate_limit_fallback_available": self.unified_rate_limit_fallback_available,
            "overage_disabled_reason": self.overage_disabled_reason,
        })
        .to_string()
    }

    /// 同 [`Self::payload_json`]，额外带上近 7 天的撞窗次数。
    pub fn payload_with_windows(&self, windows_recent: usize) -> String {
        let mut value: Value = serde_json::from_str(&self.payload_json()).unwrap_or_else(|_| json!({}));
        if let Some(obj) = value.as_object_mut() {
            obj.insert("windows_recent".into(), json!(windows_recent));
        }
        value.to_string()
    }

    /// 读回时校验（`summary::claude_quota_snapshot` 用）。
    ///
    /// 与 Codex 的 `validate_quota_snapshot` 同一纪律：**库里的东西也要当成不可信
    /// 输入**——一个半截 payload 不该让界面显示一个凭空的「重置时刻」。
    pub fn from_payload(value: &Value) -> Option<Self> {
        if value.get("status").and_then(Value::as_str) != Some("rejected") {
            return None;
        }
        let resets_at = value.get("resets_at").and_then(Value::as_i64)?;
        let rate_limit_type = value.get("rate_limit_type").and_then(Value::as_str)?;
        if !matches!(rate_limit_type, WINDOW_FIVE_HOUR | WINDOW_SEVEN_DAY) {
            // 未知窗口类型不产出快照：状态机只能解释这两个，猜一个会让「还要等多久」
            // 显示错误的时间尺度（5 小时 vs 7 天差 33 倍）。
            return None;
        }
        let observed_at = value.get("observed_at").and_then(Value::as_str)?.to_string();
        let observed_at_secs = agent_vitals_domain::budget::parse_iso(&observed_at)?.0;
        Some(Self {
            observed_at,
            observed_at_secs,
            resets_at,
            rate_limit_type: rate_limit_type.to_string(),
            is_using_overage: value.get("is_using_overage").and_then(Value::as_bool).unwrap_or(false),
            unified_rate_limit_fallback_available: value
                .get("unified_rate_limit_fallback_available")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            overage_disabled_reason: value
                .get("overage_disabled_reason")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

/// 窗口状态——`ROUTE_UNIT_COST_DECISION_SPEC` §8.3.2 的三态。
///
/// ```text
/// unknown ──(rejected, resetsAt=R)──► exhausted until R ──(now ≥ R)──► unknown
/// ```
///
/// **刻意没有 `remaining` 这一态**：数据里不存在正向读数（见模块 doc）。任何
/// 「剩余 N%」都只能是编的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowState {
    Unknown,
    Exhausted { resets_at: i64, window: &'static str },
}

/// 窗口类型 → 人类标签。**单一来源**：决策卡与待处理任务共用这套词，
/// 免得同一个窗口在两处叫出两个名字。
pub fn window_label(window: &str) -> &'static str {
    if window == WINDOW_SEVEN_DAY { "7 天窗口" } else { "5 小时窗口" }
}

/// 纯状态机：给定快照与"现在"，给出窗口状态。R 已过即回到 `unknown`——
/// **不得**因为"曾经耗尽"就显示成「已恢复 100%」或任何剩余比例。
pub fn window_state(snapshot: &ClaudeQuotaSnapshot, now_secs: i64) -> WindowState {
    if now_secs >= snapshot.resets_at {
        return WindowState::Unknown;
    }
    let window = if snapshot.rate_limit_type == WINDOW_SEVEN_DAY {
        WINDOW_SEVEN_DAY
    } else {
        WINDOW_FIVE_HOUR
    };
    WindowState::Exhausted { resets_at: snapshot.resets_at, window }
}

/// 单条 JSONL 行 → 快照（纯函数，测试直接喂字符串）。
///
/// 只认**顶层** `quotaLimits`（真机形状：`type:"assistant"` 的事件，`quotaLimits`
/// 与 `message` 同级）。子消息里的同名键不是这个语义，不认。
pub fn quota_snapshot_from_line(line: &str) -> Option<ClaudeQuotaSnapshot> {
    if !line.contains("\"quotaLimits\"") {
        return None; // 预筛：绝大多数行在这一步就被拒掉，不进 JSON 解析
    }
    let record: Value = serde_json::from_str(line).ok()?;
    let quota = record.get("quotaLimits")?;
    if quota.is_null() {
        return None;
    }
    // **必须显式要求 rejected**：本读取器只解释"被拒绝"这一种语义。若将来出现
    // `status:"allowed"` 之类的事件（它可能带正向余量），照 rejected 解释会把
    // "没被限流"显示成"已耗尽 · 还有 X 小时重置"——正好说反。未知语义一律不产出
    // 快照，让状态机诚实停在 `unknown`。
    if quota.get("status").and_then(Value::as_str) != Some("rejected") {
        return None;
    }
    let observed_at = record.get("timestamp").and_then(Value::as_str)?.to_string();
    let observed_at_secs = agent_vitals_domain::budget::parse_iso(&observed_at)?.0;
    let resets_at = quota.get("resetsAt").and_then(Value::as_i64)?;
    let rate_limit_type = quota.get("rateLimitType").and_then(Value::as_str)?.to_string();
    if !matches!(rate_limit_type.as_str(), WINDOW_FIVE_HOUR | WINDOW_SEVEN_DAY) {
        return None;
    }
    Some(ClaudeQuotaSnapshot {
        observed_at,
        observed_at_secs,
        resets_at,
        rate_limit_type,
        is_using_overage: quota.get("isUsingOverage").and_then(Value::as_bool).unwrap_or(false),
        unified_rate_limit_fallback_available: quota
            .get("unifiedRateLimitFallbackAvailable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        overage_disabled_reason: quota
            .get("overageDisabledReason")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// 一个文件里的全部快照（按行序；调用方自己取最新/计数）。
pub fn quota_snapshots_from_file(path: &Path) -> Vec<ClaudeQuotaSnapshot> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    let mut found = Vec::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if let Some(snapshot) = quota_snapshot_from_line(&line) {
            found.push(snapshot);
        }
    }
    found
}

/// 一次扫描的结果。
///
/// 除了最新那条快照，还要**近 7 天撞了几次窗**——`unknown` 态唯一的可显示内容
/// （spec §8.3.2：「窗口状态未知 · 本周撞窗 N 次」）。计数按 **(窗口类型, 重置时刻)**
/// 去重：同一轮限流会在多条事件里重复出现（真机 09-11 一天内同一条 10:50 窗口
/// 出现了 3 条事件），按事件数报会把"撞了 3 次窗"说成"撞了 1 次窗"的 3 倍。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuotaScan {
    pub latest: Option<ClaudeQuotaSnapshot>,
    pub windows_recent: usize,
}

/// 一次撞窗命中（REFRESH_STORM R5-F7a 缓存的原始记录）。**不含任何时间过滤**：
/// recent-floor（`now - 7 天`）在合并时按**当前**时间施加，不随缓存冻结——
/// 否则已滑出窗口的命中会被缓存一直算进 `windows_recent`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuotaWindowHit {
    pub rate_limit_type: String,
    pub resets_at: i64,
    pub observed_at_secs: i64,
}

/// 单文件的配额贡献：F7a 指纹缓存的最小单元。`latest` 不过滤（跨文件取
/// observed_at 最大），`window_hits` 全量记录（合并时按当前 floor 过滤去重）。
/// 读失败的文件 → 空贡献（不拖垮事实同步，语义与全量扫一致）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuotaFileContribution {
    pub window_hits: Vec<QuotaWindowHit>,
    pub latest: Option<ClaudeQuotaSnapshot>,
}

/// 解析单个会话文件的配额贡献（逐行，与原 `scan_claude_quota` 的单文件循环
/// 体逐字节同语义）。
pub fn quota_contribution_from_file(path: &Path) -> QuotaFileContribution {
    let mut out = QuotaFileContribution::default();
    for snapshot in quota_snapshots_from_file(path) {
        out.window_hits.push(QuotaWindowHit {
            rate_limit_type: snapshot.rate_limit_type.clone(),
            resets_at: snapshot.resets_at,
            observed_at_secs: snapshot.observed_at_secs,
        });
        if out
            .latest
            .as_ref()
            .map_or(true, |cur| snapshot.observed_at_secs >= cur.observed_at_secs)
        {
            out.latest = Some(snapshot);
        }
    }
    out
}

/// 合并各文件贡献 → `QuotaScan`（纯函数）。窗口命中按**当前** now 的 7 天
/// floor 过滤后按 (type, resets_at) 去重计数；latest 取 observed_at 最大。
pub fn scan_claude_quota_from_contributions<'a>(
    contributions: impl Iterator<Item = &'a QuotaFileContribution>,
    now: SystemTime,
) -> QuotaScan {
    let now_secs = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let recent_floor = now_secs.saturating_sub(QUOTA_SCAN_WINDOW.as_secs() as i64);
    let mut scan = QuotaScan::default();
    let mut seen_windows: std::collections::BTreeSet<(String, i64)> = std::collections::BTreeSet::new();
    for contribution in contributions {
        for hit in &contribution.window_hits {
            if hit.observed_at_secs >= recent_floor {
                seen_windows.insert((hit.rate_limit_type.clone(), hit.resets_at));
            }
        }
        if let Some(snapshot) = &contribution.latest {
            if scan
                .latest
                .as_ref()
                // `map_or(true, ..)` 而不是 `is_none_or`：后者稳定于 1.82，
                // 本 crate 的 MSRV 是 1.74（clippy::incompatible_msrv 会拦）。
                .map_or(true, |cur| snapshot.observed_at_secs >= cur.observed_at_secs)
            {
                scan.latest = Some(snapshot.clone());
            }
        }
    }
    scan.windows_recent = seen_windows.len();
    scan
}

/// 跨文件取最新：只扫 `now - QUOTA_SCAN_WINDOW` 之后改动过的文件。
///
/// 读失败的文件跳过（`None`）而不是让整轮同步失败——窗口状态是增强信息，
/// 一个读不动的会话文件不该拖垮事实同步（与 `budget_alerts` 对预算快照的态度一致）。
/// R5-F7a：内部改为「逐文件贡献 → 合并」，与缓存路径（sync_service
/// `scan_claude_quota_cached`）同一条合并语义；本函数保留为全量基准，
/// 对拍测试钉住两条路一致。
pub fn scan_claude_quota(files: &[PathBuf], now: SystemTime) -> QuotaScan {
    let cutoff = now.checked_sub(QUOTA_SCAN_WINDOW);
    let mut contributions: Vec<QuotaFileContribution> = Vec::new();
    for path in files {
        if let (Some(cutoff), Ok(meta)) = (cutoff, std::fs::metadata(path)) {
            match meta.modified() {
                Ok(modified) if modified >= cutoff => {}
                // mtime 读不到时**照扫**：宁可多读一个文件，也不要因为一个
                // 平台差异把窗口状态静默丢掉。
                Err(_) => {}
                _ => continue,
            }
        }
        contributions.push(quota_contribution_from_file(path));
    }
    scan_claude_quota_from_contributions(contributions.iter(), now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(ts: &str, resets: i64, window: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"u1","timestamp":"{ts}","quotaLimits":{{"status":"rejected","resetsAt":{resets},"unifiedRateLimitFallbackAvailable":false,"rateLimitType":"{window}","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}}}}"#
        )
    }

    #[test]
    fn parses_the_real_event_shape() {
        // 形状出处：2026-09-13 真机 ~/.claude/projects/*/*.jsonl 的 assistant 事件
        // 顶层 quotaLimits（42 条全是这一形状，全部 status:"rejected"）。
        let s = quota_snapshot_from_line(&line("2026-09-13T15:45:00.000Z", 1789339200, "five_hour"))
            .expect("真机形状必须能解析");
        assert_eq!(s.rate_limit_type, "five_hour");
        assert_eq!(s.resets_at, 1789339200);
        assert_eq!(s.observed_at, "2026-09-13T15:45:00.000Z");
        assert!(!s.is_using_overage);
        // 往返：落库 → 读回必须等值（读回是另一条不可信输入的入口）。
        let round_trip = ClaudeQuotaSnapshot::from_payload(&serde_json::from_str(&s.payload_json()).unwrap())
            .expect("自己写出的 payload 必须能读回");
        assert_eq!(round_trip, s);
    }

    #[test]
    fn rejects_rows_that_would_let_the_ui_invent_a_reset_time() {
        // 缺 resetsAt / 缺 timestamp / 未知窗口类型 → 一律不产出快照。
        // 未知窗口尤其危险：five_hour 与 seven_day 的时间尺度差 33 倍，
        // 猜错会让「还要等多久」错到没边。
        let no_resets = r#"{"type":"assistant","timestamp":"2026-09-13T15:45:00Z","quotaLimits":{"status":"rejected","rateLimitType":"five_hour"}}"#;
        assert!(quota_snapshot_from_line(no_resets).is_none());
        let no_ts = r#"{"type":"assistant","quotaLimits":{"status":"rejected","resetsAt":1,"rateLimitType":"five_hour"}}"#;
        assert!(quota_snapshot_from_line(no_ts).is_none());
        let unknown_window = line("2026-09-13T15:45:00Z", 1, "monthly");
        assert!(quota_snapshot_from_line(&unknown_window).is_none());
        // 非 rejected（若将来出现正向状态）→ 本读取器不产出，宁可不显示。
        let not_rejected = r#"{"type":"assistant","timestamp":"2026-09-13T15:45:00Z","quotaLimits":{"status":"allowed","resetsAt":1,"rateLimitType":"five_hour"}}"#;
        assert!(quota_snapshot_from_line(not_rejected).is_none());
        // 没有 quotaLimits 的普通行（绝大多数）→ 预筛直接拒。
        assert!(quota_snapshot_from_line(r#"{"type":"assistant","timestamp":"2026-09-13T15:45:00Z"}"#).is_none());
    }

    #[test]
    fn window_state_is_exhausted_until_r_then_unknown_never_a_percentage() {
        let s = quota_snapshot_from_line(&line("2026-09-13T15:45:00Z", 1000, "five_hour")).unwrap();
        assert_eq!(window_state(&s, 999), WindowState::Exhausted { resets_at: 1000, window: "five_hour" });
        // R 到点即 unknown——不得因为"曾经耗尽"回显示成"已恢复/剩余 100%"。
        assert_eq!(window_state(&s, 1000), WindowState::Unknown);
        assert_eq!(window_state(&s, 5000), WindowState::Unknown);
        // 周窗要如实标出七天尺度。
        let w = quota_snapshot_from_line(&line("2026-09-13T15:45:00Z", 1000, "seven_day")).unwrap();
        assert_eq!(window_state(&w, 999), WindowState::Exhausted { resets_at: 1000, window: "seven_day" });
    }

    #[test]
    fn scan_keeps_the_latest_observation_across_files() {
        let dir = std::env::temp_dir().join(format!("av-quota-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let older = dir.join("older.jsonl");
        let newer = dir.join("newer.jsonl");
        std::fs::write(&older, format!("{}\n", line("2026-09-11T02:19:00Z", 500, "five_hour"))).unwrap();
        std::fs::write(
            &newer,
            format!("{}\n{}\n", line("2026-09-13T15:45:00Z", 900, "five_hour"), line("2026-09-12T01:00:00Z", 600, "five_hour")),
        )
        .unwrap();
        // 文件内取最新（不是最后一行），跨文件也取最新。`now` 钉在最后一条事件之后：
        // 窗口计数按 `now − 7 天` 划界，传真实 now 会让钉死的真机日期随时钟滑出 7 天窗
        // （2026-09-18 合并当天就红了）——事件保持真机形状，判定不随日历漂移。
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_789_315_200); // 2026-09-13T16:00Z
        let scan = scan_claude_quota(&[older.clone(), newer.clone()], now);
        let got = scan.latest.expect("应取到快照");
        assert_eq!(got.observed_at, "2026-09-13T15:45:00Z");
        // 撞窗计数按 (窗口, 重置时刻) 去重：这里三条事件的 resetsAt 各不相同 → 3。
        assert_eq!(scan.windows_recent, 3, "三个不同重置时刻 = 撞了三次窗");
        // 窗口之外的文件不参与：把"最新"那个文件的时间戳压到 10 天前，只剩旧文件时
        // 仍应给出旧文件里的那条（而不是 None）——窗口筛的是文件 mtime，不是事件时刻。
        let stale = SystemTime::now() - Duration::from_secs(10 * 24 * 60 * 60);
        let _ = filetime_set(&newer, stale);
        let only_old = scan_claude_quota(std::slice::from_ref(&newer), SystemTime::now());
        assert!(only_old.latest.is_none(), "mtime 超出 7 天的文件必须被跳过");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repeated_events_for_the_same_window_count_once() {
        // 真机 09-11：同一条 10:50 重置的五小时窗被记了 3 条事件。按事件数报会把
        // "撞了 1 次窗"说成 3 次 —— 计数必须按 (窗口类型, 重置时刻) 去重。
        let dir = std::env::temp_dir().join(format!("av-quota-dedup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        std::fs::write(
            &f,
            format!(
                "{}\n{}\n{}\n{}\n",
                line("2026-09-11T02:19:00Z", 1000, "five_hour"),
                line("2026-09-11T02:19:00Z", 1000, "five_hour"),
                line("2026-09-11T06:51:00Z", 2000, "five_hour"),
                line("2026-09-11T14:47:00Z", 2000, "seven_day"),
            ),
        )
        .unwrap();
        // `now` 同样钉在最后一条事件（09-11T14:47Z）之后：四条事件恒在 7 天窗内。
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_789_156_800); // 2026-09-11T20:00Z
        let scan = scan_claude_quota(std::slice::from_ref(&f), now);
        // 同一 (five_hour, 1000) 出现两次只算一次；窗口类型不同则分开算。
        assert_eq!(scan.windows_recent, 3, "去重后应是 3 个不同窗口，不是 4 条事件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 把文件 mtime 拨到指定时刻（测试用；`File::set_modified` 稳定于 1.75）。
    fn filetime_set(path: &Path, at: SystemTime) -> std::io::Result<()> {
        let f = std::fs::OpenOptions::new().write(true).open(path)?;
        f.set_modified(at)
    }
}
