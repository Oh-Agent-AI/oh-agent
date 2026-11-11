#!/usr/bin/env node
// 小地图路况（2026-10-21，用户：「可以搞个小地图，这样可以明显的看出道路情况？」）：minimapModel 与修复面板「体检」的
// 道路规则是同一组判据——小地图上的红点，体检里就有一条同样的问题。这里钉住：陡路标红、很陡标琥珀、斜接桥头整座桥标红、
// 正常路不标；问题点数与体检的道路规则条数一致；水陆栅格按地形水位取样（河道是水、岸上是陆）；按布局缓存。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
globalThis.window ??= globalThis;
const { minimapModel, auditLayout, trafficModel, trafficLevel, roadValidationReport } = await loadCity({ "minimap/roadConditions.ts": ["minimapModel"], "engine/planAudit.ts": ["auditLayout"], "minimap/traffic.ts": ["trafficModel", "trafficLevel"], "game/roadValidation.ts": ["roadValidationReport"] });
const wet = (x) => x > 200 && x < 240;
const height = (x, z) => (wet(x) ? -1 : z > 40 && x > -60 && x < -40 ? 2 + (z - 40) * 0.5 : z > 40 && x > -100 && x < -80 ? 2 + (z - 40) * 0.25 : 2);
const terrain = { height, slope: () => 0, buildable: (x) => !wet(x), center: { x: 0, z: 0 }, radius: 400, coastRadius: () => 400, hasRiver: true };
const road = (a, b, width = 5, extra = {}) => ({ id: `${a.x}:${a.z}/${b.x}:${b.z}`, from: `${a.x}:${a.z}`, to: `${b.x}:${b.z}`, width, kind: width >= 8 ? "arterial" : "local", points: [a, b], structure: "ground-road", ...extra });
const edges = [
  road({ x: -50, z: 40 }, { x: -50, z: 100 }),            // 0.5 坡：开不过去
  road({ x: -90, z: 40 }, { x: -90, z: 100 }),            // 0.25 坡：很陡
  road({ x: 0, z: 0 }, { x: 150, z: 0 }, 12),             // 平路
  road({ x: 197, z: 0 }, { x: 243, z: 0 }, 5, { bridge: true, structure: "deck" }), // 桥：西端只接一条 90° 的路 → 斜接
  road({ x: 197, z: 0 }, { x: 197, z: -30 }), road({ x: 243, z: 0 }, { x: 260, z: 0 }),
];
const layout = { seed: 1, scaleTier: 1, extent: 400, terrain, coast: [{ x: -300, z: -300 }, { x: 300, z: -300 }, { x: 300, z: 300 }, { x: -300, z: 300 }], river: [],
  roadEdges: edges, roadNodes: [...new Set(edges.flatMap((e) => [e.from, e.to]))].map((id) => { const [x, z] = id.split(":").map(Number); return { id, x, z }; }),
  highways: [], districts: [], blocks: [], landmarks: [], contextBuildings: [] };
const model = minimapModel(layout);
const cond = (id) => model.roads.find((r) => r.id === id).condition;
assert.equal(cond("-50:40/-50:100"), "blocked", "a road up a 0.5 slope is red");
assert.equal(cond("-90:40/-90:100"), "steep", "a road up a 0.25 slope is amber");
assert.equal(cond("0:0/150:0"), "ok", "a flat road is not flagged");
assert.equal(cond("197:0/243:0"), "blocked", "the deck of an oblique bridgehead is red");
assert.equal(model.roads.find((r) => r.id === "197:0/243:0").cls, "bridge");
assert.equal(model.roads.find((r) => r.id === "0:0/150:0").cls, "main");
assert.deepEqual(model.counts, { blocked: 2, steep: 1 });
const roadRules = auditLayout(layout, { buildings: [] }).filter((i) => i.rule.startsWith("bridgehead") || i.rule === "roadSteep");
assert.equal(model.issues.length, roadRules.length, `every minimap spot is an audit issue and vice versa (${model.issues.length} vs ${roadRules.length})`);
assert.ok(model.issues.every((i) => i.text.zh && i.text.en), "each spot explains itself in both languages");
const { cols, rows, water } = model.water;
const at = (x, z) => water[Math.floor(((z - model.bounds.minZ) / (model.bounds.maxZ - model.bounds.minZ)) * rows) * cols + Math.floor(((x - model.bounds.minX) / (model.bounds.maxX - model.bounds.minX)) * cols)];
assert.equal(at(220, 0), 1, "the river is water"); assert.equal(at(0, 0), 0, "the bank is land");
assert.equal(minimapModel(layout), model, "cached per layout object");
assert.ok(model.blocked.has("-50:40/-50:100") && model.blocked.has("197:0/243:0") && !model.blocked.has("-90:40/-90:100"), "blocked = the red roads, exactly");

// 道路审计的车流估算：两片市中心之间只有一条窄路 → 拥堵；加一条平行主干道 → 车流分走、窄路不再堵；
// 窄路开不过去（blocked）且没有别的路 → 不进路网，两片之间的出行记作「到不了」，而不是悄悄消失。
const flat = { ...terrain, height: () => 2, buildable: () => true };
const block = (id, x, z) => ({ id, districtId: "d", x, z, width: 40, depth: 40, zone: "downtown", polygon: [], parcels: [{ id: `${id}p`, blockId: id, x, z, yaw: 0, zone: "downtown", width: 40, depth: 40 }] });
const city = (extra) => { const es = [road({ x: 0, z: 0 }, { x: 400, z: 0 }), ...extra];
  return { ...layout, terrain: flat, roadEdges: es, roadNodes: [...new Set(es.flatMap((e) => [e.from, e.to]))].map((id) => { const [x, z] = id.split(":").map(Number); return { id, x, z }; }),
    blocks: [block("a", -10, 10), block("b", 410, 10)], contextBuildings: [] }; };
const none = new Set(); const narrow = city([]); const one = trafficModel(narrow, none);
const link = one.edges.get("0:0/400:0");
assert.ok(one.trips > 0 && link.volume > 0, "trips are generated from block land use and routed");
assert.equal(link.level, "jam", `a single narrow link between two downtowns jams (v/c ${link.vc.toFixed(2)})`);
assert.equal(one.hotspots[0].id, "0:0/400:0"); assert.ok(one.hotspots[0].text.zh.includes("拥堵") && one.hotspots[0].text.en.includes("Jammed"));
const relieved = trafficModel(city([road({ x: 0, z: 0 }, { x: 200, z: 120 }, 12), road({ x: 200, z: 120 }, { x: 400, z: 0 }, 12)]), new Set());
assert.ok(relieved.edges.get("0:0/400:0").vc < link.vc * 0.7, "a parallel arterial takes traffic off the narrow link (assignment reroutes by congested time)");
const cut = trafficModel(narrow, new Set(["0:0/400:0"]));
assert.ok(!cut.edges.has("0:0/400:0") && cut.unreachable > 0, "an impassable road leaves the network and the trips it carried count as unreachable");
assert.equal(trafficModel(narrow, none), one, "cached per layout and blocked set (the minimap passes model.blocked, one Set per layout)");
assert.deepEqual([0.2, 0.5, 0.85, 1.3].map(trafficLevel), ["free", "busy", "slow", "jam"]);

const check = roadValidationReport(layout);
assert.equal(check.status, "complete");
assert.equal(check.verdict, "failed", "a city with blocked cells finishes as a fail, not an in-progress hang");
assert.equal(check.blocked, 2);
assert.equal(check.steep, 1);
assert.ok(check.primary?.kind === "road-steep" || check.primary?.kind === "bridgehead-oblique" || check.primary?.kind === "bridgehead-steep", "the fail names a layout-rule blockage");
assert.ok(check.primary?.at && Number.isFinite(check.primary.at.x) && Number.isFinite(check.primary.at.z), "the fail names a map cell");
const clearLayout = { ...layout, roadEdges: [road({ x: 0, z: 0 }, { x: 150, z: 0 }, 12)],
  roadNodes: [{ id: "0:0", x: 0, z: 0 }, { id: "150:0", x: 150, z: 0 }] };
const passed = roadValidationReport(clearLayout);
assert.equal(passed.verdict, "passed");
assert.equal(passed.blocked, 0);
assert.equal(passed.primary, null);
console.log("City minimap: steep roads red, near-limit roads amber, oblique bridgehead decks red, flat roads plain; spots match the repair audit's road rules one for one; water sampled from terrain; cached per layout. Traffic: a lone narrow link jams, a parallel arterial relieves it, an impassable road strands its trips as unreachable. Road check: blocked cities finish failed with a cell; clear cities pass.");
