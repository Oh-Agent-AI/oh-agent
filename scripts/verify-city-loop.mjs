#!/usr/bin/env node
// 尽端环路（lollipop service loop）守卫（planner/loop.ts，CITY_NETWORK_FIRST_CODE_DESIGN §4.1 形态档 / §8 合成场景）：
//   (a) 孤立服务环 → 单入口环路接主网：恰好一根入口路、落点 split 成 T 口（属性继承）、环保持闭环；
//   (b) 入口角 ≥60°：环侧（棒与环两条边的夹角）与主网侧（棒与被拆边两半的夹角）同档复核；
//   (c) 失败进诊断不静默：环被水围死 → 全候选 water-span，log 记原因、正式网络零副作用；
//   (d) 判据门：<6 边的环、远离用地的主干级环 → 不属于本遍，不加边、不记日志；
//   (e) 全窄分支：无环的全窄服务路贴近用地 → 同样单入口接入；
//   (f) 确定性：同输入两次生成完全相同的网络。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { connectServiceLoops, LOOP_CONFIG, emptyNetwork, addNetworkEdge } = await loadCity({
  "engine/planner/loop.ts": ["connectServiceLoops", "LOOP_CONFIG"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
});

/** 合成地理：半径 1000 的平岛（高 1.2），可选圆形湖。与 verify-city-connect.mjs 同口径。 */
function makeWorld({ lake = null, sites = [] } = {}) {
  const inLake = (x, z) => !!lake && Math.hypot(x - lake.x, z - lake.z) < lake.r;
  const height = (x, z) => (Math.hypot(x, z) < 1000 && !inLake(x, z)) ? 1.2 : -1;
  const buildable = (x, z) => Math.hypot(x, z) < 988 && !inLake(x, z) && (!lake || Math.hypot(x - lake.x, z - lake.z) > lake.r + 12);
  const geo = {
    R: 1200, coast: [], bbox: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
    hasRiver: false, river: null, riverShift: -400, riverX: () => -400, riverWidth: () => 18,
    coastDistance: (x, z) => 1000 - Math.hypot(x, z),
    landClearance: (x, z) => 1000 - Math.hypot(x, z),
    hillAngle: 0, hillDir: { x: 0, z: 1 }, hillLine: 5000, hillProj: () => -1,
    height, buildable,
    terrain: { height, slope: () => 0.2, buildable, center: { x: 0, z: 0 }, radius: 1200, coastRadius: () => 1200, hasRiver: false },
  };
  return { network: emptyNetwork(), geo, inRiver: () => false, reservations: () => sites };
}
const snap = (n) => JSON.stringify({ v: n.version ?? 0, nodes: [...n.nodes], edges: [...n.edges] });
const edgeId = (a, b) => [a, b].sort().join("/");
const connected = (network, from, to) => {
  const adj = new Map([...network.nodes.keys()].map((id) => [id, []]));
  for (const e of network.edges.values()) { adj.get(e.from)?.push(e.to); adj.get(e.to)?.push(e.from); }
  const seen = new Set([from]); const queue = [from];
  for (let i = 0; i < queue.length; i += 1) for (const next of adj.get(queue[i]) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen.has(to);
};
/** 顶点处两条边的夹角（度）：a/b 为从顶点出发的方向点。 */
const angleDeg = (at, a, b) => {
  const u = { x: a.x - at.x, z: a.z - at.z }; const v = { x: b.x - at.x, z: b.z - at.z };
  const cos = (u.x * v.x + u.z * v.z) / ((Math.hypot(u.x, u.z) || 1) * (Math.hypot(v.x, v.z) || 1));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

// 合成服务环：八边形（8 边 ≥ minComponentEdges）绕体育场类用地，主网是 z=0 的干道。
const STADIUM = { x: 0, z: 260, radius: 50 };
const octagon = Array.from({ length: 8 }, (_, k) => {
  const t = (k / 8) * Math.PI * 2;
  return { x: Math.round((STADIUM.x + Math.cos(t) * 60) * 100) / 100, z: Math.round((STADIUM.z + Math.sin(t) * 60) * 100) / 100 };
});
const buildLoopWorld = (opts = {}) => {
  const w = makeWorld(opts);
  // 干道在 (-100,0) 设节点：core (0,-40) 的最近节点落在主网上（主网锚点定义，否则锚点会选到
  // 环上）；环底 (0,200) 的投影落在 (-100,0)-(300,0) 中段 → 拆边成 T 口（合成场景要验的主路径）。
  addNetworkEdge(w.network, { x: -300, z: 0 }, { x: -100, z: 0 }, true);
  addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 300, z: 0 }, true);
  for (let k = 0; k < 8; k += 1) addNetworkEdge(w.network, octagon[k], octagon[(k + 1) % 8], false);
  return w;
};
const ringIds = octagon.map((p) => `${p.x}:${p.z}`);
const ringEdgeIds = new Set(Array.from({ length: 8 }, (_, k) => edgeId(ringIds[k], ringIds[(k + 1) % 8])));

// J：核心附近的孤立环不能抢走已声明主网；生产锚点优先于最近节点。
{
  const w = buildLoopWorld({ sites: [STADIUM] });
  assert.equal(connectServiceLoops({ world: w, core: STADIUM, primaryAnchorNodeId: "-300:0" }), 1);
  assert.ok(connected(w.network, ringIds[0], "-300:0"));
  const missing = buildLoopWorld({ sites: [STADIUM] });
  const before = JSON.stringify([...missing.network.edges]);
  assert.equal(connectServiceLoops({ world: missing, core: STADIUM, primaryAnchorNodeId: "missing" }), 0);
  assert.equal(JSON.stringify([...missing.network.edges]), before);
}

// (a)+(b) 孤立服务环 → 单入口环路：一根入口路、T 口拆边、环闭环、两侧入口角 ≥60°。
{
  const w = buildLoopWorld({ sites: [STADIUM] });
  assert.ok(!connected(w.network, ringIds[0], "-300:0"), "precondition: the service loop must start isolated");
  const log = [];
  const n = connectServiceLoops({ world: w, core: { x: 0, z: -40 }, log });
  assert.equal(n, 1, `exactly one lollipop entry expected, got ${n}`);
  assert.ok(connected(w.network, ringIds[0], "-300:0"), "the loop must join the primary network");
  // 环保持闭环：8 条环边原样俱在，环上每点仍连着两个环邻居（入口点则为环邻居 + 入口棒）。
  for (const id of ringEdgeIds) assert.ok(w.network.edges.has(id), `ring edge ${id} must survive`);
  for (let k = 0; k < 8; k += 1) {
    const left = ringIds[(k + 7) % 8]; const right = ringIds[(k + 1) % 8];
    const sticks = [...w.network.edges.values()].filter((e) => !ringEdgeIds.has(e.id) && (e.from === ringIds[k] || e.to === ringIds[k]));
    assert.ok(sticks.length <= 1, `ring node ${ringIds[k]} must carry at most the single entry stick`);
    const ringAt = (id) => w.network.nodes.get(id);
    assert.ok(ringAt(left) && ringAt(right), `ring neighbours of ${ringIds[k]} must still exist`);
  }
  // 恰好一根入口棒：环 ↔ 非环 的唯一新边；主网被 split 成 T 口（原边不在，两半在场、属性继承）。
  const entry = [...w.network.edges.values()].filter((e) => !ringEdgeIds.has(e.id)
    && ((ringIds.includes(e.from) && !ringIds.includes(e.to)) || (ringIds.includes(e.to) && !ringIds.includes(e.from))));
  assert.equal(entry.length, 1, `a single entry stick expected, got ${entry.length}`);
  assert.ok(!w.network.edges.has(edgeId("-100:0", "300:0")), "the host primary edge must be split into a T junction");
  assert.ok(w.network.edges.has(edgeId("-100:0", "0:0")) && w.network.edges.has(edgeId("0:0", "300:0")), "both T halves must exist");
  const at = entry[0].from && ringIds.includes(entry[0].from) ? entry[0].from : entry[0].to;
  const landing = entry[0].from === at ? entry[0].to : entry[0].from;
  const halves = [...w.network.edges.values()].filter((e) => (e.from === landing || e.to === landing) && e.id !== entry[0].id);
  assert.equal(halves.length, 2, `the T landing must keep two host halves, got ${halves.length}`);
  for (const half of halves) { assert.equal(half.kind, "arterial"); assert.equal(half.width, 8); }
  // 入口角 ≥60°：环侧（棒与两条环边）与主网侧（棒与两半宿主边）。
  const node = (id) => w.network.nodes.get(id);
  const stickFar = node(landing);
  const idx = ringIds.indexOf(at);
  for (const nb of [ringIds[(idx + 7) % 8], ringIds[(idx + 1) % 8]]) {
    const a = angleDeg(node(at), stickFar, node(nb));
    assert.ok(a >= LOOP_CONFIG.entryAngleDeg - 1e-6, `ring-side entry angle ${a.toFixed(1)}deg < ${LOOP_CONFIG.entryAngleDeg}deg`);
  }
  for (const half of halves) {
    const otherId = half.from === landing ? half.to : half.from;
    const a = angleDeg(node(landing), node(at), node(otherId));
    assert.ok(a >= LOOP_CONFIG.entryAngleDeg - 1e-6, `host-side entry angle ${a.toFixed(1)}deg < ${LOOP_CONFIG.entryAngleDeg}deg`);
  }
  assert.ok(log.some((x) => x.ok && x.id.startsWith("loop:")), "the success must be logged");
}

// (c) 失败进诊断、零副作用：湖把环与主网隔开 → 全候选 water-span，网络原样。
{
  const w = buildLoopWorld({ lake: { x: 0, z: 130, r: 80 }, sites: [STADIUM] });
  const frozen = snap(w.network);
  const log = [];
  const n = connectServiceLoops({ world: w, core: { x: 0, z: -40 }, log });
  assert.equal(n, 0, "a lake-walled loop must not connect");
  assert.equal(snap(w.network), frozen, "failed lollipop attempts mutated the network");
  const entries = log.filter((x) => x.id.startsWith("loop:"));
  assert.ok(entries.length > 0, "failures must be logged, not silent");
  // 湖墙附近的诚实拒绝：最近候选 water-span；擦到湖岸不可建带 → slope；远侧候选超长 → no-target。
  assert.ok(entries.every((x) => !x.ok && x.reason && x.detail), `every failure must carry a reason: ${JSON.stringify(entries[0])}`);
  assert.equal(entries[0].reason, "water-span", `the nearest candidate must fail water-span: ${JSON.stringify(entries[0])}`);
}

// (d) 判据门：<6 边的小环、远离用地的主干级环 → 不属于本遍（不加边、不记日志）。
{
  const w = makeWorld({ sites: [STADIUM] });
  addNetworkEdge(w.network, { x: -300, z: 0 }, { x: 0, z: 0 }, true);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 300, z: 0 }, true);
  const square = [{ x: 500, z: 400 }, { x: 560, z: 400 }, { x: 560, z: 460 }, { x: 500, z: 460 }]; // 4 边 < 6
  for (let k = 0; k < 4; k += 1) addNetworkEdge(w.network, square[k], square[(k + 1) % 4], false);
  const hex = Array.from({ length: 6 }, (_, k) => ({ x: 700 + Math.round(Math.cos((k / 6) * Math.PI * 2) * 60), z: 700 + Math.round(Math.sin((k / 6) * Math.PI * 2) * 60) }));
  for (let k = 0; k < 6; k += 1) addNetworkEdge(w.network, hex[k], hex[(k + 1) % 6], true); // 主干级、远离用地
  const frozen = snap(w.network);
  const log = [];
  const n = connectServiceLoops({ world: w, core: { x: 0, z: -40 }, log });
  assert.equal(n, 0, "non-qualifying components must stay untouched");
  assert.equal(snap(w.network), frozen, "a skipped component must not mutate the network");
  assert.equal(log.filter((x) => x.id.startsWith("loop:")).length, 0, "skipped components must not be logged as attempts");
}

// (e) 全窄分支：7 边全窄服务路（无环）贴近用地 → 单入口接入（落点可吸附干道端点，不强制拆边）。
{
  const site = { x: -500, z: 500, radius: 45 };
  const w = makeWorld({ sites: [site] });
  addNetworkEdge(w.network, { x: -300, z: 0 }, { x: 0, z: 0 }, true);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 300, z: 0 }, true);
  for (let k = 0; k < 7; k += 1) addNetworkEdge(w.network, { x: -500, z: 60 + k * 60 }, { x: -500, z: 120 + k * 60 }, false);
  const top = "-500:480";
  const log = [];
  const n = connectServiceLoops({ world: w, core: { x: 0, z: -40 }, log });
  assert.equal(n, 1, `the all-narrow service cluster must connect, got ${n}`);
  assert.ok(connected(w.network, top, "300:0"), "the narrow cluster must join the primary network");
  const stick = [...w.network.edges.values()].filter((e) => e.from === "-500:60" || e.to === "-500:60");
  assert.ok(stick.some((e) => e.width === 5), "the entry stick must be a local service road");
  assert.ok(log.some((x) => x.ok && x.id.startsWith("loop:")), "the success must be logged");
}

// (f) 确定性：同输入两次 → 完全相同的网络与日志。
{
  const run = () => {
    const w = buildLoopWorld({ sites: [STADIUM] });
    const log = [];
    connectServiceLoops({ world: w, core: { x: 0, z: -40 }, log });
    return { net: snap(w.network), log: JSON.stringify(log) };
  };
  const a = run(); const b = run();
  assert.equal(a.net, b.net, "same input must yield the identical network");
  assert.equal(a.log, b.log, "same input must yield the identical diagnostics");
}

console.log("City loop: isolated service loops join the primary network with a single attribute-preserving T entry, the ring stays closed, both entry angles >= 60deg, lake-walled loops fail into diagnostics with zero side effects, non-qualifying components untouched, all-narrow clusters connect, deterministic.");
