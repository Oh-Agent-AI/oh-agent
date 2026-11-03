import {
  BOARD, FLAT_SPAWN_MAX_DELTA, footprintCenter, livingStakeBuildings, pathDistance,
  type Cell, type MatchState, type MechId,
} from "../rules";

export function same(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

export function mechAt(state: MatchState, id: MechId) {
  const found = state.mechs.find((mech) => mech.id === id);
  if (!found) throw new Error(id);
  return found;
}

export function threatened(state: MatchState, dest: Cell): boolean {
  if (state.boss.intent?.projected.some((cell) => same(cell, dest))) return true;
  return state.raiders.some((raider) => raider.hp > 0 && raider.intent?.projected.some((cell) => same(cell, dest)));
}

export function manh(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

const APPROACH_DIRS = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];

export function boardChargesTerrain(state: MatchState): boolean {
  if (state.terrain) {
    for (const row of state.terrain) for (const cell of row) if (cell !== "land") return true;
  }
  if (!state.heights) return false;
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const height = state.heights[y]?.[x];
      if (height === undefined) continue;
      for (const dir of APPROACH_DIRS) {
        const next = state.heights[y + dir.y]?.[x + dir.x];
        if (next !== undefined && next - height > FLAT_SPAWN_MAX_DELTA) return true;
      }
    }
  }
  return false;
}

export function approachCost(state: MatchState, from: Cell, focus: Cell, mover: MechId): number {
  const direct = pathDistance(state, from, focus, mover);
  if (direct !== null) return direct;
  let best = Number.POSITIVE_INFINITY;
  for (const dir of APPROACH_DIRS) {
    const dist = pathDistance(state, from, { x: focus.x + dir.x, y: focus.y + dir.y }, mover);
    if (dist !== null && dist < best) best = dist;
  }
  return best;
}

export function rankToward(state: MatchState, id: MechId, focus: Cell, bias: "cell" | "center"): (a: Cell, b: Cell) => number {
  const terrain = boardChargesTerrain(state);
  const biasOf = (cell: Cell) => bias === "center"
    ? Math.abs(cell.x + 0.5 - focus.x) + Math.abs(cell.y + 0.5 - focus.y)
    : manh(cell, focus);
  return (a, b) => {
    if (terrain) {
      const cost = approachCost(state, a, focus, id) - approachCost(state, b, focus, id);
      if (cost !== 0) return cost;
    }
    return biasOf(a) - biasOf(b) || a.x - b.x || a.y - b.y;
  };
}

function nearestBuildingDist(state: MatchState, cell: Cell): number {
  let best = 99;
  for (const building of livingStakeBuildings(state)) {
    for (const other of building.cells) best = Math.min(best, manh(cell, other));
  }
  return best;
}

export function nearestStakeCell(state: MatchState, from: Cell): Cell | null {
  let best: Cell | null = null;
  let bestDistance = 99;
  for (const building of livingStakeBuildings(state)) {
    for (const cell of building.cells) {
      const dist = manh(from, cell);
      const closer = !best || dist < bestDistance || (dist === bestDistance && (cell.y < best.y || (cell.y === best.y && cell.x < best.x)));
      if (closer) {
        best = cell;
        bestDistance = dist;
      }
    }
  }
  return best;
}

export function threatFocus(state: MatchState): { cell: Cell; id: string } {
  const raiders = state.raiders.filter((raider) => raider.hp > 0);
  if (raiders.length === 0) return { cell: footprintCenter(state.boss.anchor), id: "boss" };
  raiders.sort((a, b) => nearestBuildingDist(state, a.pos) - nearestBuildingDist(state, b.pos) || a.pos.y - b.pos.y || a.pos.x - b.pos.x || (a.id < b.id ? -1 : 1));
  const first = raiders[0];
  if (!first) return { cell: footprintCenter(state.boss.anchor), id: "boss" };
  return { cell: first.pos, id: first.id };
}
