import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildGeographyWithGenerator, validateGeographyBuildOptions } from "../src/engine/planner/geography.ts";
import { createCityShape } from "../src/engine/cityPlan.ts";
import { ARID_DUNES_CITY_WORLD_V1, cityWorldBuildConfig, type AridDunesCityWorldProfileV1 } from "../src/engine/cityWorldProfile.ts";
import { executePlanningWorkerJob } from "../src/engine/planningWorker/planningWorkerJob.ts";
import { hydratePlanningPlan, PLANNING_PROTOCOL_VERSION, type PlanningParameters } from "../src/engine/planningWorker/planningProtocol.ts";
import { PLANNING_WORK_UNITS } from "../src/engine/planner/operationBudget.ts";

// S2b 界内地貌（CITY_WORLD_DIVERSIFICATION_SDK_SPEC §2.1）：岩台/干河/绿洲/湖泊与
// 沙丘场细化。默认零漂移由 world-params-no-drift 的黄金哈希锁定；本文件验证每个
// 地貌特征的确定性、显式默认与省略等价、以及对 height/buildable/waterClearance
// 的影响方向。风格参考 tests/world-shape-field.test.ts。
const V1 = { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 };

const build = (seed: number, diversity: Record<string, unknown>) =>
  buildGeographyWithGenerator("arid-dunes-v1", { seed, radius: 1000, options: validateGeographyBuildOptions("arid-dunes-v1", { ...V1, ...diversity }) });

const hash = (seed: number, diversity: Record<string, unknown>) => {
  const geo = build(seed, diversity);
  const values: number[] = [];
  for (let i = 0; i <= 12; i += 1) {
    for (let j = 0; j <= 12; j += 1) {
      const x = -1200 + i * 200, z = -1200 + j * 200;
      values.push(geo.landform.signedLandDistance(x, z), geo.height(x, z), geo.landform.waterClearance(x, z), geo.buildable(x, z) ? 1 : 0);
    }
  }
  return createHash("sha256").update(values.join(",")).digest("hex");
};

test("rock outcrops raise terrain, keep the boundary, and are deterministic", () => {
  const diversity = { "landscape.rockOutcropDensity": 1 };
  assert.equal(hash(42, diversity), hash(42, diversity));
  assert.notEqual(hash(42, diversity), hash(42, {}));
  assert.notEqual(hash(42, diversity), hash(74031, diversity));
  // 密度 0 的显式默认与省略逐位等价。
  assert.equal(hash(42, { "landscape.rockOutcropDensity": 0 }), hash(42, {}));

  const base = build(42, {});
  const rocky = build(42, diversity);
  // 岩台只改地形高度与可建掩码，不动占地边界（signedLandDistance 逐位一致）。
  // 20 m 网格保证每座岩台的平顶（半径 ≥ 0.55·30 = 16.5 > 14.14 网格上界）至少被
  // 一个采样点完整命中：满幅抬升 ≥ 台高下限 7。
  let maxLift = 0;
  let raised = 0;
  let lostBuildable = 0;
  for (let i = 0; i < 81; i += 1) {
    for (let j = 0; j < 81; j += 1) {
      const x = -800 + i * 20, z = -800 + j * 20;
      assert.equal(rocky.landform.signedLandDistance(x, z), base.landform.signedLandDistance(x, z));
      const lift = rocky.height(x, z) - base.height(x, z);
      if (lift > maxLift) maxLift = lift;
      if (lift >= 7) raised += 1;
      if (base.buildable(x, z) && !rocky.buildable(x, z)) lostBuildable += 1;
    }
  }
  assert.ok(maxLift >= 7, `max rock lift ${maxLift.toFixed(2)}`);
  assert.ok(raised >= 4, `full-lift samples ${raised}`);
  // 影响方向：台顶（裸岩）把原本可建的地块变成不可建。
  assert.ok(lostBuildable >= 1, `buildable cells lost to rock ${lostBuildable}`);
  // 岩台不产生水体语义。
  assert.equal(rocky.landform.waterBodies.length, 0);
  assert.equal(rocky.landform.waterClearance(0, 0), Infinity);
});

test("the wadi fills the legacy river interfaces and carves a dry channel", () => {
  const diversity = { "landscape.riverMeander": 0.6, "landscape.riverWidthM": 40 };
  assert.equal(hash(42, diversity), hash(42, diversity));
  assert.notEqual(hash(42, diversity), hash(42, {}));

  const base = build(42, {});
  const wadi = build(42, diversity);
  // 占位接口被真实填充：hasRiver/river 多边形/河宽/跨水口径全部成立。
  assert.equal(wadi.hasRiver, true);
  assert.equal(wadi.features.river, true);
  assert.equal(wadi.terrain.hasRiver, true);
  assert.equal(wadi.river.length, 121);
  assert.equal(wadi.maxWaterSpan, 140);
  assert.equal(base.hasRiver, false);
  assert.equal(base.maxWaterSpan, 0);
  // 干河不是水体：不进 waterBodies，waterClearance 保持无穷（无水面语义）。
  assert.equal(wadi.landform.waterBodies.length, 0);
  assert.equal(wadi.landform.waterClearance(0, 0), Infinity);

  let channelSamples = 0;
  let carved = 0;
  let bankLoss = 0;
  for (let i = 0; i <= 40; i += 1) {
    const z = -900 + i * 45;
    const cx = wadi.riverX(z);
    if (wadi.coastDistance(cx, z) > 24) {
      // 河道中心：不可建，且高度被切割。
      assert.equal(wadi.buildable(cx, z), false, `channel center at z=${z}`);
      channelSamples += 1;
      if (wadi.height(cx, z) < base.height(cx, z)) carved += 1;
    }
    for (const side of [-1, 1]) {
      // 河道 + 12 m 退界从可建集里消失（距中线半宽 + 6 < 12 的岸带）。
      const bx = cx + side * (wadi.riverWidth(z) + 6);
      if (wadi.coastDistance(bx, z) > 24 && base.buildable(bx, z) && !wadi.buildable(bx, z)) bankLoss += 1;
    }
    // 干河不改变城市体量边界。
    assert.equal(wadi.landform.signedLandDistance(cx, z), base.landform.signedLandDistance(cx, z));
  }
  assert.ok(channelSamples >= 20, `channel samples ${channelSamples}`);
  assert.ok(carved >= 20, `carved samples ${carved}`);
  assert.ok(bankLoss >= 1, `bank cells lost ${bankLoss}`);

  // 显式默认 = 省略：激活旋钮是 riverMeander > 0，宽度或 meander=0 都不激活。
  assert.equal(hash(42, { "landscape.riverMeander": 0 }), hash(42, {}));
  assert.equal(hash(42, { "landscape.riverWidthM": 40 }), hash(42, {}));
  assert.equal(hash(42, { "landscape.riverMeander": 0, "landscape.riverWidthM": 40 }), hash(42, {}));
  // 蜿蜒强度真实生效：0.1 与 0.9 的河道几何不同。
  assert.notEqual(hash(42, { "landscape.riverMeander": 0.1, "landscape.riverWidthM": 40 }),
    hash(42, { "landscape.riverMeander": 0.9, "landscape.riverWidthM": 40 }));
});

test("lakes and oases are real water bodies with negative clearance and unbuildable centers", () => {
  const diversity = { "water.lakeCount": 2, "water.lakeSizeM": 160, "water.oasisCount": 1 };
  assert.equal(hash(42, diversity), hash(42, diversity));
  assert.notEqual(hash(42, diversity), hash(42, {}));
  assert.notEqual(hash(42, diversity), hash(74031, diversity));

  const base = build(42, {});
  const wet = build(42, diversity);
  const bodies = wet.landform.waterBodies;
  assert.equal(bodies.length, 3);
  assert.equal(bodies.filter((body) => body.kind === "lake").length, 2);
  assert.equal(bodies.filter((body) => body.kind === "oasis").length, 1);
  assert.equal(wet.maxWaterSpan, 140);

  let farClearance = -Infinity;
  for (const body of bodies) {
    const [ring] = body.shorelines;
    assert.ok(ring.length >= 32, `shoreline points ${ring.length}`);
    // 岸线与 waterClearance 同一口径（dNorm = 1 等值线）。
    for (const point of ring) assert.ok(Math.abs(wet.landform.waterClearance(point.x, point.z)) < 1e-6);
    // 均匀参数化的椭圆环均值 = 椭圆中心。
    const cx = ring.reduce((sum, p) => sum + p.x, 0) / ring.length;
    const cz = ring.reduce((sum, p) => sum + p.z, 0) / ring.length;
    // 湖心：水净空为负、不可建、地形开挖到水面以下；水面低于四周既有地面。
    assert.ok(wet.landform.waterClearance(cx, cz) < 0, `center clearance ${wet.landform.waterClearance(cx, cz)}`);
    assert.equal(wet.buildable(cx, cz), false, "water center must not be buildable");
    assert.ok(wet.height(cx, cz) < body.surfaceElevation, "bowl floor below water surface");
    assert.ok(body.surfaceElevation < base.height(cx, cz), "water surface below surrounding ground");
    assert.ok(wet.height(cx, cz) < base.height(cx, cz), "center carved relative to base");
  }
  for (let i = 0; i <= 12; i += 1) {
    for (let j = 0; j <= 12; j += 1) {
      const x = -1200 + i * 200, z = -1200 + j * 200;
      const clearance = wet.landform.waterClearance(x, z);
      if (Number.isFinite(clearance)) {
        // 水里的格点一律不可建；岸外净空为正。
        if (clearance < 0) assert.equal(wet.buildable(x, z), false, `in-water cell ${x}:${z}`);
        else assert.ok(clearance > 0);
      }
      if (clearance > farClearance) farClearance = clearance;
    }
  }
  assert.ok(farClearance > 150, `max land clearance ${farClearance}`);
  // 显式默认 = 省略。
  assert.equal(hash(42, { "water.oasisCount": 0 }), hash(42, {}));
  assert.equal(hash(42, { "water.lakeCount": 0, "water.lakeSizeM": 400 }), hash(42, {}));
  assert.equal(hash(42, { "water.lakeSizeM": 400 }), hash(42, {}));
  // 数量真实生效：0 → 无水体；3 → waterBodies 增多。
  assert.equal(build(42, { "water.lakeCount": 3, "water.lakeSizeM": 120 }).landform.waterBodies.length, 3);
});

test("dune field refinement scales frequency and adds secondary ridges deterministically", () => {
  // 显式默认与省略逐位等价（frequency 1、ridge 0 都是既有波形）。
  assert.equal(hash(42, { "landform.duneFrequency": 1 }), hash(42, {}));
  assert.equal(hash(42, { "landform.ridgeSecondary": 0 }), hash(42, {}));
  // 非默认值改变高度场且确定；占地边界场不受沙丘细化影响。
  for (const diversity of [
    { "landform.duneFrequency": 2 },
    { "landform.duneFrequency": 0.5 },
    { "landform.ridgeSecondary": 1 },
    { "landform.ridgeSecondary": 0.4 },
  ]) {
    assert.equal(hash(42, diversity), hash(42, diversity), JSON.stringify(diversity));
    assert.notEqual(hash(42, diversity), hash(42, {}), JSON.stringify(diversity));
  }
  assert.notEqual(hash(42, { "landform.duneFrequency": 2 }), hash(42, { "landform.duneFrequency": 0.5 }));
  assert.notEqual(hash(42, { "landform.ridgeSecondary": 1 }), hash(42, { "landform.ridgeSecondary": 0.4 }));
  const refined = build(42, { "landform.duneFrequency": 2 });
  const baseline = build(42, {});
  for (let i = 0; i <= 12; i += 1) {
    for (let j = 0; j <= 12; j += 1) {
      const x = -1200 + i * 200, z = -1200 + j * 200;
      assert.equal(refined.landform.signedLandDistance(x, z), baseline.landform.signedLandDistance(x, z));
    }
  }
});

test("combined landforms compose deterministically and stay seed-keyed", () => {
  const all = {
    "landscape.rockOutcropDensity": 0.6, "landscape.riverMeander": 0.5, "landscape.riverWidthM": 30,
    "water.lakeCount": 2, "water.lakeSizeM": 120, "water.oasisCount": 2,
    "landform.duneFrequency": 1.3, "landform.ridgeSecondary": 0.4,
  };
  assert.equal(hash(42, all), hash(42, all));
  assert.notEqual(hash(42, all), hash(42, {}));
  assert.notEqual(hash(42, all), hash(74031, all));
  const geo = build(42, all);
  assert.equal(geo.hasRiver, true);
  assert.equal(geo.landform.waterBodies.length, 4);
  assert.equal(geo.maxWaterSpan, 140);
});

test("a landform world survives the full planning worker", () => {
  // 集成冒烟：地貌全开的世界走完整规划（骨架/桥/街区/地块），不因界内水体或
  // 干河把规划打成 failed。断言只钉「可计算且容量成立」，布局质量由既有
  // planner 契约测试守卫。
  // 种子说明：缺省沙漠世界对部分种子本就产出 failed（endpoint 续接需求未满足，
  // 如 seed 1/657066710/8675309——既有退化包络，与本切片无关）。这里选地貌全开
  // 仍可计算的种子 74031，钉住「界内地貌不新增系统性规划失败」。
  const landformProfile = {
    ...ARID_DUNES_CITY_WORLD_V1,
    geography: {
      generator: "arid-dunes-v1" as const,
      parameters: {
        dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 },
        diversity: {
          "landscape.rockOutcropDensity": 0.6, "landscape.riverMeander": 0.5, "landscape.riverWidthM": 30,
          "water.lakeCount": 2, "water.lakeSizeM": 120, "water.oasisCount": 2,
          "landform.duneFrequency": 1.3, "landform.ridgeSecondary": 0.4,
        },
      },
    },
  } as AridDunesCityWorldProfileV1;
  const seed = 74031;
  const config = cityWorldBuildConfig(landformProfile, createCityShape(seed));
  assert.equal(config.geographyGenerator, "arid-dunes-v1");
  const parameters = { seed, tier: 1, coastal: null, biome: config.biome, geographyGenerator: config.geographyGenerator,
    geographyOptions: config.geographyOptions, limits: Object.fromEntries(PLANNING_WORK_UNITS.map(unit => [unit, Number.MAX_SAFE_INTEGER])) } as PlanningParameters;
  const result = executePlanningWorkerJob({ version: PLANNING_PROTOCOL_VERSION, requestId: "world-landforms-test", parameters });
  assert.equal(result.status, "computed");
  if (result.status !== "computed") return;
  const plan = hydratePlanningPlan(result.snapshot, parameters);
  assert.notEqual(plan.planningOutcome.status, "failed");
  assert.ok(plan.capacity.satisfied);
});
