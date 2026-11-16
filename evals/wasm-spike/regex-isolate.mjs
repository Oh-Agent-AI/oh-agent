#!/usr/bin/env node
// Isolate the exact regexp construct that breaks Bellard QuickJS in the vehicle LABEL regex.
import { getQuickJS } from "quickjs-emscripten";

const QuickJS = await getQuickJS();
const runtime = QuickJS.newRuntime();
const ctx = runtime.newContext();

function evalOne(code) {
  const result = ctx.evalCode(code, "probe.js");
  if (result.error) {
    const dumped = ctx.dump(result.error);
    result.error.dispose();
    return `ERROR ${dumped && dumped.message ? dumped.message : JSON.stringify(dumped)}`;
  }
  const value = ctx.getString(result.value);
  result.value.dispose();
  return value;
}

const cases = [
  ["class pL", "/^[\\p{L}]$/u.test('a')"],
  ["class pL pN", "/^[\\p{L}\\p{N}]$/u.test('a')"],
  ["class literal CJK", "/^[ ·、（）()\\-]$/u.test('·')"],
  ["class escape hyphen", "/^[a\\-z]$/u.test('b')"],
  ["LABEL full", "/^[\\p{L}\\p{N}][\\p{L}\\p{N} .·、（）()\\-]{0,126}$/u.test('扑翼机')"],
  ["LABEL no hyphen", "/^[\\p{L}\\p{N}][\\p{L}\\p{N} .·、（）()]{0,126}$/u.test('扑翼机')"],
  ["LABEL ascii-only class", "/^[\\p{L}\\p{N}][\\p{L}\\p{N} .]{0,126}$/u.test('扑翼机')"],
  ["pLu outside class", "/^\\p{Lu}$/u.test('A')"],
  ["class negated pL", "/^[^\\p{L}]$/u.test('1')"],
];
for (const [name, code] of cases) {
  console.log(`${name}:`, evalOne(code));
}
ctx.dispose();
runtime.dispose();
