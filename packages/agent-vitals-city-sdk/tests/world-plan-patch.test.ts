import test from "node:test";
import assert from "node:assert/strict";
import { validateWorldPlanPatch } from "../src/worldPlanPatch";

const patch = () => ({ version: 1, seed: 42, scaleTier: 2, generatorVersion: 6, updatedAt: 10,
  roadOps: [{ t: "add", from: { x: 0, z: 0 }, to: { x: 25, z: 0 }, width: 8 }],
  siteOps: [{ t: "move", id: "site:gate", to: "parcel:1", at: { x: 3, z: 4 } }], buildingMoves: {}, suppressedContext: [],
  terrainOps: [{ t: "pad", at: { x: 5, z: 5 }, radius: 10, falloff: 4, height: 2 }] });

test("portable world patch retains roads, static sites and terrain with pinned seed/version", () => {
  const input = patch(); const result = validateWorldPlanPatch(input, 42, 6);
  assert.equal(result.ok, true); if (result.ok) assert.deepEqual(result.value.roadOps, input.roadOps);
  assert.equal(validateWorldPlanPatch(input, 43, 6).ok, false);
  assert.equal(validateWorldPlanPatch(input, 42, 5).ok, false);
  const malformed = patch(); malformed.roadOps[0]!.width = 0;
  assert.equal(validateWorldPlanPatch(malformed, 42, 6).ok, false);
  const privateMoves = { ...patch(), buildingMoves: { "session:abc": "parcel:1" } };
  const denied = validateWorldPlanPatch(privateMoves, 42, 6);
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.diagnostics[0]?.code, "world_patch_private_buildings");
});
