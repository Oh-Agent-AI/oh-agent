import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCodeGame, type CodeGameBuildSuccess } from "../scripts/buildGame.ts";
import {
  evaluateGameTestScenarioV1,
  MAX_SCENARIO_ASSERTIONS,
  MAX_SCENARIO_DESCRIPTION,
  MAX_SCENARIO_ID,
  validateGameTestScenarioV1,
  type GameTestRunObservationV1,
  type GameTestScenarioV1,
} from "../src/testing/scenario.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const templateDir = path.join(repoRoot, "games", "hello-city");
const previewScript = path.join(packageRoot, "scripts", "previewGame.ts");
const registerHook = path.join(repoRoot, "scripts", "mecha-ts-register.mjs");

const scenario = (overrides: Partial<GameTestScenarioV1> = {}): GameTestScenarioV1 => ({
  schemaVersion: 1,
  scenarioId: "test.scenario",
  assertions: [{ id: "win", kind: "outcome", expectOutcome: "success" }],
  ...overrides,
});

const observation = (overrides: Partial<GameTestRunObservationV1> = {}): GameTestRunObservationV1 => ({
  outcome: "success",
  tick: 400,
  entities: 1,
  hud: { progress: 1 },
  counters: { spawns: 1, destroys: 0, fixedUpdates: 400, hudUpdates: 4, audioPlays: 0, events: 0, errors: 0 },
  finishedWithinBudget: true,
  ...overrides,
});

// ── validator ──────────────────────────────────────────────────────

test("valid scenarios pass and unknown fields are rejected", () => {
  const valid = validateGameTestScenarioV1({
    schemaVersion: 1,
    scenarioId: "route.complete",
    description: "the cube reaches the end of the road",
    seed: 7,
    maxTicks: 1200,
    assertions: [
      { id: "win", kind: "outcome", expectOutcome: "success" },
      { id: "road", kind: "entityCountAtLeast", count: 1 },
      { id: "clean", kind: "entityCountAtMost", count: 8 },
      { id: "hud", kind: "hudFlag", key: "progress", equals: 1 },
      { id: "spawns", kind: "counterAtLeast", key: "spawns", value: 1 },
      { id: "quiet", kind: "counterEquals", key: "errors", value: 0 },
      { id: "fast", kind: "finishedWithinTicks", max: 3600 },
    ],
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
  assert.equal(valid.ok && valid.value.assertions.length, 7);
  for (const bad of [
    { ...scenario(), extra: true },
    { ...scenario(), schemaVersion: 2 },
    { ...scenario(), scenarioId: "" },
    { ...scenario(), assertions: [] },
    { ...scenario(), assertions: [{ id: "a", kind: "entityPresent", blueprint: "cube" }] },
    { ...scenario(), assertions: [{ id: "win", kind: "outcome" }] },
    { ...scenario(), assertions: [{ id: "win", kind: "outcome", expectOutcome: "draw" }] },
    { ...scenario(), assertions: [{ id: "a", kind: "counterAtLeast", key: "notACounter", value: 1 }] },
    { ...scenario(), assertions: [{ id: "a", kind: "hudFlag", key: "k", equals: { nested: true } }] },
    { ...scenario(), assertions: [{ id: "a", kind: "finishedWithinTicks", max: 3601 }] },
    { ...scenario(), assertions: [{ id: "a", kind: "entityCountAtLeast", count: -1 }] },
    { ...scenario(), maxTicks: 3601 },
    { ...scenario(), seed: 4_294_967_296 },
  ]) {
    const result = validateGameTestScenarioV1(bad);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(result.ok ? "" : result.diagnostics[0]?.code, "game_argument_invalid");
  }
});

test("scenario bounds are capped exactly at the documented limits", () => {
  assert.equal(validateGameTestScenarioV1(scenario({ scenarioId: "a".repeat(MAX_SCENARIO_ID) })).ok, true);
  assert.equal(validateGameTestScenarioV1(scenario({ scenarioId: "a".repeat(MAX_SCENARIO_ID + 1) })).ok, false);
  assert.equal(validateGameTestScenarioV1(scenario({ description: "d".repeat(MAX_SCENARIO_DESCRIPTION) })).ok, true);
  assert.equal(validateGameTestScenarioV1(scenario({ description: "d".repeat(MAX_SCENARIO_DESCRIPTION + 1) })).ok, false);
  const atCap = validateGameTestScenarioV1(scenario({
    assertions: Array.from({ length: MAX_SCENARIO_ASSERTIONS }, (_, index) => ({ id: `a${index}`, kind: "finishedWithinTicks", max: 3600 })),
  }));
  assert.equal(atCap.ok, true, JSON.stringify(atCap.ok ? "" : atCap.diagnostics));
  const overCap = validateGameTestScenarioV1(scenario({
    assertions: Array.from({ length: MAX_SCENARIO_ASSERTIONS + 1 }, (_, index) => ({ id: `a${index}`, kind: "finishedWithinTicks", max: 3600 })),
  }));
  assert.equal(overCap.ok, false);
  const duplicates = validateGameTestScenarioV1(scenario({
    assertions: [
      { id: "same", kind: "finishedWithinTicks", max: 10 },
      { id: "same", kind: "finishedWithinTicks", max: 20 },
    ],
  }));
  assert.equal(duplicates.ok, false);
  assert.equal(validateGameTestScenarioV1("not-an-object").ok, false);
});

// ── evaluator: the PR06 verdict decision table ─────────────────────

test("all passed assertions with a finished run pass the scenario", () => {
  const result = evaluateGameTestScenarioV1(scenario({
    assertions: [
      { id: "win", kind: "outcome", expectOutcome: "success" },
      { id: "fast", kind: "finishedWithinTicks", max: 500 },
    ],
  }), observation());
  assert.equal(result.verdict, "passed");
  assert.equal(result.verdictReason, undefined);
  assert.deepEqual(result.assertions.map((item) => item.status), ["passed", "passed"]);
});

test("any failed assertion fails the scenario, even on an unfinished run", () => {
  const lost = evaluateGameTestScenarioV1(scenario({ assertions: [{ id: "win", kind: "outcome", expectOutcome: "success" }] }),
    observation({ outcome: "failure" }));
  assert.equal(lost.verdict, "failed");
  assert.match(lost.assertions[0]?.diagnostic ?? "", /failure/);
  const neverFinished = evaluateGameTestScenarioV1(scenario({ assertions: [{ id: "win", kind: "outcome", expectOutcome: "success" }] }),
    observation({ outcome: null, finishedWithinBudget: false }));
  assert.equal(neverFinished.verdict, "failed");
  assert.match(neverFinished.assertions[0]?.diagnostic ?? "", /never finished/);
  const unfinishedButPassing = evaluateGameTestScenarioV1(
    scenario({ assertions: [{ id: "active", kind: "counterAtLeast", key: "fixedUpdates", value: 1 }] }),
    observation({ outcome: null, finishedWithinBudget: false }),
  );
  // All assertions pass, but the budget expired mid-run: never `passed`.
  assert.equal(unfinishedButPassing.verdict, "inconclusive");
  assert.equal(unfinishedButPassing.verdictReason, "tick_budget_exhausted");
});

test("unsupported observations report unknown and degrade to inconclusive", () => {
  const missingCounter = evaluateGameTestScenarioV1(
    scenario({ assertions: [{ id: "spawns", kind: "counterAtLeast", key: "spawns", value: 1 }] }),
    observation({ counters: {} }),
  );
  assert.equal(missingCounter.assertions[0]?.status, "unknown");
  assert.equal(missingCounter.verdict, "inconclusive");
  assert.equal(missingCounter.verdictReason, "unresolved_assertions");
  const absentHud = evaluateGameTestScenarioV1(
    scenario({ assertions: [{ id: "hud", kind: "hudFlag", key: "progress", equals: 1 }] }),
    observation({ hud: null }),
  );
  // A HUD the game never published is a real (deterministic) miss, not unknown.
  assert.equal(absentHud.assertions[0]?.status, "failed");
  assert.match(absentHud.assertions[0]?.diagnostic ?? "", /never published a HUD/);
  const missingKey = evaluateGameTestScenarioV1(
    scenario({ assertions: [{ id: "hud", kind: "hudFlag", key: "progress", equals: 1 }] }),
    observation({ hud: { other: 1 } }),
  );
  assert.equal(missingKey.assertions[0]?.status, "failed");
});

// ── runner wiring (real sealed build, real headless run) ───────────

function fixture(t: { after(callback: () => void): void }): { workspace: string; outDir: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-scenario-workspace-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-scenario-builds-"));
  fs.cpSync(templateDir, workspace, { recursive: true });
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  return { workspace, outDir };
}

async function built(workspace: string, outDir: string): Promise<CodeGameBuildSuccess> {
  const result = await buildCodeGame({ workspaceDir: workspace, outDir });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function runPreview(outDir: string, buildId: string, extraArgs: readonly string[]): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      registerHook,
      previewScript,
      "--build",
      buildId,
      "--builds-dir",
      outDir,
      "--ticks",
      "400",
      ...extraArgs,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("previewGame evaluates a requested scenario and reports the verdict", async (t) => {
  const { workspace, outDir } = fixture(t);
  const result = await built(workspace, outDir);
  const passing = runPreview(outDir, result.buildId, [
    "--scenario",
    JSON.stringify(scenario({
      scenarioId: "route.complete",
      assertions: [
        { id: "win", kind: "outcome", expectOutcome: "success" },
        { id: "spawned", kind: "counterAtLeast", key: "spawns", value: 1 },
        { id: "fast", kind: "finishedWithinTicks", max: 3600 },
      ],
    })),
  ]);
  assert.equal(passing.ok, true, result.stdout);
  const scenarioBlock = passing.scenario as Record<string, unknown>;
  assert.equal(scenarioBlock.scenarioId, "route.complete");
  assert.equal(scenarioBlock.verdict, "passed");
  assert.equal((scenarioBlock.assertions as unknown[]).length, 3);

  const failing = runPreview(outDir, result.buildId, [
    "--scenario",
    JSON.stringify(scenario({ assertions: [{ id: "lose", kind: "outcome", expectOutcome: "failure" }] })),
  ]);
  const failingBlock = failing.scenario as Record<string, unknown>;
  assert.equal(failingBlock.verdict, "failed");
  assert.equal((failingBlock.assertions as Array<{ status: string }>)[0]?.status, "failed");
});

test("previewGame never reports passed for a run cut off before the game finished", async (t) => {
  const { workspace, outDir } = fixture(t);
  fs.writeFileSync(
    path.join(workspace, "src", "index.ts"),
    `import { defineGame } from "@oh-agent/city-game-sdk";
export default defineGame({ id: "community.hello-city", setup() {} });
`,
  );
  const result = await built(workspace, outDir);
  const unfinished = runPreview(outDir, result.buildId, [
    "--ticks",
    "5",
    "--scenario",
    JSON.stringify(scenario({ assertions: [{ id: "spawned", kind: "counterAtLeast", key: "spawns", value: 1 }] })),
  ]);
  assert.equal(unfinished.ok, true, result.stdout);
  const block = unfinished.scenario as Record<string, unknown>;
  // An idle game never spawns → the assertion itself fails decisively.
  assert.equal(block.verdict, "failed");

  const zeroAssertion = runPreview(outDir, result.buildId, [
    "--ticks",
    "5",
    "--scenario",
    JSON.stringify(scenario({ assertions: [{ id: "ticking", kind: "counterAtLeast", key: "fixedUpdates", value: 1 }] })),
  ]);
  const zeroBlock = zeroAssertion.scenario as Record<string, unknown>;
  // The idle game ticks 5 times (assertion passes) but never finished: more
  // ticks might have flipped the outcome, so the verdict stays inconclusive.
  assert.equal(zeroBlock.verdict, "inconclusive");
  assert.equal(zeroBlock.verdictReason, "tick_budget_exhausted");
});

test("previewGame rejects invalid scenarios with structured argument errors and preserves legacy output", async (t) => {
  const { workspace, outDir } = fixture(t);
  const result = await built(workspace, outDir);
  const expectInvalid = (args: readonly string[]) => {
    const output = runPreview(outDir, result.buildId, args) as { ok: boolean; error?: { code?: string } };
    assert.equal(output.ok, false);
    assert.equal(output.error?.code, "game_argument_invalid");
  };
  expectInvalid(["--scenario", "x".repeat(8_193)]);
  expectInvalid(["--scenario", "{not json"]);
  expectInvalid(["--scenario", JSON.stringify({ schemaVersion: 1, scenarioId: "s", assertions: [{ id: "a", kind: "entityPresent" }] })]);

  const legacy = runPreview(outDir, result.buildId, []);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.scenario, undefined, "without --scenario no scenario block is emitted");
});
