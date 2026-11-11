import { living, validateAndApplyPlan, type MechId, type MatchState } from "../game/mecha/rules";
import { checkDraftAction, checkDraftPlan, draftPlan, settledDraftBoard, type DraftAuthority, type DraftCheck, type DraftMap } from "../game/mecha/planning";
import { swapEventSink } from "../game/mecha/board";

// Transport/mode adapter: legality remains with the same authoritative rules
// used by the host. Planning mechanics themselves are shared with City.
function remoteAuthority(remote: MatchState): DraftAuthority {
  return (plan) => {
    // PvE validation emits into a shared sink, even on rejection. A preflight
    // must not contaminate an enclosing turn log and must restore on exceptions.
    const outer = swapEventSink(null);
    try {
      const result = validateAndApplyPlan(structuredClone(remote), plan);
      return "ok" in result ? { ok: true } : { ok: false, fault: result };
    } finally {
      swapEventSink(outer);
    }
  };
}

export function remoteDraftProjection(state: MatchState, draft: DraftMap) {
  try {
    const authority = remoteAuthority(state);
    const movement = checkDraftPlan(draftPlan(state, draft, "movement"), authority);
    if (movement.status !== "ok") return { movement, state: null, invalid: [] as MechId[], actionUnknown: false, plan: movement };
    const projected = settledDraftBoard(state, draft);
    const checks = living(state).filter((mech) => draft[mech.id].explicit)
      .map((mech) => ({ id: mech.id, result: checkDraftAction(state, draft, mech.id, draft[mech.id].action, authority) }));
    const invalid = checks.filter(({ result }) => result.status === "rejected").map(({ id }) => id);
    const actionUnknown = checks.some(({ result }) => result.status === "unknown");
    const plan = checkDraftPlan(draftPlan(state, draft), authority);
    return { movement, state: projected, invalid, actionUnknown, plan };
  } catch {
    const unknown: DraftCheck = { status: "unknown" };
    return { movement: unknown, state: null, invalid: [] as MechId[], actionUnknown: false, plan: unknown };
  }
}

