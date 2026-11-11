import { parseKitModel, type KitModel, type KitPart } from "./sessionKitConstruction";

export const INHERITANCE_KIT_VERSION = "session-kit/inheritance/v1";
export const FINE_CATALOG_IDS = ["kit-fine-midrise", "kit-fine-storefront"] as const;

export type InheritanceDocument = {
  kit_version: typeof INHERITANCE_KIT_VERSION;
  base?: { kind: "projection" } | { kind: "catalog"; catalog_id: string };
  overrides?: { params?: Record<string, unknown>; parts_replace?: Array<{ id: string; part: KitPart }>; parts_add?: KitPart[]; parts_remove?: string[] };
  reset?: true;
};

export type InheritanceIssue = { rule: "invalid_inheritance" | "invalid_model"; message: string; suggested_fix: string };
export class InheritanceError extends Error {
  readonly issue: InheritanceIssue;
  constructor(message: string, suggestedFix: string, rule: InheritanceIssue["rule"] = "invalid_inheritance") {
    super(message);
    this.name = "InheritanceError";
    this.issue = { rule, message, suggested_fix: suggestedFix };
  }
}

type CatalogEntry = { params: NonNullable<KitModel["params"]>; parts: KitPart[] };
const CATALOG: Record<string, CatalogEntry> = {
  "kit-low-block": { params: { form: "block", catalog_id: "kit-low-block", floors: 2, story_height: 2.8, detail_tier: "standard", build_cost: 32 }, parts: [
    { id: "base", kind: "box", role: "structure", at: [0, 0, 0], size: [5, 2.8, 6] },
    { id: "cap", kind: "box", role: "wall", at: [0, 2.8, 0], size: [4.5, 2.8, 5.5] },
    { id: "door", kind: "box", role: "door", at: [0, 0, 3.11], size: [1.2, 2, 0.2] },
    { id: "window", kind: "box", role: "window", at: [0, 3.5, 3.085], size: [1.4, 1.2, 0.15] },
  ] },
  "kit-midrise": { params: { form: "midrise", catalog_id: "kit-midrise", floors: 2, story_height: 3.2, detail_tier: "detailed", build_cost: 72 }, parts: [
    { id: "base", kind: "box", role: "structure", at: [0, 0, 0], size: [5, 3, 6] },
    { id: "upper", kind: "box", role: "wall", at: [0, 3, 0], size: [4.5, 3.2, 5.5] },
    { id: "door", kind: "box", role: "door", at: [0, 0, 3.11], size: [1.2, 2.2, 0.2] },
    { id: "window", kind: "box", role: "window", at: [0, 4, 3.085], size: [1.4, 1.2, 0.15] },
    { id: "roof", kind: "box", role: "roof", at: [0, 6.2, 0], size: [5, 0.35, 6] },
  ] },
  "kit-tower": { params: { form: "tower", catalog_id: "kit-tower", floors: 3, story_height: 3.4, detail_tier: "detailed", build_cost: 120 }, parts: [
    { id: "podium", kind: "box", role: "structure", at: [0, 0, 0], size: [3.2, 1.2, 3.2] },
    { id: "shaft", kind: "box", role: "wall", at: [0, 1.2, 0], size: [2.8, 8.5, 2.8] },
    { id: "roof", kind: "box", role: "roof", at: [0, 9.7, 0], size: [3.2, 0.4, 3.2] },
    { id: "door", kind: "box", role: "door", at: [0, 0, 1.71], size: [1, 2, 0.2] },
    { id: "window", kind: "box", role: "window", at: [0, 4.5, 1.685], size: [1.2, 1, 0.15] },
  ] },
  "kit-wide-slab": { params: { form: "slab", catalog_id: "kit-wide-slab", floors: 2, story_height: 3, detail_tier: "standard", build_cost: 48 }, parts: [
    { id: "base", kind: "box", role: "structure", at: [0, 0, 0], size: [6.4, 3, 4] },
    { id: "upper", kind: "box", role: "wall", at: [0, 3, 0], size: [6, 3, 3.6] },
    { id: "door", kind: "box", role: "door", at: [0, 0, 2.11], size: [1.2, 2, 0.2] },
    { id: "window", kind: "box", role: "window", at: [0, 4, 2.085], size: [1.6, 1.2, 0.15] },
  ] },
  "kit-fine-midrise": { params: { form: "midrise", catalog_id: "kit-fine-midrise", floors: 2, story_height: 3.2, detail_tier: "detailed", build_cost: 85 }, parts: [
    { id: "podium", kind: "box", role: "structure", at: [0, 0, 0], size: [5.2, 1, 6] },
    { id: "floor1", kind: "box", role: "wall", at: [0, 1, 0], size: [4.8, 3.2, 5.6] },
    { id: "floor2", kind: "box", role: "wall", at: [0, 4.2, 0], size: [4.6, 3.2, 5.4] },
    { id: "cornice", kind: "box", role: "trim", at: [0, 7.45, 0], size: [5, 0.25, 5.8] },
    { id: "roof", kind: "box", role: "roof", at: [0, 7.7, 0], size: [5.2, 0.35, 6] },
    { id: "door", kind: "box", role: "door", at: [0, 0, 3.11], size: [1.3, 2.2, 0.2] },
    { id: "window", kind: "box", role: "window", at: [0, 2.2, 3.085], size: [1.5, 1.4, 0.15] },
    { id: "window_upper", kind: "box", role: "window", at: [0, 5.2, 3.085], size: [1.5, 1.4, 0.15] },
  ] },
  "kit-fine-storefront": { params: { form: "block", catalog_id: "kit-fine-storefront", floors: 2, story_height: 3, detail_tier: "detailed", build_cost: 78 }, parts: [
    { id: "base", kind: "box", role: "structure", at: [0, 0, 0], size: [5.4, 3, 6] },
    { id: "upper", kind: "box", role: "wall", at: [0, 3, 0], size: [5, 3, 5.6] },
    { id: "awning", kind: "box", role: "trim", at: [0, 4.5, 3.18], size: [4, 0.15, 0.25] },
    { id: "door", kind: "box", role: "door", at: [0, 0, 3.11], size: [1.2, 2.2, 0.2] },
    { id: "glass", kind: "box", role: "glass", at: [0, 2.4, 3.08], size: [3.6, 1.4, 0.12] },
    { id: "window", kind: "box", role: "window", at: [0, 5.2, 3.085], size: [1.6, 1.3, 0.15] },
  ] },
};

export function catalogModel(id: string): KitModel | null {
  const entry = CATALOG[id];
  return entry ? { kit_version: "session-kit/v1", params: { ...entry.params }, parts: entry.parts.map((part) => ({ ...part,
    at: [...part.at] as KitPart["at"], size: [...part.size] as KitPart["size"] })) } : null;
}

export function isInheritanceDocument(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).kit_version === INHERITANCE_KIT_VERSION;
}

/** Resolve only the inheritance layer. Preview/set must still pass the full geometry, slot, detail and design gates. */
export function resolveInheritance(defaultModel: KitModel, document: unknown): KitModel {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new InheritanceError("inheritance must be a JSON object", "send {kit_version, base, overrides}");
  }
  const doc = document as Record<string, unknown>;
  if (doc.reset === true) return structuredClone(defaultModel);
  const allowedDoc = new Set(["kit_version", "base", "overrides", "reset"]);
  const extra = Object.keys(doc).find((key) => !allowedDoc.has(key));
  if (extra) throw new InheritanceError(`unknown inheritance field \`${extra}\``, "only kit_version, base, overrides, reset are allowed");
  if (doc.kit_version !== INHERITANCE_KIT_VERSION) {
    throw new InheritanceError(`kit_version must be \`${INHERITANCE_KIT_VERSION}\` (got \`${String(doc.kit_version ?? "")}\`)`,
      `set kit_version to \`${INHERITANCE_KIT_VERSION}\``);
  }
  const base = doc.base;
  if (!base || typeof base !== "object" || Array.isArray(base)) throw new InheritanceError("base must be an object", "use {kind: projection} or {kind: catalog, catalog_id}");
  const baseRow = base as Record<string, unknown>;
  const extraBase = Object.keys(baseRow).find((key) => !["kind", "catalog_id"].includes(key));
  if (extraBase) throw new InheritanceError(`unknown base field \`${extraBase}\``, "base only accepts kind and catalog_id");
  let model: KitModel;
  if (baseRow.kind === "projection") model = structuredClone(defaultModel);
  else if (baseRow.kind === "catalog") {
    if (typeof baseRow.catalog_id !== "string") throw new InheritanceError("base.catalog_id is required when kind is catalog", "pick an id from get_building.projection.compliant_catalog");
    const selected = catalogModel(baseRow.catalog_id);
    if (!selected) throw new InheritanceError(`unknown catalog_id \`${baseRow.catalog_id}\` for re-base`, "use an id from get_building.projection.compliant_catalog");
    model = selected;
  } else throw new InheritanceError(`base.kind \`${String(baseRow.kind ?? "")}\` is not supported`, "use projection or catalog");

  const overrides = doc.overrides === undefined ? {} : doc.overrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new InheritanceError("overrides must be an object", "send overrides.params / parts_add / parts_remove / parts_replace");
  const edit = overrides as Record<string, unknown>;
  const extraOverride = Object.keys(edit).find((key) => !["params", "parts_replace", "parts_add", "parts_remove"].includes(key));
  if (extraOverride) throw new InheritanceError(`unknown overrides field \`${extraOverride}\``, "overrides accepts params, parts_replace, parts_add, parts_remove");
  if (edit.params !== undefined) {
    if (!edit.params || typeof edit.params !== "object" || Array.isArray(edit.params)) throw new InheritanceError("overrides.params must be an object", "set scalar params such as story_height, detail_tier, build_cost");
    model.params = { ...(model.params ?? {}), ...(edit.params as Record<string, unknown>) } as KitModel["params"];
  }
  if (edit.parts_remove !== undefined) {
    if (!Array.isArray(edit.parts_remove) || edit.parts_remove.some((id) => typeof id !== "string")) throw new InheritanceError("parts_remove entries must be strings", "use part id strings");
    const remove = new Set(edit.parts_remove as string[]);
    model.parts = model.parts.filter((part) => !part.id || !remove.has(part.id));
  }
  if (edit.parts_replace !== undefined) {
    if (!Array.isArray(edit.parts_replace)) throw new InheritanceError("parts_replace must be an array", "send [{id, part}, …]");
    for (const raw of edit.parts_replace) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InheritanceError("parts_replace entries must be objects", "use {id, part}");
      const replacement = raw as Record<string, unknown>;
      if (typeof replacement.id !== "string") throw new InheritanceError("parts_replace.id is required", "name the part id to replace");
      const index = model.parts.findIndex((part) => part.id === replacement.id);
      if (index < 0) throw new InheritanceError(`parts_replace id \`${replacement.id}\` was not found in the base mesh`, "check the base catalog layout or use parts_add");
      if (!replacement.part || typeof replacement.part !== "object" || Array.isArray(replacement.part)) throw new InheritanceError(`parts_replace \`${replacement.id}\` is missing part`, "send the full replacement part object");
      const part = parseKitModel({ kit_version: "session-kit/v1", parts: [replacement.part] })?.parts[0];
      if (!part) throw new InheritanceError(`parts_replace \`${replacement.id}\` is not a valid part`, "send a valid session-kit part", "invalid_model");
      model.parts[index] = part;
    }
  }
  if (edit.parts_add !== undefined) {
    if (!Array.isArray(edit.parts_add)) throw new InheritanceError("parts_add must be an array of parts", "append new part objects");
    for (const raw of edit.parts_add) {
      const part = parseKitModel({ kit_version: "session-kit/v1", parts: [raw] })?.parts[0];
      if (!part) throw new InheritanceError("parts_add contains an invalid part", "append valid session-kit part objects", "invalid_model");
      model.parts.push(part);
    }
  }
  const normalized = parseKitModel(model);
  if (!normalized) throw new InheritanceError("merged model does not match session-kit/v1 shape", "correct model params and parts", "invalid_model");
  return normalized;
}

export function normalizeInheritance(document: unknown): InheritanceDocument {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new InheritanceError("inheritance must be an object", "send inheritance JSON");
  const doc = document as Record<string, unknown>;
  if (doc.reset === true) return { kit_version: INHERITANCE_KIT_VERSION, reset: true };
  if (!isInheritanceDocument(doc)) throw new InheritanceError(`kit_version must be \`${INHERITANCE_KIT_VERSION}\``, `set kit_version to \`${INHERITANCE_KIT_VERSION}\``);
  return { kit_version: INHERITANCE_KIT_VERSION, base: doc.base as InheritanceDocument["base"],
    overrides: (doc.overrides ?? {}) as InheritanceDocument["overrides"] };
}
