import type { TurnEvent } from "./board";
import type { HealthTimeline } from "./healthTimeline";

/** Actual gross health loss, not net change: later healing does not cancel damage. */
export type TurnRecap = {
  fizzledActions: number;
  health: { enemiesDown: number; mechDamage: number; buildingDamage: number } | null;
};

/** Derive only facts available in the accepted log and its reconciled HP timeline. */
export function buildTurnRecap(log: readonly TurnEvent[], timeline?: HealthTimeline | null): TurnRecap {
  const fizzledActions = log.filter((event) => event.type === "act" && event.fizzled).length;
  if (!timeline?.ok) return { fizzledActions, health: null };
  let mechDamage = 0;
  let buildingDamage = 0;
  const enemiesDown = new Set<string>();
  for (const { effect } of timeline.steps) {
    const loss = Math.max(0, effect.before - effect.after);
    if (effect.kind === "mech") mechDamage += loss;
    else if (effect.kind === "building") buildingDamage += loss;
    else if ((effect.kind === "boss" || effect.kind === "raider") && effect.before > 0 && effect.after <= 0) {
      enemiesDown.add(`${effect.kind}:${effect.id}`);
    }
  }
  return { fizzledActions, health: { enemiesDown: enemiesDown.size, mechDamage, buildingDamage } };
}
