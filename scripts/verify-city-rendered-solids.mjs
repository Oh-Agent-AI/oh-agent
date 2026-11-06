#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { canonicalCityWorldBytes, copyRenderedSolids, assertRenderedSolidBudget } = await loadCity({
  "engine/surface/citySurfacePort.ts": ["canonicalCityWorldBytes"],
  "engine/surface/renderedSolidTypes.ts": ["copyRenderedSolids", "assertRenderedSolidBudget"],
});
const metadata = { obstacles: [], landings: [], counts: { bridges: 0, expresswaySegments: 0, flares: 0, islands: 0, culDeSacs: 0 } };
const solid = (id = "one") => ({ id, role: "building", positions: new Float32Array([0,0,0,1,0,0,0,1,0]), indices: new Uint32Array([0,1,2]), transforms: new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]) });
const canonical = (solids) => canonicalCityWorldBytes("surface-test", metadata, solids);
const a = solid(), b = solid("two");
assert.deepEqual(canonical([a,b]), canonical([b,a]), "incidental mesh order does not alter identity");
assert.notDeepEqual(canonical([]), canonicalCityWorldBytes("surface-test", metadata), "empty registered coverage differs from structures-only");
const owned = copyRenderedSolids([a]); owned[0].positions[0] = 5; owned[0].transforms[12] = 9;
assert.equal(a.positions[0], 0); assert.equal(a.transforms[12], 0);
const changed = solid(); changed.transforms[12] = 1;
assert.notDeepEqual(canonical([a]), canonical([changed]), "displayed transform participates in identity");
assert.throws(() => canonical([a,a]), /invalid-world-rendered-solid/);
const badIndex = solid(); badIndex.indices[1] = 3; assert.throws(() => canonical([badIndex]), /invalid-world-rendered-solid/);
const badTransform = solid(); badTransform.transforms[3] = .2; assert.throws(() => canonical([badTransform]), /invalid-world-rendered-solid-transform/);
const nonfinite = solid(); nonfinite.positions[0] = NaN; assert.throws(() => canonical([nonfinite]), /invalid-world-rendered-solid/);
const reflected = solid(); reflected.transforms[0] = -1; canonical([reflected]);
const hugeVertices = { ...solid(), positions: new Float32Array(3000003) };
assert.throws(() => copyRenderedSolids([hugeVertices]), /rendered-solids-budget/);
const hugeInstances = { ...solid(), transforms: new Float64Array(1600016) };
assert.throws(() => canonical([hugeInstances]), /rendered-solids-budget/);
assert.throws(() => assertRenderedSolidBudget(new Array(20001).fill(a)), /rendered-solids-budget/);
console.log("Rendered solid transport: bounded owned buffers, deterministic binary geometry identity, displayed transforms, explicit coverage, malformed geometry and budgets passed.");
