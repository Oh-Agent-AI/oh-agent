/**
 * 机甲战棋控制器（整改规格 §3.5，ARCH-1）：纯 TypeScript，没有 React、Three、engine。
 * 以前这些状态与逻辑都塞在 MechaBoard 的 MechaMatch 里（约 360 行），无法脱离组件测试，
 * 回合编排（validate → bossExecute → bossPrepare）还在界面里手写两遍。
 *
 * 约定：
 * - 回合推进只走 rules.playTurn；开局的第一次 bossPrepare 是「创建对局」的一部分，不算推进。
 * - 草稿合法性按 v1.4：可达格用 alliesPass 的路径距离；行动在「所有已排移动落定之后」的局面上算。
 *   改一台的移动只需重查终点冲突，并在新局面上重验别台的行动，作废的退回「未规划」并带原因。
 * - 提交前先 previewPlan：受击预测与预告格（推动之后）都来自它，不再用推动前的预告。
 * - 战斗动画只由 playTurn 返回的 TurnEvent 推出：被拒的包没有任何提示，落空的行动不播命中。
 * - 自动对战的规划按 (对局, 打法) 缓存：「展示」「结算」两拍用同一份计划，不再每回合算两次 AI。
 * - 订阅者拿到的快照在两次变更之间引用稳定（useSyncExternalStore 的要求）。
 */
import { PLAN_FAULT_CAUSES, gameText, planFaultText, type GameLocale } from "../gameCopy";
import type { MechaCombatCue } from "../../render/mecha/animation";
import { doctrineFocus, doctrineFocusCells, planForDoctrine, type DoctrineFocus, type DoctrineId } from "./ai";
import { buildHealthTimeline, type HealthTimeline } from "./healthTimeline";
import { buildPresentationChanges, type PresentationChanges } from "./presentationChanges";
import type { PresentationStages } from "./presentationSnapshot";
import { buildPresentationRoutes, type PresentationRoutes } from "./presentationRoutes";
import type { CityMechaSite } from "./citySite";
import { matchFromSite } from "./matchFromSite";
import {
  BOARD, bossPrepare, createMatch, incomingDamage, legalActions, living, moveBudget, pathDistance, playTurn, previewPlan,
  type Action, type ArenaPlan, type BossScriptId, type BuildingStake, type Cell, type CoverPresetId, type MatchState, type MechId,
  type PlanFault, type TurnEvent,
} from "./rules";

export type Draft = { moveTo: Cell | null; action: Action; explicit: boolean };
export type DraftMap = Record<MechId, Draft>;
export type TargetKind = Exclude<Action["kind"], "skip">;
export type TargetOption = { id: string; cells: Cell[] };
export type Planner = (state: MatchState, doctrine: DoctrineId) => ArenaPlan;
export type Beat = "show" | "resolve";

/** 界面能看到的故障：scope 区分「整包被拒」与「草稿里的行动被作废」，决定文案收尾。 */
export type ControllerFault = { mechId?: MechId; cause: NonNullable<PlanFault["cause"]>; scope: "rejected" | "draft"; reason?: string };

export type MechaPreview =
  | { ok: true; telegraphAfter: Cell[]; hitsAfter: Record<MechId, number>; assumed: MechId[] }
  | { ok: false; fault: PlanFault };

export type MechaControllerState = {
  locale: GameLocale;
  match: MatchState;
  site: CityMechaSite | null;
  preset: CoverPresetId;
  script: BossScriptId;
  stake: BuildingStake;
  doctrine: DoctrineId;
  draft: DraftMap;
  selected: MechId;
  targeting: TargetKind | null;
  auto: boolean;
  paused: boolean;
  beat: Beat;
  /** 已按当前语言翻好的提示；fault 存在时是故障句。 */
  notice: string | null;
  fault: ControllerFault | null;
  lastLog: TurnEvent[];
  combat: { id: number; actions: MechaCombatCue[]; reset?: true; healthTimeline?: HealthTimeline; presentationChanges?: PresentationChanges; presentationStages?: PresentationStages | null; presentationRoutes?: PresentationRoutes };
  preview: MechaPreview;
  // ---- 派生量（每次变更重算，视图只读）----
  /** 能下命令：没有自动/暂停、没有结局、在玩家计划阶段。 */
  interactive: boolean;
  reach: Cell[];
  /** 选中机甲在「所有已排移动落定后」局面上的合法行动。 */
  actions: Action[];
  targetOptions: TargetOption[];
  /** 每台的受击预测：预览成功用 hitsAfter（含推动后预告），否则退回推动前的 incomingDamage。 */
  hits: Record<MechId, number>;
  /** 每台到草稿落点的半步花费（面板显示用；alliesPass，与提交校验同口径）。 */
  stepCost: Record<MechId, number | null>;
  /** 预告格：预览成功用推动之后的，否则当前的。 */
  telegraph: Cell[];
  focus: DoctrineFocus;
  focusCells: Cell[];
  plannedCount: number;
  pendingIds: MechId[];
  packReady: boolean;
};

export type MechaControllerInit = {
  locale?: GameLocale;
  site?: CityMechaSite | null;
  preset?: CoverPresetId;
  script?: BossScriptId;
  stake?: BuildingStake;
  doctrine?: DoctrineId;
  /** 注入规划器：测试数调用次数，将来换 worker 版本也从这里进。 */
  planner?: Planner;
  /** 测试用：直接给一局（须已 bossPrepare），绕过 preset/script/site。 */
  match?: MatchState;
};

export type MechaRestartOptions = { preset?: CoverPresetId; script?: BossScriptId; site?: CityMechaSite | null; stake?: BuildingStake };

export type MechaController = {
  getState(): MechaControllerState;
  subscribe(fn: () => void): () => void;
  setLocale(locale: GameLocale): void;
  selectMech(id: MechId): void;
  setTargeting(kind: TargetKind | null): void;
  setMove(id: MechId, cell: Cell | null): void;
  setAction(id: MechId, action: Action): void;
  /** 格子点击的全部分支（选目标 / 换选机甲 / 移动）。 */
  clickCell(x: number, y: number): void;
  /** 按打法填入草稿（并把它设为当前打法）。 */
  applyDoctrine(doctrine?: DoctrineId): void;
  /** 只换打法；有可填的草稿时顺带按它重填（下拉框的行为）。 */
  setDoctrine(doctrine: DoctrineId): void;
  submit(): void;
  restart(opts?: MechaRestartOptions): void;
  startAuto(): void;
  stopAuto(): void;
  toggleAuto(): void;
  pause(): void;
  resume(): void;
  togglePause(): void;
  /** 自动对战推进一拍；由外部定时器驱动。 */
  tick(): void;
};

const FAULT_CAUSES = new Set<string>(PLAN_FAULT_CAUSES);

function same(a: Cell, b: Cell) {
  return a.x === b.x && a.y === b.y;
}

function footprintCells(anchor: Cell): Cell[] {
  return [anchor, { x: anchor.x + 1, y: anchor.y }, { x: anchor.x, y: anchor.y + 1 }, { x: anchor.x + 1, y: anchor.y + 1 }];
}

function telegraphsOf(state: MatchState): Cell[] {
  const cells = [...(state.boss.intent?.projected ?? [])];
  for (const raider of state.raiders) cells.push(...(raider.intent?.projected ?? []));
  return cells;
}

function blankDraft(state: MatchState): DraftMap {
  return {
    Assault: { moveTo: null, action: { kind: "skip" }, explicit: false },
    Gunner: { moveTo: null, action: { kind: "skip" }, explicit: false },
    Support: { moveTo: null, action: { kind: "skip" }, explicit: false },
    ...Object.fromEntries(living(state).map((m) => [m.id, { moveTo: null, action: { kind: "skip" as const }, explicit: false }])),
  } as DraftMap;
}

function draftFromPlan(state: MatchState, plan: ArenaPlan): DraftMap {
  const next = blankDraft(state);
  for (const item of plan.items) next[item.mechId] = { moveTo: item.moveTo, action: item.action, explicit: true };
  return next;
}

/** 规则层的 cause 可选；翻译表只认已登记的键，未知值落到 other，不让界面出现空句。 */
function causeOf(fault: Pick<PlanFault, "cause">): NonNullable<PlanFault["cause"]> {
  return fault.cause && FAULT_CAUSES.has(fault.cause) ? fault.cause : "other";
}

/**
 * 动画提示只来自结算事件（ARCH-9）：生效的 act → 该机甲的攻击/维修；enemy → 大怪/小怪的攻击。
 * 落空的 act（fizzled）和被拒的整包（没有 log）都不产生提示。
 */
export function cuesFromLog(log: TurnEvent[]): MechaCombatCue[] {
  const cues: MechaCombatCue[] = [];
  for (const event of log) {
    if (event.type === "act" && !event.fizzled && event.action !== "skip") {
      cues.push({ actor: event.mechId, action: event.action === "repair" ? "repair" : "attack", target: event.target });
    } else if (event.type === "enemy") {
      cues.push({ actor: event.actor, action: "attack" });
    }
  }
  return cues;
}

function freshMatch(preset: CoverPresetId, script: BossScriptId, site: CityMechaSite | null, stake: BuildingStake): MatchState {
  const state = site ? matchFromSite(site, { preset, script, stake }) : createMatch({ preset, script, stake });
  bossPrepare(state);
  return state;
}

export function createMechaController(init: MechaControllerInit = {}): MechaController {
  const planner: Planner = init.planner ?? planForDoctrine;
  const listeners = new Set<() => void>();

  let locale: GameLocale = init.locale ?? "zh-Hans";
  let site: CityMechaSite | null = init.site ?? null;
  let preset: CoverPresetId = init.preset ?? "covers_sparse_mid";
  let script: BossScriptId = init.script ?? "siege";
  let stake: BuildingStake = init.stake ?? "all";
  let doctrine: DoctrineId = init.doctrine ?? "tunnel";
  let match: MatchState = init.match ?? freshMatch(preset, script, site, stake);
  let selected: MechId = living(match)[0]?.id ?? "Assault";
  let targeting: TargetKind | null = null;
  let auto = false;
  let paused = false;
  let beat: Beat = "show";
  let noticeSource: string | null = null;
  let fault: ControllerFault | null = null;
  let lastLog: TurnEvent[] = [];
  let combat: MechaControllerState["combat"] = { id: 0, actions: [], reset: true };

  // 规划缓存：同一局面（对象身份即 revision 的承载）同一打法只算一次。
  let planCache: { match: MatchState; revision: number; doctrine: DoctrineId; plan: ArenaPlan } | null = null;
  const planFor = (state: MatchState, which: DoctrineId): ArenaPlan => {
    if (planCache && planCache.match === state && planCache.revision === state.revision && planCache.doctrine === which) return planCache.plan;
    const plan = planner(state, which);
    planCache = { match: state, revision: state.revision, doctrine: which, plan };
    return plan;
  };

  /** 新开一局时按打法填草稿；结算后的下一回合仍是空白，等玩家自己填。 */
  const openingDraft = (state: MatchState): DraftMap =>
    state.outcome || state.phase !== "player_plan" ? blankDraft(state) : draftFromPlan(state, planFor(state, doctrine));

  let draft: DraftMap = openingDraft(match);

  const finished = () => Boolean(match.outcome) || match.phase !== "player_plan";
  const canEdit = () => !auto && !paused && !finished();

  // ---- 草稿推演 ----

  const itemsOf = (state: MatchState, drafts: DraftMap, only?: { id: MechId; action: Action }): ArenaPlan["items"] =>
    living(state).map((m) => ({
      mechId: m.id,
      moveTo: drafts[m.id]?.moveTo ?? null,
      action: only ? (m.id === only.id ? only.action : { kind: "skip" as const }) : (drafts[m.id]?.explicit ? drafts[m.id]!.action : { kind: "skip" as const }),
    }));

  /** 这台机甲的这个行动，在「所有已排移动落定」的局面上是否成立。成立返回 null，否则是故障。 */
  const actionFault = (state: MatchState, drafts: DraftMap, id: MechId, action: Action): PlanFault | null => {
    if (action.kind === "skip") return null;
    const result = previewPlan(state, { revision: state.revision, items: itemsOf(state, drafts, { id, action }) });
    return result.ok ? null : result.fault;
  };

  const settledBoard = (state: MatchState, drafts: DraftMap): MatchState => {
    const scratch = structuredClone(state);
    for (const m of scratch.mechs) {
      const dest = m.hp > 0 ? drafts[m.id]?.moveTo : null;
      if (dest) m.pos = { ...dest };
    }
    return scratch;
  };

  const finalCell = (state: MatchState, drafts: DraftMap, id: MechId): Cell =>
    drafts[id]?.moveTo ?? living(state).find((m) => m.id === id)!.pos;

  const unplanned = (): Draft => ({ moveTo: null, action: { kind: "skip" }, explicit: false });

  // ---- 派生 ----

  const deriveReach = (): Cell[] => {
    const who = living(match).find((m) => m.id === selected);
    if (!who || match.phase !== "player_plan") return [];
    const cells: Cell[] = [];
    for (let y = 0; y < BOARD; y += 1) {
      for (let x = 0; x < BOARD; x += 1) {
        // v1.4：三台同时移动，队友不挡路；终点撞车另在 setMove 里查。
        const dist = pathDistance(match, who.pos, { x, y }, selected, { alliesPass: true });
        if (dist !== null && dist <= moveBudget(selected)) cells.push({ x, y });
      }
    }
    return cells;
  };

  const deriveTargets = (): TargetOption[] => {
    if (!targeting || !living(match).some((m) => m.id === selected)) return [];
    const options: TargetOption[] = targeting === "repair"
      ? living(match).filter((mech) => mech.id !== selected).map((mech) => ({ id: mech.id, cells: [{ ...mech.pos }] }))
      : [
        ...(match.boss.hp > 0 ? [{ id: "boss", cells: footprintCells(match.boss.anchor) }] : []),
        ...match.raiders.filter((raider) => raider.hp > 0).map((raider) => ({ id: raider.id, cells: [{ ...raider.pos }] })),
      ];
    return options.filter((option) => !actionFault(match, draft, selected, { kind: targeting, target: option.id } as Action));
  };

  const derivePreview = (): MechaPreview => {
    if (match.phase !== "player_plan") return { ok: false, fault: { code: "PLAN_PACK_REJECTED", reason: "not player_plan", cause: "other" } };
    // 只带「有排」的机甲：已选行动或已排移动；其余由 previewPlan 当假设待机。
    const items = itemsOf(match, draft).filter((item) => draft[item.mechId]?.explicit || draft[item.mechId]?.moveTo);
    return previewPlan(match, { revision: match.revision, items });
  };

  let snapshot: MechaControllerState;
  const rebuild = () => {
    const preview = derivePreview();
    const alive = living(match);
    const pendingIds = alive.filter((m) => !draft[m.id]?.explicit).map((m) => m.id);
    const hits = Object.fromEntries(alive.map((m) => [
      m.id,
      preview.ok ? preview.hitsAfter[m.id] ?? 0 : incomingDamage(match, m.id, draft[m.id]?.moveTo ?? m.pos),
    ])) as Record<MechId, number>;
    const stepCost = Object.fromEntries(alive.map((m) => [
      m.id,
      pathDistance(match, m.pos, draft[m.id]?.moveTo ?? m.pos, m.id, { alliesPass: true }),
    ])) as Record<MechId, number | null>;
    const notice = fault ? planFaultText(fault, locale, fault.scope) : noticeSource ? gameText(noticeSource, locale) : null;
    snapshot = {
      locale, match, site, preset, script, stake, doctrine, draft, selected, targeting, auto, paused, beat, notice, fault, lastLog, combat, preview,
      interactive: canEdit(),
      reach: deriveReach(),
      actions: living(match).some((m) => m.id === selected) ? legalActions(settledBoard(match, draft), selected) : [],
      targetOptions: deriveTargets(),
      hits,
      stepCost,
      telegraph: preview.ok ? preview.telegraphAfter : telegraphsOf(match),
      focus: doctrineFocus(match, doctrine),
      focusCells: doctrineFocusCells(match, doctrine),
      plannedCount: alive.length - pendingIds.length,
      pendingIds,
      packReady: pendingIds.length === 0,
    };
  };
  const commit = () => {
    rebuild();
    for (const fn of [...listeners]) fn();
  };

  const say = (source: string | null) => {
    noticeSource = source;
    fault = null;
  };

  // ---- 回合推进 ----

  const advance = (plan: ArenaPlan): boolean => {
    const result = playTurn(match, plan);
    if (!result.ok) {
      // 被拒：局面、草稿、动画提示都不动（ARCH-9），只报是哪一台、为什么。
      fault = { mechId: result.fault.mechId, cause: causeOf(result.fault), scope: "rejected", reason: result.fault.reason };
      noticeSource = null;
      return false;
    }
    const healthTimeline = buildHealthTimeline(match, result.state, result.log);
    const presentationRoutes = buildPresentationRoutes(match, result.log);
    const presentationChanges = result.presentationStages ? buildPresentationChanges(result.presentationStages, result.log) : undefined;
    match = result.state;
    lastLog = result.log;
    combat = { id: combat.id + 1, actions: cuesFromLog(result.log), healthTimeline, presentationChanges, presentationStages: result.presentationStages, presentationRoutes };
    draft = blankDraft(match);
    targeting = null;
    beat = "show";
    say(null);
    if (match.outcome) auto = false;
    const alive = living(match);
    if (!alive.some((m) => m.id === selected) && alive[0]) selected = alive[0].id;
    return true;
  };

  // ---- 命令 ----

  const setMove = (id: MechId, cell: Cell | null) => {
    if (!canEdit()) return;
    const who = living(match).find((m) => m.id === id);
    if (!who) return;
    const moveTo = cell && !same(cell, who.pos) ? { x: cell.x, y: cell.y } : null;
    if (moveTo) {
      const dist = pathDistance(match, who.pos, moveTo, id, { alliesPass: true });
      if (dist === null || dist > moveBudget(id)) {
        fault = { mechId: id, cause: "out_of_reach", scope: "draft" };
        noticeSource = null;
        commit();
        return;
      }
    }
    const dest = moveTo ?? who.pos;
    const next: DraftMap = { ...draft };
    const notes: ControllerFault[] = [];
    // 终点冲突：别台已排的终点正是这一格 → 那台退回未规划；别台原地不动占着这格 → 这一步不成立。
    for (const other of living(match)) {
      if (other.id === id || !same(finalCell(match, next, other.id), dest)) continue;
      if (next[other.id]?.moveTo) {
        next[other.id] = unplanned();
        notes.push({ mechId: other.id, cause: "occupied", scope: "draft" });
      } else {
        fault = { mechId: id, cause: "occupied", scope: "draft" };
        noticeSource = null;
        commit();
        return;
      }
    }
    const current = next[id];
    next[id] = { moveTo, action: current?.action ?? { kind: "skip" }, explicit: Boolean(current?.explicit) };
    // 局面变了：所有已选行动在新局面上重验，作废的退回未规划（自己的静默，别台的要告诉玩家原因）。
    for (const m of living(match)) {
      const row = next[m.id];
      if (!row?.explicit || row.action.kind === "skip") continue;
      const bad = actionFault(match, next, m.id, row.action);
      if (!bad) continue;
      next[m.id] = { moveTo: row.moveTo, action: { kind: "skip" }, explicit: false };
      if (m.id !== id) notes.push({ mechId: m.id, cause: causeOf(bad), scope: "draft", reason: bad.reason });
    }
    draft = next;
    say(null);
    fault = notes[0] ?? null;
    commit();
  };

  const setAction = (id: MechId, action: Action) => {
    if (!canEdit() || !living(match).some((m) => m.id === id)) return;
    const bad = actionFault(match, draft, id, action);
    if (bad) {
      fault = { mechId: id, cause: causeOf(bad), scope: "draft", reason: bad.reason };
      noticeSource = null;
      commit();
      return;
    }
    draft = { ...draft, [id]: { ...draft[id], action, explicit: true } };
    targeting = null;
    say(null);
    commit();
  };

  const fillFromDoctrine = (which: DoctrineId) => {
    doctrine = which;
    if (!match.outcome && match.phase === "player_plan") draft = draftFromPlan(match, planFor(match, which));
  };

  const controller: MechaController = {
    getState: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    setLocale(next) {
      if (next === locale) return;
      locale = next;
      commit();
    },
    selectMech(id) {
      if (auto || paused || !living(match).some((m) => m.id === id)) return;
      selected = id;
      targeting = null;
      commit();
    },
    setTargeting(kind) {
      if (kind !== null && !canEdit()) return;
      targeting = kind;
      say(null);
      commit();
    },
    setMove,
    setAction,
    clickCell(x, y) {
      if (!canEdit()) return;
      const cell = { x, y };
      if (targeting) {
        const option = deriveTargets().find((item) => item.cells.some((c) => same(c, cell)));
        if (!option) {
          say("这里不是合法目标，请点击地图上的高亮单位。");
          commit();
          return;
        }
        setAction(selected, { kind: targeting, target: option.id } as Action);
        return;
      }
      const occupant = living(match).find((m) => same(m.pos, cell));
      if (occupant && occupant.id !== selected) {
        controller.selectMech(occupant.id);
        return;
      }
      const who = living(match).find((m) => m.id === selected);
      if (!who || !snapshot.reach.some((k) => same(k, cell))) return;
      setMove(selected, same(who.pos, cell) ? null : cell);
    },
    applyDoctrine(which = doctrine) {
      if (!canEdit()) return;
      fillFromDoctrine(which);
      targeting = null;
      say(null);
      commit();
    },
    setDoctrine(which) {
      // 下拉框：换打法总是生效；有可填的草稿才重填（与旧界面一致，自动对战中也重填）。
      fillFromDoctrine(which);
      commit();
    },
    submit() {
      if (!canEdit() || pendingIdsNow().length > 0) return;
      advance({ revision: match.revision, items: itemsOf(match, draft) });
      commit();
    },
    restart(opts = {}) {
      preset = opts.preset ?? preset;
      script = opts.script ?? script;
      if (opts.site !== undefined) site = opts.site;
      stake = opts.stake ?? stake;
      match = freshMatch(preset, script, site, stake);
      combat = { id: combat.id + 1, actions: [], reset: true };
      lastLog = [];
      draft = openingDraft(match);
      selected = living(match)[0]?.id ?? "Assault";
      targeting = null;
      say(null);
      auto = false;
      paused = false;
      beat = "show";
      commit();
    },
    startAuto() {
      if (match.outcome) return;
      paused = false;
      beat = "show";
      auto = true;
      targeting = null;
      commit();
    },
    stopAuto() {
      auto = false;
      commit();
    },
    toggleAuto() {
      if (auto) controller.stopAuto();
      else controller.startAuto();
    },
    pause() {
      if (match.outcome || paused) return;
      paused = true;
      targeting = null;
      commit();
    },
    resume() {
      if (!paused) return;
      paused = false;
      commit();
    },
    togglePause() {
      if (paused) controller.resume();
      else controller.pause();
    },
    tick() {
      if (!auto || paused) return;
      if (match.outcome) {
        auto = false;
        commit();
        return;
      }
      if (match.phase !== "player_plan") return;
      // 两拍共用一份规划：展示拍填草稿，结算拍提交同一份计划。
      const plan = planFor(match, doctrine);
      if (beat === "show") {
        draft = draftFromPlan(match, plan);
        beat = "resolve";
        commit();
        return;
      }
      if (!advance(plan)) auto = false;
      commit();
    },
  };

  function pendingIdsNow(): MechId[] {
    return living(match).filter((m) => !draft[m.id]?.explicit).map((m) => m.id);
  }

  rebuild();
  return controller;
}
