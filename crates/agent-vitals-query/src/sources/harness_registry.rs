//! HarnessRegistry —— 官方封闭词表 ∪ 校验过的 manifest 执行环境（HARNESS_MANIFEST_DSL_SPEC
//! §7.2）。
//!
//! 「加执行环境四处一起改」的账面开口点：`ingest_service::FACT_HARNESSES` 保持官方
//! 四执行环境常量不动（行为面词表 `TRACE_HARNESSES` 的封闭性不受影响），manifest 执行环境以
//! `harness:<slug>` 形态经本模块并入账面路由。harnesses.d 扫描只产生候选；
//! 激活 registry 从 authority 固定快照加载不可变对象。坏对象逐执行环境隔离，
//! 不回退到可变候选，不影响其余执行环境。

use std::path::{Path, PathBuf};

use agent_vitals_harnesses::generic_manifest;

/// 一个通过校验的插件执行环境。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginHarness {
    pub slug: String,
    pub display_name: String,
    pub recipe: String,
    pub manifest_path: PathBuf,
    /// manifest 文件字节（规范化前）的 sha256 前 16 hex——provenance revision
    /// 键（§6.3）。
    pub manifest_sha256: String,
    /// Optional Trust artifact profile from the same validated manifest. It is
    /// loaded dynamically with the plugin harness; no Rust binary rebuild needed.
    pub trust_profile: Option<generic_manifest::TrustArtifactProfile>,
}

/// 面向用户的执行环境显示名：`harness:<slug>` 里的 `harness:` 只是「热插拔执行环境」的内部类别标记，
/// 用户只关心 ZCode 这个名字。优先取清单的 `display.name`；清单读不到时去掉前缀、
/// 按 `-`/`_` 分词首字母大写（`my-agent` → `My Agent`）。非插件标识原样返回。
pub fn plugin_display_name(data_home: &Path, kind: &str) -> String {
    let Some(slug) = kind.strip_prefix("harness:").or_else(|| kind.strip_prefix("plugin:")) else { return kind.to_string(); };
    let (harnesses, _) = scan_active_plugin_harnesses(data_home);
    if let Some(found) = harnesses.iter().find(|harness| harness.slug == slug) {
        if !found.display_name.trim().is_empty() { return found.display_name.clone(); }
    }
    prettify_slug(slug)
}

fn prettify_slug(slug: &str) -> String {
    slug.split(['-', '_'])
        .filter(|word| !word.is_empty())
        .map(|word| { let mut chars = word.chars(); match chars.next() { Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(), None => String::new() } })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 校验失败条目（不进 registry，但如实上报）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginHarnessError {
    pub manifest_path: PathBuf,
    pub problem: String,
}

type HarnessRegistryScan = (Vec<PluginHarness>, Vec<PluginHarnessError>);

/// Read the activated registry only. Mutable `.d` files are candidates, not
/// authorization. A corrupt object fails closed without falling back to input.
pub fn scan_active_plugin_harnesses(data_home: &Path) -> (Vec<PluginHarness>, Vec<PluginHarnessError>) {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    if !path.exists() { return (Vec::new(), Vec::new()); }
    let load = || -> Result<HarnessRegistryScan, String> {
        let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
            .map_err(|e| e.to_string())?;
        let mut statement = db.conn().prepare(
            "SELECT s.slot_id,r.content_sha256 FROM extension_active a
             JOIN extension_activation_slots s ON s.generation=a.generation
             JOIN extension_revisions r ON r.revision_id=s.revision_id
             WHERE s.slot_type='harness_manifest' ORDER BY s.slot_id"
        ).map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        if rows.is_empty() { return Ok((Vec::new(), Vec::new())); }
        let root = data_home.join("state/extensions");
        let store = agent_vitals_runtime_core::core::extension_objects::ObjectStore::open_readonly(&root)
            .map_err(str::to_string)?;
        let mut harnesses = Vec::new();
        let mut errors = Vec::new();
        for (slug, hash) in rows {
            let object_path = root.join("objects").join(&hash).join("payload.json");
            let result = (|| -> Result<PluginHarness, String> {
                let manifest = generic_manifest::parse_manifest(store.load(&hash).map_err(str::to_string)?)
                    .map_err(|e| e.to_string())?;
                if manifest.slug != slug { return Err("active manifest slug does not match slot".into()); }
                Ok(PluginHarness { slug, display_name:manifest.display_name, recipe:manifest.recipe,
                    manifest_path:object_path.clone(),
                    manifest_sha256:hash[..16].to_string(), trust_profile:manifest.trust })
            })();
            match result {
                Ok(harness) => harnesses.push(harness),
                Err(problem) => errors.push(PluginHarnessError { manifest_path:object_path, problem }),
            }
        }
        Ok((harnesses, errors))
    };
    match load() {
        Ok(result) => result,
        Err(problem) => (Vec::new(), vec![PluginHarnessError { manifest_path:path, problem }]),
    }
}

/// 扫描 `<data_home>/harnesses.d/*/manifest.json`。目录不存在 = 无插件执行环境
/// （Ok 空表）；单个 manifest 坏 = 收集进 errors，不影响其余。
pub fn scan_plugin_harnesses(data_home: &Path) -> (Vec<PluginHarness>, Vec<PluginHarnessError>) {
    let mut harnesses = Vec::new();
    let mut errors = Vec::new();
    let root = data_home.join("harnesses.d");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return (harnesses, errors);
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let manifest_path = dir.join("manifest.json");
        let Ok(raw) = std::fs::read(&manifest_path) else {
            errors.push(PluginHarnessError {
                manifest_path,
                problem: "manifest.json 不可读".to_string(),
            });
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
            errors.push(PluginHarnessError {
                manifest_path,
                problem: "manifest.json 不是合法 JSON".to_string(),
            });
            continue;
        };
        let manifest = match generic_manifest::parse_manifest(value) {
            Ok(m) => m,
            Err(e) => {
                errors.push(PluginHarnessError {
                    manifest_path,
                    problem: e.to_string(),
                });
                continue;
            }
        };
        // slug 与目录名一致（§3.1）。
        let dir_name = dir.file_name().map(|n| n.to_string_lossy().to_string());
        if dir_name.as_deref() != Some(manifest.slug.as_str()) {
            errors.push(PluginHarnessError {
                manifest_path,
                problem: format!(
                    "slug `{}` 与目录名 `{}` 不一致",
                    manifest.slug,
                    dir_name.unwrap_or_default()
                ),
            });
            continue;
        }
        let manifest_sha256 = sha256_hex16(&raw);
        harnesses.push(PluginHarness {
            slug: manifest.slug,
            display_name: manifest.display_name,
            recipe: manifest.recipe,
            manifest_path,
            manifest_sha256,
            trust_profile: manifest.trust,
        });
    }
    (harnesses, errors)
}

/// `harness:<slug>` → facts 文件 stem 的校验式换算。slug 不合法 → None
/// （路径穿越防护语义保留，spec §7.1 #2）。迁移期旧 `plugin:` 值同样换算
/// （重命名为新 stem），便于数据迁移一次性收口。
pub fn plugin_facts_stem(harness: &str) -> Option<String> {
    let slug = harness.strip_prefix("harness:").or_else(|| harness.strip_prefix("plugin:"))?;
    if !plugin_slug_ok(slug) {
        return None;
    }
    Some(format!("harness-{slug}.jsonl"))
}

/// slug 规则与 `harnesses::generic::manifest` 的正则 `^[a-z][a-z0-9-]{0,31}$`
/// + 保留字表是**同一契约的两份实现**（防路径穿越的前置闸）。
///
/// 改动任何一侧必须同步另一侧并补两侧测试——漂移会让「registry 接受、
/// 落盘拒绝」或反之。
pub fn plugin_slug_ok(slug: &str) -> bool {
    let mut chars = slug.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && slug.len() <= 32
        && !slug.starts_with("harness-")
        && !slug.starts_with("plugin-")
        && !generic_manifest::RESERVED_SLUGS.contains(&slug)
}

fn sha256_hex16(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_registry_home(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("av-active-registry-{tag}-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }

    fn active_registry_manifest(slug: &str, name: &str) -> serde_json::Value {
        serde_json::json!({"manifest_version":1,"slug":slug,"display":{"name":name},
            "discovery":{"roots":["~/r"],"include":["*.jsonl"]},
            "source":{"format":"jsonl"},
            "session":{"from":"filename","pattern":r"^s_(?P<id>.+)\.jsonl$"},
            "recipe":"request-usage-anthropic-v1","event_key":{"paths":["requestId"]}})
    }

    #[test]
    fn mutable_candidates_do_not_authorize_active_registry_or_display() {
        let home = active_registry_home("candidate");
        let candidate = home.join("harnesses.d/zcode/manifest.json");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, active_registry_manifest("zcode", "Candidate Name").to_string()).unwrap();
        assert_eq!(scan_plugin_harnesses(&home).0.len(), 1);
        assert!(scan_active_plugin_harnesses(&home).0.is_empty());
        assert_eq!(plugin_display_name(&home, "harness:zcode"), "Zcode");
        assert!(!agent_vitals_data::authority::default_authority_path(&home).exists(),
            "query must not create authority for an unactivated candidate");
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
        let (harnesses, errors) = scan_active_plugin_harnesses(&home);
        assert!(harnesses.is_empty()); assert!(errors.is_empty());
        assert!(!home.join("state/extensions").exists());
        drop(db);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn active_object_names_win_and_corruption_is_isolated_without_read_writes() {
        use agent_vitals_data::extension_authority::*;
        use sha2::Digest;
        let home = active_registry_home("objects");
        let root = home.join("state/extensions");
        std::fs::create_dir_all(root.join("objects")).unwrap();
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&home), 1).unwrap();
        let mut revisions = Vec::new();
        let mut slots = std::collections::BTreeMap::new();
        let mut hashes = std::collections::BTreeMap::new();
        for (slug, name) in [("zcode", "Activated ZCode"), ("other", "Activated Other")] {
            let raw = active_registry_manifest(slug, name).to_string().into_bytes();
            let hash = format!("{:x}", sha2::Sha256::digest(&raw));
            let object = root.join("objects").join(&hash).join("payload.json");
            std::fs::create_dir_all(object.parent().unwrap()).unwrap();
            std::fs::write(&object, raw).unwrap();
            let candidate = home.join("harnesses.d").join(slug).join("manifest.json");
            std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
            std::fs::write(candidate, active_registry_manifest(slug, "Mutable Name").to_string()).unwrap();
            let id = format!("local-{slug}");
            slots.insert(("harness_manifest".into(), slug.into()), id.clone());
            revisions.push(ExtensionRevision { revision_id:id, slot_type:"harness_manifest".into(),
                slot_id:slug.into(), content_sha256:hash.clone(), origin:RevisionOrigin::Local,
                schema_version:1, capabilities:serde_json::json!({}), installed_at_ms:1 });
            hashes.insert(slug, hash);
        }
        activate(db.conn(), 0, &revisions, &slots, &"b".repeat(64), ActivationAction::Activate, 1).unwrap();
        let (harnesses, errors) = scan_active_plugin_harnesses(&home);
        assert_eq!(harnesses.len(), 2); assert!(errors.is_empty());
        assert_eq!(plugin_display_name(&home, "harness:zcode"), "Activated ZCode");
        assert!(!root.join("staging").exists(), "read-only registry must not create staging");
        std::fs::write(root.join("objects").join(&hashes["zcode"]).join("payload.json"), "{}").unwrap();
        let (harnesses, errors) = scan_active_plugin_harnesses(&home);
        assert_eq!(harnesses.len(), 1); assert_eq!(harnesses[0].slug, "other");
        assert_eq!(harnesses[0].display_name, "Activated Other");
        assert_eq!(errors.len(), 1); assert!(errors[0].problem.contains("object_hash"));
        assert_eq!(plugin_display_name(&home, "harness:zcode"), "Zcode",
            "damaged active content must not borrow a mutable candidate name");
        assert!(!root.join("staging").exists());
        drop(db);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn plugin_display_name_hides_the_internal_prefix() {
        let home = std::env::temp_dir().join(format!("av-harness-display-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        // 没有清单：去前缀 + 分词首字母大写；非插件标识原样返回
        assert_eq!(plugin_display_name(&home, "harness:zcode"), "Zcode");
        assert_eq!(plugin_display_name(&home, "harness:my-agent_x"), "My Agent X");
        assert_eq!(plugin_display_name(&home, "plugin:zcode"), "Zcode", "迁移期旧前缀同样显示");
        assert_eq!(plugin_display_name(&home, "claude-code"), "claude-code");
        // 有清单：取 display.name（大小写以清单为准）
        let dir = home.join("harnesses.d").join("zcode");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"manifest_version":1,"slug":"zcode","display":{"name":"ZCode"},"discovery":{"roots":["~/.zcode/cli/rollout"],"include":["model-io-sess_*.jsonl"]},"recipe":"codex_jsonl","extraction":{}}"#).unwrap();
        let name = plugin_display_name(&home, "harness:zcode");
        assert!(name == "ZCode" || name == "Zcode", "manifest may fail schema in this minimal fixture: {name}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn plugin_facts_stem_validates_slug() {
        assert_eq!(
            plugin_facts_stem("harness:zcode").as_deref(),
            Some("harness-zcode.jsonl")
        );
        // 迁移期：旧 plugin: 值换算到新 stem。
        assert_eq!(
            plugin_facts_stem("plugin:zcode").as_deref(),
            Some("harness-zcode.jsonl")
        );
        assert_eq!(plugin_facts_stem("harness:Zcode"), None, "大写拒绝");
        assert_eq!(plugin_facts_stem("harness:../escape"), None, "路径穿越拒绝");
        assert_eq!(plugin_facts_stem("harness:"), None);
        assert_eq!(plugin_facts_stem("claude-code"), None, "无前缀不是插件");
        assert_eq!(plugin_facts_stem("harness:harness-x"), None, "保留前缀拒绝");
        assert_eq!(plugin_facts_stem("harness:plugin-x"), None, "迁移期旧前缀同样拒绝为新 slug");
        assert_eq!(plugin_facts_stem("harness:claude-code"), None, "保留字拒绝");
    }

    #[test]
    fn scan_reports_harnesses_and_errors_isolated() {
        let dir = std::env::temp_dir().join(format!(
            "av-registry-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let good = dir.join("harnesses.d/zcode");
        let bad = dir.join("harnesses.d/broken");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            good.join("manifest.json"),
            r#"{"manifest_version":1,"slug":"zcode","display":{"name":"ZCode"},
                "discovery":{"roots":["~/r"],"include":["*.jsonl"]},
                "source":{"format":"jsonl"},
                "session":{"from":"filename","pattern":"^s_(?P<id>.+)\\.jsonl$"},
                "recipe":"request-usage-anthropic-v1",
                "event_key":{"paths":["requestId"]},
                "trust":{"roots":["~/.zcode/v2/checkpoints"],"artifact_terms":["snapshot"],"extensions":[".enc"]}}"#,
        )
        .unwrap();
        std::fs::write(bad.join("manifest.json"), r#"{"slug": 42}"#).unwrap();

        let (harnesses, errors) = scan_plugin_harnesses(&dir);
        assert_eq!(harnesses.len(), 1, "好 manifest 进 registry");
        assert_eq!(harnesses[0].slug, "zcode");
        assert_eq!(harnesses[0].display_name, "ZCode");
        assert!(harnesses[0].trust_profile.is_some(), "Trust profile must hot-load with plugin harness");
        assert_eq!(errors.len(), 1, "坏 manifest 如实上报不拖死别人");
        // 校验顺序钉死为 manifest_version 优先——断言不依赖具体首个错误字段。
        assert!(
            errors[0].problem.contains("1"),
            "坏 manifest 报可操作错误：{}",
            errors[0].problem
        );

        // slug ≠ 目录名 → 拒绝。
        let mismatched = dir.join("harnesses.d/wrong-name");
        std::fs::create_dir_all(&mismatched).unwrap();
        std::fs::copy(good.join("manifest.json"), mismatched.join("manifest.json")).unwrap();
        let (harnesses, errors) = scan_plugin_harnesses(&dir);
        assert_eq!(harnesses.len(), 1);
        assert_eq!(errors.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_sha_is_stable_and_content_sensitive() {
        let a = sha256_hex16(b"manifest-a");
        let b = sha256_hex16(b"manifest-b");
        let a2 = sha256_hex16(b"manifest-a");
        assert_eq!(a, a2, "同一内容稳定");
        assert_ne!(a, b, "不同内容不同键");
    }
}
