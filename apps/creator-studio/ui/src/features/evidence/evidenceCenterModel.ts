import type { PlaytestRun } from "../../contracts/creatorStudio";

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 128): string | null => typeof value === "string" && value.length <= max ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export function parsePlaytestHistory(value: unknown): readonly PlaytestRun[] {
  const rows = object(value)?.runs;
  if (!Array.isArray(rows)) throw new Error("creator_playtest_history_invalid");
  return Object.freeze(rows.map(item => {
    const row = object(item);
    const runId = text(row?.runId); const releaseId = text(row?.releaseId);
    const status = text(row?.status); const revision = number(row?.revision);
    const createdAtMs = number(row?.createdAtMs);
    if (!row || !runId || !releaseId || !status || revision === null || createdAtMs === null) throw new Error("creator_playtest_history_invalid");
    const source = text(row.evidenceSource);
    return Object.freeze({ runId, releaseId, revision, status: status as PlaytestRun["status"], createdAtMs,
      finishedAtMs: number(row.finishedAtMs), evidenceSource: source, evidence: row.evidence ?? null, failureCode: text(row.failureCode) });
  }));
}

export type CityDiagnostic = Readonly<{ revision: number; correlationId: string; event: string; code: string | null; elapsedMs: number | null; atMs: number }>;
export function parseCityDiagnostics(value: unknown): readonly CityDiagnostic[] {
  const rows = object(value)?.events;
  if (!Array.isArray(rows)) throw new Error("creator_city_diagnostics_invalid");
  return Object.freeze(rows.map(item => {
    const row = object(item); const revision = number(row?.revision); const correlationId = text(row?.correlationId);
    const event = text(row?.event); const atMs = number(row?.atMs);
    if (!row || revision === null || !correlationId || !event || atMs === null) throw new Error("creator_city_diagnostics_invalid");
    return Object.freeze({ revision, correlationId, event, code: text(row.code), elapsedMs: number(row.elapsedMs), atMs });
  }));
}

export type TraceSummary = Readonly<{ count: number; firstTick: number | null; lastTick: number | null; hostDisagreement: boolean }>;
export function traceSummary(evidence: unknown): TraceSummary | null {
  const row = object(evidence);
  if (!row) return null;
  const trace = Array.isArray(row.trace) ? row.trace : [];
  const ticks = trace.map(item => number(object(item)?.tick)).filter((tick): tick is number => tick !== null);
  return Object.freeze({ count: trace.length, firstTick: ticks[0] ?? null, lastTick: ticks[ticks.length - 1] ?? null,
    hostDisagreement: object(row.hostDisagreement) !== null });
}

export type GroundInspection = Readonly<{
  status: "ready" | "unsupported";
  regionId: string | null;
  code: string | null;
  reason: string | null;
  y: number | null;
  pitch: number | null;
  roll: number | null;
  wheels: readonly number[];
  worldRevision: string | null;
  layerId: string | null;
  surfaceRevision: number | null;
}>;
export function parseGroundInspection(value: unknown): GroundInspection {
  const row = object(value);
  const status = row?.status;
  if (!row || (status !== "ready" && status !== "unsupported")) throw new Error("ground_inspection_invalid");
  const wheels = Array.isArray(row.wheels) ? row.wheels.map(number) : [];
  if (status === "ready" && (wheels.length !== 4 || wheels.some(value => value === null))) throw new Error("ground_inspection_invalid");
  return Object.freeze({ status, regionId: text(row.regionId), code: text(row.code), reason: text(row.reason, 256),
    y: number(row.y), pitch: number(row.pitch), roll: number(row.roll),
    wheels: Object.freeze(wheels.filter((value): value is number => value !== null)), worldRevision: text(row.worldRevision, 256),
    layerId: text(row.layerId, 256), surfaceRevision: number(row.surfaceRevision) });
}
