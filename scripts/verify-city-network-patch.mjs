#!/usr/bin/env node
// 事务式 NetworkPatch 守卫（CITY_NETWORK_FIRST_CODE_DESIGN 迁移批次 3，设计 §4.3/§8 合成场景）：
//   (a) 拆边保属性：等级/宽度/桥标记继承，两段端点接续；
//   (b) 版本乐观锁：stale-base 拒绝且零副作用；
//   (c) 校验失败：正式网络逐字节不变（失败无副作用）；
//   (d) 成功提交：一次替换、版本 +1；
//   (e) 确定性：同补丁同网络重复结果一致。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { emptyNetwork, addNetworkEdge, commitNetworkPatch, previewNetworkPatch, remapRoadPath, applyNetworkReferences, NETWORK_RELINE_CONFIG } = await loadCity({
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge", "commitNetworkPatch", "previewNetworkPatch", "NETWORK_RELINE_CONFIG"],
  "engine/planner/references.ts": ["remapRoadPath", "applyNetworkReferences"],
});
const snap = (n) => JSON.stringify({ v: n.version ?? 0, nodes: [...n.nodes], edges: [...n.edges] });
// A corridor can retain its graph endpoints/id while replacing its actual
// interior shape. Ordered full-span references must change in both directions.
for (const width of [9, 12]) for (let quarter = 0; quarter < 4; quarter++) {
  const rotate = point => {
    for (let turn = 0; turn < quarter; turn++) point = { x: -point.z, z: point.x };
    return point;
  };
  const a = rotate({ x: 0, z: 0 }), oldBend = rotate({ x: 20, z: 3 }), b = rotate({ x: 40, z: 0 });
  const shape = [a, rotate({ x: 10, z: 8 }), rotate({ x: 30, z: 8 }), b];
  const network = emptyNetwork(); addNetworkEdge(network, a, b, true, false, true); network.patchRemaps = [];
  const original = [...network.edges.values()][0]; original.width = width; original.purpose = "waterfront"; original.points = [a, oldBend, b];
  const before = snap(network), patch = { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [], relineEdges: [{ edgeId: original.id, points: shape }] };
  const preview = previewNetworkPatch(network, patch); assert.ok(preview.ok); assert.equal(snap(network), before);
  assert.equal(commitNetworkPatch(network, patch, () => "corridor unsafe").ok, false); assert.equal(snap(network), before); assert.equal(network.patchRemaps.length, 0);
  const result = commitNetworkPatch(network, patch); assert.ok(result.ok); assert.equal(result.version, 1);
  const current = network.edges.get(original.id);
  assert.equal(network.edges.size, 1); assert.equal(network.nodes.size, 2);
  for (const key of ["id", "from", "to", "width", "kind", "structure", "purpose", "bridge"]) assert.equal(current[key], original[key]);
  assert.deepEqual(current.points, shape); assert.deepEqual(result.remap.edges, {});
  assert.equal(result.remap.paths.length, 1); assert.equal(network.patchRemaps.length, 1);
  assert.deepEqual(remapRoadPath([a, oldBend, b], result.remap, network), shape);
  assert.deepEqual(remapRoadPath([b, oldBend, a], result.remap, network), [...shape].reverse());
  assert.equal(remapRoadPath([oldBend, b], result.remap, network), null, "undeclared partial curved reference must not guess a new point");
  const prior = rotate({ x: -10, z: 0 }), next = rotate({ x: 50, z: 0 });
  assert.deepEqual(remapRoadPath([prior, a, oldBend, b, next], result.remap, network), [prior, ...shape, next]);
  const ctx = { network, publicSites: [], landmarks: [], primaryAnchorNodeId: original.from,
    carPaths: [[a, oldBend, b]], coastRoadRuns: [[b, oldBend, a]], riverRoadRuns: [], coastRoadRunEnds: [b],
    blocks: [{ id: "face", polygon: [a, oldBend, b, next, prior] }], bridges: [] };
  assert.equal(applyNetworkReferences(ctx, [result.remap]), null);
  assert.deepEqual(ctx.carPaths, [shape]); assert.deepEqual(ctx.coastRoadRuns, [[...shape].reverse()]);
  assert.deepEqual(ctx.blocks[0].polygon, [...shape, next, prior]);
  const committed = snap(network); assert.equal(commitNetworkPatch(network, patch).reason, "stale-base"); assert.equal(snap(network), committed);
  const conflicting = { ...result.remap, paths: [...result.remap.paths, { before: [a, oldBend, b], after: [a, oldBend, b] }] };
  assert.equal(remapRoadPath([a, oldBend, b], conflicting, network), null, "ambiguous ordered lineage fails closed");
  assert.equal(remapRoadPath([a, oldBend, b], { ...conflicting, paths: [...conflicting.paths].reverse() }, network), null);
}
for (const bad of ["bridge", "approach", "endpoint", "reverse", "nan", "zero", "crossing", "backtrack", "duplicate", "split", "width", "point-budget", "edge-budget"]) {
  const network = emptyNetwork(), a = { x: 0, z: 0 }, b = { x: 40, z: 0 };
  addNetworkEdge(network, a, b, true, false, true); network.patchRemaps = [];
  const edge = [...network.edges.values()][0];
  if (bad === "bridge") { edge.bridge = true; edge.structure = "deck"; }
  if (bad === "approach") edge.structure = "ground-approach";
  if (bad === "width") edge.width = 0;
  const shapes = { endpoint: [a, { x: 20, z: 8 }, { x: 41, z: 0 }], reverse: [b, { x: 20, z: 8 }, a],
    nan: [a, { x: NaN, z: 8 }, b], zero: [a, { x: 10, z: 8 }, { x: 10.001, z: 8 }, b],
    crossing: [a, { x: 30, z: 10 }, { x: 10, z: 10 }, b], backtrack: [a, { x: 20, z: 0 }, { x: 10, z: 0 }, b] };
  const replacement = { edgeId: edge.id, points: bad === "point-budget" ? Array.from({ length: NETWORK_RELINE_CONFIG.maxPointsPerEdge + 1 }, (_, index) => ({ x: index * 40 / NETWORK_RELINE_CONFIG.maxPointsPerEdge, z: 0 }))
    : shapes[bad] ?? [a, { x: 20, z: 8 }, b] };
  const patch = { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: bad === "split" ? [{ edgeId: edge.id, at: { x: 20, z: 0 } }] : [],
    relineEdges: bad === "edge-budget" ? Array(NETWORK_RELINE_CONFIG.maxEdgesPerPatch + 1).fill(replacement)
      : bad === "duplicate" ? [replacement, replacement] : [replacement] };
  const before = snap(network); assert.equal(commitNetworkPatch(network, patch).ok, false, bad);
  assert.equal(snap(network), before, bad); assert.equal(network.patchRemaps.length, 0, bad);
}
// Explicit straight-ground coalescence carries both ordered lineages into the
// widest compatible corridor. Default, curved, approach and deck collisions
// remain failures, and rejection must not mutate either original geometry.
for (const incompatible of ["default", "curve", "approach", "deck", "purpose", null]) {
  const network = emptyNetwork(), a = { x: 0, z: 0 }, source = { x: 12, z: 4 }, b = { x: 40, z: 0 }, at = { x: 12, z: 0 };
  addNetworkEdge(network, a, source, true, false, true);
  addNetworkEdge(network, a, b, false);
  const incoming = [...network.edges.values()].find((edge) => edge.width === 12);
  const host = [...network.edges.values()].find((edge) => edge.width === 5); host.width = 9;
  if (incompatible === "curve") incoming.points = [a, { x: 5, z: 8 }, source];
  if (incompatible === "approach") incoming.structure = "ground-approach";
  if (incompatible === "deck") { incoming.bridge = true; incoming.structure = "deck"; }
  if (incompatible === "purpose") incoming.purpose = "waterfront";
  const patch = { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: host.id, at }],
    rebindNodes: [{ from: "12:4", to: "12:0", coalesceStraightGround: incompatible !== "default" }] };
  const before = snap(network), result = commitNetworkPatch(network, patch);
  if (incompatible) { assert.equal(result.ok, false); assert.equal(snap(network), before); }
  else {
    assert.ok(result.ok);
    assert.equal(network.edges.get("0:0/12:0").width, 12);
    assert.equal(network.edges.get("0:0/12:0").kind, "arterial");
    assert.equal(network.edges.get("12:0/40:0").width, 9);
    assert.deepEqual(result.remap.edges[incoming.id], ["0:0/12:0"]);
    assert.deepEqual(result.remap.edges[host.id], ["0:0/12:0", "12:0/40:0"]);
    assert.deepEqual(remapRoadPath([source, a], result.remap, network), [at, a]);
    assert.deepEqual(remapRoadPath([b, a], result.remap, network), [b, at, a]);
  }
}
// Joint reline + split keeps endpoint identity, arbitrary width, and ordered
// path lineage. Unsafe input/validator rejection must publish nothing.
{
  const network = emptyNetwork(), a = { x: 0, z: 0 }, b = { x: 40, z: 0 }, at = { x: 20, z: 4 };
  addNetworkEdge(network, a, b, true);
  const host = [...network.edges.values()][0]; host.width = 9;
  const patch = { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [], relineSplits: [{ edgeId: host.id, at }] };
  const before = snap(network);
  assert.equal(commitNetworkPatch(network, patch, () => "unsafe").ok, false);
  assert.equal(snap(network), before);
  for (const point of [a, { x: NaN, z: 0 }]) {
    assert.equal(commitNetworkPatch(network, { ...patch, relineSplits: [{ edgeId: host.id, at: point }] }).ok, false);
    assert.equal(snap(network), before);
  }
  const preview = previewNetworkPatch(network, patch); assert.ok(preview.ok);
  assert.equal(snap(network), before);
  const result = commitNetworkPatch(network, patch); assert.ok(result.ok);
  assert.deepEqual([...preview.network.edges], [...network.edges]);
  assert.ok([...network.edges.values()].every((edge) => edge.width === 9 && edge.structure === host.structure));
  assert.deepEqual(remapRoadPath([a, b], result.remap, network), [a, at, b]);
  assert.deepEqual(remapRoadPath([b, a], result.remap, network), [b, at, a]);
  assert.ok(network.nodes.has("0:0") && network.nodes.has("40:0"));
}
// Curved splits carry ordered lineage and preserve forward/reverse routes.
{
  const network = emptyNetwork();
  const a = { x: 0, z: 0 }, bend = { x: 20, z: 20 }, b = { x: 40, z: 0 }, at = { x: 10, z: 10 };
  addNetworkEdge(network, a, b, false);
  const host = [...network.edges.values()][0]; host.points = [a, bend, b];
  const patch = { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: host.id, at }] };
  const before = snap(network), preview = previewNetworkPatch(network, patch);
  assert.ok(preview.ok); assert.equal(snap(network), before);
  const result = commitNetworkPatch(network, patch);
  assert.ok(result.ok); assert.equal(result.remap.edges[host.id].length, 2);
  assert.deepEqual(remapRoadPath([a, b], result.remap, network), [a, at, bend, b]);
  assert.deepEqual(remapRoadPath([b, bend, a], result.remap, network), [b, bend, at, a]);
  const ctx = { network, publicSites: [], landmarks: [], blocks: [], bridges: [], coastRoadRunEnds: [a, b], coastRoadRuns: [[a, b]], riverRoadRuns: [], carPaths: [[b, a]] };
  assert.equal(applyNetworkReferences(ctx, [result.remap]), null);
  assert.deepEqual(ctx.coastRoadRuns[0], [a, at, bend, b]);
  assert.deepEqual(ctx.carPaths[0], [b, bend, at, a]);
  assert.deepEqual(ctx.coastRoadRunEnds, [a, b]);
  const removed = commitNetworkPatch(network, { baseVersion: 1, addEdges: [], splits: [], removeEdgeIds: [result.remap.edges[host.id][0]] });
  assert.ok(removed.ok);
  assert.match(applyNetworkReferences(ctx, [removed.remap]), /removed without a replacement/);
}
const net = emptyNetwork();
addNetworkEdge(net, { x: 0, z: 0 }, { x: 100, z: 0 }, true, true, true);
addNetworkEdge(net, { x: 100, z: 0 }, { x: 200, z: 0 }, false);

// (a) 拆边保属性
let r = commitNetworkPatch(net, { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: "0:0/100:0", at: { x: 50, z: 0 } }] });
assert.ok(r.ok, `split failed: ${JSON.stringify(r)}`);
const half1 = [...net.edges.values()].find((e) => Math.abs(e.points[1].x - 50) < 0.01 && Math.abs(e.points[0].x) < 0.01);
assert.ok(half1, "split half missing");
assert.equal(half1.kind, "arterial", "split lost the arterial kind");
assert.equal(half1.width, 12, "split lost the primary width");
assert.equal(half1.bridge, true, "split lost the bridge flag");
assert.equal(half1.structure, "deck", "split preserves explicit deck structure");
assert.ok(!net.edges.has("0:0/100:0"), "original edge must be gone after split");
const halves = [...net.edges.values()].filter((e) => Math.abs(e.points[1].z) < 0.01 && (Math.abs(e.points[1].x - 50) < 0.01 || Math.abs(e.points[1].x - 100) < 0.01));
assert.equal(halves.length, 2, `split must yield exactly two halves, got ${halves.length}`);
r = commitNetworkPatch(net, { baseVersion: 1, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: halves[0].id, at: { x: halves[0].points[0].x, z: 0 } }] });
assert.ok(!r.ok && r.reason === "self-loop", "split at an endpoint must be rejected as self-loop");
assert.equal(net.version, 1, "version must bump once per commit");

// (b) stale base 拒绝 + 零副作用
const frozen = snap(net);
r = commitNetworkPatch(net, { baseVersion: 0, addEdges: [{ a: { x: 0, z: 0 }, b: { x: 0, z: 90 }, arterial: false }], removeEdgeIds: [], splits: [] });
assert.ok(!r.ok && r.reason === "stale-base", "stale base must be rejected");
assert.equal(snap(net), frozen, "stale-base commit mutated the network");

// (c) 校验失败零副作用
r = commitNetworkPatch(net, { baseVersion: 1, addEdges: [{ a: { x: 0, z: 0 }, b: { x: 0, z: 90 }, arterial: false }], removeEdgeIds: [], splits: [] }, () => "road would cross a site");
assert.ok(!r.ok && r.reason === "validation", "validator veto must fail the commit");
assert.equal(snap(net), frozen, "failed commit mutated the network");

// (d) 未知边拒绝零副作用
r = commitNetworkPatch(net, { baseVersion: 1, addEdges: [], removeEdgeIds: ["no/such"], splits: [] });
assert.ok(!r.ok && r.reason === "unknown-edge", "unknown edge must be rejected");
assert.equal(snap(net), frozen, "unknown-edge commit mutated the network");

// (e) 成功 + 确定性
const ok1 = commitNetworkPatch(net, { baseVersion: 1, addEdges: [{ a: { x: 0, z: 0 }, b: { x: 0, z: 90 }, arterial: false }], removeEdgeIds: [], splits: [] });
assert.ok(ok1.ok && ok1.version === 2, "valid commit must succeed and bump version");
const net2 = emptyNetwork();
addNetworkEdge(net2, { x: 0, z: 0 }, { x: 100, z: 0 }, true, true, true);
addNetworkEdge(net2, { x: 100, z: 0 }, { x: 200, z: 0 }, false);
commitNetworkPatch(net2, { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: "0:0/100:0", at: { x: 50, z: 0 } }] });
commitNetworkPatch(net2, { baseVersion: 1, addEdges: [{ a: { x: 0, z: 0 }, b: { x: 0, z: 90 }, arterial: false }], removeEdgeIds: [], splits: [] });
assert.equal(snap(net2), snap(net), "same patches must yield identical networks");
// 评审 P1-4 反例：离线拆分拒绝；宽度 9 完整继承
const net3 = emptyNetwork();
addNetworkEdge(net3, { x: 0, z: 0 }, { x: 100, z: 0 }, true);
const w9 = [...net3.edges.values()][0]; w9.width = 9;
r = commitNetworkPatch(net3, { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: w9.id, at: { x: 50, z: 3 } }] });
assert.ok(!r.ok && r.reason === "off-line-split", `off-line split must be rejected, got ${JSON.stringify(r)}`);
r = commitNetworkPatch(net3, { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: w9.id, at: { x: 50, z: 0 } }] });
assert.ok(r.ok, "on-line split must pass");
assert.ok([...net3.edges.values()].every((e) => e.width === 9), "width 9 must be inherited by both halves");


// (f) removeNodeIds（桥头落地环批次）：孤立残点随补丁清除；仍被引用的节点拒绝且零副作用。
{
  const net3 = emptyNetwork();
  addNetworkEdge(net3, { x: 0, z: 0 }, { x: 100, z: 0 }, false);
  addNetworkEdge(net3, { x: 100, z: 0 }, { x: 200, z: 0 }, false);
  const r3 = commitNetworkPatch(net3, { baseVersion: 0, removeEdgeIds: ["100:0/200:0"], removeNodeIds: ["200:0"], addEdges: [], splits: [] });
  assert.ok(r3.ok, `orphan node removal expected: ${JSON.stringify(r3)}`);
  assert.ok(!net3.nodes.has("200:0"), "orphan endpoint must be gone with its edge");
  assert.ok(net3.nodes.has("100:0") && net3.nodes.has("0:0"), "still-referenced nodes must stay");
  const frozen3 = snap(net3);
  const r4 = commitNetworkPatch(net3, { baseVersion: 1, removeEdgeIds: [], removeNodeIds: ["100:0"], addEdges: [], splits: [] });
  assert.ok(!r4.ok && r4.reason === "node-in-use", `node with edges must be refused: ${JSON.stringify(r4)}`);
  assert.equal(snap(net3), frozen3, "node-in-use commit mutated the network");
}
// 实际折线拆分：不接受首尾弦线上的伪拆点，不丢中间弯点。
{
  const bent = emptyNetwork();
  addNetworkEdge(bent, { x: 0, z: 0 }, { x: 100, z: 100 }, true);
  const host = [...bent.edges.values()][0];
  host.points = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }]; host.width = 9;
  const frozen = snap(bent);
  const patch = (at) => ({ baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: host.id, at }] });
  assert.equal(commitNetworkPatch(bent, patch({ x: 50, z: 50 })).reason, "off-line-split");
  assert.equal(snap(bent), frozen);
  assert.ok(commitNetworkPatch(bent, patch({ x: 100, z: 50 })).ok);
  assert.deepEqual(bent.edges.get("0:0/100:50").points, [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 50 }]);
  assert.deepEqual(bent.edges.get("100:100/100:50").points, [{ x: 100, z: 50 }, { x: 100, z: 100 }]);
  assert.ok([...bent.edges.values()].every((edge) => edge.width === 9));
}
// 拆分不得覆盖同端点 id 的既有边（宽度/形状可能不同）。
{
  const collision = emptyNetwork();
  addNetworkEdge(collision, { x: 0, z: 0 }, { x: 100, z: 0 }, true);
  addNetworkEdge(collision, { x: 0, z: 0 }, { x: 50, z: 0 }, false);
  const before = snap(collision);
  const result = commitNetworkPatch(collision, { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: "0:0/100:0", at: { x: 50, z: 0 } }] });
  assert.ok(!result.ok && result.reason === "validation");
  assert.equal(snap(collision), before);
}
// 节点重绑保属性及折线，冲突/自环拒绝且正式表不改变。
{
  const net = emptyNetwork();
  addNetworkEdge(net, { x: 0, z: 0 }, { x: 100, z: 0 }, true);
  addNetworkEdge(net, { x: 0, z: 0.16 }, { x: 0, z: 100 }, false);
  const curved = [...net.edges.values()].find((edge) => edge.from === "0:0.16"); curved.width = 9;
  curved.points = [{ x: 0, z: 0.16 }, { x: 5, z: 50 }, { x: 0, z: 100 }];
  assert.ok(commitNetworkPatch(net, { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [], rebindNodes: [{ from: "0:0.16", to: "0:0" }] }).ok);
  const bound = net.edges.get("0:0/0:100"); assert.equal(bound.width, 9);
  assert.deepEqual(bound.points, [{ x: 0, z: 0 }, { x: 5, z: 50 }, { x: 0, z: 100 }]);
  assert.ok(!net.nodes.has("0:0.16"));
  const before = snap(net);
  assert.equal(commitNetworkPatch(net, { baseVersion: 1, addEdges: [], removeEdgeIds: [], splits: [], rebindNodes: [{ from: "100:0", to: "0:0" }] }).reason, "self-loop");
  assert.equal(snap(net), before);
}
// 桥先/后创建均声明地面引道；拆分后远离桥端的半段仍保留其宿主结构类别。
{
  const n = emptyNetwork();
  addNetworkEdge(n, { x: 0, z: 0 }, { x: 0, z: 40 }, true);
  addNetworkEdge(n, { x: -100, z: 0 }, { x: 0, z: 0 }, true, true);
  assert.equal(n.edges.get("0:0/0:40").structure, "ground-approach");
  assert.ok(commitNetworkPatch(n, { baseVersion: 0, addEdges: [], removeEdgeIds: [], splits: [{ edgeId: "0:0/0:40", at: { x: 0, z: 20 } }] }).ok);
  assert.equal(n.edges.get("0:20/0:40").structure, "ground-approach");
  addNetworkEdge(n, { x: -100, z: 0 }, { x: -100, z: 40 }, false);
  assert.equal(n.edges.get("-100:0/-100:40").structure, "ground-approach");
  const collision = emptyNetwork();
  addNetworkEdge(collision, { x: 0, z: 0 }, { x: 10, z: 0 }, false);
  addNetworkEdge(collision, { x: 0, z: 0 }, { x: 10, z: 0 }, false, true);
  assert.equal(collision.edges.get("0:0/10:0").structure, "ground-road", "discarded duplicate bridge proposal cannot manufacture approach evidence");
}
// 重定线到新坐标仍是同一个原子操作：保属性，身份不一致及校验拒绝不留新节点。
{
  const n = emptyNetwork();
  addNetworkEdge(n, { x: 0, z: 0 }, { x: 10, z: 0 }, true);
  n.edges.get("0:0/10:0").width = 9;
  n.edges.get("0:0/10:0").points = [{ x: 0, z: 0 }, { x: 5, z: 2 }, { x: 10, z: 0 }];
  const patch = { baseVersion: 0, removeEdgeIds: [], addEdges: [], splits: [], rebindNodes: [{ from: "10:0", to: "10:4", targetAt: { x: 10, z: 4 } }] };
  const before = snap(n);
  assert.ok(!commitNetworkPatch(n, patch, () => "unsafe proposed corridor").ok);
  assert.equal(snap(n), before);
  assert.ok(!commitNetworkPatch(n, { ...patch, rebindNodes: [{ from: "10:0", to: "wrong", targetAt: { x: 10, z: 4 } }] }).ok);
  assert.equal(snap(n), before);
  assert.ok(commitNetworkPatch(n, patch).ok);
  assert.ok(!n.nodes.has("10:0") && n.nodes.has("10:4"));
  assert.equal(n.edges.get("0:0/10:4").width, 9);
  assert.deepEqual(n.edges.get("0:0/10:4").points, [{ x: 0, z: 0 }, { x: 5, z: 2 }, { x: 10, z: 4 }]);
}
console.log("City network patch: split/rebind attribute/shape/structure inheritance, stale-base/validation/unknown-edge rejections with zero side effects, versioned atomic commit, orphan-node removal, deterministic.");
