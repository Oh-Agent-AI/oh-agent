import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { inspectBlockPlacement, lotClearsRoads, checkSitePlacement } = await loadCity({
  "engine/cityLayout.ts": ["checkSitePlacement"],
  "engine/planner/blockPlacement.ts": ["inspectBlockPlacement"],
  "engine/planner/lotRoadClearance.ts": ["lotClearsRoads"],
});
const p = (x, z) => ({ x, z });
const base = { block: { polygon: [p(0, 0), p(80, 0), p(80, 80), p(0, 80)], holes: [] },
  footprint: { x: 40, z: 40, yaw: 0, width: 16, depth: 16 }, roads: [], sites: [], highways: [], buildable: () => true };
const check = (input, reason) => { const before = JSON.stringify(input), result = inspectBlockPlacement(input); assert.equal(JSON.stringify(input), before);
  assert.equal(result.ok, reason === undefined); if (reason) assert.equal(result.reason, reason); return result; };
assert.equal(check(base).terrainSamples, 289);
assert.ok(check({ ...base, footprint: { ...base.footprint, yaw: Math.PI / 4 } }).ok);
check({ ...base, footprint: { ...base.footprint, x: 3 } }, "rectangle-crosses-block-boundary");
check({ ...base, block: { ...base.block, holes: [[p(39, 39), p(41, 39), p(41, 41), p(39, 41)]] } }, "rectangle-crosses-hole");
const notch = [p(0, 0), p(80, 0), p(80, 80), p(41, 80), p(41, 45), p(39, 45), p(39, 80), p(0, 80)];
check({ ...base, block: { polygon: notch } }, "rectangle-crosses-block-boundary"); // All four corners inside, upper edge crosses notch.
check({ ...base, block: { polygon: notch }, footprint: { ...base.footprint, x: 18 } });
const road = points => ({ id: "road", from: "a", to: "b", width: 8, kind: "local", points });
check({ ...base, roads: [road([p(0, 70), p(40, 40), p(80, 70)])] }, "actual-road-capsule-conflict");
check({ ...base, roads: [road([p(0, 10), p(80, 10)])] });
// A rendered junction fan reaches beyond its centreline capsule. Reject contained
// islands and edge-only intersections, even when every rectangle corner is clear.
check({ ...base, roadPolygons: [[p(39,39),p(41,39),p(40,41)]] }, "rendered-road-polygon-conflict");
check({ ...base, roadPolygons: [[p(20,39),p(60,39),p(60,41)]] }, "rendered-road-polygon-conflict");
check({ ...base, roadPolygons: [[p(1,1),p(2,1),p(1,2)]] });
check({ ...base, roadPolygons: [[p(NaN,1),p(2,1),p(1,2)]] }, "invalid-obstacle-envelope");
check({ ...base, sites: [{ x: 48, z: 40, radius: 1 }] }, "declared-site-circle-conflict");
check({ ...base, highways: [[p(0, 40), p(80, 40)]] }, "highway-capsule-conflict");
check({ ...base, buildable: (x, z) => !(x === 40 && z === 40) }, "rectangle-terrain-or-reserve-conflict");
check({ ...base, reserved: q => q.x === 40 && q.z === 40 }, "rectangle-terrain-or-reserve-conflict");
check({ ...base, terrainSampleBudget: 1 }, "terrain-sample-budget-exhausted");
check({ ...base, cancelled: () => true }, "cancelled");
check({ ...base, footprint: { ...base.footprint, width: NaN } }, "invalid-footprint-or-budget");
const result = check(base); assert.equal(result.scope, "sampled-rectangle-and-declared-circle-proxies");
// Public boundary must reuse the generator's environment, including occupied
// address circles and complete curved roads, without mutating the layout.
const host = { ...base.block, id: "host" };
const layout = { blocks: [host], roadEdges: [], publicSites: [], landmarks: [], highways: [], terrain: { buildable: base.buildable } };
const footprint = { ...base.footprint, blockId: host.id };
assert.deepEqual(checkSitePlacement(layout, footprint, []), result);
const beforeLayout = JSON.stringify(layout);
assert.equal(checkSitePlacement(layout, { ...footprint, blockId: "absent" }, []).reason, "unknown-host-block");
assert.equal(checkSitePlacement({ ...layout, blocks: [host, host] }, footprint, []).reason, "ambiguous-host-block");
assert.equal(checkSitePlacement({ ...layout, blocks: [{ ...host, holes: [[p(39, 39), p(41, 39), p(41, 41), p(39, 41)]] }] }, footprint, []).reason, "rectangle-crosses-hole");
assert.equal(checkSitePlacement({ ...layout, roadEdges: [road([p(0, 70), p(40, 40), p(80, 70)])] }, footprint, []).reason, "actual-road-capsule-conflict");
assert.equal(checkSitePlacement(layout, footprint, [{ x: 48, z: 40, width: 2, depth: 2 }]).reason, "declared-site-circle-conflict");
assert.equal(checkSitePlacement({ ...layout, landmarks: [{ x: 48, z: 40, radius: 1 }] }, footprint, []).reason, "declared-site-circle-conflict");
assert.equal(checkSitePlacement({ ...layout, highways: [[p(0, 40), p(80, 40)]] }, footprint, []).reason, "highway-capsule-conflict");
assert.equal(checkSitePlacement(layout, footprint, [], { terrainSampleBudget: 1 }).reason, "terrain-sample-budget-exhausted");
assert.equal(checkSitePlacement(layout, footprint, [], { cancelled: () => true }).reason, "cancelled");
assert.equal(JSON.stringify(layout), beforeLayout);
const hotel = { x: 0, z: 0, yaw: 0, width: 20, depth: 20 };
const bent = road([p(-100, 50), p(-50, 50), p(0, 0), p(100, 50)]);
assert.equal(lotClearsRoads(hotel, [bent]), false, "later polyline segments cannot pass through a hotel");
assert.equal(lotClearsRoads(hotel, [road([p(-100, 50), p(100, 50)])]), true);
assert.equal(lotClearsRoads(hotel, [road([p(-100, 14.49), p(100, 14.49)])]), false);
assert.equal(lotClearsRoads(hotel, [road([p(-100, 14.5), p(100, 14.5)])]), true);
assert.equal(lotClearsRoads({ ...hotel, yaw: NaN }, []), false);
assert.equal(lotClearsRoads(hotel, [road([p(0, NaN), p(100, 50)])]), false);
for (const yaw of [0, 0.4, Math.PI / 2, -1.2]) {
  const c = Math.cos(yaw), s = Math.sin(yaw), at = (x, z) => p(c * x + s * z, -s * x + c * z);
  const long = { ...hotel, yaw, width: 40, depth: 8 };
  assert.equal(lotClearsRoads(long, [road([at(-30, 9), at(30, 9)])]), true);
  assert.equal(lotClearsRoads(long, [road([at(-30, 8), at(30, 8)])]), false);
}
console.log("City block placement: full rectangle/corner/concavity/hole, actual curved road/site/highway, sampled interior, failclosed budget/cancel and immutable proposals passed.");
