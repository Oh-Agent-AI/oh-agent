import { MECH_IDS, presentationSnapshot, type MatchState, type MechId, type PresentationSnapshot } from "../board";
import { bossExecute, type EnemyActorTrace } from "../enemy";
import { prepareEnemy, scriptedEnemyPlanner } from "../enemy/planner";
import type { EnemyPlanner } from "../enemy/contracts";

export type EnemyPhaseResolution = {
  hits: Record<MechId, number>;
  afterEnemy: PresentationSnapshot | null;
  afterPrepare: PresentationSnapshot | null;
};

export type EnemyPhaseOptions = {
  planner?: EnemyPlanner;
  capturePresentation?: boolean;
  /** Run cleanup after enemy actions but before recording the enemy snapshot. */
  afterBoss?: () => void;
  /** Preserve rule-event placement between the enemy snapshot and next preparation. */
  afterEnemy?: (snapshot: PresentationSnapshot | null, hits: Record<MechId, number>) => void;
  /** Preserve rule-event placement after preparation. */
  afterPrepare?: (snapshot: PresentationSnapshot | null) => void;
  onActor?: (step: EnemyActorTrace) => void;
};

/** Shared deterministic boss execution and next-enemy preparation for both turn drivers. */
export function resolveEnemyPhase(state: MatchState, options: EnemyPhaseOptions = {}): EnemyPhaseResolution {
  const hpBefore = Object.fromEntries(state.mechs.map(mech => [mech.id, mech.hp])) as Record<MechId, number>;
  if (state.phase === "resolving_boss") bossExecute(state, options.onActor);
  options.afterBoss?.();

  const afterEnemy = options.capturePresentation ? presentationSnapshot(state) : null;
  const hits = Object.fromEntries(MECH_IDS.map(id => [
    id,
    Math.max(0, (hpBefore[id] ?? 0) - (state.mechs.find(mech => mech.id === id)?.hp ?? 0)),
  ])) as Record<MechId, number>;
  options.afterEnemy?.(afterEnemy, hits);

  if (state.phase === "enemy_prepare") prepareEnemy(state, options.planner ?? scriptedEnemyPlanner);
  const afterPrepare = options.capturePresentation ? presentationSnapshot(state) : null;
  options.afterPrepare?.(afterPrepare);
  return { hits, afterEnemy, afterPrepare };
}
