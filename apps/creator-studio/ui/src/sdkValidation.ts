/**
 * Creator SDK 预校验与 validation 信封（设计 AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION
 * §5.2，P2 语义搬运）：Studio 在每个 preview 前用 city-sdk 校验载荷语义，把结论
 * 信封附到请求上；Rust 签发 preview 时原子绑定结论，调用方不能提交或覆盖。
 *
 * 校验范围（P2）：game pack 全量；scene 上插对象载荷；mount.bind 拓扑/可达性；
 * skin 词表。city.patch.* 语义归 City 引擎（Rust 保持结构与预算），remove 类操作
 * 无可载荷语义。校验自身抛错按 SDK 判负处理——宁可拒绝也不静默放行 legacy 直通。
 *
 * 信封必须满足 Rust 侧 creator_validation_invalid 的字段预算：diagnostics ≤200、
 * message ≤400、path ≤256、整封 ≤32 KiB——超限截断并置 truncated，而不是让
 * 签发被预算拒绝。
 */
import { validateMiniGamePack, validateSceneDraft, validateMount, type DiagnosticV1 } from "@agent-vitals/city-sdk";
import { CREATOR_CAPABILITIES_V1 } from "@agent-vitals/city-sdk";

export type ValidationEnvelope = {
  capabilityVersion: string;
  validatorVersion: 1;
  ok: boolean;
  diagnostics: DiagnosticV1[];
  truncated?: boolean;
};

const MAX_DIAGNOSTICS = 200;
const MAX_ENVELOPE_BYTES = 30_000; // Rust 上限 32 KiB；留信封键开销余量。

type SceneProjectSnapshot = {
  cityLayout?: { layout?: unknown } | null;
  game?: unknown;
} | null;

/** SDK 诊断裁剪到宿主信封预算（Rust creator_validation_invalid 的字段上限）。 */
const bounded = (item: DiagnosticV1): DiagnosticV1 => ({
  code: item.code,
  severity: item.severity === "warning" ? "warning" : "error",
  path: item.path.slice(0, 256) || "$",
  ...(item.objectId !== undefined ? { objectId: String(item.objectId).slice(0, 128) } : {}),
  message: item.message.slice(0, 400),
});

const run = (validate: () => { diagnostics: readonly DiagnosticV1[] }): DiagnosticV1[] => {
  try {
    return validate().diagnostics.map(bounded);
  } catch {
    return [{ code: "studio_validation_internal", severity: "error", path: "$", message: "Studio SDK 校验执行失败；按判负处理。" }];
  }
};

const layoutOf = (project: SceneProjectSnapshot): unknown =>
  project?.cityLayout && typeof project.cityLayout === "object" ? (project.cityLayout as { layout?: unknown }).layout : undefined;

export function buildGameValidation(game: unknown): ValidationEnvelope {
  return finish(run(() => validateMiniGamePack(game)));
}

export function buildSceneValidation(project: SceneProjectSnapshot, operations: unknown): ValidationEnvelope {
  const diagnostics: DiagnosticV1[] = [];
  const list = Array.isArray(operations) ? operations as Array<Record<string, unknown>> : [];
  const layout = layoutOf(project);
  const game = project?.game;
  for (const operation of list) {
    const op = typeof operation?.op === "string" ? operation.op : "";
    if ((op === "scene.object.upsert" || op === "anchor.upsert") && operation.object !== undefined) {
      // 单对象走同一 SceneDraft 校验器：与整场景提交同一套 kind/字段/预算语义。
      diagnostics.push(...run(() => validateSceneDraft({ schemaVersion: 1, objects: [operation.object] })));
    } else if (op === "mount.bind" && operation.mount !== undefined) {
      if (!layout || !game) {
        diagnostics.push({ code: "creator_layout_not_bound", severity: "error", path: "mount", message: "项目未绑定 City 布局，挂载无法校验。" });
      } else {
        diagnostics.push(...run(() => validateMount({ layout, game, mount: operation.mount })));
      }
    } else if (op === "skin.select") {
      const skinId = typeof operation.skinId === "string" ? operation.skinId : "";
      if (!CREATOR_CAPABILITIES_V1.content.skins.includes(skinId)) {
        diagnostics.push({ code: "creator_skin_not_found", severity: "error", path: "skinId", message: `未知皮肤 ID：${skinId || "(空)"}` });
      }
    }
  }
  return finish(diagnostics);
}

function finish(diagnostics: DiagnosticV1[]): ValidationEnvelope {
  const truncatedByCount = diagnostics.length > MAX_DIAGNOSTICS;
  const kept = diagnostics.slice(0, MAX_DIAGNOSTICS);
  // 序列化字节兜底：逐条丢弃最旧的诊断直到整封装进预算。
  let envelope = { capabilityVersion: CREATOR_CAPABILITIES_V1.capabilityVersion, validatorVersion: 1 as const, ok: false, diagnostics: kept };
  while (JSON.stringify(envelope).length > MAX_ENVELOPE_BYTES && envelope.diagnostics.length > 0) {
    const drop = Math.max(1, Math.ceil(envelope.diagnostics.length / 4));
    envelope = { ...envelope, diagnostics: envelope.diagnostics.slice(0, -drop) };
  }
  const truncated = truncatedByCount || envelope.diagnostics.length < diagnostics.length;
  return {
    ...envelope,
    ok: !truncated && !envelope.diagnostics.some(item => item.severity === "error"),
    ...(truncated ? { truncated: true } : {}),
  };
}
