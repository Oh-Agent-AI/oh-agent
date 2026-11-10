import type { KitModel } from "./sessionKitConstruction";
import type { BuildingValidationIssue } from "./sessionKitCompliance";

export const DESIGN_RULE_DISCONNECTED = "disconnected_part";
export const DESIGN_RULE_MASSING_DRIFT = "massing_drift";
export const DESIGN_RULE_MASSING_SHIFT = "massing_shift";
export const DESIGN_RULE_ADDITIVE = "additive_override";

const STRUCTURE_ROLES = new Set(["wall", "structure", "roof"]);
const FACADE_ROLES = new Set(["trim", "door", "window", "glass"]);
const STRUCT_TOUCH = 0.12;
const FACADE_TOUCH = 0.4;
const HEIGHT_STABLE_LO = 0.88;
const HEIGHT_STABLE_HI = 1.12;
const FOOTPRINT_REJECT = 1.22;
const FOOTPRINT_WARN = 1.12;
const HEIGHT_SHIFT = 0.2;
const ADD_WARN_COUNT = 3;
const ADD_WARN_VOLUME = 0.18;
const ADD_REJECT_STRUCT_COUNT = 4;
const ADD_REJECT_VOLUME = 0.35;

type Bounds = { min: [number, number, number]; max: [number, number, number] };
type PartBox = { id: string; role: string; bounds: Bounds; volume: number };
type Massing = { halfX: number; halfZ: number; height: number };
type OverrideProfile = { catalogRebase: boolean; structuralAdds: number; facadeAdds: number;
  addedVolume: number; hasStructuralEdit: boolean };
export type DesignWarning = {
  kind: "design"; severity: "warning"; rule: typeof DESIGN_RULE_MASSING_SHIFT | typeof DESIGN_RULE_ADDITIVE;
  parts: string[]; message: string; suggested_fix: string;
};

function partBoxes(model: KitModel): PartBox[] {
  return model.parts.map((part, index) => {
    const rotated = !!part.rot?.some((value) => Math.abs(value) > 1e-6);
    const halfX = (rotated ? Math.max(part.size[0], part.size[2]) : part.size[0]) / 2;
    const halfZ = (rotated ? Math.max(part.size[0], part.size[2]) : part.size[2]) / 2;
    return { id: part.id ?? "#" + index, role: part.role,
      bounds: { min: [part.at[0] - halfX, part.at[1], part.at[2] - halfZ],
        max: [part.at[0] + halfX, part.at[1] + part.size[1], part.at[2] + halfZ] },
      volume: part.size[0] * part.size[1] * part.size[2] };
  });
}

function touches(left: Bounds, right: Bounds, slack: number): boolean {
  return [0, 1, 2].every((axis) => left.min[axis]! < right.max[axis]! + slack
    && right.min[axis]! < left.max[axis]! + slack);
}

function disconnected(parts: PartBox[]): BuildingValidationIssue | null {
  if (!parts.length) return null;
  const parent = parts.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]!]!;
      root = parent[root]!;
    }
    return root;
  };
  for (let left = 0; left < parts.length; left += 1) {
    for (let right = left + 1; right < parts.length; right += 1) {
      const a = parts[left]!;
      const b = parts[right]!;
      const slack = STRUCTURE_ROLES.has(a.role) && STRUCTURE_ROLES.has(b.role) ? STRUCT_TOUCH : FACADE_TOUCH;
      if (touches(a.bounds, b.bounds, slack)) {
        const rootA = find(left);
        const rootB = find(right);
        parent[rootB] = rootA;
      }
    }
  }
  const structure = parts.flatMap((part, index) => STRUCTURE_ROLES.has(part.role) ? [index] : []);
  const seed = structure[0] ?? 0;
  const root = find(seed);
  const orphan: string[] = [];
  for (const index of structure) if (find(index) !== root) orphan.push(parts[index]!.id);
  if (orphan.length) return { kind: "validation", rule: DESIGN_RULE_DISCONNECTED, parts: orphan,
    message: "structure parts must form one connected mass",
    suggested_fix: "move the part so its box touches the main shaft/podium; do not float decks or wings beside the building" };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (FACADE_ROLES.has(part.role) && find(index) !== root) orphan.push(part.id);
  }
  if (orphan.length) return { kind: "validation", rule: DESIGN_RULE_DISCONNECTED, parts: orphan,
    message: "door/window/trim/glass must attach to the main structure",
    suggested_fix: "move the part so its box touches the main shaft/podium; do not float decks or wings beside the building" };
  return null;
}

function massing(model: KitModel): Massing {
  const boxes = partBoxes(model).map((part) => part.bounds);
  if (!boxes.length) return { halfX: 0.01, halfZ: 0.01, height: 0.01 };
  const minX = Math.min(...boxes.map((box) => box.min[0]));
  const maxX = Math.max(...boxes.map((box) => box.max[0]));
  const minY = Math.min(...boxes.map((box) => box.min[1]));
  const maxY = Math.max(...boxes.map((box) => box.max[1]));
  const minZ = Math.min(...boxes.map((box) => box.min[2]));
  const maxZ = Math.max(...boxes.map((box) => box.max[2]));
  return { halfX: Math.max(Math.abs(maxX - minX) / 2, 0.01),
    halfZ: Math.max(Math.abs(maxZ - minZ) / 2, 0.01), height: Math.max(maxY - minY, 0.01) };
}

function sameMassing(current: KitModel, proposed: KitModel): boolean {
  const a = massing(current);
  const b = massing(proposed);
  return Math.abs(a.halfX - b.halfX) < 0.02 && Math.abs(a.halfZ - b.halfZ) < 0.02
    && Math.abs(a.height - b.height) < 0.02 && current.parts.length === proposed.parts.length;
}

function overrideAdds(inheritance: unknown): unknown[] {
  if (!inheritance || typeof inheritance !== "object" || Array.isArray(inheritance)) return [];
  const overrides = (inheritance as Record<string, unknown>).overrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return [];
  const adds = (overrides as Record<string, unknown>).parts_add;
  return Array.isArray(adds) ? adds : [];
}

function structuralRemoveOrReplace(inheritance: unknown): boolean {
  if (!inheritance || typeof inheritance !== "object" || Array.isArray(inheritance)) return false;
  const rawOverrides = (inheritance as Record<string, unknown>).overrides;
  if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) return false;
  const overrides = rawOverrides as Record<string, unknown>;
  const remove = Array.isArray(overrides.parts_remove) ? overrides.parts_remove : [];
  if (remove.some((id) => ["podium", "shaft", "roof", "base", "upper", "floor1", "floor2"].includes(String(id)))) return true;
  if (remove.length && Array.isArray(overrides.parts_add) && overrides.parts_add.length) return true;
  const replace = Array.isArray(overrides.parts_replace) ? overrides.parts_replace : [];
  return replace.some((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry)
    && !!(entry as Record<string, unknown>).part && typeof (entry as Record<string, unknown>).part === "object"
    && STRUCTURE_ROLES.has(String(((entry as Record<string, unknown>).part as Record<string, unknown>).role ?? "")));
}

function profile(inheritance: unknown, proposed: PartBox[], current: KitModel): OverrideProfile {
  const doc = inheritance && typeof inheritance === "object" && !Array.isArray(inheritance)
    ? inheritance as Record<string, unknown> : {};
  const base = doc.base && typeof doc.base === "object" && !Array.isArray(doc.base) ? doc.base as Record<string, unknown> : {};
  const adds = overrideAdds(inheritance);
  let structuralAdds = 0;
  let facadeAdds = 0;
  let addedVolume = 0;
  if (!adds.length && inheritance === undefined) {
    const currentIds = new Set(partBoxes(current).map((part) => part.id));
    for (const part of proposed) {
      if (currentIds.has(part.id)) continue;
      if (STRUCTURE_ROLES.has(part.role)) structuralAdds += 1;
      else if (FACADE_ROLES.has(part.role)) facadeAdds += 1;
      addedVolume += part.volume;
    }
  } else {
    for (const raw of adds) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const part = raw as Record<string, unknown>;
      const role = String(part.role ?? "");
      const size = Array.isArray(part.size) && part.size.length === 3 && part.size.every((n) => typeof n === "number")
        ? part.size as number[] : [0, 0, 0];
      addedVolume += Math.abs(size[0]!) * Math.abs(size[1]!) * Math.abs(size[2]!);
      if (STRUCTURE_ROLES.has(role)) structuralAdds += 1;
      else if (FACADE_ROLES.has(role)) facadeAdds += 1;
    }
  }
  const hasStructuralEdit = structuralAdds > 0 || structuralRemoveOrReplace(inheritance);
  return { catalogRebase: base.kind === "catalog" && !hasStructuralEdit, structuralAdds,
    facadeAdds, addedVolume, hasStructuralEdit };
}

function warning(rule: DesignWarning["rule"], message: string, suggestedFix: string): DesignWarning {
  return { kind: "design", severity: "warning", rule, parts: [], message, suggested_fix: suggestedFix };
}

function ratio(numerator: number, denominator: number): number { return numerator / Math.max(denominator, 0.01); }

/** Port of Rust's post-compliance #11 design gate. Null means hard-rejected. */
export function validateDesignCoherence(
  current: KitModel,
  proposed: KitModel,
  inheritance?: unknown,
): { issue: BuildingValidationIssue | null; warnings: DesignWarning[] } {
  if (inheritance && typeof inheritance === "object" && !Array.isArray(inheritance)
      && (inheritance as Record<string, unknown>).reset === true) return { issue: null, warnings: [] };
  const proposedParts = partBoxes(proposed);
  const disconnectedIssue = disconnected(proposedParts);
  if (disconnectedIssue) return { issue: disconnectedIssue, warnings: [] };
  if (sameMassing(current, proposed) && overrideAdds(inheritance).length === 0) return { issue: null, warnings: [] };

  const before = massing(current);
  const after = massing(proposed);
  const edits = profile(inheritance, proposedParts, current);
  const warnings: DesignWarning[] = [];
  const growX = ratio(after.halfX, before.halfX);
  const growZ = ratio(after.halfZ, before.halfZ);
  const footprintGrow = Math.max(growX, growZ);
  const heightRatio = ratio(after.height, before.height);
  const heightStable = heightRatio >= HEIGHT_STABLE_LO && heightRatio <= HEIGHT_STABLE_HI;
  if (!edits.catalogRebase && heightStable && footprintGrow > FOOTPRINT_REJECT) {
    return { issue: { kind: "validation", rule: DESIGN_RULE_MASSING_DRIFT, parts: [],
      message: "proposal keeps height " + after.height.toFixed(2) + " (×" + heightRatio.toFixed(2)
        + ") but grows footprint ×" + footprintGrow.toFixed(2) + " — this is a bolt-on widen, not an in-mass adjustment",
      suggested_fix: "keep the current shaft/podium proportion; only adjust parts that stay on the existing mass" }, warnings: [] };
  }
  const heightShift = Math.abs(heightRatio - 1) > HEIGHT_SHIFT;
  const footprintShift = footprintGrow > FOOTPRINT_WARN;
  if (heightShift || footprintShift) warnings.push(warning(DESIGN_RULE_MASSING_SHIFT,
    "proposal changes massing (height ×" + heightRatio.toFixed(2) + ", footprint ×" + footprintGrow.toFixed(2) + ") versus the current building",
    "show this warning to the user before set; rebase to a catalog kit or keep the current proportions"));

  const added = edits.structuralAdds + edits.facadeAdds;
  if (!added) return { issue: null, warnings };
  const currentVolume = Math.max(partBoxes(current).reduce((sum, part) => sum + part.volume, 0), 0.01);
  const volumeRatio = edits.addedVolume / currentVolume;
  if (!edits.catalogRebase && (edits.structuralAdds >= ADD_REJECT_STRUCT_COUNT || volumeRatio > ADD_REJECT_VOLUME)
      && edits.hasStructuralEdit) {
    return { issue: { kind: "validation", rule: DESIGN_RULE_MASSING_DRIFT, parts: [],
      message: "proposal adds " + edits.structuralAdds + " structural parts and " + (volumeRatio * 100).toFixed(0)
        + "% extra volume — that rebuilds the mass instead of adjusting it",
      suggested_fix: "add at most a few attached trim pieces; do not hang new bases, decks, or spines on the current shaft" }, warnings: [] };
  }
  if (added >= ADD_WARN_COUNT || volumeRatio > ADD_WARN_VOLUME) warnings.push(warning(DESIGN_RULE_ADDITIVE,
    "proposal adds " + added + " parts (" + (volumeRatio * 100).toFixed(0) + "% extra volume); confirm they belong on the current structure",
    "show this warning before set; drop bolt-on decks/wings or attach them inside the existing mass"));
  return { issue: null, warnings };
}
