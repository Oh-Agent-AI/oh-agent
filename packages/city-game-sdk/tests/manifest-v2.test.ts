import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptCodeGameManifestV1ToV2,
  resolveCodeGameEntryV2,
  validateCodeGameManifest,
  validateCodeGameManifestV2,
} from "../src/protocol/manifestV2";
import { validateCodeGameManifestV1 } from "../src/protocol/manifest";
import { createTestManifest } from "../src/testing/headless";

const validManifest = (): Record<string, unknown> => ({
  schemaVersion: 2,
  kind: "code-game",
  gameId: "community.submarine-explorer",
  displayName: "Submarine Explorer",
  version: "0.2.0",
  entry: "src/index.ts",
  sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 2 },
  citySdk: { name: "@oh-agent/city-sdk", schemaMajor: 2 },
  world: {
    requiredCapabilities: ["world.snapshot", "terrain.heightfield", "navigation.volume"],
    compatibleBiomes: ["underwater"],
    minSnapshotSchema: 4,
    binding: "capability-based",
  },
  render: { compatibleProfiles: ["realistic-3d", "pixel-3d"], preferredProfile: "pixel-3d" },
  presentation: { supported: ["exclusive", "overlay"], default: "exclusive" },
  permissions: [
    "world.read",
    "terrain.sample",
    "navigation.query",
    "entities.write.owned",
    "input.read",
    "ui.hud",
  ],
  entries: [
    { id: "default", export: "default", presentation: ["exclusive"] },
    { id: "briefing", export: "briefing", presentation: ["overlay"] },
  ],
  limits: { maxEntities: 64, maxProjectiles: 0 },
  assets: [{ id: "submarine", path: "assets/submarine.glb", type: "model/glb" }],
});

test("Manifest V2 separates City capabilities from permission requests and freezes entries", () => {
  const result = validateCodeGameManifestV2(validManifest());
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) return;
  assert.deepEqual(result.value.world.requiredCapabilities, [
    "world.snapshot",
    "terrain.heightfield",
    "navigation.volume",
  ]);
  assert.equal(result.value.permissions.includes("navigation.query"), true);
  assert.equal(Object.isFrozen(result.value.entries), true);
  assert.equal(Object.isFrozen(result.value.entries[0]?.presentation), true);
  assert.equal(resolveCodeGameEntryV2(result.value).export, "default");
  assert.equal(resolveCodeGameEntryV2(result.value, "briefing", "overlay").id, "briefing");
  assert.throws(
    () => resolveCodeGameEntryV2(result.value, "missing"),
    (error: unknown) => (error as { code?: string }).code === "game_entry_invalid",
  );
  assert.throws(
    () => resolveCodeGameEntryV2(result.value, "briefing", "exclusive"),
    (error: unknown) => (error as { code?: string }).code === "game_entry_invalid",
  );
});

test("a V2 capability requires its mapped permission, while game-only permissions need no capability", () => {
  const missing = validManifest();
  missing.permissions = ["world.read", "terrain.sample", "ui.hud"];
  const denied = validateCodeGameManifestV2(missing);
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? "" : denied.diagnostics.map((item) => item.message).join(" "), /navigation\.query/);

  const gameOnly = validManifest();
  gameOnly.world = { requiredCapabilities: [], binding: "capability-based" };
  gameOnly.permissions = ["entities.write.owned", "ui.hud"];
  gameOnly.entries = [{ id: "default", export: "default", presentation: ["exclusive"] }];
  const accepted = validateCodeGameManifestV2(gameOnly);
  assert.equal(accepted.ok, true, accepted.ok ? "" : JSON.stringify(accepted.diagnostics));
});

test("entry ids are unique and entry exports and presentations are controlled", () => {
  const duplicate = validManifest();
  duplicate.entries = [
    { id: "default", export: "default", presentation: ["exclusive"] },
    { id: "default", export: "other", presentation: ["overlay"] },
  ];
  assert.equal(validateCodeGameManifestV2(duplicate).ok, false);

  const arbitraryExport = validManifest();
  arbitraryExport.entries = [{ id: "default", export: "../secret", presentation: ["exclusive"] }];
  assert.equal(validateCodeGameManifestV2(arbitraryExport).ok, false);

  const unsupported = validManifest();
  unsupported.entries = [{ id: "default", export: "default", presentation: ["overlay", "exclusive", "exclusive"] }];
  assert.equal(validateCodeGameManifestV2(unsupported).ok, false);
});

test("generic validation dispatches V2 without weakening V1 strictness", () => {
  assert.equal(validateCodeGameManifest(validManifest()).ok, true);
  const v1 = createTestManifest("test.compat");
  assert.equal(validateCodeGameManifest(v1).ok, true);
  const oldApi = validManifest();
  oldApi.sdk = { name: "@oh-agent/city-game-sdk", apiMajor: 1 };
  const result = validateCodeGameManifestV2(oldApi);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.diagnostics.some((item) => item.code === "game_manifest_unsupported"), true);
});

test("V1 compatibility explicitly maps only the three legacy world capabilities", () => {
  const v1 = createTestManifest("test.compat", {
    world: { requiredCapabilities: ["world.read", "roads.read", "terrain.sample"], layoutId: "legacy-layout" },
  });
  const v2 = adaptCodeGameManifestV1ToV2(v1);
  assert.deepEqual(v2.world.requiredCapabilities, ["world.snapshot", "roads.graph", "terrain.heightfield"]);
  assert.deepEqual(v2.permissions, v1.permissions);
  assert.deepEqual(v2.entries, [{ id: "default", export: "default", presentation: ["exclusive"] }]);
  assert.equal(validateCodeGameManifestV2(v2).ok, true);
  assert.equal(validateCodeGameManifestV1(v1).ok, true);
  assert.equal(v1.world.layoutId, "legacy-layout");
});
