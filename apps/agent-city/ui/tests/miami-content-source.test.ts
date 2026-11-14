import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateCityWorldProfile } from "@agent-vitals/city-sdk";
import { CITY_GENERATOR_VERSION } from "../src/engine/generatorVersion.ts";
import { MIAMI_CITY_WORLD_V1, parseCityWorldProfileJson } from "../src/engine/cityWorldProfile.ts";

// 迁移规范 §7.2 第 2 步：worlds/miami 是官方世界的并行内容源码，运行时权威仍是应用内
// 常量。这里钉住「文件 == 应用权威」「SDK 内容契约接受」「内置 ID 不被自定义导入覆盖」
// 「生成器版本基线」；任何一侧单独漂移都在这里失败，而不是等到真机升级才暴露。
const worldJsonUrl = new URL("../../worlds/miami/world/world.json", import.meta.url);

test("official Miami content source stays identical to the in-code world authority", async () => {
  const raw = await readFile(worldJsonUrl, "utf8");
  assert.deepEqual(JSON.parse(raw), MIAMI_CITY_WORLD_V1);
});

test("official Miami content source passes the SDK content contract", async () => {
  const raw = await readFile(worldJsonUrl, "utf8");
  const validated = validateCityWorldProfile(JSON.parse(raw));
  assert.equal(validated.ok, true, JSON.stringify(validated.diagnostics));
});

test("official identity stays reserved against the custom-world import path", async () => {
  // 内置世界 ID 不能经自定义导入覆盖：官方内容走内置权威，自定义世界必须换 ID。
  const raw = await readFile(worldJsonUrl, "utf8");
  const imported = parseCityWorldProfileJson(raw);
  assert.equal(imported.ok, false);
  if (!imported.ok) assert.equal(imported.diagnostics[0]?.code, "world_profile_reserved_id");
});

test("migration baseline pins the generator version recorded in design/migration-baseline.md", () => {
  // 生成器有意变更（递增 CITY_GENERATOR_VERSION）时，必须重新核对 worlds/miami 并更新基线。
  assert.equal(CITY_GENERATOR_VERSION, 6);
});
