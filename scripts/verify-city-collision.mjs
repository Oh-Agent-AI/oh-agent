#!/usr/bin/env node
// Solid collision on the rendered city (B batch ②): the CityParts scene of 0/90/500 synthetic sessions ×
// five seeds is built in Node, captured through CitySurfacePort exactly as CityEngine does (structure
// obstacles + deck slabs + rendered building/landmark solids, frozen at capture), and driven with the same
// kernel on straight roads and expressway ramps. Every tick is re-validated with the solids included.
import assert from "node:assert/strict";
import { sceneKit, buildParts } from "./city-kit/scene-parts.mjs";
import { makeRoutePilot } from "./city-kit/route-pilot.mjs";

const kit = await sceneKit({
  "engine/surface/citySurfacePort.ts": ["CitySurfacePort"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "engine/surface/compileSurface.ts": ["landingConnectivity"],
  "game/driving/citySolids.ts": ["solidsOnRoad", "cityCollisionIndex"],
  "game/driving/surfaceFootprint.ts": ["footprintSupport"],
  "game/driving/SurfaceDrivingWorld.ts": ["SurfaceDrivingEnvironment", "SurfaceWorldValidator", "polylineProgress"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"],
  "game/DrivingSimulation.ts": ["initialDrivingState"],
});
const key = { baseSnapshotHash: "scene-collision-v1", vehicleConfigHash: "car-v1", kernelBuildId: "fixture-build-v1", surfaceVersion: 3, queryVersion: 4,
  snapshotCompilerVersion: 1, physicsVersion: 1, collisionVersion: 1, controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "x", releasePolicyVersion: 1, releaseBoundaryHash: null };
const drive = makeRoutePilot(kit, key);
// Regression ceiling measured 2026-10-16: at most 7 solids stand on drivable road in one scene (expressway
// piers placed by mileage inside ground roads, a truss chord over a bridgehead road, one airport canopy
// 1.1 above its access road, one district landmark over a junction). These are reported, never opened.
const MAX_ON_ROAD = 7;
const totals = { scenes: 0, solids: 0, onRoad: {}, runs: 0, driven: 0, collisionBlocks: 0, rampsUp: 0, ramps: 0 };
for (const sessions of [0, 90, 500]) for (const seed of [1, 7, 42, 2026, 65537]) {
  const { parts } = buildParts(kit, sessions, seed);
  const frozen = parts.acquireStaticSceneSource();
  const source = frozen.drivingSource; assert.ok(source?.solids, "the rendered city exposes its solids to the capture");
  const capture = await new kit.CitySurfacePort().capture(source);
  assert.equal(capture.status, "ready");
  const surface = capture.read(); const regions = kit.buildSurfaceRegions(surface, kit.buildSurfaceIndex(surface)); assert.equal(regions.status, "ready");
  const compilation = capture.readWorld(); assert.ok(compilation);
  const collision = kit.cityCollisionIndex(compilation.obstacles, compilation.sceneSolids);
  assert.equal(collision.report.rejected, 0, "every captured solid is a valid convex polytope");
  const roles = collision.report.byRole;
  if (sessions > 0) assert.ok((roles["city-shafts"] ?? 0) + (roles["city-civic-boxes"] ?? 0) > 0, "buildings are in the index");
  assert.ok(Object.keys(roles).some((r) => r.startsWith("city-landmark")), "landmarks are in the index");
  assert.ok(!Object.keys(roles).some((r) => /suspension-bridge|truss-bridge|infrastructure|beach|road-surface/.test(r)), "structure meshes come from descriptors, decor is not solid");
  const onRoad = kit.solidsOnRoad(regions, collision);
  assert.ok(onRoad.length <= MAX_ON_ROAD, `${sessions}/${seed}: ${onRoad.length} solids on road (${onRoad.map((s) => s.id).join(", ")})`);
  // 城区地标场地（裙楼、停车场、树、绿篱）必须整个落在自己的街区内：曾按地块包围盒铺矩形草坪，非矩形街区的角伸到路面，
  // 贴地铺装又被当成实体，500/2026 一个场景就有 7 个（2026-10-20 修复）。贴地铺装不是实体，其余部件不得在路上。
  const districtOnRoad = onRoad.filter((s) => s.role === "city-landmark-district");
  assert.equal(districtOnRoad.length, 0, `${sessions}/${seed}: district landmark site parts on road (${districtOnRoad.map((s) => s.id).join(", ")})`);
  for (const s of onRoad) totals.onRoad[s.role] = (totals.onRoad[s.role] ?? 0) + 1;
  // Straight roads with solids on: spawn 12 in, drive to 6 past the end node; outcomes reported.
  const layout = source.layout; const outcomes = {};
  const edges = layout.roadEdges.filter((e) => e.points.length === 2 && !e.bridge && e.structure !== "deck" && Math.hypot(e.points[1].x - e.points[0].x, e.points[1].z - e.points[0].z) > 30)
    .sort((a, b) => a.id < b.id ? -1 : 1).slice(0, 20);
  for (const edge of edges) {
    const [a, b] = edge.points; const len = Math.hypot(b.x - a.x, b.z - a.z); const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const r = drive(regions, [{ x: a.x + ux * 12, z: a.z + uz * 12 }, { x: b.x + ux * 6, z: b.z + uz * 6 }], { collision, until: Math.max(12, len - 6) });
    totals.runs++;
    const kind = r.result.startsWith("blocked") ? `blocked:${r.result.split(":")[1]}` : r.result.split("@")[0];
    if (r.result.startsWith("invalid")) assert.fail(`${sessions}/${seed} ${edge.id}: ${r.result}`);
    if (r.s >= 12) totals.driven++;
    if (/collision/.test(r.result)) totals.collisionBlocks++;
    outcomes[kind] = (outcomes[kind] ?? 0) + 1;
  }
  // Expressway ramps: road → ramp → elevated deck with every solid present.
  const ramps = [];
  for (const x of kit.landingConnectivity(compilation, regions).filter((x) => x.landing.structureId.startsWith("expressway:") && x.connected)) {
    const l = x.landing; const run = layout.highways[Number(l.structureId.split(":")[1])];
    const r = drive(regions, [{ x: l.x + l.outX * 4, z: l.z + l.outZ * 4 }, ...(l.end === "from" ? run : [...run].reverse())], { collision, until: 4 + 110 });
    if (r.result.startsWith("invalid")) assert.fail(`${sessions}/${seed} ramp ${l.structureId}/${l.end}: ${r.result}`);
    totals.ramps++; if (r.maxY > 9) totals.rampsUp++;
    ramps.push(`${l.end}:${r.result}(${r.maxY.toFixed(1)})`);
  }
  totals.scenes++; totals.solids += collision.report.solids;
  frozen.release();
  console.log(`Collision: ${sessions} sessions, seed ${seed}: ${collision.report.solids} solids, ${onRoad.length} on road ${JSON.stringify(onRoad.map((s) => s.role))}, straight ${JSON.stringify(outcomes)}, ramps [${ramps.join(" ")}].`);
}
assert.ok(totals.driven >= totals.runs * 0.6, `straight runs with solids regressed (${totals.driven}/${totals.runs})`);
if (totals.ramps) assert.ok(totals.rampsUp >= 1, "at least one connected ramp reaches the elevated deck with every solid present");
console.log(`Collision: ${totals.scenes} scenes, ${totals.solids} solids; on road ${JSON.stringify(totals.onRoad)} (reported, ceiling ${MAX_ON_ROAD}/scene); ${totals.driven}/${totals.runs} straight runs ≥12 with solids, ${totals.collisionBlocks} stopped by a solid; ${totals.rampsUp}/${totals.ramps} connected ramps climbed to the deck. Every tick independently validated with solids.`);
