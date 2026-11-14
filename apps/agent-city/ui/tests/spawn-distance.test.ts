import test from "node:test";
import assert from "node:assert/strict";
import { spawnDistanceFailure } from "../src/game/runtime/spawnDistance.ts";

test("spawn validation distinguishes missing pose from an unsafe distant pose", () => {
  const expected = { x: 100, z: 200 };
  assert.equal(spawnDistanceFailure(null, expected), "unavailable");
  assert.equal(spawnDistanceFailure({ x: NaN, z: 200 }, expected), "unavailable");
  assert.equal(spawnDistanceFailure({ x: 140, z: 200 }, expected), null);
  assert.equal(spawnDistanceFailure({ x: 141, z: 200 }, expected), "too-far");
});
