import type { CandidateBuildRef } from "./contracts/creatorProject";

export type CodeBuildRowV1 = Readonly<CandidateBuildRef & {
  gameId: string;
  gameVersion: string | null;
  byteLength: number | null;
  createdAtMs: number | null;
}>;

export type CodePreviewStatusV1 = Readonly<{
  available: boolean;
  status: "starting" | "running" | "finished" | "error" | "unavailable" | "unknown";
  gameId: string | null;
  previewId: string | null;
  buildId: string | null;
  runId: string | null;
  outcome: "success" | "failure" | null;
  reason: string | null;
  tick: number | null;
  entities: number | null;
  updatedAtMs: number | null;
}>;

const text = (value: unknown, max: number): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseCodeBuilds(value: unknown): readonly CodeBuildRowV1[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { builds?: unknown }).builds)) throw new Error("creator_code_builds_invalid");
  return (value as { builds: unknown[] }).builds.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("creator_code_builds_invalid");
    const row = raw as Record<string, unknown>;
    const buildId = text(row.buildId, 64);
    const gameId = text(row.gameId, 128);
    if (!buildId || !/^[a-f0-9]{64}$/.test(buildId) || !gameId) throw new Error("creator_code_builds_invalid");
    return Object.freeze({ buildId, gameId, gameVersion: text(row.gameVersion, 32),
      byteLength: count(row.byteLength), createdAtMs: count(row.createdAtMs) });
  });
}

export function parseCodePreviewStatus(value: unknown): CodePreviewStatusV1 {
  if (!value || typeof value !== "object" || typeof (value as { available?: unknown }).available !== "boolean") throw new Error("creator_code_preview_status_invalid");
  const raw = value as Record<string, unknown>;
  const status = ["starting","running","finished","error","unavailable"].includes(String(raw.status)) ? String(raw.status) as CodePreviewStatusV1["status"] : "unknown";
  const outcome = raw.outcome === "success" || raw.outcome === "failure" ? raw.outcome : null;
  return Object.freeze({ available: raw.available as boolean, status, gameId: text(raw.gameId, 128), previewId: text(raw.previewId, 128), buildId: text(raw.buildId, 64),
    runId: text(raw.runId, 64), outcome, reason: text(raw.reason, 120), tick: count(raw.tick), entities: count(raw.entities), updatedAtMs: count(raw.updatedAtMs) });
}

export type CodeStoryEvidenceV1 = Readonly<{
  available: boolean;
  storyRevision: string | null;
  affection: number | null;
  rules: readonly Readonly<{ ruleId: string; nextDueUtcMs: number | null; status: string }>[];
  dialogue: readonly Readonly<{ eventId: string; text: string; createdAtMs: number | null }>[];
}>;

export function parseCodeStoryEvidence(value: unknown): CodeStoryEvidenceV1 {
  if (!value || typeof value !== "object" || typeof (value as { available?: unknown }).available !== "boolean") throw new Error("creator_code_story_invalid");
  const raw = value as Record<string, unknown>;
  if (!raw.available) return Object.freeze({ available: false, storyRevision: null, affection: null, rules: [], dialogue: [] });
  const state = raw.state && typeof raw.state === "object" ? raw.state as Record<string, unknown> : {};
  const affection = count(state.affection);
  const rules = Array.isArray(raw.rules) ? raw.rules.map(rawRule => {
    if (!rawRule || typeof rawRule !== "object") throw new Error("creator_code_story_invalid");
    const rule = rawRule as Record<string, unknown>;
    const ruleId = text(rule.ruleId, 128);
    const status = text(rule.status, 32);
    if (!ruleId || !status) throw new Error("creator_code_story_invalid");
    return Object.freeze({ ruleId, nextDueUtcMs: count(rule.nextDueUtcMs), status });
  }) : [];
  const dialogue = Array.isArray(raw.dialogue) ? raw.dialogue.map(rawEntry => {
    if (!rawEntry || typeof rawEntry !== "object") throw new Error("creator_code_story_invalid");
    const entry = rawEntry as Record<string, unknown>;
    const eventId = text(entry.eventId, 128);
    const content = text(entry.text, 2_000);
    if (!eventId || !content) throw new Error("creator_code_story_invalid");
    return Object.freeze({ eventId, text: content, createdAtMs: count(entry.createdAtMs) });
  }) : [];
  return Object.freeze({ available: true, storyRevision: text(raw.storyRevision, 128), affection, rules, dialogue });
}

export function canStopCodePreview(status: CodePreviewStatusV1): boolean {
  return (status.status === "starting" || status.status === "running") && !!status.previewId && !!status.runId;
}
