import { bossPrepare, createMatch, GDD_RULESET, type BossScriptId, type BuildingStake, type Cell, type MatchState, type MechId, type TerrainKind } from "../rules";
import type { CityMechaSite } from "../citySite";

export type RemoteArenaBuilding = {
  id: string;
  cells: Cell[];
  x: number;
  z: number;
  yaw: number;
  ground: number;
  height: number;
};

export type RemoteArenaV1 = {
  schema: "mecha-arena:v1";
  arenaId: string;
  sourceRevision: string;
  ruleset: string;
  originX: number;
  originZ: number;
  yaw: number;
  cellW: number;
  cellD: number;
  terrain: TerrainKind[][];
  heights: number[][];
  buildings: RemoteArenaBuilding[];
  blocked: Cell[];
  mechs: Array<{ id: MechId; pos: Cell }>;
  boss: Cell;
  raiders: Array<{ id: string; pos: Cell }>;
  spawnSpread: number;
};

export function remoteArenaFromSite(site: CityMechaSite, input: { arenaId: string; sourceRevision: string }): RemoteArenaV1 {
  return {
    schema: "mecha-arena:v1",
    arenaId: input.arenaId,
    sourceRevision: input.sourceRevision,
    ruleset: GDD_RULESET,
    originX: site.originX,
    originZ: site.originZ,
    yaw: site.yaw,
    cellW: site.cellW,
    cellD: site.cellD,
    terrain: site.terrain.map((row) => row.slice()),
    heights: site.heights.map((row) => row.slice()),
    buildings: site.buildings.map((building, index) => ({
      id: `building-${String(index).padStart(4, "0")}`,
      cells: building.cells.map((cell) => ({ ...cell })),
      x: building.x,
      z: building.z,
      yaw: building.yaw,
      ground: building.ground,
      height: building.height,
    })),
    blocked: site.blocked.map((cell) => ({ ...cell })),
    mechs: site.mechs.map((mech) => ({ id: mech.id, pos: { ...mech.pos } })),
    boss: { ...site.boss },
    raiders: site.raiders.map((raider, index) => ({ id: `raider-${index}`, pos: { ...raider.pos } })),
    spawnSpread: site.spawnSpread,
  };
}

export function remoteStateFromSite(site: CityMechaSite, state: MatchState): MatchState {
  const cell = ({ x, y }: Cell): Cell => ({ x, y });
  const intent = (value: MatchState["boss"]["intent"]) => value && ({
    skillId: value.skillId, local: value.local.map(cell), projected: value.projected.map(cell), cdSweep: value.cdSweep, status: value.status,
  });
  const buildings = new Map(site.buildings.map((building, index) => [building.id, `building-${String(index).padStart(4, "0")}`]));
  return {
    ruleset: state.ruleset, preset: state.preset, script: state.script,
    covers: state.covers.map(cell), obstacles: state.obstacles.map(cell), terrain: state.terrain.map((row) => row.slice()), heights: state.heights.map((row) => row.slice()),
    buildings: state.buildings.map((building, index) => ({ id: buildings.get(building.id) ?? `other-building-${String(index).padStart(4, "0")}`, cells: building.cells.map(cell), hp: building.hp, maxHp: building.maxHp })),
    stake: state.stake,
    raiders: state.raiders.map((raider, index) => ({ id: `raider-${String(index).padStart(4, "0")}`, pos: cell(raider.pos), hp: raider.hp, intent: intent(raider.intent) })),
    mechs: state.mechs.map((mech) => ({ id: mech.id, pos: cell(mech.pos), hp: mech.hp, cd: mech.cd, skillUsed: mech.skillUsed })),
    boss: { anchor: cell(state.boss.anchor), hp: state.boss.hp, cdSweep: state.boss.cdSweep, cadence: state.boss.cadence, intent: intent(state.boss.intent) },
    turn: state.turn, phase: state.phase, revision: state.revision, outcome: state.outcome,
  };
}

export function pveMatchFromArena(arena: RemoteArenaV1, options: { script: BossScriptId; stake?: BuildingStake }): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid",
    script: options.script,
    covers: [],
    terrain: arena.terrain,
    heights: arena.heights,
    buildings: arena.buildings.map((building) => ({ id: building.id, cells: building.cells })),
    obstacles: arena.blocked,
    raiders: arena.raiders,
    mechs: arena.mechs,
    boss: arena.boss,
    stake: options.stake ?? "all",
  });
  bossPrepare(state);
  return state;
}
