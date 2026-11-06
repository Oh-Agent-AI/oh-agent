#!/usr/bin/env node
// 规划修复放权（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §15，参考 SimCity）守卫：
//   (a) 推土机：新路压到非会话设施 → 随这一笔推平；压到会话楼 → 开发商就近安置到合法空地块（不拆）；
//       生成器原本就压着的（残余）不算这一笔的，不会被顺手拆/搬；附近无空地块 → homeless 如实上报；
//   (b) 新几何判定：被拆成两半的旧路不算「新路面」，不会因为拆路把两侧的楼当成被压到；
//   (c) 致敬地标与市政用地：可拆除、可搬到任意空地（free 级，目标 "@x,z"）；圆内地形/道路/建筑检查；
//       唯一锁定的是悬索桥（不是建筑，是桥面）；海上地标与港口也可以动（用户拍板「所有建筑都可以移动」）；
//   (d) 搬走的地标会让它圆内的地块算占用，会话楼不能被搬进去；
//   (e) 真实城市：画一条横穿城区的路，推平与安置后补丁干净重放、没有会话楼仍压在新路上（除非 homeless）；
//       搬一座地标并补接入路，干净重放（SPEC §16.3）；
//   (f) 接入路：新位置离路远就补一条最短的、不推平不安置的接入路；挨着路不补；原址断头接入路沿单行链列出，到岔路口为止；
//   (g) 清除失效修改：只删失效条目，其余重放结果不变；跨档整份失效 → 空补丁；
//   (i) 提速不改结果（路线图 SPEC P0-1）：网格版净空 = 逐条版；网格邻域不漏路；钉子不变时重排 = 缓存的底层布局；
//   (j) 自由级设施按模型真实占地：车站是矩形不是预留圆、能贴路（正门朝路、前沿离路肩 ROAD_SETBACK）、贴上后不需要接入路、
//       [ / ] 转向、接到正门的路不算压到它（穿过它的路才算）——用户截图：车站按圆占地，贴不上路、接入路断在草地上；
//   (k) 两层投影：有物理声明的模型（摩天轮/凯旋门/歌剧院陆侧）用声明——地面占地管地形与正门，俯视投影（∪ 悬挑 ∪ 运动包络）
//       管路与楼的碰撞；摩天轮转盘竖在 x-y 平面，俯视是窄条不是圆（用户：摩天轮、港口不该是圆）；海上歌剧院、港口仍是名义圆；
//   (h) 高架下不能有楼：新高架压到的设施推平、会话楼安置；切高架不算新几何；真实城市跨河高架 + 滨海大道干净重放（SPEC §17）。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

globalThis.window ??= globalThis;
const {
  bulldozeForRoads, freshRoadGeometry, applyPlanPatch, emptyPlanPatch, appendRoadOp, appendSiteOp, listSites, siteMoveProblem, reservedParcelIds,
  validateRoadAdd, rectClearOfEdges, buildingRect, buildCityModel, layoutCity, MIAMI_COASTAL,
  accessRoadFor, strandedAccessEdges, pruneStalePatch, appendHighwayOp, validateHighwayAdd, freshViaductGeometry,
  rectClearOfRoads, edgesNear, clearanceRoads, rectClearOfEdgesRaw, nearestOnPolyline,
  validateRestyle, autoPlaceFree, formatFreeTarget, siteTouchesRoad, frontEntrance, worldParts, segmentPolygonDistance, ROAD_SETBACK, siteFootprint, roadImpact,
} = await loadCity({
  "engine/planFootprint.ts": ["frontEntrance", "worldParts", "segmentPolygonDistance", "ROAD_SETBACK", "siteFootprint"],
  "engine/planGeometry.ts": ["rectClearOfRoads", "edgesNear", "clearanceRoads", "rectClearOfEdges as rectClearOfEdgesRaw"],
  "engine/planAccess.ts": ["accessRoadFor", "strandedAccessEdges", "siteTouchesRoad"],
  "engine/planBulldozer.ts": ["bulldozeForRoads", "freshRoadGeometry", "freshViaductGeometry"],
  "engine/planPatch.ts": ["applyPlanPatch", "emptyPlanPatch", "appendRoadOp", "appendSiteOp", "reservedParcelIds", "rectClearOfEdges", "buildingRect", "pruneStalePatch", "appendHighwayOp", "nearestOnPolyline"],
  "engine/planSites.ts": ["listSites", "siteMoveProblem", "autoPlaceFree", "formatFreeTarget"],
  "engine/planRoadRules.ts": ["validateRoadAdd", "validateHighwayAdd", "validateRestyle", "roadImpact"],
  "cityModel.ts": ["buildCityModel"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

// ── 合成城市 ── 一条东西向主路 z=0（0..300），路北是两排地块；一栋会话楼 b1 在 (100,30)，一栋背景楼在 (160,30)，
// 一栋会话楼 b2 原本就压在路上（生成器残余）在 (220,0)。一座致敬地标（摩天轮）在 (60,-80)、一座悬索桥、一座港口。
const terrain = { height: () => 2, slope: () => 0.1, buildable: (x, z) => x < 400 && z > -150, center: { x: 0, z: 0 }, radius: 500, coastRadius: () => 500, hasRiver: false };
const parcel = (id, blockId, x, z) => ({ id, blockId, x, z, yaw: 0, zone: "residential", width: 8, depth: 8 });
const rowA = Array.from({ length: 10 }, (_, i) => parcel(`a${i}`, "A", 20 + i * 30, 30));
const rowB = Array.from({ length: 10 }, (_, i) => parcel(`b${i}`, "B", 20 + i * 30, 60));
const edge = (from, to, width = 5, extra = {}) => {
  const [fx, fz] = from.split(":").map(Number); const [tx, tz] = to.split(":").map(Number);
  return { id: [from, to].sort().join("/"), from, to, width, kind: "local", points: [{ x: fx, z: fz }, { x: tx, z: tz }], structure: "ground-road", ...extra };
};
const model = {
  windowStartMs: 0, windowEndMs: 1, windowLabel: "t", generatedAt: 1,
  districts: [{ id: "d0", label: "D0", sessionCount: 2, tokensTotal: 0, activeCount: 0, anomaly: null }],
  buildings: ["b1", "b2"].map((id) => ({ id, districtId: "d0", footprint: 5, height: 10, archetype: "block" })),
};
function makeLayout() {
  const slots = new Map([["b1", rowA[3]], ["b2", parcel("onroad", "R", 220, 0)]]); // a3 = (110,30)
  return {
    seed: 1, scaleTier: 1, activityKey: "k", terrain,
    blocks: [{ id: "A", districtId: "d0", x: 155, z: 30, width: 300, depth: 10, zone: "residential", parcels: rowA, polygon: [] },
      { id: "B", districtId: "d0", x: 155, z: 60, width: 300, depth: 10, zone: "residential", parcels: rowB, polygon: [] }],
    roadNodes: [{ id: "0:0", x: 0, z: 0 }, { id: "300:0", x: 300, z: 0 }], roadEdges: [edge("0:0", "300:0")], culDeSacEnds: [],
    civics: [], gardens: [], districtLandmarks: [],
    contextBuildings: [{ id: "context:a5", x: 170, z: 30, y: 2, yaw: 0, width: 8, depth: 8, height: 15, seed: 0.5, zone: "residential", appearAt: 0 }],
    landmarks: [{ id: "landmark:ferris-wheel", kind: "ferris-wheel", x: 60, z: -80, yaw: 0, radius: 18 },
      { id: "landmark:suspension-bridge", kind: "suspension-bridge", x: 250, z: -80, yaw: 0, radius: 15, to: { x: 300, z: -80 } },
      { id: "landmark:sail-opera", kind: "sail-opera", x: 150, z: -120, yaw: 0, radius: 14, shore: { x: 150, z: -100 } }],
    publicSites: [{ id: "site:harbor", kind: "harbor", x: 330, z: -60, yaw: 0, radius: 12 }],
    highways: [],
    districts: [{ id: "d0", label: "D0", center: { x: 150, z: 30 }, radius: 300, terrain, slots, grounds: new Map([["b1", 2], ["b2", 2]]), roads: [], carPaths: [], river: null, riverHalfWidth: 0, trees: [], plaza: { x: 0, z: 0, y: 2 }, anomaly: null, sessionCount: 2 }],
  };
}
const fresh = () => emptyPlanPatch(1, 1);
const slotOf = (layout, id) => layout.districts.flatMap((d) => [...d.slots]).find(([b]) => b === id)?.[1];

// (a) 推土机：一条南北向新路从 (110,-20) 到 (110,90)，穿过 b1（110,30）。再一条穿过背景楼 (170,30)。
{
  const base = makeLayout();
  const verdict = validateRoadAdd(base, model, { x: 110, z: 0 }, { x: 110, z: 90 }, 5);
  assert.deepEqual(verdict.blockers, [], "a road through a session building is allowed");
  assert.ok(verdict.warnings.includes("relocate:1"), `…and the developer re-home is announced — ${verdict.warnings}`);
  const patch = appendRoadOp(fresh(), { t: "add", from: { x: 110, z: 0 }, to: { x: 110, z: 90 }, width: 5 }, 1);
  const result = bulldozeForRoads(base, model, base, patch);
  assert.equal(result.relocated.length, 1); assert.equal(result.relocated[0].id, "b1");
  assert.deepEqual(result.bulldozed, []); assert.deepEqual(result.homeless, []);
  const after = applyPlanPatch(base, result.patch).layout;
  const newRoad = after.roadEdges.filter((e) => e.points.some((p) => p.x === 110 && p.z === 90));
  const home = slotOf(after, "b1");
  assert.notEqual(home.id, "a3", "b1 left its parcel");
  assert.ok(rectClearOfEdges(buildingRect(model.buildings[0], home), newRoad, 0.5), "…and its new parcel is clear of the new road");
  assert.ok(Math.hypot(home.x - 110, home.z - 30) <= 60, "…and it was re-homed nearby (nearest legal parcel)");
  assert.ok(after.districts[0].slots.has("b1"), "a session building is never removed — only moved");

  const throughContext = appendRoadOp(fresh(), { t: "add", from: { x: 170, z: 0 }, to: { x: 170, z: 90 }, width: 5 }, 1);
  const razed = bulldozeForRoads(base, model, base, throughContext);
  assert.deepEqual(razed.bulldozed, ["context:a5"], "a context building in the way is bulldozed with the road");
  assert.equal(applyPlanPatch(base, razed.patch).layout.contextBuildings.length, 0);
  assert.equal(applyPlanPatch(base, razed.patch).stale.length, 0, "road + bulldoze replay cleanly together");

  // 残余：b2 原本就压在主路上——画一条与主路相交的新路经过附近，不应把 b2 当成这一笔压到的。
  const nearResidual = appendRoadOp(fresh(), { t: "add", from: { x: 220, z: -40 }, to: { x: 220, z: -4 }, width: 5 }, 1);
  const residual = bulldozeForRoads(base, model, base, nearResidual);
  assert.ok(!residual.relocated.some((r) => r.id === "b2"), "a building the generator left on a road is not this stroke's casualty");

  // 无处安置：把所有空地块都填满再压 b1 → homeless 如实上报，补丁里不硬塞。
  const crowded = makeLayout();
  crowded.contextBuildings = [...rowA, ...rowB].filter((p) => p.id !== "a3").map((p) => ({ id: `context:${p.id}`, x: p.x, z: p.z, y: 2, yaw: 0, width: 8, depth: 8, height: 10, seed: 0.1, zone: "residential", appearAt: 0 }));
  const squeezed = bulldozeForRoads(crowded, model, crowded, appendRoadOp(fresh(), { t: "add", from: { x: 110, z: 0 }, to: { x: 110, z: 15 }, width: 5 }, 1));
  assert.ok(squeezed.homeless.includes("b1") || squeezed.relocated.every((r) => r.id !== "b1"), "with no free parcel the building is reported homeless, not forced");
}

// (b) 新几何：交叉把旧路拆成两半——两半不是新路面。
{
  const base = makeLayout();
  const crossing = appendRoadOp(fresh(), { t: "add", from: { x: 150, z: -40 }, to: { x: 150, z: -10 }, width: 5 }, 1);
  const after = applyPlanPatch(base, crossing).layout;
  const geometry = freshRoadGeometry(base, after);
  assert.equal(geometry.length, 1, "only the new stroke is new geometry");
  const crossed = appendRoadOp(fresh(), { t: "add", from: { x: 150, z: -40 }, to: { x: 150, z: 20 }, width: 5 }, 1);
  const split = applyPlanPatch(base, crossed).layout;
  assert.ok(split.roadEdges.some((e) => e.id === "0:0/150:0") && split.roadEdges.some((e) => e.id === "150:0/300:0"), "the main road is split at the crossing");
  assert.equal(freshRoadGeometry(base, split).length, 2, "the two new pieces are new geometry; the two halves of the old road are not");
}

// (c) 致敬地标与市政用地。
{
  const base = makeLayout();
  const sites = new Map(listSites(base).map((s) => [s.id, s]));
  const wheel = sites.get("landmark:ferris-wheel"); const bridge = sites.get("landmark:suspension-bridge");
  const opera = sites.get("landmark:sail-opera"); const harbor = sites.get("public:site:harbor");
  assert.equal(wheel.level, "free"); assert.equal(wheel.locked, undefined);
  assert.ok(bridge.locked && /悬索桥/.test(bridge.locked), "the suspension bridge is the one locked object — it is part of the road network");
  assert.equal(opera.locked, undefined, "a sea landmark can be moved (user: every building is movable)");
  assert.equal(harbor.locked, undefined, "the harbor can be moved too");
  assert.equal(siteMoveProblem(base, wheel, "@60,-100"), null, "open ground accepts the wheel");
  assert.equal(siteMoveProblem(base, wheel, "@60,5"), "site-over-road", "the wheel cannot sit on the main road");
  assert.equal(siteMoveProblem(base, wheel, "@110,30"), "target-occupied", "nor on a session building");
  // 真实占地（平台 20×8 + 转盘俯视窄条 57×5）比旧的名义圆（r 18）小：中心离会话楼 10 已经碰不到——旧圆在这里算占用。
  assert.equal(siteMoveProblem(base, wheel, "@110,42"), null, "the wheel's real footprint clears a session building its nominal circle would have hit");
  assert.equal(siteMoveProblem(base, wheel, "@60,-148"), "not-buildable", "nor half in the sea");
  assert.equal(siteMoveProblem(base, wheel, "@60,-140"), null, "…but its platform (z ±4) may stand right at the shore — only the ground footprint needs buildable land");
  assert.equal(siteMoveProblem(base, wheel, "nope"), "missing-target");
  assert.equal(siteMoveProblem(base, bridge, "@60,-100"), "site-locked");
  const moved = applyPlanPatch(base, appendSiteOp(fresh(), { t: "move", id: "landmark:ferris-wheel", at: { x: 60, z: -80 }, to: "@60,-100" }, 1));
  assert.equal(moved.stale.length, 0);
  assert.deepEqual([moved.layout.landmarks[0].x, moved.layout.landmarks[0].z], [60, -100], "the wheel moved");
  const razed = applyPlanPatch(base, appendSiteOp(appendSiteOp(fresh(), { t: "remove", id: "landmark:sail-opera", at: { x: 150, z: -120 } }, 1), { t: "remove", id: "public:site:harbor", at: { x: 330, z: -60 } }, 2));
  assert.equal(razed.stale.length, 0);
  assert.ok(!razed.layout.landmarks.some((l) => l.id === "landmark:sail-opera") && razed.layout.publicSites.length === 0, "landmarks and public sites can be removed");
  const lockedTry = applyPlanPatch(base, appendSiteOp(fresh(), { t: "remove", id: "landmark:suspension-bridge" }, 1));
  assert.deepEqual(lockedTry.stale.map((s) => s.reason), ["site-blocked"], "removing the locked bridge goes stale, not through");
}

// (d) 搬到地块上的地标：圆内地块算占用。
{
  const base = makeLayout();
  const onto = applyPlanPatch(base, appendSiteOp(fresh(), { t: "move", id: "landmark:ferris-wheel", at: { x: 60, z: -80 }, to: "@200,62" }, 1));
  // (200,62) 的俯视投影（转盘窄条 x 171..229）盖住 b 排地块，但不压会话楼/路——放下后占地内的地块应被占用。
  if (onto.stale.length === 0) {
    const reserved = reservedParcelIds(onto.layout);
    assert.ok(reserved.has("b6"), "parcels under a relocated landmark are reserved");
  } else {
    assert.deepEqual(onto.stale.map((s) => s.reason), ["site-blocked"], "if the target is refused it is reported, not half-applied");
  }
}

// (f) 接入路与原址断头路。主路拆成 0:0–60:0–300:0，摩天轮 (60,-80) 的接入点是断头路口 60:-60（经 60:-60/60:0 接主路）。
{
  const base = makeLayout();
  base.roadNodes = [{ id: "0:0", x: 0, z: 0 }, { id: "60:0", x: 60, z: 0 }, { id: "300:0", x: 300, z: 0 }, { id: "60:-60", x: 60, z: -60 }];
  base.roadEdges = [edge("0:0", "60:0"), edge("60:0", "300:0"), edge("60:-60", "60:0")];
  base.landmarks[0] = { ...base.landmarks[0], access: { role: "plot-gate", nodeId: "60:-60", ownerX: 60, ownerZ: -80, ownerYaw: 0 } };
  const wheel = listSites(base).find((s) => s.id === "landmark:ferris-wheel");
  // 搬到 (200,-60)：离主路 60 → 补接入路；原址那截断头路留下。
  const target = "@200,-60";
  assert.equal(siteMoveProblem(base, wheel, target), null);
  const movedPatch = appendSiteOp(fresh(), { t: "move", id: wheel.id, at: { x: wheel.x, z: wheel.z }, to: target }, 1);
  const moved = applyPlanPatch(base, movedPatch).layout;
  const placedAt = (layout, id) => listSites(layout).find((candidate) => candidate.id === id);
  const road = accessRoadFor(moved, model, placedAt(moved, wheel.id));
  assert.ok(road, "a site moved away from roads gets an access road");
  assert.equal(road.to.z, 0, "…ending on the main road");
  assert.ok(Math.abs(road.to.x - 200) < 1, "…at the nearest point");
  // 起笔在正门（占地 +z 面中点），不再在名义预留圆的外接方形外——曾离建筑大半个半径，路像断在草地上（用户截图：车站）。
  // 摩天轮的正门 = 地面占地（平台 + 腿条带 + 售票亭）+z 面中点：x 跨 −10..10.5 → 中点 0.25；z 前沿 4。
  assert.deepEqual(road.from, { x: 200.25, z: -56 }, "…starting right at the front door, not half a radius out in the grass");
  const withRoad = appendRoadOp(movedPatch, { t: "add", from: road.from, to: road.to, width: 5 }, 2);
  const after = applyPlanPatch(base, withRoad);
  assert.equal(after.stale.length, 0, "move + access road replay cleanly");
  assert.equal(bulldozeForRoads(base, model, moved, withRoad).bulldozed.length, 0, "the access road bulldozes nothing (else it would not have been offered)");
  const stranded = strandedAccessEdges(after.layout, { x: 60, z: -80 }, wheel.width / 2, "60:-60", new Set(moved.roadEdges.map((e) => e.id)));
  assert.deepEqual(stranded, ["60:-60/60:0"], "the old dead-end access road is listed, and the walk stops at the junction with the main road");
  // 挨着路：不补。
  const close = applyPlanPatch(base, appendSiteOp(fresh(), { t: "move", id: wheel.id, at: { x: wheel.x, z: wheel.z }, to: "@200,-9.5" }, 1)).layout; // 正门 z −5.5，离路肩 3
  assert.equal(accessRoadFor(close, model, placedAt(close, wheel.id)), null, "a site whose front door is already at the road gets no extra road");
  // 搬到旧接入路旁：接入路接到断头路口上，它不再是断头路——不列为遗留。
  const reuse = applyPlanPatch(base, appendSiteOp(fresh(), { t: "move", id: wheel.id, at: { x: wheel.x, z: wheel.z }, to: "@60,-110" }, 1)).layout;
  const reuseRoad = accessRoadFor(reuse, model, placedAt(reuse, wheel.id));
  assert.ok(reuseRoad && Math.hypot(reuseRoad.to.x - 60, reuseRoad.to.z + 60) < 1, "moving next to the old access road reuses its dead end");
  const reused = applyPlanPatch(base, appendRoadOp(appendSiteOp(fresh(), { t: "move", id: wheel.id, at: { x: wheel.x, z: wheel.z }, to: "@60,-110" }, 1), { t: "add", from: reuseRoad.from, to: reuseRoad.to, width: 5 }, 2)).layout;
  assert.deepEqual(strandedAccessEdges(reused, { x: 60, z: -80 }, wheel.width / 2, "60:-60", new Set(reuse.roadEdges.map((e) => e.id))), [], "…and it is no longer a leftover (the new road's own end does not start a walk into it)");
  // 远到 160 以外没有路：不补，交给用户画。
  const far = { ...base, roadNodes: [{ id: "0:0", x: 0, z: 0 }, { id: "60:0", x: 60, z: 0 }], roadEdges: [edge("0:0", "60:0")] };
  assert.equal(accessRoadFor(far, model, { ...placedAt(base, wheel.id), x: 300, z: -120, box: undefined }), null, "no road within reach → none is invented");
}

// (g) 清除失效修改。
{
  const base = makeLayout();
  let patch = appendSiteOp(fresh(), { t: "move", id: "landmark:ferris-wheel", at: { x: 60, z: -80 }, to: "@60,-100" }, 1);
  patch = appendSiteOp(patch, { t: "remove", id: "civic:9", at: { x: 0, z: 0 } }, 2);
  patch = appendRoadOp(patch, { t: "drop", edge: "nope/nope" }, 3);
  patch = appendRoadOp(patch, { t: "add", from: { x: 110, z: -40 }, to: { x: 110, z: -10 }, width: 5 }, 4);
  patch = { ...patch, buildingMoves: { b1: "a7", ghost: "a8" } };
  const before = applyPlanPatch(base, patch);
  assert.equal(before.stale.length, 3, `three stale entries — ${before.stale.map((s) => s.id)}`);
  const pruned = pruneStalePatch(patch, before.stale, 9);
  assert.equal(pruned.siteOps.length, 1); assert.equal(pruned.roadOps.length, 1); assert.deepEqual(Object.keys(pruned.buildingMoves), ["b1"]);
  const after = applyPlanPatch(base, pruned);
  assert.equal(after.stale.length, 0, "nothing stale remains");
  const shape = (l) => JSON.stringify({ e: l.roadEdges.map((e) => e.id).sort(), lm: l.landmarks.map((x) => [x.id, x.x, x.z]), s: [...l.districts[0].slots].map(([k, v]) => [k, v.id]) });
  assert.equal(shape(after.layout), shape(before.layout), "pruning stale entries does not change what the rest of the patch does");
  assert.equal(pruneStalePatch({ ...patch, scaleTier: 2 }, [{ kind: "road-add", id: "1:add", reason: "tier-changed", detail: "" }]), null, "a tier-changed patch prunes to nothing");
  assert.equal(pruneStalePatch(patch, []), patch, "no stale entries → unchanged");
}

// (h) 高架下不能有楼（合成城市：高架 z=30 横穿 a 排地块）。
{
  const base = makeLayout(); base.highways = [];
  const verdict = validateHighwayAdd(base, model, [{ x: -50, z: 30 }, { x: 350, z: 30 }]);
  assert.deepEqual(verdict.blockers, []);
  assert.ok(verdict.warnings.includes("relocate:1") && verdict.warnings.includes("bulldoze:1"), `a viaduct over b1 and the context building re-homes / bulldozes them — ${verdict.warnings}`);
  const patch = appendHighwayOp(fresh(), { t: "add", points: [{ x: -50, z: 30 }, { x: 350, z: 30 }] }, 1);
  const result = bulldozeForRoads(base, model, base, patch);
  assert.deepEqual(result.bulldozed, ["context:a5"]); assert.deepEqual(result.relocated.map((r) => r.id), ["b1"]);
  const after = applyPlanPatch(base, result.patch).layout;
  assert.ok(Math.abs(slotOf(after, "b1").z - 30) > 8, "b1 moved off the deck's row");
  // 切一刀：切口两侧都在旧高架上，不是新几何——不会因为切高架去推平谁。
  const withDeck = { ...base, highways: [[{ x: -50, z: 30 }, { x: 350, z: 30 }]] };
  const cut = applyPlanPatch(withDeck, appendHighwayOp(fresh(), { t: "cut", at: { x: 100, z: 30 } }, 1)).layout;
  assert.equal(freshViaductGeometry(withDeck, cut).length, 0, "the two halves of a cut viaduct are not new geometry");
}

// (j) 自由级设施的真实占地与朝向（车站，radius 20）。主路 z=0（0..300）。
{
  const base = makeLayout(); base.publicSites = [{ id: "site:station", kind: "station", x: 150, z: -90, yaw: 0, radius: 20 }];
  const station = listSites(base).find((site) => site.id === "public:site:station");
  assert.equal(station.footprint.exact, true, "the station has a real footprint");
  assert.ok(Math.abs(station.width - 30) < 1e-6, `…its width is the platform (1.5r), not the reservation circle (2r): ${station.width}`);
  assert.ok(station.depth < 2 * 20 + 1 && station.depth > 1.1 * 20, `…and its depth is platform + hall: ${station.depth}`);
  // 旧规则：路离中心 ≥ 0.75r + 半路宽 = 17.5。真实占地：前沿 + 1 + 半路宽即可。
  const near = formatFreeTarget({ x: 150, z: -16, yaw: 0 });
  assert.equal(siteMoveProblem(base, station, near), null, "the station can sit right by the road (front edge 1.5 from the shoulder) — the circle rule forbade anything within 17.5");
  assert.equal(siteMoveProblem(base, station, formatFreeTarget({ x: 150, z: -12, yaw: 0 })), "site-over-road", "…but not on it");
  // 自动落位：点在路北侧 30 处 → 转身正门朝路、前沿离路肩 ROAD_SETBACK。
  const placed = autoPlaceFree(base, station, { x: 150, z: -40 });
  assert.ok(Math.abs(placed.yaw) < 1e-3, `the front (+z) turns to face the road at z=0, north of the click (yaw 0): ${placed.yaw}`);
  const moved = applyPlanPatch(base, appendSiteOp(fresh(), { t: "move", id: station.id, at: { x: station.x, z: station.z }, to: formatFreeTarget(placed) }, 1));
  assert.equal(moved.stale.length, 0, "the auto placement is legal");
  const there = listSites(moved.layout).find((site) => site.id === station.id);
  const door = frontEntrance(there.footprint, there, there.yaw);
  assert.ok(Math.abs(door.at.z - (-(2.5 + ROAD_SETBACK))) < 0.01, `the front door sits ROAD_SETBACK off the road shoulder: ${JSON.stringify(door.at)}`);
  assert.ok(door.outward.z > 0.99, "…facing the road");
  assert.equal(siteTouchesRoad(moved.layout, there), true, "a snapped station already touches the road");
  assert.equal(accessRoadFor(moved.layout, model, there), null, "…so no access road is added");
  // 转向：[ / ] 在自动朝向上再转 90°。
  const turned = autoPlaceFree(base, station, { x: 150, z: -40 }, 1);
  assert.ok(Math.abs(Math.abs(turned.yaw - placed.yaw) - Math.PI / 2) < 1e-3 || Math.abs(Math.abs(turned.yaw - placed.yaw) - 3 * Math.PI / 2) < 1e-3, "a quarter turn rotates by 90°");
  // 离路远：只转向不平移；接入路从正门起笔，不穿过车站。
  const far = autoPlaceFree(base, station, { x: 100, z: -110 });
  assert.deepEqual([far.x, far.z], [100, -110], "far from any road the station is not dragged to it");
  const farLayout = applyPlanPatch(base, appendSiteOp(fresh(), { t: "move", id: station.id, at: { x: station.x, z: station.z }, to: formatFreeTarget(far) }, 1)).layout;
  const farSite = listSites(farLayout).find((site) => site.id === station.id);
  const road = accessRoadFor(farLayout, model, farSite);
  assert.ok(road, "a station away from roads gets an access road");
  const farDoor = frontEntrance(farSite.footprint, farSite, farSite.yaw).at;
  assert.ok(Math.hypot(road.from.x - farDoor.x, road.from.z - farDoor.z) < 0.01, "…from its front door");
  const parts = worldParts(farSite.footprint, farSite, farSite.yaw);
  const lead = { x: road.from.x, z: road.from.z + 0.05 };
  assert.ok(parts.every((part) => segmentPolygonDistance(lead, road.to, part) > 0), "…that does not cross the station itself");
  // 接到正门的路不算压到；穿过车站的路算（推平）。
  const withAccess = appendRoadOp(appendSiteOp(fresh(), { t: "move", id: station.id, at: { x: station.x, z: station.z }, to: formatFreeTarget(far) }, 1), { t: "add", from: road.from, to: road.to, width: 5 }, 2);
  assert.deepEqual(bulldozeForRoads(base, model, farLayout, withAccess).bulldozed, [], "a road ending at the front door connects the station — it does not bulldoze it");
  const through = appendRoadOp(fresh(), { t: "add", from: { x: 70, z: -110 }, to: { x: 130, z: -110 }, width: 5 }, 1);
  const crossVerdict = validateRoadAdd(farLayout, model, { x: 70, z: -110 }, { x: 130, z: -110 }, 5);
  assert.ok(crossVerdict.warnings.includes("bulldoze:1"), `a road straight through the station still hits it — ${crossVerdict.warnings}`);
  void through;
}

// (l) 改路型加宽（路线图 P1-4）：一条 z=21 的小路（宽 5，离会话楼 b1 (110,30)、背景楼 (170,30) 都够远）改成主干道（宽 12）——
//     路带扫过的新地面上的楼照画路一样处理：设施推平、会话楼由开发商安置；变窄不推任何东西。
{
  const base = makeLayout();
  base.roadNodes.push({ id: "0:21", x: 0, z: 21 }, { id: "300:21", x: 300, z: 21 });
  base.roadEdges.push(edge("0:21", "300:21"));
  const lane = applyPlanPatch(base, fresh()).layout;
  assert.deepEqual(bulldozeForRoads(base, model, lane, appendRoadOp(fresh(), { t: "restyle", edge: "0:21/300:21", width: 5 }, 1)).relocated, [], "a 5-wide lane at z=21 clears both buildings");
  const verdict = validateRestyle(lane, model, ["0:21/300:21"], 12);
  assert.ok(verdict.warnings.includes("bulldoze:1") && verdict.warnings.includes("relocate:1"), `widening announces what it will hit — ${verdict.warnings}`);
  const widen = appendRoadOp(fresh(), { t: "restyle", edge: "0:21/300:21", width: 12 }, 1);
  const result = bulldozeForRoads(base, model, lane, widen);
  assert.deepEqual(result.bulldozed, ["context:a5"], "widening to 12 bulldozes the backdrop building in the new band");
  assert.deepEqual(result.relocated.map((r) => r.id), ["b1"], "…and the developer re-homes the session building");
  const narrowed = applyPlanPatch(base, appendRoadOp(fresh(), { t: "restyle", edge: "0:0/300:0", width: 5 }, 1)).layout;
  assert.deepEqual(bulldozeForRoads(base, model, narrowed, appendRoadOp(fresh(), { t: "restyle", edge: "0:0/300:0", width: 5 }, 1)).bulldozed, [], "narrowing never bulldozes");
}

// (k) 两层投影。
{
  const wheelFp = siteFootprint("ferris-wheel", "landmark:ferris-wheel", 18);
  assert.equal(wheelFp.exact, true, "the Ferris wheel uses its physical declaration, not the nominal circle");
  assert.equal(wheelFp.parts.length, 4, "…ground footprint = platform + two leg strips + ticket booth");
  assert.equal(wheelFp.overhead.length, 6, "…overhead = ground + the wheel's two swept-disc variants");
  assert.ok(Math.abs(wheelFp.max.x - wheelFp.min.x - 2 * 28.7) < 1e-6 && wheelFp.max.z - wheelFp.min.z === 8,
    `…seen from above the vertical wheel is a 57.4 × 8 strip, not a circle: ${JSON.stringify([wheelFp.min, wheelFp.max])}`);
  const archFp = siteFootprint("arch", "landmark:arch", 16);
  assert.equal(archFp.parts.length, 2, "the arch stands on two piers");
  assert.ok(archFp.overhead.length === 3 && archFp.max.x - archFp.min.x === 34, "…its vault (33 wide) overhangs the gap between them; the piers' outer faces (±17) bound it");
  assert.equal(siteFootprint("sail-opera", "landmark:sail-opera", 14).exact, true, "the land-side opera uses its declaration");
  assert.equal(siteFootprint("sail-opera", "landmark:sail-opera", 14, true).exact, false, "…the island variant keeps its round island (the declaration covers land only)");
  assert.equal(siteFootprint("harbor", "public:site:harbor", 12).exact, false, "the harbor has no declaration yet — it stays the nominal circle, honestly marked");
  // 物理声明待补的声明式模型：从 3D 件表俯视投影（用户截图：电视塔底是巨大的圆——那是名义留地 r，模型裙房直径只有 17）。
  const tower = siteFootprint("tv-tower", "landmark:tv-tower", 22);
  assert.equal(tower.source, "projected", "the TV tower is projected from its part list");
  const towerR = Math.max(...tower.parts.flat().map((p) => Math.hypot(p.x, p.z)));
  assert.ok(towerR >= 8.5 && towerR < 9, `…its ground footprint is the podium (Ø17, sampled circumscribed), not the nominal r 22: ${towerR}`);
  assert.ok(tower.overhead.flat().every((p) => Math.hypot(p.x, p.z) < 9), "…and nothing above (pod, ring, deck) reaches past the podium");
  for (const kind of ["pagoda", "lighthouse"]) {
    const projected = siteFootprint(kind, `landmark:${kind}`, 18);
    assert.equal(projected.source, "projected", `${kind} is projected too`);
    assert.strictEqual(siteFootprint(kind, `landmark:${kind}`, 18), projected, `${kind} projection is reused for repeated corridor checks`);
  }
  assert.equal(siteFootprint("twin-towers", "landmark:twin-towers", 20).source, "nominal", "hand-drawn models without a part list stay nominal");

  const base = makeLayout(); base.landmarks[0] = { ...base.landmarks[0], x: 150, z: -60 };
  // 路从转盘下穿过（离平台很远，但在转盘俯视窄条里）：压到；挪开到窄条外：不压。
  const under = validateRoadAdd(base, model, { x: 172, z: -80 }, { x: 172, z: -40 }, 5);
  assert.ok(under.warnings.includes("bulldoze:1"), `a road under the wheel's disc hits it (no height contract → no passing underneath) — ${under.warnings}`);
  const beside = validateRoadAdd(base, model, { x: 182.5, z: -80 }, { x: 182.5, z: -40 }, 5);
  assert.ok(!beside.warnings.some((code) => code.startsWith("bulldoze:")), `a road just past the disc's end clears it — ${beside.warnings}`);
  // 楼与楼按俯视投影：平台碰不到会话楼 b1 (110,30)，但转盘窄条压在它头上 → 占用。
  const wheel = listSites(base).find((site) => site.id === "landmark:ferris-wheel");
  assert.equal(siteMoveProblem(base, wheel, "@135,30"), "target-occupied", "the wheel's disc may not swing over a session building even though its platform clears it");
}

// (e) 真实城市：一条横穿城区的路。
{
  const HARNESSES = ["codex", "claude-code", "dsh", "harness:zcode"];
  const GENERATED_AT = Date.UTC(2026, 9, 7, 12, 0, 0);
  let seedState = 12345; const rnd = () => { seedState = (seedState * 1103515245 + 12345) & 0x7fffffff; return seedState / 0x7fffffff; };
  const rows = Array.from({ length: 380 }, (_, i) => {
    const total = Math.round(2000 + rnd() ** 3 * 4_000_000);
    const start = GENERATED_AT - Math.round(rnd() * 28 * 86_400_000);
    return {
      session_ref: `session:${i}`, harness: HARNESSES[i % HARNESSES.length],
      first_event_at: new Date(start).toISOString(), last_event_at: new Date(start + Math.round(rnd() * 3_600_000)).toISOString(),
      event_count: 10, model_ids: ["claude-sonnet-5"],
      tokens: { uncached_input_tokens: Math.round(total * 0.2), cache_read_tokens: Math.round(total * 0.5), cache_write_tokens: Math.round(total * 0.1), output_tokens: Math.round(total * 0.2), total },
      peak_tokens: Math.round(total * 0.3), cost_minor: { amount_minor: Math.round(total / 1000), currency: "USD", basis: "api_equivalent" },
      cost_status: { state: "estimated", reason: "", has_unresolved: false },
    };
  });
  const real = buildCityModel({ rows, findings: [], windowStartMs: GENERATED_AT - 30 * 86_400_000, windowEndMs: GENERATED_AT, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: GENERATED_AT });
  const layout = layoutCity(real, null, undefined, MIAMI_COASTAL);
  // 找一条穿过会话楼、两端都在陆地上且不过河的路：以若干会话楼为中点，各试 8 个方向（岛中间有河，过河要桥，本期没有架桥工具）。
  const slots = layout.districts.flatMap((d) => [...d.slots.values()]);
  let chosen = null;
  for (let i = 0; i < slots.length && !chosen; i += 7) {
    for (let k = 0; k < 8 && !chosen; k += 1) {
      const ang = (k * Math.PI) / 8; const half = 70; const c = slots[i];
      const from = { x: c.x - Math.cos(ang) * half, z: c.z - Math.sin(ang) * half }; const to = { x: c.x + Math.cos(ang) * half, z: c.z + Math.sin(ang) * half };
      const verdict = validateRoadAdd(layout, real, from, to, 5);
      if (!verdict.blockers.length && verdict.warnings.some((w) => w.startsWith("relocate:"))) chosen = { from, to, verdict };
    }
  }
  assert.ok(chosen, "a cross-town road through session buildings is accepted");
  const t0 = performance.now();
  const result = bulldozeForRoads(layout, real, layout, appendRoadOp(emptyPlanPatch(layout.seed, layout.scaleTier), { t: "add", from: chosen.from, to: chosen.to, width: 5 }, 1));
  const ms = Math.round(performance.now() - t0);
  const applied = applyPlanPatch(layout, result.patch);
  assert.equal(applied.stale.length, 0, `the road + bulldoze + relocations replay cleanly — ${JSON.stringify(applied.stale.slice(0, 3))}`);
  const fresh2 = freshRoadGeometry(layout, applied.layout);
  const buildings = new Map(real.buildings.map((b) => [b.id, b]));
  const stillOnRoad = applied.layout.districts.flatMap((d) => [...d.slots]).filter(([id, slot]) => !result.homeless.includes(id) && !rectClearOfEdges(buildingRect(buildings.get(id), slot), fresh2, 0.5));
  assert.deepEqual(stillOnRoad.map(([id]) => id), [], "no re-homed session building is left under the new road");
  assert.equal(applied.layout.districts.reduce((n, d) => n + d.slots.size, 0), layout.districts.reduce((n, d) => n + d.slots.size, 0), "no session building disappears");
  console.log(`  真实城市 380 楼：横穿城区的新路 ${chosen.verdict.warnings.join("、")} → 推平 ${result.bulldozed.length}、安置 ${result.relocated.length}、无处安置 ${result.homeless.length}；推土机耗时 ${ms}ms`);

  // 搬一座地标到 60~200 外的空地并补接入路：补丁干净重放、接入路不推平任何东西。
  const landmarks = listSites(layout).filter((site) => site.level === "free" && !site.locked);
  let movedOne = null;
  for (const site of landmarks) {
    for (let k = 0; k < 24 && !movedOne; k += 1) {
      const ang = (k * Math.PI) / 12; const dist = 60 + (k % 3) * 60;
      const target = `@${Math.round((site.x + Math.cos(ang) * dist) * 100) / 100},${Math.round((site.z + Math.sin(ang) * dist) * 100) / 100}`;
      if (siteMoveProblem(layout, site, target)) continue;
      const patch = appendSiteOp(emptyPlanPatch(layout.seed, layout.scaleTier), { t: "move", id: site.id, at: { x: site.x, z: site.z }, to: target }, 1);
      const movedLayout = applyPlanPatch(layout, patch).layout;
      const t1 = performance.now();
      const road = accessRoadFor(movedLayout, real, listSites(movedLayout).find((candidate) => candidate.id === site.id));
      const accessMs = Math.round(performance.now() - t1);
      if (!road) continue;
      const full = appendRoadOp(patch, { t: "add", from: road.from, to: road.to, width: 5 }, 2);
      const replay = applyPlanPatch(layout, full);
      assert.equal(replay.stale.length, 0, `real-city landmark move + access road replay cleanly — ${JSON.stringify(replay.stale)}`);
      assert.equal(bulldozeForRoads(layout, real, movedLayout, full).bulldozed.length, 0, "the access road bulldozes nothing");
      movedOne = { site: site.id, target, length: road.length, accessMs };
    }
    if (movedOne) break;
  }
  assert.ok(movedOne, "some landmark can be moved and given an access road in the real city");

  // (i) 提速不改结果。
  {
    let seedR = 99; const rr = () => { seedR = (seedR * 1103515245 + 12345) & 0x7fffffff; return seedR / 0x7fffffff; };
    const roads = clearanceRoads(layout);
    const span = layout.islandRadius ?? 600;
    let hits = 0;
    for (let i = 0; i < 400; i += 1) {
      const rect = { x: (rr() * 2 - 1) * span, z: (rr() * 2 - 1) * span, yaw: rr() * Math.PI, width: 4 + rr() * 30, depth: 4 + rr() * 30 };
      const fast = rectClearOfRoads(layout, rect, 0.5); const slow = rectClearOfEdgesRaw(rect, roads, 0.5);
      assert.equal(fast, slow, `grid clearance equals brute force at ${JSON.stringify(rect)}`);
      if (!slow) hits += 1;
      const r = 5 + rr() * 120; const near = new Set(edgesNear(layout, rect.x, rect.z, r));
      for (const edge of roads) if (nearestOnPolyline(rect, edge.points).distance <= r) assert.ok(near.has(edge), "edgesNear never misses a road within the radius");
    }
    assert.ok(hits > 20, `the sample exercises both outcomes (${hits} rects touch roads)`);
    const again = layoutCity(real, layout, undefined, MIAMI_COASTAL);
    const slotsOf = (l) => JSON.stringify(l.districts.map((d) => [...d.slots].map(([id, p]) => [id, p.id])));
    assert.equal(slotsOf(again), slotsOf(layout), "with unchanged pins a relayout keeps every address — so road-only commits may skip it");
    assert.equal(JSON.stringify(again.roadEdges.map((e) => e.id)), JSON.stringify(layout.roadEdges.map((e) => e.id)), "…and the same road network");
  }

  // 跨河高架：找一段两端在陆地、中间过水的直线（岛中间有河），画成高架。曾要求「地面路过不去」——P1-5 起窄河地面路也能架桥，
  //   这条河地面桥就能过（下面另测），高架照样可以跨。
  let crossing = null;
  const isWater = (p) => !layout.terrain.buildable(p.x, p.z);
  // 半跨度取多档：窄河 160 就够，开湾的海湾宽 300–450，要 240–400 的跨度才有两端都在陆地的直线。
  for (let i = 0; i < slots.length && !crossing; i += 5) {
    for (let k = 0; k < 32 && !crossing; k += 1) {
      const ang = ((k % 8) * Math.PI) / 8; const c = slots[i]; const half = [160, 240, 320, 400][Math.floor(k / 8)];
      const a = { x: c.x - Math.cos(ang) * half, z: c.z - Math.sin(ang) * half }; const b = { x: c.x + Math.cos(ang) * half, z: c.z + Math.sin(ang) * half };
      const samples = Array.from({ length: 33 }, (_, t) => ({ x: a.x + (b.x - a.x) * t / 32, z: a.z + (b.z - a.z) * t / 32 }));
      if (isWater(a) || isWater(b) || !samples.some(isWater)) continue;
      const verdict = validateHighwayAdd(layout, real, [a, b]);
      if (!verdict.blockers.length) crossing = { a, b, verdict };
    }
  }
  assert.ok(crossing, "somewhere a viaduct can span the river");
  const viaductPatch = appendHighwayOp(emptyPlanPatch(layout.seed, layout.scaleTier), { t: "add", points: [crossing.a, crossing.b] }, 1);
  const vResult = bulldozeForRoads(layout, real, layout, viaductPatch);
  const vApplied = applyPlanPatch(layout, vResult.patch);
  assert.equal(vApplied.stale.length, 0, `the river-crossing viaduct (with its bulldoze/relocations) replays cleanly — ${JSON.stringify(vApplied.stale.slice(0, 3))}`);
  assert.equal(vApplied.layout.highways.length, (layout.highways ?? []).length + 1, "…as one more viaduct run");
  const deck = freshViaductGeometry(layout, vApplied.layout);
  const stillUnder = vApplied.layout.districts.flatMap((d) => [...d.slots]).filter(([id, slot]) => !vResult.homeless.includes(id) && !rectClearOfEdges(buildingRect(buildings.get(id), slot), deck, 0.5));
  assert.deepEqual(stillUnder.map(([id]) => id), [], `no session building is left under the new deck — ${JSON.stringify({ relocated: vResult.relocated, homeless: vResult.homeless, affected: roadImpact(vApplied.layout, real, deck).relocate })}`);
  console.log(`  真实城市：跨河高架 ${Math.round(Math.hypot(crossing.b.x - crossing.a.x, crossing.b.z - crossing.a.z))} 长 ${crossing.verdict.warnings.join("、") || "无提示"} → 推平 ${vResult.bulldozed.length}、安置 ${vResult.relocated.length}`);

  // 地面桥（路线图 P1-5）：找一笔恰好跨一段河的直路——校验给 bridge 提示、不拦；套用后多一座锁定的桥面、桥登记进 bridges、补丁干净重放。
  let groundBridge = null;
  for (let i = 0; i < slots.length && !groundBridge; i += 3) {
    for (let k = 0; k < 8 && !groundBridge; k += 1) {
      const ang = (k * Math.PI) / 8; const c = slots[i];
      for (const half of [60, 90, 120]) {
        const a = { x: c.x - Math.cos(ang) * half, z: c.z - Math.sin(ang) * half }; const b = { x: c.x + Math.cos(ang) * half, z: c.z + Math.sin(ang) * half };
        const verdict = validateRoadAdd(layout, real, a, b, 8);
        if (!verdict.blockers.length && verdict.warnings.some((code) => code.startsWith("bridge:"))) { groundBridge = { a, b, verdict }; break; }
      }
    }
  }
  if (groundBridge) {
    const gb = bulldozeForRoads(layout, real, layout, appendRoadOp(emptyPlanPatch(layout.seed, layout.scaleTier), { t: "add", from: groundBridge.a, to: groundBridge.b, width: 8 }, 1));
    const gbApplied = applyPlanPatch(layout, gb.patch);
    assert.equal(gbApplied.stale.length, 0, `a ground bridge over the river replays cleanly — ${JSON.stringify(gbApplied.stale.slice(0, 3))}`);
    const decks = gbApplied.layout.roadEdges.filter((e) => e.bridge && !layout.roadEdges.some((o) => o.id === e.id));
    assert.equal(decks.length, 1, "…with exactly one new locked deck");
    assert.equal(gbApplied.layout.bridges.length, (layout.bridges ?? []).length + 1, "…registered as a bridge");
    console.log(`  真实城市：地面桥 ${groundBridge.verdict.warnings.join("、")} → 推平 ${gb.bulldozed.length}、安置 ${gb.relocated.length}`);
  } else console.log("  真实城市：没找到一笔只跨一段河的直路（跳过地面桥）");

  // 滨海大道：沿一段生成器滨海路外侧平行画一段，景观带折线随之增加，补丁干净重放。
  const run = (layout.coastRoads ?? []).find((r) => r.length >= 6);
  if (run) {
    const [p0, p1] = [run[1], run[4]];
    const along = { x: p1.x - p0.x, z: p1.z - p0.z }; const len = Math.hypot(along.x, along.z) || 1;
    const inland = (q) => ({ x: q.x - (along.z / len) * 30, z: q.z + (along.x / len) * 30 });
    const options = [[inland(p0), inland(p1)], [{ x: p0.x + (along.z / len) * 30, z: p0.z - (along.x / len) * 30 }, { x: p1.x + (along.z / len) * 30, z: p1.z - (along.x / len) * 30 }]];
    const pick = options.find(([a, b]) => !validateRoadAdd(layout, real, a, b, 12, "waterfront").blockers.length);
    if (pick) {
      const wf = bulldozeForRoads(layout, real, layout, appendRoadOp(emptyPlanPatch(layout.seed, layout.scaleTier), { t: "add", from: pick[0], to: pick[1], width: 12, purpose: "waterfront" }, 1));
      const wfApplied = applyPlanPatch(layout, wf.patch);
      assert.equal(wfApplied.stale.length, 0, "a waterfront boulevard replays cleanly");
      assert.ok(wfApplied.layout.coastRoads.length > (layout.coastRoads ?? []).length, "…and grows a promenade run");
      console.log(`  真实城市：滨海大道一段 → 景观带折线 ${(layout.coastRoads ?? []).length} → ${wfApplied.layout.coastRoads.length}`);
    } else console.log("  真实城市：滨海路两侧都放不下平行的滨海大道（跳过）");
  }
  console.log(`  真实城市：${movedOne.site} → ${movedOne.target}，补接入路 ${movedOne.length}（求路耗时 ${movedOne.accessMs}ms）`);
}

console.log("City plan bulldozer: roads through buildings are allowed — facilities are bulldozed and session buildings re-homed by the developer (never removed), generator residue is left alone, homeless buildings are reported, split halves are not new geometry; landmarks and public sites can be removed or moved anywhere legal, only the suspension bridge stays locked; moved sites get a non-destructive access road and their old dead-end access road is listed; pruning stale entries leaves the rest unchanged; viaducts clear the ground beneath them like roads do; free-level sites use their real model footprint (declared, or projected from the part list when the declaration is pending; ground for terrain and the front door, overhead projection incl. overhangs and the wheel swept disc for collisions), snap their front door to the road and are not bulldozed by the road that serves them; real-city cross-town road, landmark move, river-crossing viaduct and waterfront boulevard replay cleanly.");
