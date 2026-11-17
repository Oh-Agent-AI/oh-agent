/**
 * Creator 能力描述符 v1（设计文档 AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION §5.1）：
 * 模板/皮肤/操作词表、内容预算与公开能力目录的唯一人工维护点。
 *
 * 构建期由 scripts/generate-creator-capabilities.mjs 导出到 assets/creator/*，
 * Rust（include_str!）与 MCP 消费生成产物；本文件是单一来源，改这里 + 重新生成，
 * 不改 Rust。`capabilityVersion` 变更时 preview/operation 记录随之可诊断版本偏斜。
 */
import { ARID_DUNES_WORLD_V2, COASTAL_ISLANDS_WORLD_V1 } from "./worldParameters";

export const CREATOR_CAPABILITY_SCHEMA_VERSION = 1;
export const CREATOR_CAPABILITY_VERSION = "2026-11-15.1";

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

export type CreatorSemanticGateV1 = Readonly<{
  schemaVersion: 1;
  /** 官方 Studio webview 附发信封的常规路径。 */
  studioEnvelope: boolean;
  /** 宿主内嵌 city-sdk 闸（E5，spec §8.4 路径 2）：Studio 缺席时的权威回退。 */
  embeddedSdk: boolean;
  /** embeddedSdk 覆盖的编辑面（headless 可 commit）。 */
  embeddedSdkCoverage: readonly string[];
  /** 仍需 Studio/视口/City 运行时、headless 如实不可用的编辑面。 */
  requiresStudio: readonly string[];
}>;

export type CreatorCapabilitiesDescriptor = {
  schemaVersion: 1;
  capabilityVersion: string;
  operations: readonly CreatorOperationDescriptor[];
  content: { templates: readonly string[]; skins: readonly string[] };
  /** 稳定错误码 → 可执行恢复建议（诊断闭环单一来源，见 CREATOR_RECOVERIES_V1）。 */
  recoveries?: readonly Readonly<{ code: string; tool: string; args: Record<string, unknown>; note: string }>[];
  budgets: {
    gameBytes: number;
    sceneObjects: number;
    sceneColliders: number;
    mountBindings: number;
    cityPatchBytes: number;
  };
  /** 公开能力目录：宿主的 creator_capabilities() 与 MCP 的离线发现都直接返回这一份。 */
  capabilities: CreatorCapabilitiesProjection;
  /** 无头语义校验可用性（E5）：能力发现不得虚报——宿主守卫测试钉住这里的声明
   * 与实际嵌入能力（bundle digest 锁文件 + 锁步向量）一致。 */
  semanticGate: CreatorSemanticGateV1;
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
  templates: ["checkpoint-race", "flight-checkpoint", "ornithopter-flight", "collect-one"],
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

/** World-parameter edit budgets (CITY_WORLD_DIVERSIFICATION_SDK_SPEC_2026_11_15
 * §5.2): per preview ≤16 operations, ≤32 distinct parameters and an 8 KiB
 * operations payload. Rust keeps identical hard caps and clamps (guard tests
 * pin the generated descriptor against them), so raising these numbers here
 * alone can never widen the enforced limit. */
export const CREATOR_WORLD_BUDGETS_V1 = Object.freeze({
  maxOperationsPerPreview: 16,
  maxParametersPerSet: 32,
  maxRequestBytes: 8 * 1024,
});

/** Read-only projection of the registered world capability catalogs
 * (`worldParameters.ts` is the single source; this re-exports their
 * contractVersion/parameters/presets verbatim so capability discovery cannot
 * drift from the SDK contract). Operation `world.set` is layout-affecting and
 * always produces a new world revision; `style.set` is not cataloged yet and
 * therefore not callable (spec §2.3). */
export const CREATOR_WORLDS_V1 = Object.freeze({
  schemaVersion: 1,
  capabilityVersion: CREATOR_CAPABILITY_VERSION,
  budgets: CREATOR_WORLD_BUDGETS_V1,
  generators: Object.freeze({
    "arid-dunes-v1": Object.freeze({
      contractVersion: ARID_DUNES_WORLD_V2.contractVersion,
      parameters: ARID_DUNES_WORLD_V2.parameters,
      presets: ARID_DUNES_WORLD_V2.presets,
    }),
    "coastal-islands-v1": Object.freeze({
      contractVersion: COASTAL_ISLANDS_WORLD_V1.contractVersion,
      parameters: COASTAL_ISLANDS_WORLD_V1.parameters,
      presets: COASTAL_ISLANDS_WORLD_V1.presets,
    }),
  }),
});

/** Additive game-type discovery for UI/Agent planning. Descriptors remain
 * data-only; adapters are app-side and `planned` entries are not registrable. */
export type CreatorGameTypeStatusV1 = "builtin-adapter" | "prototype" | "planned";
export type CreatorGameTypeSummaryV1 = Readonly<{
  id: string; label: string; template: string; templateCatalog: "creator" | "builtin" | "planned";
  runtime: Readonly<{ id: string; contractVersion: number }>; status: CreatorGameTypeStatusV1;
}>;
export const CREATOR_GAME_TYPES_V1: readonly CreatorGameTypeSummaryV1[] = Object.freeze<CreatorGameTypeSummaryV1[]>([
  { id: "miami.flight-v1", label: "驾驶飞机", template: "miami-flight", templateCatalog: "builtin",
    runtime: { id: "miami.flight", contractVersion: 1 }, status: "builtin-adapter" },
  { id: "miami.driving-v1", label: "驾车", template: "miami-driving", templateCatalog: "builtin",
    runtime: { id: "miami.driving", contractVersion: 1 }, status: "builtin-adapter" },
  { id: "miami.mecha-v1", label: "机甲战棋", template: "miami-mecha", templateCatalog: "builtin",
    runtime: { id: "miami.mecha", contractVersion: 1 }, status: "builtin-adapter" },
  { id: "miami.cinema-v1", label: "航拍", template: "miami-cinema", templateCatalog: "builtin",
    runtime: { id: "miami.cinema", contractVersion: 1 }, status: "builtin-adapter" },
  { id: "creator.flight-ornithopter-prototype-v1", label: "扑翼飞行（飞行原型）", template: "miami-flight", templateCatalog: "builtin",
    runtime: { id: "miami.flight", contractVersion: 1 }, status: "prototype" },
  { id: "creator.flight-ornithopter-v1", label: "扑翼飞行", template: "ornithopter-flight", templateCatalog: "planned",
    runtime: { id: "city-flight-ornithopter", contractVersion: 1 }, status: "planned" },
]);

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
    worlds: { operation: "world.set", budgets: CREATOR_WORLD_BUDGETS_V1, generators: CREATOR_WORLDS_V1.generators },
    gameTypes: { status: "adapter-seam", types: CREATOR_GAME_TYPES_V1 },
  },
  preview: { ttlMs: CREATOR_LIMITS_V1.previewTtlMs, maxActive: CREATOR_LIMITS_V1.maxActivePreviews, singleUse: true, instanceBound: true },
});

/** 恢复建议（Agent-first 诊断闭环，STUDIO_AGENT_FIRST_EDITOR_SPEC §3.3）：稳定错误码 →
 * 可执行下一步（工具 + 参数模板）。由生成链导出，宿主/MCP 在错误响应的 `next` 字段
 * 返回同一份建议；Agent 与 Studio UI 看到同一来源。工具名必须在已注册集合内。 */
export const CREATOR_RECOVERIES_V1: ReadonlyArray<Readonly<{ code: string; tool: string; args: Record<string, unknown>; note: string }>> = Object.freeze([
  Object.freeze({ code: "creator_layout_not_ready", tool: "creator_city_view_status", args: {}, note: "布局尚未生成完毕；轮询状态直到 ready 后再读取布局。" }),
  Object.freeze({ code: "creator_layout_not_found", tool: "creator_city_view_status", args: {}, note: "该版本尚无布局；等待城市视口 ready（必要时用 creator_city_view 打开），布局由视口生成后再读取。" }),
  Object.freeze({ code: "revision_conflict", tool: "creator_project_read", args: {}, note: "项目已被他人推进；重读最新 revision 后以新基线重开预览。" }),
  Object.freeze({ code: "creator_city_revision_unavailable", tool: "creator_city_read", args: {}, note: "请求的历史版本已被覆盖；改读当前 revision。" }),
  Object.freeze({ code: "preview_expired", tool: "creator_scene_preview", args: {}, note: "预览已过期；以当前 revision 重新发起预览后再提交。" }),
  Object.freeze({ code: "operation_id_conflict", tool: "creator_operation_status", args: {}, note: "同一 operationId 被用于不同请求；换新 operationId，或先查询既有结果。" }),
  Object.freeze({ code: "creator_playtest_not_claimed", tool: "creator_playtest_start", args: {}, note: "尚无活跃试玩；先 start 一次试玩再读取结果。" }),
  Object.freeze({ code: "creator_playtest_instance_mismatch", tool: "creator_playtest_start", args: {}, note: "试玩被其他实例领取；重新 start 开启新的试玩。" }),
  Object.freeze({ code: "creator_capture_unavailable", tool: "creator_city_view_status", args: {}, note: "视口不可用（未打开/无头）；等待视口 ready，或改用结构校验与无头规则试玩。" }),
  Object.freeze({ code: "creator_validation_scope_mismatch", tool: "creator_project_read", args: {}, note: "信封作用域与请求不符；重读项目后让 Studio 重新附发信封。" }),
]);

export const CREATOR_SEMANTIC_GATE_V1: CreatorSemanticGateV1 = Object.freeze({
  schemaVersion: 1,
  studioEnvelope: true,
  embeddedSdk: true,
  embeddedSdkCoverage: ["vehicle.preview", "vehicle.define", "city.edit.preview(world.set)", "city.edit.commit", "city.create"],
  requiresStudio: ["scene.preview", "game.preview", "city.layout.save", "city.anchor.upsert", "city.patch.preview",
    "project.create(cityId 绑定布局)", "project.publish", "playtest.start", "viewport.capture"],
});

export const CREATOR_CAPABILITIES_V1: CreatorCapabilitiesDescriptor = Object.freeze({
  schemaVersion: CREATOR_CAPABILITY_SCHEMA_VERSION,
  capabilityVersion: CREATOR_CAPABILITY_VERSION,
  operations: CREATOR_OPERATIONS_V1,
  content: CREATOR_CONTENT_V1,
  budgets: CREATOR_BUDGETS_V1,
  capabilities: CREATOR_CAPABILITIES_PROJECTION_V1,
  recoveries: CREATOR_RECOVERIES_V1,
  semanticGate: CREATOR_SEMANTIC_GATE_V1,
});
