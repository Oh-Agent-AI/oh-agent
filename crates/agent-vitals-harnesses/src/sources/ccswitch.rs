//! cc-switch（`farion1231/cc-switch`）的 provider 表读取器——`config-time-bound`(5)
//! 证据的**第一个 emitter**。
//!
//! **为什么需要它**（2026-09-17 真机事故）：codex 的 rollout 只记 `model_provider =
//! "custom"`，cc-switch 每次切换供应商都改写同一个 `[model_providers.custom]` 段，
//! 于是胜算云（`router.shengsuanyun.com`）和 cogfoundry（`router.cogfoundry.ai`）的
//! 会话在日志层**同形**；`endpoint_evidence::read_codex` 只读当前 `config.toml`，
//! 同步那一刻指向胜算云，整月 `custom` 用量就全被建议成胜算云——其中 09-09 的
//! 395 次 gpt-5.6-sol（官方价估 ¥736）实际走的是 cogfoundry，胜算云账单上一条
//! 都没有。
//!
//! cc-switch 的库里有两样**带时间**的东西，是本机唯一能把两家分开的证据：
//! - `providers.created_at`：胜算云那条 09-11 23:43 才建——**之前的事实不可能经它**
//!   （硬下界，不是推断）；
//! - `backups/db_backup_*.db` 里每日快照的 `is_current`：粗粒度"当时选的是谁"。
//!
//! **隐私边界**（与 `endpoint_evidence` 同纪律）：`settings_config` 这一列和凭据挨在
//! 一起（codex 的 `experimental_bearer_token`、claude 的 `env.ANTHROPIC_AUTH_TOKEN`），
//! 本模块只从中**白名单**取 `base_url` / `env.ANTHROPIC_BASE_URL`，凭据连值都不复制出
//! 来；输出结构没有放凭据的槽位（测试用穷举解构钉住）。库以只读打开，不写、不建
//! `-journal`。
//!
//! **证据强度只到 `ConfigTimeBound`(5)**：它能排除"那时还不存在的中转"，能说"那天快照
//! 里选的是谁"，但不能证明某一条会话走了哪家——同一天来回切换的部分仍要靠账单。

use std::collections::BTreeMap;
use std::path::Path;

use agent_vitals_provider::EvidenceBasis;
use serde_json::Value;

use super::endpoint_evidence::{codex_toml_base_urls, hostname_of, RelayRecord};

/// cc-switch 的 `app_type` → 本仓库执行环境 id。其余 app_type（gemini/opencode/…）不是
/// 我们的执行环境，跳过。
fn harness_of_app_type(app_type: &str) -> Option<&'static str> {
    match app_type {
        "codex" => Some("codex"),
        "claude" => Some("claude-code"),
        _ => None,
    }
}

/// 从一条 provider 的 `settings_config` JSON 里**只**取端点：codex 的 `config`（TOML 文本）
/// 里 `[model_providers.*].base_url`；claude 的 `env.ANTHROPIC_BASE_URL`。其余键一律不看。
fn endpoint_of_settings(app_type: &str, settings_config: &str) -> Option<String> {
    let doc: Value = serde_json::from_str(settings_config).ok()?;
    match app_type {
        "codex" => {
            let toml = doc.get("config").and_then(Value::as_str)?;
            codex_toml_base_urls(toml).into_iter().next()
        }
        "claude" => doc.get("env")
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn open_read_only(path: &Path) -> Option<rusqlite::Connection> {
    use rusqlite::OpenFlags;
    if !path.is_file() {
        return None;
    }
    rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).ok()
}

/// 一次读取的结果：按执行环境分组的中转时间线。执行环境没有任何中转条目 → 不进 map。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcSwitchEvidence {
    /// harness → 该执行环境在 cc-switch 里配置过的**中转**条目（按 `created_at_ms` 升序）。
    /// 官方端点（`api.openai.com`/`chatgpt.com`/`api.anthropic.com`）不进来——它们不是
    /// 中转，`is_official_endpoint` 由判定器按厂商判；这里只是不带端点的条目
    /// （`OpenAI Official` 的 settings 没有 base_url）自然被跳过。
    pub relays_by_harness: BTreeMap<String, Vec<RelayRecord>>,
    pub evidence_basis: EvidenceBasis,
    pub source: String,
}

/// 读 `~/.cc-switch/cc-switch.db`（+ `backups/`）。库不存在 / 打不开 / 表不存在 → `None`
/// （不猜）。`backups/` 最多读最近 [`MAX_BACKUPS`] 份——每份都是整库副本，只查一张小表。
pub fn read(home: &Path) -> Option<CcSwitchEvidence> {
    let dir = home.join(".cc-switch");
    let conn = open_read_only(&dir.join("cc-switch.db"))?;
    let mut records: BTreeMap<String, Vec<RelayRecord>> = BTreeMap::new();
    let mut ids: BTreeMap<(String, String), (String, String)> = BTreeMap::new(); // (harness, provider id) → (endpoint harness, label)
    {
        let mut stmt = conn.prepare(
            "SELECT id, app_type, name, settings_config, created_at, is_current FROM providers",
        ).ok()?;
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
            r.get::<_, String>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, Option<i64>>(5)?,
        ))).ok()?;
        for row in rows.flatten() {
            let (id, app_type, name, settings, created_at, is_current) = row;
            let Some(harness) = harness_of_app_type(&app_type) else { continue };
            let Some(url) = endpoint_of_settings(&app_type, &settings) else { continue };
            let Some(endpoint_host) = hostname_of(&url) else { continue };
            ids.insert((harness.to_string(), id), (endpoint_host.clone(), name.clone()));
            let list = records.entry(harness.to_string()).or_default();
            // **同一端点合并成一条**：真机 cc-switch 里 `router.cogfoundry.ai` 有两条（用户
            // 起名 "cogfoundry.ai" 和 "DeepSeek"），各自的 created_at 不同。判定器关心的是
            // "这个端点从何时起存在"，取最早的建立时刻；两条各算一行会给同一个端点两个
            // 互相矛盾的关系（一条 partial 一条 possible）。
            match list.iter_mut().find(|r| r.endpoint_host == endpoint_host) {
                Some(existing) => {
                    existing.created_at_ms = match (existing.created_at_ms, created_at) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                    existing.is_current |= is_current.unwrap_or(0) != 0;
                    if !existing.label.split(" / ").any(|l| l == name) {
                        existing.label = format!("{} / {}", existing.label, name);
                    }
                }
                None => list.push(RelayRecord {
                    endpoint_host,
                    label: name,
                    created_at_ms: created_at,
                    is_current: is_current.unwrap_or(0) != 0,
                    active_at_ms: Vec::new(),
                }),
            }
        }
    }
    drop(conn);
    // 每日备份快照：`is_current = 1` 的那条在当时被选中。时间取文件 mtime（备份建立时刻，
    // UTC epoch，不依赖文件名里的本地时间）。
    let mut backups: Vec<(i64, std::path::PathBuf)> = std::fs::read_dir(dir.join("backups")).ok()
        .into_iter().flatten().flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !(name.starts_with("db_backup_") && name.ends_with(".db")) {
                return None;
            }
            let mtime = entry.metadata().ok()?.modified().ok()?
                .duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
            Some((mtime, path))
        })
        .collect();
    backups.sort();
    for (at_ms, path) in backups.iter().rev().take(MAX_BACKUPS) {
        let Some(conn) = open_read_only(path) else { continue };
        let Ok(mut stmt) = conn.prepare("SELECT id, app_type FROM providers WHERE is_current = 1") else { continue };
        let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) else { continue };
        for (id, app_type) in rows.flatten() {
            let Some(harness) = harness_of_app_type(&app_type) else { continue };
            let Some((endpoint_host, _)) = ids.get(&(harness.to_string(), id)) else { continue };
            if let Some(record) = records.get_mut(harness).and_then(|v| v.iter_mut().find(|r| &r.endpoint_host == endpoint_host)) {
                record.active_at_ms.push(*at_ms);
            }
        }
    }
    for list in records.values_mut() {
        list.sort_by_key(|r| (r.created_at_ms.unwrap_or(i64::MAX), r.endpoint_host.clone()));
        for r in list.iter_mut() {
            r.active_at_ms.sort_unstable();
            r.active_at_ms.dedup();
        }
    }
    if records.is_empty() {
        return None;
    }
    Some(CcSwitchEvidence {
        relays_by_harness: records,
        evidence_basis: EvidenceBasis::ConfigTimeBound,
        source: "~/.cc-switch/cc-switch.db".to_string(),
    })
}

/// 最多读多少份每日备份。cc-switch 每 24h 一份，60 份 ≈ 两个月，覆盖 13 个月保留期
/// 之外的部分不需要（更早的月份早已归档，声明也早已确认）。
pub const MAX_BACKUPS: usize = 60;

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("av-ccswitch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".cc-switch").join("backups")).unwrap();
        dir
    }

    fn create_db(path: &Path, rows: &[(&str, &str, &str, &str, i64, i64)]) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
                settings_config TEXT NOT NULL, created_at INTEGER, is_current BOOLEAN NOT NULL DEFAULT 0,
                PRIMARY KEY (id, app_type))",
        ).unwrap();
        for (id, app_type, name, settings, created_at, is_current) in rows {
            conn.execute(
                "INSERT INTO providers(id, app_type, name, settings_config, created_at, is_current) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, app_type, name, settings, created_at, is_current],
            ).unwrap();
        }
    }

    /// 真机 2026-09-17 的 codex 形状：两条中转都叫 `shengsuanyun`（`[model_providers.custom].name`），
    /// 只有 base_url 和 created_at 不同；OpenAI Official 没有 base_url；MiniMax 是官方端点但
    /// 这里不判官方（那是判定器按厂商做的事）。
    const SSY: &str = r#"{"config":"model_provider = \"custom\"\nmodel = \"gpt-5.6-terra\"\n\n[model_providers.custom]\nname = \"shengsuanyun\"\nbase_url = \"https://router.shengsuanyun.com/api/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"sk-SECRET-SSY\"\n"}"#;
    const COG: &str = r#"{"config":"model_provider = \"custom\"\nmodel = \"openai/gpt-5.6-sol\"\n\n[model_providers.custom]\nname = \"shengsuanyun\"\nbase_url = \"https://router.cogfoundry.ai/api/v1\"\nexperimental_bearer_token = \"sk-SECRET-COG\"\n"}"#;
    const OFFICIAL: &str = r#"{"config":"model = \"gpt-5.6-luna\"\napproval_policy = \"never\"\n"}"#;
    const CLAUDE_SSY: &str = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-SECRET-CLAUDE","ANTHROPIC_BASE_URL":"https://router.shengsuanyun.com/api","ANTHROPIC_MODEL":"deepseek/deepseek-v4-pro"}}"#;

    #[test]
    fn reads_relays_with_created_at_and_never_the_tokens() {
        let h = home("read");
        let db = h.join(".cc-switch").join("cc-switch.db");
        create_db(&db, &[
            ("cog", "codex", "DeepSeek", COG, 1_788_871_111_025, 0),
            // 真机：同一个端点的第二条（用户起名不同、建立更早）——必须合并成一条、取最早建立时刻。
            ("cog2", "codex", "cogfoundry.ai", COG, 1_788_862_810_585, 0),
            ("ssy", "codex", "胜算云（网关）", SSY, 1_789_141_416_965, 0),
            ("codex-official", "codex", "OpenAI Official", OFFICIAL, 1_784_900_167_165, 1),
            ("c-ssy", "claude", "胜算云", CLAUDE_SSY, 1_788_000_000_000, 1),
            ("g", "gemini", "Google Official", r#"{"env":{}}"#, 1, 1),
        ]);
        let e = read(&h).expect("evidence");
        let CcSwitchEvidence { relays_by_harness, evidence_basis, source } = e.clone();
        assert_eq!(evidence_basis, EvidenceBasis::ConfigTimeBound);
        assert!(source.contains("cc-switch.db"));
        let codex = &relays_by_harness["codex"];
        assert_eq!(codex.len(), 2, "official (no base_url) and gemini (not our harness) are skipped; same endpoint merges: {codex:?}");
        assert_eq!(codex[0].endpoint_host, "router.cogfoundry.ai");
        assert_eq!(codex[0].created_at_ms, Some(1_788_862_810_585), "earliest creation of the merged endpoint");
        assert_eq!(codex[0].label, "DeepSeek / cogfoundry.ai");
        assert_eq!(codex[1].endpoint_host, "router.shengsuanyun.com");
        assert_eq!(codex[1].created_at_ms, Some(1_789_141_416_965));
        assert_eq!(codex[1].label, "胜算云（网关）");
        assert!(!codex[1].is_current);
        let claude = &relays_by_harness["claude-code"];
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].endpoint_host, "router.shengsuanyun.com");
        assert!(claude[0].is_current);
        let debug = format!("{e:?}");
        for forbidden in ["SECRET", "sk-", "bearer", "AUTH_TOKEN"] {
            assert!(!debug.contains(forbidden), "leaked {forbidden}: {debug}");
        }
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn backups_give_active_snapshots_per_relay() {
        let h = home("backups");
        let rows = [
            ("cog", "codex", "DeepSeek", COG, 100, 0),
            ("ssy", "codex", "胜算云（网关）", SSY, 200, 0),
            ("codex-official", "codex", "OpenAI Official", OFFICIAL, 1, 1),
        ];
        create_db(&h.join(".cc-switch").join("cc-switch.db"), &rows);
        // 09-09 快照：cogfoundry 当前；09-12 快照：胜算云当前；09-13：官方当前（不进任何中转）。
        let snap = |name: &str, current: &str| {
            let path = h.join(".cc-switch").join("backups").join(name);
            create_db(&path, &rows.iter().map(|r| (r.0, r.1, r.2, r.3, r.4, if r.0 == current { 1 } else { 0 })).collect::<Vec<_>>());
            path
        };
        let a = snap("db_backup_20260909_153125.db", "cog");
        let b = snap("db_backup_20260912_150607.db", "ssy");
        let _c = snap("db_backup_20260913_231059.db", "codex-official");
        let e = read(&h).unwrap();
        let codex = &e.relays_by_harness["codex"];
        let mtime = |p: &Path| std::fs::metadata(p).unwrap().modified().unwrap()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        assert_eq!(codex[0].active_at_ms, vec![mtime(&a)], "cogfoundry current in the 09-09 snapshot");
        assert_eq!(codex[1].active_at_ms, vec![mtime(&b)], "shengsuanyun current in the 09-12 snapshot");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn missing_db_or_missing_table_is_none() {
        let h = home("missing");
        assert!(read(&h).is_none(), "no db → None");
        let db = h.join(".cc-switch").join("cc-switch.db");
        rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TABLE settings (k TEXT)").unwrap();
        assert!(read(&h).is_none(), "no providers table → None, never a guess");
        let _ = std::fs::remove_dir_all(&h);
    }
}
