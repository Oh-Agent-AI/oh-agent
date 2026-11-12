import test from "node:test";
import assert from "node:assert/strict";
import { buildGameValidation, buildSceneValidation } from "../src/sdkValidation";
import { CREATOR_TEMPLATES_V1 } from "../../../../packages/agent-vitals-city-sdk/src/creatorTemplates";
import { CREATOR_CAPABILITIES_V1 as CAPABILITIES } from "../../../../packages/agent-vitals-city-sdk/src/creatorCapabilities";

/**
 * Studio SDK 预校验信封的单元测试（设计 §5.2，P2 语义搬运）：
 * 信封字段必须满足 Rust 侧 creator_validation_invalid 的形状与预算
 * （capabilityVersion 与描述符一致、severity 枚举、≤200 条诊断、超限截断）。
 */

const layout = {
  schemaVersion: 1, id: "loop-layout", coordinateSystem: "city-local-m-v1",
  anchors: [
    { id: "spawn-a", kind: "spawn", capabilities: ["drive"], geometryRef: "geom-spawn-a" },
    { id: "zone-b", kind: "zone", capabilities: ["drive"], geometryRef: "geom-zone-b" },
  ],
  links: [{ id: "link-1", fromAnchorId: "spawn-a", toAnchorId: "zone-b", capabilities: ["drive"] }],
};
const project = { cityLayout: { layout }, game: CREATOR_TEMPLATES_V1[0].pack };

test("game envelope: valid pack passes with descriptor capabilityVersion", () => {
  const envelope = buildGameValidation(CREATOR_TEMPLATES_V1[0].pack);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.validatorVersion, 1);
  assert.equal(envelope.capabilityVersion, CAPABILITIES.capabilityVersion);
  assert.deepEqual(envelope.diagnostics, []);
  assert.equal(envelope.truncated, undefined);
});

test("game envelope: script/unknown op is a signed rejection", () => {
  const bad = { ...CREATOR_TEMPLATES_V1[0].pack, rules: { ...CREATOR_TEMPLATES_V1[0].pack.rules,
    nodes: [...CREATOR_TEMPLATES_V1[0].pack.rules.nodes, { id: "bad", on: { type: "run.started" }, actions: [{ op: "host.call", method: "readFile" }] }] } };
  const envelope = buildGameValidation(bad);
  assert.equal(envelope.ok, false);
  assert.ok(envelope.diagnostics.length >= 1);
  for (const item of envelope.diagnostics) {
    assert.match(item.code, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "diagnostic code must satisfy Rust valid_id");
    assert.ok(item.severity === "error" || item.severity === "warning");
    assert.ok(item.path.length > 0 && item.path.length <= 256);
    assert.ok(item.message.length <= 400);
  }
});

test("scene envelope: upsert payload validated by the same SceneDraft validator", () => {
  const good = buildSceneValidation(project, [{ op: "scene.object.upsert", object: {
    id: "crate-1", kind: "collider", shape: "box", sizeMeters: { x: 1, y: 1, z: 1 },
    transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } } }]);
  assert.equal(good.ok, true);
  const bad = buildSceneValidation(project, [{ op: "scene.object.upsert", object: {
    id: "crate-2", kind: "collider", shape: "sphere", sizeMeters: { x: 1, y: 1, z: 1 },
    transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } } }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some(item => item.severity === "error"));
});

test("scene envelope: mount.bind checks topology and unbound layout fails closed", () => {
  const mount = { schemaVersion: 1, mountId: "main-mount",
    layout: { kind: "city-layout", id: "loop-layout", version: "1", digest: "sha256:" + "a".repeat(64) },
    game: { kind: "city-minigame", id: project.game.id, version: "1", digest: "sha256:" + "b".repeat(64) },
    entryAnchorId: "spawn-a", bindings: { points: ["zone-b"] }, parameterOverrides: {} };
  const bound = buildSceneValidation(project, [{ op: "mount.bind", mount }]);
  // 结论内容（槽位基数/可达性）归 SDK 语料测试；这里只断言校验在已绑定项目上运行并产出结论。
  assert.equal(typeof bound.ok, "boolean");
  const unbound = buildSceneValidation(null, [{ op: "mount.bind", mount }]);
  assert.equal(unbound.ok, false);
  assert.ok(unbound.diagnostics.some(item => item.code === "creator_layout_not_bound"));
});

test("scene envelope: unknown skin rejected, listed skin passes; city.patch ops are out of scope", () => {
  const bad = buildSceneValidation(project, [{ op: "skin.select", skinId: "totally-unknown" }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some(item => item.code === "creator_skin_not_found"));
  const good = buildSceneValidation(project, [{ op: "skin.select", skinId: CAPABILITIES.content.skins[0] }]);
  assert.equal(good.ok, true);
  const patch = buildSceneValidation(project, [{ op: "city.patch.upsert", patch: { anything: true } }]);
  assert.equal(patch.ok, true, "city.patch semantics belong to the City engine; Studio must not reject here");
});

test("envelope budget: diagnostics truncate with truncated marker and stay within bounds", () => {
  const operations = Array.from({ length: 300 }, (_, index) => [{ op: "scene.object.upsert", object: { id: `bad-${index}`, kind: "totally-unknown" } }]).flat();
  const envelope = buildSceneValidation(project, operations);
  assert.equal(envelope.truncated, true);
  assert.ok(envelope.diagnostics.length <= 200);
  assert.equal(envelope.ok, false);
  assert.ok(JSON.stringify(envelope).length <= 32 * 1024, "envelope must fit the Rust 32 KiB budget");
});
