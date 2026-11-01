import assert from "node:assert/strict";
import test from "node:test";
import {
  bossExecute, bossPrepare, createMatch, MAX_TURNS, playTurn, previewPlan,
  type ArenaPlan, type Cell, type MatchState,
} from "../src/game/mecha/rules.ts";

function smash(from: Cell, target: Cell) {
  return {
    skillId: "smash" as const,
    local: [{ x: target.x - from.x, y: target.y - from.y }],
    projected: [{ ...target }], cdSweep: 0, status: "planned" as const,
  };
}

// Start from a prepared match, then install deterministic adjacent telegraphs.
// The first raider attacks the only staked building; the second attacks Assault.
function fixture(buildingHp = 3, bossAlive = false): MatchState {
  const state = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: [],
    boss: { x: 7, y: 0 },
    buildings: [{ id: "last", cells: [{ x: 3, y: 3 }], hp: buildingHp }],
    raiders: [{ id: "first", pos: { x: 2, y: 3 } }, { id: "second", pos: { x: 6, y: 5 } }],
    mechs: [
      { id: "Assault", pos: { x: 6, y: 6 } },
      { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ],
  });
  if (!bossAlive) state.boss.hp = 0;
  bossPrepare(state);
  state.boss.intent = { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" };
  state.raiders[0]!.pos = { x: 2, y: 3 };
  state.raiders[0]!.intent = smash(state.raiders[0]!.pos, { x: 3, y: 3 });
  state.raiders[1]!.pos = { x: 6, y: 5 };
  state.raiders[1]!.intent = smash(state.raiders[1]!.pos, { x: 6, y: 6 });
  return state;
}

function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter((m) => m.hp > 0)
    .map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
}

function resolve(state: MatchState) {
  const before = structuredClone(state);
  const plan = hold(state);
  const preview = previewPlan(state, plan);
  const actual = playTurn(state, plan);
  assert.ok(preview.ok);
  assert.ok(actual.ok);
  assert.deepEqual(state, before, "preview and playTurn must not mutate their input");
  assert.deepEqual(preview.log, actual.log);
  assert.equal(preview.outcome, actual.state.outcome);
  assert.deepEqual(preview.enemyOrder, actual.log.filter((event) => event.type === "enemy"));
  assert.deepEqual(preview.stages, actual.presentationStages);
  return { preview, actual };
}

for (const bossAlive of [false, true]) {
  test(`last building ends enemy execution after first raider (boss ${bossAlive ? "alive" : "dead"})`, () => {
    const state = fixture(3, bossAlive);
    const { preview, actual } = resolve(state);
    assert.equal(actual.state.outcome, "defeat_buildings");
    assert.equal(actual.state.phase, "finished");
    assert.equal(actual.state.turn, state.turn);
    assert.equal(actual.state.buildings[0]!.hp, 0);
    assert.equal(actual.state.mechs[0]!.hp, state.mechs[0]!.hp);
    assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first"]);
    assert.deepEqual(preview.telegraphByActor, { first: [{ x: 3, y: 3 }] });
    assert.deepEqual(preview.telegraphAfter, [{ x: 3, y: 3 }]);
    assert.equal(preview.buildings[0]!.endHp, 0);
    assert.deepEqual(actual.log.filter((event) => event.type === "outcome"), [{ type: "outcome", outcome: "defeat_buildings" }]);
    assert.equal(actual.presentationStages!.afterEnemy.outcome, "defeat_buildings");
    assert.deepEqual(actual.presentationStages!.afterPrepare, actual.presentationStages!.afterEnemy);
  });
}

test("without an outcome both raiders act and the next turn prepares", () => {
  const state = fixture(4);
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, null);
  assert.equal(actual.state.phase, "player_plan");
  assert.equal(actual.state.turn, state.turn + 1);
  assert.equal(actual.state.buildings[0]!.hp, 1);
  assert.equal(actual.state.mechs[0]!.hp, state.mechs[0]!.hp - 1);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first", "second"]);
  assert.deepEqual(preview.telegraphAfter, [{ x: 3, y: 3 }, { x: 6, y: 6 }]);
  assert.deepEqual(preview.hitsAfter, { Assault: 1, Gunner: 0, Support: 0 });
});

test("a raider wipe prevents later building damage after the boss dies", () => {
  const state = fixture(3);
  state.mechs[0]!.hp = 1;
  state.mechs[1]!.hp = 0;
  state.mechs[2]!.hp = 0;
  state.raiders[0]!.pos = { x: 5, y: 6 };
  state.raiders[0]!.intent = smash(state.raiders[0]!.pos, state.mechs[0]!.pos);
  state.raiders[1]!.pos = { x: 2, y: 3 };
  state.raiders[1]!.intent = smash(state.raiders[1]!.pos, { x: 3, y: 3 });
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, "defeat_wipe");
  assert.equal(actual.state.phase, "finished");
  assert.equal(actual.state.buildings[0]!.hp, 3);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first"]);
  assert.deepEqual(preview.hitsAfter, { Assault: 1, Gunner: 0, Support: 0 });
});

test("a terminal second raider still executes after the first", () => {
  const state = fixture(4);
  state.raiders[1]!.pos = { x: 4, y: 3 };
  state.raiders[1]!.intent = smash(state.raiders[1]!.pos, { x: 3, y: 3 });
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, "defeat_buildings");
  assert.equal(actual.state.buildings[0]!.hp, 0);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first", "second"]);
  assert.deepEqual(preview.enemyOrder.map((event) => event.damage), [3, 1]);
  assert.equal(actual.state.turn, state.turn);
});

test("a boss-caused terminal outcome prevents both raiders", () => {
  const state = fixture(3, true);
  state.boss.anchor = { x: 3, y: 1 };
  state.boss.intent = smash(state.boss.anchor, { x: 3, y: 3 });
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, "defeat_buildings");
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["boss"]);
  assert.equal(actual.state.mechs[0]!.hp, state.mechs[0]!.hp);
});

test("timeout is evaluated only after both nonterminal raiders act", () => {
  const state = fixture(4);
  state.turn = MAX_TURNS;
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, "defeat_timeout");
  assert.equal(actual.state.phase, "finished");
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first", "second"]);
  assert.equal(actual.state.mechs[0]!.hp, state.mechs[0]!.hp - 1);
});

test("an already recorded outcome prevents enemy execution", () => {
  const state = fixture();
  state.phase = "resolving_boss";
  state.outcome = "defeat_buildings";
  const before = structuredClone(state);
  bossExecute(state);
  assert.deepEqual(state, { ...before, phase: "finished" });
});

test("killing the boss during the player turn still stops after the first lethal raider", () => {
  const state = fixture(3, true);
  state.boss.hp = 1;
  state.mechs[0]!.pos = { x: 6, y: 0 };
  state.mechs[1]!.pos = { x: 6, y: 6 };
  const plan = hold(state);
  plan.items[0]!.action = { kind: "melee", target: "boss" };
  const before = structuredClone(state);
  const preview = previewPlan(state, plan);
  const actual = playTurn(state, plan);
  assert.ok(preview.ok && actual.ok);
  assert.deepEqual(state, before);
  assert.deepEqual(preview.log, actual.log);
  assert.equal(actual.state.boss.hp, 0);
  assert.equal(actual.state.outcome, "defeat_buildings");
  assert.equal(preview.outcome, actual.state.outcome);
  assert.equal(actual.state.mechs[1]!.hp, state.mechs[1]!.hp);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first"]);
  assert.deepEqual(preview.stages, actual.presentationStages);
});

test("destroying a non-staked building does not stop the next raider", () => {
  const state = fixture(3);
  state.stake = "frontage";
  state.buildings.push({ id: "defended", cells: [{ x: 8, y: 3 }], hp: 8, maxHp: 8 });
  state.terrain[2]![8] = "road";
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, null);
  assert.equal(actual.state.buildings[0]!.hp, 0);
  assert.equal(actual.state.buildings[1]!.hp, 8);
  assert.deepEqual(preview.buildings.map((building) => building.staked), [false, true]);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first", "second"]);
  assert.equal(actual.state.mechs[0]!.hp, state.mechs[0]!.hp - 1);
});

test("a dead first raider is skipped and the next living raider still acts", () => {
  const state = fixture(3);
  state.raiders[0]!.hp = 0;
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, null);
  assert.equal(actual.state.buildings[0]!.hp, 3);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["second"]);
  assert.equal(actual.state.mechs[0]!.hp, state.mechs[0]!.hp - 1);
});

test("building defeat takes precedence over timeout on the last turn", () => {
  const state = fixture(3);
  state.turn = MAX_TURNS;
  const { preview, actual } = resolve(state);
  assert.equal(actual.state.outcome, "defeat_buildings");
  assert.equal(actual.state.turn, MAX_TURNS);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first"]);
  assert.equal(actual.state.mechs[0]!.hp, state.mechs[0]!.hp);
});

test("partial preview assumes holds and agrees with the committed full plan", () => {
  const state = fixture(3);
  const full = hold(state);
  const preview = previewPlan(state, { revision: state.revision, items: [full.items[0]!] });
  const actual = playTurn(state, full);
  assert.ok(preview.ok && actual.ok);
  assert.deepEqual(preview.assumed, ["Gunner", "Support"]);
  assert.equal(preview.outcome, "defeat_buildings");
  assert.equal(preview.outcome, actual.state.outcome);
  assert.deepEqual(preview.log, actual.log);
  assert.deepEqual(preview.stages, actual.presentationStages);
  assert.deepEqual(preview.enemyOrder.map((event) => event.actor), ["first"]);
});
