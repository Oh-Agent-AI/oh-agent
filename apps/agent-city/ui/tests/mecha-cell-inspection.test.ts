import assert from "node:assert/strict";
import test from "node:test";
import { createMatch, bossPrepare, type MatchState } from "../src/game/mecha/rules";
import { declaredAttack, inspectCell, inspectionSegments } from "../src/game/mecha/cellInspection";

function fixture(): MatchState {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [{ x: 2, y: 2 }], buildings: [{ id: "b1", cells: [{ x: 6, y: 6 }], hp: 9, maxHp: 16 }], raiders: [{ id: "raider-w", pos: { x: 7, y: 8 } }], boss: { x: 4, y: 0 }, mechs: [{ id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }] });
  bossPrepare(state);
  return state;
}

test("empty tiles expose actual terrain and height without inventing occupants", () => {
  const state = fixture();
  for (const [x, terrain] of [[0, "land"], [1, "water"], [2, "mountain"], [3, "road"]] as const) {
    state.terrain[5]![x] = terrain; state.heights[5]![x] = 7.5;
    const info = inspectCell(state, { x, y: 5 })!;
    assert.equal(info.terrain, terrain); assert.equal(info.height, 7.5);
    assert.equal(info.object, "empty"); assert.equal(info.unit, undefined);
  }
  assert.equal(inspectCell(state, { x: -1, y: 0 }), null);
  assert.equal(inspectCell(state, { x: 10, y: 0 }), null);
  assert.equal(inspectCell(state, { x: 1.5, y: 5 }), null);
  assert.equal(inspectCell(state, { x: NaN, y: 5 }), null);
});

test("cover, scene obstacles, multi-cell buildings and rubble keep their own properties", () => {
  const state = fixture(); state.obstacles.push({ x: 2, y: 3 });
  assert.equal(inspectCell(state, { x: 2, y: 2 })!.object, "cover");
  assert.equal(inspectCell(state, { x: 2, y: 3 })!.object, "obstacle");
  const b = state.buildings[0]!; b.cells.push({ x: 7, y: 6 });
  assert.deepEqual(inspectCell(state, { x: 7, y: 6 })!.building, { id: "b1", hp: b.hp, maxHp: b.maxHp });
  b.hp = 0;
  assert.equal(inspectCell(state, { x: 6, y: 6 })!.object, "rubble");
});

test("all friendly units and every boss footprint cell expose rule stats", () => {
  const state = fixture();
  for (const mech of state.mechs) assert.equal(inspectCell(state, mech.pos)!.unit?.id, mech.id);
  assert.equal(inspectCell(state, state.mechs[0]!.pos)!.unit?.atk, 5);
  for (const x of [4, 5]) for (const y of [0, 1]) {
    const info = inspectCell(state, { x, y })!;
    assert.equal(info.unit?.id, "boss"); assert.equal(info.unit?.maxHp, 40);
    assert.deepEqual(info.attack?.origin, { x: 4, y: 0 });
  }
  assert.equal(inspectCell(state, state.raiders[0]!.pos)!.unit?.maxHp, 8);
});

test("displayed friendly draft endpoints use a real path, not a straight shortcut", () => {
  const state = fixture(); const mech = state.mechs[0]!;
  const destination = { x: 1, y: 1 }; const draft = { Assault: { moveTo: destination } };
  const info = inspectCell(state, destination, draft)!;
  assert.equal(info.unit?.id, "Assault"); assert.deepEqual(info.movePath?.[0], mech.pos);
  assert.deepEqual(info.movePath?.at(-1), destination);
  assert.equal(inspectCell(state, mech.pos, draft)!.object, "empty");
  const segments = inspectionSegments(null, info.movePath);
  assert.equal(segments.length, info.movePath!.length - 1);
  for (const segment of segments) assert.equal(Math.abs(segment.from.x - segment.to.x) + Math.abs(segment.from.y - segment.to.y), 1);
});

test("attack areas produce independent directional rays, never a fictional walk path", () => {
  const state = fixture();
  state.boss.intent = { skillId: "sweep", status: "planned", local: [], cdSweep: 0, projected: [{ x: 4, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 2 }, { x: 11, y: 2 }] };
  const attack = declaredAttack(state, "boss")!; const segments = inspectionSegments(attack, [{ x: 0, y: 0 }, { x: 0, y: 1 }]);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(s => s.from), [{ x: 4.5, y: .5 }, { x: 4.5, y: .5 }]);
  assert.ok(segments.every(s => s.kind === "attack"));
  assert.deepEqual(attack.targets, [{ x: 4, y: 2 }, { x: 5, y: 2 }]);
  segments[0]!.to.x = 9;
  assert.equal(state.boss.intent.projected[0]!.x, 4, "presentation cannot mutate rule targets");
});

test("missing, skip, void, dead and unknown declarations don't fabricate routes", () => {
  const state = fixture();
  state.boss.intent = null;
  assert.equal(declaredAttack(state, "boss")!.status, "missing");
  assert.deepEqual(inspectionSegments(declaredAttack(state, "boss"), null), []);
  for (const [skillId, status] of [["skip", "planned"], ["smash", "void"]] as const) {
    state.boss.intent = { skillId, status, local: [], projected: [{ x: 3, y: 1 }], cdSweep: 0 };
    assert.deepEqual(declaredAttack(state, "boss")!.targets, []);
  }
  state.boss.hp = 0;
  assert.equal(declaredAttack(state, "boss"), null);
  assert.equal(inspectCell(state, { x: 4, y: 0 })!.unit, undefined);
  assert.equal(declaredAttack(state, "not-an-enemy"), null);
});

test("a click on empty ground stays a terrain inspection even if it also queues a move", () => {
  const state = fixture(); const cell = { x: 1, y: 1 };
  const draft = { Assault: { moveTo: cell } };
  assert.equal(inspectCell(state, cell, draft)!.unit?.id, "Assault", "a later model click resolves its draft destination");
  assert.equal(inspectCell(state, cell, draft, null)!.object, "empty", "the original ground click isn't replaced by the moving model");
});
