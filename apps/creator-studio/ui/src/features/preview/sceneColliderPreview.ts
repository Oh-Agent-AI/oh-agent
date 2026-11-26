import { validateSceneDraft, type SceneBoxColliderObjectV1 } from "@oh-agent/city-sdk";

export type AgentColliderPreview = Readonly<{
  previewId: string;
  projectId: string;
  revision: number;
  expiresAt: number;
  boxes: readonly SceneBoxColliderObjectV1[];
  removed: readonly string[];
  sceneOperations?: readonly Record<string, unknown>[];
}>;

export function colliderPreviewOperations(operations: unknown) {
  if (!Array.isArray(operations)) return null;
  const boxes = new Map<string, SceneBoxColliderObjectV1>();
  const removed = new Set<string>();
  for (const operation of operations) {
    if (operation?.op === "scene.object.remove" && typeof operation.objectId === "string") {
      boxes.delete(operation.objectId);
      removed.add(operation.objectId);
    }
    if (operation?.op === "scene.object.upsert") {
      const checked = validateSceneDraft({ schemaVersion: 1, objects: [operation.object] });
      if (!checked.ok) return null;
      const object = checked.value.objects[0];
      if (object.kind === "collider") boxes.set(object.id, object);
      else boxes.delete(object.id);
      removed.add(object.id);
    }
  }
  return { boxes: [...boxes.values()], removed: [...removed] };
}
