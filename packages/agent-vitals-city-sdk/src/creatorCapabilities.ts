/**
 * Creator 能力描述符 v1（设计文档 AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION §5.1）：
 * 模板/皮肤/操作词表、内容预算与公开能力目录的唯一人工维护点。
 *
 * 构建期由 scripts/generate-creator-capabilities.mjs 导出到 assets/creator/*，
 * Rust（include_str!）与 MCP 消费生成产物；本文件是单一来源，改这里 + 重新生成，
 * 不改 Rust。`capabilityVersion` 变更时 preview/operation 记录随之可诊断版本偏斜。
 */

export const CREATOR_CAPABILITY_SCHEMA_VERSION = 1;
export const CREATOR_CAPABILITY_VERSION = "2026-11-12.2";

/** 协议级操作类别：首版固定四种，新增内容不能增加 kind（§5.1.1）。 */
export type CreatorOperationKind = "upsert" | "remove" | "bind" | "set";

export type CreatorOperationDescriptor = {
  id: string;
  kind: CreatorOperationKind;
  /** Rust 编译期固定枚举目标；描述符不得提供任意 JSON path 或路由。 */
  target: "scene.objects" | "mounts" | "skinId" | "cityPatch";
  /** 目标对象的主键字段名（remove/引用检查用）。 */
  idField?: string;
};

export type CreatorCapabilitiesProjection = {
  schemaVersion: 1;
  capabilityVersion: string;
  categories: Record<string, unknown>;
  preview: Record<string, unknown>;
};

export type CreatorCapabilitiesDescriptor = {
  schemaVersion: 1;
  capabilityVersion: string;
  operations: readonly CreatorOperationDescriptor[];
  content: { templates: readonly string[]; skins: readonly string[] };
  budgets: {
    gameBytes: number;
    sceneObjects: number;
    sceneColliders: number;
    mountBindings: number;
    cityPatchBytes: number;
  };
  /** 公开能力目录：宿主的 creator_capabilities() 与 MCP 的离线发现都直接返回这一份。 */
  capabilities: CreatorCapabilitiesProjection;
};

export const CREATOR_OPERATIONS_V1: readonly CreatorOperationDescriptor[] = Object.freeze([
  { id: "scene.object.upsert", kind: "upsert", target: "scene.objects", idField: "id" },
  { id: "scene.object.remove", kind: "remove", target: "scene.objects", idField: "id" },
  { id: "anchor.upsert", kind: "upsert", target: "scene.objects", idField: "id" },
  { id: "anchor.remove", kind: "remove", target: "scene.objects", idField: "id" },
  { id: "mount.bind", kind: "bind", target: "mounts", idField: "mountId" },
  { id: "mount.remove", kind: "remove", target: "mounts", idField: "mountId" },
  { id: "skin.select", kind: "set", target: "skinId" },
  { id: "city.patch.upsert", kind: "set", target: "cityPatch" },
  { id: "city.patch.remove", kind: "remove", target: "cityPatch" },
]);

/** 皮肤/模板目录：新增内容只改这里 + 重新生成资产，Rust 零改动（§1.3）。 */
export const CREATOR_CONTENT_V1 = Object.freeze({
  templates: ["checkpoint-race", "collect-one"],
  skins: ["miami-vice", "desert-evening"],
});

/** 内容预算：Rust 保留硬上限并 clamp（描述符不能把上限调高）。数值与
 * apps/desktop/src-tauri/src/creator_projects.rs 的 MAX_* 常量一致（Rust 守卫测试锁定）。 */
export const CREATOR_BUDGETS_V1 = Object.freeze({
  gameBytes: 262144,
  sceneObjects: 10000,
  sceneColliders: 256,
  mountBindings: 32,
  cityPatchBytes: 262144,
});

/** 非内容预算的公开上限（协议/生命周期）：同样与 Rust 常量锁定，避免能力发现虚报。 */
export const CREATOR_LIMITS_V1 = Object.freeze({
  sceneObjectKinds: ["model", "anchor", "collider"],
  maxOperationsPerPreview: 128,
  maxReleaseMounts: 32,
  maxImportedModelBytes: 64 * 1024 * 1024,
  maxProjectAssets: 4096,
  playtestTtlMs: 30 * 60 * 1000,
  maxProjectBytes: 2 * 1024 * 1024,
  maxReleaseBytes: 512 * 1024,
  previewTtlMs: 600_000,
  maxActivePreviews: 128,
});

/** 公开能力目录：此前散落在 Rust 的 creator_capabilities()，现在由 SDK 声明。 */
export const CREATOR_CAPABILITIES_PROJECTION_V1: CreatorCapabilitiesProjection = Object.freeze({
  schemaVersion: 1,
  capabilityVersion: CREATOR_CAPABILITY_VERSION,
  categories: {
    game: { preview: "creator.game.preview", commit: "creator.project.commit", maxGameBytes: CREATOR_BUDGETS_V1.gameBytes },
    scene: { preview: "creator.scene.preview", commit: "creator.scene.commit",
      objectKinds: CREATOR_LIMITS_V1.sceneObjectKinds, maxObjects: CREATOR_BUDGETS_V1.sceneObjects,
      maxColliders: CREATOR_BUDGETS_V1.sceneColliders, maxOperationsPerPreview: CREATOR_LIMITS_V1.maxOperationsPerPreview },
    mount: { bind: "mount.bind", remove: "mount.remove", maxReleaseMounts: CREATOR_LIMITS_V1.maxReleaseMounts },
    skin: { select: "skin.select", skins: CREATOR_CONTENT_V1.skins },
    cityPatch: { upsert: "city.patch.upsert", remove: "city.patch.remove", maxBytes: CREATOR_BUDGETS_V1.cityPatchBytes },
    assets: { import: "creator.asset.import（桌面原生选择器，MCP 不接收路径）",
      maxImportedModelBytes: CREATOR_LIMITS_V1.maxImportedModelBytes, maxAssets: CREATOR_LIMITS_V1.maxProjectAssets },
    playtest: { start: "creator.project.playtest.start", result: "creator.project.playtest.result",
      cancel: "creator.project.playtest.cancel", ttlMs: CREATOR_LIMITS_V1.playtestTtlMs },
    project: { create: "creator.project.create", publish: "creator.project.publish",
      maxDocumentBytes: CREATOR_LIMITS_V1.maxProjectBytes, maxReleaseBytes: CREATOR_LIMITS_V1.maxReleaseBytes,
      templates: CREATOR_CONTENT_V1.templates },
  },
  preview: { ttlMs: CREATOR_LIMITS_V1.previewTtlMs, maxActive: CREATOR_LIMITS_V1.maxActivePreviews, singleUse: true, instanceBound: true },
});

export const CREATOR_CAPABILITIES_V1: CreatorCapabilitiesDescriptor = Object.freeze({
  schemaVersion: CREATOR_CAPABILITY_SCHEMA_VERSION,
  capabilityVersion: CREATOR_CAPABILITY_VERSION,
  operations: CREATOR_OPERATIONS_V1,
  content: CREATOR_CONTENT_V1,
  budgets: CREATOR_BUDGETS_V1,
  capabilities: CREATOR_CAPABILITIES_PROJECTION_V1,
});
