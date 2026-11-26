import test from "node:test";
import assert from "node:assert/strict";
import { defineGame } from "../../../../packages/city-game-sdk/src/api/defineGame.ts";
import type { GameDefinitionV1 } from "../../../../packages/city-game-sdk/src/api/defineGame.ts";
import { GameSdkError } from "../../../../packages/city-game-sdk/src/protocol/errors.ts";
import { createGameTestWorld, createTestManifest } from "../../../../packages/city-game-sdk/src/testing/index.ts";
import {
  CodeGameRunV1,
  type CodeGameActivityCoordinatorV1,
  type CodeGameRenderFactoryV1,
  type CodeGameSceneLeaseV1,
  type CodeGameScenePortV1,
} from "../src/game/codeGameHost/codeGameSession.ts";

/**
 * The session is the seam where three ownership systems meet. These tests use
 * fakes on purpose: the point under test is *ordering and unwinding*, not Three
 * or React. A fake lease records attach/detach/frame-hook calls; a fake
 * coordinator records activate/release; a fake renderer records dispose.
 */

type Visual = Readonly<{ kind: string }>;

function createFakeScene(): {
  port: CodeGameScenePortV1<Visual>;
  frame: (frameSeconds: number) => void;
  setCurrent: (value: boolean) => void;
  hook: () => ((frameSeconds: number) => void) | null;
  state: { acquired: number; released: number; attached: number; detached: number };
} {
  const state = { acquired: 0, released: 0, attached: 0, detached: 0 };
  let hook: ((frameSeconds: number) => void) | null = null;
  let current = true;
  const lease: CodeGameSceneLeaseV1<Visual> = {
    token: Symbol("scene"),
    isCurrent: () => current,
    setFrameHook: (next) => {
      hook = next;
    },
    attach: (objects) => {
      state.attached += objects.length;
    },
    detach: (objects) => {
      state.detached += objects.length;
    },
    release: () => {
      state.released += 1;
    },
  };
  return {
    port: {
      async acquireResult() {
        state.acquired += 1;
        return { status: "ready", lease };
      },
    },
    frame: (frameSeconds) => hook?.(frameSeconds),
    setCurrent: (value) => {
      current = value;
    },
    hook: () => hook,
    state,
  };
}

function createFakeCoordinator(busy = false): {
  coordinator: CodeGameActivityCoordinatorV1;
  state: { activated: number; released: number };
} {
  const state = { activated: 0, released: 0 };
  const lease = {
    runId: 7,
    activate: () => {
      state.activated += 1;
      return true;
    },
    release: () => {
      state.released += 1;
    },
  };
  return {
    coordinator: {
      tryAcquire: () =>
        busy
          ? { ok: false, active: { activityId: "driving", phase: "running", runId: 3 } }
          : { ok: true, lease },
    },
    state,
  };
}

function createFakeRenderer(): {
  factory: CodeGameRenderFactoryV1<Visual>;
  state: { disposed: number; spawned: string[] };
} {
  const state = { disposed: 0, spawned: [] as string[] };
  return {
    factory: (lease) => {
      const group: Visual = { kind: "group" };
      lease.attach([group]);
      return {
        port: {
          spawn: (entity) => {
            state.spawned.push(entity.id);
          },
          update: () => undefined,
          destroy: () => undefined,
        },
        dispose: () => {
          state.disposed += 1;
          lease.detach([group]);
        },
      };
    },
    state,
  };
}

const tickingDefinition = (ticksToFinish: number, counter: { value: number }): GameDefinitionV1 =>
  defineGame({
    id: "test.session",
    setup(context) {
      context.onFixedUpdate(() => {
        counter.value += 1;
        if (counter.value === ticksToFinish) context.finish("success");
      });
    },
  });

test("a run drives the host from City frames and releases everything on finish", async () => {
  const scene = createFakeScene();
  const coordinator = createFakeCoordinator();
  const renderer = createFakeRenderer();
  const counter = { value: 0 };
  const world = createGameTestWorld();

  const run = await CodeGameRunV1.start({
    definition: tickingDefinition(3, counter),
    manifest: createTestManifest("test.session"),
    world: world.source,
    seed: 4,
    scenePort: scene.port,
    coordinator: coordinator.coordinator,
    createRender: renderer.factory,
  });

  assert.equal(run.host.status, "running");
  assert.equal(scene.state.acquired, 1);
  assert.equal(coordinator.state.activated, 1);
  assert.equal(scene.state.attached, 1);

  for (let index = 0; index < 10; index += 1) scene.frame(1 / 60);

  assert.equal(run.host.status, "finished");
  assert.equal(run.host.telemetry().outcome, "success");
  assert.equal(run.stopReason, "game_finished");
  assert.equal(scene.hook(), null, "the frame hook must be cleared before release");
  assert.equal(scene.state.released, 1);
  assert.equal(coordinator.state.released, 1);
  assert.equal(renderer.state.disposed, 1);
  assert.equal(scene.state.detached, 1);
});

test("a busy City activity refuses the run before touching the scene", async () => {
  const scene = createFakeScene();
  const coordinator = createFakeCoordinator(true);
  const renderer = createFakeRenderer();
  const world = createGameTestWorld();

  await assert.rejects(
    CodeGameRunV1.start({
      definition: tickingDefinition(3, { value: 0 }),
      manifest: createTestManifest("test.session"),
      world: world.source,
      seed: 4,
      scenePort: scene.port,
      coordinator: coordinator.coordinator,
      createRender: renderer.factory,
    }),
    (error) => {
      assert.equal(error instanceof GameSdkError, true);
      assert.equal((error as GameSdkError).code, "game_activity_busy");
      return true;
    },
  );
  assert.equal(scene.state.acquired, 0);
  assert.equal(renderer.state.disposed, 0);
});

test("a world revision change stops the run instead of mutating the new City", async () => {
  const scene = createFakeScene();
  const coordinator = createFakeCoordinator();
  const renderer = createFakeRenderer();
  const world = createGameTestWorld();

  const run = await CodeGameRunV1.start({
    definition: tickingDefinition(100, { value: 0 }),
    manifest: createTestManifest("test.session"),
    world: world.source,
    seed: 4,
    scenePort: scene.port,
    coordinator: coordinator.coordinator,
    createRender: renderer.factory,
  });

  scene.frame(1 / 60);
  scene.setCurrent(false);
  scene.frame(1 / 60);

  assert.equal(run.stopReason, "world_changed");
  assert.equal(run.host.telemetry().disposed, true);
  assert.equal(scene.state.released, 1);
  assert.equal(coordinator.state.released, 1);
  assert.equal(renderer.state.disposed, 1);
});

test("a setup failure unwinds the scene lease, renderer and activity lease", async () => {
  const scene = createFakeScene();
  const coordinator = createFakeCoordinator();
  const renderer = createFakeRenderer();
  const world = createGameTestWorld();
  const broken = defineGame({
    id: "test.session",
    setup() {
      throw new Error("boom");
    },
  });

  await assert.rejects(
    CodeGameRunV1.start({
      definition: broken,
      manifest: createTestManifest("test.session"),
      world: world.source,
      seed: 4,
      scenePort: scene.port,
      coordinator: coordinator.coordinator,
      createRender: renderer.factory,
    }),
    (error) => {
      assert.equal(error instanceof GameSdkError, true);
      assert.equal((error as GameSdkError).code, "game_runtime_fault");
      return true;
    },
  );
  assert.equal(renderer.state.disposed, 1);
  assert.equal(scene.state.released, 1);
  assert.equal(coordinator.state.released, 1);
});

test("a slow frame drops catch-up time instead of killing the run", async () => {
  const scene = createFakeScene();
  const coordinator = createFakeCoordinator();
  const renderer = createFakeRenderer();
  const world = createGameTestWorld();

  const run = await CodeGameRunV1.start({
    definition: tickingDefinition(1000, { value: 0 }),
    manifest: createTestManifest("test.session"),
    world: world.source,
    seed: 4,
    scenePort: scene.port,
    coordinator: coordinator.coordinator,
    createRender: renderer.factory,
  });

  // 400 ms frame: the clock caps at 10 steps (~166 ms of simulation) and drops
  // the rest, rather than replaying 24 steps or stopping the game.
  scene.frame(0.4);
  assert.equal(run.stopReason, null);
  assert.equal(run.host.status, "running");
  assert.equal(run.host.telemetry().tick, 10);
  run.dispose();
});

test("a frame beyond the gap budget stops the run", async () => {
  const scene = createFakeScene();
  const coordinator = createFakeCoordinator();
  const renderer = createFakeRenderer();
  const world = createGameTestWorld();

  const run = await CodeGameRunV1.start({
    definition: tickingDefinition(1000, { value: 0 }),
    manifest: createTestManifest("test.session"),
    world: world.source,
    seed: 4,
    scenePort: scene.port,
    coordinator: coordinator.coordinator,
    createRender: renderer.factory,
  });

  scene.frame(1.2);
  assert.equal(run.stopReason, "frame_gap");
  assert.equal(run.host.telemetry().disposed, true);
});
