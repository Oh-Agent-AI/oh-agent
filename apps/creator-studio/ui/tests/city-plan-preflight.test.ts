import test from "node:test";
import assert from "node:assert/strict";
import { assertCityPlanPlayable } from "../src/cityPlanPreflight.ts";

const DUNES = {
  schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } },
  visuals: { themeId: "desert" },
};

test("a seed whose tier-1 plan fails is rejected before it becomes a City", () => {
  assert.throws(() => assertCityPlanPlayable(20261118, DUNES), /planning_outcome_failed/);
});

test("a seed with a usable tier-1 plan passes the preflight", () => {
  assert.doesNotThrow(() => assertCityPlanPlayable(20261117, DUNES));
});

test("malformed seed/profile fails closed", () => {
  assert.throws(() => assertCityPlanPlayable("20261117", DUNES), /planning_outcome_failed/);
  assert.throws(() => assertCityPlanPlayable(20261117, null), /planning_outcome_failed/);
});
