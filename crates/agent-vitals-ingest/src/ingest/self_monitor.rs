//! 自看护（`docs/EVENT_PROCESSING_AND_OBSERVABILITY_REVIEW.md` P4，G5）。
//!
//! 2026-09-22 的 CPU 风暴事故里，进程烧了 ~3 核持续到人工发现——托盘自己不知道，
//! UI 也看不到。这个模块是那条缺口的补丁：读自身累计 CPU 占用，超阈值持续一段
//! 时间就记一条 warn 并把 watcher 触发的同步冷却指数拉长，CPU 掉回来再收回基线。
//!
//! **读 CPU 用 POSIX `getrusage`，不是 macOS 专属的 `proc_pidinfo`**——两者都能
//! 拿到自身累计 CPU 时间，前者是标准 API、`libc` crate 直接有绑定、Linux 也覆盖；
//! 后者是 mach 层 API，多绑一层平台特有代码换不来更多信息。`getrusage(RUSAGE_SELF)`
//! 汇总的是**整个进程**（所有线程）的累计用户态+内核态时间——两次采样的差值除以
//! 墙钟差值就是「这段时间平均用了多少个核」，乘 100 就是与本次事故复盘同一口径
//! 的百分比（六线程各自 ~75% ≈ 284%，不是单核封顶的 100%）。
//!
//! **纯状态机 + 注入式采样**：`SelfMonitor::step` 只吃 `(cpu_pct, now: Instant)`，
//! 不自己读时钟也不自己读 rusage——与 `watcher_cooldown_remaining` 同一测试哲学，
//! 真实采样（`process_cpu_time_ns`）是唯一的 I/O 边界，被注入到调用方（desktop
//! 的健康巡检循环）而不是烧进状态机里。

use std::time::{Duration, Instant};

/// 触发节流的 CPU 占用率阈值（进程整体，多线程口径）。REVIEW P4 原文的 50%——
/// 真机基线是空闲 0%、正常活跃 ~8%，事故峰值 284%，50% 留了足够余量不会在正常
/// 使用中误报，又远低于事故量级，能在真正失控前介入。
pub const CPU_THROTTLE_THRESHOLD_PCT: f64 = 50.0;

/// 阈值之上要连续「撑」多久才算「持续」，不是一次瞬时尖峰。
pub const SUSTAIN: Duration = Duration::from_secs(30);

/// 阈值之下要连续多久才认为已经恢复正常、把冷却收回基线——同一个常量复用给
/// 「回落判定」，避免在阈值边界来回跳（flapping）时反复加倍/收回。
pub const RECOVERY_SUSTAIN: Duration = SUSTAIN;

/// 冷却基线——与 `watch::WATCHER_SYNC_COOLDOWN` 数值同步（真机 2026-09-22 验收
/// 定的 30s），节流状态机从这个值开始翻倍。
pub const COOLDOWN_BASE: Duration = Duration::from_secs(30);

/// 冷却上限（REVIEW P4：指数退避，上限 5 分钟）。
pub const COOLDOWN_MAX: Duration = Duration::from_secs(300);

/// 一次 `step` 造成的状态跳变——调用方只在这两种情形下才记日志/发事件，其余
/// `Unchanged` 静默（否则 2s 一次的巡检本身就会变成新的噪音源）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    Unchanged,
    /// 冷却被拉长了一档（可能是从基线首次进入节流，也可能是已节流状态下再次加倍）。
    Escalated,
    /// 冷却收回基线——不再节流。
    Recovered,
}

/// 节流状态机。`cooldown() > COOLDOWN_BASE` 等价于「当前处于节流态」，不另外
/// 存一个 bool——两者不可能不同步，存两份就是给自己留一个会漂移的 bug。
#[derive(Debug)]
pub struct SelfMonitor {
    /// 当前连续处于阈值之上的起点；`None` = 当前不在阈值之上（或还没采过样）。
    high_since: Option<Instant>,
    /// 已节流状态下，当前连续处于阈值之下的起点；`None` = 当前不在阈值之下、
    /// 或本来就没节流（未节流时不追踪这个，省一次无意义的计时）。
    low_since: Option<Instant>,
    /// 上一次加倍冷却的时刻——同一个 30s 高位窗口内不会重复加倍；窗口过了才
    /// 允许再翻一倍。`None` 表示还没加倍过（当前在基线）。
    last_escalation_at: Option<Instant>,
    cooldown: Duration,
}

impl Default for SelfMonitor {
    fn default() -> Self {
        Self { high_since: None, low_since: None, last_escalation_at: None, cooldown: COOLDOWN_BASE }
    }
}

impl SelfMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cooldown(&self) -> Duration {
        self.cooldown
    }

    pub fn is_throttled(&self) -> bool {
        self.cooldown > COOLDOWN_BASE
    }

    /// 喂一次 CPU 采样。`cpu_pct` 可能 > 100（多线程进程的合计口径，见模块头）。
    pub fn step(&mut self, cpu_pct: f64, now: Instant) -> Transition {
        if cpu_pct >= CPU_THROTTLE_THRESHOLD_PCT {
            self.low_since = None;
            let since = *self.high_since.get_or_insert(now);
            let sustained_enough = now.duration_since(since) >= SUSTAIN;
            let window_elapsed = self
                .last_escalation_at
                .map(|t| now.duration_since(t) >= SUSTAIN)
                .unwrap_or(true);
            if sustained_enough && window_elapsed && self.cooldown < COOLDOWN_MAX {
                self.cooldown = (self.cooldown * 2).min(COOLDOWN_MAX);
                self.last_escalation_at = Some(now);
                // 重新起算：加倍之后，要再撑满一个 SUSTAIN 窗口才可能再加倍——
                // `last_escalation_at` 已经担了这个职责，这里不清 `high_since`，
                // 因为「还在阈值之上」这件事本身没有中断，没理由假装重新开始。
                return Transition::Escalated;
            }
            Transition::Unchanged
        } else {
            self.high_since = None;
            if self.cooldown == COOLDOWN_BASE {
                // 本来就没节流，不用管「低位持续多久」——没什么好恢复的。
                self.low_since = None;
                return Transition::Unchanged;
            }
            let since = *self.low_since.get_or_insert(now);
            if now.duration_since(since) >= RECOVERY_SUSTAIN {
                self.cooldown = COOLDOWN_BASE;
                self.low_since = None;
                self.last_escalation_at = None;
                return Transition::Recovered;
            }
            Transition::Unchanged
        }
    }
}

/// 两次 `process_cpu_time_ns()` 采样之间的 CPU 占用率。纯函数——两个时间戳与
/// 两个纳秒计数进，一个百分比出，真实采样值和合成测试值走同一条路径。
pub fn cpu_percent(prev_cpu_ns: u64, prev_wall: Instant, cur_cpu_ns: u64, cur_wall: Instant) -> f64 {
    let wall_ns = cur_wall.saturating_duration_since(prev_wall).as_nanos().max(1) as f64;
    let cpu_ns = cur_cpu_ns.saturating_sub(prev_cpu_ns) as f64;
    (cpu_ns / wall_ns) * 100.0
}

/// 读本进程累计 CPU 时间（用户态+内核态，纳秒）——POSIX `getrusage(RUSAGE_SELF)`。
/// 失败/不支持的平台返回 `None`，调用方跳过这一轮采样（不拿 0 冒充，0 会被
/// 误读成「CPU 占用骤降」）。
#[cfg(unix)]
pub fn process_cpu_time_ns() -> Option<u64> {
    // SAFETY：`rusage` 是纯数据结构（无指针/生命周期），`getrusage` 只写它给的
    // 那块内存；`zeroed()` 起手是 libc crate 文档推荐的初始化方式。
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0;
    if !ok {
        return None;
    }
    let user_ns = (usage.ru_utime.tv_sec as u64).saturating_mul(1_000_000_000)
        + (usage.ru_utime.tv_usec as u64).saturating_mul(1_000);
    let sys_ns = (usage.ru_stime.tv_sec as u64).saturating_mul(1_000_000_000)
        + (usage.ru_stime.tv_usec as u64).saturating_mul(1_000);
    Some(user_ns.saturating_add(sys_ns))
}

#[cfg(not(unix))]
pub fn process_cpu_time_ns() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    #[test]
    fn stays_at_baseline_under_threshold() {
        let base = Instant::now();
        let mut m = SelfMonitor::new();
        for s in 0..120 {
            assert_eq!(m.step(20.0, t(base, s)), Transition::Unchanged);
        }
        assert_eq!(m.cooldown(), COOLDOWN_BASE);
        assert!(!m.is_throttled());
    }

    #[test]
    fn brief_spike_under_sustain_does_not_escalate() {
        let base = Instant::now();
        let mut m = SelfMonitor::new();
        assert_eq!(m.step(90.0, t(base, 0)), Transition::Unchanged);
        assert_eq!(m.step(90.0, t(base, 10)), Transition::Unchanged);
        // 撑不满 30s 就跌回去：不该有任何跳变，冷却纹丝不动。
        assert_eq!(m.step(10.0, t(base, 15)), Transition::Unchanged);
        assert_eq!(m.cooldown(), COOLDOWN_BASE);
    }

    #[test]
    fn sustained_high_cpu_escalates_and_then_recovers() {
        let base = Instant::now();
        let mut m = SelfMonitor::new();
        assert_eq!(m.step(80.0, t(base, 0)), Transition::Unchanged);
        // 撑到第 30s：首次加倍，30s → 60s。
        assert_eq!(m.step(80.0, t(base, 30)), Transition::Escalated);
        assert_eq!(m.cooldown(), Duration::from_secs(60));
        assert!(m.is_throttled());
        // 同一个 30s 窗口内不重复加倍。
        assert_eq!(m.step(80.0, t(base, 35)), Transition::Unchanged);
        assert_eq!(m.cooldown(), Duration::from_secs(60));
        // 再撑满一个窗口：再加倍，60s → 120s。
        assert_eq!(m.step(80.0, t(base, 60)), Transition::Escalated);
        assert_eq!(m.cooldown(), Duration::from_secs(120));
        // 跌破阈值但还没撑满 RECOVERY_SUSTAIN：不恢复。
        assert_eq!(m.step(5.0, t(base, 70)), Transition::Unchanged);
        assert_eq!(m.cooldown(), Duration::from_secs(120));
        // 低位撑满：收回基线。
        assert_eq!(m.step(5.0, t(base, 100)), Transition::Recovered);
        assert_eq!(m.cooldown(), COOLDOWN_BASE);
        assert!(!m.is_throttled());
    }

    #[test]
    fn escalation_caps_at_five_minutes() {
        let base = Instant::now();
        let mut m = SelfMonitor::new();
        let mut clock = 0u64;
        m.step(90.0, t(base, clock));
        // 30s(→60) → 60s(→120) → 90s(→240) → 120s(→300，封顶) → 150s(仍 300，不再变化)。
        for _ in 0..5 {
            clock += 30;
            m.step(90.0, t(base, clock));
        }
        assert_eq!(m.cooldown(), COOLDOWN_MAX);
        clock += 30;
        assert_eq!(m.step(90.0, t(base, clock)), Transition::Unchanged, "capped: no further escalation to report");
        assert_eq!(m.cooldown(), COOLDOWN_MAX);
    }

    #[test]
    fn recovery_dip_that_goes_back_high_resets_the_recovery_timer() {
        let base = Instant::now();
        let mut m = SelfMonitor::new();
        m.step(90.0, t(base, 0));
        m.step(90.0, t(base, 30)); // escalate to 60s
        assert!(m.is_throttled());
        m.step(5.0, t(base, 40));  // dip starts
        m.step(5.0, t(base, 55));  // 15s into the dip — not yet recovered
        // 回到阈值之上：低位计时器必须被打断，不能让「后面再跌破」直接借用
        // 这次已经攒了 15s 的低位时长。
        m.step(90.0, t(base, 56));
        assert!(m.is_throttled(), "a return to high CPU must not let recovery slip through");
        m.step(5.0, t(base, 57));
        // 从 t=57 重新起算，撑到 t=87 才够 30s——t=80 时还不够。
        assert_eq!(m.step(5.0, t(base, 80)), Transition::Unchanged);
        assert!(m.is_throttled());
        assert_eq!(m.step(5.0, t(base, 87)), Transition::Recovered);
    }

    #[test]
    fn cpu_percent_is_cumulative_cpu_over_wall_time() {
        let base = Instant::now();
        // 1 秒墙钟内用了 0.5 秒 CPU（一个核一半时间）→ 50%。
        assert!((cpu_percent(0, base, 500_000_000, t(base, 1)) - 50.0).abs() < 0.01);
        // 1 秒墙钟内六个线程各用满 → 600%（本次事故的口径，不是单核封顶）。
        assert!((cpu_percent(0, base, 6_000_000_000, t(base, 1)) - 600.0).abs() < 0.01);
    }

    #[test]
    fn cpu_percent_never_divides_by_zero_wall_time() {
        let base = Instant::now();
        // 同一时刻两次采样（理论上不该发生，但注入式函数不能因为墙钟差为 0 而 panic）。
        let pct = cpu_percent(0, base, 1_000_000, base);
        assert!(pct.is_finite());
    }

    #[cfg(unix)]
    #[test]
    fn process_cpu_time_ns_returns_a_plausible_value() {
        // 真实 syscall：只断言「读得到、非零、且两次调用之间不减少」（CPU 时间
        // 单调不减是 POSIX 保证），不断言具体数值（机器相关）。
        let a = process_cpu_time_ns().expect("getrusage must succeed on unix");
        // 烧一点真实 CPU，让第二次读数有把握前进。
        let mut acc: u64 = 0;
        for i in 0..5_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        std::hint::black_box(acc);
        let b = process_cpu_time_ns().expect("getrusage must succeed on unix");
        assert!(b >= a);
    }
}
