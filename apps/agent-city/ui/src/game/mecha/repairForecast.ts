import type { MechaPreview } from "./controller";

/** A stage comparison, not attribution of damage or survival to the repair. */
export type RepairEnemyStage =
  | { status: "unknown" }
  | { status: "ended" }
  | { status: "already-destroyed" }
  | { status: "resolved"; before: number; after: number };

export function repairEnemyStage(preview: MechaPreview | null, target: string): RepairEnemyStage {
  if (!preview?.ok || !preview.stages) return { status: "unknown" };
  const { afterPlayer, afterEnemy } = preview.stages;
  const before = afterPlayer.mechs.find(mech => mech.id === target)?.hp;
  const after = afterEnemy.mechs.find(mech => mech.id === target)?.hp;
  if (before === undefined || after === undefined) return { status: "unknown" };
  if (afterPlayer.outcome) return { status: "ended" };
  if (before <= 0) return { status: "already-destroyed" };
  return { status: "resolved", before, after };
}

/** Only compare forecasts produced from the same draft and rules revision. */
export function repairEnemyStageComparison(baseline: MechaPreview | null, candidate: MechaPreview | null, target: string) {
  if (!baseline?.ok || !candidate?.ok || baseline.revision !== candidate.revision || baseline.draftVersion !== candidate.draftVersion) return { status: "unknown" } as const;
  return { status: "ready", baseline: repairEnemyStage(baseline, target), candidate: repairEnemyStage(candidate, target) } as const;
}
