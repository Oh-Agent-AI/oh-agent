//! 监听根拓扑投影（RUNTIME_REFACTOR_WATCHER_HOTPLUG_HARDENING_SPEC §5.2-§5.3，
//! Phase B）。`runtime::sources` 拥有「该监听哪些目录」的**唯一**答案：
//! 与 ingest 同一份配置派生（内置根 + 已批准自定义源 + skills 缓存根），
//! desktop 不再自建清单（消灭 desktop lib.rs 里第三份根知识副本的漂移面）。
//!
//! **失败关闭（fail-closed）根策略**（spec §4 不变量 5）：描述符被拒只损失
//! 「秒级加速」，不损失正确性——周期 tick/手动同步照常发现该源（watcher
//! 从来只是加速器）。被拒原因走闭集 [`RootRejection`]，无路径无原始错误串
//! （serving-face 纪律）。
//!
//! 词表解释（评审裁定的实施口径）：
//! - **BuiltIn / CacheOnly**：必须位于 `user_home` 之下（词法 + 规范化双检，
//!   符号链接逃逸拒绝）——内置根全在 home 下，这是它们的全集。
//! - **CustomApproved**：用户在设置里**亲手输入**的绝对路径——允许 home 外
//!   （外置卷/归档挂载是合法用例），但仍拒绝 `/`、home 根本身与 `..` 穿越。
//!   spec 非目标禁的是「**导入 profile** 递归监听任意路径」，不是用户显式
//!   添加的自定义源。
//! - **Configured**：内置执行环境的明确运行时根配置（当前仅 `DSH_HOME`）。它同样
//!   允许 home 外，但只能由已知内置执行环境产生，且受与 CustomApproved 相同的范围
//!   限制；不能借此让 profile 导入任意根。
//! - **PluginApproved**：**暂缓**——仓库没有签名插件基建（HARNESS_MANIFEST_DSL
//!   无签名面），spec §5.3 的 provenance 行在签名系统落地前不开放 plugin
//!   origin（评审修正，见 HARDENING spec 修订注记）。
//!
//! 本模块不 import `ingest::watch`（消费方向单向：watch 侧读描述符），
//! 不做任何 I/O 之外的副作用；`custom_source_roots` 的读失败上抛 Err，
//! 调用方（desktop）按「只用内置根 + 记日志」降级——不静默装死。

use std::path::{Path, PathBuf};

use crate::custom_sources::custom_source_roots;


/// 一个监听根的声明。`path` 只在 runtime 进程内存在，永不进 UI/MCP DTO
/// （spec §4 不变量 6）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchRootDescriptor {
    /// 执行环境标签（内置 slug 或自定义源 harness）。
    pub harness: String,
    /// 根的类别：事实面（可唤醒 sync）或缓存面（只失效缓存）。
    pub class: WatchRootClass,
    /// 根的来历——内置 / 用户批准的自定义源。
    pub origin: WatchRootOrigin,
    pub path: PathBuf,
    /// 当前全部根都是递归监听；保留字段以显式声明意图。
    pub recursive: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchRootClass {
    /// 事实源目录：事件 → 去抖 → 唤醒 sync tick（不解析、不写库）。
    FactsSource,
    /// 缓存面目录（如 skills 安装根）：事件 → 失效进程内缓存，**不能**触发
    /// facts sync（spec §5.2）。
    CacheOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchRootOrigin {
    BuiltIn,
    CustomApproved,
    Configured,
}

/// 根被拒的闭集原因（无路径、无原生错误串）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RootRejection {
    NotAbsolute,
    FilesystemRoot,
    HomeRoot,
    ParentTraversal,
    /// BuiltIn/CacheOnly 的规范化路径逃出了 user_home（符号链接逃逸）。
    CanonicalEscape,
    /// 事实源执行环境不在 ingest 支持集（含自定义源合法执行环境集）。
    UnsupportedHarness,
}

impl RootRejection {
    /// 稳定的机器可判码（喂 Phase D 健康 DTO 的 `topology_rejected`）。
    pub fn code(&self) -> &'static str {
        match self {
            RootRejection::NotAbsolute => "not_absolute",
            RootRejection::FilesystemRoot => "filesystem_root",
            RootRejection::HomeRoot => "home_root",
            RootRejection::ParentTraversal => "parent_traversal",
            RootRejection::CanonicalEscape => "canonical_escape",
            RootRejection::UnsupportedHarness => "unsupported_harness",
        }
    }
}

/// 拓扑快照：通过的描述符 + 被拒项（`(harness, path)` 对 + 原因码）。
/// 快照不可变（spec §5.4「each descriptor snapshot is immutable after
/// submission」）；热插拔 = 换一份新快照。
#[derive(Clone, Debug, Default)]
pub struct WatchTopology {
    pub descriptors: Vec<WatchRootDescriptor>,
    pub rejected: Vec<(String, PathBuf, RootRejection)>,
}

impl WatchTopology {
    pub fn facts_sources(&self) -> impl Iterator<Item = &WatchRootDescriptor> {
        self.descriptors
            .iter()
            .filter(|d| d.class == WatchRootClass::FactsSource)
    }

    pub fn cache_only(&self) -> impl Iterator<Item = &WatchRootDescriptor> {
        self.descriptors
            .iter()
            .filter(|d| d.class == WatchRootClass::CacheOnly)
    }
}

/// 自定义源允许的事实执行环境（与 `custom_sources::valid_harness` 同一集合——
/// sync 侧批处理只认这三个，watcher 不得超前）。
const CUSTOM_FACTS_HARNESSES: [&str; 3] = ["claude-code", "codex", "dsh"];

fn is_ingest_harness(harness: &str) -> bool {
    crate::source_controls::supported_harnesses().contains(&harness)
}

/// 单描述符策略校验（spec §5.3 表的词法/规范化两行 + 执行环境行）。
/// 纯函数：只看路径形状与 home，不碰配置。
pub fn validate_descriptor(
    descriptor: &WatchRootDescriptor,
    user_home: &Path,
) -> Result<(), RootRejection> {
    let path = &descriptor.path;
    if !path.is_absolute() {
        return Err(RootRejection::NotAbsolute);
    }
    if path == Path::new("/") {
        return Err(RootRejection::FilesystemRoot);
    }
    if path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(RootRejection::ParentTraversal);
    }
    // home 根本身：任何 origin 都拒绝（监听整个 home = 监听一切）。
    if path == user_home {
        return Err(RootRejection::HomeRoot);
    }
    match descriptor.class {
        WatchRootClass::FactsSource => {
            let known = match descriptor.origin {
                WatchRootOrigin::BuiltIn => is_ingest_harness(&descriptor.harness),
                WatchRootOrigin::CustomApproved | WatchRootOrigin::Configured => {
                    CUSTOM_FACTS_HARNESSES.contains(&descriptor.harness.as_str())
                }
            };
            if !known {
                return Err(RootRejection::UnsupportedHarness);
            }
        }
        WatchRootClass::CacheOnly => {
            // skills 根的 harness 标签是扫描器词表（如 "claude-code-plugins"），
            // 不做 ingest 执行环境校验——它本来就不进事实面。
        }
    }
    match descriptor.origin {
        WatchRootOrigin::BuiltIn => {
            // 内置根必须词法上在 home 下……
            if !path.starts_with(user_home) {
                return Err(RootRejection::CanonicalEscape);
            }
            // ……且已存在时规范化后仍在（canonical home）下——符号链接逃逸。
            if let (Ok(canonical_root), Ok(canonical_home)) =
                (path.canonicalize(), user_home.canonicalize())
            {
                if !canonical_root.starts_with(&canonical_home) {
                    return Err(RootRejection::CanonicalEscape);
                }
            }
            Ok(())
        }
        WatchRootOrigin::CustomApproved | WatchRootOrigin::Configured => {
            // 用户亲手输入或内置执行环境显式配置的绝对路径：允许 home 外，但已存在时
            // 规范化不得落到 `/` 或 canonical home（整盘/整个 home 的监听没有
            // 产品语义）。
            if let Ok(canonical_root) = path.canonicalize() {
                if canonical_root == std::path::Path::new("/") {
                    return Err(RootRejection::FilesystemRoot);
                }
                if let Ok(canonical_home) = user_home.canonicalize() {
                    if canonical_root == canonical_home {
                        return Err(RootRejection::HomeRoot);
                    }
                }
            }
            Ok(())
        }
    }
}

/// 从 ingest 的同一份配置派生监听拓扑（spec Phase B.1）：
/// - 内置事实根：`default_source_watch_roots`（与 sync_facts 发现根同源）；
/// - 已批准自定义源：`custom_source_roots`（读取即校验，失败上抛）；
/// - skills 缓存根：`default_skill_watch_roots`（CacheOnly）；
/// - source-controls 排除的执行环境即时移除（spec §5.3「user control」行）。
pub fn watch_topology(data_home: &Path, user_home: &Path) -> Result<WatchTopology, String> {
    let mut topology = WatchTopology::default();

    for (harness, path) in default_source_watch_roots(user_home) {
        // `DSH_HOME` 是 DSH 的显式运行时配置，不能错误套用「内置根均在
        // user_home 内」的规则。默认 ~/.dsh 仍是 BuiltIn；只有偏离默认值的
        // 已知 DSH 根才取得 Configured provenance。
        let origin = if harness == "dsh" && path != user_home.join(".dsh") {
            WatchRootOrigin::Configured
        } else {
            WatchRootOrigin::BuiltIn
        };
        let descriptor = WatchRootDescriptor {
            harness: harness.to_string(),
            class: WatchRootClass::FactsSource,
            origin,
            path,
            recursive: true,
        };
        match validate_descriptor(&descriptor, user_home) {
            Ok(()) => topology.descriptors.push(descriptor),
            Err(reason) => topology
                .rejected
                .push((descriptor.harness.clone(), descriptor.path.clone(), reason)),
        }
    }
    for (harness, path) in default_skill_watch_roots(user_home) {
        let descriptor = WatchRootDescriptor {
            harness,
            class: WatchRootClass::CacheOnly,
            origin: WatchRootOrigin::BuiltIn,
            path,
            recursive: true,
        };
        match validate_descriptor(&descriptor, user_home) {
            Ok(()) => topology.descriptors.push(descriptor),
            Err(reason) => topology
                .rejected
                .push((descriptor.harness.clone(), descriptor.path.clone(), reason)),
        }
    }

    for source in custom_source_roots(data_home)? {
        let descriptor = WatchRootDescriptor {
            harness: source.harness.clone(),
            class: WatchRootClass::FactsSource,
            origin: WatchRootOrigin::CustomApproved,
            path: PathBuf::from(&source.root),
            recursive: true,
        };
        match validate_descriptor(&descriptor, user_home) {
            Ok(()) => topology.descriptors.push(descriptor),
            Err(reason) => topology
                .rejected
                .push((source.harness, PathBuf::from(source.root), reason)),
        }
    }

    // 排除的执行环境：整执行环境移除（内置 + 自定义一起）。控制面读失败不能退化成
    // 「全部未排除」：那会在启动或热插拔时重新监听用户已经禁止的执行环境。
    // 调用方收到 Err 后保留上一份安全快照（启动时则空注册表 + 周期兜底）。
    let excluded = crate::source_controls::excluded_harnesses(data_home)
        .map_err(|error| format!("source controls failed: {error}"))?;
    topology
        .descriptors
        .retain(|d| !excluded.contains(&d.harness));

    topology.descriptors.sort_by(|a, b| a.path.cmp(&b.path));
    topology.descriptors.dedup_by(|a, b| a.path == b.path && a.class == b.class);
    Ok(topology)
}

/// skills 安装根（`scanner::DEFAULT_ROOTS` 里 home 相对的那部分）→
/// watch-only 注册用。`./` 开头的项目本地根**不监听**：桌面 app 的
/// cwd 无产品语义，监听它会做出随启动目录变化的怪行为。
pub fn default_skill_watch_roots(user_home: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for (harness, root) in crate::skills::scanner::DEFAULT_ROOTS.iter() {
        let Some(rel) = root.strip_prefix("~/") else {
            continue; // "./…" 项目本地根跳过
        };
        out.push((harness.to_string(), user_home.join(rel)));
    }
    out.sort();
    out.dedup();
    out
}

/// 四执行环境事实面的监听根——**与 `sync_facts` 的发现根同一来源**
/// （ingest/sync_service.rs 的 batches 枚举；W3 从 ingest/watch.rs 挪来）：watcher 只是那趟 walk 的
/// 「早点跑」触发器，不是第二个真相源。根不存在也返回（注册进 pending，
/// watcher 超时循环补挂）。
pub fn default_source_watch_roots(user_home: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut roots: Vec<(&'static str, PathBuf)> = vec![
        ("claude-code", user_home.join(".claude").join("projects")),
        // Phase B 修正（拓扑 parity 测试抓到）：此前误用 codex_home() 的返回值
        // ——它是 home 根本身（~），等于递归监听整个 home。真实发现根是
        // ~/.codex 下的 sessions + archived_sessions（codex_rollout_files）。
        ("codex", user_home.join(".codex")),
        (
            "workbuddy",
            agent_vitals_harnesses::workbuddy_session::workbuddy_root(user_home),
        ),
    ];
    if let Some(dsh) = crate::home::dsh_home() {
        roots.push(("dsh", dsh));
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custom_sources::add_custom_source_root;

    fn home() -> PathBuf {
        if cfg!(test) {
            std::env::temp_dir().join(format!(
                "avd-topo-home-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
        } else {
            unreachable!()
        }
    }

    fn data_home_with() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "avd-topo-data-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("state")).unwrap();
        dir
    }

    fn descriptor(path: &str) -> WatchRootDescriptor {
        WatchRootDescriptor {
            harness: "claude-code".into(),
            class: WatchRootClass::FactsSource,
            origin: WatchRootOrigin::BuiltIn,
            path: PathBuf::from(path),
            recursive: true,
        }
    }

    /// Phase B 出口判据（spec §6）：启动快照产生与现实现一致的内置根。
    /// 期望值**独立硬编码**（不调用 default_* 函数），钉住漂移。
    #[test]
    fn startup_topology_matches_legacy_builtin_roots() {
        let user_home = home();
        let data_home = data_home_with();
        let topology = watch_topology(&data_home, &user_home).unwrap();

        let facts: Vec<(&str, &Path)> = topology
            .facts_sources()
            .map(|d| (d.harness.as_str(), d.path.as_path()))
            .collect();
        // claude/codex/workbuddy 总在；dsh 视环境而定（dsh_home 可能 None）。
        assert!(facts
            .iter()
            .any(|(h, p)| *h == "claude-code" && p.ends_with(".claude/projects")));
        assert!(facts.iter().any(|(h, p)| *h == "codex" && p.to_string_lossy().contains(".codex")));
        assert!(facts
            .iter()
            .any(|(h, p)| *h == "workbuddy" && p.to_string_lossy().contains(".workbuddy")));

        // skills 缓存根：CacheOnly、全在 home 下、数量与 DEFAULT_ROOTS 的
        // home 相对项一致。
        let skills: Vec<&WatchRootDescriptor> = topology.cache_only().collect();
        assert!(!skills.is_empty());
        assert!(skills
            .iter()
            .all(|d| d.class == WatchRootClass::CacheOnly && d.path.starts_with(&user_home)));

        // 干净配置零拒绝；DSH_HOME 若显式改到 home 外，使用受限的 Configured
        // provenance，而不是被误当内置根静默丢弃。
        assert!(topology.rejected.is_empty());
        let _ = std::fs::remove_dir_all(data_home);
    }

    /// 策略矩阵（spec §6「security」行）：根/home 根/穿越/非绝对/未知执行环境。
    #[test]
    fn policy_rejects_closed_reason_set() {
        let user_home = PathBuf::from("/home/u");
        for (path, expected) in [
            ("/", RootRejection::FilesystemRoot),
            ("/home/u", RootRejection::HomeRoot),
            ("/home/u/projects/../../etc", RootRejection::ParentTraversal),
            ("relative/path", RootRejection::NotAbsolute),
        ] {
            let got = validate_descriptor(&descriptor(path), &user_home).unwrap_err();
            assert_eq!(got, expected, "{path}");
        }
        // 内置根词法上不在 home 下 → 拒绝。
        assert_eq!(
            validate_descriptor(&descriptor("/opt/data"), &user_home).unwrap_err(),
            RootRejection::CanonicalEscape,
        );
        // 内置执行环境词表外 → 拒绝。
        let mut alien = descriptor("/home/u/x");
        alien.harness = "not-a-harness".into();
        assert_eq!(
            validate_descriptor(&alien, &user_home).unwrap_err(),
            RootRejection::UnsupportedHarness,
        );
        // 自定义源执行环境超出 {claude-code,codex,dsh} → 拒绝（workbuddy 对自定义
        // 源不开放——sync 批处理不认它）。
        let mut custom = descriptor("/mnt/archive");
        custom.origin = WatchRootOrigin::CustomApproved;
        custom.harness = "workbuddy".into();
        assert_eq!(
            validate_descriptor(&custom, &user_home).unwrap_err(),
            RootRejection::UnsupportedHarness,
        );
        // 同一路径作为 CustomApproved 且执行环境合法 → 通过（home 外合法）。
        let mut custom_ok = descriptor("/mnt/archive");
        custom_ok.origin = WatchRootOrigin::CustomApproved;
        assert!(validate_descriptor(&custom_ok, &user_home).is_ok());

        // DSH_HOME 这类已知执行环境的显式配置可在 home 外，但仍复用相同的
        // 宽根拒绝策略；它不是给未知 harness 打开的旁路。
        let mut configured = descriptor("/mnt/dsh-state");
        configured.origin = WatchRootOrigin::Configured;
        configured.harness = "dsh".into();
        assert!(validate_descriptor(&configured, &user_home).is_ok());
        configured.harness = "not-a-harness".into();
        assert_eq!(
            validate_descriptor(&configured, &user_home).unwrap_err(),
            RootRejection::UnsupportedHarness,
        );
    }

    /// 符号链接逃逸：BuiltIn 根指向 home 外的真实目录 → CanonicalEscape。
    #[test]
    fn builtin_symlink_escape_is_rejected() {
        let outside = std::env::temp_dir().join(format!(
            "avd-topo-out-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        let user_home = std::env::temp_dir().join(format!(
            "avd-topo-sym-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&user_home).unwrap();
        let link = user_home.join("projects-link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let d = WatchRootDescriptor {
            harness: "claude-code".into(),
            class: WatchRootClass::FactsSource,
            origin: WatchRootOrigin::BuiltIn,
            path: link,
            recursive: true,
        };
        assert_eq!(
            validate_descriptor(&d, &user_home).unwrap_err(),
            RootRejection::CanonicalEscape,
        );
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&user_home);
    }

    /// 自定义源生命周期入拓扑：添加 → 描述符出现；排除执行环境 → 即时移除
    /// （spec §6「dynamic lifecycle」行的 Phase B 子集）。
    #[test]
    fn custom_sources_enter_topology_and_exclusion_removes_them() {
        let data_home = data_home_with();
        let user_home = home();
        std::fs::create_dir_all(&user_home).unwrap();
        let custom_root = user_home.join("archived-sessions");
        std::fs::create_dir_all(&custom_root).unwrap();

        add_custom_source_root(&data_home, "claude-code", &custom_root)
            .unwrap();
        let topology = watch_topology(&data_home, &user_home).unwrap();
        assert!(
            topology
                .facts_sources()
                .any(|d| d.origin == WatchRootOrigin::CustomApproved && d.path == custom_root),
            "自定义源必须进拓扑: {:?}",
            topology.descriptors,
        );

        crate::source_controls::set_harness_excluded(&data_home, "claude-code", true).unwrap();
        let topology = watch_topology(&data_home, &user_home).unwrap();
        assert!(
            !topology.descriptors.iter().any(|d| d.harness == "claude-code"),
            "排除的执行环境不得留任何监听描述符",
        );
        let _ = std::fs::remove_dir_all(data_home);
        let _ = std::fs::remove_dir_all(user_home);
    }

    /// 排除控制文件不可读/损坏不能按「无排除」继续，否则用户已关闭的执行环境会
    /// 在 watcher 重启或热插拔时重新进入监听集合。
    #[test]
    fn invalid_source_controls_fail_topology_closed() {
        let data_home = data_home_with();
        let user_home = home();
        std::fs::create_dir_all(&user_home).unwrap();
        std::fs::write(data_home.join("state/source-controls.json"), "{").unwrap();
        let error = watch_topology(&data_home, &user_home).unwrap_err();
        assert!(error.contains("source controls failed"));
        let _ = std::fs::remove_dir_all(data_home);
        let _ = std::fs::remove_dir_all(user_home);
    }
}
