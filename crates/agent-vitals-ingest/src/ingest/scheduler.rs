//! 同步 tick 调度状态机（W3 第 2 步：从桌面 `lib.rs::start_refresh_tick` 下沉）。
//!
//! 为什么下沉：这套轻/重决策、防饥饿、托盘节流、唤醒冷却的规则此前只活在 Tauri 的
//! 线程闭包里，只能打成 `.app` 验证——LIGHT-PATH spec 的几条验收（「锁被占时不丢
//! 执行环境集合」「升级重 tick 要推进防饥饿时钟」「轻 tick 满额强制重」）没有一条能写
//! 单元测试。这里是纯状态机：时间由调用方传入 `now`，不读时钟、不起线程、不碰 UI；
//! 桌面只负责线程、锁、等待唤醒和把结果转成界面事件。规则与原闭包逐条等价。

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use super::watch::TickKind;

#[derive(Debug, Clone, Copy)]
pub struct SchedulerConfig {
    /// 重 tick 周期（全执行环境对账的兜底间隔）。
    pub tick_period: Duration,
    /// 连续轻 tick 达到该次数即强制重 tick（防饥饿，与周期到期谁先到算谁）。
    pub light_ticks_per_heavy: u32,
    /// 轻 tick 里托盘重建的最小间隔。
    pub tray_refresh_interval: Duration,
}

/// 调度器给出的本轮计划。
#[derive(Debug)]
pub struct PlannedTick {
    pub kind: TickKind,
    /// 仅对轻 tick 有意义：距上次托盘重建已满 `tray_refresh_interval`。
    pub tray_due: bool,
}

/// 轻 tick 的执行结果（重 tick 没有需要回报的分支）。
#[derive(Debug, Clone, Copy, Default)]
pub struct LightOutcome {
    /// 本轮是否重建了托盘（推进托盘节流钟）。
    pub tray_refreshed: bool,
    /// 轻路径失败、实际升级跑了全量重 tick（推进防饥饿时钟）。
    pub escalated: bool,
}

#[derive(Debug)]
pub struct TickScheduler {
    cfg: SchedulerConfig,
    light_run: u32,
    last_heavy: Instant,
    last_tray: Instant,
    last_sync_finished: Instant,
    /// 上一次唤醒带来的待同步执行环境；None = 下一轮走重 tick。
    pending: Option<BTreeSet<String>>,
}

impl TickScheduler {
    /// 启动时刻作为各时钟基线（原闭包同款：启动后的第一轮是重 tick，因为 pending 为空）。
    pub fn new(cfg: SchedulerConfig, now: Instant) -> Self {
        Self { cfg, light_run: 0, last_heavy: now, last_tray: now, last_sync_finished: now, pending: None }
    }

    /// 拿到同步锁之后调用：决定本轮跑什么。**只有这里消费 pending**——锁被占时调用方
    /// 不调这个函数，执行环境集合保留到下一次（LIGHT-PATH 验收 #3：否则重试轮退化成重 tick）。
    /// 重 tick 到期时 pending 一并丢弃（全量对账已覆盖）。
    pub fn plan(&mut self, now: Instant) -> PlannedTick {
        let heavy_due = self.light_run >= self.cfg.light_ticks_per_heavy
            || now.duration_since(self.last_heavy) >= self.cfg.tick_period;
        let kind = match self.pending.take() {
            Some(harnesses) if !heavy_due => TickKind::Light(harnesses),
            _ => TickKind::Heavy,
        };
        let tray_due = now.duration_since(self.last_tray) >= self.cfg.tray_refresh_interval;
        PlannedTick { kind, tray_due }
    }

    /// 重 tick 跑完。
    pub fn heavy_finished(&mut self, now: Instant) {
        self.last_heavy = now;
        self.last_tray = now;
        self.light_run = 0;
        self.last_sync_finished = now;
    }

    /// 轻 tick 跑完。升级过重 tick 的，防饥饿时钟同步推进（验收 #4：否则 light_run
    /// 失真、重 tick 被推迟）。
    pub fn light_finished(&mut self, outcome: LightOutcome, now: Instant) {
        if outcome.escalated {
            self.last_heavy = now;
            self.last_tray = now;
            self.light_run = 0;
        } else {
            if outcome.tray_refreshed {
                self.last_tray = now;
            }
            self.light_run += 1;
        }
        self.last_sync_finished = now;
    }

    /// watcher 唤醒：记下执行环境集合（覆盖上一批——wait 每次取走槽里的全部），返回
    /// 下一轮执行前还需等待的冷却（睡满剩余冷却再执行，不丢弃最后一批写入）。
    pub fn woken(&mut self, harnesses: BTreeSet<String>, cooldown: Duration, now: Instant) -> Option<Duration> {
        self.pending = Some(harnesses);
        super::watch::cooldown_remaining_with(cooldown, self.last_sync_finished, now)
    }

    pub fn pending(&self) -> Option<&BTreeSet<String>> {
        self.pending.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: SchedulerConfig = SchedulerConfig {
        tick_period: Duration::from_secs(300),
        light_ticks_per_heavy: 3,
        tray_refresh_interval: Duration::from_secs(300),
    };

    fn harnesses(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|h| h.to_string()).collect()
    }

    fn is_light(kind: &TickKind, expected: &[&str]) -> bool {
        matches!(kind, TickKind::Light(set) if *set == harnesses(expected))
    }

    #[test]
    fn first_tick_is_heavy_and_wake_makes_the_next_one_light() {
        let t0 = Instant::now();
        let mut s = TickScheduler::new(CFG, t0);
        assert!(matches!(s.plan(t0).kind, TickKind::Heavy), "启动首轮无 pending → 重");
        s.heavy_finished(t0);
        s.woken(harnesses(&["codex"]), Duration::ZERO, t0 + Duration::from_secs(1));
        let plan = s.plan(t0 + Duration::from_secs(2));
        assert!(is_light(&plan.kind, &["codex"]));
        assert!(s.pending().is_none(), "plan 消费 pending");
    }

    /// 验收 #3：锁被占时调用方不调 plan，执行环境集合必须留到下一次，而不是退化成重 tick。
    #[test]
    fn pending_survives_until_plan_is_called() {
        let t0 = Instant::now();
        let mut s = TickScheduler::new(CFG, t0);
        s.heavy_finished(t0);
        s.woken(harnesses(&["dsh"]), Duration::ZERO, t0);
        // （锁被占：这里没有 plan 调用）
        assert_eq!(s.pending(), Some(&harnesses(&["dsh"])));
        assert!(is_light(&s.plan(t0 + Duration::from_secs(5)).kind, &["dsh"]));
    }

    #[test]
    fn light_ticks_escalate_to_heavy_after_the_budget() {
        let t0 = Instant::now();
        let mut s = TickScheduler::new(CFG, t0);
        s.heavy_finished(t0);
        for i in 0..CFG.light_ticks_per_heavy {
            let now = t0 + Duration::from_secs(10 * (i as u64 + 1));
            s.woken(harnesses(&["codex"]), Duration::ZERO, now);
            assert!(is_light(&s.plan(now).kind, &["codex"]), "第 {i} 轮仍轻");
            s.light_finished(LightOutcome::default(), now);
        }
        let now = t0 + Duration::from_secs(100);
        s.woken(harnesses(&["codex"]), Duration::ZERO, now);
        assert!(matches!(s.plan(now).kind, TickKind::Heavy), "轻 tick 满额 → 强制重（防饥饿）");
        assert!(s.pending().is_none(), "重 tick 覆盖全量，pending 丢弃");
    }

    #[test]
    fn tick_period_forces_heavy_even_with_pending() {
        let t0 = Instant::now();
        let mut s = TickScheduler::new(CFG, t0);
        s.heavy_finished(t0);
        let later = t0 + CFG.tick_period;
        s.woken(harnesses(&["codex"]), Duration::ZERO, later);
        assert!(matches!(s.plan(later).kind, TickKind::Heavy));
    }

    /// 验收 #4：轻路径失败升级成重 tick → 防饥饿时钟与轻计数一起复位。
    #[test]
    fn escalated_light_tick_resets_starvation_clock() {
        let t0 = Instant::now();
        let mut s = TickScheduler::new(CFG, t0);
        s.heavy_finished(t0);
        let t1 = t0 + Duration::from_secs(290);
        s.woken(harnesses(&["codex"]), Duration::ZERO, t1);
        assert!(is_light(&s.plan(t1).kind, &["codex"]));
        s.light_finished(LightOutcome { tray_refreshed: true, escalated: true }, t1);
        // 若没复位，t0+300 就到期成重；复位后到 t1+300 才到期。
        let t2 = t0 + Duration::from_secs(310);
        s.woken(harnesses(&["codex"]), Duration::ZERO, t2);
        assert!(is_light(&s.plan(t2).kind, &["codex"]));
    }

    #[test]
    fn tray_due_follows_the_refresh_interval() {
        let t0 = Instant::now();
        let mut s = TickScheduler::new(CFG, t0);
        s.heavy_finished(t0);
        let t1 = t0 + Duration::from_secs(60);
        s.woken(harnesses(&["codex"]), Duration::ZERO, t1);
        assert!(!s.plan(t1).tray_due, "距上次托盘重建未满间隔");
        s.light_finished(LightOutcome::default(), t1);
        let t2 = t0 + CFG.tray_refresh_interval;
        s.woken(harnesses(&["codex"]), Duration::ZERO, t2);
        let plan = s.plan(t2);
        assert!(plan.tray_due);
        s.light_finished(LightOutcome { tray_refreshed: true, escalated: false }, t2);
        let t3 = t2 + Duration::from_secs(10);
        s.woken(harnesses(&["codex"]), Duration::ZERO, t3);
        assert!(!s.plan(t3).tray_due, "托盘刚重建过 → 节流钟推进");
    }

    #[test]
    fn wake_returns_remaining_cooldown_since_last_sync() {
        let t0 = Instant::now();
        let mut s = TickScheduler::new(CFG, t0);
        s.heavy_finished(t0);
        let cooldown = Duration::from_secs(30);
        assert_eq!(s.woken(harnesses(&["codex"]), cooldown, t0 + Duration::from_secs(10)), Some(Duration::from_secs(20)));
        assert_eq!(s.woken(harnesses(&["codex"]), cooldown, t0 + Duration::from_secs(40)), None);
    }
}
