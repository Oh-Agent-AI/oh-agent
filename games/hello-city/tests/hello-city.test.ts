import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCodeGame } from "../../../packages/city-game-sdk/scripts/buildGame.ts";
import { createGameTestWorld } from "../../../packages/city-game-sdk/src/testing/index.ts";
import type { GameDefinitionV1 } from "../../../packages/city-game-sdk/src/api/defineGame.ts";
import type { RouteV1 } from "../../../packages/city-game-sdk/src/api/types.ts";

const gameDir = fileURLToPath(new URL("../", import.meta.url));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "hello-city-build-"));

const ROUTE: RouteV1 = Object.freeze({
  id: "main-road",
  points: Object.freeze([
    Object.freeze([0, 0, 0] as const),
    Object.freeze([12, 0, 0] as const),
    Object.freeze([24, 0, 4] as const),
  ]),
});

test("hello-city builds to an immutable, content-addressed ESM bundle", async () => {
  const first = await buildCodeGame({ workspaceDir: gameDir, outDir });
  const second = await buildCodeGame({ workspaceDir: gameDir, outDir });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.match(first.buildId, /^[0-9a-f]{64}$/);
  assert.equal(first.buildId, second.buildId, "a rebuild must produce the same buildId");
  assert.equal(fs.existsSync(first.bundlePath), true);
  assert.equal(first.byteLength > 0, true);

  const metadata = JSON.parse(fs.readFileSync(path.join(first.buildDir, "build.json"), "utf8")) as {
    buildId: string;
    gameId: string;
    bundle: string;
  };
  assert.equal(metadata.buildId, first.buildId);
  assert.equal(metadata.gameId, "community.hello-city");
  assert.equal(metadata.bundle, "game.js");

  // The SDK is bundled at build time (trusted alias), so the output must not
  // contain a bare specifier the City import() could not resolve.
  const bundle = fs.readFileSync(first.bundlePath, "utf8");
  assert.equal(/from\s*["']@oh-agent\//.test(bundle), false);
});

test("the built bundle runs headlessly and completes its route", async () => {
  const built = await buildCodeGame({ workspaceDir: gameDir, outDir });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const module = (await import(pathToFileURL(built.bundlePath).href)) as { default: GameDefinitionV1 };
  assert.equal(module.default.id, "community.hello-city");

  const manifest = JSON.parse(fs.readFileSync(path.join(gameDir, "game.manifest.json"), "utf8")) as unknown;
  const world = createGameTestWorld({ routes: [ROUTE], worldRevision: "world-hello-1" });
  const run = await world.launch(module.default, { seed: 17, manifest });

  run.advanceTicks(60);
  assert.equal(run.telemetry().entities, 1, "the cube must exist while the run is active");
  const hud = run.telemetry().hud;
  assert.ok(hud, "the HUD must receive progress");
  assert.equal(typeof hud.travelledMeters, "number");
  assert.equal((hud.travelledMeters as number) > 0, true);

  run.advanceTicks(600);
  const telemetry = run.telemetry();
  assert.equal(telemetry.outcome, "success");
  assert.equal(telemetry.reason, "route_complete");
  assert.equal(telemetry.status, "finished");
  assert.equal(telemetry.entities, 0, "finish must destroy run-owned entities");
  run.assertNoLeakedEntities();
});

test("the build rejects a missing entry and a missing declared asset", async () => {
  const brokenEntry = fs.mkdtempSync(path.join(os.tmpdir(), "hello-city-broken-"));
  fs.writeFileSync(
    path.join(brokenEntry, "game.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "code-game",
      gameId: "community.broken",
      displayName: "Broken",
      version: "0.1.0",
      entry: "src/does-not-exist.ts",
      sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 1 },
      world: { requiredCapabilities: ["roads.read"] },
      permissions: ["roads.read"],
      limits: { maxEntities: 4, maxProjectiles: 0 },
      assets: [],
    }),
  );
  const entryResult = await buildCodeGame({ workspaceDir: brokenEntry, outDir });
  assert.equal(entryResult.ok, false);
  assert.equal(entryResult.ok ? "" : entryResult.diagnostics[0]?.code, "game_entry_invalid");

  const brokenAsset = fs.mkdtempSync(path.join(os.tmpdir(), "hello-city-asset-"));
  fs.mkdirSync(path.join(brokenAsset, "src"), { recursive: true });
  fs.writeFileSync(path.join(brokenAsset, "src", "index.ts"), "export default {};\n");
  fs.writeFileSync(
    path.join(brokenAsset, "game.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "code-game",
      gameId: "community.broken",
      displayName: "Broken",
      version: "0.1.0",
      entry: "src/index.ts",
      sdk: { name: "@oh-agent/city-game-sdk", apiMajor: 1 },
      world: { requiredCapabilities: ["roads.read"] },
      permissions: ["roads.read"],
      limits: { maxEntities: 4, maxProjectiles: 0 },
      assets: [{ id: "cube", path: "assets/missing.glb", type: "model/glb" }],
    }),
  );
  const assetResult = await buildCodeGame({ workspaceDir: brokenAsset, outDir });
  assert.equal(assetResult.ok, false);
  assert.equal(assetResult.ok ? "" : assetResult.diagnostics[0]?.code, "game_asset_invalid");
});
