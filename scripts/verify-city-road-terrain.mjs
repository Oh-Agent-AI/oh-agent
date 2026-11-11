#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sceneKit, buildParts } from './city-kit/scene-parts.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/city-driving/coastal-wheel-twist.json', import.meta.url), 'utf8'));
assert.equal(fixture.schemaVersion, 1);
assert.equal(fixture.sourceCommit, 'c9d84b15f159b020042c8b19fc6c7df6293fc23e');
assert.equal(fixture.source.sessionCount, 0);
assert.equal(fixture.source.seed, 1);

const k = await sceneKit({
  'engine/surface/terrainSampling.ts': ['TERRAIN_SEGMENTS'],
  'engine/surface/compileSurface.ts': ['compileCitySurface'],
  'engine/surface/SurfaceIndex.ts': ['buildSurfaceIndex'],
  'engine/surface/surfaceRegions.ts': ['buildSurfaceRegions'],
  'game/driving/surfaceFootprint.ts': ['footprintSupport', 'DEFAULT_FOOTPRINT_PARAMS'],
  'game/driving/citySolids.ts': ['cityCollisionIndex'],
  'game/driving/ContinuousDrivingEnvironment.ts': ['ContinuousDrivingEnvironment'],
  'game/driving/ContinuousWorldValidator.ts': ['ContinuousWorldValidator'],
  'game/driving/createContinuousDrivingKernel.ts': ['createContinuousDrivingKernel'],
  'game/driving/audit/RoadPassabilityAudit.ts': ['CONTINUOUS_AUDIT_COLLIDER'],
  'game/DrivingSimulation.ts': ['initialDrivingState'],
});
assert.equal(k.DEFAULT_FOOTPRINT_PARAMS.maxWheelResidual, .06, 'wheel tolerance must not change');

function historicalHeight(resolution) {
  assert.ok(resolution === 192 || resolution === 384);
  assert.equal(fixture.grid.segments % resolution, 0);
  const stride = fixture.grid.segments / resolution;
  const cell = fixture.extent / resolution;
  const at = (i, j) => fixture.grid.heights[
    Math.max(0, Math.min(fixture.grid.heights.length - 1, j * stride - fixture.grid.z0))
  ][
    Math.max(0, Math.min(fixture.grid.heights[0].length - 1, i * stride - fixture.grid.x0))
  ];
  return (x, z) => {
    const gx = (x + fixture.extent / 2) / cell;
    const gz = (z + fixture.extent / 2) / cell;
    const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
    if (fx + fz <= 1) {
      const h = at(ix, iz);
      return h + (at(ix + 1, iz) - h) * fx + (at(ix, iz + 1) - h) * fz;
    }
    const h = at(ix + 1, iz + 1);
    return h + (at(ix, iz + 1) - h) * (1 - fx) + (at(ix + 1, iz) - h) * (1 - fz);
  };
}

function compileRegions(layout, revision) {
  const compiled = k.compileCitySurface(layout);
  const surface = { ...compiled.surface, revision };
  const regions = k.buildSurfaceRegions(surface, k.buildSurfaceIndex(surface));
  assert.equal(regions.status, 'ready', `${revision}: surface regions must be ready`);
  return { compiled, surface, regions };
}

function historicalLayout(resolution) {
  return {
    extent: fixture.extent,
    terrain: { height: historicalHeight(resolution) },
    roadEdges: [fixture.road],
    highways: [], landmarks: [], bridges: [], culDeSacEnds: [],
  };
}

// The old generator's road moved in later versions. Keep this small historical terrain patch
// as a fixture so generator changes cannot silently erase the 192-segment wheel-twist regression.
const twist = compileRegions(historicalLayout(192), 'historical-wheel-twist-192');
const oldPoint = fixture.point;
const oldCenter = twist.regions.classify(oldPoint.x, oldPoint.z, 'ground');
assert.equal(oldCenter.status, 'drivable', 'historical road center should be on the road');
const oldFailures = [];
for (let i = 0; i < 32; i++) {
  const support = k.footprintSupport(twist.regions, { ...oldPoint, heading: i * Math.PI / 16 }, oldCenter.regionId);
  if (!support.ok) oldFailures.push({ heading: i, reason: support.reason, detail: support.detail });
}
assert.ok(oldFailures.length > 0, 'historical 192-segment terrain must reproduce the wheel-twist failure');
assert.ok(oldFailures.every((failure) => failure.reason === 'excessive-step' && failure.detail === 'wheel-twist'),
  `historical failure must remain specifically wheel twist: ${JSON.stringify(oldFailures)}`);

const fixed = compileRegions(historicalLayout(384), 'historical-wheel-twist-384');
const fixedCenter = fixed.regions.classify(oldPoint.x, oldPoint.z, 'ground');
assert.equal(fixedCenter.status, 'drivable');
let historicalMaxResidual = 0;
for (let i = 0; i < 32; i++) {
  const support = k.footprintSupport(fixed.regions, { ...oldPoint, heading: i * Math.PI / 16 }, fixedCenter.regionId);
  assert.ok(support.ok, `384-segment historical footprint heading ${i}: ${JSON.stringify(support)}`);
  const residual = Math.abs((support.wheels[0] - support.wheels[1]) - (support.wheels[2] - support.wheels[3])) / 2;
  assert.ok(residual <= k.DEFAULT_FOOTPRINT_PARAMS.maxWheelResidual);
  historicalMaxResidual = Math.max(historicalMaxResidual, residual);
}

// Keep a real current City scene check: the rendered PlaneGeometry must be the same terrain
// field used by the compiler and the actual driving integration must traverse real city roads.
const { parts, layout } = buildParts(k, 0, 1);
const lease = parts.acquireDrivingWorldSource();
try {
  const { compiled, surface, regions } = compileRegions(layout, 'current-city-terrain-384-0-1');
  assert.equal(k.TERRAIN_SEGMENTS, 384, 'current terrain resolution must remain 384');
  let vertices = 0;
  parts.group.traverse((object) => {
    const position = object.geometry?.attributes?.position;
    if (object.geometry?.type !== 'PlaneGeometry' || position?.count !== (k.TERRAIN_SEGMENTS + 1) ** 2) return;
    for (let i = 0; i < position.count; i++) {
      assert.ok(Math.abs(position.getY(i) - layout.terrain.height(position.getX(i), position.getZ(i))) < 1e-5,
        'rendered terrain shares the original height source');
    }
    vertices += position.count;
  });
  assert.equal(vertices, (k.TERRAIN_SEGMENTS + 1) ** 2, 'verify the real rendered terrain mesh');

  // Select a deterministic geometrically supported straight segment. Selection does not inspect
  // collision outcomes; once selected, both real collision-enabled drives must complete.
  const candidates = layout.roadEdges
    .filter((edge) => !edge.bridge && edge.width >= 8 && edge.points?.length === 2)
    .map((edge) => {
      const [a, b] = edge.points;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      return { edge, a, b, dx, dz, length, ux: dx / length, uz: dz / length, heading: Math.atan2(dz, dx), x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    })
    .filter((candidate) => candidate.length >= 24)
    .sort((a, b) => b.length - a.length || a.edge.id.localeCompare(b.edge.id));
  let chosen;
  for (const candidate of candidates) {
    const center = regions.classify(candidate.x, candidate.z, 'ground');
    if (center.status !== 'drivable') continue;
    const forward = k.footprintSupport(regions, { x: candidate.x - candidate.ux * 5, z: candidate.z - candidate.uz * 5, heading: candidate.heading }, center.regionId);
    const reverse = k.footprintSupport(regions, { x: candidate.x + candidate.ux * 5, z: candidate.z + candidate.uz * 5, heading: candidate.heading + Math.PI }, center.regionId);
    if (forward.ok && reverse.ok) { chosen = { ...candidate, regionId: center.regionId }; break; }
  }
  assert.ok(chosen, 'current City must expose a straight ground road with supported start poses in both directions');

  const solids = k.cityCollisionIndex(compiled.obstacles, lease.source.solids()).solids();
  const env = new k.ContinuousDrivingEnvironment(regions, {
    surfaceRevision: surface.revision,
    worldRevision: surface.revision,
    solidRevision: surface.revision,
    solids,
    ...k.CONTINUOUS_AUDIT_COLLIDER,
    isCurrent: () => true,
  });
  const kernel = k.createContinuousDrivingKernel(env, {
    worldRevision: surface.revision,
    vehicleConfigHash: 'calibrated-road-terrain',
    kernelBuildId: 'terrain-384-regression-v1',
  });
  for (const reverse of [false, true]) {
    const sign = reverse ? -1 : 1;
    const x = chosen.x - chosen.ux * sign * 5;
    const z = chosen.z - chosen.uz * sign * 5;
    const heading = chosen.heading + (reverse ? Math.PI : 0);
    const support = k.footprintSupport(regions, { x, z, heading }, chosen.regionId);
    assert.ok(support.ok);
    let state = { ...k.initialDrivingState(x, z, heading, chosen.regionId), y: support.y, pitch: support.pitch, roll: support.roll };
    let travel = 0;
    const validator = new k.ContinuousWorldValidator(env, (next) => (next.x - x) * chosen.ux * sign + (next.z - z) * chosen.uz * sign);
    assert.equal(validator.validateStart(state), 'valid');
    for (let i = 0; i < 500 && travel < 8; i++) {
      const next = kernel.step(state, { forward: true, backward: false, left: false, right: false });
      assert.equal(next.motion.queryStatus, 'resolved', next.motion.reason);
      assert.equal(next.motion.blocked, false, next.motion.reason);
      assert.equal(validator.validate(state, next), 'valid');
      state = next.state;
      travel = validator.progress(state);
    }
    assert.ok(travel >= 8, `real collision-enabled City car must travel 8 world units along ${chosen.edge.id} (${reverse ? 'reverse' : 'forward'})`);
  }
  console.log(`Road terrain: historical 192-segment patch reproduces ${oldFailures.length}/32 wheel-twist failures; 384-segment patch supports all 32 headings (max residual ${historicalMaxResidual.toFixed(6)}). Current City resolution ${k.TERRAIN_SEGMENTS}; ${vertices} rendered terrain vertices match the source; real collision-enabled driving passed both directions on ${chosen.edge.id}.`);
} finally {
  lease.release();
  parts.dispose();
}
