import type { MechaCombatCue } from "../../../render/mecha/animation";
import type { TurnEvent } from "../board";

/** Animation cues come only from accepted battle events, never from previews. */
export function cuesFromLog(log: readonly TurnEvent[]): MechaCombatCue[] {
  const cues: MechaCombatCue[] = [];
  for (const event of log) {
    if (event.type === "act" && !event.fizzled && event.action !== "skip") {
      cues.push({ actor: event.mechId, action: event.action === "repair" ? "repair" : "attack", target: event.target });
    } else if (event.type === "enemy") {
      cues.push({ actor: event.actor, action: "attack" });
    }
  }
  return cues;
}
