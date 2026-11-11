/**
 * Shared host → City write-path envelope.
 *
 * PluginHost evals `__AV_PLUGIN_ENTITY_CHANGED__` with this JSON. City
 * dispatches on `entity_kind`. This PR handles `"building"`; `"road"` /
 * `"vehicle"` reuse the same channel later without a second event name.
 *
 * Keep in lockstep with `city_building::ENTITY_CHANGED_*` and
 * `plugin_host::entity_event_script`.
 */
export const ENTITY_CHANGED_EVENT = "__AV_PLUGIN_ENTITY_CHANGED__";
export const ENTITY_CHANGED_TYPE = "CityEntityChanged";

/** Persist actions (`set`/`reset`) plus ephemeral edit states (`preview`/`reject`). */
export type EntityAction = "set" | "reset" | "preview" | "reject";

export type CityEntityChanged = {
  type: typeof ENTITY_CHANGED_TYPE;
  schema_version?: number;
  entity_kind: string;
  entity_id: string;
  action: EntityAction;
  revision: number;
  event_id: string;
  session_id?: string;
  source?: string;
  model?: unknown;
  /** Building aliases so MCP / SQLite `asset_ref` + `build_event_id` round-trip. */
  asset_ref?: string;
  build_event_id?: string;
  kind?: EntityAction;
};

export type EntityKindHandlers = {
  building?: (event: CityEntityChanged) => void;
  // road / vehicle: add a handler here when those write paths exist.
};

const KIND = /^[a-z][a-z0-9_]{0,31}$/;

export function parseEntityChanged(raw: unknown): CityEntityChanged | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.type !== undefined && row.type !== ENTITY_CHANGED_TYPE) return null;
  const entity_kind = typeof row.entity_kind === "string" && KIND.test(row.entity_kind) ? row.entity_kind : null;
  if (!entity_kind) return null;
  const entity_id = stringId(row.entity_id) ?? stringId(row.asset_ref);
  const event_id = stringId(row.event_id) ?? stringId(row.build_event_id);
  if (!entity_id || !event_id) return null;
  if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0) return null;
  const action = parseAction(row.action) ?? parseAction(row.kind);
  if (!action) return null;
  const session_id = typeof row.session_id === "string" && /^sr_[0-9a-f]{32}$/.test(row.session_id) ? row.session_id : undefined;
  const source = typeof row.source === "string" ? row.source : undefined;
  return {
    type: ENTITY_CHANGED_TYPE,
    schema_version: typeof row.schema_version === "number" ? row.schema_version : undefined,
    entity_kind,
    entity_id,
    action,
    revision: row.revision,
    event_id,
    session_id,
    source,
    model: row.model,
    asset_ref: stringId(row.asset_ref) ?? (entity_kind === "building" ? entity_id : undefined),
    build_event_id: stringId(row.build_event_id) ?? (entity_kind === "building" ? event_id : undefined),
    kind: action,
  };
}

/** Kind-dispatched UI apply. Unknown kinds are a no-op so the envelope stays extensible. */
export function dispatchEntityChanged(event: CityEntityChanged, handlers: EntityKindHandlers): boolean {
  if (event.entity_kind === "building") {
    handlers.building?.(event);
    return true;
  }
  return false;
}

function parseAction(value: unknown): EntityAction | null {
  return value === "set" || value === "reset" || value === "preview" || value === "reject" ? value : null;
}

function stringId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}
