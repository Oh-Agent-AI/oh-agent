#!/usr/bin/env node
// 地标造型基线哈希（CITY_ARCHITECTURE 迁移步 2 / BUILDING_MODEL_SPEC v2 §6.4）：对 10 个致敬地标 × {霓虹关, 霓虹开}
// 加机场岛，各自在 Node 里构建 THREE 对象，取场景图哈希（几何、世界矩阵、材质可见属性），与
// golden/city-landmark-baseline.json 比较。重构地标造型（拆文件、材质缓存、改成 Part 声明）前后哈希必须相等；
// 有意改造型才 --update，且先 --diff 看是哪几个地标变了。
//   node scripts/verify-city-landmark-baseline.mjs [--diff|--update]
// 贴图内容不进哈希（Node 里画布是空替身），只记「有贴图」；夜灯批次用占位 MeshBasic，故只验证摆放不验证亮度。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCity, repo } from "./city-kit/index.mjs";
import { installCanvasShim, sceneHash } from "./city-kit/scene-hash.mjs";

installCanvasShim();
const { THREE, LANDMARK_BUILDERS, buildAirport, createMaterialFactory } = await loadCity({
  "pkg:three": ["* as THREE"],
  "engine/render/landmarkMaterials.ts": ["createMaterialFactory"],
  "engine/render/landmarkBuilders.ts": ["LANDMARK_BUILDERS"],
  "engine/cityAirport.ts": ["buildAirport"],
});
const goldenPath = path.join(repo, "golden/city-landmark-baseline.json");

// cached = true 镜像 landmarkSystem.buildLandmarks 的缓存材质工厂（同一份 createMaterialFactory）；false = 批 0a 之前的「每次 new」。
function buildLandmark(kind, neon, cached = true) {
  const disposables = [];
  const landmark = { id: `landmark:${kind}`, kind, x: 0, z: 0, yaw: 0.4, radius: 30, ...(kind === "suspension-bridge" ? { to: { x: 90, z: 30 } } : {}) };
  const group = new THREE.Group();
  group.position.set(0, 0.3, 0);
  group.rotation.y = landmark.yaw;
  const material = cached ? createMaterialFactory() : (color, emissive = 0) => new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(emissive) });
  const mesh = (geometry, mat, parent, x, y, z, ry = 0) => { const m = new THREE.Mesh(geometry, mat); m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); return m; };
  const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion(); const scaleVector = new THREE.Vector3(); const positionVector = new THREE.Vector3(); const euler = new THREE.Euler();
  const host = {
    disposables, landmarkSpinners: [], landmarkWindows: [], layout: { terrain: { height: () => 0.5 } }, group: new THREE.Group(),
    nightLights: { heads: new THREE.MeshBasicMaterial(), pools: new THREE.MeshBasicMaterial(), strips: new THREE.MeshBasicMaterial(), neon: new THREE.MeshBasicMaterial() },
    compose: (x, y, z, rotationY, sx, sy, sz) => { euler.set(0, rotationY, 0); quaternion.setFromEuler(euler); positionVector.set(x, y, z); scaleVector.set(Math.max(sx, 1e-4), Math.max(sy, 1e-4), Math.max(sz, 1e-4)); matrix.compose(positionVector, quaternion, scaleVector); },
    matrix, color: new THREE.Color(), spillWhite: new THREE.Color(), positionVector, quaternion, scaleVector,
  };
  LANDMARK_BUILDERS[kind]({ group, landmark, mesh, material, white: material("#f3f1ea"), steel: material("#c9cfd3"), red: material("#c8473a"), cap: 70, neon, host });
  host.group.add(group); // 悬索桥灯串直接加进 host.group：一并哈希
  const distinct = new Set(); host.group.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) distinct.add(m); });
  return { root: host.group, materials: distinct.size, spinners: host.landmarkSpinners.length, windows: host.landmarkWindows.length };
}

const current = {};
const saving = [];
for (const kind of Object.keys(LANDMARK_BUILDERS)) {
  for (const neon of [false, true]) {
    const built = buildLandmark(kind, neon);
    const before = buildLandmark(kind, neon, false);
    saving.push({ kind: `${kind}${neon ? "+neon" : ""}`, before: before.materials, after: built.materials });
    const { hash, meshes } = sceneHash(THREE, built.root);
    current[`${kind}${neon ? "+neon" : ""}`] = { hash, meshes, spinners: built.spinners, windows: built.windows };
  }
}
{
  const plan = { shore: { x: 0, z: 0 }, centre: { x: 0, z: 140 }, outward: { x: 0, z: 1 }, yaw: 0 };
  const { hash, meshes } = sceneHash(THREE, buildAirport(plan, [], new THREE.MeshBasicMaterial()));
  current.airport = { hash, meshes };
}

if (process.argv.includes("--update")) {
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, `${JSON.stringify(current, null, 1)}\n`);
  {
  const sum = (key) => saving.reduce((a, r) => a + r[key], 0);
  console.log(`City landmark materials (distinct material objects per landmark, uncached -> cached; neon off):`);
  for (const r of saving.filter((x) => !x.kind.endsWith("+neon"))) console.log(`  ${r.kind.padEnd(18)} ${String(r.before).padStart(4)} -> ${String(r.after).padStart(3)}`);
  console.log(`  total (neon off+on) ${sum("before")} -> ${sum("after")}`);
}
console.log(`City landmark baseline: rewrote ${Object.keys(current).length} model hashes.`);
  process.exit(0);
}
assert(fs.existsSync(goldenPath), "golden/city-landmark-baseline.json missing — run with --update once and review");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const changed = Object.keys(current).filter((k) => JSON.stringify(golden[k]) !== JSON.stringify(current[k]));
const missing = Object.keys(golden).filter((k) => !(k in current));
if (changed.length || missing.length) assert.fail(`landmark models changed: ${[...changed.map((k) => `${k} (${golden[k]?.meshes ?? "new"} → ${current[k].meshes} meshes)`), ...missing.map((k) => `${k} (removed)`)].join(", ")}`);
{
  const sum = (key) => saving.reduce((a, r) => a + r[key], 0);
  console.log(`City landmark materials (distinct material objects per landmark, uncached -> cached; neon off):`);
  for (const r of saving.filter((x) => !x.kind.endsWith("+neon"))) console.log(`  ${r.kind.padEnd(18)} ${String(r.before).padStart(4)} -> ${String(r.after).padStart(3)}`);
  console.log(`  total (neon off+on) ${sum("before")} -> ${sum("after")}`);
}
console.log(`City landmark baseline: ${Object.keys(current).length} model hashes (10 landmarks × neon off/on + airport) match golden/city-landmark-baseline.json.`);
