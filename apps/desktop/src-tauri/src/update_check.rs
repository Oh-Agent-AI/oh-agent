//! 应用内版本检查的纯选择逻辑（无网络、无 Tauri 依赖，便于单测）。
//!
//! 为什么不用 GitHub `/releases/latest`：该端点会跳过 prerelease，
//! 1.0.0-beta.* 用户永远看不到更新的 beta。这里改为拉取
//! `/releases?per_page=100` 列表（单次请求），自行按通道与 semver 选出候选：
//!
//! - 只认 `app-v<semver>` 标签（仓库历史上还有 `skill-v*` 等其它标签族）；
//! - 跳过 draft；
//! - 当前是预发布版（如 1.0.0-beta.3）→ 预发布与正式版都参与比较；
//!   当前是正式版 → 只看正式版，不把 beta 推给正式版用户；
//! - 只有严格更新（semver 优先级，beta.10 > beta.9，1.0.0 > 1.0.0-beta.N）才算有更新。

use semver::Version;
use serde_json::Value;

/// 可信发布页根；单个 release 页链接必须严格落在 `{TRUSTED_RELEASES_URL}/tag/<tag>`。
pub const TRUSTED_RELEASES_URL: &str = "https://github.com/Oh-Agent-AI/oh-agent/releases";
/// 发布列表 API（含 prerelease）。owner/repo 与 TRUSTED_RELEASES_URL 保持一致。
/// `per_page=100` 是 GitHub 单次请求上限，避免 `skill-v*` 等其它标签族把最新 `app-v*` 挤出第一页。
pub const RELEASES_API: &str =
    "https://api.github.com/repos/Oh-Agent-AI/oh-agent/releases?per_page=100";
pub const APP_TAG_PREFIX: &str = "app-v";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseCandidate {
    pub tag: String,
    pub version: Version,
    /// semver 带预发布段，或 GitHub 把它标成 prerelease，都视为预发布。
    pub prerelease: bool,
    /// 校验通过的 release 页链接；不可信时回落到 TRUSTED_RELEASES_URL。
    pub release_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateSelection {
    /// 当前通道内可见的最新发布（可能等于当前版本）。
    pub latest: ReleaseCandidate,
    /// 只有 latest 严格新于当前版本时为 true。
    pub update_available: bool,
}

/// `/releases` 列表按通道选择的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectOutcome {
    Selected(UpdateSelection),
    /// 当前是正式版，列表里有 `app-v` 发布，但通道内没有正式版可推（只剩 beta）。
    /// 不是「仓库没有发布」——不能用 no_release 的出错口吻。
    OnLatestStable,
    /// 列表为空、不是数组、或没有任何可解析的 `app-v` 发布。
    None,
}

/// GitHub `/releases` 的 HTTP 分类。403 并不都是限流。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleasesHttpClass {
    Ok,
    NotFound,
    RateLimited,
    Forbidden,
    Other,
}

/// 与前端 `parseUpdateCheck` 的标签白名单一致：`app-v` + `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`。
fn tag_is_safe(tag: &str) -> bool {
    let Some(rest) = tag.strip_prefix(APP_TAG_PREFIX) else {
        return false;
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    rest.len() <= 64 && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 只接受 `https://github.com/Oh-Agent-AI/oh-agent/releases/tag/<tag>` 这一种形态。
fn trusted_release_url(html_url: Option<&str>, tag: &str) -> String {
    let expected = format!("{TRUSTED_RELEASES_URL}/tag/{tag}");
    match html_url {
        Some(url) if url == expected => expected,
        _ => TRUSTED_RELEASES_URL.to_string(),
    }
}

/// `open_trusted_releases_page` 只允许打开发布根或 `{root}/tag/<safe app-v tag>`。
/// 其它任何字符串（其它 host、query、fragment、非 app-v 标签）都回落到根，不跟前端走。
pub fn resolve_open_url(requested: Option<&str>) -> String {
    match requested {
        None => TRUSTED_RELEASES_URL.to_string(),
        Some(url) if url == TRUSTED_RELEASES_URL => TRUSTED_RELEASES_URL.to_string(),
        Some(url) => {
            let prefix = format!("{TRUSTED_RELEASES_URL}/tag/");
            match url.strip_prefix(&prefix) {
                Some(tag) if tag_is_safe(tag) => format!("{TRUSTED_RELEASES_URL}/tag/{tag}"),
                _ => TRUSTED_RELEASES_URL.to_string(),
            }
        }
    }
}

/// 区分「真限流」和其它 403。
///
/// - 429 → 限流
/// - 403 且 `x-ratelimit-remaining` 解析为 0，或带非空 `retry-after` → 限流
///   （GitHub 主限额耗尽是 403 + remaining=0；次级限额常用 403/429 + Retry-After）
/// - 其它 403 → Forbidden（仍应静默降级为 unavailable，但 reason 不能写成 rate_limited）
pub fn classify_releases_http(
    status: u16,
    ratelimit_remaining: Option<&str>,
    retry_after: Option<&str>,
) -> ReleasesHttpClass {
    match status {
        200..=299 => ReleasesHttpClass::Ok,
        404 => ReleasesHttpClass::NotFound,
        429 => ReleasesHttpClass::RateLimited,
        403 => {
            if remaining_exhausted(ratelimit_remaining) || retry_after_present(retry_after) {
                ReleasesHttpClass::RateLimited
            } else {
                ReleasesHttpClass::Forbidden
            }
        }
        _ => ReleasesHttpClass::Other,
    }
}

fn remaining_exhausted(remaining: Option<&str>) -> bool {
    remaining
        .and_then(|value| value.trim().parse::<u64>().ok())
        .is_some_and(|n| n == 0)
}

fn retry_after_present(retry_after: Option<&str>) -> bool {
    retry_after.is_some_and(|value| !value.trim().is_empty())
}

/// 把单条 release JSON 解析成候选；draft、非 app-v、非 semver、不安全标签一律 None。
pub fn parse_release(entry: &Value) -> Option<ReleaseCandidate> {
    if entry.get("draft").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let tag = entry.get("tag_name").and_then(Value::as_str)?;
    if !tag_is_safe(tag) {
        return None;
    }
    let version = Version::parse(&tag[APP_TAG_PREFIX.len()..]).ok()?;
    let flagged = entry
        .get("prerelease")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(ReleaseCandidate {
        tag: tag.to_string(),
        prerelease: flagged || !version.pre.is_empty(),
        release_url: trusted_release_url(entry.get("html_url").and_then(Value::as_str), tag),
        version,
    })
}

/// 从 `/releases` 列表里按通道选出最新候选。
pub fn select_update(current: &Version, releases: &Value) -> SelectOutcome {
    let Some(entries) = releases.as_array() else {
        return SelectOutcome::None;
    };
    let parsed: Vec<ReleaseCandidate> = entries.iter().filter_map(parse_release).collect();
    if parsed.is_empty() {
        return SelectOutcome::None;
    }
    let allow_prerelease = !current.pre.is_empty();
    let latest = parsed
        .into_iter()
        .filter(|candidate| allow_prerelease || !candidate.prerelease)
        .max_by(|a, b| {
            a.version
                .cmp_precedence(&b.version)
                .then_with(|| a.version.cmp(&b.version))
        });
    match latest {
        Some(latest) => {
            let update_available = latest.version.cmp_precedence(current).is_gt();
            SelectOutcome::Selected(UpdateSelection {
                latest,
                update_available,
            })
        }
        None if current.pre.is_empty() => SelectOutcome::OnLatestStable,
        None => SelectOutcome::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn rel(tag: &str, prerelease: bool) -> Value {
        json!({
            "tag_name": tag,
            "draft": false,
            "prerelease": prerelease,
            "html_url": format!("{TRUSTED_RELEASES_URL}/tag/{tag}"),
        })
    }

    fn selected(current: &str, list: Value) -> UpdateSelection {
        match select_update(&v(current), &list) {
            SelectOutcome::Selected(sel) => sel,
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    #[test]
    fn releases_api_is_single_page_of_100() {
        assert!(
            RELEASES_API.ends_with("?per_page=100"),
            "{RELEASES_API}"
        );
        assert_eq!(RELEASES_API.matches("per_page=").count(), 1);
        assert!(!RELEASES_API.contains("&page="));
        assert!(!RELEASES_API.contains("?page="));
    }

    #[test]
    fn newest_app_release_survives_a_full_page_of_other_tag_families() {
        let mut list = Vec::new();
        for i in 0..80 {
            list.push(rel(&format!("skill-v{i}.0.0"), false));
        }
        list.push(rel("app-v1.0.0-beta.4", true));
        for i in 80..99 {
            list.push(rel(&format!("cli-v{i}.0.0"), false));
        }
        assert_eq!(list.len(), 100);
        let sel = selected("1.0.0-beta.3", json!(list));
        assert_eq!(sel.latest.tag, "app-v1.0.0-beta.4");
        assert!(sel.update_available);
    }

    #[test]
    fn stable_user_ignores_betas() {
        let list = json!([rel("app-v1.1.0-beta.1", true), rel("app-v1.0.0", false)]);
        let sel = selected("1.0.0", list);
        assert_eq!(sel.latest.tag, "app-v1.0.0");
        assert!(!sel.update_available);
    }

    #[test]
    fn stable_user_with_only_prereleases_is_on_latest_stable_not_missing() {
        assert_eq!(
            select_update(&v("1.0.0"), &json!([rel("app-v1.1.0-beta.1", true)])),
            SelectOutcome::OnLatestStable
        );
        // 列表里没有任何 app-v：那才是真的没有发布，不能说「已是最新正式版」。
        assert_eq!(
            select_update(&v("1.0.0"), &json!([rel("skill-v9.9.9", false)])),
            SelectOutcome::None
        );
        assert_eq!(select_update(&v("1.0.0"), &json!([])), SelectOutcome::None);
        // beta 用户通道内没有候选，仍是 None（不是「最新正式版」）。
        assert_eq!(
            select_update(&v("1.0.0-beta.3"), &json!([rel("skill-v9.9.9", false)])),
            SelectOutcome::None
        );
    }

    #[test]
    fn stable_user_ignores_github_flagged_prerelease_even_with_plain_version() {
        let list = json!([rel("app-v1.2.0", true), rel("app-v1.1.0", false)]);
        let sel = selected("1.0.0", list);
        assert_eq!(sel.latest.tag, "app-v1.1.0");
        assert!(sel.update_available);
    }

    #[test]
    fn beta_user_sees_newer_beta() {
        let list = json!([
            rel("app-v1.0.0-beta.4", true),
            rel("app-v1.0.0-beta.3", true)
        ]);
        let sel = selected("1.0.0-beta.3", list);
        assert_eq!(sel.latest.tag, "app-v1.0.0-beta.4");
        assert!(sel.update_available);
        assert_eq!(
            sel.latest.release_url,
            format!("{TRUSTED_RELEASES_URL}/tag/app-v1.0.0-beta.4")
        );
    }

    #[test]
    fn beta_user_sees_stable_release() {
        let list = json!([rel("app-v1.0.0", false), rel("app-v1.0.0-beta.9", true)]);
        let sel = selected("1.0.0-beta.3", list);
        assert_eq!(sel.latest.tag, "app-v1.0.0");
        assert!(sel.update_available);
    }

    #[test]
    fn ignores_non_app_tags_and_drafts() {
        let mut draft = rel("app-v1.0.0-beta.9", true);
        draft["draft"] = json!(true);
        let list = json!([
            rel("skill-v9.9.9", false),
            rel("v9.9.9", false),
            rel("app-vnext", false),
            rel("app-v2.0.0+build/../x", false),
            draft,
            rel("app-v1.0.0-beta.3", true),
        ]);
        let sel = selected("1.0.0-beta.2", list);
        assert_eq!(sel.latest.tag, "app-v1.0.0-beta.3");
        assert!(sel.update_available);
    }

    #[test]
    fn beta_10_is_newer_than_beta_9() {
        let list = json!([
            rel("app-v1.0.0-beta.9", true),
            rel("app-v1.0.0-beta.10", true)
        ]);
        let sel = selected("1.0.0-beta.9", list);
        assert_eq!(sel.latest.tag, "app-v1.0.0-beta.10");
        assert!(sel.update_available);
    }

    #[test]
    fn equal_version_is_not_an_update() {
        let list = json!([rel("app-v1.0.0-beta.3", true)]);
        let sel = selected("1.0.0-beta.3", list);
        assert_eq!(sel.latest.tag, "app-v1.0.0-beta.3");
        assert!(!sel.update_available);
    }

    #[test]
    fn older_release_is_not_an_update() {
        let list = json!([rel("app-v1.0.0-beta.2", true)]);
        let sel = selected("1.0.0-beta.3", list);
        assert!(!sel.update_available);
    }

    #[test]
    fn empty_or_malformed_list_yields_none() {
        assert_eq!(
            select_update(&v("1.0.0-beta.3"), &json!([])),
            SelectOutcome::None
        );
        assert_eq!(
            select_update(
                &v("1.0.0-beta.3"),
                &json!({"message": "API rate limit exceeded"})
            ),
            SelectOutcome::None
        );
        assert_eq!(
            select_update(&v("1.0.0-beta.3"), &json!([{"draft": false}])),
            SelectOutcome::None
        );
    }

    #[test]
    fn untrusted_html_url_falls_back_to_releases_root() {
        let mut evil = rel("app-v1.0.0-beta.4", true);
        evil["html_url"] =
            json!("https://evil.example/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.4");
        let mut other_repo = rel("app-v1.0.0-beta.5", true);
        other_repo["html_url"] =
            json!("https://github.com/someone/fork/releases/tag/app-v1.0.0-beta.5");
        for entry in [evil, other_repo] {
            let cand = parse_release(&entry).unwrap();
            assert_eq!(cand.release_url, TRUSTED_RELEASES_URL);
        }
    }

    #[test]
    fn resolve_open_url_only_allows_root_or_safe_app_tag_page() {
        assert_eq!(resolve_open_url(None), TRUSTED_RELEASES_URL);
        assert_eq!(
            resolve_open_url(Some(TRUSTED_RELEASES_URL)),
            TRUSTED_RELEASES_URL
        );
        let good = format!("{TRUSTED_RELEASES_URL}/tag/app-v1.0.0-beta.4");
        assert_eq!(resolve_open_url(Some(&good)), good);
        assert_eq!(
            resolve_open_url(Some(
                "https://evil.example/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.4"
            )),
            TRUSTED_RELEASES_URL
        );
        assert_eq!(
            resolve_open_url(Some(&format!("{good}?next=1"))),
            TRUSTED_RELEASES_URL
        );
        assert_eq!(
            resolve_open_url(Some(&format!("{good}#notes"))),
            TRUSTED_RELEASES_URL
        );
        assert_eq!(
            resolve_open_url(Some(&format!(
                "{TRUSTED_RELEASES_URL}/tag/skill-v1.0.0"
            ))),
            TRUSTED_RELEASES_URL
        );
        assert_eq!(
            resolve_open_url(Some(&format!(
                "{TRUSTED_RELEASES_URL}/tag/app-v1.0.0/extra"
            ))),
            TRUSTED_RELEASES_URL
        );
        assert_eq!(
            resolve_open_url(Some(&format!(
                "{TRUSTED_RELEASES_URL}/tag/app-v2.0.0+build/../x"
            ))),
            TRUSTED_RELEASES_URL
        );
    }

    #[test]
    fn http_429_and_403_with_exhausted_quota_are_rate_limited() {
        assert_eq!(
            classify_releases_http(429, None, None),
            ReleasesHttpClass::RateLimited
        );
        assert_eq!(
            classify_releases_http(429, Some("10"), None),
            ReleasesHttpClass::RateLimited
        );
        assert_eq!(
            classify_releases_http(403, Some("0"), None),
            ReleasesHttpClass::RateLimited
        );
        assert_eq!(
            classify_releases_http(403, Some(" 0 "), None),
            ReleasesHttpClass::RateLimited
        );
        assert_eq!(
            classify_releases_http(403, Some("10"), Some("30")),
            ReleasesHttpClass::RateLimited
        );
        assert_eq!(
            classify_releases_http(403, None, Some("10")),
            ReleasesHttpClass::RateLimited
        );
    }

    #[test]
    fn other_403s_are_forbidden_not_rate_limited() {
        assert_eq!(
            classify_releases_http(403, None, None),
            ReleasesHttpClass::Forbidden
        );
        assert_eq!(
            classify_releases_http(403, Some("58"), None),
            ReleasesHttpClass::Forbidden
        );
        assert_eq!(
            classify_releases_http(403, Some("not-a-number"), Some("")),
            ReleasesHttpClass::Forbidden
        );
        assert_eq!(
            classify_releases_http(401, None, None),
            ReleasesHttpClass::Other
        );
        assert_eq!(
            classify_releases_http(500, None, None),
            ReleasesHttpClass::Other
        );
        assert_eq!(
            classify_releases_http(404, None, None),
            ReleasesHttpClass::NotFound
        );
    }

    /// 2026-10-22 实拍的 `/releases` 响应（精简字段），见 fixtures 文件。
    #[test]
    fn live_fixture_beta3() {
        let list: Value =
            serde_json::from_str(include_str!("../tests/fixtures/releases-2026-10-22.json"))
                .unwrap();
        let sel = selected("1.0.0-beta.2", list.clone());
        assert_eq!(sel.latest.tag, "app-v1.0.0-beta.3");
        assert!(sel.update_available);
        assert_eq!(
            sel.latest.release_url,
            "https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3"
        );
        let sel = selected("1.0.0-beta.3", list.clone());
        assert!(!sel.update_available);
        // 正式版用户在只有 beta 的仓库里：检查成功，只是没有更新的正式版。
        assert_eq!(
            select_update(&v("1.0.0"), &list),
            SelectOutcome::OnLatestStable
        );
    }
}
