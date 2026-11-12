//! Creator asset binary handling: GLB structural inspection and release-asset
//! serving. The inspector enforces the glTF 2.0 subset the City runtime
//! accepts (no external URIs, no extensions/skins/animations, bounded counts)
//! and derives world-space bounds from POSITION accessors; release assets are
//! only served after proving they are referenced by that immutable release.
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::path::Path;

use crate::creator_store::{bytes_digest, database, digest, valid_id};
use crate::creator_projects::{MAX_IMPORTED_MODEL_BYTES, MAX_RELEASE_BYTES};

pub(crate) fn inspect_glb(bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.len() < 20 || &bytes[..4] != b"glTF"
        || u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| "creator_asset_invalid")?) != 2
        || u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| "creator_asset_invalid")?) as usize != bytes.len() {
        return Err("creator_asset_glb_invalid");
    }
    let mut offset = 12usize;
    let mut json_chunk: Option<&[u8]> = None;
    let mut bin_length = 0usize;
    while offset < bytes.len() {
        if offset.saturating_add(8) > bytes.len() { return Err("creator_asset_glb_invalid"); }
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().map_err(|_| "creator_asset_glb_invalid")?) as usize;
        let kind = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().map_err(|_| "creator_asset_glb_invalid")?);
        offset += 8;
        let end = offset.checked_add(length).filter(|end| *end <= bytes.len()).ok_or("creator_asset_glb_invalid")?;
        match kind {
            0x4e4f534a if json_chunk.is_none() => json_chunk = Some(&bytes[offset..end]),
            0x004e4942 if bin_length == 0 => bin_length = length,
            _ => return Err("creator_asset_glb_invalid"),
        }
        offset = end;
    }
    let json_bytes = json_chunk.ok_or("creator_asset_glb_invalid")?;
    let document: Value = serde_json::from_slice(json_bytes).map_err(|_| "creator_asset_glb_invalid")?;
    if document.get("asset").and_then(|asset| asset.get("version")).and_then(Value::as_str) != Some("2.0") {
        return Err("creator_asset_glb_invalid");
    }
    if document.get("buffers").and_then(Value::as_array).is_some_and(|buffers| buffers.iter().any(|buffer| buffer.get("uri").is_some()))
        || document.get("images").and_then(Value::as_array).is_some_and(|images| images.iter().any(|image| image.get("uri").is_some())) {
        return Err("creator_asset_external_resource_denied");
    }
    if document.get("extensionsUsed").and_then(Value::as_array).is_some_and(|extensions| !extensions.is_empty())
        || document.get("extensionsRequired").and_then(Value::as_array).is_some_and(|extensions| !extensions.is_empty())
        || document.get("skins").and_then(Value::as_array).is_some_and(|skins| !skins.is_empty())
        || document.get("animations").and_then(Value::as_array).is_some_and(|animations| !animations.is_empty())
        || document.get("buffers").and_then(Value::as_array).is_none_or(|buffers| buffers.len() != 1)
        || document.get("bufferViews").and_then(Value::as_array).is_none_or(|views| views.is_empty() || views.len() > 16_384)
        || document.get("accessors").and_then(Value::as_array).is_none_or(|accessors| accessors.is_empty() || accessors.len() > 16_384)
        || document.get("meshes").and_then(Value::as_array).is_none_or(|meshes| meshes.is_empty() || meshes.len() > 512)
        || document.get("nodes").and_then(Value::as_array).is_some_and(|nodes| nodes.len() > 4_096) {
        return Err("creator_asset_budget_exceeded");
    }
    let declared_bin = document.get("buffers").and_then(Value::as_array).and_then(|buffers| buffers.first())
        .and_then(|buffer| buffer.get("byteLength")).and_then(Value::as_u64).unwrap_or(0) as usize;
    if declared_bin == 0 || bin_length == 0 || declared_bin > bin_length { return Err("creator_asset_glb_invalid"); }
    let views = document.get("bufferViews").and_then(Value::as_array).ok_or("creator_asset_glb_invalid")?;
    for view in views {
        if view.get("buffer").and_then(Value::as_u64) != Some(0) { return Err("creator_asset_glb_invalid"); }
        let start = view.get("byteOffset").and_then(Value::as_u64).unwrap_or(0);
        let length = view.get("byteLength").and_then(Value::as_u64).filter(|length| *length > 0).ok_or("creator_asset_glb_invalid")?;
        if start.saturating_add(length) > declared_bin as u64 || view.get("byteStride").and_then(Value::as_u64).is_some_and(|stride| !(4..=252).contains(&stride)) {
            return Err("creator_asset_glb_invalid");
        }
    }
    let accessors = document.get("accessors").and_then(Value::as_array).ok_or("creator_asset_glb_invalid")?;
    for accessor in accessors {
        if accessor.get("sparse").is_some() || accessor.get("count").and_then(Value::as_u64).is_none_or(|count| count == 0 || count > 1_000_000)
            || accessor.get("bufferView").and_then(Value::as_u64).is_none_or(|index| index as usize >= views.len()) {
            return Err("creator_asset_budget_exceeded");
        }
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut found_position = false;
    let mut primitive_count = 0usize;
    let mut total_position_vertices = 0u64;
    for mesh in document["meshes"].as_array().ok_or("creator_asset_glb_invalid")? {
        for primitive in mesh.get("primitives").and_then(Value::as_array).ok_or("creator_asset_glb_invalid")? {
            primitive_count = primitive_count.saturating_add(1);
            if primitive_count > 2_048 { return Err("creator_asset_budget_exceeded"); }
            let index = primitive.get("attributes").and_then(|attributes| attributes.get("POSITION")).and_then(Value::as_u64).ok_or("creator_asset_glb_invalid")? as usize;
            let accessor = accessors.get(index).ok_or("creator_asset_glb_invalid")?;
            if accessor.get("type").and_then(Value::as_str) != Some("VEC3") || accessor.get("componentType").and_then(Value::as_u64) != Some(5126) {
                return Err("creator_asset_geometry_unsupported");
            }
            total_position_vertices = total_position_vertices.saturating_add(accessor.get("count").and_then(Value::as_u64).unwrap_or(u64::MAX));
            if total_position_vertices > 1_000_000 { return Err("creator_asset_budget_exceeded"); }
            let low = accessor.get("min").and_then(Value::as_array).filter(|values| values.len() == 3).ok_or("creator_asset_bounds_invalid")?;
            let high = accessor.get("max").and_then(Value::as_array).filter(|values| values.len() == 3).ok_or("creator_asset_bounds_invalid")?;
            for axis in 0..3 {
                let lo = low[axis].as_f64().filter(|value| value.is_finite()).ok_or("creator_asset_bounds_invalid")?;
                let hi = high[axis].as_f64().filter(|value| value.is_finite() && *value >= lo).ok_or("creator_asset_bounds_invalid")?;
                min[axis] = min[axis].min(lo);
                max[axis] = max[axis].max(hi);
            }
            found_position = true;
        }
    }
    if !found_position { return Err("creator_asset_bounds_invalid"); }
    let dimensions = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    if dimensions.iter().any(|value| !value.is_finite() || *value <= 0.0 || *value > 10_000.0) { return Err("creator_asset_bounds_invalid"); }
    Ok(json!({"x":dimensions[0],"y":dimensions[1],"z":dimensions[2]}))
}

/// Read one immutable release asset only after proving it is referenced by that
/// release. The caller separately binds access to the active official City WebView.
pub fn read_city_release_asset(home: &Path, release_id: &str, asset_digest: &str) -> Result<Vec<u8>, &'static str> {
    if !valid_id(release_id) || !asset_digest.strip_prefix("sha256:").is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())) {
        return Err("creator_asset_invalid");
    }
    let db = database(home)?;
    let (raw, snapshot_digest): (String, String) = db.query_row("SELECT snapshot_json,snapshot_digest FROM creator_releases WHERE release_id=?1", [release_id], |row| Ok((row.get(0)?,row.get(1)?)))
        .optional().map_err(|_| "creator_store_unavailable")?.ok_or("creator_release_not_found")?;
    if raw.len() > MAX_RELEASE_BYTES { return Err("creator_release_invalid"); }
    if digest(&raw) != snapshot_digest { return Err("creator_release_digest_mismatch"); }
    let snapshot: Value = serde_json::from_str(&raw).map_err(|_| "creator_store_unavailable")?;
    let asset = snapshot.get("assets").and_then(|assets| assets.get("entries")).and_then(Value::as_array)
        .and_then(|entries| entries.iter().find(|entry| entry.get("sha256").and_then(Value::as_str) == Some(asset_digest)))
        .ok_or("creator_release_asset_not_found")?;
    let referenced = snapshot.get("assetRefs").and_then(Value::as_array).is_some_and(|refs|
        refs.iter().any(|reference| reference.get("digest").and_then(Value::as_str) == Some(asset_digest)))
        && snapshot.get("scene").and_then(|scene| scene.get("objects")).and_then(Value::as_array).is_some_and(|objects|
            objects.iter().any(|object| object.get("kind").and_then(Value::as_str) == Some("model")
                && object.get("asset").and_then(|asset| asset.get("digest")).and_then(Value::as_str) == Some(asset_digest)));
    if !referenced { return Err("creator_release_asset_not_found"); }
    let project_id = snapshot.get("projectId").and_then(Value::as_str).filter(|value| valid_id(value)).ok_or("creator_release_invalid")?;
    let byte_length = asset.get("byteLength").and_then(Value::as_u64).filter(|length| *length <= MAX_IMPORTED_MODEL_BYTES).ok_or("creator_release_asset_invalid")?;
    let path = home.join("state/creator/projects").join(project_id).join("assets").join(format!("{}.glb", &asset_digest[7..]));
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| "creator_release_asset_missing")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() != byte_length { return Err("creator_release_asset_invalid"); }
    let bytes = std::fs::read(path).map_err(|_| "creator_release_asset_missing")?;
    if bytes_digest(&bytes) != asset_digest { return Err("creator_release_asset_digest_mismatch"); }
    inspect_glb(&bytes)?;
    Ok(bytes)
}
