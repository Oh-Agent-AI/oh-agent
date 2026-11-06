#!/usr/bin/env node
// 海滨带契约守卫（CITY_VICE_THEME_TECHNICAL_DESIGN §1/T0）：确定性、朝向、
// 偏移顺序、陆海边界、保留带排他、港口避让、编码预算与降级路径。
// 消费 createCityPlan(seed, tier, config?) 的 seaside 输出与 citySeaside 纯函数。
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { cachedPlan, loadCity } from "./city-kit/index.mjs";

// 原生加载 + 进程内缓存（CITY_ARCHITECTURE 迁移步 1）。确定性断言（同 seed 两次生成相等）直接调 rawPlan，不走缓存。
const { createCityPlan: rawPlan, layoutCity, polygonDistance, MIAMI_COASTAL, seasideStripContains, promenadeSegments, boulevardSegments, seasideHotelCount, encodeDistance, decodeDistance, distanceQuantizationError } = await loadCity({
  "engine/cityPlan.ts": ["createCityPlan", "polygonDistance"],
  "engine/cityLayout.ts": ["layoutCity"],
  "engine/citySeaside.ts": ["MIAMI_COASTAL", "seasideStripContains", "promenadeSegments", "boulevardSegments", "seasideHotelCount", "encodeDistance", "decodeDistance", "distanceQuantizationError"],
});
const createCityPlan = (seed, tier, config) => {
  const trace = tier === 10 || process.env.CITY_VERIFY_PROGRESS === "1", began = performance.now();
  if (trace) console.error(`City seaside: start ${seed}/t${tier} profile=${config?.profile ?? "default"}`);
  const plan = cachedPlan(rawPlan, seed, tier, config);
  if (trace) console.error(`City seaside: done ${seed}/t${tier} ${Math.round(performance.now() - began)}ms`);
  return plan;
};

const normalizeAngle = (a) => { let r = a % (Math.PI * 2); if (r < 0) r += Math.PI * 2; return r; };
const angleDelta = (a, b) => { const d = Math.abs(normalizeAngle(a) - normalizeAngle(b)); return Math.min(d, Math.PI * 2 - d); };
// 档位：每档 400 栋，1 = 初始规划（默认），10 = 满档 4000 栋：CITY_SEASIDE_TIER=10 跑满档。
const TIER = Number(process.env.CITY_SEASIDE_TIER ?? 1);
const seeds = Array.from({ length: 20 }, (_, i) => (i * 2654435761 + 97) >>> 0 || 1);

assert.equal(seasideHotelCount(4), 8, "a short valid coast still gets a readable hotel row");
assert.equal(seasideHotelCount(22), 13, "the default coast uses enough Deco frontage to read as a district");
assert.equal(seasideHotelCount(80), 18, "large coast frontage remains instance-bounded");

// 1) 无配置：旧行为不变（seaside 为 null，生态带仍随机）。
{
  const biomes = new Set();
  for (const seed of seeds) {
    const plan = createCityPlan(seed, TIER);
    assert.equal(plan.seaside, null, `seed ${seed}: 无配置时 seaside 必须为 null`);
    assert.ok(plan.blocks.length > 0, `seed ${seed}: 无配置仍生成街区`);
    biomes.add(plan.biome);
  }
  assert.ok(biomes.size >= 2, `无配置时生态带应保持随机（20 种子只见 ${biomes.size} 种）`);
}

// 2) 确定性：同 seed 同 config 两次构建，seaside 逐位相等。
{
  const a = rawPlan(seeds[0], TIER, MIAMI_COASTAL).seaside;
  const b = rawPlan(seeds[0], TIER, MIAMI_COASTAL).seaside;
  assert.deepEqual(a, b, "同 seed 同配置的 seaside 必须确定性相等");
}

// 3) 有效性、偏移顺序、陆海边界（20 种子）。
{
  let validBands = 0;
  for (const seed of seeds) {
    const plan = createCityPlan(seed, TIER, MIAMI_COASTAL);
    const band = plan.seaside;
    assert.ok(plan.landmarks.some((landmark) => landmark.kind === "twin-towers" || landmark.kind === "twist-tower"),
      `seed ${seed}: Vice City silhouette must include one deterministic downtown high-rise landmark`);
    assert.ok(band, `seed ${seed}: 应产出海滨带`);
    if (!band.degraded) validBands += 1;
    for (const sample of band.samples) {
      if (!sample.valid) continue;
      const d = (p) => Math.hypot(p.x - sample.waterline.x, p.z - sample.waterline.z);
      assert.ok(d(sample.wetOuter) < d(sample.dryOuter) && d(sample.dryOuter) < d(sample.promenade)
        && d(sample.promenade) < d(sample.boulevard) && d(sample.boulevard) < d(sample.hotelLine) && d(sample.hotelLine) < d(sample.outer),
        `seed ${seed}: 空间顺序必须是海水→湿沙→干沙→棕榈步道→滨海大道→酒店→城区`);
      // 独立陆海校验：酒店线在海岸多边形内部（polygonDistance 内正外负）。
      assert.ok(polygonDistance(sample.hotelLine, plan.coast) > 0, `seed ${seed}: 酒店线必须在陆地上`);
      assert.ok(polygonDistance(sample.boulevard, plan.coast) > 0, `seed ${seed}: 滨海大道必须在陆地上`);
      assert.ok(sample.inward.x * sample.inward.x + sample.inward.z * sample.inward.z > 0.99,
        `seed ${seed}: 内向法线必须是单位向量`);
    }
    if (!band.degraded) {
      // 保留带排他：任何数据地块不得落在带内。
      const parcels = plan.blocks.flatMap((block) => block.parcels);
      for (const parcel of parcels) {
        assert.equal(seasideStripContains(band, parcel, 0), false, `seed ${seed}: 地块 ${parcel.id} 不得落在海滨保留带内`);
      }
      // 港口避让：段中心方位避开港口 ±25°（blocked 半宽 30° 留容差）。
      const harbor = plan.publicSites.find((site) => site.kind === "harbor");
      if (harbor) {
        const harborAzimuth = normalizeAngle(Math.atan2(harbor.z - plan.core.z, harbor.x - plan.core.x));
        // 跨 0° 的段（如 306° → 23°）不能直接取算术平均（得 164°）：按顺时针跨度取中点。
        const span = (band.azimuthTo - band.azimuthFrom + Math.PI * 2) % (Math.PI * 2);
        const mid = (band.azimuthFrom + span / 2) % (Math.PI * 2);
        assert.ok(angleDelta(mid, harborAzimuth) > (25 * Math.PI) / 180, `seed ${seed}: 海滨段不得压港口朝向`);
      }
      // 步道合法连续段：段内间距 ≤ 15+ε；段数 ≥ 1；不做跨缺口搭桥。
      const segments = promenadeSegments(band);
      assert.ok(segments.length >= 1, `seed ${seed}: 至少一段合法步道`);
      for (const segment of segments) {
        for (let i = 1; i < segment.length; i += 1) {
          const gap = Math.hypot(segment[i].x - segment[i - 1].x, segment[i].z - segment[i - 1].z);
          assert.ok(gap <= 17, `seed ${seed}: 段内间距 ${gap.toFixed(1)} ≤17（缺口必须切段，不搭桥）`);
        }
      }
      const boulevards = boulevardSegments(band);
      assert.ok(boulevards.length >= 1, `seed ${seed}: 至少一段合法滨海大道`);
      for (const segment of boulevards) {
        for (let i = 1; i < segment.length; i += 1) {
          const gap = Math.hypot(segment[i].x - segment[i - 1].x, segment[i].z - segment[i - 1].z);
          assert.ok(gap <= 17, `seed ${seed}: 大道连续段间距 ${gap.toFixed(1)} ≤17（无效河口/岸段必须断开）`);
          assert.ok(plan.terrain.height((segment[i].x + segment[i - 1].x) / 2, (segment[i].z + segment[i - 1].z) / 2) > 0.5,
            `seed ${seed}: 滨海大道不可穿海`);
        }
      }
      // 取「真正成路的」大道段的起点：第一个合法样本可能是只有 1 个点的孤立段，孤立段不成路、没有车流回路（设计如此）。
      const routeSegment = boulevards.find((segment) => segment.length >= 2);
      assert.ok(routeSegment, `seed ${seed}: 至少一段 ≥2 点的大道`);
      // 段首的 1–2 个点可能是端部短桩，被网络清理（端点吃水/断头清理）删掉而不在路网上（seed 97/10 档：前 2 点离最近的边 26.9，
      // 其余 109 点都在路上）；契约是「大道进入真实路网并继承主干道路幅」，所以取第一个确实落在路网上的点做代表。
      const onNetwork = (point) => plan.roadEdges.some((edge) => edge.points.some((p) => Math.hypot(p.x - point.x, p.z - point.z) < 0.01));
      const routeSample = { boulevard: routeSegment.find(onNetwork) ?? routeSegment[0] };
      assert.ok(plan.roadEdges.some((edge) => edge.width === 12 && edge.points.some((point) => Math.hypot(point.x - routeSample.boulevard.x, point.z - routeSample.boulevard.z) < 0.01)),
        `seed ${seed}: 规划的大道应进入真实车行路网并继承主干道路幅`);
      const coastalTraffic = plan.carPaths.find((path) => path.some((point) => Math.hypot(point.x - routeSample.boulevard.x, point.z - routeSample.boulevard.z) < 0.01));
      assert.ok(coastalTraffic, `seed ${seed}: 至少一条机动车回路应经过滨海大道`);
      assert.deepEqual(coastalTraffic[0], coastalTraffic.at(-1), `seed ${seed}: 滨海车流回路必须闭合，不可在端点瞬移`);
      // 车路径按折线逐段走：地面走廊重绘（relineEdges/relineSplits）会产出多点边，所以按「相邻点对」建集合，
      // 而不是把整条边所有点拼成一个键（那样多点边上的每一步都会被误判成离路）。
      const roadPairs = new Set(plan.roadEdges.flatMap((edge) => edge.points.slice(1).map((point, i) =>
        [edge.points[i], point].map((p) => `${p.x}:${p.z}`).sort().join("/"))));
      for (let i = 1; i < coastalTraffic.length; i += 1) {
        assert.ok(roadPairs.has([coastalTraffic[i - 1], coastalTraffic[i]].map((point) => `${point.x}:${point.z}`).sort().join("/")),
          `seed ${seed}: 滨海车流只能沿已渲染道路移动 (${JSON.stringify([coastalTraffic[i - 1], coastalTraffic[i]])})`);
      }
      // 全降级 → 零段。
      assert.equal(promenadeSegments({ ...band, degraded: true }).length, 0, `seed ${seed}: 降级时步道为零段`);
      assert.equal(boulevardSegments({ ...band, degraded: true }).length, 0, `seed ${seed}: 降级时大道为零段`);
    }
  }
  assert.ok(validBands >= 18, `20 种子至少 18 个非降级海滨带（实际 ${validBands}）`);
}

// 4) 降级路径：不可能的净空阈值 → degraded + reason，规划不炸、街区照常。
{
  const impossible = { ...MIAMI_COASTAL, maxCoastalHeight: -1 };
  const plan = createCityPlan(seeds[1], TIER, impossible);
  assert.ok(plan.seaside.degraded, "不可能阈值必须降级");
  assert.ok(typeof plan.seaside.reason === "string" && plan.seaside.reason.length > 0, "降级必须带原因");
  assert.ok(plan.blocks.length > 0, "降级不影响街区生成");
}

// 5) 编码预算：往返误差在量化界内；量化误差小于湿沙过渡宽度。
{
  const range = 60;
  for (const d of [-range, -range / 2, -1, 0, 1, range / 3, range]) {
    const v = encodeDistance(d, range);
    const back = decodeDistance(v, range);
    assert.ok(Math.abs(back - d) <= distanceQuantizationError(range) + 1e-9, `编码往返误差超界: ${d} → ${back}`);
  }
  assert.ok(distanceQuantizationError(range) < MIAMI_COASTAL.wetSandWidth, "量化误差必须小于湿沙过渡宽度");
}


// 6) 参数级缓存身份（审查 #5）：同 profile/version 改参数 → 不同海滨带。
{
  const modified = { ...MIAMI_COASTAL, maxCoastalHeight: -1 };
  const normal = createCityPlan(seeds[2], TIER, MIAMI_COASTAL).seaside;
  const degraded = createCityPlan(seeds[2], TIER, modified).seaside;
  assert.equal(normal.degraded, false, "标准配置应产出有效海滨带");
  assert.equal(degraded.degraded, true, "修改参数后必须独立降级（不能复用旧规划）");
  const emptyModel = { buildings: [], districts: [] };
  const cachedNormal = layoutCity(emptyModel, null, seeds[2], MIAMI_COASTAL);
  const cachedModified = layoutCity(emptyModel, null, seeds[2], modified);
  assert.equal(cachedNormal.seaside.degraded, false, "标准布局缓存应保存有效海滨带");
  assert.equal(cachedModified.seaside.degraded, true, "layoutCity 缓存键必须纳入全部配置参数");
  assert.notEqual(cachedNormal.coastalConfigKey, cachedModified.coastalConfigKey, "静态场景可用配置指纹判断失效");
}

// 7) 浏览器默认演示种子：用户截图验收时的首屏必须能规划出海滨酒店样板。
{
  const previewSeed = 523001688;
  const previewPlan = createCityPlan(previewSeed, 1, MIAMI_COASTAL);
  const validSamples = previewPlan.seaside.samples.filter((sample) => sample.valid).length;
  assert.ok(previewPlan.landmarks.some((landmark) => landmark.kind === "twin-towers" || landmark.kind === "twist-tower"),
    "browser preview must contain the Vice City skyline landmark");
  assert.ok(!previewPlan.seaside.degraded && validSamples >= 3, "browser preview must have hotel samples");
  console.log(`Browser preview seed ${previewSeed}: seaside degraded=${previewPlan.seaside.degraded}, valid samples=${validSamples}/${previewPlan.seaside.samples.length}, Deco hotels=${seasideHotelCount(validSamples)} / ${seasideHotelCount(validSamples) * 8} batched pieces, skyline=${previewPlan.landmarks.find((landmark) => landmark.kind === "twin-towers" || landmark.kind === "twist-tower")?.kind}`);
}

console.log(`City seaside: determinism, offsets, land boundary, strip exclusion, harbor avoidance, degradation, segments, param cache identity, encoding budget passed (${validCount(seeds)} seeds).`);
function validCount(s) { return s.length; }
