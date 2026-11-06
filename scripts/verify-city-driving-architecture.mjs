#!/usr/bin/env node
// Executable handoff contracts: same-kernel trials, no false greens, cancellation/staleness.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const load = (file) => {
  const code = buildSync({ entryPoints: [new URL(`../apps/agent-city/ui/src/game/${file}.ts`, import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles[0].text;
  const mod = { exports: {} }; vm.runInNewContext(code, { module: mod, exports: mod.exports, console }); return mod.exports;
};
const { DrivingKernel } = load("driving/DrivingKernel");
const { DrivingRouteRunner } = load("driving/audit/DrivingRouteRunner");
const { GateAuditObserver } = load("driving/audit/GateAuditObserver");
const { evaluateAuditRelease } = load("driving/audit/AuditReleasePolicy");
const { scheduleAudit } = load("driving/audit/AuditScheduler");
const { auditKeyId, validateManifest } = load("driving/audit/AuditIdentity");
const { FixedStepClock } = load("runtime/FixedStepClock");
const { DrivingWorld } = load("DrivingWorld");
const { initialDrivingState, stepDriving, DRIVING_DT } = load("DrivingSimulation");
const key = { baseSnapshotHash: "synthetic-plane-v1", vehicleConfigHash: "car-v1", kernelBuildId: "fixture-build-v1",
  surfaceVersion: 1, queryVersion: 1, snapshotCompilerVersion: 1, physicsVersion: 1, collisionVersion: 1,
  controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "straight-v1", releasePolicyVersion: 1, releaseBoundaryHash: "fixture-final-boundaries" };
const world = new DrivingWorld([{ id: "pad", layer: "ground", minX: -100, maxX: 100, minZ: -10, maxZ: 10, base: 0, slopeX: 0, slopeZ: 0, connections: [] }], []);
const kernel = new DrivingKernel(world, key);
const forward = { forward: true, backward: false, left: false, right: false };
const idle = { forward: false, backward: false, left: false, right: false };
const test = { id: "spawn-to-edge", units: ["edge-forward", "spawn"], start: initialDrivingState(),
  corridor: { surfaceSequence: ["pad"], portalSequence: [], waypoints: [{ x: 0, z: 0 }, { x: 5, z: 0 }] }, policy: { cruiseSpeed: 7, maxReverseSpeed: 4 },
  gates: [{ id: "exit", x: 3, y: 0, z: 0, forwardX: 1, forwardZ: 0, halfWidth: 2, heightTolerance: 0.1, surfaceIds: ["pad"] }], maxTicks: 300, maxNoProgressTicks: 90 };
const manifest = { key, units: [{ id: "edge-forward", kind: "directed-edge" }, { id: "spawn", kind: "spawn-access" }], exclusions: [], cases: [test] };
// Explicit synthetic validator; a production always-valid validator is forbidden.
const validator = { validateStart: (state) => state.surfaceId === "pad" && state.x === 0 && state.z === 0 ? "valid" : "route-deviation", validate: (_previous, next) => next.state.surfaceId === "pad" && Math.abs(next.state.z) <= 8 && !next.motion.blocked ? "valid" : "route-deviation", progress: (state) => state.x };
const runner = (case_ = test, pilot = { input: () => forward }, observer = new GateAuditObserver(case_, validator), identity = key, simulation = kernel) => new DrivingRouteRunner(identity, case_, simulation, pilot, observer);
const finish = (run, batch = 1) => { let budget = 1000; while (!run.result && budget-- > 0) run.advance(batch, run.key); assert.ok(run.result); return run.result; };
const one = runner(); const r1 = finish(one, 1); const many = runner(); const r2 = finish(many, 37);
assert.equal(r1.verdict, "passed"); assert.equal(r1.simulatedTicks, r2.simulatedTicks);
assert.equal(JSON.stringify(one.state), JSON.stringify(many.state));
assert.ok(one.state.x > 4.4, "entire body, not just center, exits gate");
let manual = test.start; for (let i = 0; i < r1.simulatedTicks; i++) manual = stepDriving(manual, forward, world);
assert.equal(JSON.stringify(one.state), JSON.stringify(manual), "manual and audit must use identical physics");
// Audit failures retain a bounded local fault location, without forwarding raw exceptions.
for (const message of ["unexpected-position-jump", "private /home/user/log token=secret"]) {
  const broken = { identity: key, step() { throw new Error(message); } };
  const result = finish(runner(test, undefined, undefined, key, broken));
  assert.equal(result.cause, "simulation-invalid");
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.diagnostic.stage, "kernel");
  assert.equal(result.diagnostic.reason, message === "unexpected-position-jump" ? message : "kernel-exception");
  assert.equal(result.diagnostic.x, test.start.x);
  assert(!JSON.stringify(result).includes("secret"));
}
// Latest dev distinguishes an unresolved collision budget from a simulation defect.
const budgetObserver = { begin: () => "valid", observe: () => ({ status: "budget-exhausted", progress: 0, plannedStop: false }) };
const budgetKernel = { identity: key, step: (state) => ({ state, motion: { blocked: true, queryStatus: "unresolved", reason: "continuous-collision:budget" } }) };
const budgetResult = finish(runner(test, undefined, budgetObserver, key, budgetKernel));
assert.equal(budgetResult.cause, "budget-exhausted"); assert.equal(budgetResult.verdict, "inconclusive");
assert.equal(budgetResult.diagnostic.reason, "collision-query-budget");
assert.ok(Object.isFrozen(one.state));
assert.throws(() => runner(test, undefined, undefined, { ...key, collisionVersion: 2 }), /kernel-audit-identity-mismatch/);
const stalled = finish(runner(test, { input: () => idle })); assert.equal(stalled.cause, "pilot-failed"); assert.equal(stalled.verdict, "inconclusive"); assert.equal(stalled.coveredUnits.length, 0);
const cancelled = runner(); cancelled.advance(2, key); cancelled.cancel(); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.result.coveredUnits.length, 0);
const stale = runner(); stale.advance(2, { ...key, queryVersion: 2 }); assert.equal(stale.status, "stale"); assert.equal(stale.result.coveredUnits.length, 0);
one.advance(1, { ...key, vehicleConfigHash: "different-car" }); assert.equal(one.status, "stale"); assert.equal(one.result.verdict, "inconclusive");
const bad = new DrivingKernel({ move: (previous, desired) => ({ ...previous, ...desired, x: desired.x + 10, blocked: false }) }, key);
assert.equal(finish(runner(test, undefined, undefined, key, bad)).cause, "simulation-invalid");
const invalidStart = { ...test, start: { ...test.start, surfaceId: "unknown" } };
assert.equal(finish(runner(invalidStart)).simulatedTicks, 0);
assert.equal(finish(runner(invalidStart)).verdict, "inconclusive");
const wrongLayer = { ...test, gates: [{ ...test.gates[0], surfaceIds: ["bridge"] }] };
assert.equal(finish(runner(wrongLayer)).cause, "route-deviation");
const backwardGate = { ...test, gates: [{ ...test.gates[0], forwardX: -1 }] };
assert.notEqual(finish(runner(backwardGate)).verdict, "passed");
const narrowGate = { ...test, gates: [{ ...test.gates[0], halfWidth: 0.7 }] };
assert.equal(finish(runner(narrowGate)).cause, "route-deviation", "turning tire envelope is part of footprint");
const malformedPilot = runner(test, { input: () => ({ ...forward, forward: "true" }) });
assert.equal(finish(malformedPilot).cause, "pilot-failed");
const plannedStop = { begin: () => "valid", observe: () => ({ status: "continue", progress: 0, plannedStop: true }) };
assert.equal(finish(runner(test, { input: () => idle }, plannedStop)).cause, "budget-exhausted", "planned stops never bypass global budget");
const statics = manifest.units.map((unit) => ({ key, unitId: unit.id, topology: "passed", geometry: "passed", witness: null }));
const ready = evaluateAuditRelease(manifest, statics, [r1]); assert.equal(ready.ready, true); assert.equal(ready.candidateCount, 2);
assert.equal(evaluateAuditRelease(manifest, statics, []).ready, false);
assert.equal(evaluateAuditRelease(manifest, statics, [stalled]).units[0].status, "pending", "pilot failure is not blocked road");
assert.equal(evaluateAuditRelease(manifest, [{ ...statics[0], geometry: "blocked", witness: "clearance-0.6" }, statics[1]], [r1]).units[0].status, "blocked");
assert.equal(evaluateAuditRelease(manifest, [{ ...statics[0], geometry: "blocked" }, statics[1]], [r1]).units[0].status, "pending", "no witness cannot assert blockage");
assert.equal(evaluateAuditRelease(manifest, statics, [r1, r1]).ready, false, "duplicate results fail closed");
assert.equal(evaluateAuditRelease(manifest, statics, [{ ...r1, coveredUnits: ["edge-forward"] }]).ready, false);
assert.equal(evaluateAuditRelease(manifest, statics, [{ ...r1, key: { ...key, physicsVersion: 2 } }]).ready, false);
const baseKey = { ...key, releaseBoundaryHash: null };
assert.equal(evaluateAuditRelease({ ...manifest, key: baseKey }, statics.map((s) => ({ ...s, key: baseKey })), [{ ...r1, key: baseKey }]).ready, false, "base audit is not final-boundary replay");
assert.equal(evaluateAuditRelease({ ...manifest, key: baseKey }, statics.map((s) => ({ ...s, key: baseKey })), [{ ...r1, key: baseKey }]).units[0].status, "pending", "base-only success cannot color a unit green");
assert.throws(() => validateManifest({ ...manifest, units: [...manifest.units, { id: "unplanned", kind: "turn" }] }), /unplanned/);
assert.throws(() => validateManifest({ ...manifest, cases: [{ ...test, gates: [{ ...test.gates[0], forwardX: 0 }] }] }), /invalid-audit-gate/);
assert.notEqual(auditKeyId(key), auditKeyId({ ...key, observerVersion: 2 }));
const options = { ticksPerBatch: 11, maxTotalTicks: 1000, currentKey: () => key, isCancelled: () => false, yieldControl: async () => {} };
const completed = await scheduleAudit(manifest, (case_) => runner(case_), options); assert.equal(completed.state, "complete"); assert.equal(completed.results.length, 1);
const exhausted = await scheduleAudit(manifest, (case_) => runner(case_), { ...options, maxTotalTicks: 2 });
assert.equal(exhausted.state, "budget-exhausted"); assert.equal(exhausted.results.length, 0);
let cancelledFlag = false;
const abandoned = await scheduleAudit(manifest, (case_) => runner(case_), { ...options, isCancelled: () => cancelledFlag, yieldControl: async () => { cancelledFlag = true; } });
assert.equal(abandoned.state, "cancelled"); assert.equal(abandoned.results.length, 0);
let liveKey = key;
const expired = await scheduleAudit(manifest, (case_) => runner(case_), { ...options, ticksPerBatch: 1000, currentKey: () => liveKey, yieldControl: async () => { liveKey = { ...key, baseSnapshotHash: "new-city" }; } });
assert.equal(expired.state, "stale"); assert.equal(expired.results.length, 0, "late success must never publish");
await assert.rejects(scheduleAudit(manifest, (case_) => runner({ ...case_, maxTicks: 999 }), options), /runner-plan-mismatch/);
for (const hz of [30, 60, 120]) {
  const clock = new FixedStepClock(); let ticks = 0;
  for (let i = 0; i < hz * 5; i++) clock.advance(1 / hz, false, () => ticks++);
  assert.equal(ticks, 300);
  assert.equal(clock.advance(1, false, () => ticks++).pauseRequired, true); assert.equal(ticks, 300);
  assert.equal(clock.advance(0.1, true, () => ticks++).steps, 0);
  assert.ok(clock.advance(0.2, false, () => ticks++).steps <= 5);
}
console.log("Driving architecture verified: same-kernel parity, batch determinism, ordered directional full-body/layer gates, failure attribution, cancellation/stale rejection, final release fail-closed and fixed clock.");
