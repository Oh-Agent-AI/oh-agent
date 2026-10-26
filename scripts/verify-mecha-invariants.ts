/**
 * 机甲战棋的随机不变量守卫（固定种子，可复现）。
 * 用线性同余生成器随机开局：4 种剧本 × 3 种掩体 × 3 种地形（全平地 / 多道路 / 混合水山路）。
 * 随机包和 AI 包逐回合推进，每一步检查：机甲、Boss 脚印、袭扰者不越界、不重叠、
 * 不在水、掩体、楼（含废墟）上；血量与冷却范围；预告格界内；revision 严格递增；
 * 非法整包被拒后整局回滚；胜负条件与 15 回合上限。
 * 随机包的动作选择是有意的：移动只在抽样候选格里挑可达的，动作从 legalActions 里挑，
 * 同一包里后面的动作看不到前面动作的结算，所以偶尔会被拒，正好测回滚。
 * 本文件是小规模版本（随机 200 局 + AI 10 局），适合 CI。全量跑时把下面的 RANDOM_MATCHES /
 * AI_MATCHES 调大后用同一条 node 命令手动运行。
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import {
  BOARD, BOSS_HP, MAX_TURNS, bossExecute, bossPrepare, createMatch, legalActions, living, livingRaiders,
  livingStakeBuildings, moveBudget, pathDistance, spawnsAreOpenGround, validateAndApplyPlan,
  type Action, type ArenaPlan, type BossScriptId, type BuildingStake, type Cell, type CoverPresetId,
  type MatchState, type MechId, type MechOrder, type TerrainKind,
} from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { peelPlan, squadPlan } from "../apps/agent-city/ui/src/game/mecha/ai.ts";

const RANDOM_MATCHES = 200;
const AI_MATCHES = 10;
/** 每回合最多推进一次；超过这个数还没有结局就算违例。 */
const MAX_STEPS = 20;
/** 随机移动每个机甲抽多少个候选格去找可达的；全盘扫描每回合要上百次 BFS，太慢。 */
const MOVE_CANDIDATES = 24;
const SEED_RANDOM = 20261026;
const SEED_AI = 77001;

const SCRIPTS: BossScriptId[] = ["stationary_smash", "cadence_ssw", "raid_ssw", "siege"];
const PRESETS: CoverPresetId[] = ["covers_sparse_mid", "covers_diag_corridor", "covers_twin_clusters"];
const TERRAIN_MODES = ["land", "road", "mixed"] as const;
const MAX_HP: Record<MechId, number> = { Assault: 14, Gunner: 11, Support: 12 };
/** 机甲出生格、Boss 脚印和袭扰者出生格，强制成陆地，否则整局没法开。 */
const FORCED_LAND: Cell[] = [
  { x: 2, y: 9 }, { x: 5, y: 9 }, { x: 8, y: 9 }, { x: 4, y: 0 }, { x: 5, y: 0 },
  { x: 4, y: 1 }, { x: 5, y: 1 }, { x: 1, y: 4 }, { x: 8, y: 4 },
];

/** 一个 LCG：seed = (seed * 1664525 + 1013904223) >>> 0，返回 seed / 2^32。 */
function lcg(initial: number): () => number {
  let seed = initial >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
}

const key = (c: Cell) => `${c.x},${c.y}`;
const inBoard = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < BOARD && c.y < BOARD;

function makeMatch(rng: () => number, index: number): { label: string; state: MatchState } | null {
  const script = pick(SCRIPTS, rng);
  const preset = pick(PRESETS, rng);
  const mode = pick(TERRAIN_MODES, rng);
  const stake: BuildingStake = rng() < 0.5 ? "all" : "frontage";
  const terrain: TerrainKind[][] = [];
  const heights: number[][] = [];
  for (let y = 0; y < BOARD; y += 1) {
    const row: TerrainKind[] = [];
    const hrow: number[] = [];
    for (let x = 0; x < BOARD; x += 1) {
      let kind: TerrainKind = "land";
      if (mode === "road") kind = rng() < 0.3 ? "road" : "land";
      else if (mode === "mixed") {
        const r = rng();
        kind = r < 0.08 ? "water" : r < 0.16 ? "mountain" : r < 0.3 ? "road" : "land";
      }
      row.push(kind);
      hrow.push(mode === "land" ? 0 : Math.floor(rng() * 4));
    }
    terrain.push(row);
    heights.push(hrow);
  }
  for (const c of FORCED_LAND) terrain[c.y]![c.x] = "land";
  const label = `#${index} ${script}/${preset}/${mode}/${stake}`;
  const base = { preset, script, stake, terrain, heights };
  const state =
    script === "siege"
      ? createMatch({
          ...base,
          covers: [],
          buildings: [
            { id: "a", cells: [{ x: 4, y: 4 }] },
            { id: "b", cells: [{ x: 5, y: 4 }, { x: 5, y: 5 }] },
            { id: "c", cells: [{ x: 3, y: 5 }] },
          ],
          raiders: [{ id: "raider-w", pos: { x: 1, y: 4 } }, { id: "raider-e", pos: { x: 8, y: 4 } }],
        })
      : script === "raid_ssw"
        ? createMatch({
            ...base,
            covers: [],
            buildings: [
              { id: "a", cells: [{ x: 4, y: 4 }] },
              { id: "b", cells: [{ x: 5, y: 4 }, { x: 5, y: 5 }] },
              { id: "c", cells: [{ x: 3, y: 5 }] },
            ],
          })
        : createMatch(base);
  if (!spawnsAreOpenGround(state)) return null;
  return { label, state };
}

/** 逐格检查。返回的每一条都是一个具体违例，调用方加上局号和步骤。 */
function invariantViolations(state: MatchState): string[] {
  const out: string[] = [];
  const cover = new Set(state.covers.map(key));
  const building = new Set(state.buildings.flatMap((b) => b.cells.map(key)));
  const seen = new Map<string, string>();
  const place = (who: string, c: Cell) => {
    if (!inBoard(c)) {
      out.push(`${who} out of bounds at ${key(c)}`);
      return;
    }
    if (state.terrain[c.y]?.[c.x] === "water") out.push(`${who} on water at ${key(c)}`);
    if (cover.has(key(c))) out.push(`${who} on cover at ${key(c)}`);
    if (building.has(key(c))) out.push(`${who} on building at ${key(c)}`);
    const prior = seen.get(key(c));
    if (prior) out.push(`${who} and ${prior} share ${key(c)}`);
    else seen.set(key(c), who);
  };

  for (const m of living(state)) place(m.id, m.pos);
  if (state.boss.hp > 0) {
    const a = state.boss.anchor;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) place("boss", { x: a.x + dx, y: a.y + dy });
  }
  for (const r of livingRaiders(state)) place(r.id, r.pos);

  for (const m of state.mechs) {
    if (m.hp > MAX_HP[m.id]) out.push(`${m.id} hp ${m.hp} above max ${MAX_HP[m.id]}`);
    if (m.cd !== 0 && m.cd !== 1) out.push(`${m.id} cd ${m.cd} outside {0,1}`);
  }
  if (state.boss.hp < 0 || state.boss.hp > BOSS_HP) out.push(`boss hp ${state.boss.hp} outside 0..${BOSS_HP}`);
  for (const b of state.buildings) {
    if (b.hp < 0 || b.hp > b.maxHp) out.push(`building ${b.id} hp ${b.hp} outside 0..${b.maxHp}`);
  }

  const intents: Array<[string, Cell[]]> = [
    ["boss", state.boss.intent?.projected ?? []],
    ...state.raiders.map((r): [string, Cell[]] => [r.id, r.intent?.projected ?? []]),
  ];
  for (const [who, cells] of intents) {
    for (const c of cells) if (!inBoard(c)) out.push(`${who} intent projects out of bounds at ${key(c)}`);
  }

  if (state.outcome) {
    if (state.phase !== "finished") out.push(`outcome ${state.outcome} but phase ${state.phase}`);
    if (state.outcome === "victory" && (state.boss.hp > 0 || livingRaiders(state).length > 0)) {
      out.push("victory while boss or raiders still alive");
    }
    if (state.outcome === "defeat_wipe" && living(state).length > 0) out.push("defeat_wipe with living mechs");
    if (state.outcome === "defeat_buildings" && livingStakeBuildings(state).length > 0) {
      out.push("defeat_buildings with staked buildings standing");
    }
  } else if (state.phase === "finished") {
    out.push("phase finished without outcome");
  }
  if (state.turn > MAX_TURNS + 1) out.push(`turn ${state.turn} above MAX_TURNS + 1`);
  return out;
}

function holdPlan(state: MatchState): ArenaPlan {
  return {
    revision: state.revision,
    items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })),
  };
}

/** 随机包：每个机甲 70% 去一个可达格，80% 从 legalActions 挑一个动作，其余 skip。 */
function randomPlan(state: MatchState, rng: () => number): ArenaPlan {
  const scratch = structuredClone(state);
  const ids = living(state).map((m) => m.id);
  shuffle(ids, rng);
  const items: MechOrder[] = [];
  for (const id of ids) {
    const mech = scratch.mechs.find((m) => m.id === id);
    if (!mech) continue;
    let moveTo: Cell | null = null;
    if (rng() < 0.7) {
      const reachable: Cell[] = [];
      for (let i = 0; i < MOVE_CANDIDATES; i += 1) {
        const c = { x: Math.floor(rng() * BOARD), y: Math.floor(rng() * BOARD) };
        const d = pathDistance(scratch, mech.pos, c, id);
        if (d !== null && d > 0 && d <= moveBudget(id)) reachable.push(c);
      }
      if (reachable.length > 0) {
        moveTo = pick(reachable, rng);
        mech.pos = { ...moveTo };
      }
    }
    let action: Action = { kind: "skip" };
    if (rng() < 0.8) action = pick(legalActions(scratch, id), rng);
    items.push({ mechId: id, moveTo, action });
  }
  return { revision: state.revision, items };
}

/**
 * 推进一局直到结局，所有违例都收进 violations。ai 为 null 时走随机包，否则用给定的 AI 出包。
 * 每回合：机甲出包 → 结算 Boss（若在 resolving_boss）→ 预告下一回合（若在 enemy_prepare）。
 */
function playMatch(
  label: string,
  state: MatchState,
  rng: () => number,
  ai: ((s: MatchState) => ArenaPlan) | null,
  violations: string[],
): { outcome: MatchState["outcome"]; turns: number } {
  const push = (step: string, msgs: string[]) => {
    for (const msg of msgs) violations.push(`${label} ${step}: ${msg}`);
  };
  let steps = 0;
  for (let t = 1; t <= MAX_STEPS && !state.outcome; t += 1) {
    steps = t;
    if (state.phase === "enemy_prepare") {
      bossPrepare(state);
      push(`turn ${t} prepare`, invariantViolations(state));
    }
    if (state.phase === "player_plan") {
      const before = structuredClone(state);
      const rev = state.revision;
      const plan = ai ? ai(state) : randomPlan(state, rng);
      const res = validateAndApplyPlan(state, plan);
      if ("ok" in res) {
        if (state.revision <= rev) push(`turn ${t} plan`, [`revision ${rev} did not increase after accepted plan`]);
      } else {
        if (ai) push(`turn ${t} plan`, [`AI plan rejected: ${res.code} (${res.reason})`]);
        if (!isDeepStrictEqual(state, before)) push(`turn ${t} plan`, [`rejected plan (${res.code}) changed state`]);
        const held = validateAndApplyPlan(state, holdPlan(state));
        if (!("ok" in held)) push(`turn ${t} hold`, [`all-skip hold rejected: ${held.code} (${held.reason})`]);
        else if (state.revision <= rev) push(`turn ${t} hold`, [`revision ${rev} did not increase after hold`]);
      }
      push(`turn ${t} plan`, invariantViolations(state));
    }
    if (state.phase === "resolving_boss") {
      bossExecute(state);
      push(`turn ${t} execute`, invariantViolations(state));
    }
    if (state.phase === "enemy_prepare" && !state.outcome) {
      bossPrepare(state);
      push(`turn ${t} prepare`, invariantViolations(state));
    }
  }
  if (!state.outcome) push(`after ${steps} steps`, ["no outcome within 20 turns"]);
  return { outcome: state.outcome, turns: state.turn };
}

function report(violations: string[]): string {
  return `${violations.length} violation(s); first:\n  ${violations.slice(0, 5).join("\n  ")}`;
}

test("random packs keep every invariant", (t) => {
  const rng = lcg(SEED_RANDOM);
  const violations: string[] = [];
  const outcomes: Record<string, number> = {};
  let played = 0;
  let skipped = 0;
  for (let index = 0; played < RANDOM_MATCHES; index += 1) {
    assert.ok(index < RANDOM_MATCHES * 5, "generator could not find enough open-ground matches");
    const made = makeMatch(rng, index);
    if (!made) {
      skipped += 1;
      continue;
    }
    const result = playMatch(made.label, made.state, rng, null, violations);
    outcomes[String(result.outcome)] = (outcomes[String(result.outcome)] ?? 0) + 1;
    played += 1;
  }
  t.diagnostic(`played ${played} matches (${skipped} regenerated for non-open spawns); outcomes ${JSON.stringify(outcomes)}`);
  assert.equal(violations.length, 0, report(violations));
});

test("AI packs are never rejected and keep every invariant", (t) => {
  const rng = lcg(SEED_AI);
  const violations: string[] = [];
  const outcomes: Record<string, number> = {};
  let played = 0;
  for (let index = 0; played < AI_MATCHES; index += 1) {
    assert.ok(index < AI_MATCHES * 5, "generator could not find enough open-ground matches");
    const made = makeMatch(rng, index);
    if (!made) continue;
    const doctrine = played % 2 === 0 ? squadPlan : peelPlan;
    const result = playMatch(made.label, made.state, rng, doctrine, violations);
    outcomes[String(result.outcome)] = (outcomes[String(result.outcome)] ?? 0) + 1;
    played += 1;
  }
  t.diagnostic(`played ${played} AI matches (squad/peel alternating); outcomes ${JSON.stringify(outcomes)}`);
  assert.equal(violations.length, 0, report(violations));
});
