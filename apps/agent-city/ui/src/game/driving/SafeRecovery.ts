/** SafeRecovery (Agent B): put a stuck, overlapping or unsupported car back on a legal pose of the SAME
 * frozen world. Pure CPU; no THREE/DOM/host.
 *
 * 为什么不是「推出去」：初始重叠时按碰撞法线把车推开，推的方向取决于最近的那一个固体，常常推进另一个
 * 固体或推下路缘，碰撞层也明令不随机推出（spec §6）。这里是有界的确定性搜索：
 *   - 候选按（位移, 航向变化, 方位角）字典序逐一试，第一个整车合法的位姿就是答案——同一输入永远同一结果；
 *   - 合法 = footprintSupport（整车覆盖、坡度、扭曲、固体）+ 独立验证器 validateStart 都通过；
 *   - 只在请求的区域里找，绝不借机换区域（换区域是非法层跳）；多层区域按请求高度选层；
 *   - 结果绑定世界 revision；提交时 revision 不同或世界已不是当前的，一律拒绝，绝不把旧世界的位姿用到新世界。
 * 找不到就是 unrecoverable，并说明是界内无解还是预算用尽——后者不是「此处无路」的证据。 */
import type { SurfaceRegionsBuild } from "../../engine/surface/surfaceRegions";
import { initialDrivingState, type DrivingState } from "../DrivingSimulation";
import type { CollisionIndex } from "./CollisionIndex";
import { DEFAULT_FOOTPRINT_PARAMS, footprintSupport, type FootprintParams, type VehicleFootprint } from "./surfaceFootprint";
import { SurfaceWorldValidator } from "./SurfaceDrivingWorld";
import { DRIVING_FOOTPRINT } from "./vehicleFootprint";

export const SAFE_RECOVERY_VERSION = 1;

export type RecoveryWorld = Readonly<{
  worldRevision: string; regions: SurfaceRegionsBuild;
  /** Solids the recovered pose must be clear of (structure + scene proxies). Omitted = support only. */
  collision?: CollisionIndex;
  isCurrent: () => boolean;
}>;
export type RecoveryRequest = Readonly<{
  x: number; z: number; heading: number; regionId: string;
  /** Height of the surface the car was on (layer choice in multi-layer regions). */
  y?: number;
}>;
export type RecoveryOptions = Readonly<{
  /** Search radius and spacing (world units). */
  maxDistance?: number; distanceStep?: number;
  /** Heading offsets tried at each position, radians, in this order of preference by |offset|. */
  maxHeadingChange?: number; headingStep?: number;
  /** Also try the reversed heading (turned around) after all forward-ish headings fail at a ring. */
  allowReverse?: boolean;
  maxCandidates?: number;
  /** Extra clearance around the body beyond the footprint margins: a recovered pose merely touch-free
   * (gap ~0) puts the next steering input straight into a grazing contact. */
  clearance?: number;
  footprint?: VehicleFootprint; params?: FootprintParams;
}>;
export type RecoveryResult =
  | Readonly<{ status: "recovered"; worldRevision: string; version: number; state: Readonly<DrivingState>;
      displacement: number; headingChange: number; candidatesTested: number; alreadySafe: boolean }>
  | Readonly<{ status: "unrecoverable"; worldRevision: string; version: number;
      reason: "no-safe-pose-within-bound" | "budget" | "stale-world" | "invalid-input" | "unknown-region"; candidatesTested: number }>;

const DEFAULTS = Object.freeze({ maxDistance: 6, distanceStep: 0.25, maxHeadingChange: Math.PI / 4, headingStep: Math.PI / 24, allowReverse: true, maxCandidates: 20000, clearance: 0.1 });

/** Deterministic bounded search for the nearest legal pose. */
export function findSafePose(world: RecoveryWorld, request: RecoveryRequest, options: RecoveryOptions = {}): RecoveryResult {
  const o = { ...DEFAULTS, ...options };
  const footprint = options.footprint ?? DRIVING_FOOTPRINT; const params = options.params ?? DEFAULT_FOOTPRINT_PARAMS;
  let tested = 0;
  const fail = (reason: Extract<RecoveryResult, { status: "unrecoverable" }>["reason"]): RecoveryResult =>
    Object.freeze({ status: "unrecoverable", worldRevision: world.worldRevision, version: SAFE_RECOVERY_VERSION, reason, candidatesTested: tested });
  if (![request.x, request.z, request.heading].every(Number.isFinite) || (request.y !== undefined && !Number.isFinite(request.y)) ||
    ![o.maxDistance, o.distanceStep, o.maxHeadingChange, o.headingStep, o.clearance].every((n) => Number.isFinite(n) && n >= 0) || !(o.distanceStep > 0) || !(o.headingStep > 0) ||
    !Number.isSafeInteger(o.maxCandidates) || o.maxCandidates < 1) return fail("invalid-input");
  if (!world.isCurrent()) return fail("stale-world");
  if (world.regions.status !== "ready") return fail("invalid-input");
  if (!world.regions.regionById(request.regionId)) return fail("unknown-region");
  const validator = new SurfaceWorldValidator(world.regions, () => 0, footprint, params, world.collision);
  // The clearance check inflates the body; the returned pose's support is fitted with the normal params.
  const clear = Object.freeze({ ...params, lateralMargin: params.lateralMargin + o.clearance, longitudinalMargin: params.longitudinalMargin + o.clearance });
  const headings: number[] = [0];
  for (let k = 1; k * o.headingStep <= o.maxHeadingChange + 1e-12; k++) headings.push(k * o.headingStep, -k * o.headingStep);
  if (o.allowReverse) headings.push(Math.PI);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const tryPose = (x: number, z: number, dHeading: number): RecoveryResult | null => {
    if (++tested > o.maxCandidates) throw new BudgetStop();
    const heading = wrap(request.heading + dHeading);
    if (o.clearance > 0 && !footprintSupport(world.regions, { x, z, heading, y: request.y }, request.regionId, footprint, clear, world.collision).ok) return null;
    const support = footprintSupport(world.regions, { x, z, heading, y: request.y }, request.regionId, footprint, params, world.collision);
    if (!support.ok) return null;
    const state: DrivingState = { ...initialDrivingState(x, z, heading, request.regionId), y: support.y, pitch: support.pitch, roll: support.roll };
    if (validator.validateStart(state) !== "valid") return null;
    const displacement = Math.hypot(x - request.x, z - request.z);
    return Object.freeze({ status: "recovered", worldRevision: world.worldRevision, version: SAFE_RECOVERY_VERSION, state: Object.freeze(state),
      displacement, headingChange: Math.abs(wrap(dHeading)), candidatesTested: tested, alreadySafe: displacement === 0 && dHeading === 0 });
  };
  try {
    // Ring 0 (the requested position), then rings of growing radius sampled every distanceStep of arc.
    for (let ring = 0; ring * o.distanceStep <= o.maxDistance + 1e-12; ring++) {
      const r = ring * o.distanceStep;
      const n = ring === 0 ? 1 : Math.max(8, Math.ceil((2 * Math.PI * r) / o.distanceStep));
      // Within a ring, prefer the smallest heading change, then the angle order (stable).
      for (const dHeading of headings) for (let k = 0; k < n; k++) {
        const angle = request.heading + (2 * Math.PI * k) / n;
        const found = tryPose(request.x + Math.cos(angle) * r, request.z + Math.sin(angle) * r, dHeading);
        if (found) return world.isCurrent() ? found : fail("stale-world");
      }
    }
  } catch (error) {
    if (error instanceof BudgetStop) return fail("budget");
    throw error;
  }
  return fail("no-safe-pose-within-bound");
}
class BudgetStop extends Error {}

/** Apply a recovery only to the world it was computed on, while that world is still current. */
export function commitRecovery(result: RecoveryResult, world: RecoveryWorld): Readonly<DrivingState> | null {
  if (result.status !== "recovered" || result.worldRevision !== world.worldRevision || !world.isCurrent()) return null;
  return result.state;
}
