//! 发起期凭据解析：`credential_ref` 引用 → 内存中的 (base_url, token)。
//!
//! 政策红线（AGENTS.md 2026-09-19 节 + WORKBENCH_TEST_TAB_SPEC §7）：
//! 凭据**只在发起探针的瞬间**从 cc-switch DB 或环境变量读入内存，作为子进程
//! env 传给 claude/codex CLI，随后连同本值一起 Drop；不落库、不落盘、不进
//! 日志。本类型的 `Debug` 手写脱敏（只打引用与 token 长度），防止 `{:?}` 意外
//! 泄漏——与 harnesses/ccswitch.rs「证据读取器永不复制凭据」是**两条并行的边界**：
//! 那条服务于证据面（永不取出），这条服务于发起面（取出即用即弃）。

use std::path::PathBuf;

/// 解析后的发起凭据。Debug 脱敏（见模块 doc）。
pub struct LaunchCredential {
    pub base_url: Option<String>,
    pub auth_token: String,
}

impl std::fmt::Debug for LaunchCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaunchCredential")
            .field("base_url", &self.base_url)
            .field("auth_token", &format!("<redacted:{}chars>", self.auth_token.len()))
            .finish()
    }
}

fn ccswitch_db_path() -> Option<PathBuf> {
    dirs_home().map(|home| home.join(".cc-switch").join("cc-switch.db"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// `ccswitch:<provider_row>` → 打开 `~/.cc-switch/cc-switch.db`（只读），
/// 按 `providers.id` 取 `settings_config`，抽 `env.ANTHROPIC_AUTH_TOKEN` 与
/// `env.ANTHROPIC_BASE_URL`。找不到/解析失败返回带原因的错误（token 绝不
/// 出现在错误文本里）。
///
/// id 按**文本**匹配（`CAST(id AS TEXT)`）：真机 cc-switch 的 id 是 UUID 字符串
/// （`32242fef-…`），老版本按整数 parse 会把整台机器的中转引用全拒掉；
/// 数值型 id（自建库/测试夹具）CAST 后同样是十进制文本，两种形状都命中。
fn resolve_from_ccswitch(provider_row: &str, harness_kind: &str) -> Result<LaunchCredential, String> {
    let Some(path) = ccswitch_db_path() else {
        return Err("cc-switch credential requires $HOME".to_string());
    };
    if !path.exists() {
        return Err(format!(
            "cc-switch db not found at {} (route credential_ref points there)",
            path.display()
        ));
    }
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| format!("open cc-switch db read-only: {error}"))?;
    let settings: String = conn
        .query_row(
            "SELECT settings_config FROM providers WHERE CAST(id AS TEXT) = ?1",
            rusqlite::params![provider_row],
            |row| row.get(0),
        )
        .map_err(|error| format!("cc-switch provider row lookup failed: {error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&settings).map_err(|error| format!("cc-switch settings parse: {error}"))?;
    let env = value.get("env").cloned().unwrap_or(serde_json::Value::Null);
    let token = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            format!(
                "cc-switch provider row {provider_row} has no env.ANTHROPIC_AUTH_TOKEN (harness_kind={harness_kind})"
            )
        })?
        .to_string();
    let base_url = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok(LaunchCredential { base_url, auth_token: token })
}

/// `credential_ref` 引用 → 发起凭据。支持 `env:VAR` 与 `ccswitch:<row>`；
/// 其他格式报错（不猜）。
pub fn resolve(credential_ref: &str, harness_kind: &str) -> Result<LaunchCredential, String> {
    if let Some(var) = credential_ref.strip_prefix("env:") {
        let token = std::env::var(var)
            .map_err(|_| format!("environment variable {var} (credential_ref) is not set"))?;
        return Ok(LaunchCredential { base_url: None, auth_token: token });
    }
    if let Some(row) = credential_ref.strip_prefix("ccswitch:") {
        return resolve_from_ccswitch(row, harness_kind);
    }
    Err(format!(
        "unsupported credential_ref '{credential_ref}' (expected 'env:VAR' or 'ccswitch:<row>')"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_the_token() {
        let credential = LaunchCredential {
            base_url: Some("https://router.example/api".to_string()),
            auth_token: "sk-super-secret-value-123".to_string(),
        };
        let text = format!("{credential:?}");
        assert!(!text.contains("sk-super-secret"), "Debug 必须脱敏：{text}");
        assert!(text.contains("<redacted:25chars>"), "{text}");
    }

    #[test]
    fn ccswitch_resolution_reads_env_fields_from_readonly_db() {
        let dir = std::env::temp_dir().join(format!("av-ccsw-{}", std::process::id()));
        let switch_dir = dir.join(".cc-switch");
        std::fs::create_dir_all(&switch_dir).unwrap();
        let db = switch_dir.join("cc-switch.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (id INTEGER PRIMARY KEY, settings_config TEXT NOT NULL);
             INSERT INTO providers(id, settings_config) VALUES (7, '{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-RELAY-TOKEN\",\"ANTHROPIC_BASE_URL\":\"https://router.example/api\"}}');",
        ).unwrap();
        drop(conn);
        // 指向临时 HOME（resolve_from_ccswitch 读 $HOME/.cc-switch/cc-switch.db）。
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &dir);
        let credential = resolve_from_ccswitch("7", "claude-code").unwrap();
        std::env::set_var("HOME", previous.unwrap_or_default());
        assert_eq!(credential.auth_token, "sk-RELAY-TOKEN");
        assert_eq!(credential.base_url.as_deref(), Some("https://router.example/api"));
        // 错误路径不带 token；坏引用格式报错。
        assert!(resolve_from_ccswitch("not-a-number", "claude-code").is_err());
        assert!(resolve("weird:ref", "claude-code").is_err());
        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_dir(&dir);
    }

    /// 真机回归（2026-09-19）：cc-switch 的 provider id 是 UUID 字符串，老实现
    /// `parse::<i64>()` 会把所有真实引用拒成 "needs a numeric provider row id"。
    #[test]
    fn ccswitch_resolution_accepts_uuid_shaped_provider_ids() {
        let dir = std::env::temp_dir().join(format!("av-ccsw-uuid-{}", std::process::id()));
        let switch_dir = dir.join(".cc-switch");
        std::fs::create_dir_all(&switch_dir).unwrap();
        let db = switch_dir.join("cc-switch.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (id TEXT PRIMARY KEY, settings_config TEXT NOT NULL);
             INSERT INTO providers(id, settings_config) VALUES ('32242fef-e53e-483c-a082-1ebaf1f2b234',
                '{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-UUID-RELAY\",\"ANTHROPIC_BASE_URL\":\"https://router.shengsuanyun.com/api\"}}');",
        )
        .unwrap();
        drop(conn);
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &dir);
        let resolved = resolve_from_ccswitch("32242fef-e53e-483c-a082-1ebaf1f2b234", "claude-code");
        std::env::set_var("HOME", previous.unwrap_or_default());
        let credential = resolved.expect("UUID-shaped provider row must resolve");
        assert_eq!(credential.auth_token, "sk-UUID-RELAY");
        assert_eq!(credential.base_url.as_deref(), Some("https://router.shengsuanyun.com/api"));
        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_dir(&dir);
    }
}
