import type { EntityTransformV1, Vec3V1, WorldBoundsV1 } from "../api/types";
import type { GameDiagnosticCodeV1 } from "../protocol/diagnostics";
import { GameSdkError } from "../protocol/errors";
import { deepFreeze } from "../protocol/freeze";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 byte length without TextEncoder: the package is DOM-free and this must
 * agree with the byte budget a browser host would apply. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * JSON is the wire format across the host boundary, so values that JSON would
 * silently rewrite (NaN/Infinity become null) are rejected instead. A game
 * that stores NaN in a transform must fail, not teleport an entity to origin.
 */
export function assertJsonSafe(value: unknown, label: string, depth = 0): void {
  if (depth > 6) throw new GameSdkError("game_argument_invalid", `${label} is nested too deeply.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GameSdkError("game_argument_invalid", `${label} contains a non-finite number.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSafe(item, label, depth + 1);
    return;
  }
  if (isPlainRecord(value)) {
    for (const key of Object.keys(value)) assertJsonSafe(value[key], label, depth + 1);
    return;
  }
  throw new GameSdkError(
    "game_argument_invalid",
    `${label} must contain only JSON values (no functions, dates or class instances).`,
  );
}

export function cloneJson<T>(
  value: T,
  label: string,
  maxBytes: number,
  budgetCode: GameDiagnosticCodeV1 = "game_ui_budget_exceeded",
): T {
  assertJsonSafe(value, label);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new GameSdkError("game_argument_invalid", `${label} is not serializable.`);
  }
  if (typeof text !== "string") {
    throw new GameSdkError("game_argument_invalid", `${label} must be a JSON value.`);
  }
  if (utf8Length(text) > maxBytes) {
    throw new GameSdkError(budgetCode, `${label} exceeds the ${maxBytes} byte budget.`);
  }
  return deepFreeze(JSON.parse(text) as T);
}

export function readVec3(value: unknown, label: string): Vec3V1 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new GameSdkError("game_argument_invalid", `${label} must be a [x, y, z] tuple.`);
  }
  const [x, y, z] = value;
  for (const component of [x, y, z]) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new GameSdkError("game_argument_invalid", `${label} must contain finite numbers.`);
    }
  }
  return Object.freeze([x, y, z]) as Vec3V1;
}

export function readTransform(value: unknown, label: string): EntityTransformV1 {
  if (!isPlainRecord(value)) {
    throw new GameSdkError("game_argument_invalid", `${label} must be an object.`);
  }
  const position = readVec3(value.position, `${label}.position`);
  const rotation = value.rotation === undefined ? undefined : readVec3(value.rotation, `${label}.rotation`);
  const scale = value.scale === undefined ? undefined : readVec3(value.scale, `${label}.scale`);
  return Object.freeze({
    position,
    ...(rotation !== undefined ? { rotation } : {}),
    ...(scale !== undefined ? { scale } : {}),
  });
}

export function readBounds(value: unknown, label: string): WorldBoundsV1 {
  if (!isPlainRecord(value)) {
    throw new GameSdkError("game_argument_invalid", `${label} must be an object.`);
  }
  const min = readVec3(value.min, `${label}.min`);
  const max = readVec3(value.max, `${label}.max`);
  for (let axis = 0; axis < 3; axis += 1) {
    if ((min[axis] as number) > (max[axis] as number)) {
      throw new GameSdkError("game_argument_invalid", `${label}.min must not exceed ${label}.max.`);
    }
  }
  return Object.freeze({ min, max });
}

export function readProps(value: unknown, label: string, maxBytes = 4096): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new GameSdkError("game_argument_invalid", `${label} must be a plain object.`);
  }
  return cloneJson(value, label, maxBytes);
}
