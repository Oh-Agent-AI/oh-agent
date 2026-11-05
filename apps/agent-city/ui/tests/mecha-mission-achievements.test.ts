import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { buildMissionAchievements, type MissionAchievementRound } from "../src/game/mecha/missionAchievements.ts";
import { buildHealthTimeline } from "../src/game/mecha/healthTimeline.ts";
import { bossPrepare, createMatch, playTurn, MECH_IDS, moveBudget, pathRoute, setScriptCounters, type MatchState } from "../src/game/mecha/rules.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { createLocalReplayArchive, restoreLocalReplayArchive, type ReplaySourceRound } from "../src/game/mecha/replayArchive.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { planForDoctrine } from "../src/game/mecha/ai.ts";
import type { CityMechaSite } from "../src/game/mecha/citySite.ts";

const options = { preset: "covers_sparse_mid" as const, script: "stationary_smash" as const,
  covers: [], stake: "all" as const, buildings: [{ id: "home", cells: [{ x: 3, y: 3 }], hp: 10 }] };
const values = (result: ReturnType<typeof buildMissionAchievements>) => result?.items.map(item => item.status);
function fixture(rescue = false) {
  const before = createMatch({ ...options, boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 7, y: 0 } },
  ], ...(rescue ? { mission: "rescue:v1" as const } : {}) });
  before.boss.hp = 1;
  bossPrepare(before);
  if (rescue) before.mission!.target = { ...before.mechs[0]!.pos };
  const plan = { revision: before.revision, items: MECH_IDS.map(mechId => ({ mechId, moveTo: null,
    action: mechId === "Assault" && !rescue ? { kind: "melee" as const, target: "boss" } : { kind: "skip" as const } })) };
  const result = playTurn(before, plan);
  assert.ok(result.ok); assert.equal(result.state.outcome, "victory");
  const rounds: MissionAchievementRound[] = [{ before, after: result.state, plan, log: result.log }];
  return { final: result.state, rounds };
}
const evaluate = (f: { final: MatchState; rounds?: MissionAchievementRound[] | null }) =>
  buildMissionAchievements({ scope: "local-pve", ...f });

test("complete legacy victory shows only explicit history facts and leaves its inputs untouched", () => {
  const f = fixture(); const original = structuredClone(f);
  assert.deepEqual(values(evaluate(f)), ["achieved", "achieved"]);
  assert.deepEqual(f, original);
});

test("self-consistent invented damage and repair events fail authoritative replay", () => {
  const f = fixture(); const m = f.rounds[0]!.before.mechs[0]!;
  // Reconciled effects alone are insufficient: these events never happened under the plan.
  const originalLog = structuredClone(f.rounds[0]!.log);
  for (const event of originalLog) if ("effects" in event) for (const effect of event.effects ?? []) effect.order += 4;
  f.rounds[0]!.log = [
    { type: "enemy", actor: "boss", skill: "smash", cells: [], damage: m.hp + 2, effects: [
      { kind: "mech", id: m.id, before: m.hp, after: 0, order: 0 },
      { kind: "building", id: "home", before: 10, after: 8, order: 1 },
    ] },
    { type: "act", mechId: "Support", action: "repair", target: m.id, damage: 0, effects: [
      { kind: "mech", id: m.id, before: 0, after: m.hp, order: 2 },
      { kind: "building", id: "home", before: 8, after: 10, order: 3 },
    ] }, ...originalLog,
  ];
  assert.equal(buildHealthTimeline(f.rounds[0]!.before, f.final, f.rounds[0]!.log).ok, true);
  assert.deepEqual(values(evaluate(f)), ["unverifiable", "unverifiable"]);
});

test("rescue never calls buildings a protection objective, including incomplete records", () => {
  const f = fixture(true);
  assert.deepEqual(values(evaluate(f)), ["achieved", "not-applicable"]);
  assert.deepEqual(values(evaluate({ final: f.final, rounds: [] })), ["unverifiable", "not-applicable"]);
});

test("legacy empty target differs from missing or unknown objective data", () => {
  const f = fixture(); f.rounds[0]!.before.buildings = []; f.final.buildings = [];
  assert.deepEqual(values(evaluate(f)), ["achieved", "not-applicable"]);
  for (const mutate of [
    (v: typeof f) => { delete (v.final as Partial<MatchState>).buildings; },
    (v: typeof f) => { (v.final as any).mission = { kind: "future:v2", target: { x: 0, y: 0 } }; },
    (v: typeof f) => { delete (v.final as Partial<MatchState>).stake; },
  ]) {
    const bad = structuredClone(f); mutate(bad);
    assert.deepEqual(values(evaluate(bad)), ["unverifiable", "unverifiable"]);
  }
});

test("truncated, contradictory, old and malformed histories cannot earn achievements", () => {
  const f = fixture();
  assert.deepEqual(values(evaluate({ final: f.final })), ["unverifiable", "unverifiable"]);
  for (const mutate of [
    (v: typeof f) => { v.rounds[0]!.before.turn = 2; },
    (v: typeof f) => { v.final = structuredClone(v.final); v.final.revision++; },
    (v: typeof f) => { v.rounds[0]!.log = []; },
    (v: typeof f) => { delete v.rounds[0]!.plan; },
    (v: typeof f) => { v.rounds[0]!.plan!.revision++; },
    (v: typeof f) => { v.rounds[0]!.log.unshift({ type: "act", mechId: "Assault", action: "skip", damage: 0 }); },
    (v: typeof f) => { v.rounds[0]!.log.unshift({ type: "enemy", actor: "boss", skill: "smash", cells: [], damage: 1 }); },
    (v: typeof f) => { v.final.mechs[0]!.hp--; },
    (v: typeof f) => { v.rounds[0]!.before.mechs[0]!.hp--; },
    (v: typeof f) => { v.final.mechs[0]!.hp = NaN; },
    (v: typeof f) => { v.final.mechs[1]!.id = v.final.mechs[0]!.id; },
    (v: typeof f) => { v.final.buildings[0]!.maxHp = 0; },
    (v: typeof f) => { v.rounds[0]!.log.unshift({ type: "enemy", actor: "boss", skill: "smash", cells: [], damage: 2,
      effects: [{ kind: "mech", id: "Assault", before: 14, after: 13, order: 0 }] }); },
  ]) {
    const broken = structuredClone(f); mutate(broken);
    assert.deepEqual(values(evaluate(broken)), ["unverifiable", "unverifiable"]);
  }
  const changedObjective = fixture(true); delete changedObjective.rounds[0]!.before.mission;
  assert.deepEqual(values(evaluate(changedObjective)), ["unverifiable", "unverifiable"]);
  const frontage = fixture(); frontage.final.stake = "frontage"; frontage.rounds[0]!.before.stake = "frontage";
  frontage.final.terrain[0] = [];
  assert.deepEqual(values(evaluate(frontage)), ["unverifiable", "unverifiable"]);
});

test("only an explicitly local PvE victory is eligible", () => {
  const f = fixture();
  assert.equal(buildMissionAchievements({ scope: "other", ...f }), null);
  assert.equal(buildMissionAchievements({ scope: "local-pve", final: null }), null);
  const lost = structuredClone(f.final); lost.outcome = "defeat_wipe";
  assert.equal(evaluate({ final: lost, rounds: f.rounds }), null);
  lost.phase = "player_plan"; lost.outcome = null;
  assert.equal(evaluate({ final: lost, rounds: f.rounds }), null);
});

test("real rescue turn yields usable local replay-shaped records", () => {
  const before = createMatch({ ...options, mission: "rescue:v1" }); bossPrepare(before);
  before.mission!.target = { ...before.mechs[0]!.pos };
  const plan = { revision: before.revision, items: MECH_IDS.map(mechId => ({ mechId, moveTo: null, action: { kind: "skip" as const } })) };
  const result = playTurn(before, plan);
  assert.ok(result.ok); assert.equal(result.state.outcome, "victory");
  assert.deepEqual(values(evaluate({ final: result.state, rounds: [{ before, after: result.state, plan, log: result.log }] })), ["achieved", "not-applicable"]);
});

test("component has readable localized status and no settlement controls", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { MechaMissionAchievements } = await server.ssrLoadModule("/src/game/MechaMissionAchievements.tsx");
    const achievements = evaluate({ final: fixture(true).final, rounds: [] });
    for (const [locale, text] of [["en", ["Optional battle facts", "Cannot verify", "No such objective", "This mission has no protected-building objective."]],
      ["zh-Hans", ["可选战斗事实", "无法核验", "无此目标", "本任务没有保护建筑目标。"]]] as const) {
      const html = renderToStaticMarkup(createElement(MechaMissionAchievements, { achievements, locale }));
      for (const part of text) assert.ok(html.includes(part), part);
      assert.match(html, /<section[^>]*aria-label=/);
      assert.doesNotMatch(html, /<button|<dialog|tabindex=/i);
    }
    assert.equal(renderToStaticMarkup(createElement(MechaMissionAchievements, { achievements: null, locale: "en" })), "");
  } finally { await server.close(); }
});


test("real multi-turn rescue archive reconstructs the same facts; missing or disconnected rounds do not", async () => {
  const site: CityMechaSite = {
    originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
    terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
    heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)), buildings: [], blocked: [],
    mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
    boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0,
  };
  const opts = { preset: "covers_sparse_mid" as const, script: "stationary_smash" as const, stake: "all" as const, mission: "rescue:v1" as const };
  let state = matchFromSite(site, opts); bossPrepare(state);
  const rounds: ReplaySourceRound[] = [];
  for (let i = 0; i < 15 && !state.outcome; i++) {
    const unit = state.mechs.find(m => m.hp > 0 && pathRoute(state, m.pos, state.mission!.target, m.id, { alliesPass: true }));
    assert.ok(unit);
    const route = pathRoute(state, unit.pos, state.mission!.target, unit.id, { alliesPass: true })!;
    const destination = [...route.cells].reverse().find(cell => !state.mechs.some(m => m.id !== unit.id && m.hp > 0 && m.pos.x === cell.x && m.pos.y === cell.y)
      && (pathRoute(state, unit.pos, cell, unit.id, { alliesPass: true })?.cost ?? Infinity) <= moveBudget(unit.id));
    assert.ok(destination);
    const plan = { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: m.id === unit.id ? destination : null, action: { kind: "skip" as const } })) };
    const result = playTurn(state, plan); assert.ok(result.ok);
    rounds.push({ before: state, after: result.state, plan, log: result.log, presentationStages: result.presentationStages });
    state = result.state;
  }
  assert.equal(state.outcome, "victory"); assert.ok(rounds.length > 1);
  const source = { site, preset: opts.preset, script: opts.script, stake: opts.stake, deployment: false, rounds };
  const restored = await restoreLocalReplayArchive(await createLocalReplayArchive(source), site);
  assert.deepEqual(evaluate({ final: state, rounds: restored }), evaluate({ final: state, rounds }));
  assert.deepEqual(values(evaluate({ final: state, rounds: restored })), ["achieved", "not-applicable"]);
  assert.deepEqual(values(evaluate({ final: state, rounds: restored.slice(1) })), ["unverifiable", "not-applicable"]);
  const disconnected = structuredClone(restored);
  disconnected[1]!.before = structuredClone(disconnected[1]!.before);
  disconnected[1]!.before.revision++;
  assert.deepEqual(values(evaluate({ final: state, rounds: disconnected })), ["unverifiable", "not-applicable"]);
});


function controllerSite(): CityMechaSite {
  return { originX: 7, originZ: 4, yaw: 0, cellW: 8, cellD: 8,
    terrain: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const)),
    heights: Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0)), buildings: [], blocked: [],
    mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })),
    boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0 };
}

test("authoritative legacy frontage excludes non-target damage and falls back when no road fronts a building", () => {
  for (const road of [true, false]) {
    const terrain = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as "land" | "road"));
    if (road) terrain[7]![7] = "road";
    const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], stake: "frontage", terrain,
      buildings: [{ id: "home", cells: [{ x: 3, y: 1 }], hp: 10 }, { id: "front", cells: [{ x: 8, y: 7 }], hp: 10 }],
      boss: { x: 4, y: 0 }, mechs: [{ id: "Assault", pos: { x: 2, y: 5 } },
        { id: "Gunner", pos: { x: 6, y: 5 } }, { id: "Support", pos: { x: 7, y: 5 } }] });
    match.boss.hp = 1; bossPrepare(match);
    const controller = createMechaController({ site: controllerSite(), match, deployment: false, animate: false,
      planner: (state, doctrine) => state.turn === 1 ? { revision: state.revision,
        items: MECH_IDS.map(mechId => ({ mechId, moveTo: null, action: { kind: "skip" as const } })) } : planForDoctrine(state, doctrine) });
    controller.startAuto();
    for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) controller.tick();
    const final = controller.getState().match, source = controller.replayArchiveSource();
    assert.equal(final.outcome, "victory"); assert.ok(source);
    assert.deepEqual(final.buildings.map(b => b.hp), [4, 10]);
    assert.deepEqual(values(evaluate({ final, rounds: source.rounds })), ["achieved", road ? "achieved" : "not-achieved"]);
  }
});

test("authoritative rescue victory tolerates a destroyed building and has no protection objective", () => {
  let state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], mission: "rescue:v1",
    buildings: [{ id: "home", cells: [{ x: 3, y: 1 }], hp: 5 }], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 2, y: 5 } }, { id: "Gunner", pos: { x: 6, y: 5 } }, { id: "Support", pos: { x: 7, y: 5 } }] });
  bossPrepare(state); state.mission!.target = { x: 2, y: 4 };
  const rounds: MissionAchievementRound[] = [];
  for (let turn = 1; turn <= 2; turn++) {
    const plan = { revision: state.revision, items: MECH_IDS.map(mechId => ({ mechId,
      moveTo: turn === 2 && mechId === "Assault" ? { x: 2, y: 4 } : null, action: { kind: "skip" as const } })) };
    const result = playTurn(state, plan); assert.ok(result.ok);
    rounds.push({ before: state, after: result.state, plan, log: result.log }); state = result.state;
  }
  assert.equal(state.outcome, "victory"); assert.equal(state.buildings[0]!.hp, 0);
  assert.deepEqual(values(evaluate({ final: state, rounds })), ["achieved", "not-applicable"]);
});

test("authoritative rescue records a lost starting mech despite victory", () => {
  let state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [{ x: 2, y: 1 }],
    mission: "rescue:v1", buildings: [], boss: { x: 4, y: 0 },
    mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 5 } }, { id: "Support", pos: { x: 7, y: 5 } }] });
  bossPrepare(state); state.mission!.target = { x: 6, y: 4 };
  const rounds: MissionAchievementRound[] = [];
  for (let turn = 1; turn <= 4; turn++) {
    const plan = { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id,
      moveTo: turn === 4 && m.id === "Gunner" ? { x: 6, y: 4 } : null, action: { kind: "skip" as const } })) };
    const result = playTurn(state, plan); assert.ok(result.ok);
    rounds.push({ before: state, after: result.state, plan, log: result.log }); state = result.state;
  }
  assert.equal(state.outcome, "victory"); assert.equal(state.mechs[0]!.hp, 0);
  assert.deepEqual(values(evaluate({ final: state, rounds })), ["not-achieved", "not-applicable"]);
});

test("controller accepted rounds preserve armour, collision victims, nested shove and capped repair", () => {
  const match = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [{ x: 2, y: 1 }], boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 7, y: 0 } },
  ] });
  match.boss.hp = 8; bossPrepare(match);
  const controller = createMechaController({ site: controllerSite(), match, deployment: false, animate: false,
    planner: (state, doctrine) => state.turn === 1 ? { revision: state.revision, items: [
      { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
      { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
      { mechId: "Support", moveTo: null, action: { kind: "repair", target: "Gunner" } },
    ] } : planForDoctrine(state, doctrine) });
  controller.startAuto();
  for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) controller.tick();
  const final = controller.getState().match, source = controller.replayArchiveSource();
  assert.equal(final.outcome, "victory"); assert.ok(source);
  const log = source.rounds[0]!.log;
  const attack = log.find(event => event.type === "act" && event.action === "melee");
  const collision = log.find(event => event.type === "shove" && event.unit === "boss");
  const repair = log.find(event => event.type === "act" && event.action === "repair");
  const enemy = log.find(event => event.type === "enemy");
  const nested = log.find(event => event.type === "shove" && event.unit === "Assault");
  assert.ok(attack && attack.type === "act"); assert.equal(attack.damage, 2); // 5 ATK - 3 DEF
  assert.ok(collision && collision.type === "shove"); assert.equal(collision.damage, 2);
  assert.equal(collision.effects?.reduce((sum, effect) => sum + effect.before - effect.after, 0), 4);
  assert.ok(repair && repair.type === "act"); assert.equal(repair.damage, 0);
  assert.equal(repair.effects?.[0]?.after! - repair.effects?.[0]?.before!, 2); // +4 capped at max HP
  assert.ok(enemy && enemy.type === "enemy"); assert.equal(enemy.damage, 4); // 6 ATK - 2 DEF
  assert.ok(nested && nested.type === "shove"); assert.equal(nested.damage, 2);
  assert.deepEqual(values(evaluate({ final, rounds: source.rounds })), ["achieved", "not-applicable"]);
});

test("controller accepted multi-target sweep sums armour-adjusted victims, not nested damage", () => {
  const match = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw", covers: [], boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 6, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 7, y: 0 } },
  ] });
  match.boss.hp = 5; setScriptCounters(match, 2, 0); assert.equal(bossPrepare(match).skillId, "sweep");
  const controller = createMechaController({ site: controllerSite(), match, deployment: false, animate: false,
    planner: (state, doctrine) => state.turn === 1 ? { revision: state.revision,
      items: MECH_IDS.map(mechId => ({ mechId, moveTo: null, action: { kind: "skip" as const } })) } : planForDoctrine(state, doctrine) });
  controller.startAuto();
  for (let i = 0; i < 100 && !controller.getState().match.outcome; i++) controller.tick();
  const final = controller.getState().match, source = controller.replayArchiveSource();
  assert.equal(final.outcome, "victory"); assert.ok(source);
  const sweep = source.rounds[0]!.log.find(event => event.type === "enemy" && event.skill === "sweep");
  assert.ok(sweep && sweep.type === "enemy");
  assert.equal(sweep.damage, 9); // 6 - Gunner defence 1; 6 - Assault defence 2
  assert.deepEqual(sweep.effects?.map(effect => effect.before - effect.after), [5, 4]);
  const capped = source.rounds[1]!.log.find(event => event.type === "shove" && event.unit === "boss");
  assert.ok(capped && capped.type === "shove"); assert.equal(capped.damage, 1); // collision loss capped at remaining HP
  assert.deepEqual(values(evaluate({ final, rounds: source.rounds })), ["achieved", "not-applicable"]);
});
