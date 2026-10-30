/**
 * GDD v1.4 mecha tactics, the City playable copy.
 * 2×2 footprint center is anchor + (1, 1). arena_plan is whole-pack.
 *
 * v1.4 整包契约（相对 v1.3：整包不再按提交顺序逐台结算，玩家排的顺序不影响结果）：
 *   1. 结算顺序固定为 MECH_IDS（突击→射手→支援），与 plan.items 排列无关。
 *   2. 移动同时：路径按出发局面算、队友互不阻挡，终点两两不同（允许跟随、互换），否则整包拒绝。
 *   3. 行动同时校验：在「全部移动完成、尚无行动」的局面上，每台行动必须在 legalActions 里，否则整包拒绝。
 *   4. 行动按规范顺序结算：执行者/目标已死，或被前面的击退弄得不再相邻/对齐，则落空——
 *      无效果、不耗冷却、记 fizzled 事件，整包不因落空被拒。
 *   5. 碰撞：大怪被推时脚印目标格上所有障碍一次结算（大怪只受一次 2，每个被撞单位各受 2）。
 *   6. threat：机甲 3，活楼 2，其余（空地/掩体/障碍/废墟）1。
 *   其余数值、地形、半步、敌方脚本与 v1.3 相同；推动大怪后预告随之平移（RULE-3）不变。
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
 *
 * 模块划分：board.ts（棋盘、地形、占位、寻路、事件接收口）→ combat.ts（行动、伤害、整包结算）→
 * enemy.ts（大怪/小怪脚本）→ 本文件（建局、回合入口，并原样再导出对外 API，导入路径不变）。
 * playTurn/previewPlan 同时要 validateAndApplyPlan 与 bossExecute，所以放这一层，避免 combat ↔ enemy 成环。
 */

import {
  BOARD, BOSS_HP, BUILDING_HP, COVERS, GDD_RULESET, MECH_IDS, RAIDER_HP, SIEGE_BUILDINGS, SIEGE_RAIDERS, STATS, footprint, inb, key, living, emit, noSpawn, swapEventSink,
  type ArenaPlan, type BossScriptId, type BuildingStake, type Cell, type CoverPresetId, type MatchState, type MechId, type PlanFault, type TerrainKind, type TurnEvent,
} from "./board";
import { validateAndApplyPlan } from "./combat";
import { movementSnapshot, presentationSnapshot, type PresentationStages } from "./board";
import { bossExecute, bossPrepare } from "./enemy";

export {
  BOARD, BOSS_ATK, BOSS_DEF, BOSS_HP, BOSS_MOVE, BUILDING_DEF, BUILDING_HP, COVERS, FLAT_SPAWN_MAX_DELTA, GDD_RULESET, MAX_TURNS, MECH_IDS, MOVE_QUANTUM,
  RAIDER_ATK, RAIDER_DEF, RAIDER_HP, RAIDER_MOVE, RELAXED_SPAWN_MAX_DELTA, SIEGE_BUILDINGS, SIEGE_RAIDERS, STATS_MOVE, TERRAIN_MOD,
  adjacentToFootprint, attackerCenter, footprintCenter, knockbackFromAttacker, livingBuildings, livingRaiders, livingStakeBuildings, living, moveBudget, pathDistance, pathRoute, movementPath,
  primaryAxis, stakeBuildings,
} from "./board";
export type {
  Action, ArenaPlan, Building, BuildingStake, BossScriptId, BossSkill, Cell, CoverPresetId, Intent, MatchState, MechId, MechOrder, MoverId, Outcome, Phase,
  PlanFault, PlanReject, Raider, TerrainKind, TurnEvent,
} from "./board";
export { bossDamageTo, buildingDamage, incomingDamage, legalActions, raiderDamageTo, validateAndApplyPlan } from "./combat";
export { bossExecute, bossPrepare, setScriptCounters } from "./enemy";


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

export function createMatch(opts: {
  preset: CoverPresetId;
  script: BossScriptId;
  covers?: Cell[];
  terrain?: TerrainKind[][];
  heights?: number[][];
  buildings?: Array<{ id: string; cells: Cell[]; hp?: number }>;
  obstacles?: Cell[];
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
    obstacles: (opts.obstacles ?? []).map((c) => ({ ...c })),
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

/** Mech cells and the boss footprint sit on land, with no cover and no building. */
export function spawnsAreOpenGround(state: MatchState): boolean {
  const blocked = new Set<string>();
  for (const c of state.covers) blocked.add(key(c));
  for (const c of state.obstacles ?? []) blocked.add(key(c));
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

// ---- 回合入口 ----

export type TurnResult =
  | { ok: true; state: MatchState; log: TurnEvent[]; presentationStages: PresentationStages | null }
  | { ok: false; fault: PlanFault };

/** 内部：在克隆上跑 校验 → 大怪结算 → 下回合准备，并在玩家行动之后、敌方结算之前取一次预告。 */
function runTurn(state: MatchState, plan: ArenaPlan, capturePresentation = false) {
  const next = structuredClone(state);
  const before = capturePresentation ? presentationSnapshot(state) : null;
  const log: TurnEvent[] = [];
  const outer = swapEventSink(log);
  try {
    const applied = validateAndApplyPlan(next, plan);
    if (!("ok" in applied)) return { ok: false as const, fault: applied };
    const afterMovement = before ? movementSnapshot(before, log) : null;
    const afterPlayer = capturePresentation ? presentationSnapshot(next) : null;
    let announced = false;
    const noteOutcome = () => {
      if (next.outcome && !announced) {
        announced = true;
        emit({ type: "outcome", outcome: next.outcome });
      }
    };
    noteOutcome();
    // 推动之后的预告：大怪被推会 reproject，小怪的预告不跟着动。
    // byActor 与合并列表同一时刻取样，悬停一只怪时不必再推演一遍。
    const { cells: telegraph, byActor: telegraphByActor } = collectTelegraphs(next);
    const hpBefore = Object.fromEntries(next.mechs.map((m) => [m.id, m.hp])) as Record<MechId, number>;
    if (next.phase === "resolving_boss") bossExecute(next);
    const afterEnemy = capturePresentation ? presentationSnapshot(next) : null;
    const hits = Object.fromEntries(MECH_IDS.map((id) => [id, Math.max(0, (hpBefore[id] ?? 0) - (next.mechs.find((m) => m.id === id)?.hp ?? 0))])) as Record<MechId, number>;
    noteOutcome();
    if (next.phase === "enemy_prepare") bossPrepare(next);
    noteOutcome();
    const afterPrepare = capturePresentation ? presentationSnapshot(next) : null;
    const presentationStages = before && afterMovement && afterPlayer && afterEnemy && afterPrepare
      ? { before, afterMovement, afterPlayer, afterEnemy, afterPrepare } : null;
    return { ok: true as const, state: next, log, telegraph, telegraphByActor, hits, presentationStages };
  } finally {
    swapEventSink(outer);
  }
}

/**
 * 一回合的唯一入口：校验并结算玩家整包，再走完大怪结算与下回合准备，
 * 调用方不用再看 phase。不修改传入的 state（内部克隆），拒绝时返回 fault、原 state 原样可用。
 * 成功时 state 已进入下一回合的 player_plan（或 finished）。log 按结算顺序。
 */
export function playTurn(state: MatchState, plan: ArenaPlan): TurnResult {
  const r = runTurn(state, plan, true);
  return r.ok ? { ok: true, state: r.state, log: r.log, presentationStages: r.presentationStages } : r;
}

/** 每只活着的敌人自己的预告格（推动之后各算各的）。合并列表见 cells，重叠格只留一份。 */
export function collectTelegraphs(state: MatchState): { cells: Cell[]; byActor: Record<string, Cell[]> } {
  const seen = new Set<string>();
  const cells: Cell[] = [];
  const byActor: Record<string, Cell[]> = {};
  const sources: Array<[string, MatchState["boss"]["intent"]]> = [
    ["boss", state.boss.intent],
    ...state.raiders.map((raider) => [raider.id, raider.intent] as [string, MatchState["boss"]["intent"]]),
  ];
  for (const [id, intent] of sources) {
    if (!intent || intent.skillId === "skip" || intent.status === "void") continue;
    const own: Cell[] = [];
    for (const c of intent.projected) {
      const copy = { x: c.x, y: c.y };
      own.push(copy);
      const idKey = key(copy);
      if (!seen.has(idKey)) {
        seen.add(idKey);
        cells.push({ ...copy });
      }
    }
    if (own.length) byActor[id] = own;
  }
  return { cells, byActor };
}

/**
 * 预览：在克隆上做与提交完全相同的试算，plan 可以不完整——
 * 没排的活机甲按「不动 + 待机」排在末尾，并列入 assumed，界面据此标「假设」。
 * telegraphAfter 是玩家行动之后（推动已生效）的预告格；hitsAfter 是本回合敌方结算里每台掉的血。
 * telegraphByActor 是同一时刻按敌人拆开的预告，给悬停归属用。
 */
export function previewPlan(
  state: MatchState,
  plan: ArenaPlan,
): { ok: true; telegraphAfter: Cell[]; telegraphByActor: Record<string, Cell[]>; hitsAfter: Record<MechId, number>; assumed: MechId[]; enemyOrder: Array<Extract<TurnEvent, { type: "enemy" }>> } | { ok: false; fault: PlanFault } {
  const named = new Set(plan.items.map((i) => i.mechId));
  const assumed = living(state).map((m) => m.id).filter((id) => !named.has(id));
  const full: ArenaPlan = {
    revision: plan.revision,
    items: [...plan.items, ...assumed.map((mechId) => ({ mechId, moveTo: null, action: { kind: "skip" as const } }))],
  };
  const r = runTurn(state, full);
  return r.ok ? { ok: true, telegraphAfter: r.telegraph, telegraphByActor: r.telegraphByActor, hitsAfter: r.hits, assumed, enemyOrder: r.log.filter((event): event is Extract<TurnEvent, { type: "enemy" }> => event.type === "enemy") } : r;
}
