import test from "node:test";
import assert from "node:assert/strict";
import {
  attachPreviewEntitySupport, composeStudioTaskRequest, entityVerificationLevel,
  parsePreviewEntityReference, previewEntityReferenceStatus, previewEntityTaskContext,
} from "../src/contracts/previewContext.ts";

const reference = parsePreviewEntityReference({
  schemaVersion: 1, projectId: "project-a", cityId: "city-a", entityId: "taxi-17", label: "黄色出租车",
  entityKind: "scene-model", projectRevision: 4, cityRevision: 8, worldRevision: "world-v3", previewId: "preview-a",
  pose: { x: 12, y: 3, z: -8, heading: Math.PI / 2 },
});
const scope = { projectId: "project-a", cityId: "city-a", projectRevision: 4, cityRevision: 8, worldRevision: "world-v3" };

test("preview entity references preserve stable identity, revision, pose and support", () => {
  assert.equal(reference.entityId, "taxi-17");
  assert.equal(previewEntityReferenceStatus(reference, scope), "current");
  assert.equal(previewEntityReferenceStatus(reference, null), "stale");
  assert.equal(previewEntityReferenceStatus(reference, { ...scope, projectRevision: 5 }), "stale");
  assert.equal(previewEntityReferenceStatus(reference, { ...scope, worldRevision: "world-v4" }), "stale");
  assert.equal(previewEntityReferenceStatus(reference, { ...scope, projectId: "project-b" }), "wrong-project");
  const supported = attachPreviewEntitySupport(reference, { regionId: "bridge-road", surfaceId: "bridge-deck" });
  assert.deepEqual(supported.support, { regionId: "bridge-road", surfaceId: "bridge-deck" });
  assert.throws(() => parsePreviewEntityReference({ ...reference, entityId: "" }), /preview_entity_reference_invalid/);
  assert.throws(() => parsePreviewEntityReference({ ...reference, pose: { x: NaN } }), /preview_entity_reference_invalid/);
});

test("task request carries bounded structured context and refuses stale objects", () => {
  const request = composeStudioTaskRequest("这辆车开到桥上时有点悬空。", reference, scope);
  assert.equal(request, `这辆车开到桥上时有点悬空。${previewEntityTaskContext(reference)}`);
  assert.match(request, /这辆车开到桥上时有点悬空/);
  assert.match(request, /"entityId":"taxi-17"/);
  assert.match(request, /"worldRevision":"world-v3"/);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(request), false);
  const multiline = composeStudioTaskRequest("第一行\n第二行\t继续", reference, scope);
  assert.equal(multiline.includes("第一行 第二行 继续"), true);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(multiline), false);
  assert.throws(() => composeStudioTaskRequest("继续修改", reference, { ...scope, projectRevision: 5 }), /preview_entity_reference_stale/);
  assert.throws(() => composeStudioTaskRequest("x".repeat(4_000), reference, scope), /creator_task_request_too_long/);
});

test("verification levels separate client playtest reports from Host verification", () => {
  const inspection = { status: "ready", worldRevision: "city-world-v2:sha256:surface", wheels: [1, 1, 1, 1] };
  const data = { entityId: "taxi-17", projectRevision: 4, cityRevision: 8, worldRevision: "world-v3", previewId: "preview-a", inspection };
  // 客户端回报到「试玩通过」这一级为止，绝不冒充 Host 验证。
  assert.equal(entityVerificationLevel([{ kind: "test", trustLevel: "city-client-reported", data }], reference), "client-reported");
  assert.equal(entityVerificationLevel([{ kind: "preview", trustLevel: "host-observed", data }], reference), "none");
  assert.equal(entityVerificationLevel([{ kind: "test", trustLevel: "city-client-reported", data: { ...data, entityId: "taxi-18" } }], reference), "none");
  assert.equal(entityVerificationLevel([{ kind: "test", trustLevel: "city-client-reported", data: { ...data, worldRevision: "world-v4" } }], reference), "none");
  assert.equal(entityVerificationLevel([{ kind: "test", trustLevel: "city-client-reported", data: { ...data, inspection: { ...inspection, status: "unsupported" } } }], reference), "none");
  // Host 可信检查证据是唯一的最高级；它不被客户端回报降级，反之亦然。
  assert.equal(entityVerificationLevel([{ kind: "test", trustLevel: "host-verified", data }], reference), "host-verified");
  assert.equal(entityVerificationLevel([
    { kind: "test", trustLevel: "city-client-reported", data },
    { kind: "test", trustLevel: "host-verified", data },
  ], reference), "host-verified");
});
