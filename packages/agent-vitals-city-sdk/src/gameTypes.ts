/**
 * Pure game-type contract for Creator content. Descriptors declare what a game
 * type needs; they never contain executable code. Runtime adapters live in the
 * app-side `@agent-vitals/city-game-runtime` package and consume this contract.
 */
import type { DiagnosticV1, Result } from "./types";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
const SLOT_KINDS = new Set(["spawn", "route", "zone", "object"]);
const CAPABILITIES = new Set(["drive", "walk", "fly"]);
const ASSET_KINDS = new Set(["model-glb"]);
const MAX_SLOTS = 32;
const MAX_PARAMETERS = 32;
const MAX_ASSET_ROLES = 16;

export type GameTypeSlotKindV1 = "spawn" | "route" | "zone" | "object";
export type GameTypeCapabilityV1 = "drive" | "walk" | "fly";
export type GameTypeDescriptorV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  version: number;
  label: string;
  template: string;
  runtime: Readonly<{ id: string; contractVersion: number }>;
  slots: Readonly<Record<string, Readonly<{ kind: GameTypeSlotKindV1; min: number; max: number; requires: readonly GameTypeCapabilityV1[]; role?: string }>>>;
  parameters: Readonly<Record<string, Readonly<{ min: number; max: number; default: number; unit?: string }>>>;
  assetRoles: Readonly<Record<string, Readonly<{ kind: "model-glb"; required: boolean; maxBytes?: number; nodeRoles?: readonly string[] }>>>;
  hud: string;
}>;

const error = (code: string, path: string, message: string): DiagnosticV1 => ({ code, severity: "error", path, message });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;

/** Validate a game-type descriptor before it can enter a runtime registry.
 * This is content semantics, not a runtime implementation check. */
export function validateGameTypeDescriptorV1(input: unknown): Result<GameTypeDescriptorV1> {
  const diagnostics: DiagnosticV1[] = [];
  if (!object(input)) return { ok: false, diagnostics: [error("game_type_invalid", "$", "Game type descriptor must be an object.")] };
  if (!exactKeys(input, ["schemaVersion", "id", "version", "label", "template", "runtime", "slots", "parameters", "assetRoles", "hud"])) {
    diagnostics.push(error("game_type_invalid", "$", "Game type descriptor contains missing or unsupported fields."));
  }
  if (input.schemaVersion !== 1) diagnostics.push(error("game_type_unsupported", "schemaVersion", "Only game type schema version 1 is supported."));
  if (typeof input.id !== "string" || !IDENTIFIER.test(input.id)) diagnostics.push(error("game_type_invalid", "id", "Game type ID must be a stable ASCII identifier."));
  if (!integer(input.version, 1, 2_147_483_647)) diagnostics.push(error("game_type_invalid", "version", "Game type version must be a positive integer."));
  if (!text(input.label, 128)) diagnostics.push(error("game_type_invalid", "label", "Label must be 1..128 characters."));
  if (typeof input.template !== "string" || !IDENTIFIER.test(input.template)) diagnostics.push(error("game_type_invalid", "template", "Template must be a stable identifier."));
  if (!text(input.hud, 64)) diagnostics.push(error("game_type_invalid", "hud", "HUD profile must be a stable identifier."));
  if (!object(input.runtime) || !exactKeys(input.runtime, ["id", "contractVersion"])
    || typeof input.runtime.id !== "string" || !IDENTIFIER.test(input.runtime.id)
    || !integer(input.runtime.contractVersion, 1, 2_147_483_647)) {
    diagnostics.push(error("game_type_invalid", "runtime", "Runtime must declare a stable id and positive contract version."));
  }
  const slots = object(input.slots) ? input.slots : {};
  if (!object(input.slots) || Object.keys(slots).length > MAX_SLOTS) diagnostics.push(error("game_type_budget", "slots", `Slots must be an object with at most ${MAX_SLOTS} entries.`));
  for (const [name, raw] of Object.entries(slots)) {
    const path = `slots.${name}`;
    if (!IDENTIFIER.test(name) || !object(raw)) { diagnostics.push(error("game_type_invalid", path, "Slot must have a stable ID and object body.")); continue; }
    if (!exactKeys(raw, ["kind", "min", "max", "requires", "role"]) && !exactKeys(raw, ["kind", "min", "max", "requires"])) diagnostics.push(error("game_type_invalid", path, "Slot contains unsupported fields."));
    if (typeof raw.kind !== "string" || !SLOT_KINDS.has(raw.kind)) diagnostics.push(error("game_type_invalid", `${path}.kind`, "Slot kind is unsupported."));
    const slotMin = integer(raw.min, 0, 64);
    const slotMax = integer(raw.max, 0, 64);
    if (!slotMin || !slotMax || (raw.min as number) > (raw.max as number)) diagnostics.push(error("game_type_invalid", path, "Slot min/max must be ordered integers from 0 to 64."));
    if (!Array.isArray(raw.requires) || raw.requires.length === 0 || raw.requires.length > 4 || raw.requires.some(item => typeof item !== "string" || !CAPABILITIES.has(item))) {
      diagnostics.push(error("game_type_invalid", `${path}.requires`, "Slot capabilities must be one or more of drive, walk, fly."));
    }
    if (raw.role !== undefined && (typeof raw.role !== "string" || !IDENTIFIER.test(raw.role))) diagnostics.push(error("game_type_invalid", `${path}.role`, "Slot role must be a stable identifier."));
  }
  const parameters = object(input.parameters) ? input.parameters : {};
  if (!object(input.parameters) || Object.keys(parameters).length > MAX_PARAMETERS) diagnostics.push(error("game_type_budget", "parameters", `Parameters must be an object with at most ${MAX_PARAMETERS} entries.`));
  for (const [name, raw] of Object.entries(parameters)) {
    const path = `parameters.${name}`;
    if (!IDENTIFIER.test(name) || !object(raw)) { diagnostics.push(error("game_type_invalid", path, "Parameter must have a stable ID and object body.")); continue; }
    if (!exactKeys(raw, ["min", "max", "default", "unit"]) && !exactKeys(raw, ["min", "max", "default"])) diagnostics.push(error("game_type_invalid", path, "Parameter contains unsupported fields."));
    const minOk = integer(raw.min, 0, 1_000_000);
    const maxOk = integer(raw.max, 0, 1_000_000);
    const defaultOk = integer(raw.default, 0, 1_000_000);
    if (!minOk || !maxOk || !defaultOk
      || (raw.min as number) > (raw.max as number) || (raw.default as number) < (raw.min as number) || (raw.default as number) > (raw.max as number)) {
      diagnostics.push(error("game_type_invalid", path, "Parameter min/max/default must be ordered integers from 0 to 1,000,000."));
    }
    if (raw.unit !== undefined && (typeof raw.unit !== "string" || !VERSION.test(raw.unit))) diagnostics.push(error("game_type_invalid", `${path}.unit`, "Parameter unit must be a short stable token."));
  }
  const assetRoles = object(input.assetRoles) ? input.assetRoles : {};
  if (!object(input.assetRoles) || Object.keys(assetRoles).length > MAX_ASSET_ROLES) diagnostics.push(error("game_type_budget", "assetRoles", `Asset roles must be an object with at most ${MAX_ASSET_ROLES} entries.`));
  for (const [name, raw] of Object.entries(assetRoles)) {
    const path = `assetRoles.${name}`;
    if (!IDENTIFIER.test(name) || !object(raw)) { diagnostics.push(error("game_type_invalid", path, "Asset role must have a stable ID and object body.")); continue; }
    if (!exactKeys(raw, ["kind", "required", "maxBytes", "nodeRoles"]) && !exactKeys(raw, ["kind", "required", "maxBytes"]) && !exactKeys(raw, ["kind", "required"])) diagnostics.push(error("game_type_invalid", path, "Asset role contains unsupported fields."));
    if (typeof raw.kind !== "string" || !ASSET_KINDS.has(raw.kind)) diagnostics.push(error("game_type_invalid", `${path}.kind`, "Asset role kind must be model-glb."));
    if (typeof raw.required !== "boolean") diagnostics.push(error("game_type_invalid", `${path}.required`, "Asset role requires must be boolean."));
    if (raw.maxBytes !== undefined && (!integer(raw.maxBytes, 20, 64 * 1024 * 1024))) diagnostics.push(error("game_type_invalid", `${path}.maxBytes`, "Asset maxBytes must be between 20 bytes and 64 MiB."));
    if (raw.nodeRoles !== undefined && (!Array.isArray(raw.nodeRoles) || raw.nodeRoles.length > 32 || raw.nodeRoles.some(item => typeof item !== "string" || !IDENTIFIER.test(item)))) {
      diagnostics.push(error("game_type_invalid", `${path}.nodeRoles`, "nodeRoles must be at most 32 stable identifiers."));
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: deepFreeze({ ...input, slots, parameters, assetRoles } as GameTypeDescriptorV1), diagnostics: [] };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
