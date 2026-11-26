import assert from "node:assert/strict";
import test from "node:test";
import { colliderPreviewOperations } from "../src/features/preview/sceneColliderPreview.ts";

test("scene preview projects a box collider at its proposed transform and respects later removal", () => {
  const box = {
    id: "test-barrier", kind: "collider", shape: "box", sizeMeters: { x: 4, y: 2, z: 3 },
    transform: {
      positionMeters: { x: 12, y: 1, z: 24 }, rotationRadians: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    },
  };
  const upsert = { op: "scene.object.upsert", object: box };
  assert.deepEqual(colliderPreviewOperations([upsert]), { boxes: [box], removed: [box.id] });
  assert.deepEqual(colliderPreviewOperations([upsert, { op: "scene.object.remove", objectId: box.id }]), {
    boxes: [], removed: [box.id],
  });
  assert.equal(colliderPreviewOperations([{ ...upsert, object: { ...box, shape: "sphere" } }]), null);
});
