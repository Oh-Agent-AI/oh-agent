#!/usr/bin/env node
// W1 spike (docs/STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md section 11.3).
//
// Bundle the *already built* city-sdk dist artifact (packages/agent-vitals-city-sdk/dist/index.js,
// the esbuild ESM product of the same TS sources the Studio webview executes) into a single
// IIFE script that exposes a `citySdk` global. That shape is loadable by plain-script eval in
// QuickJS (quickjs-emscripten), which has no ES-module import plumbing in the spike harness.
//
// Nothing here changes the city-sdk package build: the spike consumes dist as-is.

import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const spikeRoot = fileURLToPath(new URL("../", import.meta.url));
const citySdkDist = path.resolve(spikeRoot, "../../packages/agent-vitals-city-sdk/dist/index.js");
const outDir = path.join(spikeRoot, "build");
const outFile = path.join(outDir, "city-sdk.spike.iife.js");
mkdirSync(outDir, { recursive: true });

await build({
  absWorkingDir: spikeRoot,
  entryPoints: {
    "city-sdk.spike.iife": citySdkDist,
    "validate-vehicle.iife": path.join(spikeRoot, "scripts/entry-validator.mjs"),
  },
  outdir: outDir,
  bundle: true,
  format: "iife",
  globalName: "citySdk",
  platform: "neutral",
  target: ["es2022"],
  sourcemap: false,
  logLevel: "info",
});

// Known QuickJS incompatibility (spike finding, 2026-11-16): both Bellard quickjs and
// quickjs-ng reject the ES-spec-legal `\-` class escape under the `u` flag
// (`/^[a\-z]$/u` -> "invalid escape sequence in regular expression"; V8 and the
// ECMAScript grammar accept it). The vehicle validator's LABEL regex contains exactly
// one such escape. `\-` inside a character class denotes the literal hyphen `-`, so the
// rewrite below is semantics-preserving by grammar — but it IS a textual divergence from
// the bytes Studio executes and must be revisited upstream (drop the pointless `\`).
// The assertions make the patch fail loudly if the bundle text drifts.
const patchFrom = String.raw`（）()\-]{0,126}`;
const patchTo = String.raw`（）()-]{0,126}`;
const patchTargets = [
  path.join(outDir, "city-sdk.spike.iife.js"),
  path.join(outDir, "validate-vehicle.iife.js"),
];
for (const target of patchTargets) {
  const bundleSource = readFileSync(target, "utf8");
  const occurrences = bundleSource.split(patchFrom).length - 1;
  if (occurrences > 1) {
    console.error(`QuickJS compat patch aborted: LABEL regex marker found ${occurrences} times in ${path.basename(target)} (expected 0 or 1).`);
    process.exit(1);
  }
  if (occurrences === 1) {
    writeFileSync(target, bundleSource.replace(patchFrom, patchTo));
    console.log(`applied QuickJS class-escape compat patch to ${path.basename(target)} (1 occurrence): \\- -> - inside the LABEL character class`);
  }
}
