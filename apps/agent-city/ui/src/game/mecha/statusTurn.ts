import { emit, mech, orderedHealthEffect, type MatchState, type MechId } from "./board";
import { hurtMech, refresh } from "./combat";
import { finishEncounterStatusTurn } from "./statusEncounter";

/** Remove effects whose actor died, emitting the same authoritative removal events as the turn driver. */
export function removeDeadEncounterStatuses(state: MatchState): void {
  const ledger = state.statusEncounter;
  if (!ledger) return;
  const removed = ledger.statuses.filter(status => !mech(state, status.target as MechId));
  ledger.statuses = ledger.statuses.filter(status => mech(state, status.target as MechId));
  for (const status of removed) emit({ type: "status_effect", schema: "mecha-status-event:v1", event: { type: "status_removed", status } });
}

/** Apply deterministic player-end poison/burn ticks before enemy actions. Mutates only the supplied state. */
export function finishPlayerEncounterStatuses(state: MatchState): void {
  const ledger = state.statusEncounter;
  if (!ledger) return;
  // Status input order is not a gameplay tie-breaker.
  ledger.statuses.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
  const ids: MechId[] = ["Assault", "Gunner", "Support"];
  for (const id of ids) {
    if (state.outcome) break;
    if (!mech(state, id)) continue;
    const active = ledger.statuses.filter(status => status.target === id);
    for (const entry of active) {
      if (!mech(state, id) || state.outcome) break;
      const result = finishEncounterStatusTurn([entry], id);
      for (const event of result.events) {
        if (!mech(state, id) || state.outcome) break;
        if (event.type === "status_damage") {
          const unit = mech(state, id)!, before = unit.hp;
          hurtMech(state, id, event.amount);
          const effects = unit.hp !== before ? [orderedHealthEffect({ kind: "mech", id, before, after: unit.hp })] : [];
          emit({ type: "status_effect", schema: "mecha-status-event:v1", event, ...(effects.length ? { effects } : {}) });
          refresh(state);
          removeDeadEncounterStatuses(state);
        } else emit({ type: "status_effect", schema: "mecha-status-event:v1", event });
      }
      const index = ledger.statuses.indexOf(entry);
      if (index >= 0) ledger.statuses.splice(index, 1, ...result.statuses);
    }
  }
}
