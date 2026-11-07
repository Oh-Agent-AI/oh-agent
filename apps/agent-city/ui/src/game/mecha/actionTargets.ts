import { footprint, living, type Action, type Cell, type MatchState, type MechId } from "./board";
import { bindActionTarget } from "./combat";

export type TargetOption = { id: string; cells: Cell[] };
type SequentialTarget = TargetOption & { actionIndex: number };

/** Project target identities on the board used by the caller's action rules. */
export function boardActionTargets(state: MatchState, kind: Action["kind"], actor: MechId): TargetOption[] {
  if (kind === "skip") return [];
  if (kind === "repair") return living(state).filter(unit => unit.id !== actor)
    .map(unit => ({ id: unit.id, cells: [{ ...unit.pos }] }));
  return [
    ...(state.boss.hp > 0 ? [{ id: "boss", cells: footprint(state.boss.anchor) }] : []),
    ...state.raiders.filter(unit => unit.hp > 0).map(unit => ({ id: unit.id, cells: [{ ...unit.pos }] })),
  ];
}

/** Keep the existing action ordering after binding each legal action to its target. */
export function sequentialTargets(state: MatchState, actions: readonly Action[], kind: Action["kind"] | null, actor: MechId): SequentialTarget[] {
  if (!kind || kind === "skip") return [];
  const targets = boardActionTargets(state, kind, actor);
  return actions.flatMap((action, actionIndex) => {
    if (action.kind !== kind) return [];
    const bound = bindActionTarget(state, actor, action);
    const target = "target" in bound ? targets.find(option => option.id === bound.target) : undefined;
    return target ? [{ ...target, actionIndex }] : [];
  });
}
