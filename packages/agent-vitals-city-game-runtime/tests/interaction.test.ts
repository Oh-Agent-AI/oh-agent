import test from "node:test";
import assert from "node:assert/strict";
import { InstalledGameRegistryV1, InteractionRouter } from "../src/interaction";
import type { InstalledGameV1 } from "../../city-game-sdk/src/protocol/installedGame";
import { createGameAccessV1, type HostGrantV1 } from "../../city-game-sdk/src/protocol/access";
import { validateCodeGameManifestV2 } from "../../city-game-sdk/src/protocol/manifestV2";
import type { GameLaunchAdapterV1, GameLaunchRequestV1 } from "../src/interaction";

const playerScope = { playerId: "player-1", kind: "local-profile" } as const;
const request: GameLaunchRequestV1 = {
  launchId: "launch-1",
  cityId: "city-1",
  cityRevision: 7,
  worldRevision: "world-1",
  snapshotDigest: "sha256:snapshot",
  interactionRevision: "interaction-1",
  target: { kind: "resident", id: "resident:linxia" },
  gameId: "community.romance",
  entry: "default",
  presentation: "overlay",
  playerScope,
};

function installation(overrides: Partial<InstalledGameV1> = {}): InstalledGameV1 {
  return Object.freeze({
    installationId: "installation-1",
    gameId: "community.romance",
    gameVersion: "1.0.0",
    kind: "code",
    contentDigest: "sha256:content",
    trustLevel: "local-trusted",
    status: "installed",
    entries: [{ id: "default", presentations: ["overlay"] }],
    ...overrides,
  });
}

function access(grant: HostGrantV1<typeof playerScope>) {
  const manifest = validateCodeGameManifestV2({
    schemaVersion: 2,
    kind: "code-game",
    gameId: "community.romance",
    displayName: "Romance",
    version: "1.0.0",
    entry: "src/index.ts",
    sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 2 },
    citySdk: { name: "@oh-agent/city-sdk", schemaMajor: 2 },
    world: { requiredCapabilities: ["world.snapshot"], binding: "capability-based" },
    render: { compatibleProfiles: [] },
    presentation: { supported: ["overlay"], default: "overlay" },
    permissions: ["world.read"],
    entries: [{ id: "default", export: "default", presentation: ["overlay"] }],
    limits: { maxEntities: 1, maxProjectiles: 0 },
    assets: [],
  });
  assert.equal(manifest.ok, true);
  if (!manifest.ok) throw new Error("unreachable");
  return createGameAccessV1(manifest.value, ["world.snapshot"], grant);
}

function setup(status: InstalledGameV1["status"] = "installed") {
  const registry = new InstalledGameRegistryV1();
  registry.register(installation({ status }));
  const grant: HostGrantV1<typeof playerScope> = {
    installationId: "installation-1",
    runId: "launch-1",
    playerScope,
    grantedPermissions: ["world.read"],
    status: "active",
  };
  let launches = 0;
  const adapter: GameLaunchAdapterV1 = {
    launch: async (input) => {
      launches += 1;
      return {
        launchId: input.launchId,
        runId: "run-1",
        installationId: "installation-1",
        gameId: input.gameId,
        entry: input.entry,
        presentation: input.presentation,
      };
    },
  };
  const router = new InteractionRouter(registry, {
    declarative: adapter,
    "legacy-runtime": adapter,
    code: adapter,
    revisions: () => ({ worldRevision: "world-1", interactionRevision: "interaction-1" }),
  });
  return { registry, router, grant, access: access(grant), adapter, launches: () => launches };
}

test("InstalledGameRegistry preserves immutable identity and rejects a swapped package", () => {
  const registry = new InstalledGameRegistryV1();
  const original = installation();
  registry.register(original);
  registry.register(original);
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.register(installation({ contentDigest: "sha256:other" })), /different content/);
  assert.throws(() => registry.findGame("missing"), /not installed/);
});

test("InteractionRouter launches through the unified read model exactly once per launchId", async () => {
  const { router, grant, access, launches } = setup();
  const first = await router.launch(request, access, grant);
  const second = await router.launch(request, access, grant);
  assert.equal(first.runId, "run-1");
  assert.equal(second.runId, "run-1");
  assert.equal(launches(), 1);
  await assert.rejects(() => router.launch({ ...request, launchId: "bad-entry", entry: "other" }, access, grant), /no registered entry/);
  await assert.rejects(() => router.launch({ ...request, launchId: "bad-presentation", presentation: "exclusive" }, access, grant), /does not support/);
});

test("InteractionRouter fails closed on revision, permission and installation state", async () => {
  const { registry, router, grant, access } = setup();
  await assert.rejects(
    () => router.launch({ ...request, interactionRevision: "stale" }, access, grant),
    /revision changed/,
  );
  await assert.rejects(
    () => router.launch(request, access, { ...grant, status: "revoked" }),
    /permission denied/,
  );
  const revoked = setup("revoked");
  await assert.rejects(() => revoked.router.launch(request, revoked.access, revoked.grant), /is revoked/);
});
