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
  livingStakeBuildings, moveBudget, pathDistance, playTurn, previewPlan, spawnsAreOpenGround, stakeBuildings, validateAndApplyPlan,
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

// Sample multi-turn generated states in addition to the directed UX fixtures. The
// seed and counts are fixed so a failure can be reproduced by label and turn.
// This is not an exhaustive enumeration of all legal packs or input devices.
test("generated complete and partial packs preserve preview/commit parity", (t) => {
  const rng = lcg(20261101);
  let states = 0, ready = 0, rejected = 0, partials = 0, moved = 0, acted = 0;
  const scripts = new Set<BossScriptId>();
  const stakes = new Set<BuildingStake>();

  for (let index = 0, matches = 0; matches < 24; index += 1) {
    assert.ok(index < 120, "generator could not find enough open-ground matches");
    const made = makeMatch(rng, index);
    if (!made) continue;
    matches += 1;
    let state = made.state;
    scripts.add(state.script);
    stakes.add(state.stake);
    bossPrepare(state);

    for (let turn = 0; turn < 6 && !state.outcome; turn += 1) {
      states += 1;
      const generated = randomPlan(state, rng);
      const candidates = [generated, holdPlan(state)];
      if (generated.items.length > 0) {
        candidates.push({ revision: generated.revision, items: generated.items.slice(1) });
        partials += 1;
      }
      let next: MatchState | null = null;
      for (const partial of candidates) {
        const named = new Set(partial.items.map((item) => item.mechId));
        const missing = living(state).map((mech) => mech.id).filter((id) => !named.has(id));
        const full: ArenaPlan = { revision: partial.revision, items: [...partial.items,
          ...missing.map((mechId) => ({ mechId, moveTo: null, action: { kind: "skip" as const } }))] };
        const context = `${made.label}, turn ${turn + 1}, plan ${JSON.stringify(partial)}`;
        const stateBefore = structuredClone(state);
        const planBefore = structuredClone(partial);
        const fullBefore = structuredClone(full);
        const preview = previewPlan(state, partial);
        assert.deepEqual(state, stateBefore, `${context}: preview state mutated`);
        assert.deepEqual(partial, planBefore, `${context}: preview plan mutated`);
        const actual = playTurn(state, full);
        assert.deepEqual(state, stateBefore, `${context}: commit state mutated`);
        assert.deepEqual(full, fullBefore, `${context}: commit plan mutated`);
        assert.equal(preview.ok, actual.ok, `${context}: validity differs`);
        if (!preview.ok && !actual.ok) {
          rejected += 1;
          assert.deepEqual(preview.fault, actual.fault, `${context}: fault differs`);
          continue;
        }
        if (!preview.ok || !actual.ok) throw new Error(`${context}: inconsistent result`);
        ready += 1;
        if (full.items.some((item) => item.moveTo !== null)) moved += 1;
        if (full.items.some((item) => item.action.kind !== "skip")) acted += 1;
        assert.deepEqual(preview.assumed, missing, `${context}: assumed mechs`);
        assert.deepEqual(preview.stages, actual.presentationStages, `${context}: stages`);
        assert.deepEqual(preview.log, actual.log, `${context}: event log`);
        assert.equal(preview.outcome, actual.state.outcome, `${context}: outcome`);
        const stages = actual.presentationStages;
        assert.ok(stages, `${context}: missing presentation stages`);
        const staked = new Set(stakeBuildings(state).map((building) => building.id));
        assert.deepEqual(preview.buildings, state.buildings.map((building) => ({
          id: building.id, cells: building.cells, staked: staked.has(building.id),
          startHp: building.hp,
          afterPlayerHp: stages.afterPlayer.buildings.find((item) => item.id === building.id)!.hp,
          endHp: actual.state.buildings.find((item) => item.id === building.id)!.hp,
          maxHp: building.maxHp,
        })), `${context}: building projections`);
        for (const mech of state.mechs) {
          const before = stages.afterPlayer.mechs.find((unit) => unit.id === mech.id)!.hp;
          const after = stages.afterEnemy.mechs.find((unit) => unit.id === mech.id)!.hp;
          assert.equal(preview.hitsAfter[mech.id], Math.max(0, before - after), `${context}: enemy-phase hits ${mech.id}`);
        }
        const enemyEvents = actual.log.filter((event) => event.type === "enemy");
        assert.deepEqual(preview.enemyOrder, enemyEvents, `${context}: enemy order`);
        const byActor: Record<string, Cell[]> = {};
        const cellKeys = new Set<string>();
        const cells: Cell[] = [];
        for (const event of enemyEvents) {
          if (event.type !== "enemy") continue;
          byActor[event.actor] = event.cells;
          for (const cell of event.cells) {
            if (!cellKeys.has(key(cell))) { cellKeys.add(key(cell)); cells.push(cell); }
          }
        }
        assert.deepEqual(preview.telegraphByActor, byActor, `${context}: threat by actor`);
        assert.deepEqual(preview.telegraphAfter, cells, `${context}: combined threat`);
        if (!next) next = actual.state;
      }
      assert.ok(next, `${made.label}: hold should always produce a valid plan`);
      state = next;
    }
  }
  t.diagnostic(`seed 20261101: ${states} states, ${ready} ready, ${rejected} rejected, ${partials} partial, ${moved} moved, ${acted} acted; scripts ${[...scripts].sort()}, stakes ${[...stakes].sort()}`);
  assert.ok(states >= 60 && ready >= 100 && partials >= 60, "insufficient generated coverage");
  assert.ok(moved > 0 && acted > 0, "generated plans must include moves and actions");
  assert.equal(scripts.size, SCRIPTS.length, "all enemy scripts should be sampled");
  assert.equal(stakes.size, 2, "both stake modes should be sampled");
});

// Exhaustive over semantic movement/action choices on deliberately bounded maps.
// Equivalent representations (item order and explicit move to the current cell)
// are not counted as separate plans. This does not enumerate unrestricted maps.
test("all canonical legal packs on bounded deterministic boards match preview", (t) => {
  const free = [
    { x: 2, y: 3 }, { x: 2, y: 4 }, { x: 3, y: 3 }, { x: 3, y: 4 },
    { x: 4, y: 2 }, { x: 4, y: 3 }, { x: 5, y: 2 }, { x: 5, y: 3 },
    { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 5 },
    { x: 1, y: 4 }, { x: 6, y: 4 }, { x: 7, y: 5 },
  ];
  const open = new Set(free.map(key));
  const scripts: BossScriptId[] = ["stationary_smash", "raid_ssw", "siege", ...SCRIPTS];
  const rng = lcg(20261102);
  const required = new Set(["3,4", "4,2", "3,3", "4,4", "5,4", "4,5", "5,5", "6,4", "7,5", "1,4"]);
  const generatedMaps = new Set<string>();
  const generatedStakes = new Set<BuildingStake>();
  let generatedPlans = 0, generatedAttacks = 0, generatedRepairs = 0;
  let totalPlans = 0, movementBundles = 0, attacks = 0, repairs = 0, fizzles = 0;
  for (let scenario = 0; scenario < scripts.length; scenario += 1) {
    const generated = scenario >= 3;
    const terrain: TerrainKind[][] = Array.from({ length: BOARD }, (_, y) =>
      Array.from({ length: BOARD }, (_, x) => {
        const cell = key({ x, y });
        if (!open.has(cell)) return "water";
        if (!generated) return "land";
        const roll = rng();
        return !required.has(cell) && roll < 0.18 ? "water" : roll < 0.42 ? "road" : "land";
      }));
    const heights = generated ? Array.from({ length: BOARD }, (_, y) =>
      Array.from({ length: BOARD }, (_, x) => open.has(key({ x, y })) ? Math.floor(rng() * 3) : 0)) : undefined;
    if (scenario === 1) terrain[4]![5] = "road"; // Adjacent to street, but not back.
    const script = scripts[scenario]!;
    const state = createMatch({ preset: "covers_sparse_mid", script, terrain, heights, covers: [],
      boss: { x: 4, y: 4 },
      mechs: [{ id: "Assault", pos: { x: 3, y: 4 } }, { id: "Gunner", pos: { x: 4, y: 2 } }, { id: "Support", pos: { x: 3, y: 3 } }],
      buildings: [{ id: "street", cells: [{ x: 6, y: 4 }] }, { id: "back", cells: [{ x: 7, y: 5 }] }],
      raiders: script === "stationary_smash" ? [] : [{ id: "raider-w", pos: { x: 1, y: 4 } }],
      stake: scenario === 1 || (generated && rng() < 0.5) ? "frontage" : "all",
    });
    state.mechs[0]!.hp -= 2;
    state.mechs[1]!.hp -= 1;
    if (generated) {
      for (const mech of state.mechs) {
        mech.hp -= Math.floor(rng() * 3);
        mech.cd = rng() < 0.3 ? 1 : 0;
      }
      for (const building of state.buildings) building.hp = Math.max(1, building.hp - Math.floor(rng() * 5));
      state.boss.hp -= Math.floor(rng() * 6);
      generatedMaps.add(JSON.stringify({ terrain, heights }));
      generatedStakes.add(state.stake);
      t.diagnostic(`generated ${scenario}: stake ${state.stake}, mech HP/cd ${state.mechs.map((mech) => `${mech.hp}/${mech.cd}`).join(",")}, building HP ${state.buildings.map((building) => building.hp).join(",")}, boss HP ${state.boss.hp}`);
    }
    if (scenario === 1) {
      assert.deepEqual(stakeBuildings(state).map((building) => building.id), ["street"],
        "frontage scenario must include one staked and one non-staked building");
      assert.deepEqual(state.buildings.map((building) => building.id), ["street", "back"]);
    }
    assert.ok(spawnsAreOpenGround(state), `scenario ${scenario} spawn`);
    bossPrepare(state);
    const ids = living(state).map((mech) => mech.id);
    const options = living(state).map((mech) => [null, ...free.filter((cell) => {
      if (key(cell) === key(mech.pos)) return false;
      const cost = pathDistance(state, mech.pos, cell, mech.id, { alliesPass: true });
      return cost !== null && cost <= moveBudget(mech.id);
    })]);
    const before = structuredClone(state);
    let scenarioPlans = 0;
    for (const assaultMove of options[0]!) for (const gunnerMove of options[1]!) for (const supportMove of options[2]!) {
      const destinations = [assaultMove, gunnerMove, supportMove];
      const positions = destinations.map((cell, index) => cell ?? state.mechs[index]!.pos);
      if (new Set(positions.map(key)).size !== ids.length) continue;
      const base: ArenaPlan = { revision: state.revision, items: ids.map((mechId, index) => ({
        mechId, moveTo: destinations[index] ?? null, action: { kind: "skip" },
      })) };
      const moved = structuredClone(state);
      for (let index = 0; index < ids.length; index += 1) moved.mechs.find((mech) => mech.id === ids[index])!.pos = { ...positions[index]! };
      const actionOptions = ids.map((id, index) => {
        const listed = legalActions(moved, id);
        const expanded: Action[] = [...listed];
        for (const action of listed) {
          if (action.kind === "skip" || action.kind === "repair" || action.target !== undefined) continue;
          // With a unique legal target, both omitted and explicit target are valid.
          for (const target of ["boss", ...livingRaiders(moved).map((raider) => raider.id)]) {
            expanded.push({ kind: action.kind, target });
          }
        }
        return expanded.filter((action) => {
          const trial = structuredClone(base);
          trial.items[index]!.action = action;
          const accepted = playTurn(state, trial).ok;
          if (listed.includes(action)) assert.ok(accepted, `legalActions rejected for ${id}: ${JSON.stringify(trial)}`);
          return accepted;
        });
      });
      movementBundles += 1;
      for (const assault of actionOptions[0]!) for (const gunner of actionOptions[1]!) for (const support of actionOptions[2]!) {
        const plan: ArenaPlan = { revision: state.revision, items: base.items.map((item, index) => ({
          ...item, action: [assault, gunner, support][index]!,
        })) };
        const originalPlan = structuredClone(plan);
        const expected = playTurn(state, plan);
        assert.deepEqual(plan, originalPlan, `scenario ${scenario}: playTurn changed input plan`);
        assert.deepEqual(state, before, `scenario ${scenario}: playTurn changed input state`);
        assert.ok(expected.ok, `enumerated pack rejected in scenario ${scenario}: ${JSON.stringify(plan)}`);
        if (!expected.ok) continue;
        const preview = previewPlan(state, plan);
        assert.ok(preview.ok, `preview rejected in scenario ${scenario}: ${JSON.stringify(plan)}`);
        if (!preview.ok) continue;
        const message = `scenario ${scenario}, plan ${JSON.stringify(plan)}`;
        assert.deepEqual(plan, originalPlan, `${message}: input plan changed`);
        assert.deepEqual(state, before, `${message}: input state changed`);
        assert.deepEqual(preview.stages, expected.presentationStages, `${message}: stages`);
        assert.deepEqual(preview.log, expected.log, `${message}: events`);
        assert.equal(preview.outcome, expected.state.outcome, `${message}: outcome`);
        assert.deepEqual(preview.enemyOrder, expected.log.filter((event) => event.type === "enemy"), `${message}: enemy order`);
        const stages = expected.presentationStages;
        assert.ok(stages, `${message}: no stages`);
        const staked = new Set(stakeBuildings(state).map((building) => building.id));
        assert.deepEqual(preview.buildings, state.buildings.map((building) => ({
          id: building.id, cells: building.cells, staked: staked.has(building.id), startHp: building.hp,
          afterPlayerHp: stages.afterPlayer.buildings.find((item) => item.id === building.id)!.hp,
          endHp: expected.state.buildings.find((item) => item.id === building.id)!.hp, maxHp: building.maxHp,
        })), `${message}: building projections`);
        assert.deepEqual(preview.assumed, [], `${message}: full pack assumed a mech`);
        for (const mech of state.mechs) {
          const playerHp = stages.afterPlayer.mechs.find((unit) => unit.id === mech.id)!.hp;
          const enemyHp = stages.afterEnemy.mechs.find((unit) => unit.id === mech.id)!.hp;
          assert.equal(preview.hitsAfter[mech.id], Math.max(0, playerHp - enemyHp), `${message}: enemy damage`);
        }
        if (plan.items.some((item) => !["skip", "repair"].includes(item.action.kind))) {
          attacks += 1;
          if (generated) generatedAttacks += 1;
        }
        if (plan.items.some((item) => item.action.kind === "repair")) {
          repairs += 1;
          if (generated) generatedRepairs += 1;
        }
        if (expected.log.some((event) => event.type === "act" && event.fizzled)) fizzles += 1;
        scenarioPlans += 1;
        totalPlans += 1;
        if (generated) generatedPlans += 1;
      }
    }
    assert.ok(scenarioPlans > 100, `scenario ${scenario} insufficient complete plans`);
    t.diagnostic(`scenario ${scenario} ${generated ? "seed 20261102 " : "fixed "}${script}: ${scenarioPlans} complete plans`);
  }
  assert.equal(generatedMaps.size, SCRIPTS.length, "generated terrain and height maps must be distinct");
  assert.ok(generatedPlans > 400 && generatedAttacks > 0 && generatedRepairs > 0, "generated cases must include complete plans, attacks and repairs");
  t.diagnostic(`seed 20261102: ${generatedPlans} plans, ${generatedAttacks} attack, ${generatedRepairs} repair; stakes ${[...generatedStakes].sort()}`);
  assert.ok(movementBundles > 10 && attacks > 0 && repairs > 0 && fizzles > 0, "coverage must include movement, attack, repair and fizzle");
  t.diagnostic(`${movementBundles} movement bundles, ${totalPlans} plans, ${attacks} attack, ${repairs} repair, ${fizzles} fizzle`);
});
