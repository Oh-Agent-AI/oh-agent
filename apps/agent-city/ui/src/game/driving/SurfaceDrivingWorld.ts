/** Surface-region adapters for the existing kernel contracts.
 *
 * SurfaceDrivingEnvironment: DrivingEnvironment.move() 用 validateMotion 判整步，通不过就整步拒绝
 * （与原型 DrivingWorld 相同语义；TOI/切线滑动是 Agent C 的 DrivingCollision）。
 * SurfaceWorldValidator: AuditWorldValidator 的独立复核——不信 kernel 报告的 y/surfaceId/blocked，
 * 而是对实际位姿变化重新做整车覆盖与连续运动检查。两者共享 surface 事实（spec §11.1 允许），
 * 所以路面编译本身的错误要靠 A 批次的渲染几何对照兜底，不能靠这两个互相印证。
 *
 * 默认仅覆盖支撑面；可选绑定冻结结构碰撞，不覆盖渲染建筑/地标。区域 id 即 surfaceId；
 * 已验证 portal 可以在同一区域内连接高度层；区域切换仍拒绝。 */
import type { SurfaceRegionsBuild } from "../../engine/surface/surfaceRegions";
import type { DrivingEnvironment, DrivingMotion, DrivingMoveResult, DrivingState } from "../DrivingSimulation";
import type { KernelStep } from "./DrivingKernel";
import type { AuditWorldValidator, StepValidation } from "./audit/contracts";
import { DEFAULT_FOOTPRINT_PARAMS, footprintSupport, mountableQueryOf, validateMotion, type FootprintParams, type VehicleFootprint } from "./surfaceFootprint";
import { DRIVING_FOOTPRINT } from "./vehicleFootprint";
import type { CollisionDimensions, CollisionIndex, CollisionPose } from "./CollisionIndex";
import type { MountablePolicy } from "./staticSolidContracts";

/** Height agreement between a reported state and the independently fitted support. */
export const SUPPORT_HEIGHT_TOLERANCE = 1e-6;

/** A structure-only lease. The owning host must revoke isCurrent when its world changes. */
export type StructureCollisionBinding = Readonly<{
  coverage: "structures-only"; surfaceRevision: string; worldRevision: string;
  index: CollisionIndex; dimensions: CollisionDimensions;
  /** Along the fitted body up axis from support centre to collider centre. */
  centerHeight: number; isCurrent: () => boolean;
}>;
export function createStructureCollisionBinding(input: Omit<StructureCollisionBinding, "coverage">): StructureCollisionBinding {
  if (!input.surfaceRevision || !input.worldRevision || input.index.revision !== input.worldRevision ||
    !Number.isFinite(input.centerHeight) || input.centerHeight < 0 ||
    ![input.dimensions.halfLength,input.dimensions.halfWidth,input.dimensions.halfHeight].every(n=>Number.isFinite(n)&&n>0) ||
    typeof input.isCurrent !== "function") throw new Error("invalid-structure-collision-binding");
  return Object.freeze({ ...input, coverage: "structures-only", dimensions: Object.freeze({ ...input.dimensions }) });
}
function collisionCurrent(regions: SurfaceRegionsBuild, binding?: StructureCollisionBinding | CollisionIndex): boolean {
  return !isBinding(binding) || (regions.status === "ready" && regions.revision === binding.surfaceRevision &&
    binding.index.revision === binding.worldRevision && binding.isCurrent());
}
function isBinding(value: StructureCollisionBinding | CollisionIndex | undefined): value is StructureCollisionBinding { return !!value && "index" in value; }
function collisionPose(pose: Readonly<{ x: number; z: number; heading: number }>, support: Readonly<{ y: number; pitch: number; roll: number }>, centerHeight: number): CollisionPose {
  const c=Math.cos(pose.heading),s=Math.sin(pose.heading),sp=Math.sin(support.pitch),cp=Math.cos(support.pitch),cr=Math.cos(support.roll),sr=Math.sin(support.roll);
  return { x:pose.x+(-c*sp*cr+s*sr)*centerHeight, y:support.y+cp*cr*centerHeight,
    z:pose.z+(-s*sp*cr-c*sr)*centerHeight,heading:pose.heading,pitch:support.pitch,roll:support.roll };
}
function clearPose(binding: StructureCollisionBinding | CollisionIndex | undefined, pose: Readonly<{ x: number; z: number; heading: number }>, support: Readonly<{ y: number; pitch: number; roll: number }>, mountablePolicy:MountablePolicy): boolean {
  return !isBinding(binding) || binding.index.overlap(collisionPose(pose,support,binding.centerHeight),binding.dimensions,mountablePolicy).status === "clear";
}

export class SurfaceDrivingEnvironment implements DrivingEnvironment {
  private readonly mountable: ReturnType<typeof mountableQueryOf>;
  constructor(private readonly regions: SurfaceRegionsBuild,
    private readonly footprint: VehicleFootprint = DRIVING_FOOTPRINT,
    private readonly params: FootprintParams = DEFAULT_FOOTPRINT_PARAMS,
    private readonly collision?: StructureCollisionBinding | CollisionIndex,
    private readonly mountablePolicy:MountablePolicy="disabled") {
    if (regions.status !== "ready") throw new Error("surface-regions-unresolved");
    if (!collisionCurrent(regions,collision)) throw new Error("collision-revision-mismatch-or-stale");
    if(mountablePolicy!=="disabled"&&mountablePolicy!=="gameplay")throw new Error("invalid-surface-driving-policy");
    this.mountable=mountablePolicy==="gameplay"?mountableQueryOf(collision ? (isBinding(collision)?collision.index.solids():collision.solids()) : []):null;
  }
  move(previous: DrivingState, desired: DrivingMotion): DrivingMoveResult {
    const stopped = (reason: string): DrivingMoveResult => ({ x:previous.x,y:previous.y,z:previous.z,heading:previous.heading,pitch:previous.pitch,roll:previous.roll,surfaceId:previous.surfaceId,blocked:true,reason });
    if (!collisionCurrent(this.regions,this.collision)) return stopped("stale-structure-collision");
    const result = validateMotion(this.regions, previous, desired, previous.surfaceId, this.footprint, this.params,isBinding(this.collision) ? undefined : this.collision,this.mountable??undefined);
    if (!result.ok) {
      return { x: previous.x, y: previous.y, z: previous.z, heading: previous.heading, pitch: previous.pitch, roll: previous.roll,
        surfaceId: previous.surfaceId, blocked: true, reason: `${result.reason}:${result.detail}` };
    }
    const s = result.support;
    if (isBinding(this.collision)) {
      const start=footprintSupport(this.regions,previous,previous.surfaceId,this.footprint,this.params,undefined,this.mountable??undefined);
      if (!start.ok || Math.abs(start.y-previous.y)>SUPPORT_HEIGHT_TOLERANCE) return stopped("invalid-start-support");
      const checked=this.collision.index.sweep(collisionPose(previous,start,this.collision.centerHeight),collisionPose(desired,s,this.collision.centerHeight),this.collision.dimensions,this.mountablePolicy);
      if (checked.status !== "clear") return stopped(`structure-collision:${checked.status}:${checked.reason}`);
      if (!collisionCurrent(this.regions,this.collision)) return stopped("stale-structure-collision");
    }
    return { x: desired.x, z: desired.z, heading: desired.heading, y: s.y, pitch: s.pitch, roll: s.roll, surfaceId: s.regionId, blocked: false };
  }
  /** Spawn/reset entry: a pose is legal only with an explicit region id; no "nearest surface". */
  /** Layer-scoped region lookup for spawn validation; null when not drivable on that layer. */
  regionAt(x: number, z: number, layerId: string): string | null {
    if (this.regions.status !== "ready") return null;
    const state = this.regions.classify(x, z, layerId);
    return state.status === "drivable" ? state.regionId : null;
  }
  place(x: number, z: number, heading: number, regionId: string, y?: number): Readonly<{ y: number; pitch: number; roll: number }> | null {
    if (!collisionCurrent(this.regions,this.collision)) return null;
    const pose={x,z,heading,y};
    const support = footprintSupport(this.regions, pose, regionId, this.footprint, this.params,isBinding(this.collision) ? undefined : this.collision,this.mountable??undefined);
    return support.ok && clearPose(this.collision,pose,support,this.mountablePolicy) && collisionCurrent(this.regions,this.collision)
      ? Object.freeze({ y: support.y, pitch: support.pitch, roll: support.roll }) : null;
  }
}

export class SurfaceWorldValidator implements AuditWorldValidator {
  constructor(private readonly regions: SurfaceRegionsBuild,
    /** Corridor progress is case-specific (planner/corridor); never wheel distance. */
    private readonly corridorProgress: (state: Readonly<DrivingState>) => number,
    private readonly footprint: VehicleFootprint = DRIVING_FOOTPRINT,
    private readonly params: FootprintParams = DEFAULT_FOOTPRINT_PARAMS,
    private readonly collision?: StructureCollisionBinding | CollisionIndex,
    private readonly mountablePolicy:MountablePolicy="disabled") {
    if (regions.status !== "ready") throw new Error("surface-regions-unresolved");
    if (!collisionCurrent(regions,collision)) throw new Error("collision-revision-mismatch-or-stale");
    if(mountablePolicy!=="disabled"&&mountablePolicy!=="gameplay")throw new Error("invalid-surface-driving-policy");
    this.mountable=mountablePolicy==="gameplay"?mountableQueryOf(collision ? (isBinding(collision)?collision.index.solids():collision.solids()) : []):null;
  }
  private readonly mountable:ReturnType<typeof mountableQueryOf>;
  validateStart(state: Readonly<DrivingState>): StepValidation {
    if (!collisionCurrent(this.regions,this.collision)) return "simulation-invalid";
    const support = footprintSupport(this.regions, state, state.surfaceId, this.footprint, this.params,isBinding(this.collision) ? undefined : this.collision,this.mountable??undefined);
    if (!support.ok) return "route-deviation";
    return Math.abs(support.y - state.y) <= SUPPORT_HEIGHT_TOLERANCE && clearPose(this.collision,state,support,this.mountablePolicy) && collisionCurrent(this.regions,this.collision) ? "valid" : "simulation-invalid";
  }
  validate(previous: Readonly<DrivingState>, next: KernelStep): StepValidation {
    const state = next.state;
    // Query failure is simulation uncertainty, never physical-road evidence.
    if (next.motion.reason?.startsWith("structure-collision:unresolved:")) return "simulation-invalid";
    if (!collisionCurrent(this.regions,this.collision)) return "simulation-invalid";
    // Validated portals retain their region ID; an unrelated region jump remains invalid.
    if (state.surfaceId !== previous.surfaceId) return "simulation-invalid";
    const moved = state.x !== previous.x || state.z !== previous.z || state.heading !== previous.heading;
    if (next.motion.blocked && moved) return "simulation-invalid";
    const result = validateMotion(this.regions, previous, state, previous.surfaceId, this.footprint, this.params,isBinding(this.collision) ? undefined : this.collision,this.mountable??undefined);
    // The kernel accepted a motion the independent check rejects: penetration through a curb,
    // island or gap is a simulation defect, never a pass and never "road blocked".
    if (!result.ok) return "simulation-invalid";
    if (isBinding(this.collision)) {
      const start=footprintSupport(this.regions,previous,previous.surfaceId,this.footprint,this.params,undefined,this.mountable??undefined);
      if (!start.ok || Math.abs(start.y-previous.y)>SUPPORT_HEIGHT_TOLERANCE) return "simulation-invalid";
      const checked=this.collision.index.sweep(collisionPose(previous,start,this.collision.centerHeight),collisionPose(state,result.support,this.collision.centerHeight),this.collision.dimensions,this.mountablePolicy);
      if (checked.status !== "clear" || !collisionCurrent(this.regions,this.collision)) return "simulation-invalid";
    }
    return Math.abs(result.support.y - state.y) <= SUPPORT_HEIGHT_TOLERANCE ? "valid" : "simulation-invalid";
  }
  progress(state: Readonly<DrivingState>): number { return this.corridorProgress(state); }
}

/** Arc-length progress of the closest point on a polyline (stable tie: first segment). */
export function polylineProgress(points: readonly Readonly<{ x: number; z: number }>[]): (state: Readonly<{ x: number; z: number }>) => number {
  if (points.length < 2 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))) throw new Error("invalid-progress-polyline");
  const frozen = points.map((p) => ({ x: p.x, z: p.z }));
  return (state) => {
    let best = Infinity; let progress = NaN; let along = 0;
    for (let i = 1; i < frozen.length; i++) {
      const a = frozen[i - 1]; const b = frozen[i];
      const dx = b.x - a.x; const dz = b.z - a.z; const ll = dx * dx + dz * dz; const len = Math.sqrt(ll);
      const t = ll === 0 ? 0 : Math.max(0, Math.min(1, ((state.x - a.x) * dx + (state.z - a.z) * dz) / ll));
      const d = Math.hypot(state.x - (a.x + dx * t), state.z - (a.z + dz * t));
      if (d < best) { best = d; progress = along + len * t; }
      along += len;
    }
    return progress;
  };
}
