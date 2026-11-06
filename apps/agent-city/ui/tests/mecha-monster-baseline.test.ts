import test from "node:test";
import assert from "node:assert/strict";
import {
  bossPrepare, collectTelegraphs, createMatch, playTurn, previewPlan,
  type BossScriptId, type MatchState,
} from "../src/game/mecha/rules.ts";
import { scriptedEnemyPlanner, applyEnemyPlan } from "../src/game/mecha/enemy/planner.ts";
import { applyDeployPlan, type DeployPlan } from "../src/game/mecha/deployment.ts";
import { declaredEnemyIntents, declaredIntentSegments } from "../src/game/mecha/enemyIntentPresentation.ts";
import { buildPresentationChanges } from "../src/game/mecha/presentationChanges.ts";
import { reproject } from "../src/game/mecha/combat.ts";

// MON-000 freezes current legacy Boss behavior, not a new monster API.
const adjacentMechs = [
  { id: "Assault" as const, pos: { x: 4, y: 3 } },
  { id: "Gunner" as const, pos: { x: 5, y: 3 } },
  { id: "Support" as const, pos: { x: 9, y: 9 } },
];
const distantMechs = [
  { id: "Assault" as const, pos: { x: 1, y: 8 } },
  { id: "Gunner" as const, pos: { x: 4, y: 8 } },
  { id: "Support" as const, pos: { x: 7, y: 8 } },
];
function fixture(script: BossScriptId = "cadence_ssw"): MatchState {
  return createMatch({ preset: "covers_sparse_mid", script, covers: [], buildings: [], raiders: [],
    boss: { x: 4, y: 4 }, mechs: adjacentMechs });
}
function waitPlan(state: MatchState) {
  return { revision: state.revision, items: state.mechs.map(({ id }) => ({
    mechId: id, moveTo: null, action: { kind: "skip" as const },
  })) };
}
function preparedTurn(state: MatchState, plan = waitPlan(state)) {
  const before = structuredClone(state);
  const packet = structuredClone(plan);
  const preview = previewPlan(state, plan);
  const actual = playTurn(state, plan);
  assert.ok(preview.ok);
  assert.ok(actual.ok);
  assert.deepEqual(state, before, "preview and execution must not mutate their source");
  assert.deepEqual(plan, packet);
  assert.deepEqual(preview.log, actual.log);
  assert.deepEqual(preview.stages, actual.presentationStages);
  return { preview, actual };
}
const smash = (cdSweep = 0) => ({ skillId: "smash", local: [{ x: 0, y: -1 }],
  projected: [{ x: 4, y: 3 }], cdSweep, status: "planned" });
const sweep = { skillId: "sweep", local: [{ x: 0, y: -1 }, { x: 1, y: -1 }],
  projected: [{ x: 4, y: 3 }, { x: 5, y: 3 }], cdSweep: 0, status: "planned" };

for (const script of ["stationary_smash", "cadence_ssw", "raid_ssw", "siege"] as const) {
  test(`legacy prepare: ${script} cadence, cooldown and deterministic target`, () => {
    for (const cadence of [0, 1, 2]) for (const cooldown of [0, 1]) {
      const state = fixture(script);
      state.boss.cadence = cadence;
      state.boss.cdSweep = cooldown;
      const before = structuredClone(state);
      const first = scriptedEnemyPlanner.plan(state);
      const second = scriptedEnemyPlanner.plan(structuredClone(state));
      assert.deepEqual(state, before);
      assert.deepEqual(first, second);
      assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
      assert.equal(first.policy, "scripted:v1");
      assert.deepEqual(first.boss, {
        anchor: { x: 4, y: 4 },
        cadence: script === "stationary_smash" ? cadence : (cadence + 1) % 3,
        cdSweep: cooldown,
        intent: script !== "stationary_smash" && cadence === 2 && cooldown === 0 ? sweep : smash(cooldown),
      });
      assert.deepEqual(first.next, { phase: "player_plan", revision: 1, outcome: null });
      const applied = structuredClone(state);
      assert.equal(applyEnemyPlan(applied, first), true);
      const viaPrepare = structuredClone(state);
      assert.deepEqual(bossPrepare(viaPrepare), first.boss.intent);
      assert.deepEqual(applied, viaPrepare);
      assert.equal(applyEnemyPlan(applied, first), false, "a plan cannot be applied twice");
    }
  });
}

test("legacy prepare: only raid and siege advance the 2x2 Boss toward distant objectives", () => {
  for (const script of ["stationary_smash", "cadence_ssw", "raid_ssw", "siege"] as const) {
    const state = createMatch({ preset: "covers_sparse_mid", script, covers: [], buildings: [], raiders: [],
      boss: { x: 4, y: 1 }, mechs: distantMechs });
    bossPrepare(state);
    const moving = script === "raid_ssw" || script === "siege";
    assert.deepEqual(state.boss.anchor, { x: 4, y: moving ? 4 : 1 });
    assert.deepEqual(state.boss.intent, { skillId: "smash", local: [{ x: 0, y: 2 }],
      projected: [{ x: 4, y: moving ? 6 : 3 }], cdSweep: 0, status: "planned" });
  }
});

test("smash preview and execution preserve damage, push, telegraph and presentation order", () => {
  const state = fixture();
  bossPrepare(state);
  assert.deepEqual(collectTelegraphs(state), { cells: [{ x: 4, y: 3 }], byActor: { boss: [{ x: 4, y: 3 }] } });
  const declared = declaredEnemyIntents(state);
  assert.deepEqual(declared, [{ actor: "boss", origin: { x: 4, y: 4 }, footprint: 2,
    skill: "smash", status: "planned", targets: [{ x: 4, y: 3 }] }]);
  assert.deepEqual(declaredIntentSegments(declared[0]!), [
    { from: { x: 4.5, y: 4.5 }, to: { x: 4, y: 3 }, kind: "attack" },
  ]);
  const { preview, actual } = preparedTurn(state);
  assert.deepEqual(actual.log, [
    { type: "enemy", actor: "boss", skill: "smash", cells: [{ x: 4, y: 3 }], damage: 4,
      effects: [{ kind: "mech", id: "Assault", before: 14, after: 10, order: 0, sequence: 0 }] },
    { type: "shove", unit: "Assault", dir: { x: 0, y: -1 }, damage: 0, sequence: 1 },
  ]);
  assert.deepEqual(preview.hitsAfter, { Assault: 4, Gunner: 0, Support: 0 });
  assert.deepEqual(preview.telegraphByActor, { boss: [{ x: 4, y: 3 }] });
  assert.equal(actual.state.turn, 2);
  assert.equal(actual.state.revision, 4);
  assert.deepEqual(actual.state.mechs[0]!.pos, { x: 4, y: 2 });
  assert.deepEqual(actual.state.boss.intent, { skillId: "smash", local: [{ x: 1, y: -1 }],
    projected: [{ x: 5, y: 3 }], cdSweep: 0, status: "planned" });
  const stages = actual.presentationStages!;
  assert.deepEqual(stages.afterPlayer.mechs[0], { id: "Assault", pos: { x: 4, y: 3 }, hp: 14 });
  assert.deepEqual(stages.afterEnemy.mechs[0], { id: "Assault", pos: { x: 4, y: 2 }, hp: 10 });
  assert.deepEqual(buildPresentationChanges(stages, actual.log), { ok: true, changes: [
    { sequence: 0, eventIndex: 0, kind: "health", effect: { kind: "mech", id: "Assault", before: 14, after: 10, order: 0, sequence: 0 } },
    { sequence: 1, eventIndex: 1, kind: "shove", unit: "Assault", dir: { x: 0, y: -1 } },
  ] });
});

test("partial preview assumes waits and stale plans are rejected without changes", () => {
  const state = fixture();
  bossPrepare(state);
  const before = structuredClone(state);
  const partial = previewPlan(state, { revision: state.revision, items: [] });
  const full = playTurn(state, waitPlan(state));
  assert.ok(partial.ok && full.ok);
  assert.deepEqual(partial.assumed, ["Assault", "Gunner", "Support"]);
  assert.deepEqual(partial.log, full.log);
  assert.deepEqual(partial.stages, full.presentationStages);
  const stale = { revision: state.revision - 1, items: [] };
  const failure = { ok: false, fault: { code: "STALE_REVISION", reason: "revision mismatch", cause: "other" } };
  assert.deepEqual(previewPlan(state, stale), failure);
  assert.deepEqual(playTurn(state, stale), failure);
  assert.deepEqual(state, before);
});

test("sweep hits both declared cells without push and applies cooldown to next prepare", () => {
  const state = fixture();
  state.boss.cadence = 2;
  bossPrepare(state);
  assert.deepEqual(state.boss.intent, sweep);
  const { preview, actual } = preparedTurn(state);
  assert.deepEqual(actual.log, [{ type: "enemy", actor: "boss", skill: "sweep",
    cells: [{ x: 4, y: 3 }, { x: 5, y: 3 }], damage: 9, effects: [
      { kind: "mech", id: "Assault", before: 14, after: 10, order: 0, sequence: 0 },
      { kind: "mech", id: "Gunner", before: 11, after: 6, order: 1, sequence: 1 },
    ] }]);
  assert.deepEqual(preview.hitsAfter, { Assault: 4, Gunner: 5, Support: 0 });
  assert.deepEqual(preview.telegraphAfter, [{ x: 4, y: 3 }, { x: 5, y: 3 }]);
  assert.deepEqual(actual.state.mechs.map(m => m.pos), adjacentMechs.map(m => m.pos));
  assert.equal(actual.state.boss.cdSweep, 1);
  assert.deepEqual(actual.state.boss.intent, smash(1));
  assert.equal(declaredEnemyIntents(state)[0]!.skill, "sweep");
  assert.deepEqual(declaredEnemyIntents(state)[0]!.targets, preview.telegraphAfter);
  assert.equal(buildPresentationChanges(actual.presentationStages!, actual.log).ok, true);
  const next = preparedTurn(actual.state);
  assert.equal(next.actual.state.boss.cdSweep, 0, "non-sweep execution consumes the cooldown");
});

test("sweep damages a multi-cell building only once", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "cadence_ssw", covers: [], raiders: [],
    boss: { x: 4, y: 4 }, mechs: [
      { id: "Assault", pos: { x: 0, y: 9 } }, { id: "Gunner", pos: { x: 1, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ], buildings: [{ id: "tower", cells: [{ x: 4, y: 3 }, { x: 5, y: 3 }], hp: 20 }] });
  state.boss.cadence = 2;
  bossPrepare(state);
  assert.deepEqual(state.boss.intent, sweep);
  const { preview, actual } = preparedTurn(state);
  assert.deepEqual(actual.log, [{ type: "enemy", actor: "boss", skill: "sweep",
    cells: [{ x: 4, y: 3 }, { x: 5, y: 3 }], damage: 6,
    effects: [{ kind: "building", id: "tower", before: 20, after: 14, order: 0, sequence: 0 }] }]);
  assert.equal(actual.state.buildings[0]!.hp, 14);
  assert.deepEqual(preview.buildings, [{ id: "tower", cells: [{ x: 4, y: 3 }, { x: 5, y: 3 }],
    staked: true, startHp: 20, afterPlayerHp: 20, endHp: 14, maxHp: 20 }]);
});

test("blocked Boss prepares skip, renders no attack, and executes no enemy event", () => {
  const state = fixture();
  state.mechs[0]!.pos = { x: 0, y: 9 };
  state.mechs[1]!.pos = { x: 1, y: 9 };
  state.obstacles = [
    { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 }, { x: 6, y: 3 },
    { x: 3, y: 4 }, { x: 6, y: 4 }, { x: 3, y: 5 }, { x: 6, y: 5 },
    { x: 3, y: 6 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 },
  ];
  state.boss.cadence = 2;
  bossPrepare(state);
  assert.deepEqual(state.boss.intent, { skillId: "skip", local: [], projected: [], cdSweep: 0, status: "planned" });
  assert.deepEqual(collectTelegraphs(state), { cells: [], byActor: {} });
  assert.deepEqual(declaredEnemyIntents(state), []);
  const { preview, actual } = preparedTurn(state);
  assert.deepEqual(actual.log, []);
  assert.deepEqual(preview.enemyOrder, []);
  assert.equal(actual.state.turn, 2);
  assert.equal(actual.state.phase, "player_plan");
});

test("pushing the Boss reprojects its attack and keeps presentation stages in resolution order", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [],
    boss: { x: 4, y: 4 }, mechs: [
      { id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 9, y: 9 } },
    ] });
  bossPrepare(state);
  assert.deepEqual(state.boss.intent?.projected, [{ x: 5, y: 3 }]);
  const plan = { revision: state.revision, items: [
    { mechId: "Assault" as const, moveTo: { x: 5, y: 3 }, action: { kind: "melee" as const, target: "boss" as const } },
    { mechId: "Gunner" as const, moveTo: null, action: { kind: "skip" as const } },
    { mechId: "Support" as const, moveTo: null, action: { kind: "skip" as const } },
  ] };
  const before = structuredClone(state);
  const preview = previewPlan(state, plan);
  const actual = playTurn(state, plan);
  assert.ok(preview.ok && actual.ok);
  assert.deepEqual(state, before);
  assert.deepEqual(preview.log, actual.log);
  assert.deepEqual(preview.stages, actual.presentationStages);
  assert.deepEqual(actual.log, [
    { type: "move", mechId: "Assault", from: { x: 5, y: 2 }, to: { x: 5, y: 3 } },
    { type: "act", mechId: "Assault", action: "melee", target: "boss", damage: 2,
      effects: [{ kind: "boss", id: "boss", before: 40, after: 38, order: 0, sequence: 0 }] },
    { type: "shove", unit: "boss", dir: { x: 0, y: 1 }, damage: 0, sequence: 1 },
    { type: "enemy", actor: "boss", skill: "smash", cells: [{ x: 5, y: 4 }], damage: 0 },
  ]);
  assert.deepEqual(preview.telegraphAfter, [{ x: 5, y: 4 }]);
  const stages = actual.presentationStages!;
  assert.deepEqual(stages.before.mechs[0]!.pos, { x: 5, y: 2 });
  assert.deepEqual(stages.afterMovement.mechs[0]!.pos, { x: 5, y: 3 });
  assert.deepEqual(stages.afterMovement.boss, { anchor: { x: 4, y: 4 }, hp: 40 });
  assert.deepEqual(stages.afterPlayer.boss, { anchor: { x: 4, y: 5 }, hp: 38 });
  assert.deepEqual(stages.afterEnemy.boss, stages.afterPlayer.boss);
  assert.equal(buildPresentationChanges(stages, actual.log).ok, true);
  actual.state.boss.anchor.x = 9;
  assert.deepEqual(stages.afterPrepare.boss.anchor, { x: 4, y: 5 }, "snapshots are not aliases");
});

test("reprojection clips off-board cells and marks fully clipped attacks void", () => {
  const state = fixture();
  state.boss.anchor = { x: 0, y: 0 };
  state.boss.intent = { skillId: "sweep", local: [{ x: -1, y: 0 }, { x: 2, y: 0 }],
    projected: [{ x: 9, y: 9 }], cdSweep: 0, status: "planned" };
  reproject(state);
  assert.deepEqual(state.boss.intent.projected, [{ x: 2, y: 0 }]);
  assert.equal(state.boss.intent.status, "reprojected");
  state.boss.intent.local = [{ x: -1, y: 0 }];
  reproject(state);
  assert.deepEqual(state.boss.intent.projected, []);
  assert.equal(state.boss.intent.status, "void");
  assert.deepEqual(declaredEnemyIntents(state), []);
});

test("a killing player action ends the turn before the Boss can execute", () => {
  const state = fixture();
  state.boss.hp = 2;
  bossPrepare(state);
  const plan = { revision: state.revision, items: [
    { mechId: "Assault" as const, moveTo: null, action: { kind: "melee" as const, target: "boss" as const } },
    { mechId: "Gunner" as const, moveTo: null, action: { kind: "skip" as const } },
    { mechId: "Support" as const, moveTo: null, action: { kind: "skip" as const } },
  ] };
  const preview = previewPlan(state, plan), actual = playTurn(state, plan);
  assert.ok(preview.ok && actual.ok);
  assert.deepEqual(preview.log, actual.log);
  assert.deepEqual(preview.stages, actual.presentationStages);
  assert.deepEqual(actual.log, [
    { type: "act", mechId: "Assault", action: "melee", target: "boss", damage: 2,
      effects: [{ kind: "boss", id: "boss", before: 2, after: 0, order: 0, sequence: 0 }] },
    { type: "outcome", outcome: "victory" },
  ]);
  assert.deepEqual(preview.telegraphAfter, []);
  assert.deepEqual(preview.enemyOrder, []);
  assert.equal(actual.state.outcome, "victory");
  assert.equal(actual.state.phase, "finished");
  assert.deepEqual(actual.presentationStages!.afterEnemy, actual.presentationStages!.afterPlayer);
});

test("deployment defers Boss prepare until an atomic valid placement and targets the selected cell", () => {
  const zone = [{ x: 4, y: 3 }, { x: 5, y: 6 }, { x: 0, y: 9 }, { x: 9, y: 9 }];
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], buildings: [], raiders: [],
    boss: { x: 4, y: 4 }, deployment: true, deployZone: zone });
  const before = structuredClone(state);
  bossPrepare(state);
  assert.deepEqual(state, before);
  assert.equal(state.boss.intent, null);
  assert.deepEqual(declaredEnemyIntents(state), []);
  const makePlan = (first: { x: number; y: number }): DeployPlan => ({ revision: 0, placements: [
    { mechId: "Assault", pos: first }, { mechId: "Gunner", pos: { x: 0, y: 9 } },
    { mechId: "Support", pos: { x: 9, y: 9 } },
  ] });
  const invalid = applyDeployPlan(state, { ...makePlan(zone[0]!), revision: -1 });
  assert.deepEqual(invalid, { ok: false, fault: { code: "revision" } });
  assert.deepEqual(state, before);
  for (const [cell, offset] of [[zone[0]!, { x: 0, y: -1 }], [zone[1]!, { x: 1, y: 2 }]] as const) {
    const plan = makePlan(cell);
    const originalPlan = structuredClone(plan);
    const result = applyDeployPlan(state, plan);
    assert.ok(result.ok);
    assert.deepEqual(result.log, []);
    assert.equal(result.state.revision, 1);
    assert.equal(result.state.turn, 1);
    assert.equal(result.state.phase, "player_plan");
    assert.equal(Object.hasOwn(result.state, "deployment"), false);
    assert.deepEqual(result.state.mechs.map(m => m.pos), plan.placements.map(p => p.pos));
    assert.deepEqual(result.state.boss.intent, { skillId: "smash", local: [offset], projected: [cell], cdSweep: 0, status: "planned" });
    assert.deepEqual(state, before);
    assert.deepEqual(plan, originalPlan);
  }
});
