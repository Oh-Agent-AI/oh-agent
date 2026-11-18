import test from "node:test";
import assert from "node:assert/strict";
import { defineGame } from "../src/api/defineGame";
import type { GameContextV1 } from "../src/api/types";
import { CodeGameHostV1 } from "../src/host/codeGameHost";
import { GameSdkError } from "../src/protocol/errors";
import { createGameTestWorld, createTestManifest } from "../src/testing/headless";

const expectCode = (code: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test("fixed updates run once per step and finish() tears the run down", async () => {
  const world = createGameTestWorld();
  const dtValues: number[] = [];
  const definition = defineGame({
    id: "test.lifecycle",
    setup(context) {
      context.onFixedUpdate((dt) => {
        dtValues.push(dt);
        if (dtValues.length === 5) context.finish("success", "base_destroyed");
      });
    },
  });
  const run = await world.launch(definition, { seed: 7 });
  run.step(10);
  const telemetry = run.telemetry();
  assert.equal(telemetry.tick, 5);
  assert.equal(telemetry.outcome, "success");
  assert.equal(telemetry.reason, "base_destroyed");
  assert.equal(telemetry.status, "finished");
  assert.equal(telemetry.disposed, true);
  assert.equal(dtValues.length, 5);
  assert.equal(dtValues[0], 1 / 60);
  run.assertNoLeakedEntities();
});

test("cleanup runs LIFO and the setup-returned disposer runs last", async () => {
  const world = createGameTestWorld();
  const order: string[] = [];
  const definition = defineGame({
    id: "test.cleanup",
    setup(context) {
      context.onDispose(() => order.push("a"));
      context.onDispose(() => order.push("b"));
      return () => order.push("setup");
    },
  });
  const run = await world.launch(definition);
  run.dispose();
  run.dispose();
  assert.deepEqual(order, ["b", "a", "setup"]);
  assert.equal(run.telemetry().disposed, true);
});

test("a throwing cleanup does not prevent the remaining cleanups", async () => {
  const world = createGameTestWorld();
  const order: string[] = [];
  const definition = defineGame({
    id: "test.cleanup.fault",
    setup(context) {
      context.onDispose(() => {
        order.push("throws");
        throw new Error("dispose failed");
      });
      context.onDispose(() => order.push("survives"));
    },
  });
  const run = await world.launch(definition);
  run.dispose();
  assert.deepEqual(order, ["survives", "throws"]);
  assert.equal(run.telemetry().counters.errors, 1);
  assert.equal(run.telemetry().diagnostics, 1);
});

test("a setup exception fails the run with game_runtime_fault", async () => {
  const world = createGameTestWorld();
  const definition = defineGame({
    id: "test.setup.fault",
    setup() {
      throw new Error("boom");
    },
  });
  const host = new CodeGameHostV1({
    manifest: createTestManifest("test.setup.fault"),
    world: world.source,
    seed: 1,
  });
  await assert.rejects(host.prepare(definition), expectCode("game_runtime_fault"));
  assert.equal(host.status, "failed");
  assert.equal(host.telemetry().disposed, true);
});

test("finish() before start() is rejected instead of half-finishing", async () => {
  const world = createGameTestWorld();
  let context: GameContextV1 | undefined;
  const definition = defineGame({
    id: "test.finish.guard",
    setup(value) {
      context = value;
    },
  });
  const run = await world.launch(definition);
  run.host.pause();
  assert.throws(() => run.host.finish("success"), expectCode("game_argument_invalid"));
  assert.equal(context !== undefined, true);
  run.dispose();
});

test("paused runs do not advance their tick", async () => {
  const world = createGameTestWorld();
  let updates = 0;
  const definition = defineGame({
    id: "test.pause",
    setup(context) {
      context.onFixedUpdate(() => {
        updates += 1;
      });
    },
  });
  const run = await world.launch(definition);
  run.step(2);
  run.host.pause();
  run.step(5);
  assert.equal(updates, 2);
  assert.equal(run.telemetry().tick, 2);
  run.host.resume();
  run.step(1);
  assert.equal(updates, 3);
  run.dispose();
});

test("unsubscribing a fixed handler stops future updates", async () => {
  const world = createGameTestWorld();
  let count = 0;
  const definition = defineGame({
    id: "test.unsubscribe",
    setup(context) {
      const unsubscribe = context.onFixedUpdate(() => {
        count += 1;
      });
      context.onFixedUpdate(() => {
        if (count >= 2) unsubscribe();
      });
    },
  });
  const run = await world.launch(definition);
  run.step(10);
  assert.equal(count, 2);
  run.dispose();
});

test("prepare() rejects a bundle whose id disagrees with the manifest", async () => {
  const world = createGameTestWorld();
  const host = new CodeGameHostV1({
    manifest: createTestManifest("test.manifest-id"),
    world: world.source,
    seed: 1,
  });
  const definition = defineGame({ id: "test.other-id", setup() {} });
  await assert.rejects(host.prepare(definition), (error) => {
    assert.equal(error instanceof GameSdkError, true);
    assert.equal((error as GameSdkError).code, "game_entry_invalid");
    return true;
  });
});

test("an async setup does not tick before the host is ready", async () => {
  const world = createGameTestWorld();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const definition = defineGame({
    id: "test.async",
    async setup(context) {
      await gate;
      context.onFixedUpdate(() => undefined);
    },
  });
  const host = new CodeGameHostV1({
    manifest: createTestManifest("test.async"),
    world: world.source,
    seed: 3,
  });
  const preparing = host.prepare(definition);
  assert.equal(host.status, "preparing");
  host.step();
  assert.equal(host.tick, 0);
  release();
  await preparing;
  assert.equal(host.status, "ready");
  host.start();
  host.step();
  assert.equal(host.tick, 1);
  host.dispose();
});
