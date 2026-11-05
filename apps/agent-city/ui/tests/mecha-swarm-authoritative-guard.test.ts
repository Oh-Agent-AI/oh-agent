import assert from "node:assert/strict";
import test from "node:test";
import { assertMonsterState, swapEventSink, type ArenaPlan, type MatchState, type Raider, type TurnEvent } from "../src/game/mecha/board.ts";
import { validateAndApplyPlan } from "../src/game/mecha/combat.ts";
import { bossExecute, scriptedEnemyPrepare } from "../src/game/mecha/enemy.ts";
import { applyEnemyPlan, prepareEnemy, scriptedEnemyPlanner } from "../src/game/mecha/enemy/planner.ts";
import { createMatch, playTurn, previewPlan } from "../src/game/mecha/rules.ts";
import { createSwarmBattle, prepareSwarmBattle, reprojectSwarmBattle, resolveSwarmBattle } from "./mecha-swarm-host-fixture.ts";

const cell = (x: number, y: number) => ({ x, y });
function initial(): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: cell(4, 4),
    raiders: [{ id: "r1", pos: cell(9, 0) }], mechs: [
      { id: "Assault", pos: cell(0, 9) }, { id: "Gunner", pos: cell(1, 9) }, { id: "Support", pos: cell(2, 9) },
    ] });
}
function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter(m => m.hp > 0)
    .map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) };
}
const marker = { parentId: "boss", speciesId: "swarm_child", expiresAtRound: 3 } as const;

test("all authoritative turn and planner entries reject summon metadata without mutation or events", () => {
  const unprepared = initial();
  const enemyPlan = scriptedEnemyPlanner.plan(unprepared);
  const prepared = structuredClone(unprepared);
  prepareEnemy(prepared);
  const cases: Array<[string, MatchState, (s: MatchState) => unknown]> = [
    ["playTurn", prepared, s => playTurn(s, hold(s))],
    ["previewPlan", prepared, s => previewPlan(s, hold(s))],
    ["validateAndApplyPlan", prepared, s => validateAndApplyPlan(s, hold(s))],
    ["bossExecute", prepared, s => bossExecute(s)],
    ["scriptedEnemyPrepare", unprepared, s => scriptedEnemyPrepare(s)],
    ["planner.plan", unprepared, s => scriptedEnemyPlanner.plan(s)],
    ["prepareEnemy", unprepared, s => prepareEnemy(s)],
    ["applyEnemyPlan", unprepared, s => applyEnemyPlan(s, enemyPlan)],
  ];
  for (const [name, base, invoke] of cases) {
    const state = structuredClone(base);
    state.raiders[0]!.summon = { ...marker };
    const before = structuredClone(state), planBefore = structuredClone(enemyPlan);
    const events: TurnEvent[] = [], oldSink = swapEventSink(events);
    try {
      assert.throws(() => invoke(state), /unsupported_swarm_state/, name);
      assert.deepEqual(state, before, name);
      assert.deepEqual(enemyPlan, planBefore, name);
      assert.deepEqual(events, [], name);
    } finally { swapEventSink(oldSink); }
  }
});

test("presence-based rejection catches undefined, hidden, inherited and accessor markers without invoking getters", () => {
  for (const kind of ["undefined", "hidden", "inherited", "accessor"] as const) {
    const state = initial(), original = state.raiders[0]!;
    let reads = 0;
    if (kind === "undefined") original.summon = undefined;
    if (kind === "hidden") Object.defineProperty(original, "summon", { value: marker, enumerable: false });
    if (kind === "inherited") Object.setPrototypeOf(original, { summon: marker });
    if (kind === "accessor") Object.defineProperty(original, "summon", { get() { reads++; return marker; }, enumerable: true });
    assert.throws(() => assertMonsterState(state), /unsupported_swarm_state/, kind);
    assert.equal(reads, 0, kind);
  }
});

test("constructor rejects summon markers before legacy raider mapping can erase them", () => {
  let reads = 0;
  const child = { id: "swarm:0", pos: cell(9, 0), get summon() { reads++; return marker; } };
  assert.throws(() => createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", raiders: [child] }), /unsupported_swarm_state/);
  assert.equal(reads, 0);
  const inherited = Object.assign(Object.create({ summon: marker }) as Raider, { id: "r", pos: cell(9, 0) });
  assert.throws(() => createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", raiders: [inherited] }), /unsupported_swarm_state/);
});

test("a spawned fixture child cannot enter real preview or play without its host ledger", () => {
  const base = initial(); base.raiders = [];
  const created = createSwarmBattle(base), prepared = prepareSwarmBattle(created);
  assert.equal(prepared.status, "resolved");
  if (prepared.status !== "resolved") throw new Error("fixture prepare failed");
  const spawn = resolveSwarmBattle(prepared.battle, reprojectSwarmBattle(prepared.battle));
  assert.equal(spawn.status, "resolved");
  if (spawn.status !== "resolved") throw new Error("fixture resolve failed");
  assert.ok(spawn.battle.match.raiders.length > 0);
  const state = spawn.battle.match, before = structuredClone(state);
  assert.throws(() => previewPlan(state, hold(state)), /unsupported_swarm_state/);
  assert.throws(() => playTurn(state, hold(state)), /unsupported_swarm_state/);
  assert.deepEqual(state, before);
});

test("ordinary legacy raiders, including swarm-prefixed IDs, retain preview/play behavior", () => {
  const state = initial(); state.raiders[0]!.id = "swarm:legacy";
  prepareEnemy(state);
  const before = structuredClone(state), plan = hold(state);
  const preview = previewPlan(state, plan), actual = playTurn(state, plan);
  assert.ok(preview.ok); assert.ok(actual.ok);
  assert.deepEqual(preview.log, actual.log);
  assert.deepEqual(preview.stages, actual.presentationStages);
  assert.deepEqual(state, before);
});
