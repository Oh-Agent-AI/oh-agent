#!/usr/bin/env node
// Environment probe for the W1 spike: what the default (Bellard) QuickJS variant and the
// quickjs-ng variant actually support, plus version + timing facts for SPIKE_REPORT.md.
import { getQuickJS, RELEASE_SYNC } from "quickjs-emscripten";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const spikeRoot = fileURLToPath(new URL("./", import.meta.url));
const BUNDLE = path.join(spikeRoot, "build/city-sdk.spike.iife.js");

function evalOne(ctx, code) {
  const result = ctx.evalCode(code, "probe.js");
  if (result.error) {
    const dumped = ctx.dump(result.error);
    result.error.dispose();
    return { error: typeof dumped === "string" ? dumped : JSON.stringify(dumped) };
  }
  const value = ctx.getString(result.value);
  result.value.dispose();
  return { value };
}

console.log("== environment ==");
console.log("node", process.version);
console.log("city-sdk dist/index.js bytes:", statSync(path.resolve(spikeRoot, "../../packages/agent-vitals-city-sdk/dist/index.js")).size);
console.log("spike IIFE bundle bytes:", statSync(BUNDLE).size);
const variantWasm = path.resolve(spikeRoot, "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm");
console.log("quickjs wasm (release-sync) bytes:", statSync(variantWasm).size);

console.log("\n== default variant: Bellard quickjs (release-sync) ==");
const QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
const ctx = runtime.newContext();

const versionProbe = evalOne(ctx, "typeof QuickJSVersion !== 'undefined' ? QuickJSVersion : 'n/a'");
console.log("QuickJSVersion:", versionProbe.value ?? versionProbe.error);

// NOTE: \p probes are file-based because shell escaping mangles them.
const probes = [
  ["unicode property escape class", "/^\\p{L}+$/u.test('abc')"],
  ["unicode property escape CJK", "/^\\p{L}+$/u.test('扑翼机')"],
  ["u-flag literal CJK", "/^[\\p{L}\\p{N}][\\p{L}\\p{N} .·、（）()\\-]{0,126}$/u.test('扑翼机')"],
  ["regex dotAll s flag", "/a.b/s.test('a\\nb')"],
  ["lookbehind", /(?<=a)b/.source !== undefined ? "'ab'.replace(/(?<=a)b/, 'X')" : "'n/a'"],
  ["nullish coalescing", "null ?? 1"],
  ["optional chaining", "({})?.a"],
  ["Object.values", "Object.values({a:1}).join()"],
  ["String.includes", "'abc'.includes('b')"],
  ["Number.isFinite", "Number.isFinite(1)"],
  ["JSON.parse dup keys", "JSON.parse('{\"a\":1,\"a\":2}').a"],
  ["toFixed", "(170).toFixed(3)"],
  ["number formatting", "JSON.stringify({a:120,b:0.1,c:2.4,d:1/3,e:66.66666666666667})"],
  ["Date.now", "typeof Date.now"],
];
for (const [name, code] of probes) {
  const outcome = evalOne(ctx, code);
  console.log(`  ${name}:`, outcome.value ?? `ERROR ${outcome.error}`);
}

// Load the real bundle and validate the preset vector once.
const bundleSource = readFileSync(BUNDLE, "utf8");
const tLoad0 = performance.now();
const bundleResult = ctx.evalCode(bundleSource, "spike/bundle.js");
if (bundleResult.error) {
  console.log("bundle load ERROR:", JSON.stringify(ctx.dump(bundleResult.error)));
  bundleResult.error.dispose();
} else {
  bundleResult.value.dispose();
}
console.log("bundle load ms:", (performance.now() - tLoad0).toFixed(1));
const presetProbe = evalOne(ctx, "JSON.stringify(citySdk.validateVehicleProfileV1(JSON.parse('{\"schemaVersion\":1,\"id\":\"vehicle.ornithopter\",\"label\":\"扑翼机\",\"modelAssetId\":null,\"flightModel\":\"flapping\",\"physics\":{\"massKg\":340,\"wingAreaM2\":18,\"thrustN\":10000,\"maxSpeedMps\":120,\"dragCoefficient\":0.1,\"turnRateRps\":0.9,\"climbRateMps\":34,\"sinkRateMps\":26,\"flapFrequencyHz\":2.4,\"flapAmplitudeRad\":1.1},\"bounds\":{\"halfLengthM\":3.6,\"halfWidthM\":4.8,\"halfHeightM\":1.4},\"camera\":{\"followDistanceM\":26,\"heightOffsetM\":12,\"fovDeg\":52}}')))");
console.log("validateVehicleProfileV1(preset) via Bellard quickjs:", presetProbe.value ? presetProbe.value.slice(0, 120) + "..." : `ERROR ${presetProbe.error}`);

// tidy: drop the bundle-defined globals so runtime teardown is clean
evalOne(ctx, "citySdk = undefined; undefined;");
ctx.dispose();
runtime.dispose();
