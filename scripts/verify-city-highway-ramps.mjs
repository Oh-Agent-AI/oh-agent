#!/usr/bin/env node
// 匝道必须接上真实高架和有限地面宿主，不能只在切线/道路延长线上看起来接近。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { planHighwayRamps, HIGHWAY_RAMP_CONFIG: C, segmentDistance, THREE, buildHighwayRamps, EXPRESSWAY_DECK_Y, expresswayPieces, compileCitySurface, compileStaticStructureObstacles } = await loadCity({
  "engine/planner/highwayRamps.ts": ["planHighwayRamps", "HIGHWAY_RAMP_CONFIG"],
  "engine/roadGeometry.ts": ["segmentDistance"],
  "pkg:three": ["* as THREE"],
  "engine/systems/roadSystem.ts": ["buildHighwayRamps"],
  "engine/render/shared.ts": ["EXPRESSWAY_DECK_Y"],
  "engine/surface/structureCompiler.ts": ["expresswayPieces"],
  "engine/surface/compileSurface.ts": ["compileCitySurface", "compileStaticStructureObstacles"],
});
const road = (id, x, lo = -100, hi = 100) => ({ id, from: `${x}:${lo}`, to: `${x}:${hi}`,
  width: 12, kind: "arterial", structure: "ground-road", points: [{ x, z: lo }, { x, z: hi }] });
const run = [{ x: -500, z: 0 }, { x: -80, z: 20 }, { x: 80, z: 0 }, { x: 500, z: -10 }];
const input = { highways: [run], roads: [road("host", 0)], buildable: () => true, sites: [] };
const before = JSON.stringify(input);
const result = planHighwayRamps(input);
assert.equal(result.ramps.length, 4, "an unobstructed crossing has two ramps on each side");
for (const ramp of result.ramps) {
  const start = ramp.points[0], end = ramp.points.at(-1);
  assert.ok(run.slice(1).some((b, i) => segmentDistance(start, run[i], b) < 1e-8), "bridge end lies on actual curved highway");
  assert.ok(segmentDistance(end, input.roads[0].points[0], input.roads[0].points[1]) < 1e-8, "ground end lies on finite host");
}
const splitHosts = planHighwayRamps({ ...input, roads: [road("lower", 0, -100, 0), road("upper", 0, 0, 100)] });
assert.equal(splitHosts.ramps.length, 4, "a junction split must not hide real collinear landing hosts");
assert.deepEqual(planHighwayRamps(input), result);
assert.equal(JSON.stringify(input), before);
assert.equal(planHighwayRamps({ ...input, roads: [road("short-host", 0, -5, 5)] }).ramps.length, 0,
  "a landing beyond the road endpoint cannot become an interchange");
assert.equal(planHighwayRamps({ ...input, buildable: () => false }).ramps.length, 0);
assert.equal(planHighwayRamps({ ...input, sites: [{ x: 0, z: 0, radius: 500 }] }).ramps.length, 0);
assert.equal(planHighwayRamps({ ...input, highways: [[{ x: -160, z: 0 }, { x: 160, z: 0 }]] }).ramps.length, 0,
  "the bridge merge must clear the highway's own landing slope");
const closed = [{ x: -500, z: -500 }, { x: 500, z: -500 }, { x: 500, z: 500 }, { x: -500, z: 500 }, { x: -500, z: -500 }];
const spaced = planHighwayRamps({ ...input, highways: [closed], roads: [road("a", -50, -550, -450), road("b", 50, -550, -450)] });
assert.equal(spaced.interchanges.length, 1, "nearby crossings on a closed highway obey longitudinal spacing");
assert.ok(C.endClear >= 90, "merge points must be above the existing highway end slopes");
{
  const host = { layout: { highways: [run], highwayRamps: [result.ramps[0]], terrain: { height: () => 1.2 } }, group: new THREE.Group(), disposables: [],
    positionVector: new THREE.Vector3(), euler: new THREE.Euler(), quaternion: new THREE.Quaternion(), scaleVector: new THREE.Vector3(),
    matrix: new THREE.Matrix4(), color: new THREE.Color() };
  buildHighwayRamps(host);
  // 匝道是连续网格（2026-10-21）：桥面板 / 护栏 / 车道边线各一张网格，墩柱仍是实例盒子。
  const deck = host.group.getObjectByName("city-highway-ramp-deck"), railMesh = host.group.getObjectByName("city-highway-ramp-rails"), lineMesh = host.group.getObjectByName("city-highway-ramp-lines");
  assert.ok(deck && railMesh && lineMesh, "the accepted geometry is rendered as deck, rails and edge lines");
  const tris = (mesh) => { const pos = mesh.geometry.getAttribute("position"); const out = [];
    for (let i = 0; i < pos.count; i += 3) out.push([0, 1, 2].map((k) => ({ x: pos.getX(i + k), y: pos.getY(i + k), z: pos.getZ(i + k) }))); return out; };
  const centroid = (t) => ({ x: (t[0].x + t[1].x + t[2].x) / 3, y: (t[0].y + t[1].y + t[2].y) / 3, z: (t[0].z + t[1].z + t[2].z) / 3 });
  const toHighway = (p) => Math.min(...run.slice(1).map((b, j) => segmentDistance({ x: p.x, z: p.z }, run[j], b)));
  const flat = (t) => Math.abs((t[1].x - t[0].x) * (t[2].z - t[0].z) - (t[1].z - t[0].z) * (t[2].x - t[0].x)) > 1e-6; // 有水平投影面积 = 顶/底面
  const deckTris = tris(deck); const deckTop = Math.max(...deckTris.flat().map((p) => p.y));
  // 顶面 = 桥面高 + 板厚；坡度转折处的接缝按驾驶面同一规则抬 RIBBON_LIFT（0.03）。
  assert.ok(deckTop >= EXPRESSWAY_DECK_Y + 0.9 - 1e-4 && deckTop <= EXPRESSWAY_DECK_Y + 0.9 + 0.03 + 1e-4, `merge deck stays level with the highway instead of sinking into it (top ${deckTop})`);
  for (const t of deckTris) if (flat(t) && toHighway(centroid(t)) < (10.5 + result.ramps[0].width) / 2 + 0.5)
    assert.ok([EXPRESSWAY_DECK_Y + 0.9, EXPRESSWAY_DECK_Y + 0.93, EXPRESSWAY_DECK_Y].some((y) => Math.abs(Math.max(...t.map((p) => p.y)) - y) < 1e-4), `overlapping ramp cross sections must stay at main deck height (${Math.max(...t.map((p) => p.y))})`);
  // 每条标线是一块薄实体（12 个三角形：顶、底、两侧、两端）——按实体中心判断，与旧的「按盒子中心」同口径。
  const lineTris = tris(lineMesh);
  for (let i = 0; i < lineTris.length; i += 12) { const c = centroid(lineTris.slice(i, i + 12).map(centroid)); assert.ok(toHighway(c) > 10.5 / 2 + 0.39, "ramp edge markings must not cross the main highway lanes"); }
  const end = result.ramps[0].points.at(-1); const railTris = tris(railMesh);
  assert.ok(railTris.length > 0, "the descent retains protective rails between open ends");
  for (let i = 0; i < railTris.length; i += 12) { const c = centroid(railTris.slice(i, i + 12).map(centroid)); assert.ok(Math.hypot(c.x - end.x, c.z - end.z) > 9.5, "ramp rails must leave the ground junction open"); }
  // 截图缺陷：弯道上相邻桥板之间张开楔形裂口。沿匝道两条外缘（离中线 半宽 − 0.05）每 0.5 取一点，都要落在某块桥面顶面三角形里。
  const inside = (p, t) => { const d = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x); const d1 = d(t[0], t[1], p), d2 = d(t[1], t[2], p), d3 = d(t[2], t[0], p);
    return !((d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9) && (d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9)); };
  const topTris = deckTris.filter((t) => flat(t) && Math.min(...t.map((p) => p.y)) > Math.max(...t.map((p) => p.y)) - 1.5 && t.every((p) => p.y >= 0));
  const pts = result.ramps[0].points; let probes = 0, holes = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1], b = pts[i], len = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    for (let s = 0; s <= len; s += 0.5) for (const side of [-1, 1]) {
      const p = { x: a.x + ux * s - uz * side * (result.ramps[0].width / 2 - 0.05), z: a.z + uz * s + ux * side * (result.ramps[0].width / 2 - 0.05) };
      probes += 1; if (!topTris.some((t) => inside(p, t))) holes += 1;
    }
  }
  // 弯道外角：在每个内部顶点沿前后两段法线之间扫一圈——楔形裂口正在这里（沿各段自己的法线取点会从它旁边漏过去；
  // 15 个规划的 8 条匝道上，旧的逐段盒子在这里漏 94 个探针、连续网格 0 个）。
  for (let i = 1; i + 1 < pts.length; i += 1) {
    const p0 = pts[i - 1], v = pts[i], p1 = pts[i + 1];
    const a0 = Math.atan2(v.z - p0.z, v.x - p0.x), a1 = Math.atan2(p1.z - v.z, p1.x - v.x);
    let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    const outer = da > 0 ? -1 : 1;
    for (let k = 0; k <= 8; k += 1) {
      const ang = a0 + (da * k) / 8; const p = { x: v.x - Math.sin(ang) * outer * (result.ramps[0].width / 2 - 0.05), z: v.z + Math.cos(ang) * outer * (result.ramps[0].width / 2 - 0.05) };
      probes += 1; if (!topTris.some((t) => inside(p, t))) holes += 1;
    }
  }
  assert.equal(holes, 0, `the ramp deck has no wedge gaps along its outer edges or bend corners (${holes}/${probes} edge probes uncovered)`);
  for (const disposable of host.disposables) disposable.dispose();
}
// 主桥护栏在匝道合流处开口：dev 把高架几何抽进 structureCompiler 时丢过这条，合并后护栏又横截匝道。
{
  const base = { highways: [run], terrain: { height: () => 1.2 } };
  const railsOf = (layout) => expresswayPieces(layout).filter((piece) => piece.role === "expressway-rail");
  const closedRails = railsOf(base), openRails = railsOf({ ...base, highwayRamps: result.ramps });
  assert.notEqual(openRails.length, closedRails.length, "a merging ramp changes the main rail layout");
  for (const ramp of result.ramps) {
    const head = ramp.points.slice(0, Math.ceil(ramp.points.length * 0.4) + 1);
    for (const rail of openRails) assert.ok(head.every((point) => Math.hypot(rail.x - point.x, rail.z - point.z) >= ramp.width / 2),
      `main rail at ${rail.x.toFixed(1)},${rail.z.toFixed(1)} cuts across a merging ramp`);
  }
}
// 立交匝道可驾驶（2026-10-20）：与高架同进结构编译器——桥面是高架层上的驾驶面片，地面端是带门户的落地点，
// 护栏/墩柱/桥面板是碰撞实体。此前匝道只渲染：车开上去是穿模的空气，结构过渡审计也看不到它。
{
  const layout = { roadEdges: [road("host", 0)], extent: 600, terrain: { height: () => 1.2 }, highways: [run], bridges: [], landmarks: [], culDeSacEnds: [], highwayRamps: result.ramps };
  const compiled = compileCitySurface(layout);
  for (const [i, ramp] of result.ramps.entries()) {
    const patches = compiled.surface.patches.filter((p) => p.id.startsWith(`ramp:${i}:`));
    assert.ok(patches.length > 0 && patches.every((p) => p.kind === "ramp" && p.layerId.startsWith("expressway:")), `ramp ${i} is a drivable patch run on its highway layer`);
    const landing = compiled.landings.find((l) => l.structureId === `ramp:${i}` && l.end === "to");
    assert.ok(landing, `ramp ${i} has a ground landing`);
    assert.ok(landing.step !== null && Math.abs(landing.step) < 0.35, `ramp ${i} lands flush (step ${landing.step})`);
    const end = ramp.points.at(-1);
    assert.ok(Math.hypot(landing.x - end.x, landing.z - end.z) < 1e-6, `ramp ${i} landing sits at the ground end`);
  }
  const obstacles = compileStaticStructureObstacles(layout);
  for (const role of ["ramp-rail", "ramp-deck"]) assert.ok(obstacles.some((o) => o.role === role), `ramp ${role} is a collision solid`);
}
console.log("City highway ramps: drivable patches/landings/solids, curved bridge contact, finite ground hosts, slope clearance, closed spacing, obstacles, determinism and rail openings passed.");
