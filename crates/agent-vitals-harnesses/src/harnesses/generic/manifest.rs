//! 自描述插件执行环境的 manifest 加载与校验（HARNESS_MANIFEST_DSL_SPEC §3）。
//!
//! **纯模块**（无 I/O）：输入是已加载的 `serde_json::Value`，输出是校验过的
//! `PluginManifest` 或精确到字段的问题。文件读取与目录名一致性检查在
//! `sources/`（I/O 守卫层）。
//!
//! 校验是 `docs/schemas/harness-manifest-v1.json` 的手写执行版——runtime 不引
//! jsonschema 依赖（dependency_budget 守卫的依赖白名单），schema 文件供
//! 编辑器/Agent 与本实现对账；两边的差异由 fixtures 测试钉住。
//!
//! P0 capability 边界（spec 附录 A 尾注）：`records`（DSL，P2）与 `adapter`
//! （沙箱脚本，P1.5）在 P0 是**显式拒绝**并给出可操作报错，不是未知字段
//! 的泛化报错——避免「结构校验通过、运行时不支持」的半接状态。

use std::collections::BTreeMap;

use regex::Regex;

/// P0 收录的 recipe 词表（spec §4.1）。语义实现住 `super::recipe`。
pub const RECIPE_IDS: [&str; 3] = [
    "request-usage-anthropic-v1",
    "request-usage-openai-total-input-v1",
    "request-usage-four-bucket-v1",
];

/// slug 保留字（spec §3.1）：官方执行环境名（防 `harness:claude-code` 式冒充）+
/// `harness-` / `plugin-` 前缀变体（防 `harness:harness-x` → `harness-harness-x.jsonl`
/// 与迁移期旧 `plugin-` 文件名的混淆）。
pub const RESERVED_SLUGS: [&str; 6] =
    ["claude-code", "codex", "dsh", "workbuddy", "openclaw", "hermes"];

/// overrides / event_key 允许的槽位词表（schema `propertyNames`）。
pub const OVERRIDE_SLOTS: [&str; 9] = [
    "event_ts",
    "model_raw",
    "provider_raw",
    "uncached_input_tokens",
    "total_input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "provider_request_id",
];

/// 单文件目标记录上限（spec §6.4）：默认 5 万、封顶 50 万。超限整文件失败，
/// 不截断。
pub const DEFAULT_MAX_ROWS_PER_FILE: u64 = 50_000;
pub const HARD_MAX_ROWS_PER_FILE: u64 = 500_000;

/// manifest 版本。不认识的版本拒绝加载并报可操作错误（spec §3.1）。
pub const MANIFEST_VERSION: u64 = 1;

/// Only capabilities implemented by both compatibility runtimes are advertised.
pub const FEATURE_IDS: [&str; 0] = [];
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone)]
pub struct CapabilitySet {
    pub app_version: String,
    pub recipes: Vec<String>,
    pub features: Vec<String>,
}

impl Default for CapabilitySet {
    fn default() -> Self {
        Self {
            app_version: APP_VERSION.to_owned(),
            recipes: RECIPE_IDS.iter().map(|s| (*s).to_owned()).collect(),
            features: FEATURE_IDS.iter().map(|s| (*s).to_owned()).collect(),
        }
    }
}

fn release_version(value: &str) -> Option<[u32; 3]> {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 { return None; }
    let mut version = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0')) { return None; }
        version[i] = part.parse().ok()?;
    }
    Some(version)
}

pub fn negotiate_capabilities(value: &serde_json::Value, capabilities: &CapabilitySet) -> Result<(), ManifestError> {
    negotiate_requirements(value, capabilities)?;
    if let Some(recipe) = value.get("recipe") {
        let recipe = recipe.as_str().ok_or_else(|| err("recipe", "必须是字符串"))?;
        if !capabilities.recipes.iter().any(|supported| supported == recipe) {
            return Err(err("recipe", format!("未知 recipe `{recipe}`（已知：{:?}）", capabilities.recipes)));
        }
    }
    Ok(())
}

fn negotiate_requirements(value: &serde_json::Value, capabilities: &CapabilitySet) -> Result<(), ManifestError> {
    let obj = value.as_object().ok_or_else(|| err("(root)", "manifest 必须是 JSON object"))?;
    let app_version = &capabilities.app_version;
    if let Some(value) = obj.get("min_app_version") {
        let minimum = value.as_str().and_then(release_version)
            .ok_or_else(|| err("min_app_version", "必须是 MAJOR.MINOR.PATCH（无前导零、预发布或构建后缀，各段 <= 4294967295）"))?;
        let current = release_version(app_version)
            .ok_or_else(|| err("min_app_version", "运行时版本不是受支持的发布版本"))?;
        if current < minimum {
            return Err(err("min_app_version", format!("需要 app >= {}（当前 {app_version}）——请升级 app", value.as_str().unwrap())));
        }
    }
    if let Some(value) = obj.get("requires") {
        let requires = value.as_object().ok_or_else(|| err("requires", "必须是 object"))?;
        for key in requires.keys() {
            if key != "recipes" && key != "features" { return Err(err(format!("requires.{key}"), "未知字段")); }
        }
        for (key, supported) in [("recipes", capabilities.recipes.as_slice()), ("features", capabilities.features.as_slice())] {
            if let Some(value) = requires.get(key) {
                let field = format!("requires.{key}");
                let entries = string_array(Some(value), &field, 0, 64)?;
                for (i, entry) in entries.iter().enumerate() {
                    if entries[..i].contains(entry) { return Err(err(format!("{field}[{i}]"), "重复能力")); }
                    if !supported.contains(entry) {
                        return Err(err(format!("{field}[{i}]"), format!("缺失能力 `{entry}`（支持：{supported:?}；最低版本未知）——请升级 app 或换 manifest")));
                    }
                }
            }
        }
    }
    Ok(())
}

/// 校验失败：`field` 是 manifest 内的字段路径（如 `session.pattern`），
/// `problem` 是可直接展示给作者/Agent 的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError {
    pub field: String,
    pub problem: String,
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.field, self.problem)
    }
}

fn err(field: impl Into<String>, problem: impl Into<String>) -> ManifestError {
    ManifestError {
        field: field.into(),
        problem: problem.into(),
    }
}

/// 校验后的 manifest。`session_pattern` 已编译；`overrides` 键序用 BTreeMap
/// 固定（golden 字节序的前提）。
#[derive(Debug)]
pub struct PluginManifest {
    pub slug: String,
    pub display_name: String,
    pub roots: Vec<String>,
    pub include: Vec<String>,
    pub session_pattern: Regex,
    /// On-disk encoding for the JSONL source. Defaults to plain JSONL.
    pub compression: SourceCompression,
    pub recipe: String,
    pub overrides: BTreeMap<String, String>,
    pub event_key_paths: Vec<String>,
    pub max_rows_per_file: u64,
    pub billing_locked: bool,
    /// Optional reviewed local session-title adapter. Manifests select only a
    /// closed adapter id; they cannot provide paths, SQL, or executable code.
    pub session_title_adapter: Option<PluginSessionTitleAdapter>,
    /// Optional local Trust artifact profile. This is a declarative, read-only
    /// capability; it does not authorize a scanner to read file contents.
    pub trust: Option<TrustArtifactProfile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceCompression { None, Zstd }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginSessionTitleAdapter {
    ZcodeSqliteSessionV1,
}

impl PluginSessionTitleAdapter {
    pub const fn as_str(self) -> &'static str {
        match self { Self::ZcodeSqliteSessionV1 => "zcode_sqlite_session_v1" }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value { "zcode_sqlite_session_v1" => Some(Self::ZcodeSqliteSessionV1), _ => None }
    }

    fn supports_slug(self, slug: &str) -> bool {
        match self { Self::ZcodeSqliteSessionV1 => slug == "zcode" }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustArtifactProfile {
    pub roots: Vec<String>,
    pub artifact_terms: Vec<String>,
    pub extensions: Vec<String>,
    /// An optional, reviewed local evidence adapter.  Omitted means generic
    /// filename metadata only; manifests cannot supply SQL or a command.
    pub adapter: Option<TrustEvidenceAdapter>,
    /// Coverage scheduling hint only. It never changes evidence confidence,
    /// severity, Finding creation, or notification eligibility.
    pub watch_priority: TrustWatchPriority,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustWatchPriority { Normal, Enhanced }

impl TrustWatchPriority {
    pub const fn as_str(self) -> &'static str {
        match self { Self::Normal => "normal", Self::Enhanced => "enhanced" }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value { "normal" => Some(Self::Normal), "enhanced" => Some(Self::Enhanced), _ => None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustEvidenceAdapter {
    GenericArtifactV1,
    ZcodeCheckpointV1,
    MiniMaxWorkspaceIndexV1,
}

impl TrustEvidenceAdapter {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GenericArtifactV1 => "generic_artifact_v1",
            Self::ZcodeCheckpointV1 => "zcode_checkpoint_v1",
            Self::MiniMaxWorkspaceIndexV1 => "minimax_workspace_index_v1",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "generic_artifact_v1" => Some(Self::GenericArtifactV1),
            "zcode_checkpoint_v1" => Some(Self::ZcodeCheckpointV1),
            "minimax_workspace_index_v1" => Some(Self::MiniMaxWorkspaceIndexV1),
            _ => None,
        }
    }
}

/// 从 `~/` 展开后的 roots。保留原始串用于 display；展开在 discovery 做。
impl PluginManifest {
    pub fn facts_harness(&self) -> String {
        format!("harness:{}", self.slug)
    }

    pub fn facts_file_stem(&self) -> String {
        format!("harness-{}", self.slug)
    }
}

/// 点路径文法（spec §4.2）：`IDENT ("." IDENT)*`，无函数/下标/通配。
pub fn is_dotted_path(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    s.split('.').all(|seg| {
        let mut chars = seg.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// 受限正则子集校验（spec §3.1）：只允许字面量/字符类/锚点/分组与唯一
/// `(?P<id>...)` 具名组。**显式扫描**拒绝 look-around、backreference 与
/// 非 `?P` 命名组——Rust `regex` 不支持前两者（编译即败），但 Python `re`
/// 支持前视；两语言必须走同一条扫描规则，不能依赖各自引擎的失败模式。
pub fn validate_session_pattern(pattern: &str) -> Result<Regex, ManifestError> {
    let field = "session.pattern";
    // `(?P=`/`(?#` 是 Python 专属（命名反向引用/注释组），Python re 会编译
    // 通过而 Rust 引擎报错——必须走显式拒绝，不能依赖引擎失败模式的分歧。
    for banned in ["(?=", "(?!", "(?<=", "(?<!", "(?'", "(?P=", "(?#"] {
        if pattern.contains(banned) {
            return Err(err(
                field,
                format!("受限正则子集不接受 {banned}…（look-around）"),
            ));
        }
    }
    for (i, b) in pattern.bytes().enumerate() {
        if b == b'\\' && i + 1 < pattern.len() {
            let next = pattern.as_bytes()[i + 1];
            if next.is_ascii_digit() {
                return Err(err(
                    field,
                    "受限正则子集不接受反向引用（\\1…\\9）",
                ));
            }
        }
    }
    // 非 `(?P<name>` 的命名组写法（如 .NET/PCRE 的 `(?<name>`）统一拒绝，
    // 两语言各自引擎的宽容度不同，规范只认 `(?P<id>...)`。
    let mut rest = pattern;
    while let Some(pos) = rest.find("(?<") {
        if rest[pos..].starts_with("(?P<") {
            rest = &rest[pos + 4..];
        } else {
            return Err(err(
                field,
                "命名组只接受 Python 风格 (?P<id>...) 写法",
            ));
        }
    }
    let compiled = Regex::new(pattern)
        .map_err(|e| err(field, format!("正则编译失败：{e}")))?;
    let names: Vec<&str> = compiled.capture_names().flatten().collect();
    if names != ["id"] {
        return Err(err(
            field,
            format!(
                "必须恰好一个具名组 (?P<id>...)（实际：{}个）",
                names.len()
            ),
        ));
    }
    Ok(compiled)
}

/// 从已解析的 JSON Value 构造并校验 manifest（spec §3 字段表 + 附录 A）。
pub fn parse_manifest(value: serde_json::Value) -> Result<PluginManifest, ManifestError> {
    let obj = value
        .as_object()
        .ok_or_else(|| err("(root)", "manifest 必须是 JSON object"))?;

    // P0 capability 边界：两个未来字段显式拒绝（附录 A 尾注）。
    if obj.contains_key("records") {
        return Err(err(
            "records",
            "DSL records 是 P2 capability，当前运行时不支持（manifest_version 1 P0）",
        ));
    }
    if obj.contains_key("adapter") {
        return Err(err(
            "adapter",
            "脚本 adapter 是 P1.5 capability，当前运行时不支持（manifest_version 1 P0）",
        ));
    }

    let known = [
        "$schema",
        "manifest_version",
        "slug",
        "display",
        "discovery",
        "source",
        "session",
        "recipe",
        "overrides",
        "event_key",
        "limits",
        "billing",
        "trust",
        "session_title_adapter",
        "requires",
        "min_app_version",
    ];
    for key in obj.keys() {
        if !known.contains(&key.as_str()) {
            return Err(err(key, "未知字段（schema additionalProperties: false）"));
        }
    }
    if let Some(v) = obj.get("$schema") {
        if v.as_str().is_none() {
            return Err(err("$schema", "必须是字符串（schema URL）"));
        }
    }

    let version = obj
        .get("manifest_version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| err("manifest_version", "必须是整数 1"))?;
    if version != MANIFEST_VERSION {
        return Err(err(
            "manifest_version",
            format!("不支持的版本 {version}（本运行时支持 {MANIFEST_VERSION}）——请升级 app 或换 manifest"),
        ));
    }

    negotiate_requirements(&value, &CapabilitySet::default())?;

    let slug = obj
        .get("slug")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("slug", "必须是非空字符串"))?;
    let slug_re = Regex::new(r"^[a-z][a-z0-9-]{0,31}$").unwrap();
    if !slug_re.is_match(slug) {
        return Err(err(
            "slug",
            "必须匹配 ^[a-z][a-z0-9-]{0,31}$",
        ));
    }
    if RESERVED_SLUGS.contains(&slug) || slug.starts_with("harness-") || slug.starts_with("plugin-") {
        return Err(err("slug", format!("`{slug}` 是保留字（官方执行环境名 / harness- 与 plugin- 前缀）")));
    }

    let display = obj
        .get("display")
        .and_then(|v| v.as_object())
        .ok_or_else(|| err("display", "必须是 object"))?;
    for key in display.keys() {
        if key != "name" {
            return Err(err(format!("display.{key}"), "未知字段"));
        }
    }
    let display_name = display
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("display.name", "必须是非空字符串"))?;
    if display_name.is_empty() || display_name.chars().count() > 24 {
        return Err(err("display.name", "长度必须 1..=24 字符"));
    }

    let discovery = obj
        .get("discovery")
        .and_then(|v| v.as_object())
        .ok_or_else(|| err("discovery", "必须是 object"))?;
    for key in discovery.keys() {
        if key != "roots" && key != "include" {
            return Err(err(format!("discovery.{key}"), "未知字段"));
        }
    }
    let roots: Vec<String> = string_array(discovery.get("roots"), "discovery.roots", 1, 16)?;
    let include: Vec<String> = string_array(discovery.get("include"), "discovery.include", 1, 16)?;
    for (i, g) in include.iter().enumerate() {
        if !is_valid_glob(g) {
            return Err(err(
                format!("discovery.include[{i}]"),
                "只支持 *、?、** 与字面量字符（不支持字符类/花括号）",
            ));
        }
    }

    let source = obj
        .get("source")
        .and_then(|v| v.as_object())
        .ok_or_else(|| err("source", "必须是 object"))?;
    for key in source.keys() {
        if key != "format" && key != "compression" {
            return Err(err(format!("source.{key}"), "未知字段"));
        }
    }
    let format = source
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("source.format", "必须是字符串"))?;
    if format != "jsonl" {
        return Err(err("source.format", format!("P0 仅支持 jsonl（得到 {format}）")));
    }
    let compression_value = match source.get("compression") {
        None => "none",
        Some(value) => value.as_str().ok_or_else(|| err("source.compression", "必须是字符串"))?,
    };
    let compression = match compression_value {
        "none" => SourceCompression::None,
        "zstd" => SourceCompression::Zstd,
        value => return Err(err("source.compression", format!("仅支持 none 或 zstd（得到 {value}）"))),
    };

    let session = obj
        .get("session")
        .and_then(|v| v.as_object())
        .ok_or_else(|| err("session", "必须是 object"))?;
    for key in session.keys() {
        if key != "from" && key != "pattern" {
            return Err(err(format!("session.{key}"), "未知字段"));
        }
    }
    let from = session
        .get("from")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("session.from", "必须是字符串"))?;
    if from != "filename" {
        return Err(err("session.from", "P0 仅支持 filename（record 提取是 P2）"));
    }
    let pattern = session
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("session.pattern", "必须是字符串"))?;
    let session_pattern = validate_session_pattern(pattern)?;

    let recipe = obj
        .get("recipe")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("recipe", "必须是字符串"))?;
    if !RECIPE_IDS.contains(&recipe) {
        return Err(err(
            "recipe",
            format!("未知 recipe `{recipe}`（已知：{RECIPE_IDS:?}）"),
        ));
    }

    let mut overrides = BTreeMap::new();
    match obj.get("overrides") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(map)) => {
            for (k, v) in map {
                if !OVERRIDE_SLOTS.contains(&k.as_str()) {
                    return Err(err(
                        format!("overrides.{k}"),
                        format!("未知槽位（允许：{OVERRIDE_SLOTS:?}）"),
                    ));
                }
                let path = v
                    .as_str()
                    .ok_or_else(|| err(format!("overrides.{k}"), "必须是点路径字符串"))?;
                if !is_dotted_path(path) {
                    return Err(err(
                        format!("overrides.{k}"),
                        "必须是纯点路径 IDENT(.IDENT)*（无表达式/函数/下标）",
                    ));
                }
                overrides.insert(k.clone(), path.to_string());
            }
        }
        Some(_) => return Err(err("overrides", "必须是 object")),
    }

    let event_key = obj
        .get("event_key")
        .and_then(|v| v.as_object())
        .ok_or_else(|| err("event_key", "必须是 object"))?;
    for key in event_key.keys() {
        if key != "paths" {
            return Err(err(format!("event_key.{key}"), "未知字段"));
        }
    }
    let event_key_paths: Vec<String> =
        string_array(event_key.get("paths"), "event_key.paths", 1, 8)?;
    for (i, p) in event_key_paths.iter().enumerate() {
        if !is_dotted_path(p) {
            return Err(err(
                format!("event_key.paths[{i}]"),
                "必须是纯点路径 IDENT(.IDENT)*",
            ));
        }
    }

    let mut max_rows_per_file = DEFAULT_MAX_ROWS_PER_FILE;
    match obj.get("limits") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(limits)) => {
            for key in limits.keys() {
                if key != "max_rows_per_file" {
                    return Err(err(format!("limits.{key}"), "未知字段"));
                }
            }
            if let Some(n) = limits.get("max_rows_per_file") {
                let n = n
                    .as_u64()
                    .ok_or_else(|| err("limits.max_rows_per_file", "必须是正整数"))?;
                if n == 0 || n > HARD_MAX_ROWS_PER_FILE {
                    return Err(err(
                        "limits.max_rows_per_file",
                        format!("必须 1..={HARD_MAX_ROWS_PER_FILE}"),
                    ));
                }
                max_rows_per_file = n;
            }
        }
        Some(_) => return Err(err("limits", "必须是 object")),
    }

    let mut billing_locked = false;
    match obj.get("billing") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(billing)) => {
            for key in billing.keys() {
                if key != "policy" {
                    return Err(err(format!("billing.{key}"), "未知字段"));
                }
            }
            let policy = billing
                .get("policy")
                .and_then(|v| v.as_str())
                .ok_or_else(|| err("billing.policy", "必须是字符串"))?;
            if policy != "lock:metered_estimate" {
                return Err(err(
                    "billing.policy",
                    format!("插件执行环境仅接受 `lock:metered_estimate`（得到 `{policy}`）——官方订阅档须官方适配器"),
                ));
            }
            billing_locked = true;
        }
        Some(_) => return Err(err("billing", "必须是 object")),
    }

    let trust = match obj.get("trust") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(trust)) => {
            for key in trust.keys() {
                if !matches!(key.as_str(), "roots" | "artifact_terms" | "extensions" | "adapter" | "watch_priority") {
                    return Err(err(format!("trust.{key}"), "未知字段"));
                }
            }
            let roots = string_array(trust.get("roots"), "trust.roots", 1, 8)?;
            for (index, root) in roots.iter().enumerate() {
                let relative = root.strip_prefix("~/").ok_or_else(|| err(
                    format!("trust.roots[{index}]"), "必须是 ~/ 下的相对路径",
                ))?;
                let path = std::path::Path::new(relative);
                if relative.is_empty() || relative.len() > 240 || path.is_absolute()
                    || path.components().any(|part| !matches!(part, std::path::Component::Normal(_)))
                {
                    return Err(err(format!("trust.roots[{index}]"), "不得是绝对路径或包含 . / .."));
                }
            }
            let artifact_terms = string_array(trust.get("artifact_terms"), "trust.artifact_terms", 1, 8)?;
            for (index, term) in artifact_terms.iter().enumerate() {
                if !safe_trust_token(term, 40) {
                    return Err(err(format!("trust.artifact_terms[{index}]"), "必须是小写枚举 token"));
                }
            }
            let extensions = string_array(trust.get("extensions"), "trust.extensions", 1, 8)?;
            for (index, extension) in extensions.iter().enumerate() {
                let Some(suffix) = extension.strip_prefix('.') else {
                    return Err(err(format!("trust.extensions[{index}]"), "必须是 . 加小写扩展名"));
                };
                if !safe_trust_token(suffix, 16) {
                    return Err(err(format!("trust.extensions[{index}]"), "必须是 . 加小写扩展名"));
                }
            }
            let adapter = match trust.get("adapter") {
                None => None,
                Some(serde_json::Value::String(value)) => TrustEvidenceAdapter::parse(value)
                    .map(Some).ok_or_else(|| err("trust.adapter", "不是受支持的受审计 adapter"))?,
                Some(_) => return Err(err("trust.adapter", "必须是 string")),
            };
            let watch_priority = match trust.get("watch_priority") {
                None => TrustWatchPriority::Normal,
                Some(serde_json::Value::String(value)) => TrustWatchPriority::parse(value)
                    .ok_or_else(|| err("trust.watch_priority", "必须是 normal 或 enhanced"))?,
                Some(_) => return Err(err("trust.watch_priority", "必须是 string")),
            };
            Some(TrustArtifactProfile { roots, artifact_terms, extensions, adapter, watch_priority })
        }
        Some(_) => return Err(err("trust", "必须是 object")),
    };

    let session_title_adapter = match obj.get("session_title_adapter") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => PluginSessionTitleAdapter::parse(value)
            .map(Some).ok_or_else(|| err("session_title_adapter", "不是受支持的受审计 adapter"))?,
        Some(_) => return Err(err("session_title_adapter", "必须是 string")),
    };
    if session_title_adapter.is_some_and(|adapter| !adapter.supports_slug(slug)) {
        return Err(err("session_title_adapter", "此 adapter 与 manifest slug 不匹配"));
    }

    Ok(PluginManifest {
        slug: slug.to_string(),
        display_name: display_name.to_string(),
        roots,
        include,
        session_pattern,
        compression,
        recipe: recipe.to_string(),
        overrides,
        event_key_paths,
        max_rows_per_file,
        billing_locked,
        session_title_adapter,
        trust,
    })
}

fn safe_trust_token(value: &str, max_len: usize) -> bool {
    value.bytes().next().is_some_and(|byte| byte.is_ascii_lowercase())
        && value.len() <= max_len
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.'))
}

fn string_array(
    value: Option<&serde_json::Value>,
    field: &str,
    min: usize,
    max: usize,
) -> Result<Vec<String>, ManifestError> {
    let arr = value
        .and_then(|v| v.as_array())
        .ok_or_else(|| err(field, "必须是字符串数组"))?;
    if arr.len() < min || arr.len() > max {
        return Err(err(field, format!("长度必须 {min}..={max}")));
    }
    arr.iter()
        .enumerate()
        .map(|(i, v)| {
            let s = v
                .as_str()
                .ok_or_else(|| err(format!("{field}[{i}]"), "必须是字符串"))?;
            if s.is_empty() {
                return Err(err(format!("{field}[{i}]"), "不能为空"));
            }
            Ok(s.to_string())
        })
        .collect()
}

/// include glob 文法检查（spec §3.2）：只允许字面量、`*`、`?`、`**`。
/// 语义实现在 `super::super::sources::discover::glob_match`，这里只做
/// 装期文法拒绝（字符类/花括号等 fnmatch 花活不进契约）。
fn is_valid_glob(pattern: &str) -> bool {
    !pattern.is_empty()
        && !pattern.contains(['[', ']', '{', '}'])
        && !pattern.contains('\\')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn zcode_manifest() -> serde_json::Value {
        json!({
            "manifest_version": 1,
            "slug": "zcode",
            "display": { "name": "ZCode" },
            "discovery": {
                "roots": ["~/.zcode/cli/rollout"],
                "include": ["model-io-sess_*.jsonl"]
            },
            "source": { "format": "jsonl" },
            "session": {
                "from": "filename",
                "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$"
            },
            "recipe": "request-usage-anthropic-v1",
            "session_title_adapter": "zcode_sqlite_session_v1",
            "overrides": {
                "event_ts": "completedAt",
                "model_raw": "model.modelId",
                "uncached_input_tokens": "usage.input_tokens"
            },
            "event_key": { "paths": ["requestId", "attempt"] },
            "billing": { "policy": "lock:metered_estimate" }
        })
    }

    #[test]
    fn shared_capability_fixtures() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../../../../fixtures/harness-manifest-capabilities.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mut value = zcode_manifest();
            value.as_object_mut().unwrap().extend(case["extension"].as_object().unwrap().clone());
            if let Some(count) = case["repeat_features"].as_u64() {
                value["requires"] = json!({"features": vec!["future"; count as usize]});
            }
            if case["error_field"].is_null() {
                parse_manifest(value).unwrap();
            } else {
                let error = parse_manifest(value).unwrap_err();
                assert_eq!(error.field, case["error_field"].as_str().unwrap());
                assert_eq!(error.problem, case["problem"].as_str().unwrap());
            }
        }
    }

    #[test]
    fn negotiation_uses_injected_runtime_capabilities() {
        let value = json!({"min_app_version": "1.10.0", "requires": {"features": ["fixture-feature"]}});
        let mut capabilities = CapabilitySet {
            app_version: "1.10.0".to_owned(), recipes: vec![], features: vec!["fixture-feature".to_owned()],
        };
        negotiate_capabilities(&value, &capabilities).unwrap();
        let recipe_value = json!({"recipe": RECIPE_IDS[0]});
        assert_eq!(negotiate_capabilities(&recipe_value, &capabilities).unwrap_err().field, "recipe");
        capabilities.app_version = "1.9.0".to_owned();
        assert_eq!(negotiate_capabilities(&value, &capabilities).unwrap_err().field, "min_app_version");
    }

    #[test]
    fn capabilities_and_release_versions_gate_real_parser() {
        for minimum in ["0.0.0", APP_VERSION] {
            let mut v = zcode_manifest();
            v["min_app_version"] = json!(minimum);
            v["requires"] = json!({"recipes": RECIPE_IDS, "features": []});
            assert_eq!(parse_manifest(v).unwrap().facts_harness(), "harness:zcode");
        }
        for (extension, field) in [
            (json!({"min_app_version": "4294967295.0.0"}), "min_app_version"),
            (json!({"min_app_version": "01.0.0"}), "min_app_version"),
            (json!({"min_app_version": "1.0.0-rc.1"}), "min_app_version"),
            (json!({"min_app_version": "1.0.0+build"}), "min_app_version"),
            (json!({"min_app_version": "1.0"}), "min_app_version"),
            (json!({"min_app_version": "4294967296.0.0"}), "min_app_version"),
            (json!({"min_app_version": null}), "min_app_version"),
            (json!({"requires": null}), "requires"),
            (json!({"requires": {"unknown": []}}), "requires.unknown"),
            (json!({"requires": {"features": ["trust"]}}), "requires.features[0]"),
            (json!({"requires": {"recipes": ["future-v2"]}}), "requires.recipes[0]"),
            (json!({"requires": {"recipes": [RECIPE_IDS[0], RECIPE_IDS[0]]}}), "requires.recipes[1]"),
            (json!({"requires": {"features": "records"}}), "requires.features"),
            (json!({"session_title_adapter": "arbitrary_sql"}), "session_title_adapter"),
        ] {
            let mut v = zcode_manifest();
            v.as_object_mut().unwrap().extend(extension.as_object().unwrap().clone());
            assert_eq!(parse_manifest(v).unwrap_err().field, field);
        }
    }

    #[test]
    fn zcode_pilot_manifest_parses() {
        let m = parse_manifest(zcode_manifest()).unwrap();
        assert_eq!(m.slug, "zcode");
        assert_eq!(m.facts_harness(), "harness:zcode");
        assert_eq!(m.facts_file_stem(), "harness-zcode");
        assert_eq!(m.recipe, "request-usage-anthropic-v1");
        assert_eq!(m.overrides.len(), 3);
        assert_eq!(m.event_key_paths, ["requestId", "attempt"]);
        assert_eq!(m.session_title_adapter, Some(PluginSessionTitleAdapter::ZcodeSqliteSessionV1));
        assert!(m.billing_locked);
        assert_eq!(m.max_rows_per_file, DEFAULT_MAX_ROWS_PER_FILE);
        // 具名组提取走一次真实匹配。
        let caps = m.session_pattern.captures("model-io-sess_abc-123.jsonl").unwrap();
        assert_eq!(caps.name("id").unwrap().as_str(), "abc-123");
    }

    #[test]
    fn source_compression_is_optional_and_restricted() {
        let mut value = zcode_manifest();
        assert_eq!(parse_manifest(value.clone()).unwrap().compression, SourceCompression::None);
        value["source"]["compression"] = json!("zstd");
        assert_eq!(parse_manifest(value.clone()).unwrap().compression, SourceCompression::Zstd);
        value["source"]["compression"] = json!("gzip");
        assert_eq!(parse_manifest(value).unwrap_err().field, "source.compression");
    }

    #[test]
    fn session_title_adapter_must_match_its_plugin_identity() {
        let mut value = zcode_manifest();
        value["slug"] = json!("other-plugin");
        let error = parse_manifest(value).unwrap_err();
        assert_eq!(error.field, "session_title_adapter");
    }

    #[test]
    fn trust_profile_is_optional_bounded_and_read_only() {
        let mut value = zcode_manifest();
        value["trust"] = json!({
            "roots": ["~/.zcode/v2/checkpoints"],
            "artifact_terms": ["snapshot", "checkpoint"],
            "extensions": [".enc"]
        });
        let manifest = parse_manifest(value).unwrap();
        let trust = manifest.trust.unwrap();
        assert_eq!(trust.roots, ["~/.zcode/v2/checkpoints"]);
        assert_eq!(trust.artifact_terms, ["snapshot", "checkpoint"]);
        assert_eq!(trust.adapter, None);
        assert_eq!(trust.watch_priority, TrustWatchPriority::Normal);

        let mut adapter_value = zcode_manifest();
        adapter_value["trust"] = json!({
            "roots": ["~/.zcode/v2/checkpoints"],
            "artifact_terms": ["snapshot"], "extensions": [".enc"],
            "adapter": "zcode_checkpoint_v1"
        });
        assert_eq!(parse_manifest(adapter_value).unwrap().trust.unwrap().adapter,
            Some(TrustEvidenceAdapter::ZcodeCheckpointV1));

        let mut enhanced_value = zcode_manifest();
        enhanced_value["trust"] = json!({
            "roots": ["~/.zcode/v2/checkpoints"], "artifact_terms": ["snapshot"],
            "extensions": [".enc"], "watch_priority": "enhanced"
        });
        assert_eq!(parse_manifest(enhanced_value).unwrap().trust.unwrap().watch_priority,
            TrustWatchPriority::Enhanced);

        let mut unsafe_value = zcode_manifest();
        unsafe_value["trust"] = json!({
            "roots": ["~/../outside"], "artifact_terms": ["snapshot"], "extensions": [".enc"]
        });
        assert!(parse_manifest(unsafe_value).is_err(), "Trust roots must stay under HOME");

        let mut unsafe_adapter = zcode_manifest();
        unsafe_adapter["trust"] = json!({
            "roots": ["~/.zcode/v2/checkpoints"], "artifact_terms": ["snapshot"],
            "extensions": [".enc"], "adapter": "arbitrary_sql_v1"
        });
        assert!(parse_manifest(unsafe_adapter).is_err(), "Trust adapter must stay allowlisted");
    }

    #[test]
    fn unknown_field_and_future_capabilities_are_rejected() {
        let mut v = zcode_manifest();
        v["bogus"] = json!(1);
        assert_eq!(
            parse_manifest(v).unwrap_err(),
            err("bogus", "未知字段（schema additionalProperties: false）")
        );
        let mut v = zcode_manifest();
        v["records"] = json!([]);
        let e = parse_manifest(v).unwrap_err();
        assert!(e.problem.contains("P2"), "records 拒绝须指明 capability：{e}");
        let mut v = zcode_manifest();
        v["adapter"] = json!({"command": ["x"]});
        let e = parse_manifest(v).unwrap_err();
        assert!(e.problem.contains("P1.5"), "adapter 拒绝须指明 capability：{e}");
    }

    #[test]
    fn unknown_manifest_version_is_rejected_actionably() {
        let mut v = zcode_manifest();
        v["manifest_version"] = json!(2);
        let e = parse_manifest(v).unwrap_err();
        assert!(e.problem.contains("2") && e.problem.contains("1"), "{e}");
    }

    #[test]
    fn slug_rules_are_enforced() {
        for bad in [
            "ZCode", "1code", "-code", "", "claude-code", "codex", "dsh", "workbuddy",
            "openclaw", "hermes", "plugin-x", "harness-x", "has_underscore",
        ] {
            let mut v = zcode_manifest();
            v["slug"] = json!(bad);
            assert!(parse_manifest(v).is_err(), "slug `{bad}` 应被拒绝");
        }
    }

    #[test]
    fn override_slots_and_paths_are_enforced() {
        let mut v = zcode_manifest();
        v["overrides"]["nope"] = json!("a.b");
        assert!(parse_manifest(v).is_err());
        let mut v = zcode_manifest();
        v["overrides"]["event_ts"] = json!("a ?? b");
        assert!(parse_manifest(v).is_err(), "表达式不是点路径");
        let mut v = zcode_manifest();
        v["overrides"]["event_ts"] = json!("rows[0].ts");
        assert!(parse_manifest(v).is_err(), "下标不是点路径");
        let mut v = zcode_manifest();
        v["event_key"]["paths"] = json!((1..=9).map(|i| json!(format!("k{i}"))).collect::<Vec<_>>());
        assert!(parse_manifest(v).is_err(), "event_key.paths 上限 8");
    }

    #[test]
    fn billing_lock_rejects_anything_but_metered_estimate() {
        let mut v = zcode_manifest();
        v["billing"]["policy"] = json!("lock:official_subscription");
        let e = parse_manifest(v).unwrap_err();
        assert!(e.problem.contains("metered_estimate"), "{e}");
    }

    #[test]
    fn session_pattern_subset_is_explicitly_scanned() {
        // look-around：Rust regex 本来就不编译，但扫描拒绝是两语言共同规则。
        for bad in [
            "^model-(?=io)sess_(?P<id>.+)\\.jsonl$",
            "^model-(?!x)sess_(?P<id>.+)\\.jsonl$",
            "^sess_(?P<id>.+)\\1$",
            "^sess_(?<id>.+)\\.jsonl$",   // 非 ?P 命名组写法
            "^sess_(?P<a>.+)(?P<b>x)$",   // 具名组数量 ≠ 1
            "^sess_(?P<id>a)(?P=id)$",    // Python 命名反向引用（显式拒绝，不靠引擎分歧）
            "^sess_(?#c)(?P<id>.+)$",     // Python 注释组
            "^sess_\\.jsonl$",            // 没有具名组
        ] {
            assert!(validate_session_pattern(bad).is_err(), "`{bad}` 应被拒绝");
        }
        let ok = validate_session_pattern("^model-io-sess_(?P<id>[^/]+)\\.jsonl$").unwrap();
        assert!(ok.is_match("model-io-sess_x.jsonl"));
    }

    #[test]
    fn dotted_path_grammar() {
        assert!(is_dotted_path("usage.input_tokens"));
        assert!(is_dotted_path("_a.b1"));
        assert!(!is_dotted_path(""));
        assert!(!is_dotted_path("a..b"));
        assert!(!is_dotted_path("a[0]"));
        assert!(!is_dotted_path("1a"));
        assert!(!is_dotted_path("a b"));
    }

    #[test]
    fn limits_range_is_enforced() {
        let mut v = zcode_manifest();
        v["limits"] = json!({ "max_rows_per_file": 500_001 });
        assert!(parse_manifest(v).is_err());
        let mut v = zcode_manifest();
        v["limits"] = json!({ "max_rows_per_file": 1 });
        assert_eq!(parse_manifest(v).unwrap().max_rows_per_file, 1);
    }
}
