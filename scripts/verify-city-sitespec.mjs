#!/usr/bin/env node
// 选址登记表守卫（CITY_NETWORK_FIRST_CODE_DESIGN 迁移批次 6a-1）：
//   (a) 完整性：真实规划放置的每类用地/地标（radius > 0）都有 SiteSpec 行，半径与表一致——
//       表漏登一行，行为变更批接线时该类就会静默丢选址知识；
//   (b) 分类一致：coastalSitingKinds/straddleSitingKinds/frontageExemptKinds 与 cityPlan 现行
//       SHORE_SITE_KINDS / STRADDLE / SHORE_BOUND 逐一相等（6b 起这三个集合由表派生，此处是值的门禁）；
//   (c) 表自身确定性：同输入两次求值同输出、导出顺序稳定；
//   (d) suspension-bridge 不登记（radius 0 的派生装饰，不走选址）。
// 批次 6a-3 起追加：(e) access/assign 骨架的确定性（同输入两次运行同输出）与 hard 闸门行为。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { createCityPlan, MIAMI_COASTAL, SITE_SPECS, specByKind, coastalSitingKinds, straddleSitingKinds, frontageExemptKinds, nominalAnchorPoint, SITING_TABLE_VERSION, runAssignment, siteCandidateHardReject, assignConnectedSite, connectRelocatedPlotAccess, JOINT_SITE_CONFIG, stationEntranceLocal, emptyNetwork, addNetworkEdge, siteInWater, sitesOverlap, siteFootprintSeparation, siteFootprint, worldParts, pointInPolygon, ringSamples16 } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL"],
  "engine/planner/sitespec.ts": ["SITE_SPECS", "specByKind", "coastalSitingKinds", "straddleSitingKinds", "frontageExemptKinds", "nominalAnchorPoint", "SITING_TABLE_VERSION"],
  "engine/planner/assign.ts": ["runAssignment"],
  "engine/planner/access.ts": ["siteCandidateHardReject"],
  "engine/planner/jointSite.ts": ["assignConnectedSite", "connectRelocatedPlotAccess", "JOINT_SITE_CONFIG"],
  "engine/models/publicSiteGeometry.ts": ["stationEntranceLocal"],
  "engine/planner/network.ts": ["emptyNetwork", "addNetworkEdge"],
  "engine/planner/constraints.ts": ["siteInWater", "sitesOverlap"],
  "engine/planFootprint.ts": ["siteFootprint", "siteFootprintSeparation", "worldParts", "pointInPolygon"],
  "engine/planner/footprint.ts": ["ringSamples16"],
});

// Shared collision facts: empty nominal-circle corners may fit beside a
// rectangle, but real overlap (including two instances of one class) may not.
{
  const stadium = { id: "stadium:a", kind: "stadium", x: 0, z: 0, yaw: 0, radius: 49 };
  const proxy = { id: "small-plot", kind: "unknown-model", x: 50, z: 0, yaw: 0, radius: 5 };
  assert.equal(siteFootprintSeparation(stadium, proxy), 12.5);
  assert.equal(siteFootprintSeparation(proxy, stadium), 12.5);
  assert.equal(sitesOverlap.measure({ publicSites: [stadium, proxy], landmarks: [] }).length, 0);
  const overlapping = { ...stadium, id: "stadium:b", x: 20 };
  assert(siteFootprintSeparation(stadium, overlapping) < 0, "polygon penetration must have a negative sign, not the contact distance zero");
  assert.equal(sitesOverlap.measure({ publicSites: [stadium, overlapping], landmarks: [] }).length, 1);
  assert.equal(siteFootprintSeparation(stadium, { ...overlapping, x: 65 }), 0, "touching edges have zero separation");
  assert.equal(siteFootprintSeparation(stadium, { ...overlapping, x: 70 }), 5);
  assert.equal(siteFootprintSeparation({ ...stadium, kind: "unknown-a" }, proxy), -4,
    "undeclared shapes retain their full circular reservation");
  assert.equal(siteFootprintSeparation({ ...stadium, yaw: NaN }, proxy), -Infinity);
}

// A neighbour may need a new frontage route after a joint move. Only a proved
// primary connection makes the formerly-too-far candidate usable.
{
  const network = emptyNetwork(); addNetworkEdge(network, { x: -100, z: 0 }, { x: 100, z: 0 }, true);
  const owner = { id: "relocated-park", kind: "park", x: 0, z: 60, yaw: 0, radius: 20 };
  const geo = { height: () => 1.2, buildable: () => true, terrain: { slope: () => 0 } };
  assert.equal(connectRelocatedPlotAccess({ network, geo, inRiver: () => false, reservations: () => [owner] }, owner, "-100:0"), true);
  assert(network.edges.size > 1, "a successful neighbour relocation must retain its actual new route");
  const wet = emptyNetwork(); addNetworkEdge(wet, { x: -100, z: 0 }, { x: 100, z: 0 }, true);
  const before = JSON.stringify([...wet.edges]);
  assert.equal(connectRelocatedPlotAccess({ network: wet, geo: { ...geo, height: () => -1 }, inRiver: () => false,
    reservations: () => [owner] }, owner, "-100:0"), false);
  assert.equal(JSON.stringify([...wet.edges]), before, "failed neighbour access publishes no route");
}

// Exact declared model geometry replaces the nominal reservation circle in
// generator admission; legacy-only classes keep their existing proxy checks.
{
  const candidate = { id: "stadium:shape", x: 0, z: 0, yaw: 0, source: "shape fixture" };
  const world = { core: { x: 0, z: 0 }, R: 300, turn: 0, coast: [],
    trunkRuns: [[{ x: -100, z: 40 }, { x: 100, z: 40 }]], ringRuns: [], bridges: [],
    placed: [{ x: 50, z: 0, radius: 5 }], height: (_x, z) => z > 30 && Math.abs(_x) < 5 ? 0.2 : 1.2,
    inRiver: () => false, riverBank: () => false, coastDistance: () => 200, landClearance: () => 100, buildable: () => true,
    hasRiver: false, riverX: () => 9999, riverWidth: () => 0, hillDir: { x: 1, z: 0 }, hillLine: 9999, hillProj: () => 0 };
  assert.equal(siteCandidateHardReject(world, specByKind("stadium"), candidate), null,
    "65x50 stadium fits beside a road, on dry model ground, and beside a small plot even when its legacy radius would reject it");
  assert.equal(siteCandidateHardReject({ ...world, trunkRuns: [[{ x: -100, z: 32 }, { x: 100, z: 32 }]], placed: [] },
    specByKind("stadium"), candidate), "trunk-clearance-r+8", "real footprint must still reject a road corridor within its 8-unit setback");
  let terrainSamples = 0;
  const blockedWorld = { ...world, trunkRuns: [[{ x: -100, z: 32 }, { x: 100, z: 32 }]], placed: [],
    height: () => { terrainSamples += 1; return 1.2; } };
  assert.equal(siteCandidateHardReject(blockedWorld, specByKind("stadium"), candidate), "trunk-clearance-r+8");
  assert.equal(terrainSamples, 0, "cheap physical clearance rejection must happen before terrain sampling");
}

// Exact inland models use their declared ground footprint for the water measure,
// matching generator admission instead of rejecting a dry model for wet corners
// of its larger nominal reservation circle.
{
  const owner = { id: "central-station", kind: "station", x: 0, z: 0, yaw: 0, radius: specByKind("station").radius };
  const footprint = siteFootprint(owner.kind, owner.id, owner.radius), polygons = worldParts(footprint, owner, owner.yaw);
  assert(footprint.exact, "station fixture must exercise the declared physical footprint path");
  const outsideRingPoint = ringSamples16(owner, owner.radius).find(point => !polygons.some(polygon => pointInPolygon(point, polygon)));
  assert(outsideRingPoint, "station's nominal plot circle must contain a point outside the physical ground footprint");
  const height = (x, z) => Math.hypot(x - outsideRingPoint.x, z - outsideRingPoint.z) < 0.1 ? 0 : 1.2;
  const plan = { publicSites: [owner], landmarks: [], terrain: { height } };
  assert.equal(siteInWater.measure(plan).length, 0, "wet area outside the exact inland footprint cannot create a water violation");
  const proxyOwner = { ...owner, kind: "legacy-proxy" };
  assert.equal(siteInWater.measure({ ...plan, publicSites: [proxyOwner] }).length, 1,
    "unknown/nominal footprints retain the conservative reservation-circle water measure");
}

const frontagePrimaryMax = JOINT_SITE_CONFIG.frontageSegments * (1 + JOINT_SITE_CONFIG.probes.length) * 2;
const frontageFallbackMax = JOINT_SITE_CONFIG.fallbackCandidateLimit * (1 + JOINT_SITE_CONFIG.fallbackProbes.length) * 2;
const regionFallbackMax = 1 + (JOINT_SITE_CONFIG.fallbackRegionRadii.length - 1) * JOINT_SITE_CONFIG.fallbackRegionDirections
  + JOINT_SITE_CONFIG.outerRegionRadii.length * JOINT_SITE_CONFIG.outerRegionDirections;
assert.equal(JOINT_SITE_CONFIG.maxCandidateEvaluations, frontagePrimaryMax + frontageFallbackMax + regionFallbackMax,
  "required-site search candidate bound must match its configured frontage and region tiers");

// 联合指派：只有真实主网可达的入口候选才返回位置/网络；拒绝没有名义位置或正式图副作用。
{
  const a = { x: -600, z: 0 }; const b = { x: 600, z: 0 };
  const network = emptyNetwork(); addNetworkEdge(network, a, b, true, false, true);
  const world = { core: { x: 0, z: 0 }, R: 1200, turn: 0, coast: [], trunkRuns: [[a, b]], ringRuns: [], bridges: [], placed: [],
    height: () => 1.2, inRiver: () => false, riverBank: () => false, coastDistance: () => 1000, landClearance: () => 1000, buildable: () => true,
    hasRiver: false, riverX: () => 9999, riverWidth: () => 0, hillDir: { x: 0, z: 1 }, hillLine: 9999, hillProj: () => 0 };
  const connector = { network, geo: { height: world.height, buildable: world.buildable, terrain: { slope: () => 0 } }, inRiver: world.inRiver, reservations: () => [] };
  const before = JSON.stringify([...network.edges]);
  for (const kind of ["station", "stadium"]) {
    const assigned = assignConnectedSite(world, connector, specByKind(kind), `test:${kind}`, "-600:0");
    assert.ok(assigned.site && assigned.network);
    assert.equal(assigned.site.access.role, "plot-gate");
    assert.ok(assigned.network.nodes.has(assigned.site.access.nodeId));
    if (kind === "stadium") {
      let screened = 0;
      const retried = assignConnectedSite(world, connector, specByKind(kind), "retry:stadium", "-600:0", () => {
        screened += 1;
        return screened === 1 ? "candidate-local-relocation-refused" : null;
      });
      assert.ok(retried.site && retried.network, "a proposal-local relocation refusal must continue to the next candidate");
      assert.ok(screened >= 2, "the proposal validator must screen each candidate until one can commit");
    }
    if (kind === "station") {
      const localDoor = stationEntranceLocal(assigned.site.radius);
      const expectedDoor = { x: assigned.site.x + localDoor.x * Math.cos(assigned.site.yaw) + localDoor.z * Math.sin(assigned.site.yaw), z: assigned.site.z - localDoor.x * Math.sin(assigned.site.yaw) + localDoor.z * Math.cos(assigned.site.yaw) };
      assert.ok(Math.hypot(assigned.site.access.doorX - expectedDoor.x, assigned.site.access.doorZ - expectedDoor.z) <= 0.01, "station access must reference the actual hall's positive-z entrance facade");
      const gate = assigned.network.nodes.get(assigned.site.access.nodeId);
      const dx = gate.x - assigned.site.access.doorX; const dz = gate.z - assigned.site.access.doorZ; const length = Math.hypot(dx, dz);
      const normal = specByKind(kind).planarAccess.entrance.outward;
      const yaw = assigned.site.yaw;
      const facing = ((normal.x * Math.cos(yaw) + normal.z * Math.sin(yaw)) * dx + (-normal.x * Math.sin(yaw) + normal.z * Math.cos(yaw)) * dz) / length;
      assert.ok(facing >= Math.cos(Math.PI / 4), "station model entrance must face its declared gate");
    }
    for (const edge of assigned.network.edges.values()) {
      const [a, b] = [edge.points[0], edge.points.at(-1)];
      const dx = b.x - a.x; const dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((assigned.site.x - a.x) * dx + (assigned.site.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const gap = Math.hypot(assigned.site.x - a.x - dx * t, assigned.site.z - a.z - dz * t);
      assert.ok(gap >= assigned.site.radius + edge.width / 2, `${kind} candidate overlaps ${edge.id} road envelope (${gap} < ${assigned.site.radius + edge.width / 2})`);
    }
    assert.equal(JSON.stringify([...network.edges]), before, "joint proposals cannot pre-publish road changes");
    const rejected = assignConnectedSite({ ...world, buildable: () => false }, connector, specByKind(kind), `bad:${kind}`, "-600:0");
    assert.equal(rejected.site, null); assert.ok(rejected.reason);
    const blocked = assignConnectedSite(world, { ...connector, geo: { ...connector.geo, terrain: { slope: () => 2 } } }, specByKind(kind), `blocked:${kind}`, "-600:0");
    assert.equal(blocked.site, null, "valid land alone cannot accept an unsafe entrance corridor");
    assert.equal(JSON.stringify([...network.edges]), before);
  }
}

// ── (a) 完整性：真实规划的放置种类 ↔ 表行 一一对应（含半径常量）──────────────────────
const ISLANDS = [[1, 0, null], [2, 3, MIAMI_COASTAL], [5, 7, MIAMI_COASTAL], [2, 13, null], [3, 21, MIAMI_COASTAL]];
const placedKinds = new Map();
for (const [tier, i, cfg] of ISLANDS) {
  const seed = 1703294958 + i * 7919;
  const plan = createCityPlan(seed, tier, cfg);
  for (const site of [...plan.publicSites, ...plan.landmarks]) {
    if (!site.radius) continue;
    const row = specByKind(site.kind);
    assert.ok(row, `seed ${seed}/t${tier}: placed kind "${site.kind}" has no SiteSpec row (siting knowledge would be lost at wire-up)`);
    assert.equal(site.radius, row.radius, `seed ${seed}/t${tier}: ${site.kind} radius ${site.radius} != table ${row.radius}`);
    placedKinds.set(site.kind, (placedKinds.get(site.kind) ?? 0) + 1);
  }
}
// 抽签类不必每个岛都出现，但 15 行里除 suspension-bridge 外的公共用地 6 类必须全部出现；
// 地标类在 5 个岛（固定 5 座 + 抽签 ≥1 席）上合计出现 ≥7 类。
const publicRows = SITE_SPECS.filter((r) => r.priority < 100).map((r) => r.kind);
for (const kind of publicRows) assert.ok(placedKinds.has(kind), `public kind "${kind}" never placed across the sample islands`);
const landmarkRows = SITE_SPECS.filter((r) => r.priority === 100).map((r) => r.kind);
const seenLandmarks = landmarkRows.filter((k) => placedKinds.has(k));
assert.ok(seenLandmarks.length >= 7, `only ${seenLandmarks.length} landmark kinds appeared (${seenLandmarks.join(",")}) — sample too small to cross-check the table`);

// ── (b) 分类与 cityPlan 现行集合一致（6b 派生化之前的值门禁）────────────────────────
assert.deepEqual([...coastalSitingKinds()].sort(), ["ferris-wheel", "harbor", "lighthouse", "sail-opera", "villa-complex"], "coastalSitingKinds != SHORE_SITE_KINDS");
assert.deepEqual([...straddleSitingKinds()], ["arch"], "straddleSitingKinds != STRADDLE");
assert.deepEqual([...frontageExemptKinds()].sort(), ["arch", "civic", "ferris-wheel", "harbor", "lighthouse", "sail-opera", "villa-complex"], "frontageExemptKinds != SHORE_BOUND ∪ STRADDLE");

// ── (c) 表自身确定性 ────────────────────────────────────────────────────────────
// （验收修订）原「同对象 JSON.stringify 自比」恒真，已删——真正的确定性证明是上面的 anchors
// 双跑与 runAssignment 双世界双跑；此处改为钉死导出序的可区分断言。
const exportOrder = SITE_SPECS.map((r) => r.kind).join(",");
assert.match(exportOrder, /^[a-z-]+(,[a-z-]+)*$/, "SITE_SPECS rows must all be lower-case kinds");
assert.ok(exportOrder.length > 0 && !exportOrder.includes("undefined"), "SITE_SPECS rows must all carry a kind");
const kinds = SITE_SPECS.map((r) => r.kind);
assert.equal(new Set(kinds).size, kinds.length, "duplicate kind rows in SITE_SPECS");
assert.equal(kinds.length, 15, `expected 15 rows (6 public + 9 landmark candidates), got ${kinds.length}`);
assert.equal(specByKind("suspension-bridge"), undefined, "suspension-bridge must stay unregistered (derived decoration, radius 0)");
const anchorWorld = { core: { x: 12.5, z: -7.25 }, R: 390, turn: 1.25, coast: Array.from({ length: 96 }, (_, i) => ({ x: Math.cos((i / 96) * Math.PI * 2) * 300, z: Math.sin((i / 96) * Math.PI * 2) * 300 })), hasRiver: true, riverX: (z) => 30 + Math.sin(z * 0.006) * 20, riverWidth: () => 18, hillDir: { x: 0.8, z: 0.6 }, hillLine: 210 };
const anchors1 = SITE_SPECS.map((row) => nominalAnchorPoint(row, anchorWorld));
const anchors2 = SITE_SPECS.map((row) => nominalAnchorPoint(row, anchorWorld));
assert.deepEqual(anchors1, anchors2, "nominalAnchorPoint not deterministic");
for (const p of anchors1) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `nominalAnchorPoint produced NaN for some row (${JSON.stringify(p)})`);

console.log(`City sitespec: table v${SITING_TABLE_VERSION} — ${SITE_SPECS.length} rows, ${placedKinds.size} kinds placed across ${ISLANDS.length} islands all match radius; coastal/straddle/frontage-exempt sets equal cityPlan's; deterministic.`);

// ── (e) 6a-3：access/assign 骨架——确定性、hard 闸门、无候选不回落 ─────────────────
// 合成世界（解析地理，不跑真实 buildPlan）：圆岛 R=300（宽缓滩：1.2 平台到 294，294–310 缓降，
// 岸外 314 起深水 ≤ −0.8）、sin 弯河偏在 x≈150、5 条放射主干、无环线/桥。
function makeWorld() {
  const R = 300; const core = { x: 0, z: 0 };
  const coast = Array.from({ length: 96 }, (_, i) => ({ x: Math.cos((i / 96) * Math.PI * 2) * R, z: Math.sin((i / 96) * Math.PI * 2) * R }));
  const d = (x, z) => Math.hypot(x, z);
  const riverX = (z) => 150 + 40 * Math.sin(z * 0.006);
  const riverWidth = () => 16;
  const height = (x, z) => { const r = d(x, z); return r <= 294 ? 1.2 : r <= 310 ? 1.2 - (r - 294) * 0.1 : Math.max(-1.2, -0.4 - (r - 310) * 0.1); };
  const coastDistance = (x, z) => R - d(x, z);
  const landClearance = (x, z) => Math.min(coastDistance(x, z), Math.abs(x - riverX(z)) - riverWidth(z));
  return {
    core, R, turn: 1.0, coast,
    trunkRuns: Array.from({ length: 5 }, (_, i) => {
      const a = i * ((Math.PI * 2) / 5) + 0.3;
      return Array.from({ length: 5 }, (_, k) => 60 + k * 50).map((r) => ({ x: Math.cos(a) * r, z: Math.sin(a) * r }));
    }),
    ringRuns: [], bridges: [], placed: [],
    height, riverX, riverWidth,
    inRiver: (x, z) => Math.abs(x - riverX(z)) < riverWidth(z),
    riverBank: (x, z, bank) => Math.abs(x - riverX(z)) < riverWidth(z) + bank,
    coastDistance, landClearance,
    buildable: (x, z) => landClearance(x, z) > 12,
    hasRiver: true,
    hillDir: { x: 1, z: 0 }, hillLine: 220, hillProj: (x) => x,
  };
}
const CLASS_SAMPLE = ["civic", "station", "harbor", "arch", "sail-opera", "ferris-wheel"].map((k) => specByKind(k));
assert.ok(CLASS_SAMPLE.every(Boolean), "class sample kinds missing from the table");
{
  const worldA = makeWorld(); const worldB = makeWorld();
  const outA = runAssignment(worldA, CLASS_SAMPLE);
  const outB = runAssignment(worldB, CLASS_SAMPLE);
  // (e1) 确定性：同输入两次运行，结果与放置表完全一致（设计 §5A-7 / §6.3 稳定 tie-break）。
  assert.deepEqual(outA, outB, "runAssignment not deterministic");
  assert.deepEqual(worldA.placed, worldB.placed, "sequential placed list not deterministic");
  // (e2) 处理序 = priority 升序、同档按 kind 字典序（public 先于地标）。
  assert.deepEqual(outA.map((r) => r.kind), ["civic", "station", "harbor", "arch", "ferris-wheel", "sail-opera"], "assignment order != priority order");
  // (e3) 广场 = 核心点（构造保证）；合成世界足够开阔，至少 4/6 类应找到合法候选（生成器确实在产出）。
  assert.equal(outA[0].chosen?.id, "plaza:core", "plaza must sit on the core by construction");
  const placedCount = outA.filter((r) => r.chosen).length;
  assert.ok(placedCount >= 4, `only ${placedCount}/6 kinds found a viable candidate in the open synthetic world (${outA.map((r) => `${r.kind}:${r.chosen ? "ok" : r.reason}`).join(", ")})`);
  // (e4) 每个结果要么有 chosen 要么有显式原因（失败不静默、不回落名义坐标）。
  assert.ok(outA.every((r) => r.chosen || (r.reason && r.candidates >= 0)), "an assignment neither chose nor explained");
}
{
  // (e5) hard 闸门逐判据：河道中心必被 buildable-center 拒；陆上点位必被 deep-water-ring 拒。
  const world = makeWorld();
  const station = specByKind("station"); const opera = specByKind("sail-opera");
  assert.equal(siteCandidateHardReject(world, station, { id: "t", x: world.riverX(0), z: 0, yaw: 0, source: "t" }), "buildable-center", "in-river candidate must be rejected by buildable-center");
  const badOffshore = { id: "t", x: 150, z: 0, yaw: 0, source: "t", shoreAnchor: { x: 250, z: 0 } };
  assert.equal(siteCandidateHardReject(world, opera, badOffshore), "deep-water-ring", "on-land candidate must be rejected by deep-water-ring");
}
{
  // (e6) 无合法候选：毒化世界（全岛低净空、非深水）——全部显式失败，chosen 均为 null。
  const poisoned = makeWorld();
  poisoned.landClearance = () => 5;
  poisoned.buildable = () => false;
  poisoned.height = () => 0.3;
  const out = runAssignment(poisoned, CLASS_SAMPLE);
  assert.ok(out.every((r) => !r.chosen && r.reason), `poisoned world must fail every kind explicitly (${out.map((r) => `${r.kind}:${r.reason}`).join(", ")})`);
}
console.log("City sitespec assign/access skeleton: deterministic double-run, priority order, plaza-on-core, hard gate rejects in-river/on-land placements, poisoned world fails explicitly without nominal-coordinate fallback.");
