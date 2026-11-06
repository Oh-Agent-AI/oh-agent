#!/usr/bin/env node
// 统一连接器守卫（CITY_NETWORK_FIRST_CODE_DESIGN 迁移批次 4，设计 §4/§8 合成场景）：
//   (a) 直连：最近合法路段投影、T 口拆边保属性（等级/宽度继承）、拆边后路径保持；
//   (b) 并线：node-merge 与已有节点直连（全程校验：不过水、可建、坡度、避让用地、端点净空角）；
//   (c) 绕行：直连被用地挡住时，两侧 ± 三档偏移的折线绕过；
//   (d) A*：三档绕行偏移都不够时，有界网格 A*（位置 + 入射方向状态）绕湖接通；
//   (e) 预算耗尽：search-budget 上限返回 search-budget（≠ 无路可走），失败零副作用；
//   (f) 主网定向：目标必须是 primary 分量——诱饵分量更近也不许接；主网不可达时如实失败；
//   (g) stale-base：过期 baseVersion 拒绝且零副作用；
//   (h) 确定性：同输入两次搜索产生相同补丁与相同网络。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
import "./verify-city-repair-safety.mjs";

const { runConnection, proposeConnection, commitConnection, commitFixedLink, runMiniRoundabout, corridorFailure, validateCandidate, connectGroundJunctions, normalizeGroundJunctions, groundJunctionFindings, classifyRoadSegments, consolidateTerminalCorridors, joinNearMissEnds, pruneShortSpurs, roadPaintPlan, CONNECTOR_CONFIG, VALIDATION_CONFIG, emptyNetwork, addNetworkEdge, acuteJunctions, snapNearJunctions, mergeCoincidentJunctionLegs, snapNearEdgeJunctions, snapShortCrossings, rerouteUnsafeGroundCrossings, civicRoadClear, groundJunctionCorridorFailure, civicGroundFootprint, civicFlagLocalX, pointInRegion } = await loadCity({
  "engine/planner/connect.ts": ["runConnection", "proposeConnection", "commitConnection", "commitFixedLink", "runMiniRoundabout", "corridorFailure", "CONNECTOR_CONFIG", "VALIDATION_CONFIG"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
  "engine/planner/validation.ts": ["validateCandidate"],
  "engine/planner/junctions.ts": ["connectGroundJunctions", "normalizeGroundJunctions"],
  "engine/planner/report.ts": ["groundJunctionFindings"],
  "engine/planner/relations.ts": ["classifyRoadSegments"],
  "engine/planner/consolidateCorridors.ts": ["consolidateTerminalCorridors"],
  "engine/planner/snapJunctions.ts": ["snapNearJunctions", "mergeCoincidentJunctionLegs", "snapNearEdgeJunctions", "snapShortCrossings", "rerouteUnsafeGroundCrossings"],
  "engine/planner/civicClearance.ts": ["civicRoadClear", "groundJunctionCorridorFailure"],
  "engine/models/publicSiteGeometry.ts": ["civicGroundFootprint", "civicFlagLocalX"],
  "engine/models/physical.ts": ["pointInRegion"],
  "engine/cityRoadPaint.ts": ["roadPaintPlan"],
  "engine/planner/networkRepairs.ts": ["joinNearMissEnds", "pruneShortSpurs"],
  "engine/planner/constraints.ts": ["acuteJunctions"],
});

/** 合成地理：半径 1000 的平岛（高 1.2），可选竖直河道（x = riverX，宽 riverWidth）、圆形湖与
 *  陡坡盘（slopeDisc.value 自定坡度，缺省 2——批 A 引道阈值为实测 3，负例须 >3）、不可建盘
 *  （干地但 buildable=false，模拟前滩：引道按道路可行条件放行，建筑判据不适用）。 */
function makeWorld({ riverX = -400, riverWidth = 18, lake = null, slopeDisc = null, sites = [], unbuildable = [] } = {}) {
  const inLake = (x, z) => !!lake && Math.hypot(x - lake.x, z - lake.z) < lake.r;
  const inSlope = (x, z) => !!slopeDisc && Math.hypot(x - slopeDisc.x, z - slopeDisc.z) < slopeDisc.r;
  const inUnbuildable = (x, z) => unbuildable.some((d) => Math.hypot(x - d.x, z - d.z) < d.r);
  const height = (x, z) => (Math.hypot(x, z) < 1000 && !inLake(x, z) && Math.abs(x - riverX) >= riverWidth) ? 1.2 : -1;
  const buildable = (x, z) => Math.hypot(x, z) < 988 && !inLake(x, z) && Math.abs(x - riverX) > riverWidth + 12 && (!lake || Math.hypot(x - lake.x, z - lake.z) > lake.r + 12) && !inUnbuildable(x, z);
  const geo = {
    R: 1200, coast: [], bbox: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 },
    hasRiver: true, river: [], riverShift: riverX, riverX: () => riverX, riverWidth: () => riverWidth,
    coastDistance: (x, z) => 1000 - Math.hypot(x, z),
    landClearance: (x, z) => Math.min(1000 - Math.hypot(x, z), Math.abs(x - riverX) - riverWidth),
    hillAngle: 0, hillDir: { x: 0, z: 1 }, hillLine: 5000, hillProj: () => -1,
    height, buildable,
    terrain: { height, slope: (x, z) => (inSlope(x, z) ? (slopeDisc?.value ?? 2) : 0.2), buildable, center: { x: 0, z: 0 }, radius: 1200, coastRadius: () => 1200, hasRiver: true },
  };
  return { network: emptyNetwork(), geo, inRiver: (x, z) => Math.abs(x - riverX) < riverWidth, reservations: () => sites };
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
const request = (over) => ({ id: "req", source: { x: 0, z: 0 }, target: { kind: "edges", include: () => true }, purpose: "district-access", allowBridge: false, maxLength: 400, roadClass: "local", ...over });

// Bridge/shore approach proposals must use later polyline segments too, without
// spending extra host candidates or replacing the bent host with its chord.
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 200, z: -100 }, { x: 100, z: -100 }, true);
  const host = [...w.network.edges.values()][0];
  host.points = [{ x: 200, z: -100 }, { x: 200, z: 100 }, { x: 100, z: 100 }, { x: 100, z: -100 }];
  const result = runConnection(request({ id: "bent-shore-host", allowBridge: true, maxLength: 150 }), w,
    { strategies: ["bridge-candidate"], bridge: { blockers: [] } });
  assert.ok(result.ok, `later host segment is reachable inside the unchanged length bound: ${JSON.stringify(result)}`);
  assert.equal(result.cost, 100);
  assert.ok(w.network.nodes.has("100:0"));
  assert.ok([...w.network.edges.values()].some((edge) => edge.points.some((point) => point.x === 200 && point.z === 100)),
    "splitting a curved host must retain its actual shape");
}

// (a) 直连：投影 T 口拆边，宿主属性保留，拆边后路径保持（设计 §8「拆边后属性与路径保持」）。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: -60 }, false);
  addNetworkEdge(w.network, { x: -200, z: 120 }, { x: 200, z: 120 }, true);
  const r = runConnection(request({ id: "direct" }), w);
  assert.ok(r.ok && r.strategy === "direct-projection", `direct projection expected: ${JSON.stringify(r)}`);
  assert.equal(r.version, 1, "commit must bump the version exactly once");
  assert.ok(!w.network.edges.has(edgeId("-200:120", "200:120")), "host edge must be split, not kept whole");
  const halves = [...w.network.edges.values()].filter((e) => e.kind === "arterial" && e.width === 8 && (e.from === "0:120" || e.to === "0:120"));
  assert.equal(halves.length, 2, `split must keep two arterial halves, got ${halves.length}`);
  assert.ok(w.network.edges.has(edgeId("0:0", "0:120")), "connecting edge missing");
  assert.ok(connected(w.network, "0:0", "200:120"), "path lost across the T junction");
}

// (b) 并线：node-merge 直连既有节点（不拆边），通过全部硬校验后提交。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: -60, z: 0 }, false);
  addNetworkEdge(w.network, { x: 120, z: 0 }, { x: 260, z: 0 }, true);
  const r = runConnection(request({ id: "merge", target: { kind: "node", id: "120:0" } }), w, { strategies: ["node-merge"] });
  assert.ok(r.ok && r.strategy === "node-merge", `node merge expected: ${JSON.stringify(r)}`);
  assert.ok(w.network.edges.has(edgeId("0:0", "120:0")), "merge edge missing");
  assert.ok(w.network.edges.has(edgeId("120:0", "260:0")), "merge must not split the host edge");
  assert.ok(connected(w.network, "0:0", "260:0"), "merge did not join the components");
}

// (c) 绕行：直连被用地挡住（site-clearance），折线从侧面绕过（两侧 ±，三档偏移的第一档即可）。
{
  const w = makeWorld({ sites: [{ x: 0, z: 75, radius: 20 }] });
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: -60 }, false);
  addNetworkEdge(w.network, { x: -100, z: 150 }, { x: 100, z: 150 }, true);
  const r = runConnection(request({ id: "detour" }), w, { strategies: ["direct-projection", "detour"] });
  assert.ok(r.ok && r.strategy === "detour", `detour expected: ${JSON.stringify(r)}`);
  assert.equal(r.patch.addEdges.length, 3, `detour must add a polyline, got ${r.patch.addEdges.length} edges`);
  assert.ok(r.patch.splits.length === 1, "detour join should split the host into a T junction");
  assert.ok(connected(w.network, "0:0", "100:150"), "detour did not join the components");
  for (const e of r.patch.addEdges) for (const site of w.reservations()) {
    const mid = { x: (e.a.x + e.b.x) / 2, z: (e.a.z + e.b.z) / 2 };
    assert.ok(Math.hypot(mid.x - site.x, mid.z - site.z) > site.radius, "detour segment grazes the blocking site");
  }
}

// A legal grid centre can hide an unsafe lateral road envelope. The first
// goal proposal fails; A* must continue in the same budget, without mutations.
{
  const build = () => {
    const w = makeWorld({ unbuildable: [{ x: 52, z: 2.5, r: 1 }] });
    addNetworkEdge(w.network, { x: -60, z: 0 }, { x: 0, z: 0 }, false);
    addNetworkEdge(w.network, { x: 120, z: 0 }, { x: 120, z: 60 }, true);
    return w;
  };
  const req = request({ id: "astar-goal-retry", target: { kind: "node", id: "120:0" }, maxLength: 240 });
  const short = build(), before = snap(short.network);
  const exhausted = runConnection({ ...req, searchBudget: 10 }, short, { strategies: ["grid-astar"] });
  assert.ok(!exhausted.ok && exhausted.reason === "search-budget", JSON.stringify(exhausted));
  assert.match(exhausted.detail, /rejected [1-9][0-9]* goal candidates/, "budget must include rejected final corridors, not only cell expansion");
  const rejectionEvidence = exhausted.detail.match(/rejected (\d+) goal candidates \[([^\]]*)\]/);
  assert.ok(rejectionEvidence, "budget failure must retain all final-proposal rejection categories");
  const rejectionEntries = rejectionEvidence[2].split(",").map((entry) => entry.split(":"));
  assert.ok(rejectionEntries.every(([reason, count]) => reason && Number.isInteger(Number(count)) && Number(count) > 0));
  assert.equal(rejectionEntries.reduce((sum, [, count]) => sum + Number(count), 0), Number(rejectionEvidence[1]),
    "rejection categories must account for every rejected proposal without dropping earlier causes");
  assert.equal(snap(short.network), before);
  const w = build(), repeated = build();
  const result = runConnection(req, w, { strategies: ["grid-astar"] });
  assert.ok(result.ok, `A* must continue after the unsafe first goal proposal: ${JSON.stringify(result)}`);
  assert.ok(connected(w.network, "-60:0", "120:60"));
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 0);
  assert.ok(result.patch.addEdges.length > 1, "unsafe straight route cannot become the accepted fallback");
  assert.deepEqual(runConnection(req, repeated, { strategies: ["grid-astar"] }), result);
  assert.equal(snap(repeated.network), snap(w.network));
}

// An unbound entrance has no incoming network tangent. The nearest-target
// heading can be blocked while a smooth northward departure remains legal.
for (const turns of [0, 1, 2, 3]) for (const shift of [0, 120]) {
  const transform = (x, z) => {
    for (let i = 0; i < turns; i += 1) [x, z] = [-z, x];
    return { x: x + shift, z: z - shift };
  };
  const w = makeWorld({ unbuildable: [-12, 0, 12].map((z) => ({ ...transform(12, z), r: 5 })) });
  const target = transform(120, 0), source = transform(0, 0), targetId = `${target.x}:${target.z}`;
  addNetworkEdge(w.network, target, transform(120, 60), true);
  const before = snap(w.network);
  const exhausted = runConnection(request({ id: "unbound-entrance-budget", source, target: { kind: "node", id: targetId }, maxLength: 240, searchBudget: 1 }),
    w, { strategies: ["grid-astar"] });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, "search-budget", "alternate headings share the one original expansion budget");
  assert.equal(snap(w.network), before);
  const result = runConnection(request({ id: "unbound-entrance-heading", source, target: { kind: "node", id: targetId }, maxLength: 240 }),
    w, { strategies: ["grid-astar"] });
  assert.ok(result.ok, `unbound entrance must find the legal alternate departure: ${JSON.stringify(result)}`);
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 0);
}

// A caller's final topology guard must reject proposals inside the same A*
// search, not terminate at a physically legal but globally unacceptable route.
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: -60, z: 0 }, { x: 0, z: 0 }, false);
  addNetworkEdge(w.network, { x: 120, z: 0 }, { x: 120, z: 60 }, true);
  const original = new Set(w.network.edges.keys());
  w.draftAcceptance = (draft) => [...draft.edges].filter(([id]) => !original.has(id))
    .every(([, edge]) => edge.points.every((point) => point.z === 0)) ? "crossing straight route refused by caller" : null;
  const before = snap(w.network);
  const req = request({ id: "astar-caller-guard", target: { kind: "node", id: "120:0" }, maxLength: 240 });
  const exhausted = runConnection({ ...req, searchBudget: 10 }, w, { strategies: ["grid-astar"] });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.reason, "search-budget");
  assert.equal(snap(w.network), before);
  const result = runConnection(req, w, { strategies: ["grid-astar"] });
  assert.ok(result.ok, `caller rejection must resume bounded search: ${JSON.stringify(result)}`);
  assert.ok([...w.network.edges].some(([id, edge]) => !original.has(id) && edge.points.some((point) => point.z !== 0)));
}

// A site outside the old centreline-only grid exclusion still intersects the
// real road envelope. Search around it under the unchanged expansion budget.
{
  const w = makeWorld({ sites: [{ id: "grid-envelope", kind: "test", x: 52, z: 12, radius: 8 }] });
  addNetworkEdge(w.network, { x: -60, z: 0 }, { x: 0, z: 0 }, false);
  addNetworkEdge(w.network, { x: 120, z: 0 }, { x: 120, z: 60 }, true);
  const result = runConnection(request({ id: "astar-site-width", target: { kind: "node", id: "120:0" }, maxLength: 240 }),
    w, { strategies: ["grid-astar"] });
  assert.ok(result.ok, `full-width grid search must find the safe detour: ${JSON.stringify(result)}`);
  assert.ok(result.patch.addEdges.length > 1, "centreline shortcut is not a safe full-width road");
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 0);
}

// A curved source uses its adjacent segment, not its endpoint chord, for
// the initial A* heading. Ten states suffice for the safe straight continuation.
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: -40, z: 40 }, { x: 0, z: 0 }, false);
  w.network.edges.get("-40:40/0:0").points = [{ x: -40, z: 40 }, { x: 0, z: -24 }, { x: 0, z: 0 }];
  addNetworkEdge(w.network, { x: 0, z: 120 }, { x: 60, z: 120 }, true);
  const r = runConnection(request({ id: "astar-curve-heading", target: { kind: "node", id: "0:120" },
    maxLength: 240, searchBudget: 10 }), w, { strategies: ["grid-astar"] });
  assert.ok(r.ok, `curve tangent must permit the direct bounded continuation: ${JSON.stringify(r)}`);
  assert.equal(r.cost, 120);
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 0);
}

// (d) A*：湖挡住直线与三档绕行偏移，有界网格搜索（位置 + 入射方向）绕过去。
{
  const w = makeWorld({ lake: { x: 0, z: 0, r: 90 } });
  addNetworkEdge(w.network, { x: -200, z: 0 }, { x: -320, z: 0 }, false);
  addNetworkEdge(w.network, { x: 200, z: 0 }, { x: 320, z: 0 }, true);
  const r = runConnection(request({ id: "astar", source: { x: -200, z: 0 }, maxLength: 600 }), w);
  assert.ok(r.ok && r.strategy === "grid-astar", `grid A* expected: ${JSON.stringify(r)}`);
  assert.ok(connected(w.network, "-200:0", "320:0"), "A* did not join the components");
  for (const e of r.patch.addEdges) { // 全线不得入水（格点合法 ≠ 走廊合法，终筛以密集采样为准）
    const steps = Math.max(1, Math.ceil(Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) / 4));
    for (let k = 0; k <= steps; k += 1) {
      const p = { x: e.a.x + (e.b.x - e.a.x) * k / steps, z: e.a.z + (e.b.z - e.a.z) * k / steps };
      assert.ok(Math.hypot(p.x, p.z) >= 90, `A* segment crosses the lake at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    }
  }
  // (e) 预算耗尽：search-budget 是「未完成搜索」，不是「无路」；失败零副作用。
  const w2 = makeWorld({ lake: { x: 0, z: 0, r: 90 } });
  addNetworkEdge(w2.network, { x: -200, z: 0 }, { x: -320, z: 0 }, false);
  addNetworkEdge(w2.network, { x: 200, z: 0 }, { x: 320, z: 0 }, true);
  const frozen = snap(w2.network);
  const r2 = runConnection(request({ id: "budget", source: { x: -200, z: 0 }, maxLength: 600, searchBudget: 5 }), w2);
  assert.ok(!r2.ok && r2.reason === "search-budget", `search-budget expected: ${JSON.stringify(r2)}`);
  assert.equal(snap(w2.network), frozen, "failed connection mutated the network");
  const r3 = runConnection(request({ id: "no-target", target: { kind: "edges", include: () => false } }), w2);
  assert.ok(!r3.ok && r3.reason === "no-target", `no-target expected: ${JSON.stringify(r3)}`);
  assert.equal(snap(w2.network), frozen, "no-target failure mutated the network");
}

// (f) 主网定向：目标必须是 primary 分量——更近的诱饵分量不许接（不许「接最近分量」）；
//     主网不可达时如实失败并保持零副作用。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: -60 }, false);
  addNetworkEdge(w.network, { x: 0, z: 30 }, { x: 300, z: 30 }, false);   // 诱饵：更近，但不是主网
  addNetworkEdge(w.network, { x: 0, z: 300 }, { x: 300, z: 300 }, true);  // 主网
  const primary = new Set(["0:300", "300:300"]);
  const r = runConnection(request({ id: "primary", target: { kind: "primary", isPrimaryNode: (id) => primary.has(id) } }), w);
  assert.ok(r.ok, `primary-targeted connection expected to succeed: ${JSON.stringify(r)}`);
  const added = r.patch.addEdges[r.patch.addEdges.length - 1];
  assert.ok(primary.has(`${added.b.x}:${added.b.z}`) || primary.has(`${added.a.x}:${added.a.z}`), "connection must land on the primary component");
  assert.ok(!connected(w.network, "0:0", "300:30"), "the decoy component must stay unreached");
  // 主网被河隔开：连接器不许退回「接最近分量」，也不许跨水硬连。
  const w2 = makeWorld({ riverX: 0 });
  addNetworkEdge(w2.network, { x: -200, z: 0 }, { x: -320, z: 0 }, false);
  addNetworkEdge(w2.network, { x: -200, z: 40 }, { x: -60, z: 40 }, false); // 诱饵（近，同侧）
  addNetworkEdge(w2.network, { x: 200, z: 0 }, { x: 320, z: 0 }, true);     // 主网（河对岸）
  const primary2 = new Set(["200:0", "320:0"]);
  const frozen = snap(w2.network);
  const r2 = runConnection(request({ id: "primary-blocked", source: { x: -200, z: 0 }, maxLength: 600, target: { kind: "primary", isPrimaryNode: (id) => primary2.has(id) } }), w2);
  assert.ok(!r2.ok && ["water-span", "no-target", "search-budget"].includes(r2.reason), `unreachable primary must fail honestly: ${JSON.stringify(r2)}`);
  assert.equal(snap(w2.network), frozen, "failed primary connection mutated the network");
  assert.ok(!connected(w2.network, "-200:0", "-60:40"), "must not silently connect to the nearer non-primary component");
}

// (g) stale-base：过期 baseVersion 拒绝且零副作用（设计 §8「过期 baseVersion 拒绝」）。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: -60 }, false);
  addNetworkEdge(w.network, { x: -200, z: 120 }, { x: 200, z: 120 }, true);
  const proposed = proposeConnection(request({ id: "stale" }), w);
  assert.ok(proposed.ok, "proposal must succeed on a fresh network");
  w.network.version = 7;
  const frozen = snap(w.network);
  const committed = commitConnection(w, proposed);
  assert.ok(!committed.ok && committed.reason === "stale-base", `stale-base expected: ${JSON.stringify(committed)}`);
  assert.equal(snap(w.network), frozen, "stale-base commit mutated the network");
}

// (h) 确定性：同输入两次搜索产生相同补丁；两次提交产生相同网络。
{
  const build = () => {
    const w = makeWorld({ lake: { x: 0, z: 0, r: 90 } });
    addNetworkEdge(w.network, { x: -200, z: 0 }, { x: -320, z: 0 }, false);
    addNetworkEdge(w.network, { x: 200, z: 0 }, { x: 320, z: 0 }, true);
    return w;
  };
  const w1 = build(); const w2 = build();
  const r1 = runConnection(request({ id: "det", source: { x: -200, z: 0 }, maxLength: 600 }), w1);
  const r2 = runConnection(request({ id: "det", source: { x: -200, z: 0 }, maxLength: 600 }), w2);
  assert.ok(r1.ok && r2.ok, "both deterministic runs must succeed");
  assert.equal(JSON.stringify(r1.patch), JSON.stringify(r2.patch), "same input must yield the identical patch");
  assert.equal(snap(w1.network), snap(w2.network), "same input must yield the identical network");
}

// (i) 显式桥候选（批次 5-1，设计 §4.2）：窄河 ground→bridge→ground 三段、桥头在干地、跨距受控；
//     宽河拒绝；不 allowBridge 的普通连接不许「遇水自动可桥」。
{
  // 窄河（宽 18）：地面阶梯全部 water-span 失败，bridge-candidate 产出三段（中段 bridge）。
  const w = makeWorld({ riverX: 0 });
  addNetworkEdge(w.network, { x: -100, z: 0 }, { x: -220, z: 0 }, false);   // 门口悬挂支路
  addNetworkEdge(w.network, { x: 100, z: 0 }, { x: 220, z: 0 }, true);      // 对岸干道
  const noBridge = runConnection(request({ id: "nobridge", source: { x: -100, z: 0 }, maxLength: 400 }), w);
  assert.ok(!noBridge.ok && ["water-span", "slope", "no-target", "search-budget"].includes(noBridge.reason), `ground ladder must refuse to cross the river: ${JSON.stringify(noBridge)}`);
  assert.ok(!connected(w.network, "-100:0", "220:0"), "ground-only request must not reach the far bank");
  assert.ok([...w.network.edges.values()].every((e) => !e.bridge), "ground-only request must not sneak a bridge edge in");
  const beforeProposal = snap(w.network);
  const br = proposeConnection(request({ id: "bridge", source: { x: -100, z: 0 }, maxLength: 400, allowBridge: true }), w, { strategies: ["bridge-candidate"], crossings: false });
  assert.equal(snap(w.network), beforeProposal, "bridge proposal must not pre-commit its own corridor");
  assert.ok(br.ok && br.strategy === "bridge-candidate", `bridge candidate expected: ${JSON.stringify(br)}`);
  assert.equal(br.patch.addEdges.length, 3, `ground-bridge-ground needs 3 segments, got ${br.patch.addEdges.length}`);
  assert.equal(br.patch.addEdges.filter((e) => e.bridge).length, 1, "exactly the middle segment is the bridge");
  assert.equal(br.bridgeSpans.length, 1, "one bridge span to register");
  for (const end of [br.bridgeSpans[0].from, br.bridgeSpans[0].to]) assert.ok(w.geo.height(end.x, end.z) > 0.5, "bridgeheads must sit on dry land");
  const committed = runConnection(request({ id: "bridge2", source: { x: -100, z: 0 }, maxLength: 400, allowBridge: true }), w, { strategies: ["bridge-candidate"], crossings: false });
  assert.ok(committed.ok, "the bridge connection must commit");
  assert.ok(connected(w.network, "-100:0", "220:0"), "bridge did not join the banks");
  assert.ok([...w.network.edges.values()].some((e) => e.bridge), "the committed network must carry the bridge edge");
  // 宽河（跨距 > 84）：拒绝成桥，且零副作用。
  const w2 = makeWorld({ riverX: 0, riverWidth: 140 });
  addNetworkEdge(w2.network, { x: -200, z: 0 }, { x: -320, z: 0 }, false);
  addNetworkEdge(w2.network, { x: 200, z: 0 }, { x: 320, z: 0 }, true);
  const frozen = snap(w2.network);
  const tooWide = runConnection(request({ id: "wide", source: { x: -200, z: 0 }, maxLength: 800, allowBridge: true }), w2, { strategies: ["bridge-candidate"], crossings: false });
  assert.ok(!tooWide.ok && tooWide.reason === "water-span", `wide river must be refused: ${JSON.stringify(tooWide)}`);
  assert.equal(snap(w2.network), frozen, "refused bridge mutated the network");
}

// (j) 反向/共线端点（§8「反向端点」）：接入线沿悬挂边折回（<35°）时按 junction-angle 拒绝，
//     不产生 0° 重叠的假路口；坡度超限（§8「坡度超限」）：陡坡盘挡住直线，A* 绕过去。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: -120, z: 0 }, false);   // 悬挂边沿 -x
  addNetworkEdge(w.network, { x: -200, z: 0 }, { x: -320, z: 0 }, true); // 目标边在悬挂边的延长线上
  const folded = runConnection(request({ id: "fold" }), w, { strategies: ["direct-projection"] });
  assert.ok(!folded.ok && folded.reason === "junction-angle", `fold-back must be refused: ${JSON.stringify(folded)}`);
  assert.ok(!w.network.edges.has(edgeId("0:0", "-200:0")), "a collinear fold-back edge must not appear");
  const w2 = makeWorld({ slopeDisc: { x: 0, z: 0, r: 90 } });
  addNetworkEdge(w2.network, { x: -200, z: 0 }, { x: -320, z: 0 }, false);
  addNetworkEdge(w2.network, { x: 200, z: 0 }, { x: 320, z: 0 }, true);
  const steep = runConnection(request({ id: "slope", source: { x: -200, z: 0 }, maxLength: 600 }), w2);
  assert.ok(steep.ok && steep.strategy === "grid-astar", `A* around the steep disc expected: ${JSON.stringify(steep)}`);
  for (const e of steep.patch.addEdges) {
    const steps = Math.max(1, Math.ceil(Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) / 4));
    for (let k = 0; k <= steps; k += 1) {
      const p = { x: e.a.x + (e.b.x - e.a.x) * k / steps, z: e.a.z + (e.b.z - e.a.z) * k / steps };
      assert.ok(Math.hypot(p.x, p.z) >= 90, `route crosses the steep disc at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    }
  }
  assert.ok(connected(w2.network, "-200:0", "320:0"), "slope detour did not join the components");
}

// (k) mini-roundabout 策略档（city-roundabout，形态盘点 §5-1）：三岔口锐角对（20° < 30°，阈值放宽 (b)）
//     以交通环消解——建环不删边（三条腿只剩环内残头被替换，远端全部经环连通）、弧段全过走廊、
//     建环后整网过角度守卫（acuteJunctions 归零）；陡坡盘挡住 r=10 时升档到 r=12（半径阶梯）；
//     灰带外（≥50°）/腿太短 → 拒绝且零副作用；确定性：两次建环产生相同网络。
{
  const legAt = (w, deg, len, arterial) => addNetworkEdge(w.network, { x: 0, z: 0 }, { x: Math.cos(deg * Math.PI / 180) * len, z: Math.sin(deg * Math.PI / 180) * len }, arterial);
  const trunkAt = (w, deg, len) => addNetworkEdge(w.network, { x: 0, z: 0 }, { x: Math.cos(deg * Math.PI / 180) * len, z: Math.sin(deg * Math.PI / 180) * len }, true, false, true);
  const farId = (deg, len) => `${Math.round(Math.cos(deg * Math.PI / 180) * len * 100) / 100}:${Math.round(Math.sin(deg * Math.PI / 180) * len * 100) / 100}`;
  const view = (w) => ({ roadEdges: [...w.network.edges.values()], roadNodes: [...w.network.nodes.values()] });
  const policy = (w) => ({ requireBuildable: true, maxSlope: 0.9, sites: w.reservations(), siteMargin: CONNECTOR_CONFIG.fallbackSiteMargin });
  // 锐角对：V 三条腿 90° / 70°（夹角 20°，acuteJunctions 标记）/ 220°，各长 120。
  const w = makeWorld();
  legAt(w, 90, 120, false); legAt(w, 70, 120, false); legAt(w, 220, 120, true);
  assert.equal(acuteJunctions.measure(view(w)).length, 1, "scenario must start with exactly one acute junction");
  const r = runMiniRoundabout(w, { id: "0:0", x: 0, z: 0 }, [...w.network.edges.values()]);
  assert.ok(r.ok, `mini-roundabout expected: ${JSON.stringify(r)}`);
  assert.ok(r.radius >= 10 && r.radius <= 14, `ring radius ${r.radius} outside 10..14`);
  assert.ok(r.ring.length >= CONNECTOR_CONFIG.roundaboutMinSegments && r.ring.length <= CONNECTOR_CONFIG.roundaboutMaxSegments, `ring must have 4-6 arc edges, got ${r.ring.length}`);
  assert.ok(!w.network.nodes.has("0:0"), "the ring must replace the junction node (no orphan centre)");
  assert.ok(connected(w.network, farId(90, 120), farId(70, 120)) && connected(w.network, farId(90, 120), farId(220, 120)), "all three leg far-ends must stay connected through the ring (no deletion)");
  assert.equal(w.network.edges.size, 3 + r.ring.length, `3 leg remainders + ${r.ring.length} arc edges expected, got ${w.network.edges.size}`);
  const arterialRemainder = [...w.network.edges.values()].filter((e) => e.kind === "arterial");
  assert.equal(arterialRemainder.length, 1, "the arterial leg's remainder must keep its class/width (attribute inheritance)");
  assert.ok([...w.network.edges.values()].filter((e) => e.width === 5).length >= r.ring.length, "arc edges are local-width ring segments");
  for (const p of r.ring) assert.ok(Math.abs(Math.hypot(p.x, p.z) - r.radius) < 0.06, `ring point (${p.x},${p.z}) off the radius-${r.radius} circle`);
  for (let k = 0; k < r.ring.length; k += 1) {
    const a = r.ring[k]; const b = r.ring[(k + 1) % r.ring.length];
    assert.equal(corridorFailure(w, a, b, policy(w)), null, `arc chord ${k} must pass the ground corridor`);
  }
  assert.equal(acuteJunctions.measure(view(w)).length, 0, "the ring must clear acuteJunctions across the whole network (guard's own predicate)");
  // 半径阶梯：半径 9 的陡坡盘挡住小环路；全路幅检查要求更大的合法半径。
  const wSlope = makeWorld({ slopeDisc: { x: 0, z: 0, r: 9 } });
  legAt(wSlope, 90, 120, false); legAt(wSlope, 70, 120, false); legAt(wSlope, 220, 120, false);
  const rs = runMiniRoundabout(wSlope, { id: "0:0", x: 0, z: 0 }, [...wSlope.network.edges.values()]);
  assert.ok(rs.ok && rs.radius > 10, `radius ladder must avoid the slope disc with the full road width: ${JSON.stringify(rs)}`);
  for (let k = 0; k < rs.ring.length; k += 1) {
    const a = rs.ring[k]; const b = rs.ring[(k + 1) % rs.ring.length];
    assert.equal(corridorFailure(wSlope, a, b, { ...policy(wSlope), roadWidth: 5 }), null, `arc chord ${k} must clear the slope disc across its width`);
  }
  // 主干三岔口（普查残留的真实形态，如 seed 2004084431：local 78° / trunk 102° / trunk 282°，24.2° 对）：
  // 主干腿进环（环是路口形态不是删路），剩余段保 12 宽，弧段是 local 5 宽的环流。
  const wTrunk = makeWorld();
  legAt(wTrunk, 77.8, 113, false); trunkAt(wTrunk, 102, 36); trunkAt(wTrunk, 282, 36);
  const rt = runMiniRoundabout(wTrunk, { id: "0:0", x: 0, z: 0 }, [...wTrunk.network.edges.values()]);
  assert.ok(rt.ok, `trunk-leg roundabout expected: ${JSON.stringify(rt)}`);
  assert.equal([...wTrunk.network.edges.values()].filter((e) => e.width === 12).length, 2, "trunk leg remainders must keep width 12");
  assert.equal([...wTrunk.network.edges.values()].filter((e) => e.width === 5).length, rt.ring.length + 1, "the ring plus the local leg remainder stay width 5");
  assert.equal(acuteJunctions.measure(view(wTrunk)).length, 0, "trunk roundabout must clear acuteJunctions too");
  assert.ok(connected(wTrunk.network, farId(77.8, 113), farId(102, 36)) && connected(wTrunk.network, farId(102, 36), farId(282, 36)), "trunk junction must stay connected through the ring");
  // 桥腿不参与（环段是地面弧边，不能替换桥跨）：锐角对里一条腿是桥的三岔口拒绝且零副作用。
  const wBridge = makeWorld();
  legAt(wBridge, 80, 120, false); legAt(wBridge, 100, 120, false); legAt(wBridge, 250, 120, false);
  const bridgeId = [ "0:0", farId(100, 120) ].sort().join("/");
  wBridge.network.edges.get(bridgeId).bridge = true;
  const frozenBridge = snap(wBridge.network);
  const rb = runMiniRoundabout(wBridge, { id: "0:0", x: 0, z: 0 }, [...wBridge.network.edges.values()]);
  assert.ok(!rb.ok && rb.reason === "no-target", `bridge-leg junction must be refused: ${JSON.stringify(rb)}`);
  assert.equal(snap(wBridge.network), frozenBridge, "refused bridge-leg roundabout mutated the network");
  // 灰带外（最小夹角 55° ≥ 50°）：策略档不是它的活——拒绝（junction-angle）且零副作用。
  const wWide = makeWorld();
  legAt(wWide, 90, 120, false); legAt(wWide, 35, 120, false); legAt(wWide, 220, 120, false);
  const frozenWide = snap(wWide.network);
  const rw = runMiniRoundabout(wWide, { id: "0:0", x: 0, z: 0 }, [...wWide.network.edges.values()]);
  assert.ok(!rw.ok && rw.reason === "junction-angle", `out-of-band junction must be refused: ${JSON.stringify(rw)}`);
  assert.equal(snap(wWide.network), frozenWide, "refused roundabout mutated the network");
  // 腿太短（12 长，切完剩 <6）：三档半径全作废——如实失败、零副作用（调用方退回删短枝）。
  const wShort = makeWorld();
  legAt(wShort, 90, 12, false); legAt(wShort, 70, 12, false); legAt(wShort, 220, 12, false);
  const frozenShort = snap(wShort.network);
  const rshort = runMiniRoundabout(wShort, { id: "0:0", x: 0, z: 0 }, [...wShort.network.edges.values()]);
  assert.ok(!rshort.ok, "short legs must not yield a roundabout");
  assert.equal(snap(wShort.network), frozenShort, "failed roundabout mutated the network");
  // 确定性：同输入两次建环产生相同网络。
  const build2 = () => { const x = makeWorld(); legAt(x, 90, 120, false); legAt(x, 70, 120, false); legAt(x, 220, 120, true); return x; };
  const wA = build2(); const wB = build2();
  runMiniRoundabout(wA, { id: "0:0", x: 0, z: 0 }, [...wA.network.edges.values()]);
  runMiniRoundabout(wB, { id: "0:0", x: 0, z: 0 }, [...wB.network.edges.values()]);
  assert.equal(snap(wA.network), snap(wB.network), "same input must yield the identical ring network");
}

// ── 批 A 统一终筛门禁（CITY_NETWORK_FIRST_OPTIMIZATION_PLAN §4-A）──────────────────────────
// 提议期预筛与提交期草稿复核共用 validateCandidate；策略级整体豁免已废除。四个负例 + 一个正向对照。

// (i1) 无水陡坡桥策略：纯地面 bridge-candidate 引道穿坡度 9 盘（> 实测阈值 6）——拒（slope），零副作用。
{
  const w = makeWorld({ slopeDisc: { x: 0, z: 75, r: 20, value: 9 } });
  addNetworkEdge(w.network, { x: -40, z: 150 }, { x: 40, z: 150 }, true);
  const frozen = snap(w.network);
  const r = runConnection(request({ id: "steep-dry", allowBridge: true, maxLength: 300 }), w, { strategies: ["bridge-candidate"], bridge: { blockers: [] } });
  assert.ok(!r.ok && r.reason === "slope", `steep dry approach must be refused: ${JSON.stringify(r)}`);
  assert.equal(snap(w.network), frozen, "refused steep approach mutated the network");
}

// (i2) 真实桥陡坡引道：跨河桥的西岸引道穿坡度 9 盘——deck 合法，但引道（ground-approach）拒 slope，零副作用。
{
  const w = makeWorld({ riverX: 0, slopeDisc: { x: -30, z: 0, r: 15, value: 9 } });
  addNetworkEdge(w.network, { x: 60, z: 0 }, { x: 220, z: 0 }, true);
  const frozen = snap(w.network);
  const r = runConnection(request({ id: "steep-bank", source: { x: -60, z: 0 }, allowBridge: true, maxLength: 400 }), w, { strategies: ["bridge-candidate"], bridge: { blockers: [] } });
  assert.ok(!r.ok && r.reason === "slope", `steep river-bank approach must be refused: ${JSON.stringify(r)}`);
  assert.equal(snap(w.network), frozen, "refused steep bank approach mutated the network");
}

// (i3) siteGate 不再豁免坡度：门路（siteGate: true，purpose=site-access）引道穿坡度 9 盘、无 blockers——
//      旧实现（整体豁免 + maxSlope=Infinity）会提交；批 A 起按 ground-approach 有限坡度（实测 6）拒 slope，零副作用。
{
  const w = makeWorld({ slopeDisc: { x: 0, z: 75, r: 20, value: 9 } });
  addNetworkEdge(w.network, { x: -40, z: 150 }, { x: 40, z: 150 }, true);
  const frozen = snap(w.network);
  const r = runConnection(request({ id: "gate-steep", purpose: "site-access", allowBridge: true, maxLength: 300 }), w, { strategies: ["bridge-candidate"], bridge: { self: { x: 0, z: -14, radius: 10 }, blockers: [], siteGate: true }, crossings: false });
  assert.ok(!r.ok && r.reason === "slope", `gate with a steep approach must be refused (no siteGate slope exemption): ${JSON.stringify(r)}`);
  assert.equal(snap(w.network), frozen, "refused steep gate mutated the network");
}

// (i4) 固定路线冲突：堤道 deck 与既有路严格相交且无高程模型——vertical-clearance-unsupported 拒，零副作用。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: -100, z: 50 }, { x: 100, z: 50 }, true);
  const frozen = snap(w.network);
  const committed = commitFixedLink(w, [{ a: { x: 0, z: 0 }, b: { x: 0, z: 150 }, arterial: false, bridge: true, primary: false }]);
  assert.ok(!committed.ok, `conflicting fixed deck must be refused: ${JSON.stringify(committed)}`);
  assert.match(committed.detail ?? "", /vertical-clearance-unsupported/, "refusal must name the vertical-clearance cause");
  assert.equal(snap(w.network), frozen, "refused fixed link mutated the network");
}

// (i5) 正向对照（前滩引道）：干地但 buildable=false（前滩）、坡度 0.2（≤6）——引道按道路可行条件放行，
//      不套建筑 buildable 判据（「前滩地面不必满足建筑 buildable，但须按明确道路可行条件验证」）。
{
  const self = { id: "beach-owner", x: 0, z: -14, radius: 10 };
  const w = makeWorld({ unbuildable: [{ x: 0, z: 60, r: 30 }], sites: [self] });
  addNetworkEdge(w.network, { x: -40, z: 150 }, { x: 40, z: 150 }, true);
  const r = runConnection(request({ id: "beach-gate", allowBridge: true, maxLength: 300 }), w, { strategies: ["bridge-candidate"], bridge: { self, blockers: [], siteGate: true }, crossings: false });
  assert.ok(r.ok && r.strategy === "bridge-candidate", `gentle unbuildable beachfront approach must pass: ${JSON.stringify(r)}`);
  assert.ok(w.network.edges.size > 1, "beachfront gate must commit its edges");
  assert.ok([...w.network.edges.values()].every((e) => !e.bridge), "no deck is needed on dry beachfront");
}

// J：生产近接 T 使用连接器事务，属性继承；陡坡拒绝零副作用。
{
  const w = makeWorld();
  const r = commitFixedLink(w, [{ a: { x: -40.004, z: 0.004 }, b: { x: 40.004, z: -0.004 }, arterial: true }]);
  assert.ok(r.ok, "a canonicalized corridor must not be rejected for crossing its own rounded draft edge");
  assert.ok(w.network.edges.has("-40:0/40:0"));
  const conflict = snap(w.network);
  assert.ok(!commitFixedLink(w, [{ a: { x: -40, z: 0 }, b: { x: 40, z: 0 }, arterial: true, bridge: true }]).ok, "a skipped duplicate ground edge cannot be certified as a deck");
  assert.equal(snap(w.network), conflict);
  const wide = makeWorld({ sites: [{ x: 0, z: 10, radius: 4 }] });
  addNetworkEdge(wide.network, { x: -40, z: 0 }, { x: 40, z: 0 }, true, false, true);
  const before = snap(wide.network);
  assert.ok(!commitFixedLink(wide, [{ a: { x: -40, z: 0 }, b: { x: 40, z: 0 }, arterial: false }]).ok, "actual retained width wins over the narrower duplicate proposal");
  assert.equal(snap(wide.network), before);
}

// J：生产近接 T 使用连接器事务，属性继承；陡坡拒绝零副作用。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 0, z: -100 }, { x: 0, z: 0 }, false);
  addNetworkEdge(w.network, { x: -100, z: 12 }, { x: 100, z: 12 }, true);
  const host = [...w.network.edges.values()].find((e) => e.width === 8); host.width = 9;
  const log = [];
  const ctx = { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [], landmarks: [], coast: [], seaside: null, coastRoadRunEnds: [], connectionLog: log };
  assert.equal(joinNearMissEnds(ctx), 1, "near T goes through the production repair's transaction connector");
  assert.ok(connected(w.network, "0:-100", "100:12"));
  assert.equal([...w.network.edges.values()].filter((e) => e.width === 9).length, 2, "host custom width survives both split halves");
  assert.ok(log.some((entry) => entry.ok));
  const bad = makeWorld({ slopeDisc: { x: 0, z: 6, r: 4 } });
  addNetworkEdge(bad.network, { x: 0, z: -100 }, { x: 0, z: 0 }, false);
  addNetworkEdge(bad.network, { x: -100, z: 12 }, { x: 100, z: 12 }, true);
  const frozen = snap(bad.network);
  assert.equal(joinNearMissEnds({ ...ctx, network: bad.network, geo: bad.geo, inRiver: bad.inRiver }), 0);
  assert.equal(snap(bad.network), frozen, "unsafe near T leaves both hosts intact");
}

// 桥头短引道不是可删短枝：即便非桥子图把它列为度 1，删枝也不能移除唯一接地关系。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: -30, z: 0 }, { x: -2, z: 0 }, false, true);
  addNetworkEdge(w.network, { x: -2, z: 0 }, { x: 0, z: 0 }, false);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 100, z: 0 }, false);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: 100 }, false);
  const frozen = snap(w.network);
  const ctx = { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [], landmarks: [], coast: [], seaside: null, coastRoadRunEnds: [], carPaths: [] };
  assert.equal(pruneShortSpurs(ctx), 0);
  assert.equal(snap(w.network), frozen);
}

// 已注册桥头引道继承统一终筛的有限标准；普通道路不得借同一地形放宽坡度。
{
  const w = makeWorld({ slopeDisc: { x: 0, z: 10, r: 25, value: 2 } });
  addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 0, z: 0 }, true, true);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: 40 }, true);
  const parent = [...w.network.edges.values()].find((edge) => !edge.bridge);
  assert.equal(groundJunctionCorridorFailure(w, { x: 0, z: 0 }, { x: 0, z: 40 }, 8), "slope");
  assert.equal(groundJunctionCorridorFailure(w, { x: 0, z: 0 }, { x: 0, z: 40 }, 8, parent), null);
  assert.equal(groundJunctionCorridorFailure(w, { x: 0, z: 20 }, { x: 0, z: 40 }, 8, parent), null, "split descendant uses its actual bridge-approach parent");
  const steep = makeWorld({ slopeDisc: { x: 0, z: 10, r: 25, value: 7 } });
  steep.network = w.network;
  assert.equal(groundJunctionCorridorFailure(steep, { x: 0, z: 0 }, { x: 0, z: 40 }, 8, parent), "slope", "bridge adjacency never creates an unlimited slope exemption");
}

// 广场圆预留不是实体占地；道路全幅和余量仍必须避开所有生长阶段的实体。
{
  const site = { x: 9.860828518609765, z: -421.5568316036062, radius: 44, yaw: -0.15 };
  assert.ok(civicRoadClear(site, { x: -26.8, z: -458.44 }, { x: -40.9, z: -472.62 }, 12, 3), "actual civic solids leave the existing plaza ring corridor clear");
  assert.ok(!civicRoadClear({ x: 0, z: 0, radius: 44, yaw: 0 }, { x: -100, z: 0 }, { x: 100, z: 0 }, 12, 3), "road through the actual civic base is refused");
  assert.ok(!civicRoadClear({ x: 0, z: 0, radius: 44, yaw: 0 }, { x: -100, z: 41 }, { x: 100, z: 41 }, 12, 3), "high-tier steps and flag band require full-road clearance");
  const footprint = civicGroundFootprint(44);
  for (const count of [1, 4, 30]) for (let i = 0; i < count; i += 1) {
    const x = civicFlagLocalX(44, i, count);
    assert.ok(footprint.parts.some((part) => pointInRegion({ x: x - 0.15, z: 44 * 0.78 }, part)));
    assert.ok(footprint.parts.some((part) => pointInRegion({ x: x + 2.4, z: 44 * 0.78 }, part)), "data-dependent flags fit their declared envelope");
  }
}

// 亚单位近接是节点合并，不能添加零碎短路；owner、车流、岸段引用同步更新。
// Replay the historical civic-ring geometry independently of changes to the
// whole-city radius/site layout: the 0.156-unit gap must be a real 3-way node.
{
  const site = { id: "civic-square", kind: "civic", x: 9.860828518609765, z: -421.5568316036062, radius: 44, yaw: -0.15 };
  const w = makeWorld(), target = { x: -26.8, z: -458.44 }, source = { x: -26.91, z: -458.33 };
  addNetworkEdge(w.network, { x: -40.9, z: -472.62 }, target, true, false, true);
  addNetworkEdge(w.network, target, { x: -12.7, z: -472.62 }, true, false, true);
  addNetworkEdge(w.network, source, { x: -70, z: -430 }, true);
  const ctx = { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [site], landmarks: [], blocks: [],
    primaryAnchorNodeId: "-26.8:-458.44", carPaths: [[source, { x: -70, z: -430 }]], coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [] };
  assert.equal(snapNearJunctions(ctx), 1);
  assert.ok(!ctx.network.nodes.has("-26.91:-458.33"));
  assert.equal([...ctx.network.edges.values()].filter((edge) => edge.from === "-26.8:-458.44" || edge.to === "-26.8:-458.44").length, 3);
  assert.deepEqual(ctx.carPaths[0][0], target);
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
}
{
  const build = (blocked = false) => {
    const w = makeWorld({ sites: blocked ? [{ x: 0, z: 10, radius: 5 }] : [] });
    addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 0, z: 0 }, true);
    addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 100, z: 0 }, true);
    addNetworkEdge(w.network, { x: 0, z: 0.16 }, { x: 0, z: 100 }, false);
    const gate = { id: "station-test", kind: "station", x: 0, z: 150, radius: 10, yaw: 0,
      access: { role: "plot-gate", nodeId: "0:0.16", ownerX: 0, ownerZ: 150, ownerYaw: 0 } };
    return { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [gate], landmarks: [], blocks: [], primaryAnchorNodeId: "0:0",
      carPaths: [[{ x: 0, z: 0.16 }, { x: 0, z: 100 }]], coastRoadRuns: [[{ x: 0, z: 0.16 }, { x: 0, z: 100 }]], riverRoadRuns: [], coastRoadRunEnds: [{ x: 0, z: 0.16 }] };
  };
  const ctx = build();
  assert.equal(snapNearJunctions(ctx), 1);
  assert.equal(ctx.network.edges.size, 3, "no microscopic connecting edge added");
  assert.ok(!ctx.network.nodes.has("0:0.16"));
  assert.equal(ctx.publicSites[0].access.nodeId, "0:0");
  assert.deepEqual(ctx.carPaths[0][0], { x: 0, z: 0 });
  assert.deepEqual(ctx.coastRoadRuns[0][0], { x: 0, z: 0 });
  assert.deepEqual(ctx.coastRoadRunEnds[0], { x: 0, z: 0 });
  assert.equal(snapNearJunctions(ctx), 0);
  const blocked = build(); blocked.publicSites.push({ id: "blocker", kind: "park", x: 0, z: 10, radius: 5, yaw: 0 });
  const before = snap(blocked.network);
  assert.equal(snapNearJunctions(blocked), 0);
  assert.equal(snap(blocked.network), before);
  assert.equal(blocked.publicSites[0].access.nodeId, "0:0.16");
}

// 急角口中两条重合支路不能靠删边制造断头；并远端节点、删重复边并保留支路和 owner/车流引用。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 50, z: 0 }, true);
  addNetworkEdge(w.network, { x: 50, z: 0 }, { x: 100, z: 0 }, true);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 50, z: 0.1 }, false);
  addNetworkEdge(w.network, { x: 50, z: 0.1 }, { x: 60, z: 20 }, false);
  const gate = { id: "close-branch-gate", kind: "station", x: 70, z: 30, radius: 5, yaw: 0,
    access: { role: "plot-gate", nodeId: "50:0.1", ownerX: 70, ownerZ: 30, ownerYaw: 0 } };
  const ctx = { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [gate], landmarks: [], blocks: [], primaryAnchorNodeId: "100:0",
    carPaths: [[{ x: 0, z: 0 }, { x: 50, z: 0.1 }, { x: 60, z: 20 }]], coastRoadRuns: [[{ x: 0, z: 0 }, { x: 50, z: 0.1 }, { x: 60, z: 20 }]], riverRoadRuns: [], coastRoadRunEnds: [{ x: 0, z: 0 }] };
  assert.equal(mergeCoincidentJunctionLegs(ctx, "0:0"), true);
  assert.equal(ctx.network.edges.size, 3, "overlapping duplicate edge is removed while its far branch survives");
  assert.ok(!ctx.network.nodes.has("50:0.1"));
  assert.equal(ctx.network.nodes.has("50:0"), true);
  assert.equal(ctx.publicSites[0].access.nodeId, "50:0");
  assert.deepEqual(ctx.carPaths[0], [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 60, z: 20 }]);
  assert.deepEqual(ctx.coastRoadRuns[0], ctx.carPaths[0]);
  assert.equal(acuteJunctions.measure({ roadEdges: [...ctx.network.edges.values()], roadNodes: [...ctx.network.nodes.values()] }).length, 0);
}

// 近邻节点共同邻点只有两条腿，也须消解重复边；不依赖锐角策略的三岔触发。
{
  const build = (blocked = false, incompatible = false) => {
    const w = makeWorld({ sites: blocked ? [{ x: 50, z: 0, radius: 3 }] : [] });
    addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 100, z: 0 }, true, false, true);
    addNetworkEdge(w.network, { x: 0, z: 0.16 }, { x: 100, z: 0 }, true);
    addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 0, z: 0 }, true, false, true);
    addNetworkEdge(w.network, { x: 0, z: 0.16 }, { x: 0, z: 100 }, false);
    if (incompatible) w.network.edges.get("0:0.16/100:0").structure = "ground-approach";
    const site = { id: "owner", kind: "park", x: 25, z: 25, radius: 3, yaw: 0,
      access: { role: "plot-gate", nodeId: "0:0.16", ownerX: 25, ownerZ: 25, ownerYaw: 0 } };
    return { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [...w.reservations(), site], landmarks: [], blocks: [],
      primaryAnchorNodeId: "-100:0", carPaths: [[{ x: 100, z: 0 }, { x: 0, z: 0.16 }, { x: 0, z: 100 }]],
      coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [], connectionLog: [] };
  };
  const ctx = build();
  assert.equal(snapNearJunctions(ctx), 1);
  assert.equal(ctx.network.edges.size, 3);
  assert.equal(ctx.network.edges.get("0:0/100:0").width, 12);
  assert.ok(!ctx.network.nodes.has("0:0.16"));
  assert.equal(ctx.publicSites[0].access.nodeId, "0:0");
  assert.deepEqual(ctx.carPaths[0], [{ x: 100, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 100 }]);
  assert.equal(groundJunctionFindings([...ctx.network.edges.values()]).length, 0);
  for (const rejected of [build(true), build(false, true)]) {
    const before = snap(rejected.network), refs = JSON.stringify([rejected.publicSites, rejected.carPaths]);
    assert.equal(snapNearJunctions(rejected), 0);
    assert.equal(snap(rejected.network), before);
    assert.equal(JSON.stringify([rejected.publicSites, rejected.carPaths]), refs);
  }
}

// 同走廊终端重复段整合；桥体不移动，支路/gate/路径保留，独立需求和地块碰撞不接受。
{
  const build = (relocate = false) => {
    const w = makeWorld();
    if (relocate) {
      const height = (x, z) => Math.hypot(x - 20, z - 20) < 0.5 ? 0.2 : 1.2;
      w.geo.height = height; w.geo.terrain.height = height;
    }
    addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: 100 }, true, false, true);
    addNetworkEdge(w.network, { x: 0, z: -100 }, { x: 0, z: 0 }, true, true, true);
    if (relocate) {
      addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 20, z: 20 }, false);
      addNetworkEdge(w.network, { x: 20, z: 20 }, { x: 40, z: 40 }, false);
    }
    addNetworkEdge(w.network, { x: 0.3, z: 0.5 }, { x: 0.3, z: 40 }, true);
    addNetworkEdge(w.network, { x: 0.3, z: 0.5 }, { x: 0, z: 0 }, false);
    addNetworkEdge(w.network, { x: 0.3, z: 0.5 }, { x: -50, z: 0.5 }, false);
    return { network: w.network, geo: w.geo, height: w.geo.height, inRiver: w.inRiver, primaryAnchorNodeId: "0:100", landmarks: [], blocks: [],
      publicSites: [{ id: "plot", kind: "park", x: -60, z: 20, radius: 3, yaw: 0, access: { role: "plot-gate", nodeId: "0.3:0.5", ownerX: -60, ownerZ: 20, ownerYaw: 0 } }],
      carPaths: [[{ x: 0.3, z: 0.5 }, { x: -50, z: 0.5 }]], coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [] };
  };
  const ctx = build(), deck = JSON.stringify([...ctx.network.edges.values()].find((edge) => edge.bridge));
  assert.equal(consolidateTerminalCorridors(ctx), 1);
  assert.equal(ctx.network.edges.size, 3);
  assert.equal(ctx.network.version, 1);
  assert.ok(!ctx.network.nodes.has("0.3:40") && !ctx.network.nodes.has("0.3:0.5"));
  assert.equal(JSON.stringify([...ctx.network.edges.values()].find((edge) => edge.bridge)), deck);
  assert.equal(ctx.publicSites[0].access.nodeId, "0:0");
  assert.deepEqual(ctx.carPaths[0][0], { x: 0, z: 0 });
  assert.equal(ctx.network.edges.get("-50:0.5/0:0").structure, "ground-approach");
  assert.equal(consolidateTerminalCorridors(ctx), 0);
  const relocated = build(true);
  assert.equal(consolidateTerminalCorridors(relocated), 1, "an unchanged unsafe neighboring approach does not block an independent duplicate removal");
  assert.ok(relocated.network.nodes.has("20:20"), "untouched terrain defect is retained for its own repair strategy");
  assert.equal([...relocated.network.edges.values()].filter((edge) => edge.from === "0:0" || edge.to === "0:0").length, 4);
  assert.equal([...relocated.network.edges.values()].filter((edge) => edge.from === "40:40" || edge.to === "40:40").length, 1);
  assert.ok([...relocated.network.edges.values()].some((edge) => edge.from === "20:20" || edge.to === "20:20"), "both legs of the unchanged approach remain connected");
  for (const type of ["owned-terminal", "traffic-terminal", "parcel"]) {
    const bad = build();
    if (type === "owned-terminal") bad.publicSites[0].access.nodeId = "0.3:40";
    if (type === "traffic-terminal") bad.carPaths.push([{ x: 0.3, z: 0.5 }, { x: 0.3, z: 40 }]);
    if (type === "parcel") bad.blocks.push({ parcels: [{ id: "reserved", x: -10, z: -3.6, width: 1, depth: 1 }] });
    const frozen = snap(bad.network), paths = JSON.stringify(bad.carPaths);
    assert.equal(consolidateTerminalCorridors(bad), 0, `${type}: independent obligation or unsafe geometry cannot be discarded`);
    assert.equal(snap(bad.network), frozen);
    assert.equal(JSON.stringify(bad.carPaths), paths);
  }
}

// 端点到路段近接，与两个节点的距离不同：长宿主拆T，邻端不足3时合并邻端。
{
  const build = (nearEnd = false) => {
    const w = makeWorld();
    addNetworkEdge(w.network, { x: 0, z: -100 }, { x: 0, z: -0.2 }, false);
    addNetworkEdge(w.network, { x: nearEnd ? -1.5 : -100, z: 0 }, { x: 100, z: 0 }, true);
    if (nearEnd) addNetworkEdge(w.network, { x: -1.5, z: 0 }, { x: -1.5, z: 100 }, true);
    return { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [], landmarks: [], blocks: [], primaryAnchorNodeId: "0:-100",
      carPaths: [[{ x: nearEnd ? -1.5 : -100, z: 0 }, { x: 100, z: 0 }]], coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [] };
  };
  const middle = build(); assert.equal(snapNearEdgeJunctions(middle), 1);
  assert.ok(!middle.network.nodes.has("0:-0.2"));
  assert.equal(middle.network.edges.size, 3);
  assert.deepEqual(middle.carPaths[0], [{ x: -100, z: 0 }, { x: 0, z: 0 }, { x: 100, z: 0 }]);
  const end = build(true); assert.equal(snapNearJunctions(end), 0, "nodes more than0.5 apart do not enter subunit node snap");
  assert.equal(snapNearEdgeJunctions(end), 1);
  assert.ok(!end.network.nodes.has("0:-0.2"));
  assert.equal(end.network.edges.size, 3, "short host remnant is avoided by existing endpoint merge");
  assert.equal(groundJunctionFindings([...end.network.edges.values()]).length, 0);
}

// Adjacent junctions already joined by a sub-unit edge: remove only that
// collapsed connector, preserve its pre-existing short leg without shortening
// it, and normalize all crossing relations in one transaction.
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: -40, z: 0 }, { x: 0, z: 0 }, true, false, true);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: -40 }, true);
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0.17, z: 0 }, true);
  addNetworkEdge(w.network, { x: 0.17, z: 0 }, { x: 40, z: -20 }, true);
  addNetworkEdge(w.network, { x: 0.17, z: 0 }, { x: 1.8, z: 2 }, false);
  const ctx = { network: w.network, geo: w.geo, inRiver: w.inRiver, height: w.geo.height,
    publicSites: [], landmarks: [], blocks: [], ringRuns: [], coast: [], core: { x: 0, z: 0 }, trunkRuns: [],
    bridges: [], SHORE_SITE_KINDS: new Set(), carPaths: [], coastRoadRunEnds: [], coastRoadRuns: [], riverRoadRuns: [],
    primaryAnchorNodeId: "-40:0", connectionLog: [] };
  const beforeShortLeg = Math.hypot(1.8 - 0.17, 2);
  assert.ok(groundJunctionFindings([...w.network.edges.values()]).length > 0);
  assert.equal(snapNearEdgeJunctions(ctx), 1);
  assert.ok(!w.network.edges.has("0:0/0.17:0"), "collapsed sub-unit connector is removed instead of becoming a self-loop");
  const shortLeg = w.network.edges.get("0.17:0/1.8:2");
  assert.ok(shortLeg, "pre-existing short leg remains connected at the canonical junction");
  assert.ok(Math.hypot(shortLeg.points[1].x - shortLeg.points[0].x, shortLeg.points[1].z - shortLeg.points[0].z) + 0.17 >= beforeShortLeg,
    "the merge must not materially shorten the grandfathered leg");
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 0);
}

// 距交点1单位的尽端与宿主拆边原子成为T；不得保留小残段或丢弃路径引用。
{
  const build = (blocked = false) => {
    const w = makeWorld();
    addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 1, z: 0 }, true, false, true);
    addNetworkEdge(w.network, { x: 0, z: -50 }, { x: 0, z: 50 }, true);
    const sites = blocked ? [{ id: "obstacle", kind: "park", x: 0, z: 0, radius: 5, yaw: 0 }] : [];
    return { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: sites, landmarks: [], blocks: [], primaryAnchorNodeId: "-100:0",
      carPaths: [[{ x: -100, z: 0 }, { x: 1, z: 0 }], [{ x: 0, z: -50 }, { x: 0, z: 50 }]], coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [] };
  };
  const ctx = build();
  assert.equal(snapShortCrossings(ctx), 1);
  assert.equal(ctx.network.version, 1, "split and end relocation publish once");
  assert.equal(ctx.network.edges.size, 3);
  assert.ok(!ctx.network.nodes.has("1:0"));
  assert.equal([...ctx.network.edges.values()].filter((edge) => edge.from === "0:0" || edge.to === "0:0").length, 3);
  assert.ok([...ctx.network.edges.values()].some((edge) => edge.width === 12));
  assert.deepEqual(ctx.carPaths[0], [{ x: -100, z: 0 }, { x: 0, z: 0 }]);
  assert.deepEqual(ctx.carPaths[1], [{ x: 0, z: -50 }, { x: 0, z: 0 }, { x: 0, z: 50 }]);
  assert.equal(snapShortCrossings(ctx), 0);
  const bad = build(true), before = snap(bad.network), paths = JSON.stringify(bad.carPaths);
  assert.equal(snapShortCrossings(bad), 0);
  assert.equal(snap(bad.network), before);
  assert.equal(JSON.stringify(bad.carPaths), paths);
}

// 交叉度量按真实折线，不拿弦线造假交点，也不漏掉共用远端节点后的第二处交叉。
{
  const point = (x, z) => ({ x, z });
  const edge = (id, points, from = `${points[0].x}:${points[0].z}`) => ({ id, from, to: `${points.at(-1).x}:${points.at(-1).z}`, points, width: 8, kind: "arterial" });
  const bent = edge("bent", [point(0, 0), point(100, 0), point(100, 100)]);
  assert.equal(groundJunctionFindings([bent, edge("chord-only", [point(40, 40), point(60, 40)])]).length, 0);
  const crossing = edge("actual", [point(50, -10), point(50, 10)]);
  assert.equal(groundJunctionFindings([bent, crossing]).length, 1);
  assert.deepEqual(groundJunctionFindings([crossing, bent]), groundJunctionFindings([bent, crossing]));
  const returning = edge("returning", [point(0, 0), point(50, 5), point(50, -10)]);
  assert.equal(groundJunctionFindings([bent, returning]).length, 1, "shared origin does not authorize the distant unmodeled intersection");
}

// 同一几何分类器：已知答案与边反转/置换/刚体变换，接触不冒充拓扑接入。
{
  const p = (x, z) => ({ x, z });
  const cases = [
    [[p(0, 0), p(10, 0), p(5, -5), p(5, 5)], "interior-crossing", 0],
    [[p(0, 0), p(10, 0), p(5, 0), p(5, 5)], "endpoint-on-edge", 0],
    [[p(0, 0), p(10, 0), p(10, 0), p(10, 5)], "endpoint-contact", 0],
    [[p(0, 0), p(10, 0), p(5, 0), p(15, 0)], "collinear-overlap", 0],
    ...[0.02, 0.16, 0.5].map((gap) => [[p(0, 0), p(10, 0), p(10 + gap, 0), p(20 + gap, 0)], "endpoint-near-node", gap]),
    [[p(0, 0), p(10, 0), p(5, 0.16), p(5, 5)], "endpoint-near-edge", 0.16],
    [[p(0, 0), p(10, 0), p(0, 0.5), p(10, 0.5)], "parallel-near", 0.5],
    [[p(0, 0), p(10, 0), p(10.5001, 0), p(20, 0)], "separate", 0.5001],
    [[p(0, 0), p(10, 0), p(5, -1e-10), p(5, 1e-10)], "interior-crossing", 0],
  ];
  for (const [points, kind, distance] of cases) {
    const [a, b, c, d] = points;
    const variants = [points, [c, d, a, b], [b, a, d, c], points.map((q) => p(-q.z + 100, q.x - 50))];
    for (const variant of variants) {
      const r = classifyRoadSegments(...variant);
      assert.equal(r.kind, kind);
      assert.ok(Math.abs(r.distance - distance) < 1e-8);
      assert.ok(r.a.t >= 0 && r.a.t <= 1 && r.b.t >= 0 && r.b.t <= 1);
    }
  }
  assert.equal(classifyRoadSegments(p(NaN, 0), p(10, 0), p(5, 0), p(5, 5)).kind, "invalid");
  assert.equal(classifyRoadSegments(p(0, 0), p(10, 0), p(5, 0), p(5, 5), -1).kind, "invalid");
  const overlap = classifyRoadSegments(p(0, 0), p(10, 0), p(15, 0), p(5, 0));
  assert.deepEqual(overlap.overlap, { a: [0.5, 1], b: [1, 0.5] });
  const findings = groundJunctionFindings([
    { id: "a", from: "0:0", to: "10:0", points: [p(0, 0), p(10, 0)], width: 5, kind: "local" },
    { id: "b", from: "10.16:0", to: "20:0", points: [p(10.16, 0), p(20, 0)], width: 5, kind: "local" },
  ]);
  assert.equal(findings[0].relation, "endpoint-near-node");
  assert.equal(findings[0].distance, 0.16);
}

// 求解中的一般路口接线必须同时精化既有路径；不能新增地块压路。
{
  const w = makeWorld();
  addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 100, z: 0 }, true);
  addNetworkEdge(w.network, { x: 0, z: -100 }, { x: 0, z: 100 }, false);
  const ctx = { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [], landmarks: [], blocks: [],
    carPaths: [[{ x: -100, z: 0 }, { x: 100, z: 0 }]], coastRoadRuns: [], riverRoadRuns: [] };
  assert.equal(normalizeGroundJunctions(ctx).changes, 1);
  assert.deepEqual(ctx.carPaths[0], [{ x: -100, z: 0 }, { x: 0, z: 0 }, { x: 100, z: 0 }]);
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 0);
  assert.equal(normalizeGroundJunctions(ctx).changes, 0);
}

// J：同一地点多条道路原子并网，精确 T 口和折线使用实际路段。
{
  const six = (reverse = false) => {
    const w = makeWorld();
    const pairs = [[{ x: -100, z: 0 }, { x: 100, z: 0 }], [{ x: -50, z: -86.6 }, { x: 50, z: 86.6 }], [{ x: -50, z: 86.6 }, { x: 50, z: -86.6 }]];
    for (const [a, b] of reverse ? [...pairs].reverse() : pairs) addNetworkEdge(w.network, a, b, true);
    return w;
  };
  const w = six(); assert.equal(connectGroundJunctions(w).connected, 1);
  assert.equal(w.network.version, 1, "all six legs publish in one transaction");
  assert.equal(w.network.edges.size, 6);
  assert.equal([...w.network.edges.values()].filter((e) => e.from === "0:0" || e.to === "0:0").length, 6);
  const reversed = six(true); connectGroundJunctions(reversed);
  const digest = (n) => JSON.stringify([...n.edges.values()].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(digest(reversed.network), digest(w.network));
  assert.equal(connectGroundJunctions(w).connected, 0);
  const tee = makeWorld();
  addNetworkEdge(tee.network, { x: -100, z: 0 }, { x: 100, z: 0 }, true);
  addNetworkEdge(tee.network, { x: 0, z: -100 }, { x: 0, z: 0 }, false);
  assert.equal(connectGroundJunctions(tee).connected, 1);
  assert.equal(tee.network.edges.size, 3);
  const crossingAtAngle = (degrees) => {
    const w = makeWorld();
    const angle = degrees * Math.PI / 180;
    addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 100, z: 0 }, true);
    addNetworkEdge(w.network, { x: -100 * Math.cos(angle), z: -100 * Math.sin(angle) }, { x: 100 * Math.cos(angle), z: 100 * Math.sin(angle) }, true);
    return w;
  };
  const guardBandCrossing = crossingAtAngle(32);
  const frozenGuardBand = snap(guardBandCrossing.network);
  assert.equal(connectGroundJunctions(guardBandCrossing).connected, 0, "30–35 degree crossings require dedicated turning geometry under the residual SPEC");
  assert.equal(snap(guardBandCrossing.network), frozenGuardBand);
  const acuteCrossing = crossingAtAngle(29), frozenAcuteCrossing = snap(acuteCrossing.network);
  assert.equal(connectGroundJunctions(acuteCrossing).connected, 0, "crossings below the ordinary 35 degree contract remain declined");
  assert.equal(snap(acuteCrossing.network), frozenAcuteCrossing);
  const unsafeTee = makeWorld({ sites: [{ x: 0, z: -70, radius: 10 }] });
  addNetworkEdge(unsafeTee.network, { x: -100, z: 0 }, { x: 100, z: 0 }, true);
  addNetworkEdge(unsafeTee.network, { x: 0, z: -100 }, { x: 0, z: 0 }, false);
  const frozenTee = snap(unsafeTee.network);
  const declinedTee = connectGroundJunctions(unsafeTee);
  assert.equal(declinedTee.connected, 0, "T branch must be physically checked even when only its host is split");
  assert.ok(declinedTee.declined.some(({ node, reason }) => node === "0:0" && /participant corridor unsafe \(site-clearance\) on /.test(reason)), "declined junctions must identify the exact physical guard and road edge");
  assert.equal(snap(unsafeTee.network), frozenTee);
  const bent = makeWorld();
  addNetworkEdge(bent.network, { x: -100, z: 0 }, { x: 0, z: 100 }, true);
  [...bent.network.edges.values()][0].points = [{ x: -100, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 100 }];
  addNetworkEdge(bent.network, { x: -50, z: 50 }, { x: 50, z: 50 }, false);
  assert.equal(connectGroundJunctions(bent).connected, 1);
  assert.ok(connected(bent.network, "-100:0", "50:50"));
  assert.ok([...bent.network.edges.values()].some((e) => e.points.length === 3 && e.points[1].x === 0 && e.points[1].z === 0));
}

// A crossing whose original junction falls on an unsafe slope must be routed
// around, not joined by weakening the corridor contract.
{
  const w = makeWorld({ slopeDisc: { x: 0, z: 0, r: 14, value: 2 } });
  addNetworkEdge(w.network, { x: -100, z: 0 }, { x: 100, z: 0 }, true);
  addNetworkEdge(w.network, { x: 0, z: -100 }, { x: 0, z: 100 }, false);
  const ctx = { network: w.network, geo: w.geo, inRiver: w.inRiver, publicSites: [], landmarks: [], blocks: [],
    carPaths: [], coastRoadRuns: [], riverRoadRuns: [], coastRoadRunEnds: [], connectionLog: [] };
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 1);
  const reroute = rerouteUnsafeGroundCrossings(ctx);
  assert.equal(reroute.changes, 1, `safe reroute should go around the crossing/slope: ${reroute.reason ?? ""}`);
  assert.equal(groundJunctionFindings([...w.network.edges.values()]).length, 0, "reroute removes the unsafe planar crossing");
  assert.ok([...w.network.edges.values()].some((edge) => edge.points.length === 2 && edge.width === 5), "replacement retains the original local-road width");
}

// J：地面交叉真实并网，宿主属性继承，多次拆边确定；桥/不安全走廊保持原图。
{
  const build = (reverse = false, blocked = false, bridge = false) => {
    const w = makeWorld({ sites: blocked ? [{ x: 0, z: 0, radius: 10 }] : [] });
    const links = [[{ x: -100, z: 0 }, { x: 100, z: 0 }], [{ x: 0, z: -100 }, { x: 0, z: 100 }], [{ x: 50, z: -100 }, { x: 50, z: 100 }]];
    for (const [a, b] of reverse ? [...links].reverse() : links) addNetworkEdge(w.network, a, b, true, bridge);
    return w;
  };
  const w = build();
  const report = connectGroundJunctions(w);
  assert.equal(report.connected, 2, "multiple intersections split the current host, not a removed original edge");
  assert.equal(w.network.edges.size, 7);
  assert.ok(connected(w.network, "-100:0", "50:100"), "crossing roads must now share graph nodes");
  for (const id of ["0:0", "50:0"]) assert.equal([...w.network.edges.values()].filter((e) => e.from === id || e.to === id).length, 4);
  const paint = roadPaintPlan([...w.network.edges.values()]);
  for (const id of ["0:0", "50:0"]) assert.ok(paint.junctions.has(id), "render geometry must consume the same shared junction nodes");
  assert.ok([...w.network.edges.values()].every((e) => e.width === 8 && e.kind === "arterial"));
  const reversed = build(true); connectGroundJunctions(reversed);
  const digest = (world) => JSON.stringify([...world.network.edges.values()].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(digest(reversed), digest(w), "junction topology must not depend on enumeration order");
  assert.equal(connectGroundJunctions(w).connected, 0, "normalization is idempotent");
  for (const world of [build(false, true), build(false, false, true)]) {
    const before = snap(world.network);
    assert.equal(connectGroundJunctions(world).connected, 0);
    assert.equal(snap(world.network), before, "unsupported/unsafe intersections have zero side effects");
  }
}

// 提交期复核：提案之后出现的新障碍不能靠门路用途免查；拒绝时正式图不变。
{
  const blockers = [];
  const w = makeWorld({ sites: blockers });
  addNetworkEdge(w.network, { x: -40, z: 150 }, { x: 40, z: 150 }, true);
  const proposed = proposeConnection(request({ purpose: "site-access", allowBridge: true }), w,
    { strategies: ["bridge-candidate"], bridge: { blockers }, crossings: false });
  assert.ok(proposed.ok, "gate proposal starts with a clear corridor");
  blockers.push({ x: 0, z: 75, radius: 10 });
  const frozen = snap(w.network);
  const committed = commitConnection(w, proposed);
  assert.ok(!committed.ok && /site-clearance/.test(committed.detail), "gate revalidates blockers before commit");
  assert.equal(snap(w.network), frozen);
}

// 预留数组整体替换也必须失效；不能只对同一数组 push 的反例有效。
for (const bridge of [false, true]) {
  let current = [];
  const w = makeWorld(); w.reservations = () => current;
  addNetworkEdge(w.network, { x: -40, z: 150 }, { x: 40, z: 150 }, true);
  const proposal = proposeConnection(request({ purpose: bridge ? "site-access" : "district-access", allowBridge: bridge }), w,
    bridge ? { strategies: ["bridge-candidate"], bridge: { blockers: [] } } : { strategies: ["direct-projection"] });
  assert.ok(proposal.ok);
  current = [{ x: 0, z: 75, radius: 10 }];
  const before = snap(w.network);
  assert.ok(!commitConnection(w, proposal).ok, "commit must query current reservations, not a detached proposal array");
  assert.equal(snap(w.network), before);
}

// 桥跨提出阶段也消费全路幅：中心线干地、侧缘水塘应产生 deck 而不是反复提出非法引道。
{
  const self = { id: "entrance-owner", x: 0, z: -20, radius: 5 };
  const w = makeWorld({ sites: [self] });
  addNetworkEdge(w.network, { x: -40, z: 150 }, { x: 40, z: 150 }, true);
  const proposal = proposeConnection(request({ purpose: "site-access", allowBridge: true }), w,
    { strategies: ["bridge-candidate"], bridge: { self, blockers: [] } });
  assert.ok(proposal.ok);
  self.x = 20;
  const before = snap(w.network);
  const result = commitConnection(w, proposal);
  assert.ok(!result.ok && /owner moved/.test(result.detail), "owner mutation invalidates the old entrance proposal");
  assert.equal(snap(w.network), before);
}

// 桥跨提出阶段也消费全路幅：中心线干地、侧缘水塘应产生 deck 而不是反复提出非法引道。
{
  const w = makeWorld();
  w.geo.height = (x, z) => Math.abs(x) < 10 && z > 1 ? -1 : 2;
  addNetworkEdge(w.network, { x: 80, z: -50 }, { x: 80, z: 50 }, true);
  const r = runConnection(request({ source: { x: -80, z: 0 }, allowBridge: true, roadClass: "arterial" }), w, { strategies: ["bridge-candidate"] });
  assert.ok(r.ok && r.bridgeSpans.length === 1, `full-width wet analysis must find a legal deck: ${JSON.stringify(r)}`);
  assert.ok(r.patch.addEdges.some((e) => e.bridge));
}

// 宽度必须跟实际加边一致：collector、桥候选引道、固定主干全部拒绝侧缘压入安全余量。
for (const mode of ["collector", "bridge", "fixed"]) {
  const w = makeWorld({ sites: [{ x: 15, z: 75, radius: 10 }] });
  addNetworkEdge(w.network, { x: 0, z: 150 }, { x: 100, z: 150 }, true);
  const frozen = snap(w.network);
  const r = mode === "fixed"
    ? commitFixedLink(w, [{ a: { x: 0, z: 0 }, b: { x: 0, z: 150 }, arterial: true, primary: true }])
    : runConnection(request({ roadClass: mode === "collector" ? "collector" : "arterial", target: { kind: "node", id: "0:150" }, allowBridge: mode === "bridge" }), w,
      mode === "collector" ? { strategies: ["node-merge"], siteMargin: 2 } : { strategies: ["bridge-candidate"], bridge: { blockers: w.reservations() } });
  assert.ok(!r.ok, `${mode} must reject full-width site overlap`);
  assert.equal(snap(w.network), frozen);
}

// 道路侧缘地形、采样间的小预留，以及 crossings:false 均不能绕过终筛。
{
  const w = makeWorld();
  const p = { requireBuildable: false, maxSlope: 0.9, sites: [], siteMargin: 0, roadWidth: 12 };
  w.geo.height = (x) => Math.abs(x) > 3 ? -1 : 2;
  assert.equal(corridorFailure(w, { x: 0, z: 0 }, { x: 0, z: 100 }, p), "water-span", "road side in water is rejected");
  w.geo.height = () => 2;
  w.geo.terrain.slope = (x) => Math.abs(x) > 3 ? 2 : 0;
  assert.equal(corridorFailure(w, { x: 0, z: 0 }, { x: 0, z: 100 }, p), "slope", "road side on steep terrain is rejected");
  w.geo.terrain.slope = () => 0;
  assert.equal(corridorFailure(w, { x: 0, z: 0 }, { x: 0, z: 4 }, { ...p, roadWidth: 0, sites: [{ x: 0, z: 2, radius: 0.1 }] }), "site-clearance", "exact capsule test sees obstacles between samples");
  addNetworkEdge(w.network, { x: -100, z: 50 }, { x: 100, z: 50 }, true);
  for (const kind of ["deck", "ground-approach"]) {
    const r = validateCandidate(w, w.network, { id: kind, crossings: false, blockers: [], gate: true,
      segments: [{ a: { x: 0, z: 0 }, b: { x: 0, z: 100 }, kind, width: 5 }] }, { roadPolicy: p });
    assert.ok(!r.ok && r.violations.some((v) => v.kind === (kind === "deck" ? "vertical-clearance-unsupported" : "crossing")), "crossing switch cannot bypass validation");
  }
}

// (i6) 宽道路侧缘压楼（批 A2 胶囊口径）：次干（宽 8）中心线离用地盘 r+3（旧中心线口径的
//      fallback margin 恰好放行），但侧缘再进 4 个单位压进盘内——胶囊口径拒 site-clearance，零副作用。
{
  const w = makeWorld({ sites: [{ x: 0, z: 100, radius: 20 }] });
  addNetworkEdge(w.network, { x: 0, z: 0 }, { x: 0, z: -60 }, false);
  addNetworkEdge(w.network, { x: -100, z: 123 }, { x: 100, z: 123 }, true);
  const frozen = snap(w.network);
  const r = runConnection(request({ id: "wide-crush", roadClass: "arterial", maxLength: 300 }), w, { strategies: ["direct-projection"] });
  assert.ok(!r.ok && r.reason === "site-clearance", `wide arterial edge crushing the site must be refused: ${JSON.stringify(r)}`);
  assert.equal(snap(w.network), frozen, "refused wide road mutated the network");
}

console.log("City connect: direct projection with attribute-preserving splits, node merge, coincident parallel-leg merge preserving branches/owners/traffic, site detour, bounded grid A* (heading state, expansion budget), search-budget/no-target/stale-base failures with zero side effects, primary-component targeting, explicit ground-bridge-ground candidates (narrow river only), fold-back endpoints refused, slope discs detoured, mini-roundabout rings dissolving acute 3-way junctions (radius ladder, corridor-checked arcs, guard-level angles, zero side effects), unified batch-A final screen (steep dry/river-bank approaches refused, gate clipping other sites refused, conflicting fixed decks refused with vertical-clearance cause, gentle unbuildable beachfront passes, wide-road envelope clearance), deterministic.");
