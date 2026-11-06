#!/usr/bin/env node
// 碰撞精度诊断（docs/CITY_WORLD_PRECISION_AND_SIZE_STANDARD_SPEC.md P2/P6；不进 CI）：改容差或几何时拿来对照。
// 对每个场景里的每个结构 box，按 CollisionIndex.shape() 的口径算「最大面偏差 / 容差」：
//   old = 128·ε·max(1, 实体尺寸)——590c8b30 之前，只按实体大小，远离原点的小 box 全看舍入运气；
//   new = 128·ε·max(1, 实体尺寸, 最大 |坐标|)——现行口径（只剩角点实体走这条检查，box 已按半轴构造）。
// 输出每个场景的 box 数、旧口径下超限（会被拒）与 2 倍以内（随时可能被几何改动推过线）的数量，以及新口径下的同两项。
// 场景取结构编译器的障碍（compileCitySurface().obstacles：桥面、栏杆、墩、匝道板等），与 verify-city-driving-collision --cities 同一组；
// 规范 P2 的 68,294 个是全城静态碰撞体（含建筑与场景实体，要真实场景图），这里只覆盖结构件那一部分（15 场景约 5 千个）。
// 用法：node scripts/diagnose-city-collision-precision.mjs [种子,…] [等级,…]
import { loadCity, cachedPlan } from "./city-kit/index.mjs";
globalThis.window ??= globalThis;
const { createCityPlan, compileCitySurface } = await loadCity({ "engine/cityPlan.ts": ["createCityPlan"], "engine/surface/compileSurface.ts": ["compileCitySurface"] });
const seeds = (process.argv[2] ?? "1,7,42,2026,65537").split(",").map(Number);
const tiers = (process.argv[3] ?? "1,2,3").split(",").map(Number);
const FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]; // CollisionIndex.boxFaces
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
/** 一个 box 在两种口径下的最坏「偏差 / 容差」比值（> 1 即 shape() 会拒绝）。 */
function ratios(v) {
  let worstOld = 0, worstNew = 0;
  for (const f of FACES) {
    const n = cross(sub(v[f[1]], v[f[0]]), sub(v[f[2]], v[f[0]])); const l = len(n); if (!(l > 1e-12)) return { old: Infinity, new: Infinity };
    const normal = { x: n.x / l, y: n.y / l, z: n.z / l };
    const deviation = Math.max(...f.map((i) => Math.abs(dot(normal, sub(v[i], v[f[0]])))));
    const extent = Math.max(1, ...v.map((p) => len(sub(p, v[f[0]]))));
    const coordinate = Math.max(...v.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))));
    worstOld = Math.max(worstOld, deviation / (128 * Number.EPSILON * extent));
    worstNew = Math.max(worstNew, deviation / (128 * Number.EPSILON * Math.max(extent, coordinate)));
  }
  return { old: worstOld, new: worstNew };
}
const total = { boxes: 0, oldOver: 0, oldNear: 0, newOver: 0, newNear: 0 };
for (const seed of seeds) for (const tier of tiers) {
  const boxes = compileCitySurface(cachedPlan(createCityPlan, seed, tier)).obstacles.filter((o) => o.shape === "box");
  const row = { boxes: boxes.length, oldOver: 0, oldNear: 0, newOver: 0, newNear: 0 }; let worst = null;
  for (const box of boxes) {
    const r = ratios(box.corners);
    if (r.old > 1) row.oldOver++; else if (r.old > 0.5) row.oldNear++;
    if (r.new > 1) row.newOver++; else if (r.new > 0.5) row.newNear++;
    if (!worst || r.old > worst.ratio) worst = { id: box.id, ratio: r.old };
  }
  for (const k of Object.keys(total)) total[k] += row[k];
  console.log(`${seed}/${tier}: ${row.boxes} boxes · old tolerance: ${row.oldOver} over, ${row.oldNear} within 2× · current: ${row.newOver} over, ${row.newNear} within 2×` +
    (worst ? ` · worst old ratio ${worst.ratio.toFixed(2)} (${worst.id})` : ""));
}
console.log(`total: ${total.boxes} boxes · old tolerance: ${total.oldOver} over, ${total.oldNear} within 2× · current: ${total.newOver} over, ${total.newNear} within 2×`);
