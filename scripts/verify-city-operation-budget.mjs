import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { PLANNING_WORK_UNITS, createPlanningWorkLedger, PlanningInterrupted, withPlanningWorkLedger, spendPlanningWork,
  createCityPlan, MIAMI_COASTAL, emptyNetwork, addNetworkEdge, commitNetworkPatch, runConnection, inspectModelGround } = await loadCity({
  "engine/planner/operationBudget.ts": ["PLANNING_WORK_UNITS", "createPlanningWorkLedger", "PlanningInterrupted", "withPlanningWorkLedger", "spendPlanningWork"],
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge", "commitNetworkPatch"],
  "engine/planner/connect.ts": ["runConnection"], "engine/planner/modelGround.ts": ["inspectModelGround"],
});
const limits = maximum => Object.fromEntries(PLANNING_WORK_UNITS.map(unit => [unit, maximum]));
{
  const input = limits(3), ledger = createPlanningWorkLedger(input);
  input.candidate = 100;
  ledger.spend("request:1", { candidate: 1, cloneRow: 2 });
  const first = ledger.snapshot();
  ledger.spend("rejected-draft", { candidate: 1 });
  ledger.spend("radius-retry", { candidate: 1, radiusAttempt: 1 });
  assert.equal(first.consumed.candidate, 1, "snapshots do not change with later work");
  assert.equal(ledger.snapshot().consumed.candidate, 3, "rejection and retry share cumulative accounting");
  assert.throws(() => { first.consumed.candidate = 0; }, TypeError);
  assert.throws(() => { first.limits.candidate = 100; }, TypeError);
  assert.throws(() => ledger.spend("next-request", { candidate: 1, terrainSample: 2 }), error =>
    error instanceof PlanningInterrupted && error.detail.status === "budget-exhausted" && error.detail.unit === "candidate");
  assert.equal(ledger.snapshot().consumed.terrainSample, 0, "failed multi-charge is atomic");
  assert.throws(() => ledger.check("final-publication"), PlanningInterrupted, "exhaustion remains terminal");
}
{
  let cancelled = false;
  const ledger = createPlanningWorkLedger(limits(5), () => cancelled);
  ledger.spend("first-draft", { transaction: 1 }); cancelled = true;
  assert.throws(() => ledger.check("publish"), error => error.detail?.status === "cancelled");
  cancelled = false;
  assert.throws(() => ledger.spend("retry-after-cancellation", {}), PlanningInterrupted);
  assert.equal(ledger.snapshot().consumed.transaction, 1);
}
{
  const run = charge => {
    const ledger = createPlanningWorkLedger(limits(0));
    try { ledger.spend("same-stage", charge); } catch (error) { return error.detail; }
  };
  assert.deepEqual(run({ terrainSample: 1, candidate: 1 }), run({ candidate: 1, terrainSample: 1 }));
  const ledger = createPlanningWorkLedger(limits(2));
  for (const charge of [{ candidate: NaN }, { candidate: -1 }, { candidate: 0.1 }, { unknown: 1 }, [], Object.create({ candidate: -1 })])
    assert.throws(() => ledger.spend("invalid", charge), /invalid-planning-work-charge/);
  assert.equal(ledger.snapshot().consumed.candidate, 0);
  let reads = 0;
  ledger.spend("getter-snapshot", { get candidate() { reads += 1; return reads === 1 ? 1 : -1; } });
  assert.equal(reads, 1, "input accessors are read once before mutation");
  assert.equal(ledger.snapshot().consumed.candidate, 1);
  assert.throws(() => createPlanningWorkLedger({}), /invalid-planning-work-limits/);
  assert.throws(() => createPlanningWorkLedger(limits(Infinity)), /invalid-planning-work-limits/);
  const huge = createPlanningWorkLedger(limits(Number.MAX_SAFE_INTEGER));
  huge.spend("all", { expandedState: Number.MAX_SAFE_INTEGER });
  assert.throws(() => huge.spend("overflow", { expandedState: 1 }), PlanningInterrupted);
}
{
  const ledger = createPlanningWorkLedger(limits(2));
  withPlanningWorkLedger(ledger, () => {
    spendPlanningWork("outer", { candidate: 1 });
    withPlanningWorkLedger(ledger, () => spendPlanningWork("inner", { candidate: 1 }));
    assert.throws(() => withPlanningWorkLedger(createPlanningWorkLedger(limits(100)), () => 1), /replacement-refused/);
  });
  assert.equal(ledger.snapshot().consumed.candidate, 2);
  assert.throws(() => withPlanningWorkLedger(ledger, () => Promise.resolve(1)), /async-planning-work-scope-unsupported/);
}
{
  const ledger = createPlanningWorkLedger({ ...limits(100), radiusAttempt: 0 });
  let published;
  assert.throws(() => { published = createCityPlan(4005969553, 1, MIAMI_COASTAL, { workLedger: ledger }); },
    error => error instanceof PlanningInterrupted && error.detail.unit === "radiusAttempt");
  assert.equal(published, undefined, "an exhausted job does not return a partial plan");
  const terrainLedger = createPlanningWorkLedger({ ...limits(100), terrainSample: 0 });
  assert.throws(() => createCityPlan(4005969553, 1, MIAMI_COASTAL, { workLedger: terrainLedger }),
    error => error.detail?.unit === "terrainSample");
  const cancelled = createPlanningWorkLedger(limits(100), () => true);
  assert.throws(() => createCityPlan(1, 1, MIAMI_COASTAL, { workLedger: cancelled }), error => error.detail?.status === "cancelled");
  const retryLedger = createPlanningWorkLedger({ ...limits(Number.MAX_SAFE_INTEGER), radiusAttempt: 1 });
  assert.throws(() => createCityPlan(4001256748, 1, MIAMI_COASTAL, { workLedger: retryLedger }),
    error => error.detail?.unit === "radiusAttempt" && error.detail.consumed === 1);
  assert(retryLedger.snapshot().consumed.terrainSample > 0, "the next radius attempt cannot reset work from the first draft");
  let delayed;
  delayed = createPlanningWorkLedger(limits(Number.MAX_SAFE_INTEGER), () => delayed.snapshot().consumed.terrainSample >= 4);
  assert.throws(() => createCityPlan(1, 1, MIAMI_COASTAL, { workLedger: delayed }), error => error.detail?.status === "cancelled");
  assert.equal(delayed.snapshot().consumed.terrainSample, 4, "cancellation is observed inside generation, not only on return");
}
{
  const ledger = createPlanningWorkLedger({ ...limits(100), terrainSample: 0 });
  assert.throws(() => withPlanningWorkLedger(ledger, () => inspectModelGround({ id: "villa", kind: "villa-complex", x: 0, z: 0, yaw: 0, radius: 34 }, {
    height: () => { spendPlanningWork("ground:probe", { terrainSample: 1 }); return 1.2; }, inRiver: () => false,
  })), error => error instanceof PlanningInterrupted, "foundation inspection cannot turn a terminal stop into unsupported and continue");
  const foreign = await loadCity({ "engine/planner/operationBudget.ts": ["createPlanningWorkLedger"] });
  assert.notEqual(foreign.createPlanningWorkLedger, createPlanningWorkLedger);
  const foreignLedger = foreign.createPlanningWorkLedger({ ...limits(100), terrainSample: 0 });
  assert.throws(() => withPlanningWorkLedger(foreignLedger, () => inspectModelGround({ id: "villa", kind: "villa-complex", x: 0, z: 0, yaw: 0, radius: 34 }, {
    height: () => { spendPlanningWork("foreign-ground:probe", { terrainSample: 1 }); return 1.2; }, inRiver: () => false,
  })), error => error.code === "city-planning-interrupted" && error.detail?.unit === "terrainSample",
  "a terminal error from another bundle must propagate instead of becoming unsupported");
}
{
  const network = emptyNetwork(); addNetworkEdge(network, { x: -50, z: 20 }, { x: 50, z: 20 }, true);
  const ledger = createPlanningWorkLedger(limits(Number.MAX_SAFE_INTEGER));
  const result = withPlanningWorkLedger(ledger, () => runConnection({ id: "metered-grid", source: { x: 0, z: 0 },
    target: { kind: "primary", isPrimaryNode: () => true }, purpose: "site-access", allowBridge: false,
    maxLength: 80, roadClass: "local", minAngleDeg: 35 }, { network,
    geo: { height: () => 1.2, buildable: () => true, terrain: { slope: () => 0 } }, inRiver: () => false, reservations: () => [],
  }, { strategies: ["grid-astar"] }));
  assert.equal(result.ok, true);
  assert(ledger.snapshot().consumed.expandedState > 0, "real A* expansions spend the job ledger");
}
{
  const network = emptyNetwork(); addNetworkEdge(network, { x: 0, z: 0 }, { x: 20, z: 0 }, false);
  const before = JSON.stringify({ nodes: [...network.nodes], edges: [...network.edges] });
  let cancelled = false;
  const ledger = createPlanningWorkLedger(limits(100), () => cancelled);
  assert.throws(() => withPlanningWorkLedger(ledger, () => commitNetworkPatch(network,
    { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [] }, () => { cancelled = true; return null; })), error => error.detail?.status === "cancelled");
  assert.equal(JSON.stringify({ nodes: [...network.nodes], edges: [...network.edges] }), before,
    "cancellation during validation publishes no graph patch");
}
{
  const seed = 4005969553, ledger = createPlanningWorkLedger(limits(Number.MAX_SAFE_INTEGER));
  const started = performance.now(), baseline = createCityPlan(seed, 1, MIAMI_COASTAL), baselineMs = performance.now() - started;
  const began = performance.now(), metered = createCityPlan(seed, 1, MIAMI_COASTAL, { workLedger: ledger }), meteredMs = performance.now() - began;
  assert.deepEqual(JSON.parse(JSON.stringify({ ...metered, workBudget: undefined })),
    JSON.parse(JSON.stringify({ ...baseline, workBudget: undefined })));
  for (const point of [{ x: 0, z: 0 }, ...baseline.coast.slice(0, 5)])
    assert.equal(metered.terrain.height(point.x, point.z), baseline.terrain.height(point.x, point.z));
  assert.equal(metered.workBudget.consumed.radiusAttempt, metered.radiusAttempts + 1);
  for (const unit of ["candidate", "terrainSample", "cloneRow", "transaction", "derivedRow"])
    assert(metered.workBudget.consumed[unit] > 0, `${unit} must be charged by real production work`);
  const secondStarted = ledger.snapshot().consumed.radiusAttempt;
  createCityPlan(seed, 1, MIAMI_COASTAL, { workLedger: ledger });
  assert(ledger.snapshot().consumed.radiusAttempt > secondStarted, "a reused ledger cannot reset between requests");
  console.log(JSON.stringify({ scope: "single named production accounting sample, not default-limit calibration", seed,
    baselineMs: Math.round(baselineMs), meteredMs: Math.round(meteredMs), consumed: metered.workBudget.consumed }));
}
console.log("City operation budget: production opt-in scope, retries, terrain/candidate/search/clone/patch/parcel accounting and interruption/publication guards pass; measured defaults, complete write-entry coverage and asynchronous UI cancellation remain pending.");
