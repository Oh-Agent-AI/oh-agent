import test from "node:test";
import assert from "node:assert/strict";
import { validateWorldPlanPatch } from "@agent-vitals/city-sdk";
import { buildCityModel } from "../src/cityModel.ts";
import { layoutCityForWorld } from "../src/engine/cityLayout.ts";
import { ARID_DUNES_CITY_WORLD_V1, MIAMI_CITY_WORLD_V1 } from "../src/engine/cityWorldProfile.ts";
import { applyPlanPatch, emptyPlanPatch } from "../src/engine/planPatch.ts";
import { selectViewportPatch } from "../src/viewport/viewportPatch.ts";

test("a scoped desert project patch replays on its own generated layout without altering Miami", () => {
  const model = buildCityModel({ harnessNames: {}, rows: [], findings: [], windowStartMs: 0, windowEndMs: 1,
    windowLabel: "独立空城", totalSessions: 0, truncated: false, generatedAt: 0 });
  const desert = layoutCityForWorld(model, null, 42, ARID_DUNES_CITY_WORLD_V1, "off");
  const miami = layoutCityForWorld(model, null, 42, MIAMI_CITY_WORLD_V1, "off");
  const miamiEdges = miami.roadEdges.map(edge => edge.id);
  let applied = false;
  for (const edge of desert.roadEdges) {
    const patch = { ...emptyPlanPatch(42, desert.scaleTier), roadOps: [{ t: "drop" as const, edge: edge.id }] };
    const checked = validateWorldPlanPatch(patch, 42, patch.generatorVersion!);
    assert.equal(checked.ok, true);
    const chosen = selectViewportPatch(true, 42, patch, patch, patch);
    assert.ok(chosen);
    const result = applyPlanPatch(desert, chosen);
    if (result.stale.length === 0 && !result.layout.roadEdges.some(candidate => candidate.id === edge.id)) {
      applied = true; break;
    }
  }
  assert.ok(applied, "at least one unlocked road edit must replay");
  assert.deepEqual(miami.roadEdges.map(edge => edge.id), miamiEdges);
  assert.equal(selectViewportPatch(true, 42, emptyPlanPatch(42, miami.scaleTier), null), null);
});
