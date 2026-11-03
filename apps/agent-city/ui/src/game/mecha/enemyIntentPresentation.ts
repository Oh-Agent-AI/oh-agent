/** Current declarations only. These are aim rays, not movement paths or a
 * simulation of the friendly draft. Every target still belongs to the area. */
import { declaredAttack, type DeclaredAttack, type InspectionSegment } from "./cellInspection";
import type { MatchState } from "./board";

export function declaredEnemyIntents(state: MatchState): DeclaredAttack[] {
  return ["boss", ...state.raiders.map(r => r.id)].flatMap(actor => {
    const attack = declaredAttack(state, actor);
    return attack?.targets.length ? [attack] : [];
  });
}

/** At most three real target rays: angular bounds and a central direction.
 * Never join targets in array order (an area is not a zigzag walk route), and
 * never draw a fabricated centroid as an attack cell. Collinear cells need only
 * the farthest ray. The largest angular gap unwraps fans crossing +/- pi. */
export function declaredIntentSegments(attack: DeclaredAttack): InspectionSegment[] {
  if (!attack.skill || attack.skill === "skip" || attack.status === "void" || attack.status === "missing") return [];
  const from = { x: attack.origin.x + (attack.footprint - 1) / 2, y: attack.origin.y + (attack.footprint - 1) / 2 };
  const rays = attack.targets.filter(c => c.x !== from.x || c.y !== from.y).map(to => ({
    to, angle: Math.atan2(to.y - from.y, to.x - from.x), distance: Math.hypot(to.x - from.x, to.y - from.y),
  })).sort((a, b) => a.angle - b.angle || b.distance - a.distance);
  const directions = rays.filter((r, i) => !i || Math.abs(r.angle - rays[i - 1]!.angle) > 1e-6);
  if (!directions.length) return [];
  let start = 0, gap = -1;
  for (let i = 0; i < directions.length; i++) {
    const next = (i + 1) % directions.length;
    const size = directions[next]!.angle + (next === 0 ? 2 * Math.PI : 0) - directions[i]!.angle;
    if (size > gap) { gap = size; start = next; }
  }
  const ordered = [...directions.slice(start), ...directions.slice(0, start)];
  const angle = (r: typeof ordered[number]) => r.angle < ordered[0]!.angle ? r.angle + 2 * Math.PI : r.angle;
  const midpoint = (angle(ordered[0]!) + angle(ordered.at(-1)!)) / 2;
  const central = ordered.reduce((best, r) => Math.abs(angle(r) - midpoint) < Math.abs(angle(best) - midpoint) ? r : best);
  return [...new Set([ordered[0]!, central, ordered.at(-1)!])].map(r => ({ from: { ...from }, to: { ...r.to }, kind: "attack" }));
}
