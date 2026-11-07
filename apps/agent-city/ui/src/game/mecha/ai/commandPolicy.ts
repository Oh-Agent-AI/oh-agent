import { MECH_IDS, manh, mech, moveBudget, occupant, pathDistance, type Action, type Cell, type MatchState, type MechId } from "../board";
import { legalActions } from "../combat";
import { statusBlocks } from "../statusEffects";
import type { SequentialTurn } from "../sequentialTurn";

export type CommandIntent =
  | { kind: "move"; mech: MechId; to: Cell }
  | { kind: "act"; mech: MechId; action: Action }
  | { kind: "end" };

type SearchCommand =
  | { kind: "act"; mech: MechId; action: Action }
  | { kind: "move"; mech: MechId; to: Cell };

const enemyHp = (state: MatchState): number =>
  state.boss.hp + state.raiders.reduce((total, raider) => total + raider.hp, 0);
const mechHp = (state: MatchState): number => state.mechs.reduce((total, unit) => total + unit.hp, 0);
const buildingHp = (state: MatchState): number => state.buildings.reduce((total, building) => total + building.hp, 0);

/** Deterministic leaf value; outcome dominates, then enemy damage, our losses and objectives. */
export function stateValue(state: MatchState): number {
  if (state.outcome === "victory") return 1_000_000;
  if (state.outcome) return -1_000_000;
  const threat = new Set<string>();
  for (const intent of [state.boss.hp > 0 ? state.boss.intent : null, ...state.raiders.filter(raider => raider.hp > 0).map(raider => raider.intent)]) {
    if (!intent) continue;
    for (const cell of [...intent.local, ...intent.projected]) threat.add(`${cell.x},${cell.y}`);
  }
  const cover = new Set(state.covers.map(cell => `${cell.x},${cell.y}`));
  let score = -enemyHp(state) * 10 + mechHp(state) * 8 + buildingHp(state) * 6;
  for (const unit of state.mechs) {
    if (unit.hp <= 0) continue;
    if (threat.has(`${unit.pos.x},${unit.pos.y}`)) score -= 4;
    if (cover.has(`${unit.pos.x},${unit.pos.y}`)) score += 2;
  }
  for (const status of state.statusEncounter?.statuses ?? []) {
    if (status.remainingTurns > 0 && (status.kind === "freeze" || status.kind === "stun")) score -= 3;
  }
  if (state.mission) {
    const alive = state.mechs.filter(unit => unit.hp > 0);
    if (alive.length) score += Math.max(0, 12 - Math.min(...alive.map(unit => manh(unit.pos, state.mission!.target)))) * 2;
  }
  return score;
}

function restrictions(state: MatchState, id: MechId): { move: boolean; action: boolean } {
  return state.statusEncounter ? statusBlocks(state.statusEncounter.statuses, id) ?? { move: false, action: false } : { move: false, action: false };
}

function nearestEnemy(state: MatchState, from: Cell): number {
  const cells: Cell[] = [];
  if (state.boss.hp > 0) cells.push(state.boss.anchor);
  for (const raider of state.raiders) if (raider.hp > 0) cells.push(raider.pos);
  return cells.length ? Math.min(...cells.map(cell => manh(from, cell))) : 0;
}

function execute(branch: SequentialTurn, input: SearchCommand) {
  return branch.execute({ ...input, id: `search-${input.kind}`, revision: branch.snapshot().match.revision });
}

/** One deterministic command; the search branch never mutates the live authority. */
export function nextCommand(authority: SequentialTurn): CommandIntent {
  const snapshot = authority.snapshot(), state = snapshot.match;
  if (state.outcome || state.phase !== "player_plan") return { kind: "end" };
  const baseline = stateValue(state);

  let bestAct: { intent: Extract<CommandIntent, { kind: "act" }>; score: number } | null = null;
  for (const id of MECH_IDS) {
    if (!mech(state, id) || !snapshot.rights[id]?.action || restrictions(state, id).action) continue;
    for (const action of legalActions(state, id)) {
      if (action.kind === "skip") continue;
      const result = execute(authority.branch(), { kind: "act", mech: id, action });
      if (!result.ok) continue;
      const score = stateValue(result.snapshot.match);
      if (score > baseline && (!bestAct || score > bestAct.score)) bestAct = { intent: { kind: "act", mech: id, action }, score };
    }
  }
  if (bestAct) return bestAct.intent;

  let bestMove: { intent: Extract<CommandIntent, { kind: "move" }>; score: number } | null = null;
  for (const id of MECH_IDS) {
    const unit = mech(state, id);
    if (!unit || !snapshot.rights[id]?.move || restrictions(state, id).move) continue;
    const approach = nearestEnemy(state, unit.pos);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const to = { x, y };
      if (to.x === unit.pos.x && to.y === unit.pos.y) continue;
      if (occupant(state, to) !== "empty") continue;
      const distance = pathDistance(state, unit.pos, to, id, { alliesPass: true });
      if (distance === null || distance > moveBudget(id)) continue;
      const result = execute(authority.branch(), { kind: "move", mech: id, to });
      if (!result.ok) continue;
      const gain = approach - nearestEnemy(result.snapshot.match, to);
      const score = stateValue(result.snapshot.match);
      if (gain <= 0 && score <= baseline) continue;
      const total = score + gain * 2;
      if (!bestMove || total > bestMove.score) bestMove = { intent: { kind: "move", mech: id, to }, score: total };
    }
  }
  return bestMove?.intent ?? { kind: "end" };
}
