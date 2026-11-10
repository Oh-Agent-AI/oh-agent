/**
 * Session-kit/v1 construction apply path (no renderer).
 *
 * Host events and generic typed-object snapshots share this reducer so load,
 * live push, poll fallback, and replay all agree on: which revision wins,
 * whether to animate, and which parts are visible at a given progress.
 *
 * Host wire is the shared `CityEntityChanged` envelope (`entity_kind=building`).
 */
import { ENTITY_CHANGED_TYPE, parseEntityChanged, type CityEntityChanged } from "./entityEvents";

export type KitKind = "box" | "cylinder" | "cone";
export type KitRole = "wall" | "trim" | "roof" | "glass" | "structure" | "door" | "window";

export type KitPart = {
  id?: string;
  kind: KitKind;
  role: KitRole;
  at: [number, number, number];
  size: [number, number, number];
  rot?: [number, number, number];
  color?: string;
};

export type KitParams = {
  form?: "tower" | "slab" | "block" | "midrise";
  palette?: string;
  catalog_id?: string;
  build_cost?: number;
  floors?: number;
  story_height?: number;
  detail_tier?: 0 | 1 | 2 | "coarse" | "standard" | "detailed";
};

export type KitModel = {
  kit_version: string;
  params?: KitParams;
  parts: KitPart[];
};

export type BuildingChangedEvent = CityEntityChanged & {
  entity_kind: "building";
  asset_ref: string;
  build_event_id: string;
  kind: "set" | "reset";
  model?: KitModel | null;
};

export type OverlayDecision = {
  assetRef: string;
  sessionId: string;
  revision: number;
  buildEventId: string;
  kind: "set" | "reset";
  source: "override" | "default";
  parts: KitPart[];
  /** Live host/poll event after the city is on screen. Cold load snaps. */
  animate: boolean;
};

function round4(value: number): number { return Math.round(value * 10_000) / 10_000; }

/** Default City building model derived from the session's token volume. */
export function defaultKitModel(tokens: number): KitModel {
  const magnitude = Math.max(Math.log10(Math.max(tokens, 1)) - 1, 0);
  const height = Math.max(2.6, Math.min(48, 0.75 * magnitude ** 2.2));
  const form = height >= 30 ? "tower" : height >= 14 ? "midrise" : "block";
  const [width, depth] = form === "tower" ? [3.2, 3.2] : form === "midrise" ? [5.2, 4.4] : [4.6, 4.6];
  const podium = Math.max(0.6, Math.min(1.2, height * 0.2));
  const roof = Math.max(0.25, Math.min(0.4, height * 0.08));
  const shaftHeight = Math.max(0.8, height - podium - roof);
  const shaftWidth = Math.max(width * 0.86, 1.2);
  const shaftDepth = Math.max(depth * 0.86, 1.2);
  const storyHeight = Math.max(2.4, Math.min(4.2, shaftHeight / 2));
  return {
    kit_version: "session-kit/v1",
    params: { form, floors: 2, story_height: round4(storyHeight) },
    parts: [
      { id: "podium", kind: "box", role: "structure", at: [0, 0, 0], size: [width, podium, depth] },
      { id: "shaft", kind: "box", role: "wall", at: [0, podium, 0], size: [shaftWidth, shaftHeight, shaftDepth] },
      { id: "roof", kind: "box", role: "roof", at: [0, podium + shaftHeight, 0], size: [width, roof, depth] },
      { id: "door", kind: "box", role: "door", at: [0, 0, depth / 2 + 0.11], size: [1.2, 2, 0.2] },
      { id: "window", kind: "box", role: "window", at: [0, podium + shaftHeight * 0.35, depth / 2 + 0.085], size: [1.4, 1.2, 0.15] },
    ],
  };
}

const KINDS = new Set<KitKind>(["box", "cylinder", "cone"]);
const ROLES = new Set<KitRole>(["wall", "trim", "roof", "glass", "structure", "door", "window"]);
const MODEL_FIELDS = new Set(["kit_version", "params", "parts"]);
const PARAM_FIELDS = new Set(["form", "palette", "catalog_id", "build_cost", "floors", "story_height", "detail_tier"]);
const PART_FIELDS = new Set(["id", "kind", "role", "at", "size", "rot", "color"]);
const LOT_HALF_X = 4;
const LOT_HALF_Z = 6;
const MAX_BUILDING_HEIGHT = 48;
const OVERLAP_EPSILON = 0.02;

export function isKitKind(value: string): value is KitKind {
  return KINDS.has(value as KitKind);
}
export function isKitRole(value: string): value is KitRole {
  return ROLES.has(value as KitRole);
}

export function constructionOrder(parts: KitPart[]): KitPart[] {
  return [...parts].sort((left, right) => {
    const byY = left.at[1] - right.at[1];
    if (byY !== 0) return byY;
    return (left.id ?? "").localeCompare(right.id ?? "");
  });
}

/** How many parts should exist at `progress` in [0, 1], counting the in-progress block. */
export function visiblePartCount(progress: number, partCount: number): number {
  if (partCount <= 0) return 0;
  if (progress <= 0) return 0;
  if (progress >= 1) return partCount;
  return Math.min(partCount, Math.floor(progress * partCount) + 1);
}

/** Per-part reveal in [0, 1]. Parts assemble bottom-to-top, one block at a time. */
export function partReveal(progress: number, index: number, partCount: number): number {
  if (partCount <= 0) return 1;
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const start = index / partCount;
  const end = (index + 1) / partCount;
  if (progress <= start) return 0;
  if (progress >= end) return 1;
  return (progress - start) / (end - start);
}

export function parseKitPart(raw: unknown): KitPart | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !PART_FIELDS.has(key))) return null;
  if (row.id !== undefined && (typeof row.id !== "string" || row.id.length === 0 || row.id.length > 64)) return null;
  if (typeof row.kind !== "string" || !isKitKind(row.kind)) return null;
  if (typeof row.role !== "string" || !isKitRole(row.role)) return null;
  const at = vec3(row.at);
  const size = vec3(row.size);
  if (!at || !size || size.some((n) => n <= 0)) return null;
  if (size[0] > LOT_HALF_X * 2 + 0.5 || size[2] > LOT_HALF_Z * 2 + 0.5 || size[1] > MAX_BUILDING_HEIGHT) return null;
  const rot = row.rot === undefined ? undefined : vec3(row.rot);
  if (row.rot !== undefined && !rot) return null;
  if (row.color !== undefined && (typeof row.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(row.color))) return null;
  const color = row.color as string | undefined;
  const id = row.id as string | undefined;
  return { id, kind: row.kind, role: row.role, at, size, ...(rot ? { rot } : {}), ...(color ? { color } : {}) };
}

export function parseKitModel(raw: unknown): KitModel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !MODEL_FIELDS.has(key))) return null;
  if (row.kit_version !== "session-kit/v1" || !Array.isArray(row.parts) || row.parts.length < 1 || row.parts.length > 64) return null;
  let params: KitParams | undefined;
  if (row.params !== undefined) {
    if (!row.params || typeof row.params !== "object" || Array.isArray(row.params)) return null;
    const rawParams = row.params as Record<string, unknown>;
    if (Object.keys(rawParams).some((key) => !PARAM_FIELDS.has(key))) return null;
    if (rawParams.form !== undefined && !["tower", "slab", "block", "midrise"].includes(String(rawParams.form))) return null;
    if (rawParams.palette !== undefined && (typeof rawParams.palette !== "string" || !/^#[0-9a-fA-F]{6}$/.test(rawParams.palette))) return null;
    if (rawParams.catalog_id !== undefined && typeof rawParams.catalog_id !== "string") return null;
    if (rawParams.build_cost !== undefined && (typeof rawParams.build_cost !== "number" || !Number.isFinite(rawParams.build_cost) || rawParams.build_cost < 0)) return null;
    if (rawParams.floors !== undefined && (!Number.isSafeInteger(rawParams.floors) || Number(rawParams.floors) < 1)) return null;
    if (rawParams.story_height !== undefined && (typeof rawParams.story_height !== "number" || !Number.isFinite(rawParams.story_height) || rawParams.story_height <= 0)) return null;
    if (rawParams.detail_tier !== undefined && !([0, 1, 2, "coarse", "standard", "detailed"] as unknown[]).includes(rawParams.detail_tier)) return null;
    params = { ...rawParams } as KitParams;
  }
  const parts: KitPart[] = [];
  for (const item of row.parts) {
    const part = parseKitPart(item);
    if (!part) return null;
    parts.push(part);
  }
  const ids = parts.flatMap((part) => part.id ? [part.id] : []);
  if (new Set(ids).size !== ids.length || !validKitGeometry(parts)) return null;
  return { kit_version: "session-kit/v1", ...(params ? { params } : {}), parts };
}

type KitBounds = { min: [number, number, number]; max: [number, number, number] };

function kitPartBounds(part: KitPart): KitBounds {
  // Match the host validator's conservative rotated footprint approximation.
  const rotated = !!part.rot?.some((value) => Math.abs(value) > 1e-6);
  const halfX = rotated ? Math.max(part.size[0], part.size[2]) / 2 : part.size[0] / 2;
  const halfZ = rotated ? Math.max(part.size[0], part.size[2]) / 2 : part.size[2] / 2;
  return { min: [part.at[0] - halfX, part.at[1], part.at[2] - halfZ],
    max: [part.at[0] + halfX, part.at[1] + part.size[1], part.at[2] + halfZ] };
}

function validKitGeometry(parts: readonly KitPart[]): boolean {
  const bounds = parts.map(kitPartBounds);
  for (const box of bounds) {
    if (box.min[0] < -LOT_HALF_X - OVERLAP_EPSILON || box.max[0] > LOT_HALF_X + OVERLAP_EPSILON
        || box.min[2] < -LOT_HALF_Z - OVERLAP_EPSILON || box.max[2] > LOT_HALF_Z + OVERLAP_EPSILON
        || box.min[1] < -OVERLAP_EPSILON || box.max[1] > MAX_BUILDING_HEIGHT + OVERLAP_EPSILON) return false;
  }
  for (let left = 0; left < bounds.length; left += 1) {
    for (let right = left + 1; right < bounds.length; right += 1) {
      const a = bounds[left]!;
      const b = bounds[right]!;
      if ([0, 1, 2].every((axis) => a.min[axis]! < b.max[axis]! - OVERLAP_EPSILON
          && b.min[axis]! < a.max[axis]! - OVERLAP_EPSILON)) return false;
    }
  }
  return true;
}

/** Lift a building kit revision change onto the shared host event envelope. */
export function entityChangedFromBuilding(row: {
  asset_ref: string;
  revision: number;
  kind: "set" | "reset";
  build_event_id?: string;
  event_id?: string;
  session_id?: string;
  source?: string;
  model?: KitModel | null;
}): BuildingChangedEvent {
  const event_id = row.event_id ?? row.build_event_id ?? `be_load_${row.asset_ref}`;
  return {
    type: ENTITY_CHANGED_TYPE,
    entity_kind: "building",
    entity_id: row.asset_ref,
    action: row.kind,
    revision: row.revision,
    event_id,
    session_id: row.session_id,
    source: row.source,
    model: row.model,
    asset_ref: row.asset_ref,
    build_event_id: event_id,
    kind: row.kind,
  };
}

export function parseBuildingChanged(raw: unknown): BuildingChangedEvent | null {
  const entity = parseEntityChanged(raw);
  if (!entity || entity.entity_kind !== "building") return null;
  if (entity.action !== "set" && entity.action !== "reset") return null;
  if (!/^ca_[0-9a-f]{32}$/.test(entity.entity_id)) return null;
  const model = entity.model == null ? null : parseKitModel(entity.model);
  if (entity.action === "set" && !model) return null;
  const event_id = entity.event_id;
  return {
    ...entity,
    entity_kind: "building",
    asset_ref: entity.asset_ref ?? entity.entity_id,
    build_event_id: entity.build_event_id ?? event_id,
    kind: entity.action,
    model,
  };
}

/**
 * Decide the next overlay. Same build_event_id is a no-op (replay goes through
 * `replayDecision`). Older revisions are ignored. Reset clears kit parts.
 */
export function applyBuildingEvent(
  current: OverlayDecision | null,
  event: BuildingChangedEvent,
  sessionId: string,
  animate: boolean,
): OverlayDecision | null {
  if (current && current.buildEventId === event.event_id) return current;
  if (current && event.revision < current.revision) return current;
  const kind = event.action === "reset" || event.source === "default" ? "reset" : "set";
  const parts = kind === "set" && event.model ? constructionOrder(event.model.parts) : [];
  return {
    assetRef: event.entity_id,
    sessionId: event.session_id ?? sessionId,
    revision: event.revision,
    buildEventId: event.event_id,
    kind,
    source: kind === "reset" ? "default" : "override",
    parts,
    animate,
  };
}

export function replayDecision(current: OverlayDecision): OverlayDecision {
  return { ...current, animate: true };
}

function vec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const n = value[i];
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}
