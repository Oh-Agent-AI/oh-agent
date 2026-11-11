//! Layer 2: base + overrides inheritance for session-kit buildings.
//!
//! Agent tools submit an inheritance document; the server resolves base → merges
//! overrides → validates geometry/compliance/detail regression on the merged mesh.
//! Stored overrides keep the inheritance JSON (not the resolved mesh).

use serde_json::{json, Map, Value};

use super::city_building::{default_model, validate_model, BuildingError, BuildingIdentity, KIT_VERSION};
use super::city_building_catalog::catalog_model;

pub const INHERITANCE_KIT_VERSION: &str = "session-kit/inheritance/v1";

const INHERITANCE_KEYS: &[&str] = &["kit_version", "base", "overrides", "reset"];
const OVERRIDE_KEYS: &[&str] = &["params", "parts_replace", "parts_add", "parts_remove"];
const BASE_KEYS: &[&str] = &["kind", "catalog_id"];

pub fn is_inheritance_document(value: &Value) -> bool {
    value.get("kit_version").and_then(Value::as_str) == Some(INHERITANCE_KIT_VERSION)
}

pub fn is_legacy_mesh_document(value: &Value) -> bool {
    value.get("kit_version").and_then(Value::as_str) == Some(KIT_VERSION)
        && value.get("parts").is_some()
}

/// Resolve a stored row or inheritance payload to a full mesh model.
pub fn resolve_to_mesh(identity: &BuildingIdentity, stored: Option<&Value>) -> Value {
    match stored {
        None => default_model(identity.tokens_total()),
        Some(doc) if is_inheritance_document(doc) => {
            resolve_inheritance(identity, doc).unwrap_or_else(|_| default_model(identity.tokens_total()))
        }
        Some(doc) if is_legacy_mesh_document(doc) => doc.clone(),
        Some(_) => default_model(identity.tokens_total()),
    }
}

/// Parse + merge inheritance into a mesh; does not run compliance/detail gates.
pub fn resolve_inheritance(identity: &BuildingIdentity, doc: &Value) -> Result<Value, BuildingError> {
    if doc.get("reset").and_then(Value::as_bool) == Some(true) {
        return Ok(default_model(identity.tokens_total()));
    }
    let obj = doc.as_object().ok_or_else(|| inheritance_error(
        "inheritance must be a JSON object",
        "send {kit_version, base, overrides}",
    ))?;
    if let Some(extra) = obj.keys().find(|k| !INHERITANCE_KEYS.contains(&k.as_str())) {
        return Err(inheritance_error(
            format!("unknown inheritance field `{extra}`"),
            "only kit_version, base, overrides, reset are allowed",
        ));
    }
    let kit = obj.get("kit_version").and_then(Value::as_str).unwrap_or("");
    if kit != INHERITANCE_KIT_VERSION {
        return Err(inheritance_error(
            format!("kit_version must be `{INHERITANCE_KIT_VERSION}` (got `{kit}`)"),
            format!("set kit_version to `{INHERITANCE_KIT_VERSION}`"),
        ));
    }
    let base = obj.get("base").ok_or_else(|| inheritance_error(
        "inheritance.base is required unless reset is true",
        "set base to {kind: projection} or {kind: catalog, catalog_id: …}",
    ))?;
    let overrides = obj.get("overrides").cloned().unwrap_or(json!({}));
    let merged = merge_on_base(identity, base, &overrides)?;
    validate_model(&merged)
}

fn merge_on_base(identity: &BuildingIdentity, base: &Value, overrides: &Value) -> Result<Value, BuildingError> {
    let base_obj = base.as_object().ok_or_else(|| inheritance_error(
        "base must be an object",
        "use {kind: projection} or {kind: catalog, catalog_id}",
    ))?;
    if let Some(extra) = base_obj.keys().find(|k| !BASE_KEYS.contains(&k.as_str())) {
        return Err(inheritance_error(
            format!("unknown base field `{extra}`"),
            "base only accepts kind and catalog_id",
        ));
    }
    let kind = base_obj.get("kind").and_then(Value::as_str).ok_or_else(|| inheritance_error(
        "base.kind is required",
        "use projection or catalog",
    ))?;
    let mut model = match kind {
        "projection" => default_model(identity.tokens_total()),
        "catalog" => {
            let id = base_obj.get("catalog_id").and_then(Value::as_str).ok_or_else(|| inheritance_error(
                "base.catalog_id is required when kind is catalog",
                "pick an id from get_building.projection.compliant_catalog",
            ))?;
            catalog_model(id).ok_or_else(|| inheritance_error(
                format!("unknown catalog_id `{id}` for re-base"),
                "use an id from get_building.projection.compliant_catalog",
            ))?
        }
        other => {
            return Err(inheritance_error(
                format!("base.kind `{other}` is not supported"),
                "use projection or catalog",
            ));
        }
    };
    apply_overrides_merge(&mut model, overrides)?;
    Ok(model)
}

fn apply_overrides_merge(model: &mut Value, overrides: &Value) -> Result<(), BuildingError> {
    let obj = overrides.as_object().ok_or_else(|| inheritance_error(
        "overrides must be an object",
        "send overrides.params / parts_add / parts_remove / parts_replace",
    ))?;
    if let Some(extra) = obj.keys().find(|k| !OVERRIDE_KEYS.contains(&k.as_str())) {
        return Err(inheritance_error(
            format!("unknown overrides field `{extra}`"),
            "overrides accepts params, parts_replace, parts_add, parts_remove",
        ));
    }
    if let Some(params) = obj.get("params") {
        let params_obj = params.as_object().ok_or_else(|| inheritance_error(
            "overrides.params must be an object",
            "set scalar params such as story_height, detail_tier, build_cost",
        ))?;
        let model_obj = model.as_object_mut().ok_or_else(|| inheritance_error("internal model shape", "retry"))?;
        let existing = model_obj.entry("params".to_string()).or_insert_with(|| json!({}));
        if !existing.is_object() {
            *existing = json!({});
        }
        let target = existing.as_object_mut().unwrap();
        for (key, value) in params_obj {
            target.insert(key.clone(), value.clone());
        }
    }
    let parts = model
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut parts: Vec<Value> = parts;

    if let Some(remove) = obj.get("parts_remove") {
        let ids = remove.as_array().ok_or_else(|| inheritance_error(
            "parts_remove must be an array of part ids",
            "send [\"trim-id\", …]",
        ))?;
        let mut remove_set = std::collections::BTreeSet::new();
        for item in ids {
            let id = item.as_str().ok_or_else(|| inheritance_error(
                "parts_remove entries must be strings",
                "use part id strings",
            ))?;
            remove_set.insert(id);
        }
        parts.retain(|p| {
            p.get("id")
                .and_then(Value::as_str)
                .map_or(true, |id| !remove_set.contains(id))
        });
    }

    if let Some(replace) = obj.get("parts_replace") {
        let entries = replace.as_array().ok_or_else(|| inheritance_error(
            "parts_replace must be an array",
            "send [{id, part}, …]",
        ))?;
        for entry in entries {
            let entry_obj = entry.as_object().ok_or_else(|| inheritance_error(
                "parts_replace entries must be objects",
                "use {id, part}",
            ))?;
            let id = entry_obj.get("id").and_then(Value::as_str).ok_or_else(|| inheritance_error(
                "parts_replace.id is required",
                "name the part id to replace",
            ))?;
            let part = entry_obj.get("part").ok_or_else(|| inheritance_error(
                format!("parts_replace `{id}` is missing part"),
                "send the full replacement part object",
            ))?;
            if let Some(pos) = parts.iter().position(|p| p.get("id").and_then(Value::as_str) == Some(id)) {
                parts[pos] = part.clone();
            } else {
                return Err(inheritance_error(
                    format!("parts_replace id `{id}` was not found in the base mesh"),
                    "check the base catalog layout or use parts_add",
                ));
            }
        }
    }

    if let Some(add) = obj.get("parts_add") {
        let entries = add.as_array().ok_or_else(|| inheritance_error(
            "parts_add must be an array of parts",
            "append new part objects",
        ))?;
        for part in entries {
            parts.push(part.clone());
        }
    }

    if let Some(model_obj) = model.as_object_mut() {
        model_obj.insert("parts".into(), Value::Array(parts));
    }
    Ok(())
}

/// Normalize a successful inheritance document for persistence (stable ordering).
pub fn normalize_inheritance(doc: &Value) -> Result<Value, BuildingError> {
    if doc.get("reset").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "reset": true,
        }));
    }
    let obj = doc.as_object().ok_or_else(|| inheritance_error("inheritance must be an object", "send inheritance JSON"))?;
    let mut out = Map::new();
    out.insert("kit_version".into(), json!(INHERITANCE_KIT_VERSION));
    out.insert("base".into(), obj.get("base").cloned().unwrap_or(Value::Null));
    let overrides = obj.get("overrides").cloned().unwrap_or(json!({}));
    out.insert("overrides".into(), overrides);
    Ok(Value::Object(out))
}

fn inheritance_error(message: impl Into<String>, fix: impl Into<String>) -> BuildingError {
    BuildingError::validation("invalid_inheritance", vec![], message, fix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn identity(tokens: i64) -> BuildingIdentity {
        crate::query::city_building::test_building_identity(tokens)
    }

    #[test]
    fn merge_params_and_parts_add_on_catalog_base() {
        let id = identity(100_000);
        let doc = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "catalog", "catalog_id": "kit-fine-midrise" },
            "overrides": {
                "params": { "palette": "#c47a54" },
                "parts_add": [
                    {"id": "sign", "kind": "box", "role": "trim", "at": [0.0, 8.1, 3.0], "size": [1.2, 0.4, 0.2]}
                ]
            }
        });
        let mesh = resolve_inheritance(&id, &doc).unwrap();
        assert_eq!(mesh["params"]["palette"], "#c47a54");
        assert_eq!(mesh["params"]["catalog_id"], "kit-fine-midrise");
        assert!(mesh["parts"].as_array().unwrap().iter().any(|p| p["id"] == "sign"));
        assert!(mesh["parts"].as_array().unwrap().len() >= 8);
    }

    #[test]
    fn parts_replace_and_remove() {
        let id = identity(100_000);
        let doc = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "catalog", "catalog_id": "kit-low-block" },
            "overrides": {
                "parts_remove": ["window"],
                "parts_replace": [{
                    "id": "cap",
                    "part": {"id": "cap", "kind": "box", "role": "roof", "at": [0.0, 2.8, 0.0], "size": [4.5, 0.4, 5.5]}
                }]
            }
        });
        let mesh = resolve_inheritance(&id, &doc).unwrap();
        let parts = mesh["parts"].as_array().unwrap();
        assert!(!parts.iter().any(|p| p["id"] == "window"));
        let cap = parts.iter().find(|p| p["id"] == "cap").unwrap();
        assert_eq!(cap["role"], "roof");
    }

    #[test]
    fn reset_resolves_to_projection_default() {
        let id = identity(50_000);
        let doc = json!({ "kit_version": INHERITANCE_KIT_VERSION, "reset": true });
        let mesh = resolve_inheritance(&id, &doc).unwrap();
        assert_eq!(mesh["kit_version"], KIT_VERSION);
        assert!(mesh["parts"].as_array().unwrap().len() >= 5);
    }

    #[test]
    fn rebase_projection_matches_default_model() {
        let id = identity(50_000);
        let doc = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let mesh = resolve_inheritance(&id, &doc).unwrap();
        let expected = default_model(50_000);
        assert_eq!(mesh["parts"].as_array().unwrap().len(), expected["parts"].as_array().unwrap().len());
    }
}
