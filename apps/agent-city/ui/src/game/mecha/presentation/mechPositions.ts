/** Actual actors and uncommitted destinations are separate scene projections. */
import type { Cell, MatchState, MechId } from "../board";
import type { DeployPlacement } from "../deployment";
import type { InspectionDraft } from "../cellInspection";

export function projectMechPositions(state: MatchState, placements: readonly DeployPlacement[] | null = null) {
  return state.mechs.flatMap(mech => {
    const pos = state.phase === "deployment" ? placements?.find(p => p.mechId === mech.id)?.pos : mech.pos;
    return pos ? [{ ...mech, pos: { ...pos } }] : [];
  });
}

export type PlannedMechMove = { id: MechId; from: Cell; to: Cell };
export function projectPlannedMoves(state: MatchState, draft: InspectionDraft = {}): PlannedMechMove[] {
  if (state.phase !== "player_plan" || state.outcome) return [];
  return state.mechs.flatMap(mech => {
    const to = draft[mech.id]?.moveTo;
    return mech.hp > 0 && to && (to.x !== mech.pos.x || to.y !== mech.pos.y)
      ? [{ id: mech.id, from: { ...mech.pos }, to: { ...to } }] : [];
  });
}
