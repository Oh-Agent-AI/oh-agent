//! Deterministic, local-only Trust Observation to Finding projection.
//!
//! This consumes the redacted authority rows only.  It does not read source
//! files, make network requests, or assert anything about remote retention or
//! model training.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::{authority::AuthorityError, issues::{upsert_issue, IssueInput}, trust::link_issue_evidence};

const EVALUATOR_ID: &str = "trust-egress-correlator";
const EVALUATOR_VERSION: &str = "v1";
const INCIDENT_WINDOW_MS: i64 = 60 * 60 * 1000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustCorrelationReport {
    pub evaluated: usize,
    pub findings_upserted: usize,
    pub evidence_links_added: usize,
    pub findings_inserted: usize,
    pub findings_refreshed: usize,
    pub severity_upgraded: usize,
    pub stage_upgraded: usize,
    pub notification_candidates: usize,
    /// Stable per-Finding notification keys.  The desktop applies the user
    /// notification policy and cooldown; the correlator only says which
    /// changed findings are eligible.
    pub notification_keys: Vec<String>,
}

/// Safe aggregate for the desktop Finding surface.  It intentionally has no
/// actor, workspace, destination hostname, source anchor, or Observation id.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct TrustFindingSummary {
    pub issue_type: String,
    pub status: String,
    pub severity: String,
    pub finding_count: i64,
    pub most_recent_at_ms: i64,
}

#[derive(Debug)]
struct ObservationRow {
    id: String,
    machine: String,
    harness: String,
    actor: String,
    workspace: Option<String>,
    observed_at_ms: i64,
    stage: String,
    evidence_level: String,
    evidence_origin: String,
    scope_classes_json: String,
    destination_class: Option<String>,
    consent_kind: Option<String>,
    consent_state: String,
}

#[derive(Debug)]
struct Incident {
    machine: String,
    harness: String,
    actor: String,
    workspace: Option<String>,
    bucket: i64,
    rows: Vec<ObservationRow>,
}

fn stable_fingerprint(parts: &[&str]) -> String {
    // FNV-1a is deliberately specified here (rather than DefaultHasher): an
    // Issue identity must survive compiler/library upgrades and source replay.
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("trust_{hash:016x}")
}

fn evidence_rank(value: &str) -> u8 {
    match value { "E5" => 5, "E4" => 4, "E3" => 3, "E2" => 2, "E1" => 1, _ => 0 }
}

fn effective_level(row: &ObservationRow) -> &str {
    match (row.evidence_level.as_str(), row.evidence_origin.as_str()) {
        ("E5", "verified_receipt") => "E5",
        ("E5", _) => "E2",
        ("E4", "network_metadata") => "E4",
        ("E4", _) => "E3",
        _ => row.evidence_level.as_str(),
    }
}

fn confidence(rows: &[ObservationRow], level: &str) -> (&'static str, Vec<&'static str>) {
    let origins = rows.iter().map(|row| row.evidence_origin.as_str()).collect::<std::collections::BTreeSet<_>>();
    let verified_receipt = origins.contains("verified_receipt");
    let network_metadata = origins.contains("network_metadata");
    let runtime_metadata = origins.contains("runtime_process_metadata");
    match evidence_rank(level) {
        5 if verified_receipt => ("high", vec!["verified_receipt"]),
        5 => ("medium", vec!["unverified_acceptance_claim"]),
        4 if network_metadata => ("high", vec!["network_metadata"]),
        4 => ("medium", vec!["transmission_origin_unverified"]),
        3 if network_metadata && origins.len() >= 2 => ("high", vec!["network_metadata", "independent_support"]),
        3 if runtime_metadata => ("medium", vec!["runtime_process_correlation"]),
        3 => ("medium", vec!["network_attempt_origin_unverified"]),
        1 | 2 => ("medium", vec!["local_structural_evidence"]),
        _ => ("low", vec!["inferred_or_legacy_evidence"]),
    }
}

fn stage_rank(value: &str) -> u8 {
    match value {
        "read_observed" => 1,
        "package_observed" => 2,
        "credential_observed" => 3,
        "egress_attempted" => 4,
        "egress_transmitted" => 5,
        "remote_accepted" => 6,
        _ => 0,
    }
}

fn max_level<'a>(rows: impl Iterator<Item = &'a ObservationRow>) -> &'a str {
    rows.max_by_key(|row| evidence_rank(effective_level(row))).map(effective_level).unwrap_or("E0")
}

fn max_stage<'a>(rows: impl Iterator<Item = &'a ObservationRow>) -> &'a str {
    rows.max_by_key(|row| stage_rank(&row.stage)).map(|row| row.stage.as_str()).unwrap_or("read_observed")
}

fn safe_scope_classes(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default().into_iter()
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .collect()
}

fn candidates(incident: &Incident) -> Vec<(&'static str, &'static str, Value)> {
    let rows = &incident.rows;
    let scopes = rows.iter().flat_map(|row| safe_scope_classes(&row.scope_classes_json))
        .collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    let first = rows.iter().map(|row| row.observed_at_ms).min().unwrap_or(0);
    let last = rows.iter().map(|row| row.observed_at_ms).max().unwrap_or(first);
    let level = max_level(rows.iter());
    let stage = max_stage(rows.iter());
    let origins = rows.iter().map(|row| row.evidence_origin.as_str())
        .collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    let (incident_confidence, incident_confidence_reasons) = confidence(rows, level);
    let common = |coverage: &'static str| json!({
        "stage": stage, "evidence_level": level, "confidence": incident_confidence,
        "evidence_origins": origins, "confidence_reasons": incident_confidence_reasons,
        "scope_classes": scopes, "observation_count": rows.len(),
        "first_observed_at_ms": first, "last_observed_at_ms": last,
        "incident_bucket": incident.bucket, "coverage": coverage,
    });
    let mut out = Vec::new();
    if rows.iter().any(|row| row.stage == "package_observed") && scopes.iter().any(|scope| scope == "git_history") {
        out.push(("SV702", "warning", common("local_artifact")));
    }
    if rows.iter().any(|row| row.consent_state == "disabled" && row.consent_kind.is_some() && evidence_rank(effective_level(row)) >= 2) {
        let level = max_level(rows.iter().filter(|row| row.consent_state == "disabled" && row.consent_kind.is_some()));
        let severity = if evidence_rank(level) >= 3 { "critical" } else { "warning" };
        let mut metadata = common("consent_and_behavior");
        metadata["consent_state"] = json!("disabled");
        metadata["consent_kind"] = json!(rows.iter().find(|row| row.consent_state == "disabled" && row.consent_kind.is_some()).and_then(|row| row.consent_kind.clone()).unwrap_or_else(|| "unknown".to_string()));
        metadata["evidence_level"] = json!(level);
        metadata["confidence"] = json!(confidence(rows, level).0);
        out.push(("SV705", severity, metadata));
    }
    let has_upload_prep = rows.iter().any(|row| row.stage == "credential_observed" || row.destination_class.as_deref() == Some("vendor_api"));
    let has_object_storage = rows.iter().any(|row| row.destination_class.as_deref() == Some("object_storage") && evidence_rank(effective_level(row)) >= 3 && row.stage != "credential_observed");
    if has_upload_prep && has_object_storage {
        let level = max_level(rows.iter().filter(|row| row.destination_class.as_deref() == Some("object_storage")));
        let severity = if evidence_rank(level) >= 4 { "critical" } else { "warning" };
        let mut metadata = common("local_network_metadata");
        metadata["destination_class"] = json!("object_storage");
        metadata["evidence_level"] = json!(level);
        metadata["confidence"] = json!(confidence(rows, level).0);
        out.push(("SV709", severity, metadata));
    }
    out
}

fn incidents(rows: Vec<ObservationRow>) -> Vec<Incident> {
    let mut grouped: std::collections::BTreeMap<(String, String, String, String), Vec<ObservationRow>> = std::collections::BTreeMap::new();
    for row in rows {
        let workspace = row.workspace.clone().unwrap_or_else(|| "none".to_string());
        grouped.entry((row.machine.clone(), row.harness.clone(), row.actor.clone(), workspace)).or_default().push(row);
    }
    let mut out = Vec::new();
    for ((machine, harness, actor, workspace), mut rows) in grouped {
        rows.sort_by_key(|row| (row.observed_at_ms, row.id.clone()));
        let mut window = Vec::new();
        for row in rows {
            let split = window.last().is_some_and(|previous: &ObservationRow| {
                row.observed_at_ms.saturating_sub(previous.observed_at_ms) > 30 * 60 * 1000
                    || row.observed_at_ms.saturating_sub(window.first().map(|first: &ObservationRow| first.observed_at_ms).unwrap_or(row.observed_at_ms)) >= INCIDENT_WINDOW_MS
            });
            if split && !window.is_empty() {
                let bucket = window.first().map(|first: &ObservationRow| first.observed_at_ms.div_euclid(INCIDENT_WINDOW_MS)).unwrap_or(0);
                out.push(Incident { machine: machine.clone(), harness: harness.clone(), actor: actor.clone(), workspace: (workspace != "none").then_some(workspace.clone()), bucket, rows: std::mem::take(&mut window) });
            }
            window.push(row);
        }
        if !window.is_empty() {
            let bucket = window.first().map(|first: &ObservationRow| first.observed_at_ms.div_euclid(INCIDENT_WINDOW_MS)).unwrap_or(0);
            out.push(Incident { machine: machine.clone(), harness: harness.clone(), actor: actor.clone(), workspace: (workspace != "none").then_some(workspace.clone()), bucket, rows: window });
        }
    }
    out.sort_by_key(|incident| (incident.rows.first().map(|row| row.observed_at_ms).unwrap_or(0), incident.machine.clone(), incident.harness.clone(), incident.actor.clone(), incident.bucket));
    out
}

/// Project supported multi-signal-safe observations into durable Issues.
///
/// The correlator intentionally leaves unsupported rules unavailable rather
/// than inventing a conclusion.  All identifiers used for instance identity
/// are hashed; Issue metadata contains only the spec allowlist.
pub fn correlate(conn: &Connection) -> Result<TrustCorrelationReport, AuthorityError> {
    correlate_selected(conn, &[])
}

/// Project only observations created or refreshed by the current collector.
/// An empty selection retains the full authority re-evaluation behavior used by
/// migrations and tests. Incremental collectors must pass their own IDs so a
/// harmless scan does not inflate its report with another harness's old evidence.
pub fn correlate_selected(
    conn: &Connection, observation_ids: &[String],
) -> Result<TrustCorrelationReport, AuthorityError> {
    let mut stmt = conn.prepare(
        "SELECT observation_id, machine_namespace, harness, actor_id, workspace_ref,
                observed_at_ms, stage, evidence_level, evidence_origin, scope_classes_json,
                destination_class, consent_kind, consent_state
         FROM trust_observations ORDER BY observed_at_ms, observation_id",
    )?;
    let rows = stmt.query_map([], |row| Ok(ObservationRow {
        id: row.get(0)?, machine: row.get(1)?, harness: row.get(2)?, actor: row.get(3)?,
        workspace: row.get(4)?, observed_at_ms: row.get(5)?, stage: row.get(6)?,
        evidence_level: row.get(7)?, evidence_origin: row.get(8)?, scope_classes_json: row.get(9)?,
        destination_class: row.get(10)?, consent_kind: row.get(11)?, consent_state: row.get(12)?,
    }))?.collect::<Result<Vec<_>, _>>()?;
    let mut report = TrustCorrelationReport::default();
    for incident in incidents(rows) {
        if !observation_ids.is_empty() && !incident.rows.iter().any(|row| observation_ids.iter().any(|id| id == &row.id)) {
            continue;
        }
        report.evaluated += incident.rows.len();
        for (issue_type, severity, metadata) in candidates(&incident) {
            let workspace = incident.workspace.as_deref().unwrap_or("none");
            let bucket = incident.bucket.to_string();
            let instance = stable_fingerprint(&[issue_type, &incident.machine, &incident.harness, &incident.actor, workspace, &bucket]);
            let ids = incident.rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>();
            let evidence = stable_fingerprint(&[issue_type, &ids.join("|"), metadata["evidence_level"].as_str().unwrap_or("E0")]);
            let previous: Option<(String, String, String)> = conn.query_row(
                "SELECT status, severity, metadata_json FROM issue_instances WHERE machine_namespace=?1 AND issue_type=?2 AND instance_fingerprint=?3",
                rusqlite::params![incident.machine, issue_type, instance],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional()?;
            let issue_id = upsert_issue(conn, &IssueInput {
                machine_namespace: &incident.machine, harness: &incident.harness, session_key: None,
                issue_type, instance_fingerprint: &instance, status: "open", severity,
                evaluator_id: EVALUATOR_ID, evaluator_version: EVALUATOR_VERSION,
                evidence_fingerprint: &evidence, opened_at_ms: incident.rows.first().map(|row| row.observed_at_ms).unwrap_or(0),
                metadata_json: &metadata.to_string(),
            })?;
            report.findings_upserted += 1;
            let mut changed = false;
            match previous {
                None => { report.findings_inserted += 1; changed = true; }
                Some((_, old_severity, old_metadata)) => {
                    report.findings_refreshed += 1;
                    let old_rank = match old_severity.as_str() { "critical" => 3, "warning" => 2, _ => 1 };
                    let new_rank = match severity { "critical" => 3, "warning" => 2, _ => 1 };
                    if new_rank > old_rank { report.severity_upgraded += 1; changed = true; }
                    let old_stage = serde_json::from_str::<Value>(&old_metadata).ok().and_then(|value| value.get("stage").and_then(Value::as_str).map(str::to_owned));
                    let new_stage = metadata.get("stage").and_then(Value::as_str).map(str::to_owned);
                    if old_stage.as_deref().map(stage_rank).unwrap_or(0) < new_stage.as_deref().map(stage_rank).unwrap_or(0) { report.stage_upgraded += 1; changed = true; }
                }
            }
            let level_rank = metadata.get("evidence_level").and_then(Value::as_str).map(evidence_rank).unwrap_or(0);
            let eligible_notification = level_rank >= 4 || (severity == "critical" && metadata.get("confidence").and_then(Value::as_str).unwrap_or("low") != "low");
            let suppressed: i64 = conn.query_row(
                "SELECT COUNT(*) FROM trust_suppressions
                 WHERE issue_type = ?1 AND revoked_at_ms IS NULL
                   AND (instance_fingerprint IS NULL OR instance_fingerprint = ?2)",
                rusqlite::params![issue_type, instance], |row| row.get(0),
            )?;
            if eligible_notification && suppressed == 0 && changed {
                report.notification_candidates += 1;
                report.notification_keys.push(instance.clone());
            }
            for row in &incident.rows {
                if link_issue_evidence(conn, &issue_id, &row.id, "supporting", row.observed_at_ms)? {
                    report.evidence_links_added += 1;
                }
            }
        }
    }
    Ok(report)
}

/// Read the safe Trust Finding rollup without scanning harness files.
pub fn findings_summary(conn: &Connection) -> Result<Vec<TrustFindingSummary>, AuthorityError> {
    let mut stmt = conn.prepare(
        "SELECT issue_type, status, severity, COUNT(*), MAX(opened_at_ms) AS most_recent_at_ms
         FROM issue_instances
         WHERE issue_type IN ('SV701','SV702','SV703','SV704','SV705','SV706','SV707','SV708','SV709','SV710')
           AND NOT EXISTS (
             SELECT 1 FROM trust_suppressions
             WHERE trust_suppressions.issue_type = issue_instances.issue_type
               AND trust_suppressions.revoked_at_ms IS NULL
               AND (trust_suppressions.instance_fingerprint IS NULL
                    OR trust_suppressions.instance_fingerprint = issue_instances.instance_fingerprint)
           )
         GROUP BY issue_type, status, severity
         ORDER BY most_recent_at_ms DESC, issue_type ASC",
    )?;
    let rows = stmt.query_map([], |row| Ok(TrustFindingSummary {
        issue_type: row.get(0)?, status: row.get(1)?, severity: row.get(2)?,
        finding_count: row.get(3)?, most_recent_at_ms: row.get(4)?,
    }))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::{candidates, correlate, incidents, Incident, ObservationRow};
    use crate::authority::AuthorityDb;
    use serde_json::Value;

    fn tmp_db(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("agent-vitals-trust-correlator-{tag}-{}", std::process::id()))
    }

    #[test]
    fn correlates_supported_rules_without_leaking_identity_to_metadata() {
        let path = tmp_db("correlation");
        std::fs::remove_file(&path).ok();
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "test", 1).unwrap();
        db.conn().execute_batch(
            "INSERT INTO trust_observations(
                observation_id, machine_namespace, harness, actor_id, actor_kind, observed_at_ms,
                observation_kind, stage, evidence_level, workspace_ref, scope_classes_json,
                destination_class, destination_host, consent_kind, consent_state, collector_id, collector_version,
                provenance_json, ingested_run_id, created_at_ms
             ) VALUES
                ('history', 'machine', 'zcode', 'actor-private', 'sidecar', 1, 'package',
                 'package_observed', 'E1', 'workspace-private', '[\"git_history\"]', NULL, NULL,
                 NULL, 'unavailable', 'test', 'v1', '{}', 'run', 1),
                ('consent', 'machine', 'zcode', 'actor-private', 'sidecar', 2, 'credential',
                 'credential_observed', 'E2', 'workspace-private', '[]', 'vendor_api', NULL,
                 'indexing', 'disabled', 'test', 'v1', '{}', 'run', 1),
                ('object', 'machine', 'zcode', 'actor-private', 'sidecar', 3, 'connection',
                 'egress_attempted', 'E3', 'workspace-private', '[]', 'object_storage', 'bucket.example.com',
                 NULL, 'unavailable', 'test', 'v1', '{}', 'run', 1);",
        ).unwrap();
        let report = db.with_immediate_txn(correlate).unwrap();
        assert_eq!((report.evaluated, report.findings_upserted, report.evidence_links_added), (3, 3, 9));
        let issues: Vec<(String, String)> = db.conn().prepare(
            "SELECT issue_type, metadata_json FROM issue_instances ORDER BY issue_type",
        ).unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(issues.iter().map(|(kind, _)| kind.as_str()).collect::<Vec<_>>(), vec!["SV702", "SV705", "SV709"]);
        for (_, metadata) in issues {
            assert!(!metadata.contains("actor-private"));
            assert!(!metadata.contains("workspace-private"));
            assert!(!metadata.contains("bucket.example.com"));
        }
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM trust_issue_evidence", [], |r| r.get::<_, i64>(0)).unwrap(), 9);
        let summary = super::findings_summary(db.conn()).unwrap();
        assert_eq!(summary.iter().map(|row| row.issue_type.as_str()).collect::<Vec<_>>(), vec!["SV702", "SV705", "SV709"]);
        std::fs::remove_file(path).ok();
    }

    fn row(id: &str, at: i64) -> ObservationRow {
        ObservationRow {
            id: id.into(), machine: "m".into(), harness: "h".into(), actor: "a".into(),
            workspace: Some("w".into()), observed_at_ms: at, stage: "package_observed".into(),
            evidence_level: "E1".into(), evidence_origin: "local_artifact".into(), scope_classes_json: "[]".into(),
            destination_class: None, consent_kind: None, consent_state: "unavailable".into(),
        }
    }

    #[test]
    fn incident_window_is_rolling_and_splits_after_thirty_minutes() {
        let rows = vec![
            row("a", 1_000),
            row("b", 1_000 + 29 * 60 * 1000),
            row("c", 1_000 + 29 * 60 * 1000 + 31 * 60 * 1000),
        ];
        let grouped = incidents(rows);
        assert_eq!(grouped.len(), 2, "a 31 minute gap starts a new Incident");
        assert_eq!(grouped[0].rows.len(), 2);
        assert_eq!(grouped[0].rows[0].id, "a");
        assert_eq!(grouped[0].rows[1].id, "b");
        assert_eq!(grouped[1].rows[0].id, "c");
    }

    #[test]
    fn object_storage_connection_alone_is_not_sv709() {
        let mut object = row("object", 1);
        object.stage = "egress_attempted".into();
        object.evidence_level = "E3".into();
        object.destination_class = Some("object_storage".into());
        let incident = Incident {
            machine: "m".into(), harness: "h".into(), actor: "a".into(), workspace: Some("w".into()),
            bucket: 0, rows: vec![object],
        };
        assert!(!candidates(&incident).iter().any(|(code, _, _)| *code == "SV709"));
    }

    #[test]
    fn unverified_legacy_acceptance_cannot_elevate_the_incident_to_e5() {
        let mut legacy = row("legacy-accepted", 1);
        legacy.evidence_level = "E5".into();
        legacy.evidence_origin = "unknown_legacy".into();
        legacy.scope_classes_json = "[\"git_history\"]".into();
        let incident = Incident {
            machine: "m".into(), harness: "h".into(), actor: "a".into(), workspace: Some("w".into()),
            bucket: 0, rows: vec![legacy],
        };
        let metadata = candidates(&incident).into_iter().find(|(code, _, _)| *code == "SV702").unwrap().2;
        assert_eq!(metadata["evidence_level"], "E2");
        assert_eq!(metadata["confidence"], "medium");
        assert!(metadata["confidence_reasons"].to_string().contains("local_structural_evidence"));
    }

    #[test]
    fn redacted_fixture_contract_is_shared_with_python_mirror() {
        let payload: Value = serde_json::from_str(include_str!("../../../fixtures/trust/correlation_cases.json")).unwrap();
        assert_eq!(payload["schema_version"], "trust-correlation-v1");
        let cases = payload["cases"].as_array().unwrap();
        assert_eq!(cases[0]["expected"]["finding_types"], serde_json::json!(["SV702", "SV705", "SV709"]));
        assert_eq!(cases[0]["expected"]["evidence_links"], 9);
        assert_eq!(cases[1]["expected"]["finding_types"], serde_json::json!([]));
        assert_eq!(cases[1]["expected"]["evidence_links"], 0);
    }

    #[test]
    fn harness_chain_fixtures_never_claim_remote_acceptance() {
        for raw in [
            include_str!("../../../fixtures/trust/zcode_complete_chain.json"),
            include_str!("../../../fixtures/trust/minimax_missing_chain.json"),
        ] {
            let value: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(value["schema_version"], "trust-egress-fixture-v1");
            assert_eq!(value["expected"]["remote_accepted"], false);
            assert!(!raw.contains("Authorization"));
            assert!(!raw.contains("signature"));
        }
    }

    #[test]
    fn notification_candidates_cover_insert_refresh_stage_and_suppression() {
        let path = tmp_db("notification");
        std::fs::remove_file(&path).ok();
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("notify-run", "test", 1).unwrap();
        let insert = |conn: &rusqlite::Connection, id: &str, stage: &str, level: &str, at: i64| {
            conn.execute(
                "INSERT INTO trust_observations(
                    observation_id, machine_namespace, harness, actor_id, actor_kind, observed_at_ms,
                    observation_kind, stage, evidence_level, evidence_origin, workspace_ref, scope_classes_json,
                    destination_class, destination_host, consent_kind, consent_state, collector_id,
                    collector_version, provenance_json, ingested_run_id, created_at_ms)
                 VALUES (?1,'m','zcode','a','sidecar',?4,'connection',?2,?3,?5,'w','[]',?6,NULL,NULL,'unavailable','test','v1','{}','notify-run',?4)",
                rusqlite::params![id, stage, level, at,
                    if level == "E5" { "verified_receipt" } else if level == "E4" { "network_metadata" } else { "local_artifact" },
                    if stage == "credential_observed" { "vendor_api" } else { "object_storage" }],
            ).unwrap();
        };
        insert(db.conn(), "credential", "credential_observed", "E2", 1_000);
        insert(db.conn(), "upload", "egress_transmitted", "E4", 1_001);
        let first = db.with_immediate_txn(correlate).unwrap();
        assert_eq!(first.notification_candidates, 1);
        let refresh = db.with_immediate_txn(correlate).unwrap();
        assert_eq!(refresh.notification_candidates, 0);
        insert(db.conn(), "accepted", "remote_accepted", "E5", 1_002);
        let upgraded = db.with_immediate_txn(correlate).unwrap();
        assert_eq!(upgraded.notification_candidates, 1);
        db.trust_suppression_set("sup-notify", "SV709", None, "reviewed", 1_003).unwrap();
        insert(db.conn(), "accepted-2", "remote_accepted", "E5", 1_004);
        let suppressed = db.with_immediate_txn(correlate).unwrap();
        assert_eq!(suppressed.notification_candidates, 0);
        assert!(super::findings_summary(db.conn()).unwrap().is_empty(), "suppressed Trust findings stay out of open summary");
        std::fs::remove_file(path).ok();
    }
}
