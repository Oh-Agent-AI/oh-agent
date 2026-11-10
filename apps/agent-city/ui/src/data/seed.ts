import { invokeHost, embedded } from "../host";
import type { PluginResponseV1, PluginStateReadResult, PluginStateWriteResult } from "@agent-vitals/app-sdk";
let sequence = 0;
export const DEMO_CITY_SEED = 74031;
export const CITY_SEED_STATE_KEY = "city-seed:v1";

type CitySeedState = { schemaVersion: 1; seed: number };
type SeedStateSnapshot = { value: unknown; revision: number };
export type CitySeedStatePort = {
  readState: () => Promise<SeedStateSnapshot>;
  writeState: (revision: number, value: CitySeedState) => Promise<number>;
};

/** Demo previews intentionally ignore and never modify the user's city seed. */
export function isStandaloneDemo(): boolean {
  return typeof window !== "undefined" && !window.__AV_PLUGIN_INSTANCE__ &&
    typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1";
}

export function randomSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;
}

function validSeed(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 4294967295;
}

function stateSeed(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  return state.schemaVersion === 1 && validSeed(state.seed) ? state.seed : null;
}

function hasUnsupportedFutureSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).schemaVersion === "number"
    && Number.isFinite((value as Record<string, unknown>).schemaVersion)
    && Number((value as Record<string, unknown>).schemaVersion) > 1;
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && /revision_conflict/.test(error.message);
}

export async function readCitySeedState(port: CitySeedStatePort): Promise<number | null> {
  return stateSeed((await port.readState()).value);
}

/** Persist the seed directly in the current plugin state contract. */
export async function writeCitySeedState(port: CitySeedStatePort, seed: number): Promise<number> {
  if (!validSeed(seed)) throw new Error("invalid_seed");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await port.readState();
    if (hasUnsupportedFutureSchema(current.value)) throw new Error("unsupported_schema_version");
    try {
      await port.writeState(current.revision, { schemaVersion: 1, seed });
      return seed;
    } catch (error) {
      if (isRevisionConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("revision_conflict");
}

async function nativeReadState(): Promise<SeedStateSnapshot> {
  const requestId = `city-seed-state-read-${++sequence}`;
  const response = await invokeHost<PluginResponseV1<PluginStateReadResult>>("plugin_request", {
    request: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method: "plugin.state.read",
      payload: { key: CITY_SEED_STATE_KEY } },
  });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result
      || !Number.isSafeInteger(response.result.revision) || response.result.revision < 0) {
    throw new Error(response.error?.code ?? "seed_unavailable");
  }
  return response.result;
}

async function nativeWriteState(revision: number, value: CitySeedState): Promise<number> {
  const requestId = `city-seed-state-write-${++sequence}`;
  const response = await invokeHost<PluginResponseV1<PluginStateWriteResult>>("plugin_request", {
    request: { version: 1, instanceId: window.__AV_PLUGIN_INSTANCE__, requestId, method: "plugin.state.write",
      payload: { key: CITY_SEED_STATE_KEY, revision, value } },
  });
  if (response.version !== 1 || response.requestId !== requestId || !response.ok || !response.result
      || !Number.isSafeInteger(response.result.revision) || response.result.revision <= revision) {
    throw new Error(response.error?.code ?? "seed_unavailable");
  }
  return response.result.revision;
}

const nativePort: CitySeedStatePort = {
  readState: nativeReadState,
  writeState: nativeWriteState,
};

export async function citySeed(action: "read" | "write", seed?: number): Promise<number | null> {
  if (isStandaloneDemo()) return action === "read" ? DEMO_CITY_SEED : (seed ?? DEMO_CITY_SEED);
  if (!embedded() || window.__CITY_ISOLATION_FIXTURE__) {
    if (action === "write") localStorage.setItem("city.seed", String(seed));
    const saved = Number(localStorage.getItem("city.seed") ?? localStorage.getItem("agent-vitals.city-seed"));
    return validSeed(saved) ? saved : null;
  }
  try {
    if (action === "read") return await readCitySeedState(nativePort);
    if (seed === undefined) throw new Error("invalid_seed");
    return await writeCitySeedState(nativePort, seed);
  } catch {
    // Keep the existing local fallback for WebView mount races. A successful
    // native state write remains authoritative; localStorage is only fallback.
    if (action === "write" && seed !== undefined) {
      try { localStorage.setItem("city.seed", String(seed)); } catch { /* 无存储时静默 */ }
    }
    const saved = Number(localStorage.getItem("city.seed"));
    return validSeed(saved) ? saved : null;
  }
}
