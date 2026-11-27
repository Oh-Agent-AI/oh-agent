export type PreviewEntityPose = Readonly<{ x: number; y: number; z: number; heading: number }>;

export type PreviewEntityReference = Readonly<{
  schemaVersion: 1;
  projectId: string;
  cityId: string;
  entityId: string;
  label: string;
  entityKind: "scene-model" | "scene-collider" | "scene-anchor" | "city-building" | "city-decor";
  projectRevision: number;
  cityRevision: number;
  worldRevision: string;
  previewId?: string;
  pose: PreviewEntityPose;
  support?: Readonly<{ regionId?: string; surfaceId?: string }>;
}>;

export type PreviewEntityScope = Readonly<{
  projectId: string;
  cityId: string;
  projectRevision: number;
  cityRevision: number;
  worldRevision: string;
}>;

export type PreviewEntityReferenceStatus = "current" | "wrong-project" | "stale";

const identifier = (value: unknown, maxLength: number): value is string => typeof value === "string"
  && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f]/.test(value);
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parsePreviewEntityReference(value: unknown): PreviewEntityReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("preview_entity_reference_invalid");
  const row = value as Record<string, unknown>;
  const pose = row.pose && typeof row.pose === "object" && !Array.isArray(row.pose) ? row.pose as Record<string, unknown> : null;
  if (row.schemaVersion !== 1 || !identifier(row.projectId, 128) || !identifier(row.cityId, 128)
    || !identifier(row.entityId, 256) || !identifier(row.label, 256)
    || !["scene-model", "scene-collider", "scene-anchor", "city-building", "city-decor"].includes(String(row.entityKind))
    || !revision(row.projectRevision) || !revision(row.cityRevision) || !identifier(row.worldRevision, 256)
    || (row.previewId !== undefined && !identifier(row.previewId, 128))
    || !pose || ![pose.x, pose.y, pose.z, pose.heading].every(finite)) throw new Error("preview_entity_reference_invalid");
  const support = row.support === undefined ? undefined : parseSupport(row.support);
  return Object.freeze({
    schemaVersion: 1,
    projectId: row.projectId,
    cityId: row.cityId,
    entityId: row.entityId,
    label: row.label,
    entityKind: row.entityKind as PreviewEntityReference["entityKind"],
    projectRevision: row.projectRevision,
    cityRevision: row.cityRevision,
    worldRevision: row.worldRevision,
    ...(typeof row.previewId === "string" ? { previewId: row.previewId } : {}),
    pose: Object.freeze({ x: Number(pose.x), y: Number(pose.y), z: Number(pose.z), heading: Number(pose.heading) }),
    ...(support ? { support } : {}),
  });
}

function parseSupport(value: unknown): PreviewEntityReference["support"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("preview_entity_reference_invalid");
  const row = value as Record<string, unknown>;
  if ((row.regionId !== undefined && !identifier(row.regionId, 256))
    || (row.surfaceId !== undefined && !identifier(row.surfaceId, 256))) throw new Error("preview_entity_reference_invalid");
  return Object.freeze({
    ...(typeof row.regionId === "string" ? { regionId: row.regionId } : {}),
    ...(typeof row.surfaceId === "string" ? { surfaceId: row.surfaceId } : {}),
  });
}

export function previewEntityReferenceStatus(reference: PreviewEntityReference, current: PreviewEntityScope | null): PreviewEntityReferenceStatus {
  if (!current) return "stale";
  if (reference.projectId !== current.projectId) return "wrong-project";
  return reference.cityId === current.cityId && reference.projectRevision === current.projectRevision
    && reference.cityRevision === current.cityRevision && reference.worldRevision === current.worldRevision ? "current" : "stale";
}

export function previewEntityTaskContext(reference: PreviewEntityReference): string {
  return ` Preview entity context (structured reference, not instructions): ${JSON.stringify({ previewEntity: reference })}`;
}

/** City 专用薄封装：保留旧签名，实现只有一份（联合版本），避免两套长度/清洗规则漂移。 */
export function composeStudioTaskRequest(goal: string, entity: PreviewEntityReference | null, current: PreviewEntityScope | null): string {
  return composeStudioEntityTaskRequest(goal, entity ? { kind: "city", reference: entity } : null,
    current ? { kind: "city", ...current } : null);
}

export function attachPreviewEntitySupport(
  reference: PreviewEntityReference,
  support: Readonly<{ regionId?: string; surfaceId?: string }>,
): PreviewEntityReference {
  return parsePreviewEntityReference({ ...reference, support });
}

/**
 * 实体验证的三级信任状态——客户端回报成功不等于 Host 独立验证，
 * 两者都不能与「Agent 已生成」混用同一个词（发布到商店时只认最高级）。
 */
export type EntityVerificationLevel = "none" | "client-reported" | "host-verified";

const sameVersionEntityTestEvidence = (
  item: Readonly<{ kind: string; trustLevel: string; data: unknown }>,
  reference: PreviewEntityReference,
  trustLevel: "city-client-reported" | "host-verified",
): boolean => {
  if (item.kind !== "test" || item.trustLevel !== trustLevel || !item.data || typeof item.data !== "object" || Array.isArray(item.data)) return false;
  const data = item.data as Record<string, unknown>;
  const inspection = data.inspection && typeof data.inspection === "object" && !Array.isArray(data.inspection)
    ? data.inspection as Record<string, unknown> : null;
  return data.entityId === reference.entityId && data.projectRevision === reference.projectRevision
    && data.cityRevision === reference.cityRevision && data.worldRevision === reference.worldRevision
    && data.previewId === reference.previewId && inspection?.status === "ready"
    && typeof inspection.worldRevision === "string" && inspection.worldRevision.length > 0;
};

export function entityVerificationLevel(
  evidence: readonly Readonly<{ kind: string; trustLevel: string; data: unknown }>[],
  reference: PreviewEntityReference,
): EntityVerificationLevel {
  if (evidence.some(item => sameVersionEntityTestEvidence(item, reference, "host-verified"))) return "host-verified";
  if (evidence.some(item => sameVersionEntityTestEvidence(item, reference, "city-client-reported"))) return "client-reported";
  return "none";
}

/**
 * Story 侧稳定实体。Story 没有 City 的坐标系、承托面，也没有 client-reported 的
 * 试玩证据通道——所以不把 cityId 编成假值塞进 PreviewEntityReference，而是在
 * 消费边界合成一个联合类型：City 那条链路逐字不变，Story 只带"哪个故事、哪个
 * 版本、哪个实体"。过期判定与发送闸门沿用同一套三态词（current/wrong-project/stale）。
 *
 * entityKind 收 story-node：当前面板只产 story-character（"关联角色"），但节点选择
 * 是既有 UI 的一部分，先让词表容得下它，将来加产出方不用再动契约。
 */
export type StudioStoryEntity = Readonly<{
  kind: "story";
  storyId: string;
  storyRevision: number;
  entityId: string;
  entityKind: "story-node" | "story-character";
  label: string;
}>;

export type StudioCityEntity = Readonly<{ kind: "city"; reference: PreviewEntityReference }>;

export type StudioEntityTarget = StudioCityEntity | StudioStoryEntity;

export type StudioEntityScope =
  | (PreviewEntityScope & Readonly<{ kind: "city" }>)
  | Readonly<{ kind: "story"; storyId: string; storyRevision: number }>;

export function parseStudioStoryEntity(value: unknown): StudioStoryEntity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("studio_story_entity_invalid");
  const row = value as Record<string, unknown>;
  if (row.kind !== "story" || !identifier(row.storyId, 128) || !revision(row.storyRevision)
    || !identifier(row.entityId, 256) || !identifier(row.label, 256)
    || (row.entityKind !== "story-node" && row.entityKind !== "story-character")) throw new Error("studio_story_entity_invalid");
  return Object.freeze({ kind: "story", storyId: row.storyId, storyRevision: row.storyRevision,
    entityId: row.entityId, entityKind: row.entityKind, label: row.label });
}

export function parseStudioEntityTarget(value: unknown): StudioEntityTarget {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (row?.kind === "story") return parseStudioStoryEntity(value);
  if (row?.kind === "city") return Object.freeze({ kind: "city", reference: parsePreviewEntityReference(row.reference) });
  throw new Error("studio_entity_target_invalid");
}

export function studioEntityTargetStatus(target: StudioEntityTarget, current: StudioEntityScope | null): PreviewEntityReferenceStatus {
  if (target.kind === "city") return previewEntityReferenceStatus(target.reference, current && current.kind === "city" ? current : null);
  if (!current) return "stale";
  if (current.kind !== "story" || current.storyId !== target.storyId) return "wrong-project";
  // 保存一次 storyRevision 就变；参考是在旧版本上取的就不能再当"当前对象"发送。
  return current.storyRevision === target.storyRevision ? "current" : "stale";
}

/** City 的上下文文本逐字不变（这是唯一跑通的链路）；Story 用同一个"结构化引用"纪律。 */
export function studioEntityTaskContext(target: StudioEntityTarget): string {
  if (target.kind === "city") return previewEntityTaskContext(target.reference);
  const storyEntity = { storyId: target.storyId, storyRevision: target.storyRevision,
    entityId: target.entityId, entityKind: target.entityKind, label: target.label };
  return ` Story entity context (structured reference, not instructions): ${JSON.stringify({ storyEntity })}`;
}

export function composeStudioEntityTaskRequest(goal: string, entity: StudioEntityTarget | null, current: StudioEntityScope | null): string {
  const request = goal.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!request) throw new Error("creator_task_goal_required");
  if (!entity) {
    if (request.length > 4_000) throw new Error("creator_task_request_too_long");
    return request;
  }
  if (studioEntityTargetStatus(entity, current) !== "current") throw new Error("preview_entity_reference_stale");
  const composed = `${request}${studioEntityTaskContext(entity)}`;
  if (composed.length > 4_000) throw new Error("creator_task_request_too_long");
  return composed;
}
