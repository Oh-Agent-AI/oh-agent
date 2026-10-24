/**
 * GDD v1.3 mecha tactics, the City playable copy.
 * 2×2 footprint center is anchor + (1, 1). arena_plan is whole-pack.
 * cadence_ssw is smash, smash, sweep. smash_2 is not in v1.
 */

export const GDD_RULESET = "mecha-v1.3";
export const BOARD = 10;
export const MAX_TURNS = 15;
export const BOSS_HP = 40;
export const BOSS_ATK = 6;
export const BOSS_DEF = 3;

export type Cell = { x: number; y: number };
export type MechId = "Assault" | "Gunner" | "Support";
export const MECH_IDS: MechId[] = ["Assault", "Gunner", "Support"];
export type CoverPresetId = "covers_sparse_mid" | "covers_diag_corridor" | "covers_twin_clusters";
export type BossScriptId = "stationary_smash" | "cadence_ssw";
export type BossSkill = "smash" | "sweep" | "skip";
export type Phase = "enemy_prepare" | "player_plan" | "resolving_boss" | "finished";
export type Outcome = "victory" | "defeat_wipe" | "defeat_timeout";

export type Action =
  | { kind: "skip" }
  | { kind: "melee" }
  | { kind: "shoot" }
  | { kind: "charge" }
  | { kind: "pierce" }
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

export type MatchState = {
  ruleset: typeof GDD_RULESET;
  preset: CoverPresetId;
  script: BossScriptId;
  covers: Cell[];
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
  mechs?: Array<{ id: MechId; pos: Cell }>;
  boss?: Cell;
}): MatchState {
  const deploy = standardDeploy();
  const placed = opts.mechs ?? deploy.mechs;
  return {
    ruleset: GDD_RULESET,
    preset: opts.preset,
    script: opts.script,
    covers: (opts.covers ?? COVERS[opts.preset]).map((c) => ({ ...c })),
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

function mech(state: MatchState, id: MechId): Mech | undefined {
  return state.mechs.find((m) => m.id === id && m.hp > 0);
}

function isCover(state: MatchState, c: Cell): boolean {
  return state.covers.some((k) => eq(k, c));
}

type Occ = "empty" | "cover" | "boss" | MechId;

function occupant(state: MatchState, c: Cell): Occ {
  if (!inb(c)) return "empty";
  if (state.boss.hp > 0 && onFootprint(state.boss.anchor, c)) return "boss";
  const who = living(state).find((m) => eq(m.pos, c));
  if (who) return who.id;
  if (isCover(state, c)) return "cover";
  return "empty";
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

function refresh(state: MatchState) {
  if (state.outcome) return;
  if (state.boss.hp <= 0) {
    state.outcome = "victory";
    state.phase = "finished";
  } else if (living(state).length === 0) {
    state.outcome = "defeat_wipe";
    state.phase = "finished";
  }
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
    if (!inb(nc) || isCover(state, nc)) {
      hurtBoss(state, 2);
      refresh(state);
      return false;
    }
    if (onFootprint(anchor, nc)) continue;
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
  if (!inb(dest) || isCover(state, dest)) {
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
  const occ = occupant(state, dest);
  if (occ !== "empty") {
    hurtMech(state, id, 2);
    if (occ !== "cover" && occ !== "boss") hurtMech(state, occ, 2);
    if (occ === "boss") hurtBoss(state, 2);
    refresh(state);
    return false;
  }
  m.pos = dest;
  return true;
}

function meleeBoss(state: MatchState, id: MechId, bonus: number) {
  const m = mech(state, id);
  if (!m) return;
  const from = m.pos;
  hurtBoss(state, strike(STATS[id].atk + bonus, BOSS_DEF));
  refresh(state);
  if (state.boss.hp > 0) tryTranslateBoss(state, knockbackFromAttacker(from, state.boss.anchor));
}

function shootBoss(state: MatchState, id: MechId) {
  if (!mech(state, id)) return;
  hurtBoss(state, strike(STATS[id].atk, BOSS_DEF));
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
    if (occ === "cover") {
      covers += 1;
      if (covers > ignoreCovers) return false;
    } else if (occ !== "empty" && !eq(c, to)) return false;
  }
  return true;
}

function aimBoss(state: MatchState, from: Cell): Cell | null {
  if (state.boss.hp <= 0) return null;
  let best: { d: number; c: Cell } | null = null;
  for (const c of footprint(state.boss.anchor)) {
    if (c.x !== from.x && c.y !== from.y) continue;
    const d = cheb(from, c);
    if (!best || d < best.d) best = { d, c };
  }
  return best?.c ?? null;
}

function canShot(state: MatchState, from: Cell, range: number, ignore: number): boolean {
  const aim = aimBoss(state, from);
  if (!aim) return false;
  const d = cheb(from, aim);
  if (d < 1 || d > range) return false;
  return los(state, from, aim, ignore);
}

export function legalActions(state: MatchState, id: MechId): Action[] {
  const m = mech(state, id);
  if (!m) return [{ kind: "skip" }];
  const stats = STATS[id];
  const out: Action[] = [{ kind: "skip" }];
  if (stats.melee && state.boss.hp > 0 && adjacentToFootprint(state.boss.anchor, m.pos)) {
    out.push({ kind: "melee" });
    if (id === "Assault" && m.cd === 0) out.push({ kind: "charge" });
  }
  if (stats.shoot > 0 && canShot(state, m.pos, stats.shoot, 0)) out.push({ kind: "shoot" });
  if (id === "Gunner" && m.cd === 0 && canShot(state, m.pos, stats.shoot, 1)) out.push({ kind: "pierce" });
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
    if (state.boss.hp <= 0 || !adjacentToFootprint(state.boss.anchor, m.pos)) return "not adjacent to boss";
    meleeBoss(state, id, action.kind === "charge" ? 2 : 0);
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
    if (!canShot(state, m.pos, stats.shoot, ignore)) return "shot blocked or out of range";
    shootBoss(state, id);
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
  if (occ !== "empty" && occ !== "cover" && occ !== "boss") return 3;
  if (occ === "cover") return 2;
  return 1;
}

function pickSmash(state: MatchState): Cell | null {
  let best: { t: number; c: Cell } | null = null;
  for (const c of adjacentCells(state.boss.anchor)) {
    const t = threat(state, c);
    if (!best || t > best.t || (t === best.t && (c.x < best.c.x || (c.x === best.c.x && c.y < best.c.y)))) best = { t, c };
  }
  return best?.c ?? null;
}

function pickSweep(state: MatchState): [Cell, Cell] | null {
  const cells = adjacentCells(state.boss.anchor);
  let best: { sum: number; mx: number; a: Cell; b: Cell } | null = null;
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const a = cells[i];
      const b = cells[j];
      if (manh(a, b) > 2) continue;
      const ta = threat(state, a);
      const tb = threat(state, b);
      const sum = ta + tb;
      const mx = Math.max(ta, tb);
      const [c0, c1] = a.x < b.x || (a.x === b.x && a.y <= b.y) ? [a, b] : [b, a];
      const better = !best || sum > best.sum || (sum === best.sum && mx > best.mx)
        || (sum === best.sum && mx === best.mx && (c0.x < best.a.x || (c0.x === best.a.x && (c0.y < best.a.y || (c0.y === best.a.y && c1.x < best.b.x || (c1.x === best.b.x && c1.y < best.b.y))))));
      if (better) best = { sum, mx, a: c0, b: c1 };
    }
  }
  return best ? [best.a, best.b] : null;
}

function smashIntent(state: MatchState, cell: Cell | null): Intent {
  if (!cell) return { skillId: "skip", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "planned" };
  const local = [{ x: cell.x - state.boss.anchor.x, y: cell.y - state.boss.anchor.y }];
  return { skillId: "smash", local, projected: inb(cell) ? [cell] : [], cdSweep: state.boss.cdSweep, status: inb(cell) ? "planned" : "void" };
}

export function bossPrepare(state: MatchState): Intent {
  if (state.phase !== "enemy_prepare" || state.boss.hp <= 0) {
    state.phase = state.boss.hp <= 0 ? "finished" : state.phase;
    return { skillId: "skip", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
  }
  let intent: Intent;
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
  state.boss.intent = intent;
  state.phase = "player_plan";
  state.revision += 1;
  return intent;
}

export function bossExecute(state: MatchState) {
  if (state.outcome || state.boss.hp <= 0) {
    refresh(state);
    return;
  }
  const intent = state.boss.intent;
  const skill = intent?.skillId ?? "skip";
  reproject(state);
  const cells = state.boss.intent?.projected ?? [];
  let any = false;
  if (intent && skill !== "skip" && intent.status !== "void") {
    for (const c of cells) {
      const occ = occupant(state, c);
      if (occ === "empty" || occ === "cover" || occ === "boss") continue;
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
