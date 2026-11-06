import { sporeLeapCells, sporeLeapReachable, occupant, livingBuildingAt, raiderAt, mech, emit, enemyStatsOf, STATS, RAIDER_DEF, BUILDING_DEF, orderedHealthEffect, type MatchState, type Intent, type Cell, type MechId, type Raider, type TurnEvent } from "./board";
import type { hurtMech, hurtRaider, strike, refresh } from "./combat";
type SporeCombatOps = { hurtMech: typeof hurtMech; hurtRaider: typeof hurtRaider; strike: typeof strike; refresh: typeof refresh };
type SporeEffect = { kind: "move"; from: Cell; to: Cell } | { kind: "damage"; target: "mech" | "building" | "raider"; id: string };

/** Reproject a declared landing against current authority state. */
export function projectSporeUnitPure(state: MatchState, source: Intent): Intent {
  const intent = structuredClone(source);
  if (intent.status === "void") return intent;
  const offset = intent.landingOffset;
  const target = offset && { x: state.boss.anchor.x + offset.x, y: state.boss.anchor.y + offset.y };
  if (!target || state.boss.hp <= 0 || !sporeLeapReachable(state, target)) {
    intent.status = "void"; intent.projected = [];
  } else {
    intent.projected = sporeLeapCells(target); intent.status = "reprojected";
  }
  return intent;
}
export function projectSporeUnit(state: MatchState, intent: Intent): void {
  const projected = projectSporeUnitPure(state, intent);
  intent.status = projected.status;
  intent.projected = projected.projected;
}

/** Choose once from the bounded radius; the relative offset is the binding. */
export function declareSporeUnit(state: MatchState, objectiveGap: (state: MatchState, cell: Cell) => number): Intent {
  const start = state.boss.anchor;
  const candidates: Cell[] = [];
  for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
    const target = { x: start.x + dx, y: start.y + dy };
    if (sporeLeapReachable(state, target)) candidates.push(target);
  }
  candidates.sort((a, b) => objectiveGap(state, a) - objectiveGap(state, b) || a.x - b.x || a.y - b.y);
  const target = candidates[0];
  if (!target) return { skillId: "spore_leap", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
  const projected = sporeLeapCells(target);
  return { skillId: "spore_leap", landingOffset: { x: target.x - start.x, y: target.y - start.y },
    local: projected.map((c) => ({ x: c.x - start.x, y: c.y - start.y })), projected, cdSweep: state.boss.cdSweep, status: "planned" };
}


export function resolveSporeUnit(state: MatchState, intent: Intent, ops: SporeCombatOps): void {
  const { hurtMech, hurtRaider, strike, refresh } = ops;
  const offset = intent.landingOffset;
  if (intent.status === "void" || !offset) return;
  const effects: SporeEffect[] = [{ kind: "move", from: { ...state.boss.anchor },
    to: { x: state.boss.anchor.x + offset.x, y: state.boss.anchor.y + offset.y } }];
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
  let event: Extract<TurnEvent, { type: "enemy" }> | null = null;
  for (const effect of effects) {
    if (state.outcome) break;
    if (effect.kind === "move") {
      state.boss.anchor = { ...effect.to };
      emit({ type: "boss_move", from: effect.from, to: effect.to });
      event = { type: "enemy", actor: "boss", skill: "spore_leap", cells: intent.projected.map((c) => ({ ...c })), damage: 0 };
      emit(event);
      continue;
    }
    const target = effect.target === "mech" ? mech(state, effect.id as MechId)
      : effect.target === "raider" ? state.raiders.find((r) => r.id === effect.id && r.hp > 0)
      : state.buildings.find((b) => b.id === effect.id && b.hp > 0);
    if (!target || !event) continue;
    const before = target.hp;
    if (effect.target === "mech") hurtMech(state, effect.id as MechId, strike(enemyStatsOf(state).bossAtk, STATS[effect.id as MechId].def));
    else if (effect.target === "raider") hurtRaider(target as Raider, strike(enemyStatsOf(state).bossAtk, RAIDER_DEF));
    else target.hp = Math.max(0, target.hp - strike(enemyStatsOf(state).bossAtk, BUILDING_DEF));
    event.damage += before - target.hp;
    if (target.hp !== before) (event.effects ??= []).push(orderedHealthEffect({ kind: effect.target, id: effect.id, before, after: target.hp }));
    refresh(state);
  }
}


export const sporeUnit = { declare: declareSporeUnit, project: projectSporeUnit, resolve: resolveSporeUnit } as const;
