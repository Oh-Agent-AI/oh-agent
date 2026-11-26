/**
 * WASM-QuickJS execution face of the spike.
 *
 * Loads the spike IIFE bundle (a pure re-bundle of packages/agent-vitals-city-sdk/dist/index.js,
 * produced by scripts/build-spike.mjs) into quickjs-emscripten's release-sync QuickJS WASM
 * runtime as a plain script. The bundle defines a `citySdk` global; a small entry shim exposes
 * `__spike.validateJson(jsonText)` so both execution faces consume identical JSON text inputs
 * and return identical JSON.stringify'd diagnostics with no object marshaling across the bridge.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { getQuickJS } from "quickjs-emscripten";

export const BUNDLE_PATH = path.resolve(import.meta.dirname, "build/city-sdk.spike.iife.js");

const ENTRY_SHIM = `
globalThis.__spike = {
  validateJson: function (jsonText) {
    return JSON.stringify(citySdk.validateVehicleProfileV1(JSON.parse(jsonText)));
  },
  validateObject: function (profile) {
    return JSON.stringify(citySdk.validateVehicleProfileV1(profile));
  },
  preset: citySdk.ORNITHOPTER_VEHICLE_PRESET_V1,
  presetJson: JSON.stringify(citySdk.ORNITHOPTER_VEHICLE_PRESET_V1),
  regexProbe: (function () {
    try {
      return String(/^[\\p{L}\\p{N}][\\p{L}\\p{N} .·、（）()-]{0,126}$/u.test("扑翼机"));
    } catch (error) {
      return "regex-error: " + String(error);
    }
  })(),
  version: typeof QuickJSVersion !== "undefined" ? String(QuickJSVersion) : "unknown",
};
`;

function evalScript(ctx, code, label) {
  const result = ctx.evalCode(code, `spike/${label}.js`);
  if (result.error) {
    const dumped = ctx.dump(result.error);
    result.error.dispose();
    const message = typeof dumped === "string" ? dumped : JSON.stringify(dumped);
    throw new Error(`QuickJS eval failed (${label}): ${message}`);
  }
  return result.value;
}

export async function createQuickjsHost({ bundlePath = BUNDLE_PATH } = {}) {
  const bundleSource = readFileSync(bundlePath, "utf8");
  const timings = {};

  const t0 = performance.now();
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  const ctx = runtime.newContext();
  timings.wasmInstantiateMs = performance.now() - t0;

  const t1 = performance.now();
  const bundleHandle = evalScript(ctx, bundleSource, "bundle");
  bundleHandle.dispose();
  timings.bundleLoadMs = performance.now() - t1;

  const t2 = performance.now();
  const shimHandle = evalScript(ctx, ENTRY_SHIM, "entry-shim");
  shimHandle.dispose();
  timings.entryShimMs = performance.now() - t2;

  return {
    timings,
    presetJson: () => ctx.getString(evalScript(ctx, "__spike.presetJson", "preset-json")),
    regexProbe: () => ctx.getString(evalScript(ctx, "__spike.regexProbe", "regex-probe")),
    quickjsVersion: () => ctx.getString(evalScript(ctx, "__spike.version", "version")),
    validateJson(jsonText) {
      const callCode = `__spike.validateJson(${JSON.stringify(jsonText)})`;
      return ctx.getString(evalScript(ctx, callCode, "validate"));
    },
    validateLoadedPresetObject() {
      return ctx.getString(evalScript(ctx, "__spike.validateObject(__spike.preset)", "validate-preset-object"));
    },
    /** In-interpreter loop: pure QuickJS parse+validate cost, no per-call bridge overhead. */
    benchInQuickJS(jsonText, iterations) {
      const benchCode = `
        (function (count, payload) {
          var started = Date.now();
          var last = null;
          for (var index = 0; index < count; index += 1) {
            last = __spike.validateJson(payload);
          }
          return JSON.stringify({ elapsedMs: Date.now() - started, last: last });
        })(${iterations}, ${JSON.stringify(jsonText)})
      `;
      return JSON.parse(ctx.getString(evalScript(ctx, benchCode, "bench")));
    },
    /** Host-loop timing: full round trip incl. evalCode bridge, the integration-realistic cost. */
    benchHostLoop(jsonText, iterations) {
      const callCode = `__spike.validateJson(${JSON.stringify(jsonText)})`;
      const started = performance.now();
      let last = "";
      for (let index = 0; index < iterations; index += 1) last = this.validateJson(jsonText);
      return { elapsedMs: performance.now() - started, last };
    },
    dispose() {
      ctx.dispose();
      runtime.dispose();
    },
  };
}
