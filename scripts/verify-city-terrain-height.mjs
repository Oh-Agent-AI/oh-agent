#!/usr/bin/env node
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const { buildSync } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("esbuild");
const code = buildSync({ stdin: { contents: 'export { buildGeography } from "./planner/geography"; export { fbm, smoothstep } from "./cityNoise"; export { DetMath } from "./detMath";', resolveDir: new URL("../apps/agent-city/ui/src/engine/", import.meta.url).pathname }, bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { buildGeography, fbm, smoothstep, DetMath } = mod.exports;
let samples = 0, flat = 0, hills = 0;
for (const seed of [1, 42, 74031, 1703294958, 4294967295]) {
  const geo = buildGeography(seed, 250, { harmonics: [{ a: .2, k: 3, p: 1 }], bays: [{ at: .4, depth: .2, width: .3 }], stretch: 1.2, spin: .5 });
  const reach = DetMath.max(...geo.coast.map((p) => p.x * geo.hillDir.x + p.z * geo.hillDir.z));
  for (let x = -300; x <= 300; x += 12) for (let z = -300; z <= 300; z += 12) {
    const inland = geo.landClearance(x, z);
    const weight = smoothstep(geo.hillLine - 10, geo.hillLine + reach * .3, geo.hillProj(x, z));
    const original = inland < 0 ? -.65 - DetMath.min(5, -inland * .25)
      : smoothstep(0, 10, inland) * (1.2 + weight * (30 + 65 * fbm(x * .012, z * .013, seed, 4)));
    assert.equal(geo.height(x, z), original, `seed ${seed}, ${x}/${z}: preserve exact height`);
    if (inland >= 0) { if (weight === 0) flat++; else hills++; }
    samples++;
  }
}
assert.ok(flat > 0 && hills > 0);
console.log(`City terrain: ${samples} exact-height samples passed (flat ${flat}, hills ${hills}).`);
