#!/usr/bin/env node
// 桥头落地环守卫（E 轨 2026-10-08，CITY_NETWORK_FIRST_CODE_DESIGN §4.2「桥头和地面路同时校验位置、
// 高度及切向连续性」的落地环实现批，设计 §8 合成场景）：
//   (a) 45° 失配：桥轴向与接地路向夹角 45° → 桥头建环（桥面端点落在环上、接地路径向重锚到环缘），
//       建环后 bridgeheadContinuity 视角（桥两端各至少接一条非桥边）通过；
//   (b) 接地路缺失：环缘外平行路以接杆捕获，中段垂足拆边成 T 口、宿主属性（等级/宽度）继承；
//   (c) 近失误擦肩：接地路端点离桥头 <2（不并点）→ 宿主边端点重锚到桥头 + 整环，桥头地面度数 ≥2；
//   (d) 真无地可接：如实 declined（不建「通向虚无的环」），正式网络逐字节不变；
//   (e) 确定性：同输入两遍，报告与网络完全一致。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { buildLandingCircles, emptyNetwork, addNetworkEdge } = await loadCity({
  "engine/planner/landing.ts": ["buildLandingCircles"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
});

/** 合成地理：平地岛（高 1.2、全域可建、无河），落环判据只剩触发条件本身。 */
const height = () => 1.2;
const geo = {
  R: 1200, coast: [], bbox: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 }, hasRiver: false, river: [], riverShift: 0,
  riverX: () => 0, riverWidth: () => -1e6, coastDistance: () => 500, landClearance: () => 500, hillAngle: 0, hillDir: { x: 0, z: 1 },
  hillLine: 5000, hillProj: () => -1, height, buildable: () => true,
  terrain: { height, slope: () => 0.2, buildable: () => true, center: { x: 0, z: 0 }, radius: 1200, coastRadius: () => 1200, hasRiver: false },
};
const world = (network) => ({ network, geo, inRiver: () => false, sites: () => [] });
const snap = (n) => JSON.stringify({ v: n.version ?? 0, nodes: [...n.nodes], edges: [...n.edges] });
/** bridgeheadContinuity 的核心谓词（constraints.ts 同判据；合成场景无海上地标豁免项）。 */
const bridgeEndsGrounded = (network) => {
  const grounded = new Set();
  for (const e of network.edges.values()) if (!e.bridge) { grounded.add(e.from); grounded.add(e.to); }
  return [...network.edges.values()].filter((e) => e.bridge).every((e) => grounded.has(e.from) && grounded.has(e.to));
};
/** 桥头的地面度数（pruneShortSpurs 的 deg 只数地面边——「桥+1 地面边」正是被删形状）。 */
const groundDegree = (network, id) => [...network.edges.values()].filter((e) => !e.bridge && (e.from === id || e.to === id)).length;
const noOrphans = (network) => {
  const used = new Set();
  for (const e of network.edges.values()) { used.add(e.from); used.add(e.to); }
  return [...network.nodes.keys()].every((id) => used.has(id));
};

// (a) 45° 失配：桥沿 +x，接地路从桥头向 45°。建环后桥两端都接地、桥头地面度数 ≥2、环 4–6 段。
{
  const n = emptyNetwork();
  addNetworkEdge(n, { x: 0, z: 0 }, { x: 90, z: 0 }, false, true);    // 桥
  addNetworkEdge(n, { x: 0, z: 0 }, { x: 56.57, z: 56.57 }, false);   // 接地路，与桥轴夹角 45°
  addNetworkEdge(n, { x: 90, z: 0 }, { x: 160, z: 0 }, false);        // 对岸桥头对齐接地路（不触发）
  const r = buildLandingCircles(world(n));
  assert.ok(r.built === 1 && r.declined.length === 0, `45deg mismatch must build one ring: ${JSON.stringify(r)}`);
  assert.ok(r.rings[0].radius >= 10 && r.rings[0].radius <= 14, "ring radius must stay in the 10-14 band");
  assert.ok(bridgeEndsGrounded(n), "bridgeheadContinuity view: both bridge ends must touch a ground edge");
  assert.ok(groundDegree(n, "0:0") >= 2, "the mismatched head must have ground degree >= 2 (prune-proof)");
  const ringEdges = [...n.edges.values()].filter((e) => !e.bridge && !["0:0", "90:0", "160:0"].includes(e.from) && !["0:0", "90:0", "160:0"].includes(e.to));
  assert.ok(ringEdges.length >= 4 && ringEdges.length <= 8, `4-6 arc edges expected (re-anchor adds one), got ${ringEdges.length}`);
  assert.ok(noOrphans(n), "no orphan nodes after the landing patch");
}

// (b) 接地路缺失 + 接杆捕获：桥头无地面边，环缘外 10 有一条干道——垂足拆边成 T 口、属性继承。
{
  const n = emptyNetwork();
  addNetworkEdge(n, { x: 0, z: 0 }, { x: 90, z: 0 }, false, true);
  addNetworkEdge(n, { x: 90, z: 0 }, { x: 160, z: 0 }, false);
  addNetworkEdge(n, { x: -60, z: 22 }, { x: 60, z: 22 }, true, false, true); // 宽 12 干道
  const r = buildLandingCircles(world(n));
  assert.ok(r.built === 1, `capture ring expected: ${JSON.stringify(r)}`);
  assert.ok(bridgeEndsGrounded(n), "capture ring must ground the bridgehead");
  assert.ok(!n.edges.has(["-60:22", "60:22"].sort().join("/")), "the host road must be split into a T junction");
  const halves = [...n.edges.values()].filter((e) => e.width === 12 && Math.abs(e.points[0].z - 22) < 0.01 && Math.abs(e.points[1].z - 22) < 0.01);
  assert.equal(halves.length, 2, "split halves must inherit the primary width");
  assert.ok(noOrphans(n), "no orphan nodes after the capture patch");
}

// (c) 近失误擦肩：接地路端点离桥头 0.89（不并点）→ 重锚到桥头 + 整环；桥头地面度数 ≥2。
{
  const n = emptyNetwork();
  addNetworkEdge(n, { x: 0, z: 0 }, { x: 90, z: 0 }, false, true);
  addNetworkEdge(n, { x: 90, z: 0 }, { x: 160, z: 0 }, false);
  addNetworkEdge(n, { x: 0.8, z: -0.4 }, { x: 50, z: -30 }, false); // 端点擦肩 0.89
  const r = buildLandingCircles(world(n));
  assert.ok(r.built === 1, `near-miss re-anchor ring expected: ${JSON.stringify(r)}`);
  assert.ok(bridgeEndsGrounded(n), "near-miss ring must ground the bridgehead");
  assert.ok(groundDegree(n, "0:0") >= 2, "the near-miss head must be prune-proof (ground degree >= 2)");
  assert.ok(!n.nodes.has("0.8:-0.4"), "the merged-away endpoint must not stay as an orphan node");
}

// (d) 真无地可接：如实 declined，正式网络逐字节不变（失败无副作用，设计 §5A-7）。
{
  const n = emptyNetwork();
  addNetworkEdge(n, { x: 0, z: 0 }, { x: 90, z: 0 }, false, true);
  addNetworkEdge(n, { x: 90, z: 0 }, { x: 160, z: 0 }, false);
  const frozen = snap(n);
  const r = buildLandingCircles(world(n));
  assert.ok(r.built === 0 && r.declined.length === 1, `honest decline at the roadless head expected: ${JSON.stringify(r)}`);
  assert.ok(r.declined.every((d) => d.reason === "no-ground-reach"), `no-ground-reach expected: ${JSON.stringify(r.declined)}`);
  assert.equal(snap(n), frozen, "declined landing mutated the network");
}

// (e) 确定性：同输入两遍，报告与网络逐字节一致。
{
  const build = () => {
    const n = emptyNetwork();
    addNetworkEdge(n, { x: 0, z: 0 }, { x: 90, z: 0 }, false, true);
    addNetworkEdge(n, { x: 0, z: 0 }, { x: 56.57, z: 56.57 }, false);
    addNetworkEdge(n, { x: 90, z: 0 }, { x: 160, z: 0 }, false);
    addNetworkEdge(n, { x: -60, z: 22 }, { x: 60, z: 22 }, true);
    return n;
  };
  const n1 = build(); const n2 = build();
  const r1 = buildLandingCircles(world(n1)); const r2 = buildLandingCircles(world(n2));
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), "landing report must be deterministic");
  assert.equal(snap(n1), snap(n2), "landing network must be deterministic");
}
console.log("City landing: 45deg mismatch rings ground both bridge ends, capture spokes split hosts with inherited attributes, near-miss re-anchors merge the grazing endpoint, no-ground-reach declines with zero side effects, deterministic.");
