//! 状态写链的 **I/O + 时间侧**（R1c）。
//!
//! 纯合并规则在 core（`agent_vitals_domain::state`），本模块只做：state 目录定位、
//! 原子写（递归 sort_keys + indent=2，逐字节复刻 Python `_atomic_write`）、
//! UTC now，以及导航快照写入口：`write_oneline` / `append_session_history`。
//! 日/月/告警/预算的业务数据已由 SQL authority 管理，不能通过本模块写入。
//!
//! 逐字节一致性由 `tests/test_cli_matrix.py::CliMatrix` 的差分钉住（同一 HOME
//! 跑 Python 与 Rust 两边，`generated_at` / `archived_at` 打码后文件逐字节相等）。
//! 与 `budget.rs` 同款边界：这里不重写任何算术。
//!
//! **flock 已知限制**（2026-08 决定，不是 bug）：`std::fs::File::lock` 是 Rust
//! 1.89 才进 std，本 crate MSRV 1.74。Python 用 `fcntl.flock` 防并发
//! read-modify-write 互相覆盖；这里靠「写 tmp → rename」的原子性（Python 自己的
//! 注释也承认 rename 已经原子，锁只防两个并发审计各读各写）。tick 的单写者假设
//! 成立（R1a 起只有一个 tick）；真正的并发防护是 R1d 的 writer_epoch/owner
//! fencing，那才是有明确归宿的下一步，而不是在这里抄一把 std 里没有的 flock。
//!
//! **write_config（config.toml 写）不在本模块** —— 它是 TOML 文本手术（Python
//! `budget.write_config` 的 append/upsert），不是 tick 写链的一环（tick 不写配置，
//! 配置是用户 `budget set` 动作），随 R1d 的 `budget set` CLI 落地。

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::home::data_home;
use agent_vitals_domain::util::civil_from_unix_secs;

use agent_vitals_domain::state as state_core;

/// 数据根 `state/` 目录 —— 与 Python `state.state_dir()` 同路径。
/// `pub(crate)`：R1d 的 `agent::takeover`（fold 驱动）复用同一个根。
pub fn state_dir() -> PathBuf {
    data_home().join("state")
}

/// 复刻 Python `state._read`：缺文件 / 坏 JSON → None（「缺列不编列」）。
/// `pub(crate)`：R1d 的 `agent::takeover` 读 manifest/ledger/machine.json 复用。
pub fn read_json(p: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

/// 复刻 Python `_now_iso()` = `datetime.now(timezone.utc).isoformat()`。
///
/// 微秒为 0 时 Python **省略** `.000000`（`datetime(...).isoformat()` 不输出全零
/// 分数）—— 这里也省略，否则亚秒为 0 的那一刻写出的时间戳与 Python 格式不符。
/// 差分测试里 `generated_at` 一律打码，所以这个格式只影响真实写出的文件与
/// Python 读者（`fromisoformat` 两种都吃）。
pub fn now_iso_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (y, m, d) = civil_from_unix_secs(secs, 0);
    let micros = now.subsec_micros();
    let hh = (secs % 86400) / 3600;
    let mm = (secs % 3600) / 60;
    let ss = secs % 60;
    let frac = if micros == 0 {
        String::new()
    } else {
        format!(".{micros:06}")
    };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}{frac}+00:00")
}

/// 递归按 key 排序 —— 复刻 Python `json.dump(sort_keys=True)` 的**每一层**排序。
/// serde_json 的 `to_string_pretty` 只保证结构，key 顺序由插入顺序（preserve_order）
/// 决定；必须显式排一遍才能与 Python 逐字节一致。
pub fn sort_keys(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut pairs: Vec<(String, Value)> = m
                .iter()
                .map(|(k, val)| (k.clone(), sort_keys(val)))
                .collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out = Map::new();
            for (k, val) in pairs {
                out.insert(k, val);
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

/// 原子写 —— 复刻 Python `state._atomic_write`：写 `<file>.tmp.<pid>` → fsync →
/// `rename`。POSIX rename 原子：任何读者要么见旧版要么见新版。出错清理 tmp，
/// 不给 state 目录留垃圾。
pub fn atomic_write_json(path: &Path, data: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("cannot create state dir");
    }
    let sorted = sort_keys(data);
    let text = serde_json::to_string_pretty(&sorted)
        .expect("state values are always serializable (no datetime/NaN)");
    // serde_json 的 pretty 输出与 Python indent=2 的 `", "`/`": "` 逐字节一致；
    // to_string_pretty 不补尾换行，Python json.dump 也不补 —— 一致。
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("state.json");
    let tmp_path = path.with_file_name(format!("{file_name}.tmp.{}", std::process::id()));
    let write_result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?; // Python 的 flush + fsync
        std::fs::rename(&tmp_path, path)?; // atomic on POSIX
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        panic!("atomic write to {path:?} failed: {e}");
    }
}

/// 复刻 `write_oneline(audit)`：单次审计快照，原地覆盖 + schema_version + generated_at。
pub fn write_oneline(audit: &Value) -> PathBuf {
    let path = state_dir().join("oneline.json");
    let mut data = audit.clone();
    data["schema_version"] = json!(state_core::SCHEMA_VERSION);
    data["generated_at"] = json!(now_iso_utc());
    atomic_write_json(&path, &data);
    path
}

/// Python `json.dumps` 默认（无 indent）分隔符：`", "` 与 `": "`。serde_json 内置
/// compact 是 `,` `:`（无空格），与 Python **逐字节不一致** —— sessions.jsonl 的
/// 行格式是 Python 读者还在用的契约，必须一致。用自定义 Formatter 复刻。
struct PyCompact;

impl serde_json::ser::Formatter for PyCompact {
    fn begin_object<W>(&mut self, writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        writer.write_all(b"{")
    }
    fn end_object<W>(&mut self, writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        writer.write_all(b"}")
    }
    fn begin_array<W>(&mut self, writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        writer.write_all(b"[")
    }
    fn end_array<W>(&mut self, writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        writer.write_all(b"]")
    }
    fn begin_object_key<W>(&mut self, writer: &mut W, first: bool) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        if !first {
            writer.write_all(b", ")?;
        }
        Ok(())
    }
    // 这个 serde_json 版本里分隔符的归属：`end_object_key` 默认**什么都不写**，
    // 冒号由 `begin_object_value` 负责（旧版是 end_object_key 写 `:`）。两边都覆写
    // 会把冒号写两遍 —— `{...": :"}` 就是这么来的。改成了 Python 的分隔符
    // （`", "` / `": "`）必须只写一次，所以 key 分隔放在 `begin_object_value`。
    fn end_object_key<W>(&mut self, _writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        Ok(())
    }
    fn begin_object_value<W>(&mut self, writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        writer.write_all(b": ")
    }
    fn begin_array_value<W>(&mut self, writer: &mut W, first: bool) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        if !first {
            writer.write_all(b", ")?;
        }
        Ok(())
    }
    fn end_array_value<W>(&mut self, _writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + std::io::Write,
    {
        Ok(())
    }
}

/// 用 Python 分隔符序列化（不 sort_keys —— Python 的 JSONL 行也不排）。
fn py_compact_json(v: &Value) -> String {
    let mut out = Vec::new();
    {
        use serde::Serialize;
        let mut ser = serde_json::Serializer::with_formatter(&mut out, PyCompact);
        v.serialize(&mut ser)
            .expect("state values are serializable");
    }
    String::from_utf8(out).expect("JSON output is valid UTF-8")
}

/// 复刻 `append_session_history(summary)`：append 一行到 sessions.jsonl，自动补
/// generated_at（已有则不覆盖）。JSONL 用 Python 默认分隔符（`,` + `:` 带空格），
/// 不 sort_keys —— 与 `state.py` 的 `json.dumps(payload, ensure_ascii=False)` 一致。
pub fn append_session_history(summary: &Value) -> PathBuf {
    let path = state_dir().join("sessions.jsonl");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("cannot create state dir");
    }
    let mut payload = summary.clone();
    if payload.get("generated_at").is_none() {
        payload["generated_at"] = json!(now_iso_utc());
    }
    let line = py_compact_json(&payload);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .expect("cannot open sessions.jsonl for append");
    f.write_all(line.as_bytes())
        .expect("cannot append to sessions.jsonl");
    f.write_all(b"\n").expect("cannot append to sessions.jsonl");
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 环境锁是进程级的（util::ENV_LOCK），不是本模块局部的 —— budget 的测试
    /// 也改 AGENT_VITALS_HOME，各自一把锁就互相踩踏（见 util.rs 注释）。
    /// tmp_home 的唯一化计数器（每个测试独立 home，见 tmp_home 注释）。
    static HOME_SEQ: AtomicUsize = AtomicUsize::new(0);

    /// 把 AGENT_VITALS_HOME 指到夹具根，Drop 时恢复原值。
    struct TestEnvGuard {
        prev: Option<String>,
    }
    impl TestEnvGuard {
        fn set(home: &Path) -> Self {
            let prev = std::env::var("AGENT_VITALS_HOME").ok();
            std::env::set_var("AGENT_VITALS_HOME", home);
            TestEnvGuard { prev }
        }
    }
    impl Drop for TestEnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
                None => std::env::remove_var("AGENT_VITALS_HOME"),
            }
        }
    }

    fn tmp_home(t: &std::path::Path) -> PathBuf {
        // 每个测试一个**唯一**子目录：所有测试共用同一 base（`av-state-test-<pid>`），
        // 若都写同一个 `home`，today.json/month.json/archive 会在测试间泄漏 ——
        // 前一个测试留下的桶被后一个合并，`merge_today_writes_filtered_buckets`
        // 的 150 变 160 就是这么来的（上一测试 hour9=10 残留）。序列号保证隔离。
        let seq = HOME_SEQ.fetch_add(1, Ordering::Relaxed);
        let home = t.join(format!("home-{seq}"));
        std::fs::create_dir_all(home.join("state")).unwrap();
        home
    }

    #[test]
    fn now_iso_utc_is_python_shape() {
        // Python `datetime.now(timezone.utc).isoformat()`：UTC `+00:00` 后缀。
        let s = now_iso_utc();
        let has_t = s.contains('T');
        let has_offset = s.ends_with("+00:00");
        let date_ok = s.len() >= 19 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-';
        assert!(has_t && has_offset && date_ok, "unexpected shape: {s}");
    }

    #[test]
    fn sort_keys_recursive() {
        // Python `sort_keys=True` 排每一层；数组不排序（保持顺序）。
        let v = json!({"b": 1, "a": {"d": 2, "c": 3}, "arr": [{"y": 1, "x": 2}]});
        let sorted = sort_keys(&v);
        assert_eq!(
            sorted,
            json!({"a": {"c": 3, "d": 2}, "arr": [{"x": 2, "y": 1}], "b": 1})
        );
        let text = serde_json::to_string_pretty(&sorted).unwrap();
        assert!(text.find("\"a\": {").is_some());
    }

    #[test]
    fn atomic_write_sorts_keys_and_no_trailing_newline() {
        let _env = crate::ENV_LOCK.lock().unwrap();
        let home =
            tmp_home(&std::env::temp_dir().join(format!("av-state-test-{}", std::process::id())));
        let _guard = TestEnvGuard::set(&home);
        let p = state_dir().join("probe.json");
        atomic_write_json(&p, &json!({"z": 1, "a": {"m": 2, "l": 3}}));
        let text = std::fs::read_to_string(&p).unwrap();
        // 与 Python json.dump(indent=2, sort_keys=True) 逐字节：2 空格缩进 + 排序 + 无尾换行
        assert_eq!(
            text,
            "{\n  \"a\": {\n    \"l\": 3,\n    \"m\": 2\n  },\n  \"z\": 1\n}"
        );
    }

    #[test]
    fn write_oneline_stamps_metadata() {
        let _env = crate::ENV_LOCK.lock().unwrap();
        let home =
            tmp_home(&std::env::temp_dir().join(format!("av-state-test-{}", std::process::id())));
        let _guard = TestEnvGuard::set(&home);
        let summary = json!({"session_id": "s1", "tokens_total": 100});
        let p = write_oneline(&summary);
        assert!(p.is_file());
        let f = read_json(&p).unwrap();
        assert_eq!(f["session_id"], "s1");
        assert_eq!(f["schema_version"], state_core::SCHEMA_VERSION);
        assert!(f.get("generated_at").is_some());
    }

    #[test]
    fn append_session_history_appends_with_py_separators() {
        // 行格式与 Python `json.dumps(payload, ensure_ascii=False)` 逐字节一致
        // （`, ` 与 `: ` 分隔符，非 serde 默认的 `,` `:`）。
        let _env = crate::ENV_LOCK.lock().unwrap();
        let home =
            tmp_home(&std::env::temp_dir().join(format!("av-state-test-{}", std::process::id())));
        let _guard = TestEnvGuard::set(&home);
        let summary = json!({"session_id": "s1", "cost_cny": 0.5});
        append_session_history(&summary);
        append_session_history(&summary);
        let lines: Vec<String> = std::fs::read_to_string(state_dir().join("sessions.jsonl"))
            .unwrap()
            .lines()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(lines.len(), 2);
        assert!(
            lines[0].contains("\": \"s1\", \"cost_cny\": 0.5"),
            "got: {}",
            lines[0]
        );
        // generated_at 已自动补上
        let parsed: Value = serde_json::from_str(&lines[0]).unwrap();
        assert!(parsed.get("generated_at").is_some());
    }
}
