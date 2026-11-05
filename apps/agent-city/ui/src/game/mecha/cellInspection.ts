/** Local presentation only. Targets are a set of attack cells, never a walk path. */
import {
  BOSS_DEF, BOSS_MOVE, RAIDER_DEF, RAIDER_MOVE,
  STATS, enemyStatsOf, heightAt, inb, terrainAt, occupant, onFootprint, movementPath,
  type Cell, type MatchState, type MechId, type Raider, type RaiderRole, type TerrainKind, type Intent,
} from "./board";
import { unitMaxHp } from "./unitHealth";

export type InspectionDraft = Partial<Record<MechId, { moveTo: Cell | null }>>;
export type DeclaredAttack = {
  actor: string; origin: Cell; footprint: number;
  skill: Intent["skillId"] | null; status: Intent["status"] | "missing";
  targets: Cell[];
};
export type CellInspection = {
  cell: Cell; terrain: TerrainKind; height: number;
  object: "empty" | "cover" | "obstacle" | "building" | "rubble" | "unit";
  unit?: { id: string; side: "mech" | "enemy"; hp: number; maxHp: number | null; atk: number; def: number; move: number; cd: number | null; role?: RaiderRole; summon?: Raider["summon"] };
  building?: { id: string; hp: number; maxHp: number };
  attack?: DeclaredAttack;
  /** Authoritative pathfinder applied to an uncommitted friendly move. */
  movePath: Cell[] | null;
};

export function declaredAttack(state: MatchState, actor: string | null): DeclaredAttack | null {
  if (!actor) return null;
  const boss = actor === "boss";
  const entity = boss ? state.boss : state.raiders.find(r => r.id === actor);
  if (!entity || entity.hp <= 0) return null;
  const intent = entity.intent;
  const origin = boss ? state.boss.anchor : state.raiders.find(r => r.id === actor)!.pos;
  const active = intent && intent.skillId !== "skip" && intent.status !== "void";
  const targets = active ? intent.projected.filter(inb).filter((cell, index, cells) => cells.findIndex(c => c.x === cell.x && c.y === cell.y) === index).map(c => ({ ...c })) : [];
  return { actor, origin: { ...origin }, footprint: boss ? 2 : 1, skill: intent?.skillId ?? null, status: intent?.status ?? "missing", targets };
}

export function inspectCell(state: MatchState, cell: Cell, draft: InspectionDraft = {}, inspectedUnit?: string | null): CellInspection | null {
  if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) || !inb(cell)) return null;
  const info: CellInspection = { cell: { ...cell }, terrain: terrainAt(state, cell), height: heightAt(state, cell), object: "empty", movePath: null };
  const friendly = state.mechs.find(m => {
    const position = draft[m.id]?.moveTo ?? m.pos;
    return inspectedUnit !== null && (inspectedUnit === undefined || inspectedUnit === m.id) && m.hp > 0 && position.x === cell.x && position.y === cell.y;
  });
  const enemyAtCell = state.boss.hp > 0 && onFootprint(state.boss.anchor, cell) ? "boss" : state.raiders.find(r => r.hp > 0 && r.pos.x === cell.x && r.pos.y === cell.y)?.id;
  const enemy = inspectedUnit === null || (inspectedUnit !== undefined && inspectedUnit !== enemyAtCell) ? undefined : enemyAtCell;
  if (friendly) {
    const stats = STATS[friendly.id];
    info.object = "unit";
    info.unit = { id: friendly.id, side: "mech", hp: friendly.hp, maxHp: unitMaxHp(friendly.id), atk: stats.atk, def: stats.def, move: stats.move, cd: friendly.cd };
    const destination = draft[friendly.id]?.moveTo;
    if (destination && (destination.x !== friendly.pos.x || destination.y !== friendly.pos.y)) info.movePath = movementPath(state, friendly.pos, destination, friendly.id, { alliesPass: true });
  } else if (enemy) {
    const boss = enemy === "boss";
    const enemyStats = enemyStatsOf(state);
    info.object = "unit";
    info.unit = { id: enemy, side: "enemy", hp: boss ? state.boss.hp : state.raiders.find(r => r.id === enemy)!.hp, maxHp: unitMaxHp(enemy, state), atk: boss ? enemyStats.bossAtk : enemyStats.raiderAtk, def: boss ? BOSS_DEF : RAIDER_DEF, move: boss ? BOSS_MOVE : RAIDER_MOVE, cd: boss ? state.boss.cdSweep : null };
    const raider = !boss ? state.raiders.find(r => r.id === enemy) : undefined;
    if (raider?.summon) info.unit.summon = { parentId: raider.summon.parentId, speciesId: raider.summon.speciesId, expiresAtRound: raider.summon.expiresAtRound };
    const role = state.mission?.kind === "rescue:v1" ? raider?.role : undefined;
    if (role) info.unit.role = role;
    info.attack = declaredAttack(state, enemy) ?? undefined;
  } else {
    const occ = occupant(state, cell);
    // A friendly model may already be displayed at its draft destination.
    if (["cover", "obstacle", "building", "rubble"].includes(occ)) info.object = occ as CellInspection["object"];
    const building = state.buildings.find(b => b.cells.some(c => c.x === cell.x && c.y === cell.y));
    if (building) info.building = { id: building.id, hp: building.hp, maxHp: building.maxHp };
  }
  return info;
}

export type InspectionSegment = { from: Cell; to: Cell; kind: "attack" | "move" };
/** Separate rays for area attacks; the order of projected cells has no route meaning. */
export function inspectionSegments(attack: DeclaredAttack | null, path: Cell[] | null): InspectionSegment[] {
  if (attack) {
    const center = { x: attack.origin.x + (attack.footprint - 1) / 2, y: attack.origin.y + (attack.footprint - 1) / 2 };
    return attack.targets.map(to => ({ from: { ...center }, to: { ...to }, kind: "attack" }));
  }
  return (path ?? []).slice(1).map((to, index) => ({ from: { ...path![index]! }, to: { ...to }, kind: "move" }));
}
