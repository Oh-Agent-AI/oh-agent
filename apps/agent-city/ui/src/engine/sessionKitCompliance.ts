import type { KitModel } from "./sessionKitConstruction";

export type HeightClass = "low" | "mid" | "high";
export type BuildingSlot = {
  heightClass: HeightClass; halfX: number; halfZ: number; maxHeight: number;
  budgetCap: number; storyHeightMin: number; storyHeightMax: number;
};
export type BuildingCatalogEntry = { id: string; halfX: number; halfZ: number; height: number; cost: number };
export type BuildingValidationIssue = {
  kind: "validation"; rule: "invalid_model" | "detail_regression" | "disconnected_part" | "massing_drift"; parts: string[];
  message: string; suggested_fix: string; compliant_models?: string[];
};

const CATALOG: readonly (BuildingCatalogEntry & {
  providesDoorWindow: boolean; detailTier: 0 | 1 | 2; typicalParts: number;
})[] = [
  { id: "kit-low-block", halfX: 3.8, halfZ: 5.5, height: 14, cost: 32, providesDoorWindow: true, detailTier: 1, typicalParts: 4 },
  { id: "kit-midrise", halfX: 4, halfZ: 6, height: 30, cost: 72, providesDoorWindow: true, detailTier: 2, typicalParts: 5 },
  { id: "kit-tower", halfX: 3.2, halfZ: 3.2, height: 48, cost: 120, providesDoorWindow: true, detailTier: 2, typicalParts: 5 },
  { id: "kit-wide-slab", halfX: 4, halfZ: 5, height: 22, cost: 48, providesDoorWindow: true, detailTier: 1, typicalParts: 4 },
  { id: "kit-fine-midrise", halfX: 4, halfZ: 6, height: 30, cost: 85, providesDoorWindow: true, detailTier: 2, typicalParts: 8 },
  { id: "kit-fine-storefront", halfX: 4, halfZ: 6, height: 22, cost: 78, providesDoorWindow: true, detailTier: 2, typicalParts: 6 },
];

export const BUILDING_CATALOG: readonly BuildingCatalogEntry[] = CATALOG.map(({ id, halfX, halfZ, height, cost }) =>
  ({ id, halfX, halfZ, height, cost }));

function tokenHeight(tokens: number): number {
  const magnitude = Math.max(Math.log10(Math.max(tokens, 1)) - 1, 0);
  return Math.max(2.6, Math.min(48, 0.75 * magnitude ** 2.2));
}

export function deriveBuildingSlot(tokensTotal: number): BuildingSlot {
  const height = tokenHeight(tokensTotal);
  const heightClass: HeightClass = height >= 30 ? "high" : height >= 14 ? "mid" : "low";
  const classHeight = heightClass === "high" ? 48 : heightClass === "mid" ? 30 : 14;
  const scale = 1 + Math.min(Math.max(height / 48, 0), 1) * 0.12;
  const budgetCap = Math.max(12, Math.min(200, (Math.max(tokensTotal, 500) / 800) ** 0.85 * 18));
  return { heightClass, halfX: 4 * scale, halfZ: 6 * scale, maxHeight: Math.min(height, classHeight),
    budgetCap, storyHeightMin: 2.4, storyHeightMax: 4.2 };
}

export function compliantCatalogIds(slot: BuildingSlot): string[] {
  return CATALOG.filter((entry) => entry.height <= slot.maxHeight + 0.05
    && entry.halfX <= slot.halfX + 0.02 && entry.halfZ <= slot.halfZ + 0.02
    && entry.cost <= slot.budgetCap + 0.05).map((entry) => entry.id);
}

function detailTier(model: KitModel): 0 | 1 | 2 {
  const declared = model.params?.detail_tier;
  if (declared === 0 || declared === "coarse") return 0;
  if (declared === 1 || declared === "standard") return 1;
  if (declared === 2 || declared === "detailed") return 2;
  const catalog = CATALOG.find((entry) => entry.id === model.params?.catalog_id);
  if (catalog) return catalog.detailTier;
  return model.parts.length <= 2 ? 0 : model.parts.length <= 4 ? 1 : 2;
}

function hasRole(model: KitModel, role: string): boolean { return model.parts.some((part) => part.role === role); }
function hasCatalogOpenings(model: KitModel): boolean {
  return CATALOG.some((entry) => entry.id === model.params?.catalog_id && entry.providesDoorWindow);
}

export function detailScore(model: KitModel): { total: number; partCount: number; tier: 0 | 1 | 2 } {
  const partCount = model.parts.length;
  const hasDoor = hasRole(model, "door") || hasCatalogOpenings(model);
  const hasWindow = hasRole(model, "window") || hasCatalogOpenings(model);
  const tier = detailTier(model);
  return { total: partCount * 2 + (hasDoor ? 3 : 0) + (hasWindow ? 3 : 0)
    + (tier === 0 ? 0 : tier === 1 ? 5 : 10), partCount, tier };
}

function modelMetrics(model: KitModel) {
  const bounds = model.parts.map((part) => {
    const rotated = !!part.rot?.some((angle) => Math.abs(angle) > 1e-6);
    const halfX = (rotated ? Math.max(part.size[0], part.size[2]) : part.size[0]) / 2;
    const halfZ = (rotated ? Math.max(part.size[0], part.size[2]) : part.size[2]) / 2;
    return { minX: part.at[0] - halfX, maxX: part.at[0] + halfX, minY: part.at[1],
      maxY: part.at[1] + part.size[1], minZ: part.at[2] - halfZ, maxZ: part.at[2] + halfZ };
  });
  return { halfX: (Math.max(...bounds.map((box) => box.maxX)) - Math.min(...bounds.map((box) => box.minX))) / 2,
    halfZ: (Math.max(...bounds.map((box) => box.maxZ)) - Math.min(...bounds.map((box) => box.minZ))) / 2,
    height: Math.max(...bounds.map((box) => box.maxY)) - Math.min(...bounds.map((box) => box.minY)) };
}

function costEstimate(model: KitModel): number {
  return model.parts.reduce((cost, part) => cost + part.size[0] * part.size[1] * part.size[2] * 0.2 + 1, 0);
}

function floorBands(model: KitModel): number {
  return model.parts.filter((part) => ["wall", "structure", "door", "window"].includes(part.role) && part.size[1] >= 2).length;
}

function storyMetrics(model: KitModel, height: number): { floors: number; storyHeight: number } {
  const bands = floorBands(model);
  const floors = model.params?.floors ?? (bands >= 2 ? bands : 1);
  return { floors, storyHeight: model.params?.story_height ?? height / Math.max(floors, 1) };
}

function issue(message: string, suggestedFix: string, candidates: string[]): BuildingValidationIssue {
  return { kind: "validation", rule: "invalid_model", parts: [], message, suggested_fix: suggestedFix,
    ...(candidates.length ? { compliant_models: candidates } : {}) };
}

export function validateBuildingCompliance(model: KitModel, slot: BuildingSlot): BuildingValidationIssue | null {
  const candidates = compliantCatalogIds(slot);
  const { halfX, halfZ, height } = modelMetrics(model);
  const cost = model.params?.build_cost ?? costEstimate(model);
  const catalogId = model.params?.catalog_id;
  const catalog = CATALOG.find((entry) => entry.id === catalogId);
  if (halfX > slot.halfX + 0.02 || halfZ > slot.halfZ + 0.02) {
    return issue("model footprint " + (halfX * 2).toFixed(2) + "×" + (halfZ * 2).toFixed(2)
      + " exceeds lot " + (slot.halfX * 2).toFixed(2) + "×" + (slot.halfZ * 2).toFixed(2),
    "shrink or reposition parts so the bbox fits inside the parcel", candidates);
  }
  const minHalfX = slot.halfX * 0.32;
  const minHalfZ = slot.halfZ * 0.32;
  if (halfX + 0.02 < minHalfX || halfZ + 0.02 < minHalfZ) {
    return issue("model footprint " + (halfX * 2).toFixed(2) + "×" + (halfZ * 2).toFixed(2)
      + " under-fills the lot (need at least " + (minHalfX * 2).toFixed(2) + "×" + (minHalfZ * 2).toFixed(2) + ")",
    "widen the base so the building covers more of the parcel (avoid thin pillars)", candidates);
  }
  const stories = storyMetrics(model, height);
  if (stories.storyHeight < slot.storyHeightMin - 0.05 || stories.storyHeight > slot.storyHeightMax + 0.05) {
    return issue("story height " + stories.storyHeight.toFixed(2) + " is outside allowed "
      + slot.storyHeightMin.toFixed(1) + ".." + slot.storyHeightMax.toFixed(1),
    "set params.story_height in range or split into stacked floor parts", candidates);
  }
  if (stories.floors * stories.storyHeight > slot.maxHeight + 0.1) {
    return issue("floors×story height (" + stories.floors + "×" + stories.storyHeight.toFixed(2)
      + ") exceeds session max height " + slot.maxHeight.toFixed(2),
    "reduce floors, lower story_height, or shorten parts", candidates);
  }
  if (height > slot.maxHeight + 0.05) {
    return issue("model height " + height.toFixed(2) + " exceeds " + slot.heightClass + " max "
      + slot.maxHeight.toFixed(2) + " for this session", "lower the structure to match the session height class", candidates);
  }
  const bands = floorBands(model);
  if (height > 6 && bands < 2 && stories.floors < 2) {
    return issue("model height " + height.toFixed(1) + " has no floor stack (need ≥2 floor bands or params.floors ≥ 2)",
      "add stacked wall/structure parts per floor or set params.floors and story_height", candidates);
  }
  if (cost > slot.budgetCap + 0.05) {
    return issue("construction cost " + cost.toFixed(1) + " exceeds session budget cap " + slot.budgetCap.toFixed(1),
      "use fewer/smaller parts, set params.build_cost honestly, or pick a catalog kit within budget", candidates);
  }
  if (catalog) {
    if (cost > catalog.cost + 0.05) return issue("construction cost " + cost.toFixed(1) + " exceeds catalog "
      + catalog.id + " cost " + catalog.cost.toFixed(1), "simplify the model or pick a catalog kit with a higher cost", candidates);
    if (halfX > catalog.halfX + 0.02 || halfZ > catalog.halfZ + 0.02) {
      return issue("model footprint exceeds catalog " + catalog.id + " lot size", "shrink the footprint or choose another catalog_id", candidates);
    }
    if (height > catalog.height + 0.05) {
      return issue("model height exceeds catalog " + catalog.id + " max " + catalog.height.toFixed(1), "lower the roof or pick a taller catalog entry", candidates);
    }
  } else if (catalogId) {
    return issue("unknown catalog_id " + catalogId, "use an id from get_building.projection.compliant_catalog", candidates);
  }
  if (!catalog?.providesDoorWindow && height > 3.5) {
    for (const role of ["door", "window"]) {
      if (!hasRole(model, role)) return issue("occupiable building is missing required part role " + role,
        "add parts with role door and window, or set params.catalog_id to a kit that provides them", candidates);
    }
  }
  return null;
}

function catalogDetailScore(entry: (typeof CATALOG)[number]): number {
  return entry.typicalParts * 2 + (entry.providesDoorWindow ? 6 : 0)
    + (entry.detailTier === 0 ? 0 : entry.detailTier === 1 ? 5 : 10);
}

export function validateDetailRegression(current: KitModel, proposed: KitModel, slot: BuildingSlot): BuildingValidationIssue | null {
  const before = detailScore(current);
  const after = detailScore(proposed);
  if (after.total >= before.total) return null;
  const candidates = compliantCatalogIds(slot).filter((id) => {
    const entry = CATALOG.find((candidate) => candidate.id === id);
    return !!entry && catalogDetailScore(entry) >= before.total;
  });
  const suggestions = candidates.length ? candidates : compliantCatalogIds(slot);
  const label = (tier: number) => tier === 0 ? "coarse" : tier === 1 ? "standard" : "detailed";
  return { kind: "validation", rule: "detail_regression", parts: [],
    message: "proposed detail score " + after.total + " is below current " + before.total + " (parts "
      + before.partCount + "→" + after.partCount + ", tier " + label(before.tier) + "→" + label(after.tier) + ")",
    suggested_fix: "add parts, door/window roles, or raise params.detail_tier; do not simplify below the current building",
    ...(suggestions.length ? { compliant_models: suggestions } : {}) };
}
