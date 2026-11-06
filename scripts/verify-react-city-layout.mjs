#!/usr/bin/env node
// Execute the production layout, not a second implementation of its allocator.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

const { layoutCity, MIAMI_COASTAL } = await loadCity({
  "engine/cityLayout.ts": ["layoutCity"], "engine/citySeaside.ts": ["MIAMI_COASTAL"],
});

function model(count, harnesses = ["codex", "claude-code", "dsh", "harness:zcode"]) {
  const buildings = Array.from({ length: count }, (_, index) => ({
    id: `session:${index}`, districtId: harnesses[index % harnesses.length], height: 2.6 + index % 46,
    footprint: 7.2, startedAt: index * 1000,
  }));
  return { buildings, districts: harnesses.map((id) => ({ id, label: id, sessionCount: buildings.filter((b) => b.districtId === id).length, anomaly: null })) };
}
const addresses = (layout) => Object.fromEntries(layout.districts.flatMap((district) => [...district.slots].map(([id, p]) => [id, [p.id, p.x, p.z, p.yaw]])));
function coastGap(layout, p) {
  let best = Infinity;
  for (let i = 0; i < layout.coast.length; i += 1) {
    const a = layout.coast[i], b = layout.coast[(i + 1) % layout.coast.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}
function validate(layout, input) {
  const all = layout.districts.flatMap((district) => [...district.slots]);
  assert.equal(all.length, input.buildings.length, "every building must be placed");
  const blockSideLengths = layout.blocks.flatMap((block) => block.polygon.map((point, index) => {
    const next = block.polygon[(index + 1) % block.polygon.length];
    return Math.round(Math.hypot(point.x - next.x, point.z - next.z) * 10) / 10;
  }));
  assert(new Set(blockSideLengths).size > 12, "seeded street junction offsets prevent a mechanically repeated grid");
  assert.equal(new Set(all.map(([, p]) => p.id)).size, all.length, "addresses are unique");
  const nodes = new Map(layout.roadNodes.map((node) => [node.id, node]));
  assert.deepEqual(layout.retentionReport.unresolvedParcelFrontage, [], "occupied parcel frontage must remain current");
  const hotelAddresses = all.map(([, parcel]) => parcel.id).filter(id => id.startsWith("hotel:")).sort();
  assert.deepEqual(layout.retentionReport.unsupportedAuxiliaryFrontage, hotelAddresses, "unproved auxiliary hotel access remains in the display denominator");
  if (hotelAddresses.length) assert.equal(layout.displayOutcome.status, "failed", "missing hotel service proof cannot become implicit success");
  const liveEdges = new Set(layout.roadEdges.map((edge) => edge.id));
  for (const [, parcel] of all) if (parcel.frontage) {
    assert.equal(parcel.frontage.networkVersion, layout.derivedNetworkVersion);
    assert(liveEdges.has(parcel.frontage.hostEdgeId), `${parcel.id}: display pruning removed its real frontage host`);
    for (const id of parcel.frontage.primaryEdgePath) assert(liveEdges.has(id), `${parcel.id}: display pruning removed its primary service route`);
  }
  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of layout.roadEdges) {
    assert(nodes.has(edge.from) && nodes.has(edge.to));
    adjacency.get(edge.from).push(edge.to); adjacency.get(edge.to).push(edge.from);
  }
  assert(layout.roadEdges.some((edge) => edge.width === 12), "island-spanning primary arterials have a distinct wide-road tier");
  assert(layout.roadEdges.some((edge) => edge.width === 8), "district arterials remain narrower than primary routes");
  assert(layout.roadEdges.some((edge) => edge.width === 5), "local streets remain the narrowest road tier");
  const queue = [layout.roadNodes[0].id]; const visited = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    for (const neighbor of adjacency.get(queue[index])) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
  }
  assert.equal(visited.size, nodes.size, "surface road graph is connected across harnesses");
  for (const site of layout.publicSites) if (site.access) {
    assert(visited.has(site.access.nodeId), `${site.id}: declared plot gate must survive display pruning on the primary network`);
  }
  const groundNodes = new Set(layout.roadEdges.filter((edge) => !edge.bridge).flatMap((edge) => [edge.from, edge.to]));
  const airportCauseway = layout.airport?.causeway;
  const airportPlatformNode = airportCauseway ? `${airportCauseway.to.x}:${airportCauseway.to.z}` : null;
  const airportCausewayEdgeId = airportCauseway ? `${airportCauseway.fromNode}/${airportPlatformNode}` : null;
  for (const edge of layout.roadEdges) if (edge.bridge) for (const id of [edge.from, edge.to]) {
    const declaredAirportPlatformLanding = edge.id === airportCausewayEdgeId
      && edge.from === airportCauseway.fromNode
      && edge.to === airportPlatformNode
      && id === airportPlatformNode;
    assert(groundNodes.has(id) || declaredAirportPlatformLanding || layout.retentionReport.missingBridgeLandings.includes(id), `${edge.id}: display pruning lost a planned ground landing at ${id}`);
  }
  for (const [, parcel] of all) {
    assert(Number.isFinite(layout.terrain.height(parcel.x, parcel.z)));
    assert.equal(layout.terrain.height(parcel.x, parcel.z), 1.2, "buildings occupy the level coastal plain");
    // Parcel footprint (half-diagonal of width × depth) must clear every street + sidewalk, in any direction.
    // 曾只检查水平/竖直路段：街网一旦斜向（warp 后已是斜的，G2 起各片区朝向不同）这条断言就形同虚设。
    // 高楼并入的相邻地块（parcel.mergedWith，宽 14.4）按真实朝向矩形检查：两块原地块各自都过了圆判据，
    // 拼成的矩形不压路；但 14.4×8 的外接圆比两块原地块的圆都大一圈，会把贴着横街的并地块误判成压路。
    if (parcel.mergedWith) {
      const ax = Math.sin(parcel.yaw); const az = Math.cos(parcel.yaw); const bx = az; const bz = -ax;
      for (const edge of layout.roadEdges) for (let segment = 1; segment < edge.points.length; segment += 1) {
        const a = edge.points[segment - 1], b = edge.points[segment], len = Math.hypot(b.x - a.x, b.z - a.z);
        for (let d = 0; d <= len; d += 1) {
          const t = len ? d / len : 0;
          const dx = a.x + (b.x - a.x) * t - parcel.x; const dz = a.z + (b.z - a.z) * t - parcel.z;
          assert(!(Math.abs(dx * bx + dz * bz) < parcel.width / 2 + edge.width / 2 + 0.5 && Math.abs(dx * ax + dz * az) < parcel.depth / 2 + edge.width / 2 + 0.5),
            `merged parcel ${parcel.id} overlaps road ${edge.id}`);
        }
      }
      continue;
    }
    const halfDiagonal = Math.hypot(parcel.width, parcel.depth) / 2;
    for (const edge of layout.roadEdges) for (let segment = 1; segment < edge.points.length; segment += 1) {
      const a = edge.points[segment - 1], b = edge.points[segment];
      const dx = b.x - a.x; const dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((parcel.x - a.x) * dx + (parcel.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const gap = Math.hypot(parcel.x - a.x - dx * t, parcel.z - a.z - dz * t);
      assert(gap >= halfDiagonal + edge.width / 2 + 0.5, `parcel ${parcel.id} overlaps road ${edge.id} (gap ${gap.toFixed(1)})`);
    }
  }
  // 海滨酒店地块（无论是否已有楼）按真实朝向矩形不得压路：曾 17% 的酒店地块压在后加的接入路/环岛路上（真机：楼占在路上）。
  for (const parcel of all.map(([, parcel]) => parcel).filter(parcel => parcel.id.startsWith("hotel:"))) {
    const ax = Math.sin(parcel.yaw); const az = Math.cos(parcel.yaw); const bx = az; const bz = -ax;
    for (const edge of layout.roadEdges) for (let segment = 1; segment < edge.points.length; segment += 1) {
      const a = edge.points[segment - 1], b = edge.points[segment], len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 0; d <= len; d += 1.5) {
        const t = len ? d / len : 0;
        const dx = a.x + (b.x - a.x) * t - parcel.x; const dz = a.z + (b.z - a.z) * t - parcel.z;
        assert(!(Math.abs(dx * bx + dz * bz) < parcel.width / 2 + edge.width / 2 + 0.5 && Math.abs(dx * ax + dz * az) < parcel.depth / 2 + edge.width / 2 + 0.5),
          `hotel lot ${parcel.id} overlaps road ${edge.id}`);
      }
    }
  }
  const edgePairs = new Set(layout.roadEdges.map((edge) => [edge.from, edge.to].sort().join("/")));
  for (const district of layout.districts) for (const route of district.carPaths) {
    assert.deepEqual({ ...route[0] }, { ...route.at(-1) }, "traffic circuits close without teleporting");
    for (let index = 1; index < route.length; index += 1) {
      const ids = [route[index - 1], route[index]].map((p) => `${p.x}:${p.z}`).sort().join("/");
      assert(edgePairs.has(ids), "traffic follows rendered roads");
    }
  }
}

for (const [count, harnesses] of [[0, []], [1, ["codex"]], [700], [1400, ["codex"]], [1480], [240, Array.from({ length: 12 }, (_, i) => `plugin:${i}`)]]) {
  const input = model(count, harnesses); const layout = layoutCity(input); validate(layout, input);
  const reversed = { ...input, buildings: [...input.buildings].reverse(), districts: [...input.districts].reverse() };
  assert.deepEqual(addresses(layoutCity(reversed)), addresses(layout), "input order does not change a fresh layout");
}
const first = layoutCity(model(500));
// 分页追加在同一规模档位内（400 会话一档）必须不搬家；跨档时岛按原形状放大、整体重排（CITY_PLANNING_SPEC §4.2，
// 比例映射留待后续），所以这里用同档的 500 → 780。
const expandedInput = model(780); const expanded = layoutCity(expandedInput, first);
validate(expanded, expandedInput);
for (const [id, address] of Object.entries(addresses(first))) assert.deepEqual(addresses(expanded)[id], address, "pagination retains existing addresses");
const changed = { ...expandedInput, buildings: expandedInput.buildings.map((building) => ({ ...building, height: 48, startedAt: 0 })) };
assert.deepEqual(addresses(layoutCity(changed, expanded)), addresses(expanded), "token growth and replay timing do not move buildings");
const additionalHarness = model(1400, ["codex", "claude-code", "dsh", "harness:zcode", "new-harness"]);
validate(layoutCity(additionalHarness, expanded), additionalHarness);
// 城市配套（学校/商场/医院）：数量随会话规模增长、只占没有会话楼的整街区、落成时刻随规模单调、刷新不搬家。
const civicCount = (count) => layoutCity(model(count)).civics.length;
assert.equal(civicCount(0), 0, "an empty city has no civic buildings");
// 规划城区约 1600 个地块：会话楼接近填满时空街区所剩无几，配套不挤占会话地块，数量随之封顶（1400 会话时约 11 座）。
assert(civicCount(90) < civicCount(300) && civicCount(300) < civicCount(700) && civicCount(700) < civicCount(1000), "civic buildings grow with the city until it runs out of empty blocks");
for (const layout of [first, expanded]) {
  const sessionBlocks = new Set(layout.districts.flatMap((district) => [...district.slots.values()].map((parcel) => parcel.blockId)));
  for (const civic of layout.civics) assert(!sessionBlocks.has(civic.parcelId), `${civic.id} must not share a block with session buildings`);
  assert.equal(new Set(layout.civics.map((civic) => civic.parcelId)).size, layout.civics.length, "one civic building per block");
  for (let index = 1; index < layout.civics.length; index += 1) assert(layout.civics[index].unlockAt >= layout.civics[index - 1].unlockAt, "civic buildings open in growth order");
}
const expandedBlocks = new Set(expanded.districts.flatMap((district) => [...district.slots.values()].map((parcel) => parcel.blockId)));
for (const civic of first.civics) {
  if (expandedBlocks.has(civic.parcelId)) continue;
  const again = expanded.civics.find((item) => item.id === civic.id);
  assert(again && again.parcelId === civic.parcelId, `${civic.id} keeps its block while the block stays free`);
}
// 个人化地形：每个用户一个随机种子（首次打开城市页生成并落盘）。任何种子下都必须是一座完整可用的城：
// 会话全部落位、公共用地与城区锚点不落进海里、同种子同输入得到同一座城。
for (const seed of [7, 42, 2026, 31337, 99991, 123456789, 4294967295]) {
  const input = model(700);
  const layout = layoutCity(input, null, seed);
  validate(layout, input);
  for (const site of layout.publicSites) {
    // Production's 12-unit setback is a conservative polar distance; the exposed 96-segment
    // coast polyline has chord error, so its Euclidean gap can be several units larger.
    if (site.kind === "harbor") assert(coastGap(layout, site) <= 20, `seed ${seed}: harbor remains within the coastal setback (including coast approximation)`);
    else assert(layout.terrain.height(site.x, site.z) > 0.5, `seed ${seed}: ${site.id} must sit on land`);
  }
  for (const anchor of layout.districtAnchors) assert(layout.terrain.height(anchor.x, anchor.z) > 0.5, `seed ${seed}: district anchor must sit on land`);
  assert.deepEqual(addresses(layoutCity(input, null, seed)), addresses(layout), `seed ${seed}: deterministic`);
}
// Vice City 环境楼群：低会话量时依然有城区肌理，但只占空置商业地块，且绝不伪装成会话数据。
{
  const input = model(3, ["codex", "claude-code", "dsh"]);
  // 「繁华」档 = VICE 原行为（F4 full）：下面的断言照旧钉住它。
  const layout = layoutCity(input, null, 523001688, MIAMI_COASTAL, "full");
  const repeated = layoutCity(input, null, 523001688, MIAMI_COASTAL, "full");
  assert(layout.contextBuildings.length >= 140, `low-volume Miami city still has broad urban fabric (${layout.contextBuildings.length})`);
  console.log(`Vice City low-volume context buildings: ${layout.contextBuildings.length}`);
  // F2：背景楼按次序在数据窗口前 85% 内逐个落成（回放起点是空地）。
  const starts = input.buildings.map((building) => building.startedAt);
  const windowStart = input.windowStartMs ?? Math.min(...starts);
  const windowEnd = input.windowEndMs ?? Math.max(...starts);
  for (const building of layout.contextBuildings) assert(Number.isFinite(building.appearAt) && building.appearAt >= windowStart && building.appearAt <= windowStart + (windowEnd - windowStart) * 0.85 + 1, `${building.id} appears inside the data window`);
  for (let i = 1; i < layout.contextBuildings.length; i += 1) assert(layout.contextBuildings[i].appearAt >= layout.contextBuildings[i - 1].appearAt, "backdrop appears in placement order");
  assert.deepEqual(layout.contextBuildings, repeated.contextBuildings, "environment buildings are deterministic for a seed and session set");
  const sessionLots = new Set(layout.districts.flatMap((district) => [...district.slots.values()].map((parcel) => parcel.id)));
  const civicLots = new Set(layout.civics.map((civic) => civic.parcelId));
  const gardenBlocks = new Set(layout.gardens.map((garden) => garden.blockId));
  for (const building of layout.contextBuildings) {
    const lotId = building.id.slice("context:".length);
    assert(!sessionLots.has(lotId), `${building.id} cannot overlap a session building`);
    assert(!civicLots.has(lotId), `${building.id} cannot occupy a civic site`);
    assert(!gardenBlocks.has(lotId.split("/")[0]), `${building.id} cannot occupy a garden block`);
    const expectedHeight = building.zone === "downtown" ? [38, 72]
      : building.zone === "commercial" ? [20, 48]
        : building.zone === "waterfront" ? [16, 36]
          : [8, 22];
    assert(building.height >= expectedHeight[0] && building.height <= expectedHeight[1], `${building.zone} gets a readable city-height band`);
    const halfDiagonal = Math.hypot(building.width, building.depth) / 2;
    for (const edge of layout.roadEdges) for (let segment = 1; segment < edge.points.length; segment += 1) {
      const a = edge.points[segment - 1], b = edge.points[segment], dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((building.x - a.x) * dx + (building.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const distance = Math.hypot(building.x - a.x - dx * t, building.z - a.z - dz * t);
      assert(distance >= halfDiagonal + edge.width / 2 + 0.5, `${building.id} footprint stays clear of road ${edge.id}`);
    }
    for (const [, session] of layout.districts.flatMap((district) => [...district.slots])) {
      const distance = Math.hypot(building.x - session.x, building.z - session.z);
      assert(distance >= halfDiagonal + Math.hypot(session.width, session.depth) / 2 + 2, `${building.id} does not crowd a session building`);
    }
    for (const civic of layout.civics) assert(Math.hypot(building.x - civic.x, building.z - civic.z) >= halfDiagonal + Math.hypot(civic.width, civic.depth) / 2 + 2, `${building.id} does not crowd civic facilities`);
  }
  // 海滨酒店 / Ocean Drive 街墙地块上的会话楼除外：背景楼按设计不进海滨保留带，这两排周边本就没有背景肌理
  // （酒店地块由各城区共享；Ocean Drive 地块是东岛会话楼的街墙，临海一侧就是沙滩）。
  for (const [, session] of layout.districts.flatMap((district) => [...district.slots]).filter(([, s]) => !s.blockId.startsWith("hotel:") && !s.blockId.startsWith("oceandrive:"))) {
    assert(layout.contextBuildings.some((building) => Math.hypot(building.x - session.x, building.z - session.z) < 70), `session districts should receive nearby non-session city fabric (${session.blockId} @ ${Math.round(session.x)},${Math.round(session.z)})`);
  }
  for (let i = 0; i < layout.contextBuildings.length; i += 1) for (let j = i + 1; j < layout.contextBuildings.length; j += 1) {
    const a = layout.contextBuildings[i]; const b = layout.contextBuildings[j];
    const clearance = Math.hypot(a.width, a.depth) / 2 + Math.hypot(b.width, b.depth) / 2 + 2;
    assert(Math.hypot(a.x - b.x, a.z - b.z) >= clearance, "context building footprints do not overlap");
  }
}
// 背景楼「自动」档（CITY_DATA_LEGIBILITY_SPEC F1）：楼量随会话数、离会话楼 ≥ 60、绝不贴着城区填。
// 曾恒为「繁华」：3 个会话的城里 200+ 栋背景楼紧贴城区外缘，host 分区读不出来、数据量也读不出来（真机截图）。
// 「关闭」档：零背景楼。
{
  for (const [sessions, seed] of [[3, 523001688], [50, 7], [700, 42]]) {
    const input = model(sessions, ["codex", "claude-code", "dsh"]);
    const auto = layoutCity(input, null, seed, MIAMI_COASTAL, "auto");
    const off = layoutCity(input, null, seed, MIAMI_COASTAL, "off");
    const expected = Math.round(sessions * 0.35);
    assert(auto.contextBuildings.length <= expected, `auto backdrop scales with data: ${sessions} sessions -> ${auto.contextBuildings.length} (<= ${expected})`);
    assert.equal(off.contextBuildings.length, 0, "off backdrop is a data-only city");
    const slots = auto.districts.flatMap((district) => [...district.slots.values()]);
    for (const building of auto.contextBuildings) {
      const nearest = Math.min(...slots.map((slot) => Math.hypot(slot.x - building.x, slot.z - building.z)));
      assert(nearest >= 60, `${building.id} keeps out of session districts (${nearest.toFixed(1)} < 60)`);
    }
    assert.deepEqual(addresses(auto), addresses(off), "backdrop mode never moves a session building");
    console.log(`Backdrop auto: ${sessions} sessions -> ${auto.contextBuildings.length} context buildings`);
  }
}
// 海滨酒店是会话楼：酒店地块（hotel:<i>/0）只由会话占用；背景楼与配套不得占；会话少时没有酒店。
// 曾是一排装饰酒店——无论有没有数据都立着、点了没反应（用户：「海滨酒店为什么不能作为执行环境的会话楼」）。
{
  for (const [sessions, seed] of [[3, 523001688], [700, 42], [2000, 7]]) {
    const input = model(sessions, ["codex", "claude-code", "dsh"]);
    const layout = layoutCity(input, null, seed, MIAMI_COASTAL);
    const hotelSlots = layout.districts.flatMap((district) => [...district.slots.values()]).filter((parcel) => parcel.blockId.startsWith("hotel:"));
    for (const building of layout.contextBuildings) assert(!building.id.includes("hotel:"), "backdrop never takes a hotel lot");
    for (const civic of layout.civics) assert(!civic.parcelId.startsWith("hotel:"), "civics never take a hotel lot");
    assert.equal(new Set(hotelSlots.map((parcel) => parcel.id)).size, hotelSlots.length, "one session per hotel lot");
    if (sessions === 3) assert.equal(hotelSlots.length, 0, "a 3-session city has no hotels");
    console.log(`Hotel lots: ${sessions} sessions -> ${hotelSlots.length} session hotels`);
  }
}
// 配套按服务半径铺开：同一座岛上任意两座配套至少隔 60，学校多数落在居住区、商场多数落在商业区/市中心。
{
  const layout = layoutCity(model(1000), null, 42);
  const civics = layout.civics;
  assert(civics.length >= 10, `enough civic buildings to judge spread (${civics.length})`);
  for (let i = 0; i < civics.length; i += 1) for (let j = i + 1; j < civics.length; j += 1) assert(Math.hypot(civics[i].x - civics[j].x, civics[i].z - civics[j].z) >= 60, "civic buildings keep their distance");
  // 大门朝路（用户：医院门前没有路）：配套正门（局部 +z）外 8 处离最近路面 ≤ 15。
  for (const civic of civics) {
    const q = { x: civic.x + Math.sin(civic.yaw) * (civic.depth / 2 + 8), z: civic.z + Math.cos(civic.yaw) * (civic.depth / 2 + 8) };
    const gap = Math.min(...layout.roadEdges.filter((e) => !e.bridge).flatMap((e) => e.points.slice(1).map((b, index) => { const a = e.points[index]; const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.z - a.z) * dz) / l2)); return Math.hypot(q.x - a.x - dx * t, q.z - a.z - dz * t) - e.width / 2; })));
    assert(gap <= 15, `${civic.id} (${civic.kind}) entrance faces a road (gap ${gap.toFixed(1)})`);
  }
  const zoneOf = (civic) => layout.blocks.find((block) => block.id === civic.parcelId)?.zone;
  const schools = civics.filter((civic) => civic.kind === "school");
  const malls = civics.filter((civic) => civic.kind === "mall");
  assert(schools.filter((civic) => zoneOf(civic) === "residential").length >= schools.length / 2, "schools prefer residential blocks");
  // 岛上商业/市中心街区本就稀少（被会话楼占满），商场退而求其次落在海滨（沿海商业街）：这里只要求不落进居住区。
  assert(malls.filter((civic) => zoneOf(civic) !== "residential").length >= malls.length / 2, "malls prefer commercial, downtown or waterfront blocks");
}
// 跨档地址映射：整体长大而不是整体洗牌——每栋楼落在「放大后的原位置」附近。
{
  // 档位边界：1 档 = 2000 栋，超出扩展到 2 档（4000 栋）。
  const before = layoutCity(model(1900), null, 42);
  const after = layoutCity(model(2100), before, 42);
  assert(after.scaleTier > before.scaleTier, "1900 -> 2100 sessions crosses a tier");
  const ratio = after.islandRadius / before.islandRadius;
  const was = new Map(before.districts.flatMap((d) => [...d.slots]));
  const now = new Map(after.districts.flatMap((d) => [...d.slots]));
  let moved = 0; let kept = 0;
  for (const [id, parcel] of was) {
    const next = now.get(id); if (!next) continue;
    kept += 1;
    if (Math.hypot(next.x - parcel.x * ratio, next.z - parcel.z * ratio) <= 120) moved += 1;
  }
  assert(kept >= 1770, `buildings survive a tier change (${kept}/1900)`);
  assert(moved / kept >= 0.9, `a tier change keeps buildings near their scaled position (${moved}/${kept})`);
}
// 跨档：同一种子从 1 档到 2 档，岛只放大不变形（归一化轮廓逐点重合）。
{
  const small = layoutCity(model(1500), null, 42); const big = layoutCity(model(3000), null, 42);
  assert(big.scaleTier > small.scaleTier, "more sessions move to a larger tier");
  const ratio = big.islandRadius / small.islandRadius;
  assert(ratio > 1.2, "a larger tier grows the island");
  small.coast.forEach((p, i) => { const q = big.coast[i]; assert(Math.hypot(q.x - p.x * ratio, q.z - p.z * ratio) < 0.5, "tier change scales the coast without reshaping it"); });
}
// v3 progressive load: plan the island for the full window so later pages fill lots
// instead of retiering and reshuffling the first page.
{
  const withStats = (count, total) => {
    const input = model(count);
    input.stats = { totalSessions: total, tokensTotal: 0, renderedSessions: count, aggregatedSessions: 0, activeCount: 0, truncated: count < total };
    return input;
  };
  const firstPage = layoutCity(withStats(500, 4000), null, 42);
  const laterPages = layoutCity(withStats(2000, 4000), firstPage, 42);
  assert.equal(firstPage.scaleTier, laterPages.scaleTier, "paging must not change the planned island tier");
  const was = addresses(firstPage);
  const now = addresses(laterPages);
  let kept = 0;
  for (const id of Object.keys(was)) if (now[id] && now[id][0] === was[id][0]) kept += 1;
  assert(kept >= 480, `later pages keep first-page parcels (${kept}/500)`);
}
console.log("City layout: full placement, unique lots, road clearance/connectivity, traffic, incremental stability, civic growth, per-user seeds and deterministic Vice City context buildings passed.");
