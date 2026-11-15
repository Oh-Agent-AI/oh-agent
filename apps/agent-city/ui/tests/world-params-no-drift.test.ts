import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildGeographyWithGenerator, validateGeographyBuildOptions } from "../src/engine/planner/geography.ts";
import { ARID_DUNES_WORLD_V2 } from "../../../../packages/agent-vitals-city-sdk/src/worldParameters.ts";

// 无漂移锁步（CITY_WORLD_DIVERSIFICATION_SDK_SPEC S1）：世界参数契约落地后，
// 「省略 diversity」与「v2 全默认」必须与既有沙漠世界逐位一致。这里的黄金哈希
// 同时钉住默认行为——任何改变默认输出的提交都必须有意识地更新基线并递增
// CITY_GENERATOR_VERSION，而不是悄悄改变用户已保存的城市。
const V1 = { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 };

function sampledHash(seed: number, options: Record<string, unknown>): string {
  const geo = buildGeographyWithGenerator("arid-dunes-v1", { seed, radius: 1000, options: validateGeographyBuildOptions("arid-dunes-v1", options) });
  const values: number[] = [];
  for (let i = 0; i <= 20; i += 1) {
    for (let j = 0; j <= 20; j += 1) {
      const x = -1200 + i * 120, z = -1200 + j * 120;
      values.push(geo.landform.signedLandDistance(x, z), geo.height(x, z));
    }
  }
  return createHash("sha256").update(values.join(",")).digest("hex");
}

const GOLDEN: Record<number, string> = {
  // 黄金值取自契约落地前的生成器（dev@da2643a1）：新旧实现对同一 seed 的采样哈希逐位一致。
  1: "65d1f3c5212c5cd01349bf00c9b10e404e2bc123887ec15bdff3c961d8138ddd",
  42: "3b4c0911db6c440fb67c8adfd9eb6d881821d36172d7cd16dd4ac80adf9ef0c9",
  74031: "a784d7bc473566e88e0411fcf3010cecc558f9526dc797f0ce6fed53ed7a7fcd",
};

test("catalog default coastFractal equals the shipped boundary wobble", () => {
  const descriptor = ARID_DUNES_WORLD_V2.parameters.find(item => `${item.group}.${item.id}` === "shape.coastFractal");
  assert.equal(descriptor?.default, 0.035);
});

test("explicit v1 options and empty diversity normalize to identical geography", () => {
  for (const seed of [1, 42, 74031, 657066710]) {
    assert.equal(sampledHash(seed, V1), sampledHash(seed, { ...V1, "shape.coastFractal": 0.035 }), `seed ${seed}`);
  }
});

test("defaults do not drift the shipped desert worlds (golden hashes)", () => {
  for (const [seed, golden] of Object.entries(GOLDEN)) {
    if (!golden) continue;
    assert.equal(sampledHash(Number(seed), V1), golden, `seed ${seed}`);
  }
});

test("coastFractal is consumed end to end", () => {
  const baseline = sampledHash(42, V1);
  assert.notEqual(sampledHash(42, { ...V1, "shape.coastFractal": 0.25 }), baseline);
  assert.notEqual(sampledHash(42, { ...V1, "shape.coastFractal": 0.0 }), baseline);
});

test("unimplemented diversity values fail closed instead of being ignored", () => {
  // S2 解锁了 shape.*；本断言改用仍未实现的字段。逐字段实现后同步更新（S2b：water/landscape）。
  assert.throws(() => validateGeographyBuildOptions("arid-dunes-v1", { ...V1, "water.oasisCount": 1 }), /city-world-options-invalid/);
  assert.throws(() => validateGeographyBuildOptions("arid-dunes-v1", { ...V1, "landform.duneFrequency": 1.5 }), /city-world-options-invalid/);
  assert.throws(() => validateGeographyBuildOptions("arid-dunes-v1", { ...V1, "shape.unknown": 1 }), /city-world-options-invalid/);
  // 显式设置默认值与省略等价：不算未实现消费。
  assert.doesNotThrow(() => validateGeographyBuildOptions("arid-dunes-v1", { ...V1, "water.oasisCount": 0 }));
  assert.doesNotThrow(() => validateGeographyBuildOptions("arid-dunes-v1", { ...V1, "shape.family": "lobed" }));
});
