import test from "node:test";
import assert from "node:assert/strict";
import { defineGame } from "../src/api/defineGame";
import { CodeGameHostV1 } from "../src/host/codeGameHost";
import { createGameTestWorld, createTestManifest } from "../src/testing/headless";

/** Same seed must produce the same stream across hosts, because the headless
 * harness and the City WebView are separate JS engines (AC-04 replay). */
test("the same seed produces the same random stream on two hosts", async () => {
  const samplesOf = async (seed: number): Promise<number[]> => {
    const world = createGameTestWorld();
    const samples: number[] = [];
    const definition = defineGame({
      id: "test.random",
      setup(context) {
        context.onFixedUpdate(() => samples.push(context.random.next()));
      },
    });
    const run = await world.launch(definition, { seed });
    run.step(60);
    return samples;
  };

  const first = await samplesOf(1234);
  const second = await samplesOf(1234);
  const third = await samplesOf(4321);
  assert.equal(first.length, 60);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, third);
});

test("pausing does not consume random values", async () => {
  const world = createGameTestWorld();
  const samples: number[] = [];
  const definition = defineGame({
    id: "test.random.pause",
    setup(context) {
      context.onFixedUpdate(() => samples.push(context.random.next()));
    },
  });
  const run = await world.launch(definition, { seed: 9 });
  run.step(3);
  const afterThree = [...samples];
  run.host.pause();
  run.step(10);
  assert.deepEqual(samples, afterThree);
  run.host.resume();
  run.step(1);
  assert.equal(samples.length, 4);
  run.dispose();
});

test("random.int stays in range and rejects empty intervals", async () => {
  const world = createGameTestWorld();
  let context: import("../src/api/types").GameContextV1 | undefined;
  const definition = defineGame({ id: "test.random.int", setup(value) { context = value; } });
  const run = await world.launch(definition, { seed: 1 });
  assert.ok(context);
  for (let index = 0; index < 200; index += 1) {
    const value = context.random.int(3, 7);
    assert.equal(Number.isInteger(value), true);
    assert.equal(value >= 3 && value < 7, true);
  }
  assert.throws(() => context.random.int(5, 5), (error) => {
    assert.equal((error as { code?: string }).code, "game_argument_invalid");
    return true;
  });
  run.dispose();
});

test("the diagnostics clock is injected, and defaults to zero in headless runs", async () => {
  const world = createGameTestWorld();
  const definition = defineGame({ id: "test.clock", setup() {} });
  const defaultHost = new CodeGameHostV1({
    manifest: createTestManifest("test.clock"),
    world: world.source,
    seed: 1,
  });
  await defaultHost.prepare(definition);
  assert.equal(defaultHost.telemetry().tick, 0);

  const nowHost = new CodeGameHostV1({
    manifest: createTestManifest("test.clock"),
    world: world.source,
    seed: 1,
    nowMs: () => 4242,
  });
  let observed = 0;
  const clockDefinition = defineGame({
    id: "test.clock",
    setup(context) {
      observed = context.clock.nowMs();
    },
  });
  await nowHost.prepare(clockDefinition);
  assert.equal(observed, 4242);
  defaultHost.dispose();
  nowHost.dispose();
});
