#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const {
  executePlanningWorkerJob, hydratePlanningPlan, planningRequestKey, cityPlanDiskKey,
  createMemoryCityPlanStore, setCityPlanDiskStore, clearCityPlanDiskCache, readCityPlanSnapshot,
  writeCityPlanSnapshot, CITY_PLAN_DISK_CACHE, RADIUS_CALIBRATION_CONFIG,
  PLANNING_WORK_UNITS, buildCityModel, layoutCity, clearCityPlanCache, prepareCityLayout,
  takePreparePlanSource, cityPlanCacheSize, MIAMI_COASTAL, createCityPlan,
} = await loadCity({
  "engine/planningWorker/planningWorkerJob.ts": ["executePlanningWorkerJob"],
  "engine/planningWorker/planningProtocol.ts": ["hydratePlanningPlan", "planningRequestKey"],
  "engine/planningWorker/cityPlanDiskCache.ts": [
    "cityPlanDiskKey", "createMemoryCityPlanStore", "setCityPlanDiskStore", "clearCityPlanDiskCache",
    "readCityPlanSnapshot", "writeCityPlanSnapshot", "CITY_PLAN_DISK_CACHE",
  ],
  "engine/cityPlan.ts": ["RADIUS_CALIBRATION_CONFIG", "createCityPlan"],
  "engine/planner/operationBudget.ts": ["PLANNING_WORK_UNITS"],
  "engine/cityLayout.ts": ["layoutCity", "clearCityPlanCache", "prepareCityLayout", "takePreparePlanSource", "cityPlanCacheSize"],
  "cityModel.ts": ["buildCityModel"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

const parameters = (overrides = {}) => ({
  seed: 4005969553, tier: 1, coastal: { ...MIAMI_COASTAL },
  limits: Object.fromEntries(PLANNING_WORK_UNITS.map(unit => [unit, Number.MAX_SAFE_INTEGER])),
  ...overrides,
});
const model = () => buildCityModel({
  rows: [], findings: [], windowStartMs: 0, windowEndMs: 86400000, windowLabel: "synthetic",
  totalSessions: 0, truncated: false, generatedAt: 1,
});
const shape = (plan) => JSON.parse(JSON.stringify({ ...plan, terrain: undefined, workBudget: undefined }));

const input = parameters();
const response = executePlanningWorkerJob({ version: 1, requestId: "disk", parameters: input });
assert.equal(response.status, "computed");
const snapshot = structuredClone(response.snapshot);
const baseline = createCityPlan(input.seed, input.tier, input.coastal);

assert.match(cityPlanDiskKey(input), new RegExp(`^\\[${CITY_PLAN_DISK_CACHE.version},${RADIUS_CALIBRATION_CONFIG.version},`));
assert.notEqual(cityPlanDiskKey(input), cityPlanDiskKey({ ...input, seed: input.seed + 1 }));
assert.notEqual(cityPlanDiskKey(input), cityPlanDiskKey({ ...input, coastal: { ...input.coastal, boulevardOffset: input.coastal.boulevardOffset + 1 } }));
assert.notEqual(planningRequestKey(input), planningRequestKey({ ...input, tier: 2 }));

const disk = createMemoryCityPlanStore();
setCityPlanDiskStore(disk);
await clearCityPlanDiskCache();
clearCityPlanCache();

await writeCityPlanSnapshot(input, snapshot);
assert.deepEqual(await readCityPlanSnapshot(input), snapshot, "memory disk store round-trips the worker snapshot");
assert.equal(await readCityPlanSnapshot({ ...input, seed: input.seed + 1 }), null, "seed changes must miss");
assert.equal(await readCityPlanSnapshot({ ...input, coastal: { ...input.coastal, version: input.coastal.version + 1 } }), null, "coastal version changes must miss");

{
  const stale = structuredClone(snapshot);
  stale.requestKey = planningRequestKey({ ...input, seed: input.seed + 1 });
  await disk.set(cityPlanDiskKey(input), stale);
  assert.equal(await readCityPlanSnapshot(input), null, "stale requestKey is dropped, not hydrated");
  await writeCityPlanSnapshot(input, snapshot);
}

const hydrated = hydratePlanningPlan(await readCityPlanSnapshot(input), input);
assert.deepEqual(shape(hydrated), shape(baseline), "disk hydrate matches a fresh createCityPlan");
for (const point of [{ x: 0, z: 0 }, ...baseline.coast]) {
  for (const field of ["height", "slope", "buildable"])
    assert.equal(hydrated.terrain[field](point.x, point.z), baseline.terrain[field](point.x, point.z), `${field} from disk`);
}

function fakeWorker() {
  let message;
  const port = { onmessage: null, onerror: null, onmessageerror: null, postMessage: value => { message = value; }, terminate() {} };
  return { port, message: () => message, reply: value => port.onmessage?.({ data: value }) };
}
async function replyWhenPosted(fake, body) {
  for (let i = 0; i < 50; i++) {
    if (fake.message()) { fake.reply({ ...body, requestId: fake.message().requestId }); return; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("planning worker never posted");
}

{
  clearCityPlanCache();
  await writeCityPlanSnapshot(input, snapshot);
  await prepareCityLayout(model(), input.seed, MIAMI_COASTAL, {
    signal: new AbortController().signal,
    workerFactory: () => { throw new Error("disk hit must not start a worker"); },
  });
  assert.equal(takePreparePlanSource(), "disk");
  const layout = layoutCity(model(), null, input.seed, MIAMI_COASTAL);
  assert.equal(layout.seed, input.seed);
  assert.ok(layout.workBudget && layout.workBudget.consumed.terrainSample > 0);
  await prepareCityLayout(model(), input.seed, MIAMI_COASTAL, {
    signal: new AbortController().signal,
    workerFactory: () => { throw new Error("memory hit must not start a worker"); },
  });
  assert.equal(takePreparePlanSource(), "memory");
}

{
  clearCityPlanCache();
  const corrupt = structuredClone(snapshot);
  corrupt.plan.roadEdges[0].from = "missing";
  await writeCityPlanSnapshot(input, corrupt);
  const fake = fakeWorker();
  const pending = prepareCityLayout(model(), input.seed, MIAMI_COASTAL, {
    signal: new AbortController().signal, workerFactory: () => fake.port,
  });
  await replyWhenPosted(fake, response);
  await pending;
  assert.equal(takePreparePlanSource(), "compute", "corrupt disk snapshot falls back to the worker");
  assert.deepEqual(await readCityPlanSnapshot(input), response.snapshot, "successful compute replaces the corrupt entry");
}

{
  clearCityPlanCache();
  await clearCityPlanDiskCache();
  const fake = fakeWorker();
  const pending = prepareCityLayout(model(), input.seed, MIAMI_COASTAL, {
    signal: new AbortController().signal, workerFactory: () => fake.port,
  });
  await replyWhenPosted(fake, response);
  await pending;
  assert.equal(takePreparePlanSource(), "compute");
  assert.ok(await readCityPlanSnapshot(input), "compute persists a snapshot for the next process");
  const size = cityPlanCacheSize();
  clearCityPlanCache();
  assert.equal(cityPlanCacheSize(), 0);
  assert.ok(await readCityPlanSnapshot(input), "clearCityPlanCache must not wipe the restart cache");
  await prepareCityLayout(model(), input.seed, MIAMI_COASTAL, {
    signal: new AbortController().signal,
    workerFactory: () => { throw new Error("second open must read disk"); },
  });
  assert.equal(takePreparePlanSource(), "disk");
  assert.equal(cityPlanCacheSize(), size);
}

{
  await clearCityPlanDiskCache();
  for (let i = 0; i < CITY_PLAN_DISK_CACHE.maxEntries + 2; i++) {
    const extra = parameters({ coastal: { ...MIAMI_COASTAL, version: 100 + i } });
    const extraSnap = structuredClone(snapshot);
    extraSnap.requestKey = planningRequestKey(extra);
    await disk.set(cityPlanDiskKey(extra), extraSnap);
  }
  let kept = 0;
  for (let i = 0; i < CITY_PLAN_DISK_CACHE.maxEntries + 2; i++) {
    if (await readCityPlanSnapshot(parameters({ coastal: { ...MIAMI_COASTAL, version: 100 + i } }))) kept += 1;
  }
  assert.equal(kept, CITY_PLAN_DISK_CACHE.maxEntries, "disk cache has the same entry bound as the in-memory LRU");
}

setCityPlanDiskStore(null);
console.log("City plan disk cache: hydrate equals createCityPlan, seed/coastal/version miss, corrupt fallback, second prepareCityLayout skips the worker, eviction bound holds.");
