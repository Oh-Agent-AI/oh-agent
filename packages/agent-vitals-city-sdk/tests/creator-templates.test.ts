import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { validateMiniGamePack } from "../src/content";
import { CREATOR_CAPABILITIES_V1, CREATOR_OPERATIONS_V1, CREATOR_WORLDS_V1 } from "../src/creatorCapabilities";
import { CREATOR_TEMPLATES_V1 } from "../src/creatorTemplates";
import { CREATOR_CODE_TEMPLATES_V1 } from "../src/creatorCodeTemplates.generated";
import { CREATOR_VEHICLE_CATALOG_V1 } from "../src/vehicleProfile";

/**
 * Creator descriptor/template source-of-truth guards (design doc
 * docs/AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION_2026_11_12.md §5.1/§7 P1 去硬编码).
 *
 * These constants are the single human-maintained entry point: build tooling
 * (scripts/generate-creator-capabilities.mjs) renders them to assets/creator/*,
 * which Rust include_str! consumes. These tests pin the contract the generated
 * assets and the Rust side rely on; drift here breaks generation, not runtime.
 */

const assetsDir = fileURLToPath(new URL("../../../assets/creator", import.meta.url));
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
};

test("descriptor: schema/operation kinds stay within the protocol envelope", () => {
  assert.equal(CREATOR_CAPABILITIES_V1.schemaVersion, 1);
  assert.equal(typeof CREATOR_CAPABILITIES_V1.capabilityVersion, "string");
  assert.ok(CREATOR_CAPABILITIES_V1.capabilityVersion.length > 0);
  // E5 无头语义闸标注（生成链单一来源）：能力发现不得虚报，两条语义路径与
  // 覆盖面/排除面必须同时声明（Rust 侧守卫测试把它与实际嵌入能力锁步）。
  assert.equal(CREATOR_CAPABILITIES_V1.semanticGate.schemaVersion, 1);
  assert.equal(CREATOR_CAPABILITIES_V1.semanticGate.studioEnvelope, true);
  assert.equal(CREATOR_CAPABILITIES_V1.semanticGate.embeddedSdk, true);
  assert.ok(CREATOR_CAPABILITIES_V1.semanticGate.embeddedSdkCoverage.includes("vehicle.define"));
  assert.ok(CREATOR_CAPABILITIES_V1.semanticGate.requiresStudio.includes("scene.preview"));
  const allowedKinds = new Set(["upsert", "remove", "bind", "set"]);
  const allowedTargets = new Set(["scene.objects", "mounts", "skinId", "cityPatch"]);
  for (const operation of CREATOR_OPERATIONS_V1) {
    assert.ok(allowedKinds.has(operation.kind), `${operation.id}: kind ${operation.kind} not allowed`);
    assert.ok(allowedTargets.has(operation.target), `${operation.id}: target ${operation.target} not allowed`);
    // Collection-target removes address one entry by primary key; singleton
    // targets (cityPatch, skinId) replace/clear the whole value and need no idField.
    const singletonTargets = new Set(["cityPatch", "skinId"]);
    if (operation.kind === "remove" && !singletonTargets.has(operation.target)) {
      assert.ok(operation.idField, `${operation.id}: collection remove needs idField`);
    }
  }
});

test("templates: every pack passes validateMiniGamePack and template ids are unique", () => {
  const seen = new Set<string>();
  for (const template of CREATOR_TEMPLATES_V1) {
    assert.ok(!seen.has(template.id), `duplicate template id ${template.id}`);
    seen.add(template.id);
    const verdict = validateMiniGamePack(template.pack);
    assert.deepEqual(verdict.diagnostics, [], `${template.id}: pack must validate cleanly`);
    assert.ok(template.label.length > 0, `${template.id}: label required (project title source)`);
  }
  assert.deepEqual(seen, new Set(CREATOR_CAPABILITIES_V1.content.templates), "descriptor content.templates must list every template");
});

test("skins: descriptor content lists at least one skin (default-skin source)", () => {
  assert.ok(CREATOR_CAPABILITIES_V1.content.skins.length >= 1, "need at least one skin for project defaults");
  assert.ok(new Set(CREATOR_CAPABILITIES_V1.content.skins).size === CREATOR_CAPABILITIES_V1.content.skins.length, "skin ids must be unique");
});

test("generated assets on disk match the SDK constants (generator must have run)", () => {
  const capabilities = JSON.parse(fs.readFileSync(`${assetsDir}/capabilities.json`, "utf8")) as Record<string, unknown>;
  assert.deepEqual(capabilities, JSON.parse(JSON.stringify(canonical(CREATOR_CAPABILITIES_V1))), "capabilities.json drifted from CREATOR_CAPABILITIES_V1");
  for (const template of CREATOR_TEMPLATES_V1) {
    const rendered = JSON.parse(fs.readFileSync(`${assetsDir}/templates/${template.id}.json`, "utf8")) as Record<string, unknown>;
    assert.deepEqual(rendered, JSON.parse(JSON.stringify(canonical({
      schemaVersion: 1, templateId: template.id, label: template.label, gameType: template.gameType, pack: template.pack
    }))), `templates/${template.id}.json drifted from CREATOR_TEMPLATES_V1`);
  }
  const worlds = JSON.parse(fs.readFileSync(`${assetsDir}/worlds.json`, "utf8")) as Record<string, unknown>;
  assert.deepEqual(worlds, JSON.parse(JSON.stringify(canonical(CREATOR_WORLDS_V1))), "worlds.json drifted from CREATOR_WORLDS_V1");
  // 车辆目录（2026-11-15 泛化切片）：生成产物与 SDK 常量逐字段同源。
  const vehicles = JSON.parse(fs.readFileSync(`${assetsDir}/vehicles.json`, "utf8")) as Record<string, unknown>;
  assert.deepEqual(vehicles, JSON.parse(JSON.stringify(canonical(CREATOR_VEHICLE_CATALOG_V1))), "vehicles.json drifted from CREATOR_VEHICLE_CATALOG_V1");
});

// PR12 统一创作模板目录：Code Game 模板目录（games/<id>/template.json 碎片 +
// 生成索引）的锁步守卫。索引是 Rust/MCP 的 allow list 数据源，形状/来源/兼容性
// 漂移必须在这里显式失败。
test("code templates: JSON index and TS face stay in lockstep with the games/ sources", () => {
  const index = JSON.parse(fs.readFileSync(`${assetsDir}/code-templates-index.json`, "utf8")) as Record<string, unknown>;
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.templates, JSON.parse(JSON.stringify(canonical(CREATOR_CODE_TEMPLATES_V1))), "code-templates-index.json drifted from CREATOR_CODE_TEMPLATES_V1");
  assert.ok(CREATOR_CODE_TEMPLATES_V1.length >= 1, "code template catalog must not be empty");
  const gamesDir = fileURLToPath(new URL("../../../games", import.meta.url));
  let previous = "";
  for (const template of CREATOR_CODE_TEMPLATES_V1) {
    assert.ok(template.templateId > previous, `entries must be sorted by templateId (${previous} < ${template.templateId})`);
    previous = template.templateId;
    assert.equal(template.runtime, "code");
    assert.equal(template.source.entry, `games/${template.templateId}`, "source.entry must be the template's own relative path (fixed join, no escape)");
    assert.ok(template.source.entry.startsWith("games/") && !template.source.entry.includes(".."), "source.entry must never escape games/");
    assert.match(template.source.digest, /^sha256:[0-9a-f]{64}$/, "source.digest recipe: sha256:<64 lower-case hex>");
    assert.ok(template.compatibility.requiredCapabilities.length >= 1, "compatibility must declare required world capabilities");
    assert.ok(template.tests.length >= 1, "catalog entry must reference the template's test file");
    // 碎片与仓库模板目录同源（生成器已核对；这里防索引↔目录漂移）。
    const manifest = JSON.parse(fs.readFileSync(`${gamesDir}/${template.templateId}/game.manifest.json`, "utf8")) as { kind: string; displayName: string; version: string; world: { requiredCapabilities: string[] } };
    assert.equal(manifest.kind, "code-game");
    assert.equal(template.name, manifest.displayName, "catalog name must equal the manifest displayName");
    assert.equal(template.version, manifest.version, "catalog version must equal the manifest version");
    assert.deepEqual([...template.compatibility.requiredCapabilities], manifest.world.requiredCapabilities, "requiredCapabilities must come from the manifest world block");
    const fragment = JSON.parse(fs.readFileSync(`${gamesDir}/${template.templateId}/template.json`, "utf8")) as Record<string, unknown>;
    assert.equal(fragment.templateId, template.templateId);
    assert.equal(fragment.license, template.license);
    assert.deepEqual([...template.tags], fragment.tags);
  }
});
