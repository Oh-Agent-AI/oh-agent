//! 插件执行环境摄入编排 + Candidate → UsageFact 喉咙（HARNESS_MANIFEST_DSL_SPEC
//! §5-§6、§9.2）。
//!
//! 职责边界：`agent-vitals-harnesses::generic` 产「候选行」（recipe 三态），
//! 本模块把候选行组装进 `build_usage_fact` 的字段 map（身份/billing 锁/
//! provenance 全部本体侧 stamp，manifest 无权提供 fact_id），并编排
//! validate（dry-run）与 ingest --write（facts JSONL exactly-once +
//! authority 双写）。
//!
//! **P0 护栏落点**（§6）：billing 锁（`billing_mode=metered` +
//! `pricing_basis=metered_estimate`，manifest 无权改）；provenance
//! （`source_revision` = manifest sha256 前 16 hex）；行数上限（超限整
//! 文件失败，不提交该文件任何事实）；fact_id 稳定性（重放两遍 id 序列
//! 不一致 → 拒绝安装）；首装 format guard（整个 corpus 零 emit → 拒绝；
//! 单文件零 target 只标黄——混合目录不误伤，spec §4.3 修订案）。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use agent_vitals_domain::usage_fact::build_usage_fact;
use agent_vitals_harnesses::generic_candidate::CandidateUsageV1;
use agent_vitals_harnesses::generic_manifest::{self, PluginManifest};
use agent_vitals_harnesses::generic_recipe::{self, LineVerdict, RecipeDef};
use serde_json::{json, Value};

use crate::harness_registry::{scan_plugin_harnesses, PluginHarness};

/// 单文件提取报告（如实三态计数 + 最多 8 条问题样例）。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PluginFileReport {
    pub rel_path: String,
    /// 绝对路径只在本地进程内用（authority sources 登记）；不进 JSON 负载
    /// （§6.3：redacted 面不暴露本地路径）。
    #[serde(skip_serializing)]
    pub abs_path: PathBuf,
    pub session_id: String,
    pub emitted: usize,
    pub skipped: usize,
    pub invalid: usize,
    pub invalid_problems: Vec<String>,
    /// 零 target 文件标黄（§4.3：不整文件失败，报告可见）。
    pub zero_target: bool,
    /// 行数超限 → 整文件失败，该文件事实不进账（§6.4）。
    pub failed: bool,
    pub problems: Vec<String>,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct PluginRunReport {
    pub slug: String,
    pub harness: String,
    pub recipe: String,
    pub manifest_revision: String,
    pub files: Vec<PluginFileReport>,
    pub emitted: usize,
    pub skipped: usize,
    pub invalid: usize,
    pub failed_files: usize,
    pub fact_id_stable: bool,
    pub date_min_utc_ms: Option<i64>,
    pub date_max_utc_ms: Option<i64>,
    pub models: Vec<String>,
    /// 首装 format guard：整个 corpus 零 emit → false（拒绝安装）。
    pub corpus_has_emit: bool,
    /// 如实警示（§「发现矛盾报告给上层」）：跨 root 的同一 session id 落在
    /// 多个 source_profile 下时，JSONL（身份含 profile）与 authority（身份
    /// UNIQUE 不含 profile）的行数会分歧——这里点名，不静默。
    pub warnings: Vec<String>,
    #[serde(skip_serializing)]
    pub facts: Vec<Value>,
    /// Opaque exact-input digest for local preview binding; not a serving field.
    #[serde(skip_serializing)]
    pub corpus_fingerprint: String,
    /// Local-only sidecar title enrichment. Never emitted in plugin reports.
    #[serde(skip_serializing)]
    pub session_titles: Vec<agent_vitals_domain::contracts::workflow::SessionTitle>,
}

/// 加载并校验 manifest 文件（含 slug == 目录名检查）。`--file` 模式下
/// 目录名检查以 manifest 文件自身目录为准。
pub fn load_manifest(manifest_path: &Path) -> Result<(PluginManifest, String), String> {
    let raw = std::fs::read(manifest_path)
        .map_err(|e| format!("manifest `{}` 不可读：{e}", manifest_path.display()))?;
    parse_manifest_bytes(manifest_path, &raw)
}

pub(crate) fn parse_manifest_bytes(manifest_path: &Path, raw: &[u8]) -> Result<(PluginManifest, String), String> {
    let value: Value = serde_json::from_slice(raw)
        .map_err(|e| format!("manifest `{}` 不是合法 JSON：{e}", manifest_path.display()))?;
    let manifest = generic_manifest::parse_manifest(value)
        .map_err(|e| format!("manifest 校验失败：{e}"))?;
    let dir_name = manifest_path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string());
    if dir_name.as_deref() != Some(manifest.slug.as_str()) {
        return Err(format!(
            "slug `{}` 与 manifest 所在目录名 `{}` 不一致（§3.1）",
            manifest.slug,
            dir_name.unwrap_or_default()
        ));
    }
    use sha2::Digest;
    let digest = sha2::Sha256::digest(raw);
    let revision: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok((manifest, revision))
}

fn dotted_get<'a>(record: &'a Value, path: &str) -> &'a Value {
    // 与 harnesses::generic::recipe::dotted_get 同语义（空路径短路）。
    if path.is_empty() {
        return &Value::Null;
    }
    let mut cur = record;
    for seg in path.split('.') {
        match cur.get(seg) {
            Some(v) => cur = v,
            None => return &Value::Null,
        }
    }
    cur
}

/// source_profile：声明形式 root 串的 sha256 前 8 hex（不含绝对路径，
/// §9.2）。root 声明形如 `~/...`，跨机器稳定。
fn source_profile_for_root(slug: &str, root_declared: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(format!("{slug}|{root_declared}").as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("harness-{hex}")
}

/// 候选行 → UsageFact 字段 map（§9.2 映射表）。**billing 锁在这里 stamp**：
/// `billing_mode=metered` + `pricing_basis=metered_estimate`，provider 证据
/// 不构成订阅证据（billing fallback 规则）。
/// 一次插件运行内不变的字段 map 组装上下文（避免 8 参函数，clippy 门）。
struct ThroatCtx<'a> {
    def: &'a RecipeDef,
    manifest: &'a PluginManifest,
    revision: &'a str,
    machine_namespace: &'a str,
}

fn candidate_to_fact_fields(
    ctx: &ThroatCtx,
    source_profile: &str,
    native_session_id: &str,
    candidate: &CandidateUsageV1,
    event_ts_raw: &str,
) -> Value {
    let (def, manifest, manifest_revision, machine_namespace) =
        (ctx.def, ctx.manifest, ctx.revision, ctx.machine_namespace);
    let mut m = serde_json::Map::new();
    m.insert("machine_namespace".into(), json!(machine_namespace));
    m.insert("harness".into(), json!(manifest.facts_harness()));
    m.insert("source_profile".into(), json!(source_profile));
    m.insert("native_session_id".into(), json!(native_session_id));
    m.insert("source_event_id".into(), json!(candidate.source_event_id));
    m.insert("observation_kind".into(), json!(def.observation_kind));
    m.insert("identity_basis".into(), json!("native"));
    m.insert("event_ts_utc".into(), json!(event_ts_raw));
    m.insert("event_tz_basis".into(), Value::Null);
    m.insert("time_basis".into(), json!("native"));
    m.insert(
        "source_usage_semantics".into(),
        json!(def.source_usage_semantics),
    );
    // provenance（§6.3）：manifest revision 进 source_revision；
    // adapter_version = recipe 代码版本（P0 与 recipe id 同源）。
    m.insert("source_revision".into(), json!(manifest_revision));
    m.insert("adapter_version".into(), json!(def.id));
    m.insert("model_raw".into(), json!(candidate.model_raw));
    m.insert(
        "provider_raw".into(),
        candidate
            .provider_raw
            .as_ref()
            .map(|s| json!(s))
            .unwrap_or(Value::Null),
    );
    m.insert(
        "provider_request_id".into(),
        candidate
            .provider_request_id
            .as_ref()
            .map(|s| json!(s))
            .unwrap_or(Value::Null),
    );
    for (key, v) in [
        ("uncached_input_tokens", candidate.uncached_input_tokens),
        ("cache_read_tokens", candidate.cache_read_tokens),
        ("cache_write_tokens", candidate.cache_write_tokens),
        ("output_tokens", candidate.output_tokens),
    ] {
        m.insert(key.into(), v.map(|n| json!(n)).unwrap_or(Value::Null));
    }
    // billing 锁（§6.1）：插件事实永远 metered estimate。
    m.insert("billing_source".into(), Value::Null);
    m.insert("billing_mode".into(), json!("metered"));
    m.insert("pricing_basis".into(), json!("metered_estimate"));
    m.insert(
        "evidence_basis".into(),
        if candidate.provider_raw.is_some() {
            json!("session-native")
        } else {
            json!("missing")
        },
    );
    Value::Object(m)
}

/// 对单个文件跑提取循环。返回 (报告, 该文件的事实行)。
fn extract_file(
    ctx: &ThroatCtx,
    source_profile: &str,
    rel_path: &str,
    abs_path: &Path,
    session_id: &str,
    content: &str,
) -> (PluginFileReport, Vec<Value>) {
    let (def, manifest) = (ctx.def, ctx.manifest);
    let mut report = PluginFileReport {
        rel_path: rel_path.to_string(),
        abs_path: abs_path.to_path_buf(),
        session_id: session_id.to_string(),
        ..Default::default()
    };
    let mut facts = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            report.invalid += 1;
            if report.invalid_problems.len() < 8 {
                let excerpt: String = line.chars().take(120).collect();
                report
                    .invalid_problems
                    .push(format!("bad_json: {excerpt}"));
            }
            continue;
        };
        // 拿原始时间串给 fact 的 event_ts_utc（Candidate 只留毫秒）。
        let ts_raw = dotted_get(
            &record,
            &generic_recipe::effective_path(def, manifest, generic_recipe::Slot::EventTs),
        )
        .as_str()
        .unwrap_or_default()
        .to_string();
        match generic_recipe::extract_line(def, manifest, &record) {
            LineVerdict::Emit(c) => {
                let fields = candidate_to_fact_fields(
                    ctx,
                    source_profile,
                    session_id,
                    &c,
                    &ts_raw,
                );
                // fact_id 在这里 stamp（§9.2：外部不可写）——之后 FactWriter /
                // SQL 侧的重复 build 是幂等的（身份相同 ⇒ id 相同）。
                match build_usage_fact(fields.as_object().expect("map")) {
                    Ok(built) => {
                        facts.push(built);
                        report.emitted += 1;
                    }
                    Err(problems) => {
                        report.invalid += 1;
                        if report.invalid_problems.len() < 8 {
                            report
                                .invalid_problems
                                .push(format!("contract: {}", problems.join("; ")));
                        }
                    }
                }
            }
            LineVerdict::Skip { reason } => {
                report.skipped += 1;
                let _ = reason;
            }
            LineVerdict::Invalid { code, excerpt } => {
                report.invalid += 1;
                if report.invalid_problems.len() < 8 {
                    report.invalid_problems.push(format!("{code}: {excerpt}"));
                }
            }
        }
    }
    if report.emitted == 0 && report.invalid == 0 {
        report.zero_target = true;
    }
    if report.emitted as u64 > manifest.max_rows_per_file {
        report.failed = true;
        report.problems.push(format!(
            "行数超限：{} > {}（§6.4 整文件失败，不提交部分事实）",
            report.emitted, manifest.max_rows_per_file
        ));
        facts.clear();
        report.emitted = 0;
    }
    (report, facts)
}

/// 主入口：manifest + 显式文件列表 → 完整运行报告。`files` 为空 = 按
/// manifest discovery 走（生产路径）；非空 = fixture/测试直供（文件名提取
/// session id，profile 用其父目录声明形式）。
pub fn run_plugin(
    manifest_path: &Path,
    files: &[PathBuf],
    machine_namespace: &str,
    home: &Path,
) -> Result<PluginRunReport, String> {
    let (manifest, revision) = load_manifest(manifest_path)?;
    run_manifest(manifest, revision, files, machine_namespace, home)
}

struct CapturedUnit {
    rel: String,
    abs: PathBuf,
    session_id: String,
    profile: String,
    content: Option<String>,
}

const MAX_FROZEN_CORPUS_BYTES: usize = 64 * 1024 * 1024;

fn decode_source_bytes(manifest: &PluginManifest, bytes: &[u8], path: &Path, limit: Option<usize>) -> Result<String, String> {
    let decoded = match manifest.compression {
        agent_vitals_harnesses::generic_manifest::SourceCompression::None => {
            if limit.is_some_and(|max| bytes.len() > max) { return Err("frozen preview corpus exceeds 64 MiB; use a bounded sample".into()); }
            bytes.to_vec()
        }
        agent_vitals_harnesses::generic_manifest::SourceCompression::Zstd => {
            if let Some(max) = limit {
                agent_vitals_harnesses::decode_zstd_multi_frame_limited(bytes, max)
                    .map_err(|error| match error {
                        agent_vitals_harnesses::ZstdDecodeError::LimitExceeded => "frozen preview corpus exceeds 64 MiB; use a bounded sample".to_string(),
                        agent_vitals_harnesses::ZstdDecodeError::InvalidData => format!("文件 `{}` zstd 解压失败", path.display()),
                    })?
            } else {
                agent_vitals_harnesses::decode_zstd_multi_frame(bytes)
                    .ok_or_else(|| format!("文件 `{}` zstd 解压失败", path.display()))?
            }
        }
    };
    String::from_utf8(decoded).map_err(|_| format!("文件 `{}` 不是 UTF-8", path.display()))
}

fn read_frozen_file(manifest: &PluginManifest, path: &Path, remaining: usize) -> Result<String, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("文件 `{}` 不可读：{e}", path.display()))?;
    let mut bytes = Vec::new();
    if manifest.compression == agent_vitals_harnesses::generic_manifest::SourceCompression::Zstd {
        // Compressed size can be larger or smaller than the remaining decoded
        // budget. Bound stored input independently, then enforce the real
        // corpus limit during streaming decompression.
        file.take((MAX_FROZEN_CORPUS_BYTES as u64) + 1).read_to_end(&mut bytes)
            .map_err(|e| format!("文件 `{}` 不可读：{e}", path.display()))?;
        if bytes.len() > MAX_FROZEN_CORPUS_BYTES {
            return Err("frozen preview compressed input exceeds 64 MiB".into());
        }
    } else {
        file.take((remaining as u64) + 1).read_to_end(&mut bytes)
            .map_err(|e| format!("文件 `{}` 不可读：{e}", path.display()))?;
        if bytes.len() > remaining {
            return Err("frozen preview corpus exceeds 64 MiB; use a bounded sample".into());
        }
    }
    decode_source_bytes(manifest, &bytes, path, Some(remaining))
}

fn capture_corpus(manifest: &PluginManifest, files: &[PathBuf], home: &Path, freeze: bool) -> Result<Vec<CapturedUnit>, String> {
    let mut units: Vec<(String, PathBuf, String, String)> = Vec::new();
    if files.is_empty() {
        let report = agent_vitals_harnesses::generic_discover::discover_files(manifest, home)
            .map_err(|e| format!("discovery 失败：{e}"))?;
        for f in &report.files {
            let root_declared = manifest
                .roots
                .iter()
                .find(|r| {
                    let expanded =
                        agent_vitals_harnesses::generic_discover::expand_tilde_home(r, home);
                    expanded
                        .canonicalize()
                        .map(|c| f.abs_path.starts_with(&c))
                        .unwrap_or(false)
                })
                .map(|s| s.as_str())
                .unwrap_or("");
            let profile = source_profile_for_root(&manifest.slug, root_declared);
            units.push((f.rel_path.clone(), f.abs_path.clone(), f.session_id.clone(), profile));
        }
    } else {
        for path in files {
            let abs = path.canonicalize().unwrap_or_else(|_| path.clone());
            let file_name = abs
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let Some(caps) = manifest.session_pattern.captures(&file_name) else {
                return Err(format!("文件 `{file_name}` 不匹配 session.pattern"));
            };
            let session_id = caps
                .name("id")
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            // fixture 模式 profile 固定（不依赖临时目录绝对路径）——
            // golden/parity 的逐字节跨机复现前提（验收发现 #3）。
            let profile = source_profile_for_root(&manifest.slug, "<fixture>");
            units.push((file_name, abs, session_id, profile));
        }
    }
    units.sort_by(|a, b| a.0.cmp(&b.0));
    let mut total = 0usize;
    units.into_iter().map(|(rel, abs, session_id, profile)| {
        let content = if freeze {
            let remaining = MAX_FROZEN_CORPUS_BYTES.saturating_sub(total);
            let value = read_frozen_file(manifest, &abs, remaining)?;
            total = total.checked_add(value.len()).ok_or("frozen preview corpus size overflow")?;
            if total > MAX_FROZEN_CORPUS_BYTES { return Err("frozen preview corpus exceeds 64 MiB; use a bounded sample".into()); }
            Some(value)
        } else { None };
        Ok(CapturedUnit { rel, abs, session_id, profile, content })
    }).collect()
}

fn run_manifest(
    manifest: PluginManifest,
    revision: String,
    files: &[PathBuf],
    machine_namespace: &str,
    home: &Path,
) -> Result<PluginRunReport, String> {
    let captured = capture_corpus(&manifest, files, home, false)?;
    run_captured_manifest(manifest, revision, &captured, machine_namespace)
}

fn run_captured_manifest(
    manifest: PluginManifest,
    revision: String,
    units: &[CapturedUnit],
    machine_namespace: &str,
) -> Result<PluginRunReport, String> {
    let def = generic_recipe::recipe_def(&manifest.recipe)
        .ok_or_else(|| format!("未知 recipe `{}`", manifest.recipe))?;
    generic_recipe::check_overrides(def, &manifest).map_err(|e| format!("overrides 校验失败：{e}"))?;

    let ctx = ThroatCtx {
        def,
        manifest: &manifest,
        revision: &revision,
        machine_namespace,
    };

    let mut out = PluginRunReport {
        slug: manifest.slug.clone(),
        harness: manifest.facts_harness(),
        recipe: def.id.to_string(),
        manifest_revision: revision.clone(),
        ..Default::default()
    };
    use sha2::Digest;
    let mut corpus_hash = sha2::Sha256::new();
    let mut ids_again = Vec::new();
    for value in ["manifest-corpus/v1", machine_namespace] {
        corpus_hash.update((value.len() as u64).to_be_bytes());
        corpus_hash.update(value.as_bytes());
    }
    for unit in units {
        let CapturedUnit { rel, abs, session_id, profile, content } = unit;
        let owned;
        let content = match content {
            Some(content) => content.as_str(),
            None => {
                let bytes = std::fs::read(abs).map_err(|e| format!("文件 `{}` 不可读：{e}", abs.display()))?;
                owned = decode_source_bytes(&manifest, &bytes, abs, None)?;
                &owned
            }
        };
        let (report, mut facts) = extract_file(
            &ctx,
            profile,
            rel,
            abs,
            session_id,
            content,
        );
        // Both replays use these exact bytes. Never reread a live log merely
        // to claim extractor determinism (tokens can change without ID drift).
        let (_, replay) = extract_file(&ctx, profile, rel, abs, session_id, content);
        ids_again.extend(replay.iter().filter_map(|fact|
            fact.get("fact_id").and_then(Value::as_str).map(String::from)));
        for value in [rel.as_bytes(), abs.as_os_str().as_encoded_bytes(), session_id.as_bytes(),
            profile.as_bytes(), content.as_bytes()] {
            corpus_hash.update((value.len() as u64).to_be_bytes());
            corpus_hash.update(value);
        }
        out.emitted += report.emitted;
        out.skipped += report.skipped;
        out.invalid += report.invalid;
        out.failed_files += usize::from(report.failed);
        out.corpus_has_emit |= report.emitted > 0;
        out.files.push(report);
        out.facts.append(&mut facts);
    }
    out.corpus_fingerprint = format!("{:x}", corpus_hash.finalize());

    // 汇总：日期范围 + 模型清单。
    let mut models = std::collections::BTreeSet::new();
    for f in &out.facts {
        let ms = f
            .get("event_ts_utc")
            .and_then(|t| t.as_str())
            .and_then(agent_vitals_domain::domain::budget::parse_iso)
            .map(|(s, _)| s.saturating_mul(1000));
        if let Some(ms) = ms {
            out.date_min_utc_ms = Some(out.date_min_utc_ms.map_or(ms, |m: i64| m.min(ms)));
            out.date_max_utc_ms = Some(out.date_max_utc_ms.map_or(ms, |m: i64| m.max(ms)));
        }
        if let Some(m) = f.get("model_raw").and_then(Value::as_str) {
            models.insert(m.to_string());
        }
    }
    out.models = models.into_iter().collect();

    // 跨 root 同 session 多 profile 警示（验收发现：JSONL/authority 双层
    // 分歧必须可见）。
    {
        let mut by_session: BTreeMap<&str, std::collections::BTreeSet<&str>> =
            BTreeMap::new();
        for (session, profile) in units.iter().map(|unit| (unit.session_id.as_str(), unit.profile.as_str())) {
            by_session.entry(session).or_default().insert(profile);
        }
        for (session, profiles) in &by_session {
            if profiles.len() > 1 {
                out.warnings.push(format!(
                    "session `{session}` 出现在 {} 个 source_profile 下（跨 root）——\
                     facts JSONL 按 profile 分行，authority 按 harness+session 身份去重合并",
                    profiles.len()
                ));
            }
        }
    }

    // fact_id 稳定性（§6.5）：提取是纯函数，重放两遍 id 序列必须一致。
    let ids_once: Vec<String> = out
        .facts
        .iter()
        .filter_map(|f| f.get("fact_id").and_then(Value::as_str).map(String::from))
        .collect();
    out.fact_id_stable = ids_once == ids_again;
    Ok(out)
}

/// Redacted local impact summary; identities and source contents stay internal.
#[derive(Debug, serde::Serialize)]
pub struct ManifestImpact {
    pub captured_files: usize,
    pub coverage: &'static str,
    pub previous_facts: usize,
    pub candidate_facts: usize,
    pub previous_emitted: usize,
    pub candidate_emitted: usize,
    pub previous_skipped: usize,
    pub candidate_skipped: usize,
    pub previous_invalid: usize,
    pub candidate_invalid: usize,
    pub changed_tokens: usize,
    pub changed_models: usize,
    pub changed_timestamps: usize,
    pub impact_sha256: String,
    #[serde(skip_serializing)]
    pub corpus_fingerprint: String,
}

/// Pure local preview: no authority writes and no source contents in its output.
/// Replayed reports must prove they captured the same corpus. Updates cannot
/// change identities implicitly; an explicit migration is a separate operation.
pub fn preview_manifest_impact(
    previous: Option<&PluginRunReport>,
    candidate: &PluginRunReport,
) -> Result<ManifestImpact, String> {
    validate_gate(candidate)?;
    if candidate.corpus_fingerprint.len() != 64 || !candidate.corpus_fingerprint.bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("preview requires a captured corpus fingerprint".into());
    }
    fn facts_by_id(report: &PluginRunReport) -> Result<BTreeMap<&str, &Value>, String> {
        let mut facts = BTreeMap::new();
        for fact in &report.facts {
            let id = fact.get("fact_id").and_then(Value::as_str).filter(|id| !id.is_empty())
                .ok_or("preview fact has no identity")?;
            if let Some(prior) = facts.insert(id, fact) {
                if prior != fact { return Err("preview contains conflicting duplicate identities".into()); }
            }
        }
        if facts.is_empty() { return Err("preview has no captured facts".into()); }
        Ok(facts)
    }
    let next = facts_by_id(candidate)?;
    let old = match previous {
        Some(previous) => {
            validate_gate(previous)?;
            if previous.corpus_fingerprint != candidate.corpus_fingerprint {
                return Err("preview input changed; recapture the same corpus before comparison".into());
            }
            if previous.harness != candidate.harness { return Err("preview harness identity drift".into()); }
            let facts = facts_by_id(previous)?;
            if !facts.keys().eq(next.keys()) { return Err("preview fact identity drift; explicit migration required".into()); }
            facts
        }
        None => BTreeMap::new(),
    };
    let mut impact = ManifestImpact {
        captured_files:candidate.files.len(), coverage:"captured-files-only",
        previous_facts:old.len(), candidate_facts:next.len(),
        previous_emitted:previous.map_or(0, |report| report.emitted), candidate_emitted:candidate.emitted,
        previous_skipped:previous.map_or(0, |report| report.skipped), candidate_skipped:candidate.skipped,
        previous_invalid:previous.map_or(0, |report| report.invalid), candidate_invalid:candidate.invalid,
        changed_tokens:0, changed_models:0, changed_timestamps:0, impact_sha256:String::new(),
        corpus_fingerprint:candidate.corpus_fingerprint.clone() };
    for (id, new) in &next {
        if let Some(prior) = old.get(id) {
            if ["uncached_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"]
                .iter().any(|key| prior.get(*key) != new.get(*key)) { impact.changed_tokens += 1; }
            if prior.get("model_raw") != new.get("model_raw") { impact.changed_models += 1; }
            if prior.get("event_ts_utc") != new.get("event_ts_utc") { impact.changed_timestamps += 1; }
        }
    }
    use sha2::Digest;
    let payload = json!({"schema":"manifest-impact/v1", "engine":env!("CARGO_PKG_VERSION"),
        "harness":candidate.harness, "corpus":candidate.corpus_fingerprint,
        "coverage":impact.coverage, "captured_files":impact.captured_files,
        "previous_emitted":impact.previous_emitted, "candidate_emitted":impact.candidate_emitted,
        "previous_skipped":impact.previous_skipped, "candidate_skipped":impact.candidate_skipped,
        "previous_invalid":impact.previous_invalid, "candidate_invalid":impact.candidate_invalid,
        "previous_recipe":previous.map(|report| report.recipe.as_str()), "candidate_recipe":candidate.recipe,
        "previous_revision":previous.map(|report| report.manifest_revision.as_str()),
        "candidate_revision":candidate.manifest_revision, "old":old, "new":next});
    impact.impact_sha256 = format!("{:x}", sha2::Sha256::digest(
        super::extension_installer::canonical_value(&payload).to_string().as_bytes()));
    Ok(impact)
}

/// Replay one immutable recipe over a bounded, frozen corpus.
pub(crate) fn frozen_manifest_replay(manifest: PluginManifest, revision: String,
    files: &[PathBuf], machine_namespace: &str, home: &Path) -> Result<PluginRunReport, String> {
    if machine_namespace.is_empty() { return Err("replay requires machine namespace".into()); }
    let captured = capture_corpus(&manifest, files, home, true)?;
    let report = run_captured_manifest(manifest, revision, &captured, machine_namespace)?;
    validate_gate(&report)?;
    Ok(report)
}

/// Capture each selected source once, then run both recipes over those bytes.
/// A change to discovery or session declarations needs an explicit identity
/// migration; otherwise reusing candidate-derived source keys would hide it.
pub fn preview_captured_manifest_change(
    previous: Option<(PluginManifest, String)>,
    candidate: (PluginManifest, String),
    files: &[PathBuf],
    machine_namespace: &str,
    home: &Path,
) -> Result<ManifestImpact, String> {
    if machine_namespace.is_empty() { return Err("preview requires machine namespace".into()); }
    let (candidate_manifest, candidate_revision) = candidate;
    if let Some((prior, _)) = &previous {
        if prior.slug != candidate_manifest.slug || prior.roots != candidate_manifest.roots
            || prior.include != candidate_manifest.include
            || prior.session_pattern.as_str() != candidate_manifest.session_pattern.as_str() {
            return Err("preview source identity declaration drift; explicit migration required".into());
        }
    }
    let captured = capture_corpus(&candidate_manifest, files, home, true)?;
    let prior = previous.map(|(manifest, revision)|
        run_captured_manifest(manifest, revision, &captured, machine_namespace)).transpose()?;
    let candidate = run_captured_manifest(candidate_manifest, candidate_revision, &captured, machine_namespace)?;
    preview_manifest_impact(prior.as_ref(), &candidate)
}

/// validate 的判定门（§6.5）：返回 Ok(()) 或可操作拒绝原因。
pub fn validate_gate(report: &PluginRunReport) -> Result<(), String> {
    if !report.fact_id_stable {
        return Err("fact_id 稳定性检查失败：同文件重放两遍 id 序列不一致——\
                    检查 event_key 是否稳定（§6.5）"
            .to_string());
    }
    if report.failed_files > 0 {
        return Err(format!(
            "{} 个文件行数超限整文件失败（§6.4）——调低 limits 或修 recipe",
            report.failed_files
        ));
    }
    if !report.corpus_has_emit {
        return Err(
            "首装 format guard：整个 corpus 零 emit（§4.3）——include 或 recipe \
             discriminator 与数据不匹配"
                .to_string(),
        );
    }
    Ok(())
}

/// ingest --write：validate 门 → authority → facts JSONL 镜像。
/// authority 失败不写镜像；镜像失败可重跑修复，两阶段各自 exactly-once。
#[cfg(test)]
fn plugin_ingest_write(
    manifest_path: &Path,
    machine_namespace: &str,
    data_home: &Path,
    home: &Path,
) -> Result<Value, String> {
    let (manifest, _) = load_manifest(manifest_path)?;
    let title_adapter = manifest.session_title_adapter;
    let mut report = run_plugin(manifest_path, &[], machine_namespace, home)?;
    let session_ids = report.facts.iter()
        .filter_map(|fact| fact.get("native_session_id").and_then(Value::as_str))
        .map(str::to_string).collect::<Vec<_>>();
    report.session_titles = agent_vitals_harnesses::sources::session_harnesses::plugin_session_titles(title_adapter, home, &session_ids);
    validate_gate(&report).map_err(|e| format!("validate 拒绝安装：{e}"))?;
    let facts = std::mem::take(&mut report.facts);
    let authority = open_authority_and_write(data_home, &report, &facts)
        .map_err(|e| format!("authority 写入失败（未写 facts JSONL 镜像）：{e}"))?;
    let ingest = crate::ingest_service::ingest_facts(data_home, &facts)
        .map_err(|e| format!("facts JSONL 镜像失败（authority 已提交，重跑可修复）：{e}"))?;
    let payload = json!({
        "mode": "ingest",
        "report": serde_json::to_value(&report).unwrap_or(Value::Null),
        "ingest": ingest,
        "authority": authority,
    });
    Ok(payload)
}

#[cfg(test)]
fn open_authority_and_write(
    data_home: &Path,
    report: &PluginRunReport,
    facts: &[Value],
) -> Result<Value, String> {
    open_authority_and_write_extension(data_home, report, facts, None)
}

fn open_authority_and_write_extension(
    data_home: &Path,
    report: &PluginRunReport,
    facts: &[Value],
    extension: Option<&agent_vitals_data::fact_writer_sql::ExtensionFactContext>,
) -> Result<Value, String> {
    let authority_path = agent_vitals_data::authority::default_authority_path(data_home);
    let now = crate::clock::now_ms();
    let db = agent_vitals_data::authority::AuthorityDb::open(&authority_path, now)
        .map_err(|e| format!("authority open: {e}"))?;
    let no_overrides: std::collections::HashMap<String, crate::source_graph::SourceCheckpointOverride> = std::collections::HashMap::new();
    let outcome = crate::sql_sync::write_flat_facts_with_sources_and_extension(
        &db,
        &report.harness,
        // write_flat_facts_with_sources 需要 machine_namespace——从事实行取。
        facts
            .first()
            .and_then(|f| f.get("machine_namespace"))
            .and_then(Value::as_str)
            .unwrap_or(""),
        // sources：以事实行为准构建（path, (size, mtime_ns)）由调用方给——
        // P0 简化：文件元数据从报告文件列表反查。
        &source_entries(report),
        &no_overrides,
        facts,
        &[],
        // session_excerpts：行为面素材，插件执行环境不产（行为须官方，spec §1）。
        &[],
        // 仅消费由 adapter 明确提供的本机侧车标题；不从 usage/prompt 猜标题。
        &report.session_titles,
        None,
        None,
        now,
        extension,
    )
    .map_err(|e| format!("authority write: {e}"))?;
    // A successful transaction can still reject individual inputs. Do not mirror
    // the unfiltered input batch as if every row had been accepted by authority.
    if outcome.rejected > 0 || !outcome.errors.is_empty() {
        return Err(format!(
            "authority 未完整接受输入（accepted rows 已提交）：rejected={}, errors={:?}",
            outcome.rejected, outcome.errors,
        ));
    }
    Ok(json!({
        "files_synced": outcome.files_synced,
        "files_skipped": outcome.files_skipped,
        "inserted": outcome.inserted,
        "duplicate": outcome.duplicate,
        "rejected": outcome.rejected,
        "errors": outcome.errors,
    }))
}

fn source_entries(report: &PluginRunReport) -> Vec<(PathBuf, (u64, u64))> {
    let mut entries = Vec::new();
    for f in &report.files {
        if let Ok(meta) = std::fs::metadata(&f.abs_path) {
            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            entries.push((f.abs_path.clone(), (size, mtime)));
        }
    }
    entries
}

/// 周期再摄取：仅消费 authority 激活的不可变 manifest，整轮固定 generation。
/// `.d` 是候选输入，不自动安装。exactly-once 由事实层
/// fact_id 幂等兜底（重放 = duplicate 计数，不双计）。单 manifest 失败
/// 隔离为 Err 条目（坏 manifest 不得拖垮整轮 sync，tick 兜底语义）。
/// 返回 (slug, 摘要 or 错误) 列表供调用方记入 report.errors/log。
pub fn ingest_installed(
    ns: &str,
    data_home: &Path,
    user_home: &Path,
) -> Vec<(String, Result<Value, String>)> {
    match ingest_active_generation(ns, data_home, user_home) {
        Ok(out) => out,
        Err(error) => vec![("extension-registry".into(), Err(error))],
    }
}

type InstalledIngestResults = Vec<(String, Result<Value, String>)>;

fn ingest_active_generation(
    ns: &str,
    data_home: &Path,
    user_home: &Path,
) -> Result<InstalledIngestResults, String> {
    ingest_active_generation_after_pin(ns, data_home, user_home, || {})
}

fn ingest_active_generation_after_pin(
    ns: &str,
    data_home: &Path,
    user_home: &Path,
    after_pin: impl FnOnce(),
) -> Result<InstalledIngestResults, String> {
    let authority_path = agent_vitals_data::authority::default_authority_path(data_home);
    if !authority_path.exists() { return Ok(unactivated_candidates(data_home, &[])); }
    let db = agent_vitals_data::authority::AuthorityDb::open(&authority_path, crate::clock::now_ms())
        .map_err(|e| format!("extension authority: {e}"))?;
    // One SELECT snapshot pins the whole harness set, not a fresh pointer per harness.
    let mut stmt = db.conn().prepare(
        "SELECT a.generation,s.slot_id,s.revision_id,r.content_sha256
         FROM extension_active a JOIN extension_activation_slots s ON s.generation=a.generation
         JOIN extension_revisions r ON r.revision_id=s.revision_id
         WHERE s.slot_type='harness_manifest' ORDER BY s.slot_id"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?,
        r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    drop(db);
    after_pin();
    if rows.is_empty() { return Ok(unactivated_candidates(data_home, &[])); }
    let active_slugs: Vec<String> = rows.iter().map(|row| row.1.clone()).collect();
    let store = agent_vitals_runtime_core::core::extension_objects::ObjectStore::open(
        &data_home.join("state/extensions"))
        .map_err(|e| format!("extension objects: {e}"))?;
    let mut out = unactivated_candidates(data_home, &active_slugs);
    for (generation, slug, revision_id, hash) in rows {
        let result = (|| {
            let harness = format!("harness:{slug}");
            let _lease = crate::lease::acquire_blocking(
                &crate::source_controls::harness_data_lock_path(data_home, &harness)?,
                "manifest-ingest", 600_000, 10_000,
            ).map_err(|e| format!("manifest lease: {e}"))?;
            if crate::source_controls::excluded_harnesses(data_home)?.contains(&harness) {
                return Ok(json!({"mode":"ingest", "harness":harness, "skipped":"source_excluded",
                    "generation":generation}));
            }
            let value = store.load(&hash).map_err(|e| format!("active object: {e}"))?;
            let manifest = generic_manifest::parse_manifest(value).map_err(|e| e.to_string())?;
            if manifest.slug != slug { return Err("active manifest slug does not match slot".into()); }
            let title_adapter = manifest.session_title_adapter;
            super::extension_installer::ensure_compiled_sources_exclusive(&manifest, user_home, data_home)?;
            let mut report = run_manifest(manifest, hash[..16].to_string(), &[], ns, user_home)?;
            let session_ids = report.facts.iter()
                .filter_map(|fact| fact.get("native_session_id").and_then(Value::as_str))
                .map(str::to_string).collect::<Vec<_>>();
            report.session_titles = agent_vitals_harnesses::sources::session_harnesses::plugin_session_titles(title_adapter, user_home, &session_ids);
            validate_gate(&report)?;
            let facts = std::mem::take(&mut report.facts);
            let context = agent_vitals_data::fact_writer_sql::ExtensionFactContext {
                generation, revision_id, engine_version: env!("CARGO_PKG_VERSION").to_string(),
            };
            let authority = open_authority_and_write_extension(data_home, &report, &facts, Some(&context))?;
            let ingest = crate::ingest_service::ingest_facts(data_home, &facts)
                .map_err(|e| format!("facts mirror failed (authority committed): {e}"))?;
            Ok(json!({"mode":"ingest", "report":report, "ingest":ingest, "authority":authority,
                "generation":generation}))
        })();
        out.push((slug, result));
    }
    Ok(out)
}

fn unactivated_candidates(data_home: &Path, active: &[String]) -> Vec<(String, Result<Value, String>)> {
    let (harnesses, errors) = scan_plugin_harnesses(data_home);
    let mut out: Vec<_> = harnesses.into_iter().filter(|harness| !active.contains(&harness.slug))
        .map(|harness| (harness.slug, Err("manifest is an unactivated candidate; explicit preview and activation required".into())))
        .collect();
    out.extend(errors.into_iter().filter(|error| {
        !active.iter().any(|slug| error.manifest_path == data_home.join("harnesses.d").join(slug).join("manifest.json"))
    }).map(|error| (error.manifest_path.to_string_lossy().to_string(), Err(error.problem))));
    out
}

/// plugin-list 的负载：registry 内容 + 坏 manifest 报错。
pub fn plugin_list(data_home: &Path) -> Value {
    let (harnesses, errors) = scan_plugin_harnesses(data_home);
    let harness_values: Vec<Value> = harnesses
        .iter()
        .map(|h| {
            json!({
                "slug": h.slug,
                "display_name": h.display_name,
                "recipe": h.recipe,
                "harness": format!("harness:{}", h.slug),
                "manifest_revision": h.manifest_sha256,
                "manifest_path": h.manifest_path.to_string_lossy(),
            })
        })
        .collect();
    let error_values: Vec<Value> = errors
        .iter()
        .map(|e| {
            json!({
                "manifest_path": e.manifest_path.to_string_lossy(),
                "problem": e.problem,
            })
        })
        .collect();
    json!({ "harnesses": harness_values, "errors": error_values })
}

/// 保留 harness→PluginHarness 的有序视图给调用方（BTreeMap 键序稳定）。
pub fn plugin_harnesses_by_slug(data_home: &Path) -> BTreeMap<String, PluginHarness> {
    scan_plugin_harnesses(data_home)
        .0
        .into_iter()
        .map(|h| (h.slug.clone(), h))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "av-plugin-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 布一个最小 zcode 形状的插件执行环境：manifest 进 harnesses.d/zcode/，
    /// 两份 rollout fixture。
    fn setup_harness(home: &Path) -> (PathBuf, Vec<PathBuf>) {
        let manifest_dir = home.join("harnesses.d/zcode");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        let manifest = r#"{
            "manifest_version": 1,
            "slug": "zcode",
            "display": { "name": "ZCode" },
            "discovery": { "roots": ["~/data"], "include": ["model-io-sess_*.jsonl"] },
            "source": { "format": "jsonl" },
            "session": { "from": "filename", "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$" },
            "recipe": "request-usage-anthropic-v1",
            "session_title_adapter": "zcode_sqlite_session_v1",
            "overrides": {
                "event_ts": "completedAt",
                "model_raw": "model.modelId",
                "provider_raw": "model.providerId",
                "uncached_input_tokens": "response.providerMetadata.anthropic.usage.input_tokens",
                "cache_read_tokens": "response.providerMetadata.anthropic.usage.cache_read_input_tokens",
                "output_tokens": "response.providerMetadata.anthropic.usage.output_tokens",
                "provider_request_id": "requestId"
            },
            "event_key": { "paths": ["requestId", "attempt"] },
            "billing": { "policy": "lock:metered_estimate" }
        }"#;
        let manifest_path = manifest_dir.join("manifest.json");
        std::fs::write(&manifest_path, manifest).unwrap();

        let data = home.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let row = |id: &str, attempt: i64, input: i64| {
            serde_json::json!({
                "requestId": id, "attempt": attempt,
                "completedAt": "2026-09-19T15:18:41.337Z",
                "model": { "modelId": "GLM-5.3", "providerId": "builtin:bigmodel-coding-plan" },
                "response": {
                    "usage": { "inputTokens": input + 5 },
                    "providerMetadata": { "anthropic": { "usage": {
                        "input_tokens": input, "cache_read_input_tokens": 5,
                        "output_tokens": 99
                    }}}
                }
            })
            .to_string()
        };
        let f1 = data.join("model-io-sess_aaa.jsonl");
        std::fs::write(&f1, format!("{}\n{}\n", row("r1", 1, 100), row("r2", 1, 200))).unwrap();
        let f2 = data.join("model-io-sess_bbb.jsonl");
        std::fs::write(&f2, format!("{}\n", row("r3", 1, 300))).unwrap();
        (manifest_path, vec![f1, f2])
    }

    #[test]
    fn local_impact_preview_counts_changes_without_writes_or_raw_output() {
        let home = tmp_home("impact-counts");
        let (manifest, files) = setup_harness(&home);
        let old = run_plugin(&manifest, &files, "m1", &home).unwrap();
        let mut candidate = run_plugin(&manifest, &files, "m1", &home).unwrap();
        let unchanged = preview_manifest_impact(Some(&old), &candidate).unwrap();
        assert_eq!((unchanged.previous_facts, unchanged.candidate_facts), (3, 3));
        assert_eq!(unchanged.captured_files, 2);
        assert_eq!(unchanged.coverage, "captured-files-only");
        assert_eq!((unchanged.previous_emitted, unchanged.candidate_emitted), (old.emitted, candidate.emitted));
        assert_eq!((unchanged.previous_skipped, unchanged.candidate_skipped), (old.skipped, candidate.skipped));
        assert_eq!((unchanged.previous_invalid, unchanged.candidate_invalid), (old.invalid, candidate.invalid));
        assert_eq!((unchanged.changed_tokens, unchanged.changed_models, unchanged.changed_timestamps), (0, 0, 0));
        assert_eq!(unchanged.impact_sha256,
            preview_manifest_impact(Some(&old), &candidate).unwrap().impact_sha256);
        candidate.skipped += 1;
        assert_ne!(unchanged.impact_sha256,
            preview_manifest_impact(Some(&old), &candidate).unwrap().impact_sha256);
        candidate.skipped -= 1;
        candidate.files.pop();
        assert_ne!(unchanged.impact_sha256,
            preview_manifest_impact(Some(&old), &candidate).unwrap().impact_sha256);
        candidate = run_plugin(&manifest, &files, "m1", &home).unwrap();
        candidate.facts[0]["uncached_input_tokens"] = json!(101);
        candidate.facts[0]["cache_read_tokens"] = json!(6);
        candidate.facts[0]["cache_write_tokens"] = json!(7);
        candidate.facts[0]["output_tokens"] = json!(100);
        candidate.facts[1]["model_raw"] = json!("private-model-marker");
        candidate.facts[2]["event_ts_utc"] = json!("2026-09-20T15:18:41.337Z");
        let changed = preview_manifest_impact(Some(&old), &candidate).unwrap();
        assert_eq!((changed.changed_tokens, changed.changed_models, changed.changed_timestamps), (1, 1, 1));
        assert_ne!(unchanged.impact_sha256, changed.impact_sha256);
        let output = serde_json::to_string(&changed).unwrap();
        for fact in &candidate.facts {
            assert!(!output.contains(fact["fact_id"].as_str().unwrap()));
        }
        assert!(!output.contains("private-model-marker"));
        assert!(!output.contains("2026-09-20"));
        assert!(!output.contains(&home.to_string_lossy().to_string()));
        assert!(!output.contains(&candidate.corpus_fingerprint));
        assert!(!agent_vitals_data::authority::default_authority_path(&home).exists());
        assert!(!home.join("facts").exists());
        let first_install = preview_manifest_impact(None, &candidate).unwrap();
        assert_eq!((first_install.previous_facts, first_install.candidate_facts), (0, 3));
        assert_eq!((first_install.previous_emitted, first_install.previous_skipped, first_install.previous_invalid), (0, 0, 0));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn local_impact_preview_rejects_scope_harness_and_identity_drift() {
        let home = tmp_home("impact-drift");
        let (manifest, files) = setup_harness(&home);
        let old = run_plugin(&manifest, &files, "m1", &home).unwrap();
        let mut candidate = run_plugin(&manifest, &files, "m1", &home).unwrap();
        candidate.corpus_fingerprint = "a".repeat(64);
        assert!(preview_manifest_impact(Some(&old), &candidate).unwrap_err().contains("input changed"));
        candidate.corpus_fingerprint = old.corpus_fingerprint.clone();
        candidate.harness = "harness:other".into();
        assert!(preview_manifest_impact(Some(&old), &candidate).unwrap_err().contains("harness identity drift"));
        candidate.harness = old.harness.clone();
        candidate.facts[0]["fact_id"] = json!("private-drift-id");
        let error = preview_manifest_impact(Some(&old), &candidate).unwrap_err();
        assert!(error.contains("fact identity drift"));
        assert!(!error.contains("private-drift-id"));
        candidate.facts[0] = old.facts[0].clone();
        candidate.facts.pop();
        assert!(preview_manifest_impact(Some(&old), &candidate).unwrap_err().contains("fact identity drift"));
        candidate.corpus_fingerprint = "bad".into();
        assert!(preview_manifest_impact(None, &candidate).unwrap_err().contains("fingerprint"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn local_impact_preview_deduplicates_equal_facts_and_rejects_conflicts() {
        let home = tmp_home("impact-duplicates");
        let (manifest, files) = setup_harness(&home);
        let mut old = run_plugin(&manifest, &files, "m1", &home).unwrap();
        let mut candidate = run_plugin(&manifest, &files, "m1", &home).unwrap();
        candidate.facts.push(candidate.facts[0].clone());
        let impact = preview_manifest_impact(Some(&old), &candidate).unwrap();
        assert_eq!(impact.candidate_facts, 3);
        candidate.facts.last_mut().unwrap()["output_tokens"] = json!(12345);
        assert!(preview_manifest_impact(Some(&old), &candidate).unwrap_err().contains("conflicting duplicate"));
        candidate.facts.pop();
        let mut conflict = old.facts[0].clone();
        conflict["output_tokens"] = json!(12345);
        old.facts.push(conflict);
        assert!(preview_manifest_impact(Some(&old), &candidate).unwrap_err().contains("conflicting duplicate"));
        old.facts.pop();
        candidate.facts[0].as_object_mut().unwrap().remove("fact_id");
        assert!(preview_manifest_impact(Some(&old), &candidate).unwrap_err().contains("no identity"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn corpus_fingerprint_binds_content_even_when_fact_ids_do_not_change() {
        let home = tmp_home("corpus-content");
        let (manifest, files) = setup_harness(&home);
        let before = run_plugin(&manifest, &files, "m1", &home).unwrap();
        let repeated = run_plugin(&manifest, &files, "m1", &home).unwrap();
        assert_eq!(before.corpus_fingerprint, repeated.corpus_fingerprint);
        assert_eq!(before.corpus_fingerprint.len(), 64);
        assert!(before.corpus_fingerprint.bytes().all(|b| b.is_ascii_hexdigit()));

        let content = std::fs::read_to_string(&files[0]).unwrap();
        let mut rows: Vec<Value> = content.lines().map(|line|
            serde_json::from_str(line).unwrap()).collect();
        rows[0]["response"]["providerMetadata"]["anthropic"]["usage"]["input_tokens"] = json!(101);
        let changed = rows.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(&files[0], changed).unwrap();
        let after = run_plugin(&manifest, &files, "m1", &home).unwrap();
        let ids = |report: &PluginRunReport| report.facts.iter()
            .map(|fact| fact["fact_id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(ids(&before), ids(&after), "token change must preserve event identity");
        assert_eq!(after.facts[0]["uncached_input_tokens"], 101);
        assert!(before.fact_id_stable && after.fact_id_stable);
        assert_ne!(before.corpus_fingerprint, after.corpus_fingerprint);
        let serialized = serde_json::to_string(&after).unwrap();
        assert!(!serialized.contains("corpus_fingerprint"));
        assert!(!serialized.contains(&after.corpus_fingerprint));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn captured_corpus_is_reused_for_old_and_candidate_after_source_changes() {
        let home = tmp_home("shared-capture");
        let (manifest_path, files) = setup_harness(&home);
        let (manifest, revision) = load_manifest(&manifest_path).unwrap();
        let captured = capture_corpus(&manifest, &files, &home, true).unwrap();
        let (previous_manifest, previous_revision) = load_manifest(&manifest_path).unwrap();
        let old = run_captured_manifest(previous_manifest, previous_revision, &captured, "m1").unwrap();
        std::fs::write(&files[0], "changed after capture\n").unwrap();
        let candidate = run_captured_manifest(manifest, revision, &captured, "m1").unwrap();
        assert_eq!(old.corpus_fingerprint, candidate.corpus_fingerprint);
        assert_eq!(old.facts, candidate.facts);
        assert_eq!(preview_manifest_impact(Some(&old), &candidate).unwrap().changed_tokens, 0);
        let live = run_plugin(&manifest_path, &files, "m1", &home).unwrap();
        assert_ne!(candidate.corpus_fingerprint, live.corpus_fingerprint);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn frozen_reader_honors_remaining_bytes_before_decoding() {
        let home = tmp_home("bounded-capture");
        let (manifest_path, _) = setup_harness(&home);
        let (manifest, _) = load_manifest(&manifest_path).unwrap();
        let path = home.join("source.jsonl");
        std::fs::write(&path, "abcd").unwrap();
        assert_eq!(read_frozen_file(&manifest, &path, 4).unwrap(), "abcd");
        assert!(read_frozen_file(&manifest, &path, 3).unwrap_err().contains("64 MiB"));
        std::fs::write(&path, "").unwrap();
        assert_eq!(read_frozen_file(&manifest, &path, 0).unwrap(), "");
        std::fs::write(&path, "x").unwrap();
        assert!(read_frozen_file(&manifest, &path, 0).unwrap_err().contains("64 MiB"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn shared_preview_rejects_source_identity_declaration_changes() {
        let home = tmp_home("declaration-drift");
        let (manifest_path, files) = setup_harness(&home);
        let previous = load_manifest(&manifest_path).unwrap();
        let candidate = load_manifest(&manifest_path).unwrap();
        let impact = preview_captured_manifest_change(Some(previous), candidate,
            &files, "m1", &home).unwrap();
        assert_eq!((impact.previous_facts, impact.candidate_facts), (3, 3));
        let (mut previous, revision) = load_manifest(&manifest_path).unwrap();
        previous.roots.push("~/different-root".into());
        let error = preview_captured_manifest_change(Some((previous, revision)),
            load_manifest(&manifest_path).unwrap(), &files, "m1", &home).unwrap_err();
        assert!(error.contains("source identity declaration drift"));
        let (mut previous, revision) = load_manifest(&manifest_path).unwrap();
        previous.include.push("other/**".into());
        assert!(preview_captured_manifest_change(Some((previous, revision)),
            load_manifest(&manifest_path).unwrap(), &files, "m1", &home)
            .unwrap_err().contains("source identity declaration drift"));
        let (mut previous, revision) = load_manifest(&manifest_path).unwrap();
        previous.session_pattern = "^different-(?P<id>[^/]+)\\.jsonl$".parse().unwrap();
        assert!(preview_captured_manifest_change(Some((previous, revision)),
            load_manifest(&manifest_path).unwrap(), &files, "m1", &home)
            .unwrap_err().contains("source identity declaration drift"));
        let (mut previous, revision) = load_manifest(&manifest_path).unwrap();
        previous.slug = "other".into();
        assert!(preview_captured_manifest_change(Some((previous, revision)),
            load_manifest(&manifest_path).unwrap(), &files, "m1", &home)
            .unwrap_err().contains("source identity declaration drift"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn corpus_fingerprint_binds_source_membership_and_namespace() {
        let home = tmp_home("corpus-membership");
        let (manifest, files) = setup_harness(&home);
        let all = run_plugin(&manifest, &files, "m1", &home).unwrap();
        let subset = run_plugin(&manifest, &files[..1], "m1", &home).unwrap();
        assert_ne!(all.corpus_fingerprint, subset.corpus_fingerprint);
        let other_namespace = run_plugin(&manifest, &files, "m2", &home).unwrap();
        assert_ne!(all.corpus_fingerprint, other_namespace.corpus_fingerprint);
        // Different explicit-list order describes the same sorted source set.
        let reversed = run_plugin(&manifest, &[files[1].clone(), files[0].clone()], "m1", &home).unwrap();
        assert_eq!(all.corpus_fingerprint, reversed.corpus_fingerprint);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn run_plugin_emits_facts_with_billing_lock_and_identity() {
        let home = tmp_home("emit");
        let (manifest, files) = setup_harness(&home);
        let report = run_plugin(&manifest, &files, "m1", &home).unwrap();
        assert_eq!(report.emitted, 3);
        assert_eq!(report.skipped, 0);
        assert_eq!(report.invalid, 0);
        assert!(report.fact_id_stable);
        assert!(report.corpus_has_emit);
        assert_eq!(report.models, ["GLM-5.3"]);
        assert_eq!(report.harness, "harness:zcode");
        let f = &report.facts[0];
        assert_eq!(f["harness"], "harness:zcode");
        assert_eq!(f["billing_mode"], "metered", "计价锁（§6.1）");
        assert_eq!(f["pricing_basis"], "metered_estimate");
        assert_eq!(f["machine_namespace"], "m1");
        assert_eq!(f["native_session_id"], "aaa");
        assert_eq!(f["uncached_input_tokens"], 100);
        assert_eq!(f["cache_read_tokens"], 5);
        let fid = f["fact_id"].as_str().unwrap();
        assert!(fid.starts_with("uf1-") && fid.len() == 20, "fact_id 已 stamp：{fid}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn zero_corpus_emit_is_refused_by_gate() {
        let home = tmp_home("zeroguard");
        let (manifest, _files) = setup_harness(&home);
        let empty = home.join("data/model-io-sess_empty.jsonl");
        std::fs::write(&empty, "{\"requestId\":\"x\",\"attempt\":1}\n").unwrap();
        let report = run_plugin(&manifest, &[empty], "m1", &home).unwrap();
        let err = validate_gate(&report).unwrap_err();
        assert!(err.contains("零 emit"), "{err}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn bad_manifest_dir_name_is_refused() {
        let home = tmp_home("dirname");
        let (manifest, _files) = setup_harness(&home);
        let wrong = home.join("harnesses.d/other.json");
        std::fs::copy(&manifest, &wrong).unwrap();
        let e = run_plugin(&wrong, &[], "m1", &home).unwrap_err();
        assert!(e.contains("目录名"), "{e}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn installed_ingest_uses_active_object_and_links_provenance() {
        use agent_vitals_data::extension_authority::*;
        use agent_vitals_runtime_core::core::extension_objects::ObjectStore;
        use sha2::Digest;
        let home = tmp_home("active-ingest");
        let data_home = home.join("data-home");
        let (manifest, _files) = setup_harness(&home);
        let root = data_home.join("state/extensions");
        std::fs::create_dir_all(&root).unwrap();
        let store = ObjectStore::open(&root).unwrap();
        let raw = std::fs::read(&manifest).unwrap();
        let candidate = data_home.join("harnesses.d/zcode/manifest.json");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, &raw).unwrap();
        let hash = format!("{:x}", sha2::Sha256::digest(&raw));
        let staging = store.stage(&raw).unwrap();
        store.install(Path::new(&staging), &hash).unwrap();
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&data_home), 1).unwrap();
        let revision = ExtensionRevision { revision_id:"local-zcode-1".into(),
            slot_type:"harness_manifest".into(), slot_id:"zcode".into(), content_sha256:hash.clone(),
            origin:RevisionOrigin::Local, schema_version:1, capabilities:json!({}), installed_at_ms:1 };
        let slots = std::collections::BTreeMap::from([
            (("harness_manifest".into(), "zcode".into()), revision.revision_id.clone())]);
        activate(db.conn(), 0, &[revision], &slots, &"b".repeat(64), ActivationAction::Activate, 1).unwrap();
        // The mutable candidate may change after activation; it is not consumed.
        std::fs::write(&candidate, "not JSON anymore").unwrap();
        let results = ingest_active_generation_after_pin("m1", &data_home, &home, || {
            // Simulate uninstall after the SELECT: this run must keep generation 1.
            activate(db.conn(), 1, &[], &std::collections::BTreeMap::new(),
                &"c".repeat(64), ActivationAction::Uninstall, 2).unwrap();
        }).unwrap();
        assert_eq!(results.len(), 1);
        let payload = results[0].1.as_ref().unwrap();
        assert_eq!(payload["generation"], 1);
        assert_eq!(payload["authority"]["inserted"], 3);
        let links: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM extension_fact_provenance WHERE generation=1 AND revision_id='local-zcode-1'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(links, 3);
        activate(db.conn(), 2, &[], &slots, &"d".repeat(64), ActivationAction::Rollback, 3).unwrap();
        let replay = ingest_installed("m1", &data_home, &home);
        assert_eq!(replay[0].1.as_ref().unwrap()["ingest"]["harnesses"][0]["appended"], 0);
        crate::source_controls::set_harness_excluded(&data_home, "harness:zcode", true).unwrap();
        let stopped = ingest_installed("m1", &data_home, &home);
        assert_eq!(stopped[0].1.as_ref().unwrap()["skipped"], "source_excluded");
        crate::source_controls::set_harness_excluded(&data_home, "harness:zcode", false).unwrap();
        // Corruption must fail closed, even if a mutable candidate is available.
        std::fs::write(&candidate, &raw).unwrap();
        std::fs::write(root.join("objects").join(&hash).join("payload.json"), "{}").unwrap();
        let broken = ingest_installed("m1", &data_home, &home);
        assert!(broken[0].1.as_ref().unwrap_err().contains("active object"));
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM usage_facts", [],
            |r| r.get::<_, i64>(0)).unwrap(), 3);
        drop(db);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn mutable_candidate_is_not_automatically_activated() {
        let home = tmp_home("candidate-only");
        let data_home = home.join("data-home");
        let (manifest, _) = setup_harness(&home);
        std::fs::create_dir_all(&data_home).unwrap();
        let candidate = data_home.join("harnesses.d/zcode");
        std::fs::create_dir_all(&candidate).unwrap();
        std::fs::copy(manifest, candidate.join("manifest.json")).unwrap();
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&data_home), 1).unwrap();
        let result = ingest_installed("m1", &data_home, &home);
        assert_eq!(result.len(), 1);
        assert!(result[0].1.as_ref().unwrap_err().contains("unactivated candidate"));
        assert!(!data_home.join("facts/harness-zcode.jsonl").exists());
        drop(db);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn authority_rejected_input_is_not_reported_as_mirrorable() {
        let home = tmp_home("authority-reject");
        let data_home = home.join("data-home");
        let (manifest, _files) = setup_harness(&home);
        let mut report = run_plugin(&manifest, &[], "m1", &home).unwrap();
        let mut facts = std::mem::take(&mut report.facts);
        for fact in &mut facts {
            fact.as_object_mut().unwrap().remove("native_session_id");
        }
        let err = open_authority_and_write(&data_home, &report, &facts).unwrap_err();
        assert!(err.contains("未完整接受输入"), "{err}");
        assert!(!data_home.join("facts/harness-zcode.jsonl").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn authority_failure_does_not_write_facts_mirror() {
        let home = tmp_home("authority-first");
        let data_home = home.join("data-home");
        let (manifest, _files) = setup_harness(&home);
        let authority_path = agent_vitals_data::authority::default_authority_path(&data_home);
        std::fs::create_dir_all(authority_path.parent().unwrap()).unwrap();
        // A directory at the database path deterministically rejects SQLite open.
        std::fs::create_dir(&authority_path).unwrap();
        let err = plugin_ingest_write(&manifest, "m1", &data_home, &home).unwrap_err();
        assert!(err.contains("未写 facts JSONL 镜像"), "{err}");
        assert!(!data_home.join("facts/harness-zcode.jsonl").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn mirror_failure_can_be_repaired_without_double_counting_authority() {
        let home = tmp_home("mirror-repair");
        let data_home = home.join("data-home");
        let (manifest, _files) = setup_harness(&home);
        std::fs::create_dir_all(&data_home).unwrap();
        let facts_dir = data_home.join("facts");
        std::fs::write(&facts_dir, "block mirror directory").unwrap();
        let err = plugin_ingest_write(&manifest, "m1", &data_home, &home).unwrap_err();
        assert!(err.contains("authority 已提交"), "{err}");
        let authority_path = agent_vitals_data::authority::default_authority_path(&data_home);
        let db = agent_vitals_data::authority::AuthorityDb::open(&authority_path, 0).unwrap();
        let count = || db.conn().query_row(
            "SELECT COUNT(*) FROM usage_facts WHERE harness = 'harness:zcode'", [],
            |r| r.get::<_, i64>(0),
        ).unwrap();
        assert_eq!(count(), 3);
        std::fs::remove_file(&facts_dir).unwrap();
        let repaired = plugin_ingest_write(&manifest, "m1", &data_home, &home).unwrap();
        assert_eq!(repaired["ingest"]["harnesses"][0]["appended"], 3);
        assert_eq!(count(), 3);
        let replay = plugin_ingest_write(&manifest, "m1", &data_home, &home).unwrap();
        assert_eq!(replay["ingest"]["harnesses"][0]["appended"], 0);
        assert_eq!(count(), 3);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ingest_write_is_exactly_once_and_dual_writes_authority() {
        let home = tmp_home("e2e");
        let data_home = home.join("data-home");
        std::fs::create_dir_all(&data_home).unwrap();
        let (manifest, _files) = setup_harness(&home);
        let title_db_path = home.join(".zcode/cli/db/db.sqlite");
        std::fs::create_dir_all(title_db_path.parent().unwrap()).unwrap();
        let title_db = rusqlite::Connection::open(&title_db_path).unwrap();
        title_db.execute_batch("CREATE TABLE session (id TEXT, title TEXT);").unwrap();
        title_db.execute("INSERT INTO session VALUES (?1, ?2)", rusqlite::params!["sess_aaa", "会话 A"]).unwrap();
        title_db.execute("INSERT INTO session VALUES (?1, ?2)", rusqlite::params!["sess_bbb", "会话 B"]).unwrap();
        drop(title_db);

        let payload = plugin_ingest_write(&manifest, "m1", &data_home, &home).unwrap();
        assert!(payload["report"].get("session_titles").is_none(), "本地标题不出现在报告中");
        let ingest = &payload["ingest"];
        assert_eq!(ingest["harnesses"][0]["appended"], 3, "首跑追加 3 条");
        assert_eq!(ingest["harnesses"][0]["duplicate"], 0);

        // facts 文件落在 slug 命名空间。
        let facts_file = data_home.join("facts/harness-zcode.jsonl");
        assert!(facts_file.exists(), "{:?}", facts_file);
        assert_eq!(std::fs::read_to_string(&facts_file).unwrap().lines().count(), 3);

        // authority 双写：usage_facts 有行（harness = harness:zcode）。
        let authority_path =
            agent_vitals_data::authority::default_authority_path(&data_home);
        let db = agent_vitals_data::authority::AuthorityDb::open(&authority_path, 0).unwrap();
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM usage_facts WHERE harness = 'harness:zcode'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 3, "authority 双写落行");
        let titled: Vec<(String, String)> = db.conn().prepare(
            "SELECT native_session_id, title FROM sessions WHERE harness = 'harness:zcode' ORDER BY native_session_id",
        ).unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
            .map(Result::unwrap).collect();
        assert_eq!(titled, [("aaa".to_string(), "会话 A".to_string()), ("bbb".to_string(), "会话 B".to_string())]);

        // 重跑：两个阶段都 exactly-once。
        let payload2 = plugin_ingest_write(&manifest, "m1", &data_home, &home).unwrap();
        assert_eq!(payload2["ingest"]["harnesses"][0]["appended"], 0, "重跑零追加");
        assert_eq!(payload2["ingest"]["harnesses"][0]["duplicate"], 3);
        let count2: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM usage_facts WHERE harness = 'harness:zcode'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count2, 3, "authority 重跑不双计");

        // retention 覆盖插件文件（registry 驱动）。
        let rep = crate::ingest_service::enforce_retention(&data_home, "2026-09").unwrap();
        assert!(
            rep.get("harness:zcode").is_some(),
            "retention 输出含插件执行环境：{rep}"
        );

        // harness-agnostic 下游：matrix 的 combo 查询面按 harness 收纳（§7.4）。
        let n: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(DISTINCT harness) FROM usage_facts",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n >= 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ingest_refuses_without_machine_namespace_shape() {
        // fact 身份缺 machine_namespace → build_usage_fact 报 contract 问题计
        // invalid（喉咙不造默认值，spec §9）。
        let home = tmp_home("nons");
        let (manifest, files) = setup_harness(&home);
        let report = run_plugin(&manifest, &files, "", &home).unwrap();
        assert_eq!(report.emitted, 0, "空 ns 不产事实");
        assert_eq!(report.invalid, 3, "如实计 invalid");
        let _ = std::fs::remove_dir_all(&home);
    }
}
