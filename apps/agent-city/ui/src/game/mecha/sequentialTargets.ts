/** Board targets for a selected action kind, projected only from legal actions. */
import { STATS, footprint, mech, type Action, type Cell, type MatchState, type MechId } from "./board";
import { meleeTargets, shotTargets } from "./combat";
export type SequentialTarget = { actionIndex: number; id: string; cells: Cell[] };
export function sequentialTargets(state: MatchState, actions: readonly Action[], kind: Action["kind"] | null, selected: MechId): SequentialTarget[] {
  if (!kind || kind === "skip") return [];
  return actions.flatMap((action, actionIndex) => {
    if (action.kind !== kind) return [];
    const actor = mech(state, selected);
    const candidates = !action.target && actor && action.kind !== "repair" ? action.kind === "melee" || action.kind === "charge"
      ? meleeTargets(state, actor.pos) : shotTargets(state, actor.pos, STATS[selected].shoot, action.kind === "pierce" ? 1 : 0) : [];
    const id = action.target ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!id) return [];
    if (id === "boss") return state.boss.hp > 0 ? [{ actionIndex, id, cells: footprint(state.boss.anchor) }] : [];
    const unit = action.kind === "repair" ? state.mechs.find(mech => mech.id === id && mech.hp > 0) : state.raiders.find(raider => raider.id === id && raider.hp > 0);
    return unit ? [{ actionIndex, id, cells: [{ ...unit.pos }] }] : [];
  });
}
