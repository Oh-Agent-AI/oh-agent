import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TURNS, ringPierceCells } from "../src/game/mecha/board.ts";
import { reproject, tryTranslateBoss } from "../src/game/mecha/combat.ts";
import { bossExecute } from "../src/game/mecha/enemy.ts";
import { applyEnemyPlan, scriptedEnemyPlanner } from "../src/game/mecha/enemy/planner.ts";
import { bossPrepare, createMatch, playTurn, previewPlan, type ArenaPlan, type MatchState, type MonsterSpeciesId } from "../src/game/mecha/rules.ts";

function fixture(speciesId: MonsterSpeciesId): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 7 } }, { id: "Gunner", pos: { x: 4, y: 8 } }, { id: "Support", pos: { x: 0, y: 9 } }],
    monsterContent: { speciesId, contentVersion: 1 } });
  bossPrepare(state);
  return state;
}
function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter(m => m.hp > 0).map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
}
function resolve(state: MatchState, plan = hold(state)) {
  const saved = structuredClone(state);
  const preview = previewPlan(state, plan);
  const result = playTurn(state, plan);
  assert.ok(preview.ok); assert.ok(result.ok);
  assert.deepEqual(state, saved);
  assert.deepEqual(preview.log, result.log);
  assert.deepEqual(preview.stages, result.presentationStages);
  assert.equal(preview.outcome, result.state.outcome);
  return result;
}

test("only six content/skill pairs are supported; validate before normalization", () => {
  for (const speciesId of ["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "phase_stalker", "gravity_core"] as const) {
    const state = fixture(speciesId);
    assert.deepEqual(state.monsterContent, { speciesId, contentVersion: 1 });
  }
  const opts = { preset: "covers_sparse_mid", script: "stationary_smash" } as const;
  for (const value of ["swarm_mantle", "neural_weaver", "many_core", "field_sovereign", "unknown"]) {
    assert.throws(() => createMatch({ ...opts, monsterContent: { speciesId: value, contentVersion: 1 } as never }), /unsupported_monster_content/);
  }
  for (const bad of [{ speciesId: "flux_lancer", contentVersion: 2 }, { speciesId: "flux_lancer", contentVersion: 1, extra: true },
    { speciesId: "prism_warden", contentVersion: 1, visualSeed: 0 }]) {
    assert.throws(() => createMatch({ ...opts, monsterContent: bad as never }), /unsupported_monster_content/);
  }
  let read = false;
  const accessor = { get speciesId() { read = true; return "flux_lancer"; }, contentVersion: 1 };
  assert.throws(() => createMatch({ ...opts, monsterContent: accessor as never }), /unsupported_monster_content/);
  assert.equal(read, false);
  assert.throws(() => createMatch({ ...opts, mission: "rescue:v1", monsterContent: { speciesId: "flux_lancer", contentVersion: 1 } }), /monster_content_rescue_unsupported/);
});

test("legacy or wrong species cannot inject new skills, and monsters cannot inject old attacks", () => {
  for (const skillId of ["spore_leap", "ring_pierce", "corrode_cell", "prism_guard", "phase_swap", "gravity_well"] as const) {
    const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash" });
    state.boss.intent = { skillId, local: [], projected: [], cdSweep: 0, status: "planned" };
    assert.throws(() => playTurn(state, hold(state)), /unsupported_monster_content/);
    assert.throws(() => bossExecute(state), /unsupported_monster_content/);
  }
  const state = fixture("flux_lancer");
  state.boss.intent!.skillId = "smash";
  assert.throws(() => reproject(state), /unsupported_monster_content/);
  state.boss.intent!.skillId = "prism_guard";
  assert.throws(() => previewPlan(state, hold(state)), /unsupported_monster_content/);
  const unprepared = fixture("spore_leaper");
  unprepared.phase = "enemy_prepare"; unprepared.boss.intent = null;
  const plan = scriptedEnemyPlanner.plan(unprepared);
  plan.boss.intent!.skillId = "ring_pierce";
  assert.throws(() => applyEnemyPlan(unprepared, plan), /unsupported_monster_content/);
});

test("ring pierce selects a deterministic bound ray and hits in order, same preview and execution", () => {
  const state = fixture("flux_lancer");
  const intent = state.boss.intent!;
  assert.equal(intent.skillId, "ring_pierce");
  assert.deepEqual(intent.direction, { x: 0, y: 1 });
  assert.equal(intent.lane, 0);
  assert.deepEqual(intent.projected, [{ x: 4, y: 6 }, { x: 4, y: 7 }, { x: 4, y: 8 }, { x: 4, y: 9 }]);
  assert.deepEqual(fixture("flux_lancer").boss.intent, intent);
  const result = resolve(state);
  const attack = result.log.find(e => e.type === "enemy" && e.skill === "ring_pierce");
  assert.ok(attack && attack.type === "enemy");
  assert.deepEqual(attack.effects?.map(e => e.id), ["Assault", "Gunner"]);
  assert.ok(attack.effects![0]!.sequence! < attack.effects![1]!.sequence!);
  assert.equal(result.state.mechs[0]!.hp, 10);
  assert.equal(result.state.mechs[1]!.hp, 6);
});

test("ring pierce follows the same direction and lane after shove, never reselects", () => {
  const state = fixture("flux_lancer");
  assert.ok(tryTranslateBoss(state, { x: 1, y: 0 }));
  reproject(state);
  assert.deepEqual(state.boss.intent?.direction, { x: 0, y: 1 });
  assert.equal(state.boss.intent?.lane, 0);
  assert.deepEqual(state.boss.intent?.projected, ringPierceCells(state, { x: 5, y: 4 }, { x: 0, y: 1 }, 0));
  const result = resolve(state);
  const attack = result.log.find(e => e.type === "enemy" && e.skill === "ring_pierce");
  assert.ok(attack && attack.type === "enemy");
  assert.equal(attack.damage, 0);
});

test("ring pierce truncates on blockers; no first cell and invalid binding void without reselecting", () => {
  const state = fixture("flux_lancer");
  state.obstacles = [{ x: 4, y: 8 }];
  reproject(state);
  assert.deepEqual(state.boss.intent?.projected, [{ x: 4, y: 6 }, { x: 4, y: 7 }]);
  assert.equal(resolve(state).state.mechs[1]!.hp, 11);
  state.obstacles = [{ x: 4, y: 6 }];
  reproject(state);
  assert.equal(state.boss.intent?.status, "void");
  assert.ok(!resolve(state).log.some(e => e.type === "enemy" && e.actor === "boss"));
  const malformed = fixture("flux_lancer");
  malformed.boss.intent!.direction = { x: 1, y: 1 };
  reproject(malformed);
  assert.equal(malformed.boss.intent?.status, "void");
});

test("ring pierce hits a multi-cell building once and stops immediately on terminal damage", () => {
  const state = fixture("flux_lancer");
  state.mechs[0]!.pos = { x: 0, y: 0 }; state.mechs[1]!.pos = { x: 4, y: 9 };
  state.buildings = [{ id: "last", cells: [{ x: 4, y: 6 }, { x: 4, y: 7 }], hp: 5, maxHp: 5 }];
  const result = resolve(state);
  const attack = result.log.find(e => e.type === "enemy" && e.skill === "ring_pierce");
  assert.ok(attack && attack.type === "enemy");
  assert.deepEqual(attack.effects?.map(e => e.id), ["last"]);
  assert.equal(result.state.outcome, "defeat_buildings");
  assert.equal(result.state.mechs[1]!.hp, 11);
});

test("prism guard announces boss binding and absorbs exactly one damage segment", () => {
  let state = fixture("prism_warden");
  assert.equal(state.boss.intent?.skillId, "prism_guard");
  assert.equal(state.boss.intent?.targetId, "boss");
  assert.equal(state.boss.intent?.shieldHits, 1);
  let result = resolve(state);
  assert.deepEqual(result.state.boss.shield, { kind: "prism_guard", hits: 1 });
  assert.equal(result.presentationStages!.before.boss.shield, undefined);
  assert.deepEqual(result.presentationStages!.afterEnemy.boss.shield, { kind: "prism_guard", hits: 1 });
  const preview = previewPlan(state, hold(state));
  assert.ok(preview.ok);
  assert.equal(preview.enemyOrder.length, 0, "defense is not an attack");
  assert.deepEqual(preview.stages!.afterEnemy.boss.shield, { kind: "prism_guard", hits: 1 });
  const applied = result.log.find(e => e.type === "monster_status" && e.change === "applied");
  assert.ok(applied && applied.type === "monster_status" && applied.sequence !== undefined);
  state = result.state;
  state.mechs[0]!.pos = { x: 3, y: 4 }; state.mechs[1]!.pos = { x: 5, y: 8 };
  const plan = hold(state);
  plan.items[0]!.action = { kind: "melee", target: "boss" };
  plan.items[1]!.action = { kind: "shoot", target: "boss" };
  result = resolve(state, plan);
  const absorbed = result.log.find(e => e.type === "monster_status" && e.change === "absorbed");
  assert.ok(absorbed && absorbed.type === "monster_status");
  assert.deepEqual(result.presentationStages!.before.boss.shield, { kind: "prism_guard", hits: 1 });
  assert.equal(result.presentationStages!.afterPlayer.boss.shield, undefined);
  assert.deepEqual(result.presentationStages!.afterEnemy.boss.shield, { kind: "prism_guard", hits: 1 });
  const actions = result.log.filter(e => e.type === "act" && e.target === "boss");
  assert.equal(actions.length, 2);
  assert.equal(actions[0]!.damage, 0);
  assert.ok(actions[1]!.damage > 0);
  assert.ok(absorbed.sequence! < actions[1]!.effects![0]!.sequence!);
});

test("invalid prism target is void, and terminal state expires an existing shield", () => {
  const state = fixture("prism_warden");
  state.boss.intent!.shieldHits = 2;
  reproject(state);
  assert.equal(state.boss.intent?.status, "void");
  assert.ok(!resolve(state).log.some(e => e.type === "monster_status" && e.change === "applied"));
  const timed = fixture("prism_warden");
  timed.turn = MAX_TURNS;
  const result = resolve(timed);
  assert.equal(result.state.outcome, "defeat_timeout");
  assert.equal(result.state.boss.shield, undefined);
  const statuses = result.log.filter(e => e.type === "monster_status");
  assert.deepEqual(statuses.map(e => e.change), ["applied", "expired"]);
  assert.ok(statuses[0]!.sequence! < statuses[1]!.sequence!);
});

test("a boss killed before its bound skill resolves neither pierces nor gains a shield", () => {
  for (const speciesId of ["flux_lancer", "prism_warden"] as const) {
    const state = fixture(speciesId);
    state.boss.hp = 1;
    state.mechs[0]!.pos = { x: 0, y: 0 };
    const plan = hold(state);
    plan.items[1]!.action = { kind: "shoot", target: "boss" };
    const result = resolve(state, plan);
    assert.equal(result.state.outcome, "victory");
    assert.equal(result.state.boss.hp, 0);
    assert.equal(result.state.boss.shield, undefined);
    assert.ok(!result.log.some(e => (e.type === "monster_status" && e.change === "applied") || (e.type === "enemy" && e.actor === "boss")));
  }
});

test("invalid authoritative content and malformed shield are rejected before turn cloning", () => {
  for (const speciesId of ["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "phase_stalker", "gravity_core"] as const) {
    const state = fixture(speciesId);
    (state as unknown as { monsterContent: unknown }).monsterContent = { speciesId, contentVersion: 2 };
    assert.throws(() => previewPlan(state, hold(state)), /unsupported_monster_content/);
    assert.throws(() => playTurn(state, hold(state)), /unsupported_monster_content/);
  }
  const state = fixture("prism_warden");
  (state.boss as unknown as { shield: unknown }).shield = null;
  assert.throws(() => playTurn(state, hold(state)), /unsupported_monster_content/);
});
