//! 读侧 memo（`docs/RUNTIME_INVALIDATION_AND_READ_BACKPRESSURE_SPEC.md` §5.1）。
//!
//! 重查询按 `(query, scope, params, ReadVersion)` 缓存计算结果；同版本命中返回
//! `Arc<Value>`，版本前进即失效。它是与 UI 刷新纪律**无关**的硬保护：页面订阅者再
//! 怎么重复 invoke，同一版本下只付一次 SQL。
//!
//! **版本不只是权威 revision。** 2026-09-22 核对七个重查询的真实输入后发现它们不是
//! 权威库的纯函数：`PricingCards::current()` 读 `state/pricing-overrides.json`
//! （用户补卡 + 路由，桌面 IPC 与 MCP serve 两个写者，后者只读打开权威库、没法推进
//! revision），统计时区来自进程 `TZ`。这些输入变了 revision 不动——只以 revision 为键
//! 就会在用户刚补完价卡时继续端出旧价格，正是 `price_overrides.rs` 那段「读时合并、
//! 永远盖在最上面」注释要防的场景被缓存抵消。所以 [`ReadVersion`] = 权威 revision +
//! 配置指纹（覆盖文件**内容**哈希，不用 mtime——同秒两次写会漏 + 时区名）。
//!
//! 长期正确形状是把补卡/路由迁进权威库让 revision 自然覆盖（spec §5.1 方案 1）；
//! 指纹是在那之前诚实的过渡，不是终态。
//!
//! 锁纪律：锁内只做查/插，`compute` 在锁外；并发 miss 允许重复计算（写回时若已有更
//! 新 revision 的条目则不覆盖），不引入 per-key 条件变量——简单优先。命中返回 `Arc`，
//! 调用方不再深拷贝 Map（2026-09-05 `codex_merged_cached` 锁内深拷贝把并发命令串在
//! 锁上的教训）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

use agent_vitals_domain::source_identity::fnv1a64_hex;

/// 一次读的版本坐标：权威 revision + 配置指纹。两者都相等才算同版本。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ReadVersion {
    pub revision: u64,
    pub config: String,
}

impl ReadVersion {
    /// 从已打开的权威库句柄与 data_home 观测当前版本。库缺席（首装未同步）返回
    /// `None`——调用方直接算、不进 memo（空态不值得占槽，且没有 revision 可比）。
    pub fn observe(
        db: Option<&agent_vitals_data::authority::AuthorityDb>,
        data_home: &Path,
    ) -> Option<Self> {
        let db = db?;
        let revision = db.revision().ok()?;
        Some(Self {
            revision,
            config: config_fingerprint(data_home, &crate::clock::statistics_timezone_name()),
        })
    }
}

/// 权威库之外、会改变重查询结果的输入的指纹（spec §5.1「params 必须含影响结果的
/// 全部输入」在文件/环境面的落实）。目前两项：
/// - `state/pricing-overrides.json` 内容（缺场 = `absent`，与「空对象」不同——
///   `price_overrides::load` 对两者都当无覆盖，但指纹区分它们无害且更保守）；
/// - 统计时区 IANA 名。
///
/// 新增会影响读结果的文件/环境输入时**必须**进这里，`tests::fingerprint_covers_*`
/// 逐项钉住。
pub fn config_fingerprint(data_home: &Path, timezone_name: &str) -> String {
    let overrides_path = data_home.join("state").join("pricing-overrides.json");
    let overrides = match std::fs::read(&overrides_path) {
        Ok(bytes) => fnv1a64_hex(&bytes),
        Err(_) => "absent".to_string(),
    };
    let material = format!("overrides={overrides}\0tz={timezone_name}");
    fnv1a64_hex(material.as_bytes())
}

struct Entry {
    version: ReadVersion,
    value: Arc<Value>,
    last_used: u64,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    tick: u64,
}

/// 命中/未命中计数（健康 DTO 与验收 9.10 用）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoStats {
    pub hits: u64,
    pub misses: u64,
    pub entries: usize,
}

pub struct ReadMemo {
    inner: Mutex<Inner>,
    capacity: usize,
    hits: AtomicU64,
    misses: AtomicU64,
}

/// 进程级容量：七个重查询 × 常见参数（当月 + 前后月、几个日期）远不到 64。
pub const DEFAULT_CAPACITY: usize = 64;

impl Default for ReadMemo {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl ReadMemo {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            capacity: capacity.max(1),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    /// 进程级单例。所有 data_home 共用一张表，`scope` 进键区分。
    pub fn global() -> &'static ReadMemo {
        static MEMO: OnceLock<ReadMemo> = OnceLock::new();
        MEMO.get_or_init(ReadMemo::default)
    }

    fn key(query: &str, scope: &Path, params: &str) -> String {
        format!("{query}\0{}\0{params}", scope.display())
    }

    /// 同 `(query, scope, params)` 且版本相等 → 命中；否则在锁外 `compute` 并写回。
    ///
    /// `params` 是调用方**规范化**后的参数串（月份/日期/视图键……）。漏掉一个影响
    /// 结果的参数就是跨参数串缓存——spec 验收 9.12 要求每个接入点用参数变异测试钉住。
    pub fn get_or_compute(
        &self,
        query: &'static str,
        scope: &Path,
        params: &str,
        version: &ReadVersion,
        compute: impl FnOnce() -> Value,
    ) -> Arc<Value> {
        let key = Self::key(query, scope, params);
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.tick += 1;
            let tick = inner.tick;
            if let Some(entry) = inner.entries.get_mut(&key) {
                if entry.version == *version {
                    entry.last_used = tick;
                    self.hits.fetch_add(1, Ordering::Relaxed);
                    return Arc::clone(&entry.value);
                }
            }
        }
        self.misses.fetch_add(1, Ordering::Relaxed);
        let value = Arc::new(compute());
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.tick += 1;
        let tick = inner.tick;
        if let Some(existing) = inner.entries.get(&key) {
            // 并发 miss：别用更旧的 revision 盖掉更新的。同 revision 不同 config
            // 的两份没有序，后写赢（下一次读按自己的 config 判断命中与否）。
            if existing.version.revision > version.revision {
                return value;
            }
        } else if inner.entries.len() >= self.capacity {
            if let Some(victim) = inner
                .entries
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone())
            {
                inner.entries.remove(&victim);
            }
        }
        inner.entries.insert(
            key,
            Entry { version: version.clone(), value: Arc::clone(&value), last_used: tick },
        );
        value
    }

    pub fn stats(&self) -> MemoStats {
        let entries = self.inner.lock().unwrap_or_else(|e| e.into_inner()).entries.len();
        MemoStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            entries,
        }
    }

    /// 清空（测试与 `data-migrate` 一类重建库的路径用；正常运行不需要——版本键
    /// 已经让陈旧条目自然失效，只占槽直到被 LRU 淘汰）。
    pub fn clear(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn tmp_home(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "avr-read-memo-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(p.join("state")).unwrap();
        p
    }

    fn v(revision: u64, config: &str) -> ReadVersion {
        ReadVersion { revision, config: config.to_string() }
    }

    #[test]
    fn same_version_hits_and_returns_the_same_arc() {
        let memo = ReadMemo::with_capacity(8);
        let scope = Path::new("/h");
        let mut calls = 0;
        let a = memo.get_or_compute("q", scope, "2026-09", &v(1, "c"), || { calls += 1; json!({"n": 1}) });
        let b = memo.get_or_compute("q", scope, "2026-09", &v(1, "c"), || { calls += 1; json!({"n": 2}) });
        assert_eq!(calls, 1);
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(memo.stats(), MemoStats { hits: 1, misses: 1, entries: 1 });
    }

    #[test]
    fn revision_advance_misses_and_old_arc_is_not_mutated() {
        let memo = ReadMemo::with_capacity(8);
        let scope = Path::new("/h");
        let old = memo.get_or_compute("q", scope, "p", &v(1, "c"), || json!({"n": 1}));
        let new = memo.get_or_compute("q", scope, "p", &v(2, "c"), || json!({"n": 2}));
        assert_eq!(old["n"], 1, "a held Arc must never change under the caller");
        assert_eq!(new["n"], 2);
        assert_eq!(memo.stats().misses, 2);
    }

    #[test]
    fn config_change_at_same_revision_misses() {
        let memo = ReadMemo::with_capacity(8);
        let scope = Path::new("/h");
        let _ = memo.get_or_compute("q", scope, "p", &v(1, "c1"), || json!(1));
        let _ = memo.get_or_compute("q", scope, "p", &v(1, "c2"), || json!(2));
        assert_eq!(memo.stats(), MemoStats { hits: 0, misses: 2, entries: 1 });
    }

    #[test]
    fn every_key_component_participates() {
        // query / scope / params 任一不同都是不同条目（spec 9.12 的原语级面）。
        let memo = ReadMemo::with_capacity(8);
        let ver = v(1, "c");
        let _ = memo.get_or_compute("q1", Path::new("/a"), "p", &ver, || json!(1));
        let _ = memo.get_or_compute("q2", Path::new("/a"), "p", &ver, || json!(1));
        let _ = memo.get_or_compute("q1", Path::new("/b"), "p", &ver, || json!(1));
        let _ = memo.get_or_compute("q1", Path::new("/a"), "p2", &ver, || json!(1));
        assert_eq!(memo.stats(), MemoStats { hits: 0, misses: 4, entries: 4 });
    }

    #[test]
    fn stale_concurrent_writeback_does_not_overwrite_newer_revision() {
        let memo = ReadMemo::with_capacity(8);
        let scope = Path::new("/h");
        // 先有 rev 2 的条目，再来一个 rev 1 的迟到写回（模拟并发 miss 的慢线程）。
        let _ = memo.get_or_compute("q", scope, "p", &v(2, "c"), || json!("new"));
        let late = memo.get_or_compute("q", scope, "p", &v(1, "c"), || json!("old"));
        assert_eq!(*late, json!("old"), "the late caller still gets its own result");
        let again = memo.get_or_compute("q", scope, "p", &v(2, "c"), || json!("recomputed"));
        assert_eq!(*again, json!("new"), "rev 2 entry must survive the stale writeback");
    }

    #[test]
    fn capacity_evicts_least_recently_used() {
        let memo = ReadMemo::with_capacity(2);
        let scope = Path::new("/h");
        let ver = v(1, "c");
        let _ = memo.get_or_compute("q", scope, "a", &ver, || json!(1));
        let _ = memo.get_or_compute("q", scope, "b", &ver, || json!(2));
        let _ = memo.get_or_compute("q", scope, "a", &ver, || json!(1)); // a 最近用过
        let _ = memo.get_or_compute("q", scope, "c", &ver, || json!(3)); // 淘汰 b
        assert_eq!(memo.stats().entries, 2);
        let mut a_recomputed = false;
        let _ = memo.get_or_compute("q", scope, "a", &ver, || { a_recomputed = true; json!(1) });
        assert!(!a_recomputed, "a survived (it was used more recently than b)");
        let mut recomputed = false;
        let _ = memo.get_or_compute("q", scope, "b", &ver, || { recomputed = true; json!(2) });
        assert!(recomputed, "b was the LRU victim");
    }

    #[test]
    fn fingerprint_covers_overrides_file_content() {
        let home = tmp_home("fp-overrides");
        let absent = config_fingerprint(&home, "Asia/Shanghai");
        let path = home.join("state").join("pricing-overrides.json");
        std::fs::write(&path, r#"{"cards":{}}"#).unwrap();
        let empty = config_fingerprint(&home, "Asia/Shanghai");
        assert_ne!(absent, empty, "absent and empty object are distinct inputs");
        std::fs::write(&path, r#"{"cards":{"minimax":{"m":{"in":1}}}}"#).unwrap();
        let with_card = config_fingerprint(&home, "Asia/Shanghai");
        assert_ne!(empty, with_card, "a saved price card must invalidate");
        // 同内容再写一次（mtime 变、内容不变）→ 指纹不变：按内容不按 mtime。
        std::fs::write(&path, r#"{"cards":{"minimax":{"m":{"in":1}}}}"#).unwrap();
        assert_eq!(with_card, config_fingerprint(&home, "Asia/Shanghai"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn fingerprint_covers_timezone() {
        let home = tmp_home("fp-tz");
        assert_ne!(
            config_fingerprint(&home, "Asia/Shanghai"),
            config_fingerprint(&home, "America/Los_Angeles")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn observe_is_none_without_a_database() {
        let home = tmp_home("observe-none");
        assert!(ReadVersion::observe(None, &home).is_none());
        let _ = std::fs::remove_dir_all(&home);
    }
}
