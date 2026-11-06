#!/usr/bin/env node
// Display-layout matrix: 0/90/500 synthetic sessions × seeds 1/7/42/2026/65537 through
// layoutCity (display pruning included). Per layout: aggregate surface compile, exact terrain
// fit + manifold drivable pieces, regions without ground-ground height conflicts, landing
// connectivity, and same-kernel straight-road runs validated every tick. Not a release audit.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { sessionModel } from "./city-kit/session-models.mjs";
const kit = await loadCity({
  "cityModel.ts": ["buildCityModel"], "engine/cityLayout.ts": ["layoutCity"],
  "engine/surface/compileSurface.ts": ["compileCitySurface", "landingConnectivity"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"], "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "engine/surface/groundRoadCompiler.ts": ["groundPieceTriangles", "ROAD_SURFACE_LIFT"], "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "game/driving/SurfaceDrivingWorld.ts": ["SurfaceDrivingEnvironment", "SurfaceWorldValidator", "polylineProgress"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"], "game/DrivingSimulation.ts": ["initialDrivingState"],
});
const key = { baseSnapshotHash: "session-matrix", vehicleConfigHash: "car-v1", kernelBuildId: "fixture-build-v1", surfaceVersion: 2, queryVersion: 2,
  snapshotCompilerVersion: 1, physicsVersion: 1, collisionVersion: 1, controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "x", releasePolicyVersion: 1, releaseBoundaryHash: null };
const GROUND = /^(road|junction):/;
let runs = 0; let driven = 0;
for (const sessions of [0, 90, 500]) for (const seed of [1, 7, 42, 2026, 65537]) {
  const layout = kit.layoutCity(sessionModel(kit.buildCityModel, sessions), null, seed, null, "auto");
  const c = kit.compileCitySurface(layout);
  const label = `${sessions} sessions, seed ${seed}`;
  let sidewalkUnresolved = 0;
  for (const piece of c.ground.pieces) {
    assert.ok(piece.terrainDeviation <= kit.ROAD_SURFACE_LIFT / 2 + 1e-12, `${label}: ${piece.id} terrain deviation ${piece.terrainDeviation}`);
    const { positions, indices } = kit.groundPieceTriangles(c.ground, piece);
    if (kit.extractMeshBoundaries(positions, indices).status !== "complete") {
      assert.equal(piece.kind, "sidewalk", `${label}: drivable piece ${piece.id} has no manifold boundary`); sidewalkUnresolved++;
    }
  }
  assert.equal(sidewalkUnresolved, 0, `${label}: ${sidewalkUnresolved} sidewalk pieces unresolved`);
  const surface = { ...c.surface, revision: "session-matrix" };
  const regions = kit.buildSurfaceRegions(surface, kit.buildSurfaceIndex(surface));
  assert.equal(regions.status, "ready", `${label}: ${regions.reason}`);
  const groundConflicts = regions.report.conflicts.filter((x) => GROUND.test(x.a) && GROUND.test(x.b));
  assert.deepEqual(groundConflicts, [], `${label}: ordinary road/junction pieces never conflict after the terrain fit`);
  const connected = kit.landingConnectivity(c, regions).filter((x) => x.connected).length;
  // Straight single-segment roads: spawn 12 in, drive 12 along the centreline.
  const env = new kit.SurfaceDrivingEnvironment(regions); const kernel = new kit.DrivingKernel(env, key);
  const edges = layout.roadEdges.filter((e) => e.points.length === 2 && !e.bridge && Math.hypot(e.points[1].x - e.points[0].x, e.points[1].z - e.points[0].z) > 30)
    .sort((a, b) => a.id < b.id ? -1 : 1).slice(0, 20);
  let ok = 0;
  for (const edge of edges) {
    const [a, b] = edge.points; const len = Math.hypot(b.x - a.x, b.z - a.z); const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len, heading = Math.atan2(dz, dx);
    const sx = a.x + dx * 12, sz = a.z + dz * 12; const start = regions.classify(sx, sz, "ground");
    if (start.status !== "drivable") continue;
    const placed = env.place(sx, sz, heading, start.regionId); if (!placed) continue;
    let s = { ...kit.initialDrivingState(sx, sz, heading, start.regionId), ...placed };
    const validator = new kit.SurfaceWorldValidator(regions, kit.polylineProgress([a, b]));
    runs++;
    for (let tick = 0; tick < 600 && (s.x - sx) * dx + (s.z - sz) * dz < 12; tick++) {
      const lateral = -(s.x - a.x) * dz + (s.z - a.z) * dx; const err = Math.atan2(Math.sin(heading - s.heading), Math.cos(heading - s.heading)) - lateral * 0.3;
      const step = kernel.step(s, { forward: true, backward: false, left: err < -0.02, right: err > 0.02 });
      assert.equal(validator.validate(s, step), "valid", `${label}: ${edge.id} tick ${tick}`);
      if (step.motion.blocked) break;
      s = step.state;
    }
    if ((s.x - sx) * dx + (s.z - sz) * dz >= 12) { ok++; driven++; }
  }
  console.log(`Surface sessions: ${label}: ${layout.roadEdges.length} edges, ${c.surface.patches.length} patches ${JSON.stringify(c.counts)}, ${regions.report.regions} regions, ${regions.report.conflicts.length} structure conflicts, ${connected}/${c.landings.length} landings connected, ${ok}/${edges.length} straight runs ≥12, ${sidewalkUnresolved} sidewalk unresolved.`);
}
assert.ok(driven > 0 && driven >= runs * 0.95, `straight-road runs on display layouts (${driven}/${runs})`);
console.log(`Surface sessions: 15 display layouts passed; ${driven}/${runs} straight runs validated tick-by-tick. Display layouts with repair patches and the native bundle remain outside this guard.`);
