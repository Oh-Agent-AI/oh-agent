//! Independent, bounded integrity checks for v2 world development artifacts.
//! This module does not install content, trust publishers, or validate runtime semantics.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::{collections::{BTreeMap, HashSet}, fmt, io::Read, path::Path};

use crate::creator_store::{bytes_digest, canonical_json, digest, only_keys, valid_id};

const MAX_ARTIFACT: usize = 140 * 1024 * 1024;
const MAX_TOTAL: u64 = 100 * 1024 * 1024;
const MAX_JSON: u64 = 10 * 1024 * 1024;
const MAX_MEDIA: u64 = 64 * 1024 * 1024;

/// Integrity-checked bytes remain untrusted and must pass the host's separate
/// semantic, compatibility, provenance and installation-authorization gates.
pub struct IntegrityCheckedWorldV2 {
    pub manifest: Value,
    pub files: BTreeMap<String, Vec<u8>>,
}

/// Read a native-picker selection with bounded IO. Return only non-sensitive
/// metadata; this preflight never persists, installs or authorizes the package.
pub(crate) fn read_selected_world_file(path: &Path) -> Result<Vec<u8>, &'static str> {
    let before = std::fs::symlink_metadata(path).map_err(|_| "content_read_failed")?;
    if !before.file_type().is_file() || before.file_type().is_symlink() || before.len() == 0 || before.len() > MAX_ARTIFACT as u64 { return Err("content_file_invalid"); }
    let mut file = std::fs::File::open(path).map_err(|_| "content_read_failed")?;
    let opened = file.metadata().map_err(|_| "content_read_failed")?;
    if !opened.is_file() || opened.len() != before.len() { return Err("content_file_changed"); }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != before.dev() || opened.ino() != before.ino() { return Err("content_file_changed"); }
    }
    let mut raw = Vec::new();
    (&mut file).take(MAX_ARTIFACT as u64 + 1).read_to_end(&mut raw).map_err(|_| "content_read_failed")?;
    if raw.len() as u64 != opened.len() || raw.len() > MAX_ARTIFACT || file.metadata().map_err(|_| "content_read_failed")?.len() != opened.len() { return Err("content_file_changed"); }
    Ok(raw)
}

pub(crate) fn inspect_selected_world_file(path: &Path) -> Result<Value, &'static str> {
    let raw = read_selected_world_file(path)?;
    let checked = inspect_world_integrity_v2(&raw)?;
    Ok(serde_json::json!({"kind":"city-world","packageId":checked.manifest["packageId"],"version":checked.manifest["version"],
        "contentDigest":checked.manifest["contentDigest"],"fileCount":checked.files.len(),"installable":false,
        "checks":{"integrity":"passed","semantics":"unchecked","compatibility":"unchecked","publisher":"unverified","installation":"unavailable"}}))
}

// serde_json::Value normally keeps the last duplicate key, which makes a signed
// or hashed document ambiguous across parsers. Reject duplicates at every depth.
struct UniqueValue(Value);
impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = UniqueValue;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { formatter.write_str("unambiguous JSON") }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> { Ok(UniqueValue(Value::Bool(v))) }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> { Ok(UniqueValue(Value::from(v))) }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> { Ok(UniqueValue(Value::from(v))) }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> { serde_json::Number::from_f64(v).map(|n| UniqueValue(Value::Number(n))).ok_or_else(|| E::custom("invalid number")) }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> { Ok(UniqueValue(Value::String(v.to_owned()))) }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> { Ok(UniqueValue(Value::String(v))) }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(UniqueValue(Value::Null)) }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(UniqueValue(Value::Null)) }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<UniqueValue>()? { values.push(value.0); }
                Ok(UniqueValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) { return Err(de::Error::custom("duplicate JSON key")); }
                    let value = map.next_value::<UniqueValue>()?;
                    values.insert(key, value.0);
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}

fn safe_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 240 && path.split('/').all(|part| {
        !part.is_empty() && part.len() <= 128 && part != "." && part != ".."
            && part.as_bytes()[0].is_ascii_alphanumeric()
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}
fn version(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 64 && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-')))
}
fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Checks shape, path and byte budgets, manifest digest, and exact file hashes.
/// Rejects duplicate JSON keys and accepts only a world artifact, never code.
pub fn inspect_world_integrity_v2(raw: &[u8]) -> Result<IntegrityCheckedWorldV2, &'static str> {
    if raw.is_empty() || raw.len() > MAX_ARTIFACT { return Err("content_budget_exceeded"); }
    let mut parser = serde_json::Deserializer::from_slice(raw);
    let artifact = UniqueValue::deserialize(&mut parser).map_err(|_| "content_json_invalid")?.0;
    parser.end().map_err(|_| "content_json_invalid")?;
    let root = artifact.as_object().filter(|o| o.len() == 3 && only_keys(o, &["format", "manifest", "files"])) .ok_or("content_invalid")?;
    if root.get("format").and_then(Value::as_str) != Some("oh-agent-city-content-v2") { return Err("content_unsupported"); }
    let manifest = root.get("manifest").and_then(Value::as_object).filter(|o| o.len() == 9 && only_keys(o,
        &["formatVersion", "kind", "packageId", "version", "sdkContractVersion", "minCityRuntimeVersion", "entry", "files", "contentDigest"])) .ok_or("content_invalid")?;
    if manifest.get("formatVersion").and_then(Value::as_u64) != Some(2) || manifest.get("kind").and_then(Value::as_str) != Some("city-world")
        || !manifest.get("packageId").and_then(Value::as_str).is_some_and(valid_id)
        || !["version", "sdkContractVersion", "minCityRuntimeVersion"].iter().all(|k| manifest.get(*k).is_some_and(version))
        || !manifest.get("contentDigest").is_some_and(sha) { return Err("content_invalid"); }
    let entry = manifest.get("entry").and_then(Value::as_object).filter(|o| (o.len() == 5 || o.len() == 6) && only_keys(o,
        &["profile", "scene", "assets", "generatorVersion", "defaultSeed", "patch"])) .ok_or("content_invalid")?;
    if !["profile", "scene", "assets"].iter().all(|key| entry.contains_key(*key))
        || !entry.get("generatorVersion").and_then(Value::as_u64).is_some_and(|v| (1..=9_007_199_254_740_991).contains(&v))
        || !entry.get("defaultSeed").and_then(Value::as_u64).is_some_and(|v| v <= u32::MAX as u64) { return Err("content_invalid"); }
    let entry_paths: Vec<&str> = ["profile", "scene", "assets", "patch"].iter().filter_map(|k| entry.get(*k).map(|v| v.as_str().unwrap_or(""))).collect();
    if entry_paths.len() != entry.len() - 2 || entry_paths.iter().any(|p| !safe_path(p)) || entry_paths.iter().collect::<HashSet<_>>().len() != entry_paths.len() { return Err("content_invalid"); }
    let declarations = manifest.get("files").and_then(Value::as_array).filter(|a| a.len() >= entry_paths.len() && a.len() <= 128).ok_or("content_invalid")?;
    let encoded_files = root.get("files").and_then(Value::as_object).filter(|o| o.len() == declarations.len()).ok_or("content_file_set_mismatch")?;
    let mut unsigned = manifest.clone();
    let expected_manifest = unsigned.remove("contentDigest").and_then(|v| v.as_str().map(str::to_owned)).ok_or("content_invalid")?;
    if digest(&canonical_json(&Value::Object(unsigned)).map_err(|_| "content_invalid")?) != expected_manifest { return Err("content_digest_mismatch"); }
    let mut files = BTreeMap::new(); let mut folded = HashSet::new(); let mut previous = ""; let mut total = 0u64; let mut json_paths = HashSet::new();
    for declaration in declarations {
        let item = declaration.as_object().filter(|o| o.len() == 4 && only_keys(o, &["path", "mediaType", "byteLength", "sha256"])) .ok_or("content_invalid")?;
        let path = item.get("path").and_then(Value::as_str).filter(|p| safe_path(p)).ok_or("content_invalid")?;
        if path <= previous || !folded.insert(path.to_ascii_lowercase()) { return Err("content_invalid"); }
        previous = path;
        let media = item.get("mediaType").and_then(Value::as_str).ok_or("content_invalid")?;
        let (extension, maximum) = match media { "application/json" => (".json", MAX_JSON), "model/gltf-binary" => (".glb", MAX_MEDIA), "image/png" => (".png", MAX_MEDIA), "image/jpeg" => (".jpg", MAX_MEDIA), _ => return Err("content_invalid") };
        if !path.ends_with(extension) || !item.get("sha256").is_some_and(sha) { return Err("content_invalid"); }
        let length = item.get("byteLength").and_then(Value::as_u64).filter(|n| (1..=maximum).contains(n)).ok_or("content_invalid")?;
        total = total.checked_add(length).filter(|n| *n <= MAX_TOTAL).ok_or("content_budget_exceeded")?;
        let encoded = encoded_files.get(path).and_then(Value::as_str).ok_or("content_file_set_mismatch")?;
        if encoded.len() != (length as usize).div_ceil(3) * 4 { return Err("content_file_length_mismatch"); }
        let bytes = STANDARD.decode(encoded).map_err(|_| "content_file_encoding_invalid")?;
        if bytes.len() as u64 != length || STANDARD.encode(&bytes) != encoded { return Err("content_file_encoding_invalid"); }
        if bytes_digest(&bytes) != item["sha256"].as_str().unwrap_or_default() { return Err("content_file_digest_mismatch"); }
        if media == "application/json" { json_paths.insert(path); }
        files.insert(path.to_owned(), bytes);
    }
    if entry_paths.iter().any(|path| !json_paths.contains(path)) { return Err("content_invalid"); }
    Ok(IntegrityCheckedWorldV2 { manifest: Value::Object(manifest.clone()), files })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        let sha = bytes_digest(b"{}");
        let mut manifest = json!({"formatVersion":2,"kind":"city-world","packageId":"example.desert","version":"1.0.0",
            "sdkContractVersion":"1","minCityRuntimeVersion":"1.0.0",
            "entry":{"profile":"world/profile.json","scene":"scene/objects.json","assets":"assets/catalog.json","generatorVersion":1,"defaultSeed":42},
            "files":[
                {"path":"assets/catalog.json","mediaType":"application/json","byteLength":2,"sha256":sha},
                {"path":"scene/objects.json","mediaType":"application/json","byteLength":2,"sha256":sha},
                {"path":"world/profile.json","mediaType":"application/json","byteLength":2,"sha256":sha}
            ]});
        manifest["contentDigest"] = json!(digest(&canonical_json(&manifest).unwrap()));
        json!({"format":"oh-agent-city-content-v2","manifest":manifest,"files":{
            "assets/catalog.json":"e30=","scene/objects.json":"e30=","world/profile.json":"e30="}})
    }

    fn check(value: &Value) -> Result<IntegrityCheckedWorldV2, &'static str> { inspect_world_integrity_v2(value.to_string().as_bytes()) }
    #[test]
    fn v2_integrity_checks_cross_language_vector_and_tampering() {
        let valid = fixture();
        let shared = include_bytes!("../../../../fixtures/city-content-v2/integrity-vector.json");
        assert_eq!(inspect_world_integrity_v2(shared).unwrap().manifest, valid["manifest"]);
        assert_eq!(valid["manifest"]["contentDigest"], "sha256:432a5a6173179521080db1ae9aa71a0d49e41d27681ed2b5ce0b62ba87383682");
        let result = check(&valid).unwrap();
        assert_eq!(result.files["world/profile.json"], b"{}");
        let mut bad = valid.clone(); bad["files"]["world/profile.json"] = json!("W10=");
        assert_eq!(check(&bad).err(), Some("content_file_digest_mismatch"));
        let mut bad = valid.clone(); bad["manifest"]["entry"]["defaultSeed"] = json!(43);
        assert_eq!(check(&bad).err(), Some("content_digest_mismatch"));
        let mut bad = valid.clone(); bad["files"]["extra.json"] = json!("e30=");
        assert_eq!(check(&bad).err(), Some("content_file_set_mismatch"));
        let mut bad = valid.clone(); bad["files"]["world/profile.json"] = json!("e31=");
        assert_eq!(check(&bad).err(), Some("content_file_encoding_invalid"));
    }

    #[test]
    fn selected_world_file_preflight_accepts_only_a_regular_integrity_checked_file() {
        let path = std::env::temp_dir().join(format!("world-preflight-{}-{}.json",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::write(&path, include_bytes!("../../../../fixtures/city-content-v2/integrity-vector.json")).unwrap();
        let inspected = inspect_selected_world_file(&path).unwrap();
        assert_eq!(inspected["kind"], "city-world");
        assert_eq!(inspected["installable"], false);
        assert_eq!(inspected["checks"]["integrity"], "passed");
        assert_eq!(inspected["checks"]["installation"], "unavailable");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(inspect_selected_world_file(&path).unwrap_err(), "content_read_failed");
        std::fs::create_dir(&path).unwrap();
        assert_eq!(inspect_selected_world_file(&path).unwrap_err(), "content_file_invalid");
        std::fs::remove_dir(&path).unwrap();
    }

    #[test]
    fn rejects_duplicate_keys_and_noncanonical_paths() {
        let valid = fixture().to_string();
        let duplicate = valid.replacen("\"format\":", "\"format\":\"oh-agent-city-content-v2\",\"format\":", 1);
        assert_eq!(inspect_world_integrity_v2(duplicate.as_bytes()).err(), Some("content_json_invalid"));
        for path in ["../escape.json", "/absolute.json", "folder\\file.json", "folder//file.json", ".hidden.json"] { assert!(!safe_path(path)); }
        assert!(safe_path("world/profile.json"));
    }
}
