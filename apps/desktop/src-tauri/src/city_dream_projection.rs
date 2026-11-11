//! City-owned visual-contract checks. These checks are only one part of the
//! future trusted projection: success does NOT authorize a snapshot to leave
//! the machine. Layout/model deep allowlists and publication authorization must
//! also pass before any dream publication can be enabled.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

const MAX_SNAPSHOT_PLAIN_BYTES: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOT_ENVELOPE_BYTES: usize = 230 * 1024;
const MAX_SNAPSHOT_COMPRESSED_BYTES: usize = MAX_SNAPSHOT_ENVELOPE_BYTES * 3 / 4;

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
}

fn alias(value: &Value, prefix: &str) -> Option<String> {
    let id = value.as_str()?;
    let digits = id.strip_prefix(prefix)?;
    let legacy = (4..=8).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit())
        && digits.parse::<u32>().is_ok_and(|number| number > 0);
    let opaque = (digits.len() == 16 || digits.len() == 32) && digits.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && digits.bytes().any(|byte| byte != b'0');
    if !legacy && !opaque { return None; }
    Some(id.to_owned())
}

fn alias_prefix(id: &str) -> Option<&'static str> {
    ["district-", "building-", "hotel:entity-", "oceandrive:entity-", "entity-"]
        .into_iter().find(|prefix| alias(&Value::String(id.to_owned()), prefix).is_some())
}

fn collect_aliases(value: &Value, aliases: &mut BTreeSet<String>) {
    match value {
        Value::String(text) if alias_prefix(text).is_some() => { aliases.insert(text.clone()); }
        Value::Array(items) => for item in items { collect_aliases(item, aliases); },
        Value::Object(items) => for (key, item) in items {
            if alias_prefix(key).is_some() { aliases.insert(key.clone()); }
            collect_aliases(item, aliases);
        },
        _ => {}
    }
}

fn random_opaque_alias(prefix: &str) -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "dream_alias_random_failed")?;
    if bytes.iter().all(|byte| *byte == 0) { bytes[15] = 1; }
    let suffix: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{prefix}{suffix}"))
}

fn rewrite_aliases(value: &mut Value, aliases: &BTreeMap<String, String>) {
    match value {
        Value::String(text) => if let Some(replacement) = aliases.get(text) { *text = replacement.clone(); },
        Value::Array(items) => for item in items { rewrite_aliases(item, aliases); },
        Value::Object(items) => {
            let old = std::mem::take(items);
            for (key, mut item) in old {
                let next_key = aliases.get(&key).cloned().unwrap_or(key);
                rewrite_aliases(&mut item, aliases);
                items.insert(next_key, item);
            }
        },
        _ => {}
    }
}

/// Validates a complete anonymous candidate, then assigns publication-local
/// opaque aliases to every entity and reference. The mapping is intentionally
/// ephemeral: callers must freeze this returned value for that publication and
/// must never reuse the mapping for a later publication.
pub(crate) fn rekey_candidate_for_publication(value: &mut Value) -> Result<(), &'static str> {
    validate_candidate(value)?;
    let mut ids = BTreeSet::new();
    collect_aliases(value, &mut ids);
    let mut aliases = BTreeMap::new();
    let mut generated = BTreeSet::new();
    for id in ids {
        let prefix = alias_prefix(&id).ok_or("invalid_dream_alias")?;
        let replacement = loop {
            let next = random_opaque_alias(prefix)?;
            if generated.insert(next.clone()) { break next; }
        };
        aliases.insert(id, replacement);
    }
    rewrite_aliases(value, &aliases);
    // The renderer uses this only to invalidate a static coast cache. The
    // source key embeds every coastal parameter, so it must not cross a share
    // boundary as a stable configuration fingerprint.
    value["snapshot"]["layout"]["data"]["coastalConfigKey"] = Value::String(random_opaque_alias("dream-publication-")?);
    validate_candidate(value)
}

pub(crate) fn prepare_candidate(value: &Value) -> Result<Value, &'static str> {
    let mut candidate = value.clone();
    rekey_candidate_for_publication(&mut candidate)?;
    Ok(candidate)
}

/// Revalidates and publication-rekeys a Dream snapshot before producing the
/// bounded gzip envelope accepted by the visitor protocol. This remains a
/// City projection concern; the generic remote gateway sees only opaque JSON.
pub(crate) fn prepare_candidate_envelope(value: &Value) -> Result<Value, &'static str> {
    let candidate = prepare_candidate(value)?;
    let plain = serde_json::to_vec(&candidate).map_err(|_| "invalid_dream_candidate")?;
    if plain.is_empty() || plain.len() > MAX_SNAPSHOT_PLAIN_BYTES { return Err("dream_candidate_too_large"); }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&plain).map_err(|_| "dream_compression_failed")?;
    let compressed = encoder.finish().map_err(|_| "dream_compression_failed")?;
    if compressed.len() > MAX_SNAPSHOT_COMPRESSED_BYTES { return Err("dream_candidate_too_large"); }
    use base64::Engine;
    let envelope = serde_json::json!({
        "schema":"dream-city-gzip:v1",
        "plainBytes":plain.len(),
        "data":base64::engine::general_purpose::STANDARD.encode(compressed),
    });
    let envelope_bytes = serde_json::to_vec(&envelope).map_err(|_| "invalid_dream_candidate")?;
    if envelope_bytes.len() > MAX_SNAPSHOT_ENVELOPE_BYTES { return Err("dream_candidate_too_large"); }
    Ok(envelope)
}

fn color(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text.len() == 7 && text.starts_with('#') && text.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
}

fn range(value: &Value, min: f64, max: f64) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite() && *number >= min && *number <= max)
}

fn road_alias(value: &Value) -> Option<String> {
    for prefix in ["entity-", "hotel:entity-", "oceandrive:entity-"] {
        if let Some(id) = alias(value, prefix) { return Some(id); }
    }
    None
}

fn point(value: &Value) -> bool {
    exact(value, &["x", "z"]) && range(&value["x"], -200_000.0, 200_000.0).is_some()
        && range(&value["z"], -200_000.0, 200_000.0).is_some()
}

fn zone(value: &Value) -> bool {
    matches!(value.as_str(), Some("downtown" | "residential" | "commercial" | "waterfront"))
}

fn parcel(value: &Value) -> bool {
    let Some(object) = value.as_object() else { return false; };
    if ["id", "blockId", "x", "z", "yaw", "zone", "width", "depth"].iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| !matches!(key.as_str(), "id" | "blockId" | "x" | "z" | "yaw" | "zone" | "width" | "depth" | "mergedWith"))
        || road_alias(&value["id"]).is_none() || road_alias(&value["blockId"]).is_none()
        || range(&value["x"], -200_000.0, 200_000.0).is_none() || range(&value["z"], -200_000.0, 200_000.0).is_none()
        || range(&value["yaw"], -100.0, 100.0).is_none() || !zone(&value["zone"])
        || range(&value["width"], 0.01, 10_000.0).is_none() || range(&value["depth"], 0.01, 10_000.0).is_none() { return false; }
    object.get("mergedWith").is_none_or(|value| road_alias(value).is_some())
}

fn polygon(value: &Value) -> bool {
    value.as_array().is_some_and(|points| (3..=5_000).contains(&points.len()) && points.iter().all(point))
}

fn exclusion(value: &Value) -> bool {
    match value["kind"].as_str() {
        Some("road-corridor" | "highway-corridor") => exact(value, &["id", "kind", "points", "width"])
            && road_alias(&value["id"]).is_some() && range(&value["width"], 0.01, 10_000.0).is_some()
            && value["points"].as_array().is_some_and(|points| (2..=5_000).contains(&points.len()) && points.iter().all(point)),
        Some("site-circle") => exact(value, &["id", "kind", "x", "z", "radius"]) && road_alias(&value["id"]).is_some()
            && range(&value["x"], -200_000.0, 200_000.0).is_some() && range(&value["z"], -200_000.0, 200_000.0).is_some()
            && range(&value["radius"], 0.01, 10_000.0).is_some(),
        _ => false,
    }
}

fn terrain_meta(value: &Value) -> bool {
    exact(value, &["__remoteTerrain"]) && exact(&value["__remoteTerrain"], &["center", "radius", "hasRiver"])
        && point(&value["__remoteTerrain"]["center"]) && range(&value["__remoteTerrain"]["radius"], 0.01, 200_000.0).is_some()
        && value["__remoteTerrain"]["hasRiver"].is_boolean()
}

fn path(value: &Value) -> bool {
    value.as_array().is_some_and(|points| points.len() <= 20_000 && points.iter().all(point))
}

fn publication_activity_key(value: &Value) -> bool {
    value.as_str().and_then(|key| key.strip_prefix("dream-publication-")).is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn finite_keys(value: &Value, keys: &[&str], min: f64, max: f64) -> bool {
    keys.iter().all(|key| range(&value[*key], min, max).is_some())
}

fn valid_coastal_config(config: &Value, key: &Value) -> bool {
    if config.is_null() { return key == "none" || key.as_str().is_some_and(|text| publication_activity_key(&Value::String(text.to_owned()))); }
    let fields = ["preferredAzimuth", "azimuthTolerance", "segmentArc", "wetSandWidth", "drySandWidth", "promenadeOffset",
        "boulevardOffset", "hotelOffset", "bandOuter", "maxCoastalSlope", "maxCoastalHeight", "riverMargin", "siteMargin", "minValidRatio", "bayHalfWidth", "bayShift"];
    let mut keys = vec!["profile", "version", "biome"]; keys.extend(fields);
    if !exact(config, &keys) || config["profile"] != "miami-coastal" || config["biome"] != "tropical"
        || !config["version"].as_u64().is_some_and(|version| (1..=100).contains(&version))
        || !finite_keys(config, &fields, -10_000.0, 10_000.0)
        || range(&config["minValidRatio"], 0.0, 1.0).is_none() || range(&config["bayHalfWidth"], 0.0, 1.0).is_none()
        || range(&config["bayShift"], -1.0, 1.0).is_none() { return false; }
    let Some(key) = key.as_str().filter(|text| text.len() <= 512) else { return false; };
    if publication_activity_key(&Value::String(key.to_owned())) { return true; }
    let prefix = format!("miami-coastal:v{}:", config["version"].as_u64().unwrap_or_default());
    let Some(numbers) = key.strip_prefix(&prefix) else { return false; };
    let values: Vec<&str> = numbers.split(',').collect();
    values.len() == fields.len() && values.iter().zip(fields).all(|(text, field)| {
        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'+' | b'e' | b'E'))
            && text.parse::<f64>().ok() == config[field].as_f64()
    })
}

fn valid_seaside(value: &Value) -> bool {
    if value.is_null() { return true; }
    if !exact(value, &["id", "azimuthFrom", "azimuthTo", "samples", "validRatio", "degraded", "reason"])
        || road_alias(&value["id"]).is_none() || !finite_keys(value, &["azimuthFrom", "azimuthTo"], -100.0, 100.0)
        || range(&value["validRatio"], 0.0, 1.0).is_none() || !value["degraded"].is_boolean() { return false; }
    let reason_valid = value["reason"].is_null() || value["reason"] == "no-coast" || value["reason"].as_str().is_some_and(|reason| {
        reason.strip_prefix("valid-ratio-").is_some_and(|ratio| ratio.len() == 4 && ratio.parse::<f64>().is_ok_and(|value| (0.0..=1.0).contains(&value)))
    });
    if !reason_valid { return false; }
    value["samples"].as_array().is_some_and(|samples| samples.len() <= 20_000 && samples.iter().all(|sample| {
        if !exact(sample, &["azimuth", "waterline", "inward", "wetOuter", "dryOuter", "promenade", "boulevard", "hotelLine", "outer", "groundY", "valid", "reason"])
            || range(&sample["azimuth"], -100.0, 100.0).is_none() || range(&sample["groundY"], -100_000.0, 100_000.0).is_none()
            || !sample["valid"].is_boolean() || ["waterline", "inward", "wetOuter", "dryOuter", "promenade", "boulevard", "hotelLine", "outer"].iter().any(|key| !point(&sample[*key])) { return false; }
        sample["reason"].is_null() || matches!(sample["reason"].as_str(), Some("hotel-line-off-land" | "boulevard-off-land" | "steep-promenade" | "steep-boulevard" | "high-ground" | "boulevard-high-ground" | "river" | "river-boulevard" | "reservation" | "boulevard-reservation"))
    }))
}

fn valid_plot_access(value: &Value, node_ids: &BTreeSet<String>) -> bool {
    let Some(object) = value.as_object() else { return false; };
    if ["role", "nodeId", "ownerX", "ownerZ", "ownerYaw"].iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| !matches!(key.as_str(), "role" | "nodeId" | "ownerX" | "ownerZ" | "ownerYaw" | "capability" | "entranceId" | "entranceEvidence" | "doorX" | "doorZ"))
        || value["role"] != "plot-gate" || !finite_keys(value, &["ownerX", "ownerZ"], -200_000.0, 200_000.0)
        || range(&value["ownerYaw"], -100.0, 100.0).is_none()
        || !road_alias(&value["nodeId"]).is_some_and(|id| node_ids.contains(&id))
        || object.get("capability").is_some_and(|value| !matches!(value.as_str(), Some("ground-frontage" | "island-causeway" | "shore-plot-boundary")))
        || object.get("entranceId").is_some_and(|value| !value.is_null() && road_alias(value).is_none())
        || object.get("entranceEvidence").is_some_and(|value| !matches!(value.as_str(), Some("model-position" | "plot-proxy")))
        || object.get("doorX").is_some_and(|value| range(value, -200_000.0, 200_000.0).is_none())
        || object.get("doorZ").is_some_and(|value| range(value, -200_000.0, 200_000.0).is_none())
        || object.contains_key("doorX") != object.contains_key("doorZ") { return false; }
    true
}

/// Checks coastal configuration, seaside geometry, public sites and landmarks.
pub(crate) fn validate_coastal_sites(data: &Value) -> Result<(), &'static str> {
    if !valid_coastal_config(&data["coastalConfig"], &data["coastalConfigKey"]) || !valid_seaside(&data["seaside"]) { return Err("invalid_dream_coast"); }
    let nodes = data["roadNodes"].as_array().ok_or("invalid_dream_coast")?;
    let node_ids: BTreeSet<String> = nodes.iter().map(|node| road_alias(&node["id"]).ok_or("invalid_dream_coast")).collect::<Result<_, _>>()?;
    for (key, kinds) in [("publicSites", &["civic", "station", "stadium", "park", "tower", "harbor"][..]),
        ("landmarks", &["tv-tower", "sail-opera", "arch", "pagoda", "lighthouse", "ferris-wheel", "suspension-bridge", "twin-towers", "twist-tower", "villa-complex", "islet-mansion", "islet-grounds"][..])] {
        let items = data[key].as_array().filter(|items| items.len() <= 20_000).ok_or("invalid_dream_coast")?;
        let mut ids = BTreeSet::new();
        for item in items {
            let object = item.as_object().ok_or("invalid_dream_coast")?;
            if ["id", "kind", "x", "z", "yaw", "radius"].iter().any(|field| !object.contains_key(*field))
                || object.keys().any(|field| !matches!(field.as_str(), "id" | "kind" | "x" | "z" | "yaw" | "radius" | "access" | "to" | "shore" | "reach" | "scale" | "variant" | "roadZ"))
                || (key == "publicSites" && object.keys().any(|field| matches!(field.as_str(), "to" | "shore" | "reach" | "scale" | "variant" | "roadZ")))
                || !item["kind"].as_str().is_some_and(|kind| kinds.contains(&kind)) || !finite_keys(item, &["x", "z"], -200_000.0, 200_000.0)
                || range(&item["yaw"], -100.0, 100.0).is_none() || range(&item["radius"], if key == "landmarks" { 0.0 } else { 0.01 }, 100_000.0).is_none()
                || object.get("access").is_some_and(|access| !valid_plot_access(access, &node_ids))
                || object.get("to").is_some_and(|value| !point(value)) || object.get("shore").is_some_and(|value| !point(value))
                || object.get("reach").is_some_and(|value| range(value, 0.0, 200_000.0).is_none())
                || object.get("scale").is_some_and(|value| range(value, 0.01, 100.0).is_none())
                || object.get("roadZ").is_some_and(|value| range(value, -200_000.0, 200_000.0).is_none())
                || object.get("variant").is_some_and(|value| !matches!(value.as_str(), Some("estate" | "golf" | "studio"))) { return Err("invalid_dream_coast"); }
            if !ids.insert(road_alias(&item["id"]).ok_or("invalid_dream_coast")?) { return Err("invalid_dream_coast"); }
        }
    }
    Ok(())
}

fn paths(value: &Value) -> bool {
    value.as_array().is_some_and(|items| items.len() <= 5_000 && items.iter().all(path))
}

/// Checks basic terrain and geometry layers only; other layout fields remain separate.
pub(crate) fn validate_geometry(data: &Value) -> Result<(), &'static str> {
    let _seed = data["seed"].as_u64().filter(|seed| *seed <= 9_007_199_254_740_991).ok_or("invalid_dream_geometry")?;
    let _tier = data["scaleTier"].as_u64().filter(|tier| (1..=32).contains(tier)).ok_or("invalid_dream_geometry")?;
    if !publication_activity_key(&data["activityKey"])
        || !matches!(data["biome"].as_str(), Some("tropical" | "temperate" | "boreal" | "savanna" | "eastasian"))
        || !point(&data["core"]) || !terrain_meta(&data["terrain"])
        || range(&data["islandRadius"], 10.0, 100_000.0).is_none() || range(&data["extent"], 10.0, 200_000.0).is_none()
        || range(&data["boundsRadius"], 0.01, 200_000.0).is_none()
        || !path(&data["coast"]) || !data["coast"].as_array().is_some_and(|coast| coast.len() >= 8)
        || !path(&data["river"]) || !path(&data["districtAnchors"])
        || !paths(&data["highways"]) || !paths(&data["boatLoops"])
        || !(data["coastRoads"].is_null() || paths(&data["coastRoads"]))
        || !(data["culDeSacEnds"].is_null() || path(&data["culDeSacEnds"])) { return Err("invalid_dream_geometry"); }
    let bounds = &data["urbanBounds"];
    if !exact(bounds, &["left", "right", "north", "south"]) || ["left", "right", "north", "south"].iter().any(|key| range(&bounds[*key], -200_000.0, 200_000.0).is_none())
        || bounds["left"].as_f64() > bounds["right"].as_f64() || bounds["north"].as_f64() > bounds["south"].as_f64() { return Err("invalid_dream_geometry"); }
    if !data["parkTrees"].as_array().is_some_and(|trees| trees.len() <= 50_000 && trees.iter().all(|tree|
        exact(tree, &["x", "z", "y", "seed"]) && placed_xyz(tree) && range(&tree["seed"], 0.0, 1.0).is_some())) { return Err("invalid_dream_geometry"); }
    if !data["bridges"].as_array().is_some_and(|items| items.len() <= 20_000 && items.iter().all(|bridge|
        exact(bridge, &["from", "to", "angle", "length"]) && point(&bridge["from"]) && point(&bridge["to"])
            && range(&bridge["angle"], -100.0, 100.0).is_some() && range(&bridge["length"], 0.0, 200_000.0).is_some())) { return Err("invalid_dream_geometry"); }
    if !data["boatLanes"].as_array().is_some_and(|items| items.len() <= 5_000 && items.iter().all(|lane|
        exact(lane, &["radius", "speed", "phase"]) && range(&lane["radius"], 0.0, 200_000.0).is_some()
            && range(&lane["speed"], -10_000.0, 10_000.0).is_some() && range(&lane["phase"], -10_000.0, 10_000.0).is_some())) { return Err("invalid_dream_geometry"); }
    if !data["decorMountains"].as_array().is_some_and(|items| items.len() <= 5_000 && items.iter().all(|mountain|
        exact(mountain, &["center", "radius", "terrain"]) && point(&mountain["center"])
            && range(&mountain["radius"], 0.01, 100_000.0).is_some() && terrain_meta(&mountain["terrain"]))) { return Err("invalid_dream_geometry"); }
    if !data["seaMountains"].as_array().is_some_and(|items| items.len() <= 5_000 && items.iter().all(|mountain|
        exact(mountain, &["center", "radius", "height", "seed"]) && point(&mountain["center"])
            && range(&mountain["radius"], 0.01, 100_000.0).is_some() && range(&mountain["height"], 0.0, 100_000.0).is_some()
            && range(&mountain["seed"], -1.0e12, 1.0e12).is_some())) { return Err("invalid_dream_geometry"); }
    if !data["junctionRings"].is_null() && !data["junctionRings"].as_array().is_some_and(|items| items.len() <= 20_000 && items.iter().all(|ring|
        exact(ring, &["x", "z", "radius", "width", "kind"]) && range(&ring["x"], -200_000.0, 200_000.0).is_some()
            && range(&ring["z"], -200_000.0, 200_000.0).is_some() && range(&ring["radius"], 0.01, 10_000.0).is_some()
            && range(&ring["width"], 0.01, 1_000.0).is_some() && matches!(ring["kind"].as_str(), Some("major" | "minor")))) { return Err("invalid_dream_geometry"); }
    if !data["highwayRamps"].is_null() && !data["highwayRamps"].as_array().is_some_and(|items| items.len() <= 20_000 && items.iter().all(|ramp|
        exact(ramp, &["points", "width", "side"]) && path(&ramp["points"]) && range(&ramp["width"], 0.01, 1_000.0).is_some()
            && (ramp["side"] == 1 || ramp["side"] == -1))) { return Err("invalid_dream_geometry"); }
    Ok(())
}

fn building_number_map(value: &Value, allowed: &BTreeSet<String>, min: f64, max: f64) -> bool {
    if !exact(value, &["__remoteMap"]) { return false; }
    let Some(entries) = value["__remoteMap"].as_array() else { return false; };
    if entries.len() != allowed.len() { return false; }
    let mut seen = BTreeSet::new();
    entries.iter().all(|entry| {
        let Some(pair) = entry.as_array().filter(|pair| pair.len() == 2) else { return false; };
        let Some(id) = alias(&pair[0], "building-") else { return false; };
        allowed.contains(&id) && seen.insert(id) && range(&pair[1], min, max).is_some()
    })
}

fn placed_xyz(value: &Value) -> bool {
    range(&value["x"], -200_000.0, 200_000.0).is_some() && range(&value["z"], -200_000.0, 200_000.0).is_some()
        && range(&value["y"], -100_000.0, 100_000.0).is_some()
}

fn rect_geometry(value: &Value) -> bool {
    placed_xyz(value) && range(&value["yaw"], -100.0, 100.0).is_some()
        && range(&value["width"], 0.01, 10_000.0).is_some() && range(&value["depth"], 0.01, 10_000.0).is_some()
}

/// Checks the explicitly listed visual facilities, not all layout fields.
pub(crate) fn validate_facilities(data: &Value, model: &Value) -> Result<(), &'static str> {
    validate_anonymous_model(model)?;
    let district_ids: BTreeSet<&str> = model["districts"].as_array().ok_or("invalid_dream_facilities")?.iter()
        .filter_map(|district| district["id"].as_str()).collect();
    let valid_district = |value: &Value| value.as_str().is_some_and(|id| district_ids.contains(id));
    let arrays = ["massing", "civics", "contextBuildings", "gardens"];
    if arrays.iter().any(|key| !data[*key].as_array().is_some_and(|items| items.len() <= 20_000)) { return Err("invalid_dream_facilities"); }
    for block in data["massing"].as_array().unwrap() {
        if !exact(block, &["districtId", "x", "z", "y", "count", "tokens", "height"]) || !valid_district(&block["districtId"])
            || !placed_xyz(block) || block["count"] != 0 || block["tokens"] != 0 || range(&block["height"], 0.0, 100_000.0).is_none() { return Err("invalid_dream_facilities"); }
    }
    for site in data["civics"].as_array().unwrap() {
        if !exact(site, &["id", "kind", "districtId", "parcelId", "x", "z", "y", "yaw", "width", "depth", "unlockAt"])
            || road_alias(&site["id"]).is_none() || road_alias(&site["parcelId"]).is_none() || !valid_district(&site["districtId"])
            || !matches!(site["kind"].as_str(), Some("school" | "mall" | "hospital")) || !rect_geometry(site) || site["unlockAt"] != 0 { return Err("invalid_dream_facilities"); }
    }
    for building in data["contextBuildings"].as_array().unwrap() {
        if !exact(building, &["id", "x", "z", "y", "yaw", "width", "depth", "height", "seed", "zone", "appearAt"])
            || road_alias(&building["id"]).is_none() || !rect_geometry(building) || !zone(&building["zone"])
            || range(&building["height"], 0.0, 100_000.0).is_none() || range(&building["seed"], 0.0, 1.0).is_none()
            || building["appearAt"] != 0 { return Err("invalid_dream_facilities"); }
    }
    for garden in data["gardens"].as_array().unwrap() {
        if !exact(garden, &["id", "districtId", "blockId", "x", "z", "y", "yaw", "width", "depth", "seed"])
            || road_alias(&garden["id"]).is_none() || road_alias(&garden["blockId"]).is_none() || !valid_district(&garden["districtId"])
            || !rect_geometry(garden) || range(&garden["seed"], 0.0, 1.0).is_none() { return Err("invalid_dream_facilities"); }
    }
    let landmarks = data.get("districtLandmarks").ok_or("invalid_dream_facilities")?;
    if !landmarks.is_null() {
        let Some(items) = landmarks.as_array().filter(|items| items.len() <= 32) else { return Err("invalid_dream_facilities"); };
        let mut seen = BTreeSet::new();
        for item in items {
            if !exact(item, &["districtId", "parcelId", "x", "z", "y", "yaw"]) || !valid_district(&item["districtId"])
                || road_alias(&item["parcelId"]).is_none() || !placed_xyz(item) || range(&item["yaw"], -100.0, 100.0).is_none()
                || !seen.insert(item["districtId"].as_str().unwrap_or_default()) { return Err("invalid_dream_facilities"); }
        }
    }
    Ok(())
}

/// Checks facility references against the canonical ordinary parcel/block lists.
/// Civic parcel IDs are an existing external placement reference in the City
/// projection and are retained only as opaque, publication-rekeyed aliases.
pub(crate) fn validate_facility_references(data: &Value) -> Result<(), &'static str> {
    let blocks = data["blocks"].as_array().ok_or("invalid_dream_facilities")?;
    let block_ids: BTreeSet<String> = blocks.iter().map(|block| road_alias(&block["id"]).ok_or("invalid_dream_facilities")).collect::<Result<_, _>>()?;
    let parcel_ids: BTreeSet<String> = blocks.iter().flat_map(|block| block["parcels"].as_array().into_iter().flatten())
        .map(|parcel| road_alias(&parcel["id"]).ok_or("invalid_dream_facilities")).collect::<Result<_, _>>()?;
    for garden in data["gardens"].as_array().ok_or("invalid_dream_facilities")? {
        let block = road_alias(&garden["blockId"]).ok_or("invalid_dream_facilities")?;
        if !block_ids.contains(&block) { return Err("invalid_dream_facilities"); }
    }
    if let Some(landmarks) = data["districtLandmarks"].as_array() {
        for landmark in landmarks {
            let parcel = road_alias(&landmark["parcelId"]).ok_or("invalid_dream_facilities")?;
            if !parcel_ids.contains(&parcel) { return Err("invalid_dream_facilities"); }
        }
    }
    Ok(())
}

/// Validates district-specific fields. Parcel content has its own validator.
pub(crate) fn validate_district_fields(data: &Value, model: &Value) -> Result<(), &'static str> {
    validate_anonymous_model(model)?;
    let Some(districts) = data["districts"].as_array() else { return Err("invalid_dream_districts"); };
    let Some(model_districts) = model["districts"].as_array() else { return Err("invalid_dream_districts"); };
    if districts.len() != model_districts.len() || districts.len() > 32 { return Err("invalid_dream_districts"); }
    let expected: BTreeMap<&str, &Value> = model_districts.iter().filter_map(|district| district["id"].as_str().map(|id| (id, district))).collect();
    let owners: BTreeMap<&str, &str> = model["buildings"].as_array().ok_or("invalid_dream_districts")?.iter()
        .filter_map(|building| building["id"].as_str().zip(building["districtId"].as_str())).collect();
    let mut seen = BTreeSet::new();
    for district in districts {
        if !exact(district, &["id", "label", "center", "radius", "terrain", "slots", "grounds", "roads", "carPaths", "river", "riverHalfWidth", "trees", "plaza", "anomaly", "sessionCount", "landValue"])
            || !point(&district["center"]) || range(&district["radius"], 0.0, 200_000.0).is_none() || !terrain_meta(&district["terrain"])
            || !district["anomaly"].is_null() || district["sessionCount"] != 0 || !district["roads"].as_array().is_some_and(Vec::is_empty)
            || !district["carPaths"].as_array().is_some_and(|paths| paths.len() <= 5_000 && paths.iter().all(path))
            || !(district["river"].is_null() || path(&district["river"])) || range(&district["riverHalfWidth"], 0.0, 10_000.0).is_none()
            || !exact(&district["plaza"], &["x", "z", "y"]) || range(&district["plaza"]["x"], -200_000.0, 200_000.0).is_none()
            || range(&district["plaza"]["z"], -200_000.0, 200_000.0).is_none() || range(&district["plaza"]["y"], -100_000.0, 100_000.0).is_none()
            || !district["trees"].as_array().is_some_and(|trees| trees.len() <= 50_000 && trees.iter().all(|tree|
                exact(tree, &["x", "z", "y", "seed"]) && range(&tree["x"], -200_000.0, 200_000.0).is_some()
                    && range(&tree["z"], -200_000.0, 200_000.0).is_some() && range(&tree["y"], -100_000.0, 100_000.0).is_some()
                    && range(&tree["seed"], 0.0, 1.0).is_some()))
            || !exact(&district["slots"], &["__remoteMap"]) { return Err("invalid_dream_districts"); }
        let id = district["id"].as_str().ok_or("invalid_dream_districts")?;
        if !seen.insert(id) || expected.get(id).is_none_or(|item| item["label"] != district["label"]) { return Err("invalid_dream_districts"); }
        let entries = district["slots"]["__remoteMap"].as_array().ok_or("invalid_dream_districts")?;
        if entries.len() > 5_000 { return Err("invalid_dream_districts"); }
        let mut slots = BTreeSet::new();
        for entry in entries {
            let pair = entry.as_array().filter(|pair| pair.len() == 2).ok_or("invalid_dream_districts")?;
            let building = alias(&pair[0], "building-").ok_or("invalid_dream_districts")?;
            if owners.get(building.as_str()) != Some(&id) || !slots.insert(building) { return Err("invalid_dream_districts"); }
        }
        if !building_number_map(&district["grounds"], &slots, -100_000.0, 100_000.0)
            || !building_number_map(&district["landValue"], &slots, 0.0, 1.0) { return Err("invalid_dream_districts"); }
    }
    Ok(())
}

/// Checks blocks, parcel shapes, and model-to-district slot ownership only.
pub(crate) fn validate_parcels(data: &Value, model: &Value) -> Result<(), &'static str> {
    let (Some(blocks), Some(districts), Some(model_buildings)) = (data["blocks"].as_array(), data["districts"].as_array(), model["buildings"].as_array()) else { return Err("invalid_dream_parcels"); };
    if blocks.len() > 20_000 || districts.len() > 32 || model_buildings.len() > 5_000 { return Err("invalid_dream_parcels"); }
    let mut owners = BTreeMap::new();
    for building in model_buildings {
        let id = alias(&building["id"], "building-").ok_or("invalid_dream_parcels")?;
        let district = alias(&building["districtId"], "district-").ok_or("invalid_dream_parcels")?;
        if owners.insert(id, district).is_some() { return Err("invalid_dream_parcels"); }
    }
    let mut block_ids = BTreeSet::new();
    let mut block_parcels = BTreeMap::new();
    let mut parcel_count = 0_usize;
    for block in blocks {
        let Some(object) = block.as_object() else { return Err("invalid_dream_parcels"); };
        if ["id", "districtId", "x", "z", "width", "depth", "zone", "parcels", "polygon"].iter().any(|key| !object.contains_key(*key))
            || object.keys().any(|key| !matches!(key.as_str(), "id" | "districtId" | "x" | "z" | "width" | "depth" | "zone" | "parcels" | "polygon" | "holes" | "surfaceCoverage" | "surfaceExclusions" | "vacant"))
            || road_alias(&block["districtId"]).is_none() || !zone(&block["zone"])
            || range(&block["x"], -200_000.0, 200_000.0).is_none() || range(&block["z"], -200_000.0, 200_000.0).is_none()
            || range(&block["width"], 0.01, 10_000.0).is_none() || range(&block["depth"], 0.01, 10_000.0).is_none() || !polygon(&block["polygon"])
            || object.get("vacant").is_some_and(|item| !item.is_boolean())
            || object.get("surfaceCoverage").is_some_and(|item| !matches!(item.as_str(), Some("road-width-inset" | "requires-envelope-clipping")))
            || object.get("holes").is_some_and(|item| !item.as_array().is_some_and(|holes| holes.len() <= 1_000 && holes.iter().all(polygon)))
            || object.get("surfaceExclusions").is_some_and(|item| !item.as_array().is_some_and(|items| items.len() <= 5_000 && items.iter().all(exclusion))) { return Err("invalid_dream_parcels"); }
        let id = road_alias(&block["id"]).ok_or("invalid_dream_parcels")?;
        let entries = block["parcels"].as_array().ok_or("invalid_dream_parcels")?;
        parcel_count = parcel_count.checked_add(entries.len()).ok_or("invalid_dream_parcels")?;
        if !block_ids.insert(id.clone()) || entries.len() > 5_000 || parcel_count > 100_000 { return Err("invalid_dream_parcels"); }
        for entry in entries {
            if !parcel(entry) || entry["blockId"] != id { return Err("invalid_dream_parcels"); }
            let parcel_id = road_alias(&entry["id"]).ok_or("invalid_dream_parcels")?;
            if block_parcels.insert((id.clone(), parcel_id), entry.clone()).is_some() { return Err("invalid_dream_parcels"); }
        }
    }
    let mut district_ids = BTreeSet::new();
    let mut slotted = BTreeSet::new();
    let mut slotted_parcels = BTreeSet::new();
    for district in districts {
        let id = alias(&district["id"], "district-").ok_or("invalid_dream_parcels")?;
        if !district_ids.insert(id.clone()) || !exact(&district["slots"], &["__remoteMap"]) { return Err("invalid_dream_parcels"); }
        let entries = district["slots"]["__remoteMap"].as_array().ok_or("invalid_dream_parcels")?;
        if entries.len() > 5_000 { return Err("invalid_dream_parcels"); }
        for entry in entries {
            let pair = entry.as_array().filter(|pair| pair.len() == 2).ok_or("invalid_dream_parcels")?;
            let building = alias(&pair[0], "building-").ok_or("invalid_dream_parcels")?;
            if owners.get(&building) != Some(&id) || !slotted.insert(building) || !parcel(&pair[1]) { return Err("invalid_dream_parcels"); }
            let block_id = road_alias(&pair[1]["blockId"]).ok_or("invalid_dream_parcels")?;
            let parcel_id = road_alias(&pair[1]["id"]).ok_or("invalid_dream_parcels")?;
            let parcel_key = (block_id, parcel_id);
            if !slotted_parcels.insert(parcel_key.clone()) { return Err("invalid_dream_parcels"); }
            match block_parcels.get(&parcel_key) {
                Some(source) if source == &pair[1] => {}
                // Some coastal waterfront slots come from the shoreline plot
                // projection rather than the ordinary urban block list.
                None if pair[1]["zone"] == "waterfront" => {}
                _ => return Err("invalid_dream_parcels"),
            }
        }
    }
    if slotted.len() != owners.len() || owners.keys().any(|building| !slotted.contains(building)) { return Err("invalid_dream_parcels"); }
    Ok(())
}

/// Validates the road graph only, including all nested keys and node references.
pub(crate) fn validate_road_graph(data: &Value) -> Result<(), &'static str> {
    let (Some(nodes), Some(edges)) = (data["roadNodes"].as_array(), data["roadEdges"].as_array()) else { return Err("invalid_dream_roads"); };
    if nodes.len() > 50_000 || edges.len() > 20_000 { return Err("invalid_dream_roads"); }
    let mut node_ids = BTreeSet::new();
    for node in nodes {
        if !exact(node, &["id", "x", "z"]) || range(&node["x"], -200_000.0, 200_000.0).is_none()
            || range(&node["z"], -200_000.0, 200_000.0).is_none() { return Err("invalid_dream_roads"); }
        if !node_ids.insert(road_alias(&node["id"]).ok_or("invalid_dream_roads")?) { return Err("invalid_dream_roads"); }
    }
    let mut edge_ids = BTreeSet::new();
    let mut point_count = 0_usize;
    for edge in edges {
        let Some(object) = edge.as_object() else { return Err("invalid_dream_roads"); };
        if ["id", "from", "to", "width", "kind", "points"].iter().any(|key| !object.contains_key(*key))
            || object.keys().any(|key| !matches!(key.as_str(), "id" | "from" | "to" | "width" | "kind" | "points" | "bridge" | "structure" | "purpose"))
            || range(&edge["width"], 0.01, 1_000.0).is_none() || !matches!(edge["kind"].as_str(), Some("arterial" | "local"))
            || object.get("bridge").is_some_and(|value| !value.is_boolean())
            || object.get("structure").is_some_and(|value| !matches!(value.as_str(), Some("ground-road" | "ground-approach" | "deck")))
            || object.get("purpose").is_some_and(|value| value != "waterfront") { return Err("invalid_dream_roads"); }
        let id = road_alias(&edge["id"]).ok_or("invalid_dream_roads")?;
        let from = road_alias(&edge["from"]).ok_or("invalid_dream_roads")?;
        let to = road_alias(&edge["to"]).ok_or("invalid_dream_roads")?;
        let points = edge["points"].as_array().ok_or("invalid_dream_roads")?;
        point_count = point_count.checked_add(points.len()).ok_or("invalid_dream_roads")?;
        if !edge_ids.insert(id) || !node_ids.contains(&from) || !node_ids.contains(&to)
            || points.len() < 2 || points.len() > 5_000 || point_count > 200_000 || !points.iter().all(point) { return Err("invalid_dream_roads"); }
    }
    Ok(())
}

fn same_point(left: &Value, right: &Value) -> bool {
    let (Some(lx), Some(lz), Some(rx), Some(rz)) = (left["x"].as_f64(), left["z"].as_f64(), right["x"].as_f64(), right["z"].as_f64()) else { return false; };
    (lx - rx).abs() <= 0.01 && (lz - rz).abs() <= 0.01
}

/// Validates the airport and its causeway against the already validated road graph.
pub(crate) fn validate_airport(data: &Value) -> Result<(), &'static str> {
    validate_road_graph(data)?;
    let airport = data.get("airport").ok_or("invalid_dream_airport")?;
    if airport.is_null() { return Ok(()); }
    let Some(object) = airport.as_object() else { return Err("invalid_dream_airport"); };
    if ["shore", "centre", "yaw", "outward"].iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| !matches!(key.as_str(), "shore" | "centre" | "yaw" | "outward" | "causeway"))
        || !point(&airport["shore"]) || !point(&airport["centre"]) || !point(&airport["outward"])
        || range(&airport["yaw"], -std::f64::consts::PI, std::f64::consts::PI).is_none() { return Err("invalid_dream_airport"); }
    let ox = airport["outward"]["x"].as_f64().ok_or("invalid_dream_airport")?;
    let oz = airport["outward"]["z"].as_f64().ok_or("invalid_dream_airport")?;
    let yaw = airport["yaw"].as_f64().ok_or("invalid_dream_airport")?;
    if (ox.hypot(oz) - 1.0).abs() > 1e-5 || (yaw.sin() - ox).abs() > 1e-5 || (yaw.cos() - oz).abs() > 1e-5 { return Err("invalid_dream_airport"); }
    let Some(causeway) = object.get("causeway") else { return Ok(()); };
    if !exact(causeway, &["from", "fromNode", "to"]) || !point(&causeway["from"]) || !point(&causeway["to"])
        || !same_point(&airport["shore"], &causeway["from"]) { return Err("invalid_dream_airport"); }
    // Airport platform half-width 55 minus its 4-unit landing inset.
    let expected = serde_json::json!({"x":airport["centre"]["x"].as_f64().unwrap_or_default() - ox * 51.0,
        "z":airport["centre"]["z"].as_f64().unwrap_or_default() - oz * 51.0});
    if !same_point(&expected, &causeway["to"]) { return Err("invalid_dream_airport"); }
    let from_id = road_alias(&causeway["fromNode"]).ok_or("invalid_dream_airport")?;
    let nodes = data["roadNodes"].as_array().ok_or("invalid_dream_airport")?;
    if !nodes.iter().any(|node| node["id"] == from_id && same_point(node, &causeway["from"])) { return Err("invalid_dream_airport"); }
    let target_ids: BTreeSet<&str> = nodes.iter().filter(|node| same_point(node, &causeway["to"]))
        .filter_map(|node| node["id"].as_str()).collect();
    let edges = data["roadEdges"].as_array().ok_or("invalid_dream_airport")?;
    let linked = edges.iter().any(|edge| {
        let Some(points) = edge["points"].as_array() else { return false; };
        edge["bridge"] == true && edge["structure"] == "deck" && points.len() == 2
            && ((edge["from"] == from_id && edge["to"].as_str().is_some_and(|id| target_ids.contains(id))
                    && same_point(&points[0], &causeway["from"]) && same_point(&points[1], &causeway["to"]))
                || (edge["to"] == from_id && edge["from"].as_str().is_some_and(|id| target_ids.contains(id))
                    && same_point(&points[1], &causeway["from"]) && same_point(&points[0], &causeway["to"])))
    });
    if linked { Ok(()) } else { Err("invalid_dream_airport") }
}

/// Validates the default anonymous model only; it does not validate the layout.
pub(crate) fn validate_anonymous_model(model: &Value) -> Result<(), &'static str> {
    if !exact(model, &["districts", "buildings", "stats", "rows"]) { return Err("invalid_dream_model"); }
    let (Some(districts), Some(buildings), Some(rows)) = (model["districts"].as_array(), model["buildings"].as_array(), model["rows"].as_array()) else { return Err("invalid_dream_model"); };
    if districts.is_empty() || districts.len() > 32 || buildings.len() > 5_000 || !rows.is_empty() { return Err("invalid_dream_model"); }
    let mut district_ids = BTreeSet::new();
    for (index, district) in districts.iter().enumerate() {
        if !exact(district, &["id", "label", "sessionCount", "tokensTotal", "activeCount", "anomaly"])
            || district["label"] != format!("城区 {}", index + 1) || district["sessionCount"] != 0
            || district["tokensTotal"] != 0 || district["activeCount"] != 0 || !district["anomaly"].is_null() { return Err("invalid_dream_model"); }
        let id = alias(&district["id"], "district-").ok_or("invalid_dream_model")?;
        if !district_ids.insert(id) { return Err("invalid_dream_model"); }
    }
    let mut building_ids = BTreeSet::new();
    for building in buildings {
        if !exact(building, &["id", "districtId", "archetype", "facade", "seed", "tokensTotal", "height", "footprint", "active", "builtFraction", "busyness", "aggregated", "extraCount", "startedAt", "endedAt"])
            || !matches!(building["archetype"].as_str(), Some("tower" | "slab" | "midrise" | "block" | "landmark"))
            || !building["facade"].as_u64().is_some_and(|number| number <= 2)
            || range(&building["seed"], 0.0, 1.0).is_none() || range(&building["height"], 0.0, 100_000.0).is_none()
            || range(&building["footprint"], 0.0, 100_000.0).is_none() || building["builtFraction"] != 1
            || building["startedAt"] != 1
            || building["tokensTotal"] != 0 || building["active"] != false || building["busyness"] != 0
            || building["aggregated"] != false || building["extraCount"] != 0 || !building["endedAt"].is_null() { return Err("invalid_dream_model"); }
        let id = alias(&building["id"], "building-").ok_or("invalid_dream_model")?;
        let district = alias(&building["districtId"], "district-").ok_or("invalid_dream_model")?;
        if !district_ids.contains(&district) || !building_ids.insert(id) { return Err("invalid_dream_model"); }
    }
    let stats = &model["stats"];
    if !exact(stats, &["renderedSessions", "aggregatedSessions", "totalSessions", "tokensTotal", "activeCount", "truncated"])
        || ["renderedSessions", "aggregatedSessions", "totalSessions", "tokensTotal", "activeCount"].iter().any(|key| stats[*key] != 0)
        || stats["truncated"] != false { return Err("invalid_dream_model"); }
    Ok(())
}

/// Validates visual overrides and their references only, never the full payload.
pub(crate) fn validate_visual_fields(value: &Value) -> Result<(), &'static str> {
    if !exact(value, &["schema", "revision", "snapshot", "display", "palettes", "heroBuildingId"])
        || value["schema"] != "dream-city-snapshot:v2"
        || !value["revision"].as_u64().is_some_and(|revision| revision > 0 && revision <= 9_007_199_254_740_991)
        || !exact(&value["snapshot"], &["layout", "model"]) { return Err("invalid_visual_contract"); }
    let model = &value["snapshot"]["model"];
    let (Some(districts), Some(buildings), Some(palettes)) = (model["districts"].as_array(), model["buildings"].as_array(), value["palettes"].as_array()) else { return Err("invalid_visual_contract"); };
    if districts.is_empty() || districts.len() > 32 || buildings.len() > 5_000 || palettes.len() != districts.len() { return Err("invalid_visual_contract"); }
    let mut district_ids = BTreeSet::new();
    for district in districts {
        let id = alias(&district["id"], "district-").ok_or("invalid_visual_contract")?;
        if !district_ids.insert(id) { return Err("invalid_visual_contract"); }
    }
    let mut building_districts = BTreeMap::new();
    for building in buildings {
        let id = alias(&building["id"], "building-").ok_or("invalid_visual_contract")?;
        let district = alias(&building["districtId"], "district-").ok_or("invalid_visual_contract")?;
        if !district_ids.contains(&district) || building_districts.insert(id, district).is_some() { return Err("invalid_visual_contract"); }
    }
    validate_display(&value["display"], &district_ids, &building_districts)?;
    let mut seen = BTreeSet::new();
    let mut total_share = 0.0;
    for entry in palettes {
        if !exact(entry, &["districtId", "palette", "landmarkHeight", "flagShare"])
            || !exact(&entry["palette"], &["wall", "roof", "accent", "park"])
            || ["wall", "roof", "accent", "park"].iter().any(|key| !color(&entry["palette"][*key]))
            || range(&entry["landmarkHeight"], 0.0, 90.0).is_none() { return Err("invalid_visual_contract"); }
        let district = alias(&entry["districtId"], "district-").ok_or("invalid_visual_contract")?;
        if !district_ids.contains(&district) || !seen.insert(district) { return Err("invalid_visual_contract"); }
        total_share += range(&entry["flagShare"], 0.0, 1.0).ok_or("invalid_visual_contract")?;
    }
    if total_share > 0.0 && (total_share - 1.0).abs() > 1e-9 { return Err("invalid_visual_contract"); }
    if value["heroBuildingId"].is_null() { return Ok(()); }
    let hero = alias(&value["heroBuildingId"], "building-").ok_or("invalid_visual_contract")?;
    let district = building_districts.get(&hero).ok_or("invalid_visual_contract")?;
    let layout_districts = value["snapshot"]["layout"]["data"]["districts"].as_array().ok_or("invalid_visual_contract")?;
    let mut placed = false;
    for item in layout_districts {
        if item["id"] != *district { continue; }
        let slots = item["slots"]["__remoteMap"].as_array().ok_or("invalid_visual_contract")?;
        if slots.iter().any(|slot| slot.as_array().is_some_and(|pair| pair.len() == 2 && pair[0] == hero)) { placed = true; }
    }
    if placed { Ok(()) } else { Err("invalid_visual_contract") }
}

fn display_count(value: &Value) -> bool {
    value.as_u64().is_some_and(|number| number <= 9_007_199_254_740_991)
}

fn clean_display_text(value: &Value) -> bool {
    let Some(text) = value.as_str() else { return false; };
    let Some(cleaned) = agent_vitals_domain::enrichment::bound_session_title(text) else { return false; };
    cleaned == text && text.chars().count() <= 256 && text.len() <= 1024
}

fn validate_display(display: &Value, districts: &BTreeSet<String>, buildings: &BTreeMap<String, String>) -> Result<(), &'static str> {
    if !exact(display, &["schema", "city", "districts", "buildings"]) || display["schema"] != "agent-city-display:v1"
        || !exact(&display["city"], &["sessionCount", "activeCount", "tokensTotal", "truncated"])
        || !display_count(&display["city"]["sessionCount"]) || !display_count(&display["city"]["activeCount"])
        || display["city"]["activeCount"].as_u64().unwrap_or_default() > display["city"]["sessionCount"].as_u64().unwrap_or_default()
        || !display_count(&display["city"]["tokensTotal"]) || !display["city"]["truncated"].is_boolean() { return Err("invalid_dream_display"); }
    let (Some(shown_districts), Some(shown_buildings)) = (display["districts"].as_array(), display["buildings"].as_array()) else { return Err("invalid_dream_display"); };
    if shown_districts.len() != districts.len() || shown_buildings.len() != buildings.len() || shown_buildings.len() > 4_000 { return Err("invalid_dream_display"); }
    let mut seen_districts = BTreeSet::new();
    for item in shown_districts {
        if !exact(item, &["id", "label", "sessionCount", "activeCount", "tokensTotal"])
            || !clean_display_text(&item["label"]) || !display_count(&item["sessionCount"]) || !display_count(&item["activeCount"])
            || item["activeCount"].as_u64().unwrap_or_default() > item["sessionCount"].as_u64().unwrap_or_default()
            || !display_count(&item["tokensTotal"]) { return Err("invalid_dream_display"); }
        let id = alias(&item["id"], "district-").ok_or("invalid_dream_display")?;
        if !districts.contains(&id) || !seen_districts.insert(id) { return Err("invalid_dream_display"); }
    }
    let mut seen_buildings = BTreeSet::new();
    for item in shown_buildings {
        if !exact(item, &["id", "title", "titleSource", "sessionCount", "active", "tokensTotal"])
            || !display_count(&item["sessionCount"]) || item["sessionCount"].as_u64().unwrap_or_default() == 0
            || !item["active"].is_boolean() || !display_count(&item["tokensTotal"]) { return Err("invalid_dream_display"); }
        let source = item["titleSource"].as_str();
        let title_ok = if item["title"].is_null() { source.is_none() }
            else { clean_display_text(&item["title"]) && matches!(source, Some("codex_thread_name" | "claude_ai_title" | "dsh_workspace_title")) };
        if !title_ok { return Err("invalid_dream_display"); }
        let id = alias(&item["id"], "building-").ok_or("invalid_dream_display")?;
        if !buildings.contains_key(&id) || !seen_buildings.insert(id) { return Err("invalid_dream_display"); }
    }
    Ok(())
}

/// Staged complete-candidate validation. This function does not grant access or
/// publish data; authorization and live compatibility checks remain separate.
pub(crate) fn validate_candidate(value: &Value) -> Result<(), &'static str> {
    if !serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= 4 * 1024 * 1024) { return Err("dream_candidate_too_large"); }
    validate_visual_fields(value)?;
    let snapshot = &value["snapshot"];
    let model = &snapshot["model"];
    validate_anonymous_model(model)?;
    let layout = &snapshot["layout"];
    if !exact(layout, &["schema", "revision", "generatorVersion", "seed", "backdrop", "camera", "data"])
        || layout["schema"] != "remote-city-layout:v1" || layout["generatorVersion"] != 1 || layout["revision"] != value["revision"]
        || layout["seed"].as_u64() != layout["data"]["seed"].as_u64()
        || !matches!(layout["backdrop"].as_str(), Some("off" | "auto" | "full")) { return Err("invalid_dream_layout"); }
    let camera = &layout["camera"];
    if !exact(camera, &["position", "target", "up", "fov"]) || range(&camera["fov"], 10.0, 120.0).is_none()
        || ["position", "target", "up"].iter().any(|key| !camera[*key].as_array().is_some_and(|vector|
            vector.len() == 3 && vector.iter().all(|number| range(number, -200_000.0, 200_000.0).is_some()))) { return Err("invalid_dream_layout"); }
    let data = &layout["data"];
    if !exact(data, &["scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges",
        "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks", "terrain", "extent",
        "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains",
        "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside", "airport", "coastalConfigKey", "coastalConfig",
        "contextBuildings", "gardens", "boatLoops", "seaMountains"]) { return Err("invalid_dream_layout"); }
    validate_geometry(data)?;
    validate_district_fields(data, model)?;
    validate_parcels(data, model)?;
    validate_facilities(data, model)?;
    validate_facility_references(data)?;
    validate_coastal_sites(data)?;
    validate_airport(data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/dream-city-visual-synthetic.json")).unwrap()
    }

    fn anonymous_model() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/dream-city-anonymous-model-synthetic.json")).unwrap()
    }

    fn complete_synthetic_candidate() -> Value {
        let parts = [include_str!("../tests/fixtures/dream-city-geometry-synthetic.json"),
            include_str!("../tests/fixtures/dream-city-road-graph-synthetic.json"),
            include_str!("../tests/fixtures/dream-city-parcels-synthetic.json"),
            include_str!("../tests/fixtures/dream-city-facilities-synthetic.json"),
            include_str!("../tests/fixtures/dream-city-coast-synthetic.json")];
        let mut data = serde_json::Map::new();
        for part in parts {
            let object: serde_json::Map<String, Value> = serde_json::from_str(part).unwrap();
            data.extend(object);
        }
        data.insert("districts".into(), serde_json::from_str(include_str!("../tests/fixtures/dream-city-districts-synthetic.json")).unwrap());
        let visual = sample();
        json!({"schema":"dream-city-snapshot:v2", "revision":1,
            "snapshot":{"model":anonymous_model(),"layout":{"schema":"remote-city-layout:v1","revision":1,"generatorVersion":1,"seed":74031,
                "backdrop":"off","camera":{"position":[100,120,80],"target":[0,0,0],"up":[0,1,0],"fov":50},"data":data}},
            "display":visual["display"], "palettes":visual["palettes"], "heroBuildingId":visual["heroBuildingId"]})
    }

    #[test]
    fn complete_candidate_requires_every_layer_and_rejects_unknown_content() {
        let candidate = complete_synthetic_candidate();
        assert_eq!(validate_candidate(&candidate), Ok(()));
        for change in 0..9 {
            let mut bad = candidate.clone();
            match change {
                0 => bad["snapshot"]["layout"]["data"]["private"] = json!("secret"),
                1 => bad["snapshot"]["layout"]["camera"]["private"] = json!("secret"),
                2 => bad["snapshot"]["model"]["buildings"][0]["tokensTotal"] = json!(10),
                3 => bad["snapshot"]["layout"]["data"]["massing"] = json!([{"tokens":10}]),
                4 => bad["snapshot"]["layout"]["data"]["roadEdges"][0]["to"] = json!("entity-999999"),
                5 => bad["snapshot"]["layout"]["data"]["seaside"]["reason"] = json!("secret"),
                6 => bad["snapshot"]["layout"]["seed"] = json!(74032),
                7 => bad["snapshot"]["layout"]["revision"] = json!(2),
                _ => { bad["snapshot"]["layout"]["data"].as_object_mut().unwrap().remove("airport"); },
            }
            assert!(validate_candidate(&bad).is_err(), "case {change}");
        }
    }

    #[test]
    fn dream_alias_accepts_compact_64_bit_and_legacy_128_bit_opaque_ids() {
        assert_eq!(alias(&json!("entity-0123456789abcdef"), "entity-"), Some("entity-0123456789abcdef".into()));
        assert_eq!(alias(&json!("entity-0123456789abcdef0123456789abcdef"), "entity-"), Some("entity-0123456789abcdef0123456789abcdef".into()));
        assert_eq!(alias(&json!("entity-0123456789abcde"), "entity-"), None);
        assert_eq!(alias(&json!("entity-0000000000000000"), "entity-"), None);
    }

    #[test]
    fn complete_candidate_rejects_model_buildings_without_a_rendered_slot() {
        let mut candidate = complete_synthetic_candidate();
        let slots = candidate["snapshot"]["layout"]["data"]["districts"][0]["slots"]["__remoteMap"].as_array_mut().unwrap();
        assert!(!slots.is_empty());
        let removed_building = slots.pop().unwrap()[0].as_str().unwrap().to_owned();
        for field in ["grounds", "landValue"] {
            candidate["snapshot"]["layout"]["data"]["districts"][0][field]["__remoteMap"].as_array_mut().unwrap()
                .retain(|entry| entry[0] != removed_building);
        }
        candidate["heroBuildingId"] = Value::Null;
        assert_eq!(validate_candidate(&candidate), Err("invalid_dream_parcels"));
    }

    #[test]
    fn complete_candidate_requires_slots_to_match_source_parcels_and_districts() {
        let source = complete_synthetic_candidate();
        let mut changed_slot = source.clone();
        let source_parcel = changed_slot["snapshot"]["layout"]["data"]["blocks"][0]["parcels"][0].clone();
        changed_slot["snapshot"]["layout"]["data"]["districts"][0]["slots"]["__remoteMap"][0][1] = source_parcel.clone();
        assert_eq!(validate_candidate(&changed_slot), Ok(()));
        changed_slot["snapshot"]["layout"]["data"]["districts"][0]["slots"]["__remoteMap"][0][1]["x"] = json!(1234.5);
        assert_eq!(validate_candidate(&changed_slot), Err("invalid_dream_parcels"));

    }

    #[test]
    fn complete_candidate_rejects_dangling_garden_and_landmark_references() {
        let source = complete_synthetic_candidate();
        let mut garden = source.clone();
        garden["snapshot"]["layout"]["data"]["gardens"][0]["blockId"] = json!("entity-999999");
        assert_eq!(validate_candidate(&garden), Err("invalid_dream_facilities"));

        let mut landmark = source;
        landmark["snapshot"]["layout"]["data"]["districtLandmarks"][0]["parcelId"] = json!("entity-999999");
        assert_eq!(validate_candidate(&landmark), Err("invalid_dream_facilities"));
    }

    #[test]
    fn trusted_projection_compresses_only_after_validation_and_rekeying() {
        use base64::Engine;
        use std::io::Read;
        let source = complete_synthetic_candidate();
        let envelope = prepare_candidate_envelope(&source).unwrap();
        assert_eq!(envelope["schema"], "dream-city-gzip:v1");
        assert!(envelope["plainBytes"].as_u64().is_some_and(|size| size > 0 && size as usize <= MAX_SNAPSHOT_PLAIN_BYTES));
        let compressed = base64::engine::general_purpose::STANDARD.decode(envelope["data"].as_str().unwrap()).unwrap();
        assert!(compressed.len() <= MAX_SNAPSHOT_COMPRESSED_BYTES);
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= MAX_SNAPSHOT_ENVELOPE_BYTES);
        let decoder = flate2::read::GzDecoder::new(compressed.as_slice());
        let mut plain = Vec::new();
        decoder.take(MAX_SNAPSHOT_PLAIN_BYTES as u64 + 1).read_to_end(&mut plain).unwrap();
        assert_eq!(plain.len() as u64, envelope["plainBytes"].as_u64().unwrap());
        let prepared: Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(validate_candidate(&prepared), Ok(()));
        let mut source_ids = BTreeSet::new();
        let mut prepared_ids = BTreeSet::new();
        collect_aliases(&source, &mut source_ids);
        collect_aliases(&prepared, &mut prepared_ids);
        assert!(source_ids.is_disjoint(&prepared_ids), "compressed remote form still uses fresh publication aliases");
        let dispatched = crate::plugin_projections::prepare_remote_projection("city", "city-dream:v1", &source).unwrap();
        assert_eq!(dispatched["schema"], "dream-city-gzip:v1", "remote projection dispatcher returns the wire envelope");
        let mut invalid = source;
        invalid["private"] = json!("must not cross the projection boundary");
        assert_eq!(prepare_candidate_envelope(&invalid), Err("invalid_visual_contract"));
        assert_eq!(crate::plugin_projections::prepare_remote_projection("island", "city-dream:v1", &invalid), Err("projection_denied"));
    }

    #[test]
    fn publication_rekey_uses_fresh_opaque_ids_and_rewrites_all_references() {
        let source = complete_synthetic_candidate();
        let mut first = source.clone();
        let mut second = source.clone();
        assert_eq!(rekey_candidate_for_publication(&mut first), Ok(()));
        assert_eq!(rekey_candidate_for_publication(&mut second), Ok(()));
        assert_eq!(validate_candidate(&first), Ok(()));
        assert_eq!(validate_candidate(&second), Ok(()));
        let first_coast_key = first["snapshot"]["layout"]["data"]["coastalConfigKey"].as_str().unwrap();
        let second_coast_key = second["snapshot"]["layout"]["data"]["coastalConfigKey"].as_str().unwrap();
        assert!(publication_activity_key(&Value::String(first_coast_key.to_owned())));
        assert!(publication_activity_key(&Value::String(second_coast_key.to_owned())));
        assert_ne!(first_coast_key, second_coast_key, "coastal cache key must not link publications");
        assert_ne!(first_coast_key, source["snapshot"]["layout"]["data"]["coastalConfigKey"], "source coastal parameters must not be encoded in the published key");

        let mut first_ids = BTreeSet::new();
        let mut second_ids = BTreeSet::new();
        collect_aliases(&first, &mut first_ids);
        collect_aliases(&second, &mut second_ids);
        assert!(!first_ids.is_empty());
        assert!(first_ids.is_disjoint(&second_ids), "publication aliases must not correlate across publications");
        assert!(first_ids.iter().all(|id| alias_prefix(id).is_some_and(|prefix| {
            let suffix = id.strip_prefix(prefix).unwrap_or_default();
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })));

        let data = &first["snapshot"]["layout"]["data"];
        let node_ids: BTreeSet<&str> = data["roadNodes"].as_array().unwrap().iter().map(|node| node["id"].as_str().unwrap()).collect();
        let edge = &data["roadEdges"][0];
        assert!(node_ids.contains(edge["from"].as_str().unwrap()), "edge source reference must follow node alias");
        assert!(node_ids.contains(edge["to"].as_str().unwrap()), "edge destination reference must follow node alias");
        let building = first["snapshot"]["model"]["buildings"][0]["id"].as_str().unwrap();
        assert_eq!(first["heroBuildingId"].as_str(), Some(building), "visual hero reference must follow building alias");
        assert_eq!(first["display"]["buildings"][0]["id"].as_str(), Some(building), "display building alias must follow the geometry alias");
        assert_eq!(first["display"]["buildings"][0]["title"], "Test session", "approved display title is preserved through re-keying");
        assert_eq!(first["display"]["districts"][0]["id"], first["snapshot"]["model"]["districts"][0]["id"], "district display alias must follow the geometry alias");
    }

    #[test]
    fn coastal_sites_reject_untrusted_fields_invalid_config_and_dangling_access() {
        let data: Value = serde_json::from_str(include_str!("../tests/fixtures/dream-city-coast-synthetic.json")).unwrap();
        assert!(valid_coastal_config(&data["coastalConfig"], &data["coastalConfigKey"]), "coastal config");
        assert!(valid_seaside(&data["seaside"]), "seaside");
        let node_ids: BTreeSet<String> = data["roadNodes"].as_array().unwrap().iter().filter_map(|node| road_alias(&node["id"])).collect();
        for item in data["publicSites"].as_array().unwrap().iter().chain(data["landmarks"].as_array().unwrap()) {
            if let Some(access) = item.get("access") { assert!(valid_plot_access(access, &node_ids), "site access: {access}"); }
        }
        assert_eq!(validate_coastal_sites(&data), Ok(()));
        for change in 0..8 {
            let mut bad = data.clone();
            match change {
                0 => bad["coastalConfigKey"] = json!("private-data"),
                1 => bad["coastalConfig"]["bayShift"] = json!(9),
                2 => bad["seaside"]["reason"] = json!("private-data"),
                3 => bad["seaside"]["samples"][0]["waterline"]["private"] = json!("secret"),
                4 => bad["landmarks"][1]["access"]["nodeId"] = json!("entity-999999"),
                5 => bad["publicSites"][0]["private"] = json!("secret"),
                6 => bad["landmarks"][0]["kind"] = json!("unknown"),
                _ => bad["seaside"]["samples"][0]["reason"] = json!("private-data"),
            }
            assert!(validate_coastal_sites(&bad).is_err(), "case {change}");
        }
    }

    #[test]
    fn geometry_rejects_unbounded_values_and_unexpected_nested_fields() {
        let data: Value = serde_json::from_str(include_str!("../tests/fixtures/dream-city-geometry-synthetic.json")).unwrap();
        assert_eq!(validate_geometry(&data), Ok(()));
        for change in 0..9 {
            let mut bad = data.clone();
            match change {
                0 => bad["activityKey"] = json!("private-value"),
                1 => bad["terrain"]["__remoteTerrain"]["private"] = json!("secret"),
                2 => bad["coast"][0]["x"] = json!(300_000),
                3 => bad["parkTrees"][0]["private"] = json!("secret"),
                4 => bad["bridges"][0]["from"]["private"] = json!("secret"),
                5 => bad["junctionRings"][0]["kind"] = json!("unknown"),
                6 => bad["seaMountains"][0]["height"] = json!(-1),
                7 => bad["urbanBounds"]["left"] = json!(100_000),
                _ => bad["coast"] = json!([{"x":0,"z":0}]),
            }
            assert!(validate_geometry(&bad).is_err(), "case {change}");
        }
    }

    #[test]
    fn synthetic_parcels_validate_and_reject_untrusted_fields_or_wrong_owner() {
        let data: Value = serde_json::from_str(include_str!("../tests/fixtures/dream-city-parcels-synthetic.json")).unwrap();
        let model = anonymous_model();
        assert_eq!(validate_parcels(&data, &model), Ok(()));
        for change in 0..9 {
            let mut bad = data.clone();
            match change {
                0 => bad["blocks"][0]["private"] = json!("secret"),
                1 => bad["blocks"][0]["parcels"][0]["private"] = json!("secret"),
                2 => bad["blocks"][0]["polygon"][0]["private"] = json!("secret"),
                3 => bad["districts"][0]["slots"]["__remoteMap"][0][0] = json!("building-9999"),
                4 => bad["districts"][0]["slots"]["__remoteMap"][0][1]["mergedWith"] = json!("private-id"),
                5 => bad["blocks"][0]["width"] = json!(-1),
                _ => bad["blocks"][0]["parcels"][0]["blockId"] = json!("entity-999999"),
            }
            assert!(validate_parcels(&bad, &model).is_err(), "case {change}");
        }
    }

    #[test]
    fn district_fields_reject_private_data_wrong_maps_and_bad_geometry() {
        let districts: Value = serde_json::from_str(include_str!("../tests/fixtures/dream-city-districts-synthetic.json")).unwrap();
        let data = json!({"districts":districts});
        let model = anonymous_model();
        assert_eq!(validate_district_fields(&data, &model), Ok(()));
        for change in 0..8 {
            let mut bad = data.clone();
            match change {
                0 => bad["districts"][0]["label"] = json!("Private label"),
                1 => bad["districts"][0]["sessionCount"] = json!(4),
                2 => bad["districts"][0]["terrain"]["__remoteTerrain"]["private"] = json!("secret"),
                3 => bad["districts"][0]["grounds"]["__remoteMap"][0][0] = json!("building-9999"),
                4 => bad["districts"][0]["landValue"]["__remoteMap"][0][1] = json!(1.5),
                5 => bad["districts"][0]["center"]["x"] = json!(300_000),
                6 => bad["districts"][0]["carPaths"][0][0]["private"] = json!("secret"),
                _ => bad["districts"][0]["roads"] = json!([[{"x":0,"z":0}]]),
            }
            assert!(validate_district_fields(&bad, &model).is_err(), "case {change}");
        }
    }

    #[test]
    fn facilities_reject_hidden_statistics_private_fields_and_wrong_districts() {
        let mut data: Value = serde_json::from_str(include_str!("../tests/fixtures/dream-city-facilities-synthetic.json")).unwrap();
        data["massing"] = json!([{"districtId":"district-0001","x":1,"z":2,"y":0,"count":0,"tokens":0,"height":12}]);
        data["contextBuildings"] = json!([{"id":"entity-000111","x":1,"z":2,"y":0,"yaw":0,"width":5,"depth":6,"height":12,"seed":0.5,"zone":"commercial","appearAt":0}]);
        let model = anonymous_model();
        assert_eq!(validate_facilities(&data, &model), Ok(()));
        for change in 0..8 {
            let mut bad = data.clone();
            match change {
                0 => bad["massing"][0]["tokens"] = json!(100),
                1 => bad["massing"][0]["count"] = json!(2),
                2 => bad["contextBuildings"][0]["appearAt"] = json!(1700000000000_i64),
                3 => bad["civics"][0]["unlockAt"] = json!(45),
                4 => bad["gardens"][0]["private"] = json!("secret"),
                5 => bad["districtLandmarks"][0]["districtId"] = json!("district-9999"),
                6 => bad["contextBuildings"][0]["id"] = json!("local-private-id"),
                _ => bad["civics"][0]["width"] = json!(-5),
            }
            assert!(validate_facilities(&bad, &model).is_err(), "case {change}");
        }
    }

    #[test]
    fn road_graph_rejects_unknown_fields_invalid_points_and_dangling_nodes() {
        let roads = json!({"roadNodes":[{"id":"entity-000001","x":0,"z":0},{"id":"entity-000002","x":10,"z":0}],
            "roadEdges":[{"id":"entity-000003","from":"entity-000001","to":"entity-000002","width":8,"kind":"local","points":[{"x":0,"z":0},{"x":10,"z":0}]}]});
        assert_eq!(validate_road_graph(&roads), Ok(()));
        for change in 0..7 {
            let mut invalid = roads.clone();
            match change {
                0 => invalid["roadNodes"][0]["private"] = json!("secret"),
                1 => invalid["roadEdges"][0]["points"][0]["private"] = json!("secret"),
                2 => invalid["roadEdges"][0]["to"] = json!("entity-999999"),
                3 => invalid["roadEdges"][0]["width"] = json!(-1),
                4 => invalid["roadEdges"][0]["points"][0]["x"] = json!(200_001),
                5 => invalid["roadEdges"][0]["kind"] = json!("unknown"),
                _ => invalid["roadEdges"][0]["points"] = json!([{"x":0,"z":0}]),
            }
            assert!(validate_road_graph(&invalid).is_err(), "case {change}");
        }
    }

    #[test]
    fn synthetic_projected_road_graph_passes() {
        let roads: Value = serde_json::from_str(include_str!("../tests/fixtures/dream-city-road-graph-synthetic.json")).unwrap();
        assert_eq!(validate_road_graph(&roads), Ok(()));
        assert!(roads["airport"]["causeway"].is_object());
        assert_eq!(validate_airport(&roads), Ok(()));
    }

    #[test]
    fn airport_causeway_must_reference_a_real_bridge_and_valid_nodes() {
        let scene = json!({"roadNodes":[{"id":"entity-000001","x":0,"z":0},{"id":"entity-000002","x":10,"z":0}],
            "roadEdges":[{"id":"entity-000003","from":"entity-000001","to":"entity-000002","width":8,"kind":"local",
                "bridge":true,"structure":"deck","points":[{"x":0,"z":0},{"x":10,"z":0}]}],
            "airport":{"shore":{"x":0,"z":0},"centre":{"x":61,"z":0},"yaw":std::f64::consts::FRAC_PI_2,"outward":{"x":1,"z":0},
                "causeway":{"from":{"x":0,"z":0},"fromNode":"entity-000001","to":{"x":10,"z":0}}}});
        assert_eq!(validate_airport(&scene), Ok(()));
        let mut island_only = scene.clone();
        island_only["airport"].as_object_mut().unwrap().remove("causeway");
        assert_eq!(validate_airport(&island_only), Ok(()));
        let mut no_airport = scene.clone(); no_airport["airport"] = Value::Null;
        assert_eq!(validate_airport(&no_airport), Ok(()));
        for change in 0..9 {
            let mut invalid = scene.clone();
            match change {
                0 => invalid["airport"]["causeway"]["fromNode"] = json!("entity-999999"),
                1 => invalid["airport"]["causeway"]["to"]["x"] = json!(11),
                2 => invalid["roadEdges"][0]["bridge"] = json!(false),
                3 => invalid["airport"]["outward"]["x"] = json!(0.2),
                4 => invalid["airport"]["private"] = json!("secret"),
                5 => invalid["airport"]["causeway"]["to"]["private"] = json!("secret"),
                6 => invalid["airport"]["shore"]["x"] = json!(1),
                7 => invalid["airport"]["yaw"] = json!(0),
                _ => invalid["airport"]["centre"]["x"] = json!(62),
            }
            assert!(validate_airport(&invalid).is_err(), "case {change}");
        }
    }

    #[test]
    fn anonymous_model_rejects_labels_usage_and_extra_fields() {
        assert_eq!(validate_anonymous_model(&anonymous_model()), Ok(()));
        for change in 0..9 {
            let mut value = anonymous_model();
            match change {
                0 => value["districts"][0]["label"] = json!("Private project"),
                1 => value["districts"][0]["tokensTotal"] = json!(42),
                2 => value["buildings"][0]["active"] = json!(true),
                3 => value["buildings"][0]["tokensTotal"] = json!(42),
                4 => value["rows"] = json!([{"id":"building-0001","title":"secret"}]),
                5 => value["buildings"][0]["private"] = json!("secret"),
                6 => value["stats"]["totalSessions"] = json!(1),
                7 => value["buildings"][0]["builtFraction"] = json!(0.5),
                _ => value["buildings"][0]["startedAt"] = json!(2),
            }
            assert!(validate_anonymous_model(&value).is_err(), "case {change}");
        }
    }

    #[test]
    fn dream_display_allows_bounded_labels_and_usage_but_rejects_unapproved_data() {
        assert_eq!(validate_visual_fields(&sample()), Ok(()));
        for change in 0..7 {
            let mut value = sample();
            match change {
                0 => value["display"]["buildings"][0]["id"] = json!("private-session-id"),
                1 => value["display"]["buildings"][0]["titleSource"] = json!("arbitrary-source"),
                2 => value["display"]["buildings"][0]["title"] = json!("sk-abcdefghij0123456789"),
                3 => value["display"]["buildings"][0]["tokensTotal"] = json!(-1),
                4 => value["display"]["districts"][0]["extra"] = json!("secret"),
                5 => value["display"]["city"]["activeCount"] = json!(2),
                _ => value["display"]["buildings"][0]["cost"] = json!(1),
            }
            assert!(validate_visual_fields(&value).is_err(), "case {change}");
        }
    }

    #[test]
    fn validates_visual_projection_without_claiming_full_snapshot_safety() {
        assert_eq!(validate_visual_fields(&sample()), Ok(()));
        let mut no_hero = sample();
        no_hero["heroBuildingId"] = Value::Null;
        assert_eq!(validate_visual_fields(&no_hero), Ok(()));
    }

    #[test]
    fn rejects_extensions_invalid_colors_and_unbounded_values() {
        for change in 0..6 {
            let mut value = sample();
            match change {
                0 => value["palettes"][0]["secret"] = json!("hidden"),
                1 => value["palettes"][0]["palette"]["wall"] = json!("red"),
                2 => value["palettes"][0]["landmarkHeight"] = json!(91),
                3 => value["palettes"][0]["flagShare"] = json!(0.5),
                4 => value["revision"] = json!(0),
                _ => value["extra"] = json!({}),
            }
            assert!(validate_visual_fields(&value).is_err(), "case {change}");
        }
    }

    #[test]
    fn rejects_forged_aliases_duplicate_and_unplaced_hero() {
        for change in 0..5 {
            let mut value = sample();
            match change {
                0 => value["heroBuildingId"] = json!("local-session-id"),
                1 => value["heroBuildingId"] = json!("building-9999"),
                2 => value["snapshot"]["layout"]["data"]["districts"][0]["slots"]["__remoteMap"] = json!([]),
                3 => value["palettes"][0]["districtId"] = json!("district-9999"),
                _ => value["snapshot"]["model"]["buildings"].as_array_mut().unwrap().push(json!({"id":"building-0001", "districtId":"district-0001"})),
            }
            assert!(validate_visual_fields(&value).is_err(), "case {change}");
        }
    }
}
