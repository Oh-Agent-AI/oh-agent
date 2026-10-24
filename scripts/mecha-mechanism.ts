/**
 * Algorithmic mechanism probe for the City mecha rules.
 *
 * Run: node --experimental-strip-types --test --test-concurrency=1 scripts/mecha-mechanism.ts
 *
 * Exhausts knockback geometry, whole-pack rejection, cadence_ssw, sweep
 * threat, smash versus sweep displacement, and seeded random/search play.
 * The defense block measures raid_ssw: flat open spawns, building HP,
 * mech-over-building threat, and total building loss.
 * Win rates are scaffolding, not a balance result.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  BOARD, BOSS_HP, BUILDING_HP, COVERS, FLAT_SPAWN_MAX_DELTA, MECH_IDS, STATS_MOVE, adjacentToFootprint, attackerCenter,
  bossExecute, bossPrepare, buildingDamage, createMatch, flatSpawnSpread, footprintCenter, knockbackFromAttacker,
  legalActions, living, livingBuildings, pathDistance, primaryAxis, setScriptCounters, spawnsAreOpenGround,
  validateAndApplyPlan,
  type Action, type ArenaPlan, type BossScriptId, type Cell, type CoverPresetId, type Intent, type MatchState,
  type MechId, type MechOrder,
} from "../apps/agent-city/ui/src/game/mecha/rules.ts";

const PRESETS: CoverPresetId[] = ["covers_sparse_mid", "covers_diag_corridor", "covers_twin_clusters"];
const MAX_HP: Record<MechId, number> = { Assault: 14, Gunner: 11, Support: 12 };

const report = {
  knockbackCells: 0,
  halfCenterDisagreements: 0,
  rejectedPacks: 0,
  sweepLayouts: 0,
  cadenceHolds: 0,
  playerPhases: 0,
  deterministicReplays: 0,
  outcomes: [] as Array<{ preset: string; strategy: string; outcome: string | null; bossHp: number; turn: number; living: number; bossDamage: number }>,
  spread: [] as Array<{ preset: string; strategy: string; n: number; wins: number; timeouts: number; wipes: number; minTurn: number; medianTurn: number; maxTurn: number; matchesHit: number; medianBossDamage: number }>,
  defense: [] as Array<{ strategy: string; outcome: string | null; turn: number; bossHp: number; buildingHp: number; buildingsLeft: number; living: number; bossDamage: number }>,
};

after(() => {
  console.log("MECHA_MECHANISM_REPORT");
  console.log(JSON.stringify(report, null, 2));
});

const strike = (atk: number, def: number) => Math.max(1, atk - def);
const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;
const snap = (state: MatchState) => JSON.stringify(state);
const keyOf = (c: Cell) => `${c.x},${c.y}`;

function cellLess(a: Cell, b: Cell): boolean {
  return a.x < b.x || (a.x === b.x && a.y < b.y);
}

function mechOf(state: MatchState, id: MechId) {
  const found = state.mechs.find((m) => m.id === id);
  assert.ok(found, id);
  return found;
}

function hold(state: MatchState): ArenaPlan {
  return {
    revision: state.revision,
    items: living(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })),
  };
}

function orders(state: MatchState, patch: Partial<Record<MechId, { moveTo?: Cell | null; action?: Action }>>): ArenaPlan {
  return {
    revision: state.revision,
    items: living(state).map((m) => ({
      mechId: m.id,
      moveTo: patch[m.id]?.moveTo ?? null,
      action: patch[m.id]?.action ?? { kind: "skip" },
    })),
  };
}

function applyOk(state: MatchState, plan: ArenaPlan) {
  const result = validateAndApplyPlan(state, plan);
  assert.equal("ok" in result, true, "ok" in result ? "" : `${result.code} ${result.reason}`);
}

function expectReject(state: MatchState, plan: ArenaPlan, code: string) {
  const before = snap(state);
  const result = validateAndApplyPlan(state, plan);
  assert.equal("ok" in result, false);
  if (!("ok" in result)) assert.equal(result.code, code);
  assert.equal(snap(state), before);
  report.rejectedPacks += 1;
}

function setup(opts: {
  script?: BossScriptId;
  preset?: CoverPresetId;
  covers?: Cell[];
  boss?: Cell;
  assault?: Cell;
  gunner?: Cell;
  support?: Cell;
  prepare?: boolean;
}): MatchState {
  const state = createMatch({
    preset: opts.preset ?? "covers_sparse_mid",
    script: opts.script ?? "stationary_smash",
    ...(opts.covers ? { covers: opts.covers } : {}),
    ...(opts.boss ? { boss: opts.boss } : {}),
    mechs: [
      { id: "Assault", pos: opts.assault ?? { x: 2, y: 9 } },
      { id: "Gunner", pos: opts.gunner ?? { x: 5, y: 9 } },
      { id: "Support", pos: opts.support ?? { x: 8, y: 9 } },
    ],
  });
  if (opts.prepare !== false) bossPrepare(state);
  return state;
}

function adjacent(anchor: Cell): Cell[] {
  const out: Cell[] = [];
  for (let y = anchor.y - 1; y <= anchor.y + 2; y += 1) {
    for (let x = anchor.x - 1; x <= anchor.x + 2; x += 1) {
      const c = { x, y };
      if (c.x >= 0 && c.y >= 0 && c.x < BOARD && c.y < BOARD && adjacentToFootprint(anchor, c)) out.push(c);
    }
  }
  return out;
}

function specThreat(state: MatchState, c: Cell): number {
  if (state.mechs.some((m) => m.hp > 0 && m.pos.x === c.x && m.pos.y === c.y)) return 3;
  if (state.covers.some((k) => same(k, c))) return 2;
  return 1;
}

function specApproach(state: MatchState, c: Cell): number {
  let best = 99;
  for (const m of state.mechs) {
    if (m.hp <= 0) continue;
    const d = Math.abs(m.pos.x - c.x) + Math.abs(m.pos.y - c.y);
    if (d < best) best = d;
  }
  return best;
}

function specSmash(state: MatchState): Cell | null {
  let best: Cell | null = null;
  let bestT = -1;
  let bestD = 99;
  for (const c of adjacent(state.boss.anchor)) {
    const t = specThreat(state, c);
    const d = specApproach(state, c);
    if (!best || t > bestT || (t === bestT && (d < bestD || (d === bestD && cellLess(c, best))))) {
      best = c;
      bestT = t;
      bestD = d;
    }
  }
  return best;
}

function specSweep(state: MatchState): [Cell, Cell] | null {
  const cells = adjacent(state.boss.anchor);
  let best: { sum: number; mx: number; near: number; a: Cell; b: Cell } | null = null;
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      const a = cells[i];
      const b = cells[j];
      if (!a || !b) continue;
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 2) continue;
      const ta = specThreat(state, a);
      const tb = specThreat(state, b);
      const sum = ta + tb;
      const mx = Math.max(ta, tb);
      const near = specApproach(state, a) + specApproach(state, b);
      const [c0, c1] = cellLess(b, a) ? [b, a] : [a, b];
      const tiedHead = best !== null && c0.x === best.a.x && c0.y === best.a.y;
      const better = best === null
        || sum > best.sum
        || (sum === best.sum && mx > best.mx)
        || (sum === best.sum && mx === best.mx && near < best.near)
        || (sum === best.sum && mx === best.mx && near === best.near && (cellLess(c0, best.a) || (tiedHead && cellLess(c1, best.b))));
      if (better) best = { sum, mx, near, a: c0, b: c1 };
    }
  }
  return best ? [best.a, best.b] : null;
}

function bossPushDir(anchor: Cell, target: Cell): Cell {
  const f = footprintCenter(anchor);
  const t = attackerCenter(target);
  return primaryAxis(t.x - f.x, t.y - f.y);
}

function wrongHalfPush(anchor: Cell, target: Cell): Cell {
  const t = attackerCenter(target);
  return primaryAxis(t.x - (anchor.x + 0.5), t.y - (anchor.y + 0.5));
}

function checkIntent(intent: Intent) {
  assert.ok(intent.skillId === "smash" || intent.skillId === "sweep" || intent.skillId === "skip");
  if (intent.skillId === "smash") assert.equal(intent.projected.length, 1);
  if (intent.skillId === "sweep") {
    assert.equal(intent.projected.length, 2);
    const [a, b] = intent.projected;
    assert.ok(a && b);
    assert.ok(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 2);
  }
  if (intent.skillId === "skip") assert.equal(intent.projected.length, 0);
}

function checkBoard(state: MatchState) {
  assert.ok(state.boss.hp >= 0 && state.boss.hp <= BOSS_HP);
  assert.ok(state.boss.cdSweep >= 0 && state.boss.cdSweep <= 1);
  assert.ok(state.boss.cadence >= 0 && state.boss.cadence <= 2);
  const seen = new Set<string>();
  for (const m of state.mechs) {
    assert.ok(m.hp >= 0 && m.hp <= MAX_HP[m.id], `${m.id} hp ${m.hp}`);
    assert.ok(m.pos.x >= 0 && m.pos.y >= 0 && m.pos.x < BOARD && m.pos.y < BOARD);
    assert.ok(m.cd >= 0 && m.cd <= 1);
    if (m.hp > 0) {
      const key = keyOf(m.pos);
      assert.equal(seen.has(key), false, `overlap ${key}`);
      seen.add(key);
      assert.equal(state.covers.some((c) => same(c, m.pos)), false, `mech on cover ${key}`);
    }
  }
  if (state.boss.hp > 0) {
    assert.ok(state.boss.anchor.x >= 0 && state.boss.anchor.y >= 0);
    assert.ok(state.boss.anchor.x <= BOARD - 2 && state.boss.anchor.y <= BOARD - 2);
    const foot = [
      state.boss.anchor,
      { x: state.boss.anchor.x + 1, y: state.boss.anchor.y },
      { x: state.boss.anchor.x, y: state.boss.anchor.y + 1 },
      { x: state.boss.anchor.x + 1, y: state.boss.anchor.y + 1 },
    ];
    for (const c of foot) {
      assert.equal(seen.has(keyOf(c)), false, `mech on boss ${keyOf(c)}`);
      assert.equal(state.covers.some((k) => same(k, c)), false, `boss on cover ${keyOf(c)}`);
    }
  }
  if (state.outcome) assert.equal(state.phase, "finished");
  if (state.phase === "finished") assert.ok(state.outcome);
  const skill = state.boss.intent?.skillId;
  if (skill) assert.ok(skill === "smash" || skill === "sweep" || skill === "skip");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reachable(state: MatchState, id: MechId): Cell[] {
  const me = mechOf(state, id);
  const cap = STATS_MOVE[id];
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
  return {
    mechId: id,
    moveTo: same(from, dest) ? null : { x: dest.x, y: dest.y },
    action: structuredClone(action),
  };
}

type Opt = { dest: Cell; action: Action; score: number };

function localScore(state: MatchState, id: MechId, dest: Cell, action: Action): number {
  let score = 0;
  if (action.kind === "charge") score += 100;
  else if (action.kind === "melee") score += 80;
  else if (action.kind === "pierce") score += 60;
  else if (action.kind === "shoot") score += 50;
  else if (action.kind === "repair") score += 40;
  const center = footprintCenter(state.boss.anchor);
  score -= Math.abs(dest.x + 0.5 - center.x) + Math.abs(dest.y + 0.5 - center.y);
  if (id === "Assault") score -= Math.abs(dest.x + 0.5 - center.x);
  if (state.boss.intent?.projected.some((c) => same(c, dest))) score -= 8;
  return score;
}

function optionsFor(state: MatchState, id: MechId): Opt[] {
  const origin = mechOf(state, id).pos;
  const center = footprintCenter(state.boss.anchor);
  const ranked = reachable(state, id)
    .filter((c) => !same(c, origin))
    .sort((a, b) => {
      const da = Math.abs(a.x + 0.5 - center.x) + Math.abs(a.y + 0.5 - center.y);
      const db = Math.abs(b.x + 0.5 - center.x) + Math.abs(b.y + 0.5 - center.y);
      return da - db || a.x - b.x || a.y - b.y;
    });
  const dests = [origin, ...ranked.slice(0, 3)];
  const opts: Opt[] = [];
  for (const dest of dests) {
    const scratch = structuredClone(state);
    mechOf(scratch, id).pos = dest;
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
  if (clone.boss.hp > 0 && clone.phase === "resolving_boss") bossExecute(clone);
  const center = footprintCenter(clone.boss.anchor);
  let score = (BOSS_HP - clone.boss.hp) * 20;
  for (const m of clone.mechs) {
    score += m.hp * 3;
    if (m.hp > 0) score -= Math.abs(m.pos.x + 0.5 - center.x) + Math.abs(m.pos.y + 0.5 - center.y);
  }
  for (const b of clone.buildings) score += b.hp * 4;
  if (clone.outcome === "victory") score += 5000;
  if (clone.outcome === "defeat_wipe" || clone.outcome === "defeat_buildings") score -= 3000;
  if (clone.outcome === "defeat_timeout") score -= 100;
  return score;
}

function searchPlan(state: MatchState): ArenaPlan {
  const ids = living(state).map((m) => m.id);
  const groups = ids.map((id) => optionsFor(state, id));
  let best: { score: number; key: string; plan: ArenaPlan } | null = null;
  const consider = (items: MechOrder[]) => {
    const plan = { revision: state.revision, items };
    const score = scorePlan(state, plan);
    if (score === null) return;
    const key = JSON.stringify(items);
    if (!best || score > best.score || (score === best.score && key < best.key)) best = { score, key, plan };
  };
  const walk = (index: number, items: MechOrder[]) => {
    if (index === ids.length) {
      consider(items);
      return;
    }
    const id = ids[index];
    const from = mechOf(state, id!).pos;
    for (const opt of groups[index] ?? []) walk(index + 1, items.concat(orderOf(id!, from, opt.dest, opt.action)));
  };
  walk(0, []);
  consider(hold(state).items);
  assert.ok(best, "search found no legal plan");
  return best.plan;
}

function randomPlan(state: MatchState, rng: () => number): ArenaPlan {
  const ids = living(state).map((m) => m.id);
  for (let n = 0; n < 40; n += 1) {
    const trial = structuredClone(state);
    const items: MechOrder[] = [];
    for (const id of ids) {
      const who = mechOf(trial, id);
      const dests = reachable(trial, id);
      const dest = dests[Math.floor(rng() * dests.length)];
      assert.ok(dest);
      const scratch = structuredClone(trial);
      mechOf(scratch, id).pos = dest;
      const actions = legalActions(scratch, id);
      const action = actions[Math.floor(rng() * actions.length)];
      assert.ok(action);
      items.push(orderOf(id, who.pos, dest, action));
      who.pos = dest;
    }
    const plan = { revision: state.revision, items };
    const clone = structuredClone(state);
    if ("ok" in validateAndApplyPlan(clone, plan)) return plan;
  }
  return hold(state);
}

function squadHp(state: MatchState): number {
  return state.mechs.reduce((sum, m) => sum + m.hp, 0);
}

function play(preset: CoverPresetId, strategy: "random" | "search", seed: number): { state: MatchState; bossDamage: number } {
  const state = createMatch({ preset, script: "cadence_ssw" });
  const rng = mulberry32(seed);
  let guard = 0;
  let bossDamage = 0;
  while (state.outcome === null) {
    guard += 1;
    assert.ok(guard <= 15, "match did not reach an outcome");
    assert.equal(state.phase, "enemy_prepare");
    const intent = bossPrepare(state);
    checkIntent(intent);
    checkBoard(state);
    const plan = strategy === "search" ? searchPlan(state) : randomPlan(state, rng);
    applyOk(state, plan);
    checkBoard(state);
    report.playerPhases += 1;
    if (state.outcome) break;
    assert.equal(state.phase, "resolving_boss");
    const before = squadHp(state);
    bossExecute(state);
    bossDamage += before - squadHp(state);
    checkBoard(state);
  }
  assert.equal(state.phase, "finished");
  assert.ok(state.outcome === "victory" || state.outcome === "defeat_wipe" || state.outcome === "defeat_timeout");
  return { state, bossDamage };
}

test("knockback uses the 2x2 center on every adjacent cell", () => {
  for (let y = 0; y < BOARD; y += 1) {
    for (let x = 0; x < BOARD; x += 1) {
      assert.deepEqual(attackerCenter({ x, y }), { x: x + 0.5, y: y + 0.5 });
    }
  }
  for (let y = 0; y <= BOARD - 2; y += 1) {
    for (let x = 0; x <= BOARD - 2; x += 1) {
      const anchor = { x, y };
      assert.deepEqual(footprintCenter(anchor), { x: x + 1, y: y + 1 });
      for (const cell of adjacent(anchor)) {
        const got = knockbackFromAttacker(cell, anchor);
        const center = footprintCenter(anchor);
        const atk = attackerCenter(cell);
        assert.deepEqual(got, primaryAxis(center.x - atk.x, center.y - atk.y));
        assert.equal(Math.abs(got.x) + Math.abs(got.y), 1);
        assert.ok(got.x === 0 || got.y === 0);
        const half = primaryAxis(anchor.x + 0.5 - atk.x, anchor.y + 0.5 - atk.y);
        if (half.x !== got.x || half.y !== got.y) report.halfCenterDisagreements += 1;
        report.knockbackCells += 1;
      }
    }
  }
  assert.ok(report.halfCenterDisagreements > 0);
  assert.deepEqual(knockbackFromAttacker({ x: 5, y: 3 }, { x: 4, y: 4 }), { x: 0, y: 1 });
  const half = primaryAxis(4.5 - 5.5, 4.5 - 3.5);
  assert.deepEqual(half, { x: -1, y: 0 });
});

test("illegal packs roll back, then the same revision can be resubmitted", () => {
  const early = setup({ prepare: false });
  expectReject(early, hold(early), "PLAN_PACK_REJECTED");
  assert.equal(early.phase, "enemy_prepare");

  const state = setup({ covers: [] });
  const rev = state.revision;
  expectReject(state, { revision: rev + 9, items: hold(state).items }, "STALE_REVISION");
  expectReject(state, { revision: rev, items: hold(state).items.slice(0, 2) }, "NEED_ALL_OR_CONFIRM");
  expectReject(state, {
    revision: rev,
    items: [
      { mechId: "Assault", moveTo: null, action: { kind: "skip" } },
      { mechId: "Assault", moveTo: null, action: { kind: "skip" } },
      { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    ],
  }, "NEED_ALL_OR_CONFIRM");
  expectReject(state, orders(state, { Assault: { action: { kind: "melee" } } }), "PLAN_PACK_REJECTED");
  expectReject(state, orders(state, { Gunner: { action: { kind: "shoot" } } }), "PLAN_PACK_REJECTED");
  expectReject(state, orders(state, { Assault: { moveTo: { x: 2, y: 4 } } }), "PLAN_PACK_REJECTED");
  expectReject(state, orders(state, {
    Assault: { moveTo: { x: 4, y: 8 } },
    Gunner: { moveTo: { x: 4, y: 8 } },
  }), "PLAN_PACK_REJECTED");

  const cover = setup({ covers: [{ x: 4, y: 8 }], assault: { x: 4, y: 9 } });
  expectReject(cover, orders(cover, { Assault: { moveTo: { x: 4, y: 8 } } }), "PLAN_PACK_REJECTED");

  const ontoBoss = setup({ assault: { x: 4, y: 3 }, boss: { x: 4, y: 0 } });
  expectReject(ontoBoss, orders(ontoBoss, { Assault: { moveTo: { x: 4, y: 1 } } }), "PLAN_PACK_REJECTED");

  const kill = setup({
    covers: [],
    boss: { x: 4, y: 4 },
    assault: { x: 5, y: 3 },
    gunner: { x: 5, y: 8 },
    support: { x: 9, y: 9 },
  });
  kill.boss.hp = 2;
  expectReject(kill, orders(kill, {
    Assault: { action: { kind: "melee" } },
    Gunner: { action: { kind: "shoot" } },
  }), "PLAN_PACK_REJECTED");
  assert.equal(kill.boss.hp, 2);
  applyOk(kill, orders(kill, { Gunner: { action: { kind: "shoot" } } }));
  assert.equal(kill.boss.hp, 2 - strike(4, 3));
  assert.deepEqual(kill.boss.anchor, { x: 4, y: 4 });
  assert.equal(kill.phase, "resolving_boss");

  const again = setup({ covers: [] });
  applyOk(again, orders(again, { Assault: { moveTo: { x: 2, y: 5 } } }));
  assert.deepEqual(mechOf(again, "Assault").pos, { x: 2, y: 5 });
  assert.equal(again.phase, "resolving_boss");
  assert.equal(again.outcome, null);
});

test("cadence is smash smash sweep, and cooldown falls back to smash", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  const skills: string[] = [];
  for (let i = 0; i < 9; i += 1) {
    const before = state.mechs.map((m) => ({ id: m.id, pos: { ...m.pos }, hp: m.hp }));
    skills.push(bossPrepare(state).skillId);
    assert.equal(state.phase, "player_plan");
    applyOk(state, hold(state));
    assert.equal(state.phase, "resolving_boss");
    assert.equal(state.outcome, null);
    bossExecute(state);
    assert.deepEqual(state.mechs.map((m) => ({ id: m.id, pos: m.pos, hp: m.hp })), before);
    report.cadenceHolds += 1;
  }
  assert.deepEqual(skills, ["smash", "smash", "sweep", "smash", "smash", "sweep", "smash", "smash", "sweep"]);

  const cooled = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  setScriptCounters(cooled, 2, 1);
  assert.equal(bossPrepare(cooled).skillId, "smash");

  const drill = createMatch({ preset: "covers_diag_corridor", script: "stationary_smash" });
  for (let i = 0; i < 6; i += 1) {
    assert.equal(bossPrepare(drill).skillId, "smash");
    applyOk(drill, hold(drill));
    bossExecute(drill);
  }
});

test("sweep picks the spec pair, including a diagonal that shares no edge", () => {
  const layouts: MatchState[] = [
    setup({
      prepare: false,
      script: "cadence_ssw",
      covers: [{ x: 6, y: 0 }],
      boss: { x: 4, y: 0 },
      assault: { x: 6, y: 1 },
      gunner: { x: 0, y: 9 },
      support: { x: 9, y: 9 },
    }),
    setup({
      prepare: false,
      script: "cadence_ssw",
      covers: [],
      boss: { x: 4, y: 0 },
      assault: { x: 3, y: 1 },
      gunner: { x: 6, y: 1 },
      support: { x: 9, y: 9 },
    }),
    setup({
      prepare: false,
      script: "cadence_ssw",
      covers: [],
      boss: { x: 4, y: 4 },
      assault: { x: 3, y: 3 },
      support: { x: 3, y: 5 },
      gunner: { x: 9, y: 9 },
    }),
  ];
  for (const preset of PRESETS) {
    layouts.push(createMatch({ preset, script: "cadence_ssw" }));
  }
  for (const state of layouts) {
    const want = specSweep(state);
    assert.ok(want);
    setScriptCounters(state, 2, 0);
    const intent = bossPrepare(state);
    assert.equal(intent.skillId, "sweep");
    assert.deepEqual(intent.projected, want);
    assert.ok(Math.abs(want[0].x - want[1].x) + Math.abs(want[0].y - want[1].y) <= 2);
    report.sweepLayouts += 1;
  }
  const diagonal = layouts[2];
  assert.ok(diagonal);
  assert.deepEqual(diagonal.boss.intent?.projected, [{ x: 3, y: 3 }, { x: 3, y: 5 }]);
  assert.equal(Math.abs(3 - 3) + Math.abs(3 - 5), 2);

  const split = layouts[1];
  assert.ok(split?.boss.intent);
  const picked = split.boss.intent.projected.map(keyOf).sort();
  assert.notDeepEqual(picked, ["3,1", "6,1"]);
});

test("smash pushes from the true center; sweep does not; lethal skips the push", () => {
  const anchor = { x: 4, y: 4 };
  const target = { x: 5, y: 3 };
  const dir = bossPushDir(anchor, target);
  const wrong = wrongHalfPush(anchor, target);
  assert.deepEqual(dir, { x: 0, y: -1 });
  assert.deepEqual(wrong, { x: 1, y: 0 });

  const smashed = setup({
    covers: [],
    boss: anchor,
    assault: target,
    gunner: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  assert.deepEqual(smashed.boss.intent?.projected, [target]);
  applyOk(smashed, hold(smashed));
  bossExecute(smashed);
  assert.deepEqual(mechOf(smashed, "Assault").pos, { x: target.x + dir.x, y: target.y + dir.y });
  assert.notDeepEqual(mechOf(smashed, "Assault").pos, { x: target.x + wrong.x, y: target.y + wrong.y });
  assert.equal(mechOf(smashed, "Assault").hp, MAX_HP.Assault - strike(6, 2));
  assert.deepEqual(smashed.boss.anchor, anchor);

  const swept = setup({
    prepare: false,
    script: "cadence_ssw",
    covers: [{ x: 6, y: 0 }],
    boss: { x: 4, y: 0 },
    assault: { x: 6, y: 1 },
    gunner: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  setScriptCounters(swept, 2, 0);
  assert.equal(bossPrepare(swept).skillId, "sweep");
  const pos = { ...mechOf(swept, "Assault").pos };
  applyOk(swept, hold(swept));
  bossExecute(swept);
  assert.deepEqual(mechOf(swept, "Assault").pos, pos);
  assert.equal(mechOf(swept, "Assault").hp, MAX_HP.Assault - strike(6, 2));
  assert.deepEqual(swept.boss.anchor, { x: 4, y: 0 });

  const collided = setup({
    covers: [],
    boss: anchor,
    assault: target,
    support: { x: 5, y: 2 },
    gunner: { x: 0, y: 9 },
  });
  applyOk(collided, hold(collided));
  bossExecute(collided);
  assert.deepEqual(mechOf(collided, "Assault").pos, target);
  assert.equal(mechOf(collided, "Assault").hp, MAX_HP.Assault - strike(6, 2) - 2);
  assert.equal(mechOf(collided, "Support").hp, MAX_HP.Support - 2);
  assert.deepEqual(mechOf(collided, "Support").pos, { x: 5, y: 2 });

  const intoCover = setup({
    covers: [{ x: 5, y: 2 }],
    boss: anchor,
    assault: target,
    gunner: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  applyOk(intoCover, hold(intoCover));
  bossExecute(intoCover);
  assert.deepEqual(mechOf(intoCover, "Assault").pos, target);
  assert.equal(mechOf(intoCover, "Assault").hp, MAX_HP.Assault - strike(6, 2) - 2);
  assert.equal(intoCover.boss.hp, BOSS_HP);

  const offBoard = setup({
    covers: [],
    boss: { x: 7, y: 4 },
    assault: { x: 9, y: 5 },
    gunner: { x: 0, y: 0 },
    support: { x: 0, y: 9 },
  });
  applyOk(offBoard, hold(offBoard));
  bossExecute(offBoard);
  assert.deepEqual(mechOf(offBoard, "Assault").pos, { x: 9, y: 5 });
  assert.equal(mechOf(offBoard, "Assault").hp, MAX_HP.Assault - strike(6, 2) - 2);
  assert.equal(offBoard.boss.hp, BOSS_HP);

  const melee = setup({
    covers: [],
    boss: anchor,
    assault: target,
    gunner: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  applyOk(melee, orders(melee, { Assault: { action: { kind: "melee" } } }));
  assert.equal(melee.boss.hp, BOSS_HP - strike(5, 3));
  assert.deepEqual(melee.boss.anchor, { x: 4, y: 5 });
  bossExecute(melee);
  assert.equal(mechOf(melee, "Assault").hp, MAX_HP.Assault);
  assert.deepEqual(mechOf(melee, "Assault").pos, target);

  const lethal = setup({
    covers: [],
    boss: anchor,
    assault: target,
    gunner: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  lethal.boss.hp = strike(5, 3);
  applyOk(lethal, orders(lethal, { Assault: { action: { kind: "melee" } } }));
  assert.equal(lethal.boss.hp, 0);
  assert.deepEqual(lethal.boss.anchor, anchor);
  assert.equal(lethal.outcome, "victory");
  assert.equal(lethal.phase, "finished");
  bossExecute(lethal);
  assert.equal(lethal.phase, "finished");
  assert.equal(lethal.turn, 1);
  assert.deepEqual(lethal.boss.anchor, anchor);
});

test("shot, pierce, repair, and skill cooldown follow the stat block", () => {
  const shot = setup({
    covers: [],
    boss: { x: 4, y: 4 },
    gunner: { x: 5, y: 8 },
    assault: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  assert.ok(legalActions(shot, "Gunner").some((a) => a.kind === "shoot"));
  assert.ok(legalActions(shot, "Gunner").some((a) => a.kind === "pierce"));
  applyOk(shot, orders(shot, { Gunner: { action: { kind: "pierce" } } }));
  assert.equal(shot.boss.hp, BOSS_HP - strike(4, 3));
  assert.deepEqual(shot.boss.anchor, { x: 4, y: 4 });
  assert.equal(mechOf(shot, "Gunner").cd, 1);
  bossExecute(shot);
  bossPrepare(shot);
  const cooled = legalActions(shot, "Gunner").map((a) => a.kind);
  assert.ok(cooled.includes("shoot"));
  assert.equal(cooled.includes("pierce"), false);
  applyOk(shot, hold(shot));
  bossExecute(shot);
  bossPrepare(shot);
  assert.ok(legalActions(shot, "Gunner").some((a) => a.kind === "pierce"));

  const blocked = setup({
    covers: [{ x: 5, y: 6 }],
    boss: { x: 4, y: 4 },
    gunner: { x: 5, y: 8 },
    assault: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  const kinds = legalActions(blocked, "Gunner").map((a) => a.kind);
  assert.equal(kinds.includes("shoot"), false);
  assert.ok(kinds.includes("pierce"));
  const walled = setup({
    covers: [{ x: 5, y: 6 }, { x: 5, y: 7 }],
    boss: { x: 4, y: 4 },
    gunner: { x: 5, y: 8 },
    assault: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  expectReject(walled, orders(walled, { Gunner: { action: { kind: "pierce" } } }), "PLAN_PACK_REJECTED");

  const healed = setup({
    covers: [],
    assault: { x: 2, y: 9 },
    support: { x: 2, y: 8 },
    gunner: { x: 9, y: 9 },
  });
  mechOf(healed, "Assault").hp = 5;
  applyOk(healed, orders(healed, { Support: { action: { kind: "repair", target: "Assault" } } }));
  assert.equal(mechOf(healed, "Assault").hp, 9);

  const capped = setup({
    covers: [],
    assault: { x: 2, y: 9 },
    support: { x: 2, y: 8 },
    gunner: { x: 9, y: 9 },
  });
  mechOf(capped, "Assault").hp = 12;
  applyOk(capped, orders(capped, { Support: { action: { kind: "repair", target: "Assault" } } }));
  assert.equal(mechOf(capped, "Assault").hp, MAX_HP.Assault);
});

test("preset covers stay on the named cells", () => {
  assert.deepEqual(COVERS.covers_sparse_mid, [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }]);
  assert.equal(COVERS.covers_diag_corridor.length, 5);
  assert.equal(COVERS.covers_twin_clusters.length, 6);
  for (const preset of PRESETS) {
    const state = createMatch({ preset, script: "cadence_ssw" });
    assert.deepEqual(state.covers, COVERS[preset]);
    const intent = bossPrepare(state);
    assert.equal(intent.skillId, "smash");
    assert.deepEqual(intent.projected, specSmash(state) ? [specSmash(state)] : []);
    checkBoard(state);
  }
  const aimed = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw" });
  const opening = bossPrepare(aimed);
  assert.deepEqual(opening.projected, [{ x: 5, y: 2 }]);
});

test("seeded search and random play stay inside the rules", { timeout: 120_000 }, () => {
  const jobs: Array<{ preset: CoverPresetId; strategy: "random" | "search"; seed: number }> = [];
  for (const preset of PRESETS) {
    jobs.push({ preset, strategy: "search", seed: 0x51a7 });
    jobs.push({ preset, strategy: "random", seed: 0xc0f1 });
  }
  for (const job of jobs) {
    const first = play(job.preset, job.strategy, job.seed);
    const second = play(job.preset, job.strategy, job.seed);
    assert.equal(snap(first.state), snap(second.state));
    report.deterministicReplays += 1;
    report.outcomes.push({
      preset: job.preset,
      strategy: job.strategy,
      outcome: first.state.outcome,
      bossHp: first.state.boss.hp,
      turn: first.state.turn,
      living: first.state.mechs.filter((m) => m.hp > 0).length,
      bossDamage: first.bossDamage,
    });
  }
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

test("eight seeds record turn spread and whether the telegraph lands", { timeout: 180_000 }, () => {
  for (const preset of PRESETS) {
    for (const strategy of ["search", "random"] as const) {
      const turns: number[] = [];
      const damage: number[] = [];
      let wins = 0;
      let timeouts = 0;
      let wipes = 0;
      let matchesHit = 0;
      for (let i = 0; i < 8; i += 1) {
        const seed = (strategy === "search" ? 0x51a7 : 0xc0f1) + i * 17;
        const played = play(preset, strategy, seed);
        turns.push(played.state.turn);
        damage.push(played.bossDamage);
        if (played.bossDamage > 0) matchesHit += 1;
        if (played.state.outcome === "victory") wins += 1;
        else if (played.state.outcome === "defeat_timeout") timeouts += 1;
        else wipes += 1;
      }
      report.spread.push({
        preset,
        strategy,
        n: 8,
        wins,
        timeouts,
        wipes,
        minTurn: Math.min(...turns),
        medianTurn: median(turns),
        maxTurn: Math.max(...turns),
        matchesHit,
        medianBossDamage: median(damage),
      });
    }
  }
  assert.equal(report.spread.length, 6);
  for (const row of report.spread) {
    assert.equal(row.n, 8);
    assert.ok(row.minTurn <= row.medianTurn && row.medianTurn <= row.maxTurn);
    assert.equal(row.wins + row.timeouts + row.wipes, 8);
  }
});

const DEFENSE_BUILDINGS = [
  { id: "west", cells: [{ x: 4, y: 4 }] },
  { id: "mid", cells: [{ x: 5, y: 4 }] },
  { id: "north", cells: [{ x: 4, y: 5 }] },
];

function defenseMatch(patch?: {
  script?: BossScriptId;
  buildings?: Array<{ id: string; cells: Cell[]; hp?: number }>;
  boss?: Cell;
  assault?: Cell;
  gunner?: Cell;
  support?: Cell;
  covers?: Cell[];
}): MatchState {
  return createMatch({
    preset: "covers_sparse_mid",
    script: patch?.script ?? "raid_ssw",
    covers: patch?.covers ?? [],
    buildings: patch?.buildings ?? DEFENSE_BUILDINGS,
    boss: patch?.boss ?? { x: 4, y: 0 },
    mechs: [
      { id: "Assault", pos: patch?.assault ?? { x: 2, y: 9 } },
      { id: "Gunner", pos: patch?.gunner ?? { x: 5, y: 9 } },
      { id: "Support", pos: patch?.support ?? { x: 8, y: 9 } },
    ],
  });
}

function buildingHp(state: MatchState): number {
  return state.buildings.reduce((sum, b) => sum + b.hp, 0);
}

function playDefense(strategy: "hold" | "search"): { state: MatchState; bossDamage: number } {
  const state = defenseMatch();
  let guard = 0;
  let bossDamage = 0;
  while (state.outcome === null) {
    guard += 1;
    assert.ok(guard <= 15, "defense match did not finish");
    bossPrepare(state);
    const plan = strategy === "search" ? searchPlan(state) : hold(state);
    applyOk(state, plan);
    if (state.outcome) break;
    const before = squadHp(state);
    bossExecute(state);
    bossDamage += before - squadHp(state);
  }
  return { state, bossDamage };
}

test("defense spawns sit on open flat ground, off the buildings", () => {
  const state = defenseMatch();
  assert.equal(spawnsAreOpenGround(state), true);
  const spawnCells = [
    ...state.mechs.map((m) => m.pos),
    state.boss.anchor,
    { x: state.boss.anchor.x + 1, y: state.boss.anchor.y },
    { x: state.boss.anchor.x, y: state.boss.anchor.y + 1 },
    { x: state.boss.anchor.x + 1, y: state.boss.anchor.y + 1 },
  ];
  assert.ok(flatSpawnSpread(spawnCells.map(() => 0)) <= FLAT_SPAWN_MAX_DELTA);
  assert.ok(flatSpawnSpread([0, 0, FLAT_SPAWN_MAX_DELTA + 1]) > FLAT_SPAWN_MAX_DELTA);
  const crowded = defenseMatch({ assault: { x: 4, y: 4 } });
  assert.equal(spawnsAreOpenGround(crowded), false);
});

test("a building hit costs 6 HP, does not push, and one ruin is not a loss", () => {
  const state = defenseMatch({
    script: "stationary_smash",
    buildings: [{ id: "near", cells: [{ x: 5, y: 2 }], hp: BUILDING_HP }, { id: "far", cells: [{ x: 8, y: 8 }] }],
  });
  const anchor = { ...state.boss.anchor };
  for (let hit = 1; hit <= 3; hit += 1) {
    const intent = bossPrepare(state);
    assert.equal(intent.skillId, "smash");
    assert.deepEqual(intent.projected, [{ x: 5, y: 2 }]);
    applyOk(state, hold(state));
    bossExecute(state);
    assert.deepEqual(state.boss.anchor, anchor);
  }
  assert.equal(buildingDamage(), 6);
  assert.equal(state.buildings[0]?.hp, 0);
  assert.equal(state.buildings[1]?.hp, BUILDING_HP);
  assert.equal(state.outcome, null);
  assert.equal(livingBuildings(state).length, 1);
  assert.equal(pathDistance(state, { x: 5, y: 3 }, { x: 5, y: 2 }, "Assault"), null);
});

test("smash prefers an adjacent mech over a building", () => {
  const state = defenseMatch({
    script: "stationary_smash",
    buildings: [{ id: "block", cells: [{ x: 6, y: 1 }] }],
    assault: { x: 3, y: 1 },
    gunner: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  const intent = bossPrepare(state);
  assert.deepEqual(intent.projected, [{ x: 3, y: 1 }]);
  const before = mechOf(state, "Assault").hp;
  applyOk(state, hold(state));
  bossExecute(state);
  assert.ok(mechOf(state, "Assault").hp < before);
  assert.equal(state.buildings[0]?.hp, BUILDING_HP);
  assert.equal(state.outcome, null);
});

test("raid steps toward the nearer building, at most 3 cells", () => {
  const state = defenseMatch({
    boss: { x: 1, y: 0 },
    buildings: [{ id: "south", cells: [{ x: 2, y: 6 }] }],
    assault: { x: 9, y: 9 },
    gunner: { x: 8, y: 9 },
    support: { x: 7, y: 9 },
  });
  const before = objectiveGapOf(state);
  bossPrepare(state);
  assert.deepEqual(state.boss.anchor, { x: 1, y: 3 });
  assert.ok(objectiveGapOf(state) < before);
  assert.equal(state.boss.intent?.skillId, "smash");
});

test("one sweep damages a two-cell building once", () => {
  const state = defenseMatch({
    script: "cadence_ssw",
    boss: { x: 4, y: 4 },
    buildings: [{ id: "wide", cells: [{ x: 3, y: 3 }, { x: 3, y: 5 }] }],
    assault: { x: 0, y: 0 },
    gunner: { x: 9, y: 0 },
    support: { x: 9, y: 9 },
  });
  setScriptCounters(state, 2, 0);
  const intent = bossPrepare(state);
  assert.equal(intent.skillId, "sweep");
  assert.deepEqual(intent.projected, [{ x: 3, y: 3 }, { x: 3, y: 5 }]);
  applyOk(state, hold(state));
  bossExecute(state);
  assert.equal(state.buildings[0]?.hp, BUILDING_HP - buildingDamage());
  assert.equal(state.outcome, null);
});

test("killing the boss is a win while a building still stands", () => {
  const state = defenseMatch({
    script: "stationary_smash",
    boss: { x: 4, y: 4 },
    gunner: { x: 5, y: 8 },
    assault: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
    buildings: [{ id: "side", cells: [{ x: 1, y: 1 }] }],
  });
  state.boss.hp = 1;
  bossPrepare(state);
  applyOk(state, orders(state, { Gunner: { action: { kind: "shoot" } } }));
  assert.equal(state.outcome, "victory");
  assert.equal(state.phase, "finished");
  assert.equal(buildingHp(state), BUILDING_HP);
});

test("a building cell blocks a shot the way cover does", () => {
  const state = defenseMatch({
    script: "stationary_smash",
    boss: { x: 4, y: 4 },
    buildings: [{ id: "wall", cells: [{ x: 5, y: 6 }] }],
    gunner: { x: 5, y: 8 },
    assault: { x: 0, y: 9 },
    support: { x: 9, y: 9 },
  });
  bossPrepare(state);
  const kinds = legalActions(state, "Gunner").map((a) => a.kind);
  assert.equal(kinds.includes("shoot"), false);
  assert.ok(kinds.includes("pierce"));
});

test("hold stalls on the rear building; search records the same board", { timeout: 60_000 }, () => {
  for (const strategy of ["hold", "search"] as const) {
    const played = playDefense(strategy);
    const left = livingBuildings(played.state);
    report.defense.push({
      strategy,
      outcome: played.state.outcome,
      turn: played.state.turn,
      bossHp: played.state.boss.hp,
      buildingHp: buildingHp(played.state),
      buildingsLeft: left.length,
      living: played.state.mechs.filter((m) => m.hp > 0).length,
      bossDamage: played.bossDamage,
    });
    assert.ok(
      played.state.outcome === "victory"
      || played.state.outcome === "defeat_wipe"
      || played.state.outcome === "defeat_timeout"
      || played.state.outcome === "defeat_buildings",
    );
    if (played.state.outcome === "defeat_buildings") {
      assert.equal(left.length, 0);
      assert.ok(played.state.boss.hp > 0);
    }
    if (played.state.outcome === "victory") {
      assert.equal(played.state.boss.hp, 0);
      assert.ok(left.length > 0);
    }
    for (const b of played.state.buildings) {
      for (const c of b.cells) {
        const onBoss = played.state.boss.hp > 0
          && c.x >= played.state.boss.anchor.x && c.x <= played.state.boss.anchor.x + 1
          && c.y >= played.state.boss.anchor.y && c.y <= played.state.boss.anchor.y + 1;
        assert.equal(onBoss, false);
      }
    }
  }
  const held = report.defense.find((row) => row.strategy === "hold");
  assert.equal(held?.outcome, "defeat_timeout");
  assert.equal(held?.buildingsLeft, 1);
  assert.equal(held?.buildingHp, BUILDING_HP);
  assert.equal(held?.bossHp, BOSS_HP);
  assert.equal(held?.bossDamage, 0);
});

function objectiveGapOf(state: MatchState): number {
  const goals = state.buildings.filter((b) => b.hp > 0).flatMap((b) => b.cells);
  let best = 99;
  const foot = [
    state.boss.anchor,
    { x: state.boss.anchor.x + 1, y: state.boss.anchor.y },
    { x: state.boss.anchor.x, y: state.boss.anchor.y + 1 },
    { x: state.boss.anchor.x + 1, y: state.boss.anchor.y + 1 },
  ];
  for (const f of foot) for (const g of goals) best = Math.min(best, Math.abs(f.x - g.x) + Math.abs(f.y - g.y));
  return best;
}
