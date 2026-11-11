import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  prepareDisplacement, reprojectDisplacement, resolveDisplacement,
  type DisplacementRequest, type DisplacementState,
} from "../apps/agent-city/ui/src/game/mecha/skillDisplacement.ts";

const point = (x: number, y: number) => ({ x, y });
function world() {
  return { width: 10, height: 10, terminal: false, water: [] as Array<{ x: number; y: number }>,
    obstacles: [] as Array<{ x: number; y: number }>, entities: [
      { id: "boss", position: point(2, 2), size: 2 as 1 | 2, alive: true },
      { id: "a", position: point(6, 4), size: 1 as 1 | 2, alive: true },
      { id: "b", position: point(8, 4), size: 1 as 1 | 2, alive: true },
    ] };
}
function request(skillId: "phase_swap" | "gravity_well", targets = ["a"]): DisplacementRequest {
  return { skillId, actorId: "boss", targetIds: targets, radius: 10, steps: 1, attackOffsets: [point(0, 0), point(1, 1)] };
}
function planned(state: DisplacementState, command: DisplacementRequest) {
  const result = prepareDisplacement(state, command);
  assert.equal(result.status, "planned", JSON.stringify(result));
  if (result.status !== "planned") throw new Error("expected planned");
  return result.intent;
}
function freezeDeep(value: any): any {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

test("phase declaration is an atomic 2x2/1x1 swap plus a post-swap attack projection", () => {
  const state = world(), intent = planned(state, request("phase_swap"));
  assert.deepEqual(intent.declared, { status: "reprojected", reason: null, effects: [
    { entityId: "boss", status: "move", reason: null, from: point(2, 2), to: point(6, 4), path: [point(6, 4)] },
    { entityId: "a", status: "move", reason: null, from: point(6, 4), to: point(2, 2), path: [point(2, 2)] },
  ], attackCells: [point(6, 4), point(7, 5)] });
  assert.deepEqual(reprojectDisplacement(state, intent), intent.declared);
  assert.deepEqual(resolveDisplacement(state, intent), { status: "resolved", effects: intent.declared.effects, attackCells: intent.declared.attackCells });
});

test("reprojection tracks the bound target and actor without silently retargeting", () => {
  const state = world(), intent = planned(state, request("phase_swap"));
  state.entities[0]!.position = point(1, 1);
  state.entities[1]!.position = point(5, 5);
  const projection = reprojectDisplacement(state, intent);
  assert.equal(projection.status, "reprojected");
  assert.deepEqual(projection.effects.map((e) => [e.entityId, e.from, e.to]), [
    ["boss", point(1, 1), point(5, 5)], ["a", point(5, 5), point(1, 1)],
  ]);
  assert.deepEqual(projection.attackCells, [point(5, 5), point(6, 6)]);
  assert.deepEqual(intent.declared.attackCells, [point(6, 4), point(7, 5)]);
  state.entities[1]!.alive = false;
  assert.equal(reprojectDisplacement(state, intent).reason, "target_unavailable");
  assert.deepEqual(resolveDisplacement(state, intent), { status: "void", reason: "target_unavailable", effects: [], attackCells: [] });
  state.entities = state.entities.filter((e) => e.id !== "a");
  assert.equal(reprojectDisplacement(state, intent).reason, "target_unavailable");
});

test("phase checks the whole 2x2 landing, the other landing, bounds and final overlap", () => {
  const cases = [
    { name: "water at lower right", change: (s: ReturnType<typeof world>) => s.water.push(point(7, 5)), reason: "water" },
    { name: "obstacle at lower right", change: (s: ReturnType<typeof world>) => s.obstacles.push(point(7, 5)), reason: "obstacle" },
    { name: "third entity in large landing", change: (s: ReturnType<typeof world>) => { s.entities[2]!.position = point(7, 5); }, reason: "occupied" },
    { name: "target cannot land on actor origin", change: (s: ReturnType<typeof world>) => s.water.push(point(2, 2)), reason: "water" },
    { name: "large landing crosses edge", change: (s: ReturnType<typeof world>) => { s.entities[1]!.position = point(9, 4); }, reason: "out_of_bounds" },
    { name: "new footprints overlap", change: (s: ReturnType<typeof world>) => { s.entities[1]!.position = point(1, 2); }, reason: "occupied" },
  ];
  for (const item of cases) {
    const state = world(), intent = planned(state, request("phase_swap"));
    item.change(state);
    const projection = reprojectDisplacement(state, intent);
    assert.equal(projection.status, "void", item.name);
    assert.equal(projection.reason, item.reason, item.name);
    assert.equal(projection.effects.length, 2, item.name);
    assert.ok(projection.effects.every((e) => e.status === "void" && e.reason === item.reason), item.name);
    assert.equal(resolveDisplacement(state, intent).status, "void", item.name);
  }
});

test("phase validates 2x2 targets too and never passes through an invalid destination", () => {
  const state = world();
  state.entities[1]!.size = 2;
  const intent = planned(state, request("phase_swap"));
  state.obstacles.push(point(3, 3));
  assert.equal(reprojectDisplacement(state, intent).reason, "obstacle");
  state.obstacles = []; state.entities[2]!.position = point(3, 3);
  // A live entity already overlapping the actor is an invalid input snapshot.
  assert.equal(reprojectDisplacement(state, intent).reason, "invalid_state");
});

test("gravity preserves declaration order and detects collisions against previous results", () => {
  const state = world();
  state.entities[0]!.position = point(4, 4);
  state.entities[1]!.position = point(7, 4);
  state.entities[2]!.position = point(8, 4);
  const forward = planned(state, request("gravity_well", ["a", "b"]));
  assert.deepEqual(forward.declared.effects.map((e) => [e.entityId, e.status, e.to]), [
    ["a", "move", point(6, 4)], ["b", "move", point(7, 4)],
  ]);
  const reverse = planned(state, request("gravity_well", ["b", "a"]));
  assert.deepEqual(reverse.declared.effects.map((e) => [e.entityId, e.status, e.reason, e.to]), [
    ["b", "void", "occupied", point(7, 4)], ["a", "move", null, point(6, 4)],
  ]);
  assert.deepEqual(resolveDisplacement(state, reverse).effects, reverse.declared.effects);
});

test("gravity paths are stepwise and an interrupted multi-step pull rolls back that unit", () => {
  const state = world();
  state.entities[0]!.position = point(1, 4);
  state.entities[1]!.position = point(6, 4);
  state.entities[2]!.position = point(8, 4);
  const command = { ...request("gravity_well", ["a", "b"]), steps: 2 };
  const intent = planned(state, command);
  assert.deepEqual(intent.declared.effects[0]!.path, [point(5, 4), point(4, 4)]);
  state.obstacles.push(point(4, 4));
  const projection = reprojectDisplacement(state, intent);
  assert.deepEqual(projection.effects[0], { entityId: "a", status: "void", reason: "obstacle", from: point(6, 4), to: point(4, 4), path: [point(5, 4), point(4, 4)] });
  // a never vacated (6,4): b encounters it on its second step, and also rolls back.
  assert.equal(projection.effects[1]!.reason, "occupied");
  assert.deepEqual(projection.effects[1]!.path, [point(7, 4), point(6, 4)]);
});

test("gravity validates 2x2 footprints, terrain, range, death and actor displacement", () => {
  const state = world(); state.entities[0]!.position = point(1, 1); state.entities[1]!.position = point(6, 3); state.entities[1]!.size = 2;
  const command = { ...request("gravity_well", ["a", "b"]), radius: 8 };
  const intent = planned(state, command);
  const firstStep = intent.declared.effects[0]!.to!;
  state.water.push(point(firstStep.x + 1, firstStep.y + 1));
  const wet = reprojectDisplacement(state, intent);
  assert.equal(wet.effects[0]!.status, "void"); assert.equal(wet.effects[0]!.reason, "water");
  state.water = []; state.entities[1]!.alive = false;
  assert.equal(reprojectDisplacement(state, intent).effects[0]!.reason, "target_unavailable");
  state.entities[1]!.alive = true; state.entities[0]!.position = point(0, 8);
  assert.equal(reprojectDisplacement(state, intent).effects[0]!.reason, "out_of_range");
});

test("gravity uses closest-footprint Manhattan range and x-first diagonal tie", () => {
  const state = world(); state.entities[0]!.position = point(2, 2); state.entities[1]!.position = point(6, 6);
  const intent = planned(state, { ...request("gravity_well"), radius: 6 });
  assert.deepEqual(intent.declared.effects[0]!.to, point(5, 6));
  const result = prepareDisplacement(state, { ...request("gravity_well"), radius: 5 });
  assert.equal(result.status, "void");
  if (result.status === "void") assert.equal(result.projection.effects[0]!.reason, "out_of_range");
});

test("terminal, actor, malformed and out-of-board attack inputs fail explicitly", () => {
  const state = world(), command = request("phase_swap"), intent = planned(state, command);
  state.terminal = true; assert.equal(reprojectDisplacement(state, intent).reason, "terminal");
  state.terminal = false; state.entities[0]!.alive = false; assert.equal(reprojectDisplacement(state, intent).reason, "actor_unavailable");
  state.entities[0]!.alive = true; state.entities[0]!.size = 1; assert.equal(reprojectDisplacement(state, intent).reason, "invalid_actor_footprint");
  state.entities[0]!.size = 2;
  for (const invalid of [
    { ...command, targetIds: [] }, { ...command, targetIds: ["a", "a"] },
    { ...command, targetIds: ["boss"] }, { ...command, steps: 0 },
    { ...command, steps: Infinity }, { ...command, radius: NaN },
    { ...command, attackOffsets: [point(0.5, 0)] },
  ]) assert.equal(prepareDisplacement(state, invalid).status, "void");
  const out = prepareDisplacement(state, { ...command, attackOffsets: [point(10, 0)] });
  assert.equal(out.status, "void"); if (out.status === "void") assert.equal(out.reason, "attack_out_of_bounds");
  assert.equal(reprojectDisplacement(state, { ...intent, contentVersion: 2 } as any).reason, "invalid_intent");
  state.entities[1]!.position.x = NaN;
  assert.equal(reprojectDisplacement(state, intent).reason, "invalid_state");
});

test("every phase is deterministic, serializable, and does not mutate or alias inputs", () => {
  for (const skill of ["phase_swap", "gravity_well"] as const) {
    const state = world(), command = request(skill, skill === "phase_swap" ? ["a"] : ["a", "b"]);
    const before = JSON.stringify({ state, command }); freezeDeep(state); freezeDeep(command);
    const prepared = prepareDisplacement(state, command);
    assert.equal(prepared.status, "planned"); if (prepared.status !== "planned") continue;
    const intent = freezeDeep(prepared.intent);
    const declaration = JSON.stringify(intent);
    const replay = JSON.parse(JSON.stringify({ state, intent }));
    const projection = reprojectDisplacement(state, intent);
    const resolution = resolveDisplacement(state, intent);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(prepareDisplacement(state, command), prepared);
      assert.deepEqual(reprojectDisplacement(state, intent), projection);
      assert.deepEqual(resolveDisplacement(state, intent), resolution);
    }
    assert.deepEqual(reprojectDisplacement(replay.state, replay.intent), projection);
    assert.deepEqual(resolveDisplacement(replay.state, replay.intent), resolution);
    assert.equal(JSON.stringify({ state, command }), before);
    assert.equal(JSON.stringify(intent), declaration);
    if (projection.effects[0]?.from) (projection.effects[0].from as { x: number }).x = 123;
    assert.equal(JSON.stringify(intent), declaration);
    assert.equal(JSON.stringify({ state, command }), before);
  }
});

test("resolve can reject stale or altered projections and never exposes their effects", () => {
  const state = world(), intent = planned(state, request("phase_swap"));
  const preview = reprojectDisplacement(state, intent);
  assert.equal(resolveDisplacement(state, intent, JSON.parse(JSON.stringify(preview))).status, "resolved");
  const altered = JSON.parse(JSON.stringify(preview));
  altered.effects[0].to.x += 1;
  assert.deepEqual(resolveDisplacement(state, intent, altered), { status: "void", reason: "stale_projection", effects: [], attackCells: [] });
  state.entities[1]!.position = point(5, 5);
  assert.deepEqual(resolveDisplacement(state, intent, preview), { status: "void", reason: "stale_projection", effects: [], attackCells: [] });
  assert.equal(resolveDisplacement(state, intent).status, "resolved");
});

test("failed calls are pure and gravity preserves missing targets rather than replacing them", () => {
  const state = world(), intent = planned(state, request("gravity_well", ["a", "b"]));
  state.entities[1]!.alive = false;
  const before = JSON.stringify({ state, intent }); freezeDeep(state); freezeDeep(intent);
  const projection = reprojectDisplacement(state, intent);
  assert.deepEqual(projection.effects.map((e) => [e.entityId, e.status, e.reason]), [
    ["a", "void", "target_unavailable"], ["b", "move", null],
  ]);
  assert.equal(resolveDisplacement(state, intent, projection).status, "resolved");
  assert.equal(prepareDisplacement(state, { ...request("phase_swap"), targetIds: ["a"] }).status, "void");
  assert.equal(JSON.stringify({ state, intent }), before);
});
