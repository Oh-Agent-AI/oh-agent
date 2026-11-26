import test from "node:test";
import assert from "node:assert/strict";
import { defineGame } from "../src/api/defineGame";
import type { GameContextV1 } from "../src/api/types";
import { createGameTestWorld } from "../src/testing/headless";

const expectCode = (code: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

async function launchRestricted(): Promise<GameContextV1> {
  const world = createGameTestWorld();
  let context: GameContextV1 | undefined;
  const definition = defineGame({ id: "test.permissions", setup(value) { context = value; } });
  await world.launch(definition, {
    manifestOverrides: {
      permissions: ["world.read"],
      world: { requiredCapabilities: [] },
    },
  });
  assert.ok(context);
  return context;
}

test("granted permissions work and ungranted ones fail closed", async () => {
  const context = await launchRestricted();
  assert.equal(context.world.city().cityId, "test-city");
  assert.equal(context.world.listAnchors().length, 0);

  assert.throws(() => context.world.listRoutes(), expectCode("game_permission_denied"));
  assert.throws(() => context.world.getRoute("test-road"), expectCode("game_permission_denied"));
  assert.throws(() => context.world.sampleTerrain(0, 0), expectCode("game_permission_denied"));
  assert.throws(
    () => context.entities.spawn("test-cube", { position: [0, 0, 0] }),
    expectCode("game_permission_denied"),
  );
  assert.throws(() => context.ui.setHud({ wave: 1 }), expectCode("game_permission_denied"));
  assert.throws(() => context.input.actions(), expectCode("game_permission_denied"));
  assert.throws(() => context.audio.play("any"), expectCode("game_permission_denied"));
});

test("a missing route is a diagnosable error, not an empty world", async () => {
  const world = createGameTestWorld();
  let context: GameContextV1 | undefined;
  const definition = defineGame({ id: "test.route", setup(value) { context = value; } });
  await world.launch(definition);
  assert.ok(context);
  assert.equal(context.world.listRoutes().length, 1);
  assert.equal(context.world.getRoute("test-road").points.length, 3);
  assert.throws(() => context.world.getRoute("missing-road"), expectCode("game_world_object_missing"));
});

test("queried world objects are cloned and cannot mutate the host snapshot", async () => {
  const world = createGameTestWorld({
    objects: [
      {
        id: "building-1",
        kind: "building",
        position: [0, 0, 0],
        bounds: { min: [-1, 0, -1], max: [1, 4, 1] },
      },
    ],
  });
  let context: GameContextV1 | undefined;
  const definition = defineGame({ id: "test.objects", setup(value) { context = value; } });
  await world.launch(definition);
  assert.ok(context);
  const first = context.world.queryObjects({ min: [-2, 0, -2], max: [2, 10, 2] });
  assert.equal(first.length, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  const empty = context.world.queryObjects({ min: [10, 0, 10], max: [12, 1, 12] });
  assert.equal(empty.length, 0);
});
