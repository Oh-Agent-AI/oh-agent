//! Session-building model overrides for Agent City (MCP MVP).
//!
//! Persistence is a City-owned SQLite file keyed by stable `asset_ref`, separate
//! from the analytical authority DB. Validation is pure: `session-kit/v1` is
//! params + ≤64 parts, no scripts.
//!
//! After a successful set/reset commit the same write path notifies the desktop
//! PluginHost (unix socket push + durable mailbox) using the shared
//! `CityEntityChanged` envelope (`entity_kind=building` today). City dispatches
//! on kind and plays construction. `build_events` remains the poll fallback.
//!
//! Preview success and compliance / detail-regression / design-coherence
//! rejects use the same envelope (`action=preview|reject`) but never persist:
//! they write `edit.json` (not `notify.json`) so a later persist mailbox poll
//! cannot be overwritten. Soft design issues stay `ok: true` with `warnings[]`.
//!
//! The same write path also fans out a squad IM envelope (`docs/CITY_SQUAD_IM.md`)
//! on `squad.json` + `host.sock`. That channel never overwrites persist notify.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::city_assets;
use super::city_im;
use super::city_building_compliance::{self, compliant_catalog_ids, derive_slot, slot_to_json};
use super::city_building_design;
use super::city_building_inheritance::{
    is_inheritance_document, normalize_inheritance, resolve_inheritance, resolve_to_mesh,
    INHERITANCE_KIT_VERSION,
};
use super::session_ref::{self, session_ref};

pub const KIT_VERSION: &str = "session-kit/v1";
pub const MAX_PARTS: usize = 64;

/// Shared host → City CustomEvent name. Keep in lockstep with
/// `apps/agent-city/ui/src/engine/entityEvents.ts`.
pub const ENTITY_CHANGED_EVENT: &str = "__AV_PLUGIN_ENTITY_CHANGED__";
pub const ENTITY_CHANGED_TYPE: &str = "CityEntityChanged";
pub const ENTITY_KIND_BUILDING: &str = "building";
/// Live edit actions. Not stored in `build_events`; City treats them as ephemeral.
pub const ENTITY_ACTION_PREVIEW: &str = "preview";
pub const ENTITY_ACTION_REJECT: &str = "reject";
const FLASH_RULES: &[&str] = &[
    "invalid_model",
    "detail_regression",
    city_building_design::RULE_DISCONNECTED,
    city_building_design::RULE_MASSING_DRIFT,
];

const KINDS: &[&str] = &["box", "cylinder", "cone"];
const ROLES: &[&str] = &["wall", "trim", "roof", "glass", "structure", "door", "window"];
const FORMS: &[&str] = &["tower", "slab", "block", "midrise"];
const PART_KEYS: &[&str] = &["id", "kind", "role", "at", "size", "rot", "color"];
const MODEL_KEYS: &[&str] = &["kit_version", "params", "parts"];
const PARAM_KEYS: &[&str] = &["form", "palette", "catalog_id", "build_cost", "floors", "story_height", "detail_tier"];

/// Canonical lot envelope in local parcel coordinates (world units, 1 u = 2 m).
/// Cheap out-of-bounds check until the city loader can supply the real parcel.
const LOT_HALF_X: f64 = 4.0;
const LOT_HALF_Z: f64 = 6.0;
const MAX_HEIGHT: f64 = 48.0;
const OVERLAP_EPS: f64 = 0.02;

/// Payload is boxed so `Result<T, BuildingError>` stays under clippy's
/// `result_large_err` threshold (rustc 1.99: Err ≥128 bytes). Field access
/// is unchanged via `Deref`.
#[derive(Debug, Clone, PartialEq)]
pub struct BuildingError(Box<BuildingErrorInner>);

#[derive(Debug, Clone, PartialEq)]
pub struct BuildingErrorInner {
    pub kind: &'static str,
    pub rule: &'static str,
    pub parts: Vec<String>,
    pub message: String,
    pub suggested_fix: Option<String>,
    pub compliant_models: Vec<String>,
}

impl std::ops::Deref for BuildingError {
    type Target = BuildingErrorInner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

const _: () = assert!(
    std::mem::size_of::<BuildingError>() < 128,
    "BuildingError must stay under clippy result_large_err (128-byte Err variant)",
);

impl BuildingError {
    fn new(
        kind: &'static str,
        rule: &'static str,
        parts: Vec<String>,
        message: impl Into<String>,
        suggested_fix: Option<String>,
        compliant_models: Vec<String>,
    ) -> Self {
        Self(Box::new(BuildingErrorInner {
            kind,
            rule,
            parts,
            message: message.into(),
            suggested_fix,
            compliant_models,
        }))
    }

    pub(crate) fn validation(rule: &'static str, parts: Vec<String>, message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::new("validation", rule, parts, message, Some(fix.into()), Vec::new())
    }

    pub(crate) fn invalid_model_compliance(
        message: impl Into<String>,
        fix: impl Into<String>,
        candidates: &[String],
    ) -> Self {
        Self::new("validation", "invalid_model", Vec::new(), message, Some(fix.into()), candidates.to_vec())
    }

    pub(crate) fn detail_regression(
        message: impl Into<String>,
        fix: impl Into<String>,
        candidates: &[String],
    ) -> Self {
        Self::new("validation", "detail_regression", Vec::new(), message, Some(fix.into()), candidates.to_vec())
    }
    fn conflict(current_revision: u64) -> Self {
        Self::new(
            "conflict",
            "revision_conflict",
            Vec::new(),
            format!("expected_revision does not match current revision {current_revision}"),
            Some("call get_building and retry with the returned revision".into()),
            Vec::new(),
        )
    }
    fn not_found(session_id: &str) -> Self {
        Self::new(
            "not_found",
            "unknown_session",
            Vec::new(),
            format!("no session building matches `{session_id}`"),
            Some("pass sessions_search.session_ref (sr_…) or the building asset_ref (ca_…)".into()),
            Vec::new(),
        )
    }
    pub fn to_json(&self) -> Value {
        let mut out = json!({
            "kind": self.kind,
            "rule": self.rule,
            "parts": self.parts,
            "message": self.message,
            "suggested_fix": self.suggested_fix,
        });
        if !self.compliant_models.is_empty() {
            out["compliant_models"] = json!(self.compliant_models);
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct BuildingIdentity {
    pub asset_ref: String,
    pub session_id: String,
    pub harness: String,
    pub session_key: String,
    tokens_total: i64,
}

impl BuildingIdentity {
    pub fn tokens_total(&self) -> i64 {
        self.tokens_total
    }
}

#[derive(Debug, Clone)]
struct Aabb { min: [f64; 3], max: [f64; 3] }

impl Aabb {
    fn height(&self) -> f64 { (self.max[1] - self.min[1]).max(0.0) }
    fn overlaps(&self, other: &Aabb) -> bool {
        (0..3).all(|i| self.min[i] < other.max[i] - OVERLAP_EPS && other.min[i] < self.max[i] - OVERLAP_EPS)
    }
    fn out_of_lot(&self) -> bool {
        self.min[0] < -LOT_HALF_X - OVERLAP_EPS || self.max[0] > LOT_HALF_X + OVERLAP_EPS
            || self.min[2] < -LOT_HALF_Z - OVERLAP_EPS || self.max[2] > LOT_HALF_Z + OVERLAP_EPS
            || self.min[1] < -OVERLAP_EPS || self.max[1] > MAX_HEIGHT + OVERLAP_EPS
    }
}

/// Token → height, same curve as `cityModel.tokensToHeight` (1e3→3.4 / 1e5→15.8 / 1e7→38.6, cap 48).
pub fn tokens_to_height(tokens: i64) -> f64 {
    let magnitude = ((tokens.max(1) as f64).log10() - 1.0).max(0.0);
    (0.75 * magnitude.powf(2.2)).clamp(2.6, 48.0)
}

pub fn validate_model(model: &Value) -> Result<Value, BuildingError> {
    let obj = model.as_object().ok_or_else(|| {
        BuildingError::validation("invalid_model", vec![], "model must be a JSON object", "send {kit_version, params, parts}")
    })?;
    if let Some(extra) = obj.keys().find(|k| !MODEL_KEYS.contains(&k.as_str())) {
        return Err(BuildingError::validation(
            "invalid_model", vec![], format!("unknown model field `{extra}`"),
            "session-kit/v1 only accepts kit_version, params, parts — no scripts",
        ));
    }
    let kit = obj.get("kit_version").and_then(Value::as_str).unwrap_or("");
    if kit != KIT_VERSION {
        return Err(BuildingError::validation(
            "kit_version", vec![], format!("kit_version must be `{KIT_VERSION}` (got `{kit}`)"),
            format!("set kit_version to `{KIT_VERSION}`"),
        ));
    }
    let params = match obj.get("params") {
        None => json!({}),
        Some(Value::Object(map)) => {
            if let Some(extra) = map.keys().find(|k| !PARAM_KEYS.contains(&k.as_str())) {
                return Err(BuildingError::validation(
                    "invalid_model", vec![], format!("unknown params field `{extra}`"),
                    "params only accepts form and palette",
                ));
            }
            if let Some(form) = map.get("form") {
                let form = form.as_str().ok_or_else(|| {
                    BuildingError::validation("invalid_part", vec![], "params.form must be a string", "use tower, slab, block, or midrise")
                })?;
                if !FORMS.contains(&form) {
                    return Err(BuildingError::validation(
                        "invalid_part", vec![], format!("params.form `{form}` is not a kit form"),
                        "use tower, slab, block, or midrise",
                    ));
                }
            }
            if let Some(palette) = map.get("palette") {
                let palette = palette.as_str().ok_or_else(|| {
                    BuildingError::validation("invalid_part", vec![], "params.palette must be a hex colour", "use #rrggbb")
                })?;
                if !is_hex_color(palette) {
                    return Err(BuildingError::validation(
                        "invalid_part", vec![], format!("params.palette `{palette}` is not #rrggbb"),
                        "use a six-digit hex colour such as #c47a54",
                    ));
                }
            }
            if let Some(tier) = map.get("detail_tier") {
                if !city_building_compliance::detail_tier_param_valid(tier) {
                    return Err(BuildingError::validation(
                        "invalid_model",
                        vec![],
                        "params.detail_tier must be 0..2 or coarse|standard|detailed",
                        "use detail_tier to declare kit richness; omit to derive from part count",
                    ));
                }
            }
            Value::Object(map.clone())
        }
        Some(_) => {
            return Err(BuildingError::validation("invalid_model", vec![], "params must be an object", "send params as {} or {form, palette}"));
        }
    };
    let parts_val = obj.get("parts").ok_or_else(|| {
        BuildingError::validation("invalid_model", vec![], "model.parts is required", "send an array of at most 64 parts")
    })?;
    let parts = parts_val.as_array().ok_or_else(|| {
        BuildingError::validation("invalid_model", vec![], "model.parts must be an array", "send parts as a JSON array")
    })?;
    if parts.len() > MAX_PARTS {
        return Err(BuildingError::validation(
            "parts_limit", vec![],
            format!("model has {} parts; {KIT_VERSION} allows at most {MAX_PARTS}", parts.len()),
            format!("merge or drop parts until the list has {MAX_PARTS} or fewer"),
        ));
    }
    if parts.is_empty() {
        return Err(BuildingError::validation("invalid_model", vec![], "model.parts must contain at least one part", "add a box/cylinder/cone part"));
    }
    let mut seen_ids = std::collections::BTreeSet::new();
    let mut boxes = Vec::new();
    let mut normalized = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let (label, aabb, clean) = validate_part(index, part, &mut seen_ids)?;
        if aabb.out_of_lot() {
            return Err(BuildingError::validation(
                "out_of_bounds", vec![label.clone()],
                format!("part `{label}` extends outside the parcel envelope (±{LOT_HALF_X} x, ±{LOT_HALF_Z} z, height 0..{MAX_HEIGHT})"),
                "shrink size or move `at` so the part stays inside the lot",
            ));
        }
        boxes.push((label, aabb));
        normalized.push(clean);
    }
    for i in 0..boxes.len() {
        for j in (i + 1)..boxes.len() {
            if boxes[i].1.overlaps(&boxes[j].1) {
                return Err(BuildingError::validation(
                    "overlap", vec![boxes[i].0.clone(), boxes[j].0.clone()],
                    format!("parts `{}` and `{}` overlap", boxes[i].0, boxes[j].0),
                    "move or shrink one of the two parts so their boxes no longer intersect",
                ));
            }
        }
    }
    Ok(json!({
        "kit_version": KIT_VERSION,
        "params": params,
        "parts": normalized,
    }))
}

fn validate_part(index: usize, part: &Value, seen_ids: &mut std::collections::BTreeSet<String>) -> Result<(String, Aabb, Value), BuildingError> {
    let obj = part.as_object().ok_or_else(|| {
        BuildingError::validation("invalid_part", vec![index_label(index)], format!("parts[{index}] must be an object"), "each part needs kind, role, at, size")
    })?;
    let fallback = index_label(index);
    if let Some(extra) = obj.keys().find(|k| !PART_KEYS.contains(&k.as_str())) {
        return Err(BuildingError::validation(
            "invalid_part", vec![fallback],
            format!("parts[{index}] has unknown field `{extra}`"),
            "session-kit/v1 parts accept id, kind, role, at, size, rot, color — no scripts",
        ));
    }
    let label = match obj.get("id") {
        None => fallback.clone(),
        Some(Value::String(id)) if !id.is_empty() && id.len() <= 64 => {
            if !seen_ids.insert(id.clone()) {
                return Err(BuildingError::validation(
                    "invalid_part", vec![id.clone()],
                    format!("duplicate part id `{id}`"),
                    "give each part a unique id",
                ));
            }
            id.clone()
        }
        Some(_) => {
            return Err(BuildingError::validation("invalid_part", vec![fallback], format!("parts[{index}].id must be a short string"), "omit id or use a unique string ≤64 chars"));
        }
    };
    let kind = obj.get("kind").and_then(Value::as_str).ok_or_else(|| {
        BuildingError::validation("invalid_part", vec![label.clone()], format!("part `{label}` is missing kind"), "kind must be box, cylinder, or cone")
    })?;
    if !KINDS.contains(&kind) {
        return Err(BuildingError::validation(
            "invalid_part", vec![label.clone()], format!("part `{label}` kind `{kind}` is not in the kit"),
            "use box, cylinder, or cone",
        ));
    }
    let role = obj.get("role").and_then(Value::as_str).ok_or_else(|| {
        BuildingError::validation("invalid_part", vec![label.clone()], format!("part `{label}` is missing role"), "role must be wall, trim, roof, glass, structure, door, or window")
    })?;
    if !ROLES.contains(&role) {
        return Err(BuildingError::validation(
            "invalid_part", vec![label.clone()], format!("part `{label}` role `{role}` is not in the kit"),
            "use wall, trim, roof, glass, structure, door, or window",
        ));
    }
    let at = vec3(obj.get("at"), &label, "at")?;
    let size = vec3(obj.get("size"), &label, "size")?;
    if size.iter().any(|n| *n <= 0.0) {
        return Err(BuildingError::validation(
            "invalid_part", vec![label.clone()], format!("part `{label}` size must be all positive"),
            "set each size component > 0",
        ));
    }
    if size[0] > LOT_HALF_X * 2.0 + 0.5 || size[2] > LOT_HALF_Z * 2.0 + 0.5 || size[1] > MAX_HEIGHT {
        return Err(BuildingError::validation(
            "out_of_bounds", vec![label.clone()], format!("part `{label}` is larger than the parcel"),
            "keep width/depth within the lot and height ≤ 48",
        ));
    }
    let rot = match obj.get("rot") {
        None => None,
        Some(v) => Some(vec3(Some(v), &label, "rot")?),
    };
    if let Some(color) = obj.get("color") {
        let color = color.as_str().ok_or_else(|| {
            BuildingError::validation("invalid_part", vec![label.clone()], format!("part `{label}` color must be a hex string"), "use #rrggbb")
        })?;
        if !is_hex_color(color) {
            return Err(BuildingError::validation(
                "invalid_part", vec![label.clone()], format!("part `{label}` color `{color}` is not #rrggbb"),
                "use a six-digit hex colour such as #c47a54",
            ));
        }
    }
    let aabb = part_aabb(at, size, rot);
    let mut clean = Map::new();
    if let Some(Value::String(id)) = obj.get("id") { clean.insert("id".into(), json!(id)); }
    clean.insert("kind".into(), json!(kind));
    clean.insert("role".into(), json!(role));
    clean.insert("at".into(), json!(at));
    clean.insert("size".into(), json!(size));
    if let Some(rot) = rot { clean.insert("rot".into(), json!(rot)); }
    if let Some(color) = obj.get("color") { clean.insert("color".into(), color.clone()); }
    Ok((label, aabb, Value::Object(clean)))
}

fn vec3(value: Option<&Value>, label: &str, field: &str) -> Result<[f64; 3], BuildingError> {
    let arr = value.and_then(Value::as_array).ok_or_else(|| {
        BuildingError::validation("invalid_part", vec![label.to_string()], format!("part `{label}` {field} must be [x, y, z]"), "send three finite numbers")
    })?;
    if arr.len() != 3 {
        return Err(BuildingError::validation(
            "invalid_part", vec![label.to_string()], format!("part `{label}` {field} must have 3 numbers"), "send [x, y, z]",
        ));
    }
    let mut out = [0.0; 3];
    for (i, item) in arr.iter().enumerate() {
        let n = item.as_f64().ok_or_else(|| {
            BuildingError::validation("invalid_part", vec![label.to_string()], format!("part `{label}` {field}[{i}] is not a number"), "use finite JSON numbers, not strings")
        })?;
        if !n.is_finite() {
            return Err(BuildingError::validation(
                "invalid_part", vec![label.to_string()], format!("part `{label}` {field}[{i}] is not finite"), "replace NaN/Inf with a real number",
            ));
        }
        out[i] = n;
    }
    Ok(out)
}

fn part_aabb(at: [f64; 3], size: [f64; 3], rot: Option<[f64; 3]>) -> Aabb {
    // `at` is the base centre (y = bottom), matching the City Part `anchor: "base"` default.
    let (hx, hz) = if rot.filter(|r| r.iter().any(|n| n.abs() > 1e-6)).is_some() {
        let r = size[0].max(size[2]) / 2.0;
        (r, r)
    } else {
        (size[0] / 2.0, size[2] / 2.0)
    };
    Aabb {
        min: [at[0] - hx, at[1], at[2] - hz],
        max: [at[0] + hx, at[1] + size[1], at[2] + hz],
    }
}

fn is_hex_color(value: &str) -> bool {
    let rest = match value.strip_prefix('#') { Some(r) => r, None => return false };
    rest.len() == 6 && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

fn index_label(index: usize) -> String { format!("#{index}") }

pub fn geometric_summary(model: &Value) -> Value {
    let parts = model.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut bbox: Option<Aabb> = None;
    for (index, part) in parts.iter().enumerate() {
        let at = vec3(part.get("at"), &index_label(index), "at").unwrap_or([0.0; 3]);
        let size = vec3(part.get("size"), &index_label(index), "size").unwrap_or([1.0, 1.0, 1.0]);
        let rot = part.get("rot").and_then(|_| vec3(part.get("rot"), &index_label(index), "rot").ok());
        let aabb = part_aabb(at, size, rot);
        bbox = Some(match bbox {
            None => aabb,
            Some(prev) => Aabb {
                min: [prev.min[0].min(aabb.min[0]), prev.min[1].min(aabb.min[1]), prev.min[2].min(aabb.min[2])],
                max: [prev.max[0].max(aabb.max[0]), prev.max[1].max(aabb.max[1]), prev.max[2].max(aabb.max[2])],
            },
        });
    }
    let bbox = bbox.unwrap_or(Aabb { min: [0.0; 3], max: [0.0; 3] });
    json!({
        "part_count": parts.len(),
        "height": round4(bbox.height()),
        "bbox": { "min": bbox.min.iter().map(|n| json!(round4(*n))).collect::<Vec<_>>(),
            "max": bbox.max.iter().map(|n| json!(round4(*n))).collect::<Vec<_>>() },
    })
}

fn round4(n: f64) -> f64 { (n * 10_000.0).round() / 10_000.0 }

fn default_form(height: f64) -> &'static str {
    if height >= 30.0 { "tower" } else if height >= 14.0 { "midrise" } else { "block" }
}

pub fn default_model(tokens_total: i64) -> Value {
    let height = tokens_to_height(tokens_total);
    let form = default_form(height);
    let (w, d) = match form {
        "tower" => (3.2_f64, 3.2_f64),
        "slab" => (6.4, 3.6),
        "midrise" => (5.2, 4.4),
        _ => (4.6, 4.6),
    };
    let podium_h = 1.2_f64.min(height * 0.2).max(0.6);
    let roof_h = 0.4_f64.min(height * 0.08).max(0.25);
    let shaft_h = (height - podium_h - roof_h).max(0.8);
    let shaft_w = (w * 0.86).max(1.2);
    let shaft_d = (d * 0.86).max(1.2);
    let story_h = (shaft_h / 2.0).clamp(2.4, 4.2);
    json!({
        "kit_version": KIT_VERSION,
        "params": { "form": form, "floors": 2, "story_height": round4(story_h) },
        "parts": [
            { "id": "podium", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [w, podium_h, d] },
            { "id": "shaft", "kind": "box", "role": "wall", "at": [0.0, podium_h, 0.0], "size": [shaft_w, shaft_h, shaft_d] },
            { "id": "roof", "kind": "box", "role": "roof", "at": [0.0, podium_h + shaft_h, 0.0], "size": [w, roof_h, d] },
            { "id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, d / 2.0 + 0.11], "size": [1.2, 2.0, 0.2] },
            { "id": "window", "kind": "box", "role": "window", "at": [0.0, podium_h + shaft_h * 0.35, d / 2.0 + 0.085], "size": [1.4, 1.2, 0.15] },
        ],
    })
}

fn current_model(home: &Path, identity: &BuildingIdentity) -> Result<Value, BuildingError> {
    let db = open_store(home)?;
    let stored = load_override(&db, &identity.asset_ref)?;
    Ok(resolve_to_mesh(identity, stored.model.as_ref()))
}

fn resolve_stored_row(
    home: &Path,
    conn: &Connection,
    asset_ref: &str,
    stored: &StoredOverride,
) -> Result<(Value, Option<Value>), BuildingError> {
    let identity = resolve_identity(home, conn, asset_ref)?;
    let raw = stored.model.as_ref();
    let inheritance = raw.filter(|doc| is_inheritance_document(doc)).cloned();
    let model = resolve_to_mesh(&identity, raw);
    Ok((model, inheritance))
}

fn validate_for_session(
    home: &Path,
    identity: &BuildingIdentity,
    model: &Value,
    inheritance: Option<&Value>,
) -> Result<(Value, Vec<Value>), BuildingError> {
    let clean = validate_model(model)?;
    let slot = derive_slot(&identity.session_key, identity.tokens_total());
    city_building_compliance::validate_model_compliance(&clean, &slot)?;
    let current = current_model(home, identity)?;
    city_building_compliance::validate_detail_regression(&current, &clean, &slot)?;
    let warnings = city_building_design::validate_design_coherence(&current, &clean, inheritance)?;
    Ok((clean, warnings))
}

fn attach_design_warnings(mut out: Value, warnings: Vec<Value>) -> Value {
    let n = warnings.len();
    out["warnings"] = json!(warnings);
    if n > 0 {
        if let Some(text) = out.pointer("/observe/text").and_then(Value::as_str) {
            let suffix = if n == 1 { "warning" } else { "warnings" };
            out["observe"]["text"] = json!(format!("{text}; {n} design {suffix} — show them before set"));
        }
    }
    out
}

pub(crate) fn open_store(home: &Path) -> Result<Connection, BuildingError> {
    let dir = store_dir(home);
    std::fs::create_dir_all(&dir).map_err(|_| store_unavailable())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let path = dir.join("overrides.sqlite");
    let db = Connection::open(&path).map_err(|_| store_unavailable())?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(|_| store_unavailable())?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS overrides(
            asset_ref TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            kit_version TEXT NOT NULL,
            model_json TEXT,
            updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS build_events(
            build_event_id TEXT PRIMARY KEY,
            asset_ref TEXT NOT NULL,
            revision INTEGER NOT NULL,
            kind TEXT NOT NULL,
            part_count INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS claims(
            session_id TEXT NOT NULL,
            asset_ref TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, asset_ref)
         );",
    ).map_err(|_| store_unavailable())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(db)
}

fn store_unavailable() -> BuildingError {
    BuildingError::new(
        "not_found",
        "store_unavailable",
        Vec::new(),
        "city building override store is unavailable",
        Some("retry; the store lives under state/plugins/city-buildings/".into()),
        Vec::new(),
    )
}

#[derive(Debug, Clone)]
struct StoredOverride {
    revision: u64,
    kit_version: String,
    model: Option<Value>,
}

fn load_override(db: &Connection, asset_ref: &str) -> Result<StoredOverride, BuildingError> {
    let row: Option<(u64, String, Option<String>)> = db.query_row(
        "SELECT revision, kit_version, model_json FROM overrides WHERE asset_ref=?1",
        [asset_ref],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(|_| store_unavailable())?;
    match row {
        None => Ok(StoredOverride { revision: 0, kit_version: KIT_VERSION.to_string(), model: None }),
        Some((revision, kit_version, model_json)) => {
            let model = match model_json {
                None => None,
                Some(raw) => Some(serde_json::from_str(&raw).map_err(|_| store_unavailable())?),
            };
            Ok(StoredOverride { revision, kit_version, model })
        }
    }
}

fn new_build_event_id(db: &Connection) -> Result<String, BuildingError> {
    let hex: String = db.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))
        .map_err(|_| store_unavailable())?;
    Ok(format!("be_{hex}"))
}

fn construction_stub(kind: &str, part_count: usize, build_event_id: &str, ui: &str) -> Value {
    json!({
        "mode": "block-by-block",
        "replayable": true,
        "status": if ui == "pushed" { "notified" } else { "queued" },
        "kind": kind,
        "part_count": part_count,
        "build_event_id": build_event_id,
        // pushed = host socket accepted the event; queued = mailbox only (City
        // or PluginHost poll of build_events / notify.json is the backup).
        "ui": ui,
    })
}

/// Directory that owns the override SQLite, the notify mailbox, and the host socket.
pub fn store_dir(home: &Path) -> PathBuf {
    home.join("state/plugins/city-buildings")
}

pub fn store_path(home: &Path) -> PathBuf {
    store_dir(home).join("overrides.sqlite")
}

pub fn mailbox_path(home: &Path) -> PathBuf {
    store_dir(home).join("notify.json")
}

pub fn socket_path(home: &Path) -> PathBuf {
    store_dir(home).join("host.sock")
}

/// Host event contract: PluginHost evals this JSON as `__AV_PLUGIN_ENTITY_CHANGED__`.
/// Generic fields (`entity_kind` / `entity_id` / `action` / `revision` / `event_id`)
/// are the reusable shape; building aliases (`asset_ref`, `build_event_id`, `kind`)
/// stay so MCP + SQLite vocabulary round-trips.
pub fn entity_changed_payload(
    entity_kind: &str,
    entity_id: &str,
    action: &str,
    revision: u64,
    event_id: &str,
) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("type".into(), json!(ENTITY_CHANGED_TYPE));
    out.insert("schema_version".into(), json!(1));
    out.insert("entity_kind".into(), json!(entity_kind));
    out.insert("entity_id".into(), json!(entity_id));
    out.insert("action".into(), json!(action));
    out.insert("revision".into(), json!(revision));
    out.insert("event_id".into(), json!(event_id));
    out
}

pub fn building_changed_payload(identity: &BuildingIdentity, revision: u64, build_event_id: &str, kind: &str, body: Value) -> Value {
    let mut payload = entity_changed_payload(
        ENTITY_KIND_BUILDING, &identity.asset_ref, kind, revision, build_event_id,
    );
    payload.insert("asset_ref".into(), json!(identity.asset_ref));
    payload.insert("session_id".into(), json!(identity.session_id));
    payload.insert("build_event_id".into(), json!(build_event_id));
    payload.insert("kind".into(), json!(kind));
    if let Some(extra) = body.as_object() {
        for (key, value) in extra { payload.insert(key.clone(), value.clone()); }
    }
    Value::Object(payload)
}

pub fn entity_event_id(payload: &Value) -> Option<&str> {
    payload.get("event_id").and_then(Value::as_str).filter(|s| !s.is_empty())
        .or_else(|| payload.get("build_event_id").and_then(Value::as_str).filter(|s| !s.is_empty()))
}

pub fn is_entity_changed(payload: &Value) -> bool {
    payload.get("type").and_then(Value::as_str) == Some(ENTITY_CHANGED_TYPE)
        && payload.get("entity_kind").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && payload.get("entity_id").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && matches!(
            payload.get("action").and_then(Value::as_str),
            Some("set") | Some("reset") | Some(ENTITY_ACTION_PREVIEW) | Some(ENTITY_ACTION_REJECT)
        )
        && payload.get("revision").and_then(Value::as_u64).is_some()
        && entity_event_id(payload).is_some()
}

pub fn is_flash_rule(rule: &str) -> bool {
    FLASH_RULES.contains(&rule)
}

pub fn edit_mailbox_path(home: &Path) -> PathBuf {
    store_dir(home).join("edit.json")
}

fn write_mailbox(home: &Path, payload: &Value) -> Result<(), BuildingError> {
    let dir = store_dir(home);
    std::fs::create_dir_all(&dir).map_err(|_| store_unavailable())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let path = mailbox_path(home);
    let tmp = dir.join("notify.json.tmp");
    std::fs::write(&tmp, payload.to_string()).map_err(|_| store_unavailable())?;
    std::fs::rename(&tmp, &path).map_err(|_| store_unavailable())?;
    Ok(())
}

/// Best-effort push to the desktop PluginHost. Returns true when the host socket
/// accepted a full JSON line. Failure is not an error: mailbox + build_events stay.
pub fn try_push_socket(home: &Path, payload: &Value) -> bool {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        use std::time::Duration;
        let Ok(mut stream) = UnixStream::connect(socket_path(home)) else { return false; };
        let _ = stream.set_write_timeout(Some(Duration::from_millis(150)));
        let _ = stream.set_read_timeout(Some(Duration::from_millis(150)));
        let line = format!("{payload}\n");
        stream.write_all(line.as_bytes()).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = (home, payload);
        false
    }
}

/// Persist-path notify: mailbox always, socket when the host is listening.
/// `"pushed"` / `"queued"` become `construction.ui`.
pub fn notify_city_ui(home: &Path, payload: &Value) -> &'static str {
    let _ = write_mailbox(home, payload);
    if try_push_socket(home, payload) { "pushed" } else { "queued" }
}

pub fn read_mailbox(home: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(mailbox_path(home)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn write_named_mailbox(home: &Path, filename: &str, payload: &Value) -> Result<(), BuildingError> {
    let dir = store_dir(home);
    std::fs::create_dir_all(&dir).map_err(|_| store_unavailable())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let path = dir.join(filename);
    let tmp = dir.join(format!("{filename}.tmp"));
    std::fs::write(&tmp, payload.to_string()).map_err(|_| store_unavailable())?;
    std::fs::rename(&tmp, &path).map_err(|_| store_unavailable())?;
    Ok(())
}

fn write_edit_mailbox(home: &Path, payload: &Value) -> Result<(), BuildingError> {
    write_named_mailbox(home, "edit.json", payload)
}

/// Preview / reject notify: separate mailbox so persist `notify.json` stays intact.
/// `"pushed"` / `"queued"` become `notify.ui`. Ghost/flash only matter while City is open.
pub fn notify_edit_ui(home: &Path, payload: &Value) -> &'static str {
    let _ = write_edit_mailbox(home, payload);
    if try_push_socket(home, payload) { "pushed" } else { "queued" }
}

pub fn read_edit_mailbox(home: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(edit_mailbox_path(home)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn peek_revision(home: &Path, asset_ref: &str) -> u64 {
    open_existing(home).ok().flatten()
        .and_then(|db| load_override(&db, asset_ref).ok())
        .map(|stored| stored.revision)
        .unwrap_or(0)
}

fn new_edit_event_id(action: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let now = crate::clock::now_ms();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("ui_{action}_{now:012x}{seq:08x}")
}

fn attach_edit_notify(
    home: &Path,
    identity: &BuildingIdentity,
    action: &str,
    extra: Value,
) -> Value {
    let revision = peek_revision(home, &identity.asset_ref);
    let event_id = new_edit_event_id(action);
    let payload = building_changed_payload(identity, revision, &event_id, action, extra);
    let ui = notify_edit_ui(home, &payload);
    json!({
        "channel": if ui == "pushed" { "host-socket" } else { "mailbox" },
        "ui": ui,
        "action": action,
        "event_id": event_id,
        "revision": revision,
    })
}

fn with_preview_notify(mut out: Value, home: &Path, identity: &BuildingIdentity, model: &Value, warnings: &[Value]) -> Value {
    let summary = geometric_summary(model);
    out["notify"] = attach_edit_notify(home, identity, ENTITY_ACTION_PREVIEW, json!({
        "source": "preview",
        "ephemeral": true,
        "persisted": false,
        "model": model,
        "error": Value::Null,
    }));
    attach_squad(out, home, identity, ENTITY_ACTION_PREVIEW, squad_facts(json!({
        "asset_ref": identity.asset_ref,
        "ok": true,
        "revision": peek_revision(home, &identity.asset_ref),
    }), Some(&summary), warnings))
}

fn with_reject_notify(mut out: Value, home: &Path, identity: &BuildingIdentity, error: &BuildingError, origin: &str) -> Value {
    if is_flash_rule(error.rule) {
        out["notify"] = attach_edit_notify(home, identity, ENTITY_ACTION_REJECT, json!({
            "source": "reject",
            "ephemeral": true,
            "persisted": false,
            "error": error.to_json(),
        }));
        return attach_squad(out, home, identity, ENTITY_ACTION_REJECT, json!({
            "asset_ref": identity.asset_ref,
            "ok": false,
            "error": error.message.as_str(),
            "rule": error.rule,
            "revision": peek_revision(home, &identity.asset_ref),
        }));
    }
    attach_squad(out, home, identity, origin, json!({
        "asset_ref": identity.asset_ref,
        "ok": false,
        "error": error.message.as_str(),
        "rule": error.rule,
        "revision": peek_revision(home, &identity.asset_ref),
    }))
}

fn attach_squad(mut out: Value, home: &Path, identity: &BuildingIdentity, kind: &str, payload: Value) -> Value {
    if let Some(squad) = city_im::fanout_building(home, identity, &city_im::connection_actor(), kind, payload) {
        out["squad"] = squad;
    }
    out
}

/// Squad row facts the City feed can turn into a sentence. `warnings` are the
/// soft design notes; hard failures already carry `error` on `base`.
fn squad_facts(mut base: Value, summary: Option<&Value>, warnings: &[Value]) -> Value {
    if let Some(summary) = summary {
        if let Some(count) = summary.get("part_count").and_then(Value::as_u64) {
            base["part_count"] = json!(count);
        }
        if let Some(height) = summary.get("height").and_then(Value::as_f64) {
            base["height"] = json!(height);
        }
    }
    if !warnings.is_empty() {
        let brief: Vec<Value> = warnings.iter().take(3).filter_map(|warning| {
            let message = warning.get("message").and_then(Value::as_str).unwrap_or("").trim();
            if message.is_empty() { return None; }
            Some(json!({
                "rule": warning.get("rule").and_then(Value::as_str).unwrap_or(""),
                "message": clip_chars(message, 120),
            }))
        }).collect();
        if !brief.is_empty() {
            base["warnings"] = json!(brief);
        }
    }
    base
}

fn clip_chars(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars { break; }
        out.push(ch);
    }
    out
}

/// Current overrides (model_json NOT NULL). Missing store → empty, not an error.
/// `model` is always the resolved mesh for City UI; `inheritance` is present when stored as layer 2.
pub fn list_overrides(
    home: &Path,
    authority: Option<&Connection>,
    asset_refs: &[String],
) -> Result<Vec<Value>, BuildingError> {
    let Some(db) = open_existing(home)? else { return Ok(Vec::new()); };
    if asset_refs.len() > 200 {
        return Err(BuildingError::validation(
            "invalid_model", vec![], "at most 200 asset_refs", "split the request",
        ));
    }
    let mut out = Vec::new();
    if asset_refs.is_empty() {
        let mut stmt = db.prepare(
            "SELECT asset_ref, revision, kit_version, model_json, updated_at_ms
             FROM overrides WHERE model_json IS NOT NULL ORDER BY updated_at_ms DESC LIMIT 200",
        ).map_err(|_| store_unavailable())?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
        }).map_err(|_| store_unavailable())?;
        for row in rows {
            let (asset_ref, revision, kit_version, model_json, updated_at_ms) = row.map_err(|_| store_unavailable())?;
            let stored_doc: Value = serde_json::from_str(&model_json).map_err(|_| store_unavailable())?;
            let row = override_list_row(home, authority, &asset_ref, revision as u64, &kit_version, &stored_doc, Some(updated_at_ms))?;
            out.push(row);
        }
        return Ok(out);
    }
    for asset_ref in asset_refs {
        if !is_asset_ref(asset_ref) { continue; }
        let stored = load_override(&db, asset_ref)?;
        let Some(stored_doc) = stored.model else { continue; };
        out.push(override_list_row(
            home,
            authority,
            asset_ref,
            stored.revision,
            &stored.kit_version,
            &stored_doc,
            None,
        )?);
    }
    Ok(out)
}

fn override_list_row(
    home: &Path,
    authority: Option<&Connection>,
    asset_ref: &str,
    revision: u64,
    kit_version: &str,
    stored_doc: &Value,
    updated_at_ms: Option<i64>,
) -> Result<Value, BuildingError> {
    let inheritance = stored_doc
        .as_object()
        .filter(|_| is_inheritance_document(stored_doc))
        .map(|_| stored_doc.clone());
    let model = if is_inheritance_document(stored_doc) {
        if let Some(conn) = authority {
            resolve_stored_row(home, conn, asset_ref, &StoredOverride {
                revision,
                kit_version: kit_version.to_string(),
                model: Some(stored_doc.clone()),
            })?
            .0
        } else {
            resolve_inheritance(
                &BuildingIdentity {
                    asset_ref: asset_ref.to_string(),
                    session_id: String::new(),
                    harness: String::new(),
                    session_key: String::new(),
                    tokens_total: 50_000,
                },
                stored_doc,
            )?
        }
    } else {
        stored_doc.clone()
    };
    let mut row = json!({
        "asset_ref": asset_ref,
        "revision": revision,
        "kit_version": kit_version,
        "source": "override",
        "model": model,
    });
    if let Some(ms) = updated_at_ms {
        row["updated_at_ms"] = json!(ms);
    }
    if let Some(inheritance) = inheritance {
        row["inheritance"] = inheritance;
    }
    Ok(row)
}

/// Queued construction records. Missing store → empty.
pub fn list_build_events(home: &Path, asset_refs: &[String], since_ms: Option<i64>, limit: usize) -> Result<Vec<Value>, BuildingError> {
    let Some(db) = open_existing(home)? else { return Ok(Vec::new()); };
    let limit = limit.clamp(1, 200) as i64;
    let since = since_ms.unwrap_or(0);
    let mut out = Vec::new();
    if asset_refs.is_empty() {
        let mut stmt = db.prepare(
            "SELECT build_event_id, asset_ref, revision, kind, part_count, created_at_ms
             FROM build_events WHERE created_at_ms >= ?1
             ORDER BY created_at_ms DESC, build_event_id DESC LIMIT ?2",
        ).map_err(|_| store_unavailable())?;
        let rows = stmt.query_map(params![since, limit], event_row).map_err(|_| store_unavailable())?;
        for row in rows { out.push(row.map_err(|_| store_unavailable())?); }
        return Ok(out);
    }
    for asset_ref in asset_refs {
        if !is_asset_ref(asset_ref) { continue; }
        let mut stmt = db.prepare(
            "SELECT build_event_id, asset_ref, revision, kind, part_count, created_at_ms
             FROM build_events WHERE asset_ref=?1 AND created_at_ms >= ?2
             ORDER BY created_at_ms DESC, build_event_id DESC LIMIT ?3",
        ).map_err(|_| store_unavailable())?;
        let rows = stmt.query_map(params![asset_ref, since, limit], event_row).map_err(|_| store_unavailable())?;
        for row in rows { out.push(row.map_err(|_| store_unavailable())?); }
    }
    Ok(out)
}

fn event_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let build_event_id: String = r.get(0)?;
    let asset_ref: String = r.get(1)?;
    let revision: i64 = r.get(2)?;
    let kind: String = r.get(3)?;
    Ok(json!({
        "type": ENTITY_CHANGED_TYPE,
        "entity_kind": ENTITY_KIND_BUILDING,
        "entity_id": asset_ref,
        "action": kind,
        "revision": revision,
        "event_id": build_event_id,
        "build_event_id": build_event_id,
        "asset_ref": asset_ref,
        "kind": kind,
        "part_count": r.get::<_, i64>(4)?,
        "created_at_ms": r.get::<_, i64>(5)?,
    }))
}

fn is_asset_ref(value: &str) -> bool {
    value.starts_with("ca_") && value.len() == 35 && value.as_bytes()[3..].iter().all(|b| b.is_ascii_hexdigit())
}

fn open_existing(home: &Path) -> Result<Option<Connection>, BuildingError> {
    if !store_path(home).exists() { return Ok(None); }
    Ok(Some(open_store(home)?))
}

fn observe_text(source: &str, summary: &Value, revision: u64) -> String {
    format!(
        "{source} model, {} parts, height {}, revision {revision}",
        summary["part_count"], summary["height"]
    )
}

pub fn resolve_identity(home: &Path, conn: &Connection, session_id: &str) -> Result<BuildingIdentity, BuildingError> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 80 {
        return Err(BuildingError::not_found(session_id));
    }
    let salt = session_ref::load_or_create_salt(home).map_err(|_| BuildingError::not_found(session_id))?;
    let keys = agent_vitals_data::authority_query::all_session_keys(conn)
        .map_err(|_| BuildingError::not_found(session_id))?;
    let session_key = if session_id.starts_with("ca_") && session_id.len() == 35
        && session_id.as_bytes()[3..].iter().all(|b| b.is_ascii_hexdigit())
    {
        let assets = city_assets::publish(home, conn, &keys).map_err(|_| store_unavailable())?;
        assets.by_session.iter().find(|(_, asset)| asset.as_str() == session_id)
            .map(|(key, _)| key.clone())
            .ok_or_else(|| BuildingError::not_found(session_id))?
    } else if session_id.starts_with("sr_") && session_id.len() == 35
        && session_id.as_bytes()[3..].iter().all(|b| b.is_ascii_hexdigit())
    {
        session_ref::resolve(&salt, session_id, keys.clone())
            .or_else(|| {
                // city:v3 page `id` is HMAC("app:city:{session_key}"), not MCP session_ref.
                keys.into_iter().find(|key| session_ref(&salt, &format!("app:city:{key}")) == session_id)
            })
            .ok_or_else(|| BuildingError::not_found(session_id))?
    } else {
        return Err(BuildingError::not_found(session_id));
    };
    let assets = city_assets::publish(home, conn, std::slice::from_ref(&session_key)).map_err(|_| store_unavailable())?;
    let asset_ref = assets.by_session.get(&session_key).cloned().ok_or_else(|| BuildingError::not_found(session_id))?;
    let (harness, tokens_total) = session_stats(conn, &session_key)?;
    Ok(BuildingIdentity {
        asset_ref,
        session_id: session_ref(&salt, &session_key),
        harness,
        session_key,
        tokens_total,
    })
}

fn session_stats(conn: &Connection, session_key: &str) -> Result<(String, i64), BuildingError> {
    let harness: String = conn.query_row(
        "SELECT harness FROM sessions WHERE session_key=?1 AND deleted_at_ms IS NULL",
        [session_key],
        |r| r.get(0),
    ).map_err(|_| BuildingError::not_found(session_key))?;
    let tokens: i64 = conn.query_row(
        "SELECT COALESCE(SUM(uncached_input_tokens+cache_read_tokens+cache_write_tokens+output_tokens),0)
         FROM usage_facts WHERE session_key=?1 AND deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate'",
        [session_key],
        |r| r.get(0),
    ).unwrap_or(0);
    Ok((harness, tokens))
}

fn projection_meta(identity: &BuildingIdentity, summary: &Value, kit_status: &str) -> Value {
    let slot = derive_slot(&identity.session_key, identity.tokens_total());
    json!({
        "asset_ref": identity.asset_ref,
        "session_id": identity.session_id,
        "harness": identity.harness,
        "height": summary["height"],
        "lot": slot_to_json(&slot),
        "compliant_catalog": compliant_catalog_ids(&slot),
        "parcel": { "state": "unavailable", "reason": "city_layout_not_in_building_store" },
        "kit_status": kit_status,
        "screenshot": { "state": "unavailable", "reason": "optional_vision_attachment_not_in_mvp" },
    })
}

pub fn get_building(home: &Path, conn: &Connection, session_id: &str) -> Result<Value, BuildingError> {
    let identity = resolve_identity(home, conn, session_id)?;
    let db = open_store(home)?;
    let stored = load_override(&db, &identity.asset_ref)?;
    let (model, inheritance, source, kit_status) = match &stored.model {
        Some(doc) if is_inheritance_document(doc) => {
            let status = if stored.kit_version == INHERITANCE_KIT_VERSION { "current" } else { "frozen" };
            (
                resolve_to_mesh(&identity, Some(doc)),
                Some(doc.clone()),
                "override",
                status,
            )
        }
        Some(model) => {
            let status = if stored.kit_version == KIT_VERSION { "current" } else { "frozen" };
            (model.clone(), None, "override", status)
        }
        None => (default_model(identity.tokens_total()), None, "default", "current"),
    };
    let summary = geometric_summary(&model);
    let mut out = json!({
        "ok": true,
        "error": Value::Null,
        "source": source,
        "revision": stored.revision,
        "kit_version": stored.kit_version,
        "model": model,
        "summary": summary,
        "observe": { "text": observe_text(source, &summary, stored.revision), "summary": summary },
        "projection": projection_meta(&identity, &summary, kit_status),
    });
    if let Some(inheritance) = inheritance {
        out["inheritance"] = inheritance;
    }
    Ok(out)
}

pub fn preview_building(home: &Path, conn: &Connection, session_id: &str, inheritance: &Value) -> Result<Value, BuildingError> {
    let identity = resolve_identity(home, conn, session_id)?;
    if inheritance.get("reset").and_then(Value::as_bool) == Some(true) {
        let clean = default_model(identity.tokens_total());
        let summary = geometric_summary(&clean);
        return Ok(attach_design_warnings(with_preview_notify(json!({
            "ok": true,
            "error": Value::Null,
            "persisted": false,
            "kit_version": INHERITANCE_KIT_VERSION,
            "inheritance": inheritance,
            "model": clean,
            "summary": summary,
            "observe": { "text": observe_text("preview-reset", &summary, 0), "summary": summary },
            "projection": projection_meta(&identity, &summary, "current"),
        }), home, &identity, &clean, &[]), Vec::new()));
    }
    let merged = match resolve_inheritance(&identity, inheritance) {
        Ok(clean) => clean,
        Err(error) => {
            return Ok(with_reject_notify(json!({
                "ok": false,
                "error": error.to_json(),
                "persisted": false,
                "kit_version": INHERITANCE_KIT_VERSION,
                "summary": Value::Null,
                "projection": {
                    "asset_ref": identity.asset_ref,
                    "session_id": identity.session_id,
                    "harness": identity.harness,
                    "lot": slot_to_json(&derive_slot(&identity.session_key, identity.tokens_total())),
                    "compliant_catalog": json!(compliant_catalog_ids(&derive_slot(&identity.session_key, identity.tokens_total()))),
                    "parcel": { "state": "unavailable", "reason": "city_layout_not_in_building_store" },
                },
            }), home, &identity, &error, ENTITY_ACTION_PREVIEW));
        }
    };
    match validate_for_session(home, &identity, &merged, Some(inheritance)) {
        Ok((clean, warnings)) => {
            let summary = geometric_summary(&clean);
            Ok(attach_design_warnings(with_preview_notify(json!({
                "ok": true,
                "error": Value::Null,
                "persisted": false,
                "kit_version": INHERITANCE_KIT_VERSION,
                "inheritance": inheritance,
                "model": clean,
                "summary": summary,
                "observe": { "text": observe_text("preview", &summary, 0), "summary": summary },
                "projection": projection_meta(&identity, &summary, "current"),
            }), home, &identity, &clean, &warnings), warnings))
        }
        Err(error) => Ok(with_reject_notify(json!({
            "ok": false,
            "error": error.to_json(),
            "persisted": false,
            "kit_version": INHERITANCE_KIT_VERSION,
            "inheritance": inheritance,
            "summary": Value::Null,
            "projection": {
                "asset_ref": identity.asset_ref,
                "session_id": identity.session_id,
                "harness": identity.harness,
                "lot": slot_to_json(&derive_slot(&identity.session_key, identity.tokens_total())),
                "compliant_catalog": json!(compliant_catalog_ids(&derive_slot(&identity.session_key, identity.tokens_total()))),
                "parcel": { "state": "unavailable", "reason": "city_layout_not_in_building_store" },
            },
        }), home, &identity, &error, ENTITY_ACTION_PREVIEW)),
    }
}

pub fn set_building_model(
    home: &Path,
    conn: &Connection,
    session_id: &str,
    inheritance: &Value,
    expected_revision: u64,
) -> Result<Value, BuildingError> {
    let identity = resolve_identity(home, conn, session_id)?;
    if inheritance.get("reset").and_then(Value::as_bool) == Some(true) {
        return apply_override(home, &identity, None, expected_revision, "reset", None, Vec::new());
    }
    let merged = match resolve_inheritance(&identity, inheritance) {
        Ok(clean) => clean,
        Err(error) => {
            return Ok(attach_squad(json!({
                "ok": false,
                "error": error.to_json(),
                "persisted": false,
                "revision": current_revision(home, &identity.asset_ref)?,
            }), home, &identity, "set", json!({
                "asset_ref": identity.asset_ref,
                "ok": false,
                "error": error.message.as_str(),
                "rule": error.rule,
                "revision": current_revision(home, &identity.asset_ref)?,
            })));
        }
    };
    let (clean, warnings) = match validate_for_session(home, &identity, &merged, Some(inheritance)) {
        Ok(pair) => pair,
        Err(error) => {
            return Ok(with_reject_notify(json!({
                "ok": false,
                "error": error.to_json(),
                "persisted": false,
                "revision": current_revision(home, &identity.asset_ref)?,
            }), home, &identity, &error, "set"));
        }
    };
    let stored = normalize_inheritance(inheritance)?;
    apply_override(home, &identity, Some(stored), expected_revision, "set", Some(clean), warnings)
}

pub fn reset_building(home: &Path, conn: &Connection, session_id: &str, expected_revision: u64) -> Result<Value, BuildingError> {
    let identity = resolve_identity(home, conn, session_id)?;
    apply_override(home, &identity, None, expected_revision, "reset", None, Vec::new())
}

fn current_revision(home: &Path, asset_ref: &str) -> Result<u64, BuildingError> {
    let db = open_store(home)?;
    Ok(load_override(&db, asset_ref)?.revision)
}

fn apply_override(
    home: &Path,
    identity: &BuildingIdentity,
    model: Option<Value>,
    expected_revision: u64,
    kind: &str,
    resolved_applied: Option<Value>,
    warnings: Vec<Value>,
) -> Result<Value, BuildingError> {
    let db = open_store(home)?;
    db.execute_batch("BEGIN IMMEDIATE").map_err(|_| store_unavailable())?;
    let stored = match load_override(&db, &identity.asset_ref) {
        Ok(stored) => stored,
        Err(error) => { let _ = db.execute_batch("ROLLBACK"); return Err(error); }
    };
    if stored.revision != expected_revision {
        let _ = db.execute_batch("ROLLBACK");
        let error = BuildingError::conflict(stored.revision);
        return Ok(attach_squad(json!({
            "ok": false,
            "error": error.to_json(),
            "persisted": false,
            "revision": stored.revision,
        }), home, identity, kind, json!({
            "asset_ref": identity.asset_ref,
            "ok": false,
            "error": error.message.as_str(),
            "rule": error.rule,
            "revision": stored.revision,
        })));
    }
    let next = stored.revision + 1;
    let now = crate::clock::now_ms();
    let model_json = model.as_ref().map(|value| value.to_string());
    let kit_version = model.as_ref()
        .and_then(|value| value.get("kit_version").and_then(Value::as_str))
        .unwrap_or(KIT_VERSION);
    if db.execute(
        "INSERT INTO overrides(asset_ref, revision, kit_version, model_json, updated_at_ms)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(asset_ref) DO UPDATE SET
            revision=excluded.revision, kit_version=excluded.kit_version,
            model_json=excluded.model_json, updated_at_ms=excluded.updated_at_ms",
        params![identity.asset_ref, next as i64, kit_version, model_json, now],
    ).is_err() {
        let _ = db.execute_batch("ROLLBACK");
        return Err(store_unavailable());
    }
    let applied = match (&model, resolved_applied) {
        (None, _) => default_model(identity.tokens_total()),
        (_, Some(mesh)) => mesh,
        (Some(value), None) => {
            if is_inheritance_document(value) {
                resolve_inheritance(identity, value)?
            } else {
                value.clone()
            }
        }
    };
    let summary = geometric_summary(&applied);
    let part_count = summary["part_count"].as_u64().unwrap_or(0) as i64;
    let build_event_id = match new_build_event_id(&db) {
        Ok(id) => id,
        Err(error) => { let _ = db.execute_batch("ROLLBACK"); return Err(error); }
    };
    if db.execute(
        "INSERT INTO build_events(build_event_id, asset_ref, revision, kind, part_count, created_at_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![build_event_id, identity.asset_ref, next as i64, kind, part_count, now],
    ).is_err() {
        let _ = db.execute_batch("ROLLBACK");
        return Err(store_unavailable());
    }
    db.execute_batch("COMMIT").map_err(|_| store_unavailable())?;
    let source = if model.is_some() { "override" } else { "default" };
    let payload = building_changed_payload(identity, next, &build_event_id, kind, json!({
        "source": source, "kit_version": kit_version, "part_count": summary["part_count"],
        "model": applied, "summary": summary,
    }));
    // Construction notify first so IM fanout cannot block or overwrite persist mailbox.
    let ui = notify_city_ui(home, &payload);
    city_im::release_set_won(home, identity, &city_im::connection_actor());
    Ok(attach_design_warnings(attach_squad(json!({
        "ok": true,
        "error": Value::Null,
        "persisted": true,
        "source": source,
        "revision": next,
        "build_event_id": build_event_id,
        "kit_version": kit_version,
        "model": applied,
        "summary": summary,
        "observe": { "text": observe_text(source, &summary, next), "summary": summary },
        "construction": construction_stub(kind, part_count as usize, &build_event_id, ui),
        "notify": { "channel": if ui == "pushed" { "host-socket" } else { "mailbox" }, "ui": ui },
        "projection": projection_meta(identity, &summary, "current"),
    }), home, identity, kind, squad_facts(json!({
        "asset_ref": identity.asset_ref,
        "ok": true,
        "revision": next,
        "build_event_id": build_event_id,
    }), Some(&summary), &warnings)), warnings))
}

#[cfg(test)]
pub(crate) fn test_building_identity(tokens_total: i64) -> BuildingIdentity {
    BuildingIdentity {
        asset_ref: "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        session_id: "sr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
        harness: "codex".into(),
        session_key: "sess".into(),
        tokens_total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::{AuthorityDb, default_authority_path};

    fn valid_part(id: &str, y: f64) -> Value {
        json!({"id": id, "kind": "box", "role": "wall", "at": [0.0, y, 0.0], "size": [2.0, 1.0, 2.0]})
    }
    fn valid_model(parts: Vec<Value>) -> Value {
        json!({"kit_version": KIT_VERSION, "params": {"form": "tower"}, "parts": parts})
    }

    #[test]
    fn rejects_too_many_parts_unknown_fields_overlap_and_out_of_bounds() {
        let mut parts = Vec::new();
        for i in 0..65 {
            parts.push(json!({"id": format!("p{i}"), "kind": "box", "role": "wall",
                "at": [0.0, i as f64, 0.0], "size": [1.0, 0.8, 1.0]}));
        }
        let err = validate_model(&valid_model(parts)).unwrap_err();
        assert_eq!(err.rule, "parts_limit");
        assert_eq!(err.kind, "validation");

        let err = validate_model(&json!({"kit_version": KIT_VERSION, "params": {}, "parts": [valid_part("a", 0.0)], "script": "nope"})).unwrap_err();
        assert_eq!(err.rule, "invalid_model");
        assert!(err.message.contains("script"));

        let err = validate_model(&valid_model(vec![valid_part("a", 0.0), valid_part("b", 0.2)])).unwrap_err();
        assert_eq!(err.rule, "overlap");
        assert_eq!(err.parts, vec!["a", "b"]);

        let far = json!({"id": "away", "kind": "box", "role": "wall", "at": [20.0, 0.0, 0.0], "size": [2.0, 1.0, 2.0]});
        let err = validate_model(&valid_model(vec![far])).unwrap_err();
        assert_eq!(err.rule, "out_of_bounds");
    }

    #[test]
    fn accepts_stacked_boxes_and_summarises_height() {
        let model = validate_model(&valid_model(vec![valid_part("a", 0.0), valid_part("b", 1.2)])).unwrap();
        let summary = geometric_summary(&model);
        assert_eq!(summary["part_count"], 2);
        assert_eq!(summary["height"], 2.2);
    }

    fn inh_catalog(catalog_id: &str, overrides: Value) -> Value {
        json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "catalog", "catalog_id": catalog_id },
            "overrides": overrides,
        })
    }

    #[test]
    fn preview_rejects_detail_regression_against_current_model() {
        let (home, db, session_id) = seed();
        let rich = inh_catalog("kit-fine-midrise", json!({}));
        let set = set_building_model(&home, db.conn(), &session_id, &rich, 0).unwrap();
        assert_eq!(set["ok"], true);

        let coarser = inh_catalog("kit-low-block", json!({ "params": { "detail_tier": "coarse" } }));
        let fail = preview_building(&home, db.conn(), &session_id, &coarser).unwrap();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"]["rule"], "detail_regression");
        assert!(fail["error"]["compliant_models"].as_array().is_some_and(|a| !a.is_empty()));
        assert_eq!(fail["notify"]["action"], ENTITY_ACTION_REJECT);
        let edit = read_edit_mailbox(&home).expect("edit mailbox after detail_regression");
        assert_eq!(edit["action"], ENTITY_ACTION_REJECT);
        assert_eq!(edit["error"]["rule"], "detail_regression");
        let persist = read_mailbox(&home).expect("persist mailbox from prior set");
        assert_eq!(persist["action"], "set");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn preview_rejects_compliance_pillar_with_invalid_model_candidates() {
        let (home, db, session_id) = seed();
        let pillar = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {
                "parts_remove": ["podium", "shaft", "roof", "door", "window"],
                "parts_add": [{
                    "id": "pin",
                    "kind": "box",
                    "role": "wall",
                    "at": [0.0, 0.0, 0.0],
                    "size": [0.8, 10.0, 0.8]
                }]
            }
        });
        let fail = preview_building(&home, db.conn(), &session_id, &pillar).unwrap();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"]["rule"], "invalid_model");
        assert!(fail["error"]["compliant_models"].as_array().is_some_and(|a| !a.is_empty()));
        assert_eq!(fail["notify"]["action"], ENTITY_ACTION_REJECT);
        assert!(fail["notify"]["event_id"].as_str().unwrap().starts_with("ui_reject_"));
        let edit = read_edit_mailbox(&home).expect("edit mailbox after reject");
        assert!(is_entity_changed(&edit));
        assert_eq!(edit["action"], ENTITY_ACTION_REJECT);
        assert_eq!(edit["error"]["rule"], "invalid_model");
        assert_eq!(edit["ephemeral"], true);
        assert!(read_mailbox(&home).is_none(), "reject must not overwrite persist mailbox");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn preview_success_notifies_ghost_without_touching_persist_mailbox() {
        let (home, db, session_id) = seed();
        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let set = set_building_model(&home, db.conn(), &session_id, &inheritance, 0).unwrap();
        assert_eq!(set["ok"], true);
        let persist = read_mailbox(&home).expect("persist mailbox after set");
        assert_eq!(persist["action"], "set");
        let persist_event = persist["event_id"].clone();

        let pass = preview_building(&home, db.conn(), &session_id, &inheritance).unwrap();
        assert_eq!(pass["ok"], true);
        assert_eq!(pass["persisted"], false);
        assert_eq!(pass["warnings"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(pass["notify"]["action"], ENTITY_ACTION_PREVIEW);
        assert!(pass["notify"]["event_id"].as_str().unwrap().starts_with("ui_preview_"));
        let edit = read_edit_mailbox(&home).expect("edit mailbox after preview");
        assert!(is_entity_changed(&edit));
        assert_eq!(edit["action"], ENTITY_ACTION_PREVIEW);
        assert_eq!(edit["ephemeral"], true);
        assert_eq!(edit["persisted"], false);
        assert_eq!(edit["model"]["kit_version"], "session-kit/v1");
        assert!(edit["model"]["parts"].as_array().is_some_and(|p| !p.is_empty()));
        let persist_after = read_mailbox(&home).expect("persist mailbox stays");
        assert_eq!(persist_after["event_id"], persist_event);
        assert_eq!(persist_after["action"], "set");
        let events = list_build_events(&home, &[], None, 10).unwrap();
        assert!(events.iter().all(|row| row["action"] == "set" || row["action"] == "reset"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn overlap_preview_does_not_flash() {
        let (home, db, session_id) = seed();
        let fail = preview_building(&home, db.conn(), &session_id, &json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {
                "parts_add": [valid_part("a", 0.0), valid_part("b", 0.2)]
            }
        })).unwrap();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"]["rule"], "overlap");
        assert!(fail.get("notify").is_none());
        assert!(read_edit_mailbox(&home).is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    fn seed() -> (std::path::PathBuf, AuthorityDb, String) {
        let home = std::env::temp_dir().join(format!(
            "av-city-bldg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let db = AuthorityDb::open(&default_authority_path(&home), 1_700_000_000_000).unwrap();
        db.conn().execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version) VALUES ('run',1,'cli','succeeded',2)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace, last_observed_at_ms)
             VALUES ('sess-one', 'codex', 'native-one', 'ns', 1)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id, session_key,
                 source_event_id, observation_kind, event_ts_ms, uncached_input_tokens, cache_read_tokens,
                 cache_write_tokens, output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
             VALUES ('f1', 'codex', 'ns', 'native-one', 'sess-one', 'e1', 'assistant-usage', 1, 50000, 0, 0, 50000, 'run', 1, 1)",
            [],
        ).unwrap();
        let salt = session_ref::load_or_create_salt(&home).unwrap();
        let session_id = session_ref(&salt, "sess-one");
        (home, db, session_id)
    }

    #[test]
    fn override_survives_reopen_and_reset_restores_default() {
        let (home, db, session_id) = seed();
        let got = get_building(&home, db.conn(), &session_id).unwrap();
        assert_eq!(got["ok"], true);
        assert_eq!(got["source"], "default");
        assert_eq!(got["revision"], 0);
        assert_eq!(got["model"]["parts"].as_array().unwrap().len(), 5);
        let asset = got["projection"]["asset_ref"].as_str().unwrap().to_string();
        assert!(asset.starts_with("ca_"));

        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let fail = preview_building(&home, db.conn(), &session_id, &json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {
                "parts_add": [valid_part("a", 0.0), valid_part("b", 0.2)]
            }
        })).unwrap();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"]["rule"], "overlap");
        assert_eq!(fail["persisted"], false);

        let pass = preview_building(&home, db.conn(), &session_id, &inheritance).unwrap();
        assert_eq!(pass["ok"], true);
        assert_eq!(pass["persisted"], false);

        let conflict = set_building_model(&home, db.conn(), &session_id, &inheritance, 9).unwrap();
        assert_eq!(conflict["ok"], false);
        assert_eq!(conflict["error"]["kind"], "conflict");
        assert_eq!(conflict["revision"], 0);

        let set = set_building_model(&home, db.conn(), &session_id, &inheritance, 0).unwrap();
        assert_eq!(set["ok"], true);
        assert_eq!(set["revision"], 1);
        assert!(set["build_event_id"].as_str().unwrap().starts_with("be_"));
        assert_eq!(set["construction"]["mode"], "block-by-block");
        assert_eq!(set["construction"]["replayable"], true);
        assert_eq!(set["construction"]["ui"], "queued");
        assert_eq!(set["notify"]["channel"], "mailbox");
        let mail = read_mailbox(&home).expect("mailbox after persist");
        assert!(is_entity_changed(&mail));
        assert_eq!(mail["type"], ENTITY_CHANGED_TYPE);
        assert_eq!(mail["entity_kind"], ENTITY_KIND_BUILDING);
        assert_eq!(mail["entity_id"], asset);
        assert_eq!(mail["action"], "set");
        assert_eq!(mail["event_id"], set["build_event_id"]);
        assert_eq!(mail["asset_ref"], asset);
        assert_eq!(mail["build_event_id"], set["build_event_id"]);
        assert_eq!(mail["revision"], 1);
        assert_eq!(mail["kind"], "set");
        let listed = list_overrides(&home, Some(db.conn()), std::slice::from_ref(&asset)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["model"]["parts"][1]["id"], got["model"]["parts"][1]["id"]);
        assert!(listed[0]["inheritance"].is_object());
        let events = list_build_events(&home, &[], None, 10).unwrap();
        assert_eq!(events[0]["build_event_id"], set["build_event_id"]);

        drop(db);
        let db = AuthorityDb::open(&default_authority_path(&home), 1_700_000_000_000).unwrap();
        let again = get_building(&home, db.conn(), &asset).unwrap();
        assert_eq!(again["source"], "override");
        assert_eq!(again["revision"], 1);
        assert_eq!(again["model"]["parts"][1]["id"], got["model"]["parts"][1]["id"]);

        let reset = reset_building(&home, db.conn(), &session_id, 1).unwrap();
        assert_eq!(reset["ok"], true);
        assert_eq!(reset["revision"], 2);
        assert_eq!(reset["source"], "default");
        let after = get_building(&home, db.conn(), &session_id).unwrap();
        assert_eq!(after["source"], "default");
        assert_eq!(after["revision"], 2);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn persist_pushes_host_socket_when_listening() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::net::UnixListener;
        let (home, db, session_id) = seed();
        std::fs::create_dir_all(store_dir(&home)).unwrap();
        let listener = UnixListener::bind(socket_path(&home)).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // Persist notify plus IM fanout share host.sock; drain a few accepts.
            let _ = listener.set_nonblocking(true);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let mut line = String::new();
                        if BufReader::new(stream).read_line(&mut line).is_ok() && !line.trim().is_empty() {
                            let _ = tx.send(line);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        });
        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let set = set_building_model(&home, db.conn(), &session_id, &inheritance, 0).unwrap();
        assert_eq!(set["ok"], true);
        assert_eq!(set["construction"]["ui"], "pushed");
        assert_eq!(set["notify"]["channel"], "host-socket");
        let line = rx.recv_timeout(std::time::Duration::from_secs(2)).expect("socket payload");
        let mut payloads = vec![serde_json::from_str::<Value>(line.trim()).unwrap()];
        while let Ok(extra) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
            if let Ok(value) = serde_json::from_str::<Value>(extra.trim()) { payloads.push(value); }
        }
        let payload = payloads.iter().find(|row| is_entity_changed(row)).cloned().expect("construction notify");
        assert!(is_entity_changed(&payload));
        assert_eq!(payload["type"], ENTITY_CHANGED_TYPE);
        assert_eq!(payload["entity_kind"], ENTITY_KIND_BUILDING);
        assert_eq!(payload["action"], "set");
        assert_eq!(payload["event_id"], set["build_event_id"]);
        assert_eq!(payload["build_event_id"], set["build_event_id"]);
        assert_eq!(payload["revision"], 1);
        assert_eq!(payload["kind"], "set");
        assert!(payload["entity_id"].as_str().unwrap().starts_with("ca_"));
        assert!(payload["asset_ref"].as_str().unwrap().starts_with("ca_"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn inheritance_rebase_catalog_and_reset_via_document() {
        let (home, db, session_id) = seed();
        let fine = inh_catalog("kit-fine-storefront", json!({
            "parts_add": [{"id": "sign", "kind": "box", "role": "trim", "at": [0.0, 6.2, 2.5], "size": [0.8, 0.3, 0.2]}]
        }));
        let set = set_building_model(&home, db.conn(), &session_id, &fine, 0).unwrap();
        assert_eq!(set["ok"], true);
        let got = get_building(&home, db.conn(), &session_id).unwrap();
        assert!(got["inheritance"].is_object());
        assert!(got["model"]["parts"].as_array().unwrap().iter().any(|p| p["id"] == "sign"));

        let reset_doc = json!({ "kit_version": INHERITANCE_KIT_VERSION, "reset": true });
        let reset = set_building_model(&home, db.conn(), &session_id, &reset_doc, 1).unwrap();
        assert_eq!(reset["ok"], true);
        assert_eq!(reset["source"], "default");
        let after = get_building(&home, db.conn(), &session_id).unwrap();
        assert_eq!(after["source"], "default");
        assert!(after.get("inheritance").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn envelope_is_reusable_not_building_named() {
        let payload = Value::Object(entity_changed_payload(
            "building", "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "set", 3, "be_cccccccccccccccccccccccccccccccc",
        ));
        assert!(is_entity_changed(&payload));
        assert_eq!(payload["type"], ENTITY_CHANGED_TYPE);
        assert_ne!(payload["type"], "CityBuildingChanged");
        assert_eq!(payload["entity_kind"], ENTITY_KIND_BUILDING);
        assert_eq!(payload["entity_id"], "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(payload["action"], "set");
        assert_eq!(payload["event_id"], "be_cccccccccccccccccccccccccccccccc");
        let road = Value::Object(entity_changed_payload("road", "rd_1", "set", 1, "ev_1"));
        assert!(is_entity_changed(&road));
        assert_eq!(road["entity_kind"], "road");
        assert_eq!(entity_event_id(&road), Some("ev_1"));
        let preview = Value::Object(entity_changed_payload(
            "building", "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ENTITY_ACTION_PREVIEW, 0, "ui_preview_1",
        ));
        assert!(is_entity_changed(&preview));
        let reject = Value::Object(entity_changed_payload(
            "building", "ca_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ENTITY_ACTION_REJECT, 1, "ui_reject_1",
        ));
        assert!(is_entity_changed(&reject));
        let mut incomplete = payload.clone();
        incomplete["entity_kind"] = json!("");
        assert!(!is_entity_changed(&incomplete));
    }

    #[test]
    fn preview_rejects_disconnected_deck_and_flashes() {
        let (home, db, session_id) = seed();
        let fail = preview_building(&home, db.conn(), &session_id, &json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {
                "parts_add": [{
                    "id": "deck",
                    "kind": "box",
                    "role": "structure",
                    "at": [0.0, 8.0, 4.8],
                    "size": [2.0, 0.3, 1.0]
                }]
            }
        })).unwrap();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"]["rule"], city_building_design::RULE_DISCONNECTED);
        assert_eq!(fail["notify"]["action"], ENTITY_ACTION_REJECT);
        let edit = read_edit_mailbox(&home).expect("edit mailbox after disconnected_part");
        assert_eq!(edit["action"], ENTITY_ACTION_REJECT);
        assert_eq!(edit["error"]["rule"], city_building_design::RULE_DISCONNECTED);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn preview_rejects_same_height_widened_bases() {
        let (home, db, session_id) = seed();
        let fail = preview_building(&home, db.conn(), &session_id, &json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {
                "parts_add": [
                    {"id": "wing-l", "kind": "box", "role": "structure", "at": [-3.2, 0.0, 0.0], "size": [1.2, 1.2, 4.0]},
                    {"id": "wing-r", "kind": "box", "role": "structure", "at": [3.2, 0.0, 0.0], "size": [1.2, 1.2, 4.0]}
                ]
            }
        })).unwrap();
        assert_eq!(fail["ok"], false);
        assert_eq!(fail["error"]["rule"], city_building_design::RULE_MASSING_DRIFT);
        assert_eq!(fail["notify"]["action"], ENTITY_ACTION_REJECT);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn preview_catalog_rebase_warns_but_allows() {
        let (home, db, session_id) = seed();
        let pass = preview_building(&home, db.conn(), &session_id, &inh_catalog("kit-fine-midrise", json!({}))).unwrap();
        assert_eq!(pass["ok"], true);
        let warnings = pass["warnings"].as_array().cloned().unwrap_or_default();
        assert!(warnings.iter().any(|w| w["rule"] == city_building_design::RULE_MASSING_SHIFT), "{pass}");
        assert!(pass["observe"]["text"].as_str().unwrap().contains("design warning"));
        let squad = city_im::read_squad_mailbox(&home).expect("preview squad row");
        assert_eq!(squad["agent_name"], "City MCP");
        let warnings = squad["payload"]["warnings"].as_array().cloned().unwrap_or_default();
        assert!(warnings.iter().any(|w| w["rule"] == city_building_design::RULE_MASSING_SHIFT));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn squad_row_uses_mcp_client_name() {
        let (home, db, session_id) = seed();
        city_im::set_connection_client(Some("codex"));
        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": {}
        });
        let set = set_building_model(&home, db.conn(), &session_id, &inheritance, 0).unwrap();
        assert_eq!(set["ok"], true);
        let squad = city_im::read_squad_mailbox(&home).expect("set squad row");
        assert_eq!(squad["agent_id"], "codex");
        assert_eq!(squad["agent_name"], "Codex");
        assert_eq!(squad["kind"], "set");
        assert!(squad["payload"]["part_count"].as_u64().unwrap() >= 1);
        assert!(squad["payload"]["height"].as_f64().unwrap() > 0.0);
        city_im::set_connection_client(None);
        assert_eq!(city_im::connection_actor().agent_name, "City MCP");
        let _ = std::fs::remove_dir_all(&home);
    }
}
