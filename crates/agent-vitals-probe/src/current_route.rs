//! 「当前路线」提示器 —— 「测试」tab 主动测试的默认对象（2026-09-20 v1.2）。
//!
//! 转向背景（spec §0）：主动探针的隔离注入在 cc-switch 型机器上被
//! `~/.claude/settings.json` 的 `env` 块压制（claude CLI 启动时自注入，优先级
//! 高于进程 env）。与其对抗（`--settings` 隔离会逼凭据离开 env-only 红线），
//! 不如把「测当前生效的路线本身」作为一等入口：不注入、不覆盖，claude 按
//! 用户自己的配置发起请求——测的就是用户每天在用的东西，失败（如 402）也是
//! 诚实的答案。
//!
//! 白名单纪律（与 `discover.rs` / `harnesses/ccswitch.rs` 同源）：只从
//! `~/.claude/settings.json` 取 `env.ANTHROPIC_BASE_URL` 与
//! `env.ANTHROPIC_MODEL` 两个键；`ANTHROPIC_AUTH_TOKEN` 等凭据**连值都不
//! 读出**——`CurrentRouteHint` 没有放凭据的槽位，Debug 天然安全（测试钉住）。
//! 文件缺失/不合法 → `None`（无自定义配置 = 官方默认，如实说，不猜）。

use std::path::Path;

use serde_json::Value;

/// 「当前路线」在 probe_routes 里的稳定 route_id（`probe run --route-a current`
/// 解析到它；UI 主动测试按钮也用它）。
pub const CURRENT_ROUTE_ID: &str = "current-claude-code";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentRouteHint {
    /// 中转端点（无自定义 = None = 官方直连）。
    pub base_url: Option<String>,
    /// 用户配置的默认模型（settings `env.ANTHROPIC_MODEL`；无则 None）。
    pub model: Option<String>,
}

/// 白名单提取。文件不存在 / JSON 不合法 / 没有 env 块 → `None`。
pub fn read_claude_settings_hint(home: &Path) -> Option<CurrentRouteHint> {
    let settings = std::fs::read_to_string(home.join(".claude").join("settings.json")).ok()?;
    let doc: Value = serde_json::from_str(&settings).ok()?;
    let env = doc.get("env")?;
    let pick = |key: &str| {
        env.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(CurrentRouteHint {
        base_url: pick("ANTHROPIC_BASE_URL"),
        model: pick("ANTHROPIC_MODEL"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("av-probe-current-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        dir
    }

    // 真机 2026-09-20 形状：中转三件套都在 env 里，凭据与端点挨着。
    const RELAY_SETTINGS: &str = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-SECRET-TOKEN","ANTHROPIC_BASE_URL":"https://router.shengsuanyun.com/api","ANTHROPIC_MODEL":"anthropic/claude-sonnet-5"}}"#;

    #[test]
    fn reads_relay_hint_without_ever_touching_the_token() {
        let h = home("relay");
        std::fs::write(h.join(".claude").join("settings.json"), RELAY_SETTINGS).unwrap();
        let hint = read_claude_settings_hint(&h).expect("hint");
        assert_eq!(hint.base_url.as_deref(), Some("https://router.shengsuanyun.com/api"));
        assert_eq!(hint.model.as_deref(), Some("anthropic/claude-sonnet-5"));
        let text = format!("{hint:?}");
        for forbidden in ["SECRET", "sk-", "AUTH_TOKEN"] {
            assert!(!text.contains(forbidden), "leaked {forbidden}: {text}");
        }
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn missing_or_unparsable_settings_is_none_official_default() {
        let h = home("missing");
        assert!(read_claude_settings_hint(&h).is_none(), "无文件 → None（官方默认）");
        std::fs::write(h.join(".claude").join("settings.json"), "not json").unwrap();
        assert!(read_claude_settings_hint(&h).is_none(), "坏 JSON → None，不猜");
        std::fs::write(h.join(".claude").join("settings.json"), "{\"env\":{}}").unwrap();
        let hint = read_claude_settings_hint(&h).expect("空 env 块也是合法提示");
        assert_eq!(hint.base_url, None);
        assert_eq!(hint.model, None);
        let _ = std::fs::remove_dir_all(&h);
    }
}
