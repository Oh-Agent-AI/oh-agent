#!/usr/bin/env node
// Exactness/resource guard. Optional --plans reports paired timings, not a performance acceptance gate.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { exactFieldCache, EXACT_FIELD_CACHE_CONFIG, buildGeography, createCityPlan, MIAMI_COASTAL } = await loadCity({
  "engine/planner/exactFieldCache.ts": ["exactFieldCache", "EXACT_FIELD_CACHE_CONFIG"],
  "engine/planner/geography.ts": ["buildGeography"],
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});
let calls = 0;
const cache = exactFieldCache((x, z) => { calls++; return Object.is(x, -0) ? -1 : x + z; }, 2);
assert.equal(cache.query(0, 0), 0);
assert.equal(cache.query(0, 0), 0);
assert.equal(calls, 1);
assert.equal(cache.query(-0, 0), -1, "signed zero cannot alias a different exact field input");
cache.query(1, 0);
assert.equal(cache.snapshot().entries, 2);
cache.query(0, 0);
assert.equal(calls, 4, "FIFO eviction recomputes instead of returning another point's value");
const beforeInvalid = cache.snapshot().entries;
cache.query(NaN, 0); cache.query(Infinity, 0);
assert.equal(cache.snapshot().entries, beforeInvalid);
const boolean = exactFieldCache(() => false, 1);
assert.equal(boolean.query(1, 2), false); assert.equal(boolean.query(1, 2), false);
assert.equal(boolean.snapshot().hits, 1);
let exceptions = 0;
const throwing = exactFieldCache(() => { exceptions++; throw new Error("field-error"); }, 1);
for (let i = 0; i < 2; i++) assert.throws(() => throwing.query(1, 1), /field-error/);
assert.equal(exceptions, 2); assert.equal(throwing.snapshot().entries, 0);
for (const limit of [-1, 0.5, Infinity]) assert.throws(() => exactFieldCache(() => 0, limit), RangeError);
const disabled = exactFieldCache(() => 0, 0);
disabled.query(1, 1); disabled.query(1, 1);
assert.equal(disabled.snapshot().entries, 0); assert.equal(disabled.snapshot().hits, 0);
assert.equal(EXACT_FIELD_CACHE_CONFIG.maxEntriesPerField, 2048);
const shape = { stretch: 1.07, spin: 0.4, harmonics: [{ k: 2, a: 0.1, p: 0.7 }], bays: [{ at: 1.2, depth: 0.2, width: 0.3 }] };
for (const seed of [1703294958, 2003037141, 2002827683]) for (const radius of [390, 551.5432893255071, 872.066511224918]) {
  const memo = buildGeography(seed, radius, shape, { memoize: true }), exact = buildGeography(seed, radius, shape, { memoize: false });
  const fields = [[memo.coastDistance, exact.coastDistance], [memo.landClearance, exact.landClearance],
    [memo.height, exact.height], [memo.buildable, exact.buildable], [memo.terrain.slope, exact.terrain.slope]];
  // More unique points than a cache can hold, plus repeated and signed-zero inputs.
  const points = [[0, 0], [-0, 0], [0, -0], [-0, -0], ...Array.from({ length: 2200 }, (_, i) =>
    [(i % 53 - 26) * 17.123, (Math.floor(i / 53) - 21) * 19.017])];
  for (const [x, z] of [...points, ...points.slice(0, 32)]) for (const [cached, raw] of fields)
    assert.ok(Object.is(cached(x, z), raw(x, z)), `exact field mismatch ${seed}/${radius} at ${x}:${z}`);
}
if (process.argv.includes("--plans")) {
  let index = 0;
  for (const [seed, tier] of [[1703294958, 1], [2003037141, 1], [1703326634, 5]]) {
    const results = new Map();
    for (const enabled of index++ % 2 ? [false, true] : [true, false]) {
      const began = performance.now(), plan = createCityPlan(seed, tier, MIAMI_COASTAL, { memoizeTerrain: enabled });
      results.set(enabled, { ms: Math.round(performance.now() - began), plan: JSON.stringify(plan) });
    }
    assert.equal(results.get(true).plan, results.get(false).plan, `whole-plan exactness ${seed}/t${tier}`);
    console.log(JSON.stringify({ seed, tier, exactPlanEqual: true, cachedMs: results.get(true).ms,
      uncachedMs: results.get(false).ms, timingIsInformational: true }));
  }
}
console.log("City exact fields: exact/signed-zero keys, bounded eviction, failure/nonfinite handling and nine world field comparisons passed. No interpolation.");
