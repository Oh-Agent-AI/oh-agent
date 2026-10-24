//! Design-coherence gate (after compliance #9 and detail-regression #10).
//!
//! 2026-10-24：「地形观测塔」事故——加宽基座 + 立面脊 + 中段观景平台，高度仍
//! 46.23，地块/重叠/门窗/#10 全绿。#10 只防越改越糙（件数变多反而加分），继承
//! 的 `parts_add` 又是正规写法，所以外挂改造被当成升级。本层补上产品一直有、
//! 校验器没实现的约束：**保留当前楼的主体与比例，新件必须贴在主体上**。
//!
//! - 硬拒绝：`disconnected_part`（结构件不连通）、`massing_drift`（高度几乎不
//!   变却明显加宽/加厚，或结构性外挂过量）。
//! - 警告（`ok: true` + `warnings[]`，不拦写入）：`massing_shift`（换比例/换高
//!   度，含合规 catalog 换基）、`additive_override`（外挂件数或体积偏多）。
//! - 纯 catalog 换基（只有 params / 门窗装饰件）**不**走 massing 拒绝——那是
//!   故意换 kit，但必须警告，不能当静默成功。
//!
//! 不做审美模型。重置（`reset: true` / `reset_building`）不跑本层。

use serde_json::{json, Value};

use super::city_building::{geometric_summary, BuildingError};

pub const RULE_DISCONNECTED: &str = "disconnected_part";
pub const RULE_MASSING_DRIFT: &str = "massing_drift";
pub const RULE_MASSING_SHIFT: &str = "massing_shift";
pub const RULE_ADDITIVE: &str = "additive_override";

const STRUCTURE_ROLES: &[&str] = &["wall", "structure", "roof"];
const FACADE_ROLES: &[&str] = &["trim", "door", "window", "glass"];

/// 结构件贴合容差（共面即连通；门相对基座有 ~0.01 的设计缝）。
const STRUCT_TOUCH: f64 = 0.12;
/// 装饰/开口允许略悬挑（storefront 雨篷离墙约 0.26）。
const FACADE_TOUCH: f64 = 0.40;
/// 高度变化落在这个区间内视为「几乎没改高度」。
const HEIGHT_STABLE_LO: f64 = 0.88;
const HEIGHT_STABLE_HI: f64 = 1.12;
const FOOTPRINT_REJECT: f64 = 1.22;
const FOOTPRINT_WARN: f64 = 1.12;
const HEIGHT_SHIFT: f64 = 0.20;
const ADD_WARN_COUNT: usize = 3;
const ADD_WARN_VOLUME: f64 = 0.18;
const ADD_REJECT_STRUCT_COUNT: usize = 4;
const ADD_REJECT_VOLUME: f64 = 0.35;

#[derive(Debug, Clone)]
struct PartBox {
    id: String,
    role: String,
    aabb: Aabb,
    volume: f64,
}

#[derive(Debug, Clone, Copy)]
struct Aabb {
    min: [f64; 3],
    max: [f64; 3],
}

impl Aabb {
    fn touches(&self, other: &Aabb, slack: f64) -> bool {
        (0..3).all(|i| self.min[i] < other.max[i] + slack && other.min[i] < self.max[i] + slack)
    }
}

#[derive(Debug, Clone, Copy)]
struct Massing {
    half_x: f64,
    half_z: f64,
    height: f64,
}

#[derive(Debug, Clone)]
struct OverrideProfile {
    catalog_rebase: bool,
    structural_adds: usize,
    facade_adds: usize,
    added_volume: f64,
    has_structural_edit: bool,
}

/// Run after #9/#10. `inheritance` is the agent document (None = strict).
pub fn validate_design_coherence(
    current: &Value,
    proposed: &Value,
    inheritance: Option<&Value>,
) -> Result<Vec<Value>, BuildingError> {
    if inheritance.is_some_and(|doc| doc.get("reset").and_then(Value::as_bool) == Some(true)) {
        return Ok(Vec::new());
    }
    let proposed_parts = extract_parts(proposed);
    reject_disconnected(&proposed_parts)?;

    if same_massing(current, proposed) && override_adds(inheritance).is_empty() {
        return Ok(Vec::new());
    }

    let current_mass = massing_of(current);
    let proposed_mass = massing_of(proposed);
    let profile = override_profile(inheritance, &proposed_parts, current);
    let mut warnings = Vec::new();

    reject_or_warn_massing(&current_mass, &proposed_mass, &profile, &mut warnings)?;
    reject_or_warn_additive(current, &profile, &mut warnings)?;
    Ok(warnings)
}

fn reject_disconnected(parts: &[PartBox]) -> Result<(), BuildingError> {
    if parts.is_empty() {
        return Ok(());
    }
    let mut parent: Vec<usize> = (0..parts.len()).collect();
    fn find(parent: &mut [usize], i: usize) -> usize {
        let mut x = i;
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    for i in 0..parts.len() {
        for j in (i + 1)..parts.len() {
            let slack = if STRUCTURE_ROLES.contains(&parts[i].role.as_str())
                && STRUCTURE_ROLES.contains(&parts[j].role.as_str())
            {
                STRUCT_TOUCH
            } else {
                FACADE_TOUCH
            };
            if parts[i].aabb.touches(&parts[j].aabb, slack) {
                let a = find(&mut parent, i);
                let b = find(&mut parent, j);
                parent[b] = a;
            }
        }
    }
    let structure: Vec<usize> = parts
        .iter()
        .enumerate()
        .filter(|(_, p)| STRUCTURE_ROLES.contains(&p.role.as_str()))
        .map(|(i, _)| i)
        .collect();
    let seed = structure.first().copied().unwrap_or(0);
    let root = find(&mut parent, seed);
    let mut orphan = Vec::new();
    for &i in &structure {
        if find(&mut parent, i) != root {
            orphan.push(parts[i].id.clone());
        }
    }
    if !orphan.is_empty() {
        return Err(disconnected(orphan, "structure parts must form one connected mass"));
    }
    for (i, part) in parts.iter().enumerate() {
        if !FACADE_ROLES.contains(&part.role.as_str()) {
            continue;
        }
        if find(&mut parent, i) != root {
            orphan.push(part.id.clone());
        }
    }
    if !orphan.is_empty() {
        return Err(disconnected(
            orphan,
            "door/window/trim/glass must attach to the main structure",
        ));
    }
    Ok(())
}

fn reject_or_warn_massing(
    current: &Massing,
    proposed: &Massing,
    profile: &OverrideProfile,
    warnings: &mut Vec<Value>,
) -> Result<(), BuildingError> {
    let grow_x = ratio(proposed.half_x, current.half_x);
    let grow_z = ratio(proposed.half_z, current.half_z);
    let footprint_grow = grow_x.max(grow_z);
    let height_ratio = ratio(proposed.height, current.height);
    let height_stable = (HEIGHT_STABLE_LO..=HEIGHT_STABLE_HI).contains(&height_ratio);

    if !profile.catalog_rebase && height_stable && footprint_grow > FOOTPRINT_REJECT {
        return Err(BuildingError::validation(
            RULE_MASSING_DRIFT,
            vec![],
            format!(
                "proposal keeps height {:.2} (×{height_ratio:.2}) but grows footprint ×{footprint_grow:.2} — this is a bolt-on widen, not an in-mass adjustment",
                proposed.height
            ),
            "keep the current shaft/podium proportion; only adjust parts that stay on the existing mass",
        ));
    }

    let height_shift = (height_ratio - 1.0).abs() > HEIGHT_SHIFT;
    let footprint_shift = footprint_grow > FOOTPRINT_WARN;
    if height_shift || footprint_shift {
        warnings.push(design_warning(
            RULE_MASSING_SHIFT,
            format!(
                "proposal changes massing (height ×{height_ratio:.2}, footprint ×{footprint_grow:.2}) versus the current building"
            ),
            "show this warning to the user before set; rebase to a catalog kit or keep the current proportions",
            vec![],
        ));
    }
    Ok(())
}

fn reject_or_warn_additive(
    current: &Value,
    profile: &OverrideProfile,
    warnings: &mut Vec<Value>,
) -> Result<(), BuildingError> {
    let added = profile.structural_adds + profile.facade_adds;
    if added == 0 {
        return Ok(());
    }
    let current_volume = extract_parts(current).iter().map(|p| p.volume).sum::<f64>().max(0.01);
    let volume_ratio = profile.added_volume / current_volume;
    if !profile.catalog_rebase
        && (profile.structural_adds >= ADD_REJECT_STRUCT_COUNT || volume_ratio > ADD_REJECT_VOLUME)
        && profile.has_structural_edit
    {
        return Err(BuildingError::validation(
            RULE_MASSING_DRIFT,
            vec![],
            format!(
                "proposal adds {} structural parts and {:.0}% extra volume — that rebuilds the mass instead of adjusting it",
                profile.structural_adds,
                volume_ratio * 100.0
            ),
            "add at most a few attached trim pieces; do not hang new bases, decks, or spines on the current shaft",
        ));
    }
    if added >= ADD_WARN_COUNT || volume_ratio > ADD_WARN_VOLUME {
        warnings.push(design_warning(
            RULE_ADDITIVE,
            format!(
                "proposal adds {added} parts ({:.0}% extra volume); confirm they belong on the current structure",
                volume_ratio * 100.0
            ),
            "show this warning before set; drop bolt-on decks/wings or attach them inside the existing mass",
            vec![],
        ));
    }
    Ok(())
}

fn override_profile(inheritance: Option<&Value>, proposed: &[PartBox], current: &Value) -> OverrideProfile {
    let catalog_rebase = inheritance
        .and_then(|doc| doc.get("base"))
        .and_then(|base| base.get("kind"))
        .and_then(Value::as_str)
        == Some("catalog");
    let adds = override_adds(inheritance);
    let (structural_adds, facade_adds, added_volume) = if adds.is_empty() && inheritance.is_none() {
        let current_ids: std::collections::BTreeSet<String> =
            extract_parts(current).into_iter().map(|p| p.id).collect();
        let mut structural = 0usize;
        let mut facade = 0usize;
        let mut volume = 0.0;
        for part in proposed {
            if current_ids.contains(&part.id) {
                continue;
            }
            if STRUCTURE_ROLES.contains(&part.role.as_str()) {
                structural += 1;
            } else if FACADE_ROLES.contains(&part.role.as_str()) {
                facade += 1;
            }
            volume += part.volume;
        }
        (structural, facade, volume)
    } else {
        summarize_adds(&adds)
    };
    let has_structural_edit = structural_adds > 0
        || override_has_structural_remove_or_replace(inheritance);
    OverrideProfile {
        catalog_rebase: catalog_rebase && !has_structural_edit,
        structural_adds,
        facade_adds,
        added_volume,
        has_structural_edit,
    }
}

fn override_adds(inheritance: Option<&Value>) -> Vec<Value> {
    inheritance
        .and_then(|doc| doc.get("overrides"))
        .and_then(|o| o.get("parts_add"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn override_has_structural_remove_or_replace(inheritance: Option<&Value>) -> bool {
    let Some(overrides) = inheritance.and_then(|doc| doc.get("overrides")) else {
        return false;
    };
    if let Some(remove) = overrides.get("parts_remove").and_then(Value::as_array) {
        if remove.iter().any(|id| {
            matches!(id.as_str(), Some("podium" | "shaft" | "roof" | "base" | "upper" | "floor1" | "floor2"))
        }) {
            return true;
        }
        if !remove.is_empty() && overrides.get("parts_add").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
            return true;
        }
    }
    if let Some(replace) = overrides.get("parts_replace").and_then(Value::as_array) {
        return replace.iter().any(|entry| {
            entry
                .get("part")
                .and_then(|p| p.get("role"))
                .and_then(Value::as_str)
                .is_some_and(|role| STRUCTURE_ROLES.contains(&role))
        });
    }
    false
}

fn summarize_adds(adds: &[Value]) -> (usize, usize, f64) {
    let mut structural = 0usize;
    let mut facade = 0usize;
    let mut volume = 0.0;
    for part in adds {
        let role = part.get("role").and_then(Value::as_str).unwrap_or("");
        let size = vec3(part.get("size")).unwrap_or([0.0; 3]);
        volume += size[0].abs() * size[1].abs() * size[2].abs();
        if STRUCTURE_ROLES.contains(&role) {
            structural += 1;
        } else if FACADE_ROLES.contains(&role) {
            facade += 1;
        }
    }
    (structural, facade, volume)
}

fn extract_parts(model: &Value) -> Vec<PartBox> {
    let Some(parts) = model.get("parts").and_then(Value::as_array) else {
        return Vec::new();
    };
    parts
        .iter()
        .enumerate()
        .filter_map(|(index, part)| {
            let at = vec3(part.get("at"))?;
            let size = vec3(part.get("size"))?;
            let rot = vec3(part.get("rot"));
            Some(PartBox {
                id: part
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("#{index}")),
                role: part
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("structure")
                    .to_string(),
                aabb: part_aabb(at, size, rot),
                volume: size[0].abs() * size[1].abs() * size[2].abs(),
            })
        })
        .collect()
}

fn part_aabb(at: [f64; 3], size: [f64; 3], rot: Option<[f64; 3]>) -> Aabb {
    let (hx, hz) = if rot.is_some_and(|r| r.iter().any(|n| n.abs() > 1e-6)) {
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

fn vec3(value: Option<&Value>) -> Option<[f64; 3]> {
    let arr = value.and_then(Value::as_array)?;
    if arr.len() != 3 {
        return None;
    }
    Some([arr[0].as_f64()?, arr[1].as_f64()?, arr[2].as_f64()?])
}

fn massing_of(model: &Value) -> Massing {
    let summary = geometric_summary(model);
    let min = summary["bbox"]["min"].as_array();
    let max = summary["bbox"]["max"].as_array();
    let half_x = match (min, max) {
        (Some(lo), Some(hi)) => {
            let a = lo.first().and_then(Value::as_f64).unwrap_or(0.0);
            let b = hi.first().and_then(Value::as_f64).unwrap_or(0.0);
            ((b - a) / 2.0).abs().max(0.01)
        }
        _ => 0.01,
    };
    let half_z = match (min, max) {
        (Some(lo), Some(hi)) => {
            let a = lo.get(2).and_then(Value::as_f64).unwrap_or(0.0);
            let b = hi.get(2).and_then(Value::as_f64).unwrap_or(0.0);
            ((b - a) / 2.0).abs().max(0.01)
        }
        _ => 0.01,
    };
    Massing {
        half_x,
        half_z,
        height: summary["height"].as_f64().unwrap_or(0.01).max(0.01),
    }
}

fn same_massing(current: &Value, proposed: &Value) -> bool {
    let a = massing_of(current);
    let b = massing_of(proposed);
    (a.half_x - b.half_x).abs() < 0.02
        && (a.half_z - b.half_z).abs() < 0.02
        && (a.height - b.height).abs() < 0.02
        && current.get("parts").and_then(Value::as_array).map(|p| p.len())
            == proposed.get("parts").and_then(Value::as_array).map(|p| p.len())
}

fn ratio(num: f64, den: f64) -> f64 {
    num / den.max(0.01)
}

fn disconnected(parts: Vec<String>, message: &str) -> BuildingError {
    BuildingError::validation(
        RULE_DISCONNECTED,
        parts,
        message,
        "move the part so its box touches the main shaft/podium; do not float decks or wings beside the building",
    )
}

fn design_warning(rule: &'static str, message: String, fix: &'static str, parts: Vec<String>) -> Value {
    json!({
        "kind": "design",
        "severity": "warning",
        "rule": rule,
        "parts": parts,
        "message": message,
        "suggested_fix": fix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::city_building::{default_model, validate_model};
    use crate::query::city_building_catalog::catalog_model;
    use crate::query::city_building_inheritance::INHERITANCE_KIT_VERSION;
    use serde_json::json;

    fn towerish() -> Value {
        json!({
            "kit_version": "session-kit/v1",
            "params": { "form": "tower", "floors": 2, "story_height": 3.2 },
            "parts": [
                {"id": "podium", "kind": "box", "role": "structure", "at": [0.0, 0.0, 0.0], "size": [3.2, 1.2, 3.2]},
                {"id": "shaft", "kind": "box", "role": "wall", "at": [0.0, 1.2, 0.0], "size": [2.8, 8.5, 2.8]},
                {"id": "roof", "kind": "box", "role": "roof", "at": [0.0, 9.7, 0.0], "size": [3.2, 0.4, 3.2]},
                {"id": "door", "kind": "box", "role": "door", "at": [0.0, 0.0, 1.71], "size": [1.0, 2.0, 0.2]},
                {"id": "window", "kind": "box", "role": "window", "at": [0.0, 4.5, 1.685], "size": [1.2, 1.0, 0.15]}
            ]
        })
    }

    fn projection(overrides: Value) -> Value {
        json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "projection" },
            "overrides": overrides,
        })
    }

    #[test]
    fn default_and_catalog_meshes_are_connected() {
        for tokens in [1_000_i64, 100_000, 10_000_000] {
            let model = default_model(tokens);
            validate_design_coherence(&model, &model, None).unwrap();
        }
        for id in [
            "kit-low-block",
            "kit-midrise",
            "kit-tower",
            "kit-wide-slab",
            "kit-fine-midrise",
            "kit-fine-storefront",
        ] {
            let model = catalog_model(id).unwrap();
            validate_model(&model).unwrap();
            validate_design_coherence(&model, &model, None)
                .unwrap_or_else(|e| panic!("{id}: {e:?}"));
        }
    }

    #[test]
    fn floating_deck_is_disconnected() {
        let current = towerish();
        let mut proposed = current.clone();
        proposed["parts"].as_array_mut().unwrap().push(json!({
            "id": "deck", "kind": "box", "role": "structure",
            "at": [0.0, 6.0, 4.4], "size": [2.4, 0.3, 1.4]
        }));
        let inheritance = projection(json!({
            "parts_add": [{
                "id": "deck", "kind": "box", "role": "structure",
                "at": [0.0, 6.0, 4.4], "size": [2.4, 0.3, 1.4]
            }]
        }));
        let err = validate_design_coherence(&current, &proposed, Some(&inheritance)).unwrap_err();
        assert_eq!(err.rule, RULE_DISCONNECTED);
        assert!(err.parts.iter().any(|id| id == "deck"));
    }

    #[test]
    fn same_height_widened_bases_are_massing_drift() {
        let current = towerish();
        let mut proposed = current.clone();
        let wings = [
            json!({"id": "wing-l", "kind": "box", "role": "structure", "at": [-2.2, 0.0, 0.0], "size": [1.2, 1.2, 3.2]}),
            json!({"id": "wing-r", "kind": "box", "role": "structure", "at": [2.2, 0.0, 0.0], "size": [1.2, 1.2, 3.2]}),
        ];
        for wing in &wings {
            proposed["parts"].as_array_mut().unwrap().push(wing.clone());
        }
        let inheritance = projection(json!({ "parts_add": wings }));
        let err = validate_design_coherence(&current, &proposed, Some(&inheritance)).unwrap_err();
        assert_eq!(err.rule, RULE_MASSING_DRIFT);
        assert!(err.message.contains("footprint") || err.message.contains("volume") || err.message.contains("structural"));
    }

    #[test]
    fn catalog_rebase_warns_instead_of_rejecting() {
        let current = default_model(100_000);
        let proposed = catalog_model("kit-fine-midrise").unwrap();
        let inheritance = json!({
            "kit_version": INHERITANCE_KIT_VERSION,
            "base": { "kind": "catalog", "catalog_id": "kit-fine-midrise" },
            "overrides": {}
        });
        let warnings = validate_design_coherence(&current, &proposed, Some(&inheritance)).unwrap();
        assert!(warnings.iter().any(|w| w["rule"] == RULE_MASSING_SHIFT), "{warnings:?}");
    }

    #[test]
    fn three_attached_trims_warn_but_pass() {
        let current = towerish();
        let trims = vec![
            json!({"id": "rib-a", "kind": "box", "role": "trim", "at": [1.5, 4.0, 0.0], "size": [0.2, 3.0, 0.2]}),
            json!({"id": "rib-b", "kind": "box", "role": "trim", "at": [-1.5, 4.0, 0.0], "size": [0.2, 3.0, 0.2]}),
            json!({"id": "rib-c", "kind": "box", "role": "trim", "at": [0.0, 4.0, 1.5], "size": [0.2, 3.0, 0.2]}),
        ];
        let mut proposed = current.clone();
        for trim in &trims {
            proposed["parts"].as_array_mut().unwrap().push(trim.clone());
        }
        let inheritance = projection(json!({ "parts_add": trims }));
        let warnings = validate_design_coherence(&current, &proposed, Some(&inheritance)).unwrap();
        assert!(warnings.iter().any(|w| w["rule"] == RULE_ADDITIVE), "{warnings:?}");
    }

    #[test]
    fn observation_tower_bolt_on_is_rejected() {
        // 事故复现：同高度 + 两侧基座 + 四脊 + 观景平台。
        let current = towerish();
        let adds = json!([
            {"id": "base-l", "kind": "box", "role": "structure", "at": [-2.2, 0.0, 0.0], "size": [1.2, 1.2, 3.2]},
            {"id": "base-r", "kind": "box", "role": "structure", "at": [2.2, 0.0, 0.0], "size": [1.2, 1.2, 3.2]},
            {"id": "rib-n", "kind": "box", "role": "trim", "at": [0.0, 4.0, 1.5], "size": [0.18, 6.0, 0.18]},
            {"id": "rib-s", "kind": "box", "role": "trim", "at": [0.0, 4.0, -1.5], "size": [0.18, 6.0, 0.18]},
            {"id": "rib-e", "kind": "box", "role": "trim", "at": [1.5, 4.0, 0.0], "size": [0.18, 6.0, 0.18]},
            {"id": "rib-w", "kind": "box", "role": "trim", "at": [-1.5, 4.0, 0.0], "size": [0.18, 6.0, 0.18]},
            {"id": "deck", "kind": "box", "role": "structure", "at": [0.0, 5.4, 2.0], "size": [2.2, 0.28, 1.4]}
        ]);
        let mut proposed = current.clone();
        for part in adds.as_array().unwrap() {
            proposed["parts"].as_array_mut().unwrap().push(part.clone());
        }
        let inheritance = projection(json!({ "parts_add": adds }));
        let err = validate_design_coherence(&current, &proposed, Some(&inheritance)).unwrap_err();
        assert_eq!(err.rule, RULE_MASSING_DRIFT);
    }
}
