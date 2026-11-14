import type { DiagnosticV1, Result } from "./types";
import { canonicalJson } from "./package";

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
// Generated road/parcel IDs include negative coordinates and slash-separated endpoints.
const id = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9-][a-zA-Z0-9._:/-]{0,127}$/.test(v);
const num = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const point = (v: unknown, height = false): boolean => obj(v) && Object.keys(v).length === (height ? 3 : 2) && only(v, height ? ["x", "z", "h"] : ["x", "z"]) && num(v.x, -1e6, 1e6) && num(v.z, -1e6, 1e6) && (!height || num(v.h, -1e6, 1e6));
const optionalPoint = (v: Record<string, unknown>, k: string) => v[k] === undefined || point(v[k]);
const text = (v: unknown) => typeof v === "string" && new TextEncoder().encode(v).length <= 128 && v.length > 0 && !/\p{Cc}/u.test(v);
const invalid = (code: string, message: string): Result<never> => ({ ok: false, diagnostics: [{ code, severity: "error", path: "patch", message } as DiagnosticV1] });

/** Portable structural PlanPatchV1 check; City must still replay and validate geometry. */
export function validateWorldPlanPatch(input: unknown, seed: number, generatorVersion: number): Result<Readonly<Record<string, unknown>>> {
  let raw: string, value: unknown;
  try { raw = canonicalJson(input); if (new TextEncoder().encode(raw).length > 262144) return invalid("world_patch_budget_exceeded", "Patch exceeds 256 KiB."); value = JSON.parse(raw); }
  catch { return invalid("world_patch_invalid", "Patch must be finite plain JSON."); }
  if (!integer(seed, 0, 0xffffffff) || !integer(generatorVersion, 1, 1024) || !obj(value) || !only(value, ["version", "seed", "scaleTier", "generatorVersion", "islandRadius", "updatedAt", "roadOps", "highwayOps", "siteOps", "buildingMoves", "moveAnchors", "suppressedContext", "terrainOps"])
    || value.version !== 1 || value.seed !== seed || (value.generatorVersion ?? 1) !== generatorVersion || !integer(value.scaleTier, 0, 1024) || !integer(value.updatedAt, 0, Number.MAX_SAFE_INTEGER)
    || (value.islandRadius !== undefined && !num(value.islandRadius, Number.MIN_VALUE, 100000))) return invalid("world_patch_scope_invalid", "Patch shape, seed or generator version is invalid.");
  // Session buildings belong to local analytical data. Portable world packages
  // must not serialize their identifiers or location overrides.
  if (!obj(value.buildingMoves) || Object.keys(value.buildingMoves).length !== 0 || (value.moveAnchors !== undefined && (!obj(value.moveAnchors) || Object.keys(value.moveAnchors).length !== 0)))
    return invalid("world_patch_private_buildings", "Portable packages cannot contain session-building IDs or moves.");
  if (!Array.isArray(value.suppressedContext) || value.suppressedContext.length > 4096 || !value.suppressedContext.every(id)) return invalid("world_patch_invalid", "Invalid suppressed context.");
  if (!Array.isArray(value.roadOps) || value.roadOps.length > 4096) return invalid("world_patch_invalid", "Invalid road operations.");
  for (const op of value.roadOps) {
    if (!obj(op)) return invalid("world_patch_invalid", "Invalid road operation.");
    const purpose = op.purpose === undefined || op.purpose === "waterfront";
    const width = num(op.width, Number.MIN_VALUE, 64);
    const valid = op.t === "add" ? only(op, ["t", "from", "to", "width", "purpose", "via"]) && point(op.from) && point(op.to) && width && purpose && optionalPoint(op, "via")
      : op.t === "drop" ? only(op, ["t", "edge", "anchor"]) && id(op.edge) && optionalPoint(op, "anchor")
      : op.t === "move" ? only(op, ["t", "node", "to", "anchor"]) && id(op.node) && point(op.to) && optionalPoint(op, "anchor")
      : op.t === "restyle" ? only(op, ["t", "edge", "width", "purpose", "anchor"]) && id(op.edge) && width && purpose && optionalPoint(op, "anchor") : false;
    if (!valid) return invalid("world_patch_invalid", "Invalid road operation.");
  }
  if (!Array.isArray(value.siteOps) || value.siteOps.length > 4096) return invalid("world_patch_invalid", "Invalid site operations.");
  for (const op of value.siteOps) {
    if (!obj(op) || !id(op.id) || !optionalPoint(op, "at") || (op.cls !== undefined && !text(op.cls))) return invalid("world_patch_invalid", "Invalid site operation.");
    const valid = op.t === "remove" ? only(op, ["t", "id", "at", "cls"]) : op.t === "move" && only(op, ["t", "id", "at", "to", "toAnchor", "cls"]) && text(op.to) && optionalPoint(op, "toAnchor");
    if (!valid) return invalid("world_patch_invalid", "Invalid site operation.");
  }
  if (value.highwayOps !== undefined) {
    if (!Array.isArray(value.highwayOps) || value.highwayOps.length > 1024) return invalid("world_patch_invalid", "Invalid highway operations.");
    for (const op of value.highwayOps) if (!obj(op) || !(op.t === "cut" ? only(op, ["t", "at"]) && point(op.at) : op.t === "add" && only(op, ["t", "points"]) && Array.isArray(op.points) && op.points.length >= 2 && op.points.length <= 256 && op.points.every(p => point(p)))) return invalid("world_patch_invalid", "Invalid highway operation.");
  }
  if (value.terrainOps !== undefined) {
    if (!Array.isArray(value.terrainOps) || value.terrainOps.length > 64) return invalid("world_patch_invalid", "Invalid terrain operations.");
    for (const op of value.terrainOps) if (!obj(op) || !(op.t === "pad" ? only(op, ["t", "at", "radius", "falloff", "height"]) && point(op.at) && num(op.radius, 0, 40) && num(op.falloff, 4, 30) && num(op.height, -1e6, 1e6)
      : op.t === "ramp" && only(op, ["t", "from", "to", "width", "falloff"]) && point(op.from, true) && point(op.to, true) && num(op.width, 2, 24) && num(op.falloff, 4, 30))) return invalid("world_patch_invalid", "Invalid terrain operation.");
  }
  // The validated value is detached; consumers must not interpret this check as
  // proof that roads, terrain or sites can be applied to a generated layout.
  return { ok: true, value: Object.freeze(value), diagnostics: [] };
}
