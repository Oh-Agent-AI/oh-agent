/**
 * Creator SDK 预校验与 validation 信封（设计 AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION
 * §5.2，P2 语义搬运）：Studio 在每个 preview 前用 city-sdk 校验载荷语义，把结论
 * 信封附到请求上；Rust 签发 preview 时核对信封的作用域（projectId/baseRevision/
 * payloadDigest）并原子绑定结论，调用方不能提交或覆盖。
 *
 * 校验范围（P2）：game pack 全量；scene 上插对象载荷；mount.bind 拓扑/可达性；
 * skin 词表。city.patch 语义归 City 引擎在套用时执行（Rust 保留结构与种子一致
 * 性这一 City 领域服务边界），remove 类操作无可载荷语义。校验自身抛错按 SDK
 * 判负处理——宁可拒绝也不静默放行。
 *
 * 信封必须满足 Rust 侧 creator_validation_invalid 的字段预算：diagnostics ≤200、
 * message ≤400、path ≤256、整封 ≤32 KiB——超限截断并置 truncated，而不是让
 * 签发被预算拒绝。payloadDigest 是规范 JSON（键排序、紧凑）上的 sha256，与
 * Rust canonical_json 同规格；Rust 在签发时对收到的载荷重算并逐项匹配。
 */
import { canonicalJson, validateMiniGamePack, validateSceneDraft, validateMount, validateVehicleProfileV1, type DiagnosticV1 } from "@agent-vitals/city-sdk";
import { CREATOR_CAPABILITIES_V1, CREATOR_RECOVERIES_V1, defaultVehicleCameraV1 } from "@agent-vitals/city-sdk";

export type ValidationEnvelope = {
  capabilityVersion: string;
  validatorVersion: 1;
  projectId: string;
  baseRevision: number;
  payloadDigest: string;
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

async function sha256Of(canonical: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

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

export async function buildGameValidation(projectId: string, baseRevision: number, game: unknown): Promise<ValidationEnvelope> {
  const payloadDigest = await sha256Of(canonicalJson(game));
  return finish(run(() => validateMiniGamePack(game)), projectId, baseRevision, payloadDigest);
}

export async function buildSceneValidation(project: SceneProjectSnapshot, projectId: string, baseRevision: number, operations: unknown): Promise<ValidationEnvelope> {
  const payloadDigest = await sha256Of(canonicalJson(operations));
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
  return finish(diagnostics, projectId, baseRevision, payloadDigest);
}

/**
 * Vehicle Profile 校验与归一化（2026-11-15 泛化切片）：MCP define 面发送展平字段、
 * preview 面发送 `vehicle` 对象（两者都可能缺 camera）；适配器统一归一化为完整
 * VehicleProfileV1（camera 缺省 = 确定性默认公式），用 city-sdk
 * validateVehicleProfileV1 判定后按完整 profile 计算 payloadDigest——宿主侧的
 * 结构硬闸与信封作用域核对都以这份载荷为准。
 */
export function normalizeVehicleProfileInput(raw: unknown): { ok: boolean; vehicle: Record<string, unknown>; diagnostics: DiagnosticV1[] } {
  const source = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id : typeof source.vehicleId === "string" ? source.vehicleId : "";
  const bounds = (source.bounds && typeof source.bounds === "object" && !Array.isArray(source.bounds) ? source.bounds : {}) as { halfLengthM: number; halfWidthM: number; halfHeightM: number };
  const candidate = {
    schemaVersion: 1,
    id,
    label: typeof source.label === "string" ? source.label : "",
    modelAssetId: source.modelAssetId === undefined ? null : source.modelAssetId,
    flightModel: source.flightModel,
    physics: source.physics,
    bounds: source.bounds,
    camera: source.camera ?? defaultVehicleCameraV1(bounds),
  };
  const checked = validateVehicleProfileV1(candidate);
  // 判负时仍回传候选对象：信封 payloadDigest 覆盖候选本身，宿主的 scope 核对与
  // 判负闸门各自独立成立，Agent 拿到的是 SDK 诊断而不是 scope 错误。
  return { ok: checked.ok, vehicle: candidate as Record<string, unknown>, diagnostics: checked.diagnostics };
}

export async function buildVehicleValidation(projectId: string, baseRevision: number, outcome: ReturnType<typeof normalizeVehicleProfileInput>): Promise<ValidationEnvelope> {
  const payloadDigest = await sha256Of(canonicalJson(outcome.vehicle));
  return finish(outcome.diagnostics, projectId, baseRevision, payloadDigest);
}

/** 目标项目/revision 无法核对时的判负信封：Rust 会以 scope 核对再次独立拒绝。 */
export function scopeMismatchEnvelope(projectId: string, baseRevision: number, code: string, message: string): ValidationEnvelope {  return {
    capabilityVersion: CREATOR_CAPABILITIES_V1.capabilityVersion,
    validatorVersion: 1,
    projectId, baseRevision,
    payloadDigest: "sha256:" + "0".repeat(64),
    ok: false,
    diagnostics: [{ code: code.slice(0, 128), severity: "error", path: "projectId", message: message.slice(0, 400) }],
  };
}

function finish(diagnostics: DiagnosticV1[], projectId: string, baseRevision: number, payloadDigest: string): ValidationEnvelope {
  const truncatedByCount = diagnostics.length > MAX_DIAGNOSTICS;
  const kept = diagnostics.slice(0, MAX_DIAGNOSTICS);
  // 序列化字节兜底：逐条丢弃最旧的诊断直到整封装进预算。
  let envelope = {
    capabilityVersion: CREATOR_CAPABILITIES_V1.capabilityVersion, validatorVersion: 1 as const,
    projectId, baseRevision, payloadDigest, ok: false, diagnostics: kept,
  };
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

/** E3 诊断闭环（Agent-first 编辑器规格 §3.3）：稳定错误码 → 恢复建议（与 MCP `next`
 * 字段同一份能力产物来源）。找不到时返回 null，调用方维持纯错误码行为。 */
export function recoveryFor(code: string): { tool: string; note: string } | null {
  const hit = CREATOR_RECOVERIES_V1.find(item => item.code === code);
  return hit ? { tool: hit.tool, note: hit.note } : null;
}

/** 展示面专用：纯错误码 + 同源恢复建议的组合文案。需要按码分支的逻辑继续用
 * `errorCode`（纯码），不要用本函数的返回值做比较。 */
export function describeError(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(candidate)) return fallback;
  const recovery = recoveryFor(candidate);
  return recovery ? `${candidate} — ${recovery.note}（下一步：${recovery.tool}）` : candidate;
}
