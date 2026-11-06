//! Codex current-route evidence extraction.
//! This is harness-specific parsing; attribution policy lives in provider/domain.

use std::path::Path;

use agent_vitals_provider::{EvidenceBasis, RouteEvidence};

/// Reads the current Codex config and returns a clearly marked current hint.
/// It is never session-native historical evidence.
pub fn current_route_evidence(codex_home: &Path) -> Option<RouteEvidence> {
    let config_path = if codex_home.join("config.toml").is_file() {
        codex_home.join("config.toml")
    } else {
        codex_home.join(".codex").join("config.toml")
    };
    let text = std::fs::read_to_string(config_path).ok()?;
    let mut model_provider = None;
    let mut active_provider = None;
    let mut endpoint = None;
    for raw in text.lines() {
        let line = raw.split('#').next()?.trim();
        if line.starts_with('[') && line.ends_with(']') {
            active_provider = line[1..line.len() - 1]
                .strip_prefix("model_providers.")
                .map(str::to_string);
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if active_provider.is_none() && key.trim() == "model_provider" {
            model_provider = Some(value.to_string());
        } else if active_provider.as_deref() == model_provider.as_deref()
            && key.trim() == "base_url"
        {
            endpoint = Some(value.to_string());
        }
    }
    Some(RouteEvidence {
        provider_raw: model_provider,
        endpoint_host: endpoint.and_then(|url| {
            url.split("//").nth(1).map(|harness| harness.split('/').next().unwrap_or(harness).to_string())
        }),
        evidence_basis: EvidenceBasis::ConfigCurrent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cogfoundry_current_hint() {
        let dir = tempfile_dir();
        std::fs::write(
            dir.join("config.toml"),
            "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://router.cogfoundry.ai/api/v1\"\n",
        )
        .unwrap();
        let evidence = current_route_evidence(&dir).unwrap();
        assert_eq!(evidence.endpoint_host.as_deref(), Some("router.cogfoundry.ai"));
        assert_eq!(evidence.evidence_basis, EvidenceBasis::ConfigCurrent);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("agent-vitals-route-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
