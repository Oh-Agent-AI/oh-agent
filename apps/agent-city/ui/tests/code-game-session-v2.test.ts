import test from "node:test";
import assert from "node:assert/strict";
import { compileWorldFixtureV1 } from "@oh-agent/city-sdk/testing";
import { defineGameV2 } from "../../../../packages/city-game-sdk/src/api/v2";
import { createSnapshotWorldAPIV2 } from "../../../../packages/city-game-sdk/src/host/snapshotWorld";
import { createGameAccessV1, type HostGrantV1 } from "../../../../packages/city-game-sdk/src/protocol/access";
import { validateCodeGameManifestV2 } from "../../../../packages/city-game-sdk/src/protocol/manifestV2";
import { CodeGameRunV2 } from "../src/game/codeGameHost/codeGameSessionV2";
import type { CodeGameActivityCoordinatorV1, CodeGameRenderFactoryV1, CodeGameSceneLeaseV1, CodeGameScenePortV1 } from "../src/game/codeGameHost/codeGameSession";

type Visual = Readonly<{ kind: string }>;
const playerScope = { playerId: "player-v2", kind: "local-profile" } as const;

function manifest() {
  const result = validateCodeGameManifestV2({
    schemaVersion: 2,
    kind: "code-game",
    gameId: "test.session-v2",
    displayName: "Session V2",
    version: "0.1.0",
    entry: "src/index.ts",
    sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 2 },
    citySdk: { name: "@oh-agent/city-sdk", schemaMajor: 2 },
    world: { requiredCapabilities: ["world.snapshot"], binding: "capability-based" },
    render: { compatibleProfiles: [] },
    presentation: { supported: ["exclusive"], default: "exclusive" },
    permissions: ["world.read", "entities.write.owned", "input.read", "ui.hud"],
    entries: [{ id: "default", export: "default", presentation: ["exclusive"] }],
    limits: { maxEntities: 4, maxProjectiles: 0 },
    assets: [],
  });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function scene() {
  const state = { acquired: 0, released: 0, attached: 0, detached: 0 };
  let current = true;
  let hook: ((seconds: number) => void) | null = null;
  const lease: CodeGameSceneLeaseV1<Visual> = {
    token: Symbol("scene-v2"),
    isCurrent: () => current,
    setFrameHook: (next) => { hook = next; },
    attach: (objects) => { state.attached += objects.length; },
    detach: (objects) => { state.detached += objects.length; },
    release: () => { state.released += 1; },
  };
  return {
    state,
    port: {
      acquireResult: async () => {
        state.acquired += 1;
        return { status: "ready" as const, lease };
      },
    } satisfies CodeGameScenePortV1<Visual>,
    frame: (seconds: number) => hook?.(seconds),
    invalidate: () => { current = false; },
  };
}

function coordinator(busy = false) {
  const state = { activated: 0, released: 0 };
  return {
    state,
    coordinator: {
      tryAcquire: () => busy
        ? { ok: false as const, active: { activityId: "driving", phase: "running", runId: 3 } }
        : { ok: true as const, lease: {
          runId: 7,
          activate: () => { state.activated += 1; return true; },
          release: () => { state.released += 1; },
        } },
    } satisfies CodeGameActivityCoordinatorV1,
  };
}

function renderer() {
  const state = { disposed: 0 };
  const factory: CodeGameRenderFactoryV1<Visual> = (lease) => {
    const group: Visual = { kind: "group" };
    lease.attach([group]);
    return {
      port: { spawn: () => undefined, update: () => undefined, destroy: () => undefined },
      dispose: () => {
        state.disposed += 1;
        lease.detach([group]);
      },
    };
  };
  return { state, factory };
}

function options() {
  const game = manifest();
  const grant: HostGrantV1<typeof playerScope> = {
    installationId: "installation-v2",
    runId: "launch-v2",
    playerScope,
    grantedPermissions: game.permissions,
    status: "active",
  };
  return {
    definition: defineGameV2({
      id: "test.session-v2",
      setup: () => undefined,
    }),
    manifest: game,
    world: createSnapshotWorldAPIV2(compileWorldFixtureV1()),
    seed: 42,
    access: createGameAccessV1(game, ["world.snapshot"], grant),
    grant,
    playerScope,
  };
}

test("V2 session supports fixed-step gameplay and cleans all leases on finish", async () => {
  const sceneFake = scene();
  const activity = coordinator();
  const render = renderer();
  let ticks = 0;
  const run = await CodeGameRunV2.start({
    ...options(),
    definition: defineGameV2({
      id: "test.session-v2",
      setup: (ctx) => {
        ctx.onFixedUpdate(() => {
          ticks += 1;
          if (ticks === 3) ctx.finish("success");
        });
      },
    }),
    scenePort: sceneFake.port,
    coordinator: activity.coordinator,
    createRender: render.factory,
  });
  for (let index = 0; index < 10; index += 1) sceneFake.frame(1 / 60);
  assert.equal(ticks, 3);
  assert.equal(run.host.status, "finished");
  await run.stop("game_finished");
  assert.equal(sceneFake.state.released, 1);
  assert.equal(activity.state.released, 1);
  assert.equal(render.state.disposed, 1);
});

test("V2 session is idempotent by launchId", async () => {
  const first = await CodeGameRunV2.start({ ...options(), scenePort: scene().port, coordinator: coordinator().coordinator, createRender: renderer().factory });
  const second = await CodeGameRunV2.start({ ...options(), scenePort: scene().port, coordinator: coordinator().coordinator, createRender: renderer().factory });
  assert.equal(first, second);
  await first.stop();
  await second.stop();
});

test("V2 session refuses a busy activity before touching the scene", async () => {
  const sceneFake = scene();
  await assert.rejects(CodeGameRunV2.start({
    ...options(),
    scenePort: sceneFake.port,
    coordinator: coordinator(true).coordinator,
    createRender: renderer().factory,
  }), /already running/);
  assert.equal(sceneFake.state.acquired, 0);
});

test("V2 session stops on world lease invalidation", async () => {
  const sceneFake = scene();
  const run = await CodeGameRunV2.start({ ...options(), scenePort: sceneFake.port, coordinator: coordinator().coordinator, createRender: renderer().factory });
  sceneFake.invalidate();
  sceneFake.frame(1 / 60);
  await run.stop("world_changed");
  assert.equal(run.isDisposed, true);
  assert.equal(sceneFake.state.released, 1);
});
