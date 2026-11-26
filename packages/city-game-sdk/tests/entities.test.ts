import test from "node:test";
import assert from "node:assert/strict";
import { defineGame } from "../src/api/defineGame";
import type { GameContextV1 } from "../src/api/types";
import { createGameTestWorld, type TestManifestOverridesV1 } from "../src/testing/headless";

const expectCode = (code: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

async function launchWithContext(id: string, overrides?: TestManifestOverridesV1): Promise<GameContextV1> {
  const world = createGameTestWorld();
  let context: GameContextV1 | undefined;
  const definition = defineGame({ id, setup(value) { context = value; } });
  await world.launch(definition, {
    seed: 11,
    ...(overrides !== undefined ? { manifestOverrides: overrides } : {}),
  });
  assert.ok(context);
  return context;
}

test("spawn/get/update/query/destroy keep a run-owned entity table", async () => {
  const context = await launchWithContext("test.entities");
  const id = context.entities.spawn("test-cube", { position: [1, 2, 3] }, { hp: 100 });
  assert.equal(id, "e1");
  const created = context.entities.get(id);
  assert.deepEqual(created.transform.position, [1, 2, 3]);
  assert.equal(created.props.hp, 100);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.transform), true);

  const updated = context.entities.update(id, {
    position: [4, 5, 6],
    props: { hp: 40, state: "hurt" },
  });
  assert.deepEqual(updated.transform.position, [4, 5, 6]);
  assert.equal(updated.props.hp, 40);
  assert.equal(updated.props.state, "hurt");

  context.entities.spawn("test-cube", { position: [0, 0, 0] }, { hp: 1 });
  assert.equal(context.entities.query().length, 2);
  assert.equal(context.entities.query({ prefabId: "test-cube" }).length, 2);
  assert.equal(context.entities.query({ prefabId: "other" }).length, 0);
  assert.deepEqual(context.entities.query().map((entity) => entity.id), ["e1", "e2"]);

  assert.equal(context.entities.destroy(id), true);
  assert.equal(context.entities.destroy(id), false);
  assert.equal(context.entities.query().length, 1);
});

test("the entity budget is enforced by the host, not by convention", async () => {
  const context = await launchWithContext("test.budget", { limits: { maxEntities: 2 } });
  context.entities.spawn("test-cube", { position: [0, 0, 0] });
  context.entities.spawn("test-cube", { position: [1, 0, 0] });
  assert.throws(
    () => context.entities.spawn("test-cube", { position: [2, 0, 0] }),
    (error) => {
      assert.equal((error as { code?: string }).code, "game_entity_budget_exceeded");
      return true;
    },
  );
});

test("undeclared prefabs and malformed transforms fail closed", async () => {
  const context = await launchWithContext("test.assets");
  assert.throws(
    () => context.entities.spawn("not-declared", { position: [0, 0, 0] }),
    expectCode("game_asset_invalid"),
  );
  assert.throws(
    () => context.entities.spawn("test-cube", { position: [0, 0, Number.NaN] }),
    expectCode("game_argument_invalid"),
  );
  assert.throws(
    () => context.entities.spawn("test-cube", { position: [0, 0, 0], rotation: [0, 0] as unknown as [number, number, number] }),
    expectCode("game_argument_invalid"),
  );
});

test("unknown entities are diagnosable, and destroy stays idempotent", async () => {
  const context = await launchWithContext("test.unknown");
  assert.throws(() => context.entities.get("e999"), expectCode("game_entity_unknown"));
  assert.throws(
    () => context.entities.update("e999", { position: [0, 0, 0] }),
    expectCode("game_entity_unknown"),
  );
  assert.equal(context.entities.destroy("e999"), false);
});

test("props merge shallowly and reject non-JSON values", async () => {
  const context = await launchWithContext("test.props");
  const id = context.entities.spawn("test-cube", { position: [0, 0, 0] }, { hp: 10, target: null });
  const updated = context.entities.update(id, { props: { hp: 20 } });
  assert.equal(updated.props.hp, 20);
  assert.equal(updated.props.target, null);
  assert.throws(
    () =>
      context.entities.update(id, {
        props: { hp: 30, callback: () => undefined },
      }),
    expectCode("game_argument_invalid"),
  );
});
