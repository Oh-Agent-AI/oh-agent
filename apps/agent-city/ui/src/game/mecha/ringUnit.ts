import { applyDamage } from "./skillEffects";
import { applyConfirmedStatusHit } from "./statusBattle";
import { living, livingStakeBuildings, STEP_DIRS, ringPierceCells, eq, manh, occupant, livingBuildingAt, raiderAt, mech, emit, enemyStatsOf, STATS, RAIDER_DEF, BUILDING_DEF, orderedHealthEffect, type MatchState, type Intent, type Cell, type MechId, type Raider, type TurnEvent } from "./board";
import type { hurtMech, hurtRaider, strike, refresh } from "./combat";
type CombatOps = { hurtMech: typeof hurtMech; hurtRaider: typeof hurtRaider; strike: typeof strike; refresh: typeof refresh };
function declare(state: MatchState): Intent {
  const goals = [...living(state).map((m) => m.pos), ...livingStakeBuildings(state).flatMap((b) => b.cells)];
  const choices: Array<{ direction: Cell; lane: 0 | 1; cells: Cell[]; hits: number; gap: number }> = [];
  for (const direction of STEP_DIRS) for (const lane of [0, 1] as const) {
    const cells = ringPierceCells(state, state.boss.anchor, direction, lane);
    if (!cells.length) continue;
    const hits = goals.filter((g) => cells.some((c) => eq(c, g))).length;
    const gap = goals.length ? Math.min(...goals.flatMap((g) => cells.map((c) => manh(c, g)))) : 0;
    choices.push({ direction, lane, cells, hits, gap });
  }
  choices.sort((a, b) => b.hits - a.hits || a.gap - b.gap);
  const choice = choices[0];
  if (!choice) return { skillId: "ring_pierce", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
  return { skillId: "ring_pierce", direction: { ...choice.direction }, lane: choice.lane,
    local: choice.cells.map((c) => ({ x: c.x - state.boss.anchor.x, y: c.y - state.boss.anchor.y })),
    projected: choice.cells, cdSweep: state.boss.cdSweep, status: "planned" };
}
function project(state: MatchState, intent: Intent): void {
    if (intent.status === "void") return;
    const cells = intent.direction && intent.lane !== undefined ? ringPierceCells(state, state.boss.anchor, intent.direction, intent.lane) : [];
    intent.projected = cells;
    intent.status = state.boss.hp > 0 && cells.length ? "reprojected" : "void";
    return;
}
function resolve(state: MatchState, intent: Intent, ops: CombatOps): void {
  const { hurtMech, hurtRaider, strike, refresh } = ops;
  if (intent.status === "void") return;
  const effects: Array<{ kind: "damage"; target: "mech" | "building" | "raider"; id: string }> = [];
  const seen = new Set<string>();
  for (const cell of intent.projected) {
    const occ = occupant(state, cell);
    const target = occ === "building" ? { target: "building" as const, id: livingBuildingAt(state, cell)?.id }
      : occ === "raider" ? { target: "raider" as const, id: raiderAt(state, cell)?.id }
      : occ === "Assault" || occ === "Gunner" || occ === "Support" ? { target: "mech" as const, id: occ } : null;
    if (!target?.id || seen.has(`${target.target}:${target.id}`)) continue;
    seen.add(`${target.target}:${target.id}`);
    effects.push({ kind: "damage", target: target.target, id: target.id });
  }
  const event: Extract<TurnEvent, { type: "enemy" }> = { type: "enemy", actor: "boss", skill: intent.skillId, cells: intent.projected.map((c) => ({ ...c })), damage: 0 };
  emit(event);
  for (const effect of effects) {
    if (state.outcome) break;
    const target = effect.target === "mech" ? mech(state, effect.id as MechId)
      : effect.target === "raider" ? state.raiders.find((r) => r.id === effect.id && r.hp > 0)
      : state.buildings.find((b) => b.id === effect.id && b.hp > 0);
    if (!target) continue;
    const before = target.hp;
    if (effect.target === "mech") hurtMech(state, effect.id as MechId, strike(enemyStatsOf(state).bossAtk, STATS[effect.id as MechId].def));
    else if (effect.target === "raider") hurtRaider(target as Raider, strike(enemyStatsOf(state).bossAtk, RAIDER_DEF));
    else target.hp = applyDamage(target.hp, strike(enemyStatsOf(state).bossAtk, BUILDING_DEF));
    event.damage += before - target.hp;
    if (target.hp !== before) (event.effects ??= []).push(orderedHealthEffect({ kind: effect.target, id: effect.id, before, after: target.hp }));
    refresh(state);
    if (effect.target === "mech" && intent.skillId === "ring_pierce") applyConfirmedStatusHit(state, "ring_pierce", effect.id as MechId);
  }
}
export const ringUnit = { declare, project, resolve } as const;
