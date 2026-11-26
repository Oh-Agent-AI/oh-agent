/**
 * 嵌入式语义闸入口（E5 全量，spec §8.4 路径 2 / §11）：宿主（Rust，rquickjs 承载的
 * Bellard QuickJS）在 Studio webview 不可用时，用本模块的导出运行**同一份**
 * city-sdk 校验器与 Studio 适配器逻辑。本文件只做「注册表 + 稳定出口形状」，不复制
 * 任何校验语义：vehicle 归一化/校验来自 sdkValidation.normalizeVehicleProfileInput，
 * world.set 合并来自 cityWorldOperations.applyCityWorldOperations，深度语义全部在
 * city-sdk。打包脚本（apps/desktop/src-tauri/embedded_city_sdk/build.mjs）把本模块
 * 打成 IIFE 交给 QuickJS eval；入口全是同步函数——QuickJS 里没有异步作业队列依赖，
 * crypto.subtle 由宿主以同步等价物注入（`await` 对已解析值原样透传）。
 *
 * 桥协议：JSON 字符串进、JSON 字符串出（citySdkGate.invoke(entry, argsJson) →
 * JSON.stringify(outcome)）。对象永不跨桥（W1 spike 风险 ③ 的句柄生命周期封装：
 * 每次调用一个全新 Runtime/Context，调用结束整体销毁，无跨调用句柄）。
 */
import { estimateVehiclePerformanceV1, validateCityInstance, validateMiniGamePack, validateSceneDraft,
  validateVehicleProfileV1, validateWorldParametersV1, type DiagnosticV1, type VehicleProfileV1 } from "@oh-agent/city-sdk";
import { normalizeVehicleProfileInput } from "./sdkValidation";
import { applyCityWorldOperations } from "./cityWorldOperations";

export const EMBEDDED_GATE_VERSION = 1;

/** 统一出口形状：ok + 可选诊断；invoke 层再整体 JSON.stringify。 */
type GateOutcome = { ok: boolean; [key: string]: unknown };

/** 校验执行自身抛错按判负处理（与 Studio 适配器 run() 的兜底同语义）——宁可拒绝
 * 也不静默放行。稳定码与 Studio 的 studio_validation_internal 区分来源。 */
const wrap = (fn: () => GateOutcome): GateOutcome => {
  try {
    return fn();
  } catch {
    const internal: DiagnosticV1 = { code: "embedded_gate_internal", severity: "error", path: "$",
      message: "Embedded SDK gate failed to execute this entry; treat the payload as rejected." };
    return { ok: false, diagnostics: [internal] };
  }
};

/** Vehicle 画像归一化 + city-sdk 校验（与 Studio 适配器逐语义一致：camera 缺省 =
 * 确定性默认公式；判负时仍回传候选，payloadDigest 覆盖候选本身）。 */
export function gateValidateVehicle(raw: unknown): GateOutcome {
  const outcome = normalizeVehicleProfileInput(raw);
  return { ok: outcome.ok, vehicle: outcome.vehicle, diagnostics: outcome.diagnostics };
}

/** 与 Studio 预览响应同源的确定性性能预估（city-sdk estimateVehiclePerformanceV1）；
 * 画像无效时 ok=false 且不带 estimate——宿主不得用第二份公式兜底。 */
export function gateEstimateVehicle(raw: unknown): GateOutcome {
  const outcome = normalizeVehicleProfileInput(raw);
  if (!outcome.ok) return { ok: false, vehicle: outcome.vehicle, diagnostics: outcome.diagnostics };
  return { ok: true, vehicle: outcome.vehicle,
    estimate: estimateVehiclePerformanceV1(outcome.vehicle as unknown as VehicleProfileV1) };
}

/** city.edit.preview Form B（world.set）的合并 + 复验（与 main.tsx attachValidation
 * 逐语义一致）：读入权威 city 文档 → validateCityInstance → revision 一致才合并 →
 * 合并结果（或判负时的 fallback profile）+ ok 一并返回。requestDigest 由宿主按
 * {cityId, baseRevision, profile, operations} 计算——digest 属宿主契约，不是 SDK 语义。 */
export function gateApplyWorldEdit(city: unknown, baseRevision: number, operations: unknown): GateOutcome {
  const checked = validateCityInstance(city);
  if (!checked.ok) {
    return { ok: false, profile: {}, diagnostics: [{ code: "creator_city_invalid", severity: "error", path: "$",
      message: "City draft failed SDK validation; the world edit is rejected." }] };
  }
  const fallbackProfile = checked.value.profile;
  if (checked.value.revision !== baseRevision) {
    return { ok: false, profile: fallbackProfile, diagnostics: [{ code: "creator_validation_scope_mismatch",
      severity: "error", path: "baseRevision", message: "The preview baseRevision does not match the city draft revision." }] };
  }
  const merged = applyCityWorldOperations(checked.value.profile, operations);
  return { ok: merged !== null, profile: merged ?? fallbackProfile };
}

/** creator.city.create 的创建前校验（与 main.tsx creator.city.create 分支一致：
 * cityId 用占位标识、revision 0——只验 name/seed/profile 语义）。 */
export function gateValidateCityCreate(name: unknown, seed: unknown, profile: unknown): GateOutcome {
  const checked = validateCityInstance({ schemaVersion: 1, cityId: "city-validation", revision: 0,
    name, seed, profile });
  return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
}

// ── 直连校验器（E5 任务面：四个入口逐一可用）──

export function gateValidateVehicleProfile(value: unknown): GateOutcome {
  const checked = validateVehicleProfileV1(value);
  return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
}

export function gateValidateSceneDraft(value: unknown): GateOutcome {
  const checked = validateSceneDraft(value);
  return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
}

export function gateValidateMiniGamePack(value: unknown): GateOutcome {
  const checked = validateMiniGamePack(value);
  return { ok: checked.ok, diagnostics: checked.ok ? [] : checked.diagnostics };
}

export function gateValidateWorldParameters(capability: unknown, input: unknown): GateOutcome {
  const checked = validateWorldParametersV1(capability as Parameters<typeof validateWorldParametersV1>[0], input);
  return { ok: checked.ok, value: checked.ok ? checked.value : null, diagnostics: checked.ok ? [] : checked.diagnostics };
}

/** 入口注册表：invoke 按 entry 名分发；未知入口显式判负（不静默）。 */
type GateHandler = (args: unknown) => GateOutcome;
// 参数约定：每个入口一律收「命名参数对象」，避免「有的入口收裸值、有的收包装」
// 造成的桥协议歧义（这正是首版实现踩过的坑：Rust 侧传 {raw} 而 JS 侧按裸值读）。
const rawOf = (args: unknown): unknown => (args as { raw?: unknown }).raw;
const registry: Record<string, GateHandler> = {
  "vehicle.validate": args => gateValidateVehicle(rawOf(args)),
  "vehicle.estimate": args => gateEstimateVehicle(rawOf(args)),
  "vehicle.profile.validate": args => gateValidateVehicleProfile(rawOf(args)),
  "city.world.apply": args => {
    const input = args as { city: unknown; baseRevision: unknown; operations: unknown };
    return gateApplyWorldEdit(input.city, Number(input.baseRevision), input.operations);
  },
  "city.create.validate": args => {
    const input = args as { name: unknown; seed: unknown; profile: unknown };
    return gateValidateCityCreate(input.name, input.seed, input.profile);
  },
  "scene.draft.validate": args => gateValidateSceneDraft(rawOf(args)),
  "game.pack.validate": args => gateValidateMiniGamePack(rawOf(args)),
  "world.parameters.validate": args => {
    const input = args as { capability: unknown; input: unknown };
    return gateValidateWorldParameters(input.capability, input.input);
  },
};

/** 桥面：citySdkGate.version / engine / invoke(entry, argsJson) → JSON 字符串。
 * JSON.parse 失败也按判负处理；返回值恒为字符串（桥协议）。打包成 IIFE 后由
 * 底部的 globalThis 挂载交给 QuickJS；ESM 引入方（向量生成器/锁步测试）直接
 * 具名导入同一对象——两条路径执行的是同一份实现。 */
export const citySdkGate = {
  version: EMBEDDED_GATE_VERSION,
  engine: "quickjs",
  invoke(entry: string, argsJson: string): string {
    const handler = registry[entry];
    if (typeof handler !== "function") {
      return JSON.stringify({ ok: false, diagnostics: [{ code: "embedded_gate_entry_unknown", severity: "error",
        path: "$", message: `Unknown embedded gate entry: ${String(entry).slice(0, 64)}` }] });
    }
    let parsed: unknown;
    try {
      parsed = typeof argsJson === "string" && argsJson.length > 0 ? JSON.parse(argsJson) : {};
    } catch {
      return JSON.stringify({ ok: false, diagnostics: [{ code: "embedded_gate_args_invalid", severity: "error",
        path: "$", message: "Gate arguments are not valid JSON." }] });
    }
    return JSON.stringify(wrap(() => handler(parsed)));
  },
};

(globalThis as unknown as Record<string, unknown>).citySdkGate = citySdkGate;
