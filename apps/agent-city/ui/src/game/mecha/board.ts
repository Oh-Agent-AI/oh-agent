/**
 * 棋盘层：常量、类型、地形/高度、占位查询、单步花费、寻路。
 * 不认识战斗与敌方脚本；combat.ts / enemy.ts / rules.ts 都从这里往上建（依赖单向，无运行时环）。
 * 事件接收口（eventSink）也只在这里存在一份，所有模块经 emit / swapEventSink 共用。
 */

import { prepareSwarmLink, reprojectSwarmLink, resolveSwarmLink, reconcileSwarmLink, linkedAttackBonus, NEURAL_LINK_BREAK_CONDITIONS, type NeuralLink, type SwarmIntent, type SwarmLinkState, type SwarmProjection } from "./skillSwarmLink";
import { PLANNED_SIGNATURE_SKILLS } from "./monsters/contracts";

export const GDD_RULESET = "mecha-v1.4";
/** Staged ruleset, not enabled by product, replay or remote transports. */
export const BUILDING_COLLISION_RULESET = "mecha-v1.5";
export type PveRuleset = typeof GDD_RULESET | typeof BUILDING_COLLISION_RULESET;
export const BOARD = 10;
export const MAX_TURNS = 15;
/** Shared health contract for L5 summoned swarm children. */
export const SWARM_CHILD_HP = 2;
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

export type DifficultyId = "easy" | "normal" | "hard";
export type EnemyStats = { bossHp: number; bossAtk: number; raiderHp: number; raiderAtk: number; raiderCount: number };
export const ENEMY_STATS: Record<DifficultyId, EnemyStats> = {
  easy: { bossHp: 36, bossAtk: 5, raiderHp: RAIDER_HP, raiderAtk: 2, raiderCount: 1 },
  normal: { bossHp: BOSS_HP, bossAtk: BOSS_ATK, raiderHp: RAIDER_HP, raiderAtk: RAIDER_ATK, raiderCount: 2 },
  hard: { bossHp: 48, bossAtk: 7, raiderHp: RAIDER_HP, raiderAtk: 4, raiderCount: 4 },
};

export function enemyStatsOf(state: Pick<MatchState, "difficulty">): EnemyStats {
  return ENEMY_STATS[state.difficulty ?? "normal"];
}

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
export type AssaultTerrainSafety = { unsafeCells: Cell[]; unsafeEdges: Array<{ from: Cell; to: Cell }> };
/** 水挡住脚。山地能爬、挡住射击。道路是陆地里铺过的那一格，增益后更便宜。 */
export type TerrainKind = "land" | "water" | "mountain" | "road";
export type MechId = "Assault" | "Gunner" | "Support";
export type MoverId = MechId | "boss" | "raider";
export const MECH_IDS: MechId[] = ["Assault", "Gunner", "Support"];
export type CoverPresetId = "covers_sparse_mid" | "covers_diag_corridor" | "covers_twin_clusters";
export type BossScriptId = "stationary_smash" | "cadence_ssw" | "raid_ssw" | "siege";
export const MONSTER_SPECIES_IDS = ["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "phase_stalker", "gravity_core", "swarm_mantle", "neural_weaver"] as const;
export type MonsterSpeciesId = (typeof MONSTER_SPECIES_IDS)[number];
export type MonsterContent = { speciesId: MonsterSpeciesId; contentVersion: 1 };
/** Implemented species view derived from the canonical planned skill table. */
export const MONSTER_SKILLS = Object.freeze(Object.fromEntries(
  MONSTER_SPECIES_IDS.map((speciesId) => [speciesId, PLANNED_SIGNATURE_SKILLS[speciesId]]),
) as Pick<typeof PLANNED_SIGNATURE_SKILLS, MonsterSpeciesId>);
export type BossSkill = "smash" | "sweep" | "skip" | "prism_frost" | typeof MONSTER_SKILLS[MonsterSpeciesId];
export type Phase = "deployment" | "enemy_prepare" | "player_plan" | "resolving_boss" | "finished";
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
  /** Original target anchor relative to the boss, never retargeted. */
  landingOffset?: Cell;
  /** L2 fixes direction and footprint lane; L4 binds to the boss itself. */
  direction?: Cell;
  lane?: 0 | 1;
  targetId?: "boss";
  shieldHits?: number;
  corrode?: CorrodeIntent;
  displacement?: DisplacementIntent;
  displacementProjection?: DisplacementProjection;
  /** Fixed absolute candidate set and its latest legal projection. */
  swarm?: SwarmIntent;
  swarmOrigin?: Cell;
  swarmProjection?: SwarmProjection;
  local: Cell[];
  projected: Cell[];
  cdSweep: number;
  status: "planned" | "reprojected" | "void";
};

export type Mech = { id: MechId; pos: Cell; hp: number; cd: number; skillUsed: boolean };
export type Boss = { anchor: Cell; hp: number; cdSweep: number; cadence: number; intent: Intent | null; shield?: { kind: "prism_guard"; hits: 1 } };

/** Rescue-only behavior; omitted entirely from legacy and remote match states. */
export type RaiderRole = "siege" | "interceptor";
export type Raider = { id: string; pos: Cell; hp: number; intent: Intent | null; role?: RaiderRole;
  /** Provisional local-only metadata; remote projection must reject, not strip it. */
  summon?: { parentId: "boss"; speciesId: "swarm_child"; expiresAtRound: number } };

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

export type RescueMission = { kind: "rescue:v1"; target: Cell };
export type LocalMissionId = RescueMission["kind"];

/** Local L8 event journal is authoritative rule evidence, not presentation events. */
export type NeuralJournalEvent =
  | { type: "link_created"; round: number; actionId: string; link: NeuralLink }
  | { type: "link_broken"; round: number; linkId: string; reason: "source_dead" | "target_dead" | "side_changed" | "expired" | "out_of_range" | "finished" }
  | { type: "link_void"; round: number; actionId: string; targetId: string; reason: "actor_dead" | "target_dead" | "out_of_range" | "finished" };
export type NeuralLedger = { version: 1; nextLinkId: number; links: NeuralLink[]; resolvedActions: string[]; pending: SwarmIntent | null; journal: NeuralJournalEvent[] };

export type MatchState = {
  ruleset: PveRuleset;
  /** Explicit experimental local status ledger; absent from legacy matches. */
  statusEncounter?: { schema: "mecha-status-encounter:v1"; statuses: import("./statusEffects").Status[] };
  preset: CoverPresetId;
  script: BossScriptId;
  difficulty?: DifficultyId;
  /** Optional, local-only mission; absent on all legacy and remote games. */
  mission?: RescueMission;
  /** Experimental, explicit local-only monster selection. */
  monsterContent?: MonsterContent;
  /** Local-only hazard ledger; absent from legacy and other species. */
  corrode?: CorrodeState;
  /** Local-only bounded summon identity/action ledger. */
  swarm?: { version: 1; nextSpawnId: number; resolvedActions: string[] };
  /** Local-only L8 link identity, fixed declaration, and ordered rule evidence. */
  neural?: NeuralLedger;
  covers: Cell[];
  /** 站点里画着却不可用的陆地格（场景楼、斜放楼）。和 covers 不同：挡路、挡射击且不能被穿射、
   *  不可被攻击、不参与 threat。缺省空，空时所有规则与加这个字段之前逐字节一致。 */
  obstacles: Cell[];
  /** 每格一种面。缺省全是陆地，标准盘因此和没记地形时走法相同。 */
  terrain: TerrainKind[][];
  /** 格心的地面高度。上坡花费只看相邻两格的差。 */
  heights: number[][];
  assaultTerrainSafety?: AssaultTerrainSafety;
  buildings: Building[];
  /** 缺省 all。frontage 只把正交贴着道路的楼算进楼毁和敌方目标。 */
  stake: BuildingStake;
  raiders: Raider[];
  mechs: Mech[];
  boss: Boss;
  turn: number;
  phase: Phase;
  /** Serializable map-declared deployment area; draft placements belong to the controller. */
  deployment?: { zone: Cell[]; reservedCells: Cell[] };
  revision: number;
  outcome: Outcome | null;
};

/** Validate the original object before cloning or selecting supported fields. */
export function assertMonsterContent(state: { monsterContent?: MatchState["monsterContent"]; mission?: unknown }): void {
  const property = Object.getOwnPropertyDescriptor(state, "monsterContent");
  if (!property) {
    if ("monsterContent" in state) throw new Error("unsupported_monster_content");
    return;
  }
  if (!("value" in property)) throw new Error("unsupported_monster_content");
  const content: unknown = property.value;
  if (content === undefined) return;
  if (!property.enumerable) throw new Error("unsupported_monster_content");
  if (content === null || typeof content !== "object" || Array.isArray(content)) throw new Error("unsupported_monster_content");
  const proto = Object.getPrototypeOf(content);
  const keys = Reflect.ownKeys(content);
  const species = Object.getOwnPropertyDescriptor(content, "speciesId");
  const version = Object.getOwnPropertyDescriptor(content, "contentVersion");
  if ((proto !== Object.prototype && proto !== null) || keys.length !== 2 ||
      !species?.enumerable || !("value" in species) || !(typeof species.value === "string" && Object.hasOwn(MONSTER_SKILLS, species.value)) ||
      !version?.enumerable || !("value" in version) || version.value !== 1) {
    throw new Error("unsupported_monster_content");
  }
  if (state.mission !== undefined) throw new Error("monster_content_rescue_unsupported");
}

/** Do not allow a legacy match or a supplied enemy plan to inject an experimental skill. */
export function assertMonsterState(state: MatchState, intent: Intent | null = state.boss.intent): void {
  assertMonsterContent(state);
  if (state.statusEncounter !== undefined && (state.ruleset !== BUILDING_COLLISION_RULESET || state.statusEncounter?.schema !== "mecha-status-encounter:v1")) throw new Error("unsupported_status_encounter");
  // Only the local swarm rules may admit summoned Raiders. Reject markers in
  // legacy matches before cloning instead of treating them as ordinary units.
  // Presence (including inherited/undefined markers) is intentional.
  const isSwarm = state.monsterContent?.speciesId === "swarm_mantle";
  const isNeural = state.monsterContent?.speciesId === "neural_weaver";
  if (isNeural ? !validNeuralState(state, intent) : "neural" in state) throw new Error("unsupported_neural_state");
  if (!isSwarm) {
    if (state.swarm !== undefined || state.raiders.some(raider => "summon" in raider)) throw new Error("unsupported_swarm_state");
  } else {
    const ledger = state.swarm;
    if (!ledger || ledger.version !== 1 || !Number.isSafeInteger(ledger.nextSpawnId) || ledger.nextSpawnId < 0 ||
        ledger.nextSpawnId > MAX_TURNS * 2 || !Array.isArray(ledger.resolvedActions) || ledger.resolvedActions.length > MAX_TURNS ||
        ledger.resolvedActions.some(id => typeof id !== "string" || !/^split:(?:[1-9]|1[0-5])$/.test(id)) ||
        new Set(ledger.resolvedActions).size !== ledger.resolvedActions.length ||
        ledger.resolvedActions.some((id, i) => Number(id.slice(6)) > state.turn ||
          (i > 0 && Number(ledger.resolvedActions[i - 1]!.slice(6)) >= Number(id.slice(6)))) ||
        ledger.nextSpawnId > ledger.resolvedActions.length * 2 ||
        new Set(state.raiders.map(r => r.id)).size !== state.raiders.length) throw new Error("unsupported_swarm_state");
    let summons = 0;
    for (const r of state.raiders) {
      if (!("summon" in r)) {
        if (r.id.startsWith("swarm:") || r.id === "boss" || MECH_IDS.some(id => r.id === `mech:${id}`)) throw new Error("unsupported_swarm_state");
        continue;
      }
      const marker = Object.getOwnPropertyDescriptor(r, "summon");
      if (!marker || !("value" in marker) || !marker.value || typeof marker.value !== "object") throw new Error("unsupported_swarm_state");
      const m = marker.value, match = /^swarm:(0|[1-9][0-9]*)$/.exec(r.id);
      if (!match || Number(match[1]) >= ledger.nextSpawnId || m.parentId !== "boss" || m.speciesId !== "swarm_child" ||
          !Number.isSafeInteger(m.expiresAtRound) || m.expiresAtRound < 3 || m.expiresAtRound > MAX_TURNS + 2 ||
          m.expiresAtRound > state.turn + 2 ||
          !Number.isSafeInteger(r.hp) || r.hp < 0 || r.hp > SWARM_CHILD_HP || ++summons > 4 ||
          ((state.phase === "player_plan" || state.phase === "enemy_prepare") &&
            (r.hp === 0 || m.expiresAtRound <= state.turn))) throw new Error("unsupported_swarm_state");
    }
  }
  if ((state.monsterContent?.speciesId === "porous_shaper") !== (state.corrode !== undefined)) throw new Error("unsupported_monster_content");
  if (state.boss.shield !== undefined && (state.monsterContent?.speciesId !== "prism_warden" ||
      !state.boss.shield || typeof state.boss.shield !== "object" || state.boss.shield.kind !== "prism_guard" || state.boss.shield.hits !== 1)) throw new Error("unsupported_monster_content");
  if (isSwarm && intent?.skillId === "split_swarm" && intent.status !== "void" && !validSwarmBinding(state, intent)) {
    throw new Error("unsupported_swarm_state");
  }
  const frostAllowed = state.ruleset === BUILDING_COLLISION_RULESET && state.statusEncounter?.schema === "mecha-status-encounter:v1" &&
    state.monsterContent?.speciesId === "prism_warden" && intent?.skillId === "prism_frost";
  if (intent && intent.skillId !== "skip" && (state.monsterContent
      ? MONSTER_SKILLS[state.monsterContent.speciesId] !== intent.skillId && !frostAllowed
      : intent.skillId !== "smash" && intent.skillId !== "sweep")) {
    throw new Error("unsupported_monster_content");
  }
}

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
  | { type: "status_effect"; schema: "mecha-status-event:v1"; event: import("./statusEffects").StatusEvent; effects?: HealthEffect[] }
  | { type: "status_hit"; schema: "mecha-status-hit:v1"; skill: "spore_leap" | "ring_pierce" | "prism_frost"; source: "boss"; target: MechId; cell: Cell }
  | { type: "gravity_collision"; schema: "mecha-gravity-collision:v1"; target: MechId; cell: Cell; blocker: { kind: "boss" | "mech" | "raider" | "building" | "obstacle"; id: string } }
  | { type: "status_boundary"; schema: "mecha-status-event:v1"; phase: "player_end" }
  | { type: "neural_event"; event: NeuralJournalEvent }
  | { type: "raider_spawn"; sequence: number; unit: PresentationUnit }
  | { type: "raider_remove"; sequence: number; unit: PresentationUnit; reason: "death" | "expired" }
  | { type: "move"; mechId: MechId; from: Cell; to: Cell }
  | { type: "act"; mechId: MechId; action: Action["kind"]; target?: string; damage: number; fizzled?: boolean; cause?: PlanFault["cause"]; effects?: HealthEffect[] }
  | { type: "boss_move"; from: Cell; to: Cell; sequence?: number }
  | { type: "monster_displacement"; skill: "phase_swap" | "gravity_well"; moves: Array<{ unit: string; from: Cell; to: Cell }>; sequence?: number }
  | { type: "corrode_field"; change: "created" | "expired"; field: CorrodeField; reason?: "duration" | "finished"; sequence?: number }
  | { type: "corrode_tick"; fieldId: string; unit: string; damage: number; effects?: HealthEffect[] }
  | { type: "monster_status"; actor: "boss"; status: "prism_guard"; change: "applied" | "absorbed" | "expired"; remaining: 0 | 1; sequence?: number }
  | { type: "shove"; unit: "boss" | MechId; dir: Cell; hit?: string; damage: number; effects?: HealthEffect[]; sequence?: number }
  | { type: "enemy"; actor: string; skill: BossSkill; cells: Cell[]; damage: number; effects?: HealthEffect[] }
  | { type: "outcome"; outcome: Outcome };

/** Immutable combat snapshots used to place actors while presenting an accepted turn. */

export type PresentationUnit = { id: string; pos: Cell; hp: number };
export type PresentationSnapshot = {
  statusEncounter?: MatchState["statusEncounter"];
  boss: { anchor: Cell; hp: number; shield?: { kind: "prism_guard"; hits: 1 } };
  mechs: Array<PresentationUnit & { id: MechId }>;
  raiders: PresentationUnit[];
  buildings: Array<{ id: string; hp: number }>;
  outcome: Outcome | null;
  corrode?: CorrodeState;
  neural?: NeuralLedger;
};
export type PresentationStages = {
  before: PresentationSnapshot;
  afterMovement: PresentationSnapshot;
  afterPlayer: PresentationSnapshot;
  afterEnemy: PresentationSnapshot;
  afterPrepare: PresentationSnapshot;
  /** L8-only positions captured with the committed turn; not a replay authorization. */
  neuralLogIndices?: number[];
};

export function presentationSnapshot(state: MatchState): PresentationSnapshot {
  return {
    ...(state.statusEncounter ? { statusEncounter: structuredClone(state.statusEncounter) } : {}),
    boss: { anchor: { ...state.boss.anchor }, hp: state.boss.hp,
      ...(state.boss.shield ? { shield: { ...state.boss.shield } } : {}) },
    mechs: state.mechs.map((m) => ({ id: m.id, pos: { ...m.pos }, hp: m.hp })),
    raiders: state.raiders.map((r) => ({ id: r.id, pos: { ...r.pos }, hp: r.hp })),
    buildings: state.buildings.map((b) => ({ id: b.id, hp: b.hp })),
    outcome: state.outcome,
    ...(state.corrode ? { corrode: structuredClone(state.corrode) } : {}),
    ...(state.neural ? { neural: structuredClone(state.neural) } : {}),
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
  if (e.type === "raider_spawn" || e.type === "raider_remove") e.sequence = nextPresentationOrder()!;
  if (e.type === "shove" || e.type === "boss_move" || e.type === "monster_status" || e.type === "monster_displacement" || e.type === "corrode_field") e.sequence = nextPresentationOrder();
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

export function assaultTerrainBlocked(state: MatchState, from: Cell, to: Cell): boolean {
  const safety = state.assaultTerrainSafety;
  if (!safety) return false;
  return safety.unsafeCells.some((cell) => eq(cell, to)) || safety.unsafeEdges.some((edge) =>
    (eq(edge.from, from) && eq(edge.to, to)) || (eq(edge.from, to) && eq(edge.to, from)));
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

/** Experimental leap checks every cell directly: occupant() masks objects under the boss. */
function sporeAnchorClear(state: MatchState, anchor: Cell): boolean {
  return footprint(anchor).every((c) => inb(c) && !water(state, c)
    && !state.covers.some((v) => eq(v, c)) && !state.obstacles.some((v) => eq(v, c))
    && !state.buildings.some((b) => b.cells.some((v) => eq(v, c)))
    && !state.mechs.some((m) => m.hp > 0 && eq(m.pos, c))
    && !state.raiders.some((r) => r.hp > 0 && eq(r.pos, c)));
}

/** Only one or two continuous orthogonal footprint translations are allowed. */
export function sporeLeapReachable(state: MatchState, target: Cell): boolean {
  const start = state.boss.anchor;
  const distance = manh(start, target);
  if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || distance < 1 || distance > 2) return false;
  for (const dir of STEP_DIRS) {
    const first = { x: start.x + dir.x, y: start.y + dir.y };
    if (!sporeAnchorClear(state, first)) continue;
    if (eq(first, target)) return true;
    for (const nextDir of STEP_DIRS) {
      const second = { x: first.x + nextDir.x, y: first.y + nextDir.y };
      if (eq(second, target) && sporeAnchorClear(state, second)) return true;
    }
  }
  return false;
}

/** One bound ray from a footprint edge, nearest cell first; solid terrain stops it. */
export function ringPierceCells(state: MatchState, anchor: Cell, direction: Cell, lane: 0 | 1): Cell[] {
  if (!((Math.abs(direction.x) === 1 && direction.y === 0) || (Math.abs(direction.y) === 1 && direction.x === 0)) || (lane !== 0 && lane !== 1)) return [];
  const start = direction.x !== 0
    ? { x: anchor.x + (direction.x > 0 ? 2 : -1), y: anchor.y + lane }
    : { x: anchor.x + lane, y: anchor.y + (direction.y > 0 ? 2 : -1) };
  const cells: Cell[] = [];
  for (let c = start; inb(c); c = { x: c.x + direction.x, y: c.y + direction.y }) {
    if (terrainAt(state, c) === "mountain" || state.obstacles.some((v) => eq(v, c)) || state.covers.some((v) => eq(v, c))) break;
    cells.push(c);
  }
  return cells;
}

/** Orthogonal perimeter in stable x/y order, with no diagonal corners. */
export function sporeLeapCells(anchor: Cell): Cell[] {
  const cells: Cell[] = [];
  for (const cell of footprint(anchor)) for (const dir of STEP_DIRS) {
    const next = { x: cell.x + dir.x, y: cell.y + dir.y };
    if (inb(next) && !onFootprint(anchor, next) && !cells.some((v) => eq(v, next))) cells.push(next);
  }
  return cells.sort((a, b) => a.x - b.x || a.y - b.y);
}

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
  previous?: Map<string, Cell>,
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
      previous?.set(key(nxtCell), { x: cur.x, y: cur.y });
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
  }, Number.POSITIVE_INFINITY, undefined, (cur, nxt) => { parents.set(key(nxt), { x: cur.x, y: cur.y }); });
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
function route(state: MatchState, from: Cell, to: Cell, mover: MoverId, opts?: { alliesPass?: boolean }): { cost: number; cells: Cell[] } | null {
  if (eq(from, to)) return { cost: 0, cells: [{ ...from }] };
  if (!inb(to) || water(state, to)) return null;
  const passes = (occ: Occ) => occ === "empty" || occ === mover || (opts?.alliesPass === true && MECH_IDS.includes(occ as MechId));
  const destOcc = occupant(state, to);
  if (!passes(destOcc)) return null;
  let found: number | null = null;
  const previous = new Map<string, Cell>();
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
    Number.POSITIVE_INFINITY,
    previous,
  );
  if (found === null) return null;
  const cells = [{ ...to }];
  while (!eq(cells[cells.length - 1]!, from)) cells.push(previous.get(key(cells[cells.length - 1]!))!);
  return { cost: found, cells: cells.reverse() };
}

export function pathDistance(state: MatchState, from: Cell, to: Cell, mover: MoverId, opts?: { alliesPass?: boolean }): number | null {
  return route(state, from, to, mover, opts)?.cost ?? null;
}

export function movementPath(state: MatchState, from: Cell, to: Cell, mover: MoverId, opts?: { alliesPass?: boolean }): Cell[] | null {
  return route(state, from, to, mover, opts)?.cells ?? null;
}


/** Local rescue uses the same occupancy and movement cost as pack movement.
 * Check a bounded static route after initial enemy preparation; moving enemies
 * can change the route on later turns. */
export function rescueReachable(state: MatchState, target: Cell): boolean {
  return living(state).some(m => {
    const distance = pathDistance(state, m.pos, target, m.id, { alliesPass: true });
    return distance !== null && distance <= moveBudget(m.id) * 3;
  });
}

/** Deterministic empty target in the prepared opening, preferring the forward area. */
export function selectRescueTarget(state: MatchState, deploymentZone: Cell[] = []): Cell {
  const candidates: Cell[] = [];
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const cell = { x, y };
    if (occupant(state, cell) !== "empty" || living(state).some(m => eq(m.pos, cell))) continue;
    if (rescueReachable(state, cell)) candidates.push(cell);
  }
  candidates.sort((a, b) => Number(deploymentZone.some(c => eq(c, a))) - Number(deploymentZone.some(c => eq(c, b))) || a.y - b.y || a.x - b.x);
  if (!candidates.length) throw new Error("rescue_unavailable");
  return candidates[0]!;
}

// Pure bounded rule primitive; hosted here so core imports remain one-way.
export type CorrodeCell = { x: number; y: number };
export type CorrodeField = {
  id: string; sourceId: string; cell: CorrodeCell;
  createdRound: number; expiresAfterRound: number;
};
export type CorrodeState = {
  version: 1; width: number; height: number; nextRound: number; fields: CorrodeField[];
};
export type CorrodeWorld = {
  round: number; blocked: CorrodeCell[]; casterAlive: boolean; finished: boolean;
};
export type CorrodeRequest = { sourceId: string; target: CorrodeCell; durationTurns: number };
export type CorrodeVoidReason = "finished" | "caster_dead" | "stale" | "outside_board" |
  "blocked" | "already_corroded" | "capacity";
export type CorrodeIntent = {
  skillId: "corrode_cell"; version: 1; sourceId: string; target: CorrodeCell;
  durationTurns: number; preparedRound: number; status: "planned" | "reprojected" | "void";
  projected: CorrodeCell | null; reason: CorrodeVoidReason | null;
};
export type CorrodeUnit = { id: string; cell: CorrodeCell; hp: number };
export type CorrodeEvent =
  | { type: "corrode_created"; field: CorrodeField }
  | { type: "corrode_void"; sourceId: string; target: CorrodeCell; reason: CorrodeVoidReason }
  | { type: "corrode_trigger"; fieldId: string; unitId: string; damage: 1 }
  | { type: "corrode_expired"; fieldId: string; reason: "duration" | "finished" };


export const { createCorrodeState, prepareCorrode, reprojectCorrode, resolveCorrode, endCorrodeTurn } = (() => {
const MAX_BOARD = 64;
const MAX_FIELDS = 64;
const MAX_UNITS = 256;
const MAX_ROUND = 1_000_000;
const MAX_DURATION = 5;
const VOID_REASONS: readonly CorrodeVoidReason[] = [
  "finished", "caster_dead", "stale", "outside_board", "blocked", "already_corroded", "capacity",
];

function invalid(): never { throw new Error("invalid_corrode_input"); }

// Read descriptors instead of properties, so accessors and hidden/unknown data
// cannot be silently normalized into a different, apparently valid snapshot.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !desc.enumerable || !("value" in desc)) return invalid();
    result[key] = desc.value;
  }
  return result;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) return invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, String(i));
    if (!desc || !desc.enumerable || !("value" in desc)) return invalid();
    result.push(desc.value);
  }
  return result;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) return invalid();
  return value;
}
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function id(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : invalid();
}
function cell(value: unknown): CorrodeCell {
  const v = record(value, ["x", "y"]);
  // Out-of-board targets remain representable for explicit void projection.
  return { x: integer(v.x, -MAX_BOARD, MAX_BOARD), y: integer(v.y, -MAX_BOARD, MAX_BOARD) };
}
function same(a: CorrodeCell, b: CorrodeCell): boolean { return a.x === b.x && a.y === b.y; }
function inside(c: CorrodeCell, s: CorrodeState): boolean { return c.x >= 0 && c.y >= 0 && c.x < s.width && c.y < s.height; }
function cellKey(c: CorrodeCell): string { return `${c.x},${c.y}`; }
function fieldId(round: number, c: CorrodeCell): string { return `corrode:${round}:${c.x}:${c.y}`; }
function compareFields(a: CorrodeField, b: CorrodeField): number {
  return a.cell.y - b.cell.y || a.cell.x - b.cell.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function parseState(value: unknown): CorrodeState {
  const v = record(value, ["version", "width", "height", "nextRound", "fields"]);
  if (v.version !== 1) return invalid();
  const state: CorrodeState = {
    version: 1, width: integer(v.width, 1, MAX_BOARD), height: integer(v.height, 1, MAX_BOARD),
    nextRound: integer(v.nextRound, 1, MAX_ROUND + 1), fields: [],
  };
  const cells = new Set<string>();
  for (const item of list(v.fields, MAX_FIELDS)) {
    const f = record(item, ["id", "sourceId", "cell", "createdRound", "expiresAfterRound"]);
    const c = cell(f.cell);
    const createdRound = integer(f.createdRound, 1, state.nextRound);
    const expiresAfterRound = integer(f.expiresAfterRound, state.nextRound, MAX_ROUND);
    if (!inside(c, state) || expiresAfterRound < createdRound || expiresAfterRound - createdRound >= MAX_DURATION || cells.has(cellKey(c))) return invalid();
    const expectedId = fieldId(createdRound, c);
    if (f.id !== expectedId) return invalid();
    cells.add(cellKey(c));
    state.fields.push({ id: expectedId, sourceId: id(f.sourceId), cell: c, createdRound, expiresAfterRound });
  }
  state.fields.sort(compareFields);
  return state;
}
function parseWorld(value: unknown, state: CorrodeState): CorrodeWorld {
  const v = record(value, ["round", "blocked", "casterAlive", "finished"]);
  const round = integer(v.round, 1, MAX_ROUND + 1);
  const finished = bool(v.finished);
  if (round !== state.nextRound || (round > MAX_ROUND && !finished)) return invalid();
  const blocked = list(v.blocked, state.width * state.height).map(cell);
  const seen = new Set<string>();
  for (const c of blocked) {
    if (!inside(c, state) || seen.has(cellKey(c))) return invalid();
    seen.add(cellKey(c));
  }
  return { round, blocked, casterAlive: bool(v.casterAlive), finished };
}
function parseRequest(value: unknown, round: number): CorrodeRequest {
  const v = record(value, ["sourceId", "target", "durationTurns"]);
  const durationTurns = integer(v.durationTurns, 1, MAX_DURATION);
  if (round + durationTurns - 1 > MAX_ROUND) return invalid();
  return { sourceId: id(v.sourceId), target: cell(v.target), durationTurns };
}
function parseIntent(value: unknown): CorrodeIntent {
  const v = record(value, ["skillId", "version", "sourceId", "target", "durationTurns", "preparedRound", "status", "projected", "reason"]);
  if (v.skillId !== "corrode_cell" || v.version !== 1) return invalid();
  const preparedRound = integer(v.preparedRound, 1, MAX_ROUND);
  const request = parseRequest({ sourceId: v.sourceId, target: v.target, durationTurns: v.durationTurns }, preparedRound);
  if (v.status !== "planned" && v.status !== "reprojected" && v.status !== "void") return invalid();
  const projected = v.projected === null ? null : cell(v.projected);
  if (v.status === "void") {
    if (projected !== null || typeof v.reason !== "string" || !VOID_REASONS.includes(v.reason as CorrodeVoidReason)) return invalid();
  } else if (v.reason !== null || projected === null || !same(projected, request.target)) return invalid();
  return { skillId: "corrode_cell", version: 1, ...request, preparedRound, status: v.status,
    projected, reason: v.reason as CorrodeVoidReason | null };
}
function parseUnits(value: unknown, state: CorrodeState): CorrodeUnit[] {
  const seen = new Set<string>();
  const units = list(value, MAX_UNITS).map((item) => {
    const v = record(item, ["id", "cell", "hp"]);
    const unit = { id: id(v.id), cell: cell(v.cell), hp: integer(v.hp, 0, 1_000_000) };
    if (!inside(unit.cell, state) || seen.has(unit.id)) return invalid();
    seen.add(unit.id);
    return unit;
  });
  return units.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function reasonFor(state: CorrodeState, world: CorrodeWorld, intent: CorrodeIntent): CorrodeVoidReason | null {
  if (world.finished) return "finished";
  if (!world.casterAlive) return "caster_dead";
  if (intent.preparedRound !== world.round) return "stale";
  if (intent.status === "void") return intent.reason;
  if (!inside(intent.target, state)) return "outside_board";
  if (world.blocked.some((c) => same(c, intent.target))) return "blocked";
  if (state.fields.some((f) => same(f.cell, intent.target))) return "already_corroded";
  if (state.fields.length >= MAX_FIELDS) return "capacity";
  return null;
}
function project(state: CorrodeState, world: CorrodeWorld, intent: CorrodeIntent, status: "planned" | "reprojected"): CorrodeIntent {
  const reason = reasonFor(state, world, intent);
  return { ...intent, target: { ...intent.target }, status: reason ? "void" : status,
    projected: reason ? null : { ...intent.target }, reason };
}

/** Create an empty ledger at the actual host round; all parameters are required. */
function createCorrodeState(width: number, height: number, round: number): CorrodeState {
  integer(round, 1, MAX_ROUND);
  return parseState({ version: 1, width, height, nextRound: round, fields: [] });
}
/** Target choice is made by the caller before this function; no retargeting occurs. */
function prepareCorrode(state: CorrodeState, world: CorrodeWorld, request: CorrodeRequest): CorrodeIntent {
  const s = parseState(state), w = parseWorld(world, s), r = parseRequest(request, w.round);
  const intent: CorrodeIntent = { skillId: "corrode_cell", version: 1, ...r, preparedRound: w.round,
    status: "planned", projected: { ...r.target }, reason: null };
  return project(s, w, intent, "planned");
}
function reprojectCorrode(state: CorrodeState, world: CorrodeWorld, intent: CorrodeIntent): CorrodeIntent {
  const s = parseState(state), w = parseWorld(world, s), i = parseIntent(intent);
  return project(s, w, i, "reprojected");
}
function resolveCorrode(state: CorrodeState, world: CorrodeWorld, intent: CorrodeIntent): {
  state: CorrodeState; intent: CorrodeIntent; events: CorrodeEvent[];
} {
  const s = parseState(state), w = parseWorld(world, s), i = project(s, w, parseIntent(intent), "reprojected");
  if (i.reason !== null) return { state: s, intent: i, events: [{ type: "corrode_void", sourceId: i.sourceId, target: { ...i.target }, reason: i.reason }] };
  const field: CorrodeField = { id: fieldId(w.round, i.target), sourceId: i.sourceId, cell: { ...i.target },
    createdRound: w.round, expiresAfterRound: w.round + i.durationTurns - 1 };
  s.fields.push(field);
  s.fields.sort(compareFields);
  return { state: s, intent: i, events: [{ type: "corrode_created", field: { ...field, cell: { ...field.cell } } }] };
}
/**
 * Call once at the end of state.nextRound, after host outcome checks. Events are
 * ordered by row, column, then unit ID. Trigger events are damage *requests*,
 * not applied HP changes. Death of the caster alone does not remove old fields.
 * A finished world clears fields without damage or advancing the round; repeated
 * finished calls are harmless. For a live world, repeated/skipped rounds reject.
 * Round 1,000,000 can finish normally; its successor is a terminal-only sentinel.
 */
function endCorrodeTurn(state: CorrodeState, world: CorrodeWorld, units: CorrodeUnit[]): {
  state: CorrodeState; events: CorrodeEvent[];
} {
  const s = parseState(state), w = parseWorld(world, s), actors = parseUnits(units, s);
  const events: CorrodeEvent[] = [];
  if (w.finished) {
    for (const field of s.fields) events.push({ type: "corrode_expired", fieldId: field.id, reason: "finished" });
    s.fields = [];
    return { state: s, events };
  }
  const retained: CorrodeField[] = [];
  for (const field of s.fields) {
    for (const unit of actors) if (unit.hp > 0 && same(unit.cell, field.cell)) {
      events.push({ type: "corrode_trigger", fieldId: field.id, unitId: unit.id, damage: 1 });
    }
    if (field.expiresAfterRound === w.round) events.push({ type: "corrode_expired", fieldId: field.id, reason: "duration" });
    else retained.push(field);
  }
  s.fields = retained;
  s.nextRound += 1;
  return { state: s, events };
}

return { createCorrodeState, prepareCorrode, reprojectCorrode, resolveCorrode, endCorrodeTurn };
})();

// Pure bounded rule primitive; hosted here so core imports remain one-way.
export type DisplacementCell = Readonly<{ x: number; y: number }>;
export type DisplacementEntity = Readonly<{
  id: string; position: DisplacementCell; size: 1 | 2; alive: boolean;
}>;
export type DisplacementState = Readonly<{
  width: number; height: number; terminal: boolean;
  water: readonly DisplacementCell[]; obstacles: readonly DisplacementCell[];
  entities: readonly DisplacementEntity[];
  /** Present only for experimental status rules; eligible fixed collision cells. */
  collisionTerrain?: readonly Readonly<{ cell: DisplacementCell; kind: "building" | "obstacle"; id: string }>[];
}>;
export type DisplacementRequest = Readonly<{
  skillId: "phase_swap" | "gravity_well"; actorId: string;
  targetIds: readonly string[];
  /** Gravity range is Manhattan distance between the closest footprint cells. */
  radius: number;
  /** Gravity attempts exactly this many one-cell steps per target. */
  steps: number;
  /** Ordered, relative to the actor's post-displacement top-left anchor. */
  attackOffsets: readonly DisplacementCell[];
}>;
export type DisplacementEffect = Readonly<{
  entityId: string; status: "move" | "void"; reason: string | null;
  from: DisplacementCell | null; to: DisplacementCell | null;
  /** Includes the attempted blocked cell, if any; excludes the starting cell. */
  path: readonly DisplacementCell[];
  /** Explicit blocker evidence exists only in versioned status encounters. */
  collision?: Readonly<{ cell: DisplacementCell; blocker: { kind: "boss" | "mech" | "raider" | "building" | "obstacle"; id: string } }>;
}>;
export type DisplacementProjection = Readonly<{
  status: "reprojected" | "void"; reason: string | null;
  effects: readonly DisplacementEffect[]; attackCells: readonly DisplacementCell[];
}>;
export type DisplacementIntent = Readonly<{
  contentVersion: 1; request: DisplacementRequest;
  /** Declaration is historical evidence, never a source for retargeting. */
  declared: DisplacementProjection;
}>;
export type DisplacementPrepareResult =
  | Readonly<{ status: "planned"; intent: DisplacementIntent }>
  | Readonly<{ status: "void"; reason: string; projection: DisplacementProjection }>;
export type DisplacementResolution =
  | Readonly<{ status: "resolved"; effects: readonly DisplacementEffect[]; attackCells: readonly DisplacementCell[] }>
  | Readonly<{ status: "void"; reason: string; effects: readonly []; attackCells: readonly [] }>;


export const { prepareDisplacement, reprojectDisplacement, resolveDisplacement } = (() => {
const cell = (p: DisplacementCell): DisplacementCell => ({ x: p.x, y: p.y });
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const validCell = (value: unknown): value is DisplacementCell => {
  if (!value || typeof value !== "object") return false;
  const p = value as DisplacementCell;
  return integer(p.x) && integer(p.y);
};
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const key = (p: DisplacementCell) => `${p.x},${p.y}`;
const same = (a: DisplacementCell, b: DisplacementCell) => a.x === b.x && a.y === b.y;
function footprint(p: DisplacementCell, size: number): DisplacementCell[] {
  const cells: DisplacementCell[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) cells.push({ x: p.x + x, y: p.y + y });
  return cells;
}
function inside(state: DisplacementState, p: DisplacementCell): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < state.width && p.y < state.height;
}
function validateState(state: DisplacementState): string | null {
  if (!state || !integer(state.width) || !integer(state.height) || state.width < 1 || state.height < 1 ||
      state.width > 128 || state.height > 128 || typeof state.terminal !== "boolean" ||
      !Array.isArray(state.water) || !Array.isArray(state.obstacles) || !Array.isArray(state.entities) ||
      state.water.length > 16384 || state.obstacles.length > 16384 || state.entities.length > 128) return "invalid_state";
  if (state.terminal) return "terminal";
  if ([...state.water, ...state.obstacles].some((p) => !validCell(p) || !inside(state, p))) return "invalid_state";
  if (state.collisionTerrain !== undefined) {
    if (!Array.isArray(state.collisionTerrain) || state.collisionTerrain.length > 16384) return "invalid_state";
    const obstacleKeys = new Set(state.obstacles.map(key)), collisionKeys = new Set<string>();
    for (const item of state.collisionTerrain) {
      if (!item || (item.kind !== "building" && item.kind !== "obstacle") || !validId(item.id) ||
          !validCell(item.cell) || !inside(state, item.cell) || !obstacleKeys.has(key(item.cell)) || collisionKeys.has(key(item.cell))) return "invalid_state";
      collisionKeys.add(key(item.cell));
    }
  }
  const ids = new Set<string>(), occupied = new Set<string>();
  for (const entity of state.entities) {
    if (!entity || !validId(entity.id) || ids.has(entity.id) || !validCell(entity.position) ||
        (entity.size !== 1 && entity.size !== 2) || typeof entity.alive !== "boolean") return "invalid_state";
    ids.add(entity.id);
    for (const p of footprint(entity.position, entity.size)) {
      if (!inside(state, p)) return "invalid_state";
      if (entity.alive && occupied.has(key(p))) return "invalid_state";
      if (entity.alive) occupied.add(key(p));
    }
  }
  return null;
}
function validateRequest(request: DisplacementRequest): boolean {
  return !!request && (request.skillId === "phase_swap" || request.skillId === "gravity_well") &&
    validId(request.actorId) && Array.isArray(request.targetIds) && request.targetIds.length >= 1 &&
    request.targetIds.length <= 128 && request.targetIds.every(validId) &&
    new Set(request.targetIds).size === request.targetIds.length && !request.targetIds.includes(request.actorId) &&
    (request.skillId !== "phase_swap" || request.targetIds.length === 1) &&
    integer(request.radius) && request.radius >= 0 && request.radius <= 256 &&
    integer(request.steps) && request.steps >= 1 && request.steps <= 16 &&
    Array.isArray(request.attackOffsets) && request.attackOffsets.length <= 256 &&
    request.attackOffsets.every((p) => validCell(p) && Math.abs(p.x) <= 256 && Math.abs(p.y) <= 256);
}
function copyRequest(request: DisplacementRequest): DisplacementRequest {
  return { skillId: request.skillId, actorId: request.actorId, targetIds: [...request.targetIds],
    radius: request.radius, steps: request.steps, attackOffsets: request.attackOffsets.map(cell) };
}
function failure(reason: string, effects: readonly DisplacementEffect[] = []): DisplacementProjection {
  return { status: "void", reason, effects, attackCells: [] };
}
function voidEffect(id: string, reason: string, from: DisplacementCell | null = null,
  to: DisplacementCell | null = null, path: readonly DisplacementCell[] = [], collision?: DisplacementEffect["collision"]): DisplacementEffect {
  return { entityId: id, status: "void", reason, from: from && cell(from), to: to && cell(to), path: path.map(cell),
    ...(collision ? { collision: { cell: cell(collision.cell), blocker: { ...collision.blocker } } } : {}) };
}
function moveEffect(id: string, from: DisplacementCell, to: DisplacementCell, path: readonly DisplacementCell[]): DisplacementEffect {
  return { entityId: id, status: "move", reason: null, from: cell(from), to: cell(to), path: path.map(cell) };
}
/** Destination check against terrain and all live entities except the excluded movers. */
function blocked(state: DisplacementState, positions: Map<string, DisplacementCell>, entity: DisplacementEntity,
  to: DisplacementCell, excluded: ReadonlySet<string>): string | null {
  const water = new Set(state.water.map(key)), obstacles = new Set(state.obstacles.map(key));
  const occupants = new Set<string>();
  for (const other of state.entities) {
    if (!other.alive || excluded.has(other.id)) continue;
    const position = positions.get(other.id)!;
    for (const p of footprint(position, other.size)) occupants.add(key(p));
  }
  for (const p of footprint(to, entity.size)) {
    if (!inside(state, p)) return "out_of_bounds";
    if (water.has(key(p))) return "water";
    if (obstacles.has(key(p))) return "obstacle";
    if (occupants.has(key(p))) return "occupied";
  }
  return null;
}
function distance(a: DisplacementEntity, ap: DisplacementCell, b: DisplacementEntity, bp: DisplacementCell): number {
  const dx = Math.max(0, ap.x - (bp.x + b.size - 1), bp.x - (ap.x + a.size - 1));
  const dy = Math.max(0, ap.y - (bp.y + b.size - 1), bp.y - (ap.y + a.size - 1));
  return dx + dy;
}
function calculate(state: DisplacementState, request: DisplacementRequest): DisplacementProjection {
  const invalid = validateState(state);
  if (invalid) return failure(invalid);
  if (!validateRequest(request)) return failure("invalid_request");
  const actor = state.entities.find((e) => e.id === request.actorId && e.alive);
  if (!actor) return failure("actor_unavailable");
  if (actor.size !== 2) return failure("invalid_actor_footprint");
  const positions = new Map(state.entities.filter((e) => e.alive).map((e) => [e.id, cell(e.position)]));
  const actorPositionFailure = blocked(state, positions, actor, actor.position, new Set([actor.id]));
  if (request.skillId === "gravity_well" && actorPositionFailure) return failure(`actor_${actorPositionFailure}`);
  const effects: DisplacementEffect[] = [];
  let actorDestination = cell(actor.position);
  if (request.skillId === "phase_swap") {
    const target = state.entities.find((e) => e.id === request.targetIds[0] && e.alive);
    if (!target) return failure("target_unavailable", [voidEffect(request.targetIds[0]!, "target_unavailable")]);
    if (distance(actor, actor.position, target, target.position) > request.radius) return failure("out_of_range");
    const excluded = new Set([actor.id, target.id]);
    const actorFailure = blocked(state, positions, actor, target.position, excluded);
    const targetFailure = blocked(state, positions, target, actor.position, excluded);
    const newActorCells = new Set(footprint(target.position, actor.size).map(key));
    const overlap = footprint(actor.position, target.size).some((p) => newActorCells.has(key(p)));
    const reason = actorFailure || targetFailure || (overlap ? "occupied" : null);
    if (reason) return failure(reason, [voidEffect(actor.id, reason, actor.position, target.position, [target.position]),
      voidEffect(target.id, reason, target.position, actor.position, [actor.position])]);
    actorDestination = cell(target.position);
    effects.push(moveEffect(actor.id, actor.position, target.position, [target.position]),
      moveEffect(target.id, target.position, actor.position, [actor.position]));
  } else {
    for (const id of request.targetIds) {
      const target = state.entities.find((e) => e.id === id && e.alive);
      if (!target) { effects.push(voidEffect(id, "target_unavailable")); continue; }
      const from = positions.get(id)!;
      const sourceFailure = blocked(state, positions, target, from, new Set([id]));
      if (sourceFailure) { effects.push(voidEffect(id, sourceFailure, from, from)); continue; }
      if (distance(actor, actor.position, target, from) > request.radius) {
        effects.push(voidEffect(id, "out_of_range", from, from)); continue;
      }
      let current = cell(from), reason: string | null = null, collision: DisplacementEffect["collision"];
      const path: DisplacementCell[] = [];
      for (let i = 0; i < request.steps; i++) {
        // Reduce footprint separation; X wins ties. If already touching, movement is blocked.
        const dx = current.x > actor.position.x + 1 ? -1 : current.x + target.size - 1 < actor.position.x ? 1 : 0;
        const dy = current.y > actor.position.y + 1 ? -1 : current.y + target.size - 1 < actor.position.y ? 1 : 0;
        const gapX = dx ? Math.abs(dx === -1 ? current.x - (actor.position.x + 1) : actor.position.x - (current.x + target.size - 1)) : 0;
        const gapY = dy ? Math.abs(dy === -1 ? current.y - (actor.position.y + 1) : actor.position.y - (current.y + target.size - 1)) : 0;
        if (!dx && !dy) { reason = "occupied"; break; }
        const next = { x: current.x + (gapX >= gapY ? dx : 0), y: current.y + (gapY > gapX ? dy : 0) };
        path.push(next);
        reason = blocked(state, positions, target, next, new Set([id]));
        if (reason) {
          if (state.collisionTerrain && reason === "obstacle") {
            const hit = state.collisionTerrain.find(item => same(item.cell, next));
            if (hit) collision = { cell: next, blocker: { kind: hit.kind, id: hit.id } };
          } else if (state.collisionTerrain && reason === "occupied") {
            const hit = state.entities.find(other => other.alive && other.id !== id && footprint(positions.get(other.id)!, other.size).some(p => same(p, next)));
            if (hit?.id === "boss") collision = { cell: next, blocker: { kind: "boss", id: "boss" } };
            else if (hit?.id.startsWith("mech:")) collision = { cell: next, blocker: { kind: "mech", id: hit.id.slice(5) } };
            else if (hit?.id.startsWith("raider:")) collision = { cell: next, blocker: { kind: "raider", id: hit.id.slice(7) } };
          }
          break;
        }
        current = next;
      }
      if (reason || same(from, current)) {
        effects.push(voidEffect(id, reason || "no_displacement", from, path.length ? path[path.length - 1]! : from, path, collision));
      } else {
        positions.set(id, current);
        effects.push(moveEffect(id, from, current, path));
      }
    }
    const hasCollision = state.collisionTerrain !== undefined && effects.some(effect => !!effect.collision);
    if (!effects.some((effect) => effect.status === "move") && !hasCollision) return failure("no_legal_displacement", effects);
  }
  const attackCells = request.attackOffsets.map((offset) => ({ x: actorDestination.x + offset.x, y: actorDestination.y + offset.y }));
  if (attackCells.some((p) => !inside(state, p))) return failure("attack_out_of_bounds", effects.map((e) =>
    voidEffect(e.entityId, "attack_out_of_bounds", e.from, e.to, e.path)));
  return { status: "reprojected", reason: null, effects, attackCells };
}

/** No implicit target selection: bindings and ordering are provided explicitly. */
function prepareDisplacement(state: DisplacementState, request: DisplacementRequest): DisplacementPrepareResult {
  const projection = calculate(state, request);
  if (projection.status === "void") return { status: "void", reason: projection.reason!, projection };
  return { status: "planned", intent: { contentVersion: 1, request: copyRequest(request), declared: projection } };
}
function reprojectDisplacement(state: DisplacementState, intent: DisplacementIntent): DisplacementProjection {
  if (!intent || intent.contentVersion !== 1 || !validateRequest(intent.request)) return failure("invalid_intent");
  return calculate(state, intent.request);
}
function equalCell(a: DisplacementCell | null, b: DisplacementCell | null): boolean {
  return a === null ? b === null : validCell(b) && same(a, b);
}
/** Compare semantic projection fields rather than JSON object-key order. */
function equalProjection(a: DisplacementProjection, b: DisplacementProjection): boolean {
  if (!b || a.status !== b.status || a.reason !== b.reason || !Array.isArray(b.effects) ||
      !Array.isArray(b.attackCells) || a.effects.length !== b.effects.length || a.attackCells.length !== b.attackCells.length) return false;
  return a.attackCells.every((p, i) => validCell(b.attackCells[i]) && same(p, b.attackCells[i]!)) &&
    a.effects.every((e, i) => {
      const other = b.effects[i];
      return !!other && e.entityId === other.entityId && e.status === other.status && e.reason === other.reason &&
        (e.collision ? !!other.collision && equalCell(e.collision.cell, other.collision.cell) &&
          e.collision.blocker.kind === other.collision.blocker?.kind && e.collision.blocker.id === other.collision.blocker?.id : other.collision === undefined) &&
        equalCell(e.from, other.from) && equalCell(e.to, other.to) && Array.isArray(other.path) &&
        e.path.length === other.path.length && e.path.every((p, n) => validCell(other.path[n]) && same(p, other.path[n]!));
    });
}
/**
 * Always recalculates; never applies changes or damage. An optional previous
 * projection rejects stale or altered previews before exposing executable effects.
 */
function resolveDisplacement(state: DisplacementState, intent: DisplacementIntent,
  expectedProjection?: DisplacementProjection): DisplacementResolution {
  const projection = reprojectDisplacement(state, intent);
  if (expectedProjection !== undefined && !equalProjection(projection, expectedProjection)) {
    return { status: "void", reason: "stale_projection", effects: [], attackCells: [] };
  }
  if (projection.status === "void") return { status: "void", reason: projection.reason!, effects: [], attackCells: [] };
  return { status: "resolved", effects: projection.effects, attackCells: projection.attackCells };
}

return { prepareDisplacement, reprojectDisplacement, resolveDisplacement };
})();

/** Project core match data into the pure bounded skill calculations. */
export function corrodeWorld(state: MatchState, finished = !!state.outcome): CorrodeWorld {
  const blocked: Cell[] = [];
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const c = { x, y };
    if (noSpawn(state, c) || state.obstacles.some(v => eq(v, c)) || state.covers.some(v => eq(v, c)) ||
        state.buildings.some(b => b.cells.some(v => eq(v, c)))) blocked.push(c);
  }
  return { round: finished ? state.corrode!.nextRound : state.turn, blocked, casterAlive: state.boss.hp > 0, finished };
}

export function displacementWorld(state: MatchState): DisplacementState {
  const waterCells: Cell[] = [], obstacles: Cell[] = [], collisionTerrain: Array<{ cell: Cell; kind: "building" | "obstacle"; id: string }> = [];
  const statusEnabled = state.statusEncounter?.schema === "mecha-status-encounter:v1";
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const c = { x, y };
    if (water(state, c)) waterCells.push(c);
    else if (terrainAt(state, c) === "mountain" || state.obstacles.some(v => eq(v, c)) ||
      state.covers.some(v => eq(v, c)) || state.buildings.some(b => b.cells.some(v => eq(v, c)))) {
      obstacles.push(c);
      if (statusEnabled) {
        const building = livingBuildingAt(state, c);
        if (building) collisionTerrain.push({ cell: c, kind: "building", id: building.id });
        else if (state.obstacles.some(v => eq(v, c)) || state.covers.some(v => eq(v, c))) collisionTerrain.push({ cell: c, kind: "obstacle", id: `${c.x},${c.y}` });
      }
    }
  }
  return { width: BOARD, height: BOARD, terminal: !!state.outcome, water: waterCells, obstacles,
    ...(statusEnabled ? { collisionTerrain } : {}),
    entities: [
      { id: "boss", position: { ...state.boss.anchor }, size: 2, alive: state.boss.hp > 0 },
      ...state.mechs.map(m => ({ id: `mech:${m.id}`, position: { ...m.pos }, size: 1 as const, alive: m.hp > 0 })),
      ...state.raiders.map(r => ({ id: `raider:${r.id}`, position: { ...r.pos }, size: 1 as const, alive: r.hp > 0 })),
    ] };
}

/** L5 local-only rules. Candidates are fixed at prepare; reprojection may only
 * invalidate or allow those declared cells, never select an undeclared cell. */
export function swarmCandidates(origin: Cell): Cell[] {
  const cells: Cell[] = [];
  for (let y = origin.y - 1; y <= origin.y + 2; y++) for (let x = origin.x - 1; x <= origin.x + 2; x++) {
    if ((x >= origin.x && x <= origin.x + 1 && (y === origin.y - 1 || y === origin.y + 2)) ||
        (y >= origin.y && y <= origin.y + 1 && (x === origin.x - 1 || x === origin.x + 2))) cells.push({ x, y });
  }
  return cells;
}

export function validSwarmBinding(state: MatchState, intent: Intent): boolean {
  const binding = intent.swarm, origin = intent.swarmOrigin, r = binding?.request;
  if (!origin || !Number.isInteger(origin.x) || !Number.isInteger(origin.y) || !inb(origin) ||
      !binding || binding.version !== 1 || binding.round !== state.turn || !r || r.skillId !== "split_swarm") return false;
  return r.actionId === `split:${state.turn}` && r.actorId === "boss" && r.speciesId === "swarm_child" &&
    r.maxSpawn === 2 && r.summonCap === 4 && r.spawnRange === 1 && r.hp === SWARM_CHILD_HP && r.lifetime === 2 &&
    Array.isArray(r.candidates) && JSON.stringify(r.candidates) === JSON.stringify(swarmCandidates(origin));
}

function swarmWorld(state: MatchState, protectedCells: Cell[] = []): SwarmLinkState {
  const blocked: Cell[] = [];
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const c = { x, y };
    if (noSpawn(state, c) || state.obstacles.some(v => eq(v, c)) || state.covers.some(v => eq(v, c)) ||
        state.buildings.some(b => b.cells.some(v => eq(v, c))) || state.deployment?.zone.some(v => eq(v, c)) ||
        state.deployment?.reservedCells.some(v => eq(v, c)) || state.assaultTerrainSafety?.unsafeCells.some(v => eq(v, c)) ||
        protectedCells.some(v => eq(v, c))) blocked.push(c);
  }
  return { version: 1, width: BOARD, height: BOARD, round: state.turn, finished: !!state.outcome || state.phase === "finished",
    blocked, links: [], nextSpawnId: state.swarm!.nextSpawnId, nextLinkId: 0, resolvedActions: [...state.swarm!.resolvedActions],
    units: [
      { id: "boss", side: "enemy", cell: { ...state.boss.anchor }, width: 2, height: 2, hp: state.boss.hp },
      ...state.mechs.filter(m => m.hp > 0).map(m => ({ id: `mech:${m.id}`, side: "player", cell: { ...m.pos }, width: 1, height: 1, hp: m.hp })),
      ...state.raiders.filter(r => r.hp > 0 || r.summon).map(r => ({ id: r.id, side: "enemy", cell: { ...r.pos }, width: 1, height: 1, hp: r.hp,
        ...(r.summon ? { summon: { ...r.summon } } : {}) })),
    ] };
}

/** Keep existing connected components and each mech's routes open jointly. */
function swarmPreservesPaths(state: MatchState, births: Cell[]): boolean {
  const occupied = new Set<string>();
  if (state.boss.hp > 0) for (const c of footprint(state.boss.anchor)) occupied.add(key(c));
  for (const r of state.raiders) if (r.hp > 0) occupied.add(key(r.pos));
  const removed = new Set(births.map(key));
  const passable = (c: Cell, after: boolean) => inb(c) && !water(state, c) && !occupied.has(key(c)) &&
    !state.obstacles.some(v => eq(v, c)) && !state.covers.some(v => eq(v, c)) &&
    !state.buildings.some(b => b.cells.some(v => eq(v, c))) && (!after || !removed.has(key(c)));
  const reach = (start: Cell, after: boolean, assault: boolean): Set<string> => {
    const seen = new Set<string>();
    if (!passable(start, after)) return seen;
    const queue = [start]; seen.add(key(start));
    for (let i = 0; i < queue.length; i++) for (const dir of STEP_DIRS) {
      const from = queue[i]!, to = { x: from.x + dir.x, y: from.y + dir.y }, k = key(to);
      if (seen.has(k) || !passable(to, after) || (assault && assaultTerrainBlocked(state, from, to))) continue;
      seen.add(k); queue.push(to);
    }
    return seen;
  };
  const seen = new Set<string>();
  for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
    const c = { x, y }, k = key(c);
    if (!passable(c, false) || seen.has(k)) continue;
    const before = reach(c, false, false);
    for (const p of before) seen.add(p);
    const survivors = [...before].filter(p => !removed.has(p));
    if (survivors.length) {
      const [x0, y0] = survivors[0]!.split(",").map(Number);
      const after = reach({ x: x0!, y: y0! }, true, false);
      if (survivors.some(p => !after.has(p))) return false;
    }
  }
  for (const m of living(state)) {
    const before = reach(m.pos, false, m.id === "Assault"), after = reach(m.pos, true, m.id === "Assault");
    if ([...before].some(p => !removed.has(p) && !after.has(p)) || (before.size > 1 && after.size <= 1)) return false;
    for (const b of livingStakeBuildings(state)) {
      const perimeter = b.cells.flatMap(c => STEP_DIRS.map(d => ({ x: c.x + d.x, y: c.y + d.y })));
      if (perimeter.some(c => before.has(key(c))) && !perimeter.some(c => after.has(key(c)))) return false;
    }
  }
  return true;
}

/** Bounded retry only rejects declared slots whose joint occupancy cuts a path. */
export function projectSwarm(state: MatchState, intent: Intent): { world: SwarmLinkState; projection: SwarmProjection; protectedCells: Cell[] } {
  const protectedCells: Cell[] = [];
  for (;;) {
    const world = swarmWorld(state, protectedCells);
    const projection = validSwarmBinding(state, intent) ? reprojectSwarmLink(world, intent.swarm!) : { status: "void" as const, reason: "invalid_intent" };
    if (projection.status === "void" || projection.skillId !== "split_swarm") return { world, projection, protectedCells };
    const accepted: Cell[] = [];
    let rejected: Cell | undefined;
    for (const slot of projection.slots) if (slot.unit) {
      if (!swarmPreservesPaths(state, [...accepted, slot.cell])) { rejected = slot.cell; break; }
      accepted.push(slot.cell);
    }
    if (!rejected) return { world, projection, protectedCells };
    protectedCells.push({ ...rejected });
  }
}

export function prepareSwarmIntent(state: MatchState): Intent {
  const origin = { ...state.boss.anchor };
  const result = prepareSwarmLink(swarmWorld(state), { skillId: "split_swarm", actionId: `split:${state.turn}`,
    actorId: "boss", speciesId: "swarm_child", candidates: swarmCandidates(origin), maxSpawn: 2, summonCap: 4,
    spawnRange: 1, hp: SWARM_CHILD_HP, lifetime: 2 });
  if (result.status === "void") return { skillId: "split_swarm", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
  const intent: Intent = { skillId: "split_swarm", local: [], projected: [], cdSweep: state.boss.cdSweep,
    status: "planned", swarm: result.intent, swarmOrigin: origin };
  const projected = projectSwarm(state, intent);
  intent.swarmProjection = visibleSwarmProjection(projected);
  intent.projected = intent.swarmProjection.status === "reprojected" && intent.swarmProjection.skillId === "split_swarm"
    ? intent.swarmProjection.slots.filter(s => !!s.unit).map(s => ({ ...s.cell })) : [];
  return intent;
}

export function visibleSwarmProjection(result: ReturnType<typeof projectSwarm>): SwarmProjection {
  if (result.projection.status === "void" || result.projection.skillId !== "split_swarm") return result.projection;
  return { ...result.projection, slots: result.projection.slots.map(slot =>
    slot.reason === "blocked" && result.protectedCells.some(c => eq(c, slot.cell)) ? { ...slot, reason: "protected_path" } : slot) };
}

export function resolveSwarmIntent(state: MatchState, intent: Intent): void {
  const result = projectSwarm(state, intent);
  if (result.projection.status === "void") return;
  const resolved = resolveSwarmLink(result.world, intent.swarm!, result.projection);
  if (resolved.status !== "resolved") throw new Error(`swarm_resolution_failed:${resolved.reason}`);
  state.swarm!.nextSpawnId = resolved.state.nextSpawnId;
  state.swarm!.resolvedActions = resolved.state.resolvedActions;
  for (const effect of resolved.events) if (effect.type === "summon_spawned") {
    const u = effect.unit;
    const child: Raider = { id: u.id, pos: { ...u.cell }, hp: u.hp, intent: null,
      summon: { parentId: "boss", speciesId: "swarm_child", expiresAtRound: u.summon!.expiresAtRound } };
    state.raiders.push(child);
    emit({ type: "raider_spawn", sequence: 0, unit: { id: child.id, pos: { ...child.pos }, hp: child.hp } });
  }
}

/** Call immediately after health evidence and at the round boundary, before victory. */
export function reconcileSwarm(state: MatchState): void {
  if (!state.swarm) return;
  for (let i = 0; i < state.raiders.length;) {
    const r = state.raiders[i]!;
    if (!r.summon || (r.hp > 0 && state.turn < r.summon.expiresAtRound)) { i++; continue; }
    emit({ type: "raider_remove", sequence: 0, unit: { id: r.id, pos: { ...r.pos }, hp: r.hp }, reason: r.hp <= 0 ? "death" : "expired" });
    state.raiders.splice(i, 1);
  }
}


// L8 v1 local rule constants are provisional, not a balance claim.
const NEURAL_RANGE = 3, NEURAL_BONUS = 2, NEURAL_LIFETIME = 2;
const neuralNode = (id: string) => `raider:${id}`;
const neuralAction = (round: number) => `neural:${round}`;
/** Verify only plain, own enumerable data, never execute user-supplied getters. */
function neuralRecord(value: unknown, keys: string[]): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(value, k);
    return !!d && d.enumerable === true && "value" in d;
  });
}
function neuralArray(value: unknown, cap: number): value is any[] {
  if (!Array.isArray(value) || value.length > cap || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !("value" in d)) return false;
  }
  return true;
}
function neuralLinkShape(link: unknown): link is NeuralLink {
  if (!neuralRecord(link, ["id", "sourceId", "targetId", "range", "attackBonus", "expiresAtRound"])) return false;
  return typeof link.id === "string" && /^neural-link:(0|[1-9][0-9]*)$/.test(link.id) && link.sourceId === "boss" &&
    typeof link.targetId === "string" && link.targetId.startsWith("raider:") && link.targetId.length > 7 && link.targetId.length <= 128 &&
    link.range === NEURAL_RANGE && link.attackBonus === NEURAL_BONUS && Number.isSafeInteger(link.expiresAtRound);
}
export function validNeuralBinding(state: MatchState, intent: Intent): boolean {
  const d = Object.getOwnPropertyDescriptor(intent, "swarm");
  const i = d && "value" in d && d.enumerable ? d.value : undefined;
  if (!neuralRecord(i, ["version", "round", "request"]) || i.version !== 1 || i.round !== state.turn ||
      !neuralRecord(i.request, ["skillId", "actionId", "actorId", "targetId", "range", "attackBonus", "lifetime"])) return false;
  const r = i.request;
  return r.skillId === "neural_link" && r.actionId === neuralAction(state.turn) && r.actorId === "boss" &&
    typeof r.targetId === "string" && r.targetId.startsWith("raider:") && r.targetId.length > 7 && r.targetId.length <= 128 &&
    r.range === NEURAL_RANGE && r.attackBonus === NEURAL_BONUS && r.lifetime === NEURAL_LIFETIME;
}
function validNeuralProjection(state: MatchState, intent: Intent): boolean {
  const desc = Object.getOwnPropertyDescriptor(intent, "swarmProjection");
  if (!desc || !desc.enumerable || !("value" in desc)) return false;
  const p = desc.value;
  const status = p && Object.getOwnPropertyDescriptor(p, "status");
  if (!status || !("value" in status)) return false;
  if (status.value === "void") return neuralRecord(p, ["status", "reason"]) &&
    ["actor_dead", "target_dead", "out_of_range"].includes(p.reason);
  if (!neuralRecord(p, ["status", "skillId", "linkId", "sourceId", "targetId", "range", "attackBonus", "expiresAtRound", "breakConditions"]) ||
      p.status !== "reprojected" || p.skillId !== "neural_link" || p.linkId !== `neural-link:${state.neural!.nextLinkId}` ||
      p.sourceId !== "boss" || p.targetId !== (intent.swarm!.request as { targetId: string }).targetId ||
      p.range !== NEURAL_RANGE || p.attackBonus !== NEURAL_BONUS || p.expiresAtRound !== state.turn + NEURAL_LIFETIME ||
      !neuralArray(p.breakConditions, NEURAL_LINK_BREAK_CONDITIONS.length) ||
      JSON.stringify(p.breakConditions) !== JSON.stringify(NEURAL_LINK_BREAK_CONDITIONS)) return false;
  return true;
}
function validNeuralState(state: MatchState, intent: Intent | null): boolean {
  try {
    if (intent !== null) {
      if (typeof intent !== "object") return false;
      for (const key of ["skillId", "status", "local", "projected"]) {
        const d = Object.getOwnPropertyDescriptor(intent, key);
        if (!d?.enumerable || !("value" in d)) return false;
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(state, "neural");
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    const n = descriptor.value;
    if (!neuralRecord(n, ["version", "nextLinkId", "links", "resolvedActions", "pending", "journal"]) || n.version !== 1 ||
        !Number.isSafeInteger(n.nextLinkId) || n.nextLinkId < 0 || n.nextLinkId > MAX_TURNS ||
        !Number.isSafeInteger(state.turn) || state.turn < 1 || state.turn > MAX_TURNS + 1 ||
        !neuralArray(n.links, MAX_TURNS) || !neuralArray(n.resolvedActions, MAX_TURNS) || !neuralArray(n.journal, MAX_TURNS * 2) ||
        new Set(state.raiders.map(r => r.id)).size !== state.raiders.length ||
        state.raiders.some(r => typeof r.id !== "string" || !r.id || neuralNode(r.id).length > 128 || "summon" in r)) return false;
    const active = new Map<string, NeuralLink>(), actions: string[] = [];
    let nextId = 0, previousRound = 0;
    for (const e of n.journal) {
      if (!e || typeof e !== "object") return false;
      const type = Object.getOwnPropertyDescriptor(e, "type");
      if (!type || !("value" in type)) return false;
      if (type.value === "link_created") {
        if (!neuralRecord(e, ["type", "round", "actionId", "link"]) || !neuralLinkShape(e.link) ||
            e.link.id !== `neural-link:${nextId++}` || e.actionId !== neuralAction(e.round) || e.round > MAX_TURNS ||
            !state.raiders.some(r => neuralNode(r.id) === e.link.targetId) ||
            e.link.expiresAtRound !== e.round + NEURAL_LIFETIME ||
            [...active.values()].some(l => l.targetId === e.link.targetId)) return false;
        active.set(e.link.id, e.link); actions.push(e.actionId);
      } else if (type.value === "link_broken") {
        if (!neuralRecord(e, ["type", "round", "linkId", "reason"]) || !active.has(e.linkId) ||
            !["source_dead", "target_dead", "side_changed", "expired", "out_of_range", "finished"].includes(e.reason)) return false;
        active.delete(e.linkId);
      } else if (type.value === "link_void") {
        if (!neuralRecord(e, ["type", "round", "actionId", "targetId", "reason"]) || e.actionId !== neuralAction(e.round) ||
            typeof e.targetId !== "string" || !e.targetId.startsWith("raider:") || e.targetId.length <= 7 || e.targetId.length > 128 || e.round > MAX_TURNS ||
            !state.raiders.some(r => neuralNode(r.id) === e.targetId) ||
            !["actor_dead", "target_dead", "out_of_range", "finished"].includes(e.reason)) return false;
        actions.push(e.actionId);
      } else return false;
      if (!Number.isSafeInteger(e.round) || e.round < previousRound || e.round > state.turn || e.round < 1) return false;
      previousRound = e.round;
    }
    if (nextId !== n.nextLinkId || actions.length !== n.resolvedActions.length ||
        actions.some((a, i) => a !== n.resolvedActions[i] || (i > 0 && Number(a.slice(7)) <= Number(actions[i - 1]!.slice(7)))) ||
        active.size !== n.links.length || n.links.some((l: NeuralLink) => !neuralLinkShape(l) ||
          JSON.stringify(active.get(l.id)) !== JSON.stringify(l)) || new Set(n.links.map((l: NeuralLink) => l.id)).size !== n.links.length) return false;
    if (n.pending !== null) {
      if (!intent || state.turn > MAX_TURNS || (state.phase !== "player_plan" && state.phase !== "resolving_boss") ||
          intent.skillId !== "neural_link" || !validNeuralBinding(state, intent) ||
          !validNeuralBinding(state, { swarm: n.pending } as Intent) || !validNeuralProjection(state, intent) ||
          !neuralArray(intent.local, 0) || !neuralArray(intent.projected, 0) ||
          !["planned", "reprojected", "void"].includes(intent.status) ||
          JSON.stringify(n.pending) !== JSON.stringify(intent.swarm) || n.resolvedActions.includes(neuralAction(state.turn)) ||
          !state.raiders.some(r => neuralNode(r.id) === (n.pending.request as { targetId: string }).targetId)) return false;
    } else if (intent?.skillId === "neural_link" && intent.status !== "void") return false;
    if ((state.outcome || state.phase === "finished") && (n.pending || n.links.length)) return false;
    const reconciled = reconcileSwarmLink(neuralWorld(state));
    if (reconciled.status !== "resolved" || reconciled.events.length) return false;
    return true;
  } catch { return false; }
}
function neuralWorld(state: MatchState): SwarmLinkState {
  const n = state.neural!;
  return { version: 1, width: BOARD, height: BOARD, round: state.turn, finished: false, blocked: [],
    nextSpawnId: 0, nextLinkId: n.nextLinkId, resolvedActions: [...n.resolvedActions], links: structuredClone(n.links),
    units: [
      { id: "boss", side: "enemy", cell: { ...state.boss.anchor }, width: 2, height: 2, hp: state.boss.hp },
      ...state.raiders.map(r => ({ id: neuralNode(r.id), side: "enemy", cell: { ...r.pos }, width: 1, height: 1, hp: r.hp })),
      ...state.mechs.map(m => ({ id: `mech:${m.id}`, side: "player", cell: { ...m.pos }, width: 1, height: 1, hp: m.hp })),
    ] };
}
export function prepareNeuralIntent(state: MatchState): Intent {
  const n = state.neural!;
  if (n.pending || n.resolvedActions.includes(neuralAction(state.turn))) throw new Error("unsupported_neural_state");
  const empty: Intent = { skillId: "neural_link", local: [], projected: [], cdSweep: state.boss.cdSweep, status: "void" };
  for (const raider of [...state.raiders].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const r = prepareSwarmLink(neuralWorld(state), { skillId: "neural_link", actionId: neuralAction(state.turn), actorId: "boss",
      targetId: neuralNode(raider.id), range: NEURAL_RANGE, attackBonus: NEURAL_BONUS, lifetime: NEURAL_LIFETIME });
    if (r.status === "void") {
      if (["target_dead", "out_of_range", "target_already_linked"].includes(r.reason)) continue;
      throw new Error(`neural_prepare_failed:${r.reason}`);
    }
    n.pending = structuredClone(r.intent);
    return { ...empty, status: "planned", swarm: r.intent, swarmProjection: r.projection };
  }
  return empty;
}
export function projectNeural(state: MatchState, intent: Intent): SwarmProjection {
  if (!state.neural || !state.neural.pending || !validNeuralBinding(state, intent) ||
      JSON.stringify(state.neural.pending) !== JSON.stringify(intent.swarm)) return { status: "void", reason: "invalid_intent" };
  return reprojectSwarmLink(neuralWorld(state), intent.swarm!);
}
function recordNeuralEvent(state: MatchState, event: NeuralJournalEvent): void {
  state.neural!.journal.push(event);
  emit({ type: "neural_event", event: structuredClone(event) });
}
function voidNeuralPending(state: MatchState, reason: "actor_dead" | "target_dead" | "out_of_range" | "finished"): void {
  const n = state.neural!, pending = n.pending;
  if (!pending || pending.request.skillId !== "neural_link") return;
  n.resolvedActions.push(pending.request.actionId);
  recordNeuralEvent(state, { type: "link_void", round: state.turn, actionId: pending.request.actionId, targetId: pending.request.targetId, reason });
  n.pending = null;
}
export function resolveNeuralIntent(state: MatchState, intent: Intent): void {
  const n = state.neural!;
  if (!n.pending) return;
  const projection = projectNeural(state, intent);
  if (projection.status === "void") {
    if (!["actor_dead", "target_dead", "out_of_range"].includes(projection.reason)) throw new Error(`neural_resolution_failed:${projection.reason}`);
    voidNeuralPending(state, projection.reason as "actor_dead" | "target_dead" | "out_of_range");
    return;
  }
  const result = resolveSwarmLink(neuralWorld(state), n.pending, projection);
  if (result.status !== "resolved") throw new Error(`neural_resolution_failed:${result.reason}`);
  const actionId = n.pending.request.actionId;
  n.pending = null; n.nextLinkId = result.state.nextLinkId; n.links = result.state.links; n.resolvedActions = result.state.resolvedActions;
  for (const event of result.events) if (event.type === "link_created") recordNeuralEvent(state, { type: "link_created", round: state.turn, actionId, link: event.link });
}
/** Immediately after relevant movement/death and on each round boundary. */
export function reconcileNeural(state: MatchState): void {
  if (!state.neural) return;
  const n = state.neural, result = reconcileSwarmLink(neuralWorld(state));
  if (result.status !== "resolved") throw new Error(`neural_reconcile_failed:${result.reason}`);
  n.links = result.state.links;
  for (const e of result.events) if (e.type === "link_broken") recordNeuralEvent(state, { type: "link_broken", round: state.turn, linkId: e.linkId, reason: e.reason });
  if (state.outcome || state.phase === "finished") {
    voidNeuralPending(state, "finished");
    for (const link of n.links) recordNeuralEvent(state, { type: "link_broken", round: state.turn, linkId: link.id, reason: "finished" });
    n.links = [];
  } else if (state.boss.hp <= 0 && n.pending) {
    voidNeuralPending(state, "actor_dead");
    if (state.boss.intent) { state.boss.intent.status = "void"; state.boss.intent.projected = []; }
  }
}
/** Current bonus; optional prospective declaration is useful for static threat estimates. */
export function neuralBonus(state: MatchState, raiderId: string, includePending = false): number {
  if (!state.neural || state.outcome || state.phase === "finished") return 0;
  const targetId = neuralNode(raiderId), current = linkedAttackBonus(neuralWorld(state), targetId);
  if (current || !includePending || !state.boss.intent || state.boss.intent.status === "void") return current;
  const projected = projectNeural(state, state.boss.intent);
  return projected.status === "reprojected" && projected.skillId === "neural_link" && projected.targetId === targetId ? projected.attackBonus : 0;
}
