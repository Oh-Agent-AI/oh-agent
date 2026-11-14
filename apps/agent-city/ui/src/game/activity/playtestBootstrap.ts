import type { CityWorldProfileV1 } from "../../engine/cityWorldProfile";

/** One-shot City boot override for a city-scoped Creator playtest. Stored in
 * sessionStorage so a reload cannot leak it into the player's saved City; it is
 * consumed only while the matching pending run exists. */
export type PlaytestBootstrapV1 = Readonly<{ runId: string; worldRevision: string; seed: number; profile: CityWorldProfileV1 }>;
const KEY = "city.playtest.bootstrap.v1";

export function readPlaytestBootstrap(): PlaytestBootstrapV1 | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.runId !== "string" || typeof record.worldRevision !== "string"
      || !Number.isSafeInteger(record.seed) || (record.seed as number) < 0 || (record.seed as number) > 0xffff_ffff
      || !record.profile || typeof record.profile !== "object") return null;
    return Object.freeze({ runId: record.runId, worldRevision: record.worldRevision, seed: record.seed as number,
      profile: record.profile as CityWorldProfileV1 });
  } catch { return null; }
}

export function writePlaytestBootstrap(value: PlaytestBootstrapV1): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(value)); } catch { /* sessionStorage unavailable: no bootstrap */ }
}

export function clearPlaytestBootstrap(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
