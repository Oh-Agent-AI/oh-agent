#!/usr/bin/env node
// Occupancy layout cost: profiled 2026-10-22 before this change (Node, seed 1927, Miami, 500 of 4000):
//   first layoutCity (uncached plan) 36629ms — createCityPlan 34086ms, occupancy ~2.5s
//   later pages with previous: 3625ms / 3530ms (airport ~1.5s, landmarks ~0.7s, civics ~0.55s)
// This script re-measures after the occupancy incremental path and checks determinism /
// parcel equivalence. Geography planning (createCityPlan for Miami tier 10) is a separate
// floor: one buildPlan, ~34s in this harness; production warms it on a worker via
// prepareCityLayout, which now also warms occupancy scratch (hotel lots, road index,
// compiled landmark triangles) so the first layoutCity after that cache hit is occupancy-only.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { loadCity } from "./city-kit/index.mjs";
import { sceneRows, GENERATED_AT } from "./city-kit/scene-parts.mjs";

const {
  buildCityModel, layoutCity, takeLayoutTimings, clearCityPlanCache, ensureCityPlan, scaleTierFor, MIAMI_COASTAL,
} = await loadCity({
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity", "takeLayoutTimings", "clearCityPlanCache", "ensureCityPlan"],
  "engine/scaleTier.ts": ["scaleTierFor"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

const SEED = 1927;
const WINDOW = { windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", truncated: false, generatedAt: GENERATED_AT };
const BEFORE = {
  firstUncachedMs: 36629,
  createCityPlanMs: 34086,
  occupancyAfterWarmMs: 2543,
  page1000Ms: 3625,
  page1500Ms: 3530,
};

const modelFor = (count, planned) => buildCityModel({ rows: sceneRows(count), findings: [], ...WINDOW, totalSessions: planned });
const round = (t) => t && ({ wallMs: Math.round(t.wallMs), planCached: t.planCached, phases: Object.fromEntries(Object.entries(t.phases).map(([k, v]) => [k, Math.round(v)])) });
const slotsOf = (layout) => Object.fromEntries(layout.districts.flatMap((district) => [...district.slots].map(([id, p]) => [id, `${p.id}|${p.x}|${p.z}|${p.yaw}|${p.width}|${p.mergedWith ?? ""}`])));
const fingerprint = (layout) => JSON.stringify({
  scaleTier: layout.scaleTier,
  islandRadius: layout.islandRadius,
  slots: slotsOf(layout),
  gardens: layout.gardens.map((g) => `${g.id}:${g.blockId}:${g.x}:${g.z}:${g.yaw}`).sort(),
  civics: layout.civics.map((c) => `${c.id}:${c.parcelId}:${c.x}:${c.z}:${c.yaw}:${c.width}:${c.depth}`).sort(),
  districtLandmarks: (layout.districtLandmarks ?? []).map((l) => `${l.districtId}:${l.parcelId}:${l.x}:${l.z}`).sort(),
  airport: layout.airport?.causeway ? `${layout.airport.causeway.fromNode}->${layout.airport.causeway.to.x}:${layout.airport.causeway.to.z}` : null,
  context: layout.contextBuildings.map((b) => b.id).sort(),
});

function timeLayout(model, previous) {
  const t0 = performance.now();
  const layout = layoutCity(model, previous, SEED, MIAMI_COASTAL);
  return { layout, wallMs: performance.now() - t0, timings: round(takeLayoutTimings()) };
}

// ── Determinism: same input twice, including a warm-plan occupancy pass. ──
{
  clearCityPlanCache();
  const small = modelFor(80, 80);
  const a = timeLayout(small, null);
  const b = timeLayout(small, null);
  assert.equal(fingerprint(a.layout), fingerprint(b.layout), "layoutCity must be deterministic for the same input");
  const c = timeLayout(small, a.layout);
  assert.equal(fingerprint(c.layout), fingerprint(a.layout), "re-layout with previous of the same occupants must not move anyone");
  console.log(`determinism 80: ok (${Math.round(a.wallMs)}ms / ${Math.round(b.wallMs)}ms occupancy-cached)`);
}

// ── Equivalence: later pages keep first-page parcels; two incremental runs match. ──
clearCityPlanCache();
const planned = 4000;
const page = 500;
const firstModel = modelFor(page, planned);
const tPlan = performance.now();
ensureCityPlan(SEED, scaleTierFor(planned), MIAMI_COASTAL);
const planAndWarmMs = Math.round(performance.now() - tPlan);
const first = timeLayout(firstModel, null);
assert.equal(first.timings?.planCached, true, "ensureCityPlan must land the geography LRU before first occupancy");
const firstSlots = slotsOf(first.layout);
assert.equal(first.layout.scaleTier, scaleTierFor(planned));

const page1000 = timeLayout(modelFor(1000, planned), first.layout);
const page1000b = timeLayout(modelFor(1000, planned), first.layout);
assert.equal(fingerprint(page1000.layout), fingerprint(page1000b.layout), "incremental layout of the same page must match");
const laterSlots = slotsOf(page1000.layout);
let kept = 0;
for (const id of Object.keys(firstSlots)) {
  assert.equal(laterSlots[id], firstSlots[id], `existing parcel moved for ${id}`);
  kept += 1;
}
assert.equal(kept, Object.keys(firstSlots).length);
const page1500 = timeLayout(modelFor(1500, planned), page1000.layout);
const later1500 = slotsOf(page1500.layout);
for (const id of Object.keys(laterSlots)) assert.equal(later1500[id], laterSlots[id], `page-1500 moved ${id}`);

const after = {
  planAndWarmMs,
  occupancyAfterPlanWarmMs: Math.round(first.wallMs),
  occupancyAfterPlanWarm: first.timings,
  page1000Ms: Math.round(page1000.wallMs),
  page1000: page1000.timings,
  page1500Ms: Math.round(page1500.wallMs),
  page1500: page1500.timings,
  firstPageParcelsKept: kept,
};

const ratio = (before, now) => before > 0 ? Number((now / before).toFixed(3)) : null;
console.log(JSON.stringify({
  before: BEFORE,
  after,
  speedup: {
    occupancyAfterPlanWarm: ratio(BEFORE.occupancyAfterWarmMs, after.occupancyAfterPlanWarmMs),
    page1000: ratio(BEFORE.page1000Ms, after.page1000Ms),
    page1500: ratio(BEFORE.page1500Ms, after.page1500Ms),
  },
  floor: {
    planAndWarmMs,
    note: "Uncached geography is one Miami tier-10 createCityPlan (~34s, ~6800 parcels / ~3200 roads) plus occupancy-scratch warm (hotel lots, road index, compiled landmark triangles). Production runs that on prepareCityLayout's worker. occupancyAfterPlanWarm is the first-page number after that cache hit. Later pages still grow the displayed network for newly live blocks, place extra civics, re-rank backdrop, and assign the new page of sessions — tens of ms would require skipping grow/context, which changes the displayed city.",
  },
}, null, 2));

assert.ok(after.occupancyAfterPlanWarmMs < 1000, `first occupancy after plan+scratch warm should be well under 1s (got ${after.occupancyAfterPlanWarmMs}ms)`);
assert.ok(after.page1000Ms < BEFORE.page1000Ms * 0.5, `later-page layout should be dramatically faster than ${BEFORE.page1000Ms}ms (got ${after.page1000Ms}ms)`);
assert.ok(after.page1500Ms < BEFORE.page1500Ms * 0.5, `later-page layout should be dramatically faster than ${BEFORE.page1500Ms}ms (got ${after.page1500Ms}ms)`);
console.log("bench-react-city-layout: ok");
