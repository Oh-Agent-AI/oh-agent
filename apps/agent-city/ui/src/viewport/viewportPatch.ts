import type { PlanPatchV1 } from "../engine/planPatch";

/** Legacy patches are seed-scoped and must never be projected into a City draft. */
export function selectViewportPatch(isolatedDraft: boolean, seed: number, local: PlanPatchV1 | null, project: PlanPatchV1 | null): PlanPatchV1 | null {
  if (isolatedDraft) return null;
  const candidates = [local, project].filter((candidate): candidate is PlanPatchV1 => !!candidate && candidate.seed === seed);
  if (!candidates.length) return null;
  return candidates.reduce((newer, candidate) => (candidate.updatedAt ?? 0) > (newer.updatedAt ?? 0) ? candidate : newer);
}
