import type { AnchorCapability, AnchorKind, DiagnosticV1, MiniGamePackV1, Result, RuleActionV1, RuleEventV1, RuleGuardV1 } from "./types";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ANCHOR_KINDS = new Set<AnchorKind>(["spawn", "route", "zone", "object"]);
const CAPABILITIES = new Set<AnchorCapability>(["drive", "walk"]);
const MAX_PACK_JSON_BYTES = 256 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
function id(value: unknown): value is string { return typeof value === "string" && IDENTIFIER.test(value); }
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function diagnostic(code: string, path: string, message: string, objectId?: string): DiagnosticV1 {
  return { code, severity: "error", path, message, ...(objectId ? { objectId } : {}) };
}

/** Parse and validate an untrusted JSON mini-game definition. Packs are data-only;
 * executable JavaScript, arbitrary host calls and unknown rule operations are rejected.
 */
export function parseMiniGamePackJson(text: string): Result<MiniGamePackV1> {
  if (typeof text !== "string") return { ok: false, diagnostics: [diagnostic("content_invalid_json", "$", "Mini-game content must be JSON text.")] };
  if (new TextEncoder().encode(text).byteLength > MAX_PACK_JSON_BYTES) return { ok: false, diagnostics: [diagnostic("content_budget_exceeded", "$", "Mini-game JSON exceeds the 256 KiB package budget.")] };
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, diagnostics: [diagnostic("content_invalid_json", "$", "Mini-game content is not valid JSON.")] }; }
  return validateMiniGamePack(parsed);
}

export function validateMiniGamePack(value: unknown): Result<MiniGamePackV1> {
  const diagnostics: DiagnosticV1[] = [];
  if (!object(value)) return { ok: false, diagnostics: [diagnostic("content_invalid_shape", "$", "Mini-game pack must be a JSON object.")] };
  if (!hasOnlyKeys(value, ["schemaVersion", "id", "rulesVersion", "slots", "integerParameters", "rules"])) diagnostics.push(diagnostic("content_field_unsupported", "$", "Mini-game pack contains unsupported fields."));
  if (value.schemaVersion !== 1 || value.rulesVersion !== 1) diagnostics.push(diagnostic("schema_unsupported", "$", "Only mini-game schema and rules version 1 are supported."));
  if (!id(value.id)) diagnostics.push(diagnostic("content_invalid_id", "id", "Pack ID must be a stable ASCII identifier."));
  if (!object(value.slots)) diagnostics.push(diagnostic("content_invalid_shape", "slots", "Slots must be an object."));
  const slots = object(value.slots) ? value.slots : {};
  if (Object.keys(slots).length > 32) diagnostics.push(diagnostic("content_budget_exceeded", "slots", "A pack may declare at most 32 slots."));
  for (const [name, raw] of Object.entries(slots)) {
    const path = `slots.${name}`;
    if (!id(name) || !object(raw)) { diagnostics.push(diagnostic("content_invalid_slot", path, "Slot must have a stable ID and object definition.")); continue; }
    if (!hasOnlyKeys(raw, ["kind", "min", "max", "requires"])) diagnostics.push(diagnostic("content_field_unsupported", path, "Slot contains unsupported fields."));
    if (typeof raw.kind !== "string" || !ANCHOR_KINDS.has(raw.kind as AnchorKind)) diagnostics.push(diagnostic("content_invalid_slot", `${path}.kind`, "Slot kind is unsupported."));
    if (!integer(raw.min, 0, 64) || !integer(raw.max, 0, 64) || (integer(raw.min, 0, 64) && integer(raw.max, 0, 64) && raw.min > raw.max)) diagnostics.push(diagnostic("content_invalid_slot", path, "Slot min/max must be integers from 0 to 64, with min no greater than max."));
    if (raw.requires !== undefined && (!Array.isArray(raw.requires) || raw.requires.some(capability => typeof capability !== "string" || !CAPABILITIES.has(capability as AnchorCapability)))) diagnostics.push(diagnostic("content_invalid_slot", `${path}.requires`, "Slot capabilities must be drive or walk."));
  }
  let parameters: Record<string, unknown> = {};
  if (value.integerParameters !== undefined) {
    if (!object(value.integerParameters)) diagnostics.push(diagnostic("content_invalid_parameter", "integerParameters", "Integer parameters must be an object."));
    else parameters = value.integerParameters;
  }
  if (Object.keys(parameters).length > 32) diagnostics.push(diagnostic("content_budget_exceeded", "integerParameters", "A pack may declare at most 32 integer parameters."));
  for (const [name, raw] of Object.entries(parameters)) {
    if (!id(name) || !object(raw) || !hasOnlyKeys(raw, ["min", "max", "default"]) || !integer(raw.min, 0, 1_000_000) || !integer(raw.max, 0, 1_000_000) || !integer(raw.default, 0, 1_000_000) || raw.min > raw.max || raw.default < raw.min || raw.default > raw.max) {
      diagnostics.push(diagnostic("content_invalid_parameter", `integerParameters.${name}`, "Parameter bounds/default must be ordered integers between 0 and 1,000,000."));
    }
  }
  if (!object(value.rules)) diagnostics.push(diagnostic("rule_invalid_shape", "rules", "Rules must be an object."));
  const rules = object(value.rules) ? value.rules : {};
  if (!hasOnlyKeys(rules, ["counters", "nodes"])) diagnostics.push(diagnostic("content_field_unsupported", "rules", "Rules contain unsupported fields."));
  if (!object(rules.counters)) diagnostics.push(diagnostic("rule_invalid_counter", "rules.counters", "Counters must be an object."));
  const counters = object(rules.counters) ? rules.counters : {};
  if (Object.keys(counters).length > 32) diagnostics.push(diagnostic("rule_budget_exceeded", "rules.counters", "A rule graph may declare at most 32 counters."));
  for (const [name, raw] of Object.entries(counters)) {
    if (!id(name) || !object(raw) || !hasOnlyKeys(raw, ["initial", "max"]) || !integer(raw.initial, 0, 1_000_000_000) || !integer(raw.max, 0, 1_000_000_000) || raw.initial > raw.max) diagnostics.push(diagnostic("rule_invalid_counter", `rules.counters.${name}`, "Counter bounds must be non-negative integers; initial must not exceed max."));
  }
  if (!Array.isArray(rules.nodes)) diagnostics.push(diagnostic("rule_invalid_shape", "rules.nodes", "Rule nodes must be an array."));
  const nodes = Array.isArray(rules.nodes) ? rules.nodes : [];
  if (nodes.length > 128) diagnostics.push(diagnostic("rule_budget_exceeded", "rules.nodes", "A rule graph may declare at most 128 nodes."));
  const nodeIds = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    const path = `rules.nodes[${index}]`, raw = nodes[index];
    if (!object(raw) || !id(raw.id)) { diagnostics.push(diagnostic("rule_invalid_node", path, "Rule node must have an object body and stable ID.")); continue; }
    if (!hasOnlyKeys(raw, ["id", "on", "when", "actions"])) diagnostics.push(diagnostic("content_field_unsupported", path, "Rule node contains unsupported fields.", raw.id));
    if (nodeIds.has(raw.id)) diagnostics.push(diagnostic("rule_duplicate_node_id", `${path}.id`, "Rule node IDs must be unique.", raw.id));
    nodeIds.add(raw.id);
    const event = raw.on;
    let eventValid = false;
    if (object(event)) {
      if (event.type === "run.started" && !hasOnlyKeys(event, ["type"])) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "run.started event has unsupported fields.", raw.id));
      if (event.type === "run.started") eventValid = true;
      else if (event.type === "zone.entered" || event.type === "item.collected") {
        if (!hasOnlyKeys(event, ["type", "slot"])) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "Player input event has unsupported fields.", raw.id));
        const slotId = event.slot;
        eventValid = id(slotId) && hasOwn(slots, slotId);
        if (!eventValid) diagnostics.push(diagnostic("rule_slot_not_found", `${path}.on.slot`, "Rule references an undeclared slot.", raw.id));
        else if (event.type === "zone.entered" && typeof slotId === "string" && object(slots[slotId]) && slots[slotId].kind !== "zone") diagnostics.push(diagnostic("rule_slot_kind_mismatch", `${path}.on.slot`, "zone.entered rules require a zone slot.", raw.id));
      } else if (event.type === "timer.expired") { eventValid = id(event.timerId); if (!hasOnlyKeys(event, ["type", "timerId"])) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "Timer event has unsupported fields.", raw.id)); }
    }
    if (!eventValid) diagnostics.push(diagnostic("rule_invalid_event", `${path}.on`, "Rule event type or required event fields are invalid.", raw.id));
    if (raw.when !== undefined && (!Array.isArray(raw.when) || raw.when.length > 8)) diagnostics.push(diagnostic("rule_budget_exceeded", `${path}.when`, "A rule may contain at most 8 guards.", raw.id));
    if (Array.isArray(raw.when)) for (const [guardIndex, guard] of raw.when.entries()) {
      if (!object(guard) || !id(guard.counter) || !hasOwn(counters, guard.counter) ||
        (guard.op === "counter.eq" && !integer(guard.value, 0, 1_000_000_000)) ||
        (guard.op !== "counter.eq" && guard.op !== "counter.eqEventIndex")) diagnostics.push(diagnostic("rule_invalid_guard", `${path}.when[${guardIndex}]`, "Guard operation or counter reference is invalid.", raw.id));
      if (object(guard) && guard.op === "counter.eqEventIndex" && object(event) && event.type !== "zone.entered" && event.type !== "item.collected") diagnostics.push(diagnostic("rule_invalid_guard", `${path}.when[${guardIndex}]`, "counter.eqEventIndex requires a player input event.", raw.id));
    }
    if (!Array.isArray(raw.actions) || raw.actions.length > 16) diagnostics.push(diagnostic("rule_budget_exceeded", `${path}.actions`, "A rule must contain at most 16 actions.", raw.id));
    if (Array.isArray(raw.actions)) for (const [actionIndex, action] of raw.actions.entries()) {
      const actionPath = `${path}.actions[${actionIndex}]`;
      if (!object(action) || typeof action.op !== "string") { diagnostics.push(diagnostic("rule_invalid_action", actionPath, "Action must be an object with an operation.", raw.id)); continue; }
      if (action.op === "counter.add") {
        if (!hasOnlyKeys(action, ["op", "counter", "amount"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "counter.add contains unsupported fields.", raw.id));
        if (!id(action.counter) || !hasOwn(counters, action.counter) || !integer(action.amount, -1_000_000, 1_000_000)) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "counter.add requires a declared counter and bounded integer amount.", raw.id));
      } else if (action.op === "timer.start") {
        if (!hasOnlyKeys(action, ["op", "timerId", "durationTicks"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "timer.start contains unsupported fields.", raw.id));
        const durationValid = typeof action.durationTicks === "number" ? integer(action.durationTicks, 1, 1_000_000)
          : object(action.durationTicks) && hasOnlyKeys(action.durationTicks, ["parameter"]) && id(action.durationTicks.parameter) && hasOwn(parameters, action.durationTicks.parameter);
        if (!id(action.timerId) || !durationValid) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "timer.start requires a stable timer ID and bounded duration.", raw.id));
      } else if (action.op === "hud.hint") {
        if (!hasOnlyKeys(action, ["op", "text"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "hud.hint contains unsupported fields.", raw.id));
        if (typeof action.text !== "string" || action.text.length > 160) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "HUD hint must be text no longer than 160 characters.", raw.id));
      } else if (action.op === "run.finish") {
        if (!hasOnlyKeys(action, ["op", "outcome"])) diagnostics.push(diagnostic("rule_invalid_action", actionPath, "run.finish contains unsupported fields.", raw.id));
        if (action.outcome !== "success" && action.outcome !== "failure") diagnostics.push(diagnostic("rule_invalid_action", actionPath, "run.finish outcome must be success or failure.", raw.id));
      } else diagnostics.push(diagnostic("rule_operation_unsupported", actionPath, "Action operation is not supported by the safe version 1 runtime.", raw.id));
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const snapshot: MiniGamePackV1 = {
    schemaVersion: 1,
    id: value.id as string,
    rulesVersion: 1,
    slots: Object.fromEntries(Object.entries(slots).map(([name, raw]) => {
      const slot = raw as Record<string, unknown>;
      return [name, { kind: slot.kind as AnchorKind, min: slot.min as number, max: slot.max as number,
        ...(Array.isArray(slot.requires) ? { requires: [...slot.requires] as AnchorCapability[] } : {}) }];
    })),
    ...(Object.keys(parameters).length ? { integerParameters: Object.fromEntries(Object.entries(parameters).map(([name, raw]) => {
      const parameter = raw as Record<string, unknown>;
      return [name, { min: parameter.min as number, max: parameter.max as number, default: parameter.default as number }];
    })) } : {}),
    rules: {
      counters: Object.fromEntries(Object.entries(counters).map(([name, raw]) => {
        const counter = raw as Record<string, unknown>;
        return [name, { initial: counter.initial as number, max: counter.max as number }];
      })),
      nodes: nodes.map(raw => {
        const node = raw as Record<string, unknown>;
        const event = node.on as Record<string, unknown>;
        return {
          id: node.id as string,
          on: event.type === "run.started" ? { type: "run.started" as const }
            : event.type === "timer.expired" ? { type: "timer.expired" as const, timerId: event.timerId as string }
              : { type: event.type as "zone.entered" | "item.collected", slot: event.slot as string },
          ...(Array.isArray(node.when) ? { when: node.when.map(guard => ({ ...(guard as Record<string, unknown>) } as RuleGuardV1)) } : {}),
          actions: (node.actions as unknown[]).map(action => {
            const copied = { ...(action as Record<string, unknown>) };
            if (object(copied.durationTicks)) copied.durationTicks = { ...copied.durationTicks };
            return copied as RuleActionV1;
          }),
        };
      }),
    },
  };
  const freeze = <T>(item: T): T => {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return { ok: true, value: freeze(snapshot), diagnostics };
}
