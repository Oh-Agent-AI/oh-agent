import { living, footprint, manh, displacementWorld, sporeLeapCells, prepareDisplacement, resolveDisplacement, reprojectDisplacement, emit, MECH_IDS, type MatchState, type Intent } from "./board";
import type { hurtMech, hurtRaider, strike, refresh } from "./combat";
import { ringUnit } from "./ringUnit";
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

function executeDisplacement(state: MatchState, intent: Intent, ops: CombatOps): void {
  if (intent.status === "void" || !intent.displacement || !intent.displacementProjection) return;
  const result = resolveDisplacement(displacementWorld(state), intent.displacement, intent.displacementProjection);
  if (result.status !== "resolved") { intent.status = "void"; intent.projected = []; return; }
  const skill = intent.skillId as "phase_swap" | "gravity_well";
  const moves = result.effects.filter(e => e.status === "move" && e.from && e.to)
    .map(e => ({ unit: e.entityId, from: { ...e.from! }, to: { ...e.to! } }));
  // The phase pair is applied together after validating the complete projection.
  for (const move of moves) {
    if (move.unit === "boss") state.boss.anchor = { ...move.to };
    else { const unit = state.mechs.find(m => `mech:${m.id}` === move.unit); if (unit) unit.pos = { ...move.to }; }
    if (skill === "gravity_well") emit({ type: "monster_displacement", skill, moves: [move] });
  }
  if (skill === "phase_swap") emit({ type: "monster_displacement", skill, moves });
  ringUnit.resolve(state, intent, ops);
}

export const phaseUnit = { declare: (s: MatchState) => displacementIntent(s, "phase_swap"), project, resolve: executeDisplacement };
export const gravityUnit = { declare: (s: MatchState) => displacementIntent(s, "gravity_well"), project, resolve: executeDisplacement };
