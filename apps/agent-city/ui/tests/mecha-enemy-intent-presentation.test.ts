import assert from "node:assert/strict";
import test from "node:test";
import { createMatch, bossPrepare } from "../src/game/mecha/rules";
import { declaredEnemyIntents, declaredIntentSegments } from "../src/game/mecha/enemyIntentPresentation";
import type { DeclaredAttack } from "../src/game/mecha/cellInspection";

const attack = (targets: DeclaredAttack["targets"], origin = { x: 4, y: 4 }, footprint = 1): DeclaredAttack => ({
  actor: "raider-w", origin, footprint, targets, skill: "smash", status: "planned",
});

test("overview retains attribution to current living declarations and copies target cells", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 0 }, raiders: [{ id: "raider-w", pos: { x: 7, y: 8 } }] });
  bossPrepare(state);
  const r = state.raiders[0]!;
  r.intent = { skillId: "smash", status: "planned", projected: [{ x: 7, y: 9 }, { x: 7, y: 9 }, { x: -1, y: 9 }], local: [], cdSweep: 0 };
  const intents = declaredEnemyIntents(state);
  const raider = intents.find(i => i.actor === r.id)!;
  assert.deepEqual(raider.origin, r.pos); assert.deepEqual(raider.targets, [{ x: 7, y: 9 }]);
  raider.targets[0]!.x = 0;
  assert.equal(r.intent.projected[0]!.x, 7);
  assert.ok(intents.every(i => i.targets.length > 0));
});

test("missing, skip, void and dead enemies do not invent visible attacks", () => {
  const state = createMatch({ preset: "covers_sparse_mid", boss: { x: 4, y: 0 }, raiders: [{ id: "raider-w", pos: { x: 7, y: 8 } }] });
  state.boss.intent = null; state.raiders[0]!.intent = null;
  assert.deepEqual(declaredEnemyIntents(state), []);
  for (const [skillId, status, hp] of [["skip", "planned", 8], ["smash", "void", 8], ["smash", "planned", 0]] as const) {
    state.raiders[0]!.intent = { skillId, status, projected: [{ x: 7, y: 9 }], local: [], cdSweep: 0 }; state.raiders[0]!.hp = hp;
    assert.deepEqual(declaredEnemyIntents(state), []);
  }
});

test("a straight attack has one farthest ray, irrespective of target array order", () => {
  const targets = [{ x: 4, y: 5 }, { x: 4, y: 8 }, { x: 4, y: 6 }];
  assert.deepEqual(declaredIntentSegments(attack(targets)), [{ from: { x: 4, y: 4 }, to: { x: 4, y: 8 }, kind: "attack" }]);
  assert.deepEqual(declaredIntentSegments(attack([...targets].reverse())), declaredIntentSegments(attack(targets)));
});

test("area attacks show at most three genuine target directions, not a traversal or invented centroid", () => {
  const targets = Array.from({ length: 25 }, (_, i) => ({ x: 2 + i % 5, y: 5 + Math.floor(i / 5) }));
  const declaration = attack(targets, { x: 4, y: 2 }, 2), rays = declaredIntentSegments(declaration);
  assert.equal(rays.length, 3);
  for (const ray of rays) {
    assert.deepEqual(ray.from, { x: 4.5, y: 2.5 });
    assert.ok(targets.some(t => t.x === ray.to.x && t.y === ray.to.y)); assert.equal(ray.kind, "attack");
  }
  assert.deepEqual(declaredIntentSegments({ ...declaration, targets: [...targets].reverse() }), rays);
  assert.equal(declaration.targets.length, 25, "all area cells remain dangerous despite compact direction markers");
});

test("fans straddling +/- pi keep their narrow bounds and degenerate targets draw no arrow", () => {
  const rays = declaredIntentSegments(attack([{ x: 0, y: 3 }, { x: 0, y: 4 }, { x: 0, y: 5 }]));
  assert.equal(rays.length, 3);
  assert.deepEqual(rays[1]!.to, { x: 0, y: 4 });
  assert.deepEqual(declaredIntentSegments(attack([])), []);
  assert.deepEqual(declaredIntentSegments(attack([{ x: 4, y: 4 }])), []);
});

test("reprojected is a valid current declaration, not evidence of an uncommitted draft", () => {
  const state = createMatch({ preset: "covers_sparse_mid", boss: { x: 4, y: 0 }, raiders: [] });
  state.boss.intent = { skillId: "sweep", status: "reprojected", local: [], projected: [{ x: 4, y: 2 }], cdSweep: 0 };
  const intents = declaredEnemyIntents(state);
  assert.equal(intents.length, 1); assert.equal(intents[0]!.status, "reprojected");
  assert.equal(intents[0]!.footprint, 2); assert.equal(intents[0]!.skill, "sweep");
});


test("compact directions also refuse invalid declarations when called directly", () => {
  const active = attack([{ x: 4, y: 5 }]);
  for (const invalid of [{ ...active, skill: "skip" as const }, { ...active, skill: null }, { ...active, status: "void" as const }, { ...active, status: "missing" as const }]) {
    assert.deepEqual(declaredIntentSegments(invalid), []);
  }
});
