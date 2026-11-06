/** Verify status ledger transitions. Geometry and presentation remain separate gates. */
import { BOARD, MECH_IDS, type MatchState, type PresentationStages, type TurnEvent } from "./board";
import { canonicalJson } from "./contracts/match";
import { statusBlocks, type Status, type StatusKind } from "./statusEffects";
import { applyEncounterHit, type StatusEncounterSkill } from "./statusEncounter";

type StatusLog = Extract<TurnEvent, { type: "status_effect" }>;
type Trigger = { target: string; source: string; kind: StatusKind; skill: StatusEncounterSkill };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const key = (s: Pick<Status, "target" | "source" | "kind">) => JSON.stringify([s.target, s.source, s.kind]);
const order = (items: readonly Status[]) => [...items].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const invalid = (reason: string) => ({ ok: false as const, reason });
const inside = (cell: { x: number; y: number }) => !!cell && Number.isSafeInteger(cell.x) && Number.isSafeInteger(cell.y) && cell.x >= 0 && cell.y >= 0 && cell.x < BOARD && cell.y < BOARD;

/**
 * Validates only ledger transitions and event causality. It deliberately does not
 * certify hit geometry, event chronology against movement, or visual output.
 */
export function verifyStatusLedger(before: MatchState, after: MatchState, events: readonly TurnEvent[], stages?: PresentationStages | null): { ok: true } | { ok: false; reason: string } {
  try {
    const start = before.statusEncounter, end = after.statusEncounter;
    if (!start || !end || start.schema !== "mecha-status-encounter:v1" || end.schema !== start.schema ||
        !Array.isArray(events) || !statusBlocks(start.statuses, "Assault") || !statusBlocks(end.statuses, "Assault")) return invalid("invalid_status_ledger");
    let ledger = structuredClone(start.statuses), pending: Trigger | null = null;
    let enemy: Extract<TurnEvent, { type: "enemy" }> | null = null;
    let boundarySeen = false;
    const damaged = new Set<string>(), advanced = new Set<string>();
    const sameLedger = (value: MatchState["statusEncounter"], statuses: readonly Status[]) =>
      !!value && value.schema === start.schema && same(order(value.statuses), order(statuses));
    if (stages && (!sameLedger(stages.before.statusEncounter, start.statuses) || !sameLedger(stages.afterMovement.statusEncounter, start.statuses))) return invalid("status_stage_mismatch");
    for (const entry of events) {
      if (!entry || typeof entry !== "object") return invalid("invalid_event");
      if (pending && !(entry.type === "status_effect" && (entry.event.type === "status_applied" || entry.event.type === "status_refreshed"))) return invalid("missing_status_application");
      if (entry.type === "status_boundary") {
        if (entry.schema !== "mecha-status-event:v1" || entry.phase !== "player_end" || boundarySeen || damaged.size ||
            (stages && !sameLedger(stages.afterPlayer.statusEncounter, ledger))) return invalid("status_stage_mismatch");
        boundarySeen = true; continue;
      }
      if (entry.type === "enemy") { if (!boundarySeen) return invalid("missing_status_boundary"); enemy = entry; continue; }
      if (entry.type === "status_hit") {
        if (!boundarySeen) return invalid("missing_status_boundary");
        const kind = entry.skill === "spore_leap" ? "poison" : entry.skill === "ring_pierce" ? "burn" : entry.skill === "prism_frost" ? "freeze" : null;
        if (entry.schema !== "mecha-status-hit:v1" || !kind || entry.source !== "boss" || !MECH_IDS.includes(entry.target) || !inside(entry.cell) ||
            !enemy || enemy.actor !== entry.source || enemy.skill !== entry.skill || !enemy.cells.some(c => c.x === entry.cell.x && c.y === entry.cell.y)) return invalid("invalid_status_hit");
        pending = { target: entry.target, source: entry.source, kind, skill: entry.skill }; continue;
      }
      if (entry.type === "gravity_collision") {
        if (!boundarySeen) return invalid("missing_status_boundary");
        if (entry.schema !== "mecha-gravity-collision:v1" || !MECH_IDS.includes(entry.target) || !inside(entry.cell) ||
            !entry.blocker || !["boss", "mech", "raider", "building", "obstacle"].includes(entry.blocker.kind) ||
            typeof entry.blocker.id !== "string" || !entry.blocker.id || entry.blocker.id.length > 128) return invalid("invalid_collision_evidence");
        pending = { target: entry.target, source: "boss", kind: "stun", skill: "gravity_collision" }; continue;
      }
      if (entry.type !== "status_effect") continue;
      if (entry.schema !== "mecha-status-event:v1" || !entry.event) return invalid("invalid_status_event");
      const event = entry.event;
      if (event.type === "status_applied" || event.type === "status_refreshed") {
        if (!pending || event.status.target !== pending.target || event.status.source !== pending.source || event.status.kind !== pending.kind) return invalid("status_trigger_mismatch");
        const result = applyEncounterHit(ledger, { skill: pending.skill, target: pending.target, source: pending.source, hit: true, targetAlive: true });
        if (result.events[0]?.type !== event.type || !same(result.events[0], event) || entry.effects !== undefined) return invalid("invalid_status_application");
        ledger = result.statuses; pending = null; continue;
      }
      if (event.type === "status_damage") {
        if (boundarySeen) return invalid("status_tick_after_boundary");
        const id = key(event), current = ledger.find(s => key(s) === id), effects = (entry as StatusLog).effects;
        if (!current || (current.kind !== "poison" && current.kind !== "burn") || current.magnitude <= 0 || event.amount !== current.magnitude || damaged.has(id) ||
            !Array.isArray(effects) || effects.length !== 1 || effects[0]!.kind !== "mech" || effects[0]!.id !== event.target ||
            !Number.isSafeInteger(effects[0]!.before) || effects[0]!.before <= 0 || effects[0]!.after !== Math.max(0, effects[0]!.before - event.amount)) return invalid("invalid_status_damage");
        damaged.add(id); continue;
      }
      const id = key(event.status), index = ledger.findIndex(s => key(s) === id), current = ledger[index];
      if (!current || entry.effects !== undefined) return invalid("unknown_status_instance");
      if (event.type === "status_advanced" || event.type === "status_expired") {
        if (boundarySeen) return invalid("status_tick_after_boundary");
        if (advanced.has(id)) return invalid("status_ticked_twice");
        if ((current.kind === "poison" || current.kind === "burn") && current.magnitude > 0 && !damaged.has(id)) return invalid("missing_status_damage");
        if (event.type === "status_advanced") {
          if (current.remainingTurns <= 1 || !same(event.status, { ...current, remainingTurns: current.remainingTurns - 1 })) return invalid("invalid_status_advance");
          ledger[index] = structuredClone(event.status);
        } else {
          if (current.remainingTurns !== 1 || !same(event.status, current)) return invalid("invalid_status_expiry");
          ledger.splice(index, 1);
        }
        damaged.delete(id); advanced.add(id);
      } else if (event.type === "status_removed") {
        if (!same(event.status, current) || after.mechs.find(m => m.id === current.target)?.hp !== 0) return invalid("invalid_status_removal");
        ledger.splice(index, 1); damaged.delete(id);
      } else return invalid("invalid_status_event");
    }
    if (!boundarySeen && (before.turn !== after.turn || advanced.size)) return invalid("missing_status_boundary");
    if (pending || damaged.size || !same(order(ledger), order(end.statuses))) return invalid("status_ledger_mismatch");
    if (stages && ((!boundarySeen && !sameLedger(stages.afterPlayer.statusEncounter, ledger)) ||
        !sameLedger(stages.afterEnemy.statusEncounter, ledger) || !sameLedger(stages.afterPrepare.statusEncounter, ledger))) return invalid("status_stage_mismatch");
    return { ok: true };
  } catch { return invalid("invalid_status_evidence"); }
}
