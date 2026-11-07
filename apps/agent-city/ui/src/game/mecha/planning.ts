/** Shared draft mechanics. Rule authorities remain responsible for legality. */
import { living, type Action, type ArenaPlan, type Cell, type MatchState, type MechId, type PlanFault } from "./rules";

export type Draft = { moveTo: Cell | null; action: Action; explicit: boolean };
export type DraftMap = Record<MechId, Draft>;

export function blankDraft(state?: MatchState): DraftMap {
  return {
    Assault: { moveTo: null, action: { kind: "skip" }, explicit: false },
    Gunner: { moveTo: null, action: { kind: "skip" }, explicit: false },
    Support: { moveTo: null, action: { kind: "skip" }, explicit: false },
    ...(state ? Object.fromEntries(living(state).map((m) => [m.id, { moveTo: null, action: { kind: "skip" as const }, explicit: false }])) : {}),
  } as DraftMap;
}

export function draftFromPlan(state: MatchState, plan: ArenaPlan): DraftMap {
  const next = blankDraft(state);
  for (const item of plan.items) next[item.mechId] = { moveTo: item.moveTo, action: item.action, explicit: true };
  return next;
}

/**
 * Include living PvE units in rules order, retaining every drafted move. By
 * default implicit actions wait; `movement` makes every unit hold, and `only`
 * tests one proposed action.
 */
export type DraftActions = "explicit" | "movement" | { only: { id: MechId; action: Action } };
export function draftPlan(state: MatchState, drafts: DraftMap, actions: DraftActions = "explicit"): ArenaPlan {
  return {
    revision: state.revision,
    items: living(state).map((m) => ({
      mechId: m.id,
      moveTo: drafts[m.id]?.moveTo ?? null,
      action: typeof actions === "object"
        ? (m.id === actions.only.id ? actions.only.action : { kind: "skip" as const })
        : actions === "movement" ? { kind: "skip" as const }
        : drafts[m.id]?.explicit ? (drafts[m.id]?.action ?? { kind: "skip" as const })
        : { kind: "skip" as const },
    })),
  };
}

/**
 * Optimistic position projection only: this does not validate moves. Callers
 * that require a validated board must first preflight the movement-only plan.
 */
export function settledDraftBoard(state: MatchState, drafts: DraftMap): MatchState {
  const scratch = structuredClone(state);
  for (const m of scratch.mechs) {
    const dest = m.hp > 0 ? drafts[m.id]?.moveTo : null;
    if (dest) m.pos = { ...dest };
  }
  return scratch;
}

export type DraftCheck = { status: "ok" } | { status: "rejected"; fault: PlanFault } | { status: "unknown" };
/**
 * Adapt the relevant local or PvE rules authority at the call site.
 * The adapter owns isolation: clone mutable inputs and restore any shared event
 * sink if its authority has side effects. This helper only catches exceptions.
 */
export type DraftAuthority = (plan: ArenaPlan) => { ok: true } | { ok: false; fault: PlanFault };

export function checkDraftPlan(plan: ArenaPlan, authority: DraftAuthority): DraftCheck {
  try {
    const result = authority(plan);
    return result.ok ? { status: "ok" } : { status: "rejected", fault: result.fault };
  } catch {
    return { status: "unknown" };
  }
}

/** Check one action with all moves present and every other action held. */
export function checkDraftAction(state: MatchState, drafts: DraftMap, id: MechId, action: Action, authority: DraftAuthority): DraftCheck {
  try {
    return checkDraftPlan(draftPlan(state, drafts, { only: { id, action } }), authority);
  } catch {
    return { status: "unknown" };
  }
}
