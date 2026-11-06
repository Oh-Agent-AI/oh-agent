import type * as THREE from "three";

type PositionedActor = { id: string; x: number; y: number };
type BattleStart = { figures: readonly PositionedActor[]; boss: { x: number; y: number }; raiders: readonly PositionedActor[] };

export function positionPerformanceActors(
  actors: Record<string, THREE.Group>, start: BattleStart,
  cellToWorld: (cell: { x: number; y: number }, actor: string) => THREE.Vector3,
): void {
  for (const actor of [...start.figures, ...start.raiders, { id: "boss", ...start.boss }]) {
    actors[actor.id]?.position.copy(cellToWorld(actor, actor.id));
  }
}
