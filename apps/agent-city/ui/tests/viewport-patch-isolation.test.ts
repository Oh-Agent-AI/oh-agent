import test from "node:test";
import assert from "node:assert/strict";
import { selectViewportPatch } from "../src/viewport/viewportPatch.ts";
import type { PlanPatchV1 } from "../src/engine/planPatch.ts";

test("an independent City never inherits a legacy patch even when the seed matches", () => {
  const legacy = { seed: 42, updatedAt: 7 } as PlanPatchV1;
  const project = { seed: 42, updatedAt: 9 } as PlanPatchV1;
  assert.equal(selectViewportPatch(true, 42, legacy, project), null);
  assert.equal(selectViewportPatch(false, 42, legacy, project), project);
  assert.equal(selectViewportPatch(false, 43, legacy, project), null);
});
