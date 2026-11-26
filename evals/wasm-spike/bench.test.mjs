#!/usr/bin/env node
// Timing/size measurements for SPIKE_REPORT.md (rough numbers, spike grade).
import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { VECTORS, PRESET_JSON } from "./vectors.mjs";
import { validateNative, distIndex } from "./native-host.mjs";
import { createQuickjsHost, BUNDLE_PATH } from "./quickjs-host.mjs";

test("bench: sizes, cold start, per-validation latency (printed for the report)", async () => {
  const bundleBytes = statSync(BUNDLE_PATH).size;
  const distBytes = statSync(distIndex).size;
  const wasmBytes = statSync(new URL("./node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm", import.meta.url)).size;
  const trimmedBytes = statSync(BUNDLE_PATH.replace("city-sdk.spike.iife.js", "validate-vehicle.iife.js")).size;
  console.log(`sizes: dist/index.js=${distBytes}B, spike IIFE bundle=${bundleBytes}B, validator-only IIFE bundle=${trimmedBytes}B, quickjs release-sync .wasm=${wasmBytes}B`);

  const host = await createQuickjsHost();
  try {
    const { timings } = host;
    // first validation (includes runtime warm-up inside the interpreter)
    const tFirst0 = performance.now();
    const first = host.validateJson(PRESET_JSON);
    const firstValidationMs = performance.now() - tFirst0;
    assert.ok(first.includes('"ok":true'));

    // warm per-validation through the evalCode bridge (integration-realistic upper bound)
    const HOST_LOOP = 2000;
    const hostBench = host.benchHostLoop(PRESET_JSON, HOST_LOOP);
    const perCallBridgeUs = (hostBench.elapsedMs / HOST_LOOP * 1000).toFixed(1);

    // pure in-interpreter cost, no per-call bridge
    const IN_LOOP = 5000;
    const inBench = host.benchInQuickJS(PRESET_JSON, IN_LOOP);
    const perCallInterpreterUs = (inBench.elapsedMs / IN_LOOP * 1000).toFixed(1);

    // native (V8) comparison on the same machine
    const NATIVE_LOOP = 20000;
    const tNative0 = performance.now();
    let lastNative = "";
    for (let index = 0; index < NATIVE_LOOP; index += 1) lastNative = validateNative(PRESET_JSON);
    const nativePerCallUs = ((performance.now() - tNative0) / NATIVE_LOOP * 1000).toFixed(1);
    assert.equal(lastNative, hostBench.last, "post-bench sanity: outputs still identical");

    console.log(`cold start: wasm instantiate=${timings.wasmInstantiateMs.toFixed(1)}ms, bundle load=${timings.bundleLoadMs.toFixed(1)}ms, entry shim=${timings.entryShimMs.toFixed(1)}ms`);
    console.log(`first validation after load: ${firstValidationMs.toFixed(1)}ms`);
    console.log(`per-validation (warm): in-QuickJS=${perCallInterpreterUs}us, via evalCode bridge=${perCallBridgeUs}us, native V8=${nativePerCallUs}us`);

    // JSON-bridge measurement: native JSON round trip cost already included on both sides.
    assert.ok(hostBench.elapsedMs > 0 && inBench.elapsedMs > 0);
  } finally {
    host.dispose();
  }
});
