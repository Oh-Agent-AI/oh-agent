#!/usr/bin/env node
// Structure descriptors (bridges, expressways, truss, channelised mouths, cul-de-sacs):
// render-neutral extraction, exact BOX/cylinder top faces vs THREE, the aggregate driving
// surface (layers, landings, obstacles) and same-kernel crossings. --cities: fifteen plans.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCity, cachedPlan } from "./city-kit/index.mjs";
import { structureRenderDigests } from "./city-kit/structure-render-digest.mjs";
import { makeRoutePilot } from "./city-kit/route-pilot.mjs";
const kit = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/systems/roadSystem.ts": ["buildInfrastructure", "buildDistrictExpressways", "buildTrussBridges", "buildCulDeSacBulbs", "buildChannelizedJunctions"],
  "engine/surface/structureCompiler.ts": ["eulerMatrix", "boxPoint", "boxTopFace", "bridgeDeckParts", "expresswayPieces", "culDeSacDiscs", "culDeSacTopCap", "trussBars", "trussBarPart"],
  "engine/surface/compileSurface.ts": ["compileCitySurface", "landingConnectivity", "CITY_SURFACE_GEOMETRY_VERSION"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions"],
  "game/driving/surfaceFootprint.ts": ["footprintSupport"],
  "game/driving/SurfaceDrivingWorld.ts": ["SurfaceDrivingEnvironment", "SurfaceWorldValidator", "polylineProgress"],
  "game/driving/DrivingKernel.ts": ["DrivingKernel"],
  "game/driving/citySolids.ts": ["cityCollisionIndex"],
  "game/DrivingSimulation.ts": ["initialDrivingState"],
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/surface/citySurfacePort.ts": ["CitySurfacePort"],
  "engine/surface/groundRoadCompiler.ts": ["compileGroundRoadSurface"],
});
const { THREE } = kit;
const close = (a, b, eps = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b}`);

// ── Pure Euler/BOX transform equals THREE's compose for every order the renderer uses ──
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3();
  let k = 0;
  for (const order of ["XYZ", "YZX", "YXZ"]) for (let i = 0; i < 40; i++) {
    const r = (s) => Math.sin(++k * s) * 2.7;
    const part = { x: r(1.3) * 40, y: r(0.7) * 5, z: r(2.1) * 40, sx: 1 + Math.abs(r(0.9)) * 8, sy: 0.2 + Math.abs(r(1.7)), sz: 0.5 + Math.abs(r(0.4)) * 6, rx: r(0.31), ry: r(0.53), rz: r(0.29), order, color: "#fff", role: "truss" };
    e.set(part.rx, part.ry, part.rz, order); q.setFromEuler(e);
    m.compose(new THREE.Vector3(part.x, part.y, part.z), q, new THREE.Vector3(part.sx, part.sy, part.sz));
    for (const [lx, ly, lz] of [[-0.5, 1, -0.5], [0.5, 0, 0.5], [0.5, 1, -0.5], [0, 0.5, 0]]) {
      v.set(lx, ly, lz).applyMatrix4(m); const p = kit.boxPoint(part, lx, ly, lz);
      close(p.x, v.x, 1e-9, `${order} x`); close(p.y, v.y, 1e-9, `${order} y`); close(p.z, v.z, 1e-9, `${order} z`);
    }
  }
  // Cul-de-sac top cap equals the renderer's CylinderGeometry(…,20) top ring under its own matrix.
  const disc = { x: 12, z: -7, radius: 7.5, base: 2.3, gx: 0.08, gz: -0.05 };
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 20).translate(0, 0.5, 0);
  const normal = new THREE.Vector3(-disc.gx, 1, -disc.gz).normalize(); q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  m.compose(new THREE.Vector3(disc.x, disc.base + 0.02, disc.z), q, new THREE.Vector3(disc.radius, 0.12, disc.radius));
  const cap = kit.culDeSacTopCap(disc); const pos = geometry.getAttribute("position");
  for (let i = 0; i < 20; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); close(cap.rim[i].x, v.x, 1e-6, "rim x"); close(cap.rim[i].y, v.y, 1e-6, "rim y"); close(cap.rim[i].z, v.z, 1e-6, "rim z"); }
}

// ── Synthetic layouts ──
const node = (p) => `${p.x}:${p.z}`;
const edge = (a, b, width = 5, extra = {}) => ({ id: `${node(a)}/${node(b)}`, from: node(a), to: node(b), points: [a, b], width, kind: width >= 8 ? "arterial" : "local", ...extra });
const city = (roadEdges, height = () => 2, extra = {}) => ({ extent: 400, terrain: { height }, roadEdges, highways: [], bridges: [], landmarks: [], culDeSacEnds: [], ...extra });
const W = { x: -60, z: 0 }, A = { x: -20, z: 0 }, B = { x: 20, z: 0 }, E = { x: 60, z: 0 };
const span = (a = A, b = B, extra = {}) => edge(a, b, 5, { bridge: true, structure: "deck", ...extra });
const build = (layout) => {
  const c = kit.compileCitySurface(layout); const surface = { ...c.surface, revision: "fixture" };
  const index = kit.buildSurfaceIndex(surface); assert.equal(index.status, "ready");
  const regions = kit.buildSurfaceRegions(surface, index); assert.equal(regions.status, "ready");
  return { c, surface, regions };
};
const key = { baseSnapshotHash: "synthetic-structure-v1", vehicleConfigHash: "car-v1", kernelBuildId: "fixture-build-v1",
  surfaceVersion: 2, queryVersion: 2, snapshotCompilerVersion: 1, physicsVersion: 1, collisionVersion: 1, controllerVersion: 1, plannerVersion: 1, observerVersion: 1, manifestHash: "x", releasePolicyVersion: 1, releaseBoundaryHash: null };
/** Drive straight along +x from (x0, z) with a bounded lane-keeping pilot; every tick independently validated. */
const drive = (regions, x0, z, x1) => {
  const env = new kit.SurfaceDrivingEnvironment(regions); const kernel = new kit.DrivingKernel(env, key);
  const start = regions.classify(x0, z, "ground"); assert.equal(start.status, "drivable");
  let s = { ...kit.initialDrivingState(x0, z, 0, start.regionId), ...env.place(x0, z, 0, start.regionId) };
  const validator = new kit.SurfaceWorldValidator(regions, kit.polylineProgress([{ x: x0, z }, { x: x1, z }]));
  assert.equal(validator.validateStart(s), "valid");
  for (let tick = 0; tick < 3000 && s.x < x1; tick++) {
    const err = -s.heading - (s.z - z) * 0.3;
    const step = kernel.step(s, { forward: true, backward: false, left: err < -0.02, right: err > 0.02 });
    assert.equal(validator.validate(s, step), "valid", `tick ${tick}`);
    if (step.motion.blocked) return { reached: false, x: s.x, reason: step.motion.reason, maxY: s.y };
    s = step.state;
  }
  return { reached: s.x >= x1, x: s.x, maxY: s.y };
};
{
  // Level banks: both landings aligned, the deck joins the ground region, the car crosses.
  const { c, regions } = build(city([edge(W, A), span(), edge(B, E)]));
  assert.equal(c.surface.geometryVersion, kit.CITY_SURFACE_GEOMETRY_VERSION);
  assert.deepEqual(c.landings.map((l) => [l.end, l.status, l.layerId]), [["from", "aligned", "ground"], ["to", "aligned", "ground"]]);
  const deck = c.surface.patches.find((p) => p.kind === "bridge-deck");
  assert.ok(deck && deck.layerId === "ground");
  assert.equal(regions.classify(0, 0, "ground").regionId, regions.classify(-40, 0, "ground").regionId, "deck and both roads are one region");
  assert.equal(regions.classify(0, 2.4, "ground").status, "blocked", "railing band is not drivable (inner face at width/2 − 0.3)");
  assert.ok(c.obstacles.some((o) => o.role === "bridge-railing") && c.obstacles.every((o) => o.shape !== "box" || o.corners.every((p) => Number.isFinite(p.x + p.y + p.z))));
  assert.deepEqual(kit.landingConnectivity(c, regions).map((x) => x.reason), ["connected", "connected"]);
  const run = drive(regions, -40, 0, 40); assert.ok(run.reached, `crosses the level bridge (${JSON.stringify(run)})`);
}
{
  // West bank 0.6 lower: the deck now slopes from one landing's road surface to the other's.
  // (Before the fix the deck was level at the higher bank: a 0.56 step at the west landing.)
  const { c, regions } = build(city([edge(W, A), span(), edge(B, E)], (x) => (x < 0 ? 2 : 2.6)));
  const decks = c.surface.patches.filter((p) => p.kind === "bridge-deck");
  const ys = decks.flatMap((deck) => { const values = []; for (let i = 1; i < deck.vertices.length; i += 3) values.push(deck.vertices[i]); return values; });
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.55, "the deck is pitched between the two banks");
  assert.ok(c.landings.every((l) => l.status === "aligned"), JSON.stringify(c.landings.map((l) => l.step)));
  assert.deepEqual(kit.landingConnectivity(c, regions).map((x) => x.connected), [true, true]);
  const run = drive(regions, -40, 0, 40); assert.ok(run.reached, `climbs across the sloped bridge (${JSON.stringify(run)})`);
}
{
  // Opposite cross slopes require multiple roll-transition slabs, shared with the renderer.
  const { c, regions } = build(city([edge(W, A), span(), edge(B, E)], (x, z) => 2 + (x < 0 ? 0.06 : -0.06) * z));
  assert.ok(c.surface.patches.filter(p=>p.kind==="bridge-deck").length>1,"opposite bank leans split the deck");
  assert.ok(kit.landingConnectivity(c, regions).every((x) => x.connected), "both bank leans meet the segmented deck");
  assert.equal(drive(regions, -40, 0, 40).reached, true);
}
{
  // Dangling span over open water: the end with no road keeps the landed height (no dip into the sea).
  const { c } = build(city([edge(W, A), span()], (x) => (x > 0 ? -3 : 2)));
  const deck = c.surface.patches.find((p) => p.kind === "bridge-deck");
  for (let i = 1; i < deck.vertices.length; i += 3) close(deck.vertices[i], 2.04, 1e-4, "dangling deck stays level at its landing");
  assert.equal(c.landings.find((l) => l.end === "to").status, "no-ground");
}
{
  // Overpass: a ground road runs under the span → the deck is its own layer, the road below is unaffected;
  // the deck joins its approaches only through the landing portals the region rules validate (v4).
  const N = { x: 0, z: -40 }, S = { x: 0, z: 40 };
  const { c, regions } = build(city([edge(W, A), span(), edge(B, E), edge(N, S)]));
  const deck = c.surface.patches.find((p) => p.kind === "bridge-deck");
  assert.ok(deck.layerId.startsWith("bridge:")); assert.ok(c.landings.every((l) => l.status === "layered"));
  assert.equal(c.surface.portals.length,2,"both proven overpass landings produce explicit geometric portals");
  assert.ok(c.surface.portals.every((p)=>p.validated&&p.fromPatch.startsWith("bridge:")&&p.clearance>4));
  assert.equal(regions.classify(0, 10, "ground").status, "drivable", "the road under the deck stays drivable");
  assert.equal(regions.classify(0, 0, deck.layerId).status, "drivable");
  assert.ok(regions.report.portals.length > 0 && regions.report.portals.every((p) => p.status === "open" && p.fromPatch.startsWith("bridge:")), "portals only from the deck to its landing pieces");
  assert.deepEqual(kit.landingConnectivity(c, regions).map((x) => x.connected), [true, true], "both landings connect through their portals");
  assert.ok(drive(regions, -40, 0, 40).reached, "the kernel crosses the overpass");
  const isolated = kit.buildSurfaceRegions({ ...c.surface, revision: "fixture", portals: [] }, kit.buildSurfaceIndex({ ...c.surface, revision: "fixture", portals: [] }));
  assert.notEqual(isolated.classify(0, 0, deck.layerId).regionId, isolated.classify(-40, 0, "ground").regionId, "without portals there is no implicit cross-layer link");
}
{
  // Dangling far end and a multi-point bridge.
  const { c } = build(city([edge(W, A), span()]));
  assert.equal(c.landings.find((l) => l.end === "to").status, "no-ground");
  const bent = { ...span(), points: [A, { x: 0, z: 5 }, B] };
  const issues = build(city([edge(W, A), bent, edge(B, E)])).c.surface.report.issues;
  assert.ok(issues.some((i) => i.source.id === `bridge:${bent.id}` && i.reason === "unsupported"), "multi-point bridges are rejected, not drawn as decks");
}
{
  // Expressway: own layer, actual tilted deck tops, ramp ends landed on the rendered road surface.
  const points = Array.from({ length: 11 }, (_, i) => ({ x: -100 + i * 20, z: 60 }));
  const { c, regions } = build(city([edge({ x: -120, z: 60 }, { x: 120, z: 60 }, 12)], () => 2, { highways: [points] }));
  const decks = c.surface.patches.filter((p) => p.layerId === "expressway:0");
  assert.equal(decks.length, 20, "ramp-zone segments are drawn as ≤ 10-unit pieces sampling the eased profile");
  const mid = regions.classify(0, 60, "expressway:0"); assert.equal(mid.status, "drivable"); close(mid.y, 9.1, 1e-4, "mid deck top");
  assert.ok(c.landings.filter((l) => l.structureId === "expressway:0").every((l) => l.status === "layered" && Math.abs(l.step) < 0.02), "ramp ends meet the rendered road (was a 0.26 step)");
  assert.equal(regions.classify(0, 60, "ground").status, "drivable", "the road under the expressway is its own layer");
  // Cross-layer portals at both ramp ends: validated by the region rules, the kernel climbs to the deck.
  assert.ok(regions.report.portals.length >= 2 && regions.report.portals.every((p) => p.status === "open"), JSON.stringify(regions.report.portals.map((p) => p.reason)));
  assert.ok(kit.landingConnectivity(c, regions).filter((x) => x.landing.structureId === "expressway:0").every((x) => x.connected), "both ramp ends join the road's region");
  const up = makeRoutePilot(kit, key)(regions, [{ x: -112, z: 60 }, ...points], { until: 12 + 110 });
  assert.equal(up.result, "ok"); assert.ok(up.maxY > 9, `the kernel drives up the ramp to the deck (max y ${up.maxY})`);
  assert.equal(regions.classify(0, 65.2, "expressway:0").status, "blocked", "rails bound the deck at ±4.95");
}
{
  // Channelised 40° T: flare is drivable junction surface, the island is a curb hole.
  const DEG = Math.PI / 180; const J = { x: 0, z: 0 };
  const tee = [edge({ x: -60, z: 0 }, J), edge({ x: 60, z: 0 }, J), edge({ x: Math.cos(40 * DEG) * 60, z: Math.sin(40 * DEG) * 60 }, J)];
  const { c, regions } = build(city(tee));
  assert.equal(c.counts.islands, 1); assert.equal(c.counts.flares, 2);
  const island = c.obstacles.find((o) => o.role === "island");
  const cx = island.ring.reduce((n, p) => n + p.x, 0) / island.ring.length, cz = island.ring.reduce((n, p) => n + p.z, 0) / island.ring.length;
  assert.equal(regions.classify(cx, cz, "ground").cause, "island");
}
{
  // Cul-de-sac disc: the turnaround beyond the road width is drivable and joins the road's region.
  const end = { x: 60, z: 0 };
  const { c, regions } = build(city([edge(W, end)], () => 2, { culDeSacEnds: [end] }));
  assert.equal(c.counts.culDeSacs, 1);
  const bulb = regions.classify(62, 4.5, "ground"); assert.equal(bulb.status, "drivable"); close(bulb.y, 2.08, 1e-4, "disc top = road top 2.04 + 0.04");
  assert.equal(bulb.regionId, regions.classify(30, 0, "ground").regionId, "a 0.04 lip is within the seam tolerance");
  const overlap = regions.classify(57, 0, "ground"); assert.equal(overlap.status, "drivable", "where disc and road overlap the car is on one region, not ambiguous");
}
{
  // Host snapshot port: lazy compile + SHA-256 revision, cached per source, invalidation and cancellation.
  const layout = city([edge(W, A), span(), edge(B, E)]);
  const source = { layout, ground: kit.compileGroundRoadSurface(layout) };
  const port = new kit.CitySurfacePort();
  assert.equal((await port.capture(null)).status, "unavailable");
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await port.capture(source, aborted.signal)).status, "cancelled");
  const first = await port.capture(source);
  assert.equal(first.status, "ready"); assert.match(first.revision, new RegExp(`^surface-v${kit.CITY_SURFACE_GEOMETRY_VERSION}:sha256:[a-f0-9]{64}$`));
  const frozenWorld = first.readWorld();
  assert.ok(frozenWorld.surface.patches.some((p) => p.kind === "bridge-deck"));
  const deckObstacleCount = frozenWorld.obstacles.filter((o) => o.role === "bridge-deck").length;
  const railingObstacleCount = frozenWorld.obstacles.filter((o) => o.role === "bridge-railing").length;
  assert.ok(deckObstacleCount >= 2 && railingObstacleCount >= 2,
    "the captured world carries the segmented deck slabs and its railings");
  const capturedCollision = kit.cityCollisionIndex(frozenWorld.obstacles, frozenWorld.sceneSolids ?? []);
  assert.ok(capturedCollision.report.byRole["bridge-deck"] === deckObstacleCount && capturedCollision.report.byRole["bridge-railing"] === railingObstacleCount,
    "same captured structural facts compile into the collision index without an escaping port capability");
  assert.equal(await port.capture(source), first, "same rendered source reuses the published snapshot");
  const copy = first.read(); copy.patches[0].vertices[0] += 99;
  assert.notEqual(first.read().patches[0].vertices[0], copy.patches[0].vertices[0], "reads are defensive copies");
  port.invalidate();
  assert.equal(first.read(), null, "an invalidated capture never reads the next city");
  const again = await port.capture(source);
  assert.equal(again.revision, first.revision, "same content → same revision after invalidation");
  const racing = port.capture({ layout, ground: kit.compileGroundRoadSurface(layout) }); port.invalidate();
  assert.equal((await racing).status, "stale", "a capture overtaken by a city change is stale");
}
console.log("Structure surface: THREE-exact BOX/cylinder tops, level/sloped/roll-transition bridges crossed by the kernel, dangling deck stays level, overpass layering, dangling/multi-point bridges, expressway layer and rails, channelised island, cul-de-sac turnaround, host snapshot port passed.");

if (process.argv.includes("--cities")) {
  const baselineFile = JSON.parse(readFileSync(new URL("../fixtures/city-driving/structure-render-baseline.json", import.meta.url), "utf8"));
  const baseline = baselineFile.plans; const correctedPlans = baselineFile.corrected.plans;
  const totals = { bridges: 0, landings: 0, connected: 0, crossings: 0, routedCrossings: 0, crossable: 0, ramps: 0, rampsConnected: 0, rampsUp: 0, rampsDown: 0 };
  const reasons = {}; const failures = []; const rampFailures = []; const axisOnly = [];
  for (const seed of [1, 7, 42, 2026, 65537]) for (const tier of [1, 2, 3]) {
    const plan = cachedPlan(kit.createCityPlan, seed, tier);
    const digests = await structureRenderDigests(kit, plan);
    // Bridge decks and trusses (sloped decks) and expressways (ramp ends landed on the road) changed
    // by design; everything else — curbs included — must still equal the pre-descriptor renderer.
    const before = baseline[`${seed}/${tier}`]; const corrected = correctedPlans[`${seed}/${tier}`];
    for (const name of Object.keys(before)) {
      const expected = baselineFile.landmarkPlatforms?.plans?.[`${seed}/${tier}`]?.[name] ?? baselineFile.bridgeLandingBlend?.plans?.[`${seed}/${tier}`]?.[name] ?? baselineFile.planRefresh?.plans?.[`${seed}/${tier}`]?.[name] ?? baselineFile.terrainResolution?.plans?.[`${seed}/${tier}`]?.[name] ?? baselineFile.bridgeheadTruss?.plans?.[`${seed}/${tier}`]?.[name] ?? baselineFile.portalPiers?.plans?.[`${seed}/${tier}`]?.[name] ?? baselineFile.rollTransition?.plans?.[`${seed}/${tier}`]?.[name] ?? (name === "buildInfrastructure" || name === "buildTrussBridges" ? corrected[name] : corrected[name] ?? before[name]);
      assert.equal(digests[name], expected, `seed ${seed} tier ${tier}: ${name} render output changed`);
    }
    const { c, regions } = build(plan);
    assert.deepEqual(c.surface.report.issues.filter((i) => i.reason !== "unsupported"), [], "every compiled patch has a manifold boundary");
    const connectivity = kit.landingConnectivity(c, regions).filter((x) => x.landing.structureId.startsWith("bridge:"));
    totals.bridges += c.counts.bridges; totals.landings += connectivity.length;
    for (const x of connectivity) { reasons[x.reason] = (reasons[x.reason] ?? 0) + 1; if (x.connected) totals.connected++; }
    // A bridge is crossable only when BOTH landings join the deck's region. Two same-kernel runs each:
    // the span itself (must pass), and approach → approach along the axis (counted; a straight pilot
    // cannot follow an angled approach, and a local landing conflict is reported, not hidden).
    const env = new kit.SurfaceDrivingEnvironment(regions); const kernel = new kit.DrivingKernel(env, key);
    // 起点按它所在的层分类：跨度用例从桥面上起步，必须问桥面层。structure: "deck" 的桥面是独立层，
    // 离开落地点几米后 ground 层上根本没有面——旧代码一律问 ground，7/2 的桥面整段可驶，却报 start:no-surface。
    const run = (from, ux, uz, s0, s1, layerId = "ground") => {
      const heading = Math.atan2(uz, ux); const sx = from.x + ux * s0, sz = from.z + uz * s0;
      const start = regions.classify(sx, sz, layerId); if (start.status !== "drivable") return `start:${start.cause}`;
      const placed = env.place(sx, sz, heading, start.regionId); if (!placed) return "start:footprint";
      let s = { ...kit.initialDrivingState(sx, sz, heading, start.regionId), ...placed };
      const validator = new kit.SurfaceWorldValidator(regions, kit.polylineProgress([{ x: sx, z: sz }, { x: from.x + ux * s1, z: from.z + uz * s1 }]));
      for (let tick = 0; tick < 4000; tick++) {
        const lateral = -(s.x - from.x) * uz + (s.z - from.z) * ux;
        const err = Math.atan2(Math.sin(heading - s.heading), Math.cos(heading - s.heading)) - lateral * 0.3;
        const step = kernel.step(s, { forward: true, backward: false, left: err < -0.02, right: err > 0.02 });
        assert.equal(validator.validate(s, step), "valid");
        if (step.motion.blocked) return `blocked@${((s.x - from.x) * ux + (s.z - from.z) * uz).toFixed(1)}:${step.motion.reason}`;
        s = step.state;
        if ((s.x - from.x) * ux + (s.z - from.z) * uz >= s1) return "ok";
      }
      return "timeout";
    };
    const drivePath = makeRoutePilot(kit, key);
    for (const id of new Set(connectivity.map((x) => x.landing.structureId))) {
      const ends = connectivity.filter((x) => x.landing.structureId === id);
      if (ends.length !== 2 || !ends.every((x) => x.connected)) continue;
      totals.crossable++;
      const [from, to] = ends.map((x) => x.landing); const ux = -from.outX, uz = -from.outZ; const len = Math.hypot(to.x - from.x, to.z - from.z);
      const reach = 1.4 + 0.25 + 0.2; // half car length + deck overhang + margin
      assert.equal(run(from, ux, uz, reach + 1, len - reach - 1, from.layerId), "ok", `seed ${seed} tier ${tier} ${id}: the open span itself is drivable`);
      const full = run(from, ux, uz, -1.5, len + reach, "ground");
      if (full === "ok") { totals.crossings++; continue; }
      // 斜接引道：直线跟不了拐弯（7/2 桥尾两条引道都拐 50° 以上，直行必压人行道），改沿真实地面引道开一遍。
      // 两端各取与「离桥方向」最一致的地面边，最多走 6；仍不通才算桥头故障。直线结果照样记在日志里。
      const leg = (l) => {
        const node = `${l.x}:${l.z}`; let best = null, bestDot = -Infinity;
        for (const e of plan.roadEdges) {
          if (e.bridge || (e.from !== node && e.to !== node)) continue;
          const pts = e.from === node ? e.points : [...e.points].reverse();
          const d = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z) || 1;
          const dot = ((pts[1].x - pts[0].x) * l.outX + (pts[1].z - pts[0].z) * l.outZ) / d;
          if (dot > bestDot) { bestDot = dot; best = { pts, d }; }
        }
        if (!best) return null;
        const t = Math.min(6, best.d * 0.8) / best.d;
        return { x: best.pts[0].x + (best.pts[1].x - best.pts[0].x) * t, z: best.pts[0].z + (best.pts[1].z - best.pts[0].z) * t };
      };
      const a = leg(from), b = leg(to);
      const routed = a && b ? drivePath(regions, [a, { x: from.x, z: from.z }, { x: to.x, z: to.z }, b]).result : "no-approach-leg";
      assert.ok(!routed.startsWith("invalid"), routed);
      if (routed === "ok") { totals.crossings++; totals.routedCrossings++; axisOnly.push(`${seed}/${tier} ${id.slice(0, 28)} axis ${full}`); }
      else failures.push(`${seed}/${tier} ${id.slice(0, 28)} axis ${full}; routed ${routed}`);
    }
    // Expressway ramps (cross-layer portals): road → ramp → elevated deck, and back down.
    for (const x of kit.landingConnectivity(c, regions).filter((x) => x.landing.structureId.startsWith("expressway:"))) {
      const l = x.landing; const run = plan.highways[Number(l.structureId.split(":")[1])];
      const upPath = [{ x: l.x + l.outX * 4, z: l.z + l.outZ * 4 }, ...(l.end === "from" ? run : [...run].reverse())];
      totals.ramps++; if (x.connected) totals.rampsConnected++;
      const up = drivePath(regions, upPath, { until: 4 + 110 });
      assert.ok(!up.result.startsWith("invalid"), up.result);
      if (up.maxY > 9) totals.rampsUp++; else rampFailures.push(`${seed}/${tier} ${l.structureId}/${l.end} up ${up.result}`);
      const lens = [0]; for (let i = 1; i < upPath.length; i++) lens.push(lens[i - 1] + Math.hypot(upPath[i].x - upPath[i - 1].x, upPath[i].z - upPath[i - 1].z));
      const k = Math.max(1, lens.findIndex((v) => v >= 100)); const t = (100 - lens[k - 1]) / (lens[k] - lens[k - 1]);
      const top = { x: upPath[k - 1].x + (upPath[k].x - upPath[k - 1].x) * t, z: upPath[k - 1].z + (upPath[k].z - upPath[k - 1].z) * t };
      const at = regions.classify(top.x, top.z, l.layerId);
      const down = at.status === "drivable" ? drivePath(regions, [top, ...upPath.slice(0, k).reverse()], { regionId: at.regionId, y: at.y }) : { result: `start:${at.cause}`, s: 0, layers: [] };
      assert.ok(!down.result.startsWith("invalid"), down.result);
      // Down counts once the car is back on the road layer within the last 4 units (the pilot's
      // off-ramp aim point can sit next to a curb).
      if (down.s >= 96 && down.layers.includes("ground")) totals.rampsDown++; else rampFailures.push(`${seed}/${tier} ${l.structureId}/${l.end} down ${down.result}`);
    }
    const conflicts = regions.report.conflicts.length;
    console.log(`Structure surface: seed ${seed}, tier ${tier}: render parity ok, ${JSON.stringify(c.counts)}, ${c.obstacles.length} obstacles, landings ${c.landings.map((l) => `${l.status}${l.step === null ? "" : `(${l.step.toFixed(2)})`}`).join(" ")}, ${regions.report.regions} regions, ${conflicts} conflicts.`);
  }
  assert.ok(totals.crossable >= 10, `sloped decks connect most landed bridges (${totals.crossable})`);
  // Regression floors measured 2026-10-16 (sloped decks): 10 bridges connect at both landings, 7 are
  // crossed approach → approach on the axis. Lower numbers mean the deck/landing geometry regressed.
  assert.ok(totals.crossings >= 7, `approach-to-approach crossings regressed (${totals.crossings}/${totals.crossable}): ${failures.join("; ")}`);
  if (failures.length) console.log(`Structure surface: landing-zone failures (reported, not opened): ${failures.join("; ")}`);
  if (axisOnly.length) console.log(`Structure surface: crossed along the real approach: ${axisOnly.join("; ")}`);
  // Floors measured 2026-10-16 (landed + densified ramps, v4 portals): all 14 ramp ends connect, 13
  // climb to the deck (one pilot start sits on a footprint-blocked approach), all 14 descend to the road.
  // 2026-10-19 重测：ad697cfa（junction rings / highway interchange planning）后这 15 个规划里高架只剩
  // 42/2、42/3 两条（8 → 2 条，坡道端 4 个）——是规划层的取舍，不是坡道几何退化：剩下的 4 个端全部
  // 接上、爬上、下来。下限改为「现存端全部通过」且不少于 4；规划层把高架加回来时这个下限自动收紧不了，
  // 届时按新实测值改回。
  assert.ok(totals.ramps >= 4 && totals.rampsConnected === totals.ramps && totals.rampsUp >= totals.ramps - 1 && totals.rampsDown === totals.ramps, `expressway ramps regressed: ${JSON.stringify(totals)} ${rampFailures.join("; ")}`);
  if (rampFailures.length) console.log(`Structure surface: ramp runs reported: ${rampFailures.join("; ")}`);
  console.log(`Structure surface: ${totals.bridges} bridges, ${totals.landings} landings — ${totals.connected} join the deck region ${JSON.stringify(reasons)}; every connected span driven end to end; ${totals.crossings}/${totals.crossable} crossed approach → approach tick-by-tick. Expressway ramps through cross-layer portals: ${totals.rampsConnected}/${totals.ramps} connected, ${totals.rampsUp} climbed road → deck, ${totals.rampsDown} descended deck → road. Remaining closed landings are reported with their reason.`);
}
