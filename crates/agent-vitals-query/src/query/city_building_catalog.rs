//! Built-in session-kit catalog meshes (re-base targets for inheritance layer 2).
//!
//! Metadata (lot, cost, detail tier) lives in `city_building_compliance::CATALOG`;
//! this module only supplies the canonical part layouts agents inherit from.

use serde_json::{json, Value};

pub const FINE_CATALOG_IDS: &[&str] = &["kit-fine-midrise", "kit-fine-storefront"];

/// Full `session-kit/v1` model for a catalog id, or None when unknown.
pub fn catalog_model(id: &str) -> Option<Value> {
    match id {
        "kit-low-block" => Some(json!({
            "kit_version": "session-kit/v1",
            "params": {
                "form": "block",
                "catalog_id": "kit-low-block",
                "floors": 2,
                "story_height": 2.8,
                "detail_tier": "standard",
                "build_cost": 32.0
            },
            "parts": [
                {"id": "base", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [5.0, 2.8, 6.0]},
                {"id": "cap", "kind": "box", "role": "wall", "at": [0.0, 2.8, 0.0], "size": [4.5, 2.8, 5.5]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 3.11], "size": [1.2, 2.0, 0.2]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 3.5, 3.085], "size": [1.4, 1.2, 0.15]}
            ]
        })),
        "kit-midrise" => Some(json!({
            "kit_version": "session-kit/v1",
            "params": {
                "form": "midrise",
                "catalog_id": "kit-midrise",
                "floors": 2,
                "story_height": 3.2,
                "detail_tier": "detailed",
                "build_cost": 72.0
            },
            "parts": [
                {"id": "base", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [5.0, 3.0, 6.0]},
                {"id": "upper", "kind": "box", "role": "wall", "at": [0.0, 3.0, 0.0], "size": [4.5, 3.2, 5.5]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 3.11], "size": [1.2, 2.2, 0.2]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 4.0, 3.085], "size": [1.4, 1.2, 0.15]},
                {"id": "roof", "kind": "box", "role": "roof", "at": [0.0, 6.2, 0.0], "size": [5.0, 0.35, 6.0]}
            ]
        })),
        "kit-tower" => Some(json!({
            "kit_version": "session-kit/v1",
            "params": {
                "form": "tower",
                "catalog_id": "kit-tower",
                "floors": 3,
                "story_height": 3.4,
                "detail_tier": "detailed",
                "build_cost": 120.0
            },
            "parts": [
                {"id": "podium", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [3.2, 1.2, 3.2]},
                {"id": "shaft", "kind": "box", "role": "wall", "at": [0.0, 1.2, 0.0], "size": [2.8, 8.5, 2.8]},
                {"id": "roof", "kind": "box", "role": "roof", "at": [0.0, 9.7, 0.0], "size": [3.2, 0.4, 3.2]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 1.71], "size": [1.0, 2.0, 0.2]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 4.5, 1.685], "size": [1.2, 1.0, 0.15]}
            ]
        })),
        "kit-wide-slab" => Some(json!({
            "kit_version": "session-kit/v1",
            "params": {
                "form": "slab",
                "catalog_id": "kit-wide-slab",
                "floors": 2,
                "story_height": 3.0,
                "detail_tier": "standard",
                "build_cost": 48.0
            },
            "parts": [
                {"id": "base", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [6.4, 3.0, 4.0]},
                {"id": "upper", "kind": "box", "role": "wall", "at": [0.0, 3.0, 0.0], "size": [6.0, 3.0, 3.6]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 2.11], "size": [1.2, 2.0, 0.2]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 4.0, 2.085], "size": [1.6, 1.2, 0.15]}
            ]
        })),
        "kit-fine-midrise" => Some(json!({
            "kit_version": "session-kit/v1",
            "params": {
                "form": "midrise",
                "catalog_id": "kit-fine-midrise",
                "floors": 2,
                "story_height": 3.2,
                "detail_tier": "detailed",
                "build_cost": 85.0
            },
            "parts": [
                {"id": "podium", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [5.2, 1.0, 6.0]},
                {"id": "floor1", "kind": "box", "role": "wall", "at": [0.0, 1.0, 0.0], "size": [4.8, 3.2, 5.6]},
                {"id": "floor2", "kind": "box", "role": "wall", "at": [0.0, 4.2, 0.0], "size": [4.6, 3.2, 5.4]},
                {"id": "cornice", "kind": "box", "role": "trim", "at": [0.0, 7.45, 0.0], "size": [5.0, 0.25, 5.8]},
                {"id": "roof", "kind": "box", "role": "roof", "at": [0.0, 7.7, 0.0], "size": [5.2, 0.35, 6.0]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 3.11], "size": [1.3, 2.2, 0.2]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 2.2, 3.085], "size": [1.5, 1.4, 0.15]},
                {"id": "window_upper", "kind": "box", "role": "window", "at": [0.0, 5.2, 3.085], "size": [1.5, 1.4, 0.15]}
            ]
        })),
        "kit-fine-storefront" => Some(json!({
            "kit_version": "session-kit/v1",
            "params": {
                "form": "block",
                "catalog_id": "kit-fine-storefront",
                "floors": 2,
                "story_height": 3.0,
                "detail_tier": "detailed",
                "build_cost": 78.0
            },
            "parts": [
                {"id": "base", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [5.4, 3.0, 6.0]},
                {"id": "upper", "kind": "box", "role": "wall", "at": [0.0, 3.0, 0.0], "size": [5.0, 3.0, 5.6]},
                {"id": "awning", "kind": "box", "role": "trim", "at": [0.0, 4.5, 3.18], "size": [4.0, 0.15, 0.25]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 3.11], "size": [1.2, 2.2, 0.2]},
                {"id": "glass", "kind": "box", "role": "glass", "at": [0.0, 2.4, 3.08], "size": [3.6, 1.4, 0.12]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 5.2, 3.085], "size": [1.6, 1.3, 0.15]}
            ]
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::city_building::validate_model;

    #[test]
    fn catalog_meshes_pass_geometry_validation() {
        for id in [
            "kit-low-block",
            "kit-midrise",
            "kit-tower",
            "kit-wide-slab",
            "kit-fine-midrise",
            "kit-fine-storefront",
        ] {
            let model = catalog_model(id).expect(id);
            validate_model(&model).unwrap_or_else(|e| panic!("{id}: {e:?}"));
        }
    }
}
