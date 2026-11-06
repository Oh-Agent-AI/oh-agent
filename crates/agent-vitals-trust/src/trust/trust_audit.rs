//! Read-only historical artifact discovery for Trust/Egress audit.
//!
//! A Trust profile says where a client leaves evidence; the Observation and
//! correlation model stays vendor-neutral. An installed-but-unprofiled client
//! is coverage work, never a Finding.

use std::{collections::{BTreeMap, BTreeSet}, path::{Component, Path, PathBuf}, time::SystemTime};

use agent_vitals_domain::trust::{
    TrustActorKind, TrustConsentState, TrustDestinationClass, TrustEvidenceLevel, TrustEvidenceOrigin, TrustObservation,
    TrustObservationKind, TrustStage,
};
use crate::trust_identity::TrustIdentity;
use agent_vitals_harnesses::generic_manifest::TrustEvidenceAdapter;
use agent_vitals_harnesses::generic_manifest::TrustWatchPriority;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::json;
use walkdir::WalkDir;

const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const PROFILE_VERSION: u64 = 1;
const PROFILE_DIRECTORY: &str = "trust-harnesses.d";
const MAX_MINIMAX_STATE_DATABASES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MatchMode { AnyTermOrExtension, TermAndExtension }

/// A validated artifact profile. It deliberately has no network endpoint or
/// raw-log parser: those require a higher evidence-grade adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustAuditProfile {
    id: String,
    display: String,
    roots: Vec<PathBuf>,
    artifact_terms: Vec<String>,
    extensions: Vec<String>,
    actor_id: String,
    collector_id: String,
    source: &'static str,
    match_mode: MatchMode,
    adapter: TrustEvidenceAdapter,
    watch_priority: TrustWatchPriority,
}

impl TrustAuditProfile {
    pub fn id(&self) -> &str { &self.id }
    #[allow(clippy::too_many_arguments)]
    fn builtin(
        id: &str, display: &str, roots: Vec<PathBuf>, artifact_terms: &[&str],
        extensions: &[&str], actor_id: &str, collector_id: &str, match_mode: MatchMode, adapter: TrustEvidenceAdapter,
        watch_priority: TrustWatchPriority,
    ) -> Self {
        Self {
            id: id.to_string(), display: display.to_string(), roots,
            artifact_terms: artifact_terms.iter().map(|v| (*v).to_string()).collect(),
            extensions: extensions.iter().map(|v| (*v).to_string()).collect(),
            actor_id: actor_id.to_string(), collector_id: collector_id.to_string(),
            source: "built_in", match_mode, adapter, watch_priority,
        }
    }

    fn imported(
        home: &Path, id: &str, display: &str,
        spec: &agent_vitals_harnesses::generic_manifest::TrustArtifactProfile, fallback_adapter: TrustEvidenceAdapter,
    ) -> Result<Self, String> {
        let roots = spec.roots.iter().map(|root| expand_profile_root(home, root)).collect::<Result<Vec<_>, _>>()?;
        // Specialized adapters are capabilities of reviewed built-in harnesses,
        // not claims a dynamically imported manifest may make about itself.
        // An unknown plugin remains generic E1 coverage until its adapter is
        // shipped and bound to a verified harness identity.
        let adapter = if fallback_adapter == TrustEvidenceAdapter::GenericArtifactV1 {
            TrustEvidenceAdapter::GenericArtifactV1
        } else {
            spec.adapter.unwrap_or(fallback_adapter)
        };
        Ok(Self {
            id: id.to_string(), display: display.to_string(), roots,
            artifact_terms: spec.artifact_terms.clone(), extensions: spec.extensions.clone(),
            actor_id: format!("{id}-client"), collector_id: format!("{id}-imported-artifact-metadata"),
            source: "imported_harness_manifest", match_mode: MatchMode::TermAndExtension,
            adapter, watch_priority: spec.watch_priority,
        })
    }
}

/// Coverage is separate from Findings. `detected` only says a local client
/// directory exists; it does not say data was packaged or uploaded.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct TrustHarnessCandidate {
    pub id: String,
    pub detected: bool,
    pub artifact_profile_available: bool,
    pub coverage_state: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct TrustProfileSummary {
    pub id: String,
    pub display: String,
    pub source: String,
    pub capability: String,
    pub adapter: String,
    pub watch_priority: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustAuditReport {
    pub harness: String,
    pub discovered: usize,
    pub inserted: usize,
    pub duplicate: usize,
    pub findings_upserted: usize,
    pub evidence_links_added: usize,
    /// Safe aggregate only: stages and kinds, never raw evidence or paths.
    pub stage_counts: BTreeMap<String, usize>,
    pub observation_kind_counts: BTreeMap<String, usize>,
    /// Safe, bounded evidence cards for the local UI. References are HMACs;
    /// raw paths, filenames, contents and credentials never leave the scanner.
    pub evidence: Vec<TrustEvidenceSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustEvidenceSummary {
    pub kind: String,
    pub stage: String,
    pub evidence_level: String,
    pub evidence_origin: String,
    pub observed_at_ms: i64,
    pub workspace_ref: Option<String>,
    pub native_event_ref: Option<String>,
    pub scope_classes: Vec<String>,
    pub file_count: Option<i64>,
    pub byte_count: Option<i64>,
    pub destination_class: Option<String>,
    pub collector_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustEvidenceHistoryPage {
    pub evidence: Vec<TrustEvidenceSummary>,
    pub next_cursor: Option<String>,
}

/// Read a bounded, redacted projection of persisted Trust observations.
/// This is deliberately separate from `audit_and_store`: opening the Trust
/// page never walks harness directories. No paths, contents, destination harnesses,
/// provenance JSON, or source anchors cross this local UI query face.
pub fn read_evidence_history(data_home: &Path, harness: Option<&str>, limit: usize, cursor: Option<&str>) -> Result<TrustEvidenceHistoryPage, String> {
    let now_ms = crate::clock::now_ms();
    read_evidence_history_at(data_home, harness, limit, cursor, now_ms)
}

fn read_evidence_history_at(data_home: &Path, harness: Option<&str>, limit: usize, cursor: Option<&str>, now_ms: i64) -> Result<TrustEvidenceHistoryPage, String> {
    if !(1..=500).contains(&limit) { return Err("trust evidence limit out of range".into()); }
    if let Some(harness) = harness {
        if harness.is_empty() || harness.len() > 32 || !harness.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')) {
            return Err("trust evidence harness is invalid".into());
        }
    }
    let parsed_cursor = cursor.map(parse_evidence_cursor).transpose()?;
    if parsed_cursor.as_ref().is_some_and(|value| value.1.as_deref() != harness) {
        return Err("trust evidence cursor does not match harness filter".into());
    }
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("trust evidence authority read failed: {error}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(|error| error.to_string())?;
    let sql = "SELECT observation_id, observation_kind, stage, evidence_level, evidence_origin, observed_at_ms,
                      workspace_ref, native_event_id, scope_classes_json, file_count, byte_count,
                      destination_class, collector_id
               FROM trust_observations
               WHERE (expires_at_ms IS NULL OR expires_at_ms >= ?1)
                 AND (?2 IS NULL OR harness = ?2)
                 AND (?3 IS NULL OR observed_at_ms < ?4 OR (observed_at_ms = ?4 AND observation_id < ?5))
               ORDER BY observed_at_ms DESC, observation_id DESC LIMIT ?6";
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map(rusqlite::params![now_ms, harness, cursor, parsed_cursor.as_ref().map(|value| value.0), parsed_cursor.as_ref().map(|value| value.2.as_str()), (limit + 1) as i64], |row| {
        let raw_scopes: String = row.get(8)?;
        let scope_classes = serde_json::from_str::<Vec<String>>(&raw_scopes).unwrap_or_default()
            .into_iter().filter(|value| !value.is_empty() && value.len() <= 64).take(16).collect();
        Ok((row.get::<_, String>(0)?, TrustEvidenceSummary {
            kind: row.get(1)?, stage: row.get(2)?, evidence_level: row.get(3)?, evidence_origin: row.get(4)?,
            observed_at_ms: row.get(5)?, workspace_ref: row.get(6)?, native_event_ref: row.get(7)?, scope_classes,
            file_count: row.get(9)?, byte_count: row.get(10)?, destination_class: row.get(11)?, collector_id: row.get(12)?,
        }))
    }).map_err(|error| error.to_string())?;
    let mut rows = rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("trust evidence query failed: {error}"))?;
    let has_more = rows.len() > limit;
    if has_more { rows.pop(); }
    let next_cursor = if has_more {
        rows.last().map(|(id, item)| format!("{}:{}:{id}", item.observed_at_ms, harness.unwrap_or("")))
    } else { None };
    Ok(TrustEvidenceHistoryPage { evidence: rows.into_iter().map(|(_, item)| item).collect(), next_cursor })
}

fn parse_evidence_cursor(cursor: &str) -> Result<(i64, Option<String>, String), String> {
    if cursor.len() > 320 { return Err("trust evidence cursor is invalid".into()); }
    let mut parts = cursor.splitn(3, ':');
    let timestamp = parts.next().ok_or_else(|| "trust evidence cursor is invalid".to_string())?;
    let harness = parts.next().ok_or_else(|| "trust evidence cursor is invalid".to_string())?;
    let observation_id = parts.next().ok_or_else(|| "trust evidence cursor is invalid".to_string())?;
    let timestamp = timestamp.parse::<i64>().map_err(|_| "trust evidence cursor is invalid".to_string())?;
    if !harness.is_empty() && (harness.len() > 32 || !harness.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_'))) {
        return Err("trust evidence cursor is invalid".into());
    }
    if timestamp < 0 || observation_id.is_empty() || observation_id.len() > 256 || !observation_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')) {
        return Err("trust evidence cursor is invalid".into());
    }
    Ok((timestamp, (!harness.is_empty()).then(|| harness.to_string()), observation_id.to_string()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileFile {
    profile_version: u64,
    id: String,
    display: String,
    roots: Vec<String>,
    artifact_terms: Vec<String>,
    extensions: Vec<String>,
}

/// Evidence-backed seed adapters. Additional profiles load from the local
/// profile directory; the architecture is not a two-vendor allow-list.
pub fn builtin_profiles(home: &Path) -> Vec<TrustAuditProfile> {
    vec![
        TrustAuditProfile::builtin(
            "zcode", "ZCode", vec![home.join(".zcode/v2/checkpoints")],
            &["checkpoint", "snapshot"], &[".enc"], "zcode-client",
            "zcode-checkpoint-metadata", MatchMode::AnyTermOrExtension, TrustEvidenceAdapter::ZcodeCheckpointV1,
            TrustWatchPriority::Enhanced,
        ),
        TrustAuditProfile::builtin(
            "minimax-code", "MiniMax Code", vec![
                home.join(".minimax"), home.join(".minimax-agent-cn"),
                home.join("Library/Application Support/MiniMax"),
            ], &["snapshot", "checkpoint", "eval"],
            &[".json", ".enc", ".log", ".state"], "minimax-code-client",
            "minimax-code-artifact-metadata", MatchMode::TermAndExtension, TrustEvidenceAdapter::MiniMaxWorkspaceIndexV1,
            TrustWatchPriority::Normal,
        ),
    ]
}

fn safe_identifier(value: &str, max_len: usize) -> bool {
    value.bytes().next().is_some_and(|byte| byte.is_ascii_lowercase()) && value.len() <= max_len && value.bytes().all(|byte|
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.'))
}

fn safe_display(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.chars().all(|ch|
        ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_'))
}

fn expand_profile_root(home: &Path, root: &str) -> Result<PathBuf, String> {
    let relative = root.strip_prefix("~/").ok_or_else(|| "roots must start with ~/".to_string())?;
    if relative.is_empty() || relative.len() > 240 { return Err("root is empty or too long".to_string()); }
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("root must not contain ., .., or an absolute path".to_string());
    }
    Ok(home.join(path))
}

fn parse_profile_file(home: &Path, raw: &[u8]) -> Result<TrustAuditProfile, String> {
    let profile: ProfileFile = serde_json::from_slice(raw).map_err(|error| format!("invalid JSON: {error}"))?;
    if profile.profile_version != PROFILE_VERSION { return Err(format!("unsupported profile_version {}", profile.profile_version)); }
    if !safe_identifier(&profile.id, 32) { return Err("id must be a lower-case identifier".to_string()); }
    if !safe_display(&profile.display) { return Err("display contains unsupported characters".to_string()); }
    if profile.roots.is_empty() || profile.roots.len() > 8 { return Err("roots must contain 1 to 8 entries".to_string()); }
    if profile.artifact_terms.is_empty() || profile.artifact_terms.len() > 8 || !profile.artifact_terms.iter().all(|term| safe_identifier(term, 40)) {
        return Err("artifact_terms must contain 1 to 8 lower-case identifiers".to_string());
    }
    if profile.extensions.is_empty() || profile.extensions.len() > 8 || !profile.extensions.iter().all(|extension| extension.strip_prefix('.').is_some_and(|suffix| safe_identifier(suffix, 16))) {
        return Err("extensions must contain 1 to 8 safe extensions".to_string());
    }
    let mut roots = Vec::new();
    for root in &profile.roots { roots.push(expand_profile_root(home, root)?); }
    Ok(TrustAuditProfile {
        actor_id: format!("{}-client", profile.id), collector_id: format!("{}-artifact-metadata", profile.id),
        id: profile.id, display: profile.display, roots, artifact_terms: profile.artifact_terms,
        extensions: profile.extensions, source: "local_profile", match_mode: MatchMode::TermAndExtension,
        adapter: TrustEvidenceAdapter::GenericArtifactV1, watch_priority: TrustWatchPriority::Normal,
    })
}

/// Load optional local profiles from `<data_home>/trust-harnesses.d`. Invalid files
/// are isolated and only a safe label plus reason is returned.
pub fn profiles(data_home: &Path, home: &Path) -> (Vec<TrustAuditProfile>, Vec<String>) {
    let mut loaded = builtin_profiles(home);
    let mut errors = Vec::new();
    let (plugin_harnesses, plugin_harness_errors) = crate::harness_registry::scan_plugin_harnesses(data_home);
    errors.extend(plugin_harness_errors.into_iter().map(|_| "plugin_harness_manifest_invalid".to_string()));
    for plugin in plugin_harnesses {
        let Some(spec) = plugin.trust_profile.as_ref() else { continue; };
        let fallback_adapter = loaded.iter().find(|present| present.id == plugin.slug)
            .map(|present| present.adapter).unwrap_or(TrustEvidenceAdapter::GenericArtifactV1);
        match TrustAuditProfile::imported(home, &plugin.slug, &plugin.display_name, spec, fallback_adapter) {
            Ok(profile) => {
                if let Some(index) = loaded.iter().position(|present| present.id == profile.id) {
                    loaded[index] = profile;
                } else {
                    loaded.push(profile);
                }
            }
            Err(_) => errors.push("plugin_harness_trust_profile_invalid".to_string()),
        }
    }
    let directory = data_home.join(PROFILE_DIRECTORY);
    let Ok(entries) = std::fs::read_dir(directory) else { return (loaded, errors); };
    let mut files: Vec<PathBuf> = entries.flatten().map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json")).collect();
    files.sort();
    for file in files {
        let label = file.file_stem().and_then(|value| value.to_str()).filter(|value| safe_identifier(value, 32)).unwrap_or("profile");
        let parsed = std::fs::read(&file).map_err(|_| "file unreadable".to_string()).and_then(|raw| parse_profile_file(home, &raw));
        match parsed {
            Ok(profile) if loaded.iter().any(|present| present.id == profile.id) => errors.push(format!("{label}: duplicate id")),
            Ok(profile) => loaded.push(profile),
            Err(error) => errors.push(format!("{label}: {error}")),
        }
    }
    loaded.sort_by(|left, right| left.id.cmp(&right.id));
    (loaded, errors)
}

pub fn profile_summaries(profiles: &[TrustAuditProfile]) -> Vec<TrustProfileSummary> {
    profiles.iter().map(|profile| TrustProfileSummary {
        id: profile.id.clone(), display: profile.display.clone(), source: profile.source.to_string(),
        capability: "historical_artifact_only".to_string(),
        adapter: profile.adapter.as_str().to_string(),
        watch_priority: profile.watch_priority.as_str().to_string(),
    }).collect()
}

/// Discover well-known client roots without inspecting their content. This is
/// coverage inventory, not behavioral detection or a vendor risk ranking.
pub fn discover_harness_candidates(home: &Path, profiles: &[TrustAuditProfile]) -> Vec<TrustHarnessCandidate> {
    let candidates: [(&str, &[&str]); 10] = [
        ("zcode", &[".zcode"]), ("minimax-code", &[".minimax", ".minimax-agent-cn", "Library/Application Support/MiniMax"]),
        ("codex", &[".codex"]), ("claude-code", &[".claude"]), ("cursor", &[".cursor"]),
        ("windsurf", &[".windsurf", ".codeium/windsurf"]), ("cline", &[".cline"]),
        ("continue", &[".continue"]), ("aider", &[".aider"]), ("opencode", &[".opencode"]),
    ];
    candidates.into_iter().map(|(id, roots)| {
        let detected = roots.iter().any(|root| home.join(root).is_dir());
        let available = profiles.iter().any(|profile| profile.id == id);
        TrustHarnessCandidate {
            id: id.to_string(), detected, artifact_profile_available: available,
            coverage_state: if !detected { "not_detected" } else if available { "profiled" } else { "detected_unprofiled" }.to_string(),
        }
    }).collect()
}

fn artifact_name_matches(profile: &TrustAuditProfile, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let has_term = profile.artifact_terms.iter().any(|term| name.contains(term));
    let has_extension = profile.extensions.iter().any(|extension| name.ends_with(extension));
    match profile.match_mode {
        MatchMode::AnyTermOrExtension => has_term || has_extension,
        MatchMode::TermAndExtension => has_term && has_extension,
    }
}

fn observed_at_from_metadata(metadata: &std::fs::Metadata, fallback_ms: i64) -> i64 {
    metadata.modified().ok().and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(fallback_ms)
}

fn workspace_ref_for_entry(identity: &TrustIdentity, root: &Path, entry: &Path) -> Option<String> {
    let workspace = entry.strip_prefix(root).ok()?.components().next().and_then(|part| match part {
        Component::Normal(value) => Some(root.join(value)),
        _ => None,
    })?;
    Some(identity.workspace_ref(&workspace))
}

fn zcode_manifest_observation(
    profile: &TrustAuditProfile, identity: &TrustIdentity, machine_namespace: &str,
    root: &Path, entry: &Path, metadata: &std::fs::Metadata, fallback_ms: i64,
) -> Option<TrustObservation> {
    let raw = std::fs::read(entry).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let files = value.get("files")?.as_array()?;
    let mut scopes = BTreeSet::from(["snapshot_artifact".to_string()]);
    let mut git_history_entries = 0_i64;
    let mut byte_count = 0_i64;
    for file in files {
        let path = file.get("path").and_then(serde_json::Value::as_str).unwrap_or_default().to_ascii_lowercase();
        if path == ".git" || path.starts_with(".git/") || path.contains("/.git/") {
            git_history_entries = git_history_entries.saturating_add(1);
        }
        byte_count = byte_count.saturating_add(file.get("sizeBytes").and_then(serde_json::Value::as_i64).unwrap_or(0).max(0));
    }
    if git_history_entries > 0 { scopes.insert("git_history".to_string()); }
    let observed_at_ms = observed_at_from_metadata(metadata, fallback_ms);
    Some(TrustObservation {
        observation_id: format!("{}_{}", profile.id, identity.event_ref(&format!("{}#manifest", entry.display()))),
        machine_namespace: machine_namespace.to_string(), harness: profile.id.clone(),
        actor_id: identity.actor_ref(&profile.actor_id), actor_kind: TrustActorKind::Sidecar, actor_version: None,
        observed_at_ms, observation_kind: TrustObservationKind::Package, stage: TrustStage::PackageObserved,
        evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref: workspace_ref_for_entry(identity, root, entry),
        scope_classes: scopes.into_iter().collect(), file_count: i64::try_from(files.len()).ok(), byte_count: Some(byte_count),
        destination_class: None, destination_host: None, consent_kind: None, consent_state: TrustConsentState::Unavailable,
        source_id: None, native_event_id: Some(identity.event_ref(&entry.to_string_lossy())), source_line: None, source_byte_offset: None,
        collector_id: "zcode-checkpoint-metadata".to_string(), collector_version: "v2".to_string(),
        provenance: json!({"artifact":"zcode_manifest","content_read":false,"file_entries":files.len(),"git_history_entries":git_history_entries}),
        expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
    })
}

fn zcode_state_observations(
    profile: &TrustAuditProfile, identity: &TrustIdentity, machine_namespace: &str,
    root: &Path, entry: &Path, metadata: &std::fs::Metadata, fallback_ms: i64,
) -> Vec<TrustObservation> {
    let Ok(raw) = std::fs::read(entry) else { return Vec::new() };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else { return Vec::new() };
    let observed_at_ms = observed_at_from_metadata(metadata, fallback_ms);
    let workspace_ref = workspace_ref_for_entry(identity, root, entry);
    let actor_id = identity.actor_ref(&profile.actor_id);
    let event = entry.to_string_lossy();
    let mut out = Vec::new();
    if value.get("lastAcceptedManifestHash").and_then(serde_json::Value::as_str).is_some()
        || value.get("lastAcceptedExtraManifestHash").and_then(serde_json::Value::as_str).is_some() {
        out.push(TrustObservation {
            observation_id: format!("{}_{}", profile.id, identity.event_ref(&format!("{event}#accepted"))),
            machine_namespace: machine_namespace.to_string(), harness: profile.id.clone(), actor_id: actor_id.clone(),
            actor_kind: TrustActorKind::Sidecar, actor_version: None, observed_at_ms,
            observation_kind: TrustObservationKind::RemoteAck, stage: TrustStage::PackageObserved,
            evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::ClientStateClaim, workspace_ref: workspace_ref.clone(), scope_classes: Vec::new(),
            file_count: None, byte_count: None, destination_class: None, destination_host: None,
            consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None,
            native_event_id: Some(identity.event_ref(&event)), source_line: None, source_byte_offset: None,
            collector_id: "zcode-checkpoint-state".to_string(), collector_version: "v2".to_string(),
            provenance: json!({"artifact":"zcode_state","accepted_manifest_recorded":true,"content_read":false}),
            expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
        });
    }
    if let Some(failure_count) = value.get("failureCount").and_then(serde_json::Value::as_i64).filter(|count| *count > 0) {
        out.push(TrustObservation {
            observation_id: format!("{}_{}", profile.id, identity.event_ref(&format!("{event}#retry"))),
            machine_namespace: machine_namespace.to_string(), harness: profile.id.clone(), actor_id,
            actor_kind: TrustActorKind::Sidecar, actor_version: None, observed_at_ms,
            observation_kind: TrustObservationKind::Retry, stage: TrustStage::PackageObserved,
            evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref, scope_classes: vec!["snapshot_artifact".to_string()],
            file_count: None, byte_count: None, destination_class: None, destination_host: None,
            consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None,
            native_event_id: Some(identity.event_ref(&event)), source_line: None, source_byte_offset: None,
            collector_id: "zcode-checkpoint-state".to_string(), collector_version: "v2".to_string(),
            provenance: json!({"artifact":"zcode_state","failure_count":failure_count,"content_read":false}),
            expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
        });
    }
    out
}

fn scan_zcode_history(
    profile: &TrustAuditProfile, identity: &TrustIdentity, machine_namespace: &str, observed_at_ms: i64,
) -> Vec<TrustObservation> {
    let mut observations = scan_generic_history(profile, identity, machine_namespace, observed_at_ms);
    for root in &profile.roots {
        if !root.is_dir() { continue; }
        for entry in WalkDir::new(root).follow_links(false).max_depth(5).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() { continue; }
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else { continue; };
            let relative = path.strip_prefix(root).ok();
            let is_manifest = relative.is_some_and(|value| value.components().any(|part| part.as_os_str() == "manifests"))
                && path.extension().and_then(|value| value.to_str()) == Some("json");
            if is_manifest {
                if let Some(observation) = zcode_manifest_observation(profile, identity, machine_namespace, root, path, &metadata, observed_at_ms) {
                    observations.push(observation);
                }
            } else if path.file_name().and_then(|value| value.to_str()) == Some("state.json") {
                observations.extend(zcode_state_observations(profile, identity, machine_namespace, root, path, &metadata, observed_at_ms));
            }
        }
    }
    observations.sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
    observations.dedup_by(|a, b| a.observation_id == b.observation_id);
    observations
}

/// Read MiniMax's local workspace-index projection, but never retain its
/// workspace path, archive path, object key, or manifest content.  The schema
/// has explicit archive/manifest and OSS-key columns; their presence is enough
/// for a bounded local observation.  Unknown remote-state labels deliberately
/// do not become a claimed remote acknowledgement.
fn scan_minimax_workspace_index(
    profile: &TrustAuditProfile, identity: &TrustIdentity, machine_namespace: &str, fallback_ms: i64,
) -> Vec<TrustObservation> {
    if machine_namespace.is_empty() || fallback_ms < 0 { return Vec::new(); }
    let databases = minimax_state_databases(profile);
    let mut observations = Vec::new();
    for database in databases {
        observations.extend(scan_minimax_workspace_index_database(profile, identity, machine_namespace, fallback_ms, &database));
    }
    observations.sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
    observations.dedup_by(|a, b| a.observation_id == b.observation_id);
    observations
}

/// The current database plus a bounded, explicitly named migration-backup
/// family are historical evidence roots.  Do not walk arbitrary SQLite files:
/// a client-controlled filename must not expand the audit surface.
fn minimax_state_databases(profile: &TrustAuditProfile) -> Vec<PathBuf> {
    let mut databases = Vec::new();
    for root in &profile.roots {
        let sqlite = root.join("v2/sqlite");
        let current = sqlite.join("runtime-state.sqlite");
        if std::fs::symlink_metadata(&current).ok().is_some_and(|metadata| metadata.file_type().is_file()) {
            databases.push(current);
        }
        let backup_directory = sqlite.join("backups");
        let Ok(entries) = std::fs::read_dir(backup_directory) else { continue; };
        let mut backups: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
            name.starts_with("runtime-state-before-v2-migration-") && name.ends_with(".sqlite")
                && std::fs::symlink_metadata(path).ok().is_some_and(|metadata| metadata.file_type().is_file())
        }).collect();
        backups.sort();
        databases.extend(backups);
    }
    databases.sort();
    databases.dedup();
    databases.truncate(MAX_MINIMAX_STATE_DATABASES);
    databases
}

fn scan_minimax_workspace_index_database(
    profile: &TrustAuditProfile, identity: &TrustIdentity, machine_namespace: &str, fallback_ms: i64, database: &Path,
) -> Vec<TrustObservation> {
    let Ok(connection) = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return Vec::new();
    };
    let sql = "SELECT workspace_id, workspace_real_path, archive_path IS NOT NULL, manifest_path IS NOT NULL, archive_sha256 IS NOT NULL, manifest_sha256 IS NOT NULL, archive_oss_key IS NOT NULL, manifest_oss_key IS NOT NULL, remote_state, retry_count, index_size_bytes, updated_at_ms FROM local_runtime_workspace_indexing_revisions JOIN local_runtime_workspace_indexing_sessions USING (session_id, workspace_id)";
    let Ok(mut statement) = connection.prepare(sql) else { return Vec::new() };
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?,
            row.get::<_, bool>(2)?, row.get::<_, bool>(3)?, row.get::<_, bool>(4)?, row.get::<_, bool>(5)?,
            row.get::<_, bool>(6)?, row.get::<_, bool>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, i64>(9)?,
            row.get::<_, Option<i64>>(10)?, row.get::<_, Option<i64>>(11)?,
        ))
    });
    let Ok(rows) = rows else { return Vec::new() };
    let actor_id = identity.actor_ref(&profile.actor_id);
    let database_ref = identity.event_ref(&database.to_string_lossy());
    let mut observations = Vec::new();
    for row in rows.flatten() {
        let (workspace_id, workspace_path, has_archive_path, has_manifest_path, has_archive_hash, has_manifest_hash,
            has_archive_oss_key, has_manifest_oss_key, remote_state, retry_count, index_size_bytes, updated_at_ms) = row;
        let workspace_ref = workspace_path.as_deref().filter(|value| !value.is_empty())
            .map(|value| identity.workspace_ref(Path::new(value)))
            .or_else(|| Some(identity.event_ref(&format!("minimax-workspace:{workspace_id}"))));
        let observed_at_ms = updated_at_ms.filter(|value| *value >= 0).unwrap_or(fallback_ms);
        let native = identity.event_ref(&format!("minimax-index:{database_ref}:{workspace_id}:{observed_at_ms}"));
        let has_package = has_archive_path || has_manifest_path || has_archive_hash || has_manifest_hash;
        if has_package {
            let mut scopes = Vec::new();
            if has_archive_path || has_archive_hash { scopes.push("workspace_archive".to_string()); }
            if has_manifest_path || has_manifest_hash { scopes.push("workspace_manifest".to_string()); }
            observations.push(TrustObservation {
                observation_id: format!("minimax_package_{native}"), machine_namespace: machine_namespace.to_string(), harness: profile.id.clone(),
                actor_id: actor_id.clone(), actor_kind: TrustActorKind::Main, actor_version: None, observed_at_ms,
                observation_kind: TrustObservationKind::Package, stage: TrustStage::PackageObserved,
                evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref: workspace_ref.clone(), scope_classes: scopes,
                file_count: None, byte_count: index_size_bytes.filter(|value| *value >= 0), destination_class: None, destination_host: None,
                consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None, native_event_id: Some(native.clone()),
                source_line: None, source_byte_offset: None, collector_id: "minimax-workspace-index".to_string(), collector_version: "v2".to_string(),
                provenance: json!({"artifact":"workspace_index","archive_recorded":has_archive_path || has_archive_hash,"manifest_recorded":has_manifest_path || has_manifest_hash,"content_read":false}),
                expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
            });
        }
        if has_archive_oss_key || has_manifest_oss_key {
            observations.push(TrustObservation {
                observation_id: format!("minimax_upload_ready_{native}"), machine_namespace: machine_namespace.to_string(), harness: profile.id.clone(),
                actor_id: actor_id.clone(), actor_kind: TrustActorKind::Main, actor_version: None, observed_at_ms,
                observation_kind: TrustObservationKind::Credential, stage: TrustStage::CredentialObserved,
                evidence_level: TrustEvidenceLevel::E2UploadReady, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref: workspace_ref.clone(), scope_classes: Vec::new(),
                file_count: None, byte_count: None, destination_class: Some(TrustDestinationClass::ObjectStorage), destination_host: None,
                consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None, native_event_id: Some(native.clone()),
                source_line: None, source_byte_offset: None, collector_id: "minimax-workspace-index".to_string(), collector_version: "v2".to_string(),
                provenance: json!({"artifact":"workspace_index","archive_object_key_recorded":has_archive_oss_key,"manifest_object_key_recorded":has_manifest_oss_key,"content_read":false}),
                expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
            });
        }
        if retry_count > 0 {
            observations.push(TrustObservation {
                observation_id: format!("minimax_retry_{native}"), machine_namespace: machine_namespace.to_string(), harness: profile.id.clone(),
                actor_id: actor_id.clone(), actor_kind: TrustActorKind::Main, actor_version: None, observed_at_ms,
                observation_kind: TrustObservationKind::Retry, stage: TrustStage::PackageObserved,
                evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref, scope_classes: vec!["workspace_index".to_string()],
                file_count: None, byte_count: None, destination_class: None, destination_host: None,
                consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None, native_event_id: Some(native),
                source_line: None, source_byte_offset: None, collector_id: "minimax-workspace-index".to_string(), collector_version: "v2".to_string(),
                provenance: json!({"artifact":"workspace_index","retry_count":retry_count,"remote_state_recorded":remote_state.is_some(),"content_read":false}),
                expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
            });
        }
    }
    observations
}

/// Scan one generic profile and emit only E1 package observations. It never
/// reads file content; harnesses with a verified adapter add bounded derivations separately.
fn scan_generic_history(
    profile: &TrustAuditProfile, identity: &TrustIdentity, machine_namespace: &str, observed_at_ms: i64,
) -> Vec<TrustObservation> {
    if observed_at_ms < 0 || machine_namespace.is_empty() { return Vec::new(); }
    let mut observations = Vec::new();
    for root in &profile.roots {
        if !root.is_dir() { continue; }
        for entry in WalkDir::new(root).follow_links(false).max_depth(5).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() || !artifact_name_matches(profile, &entry.file_name().to_string_lossy()) { continue; }
            let Ok(metadata) = entry.metadata() else { continue; };
            let path_ref = identity.event_ref(&entry.path().to_string_lossy());
            let workspace = profile.roots.iter().find(|root| entry.path().starts_with(root));
            let workspace_ref = workspace.map(|root| identity.workspace_ref(root));
            let actor_ref = identity.actor_ref(&profile.actor_id);
            observations.push(TrustObservation {
                observation_id: format!("{}_{}", profile.id, path_ref), machine_namespace: machine_namespace.to_string(), harness: profile.id.clone(),
                actor_id: actor_ref, actor_kind: TrustActorKind::Sidecar, actor_version: None,
                observed_at_ms, observation_kind: TrustObservationKind::Package, stage: TrustStage::PackageObserved,
                evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref,
                scope_classes: vec!["snapshot_artifact".to_string()], file_count: Some(1), byte_count: i64::try_from(metadata.len()).ok(),
                destination_class: None, destination_host: None, consent_kind: None, consent_state: TrustConsentState::Unavailable,
                source_id: None, native_event_id: Some(path_ref), source_line: None, source_byte_offset: None,
                collector_id: profile.collector_id.clone(), collector_version: "v1".to_string(),
                provenance: json!({"artifact": "encrypted_or_snapshot", "content_read": false, "profile_source": profile.source}),
                expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
            });
        }
    }
    observations.sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
    observations
}

pub fn scan_history(
    profile: &TrustAuditProfile, identity: &TrustIdentity, machine_namespace: &str, observed_at_ms: i64,
) -> Vec<TrustObservation> {
    match profile.adapter {
        TrustEvidenceAdapter::GenericArtifactV1 => scan_generic_history(profile, identity, machine_namespace, observed_at_ms),
        TrustEvidenceAdapter::ZcodeCheckpointV1 => scan_zcode_history(profile, identity, machine_namespace, observed_at_ms),
        TrustEvidenceAdapter::MiniMaxWorkspaceIndexV1 => {
            let mut observations = scan_generic_history(profile, identity, machine_namespace, observed_at_ms);
            observations.extend(scan_minimax_workspace_index(profile, identity, machine_namespace, observed_at_ms));
            observations.sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
            observations.dedup_by(|a, b| a.observation_id == b.observation_id);
            observations
        }
    }
}

/// Scan one local client and persist only redacted observations plus derived
/// Findings. A failed scan never leaves a partially linked Finding behind.
pub fn audit_and_store(
    data_home: &Path, profile: &TrustAuditProfile, machine_namespace: &str, now_ms: i64,
) -> Result<TrustAuditReport, String> {
    let identity = TrustIdentity::load_or_create(data_home)?;
    let observations = scan_history(profile, &identity, machine_namespace, now_ms);
    let authority = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home), now_ms,
    ).map_err(|error| format!("authority open failed: {error}"))?;
    let run_id = format!("trust-audit:{}:{}", profile.id, now_ms);
    authority.begin_run(&run_id, "trust-audit", now_ms)
        .map_err(|error| format!("trust audit run begin failed: {error}"))?;
    let write = authority.with_immediate_txn(|conn| {
        let inserted = agent_vitals_data::trust::insert_observations(conn, &observations, &run_id, now_ms)?;
        let ids: Vec<String> = observations.iter().map(|row| row.observation_id.clone()).collect();
        let correlation = agent_vitals_data::trust_correlator::correlate_selected(conn, &ids)?;
        Ok((inserted, correlation))
    });
    match write {
        Ok((inserted, correlation)) => {
            authority.finish_run(&run_id, "succeeded", None, None, now_ms)
                .map_err(|error| format!("trust audit run finish failed: {error}"))?;
            Ok(TrustAuditReport {
                harness: profile.id.clone(), discovered: observations.len(), inserted: inserted.inserted,
                duplicate: inserted.duplicate, findings_upserted: correlation.findings_upserted,
                evidence_links_added: correlation.evidence_links_added,
                stage_counts: observations.iter().fold(BTreeMap::new(), |mut counts, observation| {
                    *counts.entry(observation.stage.as_str().to_string()).or_insert(0) += 1;
                    counts
                }),
                observation_kind_counts: observations.iter().fold(BTreeMap::new(), |mut counts, observation| {
                    *counts.entry(observation.observation_kind.as_str().to_string()).or_insert(0) += 1;
                    counts
                }),
                evidence: observations.iter().map(|observation| TrustEvidenceSummary {
                    kind: observation.observation_kind.as_str().to_string(),
                    stage: observation.stage.as_str().to_string(),
                    evidence_level: observation.evidence_level.as_str().to_string(),
                    evidence_origin: observation.evidence_origin.as_str().to_string(),
                    observed_at_ms: observation.observed_at_ms,
                    workspace_ref: observation.workspace_ref.clone(),
                    native_event_ref: observation.native_event_id.clone(),
                    scope_classes: observation.scope_classes.clone(),
                    file_count: observation.file_count,
                    byte_count: observation.byte_count,
                    destination_class: observation.destination_class.map(|value| value.as_str().to_string()),
                    collector_id: observation.collector_id.clone(),
                }).collect(),
            })
        }
        Err(error) => {
            let _ = authority.finish_run(&run_id, "failed", Some("trust_audit_write_failed"), Some(&error.to_string()), now_ms);
            Err(format!("trust audit write failed: {error}"))
        }
    }
}

/// Safe, authority-only Finding rollup for desktop/CLI presentation.
pub fn findings_summary(data_home: &Path) -> Result<Vec<agent_vitals_data::trust_correlator::TrustFindingSummary>, String> {
    let authority = agent_vitals_data::authority::AuthorityDb::open_readonly(
        &agent_vitals_data::authority::default_authority_path(data_home),
    ).map_err(|error| format!("authority read failed: {error}"))?;
    agent_vitals_data::trust_correlator::findings_summary(authority.conn())
        .map_err(|error| format!("trust findings summary failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{audit_and_store, builtin_profiles, discover_harness_candidates, profiles, read_evidence_history, read_evidence_history_at, scan_history, RETENTION_MS};
    use agent_vitals_harnesses::generic_manifest::TrustEvidenceAdapter;
    use crate::trust_identity::TrustIdentity;
    use rusqlite::Connection;

    #[test]
    fn zcode_scan_is_read_only_and_path_redacted() {
        let root = std::env::temp_dir().join(format!("agent-vitals-zcode-trust-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".zcode/v2/checkpoints/workspace-private")).unwrap();
        let artifact = root.join(".zcode/v2/checkpoints/workspace-private/snapshot.enc");
        std::fs::write(&artifact, b"not-read-by-scanner").unwrap();
        let profile = builtin_profiles(&root).into_iter().find(|item| item.id() == "zcode").unwrap();
        let identity = TrustIdentity::load_or_create(&root).unwrap();
        let rows = scan_history(&profile, &identity, "machine-1", 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].byte_count, Some(19));
        assert!(!rows[0].observation_id.contains("workspace-private"));
        assert!(rows[0].workspace_ref.is_some());
        assert!(!rows[0].native_event_id.as_deref().unwrap().contains("workspace-private"));
        assert!(rows[0].validate().is_ok());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn zcode_checkpoint_metadata_classifies_git_history_and_local_acceptance_without_paths() {
        let root = std::env::temp_dir().join(format!("agent-vitals-zcode-state-{}", std::process::id()));
        let checkpoint = root.join(".zcode/v2/checkpoints/workspace-private");
        std::fs::create_dir_all(checkpoint.join("manifests")).unwrap();
        std::fs::write(checkpoint.join("manifests/opaque.json"), r#"{
            "files":[{"path":"src/main.rs","sizeBytes":3},{"path":".git/objects/ab/cd","sizeBytes":7}]
        }"#).unwrap();
        std::fs::write(checkpoint.join("state.json"), r#"{
            "lastAcceptedManifestHash":"opaque-hash","failureCount":2
        }"#).unwrap();
        let profile = builtin_profiles(&root).into_iter().find(|item| item.id() == "zcode").unwrap();
        let identity = TrustIdentity::load_or_create(&root).unwrap();
        let rows = scan_history(&profile, &identity, "machine-1", 1_000);
        let package = rows.iter().find(|row| row.collector_id == "zcode-checkpoint-metadata").unwrap();
        assert!(package.scope_classes.iter().any(|scope| scope == "git_history"));
        assert_eq!(package.file_count, Some(2));
        assert_eq!(package.byte_count, Some(10));
        assert!(!package.observation_id.contains("workspace-private"));
        assert!(!package.native_event_id.as_deref().unwrap().contains("opaque.json"));
        assert!(rows.iter().any(|row| row.observation_kind == agent_vitals_domain::trust::TrustObservationKind::RemoteAck
            && row.stage == agent_vitals_domain::trust::TrustStage::PackageObserved
            && row.evidence_level == agent_vitals_domain::trust::TrustEvidenceLevel::E1LocalArtifact
            && row.evidence_origin == agent_vitals_domain::trust::TrustEvidenceOrigin::ClientStateClaim));
        assert!(rows.iter().any(|row| row.observation_kind == agent_vitals_domain::trust::TrustObservationKind::Retry));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn minimax_workspace_index_emits_redacted_package_upload_ready_and_retry() {
        let root = std::env::temp_dir().join(format!("agent-vitals-minimax-index-{}", std::process::id()));
        let database = root.join(".minimax/v2/sqlite/backups/runtime-state-before-v2-migration-test.sqlite");
        std::fs::create_dir_all(database.parent().unwrap()).unwrap();
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute_batch("\
            CREATE TABLE local_runtime_workspace_indexing_sessions (
                session_id TEXT, workspace_id TEXT, workspace_real_path TEXT
            );
            CREATE TABLE local_runtime_workspace_indexing_revisions (
                session_id TEXT, workspace_id TEXT, archive_path TEXT, manifest_path TEXT,
                archive_sha256 TEXT, manifest_sha256 TEXT, archive_oss_key TEXT, manifest_oss_key TEXT,
                remote_state TEXT, retry_count INTEGER, index_size_bytes INTEGER, updated_at_ms INTEGER
            );
            INSERT INTO local_runtime_workspace_indexing_sessions VALUES ('session-private', 'workspace-private', '/private/company/repository');
            INSERT INTO local_runtime_workspace_indexing_revisions VALUES (
                'session-private', 'workspace-private', '/private/tmp/archive.tar.gz', '/private/tmp/manifest.json',
                'archive-sha', 'manifest-sha', 'opaque-archive-key', 'opaque-manifest-key', 'queued', 2, 1234, 2000
            );
        ").unwrap();
        drop(connection);
        let profile = builtin_profiles(&root).into_iter().find(|item| item.id() == "minimax-code").unwrap();
        let identity = TrustIdentity::load_or_create(&root).unwrap();
        let rows = scan_history(&profile, &identity, "machine-1", 1_000);
        assert!(rows.iter().any(|row| row.observation_kind == agent_vitals_domain::trust::TrustObservationKind::Package
            && row.scope_classes.iter().any(|scope| scope == "workspace_archive") && row.byte_count == Some(1234)));
        assert!(rows.iter().any(|row| row.observation_kind == agent_vitals_domain::trust::TrustObservationKind::Credential
            && row.evidence_level == agent_vitals_domain::trust::TrustEvidenceLevel::E2UploadReady));
        assert!(rows.iter().any(|row| row.observation_kind == agent_vitals_domain::trust::TrustObservationKind::Retry));
        for row in rows {
            assert!(row.validate().is_ok());
            assert!(!row.observation_id.contains("private"));
            assert!(!row.native_event_id.as_deref().unwrap_or_default().contains("private"));
            assert!(!row.provenance.to_string().contains("opaque"));
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn local_profile_is_restricted_and_extensible() {
        let root = std::env::temp_dir().join(format!("agent-vitals-trust-profile-{}", std::process::id()));
        let data = root.join("data/trust-harnesses.d");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("cursor.json"), r#"{"profile_version":1,"id":"cursor","display":"Cursor","roots":["~/.cursor/cache"],"artifact_terms":["snapshot"],"extensions":[".enc"]}"#).unwrap();
        std::fs::create_dir_all(root.join(".cursor/cache")).unwrap();
        std::fs::write(root.join(".cursor/cache/repo-snapshot.enc"), b"x").unwrap();
        let (loaded, errors) = profiles(&root.join("data"), &root);
        assert!(errors.is_empty());
        let profile = loaded.iter().find(|item| item.id() == "cursor").unwrap();
        let identity = TrustIdentity::load_or_create(&root).unwrap();
        assert_eq!(scan_history(profile, &identity, "machine", 1).len(), 1);
        std::fs::write(data.join("bad.json"), r#"{"profile_version":1,"id":"bad","display":"Bad","roots":["/tmp"],"artifact_terms":["snapshot"],"extensions":[".enc"]}"#).unwrap();
        let (_, errors) = profiles(&root.join("data"), &root);
        assert_eq!(errors.len(), 1);
        std::fs::remove_file(data.join("bad.json")).unwrap();
        std::fs::write(data.join("unknown.json"), r#"{"profile_version":1,"id":"unknown","display":"Unknown","roots":["~/.unknown"],"artifact_terms":["snapshot"],"extensions":[".enc"],"command":"must-not-run"}"#).unwrap();
        let (_, errors) = profiles(&root.join("data"), &root);
        assert_eq!(errors.len(), 1, "profile parser must fail closed on unknown fields");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn discovery_marks_unprofiled_client_as_coverage_not_finding() {
        let root = std::env::temp_dir().join(format!("agent-vitals-trust-discovery-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".cursor")).unwrap();
        let candidates = discover_harness_candidates(&root, &builtin_profiles(&root));
        let cursor = candidates.iter().find(|item| item.id == "cursor").unwrap();
        assert!(cursor.detected);
        assert_eq!(cursor.coverage_state, "detected_unprofiled");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn imported_harness_manifest_replaces_builtin_profile_without_rebuild() {
        let root = std::env::temp_dir().join(format!("agent-vitals-trust-plugin-{}", std::process::id()));
        let harness_dir = root.join("data/harnesses.d/zcode");
        std::fs::create_dir_all(&harness_dir).unwrap();
        std::fs::write(harness_dir.join("manifest.json"), r#"{
            "manifest_version":1,"slug":"zcode","display":{"name":"ZCode"},
            "discovery":{"roots":["~/.zcode/cli/rollout"],"include":["*.jsonl"]},
            "source":{"format":"jsonl"},"session":{"from":"filename","pattern":"^s_(?P<id>.+)\\.jsonl$"},
            "recipe":"request-usage-anthropic-v1","event_key":{"paths":["requestId"]},
            "trust":{"roots":["~/.zcode/v2/checkpoints"],"artifact_terms":["snapshot"],"extensions":[".enc"]}
        }"#).unwrap();
        let (loaded, errors) = profiles(&root.join("data"), &root);
        assert!(errors.is_empty());
        let profile = loaded.iter().find(|item| item.id() == "zcode").unwrap();
        assert_eq!(profile.source, "imported_harness_manifest");
        assert_eq!(profile.adapter, TrustEvidenceAdapter::ZcodeCheckpointV1,
            "legacy imported manifests inherit the replaced built-in adapter");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn unknown_imported_harness_cannot_claim_a_specialized_adapter() {
        let root = std::env::temp_dir().join(format!("agent-vitals-trust-plugin-generic-{}", std::process::id()));
        let harness_dir = root.join("data/harnesses.d/unknown-agent");
        std::fs::create_dir_all(&harness_dir).unwrap();
        std::fs::write(harness_dir.join("manifest.json"), r#"{
            "manifest_version":1,"slug":"unknown-agent","display":{"name":"Unknown Agent"},
            "discovery":{"roots":["~/.unknown-agent"],"include":["*.jsonl"]},
            "source":{"format":"jsonl"},"session":{"from":"filename","pattern":"^s_(?P<id>.+)\\.jsonl$"},
            "recipe":"request-usage-anthropic-v1","event_key":{"paths":["requestId"]},
            "trust":{"roots":["~/.unknown-agent/cache"],"artifact_terms":["snapshot"],"extensions":[".enc"],"adapter":"minimax_workspace_index_v1"}
        }"#).unwrap();
        let (loaded, errors) = profiles(&root.join("data"), &root);
        assert!(errors.is_empty());
        let profile = loaded.iter().find(|item| item.id() == "unknown-agent").unwrap();
        assert_eq!(profile.adapter, TrustEvidenceAdapter::GenericArtifactV1);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn audit_writes_auditable_run_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!("agent-vitals-zcode-store-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".zcode/v2/checkpoints/x")).unwrap();
        std::fs::write(root.join(".zcode/v2/checkpoints/x/snapshot.enc"), b"x").unwrap();
        let data = root.join("data");
        let profile = builtin_profiles(&root).into_iter().find(|item| item.id() == "zcode").unwrap();
        let first = audit_and_store(&data, &profile, "machine-1", 10).unwrap();
        assert_eq!((first.discovered, first.inserted, first.duplicate), (1, 1, 0));
        let second = audit_and_store(&data, &profile, "machine-1", 11).unwrap();
        assert_eq!((second.discovered, second.inserted, second.duplicate), (1, 0, 1));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn evidence_history_is_bounded_read_only_and_harness_filterable() {
        let root = std::env::temp_dir().join(format!("agent-vitals-trust-history-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".zcode/v2/checkpoints/x")).unwrap();
        std::fs::write(root.join(".zcode/v2/checkpoints/x/snapshot.enc"), b"snapshot").unwrap();
        std::fs::write(root.join(".zcode/v2/checkpoints/x/snapshot-2.enc"), b"snapshot-2").unwrap();
        let data = root.join("data");
        let profile = builtin_profiles(&root).into_iter().find(|item| item.id() == "zcode").unwrap();
        audit_and_store(&data, &profile, "machine-1", 10).unwrap();

        let all = read_evidence_history_at(&data, None, 10, None, 10).unwrap().evidence;
        assert!(!all.is_empty());
        assert!(all.iter().all(|row| row.workspace_ref.as_deref().map_or(true, |value| value.starts_with("tr_"))));
        assert!(read_evidence_history_at(&data, Some("not-installed"), 10, None, 10).unwrap().evidence.is_empty());
        let first_page = read_evidence_history_at(&data, None, 1, None, 10).unwrap();
        let cursor = first_page.next_cursor.expect("second page must exist");
        let second_page = read_evidence_history_at(&data, None, 1, Some(&cursor), 10).unwrap();
        assert_eq!(first_page.evidence.len(), 1);
        assert_eq!(second_page.evidence.len(), 1);
        assert_ne!(first_page.evidence[0].native_event_ref, second_page.evidence[0].native_event_ref);
        assert!(second_page.next_cursor.is_none());
        assert!(read_evidence_history_at(&data, Some("zcode"), 1, Some(&cursor), 10).is_err(), "cursor from all-harness query must not be reused with a harness filter");
        let harness_page = read_evidence_history_at(&data, Some("zcode"), 1, None, 10).unwrap();
        if let Some(harness_cursor) = harness_page.next_cursor {
            assert!(read_evidence_history_at(&data, None, 1, Some(&harness_cursor), 10).is_err(), "harness-filtered cursor must not be reused without its filter");
            assert!(read_evidence_history_at(&data, Some("minimax-code"), 1, Some(&harness_cursor), 10).is_err(), "harness-filtered cursor must not be reused for another harness");
            assert!(read_evidence_history_at(&data, Some("zcode"), 1, Some(&harness_cursor), 10).is_ok(), "cursor remains valid with its originating harness filter");
        }
        assert!(read_evidence_history(&data, None, 0, None).is_err());
        assert!(read_evidence_history(&data, Some("../private"), 10, None).is_err());
        assert_eq!(read_evidence_history_at(&data, None, 10, None, 10 + RETENTION_MS).unwrap().evidence.len(), all.len(), "evidence remains available through the exact expiry millisecond");
        assert!(read_evidence_history_at(&data, None, 10, None, 11 + RETENTION_MS).unwrap().evidence.is_empty(), "expired evidence must be excluded after the retention boundary");

        // Re-open with a writable connection to prove the UI query did not
        // migrate or mutate the authority as a side effect.
        let writable = Connection::open(agent_vitals_data::authority::default_authority_path(&data)).unwrap();
        let count: i64 = writable.query_row("SELECT COUNT(*) FROM trust_observations", [], |row| row.get(0)).unwrap();
        assert_eq!(count as usize, all.len());
        std::fs::remove_dir_all(root).ok();
    }
}
