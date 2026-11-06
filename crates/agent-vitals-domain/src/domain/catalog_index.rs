//! Pure catalog index validation; callers own transport, byte hashing and activation.
use std::collections::{BTreeMap, BTreeSet};
use serde_json::Value;

pub struct SlotSupport {
    pub schemas: Vec<u64>,
    pub capabilities: Vec<String>,
}
pub fn parse_catalog(payload: &[u8]) -> Result<Value, &'static str> {
    if payload.len() > 4 * 1024 * 1024 { return Err("index_bytes_limit"); }
    serde_json::from_slice(payload).map_err(|_| "index_json")
}
pub fn local_allowed(slot: &str) -> bool {
    matches!(slot, "harness_manifest" | "price_card" | "model_alias" | "endpoint_pattern" | "trust_profile")
}
fn known(slot: &str) -> bool {
    local_allowed(slot) || matches!(slot, "error_taxonomy" | "behavior_patterns" | "subscription_scope" | "fx_reference" | "quota_window" | "duration_threshold" | "slow_call_threshold" | "attribution_signatures")
}
fn hex(v: &str, n: usize) -> bool {
    v.len() == n && v.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn version(v: &str) -> Result<Vec<u32>, &'static str> {
    let parts: Vec<_> = v.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || (p.len() > 1 && p.starts_with('0')) || !p.bytes().all(|c| c.is_ascii_digit())) { return Err("version"); }
    parts.iter().map(|p| p.parse().map_err(|_| "version")).collect()
}
fn shape(v: &Value, fields: &[&str]) -> bool {
    v.as_object().map(|o| o.len() == fields.len() && fields.iter().all(|f| o.contains_key(*f))).unwrap_or(false)
}
fn string<'a>(v: &'a Value, key: &str, error: &'static str) -> Result<&'a str, &'static str> {
    v[key].as_str().ok_or(error)
}

/// Highest accepted sequence/hash remains caller-owned durable state.
/// `index_sha256` must describe the exact bytes used to parse `index`.
pub fn validate_catalog(index: &Value, supported: &BTreeMap<String, SlotSupport>, app_version: &str, index_sha256: &str, highest: Option<(u64, &str)>) -> Result<(), &'static str> {
    if !shape(index, &["index_schema_version", "catalog_sequence", "published_at", "entries"]) { return Err("index_shape"); }
    if index["index_schema_version"].as_u64() != Some(1) { return Err("index_schema"); }
    let seq = index["catalog_sequence"].as_u64().ok_or("sequence")?;
    if !hex(index_sha256, 64) { return Err("sequence"); }
    if let Some((previous, hash)) = highest {
        if seq < previous || (seq == previous && hash != index_sha256) { return Err("sequence_conflict"); }
    }
    let published = string(index, "published_at", "published_at")?;
    if published.len() != 20 || !published.bytes().enumerate().all(|(i, c)| match i { 4 | 7 => c == b'-', 10 => c == b'T', 13 | 16 => c == b':', 19 => c == b'Z', _ => c.is_ascii_digit() }) { return Err("published_at"); }
    let year: u32 = published[0..4].parse().unwrap();
    let month: usize = published[5..7].parse().unwrap();
    let day: u32 = published[8..10].parse().unwrap();
    let days = [31, if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if year == 0 || !(1..=12).contains(&month) || day == 0 || day > days[month.saturating_sub(1).min(11)] || published[11..13].parse::<u32>().unwrap() > 23 || published[14..16].parse::<u32>().unwrap() > 59 || published[17..19].parse::<u32>().unwrap() > 59 { return Err("published_at"); }
    let entries = index["entries"].as_array().ok_or("entries_limit")?;
    if entries.len() > 1024 { return Err("entries_limit"); }
    let app = version(app_version)?;
    let mut nodes = BTreeMap::new();
    for entry in entries {
        if !shape(entry, &["slot_type", "slot_id", "revision", "payload_path", "sha256", "schema_version", "requires", "min_app_version", "display", "dependencies"]) { return Err("entry_shape"); }
        let slot = string(entry, "slot_type", "slot_unsupported")?;
        if !known(slot) { return Err("slot_unsupported"); }
        let support = supported.get(slot).ok_or("slot_unsupported")?;
        let id = string(entry, "slot_id", "identity")?;
        if id.is_empty() || id.len() > 64 || !id.bytes().enumerate().all(|(i, c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && (c == b'_' || c == b'-'))) { return Err("identity"); }
        if !hex(string(entry, "revision", "digest")?, 40) || !hex(string(entry, "sha256", "digest")?, 64) { return Err("digest"); }
        let path = string(entry, "payload_path", "payload_path")?;
        if path.len() > 512 || !path.bytes().all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c)) || path.split('/').any(|p| matches!(p, "" | "." | "..")) { return Err("payload_path"); }
        let schema = entry["schema_version"].as_u64().ok_or("entry_schema")?;
        if schema == 0 || schema > u32::MAX as u64 || !support.schemas.contains(&schema) { return Err("entry_schema"); }
        if !shape(&entry["requires"], &["recipes", "features"]) { return Err("capability"); }
        for (category, prefix) in [("recipes", "recipe:"), ("features", "feature:")] {
          let req = entry["requires"][category].as_array().ok_or("capability")?;
          let mut seen = BTreeSet::new();
          if req.len() > 64 { return Err("capability"); }
          for value in req {
            let name = value.as_str().ok_or("capability")?;
            if name.is_empty() || name.chars().count() > 128 || !support.capabilities.contains(&format!("{prefix}{name}")) || !seen.insert(name) { return Err("capability"); }
          }
        }
        if version(string(entry, "min_app_version", "version")?)? > app { return Err("app_version"); }
        let display = string(entry, "display", "display")?;
        if display.is_empty() || display.chars().count() > 256 { return Err("display"); }
        if entry["dependencies"].as_array().ok_or("dependencies_limit")?.len() > 64 { return Err("dependencies_limit"); }
        if nodes.insert((slot, id), entry).is_some() { return Err("identity_conflict"); }
    }
    let mut edges = BTreeMap::new();
    for (key, entry) in &nodes {
        let mut targets = Vec::new();
        for dep in entry["dependencies"].as_array().unwrap() {
            if !shape(dep, &["slot_type", "slot_id", "revision", "sha256"]) { return Err("dependency_shape"); }
            let target = (string(dep, "slot_type", "dependency_shape")?, string(dep, "slot_id", "dependency_shape")?);
            let found = nodes.get(&target).ok_or("dependency_missing")?;
            if dep["revision"] != found["revision"] || dep["sha256"] != found["sha256"] { return Err("dependency_missing"); }
            if targets.contains(&target) { return Err("dependency_duplicate"); }
            targets.push(target);
        }
        edges.insert(*key, targets);
    }
    let mut done = BTreeSet::new();
    for key in nodes.keys() {
        let mut stack = vec![(*key, false)];
        let mut visiting = BTreeSet::new();
        while let Some((node, leaving)) = stack.pop() {
            if leaving { visiting.remove(&node); done.insert(node); }
            else if !done.contains(&node) {
                if !visiting.insert(node) { return Err("dependency_cycle"); }
                stack.push((node, true));
                stack.extend(edges[&node].iter().rev().map(|child| (*child, false)));
            }
        }
    }
    Ok(())
}
