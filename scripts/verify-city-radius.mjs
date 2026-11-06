#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { nextCalibrationRadius, RADIUS_CALIBRATION_CONFIG, targetParcels } = await loadCity({
  "engine/cityPlan.ts": ["nextCalibrationRadius", "RADIUS_CALIBRATION_CONFIG", "targetParcels"],
});
for (const tier of [1, 2, 5, 10]) for (const available of [0, 1, 5, 100, targetParcels(tier) - 1]) {
  let radius = 390 * Math.sqrt(tier);
  const initial = radius;
  for (let i = 0; i < RADIUS_CALIBRATION_CONFIG.maxRetries; i += 1) {
    const next = nextCalibrationRadius(radius, targetParcels(tier), available);
    assert.ok(next > radius && Number.isFinite(next));
    assert.ok((next / radius) ** 2 <= RADIUS_CALIBRATION_CONFIG.maxAreaGrowth + 1e-9,
      "low capacity cannot trigger a giant area expansion");
    assert.equal(nextCalibrationRadius(radius, targetParcels(tier), available), next);
    radius = next;
  }
  assert.ok(radius <= initial * RADIUS_CALIBRATION_CONFIG.maxAreaGrowth ** (RADIUS_CALIBRATION_CONFIG.maxRetries / 2) + 1e-8);
}
assert.equal(nextCalibrationRadius(390, 540, 540), 390);
assert.equal(nextCalibrationRadius(390, 540, 1000), 390);
for (const args of [[0, 540, 0], [NaN, 540, 1], [390, Infinity, 1], [390, 540, -1]])
  assert.throws(() => nextCalibrationRadius(...args), RangeError);
console.log("City radius: bounded area growth at zero/near-zero capacity, unchanged satisfied radius, original retry budget, deterministic finite calibration.");
