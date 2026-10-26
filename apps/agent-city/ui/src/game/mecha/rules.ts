/**
 * GDD v1.3 mecha tactics, the City playable copy.
 * 2×2 footprint center is anchor + (1, 1). arena_plan is whole-pack.
 * cadence_ssw is smash, smash, sweep. smash_2 is not in v1.
 * raid_ssw is that cadence plus a move toward a living building or mech.
 * siege adds two 1×1 raiders and ends at turn 15.
 * Buildings have one HP pool. Every staked pool at 0 is defeat_buildings.
 * Stake is every building, except an alley, which stakes only street frontage.
 * 花费以半步计，预算 = 移动力 × MOVE_QUANTUM。平地一步是 2，和旧的「移动力格数」对齐。
 * 水不可进入，射击照常穿过。山地可以爬，基础花费 4，并且挡住射击。
 * 上坡超过平地出生容差时，陆地基础花费 4。道路基础花费和平地一样，增益再减。
 * 增益见 TERRAIN_MOD：沿路减到 1，所以同样的预算多走一倍。最低花费是 1，避免零花费绕圈。
 * 推入水或山地算撞墙。主动爬山地不撞墙，只付步数。
 */

export const GDD_RULESET = "mecha-v1.3";
export const BOARD = 10;
export const MAX_TURNS = 15;
export const BOSS_HP = 40;
export const BOSS_ATK = 6;
export const BOSS_DEF = 3;
export const BOSS_MOVE = 3;
export const BUILDING_HP = 16;
export const BUILDING_DEF = 0;
export const RAIDER_HP = 8;
export const RAIDER_ATK = 3;
export const RAIDER_DEF = 1;
export const RAIDER_MOVE = 4;
/** Spawn samples are one plane when the spread is at most 1 world unit (2 m). */
export const FLAT_SPAWN_MAX_DELTA = 1;
/** The search retries at this wider bound when no strict window exists. This is a
 *  documented relaxation, not a hidden one: `CityMechaSite.spawnSpread` carries the
 *  value and the panel shows it when it exceeds FLAT_SPAWN_MAX_DELTA. It must never
 *  grow past this constant; Phase 0 still owns the enforce-1-vs-revise decision. */
export const RELAXED_SPAWN_MAX_DELTA = 2;
/** 一步平地是两个半步。pathDistance 返回半步，和移动力比较时乘这一档。 */
export const MOVE_QUANTUM = 2;

export type Cell = { x: number; y: number };
/** 水挡住脚。山地能爬、挡住射击。道路是陆地里铺过的那一格，增益后更便宜。 */
export type TerrainKind = "land" | "water" | "mountain" | "road";
export type MechId = "Assault" | "Gunner" | "Support";
export type MoverId = MechId | "boss" | "raider";
export const MECH_IDS: MechId[] = ["Assault", "Gunner", "Support"];
export type CoverPresetId = "covers_sparse_mid" | "covers_diag_corridor" | "covers_twin_clusters";
export type BossScriptId = "stationary_smash" | "cadence_ssw" | "raid_ssw" | "siege";
export type BossSkill = "smash" | "sweep" | "skip";
export type Phase = "enemy_prepare" | "player_plan" | "resolving_boss" | "finished";
export type Outcome = "victory" | "defeat_wipe" | "defeat_timeout" | "defeat_buildings";

export type Action =
  | { kind: "skip" }
  | { kind: "melee"; target?: string }
  | { kind: "shoot"; target?: string }
  | { kind: "charge"; target?: string }
  | { kind: "pierce"; target?: string }
  | { kind: "repair"; target: MechId };

export type MechOrder = { mechId: MechId; moveTo: Cell | null; action: Action };
export type ArenaPlan = { revision: number; items: MechOrder[] };

type Stats = { maxHp: number; move: number; atk: number; def: number; shoot: number; melee: boolean };
export const STATS_MOVE: Record<MechId, number> = { Assault: 4, Gunner: 3, Support: 3 };

/**
 * 从该地形的基础半步里减去的量。
 * 道路和平地基础都是 2；道路增益 2 把沿路一步收到 1。
 * 山地和上坡基础都是 4；对应增益 2 把它们收到和平地一样。
 * 陆地增益只抵消上坡，不把平地再打折。
 * Boss 三栏是 0：脚印太宽，沿路不加价，坡和山照付。
 * 袭扰者和机甲一样吃道路增益，所以街上两边都更快。
 */
export const TERRAIN_MOD: Record<MoverId, { road: number; land: number; mountain: number }> = {
  Assault: { road: 2, land: 0, mountain: 0 },
  Gunner: { road: 2, land: 0, mountain: 2 },
  Support: { road: 2, land: 2, mountain: 0 },
  raider: { road: 2, land: 0, mountain: 0 },
  boss: { road: 0, land: 0, mountain: 0 },
};

export function moveBudget(id: MechId): number {
  return STATS[id].move * MOVE_QUANTUM;
}

const STATS: Record<MechId, Stats> = {
  Assault: { maxHp: 14, move: 4, atk: 5, def: 2, shoot: 0, melee: true },
  Gunner: { maxHp: 11, move: 3, atk: 4, def: 1, shoot: 4, melee: false },
  Support: { maxHp: 12, move: 3, atk: 2, def: 2, shoot: 3, melee: true },
};

export const COVERS: Record<CoverPresetId, Cell[]> = {
  covers_sparse_mid: [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }],
  covers_diag_corridor: [{ x: 2, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 7 }],
  covers_twin_clusters: [{ x: 1, y: 4 }, { x: 2, y: 4 }, { x: 2, y: 5 }, { x: 7, y: 4 }, { x: 8, y: 4 }, { x: 7, y: 5 }],
};

export type Intent = {
  skillId: BossSkill;
  local: Cell[];
  projected: Cell[];
  cdSweep: number;
  status: "planned" | "reprojected" | "void";
};

type Mech = { id: MechId; pos: Cell; hp: number; cd: number; skillUsed: boolean };
type Boss = { anchor: Cell; hp: number; cdSweep: number; cadence: number; intent: Intent | null };

export type Raider = { id: string; pos: Cell; hp: number; intent: Intent | null };

export const SIEGE_BUILDINGS: Array<{ id: string; cells: Cell[]; hp?: number }> = [
  { id: "west", cells: [{ x: 4, y: 4 }] },
  { id: "mid", cells: [{ x: 5, y: 4 }] },
  { id: "north", cells: [{ x: 4, y: 5 }] },
];
export const SIEGE_RAIDERS: Array<{ id: string; pos: Cell; hp?: number }> = [
  { id: "raider-w", pos: { x: 1, y: 4 } },
  { id: "raider-e", pos: { x: 8, y: 4 } },
];

export type Building = { id: string; cells: Cell[]; hp: number; maxHp: number };

/** 平地、靠岸、翻山守全部楼。巷战只守贴着路的楼；没有临街楼时退回全部，避免一场没有输赢条件的楼。 */
export type BuildingStake = "all" | "frontage";

export type MatchState = {
  ruleset: typeof GDD_RULESET;
  preset: CoverPresetId;
  script: BossScriptId;
  covers: Cell[];
  /** 每格一种面。缺省全是陆地，标准盘因此和没记地形时走法相同。 */
  terrain: TerrainKind[][];
  /** 格心的地面高度。上坡花费只看相邻两格的差。 */
  heights: number[][];
  buildings: Building[];
  /** 缺省 all。frontage 只把正交贴着道路的楼算进楼毁和敌方目标。 */
  stake: BuildingStake;
  raiders: Raider[];
  mechs: Mech[];
  boss: Boss;
  turn: number;
  phase: Phase;
  revision: number;
  outcome: Outcome | null;
};

/** 整包被拒时的定位信息。reason 保持原英文串供旧断言；cause 是界面翻译的键。 */
export type PlanFault = {
  code: "PLAN_PACK_REJECTED" | "NEED_ALL_OR_CONFIRM" | "STALE_REVISION";
  mechId?: MechId;
  /** 在提交顺序（plan.items）里的位置。 */
  index?: number;
  reason: string;
  cause?: "occupied" | "target_gone" | "out_of_reach" | "not_adjacent" | "mech_dead" | "cooldown" | "other";
};
/** 旧名。mechId/index/cause 都是可选附加字段，只读 code/reason 的调用方不受影响。 */
export type PlanReject = PlanFault;

/**
 * 一回合里按结算顺序发生的事。damage 都是实际扣掉的血（已被血量封顶）。
 * shove：damage 是被推单位自己受的碰撞伤；hit 缺省表示顺利位移，否则是挡路的东西（"wall"、单位 id）。
 */
export type TurnEvent =
  | { type: "move"; mechId: MechId; from: Cell; to: Cell }
  | { type: "act"; mechId: MechId; action: Action["kind"]; target?: string; damage: number }
  | { type: "shove"; unit: "boss" | MechId; dir: Cell; hit?: string; damage: number }
  | { type: "enemy"; actor: string; skill: BossSkill; cells: Cell[]; damage: number }
  | { type: "outcome"; outcome: Outcome };

/**
 * 事件接收口。模块级而不是逐层传参：tryTranslateBoss/applyAction 等十几个内部函数
 * 的签名和返回值都不用动，结算结果因此不可能被事件收集改变。
 * 只有 playTurn/previewPlan 会装上它，且 finally 还原；未装时 emit 是空操作。
 */
let eventSink: TurnEvent[] | null = null;
function emit(e: TurnEvent) {
  eventSink?.push(e);
}

const key = (c: Cell) => `${c.x},${c.y}`;
const eq = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;
const inb = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < BOARD && c.y < BOARD;
const cheb = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const manh = (a: Cell, b: Cell) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function footprintCenter(anchor: Cell): { x: number; y: number } {
  return { x: anchor.x + 1, y: anchor.y + 1 };
}

export function attackerCenter(cell: Cell): { x: number; y: number } {
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

export function primaryAxis(dx: number, dy: number): Cell {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > ay) return { x: sign(dx), y: 0 };
  if (ay > ax) return { x: 0, y: sign(dy) };
  return { x: sign(dx), y: 0 };
}

export function knockbackFromAttacker(attacker: Cell, anchor: Cell): Cell {
  const f = footprintCenter(anchor);
  const a = attackerCenter(attacker);
  return primaryAxis(f.x - a.x, f.y - a.y);
}

function knockbackFromBoss(anchor: Cell, target: Cell): Cell {
  const f = footprintCenter(anchor);
  const t = attackerCenter(target);
  return primaryAxis(t.x - f.x, t.y - f.y);
}

function footprint(anchor: Cell): Cell[] {
  return [anchor, { x: anchor.x + 1, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }, { x: anchor.x + 1, y: anchor.y + 1 }];
}

function onFootprint(anchor: Cell, c: Cell): boolean {
  return c.x >= anchor.x && c.x <= anchor.x + 1 && c.y >= anchor.y && c.y <= anchor.y + 1;
}

export function adjacentToFootprint(anchor: Cell, c: Cell): boolean {
  if (onFootprint(anchor, c)) return false;
  return footprint(anchor).some((f) => cheb(f, c) === 1);
}

function adjacentCells(anchor: Cell): Cell[] {
  const out: Cell[] = [];
  for (let y = anchor.y - 1; y <= anchor.y + 2; y += 1) {
    for (let x = anchor.x - 1; x <= anchor.x + 2; x += 1) {
      const c = { x, y };
      if (inb(c) && adjacentToFootprint(anchor, c)) out.push(c);
    }
  }
  return out;
}

function strike(atk: number, def: number): number {
  return Math.max(1, atk - def);
}

/** Boss smash/sweep damage against a mech. Same formula as `strike(BOSS_ATK, def)`. */
export function bossDamageTo(id: MechId): number {
  return strike(BOSS_ATK, STATS[id].def);
}

export function raiderDamageTo(id: MechId): number {
  return strike(RAIDER_ATK, STATS[id].def);
}

/** Damage a mech would take from every telegraph currently on this cell. */
export function incomingDamage(state: MatchState, id: MechId, cell: Cell): number {
  let total = 0;
  if (state.boss.hp > 0 && state.boss.intent?.projected.some((c) => eq(c, cell))) total += bossDamageTo(id);
  for (const raider of state.raiders) {
    if (raider.hp > 0 && raider.intent?.projected.some((c) => eq(c, cell))) total += raiderDamageTo(id);
  }
  return total;
}

export function buildingDamage(): number {
  return strike(BOSS_ATK, BUILDING_DEF);
}

export function flatSpawnSpread(heights: number[]): number {
  if (heights.length === 0) return 0;
  let lo = heights[0] ?? 0;
  let hi = lo;
  for (const h of heights) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return hi - lo;
}

export function standardDeploy(): { mechs: Array<{ id: MechId; pos: Cell }>; boss: Cell } {
  return {
    mechs: [
      { id: "Assault", pos: { x: 2, y: 9 } },
      { id: "Gunner", pos: { x: 5, y: 9 } },
      { id: "Support", pos: { x: 8, y: 9 } },
    ],
    boss: { x: 4, y: 0 },
  };
}

function copyTerrain(grid: TerrainKind[][] | undefined): TerrainKind[][] {
  const out: TerrainKind[][] = [];
  for (let y = 0; y < BOARD; y += 1) {
    const row: TerrainKind[] = [];
    for (let x = 0; x < BOARD; x += 1) {
      const cell = grid?.[y]?.[x];
      row.push(cell === "water" || cell === "mountain" || cell === "road" ? cell : "land");
    }
    out.push(row);
  }
  return out;
}

function copyHeights(grid: number[][] | undefined): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < BOARD; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < BOARD; x += 1) {
      const height = grid?.[y]?.[x];
      row.push(typeof height === "number" && Number.isFinite(height) ? height : 0);
    }
    out.push(row);
  }
  return out;
}

function terrainAt(state: MatchState, cell: Cell): TerrainKind {
  return state.terrain[cell.y]?.[cell.x] ?? "land";
}

function heightAt(state: MatchState, cell: Cell): number {
  return state.heights[cell.y]?.[cell.x] ?? 0;
}

/** 只有水没有落脚点。山地能爬，推上去才算撞墙。 */
function water(state: MatchState, cell: Cell): boolean {
  return terrainAt(state, cell) === "water";
}

/** 出生不放在水里，也不放在悬崖上。开打之后山地可以爬。 */
function noSpawn(state: MatchState, cell: Cell): boolean {
  const terrain = terrainAt(state, cell);
  return terrain === "water" || terrain === "mountain";
}

/** 被推或被砸的位移撞上水、山地，人留在原地并吃碰撞伤害。 */
function shoveWall(state: MatchState, cell: Cell): boolean {
  const terrain = terrainAt(state, cell);
  return terrain === "water" || terrain === "mountain";
}

/**
 * 一步的半步花费。平地和缓坡是 MOVE_QUANTUM。
 * 山地和更陡的上坡是两倍。道路增益、山地增益、陆地增益按 TERRAIN_MOD 减，最低 1。
 * 陆地增益只减上坡。水没有花费。
 */
function stepCost(state: MatchState, from: Cell, to: Cell, mover: MoverId): number | null {
  if (!inb(to) || water(state, to)) return null;
  const face = terrainAt(state, to);
  const rise = heightAt(state, to) - heightAt(state, from);
  const uphill = rise > FLAT_SPAWN_MAX_DELTA;
  let cost = face === "mountain" || uphill ? MOVE_QUANTUM * 2 : MOVE_QUANTUM;
  const mod = TERRAIN_MOD[mover];
  if (face === "road") cost -= mod.road;
  else if (face === "mountain") cost -= mod.mountain;
  else if (uphill) cost -= mod.land;
  return Math.max(1, cost);
}

export function createMatch(opts: {
  preset: CoverPresetId;
  script: BossScriptId;
  covers?: Cell[];
  terrain?: TerrainKind[][];
  heights?: number[][];
  buildings?: Array<{ id: string; cells: Cell[]; hp?: number }>;
  raiders?: Array<{ id: string; pos: Cell; hp?: number }>;
  mechs?: Array<{ id: MechId; pos: Cell }>;
  boss?: Cell;
  stake?: BuildingStake;
}): MatchState {
  const deploy = standardDeploy();
  const placed = opts.mechs ?? deploy.mechs;
  const siege = opts.script === "siege";
  return {
    ruleset: GDD_RULESET,
    preset: opts.preset,
    script: opts.script,
    covers: (opts.covers ?? (siege ? [] : COVERS[opts.preset])).map((c) => ({ ...c })),
    terrain: copyTerrain(opts.terrain),
    heights: copyHeights(opts.heights),
    buildings: (opts.buildings ?? (siege ? SIEGE_BUILDINGS : [])).map((b) => ({
      id: b.id,
      cells: b.cells.map((c) => ({ ...c })),
      hp: b.hp ?? BUILDING_HP,
      maxHp: b.hp ?? BUILDING_HP,
    })),
    stake: opts.stake ?? "all",
    raiders: (opts.raiders ?? (siege ? SIEGE_RAIDERS : [])).map((r) => ({
      id: r.id,
      pos: { ...r.pos },
      hp: r.hp ?? RAIDER_HP,
      intent: null,
    })),
    mechs: placed.map((m) => ({ id: m.id, pos: { ...m.pos }, hp: STATS[m.id].maxHp, cd: 0, skillUsed: false })),
    boss: { anchor: { ...(opts.boss ?? deploy.boss) }, hp: BOSS_HP, cdSweep: 0, cadence: 0, intent: null },
    turn: 1,
    phase: "enemy_prepare",
    revision: 0,
    outcome: null,
  };
}

export function living(state: MatchState): Mech[] {
  return state.mechs.filter((m) => m.hp > 0);
}

export function livingBuildings(state: MatchState): Building[] {
  return state.buildings.filter((b) => b.hp > 0);
}

function touchesRoad(state: MatchState, cell: Cell): boolean {
  for (const dir of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
    const next = { x: cell.x + dir.x, y: cell.y + dir.y };
    if (!inb(next)) continue;
    if (state.terrain[next.y]?.[next.x] === "road") return true;
  }
  return false;
}

/** 这一局真正要守的楼。巷战是临街楼；临街一栋都没有时仍是全部楼。 */
export function stakeBuildings(state: MatchState): Building[] {
  if (state.stake !== "frontage") return state.buildings;
  const front = state.buildings.filter((building) => building.cells.some((cell) => touchesRoad(state, cell)));
  return front.length > 0 ? front : state.buildings;
}

export function livingStakeBuildings(state: MatchState): Building[] {
  return stakeBuildings(state).filter((building) => building.hp > 0);
}

export function livingRaiders(state: MatchState): Raider[] {
  return state.raiders.filter((r) => r.hp > 0);
}

function enemiesRemain(state: MatchState): boolean {
  return state.boss.hp > 0 || livingRaiders(state).length > 0;
}

/** Mech cells and the boss footprint sit on land, with no cover and no building. */
export function spawnsAreOpenGround(state: MatchState): boolean {
  const blocked = new Set<string>();
  for (const c of state.covers) blocked.add(key(c));
  for (const b of state.buildings) for (const c of b.cells) blocked.add(key(c));
  const seen = new Set<string>();
  const open = (cell: Cell) => {
    const id = key(cell);
    if (!inb(cell) || noSpawn(state, cell) || blocked.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  };
  for (const m of state.mechs) if (!open(m.pos)) return false;
  for (const c of footprint(state.boss.anchor)) if (!open(c)) return false;
  for (const raider of state.raiders) if (!open(raider.pos)) return false;
  return true;
}

function mech(state: MatchState, id: MechId): Mech | undefined {
  return state.mechs.find((m) => m.id === id && m.hp > 0);
}

function isCover(state: MatchState, c: Cell): boolean {
  return state.covers.some((k) => eq(k, c));
}

type Occ = "empty" | "cover" | "building" | "rubble" | "boss" | "raider" | MechId;

function raiderAt(state: MatchState, c: Cell): Raider | undefined {
  return state.raiders.find((r) => r.hp > 0 && eq(r.pos, c));
}

function livingBuildingAt(state: MatchState, c: Cell): Building | undefined {
  return state.buildings.find((b) => b.hp > 0 && b.cells.some((k) => eq(k, c)));
}

function isRubble(state: MatchState, c: Cell): boolean {
  return state.buildings.some((b) => b.hp <= 0 && b.cells.some((k) => eq(k, c)));
}

function occupant(state: MatchState, c: Cell): Occ {
  if (!inb(c)) return "empty";
  if (state.boss.hp > 0 && onFootprint(state.boss.anchor, c)) return "boss";
  const who = living(state).find((m) => eq(m.pos, c));
  if (who) return who.id;
  if (raiderAt(state, c)) return "raider";
  if (livingBuildingAt(state, c)) return "building";
  if (isRubble(state, c)) return "rubble";
  if (isCover(state, c)) return "cover";
  return "empty";
}

function blocksTerrain(state: MatchState, c: Cell): boolean {
  const occ = occupant(state, c);
  return occ === "cover" || occ === "building" || occ === "rubble";
}

function hurtMech(state: MatchState, id: MechId, amount: number) {
  const m = state.mechs.find((x) => x.id === id);
  if (!m || m.hp <= 0) return;
  m.hp = Math.max(0, m.hp - amount);
}

function hurtBoss(state: MatchState, amount: number) {
  if (state.boss.hp <= 0) return;
  state.boss.hp = Math.max(0, state.boss.hp - amount);
  if (state.boss.hp === 0 && state.boss.intent) {
    state.boss.intent.status = "void";
    state.boss.intent.projected = [];
  }
}

function hurtRaider(raider: Raider, amount: number) {
  if (raider.hp <= 0) return;
  raider.hp = Math.max(0, raider.hp - amount);
  if (raider.hp === 0 && raider.intent) {
    raider.intent.status = "void";
    raider.intent.projected = [];
  }
}

function refresh(state: MatchState) {
  if (!state.outcome) {
    if (!enemiesRemain(state)) state.outcome = "victory";
    else if (living(state).length === 0) state.outcome = "defeat_wipe";
    else if (stakeBuildings(state).length > 0 && livingStakeBuildings(state).length === 0) state.outcome = "defeat_buildings";
  }
  // The pack applier stamps resolving_boss after a killing action already
  // stored the outcome. City does not execute a dead boss, so put the phase
  // back to finished or the match stays mid-resolution under a victory banner.
  if (state.outcome) state.phase = "finished";
}

function reproject(state: MatchState) {
  const intent = state.boss.intent;
  if (!intent || intent.skillId === "skip") return;
  const projected = intent.local.map((off) => ({ x: state.boss.anchor.x + off.x, y: state.boss.anchor.y + off.y })).filter(inb);
  intent.projected = projected;
  intent.status = projected.length === 0 ? "void" : "reprojected";
}

function tryTranslateBoss(state: MatchState, dir: Cell): boolean {
  if (state.boss.hp <= 0) return false;
  const anchor = state.boss.anchor;
  const dests = footprint(anchor).map((c) => ({ x: c.x + dir.x, y: c.y + dir.y }));
  let hit: MechId | null = null;
  for (const nc of dests) {
    if (!inb(nc) || blocksTerrain(state, nc) || shoveWall(state, nc)) {
      const before = state.boss.hp;
      hurtBoss(state, 2);
      emit({ type: "shove", unit: "boss", dir, hit: "wall", damage: before - state.boss.hp });
      refresh(state);
      return false;
    }
    if (onFootprint(anchor, nc)) continue;
    const rider = raiderAt(state, nc);
    if (rider) {
      const before = state.boss.hp;
      hurtBoss(state, 2);
      hurtRaider(rider, 2);
      emit({ type: "shove", unit: "boss", dir, hit: rider.id, damage: before - state.boss.hp });
      refresh(state);
      return false;
    }
    const occ = occupant(state, nc);
    if (occ === "Assault" || occ === "Gunner" || occ === "Support") {
      hit = occ;
      break;
    }
  }
  if (hit) {
    const before = state.boss.hp;
    hurtBoss(state, 2);
    hurtMech(state, hit, 2);
    emit({ type: "shove", unit: "boss", dir, hit, damage: before - state.boss.hp });
    refresh(state);
    return false;
  }
  state.boss.anchor = { x: anchor.x + dir.x, y: anchor.y + dir.y };
  reproject(state);
  emit({ type: "shove", unit: "boss", dir, damage: 0 });
  return true;
}

function tryPushMech(state: MatchState, id: MechId, dir: Cell): boolean {
  const m = mech(state, id);
  if (!m) return false;
  const dest = { x: m.pos.x + dir.x, y: m.pos.y + dir.y };
  const before = m.hp;
  if (!inb(dest) || blocksTerrain(state, dest) || shoveWall(state, dest)) {
    hurtMech(state, id, 2);
    emit({ type: "shove", unit: id, dir, hit: "wall", damage: before - m.hp });
    refresh(state);
    return false;
  }
  if (state.boss.hp > 0 && onFootprint(state.boss.anchor, dest)) {
    hurtMech(state, id, 2);
    hurtBoss(state, 2);
    emit({ type: "shove", unit: id, dir, hit: "boss", damage: before - m.hp });
    refresh(state);
    return false;
  }
  const rider = raiderAt(state, dest);
  if (rider) {
    hurtMech(state, id, 2);
    hurtRaider(rider, 2);
    emit({ type: "shove", unit: id, dir, hit: rider.id, damage: before - m.hp });
    refresh(state);
    return false;
  }
  const occ = occupant(state, dest);
  if (occ !== "empty") {
    hurtMech(state, id, 2);
    if (occ === "Assault" || occ === "Gunner" || occ === "Support") hurtMech(state, occ, 2);
    if (occ === "boss") hurtBoss(state, 2);
    emit({ type: "shove", unit: id, dir, hit: occ, damage: before - m.hp });
    refresh(state);
    return false;
  }
  m.pos = dest;
  emit({ type: "shove", unit: id, dir, damage: 0 });
  return true;
}

function meleeTargets(state: MatchState, pos: Cell): string[] {
  const ids: string[] = [];
  if (state.boss.hp > 0 && adjacentToFootprint(state.boss.anchor, pos)) ids.push("boss");
  for (const raider of livingRaiders(state)) if (cheb(pos, raider.pos) === 1) ids.push(raider.id);
  return ids;
}

function strikeEnemy(state: MatchState, target: string, atk: number) {
  if (target === "boss") hurtBoss(state, strike(atk, BOSS_DEF));
  else {
    const raider = state.raiders.find((r) => r.id === target && r.hp > 0);
    if (raider) hurtRaider(raider, strike(atk, RAIDER_DEF));
  }
}

function enemyHp(state: MatchState, target: string): number {
  return target === "boss" ? state.boss.hp : state.raiders.find((r) => r.id === target)?.hp ?? 0;
}

function meleeEnemy(state: MatchState, id: MechId, target: string, bonus: number, kind: Action["kind"]) {
  const m = mech(state, id);
  if (!m) return;
  const from = m.pos;
  const before = enemyHp(state, target);
  strikeEnemy(state, target, STATS[id].atk + bonus);
  // act 先于击退事件：回放顺序 = 出手、再被推。
  emit({ type: "act", mechId: id, action: kind, target, damage: before - enemyHp(state, target) });
  refresh(state);
  if (target === "boss" && state.boss.hp > 0) tryTranslateBoss(state, knockbackFromAttacker(from, state.boss.anchor));
}

function shootEnemy(state: MatchState, id: MechId, target: string, kind: Action["kind"]) {
  if (!mech(state, id)) return;
  const before = enemyHp(state, target);
  strikeEnemy(state, target, STATS[id].atk);
  emit({ type: "act", mechId: id, action: kind, target, damage: before - enemyHp(state, target) });
  refresh(state);
}

export function pathDistance(state: MatchState, from: Cell, to: Cell, mover: MoverId): number | null {
  if (eq(from, to)) return 0;
  if (!inb(to) || water(state, to)) return null;
  const destOcc = occupant(state, to);
  if (destOcc !== "empty" && destOcc !== mover) return null;
  const dist = new Map<string, number>([[key(from), 0]]);
  const heap: Cell[] = [from];
  const settled = new Set<string>();
  const dirs = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
  while (heap.length) {
    let best = 0;
    for (let i = 1; i < heap.length; i += 1) {
      const da = dist.get(key(heap[i]!))!;
      const db = dist.get(key(heap[best]!))!;
      const a = heap[i]!;
      const b = heap[best]!;
      if (da < db || (da === db && (a.x < b.x || (a.x === b.x && a.y < b.y)))) best = i;
    }
    const cur = heap.splice(best, 1)[0]!;
    const id = key(cur);
    if (settled.has(id)) continue;
    settled.add(id);
    const d = dist.get(id)!;
    if (eq(cur, to)) return d;
    for (const dir of dirs) {
      const nxt = { x: cur.x + dir.x, y: cur.y + dir.y };
      if (!inb(nxt) || settled.has(key(nxt))) continue;
      const occ = occupant(state, nxt);
      if (occ !== "empty" && occ !== mover) continue;
      const step = stepCost(state, cur, nxt, mover);
      if (step === null) continue;
      const next = d + step;
      const prev = dist.get(key(nxt));
      if (prev !== undefined && prev <= next) continue;
      dist.set(key(nxt), next);
      heap.push(nxt);
    }
  }
  return null;
}

function los(state: MatchState, from: Cell, to: Cell, ignoreCovers: number): boolean {
  if (from.x !== to.x && from.y !== to.y) return false;
  const cells: Cell[] = [];
  if (from.x === to.x) {
    const [a, b] = from.y < to.y ? [from.y + 1, to.y] : [to.y + 1, from.y];
    for (let y = a; y < b; y += 1) cells.push({ x: from.x, y });
  } else {
    const [a, b] = from.x < to.x ? [from.x + 1, to.x] : [to.x + 1, from.x];
    for (let x = a; x < b; x += 1) cells.push({ x, y: from.y });
  }
  let covers = 0;
  for (const c of cells) {
    if (terrainAt(state, c) === "mountain") return false;
    const occ = occupant(state, c);
    if (occ === "cover" || occ === "building" || occ === "rubble") {
      covers += 1;
      if (covers > ignoreCovers) return false;
    } else if (occ !== "empty" && !eq(c, to)) return false;
  }
  return true;
}

function aimCell(from: Cell, cells: Cell[]): Cell | null {
  let best: { d: number; c: Cell } | null = null;
  for (const c of cells) {
    if (c.x !== from.x && c.y !== from.y) continue;
    const d = cheb(from, c);
    if (!best || d < best.d) best = { d, c };
  }
  return best?.c ?? null;
}

function canShotCell(state: MatchState, from: Cell, aim: Cell, range: number, ignore: number): boolean {
  const d = cheb(from, aim);
  if (d < 1 || d > range) return false;
  return los(state, from, aim, ignore);
}

function shotTargets(state: MatchState, from: Cell, range: number, ignore: number): string[] {
  const ids: string[] = [];
  if (state.boss.hp > 0) {
    const aim = aimCell(from, footprint(state.boss.anchor));
    if (aim && canShotCell(state, from, aim, range, ignore)) ids.push("boss");
  }
  for (const raider of livingRaiders(state)) {
    if (canShotCell(state, from, raider.pos, range, ignore)) ids.push(raider.id);
  }
  return ids;
}

function tagged(kind: "melee" | "shoot" | "charge" | "pierce", ids: string[]): Action[] {
  if (ids.length === 1) return [{ kind }];
  return ids.map((target) => ({ kind, target }));
}

export function legalActions(state: MatchState, id: MechId): Action[] {
  const m = mech(state, id);
  if (!m) return [{ kind: "skip" }];
  const stats = STATS[id];
  const out: Action[] = [{ kind: "skip" }];
  if (stats.melee) {
    const ids = meleeTargets(state, m.pos);
    if (ids.length > 0) {
      out.push(...tagged("melee", ids));
      if (id === "Assault" && m.cd === 0) out.push(...tagged("charge", ids));
    }
  }
  if (stats.shoot > 0) {
    const shots = shotTargets(state, m.pos, stats.shoot, 0);
    if (shots.length > 0) out.push(...tagged("shoot", shots));
    if (id === "Gunner" && m.cd === 0) {
      const pierced = shotTargets(state, m.pos, stats.shoot, 1);
      if (pierced.length > 0) out.push(...tagged("pierce", pierced));
    }
  }
  if (id === "Support" && m.cd === 0) {
    for (const ally of living(state)) {
      if (ally.id !== id && cheb(m.pos, ally.pos) === 1) out.push({ kind: "repair", target: ally.id });
    }
  }
  return out;
}

function applyAction(state: MatchState, id: MechId, action: Action): string | null {
  const m = mech(state, id);
  if (!m) return "mech is not alive";
  const stats = STATS[id];
  if (action.kind === "skip") return null;
  if (action.kind === "melee" || action.kind === "charge") {
    if (action.kind === "charge" && id !== "Assault") return "charge is Assault-only";
    if (action.kind === "charge" && m.cd !== 0) return "skill on cooldown";
    if (!stats.melee) return "this mech has no melee";
    const meleeIds = meleeTargets(state, m.pos);
    const target = action.target ?? (meleeIds.length === 1 ? meleeIds[0] : undefined);
    if (!target || !meleeIds.includes(target)) return "not adjacent to an enemy";
    meleeEnemy(state, id, target, action.kind === "charge" ? 2 : 0, action.kind);
    if (action.kind === "charge") {
      m.cd = 1;
      m.skillUsed = true;
    }
    return null;
  }
  if (action.kind === "shoot" || action.kind === "pierce") {
    if (action.kind === "pierce" && id !== "Gunner") return "pierce is Gunner-only";
    if (action.kind === "pierce" && m.cd !== 0) return "skill on cooldown";
    const ignore = action.kind === "pierce" ? 1 : 0;
    const shots = shotTargets(state, m.pos, stats.shoot, ignore);
    const target = action.target ?? (shots.length === 1 ? shots[0] : undefined);
    if (!target || !shots.includes(target)) return "shot blocked or out of range";
    shootEnemy(state, id, target, action.kind);
    if (action.kind === "pierce") {
      m.cd = 1;
      m.skillUsed = true;
    }
    return null;
  }
  if (id !== "Support") return "repair is Support-only";
  if (m.cd !== 0) return "skill on cooldown";
  const ally = mech(state, action.target);
  if (!ally || cheb(m.pos, ally.pos) !== 1) return "repair target not adjacent";
  ally.hp = Math.min(STATS[action.target].maxHp, ally.hp + 4);
  emit({ type: "act", mechId: id, action: "repair", target: action.target, damage: 0 });
  m.cd = 1;
  m.skillUsed = true;
  return null;
}

/**
 * 把 applyAction 的英文拒绝串归类成界面可翻译的 cause。
 * 串本身不变（旧测试断言它）；"目标没了"要对照回合初状态才分得出，所以带 start/trial。
 */
function actionFaultCause(reason: string, action: Action, start: MatchState, trial: MatchState): NonNullable<PlanFault["cause"]> {
  if (reason === "mech is not alive") return "mech_dead";
  if (reason === "skill on cooldown") return "cooldown";
  const enemies = (s: MatchState) => new Set(["boss", ...s.raiders.map((r) => r.id)].filter((id) => enemyHp(s, id) > 0));
  const startAlive = enemies(start);
  const nowAlive = enemies(trial);
  // 有显式目标看它；没写目标（单目标省略）就看回合初活着的敌人有没有被前面的条目打死。
  const intendedGone =
    "target" in action && action.target !== undefined
      ? startAlive.has(action.target) && !nowAlive.has(action.target)
      : [...startAlive].some((id) => !nowAlive.has(id));
  if (reason === "shot blocked or out of range") return intendedGone ? "target_gone" : "other";
  if (reason === "not adjacent to an enemy") {
    return "target" in action && action.target !== undefined && startAlive.has(action.target) && !nowAlive.has(action.target) ? "target_gone" : "not_adjacent";
  }
  if (reason === "repair target not adjacent") return "not_adjacent";
  return "other";
}

/**
 * 契约（阶段 A）：条目按提交顺序在同一份试算状态上逐台结算——先移动再行动，
 * 前面的击退、击杀、占位都对后面的条目可见。任何一条不合法整包拒绝，state 不动。
 * 拒绝时附 mechId/index/cause 指出是哪一台、为什么。
 */
export function validateAndApplyPlan(state: MatchState, plan: ArenaPlan): { ok: true } | PlanReject {
  if (state.phase !== "player_plan") return { code: "PLAN_PACK_REJECTED", reason: "not player_plan", cause: "other" };
  if (plan.revision !== state.revision) return { code: "STALE_REVISION", reason: "revision mismatch", cause: "other" };
  const alive = living(state).map((m) => m.id);
  const seen = new Set(plan.items.map((i) => i.mechId));
  if (seen.size !== plan.items.length || seen.size !== alive.length || alive.some((id) => !seen.has(id))) {
    return { code: "NEED_ALL_OR_CONFIRM", reason: "pack must name every living mech once", cause: "other" };
  }
  const trial = structuredClone(state);
  for (const [index, item] of plan.items.entries()) {
    const fault = (reason: string, cause: NonNullable<PlanFault["cause"]>): PlanReject => ({
      code: "PLAN_PACK_REJECTED", reason, mechId: item.mechId, index, cause,
    });
    const who = mech(trial, item.mechId);
    if (!who) return fault("mech is not alive", "mech_dead");
    const dest = item.moveTo ?? who.pos;
    if (!eq(dest, who.pos)) {
      const dist = pathDistance(trial, who.pos, dest, item.mechId);
      if (dist === null) {
        const occ = occupant(trial, dest);
        return occ === "empty" ? fault("no path within move range", "out_of_reach") : fault("destination occupied", "occupied");
      }
      if (dist > moveBudget(item.mechId)) return fault("move exceeds move_range", "out_of_reach");
      emit({ type: "move", mechId: item.mechId, from: { ...who.pos }, to: { ...dest } });
      who.pos = dest;
    }
    const err = applyAction(trial, item.mechId, item.action);
    if (err) return fault(err, actionFaultCause(err, item.action, state, trial));
  }
  for (const m of trial.mechs) {
    if (m.skillUsed) m.skillUsed = false;
    else if (m.cd > 0) m.cd -= 1;
  }
  trial.revision += 1;
  trial.phase = "resolving_boss";
  refresh(trial);
  Object.assign(state, trial);
  return { ok: true };
}

function threat(state: MatchState, c: Cell): number {
  const occ = occupant(state, c);
  if (occ === "Assault" || occ === "Gunner" || occ === "Support") return 3;
  if (occ === "building" || occ === "cover") return 2;
  return 1;
}

const STEP_DIRS: Cell[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];

function anchorClear(state: MatchState, anchor: Cell): boolean {
  for (const c of footprint(anchor)) {
    if (!inb(c) || water(state, c)) return false;
    if (onFootprint(state.boss.anchor, c)) continue;
    if (occupant(state, c) !== "empty") return false;
  }
  return true;
}

/** Boss 整座脚印平移一格。花费取四格里最贵的那一步。有一格是水就走不了。 */
function bossStepCost(state: MatchState, anchor: Cell, dir: Cell): number | null {
  const nxt = { x: anchor.x + dir.x, y: anchor.y + dir.y };
  if (!anchorClear(state, nxt)) return null;
  let cost = 0;
  for (const cell of footprint(anchor)) {
    const step = stepCost(state, cell, { x: cell.x + dir.x, y: cell.y + dir.y }, "boss");
    if (step === null) return null;
    if (step > cost) cost = step;
  }
  return cost;
}

function objectiveGap(state: MatchState, anchor: Cell): number {
  const goals: Cell[] = [];
  for (const b of livingStakeBuildings(state)) goals.push(...b.cells);
  for (const m of state.mechs) if (m.hp > 0) goals.push(m.pos);
  if (goals.length === 0) return 0;
  let best = 99;
  for (const f of footprint(anchor)) {
    for (const g of goals) {
      const d = manh(f, g);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Up to BOSS_MOVE flat steps, counted in half-steps. Only a strictly closer gap is taken. */
function stepBossTowardObjectives(state: MatchState) {
  if (state.boss.hp <= 0) return;
  const start = state.boss.anchor;
  const dist = new Map<string, number>([[key(start), 0]]);
  const heap: Array<{ x: number; y: number; cost: number }> = [{ x: start.x, y: start.y, cost: 0 }];
  const settled = new Set<string>();
  let best = { x: start.x, y: start.y, cost: 0, gap: objectiveGap(state, start) };
  while (heap.length) {
    let index = 0;
    for (let i = 1; i < heap.length; i += 1) {
      const a = heap[i]!;
      const b = heap[index]!;
      if (a.cost < b.cost || (a.cost === b.cost && (a.x < b.x || (a.x === b.x && a.y < b.y)))) index = i;
    }
    const cur = heap.splice(index, 1)[0]!;
    const id = key(cur);
    if (settled.has(id)) continue;
    settled.add(id);
    const gap = objectiveGap(state, cur);
    const closer = gap < best.gap
      || (gap === best.gap && cur.cost < best.cost)
      || (gap === best.gap && cur.cost === best.cost && (cur.x < best.x || (cur.x === best.x && cur.y < best.y)));
    if (closer) best = { x: cur.x, y: cur.y, cost: cur.cost, gap };
    if (cur.cost >= BOSS_MOVE * MOVE_QUANTUM) continue;
    for (const dir of STEP_DIRS) {
      const step = bossStepCost(state, cur, dir);
      if (step === null) continue;
      const nxt = { x: cur.x + dir.x, y: cur.y + dir.y, cost: cur.cost + step };
      if (nxt.cost > BOSS_MOVE * MOVE_QUANTUM) continue;
      const nid = key(nxt);
      const prev = dist.get(nid);
      if (prev !== undefined && prev <= nxt.cost) continue;
      dist.set(nid, nxt.cost);
      heap.push(nxt);
    }
  }
  state.boss.anchor = { x: best.x, y: best.y };
}

/** Closest living mech. Equal threat used to prefer the low corner, which on
 * the standard deploy is off the squad's road, so the smash cell was free to ignore. */
function approachDistance(state: MatchState, c: Cell): number {
  let best = 99;
  for (const m of state.mechs) {
    if (m.hp <= 0) continue;
    const d = manh(c, m.pos);
    if (d < best) best = d;
  }
  return best;
}

function cellBefore(a: Cell, b: Cell): boolean {
  return a.x < b.x || (a.x === b.x && a.y < b.y);
}

function pickSmash(state: MatchState): Cell | null {
  let best: { t: number; d: number; c: Cell } | null = null;
  for (const c of adjacentCells(state.boss.anchor)) {
    const t = threat(state, c);
    const d = approachDistance(state, c);
    if (!best || t > best.t || (t === best.t && (d < best.d || (d === best.d && cellBefore(c, best.c))))) best = { t, d, c };
  }
  return best?.c ?? null;
}

function pickSweep(state: MatchState): [Cell, Cell] | null {
  const cells = adjacentCells(state.boss.anchor);
  let best: { sum: number; mx: number; near: number; a: Cell; b: Cell } | null = null;
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const a = cells[i];
      const b = cells[j];
      if (manh(a, b) > 2) continue;
      const ta = threat(state, a);
      const tb = threat(state, b);
      const sum = ta + tb;
      const mx = Math.max(ta, tb);
      const near = approachDistance(state, a) + approachDistance(state, b);
      const [c0, c1] = a.x < b.x || (a.x === b.x && a.y <= b.y) ? [a, b] : [b, a];
      const headTied = best !== null && c0.x === best.a.x && c0.y === best.a.y;
      const better = !best || sum > best.sum || (sum === best.sum && mx > best.mx)
        || (sum === best.sum && mx === best.mx && near < best.near)
        || (sum === best.sum && mx === best.mx && near === best.near && (cellBefore(c0, best.a) || (headTied && cellBefore(c1, best.b))));
      if (better) best = { sum, mx, near, a: c0, b: c1 };
    }
  }
  return best ? [best.a, best.b] : null;
}

function smashIntent(state: MatchState, cell: Cell | null): Intent {
  if (!cell) return { skillId: "skip", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "planned" };
  const local = [{ x: cell.x - state.boss.anchor.x, y: cell.y - state.boss.anchor.y }];
  return { skillId: "smash", local, projected: inb(cell) ? [cell] : [], cdSweep: state.boss.cdSweep, status: inb(cell) ? "planned" : "void" };
}

function nearestBuilding(state: MatchState, from: Cell[]): Building | null {
  let best: Building | null = null;
  let bestD = 99;
  for (const building of livingStakeBuildings(state)) {
    const d = gapTo(from, building.cells);
    if (!best || d < bestD || (d === bestD && building.id < best.id)) {
      best = building;
      bestD = d;
    }
  }
  return best;
}

function gapTo(from: Cell[], goals: Cell[]): number {
  if (goals.length === 0) return 0;
  let best = 99;
  for (const cell of from) {
    for (const goal of goals) {
      const d = manh(cell, goal);
      if (d < best) best = d;
    }
  }
  return best;
}

function raiderGoals(state: MatchState): Map<string, Cell[]> {
  const bossGoal = state.boss.hp > 0 ? nearestBuilding(state, footprint(state.boss.anchor)) : null;
  const pool = livingStakeBuildings(state).filter((b) => b.id !== bossGoal?.id);
  const left = [...(pool.length > 0 ? pool : livingStakeBuildings(state))];
  const goals = new Map<string, Cell[]>();
  const raiders = [...livingRaiders(state)].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const raider of raiders) {
    let best: Building | null = null;
    let bestD = 99;
    for (const building of left) {
      const d = gapTo([raider.pos], building.cells);
      if (!best || d < bestD || (d === bestD && building.id < best.id)) {
        best = building;
        bestD = d;
      }
    }
    if (best) {
      goals.set(raider.id, best.cells.map((c) => ({ ...c })));
      const index = left.findIndex((b) => b.id === best?.id);
      if (index >= 0) left.splice(index, 1);
    } else {
      goals.set(raider.id, living(state).map((m) => ({ ...m.pos })));
    }
  }
  return goals;
}

function adjacentToUnit(pos: Cell): Cell[] {
  const out: Cell[] = [];
  for (let y = pos.y - 1; y <= pos.y + 1; y += 1) {
    for (let x = pos.x - 1; x <= pos.x + 1; x += 1) {
      const cell = { x, y };
      if (inb(cell) && !eq(cell, pos)) out.push(cell);
    }
  }
  return out;
}

function stepRaider(state: MatchState, raider: Raider, goals: Cell[]) {
  const start = raider.pos;
  const dist = new Map<string, number>([[key(start), 0]]);
  const heap: Array<{ x: number; y: number; cost: number }> = [{ x: start.x, y: start.y, cost: 0 }];
  const settled = new Set<string>();
  let best = { x: start.x, y: start.y, cost: 0, gap: gapTo([start], goals) };
  while (heap.length) {
    let index = 0;
    for (let i = 1; i < heap.length; i += 1) {
      const a = heap[i]!;
      const b = heap[index]!;
      if (a.cost < b.cost || (a.cost === b.cost && (a.x < b.x || (a.x === b.x && a.y < b.y)))) index = i;
    }
    const cur = heap.splice(index, 1)[0]!;
    const id = key(cur);
    if (settled.has(id)) continue;
    settled.add(id);
    const gap = gapTo([cur], goals);
    const closer = gap < best.gap
      || (gap === best.gap && cur.cost < best.cost)
      || (gap === best.gap && cur.cost === best.cost && (cur.x < best.x || (cur.x === best.x && cur.y < best.y)));
    if (closer) best = { x: cur.x, y: cur.y, cost: cur.cost, gap };
    if (cur.cost >= RAIDER_MOVE * MOVE_QUANTUM) continue;
    for (const dir of STEP_DIRS) {
      const nxtCell = { x: cur.x + dir.x, y: cur.y + dir.y };
      if (!inb(nxtCell)) continue;
      const occ = occupant(state, nxtCell);
      if (occ !== "empty" && !eq(nxtCell, raider.pos)) continue;
      const step = stepCost(state, cur, nxtCell, "raider");
      if (step === null) continue;
      const nxt = { x: nxtCell.x, y: nxtCell.y, cost: cur.cost + step };
      if (nxt.cost > RAIDER_MOVE * MOVE_QUANTUM) continue;
      const nid = key(nxt);
      const prev = dist.get(nid);
      if (prev !== undefined && prev <= nxt.cost) continue;
      dist.set(nid, nxt.cost);
      heap.push(nxt);
    }
  }
  raider.pos = { x: best.x, y: best.y };
}

function planRaiders(state: MatchState) {
  const goals = raiderGoals(state);
  for (const raider of livingRaiders(state)) {
    stepRaider(state, raider, goals.get(raider.id) ?? []);
    const cell = pickSmashCells(state, adjacentToUnit(raider.pos));
    raider.intent = cell
      ? { skillId: "smash", local: [{ x: cell.x - raider.pos.x, y: cell.y - raider.pos.y }], projected: [cell], cdSweep: 0, status: "planned" }
      : { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" };
  }
}

function pickSmashCells(state: MatchState, cells: Cell[]): Cell | null {
  let best: { t: number; d: number; c: Cell } | null = null;
  for (const c of cells) {
    const t = threat(state, c);
    const d = approachDistance(state, c);
    if (!best || t > best.t || (t === best.t && (d < best.d || (d === best.d && cellBefore(c, best.c))))) best = { t, d, c };
  }
  return best?.c ?? null;
}

export function bossPrepare(state: MatchState): Intent {
  const skip: Intent = { skillId: "skip", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
  if (state.phase !== "enemy_prepare") return skip;
  if (!enemiesRemain(state)) {
    refresh(state);
    return skip;
  }
  let intent = skip;
  if (state.boss.hp > 0) {
    if (state.script === "raid_ssw" || state.script === "siege") stepBossTowardObjectives(state);
    if (state.script === "stationary_smash") intent = smashIntent(state, pickSmash(state));
    else {
      const step = state.boss.cadence % 3;
      const wantSweep = step === 2;
      if (wantSweep && state.boss.cdSweep === 0) {
        const pair = pickSweep(state);
        if (pair) {
          const local = pair.map((c) => ({ x: c.x - state.boss.anchor.x, y: c.y - state.boss.anchor.y }));
          intent = { skillId: "sweep", local, projected: pair.filter(inb), cdSweep: state.boss.cdSweep, status: "planned" };
        } else intent = smashIntent(state, pickSmash(state));
      } else intent = smashIntent(state, pickSmash(state));
      state.boss.cadence = (step + 1) % 3;
    }
  }
  state.boss.intent = intent;
  planRaiders(state);
  state.phase = "player_plan";
  state.revision += 1;
  return intent;
}

function resolveRaider(state: MatchState, raider: Raider) {
  if (raider.hp <= 0) return;
  const intent = raider.intent;
  if (!intent || intent.skillId === "skip" || intent.status === "void") {
    raider.intent = null;
    return;
  }
  const struck = new Set<string>();
  // 事件先入列、伤害收完再回填：保证 enemy 排在它引发的后续事件之前。
  const ev: Extract<TurnEvent, { type: "enemy" }> = { type: "enemy", actor: raider.id, skill: intent.skillId, cells: intent.projected.map((c) => ({ ...c })), damage: 0 };
  emit(ev);
  for (const cell of intent.projected) {
    const occ = occupant(state, cell);
    if (occ === "building") {
      const hit = livingBuildingAt(state, cell);
      if (hit && !struck.has(hit.id)) {
        struck.add(hit.id);
        const before = hit.hp;
        hit.hp = Math.max(0, hit.hp - strike(RAIDER_ATK, BUILDING_DEF));
        ev.damage += before - hit.hp;
        refresh(state);
      }
      continue;
    }
    if (occ === "Assault" || occ === "Gunner" || occ === "Support") {
      const before = state.mechs.find((x) => x.id === occ)!.hp;
      hurtMech(state, occ, strike(RAIDER_ATK, STATS[occ].def));
      ev.damage += before - state.mechs.find((x) => x.id === occ)!.hp;
      refresh(state);
    }
  }
  raider.intent = null;
}

export function bossExecute(state: MatchState) {
  if (state.outcome) {
    refresh(state);
    return;
  }
  if (state.boss.hp <= 0) {
    for (const raider of state.raiders) resolveRaider(state, raider);
    refresh(state);
    if (!state.outcome) {
      state.turn += 1;
      if (state.turn > MAX_TURNS) {
        state.outcome = "defeat_timeout";
        state.phase = "finished";
      } else {
        state.phase = "enemy_prepare";
        state.revision += 1;
      }
    }
    return;
  }
  const intent = state.boss.intent;
  const skill = intent?.skillId ?? "skip";
  reproject(state);
  const cells = state.boss.intent?.projected ?? [];
  let any = false;
  const struckBuildings = new Set<string>();
  if (intent && skill !== "skip" && intent.status !== "void") {
    const ev: Extract<TurnEvent, { type: "enemy" }> = { type: "enemy", actor: "boss", skill, cells: cells.map((c) => ({ ...c })), damage: 0 };
    emit(ev);
    for (const c of cells) {
      const occ = occupant(state, c);
      if (occ === "building") {
        const hit = livingBuildingAt(state, c);
        if (hit && !struckBuildings.has(hit.id)) {
          struckBuildings.add(hit.id);
          const before = hit.hp;
          hit.hp = Math.max(0, hit.hp - strike(BOSS_ATK, BUILDING_DEF));
          ev.damage += before - hit.hp;
          any = true;
          refresh(state);
        }
        continue;
      }
      if (occ === "empty" || occ === "cover" || occ === "boss" || occ === "rubble" || occ === "raider") continue;
      const target = mech(state, occ);
      if (!target) continue;
      const before = target.hp;
      hurtMech(state, occ, strike(BOSS_ATK, STATS[occ].def));
      ev.damage += before - target.hp;
      refresh(state);
      if (skill === "smash" && mech(state, occ)) tryPushMech(state, occ, knockbackFromBoss(state.boss.anchor, target.pos));
      any = true;
    }
  }
  if (skill === "sweep") state.boss.cdSweep = 1;
  else if (state.boss.cdSweep > 0) state.boss.cdSweep -= 1;
  if (!any && state.boss.intent) state.boss.intent.status = "void";
  state.boss.intent = null;
  for (const raider of state.raiders) {
    if (state.outcome) break;
    resolveRaider(state, raider);
  }
  refresh(state);
  if (!state.outcome) {
    state.turn += 1;
    if (state.turn > MAX_TURNS) {
      state.outcome = "defeat_timeout";
      state.phase = "finished";
    } else {
      state.phase = "enemy_prepare";
      state.revision += 1;
    }
  }
}

/** Test hook: force the cadence beat and sweep cooldown before prepare. */
export function setScriptCounters(state: MatchState, cadence: number, cdSweep: number) {
  state.boss.cadence = cadence % 3;
  state.boss.cdSweep = cdSweep;
}

// ---- 回合入口 ----

export type TurnResult =
  | { ok: true; state: MatchState; log: TurnEvent[] }
  | { ok: false; fault: PlanFault };

/** 内部：在克隆上跑 校验 → 大怪结算 → 下回合准备，并在玩家行动之后、敌方结算之前取一次预告。 */
function runTurn(state: MatchState, plan: ArenaPlan) {
  const next = structuredClone(state);
  const log: TurnEvent[] = [];
  const outer = eventSink;
  eventSink = log;
  try {
    const applied = validateAndApplyPlan(next, plan);
    if (!("ok" in applied)) return { ok: false as const, fault: applied };
    let announced = false;
    const noteOutcome = () => {
      if (next.outcome && !announced) {
        announced = true;
        emit({ type: "outcome", outcome: next.outcome });
      }
    };
    noteOutcome();
    // 推动之后的预告：大怪被推会 reproject，小怪的预告不跟着动。
    const seen = new Set<string>();
    const telegraph: Cell[] = [];
    for (const intent of [next.boss.intent, ...next.raiders.map((r) => r.intent)]) {
      if (!intent || intent.skillId === "skip" || intent.status === "void") continue;
      for (const c of intent.projected) if (!seen.has(key(c))) (seen.add(key(c)), telegraph.push({ ...c }));
    }
    const hpBefore = Object.fromEntries(next.mechs.map((m) => [m.id, m.hp])) as Record<MechId, number>;
    if (next.phase === "resolving_boss") bossExecute(next);
    const hits = Object.fromEntries(MECH_IDS.map((id) => [id, Math.max(0, (hpBefore[id] ?? 0) - (next.mechs.find((m) => m.id === id)?.hp ?? 0))])) as Record<MechId, number>;
    noteOutcome();
    if (next.phase === "enemy_prepare") bossPrepare(next);
    noteOutcome();
    return { ok: true as const, state: next, log, telegraph, hits };
  } finally {
    eventSink = outer;
  }
}

/**
 * 一回合的唯一入口：校验并结算玩家整包，再走完大怪结算与下回合准备，
 * 调用方不用再看 phase。不修改传入的 state（内部克隆），拒绝时返回 fault、原 state 原样可用。
 * 成功时 state 已进入下一回合的 player_plan（或 finished）。log 按结算顺序。
 */
export function playTurn(state: MatchState, plan: ArenaPlan): TurnResult {
  const r = runTurn(state, plan);
  return r.ok ? { ok: true, state: r.state, log: r.log } : r;
}

/**
 * 预览：在克隆上做与提交完全相同的试算，plan 可以不完整——
 * 没排的活机甲按「不动 + 待机」排在末尾，并列入 assumed，界面据此标「假设」。
 * telegraphAfter 是玩家行动之后（推动已生效）的预告格；hitsAfter 是本回合敌方结算里每台掉的血。
 */
export function previewPlan(
  state: MatchState,
  plan: ArenaPlan,
): { ok: true; telegraphAfter: Cell[]; hitsAfter: Record<MechId, number>; assumed: MechId[] } | { ok: false; fault: PlanFault } {
  const named = new Set(plan.items.map((i) => i.mechId));
  const assumed = living(state).map((m) => m.id).filter((id) => !named.has(id));
  const full: ArenaPlan = {
    revision: plan.revision,
    items: [...plan.items, ...assumed.map((mechId) => ({ mechId, moveTo: null, action: { kind: "skip" as const } }))],
  };
  const r = runTurn(state, full);
  return r.ok ? { ok: true, telegraphAfter: r.telegraph, hitsAfter: r.hits, assumed } : r;
}
