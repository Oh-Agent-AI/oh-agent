/**
 * 棋盘层：常量、类型、地形/高度、占位查询、单步花费、寻路。
 * 不认识战斗与敌方脚本；combat.ts / enemy.ts / rules.ts 都从这里往上建（依赖单向，无运行时环）。
 * 事件接收口（eventSink）也只在这里存在一份，所有模块经 emit / swapEventSink 共用。
 */

export const GDD_RULESET = "mecha-v1.4";
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

export type Stats = { maxHp: number; move: number; atk: number; def: number; shoot: number; melee: boolean };
export const STATS: Record<MechId, Stats> = {
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

export type Mech = { id: MechId; pos: Cell; hp: number; cd: number; skillUsed: boolean };
export type Boss = { anchor: Cell; hp: number; cdSweep: number; cadence: number; intent: Intent | null };

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
  /** 站点里画着却不可用的陆地格（场景楼、斜放楼）。和 covers 不同：挡路、挡射击且不能被穿射、
   *  不可被攻击、不参与 threat。缺省空，空时所有规则与加这个字段之前逐字节一致。 */
  obstacles: Cell[];
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
 *   大怪的脚印可能同时撞上多样东西（RULE-4），此时 hit 是逗号连接的清单，顺序固定：
 *   "wall"（有墙/水/山/掩体/楼/废墟/障碍/出界则在最前）、小怪 id（字典序）、机甲（MECH_IDS 序）。
 * act.fizzled：v1.4 落空（无效果、不耗冷却），damage 恒 0，cause 说明为什么落空。
 */
/** Actual health changes for presentation; never used to calculate the rules. */
type HealthSnapshot = { kind: "boss" | "mech" | "raider" | "building"; id: string; before: number; after: number };
export type HealthEffect = HealthSnapshot & { order: number; sequence?: number };
let eventSink: TurnEvent[] | null = null;
const effectOrders = new WeakMap<TurnEvent[], number>();
// This separate clock interleaves health mutations with displacement and collision.
// `order` remains the contiguous health-only order used by existing consumers.
const presentationOrders = new WeakMap<TurnEvent[], number>();
function nextPresentationOrder(): number | undefined {
  if (!eventSink) return undefined;
  const order = presentationOrders.get(eventSink) ?? 0;
  presentationOrders.set(eventSink, order + 1);
  return order;
}

/** Effects in one event can surround a nested shove, so event order alone is insufficient. */
export function orderedHealthEffect(effect: HealthSnapshot): HealthEffect {
  const order = eventSink ? effectOrders.get(eventSink) ?? 0 : 0;
  if (eventSink) effectOrders.set(eventSink, order + 1);
  const sequence = nextPresentationOrder();
  return { ...effect, order, ...(sequence === undefined ? {} : { sequence }) };
}

export function healthSnapshot(state: MatchState): HealthSnapshot[] {
  return [
    { kind: "boss", id: "boss", before: state.boss.hp, after: state.boss.hp },
    ...state.mechs.map((m): HealthSnapshot => ({ kind: "mech", id: m.id, before: m.hp, after: m.hp })),
    ...state.raiders.map((r): HealthSnapshot => ({ kind: "raider", id: r.id, before: r.hp, after: r.hp })),
    ...state.buildings.map((b): HealthSnapshot => ({ kind: "building", id: b.id, before: b.hp, after: b.hp })),
  ];
}

/** Planning often simulates without an event sink; avoid collecting unused snapshots. */
export function healthCapture(state: MatchState): HealthSnapshot[] {
  return eventSink ? healthSnapshot(state) : [];
}

export function healthEffectFields(before: HealthSnapshot[], state: MatchState): { effects?: HealthEffect[] } {
  if (!before.length) return {};
  const after = new Map(healthSnapshot(state).map((v) => [`${v.kind}:${v.id}`, v.after]));
  const effects = before.flatMap((v) => {
    const hp = after.get(`${v.kind}:${v.id}`);
    return hp !== undefined && hp !== v.before ? [orderedHealthEffect({ ...v, after: hp })] : [];
  });
  return effects.length ? { effects } : {};
}

export type TurnEvent =
  | { type: "move"; mechId: MechId; from: Cell; to: Cell }
  | { type: "act"; mechId: MechId; action: Action["kind"]; target?: string; damage: number; fizzled?: boolean; cause?: PlanFault["cause"]; effects?: HealthEffect[] }
  | { type: "shove"; unit: "boss" | MechId; dir: Cell; hit?: string; damage: number; effects?: HealthEffect[]; sequence?: number }
  | { type: "enemy"; actor: string; skill: BossSkill; cells: Cell[]; damage: number; effects?: HealthEffect[] }
  | { type: "outcome"; outcome: Outcome };

/** Immutable combat snapshots used to place actors while presenting an accepted turn. */

export type PresentationUnit = { id: string; pos: Cell; hp: number };
export type PresentationSnapshot = {
  boss: { anchor: Cell; hp: number };
  mechs: Array<PresentationUnit & { id: MechId }>;
  raiders: PresentationUnit[];
  buildings: Array<{ id: string; hp: number }>;
  outcome: Outcome | null;
};
export type PresentationStages = {
  before: PresentationSnapshot;
  afterMovement: PresentationSnapshot;
  afterPlayer: PresentationSnapshot;
  afterEnemy: PresentationSnapshot;
  afterPrepare: PresentationSnapshot;
};

export function presentationSnapshot(state: MatchState): PresentationSnapshot {
  return {
    boss: { anchor: { ...state.boss.anchor }, hp: state.boss.hp },
    mechs: state.mechs.map((m) => ({ id: m.id, pos: { ...m.pos }, hp: m.hp })),
    raiders: state.raiders.map((r) => ({ id: r.id, pos: { ...r.pos }, hp: r.hp })),
    buildings: state.buildings.map((b) => ({ id: b.id, hp: b.hp })),
    outcome: state.outcome,
  };
}

/** Player movement is simultaneous and precedes every action in an accepted pack. */
export function movementSnapshot(before: PresentationSnapshot, log: TurnEvent[]): PresentationSnapshot | null {
  const moved: PresentationSnapshot = structuredClone(before);
  const seen = new Set<MechId>();
  let actionStarted = false;
  for (const event of log) {
    if (event.type !== "move") { actionStarted = true; continue; }
    if (actionStarted || seen.has(event.mechId)) return null;
    const unit = moved.mechs.find((m) => m.id === event.mechId);
    if (!unit || unit.pos.x !== event.from.x || unit.pos.y !== event.from.y) return null;
    unit.pos = { ...event.to }; seen.add(event.mechId);
  }
  return moved;
}

/**
 * 事件接收口。模块级而不是逐层传参：tryTranslateBoss/applyAction 等十几个内部函数
 * 的签名和返回值都不用动，结算结果因此不可能被事件收集改变。
 * 只有 playTurn/previewPlan 会装上它，且 finally 还原；未装时 emit 是空操作。
 */
export function emit(e: TurnEvent) {
  if (!eventSink) return;
  if (e.type === "shove") e.sequence = nextPresentationOrder();
  eventSink.push(e);
}
/** 换上新的接收口并返回旧的，调用方在 finally 里换回去。接收口本体只在本模块一份。 */
export function swapEventSink(next: TurnEvent[] | null): TurnEvent[] | null {
  const prev = eventSink;
  eventSink = next;
  return prev;
}

export const key = (c: Cell) => `${c.x},${c.y}`;
export const eq = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;
export const inb = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < BOARD && c.y < BOARD;
export const cheb = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const manh = (a: Cell, b: Cell) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

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

export function footprint(anchor: Cell): Cell[] {
  return [anchor, { x: anchor.x + 1, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }, { x: anchor.x + 1, y: anchor.y + 1 }];
}

export function onFootprint(anchor: Cell, c: Cell): boolean {
  return c.x >= anchor.x && c.x <= anchor.x + 1 && c.y >= anchor.y && c.y <= anchor.y + 1;
}

export function adjacentToFootprint(anchor: Cell, c: Cell): boolean {
  if (onFootprint(anchor, c)) return false;
  return footprint(anchor).some((f) => cheb(f, c) === 1);
}

export function adjacentCells(anchor: Cell): Cell[] {
  const out: Cell[] = [];
  for (let y = anchor.y - 1; y <= anchor.y + 2; y += 1) {
    for (let x = anchor.x - 1; x <= anchor.x + 2; x += 1) {
      const c = { x, y };
      if (inb(c) && adjacentToFootprint(anchor, c)) out.push(c);
    }
  }
  return out;
}

export function terrainAt(state: MatchState, cell: Cell): TerrainKind {
  return state.terrain[cell.y]?.[cell.x] ?? "land";
}

export function heightAt(state: MatchState, cell: Cell): number {
  return state.heights[cell.y]?.[cell.x] ?? 0;
}

/** 只有水没有落脚点。山地能爬，推上去才算撞墙。 */
export function water(state: MatchState, cell: Cell): boolean {
  return terrainAt(state, cell) === "water";
}

/** 出生不放在水里，也不放在悬崖上。开打之后山地可以爬。 */
export function noSpawn(state: MatchState, cell: Cell): boolean {
  const terrain = terrainAt(state, cell);
  return terrain === "water" || terrain === "mountain";
}

/** 被推或被砸的位移撞上水、山地，人留在原地并吃碰撞伤害。 */
export function shoveWall(state: MatchState, cell: Cell): boolean {
  const terrain = terrainAt(state, cell);
  return terrain === "water" || terrain === "mountain";
}

/**
 * 一步的半步花费。平地和缓坡是 MOVE_QUANTUM。
 * 山地和更陡的上坡是两倍。道路增益、山地增益、陆地增益按 TERRAIN_MOD 减，最低 1。
 * 陆地增益只减上坡。水没有花费。
 */
export function stepCost(state: MatchState, from: Cell, to: Cell, mover: MoverId): number | null {
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

export function enemiesRemain(state: MatchState): boolean {
  return state.boss.hp > 0 || livingRaiders(state).length > 0;
}


export function mech(state: MatchState, id: MechId): Mech | undefined {
  return state.mechs.find((m) => m.id === id && m.hp > 0);
}

export function isObstacle(state: MatchState, c: Cell): boolean {
  // 旧存档/手写状态可能没有这个字段，按空处理。
  return (state.obstacles ?? []).some((k) => eq(k, c));
}

export function isCover(state: MatchState, c: Cell): boolean {
  return state.covers.some((k) => eq(k, c));
}

export type Occ = "empty" | "obstacle" | "cover" | "building" | "rubble" | "boss" | "raider" | MechId;

export function raiderAt(state: MatchState, c: Cell): Raider | undefined {
  return state.raiders.find((r) => r.hp > 0 && eq(r.pos, c));
}

export function livingBuildingAt(state: MatchState, c: Cell): Building | undefined {
  return state.buildings.find((b) => b.hp > 0 && b.cells.some((k) => eq(k, c)));
}

export function isRubble(state: MatchState, c: Cell): boolean {
  return state.buildings.some((b) => b.hp <= 0 && b.cells.some((k) => eq(k, c)));
}

export function occupant(state: MatchState, c: Cell): Occ {
  if (!inb(c)) return "empty";
  if (state.boss.hp > 0 && onFootprint(state.boss.anchor, c)) return "boss";
  const who = living(state).find((m) => eq(m.pos, c));
  if (who) return who.id;
  if (raiderAt(state, c)) return "raider";
  if (livingBuildingAt(state, c)) return "building";
  if (isRubble(state, c)) return "rubble";
  if (isObstacle(state, c)) return "obstacle";
  if (isCover(state, c)) return "cover";
  return "empty";
}

export function blocksTerrain(state: MatchState, c: Cell): boolean {
  const occ = occupant(state, c);
  return occ === "cover" || occ === "building" || occ === "rubble" || occ === "obstacle";
}

export const STEP_DIRS: Cell[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];

// ---- 寻路 ----

type HeapNode = { x: number; y: number; cost: number };

/** 二叉最小堆，序 = (cost, x, y)。旧实现是线性扫描取同一个序的最小者，弹出顺序逐项相同。 */
class CellHeap {
  private a: HeapNode[] = [];
  get size(): number {
    return this.a.length;
  }
  private static before(p: HeapNode, q: HeapNode): boolean {
    return p.cost < q.cost || (p.cost === q.cost && (p.x < q.x || (p.x === q.x && p.y < q.y)));
  }
  push(n: HeapNode) {
    const a = this.a;
    let i = a.length;
    a.push(n);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!CellHeap.before(n, a[parent]!)) break;
      a[i] = a[parent]!;
      i = parent;
    }
    a[i] = n;
  }
  pop(): HeapNode {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= a.length) break;
        if (child + 1 < a.length && CellHeap.before(a[child + 1]!, a[child]!)) child += 1;
        if (!CellHeap.before(a[child]!, last)) break;
        a[i] = a[child]!;
        i = child;
      }
      a[i] = last;
    }
    return top;
  }
}

/**
 * 三处寻路（pathDistance、大怪、小怪）共用的 Dijkstra。
 * 按 (cost, x, y) 弹出；每个格子第一次弹出即定稿（settle），随后 visit(cell, cost) 按定稿顺序被调用，
 * 返回 true 就立刻停。cost >= maxCost 的格子只定稿不展开，新花费 > maxCost 的邻居不入队。
 * step(from, to) 给出一步花费，null 表示走不了；只有花费严格变小才会重新入队。
 */
export function dijkstra(
  start: Cell,
  step: (from: Cell, to: Cell) => number | null,
  visit: (cell: Cell, cost: number) => boolean | void,
  maxCost = Number.POSITIVE_INFINITY,
  onRelax?: (from: Cell, to: Cell, cost: number) => void,
): void {
  const dist = new Map<string, number>([[key(start), 0]]);
  const heap = new CellHeap();
  heap.push({ x: start.x, y: start.y, cost: 0 });
  const settled = new Set<string>();
  while (heap.size > 0) {
    const cur = heap.pop();
    const id = key(cur);
    if (settled.has(id)) continue;
    settled.add(id);
    if (visit(cur, cur.cost) === true) return;
    if (cur.cost >= maxCost) continue;
    for (const dir of STEP_DIRS) {
      const nxtCell = { x: cur.x + dir.x, y: cur.y + dir.y };
      if (settled.has(key(nxtCell))) continue;
      const s = step(cur, nxtCell);
      if (s === null) continue;
      const cost = cur.cost + s;
      if (cost > maxCost) continue;
      const prev = dist.get(key(nxtCell));
      if (prev !== undefined && prev <= cost) continue;
      dist.set(key(nxtCell), cost);
      onRelax?.(cur, nxtCell, cost);
      heap.push({ x: nxtCell.x, y: nxtCell.y, cost });
    }
  }
}

/** A deterministic least-cost cell route with the same occupancy rules as pathDistance. */
export function pathRoute(state: MatchState, from: Cell, to: Cell, mover: MoverId, opts?: { alliesPass?: boolean }): { cost: number; cells: Cell[] } | null {
  if (eq(from, to)) return { cost: 0, cells: [{ ...from }] };
  if (!inb(to) || water(state, to)) return null;
  const passes = (occ: Occ) => occ === "empty" || occ === mover || (opts?.alliesPass === true && MECH_IDS.includes(occ as MechId));
  if (!passes(occupant(state, to))) return null;
  const parents = new Map<string, Cell>();
  let found: number | null = null;
  dijkstra(from, (cur, nxt) => {
    if (!inb(nxt) || !passes(occupant(state, nxt))) return null;
    return stepCost(state, cur, nxt, mover);
  }, (cell, cost) => {
    if (!eq(cell, to)) return false;
    found = cost;
    return true;
  }, Number.POSITIVE_INFINITY, (cur, nxt) => { parents.set(key(nxt), { x: cur.x, y: cur.y }); });
  if (found === null) return null;
  const cells: Cell[] = [{ ...to }];
  while (!eq(cells[0]!, from)) {
    const parent = parents.get(key(cells[0]!));
    if (!parent || cells.length > BOARD * BOARD) return null;
    cells.unshift(parent);
  }
  return { cost: found, cells };
}

/**
 * opts.alliesPass（v1.4 同时移动）：机甲格不挡路、也可作终点——三台同时动，
 * 谁占着哪格要等所有终点出来才知道，终点是否撞车由整包校验另查。其余占位物照常阻挡。
 */
export function pathDistance(state: MatchState, from: Cell, to: Cell, mover: MoverId, opts?: { alliesPass?: boolean }): number | null {
  if (eq(from, to)) return 0;
  if (!inb(to) || water(state, to)) return null;
  const passes = (occ: Occ) => occ === "empty" || occ === mover || (opts?.alliesPass === true && MECH_IDS.includes(occ as MechId));
  const destOcc = occupant(state, to);
  if (!passes(destOcc)) return null;
  let found: number | null = null;
  dijkstra(
    from,
    (cur, nxt) => {
      if (!inb(nxt)) return null;
      if (!passes(occupant(state, nxt))) return null;
      return stepCost(state, cur, nxt, mover);
    },
    (cell, cost) => {
      if (!eq(cell, to)) return false;
      found = cost;
      return true;
    },
  );
  return found;
}
