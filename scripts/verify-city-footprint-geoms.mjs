#!/usr/bin/env node
// 实际占地几何守卫（CITY_NETWORK_FIRST_CODE_DESIGN 迁移批次 6a-2，设计 §2 P2 / §8.1 走廊矩阵）：
// 定向矩形与凸多边形距离原语的合成已知解用例——
//   (a) 旋转矩形角点：orientedRectPolygon 的已知三角解（yaw 30°）；
//   (b) 凸性/包含/到点距离：isConvexCounterClockwise、convexContains、pointToPolygonDistance 已知值；
//   (c) 到线段距离与扫掠带净空：segmentToPolygonDistance、sweptBandClearance 已知值（含相交 = 0）；
//   (d) 长条压路检出：80×12 长条离路心 10、半宽 6 → 净空 −2，组合闸门拒绝；
//   (e) 初筛通过但精确复核拒绝：角点越过 16 采样圈的端帽带（旧圆形口径的盲区样本，
//       boundingRadius 取半长 36 而非半对角 36.35——低估角点伸出量正是现状）；
//   (f) 确定性：同输入两次运行同输出。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { orientedRectPolygon, isConvexCounterClockwise, convexContains, pointToPolygonDistance, segmentToSegmentDistance, segmentToPolygonDistance, sweptBandClearance, ringSamples16, footprintClearsRoadBand } = await loadCity({
  "engine/planner/footprint.ts": ["orientedRectPolygon", "isConvexCounterClockwise", "convexContains", "pointToPolygonDistance", "segmentToSegmentDistance", "segmentToPolygonDistance", "sweptBandClearance", "ringSamples16", "footprintClearsRoadBand"],
});

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── (a) 旋转矩形角点 ─────────────────────────────────────────────────────────
{
  const rect = { x: 10, z: 10, yaw: Math.PI / 6, width: 8, depth: 4 };
  const corners = orientedRectPolygon(rect);
  assert.equal(corners.length, 4);
  const c = Math.cos(Math.PI / 6); const s = Math.sin(Math.PI / 6);
  const expected = [[-4, -2], [4, -2], [4, 2], [-4, 2]].map(([lx, lz]) => [10 + c * lx - s * lz, 10 + s * lx + c * lz]);
  corners.forEach((p, i) => { assert.ok(near(p.x, expected[i][0]) && near(p.z, expected[i][1]), `corner ${i} expected (${expected[i]}) got (${p.x}, ${p.z})`); });
  assert.ok(isConvexCounterClockwise(corners), "oriented rect must be convex CCW");
  assert.ok(convexContains(corners, { x: 10, z: 10 }), "rect must contain its centre");
  assert.ok(!convexContains(corners, { x: 10 + 5, z: 10 }), "rect must not contain a point beyond width/2");
}

// ── (b) 凸性 + 到点距离已知值（轴对齐矩形 [0,10]×[0,20]）──────────────────────
{
  const square = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 20 }, { x: 0, z: 20 }];
  assert.ok(isConvexCounterClockwise(square));
  assert.ok(!isConvexCounterClockwise([...square].reverse()), "CW winding must be rejected");
  assert.ok(!isConvexCounterClockwise([{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 2, z: 2 }, { x: 4, z: 4 }, { x: 0, z: 4 }]), "concave polygon must be rejected");
  assert.ok(near(pointToPolygonDistance(square, { x: 13, z: 10 }), 3), "right side gap");
  assert.ok(near(pointToPolygonDistance(square, { x: -4, z: 25 }), Math.sqrt(16 + 25)), "corner gap = hypot(4,5)");
  assert.ok(near(pointToPolygonDistance(square, { x: 5, z: 7 }), 0), "inside → 0");
  assert.ok(near(pointToPolygonDistance(square, { x: 0, z: 10 }), 0), "on the boundary → 0");
}

// ── (c) 到线段距离 + 扫掠带净空 ──────────────────────────────────────────────
{
  assert.ok(near(segmentToSegmentDistance({ x: 0, z: 5 }, { x: 10, z: 5 }, { x: 0, z: 0 }, { x: 10, z: 0 }), 5), "parallel gap");
  assert.ok(near(segmentToSegmentDistance({ x: -5, z: -5 }, { x: 5, z: 5 }, { x: -5, z: 5 }, { x: 5, z: -5 }), 0), "X crossing → 0");
  assert.ok(near(segmentToSegmentDistance({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 0 }, { x: 20, z: 0 }), 0), "collinear touch → 0");
  const square = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 20 }, { x: 0, z: 20 }];
  assert.ok(near(segmentToPolygonDistance({ x: 17, z: 10 }, { x: 17, z: 12 }, square), 7), "parallel segment gap");
  assert.ok(near(segmentToPolygonDistance({ x: 5, z: -5 }, { x: 5, z: 25 }, square), 0), "segment crossing polygon → 0");
  assert.ok(near(segmentToPolygonDistance({ x: 5, z: 15 }, { x: 5, z: 30 }, square), 0), "endpoint inside → 0");
  // 净空 = 到中心线距离 − 半宽：平行路离边 7、半宽 6 → 1；穿心 → −半宽。
  assert.ok(near(sweptBandClearance(square, { x: 17, z: 10 }, { x: 17, z: 12 }, 6), 1), "band clearance = gap − halfWidth");
  assert.ok(near(sweptBandClearance(square, { x: 5, z: -5 }, { x: 5, z: 25 }, 6), -6), "centre line through polygon → −halfWidth");
}

// ── (d) 长条压路检出：80×12 长条中心离路心 10、半宽 6 → 净空 −2，闸门拒绝 ────
{
  const bar = orientedRectPolygon({ x: 100, z: 10, yaw: 0, width: 80, depth: 12 });
  const road = [[{ x: 0, z: 0 }, { x: 200, z: 0 }]];
  assert.ok(near(sweptBandClearance(bar, road[0][0], road[0][1], 6), -2), `long bar over road must read -2, got ${sweptBandClearance(bar, road[0][0], road[0][1], 6)}`);
  assert.equal(footprintClearsRoadBand(bar, { x: 100, z: 10 }, 40.45, road, 6), false, "long bar must be rejected");
  // 正面确认（避免「永远拒绝」的假通过）：整个包围圈（半径 40.45）都离带 ≥ 半宽+margin 的长条必须通过。
  const clear = orientedRectPolygon({ x: 100, z: 52, yaw: 0, width: 80, depth: 12 });
  assert.equal(footprintClearsRoadBand(clear, { x: 100, z: 52 }, 40.45, road, 6, 2), true, "bar whose whole bounding circle clears the band + margin 2 must pass");
}

// ── (e) 初筛通过但精确复核拒绝：角点越过 16 采样圈的端帽带 ────────────────────
// 矩形 72×10，boundingRadius 记 36（半长；半对角实为 36.35——现状口径的低估）。
// 路段端点 E 放在 11.25°（两采样角的正中）距离 38.3 处，半宽 2：采样圈最近点离 E 7.6
// （初筛全过），而 11.25° 方向的角点伸到 36.35、离 E 1.96 < 2（精确复核拒绝）。
{
  const yaw = (11.25 - (Math.atan2(5, 36) * 180) / Math.PI) * (Math.PI / 180);
  const rect = orientedRectPolygon({ x: 0, z: 0, yaw, width: 72, depth: 10 });
  const a = { x: 38.3 * Math.cos(Math.PI / 16), z: 38.3 * Math.sin(Math.PI / 16) };
  const b = { x: a.x + 100, z: a.z };
  const road = [[a, b]];
  const samples = ringSamples16({ x: 0, z: 0 }, 36);
  const minSample = Math.min(...samples.map((p) => Math.hypot(p.x - a.x, p.z - a.z)));
  assert.ok(minSample > 2, `prescreen samples must clear the endpoint band (min ${minSample.toFixed(2)} > 2)`);
  const corner = rect.reduce((best, p) => (Math.hypot(p.x - a.x, p.z - a.z) < Math.hypot(best.x - a.x, best.z - a.z) ? p : best));
  const cornerDist = Math.hypot(corner.x - a.x, corner.z - a.z);
  assert.ok(cornerDist < 2, `rotated corner must reach inside the band (${cornerDist.toFixed(3)} < 2)`);
  assert.ok(sweptBandClearance(rect, a, b, 2) < 0, "exact recheck must reject");
  assert.equal(footprintClearsRoadBand(rect, { x: 0, z: 0 }, 36, road, 2), false, "combined gate must reject the prescreen-passing corner clip");
  // 初筛的保守方向确认：把占地整个挪出带外后，同一闸门必须通过（初筛不只「永远拒绝」）。
  const rectFar = orientedRectPolygon({ x: -100, z: 0, yaw, width: 72, depth: 10 });
  assert.equal(footprintClearsRoadBand(rectFar, { x: -100, z: 0 }, 36, road, 2), true, "footprint well away must pass");
}

// ── (f) 确定性：双跑同输出 ───────────────────────────────────────────────────
{
  const rect = orientedRectPolygon({ x: 5, z: -3, yaw: 0.7, width: 30, depth: 9 });
  const runs = [[{ x: -50, z: 10 }, { x: 0, z: 0 }, { x: 60, z: -8 }]];
  for (const margin of [0, 2, 6]) {
    const r1 = footprintClearsRoadBand(rect, { x: 5, z: -3 }, 16, runs, 6, margin);
    const r2 = footprintClearsRoadBand(rect, { x: 5, z: -3 }, 16, runs, 6, margin);
    assert.equal(r1, r2, `not deterministic at margin ${margin}`);
  }
  assert.deepEqual(ringSamples16({ x: 1, z: 2 }, 9), ringSamples16({ x: 1, z: 2 }, 9), "ringSamples16 not deterministic");
  assert.equal(ringSamples16({ x: 0, z: 0 }, 10).length, 16);
}

console.log("City footprint geoms: oriented-rect/convex-polygon distances, swept-band clearance, and the 16-sample-prescreen + exact-recheck gate — rotated corners known-answer, long bar on road detected, corner-clip past the sample ring rejected, deterministic.");
