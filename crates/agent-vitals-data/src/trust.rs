//! Authority persistence for Finding 2.0 local trust observations.
//!
//! This module stores only the redacted, bounded contract from
//! `agent_vitals_domain::trust`.  It intentionally has no harness parsing,
//! correlation, notification, network interception, or raw-evidence reader.

use agent_vitals_domain::trust::TrustObservation;
use rusqlite::{Connection, params};

use crate::authority::AuthorityError;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustObservationInsertReport {
    pub inserted: usize,
    pub duplicate: usize,
}

fn invalid(reason: &'static str) -> AuthorityError {
    AuthorityError::Sqlite(rusqlite::Error::InvalidParameterName(
        format!("__invalid_trust_observation__:{reason}"),
    ))
}

/// Insert a replay-safe batch of redacted observations.
///
/// Identity is adapter-owned: the same physical observation must keep its
/// `observation_id` across source replays.  Existing rows are never rewritten;
/// a parser upgrade may emit an additional, distinctly identified observation
/// rather than silently changing the evidence behind an open Finding.
pub fn insert_observations(
    conn: &Connection,
    observations: &[TrustObservation],
    run_id: &str,
    now_ms: i64,
) -> Result<TrustObservationInsertReport, AuthorityError> {
    if now_ms < 0 { return Err(invalid("created_at_ms is negative")); }
    for observation in observations {
        observation.validate().map_err(invalid)?;
    }
    // Reuse the authority writer's run-existence guard.  Trust observations
    // are ingest facts too: a row without a completed/auditable batch must not
    // be allowed to appear merely because SQLite FK enforcement changed.
    let _writer = crate::fact_writer_sql::SqlFactWriter::new(conn, run_id, now_ms)?;
    let mut report = TrustObservationInsertReport::default();
    for observation in observations {
        let scope_classes_json = serde_json::to_string(&observation.scope_classes)
            .map_err(|_| invalid("scope classes cannot be serialized"))?;
        let changed = conn.execute(
            "INSERT OR IGNORE INTO trust_observations(
                 observation_id, machine_namespace, harness, actor_id, actor_kind, actor_version,
                 observed_at_ms, observation_kind, stage, evidence_level, evidence_origin, workspace_ref,
                 scope_classes_json, file_count, byte_count, destination_class, destination_host,
                 consent_kind, consent_state, source_id, native_event_id, source_line, source_byte_offset,
                 collector_id, collector_version, provenance_json, expires_at_ms,
                 ingested_run_id, created_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)",
            params![
                observation.observation_id, observation.machine_namespace, observation.harness,
                observation.actor_id, observation.actor_kind.as_str(), observation.actor_version,
                observation.observed_at_ms, observation.observation_kind.as_str(), observation.stage.as_str(),
                observation.evidence_level.as_str(), observation.evidence_origin.as_str(), observation.workspace_ref, scope_classes_json,
                observation.file_count, observation.byte_count,
                observation.destination_class.map(|value| value.as_str()), observation.destination_host,
                observation.consent_kind.map(|value| value.as_str()), observation.consent_state.as_str(), observation.source_id, observation.native_event_id,
                observation.source_line, observation.source_byte_offset, observation.collector_id,
                observation.collector_version, observation.provenance.to_string(), observation.expires_at_ms,
                run_id, now_ms,
            ],
        )?;
        if changed == 1 { report.inserted += 1; } else { report.duplicate += 1; }
    }
    Ok(report)
}

/// Associate one persisted observation with an existing durable Issue.
///
/// Roles are deliberately narrow: a correlator can say what supports or
/// contradicts a conclusion without putting raw evidence in `metadata_json`.
pub fn link_issue_evidence(
    conn: &Connection,
    issue_id: &str,
    observation_id: &str,
    evidence_role: &str,
    linked_at_ms: i64,
) -> Result<bool, AuthorityError> {
    if issue_id.is_empty() || observation_id.is_empty() || linked_at_ms < 0 {
        return Err(invalid("evidence link identity or time is invalid"));
    }
    if !matches!(evidence_role, "supporting" | "contradicting" | "context") {
        return Err(invalid("evidence link role is invalid"));
    }
    Ok(conn.execute(
        "INSERT OR IGNORE INTO trust_issue_evidence(issue_id, observation_id, evidence_role, linked_at_ms)
         VALUES (?1,?2,?3,?4)",
        params![issue_id, observation_id, evidence_role, linked_at_ms],
    )? == 1)
}

/// Local-detail-only evidence timeline for one Trust Finding. The projection
/// intentionally omits actor/workspace identifiers, destination hostname,
/// source anchors and native event ids; those fields must not reach generic
/// query, MCP, or export surfaces.
pub fn issue_timeline(conn: &Connection, issue_id: &str) -> rusqlite::Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
         "SELECT observation_kind, stage, evidence_level, evidence_origin, observed_at_ms,
                scope_classes_json, destination_class, consent_state,
                collector_id, collector_version
         FROM trust_issue_evidence link
         JOIN trust_observations observation ON observation.observation_id = link.observation_id
         WHERE link.issue_id = ?1
         ORDER BY observation.observed_at_ms, observation.observation_id",
    )?;
    let rows = stmt.query_map([issue_id], |row| {
        let scopes: String = row.get(5)?;
        let scopes = serde_json::from_str::<Vec<String>>(&scopes).unwrap_or_default()
            .into_iter().filter(|scope| !scope.is_empty() && scope.len() <= 64).collect::<Vec<_>>();
        Ok(serde_json::json!({
            "observation_kind": row.get::<_, String>(0)?, "stage": row.get::<_, String>(1)?,
            "evidence_level": row.get::<_, String>(2)?, "evidence_origin": row.get::<_, String>(3)?, "observed_at_ms": row.get::<_, i64>(4)?,
            "scope_classes": scopes, "destination_class": row.get::<_, Option<String>>(6)?,
            "consent_state": row.get::<_, String>(7)?, "collector_id": row.get::<_, String>(8)?,
            "collector_version": row.get::<_, String>(9)?,
        }))
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::{insert_observations, issue_timeline, link_issue_evidence};
    use crate::{authority::AuthorityDb, issues::{IssueInput, upsert_issue}};
    use agent_vitals_domain::trust::{TrustActorKind, TrustConsentState, TrustDestinationClass, TrustEvidenceLevel, TrustEvidenceOrigin, TrustObservation, TrustObservationKind, TrustStage};
    use serde_json::json;

    fn tmp_db(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("agent-vitals-trust-{name}-{}", std::process::id()))
    }

    fn observation() -> TrustObservation {
        TrustObservation {
            observation_id: "obs-1".into(), machine_namespace: "machine-1".into(), harness: "zcode".into(),
            actor_id: "actor-1".into(), actor_kind: TrustActorKind::Sidecar, actor_version: Some("3.14.0".into()),
            observed_at_ms: 10, observation_kind: TrustObservationKind::Package, stage: TrustStage::PackageObserved,
            evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref: Some("ws-1".into()),
            scope_classes: vec!["workspace_current".into(), "git_history".into()], file_count: Some(2), byte_count: Some(3),
            destination_class: Some(TrustDestinationClass::ObjectStorage), destination_host: Some("bucket.example.com".into()),
            consent_kind: None, consent_state: TrustConsentState::Unavailable, source_id: None, native_event_id: Some("manifest-1".into()),
            source_line: Some(1), source_byte_offset: Some(0), collector_id: "zcode-history".into(), collector_version: "v1".into(),
            provenance: json!({"kind": "baseline", "failure_count": 0}), expires_at_ms: Some(20),
        }
    }

    #[test]
    fn insert_is_idempotent_and_link_is_bounded() {
        let path = tmp_db("insert-link");
        std::fs::remove_file(&path).ok();
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "test", 1).unwrap();
        db.with_immediate_txn(|conn| {
            let first = insert_observations(conn, &[observation()], "run", 2)?;
            assert_eq!((first.inserted, first.duplicate), (1, 0));
            let again = insert_observations(conn, &[observation()], "run", 2)?;
            assert_eq!((again.inserted, again.duplicate), (0, 1));
            let input = IssueInput {
                machine_namespace: "machine-1", harness: "zcode", session_key: None,
                issue_type: "SV702", instance_fingerprint: "issue-1", status: "open", severity: "warning",
                evaluator_id: "trust-egress-correlator", evaluator_version: "v1", evidence_fingerprint: "evidence-1",
                opened_at_ms: 2, metadata_json: r#"{"stage":"package_observed","evidence_level":"E1"}"#,
            };
            let issue_id = upsert_issue(conn, &input)?;
            assert!(link_issue_evidence(conn, &issue_id, "obs-1", "supporting", 2)?);
            assert!(!link_issue_evidence(conn, &issue_id, "obs-1", "supporting", 2)?);
            Ok(())
        }).unwrap();
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM trust_observations", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM trust_issue_evidence", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        let issue_id = db.conn().query_row("SELECT issue_id FROM trust_issue_evidence LIMIT 1", [], |row| row.get::<_, String>(0)).unwrap();
        let timeline = issue_timeline(db.conn(), &issue_id).unwrap();
        assert_eq!(timeline.len(), 1);
        let serialized = timeline[0].to_string();
        assert!(serialized.contains("git_history"));
        assert!(!serialized.contains("actor-1"));
        assert!(!serialized.contains("bucket.example.com"));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn raw_path_is_rejected_before_insert() {
        let path = tmp_db("raw-path");
        std::fs::remove_file(&path).ok();
        let db = AuthorityDb::open(&path, 1).unwrap();
        db.begin_run("run", "test", 1).unwrap();
        let mut unsafe_value = observation();
        unsafe_value.workspace_ref = Some("/Users/Admin/project".into());
        let result = db.with_immediate_txn(|conn| insert_observations(conn, &[unsafe_value], "run", 2));
        assert!(result.is_err());
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM trust_observations", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        std::fs::remove_file(path).ok();
    }
}
