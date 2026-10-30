#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { cachedPlan, kitStats, loadCity, snapshotCachedPlans, assertCachedPlansUnchanged } from "./city-kit/index.mjs";
import { manifest, selectStages } from "./city-kit/verification.mjs";

assert.equal(new Set(manifest.map((s) => s.id)).size, manifest.length);
assert.deepEqual(selectStages("full").map((s) => s.id), manifest.map((s) => s.id));
assert.throws(() => selectStages("module", "unknown"));
for (const group of ["network", "sites", "planning", "display", "game"]) assert(selectStages("module", group).length > 0);
assert(manifest.some((s) => s.env.CITY_SEASIDE_TIER === "10"));
assert(manifest.some((s) => s.file === "verify-city-cross-engine.mjs" && !s.shared));
assert(manifest.some((s) => s.file === "verify-city-solve.mjs" && !s.shared));
// Preserve the existing stages and register the new production causeway guard.
// 63 + city-opt 的 5 个（villa-placement / model-envelope / site-registry / site-registry-scene / joint-site-road）+ 规划修复的 6 个守卫（verify-plan-patch / -road-rules / -sites / -repair-controller / -bulldozer / -remap）+ R2 的 verify-city-import-boundary。计数锁防的是悄悄增减，
// 有意登记就同步改这里，并在下面断言它们确实挂进了 planning 组——否则登记了却不跑。
// 88（驾驶线）+ 视觉风格线 3 个（junction-rings / highway-ramps / world-scale）+ 机甲 UX 守卫（verify-city-mecha-ux，挂在 game 组）。计数锁防的是悄悄增减，
// 有意登记就同步改这里，并在下面断言它们确实挂进了 planning 组——否则登记了却不跑。
assert.equal(manifest.length, 118);
assert(selectStages("module", "game").some(stage => stage.id === "verify-city-mecha-ux"));
assert(selectStages("module", "display").some(stage => stage.id === "verify-city-coastal-receivers"));
for (const id of ["verify-city-road-audit-ui", "verify-city-road-audit-worker", "verify-city-road-audit-history"]) {
  assert(manifest.some((stage) => stage.id === id), `${id} must be registered`);
  assert(selectStages("module", "game").some((stage) => stage.id === id), `${id} must run in the game group`);
  assert(selectStages("full").some((stage) => stage.id === id), `${id} must run in full verification`);
}
for (const id of ["verify-city-junction-rings", "verify-city-highway-ramps"])
  for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined)
    .some(stage => stage.id === id));
assert(selectStages("fast").some((stage) => stage.id === "verify-city-import-boundary"), "import boundary guard must run in fast mode");
assert(selectStages("module", "planning").some((stage) => stage.id === "verify-city-import-boundary"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined)
  .some(stage => stage.id === "verify-city-planning-job"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined)
  .some(stage => stage.id === "verify-city-plan-disk-cache"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined)
  .some(stage => stage.id === "verify-city-operation-budget"));
for (const id of ["verify-plan-patch", "verify-plan-road-rules", "verify-plan-sites", "verify-plan-repair-controller", "verify-plan-bulldozer", "verify-plan-remap", "verify-plan-repair-copy", "verify-plan-repair-bridgehead", "verify-plan-repair-drivability", "verify-city-minimap", "verify-city-road-standard"]) {
  assert(selectStages("module", "planning").some((stage) => stage.id === id), `${id} must run in the planning group`);
}
for (const group of ["network", "planning", "sites"]) assert(selectStages("module", group).some(stage => stage.id === "verify-city-joint-site-road"));
for (const group of ["planning", "sites"]) assert(selectStages("module", group).some(stage => stage.id === "verify-city-site-registry-scene"));
for (const group of ["planning", "sites"]) assert(selectStages("module", group).some(stage => stage.id === "verify-city-site-registry"));
for (const group of ["planning", "sites"]) assert(selectStages("module", group).some(stage => stage.id === "verify-city-villa-placement"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "sites" : undefined).some(stage => stage.id === "verify-city-model-envelope"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined).some(stage => stage.id === "verify-city-layout-capacity"));
for (const id of ["verify-city-layout-envelopes", "verify-city-parcel-frontage", "verify-city-block-placement", "verify-city-block-lot-candidates", "verify-city-villa-physical", "verify-city-model-ground"]) {
  assert(selectStages("fast").some((stage) => stage.id === id));
  assert(selectStages("module", "planning").some((stage) => stage.id === id));
  assert(selectStages("module", "sites").some((stage) => stage.id === id));
}
assert(selectStages("module", "planning").some((stage) => stage.id === "verify-city-road-derived-plan"));
for (const group of ["planning", "sites", "display"]) assert(selectStages("module", group).some((stage) => stage.id === "verify-city-layout-placement"));
for (const id of ["verify-city-block-surface", "verify-city-shore-plot-access"]) {
  assert(selectStages("fast").some((stage) => stage.id === id));
  assert(selectStages("module", "planning").some((stage) => stage.id === id));
}
assert(selectStages("module", "sites").some((stage) => stage.id === "verify-city-shore-plot-access-named"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "sites" : undefined)
  .some((stage) => stage.id === "verify-city-joint-frontage"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined)
  .some((stage) => stage.id === "verify-city-road-blocks"));
for (const group of ["sites", "planning"]) assert(selectStages("module", group)
  .some((stage) => stage.id === "verify-city-required-placement"));
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined)
  .some((stage) => stage.id === "verify-city-road-admission"));
for (const group of ["network", "sites", "planning"]) assert(selectStages("module", group)
  .some((stage) => stage.id === "verify-city-causeway-primary"));
for (const id of ["verify-city-world", "verify-city-access-capabilities", "verify-city-endpoint-routing", "verify-city-road-faces"]) {
  assert(manifest.some((stage) => stage.id === id));
  assert(selectStages("fast").some((stage) => stage.id === id));
}
for (const mode of ["full", "fast", "module"]) assert(selectStages(mode, mode === "module" ? "planning" : undefined)
  .some((stage) => stage.id === "verify-city-radius"));
assert(manifest.some((s) => s.id === "verify-city-road-report"));
assert.equal(selectStages("module", "game").length, 33);
assert(selectStages("module", "game").some((stage) => stage.id === "verify-city-mecha-ux"), "verify-city-mecha-ux must run in the game group");
for (const id of ["verify-city-continuous-driving", "verify-city-driving-collision-differential", "verify-city-rotation-budget"])
  assert(selectStages("module", "game").some(stage => stage.id === id));
assert(selectStages("module", "game").some((stage) => stage.id === "verify-city-shared-runtime"));
for (const id of ["verify-city-game-scene-lease", "verify-city-game-audio-service", "verify-city-runtime-diagnostics", "verify-city-shared-game-ux", "verify-city-car-session", "verify-city-car-rendered-collision", "verify-city-camera-collision-query", "verify-city-preparation", "verify-city-driving-mountable", "verify-city-driving-bridge-crossing", "verify-city-static-world"]) {
  assert(selectStages("module", "game").some((stage) => stage.id === id), `${id} must run in the game group`);
}
let calls = 0;
const factory = (seed, tier, config, opts) => ({ seed, tier, config: { ...config }, opts, call: ++calls });
const c = { margin: 1, version: 2 };
const a = cachedPlan(factory, 1, 1, c);
const beforeMutation = snapshotCachedPlans();
a.seed = 2;
assert.throws(() => assertCachedPlansUnchanged(beforeMutation), /mutated/);
a.seed = 1;
assertCachedPlansUnchanged(beforeMutation);
assert.equal(cachedPlan(factory, 1, 1, { version: 2, margin: 1 }), a);
c.margin = 2;
assert.notEqual(cachedPlan(factory, 1, 1, c), a);
assert.notEqual(cachedPlan(factory, 1, 1, c, { skipSolve: true }), a);
assert.notEqual(cachedPlan(() => ({ other: true }), 1, 1, c), a);
let failures = 0;
const broken = () => { failures++; throw new Error("injected"); };
for (let i = 0; i < 2; i++) assert.throws(() => cachedPlan(broken, 1, 1, c), /injected/);
assert.equal(failures, 2);
const before = process.env.CITY_KIT_NO_CACHE;
process.env.CITY_KIT_NO_CACHE = "1";
assert.notEqual(cachedPlan(factory, 1, 1, c), cachedPlan(factory, 1, 1, c));
if (before === undefined) delete process.env.CITY_KIT_NO_CACHE; else process.env.CITY_KIT_NO_CACHE = before;
for (let i = 0; i < 70; i++) cachedPlan(factory, i, 1, c);
assert(kitStats().cachedPlans <= 64);

// Different export bundles must reuse the same generation without invoking the
// cache for the independent determinism comparison.
const x = await loadCity({ "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"] });
const y = await loadCity({ "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"], "engine/planner/constraints.ts": ["CONSTRAINTS"] });
const p = cachedPlan(x.createCityPlan, 1703294958, 1, x.MIAMI_COASTAL);
const snapshot = JSON.stringify(p);
const q = cachedPlan(y.createCityPlan, 1703294958, 1, y.MIAMI_COASTAL);
assert.equal(p, q);
for (const constraint of y.CONSTRAINTS) constraint.measure(q);
assert.equal(JSON.stringify(p), snapshot, "read-only constraints must not contaminate the shared plan");
assert.equal(JSON.stringify(y.createCityPlan(1703294958, 1, y.MIAMI_COASTAL)), snapshot, "uncached generation agrees with reused plan");
for (const stage of manifest) assert(fs.existsSync(new URL("./" + stage.file, import.meta.url)));
console.log("City verification: manifest coverage, config mutation/factory/options isolation, failures uncached, LRU, cross-bundle reuse and uncached equivalence passed.");
