#!/usr/bin/env node
// Javy leg of the W1 spike (spec section 11.3): run every acceptance vector through the
// Javy-compiled .wasm module under wasmtime and byte-compare the diagnostics against the
// Node-native execution of the same validator.
//
// Binaries are untrusted downloads living outside the worktree (see SPIKE_REPORT.md);
// paths are supplied via JAVY_WASM and WASMTIME_BIN env (defaults match the spike notes).
// Regenerate the module with:
//   node scripts/build-javy-input.mjs
//   javy build -C dynamic=n -o <tmp>/validate-vehicle.wasm build/javy-entry.js
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { VECTORS } from "../vectors.mjs";
import { validateNative } from "../native-host.mjs";

const JAVY_WASM = process.env.JAVY_WASM ?? "/tmp/wasm-spike-javy/validate-vehicle.wasm";
const WASMTIME_BIN = process.env.WASMTIME_BIN ?? "/tmp/wasm-spike-javy/wasmtime-v50.0.1-aarch64-macos/wasmtime";

if (!existsSync(JAVY_WASM)) {
  console.error(`Javy wasm module missing at ${JAVY_WASM}; see scripts/build-javy-input.mjs header.`);
  process.exit(2);
}
if (!existsSync(WASMTIME_BIN)) {
  console.error(`wasmtime missing at ${WASMTIME_BIN}.`);
  process.exit(2);
}

const wasmBytes = statSync(JAVY_WASM).size;
console.log(`javy module: ${JAVY_WASM} (${wasmBytes}B)`);

let failures = 0;
for (const vector of VECTORS) {
  const started = performance.now();
  const run = spawnSync(WASMTIME_BIN, ["run", JAVY_WASM], {
    input: vector.jsonText,
    encoding: "utf8",
    timeout: 60_000,
  });
  const elapsedMs = performance.now() - started;
  if (run.status !== 0) {
    failures += 1;
    console.log(`${vector.id}: RUN FAILED (status ${run.status})\n  stderr: ${(run.stderr ?? "").slice(0, 400)}`);
    continue;
  }
  const wasmOut = (run.stdout ?? "").trim();
  const native = validateNative(vector.jsonText).trim();
  if (wasmOut === native) {
    const verdict = JSON.parse(wasmOut);
    console.log(`${vector.id}: IDENTICAL (ok=${verdict.ok}, diagnostics=${(verdict.diagnostics ?? []).length}) [wasmtime run ${elapsedMs.toFixed(0)}ms incl. process+JIT]`);
  } else {
    failures += 1;
    console.log(`${vector.id}: DIVERGENT\n  native: ${native.slice(0, 200)}\n  javy:   ${wasmOut.slice(0, 200)}\n  stderr: ${(run.stderr ?? "").slice(0, 200)}`);
  }
}

console.log(failures === 0 ? "javy leg: all vectors byte-identical" : `javy leg: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
