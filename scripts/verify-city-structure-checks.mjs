#!/usr/bin/env node
// Exact structural slab headroom (including tilted lower side faces) and slope diagnostics.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { boxTopFace, boxCorners, checkStructureGeometry } = await loadCity({
  "engine/surface/structureCompiler.ts": ["boxTopFace", "boxCorners"],
  "engine/surface/structureChecks.ts": ["checkStructureGeometry"],
});
const rectangle = (id, layerId, points, kind = "carriageway") => ({ id, layerId, kind,
  source: { kind: "structure", id }, vertices: new Float32Array(points.flatMap((p) => [p.x, p.y, p.z])),
  indices: new Uint32Array([0,2,1,0,3,2]), boundaryLoops: [] });
const road = (id, y, bounds = 10) => rectangle(id, id, [{ x:-bounds,y,z:-bounds }, { x:bounds,y,z:-bounds }, { x:bounds,y,z:bounds }, { x:-bounds,y,z:bounds }]);
const fixture = (rotation = 0, extra = [], groundY = 1, orientation = {}) => {
  const part = { x:0,y:3,z:0,sx:8,sy:1,sz:4,rx:0,ry:0,rz:rotation,order:"XYZ",role:"bridge-deck",color:"#fff",...orientation };
  const deck = rectangle("deck", "upper", boxTopFace(part), "bridge-deck");
  const corners = boxCorners(part);
  return { revision:"world-fixture", surface: { revision:"surface-fixture", geometryVersion:3,
    patches:[road("ground",groundY),deck,...extra],portals:[],renderBatches:[],report:{candidateLength:0,geometricallyEligibleLength:0,issues:[]} },
    obstacles:[{ id:"slab",role:"bridge-deck",shape:"box",corners,surfacePatchId:"deck" }] };
};
const options = { requiredClearance:1.5,maxSlopeRadians:0.2 };
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-6, `${a} vs ${b}`);
const flat = checkStructureGeometry(fixture(),options);
assert.equal(flat.status,"complete"); assert.equal(flat.snapshotRevision,"world-fixture");
assert.equal(flat.clearances.length,1); close(flat.clearances[0].gap,2); assert.equal(flat.lowClearances.length,0);
assert.equal(checkStructureGeometry(fixture(),{...options,requiredClearance:2.1}).lowClearances.length,1);
const tiltedFixture = fixture(0.3);
const tilted = checkStructureGeometry(tiltedFixture,options);
assert.equal(tilted.status,"complete"); assert.equal(tilted.slopes[0].exceedsLimit,true); close(tilted.slopes[0].radians,0.3);
const lowestCorner = Math.min(...tiltedFixture.obstacles[0].corners.map((p)=>p.y));
close(tilted.clearances[0].gap,lowestCorner-1);
for (let i=0;i<20;i++) {
  const input=fixture(0.2,[],-10,{rx:Math.sin(i)*0.3,ry:i*Math.PI/7});
  const inspected=checkStructureGeometry(input,options);
  assert.equal(inspected.status,"complete");
  close(inspected.clearances[0].gap,Math.min(...input.obstacles[0].corners.map((p)=>p.y))+10);
}
const crossing = checkStructureGeometry(fixture(0,[],3.5),options);
assert.equal(crossing.lowClearances.length,1); close(crossing.lowClearances[0].gap,-0.5);
const above = checkStructureGeometry(fixture(0,[road("sky",7)],5),options);
assert.equal(above.clearances.length,0,"road above slab is not counted as negative underpass headroom");
assert.equal(checkStructureGeometry(fixture(),{...options,maxPairs:1}).status,"unresolved","budget failure cannot publish a complete inspection");
assert.equal(checkStructureGeometry(fixture(),{...options,requiredClearance:NaN}).reason,"invalid-input");
const broken = fixture(); broken.obstacles[0].surfacePatchId="missing";
assert.equal(checkStructureGeometry(broken,options).reason,"invalid-input");
const invalid = fixture(); invalid.obstacles[0].corners[0].y=NaN;
assert.equal(checkStructureGeometry(invalid,options).reason,"invalid-input");
const warped = fixture(); warped.obstacles[0].corners[0].y+=0.1;
assert.equal(checkStructureGeometry(warped,options).reason,"invalid-input","malformed hexahedron must not be accepted as a BOX");
console.log("Structure checks: full slab/road polygon overlap, slope, tilted lowest underside, penetrating/above-solid roads, layer separation, invalid input and budgets passed.");

if (process.argv.includes("--cities")) {
  const { cachedPlan } = await import("./city-kit/index.mjs");
  const { createCityPlan, compileCitySurface } = await loadCity({
    "engine/cityPlan.ts": ["createCityPlan"], "engine/surface/compileSurface.ts": ["compileCitySurface"],
  });
  for (const seed of [1,7,42,2026,65537]) for (const tier of [1,2,3]) {
    const compilation = compileCitySurface(cachedPlan(createCityPlan,seed,tier));
    const report = checkStructureGeometry({...compilation,revision:`fixture:${seed}/${tier}`},options);
    assert.equal(report.status,"complete", `${seed}/${tier}: ${report.reason}`);
    for (const item of report.clearances) {
      assert.ok(Number.isFinite(item.gap));
      close(item.gap,item.witness.undersideY-item.witness.roadY);
    }
    console.log(`Structure checks ${seed}/${tier}: ${report.clearances.length} slab/patch overlaps, ${report.lowClearances.length} low headrooms, ${report.slopes.filter((s)=>s.exceedsLimit).length} slopes over diagnostic limit; ${report.pairsTested} pairs. No road released.`);
  }
}
