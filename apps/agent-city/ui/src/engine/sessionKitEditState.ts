/**
 * Ephemeral City edit states for MCP preview / validation reject.
 *
 * Persist construction (`set`/`reset`) stays in sessionKitConstruction.
 * This reducer never writes overlay revision: ghost sits on top of the
 * committed building, and fail-flash highlights it then expires.
 */
import { parseEntityChanged, type CityEntityChanged } from "./entityEvents";
import { constructionOrder, parseKitModel, type KitPart } from "./sessionKitConstruction";

export const GHOST_OPACITY = 0.38;
export const REJECT_FLASH_MS = 900;
export const FLASH_RULES = ["invalid_model", "detail_regression", "disconnected_part", "massing_drift"] as const;

export type FlashRule = (typeof FLASH_RULES)[number];

export type BuildingEditEvent = CityEntityChanged & {
  entity_kind: "building";
  action: "preview" | "reject";
  asset_ref: string;
  model?: ReturnType<typeof parseKitModel>;
  error?: { rule?: string } | null;
};

export type GhostVisual = {
  kind: "ghost";
  assetRef: string;
  sessionId: string;
  eventId: string;
  revision: number;
  parts: KitPart[];
};

export type RejectVisual = {
  kind: "reject";
  assetRef: string;
  sessionId: string;
  eventId: string;
  revision: number;
  rule: FlashRule;
  startedAtMs: number;
};

export type EditVisual = GhostVisual | RejectVisual;

export function isFlashRule(rule: string | undefined): rule is FlashRule {
  return FLASH_RULES.includes(rule as FlashRule);
}

export function parseBuildingEdit(raw: unknown): BuildingEditEvent | null {
  const entity = parseEntityChanged(raw);
  if (!entity || entity.entity_kind !== "building") return null;
  if (entity.action !== "preview" && entity.action !== "reject") return null;
  if (!/^ca_[0-9a-f]{32}$/.test(entity.entity_id)) return null;
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const error = parseError(row.error);
  if (entity.action === "reject" && !isFlashRule(error?.rule)) return null;
  const model = entity.action === "preview" ? parseKitModel(entity.model) : null;
  if (entity.action === "preview" && !model) return null;
  return {
    ...entity,
    entity_kind: "building",
    action: entity.action,
    asset_ref: entity.asset_ref ?? entity.entity_id,
    model,
    error,
  };
}

/**
 * Replace the current edit visual. Same event_id is a no-op so mailbox poll
 * cannot restart a flash or rebuild a ghost the City already applied.
 */
export function applyEditEvent(
  current: EditVisual | null,
  event: BuildingEditEvent,
  sessionId: string,
  nowMs: number,
): EditVisual | null {
  if (current && current.eventId === event.event_id) return current;
  if (event.action === "preview") {
    return {
      kind: "ghost",
      assetRef: event.entity_id,
      sessionId: event.session_id ?? sessionId,
      eventId: event.event_id,
      revision: event.revision,
      parts: event.model ? constructionOrder(event.model.parts) : [],
    };
  }
  const rule = event.error?.rule;
  if (!isFlashRule(rule)) return current;
  return {
    kind: "reject",
    assetRef: event.entity_id,
    sessionId: event.session_id ?? sessionId,
    eventId: event.event_id,
    revision: event.revision,
    rule,
    startedAtMs: nowMs,
  };
}

/** One in-out pulse over REJECT_FLASH_MS. */
export function flashEnvelope(elapsedMs: number, durationMs = REJECT_FLASH_MS): { opacity: number; active: boolean } {
  if (elapsedMs < 0) return { opacity: 0, active: false };
  if (elapsedMs >= durationMs) return { opacity: 0, active: false };
  return { opacity: 0.55 * Math.sin((elapsedMs / durationMs) * Math.PI), active: true };
}

export function editPresentation(visual: EditVisual, nowMs: number): { kind: EditVisual["kind"]; opacity: number; active: boolean; rule?: FlashRule } {
  if (visual.kind === "ghost") {
    return { kind: "ghost", opacity: GHOST_OPACITY, active: visual.parts.length > 0 };
  }
  const pulse = flashEnvelope(nowMs - visual.startedAtMs);
  return { kind: "reject", opacity: pulse.opacity, active: pulse.active, rule: visual.rule };
}

function parseError(raw: unknown): { rule?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rule = (raw as Record<string, unknown>).rule;
  return typeof rule === "string" ? { rule } : {};
}
