import test from "node:test";
import assert from "node:assert/strict";
import { validateCodeGameManifestV1 } from "../src/protocol/manifest";
import { createTestManifest } from "../src/testing/headless";

/**
 * Manifest validation is the first gate an Agent-built project hits. These
 * cases pin the *content* contract: a valid document, a traversal path, a
 * capability that was required but not granted, an unknown grant, a budget the
 * host would never enforce, and an API major the host does not implement.
 */

const validManifest = (): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: "code-game",
  gameId: "community.tower-defense",
  displayName: "City Tower Defense",
  version: "0.1.0",
  entry: "src/index.ts",
  sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 1 },
  world: { requiredCapabilities: ["roads.read", "terrain.sample"] },
  permissions: [
    "world.read",
    "roads.read",
    "terrain.sample",
    "entities.write.owned",
    "input.read",
    "ui.hud",
  ],
  limits: { maxEntities: 256, maxProjectiles: 128 },
  assets: [{ id: "enemy-basic", path: "assets/enemy.glb", type: "model/glb" }],
});

test("a valid manifest is accepted and deeply frozen", () => {
  const result = validateCodeGameManifestV1(validManifest());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.gameId, "community.tower-defense");
  assert.deepEqual(result.value.world.requiredCapabilities, ["roads.read", "terrain.sample"]);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.permissions), true);
  assert.equal(Object.isFrozen(result.value.world), true);
  assert.equal(Object.isFrozen(result.value.assets[0]), true);
});

test("a traversal or absolute asset path is rejected at validation time", () => {
  for (const path of ["../secret.glb", "/etc/passwd", "C:/tmp/a.glb", "assets/../../x.glb", "assets\\x.glb"]) {
    const manifest = validManifest();
    manifest.assets = [{ id: "enemy-basic", path, type: "model/glb" }];
    const result = validateCodeGameManifestV1(manifest);
    assert.equal(result.ok, false, `expected rejection for ${path}`);
    assert.equal(result.ok ? "" : result.diagnostics[0]?.code, "game_manifest_invalid");
  }
});

test("a required world capability must also be granted", () => {
  const manifest = validManifest();
  manifest.permissions = ["world.read", "terrain.sample", "entities.write.owned"];
  const result = validateCodeGameManifestV1(manifest);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.diagnostics[0]?.code, "game_manifest_invalid");
  assert.match(result.diagnostics[0]?.message ?? "", /roads\.read/);
});

test("unknown permissions and capabilities are rejected", () => {
  const manifest = validManifest();
  manifest.permissions = ["world.read", "network.fetch"];
  const result = validateCodeGameManifestV1(manifest);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.diagnostics[0]?.code, "game_manifest_invalid");

  const world = validManifest();
  world.world = { requiredCapabilities: ["roads.teleport"] };
  const second = validateCodeGameManifestV1(world);
  assert.equal(second.ok, false);
});

test("entity budgets are bounded by the host contract", () => {
  for (const maxEntities of [0, 1025, 1.5]) {
    const manifest = validManifest();
    manifest.limits = { maxEntities, maxProjectiles: 0 };
    const result = validateCodeGameManifestV1(manifest);
    assert.equal(result.ok, false, `expected rejection for maxEntities=${maxEntities}`);
  }
});

test("an unsupported API major fails with its own code", () => {
  const manifest = validManifest();
  manifest.sdk = { name: "@oh-agent/city-game-sdk", apiMajor: 2 };
  const result = validateCodeGameManifestV1(manifest);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.diagnostics[0]?.code, "game_manifest_unsupported");
});

test("unsupported top-level fields are rejected instead of silently ignored", () => {
  const manifest = validManifest();
  manifest.scripts = { postinstall: "node evil.mjs" };
  const result = validateCodeGameManifestV1(manifest);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.diagnostics.some((item) => item.message.includes("scripts")));
});

test("the test manifest helper goes through the same validator", () => {
  const manifest = createTestManifest("test.helper");
  assert.equal(manifest.gameId, "test.helper");
  assert.equal(manifest.limits.maxEntities, 64);
  assert.equal(manifest.assets[0]?.id, "test-cube");
});
