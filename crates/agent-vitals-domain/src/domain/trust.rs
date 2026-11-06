//! Harness-neutral contract for local Agent trust observations.
//!
//! The contract deliberately describes locally observable stages, not a
//! cloud-side use claim.  In particular, an upload attempt is not evidence
//! that a remote service accepted, retained, trained on, or exposed data.

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustStage {
    ReadObserved,
    PackageObserved,
    CredentialObserved,
    EgressAttempted,
    EgressTransmitted,
    RemoteAccepted,
}

impl TrustStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustStage::ReadObserved => "read_observed",
            TrustStage::PackageObserved => "package_observed",
            TrustStage::CredentialObserved => "credential_observed",
            TrustStage::EgressAttempted => "egress_attempted",
            TrustStage::EgressTransmitted => "egress_transmitted",
            TrustStage::RemoteAccepted => "remote_accepted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustEvidenceLevel {
    E0Inferred,
    E1LocalArtifact,
    E2UploadReady,
    E3NetworkAttempt,
    E4Transmitted,
    E5Accepted,
}

/// Where the local collector obtained an observation.  This describes the
/// evidence source, not what a remote service did with the data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustEvidenceOrigin {
    LocalArtifact,
    ClientStateClaim,
    RuntimeProcessMetadata,
    NetworkMetadata,
    VerifiedReceipt,
    UnknownLegacy,
}

impl TrustEvidenceOrigin {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustEvidenceOrigin::LocalArtifact => "local_artifact",
            TrustEvidenceOrigin::ClientStateClaim => "client_state_claim",
            TrustEvidenceOrigin::RuntimeProcessMetadata => "runtime_process_metadata",
            TrustEvidenceOrigin::NetworkMetadata => "network_metadata",
            TrustEvidenceOrigin::VerifiedReceipt => "verified_receipt",
            TrustEvidenceOrigin::UnknownLegacy => "unknown_legacy",
        }
    }
}

impl TrustEvidenceLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustEvidenceLevel::E0Inferred => "E0",
            TrustEvidenceLevel::E1LocalArtifact => "E1",
            TrustEvidenceLevel::E2UploadReady => "E2",
            TrustEvidenceLevel::E3NetworkAttempt => "E3",
            TrustEvidenceLevel::E4Transmitted => "E4",
            TrustEvidenceLevel::E5Accepted => "E5",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustActorKind {
    Main,
    Sidecar,
    Helper,
    Extension,
    Unknown,
}

impl TrustActorKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustActorKind::Main => "main",
            TrustActorKind::Sidecar => "sidecar",
            TrustActorKind::Helper => "helper",
            TrustActorKind::Extension => "extension",
            TrustActorKind::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustObservationKind {
    FileScope,
    Package,
    Credential,
    Connection,
    OutboundBytes,
    RemoteAck,
    ConsentState,
    Retry,
}

impl TrustObservationKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustObservationKind::FileScope => "file_scope",
            TrustObservationKind::Package => "package",
            TrustObservationKind::Credential => "credential",
            TrustObservationKind::Connection => "connection",
            TrustObservationKind::OutboundBytes => "outbound_bytes",
            TrustObservationKind::RemoteAck => "remote_ack",
            TrustObservationKind::ConsentState => "consent_state",
            TrustObservationKind::Retry => "retry",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustDestinationClass {
    VendorApi,
    ObjectStorage,
    Telemetry,
    Eval,
    ModelApi,
    Unknown,
}

impl TrustDestinationClass {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustDestinationClass::VendorApi => "vendor_api",
            TrustDestinationClass::ObjectStorage => "object_storage",
            TrustDestinationClass::Telemetry => "telemetry",
            TrustDestinationClass::Eval => "eval",
            TrustDestinationClass::ModelApi => "model_api",
            TrustDestinationClass::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustConsentState {
    Enabled,
    Disabled,
    Unavailable,
    Ambiguous,
}

impl TrustConsentState {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustConsentState::Enabled => "enabled",
            TrustConsentState::Disabled => "disabled",
            TrustConsentState::Unavailable => "unavailable",
            TrustConsentState::Ambiguous => "ambiguous",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustConsentKind {
    Indexing,
    Telemetry,
    Improvement,
    Privacy,
    OtherDeclared,
}

impl TrustConsentKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            TrustConsentKind::Indexing => "indexing",
            TrustConsentKind::Telemetry => "telemetry",
            TrustConsentKind::Improvement => "improvement",
            TrustConsentKind::Privacy => "privacy",
            TrustConsentKind::OtherDeclared => "other_declared",
        }
    }
}

/// One redacted, replay-safe observation from a local Agent client or sidecar.
///
/// `workspace_ref` and `actor_id` must already be irreversible local references;
/// neither may be a raw path, command line, account, or process title.
#[derive(Clone, Debug, PartialEq)]
pub struct TrustObservation {
    pub observation_id: String,
    pub machine_namespace: String,
    pub harness: String,
    pub actor_id: String,
    pub actor_kind: TrustActorKind,
    pub actor_version: Option<String>,
    pub observed_at_ms: i64,
    pub observation_kind: TrustObservationKind,
    pub stage: TrustStage,
    pub evidence_level: TrustEvidenceLevel,
    pub evidence_origin: TrustEvidenceOrigin,
    pub workspace_ref: Option<String>,
    pub scope_classes: Vec<String>,
    pub file_count: Option<i64>,
    pub byte_count: Option<i64>,
    pub destination_class: Option<TrustDestinationClass>,
    /// Normalized hostname only; never a URL, signed object key, or query.
    pub destination_host: Option<String>,
    pub consent_kind: Option<TrustConsentKind>,
    pub consent_state: TrustConsentState,
    pub source_id: Option<String>,
    pub native_event_id: Option<String>,
    pub source_line: Option<i64>,
    pub source_byte_offset: Option<i64>,
    pub collector_id: String,
    pub collector_version: String,
    /// Bounded counters and enum-like labels only; never text copied from a
    /// workspace, request body, token, URL, or credential.
    pub provenance: Value,
    pub expires_at_ms: Option<i64>,
}

fn valid_bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}

fn valid_hostname(value: &str) -> bool {
    valid_bounded(value)
        && !value.contains(['/', '\\', '?', '#', '@', ':'])
        && value.split('.').all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

fn valid_ref(value: &str) -> bool {
    valid_bounded(value)
        && !value.contains(['/', '\\'])
        && !value.contains("://")
        && !value.contains("Bearer ")
        && !value.contains("token=")
        // IDs, categories and irreversible references deliberately exclude
        // whitespace and free-form punctuation.  A producer cannot smuggle an
        // excerpt, command line or prose field into a convenient `String`.
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

fn valid_provenance(value: &Value, depth: usize) -> bool {
    if depth > 3 { return false; }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => valid_ref(value),
        Value::Array(values) => values.len() <= 16 && values.iter().all(|value| valid_provenance(value, depth + 1)),
        Value::Object(values) => values.len() <= 32 && values.iter().all(|(key, value)| {
            valid_bounded(key) && valid_provenance(value, depth + 1)
        }),
    }
}

impl TrustObservation {
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [
            self.observation_id.as_str(), self.machine_namespace.as_str(), self.harness.as_str(),
            self.actor_id.as_str(), self.collector_id.as_str(), self.collector_version.as_str(),
        ] {
            if !valid_ref(value) {
                return Err("trust observation identifier is empty, unsafe, or too long");
            }
        }
        for value in [self.actor_version.as_deref(), self.source_id.as_deref(), self.native_event_id.as_deref()].into_iter().flatten() {
            if !valid_ref(value) {
                return Err("trust observation optional identifier is empty, unsafe, or too long");
            }
        }
        if let Some(workspace_ref) = self.workspace_ref.as_deref() {
            if !valid_ref(workspace_ref) {
                return Err("trust observation workspace ref is unsafe");
            }
        }
        if let Some(hostname) = self.destination_host.as_deref() {
            if !valid_hostname(hostname) {
                return Err("trust observation destination is not a hostname");
            }
        }
        if self.consent_state == TrustConsentState::Disabled && self.consent_kind.is_none() {
            return Err("disabled consent requires consent_kind");
        }
        if self.observed_at_ms < 0 || self.expires_at_ms.is_some_and(|value| value < self.observed_at_ms) {
            return Err("trust observation timestamp is invalid");
        }
        for value in [self.file_count, self.byte_count, self.source_line, self.source_byte_offset].into_iter().flatten() {
            if value < 0 { return Err("trust observation count is negative"); }
        }
        if self.scope_classes.len() > 16 || self.scope_classes.iter().any(|value| !valid_ref(value)) {
            return Err("trust observation scope class is invalid");
        }
        if !valid_provenance(&self.provenance, 0) {
            return Err("trust observation provenance is unsafe or too large");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{TrustActorKind, TrustConsentState, TrustDestinationClass, TrustEvidenceLevel, TrustEvidenceOrigin, TrustObservation, TrustObservationKind, TrustStage};
    use serde_json::json;

    fn observation() -> TrustObservation {
        TrustObservation {
            observation_id: "obs_01".into(), machine_namespace: "machine_01".into(),
            harness: "zcode".into(), actor_id: "actor_01".into(), actor_kind: TrustActorKind::Sidecar,
            actor_version: Some("3.14.0".into()), observed_at_ms: 1,
            observation_kind: TrustObservationKind::Package, stage: TrustStage::PackageObserved,
            evidence_level: TrustEvidenceLevel::E1LocalArtifact, evidence_origin: TrustEvidenceOrigin::LocalArtifact, workspace_ref: Some("ws_01".into()),
            scope_classes: vec!["workspace_current".into(), "git_history".into()], file_count: Some(2),
            byte_count: Some(3), destination_class: Some(TrustDestinationClass::ObjectStorage),
            destination_host: Some("bucket.oss-example.com".into()), consent_kind: None, consent_state: TrustConsentState::Unavailable,
            source_id: Some("source_01".into()), native_event_id: Some("event_01".into()), source_line: Some(1),
            source_byte_offset: Some(0), collector_id: "zcode-history".into(), collector_version: "v1".into(),
            provenance: json!({"failure_count": 2, "kind": "baseline"}), expires_at_ms: Some(2),
        }
    }

    #[test]
    fn accepts_redacted_observation() { assert!(observation().validate().is_ok()); }

    #[test]
    fn rejects_path_or_url_in_local_refs() {
        let mut value = observation();
        value.workspace_ref = Some("/Users/Admin/project".into());
        assert!(value.validate().is_err());
        value = observation();
        value.destination_host = Some("https://oss.example.com/upload?token=secret".into());
        assert!(value.validate().is_err());
    }

    #[test]
    fn rejects_free_form_provenance_text() {
        let mut value = observation();
        value.provenance = json!({"summary": "uploaded workspace contents"});
        assert!(value.validate().is_err());
    }
}
