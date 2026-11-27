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

/** PR06：无头 Code Game 测试记录（`creator_code_test` 落盘、
 * `creator_code_test_record` 读出）的证据投影。「执行成功」与「测试通过」分开：
 * executionOk 只说明 runner 跑完，verdict 才是游戏结论（passed/failed/inconclusive）。
 * pre-PR06 记录没有 verdict，解析直接拒绝（发布门同样按 stale 拒绝）。 */
export const CODE_TEST_VERDICTS = ["passed", "failed", "inconclusive"] as const;
export type CodeTestVerdict = (typeof CODE_TEST_VERDICTS)[number];
const CODE_TEST_ASSERTION_KINDS = ["outcome", "entityCountAtLeast", "entityCountAtMost", "hudFlag", "counterAtLeast", "counterEquals", "finishedWithinTicks"] as const;
const CODE_TEST_ASSERTION_STATUSES = ["passed", "failed", "unknown"] as const;

export type CodeTestAssertionRow = Readonly<{ id: string; kind: string; status: (typeof CODE_TEST_ASSERTION_STATUSES)[number]; diagnostic: string | null }>;

export type CodeTestRecordV1 = Readonly<{
  buildId: string;
  workspaceRevision: string | null;
  ok: boolean;
  executionOk: boolean;
  verdict: CodeTestVerdict;
  verdictReason: string | null;
  scenarioId: string | null;
  assertions: readonly CodeTestAssertionRow[];
  worldSnapshotDigest: string | null;
  source: Readonly<Record<string, unknown>> | null;
  cityId: string | null;
  cityRevision: number | null;
  snapshotDigest: string | null;
}>;

const digest = (value: unknown): string | null => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;

export function parseCodeTestRecord(value: unknown): CodeTestRecordV1 {
  const row = object(value);
  const buildId = digest(row?.buildId);
  const ok = typeof row?.ok === "boolean" ? row.ok : null;
  const executionOk = typeof row?.executionOk === "boolean" ? row.executionOk : null;
  const verdict = typeof row?.verdict === "string" && (CODE_TEST_VERDICTS as readonly string[]).includes(row.verdict) ? row.verdict as CodeTestVerdict : null;
  if (!row || !buildId || ok === null || executionOk === null || !verdict) throw new Error("creator_code_test_record_invalid");
  const assertions = Array.isArray(row.assertions) ? Object.freeze(row.assertions.slice(0, 8).map(item => {
    const assertion = object(item);
    const id = text(assertion?.id, 64);
    const kind = typeof assertion?.kind === "string" && (CODE_TEST_ASSERTION_KINDS as readonly string[]).includes(assertion.kind) ? assertion.kind : null;
    const status = typeof assertion?.status === "string" && (CODE_TEST_ASSERTION_STATUSES as readonly string[]).includes(assertion.status) ? assertion.status : null;
    if (!assertion || !id || !kind || !status) throw new Error("creator_code_test_record_invalid");
    return Object.freeze({ id, kind, status: status as CodeTestAssertionRow["status"], diagnostic: text(assertion.diagnostic, 200) });
  })) : [];
  const source = object(row.source);
  return Object.freeze({
    buildId, workspaceRevision: text(row.workspaceRevision, 64), ok, executionOk, verdict,
    verdictReason: text(row.verdictReason, 64), scenarioId: text(row.scenarioId, 128),
    assertions, worldSnapshotDigest: digest(row.worldSnapshotDigest), source,
    cityId: text(source?.cityId, 128), cityRevision: number(source?.cityRevision), snapshotDigest: digest(source?.snapshotDigest),
  });
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
