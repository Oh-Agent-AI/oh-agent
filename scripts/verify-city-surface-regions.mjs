#!/usr/bin/env node
// Same-layer union, curb/island semantics and bounded index rasterisation.
// Synthetic patches by default; --cities runs the fifteen planning layouts.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import { makeFixtures } from "./city-kit/surface-region-fixtures.mjs";
const m = await loadCity({
  "engine/surface/meshBoundaries.ts": ["extractMeshBoundaries"],
  "engine/surface/SurfaceIndex.ts": ["buildSurfaceIndex", "DEFAULT_SURFACE_INDEX_BUDGET"],
  "engine/surface/surfaceRegions.ts": ["buildSurfaceRegions", "DEFAULT_SURFACE_REGION_PARAMS"],
  "engine/surface/groundRoadCompiler.ts": ["compileGroundRoadSurface"],
  "engine/surface/buildGroundSnapshot.ts": ["buildGroundSurfaceSnapshot"],
});
const { grid, patch, snapshot, regionsOf } = makeFixtures(m);
const P = m.DEFAULT_SURFACE_REGION_PARAMS;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const boundaryIn = (regions, regionId, x0, z0, x1, z1) => { const r = regions.segmentsInBox(regionId, x0, z0, x1, z1, 100000); assert.equal(r.status, "ok"); return r.segments; };

// ── SurfaceIndex: exact cell coverage, not AABB area (seed 42 tier 2 regression) ──
{
  // One thin diagonal triangle 400 long: AABB covers 50×50 cells, the triangle touches ~100.
  const positions = new Float32Array([0, 0, 0, 400, 0, 401, 401, 0, 400]);
  const snap = snapshot([{ id: "diag", kind: "carriageway", layerId: "ground", vertices: positions, indices: new Uint32Array([0, 1, 2]), boundaryLoops: [], source: { kind: "road", id: "diag" } }]);
  const idx = m.buildSurfaceIndex(snap);
  assert.equal(idx.status, "ready", "a long thin triangle must not exhaust the per-triangle budget by its AABB");
  assert.ok(idx.entryCount < 260, `entries ${idx.entryCount} must follow the triangle, not its bounding box`);
  assert.equal(idx.query({ x: 399.5, z: 399.6, layerId: "ground" }).status, "hit", "far end is still indexed");
  assert.equal(idx.query({ x: 0.2, z: 0.2, layerId: "ground" }).status, "hit");
  assert.equal(idx.query({ x: 300, z: 100, layerId: "ground" }).status, "miss");
  // Cell-border points: every border along the diagonal must still find the triangle.
  for (let k = 1; k < 50; k++) assert.equal(idx.query({ x: k * 8, z: k * 8, layerId: "ground" }).status, "hit", `border ${k * 8}`);
  assert.equal(m.buildSurfaceIndex(snap, { ...m.DEFAULT_SURFACE_INDEX_BUDGET, maxScanCellsPerTriangle: 100 }).reason, "triangle-span-budget", "scan cost stays bounded");
  assert.equal(m.buildSurfaceIndex(snap, { ...m.DEFAULT_SURFACE_INDEX_BUDGET, maxCellsPerTriangle: 10 }).reason, "triangle-span-budget");
  const box = idx.trianglesInBox({ minX: 100, minZ: 100, maxX: 101, maxZ: 101, layerId: "ground", maxResults: 4 });
  assert.equal(box.status, "ok"); assert.equal(box.triangles.length, 1);
  assert.equal(idx.trianglesInBox({ minX: 0, minZ: 0, maxX: 1, maxZ: 1, layerId: "ground", maxResults: 1, kinds: ["sidewalk"] }).triangles.length, 0);
  assert.deepEqual({ ...idx.triangle({ patchId: "diag", triangleIndex: 0 }) }, { ax: 0, ay: 0, az: 0, bx: 400, by: 0, bz: 401, cx: 401, cy: 0, cz: 400 });
  assert.equal(idx.triangle({ patchId: "diag", triangleIndex: 1 }), null);
  const flat = idx.query({ x: 200, z: 200, layerId: "ground" }).hit.normal;
  assert.deepEqual([flat.x, flat.y, flat.z], [0, 1, 0], "flat road normal points up (A3 draft returned a horizontal normal)");
  const t = Math.tan(0.2);
  const ramp = m.buildSurfaceIndex(snapshot([patch("ramp", "ramp", grid(-5, -5, 5, 5, 1, 1, (x) => x * t))])).query({ x: 1, z: 1, layerId: "ground" }).hit;
  assert.ok(Math.abs(ramp.normal.x + Math.sin(0.2)) < 1e-6 && Math.abs(ramp.normal.y - Math.cos(0.2)) < 1e-6 && Math.abs(ramp.normal.z) < 1e-6, "uphill +x tilts the normal toward −x");
  assert.ok(Math.abs(ramp.point.y - t) < 1e-6);
}

// ── Cross-patch alias merge: an X junction of two equal-height ribbons ──
{
  const ew = patch("ew", "carriageway", grid(-20, -3, 20, 3, 8, 2));
  const ns = patch("ns", "carriageway", grid(-3, -20, 3, 20, 2, 8));
  const { regions } = regionsOf([ns, ew]);
  assert.equal(regions.status, "ready");
  assert.equal(regions.regions.length, 1, "overlapping same-height patches form one region");
  assert.equal(regions.report.aliasPairs, 1); assert.equal(regions.report.conflicts.length, 0);
  const id = regions.regions[0].id;
  assert.equal(id, "region:ground:ew", "region identity is the smallest member id, not input order");
  const c = regions.classify(0.4, 0.3, "ground");
  assert.equal(c.status, "drivable"); assert.equal(c.regionId, id);
  assert.equal(boundaryIn(regions, id, -2.9, -2.9, 2.9, 2.9).length, 0, "inner patch edges inside the overlap are not curbs");
  // Each of the four outer corners of the cross is a boundary vertex; overlap edges are cut away.
  assert.ok(boundaryIn(regions, id, 2.9, 2.9, 3.1, 3.1).length >= 2);
  assert.equal(regions.classify(10, 10, "ground").cause, "no-surface");
  // Order independence: shuffled input produces identical regions and boundaries.
  const again = regionsOf([ew, ns]).regions;
  const dump = (r) => JSON.stringify([r.regions, r.segmentsInBox(r.regions[0].id, -30, -30, 30, 30, 100000)]);
  assert.equal(dump(again), dump(regions));
}

// ── Height-conflicting overlap is not an alias and is never drivable ──
{
  const ew = patch("ew", "carriageway", grid(-20, -3, 20, 3, 8, 2));
  const ns = patch("ns", "carriageway", grid(-3, -20, 3, 20, 2, 8, () => 0.25));
  const { regions } = regionsOf([ew, ns]);
  assert.equal(regions.report.conflicts.length, 1);
  assert.ok(Math.abs(regions.report.conflicts[0].maxHeightDifference - 0.25) < 1e-6);
  assert.equal(regions.regions.length, 2);
  assert.equal(regions.classify(0, 0, "ground").status, "blocked", "never pick the higher of two disagreeing surfaces");
  assert.equal(regions.classify(10, 0, "ground").status, "drivable");
  const ewSegs = boundaryIn(regions, "region:ground:ew", -3.1, -3.1, 3.1, 3.1);
  assert.ok(ewSegs.some((s) => s.cause === "ambiguous-region"), "conflict zone is bounded inside the region");
  // Exact overlay vertices: no vertex of either patch lies inside the other; the only
  // overlay points are edge crossings, where the sloped ribbon is 0.12–0.3 above the pad.
  const pad = patch("pad", "carriageway", grid(-1, -1, 1, 1, 1, 1));
  const slopedMesh = { positions: new Float32Array([-5, 0.3, -0.5, 5, 0, -0.5, 5, 0.3, 0.5, -5, 0, 0.5]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
  const crossing = regionsOf([pad, patch("sloped", "carriageway", slopedMesh)]).regions;
  assert.equal(crossing.report.conflicts.length, 1, "max height difference is found at edge crossings, not only at vertices");
}

// ── Seam steps: A~C~B merged, but the bare A|B seam jumps 0.15 > aliasTolerance ──
{
  const a = patch("a", "carriageway", grid(0, -5, 10, 5, 2, 2));
  const b = patch("b", "carriageway", grid(10, -5, 20, 5, 2, 2, () => 0.15));
  const c = patch("c", "junction", grid(9.6, -5, 10.4, -3, 1, 1, (x) => (x - 9.6) / 0.8 * 0.15));
  const { regions } = regionsOf([a, b, c]);
  assert.equal(regions.regions.length, 1, "touching/overlapping chain within tolerance merges");
  const steps = boundaryIn(regions, regions.regions[0].id, 9.9, 0, 10.1, 4.9);
  assert.ok(steps.length >= 1 && steps.every((s) => s.label === "step"), "an in-region height jump is a step boundary");
  assert.equal(regions.report.boundaryByLabel.step > 0, true);
}

// ── Curb semantics: sidewalk beside the road → curb; bare edge → closed ──
{
  const road = patch("road", "carriageway", grid(-20, -3, 20, 3, 8, 2));
  const walk = patch("walk", "sidewalk", grid(-20, -4.2, 20, 4.2, 8, 2, () => -0.01));
  const { regions } = regionsOf([road, walk]);
  const id = regions.regions[0].id;
  const side = boundaryIn(regions, id, -1, 2.9, 1, 3.1);
  assert.ok(side.length && side.every((s) => s.label === "curb" && s.cause === "sidewalk"));
  assert.equal(regions.classify(0, 3.5, "ground").status, "blocked", "sidewalks never provide driving support");
  const end = boundaryIn(regions, id, 19.9, -1, 20.1, 1);
  assert.ok(end.length && end.every((s) => s.label === "closed"), "a road end without a portal is closed, not open");
}

// ── Channelised island and true hole inside the carriageway ──
{
  const road = patch("road", "carriageway", grid(-10, -5, 10, 5, 10, 5));
  const island = patch("island", "island", grid(-1, -0.4, 1, 0.4, 1, 1, () => 0.15));
  const { regions } = regionsOf([road, island]);
  const id = regions.regions[0].id;
  assert.equal(regions.classify(0, 0, "ground").cause, "island");
  const ring = boundaryIn(regions, id, -1.1, -0.5, 1.1, 0.5);
  assert.ok(ring.length >= 4 && ring.every((s) => s.label === "curb" && s.cause === "island"), "island outline is a curb hole in the region");
  // Unresolved island geometry still subtracts conservatively via its triangle edges.
  const loose = patch("island", "island", grid(-1, -0.4, 1, 0.4, 1, 1, () => 0.15), "ground", false);
  const r2 = regionsOf([road, loose]).regions;
  assert.equal(r2.report.unresolvedIslandPatches, 1);
  assert.equal(r2.classify(0, 0, "ground").cause, "island");
  assert.ok(boundaryIn(r2, r2.regions[0].id, -1.1, -0.5, 1.1, 0.5).length >= 4);
  // A real hole (cell removed from the mesh) is a closed boundary.
  const holed = patch("holed", "carriageway", grid(-10, -5, 10, 5, 10, 5, () => 0, (i, j) => !(i === 5 && j === 2)));
  const r3 = regionsOf([holed]).regions;
  assert.equal(r3.classify(1, 0, "ground").cause, "no-surface");
  assert.ok(boundaryIn(r3, r3.regions[0].id, -0.1, -1.1, 2.1, 1.1).every((s) => s.label === "closed"));
}

// ── Unresolved drivable geometry fails closed and blocks what it overlaps ──
{
  const road = patch("road", "carriageway", grid(-10, -3, 10, 3, 4, 2));
  const mesh = grid(-3, -10, 3, 10, 2, 4);
  const folded = { ...patch("folded", "carriageway", mesh), boundaryLoops: [] };
  const { regions } = regionsOf([road, folded]);
  assert.deepEqual(regions.report.excluded.map((e) => [e.patchId, e.reason]), [["folded", "boundary-unresolved"]]);
  assert.equal(regions.classify(0, 0, "ground").cause, "unresolved-patch", "overlap with unknown geometry is not drivable");
  assert.equal(regions.classify(0, 8, "ground").cause, "unresolved-patch");
  assert.equal(regions.classify(8, 0, "ground").status, "drivable");
  assert.ok(boundaryIn(regions, regions.regions[0].id, -3.1, -3.1, 3.1, 3.1).some((s) => s.cause === "unresolved-patch"));
}

// ── Layers: a deck over the ground road never merges, never shadows ──
{
  const ground = patch("ground-road", "carriageway", grid(-20, -3, 20, 3, 8, 2));
  const deck = patch("deck", "bridge-deck", grid(-3, -20, 3, 20, 2, 8, () => 6), "deck-1");
  const { regions } = regionsOf([ground, deck]);
  assert.equal(regions.regions.length, 2); assert.equal(regions.report.conflicts.length, 0);
  assert.equal(regions.classify(0, 0, "ground").y, 0); assert.equal(regions.classify(0, 0, "deck-1").y, 6);
  assert.equal(regions.classify(10, 0, "deck-1").status, "blocked", "projection overlap never switches layers");
  assert.equal(boundaryIn(regions, "region:ground:ground-road", -2.9, -2.9, 2.9, 2.9).length, 0);
}

// ── Bridge decks occlude the lower ground they cover (v3); ground above a deck obstructs ──
{
  const road = patch("road", "carriageway", grid(-20, -3, 0.5, 3, 4, 2, (x) => 1 + x * 0.05));
  const fanBelow = patch("fan", "junction", grid(-3, -3, 3, 3, 12, 2, (x) => 1 + Math.min(x, 0.5) * 0.05 - Math.max(0, x - 0.5) * 0.3)); // matches the road, then drops toward the river
  const deck = patch("deck", "bridge-deck", grid(0, -2.2, 30, 2.2, 6, 2, () => 1));
  const { regions } = regionsOf([road, fanBelow, deck]);
  assert.equal(regions.report.conflicts.length, 0, "ground sinking under a deck is occluded, not a conflict");
  const onDeck = regions.classify(2.5, 0, "ground");
  assert.equal(onDeck.status, "drivable"); assert.equal(onDeck.patchId, "deck"); close(onDeck.y, 1);
  assert.equal(onDeck.regionId, regions.classify(-10, 0, "ground").regionId, "deck joins the approach through its landing");
  const poke = patch("poke", "junction", grid(5, -1, 7, 1, 1, 1, () => 1.3));
  const r2 = regionsOf([road, fanBelow, deck, poke]).regions;
  assert.equal(r2.report.conflicts.length, 1, "ground standing 0.3 above the deck is an obstruction");
  assert.equal(r2.classify(6, 0, "ground").cause, "height-conflict");
}

// ── Cross-layer portals (v4): compiler candidates re-checked with the exact overlay rule ──
{
  const portalOf = (from, to, mismatch = 0.1) => ({ id: `portal:${from}:${to}`, fromPatch: from, toPatch: to,
    fromBoundary: { loop: 0, firstSegment: 0, segmentCount: 1 }, toBoundary: { loop: 0, firstSegment: 0, segmentCount: 1 },
    permittedDirection: "both", clearance: 2.2, maxHeightMismatch: mismatch, validated: false });
  const build = (patches, portals) => { const snap = { ...snapshot(patches), portals }; const r = m.buildSurfaceRegions(snap, m.buildSurfaceIndex(snap)); assert.equal(r.status, "ready"); return r; };
  // Road on the ground from x −10 to 40; a ramp layer from x 30 rising 0.05 per unit (overlaps 30–40).
  const road = patch("road", "carriageway", grid(-10, -4, 40, 4, 25, 4));
  const rampAt = (lift) => patch("ramp", "ramp", grid(30, -4, 70, 4, 20, 4, (x) => lift + (x - 30) * 0.05), "ramp:0");
  const isolated = build([road, rampAt(0)], []);
  assert.equal(isolated.regions.length, 2, "without a portal the layers never join (mutation check)");
  const r = build([road, rampAt(0)], [portalOf("ramp", "road")]);
  assert.deepEqual(r.report.portals.map((p) => [p.status, p.reason]), [["open", "ok"]]);
  assert.equal(r.regions.length, 1); assert.deepEqual([...r.regions[0].layerIds].sort(), ["ground", "ramp:0"]);
  const region = r.regions[0].id;
  assert.equal(r.classify(20, 0, "ground").regionId, region); assert.equal(r.classify(60, 0, "ramp:0").regionId, region);
  // The ramp's lower end at x = 30 is a seam (the road continues at its height): no boundary there.
  // Its far end and the road's end under the ramp (0.5 below it) stay closed boundaries.
  const at = (x0, x1, layerId) => r.boundaryOf(region).filter((seg) => seg.layerId === layerId && Math.min(seg.ax, seg.bx) >= x0 && Math.max(seg.ax, seg.bx) <= x1 && seg.ax === seg.bx);
  assert.equal(at(29.9, 30.1, "ramp:0").length, 0, "the seam to the road is not a boundary");
  assert.ok(at(69.9, 70.1, "ramp:0").length > 0, "the ramp's far end is closed");
  const under = at(39.9, 40.1, "ground"); assert.ok(under.length > 0);
  assert.ok(under.every((seg) => Math.abs(seg.ya) < 1e-6 && Math.abs(seg.yb) < 1e-6), "boundary segments carry their surface height");
  // Layer choice: height continuity, upper surface within the seam tolerance, ambiguous without a height.
  close(r.supportAt(35, 0, region, 0).y, 0); close(r.supportAt(35, 0, region, 0.25).y, 0.25);
  assert.equal(r.supportAt(35, 0, region).cause, "ambiguous-layer", "a spawn over two surfaces must name its height");
  close(r.supportAt(31, 0, region, 0).y, 0.05, 1e-6, "within the seam tolerance the car rides the upper surface");
  close(r.supportAt(31, 0, region).y, 0.05, 1e-6);
  // Rejections, each with its reason.
  assert.deepEqual(build([road, rampAt(0.3)], [portalOf("ramp", "road")]).report.portals.map((p) => p.reason), ["no-contact"], "a ramp passing 0.3 above never touches");
  assert.deepEqual(build([road, rampAt(-0.3)], [portalOf("ramp", "road")]).report.portals.map((p) => p.reason), ["height-conflict"], "ground poking through the ramp");
  const road2 = patch("road2", "carriageway", grid(35, -4, 60, 4, 10, 4));
  assert.deepEqual(build([road, road2], [portalOf("road2", "road")]).report.portals.map((p) => p.reason), ["same-layer"]);
  const walk = patch("walk", "sidewalk", grid(30, -6, 40, -4, 4, 1));
  assert.deepEqual(build([road, rampAt(0), walk], [portalOf("ramp", "walk")]).report.portals.map((p) => p.reason), ["not-member"]);
  const far = patch("far", "ramp", grid(80, -4, 90, 4, 4, 4), "ramp:0");
  assert.deepEqual(build([road, far], [portalOf("far", "road")]).report.portals.map((p) => p.reason), ["no-overlap"]);
  assert.equal(build([road, rampAt(0.3)], [portalOf("ramp", "road")]).regions.length, 2, "a rejected portal joins nothing");
}

// ── Failure modes: mismatched revision, unresolved index, budgets ──
{
  const road = patch("road", "carriageway", grid(-10, -3, 10, 3, 4, 2));
  const snap = snapshot([road]);
  const index = m.buildSurfaceIndex(snap);
  assert.equal(m.buildSurfaceRegions({ ...snap, revision: "other" }, index).reason, "revision-mismatch");
  assert.equal(m.buildSurfaceRegions(snap, { status: "unresolved", reason: "triangle-budget" }).reason, "index-unresolved");
  assert.equal(m.buildSurfaceRegions(snap, index, { ...P, maxClassifications: 3 }).reason, "classification-budget");
  assert.equal(m.buildSurfaceRegions(snap, index, { ...P, maxSegments: 2 }).reason, "segment-budget");
  assert.equal(m.buildSurfaceRegions(snap, index, { ...P, aliasTolerance: 0 }).reason, "invalid-input");
  const two = snapshot([road, patch("road2", "carriageway", grid(-3, -10, 3, 10, 2, 4))]);
  assert.equal(m.buildSurfaceRegions(two, m.buildSurfaceIndex(two), { ...P, maxOverlayTests: 1 }).reason, "overlay-budget");
}
console.log("Surface regions: exact index rasterisation, alias merge with exact overlay heights, conflict/step/seam boundaries, curb vs closed, islands and holes, unresolved patches fail closed, layer isolation, bridge-deck occlusion, cross-layer portals (open/no-contact/height-conflict/same-layer/not-member/no-overlap, seams, layer choice), budgets passed.");

if (process.argv.includes("--cities")) {
  const { cachedPlan } = await import("./city-kit/index.mjs");
  const { createCityPlan } = await loadCity({ "engine/cityPlan.ts": ["createCityPlan"] });
  for (const seed of [1, 7, 42, 2026, 65537]) for (const tier of [1, 2, 3]) {
    const snap = m.buildGroundSurfaceSnapshot(m.compileGroundRoadSurface(cachedPlan(createCityPlan, seed, tier)));
    const index = m.buildSurfaceIndex(snap);
    assert.equal(index.status, "ready", `seed ${seed} tier ${tier} index`);
    const started = performance.now();
    const regions = m.buildSurfaceRegions(snap, index);
    const ms = performance.now() - started;
    assert.equal(regions.status, "ready", `seed ${seed} tier ${tier} regions: ${regions.reason}`);
    const r = regions.report;
    assert.ok(r.conflicts.every((c) => c.maxHeightDifference > P.aliasTolerance || c.maxHeightDifference === -1));
    assert.ok(r.maxAliasHeightDifference <= P.aliasTolerance);
    // Every boundary segment must separate its region from something else.
    const sample = [];
    for (const region of regions.regions) sample.push(...regions.boundaryOf(region.id).filter((_, i) => i % 97 === 0));
    for (const s of sample) {
      const dx = s.bx - s.ax, dz = s.bz - s.az, len = Math.hypot(dx, dz), mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
      const e = P.sideOffset, layer = regions.regionById(s.regionId).layerId;
      const L = regions.classify(mx - dz / len * e, mz + dx / len * e, layer), R = regions.classify(mx + dz / len * e, mz - dx / len * e, layer);
      const inside = [L, R].filter((q) => q.status === "drivable" && q.regionId === s.regionId).length;
      assert.ok(s.label === "step" ? inside === 2 : inside === 1, `boundary ${JSON.stringify(s)} separates its region`);
    }
    const causes = {};
    for (const region of regions.regions) for (const s of regions.boundaryOf(region.id)) causes[s.cause] = (causes[s.cause] ?? 0) + 1;
    console.log(`Surface regions: seed ${seed}, tier ${tier}: ${r.regions} regions over ${r.memberPatches} patches, ${r.excluded.length} excluded, ${r.conflicts.length} height conflicts (max ${Math.max(0, ...r.conflicts.map((c) => c.maxHeightDifference)).toFixed(3)}), ${r.aliasPairs} alias pairs (max ${r.maxAliasHeightDifference.toFixed(3)}), boundary ${JSON.stringify(causes)}, ${ms.toFixed(0)} ms.`);
  }
}
