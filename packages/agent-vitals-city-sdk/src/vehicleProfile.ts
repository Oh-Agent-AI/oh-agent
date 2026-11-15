/**
 * Vehicle Profile V1（2026-11-15 飞行泛化切片）：通用飞行游戏类型
 * （creator.flight-checkpoint-v1 / city-flight-generic）的载具契约。
 *
 * 定位：扑翼（ornithopter）只是 `flightModel: "flapping"` 的一种 preset，
 * 不再是模板名。profile 声明 模型 + 物理 + 边界 + 相机 四组有界数据；
 * 严格 exact-keys 校验、数值有限、无脚本/字符串注入面。所有字段被
 * `city-flight-generic` 运行时的气动/相机参数化直接消费（见
 * apps/agent-city/ui/src/game/FlightSimulation.ts 的 vehicleFlightParams）。
 *
 * `modelAssetId` 只接受项目资产引用（assetId 形式的稳定标识符）；为 null 时
 * 运行时使用程序化占位模型（按 bounds 缩放），本切片不加载任何 GLB。
 */
import type { DiagnosticV1, Result } from "./types";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .·、（）()\-]{0,126}$/u;

export type VehicleFlightModelV1 = "fixed-wing" | "flapping" | "vtol";

export type VehicleProfileBoundsV1 = Readonly<{ halfLengthM: number; halfWidthM: number; halfHeightM: number }>;

export type VehicleProfileV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  label: string;
  /** 项目资产引用（assetId）；null = 程序化占位模型（按 bounds 缩放）。 */
  modelAssetId: string | null;
  flightModel: VehicleFlightModelV1;
  physics: Readonly<Record<string, number>>;
  bounds: VehicleProfileBoundsV1;
  camera: Readonly<Record<string, number>>;
}>;

export const VEHICLE_PROFILE_LIMITS_V1 = Object.freeze({
  maxIdLength: 128,
  maxLabelLength: 128,
});

/**
 * 逐字段上下界（测试钉住）。上界取「三种气动模型都物理可用」的宽游戏域：
 * 160 m/s（576 km/h）是固定翼/VTOL 的高性能上限，扑翼 preset 远低于它（风格化域）；
 * 单个 profile 还要过跨字段物理校验（翼载荷/推重比），不允许任意拼凑。
 */
export const VEHICLE_PHYSICS_BOUNDS_V1 = Object.freeze({
  massKg: [40, 20000],
  wingAreaM2: [0.5, 400],
  thrustN: [80, 400000],
  maxSpeedMps: [5, 160],
  dragCoefficient: [0.01, 1.5],
  turnRateRps: [0.15, 2.5],
  climbRateMps: [1, 40],
  sinkRateMps: [0.5, 40],
  flapFrequencyHz: [0.3, 8],
  flapAmplitudeRad: [0.15, 1.6],
  hoverClimbRateMps: [0.5, 30],
} as const) satisfies Record<string, readonly [number, number]>;

/** 相机参数界（米/度；运行时按 1 单位 = 2 米换算，见 engine/worldScale.ts）。 */
export const VEHICLE_CAMERA_BOUNDS_V1 = Object.freeze({
  followDistanceM: [8, 80],
  heightOffsetM: [2, 40],
  fovDeg: [40, 100],
} as const) satisfies Record<string, readonly [number, number]>;

/** 包围半尺寸界（米）：既覆盖小型扑翼机也覆盖游戏内大型载具，同时把
 * 碰撞球半径/追尾距离保持在可玩范围。 */
export const VEHICLE_BOUNDS_LIMITS_V1 = Object.freeze({
  halfExtentM: [0.5, 20],
} as const) satisfies Record<string, readonly [number, number]>;

/**
 * 跨字段物理可行性界（单一来源，测试钉住）：
 * - 翼载荷 mass/wingArea ∈ [1, 120] kg/m²：低于 1 视为翼面远大于质量的无意义输入，
 *   高于 120 的机翼无法在任何一种气动模型下维持可控飞行。
 * - 推重比（加速度）thrust/mass ∈ [1, 30] m/s²：下界保证 profile 至少能加速/抬升
 *   自身质量（0.1 g），上界是游戏风格化的机动上限。
 */
export const VEHICLE_PHYSICS_RATIOS_V1 = Object.freeze({
  minWingLoadingKgPerM2: 1,
  maxWingLoadingKgPerM2: 120,
  minThrustAccelMs2: 1,
  maxThrustAccelMs2: 30,
} as const);

/** 各气动模型的物理键集合（exact-keys）：共享键 + 模型专属键。未知键、
 * 字符串值、缺键一律拒绝——物理参数没有可选面。 */
export const VEHICLE_PHYSICS_KEYS_V1: Readonly<Record<VehicleFlightModelV1, readonly string[]>> = Object.freeze({
  "fixed-wing": Object.freeze(["massKg", "wingAreaM2", "thrustN", "maxSpeedMps", "dragCoefficient", "turnRateRps", "climbRateMps", "sinkRateMps"]),
  "flapping": Object.freeze(["massKg", "wingAreaM2", "thrustN", "maxSpeedMps", "dragCoefficient", "turnRateRps", "climbRateMps", "sinkRateMps", "flapFrequencyHz", "flapAmplitudeRad"]),
  "vtol": Object.freeze(["massKg", "wingAreaM2", "thrustN", "maxSpeedMps", "dragCoefficient", "turnRateRps", "climbRateMps", "sinkRateMps", "hoverClimbRateMps"]),
});

const VEHICLE_CAMERA_KEYS_V1 = Object.freeze(["followDistanceM", "heightOffsetM", "fovDeg"]);
const BOUND_KEYS_V1 = Object.freeze(["halfLengthM", "halfWidthM", "halfHeightM"]);

const error = (code: string, path: string, message: string): DiagnosticV1 => ({ code, severity: "error", path, message });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 校验并深度冻结一份 Vehicle Profile V1。失败时返回结构化诊断（首个 error 即拒绝原因）。 */
export function validateVehicleProfileV1(input: unknown): Result<VehicleProfileV1> {
  const diagnostics: DiagnosticV1[] = [];
  if (!object(input)) return { ok: false, diagnostics: [error("vehicle_profile_invalid", "$", "Vehicle profile must be an object.")] };
  if (!exactKeys(input, ["schemaVersion", "id", "label", "modelAssetId", "flightModel", "physics", "bounds", "camera"])) {
    diagnostics.push(error("vehicle_profile_invalid", "$", "Vehicle profile contains missing or unsupported fields."));
  }
  if (input.schemaVersion !== 1) diagnostics.push(error("vehicle_profile_unsupported", "schemaVersion", "Only vehicle profile schema version 1 is supported."));
  if (typeof input.id !== "string" || !IDENTIFIER.test(input.id)) diagnostics.push(error("vehicle_profile_invalid", "id", "Vehicle profile id must be a stable ASCII identifier."));
  if (typeof input.label !== "string" || !LABEL.test(input.label)) diagnostics.push(error("vehicle_profile_invalid", "label", "Label must be 1..128 characters of plain display text."));
  if (input.modelAssetId !== null && (typeof input.modelAssetId !== "string" || !IDENTIFIER.test(input.modelAssetId))) {
    diagnostics.push(error("vehicle_profile_invalid", "modelAssetId", "modelAssetId must be null (procedural placeholder) or a project asset id."));
  }
  let physicsKeys: readonly string[] = [];
  if (typeof input.flightModel !== "string" || !VEHICLE_PHYSICS_KEYS_V1.hasOwnProperty(input.flightModel)) {
    diagnostics.push(error("vehicle_profile_invalid", "flightModel", "flightModel must be fixed-wing, flapping or vtol."));
  } else {
    physicsKeys = VEHICLE_PHYSICS_KEYS_V1[input.flightModel as VehicleFlightModelV1];
  }
  const physics = validateNumberRecord(input.physics, physicsKeys, VEHICLE_PHYSICS_BOUNDS_V1, "physics", diagnostics);
  const camera = validateNumberRecord(input.camera, VEHICLE_CAMERA_KEYS_V1, VEHICLE_CAMERA_BOUNDS_V1, "camera", diagnostics);
  let bounds: VehicleProfileBoundsV1 | null = null;
  if (!object(input.bounds) || !exactKeys(input.bounds, BOUND_KEYS_V1)) {
    diagnostics.push(error("vehicle_profile_invalid", "bounds", "Bounds must declare exactly halfLengthM, halfWidthM, halfHeightM."));
  } else {
    const half: Record<string, number> = {};
    for (const key of BOUND_KEYS_V1) {
      const value = input.bounds[key];
      const [min, max] = VEHICLE_BOUNDS_LIMITS_V1.halfExtentM;
      if (!finite(value) || (value as number) < min || (value as number) > max) {
        diagnostics.push(error("vehicle_profile_out_of_bounds", `bounds.${key}`, `Half extent must be a finite number in [${min}, ${max}] m.`));
      } else {
        half[key] = value as number;
      }
    }
    if (Object.keys(half).length === BOUND_KEYS_V1.length) bounds = Object.freeze(half) as VehicleProfileBoundsV1;
  }
  if (physics) validateRatios(physics, diagnostics);
  if (diagnostics.length || !physics || !camera || !bounds) return { ok: false, diagnostics };
  return {
    ok: true,
    diagnostics: [],
    value: deepFreeze({
      schemaVersion: 1,
      id: input.id as string,
      label: input.label as string,
      modelAssetId: input.modelAssetId as string | null,
      flightModel: input.flightModel as VehicleFlightModelV1,
      physics,
      bounds,
      camera,
    }),
  };
}

/** 跨字段物理可行性：翼载荷与推重比必须落在 VEHICLE_PHYSICS_RATIOS_V1 内。 */
function validateRatios(physics: Readonly<Record<string, number>>, diagnostics: DiagnosticV1[]): void {
  const loading = physics.massKg / physics.wingAreaM2;
  if (!Number.isFinite(loading) || loading < VEHICLE_PHYSICS_RATIOS_V1.minWingLoadingKgPerM2 || loading > VEHICLE_PHYSICS_RATIOS_V1.maxWingLoadingKgPerM2) {
    diagnostics.push(error("vehicle_profile_unphysical", "physics.wingAreaM2",
      `Wing loading ${loading.toFixed(3)} kg/m² is outside [${VEHICLE_PHYSICS_RATIOS_V1.minWingLoadingKgPerM2}, ${VEHICLE_PHYSICS_RATIOS_V1.maxWingLoadingKgPerM2}].`));
  }
  const accel = physics.thrustN / physics.massKg;
  if (!Number.isFinite(accel) || accel < VEHICLE_PHYSICS_RATIOS_V1.minThrustAccelMs2 || accel > VEHICLE_PHYSICS_RATIOS_V1.maxThrustAccelMs2) {
    diagnostics.push(error("vehicle_profile_unphysical", "physics.thrustN",
      `Thrust-to-mass ${accel.toFixed(3)} m/s² is outside [${VEHICLE_PHYSICS_RATIOS_V1.minThrustAccelMs2}, ${VEHICLE_PHYSICS_RATIOS_V1.maxThrustAccelMs2}].`));
  }
}

function validateNumberRecord(
  raw: unknown,
  allowed: readonly string[],
  bounds: Readonly<Record<string, readonly [number, number]>>,
  path: string,
  diagnostics: DiagnosticV1[],
): Readonly<Record<string, number>> | null {
  if (!object(raw)) {
    diagnostics.push(error("vehicle_profile_invalid", path, `${path} must be an object of finite numbers.`));
    return null;
  }
  if (allowed.length === 0 || !exactKeys(raw, allowed)) {
    diagnostics.push(error("vehicle_profile_invalid", path,
      `${path} must declare exactly [${allowed.length ? allowed.join(", ") : "keys matching a supported flight model"}].`));
    return null;
  }
  const output: Record<string, number> = {};
  for (const key of allowed) {
    const value = raw[key];
    if (typeof value !== "number") {
      diagnostics.push(error("vehicle_profile_invalid", `${path}.${key}`, "Must be a number (strings and objects are rejected; no injection surface)."));
      continue;
    }
    const [min, max] = bounds[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      diagnostics.push(error("vehicle_profile_out_of_bounds", `${path}.${key}`, `Must be a finite number in [${min}, ${max}].`));
      continue;
    }
    output[key] = value;
  }
  if (Object.keys(output).length !== allowed.length) return null;
  return Object.freeze(output);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * `modelAssetId: null` 时运行时使用程序化占位模型；camera 未在 MCP define 面暴露，
 * 由该确定性默认公式从 bounds 推导（宿主 Rust 与 Studio 适配器共用同一组常量，
 * 常量经 scripts/generate-creator-capabilities.mjs 导出为 assets/creator/vehicles.json
 * ——Rust 侧不硬编码公式，直接消费生成产物）。
 */
export const VEHICLE_CAMERA_DEFAULTS_V1 = Object.freeze({
  followDistanceFactor: 6.5,
  followDistanceMinM: 8,
  followDistanceMaxM: 80,
  heightOffsetFactor: 2.6,
  heightOffsetMinM: 2,
  heightOffsetMaxM: 40,
  fovDeg: 55,
} as const);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** bounds → 默认相机（MCP define/preview 面不接收 camera；派生是确定性的纯函数）。 */
export function defaultVehicleCameraV1(bounds: VehicleProfileBoundsV1): Readonly<Record<string, number>> {
  const maxHalf = Math.max(bounds.halfLengthM, bounds.halfWidthM, bounds.halfHeightM);
  return Object.freeze({
    followDistanceM: clamp(maxHalf * VEHICLE_CAMERA_DEFAULTS_V1.followDistanceFactor, VEHICLE_CAMERA_DEFAULTS_V1.followDistanceMinM, VEHICLE_CAMERA_DEFAULTS_V1.followDistanceMaxM),
    heightOffsetM: clamp(maxHalf * VEHICLE_CAMERA_DEFAULTS_V1.heightOffsetFactor, VEHICLE_CAMERA_DEFAULTS_V1.heightOffsetMinM, VEHICLE_CAMERA_DEFAULTS_V1.heightOffsetMaxM),
    fovDeg: VEHICLE_CAMERA_DEFAULTS_V1.fovDeg,
  });
}

/**
 * 内置 preset：扑翼机（ornithopter）。扑翼降级为 preset 的锚点——飞行原型入口
 * （creator.flight-ornithopter-prototype-v1）由本 preset 驱动。
 *
 * 量级说明（留档）：按 City 比例尺（1 单位 = 2 米，城区对角 ≈ 4–5 km）游戏化调校，
 * 不是真实扑翼机数据——真实扑翼机在这个世界里巡航一次要几十分钟。结构参数
 * （质量/翼面/推力/扑动频率幅度）仍保持同量级物理关系：翼载荷 ≈ 18.9 kg/m²、
 * 推重比 ≈ 29.4 m/s²（受 VEHICLE_PHYSICS_RATIOS_V1 约束），扑动 2.4 Hz × 1.1 rad。
 */
export const ORNITHOPTER_VEHICLE_PRESET_V1: VehicleProfileV1 = Object.freeze({
  schemaVersion: 1,
  id: "vehicle.ornithopter",
  label: "扑翼机",
  modelAssetId: null,
  flightModel: "flapping",
  physics: Object.freeze({
    massKg: 340,
    wingAreaM2: 18,
    thrustN: 10000,
    maxSpeedMps: 120,
    dragCoefficient: 0.1,
    turnRateRps: 0.9,
    climbRateMps: 34,
    sinkRateMps: 26,
    flapFrequencyHz: 2.4,
    flapAmplitudeRad: 1.1,
  }),
  bounds: Object.freeze({ halfLengthM: 3.6, halfWidthM: 4.8, halfHeightM: 1.4 }),
  camera: Object.freeze({ followDistanceM: 26, heightOffsetM: 12, fovDeg: 52 }),
});

/** 内置 preset：固定翼轻型机（对照 preset，与扑翼走不同气动分支）。 */
export const FIXED_WING_VEHICLE_PRESET_V1: VehicleProfileV1 = Object.freeze({
  schemaVersion: 1,
  id: "vehicle.fixed-wing-light",
  label: "固定翼轻型机",
  modelAssetId: null,
  flightModel: "fixed-wing",
  physics: Object.freeze({
    massKg: 620,
    wingAreaM2: 16,
    thrustN: 9000,
    maxSpeedMps: 130,
    dragCoefficient: 0.06,
    turnRateRps: 1.05,
    climbRateMps: 26,
    sinkRateMps: 20,
  }),
  bounds: Object.freeze({ halfLengthM: 4.5, halfWidthM: 5.5, halfHeightM: 1.5 }),
  camera: Object.freeze({ followDistanceM: 30, heightOffsetM: 13, fovDeg: 55 }),
});

/**
 * 性能预估推导（单一来源）：巡航分频等物理域派生只在这里定义。引擎
 * （FlightSimulation.vehicleFlightParams）与宿主预览（Rust 按生成产物里的
 * performanceDerivation/向量执行）都消费本节，禁止在两侧重复实现启发式。
 */
export const VEHICLE_PERFORMANCE_DERIVATION_V1 = Object.freeze({ cruiseSpeedDivisor: 1.8 });

export type VehiclePerformanceEstimateV1 = Readonly<{
  cruiseSpeedMps: number;
  maxSpeedMps: number;
  thrustAccelMs2: number;
  wingLoadingKgPerM2: number;
  turnRateRps: number;
  climbRateMps: number;
  /** 扑翼专属；其它气动模型为 null（exact-keys 下扑翼必有该键）。 */
  flapFrequencyHz: number | null;
}>;

/** 物理域（m/s、m/s²、kg/m²）性能预估：Creator 预览向调用方展示的唯一权威值。
 * 引擎在单位换算与操纵调校（accel/brake 增益、平滑）之外不得另设启发式。 */
export function estimateVehiclePerformanceV1(profile: VehicleProfileV1): VehiclePerformanceEstimateV1 {
  const physics = profile.physics;
  return Object.freeze({
    cruiseSpeedMps: physics.maxSpeedMps / VEHICLE_PERFORMANCE_DERIVATION_V1.cruiseSpeedDivisor,
    maxSpeedMps: physics.maxSpeedMps,
    thrustAccelMs2: physics.thrustN / physics.massKg,
    wingLoadingKgPerM2: physics.massKg / physics.wingAreaM2,
    turnRateRps: physics.turnRateRps,
    climbRateMps: physics.climbRateMps,
    flapFrequencyHz: profile.flightModel === "flapping" ? (physics.flapFrequencyHz ?? 0) : null,
  });
}

/**
 * 车辆目录投影（2026-11-15 泛化切片）：MCP `creator_vehicle_list` 与宿主结构上限
 * 的单一来源。preset 是完整可用的 VehicleProfileV1（含确定性默认相机）；bounds/
 * ratios 表与 validateVehicleProfileV1 逐字段同源（同一份常量）。performanceVectors
 * 由本模块的 estimateVehiclePerformanceV1 对各 preset 计算得出——Rust 侧用同一份
 * 向量做跨语言锁步（宿主推导与 SDK 逐位一致才允许发布预览展示性能）。
 * 由生成器导出到 assets/creator/vehicles.json；Rust include_str! 消费，不改内容。
 */
export const CREATOR_VEHICLE_CATALOG_V1 = Object.freeze({
  schemaVersion: 1 as const,
  presets: Object.freeze([ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1]),
  flightModels: Object.freeze(["fixed-wing", "flapping", "vtol"] as const),
  physicsKeys: VEHICLE_PHYSICS_KEYS_V1,
  physicsBounds: VEHICLE_PHYSICS_BOUNDS_V1,
  cameraBounds: VEHICLE_CAMERA_BOUNDS_V1,
  boundsLimits: VEHICLE_BOUNDS_LIMITS_V1,
  physicsRatios: VEHICLE_PHYSICS_RATIOS_V1,
  cameraDefaults: VEHICLE_CAMERA_DEFAULTS_V1,
  performanceDerivation: VEHICLE_PERFORMANCE_DERIVATION_V1,
  performanceVectors: Object.freeze([ORNITHOPTER_VEHICLE_PRESET_V1, FIXED_WING_VEHICLE_PRESET_V1].map(preset => Object.freeze({
    id: preset.id,
    estimate: estimateVehiclePerformanceV1(preset),
  }))),
});
