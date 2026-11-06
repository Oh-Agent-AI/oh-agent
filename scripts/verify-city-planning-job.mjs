import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker as NodeWorker } from "node:worker_threads";
import { citySrc, loadCity, repo } from "./city-kit/index.mjs";
const { runPlanningJob, executePlanningWorkerJob, hydratePlanningPlan, planningRequestKey, createCityPlan,
  MIAMI_COASTAL, PLANNING_WORK_UNITS, buildCityModel, layoutCity, cityPlanCacheSize, CITY_PLAN_CACHE_CONFIG, prepareCityLayout,
  createPlanningWorkLedger, withPlanningWorkLedger } = await loadCity({
  "engine/planningWorker/planningJob.ts": ["runPlanningJob"],
  "engine/planningWorker/planningWorkerJob.ts": ["executePlanningWorkerJob"],
  "engine/planningWorker/planningProtocol.ts": ["hydratePlanningPlan", "planningRequestKey"],
  "engine/planner/operationBudget.ts": ["PLANNING_WORK_UNITS", "createPlanningWorkLedger", "withPlanningWorkLedger"],
  "engine/cityLayout.ts": ["layoutCity", "cityPlanCacheSize", "CITY_PLAN_CACHE_CONFIG", "prepareCityLayout"], "cityModel.ts": ["buildCityModel"],
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});
const parameters = () => ({ seed: 4005969553, tier: 1, coastal: { ...MIAMI_COASTAL },
  limits: Object.fromEntries(PLANNING_WORK_UNITS.map(unit => [unit, Number.MAX_SAFE_INTEGER])) });
const input = parameters(), response = executePlanningWorkerJob({ version: 1, requestId: "direct", parameters: input });
assert.equal(response.status, "computed");
const snapshot = structuredClone(response.snapshot), hydrated = hydratePlanningPlan(snapshot, input);
const baseline = createCityPlan(input.seed, input.tier, input.coastal);
const shape = plan => JSON.parse(JSON.stringify({ ...plan, terrain: undefined, workBudget: undefined }));
assert.deepEqual(shape(hydrated), shape(baseline), "transport keeps roads, sites, parcels, demands, lineage and outcomes");
for (const point of [{ x: 0, z: 0 }, ...baseline.coast]) {
  for (const field of ["height", "slope", "buildable"])
    assert.equal(hydrated.terrain[field](point.x, point.z), baseline.terrain[field](point.x, point.z), `${field} rehydrates exact geography`);
}
assert.equal(hydrated.terrain.coastRadius(0.73), baseline.terrain.coastRadius(0.73));
assert.throws(() => hydratePlanningPlan(snapshot, { ...input, seed: input.seed + 1 }), /stale/);
assert.throws(() => hydratePlanningPlan({ ...snapshot, plan: { ...snapshot.plan, terrain: { ...snapshot.plan.terrain, radius: 1 } } }, input), /terrain/);
assert.notEqual(planningRequestKey(input), planningRequestKey({ ...input, coastal: { ...input.coastal, boulevardOffset: input.coastal.boulevardOffset + 1 } }));
for (const invalid of [null, {}, { version: 1, requestId: "bad", parameters: { ...input, tier: 1.5 } }])
  assert.equal(executePlanningWorkerJob(invalid).status, "failed");
assert.equal(executePlanningWorkerJob({ version: 1, requestId: "private", parameters: { ...input, model: { prompt: "must-not-be-transferred" } } }).status, "failed");
const missingNode = structuredClone(snapshot); missingNode.plan.roadEdges[0].from = "missing";
assert.throws(() => hydratePlanningPlan(missingNode, input), /network/);
const missingOwner = structuredClone(snapshot); missingOwner.plan.publicSites = missingOwner.plan.publicSites.filter(owner => owner.id !== "central-station");
assert.throws(() => hydratePlanningPlan(missingOwner, input), /owner/);
const changedVersion = structuredClone(snapshot); changedVersion.plan.derivedNetworkVersion += 1;
assert.throws(() => hydratePlanningPlan(changedVersion, input), /version/);
const changedCoast = structuredClone(snapshot); changedCoast.plan.coast[0].x += 1;
assert.throws(() => hydratePlanningPlan(changedCoast, input), /geography/);
const exhausted = executePlanningWorkerJob({ version: 1, requestId: "budget", parameters: { ...input,
  limits: { ...input.limits, terrainSample: 0 } } });
assert.equal(exhausted.status, "failed"); assert.equal(exhausted.stop.status, "budget-exhausted");
assert.equal(exhausted.snapshot, undefined, "an exhausted worker sends no partial map");

function fakeWorker() {
  let message, terminated = 0;
  const port = { onmessage: null, onerror: null, onmessageerror: null, postMessage: value => { message = value; },
    terminate: () => { terminated += 1; } };
  return { port, message: () => message, terminated: () => terminated,
    reply: value => port.onmessage?.({ data: value }) };
}
{
  const fake = fakeWorker(), abort = new AbortController(), original = parameters();
  const pending = runPlanningJob(original, { signal: abort.signal, workerFactory: () => fake.port });
  original.limits.candidate = 0; original.coastal.boulevardOffset += 99;
  fake.reply({ ...response, requestId: fake.message().requestId });
  const result = await pending;
  assert.equal(result.status, "computed", "captured request cannot change while its worker runs");
  assert.equal(fake.terminated(), 1);
}
{
  const fake = fakeWorker(), abort = new AbortController();
  const pending = runPlanningJob(input, { signal: abort.signal, workerFactory: () => fake.port });
  const queuedHandler = fake.port.onmessage, requestId = fake.message().requestId;
  abort.abort(); queuedHandler({ data: { ...response, requestId } });
  assert.equal((await pending).status, "cancelled", "a queued stale completion cannot win after cancellation");
  assert.equal(fake.terminated(), 1); assert.equal(fake.port.onmessage, null);
}
{
  const fake = fakeWorker(), abort = new AbortController();
  const pending = runPlanningJob(input, { signal: abort.signal, workerFactory: () => fake.port });
  fake.reply({ ...response, requestId: "wrong-request" });
  assert.equal((await pending).reason, "stale-planning-worker-response");
  assert.equal(fake.terminated(), 1);
  const unavailable = await runPlanningJob(input, { signal: abort.signal, workerFactory: () => { throw new Error("unavailable"); } });
  assert.equal(unavailable.status, "unsupported", "no synchronous fallback hides worker unavailability");
  let launched = false;
  const privateInput = await runPlanningJob({ ...input, model: { prompt: "must-not-be-transferred" } }, {
    signal: abort.signal, workerFactory: () => { launched = true; return fake.port; },
  });
  assert.equal(privateInput.status, "failed"); assert.equal(launched, false);
}

// Execute the real browser worker entry in an isolated Node worker realm, not
// an in-process fake. The bridge substitutes only its message transport.
const { buildSync } = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"))("esbuild");
const entry = `import { parentPort } from "node:worker_threads";
globalThis.postMessage = value => parentPort.postMessage(value);
parentPort.on("message", data => globalThis.onmessage({ data }));
import ${JSON.stringify(path.join(citySrc, "engine/planningWorker/planning.worker.ts"))};`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "city-planning-worker-")), file = path.join(directory, "worker.cjs");
fs.writeFileSync(file, buildSync({ stdin: { contents: entry, resolveDir: citySrc }, bundle: true, format: "cjs",
  platform: "node", write: false, logLevel: "silent" }).outputFiles[0].text);
let active = 0; const terminations = [], workers = [];
const workerFactory = () => {
  const worker = new NodeWorker(file); workers.push(worker); active += 1;
  const port = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: data => worker.postMessage(data), terminate: () => { active -= 1; terminations.push(worker.terminate()); } };
  worker.on("message", data => port.onmessage?.({ data }));
  worker.on("error", () => port.onerror?.({ preventDefault: () => {} }));
  worker.on("messageerror", () => port.onmessageerror?.());
  return port;
};
{
  let pulses = 0; const interval = setInterval(() => { pulses += 1; }, 10);
  try {
    const result = await runPlanningJob(input, { signal: new AbortController().signal, workerFactory });
    assert.equal(result.status, "computed"); assert.deepEqual(shape(result.plan), shape(baseline));
    assert(pulses > 1, "the receiving event loop stays responsive during real generation");
  } finally { clearInterval(interval); }
  assert.equal(active, 0);
}
{
  const abort = new AbortController(), pending = runPlanningJob(input, { signal: abort.signal, workerFactory });
  const timer = setTimeout(() => abort.abort(), 50);
  try { assert.equal((await pending).status, "cancelled"); } finally { clearTimeout(timer); }
  assert.equal(active, 0, "real cancelled worker is terminated");
}
{
  const model = buildCityModel({ rows: [], findings: [], windowStartMs: 0, windowEndMs: 86400000, windowLabel: "synthetic", totalSessions: 0, truncated: false, generatedAt: 1 });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(prepareCityLayout(model, input.seed, MIAMI_COASTAL, { signal: cancelled.signal, workerFactory }), /cancelled/);
  const count = workers.length; let pulses = 0;
  const interval = setInterval(() => pulses++, 10);
  try {
    await prepareCityLayout(model, input.seed, MIAMI_COASTAL, { signal: new AbortController().signal, workerFactory });
  } finally { clearInterval(interval); }
  assert.ok(pulses > 1, "actual layout preparation keeps the host heartbeat responsive");
  assert.equal(workers.length, count + 1);
  await prepareCityLayout(model, input.seed, MIAMI_COASTAL, { signal: new AbortController().signal,
    workerFactory: () => { throw new Error("cache missed"); } });
  const layout = layoutCity(model, null, input.seed, MIAMI_COASTAL);
  assert.ok(layout.workBudget && layout.workBudget.consumed.terrainSample > 0,
    "real layout consumes the verified worker plan and its work receipt");
  assert.equal(active, 0);
}
await Promise.all(terminations);
assert(workers.every(worker => worker.threadId === -1), "both workers actually exited, not merely received a stop request");
{
  const model = buildCityModel({ rows: [], findings: [], windowStartMs: 0, windowEndMs: 86400000, windowLabel: "synthetic", totalSessions: 0, truncated: false, generatedAt: 1 });
  const coast1 = { ...MIAMI_COASTAL }, coast2 = { ...MIAMI_COASTAL, boulevardOffset: MIAMI_COASTAL.boulevardOffset + 1 };
  layoutCity(model, null, input.seed, coast1); const size = cityPlanCacheSize();
  layoutCity(model, null, input.seed, coast2);
  assert.equal(cityPlanCacheSize(), size + 1, "boulevard parameter changes cannot reuse a stale cached plan");
  for (let i = 0; i < CITY_PLAN_CACHE_CONFIG.maxEntries + 2; i++)
    layoutCity(model, null, input.seed, { ...MIAMI_COASTAL, version: i + 10 });
  assert.equal(cityPlanCacheSize(), CITY_PLAN_CACHE_CONFIG.maxEntries, "production plan cache has a fixed entry bound");
  const before = cityPlanCacheSize(), ledger = createPlanningWorkLedger({ ...input.limits, terrainSample: 0 });
  assert.throws(() => withPlanningWorkLedger(ledger, () => layoutCity(model, null, input.seed + 1, MIAMI_COASTAL)), /budget-exhausted/);
  assert.equal(cityPlanCacheSize(), before, "interrupted planning does not insert a cache entry");
}
console.log("City planning job: real isolated worker, responsive receiver, verified termination/stale-result refusal, exact terrain hydration, finite operation budgets and complete snapshot transport pass; UI layout prewarming/cache/cancellation pass; native WKWebView acceptance remains pending.");
