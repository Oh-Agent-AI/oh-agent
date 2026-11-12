/**
 * Creator 能力描述符 v1（设计文档 AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION §5.1）：
 * 模板/皮肤/操作词表与内容预算的唯一人工维护点。
 *
 * 构建期由 scripts/generate-creator-capabilities.mjs 导出到 assets/creator/*，
 * Rust（include_str!）与 MCP 消费生成产物；本文件是单一来源，改这里 + 重新生成，
 * 不改 Rust。`capabilityVersion` 变更时 preview/operation 记录随之可诊断版本偏斜。
 */

export const CREATOR_CAPABILITY_SCHEMA_VERSION = 1;
export const CREATOR_CAPABILITY_VERSION = "2026-11-12.1";

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

/** 内容预算：Rust 保留硬上限并 clamp（描述符不能把上限调高）。 */
export const CREATOR_BUDGETS_V1 = Object.freeze({
  gameBytes: 262144,
  sceneObjects: 10000,
  sceneColliders: 256,
  mountBindings: 64,
  cityPatchBytes: 262144,
});

export const CREATOR_CAPABILITIES_V1: CreatorCapabilitiesDescriptor = Object.freeze({
  schemaVersion: CREATOR_CAPABILITY_SCHEMA_VERSION,
  capabilityVersion: CREATOR_CAPABILITY_VERSION,
  operations: CREATOR_OPERATIONS_V1,
  content: CREATOR_CONTENT_V1,
  budgets: CREATOR_BUDGETS_V1,
});
