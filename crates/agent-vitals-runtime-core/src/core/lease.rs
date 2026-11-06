//! Stage B（spec §3.5/§7）：writer lease —— 双进程写互斥（DoD #3）。
//!
//! **冲突面**（R4 §7 Stage B）：托盘 tick 与 CLI 并写 `month.json`——
//! `atomic_write_json` 只保**单文件**原子（rename），不保 merge_month 的
//! read-modify-write **序列**（两个进程都读到旧 existing、各自 merge、各自
//! 写回 = 后写者吃掉前写者的合并，正是 2026-08 三倍计数事故的进程间版本）。
//! 本模块给「读状态 → 改 → 写回」的临界区一把跨进程锁。
//!
//! 机制：锁文件 `<dir>/.<name>.lock`（O_EXCL 原子创建）+ JSON 内容
//! `{holder, pid, acquired_at_ms, ttl_ms}`。
//!
//! - **TTL 陈旧偷取**：持锁进程 crash 会留下锁文件；过了 TTL 的锁视为
//!   陈旧，可被下一个获取者偷走。P0 不做 pid 存活探测（std 无 pid 存在性
//!   API，引 libc/sysinfo 违反本仓库依赖纪律）——代价是 crash 后最长阻塞
//!   一个 TTL，对毫秒级临界区这是可接受的保守值。
//! - **临界区必须短**：TTL 要覆盖最坏临界区时长。状态写（merge_today/
//!   merge_month）的临界区是毫秒级（两次 rename），TTL 2s；ingest 的
//!   临界区是 JSONL 追加 + 索引插入（毫秒级——**慢的 fold/emit 在锁外**），
//!   同 TTL。把 fold 关进锁里是错误用法。
//! - **等待语义**：`acquire_blocking` 每 10ms 重试至 max_wait，然后报
//!   `Held`。调用方（CLI/Tauri）拿到 `Held` 就如实失败——锁不是拿来排队
//!   长任务的，是保护短临界区的。
//!
//! **覆盖范围（如实）**：v0.9 的 lease 收口的是 **Rust 侧双进程**（托盘 +
//! CLI，spec 点名的冲突面）。Python 实现的 month.json 写入方（ClawHub
//! 发布形态）不认识这把锁——按 §7.1 Phased Python Diminishment，Python
//! 逐步退役，且 v0.9 DoD #7 明令 Python 不新增 writer；跨实现租约不在
//! 本版范围。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 单次获取的结果。`Held` 携带持有者信息——调用方的错误消息要能回答
/// 「谁在占」。
#[derive(Debug)]
pub enum LeaseError {
    /// 被别的进程持有且未过期。
    Held { holder: String, ttl_remaining_ms: u64 },
    /// I/O 错误（目录不可写等）。
    Io(std::io::Error),
}

impl std::fmt::Display for LeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LeaseError::Held { holder, ttl_remaining_ms } => write!(
                f,
                "writer lease held by `{holder}` ({ttl_remaining_ms}ms remaining)"
            ),
            LeaseError::Io(e) => write!(f, "lease io: {e}"),
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 单次尝试获取。成功返回守护（Drop = 释放）；被持有且未过期 → `Held`；
/// 过期锁被**原子 rename 偷取**。
///
/// **为什么偷取用 rename 而不是 unlink+create（审查 P1-2）**：unlink 之后、
/// create 之前是无主窗口——输家在这个窗口读到赢家刚建、还没写完 body 的
/// 锁文件 → 解析失败 → 也去偷 → **双持锁**（互斥失效，DoD #3 的核心保障
/// 破产）。rename 是原子的：把陈旧锁**整体搬走**（同一目录内 rename 只改
/// 目录项，两个偷取者恰好一个成功一个 ENOENT），锁路径上永远不存在
/// 「无主窗口」；搬走后 create_new 的 AlreadyExists = 别人已放了新锁 →
/// 如实报 Held。O_EXCL 只保护「路径上无文件时创建」，不保护 unlink 序列。
pub fn acquire(path: &Path, holder: &str, ttl_ms: u64) -> Result<FileLease, LeaseError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(LeaseError::Io)?;
    }
    // 单次取时钟：body 的 acquired_at_ms 与 identity 三元组必须同值——各调
    // 一次 now_ms() 时，跨毫秒边界的抢占会让 is_mine() 对自己的锁永假，
    // Drop 静默不删锁文件，同进程下一次 acquire 撞新鲜 TTL（2026-09-21
    // 独立验证代理在 ingest 测试里抓到的偶发 Held 根因）。
    let acquired_at = now_ms() as u64;
    let body = serde_json::json!({
        "holder": holder,
        "pid": std::process::id(),
        "acquired_at_ms": acquired_at,
        "ttl_ms": ttl_ms,
    });
    let write_lock = |p: &Path| -> Result<(), std::io::Error> {
        // O_EXCL：create_new 只在文件不存在时成功——与 rename 偷取配合后
        // 「成功创建」即唯一持锁者的全部依据。
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(p)?;
        f.write_all(body.to_string().as_bytes())?;
        f.sync_all()?;
        Ok(())
    };
    let identity = (
        holder.to_string(),
        std::process::id(),
        acquired_at,
    );
    match write_lock(path) {
        Ok(()) => Ok(FileLease {
            path: path.to_path_buf(),
            holder: identity.0,
            pid: identity.1,
            acquired_at_ms: identity.2,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // 已有锁文件。判读：可解析 → TTL 到期与否；读不出（crash 半行）→
            // 按 mtime 年龄判（body 写一半的**新鲜**锁绝不能偷——那是活人的
            // 创建窗口；只有 mtime 也老了才视为 crash 残留）。
            let parsed = std::fs::read_to_string(path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            let (lock_holder, ttl_remaining) = match parsed {
                Some(v) => {
                    let acquired = v.get("acquired_at_ms").and_then(|x| x.as_u64()).unwrap_or(0);
                    let ttl = v.get("ttl_ms").and_then(|x| x.as_u64()).unwrap_or(0);
                    let holder = v
                        .get("holder")
                        .and_then(|x| x.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let elapsed = now_ms().saturating_sub(acquired as u128) as u64;
                    (holder, ttl.saturating_sub(elapsed))
                }
                None => ("unreadable-lock".to_string(), u64::MAX),
            };
            // mtime 年龄：unreadable 锁只有老了才可偷（阈值取本调用者自己的
            // ttl——同一临界区族的量级）。
            let mtime_age = std::fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| m.elapsed().ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let stale = ttl_remaining == 0 || (ttl_remaining == u64::MAX && mtime_age > ttl_ms);
            if !stale {
                return Err(LeaseError::Held { holder: lock_holder, ttl_remaining_ms: ttl_remaining.min(u64::MAX - 1) });
            }
            // 偷：原子 rename 把陈旧锁整体搬走（无主窗口不存在）。ENOENT =
            // 同时有别的偷取者/释放者动过 → 回读现状如实报（blocking 会重试）。
            let stale_path = path.with_extension(format!("stale.{}", now_ms()));
            if std::fs::rename(path, &stale_path).is_err() {
                return Err(LeaseError::Held {
                    holder: "vanishing-lock".to_string(),
                    ttl_remaining_ms: 0,
                });
            }
            let _ = std::fs::remove_file(&stale_path); // 搬走的残尸清掉（best-effort）
            match write_lock(path) {
                Ok(()) => Ok(FileLease {
                    path: path.to_path_buf(),
                    holder: identity.0,
                    pid: identity.1,
                    acquired_at_ms: identity.2,
                }),
                // rename 与 create 之间被人放了新锁 → 不是我们的，如实 Held。
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err(LeaseError::Held { holder: "just-replaced".to_string(), ttl_remaining_ms: ttl_ms })
                }
                Err(e) => Err(LeaseError::Io(e)),
            }
        }
        Err(e) => Err(LeaseError::Io(e)),
    }
}

/// 阻塞式获取：每 10ms 重试直至 `max_wait_ms`，随后如实报 `Held`。
/// 短临界区专用——不要用这个 API 排队长任务。
pub fn acquire_blocking(
    path: &Path,
    holder: &str,
    ttl_ms: u64,
    max_wait_ms: u64,
) -> Result<FileLease, LeaseError> {
    let deadline = now_ms() + max_wait_ms as u128;
    loop {
        match acquire(path, holder, ttl_ms) {
            Ok(lease) => return Ok(lease),
            Err(LeaseError::Held { .. }) if now_ms() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
}

/// 持有的租约。Drop 兜底释放（best-effort）；正常路径应显式 `release()`
/// 拿到删除结果。
///
/// **释放必须校验归属（审计 #1，DoD #3 的收口）**：TTL 偷取允许别的进程
/// 在我们临界区超时后把锁偷走——此时锁文件已是别人的，无条件 remove 会
/// 删掉新持有者的锁、放进第三个进程 = 双持锁。所以两条释放路径都先比对
/// `holder + pid + acquired_at_ms` 三元组（acquire 时刻的身份快照），不匹配
/// = 锁已易主，**静默放弃删除**（我们的临界区已结束，放弃是安全的；新持有
/// 者的锁由它自己释放或由 TTL 兜底）。
#[derive(Debug)]
pub struct FileLease {
    path: PathBuf,
    holder: String,
    pid: u32,
    acquired_at_ms: u64,
}

impl FileLease {
    /// Keep a long-running harness ingest lease alive without changing its
    /// identity.  The lock body is atomically replaced, so contenders never
    /// observe a partial renewal.  Dropping the returned guard stops the
    /// heartbeat before the lease itself is released.
    pub fn heartbeat(&self, interval: Duration, ttl_ms: u64) -> LeaseHeartbeat {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let path = self.path.clone();
        let holder = self.holder.clone();
        let pid = self.pid;
        let acquired_at_ms = self.acquired_at_ms;
        let join = std::thread::spawn(move || {
            while !stop_thread.load(Ordering::Relaxed) {
                let mut waited = Duration::ZERO;
                while waited < interval && !stop_thread.load(Ordering::Relaxed) {
                    let step = (interval - waited).min(Duration::from_millis(100));
                    std::thread::sleep(step);
                    waited += step;
                }
                if stop_thread.load(Ordering::Relaxed) { break; }
                let Some(value) = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok()) else { break; };
                let ours = value.get("holder").and_then(|v| v.as_str()) == Some(holder.as_str())
                    && value.get("pid").and_then(|v| v.as_u64()) == Some(pid as u64)
                    && value.get("acquired_at_ms").and_then(|v| v.as_u64()) == Some(acquired_at_ms);
                if !ours { break; }
                let body = serde_json::json!({
                    "holder": holder.clone(), "pid": pid, "acquired_at_ms": acquired_at_ms,
                    "ttl_ms": ttl_ms.saturating_add(now_ms().saturating_sub(acquired_at_ms as u128) as u64),
                });
                let temporary = path.with_extension("renew");
                if std::fs::write(&temporary, body.to_string()).is_err() || std::fs::rename(&temporary, &path).is_err() {
                    let _ = std::fs::remove_file(&temporary);
                    break;
                }
            }
        });
        LeaseHeartbeat { stop, join: Some(join) }
    }

    /// 锁文件当前是否还是本租约的（acquire 时刻的身份快照三重匹配）。
    /// 读不出/解析失败的锁不是我们的（可能是别人 create 到一半的 body）。
    fn is_mine(&self) -> bool {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .is_some_and(|v| {
                v.get("holder").and_then(|x| x.as_str()) == Some(self.holder.as_str())
                    && v.get("pid").and_then(|x| x.as_u64()) == Some(self.pid as u64)
                    && v.get("acquired_at_ms").and_then(|x| x.as_u64())
                        == Some(self.acquired_at_ms)
            })
    }

    /// 显式释放（删除锁文件）。临界区结束即调——不等 Drop。锁已易主
    /// （TTL 超时被偷）→ 静默放弃，**绝不删别人的锁**；返回 Ok（释放的
    /// 语义目标是「不再持锁」，易主后本就不再持）。
    pub fn release(self) -> Result<(), std::io::Error> {
        let mine = self.is_mine();
        let path = self.path.clone();
        std::mem::forget(self); // release 自己负责，别让 Drop 再删一次
        if mine {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub struct LeaseHeartbeat {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Drop for LeaseHeartbeat {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() { let _ = join.join(); }
    }
}

impl Drop for FileLease {
    fn drop(&mut self) {
        if self.is_mine() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_lock(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "avd-lease-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn mutual_exclusion_between_two_holders() {
        let path = tmp_lock("mutex");
        let a = acquire(&path, "proc-a", 60_000).unwrap();
        let err = acquire(&path, "proc-b", 60_000).unwrap_err();
        match err {
            LeaseError::Held { holder, .. } => assert_eq!(holder, "proc-a"),
            other => panic!("expected Held, got {other:?}"),
        }
        a.release().unwrap();
        // 释放后立即可获取。
        let b = acquire(&path, "proc-b", 60_000).unwrap();
        b.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stale_lease_is_stolen_after_ttl() {
        let path = tmp_lock("stale");
        // 模拟 crash 残留：手工写一把早已过期的锁（holder 进程已死）。
        std::fs::write(
            &path,
            serde_json::json!({
                "holder": "dead-process",
                "pid": 999_999_999,
                "acquired_at_ms": now_ms() as u64 - 10_000,
                "ttl_ms": 1_000,
            })
            .to_string(),
        )
        .unwrap();
        let stolen = acquire(&path, "new-proc", 60_000).unwrap();
        stolen.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unreadable_lock_is_held_while_fresh_stolen_when_aged() {
        let path = tmp_lock("garbage");
        // crash 半行锁文件（刚写下的）：**不能偷**——那可能是别的进程
        // create_new 成功、body 还没写完的创建窗口（审查 P1-2：偷了就是双持锁）。
        std::fs::write(&path, "{\"holder\": \"crash").unwrap();
        let held = acquire(&path, "new-proc", 60_000).unwrap_err();
        assert!(
            matches!(held, LeaseError::Held { .. }),
            "新鲜的 unreadable 锁必须 Held，got {held:?}"
        );
        // 等 mtime 年龄超过偷取阈值（用调用方 ttl 当阈值）→ crash 残留可偷。
        std::thread::sleep(std::time::Duration::from_millis(30));
        let stolen = acquire(&path, "new-proc", 10).unwrap();
        stolen.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn blocking_acquire_waits_then_reports_holder() {
        let path = tmp_lock("block");
        let a = acquire(&path, "slow-holder", 60_000).unwrap();
        let started = std::time::Instant::now();
        let err = acquire_blocking(&path, "waiter", 60_000, 60).unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(50), "至少等了一轮重试");
        match err {
            LeaseError::Held { holder, .. } => assert_eq!(holder, "slow-holder"),
            other => panic!("expected Held, got {other:?}"),
        }
        // 持有者释放后，等待者能拿到。
        a.release().unwrap();
        let b = acquire_blocking(&path, "waiter", 60_000, 1_000).unwrap();
        b.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stale_holder_release_does_not_steal_the_new_holders_lock() {
        // 审计 #1：A 持锁超 TTL → B 偷走 → A 的 release/Drop 不得删 B 的锁
        // （否则 C 立刻 acquire 成功 = B/C 双持锁，DoD #3 破产）。
        let path = tmp_lock("ownership");
        let a = acquire(&path, "proc-a", 10).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        // B 偷走 A 的陈旧锁。
        let b = acquire(&path, "proc-b", 60_000).unwrap();
        // A 释放：锁已易主 → 静默放弃，文件（B 的锁）必须还在。
        a.release().unwrap();
        assert!(path.exists(), "A 的 release 不得删掉 B 的锁");
        // C 此刻 acquire 必须 Held（B 仍合法持有）——若 A 的释放删了 B 的锁，
        // 这里会直接成功 = 双持锁。
        let err = acquire(&path, "proc-c", 60_000).unwrap_err();
        assert!(matches!(err, LeaseError::Held { .. }), "B 必须仍持有，got {err:?}");
        // B 正常释放（锁是自己的）→ 文件删除，C 可获取。
        b.release().unwrap();
        let c = acquire(&path, "proc-c", 60_000).unwrap();
        c.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drop_also_respects_ownership_after_steal() {
        let path = tmp_lock("drop-ownership");
        let a = acquire(&path, "proc-a", 10).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let b = acquire(&path, "proc-b", 60_000).unwrap();
        drop(a); // Drop 兜底同样不得删 B 的锁
        assert!(path.exists(), "A 的 Drop 不得删掉 B 的锁");
        b.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drop_releases_the_lock_as_a_safety_net() {
        let path = tmp_lock("drop");
        {
            let _lease = acquire(&path, "leaky", 60_000).unwrap();
            // 不显式 release——Drop 兜底。
        }
        let next = acquire(&path, "next", 60_000).unwrap();
        next.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn heartbeat_prevents_long_ingest_lease_expiry() {
        let path = tmp_lock("heartbeat");
        let lease = acquire(&path, "long-ingest", 80).unwrap();
        let _heartbeat = lease.heartbeat(Duration::from_millis(20), 80);
        std::thread::sleep(Duration::from_millis(220));
        assert!(matches!(acquire(&path, "deleter", 80), Err(LeaseError::Held { .. })));
        drop(_heartbeat);
        lease.release().unwrap();
        let next = acquire(&path, "deleter", 80).unwrap();
        next.release().unwrap();
        let _ = std::fs::remove_file(&path);
    }
}
