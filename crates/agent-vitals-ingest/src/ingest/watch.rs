//! P2 watcher（AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC §9-P2；方案 A
//! 2026-09-22 产品拍板，见 P2_WATCHER_PRODUCT_REVIEW.md 决策记录）。
//!
//! 形状（Vite HMR 的 watcher 位，spec §3 机制 1）：**watcher 可插拔**——
//! feature `watcher` 关闭时本模块是 NoopWatcher（Vite `createNoopWatcher`
//! 同款），tick 5min 兜底照常工作；开启时 notify（macOS FSEvents / Linux
//! inotify）文件事件经**去抖合并**后做两件事：
//!
//! 1. **唤醒 tick**：文件发现/失效判定仍由 tick 的目录 walk + 指纹对账
//!    权威完成（spec §7）。watch 事件**不直接 mark_dirty、不碰 DB**——
//!    事件只负责"早点跑对账"。这是对 spec §3-P2 原案（事件 → mark_dirty）
//!    的有意简化：walk 每 tick 本来就全量 stat（实测 ~3ms），mark_dirty
//!    需要 watcher 线程开权威库写连接，引入与 sync 事务的 SQLITE_BUSY
//!    争用面，收益为零。丢事件/合并由既有对账兜底（spec §12），正确性
//!    不依赖 watcher。
//! 2. **watch-only 消费者**：非事实面目录（skills 安装根等）注册回调，
//!    变更即失效对应缓存（如桌面 Skill 体检的进程内报告缓存）。
//!
//! 去抖是有意手搓的（超时驱动单线程，见 [`DEBOUNCE`]):突发写事件在同一
//! 窗口内合并为一次唤醒，不引入 notify-debouncer-full 依赖。路由核（
//! [`WatchRouter`] / [`Debouncer`]）是**纯函数、无 notify 依赖**——没有
//! feature 也能单测；notify 只出现在 feature 门控的适配器里。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
#[cfg(feature = "watcher")]
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

#[cfg(feature = "watcher")]
use notify::Watcher;

/// 去抖窗：最后一个事件落定后等这么久再派发（毫秒）。FSEvents 自身延迟
/// ~1s，窗口取 1.2s 吸收同批写入的多条事件；再大只会白白推迟唤醒。
pub const DEBOUNCE: Duration = Duration::from_millis(1_200);

/// 持续写入时的最长合并窗：普通情况下仍等待最后一个事件后的
/// [`DEBOUNCE`]，但日志每秒追加不能让「实时」无限退化到 5 分钟 tick。
/// 到点强制派发一次后开始下一窗；正确性仍由 tick 指纹对账保证。
pub const MAX_DEBOUNCE: Duration = Duration::from_secs(5);

/// tick 唤醒槽：watcher 去抖后 `wake_harnesses`；tick 循环用
/// `wait_for_wake(&slot, TICK_PERIOD)` 代替 sleep——事件到 → 立刻醒并拿到
/// **是哪些执行环境醒了**，没事件 → 照旧按周期醒。feature 无关（无 watcher 时
/// 没人 wake，行为与纯 sleep 完全一致）。
///
/// **带身份的合并槽（LIGHT-PATH spec §5.1，取代 HARDENING §5.1 的匿名单槽）**：
/// 槽内是 `BTreeSet<执行环境>`——持续写入的活动期里，去抖窗产出的多余唤醒把执行环境
/// **并入**集合而不是排队：同一时刻至多一批 pending 执行环境（上界 = 注册的
/// FactsSource 执行环境数，天然有界）。每次重 tick 都是全拓扑指纹对账，事件基数
/// 没有语义；执行环境身份是轻/重路由的唯一输入（LIGHT-PATH spec §5.2）。
///
/// 手写 Mutex+Condvar 而不是 `sync_channel`——通道装不下"合并后的执行环境集合"
/// （满了只能丢弃，身份就丢了），而集合本身有界，不需要通道的背压语义。
#[derive(Default)]
pub struct WakeSlot {
    inner: Mutex<SlotInner>,
    signal: std::sync::Condvar,
}

#[derive(Default)]
struct SlotInner {
    harnesses: std::collections::BTreeSet<String>,
}

#[derive(Clone)]
pub struct TickWaker {
    slot: Arc<WakeSlot>,
    /// 槽非空时到来的插入批次计数（诊断，喂健康 DTO；只留内存，
    /// HARDENING spec §5.5）。
    merged: Arc<AtomicU64>,
}

/// `wake_harnesses` 的诊断结果。调用方**不**据此分支（合并/新入对行为等价），
/// 只允许累计进程内健康计数。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum WakeOutcome {
    /// 槽此前为空——本次是 pending 的第一批执行环境。
    Queued,
    /// 槽已有 pending 执行环境——本次并入集合（或无新增）。
    Coalesced,
}

pub struct WakeChannel {
    pub waker: TickWaker,
    slot: Arc<WakeSlot>,
}

impl WakeChannel {
    /// tick 循环侧的等待句柄。
    pub fn slot(&self) -> &WakeSlot {
        &self.slot
    }

    /// 跨线程持有（tick 线程 'static 需要 Arc）。
    pub fn slot_arc(&self) -> std::sync::Arc<WakeSlot> {
        std::sync::Arc::clone(&self.slot)
    }
}

impl TickWaker {
    pub fn channel() -> WakeChannel {
        let slot = Arc::new(WakeSlot::default());
        WakeChannel {
            waker: TickWaker {
                slot: Arc::clone(&slot),
                merged: Arc::new(AtomicU64::new(0)),
            },
            slot,
        }
    }

    /// 并入一批执行环境。空集合是显式 no-op（返回 `Coalesced`，不计数、不唤醒）。
    pub fn wake_harnesses(&self, harnesses: impl IntoIterator<Item = impl AsRef<str>>) -> WakeOutcome {
        let mut guard = self.slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        let was_empty = guard.harnesses.is_empty();
        let mut inserted_any = false;
        for harness in harnesses {
            if guard.harnesses.insert(harness.as_ref().to_string()) {
                inserted_any = true;
            }
        }
        if !inserted_any {
            // 空入参或全部重复——no-op，不唤醒。诊断计数仍 +1：它数的
            // 是「返回 Coalesced 的调用次数」（槽非空时到来的唤醒量，
            // 负载信号——HARDENING §5.1 原义），不是新增插入数。
            self.merged.fetch_add(1, Ordering::Relaxed);
            return WakeOutcome::Coalesced;
        }
        if !was_empty {
            self.merged.fetch_add(1, Ordering::Relaxed);
        }
        self.slot.signal.notify_one();
        if was_empty {
            WakeOutcome::Queued
        } else {
            WakeOutcome::Coalesced
        }
    }

    /// 进程内诊断计数：槽非空时到来的插入批次（喂健康 DTO；只留内存，
    /// HARDENING spec §5.5）。
    pub fn coalesced_count(&self) -> u64 {
        self.merged.load(Ordering::Relaxed)
    }
}

/// tick 循环的一次等待结果。
#[derive(Debug, PartialEq, Eq)]
pub enum TickWait {
    /// 有执行环境被唤醒——立刻跑轻 tick，集合即待同步执行环境（LIGHT-PATH §5.2）。
    Woken(std::collections::BTreeSet<String>),
    /// 等满周期——跑重 tick。
    TimedOut,
}

/// 等 wake 或等满周期。桌面 tick 循环的唯一等待原语（可注入 helper：
/// 把「wake 时序 vs 阻塞中的 sync」的排序测试从 Tauri 应用里解放出来
/// ——HARDENING spec Phase A.3）。槽由 `Arc` 共享、无"断开"态，循环退出
/// 即进程退出，不需要旧的 SenderGone 分支。
pub fn wait_for_wake(slot: &WakeSlot, period: Duration) -> TickWait {
    let deadline = std::time::Instant::now() + period;
    let mut guard = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if !guard.harnesses.is_empty() {
            let harnesses = std::mem::take(&mut guard.harnesses);
            return TickWait::Woken(harnesses);
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return TickWait::TimedOut;
        }
        let (g, _) = slot
            .signal
            .wait_timeout(guard, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        guard = g;
    }
}

/// 一轮 tick 的类别（LIGHT-PATH spec §5.2）：`Light` 携带待同步执行环境集合
/// ——desktop 的 tick 循环据此类路由到定向同步或全量重 tick。
#[derive(Debug)]
pub enum TickKind {
    /// 全执行环境对账 + 全部投影（5 分钟周期 / 防饥饿升级 / 轻路径失败升级）。
    Heavy,
    /// 只同步集合内执行环境（唤醒驱动，秒级时延路径）。
    Light(std::collections::BTreeSet<String>),
}

/// pending 根的重试起始间隔（收敛调查 §4/P4：此前每个 1.2s 去抖超时都对
/// 不存在的目录重试挂载，macOS 上每次尝试都生灭一个 FSEventStream 线程——
/// 空闲实测 0.3% 一核的纯浪费。目录晚于启动出现是分钟级事件，秒级重试
/// 没有收益。
pub const PENDING_RETRY_BASE: Duration = Duration::from_secs(30);

/// 退避上限：目录若真会出现，5 分钟内必被看到；更久不存在的根继续等，
/// tick 指纹对账始终兜底（watcher 只是加速器）。
pub const PENDING_RETRY_MAX: Duration = Duration::from_secs(300);

/// 一个待重试的挂载根 + 它的退避计划（纯数据，双态可测）。
#[derive(Debug, Clone)]
pub struct PendingRoot {
    pub path: std::path::PathBuf,
    /// 下一次允许重试的时刻；之前到点的重试轮应跳过它。
    pub next_retry_at: std::time::Instant,
    /// 当前退避间隔（指数翻倍，封顶 [`PENDING_RETRY_MAX`]）。
    pub interval: Duration,
}

/// 重试失败后的重入队升级（纯函数，验收 #3 直测）：`try_attach` 以基线
/// 间隔把仍 NotFound 的路径 push 回 pending——本函数把该新条目的间隔恢复为
/// 上一轮的值再翻倍（30→60→120→240→300 封顶），而不是从基线重新数。
pub fn requeue_escalated(
    pending: &mut [PendingRoot],
    probe: &PendingRoot,
    now: std::time::Instant,
) {
    if let Some(requeued) = pending.iter_mut().rev().find(|p| p.path == probe.path) {
        requeued.interval = probe.interval;
        requeued.escalate(now);
    }
}

impl PendingRoot {
    pub fn new(path: std::path::PathBuf, now: std::time::Instant) -> Self {
        PendingRoot { path, next_retry_at: now + PENDING_RETRY_BASE, interval: PENDING_RETRY_BASE }
    }

    pub fn due(&self, now: std::time::Instant) -> bool {
        now >= self.next_retry_at
    }

    /// 重试失败后的升级：间隔翻倍封顶，下次尝试相应推迟。
    pub fn escalate(&mut self, now: std::time::Instant) {
        self.interval = (self.interval * 2).min(PENDING_RETRY_MAX);
        self.next_retry_at = now + self.interval;
    }
}

/// watcher 触发同步的冷却下限（真机 2026-09-22 验收教训）：活动中的 agent
/// 会话连续追加被监听目录的日志，每个去抖窗都会**合法**唤醒——若每次唤醒
/// 都执行完整 sync（进程内 overview/tray 的 SQLite 聚合 + 子进程），CPU 会被
/// 钉满（实测 ~3 核持续）。冷却窗把 watcher 触发的执行率钉到 ≤1/COOLDOWN。
/// 周期 tick 与手动同步不受影响；空闲后的第一个事件仍即时服务（彼时冷却
/// 早已过期），持续写入期间的尾批最多延迟一个冷却窗。
pub const WATCHER_SYNC_COOLDOWN: Duration = Duration::from_secs(30);

/// 冷却判定（纯函数，可单测）：watcher 唤醒到达时，距上次同步完成不足
/// 冷却窗 → 返回还需睡多久（睡满后照常执行——**不丢弃**最后一批写入）；
/// 已过窗 → None，立即执行。固定用 [`WATCHER_SYNC_COOLDOWN`] 基线——自看护
/// （`self_monitor`）需要动态冷却时走 [`cooldown_remaining_with`]。
pub fn watcher_cooldown_remaining(
    last_sync_finished_at: std::time::Instant,
    now: std::time::Instant,
) -> Option<Duration> {
    cooldown_remaining_with(WATCHER_SYNC_COOLDOWN, last_sync_finished_at, now)
}

/// 同 [`watcher_cooldown_remaining`]，冷却窗口是参数而非固定常量——自看护
/// （REVIEW P4）在持续高 CPU 时把这个值拉长（指数退避，上限 5 分钟），CPU
/// 回落后收回 [`WATCHER_SYNC_COOLDOWN`] 基线。
pub fn cooldown_remaining_with(
    cooldown: Duration,
    last_sync_finished_at: std::time::Instant,
    now: std::time::Instant,
) -> Option<Duration> {
    let elapsed = now.duration_since(last_sync_finished_at);
    cooldown.checked_sub(elapsed)
}

/// watch-only 消费者回调（watcher 线程内执行，必须快——只做内存失效）。
pub type WatchCallback = Arc<dyn Fn() + Send + Sync>;

/// 注册表：源目录（事实面，唤醒 tick）+ watch-only 目录（回调面）。
#[derive(Default)]
pub struct WatchRegistry {
    sources: Vec<(String, PathBuf)>,
    watch_only: Vec<(String, PathBuf, WatchCallback)>,
}

/// 一条注册项的路由命中。
#[derive(Debug, PartialEq, Eq)]
pub enum RouteHit {
    /// 命中某执行环境的源目录 → 唤醒 tick。
    SourceHarness(String),
    /// 命中第 i 个 watch-only 消费者（按注册序）。
    WatchOnly(usize),
}

impl WatchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册执行环境源目录（递归监听）。路径不存在也允许注册——进 pending
    /// 集合，出现后由 watcher 超时循环补挂。
    pub fn register_source(&mut self, harness: &str, path: PathBuf) {
        self.sources.push((harness.to_string(), path));
    }

    /// 注册 watch-only 消费者（回调在 watcher 线程执行，必须快——
    /// 只做内存失效/置位，慢活交给对应轮询循环）。
    pub fn register_watch_only(
        &mut self,
        name: &str,
        path: PathBuf,
        on_change: WatchCallback,
    ) {
        self.watch_only.push((name.to_string(), path, on_change));
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty() && self.watch_only.is_empty()
    }

    #[cfg(any(test, feature = "watcher"))]
    fn router(&self) -> WatchRouter {
        WatchRouter {
            sources: self.sources.clone(),
            watch_only: self
                .watch_only
                .iter()
                .enumerate()
                .map(|(i, (_, p, _))| (p.clone(), i))
                .collect(),
        }
    }
}

/// 纯路由核：事件路径 → 命中列表。与 notify 无关，两态可测。
///
/// watch_only 条目显式携带回调下标（`register_watch_only` 的注册序）——
/// 平台适配器可能为同一个根追加**规范化路径别名**（macOS FSEvents 把
/// `/var/…` 上报为 `/private/var/…`），别名必须映射到同一回调，追加
/// 条目不得移动既有下标。
pub struct WatchRouter {
    sources: Vec<(String, PathBuf)>,
    watch_only: Vec<(PathBuf, usize)>,
}

pub fn is_noise_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return true;
    };
    // 编辑器/系统残渣——进了也只是多唤醒一次 tick（幂等），滤掉省 CPU。
    name == ".DS_Store" || name.ends_with(".tmp") || name.ends_with(".swp") || name.ends_with('~')
}

impl WatchRouter {
    /// 路径 → 所有命中（一个路径可能同时是源目录与 watch-only 成员；
    /// 前缀比较按组件边界，`/foo/bar2` 不算 `/foo/bar` 的成员）。
    pub fn route(&self, path: &Path) -> Vec<RouteHit> {
        if is_noise_path(path) {
            return Vec::new();
        }
        let mut hits = Vec::new();
        for (harness, root) in &self.sources {
            if starts_within(path, root) {
                hits.push(RouteHit::SourceHarness(harness.clone()));
            }
        }
        for (root, cb_index) in &self.watch_only {
            if starts_within(path, root) {
                hits.push(RouteHit::WatchOnly(*cb_index));
            }
        }
        hits
    }

    /// 追加同一执行环境源根的路径别名（规范化形式）。命中同一执行环境，幂等
    /// 语义不变（去抖合并）。
    pub fn add_source_alias(&mut self, harness: &str, path: PathBuf) {
        self.sources.push((harness.to_string(), path));
    }

    /// 追加同一 watch-only 根（回调下标不变）的路径别名。
    pub fn add_watch_only_alias(&mut self, cb_index: usize, path: PathBuf) {
        self.watch_only.push((path, cb_index));
    }
}

/// 组件边界感知的前缀判定（`std::path::starts_with` 本身就是按组件的，
/// 包一层只为语义命名与空路径防御）。
fn starts_within(path: &Path, root: &Path) -> bool {
    !root.as_os_str().is_empty() && path.starts_with(root)
}

/// 去抖收集器：窗口内offer 的命中合并成一批。纯状态机，无时钟依赖
/// （时钟在调用方：超时到了才 take_batch）。
#[derive(Default)]
pub struct Debouncer {
    harnesses: BTreeSet<String>,
    watch_only: BTreeSet<usize>,
}

/// 一批合并后的派发动作。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct WatchBatch {
    pub harnesses: Vec<String>,
    pub watch_only: Vec<usize>,
}

impl Debouncer {
    pub fn offer(&mut self, hit: RouteHit) {
        match hit {
            RouteHit::SourceHarness(harness) => {
                self.harnesses.insert(harness);
            }
            RouteHit::WatchOnly(i) => {
                self.watch_only.insert(i);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.harnesses.is_empty() && self.watch_only.is_empty()
    }

    /// 取走并清空当前批。
    pub fn take_batch(&mut self) -> WatchBatch {
        // BTreeSet 没有 drain——整体 mem::take（调用方拿走后 self 归零）。
        let harnesses = std::mem::take(&mut self.harnesses);
        let watch_only = std::mem::take(&mut self.watch_only);
        WatchBatch { harnesses: harnesses.into_iter().collect(), watch_only: watch_only.into_iter().collect() }
    }
}

/// 兼容路径：两个默认监听根函数 W3 挪进 `sources::watch_topology`（它们只描述
/// 「监听哪些根」，是源配置；此前放在这里让 `sources ↔ ingest` 互相引用成环）。
pub use crate::sources::watch_topology::{default_skill_watch_roots, default_source_watch_roots};

impl WatchRegistry {
    /// 从拓扑快照构造（Phase B）：FactsSource → 源根（唤醒 tick）；
    /// CacheOnly → watch-only（`cache_callback` 按描述符产回调——desktop
    /// 用它接 SkillsScanState 失效）。被拒项不进注册表（调用方已拿 rejected）。
    pub fn from_topology(
        topology: &crate::sources::watch_topology::WatchTopology,
        cache_callback: impl Fn(&str) -> WatchCallback,
    ) -> Self {
        let mut registry = WatchRegistry::new();
        for descriptor in &topology.descriptors {
            match descriptor.class {
                crate::sources::watch_topology::WatchRootClass::FactsSource => {
                    registry.register_source(&descriptor.harness, descriptor.path.clone());
                }
                crate::sources::watch_topology::WatchRootClass::CacheOnly => {
                    let callback = cache_callback(&descriptor.harness);
                    registry.register_watch_only(
                        &format!("cache:{}", descriptor.harness),
                        descriptor.path.clone(),
                        callback,
                    );
                }
            }
        }
        registry
    }
}

/// watcher 运行模式（spec §5.5）。闭集；Phase D 的 DTO 原样映射。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatcherMode {
    /// 原生监听运行中（可能有 pending 根——看 `pending_roots`）。
    Active,
    /// 后端初始化失败或全部根 pending——周期兜底服务中。
    Degraded,
    /// 无根可监听（空拓扑）或 feature 关闭。
    Disabled,
    /// worker 已退出（supervisor 被 drop 之后的稳态）。
    Unavailable,
}

/// watcher 健康快照（spec §5.5）。**只存在于进程内存**——运维健康不是
/// 用户数据，不落 authority SQLite；字段无路径无原始错误串（不变量 6）。
#[derive(Clone, Debug)]
pub struct WatcherHealth {
    pub mode: WatcherMode,
    /// 拓扑修订号（每次快照替换 +1，单调）。
    pub topology_revision: u64,
    pub facts_roots_registered: u32,
    pub facts_roots_attached: u32,
    pub cache_roots_registered: u32,
    pub cache_roots_attached: u32,
    pub pending_roots: u32,
    pub last_event_at_ms: Option<i64>,
    pub last_wake_at_ms: Option<i64>,
    pub coalesced_wake_count: u64,
    /// 闭集原因码（spec §5.5 允许的 8 个之一）。
    pub reason_code: Option<&'static str>,
}

impl Default for WatcherHealth {
    fn default() -> Self {
        WatcherHealth {
            mode: WatcherMode::Disabled,
            topology_revision: 0,
            facts_roots_registered: 0,
            facts_roots_attached: 0,
            cache_roots_registered: 0,
            cache_roots_attached: 0,
            pending_roots: 0,
            last_event_at_ms: None,
            last_wake_at_ms: None,
            coalesced_wake_count: 0,
            reason_code: None,
        }
    }
}

/// 一个监听根在路由器里的身份（快照重建与别名追加时用）。
#[cfg(feature = "watcher")]
#[derive(Clone)]
enum RootIdentity {
    Source(String),
    WatchOnly(usize),
}

#[cfg(feature = "watcher")]
fn add_canonical_alias(router: &mut WatchRouter, identity: &RootIdentity, path: &Path) {
    let Ok(canon) = path.canonicalize() else { return };
    if canon == path {
        return;
    }
    match identity {
        RootIdentity::Source(harness) => router.add_source_alias(harness, canon),
        RootIdentity::WatchOnly(i) => router.add_watch_only_alias(*i, canon),
    }
}

#[cfg(feature = "watcher")]
fn local_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// watcher 句柄：监督者（supervisor）的客户端面。`replace` 提交新的拓扑
/// 快照（spec §5.4——快照不可变、替换串行于 worker、重建式实现）；drop
/// 句柄 = 关停信号（worker 在下一个循环边界退出，无清理动作）。
pub struct WatcherHandle {
    noop: bool,
    control: Option<std::sync::mpsc::Sender<WatchRegistry>>,
    health: Option<Arc<std::sync::Mutex<WatcherHealth>>>,
}

impl WatcherHandle {
    pub fn is_noop(&self) -> bool {
        self.noop
    }

    /// 热插拔：换一份完整拓扑快照。noop 句柄（feature 关闭）= 无操作成功。
    pub fn replace(&self, registry: WatchRegistry) -> Result<(), String> {
        match &self.control {
            None => Ok(()),
            Some(tx) => tx.send(registry).map_err(|e| e.to_string()),
        }
    }

    /// 健康快照（feature 关闭 → 恒 Disabled/feature_disabled）。
    pub fn health(&self) -> WatcherHealth {
        match &self.health {
            None => WatcherHealth {
                reason_code: Some("feature_disabled"),
                ..WatcherHealth::default()
            },
            Some(h) => h.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }
}

/// 启动监督式 watcher（spec §5.4）。feature `watcher` 关闭 → NoopWatcher
/// （Vite createNoopWatcher 同款：零线程零依赖，tick 周期照常）；开启 →
/// 单 worker 线程 + 控制通道，初始快照即刻应用，后续 `replace` 热替换。
pub fn spawn_watcher(registry: WatchRegistry, waker: TickWaker) -> WatcherHandle {
    spawn_platform_watcher(registry, waker)
}

#[cfg(feature = "watcher")]
mod supervised {
    //! worker 内部状态机（只在 worker 线程内动，无锁）。
    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum RootAttachFailure {
        PermissionDenied,
        Other,
    }

    pub(super) struct WorkerState {
        event_tx: std::sync::mpsc::Sender<notify::Result<notify::Event>>,
        watcher: Option<notify::RecommendedWatcher>,
        router: WatchRouter,
        callbacks: Vec<WatchCallback>,
        identities: Vec<(PathBuf, RootIdentity)>,
        attached: std::collections::HashSet<PathBuf>,
        pending: Vec<PendingRoot>,
        failed: std::collections::HashMap<PathBuf, RootAttachFailure>,
        revision: u64,
        backend_failed: bool,
        facts_registered: u32,
        cache_registered: u32,
    }

    impl WorkerState {
        pub(super) fn new(
            event_tx: std::sync::mpsc::Sender<notify::Result<notify::Event>>,
        ) -> Self {
            WorkerState {
                event_tx,
                watcher: None,
                router: WatchRegistry::new().router(),
                callbacks: Vec::new(),
                identities: Vec::new(),
                attached: std::collections::HashSet::new(),
                pending: Vec::new(),
                failed: std::collections::HashMap::new(),
                revision: 0,
                backend_failed: false,
                facts_registered: 0,
                cache_registered: 0,
            }
        }

        fn identity_of(&self, path: &Path) -> Option<RootIdentity> {
            self.identities
                .iter()
                .find(|(p, _)| p == path)
                .map(|(_, id)| id.clone())
        }

        /// 应用一份拓扑快照：drop 旧原生 watcher（停全部 watch）→ 重建 →
        /// 全量挂载。**路由表先换**——旧 watcher 的在途事件撞上新表，
        /// 被移除的根立即停止路由（spec §5.4）。
        pub(super) fn apply(&mut self, snapshot: WatchRegistry) {
            self.revision += 1;
            self.watcher = None; // drop = 停止全部既有 watch
            self.backend_failed = false;
            self.attached.clear();
            self.pending.clear();
            self.failed.clear();
            self.facts_registered = snapshot.sources.len() as u32;
            self.cache_registered = snapshot.watch_only.len() as u32;
            self.router = snapshot.router();
            self.callbacks = snapshot.watch_only.iter().map(|(_, _, cb)| Arc::clone(cb)).collect();
            self.identities = snapshot
                .sources
                .iter()
                .map(|(harness, p)| (p.clone(), RootIdentity::Source(harness.clone())))
                .chain(
                    snapshot
                        .watch_only
                        .iter()
                        .enumerate()
                        .map(|(i, (_, p, _))| (p.clone(), RootIdentity::WatchOnly(i))),
                )
                .collect();

            let mut roots: Vec<PathBuf> =
                snapshot.sources.iter().map(|(_, p)| p.clone()).collect();
            roots.extend(snapshot.watch_only.iter().map(|(_, p, _)| p.clone()));
            roots.sort();
            roots.dedup();
            if roots.is_empty() {
                return;
            }
            match notify::RecommendedWatcher::new(
                self.event_tx.clone(),
                notify::Config::default(),
            ) {
                Ok(mut native) => {
                    let now = std::time::Instant::now();
                    for path in &roots {
                        self.try_attach(&mut native, path, now);
                    }
                    self.watcher = Some(native);
                }
                Err(e) => {
                    // 后端起不来（罕见）：Degraded + 周期兜底，诚实不装死。
                    self.backend_failed = true;
                    crate::core::logging::log_warn("watcher", &format!("后端初始化失败，tick 兜底照常: {e}"));
                }
            }
        }

        /// 挂一个根（仅在原生 watcher 存在时有意义）。成功 → attached +
        /// 规范化别名；目录未出现 → pending 留待重试；其他失败 → 该根
        /// 交给 tick 兜底（日志一次）。
        pub(super) fn try_attach(&mut self, native: &mut notify::RecommendedWatcher, path: &Path, now: std::time::Instant) {
            match native.watch(path, notify::RecursiveMode::Recursive) {
                Ok(()) => {
                    // 挂载成功才是补规范化别名的位置（FSEvents 上报
                    // /private/var/...，注册可能用符号链接路径）。
                    if let Some(identity) = self.identity_of(path) {
                        add_canonical_alias(&mut self.router, &identity, path);
                    }
                    self.attached.insert(path.to_path_buf());
                }
                Err(e) => {
                    let not_found = matches!(e.kind, notify::ErrorKind::PathNotFound)
                        || matches!(&e.kind, notify::ErrorKind::Io(io)
                            if io.kind() == std::io::ErrorKind::NotFound);
                    if not_found {
                        // 新 pending 从基线间隔起（P4 退避；首个重试在 30s 后）。
                        self.pending.push(PendingRoot::new(path.to_path_buf(), now));
                    } else {
                        let failure = match &e.kind {
                            notify::ErrorKind::Io(io)
                                if io.kind() == std::io::ErrorKind::PermissionDenied =>
                            {
                                RootAttachFailure::PermissionDenied
                            }
                            _ => RootAttachFailure::Other,
                        };
                        self.failed.insert(path.to_path_buf(), failure);
                        crate::core::logging::log_warn(
                            "watcher",
                            &format!("watch {} 失败（该根 tick 兜底）: {e}", path.display()),
                        );
                    }
                }
            }
        }

        pub(super) fn retry_pending(&mut self, now: std::time::Instant) {
            let old = std::mem::take(&mut self.pending);
            let Some(mut native) = self.watcher.take() else {
                self.pending = old;
                return;
            };
            for entry in old {
                if !entry.due(now) {
                    // 退避未到——本轮跳过（P4：消灭每 1.2s 的线程生灭）。
                    self.pending.push(entry);
                    continue;
                }
                let probe = entry;
                self.try_attach(&mut native, &probe.path, now);
                // try_attach 仍 NotFound 时以基线间隔 push 回来——升级为
                // 上一轮的翻倍（封顶 MAX；纯函数，有直测）。
                requeue_escalated(&mut self.pending, &probe, now);
            }
            self.watcher = Some(native);
        }

        pub(super) fn route(&self, path: &Path) -> Vec<RouteHit> {
            self.router.route(path)
        }

        pub(super) fn callbacks(&self) -> &[WatchCallback] {
            &self.callbacks
        }

        /// 把状态投影进健康快照（worker 侧唯一写者）。
        pub(super) fn publish_health(
            &self,
            health: &Arc<std::sync::Mutex<WatcherHealth>>,
            last_event_at_ms: Option<i64>,
            last_wake_at_ms: Option<i64>,
            coalesced_wake_count: u64,
        ) {
            let facts_attached = self
                .identities
                .iter()
                .filter(|(p, id)| {
                    matches!(id, RootIdentity::Source(_)) && self.attached.contains(p)
                })
                .count() as u32;
            let cache_attached = self
                .identities
                .iter()
                .filter(|(p, id)| {
                    matches!(id, RootIdentity::WatchOnly(_)) && self.attached.contains(p)
                })
                .count() as u32;
            let registered = self.facts_registered + self.cache_registered;
            let (mode, reason) = if self.backend_failed {
                (WatcherMode::Degraded, Some("backend_init_failed"))
            } else if registered == 0 {
                (WatcherMode::Disabled, Some("no_roots"))
            } else if self
                .failed
                .values()
                .any(|failure| *failure == RootAttachFailure::PermissionDenied)
            {
                (WatcherMode::Degraded, Some("root_permission_denied"))
            } else if !self.failed.is_empty() {
                (WatcherMode::Degraded, Some("root_attach_failed"))
            } else if self.attached.is_empty() && !self.pending.is_empty() {
                (WatcherMode::Degraded, Some("root_pending"))
            } else {
                (WatcherMode::Active, None)
            };
            let mut h = health.lock().unwrap_or_else(|e| e.into_inner());
            h.mode = mode;
            h.reason_code = reason;
            h.topology_revision = self.revision;
            h.facts_roots_registered = self.facts_registered;
            h.facts_roots_attached = facts_attached;
            h.cache_roots_registered = self.cache_registered;
            h.cache_roots_attached = cache_attached;
            h.pending_roots = self.pending.len() as u32;
            h.last_event_at_ms = last_event_at_ms;
            h.last_wake_at_ms = last_wake_at_ms;
            h.coalesced_wake_count = coalesced_wake_count;
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn failed_root_health_distinguishes_permission_from_other_attach_errors() {
            let (event_tx, _event_rx) = std::sync::mpsc::channel();
            let mut state = WorkerState::new(event_tx);
            state.facts_registered = 1;
            let health = Arc::new(std::sync::Mutex::new(WatcherHealth::default()));

            state.failed.insert(PathBuf::from("/tmp/root"), RootAttachFailure::Other);
            state.publish_health(&health, None, None, 0);
            let snapshot = health.lock().unwrap().clone();
            assert_eq!(snapshot.mode, WatcherMode::Degraded);
            assert_eq!(snapshot.reason_code, Some("root_attach_failed"));

            state.failed.insert(
                PathBuf::from("/tmp/denied"),
                RootAttachFailure::PermissionDenied,
            );
            state.publish_health(&health, None, None, 0);
            assert_eq!(
                health.lock().unwrap().reason_code,
                Some("root_permission_denied"),
            );
        }
    }
}

#[cfg(feature = "watcher")]
fn next_event_wait(
    batch_started_at: Option<std::time::Instant>,
    last_routed_event_at: Option<std::time::Instant>,
) -> Duration {
    match (batch_started_at, last_routed_event_at) {
        (Some(started), Some(last)) => {
            let idle_left = DEBOUNCE.saturating_sub(last.elapsed());
            let max_left = MAX_DEBOUNCE.saturating_sub(started.elapsed());
            idle_left.min(max_left)
        }
        _ => DEBOUNCE,
    }
}

#[cfg(feature = "watcher")]
fn spawn_platform_watcher(initial: WatchRegistry, waker: TickWaker) -> WatcherHandle {
    let (control_tx, control_rx) = std::sync::mpsc::channel::<WatchRegistry>();
    let health = Arc::new(std::sync::Mutex::new(WatcherHealth::default()));
    let health_for_worker = Arc::clone(&health);

    let spawned = std::thread::Builder::new()
        .name("source-watcher".into())
        .spawn(move || {
            // 事件通道：worker 持一份 keepalive——原生 watcher 按快照重建，
            // 通道只在 worker 退出时断（Disconnected = 防御性出口）。
            let (event_tx, event_rx) = std::sync::mpsc::channel();
            let _keepalive = event_tx.clone();
            let mut state = supervised::WorkerState::new(event_tx.clone());
            let mut deb = Debouncer::default();
            let mut coalesced: u64 = 0;
            let mut last_event: Option<i64> = None;
            let mut last_wake: Option<i64> = None;
            let mut batch_started_at: Option<std::time::Instant> = None;
            let mut last_routed_event_at: Option<std::time::Instant> = None;

            state.apply(initial);
            state.publish_health(&health_for_worker, last_event, last_wake, coalesced);

            loop {
                // 控制通道优先：快照替换（热插拔）不等事件窗。
                match control_rx.try_recv() {
                    Ok(snapshot) => {
                        deb = Debouncer::default(); // 旧拓扑的去抖残留整批丢弃
                        batch_started_at = None;
                        last_routed_event_at = None;
                        state.apply(snapshot);
                        state.publish_health(&health_for_worker, last_event, last_wake, coalesced);
                        continue;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        // supervisor drop（应用关停）——退出，无清理动作。
                        let mut h = health_for_worker.lock().unwrap_or_else(|e| e.into_inner());
                        h.mode = WatcherMode::Unavailable;
                        h.reason_code = Some("worker_terminated");
                        return;
                    }
                }
                let timeout = next_event_wait(batch_started_at, last_routed_event_at);
                match event_rx.recv_timeout(timeout) {
                    Ok(Ok(event)) => {
                        let mut routed = false;
                        for path in &event.paths {
                            for hit in state.route(path) {
                                deb.offer(hit);
                                routed = true;
                            }
                        }
                        if routed {
                            let now = std::time::Instant::now();
                            batch_started_at.get_or_insert(now);
                            last_routed_event_at = Some(now);
                            last_event = Some(local_now_ms());
                        }
                    }
                    Ok(Err(e)) => {
                        // in-band 错误（如缓冲溢出）：记日志继续；丢的事件由
                        // tick 指纹对账兜底（SourceGraph spec §12）。
                        crate::core::logging::log_warn("watcher", &format!("事件错误（tick 兜底）: {e}"));
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // 超时双职责：①补挂 pending 根；②去抖窗落定派发。
                        state.retry_pending(std::time::Instant::now());
                        let batch = deb.take_batch();
                        batch_started_at = None;
                        last_routed_event_at = None;
                        if !batch.harnesses.is_empty() {
                            if let WakeOutcome::Coalesced = waker.wake_harnesses(&batch.harnesses) {
                                coalesced += 1;
                            }
                            last_wake = Some(local_now_ms());
                        }
                        for i in batch.watch_only {
                            if let Some(cb) = state.callbacks().get(i) {
                                cb();
                            }
                        }
                        state.publish_health(&health_for_worker, last_event, last_wake, coalesced);
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        // keepalive 在手时不会发生；防御性退出。
                        return;
                    }
                }
            }
        });

    match spawned {
        Ok(_) => WatcherHandle {
            noop: false,
            control: Some(control_tx),
            health: Some(health),
        },
        Err(e) => {
            crate::core::logging::log_warn("watcher", &format!("线程启动失败，tick 兜底照常: {e}"));
            WatcherHandle { noop: true, control: None, health: None }
        }
    }
}

#[cfg(not(feature = "watcher"))]
fn spawn_platform_watcher(_initial: WatchRegistry, _waker: TickWaker) -> WatcherHandle {
    // NoopWatcher（Vite server/index.ts createNoopWatcher 同款）：无
    // notify 依赖、无线程；tick 周期发现照常（spec §1.5 可插拔条款）。
    WatcherHandle { noop: true, control: None, health: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(p: &str) -> PathBuf {
        PathBuf::from(p)
    }

    /// 路由：源执行环境命中、watch-only 命中、跨根互不串、边界按组件。
    #[test]
    fn router_routes_by_component_prefix() {
        let mut reg = WatchRegistry::new();
        reg.register_source("claude-code", root("/home/u/.claude/projects"));
        reg.register_source("codex", root("/home/u/.codex"));
        let cb: Arc<dyn Fn() + Send + Sync> = Arc::new(|| {});
        reg.register_watch_only("skills", root("/home/u/.claude/skills"), cb);
        let router = reg.router();

        let hits = router.route(Path::new("/home/u/.claude/projects/p-x/sess.jsonl"));
        assert_eq!(hits, vec![RouteHit::SourceHarness("claude-code".into())]);

        let hits = router.route(Path::new("/home/u/.claude/skills/foo/SKILL.md"));
        assert_eq!(hits, vec![RouteHit::WatchOnly(0)]);

        // 组件边界：/home/u/.claude/projects-x 不是 projects 的成员
        let hits = router.route(Path::new("/home/u/.claude/projects-x/sess.jsonl"));
        assert!(hits.is_empty(), "前缀必须按组件边界: {hits:?}");

        // 注册表外的路径
        let hits = router.route(Path::new("/etc/harnesses"));
        assert!(hits.is_empty());
    }

    /// 噪声文件过滤：.DS_Store / *.tmp / 编辑器备份不产生命中。
    #[test]
    fn noise_paths_are_filtered() {
        let mut reg = WatchRegistry::new();
        reg.register_source("claude-code", root("/home/u/.claude/projects"));
        let router = reg.router();
        for junk in ["/home/u/.claude/projects/.DS_Store", "/home/u/.claude/projects/sess.jsonl.tmp", "/home/u/.claude/projects/sess.jsonl~"] {
            assert!(router.route(Path::new(junk)).is_empty(), "{junk} 应被滤掉");
        }
    }

    /// 去抖：窗口内多命中合并、执行环境去重、take 后清空。
    #[test]
    fn debouncer_coalesces_bursts() {
        let mut deb = Debouncer::default();
        for _ in 0..5 {
            deb.offer(RouteHit::SourceHarness("claude-code".into()));
        }
        deb.offer(RouteHit::SourceHarness("codex".into()));
        deb.offer(RouteHit::WatchOnly(2));
        deb.offer(RouteHit::WatchOnly(2));
        let batch = deb.take_batch();
        assert_eq!(batch.harnesses, vec!["claude-code".to_string(), "codex".to_string()],
            "BTreeSet 保证去重 + 稳定序");
        assert_eq!(batch.watch_only, vec![2]);
        assert!(deb.take_batch() == WatchBatch::default(), "take 后清空");
        assert!(deb.is_empty());
    }

    /// 结构守卫（Phase B）：内置事实根绝不等于 home 根或 /——P2 版的
    /// codex 根 bug（误监听整个 home）就是这一类，parity 断言 + 此守卫
    /// 双钉。
    #[test]
    fn builtin_facts_roots_are_never_home_or_filesystem_root() {
        let user_home = PathBuf::from("/home/u");
        for (harness, path) in default_source_watch_roots(&user_home) {
            assert_ne!(path, user_home, "{harness} 不得监听整个 home");
            assert_ne!(path, PathBuf::from("/"), "{harness} 不得监听文件系统根");
            assert!(path.starts_with(&user_home) || harness == "dsh",
                "{harness} 的根 {path:?} 应在 home 下（dsh 环境配置除外）");
        }
    }

    /// skills 根派生：只收 home 相对根、展开 ~、排序去重；`./` 项目根
    /// 不出现（桌面 cwd 无语义）。
    #[test]
    fn skill_watch_roots_are_home_relative_only() {
        let home = PathBuf::from("/home/u");
        let roots = default_skill_watch_roots(&home);
        assert!(!roots.is_empty(), "DEFAULT_ROOTS 里有 ~/ 根");
        for (harness, path) in &roots {
            assert!(path.starts_with(&home), "{harness}: {path:?} 应在 home 下");
            let s = path.to_string_lossy();
            assert!(!s.contains("/./"), "项目本地根不得出现: {s}");
        }
        let claude = roots.iter().find(|(h, _)| h == "claude-code").unwrap();
        assert_eq!(claude.1, home.join(".claude/skills"));
        // 幂等：再派生一次结果一致
        assert_eq!(default_skill_watch_roots(&home), roots);
    }

    /// 验收 #3：retry_pending 的 interval 继承粘合（requeue_escalated）——
    /// try_attach 以基线重入队后，间隔必须从上一轮翻倍而不是从基线数。
    #[test]
    fn requeue_escalated_doubles_from_previous_interval() {
        let now = std::time::Instant::now();
        // 上一轮 interval=60（已经升级过一次）的探针；try_attach 模拟重入队
        // （基线 30 的全新条目）。
        let probe = PendingRoot {
            path: std::path::PathBuf::from("/tmp/absent"),
            next_retry_at: now,
            interval: Duration::from_secs(60),
        };
        let mut pending = vec![PendingRoot::new(std::path::PathBuf::from("/tmp/absent"), now)];
        requeue_escalated(&mut pending, &probe, now);
        assert_eq!(pending[0].interval, Duration::from_secs(120),
            "从上一轮 60s 翻倍到 120s，不是从基线 30s 数起");
        assert_eq!(pending[0].next_retry_at, now + Duration::from_secs(120));

        // 探针已在 300 封顶：重入队后仍 300。
        let capped = PendingRoot {
            path: std::path::PathBuf::from("/tmp/absent"),
            next_retry_at: now,
            interval: PENDING_RETRY_MAX,
        };
        requeue_escalated(&mut pending, &capped, now);
        assert_eq!(pending[0].interval, PENDING_RETRY_MAX);

        // 挂载成功（未重入队）——无操作，不炸。
        let mut attached_only = vec![PendingRoot::new(std::path::PathBuf::from("/tmp/other"), now)];
        requeue_escalated(&mut attached_only, &probe, now);
        assert_eq!(attached_only.len(), 1);
        assert_eq!(attached_only[0].interval, PENDING_RETRY_BASE, "无关路径不受影响");
    }

    /// P4 退避语义（收敛调查 §4）：新 pending 首个重试在 30s 后；未到点
    /// `due=false`；每次失败翻倍、封顶 300s。
    #[test]
    fn pending_root_backoff_schedules_and_escalates() {
        let now = std::time::Instant::now();
        let mut root = PendingRoot::new(std::path::PathBuf::from("/tmp/absent"), now);
        assert!(!root.due(now + PENDING_RETRY_BASE - Duration::from_millis(1)),
            "基线间隔内不得重试");
        assert!(root.due(now + PENDING_RETRY_BASE));
        assert_eq!(root.interval, PENDING_RETRY_BASE);

        // 失败升级：30 → 60 → 120 → 240 → 300（封顶）
        let mut t = now + PENDING_RETRY_BASE;
        for expect in [60, 120, 240, 300, 300] {
            root.escalate(t);
            assert_eq!(root.interval.as_secs(), expect, "翻倍封顶于 300s");
            assert!(!root.due(t + root.interval - Duration::from_millis(1)));
            t += root.interval;
            assert!(root.due(t));
        }
    }

    /// waker：首批执行环境入槽 = Queued，后续并入 = Coalesced；wait 取走集合
    /// 后槽清空。空入参是显式 no-op。
    #[test]
    fn tick_waker_delivers_and_never_panics() {
        let WakeChannel { waker, slot } = TickWaker::channel();
        assert_eq!(waker.wake_harnesses(["claude-code"]), WakeOutcome::Queued);
        assert_eq!(waker.wake_harnesses(["codex"]), WakeOutcome::Coalesced);
        assert_eq!(
            waker.wake_harnesses(std::iter::empty::<&str>()),
            WakeOutcome::Coalesced,
            "空入参 no-op（不计数不唤醒）",
        );
        assert_eq!(
            wait_for_wake(&slot, Duration::from_millis(5)),
            TickWait::Woken(["claude-code".to_string(), "codex".to_string()].into_iter().collect()),
            "两个执行环境都进了同一批集合（合并语义）",
        );
        assert_eq!(
            wait_for_wake(&slot, Duration::from_millis(5)),
            TickWait::TimedOut,
            "取走后槽空，等满周期",
        );
        assert_eq!(waker.coalesced_count(), 2,
            "计数 = 返回 Coalesced 的调用次数（两次并入/重复调用）");
    }

    /// Phase A 出口判据（HARDENING spec §6）：模拟「sync 阻塞中」——
    /// 10,000 次 wake 无人接收，只允许留下**一个** pending；后续全部
    /// 报告 Coalesced；合并计数如实累计；内存有界（单槽结构保证）。
    #[test]
    fn wake_pressure_coalesces_to_single_pending() {
        let WakeChannel { waker, slot } = TickWaker::channel();
        let mut queued = 0u32;
        let mut coalesced = 0u32;
        for i in 0..10_000 {
            let harness = format!("harness-{}", i % 3);
            match waker.wake_harnesses([&harness]) {
                WakeOutcome::Queued => queued += 1,
                WakeOutcome::Coalesced => coalesced += 1,
            }
        }
        assert_eq!(queued, 1, "只有第一批入槽");
        assert_eq!(coalesced, 9_999);
        assert_eq!(waker.coalesced_count(), 9_999, "诊断计数与结果一致");
        // 槽内有界：只有 3 个去重后的执行环境身份，不是 10k 条事件
        match wait_for_wake(&slot, Duration::from_millis(0)) {
            TickWait::Woken(harnesses) => {
                assert_eq!(harnesses.len(), 3, "集合上界 = 去重执行环境数: {harnesses:?}");
            }
            other => panic!("应当 Woken: {other:?}"),
        }
    }

    /// 并发压力：多线程同时 wake_harnesses，槽不 panic、集合无界增长。
    #[test]
    fn concurrent_wake_harnesses_stay_bounded() {
        let WakeChannel { waker, slot } = TickWaker::channel();
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let w = waker.clone();
                std::thread::spawn(move || {
                    for i in 0..1_000 {
                        let _ = w.wake_harnesses([format!("harness-{}", (t + i) % 4)]);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        match wait_for_wake(&slot, Duration::from_millis(0)) {
            TickWait::Woken(harnesses) => assert_eq!(harnesses.len(), 4, "恰好 4 个去重执行环境"),
            other => panic!("应当 Woken: {other:?}"),
        }
        assert_eq!(
            wait_for_wake(&slot, Duration::from_millis(0)),
            TickWait::TimedOut,
            "无第二个排队信号",
        );
    }

    /// Phase A.3 排序（HARDENING spec §6「ordering」）：阻塞中的 sync 期间
    /// 大量 wake → 恢复后**一次** Woken，之后等满周期（不是 N 次连醒）。
    #[test]
    fn wait_helper_orders_blocked_sync_into_one_followup() {
        let WakeChannel { waker, slot } = TickWaker::channel();
        for _ in 0..5_000 {
            let _ = waker.wake_harnesses(["claude-code"]);
        }
        assert!(matches!(
            wait_for_wake(&slot, Duration::from_millis(5)),
            TickWait::Woken(_),
        ));
        assert_eq!(
            wait_for_wake(&slot, Duration::from_millis(20)),
            TickWait::TimedOut,
            "合并后不得有第二次 pending 唤醒",
        );
    }

    /// 持续写入不能不断重置去抖计时器而饿死实时唤醒；达到最长合并窗时，
    /// 下一次 wait 必须近乎立即超时并派发当前批次。
    #[cfg(feature = "watcher")]
    #[test]
    fn continuous_events_are_bounded_by_max_debounce() {
        let now = std::time::Instant::now();
        assert_eq!(next_event_wait(None, None), DEBOUNCE);
        let started = now
            .checked_sub(MAX_DEBOUNCE - Duration::from_millis(20))
            .unwrap();
        let wait = next_event_wait(Some(started), Some(now));
        assert!(
            wait <= Duration::from_millis(20),
            "最长合并窗将到期时不得再等完整 idle debounce: {wait:?}",
        );
    }

    /// 冷却判定（真机 CPU 事故的回归钉子）：刚同步完 → 要睡接近全窗；
    /// 过窗 → None 立即执行；单调性——时间越久剩余越少。
    #[test]
    fn watcher_cooldown_bounds_execution_rate() {
        let now = std::time::Instant::now();
        let just_finished = now - Duration::from_secs(1);
        assert_eq!(
            watcher_cooldown_remaining(just_finished, now),
            Some(Duration::from_secs(29)),
            "同步完 1 秒后收到唤醒：还需睡 29 秒（睡满不丢弃）",
        );
        let long_ago = now - Duration::from_secs(120);
        assert_eq!(watcher_cooldown_remaining(long_ago, now), None);
        let mid = now - Duration::from_secs(10);
        assert_eq!(watcher_cooldown_remaining(mid, now), Some(Duration::from_secs(20)));
    }

    /// 自看护（`self_monitor`）拉长冷却时走的是同一条判定逻辑，只是窗口值
    /// 换成动态的——`watcher_cooldown_remaining` 必须等价于
    /// `cooldown_remaining_with(WATCHER_SYNC_COOLDOWN, ..)`，不是两套独立实现。
    #[test]
    fn cooldown_remaining_with_matches_the_fixed_baseline_wrapper() {
        let now = std::time::Instant::now();
        let finished = now - Duration::from_secs(10);
        assert_eq!(
            cooldown_remaining_with(WATCHER_SYNC_COOLDOWN, finished, now),
            watcher_cooldown_remaining(finished, now),
        );
        // 拉长到 120s 后，同一个「10 秒前完成」在动态窗口下还差 110 秒。
        assert_eq!(
            cooldown_remaining_with(Duration::from_secs(120), finished, now),
            Some(Duration::from_secs(110)),
        );
    }

    /// feature 关闭 → 恒 noop（NoopWatcher），健康快照 Disabled/
    /// feature_disabled，replace 为无操作成功。
    #[cfg(not(feature = "watcher"))]
    #[test]
    fn feature_off_is_noop_with_disabled_health() {
        let WakeChannel { waker, slot: _ } = TickWaker::channel();
        let handle = spawn_watcher(WatchRegistry::new(), waker);
        assert!(handle.is_noop());
        let health = handle.health();
        assert_eq!(health.mode, WatcherMode::Disabled);
        assert_eq!(health.reason_code, Some("feature_disabled"));
        assert!(handle.replace(WatchRegistry::new()).is_ok(), "noop 句柄的 replace 无操作成功");
    }

    /// 监督生命周期（HARDENING spec §6「dynamic lifecycle」行，Phase C）：
    /// 空拓扑启动 → Disabled/no_roots；replace 换上真实根 → Active、
    /// attached=1、revision=2；再换回空 → 回 Disabled。全程不重启线程
    /// （同一句柄三次状态转移）。只断言**附件集与修订号**（确定性），
    /// 事件唤醒走真机 ignored 测试。
    #[cfg(feature = "watcher")]
    #[test]
    fn supervised_lifecycle_matches_topology_revisions() {
        let dir = std::env::temp_dir().join(format!(
            "avd-watch-sup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let WakeChannel { waker, slot: _ } = TickWaker::channel();

        let handle = spawn_watcher(WatchRegistry::new(), waker.clone());
        assert!(!handle.is_noop(), "监督式 watcher 无根也保持 worker 在岗（热插拔前提）");
        let mut health = handle.health();
        for _ in 0..50 {
            health = handle.health();
            if health.topology_revision >= 1 { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(health.topology_revision, 1, "初始快照 revision=1");
        assert_eq!(health.mode, WatcherMode::Disabled, "空拓扑 = Disabled");
        assert_eq!(health.reason_code, Some("no_roots"));

        let mut registry = WatchRegistry::new();
        registry.register_source("claude-code", dir.clone());
        handle.replace(registry).unwrap();
        // macOS FSEvents 首次在 worker 内建流的启动时序可超过 5s；这里验收
        // 的是 supervisor 的最终替换语义，不把平台建流延迟伪装成逻辑失败。
        for _ in 0..400 {
            health = handle.health();
            if health.topology_revision >= 2 && health.facts_roots_attached >= 1 { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(health.topology_revision, 2, "替换后 revision 单调 +1");
        assert_eq!(health.mode, WatcherMode::Active);
        assert_eq!(health.facts_roots_attached, 1, "临时目录存在，挂载即成功");
        assert_eq!(health.pending_roots, 0);

        handle.replace(WatchRegistry::new()).unwrap();
        for _ in 0..100 {
            health = handle.health();
            if health.topology_revision >= 3 { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(health.topology_revision, 3);
        assert_eq!(health.mode, WatcherMode::Disabled, "换回空拓扑回到 Disabled");
        assert_eq!(health.facts_roots_registered, 0);
        drop(handle); // 关停信号；线程自行退出
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真实 FS 事件端到端（macOS FSEvents / Linux inotify）：注册临时
    /// 目录为源根 → 写文件 → 去抖窗内收到 wake。依赖平台事件时序，
    /// **不进常规门禁**（spec §12：事件时序测试允许手跑）：
    /// `cargo test -p agent-vitals-runtime --features watcher watch_real_fs_event_wakes -- --ignored --nocapture`
    #[test]
    #[cfg(feature = "watcher")]
    #[ignore = "真实 FS 事件时序；本地手跑"]
    fn watch_real_fs_event_wakes() {
        let dir = std::env::temp_dir().join(format!(
            "avd-watch-it-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let WakeChannel { waker, slot } = TickWaker::channel();
        let mut reg = WatchRegistry::new();
        reg.register_source("claude-code", dir.clone());
        let handle = spawn_watcher(reg, waker);
        assert!(!handle.is_noop());

        // FSEvents 流是「从现在起」语义：spawn 返回 ≠ 流已建立。先留挂载
        // 窗，写一轮没动静就再写一轮（新文件名），总窗 20s。
        std::thread::sleep(Duration::from_millis(400));
        let mut woke = false;
        for round in 0..2 {
            let name = format!("sess-{round}.jsonl");
            std::fs::write(dir.join(&name), "{\"type\":\"assistant\"}\n").unwrap();
            if matches!(
                wait_for_wake(&slot, Duration::from_secs(10)),
                TickWait::Woken(_)
            ) {
                woke = true;
                break;
            }
        }
        assert!(woke, "20s 内未收到 wake（检查平台 watcher 与挂载时序）");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
