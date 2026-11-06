//! 有界读闸门（`docs/RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md` §5.3）。
//!
//! 事故复盘（`EVENT_PROCESSING_AND_OBSERVABILITY_REVIEW.md` §1）：`#[tauri::command(async)]`
//! 修饰的同步函数体被 tauri 的宏放进 `async move {}` 由 `respond_async_serialized` spawn
//! 执行——**没有** `spawn_blocking`。并发的重查询命中 tokio worker，阻塞式 SQLite 直接
//! 跑在其上，N 个并发命令就钉死 N 个 worker，同时饿死 update check、价目拉取等真正的异步
//! 任务。`ReadGate` 是这条防线的另一半：把重查询的实际执行搬进阻塞线程池
//! （`tauri::async_runtime::spawn_blocking`），并用固定数量的许可把并发钉死在一个硬顶——
//! 即使 `ReadMemo` 全部 miss（比如价卡刚变、七个查询一起失效），并发也不会超过 permits。
//!
//! 不用 tokio 原语（`tokio::sync::Semaphore`）：本 crate 的依赖纪律不新增 tokio（spec §1.7），
//! `std::sync::{Mutex, Condvar}` 足够表达「阻塞获取一个许可、释放时唤醒等待者」。

use std::sync::{Condvar, Mutex};

/// 重查询并发硬顶。8 核真机上两路并发足够让工作台四个命令不互相串行，又把最坏情况
/// （全部 memo miss）钉在 2 核（spec §5.3）。
pub const HEAVY_READ_PERMITS: usize = 2;

struct State {
    available: usize,
    waiting: usize,
}

pub struct ReadGate {
    capacity: usize,
    state: Mutex<State>,
    cond: Condvar,
}

/// 持有的许可；`Drop` 释放并唤醒一个等待者。不可 `Clone`——一次 `acquire` 只授权一次
/// `release`，防止误用把同一个许可释放两次而把 `available` 计数吹爆。
pub struct ReadPermit<'a> {
    gate: &'a ReadGate,
}

impl Drop for ReadPermit<'_> {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        state.available += 1;
        drop(state);
        self.gate.cond.notify_one();
    }
}

/// 诊断快照（健康 DTO 用，REVIEW P4「自看护」在此有了可读信号，不必读 CPU）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReadGateStats {
    pub permits: usize,
    pub held: usize,
    pub waiting: usize,
}

impl ReadGate {
    pub fn new(permits: usize) -> Self {
        let permits = permits.max(1);
        Self {
            capacity: permits,
            state: Mutex::new(State { available: permits, waiting: 0 }),
            cond: Condvar::new(),
        }
    }

    /// 阻塞直到拿到一个许可。**必须在阻塞线程上调用**（`spawn_blocking` 内），
    /// 绝不能在 tokio worker 上直接调——那正是本原语要防止的阻塞。
    pub fn acquire(&self) -> ReadPermit<'_> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.waiting += 1;
        while state.available == 0 {
            state = self.cond.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.waiting -= 1;
        state.available -= 1;
        ReadPermit { gate: self }
    }

    pub fn try_acquire(&self) -> Option<ReadPermit<'_>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.available == 0 {
            return None;
        }
        state.available -= 1;
        Some(ReadPermit { gate: self })
    }

    pub fn stats(&self) -> ReadGateStats {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        ReadGateStats {
            permits: self.capacity,
            held: self.capacity.saturating_sub(state.available),
            waiting: state.waiting,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn permits_cap_concurrency_and_release_wakes_a_waiter() {
        let gate = Arc::new(ReadGate::new(2));
        let p1 = gate.acquire();
        let p2 = gate.acquire();
        assert!(gate.try_acquire().is_none(), "capacity is exhausted");

        let gate2 = Arc::clone(&gate);
        let acquired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let acquired2 = Arc::clone(&acquired);
        let handle = std::thread::spawn(move || {
            let _p3 = gate2.acquire(); // 阻塞直到 p1 释放
            acquired2.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(!acquired.load(std::sync::atomic::Ordering::SeqCst), "third acquire must still be blocked");
        drop(p1);
        handle.join().unwrap();
        assert!(acquired.load(std::sync::atomic::Ordering::SeqCst));
        drop(p2);
    }

    #[test]
    fn stats_reports_held_and_waiting() {
        let gate = ReadGate::new(2);
        assert_eq!(gate.stats(), ReadGateStats { permits: 2, held: 0, waiting: 0 });
        let p1 = gate.acquire();
        assert_eq!(gate.stats(), ReadGateStats { permits: 2, held: 1, waiting: 0 });
        let p2 = gate.acquire();
        assert_eq!(gate.stats(), ReadGateStats { permits: 2, held: 2, waiting: 0 });
        drop(p1);
        assert_eq!(gate.stats(), ReadGateStats { permits: 2, held: 1, waiting: 0 });
        drop(p2);
    }

    #[test]
    fn a_dropped_permit_can_be_reacquired_immediately() {
        let gate = ReadGate::new(1);
        {
            let _p = gate.acquire();
        }
        let _p2 = gate.acquire();
        assert!(gate.try_acquire().is_none());
    }
}
