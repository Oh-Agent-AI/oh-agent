#!/usr/bin/env node
// Confirm the single blocker on both engines: `\-` inside a character class under the u flag.
import bellardVariant from "@jitl/quickjs-wasmfile-release-sync";
import ngVariant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

const CASES = [
  ["escaped hyphen in class (u)", "/^[a\\-z]$/u.test('b')"],
  ["plain hyphen in class (u)", "/^[a-z]$/u.test('b')"],
  ["trailing hyphen before ] (u)", "/^[()\\-]$/u.test('-')"],
  ["escaped hyphen, no u flag", "/^[a\\-z]$/.test('b')"],
];

async function probe(name, variant) {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  const ctx = runtime.newContext();
  console.log(`-- ${name} --`);
  for (const [label, code] of CASES) {
    const result = ctx.evalCode(code, "probe.js");
    let outcome;
    if (result.error) {
      const dumped = ctx.dump(result.error);
      result.error.dispose();
      outcome = `ERROR ${dumped && dumped.message ? dumped.message : JSON.stringify(dumped)}`;
    } else {
      outcome = ctx.getString(result.value);
      result.value.dispose();
    }
    console.log(`  ${label}: ${outcome}`);
  }
  ctx.dispose();
  runtime.dispose();
}

await probe("bellard (default quickjs)", bellardVariant);
await probe("quickjs-ng", ngVariant);
