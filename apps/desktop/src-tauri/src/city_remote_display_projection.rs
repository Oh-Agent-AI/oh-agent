//! Trusted, versioned City display projection for generic remote sessions.
//! This module contains no game capability or battle-state rules.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
}

fn finite_between(value: &Value, min: f64, max: f64) -> bool {
    value.as_f64().is_some_and(|number| number.is_finite() && number >= min && number <= max)
}

fn numeric_display_id(value: &Value, prefix: &str, min_digits: usize) -> bool {
    value.as_str().and_then(|id| id.strip_prefix(prefix)).is_some_and(|digits| {
        let numeric = digits.len() >= min_digits && digits.len() <= 12 && digits.bytes().all(|byte| byte.is_ascii_digit());
        let opaque = digits.len() == 32 && digits.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && digits.bytes().any(|byte| byte != b'0');
        numeric || opaque
    })
}

/// Validates the versioned, display-only City payload before it is bundled in
/// a remote gameplay bootstrap. Game-specific board/site state is deliberately
/// excluded and remains opaque to this projection handler.
pub(crate) fn validate_remote_display(value: &Value) -> Result<(), &'static str> {
    if !exact(value, &["schema", "seed", "model", "layout"]) || value["schema"] != "remote-city-display:v2"
        || !value["seed"].as_u64().is_some_and(|seed| seed <= 9_007_199_254_740_991)
        || !valid_remote_display_model(&value["model"]) || !valid_remote_display_layout(&value["layout"], value["seed"].as_u64().unwrap_or_default())
        || !serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= 230 * 1024) { return Err("remote_projection_invalid"); }
    Ok(())
}

/// Validates and assigns publication/session-scoped aliases to every City ID
/// in the display projection before it is inserted into a gameplay bootstrap.
pub(crate) fn prepare_remote_display(value: &Value) -> Result<Value, &'static str> {
    validate_remote_display(value)?;
    let mut display = value.clone();
    let mut ids = BTreeSet::new();
    collect_aliases(&display, &mut ids);
    let mut aliases = BTreeMap::new();
    let mut generated = BTreeSet::new();
    for id in ids {
        let prefix = alias_prefix(&id).ok_or("remote_projection_invalid")?;
        let replacement = loop {
            let next = random_opaque_alias(prefix)?;
            if generated.insert(next.clone()) { break next; }
        };
        aliases.insert(id, replacement);
    }
    rewrite_aliases(&mut display, &aliases);
    validate_remote_display(&display)?;
    Ok(display)
}

fn valid_remote_display_model(model: &Value) -> bool {
    if !exact(model, &["districts", "buildings", "stats", "rows"]) { return false; }
    let (Some(districts), Some(buildings), Some(rows)) = (model["districts"].as_array(), model["buildings"].as_array(), model["rows"].as_array()) else { return false; };
    if districts.is_empty() || districts.len() > 32 || buildings.len() > 5_000 || rows.len() > 4_000 { return false; }
    let mut district_ids = BTreeSet::new();
    for district in districts {
        if !exact(district, &["id", "label", "sessionCount", "tokensTotal", "activeCount", "anomaly"])
            || !numeric_display_id(&district["id"], "district-", 1)
            || !district["label"].as_str().is_some_and(|value| !value.is_empty() && value.len() <= 120)
            || !district["sessionCount"].as_u64().is_some_and(|value| value <= 1_000_000)
            || !district["activeCount"].as_u64().is_some_and(|value| value <= 1_000_000)
            || !finite_between(&district["tokensTotal"], 0.0, 1.0e18) || !district["anomaly"].is_null()
            || !district_ids.insert(district["id"].as_str().unwrap_or_default().to_owned()) { return false; }
    }
    let mut building_ids = BTreeSet::new();
    for building in buildings {
        let Some(archetype) = building["archetype"].as_str() else { return false; };
        if !exact(building, &["id", "districtId", "archetype", "facade", "seed", "tokensTotal", "height", "footprint", "active", "builtFraction", "busyness", "aggregated", "extraCount", "startedAt", "endedAt"])
            || !numeric_display_id(&building["id"], "building-", 1)
            || !building["districtId"].as_str().is_some_and(|id| district_ids.contains(id))
            || !matches!(archetype, "tower" | "slab" | "midrise" | "block" | "landmark")
            || !building["facade"].as_u64().is_some_and(|value| value <= 2)
            || !finite_between(&building["seed"], 0.0, 1.0) || !finite_between(&building["tokensTotal"], 0.0, 1.0e18)
            || !finite_between(&building["height"], 0.0, 100_000.0) || !finite_between(&building["footprint"], 0.0, 100_000.0)
            || !building["active"].is_boolean() || !finite_between(&building["builtFraction"], 0.0, 1.0)
            || !finite_between(&building["busyness"], 0.0, 1.0) || !building["aggregated"].is_boolean()
            || !building["extraCount"].as_u64().is_some_and(|value| value <= 1_000_000)
            || !building["startedAt"].as_u64().is_some_and(|rank| rank <= 5_000) || !building["endedAt"].is_null()
            || !building_ids.insert(building["id"].as_str().unwrap_or_default().to_owned()) { return false; }
    }
    let stats = &model["stats"];
    if !exact(stats, &["renderedSessions", "aggregatedSessions", "totalSessions", "tokensTotal", "activeCount", "truncated"])
        || !stats["renderedSessions"].as_u64().is_some_and(|value| value <= 4_000)
        || !stats["aggregatedSessions"].as_u64().is_some_and(|value| value <= 1_000_000)
        || !stats["totalSessions"].as_u64().is_some_and(|value| value <= 1_000_000)
        || !finite_between(&stats["tokensTotal"], 0.0, 1.0e18)
        || !stats["activeCount"].as_u64().is_some_and(|value| value <= 1_000_000) || !stats["truncated"].is_boolean() { return false; }
    let mut row_ids = BTreeSet::new();
    rows.iter().all(|row| exact(row, &["id", "title"]) && numeric_display_id(&row["id"], "building-", 1)
        && building_ids.contains(row["id"].as_str().unwrap_or_default())
        && (row["title"].is_null() || row["title"].as_str().is_some_and(|title| title.len() <= 500))
        && row_ids.insert(row["id"].as_str().unwrap_or_default().to_owned()))
}

fn valid_remote_display_layout(value: &Value, display_seed: u64) -> bool {
    let data_keys = ["scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges",
        "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks", "terrain", "extent",
        "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains",
        "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside", "airport", "coastalConfigKey", "coastalConfig",
        "contextBuildings", "gardens", "boatLoops", "seaMountains"];
    if !exact(value, &["schema", "revision", "generatorVersion", "seed", "backdrop", "camera", "data"])
        || value["schema"] != "remote-city-layout:v1" || value["generatorVersion"] != 1
        || value["revision"].as_u64().is_none_or(|revision| revision == 0 || revision > 1_000_000)
        || value["seed"].as_u64() != Some(display_seed) || !matches!(value["backdrop"].as_str(), Some("off" | "auto" | "full")) { return false; }
    let camera = &value["camera"];
    if !exact(camera, &["position", "target", "up", "fov"]) || !finite_between(&camera["fov"], 10.0, 120.0)
        || ["position", "target", "up"].iter().any(|key| !camera[*key].as_array().is_some_and(|vector| vector.len() == 3
            && vector.iter().all(|component| finite_between(component, -100_000.0, 100_000.0)))) { return false; }
    let data = &value["data"];
    if data.as_object().is_none_or(|object| object.len() != data_keys.len() || data_keys.iter().any(|key| !object.contains_key(*key)))
        || data["seed"].as_u64() != Some(display_seed) || data["scaleTier"].as_u64().is_none_or(|tier| tier == 0 || tier > 32)
        || !finite_between(&data["islandRadius"], 10.0, 100_000.0) || !finite_between(&data["extent"], 10.0, 200_000.0)
        || !matches!(data["biome"].as_str(), Some("tropical" | "temperate" | "boreal" | "savanna" | "eastasian"))
        || !data["districts"].as_array().is_some_and(|items| !items.is_empty() && items.len() <= 32 && items.iter().all(valid_remote_layout_district))
        || !data["blocks"].as_array().is_some_and(|items| items.len() <= 20_000)
        || !data["roadEdges"].as_array().is_some_and(|items| items.len() <= 20_000)
        || !data["roadNodes"].as_array().is_some_and(|items| items.len() <= 50_000)
        || !data["terrain"].get("__remoteTerrain").is_some() { return false; }
    !has_forbidden_remote_city_key(data) && valid_remote_city_aliases(data)
}

pub(crate) fn valid_remote_layout_district(value: &Value) -> bool {
    exact(value, &["id", "label", "center", "radius", "terrain", "slots", "grounds", "carPaths", "river", "riverHalfWidth", "trees", "plaza", "anomaly", "sessionCount", "landValue", "roads"])
        && value["anomaly"].is_null()
}

fn has_forbidden_remote_city_key(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(has_forbidden_remote_city_key),
        Value::Object(object) => object.iter().any(|(key, child)| {
            let key = key.to_ascii_lowercase();
            matches!(key.as_str(), "sessionid" | "assetref" | "filepath" | "workingdirectory" | "prompt" | "rawerror" | "finding" | "cost" | "logpath")
                || has_forbidden_remote_city_key(child)
        }),
        _ => false,
    }
}

pub(crate) fn valid_remote_city_aliases(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().all(valid_remote_city_aliases),
        Value::Object(object) => object.iter().all(|(key, child)| {
            if key == "__remoteMap" {
                return child.as_array().is_some_and(|entries| entries.iter().all(|entry| entry.as_array().is_some_and(|pair| pair.len() == 2
                    && pair[0].as_str().is_some_and(remote_city_alias)) && valid_remote_city_aliases(entry)));
            }
            if key == "id" || key.ends_with("Id") || key == "from" || key == "to" || key == "fromNode" || key == "toNode" || key == "mergedWith" {
                if let Some(id) = child.as_str() { return remote_city_alias(id); }
            }
            valid_remote_city_aliases(child)
        }),
        _ => true,
    }
}

fn remote_city_alias(id: &str) -> bool {
    ["building-", "district-", "entity-", "hotel:entity-", "oceandrive:entity-"].iter()
        .any(|prefix| alias(&Value::String(id.to_owned()), prefix).is_some())
}

fn alias(value: &Value, prefix: &str) -> Option<String> {
    let id = value.as_str()?;
    let digits = id.strip_prefix(prefix)?;
    let legacy = (4..=8).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit())
        && digits.parse::<u32>().is_ok_and(|number| number > 0);
    let opaque = digits.len() == 32 && digits.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn remote_display() -> Value {
        let data_keys = ["scaleTier", "biome", "core", "islandRadius", "seed", "districts", "blocks", "roadNodes", "roadEdges",
            "activityKey", "coastRoads", "culDeSacEnds", "junctionRings", "highwayRamps", "districtLandmarks", "terrain", "extent",
            "coast", "river", "publicSites", "parkTrees", "urbanBounds", "bridges", "boatLanes", "boundsRadius", "decorMountains",
            "districtAnchors", "highways", "massing", "civics", "landmarks", "seaside", "airport", "coastalConfigKey", "coastalConfig",
            "contextBuildings", "gardens", "boatLoops", "seaMountains"];
        let mut data = serde_json::Map::new();
        for key in data_keys { data.insert(key.into(), Value::Null); }
        data.extend(serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "scaleTier":1,"biome":"tropical","core":{"x":0,"z":0},"islandRadius":100,"seed":7,
            "districts":[{"id":"district-0001","label":"Visible label","center":{},"radius":1,"terrain":{},"slots":{},"grounds":{},"carPaths":[],"river":null,"riverHalfWidth":0,"trees":[],"plaza":{},"anomaly":null,"sessionCount":1,"landValue":{},"roads":[]}],
            "blocks":[],"roadNodes":[],"roadEdges":[],"activityKey":"remote-layout-7-1","extent":100,
            "terrain":{"__remoteTerrain":{"center":{"x":0,"z":0},"radius":100,"hasRiver":false}}
        })).unwrap());
        json!({"schema":"remote-city-display:v2","seed":7,
            "model":{"districts":[{"id":"district-0001","label":"Visible label","sessionCount":1,"tokensTotal":4,"activeCount":1,"anomaly":null}],"buildings":[],
                "stats":{"renderedSessions":0,"aggregatedSessions":0,"totalSessions":0,"tokensTotal":0,"activeCount":0,"truncated":false},"rows":[]},
            "layout":{"schema":"remote-city-layout:v1","revision":1,"generatorVersion":1,"seed":7,"backdrop":"off",
                "camera":{"position":[1,2,3],"target":[0,0,0],"up":[0,1,0],"fov":50},"data":data}})
    }

    #[test]
    fn remote_display_projection_rekeys_ids_per_handoff_and_preserves_display_data() {
        let source = remote_display();
        assert_eq!(validate_remote_display(&source), Ok(()));
        let first = prepare_remote_display(&source).unwrap();
        let second = prepare_remote_display(&source).unwrap();
        assert_eq!(validate_remote_display(&first), Ok(()));
        assert_eq!(first["model"]["districts"][0]["label"], "Visible label");
        assert_ne!(first["model"]["districts"][0]["id"], source["model"]["districts"][0]["id"]);
        assert_ne!(first["model"]["districts"][0]["id"], second["model"]["districts"][0]["id"]);
        assert_eq!(first["layout"]["data"]["districts"][0]["id"], first["model"]["districts"][0]["id"]);
    }

}
