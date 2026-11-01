/** Read a candidate's effects from the authoritative whole-turn simulation. */
import type { PlanPreview, Cell, MechId, TurnEvent } from "./rules";

type ReadyPreview = Extract<PlanPreview, { ok: true }>;
type Act = Extract<TurnEvent, { type: "act" }>;
type Shove = Extract<TurnEvent, { type: "shove" }>;
export type CandidateResult = {
  action: Act | null;
  shoves: Array<{ event: Shove; from: Cell | null; to: Cell | null }>;
  /** HP after all player and enemy actions, not damage attributable to this action. */
  endHp: number | null;
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
  for (let i = 0; i < preview.log.length; i += 1) {
    const event = preview.log[i]!;
    if (event.type === "act") withinAction = i === index;
    else if (event.type === "enemy" || event.type === "outcome") withinAction = false;
    if (event.type !== "shove") continue;
    const from = positions.get(event.unit) ?? null;
    const to = from ? (event.hit ? { ...from } : { x: from.x + event.dir.x, y: from.y + event.dir.y }) : null;
    if (to) positions.set(event.unit, to);
    if (withinAction) shoves.push({ event, from, to });
  }
  const end = preview.stages?.afterPrepare;
  const endHp = !end ? null : target === "boss" ? end.boss.hp
    : end.mechs.find((unit) => unit.id === target)?.hp ?? end.raiders.find((unit) => unit.id === target)?.hp ?? null;
  return { action, shoves, endHp };
}
