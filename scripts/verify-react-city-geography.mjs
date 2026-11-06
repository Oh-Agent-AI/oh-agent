#!/usr/bin/env node
// 种子地理守卫（CITY_PLANNING_SPEC §6）：不同种子必须是明显不同的岛，任何种子都是完整可用的城。
// 曾经海岸是写死折线 + ±19 抖动，30 个种子的轮廓几乎完全重合——截图里「每个人的岛都一样」。
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";

// Native execution; the seed set and every assertion below remain unchanged.
// Cross-engine coverage is provided by verify-city-cross-engine, not this VM.
const { layoutCity } = await loadCity({ "engine/cityLayout.ts": ["layoutCity"] });

const harnesses = ["codex", "claude-code", "dsh", "harness:zcode"];
const model = (count) => {
  const buildings = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, districtId: harnesses[i % harnesses.length], height: 3 + (i * 37) % 44, footprint: 7.2, startedAt: i * 1000 }));
  return { buildings, districts: harnesses.map((id) => ({ id, label: id, sessionCount: buildings.filter((b) => b.districtId === id).length, anomaly: null })) };
};

/** 海岸轮廓的世界坐标极坐标剖面：72 个方位上的半径，按均值归一化（只比形状，不比大小）。 */
function profile(coast) {
  const cx = coast.reduce((a, p) => a + p.x, 0) / coast.length;
  const cz = coast.reduce((a, p) => a + p.z, 0) / coast.length;
  const polar = coast.map((p) => ({ a: Math.atan2(p.z - cz, p.x - cx), r: Math.hypot(p.x - cx, p.z - cz) })).sort((u, v) => u.a - v.a);
  const samples = [];
  for (let k = 0; k < 72; k += 1) {
    const a = -Math.PI + (k / 72) * Math.PI * 2;
    let lo = polar[polar.length - 1]; let hi = polar[0];
    for (let i = 0; i < polar.length; i += 1) if (polar[i].a >= a) { hi = polar[i]; lo = polar[(i - 1 + polar.length) % polar.length]; break; }
    const span = ((hi.a - lo.a) + Math.PI * 2) % (Math.PI * 2) || 1;
    const t = (((a - lo.a) + Math.PI * 2) % (Math.PI * 2)) / span;
    samples.push(lo.r + (hi.r - lo.r) * t);
  }
  const mean = samples.reduce((x, y) => x + y, 0) / samples.length;
  return samples.map((r) => r / mean - 1);
}
function correlation(a, b) {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0)); const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (na * nb || 1);
}
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

const seeds = [1485618003, ...Array.from({ length: 30 }, (_, i) => (i * 2654435761 + 12345) >>> 0 || 1)];
function inRiver(layout, p) {
  const river = layout.river;
  if (!river || river.length < 2) return false;
  let segment = 0;
  while (segment + 1 < river.length - 1 && river[segment + 1].z < p.z) segment += 1;
  const a = river[segment], b = river[segment + 1];
  const t = Math.max(0, Math.min(1, (p.z - a.z) / (b.z - a.z || 1)));
  const riverX = a.x + (b.x - a.x) * t;
  const minZ = river[0].z + 60, maxZ = river[river.length - 1].z - 60;
  const smoothAt = (x, lo, hi) => { const u = Math.max(0, Math.min(1, (x - lo) / (hi - lo || 1))); return u * u * (3 - 2 * u); };
  const halfWidth = 16 + 4 * Math.cos(p.z * 0.012) + smoothAt(p.z, minZ + (maxZ - minZ) * 0.55, maxZ) * 34;
  return Math.abs(p.x - riverX) < halfWidth;
}
const profiles = [];
const biomes = new Set();
const landmarkKinds = new Set();
let rivers = 0;
for (const seed of seeds) {
  const input = model(700);
  const layout = layoutCity(input, null, seed);
  const placed = layout.districts.reduce((sum, d) => sum + d.slots.size, 0);
  assert.equal(placed, 700, `seed ${seed}: every session gets a lot (${placed}/700)`);
  for (const site of layout.publicSites) {
    // Production's 12-unit setback is a conservative polar distance, while layout.coast is a 96-segment
    // polyline; chord error plus the conservative shrink can make the displayed Euclidean gap ~16.
    if (site.kind === "harbor") assert(coastGap(layout, site) <= 20, `seed ${seed}: harbor remains within the coastal setback (including coast approximation)`);
    else assert(layout.terrain.buildable(site.x, site.z) || layout.terrain.height(site.x, site.z) > 0.5, `seed ${seed}: ${site.id} on land`);
  }
  for (const bridge of layout.bridges) {
    const same = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) <= 0.02;
    const edge = layout.roadEdges.find((road) => road.bridge &&
      ((same(road.points[0], bridge.from) && same(road.points[road.points.length - 1], bridge.to)) ||
       (same(road.points[0], bridge.to) && same(road.points[road.points.length - 1], bridge.from))));
    assert(edge, `seed ${seed}: bridge registry entry has no deck edge`);
    const dx = bridge.to.x - bridge.from.x, dz = bridge.to.z - bridge.from.z;
    const length = Math.hypot(dx, dz); const nx = -dz / (length || 1), nz = dx / (length || 1);
    const steps = Math.max(2, Math.ceil(length / 3));
    let crossesWater = false;
    for (let i = 1; i < steps && !crossesWater; i += 1) for (const lateral of [-0.5, 0, 0.5]) {
      const x = bridge.from.x + dx * i / steps + nx * edge.width * lateral;
      const z = bridge.from.z + dz * i / steps + nz * edge.width * lateral;
      if (layout.terrain.height(x, z) < 0.5 || inRiver(layout, { x, z })) { crossesWater = true; break; }
    }
    assert(crossesWater, `seed ${seed}: bridge road envelope does not span ocean or river water`);
  }
  // 小区连片且彼此分开：曾按固定锚点就近落楼，两个城区挤成一团、标签重叠（seed 42）。
  const centers = layout.districts.filter((d) => d.slots.size).map((d) => {
    const pts = [...d.slots.values()];
    return { id: d.id, x: pts.reduce((a, p) => a + p.x, 0) / pts.length, z: pts.reduce((a, p) => a + p.z, 0) / pts.length };
  });
  for (let i = 0; i < centers.length; i += 1) for (let j = i + 1; j < centers.length; j += 1) {
    const gap = Math.hypot(centers[i].x - centers[j].x, centers[i].z - centers[j].z);
    // 100：曾挤成一团的种子（seed 42）两城区质心只隔几十单位；正常种子在 110–400 之间，120 的阈值贴着边、一次选址微调就会误报。
    assert(gap >= 100, `seed ${seed}: districts ${centers[i].id} and ${centers[j].id} crowd together (${gap.toFixed(2)} apart)`);
  }
  // 致敬型地标：每岛 2–4 座（含可能的悬索桥），在陆地上，不压任何会话地块。
  // 地标数随档位增长（1 档 4 座、最多 7 座）+ 有河桥时的悬索桥；同类不重复，双子塔与扭转塔二选一。
  assert(layout.landmarks.length >= 2 && layout.landmarks.length <= 8, `seed ${seed}: ${layout.landmarks.length} landmarks`);
  const kinds = layout.landmarks.map((landmark) => landmark.kind);
  assert(new Set(kinds).size === kinds.length, `seed ${seed}: duplicate landmark kind`);
  assert(!(kinds.includes("twin-towers") && kinds.includes("twist-tower")), `seed ${seed}: both skyline towers`);
  const lots = layout.districts.flatMap((d) => [...d.slots.values()]);
  // The elevated ring lives outside roadEdges: ground-road guards cannot protect it.
  for (const lot of lots) for (const run of layout.highways) for (let i = 1; i < run.length; i += 1) {
    const a = run[i - 1]; const b = run[i]; const dx = b.x - a.x; const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((lot.x - a.x) * dx + (lot.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const gap = Math.hypot(lot.x - a.x - dx * t, lot.z - a.z - dz * t);
    assert(gap >= 5.25 + Math.hypot(lot.width, lot.depth) / 2 + 1, `seed ${seed}: ${lot.id} overlaps expressway`);
  }
  // 公共用地与地标（半径 > 0 的）同样不得压在环线高架的路幅上：它们先于环线选址，曾只有地块被守住。
  for (const site of [...layout.publicSites, ...layout.landmarks.filter((l) => l.radius > 0)]) for (const run of layout.highways) for (let i = 1; i < run.length; i += 1) {
    const a = run[i - 1]; const b = run[i]; const dx = b.x - a.x; const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((site.x - a.x) * dx + (site.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const gap = Math.hypot(site.x - a.x - dx * t, site.z - a.z - dz * t);
    assert(gap >= 5.25 + site.radius + 1, `seed ${seed}: ${site.id} overlaps expressway (gap ${gap.toFixed(1)})`);
  }
  for (const landmark of layout.landmarks) {
    landmarkKinds.add(landmark.kind);
    if (landmark.kind === "suspension-bridge") continue;
    // 海上岛地标（歌剧院）：岛心在水里、堤道岸点在实地上；其余必须立在陆地上。
    if (landmark.shore) assert(layout.terrain.height(landmark.shore.x, landmark.shore.z) > 0.2 && layout.terrain.height(landmark.x, landmark.z) < -0.8, `seed ${seed}: ${landmark.id} island/causeway placement`);
    else assert(layout.terrain.height(landmark.x, landmark.z) > 0.5, `seed ${seed}: ${landmark.id} on land`);
    for (const lot of lots) assert(Math.hypot(lot.x - landmark.x, lot.z - landmark.z) >= landmark.radius, `seed ${seed}: ${landmark.id} sits on session lot ${lot.id}`);
  }
  profiles.push(profile(layout.coast));
  biomes.add(layout.biome);
  if (layout.river.length) rivers += 1;
}
const pairs = [];
for (let i = 0; i < profiles.length; i += 1) for (let j = i + 1; j < profiles.length; j += 1) pairs.push(correlation(profiles[i], profiles[j]));
pairs.sort((x, y) => x - y);
const median = pairs[Math.floor(pairs.length / 2)];
assert(median < 0.6, `island shapes too similar across seeds (median correlation ${median.toFixed(2)})`);
assert(landmarkKinds.size >= 7, `landmark variety too low: ${[...landmarkKinds].join(",")}`);
assert(biomes.size >= 4, `seeds should reach most biomes (got ${[...biomes].join(",")})`);
assert(rivers >= 18 && rivers < 30, `about four in five islands have a river (got ${rivers}/30)`);
console.log(`City geography: ${seeds.length} seeds, all placed, expressway clearance, sites on land, bridges over water; shape correlation median ${median.toFixed(2)}, ${biomes.size} biomes, ${rivers}/${seeds.length} rivers, ${landmarkKinds.size} landmark kinds passed.`);
