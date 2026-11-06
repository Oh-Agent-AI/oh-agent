//! 会话执行环境注册表（W3 第 1 步，docs/ARCHITECTURE_OPTIMIZATION_GUIDE.md）。
//!
//! 为什么要这张表：此前 runtime 在三处各写一遍「按执行环境字符串分支」——同步的内置根
//! 发现、自定义源根发现、findings 评估——每处都直接点名 `claude_project_files_with_errors`
//! / `codex_rollout_files_with_errors` / …。执行环境的「根在哪、根下怎么枚举、会话怎么评估」
//! 是执行环境适配知识，应该和执行环境的 wire 解析住在一起；runtime 只遍历这张表。接一个新执行环境
//! = 在这里加一行 + 在 `harnesses/<h>/sources/` 写实现，runtime 不动。
//!
//! 本 crate 不读环境变量、不读时钟：根目录的解析（`HOME` / `USERPROFILE` / `DSH_HOME`）
//! 由调用方做好放进 [`HarnessRoots`]，价卡（含用户覆盖）由调用方放进 [`FindingsCtx`]。
//!
//! **顺序即契约**：[`SESSION_HARNESSES`] 的顺序就是同步批次的处理顺序（与既有
//! `claude-code → codex → dsh → workbuddy` 一致，同步报告里 `harnesses[]` 的顺序随之不变）。

use std::path::{Path, PathBuf};

use agent_vitals_domain::findings::FindingRef;
use serde_json::Value;

/// 调用方解析好的根目录。`user_home` 是 `HOME`（→ `USERPROFILE`）；`dsh_home` 是
/// `DSH_HOME`（→ `~/.dsh`），两者都未知时为 `None`。
#[derive(Debug, Clone, Copy)]
pub struct HarnessRoots<'a> {
    pub user_home: &'a Path,
    pub dsh_home: Option<&'a Path>,
}

/// Concrete usage directories protected from a second manifest identity.
/// Unlike default_root (an adapter argument), these delimit actual input scope.
pub fn usage_source_roots(roots: &HarnessRoots<'_>) -> Vec<(&'static str, PathBuf)> {
    let mut scopes = vec![
        ("claude-code", roots.user_home.join(".claude/projects")),
        ("codex", roots.user_home.join(".codex/sessions")),
        ("codex", roots.user_home.join(".codex/archived_sessions")),
        ("workbuddy", crate::workbuddy_session::workbuddy_root(roots.user_home)),
    ];
    if let Some(home) = roots.dsh_home { scopes.push(("dsh", home.join("sessions"))); }
    scopes
}

/// findings 评估的上下文。`codex_index_cache` 是 Codex「路径 → session_id」索引的缓存
/// 文件（调用方决定放哪，runtime 放 `<data_home>/facts/.codex-session-index.json`）。
pub struct FindingsCtx<'a> {
    pub roots: HarnessRoots<'a>,
    pub codex_index_cache: &'a Path,
    pub pricing: &'a Value,
}

/// 一个会话本轮观察到的全部 findings（空 vec = 评估成功且零命中，会关闭旧 issue）。
#[derive(Debug, Clone)]
pub struct SessionFindings {
    pub harness: &'static str,
    pub native_id: String,
    pub findings: Vec<FindingRef>,
}

/// `(ctx, 本轮变化的文件, 本轮发现的全部文件) → (评估成功的会话, 逐文件错误)`。
/// 读失败的会话不进结果——没观察到 ≠ 观察到已消失，调用方据此不关它的旧 issue。
pub type FindingsFn =
    fn(&FindingsCtx<'_>, &[PathBuf], &[PathBuf]) -> (Vec<SessionFindings>, Vec<String>);

pub struct SessionHarness {
    /// 执行环境 id，与 UsageFact 的 `harness` stamp、`FACT_HARNESSES` 同一封闭词表。
    pub id: &'static str,
    /// 内置根。`None` = 本机没法定位该执行环境根（不是错误，枚举为空）。
    pub default_root: fn(&HarnessRoots<'_>) -> Option<PathBuf>,
    /// 在一个根下枚举会话源文件（清单 + 遍历错误）。内置根与自定义源根走同一个函数。
    pub files_under: fn(&Path) -> (Vec<PathBuf>, Vec<String>),
    /// 是否接受用户登记的自定义源根（`custom_sources`）。
    pub accepts_custom_roots: bool,
    /// 会话级行为 findings（SV6xx）。`None` = 该执行环境没有会话级产出。
    pub findings: Option<FindingsFn>,
    /// 下钻（trace）：在内置根下定位某个 native id 的源文件。空 = 源已不在（调用方报
    /// SourceUnavailable，不猜）。路径只在进程内用，不进任何 JSON 出口。
    pub session_sources: fn(&HarnessRoots<'_>, &str) -> Vec<PathBuf>,
    /// 侧车索引型会话标题（V32 City 楼名）：标题不在会话日志 wire 里、而在
    /// 执行环境自己的索引文件（codex `session_index.jsonl`、DSH
    /// `storages/workspace.json`）。`None` = 无索引型标题——claude-code 的标题
    /// 在会话日志内、由解析器随事实产出；workbuddy 的在 workbuddy.db sessions
    /// 表，暂未接。取材函数**只读、宽容**：索引缺失/畸形 → 空集（标题是加分
    /// 项，不是准入项）。
    pub title_index: Option<fn(&HarnessRoots<'_>) -> Vec<agent_vitals_domain::contracts::workflow::SessionTitle>>,
}

fn user_home_root(roots: &HarnessRoots<'_>) -> Option<PathBuf> {
    Some(roots.user_home.to_path_buf())
}

fn dsh_root(roots: &HarnessRoots<'_>) -> Option<PathBuf> {
    roots.dsh_home.map(Path::to_path_buf)
}

fn workbuddy_root(roots: &HarnessRoots<'_>) -> Option<PathBuf> {
    Some(crate::workbuddy_session::workbuddy_root(roots.user_home))
}

fn claude_session_sources(roots: &HarnessRoots<'_>, native_id: &str) -> Vec<PathBuf> {
    crate::claude_session::claude_project_files(roots.user_home)
        .into_iter()
        .filter(|path| path.file_stem().and_then(|s| s.to_str()) == Some(native_id))
        .collect()
}

/// 按内容 session_id 过滤（resume 会开新文件名的 rollout，文件名不可信，见
/// `codex/sources/findings.rs`）。下钻是单次用户动作，全量解析可以接受。
fn codex_session_sources(roots: &HarnessRoots<'_>, native_id: &str) -> Vec<PathBuf> {
    crate::codex_session::codex_rollout_files(roots.user_home)
        .into_iter()
        .filter(|path| crate::codex_session::session_audit::codex_session_id_of(path) == native_id)
        .collect()
}

fn dsh_session_sources(roots: &HarnessRoots<'_>, native_id: &str) -> Vec<PathBuf> {
    let Some(dsh_home) = roots.dsh_home else { return Vec::new() };
    crate::dsh_sources::discovery::dsh_session_files(dsh_home)
        .into_iter()
        .filter(|path| {
            crate::canonical_input::dsh_native_session_id_for_path(path).ok().as_deref() == Some(native_id)
        })
        .collect()
}

/// WorkBuddy（E4b）：源是整个 `<HOME>/.workbuddy/` 根（db + audit-log + traces 三面按
/// session_id join），不是单个文件——返回 HOME，`canonical_input` 的 workbuddy 分派按
/// 这个约定解析根。根目录不存在 → 空。
fn workbuddy_session_sources(roots: &HarnessRoots<'_>, _native_id: &str) -> Vec<PathBuf> {
    if crate::workbuddy_session::workbuddy_root(roots.user_home).is_dir() {
        vec![roots.user_home.to_path_buf()]
    } else {
        Vec::new()
    }
}

/// codex 侧车标题索引：`~/.codex/session_index.jsonl` 的 `{id, thread_name}`
/// 映射 → 已整形（脱敏 + 截断）的 [`SessionTitle`]。join 键 = 逻辑
/// `payload.session_id`（与 facts 的 native_session_id 同源，见
/// `codex/sources/mod.rs::parse_session_index` 的实测注释）。
fn codex_title_index(roots: &HarnessRoots<'_>) -> Vec<agent_vitals_domain::contracts::workflow::SessionTitle> {
    use agent_vitals_domain::contracts::workflow::SessionTitle;
    use agent_vitals_domain::enrichment::bound_session_title;
    crate::codex_session::read_session_index(roots.user_home)
        .into_iter()
        .filter_map(|(sid, raw)| {
            bound_session_title(&raw).map(|title| SessionTitle {
                native_session_id: sid,
                title,
                source: "codex_thread_name".to_string(),
            })
        })
        .collect()
}

/// DSH 侧车标题索引：`<DSH_HOME>/storages/workspace.json` 的
/// `workspaces.{wsid}.{path, title, sessionIds[]}` → 按 session 折叠的
/// [`SessionTitle`]（值取 title；path 不是标题）。根未知（DSH_HOME 与 HOME
/// 都没有）→ 空集，不报错。
fn dsh_title_index(roots: &HarnessRoots<'_>) -> Vec<agent_vitals_domain::contracts::workflow::SessionTitle> {
    use agent_vitals_domain::contracts::workflow::SessionTitle;
    use agent_vitals_domain::enrichment::bound_session_title;
    let Some(dsh_home) = roots.dsh_home else { return Vec::new() };
    crate::dsh_sources::discovery::read_workspace_index(dsh_home)
        .by_session
        .into_iter()
        .filter_map(|(sid, (_path, raw))| {
            bound_session_title(&raw).map(|title| SessionTitle {
                native_session_id: sid,
                title,
                source: "dsh_workspace_title".to_string(),
            })
        })
        .collect()
}

/// ZCode 标题来自本机 CLI 索引数据库，而不是用量 JSONL。插件 manifest
/// 必须显式选择受审计的 adapter；数据库只读，缺表/损坏/忙碌均降级为空标题集。
/// ZCode 文件名捕获的是 UUID，而 DB 的 id 通常带 `sess_` 前缀，写库时
/// 两种形式都兼容，最终以实际采集到的 native session id 做自然键匹配。
pub fn plugin_session_titles(
    adapter: Option<crate::generic_manifest::PluginSessionTitleAdapter>,
    home: &Path,
    native_session_ids: &[String],
) -> Vec<agent_vitals_domain::contracts::workflow::SessionTitle> {
    match adapter {
        Some(crate::generic_manifest::PluginSessionTitleAdapter::ZcodeSqliteSessionV1) => {
            zcode_sqlite_session_titles(home, native_session_ids)
        }
        None => Vec::new(),
    }
}

fn zcode_sqlite_session_titles(
    home: &Path,
    native_session_ids: &[String],
) -> Vec<agent_vitals_domain::contracts::workflow::SessionTitle> {
    use agent_vitals_domain::contracts::workflow::SessionTitle;
    use agent_vitals_domain::enrichment::bound_session_title;
    use rusqlite::{Connection, OpenFlags};

    let path = home.join(".zcode/cli/db/db.sqlite");
    let Ok(db) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = db.busy_timeout(std::time::Duration::from_millis(500));
    let mut titles = Vec::new();
    let Ok(mut stmt) = db.prepare("SELECT title FROM session WHERE id = ?1 AND title IS NOT NULL LIMIT 1") else {
        return Vec::new();
    };
    let ids = native_session_ids.iter().filter(|id| !id.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    // Bound work by this ingest batch, rather than an arbitrary lexical prefix of
    // the whole index. ZCode stores `sess_<uuid>` while the usage filename carries
    // just `<uuid>`; both spellings are checked, but the fact's original ID stays
    // the authoritative join key written to the sessions table. Deduplicate first
    // so a many-request session cannot consume the bounded lookup budget.
    for id in ids.into_iter().take(100_000) {
        let alternate = if id.starts_with("sess_") { id.trim_start_matches("sess_").to_string() } else { format!("sess_{id}") };
        let raw_title = stmt.query_row([id.as_str()], |row| row.get::<_, String>(0))
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => stmt.query_row([alternate], |row| row.get::<_, String>(0)),
                other => Err(other),
            });
        let Ok(raw_title) = raw_title else { continue };
        let Some(title) = bound_session_title(&raw_title) else { continue };
        titles.push(SessionTitle {
            native_session_id: id.to_string(),
            title,
            source: "zcode_session_title".to_string(),
        });
    }
    titles.sort_by(|a, b| a.native_session_id.cmp(&b.native_session_id));
    titles
}

/// 会话执行环境注册表（顺序即同步批次顺序，见模块文档）。
pub static SESSION_HARNESSES: [SessionHarness; 4] = [
    SessionHarness {
        id: "claude-code",
        default_root: user_home_root,
        files_under: crate::claude_session::claude_project_files_with_errors,
        accepts_custom_roots: true,
        findings: Some(crate::harnesses::claude_code::sources::findings::evaluate),
        session_sources: claude_session_sources,
        title_index: None,
    },
    SessionHarness {
        id: "codex",
        default_root: user_home_root,
        files_under: crate::codex_session::codex_rollout_files_with_errors,
        accepts_custom_roots: true,
        findings: Some(crate::harnesses::codex::sources::findings::evaluate),
        session_sources: codex_session_sources,
        title_index: Some(codex_title_index),
    },
    SessionHarness {
        id: "dsh",
        default_root: dsh_root,
        files_under: crate::dsh_sources::discovery::dsh_session_files_with_errors,
        accepts_custom_roots: true,
        findings: Some(crate::harnesses::dsh::sources::findings::evaluate),
        session_sources: dsh_session_sources,
        title_index: Some(dsh_title_index),
    },
    SessionHarness {
        id: "workbuddy",
        default_root: workbuddy_root,
        files_under: crate::workbuddy_traces::workbuddy_trace_files_with_errors,
        accepts_custom_roots: false,
        findings: None,
        session_sources: workbuddy_session_sources,
        title_index: None,
    },
];

pub fn session_harness(id: &str) -> Option<&'static SessionHarness> {
    SESSION_HARNESSES.iter().find(|harness| harness.id == id)
}

/// 「哪个字段带 findings」的单一权威（原 r2a `findings_for`，W8 起在 runtime 的
/// findings_eval，W3 随评估器搬来）。DSH 载荷是 behavior 20 键形状 → `findings`；
/// Codex / Claude 载荷 → `audit.findings`。两者皆无 → 空 vec（诚实零命中，不是错误）。
pub fn findings_from_payload(harness: &str, payload: &Value) -> Vec<FindingRef> {
    let arr = if harness == "dsh" {
        payload.get("findings").and_then(Value::as_array)
    } else {
        payload.pointer("/audit/findings").and_then(Value::as_array)
    };
    let Some(arr) = arr else { return Vec::new() };
    let text = |f: &Value, k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    arr.iter()
        .map(|f| FindingRef {
            rule: text(f, "rule"),
            severity: text(f, "severity"),
            category: text(f, "category"),
            tool_name: f.get("tool_name").and_then(Value::as_str).map(str::to_owned),
            evidence: f.get("evidence").and_then(Value::as_str).map(str::to_owned),
            time: f.get("time").and_then(Value::as_i64),
            seq: f.get("seq").and_then(Value::as_u64),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 原 r2a `findings_for_reads_the_right_field_per_harness`，随谓词搬来。
    #[test]
    fn findings_from_payload_reads_the_right_field_per_harness() {
        let dsh = json!({"findings": [{"rule": "SV601", "severity": "critical", "category": "shell",
            "tool_name": "bash", "evidence": "rm -rf /", "time": 100, "seq": 1}]});
        let codex = json!({"audit": {"findings": [{"rule": "SV610", "severity": "warning",
            "category": "approval", "tool_name": null, "evidence": "danger-full-access", "seq": 2}]}});
        let d = findings_from_payload("dsh", &dsh);
        assert_eq!((d.len(), d[0].rule.as_str(), d[0].time), (1, "SV601", Some(100)));
        let c = findings_from_payload("codex", &codex);
        assert_eq!((c.len(), c[0].rule.as_str(), c[0].tool_name.clone()), (1, "SV610", None));
        // 字段错位（DSH 形状喂 codex）→ 诚实零命中，不是错误。
        assert!(findings_from_payload("codex", &dsh).is_empty());
    }

    /// 顺序即同步批次顺序；执行环境集合与事实执行环境封闭词表一致。
    #[test]
    fn registry_order_and_membership_are_the_fact_harness_vocabulary() {
        let ids: Vec<&str> = SESSION_HARNESSES.iter().map(|h| h.id).collect();
        assert_eq!(ids, ["claude-code", "codex", "dsh", "workbuddy"]);
        let with_findings: Vec<&str> =
            SESSION_HARNESSES.iter().filter(|h| h.findings.is_some()).map(|h| h.id).collect();
        assert_eq!(with_findings, ["claude-code", "codex", "dsh"]);
        assert!(session_harness("dsh").is_some());
        assert!(session_harness("nope").is_none());
    }

    #[test]
    fn default_roots_follow_the_existing_conventions() {
        let home = Path::new("/h");
        let with_dsh = HarnessRoots { user_home: home, dsh_home: Some(Path::new("/d")) };
        let no_dsh = HarnessRoots { user_home: home, dsh_home: None };
        let root = |id: &str, r: &HarnessRoots<'_>| (session_harness(id).unwrap().default_root)(r);
        assert_eq!(root("claude-code", &with_dsh), Some(PathBuf::from("/h")));
        assert_eq!(root("codex", &with_dsh), Some(PathBuf::from("/h")));
        assert_eq!(root("dsh", &with_dsh), Some(PathBuf::from("/d")));
        assert_eq!(root("dsh", &no_dsh), None, "DSH 根未知 → 枚举为空，不是错误");
        assert_eq!(root("workbuddy", &with_dsh), Some(PathBuf::from("/h/.workbuddy")));
    }

    #[test]
    fn zcode_plugin_titles_are_read_only_scrubbed_and_keyed_by_session_id() {
        let home = std::env::temp_dir().join(format!(
            "agent-vitals-zcode-title-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        let db_path = home.join(".zcode/cli/db/db.sqlite");
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = rusqlite::Connection::open(&db_path).unwrap();
        db.execute_batch("CREATE TABLE session (id TEXT, title TEXT);").unwrap();
        db.execute("INSERT INTO session VALUES (?1, ?2)", rusqlite::params!["sess_abc", "  修复标题  "]).unwrap();
        db.execute("INSERT INTO session VALUES (?1, ?2)", rusqlite::params!["sess_prefixed", "带前缀会话"]).unwrap();
        db.execute("INSERT INTO session VALUES (?1, ?2)", rusqlite::params!["raw-id", "使用 sk-abcdefghij0123456789 的任务"]).unwrap();
        db.execute("INSERT INTO session VALUES (?1, ?2)", rusqlite::params!["sess_blank", "   "]).unwrap();
        drop(db);

        let titles = plugin_session_titles(
            Some(crate::generic_manifest::PluginSessionTitleAdapter::ZcodeSqliteSessionV1),
            &home,
            &["abc".to_string(), "abc".to_string(), "raw-id".to_string(), "sess_prefixed".to_string(), "missing".to_string()],
        );
        assert_eq!(titles.len(), 3);
        assert_eq!(titles[0].native_session_id, "abc");
        assert_eq!(titles[0].title, "修复标题");
        assert_eq!(titles[0].source, "zcode_session_title");
        assert_eq!(titles[1].native_session_id, "raw-id");
        assert!(!titles[1].title.contains("sk-abcdefghij0123456789"));
        assert_eq!(titles[2].native_session_id, "sess_prefixed");
        assert!(plugin_session_titles(None, &home, &["abc".to_string()]).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn zcode_plugin_title_index_degrades_when_database_is_missing() {
        let home = std::env::temp_dir().join(format!(
            "agent-vitals-zcode-title-missing-{}",
            std::process::id(),
        ));
        let _ = std::fs::remove_dir_all(&home);
        assert!(plugin_session_titles(
            Some(crate::generic_manifest::PluginSessionTitleAdapter::ZcodeSqliteSessionV1),
            &home,
            &["abc".to_string()],
        ).is_empty());
    }
}
