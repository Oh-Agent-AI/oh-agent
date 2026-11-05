import type { Cell, Intent, MatchState } from "./board";
import type { hurtMech, hurtRaider, strike, refresh } from "./combat";
import { sporeUnit } from "./sporeUnitProjection";
import { corrodeUnit } from "./corrodeUnit";
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
};
const skills: Record<string, UnitHandler> = { spore_leap: sporeUnit, ring_pierce: ringUnit, corrode_cell: corrodeUnit };
export function unitForSpecies(id: string | undefined): UnitHandler | undefined { return id && Object.hasOwn(units, id) ? units[id] : undefined; }
export function unitForSkill(id: string): UnitHandler | undefined { return Object.hasOwn(skills, id) ? skills[id] : undefined; }
