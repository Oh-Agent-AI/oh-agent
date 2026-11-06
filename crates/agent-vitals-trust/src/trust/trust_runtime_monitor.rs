//! Explicit, low-privilege runtime Trust snapshot for otherwise unprofiled
//! local processes.
//!
//! This is deliberately a point-in-time sensor, not a blocker or TLS proxy.
//! On macOS it consumes `lsof` field output without storing paths, process
//! names, arguments, endpoints, request bodies, or credentials. A concurrent
//! Git-history read, archive write, and established connection can support an
//! E3 *attempt* observation; it cannot prove transmitted bytes or remote use.

use agent_vitals_domain::trust::{
    TrustActorKind, TrustConsentState, TrustEvidenceLevel, TrustEvidenceOrigin, TrustObservation,
    TrustObservationKind, TrustStage,
};
use crate::trust_identity::TrustIdentity;
use serde::Serialize;
use serde_json::json;

const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProcessSample {
    pid: String,
    command: String,
    has_git_history: bool,
    writes_archive: bool,
    writes_workspace_index: bool,
    established_connection: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct TrustRuntimeSnapshotReport {
    pub capability: String,
    pub candidate_processes: usize,
    pub observations: usize,
    pub inserted: usize,
    pub duplicate: usize,
    pub findings_upserted: usize,
    pub notification_candidates: usize,
    pub notification_keys: Vec<String>,
    pub evidence_links_added: usize,
}

fn is_git_history_path(value: &str) -> bool {
    let path = value.to_ascii_lowercase();
    ["/.git/objects", "/.git/lfs", "/.git/logs", "/.git/reflog"]
        .iter().any(|needle| path.contains(needle))
}

fn is_archive_output(value: &str, fd: &str) -> bool {
    if !fd.ends_with('w') && !fd.ends_with('u') { return false; }
    let path = value.to_ascii_lowercase();
    path.ends_with(".tar") || path.ends_with(".tar.gz") || path.ends_with(".tgz")
        || path.ends_with(".zip") || path.ends_with(".enc")
        || path.contains("snapshot") || path.contains("checkpoint")
}

fn is_workspace_index_output(value: &str, fd: &str) -> bool {
    if !fd.ends_with('w') && !fd.ends_with('u') { return false; }
    let path = value.to_ascii_lowercase();
    path.contains("/.minimax/v2/sqlite/runtime-state.sqlite")
        || path.contains("/library/application support/minimax/") && (path.contains("index") || path.contains("manifest"))
}

fn is_established_connection(value: &str) -> bool {
    value.starts_with("TCP") && value.contains("->") && value.contains("(ESTABLISHED)")
}

/// Parse `lsof -Fpcfn` output. This pure boundary makes the platform command
/// testable while ensuring the raw `n` values never leave this function.
fn parse_lsof_fields(raw: &str) -> Vec<ProcessSample> {
    let mut samples = Vec::new();
    let mut current: Option<ProcessSample> = None;
    let mut fd = String::new();
    for line in raw.lines() {
        let Some((field, value)) = line.chars().next().map(|field| (field, &line[field.len_utf8()..])) else { continue; };
        match field {
            'p' => {
                if let Some(sample) = current.take() { samples.push(sample); }
                current = Some(ProcessSample { pid: value.to_string(), ..ProcessSample::default() });
                fd.clear();
            }
            'c' => if let Some(sample) = current.as_mut() { sample.command = value.to_string(); },
            'f' => fd = value.to_string(),
            'n' => if let Some(sample) = current.as_mut() {
                sample.has_git_history |= is_git_history_path(value);
                sample.writes_archive |= is_archive_output(value, &fd);
                sample.writes_workspace_index |= is_workspace_index_output(value, &fd);
                sample.established_connection |= is_established_connection(value);
            },
            _ => {},
        }
    }
    if let Some(sample) = current { samples.push(sample); }
    samples
}

fn observations_from_samples(
    samples: &[ProcessSample], identity: &TrustIdentity, machine_namespace: &str, observed_at_ms: i64,
) -> Vec<TrustObservation> {
    if machine_namespace.is_empty() || observed_at_ms < 0 { return Vec::new(); }
    let minute_bucket = observed_at_ms / 60_000;
    let mut out = Vec::new();
    for sample in samples.iter().filter(|sample| sample.has_git_history && (sample.writes_archive || sample.writes_workspace_index)) {
        let actor_id = identity.actor_ref(&format!("{}:{}", sample.pid, sample.command));
        let native = identity.event_ref(&format!("runtime:{minute_bucket}:{}", sample.pid));
        out.push(TrustObservation {
            observation_id: format!("runtime_package_{actor_id}_{minute_bucket}"), machine_namespace: machine_namespace.to_string(),
            harness: "unattributed-local-agent".to_string(), actor_id: actor_id.clone(), actor_kind: TrustActorKind::Unknown,
            actor_version: None, observed_at_ms, observation_kind: TrustObservationKind::Package,
            stage: TrustStage::PackageObserved, evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::RuntimeProcessMetadata,
            workspace_ref: None, scope_classes: {
                let mut scopes = vec!["git_history".to_string()];
                if sample.writes_archive { scopes.push("archive_output".to_string()); }
                if sample.writes_workspace_index { scopes.push("workspace_index_state".to_string()); }
                scopes
            },
            file_count: None, byte_count: None, destination_class: None, destination_host: None,
            consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None, native_event_id: Some(native.clone()),
            source_line: None, source_byte_offset: None, collector_id: "macos-lsof-runtime".to_string(),
            collector_version: "v1".to_string(),
            provenance: json!({"git_history":true,"archive_output":sample.writes_archive,"workspace_index_state":sample.writes_workspace_index,"content_read":false}),
            expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
        });
        if sample.established_connection {
            out.push(TrustObservation {
                observation_id: format!("runtime_egress_{actor_id}_{minute_bucket}"), machine_namespace: machine_namespace.to_string(),
                harness: "unattributed-local-agent".to_string(), actor_id, actor_kind: TrustActorKind::Unknown,
                actor_version: None, observed_at_ms, observation_kind: TrustObservationKind::Connection,
                stage: TrustStage::EgressAttempted, evidence_level: TrustEvidenceLevel::E3NetworkAttempt, evidence_origin: TrustEvidenceOrigin::RuntimeProcessMetadata,
                workspace_ref: None, scope_classes: {
                    let mut scopes = vec!["git_history".to_string()];
                    if sample.writes_archive { scopes.push("archive_output".to_string()); }
                    if sample.writes_workspace_index { scopes.push("workspace_index_state".to_string()); }
                    scopes
                },
                file_count: None, byte_count: None, destination_class: None, destination_host: None,
                consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None, native_event_id: Some(native),
                source_line: None, source_byte_offset: None, collector_id: "macos-lsof-runtime".to_string(),
                collector_version: "v1".to_string(),
                provenance: json!({"git_history":true,"archive_output":sample.writes_archive,"workspace_index_state":sample.writes_workspace_index,"established_connection":true,"content_read":false}),
                expires_at_ms: observed_at_ms.checked_add(RETENTION_MS),
            });
        }
    }
    out.sort_by(|left, right| left.observation_id.cmp(&right.observation_id));
    out
}

#[cfg(target_os = "macos")]
fn lsof_raw() -> Result<String, String> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-n", "-P", "-Fpcfn"])
        .output()
        .map_err(|_| "lsof_unavailable".to_string())?;
    // lsof may exit 1 when it cannot inspect another user's process. Its field
    // output is still useful for the current user, and the report remains a
    // partial low-privilege snapshot rather than a claim of full coverage.
    if output.stdout.is_empty() { return Err("lsof_no_visible_output".to_string()); }
    String::from_utf8(output.stdout).map_err(|_| "lsof_invalid_output".to_string())
}

#[cfg(not(target_os = "macos"))]
fn lsof_raw() -> Result<String, String> {
    Err("runtime_sensor_unavailable_on_this_platform".to_string())
}

/// P3 六段子计时（TRUST_SENSOR_OPTIMIZATION spec §4.4，与 read_overview 的
/// 段级计时同款手法）：`lsof_spawn / lsof_parse / open / txn_insert /
/// correlate / outbox_emit`，单行 INFO——burst 分解有数据面，P1/P2 的效果
/// 验证与回归有基线（空轮也打点，便于区分「门控跳过」与「跑了但空」）。
#[derive(Debug, Default)]
pub struct SensorSegments {
    pub lsof_spawn: std::time::Duration,
    pub lsof_parse: std::time::Duration,
    pub open: std::time::Duration,
    pub txn_insert: std::time::Duration,
    pub correlate: std::time::Duration,
    pub outbox_emit: std::time::Duration,
}

impl SensorSegments {
    pub fn log_line(&self, total: std::time::Duration) -> String {
        format!(
            "trust 传感六段 lsof_spawn={:?} lsof_parse={:?} open={:?} txn_insert={:?} correlate={:?} outbox_emit={:?} total={:?}",
            self.lsof_spawn, self.lsof_parse, self.open, self.txn_insert,
            self.correlate, self.outbox_emit, total
        )
    }
}

/// Capture one explicit local-process snapshot and persist redacted evidence.
/// It intentionally does not install a watcher, request elevated permission,
/// show notifications, or run in the background.
pub fn snapshot_and_store(
    data_home: &std::path::Path, machine_namespace: &str, now_ms: i64,
) -> Result<TrustRuntimeSnapshotReport, String> {
    let t_total = std::time::Instant::now();
    let mut seg = SensorSegments::default();
    let t = std::time::Instant::now();
    let raw = match lsof_raw() {
        Ok(raw) => raw,
        Err(capability) => return Ok(TrustRuntimeSnapshotReport {
            capability, candidate_processes: 0, observations: 0, inserted: 0, duplicate: 0,
            findings_upserted: 0, notification_candidates: 0, evidence_links_added: 0,
            notification_keys: Vec::new(),
        }),
    };
    seg.lsof_spawn = t.elapsed();
    let t = std::time::Instant::now();
    let samples = parse_lsof_fields(&raw);
    seg.lsof_parse = t.elapsed();
    let identity = TrustIdentity::load_or_create(data_home)?;
    let observations = observations_from_samples(&samples, &identity, machine_namespace, now_ms);
    let candidate_processes = samples.iter().filter(|sample| sample.has_git_history && (sample.writes_archive || sample.writes_workspace_index)).count();
    let t = std::time::Instant::now();
    let authority = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home), now_ms,
    ).map_err(|error| format!("authority_open_failed:{error}"))?;
    let run_id = format!("trust-runtime-snapshot:{now_ms}");
    authority.begin_run(&run_id, "trust-runtime-snapshot", now_ms)
        .map_err(|error| format!("trust_runtime_run_begin_failed:{error}"))?;
    seg.open = t.elapsed();
    let write = authority.with_immediate_txn(|conn| {
        let t = std::time::Instant::now();
        let inserted = agent_vitals_data::trust::insert_observations(conn, &observations, &run_id, now_ms)?;
        seg.txn_insert = t.elapsed();
        let ids: Vec<String> = observations.iter().map(|row| row.observation_id.clone()).collect();
        let t = std::time::Instant::now();
        let correlation = agent_vitals_data::trust_correlator::correlate_selected(conn, &ids)?;
        seg.correlate = t.elapsed();
        // 事件总线（迭代 4）：有新观察才发——与写入同事务（spec §1.2）。correlate
        // 保持内联（它要原子地看到上面 insert 的观察）；事件是"这次传感发生了"
        // 的事实通知，P2 常驻传感器落地后复用同一通道与载荷形状。
        if inserted.inserted > 0 {
            let t = std::time::Instant::now();
            crate::events::insert_outbox(
                conn,
                &crate::events::AppEvent::trust_monitor_event(
                    &run_id, observations.len(), inserted.inserted,
                    correlation.findings_upserted,
                ),
                &run_id,
            ).map_err(|e| agent_vitals_data::authority::AuthorityError::Sqlite(
                rusqlite::Error::InvalidParameterName(format!("__trust_event__:{e}")),
            ))?;
            seg.outbox_emit = t.elapsed();
        }
        Ok((inserted, correlation))
    });
    let report = match write {
        Ok((inserted, correlation)) => {
            authority.finish_run(&run_id, "succeeded", None, None, now_ms)
                .map_err(|error| format!("trust_runtime_run_finish_failed:{error}"))?;
            Ok(TrustRuntimeSnapshotReport {
                capability: "macos_lsof_partial".to_string(), candidate_processes,
                observations: observations.len(), inserted: inserted.inserted, duplicate: inserted.duplicate,
                findings_upserted: correlation.findings_upserted, notification_candidates: correlation.notification_candidates,
                notification_keys: correlation.notification_keys,
                evidence_links_added: correlation.evidence_links_added,
            })
        }
        Err(error) => {
            let _ = authority.finish_run(&run_id, "failed", Some("trust_runtime_write_failed"), Some(&error.to_string()), now_ms);
            Err(format!("trust_runtime_write_failed:{error}"))
        }
    };
    crate::logging::log_info("trust_sensor", &seg.log_line(t_total.elapsed()));
    report
}

#[cfg(test)]
mod tests {
    use super::{observations_from_samples, parse_lsof_fields};
    use crate::trust_identity::TrustIdentity;

    #[test]
    fn parser_correlates_git_archive_and_connection_without_retaining_raw_fields() {
        let source = "p42\ncprivate-agent\nf3r\nn/Users/example/project/.git/objects/ab/cd\nf5w\nn/private/tmp/workspace-snapshot.enc\nf9u\nnTCP 127.0.0.1:50000->198.51.100.2:443 (ESTABLISHED)\n";
        let samples = parse_lsof_fields(source);
        assert_eq!(samples.len(), 1);
        let home = std::env::temp_dir().join(format!("av-trust-runtime-{}", std::process::id()));
        let identity = TrustIdentity::load_or_create(&home).unwrap();
        let observations = observations_from_samples(&samples, &identity, "machine", 120_000);
        assert_eq!(observations.len(), 2);
        for observation in observations {
            assert!(observation.validate().is_ok());
            assert!(!observation.actor_id.contains("private-agent"));
            assert!(!observation.provenance.to_string().contains("private"));
        }
    }

    #[test]
    fn parser_does_not_make_a_package_from_an_open_git_file_alone() {
        let source = "p42\ncgit\nf3r\nn/Users/example/project/.git/objects/ab/cd\nf9u\nnTCP 127.0.0.1:50000->198.51.100.2:443 (ESTABLISHED)\n";
        let samples = parse_lsof_fields(source);
        let home = std::env::temp_dir().join(format!("av-trust-runtime-no-package-{}", std::process::id()));
        let identity = TrustIdentity::load_or_create(&home).unwrap();
        assert!(observations_from_samples(&samples, &identity, "machine", 120_000).is_empty());
    }

    #[test]
    fn parser_treats_minimax_workspace_index_write_as_a_runtime_package_signal() {
        let source = "p42\ncMiniMax Code\nf3r\nn/Users/example/project/.git/objects/ab/cd\nf5u\nn/Users/example/.minimax/v2/sqlite/runtime-state.sqlite\nf9u\nnTCP 127.0.0.1:50000->127.0.0.1:7897 (ESTABLISHED)\n";
        let samples = parse_lsof_fields(source);
        let home = std::env::temp_dir().join(format!("av-trust-runtime-minimax-{}", std::process::id()));
        let identity = TrustIdentity::load_or_create(&home).unwrap();
        let observations = observations_from_samples(&samples, &identity, "machine", 120_000);
        assert_eq!(observations.len(), 2);
        assert!(observations.iter().all(|row| row.scope_classes.iter().any(|scope| scope == "workspace_index_state")));
        assert!(observations.iter().all(|row| row.validate().is_ok()));
        let _ = std::fs::remove_dir_all(home);
    }
}
