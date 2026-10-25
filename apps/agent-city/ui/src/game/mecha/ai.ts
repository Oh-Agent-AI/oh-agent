/**
 * 机甲方脚本。Boss 仍走 rules.ts。
 * 搜索在提交前看完预告和敌方结算，所以会为输出走近，也会吃到挡路的预告格。
 * 有楼时，楼全毁和机甲全灭一样是输。
 */
import {
  BOARD, BOSS_HP, FLAT_SPAWN_MAX_DELTA, RAIDER_HP, bossExecute, footprintCenter, legalActions, living, livingStakeBuildings, moveBudget, pathDistance,
  validateAndApplyPlan,
  type Action, type ArenaPlan, type Cell, type MatchState, type MechId, type MechOrder,
} from "./rules";

function same(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

function threatened(state: MatchState, dest: Cell): boolean {
  if (state.boss.intent?.projected.some((c) => same(c, dest))) return true;
  return state.raiders.some((raider) => raider.hp > 0 && raider.intent?.projected.some((c) => same(c, dest)));
}

function mechAt(state: MatchState, id: MechId) {
  const found = state.mechs.find((m) => m.id === id);
  if (!found) throw new Error(id);
  return found;
}

function holdPlan(state: MatchState): ArenaPlan {
  return {
    revision: state.revision,
    items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })),
  };
}

function reachable(state: MatchState, id: MechId): Cell[] {
  const me = mechAt(state, id);
  const cap = moveBudget(id);
  const out: Cell[] = [];
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const dist = pathDistance(state, me.pos, { x, y }, id);
      if (dist !== null && dist <= cap) out.push({ x, y });
    }
  }
  return out;
}

function orderOf(id: MechId, from: Cell, dest: Cell, action: Action): MechOrder {
  return { mechId: id, moveTo: same(from, dest) ? null : { x: dest.x, y: dest.y }, action: structuredClone(action) };
}

function localScore(state: MatchState, id: MechId, dest: Cell, action: Action): number {
  let score = 0;
  if (action.kind === "charge") score += 100;
  else if (action.kind === "melee") score += 80;
  else if (action.kind === "pierce") score += 60;
  else if (action.kind === "shoot") score += 50;
  else if (action.kind === "repair") score += 40;
  const center = footprintCenter(state.boss.anchor);
  if (boardChargesTerrain(state)) score -= approachCost(state, dest, center, id);
  else {
    score -= Math.abs(dest.x + 0.5 - center.x) + Math.abs(dest.y + 0.5 - center.y);
    if (id === "Assault") score -= Math.abs(dest.x + 0.5 - center.x);
  }
  if (threatened(state, dest)) score -= 8;
  return score;
}

type Opt = { dest: Cell; action: Action; score: number };

function optionsFor(state: MatchState, id: MechId): Opt[] {
  const origin = mechAt(state, id).pos;
  const center = footprintCenter(state.boss.anchor);
  const ranked = reachable(state, id)
    .filter((c) => !same(c, origin))
    .sort(rankToward(state, id, center, "center"));
  const dests = [origin, ...ranked.slice(0, 3)];
  const opts: Opt[] = [];
  for (const dest of dests) {
    const scratch = structuredClone(state);
    mechAt(scratch, id).pos = dest;
    for (const action of legalActions(scratch, id)) opts.push({ dest, action, score: localScore(state, id, dest, action) });
  }
  opts.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.dest.x !== b.dest.x) return a.dest.x - b.dest.x;
    if (a.dest.y !== b.dest.y) return a.dest.y - b.dest.y;
    const ka = JSON.stringify(a.action);
    const kb = JSON.stringify(b.action);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  const top = opts.slice(0, 5);
  const stay = opts.find((o) => same(o.dest, origin) && o.action.kind === "skip");
  if (stay && !top.some((o) => same(o.dest, stay.dest) && o.action.kind === "skip")) top.push(stay);
  return top;
}

function scorePlan(state: MatchState, plan: ArenaPlan): number | null {
  const clone = structuredClone(state);
  const result = validateAndApplyPlan(clone, plan);
  if (!("ok" in result)) return null;
  if (clone.phase === "resolving_boss") bossExecute(clone);
  const center = footprintCenter(clone.boss.anchor);
  let score = (BOSS_HP - clone.boss.hp) * 20;
  for (const raider of clone.raiders) score += (RAIDER_HP - raider.hp) * 12;
  for (const m of clone.mechs) {
    score += m.hp * 3;
    if (m.hp > 0) {
      score -= boardChargesTerrain(clone)
        ? approachCost(clone, m.pos, center, m.id)
        : Math.abs(m.pos.x + 0.5 - center.x) + Math.abs(m.pos.y + 0.5 - center.y);
    }
  }
  for (const b of clone.buildings) score += b.hp * 4;
  if (clone.outcome === "victory") score += 5000;
  if (clone.outcome === "defeat_wipe" || clone.outcome === "defeat_buildings") score -= 3000;
  if (clone.outcome === "defeat_timeout") score -= 100;
  return score;
}

/**
 * 攻坚：候选格朝 Boss。自动对战的默认打法，也是分布脚本里的 tunnel 对照。
 * 守楼是另一套，见 peelPlan。两套都留给玩家选，不互相覆盖。
 */
export function squadPlan(state: MatchState): ArenaPlan {
  const ids = living(state).map((m) => m.id);
  const groups = ids.map((id) => optionsFor(state, id));
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestKey = "";
  let bestPlan: ArenaPlan | null = null;
  const consider = (items: MechOrder[]) => {
    const plan = { revision: state.revision, items };
    const score = scorePlan(state, plan);
    if (score === null) return;
    const key = JSON.stringify(items);
    if (!bestPlan || score > bestScore || (score === bestScore && key < bestKey)) {
      bestScore = score;
      bestKey = key;
      bestPlan = plan;
    }
  };
  const walk = (index: number, items: MechOrder[]) => {
    if (index === ids.length) {
      consider(items);
      return;
    }
    const id = ids[index];
    if (!id) return;
    const from = mechAt(state, id).pos;
    for (const opt of groups[index] ?? []) walk(index + 1, items.concat(orderOf(id, from, opt.dest, opt.action)));
  };
  walk(0, []);
  consider(holdPlan(state).items);
  return bestPlan ?? holdPlan(state);
}

/** 和 squadPlan 同一份搜法。名字留给对照，避免和守楼混用。 */
export function bossTunnelPlan(state: MatchState): ArenaPlan {
  return squadPlan(state);
}

export type DoctrineId = "tunnel" | "peel";

const PEEL_WEIGHTS = { boss: 8, raider: 24, building: 16, mech: 3, victory: 5000, wipe: -3000, buildings: -4000, timeout: -150 };

const APPROACH_DIRS = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];

function manh(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 平地一步的花费处处相同，曼哈顿序就是半步序。有路、水、山或上坡时才改用半步。 */
function boardChargesTerrain(state: MatchState): boolean {
  if (state.terrain) {
    for (const row of state.terrain) for (const cell of row) if (cell !== "land") return true;
  }
  if (!state.heights) return false;
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      const h = state.heights[y]?.[x];
      if (h === undefined) continue;
      for (const dir of APPROACH_DIRS) {
        const next = state.heights[y + dir.y]?.[x + dir.x];
        if (next !== undefined && next - h > FLAT_SPAWN_MAX_DELTA) return true;
      }
    }
  }
  return false;
}

/** 从这一格走到焦点的半步。焦点被占时改走到它四周还能落脚的格子。 */
function approachCost(state: MatchState, from: Cell, focus: Cell, mover: MechId): number {
  const direct = pathDistance(state, from, focus, mover);
  if (direct !== null) return direct;
  let best = Number.POSITIVE_INFINITY;
  for (const dir of APPROACH_DIRS) {
    const dist = pathDistance(state, from, { x: focus.x + dir.x, y: focus.y + dir.y }, mover);
    if (dist !== null && dist < best) best = dist;
  }
  return best;
}

function rankToward(state: MatchState, id: MechId, focus: Cell, bias: "cell" | "center"): (a: Cell, b: Cell) => number {
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

function nearestStakeCell(state: MatchState, from: Cell): Cell | null {
  let best: Cell | null = null;
  let bestD = 99;
  for (const building of livingStakeBuildings(state)) {
    for (const cell of building.cells) {
      const dist = manh(from, cell);
      const closer = !best || dist < bestD || (dist === bestD && (cell.y < best.y || (cell.y === best.y && cell.x < best.x)));
      if (closer) {
        best = cell;
        bestD = dist;
      }
    }
  }
  return best;
}

/** 离一栋还活着的楼最近的袭扰者。没有袭扰者时退回 Boss 脚印中心。 */
function threatFocus(state: MatchState): { cell: Cell; id: string } {
  const raiders = state.raiders.filter((raider) => raider.hp > 0);
  if (raiders.length === 0) return { cell: footprintCenter(state.boss.anchor), id: "boss" };
  raiders.sort((a, b) => nearestBuildingDist(state, a.pos) - nearestBuildingDist(state, b.pos) || a.pos.y - b.pos.y || a.pos.x - b.pos.x || (a.id < b.id ? -1 : 1));
  const first = raiders[0];
  if (!first) return { cell: footprintCenter(state.boss.anchor), id: "boss" };
  return { cell: first.pos, id: first.id };
}

function peelLocalScore(state: MatchState, id: MechId, dest: Cell, action: Action): number {
  const focus = threatFocus(state);
  const aimed = action.kind !== "skip" && action.kind !== "repair" && (!("target" in action) || action.target === undefined || action.target === focus.id);
  let score = 0;
  if (aimed && action.kind === "charge") score += 100;
  else if (aimed && action.kind === "melee") score += 80;
  else if (aimed && action.kind === "pierce") score += 60;
  else if (aimed && action.kind === "shoot") score += 50;
  else if (action.kind === "repair") score += 20;
  else if (action.kind !== "skip") score += 8;
  score -= boardChargesTerrain(state) ? approachCost(state, dest, focus.cell, id) : manh(dest, focus.cell);
  if (threatened(state, dest)) score -= 8;
  return score;
}

function peelOptions(state: MatchState, id: MechId): Opt[] {
  const origin = mechAt(state, id).pos;
  const focus = threatFocus(state).cell;
  const ranked = reachable(state, id)
    .filter((cell) => !same(cell, origin))
    .sort(rankToward(state, id, focus, "cell"));
  const dests = [origin, ...ranked.slice(0, 3)];
  const opts: Opt[] = [];
  for (const dest of dests) {
    const scratch = structuredClone(state);
    mechAt(scratch, id).pos = dest;
    for (const action of legalActions(scratch, id)) opts.push({ dest, action, score: peelLocalScore(state, id, dest, action) });
  }
  opts.sort((a, b) => b.score - a.score || a.dest.x - b.dest.x || a.dest.y - b.dest.y || JSON.stringify(a.action).localeCompare(JSON.stringify(b.action)));
  const top = opts.slice(0, 5);
  const stay = opts.find((opt) => same(opt.dest, origin) && opt.action.kind === "skip");
  if (stay && !top.some((opt) => same(opt.dest, stay.dest) && opt.action.kind === "skip")) top.push(stay);
  return top;
}

function peelScore(state: MatchState, plan: ArenaPlan): number | null {
  const clone = structuredClone(state);
  const result = validateAndApplyPlan(clone, plan);
  if (!("ok" in result)) return null;
  if (clone.phase === "resolving_boss") bossExecute(clone);
  const focus = threatFocus(clone).cell;
  let score = (BOSS_HP - clone.boss.hp) * PEEL_WEIGHTS.boss;
  for (const raider of clone.raiders) score += (RAIDER_HP - raider.hp) * PEEL_WEIGHTS.raider;
  for (const mech of clone.mechs) {
    score += mech.hp * PEEL_WEIGHTS.mech;
    if (mech.hp > 0) {
      score -= boardChargesTerrain(clone) ? approachCost(clone, mech.pos, focus, mech.id) : manh(mech.pos, focus);
    }
  }
  for (const building of clone.buildings) score += building.hp * PEEL_WEIGHTS.building;
  if (clone.outcome === "victory") score += PEEL_WEIGHTS.victory;
  if (clone.outcome === "defeat_wipe") score += PEEL_WEIGHTS.wipe;
  if (clone.outcome === "defeat_buildings") score += PEEL_WEIGHTS.buildings;
  if (clone.outcome === "defeat_timeout") score += PEEL_WEIGHTS.timeout;
  return score;
}

/** 守楼：候选格和评分都朝离活楼最近的袭扰者。搜索宽度与攻坚相同。 */
export function peelPlan(state: MatchState): ArenaPlan {
  const ids = living(state).map((mech) => mech.id);
  const groups = ids.map((id) => peelOptions(state, id));
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestKey = "";
  let bestPlan: ArenaPlan | null = null;
  const consider = (items: MechOrder[]) => {
    const plan = { revision: state.revision, items };
    const score = peelScore(state, plan);
    if (score === null) return;
    const key = JSON.stringify(items);
    if (!bestPlan || score > bestScore || (score === bestScore && key < bestKey)) {
      bestScore = score;
      bestKey = key;
      bestPlan = plan;
    }
  };
  const walk = (index: number, items: MechOrder[]) => {
    if (index === ids.length) {
      consider(items);
      return;
    }
    const id = ids[index];
    if (!id) return;
    const from = mechAt(state, id).pos;
    for (const opt of groups[index] ?? []) walk(index + 1, items.concat(orderOf(id, from, opt.dest, opt.action)));
  };
  walk(0, []);
  consider(holdPlan(state).items);
  return bestPlan ?? holdPlan(state);
}

export function planForDoctrine(state: MatchState, doctrine: DoctrineId): ArenaPlan {
  return doctrine === "peel" ? peelPlan(state) : squadPlan(state);
}

export type DoctrineFocus = { kind: "boss" | "raider"; id: string; cell: Cell; building: Cell | null };

/** 面板和地面标记用的焦点。攻坚是 Boss 脚印中心。守楼是离要守的楼最近的袭扰者，并带上那栋楼的一格。 */
export function doctrineFocus(state: MatchState, doctrine: DoctrineId): DoctrineFocus {
  if (doctrine !== "peel") return { kind: "boss", id: "boss", cell: footprintCenter(state.boss.anchor), building: null };
  const threat = threatFocus(state);
  if (threat.id === "boss") return { kind: "boss", id: "boss", cell: threat.cell, building: null };
  return { kind: "raider", id: threat.id, cell: threat.cell, building: nearestStakeCell(state, threat.cell) };
}

export function doctrineFocusCells(state: MatchState, doctrine: DoctrineId): Cell[] {
  const focus = doctrineFocus(state, doctrine);
  if (focus.kind === "boss") {
    const anchor = state.boss.anchor;
    return [anchor, { x: anchor.x + 1, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }, { x: anchor.x + 1, y: anchor.y + 1 }];
  }
  const cells = [focus.cell];
  if (focus.building && !same(focus.building, focus.cell)) cells.push(focus.building);
  return cells;
}
