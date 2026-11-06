/** Read a candidate's effects from the authoritative whole-turn simulation. */
import type { PlanPreview, Cell, MechId, TurnEvent } from "./rules";
import type { HealthEffect } from "./board";
import { projectMovementEffect } from "./skillEffects";

type ReadyPreview = Extract<PlanPreview, { ok: true }>;
type Act = Extract<TurnEvent, { type: "act" }>;
type Shove = Extract<TurnEvent, { type: "shove" }>;
export type CandidateResult = {
  action: Act | null;
  shoves: Array<{ event: Shove; from: Cell | null; to: Cell | null }>;
  /** Only this action's actual changes; nominal skill strength is not healing. */
  healing: number;
  kills: Array<{ kind: HealthEffect["kind"]; id: string; source: "direct" | "collision" }>;
  /** Target HP immediately after this action AND its shoves, before later actions. */
  actionHp: number | null;
  /** HP after all player and enemy actions, not damage attributable to this action. */
  endHp: number | null;
  enemyAttacks: number;
  /** Whole-turn building changes, not attributed to the selected action. */
  buildings: ReadyPreview["buildings"];
};

export function candidateResult(preview: ReadyPreview, mech: MechId, target: string): CandidateResult {
  const index = preview.log.findIndex((event) => event.type === "act" && event.mechId === mech);
  const action = index < 0 ? null : preview.log[index] as Act;
  const before = preview.stages?.afterMovement;
  const positions = new Map<string, Cell>();
  if (before) {
    positions.set("boss", { ...before.boss.anchor });
    for (const unit of before.mechs) positions.set(unit.id, { ...unit.pos });
  }
  const shoves: CandidateResult["shoves"] = [];
  let withinAction = false;
  let endIndex = index < 0 ? 0 : preview.log.length;
  for (let i = 0; i < preview.log.length; i += 1) {
    const event = preview.log[i]!;
    if (event.type === "act" || event.type === "enemy" || event.type === "outcome") {
      if (withinAction && i !== index) endIndex = i;
      withinAction = i === index;
    }
    if (event.type !== "shove") continue;
    const { from, to } = projectMovementEffect(event, positions.get(event.unit)).moves[0]!;
    if (to) positions.set(event.unit, to);
    if (withinAction) shoves.push({ event, from, to });
  }
  const effects = (event: TurnEvent): HealthEffect[] => "effects" in event ? event.effects ?? [] : [];
  // Replay actual health effects up to the selected action boundary. Later
  // damage/death must never be shown as a kill caused by this candidate.
  let actionHp = !action || !before ? null : target === "boss" ? before.boss.hp
    : before.mechs.find(unit => unit.id === target)?.hp ?? before.raiders.find(unit => unit.id === target)?.hp
      ?? before.buildings.find(unit => unit.id === target)?.hp ?? null;
  if (action && before) {
    for (const effect of preview.log.slice(0, endIndex).flatMap(effects).sort((a, b) => a.order - b.order)) {
      if (effect.id === target) actionHp = effect.after;
    }
  }
  const kills: CandidateResult["kills"] = [];
  const addKills = (changes: HealthEffect[], source: "direct" | "collision") => {
    for (const effect of changes) {
      if (effect.before > 0 && effect.after === 0 && !kills.some(kill => kill.kind === effect.kind && kill.id === effect.id)) {
        kills.push({ kind: effect.kind, id: effect.id, source });
      }
    }
  };
  if (action && !action.fizzled) {
    addKills(action.effects ?? [], "direct");
    for (const { event } of shoves) addKills(event.effects ?? [], "collision");
  }
  const healing = !action || action.fizzled ? 0 : (action.effects ?? []).reduce((sum, effect) => sum + Math.max(0, effect.after - effect.before), 0);
  const end = preview.stages?.afterPrepare;
  const endHp = !end ? null : target === "boss" ? end.boss.hp
    : end.mechs.find((unit) => unit.id === target)?.hp ?? end.raiders.find((unit) => unit.id === target)?.hp
      ?? end.buildings.find((unit) => unit.id === target)?.hp ?? null;
  return { action, shoves, healing, kills, actionHp, endHp, enemyAttacks: preview.enemyOrder.length,
    buildings: preview.buildings.filter(building => building.startHp !== building.endHp).map(building => ({ ...building, cells: building.cells.map(cell => ({ ...cell })) })) };
}
