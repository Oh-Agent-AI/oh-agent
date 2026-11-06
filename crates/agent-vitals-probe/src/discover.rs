//! cc-switch → 探针路线的**默认发现器**（「测试」tab 的默认配置来源）。
//!
//! 背景：用户的中转配置已经在 `~/.cc-switch/cc-switch.db` 里（billing 证据链
//! 2026-09 起就在读它），让用户手敲 `--endpoint` + `--credential-ref` 等于要求
//! 他们复述机器已知的事实。本模块把这份事实变成路线档案的**候选**——注册与
//! consent 仍是两步显式动作，发现本身零副作用、零凭据接触。
//!
//! 白名单纪律（与 `harnesses/sources/ccswitch.rs` 同源）：只读
//! `id / app_type / name` 三列 + `settings_config` 里的
//! `env.ANTHROPIC_BASE_URL` 与 `env.ANTHROPIC_MODEL` 两个键。凭据键
//! （`ANTHROPIC_AUTH_TOKEN` 等）连值都不取出——`DiscoveredRoute` 没有放
//! 凭据的槽位，`Debug` 因此天然安全（测试钉住）。库以只读打开，不写不建
//! journal。
//!
//! 只发现 `app_type = "claude"` 且 base_url 与 model **都**在的行：
//! - 官方直连行（无 base_url）不进来——探针的官方路线走 CLI 自身登录，
//!   不需要 cc-switch 引用（「测试」tab 的空态文案另给命令）；
//! - 无 `ANTHROPIC_MODEL` 的中转行不进来——不知道该请求什么模型的身份
//!   探针没有可判定的基准，宁缺毋滥（跳过原因进 `ScanReport::skipped`，
//!   不静默）。
//!
//! 同一 (base_url, model) 的重复行（如「胜算云」与「胜算云（前台）」请求
//! 同一模型）合并为一条——两个 route 档案跑不出第二个结论。

use std::path::Path;

use serde_json::Value;

/// 一条可注册的中转路线候选。没有凭据槽位（见模块 doc）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredRoute {
    /// cc-switch `providers.id` 原样（真机是 UUID 字符串； credential_ref 写成
    /// `ccswitch:<这一串>`，发起期由 `credentials::resolve` 按同款 CAST 匹配）。
    pub provider_row: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
}

/// 扫描结果：候选 + 被跳过行的原因（label + 为什么），跳过不静默。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub routes: Vec<DiscoveredRoute>,
    pub skipped: Vec<String>,
}

/// 读 `<home>/.cc-switch/cc-switch.db`（只读）。库不存在 / 打不开 / 表不存在
/// 都是 `Err`（带路径与原因）——「没装 cc-switch」与「装了但读不了」对用户的
/// 下一步动作不同，不吞成空列表。
pub fn scan_ccswitch(home: &Path) -> Result<ScanReport, String> {
    let db = home.join(".cc-switch").join("cc-switch.db");
    if !db.is_file() {
        return Err(format!(
            "cc-switch db not found at {} (install or configure cc-switch first)",
            db.display()
        ));
    }
    let conn = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("open cc-switch db read-only: {error}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, settings_config FROM providers
             WHERE app_type = 'claude' ORDER BY id",
        )
        .map_err(|error| format!("cc-switch providers table unreadable: {error}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("cc-switch providers query: {error}"))?;

    let mut report = ScanReport::default();
    for row in rows.flatten() {
        let (id, name, settings) = row;
        let doc: Value = match serde_json::from_str(&settings) {
            Ok(doc) => doc,
            Err(_) => {
                report.skipped.push(format!("{name}: settings_config 不是合法 JSON"));
                continue;
            }
        };
        let env = doc.get("env").cloned().unwrap_or(Value::Null);
        let pick = |key: &str| {
            env.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let (Some(base_url), Some(model)) = (pick("ANTHROPIC_BASE_URL"), pick("ANTHROPIC_MODEL"))
        else {
            let why = if pick("ANTHROPIC_BASE_URL").is_some() {
                "有 base_url 但没有 ANTHROPIC_MODEL——身份探针没有请求基准"
            } else {
                "无 base_url（官方直连不需要 cc-switch 引用；用 --label 官方直连 手工注册）"
            };
            report.skipped.push(format!("{name}: {why}"));
            continue;
        };
        // 同 (base_url, model) 合并：首见保留（ORDER BY id 确定性），label 并列记名。
        match report
            .routes
            .iter_mut()
            .find(|r| r.base_url == base_url && r.model == model)
        {
            Some(existing) => {
                if !existing.label.split(" / ").any(|l| l == name) {
                    existing.label = format!("{} / {}", existing.label, name);
                }
            }
            None => report.routes.push(DiscoveredRoute {
                provider_row: id,
                label: name,
                base_url,
                model,
            }),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("av-probe-scan-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".cc-switch")).unwrap();
        dir
    }

    fn create_db(path: &Path, rows: &[(&str, &str, &str, &str)]) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
                settings_config TEXT NOT NULL, created_at INTEGER, is_current BOOLEAN NOT NULL DEFAULT 0)",
        )
        .unwrap();
        for (id, app_type, name, settings) in rows {
            conn.execute(
                "INSERT INTO providers(id, app_type, name, settings_config) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, app_type, name, settings],
            )
            .unwrap();
        }
    }

    // 真机 2026-09-19 形状：UUID id；凭据与端点在 env 里挨着。
    const SSY: &str = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-SECRET-SSY","ANTHROPIC_BASE_URL":"https://router.shengsuanyun.com/api","ANTHROPIC_MODEL":"deepseek/deepseek-v4-pro-0813"}}"#;
    const SSY_FRONT: &str = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-SECRET-FRONT","ANTHROPIC_BASE_URL":"https://router.shengsuanyun.com/api","ANTHROPIC_MODEL":"bigmodel/glm-5.3-flash[1M]"}}"#;
    const GLM_DUP: &str = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-SECRET-GLM","ANTHROPIC_BASE_URL":"https://router.shengsuanyun.com/api","ANTHROPIC_MODEL":"bigmodel/glm-5.3-flash[1M]"}}"#;
    const OFFICIAL: &str = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-SECRET-OFFICIAL"}}"#;
    const NO_MODEL: &str = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-SECRET-NM","ANTHROPIC_BASE_URL":"https://api.example-relay.com/anthropic"}}"#;
    const CODEX: &str = r#"{"config":"model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://router.cogfoundry.ai/api/v1\"\nexperimental_bearer_token = \"sk-SECRET-COG\""}"#;

    #[test]
    fn scans_claude_relays_merges_duplicates_and_reports_skips() {
        let h = home("full");
        create_db(&h.join(".cc-switch").join("cc-switch.db"), &[
            ("32242fef-e53e-483c-a082-1ebaf1f2b234", "claude", "胜算云", SSY),
            ("9f4e8429-3ca1-4baf-aac7-fa7486a20a3a", "claude", "胜算云（前台）", SSY_FRONT),
            // 同端点同模型的第二条（用户另起的名）——合并、label 并列。
            ("41cca70b-1367-4fa9-b2eb-1d4f8be0e52b", "claude", "Zhipu GLM", GLM_DUP),
            ("claude-official", "claude", "Claude Official", OFFICIAL),
            ("e1e3e281-7c9f-4093-95d6-64f068b619ac", "claude", "无模型中转", NO_MODEL),
            ("5c53f58b-6b18-449d-8dc1-eb6e31cd7e0e", "codex", "cogfoundry.ai", CODEX),
        ]);
        let report = scan_ccswitch(&h).unwrap();
        assert_eq!(report.routes.len(), 2, "{report:?}");
        assert_eq!(report.routes[0].label, "胜算云");
        assert_eq!(report.routes[0].provider_row, "32242fef-e53e-483c-a082-1ebaf1f2b234");
        assert_eq!(report.routes[0].base_url, "https://router.shengsuanyun.com/api");
        assert_eq!(report.routes[0].model, "deepseek/deepseek-v4-pro-0813");
        // 合并行：label 并列、取首见的 provider_row（凭据指向首个注册者）。
        // ORDER BY id 文本序：41cca70b（Zhipu GLM）先于 9f4e8429（胜算云前台）。
        assert_eq!(report.routes[1].label, "Zhipu GLM / 胜算云（前台）");
        assert_eq!(report.routes[1].provider_row, "41cca70b-1367-4fa9-b2eb-1d4f8be0e52b");
        // 跳过不静默：官方直连（无 base_url）与无模型行各占一条原因；codex 不算 claude 跳过项。
        assert_eq!(report.skipped.len(), 2, "{report:?}");
        assert!(report.skipped.iter().any(|s| s.starts_with("Claude Official")));
        assert!(report.skipped.iter().any(|s| s.starts_with("无模型中转")));
        // 白名单纪律：整个 Debug 输出不得出现任何凭据材料。
        let text = format!("{report:?}");
        for forbidden in ["SECRET", "sk-", "AUTH_TOKEN"] {
            assert!(!text.contains(forbidden), "leaked {forbidden}: {text}");
        }
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn missing_db_is_an_error_not_an_empty_list() {
        let h = home("missing");
        let err = scan_ccswitch(&h).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        let _ = std::fs::remove_dir_all(&h);
    }
}
