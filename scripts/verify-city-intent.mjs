#!/usr/bin/env node
// 意图层只读诊断守卫（CITY_NETWORK_FIRST_CODE_DESIGN 迁移批次 2）：
//   (a) 主网定义成立：primaryComponentId 存在且覆盖大部分节点（含 civic/plaza 骨架）；
//   (b) 检测完整：每个度为 1 的非桥路端都有角色，没有 null/未分类；
//   (c) 每个 required demand 有满足布尔与原因；unmet 只作影子指标输出（本批不 gating 质量）；
//   (d) 零副作用：诊断前后 plan 深比较完全一致（设计 §5A-7 拒绝的候选不得修改正式网络）；
//   (e) 确定性：同输入两次诊断结果完全一致。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { createCityPlan, MIAMI_COASTAL, diagnoseNetwork, componentOf, preserveDemandPaths, preserveDisplayJunctions, retainBridgeLandings, CONSTRAINTS, roadReport } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/constraints.ts": ["CONSTRAINTS"],
  "engine/planner/intent.ts": ["diagnoseNetwork", "componentOf"],
  "engine/planner/retention.ts": ["preserveDemandPaths", "preserveDisplayJunctions", "retainBridgeLandings"],
  "engine/planner/report.ts": ["roadReport"],
});
const ISLANDS = [[1, 0, null], [2, 3, MIAMI_COASTAL], [5, 7, MIAMI_COASTAL], [1, 11, null], [2, 13, MIAMI_COASTAL], [5, 17, null], [3, 21, MIAMI_COASTAL], [2, 23, MIAMI_COASTAL]];
// 展示保路使用长度而不是边数，走完整规划图（允许穿过已保留的中间分量），不改变原边。
{
  const node = (id, x, z) => ({ id, x, z });
  const a = node("a", 0, 0); const b = node("b", 10, 0); const c = node("c", 20, 0); const d = node("d", 30, 0); const far = node("far", 0, 100); const e = node("e", 40, 0);
  const edge = (p, q) => ({ id: [p.id, q.id].sort().join("/"), from: p.id, to: q.id, width: 5, kind: "local", points: [p, q] });
  const roads = [edge(a, far), edge(far, d), edge(a, b), edge(b, c), edge(c, d), edge(d, e)];
  const selected = new Set([edge(b, c).id, edge(d, e).id]);
  const before = JSON.stringify(roads);
  const first = preserveDemandPaths(roads, selected, "a", ["d", "e", "missing"]);
  assert.deepEqual(first.restored, ["a/b", "c/d"]);
  assert.deepEqual(first.unresolved, ["missing"]);
  assert.equal(JSON.stringify(roads), before);
  assert.deepEqual([...selected].sort(), ["b/c", "d/e"]);
  const second = preserveDemandPaths([...roads].reverse(), selected, "a", ["missing", "e", "d"]);
  assert.deepEqual([...first.keep].sort(), [...second.keep].sort());
  assert.deepEqual(second.unresolved, first.unresolved);
  assert.ok(preserveDemandPaths(roads, selected, "absent", ["d"]).anchorMissing);
  assert.equal(preserveDemandPaths(roads, first.keep, "a", ["d", "e"]).restored.length, 0);
}
const shadow = [];
// 裁剪不能把环路变成两个断头；只恢复最短缺失路径，合法尽端维持裁剪。
{
  const point = (id, x, z) => ({ id, x, z });
  const a = point("a", 0, 0), b = point("b", 10, 0), c = point("c", 10, 10), d = point("d", 0, 10), far = point("far", 100, 100);
  const edge = (p, q) => ({ id: `${p.id}/${q.id}`, from: p.id, to: q.id, width: 5, kind: "local", points: [p, q] });
  const roads = [edge(a, b), edge(b, c), edge(c, d), edge(d, a), edge(a, far), edge(far, c)];
  const selected = new Set(["a/b", "b/c"]), frozen = JSON.stringify(roads);
  const closure = preserveDisplayJunctions(roads, selected, new Set());
  assert.deepEqual(closure.restored, ["c/d", "d/a"]);
  assert.deepEqual(closure.unresolved, []);
  assert.equal(JSON.stringify(roads), frozen);
  assert.deepEqual([...selected], ["a/b", "b/c"]);
  assert.deepEqual([...preserveDisplayJunctions([...roads].reverse(), selected, new Set()).keep].sort(), [...closure.keep].sort());
  assert.equal(preserveDisplayJunctions(roads, closure.keep, new Set()).restored.length, 0);
  assert.equal(preserveDisplayJunctions(roads, selected, new Set(["a", "c"])).restored.length, 0);
  const branch = preserveDisplayJunctions([edge(a, b), edge(b, c)], new Set(["a/b"]), new Set());
  assert.deepEqual(branch.restored, ["b/c"], "acyclic pruning restores the existing road to its original terminal");
  assert.deepEqual(branch.unresolved, []);
  const tail = point("tail", -10, 0);
  const attachedLoop = [edge(tail, a), edge(a, b), edge(b, c), edge(c, a)];
  const cycle = preserveDisplayJunctions(attachedLoop, new Set(["tail/a"]), new Set());
  assert.deepEqual(cycle.restored, ["a/b", "b/c", "c/a"], "a hidden loop can return to its sole retained attachment");
  assert.deepEqual(cycle.unresolved, []);
}
// 非桥子图 degree=1 的连续桥头有独立角色；近旁地面边不能充当真实接驳。
{
  const node = (x) => ({ x, z: 0, id: `${x}:0` });
  const a = node(-200), b = node(0), c = node(100), d = node(300);
  const road = (p, q, bridge = false) => ({ id: `${p.id}/${q.id}`, from: p.id, to: q.id, points: [p, q], width: 8, kind: "arterial", bridge });
  const plan = { roadNodes: [a, b, c, d], roadEdges: [road(a, b), road(b, c, true), road(c, d)], primaryAnchorNodeId: a.id,
    publicSites: [], landmarks: [], blocks: [], core: a, coast: [], river: null, coastRoads: [], riverRoadRuns: [], seaside: null };
  const measure = (id, p) => CONSTRAINTS.find((constraint) => constraint.id === id).measure(p);
  assert.equal(measure("looseInlandRoadEnds", plan).length, 2, "two actual road ends remain; bridge transitions are continuous");
  assert.equal(measure("bridgeheadContinuity", plan).length, 0);
  const endpoints = diagnoseNetwork(plan).endpoints;
  assert.equal(endpoints.filter((e) => e.role.kind === "bridge-landing").length, 2);
  assert.equal(endpoints.filter((e) => e.role.kind === "must-connect").length, 2);
  const report = roadReport({ ...plan, layer: "plan", nodes: plan.roadNodes });
  assert.equal(report.graph.degree1.bridgeLandings, 2);
  assert.equal(report.graph.degree1.unclassified, 2);
  const near = node(100.01);
  const gap = { ...plan, roadNodes: [...plan.roadNodes, near], roadEdges: [road(a, b), road(b, c, true), road(near, d)] };
  assert.equal(measure("bridgeheadContinuity", gap).length, 1, "nearby coordinates do not hide a detached bridgehead");
  assert.equal(measure("disconnectedComponents", gap).length, 1);
  assert.equal(diagnoseNetwork(gap).endpoints.filter((e) => e.role.kind === "bridge-landing").length, 1);
}
// 保留桥的两个端点并不自动保留地面引道；相接桥也不能充当地面边。
{
  const node = (id, x) => ({ id, x, z: 0 });
  const a = node("a", 0), b = node("b", 10), c = node("c", 20), d = node("d", 30), gate = node("gate", -5);
  const edge = (p, q, bridge = false) => ({ id: `${p.id}/${q.id}`, from: p.id, to: q.id, points: [p, q], width: 5, kind: "local", bridge });
  const roads = [edge(a, b, true), edge(b, c, true), edge(c, d), edge(gate, a), edge(b, d)];
  const selected = new Set(["a/b", "b/c"]), before = JSON.stringify(roads);
  const landings = retainBridgeLandings(roads, selected);
  assert.deepEqual([...landings.selected].sort(), ["a/b", "b/c", "b/d", "c/d", "gate/a"]);
  assert.deepEqual(landings.missing, []);
  assert.deepEqual([...retainBridgeLandings([...roads].reverse(), selected).selected].sort(), [...landings.selected].sort());
  assert.equal(JSON.stringify(roads), before);
  assert.deepEqual([...selected], ["a/b", "b/c"]);
  assert.deepEqual(retainBridgeLandings(roads.filter((e) => e.id !== "gate/a"), selected).missing, ["a"]);
  // 即使活动区选择没有门前边，设施 gate 必须作为需求恢复到主网。
  const retained = preserveDemandPaths(roads, new Set(["c/d"]), "d", ["gate"]);
  assert.ok(retained.keep.has("gate/a"));
}
for (const [tier, i, cfg] of ISLANDS) {
  const seed = 1703294958 + i * 7919;
  const plan = createCityPlan(seed, tier, cfg);
  const frozen = JSON.stringify([plan.roadNodes, plan.roadEdges, plan.publicSites, plan.landmarks, plan.coastRoads]);
  const d1 = diagnoseNetwork(plan);
  assert.ok(d1, `seed ${seed}: primary component missing (civic skeleton absent)`);
  assert.ok(plan.demandCatalogue?.length, "production diagnostics must consume a persistent catalogue");
  for (const demand of plan.demandCatalogue) assert.ok(d1.demands.some((entry) => entry.demand.id === demand.id), "retained promises cannot disappear from the final verdicts");
  assert.equal(JSON.stringify([plan.roadNodes, plan.roadEdges, plan.publicSites, plan.landmarks, plan.coastRoads]), frozen, `seed ${seed}: diagnostics mutated the plan`);
  const d2 = diagnoseNetwork(plan);
  assert.equal(JSON.stringify(d2), JSON.stringify(d1), `seed ${seed}: diagnostics not deterministic`);
  assert.ok(d1.endpoints.length > 0 && d1.endpoints.every((e) => e.role && e.role.kind), `seed ${seed}: an endpoint has no role`);
  assert.ok(d1.demands.every((x) => typeof x.satisfied === "boolean"), `seed ${seed}: a demand lacks a verdict`);
  if (seed === 1703461257 && tier === 3) {
    assert.ok(!d1.unmet.some((entry) => entry.demandId.startsWith("district:")
      || entry.demandId === "site:landmark:lighthouse" || entry.demandId === "coastal:3"),
    "isolated waterfront component, lighthouse and coast-run obligations must stay satisfied");
    // Generation can now prevent the isolated component before solve. Only
    // demand repair attribution when the unsolved plan is the same-size world
    // and actually contains the district defect; never force a bad raw graph.
    const raw = createCityPlan(seed, tier, cfg, { skipSolve: true });
    if (raw.islandRadius === plan.islandRadius && diagnoseNetwork(raw).unmet.some((entry) => entry.demandId.startsWith("district:"))) {
      assert.ok(plan.solveReport.some((entry) => entry.name === "connectDisconnectedComponents" && entry.changes > 0),
        "a same-world component repair must be attributed, not hidden by demand removal");
    }
    assert.ok(d1.demands.some((entry) => entry.demand.id === "site:landmark:lighthouse" && entry.satisfied));
    assert.ok(d1.demands.some((entry) => entry.demand.id === "coastal:3" && entry.satisfied));
  }
  for (const endpoint of d1.endpoints) if (endpoint.role.kind === "must-connect") {
    assert.ok(d1.demands.some((entry) => entry.demand.id === endpoint.role.demandId),
      `seed ${seed}: required endpoint ${endpoint.node} refers to a missing demand`);
  }
  // 主网骨架证据：primary 分量必须包含离 core ≤ 60 的节点（环岛半径 52 + 余量）——
  // 防「离 core 最近的节点恰是被孤立的 spur」选错分量（设计：主网 = 含 civic/plaza 骨架的分量）。
  const comp = componentOf(plan);
  const nearCoreIds = plan.roadNodes.filter((n) => Math.hypot(n.x - plan.core.x, n.z - plan.core.z) <= 60).map((n) => n.id);
  assert.ok(nearCoreIds.some((id) => comp.get(id) === d1.primaryComponentId), `seed ${seed}: primary component carries no plaza-ring node`);
  // 独立重数：度为 1 的非桥端总数必须与诊断的 endpoints 数一致（classifyEndpoints 静默跳过的
  // 节点记录缺失会被此处抓到）。
  const deg1 = new Map();
  for (const e of plan.roadEdges) if (!e.bridge) for (const id of [e.from, e.to]) deg1.set(id, (deg1.get(id) || 0) + 1);
  const degree1Count = [...deg1.entries()].filter(([id, d]) => d === 1 && plan.roadNodes.some((n) => n.id === id)).length;
  assert.equal(d1.endpoints.length, degree1Count, `seed ${seed}: endpoint classification incomplete (${d1.endpoints.length} of ${degree1Count})`);
  assert.ok(d1.unmet.every((u) => u.reason && u.demandId), `seed ${seed}: an unmet demand lacks a reason`);
  shadow.push(`${seed}/t${tier}: endpoints ${d1.endpoints.length} (must-connect ${d1.endpoints.filter((e) => e.role.kind === "must-connect").length}), unmet ${d1.unmet.length}${d1.unmet.length ? ` [${d1.unmet.slice(0, 3).map((u) => u.demandId).join(", ")}]` : ""}`);
}
// 评审 P1-2 反例：车站旁只有孤立环路 → site-access 必须 unmet（曾误报满足）
{
  const node = (x, z, id) => ({ x, z, id: id ?? `${x}:${z}` });
  const road = (a, b) => ({ id: [a.id, b.id].sort().join("/"), from: a.id, to: b.id, width: 5, kind: "local", points: [a, b], bridge: false });
  const primaryA = node(0, 0, "p1"); const primaryB = node(100, 0, "p2"); const lonelyA = node(300, 200, "l1"); const lonelyB = node(320, 220, "l2");
  const fakePlan = {
    roadNodes: [primaryA, primaryB, lonelyA, lonelyB],
    roadEdges: [road(primaryA, primaryB), road(lonelyA, lonelyB)],
    publicSites: [{ id: "station-x", kind: "station", x: 310, z: 210, radius: 30 }],
    landmarks: [], blocks: [], terrain: { height: () => 5 },
    seaside: null, coast: [node(-500, -500), node(500, -500), node(500, 500)], river: null,
    core: node(50, 0), coastRoads: [[lonelyA, lonelyB]], riverRoadRuns: [],
  };
  const dd = diagnoseNetwork(fakePlan);
  const station = dd.demands.find((x) => x.demand.id === "site:station-x");
  assert.ok(station && !station.satisfied && /no road within|not on the primary network/.test(station.reason ?? ""), `isolated-road door must be unmet, got ${JSON.stringify(station)}`);
  const anchored = { ...fakePlan, primaryAnchorNodeId: "p1", core: lonelyA };
  assert.equal(diagnoseNetwork(anchored).primaryComponentId, componentOf(anchored).get("p1"), "nearer isolated road cannot replace the skeleton anchor");
  assert.equal(diagnoseNetwork({ ...anchored, primaryAnchorNodeId: "missing" }), null, "missing declared anchor fails explicitly");
  const plot = { id: "station-x", kind: "station", x: 50, z: 10, radius: 30, yaw: 0,
    access: { role: "plot-gate", nodeId: "p1", ownerX: 50, ownerZ: 10, ownerYaw: 0 } };
  const declared = { ...anchored, publicSites: [plot], siteObligations: [{ ownerId: "unplaced", placed: false, reason: "all joint candidates refused" }] };
  const diagnostics = diagnoseNetwork(declared);
  assert.ok(diagnostics.demands.find((d) => d.demand.id === "site:station-x").satisfied);
  assert.ok(diagnostics.unmet.some((d) => d.demandId === "site:unplaced"), "unplaced required facilities must not disappear from the demand denominator");
  for (const site of [{ ...plot, x: 51 }, { ...plot, access: { ...plot.access, nodeId: "missing" } }]) {
    const result = diagnoseNetwork({ ...declared, publicSites: [site] });
    assert.ok(!result.demands.find((d) => d.demand.id === "site:station-x").satisfied, "nearby roads cannot override a moved/detached declared entrance");
  }
  const nearBoth = { ...anchored, publicSites: [{ id: "station-x", kind: "station", x: 50, z: 10, radius: 30 }],
    roadNodes: [...fakePlan.roadNodes, node(40, 10, "s1"), node(60, 10, "s2")],
    roadEdges: [...fakePlan.roadEdges, road(node(40, 10, "s1"), node(60, 10, "s2"))] };
  for (const roadEdges of [nearBoth.roadEdges, [...nearBoth.roadEdges].reverse()]) {
    const d = diagnoseNetwork({ ...nearBoth, roadEdges });
    assert.ok(d.demands.find((x) => x.demand.id === "site:station-x").satisfied, "nearer isolated road must not hide a qualifying primary road");
  }
}

console.log(`City intent diagnostics: ${ISLANDS.length} islands — every degree-1 endpoint classified, every required demand verdicted, read-only and deterministic.`);
console.log(`  ${shadow.join(" | ")}`);
