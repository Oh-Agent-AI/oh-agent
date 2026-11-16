/**
 * W1 spike test (docs/STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md section 11.3):
 * the same city-sdk validateVehicleProfileV1 validator, executed once by Node (V8, native)
 * and once inside a WASM QuickJS runtime, must produce byte-identical JSON diagnostics for
 * every acceptance vector.
 *
 * Run: cd evals/wasm-spike && npm install && npm run build && npm test
 * Prereq: packages/agent-vitals-city-sdk npm run build (dist/index.js present).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { VECTORS, PRESET_JSON } from "./vectors.mjs";
import { validateNative, nativePreset, nativeValidateObject, distIndex } from "./native-host.mjs";
import { createQuickjsHost, BUNDLE_PATH } from "./quickjs-host.mjs";

function requireBuilt() {
  if (!existsSync(distIndex)) {
    throw new Error(`city-sdk dist missing at ${distIndex}; run (cd packages/agent-vitals-city-sdk && npm run build) first.`);
  }
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(`spike IIFE bundle missing at ${BUNDLE_PATH}; run (cd evals/wasm-spike && npm run build) first.`);
  }
}

/** First byte offset where two UTF-8 byte strings differ (for failure reporting). */
function firstDiffOffset(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const limit = Math.min(ba.length, bb.length);
  for (let index = 0; index < limit; index += 1) {
    if (ba[index] !== bb[index]) return { offset: index, lengthA: ba.length, lengthB: bb.length };
  }
  if (ba.length !== bb.length) return { offset: limit, lengthA: ba.length, lengthB: bb.length };
  return null;
}

test("spike prerequisites are built", () => {
  requireBuilt();
  const bundleBytes = statSync(BUNDLE_PATH).size;
  const distBytes = statSync(distIndex).size;
  assert.ok(bundleBytes > 0);
  // The spike bundle is the dist artifact re-wrapped as IIFE; it must not shrink or explode.
  assert.ok(bundleBytes >= distBytes * 0.9, `bundle ${bundleBytes}B unexpectedly smaller than dist ${distBytes}B`);
});

test("each acceptance vector is byte-identical between Node-native and WASM QuickJS", async () => {
  requireBuilt();
  const host = await createQuickjsHost();
  try {
    for (const vector of VECTORS) {
      const native = validateNative(vector.jsonText);
      const wasm = host.validateJson(vector.jsonText);
      const diff = firstDiffOffset(native, wasm);
      assert.equal(
        diff,
        null,
        `vector ${vector.id}: diagnostics diverge at UTF-8 byte ${diff ? diff.offset : "?"}\n` +
        `  native (${diff ? diff.lengthA : 0}B): ${native}\n  wasm   (${diff ? diff.lengthB : 0}B): ${wasm}`,
      );
      const parsed = JSON.parse(native);
      assert.equal(parsed.ok, vector.expectOk, `vector ${vector.id}: ok flag mismatch (exit-code parity)`);
      const codes = (parsed.diagnostics ?? []).map(d => d.code);
      for (const expected of vector.expectCodes) {
        assert.ok(codes.includes(expected), `vector ${vector.id}: expected code ${expected} in ${JSON.stringify(codes)}`);
      }
    }
  } finally {
    host.dispose();
  }
});

test("the loaded preset constant table matches the JSON contract on both faces", async () => {
  requireBuilt();
  const host = await createQuickjsHost();
  try {
    // Cross-bundle check: the WASM copy of ORNITHOPTER_VEHICLE_PRESET_V1 must serialize to
    // exactly the contract JSON the vectors embed (i.e. both bundles carry identical data).
    assert.equal(compact(host.presetJson()), compact(PRESET_JSON), "WASM bundle preset constant diverges from contract JSON");
    assert.equal(compact(JSON.stringify(nativePreset())), compact(PRESET_JSON), "native bundle preset constant diverges from contract JSON");

    // And validating the *loaded object* (not via JSON.parse) is byte-identical too.
    assert.equal(host.validateLoadedPresetObject(), nativeValidateObject(nativePreset()), "preset-object validation diverges");
  } finally {
    host.dispose();
  }
});

/** Normalize whitespace for the preset constant comparison (key order stays significant). */
function compact(jsonText) {
  return JSON.stringify(JSON.parse(jsonText));
}

test("QuickJS supports the unicode regex features the validator needs", async () => {
  requireBuilt();
  const host = await createQuickjsHost();
  try {
    assert.equal(host.regexProbe(), "true", "QuickJS \\p{L} unicode property escape probe failed");
  } finally {
    host.dispose();
  }
});

test("tree-shaken validator-only bundle (validate-vehicle.iife.js) is also byte-identical", async () => {
  requireBuilt();
  const trimmedBundle = BUNDLE_PATH.replace("city-sdk.spike.iife.js", "validate-vehicle.iife.js");
  const host = await createQuickjsHost({ bundlePath: trimmedBundle });
  try {
    for (const vector of VECTORS) {
      const native = validateNative(vector.jsonText);
      const wasm = host.validateJson(vector.jsonText);
      assert.equal(wasm, native, `trimmed-bundle vector ${vector.id} diverges from native`);
    }
  } finally {
    host.dispose();
  }
});
