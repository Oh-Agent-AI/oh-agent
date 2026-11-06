//! E04：预览绑定的激活生命周期。负责 staging → 校验 → ticket → commit /
//! rollback，以及派生 registry 快照。网络传输刻意不在此层——与 pricing
//! catalog 相同，HTTP 归桌面适配层，核心只吃字节（扩展架构 §8.1/§8.3）。
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use agent_vitals_data::authority::AuthorityDb;
use agent_vitals_data::extension_authority as ledger;
use agent_vitals_data::extension_authority::{ActivationAction, ExtensionError, ExtensionRevision, SlotMap};
use agent_vitals_runtime_core::core::extension_objects::ObjectStore;
use agent_vitals_harnesses::generic_manifest::PluginManifest;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

pub const REGISTRY_SNAPSHOT_SCHEMA: &str = "agent-vitals-registry/v1";
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum InstallError {
    Ledger(ExtensionError),
    Object(&'static str),
    UnknownRevision { revision_id: String },
}
impl From<ExtensionError> for InstallError {
    fn from(value: ExtensionError) -> Self { Self::Ledger(value) }
}
impl From<rusqlite::Error> for InstallError {
    fn from(value: rusqlite::Error) -> Self { Self::Ledger(ExtensionError::Sql(value)) }
}
impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ledger(error) => write!(f, "{error}"),
            Self::Object(code) => write!(f, "{code}"),
            Self::UnknownRevision { revision_id } => write!(f, "unknown revision {revision_id}"),
        }
    }
}
impl std::error::Error for InstallError {}

fn action_tag(action: ActivationAction) -> &'static str {
    match action {
        ActivationAction::Activate => "activate",
        ActivationAction::Rollback => "rollback",
        ActivationAction::Uninstall => "uninstall",
    }
}
fn origin_tag(origin: &ledger::RevisionOrigin) -> &'static str {
    match origin {
        ledger::RevisionOrigin::Local => "local",
        ledger::RevisionOrigin::VendorCatalog { .. } => "vendor-catalog",
    }
}
fn feed(hash: &mut Sha256, line: &str) {
    hash.update((line.len() as u64).to_be_bytes());
    hash.update(line.as_bytes());
}

fn canonical_scope(path: &Path) -> Result<std::path::PathBuf, String> {
    match path.canonicalize() {
        Ok(value) => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Resolve existing ancestors, but do not trust a dangling symlink.
            if std::fs::symlink_metadata(path).is_ok() { return Err("source scope cannot be verified".into()); }
            let parent = path.parent().ok_or("source scope cannot be verified")?;
            let name = path.file_name().ok_or("source scope cannot be verified")?;
            Ok(canonical_scope(parent)?.join(name))
        }
        Err(_) => Err("source scope cannot be verified".into()),
    }
}

/// Conservatively reject shared roots even when a compiled importer is paused:
/// pausing does not remove previously recorded facts or prove time-range disjointness.
pub fn ensure_compiled_sources_exclusive(manifest: &PluginManifest, home: &Path,
    data_home: &Path) -> Result<(), String> {
    use agent_vitals_harnesses::sources::session_harnesses::{HarnessRoots, usage_source_roots};
    let dsh_home = std::env::var_os("DSH_HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".dsh"));
    let mut scopes = usage_source_roots(&HarnessRoots { user_home: home, dsh_home: Some(&dsh_home) });
    for source in crate::custom_sources::custom_source_roots(data_home)? {
        let harness = agent_vitals_harnesses::sources::session_harnesses::session_harness(&source.harness)
            .ok_or("unknown compiled source adapter")?;
        if harness.accepts_custom_roots { scopes.push((harness.id, source.root.into())); }
    }
    if manifest.roots.is_empty() { return Err("source scope cannot be verified: missing roots".into()); }
    for root in &manifest.roots {
        let candidate = canonical_scope(&agent_vitals_harnesses::generic_discover::expand_tilde_home(root, home))?;
        for (harness, root) in &scopes {
            let compiled = canonical_scope(root)?;
            if candidate.starts_with(&compiled) || compiled.starts_with(&candidate) {
                return Err(format!("source scope overlap with compiled adapter: {harness}; explicit source migration required"));
            }
        }
    }
    ensure_recorded_sources_exclusive(manifest, home, data_home)
}

fn ensure_recorded_sources_exclusive(candidate: &PluginManifest, home: &Path,
    data_home: &Path) -> Result<(), String> {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    if !path.exists() { return Ok(()); }
    let db = AuthorityDb::open_readonly(&path).map_err(|e| e.to_string())?;
    let mut statement = db.conn().prepare(
        "SELECT DISTINCT r.content_sha256 FROM extension_revisions r
         JOIN extension_fact_provenance p ON p.revision_id=r.revision_id
         WHERE r.slot_type='harness_manifest'").map_err(|e| e.to_string())?;
    let hashes = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if hashes.is_empty() { return Ok(()); }
    let store = ObjectStore::open_readonly(&data_home.join("state/extensions"))
        .map_err(|_| "historical source scope cannot be verified")?;
    for hash in hashes {
        let prior = agent_vitals_harnesses::generic_manifest::parse_manifest(
            store.load(&hash).map_err(|_| "historical harness object unavailable")?)
            .map_err(|e| e.to_string())?;
        if prior.slug == candidate.slug {
            if prior.roots != candidate.roots || prior.include != candidate.include
                || prior.session_pattern.as_str() != candidate.session_pattern.as_str()
                || prior.event_key_paths != candidate.event_key_paths || prior.recipe != candidate.recipe {
                return Err("historical source identity declaration drift; explicit migration required".into());
            }
        } else {
            ensure_manifest_sources_exclusive(candidate, &prior, home)?;
        }
    }
    Ok(())
}

/// Check active and recorded declarations before compiled sync can consume new roots.
pub fn ensure_active_compiled_sources_exclusive(data_home: &Path, home: &Path) -> Result<(), String> {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    if !path.exists() { return Ok(()); }
    // Older authority schemas have no extension activation and must still reach
    // normal sync's migration path. Never migrate during this read-only check.
    let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let has_activations: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='extension_active')",
        [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !has_activations { return Ok(()); }
    let mut statement = conn.prepare(
        "SELECT DISTINCT r.content_sha256,
         EXISTS(SELECT 1 FROM extension_fact_provenance p WHERE p.revision_id=r.revision_id)
         FROM extension_revisions r WHERE r.slot_type='harness_manifest' AND (
         r.revision_id IN (SELECT s.revision_id FROM extension_active a
           JOIN extension_activation_slots s ON s.generation=a.generation)
         OR EXISTS(SELECT 1 FROM extension_fact_provenance p WHERE p.revision_id=r.revision_id))")
        .map_err(|e| e.to_string())?;
    let hashes = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if hashes.is_empty() { return Ok(()); }
    let store = match ObjectStore::open_readonly(&data_home.join("state/extensions")) {
        Ok(store) => store,
        Err(_) if hashes.iter().all(|(_, historical)| !historical) => return Ok(()),
        Err(_) => return Err("historical source scope cannot be verified: object store unavailable".into()),
    };
    for (hash, historical) in hashes {
        let parsed = store.load(&hash).map_err(str::to_string)
            .and_then(|value| agent_vitals_harnesses::generic_manifest::parse_manifest(value).map_err(|e| e.to_string()));
        match parsed {
            Ok(manifest) => ensure_compiled_sources_exclusive(&manifest, home, data_home)?,
            Err(_) if !historical => (), // Cannot ingest, and no historical facts to double-count.
            Err(_) => return Err("historical source scope cannot be verified: harness object unavailable".into()),
        }
    }
    Ok(())
}

/// Fail closed when two harness declarations share or nest a discovery root.
/// Different filename globs are insufficient: an in-root symlink can alias
/// two differently named source paths to the same canonical file.
pub fn ensure_manifest_sources_exclusive(
    left: &PluginManifest,
    right: &PluginManifest,
    home: &Path,
) -> Result<(), String> {
    if left.slug == right.slug { return Ok(()); }
    if left.roots.is_empty() || right.roots.is_empty() {
        return Err("source scope cannot be verified: missing roots".into());
    }
    for left_root in &left.roots {
        let left_path = agent_vitals_harnesses::generic_discover::expand_tilde_home(left_root, home)
            .canonicalize().map_err(|_| format!("source scope cannot be verified: harness:{}", left.slug))?;
        for right_root in &right.roots {
            let right_path = agent_vitals_harnesses::generic_discover::expand_tilde_home(right_root, home)
                .canonicalize().map_err(|_| format!("source scope cannot be verified: harness:{}", right.slug))?;
            if left_path.starts_with(&right_path) || right_path.starts_with(&left_path) {
                return Err(format!("source scope overlap or cannot prove exclusive: harness:{} and harness:{}",
                    left.slug, right.slug));
            }
        }
    }
    Ok(())
}

/// Validate the complete target harness map before a rollback or other lifecycle
/// transition. The caller's preview ticket pins the generation; CAS rejects
/// any activation that races this read.
pub fn ensure_harness_map_sources_exclusive(
    db: &AuthorityDb,
    store: &ObjectStore,
    slots: &SlotMap,
    home: &Path,
    data_home: &Path,
) -> Result<(), String> {
    let mut manifests = Vec::new();
    for ((kind, slug), revision) in slots {
        if kind != "harness_manifest" { continue; }
        let hash: String = db.conn().query_row(
            "SELECT content_sha256 FROM extension_revisions WHERE revision_id=?1 AND slot_type='harness_manifest' AND slot_id=?2",
            params![revision, slug], |row| row.get(0)).map_err(|e| e.to_string())?;
        let manifest = agent_vitals_harnesses::generic_manifest::parse_manifest(
            store.load(&hash).map_err(|e| format!("harness object: {e}"))?)
            .map_err(|e| format!("harness manifest: {e}"))?;
        if manifest.slug != *slug { return Err("harness manifest slot mismatch".into()); }
        ensure_compiled_sources_exclusive(&manifest, home, data_home)?;
        manifests.push(manifest);
    }
    for (index, manifest) in manifests.iter().enumerate() {
        for other in manifests.iter().skip(index + 1) {
            ensure_manifest_sources_exclusive(manifest, other, home)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod source_scope_tests {
    use super::*;

    #[test]
    fn compiled_scope_guard_reserves_missing_roots_and_resolves_aliases() {
        let base = std::env::temp_dir().join(format!("vitals-compiled-scope-{}", std::process::id()));
        let home = base.join("home");
        let data_home = base.join("state");
        std::fs::create_dir_all(&home).unwrap();
        let candidate = manifest("codex-drift", "~/.codex/sessions/subdir", "*.jsonl");
        assert!(ensure_compiled_sources_exclusive(&candidate, &home, &data_home)
            .unwrap_err().contains("compiled adapter: codex"));
        let parent = manifest("other", "~/.claude", "*.jsonl");
        assert!(ensure_compiled_sources_exclusive(&parent, &home, &data_home).is_err());
        let separate = manifest("other", "~/independent", "*.jsonl");
        assert!(ensure_compiled_sources_exclusive(&separate, &home, &data_home).is_ok());
        #[cfg(unix)] {
            std::fs::create_dir_all(home.join(".codex/sessions")).unwrap();
            std::os::unix::fs::symlink(home.join(".codex/sessions"), home.join("alias")).unwrap();
            let alias = manifest("other", "~/alias", "*.jsonl");
            assert!(ensure_compiled_sources_exclusive(&alias, &home, &data_home).is_err());
            std::os::unix::fs::symlink(home.join("absent"), home.join("dangling")).unwrap();
            let dangling = manifest("other", "~/dangling/child", "*.jsonl");
            assert!(ensure_compiled_sources_exclusive(&dangling, &home, &data_home).is_err());
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn compiled_scope_preflight_does_not_block_or_migrate_pre_extension_database() {
        let data_home = std::env::temp_dir().join(format!("vitals-scope-old-db-{}", std::process::id()));
        let path = agent_vitals_data::authority::default_authority_path(&data_home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO schema_meta VALUES ('schema_version','27');").unwrap();
        assert!(ensure_active_compiled_sources_exclusive(&data_home, &data_home).is_ok());
        let version: String = conn.query_row("SELECT value FROM schema_meta WHERE key='schema_version'", [], |row| row.get(0)).unwrap();
        assert_eq!(version, "27");
        drop(conn);
        let _ = std::fs::remove_dir_all(data_home);
    }

    fn manifest(slug: &str, root: &str, include: &str) -> PluginManifest {
        let value = serde_json::json!({
            "manifest_version":1,"slug":slug,"display":{"name":slug},
            "discovery":{"roots":[root],"include":[include]},"source":{"format":"jsonl"},
            "session":{"from":"filename","pattern":"^model-io-sess_(?P<id>.+)\\.jsonl$"},
            "recipe":"request-usage-anthropic-v1",
            "overrides":{"event_ts":"completedAt","model_raw":"model.modelId",
                "provider_raw":"model.providerId","uncached_input_tokens":"response.providerMetadata.anthropic.usage.input_tokens",
                "output_tokens":"response.providerMetadata.anthropic.usage.output_tokens","provider_request_id":"requestId"},
            "event_key":{"paths":["requestId"]},"billing":{"policy":"lock:metered_estimate"}
        });
        agent_vitals_harnesses::generic_manifest::parse_manifest(value).unwrap()
    }

    #[test]
    fn source_scope_guard_rejects_overlap_and_unverifiable_patterns() {
        let base = std::env::temp_dir().join(format!("vitals-source-scope-{}", std::process::id()));
        let home = base.join("home");
        std::fs::create_dir_all(home.join("data")).unwrap();
        let a = manifest("alpha", "~/data", "model-io-sess_*.jsonl");
        let same = manifest("beta", "~/data", "model-io-sess_*.jsonl");
        assert!(ensure_manifest_sources_exclusive(&a, &same, &home).unwrap_err().contains("overlap"));
        let original = home.join("data/alpha.jsonl");
        #[cfg(unix)]
        let alias = home.join("data/beta.jsonl");
        std::fs::write(&original, "source\n").unwrap();
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&original, &alias).unwrap();
            assert_eq!(original.canonicalize().unwrap(), alias.canonicalize().unwrap());
        }
        let alias_left = manifest("alpha", "~/data", "alpha*.jsonl");
        let alias_glob = manifest("beta", "~/data", "beta*.jsonl");
        assert!(ensure_manifest_sources_exclusive(&alias_left, &alias_glob, &home).unwrap_err().contains("overlap"));
        let disjoint = manifest("beta", "~/other", "model-io-sess_*.jsonl");
        std::fs::create_dir_all(home.join("other")).unwrap();
        assert!(ensure_manifest_sources_exclusive(&a, &disjoint, &home).is_ok());
        std::fs::create_dir_all(home.join("data/child")).unwrap();
        let nested = manifest("beta", "~/data/child", "model-io-sess_*.jsonl");
        assert!(ensure_manifest_sources_exclusive(&a, &nested, &home).unwrap_err().contains("overlap"));
        let missing = manifest("gamma", "~/missing", "*.jsonl");
        assert!(ensure_manifest_sources_exclusive(&a, &missing, &home).unwrap_err().contains("cannot be verified"));
        let _ = std::fs::remove_dir_all(base);
    }
}

pub(crate) fn canonical_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort();
            serde_json::Value::Object(keys.into_iter().map(|key|
                (key.clone(), canonical_value(&object[key]))).collect())
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(values.iter().map(canonical_value).collect()),
        _ => value.clone(),
    }
}

/// 预览绑定（§8.1）：ticket 绑定它所针对的 generation、确切候选集与引擎
/// 版本；commit 经台账 CAS 复核，期间的任何激活都会让整张 ticket 失效。
#[derive(Debug, Clone)]
pub struct LocalInputBinding {
    pub machine_namespace: String,
    pub corpus_fingerprint: String,
    pub impact_sha256: String,
}

#[derive(Debug, Clone)]
pub struct PreviewTicket {
    pub expected_generation: i64,
    pub engine_version: String,
    pub action: ActivationAction,
    /// 在 commit 事务内新登记的不可变 revision。
    pub new_revisions: Vec<ExtensionRevision>,
    /// **完整替换映射**：省略一个在用 slot 即停用它。
    pub target_map: SlotMap,
    /// Local harness handler's exact preview input and impact commitment.
    pub local_input: Option<LocalInputBinding>,
}

impl PreviewTicket {
    pub fn preview_sha256(&self) -> String {
        let mut hash = Sha256::new();
        feed(&mut hash, "extension-preview/v2");
        feed(&mut hash, &format!("generation={}", self.expected_generation));
        feed(&mut hash, &format!("engine={}", self.engine_version));
        feed(&mut hash, &format!("action={}", action_tag(self.action)));
        if let Some(binding) = &self.local_input {
            feed(&mut hash, "local-input/v1");
            for field in [&binding.machine_namespace, &binding.corpus_fingerprint,
                &binding.impact_sha256] { feed(&mut hash, field); }
        }
        let mut revisions: Vec<&ExtensionRevision> = self.new_revisions.iter().collect();
        revisions.sort_by(|a, b| (&a.slot_type, &a.slot_id, &a.revision_id).cmp(&(&b.slot_type, &b.slot_id, &b.revision_id)));
        for revision in revisions {
            feed(&mut hash, "revision");
            for field in [&revision.slot_type, &revision.slot_id, &revision.revision_id, &revision.content_sha256] {
                feed(&mut hash, field);
            }
            feed(&mut hash, origin_tag(&revision.origin));
            if let ledger::RevisionOrigin::VendorCatalog { source, commit, index_sha256 } = &revision.origin {
                for field in [source, commit, index_sha256] { feed(&mut hash, field); }
            }
            feed(&mut hash, &revision.schema_version.to_string());
            feed(&mut hash, &canonical_value(&revision.capabilities).to_string());
        }
        for ((slot_type, slot_id), revision_id) in &self.target_map {
            feed(&mut hash, "slot");
            for field in [slot_type, slot_id, revision_id] { feed(&mut hash, field); }
        }
        format!("{:x}", hash.finalize())
    }
}

/// 新 revision 的哈希来自 ticket；既有 revision 一律查台账——哈希不猜。
fn content_sha256_for(ticket: &PreviewTicket, conn: &Connection, slot_type: &str, slot_id: &str, revision_id: &str) -> Result<String, InstallError> {
    if let Some(revision) = ticket.new_revisions.iter()
        .find(|r| r.revision_id == revision_id && r.slot_type == slot_type && r.slot_id == slot_id) {
        return Ok(revision.content_sha256.clone());
    }
    conn.query_row(
        "SELECT content_sha256 FROM extension_revisions WHERE revision_id=?1 AND slot_type=?2 AND slot_id=?3",
        params![revision_id, slot_type, slot_id],
        |row| row.get(0),
    ).map_err(|_| InstallError::UnknownRevision { revision_id: revision_id.to_string() })
}

/// §8.3.3：事务之前，映射里每个 revision 的对象必须仍在且通过哈希与
/// JSON 校验；随后单个台账事务完成新 revision 登记、完整映射写入与
/// CAS 指针切换。任一步失败整体不提交。
pub fn commit(db: &AuthorityDb, store: &ObjectStore, ticket: &PreviewTicket, now_ms: i64) -> Result<i64, InstallError> {
    if ticket.engine_version.trim().is_empty() {
        return Err(InstallError::Ledger(ExtensionError::Invalid("empty engine version")));
    }
    for ((slot_type, slot_id), revision_id) in &ticket.target_map {
        let sha = content_sha256_for(ticket, db.conn(), slot_type, slot_id, revision_id)?;
        store.load(&sha).map_err(InstallError::Object)?;
    }
    ledger::activate(db.conn(), ticket.expected_generation, &ticket.new_revisions,
        &ticket.target_map, &ticket.preview_sha256(), ticket.action, now_ms).map_err(InstallError::Ledger)
}

/// Empty-map uninstall can recover from a lost object directory: there are no
/// referenced payloads to verify. The same generation CAS still applies.
pub fn commit_empty_uninstall(db: &AuthorityDb, ticket: &PreviewTicket, now_ms: i64) -> Result<i64, InstallError> {
    if !matches!(ticket.action, ActivationAction::Uninstall)
        || !ticket.target_map.is_empty() || !ticket.new_revisions.is_empty()
        || ticket.engine_version.trim().is_empty() {
        return Err(InstallError::Ledger(ExtensionError::Invalid("not an empty-map uninstall")));
    }
    ledger::activate(db.conn(), ticket.expected_generation, &[], &ticket.target_map,
        &ticket.preview_sha256(), ticket.action, now_ms).map_err(InstallError::Ledger)
}

/// 回滚 = 指向历史 generation 完整映射的新激活；revision 不重复登记，
/// 事实与历史 activation 不被抹除（§8.3 / 台账语义）。
pub fn rollback_to(db: &AuthorityDb, store: &ObjectStore, generation: i64, engine_version: &str, now_ms: i64) -> Result<i64, InstallError> {
    let map = ledger::generation_slots(db.conn(), generation)?;
    let ticket = PreviewTicket {
        expected_generation: ledger::current_generation(db.conn())?,
        engine_version: engine_version.to_string(),
        action: ActivationAction::Rollback,
        new_revisions: Vec::new(),
        target_map: map,
        local_input: None,
    };
    commit(db, store, &ticket, now_ms)
}

/// 停用全部 slot（完整映射语义下的空映射）；revision 历史保留。
pub fn uninstall_all(db: &AuthorityDb, store: &ObjectStore, engine_version: &str, now_ms: i64) -> Result<i64, InstallError> {
    let ticket = PreviewTicket {
        expected_generation: ledger::current_generation(db.conn())?,
        engine_version: engine_version.to_string(),
        action: ActivationAction::Uninstall,
        new_revisions: Vec::new(),
        target_map: SlotMap::new(),
        local_input: None,
    };
    commit(db, store, &ticket, now_ms)
}

/// 派生快照 `<data_home>/catalog/registry.json`（尽力而为）。authority 是
/// 唯一激活权威：此文件可随时删除重建，不得作为任何授权依据
/// （扩展架构 §5.2/§8.3.5）。写入失败只报错，不撤销已提交激活。
pub fn rebuild_registry_snapshot(data_home: &Path, db: &AuthorityDb, now_ms: i64) -> Result<(), InstallError> {
    let conn = db.conn();
    let generation = ledger::current_generation(conn)?;
    let mut statement = conn.prepare(
        "SELECT s.slot_type, s.slot_id, s.revision_id, r.content_sha256, r.origin, r.installed_at_ms
         FROM extension_activation_slots s
         JOIN extension_revisions r
           ON r.revision_id = s.revision_id AND r.slot_type = s.slot_type AND r.slot_id = s.slot_id
         WHERE s.generation = ?1 ORDER BY s.slot_type, s.slot_id",
    )?;
    let slots = statement.query_map(params![generation], |row| {
        Ok(serde_json::json!({
            "slot_type": row.get::<_, String>(0)?,
            "slot_id": row.get::<_, String>(1)?,
            "revision_id": row.get::<_, String>(2)?,
            "content_sha256": row.get::<_, String>(3)?,
            "origin": row.get::<_, String>(4)?,
            "installed_at_ms": row.get::<_, i64>(5)?,
        }))
    })?.collect::<Result<Vec<_>, _>>()?;
    let snapshot = serde_json::json!({
        "schema": REGISTRY_SNAPSHOT_SCHEMA,
        "generation": generation,
        "rebuilt_at_ms": now_ms,
        "slots": slots,
    });
    let catalog = data_home.join("catalog");
    std::fs::create_dir_all(&catalog).map_err(|_| InstallError::Object("object_io"))?;
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|_| InstallError::Object("object_io"))?;
    let temporary = catalog.join(format!(".registry-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&temporary, &bytes).map_err(|_| InstallError::Object("object_io"))?;
    match std::fs::rename(&temporary, catalog.join("registry.json")) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = std::fs::remove_file(&temporary);
            Err(InstallError::Object("object_io"))
        }
    }
}
