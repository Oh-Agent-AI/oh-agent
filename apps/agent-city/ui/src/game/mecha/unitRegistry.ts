import type { Cell, Intent, MatchState } from "./board";
import type { hurtMech, hurtRaider, strike, refresh } from "./combat";
import { sporeUnit } from "./sporeUnitProjection";
import { corrodeUnit } from "./corrodeUnit";
import { prismUnit } from "./prismUnit";
import { neuralUnit } from "./neuralUnit";
import { swarmUnit } from "./swarmUnit";
import { phaseUnit, gravityUnit } from "./displacementUnit";
import { ringUnit } from "./ringUnit";

type CombatOps = { hurtMech: typeof hurtMech; hurtRaider: typeof hurtRaider; strike: typeof strike; refresh: typeof refresh };
export type UnitHandler = {
  declare(state: MatchState, objectiveGap: (state: MatchState, cell: Cell) => number): Intent;
  project(state: MatchState, intent: Intent): void;
  resolve(state: MatchState, intent: Intent, ops: CombatOps): void;
};
const units: Record<string, UnitHandler> = {
  spore_leaper: sporeUnit,
  flux_lancer: ringUnit,
  porous_shaper: corrodeUnit,
  prism_warden: prismUnit,
  swarm_mantle: swarmUnit, neural_weaver: neuralUnit,
  phase_stalker: phaseUnit, gravity_core: gravityUnit,
};
const skills: Record<string, UnitHandler> = { spore_leap: sporeUnit, ring_pierce: ringUnit, corrode_cell: corrodeUnit, prism_guard: prismUnit, split_swarm: swarmUnit, neural_link: neuralUnit, phase_swap: phaseUnit, gravity_well: gravityUnit };
export function unitForSpecies(id: string | undefined): UnitHandler | undefined { return id && Object.hasOwn(units, id) ? units[id] : undefined; }
export function unitForSkill(id: string): UnitHandler | undefined { return Object.hasOwn(skills, id) ? skills[id] : undefined; }

/** Project against an isolated snapshot; the caller decides whether to apply the result. */
export function projectUnitPure(unit: UnitHandler, state: MatchState, intent: Intent): Intent {
  const copy = structuredClone({ state, intent });
  unit.project(copy.state, copy.intent);
  return copy.intent;
}
