import test from "node:test";
import assert from "node:assert/strict";
import {
  canInvoke,
  createGameAccessV1,
  evaluateGameInvocation,
  type HostGrantV1,
} from "../src/protocol/access";
import { validateCodeGameManifestV2, type CodeGameManifestV2 } from "../src/protocol/manifestV2";

function manifest(permissions: readonly string[]): CodeGameManifestV2 {
  const result = validateCodeGameManifestV2({
    schemaVersion: 2,
    kind: "code-game",
    gameId: "test.access",
    displayName: "Access",
    version: "0.1.0",
    entry: "src/index.ts",
    sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 2 },
    citySdk: { name: "@oh-agent/city-sdk", schemaMajor: 2 },
    world: { requiredCapabilities: [], binding: "capability-based" },
    render: { compatibleProfiles: [] },
    presentation: { supported: ["exclusive"], default: "exclusive" },
    permissions,
    entries: [{ id: "default", export: "default", presentation: ["exclusive"] }],
    limits: { maxEntities: 16, maxProjectiles: 0 },
    assets: [],
  });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function grant(permissions: readonly ("world.read" | "roads.read" | "ui.hud" | "navigation.query")[]): HostGrantV1 {
  return Object.freeze({
    installationId: "installation-1",
    runId: "run-1",
    grantedPermissions: permissions,
    status: "active",
  });
}

test("grant decisions independently require a valid run, request, grant and City capability", () => {
  const game = manifest(["world.read"]);
  const active = grant(["world.read"]);
  const access = createGameAccessV1(game, ["world.snapshot"], active);
  const context = { runId: "run-1" };
  assert.equal(canInvoke("world.read", context, access, active), true);

  const noCapability = createGameAccessV1(game, [], active);
  assert.deepEqual(evaluateGameInvocation("world.read", context, noCapability, active), {
    ok: false,
    reason: "capability-unavailable",
    permission: "world.read",
    requiredCapability: "world.snapshot",
  });
  assert.equal(
    evaluateGameInvocation("world.read", context, createGameAccessV1(manifest(["ui.hud"]), ["world.snapshot"], active), active).ok,
    false,
  );
  assert.equal(
    evaluateGameInvocation("world.read", context, access, grant([])).reason,
    "permission-not-granted",
  );
  assert.equal(evaluateGameInvocation("world.read", { runId: "run-2" }, access, active).reason, "run-invalid");
  assert.equal(
    evaluateGameInvocation("world.read", context, access, { ...active, status: "revoked" }).reason,
    "run-invalid",
  );
  assert.equal(
    evaluateGameInvocation("world.read", context, access, { ...active, status: "expired" }).reason,
    "run-invalid",
  );
});

test("game-only permissions do not invent a City capability requirement", () => {
  const active = grant(["ui.hud"]);
  const access = createGameAccessV1(manifest(["ui.hud"]), [], active);
  assert.equal(canInvoke("ui.hud", { runId: "run-1" }, access, active), true);
});

test("navigation grants are checked against the requested surface or volume mode", () => {
  const active = grant(["navigation.query"]);
  const access = createGameAccessV1(manifest(["navigation.query"]), ["navigation.surface"], active);
  assert.equal(canInvoke("navigation.query", { runId: "run-1", navigationMode: "surface" }, access, active), true);
  assert.equal(
    evaluateGameInvocation("navigation.query", { runId: "run-1", navigationMode: "volume" }, access, active).reason,
    "capability-unavailable",
  );
  assert.equal(
    evaluateGameInvocation("navigation.query", { runId: "run-1" }, access, active).reason,
    "navigation-mode-required",
  );
});

test("a Host Grant does not silently add a permission omitted from the manifest", () => {
  const active = grant(["roads.read"]);
  const access = createGameAccessV1(manifest(["ui.hud"]), ["roads.graph"], active);
  assert.equal(
    evaluateGameInvocation("roads.read", { runId: "run-1" }, access, active).reason,
    "permission-not-requested",
  );
});

test("Host Grants are bound to the invocation player scope when one is supplied", () => {
  const scoped: HostGrantV1<string> = {
    installationId: "installation-1",
    runId: "run-1",
    playerScope: "player-1",
    grantedPermissions: ["ui.hud"],
    status: "active",
  };
  const access = createGameAccessV1(manifest(["ui.hud"]), [], scoped);
  assert.equal(canInvoke("ui.hud", { runId: "run-1", playerScope: "player-1" }, access, scoped), true);
  assert.equal(canInvoke("ui.hud", { runId: "run-1", playerScope: "player-2" }, access, scoped), false);
  assert.equal(canInvoke("ui.hud", { runId: "run-1" }, access, scoped), false);
});

test("PlayerScope grants compare stable identity fields rather than object references", () => {
  const scoped: HostGrantV1<{ playerId: string; kind: "local-profile" | "remote-guest" }> = {
    installationId: "installation-1",
    runId: "run-1",
    playerScope: { playerId: "player-1", kind: "local-profile" },
    grantedPermissions: ["ui.hud"],
    status: "active",
  };
  const access = createGameAccessV1(manifest(["ui.hud"]), [], scoped);
  const equalButDistinct = { playerId: "player-1", kind: "local-profile" as const };
  assert.equal(canInvoke("ui.hud", { runId: "run-1", playerScope: equalButDistinct }, access, scoped), true);
  assert.equal(canInvoke("ui.hud", {
    runId: "run-1",
    playerScope: { playerId: "player-1", kind: "remote-guest" },
  }, access, scoped), false);
});
