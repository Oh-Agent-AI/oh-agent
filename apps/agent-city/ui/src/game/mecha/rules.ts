/**
 * GDD v1.3 mecha tactics, the City playable copy.
 * 2×2 footprint center is anchor + (1, 1). arena_plan is whole-pack.
 * cadence_ssw is smash, smash, sweep. smash_2 is not in v1.
 * raid_ssw is that cadence plus a move toward a living building or mech.
 * siege adds two 1×1 raiders and ends at turn 15.
 * Buildings have one HP pool; every pool at 0 is defeat_buildings.
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

export type Cell = { x: number; y: number };
export type MechId = "Assault" | "Gunner" | "Support";
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

export type MatchState = {
  ruleset: typeof GDD_RULESET;
  preset: CoverPresetId;
  script: BossScriptId;
  covers: Cell[];
  buildings: Building[];
  raiders: Raider[];
  mechs: Mech[];
  boss: Boss;
  turn: number;
  phase: Phase;
  revision: number;
  outcome: Outcome | null;
};

export type PlanReject = { code: "PLAN_PACK_REJECTED" | "NEED_ALL_OR_CONFIRM" | "STALE_REVISION"; reason: string };

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

export function createMatch(opts: {
  preset: CoverPresetId;
  script: BossScriptId;
  covers?: Cell[];
  buildings?: Array<{ id: string; cells: Cell[]; hp?: number }>;
  raiders?: Array<{ id: string; pos: Cell; hp?: number }>;
  mechs?: Array<{ id: MechId; pos: Cell }>;
  boss?: Cell;
}): MatchState {
  const deploy = standardDeploy();
  const placed = opts.mechs ?? deploy.mechs;
  const siege = opts.script === "siege";
  return {
    ruleset: GDD_RULESET,
    preset: opts.preset,
    script: opts.script,
    covers: (opts.covers ?? (siege ? [] : COVERS[opts.preset])).map((c) => ({ ...c })),
    buildings: (opts.buildings ?? (siege ? SIEGE_BUILDINGS : [])).map((b) => ({
      id: b.id,
      cells: b.cells.map((c) => ({ ...c })),
      hp: b.hp ?? BUILDING_HP,
      maxHp: b.hp ?? BUILDING_HP,
    })),
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

export function livingRaiders(state: MatchState): Raider[] {
  return state.raiders.filter((r) => r.hp > 0);
}

function enemiesRemain(state: MatchState): boolean {
  return state.boss.hp > 0 || livingRaiders(state).length > 0;
}

/** Mech cells and the boss footprint sit on cells with no cover and no building. */
export function spawnsAreOpenGround(state: MatchState): boolean {
  const blocked = new Set<string>();
  for (const c of state.covers) blocked.add(key(c));
  for (const b of state.buildings) for (const c of b.cells) blocked.add(key(c));
  const seen = new Set<string>();
  for (const m of state.mechs) {
    const id = key(m.pos);
    if (!inb(m.pos) || blocked.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  for (const c of footprint(state.boss.anchor)) {
    const id = key(c);
    if (!inb(c) || blocked.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  for (const raider of state.raiders) {
    const id = key(raider.pos);
    if (!inb(raider.pos) || blocked.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
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
    else if (state.buildings.length > 0 && livingBuildings(state).length === 0) state.outcome = "defeat_buildings";
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
    if (!inb(nc) || blocksTerrain(state, nc)) {
      hurtBoss(state, 2);
      refresh(state);
      return false;
    }
    if (onFootprint(anchor, nc)) continue;
    const rider = raiderAt(state, nc);
    if (rider) {
      hurtBoss(state, 2);
      hurtRaider(rider, 2);
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
    hurtBoss(state, 2);
    hurtMech(state, hit, 2);
    refresh(state);
    return false;
  }
  state.boss.anchor = { x: anchor.x + dir.x, y: anchor.y + dir.y };
  reproject(state);
  return true;
}

function tryPushMech(state: MatchState, id: MechId, dir: Cell): boolean {
  const m = mech(state, id);
  if (!m) return false;
  const dest = { x: m.pos.x + dir.x, y: m.pos.y + dir.y };
  if (!inb(dest) || blocksTerrain(state, dest)) {
    hurtMech(state, id, 2);
    refresh(state);
    return false;
  }
  if (state.boss.hp > 0 && onFootprint(state.boss.anchor, dest)) {
    hurtMech(state, id, 2);
    hurtBoss(state, 2);
    refresh(state);
    return false;
  }
  const rider = raiderAt(state, dest);
  if (rider) {
    hurtMech(state, id, 2);
    hurtRaider(rider, 2);
    refresh(state);
    return false;
  }
  const occ = occupant(state, dest);
  if (occ !== "empty") {
    hurtMech(state, id, 2);
    if (occ === "Assault" || occ === "Gunner" || occ === "Support") hurtMech(state, occ, 2);
    if (occ === "boss") hurtBoss(state, 2);
    refresh(state);
    return false;
  }
  m.pos = dest;
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

function meleeEnemy(state: MatchState, id: MechId, target: string, bonus: number) {
  const m = mech(state, id);
  if (!m) return;
  const from = m.pos;
  strikeEnemy(state, target, STATS[id].atk + bonus);
  refresh(state);
  if (target === "boss" && state.boss.hp > 0) tryTranslateBoss(state, knockbackFromAttacker(from, state.boss.anchor));
}

function shootEnemy(state: MatchState, id: MechId, target: string) {
  if (!mech(state, id)) return;
  strikeEnemy(state, target, STATS[id].atk);
  refresh(state);
}

export function pathDistance(state: MatchState, from: Cell, to: Cell, mover: MechId): number | null {
  if (eq(from, to)) return 0;
  if (!inb(to)) return null;
  const destOcc = occupant(state, to);
  if (destOcc !== "empty" && destOcc !== mover) return null;
  const dist = new Map<string, number>([[key(from), 0]]);
  const q = [from];
  const dirs = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
  while (q.length) {
    const cur = q.shift()!;
    const d = dist.get(key(cur))!;
    for (const dir of dirs) {
      const nxt = { x: cur.x + dir.x, y: cur.y + dir.y };
      if (!inb(nxt) || dist.has(key(nxt))) continue;
      const occ = occupant(state, nxt);
      const pass = occ === "empty" || occ === mover;
      if (!pass) continue;
      dist.set(key(nxt), d + 1);
      if (eq(nxt, to)) return d + 1;
      q.push(nxt);
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
    meleeEnemy(state, id, target, action.kind === "charge" ? 2 : 0);
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
    shootEnemy(state, id, target);
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
  m.cd = 1;
  m.skillUsed = true;
  return null;
}

export function validateAndApplyPlan(state: MatchState, plan: ArenaPlan): { ok: true } | PlanReject {
  if (state.phase !== "player_plan") return { code: "PLAN_PACK_REJECTED", reason: "not player_plan" };
  if (plan.revision !== state.revision) return { code: "STALE_REVISION", reason: "revision mismatch" };
  const alive = living(state).map((m) => m.id);
  const seen = new Set(plan.items.map((i) => i.mechId));
  if (seen.size !== plan.items.length || seen.size !== alive.length || alive.some((id) => !seen.has(id))) {
    return { code: "NEED_ALL_OR_CONFIRM", reason: "pack must name every living mech once" };
  }
  const trial = structuredClone(state);
  for (const item of plan.items) {
    const who = mech(trial, item.mechId);
    if (!who) return { code: "PLAN_PACK_REJECTED", reason: "mech is not alive" };
    const dest = item.moveTo ?? who.pos;
    if (!eq(dest, who.pos)) {
      const dist = pathDistance(trial, who.pos, dest, item.mechId);
      if (dist === null) {
        const occ = occupant(trial, dest);
        return { code: "PLAN_PACK_REJECTED", reason: occ === "empty" ? "no path within move range" : "destination occupied" };
      }
      if (dist > STATS[item.mechId].move) return { code: "PLAN_PACK_REJECTED", reason: "move exceeds move_range" };
      who.pos = dest;
    }
    const err = applyAction(trial, item.mechId, item.action);
    if (err) return { code: "PLAN_PACK_REJECTED", reason: err };
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
    if (!inb(c)) return false;
    if (onFootprint(state.boss.anchor, c)) continue;
    if (occupant(state, c) !== "empty") return false;
  }
  return true;
}

function objectiveGap(state: MatchState, anchor: Cell): number {
  const goals: Cell[] = [];
  for (const b of state.buildings) if (b.hp > 0) goals.push(...b.cells);
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

/** Up to BOSS_MOVE orthogonal steps. Only a strictly closer gap is taken. */
function stepBossTowardObjectives(state: MatchState) {
  if (state.boss.hp <= 0) return;
  const start = state.boss.anchor;
  const queue: Array<{ x: number; y: number; steps: number }> = [{ x: start.x, y: start.y, steps: 0 }];
  const seen = new Set<string>([key(start)]);
  let best = { x: start.x, y: start.y, steps: 0, gap: objectiveGap(state, start) };
  while (queue.length) {
    const cur = queue.shift();
    if (!cur) break;
    const gap = objectiveGap(state, cur);
    const closer = gap < best.gap
      || (gap === best.gap && cur.steps < best.steps)
      || (gap === best.gap && cur.steps === best.steps && (cur.x < best.x || (cur.x === best.x && cur.y < best.y)));
    if (closer) best = { x: cur.x, y: cur.y, steps: cur.steps, gap };
    if (cur.steps >= BOSS_MOVE) continue;
    for (const dir of STEP_DIRS) {
      const nxt = { x: cur.x + dir.x, y: cur.y + dir.y, steps: cur.steps + 1 };
      const id = `${nxt.x},${nxt.y}`;
      if (seen.has(id) || !anchorClear(state, nxt)) continue;
      seen.add(id);
      queue.push(nxt);
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
  for (const building of livingBuildings(state)) {
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
  const pool = livingBuildings(state).filter((b) => b.id !== bossGoal?.id);
  const left = [...(pool.length > 0 ? pool : livingBuildings(state))];
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
  const queue: Array<{ x: number; y: number; steps: number }> = [{ x: start.x, y: start.y, steps: 0 }];
  const seen = new Set<string>([key(start)]);
  let best = { x: start.x, y: start.y, steps: 0, gap: gapTo([start], goals) };
  while (queue.length) {
    const cur = queue.shift();
    if (!cur) break;
    const gap = gapTo([cur], goals);
    const closer = gap < best.gap
      || (gap === best.gap && cur.steps < best.steps)
      || (gap === best.gap && cur.steps === best.steps && (cur.x < best.x || (cur.x === best.x && cur.y < best.y)));
    if (closer) best = { x: cur.x, y: cur.y, steps: cur.steps, gap };
    if (cur.steps >= RAIDER_MOVE) continue;
    for (const dir of STEP_DIRS) {
      const nxt = { x: cur.x + dir.x, y: cur.y + dir.y, steps: cur.steps + 1 };
      const id = `${nxt.x},${nxt.y}`;
      if (seen.has(id) || !inb(nxt)) continue;
      const occ = occupant(state, nxt);
      if (occ !== "empty" && !eq(nxt, raider.pos)) continue;
      seen.add(id);
      queue.push(nxt);
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
  for (const cell of intent.projected) {
    const occ = occupant(state, cell);
    if (occ === "building") {
      const hit = livingBuildingAt(state, cell);
      if (hit && !struck.has(hit.id)) {
        struck.add(hit.id);
        hit.hp = Math.max(0, hit.hp - strike(RAIDER_ATK, BUILDING_DEF));
        refresh(state);
      }
      continue;
    }
    if (occ === "Assault" || occ === "Gunner" || occ === "Support") {
      hurtMech(state, occ, strike(RAIDER_ATK, STATS[occ].def));
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
    for (const c of cells) {
      const occ = occupant(state, c);
      if (occ === "building") {
        const hit = livingBuildingAt(state, c);
        if (hit && !struckBuildings.has(hit.id)) {
          struckBuildings.add(hit.id);
          hit.hp = Math.max(0, hit.hp - strike(BOSS_ATK, BUILDING_DEF));
          any = true;
          refresh(state);
        }
        continue;
      }
      if (occ === "empty" || occ === "cover" || occ === "boss" || occ === "rubble" || occ === "raider") continue;
      const target = mech(state, occ);
      if (!target) continue;
      hurtMech(state, occ, strike(BOSS_ATK, STATS[occ].def));
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
