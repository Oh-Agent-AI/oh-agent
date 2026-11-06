import { emit, mech, type MatchState, type MechId } from "./board";
import { applyEncounterHit, STATUS_ENCOUNTER_VERSION, type StatusEncounterSkill } from "./statusEncounter";

/** Called by a skill resolver after it has resolved a real hit and its damage. */
export function applyConfirmedStatusHit(state: MatchState, skill: StatusEncounterSkill, target: MechId): void {
  const ledger = state.statusEncounter;
  if (!ledger) return;
  const species = skill === "spore_leap" ? "spore_leaper" : skill === "ring_pierce" ? "flux_lancer" : skill === "prism_frost" ? "prism_warden" : "gravity_core";
  if (state.ruleset !== "mecha-v1.5" || ledger.schema !== STATUS_ENCOUNTER_VERSION || state.monsterContent?.speciesId !== species) throw new Error("invalid_status_encounter");
  const hit = applyEncounterHit(ledger.statuses, { skill, source: "boss", target, hit: true, targetAlive: Boolean(mech(state, target)) });
  const unit = mech(state, target);
  if (unit && skill !== "gravity_collision")
    emit({ type: "status_hit", schema: "mecha-status-hit:v1", skill, source: "boss", target, cell: { ...unit.pos } });
  ledger.statuses = hit.statuses;
  for (const event of hit.events) emit({ type: "status_effect", schema: "mecha-status-event:v1", event });
}
