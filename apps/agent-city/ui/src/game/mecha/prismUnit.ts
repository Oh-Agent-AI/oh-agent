import { emit, enemyStatsOf, eq, mech, occupant, orderedHealthEffect, ringPierceCells, STEP_DIRS, STATS, type Cell, type Intent, type MatchState, type MechId, type TurnEvent } from "./board";
import type { CombatOps } from "./unitRegistry";
import { applyConfirmedStatusHit } from "./statusBattle";

/** Experimental v1: four cells, normal boss attack damage, no separate cooldown. */
export const PRISM_FROST_RANGE = 4;
function frostCells(state: MatchState, direction: Cell, lane: 0 | 1): Cell[] {
  return ringPierceCells(state, state.boss.anchor, direction, lane).slice(0, PRISM_FROST_RANGE);
}
function guard(state: MatchState): Intent {
  return { skillId: "prism_guard", targetId: "boss", shieldHits: 1, local: [], projected: [],
    cdSweep: state.boss.cdSweep, status: "planned" };
}

export const prismUnit = {
  declare(state: MatchState): Intent {
    if (state.ruleset !== "mecha-v1.5" || !state.statusEncounter || state.turn % 2 === 0) return guard(state);
    const choices: Array<{ direction: Cell; lane: 0 | 1; cells: Cell[]; index: number }> = [];
    for (const direction of STEP_DIRS) for (const lane of [0, 1] as const) {
      const cells = frostCells(state, direction, lane);
      const index = cells.findIndex(cell => state.mechs.some(m => m.hp > 0 && eq(m.pos, cell)));
      if (index >= 0) choices.push({ direction, lane, cells, index });
    }
    choices.sort((a, b) => a.index - b.index);
    const chosen = choices[0];
    if (!chosen) return guard(state);
    return { skillId: "prism_frost", direction: { ...chosen.direction }, lane: chosen.lane,
      local: chosen.cells.map(c => ({ x: c.x - state.boss.anchor.x, y: c.y - state.boss.anchor.y })),
      projected: chosen.cells, cdSweep: state.boss.cdSweep, status: "planned" };
  },
  project(state: MatchState, intent: Intent): void {
    if (intent.status === "void") return;
    if (intent.skillId === "prism_frost") {
      const direction = intent.direction, lane = intent.lane;
      if (state.ruleset !== "mecha-v1.5" || !state.statusEncounter || state.boss.hp <= 0 || !direction ||
          !((Math.abs(direction.x) === 1 && direction.y === 0) || (Math.abs(direction.y) === 1 && direction.x === 0)) || (lane !== 0 && lane !== 1)) {
        intent.status = "void"; intent.projected = []; return;
      }
      intent.projected = frostCells(state, direction, lane);
      intent.status = intent.projected.length ? "reprojected" : "void";
    } else if (state.boss.hp <= 0 || intent.targetId !== "boss" || intent.shieldHits !== 1) {
      intent.status = "void"; intent.projected = [];
    } else { intent.status = "reprojected"; intent.projected = []; }
  },
  resolve(state: MatchState, intent: Intent, ops: CombatOps): void {
    if (intent.status === "void") return;
    if (intent.skillId === "prism_frost") {
      const event: Extract<TurnEvent, { type: "enemy" }> = { type: "enemy", actor: "boss", skill: "prism_frost", cells: intent.projected.map(c => ({ ...c })), damage: 0 };
      emit(event);
      for (const cell of intent.projected) {
        const id = occupant(state, cell);
        if (id !== "Assault" && id !== "Gunner" && id !== "Support") continue;
        const unit = mech(state, id as MechId);
        if (!unit) continue;
        const before = unit.hp;
        ops.hurtMech(state, id, ops.strike(enemyStatsOf(state).bossAtk, STATS[id].def));
        event.damage = before - unit.hp;
        if (unit.hp !== before) event.effects = [orderedHealthEffect({ kind: "mech", id, before, after: unit.hp })];
        ops.refresh(state);
        applyConfirmedStatusHit(state, "prism_frost", id);
        break;
      }
    } else {
      state.boss.shield = { kind: "prism_guard", hits: 1 };
      emit({ type: "monster_status", actor: "boss", status: "prism_guard", change: "applied", remaining: 1 });
    }
  },
};
