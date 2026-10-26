/**
 * 敌方脚本：大怪与小怪的准备（bossPrepare）和结算（bossExecute）、威胁度、目标选择、寻路步进。
 * 依赖 board.ts（棋盘与寻路）和 combat.ts（伤害、击退）；不依赖 rules.ts。
 */
import {
  BOSS_ATK, BOSS_MOVE, BUILDING_DEF, MAX_TURNS, MOVE_QUANTUM, RAIDER_ATK, RAIDER_MOVE, STATS, adjacentCells, dijkstra, emit, enemiesRemain, eq, footprint,
  inb, isObstacle, living, livingBuildingAt, livingRaiders, livingStakeBuildings, manh, mech, occupant, onFootprint, stepCost, water,
  type Building, type Cell, type Intent, type MatchState, type Raider, type TurnEvent,
} from "./board";
import { hurtMech, knockbackFromBoss, refresh, reproject, strike, tryPushMech } from "./combat";

function threat(state: MatchState, c: Cell): number {
  const occ = occupant(state, c);
  if (occ === "Assault" || occ === "Gunner" || occ === "Support") return 3;
  // RULE-5：掩体不再比空地招仇恨（以前没机甲可砸时大怪/小怪优先砸掩体）；只有活楼是目标。
  if (occ === "building") return 2;
  return 1;
}


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
  let best = { x: start.x, y: start.y, cost: 0, gap: objectiveGap(state, start) };
  dijkstra(
    start,
    (cur, nxt) => bossStepCost(state, cur, { x: nxt.x - cur.x, y: nxt.y - cur.y }),
    (cur, cost) => {
      const gap = objectiveGap(state, cur);
      if (closerThan(gap, cost, cur, best)) best = { x: cur.x, y: cur.y, cost, gap };
    },
    BOSS_MOVE * MOVE_QUANTUM,
  );
  state.boss.anchor = { x: best.x, y: best.y };
}

/** 寻路落点的择优：缺口更小，其次花费更小，再按 (x, y) 小者优先。大怪与小怪共用。 */
function closerThan(gap: number, cost: number, cur: Cell, best: { x: number; y: number; cost: number; gap: number }): boolean {
  return gap < best.gap
    || (gap === best.gap && cost < best.cost)
    || (gap === best.gap && cost === best.cost && (cur.x < best.x || (cur.x === best.x && cur.y < best.y)));
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
    if (isObstacle(state, c)) continue; // 障碍不是目标，砸它没有意义
    const t = threat(state, c);
    const d = approachDistance(state, c);
    if (!best || t > best.t || (t === best.t && (d < best.d || (d === best.d && cellBefore(c, best.c))))) best = { t, d, c };
  }
  return best?.c ?? null;
}

function pickSweep(state: MatchState): [Cell, Cell] | null {
  const cells = adjacentCells(state.boss.anchor).filter((c) => !isObstacle(state, c));
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
  let best = { x: start.x, y: start.y, cost: 0, gap: gapTo([start], goals) };
  dijkstra(
    start,
    (cur, nxt) => {
      if (!inb(nxt)) return null;
      const occ = occupant(state, nxt);
      if (occ !== "empty" && !eq(nxt, raider.pos)) return null;
      return stepCost(state, cur, nxt, "raider");
    },
    (cur, cost) => {
      const gap = gapTo([cur], goals);
      if (closerThan(gap, cost, cur, best)) best = { x: cur.x, y: cur.y, cost, gap };
    },
    RAIDER_MOVE * MOVE_QUANTUM,
  );
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
    if (isObstacle(state, c)) continue;
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
      if (occ === "empty" || occ === "obstacle" || occ === "cover" || occ === "boss" || occ === "rubble" || occ === "raider") continue;
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
