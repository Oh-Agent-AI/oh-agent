import test from "node:test";
import assert from "node:assert/strict";
import { compileWorldFixtureV1 } from "@oh-agent/city-sdk/testing";
import { sha256Bytes } from "@oh-agent/city-sdk";
import { CodeGameHostV2 } from "../src/host/codeGameHostV2";
import { createSnapshotWorldAPIV2 } from "../src/host/snapshotWorld";
import { createGameAccessV1, type HostGrantV1 } from "../src/protocol/access";
import { validateCodeGameManifestV2, type CodeGameManifestV2 } from "../src/protocol/manifestV2";

function manifest(permissions: readonly string[]): CodeGameManifestV2 {
  const result = validateCodeGameManifestV2({
    schemaVersion: 2,
    kind: "code-game",
    gameId: "test.host-v2",
    displayName: "Host V2",
    version: "0.1.0",
    entry: "src/index.ts",
    sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 2 },
    citySdk: { name: "@oh-agent/city-sdk", schemaMajor: 2 },
    world: { requiredCapabilities: permissions.includes("world.read") ? ["world.snapshot"] : [], binding: "capability-based" },
    render: { compatibleProfiles: [] },
    presentation: { supported: ["exclusive"], default: "exclusive" },
    permissions,
    entries: [{ id: "default", export: "default", presentation: ["exclusive"] }],
    limits: { maxEntities: 4, maxProjectiles: 0 },
    assets: [],
  });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function host(permissions = ["world.read", "ui.hud", "entities.write.owned", "input.read"]): CodeGameHostV2 {
  const game = manifest(permissions);
  const grant: HostGrantV1 = Object.freeze({
    installationId: "installation-v2",
    runId: "run-v2",
    grantedPermissions: permissions,
    status: "active",
  });
  return new CodeGameHostV2({
    manifest: game,
    world: createSnapshotWorldAPIV2(compileWorldFixtureV1()),
    seed: 42,
    runId: "run-v2",
    access: createGameAccessV1(game, ["world.snapshot"], grant),
    grant,
    cleanupTimeoutMs: 2,
  });
}

test("V2 runs a synchronous setup and one async onStart to completion", async () => {
  const events: string[] = [];
  const game = host();
  await game.prepare({
    id: "test.host-v2",
    setup: (ctx) => {
      events.push("setup");
      ctx.onStart(async () => {
        events.push("start");
        assert.equal(ctx.world.header().cityId, "city-fixture");
      });
      ctx.onDispose(() => {
        events.push("dispose-sync");
      });
      ctx.onDispose(async () => {
        events.push("dispose-async");
      });
    },
  });
  await game.start();
  assert.deepEqual(events, ["setup", "start", "dispose-async", "dispose-sync"]);
  assert.equal(game.status, "finished");
  assert.equal(game.telemetry().disposed, true);
});

test("V2 rejects a second onStart registration", async () => {
  const game = host();
  await game.prepare({
    id: "test.host-v2",
    setup: (ctx) => {
      ctx.onStart(async () => undefined);
      assert.throws(() => ctx.onStart(async () => undefined), /only one onStart/);
    },
  });
  await game.start();
  assert.equal(game.status, "finished");
});

test("V2 cancellation aborts a pending onStart and still releases the inner host", async () => {
  const game = host();
  let settle: (() => void) | undefined;
  await game.prepare({
    id: "test.host-v2",
    setup: (ctx) => {
      ctx.onStart(() => new Promise<void>((resolve) => {
        settle = resolve;
      }));
    },
  });
  const starting = game.start();
  await Promise.resolve();
  await game.stop();
  assert.equal(game.status, "stopped");
  assert.equal(game.telemetry().disposed, true);
  settle?.();
  await starting;
});

test("V2 world calls fail closed when the Host Grant is missing", async () => {
  const game = host(["ui.hud"]);
  await game.prepare({
    id: "test.host-v2",
    setup: (ctx) => {
      ctx.onStart(async () => {
        assert.throws(() => ctx.world.header(), /world access denied/);
      });
    },
  });
  await game.start();
  assert.equal(game.status, "finished");
});

test("V2 supports the fixed-step V1-compatible path when no onStart is registered", async () => {
  const game = host();
  let ticks = 0;
  await game.prepare({
    id: "test.host-v2",
    setup: (ctx) => {
      ctx.onFixedUpdate(() => {
        ticks += 1;
      });
    },
  });
  await game.start();
  game.step();
  game.pause();
  game.step();
  game.resume();
  game.step();
  assert.equal(ticks, 2);
  await game.stop();
  assert.equal(game.status, "stopped");
});

test("a denied model open never invokes the asset source", async () => {
  let opens = 0;
  const bytes = new TextEncoder().encode("model");
  const digest = `sha256:${Array.from(sha256Bytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const game = manifest(["world.read"]);
  const grant: HostGrantV1 = Object.freeze({
    installationId: "installation-v2",
    runId: "run-v2",
    grantedPermissions: ["ui.hud"],
    status: "active",
  });
  const world = createSnapshotWorldAPIV2(compileWorldFixtureV1(), {
    models: { [digest]: () => {
      opens += 1;
      return bytes;
    } },
  });
  const gameHost = new CodeGameHostV2({
    manifest: game,
    world,
    seed: 42,
    runId: "run-v2",
    access: createGameAccessV1(game, ["world.snapshot"], grant),
    grant,
    cleanupTimeoutMs: 2,
  });
  await gameHost.prepare({
    id: "test.host-v2",
    setup: (ctx) => {
      ctx.onStart(async () => {
        assert.throws(() => ctx.world.openModel(digest), /world access denied/);
      });
    },
  });
  await gameHost.start();
  assert.equal(opens, 0);
});

const storyRule = {
  ruleId: "date-saturday",
  version: 1,
  trigger: { kind: "calendar", recurrence: "once", atUtcMs: 1_000 },
  conditions: [],
  action: { kind: "offer-dialogue", eventId: "date-reminder" },
  missedPolicy: "persist",
} as const;

test("V2 story scheduling is host-mediated and permission checked", async () => {
  let schedules = 0;
  const story = {
    resolveLocalTime: async () => ({ atUtcMs: 1_000, clockRevision: "clock-1" }),
    schedule: async (rule: typeof storyRule, _options: { expectedStoryRevision: string; expectedClockRevision: string; operationId: string }) => {
      schedules += 1;
      return { ruleId: rule.ruleId, storyRevision: "0" };
    },
    cancel: async () => {},
    list: async () => [],
  };
  const deniedManifest = manifest(["world.read"]);
  const deniedGrant: HostGrantV1 = Object.freeze({ installationId: "installation-v2", runId: "run-v2", grantedPermissions: ["world.read"], status: "active" });
  const denied = new CodeGameHostV2({ manifest: deniedManifest, world: createSnapshotWorldAPIV2(compileWorldFixtureV1()), seed: 42,
    runId: "run-v2", access: createGameAccessV1(deniedManifest, ["world.snapshot"], deniedGrant), grant: deniedGrant, story });
  await denied.prepare({ id: "test.host-v2", setup: (ctx) => {
    ctx.onStart(async () => {
      assert.throws(() => ctx.story?.schedule(storyRule, { expectedStoryRevision: "0", expectedClockRevision: "clock-1", operationId: "schedule-1" }), /access denied/);
    });
  } });
  await denied.start();
  assert.equal(schedules, 0);

  const allowedManifest = manifest(["world.read", "story.schedule"]);
  const allowedGrant: HostGrantV1 = Object.freeze({ installationId: "installation-v2", runId: "run-v2", grantedPermissions: ["world.read", "story.schedule"], status: "active" });
  const allowed = new CodeGameHostV2({ manifest: allowedManifest, world: createSnapshotWorldAPIV2(compileWorldFixtureV1()), seed: 42,
    runId: "run-v2", access: createGameAccessV1(allowedManifest, ["world.snapshot"], allowedGrant), grant: allowedGrant, story });
  await allowed.prepare({ id: "test.host-v2", setup: (ctx) => {
    ctx.onStart(async () => {
      const result = await ctx.story?.schedule(storyRule, { expectedStoryRevision: "0", expectedClockRevision: "clock-1", operationId: "schedule-1" });
      assert.equal(result?.ruleId, "date-saturday");
    });
  } });
  await allowed.start();
  assert.equal(schedules, 1);
});
