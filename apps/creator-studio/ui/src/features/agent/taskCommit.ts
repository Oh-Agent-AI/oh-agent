import { studioTaskScopeId, type StudioTask, type StudioTaskEvidence } from "../../contracts/studioTask";

/** 验收卡的语义 diff：按构件类型把 Preview 证据转成几行可读摘要。
 *  场景走宿主/SDK 的 changedObjects；Story 回显 document 统计节点/边/角色；
 *  City 列 changedFields。原始 JSON 折叠保留，判定永远以宿主证据为准。 */
export function previewSummary(evidence: StudioTaskEvidence, kind: StudioTask["artifact"]["kind"]): readonly string[] {
  const data = (evidence.data ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const changedObjects = Array.isArray(data.changedObjects) ? data.changedObjects as readonly Record<string, unknown>[] : [];
  if (kind === "creator-story") {
    const document = data.document;
    if (document && typeof document === "object" && !Array.isArray(document)) {
      const doc = document as Record<string, unknown>;
      const graph = (doc.graph ?? {}) as Record<string, unknown>;
      const canon = (doc.canon ?? {}) as Record<string, unknown>;
      lines.push(`将保存「${String(doc.title ?? "")}」内容版本 ${String(doc.storyVersion ?? "")}`);
      if (Array.isArray(graph.nodes)) lines.push(`节点 ${graph.nodes.length} · 边 ${Array.isArray(graph.edges) ? graph.edges.length : 0} · 入口 ${String(graph.start ?? "—")}`);
      if (Array.isArray(canon.characters)) lines.push(`角色 ${canon.characters.length}`);
    }
    const changedFields = Array.isArray(data.changedFields) ? data.changedFields as readonly string[] : [];
    if (changedFields.length > 0) lines.push(`变更字段：${changedFields.join("、")}`);
  } else if (changedObjects.length > 0) {
    const actionLabels: Readonly<Record<string, string>> = { added: "新增", removed: "移除", updated: "更新", changed: "更新" };
    const kindLabels: Readonly<Record<string, string>> = { sceneObject: "场景对象", cityPatch: "城市补丁", mount: "挂载", skin: "皮肤", object: "对象" };
    const byAction = new Map<string, number>();
    const byKind = new Map<string, number>();
    for (const item of changedObjects) {
      const action = typeof item.action === "string" ? item.action : "changed";
      const objectKind = typeof item.kind === "string" ? item.kind : "object";
      byAction.set(action, (byAction.get(action) ?? 0) + 1);
      byKind.set(objectKind, (byKind.get(objectKind) ?? 0) + 1);
    }
    lines.push([...byAction].map(([action, count]) => `${actionLabels[action] ?? action} ${count} 项`).join(" · "));
    lines.push([...byKind].map(([objectKind, count]) => `${kindLabels[objectKind] ?? objectKind}×${count}`).join(" · "));
  } else {
    const changedFields = Array.isArray(data.changedFields) ? data.changedFields as readonly string[] : [];
    if (changedFields.length > 0) lines.push(`变更：${changedFields.join("、")}`);
  }
  if (lines.length === 0) lines.push("宿主已校验 Preview；原始差异见下方证据详情。");
  return lines;
}

export function taskHasSceneObjectPreview(task: StudioTask): boolean {
  if (task.phase !== "awaiting-review" || !task.proposedChangeSetId) return false;
  return task.evidence.some(evidence => {
    if (evidence.kind !== "preview" || evidence.trustLevel !== "host-observed" || evidence.planRevision !== task.planRevision
      || (evidence.data as { previewId?: unknown } | null)?.previewId !== task.proposedChangeSetId) return false;
    const changed = (evidence.data as { changedObjects?: unknown } | null)?.changedObjects;
    return Array.isArray(changed) && changed.some(item => item && typeof item === "object"
      && (item as { kind?: unknown }).kind === "sceneObject");
  });
}

export function taskCommitBlockedReason(task: StudioTask, currentScopeId: string | null, currentRevision: number | null, hasUncommittedEdits: boolean): string | null {
  if (hasUncommittedEdits) return "存在未提交草稿；保存或丢弃后再确认。";
  if (currentScopeId === null || currentRevision === null) return null;
  if (studioTaskScopeId(task) !== currentScopeId) return "确认前请切换到任务对应的作品。";
  if (currentRevision !== task.artifact.expectedRevision) return "作品版本已变化；请重新执行任务生成新 Preview。";
  return null;
}
