#!/usr/bin/env node
// 出生点派生与校验守卫（SPEC §13.5）：几何只来自审计案例、确定性派生、
// 逐点校验拒绝路径（不可行驶/区域锚不符/车身不净空）、无几何不出候选。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { makeFixtures } = await import(path.join(repo, "scripts/city-kit/surface-region-fixtures.mjs"));
const kit = await import(path.join(repo, "scripts/city-kit/index.mjs"));
const loaded = await kit.loadCity({
    "game/driving/audit/ReleasedDrivingGraph.ts": ["publishDrivingGraph"],
    "game/driving/audit/AuditReleasePolicy.ts": ["evaluateAuditRelease"],
    "game/driving/spawnPoints.ts": ["deriveSpawnCandidates", "validateSpawnSpec", "validateSpawnPoint"],
    "game/driving/SpawnConfirmation.ts": ["SpawnConfirmationStore", "resolveFormalSpawn"],
    "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
    "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
    "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
    "engine/surface/compileCitySolidInputs.ts": ["CITY_SOLID_COMPILER_VERSION"],
  });
const { publishDrivingGraph, evaluateAuditRelease, extractMeshBoundaries, buildSurfaceIndex, SpawnConfirmationStore, resolveFormalSpawn } = loaded;
const spawn = loaded;

const key = { baseSnapshotHash: "w-1", vehicleConfigHash: "v", kernelBuildId: "k", surfaceVersion: 1, queryVersion: 1, snapshotCompilerVersion: 1,
  physicsVersion: 1, collisionVersion: 1, controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "m",
  releasePolicyVersion: 1, releaseBoundaryHash: "b1" };
const start = { x: 0, y: 0, z: 0, heading: 0, speed: 0, steering: 0, distance: 0, braking: false, reversing: false, pitch: 0, roll: 0, surfaceId: "region:ground:pad" };
const corridor = (waypoints) => ({ surfaceSequence: [start.surfaceId], portalSequence: [], waypoints });
const gate = (id) => ({ id, x: 10, y: 0, z: 0, forwardX: 1, forwardZ: 0, halfWidth: 1.8, heightTolerance: 0.3, surfaceIds: [start.surfaceId] });
const mkCase = (id, units, waypoints) => ({ id, units, start,
  gates: [gate(`${id}:exit`)], corridor: corridor(waypoints), policy: { cruiseSpeed: 6, maxReverseSpeed: 0 }, maxTicks: 600, maxNoProgressTicks: 120 });

// 两条直路（不同方向）+ 一条多案例歧义单元 + 一个非 passed 单元。
const units = [
  { id: "edge:a>b", kind: "directed-edge" }, { id: "edge:b>a", kind: "directed-edge" },
  { id: "edge:amb", kind: "directed-edge" }, { id: "edge:closed", kind: "directed-edge" }, { id: "spawn:0", kind: "spawn-access" },
];
const manifest = { key, units, exclusions: [{ unitId: "edge:closed", reason: "closed-by-decision" }],
  cases: [
    mkCase("c-ab", ["edge:a>b", "spawn:0"], [{ x: 0, z: 0 }, { x: 10, z: 0 }]),
    mkCase("c-ba", ["edge:b>a"], [{ x: 10, z: 0 }, { x: 0, z: 0 }]),
    mkCase("c-amb-1", ["edge:amb"], [{ x: 0, z: 5 }, { x: 4, z: 5 }]),
    mkCase("c-amb-2", ["edge:amb"], [{ x: 6, z: 5 }, { x: 10, z: 5 }]),
  ] };
const statics = units.filter((unit) => unit.id !== "edge:closed").map((unit) => ({ key, unitId: unit.id, topology: "passed", geometry: "passed", witness: null }));
const runs = manifest.cases.map((item) => ({ key, caseId: item.id, verdict: "passed", cause: "none", coveredUnits: item.units, simulatedTicks: 40 }));
const decision = evaluateAuditRelease(manifest, statics, runs);
assert.equal(decision.ready, true, "对照组 ready");
const boundary = (unitId, layerId = "ground") => ({ version: 1, unitId, layerId, finalBoundaryHash: "b1",
  releasePolicyVersion: 1, collisionCompilerVersion: loaded.CITY_SOLID_COMPILER_VERSION, collisionQueryVersion: 1, finalReplayPassed: true, fenceEnforced: true,
  segments: [{ ax: -10, az: -5, bx: 20, bz: -5 }, { ax: 20, az: -5, bx: 20, bz: 5 },
    { ax: 20, az: 5, bx: -10, bz: 5 }, { ax: -10, az: 5, bx: -10, bz: -5 }] });
const published = publishDrivingGraph(manifest, decision, [boundary("edge:a>b"), boundary("edge:b>a")]);
assert.equal(published.ok, true, "发布成功");

// 1) 图几何：passed 单元带 verified centerline；多案例覆盖的 edge:amb 无几何。
const geo = new Map(published.graph.geometry.map((entry) => [entry.unitId, entry]));
assert.ok(geo.has("edge:a>b") && geo.has("edge:b>a"), "单案例单元有几何");
assert.ok(!geo.has("edge:amb"), "多案例歧义单元无几何（不伪造）");
assert.ok(!geo.has("edge:closed"), "非 passed 单元无几何");
const geoAB = geo.get("edge:a>b"), geoBA = geo.get("edge:b>a");
assert.equal(geoAB ? geoAB.startHeading : null, 0, "a>b 起始朝向 +X");
assert.equal(geoBA ? Math.abs(geoBA.startHeading - Math.PI) < 1e-9 : false, true, "b>a 起始朝向 -X");

// 2) 派生：有几何单元出中点候选；歧义/非 passed/无几何不出；同图同输出。
const candidates = spawn.deriveSpawnCandidates(published.graph, () => "ground");
const ids = candidates.map((candidate) => candidate.id);
assert.equal(ids.length, 2, "只派生有几何单元");
assert.equal(ids[0], "spawn:edge:a>b");
assert.equal(ids[1], "spawn:edge:b>a");
const ab = candidates.find((candidate) => candidate.id === "spawn:edge:a>b");
assert.ok(Math.abs(ab.x - 5) < 1e-9 && Math.abs(ab.z) < 1e-9, "a>b 中点 (5,0)");
assert.ok(Math.abs(ab.heading) < 1e-9, "中点朝向沿切向 +X");
const again = spawn.deriveSpawnCandidates(published.graph, () => "ground");
assert.equal(again.length, candidates.length, "派生确定性：数量一致");
for (let index = 0; index < candidates.length; index += 1) {
  assert.equal(again[index].id, candidates[index].id);
  assert.equal(again[index].x, candidates[index].x);
  assert.equal(again[index].z, candidates[index].z);
  assert.equal(again[index].heading, candidates[index].heading);
}
const layered = spawn.deriveSpawnCandidates(published.graph, (unitId) => unitId.includes("b>a") ? "deck-1" : "ground");
const layeredBA = layered.find((candidate) => candidate.id === "spawn:edge:b>a");
assert.equal(layeredBA ? layeredBA.layerId : null, "deck-1", "layerId 由调用方映射");

// 3) 校验拒绝路径：早期 stale / revision / schema 失败。
const capture = { readWorld: () => null, isLeaseCurrent: () => false, worldRevision: "w-1" };
const spec = { schemaVersion: 1, worldRevision: "w-1", vehicleConfigHash: "v", spawns: [] };
const rejectStale = await spawn.validateSpawnSpec({ capture, graph: published.graph, isGraphCurrent: () => true }, spec, { halfLength: 1.4, halfWidth: 0.7, halfHeight: 0.5 }, 0.55);
assert.equal(rejectStale.ok, false);
assert.equal(rejectStale.reason, "stale-world");
const rejectRevision = await spawn.validateSpawnSpec({ capture: { ...capture, isLeaseCurrent: () => true }, graph: published.graph, isGraphCurrent: () => true },
  { ...spec, worldRevision: "w-other" }, { halfLength: 1.4, halfWidth: 0.7, halfHeight: 0.5 }, 0.55);
assert.equal(rejectRevision.reason, "world-revision-mismatch");
const rejectSchema = await spawn.validateSpawnSpec({ capture, graph: published.graph, isGraphCurrent: () => true },
  { ...spec, schemaVersion: 2 }, { halfLength: 1.4, halfWidth: 0.7, halfHeight: 0.5 }, 0.55);
assert.equal(rejectSchema.reason, "schema-version");

// 4) Effective valid-world guard: real compiled road, static solid snapshot and final
// released-unit fence evidence. Whole-spec validation checks each point and issues proofs.
const fixtures = makeFixtures({ ...loaded, extractMeshBoundaries });
const surface = fixtures.snapshot([fixtures.patch("pad", "carriageway", fixtures.grid(-30, -8, 30, 8, 12, 4))]);
const world = { revision: "w-1", surface, obstacles: [], sceneSolids: [], renderedSolids: [], landings: [], counts: {}, obstacleCoverage: "structures-only" };
let graphCurrent = true;
const currentCapture = { worldRevision: "w-1", isLeaseCurrent: () => true, readWorld: () => world };
const validationWorld = { capture: currentCapture, graph: published.graph, isGraphCurrent: () => graphCurrent };
const dims = { halfLength: 1.4, halfWidth: 0.7, halfHeight: 0.5 };
const valid = { id: "spawn:ab", sourceUnitId: "edge:a>b", x: 5, z: 0, heading: 0, layerId: "ground" };
const validSpec = { schemaVersion: 1, worldRevision: "w-1", vehicleConfigHash: "v", spawns: [valid] };
const accepted = await spawn.validateSpawnSpec(validationWorld, validSpec, dims, 0.55);
assert.equal(accepted.ok, true, "a fully evidenced point in a ready world validates");
assert.equal(accepted.credentials.length, 1);
assert.equal(accepted.credentials[0].isFresh(), true);
assert.deepEqual(accepted.credentials[0].collider, { dimensions: dims, centerHeight: 0.55 }, "credential binds full collider dimensions and center height");
assert.deepEqual(geoAB.surfaceRegionIds, [start.surfaceId], "corridor surfaceSequence is DrivingState.surfaceId / regionId, never patchId");

// Explicit local confirmation is a separate step after sealed validation. It is
// bound to this scene/world/released graph/config and never creates credentials.
const confirmation = new SpawnConfirmationStore();
const binding = { sceneId: "city-instance-1", worldRevision: "w-1", graphBoundaryHash: "b1", vehicleConfigHash: "v" };
const candidateChoice = [{ id: accepted.credentials[0].spawnId, sourceUnitId: accepted.credentials[0].sourceUnitId }];
assert.equal(confirmation.derive(binding, candidateChoice), true);
assert.equal(confirmation.snapshot.status, "derived");
assert.equal(confirmation.getConfirmed(binding), null, "derived candidates cannot enter");
assert.equal(resolveFormalSpawn(confirmation, binding, accepted.credentials[0]).reason, "spawn-confirmation-required", "formal entry gate rejects a derived candidate");
assert.equal(confirmation.validate(binding, { ...accepted.credentials[0] }), false, "structurally copied credentials lack the verifier seal");
assert.equal(confirmation.snapshot.status, "invalidated");
assert.equal(confirmation.derive(binding, candidateChoice), true);
assert.equal(confirmation.validate(binding, accepted.credentials[0]), true, "only validator-issued fresh credential reaches validated");
assert.equal(confirmation.snapshot.status, "validated");
assert.equal(confirmation.getConfirmed(binding), null, "validated candidate still requires explicit confirmation");
confirmation.cancel();
assert.equal(confirmation.snapshot.status, "invalidated", "cancel discards validated candidate");
assert.equal(resolveFormalSpawn(confirmation, binding, accepted.credentials[0]).ok, false, "cancelled candidate cannot enter");
assert.equal(confirmation.derive(binding, candidateChoice), true);
assert.equal(confirmation.validate(binding, accepted.credentials[0]), true);
assert.equal(confirmation.confirm(binding, accepted.credentials[0].spawnId), true);
assert.equal(confirmation.confirm(binding, accepted.credentials[0].spawnId), true, "repeated confirmation is idempotent while its credential is fresh");
assert.equal(confirmation.snapshot.status, "confirmed");
assert.equal(confirmation.getConfirmed(binding), accepted.credentials[0]);
assert.equal(resolveFormalSpawn(confirmation, binding, accepted.credentials[0]).ok, true, "formal entry gate accepts only the confirmed current credential");
assert.equal(confirmation.getConfirmed({ ...binding, sceneId: "other-city-instance" }), null, "confirmation cannot cross scene instances");
assert.equal(confirmation.snapshot.status, "invalidated");
assert.equal(confirmation.derive(binding, candidateChoice), true);
assert.equal(confirmation.validate(binding, accepted.credentials[0]), true);
assert.equal(confirmation.confirm(binding, accepted.credentials[0].spawnId), true);
graphCurrent = false;
assert.equal(confirmation.getConfirmed(binding), null, "graph lease loss invalidates confirmation through credential freshness");
assert.equal(confirmation.snapshot.status, "invalidated");
assert.equal(resolveFormalSpawn(confirmation, binding, accepted.credentials[0]).ok, false, "formal entry gate rejects after graph lease loss");
graphCurrent = true;

for (const [label, invalid] of [
  ["building overlap", { ...valid, x: 5, z: 0 }],
  ["wrong layer", { ...valid, id: "wrong-layer", layerId: "deck-1" }],
  ["reverse tangent", { ...valid, id: "reverse", heading: Math.PI }],
  ["near boundary", { ...valid, id: "near-boundary", z: 3.5 }],
  ["outside passed unit", { ...valid, id: "outside-unit", x: 11 }],
]) {
  const invalidWorld = label === "building overlap" ? { ...world, obstacles: [{ id: "spawn-wall", role: "building", shape: "box",
    corners: [{ x: 4, y: 0, z: -1 }, { x: 6, y: 0, z: -1 }, { x: 6, y: 3, z: -1 }, { x: 4, y: 3, z: -1 },
      { x: 4, y: 0, z: 1 }, { x: 6, y: 0, z: 1 }, { x: 6, y: 3, z: 1 }, { x: 4, y: 3, z: 1 }] }] } : world;
  const result = await spawn.validateSpawnSpec({ ...validationWorld, capture: { ...currentCapture, readWorld: () => invalidWorld } },
    { ...validSpec, spawns: [invalid] }, dims, 0.55);
  assert.equal(result.ok, false, `${label} must reject`);
}
const mixed = await spawn.validateSpawnSpec(validationWorld, { ...validSpec, spawns: [valid, { ...valid, id: "bad", z: 3.5 }] }, dims, 0.55);
assert.equal(mixed.ok, false, "one bad point rejects the complete table");
assert.equal(mixed.spawnId, "bad", "rejection identifies the offending point");
graphCurrent = false;
assert.equal((await spawn.validateSpawnSpec(validationWorld, validSpec, dims, 0.55)).reason, "stale-graph");

// 5) Missing final fence evidence never creates a candidate or credential.
const noFence = publishDrivingGraph(manifest, decision);
assert.equal(noFence.ok, true);
assert.equal(spawn.deriveSpawnCandidates(noFence.graph, () => "ground").length, 0);
const noFenceWorld = { ...validationWorld, graph: noFence.graph, isGraphCurrent: () => true };
assert.equal((await spawn.validateSpawnSpec(noFenceWorld, validSpec, dims, 0.55)).reason, "spawn-geometry-unavailable");

// A diagnostic road audit without the mandatory final-boundary replay is not a
// published graph and cannot seed confirmation state or formal entry.
const unpublishedManifest = { ...manifest, key: { ...key, releaseBoundaryHash: null } };
const unpublished = publishDrivingGraph(unpublishedManifest, decision);
assert.equal(unpublished.ok, false, "missing final-boundary replay rejects graph publication");
assert.equal(unpublished.reason, "final-boundary-replay-required");
const noPublishedConfirmation = new SpawnConfirmationStore();
assert.equal(noPublishedConfirmation.derive(binding, []), false, "no published graph yields no candidates");
assert.equal(noPublishedConfirmation.snapshot.status, "unavailable");
assert.equal(resolveFormalSpawn(noPublishedConfirmation, null, null).ok, false, "formal entry rejects without a published graph");

console.log("Driving spawns: released fence evidence, full-table valid-world point checks, boundary/tangent/layer/solid rejection, stale graph, missing evidence, and unpublished graph guards passed.");
