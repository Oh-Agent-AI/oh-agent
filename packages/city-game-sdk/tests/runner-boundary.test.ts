import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defineGame } from "../src/api/defineGame";
import { createGameTestWorld } from "../src/testing/headless";

/**
 * Runner resource boundaries (PR04). The MCP side enforces wall-clock budgets
 * and bounded output on the local Node runner; this file covers the SDK-side
 * defense in depth: previewGame's own tick cap and the injected-clock deadline
 * guard on the test harness's advanceTicks.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const previewScript = path.join(repoRoot, "packages/city-game-sdk/scripts/previewGame.ts");
const registerHook = path.join(repoRoot, "scripts/mecha-ts-register.mjs");

const expectCode = (code: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

function runPreview(args: readonly string[]): { ok: boolean; error?: { code?: string; message?: string } } {
  const result = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", registerHook, previewScript, ...args],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.ifError(result.error);
  return JSON.parse((result.stdout ?? "").trim()) as { ok: boolean; error?: { code?: string; message?: string } };
}

test("previewGame rejects ticks above its own cap with a structured argument error", () => {
  // 3601 alone is invalid in two ways (no build args and over the cap); the
  // cap check must win so the caller sees the unbounded-run problem, not the
  // generic usage error.
  const overCap = runPreview(["--ticks", "3601"]);
  assert.equal(overCap.ok, false);
  assert.equal(overCap.error?.code, "game_argument_invalid");
  assert.match(overCap.error?.message ?? "", /3600/);

  // A run at the cap passes the cap check and proceeds to the (here failing)
  // request-shape validation, so behavior at the boundary is unchanged.
  const atCap = runPreview(["--ticks", "3600"]);
  assert.equal(atCap.ok, false);
  assert.notEqual(atCap.error?.code, "game_argument_invalid");
});

test("advanceTicks keeps its unguarded behavior when no deadline is given", async () => {
  const world = createGameTestWorld();
  const definition = defineGame({
    id: "test.runner-boundary.unguarded",
    setup() {},
  });
  const run = await world.launch(definition, { seed: 7 });
  run.advanceTicks(5);
  assert.equal(run.telemetry().tick, 5);
  assert.equal(run.telemetry().status, "running");
  run.dispose();
  run.assertNoLeakedEntities();
});

test("advanceTicks aborts deterministically when the injected deadline passes", async () => {
  const world = createGameTestWorld();
  const definition = defineGame({
    id: "test.runner-boundary.deadline",
    setup() {},
  });
  const run = await world.launch(definition, { seed: 7 });
  // Synthetic clock: one guard reading per tick, 30 ms apart. With deadline 100
  // the first three ticks pass (30/60/90) and the fourth read (120) trips the
  // guard — no real sleeping, fully deterministic.
  let readings = 0;
  const now = (): number => {
    readings += 1;
    return readings * 30;
  };
  assert.throws(
    () => run.advanceTicks(100, { deadlineMs: 100, now }),
    expectCode("game_execution_timeout"),
  );
  assert.equal(readings, 4, "the guard reads the injected clock once per tick");
  assert.equal(run.telemetry().tick, 3, "exactly the ticks before the deadline have run");
  run.dispose();
  run.assertNoLeakedEntities();
});
