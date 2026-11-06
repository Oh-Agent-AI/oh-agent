#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.join(repo, "apps/agent-city/ui/src/engine");
const require = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const THREE = require("three");
const { buildSync } = require("esbuild");
// 集成面源级检查：makeInstanced 的初始 count 是 0，新实例网格漏设 count 会让整批件在城里
// 隐形（鳍片曾中招——模块守卫全绿但城市里一顶冠都没有），这里钉住每个批次必须有 count 赋值。
{
  const cityParts = ["cityParts.ts", ...fs.readdirSync(path.join(engine, "systems")).map((f) => `systems/${f}`)].map((f) => fs.readFileSync(path.join(engine, f), "utf8")).join("\n");
  for (const mesh of ["crownFinMesh", "crownStripMesh", "signPostMesh", "signPanelMesh", "signFrameMesh", "signStripeMesh"]) {
    assert.ok(new RegExp(`(?:this|host)\\.${mesh}\\.count\\s*=`).test(cityParts), `cityParts must assign ${mesh}.count`);
  }
}
// 三个地标/构件模块各自独立打包（引擎如何消费它们由布局/基础设施守卫覆盖，这里管模块契约本身）。
const bundle = (file, stdin) => buildSync({
  stdin: { contents: stdin, resolveDir: engine, loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "node", external: ["three"], logLevel: "silent",
}).outputFiles[0].text;
const run = (code) => {
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, process, console, Math, Map, Set });
  return mod.exports;
};

// ── L-3 地中海庄园：占地预算、非空组装、确定性 ──
const villa = run(bundle("cityLandmarkVilla.ts", `import * as THREE from "three";
  export { buildVillaComplex, VILLA_SITE_RADIUS } from "./cityLandmarkVilla";`));
assert.equal(villa.VILLA_SITE_RADIUS, 34);
{
  const box = new THREE.Box3();
  const build = villa.buildVillaComplex(42, false);
  let meshes = 0;
  build.group.updateMatrixWorld(true);
  build.group.traverse((object) => {
    if (!object.isMesh) return;
    meshes += 1;
    box.expandByObject(object);
  });
  assert.ok(meshes >= 12, `villa assembles from primitives (${meshes} meshes)`);
  assert.ok(box.max.x - box.min.x <= 68 && box.max.z - box.min.z <= 68, `villa footprint within site budget (${(box.max.x - box.min.x).toFixed(1)} x ${(box.max.z - box.min.z).toFixed(1)})`);
  assert.ok(box.max.y <= 32, `villa stays low-rise (${box.max.y.toFixed(1)})`);
  const buildAgain = villa.buildVillaComplex(42, false);
  const a = build.group.children.map((child) => `${child.type}:${child.position.x.toFixed(4)}:${child.position.y.toFixed(4)}:${child.position.z.toFixed(4)}`);
  const b = buildAgain.group.children.map((child) => `${child.type}:${child.position.x.toFixed(4)}:${child.position.y.toFixed(4)}:${child.position.z.toFixed(4)}`);
  assert.deepEqual(a, b, "villa is deterministic for the same seed");
  assert.ok(villa.buildVillaComplex(7, true).group.children.length > 0, "neon variant builds");
  for (const disposable of build.disposables) disposable.dispose();
}

// ── L-1 酒店格栅冠：矮楼平顶、null 率带、尺寸边界、确定性 ──
const crown = run(bundle("cityHotelCrown.ts", `import * as THREE from "three";
  export { hotelCrownPlan, HOTEL_CROWN_MAX_FINS } from "./cityHotelCrown";`));
assert.equal(crown.HOTEL_CROWN_MAX_FINS, 9);
{
  let crowned = 0;
  const total = 8 * 8;
  for (let width = 0; width < 8; width += 1) {
    for (let seed = 1; seed <= 8; seed += 1) {
      const slotWidth = 19.5 + width * 1.3;
      const height = 12 + ((width * 8 + seed) % 8) * 8;
      const plan = crown.hotelCrownPlan(slotWidth, 11.2, height, seed / 8);
      if (!plan) continue;
      crowned += 1;
      assert.ok(plan.fins.length >= 5 && plan.fins.length <= crown.HOTEL_CROWN_MAX_FINS, `fin count bounded (${plan.fins.length})`);
      for (const fin of plan.fins) {
        assert.ok(Math.abs(fin.x) <= slotWidth / 2 + 1 && Math.abs(fin.z) <= 11.2 / 2 + 1, `fin within slot (${fin.x.toFixed(2)}, ${fin.z.toFixed(2)})`);
        assert.ok(fin.y > height - 1 && fin.y < height + 6, `fin sits on the roof (y=${fin.y.toFixed(2)}, h=${height})`);
      }
      assert.ok(plan.stripY > height && plan.stripY < height + 1, `neon strip hugs the crown base (stripY=${plan.stripY})`);
      const again = crown.hotelCrownPlan(slotWidth, 11.2, height, seed / 8);
      assert.deepEqual(plan, again, "crown plan is deterministic");
    }
  }
  const rate = crowned / total;
  assert.ok(rate >= 0.3 && rate <= 0.75, `crown rate within the design band (${(rate * 100).toFixed(0)}%)`);
  // 矮楼门限 12 → 6（装饰艺术酒店多为低层，用户：冠在真实种子上 0 实例）。
  for (const height of [3, 5, 5.9]) assert.equal(crown.hotelCrownPlan(25, 11.2, height, 0.9), null, `low hotels stay flat-top (h=${height})`);
}

// ── L-2 招牌：出牌率带、屋顶缘自查、路边牌恒有方案、确定性 ──
const signs = run(bundle("citySkylineProps.ts", `import * as THREE from "three";
  export { rooftopSignPlan, roadsideSignPlan } from "./citySkylineProps";`));
{
  let signsUp = 0;
  const total = 96;
  for (let seed = 1; seed <= total; seed += 1) {
    const plan = signs.rooftopSignPlan(24, 18, 0, seed / total);
    if (!plan) continue;
    signsUp += 1;
    const span = plan.panel.rotY === 0 ? 24 : 18;
    assert.ok(Math.abs(plan.panel.x) <= span / 2, `rooftop panel inside the roof (x=${plan.panel.x})`);
    assert.equal(plan.frame.length, 4, "frame is a four-piece ring");
    assert.ok(plan.stripes.length >= 2 && plan.stripes.length <= 3, `stripes bounded (${plan.stripes.length})`);
    const again = signs.rooftopSignPlan(24, 18, 0, seed / total);
    assert.deepEqual(plan, again, "rooftop plan is deterministic");
  }
  const rate = signsUp / total;
  assert.ok(rate >= 0.3 && rate <= 0.6, `rooftop sign rate within the design band (45% target; candidates widened beyond the commercial zone) (${(rate * 100).toFixed(0)}%)`);
  for (const yaw of [0, 1.2, Math.PI / 2, 4]) {
    const plan = signs.roadsideSignPlan(yaw, 3, 0.42);
    assert.equal(plan.pieces.length, 3, "two posts plus one panel");
    assert.equal(plan.pieces[0].y, 3, "posts stand on the ground");
    assert.ok(plan.pieces[2].y > 7, `panel clears the treetops (y=${plan.pieces[2].y.toFixed(1)})`);
    assert.equal(plan.frame.length, 4, "roadside frame is a ring");
  }
}
console.log("City landmarks: villa budget/determinism, hotel crown gates and sign rates passed.");
