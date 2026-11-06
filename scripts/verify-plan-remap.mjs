#!/usr/bin/env node
// 跨档重定位守卫（docs/CITY_MAP_EDITOR_ROADMAP_SPEC.md P0-2）：
//   (a) 合成城市 1 档 → 同形 ×1.5 的 2 档：画路/删路/拖路口/高架/设施拆搬/移楼逐条落到放大后的对应对象，新档重放无失效；
//   (b) 旧补丁（无锚点、无岛半径）：删路/拖路口从 id 推坐标，缩放比退回 √(新档/旧档)；移楼没锚点 → 单条失败，不猜；
//   (c) 找不到对应 / 新档重放失效 → 逐条进 failed，补丁里剔掉，其余照常；全部失败 → null；
//   (d) 存档宽容读取：anchor / toAnchor / islandRadius / moveAnchors 读回，坏的丢掉；
//   (e) 真实城市：380 → 420 楼（1 → 2 档）、1600 → 2000（4 → 5 档）各造一份混合补丁，重定位后重放无失效，报告成功率。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const k = await loadCity({
  "engine/planRemap.ts": ["remapPlanPatch", "remapRatio"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "appendRoadOp", "appendSiteOp", "appendHighwayOp", "coercePlanPatch", "validateBuildingMove"],
  "engine/planSites.ts": ["listSites", "siteMoveProblem", "siteTargets", "siteClassOf"],
  "engine/planRoadRules.ts": ["validateRoadAdd", "validateEdgeDrop", "validateNodeMove"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

// ── 合成城市：3×3 路口网格（间距 100·s），两个街区各 3 块地，一座地标；s=1 是 1 档，s=1.5 是 2 档 ──
const terrain = { height: () => 2, slope: () => 0.1, buildable: (x, z) => Math.hypot(x, z) < 900, center: { x: 0, z: 0 }, radius: 900, coastRadius: () => 900, hasRiver: false };
const id = (x, z) => `${x}:${z}`;
function makeLayout(s, tier) {
  const q = (v) => Math.round(v * s * 100) / 100;
  const nodes = []; const edges = [];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) nodes.push({ id: id(q(i * 100), q(j * 100)), x: q(i * 100), z: q(j * 100) });
  const edge = (a, b) => ({ id: [a.id, b.id].sort().join("/"), from: a.id, to: b.id, width: 5, kind: "local", points: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }], structure: "ground-road" });
  const at = (i, j) => nodes[i * 3 + j];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) { if (i < 2) edges.push(edge(at(i, j), at(i + 1, j))); if (j < 2) edges.push(edge(at(i, j), at(i, j + 1))); }
  const parcel = (pid, blockId, x, z) => ({ id: pid, blockId, x: q(x), z: q(z), yaw: 0, zone: "residential", width: 8, depth: 8 });
  const A = [parcel(`A${s}/0`, `A${s}`, 30, 50), parcel(`A${s}/1`, `A${s}`, 50, 50), parcel(`A${s}/2`, `A${s}`, 70, 50)];
  const B = [parcel(`B${s}/0`, `B${s}`, 130, 50), parcel(`B${s}/1`, `B${s}`, 150, 50), parcel(`B${s}/2`, `B${s}`, 170, 50)];
  return {
    seed: 7, scaleTier: tier, islandRadius: q(400), activityKey: "k", terrain,
    blocks: [{ id: `A${s}`, districtId: "d0", x: q(50), z: q(50), width: q(60), depth: 10, zone: "residential", parcels: A, polygon: [] },
      { id: `B${s}`, districtId: "d0", x: q(150), z: q(50), width: q(60), depth: 10, zone: "residential", parcels: B, polygon: [] }],
    roadNodes: nodes, roadEdges: edges, culDeSacEnds: [], civics: [], gardens: [], districtLandmarks: [], contextBuildings: [],
    landmarks: [{ id: "landmark:ferris-wheel", kind: "ferris-wheel", x: q(250), z: q(250), yaw: 0, radius: 15 }], publicSites: [], highways: [],
    districts: [{ id: "d0", label: "D0", center: { x: 0, z: 0 }, radius: 600, terrain, slots: new Map([["b1", A[0]]]), grounds: new Map([["b1", 2]]), roads: [], carPaths: [], river: null, riverHalfWidth: 0, trees: [], plaza: { x: 0, z: 0, y: 2 }, anomaly: null, sessionCount: 1 }],
  };
}
const model = { windowStartMs: 0, windowEndMs: 1, windowLabel: "t", generatedAt: 1,
  districts: [{ id: "d0", label: "D0", sessionCount: 1, tokensTotal: 0, activeCount: 0, anomaly: null }],
  buildings: [{ id: "b1", districtId: "d0", footprint: 5, height: 10, archetype: "block" }] };

// (a) 每类操作都落到放大后的对应对象。
{
  const t1 = makeLayout(1, 1); const t2 = makeLayout(1.5, 2);
  let p = { ...k.emptyPlanPatch(7, 1), islandRadius: 400 };
  p = k.appendRoadOp(p, { t: "add", from: { x: 200, z: 200 }, to: { x: 260, z: 140 }, width: 8 }, 1);
  p = k.appendRoadOp(p, { t: "drop", edge: "0:100/100:100", anchor: { x: 50, z: 100 } }, 2);
  p = k.appendRoadOp(p, { t: "move", node: "0:200", to: { x: -10, z: 210 }, anchor: { x: 0, z: 200 } }, 3);
  p = k.appendHighwayOp(p, { t: "add", points: [{ x: -50, z: 300 }, { x: 250, z: 320 }] }, 4);
  p = k.appendSiteOp(p, { t: "move", id: "landmark:ferris-wheel", at: { x: 250, z: 250 }, to: "@300,350" }, 5);
  p = { ...p, buildingMoves: { b1: "B1/2" }, moveAnchors: { b1: { x: 170, z: 50 } } };
  assert.equal(k.applyPlanPatch(t1, p).stale.length, 0, "the fixture patch is valid on its own tier");
  assert.equal(k.applyPlanPatch(t2, p).stale.length > 0, true, "…and wholly stale on the next tier (tier-changed)");
  assert.equal(k.remapRatio(p, t2), 1.5);
  const { patch, report } = k.remapPlanPatch(t2, model, p);
  assert.deepEqual(report.failed, [], `every op found its counterpart — ${JSON.stringify(report.failed)}`);
  assert.equal(report.remapped, report.total); assert.equal(report.total, 6); assert.equal(patch.scaleTier, 2); assert.equal(patch.islandRadius, 600);
  const [add, drop, move] = patch.roadOps;
  assert.deepEqual([add.from, add.to], [{ x: 300, z: 300 }, { x: 390, z: 210 }], "coordinates scale by the island ratio");
  assert.equal(drop.edge, "0:150/150:150", "a dropped edge maps to its scaled counterpart");
  assert.equal(move.node, "0:300"); assert.deepEqual(move.to, { x: -15, z: 315 });
  assert.deepEqual(patch.highwayOps[0].points, [{ x: -75, z: 450 }, { x: 375, z: 480 }]);
  assert.equal(patch.siteOps[0].to, "@450,525"); assert.deepEqual(patch.siteOps[0].at, { x: 375, z: 375 }, "the site guard is rewritten to its new position");
  assert.equal(patch.buildingMoves.b1, "B1.5/2", "a building move lands on the nearest free parcel to the scaled target");
  assert.equal(k.applyPlanPatch(t2, patch).stale.length, 0, "the remapped patch replays cleanly on the new tier");
  // 降档同理（ratio < 1）。
  const back = k.remapPlanPatch(t1, model, patch);
  assert.deepEqual(back.report.failed, []); assert.equal(back.patch.roadOps[1].edge, "0:100/100:100", "remapping back down returns to the original objects");
}

// (a2) 改路型（路线图 P1-4）：与删路同法找对应路段，路型原样带过去。
{
  const t1 = makeLayout(1, 1); const t2 = makeLayout(1.5, 2);
  const p = k.appendRoadOp({ ...k.emptyPlanPatch(7, 1), islandRadius: 400 }, { t: "restyle", edge: "0:100/100:100", width: 12, purpose: "waterfront", anchor: { x: 50, z: 100 } }, 1);
  assert.equal(k.applyPlanPatch(t1, p).stale.length, 0);
  const { patch, report } = k.remapPlanPatch(t2, model, p);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(patch.roadOps[0], { t: "restyle", edge: "0:150/150:150", width: 12, purpose: "waterfront", anchor: { x: 75, z: 150 } }, "a restyled edge maps to its scaled counterpart and keeps its target style");
  const replayed = k.applyPlanPatch(t2, patch);
  assert.equal(replayed.stale.length, 0);
  assert.equal(replayed.layout.roadEdges.find((e) => e.id === "0:150/150:150").purpose, "waterfront");
}

// (b) 旧补丁：没有锚点、没有岛半径。
{
  const t2 = makeLayout(Math.SQRT2, 2); // 旧补丁的回退比例 √(2/1)
  let p = k.emptyPlanPatch(7, 1);
  p = k.appendRoadOp(p, { t: "drop", edge: "100:0/100:100" }, 1);
  p = k.appendRoadOp(p, { t: "move", node: "200:0", to: { x: 210, z: -10 } }, 2);
  p = { ...p, buildingMoves: { b1: "B1/2" } };
  assert.ok(Math.abs(k.remapRatio(p, t2) - Math.SQRT2) < 1e-9, "without islandRadius the ratio falls back to √(new/old tier)");
  const { patch, report } = k.remapPlanPatch(t2, model, p);
  assert.equal(patch.roadOps.length, 2, "edge and node ids carry their coordinates — legacy drops/moves still remap");
  assert.deepEqual(report.failed.map((f) => f.kind), ["building-move"], "a legacy building move has no anchor and fails honestly");
}

// (c) 找不到 / 新档失效 → 单条失败；删除目标已不存在则标记为已满足；全部无待重放操作 → null。
{
  const t2 = makeLayout(1.5, 2);
  let p = { ...k.emptyPlanPatch(7, 1), islandRadius: 400 };
  p = k.appendRoadOp(p, { t: "drop", edge: "x", anchor: { x: 600, z: 600 } }, 1); // 那里没有路
  p = k.appendSiteOp(p, { t: "remove", id: "civic:3", at: { x: 500, z: 500 }, cls: "civic/school" }, 2); // 没有同类设施
  p = { ...p, suppressedContext: ["context:A1/0"] };
  const { patch, report } = k.remapPlanPatch(t2, model, p);
  assert.equal(patch, null, "no operation remains to replay");
  assert.deepEqual(report.alreadySatisfied.map((entry) => entry.kind), ["road-drop"], "deleting a corridor that is already absent is a satisfied no-op");
  assert.equal(report.failed.length, 2); assert.equal(report.remapped, 0);
}

// (d) 存档宽容读取。
{
  const raw = { ...k.emptyPlanPatch(7, 1), islandRadius: 412.5, roadOps: [{ t: "drop", edge: "a/b", anchor: { x: 1, z: 2 } }, { t: "move", node: "n", to: { x: 0, z: 0 }, anchor: "bad" }],
    siteOps: [{ t: "move", id: "civic:0", to: "B", toAnchor: { x: 3, z: 4 } }], buildingMoves: { b1: "p" }, moveAnchors: { b1: { x: 5, z: 6 }, ghost: { x: 0, z: 0 } } };
  const read = k.coercePlanPatch(raw);
  assert.equal(read.islandRadius, 412.5); assert.deepEqual(read.roadOps[0].anchor, { x: 1, z: 2 }); assert.equal(read.roadOps[1].anchor, undefined);
  assert.deepEqual(read.siteOps[0].toAnchor, { x: 3, z: 4 }); assert.deepEqual(read.moveAnchors, { b1: { x: 5, z: 6 } }, "anchors for buildings without a move are dropped");
}

// (e) 真实城市跨档。
const H = ["codex", "claude-code", "dsh", "harness:zcode"]; const T = Date.UTC(2026, 9, 7, 12);
const rowsOf = (n) => { let s = 12345; const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({ length: n }, (_, i) => { const total = Math.round(2000 + r() ** 3 * 4e6); const start = T - Math.round(r() * 360 * 864e5);
    return { session_ref: `session:${i}`, harness: H[i % 4], first_event_at: new Date(start).toISOString(), last_event_at: new Date(start + 36e5).toISOString(), event_count: 10, model_ids: ["m"],
      tokens: { uncached_input_tokens: total * 0.2, cache_read_tokens: total * 0.5, cache_write_tokens: total * 0.1, output_tokens: total * 0.2, total }, peak_tokens: 0, cost_minor: null, cost_status: { state: "estimated", reason: "", has_unresolved: false } }; }); };
const cityOf = (n, previous = null) => { const m = k.buildCityModel({ rows: rowsOf(n), findings: [], windowStartMs: T - 366 * 864e5, windowEndMs: T, windowLabel: "366d", totalSessions: n, truncated: false, generatedAt: T }); return { model: m, layout: k.layoutCity(m, previous, undefined, k.MIAMI_COASTAL) }; };

/** 在 layout 上造一份混合补丁：删路、拖路口、画路、搬设施、移楼，每条都先过校验（只要不被阻断的）。 */
function mixedPatch(layout, model) {
  let p = { ...k.emptyPlanPatch(layout.seed, layout.scaleTier), islandRadius: layout.islandRadius };
  let current = layout;
  const commit = (next) => { const result = k.applyPlanPatch(layout, next); if (result.stale.length) return false; p = next; current = result.layout; return true; };
  const ground = current.roadEdges.filter((e) => !e.bridge && e.structure === "ground-road");
  let made = { drop: 0, move: 0, add: 0, site: 0, building: 0 };
  for (let i = 0; i < ground.length && made.drop < 6; i += 37) {
    const e = current.roadEdges.find((x) => x.id === ground[i].id); if (!e) continue;
    if (k.validateEdgeDrop(current, model, e.id).blockers.length) continue;
    const mid = { x: (e.points[0].x + e.points.at(-1).x) / 2, z: (e.points[0].z + e.points.at(-1).z) / 2 };
    if (commit(k.appendRoadOp(p, { t: "drop", edge: e.id, anchor: mid }, 1))) made.drop += 1;
  }
  for (let i = 0; i < current.roadNodes.length && made.move < 6; i += 29) {
    const n = current.roadNodes[i]; const to = { x: n.x + 6, z: n.z + 4 };
    if (k.validateNodeMove(current, model, n.id, to).blockers.length) continue;
    if (commit(k.appendRoadOp(p, { t: "move", node: n.id, to, anchor: { x: n.x, z: n.z } }, 2))) made.move += 1;
  }
  for (let i = 0; i < current.roadNodes.length && made.add < 6; i += 41) {
    const n = current.roadNodes[i]; const to = { x: n.x + 30, z: n.z + 30 };
    const v = k.validateRoadAdd(current, model, n, to, 5); if (v.blockers.length || v.warnings.some((w) => /bulldoze|relocate/.test(w))) continue;
    if (commit(k.appendRoadOp(p, { t: "add", from: { x: n.x, z: n.z }, to, width: 5 }, 3))) made.add += 1;
  }
  for (const site of k.listSites(current)) {
    if (made.site >= 4 || site.locked || site.level === "free") continue;
    const target = k.siteTargets(current, site, p.suppressedContext, 3)[0]; if (!target) continue;
    if (commit(k.appendSiteOp(p, { t: "move", id: site.id, at: { x: site.x, z: site.z }, to: target.id, toAnchor: { x: target.x, z: target.z }, cls: k.siteClassOf(site) }, 4))) made.site += 1;
  }
  const slots = current.districts.flatMap((d) => [...d.slots]);
  for (let i = 0; i < slots.length && made.building < 6; i += 53) {
    const [bid, slot] = slots[i];
    const parcel = current.blocks.flatMap((b) => b.parcels).filter((q) => Math.hypot(q.x - slot.x, q.z - slot.z) < 120).find((q) => k.validateBuildingMove(current, model, p, bid, q.id).blockers.length === 0);
    if (!parcel) continue;
    if (commit({ ...p, buildingMoves: { ...p.buildingMoves, [bid]: parcel.id }, moveAnchors: { ...p.moveAnchors, [bid]: { x: parcel.x, z: parcel.z } } })) made.building += 1;
  }
  return { patch: p, made };
}

const tierTransitions = process.env.CITY_REMAP_LARGE_ONLY === "1" ? [[1600, 2000]] : [[380, 420], [1600, 2000]];
for (const [from, to] of tierTransitions) {
  const before = cityOf(from);
  const { patch, made } = mixedPatch(before.layout, before.model);
  const total = patch.roadOps.length + patch.siteOps.length + Object.keys(patch.buildingMoves).length;
  assert.ok(total >= 15, `the fixture patch has enough ops (${JSON.stringify(made)})`);
  const after = cityOf(to, before.layout);
  assert.equal(after.layout.scaleTier, before.layout.scaleTier + 1, "the data growth crosses one tier");
  const t0 = performance.now();
  const { patch: remapped, report } = k.remapPlanPatch(after.layout, after.model, patch);
  const ms = Math.round(performance.now() - t0);
  assert.ok(remapped, "something survives the tier change");
  assert.equal(k.applyPlanPatch(after.layout, remapped).stale.length, 0, "the remapped patch replays cleanly on the new tier");
  const survived = report.remapped + report.alreadySatisfied.length;
  const rate = survived / report.total;
  const byKind = {}; for (const f of report.failed) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  console.log(`  ${from} → ${to} 楼（${report.fromTier} → ${report.toTier} 档，×${report.ratio.toFixed(3)}）：${report.remapped} 搬迁 + ${report.alreadySatisfied.length} 已满足 / ${report.total}（${Math.round(rate * 100)}%），失败 ${JSON.stringify(byKind)} ${JSON.stringify(report.failed)}，耗时 ${ms}ms`);
  assert.ok(rate >= 0.8, `≥ 80% of edits survive a tier change (spec P0-2 acceptance) (${Math.round(rate * 100)}%)`);
}

console.log("City plan remap: tier changes rescale coordinate edits and re-resolve referenced objects (roads, junctions, sites, building moves) on the new tier; legacy patches fall back to id coordinates and √tier; unmatched or still-stale entries fail one by one and are pruned; anchors round-trip through storage; real-city tier changes replay cleanly.");
