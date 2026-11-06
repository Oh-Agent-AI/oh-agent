//! 发现与分类：哪些目录是 skill、它属于哪个层级、是否真的进了上下文。
//!
//! 不变量 1（磁盘 ≠ 上下文）、2（插件命名空间）、3（cache/marketplaces 同一份）、
//! 10（覆盖优先级）的实现都在这里。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use agent_vitals_domain::skills::frontmatter::parse_frontmatter;
use agent_vitals_harnesses::harnesses::claude_code::skills::lookup_usage;
use agent_vitals_domain::util::{est_tokens, norm, pyround};

use super::security::security_scan;

fn read_lossy(p: &Path) -> Option<String> {
    let bytes = std::fs::read(p).ok()?;
    Some(agent_vitals_domain::util::bytes_to_lossy_normalized(&bytes))
}

/// 各执行环境的常见 skill 目录。找不到的会被静默跳过。
/// harness 为 "claude-code*" 的才可能进 Claude Code 的上下文。
pub const DEFAULT_ROOTS: [(&str, &str); 18] = [
    // 项目本地根排在 home 根**之前**：两者同属 claude-code 执行环境，
    // scanned_roots 的顺序会进输出，顺序错了 golden 就对不上。
    ("claude-code", "./.claude/skills"),
    ("claude-code", "~/.claude/skills"),
    ("claude-code-plugins", "~/.claude/plugins"),
    ("codex", "~/.codex/skills"),
    ("openclaw", "./skills"),
    ("openclaw", "./.agents/skills"),
    // DSH 的 discovery roots（契约 §DSH，层内 rank 越小越优先）。~/.agents/skills
    // 与 OpenClaw 共享，但两边按各自的 rank 归类，绝不跨执行环境合并判定。
    ("dsh", "./.dsh/skills"),
    ("dsh", "./.agents/skills"),
    ("dsh", "~/.dsh/skills"),
    ("dsh", "~/.agents/skills"),
    ("hermes", "~/.hermes/skills"),
    ("workbuddy", "./.codebuddy/skills"),
    ("workbuddy", "./.workbuddy/skills"),
    ("workbuddy", "~/.workbuddy/skills"),
    ("cc-switch", "~/.cc-switch/skills"),
    ("cursor", "~/.cursor/skills"),
    ("gemini-cli", "~/.gemini/skills"),
    ("opencode", "~/.opencode/skills"),
];

const DOC_DIRS: [&str; 5] = ["references", "reference", "refs", "docs", "doc"];
const REPO_META: [&str; 9] = [
    "readme.md",
    "license.md",
    "license",
    "changelog.md",
    "contributing.md",
    "code_of_conduct.md",
    "security.md",
    "notice.md",
    "authors.md",
];
const PLUGIN_WRAPPER_DIRS: [&str; 4] = ["plugins", "external_plugins", "unknown", "skills"];

fn plugin_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/plugins/(cache|marketplaces)/([^/]+)/(.+?)/skills/").unwrap())
}

// v0.8 Phase E7.6：SourceMeta 迁进 agent-vitals-harnesses::skill_discovery——
// openclaw/workbuddy 的执行环境适配器也要用它，而它们要迁进库 crate（库不能反过来
// 依赖本二进制），SourceMeta 必须先搬。E7.5 起本文件自己也迁进了库 crate，
// 不再需要 `pub use` 桥给二进制侧——直接 `use`（无消费者在本 crate 外还要经
// scanner 转手拿 SourceMeta）。
use agent_vitals_harnesses::skill_discovery::SourceMeta;

/// 扫描上下文。Python 版把这些放在模块级全局里，这里显式传递。
pub struct Ctx {
    pub home_n: String,
    pub cwd_n: String,
    pub self_root: Option<PathBuf>,
}

/// 把 `~/x` 展开成绝对路径，并复刻 Python `Path("./x")` 会丢掉 `./` 前缀的行为。
///
/// 这一条不是洁癖：`classify()` 用 `norm(skill_dir).starts_with(".claude/skills")`
/// 判定 project 层，前缀多一个 `./` 就判不出来。
pub fn expand_root(root: &str, home: &str) -> PathBuf {
    if let Some(rest) = root.strip_prefix("~/") {
        return PathBuf::from(home).join(rest);
    }
    if root == "~" {
        return PathBuf::from(home);
    }
    PathBuf::from(root.strip_prefix("./").unwrap_or(root))
}

/// 目录下的全部**文件**，按 norm() 字符串排序。
///
/// 排序不是可选项。`walkdir` 不保证顺序（Python 的 `rglob` 同样不保证，
/// 且两者的顺序互不一致），而遍历顺序会一路传导到输出 —— 最要命的是
/// `--redact-names` 的别名编号按名字出现顺序分配。
/// 按 norm() 的字符串排序而不是按路径组件排序：后者对 "a/b" 与 "a-c" 的
/// 先后判断与字符串比较相反，跨语言对不上。
pub fn sorted_files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect();
    out.sort_by_key(|p| norm(p));
    out
}

/// 从插件路径里提取 (插件名, marketplace)。不是插件路径则返回 None。
///
/// 覆盖的三种实际形态：
///   .../plugins/cache/<mkt>/<plugin>/unknown/skills/<skill>
///   .../plugins/marketplaces/<mkt>/plugins/<plugin>/skills/<skill>
///   .../plugins/marketplaces/<mkt>/external_plugins/<plugin>/skills/<skill>
/// Python 侧的 `^v?\d+(?:\.\d+)*$`。手写而不上正则：这条判断在每个插件
/// 路径上都跑，形状又固定，多一个正则不如少一个。
fn is_version_segment(s: &str) -> bool {
    let body = s.strip_prefix('v').unwrap_or(s);
    if body.is_empty() {
        return false;
    }
    let mut group_len = 0usize;
    for c in body.chars() {
        if c.is_ascii_digit() {
            group_len += 1;
        } else if c == '.' {
            if group_len == 0 {
                return false; // 空段：`1..0` / 以 `.` 开头
            }
            group_len = 0;
        } else {
            return false;
        }
    }
    group_len > 0 // 不允许以 `.` 结尾
}

pub fn plugin_identity(path_n: &str) -> Option<(String, String)> {
    let with_slash = format!("{}/", path_n);
    let caps = plugin_path_re().captures(&with_slash)?;
    let marketplace = caps.get(2)?.as_str().to_string();
    let mut middle: Vec<&str> = caps
        .get(3)?
        .as_str()
        .split('/')
        .filter(|x| !x.is_empty() && !PLUGIN_WRAPPER_DIRS.contains(x))
        .collect();
    // 版本号不能当命名空间。WorkBuddy 的缓存里 middle 是 `<包>/<版本>`，
    // 取末段会得到 `1.0.0` —— 两个**不同的包**只要版本号相同就落进同一个
    // 命名空间，各自的同名 skill 会被判成冲突（凭空报一个不存在的问题）；
    // 反过来，同一个包升级一次就换一个命名空间，真正的重复反而看不见。
    // Claude Code 在这一格放字面量 `unknown`，已由 PLUGIN_WRAPPER_DIRS 挡掉。
    // 末尾**留一个**：万一整段都像版本号，宁可要个怪名字也不要空的。
    while middle.len() > 1 && is_version_segment(middle[middle.len() - 1]) {
        middle.pop();
    }
    let plugin = middle
        .last()
        .map(|s| s.to_string())
        .unwrap_or_else(|| marketplace.clone());
    Some((plugin, marketplace))
}

pub struct Classification {
    pub level: &'static str,
    pub namespace: Option<String>,
    pub plugin_key: Option<String>,
}

/// 返回层级、命名空间与插件键。
///
/// 命名空间用于去重：插件里的 skill 按 `<plugin>:<name>` 隔离，
/// 所以 discord 和 telegram 各有一个 `access` 并不是冲突（不变量 2）。
pub fn classify(skill_dir: &Path, harness: &str, ctx: &Ctx) -> Classification {
    let resolved = skill_dir
        .canonicalize()
        .unwrap_or_else(|_| skill_dir.to_path_buf());
    let s = norm(&resolved);

    if let Some((plugin, marketplace)) = plugin_identity(&s) {
        let key = format!("{}@{}", plugin, marketplace);
        return Classification {
            level: "plugin",
            namespace: Some(plugin),
            plugin_key: Some(key),
        };
    }
    let plain = |level| Classification {
        level,
        namespace: None,
        plugin_key: None,
    };
    let under = |base: &str| s.starts_with(&format!("{}{}", base, ""));

    // 层级词汇**按执行环境而异**。同一个 personal 在 Claude Code 与 OpenClaw
    // 里指的不是同一个目录，覆盖优先级也不同（见 main.rs 的 level_rank_for）。
    if harness == "openclaw" {
        if s.contains("/workspace/skills") {
            return plain("workspace");
        }
        if s.contains("/plugin-skills/") {
            return plain("plugin");
        }
        if under(&format!("{}/skills", ctx.cwd_n)) {
            return plain("workspace");
        }
        if under(&format!("{}/.agents/skills", ctx.cwd_n)) {
            return plain("project");
        }
        if under(&format!("{}/.agents/skills", ctx.home_n)) {
            return plain("personal");
        }
        if under(&format!("{}/.openclaw/skills", ctx.home_n)) {
            return plain("managed");
        }
    }
    if harness == "hermes" {
        return if under(&format!("{}/.hermes/skills", ctx.home_n)) {
            plain("personal")
        } else {
            plain("external")
        };
    }
    // Codex 只有一个用户级根，不区分层级。
    if harness == "codex" {
        return plain("personal");
    }
    if harness == "workbuddy" {
        if under(&format!("{}/.codebuddy/skills", ctx.cwd_n))
            || under(&format!("{}/.workbuddy/skills", ctx.cwd_n))
        {
            return plain("project");
        }
        if under(&format!("{}/.workbuddy/skills", ctx.home_n)) {
            return plain("personal");
        }
        if s.contains("/.workbuddy/plugins/marketplaces/workbuddy-builtin/") {
            return plain("managed");
        }
        return plain("unknown");
    }
    if harness == "dsh" {
        // DSH 的 level 只表示「落在哪条 discovery root」（rank 见 main.rs 的 dsh_rank）。
        // 这里只回答文件系统层；scope 层由 conflict_domain 第三段（A5）表达。
        // ~/.agents/skills 与 OpenClaw 共享，但 DSH 侧按 user-agents 归类，
        // 不能复用 OpenClaw 的 personal。
        if under(&format!("{}/.dsh/skills", ctx.home_n)) {
            return plain("user-dsh");
        }
        if under(&format!("{}/.agents/skills", ctx.home_n)) {
            return plain("user-agents");
        }
        if under(&format!("{}/.dsh/skills", ctx.cwd_n))
            || norm(skill_dir).starts_with(".dsh/skills")
        {
            return plain("project-dsh");
        }
        if under(&format!("{}/.agents/skills", ctx.cwd_n))
            || norm(skill_dir).starts_with(".agents/skills")
        {
            return plain("project-agents");
        }
        return plain("custom");
    }
    if s.contains("/managed") || s.contains("/etc/") || s.contains("enterprise") {
        return plain("enterprise");
    }
    if under(&format!("{}/.claude/skills", ctx.home_n)) {
        return plain("personal");
    }
    if under(&format!("{}/.claude/skills", ctx.cwd_n))
        || norm(skill_dir).starts_with(".claude/skills")
    {
        return plain("project");
    }
    plain("unknown")
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(unix)]
fn ctime_of(p: &Path) -> Option<f64> {
    use std::os::unix::fs::MetadataExt;
    // 移植清单第 3 条：不能用 Metadata::created() —— 那取的是 birthtime，
    // 与 Python 的 st_ctime（inode 变更时间）语义不同，老内核 ext4 上还会 Err。
    // installed_days_ago 变了，僵尸 / too-new 的分类就跟着变（不变量 9）。
    std::fs::metadata(p).ok().map(|m| m.ctime() as f64)
}

#[cfg(not(unix))]
fn ctime_of(p: &Path) -> Option<f64> {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
}

fn mtime_of(p: &Path) -> Option<f64> {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
}

/// 扫描一个 skill 目录。读不到 SKILL.md 时返回 None（由调用方记进 unreadable）。
// 参数比 clippy 的 7 个阈值多一个：Python 侧同一函数的参数还要更多
// （home_n/cwd_n/now 各自独立），Rust 把它们收进 ctx，只把 DSH 证据单列。
#[allow(clippy::too_many_arguments)]
pub fn scan_skill_dir(
    skill_dir: &Path,
    harness: &str,
    enabled_plugins: Option<&HashSet<String>>,
    usage: &Map<String, Value>,
    plugins_known: bool,
    ctx: &Ctx,
    meta: &SourceMeta,
    dsh_evidence: Option<&Value>,
    dsh_snapshot: Option<&Value>,
) -> Option<Value> {
    let md = skill_dir.join("SKILL.md");
    if !md.is_file() {
        return None;
    }
    let raw = read_lossy(&md)?;

    let fm = parse_frontmatter(&raw);
    let cls = classify(skill_dir, harness, ctx);

    // 是否被所属执行环境发现。Claude 插件是唯一能由本机配置精确判定启用状态的来源。
    let (mut loaded, why): (bool, String) = if matches!(
        harness,
        "codex" | "openclaw" | "hermes" | "workbuddy" | "custom"
    ) {
        // 显式根下的 skill 一律算被该执行环境发现；这些执行环境没有等价于
        // enabledPlugins 的本机配置可查。
        let why = if cls.level == "unknown" {
            "explicit-root".to_string()
        } else {
            cls.level.to_string()
        };
        if harness == "openclaw" {
            // OpenClaw **可发现 != 已加载**。openclaw.json 只能证明「被显式
            // 关掉」；「没被关掉」不等于「进了上下文」，那只有运行时目录能证实。
            // 三种理由必须分开写 —— 把「没证实」当「已加载」就是编造证据。
            (false, String::new()) // 真实取值在下面按 skill 名查表后决定
        } else if harness == "workbuddy"
            && norm(skill_dir).contains("/plugins/marketplaces/workbuddy-builtin/")
        {
            (true, "workbuddy-builtin-marketplace-manifest".to_string())
        } else {
            (true, why)
        }
    } else {
        match cls.level {
        "personal" | "project" | "enterprise" if harness == "claude-code" => {
            (true, cls.level.to_string())
        }
        "plugin" => {
            if !plugins_known {
                (false, "plugin-state-unknown".into())
            } else {
                let set = enabled_plugins;
                let hit = |k: &Option<String>| {
                    k.as_ref()
                        .is_some_and(|v| set.is_some_and(|s| s.contains(v)))
                };
                if hit(&cls.plugin_key) || hit(&cls.namespace) {
                    (true, "plugin-enabled".into())
                } else {
                    (false, "plugin-not-enabled".into())
                }
            }
        }
        _ => (false, "unknown-location".into()),
        }
    };

    // 附带资源。渐进式披露把正文拆到 references/ 之后，那部分成本仍然真实存在。
    // 但要区分两类附带 .md：
    //   参考文档 —— references/ 等约定目录，或与 SKILL.md 同级，计入 tier2
    //   数据语料 —— 文章库、素材，只记字节**不计 tier2**（不变量 8）
    let mut bundled_files = 0usize;
    let mut bundled_bytes: u64 = 0;
    let mut refs_tokens: i64 = 0;
    let mut refs_files = 0usize;
    let mut corpus_files = 0usize;
    let mut corpus_bytes: u64 = 0;

    for p in sorted_files(skill_dir) {
        if p.file_name().and_then(|s| s.to_str()) == Some("SKILL.md") {
            continue;
        }
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        bundled_bytes += size;
        bundled_files += 1;

        let rel = match p.strip_prefix(skill_dir) {
            Ok(r) => norm(r),
            Err(_) => norm(&p),
        };
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if ext != "md" && ext != "markdown" {
            continue;
        }
        let parts: Vec<&str> = rel.split('/').collect();
        let fname = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        // README / LICENSE 等给人看的文件，不算 Agent 的载入成本（不变量 7）
        if parts.len() == 1 && REPO_META.contains(&fname.as_str()) {
            continue;
        }
        let is_doc = parts.len() == 1 || DOC_DIRS.contains(&parts[0].to_lowercase().as_str());
        if is_doc {
            if let Some(text) = read_lossy(&p) {
                refs_tokens += est_tokens(&text);
                refs_files += 1;
            }
        } else {
            corpus_files += 1;
            corpus_bytes += size;
        }
    }

    let dir_name = skill_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let name = fm
        .get("name")
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| dir_name.clone());
    // OpenClaw 的三态：显式关闭 / 显式开启但未经运行时证实 / 仅可发现。
    // 必须分开，因为它们对用户的含义完全不同。
    let mut enabled_state = Value::Null;
    // **loaded_state 与 enabled_state 不是同一件事。**
    // enabled_state 说「配置里开没开」，loaded_state 说「这一轮到底在不在
    // 上下文里」。只有**明确不在**时才是 false，其余一律 null（未知）——
    // 曾经这里硬编码 null，把「明确不在」也报成了「不知道」。
    let mut loaded_state = Value::Null;
    // DSH 的运行时证据字段（稀疏，与 openclaw 的 eligible 记录同一约定）：只有
    // catalog-visible 时置值，其余执行环境/其余 dsh 状态都不带这两个键。
    let mut dsh_catalog_visible = false;
    // DSH 的证据源（契约「Evidence recency」）：probe（快照，此刻）vs log（会话
    // 日志，当时）vs none（只有文件系统推断）。只有 dsh 才写进记录；其余执行环境不带
    // 这个键。
    let mut evidence_recency = "none";
    let why = if harness == "openclaw" {
        match meta.skill_entries.get(&name) {
            Some(Value::Object(e)) if e.get("enabled") == Some(&json!(false)) => {
                enabled_state = json!(false);
                loaded_state = json!(false); // 配置里明确关掉 = 明确不在
                "openclaw-config-disabled".to_string()
            }
            Some(Value::Object(e)) if e.get("enabled") == Some(&json!(true)) => {
                enabled_state = json!(true);
                "openclaw-config-enabled-runtime-unverified".to_string()
            }
            _ => "openclaw-discoverable-runtime-unverified".to_string(),
        }
    } else if harness == "workbuddy" && meta.workbuddy_package.is_some() {
        // WorkBuddy 按 welcomeMode 过滤注入。模式未知时**不过滤** ——
        // 宁可多报一个「可能在」，也不要因为读不到日志就把 skill 抹掉。
        let mode = meta.workbuddy_welcome_mode.as_deref();
        if !agent_vitals_harnesses::harnesses::workbuddy::sources::skills::skill_active(meta.workbuddy_legacy_name.as_deref(), mode) {
            enabled_state = json!(false);
            loaded_state = json!(false); // 模式过滤掉 = 明确不在
            loaded = false;
            format!("workbuddy-mode-filtered:{}", mode.unwrap_or(""))
        } else {
            match mode {
                Some(m) => {
                    enabled_state = json!(true);
                    format!("workbuddy-builtin-active-mode:{}", m)
                }
                None => "workbuddy-builtin-mode-unknown".to_string(),
            }
        }
    } else if harness == "dsh" {
        // DSH 的 loaded 有两个独立证据源：快照（probe，A11）与会话日志（log，A4）。
        // probe 更新鲜（`evidence_recency` 为此区分时间坐标），所以快照存在且未降级
        // 时优先；快照缺失/畸形才退回 log。快照 `complete==false` 时**整轮不发布
        // 目录**，那对模型就是「全部不可见」，所以是 unknown（不是 false）。
        // 进了名单只证明**紧凑元数据进了目录**，不证明正文被读过（契约「Precision
        // of loaded」），所以 body_loaded_state 恒为 null、runtime_status 只到
        // catalog-visible。读不到任何证据只能停在「磁盘可发现」，绝不能把
        // 「没读到」当「没加载」（不变量 12）。
        let snapshot = dsh_snapshot.filter(|s| {
            s.get("degraded").and_then(|d| d.as_str()).is_none()
        });
        if let Some(snap) = snapshot {
            evidence_recency = "probe";
            let names: Vec<String> = snap.get("catalog_entries")
                .and_then(|e| e.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            if snap.get("complete") == Some(&json!(true)) {
                if names.iter().any(|n| n == &name) {
                    loaded = true;
                    dsh_catalog_visible = true;
                    "dsh-catalog-visible".to_string()
                } else {
                    loaded = false;
                    "dsh-not-in-catalog".to_string()
                }
            } else {
                loaded = false;
                "dsh-discovery-incomplete".to_string()
            }
        } else {
            let catalog = match dsh_evidence {
                Some(ev) if ev.get("degraded").and_then(|d| d.as_str()).is_none() => {
                    ev.get("catalog_entries")
                        .and_then(|e| e.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect::<Vec<String>>()
                        })
                }
                _ => None,
            };
            match catalog {
                None => {
                    loaded = false;
                    "dsh-discoverable-runtime-unverified".to_string()
                }
                Some(names) if names.iter().any(|n| n == &name) => {
                    evidence_recency = "log";
                    loaded = true;
                    dsh_catalog_visible = true;
                    "dsh-catalog-visible".to_string()
                }
                Some(_) => {
                    evidence_recency = "log";
                    loaded = false;
                    "dsh-not-in-catalog".to_string()
                }
            }
        }
    } else {
        why
    };

    let (hits, last_ms, matched_key) = lookup_usage(usage, &name, cls.namespace.as_deref());
    // DSH 的触发证据不读 claude.json 的 skillUsage——那是另一个执行环境（Claude Code）
    // 的使用历史，与 DSH 的会话日志是两套账。日志里的 invoked（用户显式 `/<name>`）
    // 与 selected（模型自主 tool/call 选中）才是本执行环境的真实触发数。两者都算
    // 「用过」：僵尸判定问的是「这个 skill 有没有产生过价值」，模型自主选中同样
    // 说明它在起作用——skills::analysis::trigger_dsh 的 never_triggered 正是
    // never_selected ∩ never_invoked，两侧的计数语义必须一致。
    //
    // invoked/selected 只是名字列表、没有时间戳，所以 last_used_days_ago 保持
    // None（「有触发数但不知新鲜度」由 lifecycle 的 occasional 表达，绝不伪造
    // 最近使用时间）；usage_key_matched 同理为 None。
    let (hits, last_ms, matched_key) = if harness == "dsh"
        && dsh_evidence.is_some_and(|ev| ev.get("degraded").and_then(|d| d.as_str()).is_none())
    {
        let count_trigger = |key: &str| {
            dsh_evidence
                .and_then(|ev| ev.get(key))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter(|x| x.as_str() == Some(name.as_str()))
                        .count()
                })
                .unwrap_or(0)
        };
        (
            count_trigger("invoked") as i64 + count_trigger("selected") as i64,
            None,
            None,
        )
    } else {
        (hits, last_ms, matched_key)
    };

    // 装了多久。判定僵尸前必须看这个：装了一天的 skill 零触发说明不了任何事。
    let born = match (ctime_of(skill_dir), ctime_of(&md)) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => mtime_of(&md).unwrap_or(0.0),
    };
    let age_days = pyround((now_secs() - born) / 86400.0, 1);

    let desc = fm.get("description").unwrap_or("").to_string();
    let body_tokens = est_tokens(&fm.body);
    let body_lines = if fm.body.is_empty() {
        0
    } else {
        fm.body.matches('\n').count() + 1
    };

    let mut hash = Sha256::new();
    hash.update(raw.as_bytes());
    let content_hash: String = format!("{:x}", hash.finalize()).chars().take(12).collect();

    let mut rec = Map::new();
    let harness_family = if harness.starts_with("claude-code") { "claude-code" } else { harness };
    rec.insert("name".into(), json!(name));
    rec.insert("dir_name".into(), json!(dir_name));
    rec.insert("harness".into(), json!(harness));
    rec.insert("harness_family".into(), json!(harness_family));
    rec.insert("level".into(), json!(cls.level));
    rec.insert("namespace".into(), json!(cls.namespace));
    rec.insert("plugin_key".into(), json!(cls.plugin_key));
    rec.insert("loaded".into(), json!(loaded));
    rec.insert("loaded_reason".into(), json!(why));
    rec.insert("installed".into(), json!(true));
    // OpenClaw 的 skill 一律算「可发现」——它没有本机配置能判定是否真的加载，
    // 这个区分正是 discoverable 与 loaded 分成两个字段的原因。
    rec.insert(
        "discoverable".into(),
        json!(if harness == "openclaw" { true } else { loaded }),
    );
    // 三个尚无证据来源的字段。**必须是 null 而不是 false** ——
    // 「判定不了」与「判定为否」在报告里含义完全不同（不变量 12）。
    rec.insert("enabled_state".into(), enabled_state);
    rec.insert("loaded_state".into(), loaded_state);
    rec.insert("runtime_verified".into(), json!(false));
    rec.insert("instance_id".into(), SourceMeta::opt(&meta.instance_id));
    rec.insert("instance_root".into(), SourceMeta::opt(&meta.instance_root));
    rec.insert("config_path".into(), SourceMeta::opt(&meta.config_path));
    rec.insert("root_kind".into(), SourceMeta::opt(&meta.root_kind));
    // 同名 skill 只会在同一执行环境内争抢；跨执行环境是独立运行时。
    // OpenClaw 还要再按实例分 —— 两个实例里的同名 skill 不是冲突。
    //
    // DSH 的冲突域带 scope 层（A5：dsh:<DSH_HOME>:<layer>）。<DSH_HOME> 是 DSH
    // 配置根（默认 ~/.dsh），与其他执行环境的 home 一样用 ctx.home_n 做路径归一。
    // 本波只有文件系统根：DSH 的 filesystem provider 只注册在**全局 scope 层**，
    // 所以 <layer> 恒为 "global"（占位）。真正的 preset / agent 层要等运行时证据
    // （后续波 A10），届时改从证据里取层，而不是硬编码 "global"。
    let dsh_home = format!("{}/.dsh", ctx.home_n);
    rec.insert("conflict_domain".into(), if harness == "dsh" {
        json!(format!("dsh:{}:global", dsh_home))
    } else {
        match (harness, &meta.instance_id) {
            ("openclaw", Some(id)) => json!(format!("openclaw:{}", id)),
            _ => json!(harness),
        }
    });
    rec.insert("path".into(), json!(norm(skill_dir)));
    rec.insert("content_hash".into(), json!(content_hash));
    rec.insert("description".into(), json!(desc));
    rec.insert("description_chars".into(), json!(desc.chars().count()));
    // Tier 1：启动时常驻上下文的部分
    rec.insert("tier1_tokens".into(), json!(est_tokens(&fm.raw)));
    // Tier 2：触发后才载入。core 必然载入，refs 按需，max 是全读的最坏情况
    rec.insert("tier2_tokens".into(), json!(body_tokens));
    rec.insert("tier2_core_tokens".into(), json!(body_tokens));
    rec.insert("tier2_refs_tokens".into(), json!(refs_tokens));
    rec.insert("tier2_refs_files".into(), json!(refs_files));
    rec.insert("tier2_max_tokens".into(), json!(body_tokens + refs_tokens));
    rec.insert("body_lines".into(), json!(body_lines));
    rec.insert("bundled_files".into(), json!(bundled_files));
    rec.insert("bundled_bytes".into(), json!(bundled_bytes));
    rec.insert("data_corpus_files".into(), json!(corpus_files));
    rec.insert("data_corpus_bytes".into(), json!(corpus_bytes));
    rec.insert(
        "mtime".into(),
        json!(mtime_of(&md).unwrap_or(0.0) as i64),
    );
    rec.insert("installed_days_ago".into(), json!(age_days));
    rec.insert("usage_count".into(), json!(hits));
    rec.insert(
        "last_used_days_ago".into(),
        match last_ms {
            Some(ms) if ms != 0.0 => json!(pyround((now_secs() - ms / 1000.0) / 86400.0, 1)),
            _ => Value::Null,
        },
    );
    rec.insert("usage_key_matched".into(), json!(matched_key));
    rec.insert(
        "has_name".into(),
        json!(fm.get("name").is_some_and(|s| !s.is_empty())),
    );
    rec.insert("has_description".into(), json!(!desc.is_empty()));
    rec.insert(
        "security".into(),
        security_scan(skill_dir, &raw, ctx.self_root.as_deref()),
    );
    if dsh_catalog_visible {
        // 只有 dsh catalog-visible 才带这两个字段（与 openclaw eligible 的
        // 稀疏约定一致）：runtime_status 说「紧凑元数据可见」，body_loaded_state
        // 恒为 null——进了目录不等于正文被读过。
        rec.insert("runtime_status".into(), json!("catalog-visible"));
        rec.insert("body_loaded_state".into(), Value::Null);
    }
    if harness == "dsh" {
        // 证据源只对 dsh 有意义（其余执行环境单一隐式 scope，契约不要求逐记录标注）。
        // probe（快照）/ log（会话日志）/ none（文件系统推断）必须显式分开，否则
        // 一个月前的 log 证据与当下的 probe 证据并排渲染，报告就开始在时间上撒谎。
        rec.insert("evidence_recency".into(), json!(evidence_recency));
    }
    Some(Value::Object(rec))
}

pub struct Collected {
    pub skills: Vec<Value>,
    pub scanned_roots: Vec<Value>,
    pub unreadable: Vec<Value>,
}

pub fn collect(
    roots: &[(String, String, SourceMeta)],
    enabled_plugins: Option<&HashSet<String>>,
    usage: &Map<String, Value>,
    plugins_known: bool,
    ctx: &Ctx,
    dsh_evidence: Option<&Value>,
    dsh_snapshot: Option<&Value>,
) -> Collected {
    let mut skills = Vec::new();
    let mut scanned_roots = Vec::new();
    let mut unreadable = Vec::new();
    let mut seen: Vec<(String, Option<String>, String)> = Vec::new();

    for (harness, root, meta) in roots {
        let base = expand_root(root, &ctx.home_n);

        // **按 resolve 之后的路径去重。**两个不同写法可以指向同一个目录 ——
        // 从 home 跑时 `./.claude/skills` 与 `~/.claude/skills` 就是同一处。
        // 不去重的后果不止是清点虚高：同一个 skill 被扫两遍，会被去重逻辑
        // 当成「一个 skill 有两份内容相同的副本」，**凭空报出一个不存在的
        // 冲突**。清点不准只是不准，编造一个问题是另一回事。
        //
        // 去重键要带 harness 与 instance_id：同一个物理目录可以合法地属于两个
        // OpenClaw 实例，那种情况不是重复。
        let key = (
            harness.clone(),
            meta.instance_id.clone(),
            norm(&base.canonicalize().unwrap_or_else(|_| base.clone())),
        );
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);

        if !base.is_dir() {
            continue;
        }
        scanned_roots.push(json!({"harness": harness, "path": norm(&base),
                                  "instance_id": SourceMeta::opt(&meta.instance_id),
                                  "root_kind": SourceMeta::opt(&meta.root_kind)}));

        let mut mds: Vec<PathBuf> = if meta.workbuddy_only_direct {
            let direct = base.join("SKILL.md");
            if direct.is_file() { vec![direct] } else { Vec::new() }
        } else {
            WalkDir::new(&base)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .filter(|e| e.file_name() == "SKILL.md")
                .map(|e| e.into_path())
                .collect()
        };
        mds.sort_by_key(|p| norm(p));

        for md in mds {
            let dir = match md.parent() {
                Some(d) => d,
                None => continue,
            };
            match scan_skill_dir(dir, harness, enabled_plugins, usage, plugins_known, ctx, meta,
                                 dsh_evidence, dsh_snapshot) {
                Some(rec) => skills.push(rec),
                None => {
                    // SKILL.md 在那儿却没产出记录 = 读不了。
                    // 不能静默跳过：清点工具丢项就是错误答案（ENGINEERING §4.5）。
                    if md.is_file() {
                        unreadable.push(json!({
                            "name": dir.file_name().and_then(|s| s.to_str()).unwrap_or(""),
                            "path": norm(dir),
                            "harness": harness,
                            "reason": "SKILL.md exists but cannot be read (permission or I/O error)",
                        }));
                    }
                }
            }
        }
    }
    Collected {
        skills,
        scanned_roots,
        unreadable,
    }
}

/// 按 (conflict_domain, layer, namespace, name) 分组，**保持首次出现的顺序**。
///
/// 不变量 2 与 3 都靠这个键：`discord:access` 与 `telegram:access` 不是冲突，
/// 同一插件在 cache/ 与 marketplaces/ 下的两份则是同一个 key。DSH 的覆盖层
/// 单独成一维（A7）：跨层同名是设计，不是冲突。
pub fn group_by_key(scope: &[Value]) -> Vec<(String, Vec<usize>)> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, s) in scope.iter().enumerate() {
        // 同名 skill 只会在同一执行环境内争抢；跨执行环境是独立运行时，不是冲突。
        // DSH 的覆盖层也进键：跨层同名是设计不是冲突，只有同层同名才比 rank。
        let domain = s["conflict_domain"].as_str().unwrap_or("");
        let layer = agent_vitals_domain::skills::ranking::layer_of(s);
        let ns = s["namespace"].as_str().unwrap_or("");
        let name = s["name"].as_str().unwrap_or("");
        let key = format!("{}\u{0}{}\u{0}{}\u{0}{}", domain, layer, ns, name);
        if !map.contains_key(&key) {
            order.push(key.clone());
        }
        map.entry(key).or_default().push(i);
    }
    order
        .into_iter()
        .map(|k| {
            let v = map.remove(&k).unwrap_or_default();
            (k, v)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期望值来自 tests/test_characterization.py::TestPluginIdentity

    /// `is_version_segment` 是手写的 `^v?\d+(?:\.\d+)*$`。
    /// 差分测试够不到这些边界 —— 语料里不会有 `1..0` 这种目录名，
    /// 而手写解析出错恰恰最可能出在这里。
    #[test]
    fn version_segment_matches_the_python_regex() {
        for ok in ["1", "7", "1.0", "1.0.0", "v1", "v20260727", "0.1.1784877812"] {
            assert!(is_version_segment(ok), "应当判定为版本号：{}", ok);
        }
        for no in ["", "v", "beta", "1.0.0-rc1", "1..0", ".1", "1.", "unknown",
                   "v1.0.x", "1a", "①"] {
            assert!(!is_version_segment(no), "不该判定为版本号：{}", no);
        }
    }

    #[test]
    fn version_directory_is_not_the_plugin_name() {
        // WorkBuddy 的缓存形态：版本号占了 Claude Code 放 `unknown` 的那一格
        assert_eq!(
            plugin_identity("/h/.workbuddy/plugins/cache/wb/pkg/1.0.0/skills/s"),
            Some(("pkg".into(), "wb".into()))
        );
        // 整段都像版本号时留一个：宁可要个怪名字也不要空命名空间
        assert_eq!(
            plugin_identity("/h/plugins/cache/mkt/1.0.0/skills/s"),
            Some(("1.0.0".into(), "mkt".into()))
        );
        // 只丢像版本号的末段
        assert_eq!(
            plugin_identity("/h/plugins/cache/mkt/plug/beta/skills/s"),
            Some(("beta".into(), "mkt".into()))
        );
    }

    #[test]
    fn cache_form() {
        assert_eq!(
            plugin_identity("/h/.claude/plugins/cache/mkt/plug/unknown/skills/s"),
            Some(("plug".into(), "mkt".into()))
        );
    }

    #[test]
    fn marketplaces_plugins_form() {
        assert_eq!(
            plugin_identity("/h/.claude/plugins/marketplaces/mkt/plugins/plug/skills/s"),
            Some(("plug".into(), "mkt".into()))
        );
    }

    #[test]
    fn marketplaces_external_plugins_form() {
        assert_eq!(
            plugin_identity("/h/.claude/plugins/marketplaces/mkt/external_plugins/plug/skills/s"),
            Some(("plug".into(), "mkt".into()))
        );
    }

    #[test]
    fn non_plugin_path() {
        assert_eq!(plugin_identity("/h/.claude/skills/s"), None);
    }

    #[test]
    fn wrapper_dirs_stripped_last_segment_wins() {
        assert_eq!(
            plugin_identity("/h/plugins/cache/mkt/a/b/unknown/skills/s"),
            Some(("b".into(), "mkt".into()))
        );
    }

    #[test]
    fn falls_back_to_marketplace_when_all_wrappers() {
        assert_eq!(
            plugin_identity("/h/plugins/cache/mkt/unknown/skills/s"),
            Some(("mkt".into(), "mkt".into()))
        );
    }

    #[test]
    fn trailing_slash_appended_internally() {
        assert_eq!(
            plugin_identity("/h/plugins/cache/mkt/plug/unknown/skills"),
            Some(("plug".into(), "mkt".into()))
        );
    }

    #[test]
    fn expand_root_drops_dot_slash_like_python_path() {
        assert_eq!(norm(&expand_root("./.claude/skills", "/home/u")), ".claude/skills");
        assert_eq!(norm(&expand_root("~/.claude/skills", "/home/u")), "/home/u/.claude/skills");
    }
}
