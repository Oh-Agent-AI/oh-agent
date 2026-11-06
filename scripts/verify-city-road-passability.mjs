#!/usr/bin/env node
// Road passability audit (B): passed only from a validated run, blocked only with a witness (topology or
// an exact corridor cut), everything else inconclusive with its cause — bound to the world revision.
// Synthetic fixtures here; --cities audits real planned cities through the frozen surface port.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const m = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "engine/surface/compileCitySolidInputs.ts": ["CITY_SOLID_COMPILER_VERSION"],
  "game/driving/audit/RoadPassabilityAudit.ts": ["passabilityWorld", "auditRoute", "corridorCutEvidence", "directedEdgeRoutes", "ROAD_PASSABILITY_AUDIT_VERSION", "continuousAuditKeyFields", "CorridorValidator"],
  "game/driving/audit/GateAuditObserver.ts": ["GateAuditObserver"],
  "game/driving/audit/AuditReleasePolicy.ts": ["evaluateAuditRelease"],
  "game/driving/vehicleFootprint.ts": ["DRIVING_FOOTPRINT"],
  "game/driving/surfaceFootprint.ts": ["DEFAULT_FOOTPRINT_PARAMS"],
});
const { grid, patch } = makeFixtures(m);
const REQUIRED = 2 * (m.DRIVING_FOOTPRINT.halfWidth + m.DEFAULT_FOOTPRINT_PARAMS.lateralMargin);
const legacyKeyFor = (revision) => ({ baseSnapshotHash: revision, vehicleConfigHash: "car-v1", kernelBuildId: "fixture-build-v1", surfaceVersion: 3, queryVersion: 4,
  snapshotCompilerVersion: m.CITY_SOLID_COMPILER_VERSION, physicsVersion: 1, collisionVersion: 1, controllerVersion: 1, plannerVersion: 1, observerVersion: 2, manifestHash: "passability-fixture", releasePolicyVersion: 1, releaseBoundaryHash: null });
// The continuous (C) engine's calibrated identity: physics/collision/query versions + a vehicle config naming collider and solver.
const keyFor = (revision) => ({ ...legacyKeyFor(revision), ...m.continuousAuditKeyFields(), kernelBuildId: "fixture-continuous-v1" });
const box = (id, role, x0, x1, y0, y1, z0, z1) => ({ id, role, shape: "box",
  corners: [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [z0, z1].map((z) => ({ x, y, z })))) });
const worldOf = (patches, { obstacles = [], sceneSolids = [], renderedSolids = [], revision = "world-fixture", current = () => true, noBuildings = true } = {}) => {
  const surface = { revision: "surface-fixture", geometryVersion: 3, patches, portals: [], renderBatches: [], report: { candidateLength: 0, geometricallyEligibleLength: 0, issues: [] } };
  const regions = m.buildSurfaceRegions(surface, m.buildSurfaceIndex(surface)); assert.equal(regions.status, "ready");
  const snapshot = { revision, surface, obstacles, landings: [], counts: { bridges: 0, expresswaySegments: 0, flares: 0, islands: 0, culDeSacs: 0 },
    obstacleCoverage: renderedSolids.length ? "structures-and-rendered-buildings" : "structures-only", renderedSolids, sceneSolids };
  const built = m.passabilityWorld(snapshot, regions, current, { declareNoBuildings: noBuildings }); assert.equal(built.status, "ready"); return built.world;
};
// A 6-wide, 100-long road with sidewalks; routes run along its centreline.
const road = (keep) => patch("road", "carriageway", grid(-50, -3, 50, 3, 50, 6, () => 0, keep));
const walks = [patch("walk-n", "sidewalk", grid(-50, 3, 50, 4.5, 25, 1)), patch("walk-s", "sidewalk", grid(-50, -4.5, 50, -3, 25, 1))];
const route = { id: "east", units: ["edge:e:fwd"], path: [{ x: -40, z: 0 }, { x: 40, z: 0 }], halfWidth: 3.5 };
const audit = (world, r = route, options) => m.auditRoute(world, keyFor(world.worldRevision), r, options);

// ── Passed: a validated run over an open road, bound to the world revision ──
{
  const world = worldOf([road(), ...walks]);
  const r = audit(world);
  assert.equal(r.verdict, "passed", JSON.stringify(r)); assert.equal(r.cause, "none"); assert.equal(r.witness, null);
  assert.equal(r.worldRevision, "world-fixture"); assert.equal(r.run.verdict, "passed"); assert.equal(r.auditVersion, m.ROAD_PASSABILITY_AUDIT_VERSION);
  assert.deepEqual(r.evidence.map((e) => [e.unitId, e.topology, e.geometry, e.witness]), [["edge:e:fwd", "passed", "passed", null]]);
  // Release policy consumes the same evidence; without a final boundary hash it is still pending.
  const manifest = { key: r.key, units: [{ id: "edge:e:fwd", kind: "directed-edge" }, { id: "spawn", kind: "spawn-access" }], exclusions: [{ unitId: "spawn", reason: "fixture" }],
    cases: [{ ...r.run && { id: "east" }, units: ["edge:e:fwd"], start: { x: -40, y: 0, z: 0, heading: 0, speed: 0, steering: 0, distance: 0, braking: false, reversing: false, pitch: 0, roll: 0, surfaceId: "region:ground:road" },
      gates: [{ id: "g", x: 40, y: 0, z: 0, forwardX: 1, forwardZ: 0, halfWidth: 5, heightTolerance: 0.5, surfaceIds: ["region:ground:road"] }],
      corridor: { surfaceSequence: ["region:ground:road"], portalSequence: [], waypoints: route.path }, policy: { cruiseSpeed: 7, maxReverseSpeed: 0 }, maxTicks: 4000, maxNoProgressTicks: 240 }] };
  const release = m.evaluateAuditRelease(manifest, r.evidence, [r.run]);
  assert.equal(release.units.find((u) => u.unitId === "edge:e:fwd").reason, "final-boundary-replay-required");
}

// ── Blocked with a witness: an exact pier across the road; a neck narrower than the car; disconnected regions ──
{
  const world = worldOf([road(), ...walks], { obstacles: [box("pier", "expressway-pier", -1, 1, 0, 6, -3.2, 3.2)] });
  const r = audit(world);
  assert.equal(r.verdict, "blocked"); assert.equal(r.cause, "geometry-blocked");
  assert.equal(r.witness.kind, "cut"); assert.ok(r.witness.limits.includes("structure:pier"), JSON.stringify(r.witness));
  assert.ok(r.witness.station > 38 && r.witness.station < 42, `witness sits at the pier (${r.witness.station})`);
  assert.equal(r.evidence[0].geometry, "blocked"); assert.match(r.evidence[0].witness, /^cut@/);
  assert.ok(r.run && r.run.verdict !== "passed", "the run agrees");
  // A pier leaving a lane wider than the car is not evidence: the cut only claims what no body can pass.
  const partial = audit(worldOf([road(), ...walks], { obstacles: [box("pier", "expressway-pier", -1, 1, 0, 6, -3.2, 0)] }));
  assert.equal(partial.witness, null); assert.notEqual(partial.verdict, "blocked");
  // A pier high enough to drive under is no obstacle at body height.
  assert.equal(audit(worldOf([road(), ...walks], { obstacles: [box("deck", "expressway-pier", -1, 1, 2, 3, -3.2, 3.2)] })).verdict, "passed");
}
{
  // Neck 2.0 wide (a car body needs 2·(half width + 0.2) ≈ 2.06) over x ∈ [−2, 2].
  const neck = road((i, j) => !(i >= 24 && i < 26 && (j < 2 || j >= 4)));
  const r = audit(worldOf([neck]));
  assert.equal(r.verdict, "blocked"); assert.ok(r.witness.widest < REQUIRED && r.witness.widest > 1.9, JSON.stringify(r.witness));
  assert.ok(r.witness.limits.some((l) => l.startsWith("closed:")), "the neck's edges are the witness");
  // 3 wide passes the cut check (a car fits) — whatever the run says, it is never "blocked".
  const wide = audit(worldOf([road((i, j) => !(i >= 24 && i < 26 && (j < 1 || j >= 5)))]));
  assert.equal(wide.witness, null);
}
{
  const left = patch("left", "carriageway", grid(-50, -3, -1, 3, 25, 6)); const right = patch("right", "carriageway", grid(1, -3, 50, 3, 25, 6));
  const r = audit(worldOf([left, right]));
  assert.equal(r.verdict, "blocked"); assert.equal(r.cause, "topology-disconnected"); assert.equal(r.witness.kind, "topology");
  assert.equal(r.run, null, "no run is needed to prove a disconnected route"); assert.equal(r.evidence[0].topology, "blocked");
}

// ── Inconclusive: a failed pilot, a proxy-only obstacle, incomplete coverage, stale world, key mismatch ──
{
  // An island blocking the north half (3 of 6) 4 long: a car fits beside it (no witness), but the centreline pilot hits it.
  const island = road((i, j) => !(i >= 24 && i < 26 && j >= 3));
  const r = audit(worldOf([island]));
  assert.equal(r.witness, null); assert.equal(r.verdict, "inconclusive", JSON.stringify(r)); assert.notEqual(r.cause, "geometry-blocked");
  assert.equal(r.evidence[0].geometry, "passed", "static check found no blocker");
}
{
  // The same full-width obstacle as a scene PROXY (conservative bounding box): the run is stopped, but a
  // proxy can never certify "blocked".
  const proxy = { id: "scene:wall", role: "city-shafts", kind: "box", center: { x: 0, y: 3, z: 0 }, halfAxes: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 3.2 }] };
  const r = audit(worldOf([road(), ...walks], { sceneSolids: [proxy] }));
  assert.equal(r.verdict, "inconclusive"); assert.equal(r.witness, null); assert.ok(r.run && r.run.verdict !== "passed");
}
{
  const rendered = [{ id: "tower", role: "building", positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), transforms: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }];
  const r = audit(worldOf([road(), ...walks], { renderedSolids: rendered }));
  assert.equal(r.verdict, "inconclusive"); assert.equal(r.detail, "solid-coverage-incomplete", "rendered buildings without proxies were never driven against");
  const planOnly = audit(worldOf([road(), ...walks], { noBuildings: false }));
  assert.equal(planOnly.detail, "solid-coverage-incomplete", "a capture without a scene never certifies a pass");
}
{
  let current = true; const world = worldOf([road(), ...walks], { current: () => current });
  current = false;
  const r = audit(world); assert.equal(r.verdict, "inconclusive"); assert.equal(r.detail, "stale-world");
  // Stale MID-RUN: the run's own currency check is throttled, the verdict's is not — the result is discarded.
  let calls = 0; const midRun = worldOf([road(), ...walks], { current: () => ++calls < 20 });
  const discarded = audit(midRun); assert.equal(discarded.verdict, "inconclusive"); assert.equal(discarded.detail, "stale-world");
  const fresh = worldOf([road(), ...walks]);
  const mismatch = m.auditRoute(fresh, keyFor("another-world"), route);
  assert.equal(mismatch.verdict, "inconclusive"); assert.equal(mismatch.detail, "key-world-mismatch");
  const compilerMismatch = m.auditRoute(fresh, { ...keyFor(fresh.worldRevision), snapshotCompilerVersion: 1 }, route);
  assert.equal(compilerMismatch.verdict, "inconclusive"); assert.equal(compilerMismatch.detail, "key-compiler-mismatch");
  assert.equal(audit(fresh, { ...route, path: [{ x: -40, z: 0 }] }).detail, "invalid-route");
}
// ── Continuous engine (B4): calibrated key, recovered starts, legacy comparison ──
{
  const world = worldOf([road(), ...walks]);
  const legacyKey = m.auditRoute(world, legacyKeyFor(world.worldRevision), route);
  assert.equal(legacyKey.detail, "key-engine-mismatch", "a legacy key never certifies a continuous run");
  const legacy = m.auditRoute(world, legacyKeyFor(world.worldRevision), route, { engine: "legacy" });
  assert.equal(legacy.verdict, "passed", "the legacy whole-step engine stays available for comparison");
  // A short barrier across the centreline at the route start: SafeRecovery moves the start (forward,
  // the nearest legal pose), the new case passes.
  const parked = { id: "scene:van", role: "city-shafts", kind: "box", center: { x: -40, y: 1, z: 0 }, halfAxes: [{ x: 0.3, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1.2 }] };
  const r = audit(worldOf([road(), ...walks], { sceneSolids: [parked] }));
  assert.equal(r.verdict, "passed", JSON.stringify(r.detail)); assert.match(r.detail, /recovered-start:/);
  assert.equal(r.run.caseId, "east:recovered", "a recovered start is a separate case");
}
{
  // Gates follow the performed trajectory: the chord (9,0)→(11,0) would cross inside, the real slid path
  // crosses 2.5 off-centre and deviates.
  const gate = { id: "g", x: 10, y: 0, z: 0, forwardX: 1, forwardZ: 0, halfWidth: 3, heightTolerance: 0.5, surfaceIds: ["r"] };
  const test = { id: "t", units: ["u"], start: { x: 0, y: 0, z: 0, heading: 0, speed: 0, steering: 0, distance: 0, braking: false, reversing: false, pitch: 0, roll: 0, surfaceId: "r" },
    gates: [gate], corridor: { surfaceSequence: ["r"], portalSequence: [], waypoints: [{ x: 0, z: 0 }, { x: 20, z: 0 }] }, policy: { cruiseSpeed: 7, maxReverseSpeed: 0 }, maxTicks: 10, maxNoProgressTicks: 10 };
  const ok = { validateStart: () => "valid", validate: () => "valid", progress: (s) => s.x };
  const pose = (x, z) => ({ x, y: 0, z, heading: 0, pitch: 0, roll: 0, surfaceId: "r" });
  const prev = { ...test.start, x: 6 }; const next = { ...test.start, x: 14 };
  const chord = new m.GateAuditObserver(test, ok).observe(prev, { state: next, motion: { blocked: false, reason: null } });
  assert.equal(chord.status, "complete", "without a trajectory the chord is the motion (compatibility)");
  const slid = new m.GateAuditObserver(test, ok).observe(prev, { state: next, motion: { blocked: false, reason: null, trajectory: [pose(6, 0), pose(14, 5), pose(14, 0)] } });
  assert.equal(slid.status, "route-deviation", "the trajectory, not its chord, decides the gate");
  // Corridor checks every trajectory piece.
  const corridor = new m.CorridorValidator(ok, [{ x: 0, z: 0 }, { x: 20, z: 0 }], 3);
  assert.equal(corridor.validate(prev, { state: next, motion: { blocked: false, reason: null, trajectory: [pose(6, 0), pose(10, 4), pose(14, 0)] } }), "route-deviation");
  assert.equal(corridor.validate(prev, { state: next, motion: { blocked: false, reason: null, trajectory: [pose(6, 0), pose(10, 1), pose(14, 0)] } }), "valid");
}

// ── Route builder: both directions, trimmed off the node fans ──
{
  const routes = m.directedEdgeRoutes([{ id: "e1", points: [{ x: 0, z: 0 }, { x: 50, z: 0 }], width: 6 }, { id: "tiny", points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], width: 6 }]);
  assert.deepEqual(routes.map((r) => r.id), ["edge:e1:fwd", "edge:e1:rev"]);
  assert.deepEqual(routes[0].path, [{ x: 6, z: 0 }, { x: 44, z: 0 }]); assert.deepEqual(routes[1].path, [{ x: 44, z: 0 }, { x: 6, z: 0 }]);
}
console.log("Road passability (continuous engine): passed from a validated run (bound to world revision, release-policy evidence), blocked only with witnesses (exact pier cut, neck narrower than the body, disconnected regions), inconclusive for pilot failure, proxy-only obstacles, incomplete solid coverage, stale world and key mismatch; calibrated continuous key, SafeRecovery start as a new case, legacy comparison, trajectory-judged gates and corridor passed.");

// ── Real rendered cities: CityParts scene → frozen display lease → CitySurfacePort → audit ──
if (process.argv.includes("--cities")) {
  const { sceneKit, buildParts } = await import("./city-kit/scene-parts.mjs");
  const kit = await sceneKit({ "engine/surface/citySurfacePort.ts": ["CitySurfacePort"], "game/driving/audit/RoadPassabilityAudit.ts": ["auditCapture", "directedEdgeRoutes"] });
  const engine = process.env.PASSABILITY_ENGINE === "legacy" ? "legacy" : "continuous";
  const perScene = Number(process.env.PASSABILITY_EDGES ?? 12);
  const totals = { routes: 0, passed: 0, blocked: 0, inconclusive: 0 }; const causes = {}; const witnesses = [];
  // PASSABILITY_SCENES="500/42,0/42" and PASSABILITY_ROUTES="edge:a:fwd,…" narrow the run (comparisons).
  const sceneFilter = process.env.PASSABILITY_SCENES ? new Set(process.env.PASSABILITY_SCENES.split(",")) : null;
  const routeFilter = process.env.PASSABILITY_ROUTES ? new Set(process.env.PASSABILITY_ROUTES.split(",")) : null;
  const notPassed = [];
  for (const sessions of [0, 90, 500]) for (const seed of [1, 7, 42, 2026, 65537]) {
    if (sceneFilter && !sceneFilter.has(`${sessions}/${seed}`)) continue;
    const { parts } = buildParts(kit, sessions, seed);
    const lease = parts.acquireDrivingWorldSource();
    try {
      const port = new kit.CitySurfacePort();
      const capture = await port.capture(lease.source); assert.equal(capture.status, "ready");
      const edges = lease.source.layout.roadEdges.filter((e) => e.points.length >= 2).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, perScene);
      const routes = kit.directedEdgeRoutes(edges).filter((r) => !routeFilter || routeFilter.has(r.id));
      const audited = kit.auditCapture(capture, engine === "legacy" ? legacyKeyFor : keyFor, routes, { engine });
      assert.equal(audited.status, "ready", audited.reason);
      const outcome = {};
      for (const r of audited.results) {
        assert.equal(r.worldRevision, capture.worldRevision, "every result is bound to the captured world");
        assert.ok(r.verdict !== "blocked" || r.witness, "blocked always carries a witness");
        assert.ok(r.verdict !== "passed" || (r.run?.verdict === "passed" && r.cause === "none"), "passed always comes from a validated run");
        assert.notEqual(r.detail, "passed-against-witness", `${sessions}/${seed} ${r.routeId}: a run passed through a certified block`);
        totals.routes++; totals[r.verdict]++;
        const k = `${r.verdict}:${r.cause}`; outcome[k] = (outcome[k] ?? 0) + 1; causes[k] = (causes[k] ?? 0) + 1;
        if (r.witness) witnesses.push(`${sessions}/${seed} ${r.routeId} ${r.evidence[0].witness}`);
        if (r.verdict !== "passed") notPassed.push(`${sessions}/${seed} ${r.routeId} ${r.verdict}:${r.cause} ${r.detail}`);
      }
      // The same results go stale the moment the frozen world is released.
      lease.release();
      assert.equal(capture.isCurrent(), false, "releasing the display freeze retires the capture");
      console.log(`Road passability: ${sessions} sessions, seed ${seed}: ${routes.length} directed routes on ${capture.worldRevision.slice(0, 32)}… → ${JSON.stringify(outcome)}.`);
    } finally { lease.release(); }
  }
  for (const n of notPassed) console.log(`  not passed ${n}`);
  if (!routeFilter) assert.ok(totals.passed > 0, "real roads pass the audit");
  console.log(`Road passability (${engine}): ${totals.routes} real directed routes → ${totals.passed} passed, ${totals.blocked} blocked (witnessed), ${totals.inconclusive} inconclusive ${JSON.stringify(causes)}.`);
  for (const w of witnesses.slice(0, 20)) console.log(`  witness ${w}`);
}
