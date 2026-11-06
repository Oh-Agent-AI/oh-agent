import { living, footprint, manh, displacementWorld, sporeLeapCells, prepareDisplacement, resolveDisplacement, reprojectDisplacement, emit, MECH_IDS, eq, livingBuildingAt, occupant, raiderAt, type MatchState, type Intent, type MechId, type DisplacementEffect, type TurnEvent } from "./board";
import type { hurtMech, hurtRaider, strike, refresh } from "./combat";
import { ringUnit } from "./ringUnit";
import { applyConfirmedStatusHit } from "./statusBattle";
type CombatOps = { hurtMech: typeof hurtMech; hurtRaider: typeof hurtRaider; strike: typeof strike; refresh: typeof refresh };
function displacementIntent(state: MatchState, skillId: "phase_swap" | "gravity_well"): Intent {
  const origin = state.boss.anchor;
  const candidates = living(state).slice().sort((a, b) =>
    Math.min(...footprint(origin).map(c => manh(c, a.pos))) - Math.min(...footprint(origin).map(c => manh(c, b.pos))) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const world = displacementWorld(state);
  const groups = skillId === "phase_swap" ? candidates.map(m => [m]) : [candidates];
  for (const targets of groups) {
    if (!targets.length) continue;
    const anchor = skillId === "phase_swap" ? targets[0]!.pos : origin;
    const attackOffsets = sporeLeapCells(anchor).map(c => ({ x: c.x - anchor.x, y: c.y - anchor.y }));
    const result = prepareDisplacement(world, { skillId, actorId: "boss", targetIds: targets.map(m => `mech:${m.id}`),
      radius: skillId === "phase_swap" ? 5 : 3, steps: 1, attackOffsets });
    if (result.status === "planned") return { skillId, displacement: result.intent, displacementProjection: result.intent.declared,
      local: [], projected: result.intent.declared.attackCells.map(c => ({ ...c })), cdSweep: state.boss.cdSweep, status: "planned" };
  }
  return { skillId, local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
}

function project(state: MatchState, intent: Intent): void {
    if (intent.status === "void") return;
    const binding = intent.displacement;
    const request = binding?.request;
    const perimeter = new Set(["-1,0", "-1,1", "0,-1", "1,-1", "2,0", "2,1", "0,2", "1,2"]);
    if (!request || request.skillId !== intent.skillId || request.actorId !== "boss" ||
        request.radius !== (intent.skillId === "phase_swap" ? 5 : 3) || request.steps !== 1 ||
        !Array.isArray(request.targetIds) || request.targetIds.length > 3 ||
        request.targetIds.some(id => !MECH_IDS.some(m => id === `mech:${m}`)) ||
        !Array.isArray(request.attackOffsets) || !request.attackOffsets.length || request.attackOffsets.length > 8 ||
        request.attackOffsets.some(c => !c || !perimeter.has(`${c.x},${c.y}`)) ||
        new Set(request.attackOffsets.map(c => `${c.x},${c.y}`)).size !== request.attackOffsets.length) {
      intent.status = "void"; intent.projected = []; return;
    }
    const projection = reprojectDisplacement(displacementWorld(state), binding!);
    intent.displacementProjection = projection;
    intent.projected = projection.attackCells.map(c => ({ ...c }));
    intent.status = projection.status;
    return;
  }

function gravityCollision(state: MatchState, effect: DisplacementEffect): Extract<TurnEvent, { type: "gravity_collision" }> | null {
  if (!state.statusEncounter || effect.status !== "void" || !effect.collision || !effect.path.length || !effect.entityId.startsWith("mech:")) return null;
  const target = effect.entityId.slice(5) as MechId, cell = effect.path[effect.path.length - 1]!;
  if (!eq(cell, effect.collision.cell) || !MECH_IDS.includes(target) || !state.mechs.some(m => m.id === target && m.hp > 0 && effect.from && eq(m.pos, effect.from))) return null;
  let blocker: Extract<TurnEvent, { type: "gravity_collision" }>["blocker"] | null = null;
  if (effect.reason === "obstacle") {
    const building = livingBuildingAt(state, cell);
    if (building) blocker = { kind: "building", id: building.id };
    else if (state.obstacles.some(c => eq(c, cell)) || state.covers.some(c => eq(c, cell))) blocker = { kind: "obstacle", id: `${cell.x},${cell.y}` };
  } else if (effect.reason === "occupied") {
    const occupied = occupant(state, cell);
    if (occupied === "boss") blocker = { kind: "boss", id: "boss" };
    else if (occupied === "raider") { const raider = raiderAt(state, cell); if (raider) blocker = { kind: "raider", id: raider.id }; }
    else if (MECH_IDS.some(id => id === occupied)) blocker = { kind: "mech", id: occupied };
  }
  return blocker && blocker.kind === effect.collision.blocker.kind && blocker.id === effect.collision.blocker.id
    ? { type: "gravity_collision", schema: "mecha-gravity-collision:v1", target, cell: { ...cell }, blocker } : null;
}

function executeDisplacement(state: MatchState, intent: Intent, ops: CombatOps): void {
  if (intent.status === "void" || !intent.displacement || !intent.displacementProjection) return;
  const result = resolveDisplacement(displacementWorld(state), intent.displacement, intent.displacementProjection);
  if (result.status !== "resolved") { intent.status = "void"; intent.projected = []; return; }
  const skill = intent.skillId as "phase_swap" | "gravity_well";
  const moves = result.effects.filter(e => e.status === "move" && e.from && e.to)
    .map(e => ({ unit: e.entityId, from: { ...e.from! }, to: { ...e.to! } }));
  // Gravity applies each verified result in order so collision identity sees prior moves.
  if (skill === "gravity_well") for (const effect of result.effects) {
    if (effect.status === "move" && effect.from && effect.to) {
      const unit = state.mechs.find(m => `mech:${m.id}` === effect.entityId);
      if (unit) { unit.pos = { ...effect.to }; emit({ type: "monster_displacement", skill, moves: [{ unit: effect.entityId, from: { ...effect.from }, to: { ...effect.to } }] }); }
    } else {
      const collision = gravityCollision(state, effect);
      if (collision) { emit(collision); applyConfirmedStatusHit(state, "gravity_collision", collision.target); }
    }
  }
  // The phase pair is applied together after validating the complete projection.
  if (skill === "phase_swap") for (const move of moves) {
    if (move.unit === "boss") state.boss.anchor = { ...move.to };
    else { const unit = state.mechs.find(m => `mech:${m.id}` === move.unit); if (unit) unit.pos = { ...move.to }; }
  }
  if (skill === "phase_swap") emit({ type: "monster_displacement", skill, moves });
  ringUnit.resolve(state, intent, ops);
}

export const phaseUnit = { declare: (s: MatchState) => displacementIntent(s, "phase_swap"), project, resolve: executeDisplacement };
export const gravityUnit = { declare: (s: MatchState) => displacementIntent(s, "gravity_well"), project, resolve: executeDisplacement };
