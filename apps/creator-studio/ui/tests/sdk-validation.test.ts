import test from "node:test";
import assert from "node:assert/strict";
import { buildGameValidation, buildSceneValidation, scopeMismatchEnvelope } from "../src/sdkValidation";
import { CREATOR_TEMPLATES_V1 } from "../../../../packages/agent-vitals-city-sdk/src/creatorTemplates";
import { CREATOR_CAPABILITIES_V1 as CAPABILITIES } from "../../../../packages/agent-vitals-city-sdk/src/creatorCapabilities";

/**
 * Studio SDK 预校验信封的单元测试（设计 §5.2，P2 语义搬运）：
 * 信封字段必须满足 Rust 侧 creator_validation_invalid 的形状与预算
 * （capabilityVersion 与描述符一致、severity 枚举、≤200 条诊断、超限截断），
 * 并携带作用域绑定（projectId/baseRevision/payloadDigest）——Rust 签发 preview
 * 时对收到的载荷重算规范摘要并逐项匹配，审查修复的核心保证。
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

test("game envelope: valid pack passes with descriptor version and scope binding", async () => {
  const envelope = await buildGameValidation("project-abc", 3, CREATOR_TEMPLATES_V1[0].pack);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.validatorVersion, 1);
  assert.equal(envelope.capabilityVersion, CAPABILITIES.capabilityVersion);
  assert.equal(envelope.projectId, "project-abc");
  assert.equal(envelope.baseRevision, 3);
  assert.match(envelope.payloadDigest, /^sha256:[a-f0-9]{64}$/);
  // 同一载荷必须产生同一摘要（Rust 侧以 canonical_json 重算并逐项匹配）。
  const repeat = await buildGameValidation("project-abc", 3, CREATOR_TEMPLATES_V1[0].pack);
  assert.equal(repeat.payloadDigest, envelope.payloadDigest);
  const different = await buildGameValidation("project-abc", 3, CREATOR_TEMPLATES_V1[1].pack);
  assert.notEqual(different.payloadDigest, envelope.payloadDigest);
  assert.deepEqual(envelope.diagnostics, []);
  assert.equal(envelope.truncated, undefined);
});

test("game envelope: script/unknown op is a signed rejection", async () => {
  const bad = { ...CREATOR_TEMPLATES_V1[0].pack, rules: { ...CREATOR_TEMPLATES_V1[0].pack.rules,
    nodes: [...CREATOR_TEMPLATES_V1[0].pack.rules.nodes, { id: "bad", on: { type: "run.started" }, actions: [{ op: "host.call", method: "readFile" }] }] } };
  const envelope = await buildGameValidation("project-abc", 0, bad);
  assert.equal(envelope.ok, false);
  assert.ok(envelope.diagnostics.length >= 1);
  for (const item of envelope.diagnostics) {
    assert.match(item.code, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "diagnostic code must satisfy Rust valid_id");
    assert.ok(item.severity === "error" || item.severity === "warning");
    assert.ok(item.path.length > 0 && item.path.length <= 256);
    assert.ok(item.message.length <= 400);
  }
});

test("scene envelope: upsert payload validated by the same SceneDraft validator", async () => {
  const good = await buildSceneValidation(project, "project-abc", 0, [{ op: "scene.object.upsert", object: {
    id: "crate-1", kind: "collider", shape: "box", sizeMeters: { x: 1, y: 1, z: 1 },
    transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } } }]);
  assert.equal(good.ok, true);
  const bad = await buildSceneValidation(project, "project-abc", 0, [{ op: "scene.object.upsert", object: {
    id: "crate-2", kind: "collider", shape: "sphere", sizeMeters: { x: 1, y: 1, z: 1 },
    transform: { positionMeters: { x: 0, y: 0, z: 0 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } } }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some(item => item.severity === "error"));
});

test("scene envelope: mount.bind checks topology and unbound layout fails closed", async () => {
  const mount = { schemaVersion: 1, mountId: "main-mount",
    layout: { kind: "city-layout", id: "loop-layout", version: "1", digest: "sha256:" + "a".repeat(64) },
    game: { kind: "city-minigame", id: project.game.id, version: "1", digest: "sha256:" + "b".repeat(64) },
    entryAnchorId: "spawn-a", bindings: { points: ["zone-b"] }, parameterOverrides: {} };
  const bound = await buildSceneValidation(project, "project-abc", 0, [{ op: "mount.bind", mount }]);
  // 结论内容（槽位基数/可达性）归 SDK 语料测试；这里只断言校验在已绑定项目上运行并产出结论。
  assert.equal(typeof bound.ok, "boolean");
  const unbound = await buildSceneValidation(null, "project-abc", 0, [{ op: "mount.bind", mount }]);
  assert.equal(unbound.ok, false);
  assert.ok(unbound.diagnostics.some(item => item.code === "creator_layout_not_bound"));
});

test("scene envelope: unknown skin rejected, listed skin passes; city.patch is the retained Rust boundary", async () => {
  const bad = await buildSceneValidation(project, "project-abc", 0, [{ op: "skin.select", skinId: "totally-unknown" }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.some(item => item.code === "creator_skin_not_found"));
  const good = await buildSceneValidation(project, "project-abc", 0, [{ op: "skin.select", skinId: CAPABILITIES.content.skins[0] }]);
  assert.equal(good.ok, true);
  const patch = await buildSceneValidation(project, "project-abc", 0, [{ op: "city.patch.upsert", patch: { anything: true } }]);
  assert.equal(patch.ok, true, "city.patch structural checks are the retained Rust City-domain boundary; Studio must not reject here");
});

test("scope-mismatch envelope: signed rejection carrying the target identity", () => {
  const envelope = scopeMismatchEnvelope("project-abc", 7, "creator_validation_scope_mismatch", "预览目标 revision 不一致。");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.projectId, "project-abc");
  assert.equal(envelope.baseRevision, 7);
  assert.equal(envelope.validatorVersion, 1);
  assert.equal(envelope.diagnostics[0].code, "creator_validation_scope_mismatch");
  assert.match(envelope.diagnostics[0].code, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
});

test("envelope budget: diagnostics truncate with truncated marker and stay within bounds", async () => {
  const operations = Array.from({ length: 300 }, (_, index) => [{ op: "scene.object.upsert", object: { id: `bad-${index}`, kind: "totally-unknown" } }]).flat();
  const envelope = await buildSceneValidation(project, "project-abc", 0, operations);
  assert.equal(envelope.truncated, true);
  assert.ok(envelope.diagnostics.length <= 200);
  assert.equal(envelope.ok, false);
  assert.ok(JSON.stringify(envelope).length <= 32 * 1024, "envelope must fit the Rust 32 KiB budget");
});
