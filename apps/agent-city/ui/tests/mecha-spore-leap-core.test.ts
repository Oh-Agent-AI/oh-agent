import assert from "node:assert/strict";
import test from "node:test";
import { sporeLeapCells, sporeLeapReachable } from "../src/game/mecha/board.ts";
import { reproject, tryTranslateBoss, validateAndApplyPlan } from "../src/game/mecha/combat.ts";
import { bossExecute, scriptedEnemyPrepare } from "../src/game/mecha/enemy.ts";
import { applyEnemyPlan, prepareEnemy, scriptedEnemyPlanner } from "../src/game/mecha/enemy/planner.ts";
import { bossPrepare, createMatch, playTurn, previewPlan, type ArenaPlan, type Cell, type MatchState } from "../src/game/mecha/rules.ts";

const content = { speciesId: "spore_leaper", contentVersion: 1 } as const;
const options = {
  preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 },
  mechs: [{ id: "Assault", pos: { x: 3, y: 5 } }, { id: "Gunner", pos: { x: 0, y: 9 } },
    { id: "Support", pos: { x: 9, y: 9 } }],
} as const;
const baseOptions = () => ({ ...options, covers: [], mechs: options.mechs.map((m) => ({ ...m, pos: { ...m.pos } })) });
function fixture(): MatchState {
  const state = createMatch({ ...baseOptions(), monsterContent: content });
  bossPrepare(state);
  return state;
}
function hold(state: MatchState): ArenaPlan {
  return { revision: state.revision, items: state.mechs.filter((m) => m.hp > 0)
    .map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" as const } })) };
}
function resolve(state: MatchState, plan = hold(state)) {
  const before = structuredClone(state);
  const preview = previewPlan(state, plan);
  const actual = playTurn(state, plan);
  assert.ok(preview.ok);
  assert.ok(actual.ok);
  assert.deepEqual(state, before);
  assert.deepEqual(preview.log, actual.log);
  assert.deepEqual(preview.stages, actual.presentationStages);
  assert.equal(preview.outcome, actual.state.outcome);
  return { preview, actual };
}
function installIntent(state: MatchState, offset: Cell) {
  const start = state.boss.anchor;
  const target = { x: start.x + offset.x, y: start.y + offset.y };
  assert.ok(sporeLeapReachable(state, target));
  const projected = sporeLeapCells(target);
  state.boss.intent = { skillId: "spore_leap", landingOffset: { ...offset },
    local: projected.map((c) => ({ x: c.x - start.x, y: c.y - start.y })), projected, cdSweep: 0, status: "planned" };
}
function charge(state: MatchState): ArenaPlan {
  const plan = hold(state);
  plan.items[0]!.action = { kind: "charge", target: "boss" };
  return plan;
}

test("explicit content rejects unsupported versions and rescue; legacy state remains unchanged", () => {
  const base = createMatch(baseOptions());
  const explicitUndefined = createMatch({ ...baseOptions(), monsterContent: undefined });
  assert.equal("monsterContent" in base, false);
  assert.deepEqual(base, explicitUndefined);
  bossPrepare(base);
  assert.equal(base.boss.intent?.skillId, "smash");
  for (const bad of [{ speciesId: "spore_leaper", contentVersion: 2 }, { speciesId: "other", contentVersion: 1 }, null]) {
    assert.throws(() => createMatch({ ...baseOptions(), monsterContent: bad as never }), /unsupported_monster_content/);
  }
  assert.throws(() => createMatch({ ...baseOptions(), monsterContent: content, mission: "rescue:v1" }), /monster_content_rescue_unsupported/);
});

test("stable selection, orthogonal perimeter, landing then damage, preview and play agree", () => {
  const state = fixture();
  assert.deepEqual(state.monsterContent, content);
  const intent = state.boss.intent!;
  assert.equal(intent.skillId, "spore_leap");
  assert.deepEqual(intent.landingOffset, { x: -1, y: -1 });
  assert.deepEqual(intent.projected, sporeLeapCells({ x: 3, y: 3 }));
  assert.equal(intent.projected.length, 8);
  assert.ok(!intent.projected.some((c) => c.x === 2 && c.y === 2));
  assert.deepEqual(fixture().boss.intent, intent);
  const { preview, actual } = resolve(state);
  assert.deepEqual(preview.telegraphByActor.boss, intent.projected);
  const move = actual.log.find((e) => e.type === "boss_move");
  const enemy = actual.log.find((e) => e.type === "enemy" && e.actor === "boss");
  assert.ok(move && enemy);
  assert.deepEqual({ from: move.from, to: move.to }, { from: { x: 4, y: 4 }, to: { x: 3, y: 3 } });
  assert.ok(actual.log.indexOf(move) < actual.log.indexOf(enemy));
  assert.equal(enemy.damage, 4);
  assert.deepEqual(enemy.effects?.map((e) => e.id), ["Assault"]);
  assert.ok(move.sequence! < enemy.effects![0]!.sequence!);
});

test("whole footprints and continuous intermediate paths must be clear", () => {
  const state = fixture();
  state.mechs[0]!.pos = { x: 0, y: 0 };
  const target = { x: 5, y: 5 };
  assert.ok(sporeLeapReachable(state, target));
  state.obstacles = [{ x: 6, y: 4 }, { x: 4, y: 6 }];
  assert.equal(sporeLeapReachable(state, target), false, "landing clear but both approaches blocked");
  state.obstacles.pop();
  assert.ok(sporeLeapReachable(state, target));
  state.obstacles = [];
  const targetCell = { x: 6, y: 6 };
  for (const block of ["obstacle", "cover", "building", "rubble", "mech", "raider", "water"] as const) {
    const copy = structuredClone(state);
    if (block === "obstacle") copy.obstacles.push(targetCell);
    if (block === "cover") copy.covers.push(targetCell);
    if (block === "building" || block === "rubble") copy.buildings.push({ id: "b", cells: [targetCell], hp: block === "building" ? 5 : 0, maxHp: 5 });
    if (block === "mech") copy.mechs[0]!.pos = targetCell;
    if (block === "raider") copy.raiders.push({ id: "r", pos: targetCell, hp: 4, intent: null });
    if (block === "water") copy.terrain[6]![6] = "water";
    assert.equal(sporeLeapReachable(copy, target), false, block);
  }
  assert.equal(sporeLeapReachable(state, { x: 7, y: 4 }), false);
  assert.equal(sporeLeapReachable(state, { x: 4, y: 4 }), false);
});

test("player occupies announced landing: void without move, attack or retarget", () => {
  const state = fixture();
  const plan = hold(state);
  plan.items[0]!.moveTo = { x: 3, y: 4 };
  const { preview, actual } = resolve(state, plan);
  assert.equal(actual.log.some((e) => e.type === "boss_move"), false);
  assert.equal(preview.enemyOrder.some((e) => e.actor === "boss"), false);
  assert.deepEqual(actual.presentationStages!.afterEnemy.boss.anchor, { x: 4, y: 4 });
});

test("charge reprojects original offset and shares the presentation clock", () => {
  const state = fixture();
  const offset = { ...state.boss.intent!.landingOffset! };
  state.mechs[2]!.pos = { x: 3, y: 4 };
  const { preview, actual } = resolve(state, charge(state));
  const shove = actual.log.find((e) => e.type === "shove" && e.unit === "boss");
  const move = actual.log.find((e) => e.type === "boss_move");
  assert.ok(shove && move);
  assert.deepEqual(move.from, { x: 5, y: 4 });
  assert.deepEqual(move.to, { x: move.from.x + offset.x, y: move.from.y + offset.y });
  assert.ok(shove.sequence! < move.sequence!);
  const attack = actual.log.find((e) => e.type === "act");
  assert.ok(attack?.effects?.[0]?.sequence! < shove.sequence!);
  const enemy = actual.log.find((e) => e.type === "enemy" && e.actor === "boss");
  assert.equal(enemy?.effects?.[0]?.id, "Support");
  assert.ok(move.sequence! < enemy?.effects?.[0]?.sequence!);
  assert.deepEqual(preview.telegraphByActor.boss, sporeLeapCells(move.to));
});

test("invalid landing after shove stays void even if unblocked, never reselected", () => {
  const state = fixture();
  state.obstacles.push({ x: 6, y: 2 });
  installIntent(state, { x: 0, y: -2 });
  const intent = state.boss.intent!;
  const probe = structuredClone(state);
  assert.equal(tryTranslateBoss(probe, { x: 1, y: 0 }), true);
  assert.equal(probe.boss.intent!.status, "void");
  assert.deepEqual(probe.boss.intent!.projected, []);
  assert.deepEqual(probe.boss.intent!.landingOffset, intent.landingOffset);
  probe.obstacles = [];
  reproject(probe);
  assert.equal(probe.boss.intent!.status, "void");
  const { actual } = resolve(state, charge(state));
  assert.equal(actual.log.some((e) => e.type === "boss_move" || (e.type === "enemy" && e.actor === "boss")), false);
  assert.deepEqual(actual.presentationStages!.afterEnemy.boss.anchor, { x: 5, y: 4 });
});

test("stable damage order, one hit per multi-cell building, including raiders", () => {
  const state = fixture();
  state.buildings = [{ id: "wide", cells: [{ x: 3, y: 2 }, { x: 3, y: 3 }], hp: 12, maxHp: 12 }];
  state.mechs[1]!.pos = { x: 4, y: 1 };
  state.mechs[0]!.pos = { x: 6, y: 3 };
  state.raiders = [{ id: "r", pos: { x: 6, y: 2 }, hp: 8, intent: null }];
  installIntent(state, { x: 0, y: -2 });
  const { actual } = resolve(state);
  const move = actual.log.find((e) => e.type === "boss_move");
  const enemy = actual.log.find((e) => e.type === "enemy" && e.actor === "boss");
  assert.ok(move && enemy);
  assert.deepEqual(enemy.effects?.map((e) => [e.kind, e.id, e.before - e.after]), [
    ["building", "wide", 6], ["mech", "Gunner", 5], ["raider", "r", 5], ["mech", "Assault", 4],
  ]);
  assert.ok(enemy.effects!.every((e, i) => e.sequence! > move.sequence! && (i === 0 || e.sequence! > enemy.effects![i - 1]!.sequence!)));
});

test("terminal damage stops remaining leap effects and raider execution", () => {
  const state = fixture();
  state.buildings = [{ id: "last", cells: [{ x: 3, y: 2 }], hp: 5, maxHp: 5 }];
  state.mechs[1]!.pos = { x: 4, y: 1 };
  state.raiders = [{ id: "r", pos: { x: 6, y: 2 }, hp: 8,
    intent: { skillId: "smash", local: [], projected: [{ x: 9, y: 9 }], cdSweep: 0, status: "planned" } }];
  installIntent(state, { x: 0, y: -2 });
  const { actual } = resolve(state);
  assert.equal(actual.state.outcome, "defeat_buildings");
  assert.equal(actual.state.phase, "finished");
  const enemy = actual.log.find((e) => e.type === "enemy" && e.actor === "boss");
  assert.ok(enemy);
  assert.deepEqual(enemy.effects?.map((e) => e.id), ["last"]);
  assert.equal(actual.log.some((e) => e.type === "enemy" && e.actor === "r"), false);
});

test("a boss killed by the player does not leap", () => {
  const state = fixture();
  state.boss.hp = 1;
  const { actual } = resolve(state, charge(state));
  assert.equal(actual.state.outcome, "victory");
  assert.equal(actual.state.phase, "finished");
  assert.equal(actual.log.some((e) => e.type === "boss_move" || (e.type === "enemy" && e.actor === "boss")), false);
  assert.equal(actual.state.boss.intent?.status, "void");
});


test("unsupported authoritative content and rescue combinations fail closed", () => {
  const state = fixture();
  state.monsterContent = { speciesId: "spore_leaper", contentVersion: 2 } as never;
  assert.throws(() => playTurn(state, hold(state)), /unsupported_monster_content/);
  assert.throws(() => previewPlan(state, hold(state)), /unsupported_monster_content/);
  state.monsterContent = content;
  state.mission = { kind: "rescue:v1", target: { x: 0, y: 0 } };
  assert.throws(() => playTurn(state, hold(state)), /monster_content_rescue_unsupported/);
  state.phase = "enemy_prepare";
  assert.throws(() => bossPrepare(state), /monster_content_rescue_unsupported/);
});

test("no legal candidate yields a void intent and never attacks", () => {
  const state = createMatch({ ...baseOptions(), monsterContent: content,
    obstacles: [{ x: 3, y: 4 }, { x: 6, y: 4 }, { x: 4, y: 3 }, { x: 4, y: 6 }] });
  bossPrepare(state);
  assert.equal(state.boss.intent?.skillId, "spore_leap");
  assert.equal(state.boss.intent?.status, "void");
  assert.equal(state.boss.intent?.landingOffset, undefined);
  const { actual } = resolve(state);
  assert.equal(actual.log.some((e) => e.type === "boss_move" || (e.type === "enemy" && e.actor === "boss")), false);
});

test("dead boss clears leap and living raider still executes", () => {
  const state = fixture();
  state.raiders.push({ id: "r", pos: { x: 8, y: 8 }, hp: 8,
    intent: { skillId: "smash", local: [], projected: [{ x: 9, y: 9 }], cdSweep: 0, status: "planned" } });
  state.boss.hp = 1;
  const { actual } = resolve(state, charge(state));
  assert.equal(actual.state.outcome, null);
  assert.equal(actual.log.some((e) => e.type === "boss_move" || (e.type === "enemy" && e.actor === "boss")), false);
  assert.ok(actual.log.some((e) => e.type === "enemy" && e.actor === "r"));
  assert.equal(actual.state.boss.intent?.skillId, "skip");
  assert.equal(actual.state.boss.intent?.status, "void");
});


test("invalid raw content is rejected before any clone or normalization", () => {
  const hidden = Object.defineProperty({ ...content }, "extra", { value: true });
  const symbolic = { ...content, [Symbol("extra")]: true };
  let getterCalls = 0;
  const accessor = { speciesId: "spore_leaper", get contentVersion() { getterCalls += 1; return 1; } };
  const inherited = Object.assign(Object.create({ extra: true }), content);
  const cases = [
    { ...content, contentVersion: 2 }, { ...content, contentVersion: "1" },
    { ...content, extra: true }, hidden, symbolic, accessor, inherited, [], null,
  ];
  for (const bad of cases) {
    assert.throws(() => createMatch({ ...baseOptions(), monsterContent: bad as never }), /unsupported_monster_content/);
    const state = fixture();
    state.monsterContent = bad as never;
    const intentBefore = structuredClone(state.boss.intent);
    const anchorBefore = { ...state.boss.anchor };
    assert.throws(() => playTurn(state, hold(state)), /unsupported_monster_content/);
    assert.throws(() => previewPlan(state, hold(state)), /unsupported_monster_content/);
    assert.throws(() => scriptedEnemyPlanner.plan(state), /unsupported_monster_content/);
    assert.throws(() => validateAndApplyPlan(state, hold(state)), /unsupported_monster_content/);
    assert.strictEqual(state.monsterContent, bad);
    assert.deepEqual(state.boss.intent, intentBefore);
    assert.deepEqual(state.boss.anchor, anchorBefore);
  }
  assert.equal(getterCalls, 0, "content properties must not be read through accessors");
  assert.equal(Object.getOwnPropertyDescriptor(hidden, "extra")?.enumerable, false);

  const opts = baseOptions();
  Object.defineProperty(opts, "monsterContent", { enumerable: true, get() { getterCalls += 1; return content; } });
  assert.throws(() => createMatch(opts), /unsupported_monster_content/);
  const state = fixture();
  Object.defineProperty(state, "monsterContent", { enumerable: true, get() { getterCalls += 1; return content; } });
  assert.throws(() => playTurn(state, hold(state)), /unsupported_monster_content/);
  assert.equal(getterCalls, 0, "the enclosing content property must not be read through an accessor");

  const hiddenOuter = fixture();
  Object.defineProperty(hiddenOuter, "monsterContent", { value: content, enumerable: false });
  assert.throws(() => playTurn(hiddenOuter, hold(hiddenOuter)), /unsupported_monster_content/);
  assert.throws(() => scriptedEnemyPlanner.plan(hiddenOuter), /unsupported_monster_content/);
});

test("legacy state cannot execute or prepare an injected leap, including dead and terminal bosses", () => {
  for (const variant of ["planned", "void", "dead", "finished"] as const) {
    const state = fixture();
    delete state.monsterContent;
    if (variant === "void") state.boss.intent!.status = "void";
    if (variant === "dead") state.boss.hp = 0;
    if (variant === "finished") { state.phase = "finished"; state.outcome = "victory"; }
    const before = structuredClone(state);
    const operations = [
      () => playTurn(state, hold(state)), () => previewPlan(state, hold(state)),
      () => validateAndApplyPlan(state, hold(state)), () => bossExecute(state),
      () => reproject(state), () => tryTranslateBoss(state, { x: 1, y: 0 }),
      () => bossPrepare(state), () => scriptedEnemyPrepare(state), () => scriptedEnemyPlanner.plan(state),
    ];
    for (const operation of operations) {
      assert.throws(operation, /unsupported_monster_content/, variant);
      assert.deepEqual(state, before, variant);
    }
  }
});

test("enemy plan cannot inject a leap into a legacy match before state mutation", () => {
  const state = createMatch(baseOptions());
  const plan = scriptedEnemyPlanner.plan(state);
  plan.boss.anchor = { x: 0, y: 0 };
  plan.boss.intent = structuredClone(fixture().boss.intent);
  const before = structuredClone(state);
  assert.throws(() => applyEnemyPlan(state, plan), /unsupported_monster_content/);
  assert.deepEqual(state, before);
  assert.throws(() => prepareEnemy(state, { policy: "injected", plan: () => plan }), /unsupported_monster_content/);
  assert.deepEqual(state, before);
});

test("spore projection leaves authority and declaration unchanged", async () => {
  const { projectSporeUnitPure } = await import("../src/game/mecha/sporeUnitProjection.ts");
  const state = fixture();
  const intent = state.boss.intent!;
  const before = structuredClone(state);
  const projected = projectSporeUnitPure(state, intent);
  assert.deepEqual(state, before);
  const expected = structuredClone(state);
  reproject(expected);
  assert.deepEqual(projected, expected.boss.intent);
});
