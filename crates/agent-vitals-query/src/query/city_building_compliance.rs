//! Hard model compliance for session-kit/v1 (合规模型 MVP).
//!
//! Gates: lot/footprint, height (incl. story height / floors), construction budget,
//! and required part roles (door, window) for occupiable volumes.
//! After absolute compliance, `validate_detail_regression` enforces hold-or-improve
//! detail vs the session's current model (layer 1 of 防越改越糙).
//! Shared by `preview_building` and `set_building_model`.

use serde_json::Value;

use super::city_building::{geometric_summary, tokens_to_height, BuildingError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeightClass {
    Low,
    Mid,
    High,
}

impl HeightClass {
    pub fn as_str(self) -> &'static str {
        match self {
            HeightClass::Low => "low",
            HeightClass::Mid => "mid",
            HeightClass::High => "high",
        }
    }

    fn from_token_height(h: f64) -> Self {
        if h >= 30.0 {
            HeightClass::High
        } else if h >= 14.0 {
            HeightClass::Mid
        } else {
            HeightClass::Low
        }
    }

    fn class_max_height(self) -> f64 {
        match self {
            HeightClass::Low => 14.0,
            HeightClass::Mid => 30.0,
            HeightClass::High => 48.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuildingSlot {
    pub height_class: HeightClass,
    pub footprint_half_x: f64,
    pub footprint_half_z: f64,
    pub max_height: f64,
    pub budget_cap: f64,
    pub story_height_min: f64,
    pub story_height_max: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailTier {
    Coarse = 0,
    Standard = 1,
    Detailed = 2,
}

impl DetailTier {
    fn from_u8(n: u8) -> Option<Self> {
        match n {
            0 => Some(DetailTier::Coarse),
            1 => Some(DetailTier::Standard),
            2 => Some(DetailTier::Detailed),
            _ => None,
        }
    }

    fn score_weight(self) -> i32 {
        match self {
            DetailTier::Coarse => 0,
            DetailTier::Standard => 5,
            DetailTier::Detailed => 10,
        }
    }
}

struct CatalogEntry {
    id: &'static str,
    max_half_x: f64,
    max_half_z: f64,
    max_height: f64,
    cost: f64,
    /// Catalog kit satisfies door/window without tagging every part.
    provides_door_window: bool,
    detail_tier: DetailTier,
    /// Typical part count when an agent uses the kit as-is (for catalog-only scoring).
    typical_parts: u8,
}

const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "kit-low-block",
        max_half_x: 3.8,
        max_half_z: 5.5,
        max_height: 14.0,
        cost: 32.0,
        provides_door_window: true,
        detail_tier: DetailTier::Standard,
        typical_parts: 4,
    },
    CatalogEntry {
        id: "kit-midrise",
        max_half_x: 4.0,
        max_half_z: 6.0,
        max_height: 30.0,
        cost: 72.0,
        provides_door_window: true,
        detail_tier: DetailTier::Detailed,
        typical_parts: 5,
    },
    CatalogEntry {
        id: "kit-tower",
        max_half_x: 3.2,
        max_half_z: 3.2,
        max_height: 48.0,
        cost: 120.0,
        provides_door_window: true,
        detail_tier: DetailTier::Detailed,
        typical_parts: 5,
    },
    CatalogEntry {
        id: "kit-wide-slab",
        max_half_x: 4.0,
        max_half_z: 5.0,
        max_height: 22.0,
        cost: 48.0,
        provides_door_window: true,
        detail_tier: DetailTier::Standard,
        typical_parts: 4,
    },
    CatalogEntry {
        id: "kit-fine-midrise",
        max_half_x: 4.0,
        max_half_z: 6.0,
        max_height: 30.0,
        cost: 85.0,
        provides_door_window: true,
        detail_tier: DetailTier::Detailed,
        typical_parts: 8,
    },
    CatalogEntry {
        id: "kit-fine-storefront",
        max_half_x: 4.0,
        max_half_z: 6.0,
        max_height: 22.0,
        cost: 78.0,
        provides_door_window: true,
        detail_tier: DetailTier::Detailed,
        typical_parts: 6,
    },
];

/// Cheap richness signal for hold-or-improve (no ML). Higher is more detailed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetailScore {
    pub total: i32,
    pub part_count: usize,
    pub has_door: bool,
    pub has_window: bool,
    pub detail_tier: DetailTier,
}

pub fn detail_tier_param_valid(value: &Value) -> bool {
    parse_detail_tier_param(value).is_some()
}

fn parse_detail_tier_param(value: &Value) -> Option<DetailTier> {
    if let Some(n) = value.as_u64() {
        return DetailTier::from_u8(n as u8);
    }
    if let Some(s) = value.as_str() {
        return match s {
            "coarse" => Some(DetailTier::Coarse),
            "standard" => Some(DetailTier::Standard),
            "detailed" => Some(DetailTier::Detailed),
            _ => None,
        };
    }
    None
}

fn resolve_detail_tier(model: &Value, part_count: usize) -> DetailTier {
    if let Some(tier) = model
        .get("params")
        .and_then(|p| p.get("detail_tier"))
        .and_then(parse_detail_tier_param)
    {
        return tier;
    }
    if let Some(id) = model
        .get("params")
        .and_then(|p| p.get("catalog_id"))
        .and_then(Value::as_str)
    {
        if let Some(entry) = catalog_by_id(id) {
            return entry.detail_tier;
        }
    }
    if part_count <= 2 {
        DetailTier::Coarse
    } else if part_count <= 4 {
        DetailTier::Standard
    } else {
        DetailTier::Detailed
    }
}

fn model_has_opening_roles(model: &Value) -> (bool, bool) {
    let door = has_part_role(model, "door");
    let window = has_part_role(model, "window");
    if door && window {
        return (true, true);
    }
    if let Some(id) = model
        .get("params")
        .and_then(|p| p.get("catalog_id"))
        .and_then(Value::as_str)
    {
        if let Some(entry) = catalog_by_id(id) {
            if entry.provides_door_window {
                return (true, true);
            }
        }
    }
    (door, window)
}

pub fn compute_detail_score(model: &Value) -> DetailScore {
    let part_count = model
        .get("parts")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    let (has_door, has_window) = model_has_opening_roles(model);
    let detail_tier = resolve_detail_tier(model, part_count);
    let mut total = part_count as i32 * 2;
    if has_door {
        total += 3;
    }
    if has_window {
        total += 3;
    }
    total += detail_tier.score_weight();
    DetailScore {
        total,
        part_count,
        has_door,
        has_window,
        detail_tier,
    }
}

fn catalog_detail_score(entry: &CatalogEntry) -> DetailScore {
    let has_dw = entry.provides_door_window;
    let part_count = entry.typical_parts as usize;
    let mut total = part_count as i32 * 2;
    if has_dw {
        total += 6;
    }
    total += entry.detail_tier.score_weight();
    DetailScore {
        total,
        part_count,
        has_door: has_dw,
        has_window: has_dw,
        detail_tier: entry.detail_tier,
    }
}

pub fn non_regressing_catalog_ids(current: &Value, slot: &BuildingSlot) -> Vec<String> {
    let floor = compute_detail_score(current).total;
    compliant_catalog_ids(slot)
        .into_iter()
        .filter(|id| {
            catalog_by_id(id)
                .map(|entry| catalog_detail_score(entry).total >= floor)
                .unwrap_or(false)
        })
        .collect()
}

const MIN_LOT_COVERAGE: f64 = 0.32;
const OCCUPIABLE_HEIGHT: f64 = 3.5;
const PILLAR_HEIGHT: f64 = 6.0;
const REQUIRED_ROLES: &[&str] = &["door", "window"];

pub fn budget_cap_for_tokens(tokens_total: i64) -> f64 {
    let t = tokens_total.max(500) as f64;
    ((t / 800.0).powf(0.85) * 18.0).clamp(12.0, 200.0)
}

pub fn derive_slot(_session_key: &str, tokens_total: i64) -> BuildingSlot {
    let token_height = tokens_to_height(tokens_total);
    let height_class = HeightClass::from_token_height(token_height);
    let max_height = token_height.min(height_class.class_max_height());
    let scale = 1.0 + (token_height / 48.0).clamp(0.0, 1.0) * 0.12;
    BuildingSlot {
        height_class,
        footprint_half_x: 4.0 * scale,
        footprint_half_z: 6.0 * scale,
        max_height,
        budget_cap: budget_cap_for_tokens(tokens_total),
        story_height_min: 2.4,
        story_height_max: 4.2,
    }
}

pub fn slot_to_json(slot: &BuildingSlot) -> Value {
    serde_json::json!({
        "height_class": slot.height_class.as_str(),
        "footprint": {
            "half_x": round3(slot.footprint_half_x),
            "half_z": round3(slot.footprint_half_z),
        },
        "max_height": round3(slot.max_height),
        "budget_cap": round3(slot.budget_cap),
        "story_height": { "min": slot.story_height_min, "max": slot.story_height_max },
        "required_part_roles": REQUIRED_ROLES,
        "source": "derived",
    })
}

fn round3(n: f64) -> f64 {
    (n * 1000.0).round() / 1000.0
}

fn model_footprint(model: &Value) -> (f64, f64, f64) {
    let summary = geometric_summary(model);
    let min = summary["bbox"]["min"].as_array().cloned().unwrap_or_default();
    let max = summary["bbox"]["max"].as_array().cloned().unwrap_or_default();
    let height = summary["height"].as_f64().unwrap_or(0.0);
    let half_x = if !min.is_empty() && !max.is_empty() {
        (max[0].as_f64().unwrap_or(0.0) - min[0].as_f64().unwrap_or(0.0)) / 2.0
    } else {
        0.0
    };
    let half_z = if min.len() >= 3 && max.len() >= 3 {
        (max[2].as_f64().unwrap_or(0.0) - min[2].as_f64().unwrap_or(0.0)) / 2.0
    } else {
        0.0
    };
    (half_x, half_z, height)
}

pub fn estimate_build_cost(model: &Value) -> f64 {
    let parts = model.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut cost = 0.0;
    for part in &parts {
        let size = part.get("size").and_then(Value::as_array).cloned().unwrap_or_default();
        if size.len() != 3 {
            continue;
        }
        let vol = size.iter().filter_map(Value::as_f64).fold(1.0, |a, b| a * b);
        cost += vol * 0.2 + 1.0;
    }
    cost
}

fn count_floor_bands(model: &Value) -> u32 {
    let parts = model.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut bands = 0u32;
    for part in &parts {
        let role = part.get("role").and_then(Value::as_str).unwrap_or("");
        if !matches!(role, "wall" | "structure" | "door" | "window") {
            continue;
        }
        let h = part
            .get("size")
            .and_then(Value::as_array)
            .and_then(|a| a.get(1))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if h >= 2.0 {
            bands += 1;
        }
    }
    bands
}

fn story_metrics(model: &Value, total_height: f64) -> (u32, f64) {
    let params = model.get("params").and_then(Value::as_object);
    let declared_floors = params
        .and_then(|p| p.get("floors"))
        .and_then(Value::as_u64)
        .map(|n| n.max(1) as u32);
    let declared_story = params
        .and_then(|p| p.get("story_height"))
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0);

    let bands = count_floor_bands(model);
    let floors = declared_floors.unwrap_or(if bands >= 2 { bands } else { 1 });
    let story_height = declared_story.unwrap_or_else(|| total_height / floors.max(1) as f64);
    (floors, story_height)
}

fn has_part_role(model: &Value, role: &str) -> bool {
    model
        .get("parts")
        .and_then(Value::as_array)
        .is_some_and(|parts| parts.iter().any(|p| p.get("role").and_then(Value::as_str) == Some(role)))
}

pub fn compliant_catalog_ids(slot: &BuildingSlot) -> Vec<String> {
    CATALOG
        .iter()
        .filter(|entry| {
            entry.max_height <= slot.max_height + 0.05
                && entry.max_half_x <= slot.footprint_half_x + 0.02
                && entry.max_half_z <= slot.footprint_half_z + 0.02
                && entry.cost <= slot.budget_cap + 0.05
        })
        .map(|entry| entry.id.to_string())
        .collect()
}

fn catalog_by_id(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|entry| entry.id == id)
}

pub fn validate_model_compliance(model: &Value, slot: &BuildingSlot) -> Result<(), BuildingError> {
    let candidates = compliant_catalog_ids(slot);
    let (half_x, half_z, height) = model_footprint(model);
    let build_cost = estimate_build_cost(model);
    let declared_cost = model
        .get("params")
        .and_then(|p| p.get("build_cost"))
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0);
    let catalog_id = model
        .get("params")
        .and_then(|p| p.get("catalog_id"))
        .and_then(Value::as_str);
    let catalog = catalog_id.and_then(catalog_by_id);

    if half_x > slot.footprint_half_x + 0.02 || half_z > slot.footprint_half_z + 0.02 {
        return Err(compliance_error(
            format!(
                "model footprint {:.2}×{:.2} exceeds lot {:.2}×{:.2}",
                half_x * 2.0,
                half_z * 2.0,
                slot.footprint_half_x * 2.0,
                slot.footprint_half_z * 2.0,
            ),
            "shrink or reposition parts so the bbox fits inside the parcel",
            &candidates,
        ));
    }

    let min_half_x = slot.footprint_half_x * MIN_LOT_COVERAGE;
    let min_half_z = slot.footprint_half_z * MIN_LOT_COVERAGE;
    if half_x + 0.02 < min_half_x || half_z + 0.02 < min_half_z {
        return Err(compliance_error(
            format!(
                "model footprint {:.2}×{:.2} under-fills the lot (need at least {:.2}×{:.2})",
                half_x * 2.0,
                half_z * 2.0,
                min_half_x * 2.0,
                min_half_z * 2.0,
            ),
            "widen the base so the building covers more of the parcel (avoid thin pillars)",
            &candidates,
        ));
    }

    let (floors, story_height) = story_metrics(model, height);
    if story_height < slot.story_height_min - 0.05 || story_height > slot.story_height_max + 0.05 {
        return Err(compliance_error(
            format!(
                "story height {story_height:.2} is outside allowed {:.1}..{:.1}",
                slot.story_height_min,
                slot.story_height_max,
            ),
            "set params.story_height in range or split into stacked floor parts",
            &candidates,
        ));
    }
    if (floors as f64) * story_height > slot.max_height + 0.1 {
        return Err(compliance_error(
            format!(
                "floors×story height ({floors}×{story_height:.2}) exceeds session max height {:.2}",
                slot.max_height,
            ),
            "reduce floors, lower story_height, or shorten parts",
            &candidates,
        ));
    }
    if height > slot.max_height + 0.05 {
        return Err(compliance_error(
            format!(
                "model height {height:.2} exceeds {} max {:.2} for this session",
                slot.height_class.as_str(),
                slot.max_height,
            ),
            "lower the structure to match the session height class",
            &candidates,
        ));
    }
    let bands = count_floor_bands(model);
    if height > PILLAR_HEIGHT && bands < 2 && floors < 2 {
        return Err(compliance_error(
            format!(
                "model height {height:.1} has no floor stack (need ≥2 floor bands or params.floors ≥ 2)"
            ),
            "add stacked wall/structure parts per floor or set params.floors and story_height",
            &candidates,
        ));
    }

    let cost = declared_cost.unwrap_or(build_cost);
    if cost > slot.budget_cap + 0.05 {
        return Err(compliance_error(
            format!("construction cost {cost:.1} exceeds session budget cap {:.1}", slot.budget_cap),
            "use fewer/smaller parts, set params.build_cost honestly, or pick a catalog kit within budget",
            &candidates,
        ));
    }

    if let Some(entry) = catalog {
        let cid = catalog_id.unwrap_or(entry.id);
        if cost > entry.cost + 0.05 {
            return Err(compliance_error(
                format!("construction cost {cost:.1} exceeds catalog `{cid}` cost {:.1}", entry.cost),
                "simplify the model or pick a catalog kit with a higher cost",
                &candidates,
            ));
        }
        if half_x > entry.max_half_x + 0.02 || half_z > entry.max_half_z + 0.02 {
            return Err(compliance_error(
                format!("model footprint exceeds catalog `{cid}` lot size"),
                "shrink the footprint or choose another catalog_id",
                &candidates,
            ));
        }
        if height > entry.max_height + 0.05 {
            return Err(compliance_error(
                format!("model height exceeds catalog `{cid}` max {:.1}", entry.max_height),
                "lower the roof or pick a taller catalog entry",
                &candidates,
            ));
        }
    } else if let Some(id) = catalog_id {
        return Err(compliance_error(
            format!("unknown catalog_id `{id}`"),
            "use an id from get_building.projection.compliant_catalog",
            &candidates,
        ));
    }

    let skip_features = catalog.is_some_and(|e| e.provides_door_window);
    if !skip_features && height > OCCUPIABLE_HEIGHT {
        for role in REQUIRED_ROLES {
            if !has_part_role(model, role) {
                return Err(compliance_error(
                    format!("occupiable building is missing required part role `{role}`"),
                    "add parts with role door and window, or set params.catalog_id to a kit that provides them",
                    &candidates,
                ));
            }
        }
    }

    Ok(())
}

/// Hold-or-improve: proposed detail score must be ≥ current (runs after absolute compliance).
pub fn validate_detail_regression(
    current: &Value,
    proposed: &Value,
    slot: &BuildingSlot,
) -> Result<(), BuildingError> {
    let current_score = compute_detail_score(current);
    let proposed_score = compute_detail_score(proposed);
    if proposed_score.total >= current_score.total {
        return Ok(());
    }
    let candidates = non_regressing_catalog_ids(current, slot);
    let candidates = if candidates.is_empty() {
        compliant_catalog_ids(slot)
    } else {
        candidates
    };
    Err(BuildingError::detail_regression(
        format!(
            "proposed detail score {} is below current {} (parts {}→{}, tier {}→{})",
            proposed_score.total,
            current_score.total,
            current_score.part_count,
            proposed_score.part_count,
            tier_label(current_score.detail_tier),
            tier_label(proposed_score.detail_tier),
        ),
        "add parts, door/window roles, or raise params.detail_tier; do not simplify below the current building",
        &candidates,
    ))
}

fn tier_label(tier: DetailTier) -> &'static str {
    match tier {
        DetailTier::Coarse => "coarse",
        DetailTier::Standard => "standard",
        DetailTier::Detailed => "detailed",
    }
}

fn compliance_error(message: impl Into<String>, fix: impl Into<String>, candidates: &[String]) -> BuildingError {
    BuildingError::invalid_model_compliance(message, fix, candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mid_slot() -> BuildingSlot {
        // Needs max_height ≥ kit-low-block (14 u) so compliant_catalog is non-empty.
        derive_slot("sess-one", 100_000)
    }

    fn occupiable_parts() -> Value {
        json!([
            {"id": "base", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [5.0, 3.0, 6.0]},
            {"id": "upper", "kind": "box", "role": "wall", "at": [0.0, 3.0, 0.0], "size": [4.5, 3.2, 5.5]},
            {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 3.0], "size": [1.2, 2.2, 0.2]},
            {"id": "window", "kind": "box", "role": "window", "at": [0.0, 4.0, 3.0], "size": [1.4, 1.2, 0.15]}
        ])
    }

    #[test]
    fn rejects_thin_pillar_on_lot() {
        let model = json!({
            "kit_version": "session-kit/v1",
            "params": {},
            "parts": [{
                "id": "pin",
                "kind": "box",
                "role": "wall",
                "at": [0.0, 0.0, 0.0],
                "size": [0.8, 12.0, 0.8]
            }]
        });
        let err = validate_model_compliance(&model, &mid_slot()).unwrap_err();
        assert_eq!(err.rule, "invalid_model");
        assert!(!err.compliant_models.is_empty());
    }

    #[test]
    fn rejects_pillar_without_floors() {
        let model = json!({
            "kit_version": "session-kit/v1",
            "params": {"story_height": 12.0, "floors": 1},
            "parts": [{
                "id": "mono",
                "kind": "box",
                "role": "wall",
                "at": [0.0, 0.0, 0.0],
                "size": [5.0, 12.0, 6.0]
            }]
        });
        let err = validate_model_compliance(&model, &mid_slot()).unwrap_err();
        assert_eq!(err.rule, "invalid_model");
        assert!(err.message.contains("story height") || err.message.contains("floor"));
    }

    #[test]
    fn rejects_missing_door_and_window() {
        let model = json!({
            "kit_version": "session-kit/v1",
            "params": {"floors": 2, "story_height": 3.2},
            "parts": [
                {"id": "a", "kind": "box", "role": "structure", "at": [0,0,0], "size": [5, 3.2, 6]},
                {"id": "b", "kind": "box", "role": "wall", "at": [0,3.2,0], "size": [5, 3.2, 6]},
            ]
        });
        let err = validate_model_compliance(&model, &mid_slot()).unwrap_err();
        assert_eq!(err.rule, "invalid_model");
        assert!(err.message.contains("door") || err.message.contains("window"));
    }

    #[test]
    fn accepts_compliant_midrise() {
        let model = json!({
            "kit_version": "session-kit/v1",
            "params": {"catalog_id": "kit-midrise", "floors": 2, "story_height": 3.2},
            "parts": occupiable_parts()
        });
        validate_model_compliance(&model, &mid_slot()).unwrap();
    }

    fn detailed_current() -> Value {
        json!({
            "kit_version": "session-kit/v1",
            "params": {"floors": 2, "story_height": 3.0, "detail_tier": "detailed"},
            "parts": occupiable_parts()
        })
    }

    fn simpler_compliant() -> Value {
        json!({
            "kit_version": "session-kit/v1",
            "params": {"catalog_id": "kit-low-block", "floors": 2, "story_height": 2.8, "detail_tier": "coarse", "build_cost": 30.0},
            "parts": [
                {"id": "base", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [5.0, 2.8, 6.0]},
                {"id": "cap", "kind": "box", "role": "wall", "at": [0.0, 2.8, 0.0], "size": [4.5, 2.8, 5.5]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 3.0], "size": [1.2, 2.0, 0.2]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 3.5, 3.0], "size": [1.4, 1.2, 0.15]},
            ]
        })
    }

    #[test]
    fn detail_regression_equal_and_upgrade_ok() {
        let current = detailed_current();
        let slot = mid_slot();
        validate_detail_regression(&current, &current, &slot).unwrap();
        let mut parts = occupiable_parts().as_array().cloned().unwrap_or_default();
        parts.push(json!({"id": "trim", "kind": "box", "role": "trim", "at": [0.0, 6.0, 0.0], "size": [4.0, 0.2, 5.0]}));
        let upgraded = json!({
            "kit_version": "session-kit/v1",
            "params": {"catalog_id": "kit-midrise", "floors": 2, "story_height": 3.2, "detail_tier": "detailed"},
            "parts": parts,
        });
        validate_model_compliance(&upgraded, &slot).unwrap();
        validate_detail_regression(&current, &upgraded, &slot).unwrap();
    }

    #[test]
    fn detail_regression_rejects_coarser_kit() {
        let current = detailed_current();
        let proposed = simpler_compliant();
        validate_model_compliance(&proposed, &mid_slot()).unwrap();
        let err = validate_detail_regression(&current, &proposed, &mid_slot()).unwrap_err();
        assert_eq!(err.rule, "detail_regression");
        assert!(!err.compliant_models.is_empty(), "candidates: {:?}", err.compliant_models);
    }
}
