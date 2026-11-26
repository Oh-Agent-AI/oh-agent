import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCodeGame } from "../../../packages/city-game-sdk/scripts/buildGame.ts";
import { createGameTestWorld } from "../../../packages/city-game-sdk/src/testing/index.ts";
import type { GameDefinitionV1 } from "../../../packages/city-game-sdk/src/api/defineGame.ts";

const gameDir = fileURLToPath(new URL("../", import.meta.url));

test("the agent-authored tower defense builds and clears three waves", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tower-defense-build-"));
  const built = await buildCodeGame({ workspaceDir: gameDir, outDir });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const module = (await import(pathToFileURL(built.bundlePath).href)) as { default: GameDefinitionV1 };
  const manifest = JSON.parse(fs.readFileSync(path.join(gameDir, "game.manifest.json"), "utf8")) as unknown;
  const world = createGameTestWorld();
  const run = await world.launch(module.default, { seed: 7, manifest });
  run.advanceTicks(1800);
  const telemetry = run.telemetry();
  assert.equal(telemetry.outcome, "success");
  assert.equal(telemetry.reason, "all_waves_cleared");
  assert.equal(telemetry.entities, 0);
  assert.equal(telemetry.hud?.killed, 15);
  run.assertNoLeakedEntities();
});
