import { validateSceneDraft, type SceneDraftV1 } from "@oh-agent/city-sdk";

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

export function isSceneObjectPreviewOperations(operations: unknown): boolean {
  return Array.isArray(operations) && operations.length > 0 && operations.length <= 128 && operations.every(operation => {
    const row = object(operation);
    if (!row) return false;
    if (row.op === "scene.object.upsert" || row.op === "anchor.upsert") {
      return Object.keys(row).length === 2 && object(row.object) !== null;
    }
    if (row.op === "scene.object.remove" || row.op === "anchor.remove") {
      return Object.keys(row).length === 2 && typeof row.objectId === "string";
    }
    return false;
  });
}

export function buildScenePreviewDraft(baseScene: unknown, operations: unknown): SceneDraftV1 | null {
  const base = validateSceneDraft(baseScene);
  if (!base.ok || !isSceneObjectPreviewOperations(operations)) return null;
  const objects = [...base.value.objects];
  for (const operation of operations as Record<string, unknown>[]) {
    if (operation.op === "scene.object.upsert" || operation.op === "anchor.upsert") {
      const candidate = validateSceneDraft({ schemaVersion: 1, objects: [operation.object] });
      if (!candidate.ok) return null;
      const next = candidate.value.objects[0];
      const index = objects.findIndex(item => item.id === next.id);
      if (index < 0) objects.push(next); else objects[index] = next;
    } else {
      const index = objects.findIndex(item => item.id === operation.objectId);
      if (index < 0) return null;
      objects.splice(index, 1);
    }
  }
  const checked = validateSceneDraft({ schemaVersion: 1, objects });
  return checked.ok ? checked.value : null;
}
