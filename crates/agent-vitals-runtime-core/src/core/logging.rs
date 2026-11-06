//! 最小文件日志（`docs/EVENT_PROCESSING_AND_OBSERVABILITY_REVIEW.md` P1）。
//!
//! **不是 `tracing`。** 这批调用点（watcher 后端故障、子进程 stderr、sync-facts
//! 告警）都是 tick 级频率，不是热路径——评审原文的取舍已经写明「不为日志引入
//! tokio/async，std 线程 + 环形缓冲足够」，本模块更进一步：连线程都不需要，
//! 一把 `Mutex` 同步写就够，与仓库其余「手写而不是拉包」的纪律（civil 日期
//! 数学、FNV 哈希）同款。
//!
//! **双出口**：`log_warn`/`log_error` 同时 `eprintln!` 一份（CLI 终端用户不
//! 因为这次改动失去现在能看到的东西）+ 落一份到 `<data_home>/logs/app.log`
//! （桌面场景下 stderr 去了 launchd 空洞，这份文件是唯一留痕）。`log_info`
//! 只落文件——不给 CLI 终端添 REVIEW 之前没有的噪音。
//!
//! **本地日志可以含路径与细节（不出机器）**——2026-09-19 数据政策：日志文件
//! 从不离开本机，本模块不做任何网络行为；导出面（诊断包）的脱敏是另一层职责，
//! 不在这里做。
//!
//! **失败即放弃，绝不影响调用方**：目录建不出来、文件锁跌了、磁盘满了——都
//! 静默吞掉，下一次调用重试（不缓存「已失败」状态，给瞬时故障自愈的机会）。
//! 日志基础设施本身出问题，不能成为第二个需要人工介入的故障源。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 单个日志级别。三档足够——没有 DEBUG/TRACE：这批调用点本来就是「值得让人
/// 看见的异常」，不是逐事件追踪（那种量级需要真正的 tracing 基础设施，不在
/// 本次范围）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// 单条记录写入前的最大字节数——防一次性把整段子进程 stderr（可能几十 KB 的
/// 堆栈/回溯）糊进日志，几条这样的记录就能把 2MB 的滚动窗口挤空。
const MAX_MESSAGE_BYTES: usize = 4096;

/// 触发滚动的单文件大小上限（REVIEW P1：5×2MB，保留 ~10MB）。
const ROTATE_AT_BYTES: u64 = 2 * 1024 * 1024;

/// 滚动保留的历史文件数（`app.log.1` .. `app.log.5`）。
const MAX_ROTATED_FILES: usize = 5;

const LOG_DIR: &str = "logs";
const LOG_BASENAME: &str = "app.log";

struct LogFile {
    file: File,
    /// 上次 `metadata()` 探测到的大小——避免每条记录都 stat，只在探测值已经
    /// 接近阈值时才重新 stat 一次确认（写入量级低，这个优化目前用不上，但
    /// 保留字段位置方便以后需要时加）。
    approx_bytes: u64,
}

static LOG: OnceLock<Mutex<Option<LogFile>>> = OnceLock::new();

fn state() -> &'static Mutex<Option<LogFile>> {
    LOG.get_or_init(|| Mutex::new(None))
}

/// 日志目录 + 文件路径，由 `crate::home::data_home()` 派生——与事实 JSONL、
/// SQLite 权威库同一个根，诊断包导出时按同一份 `data_home` 找得到。
pub fn log_path() -> PathBuf {
    crate::home::data_home().join(LOG_DIR).join(LOG_BASENAME)
}

/// 滚动时各历史文件的（源 → 目标）改名序列，从最老到最新倒序生成，避免
/// 覆盖尚未搬走的文件。纯函数，独立于文件系统，测试直接钉序列本身。
fn rotation_plan(dir: &Path, base: &str, max_files: usize) -> Vec<(PathBuf, PathBuf)> {
    let mut plan = Vec::with_capacity(max_files);
    for i in (1..max_files).rev() {
        plan.push((
            dir.join(format!("{base}.{i}")),
            dir.join(format!("{base}.{}", i + 1)),
        ));
    }
    plan.push((dir.join(base), dir.join(format!("{base}.1"))));
    plan
}

/// 执行一次滚动：先删最老的一份（存在才删，不存在不算错误），再按
/// `rotation_plan` 逐个改名（源不存在就跳过——文件数没长满时这是常态）。
fn rotate(dir: &Path, base: &str) {
    let oldest = dir.join(format!("{base}.{MAX_ROTATED_FILES}"));
    let _ = std::fs::remove_file(&oldest);
    for (from, to) in rotation_plan(dir, base, MAX_ROTATED_FILES) {
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
}

/// 一条记录格式化为单行文本：时间戳 + 定宽级别 + 定宽组件名 + 消息。消息里的
/// 换行替换成字面 `\n`——保持「一条记录一行」，方便 `grep`/`tail` 不需要多行
/// 状态机。超长消息在替换后截断，末尾标 `…[truncated]`。
fn format_line(level: Level, component: &str, message: &str) -> String {
    let now = jiff::Timestamp::now();
    let flattened: String = message
        .chars()
        .map(|c| match c {
            '\n' => '\u{2424}', // 可见的换行占位符（␤），比反斜杠转义更不容易和真实反斜杠混淆
            '\r' => ' ',
            c => c,
        })
        .collect();
    let truncated = if flattened.len() > MAX_MESSAGE_BYTES {
        let mut cut = MAX_MESSAGE_BYTES;
        while !flattened.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…[truncated]", &flattened[..cut])
    } else {
        flattened
    };
    format!("{now} {:<5} {:<16} {truncated}\n", level.as_str(), component)
}

/// 确保日志文件已打开（惰性首建），必要时先滚动。失败（目录建不出来、
/// 打不开文件）返回 `None`，调用方吞掉——这不该是第二个需要盯着的故障源。
fn ensure_open(slot: &mut Option<LogFile>) -> Option<&mut LogFile> {
    if slot.is_none() {
        let path = log_path();
        let dir = path.parent()?.to_path_buf();
        std::fs::create_dir_all(&dir).ok()?;
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() >= ROTATE_AT_BYTES {
                rotate(&dir, LOG_BASENAME);
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).ok()?;
        let approx_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        *slot = Some(LogFile { file, approx_bytes });
    }
    slot.as_mut()
}

/// 写一条记录（内部：拿锁、必要时滚动、追加、更新近似大小）。滚动检查用的
/// 是内存里追踪的 `approx_bytes`（每次写入后累加），不是每条都 `stat`——
/// 调用频率是 tick 级，这点精度足够，判定漂移的上限就是「最后一次写超阈值
/// 多出来的那几十字节」。
fn write_line(level: Level, component: &str, message: &str) {
    let line = format_line(level, component, message);
    let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
    if matches!(&*guard, Some(log) if log.approx_bytes >= ROTATE_AT_BYTES) {
        // 上一次写之后已经过阈值：关掉当前句柄、显式滚动，`ensure_open` 下面
        // 重开时看到的是滚动后的空文件（不依赖它自己那份 metadata 兜底检查
        // 去猜「该不该滚」——这里已经知道答案）。
        guard.take();
        if let Some(dir) = log_path().parent() {
            rotate(dir, LOG_BASENAME);
        }
    }
    let Some(log) = ensure_open(&mut guard) else { return };
    if log.file.write_all(line.as_bytes()).is_ok() {
        log.approx_bytes += line.len() as u64;
    }
}

/// 极简 `RUST_LOG` 读取——**不是** `tracing`/`env_logger` 那套 `EnvFilter`
/// （没有 per-target/per-module 级别，没有 `off`/`error`/`warn` 分档），只回答
/// 一个问题：「`log_info` 要不要也打到 stderr」。值里含 `info`/`debug`/`trace`
/// （大小写不敏感的子串匹配，`RUST_LOG=agent_vitals=debug`/`RUST_LOG=info`
/// 都命中）就升级。`log_warn`/`log_error` 不受这个开关影响——它们的 stderr
/// 可见性是「不因这次改动倒退」的既有承诺，不是可选项。
///
/// 每次调用都现读 env（不缓存）——这不是热路径（tick 级频率），现读换来的是
/// 可测试性：缓存在 `OnceLock` 里的话，同一测试进程里第一个用到它的测试会
/// 把值锁死，后面想测「关掉再打开」就无解了（`data_home()` 同样不缓存，同一
/// 个理由）。
fn stderr_shows_info() -> bool {
    std::env::var("RUST_LOG")
        .map(|v| {
            let v = v.to_ascii_lowercase();
            v.contains("info") || v.contains("debug") || v.contains("trace")
        })
        .unwrap_or(false)
}

/// 默认仅落文件，不打扰终端——用于「值得留痕但不是异常」的记录（watcher 健康
/// 状态跳变、子进程成功但带警告输出）。设了 `RUST_LOG=info`（或
/// `debug`/`trace`）时也打到 stderr——本地调试用，与 REVIEW P1「CLI 侧
/// `RUST_LOG` 走同一 subscriber」同一个诉求的最小实现。
pub fn log_info(component: &str, message: &str) {
    if stderr_shows_info() {
        eprintln!("[agent-vitals] {component}: {message}");
    }
    write_line(Level::Info, component, message);
}

/// 落文件 + `eprintln!`——CLI 终端里照旧看得见（不因这次改动倒退），桌面场景
/// 下这份文件是唯一留痕。
pub fn log_warn(component: &str, message: &str) {
    eprintln!("[agent-vitals] {component}: {message}");
    write_line(Level::Warn, component, message);
}

/// 同 [`log_warn`]，级别更高。
pub fn log_error(component: &str, message: &str) {
    eprintln!("[agent-vitals] {component}: {message}");
    write_line(Level::Error, component, message);
}

// ---- 诊断包导出面（REVIEW P1「诊断包 v2 增补：日志尾…含导出脱敏」）----
//
// 本地文件本身允许含路径与细节（2026-09-19 政策：不出机器）；这份日志的
// 消息里确实有——`watch {path} 失败`、子进程 stderr 透传，都可能带绝对路径。
// 导出面必须做脱敏投影，这两个函数就是那层投影，只在导出时调用，从不影响
// 落盘内容本身。

/// 最长一次脱敏读取的行数——诊断包要的是"最近发生了什么"，不是完整历史；
/// 5×2MB 的滚动窗口顶格也就几万行，几百行的尾巴够看清一次事故的时间线。
pub const DIAGNOSTIC_TAIL_MAX_LINES: usize = 200;

/// 路径脱敏（纯函数，独立于文件系统）：不是通用路径检测，是「已知最常见的
/// 敏感子串替换」——与 Python 扫描器 `--redact-names`（先收集姓名、最长优先
/// 替换）同一纪律，宁可保守多删，不可能查全。两道：
/// 1. 精确替换 `home`（本仓库几乎所有路径都在 `~/.agent-vitals`/`~/.claude`/
///    `~/.codex` 之类的 home 子目录下，这一道覆盖绝大多数情况）；
/// 2. 兜底扫 `/Users/<name>`、`/home/<name>`、`C:\Users\<name>` 前缀（覆盖
///    「用户手选了 home 之外的自定义 source root」或「消息里引用了别的账户
///    路径」——只替换到用户名这一段，后面的相对路径留着：诊断价值在
///    「哪个子系统」，不在「谁的机器」）。
pub fn redact_path_like(text: &str, home: &std::path::Path) -> String {
    let mut out = text.to_string();
    if let Some(home_str) = home.to_str() {
        if !home_str.is_empty() {
            out = out.replace(home_str, "~");
        }
    }
    out = redact_user_prefix(&out, "/Users/");
    out = redact_user_prefix(&out, "/home/");
    out = redact_user_prefix(&out, r"C:\Users\");
    out
}

/// 把 `text` 里每个 `prefix<username><分隔符或结尾>` 替换成 `~<分隔符或结尾>`——
/// 用户名段整体丢弃，分隔符之后的相对路径原样保留。
fn redact_user_prefix(text: &str, prefix: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find(prefix) {
        result.push_str(&rest[..idx]);
        result.push('~');
        let after_prefix = &rest[idx + prefix.len()..];
        let name_end = after_prefix.find(['/', '\\', ' ', '\n', '\t']).unwrap_or(after_prefix.len());
        rest = &after_prefix[name_end..];
    }
    result.push_str(rest);
    result
}

/// 读日志文件最后 `max_lines` 行并逐行脱敏——诊断包导出唯一调用点。文件
/// 缺席/打不开返回空 vec（不是错误：新装机器本来就没有日志，诊断包照样能
/// 生成，只是这一节是空的，不编造）。整份文件读进内存再取尾——日志滚动上限
/// 2MB，不值得为这个体量写流式 tail 算法。
pub fn read_redacted_tail(max_lines: usize) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(log_path()) else {
        return Vec::new();
    };
    let home = crate::core::home::harness_dir();
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].iter().map(|line| redact_path_like(line, &home)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "avr-logging-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn format_line_flattens_newlines_and_pads_columns() {
        let line = format_line(Level::Warn, "watcher", "line one\nline two");
        assert!(line.contains("WARN "));
        assert!(line.contains("watcher"));
        assert_eq!(line.matches('\n').count(), 1, "only the trailing newline may remain: {line:?}");
        assert!(line.ends_with('\n'));
        assert!(line.contains('\u{2424}'), "embedded newline becomes a visible placeholder");
    }

    #[test]
    fn format_line_truncates_oversized_messages() {
        let huge = "x".repeat(MAX_MESSAGE_BYTES * 2);
        let line = format_line(Level::Error, "sync_service", &huge);
        assert!(line.contains("…[truncated]"));
        assert!(line.len() < huge.len(), "must be materially shorter than the input");
    }

    #[test]
    fn rotation_plan_shifts_oldest_first_without_clobbering() {
        let dir = PathBuf::from("/data/home/logs");
        let plan = rotation_plan(&dir, "app.log", 5);
        // 必须从 4→5 开始、app.log→1 结束：任何相反顺序都会在真实改名时
        // 先把 app.log.1 覆盖掉再搬 app.log.2 过去，丢一份历史。
        assert_eq!(
            plan,
            vec![
                (dir.join("app.log.4"), dir.join("app.log.5")),
                (dir.join("app.log.3"), dir.join("app.log.4")),
                (dir.join("app.log.2"), dir.join("app.log.3")),
                (dir.join("app.log.1"), dir.join("app.log.2")),
                (dir.join("app.log"), dir.join("app.log.1")),
            ]
        );
    }

    /// `AGENT_VITALS_HOME` 是进程级状态（`std::env::set_var`），并行跑的其他
    /// 测试用例会看到同一个值——与 `query::summary::tests::with_home` 同款，
    /// 靠 `crate::ENV_LOCK` 序列化，不能省。
    #[test]
    fn writes_land_in_the_log_file_under_data_home() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("basic");
        let prev = std::env::var("AGENT_VITALS_HOME").ok();
        std::env::set_var("AGENT_VITALS_HOME", &home);
        // 直接走底层 I/O 路径（不经全局单例 `LOG`——那是进程级 OnceLock，
        // 一旦被另一个测试先初始化过就不会再看这次的 data_home），验证目录/
        // 文件创建与内容落地这条链路本身是对的。
        let path = home.join("logs").join("app.log");
        assert!(!path.exists());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = OpenOptions::new().create(true).append(true).open(&path).unwrap();
        file.write_all(format_line(Level::Warn, "test", "hello").as_bytes()).unwrap();
        drop(file);
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("hello"));
        assert!(content.contains("WARN"));

        match prev {
            Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
            None => std::env::remove_var("AGENT_VITALS_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn log_path_is_under_data_home_logs() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("path");
        let prev = std::env::var("AGENT_VITALS_HOME").ok();
        std::env::set_var("AGENT_VITALS_HOME", &home);
        assert_eq!(log_path(), home.join("logs").join("app.log"));
        match prev {
            Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
            None => std::env::remove_var("AGENT_VITALS_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `RUST_LOG` 是进程级环境变量——与 `AGENT_VITALS_HOME` 同款，靠
    /// `crate::ENV_LOCK` 序列化，不能省（否则并行跑的其他测试会看见这个
    /// 测试留下的值，或反过来）。
    #[test]
    fn stderr_shows_info_reads_rust_log_case_insensitively() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("RUST_LOG").ok();

        std::env::remove_var("RUST_LOG");
        assert!(!stderr_shows_info(), "unset RUST_LOG: info stays file-only");

        std::env::set_var("RUST_LOG", "warn");
        assert!(!stderr_shows_info(), "RUST_LOG=warn does not elevate info");

        for value in ["info", "INFO", "debug", "agent_vitals_runtime=debug", "trace"] {
            std::env::set_var("RUST_LOG", value);
            assert!(stderr_shows_info(), "RUST_LOG={value:?} must elevate info to stderr");
        }

        match prev {
            Some(p) => std::env::set_var("RUST_LOG", p),
            None => std::env::remove_var("RUST_LOG"),
        }
    }

    #[test]
    fn redact_path_like_strips_the_configured_home_prefix() {
        let home = PathBuf::from("/Users/alice");
        let text = "watch /Users/alice/.claude/projects/demo 失败（该根 tick 兜底）: no such file";
        let redacted = redact_path_like(text, &home);
        assert_eq!(redacted, "watch ~/.claude/projects/demo 失败（该根 tick 兜底）: no such file");
        assert!(!redacted.contains("alice"));
    }

    #[test]
    fn redact_path_like_catches_foreign_unix_and_windows_user_prefixes() {
        // home 是 /Users/alice，但消息里引用了另一个账户的路径（比如一个
        // 手选的自定义 source root）——精确替换救不了这种，靠兜底前缀扫。
        let home = PathBuf::from("/Users/alice");
        let text = "custom source /Users/bob/shared/logs rejected; also see /home/carol/data and C:\\Users\\dave\\logs";
        let redacted = redact_path_like(text, &home);
        assert_eq!(
            redacted,
            "custom source ~/shared/logs rejected; also see ~/data and ~\\logs",
        );
        for leaked in ["bob", "carol", "dave"] {
            assert!(!redacted.contains(leaked), "{leaked} must not survive redaction: {redacted}");
        }
    }

    #[test]
    fn redact_path_like_is_a_noop_on_text_with_no_paths() {
        let home = PathBuf::from("/Users/alice");
        let text = "sync-facts: +88113 appended, 0 duplicate";
        assert_eq!(redact_path_like(text, &home), text);
    }

    #[test]
    fn read_redacted_tail_returns_empty_without_a_log_file() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("tail-missing");
        let prev = std::env::var("AGENT_VITALS_HOME").ok();
        std::env::set_var("AGENT_VITALS_HOME", &home);
        assert_eq!(read_redacted_tail(DIAGNOSTIC_TAIL_MAX_LINES), Vec::<String>::new());
        match prev {
            Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
            None => std::env::remove_var("AGENT_VITALS_HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn read_redacted_tail_caps_at_max_lines_and_redacts_every_line() {
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("tail-cap");
        let prev_home_env = std::env::var("AGENT_VITALS_HOME").ok();
        let prev_real_home = std::env::var("HOME").ok();
        std::env::set_var("AGENT_VITALS_HOME", &home);
        // `HOME` 决定 `read_redacted_tail` 拿来脱敏的前缀——单独设成 home 本身，
        // 让写进日志文件的绝对路径行必须被这次读取擦掉。
        std::env::set_var("HOME", &home);
        let path = home.join("logs").join("app.log");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let home_display = home.display().to_string();
        let mut file = OpenOptions::new().create(true).append(true).open(&path).unwrap();
        for i in 0..10 {
            file.write_all(format!("line {i} touches {home_display}/logs/app.log\n").as_bytes()).unwrap();
        }
        drop(file);
        let tail = read_redacted_tail(3);
        assert_eq!(tail.len(), 3, "must cap at max_lines, not return the whole file");
        assert_eq!(tail, vec![
            "line 7 touches ~/logs/app.log",
            "line 8 touches ~/logs/app.log",
            "line 9 touches ~/logs/app.log",
        ]);
        for line in &tail {
            assert!(!line.contains(&home_display), "raw home path must not survive redaction: {line}");
        }
        match prev_home_env {
            Some(p) => std::env::set_var("AGENT_VITALS_HOME", p),
            None => std::env::remove_var("AGENT_VITALS_HOME"),
        }
        match prev_real_home {
            Some(p) => std::env::set_var("HOME", p),
            None => std::env::remove_var("HOME"),
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
