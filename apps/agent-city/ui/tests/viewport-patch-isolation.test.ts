import test from "node:test";
import assert from "node:assert/strict";
import { selectViewportPatch } from "../src/viewport/viewportPatch.ts";
import { emptyPlanPatch, hashPlanPatch, type PlanPatchV1 } from "../src/engine/planPatch.ts";

test("an independent City never inherits a legacy patch even when the seed matches", () => {
  const legacy = { seed: 42, updatedAt: 7 } as PlanPatchV1;
  const project = { seed: 42, updatedAt: 9 } as PlanPatchV1;
  assert.equal(selectViewportPatch(true, 42, legacy, project), null);
  assert.equal(selectViewportPatch(false, 42, legacy, project), project);
  assert.equal(selectViewportPatch(false, 43, legacy, project), null);
});

test("independent project uses only its explicit scoped patch, never the legacy store", () => {
  const legacy = { ...emptyPlanPatch(42, 2), updatedAt: 100 };
  const scoped = { ...emptyPlanPatch(42, 2), updatedAt: 1, roadOps: [{ t: "add" as const, from: { x: 0, z: 0 }, to: { x: 10, z: 0 }, width: 8 }] };
  assert.equal(selectViewportPatch(true, 42, legacy, legacy, scoped), scoped);
  assert.equal(selectViewportPatch(true, 43, legacy, legacy, scoped), null);
  assert.equal(selectViewportPatch(true, 42, legacy, legacy), null);
  const changed = { ...scoped, roadOps: [{ ...scoped.roadOps[0]!, to: { x: 20, z: 0 } }] };
  assert.notEqual(hashPlanPatch(scoped), hashPlanPatch(changed), "same count and timestamp must not hide a changed road");
});
