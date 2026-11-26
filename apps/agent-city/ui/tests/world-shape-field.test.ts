import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildGeographyWithGenerator, validateGeographyBuildOptions } from "../src/engine/planner/geography.ts";

// S2 形状场（CITY_WORLD_DIVERSIFICATION_SDK_SPEC §3）：多核心可达性足迹替换
// 硬编码圆盘。disc 默认路径保持逐位现状（无漂移由 world-params-no-drift 覆盖），
// 本文件验证非 disc 家族的确定性、家族差异与紧凑度验收带。
const V1 = { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 };

const build = (seed: number, diversity: Record<string, unknown>) =>
  buildGeographyWithGenerator("arid-dunes-v1", { seed, radius: 1000, options: validateGeographyBuildOptions("arid-dunes-v1", { ...V1, ...diversity }) });

const hash = (seed: number, diversity: Record<string, unknown>) => {
  const geo = build(seed, diversity);
  const values: number[] = [];
  for (let i = 0; i <= 12; i += 1) {
    for (let j = 0; j <= 12; j += 1) {
      const x = -1200 + i * 200, z = -1200 + j * 200;
      values.push(geo.landform.signedLandDistance(x, z), geo.height(x, z));
    }
  }
  return createHash("sha256").update(values.join(",")).digest("hex");
};

test("non-disc families change the footprint and stay deterministic", () => {
  const disc = hash(42, {});
  const lobed = hash(42, { "shape.family": "lobed", "shape.cores": 3 });
  const dumbbell = hash(42, { "shape.family": "dumbbell", "shape.cores": 2, "shape.corridorPull": 0.25 });
  const coastal = hash(42, { "shape.family": "coastal" });
  assert.notEqual(lobed, disc);
  assert.notEqual(dumbbell, disc);
  assert.notEqual(coastal, disc);
  assert.notEqual(lobed, dumbbell);
  assert.notEqual(lobed, coastal);
  // 同 seed 同参数重跑逐位一致（纯函数确定性）；跨 seed 形状必须不同（seed 键控变化）。
  assert.equal(lobed, hash(42, { "shape.family": "lobed", "shape.cores": 3 }));
  assert.notEqual(hash(42, { "shape.family": "coastal" }), hash(74031, { "shape.family": "coastal" }));
});

test("footprint compactness stays inside the acceptance band across declared ranges", () => {
  for (const family of ["lobed", "dumbbell", "coastal"] as const) {
    for (const cores of [1, 3]) {
      for (const aspectRatio of [1.0, 1.8]) {
        for (const corridorPull of [0, 0.4]) {
          const geo = build(74031, { "shape.family": family, "shape.cores": cores, "shape.aspectRatio": aspectRatio, "shape.corridorPull": corridorPull });
          const stats = geo.footprintStats;
          assert.ok(stats, `${family} missing footprint stats`);
          // 单核心无走廊各向异性时足迹本就近圆（可达性最优形），允许到 0.99；
          // 结构性各向异性组合必须落在规格验收带内。
          const structured = cores >= 2 || corridorPull > 0 || family === "coastal";
          const upper = structured ? 0.95 : 0.99;
          assert.ok(stats.polsbyPopper >= 0.25 && stats.polsbyPopper <= upper,
            `${family} cores=${cores} ar=${aspectRatio} pull=${corridorPull} PQ=${stats.polsbyPopper.toFixed(3)}`);
          // 面积归一化：换形状不改城市体量（±15%）。
          const target = Math.PI * 1000 * 1000;
          assert.ok(Math.abs(stats.areaM2 - target) / target < 0.15,
            `${family} area ${stats.areaM2.toFixed(0)} vs target ${target.toFixed(0)}`);
        }
      }
    }
  }
});

test("structured families deviate from a circle beyond boundary detail", () => {
  // 哑铃/多瓣/海岸形的 PQ 必须显著低于圆（排除「只是细节噪声」的假实现）。
  for (const diversity of [
    { "shape.family": "dumbbell", "shape.cores": 2, "shape.corridorPull": 0.3 },
    { "shape.family": "lobed", "shape.cores": 3 },
    { "shape.family": "coastal" },
  ]) {
    const stats = build(42, diversity).footprintStats!;
    assert.ok(stats.polsbyPopper < 0.96, `${JSON.stringify(diversity)} PQ=${stats.polsbyPopper.toFixed(3)}`);
  }
});

test("shape validation stays idempotent for normalized output", () => {
  const once = validateGeographyBuildOptions("arid-dunes-v1", { ...V1, "shape.family": "lobed", "shape.cores": 3, "shape.corridorPull": 0.2 });
  const twice = validateGeographyBuildOptions("arid-dunes-v1", once);
  assert.deepEqual(JSON.stringify(once), JSON.stringify(twice));
});

test("default disc path returns no footprint stats", () => {
  assert.equal(build(42, {}).footprintStats, undefined);
});
