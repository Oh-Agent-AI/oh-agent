/** Local PvE deployment: the complete placement packet is the authority boundary. */
import { BOARD, MECH_IDS, footprint, inb, key, noSpawn, type Cell, type MatchState, type MechId, type TurnEvent } from "./board";
import { bossPrepare } from "./enemy";

export type DeployPlacement = { mechId: MechId; pos: Cell };
export type DeployPlan = { revision: number; placements: DeployPlacement[] };
export type DeployFault = { code: "phase" | "revision" | "incomplete" | "duplicate_mech" | "invalid_cell" | "outside_zone" | "terrain" | "unsafe" | "occupied" | "reserved" | "duplicate_cell" | "insufficient_space"; mechId?: MechId };
export type DeployTurn<S = MatchState> = { ok: true; state: S; log: TurnEvent[] } | { ok: false; fault: DeployFault };
const cellIsValid = (c: Cell) => Boolean(c && Number.isInteger(c.x) && Number.isInteger(c.y) && inb(c));

/** A map declares its rear deployment band; never expand it because it is full. */
export function rearDeployZone(firstRow = BOARD - 2): Cell[] {
  const cells: Cell[] = [];
  for (let y = firstRow; y < BOARD; y++) for (let x = 0; x < BOARD; x++) cells.push({ x, y });
  return cells;
}

export function deploymentCellFault(state: MatchState, cell: Cell): DeployFault | null {
  if (!cellIsValid(cell)) return { code: "invalid_cell" };
  if (!state.deployment?.zone.some(c => key(c) === key(cell))) return { code: "outside_zone" };
  if (noSpawn(state, cell)) return { code: "terrain" };
  // All units use the same safe landing contract, including Assault's sampled slopes.
  if (state.assaultTerrainSafety?.unsafeCells.some(c => key(c) === key(cell))) return { code: "unsafe" };
  if (state.deployment.reservedCells.some(c => key(c) === key(cell))) return { code: "reserved" };
  if ([...state.covers, ...(state.obstacles ?? []), ...state.buildings.flatMap(b => b.cells),
    ...(state.boss.hp > 0 ? footprint(state.boss.anchor) : []), ...state.raiders.filter(r => r.hp > 0).map(r => r.pos)]
    .some(c => key(c) === key(cell))) return { code: "occupied" };
  return null;
}

export function deployableCells(state: MatchState): Cell[] {
  return (state.deployment?.zone ?? []).filter(c => !deploymentCellFault(state, c)).map(c => ({ ...c }));
}

export function validateDeployPlan(state: MatchState, plan: DeployPlan): { ok: true } | { ok: false; fault: DeployFault } {
  const fail = (code: DeployFault["code"], mechId?: MechId) => ({ ok: false as const, fault: { code, ...(mechId ? { mechId } : {}) } });
  if (state.phase !== "deployment" || state.outcome || !state.deployment) return fail("phase");
  if (!plan || !Number.isInteger(plan.revision) || plan.revision !== state.revision) return fail("revision");
  if (deployableCells(state).length < MECH_IDS.length) return fail("insufficient_space");
  if (!Array.isArray(plan.placements) || plan.placements.length !== MECH_IDS.length || state.mechs.length !== MECH_IDS.length) return fail("incomplete");
  const ids = new Set<MechId>();
  const cells = new Set<string>();
  for (const p of plan.placements) {
    if (!p || !MECH_IDS.includes(p.mechId) || !state.mechs.some(m => m.id === p.mechId)) return fail("incomplete");
    if (ids.has(p.mechId)) return fail("duplicate_mech", p.mechId);
    ids.add(p.mechId);
    const fault = deploymentCellFault(state, p.pos);
    if (fault) return { ok: false, fault: { ...fault, mechId: p.mechId } };
    if (cells.has(key(p.pos))) return fail("duplicate_cell", p.mechId);
    cells.add(key(p.pos));
  }
  return { ok: true };
}

export function applyDeployPlan(state: MatchState, plan: DeployPlan): DeployTurn {
  const validation = validateDeployPlan(state, plan);
  if (!validation.ok) return validation;
  const next = structuredClone(state);
  for (const placement of plan.placements) next.mechs.find(m => m.id === placement.mechId)!.pos = { ...placement.pos };
  next.phase = "enemy_prepare";
  bossPrepare(next);
  // The zone is deployment-only metadata, not part of an active battle snapshot.
  delete next.deployment;
  // Preparation already increments revision internally. The atomic deployment
  // command has exactly one externally visible revision, including terminal openings.
  next.revision = state.revision + 1;
  return { ok: true, state: next, log: [] };
}

export function deployFaultText(fault: DeployFault, en: boolean): string {
  const messages: Record<DeployFault["code"], [string, string]> = {
    phase: ["当前不是部署阶段。", "Deployment is not active."], revision: ["部署版本已过期，请重新放置。", "Deployment revision is stale."],
    incomplete: ["请先放置全部三台机甲。", "Place all three mechs first."], duplicate_mech: ["每台机甲只能部署一次。", "Each mech must appear exactly once."],
    invalid_cell: ["请选择棋盘内的整数坐标。", "Choose an integer cell inside the board."], outside_zone: ["这里不在部署区内，请选择绿色格子。", "Outside the deployment zone. Choose a green cell."],
    terrain: ["水面或山地不能部署。", "Cannot deploy on water or mountains."], unsafe: ["这里地形过陡，不能安全部署。", "This cell is too steep for safe deployment."],
    occupied: ["这里被建筑、障碍或敌人占用。", "A building, obstacle or enemy occupies this cell."], reserved: ["这里是预留增援格，不能部署。", "This cell is reserved for reinforcements."],
    duplicate_cell: ["两台机甲不能部署在同一格。", "Two mechs cannot share a deployment cell."], insufficient_space: ["部署区没有足够的安全格，请更换战场或退出。", "Not enough safe deployment cells. Change battlefield or exit."],
  };
  return messages[fault.code][en ? 1 : 0];
}
