/**
 * Session-kit/v1 construction apply path (no renderer).
 *
 * Host events and city:v3 `buildings.overrides` share this reducer so load,
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

export type KitModel = {
  kit_version: string;
  params?: { form?: string; palette?: string };
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

const KINDS = new Set<KitKind>(["box", "cylinder", "cone"]);
const ROLES = new Set<KitRole>(["wall", "trim", "roof", "glass", "structure", "door", "window"]);

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
  if (typeof row.kind !== "string" || !isKitKind(row.kind)) return null;
  if (typeof row.role !== "string" || !isKitRole(row.role)) return null;
  const at = vec3(row.at);
  const size = vec3(row.size);
  if (!at || !size || size.some((n) => n <= 0)) return null;
  const rot = row.rot === undefined ? undefined : vec3(row.rot);
  if (row.rot !== undefined && !rot) return null;
  const color = typeof row.color === "string" && /^#[0-9a-fA-F]{6}$/.test(row.color) ? row.color : undefined;
  const id = typeof row.id === "string" && row.id.length > 0 && row.id.length <= 64 ? row.id : undefined;
  return { id, kind: row.kind, role: row.role, at, size, ...(rot ? { rot } : {}), ...(color ? { color } : {}) };
}

export function parseKitModel(raw: unknown): KitModel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.kit_version !== "session-kit/v1" || !Array.isArray(row.parts) || row.parts.length < 1 || row.parts.length > 64) return null;
  const parts: KitPart[] = [];
  for (const item of row.parts) {
    const part = parseKitPart(item);
    if (!part) return null;
    parts.push(part);
  }
  return { kit_version: "session-kit/v1", parts };
}

/** Lift a SQLite / city:v3 build_events row onto the shared host envelope. */
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
