/**
 * 战斗层：机甲行动、伤害、击退/碰撞、整包校验与结算（validateAndApplyPlan）。
 * 只依赖 board.ts。大怪/小怪脚本在 enemy.ts，回合入口 playTurn/previewPlan 在 rules.ts
 * （它要同时调 validateAndApplyPlan 与 bossExecute，放在这里就会让 combat ↔ enemy 成环）。
 */
import {
  BOSS_ATK, BOSS_DEF, BUILDING_DEF, MECH_IDS, RAIDER_ATK, RAIDER_DEF, STATS, adjacentToFootprint, cheb, emit, eq, footprint, footprintCenter,
  inb, knockbackFromAttacker, living, livingRaiders, enemiesRemain, mech, occupant, onFootprint, pathDistance, primaryAxis, raiderAt, moveBudget, blocksTerrain,
  shoveWall, stakeBuildings, livingStakeBuildings, swapEventSink, terrainAt, attackerCenter,
  type Action, type ArenaPlan, type Cell, type MatchState, type MechId, type PlanFault, type PlanReject, type Raider,
} from "./board";

export function knockbackFromBoss(anchor: Cell, target: Cell): Cell {
  const f = footprintCenter(anchor);
  const t = attackerCenter(target);
  return primaryAxis(t.x - f.x, t.y - f.y);
}

export function strike(atk: number, def: number): number {
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

export function hurtMech(state: MatchState, id: MechId, amount: number) {
  const m = state.mechs.find((x) => x.id === id);
  if (!m || m.hp <= 0) return;
  m.hp = Math.max(0, m.hp - amount);
}

export function hurtBoss(state: MatchState, amount: number) {
  if (state.boss.hp <= 0) return;
  state.boss.hp = Math.max(0, state.boss.hp - amount);
  if (state.boss.hp === 0 && state.boss.intent) {
    state.boss.intent.status = "void";
    state.boss.intent.projected = [];
  }
}

export function hurtRaider(raider: Raider, amount: number) {
  if (raider.hp <= 0) return;
  raider.hp = Math.max(0, raider.hp - amount);
  if (raider.hp === 0 && raider.intent) {
    raider.intent.status = "void";
    raider.intent.projected = [];
  }
}

export function refresh(state: MatchState) {
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

export function reproject(state: MatchState) {
  const intent = state.boss.intent;
  if (!intent || intent.skillId === "skip") return;
  const projected = intent.local.map((off) => ({ x: state.boss.anchor.x + off.x, y: state.boss.anchor.y + off.y })).filter(inb);
  intent.projected = projected;
  intent.status = projected.length === 0 ? "void" : "reprojected";
}

/**
 * RULE-4：先收集脚印目标格上的全部障碍，再一次结算。
 * 旧实现遇到第一个障碍就返回，机甲吃不吃友伤取决于脚印遍历顺序（墙在前则放过机甲）。
 * 现在：任一障碍 → 大怪只受一次 2，每个被撞的小怪/机甲各受 2，大怪不动；只发一条 shove 事件。
 */
export function tryTranslateBoss(state: MatchState, dir: Cell): boolean {
  if (state.boss.hp <= 0) return false;
  const anchor = state.boss.anchor;
  const dests = footprint(anchor).map((c) => ({ x: c.x + dir.x, y: c.y + dir.y }));
  let wall = false;
  const raiders = new Map<string, Raider>();
  const mechs = new Set<MechId>();
  for (const nc of dests) {
    if (!inb(nc) || blocksTerrain(state, nc) || shoveWall(state, nc)) {
      wall = true;
      continue;
    }
    if (onFootprint(anchor, nc)) continue;
    const rider = raiderAt(state, nc);
    if (rider) {
      raiders.set(rider.id, rider);
      continue;
    }
    const occ = occupant(state, nc);
    if (occ === "Assault" || occ === "Gunner" || occ === "Support") mechs.add(occ);
  }
  if (wall || raiders.size > 0 || mechs.size > 0) {
    const before = state.boss.hp;
    hurtBoss(state, 2);
    const hitIds: string[] = [];
    if (wall) hitIds.push("wall");
    for (const id of [...raiders.keys()].sort()) {
      hurtRaider(raiders.get(id)!, 2);
      hitIds.push(id);
    }
    for (const id of MECH_IDS) {
      if (!mechs.has(id)) continue;
      hurtMech(state, id, 2);
      hitIds.push(id);
    }
    emit({ type: "shove", unit: "boss", dir, hit: hitIds.join(","), damage: before - state.boss.hp });
    refresh(state);
    return false;
  }
  state.boss.anchor = { x: anchor.x + dir.x, y: anchor.y + dir.y };
  reproject(state);
  emit({ type: "shove", unit: "boss", dir, damage: 0 });
  return true;
}

export function tryPushMech(state: MatchState, id: MechId, dir: Cell): boolean {
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

export function meleeTargets(state: MatchState, pos: Cell): string[] {
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

export function enemyHp(state: MatchState, target: string): number {
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
    // 障碍不是掩体：穿射也穿不过。
    if (occ === "obstacle") return false;
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

export function shotTargets(state: MatchState, from: Cell, range: number, ignore: number): string[] {
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

export function applyAction(state: MatchState, id: MechId, action: Action): string | null {
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
function actionFaultCause(reason: string, action: Action, start: MatchState, trial: MatchState, shooter?: { id: MechId; pos: Cell }): NonNullable<PlanFault["cause"]> {
  if (reason === "mech is not alive") return "mech_dead";
  if (reason === "skill on cooldown") return "cooldown";
  const enemies = (s: MatchState) => new Set(["boss", ...s.raiders.map((r) => r.id)].filter((id) => enemyHp(s, id) > 0));
  const startAlive = enemies(start);
  const nowAlive = enemies(trial);
  // 有显式目标看它；没写目标（单目标省略）就看回合初活着的敌人有没有被前面的条目打死。
  if (reason === "shot blocked or out of range") {
    if ("target" in action && action.target !== undefined) {
      return startAlive.has(action.target) && !nowAlive.has(action.target) ? "target_gone" : "other";
    }
    // 没写目标：只有「回合初从射手移动后的位置本来打得到」的敌人现在死了才算目标没了。
    // 以前任何一个敌人死了都算，别处死的敌人会把真正的射程/视线问题误报成目标消失。
    if (!shooter) return "other";
    const probe = structuredClone(start);
    const who = probe.mechs.find((m) => m.id === shooter.id);
    if (!who) return "other";
    who.pos = { ...shooter.pos };
    const pierce = action.kind === "pierce" ? 1 : 0;
    return shotTargets(probe, who.pos, STATS[shooter.id].shoot, pierce).some((id) => !nowAlive.has(id)) ? "target_gone" : "other";
  }
  if (reason === "not adjacent to an enemy") {
    return "target" in action && action.target !== undefined && startAlive.has(action.target) && !nowAlive.has(action.target) ? "target_gone" : "not_adjacent";
  }
  if (reason === "repair target not adjacent") return "not_adjacent";
  return "other";
}

/** 跑 fn 期间关掉事件接收口：校验阶段的试探性 applyAction 不能往日志里写东西。 */
function quiet<T>(fn: () => T): T {
  const outer = swapEventSink(null);
  try {
    return fn();
  } finally {
    swapEventSink(outer);
  }
}

/** 某台在该局面下某类行动的合法目标 id（与 legalActions 同源函数）。 */
function kindTargets(state: MatchState, id: MechId, kind: "melee" | "charge" | "shoot" | "pierce"): string[] {
  const m = mech(state, id);
  if (!m) return [];
  if (kind === "melee" || kind === "charge") return meleeTargets(state, m.pos);
  return shotTargets(state, m.pos, STATS[id].shoot, kind === "pierce" ? 1 : 0);
}

/**
 * 行动是否在 legalActions 里（按 kind + target 匹配）。
 * 没写目标：legalActions 给了无目标版本（唯一目标）或恰好一个带目标版本才算；
 * 写了目标但 legalActions 给的是无目标版本（唯一目标被省略了）：用同源函数还原目标再比。
 */
function actionIsLegal(state: MatchState, id: MechId, action: Action): boolean {
  if (action.kind === "skip") return true;
  const legal = legalActions(state, id).filter((a) => a.kind === action.kind);
  if (action.kind === "repair") return legal.some((a) => a.kind === "repair" && a.target === action.target);
  const target = action.target;
  if (target === undefined) return legal.some((a) => !("target" in a) || a.target === undefined) || legal.length === 1;
  if (legal.some((a) => "target" in a && a.target === target)) return true;
  if (legal.some((a) => !("target" in a) || a.target === undefined)) return kindTargets(state, id, action.kind).includes(target);
  return false;
}

/** 未写目标的行动在校验时绑定到当时唯一的目标：结算时「目标死了」才有明确含义，不会悄悄改打别人。 */
function bindTarget(state: MatchState, id: MechId, action: Action): Action {
  if (action.kind === "skip" || action.kind === "repair" || action.target !== undefined) return action;
  const only = kindTargets(state, id, action.kind);
  return only.length === 1 ? { kind: action.kind, target: only[0] } : action;
}

/** 落空原因（结算时才出现的情形）：只在 applyAction 拒绝后调用，用于 fizzled 事件的 cause。 */
function fizzleCause(state: MatchState, id: MechId, action: Action, reason: string): NonNullable<PlanFault["cause"]> {
  if (reason === "mech is not alive") return "mech_dead";
  if (reason === "skill on cooldown") return "cooldown";
  if (action.kind === "repair") return mech(state, action.target) ? "not_adjacent" : "target_gone";
  if (action.kind === "skip") return "other";
  if (action.target !== undefined && enemyHp(state, action.target) <= 0) return "target_gone";
  if (action.kind === "shoot" || action.kind === "pierce") return "out_of_reach";
  return "not_adjacent";
}

/**
 * v1.4 契约（见文件头）：与 plan.items 的排列无关，三步——
 *   1) 移动同时校验并落位；2) 在移动后的局面上同时校验每台行动是否合法；
 *   3) 按 MECH_IDS 顺序结算行动，落空不拒包。
 * 任何一条在 1)/2) 不满足整包拒绝，state 不动。拒绝时附 mechId/index（plan.items 里的位置）/cause。
 * 旧版（v1.3）按提交顺序逐台结算，同一组合法选择因排列不同被拒，是 RULE-1/2 的根因。
 */
export function validateAndApplyPlan(state: MatchState, plan: ArenaPlan): { ok: true } | PlanReject {
  if (state.phase !== "player_plan") return { code: "PLAN_PACK_REJECTED", reason: "not player_plan", cause: "other" };
  if (plan.revision !== state.revision) return { code: "STALE_REVISION", reason: "revision mismatch", cause: "other" };
  const alive = living(state).map((m) => m.id);
  const seen = new Set(plan.items.map((i) => i.mechId));
  if (seen.size !== plan.items.length || seen.size !== alive.length || alive.some((id) => !seen.has(id))) {
    return { code: "NEED_ALL_OR_CONFIRM", reason: "pack must name every living mech once", cause: "other" };
  }
  const canonical = MECH_IDS.filter((id) => seen.has(id));
  const itemOf = (id: MechId) => {
    const index = plan.items.findIndex((i) => i.mechId === id);
    return { item: plan.items[index]!, index };
  };
  const fault = (id: MechId, reason: string, cause: NonNullable<PlanFault["cause"]>): PlanReject => ({
    code: "PLAN_PACK_REJECTED", reason, mechId: id, index: itemOf(id).index, cause,
  });

  // 1) 移动：全部按出发局面算（队友不挡），再查终点两两不同。
  const finals = new Map<MechId, Cell>();
  for (const id of canonical) {
    const who = mech(state, id)!;
    const dest = itemOf(id).item.moveTo ?? who.pos;
    if (!eq(dest, who.pos)) {
      const dist = pathDistance(state, who.pos, dest, id, { alliesPass: true });
      if (dist === null) {
        const occ = occupant(state, dest);
        return occ === "empty" ? fault(id, "no path within move range", "out_of_reach") : fault(id, "destination occupied", "occupied");
      }
      if (dist > moveBudget(id)) return fault(id, "move exceeds move_range", "out_of_reach");
    }
    finals.set(id, { ...dest });
  }
  const claimed: MechId[] = [];
  for (const id of canonical) {
    const mine = finals.get(id)!;
    const clash = claimed.find((other) => eq(finals.get(other)!, mine));
    if (clash) {
      // 有一方没动时错在动的那台；都动则错在规范顺序靠后的。
      const culprit = eq(mine, mech(state, id)!.pos) ? clash : id;
      return fault(culprit, "destination occupied", "occupied");
    }
    claimed.push(id);
  }

  const trial = structuredClone(state);
  for (const id of canonical) {
    const who = mech(trial, id)!;
    const dest = finals.get(id)!;
    if (!eq(dest, who.pos)) {
      emit({ type: "move", mechId: id, from: { ...who.pos }, to: { ...dest } });
      who.pos = dest;
    }
  }

  // 2) 行动：在「全部移动完成、尚无行动」的局面上同时校验，所以界面的单台预检与提交一致。
  const actions = new Map<MechId, Action>();
  for (const id of canonical) {
    const action = itemOf(id).item.action;
    if (!actionIsLegal(trial, id, action)) {
      const probe = structuredClone(trial);
      const err = quiet(() => applyAction(probe, id, action)) ?? "action not legal";
      return fault(id, err, actionFaultCause(err, action, state, trial, { id, pos: { ...mech(trial, id)!.pos } }));
    }
    actions.set(id, bindTarget(trial, id, action));
  }

  // 3) 结算：规范顺序，轮到时重查。执行者/目标死了或被击退弄得不再成立 → 落空（不耗冷却、不拒包）。
  for (const id of canonical) {
    const action = actions.get(id)!;
    if (action.kind === "skip") continue;
    const err = applyAction(trial, id, action);
    if (err) {
      emit({
        type: "act", mechId: id, action: action.kind, ...(action.target !== undefined ? { target: action.target } : {}),
        damage: 0, fizzled: true, cause: fizzleCause(trial, id, action, err),
      });
    }
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
