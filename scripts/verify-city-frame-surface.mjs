#!/usr/bin/env node
// Exercise actual engine methods with a deterministic renderer/clock, no GPU.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { transformSync } = require("esbuild");
const source = readFileSync(new URL("../apps/agent-city/ui/src/engine/CityEngine.ts", import.meta.url), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" });
let now = 20_000;
const exports = {};
const module = { exports };
vm.runInNewContext(code, { module, exports, require: () => ({ activeTheme: () => ({ neon: false }) }), window: { devicePixelRatio: 2 }, performance: { now: () => now } });
const engine = Object.create(module.exports.CityEngine.prototype);
const calls = [];
const parent = { clientWidth: 800, clientHeight: 600 };
Object.assign(engine, {
  options: { canvas: { parentElement: parent } }, quality: 0, qualityMode: "eco",
  qualityDirty: false, surfaceDirty: true, surfaceWidth: 0, surfaceHeight: 0, surfacePixelRatio: 0,
  exportSize: null, composer: null, layout: null, attracted: false,
  renderer: { setDrawingBufferSize: (...args) => calls.push(["reset", ...args]), render: () => calls.push(["draw"]), shadowMap: {} },
  camera: { updateProjectionMatrix() {} }, renderMirror() {},
  sun: { shadow: { mapSize: { x: 2048, set() {} } } }, parts: null,
  lowFpsWindows: 0, highFpsWindows: 0, lastTierChangeAt: 0, upgradeAfter: 0,
});
engine.renderFrame();
assert.deepEqual(calls, [["reset", 800, 600, 1.25], ["draw"]], "resize must be followed by drawing in the SAME call");
calls.length = 0;
engine.renderFrame();
assert.deepEqual(calls, [["draw"]], "unchanged dimensions must not reset buffers");
parent.clientWidth = 900;
calls.length = 0;
engine.renderFrame();
assert.deepEqual(calls, [["reset", 900, 600, 1.25], ["draw"]]);
calls.length = 0;
engine.applyQualityLevel(2);
assert.deepEqual(calls, [], "quality decisions cannot clear a frame after drawing");
assert.equal(engine.qualityDirty, true);
// Surface operations also honor fixed export sizes/DPR and restore live sizing.
engine.exportSize = { width: 1920, height: 1080 };
engine.resize();
assert.deepEqual(calls.at(-1), ["reset", 1920, 1080, 1]);
engine.exportSize = null;
engine.resize();
assert.deepEqual(calls.at(-1), ["reset", 900, 600, 2]);
engine.softwareRenderer = true;
engine.resize();
assert.deepEqual(calls.at(-1), ["reset", 900, 600, .6], "software preview must limit actual pixels, not upscale CPU work");
engine.softwareRenderer = false;
// Actual policy: three bad windows, cooldown and a one-minute upgrade hold.
engine.qualityMode = "auto";
engine.quality = 1;
engine.surfaceDirty = false;
now += 3000;
engine.maybeRetier(20, false);
engine.maybeRetier(20, false);
assert.equal(engine.quality, 1, "one/two low samples must not cause a tier change");
engine.maybeRetier(20, false);
assert.equal(engine.quality, 0);
engine.surfaceDirty = false;
now += 20_000;
for (let i = 0; i < 20; i++) engine.maybeRetier(60, false);
assert.equal(engine.quality, 0, "do not oscillate back up immediately after downgrading");
now += 41_000;
engine.maybeRetier(60, false);
assert.equal(engine.quality, 1);
// Constructor/observer must never reset the surface outside renderFrame.
assert.match(source, /new ResizeObserver\(\(\) => \{ this.surfaceDirty = true; \}\)/);
assert.match(source, /idle && !this.surfaceDirty && !this.qualityDirty/);
assert.match(source, /webglcontextrestored/);
assert.match(source, /if \(!this\.options\.headless && !this\.contextLost\) \{\s*this\.updateScene\(0\);\s*this\.renderFrame\(\);/,
  "a newly mounted or replaced model must draw before the loading UI is dismissed");
assert.match(source, /if \(!this\.firstFrameSent\) \{\s*this\.firstFrameSent = true;\s*this\.options\.onFirstFrame\?\.\(\);/,
  "the first-frame callback remains one-shot even though replacements also draw synchronously");
console.log("City frame surface: OK (same-frame reset/draw, no-op resize, deferred quality, export sizing, hysteresis, idle invalidation).");
