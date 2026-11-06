#!/usr/bin/env node
// 规划修复补丁守卫（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §10，M1 首批）：
//   (a) 确定性：同输入两次套用逐字段相等；buildingMoves 条目倒序结果不变，roadOps 按日志顺序；
//   (b) 移楼叠套是 no-op（节点/删路不承诺叠套——补丁只套在底层布局上，见 planPatch.ts 契约）；
//   (c) 建筑移动：换 slot 重算地面高度；目标缺失/被占/被预留 → stale 如实上报，布局不动；
//   (d) 锁定口径：桥（bridge/deck/ground-approach）与滨海段（waterfront）的节点不可移、边不可删；
//   (e) 节点移动：按新坐标重挂节点 id、边引用与边 id；回车点跟随映射重筛（移动的尽端仍是尽端）；
//   (f) 删路段：孤立节点清掉、车流按新边对集过滤；缺失边 → stale；
//   (g) 编辑校验：occupied / missing / over-road / steep / not-buildable / highway / overlap 各一例，
//       桥面不算压路（与体检同一净空口径）；
//   (h) 体检：压路、楼楼占地相交、坡地、孤岛街区、patchStale 各命中且按 severity 排序，确定性输出；
//   (i) 节点撞车：拖到不动节点上 / 拖到相邻节点（零长边）/ 两条拖到同一点 → node-collision，无重复 id；
//   (j) 背景楼压制：部分生效时，其余不存在的 id 仍逐条上报；
//   (k) 套用与校验同一占用口径：目标地块有背景楼 → parcel-occupied（曾只看会话楼）；
//   (l) 存档宽容读取：null/错型字段不抛、单条坏条目丢弃、缺必填 → 整条丢弃；
//   (m) 道路日志按顺序重放：引用当前 id（移后再移、移后再删）、拆路段后再删其中一半、画路端点吸附（路口/路段中间/新建）、失败操作不留半截改动；
//   (n) 跨档位：整份补丁 tier-changed，布局不动；
//   (n2) 生成器换代（generatorVersion.ts）：整份 generator-changed、钉子不认、清除即空；新补丁带当前版本、
//        旧存档无版本按 1 读且指纹不变、坏版本值按缺省；跨档与换代同时发生时报 tier-changed（旧文案不变）；
//   (o) 真实城市：空补丁不改布局；占地重叠不误报（曾 1600 楼 1111 条）；layoutCity pins 让移楼在落位阶段生效、
//       空置街区随之长出路、刷新后不被新会话挤掉；pins=null / 跨档 pins 时落位与无 pins 一致；
//   (p) 拐角倒圆：从路尽头接着画并拐弯 → 拐点挪到弧中点、两段各带半段弧、切线连续；直行/回折/路口处不倒；
//   (q) 滨海景观带跟着滨海路走：擦掉滨海路 → 对应岸段景观带消失；画滨海大道 → 补一条加密的景观带折线；河岸路不补；
//   (r) 高架日志：画（含接到已有高架开口端，不多出匝道）、切（断成两条）、失效（切空处）、存档宽容读取、指纹兼容；
//   (s) 真实城市：画一条跨河高架、一段滨海大道，补丁干净重放；
//   (t) 改路型（路线图 P1-4）：目标状态幂等、id 不变、kind 随宽度、滨海景观带随 purpose 增撤、桥面/缺失如实失效、存档读回、
//       「一整段」沿度 2 路口走、遇岔路/换路型停；校验 unchanged/locked/提示码；
//   (u) 地面桥（路线图 P1-5）：一笔跨一段河 → 引道 + 桥面（bridge/deck）+ 引道，桥登记进 bridges；端点在水里/连跨两河 → road-in-water；
//       擦桥面 = 整座擦（多段桥面一起走、登记撤掉、引道变普通路；悬索桥塔缆一起拆）；画的桥两端到最近路口的直引道 ≥ 喇叭口伸出量且不陡；
//       水面太宽 → bridge-too-long；桥上不能有路口；桥面锁定；校验与重放同一个判定；
//   (v) 弧线路：起点 → 经过点 → 终点，铺成过经过点的折线（与校验同一条 curvePoints）；穿过现有路自动开路口并断开；
//       弯太急（按路型的最小半径）拒绝、过水拒绝（过河用直线架桥）；存档读回 via。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const {
  applyPlanPatch, validateBuildingMove, emptyPlanPatch, hashPlanPatch, edgeLocked, coercePlanPatch, appendRoadOp, layoutPinsFor,
  pruneStalePatch, patchGeneratorVersion, patchMatchesLayout, CITY_GENERATOR_VERSION,
  appendHighwayOp, filletAt, VIADUCT_DECK_WIDTH, VIADUCT_RAMP, validateHighwayAdd, validateRoadAdd, validateEdgeDrop, validateNodeMove, EXPRESSWAY_DECK_WIDTH, EXPRESSWAY_RAMP, roadRun, validateRestyle,
  curvePoints, polylineMinRadius, minCurveRadius, auditLayout, tagAuditOrigins, buildCityModel, createCityPlan, layoutCity, MIAMI_COASTAL,
} = await loadCity({
  "engine/planPatch.ts": ["applyPlanPatch", "validateBuildingMove", "emptyPlanPatch", "hashPlanPatch", "edgeLocked", "coercePlanPatch", "appendRoadOp", "layoutPinsFor", "appendHighwayOp", "filletAt", "VIADUCT_DECK_WIDTH", "VIADUCT_RAMP", "pruneStalePatch", "patchGeneratorVersion", "patchMatchesLayout", "CITY_GENERATOR_VERSION"],
  "engine/planRoadRules.ts": ["validateHighwayAdd", "validateRoadAdd", "validateEdgeDrop", "validateNodeMove", "roadRun", "validateRestyle"],
  "engine/planGeometry.ts": ["curvePoints", "polylineMinRadius", "minCurveRadius"],
  "engine/render/shared.ts": ["EXPRESSWAY_DECK_WIDTH", "EXPRESSWAY_RAMP"],
  "engine/planAudit.ts": ["auditLayout", "tagAuditOrigins"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});
const fresh = () => emptyPlanPatch(74031, 1);

// ── 合成城市 ──────────────────────────────────────────────────────────────────
// 岛半径 400（(500,500) 不可建）；坡地悬崖在 p2/p7；地面高度 x>50 处 +1（p3 高、p1 低，可断言换地重算）。
const height = (x, z) => (Math.hypot(x, z) < 400 ? 2 + (x > 50 ? 1 : 0) : -1);
const slope = (x, z) => (Math.hypot(x - 38, z - 60) < 10 || Math.hypot(x - 150, z - 150) < 10 ? 0.9 : 0.2);
const buildable = (x, z) => Math.hypot(x, z) < 380;
const terrain = { height, slope, buildable, center: { x: 0, z: 0 }, radius: 400, coastRadius: () => 400, hasRiver: false };
const parcel = (id, blockId, x, z, extra = {}) => ({ id, blockId, x, z, yaw: 0, zone: "residential", width: 8, depth: 8, ...extra });
const P1 = parcel("p1", "blkA", 30, 60);
const P2 = parcel("p2", "blkA", 38, 60);
const P3 = parcel("p3", "blkA", 54, 60);
const P4 = parcel("p4", "blkB", 300, 300);
const P5 = parcel("p5", "blkD", 50, -3);   // 压 e1（z=0 路面）
const P6 = parcel("p6", "blkE", 150, -3);  // 压 e2（桥面）
const P7 = parcel("p7", "blkF", 150, 150); // 坡地
const P8 = parcel("p8", "blkC", 500, 500); // 不可建
const P9 = parcel("p9", "blkG", 0, 20);    // 高架净空内
const edge = (id, from, to, width, points, extra = {}) => ({ id, from, to, width, kind: width >= 8 ? "arterial" : "local", points, ...extra });
const E1 = edge("0:0/100:0", "0:0", "100:0", 5, [{ x: 0, z: 0 }, { x: 100, z: 0 }]);
const E2 = edge("100:0/200:0", "100:0", "200:0", 12, [{ x: 100, z: 0 }, { x: 200, z: 0 }], { bridge: true, structure: "deck" });
const E3 = edge("0:0/0:100", "0:0", "0:100", 8, [{ x: 0, z: 0 }, { x: 0, z: 100 }], { purpose: "waterfront" });
const E4 = edge("100:0/100:100", "100:0", "100:100", 5, [{ x: 100, z: 0 }, { x: 100, z: 100 }]);

const model = {
  windowStartMs: 0, windowEndMs: 1, windowLabel: "t", generatedAt: 1,
  districts: [{ id: "d0", label: "D0", sessionCount: 4, tokensTotal: 0, activeCount: 0, anomaly: null }],
  buildings: [
    { id: "b1", districtId: "d0", footprint: 5, height: 20, archetype: "midrise" },
    { id: "b2", districtId: "d0", footprint: 10, height: 30, archetype: "tower" }, // 塔楼 10 宽（x∈[33,43]）→ 与 b1 占地相交
    { id: "b3", districtId: "d0", footprint: 5, height: 10, archetype: "block" },
    { id: "b4", districtId: "d0", footprint: 5, height: 10, archetype: "block" },
  ],
};

function makeLayout() {
  return {
    seed: 74031, scaleTier: 1, activityKey: "base",
    terrain,
    blocks: [
      { id: "blkA", districtId: "d0", x: 38, z: 60, width: 36, depth: 8, zone: "residential", parcels: [P1, P2, P3], polygon: [] },
      { id: "blkB", districtId: "d0", x: 300, z: 300, width: 8, depth: 8, zone: "residential", parcels: [P4], polygon: [] },
      { id: "blkC", districtId: "d0", x: 500, z: 500, width: 8, depth: 8, zone: "residential", parcels: [P8], polygon: [] },
      { id: "blkD", districtId: "d0", x: 50, z: -3, width: 8, depth: 8, zone: "residential", parcels: [P5], polygon: [] },
      { id: "blkE", districtId: "d0", x: 150, z: -3, width: 8, depth: 8, zone: "residential", parcels: [P6], polygon: [] },
      { id: "blkF", districtId: "d0", x: 150, z: 150, width: 8, depth: 8, zone: "residential", parcels: [P7], polygon: [] },
      { id: "blkG", districtId: "d0", x: 0, z: 20, width: 8, depth: 8, zone: "residential", parcels: [P9], polygon: [] },
    ],
    roadNodes: [
      { id: "0:0", x: 0, z: 0 }, { id: "100:0", x: 100, z: 0 }, { id: "200:0", x: 200, z: 0 },
      { id: "0:100", x: 0, z: 100 }, { id: "100:100", x: 100, z: 100 },
    ],
    roadEdges: [E1, E2, E3, E4],
    culDeSacEnds: [{ x: 100, z: 100 }],
    civics: [], gardens: [], districtLandmarks: [],
    contextBuildings: [{ id: "context:p6", x: 150, z: -3, y: 2, yaw: 0, width: 9, depth: 9, height: 10, seed: 0.5, zone: "residential", appearAt: 0 }],
    highways: [[{ x: -50, z: 20 }, { x: 250, z: 20 }]],
    districts: [{
      id: "d0", label: "D0", center: { x: 100, z: 100 }, radius: 300, terrain,
      slots: new Map([["b1", P1], ["b2", P2], ["b3", P4], ["b4", P5]]),
      grounds: new Map([["b1", 2], ["b2", 2], ["b3", 3], ["b4", 2]]),
      roads: [], carPaths: [[{ x: 0, z: 0 }, { x: 100, z: 0 }], [{ x: 100, z: 0 }, { x: 100, z: 100 }]],
      landValue: new Map([["b1", 0.5], ["b2", 0.5], ["b3", 0.2], ["b4", 0.5]]),
      river: null, riverHalfWidth: 18, trees: [], plaza: { x: 0, z: 0, y: 2 },
      anomaly: null, sessionCount: 4,
    }],
  };
}

/** 断言用快照：Map → 排序数组，只挑受补丁影响的字段。 */
const snap = (layout) => JSON.stringify({
  roadNodes: layout.roadNodes,
  roadEdges: layout.roadEdges,
  culDeSacEnds: layout.culDeSacEnds,
  contextIds: layout.contextBuildings.map((c) => c.id).sort(),
  activityKey: layout.activityKey,
  districts: layout.districts.map((d) => ({
    id: d.id,
    slots: [...d.slots].map(([b, p]) => [b, p.id]).sort(),
    grounds: [...d.grounds].sort(),
    carPaths: d.carPaths,
  })),
});

// Standard widths are checked before either preview or replay can split a host road.
{
  const from = { x: -200, z: -200 }, to = { x: -140, z: -200 };
  for (const width of [4.2, 10, 0, -1, NaN, Infinity]) {
    const layout = makeLayout();
    assert.deepEqual(validateRoadAdd(layout, model, from, to, width).blockers, ["non-standard-width"]);
    assert.deepEqual(validateRoadAdd(layout, model, from, to, width, undefined, [], { x: -170, z: -190 }).blockers, ["non-standard-width"]);
    assert.deepEqual(validateRestyle(layout, model, [E1.id], width).blockers, ["non-standard-width"]);
    for (const op of [{ t: "add", from, to, width }, { t: "restyle", edge: E1.id, width }]) {
      const patch = fresh(); patch.roadOps = [op];
      const result = applyPlanPatch(layout, patch);
      assert.deepEqual(result.stale.map((x) => x.reason), ["non-standard-width"]);
      assert.deepEqual(result.layout.roadEdges, layout.roadEdges, "invalid width must not alter existing roads");
      assert.deepEqual(result.layout.roadNodes, layout.roadNodes, "invalid width must not leave split nodes");
    }
  }
  for (const width of [5, 8, 12]) {
    const patch = fresh(); patch.roadOps = [{ t: "add", from, to, width }];
    const result = applyPlanPatch(makeLayout(), patch);
    assert.equal(result.stale.length, 0);
    assert.ok(result.layout.roadEdges.some((e) => e.width === width && e.points[0].x === from.x));
    patch.roadOps = [{ t: "restyle", edge: E1.id, width }];
    const restyled = applyPlanPatch(makeLayout(), patch);
    assert.equal(restyled.stale.length, 0);
    assert.equal(restyled.layout.roadEdges.find((e) => e.id === E1.id).width, width);
  }
  const saved = fresh(); saved.roadOps = [{ t: "add", from, to, width: 4.2 }, { t: "restyle", edge: E1.id, width: 10 }];
  assert.deepEqual(applyPlanPatch(makeLayout(), coercePlanPatch(saved)).stale.map((x) => x.reason), ["non-standard-width", "non-standard-width"], "imported edits obey the same entry rule");
  const legacy = makeLayout(); legacy.roadEdges = [{ ...E1, width: 4.2 }];
  assert.deepEqual(applyPlanPatch(legacy, fresh()).layout.roadEdges, legacy.roadEdges, "loading existing custom roads must not silently normalize them");
}

// (a) 确定性：同输入两次 → 相同；buildingMoves 条目倒序 → 相同；roadOps 顺序是语义（日志）。
{
  const patch = fresh();
  patch.buildingMoves = { b1: "p3", b2: "p9" };
  patch.roadOps = [{ t: "drop", edge: "100:0/100:100" }, { t: "add", from: { x: 100, z: 0 }, to: { x: 150, z: 50 }, width: 5 }];
  const reversed = { ...patch, buildingMoves: { b2: "p9", b1: "p3" } };
  const one = applyPlanPatch(makeLayout(), patch);
  const two = applyPlanPatch(makeLayout(), patch);
  assert.equal(snap(one.layout), snap(two.layout), "same input must yield identical layouts");
  assert.equal(JSON.stringify(one.stale), JSON.stringify(two.stale));
  assert.equal(snap(applyPlanPatch(makeLayout(), reversed).layout), snap(one.layout), "buildingMoves insertion order must not matter");
  assert.notEqual(hashPlanPatch(patch), hashPlanPatch({ ...patch, roadOps: [...patch.roadOps].reverse() }), "road op order is part of the fingerprint");
}

// (b) 移楼叠套 → 不动。
{
  const patch = fresh();
  patch.buildingMoves = { b1: "p3" };
  const once = applyPlanPatch(makeLayout(), patch);
  const twice = applyPlanPatch(once.layout, patch);
  assert.equal(snap(twice.layout), snap(once.layout), "re-applying building moves must be a no-op");
  assert.equal(twice.stale.length, 0, "building-move replay must not report stale entries");
}

// (c) 建筑移动：slot 换、地面高度重算（p3 在 x=54 → 高度 3）；失效条目 stale 且布局不动。
{
  const patch = fresh();
  patch.buildingMoves = { b1: "p3", b2: "missing-parcel", b3: "p1", ghost: "p3" };
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  const d0 = layout.districts[0];
  assert.equal(d0.slots.get("b1").id, "p3", "b1 must move to p3");
  assert.equal(d0.grounds.get("b1"), 3, "ground height must follow the new parcel terrain");
  assert.equal(d0.slots.get("b3").id, "p1", "a parcel vacated earlier in the same patch is claimable (b1 freed p1; sorted order b1 < b3)");
  assert.deepEqual(stale.map((s) => `${s.kind}:${s.reason}`).sort(), ["building-move:missing-parcel", "building-move:unknown-building"], "stale reasons must be exact");
}

// (d) 锁定口径（放权后 §15）：只锁桥面——桥端点不可移、不能从桥面中间接路（桥面可以整座擦，见 (u)）；
//     滨海路曾经一起锁，用户实测「很多东西都不能改」，现在可删可移。
{
  assert.ok(edgeLocked(E2), "a bridge deck is locked by construction");
  assert.ok(!edgeLocked(E3), "a waterfront road is editable now");
  const patch = fresh();
  patch.roadOps = [
    { t: "move", node: "100:0", to: { x: 120, z: 0 } },   // 100:0 连桥面 → 锁定
    { t: "add", from: { x: 150, z: 0 }, to: { x: 150, z: 40 }, width: 5 }, // 起点落在桥面中间 → 锁定
  ];
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  assert.equal(stale.length, 2, "every bridge-deck operation must be reported");
  assert.ok(stale.every((s) => s.reason === "locked-edge"));
  const base = makeLayout();
  assert.deepEqual(layout.roadNodes, base.roadNodes, "locked operations must not mutate nodes");
  assert.deepEqual(layout.roadEdges, base.roadEdges, "locked operations must not mutate edges");
  // 滨海路：删与移都生效。
  const coastal = fresh();
  coastal.roadOps = [{ t: "drop", edge: "0:0/0:100" }];
  const dropped = applyPlanPatch(makeLayout(), coastal);
  assert.equal(dropped.stale.length, 0); assert.ok(!dropped.layout.roadEdges.some((e) => e.id === "0:0/0:100"), "a waterfront road can be erased");
}

// (d2) 交叉自动生成路口（SimCity 式）：新路穿过一条（或多条）现有路，交点处两条路都被拆开。
{
  const patch = fresh();
  patch.roadOps = [{ t: "add", from: { x: 50, z: -40 }, to: { x: 50, z: 60 }, width: 5 }]; // 穿过 0:0—100:0（z=0）
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  assert.equal(stale.length, 0);
  assert.ok(!layout.roadEdges.some((e) => e.id === "0:0/100:0"), "the crossed road is split at the crossing");
  assert.ok(layout.roadEdges.some((e) => e.id === "0:0/50:0") && layout.roadEdges.some((e) => e.id === "100:0/50:0"), "…into two halves meeting at the junction");
  assert.ok(layout.roadEdges.some((e) => e.id === "50:-40/50:0") && layout.roadEdges.some((e) => e.id === "50:0/50:60"), "the new road runs through the junction in two pieces");
  const degree = layout.roadEdges.filter((e) => e.from === "50:0" || e.to === "50:0").length;
  assert.equal(degree, 4, "the crossing is a real four-way junction");
  // 与桥面交叉：立体交叉——新路从桥下穿过，桥面不拆、不开路口（桥上开路口才是物理上做不到的）。
  const underBridge = fresh();
  underBridge.roadOps = [{ t: "add", from: { x: 150, z: -40 }, to: { x: 150, z: 40 }, width: 5 }];
  const passed = applyPlanPatch(makeLayout(), underBridge);
  assert.equal(passed.stale.length, 0, "a road may pass under a bridge");
  assert.ok(passed.layout.roadEdges.some((e) => e.id === "100:0/200:0" && e.bridge), "the bridge deck is left intact");
  assert.ok(passed.layout.roadEdges.some((e) => e.id === "150:-40/150:40"), "the new road is one piece — no junction on the deck");
}

// (e) 节点移动：尽端节点 (100,100) → (120,120)，id/边引用/边 id/回车点全部跟随。
{
  const patch = fresh();
  patch.roadOps = [{ t: "move", node: "100:100", to: { x: 120, z: 120 } }];
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  assert.equal(stale.length, 0);
  const node = layout.roadNodes.find((n) => n.id === "120:120");
  assert.ok(node && node.x === 120 && node.z === 120, "node must be re-keyed to its new coordinates");
  assert.ok(!layout.roadNodes.some((n) => n.id === "100:100"), "old node id must be gone");
  const e4 = layout.roadEdges.find((e) => e.from === "120:120" || e.to === "120:120");
  assert.equal(e4.id, "100:0/120:120", "edge id must be re-derived from the new node ids");
  assert.deepEqual(e4.points, [{ x: 100, z: 0 }, { x: 120, z: 120 }], "edge endpoints must follow the moved node");
  assert.deepEqual(layout.culDeSacEnds, [{ x: 120, z: 120 }], "the moved dead-end must remain a cul-de-sac at its new position");
}

// (f) 删路段：车流过滤、孤立节点清除、缺失边 stale（擦桥面是整座擦，见 (u)）。
{
  const patch = fresh();
  patch.roadOps = [{ t: "drop", edge: "100:0/100:100" }, { t: "drop", edge: "nope" }];
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  assert.ok(!layout.roadEdges.some((e) => e.id === "100:0/100:100"), "the dropped local edge must be gone");
  assert.ok(!layout.roadNodes.some((n) => n.id === "100:100"), "the orphaned dead-end node must be pruned");
  assert.deepEqual(layout.culDeSacEnds, [], "the cul-de-sac of a dropped road must vanish");
  assert.equal(layout.districts[0].carPaths.length, 1, "car paths along dropped edges must be filtered");
  assert.deepEqual(stale.map((s) => s.reason).sort(), ["missing-edge"]);
}

// (g) 编辑校验：blockers 硬阻止。
{
  const empty = fresh();
  const layout = makeLayout();
  assert.deepEqual(validateBuildingMove(layout, model, empty, "b1", "p3").blockers, [], "a free, clear parcel must pass");
  assert.ok(validateBuildingMove(layout, model, empty, "b1", "p2").blockers.includes("parcel-occupied"), "occupied target must block");
  assert.ok(validateBuildingMove(layout, model, empty, "b1", "ghost").blockers.includes("missing-parcel"), "missing target must block");
  assert.ok(validateBuildingMove(layout, model, empty, "b1", "p6").blockers.includes("parcel-occupied"), "context buildings reserve their parcels");
  assert.ok(!validateBuildingMove(layout, model, empty, "b1", "p6").blockers.includes("building-over-road"), "bridge decks are not ground roads — validate shares the audit's clearance rule");
  const withSuppression = fresh();
  withSuppression.suppressedContext = ["context:p6"];
  assert.ok(!validateBuildingMove(layout, model, withSuppression, "b1", "p6").blockers.includes("parcel-occupied"), "suppression lifts the reservation");
  assert.ok(validateBuildingMove(layout, model, empty, "b1", "p7").blockers.includes("steep-slope"), "steep terrain must block");
  assert.ok(validateBuildingMove(layout, model, empty, "b1", "p8").blockers.includes("not-buildable"), "unbuildable terrain must block");
  assert.ok(validateBuildingMove(layout, model, empty, "b1", "p9").blockers.includes("highway-clearance"), "highway clearance must block");
  assert.ok(validateBuildingMove(layout, model, empty, "b1", "p5").blockers.includes("parcel-occupied"), "b4 occupies p5");
  assert.ok(validateBuildingMove(layout, model, empty, "b4", "p5").blockers.includes("building-over-road"), "a lot on a ground road must block");
  assert.deepEqual(validateBuildingMove(layout, model, empty, "ghost", "p3").blockers, ["unknown-building"]);
  // 占地重叠（SPEC §7.3 硬阻止，曾缺）：贴着塔楼 b2 的地块不行。
  layout.blocks[0].parcels.push({ ...P3, id: "p3b", x: 46, z: 60 });
  assert.ok(validateBuildingMove(layout, model, empty, "b3", "p3b").blockers.includes("building-overlap"), "overlap with another session building must block");
  assert.ok(!validateBuildingMove(layout, model, empty, "b3", "p3").blockers.includes("building-overlap"), "a clear parcel must not report overlap");
}

// (h) 体检：布局层规则命中、排序确定。
{
  const layout = makeLayout();
  const issues = auditLayout(layout, model, [{ kind: "building-move", id: "b1", reason: "missing-parcel", detail: "x" }]);
  const rules = issues.map((issue) => issue.id);
  assert.ok(rules.includes("buildingOverRoad:b4"), `b4 sits on road e1 — got ${rules.join(",")}`);
  assert.ok(rules.includes("buildingOverlap:b1/b2"), "b1 (lot) and b2 (10-wide tower) footprints must intersect");
  assert.ok(rules.includes("buildingOnSlope:steep:b2"), "b2 sits on the cliff");
  assert.ok(rules.includes("orphanedBlock:blkB"), "blkB has a building but no road nearby");
  assert.ok(rules.includes("patchStale:building-move:b1"), "stale entries must surface as info issues");
  assert.equal(issues.find((issue) => issue.rule === "patchStale").at, null, "stale entries have no location — null, never NaN");
  const again = auditLayout(layout, model, [{ kind: "building-move", id: "b1", reason: "missing-parcel", detail: "x" }]);
  assert.equal(JSON.stringify(again), JSON.stringify(issues), "audit must be deterministic");
  const order = issues.map((issue) => ({ error: 0, warning: 1, info: 2 })[issue.severity]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "issues must be severity-sorted");
  // 修复闭环：把 b4 挪到 p3 后压路问题消失（体检与补丁同一语言）。
  const patch = fresh();
  patch.buildingMoves = { b4: "p3" };
  const fixed = auditLayout(applyPlanPatch(layout, patch).layout, model);
  assert.ok(!fixed.some((issue) => issue.rule === "buildingOverRoad"), "moving b4 off the road must clear the issue");
  // 指纹稳定性：同补丁同指纹；不同补丁不同指纹。
  const other = fresh();
  other.buildingMoves = { b1: "p3" };
  assert.equal(hashPlanPatch(patch), hashPlanPatch({ ...patch, buildingMoves: { b4: "p3" } }));
  assert.notEqual(hashPlanPatch(patch), hashPlanPatch(other));
}

// (i) 节点撞车：重复 id / 零长边曾一路流进渲染。
{
  const uniqueAndNonDegenerate = (layout) => {
    const nodeIds = layout.roadNodes.map((n) => n.id); assert.equal(new Set(nodeIds).size, nodeIds.length, "node ids stay unique");
    const edgeIds = layout.roadEdges.map((e) => e.id); assert.equal(new Set(edgeIds).size, edgeIds.length, "edge ids stay unique");
    assert.ok(layout.roadEdges.every((e) => e.from !== e.to), "no zero-length edge");
  };
  for (const to of [{ x: 0, z: 100 }, { x: 100, z: 0 }]) { // 拖到不动的 0:100 上 / 拖到相邻节点 → 零长边
    const patch = fresh(); patch.roadOps = [{ t: "move", node: "100:100", to }];
    const { layout, stale } = applyPlanPatch(makeLayout(), patch);
    assert.deepEqual(stale.map((s) => s.reason), ["node-collision"], "a move onto an existing node must be rejected");
    assert.ok(layout.roadNodes.some((n) => n.id === "100:100"), "the rejected node stays put");
    uniqueAndNonDegenerate(layout);
  }
  const free = () => {
    const layout = makeLayout();
    layout.roadNodes.push({ id: "300:0", x: 300, z: 0 }, { id: "300:50", x: 300, z: 50 });
    layout.roadEdges.push(edge("300:0/300:50", "300:0", "300:50", 5, [{ x: 300, z: 0 }, { x: 300, z: 50 }]), edge("100:100/300:0", "100:100", "300:0", 5, [{ x: 100, z: 100 }, { x: 300, z: 0 }]));
    return layout;
  };
  // 日志按顺序重放：先到先得——第二个去同一点的被拒，第一个生效。
  const both = fresh(); both.roadOps = [{ t: "move", node: "300:0", to: { x: 200, z: 200 } }, { t: "move", node: "300:50", to: { x: 200, z: 200 } }];
  const collided = applyPlanPatch(free(), both);
  assert.deepEqual(collided.stale.map((s) => `${s.id}:${s.reason}`), ["2:move:node-collision"], "the later move into an occupied spot is rejected");
  assert.ok(collided.layout.roadNodes.some((n) => n.id === "200:200") && collided.layout.roadNodes.some((n) => n.id === "300:50"));
  uniqueAndNonDegenerate(collided.layout);
  // 让位：先把占位的挪开，后面的就能进。
  const swap = fresh(); swap.roadOps = [{ t: "move", node: "300:50", to: { x: 320, z: 80 } }, { t: "move", node: "300:0", to: { x: 300, z: 50 } }];
  const swapped = applyPlanPatch(free(), swap);
  assert.equal(swapped.stale.length, 0, "moving into a spot an earlier op vacated is legal");
  assert.ok(swapped.layout.roadEdges.some((e) => e.id === "300:50/320:80"));
  uniqueAndNonDegenerate(swapped.layout);
  // 反过来次序（先去被占的）→ 被拒，说明次序是语义。
  const wrongOrder = fresh(); wrongOrder.roadOps = [swap.roadOps[1], swap.roadOps[0]];
  assert.deepEqual(applyPlanPatch(free(), wrongOrder).stale.map((s) => s.reason), ["node-collision"], "op order is semantic");
}

// (j) 背景楼压制：曾以「总数没变」判失效，一条生效就吞掉其余不存在的 id。
{
  const patch = fresh(); patch.suppressedContext = ["context:p6", "context:ghost"];
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  assert.equal(layout.contextBuildings.length, 0, "the existing context building is suppressed");
  assert.deepEqual(stale.map((s) => `${s.id}:${s.reason}`), ["context:ghost:missing-context"], "the missing id must still be reported");
}

// (k) 套用与校验同一占用口径：目标地块上有背景楼（未压制）→ parcel-occupied。
{
  const patch = fresh(); patch.buildingMoves = { b1: "p6" };
  const { layout, stale } = applyPlanPatch(makeLayout(), patch);
  assert.deepEqual(stale.map((s) => s.reason), ["parcel-occupied"], "apply must honour context-building reservations");
  assert.equal(layout.districts[0].slots.get("b1").id, "p1");
  const lifted = { ...patch, suppressedContext: ["context:p6"] };
  assert.equal(applyPlanPatch(makeLayout(), lifted).layout.districts[0].slots.get("b1").id, "p6", "suppression frees the parcel");
}

// (l) 存档宽容读取：曾 `{...c, 默认, ...c}`，`edgeDrops: null` 直接让套用抛异常；旧开发版两张表转日志。
{
  const coerced = coercePlanPatch({ version: 1, seed: 74031, scaleTier: 1, nodeMoves: { a: { x: 1, z: 2 }, bad: { x: "1" } }, edgeDrops: null, buildingMoves: { b1: "p3", b2: 9 }, suppressedContext: ["context:x", 3] });
  assert.deepEqual(coerced, { version: 1, seed: 74031, scaleTier: 1, updatedAt: 0, roadOps: [{ t: "move", node: "a", to: { x: 1, z: 2 } }], siteOps: [], buildingMoves: { b1: "p3" }, suppressedContext: ["context:x"] });
  assert.doesNotThrow(() => applyPlanPatch(makeLayout(), coerced));
  const legacy = coercePlanPatch({ version: 1, seed: 1, scaleTier: 1, edgeDrops: ["0:0/100:0"], nodeMoves: { "100:100": { x: 110, z: 110 } } });
  assert.deepEqual(legacy.roadOps, [{ t: "drop", edge: "0:0/100:0" }, { t: "move", node: "100:100", to: { x: 110, z: 110 } }], "legacy tables become a log: drops first, then moves");
  const messy = coercePlanPatch({ version: 1, seed: 1, scaleTier: 1, roadOps: [{ t: "add", from: { x: 1, z: 2 }, to: { x: 3, z: 4 }, width: 5 }, { t: "add", from: { x: 1 } }, { t: "zap" }, null, { t: "drop", edge: 7 }] });
  assert.equal(messy.roadOps.length, 1, "malformed log entries are dropped one by one");
  assert.equal(coercePlanPatch({ version: 1, seed: 7 }), null, "missing scaleTier drops the whole patch");
  assert.equal(coercePlanPatch(null), null);
  assert.equal(coercePlanPatch({ version: 2, seed: 7, scaleTier: 1 }), null);
}

// (m) 道路日志重放：引用当前 id；拆路段、画路端点吸附、失败不留半截改动。
{
  const base = makeLayout();
  // 移后再移（用移后的当前 id）：两步等价于一步到终点。
  let patch = fresh();
  patch = appendRoadOp(patch, { t: "move", node: "100:100", to: { x: 120, z: 120 } }, 1);
  patch = appendRoadOp(patch, { t: "move", node: "120:120", to: { x: 130, z: 140 } }, 2);
  let patched = applyPlanPatch(base, patch);
  assert.equal(patched.stale.length, 0);
  assert.ok(patched.layout.roadNodes.some((n) => n.id === "130:140") && !patched.layout.roadNodes.some((n) => n.id === "120:120"));
  assert.deepEqual(patched.layout.culDeSacEnds, [{ x: 130, z: 140 }], "the cul-de-sac follows two successive moves");
  // 移后再删（用移后的边 id）。
  patch = appendRoadOp(patch, { t: "drop", edge: "100:0/130:140" }, 3);
  patched = applyPlanPatch(base, patch);
  assert.equal(patched.stale.length, 0);
  assert.ok(!patched.layout.roadEdges.some((e) => e.id === "100:0/130:140"), "dropping by the current id works");
  assert.ok(!patched.layout.roadNodes.some((n) => n.id === "130:140"), "the orphaned node goes with it");
  assert.deepEqual(patched.layout.culDeSacEnds, [], "…and so does its cul-de-sac");

  // 画路：端点落在路口 / 路段中间 / 空地。
  const add = (from, to, width = 5) => ({ t: "add", from, to, width });
  const draw = (op) => { const p = fresh(); p.roadOps = [op]; return applyPlanPatch(makeLayout(), p); };
  const toNode = draw(add({ x: 200, z: 0 }, { x: 100, z: 100 })); // 从桥头往尽头画：起点不是尽头，不倒圆（倒圆另测，见 (p)）
  assert.equal(toNode.stale.length, 0);
  assert.ok(toNode.layout.roadEdges.some((e) => e.id === "100:100/200:0" && e.points.length === 2 && e.structure === "ground-road"), "a road between two existing nodes is one new edge");
  assert.equal(toNode.layout.roadNodes.length, makeLayout().roadNodes.length, "no node is invented when both ends snap to nodes");
  const split = draw(add({ x: 50, z: 0 }, { x: 100, z: 100 })); // 起点落在 0:0—100:0 路段中间
  assert.equal(split.stale.length, 0);
  assert.ok(!split.layout.roadEdges.some((e) => e.id === "0:0/100:0"), "the host edge is replaced by two halves");
  assert.ok(split.layout.roadEdges.some((e) => e.id === "0:0/50:0") && split.layout.roadEdges.some((e) => e.id === "100:0/50:0"), "both halves are keyed by their endpoints");
  assert.ok(split.layout.roadEdges.some((e) => e.id === "100:100/50:0"), "the new road lands on the split node");
  assert.equal(split.layout.roadEdges.find((e) => e.id === "0:0/50:0").width, E1.width, "halves inherit the host's attributes");
  const dead = draw(add({ x: 200, z: 60 }, { x: 260, z: 60 }, 8)); // 起点在路口 200:60（路网尽头），终点是空地
  assert.equal(dead.stale.length, 0);
  assert.ok(dead.layout.roadNodes.some((n) => n.id === "260:60"), "a free end creates a node");
  assert.equal(dead.layout.roadEdges.find((e) => e.id === "200:60/260:60").kind, "arterial", "width ≥ 8 draws an arterial");
  // 拆开后再删其中一半（用拆出来的 id）——这是原始 id 方案做不到的。
  let chained = fresh(); chained.roadOps = [add({ x: 50, z: 0 }, { x: 100, z: 100 }), { t: "drop", edge: "0:0/50:0" }];
  const afterHalf = applyPlanPatch(makeLayout(), chained);
  assert.equal(afterHalf.stale.length, 0, "a half created by a split can be dropped by the log");
  assert.ok(!afterHalf.layout.roadEdges.some((e) => e.id === "0:0/50:0") && afterHalf.layout.roadEdges.some((e) => e.id === "100:0/50:0"));
  // 失败的操作不留半截改动：终点已存在的重复路段不应顺带把宿主拆了。
  const dup = fresh(); dup.roadOps = [add({ x: 0, z: 0 }, { x: 100, z: 0 })];
  const dupResult = applyPlanPatch(makeLayout(), dup);
  assert.deepEqual(dupResult.stale.map((s) => s.reason), ["edge-exists"]);
  const partial = fresh(); partial.roadOps = [add({ x: 50, z: 0 }, { x: 50.2, z: 0.1 })]; // 两端解析到同一个新路口 → 退化
  const partialResult = applyPlanPatch(makeLayout(), partial);
  assert.deepEqual(partialResult.stale.map((s) => s.reason), ["degenerate"]);
  assert.equal(snap(partialResult.layout).replace(/\|patch:\d+/, ""), snap(makeLayout()).replace(/\|patch:\d+/, ""), "a failed add must not leave a half-done split behind");
}

// (n) 跨档位：整份补丁失效，布局原样返回。
{
  const patch = emptyPlanPatch(74031, 2); patch.buildingMoves = { b1: "p3" }; patch.roadOps = [{ t: "drop", edge: "100:0/100:100" }];
  const base = makeLayout();
  const { layout, stale } = applyPlanPatch(base, patch);
  assert.equal(layout, base, "a cross-tier patch must not touch the layout");
  assert.deepEqual(stale.map((s) => `${s.kind}:${s.reason}`), ["building-move:tier-changed", "road-drop:tier-changed"]);
}

// (n2) 生成器换代：档位不变、生成器版本变了——补丁里的 id 指向上一版地图，整份不套用（会话层先 planRemap 重定位）。
{
  assert.equal(fresh().generatorVersion, CITY_GENERATOR_VERSION, "new patches are stamped with the current generator version");
  const legacyRaw = { version: 1, seed: 74031, scaleTier: 1, buildingMoves: { b1: "p3" }, roadOps: [{ t: "drop", edge: "100:0/100:100" }] };
  const legacy = coercePlanPatch(legacyRaw);
  assert.equal(legacy.generatorVersion, undefined, "an old save without a stamp loads without one");
  assert.equal(patchGeneratorVersion(legacy), 1, "...and is read as generator version 1");
  assert.equal(coercePlanPatch({ ...legacyRaw, generatorVersion: 3 }).generatorVersion, 3, "a valid stamp survives the round trip");
  for (const bad of [0, -1, 1.5, "2", null]) assert.equal(coercePlanPatch({ ...legacyRaw, generatorVersion: bad }).generatorVersion, undefined, `a malformed stamp (${JSON.stringify(bad)}) falls back to the default, it does not drop the patch`);
  assert.equal(hashPlanPatch(legacy), hashPlanPatch({ ...legacy, generatorVersion: 1 }), "stamping version 1 does not change an old patch's fingerprint");
  const other = { ...legacy, generatorVersion: CITY_GENERATOR_VERSION + 1 };
  assert.notEqual(hashPlanPatch(other), hashPlanPatch(legacy), "a different generator version is a different patch");
  assert.equal(patchMatchesLayout(legacy, 1), CITY_GENERATOR_VERSION === 1);
  assert.equal(patchMatchesLayout(other, 1), false);
  const base = makeLayout();
  const { layout, stale } = applyPlanPatch(base, other);
  assert.equal(layout, base, "a patch from another generator version must not touch the layout");
  assert.deepEqual(stale.map((s) => `${s.kind}:${s.reason}`), ["building-move:generator-changed", "road-drop:generator-changed"]);
  assert.match(stale[0].detail, /生成器/);
  assert.equal(pruneStalePatch(other, stale), null, "clearing a generator-changed patch empties it, like tier-changed");
  assert.equal(layoutPinsFor(other), null, "building pins from another generator version are ignored by layoutCity");
  assert.ok(layoutPinsFor({ ...other, generatorVersion: CITY_GENERATOR_VERSION }), "...and honoured for the current one");
  const both = { ...other, scaleTier: 2 };
  assert.deepEqual(applyPlanPatch(base, both).stale.map((s) => s.reason), ["tier-changed", "tier-changed"], "tier change takes precedence so the existing tier-changed reporting is unchanged");
}

// (o) 真实城市（同 verify-city-culdesac-bulbs 的固定伪随机数据）。
{
  const HARNESSES = ["codex", "claude-code", "dsh", "harness:zcode"];
  const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
  const rows = (count, offset = 0) => {
    let s = 12345 + offset;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    return Array.from({ length: count }, (_, i) => {
      const total = Math.round(2000 + rnd() ** 3 * 4_000_000);
      const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
      const end = start + Math.round(rnd() * 3_600_000);
      return {
        session_ref: `session:${i + offset}`, harness: HARNESSES[i % HARNESSES.length],
        first_event_at: new Date(start).toISOString(), last_event_at: new Date(end).toISOString(),
        event_count: 10, model_ids: ["claude-sonnet-5"],
        tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
        peak_tokens: Math.round(total * 0.3),
        cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
        cost_status: { state: "estimated", reason: "", has_unresolved: false },
      };
    });
  };
  const modelOf = (list) => buildCityModel({ rows: list, findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: list.length, truncated: false, generatedAt: GENERATED_AT });
  const slotsOf = (layout) => JSON.stringify(layout.districts.map((d) => [...d.slots].map(([b, p]) => [b, p.id]).sort()));
  const slotOf = (layout, id) => layout.districts.flatMap((d) => [...d.slots]).find(([b]) => b === id)?.[1];

  for (const count of [380, 1600]) {
    const real = modelOf(rows(count));
    const base = layoutCity(real, null, undefined, MIAMI_COASTAL);
    // 空补丁不改布局（只追加指纹）；pins=null 与不传逐字节一致。
    const blank = applyPlanPatch(base, emptyPlanPatch(base.seed, base.scaleTier));
    assert.equal(slotsOf(blank.layout), slotsOf(base));
    assert.equal(JSON.stringify(blank.layout.roadEdges), JSON.stringify(base.roadEdges));
    assert.equal(JSON.stringify(blank.layout.districts.map((d) => d.carPaths)), JSON.stringify(base.districts.map((d) => d.carPaths)));
    assert.deepEqual(blank.layout.culDeSacEnds, base.culDeSacEnds);
    assert.equal(slotsOf(layoutCity(real, null, undefined, MIAMI_COASTAL, "auto", null)), slotsOf(base), "pins=null must not change placement");
    // 占地重叠不误报：曾借保守碰撞包络，380 楼报 253 条、1600 楼报 1111 条 error。
    const overlaps = auditLayout(base, real).filter((issue) => issue.rule === "buildingOverlap");
    assert.ok(overlaps.length <= count * 0.01, `buildingOverlap must not flood a generated city — ${overlaps.length} for ${count}`);
    console.log(`  ${count} 楼：buildingOverlap ${overlaps.length} 条（旧保守包络口径 ${count === 380 ? 253 : 1111} 条）`);
  }

  // pins：把一栋楼搬进一个空置街区——落位阶段生效、街区长出路、刷新/新会话不挤掉。
  const real = modelOf(rows(380));
  const base = layoutCity(real, null, undefined, MIAMI_COASTAL);
  const plannedRoadIds = new Set(createCityPlan(base.seed, base.scaleTier, MIAMI_COASTAL).roadEdges.map((edge) => edge.id));
  const displayedRoadIds = new Set(base.roadEdges.map((edge) => edge.id));
  const builtBlocks = new Set(base.districts.flatMap((d) => [...d.slots.values()].map((p) => p.blockId)));
  const mover = [...base.districts[0].slots.keys()].sort()[0];
  let target = null;
  for (const block of base.blocks) {
    if (builtBlocks.has(block.id) || block.parcels.length === 0) continue;
    // Choose an actually pruned, but accepted, parcel frontage; other valid empty blocks may already
    // have all their roads retained for nearby sites, making a citywide road-count assertion vacuous.
    const parcel = block.parcels.find((candidate) => candidate.frontage
      && plannedRoadIds.has(candidate.frontage.hostEdgeId) && !displayedRoadIds.has(candidate.frontage.hostEdgeId)
      && validateBuildingMove(base, real, emptyPlanPatch(base.seed, base.scaleTier), mover, candidate.id).blockers.length === 0);
    if (parcel) { target = { block, parcel }; break; }
  }
  assert.ok(target, "the generated city must have an empty valid parcel whose proved frontage road is pruned before pinning");
  const patch = emptyPlanPatch(base.seed, base.scaleTier); patch.buildingMoves = { [mover]: target.parcel.id };
  // 只做后处理（旧行为）：楼搬过去了，但新家街区的支路早被生长剪枝剪掉。
  const postOnly = applyPlanPatch(base, patch);
  assert.equal(slotOf(postOnly.layout, mover).id, target.parcel.id);
  const orphaned = (layout) => auditLayout(layout, real).some((issue) => issue.id === `orphanedBlock:${target.block.id}`);
  const pinned = layoutCity(real, null, undefined, MIAMI_COASTAL, "auto", layoutPinsFor(patch));
  assert.equal(slotOf(pinned, mover).id, target.parcel.id, "pins must place the building at its target during layout");
  const applied = applyPlanPatch(pinned, patch);
  assert.equal(applied.stale.length, 0, "apply after a pinned layout is a no-op for the move");
  // 判别断言是实际服务边身份：移出旧街区也可能同时剪掉旧路，故全城净路段数不必增长。
  const grewRoads = pinned.roadEdges.length - base.roadEdges.length;
  assert.ok(pinned.roadEdges.some((edge) => edge.id === target.parcel.frontage.hostEdgeId), "pinning must retain the target parcel's proved frontage host");
  assert.ok(!base.roadEdges.some((edge) => edge.id === target.parcel.frontage.hostEdgeId), "the selected target frontage must be pruned in the unpinned baseline");
  assert.equal(postOnly.layout.roadEdges.length, base.roadEdges.length, "post-processing alone cannot regrow pruned roads (the defect pins fix)");
  assert.ok(!orphaned(applied.layout), "the formerly empty block must be served by a road");
  console.log(`  pins: ${mover} → ${target.parcel.id}；生长剪枝多保留 ${grewRoads} 条路段（post-only 孤立街区=${orphaned(postOnly.layout)}，pins=${orphaned(applied.layout)}）`);
  // 刷新 + 新会话：pins 先落位，目标地块不会被新会话抢走。
  const grown = modelOf([...rows(380), ...rows(12, 10_000)]);
  const refreshed = layoutCity(grown, pinned, base.seed, MIAMI_COASTAL, "auto", layoutPinsFor(patch));
  assert.equal(slotOf(refreshed, mover).id, target.parcel.id, "a refresh must keep the pinned building on its target");
  assert.equal(applyPlanPatch(refreshed, patch).stale.length, 0, "the patch stays live after a refresh");
  // 钉子跨档不认。
  const otherTier = layoutCity(real, null, undefined, MIAMI_COASTAL, "auto", { scaleTier: base.scaleTier + 1, parcels: layoutPinsFor(patch).parcels });
  assert.equal(slotsOf(otherTier), slotsOf(base), "pins written for another tier are ignored by layoutCity");
}

// (p) 拐角倒圆。E4 = 100:0 → 100:100（向 +z），100:100 是尽头。
{
  const turn = fresh(); turn.roadOps = [{ t: "add", from: { x: 100, z: 100 }, to: { x: 160, z: 100 }, width: 5 }]; // 右拐 90°
  const { layout, stale } = applyPlanPatch(makeLayout(), turn);
  assert.equal(stale.length, 0);
  assert.ok(!layout.roadNodes.some((n) => n.id === "100:100"), "the sharp corner node is replaced");
  const old = layout.roadEdges.find((e) => e.from === "100:0" || e.to === "100:0" ? (e.from === "100:0" ? e.to : e.from) !== "0:0" && (e.from === "100:0" ? e.to : e.from) !== "200:0" : false);
  const fresh_ = layout.roadEdges.find((e) => e.from === "160:100" || e.to === "160:100");
  assert.ok(old && fresh_, "both legs still meet at one junction");
  const mid = old.from === "100:0" ? old.to : old.from;
  assert.ok(fresh_.from === mid || fresh_.to === mid, "…the arc midpoint");
  assert.ok(old.points.length > 2 && fresh_.points.length > 2, "each leg carries half of the arc");
  const m = layout.roadNodes.find((n) => n.id === mid);
  assert.ok(m.x > 100 && m.z < 100, "the midpoint lies inside the corner");
  // 切线连续：相邻弧点之间的转角都小于 30°（不再是一个 90° 硬折）。
  const path = [...(old.to === mid ? old.points : [...old.points].reverse()), ...(fresh_.from === mid ? fresh_.points : [...fresh_.points].reverse()).slice(1)];
  for (let i = 2; i < path.length; i += 1) {
    const d1 = Math.atan2(path[i - 1].z - path[i - 2].z, path[i - 1].x - path[i - 2].x); const d2 = Math.atan2(path[i].z - path[i - 1].z, path[i].x - path[i - 1].x);
    const bend = Math.abs(Math.atan2(Math.sin(d2 - d1), Math.cos(d2 - d1)));
    assert.ok(bend < Math.PI / 6, `bend ${(bend * 180 / Math.PI).toFixed(1)}° at point ${i} is gentle`);
  }
  assert.ok(path.every((q) => Math.abs(q.x - 100) < 0.01 || q.z <= 100.01), "the arc cuts the inside of the corner, never bulges outward");
  assert.deepEqual(layout.culDeSacEnds, [], "the old dead end is gone, and the moved junction is not a dead end");
  // 不倒的情形：直行、回折、起点在路口（度 ≥ 2）。
  assert.equal(filletAt({ x: 0, z: 0 }, { x: 0, z: 50 }, { x: 1, z: 100 }, 5), null, "almost straight → no fillet");
  assert.equal(filletAt({ x: 0, z: 0 }, { x: 0, z: 50 }, { x: 2, z: 0 }, 5), null, "a hairpin back → no fillet");
  const fromJunction = fresh(); fromJunction.roadOps = [{ t: "add", from: { x: 100, z: 0 }, to: { x: 160, z: 60 }, width: 5 }];
  assert.ok(applyPlanPatch(makeLayout(), fromJunction).layout.roadNodes.some((n) => n.id === "100:0"), "a stroke from a junction does not move the junction");
  // 短路段上倒小圆：切点不超过路段长度的 45%。
  const tiny = filletAt({ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 40, z: 10 }, 12);
  assert.ok(tiny && Math.hypot(tiny.before[0].x - 0, tiny.before[0].z - 10) <= 4.5 + 0.01, "the tangent point stays within 45% of a short leg");
  // 重放与预览同源：连续画两段（第二段接在第一段尽头），两个拐角都倒圆，日志重放无失效。
  const chain = fresh(); chain.roadOps = [{ t: "add", from: { x: 100, z: 100 }, to: { x: 160, z: 100 }, width: 5 }, { t: "add", from: { x: 160, z: 100 }, to: { x: 160, z: 40 }, width: 5 }];
  const chained = applyPlanPatch(makeLayout(), chain);
  assert.equal(chained.stale.length, 0);
  assert.ok(!chained.layout.roadNodes.some((n) => n.id === "160:100"), "the second corner is rounded too");
}

// (q) 滨海景观带跟着滨海路走。底层：E3（0:0→0:100）是滨海路，coastRoads 沿它；另有一条河岸路（同标 waterfront）不在 coastRoads。
{
  const base = () => { const l = makeLayout(); l.coastRoads = [[{ x: 0, z: 0 }, { x: 0, z: 25 }, { x: 0, z: 50 }, { x: 0, z: 75 }, { x: 0, z: 100 }]]; l.riverRoadRuns = []; return l; };
  const none = applyPlanPatch(base(), fresh());
  assert.deepEqual(none.layout.coastRoads, base().coastRoads, "no road ops → coastRoads untouched");
  const dropped = fresh(); dropped.roadOps = [{ t: "drop", edge: "0:0/0:100" }];
  assert.deepEqual(applyPlanPatch(base(), dropped).layout.coastRoads, [], "erasing the waterfront road takes its promenade with it");
  const drawn = fresh(); drawn.roadOps = [{ t: "add", from: { x: -100, z: -50 }, to: { x: -100, z: 50 }, width: 12, purpose: "waterfront" }];
  const withBoulevard = applyPlanPatch(base(), drawn).layout;
  assert.equal(withBoulevard.coastRoads.length, 2, "the existing run stays and the drawn boulevard gets its own run");
  const run = withBoulevard.coastRoads[1];
  assert.ok(run.length >= 13 && run.every((q) => Math.abs(q.x + 100) < 0.01), "…densified every ≤ 8 along the new road (the promenade builder needs ≥ 3 points)");
  const edge = withBoulevard.roadEdges.find((e) => e.purpose === "waterfront" && e.points.some((q) => q.x === -100));
  assert.ok(edge && edge.width === 12 && edge.kind === "arterial", "a waterfront boulevard is a 12-wide arterial tagged waterfront");
  const river = base(); river.riverRoadRuns = [[{ x: 100, z: 0 }, { x: 100, z: 100 }]]; river.roadEdges = river.roadEdges.map((e) => (e.id === "100:0/100:100" ? { ...e, purpose: "waterfront" } : e));
  const touched = fresh(); touched.roadOps = [{ t: "add", from: { x: -100, z: -50 }, to: { x: -100, z: 50 }, width: 5 }];
  assert.equal(applyPlanPatch(river, touched).layout.coastRoads.length, 1, "a river-bank road (also tagged waterfront) does not grow a seaside promenade");
  const coastal = base(); coastal.coast = Array.from({ length: 64 }, (_, i) => ({ x: Math.cos(i / 64 * Math.PI * 2) * 400, z: Math.sin(i / 64 * Math.PI * 2) * 400 }));
  assert.ok(validateRoadAdd(coastal, model, { x: -100, z: -50 }, { x: -100, z: 50 }, 12, "waterfront").warnings.includes("far-from-coast"), "a waterfront boulevard far inland is flagged (not blocked)");
  assert.ok(!validateRoadAdd(coastal, model, { x: -100, z: -50 }, { x: -100, z: 50 }, 12).warnings.includes("far-from-coast"), "…a plain main road is not");
  assert.ok(!validateRoadAdd(coastal, model, { x: 330, z: -60 }, { x: 330, z: 60 }, 12, "waterfront").warnings.includes("far-from-coast"), "…nor a boulevard near the shore");
  // 存档：purpose 读回，未知 purpose 丢掉。
  const read = coercePlanPatch({ ...fresh(), roadOps: [{ t: "add", from: { x: 0, z: 0 }, to: { x: 9, z: 0 }, width: 12, purpose: "waterfront" }, { t: "add", from: { x: 0, z: 0 }, to: { x: 9, z: 0 }, width: 5, purpose: "moon" }] });
  assert.equal(read.roadOps[0].purpose, "waterfront"); assert.equal(read.roadOps[1].purpose, undefined);
}

// (t) 改路型。
{
  const base = () => { const l = makeLayout(); l.coastRoads = [[{ x: 0, z: 0 }, { x: 0, z: 50 }, { x: 0, z: 100 }]]; l.riverRoadRuns = []; return l; };
  const restyle = (...ops) => { const patch = fresh(); patch.roadOps = ops.map((op) => ({ t: "restyle", ...op })); return applyPlanPatch(base(), patch); };
  const widened = restyle({ edge: "0:0/100:0", width: 12 });
  const e1 = widened.layout.roadEdges.find((e) => e.id === "0:0/100:0");
  assert.deepEqual([e1.width, e1.kind, e1.purpose, widened.stale.length], [12, "arterial", undefined, 0], "a lane becomes a 12-wide arterial in place (same id)");
  assert.deepEqual(restyle({ edge: "0:0/100:0", width: 12 }, { edge: "0:0/100:0", width: 12 }).layout.roadEdges, widened.layout.roadEdges, "restyle records a target state — replaying it twice is the same as once");
  const plain = restyle({ edge: "0:0/0:100", width: 8 });
  assert.equal(plain.layout.roadEdges.find((e) => e.id === "0:0/0:100").purpose, undefined, "restyling a waterfront road to a plain road drops its purpose");
  assert.deepEqual(plain.layout.coastRoads, [], "…and its promenade goes with it");
  const boulevard = restyle({ edge: "100:0/100:100", width: 12, purpose: "waterfront" });
  assert.equal(boulevard.layout.coastRoads.length, 2, "restyling a road to a waterfront boulevard grows a promenade along it");
  assert.deepEqual(restyle({ edge: "0:0/0:100", width: 8, purpose: "waterfront" }).layout.roadEdges, base().roadEdges, "already that style → no-op");
  const bad = restyle({ edge: "100:0/200:0", width: 5 }, { edge: "nope/nope", width: 5 });
  assert.deepEqual(bad.stale.map((x) => [x.kind, x.reason]), [["road-restyle", "locked-edge"], ["road-restyle", "missing-edge"]], "bridge decks and missing edges go stale honestly");
  const read = coercePlanPatch({ ...fresh(), roadOps: [{ t: "restyle", edge: "a/b", width: 8, purpose: "waterfront", anchor: { x: 1, z: 2 } }, { t: "restyle", edge: "a/b", width: -1 }, { t: "restyle", width: 5 }] });
  assert.deepEqual(read.roadOps, [{ t: "restyle", edge: "a/b", width: 8, purpose: "waterfront", anchor: { x: 1, z: 2 } }], "storage reads restyle back; bad width / missing edge are dropped");
  const tier = fresh(); tier.scaleTier = 2; tier.roadOps = [{ t: "restyle", edge: "0:0/100:0", width: 12 }];
  assert.equal(applyPlanPatch(base(), tier).stale[0].kind, "road-restyle", "cross-tier invalidation names the op kind");
  // 一整段：A(5)–B(5)–C(8) 串在度 2 路口上；A、B 同型连成一段，C 换型就停。再在 A/B 之间接一条岔路 → 段被切开。
  const street = makeLayout();
  street.roadNodes.push(...["200:200", "250:200", "300:200", "350:200"].map((id) => ({ id, x: Number(id.split(":")[0]), z: 200 })));
  street.roadEdges.push(edge("200:200/250:200", "200:200", "250:200", 5, [{ x: 200, z: 200 }, { x: 250, z: 200 }]), edge("250:200/300:200", "250:200", "300:200", 5, [{ x: 250, z: 200 }, { x: 300, z: 200 }]),
    edge("300:200/350:200", "300:200", "350:200", 8, [{ x: 300, z: 200 }, { x: 350, z: 200 }]));
  assert.deepEqual(roadRun(street, "250:200/300:200"), ["200:200/250:200", "250:200/300:200"], "a run follows degree-2 junctions while width/purpose match, and stops at a style change");
  const forked = { ...street, roadNodes: [...street.roadNodes, { id: "250:250", x: 250, z: 250 }], roadEdges: [...street.roadEdges, edge("250:200/250:250", "250:200", "250:250", 5, [{ x: 250, z: 200 }, { x: 250, z: 250 }])] };
  assert.deepEqual(roadRun(forked, "250:200/300:200"), ["250:200/300:200"], "…and at a fork");
  assert.deepEqual(roadRun(street, "100:0/200:0"), ["100:0/200:0"], "a bridge deck is its own run");
  assert.deepEqual(validateRestyle(street, model, ["300:200/350:200"], 8).blockers, ["unchanged"]);
  assert.deepEqual(validateRestyle(street, model, ["100:0/200:0"], 5).blockers, ["locked-edge"]);
  assert.deepEqual(validateRestyle(street, model, ["0:0/0:100"], 5).warnings, ["drops-waterfront", "narrows-arterial"], "turning the waterfront arterial into a lane says what is lost");
}

// (u) 地面桥。在合成城市里挖一条南北向的河：x∈(200,240)（另一条在 x∈(300,320)，再远处一条 260 宽的海峡 x∈(-380,-120)）。
{
  const wet = (x) => (x > 200 && x < 240) || (x > 300 && x < 320) || (x > -380 && x < -120);
  // 水按地形高判（wetSpan 的 WATER_LEVEL）：河里地面 -1；岸上照旧。
  const river = () => { const l = makeLayout(); l.terrain = { ...l.terrain, height: (x, z) => (wet(x) ? -1 : height(x, z)), buildable: (x, z) => Math.hypot(x, z) < 380 && !wet(x) }; l.bridges = []; return l; };
  const add = (from, to, width = 8) => { const patch = fresh(); patch.roadOps = [{ t: "add", from, to, width }]; return applyPlanPatch(river(), patch); };
  const crossed = add({ x: 150, z: -100 }, { x: 280, z: -100 });
  assert.equal(crossed.stale.length, 0, `a stroke over one river replays cleanly — ${JSON.stringify(crossed.stale)}`);
  const fresh3 = crossed.layout.roadEdges.filter((e) => e.points.every((q) => q.z === -100));
  assert.deepEqual(fresh3.map((e) => [e.structure, !!e.bridge]), [["ground-approach", false], ["deck", true], ["ground-approach", false]], "…as approach + bridge deck + approach (same shape as the generator's bridges)");
  const deck = fresh3[1];
  assert.ok(deck.points[0].x < 200 && deck.points[0].x > 195 && deck.points[1].x > 240 && deck.points[1].x < 245, `the deck spans the water plus a 3-unit abutment on each bank: ${JSON.stringify(deck.points)}`);
  assert.equal(edgeLocked(deck), true, "the new deck is locked like any bridge");
  assert.equal(crossed.layout.bridges.length, 1, "the bridge is registered for the truss decoration");
  assert.ok(Math.abs(crossed.layout.bridges[0].length - 44) < 1, `water x∈(200,240) sampled per unit = 201..239, plus 3 each side: ${crossed.layout.bridges[0].length}`);
  const verdict = validateRoadAdd(river(), model, { x: 150, z: -100 }, { x: 280, z: -100 }, 8);
  assert.deepEqual(verdict.blockers, [], `validation agrees: a bridge, not road-in-water — ${verdict.blockers}`);
  assert.ok(verdict.warnings.includes("bridge:44"), `…and says so — ${verdict.warnings}`);
  assert.deepEqual(validateRoadAdd(river(), model, { x: 150, z: -100 }, { x: 220, z: -100 }, 8).blockers, ["road-in-water"], "an end in the river is still refused");
  assert.deepEqual(validateRoadAdd(river(), model, { x: 150, z: -100 }, { x: 340, z: -100 }, 8).blockers, ["road-in-water"], "two rivers in one stroke are refused (draw two strokes)");
  assert.deepEqual(validateRoadAdd(river(), model, { x: -100, z: -60 }, { x: -390 + 5, z: -60 }, 8).blockers.length > 0, true);
  assert.deepEqual(validateRoadAdd(river(), model, { x: -100, z: -60 }, { x: -110, z: -60 }, 8).blockers, [], "a short dry stroke is fine");
  const strait = river(); strait.terrain = { ...strait.terrain, height: (x, z) => (x > -300 && x < -120 ? -1 : height(x, z)), buildable: (x, z) => Math.hypot(x, z) < 380 && !(x > -300 && x < -120) };
  assert.deepEqual(validateRoadAdd(strait, model, { x: -100, z: -60 }, { x: -320, z: -60 }, 8).blockers, ["bridge-too-long"], "water wider than 160 asks for a viaduct");
  const forked = river(); forked.roadNodes = [...forked.roadNodes, { id: "220:-150", x: 220, z: -150 }, { id: "220:-50", x: 220, z: -50 }];
  forked.roadEdges = [...forked.roadEdges, { id: "220:-150/220:-50", from: "220:-150", to: "220:-50", width: 5, kind: "local", points: [{ x: 220, z: -150 }, { x: 220, z: -50 }], structure: "ground-road" }];
  assert.ok(validateRoadAdd(forked, model, { x: 150, z: -100 }, { x: 280, z: -100 }, 8).blockers.includes("junction-on-bridge"), "no junctions on a bridge");
  // 整座擦桥（2026-10-21）：坏桥头修不了就擦掉重画——桥面、登记一起撤，两端引道变回普通地面路（断头）。
  const dropDeck = fresh(); dropDeck.roadOps = [{ t: "add", from: { x: 150, z: -100 }, to: { x: 280, z: -100 }, width: 8 }, { t: "drop", edge: deck.id }];
  const erased = applyPlanPatch(river(), dropDeck);
  assert.deepEqual(erased.stale, [], "erasing a bridge deck erases the whole bridge");
  const left = erased.layout.roadEdges.filter((e) => e.points.every((q) => q.z === -100));
  assert.deepEqual(left.map((e) => [e.structure, !!e.bridge]), [["ground-road", false], ["ground-road", false]], "…its approaches stay as plain ground roads");
  assert.equal(erased.layout.bridges.length, 0, "…and the bridge leaves the truss registry");
  assert.ok(!erased.layout.roadNodes.some((n) => n.id === deck.from) || erased.layout.roadEdges.some((e) => e.from === deck.from || e.to === deck.from), "no orphan bridgehead node");
  const erasedVerdict = validateEdgeDrop(crossed.layout, model, deck.id);
  assert.deepEqual(erasedVerdict.blockers, [], `validation agrees — ${erasedVerdict.blockers}`);
  assert.ok(erasedVerdict.warnings.includes("erases-bridge") && erasedVerdict.warnings.includes("creates-dead-end"), `…and warns: ${erasedVerdict.warnings}`);
  // 一座桥多段桥面（中间是只连桥面的节点）：擦任一段整座都走。
  const split = river(); const mid = { x: 220, z: 60 };
  split.roadNodes = [...split.roadNodes, { id: "190:60", x: 190, z: 60 }, { id: "196:60", x: 196, z: 60 }, { id: "220:60", ...mid }, { id: "244:60", x: 244, z: 60 }, { id: "250:60", x: 250, z: 60 }];
  const seg = (a, b, extra) => ({ id: `${a.x}:${a.z}/${b.x}:${b.z}`, from: `${a.x}:${a.z}`, to: `${b.x}:${b.z}`, width: 8, kind: "arterial", points: [a, b], ...extra });
  const deckProps = { bridge: true, structure: "deck" };
  split.roadEdges = [...split.roadEdges, seg({ x: 190, z: 60 }, { x: 196, z: 60 }, { structure: "ground-approach" }), seg({ x: 196, z: 60 }, mid, deckProps), seg(mid, { x: 244, z: 60 }, deckProps), seg({ x: 244, z: 60 }, { x: 250, z: 60 }, { structure: "ground-approach" })];
  split.bridges = [{ from: { x: 196, z: 60 }, to: { x: 244, z: 60 }, angle: 0, length: 48 }];
  const dropHalf = fresh(); dropHalf.roadOps = [{ t: "drop", edge: "220:60/244:60" }];
  const halved = applyPlanPatch(split, dropHalf);
  assert.ok(!halved.layout.roadEdges.some((e) => e.bridge && e.points.every((q) => q.z === 60)), "both deck pieces go");
  assert.ok(!halved.layout.roadNodes.some((n) => n.id === "220:60"), "the mid-bridge node goes with them");
  assert.equal(halved.layout.bridges.length, 0, "the registered span goes too");
  assert.equal(halved.layout.roadEdges.filter((e) => e.points.every((q) => q.z === 60)).length, 2, "the two approaches stay");
  // 悬索桥（7/2 的坏桥头正是它）：整座擦掉时塔与缆（地标）一起拆，别的地标不动。
  const suspended = split; suspended.landmarks = [{ id: "landmark:suspension-bridge", kind: "suspension-bridge", x: 196, z: 60, to: { x: 244, z: 60 }, yaw: 0, radius: 0 }, { id: "landmark:arch", kind: "arch", x: 0, z: 0, yaw: 0, radius: 8 }];
  const unhung = applyPlanPatch(suspended, dropHalf);
  assert.deepEqual(unhung.stale, [], "a suspension bridge can be erased too");
  assert.deepEqual(unhung.layout.landmarks.map((l) => l.id), ["landmark:arch"], "…and its towers and cables go with it, nothing else");
  assert.deepEqual(applyPlanPatch(suspended, fresh()).layout.landmarks.length, 2, "an empty patch keeps the landmark");
  const unhungVerdict = validateEdgeDrop(suspended, model, "220:60/244:60");
  assert.deepEqual(unhungVerdict.blockers, []);
  assert.ok(unhungVerdict.warnings.includes("erases-suspension-bridge"), `the user is told the towers go too: ${unhungVerdict.warnings}`);
  // 画的桥：两端各要 ≥6 的直引道（桥端直接压在路口/落笔点上是 7/2 桥头缺陷的形状），岸坡不能比车的爬坡能力陡。
  assert.deepEqual(validateRoadAdd(river(), model, { x: 195, z: -100 }, { x: 280, z: -100 }, 8).blockers, ["bridge-approach-short"], "a stroke starting at the water's edge leaves no approach");
  assert.deepEqual(validateRoadAdd(river(), model, { x: 150, z: -100 }, { x: 255, z: -100 }, 8).blockers, ["bridge-approach-short"], "…same on the far bank (an 8-wide road needs 16 of approach: its junction mouth reaches that far)");
  assert.deepEqual(validateRoadAdd(river(), model, { x: 150, z: -100 }, { x: 260, z: -100 }, 8).blockers, [], "…and 17 is enough");
  // 引道量到最近的路口：笔画在桥尾 4 处横穿一条现有路（自动开路口）也算太短。
  const crossedNear = river(); crossedNear.roadNodes = [...crossedNear.roadNodes, { id: "245:-150", x: 245, z: -150 }, { id: "245:-50", x: 245, z: -50 }];
  crossedNear.roadEdges = [...crossedNear.roadEdges, { id: "245:-150/245:-50", from: "245:-150", to: "245:-50", width: 5, kind: "local", points: [{ x: 245, z: -150 }, { x: 245, z: -50 }], structure: "ground-road" }];
  assert.deepEqual(validateRoadAdd(crossedNear, model, { x: 150, z: -100 }, { x: 280, z: -100 }, 8).blockers, ["bridge-approach-short"], "a crossing right behind the bridgehead is a junction at the bridgehead");
  assert.deepEqual(validateRoadAdd(crossedNear, model, { x: 140, z: -100 }, { x: 245, z: -100 }, 8).blockers, ["bridge-approach-short"], "…same when the stroke ends on that road");
  // 道路体检（修复升级 P0-A）：斜接桥头、陡岸桥头、陡路都进体检，修掉后消失。
  const oblique = river(); oblique.roadNodes = [...oblique.roadNodes, { id: "190:-60", x: 190, z: -60 }, { id: "197:-60", x: 197, z: -60 }, { id: "243:-60", x: 243, z: -60 }, { id: "250:-60", x: 250, z: -60 }, { id: "197:-90", x: 197, z: -90 }];
  const road = (a, b, extra = {}) => ({ id: `${a.x}:${a.z}/${b.x}:${b.z}`, from: `${a.x}:${a.z}`, to: `${b.x}:${b.z}`, width: 5, kind: "local", points: [a, b], structure: "ground-road", ...extra });
  oblique.roadEdges = [...oblique.roadEdges, road({ x: 197, z: -60 }, { x: 243, z: -60 }, { bridge: true, structure: "deck" }), road({ x: 243, z: -60 }, { x: 250, z: -60 }), road({ x: 197, z: -60 }, { x: 197, z: -90 })];
  // 合成城市 x=50 处地面高差 1（换地重算用的台阶），基础路段横跨它——只看本例加的路。
  const fixtureEdge = (issue) => makeLayout().roadEdges.some((e) => issue.entities.includes(e.id));
  const rules = (layout) => auditLayout(layout, model).filter((i) => (i.rule.startsWith("bridgehead") || i.rule === "roadSteep") && !fixtureEdge(i)).map((i) => `${i.rule}:${i.severity}`);
  assert.deepEqual(rules(oblique), ["bridgeheadOblique:error"], "a bridge whose only road off the west end turns 90° is an oblique bridgehead; the straight east end is fine");
  const obliqueFixed = fresh(); obliqueFixed.roadOps = [{ t: "drop", edge: "197:-60/243:-60" }];
  assert.deepEqual(rules(applyPlanPatch(oblique, obliqueFixed).layout), [], "erasing the bridge clears it");
  const banked = river(); const riverHeight = banked.terrain.height; banked.terrain = { ...banked.terrain, height: (x, z) => (x > 240 && x < 250 ? 3 + (250 - x) * 0.6 : riverHeight(x, z)) };
  banked.roadNodes = oblique.roadNodes; banked.roadEdges = [...river().roadEdges, road({ x: 197, z: -60 }, { x: 243, z: -60 }, { bridge: true, structure: "deck" }), road({ x: 243, z: -60 }, { x: 250, z: -60 }), road({ x: 190, z: -60 }, { x: 197, z: -60 })];
  assert.ok(rules(banked).includes("bridgeheadSteep:error"), `a 0.6 bank at the bridge's east end is a steep bridgehead: ${rules(banked)}`);
  const hill = makeLayout(); hill.terrain = { ...hill.terrain, height: (x, z) => (Math.hypot(x, z) < 400 ? 2 + Math.max(0, z) * (x > -60 && x < -40 ? 0.5 : 0) : -1) };
  hill.roadNodes = [...hill.roadNodes, { id: "-50:0", x: -50, z: 0 }, { id: "-50:60", x: -50, z: 60 }, { id: "-30:0", x: -30, z: 0 }, { id: "-30:60", x: -30, z: 60 }];
  hill.roadEdges = [...hill.roadEdges, road({ x: -50, z: 0 }, { x: -50, z: 60 }), road({ x: -30, z: 0 }, { x: -30, z: 60 })];
  assert.ok(auditLayout(makeLayout(), model).some((i) => i.rule === "roadSteep" && fixtureEdge(i)), "the fixture's own 1-unit step at x=50 is itself a road a car can't climb (and the audit says so)");
  assert.deepEqual(auditLayout(hill, model).filter((i) => i.rule === "roadSteep" && !fixtureEdge(i)).map((i) => `${i.id}:${i.severity}`), ["roadSteep:-50:0/-50:60:error"], "a road straight up a 0.5 slope is too steep for cars; the one beside it on flat ground is fine");
  // 画路坡度（修复升级 P0-B）：> 0.31 车开不上去 → 拦；> 0.2 → 提示；弧线同样；拖路口只拦「改陡了」的。
  const steepAdd = (layout, from, to) => validateRoadAdd(layout, model, from, to, 5);
  assert.ok(steepAdd(hill, { x: -55, z: 5 }, { x: -55, z: 55 }).blockers.includes("road-too-steep"), "a stroke straight up a 0.5 slope is refused");
  assert.ok(!steepAdd(hill, { x: -80, z: 5 }, { x: -80, z: 55 }).blockers.includes("road-too-steep"), "…the same stroke on flat ground is fine");
  const ramp = makeLayout(); ramp.terrain = { ...ramp.terrain, height: (x, z) => (Math.hypot(x, z) < 400 ? 2 + Math.max(0, z) * (x > -60 && x < -40 ? 0.25 : 0) : -1) };
  const rampAdd = steepAdd(ramp, { x: -55, z: 5 }, { x: -55, z: 55 });
  assert.ok(!rampAdd.blockers.includes("road-too-steep") && rampAdd.warnings.includes("road-steep"), `a 0.25 slope is climbable but flagged: ${rampAdd.blockers} / ${rampAdd.warnings}`);
  assert.ok(validateRoadAdd(hill, model, { x: -55, z: 5 }, { x: -52, z: 55 }, 5, undefined, [], { x: -45, z: 30 }).blockers.includes("road-too-steep"), "an arc up the slope is refused too");
  const steepNode = validateNodeMove(hill, model, "-50:60", { x: -50, z: 64 });
  assert.ok(!steepNode.blockers.includes("road-too-steep"), `nudging a junction on a road that was already steep is not blocked by its old grade: ${steepNode.blockers}`);
  const flatNode = validateNodeMove(hill, model, "-30:60", { x: -48, z: 60 });
  assert.ok(flatNode.blockers.includes("road-too-steep"), `dragging a flat road's junction up onto the slope is refused: ${flatNode.blockers}`);
  // 拖路口的「改陡了」按路段各比各的：路口一边是本来就陡（0.5）的路、另一边是平路，把平路拖到 0.33 也要拦。
  // 回归：曾拿所有被拖路段改前坡度的最大值当一个基准（0.5），平路变 0.33 < 0.5 就放行——画出了车开不上去的新陡路。
  const slope = makeLayout(); slope.terrain = { ...slope.terrain, height: (x, z) => (Math.hypot(x, z) < 400 ? 2 + Math.max(0, z) * 0.5 : -1) };
  slope.roadNodes = [...slope.roadNodes, { id: "-50:0", x: -50, z: 0 }, { id: "-50:60", x: -50, z: 60 }, { id: "-100:0", x: -100, z: 0 }];
  slope.roadEdges = [...slope.roadEdges, road({ x: -50, z: 0 }, { x: -50, z: 60 }), road({ x: -50, z: 0 }, { x: -100, z: 0 })];
  const mixedNode = validateNodeMove(slope, model, "-50:0", { x: -55, z: 40 });
  assert.ok(mixedNode.blockers.includes("road-too-steep"), `the flat leg dragged up to ~0.33 is refused even though the other leg was already 0.5: ${mixedNode.blockers}`);
  const mixedOk = validateNodeMove(slope, model, "-50:0", { x: -55, z: 4 });
  assert.ok(!mixedOk.blockers.includes("road-too-steep"), `a small nudge that keeps the flat leg gentle is fine: ${mixedOk.blockers} / ${mixedOk.warnings}`);
  const cliff = river(); const flat = cliff.terrain.height; cliff.terrain = { ...cliff.terrain, height: (x, z) => (x > 240 && x < 250 ? flat(x, z) + (250 - x) * 0.6 : flat(x, z)) };
  // 桥台延伸到缓坡（P0-C）：10 宽的陡岸压在加长的桥面下，车从缓坡上桥——原来拦，现在原地就能画。
  assert.deepEqual(validateRoadAdd(cliff, model, { x: 150, z: -100 }, { x: 290, z: -100 }, 8).blockers, [], "a short steep bank is bridged over by a longer abutment");
  const overCliff = fresh(); overCliff.roadOps = [{ t: "add", from: { x: 150, z: -100 }, to: { x: 290, z: -100 }, width: 8 }];
  const extended = applyPlanPatch(cliff, overCliff).layout.roadEdges.find((e) => e.bridge && e.points.every((q) => q.z === -100));
  assert.ok(extended && Math.max(...extended.points.map((q) => q.x)) >= 250 && Math.max(...extended.points.map((q) => q.x)) <= 239 + 20, `…the replayed deck reaches past the steep bank, within 20 of the water: ${JSON.stringify(extended?.points)}`);
  assert.ok(Math.min(...extended.points.map((q) => q.x)) > 195, "…and the gentle west bank keeps its 3-unit abutment");
  const ridge = river(); ridge.terrain = { ...ridge.terrain, height: (x, z) => (x > 240 && x < 275 ? flat(x, z) + (x - 240) * 0.6 : x >= 275 ? flat(x, z) + 21 : flat(x, z)) };
  assert.deepEqual(validateRoadAdd(ridge, model, { x: 150, z: -100 }, { x: 300, z: -100 }, 8).blockers, ["bridge-approach-steep"], "a bank steep for longer than the abutment can reach is still refused");
  const plateau = river(); plateau.terrain = { ...plateau.terrain, height: (x, z) => (x >= 240 ? 30 : flat(x, z)) };
  assert.deepEqual(validateRoadAdd(plateau, model, { x: 150, z: -100 }, { x: 290, z: -100 }, 8).blockers, ["bridge-approach-steep"], "a deck climbing a 27-high plateau over 45 would itself be too steep");
}

// (v) 弧线路。
{
  const arc = (from, via, to, width = 5) => { const patch = fresh(); patch.roadOps = [{ t: "add", from, to, width, via }]; return applyPlanPatch(makeLayout(), patch); };
  // 一段不碰任何路的弧线：(-150,150) → 经过 (-120,190) → (-90,150)。
  const free = arc({ x: -150, z: 150 }, { x: -120, z: 190 }, { x: -90, z: 150 });
  assert.equal(free.stale.length, 0, `a free arc replays cleanly — ${JSON.stringify(free.stale)}`);
  const laid = free.layout.roadEdges.filter((e) => !makeLayout().roadEdges.some((o) => o.id === e.id));
  assert.equal(laid.length, 1, "one edge, laid as a polyline");
  const expected = curvePoints({ x: -150, z: 150 }, { x: -120, z: 190 }, { x: -90, z: 150 });
  assert.deepEqual(laid[0].points, expected, "…exactly the curve validation previews");
  assert.ok(laid[0].points.some((q) => Math.hypot(q.x + 120, q.z - 190) < 0.5), "…and it passes through the clicked bend point");
  // 穿过 E4（x=100 的南北向路）：弧线 (60,40) → 经过 (100,70) → (140,40)，交点处自动开路口、断成两段。
  const crossing = arc({ x: 60, z: 40 }, { x: 100, z: 70 }, { x: 140, z: 40 });
  assert.equal(crossing.stale.length, 0, `an arc over an existing road replays — ${JSON.stringify(crossing.stale)}`);
  const pieces = crossing.layout.roadEdges.filter((e) => e.points.length > 2);
  assert.equal(pieces.length, 2, "the arc is cut at the junction it makes");
  const junction = pieces[0].to === pieces[1].from || pieces[0].to === pieces[1].to ? pieces[0].to : pieces[0].from;
  assert.ok(crossing.layout.roadEdges.filter((e) => e.from === junction || e.to === junction).length === 4, "…a real 4-way junction with the host road split too");
  const arcWarnings = validateRoadAdd(makeLayout(), model, { x: 60, z: 40 }, { x: 140, z: 40 }, 5, undefined, [], { x: 100, z: 70 }).warnings;
  assert.ok(arcWarnings.includes("auto-junction:1"), `validation agrees: one auto junction (the bend point sits on the road) — ${arcWarnings}`);
  // 弯太急：同一个弯，小路（最小半径 15）能画，主干道（36）不行。
  const tight = [{ x: -150, z: 150 }, { x: -130, z: 158 }, { x: -110, z: 150 }]; // 抛物线顶点半径 L²/2h = 20²/16 = 25
  const r = polylineMinRadius(curvePoints(...tight));
  assert.ok(r > minCurveRadius(5) && r < minCurveRadius(12), `fixture bend radius sits between the lane and main-road limits: ${r}`);
  assert.deepEqual(validateRoadAdd(makeLayout(), model, tight[0], tight[2], 5, undefined, [], tight[1]).blockers, [], "a lane can take the tight bend");
  assert.ok(validateRoadAdd(makeLayout(), model, tight[0], tight[2], 12, undefined, [], tight[1]).blockers.includes("curve-too-tight"), "…a main road cannot");
  // 过水：弧线鼓到岛外（半径 380 外不可建）。
  assert.ok(validateRoadAdd(makeLayout(), model, { x: 300, z: 150 }, { x: 300, z: 220 }, 5, undefined, [], { x: 360, z: 185 }).blockers.includes("curve-over-water"), "an arc that bulges into the sea is refused");
  const wet = fresh(); wet.roadOps = [{ t: "add", from: { x: 300, z: 150 }, to: { x: 300, z: 220 }, width: 5, via: { x: 360, z: 185 } }];
  assert.deepEqual(applyPlanPatch(makeLayout(), wet).stale.map((x) => x.reason), ["road-in-water"], "…and goes stale on replay");
  const read = coercePlanPatch({ ...fresh(), roadOps: [{ t: "add", from: { x: 0, z: 0 }, to: { x: 9, z: 0 }, width: 5, via: { x: 4, z: 3 } }, { t: "add", from: { x: 0, z: 0 }, to: { x: 9, z: 0 }, width: 5, via: "bad" }] });
  assert.deepEqual([read.roadOps[0].via, read.roadOps[1].via], [{ x: 4, z: 3 }, undefined], "storage reads via back; a bad via degrades to a straight road");
}

// (r) 高架日志。底层高架：(-50,20) → (250,20)。
{
  assert.equal(VIADUCT_DECK_WIDTH, EXPRESSWAY_DECK_WIDTH, "rule-side deck width matches the renderer");
  assert.equal(VIADUCT_RAMP, EXPRESSWAY_RAMP, "rule-side ramp length matches the renderer");
  const add = appendHighwayOp(fresh(), { t: "add", points: [{ x: -50, z: 200 }, { x: 150, z: 200 }, { x: 300, z: 250 }] }, 1);
  const added = applyPlanPatch(makeLayout(), add);
  assert.equal(added.stale.length, 0);
  assert.equal(added.layout.highways.length, 2, "a new viaduct is a new run");
  // 接到已有高架的开口端（250,20）：拼成一条，不多出两段匝道。
  const extend = appendHighwayOp(fresh(), { t: "add", points: [{ x: 255, z: 22 }, { x: 350, z: 120 }] }, 1);
  const extended = applyPlanPatch(makeLayout(), extend).layout;
  assert.equal(extended.highways.length, 1, "starting at an open end extends that viaduct");
  assert.deepEqual(extended.highways[0][0], { x: -50, z: 20 }); assert.deepEqual(extended.highways[0].at(-1), { x: 350, z: 120 });
  // 切：在 (100,20) 切一刀 → 两条，切口各 20。
  const cut = appendHighwayOp(fresh(), { t: "cut", at: { x: 100, z: 21 } }, 1);
  const cutLayout = applyPlanPatch(makeLayout(), cut).layout;
  assert.equal(cutLayout.highways.length, 2, "a cut splits the viaduct in two");
  assert.deepEqual(cutLayout.highways[0].at(-1), { x: 80, z: 20 }); assert.deepEqual(cutLayout.highways[1][0], { x: 120, z: 20 });
  const missed = applyPlanPatch(makeLayout(), appendHighwayOp(fresh(), { t: "cut", at: { x: 100, z: 120 } }, 1));
  assert.deepEqual(missed.stale.map((x) => `${x.kind}:${x.reason}`), ["highway-cut:missing-highway"], "cutting where there is no viaduct goes stale");
  const degenerate = applyPlanPatch(makeLayout(), appendHighwayOp(fresh(), { t: "add", points: [{ x: 0, z: 300 }, { x: 0.3, z: 300 }] }, 1));
  assert.deepEqual(degenerate.stale.map((x) => x.reason), ["degenerate"]);
  // 新高架下的地块不再能落楼（落位判定看改过的高架）。
  const over = appendHighwayOp(fresh(), { t: "add", points: [{ x: 300, z: 200 }, { x: 300, z: 400 }] }, 1);
  assert.ok(validateBuildingMove(applyPlanPatch(makeLayout(), over).layout, model, fresh(), "b1", "p4").blockers.includes("highway-clearance"), "a parcel under a new viaduct loses its clearance");
  // 校验：太短 / 端点在水里 / 接上已有高架 / 压到会话楼要安置。
  assert.deepEqual(validateHighwayAdd(makeLayout(), model, [{ x: 0, z: 300 }, { x: 10, z: 300 }]).blockers, ["viaduct-too-short"]);
  assert.ok(validateHighwayAdd(makeLayout(), model, [{ x: 0, z: 300 }, { x: 390, z: 300 }]).blockers.includes("viaduct-end-in-water"), "a ramp cannot land in the sea");
  assert.ok(validateHighwayAdd(makeLayout(), model, [{ x: 250, z: 20 }, { x: 250, z: 200 }]).warnings.includes("joins-viaduct"));
  assert.ok(validateHighwayAdd(makeLayout(), model, [{ x: 0, z: -200 }, { x: 60, z: -200 }]).warnings.includes("short-viaduct"), "under 180 the deck never reaches full height");
  assert.ok(validateHighwayAdd(makeLayout(), model, [{ x: 300, z: 150 }, { x: 300, z: 350 }]).warnings.some((w) => w.startsWith("relocate:")), "a session building under the deck is re-homed, like under a road");
  // 存档与指纹：读回；没有高架操作时指纹与旧补丁一致。
  const read = coercePlanPatch({ ...fresh(), highwayOps: [{ t: "add", points: [{ x: 0, z: 0 }, { x: 9, z: 0 }] }, { t: "add", points: [{ x: 0, z: 0 }] }, { t: "cut", at: { x: 1, z: 2 } }, { t: "zap" }] });
  assert.equal(read.highwayOps.length, 2, "valid viaduct ops are read back; malformed ones are dropped");
  const plain = fresh(); plain.roadOps = [{ t: "drop", edge: "x" }];
  assert.equal(hashPlanPatch(plain), hashPlanPatch({ ...plain, highwayOps: [] }), "an empty viaduct log does not change the patch fingerprint");
}

// (w) 体检来源标注：生成城市自带的问题标 generated，补丁带来的新问题标 edit，补丁失效条目不标。
{
  const base = [{ id: "buildingOverRoad:a", severity: "error", rule: "buildingOverRoad", at: { x: 0, z: 0 }, detail: "x", entities: ["a"] }];
  const patched = [...base,
    { id: "buildingOverRoad:b", severity: "error", rule: "buildingOverRoad", at: { x: 1, z: 1 }, detail: "y", entities: ["b"] },
    { id: "patchStale:road-add:r1", severity: "info", rule: "patchStale", at: null, detail: "z", entities: ["r1"] }];
  const tagged = tagAuditOrigins(patched, base);
  assert.equal(tagged[0].origin, "generated", "an issue already in the unedited city is the generator's");
  assert.equal(tagged[1].origin, "edit", "a new issue after edits comes from the edits");
  assert.equal(tagged[2].origin, undefined, "stale patch entries are not city issues and carry no origin");
  assert.ok(tagAuditOrigins(base, null).every((issue) => issue.origin === "generated"), "no patch → everything is the generated city's");
  assert.equal(base[0].origin, undefined, "tagging does not mutate its input");
}

console.log("City plan patch: corners are filleted when a stroke turns off a dead end, the seaside promenade follows waterfront roads, viaducts are drawn/extended/cut with honest stale entries, deterministic (building moves order-independent, road ops replayed in log order), building-move replay is a no-op, stale entries degrade honestly (missing/locked/occupied/collision/tier/context/duplicate/degenerate), node moves re-key ids/edges/cul-de-sacs, drawn roads snap to nodes/split host edges/create free ends and halves of a split can be dropped later, failed adds leave no half-done split, edge drops prune nodes and filter car paths, building-move blockers (occupied/missing/road/slope/buildable/highway/overlap) hold, storage coercion never throws, layout audit is severity-sorted and quiet on generated cities, layout pins place moved buildings before road pruning and survive refresh.");
