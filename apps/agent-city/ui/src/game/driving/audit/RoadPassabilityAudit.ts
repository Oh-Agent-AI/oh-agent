import { matchesFinalSurfaceBoundary, type FinalSurfaceBoundary } from "./FinalSurfaceBoundary";
/** Road passability audit (Agent B): every audited route returns passed, blocked WITH a witness, or
 * inconclusive with its cause — always bound to the world revision it was computed on.
 * Pure CPU; no THREE, DOM, host or renderer. The host hands in a frozen CityDrivingSnapshot.
 *
 * 为什么不能「跑不过就是路不通」：自动驾驶员撞路缘、转向不够、预算用完，都只说明这次没跑通。
 * 本模块把两件事分开：
 *   1. 静态证据（可认证的「挡住」）——
 *      a. 拓扑：起点与出口不在同一个区域。区域是分类器的连通分量，验证器禁止换区域，所以这是证明。
 *      b. 几何截面：沿合法走廊的直段取横截线；可行驶区间由区域边界线段精确切出，再扣掉精确结构固体
 *         占住的点。车心落在截线上时，车身（含余量）在截线上的弦长不小于车宽 2·(半宽+侧余量)，且整条弦
 *         必须在同一个无边界区间内——所有区间都短于这个值，任何合法位姿都过不去这条线。
 *         走廊内从起点到出口的连续路径必然穿过每一条截线（截线跨满走廊、直段内部、不与别段相近）。
 *         场景包围盒代理（sceneSolids）是保守外包，只用于动态试跑，永远不能当「挡住」的证据。
 *   2. 动态试跑（可认证的「通过」）——同一个 DrivingKernel、按钮式 pilot，经 DrivingRouteRunner +
 *      GateAuditObserver，每 tick 由独立验证器（整车覆盖 + 连续运动 + 固体 + 走廊）复核。
 * 合并：通过只来自试跑通过且固体覆盖完整；挡住只来自证据；其余都是 inconclusive 并带原因。
 * 有证据却跑通了，是模拟缺陷（simulation-invalid），不是通过。 */
import type { CityDrivingSnapshot, ReadyCitySurfaceCapture } from "../../../engine/surface/citySurfacePort";
import { compileCitySolidInputs } from "../../../engine/surface/compileCitySolidInputs";
import { buildSurfaceIndex } from "../../../engine/surface/SurfaceIndex";
import { buildSurfaceRegions } from "../../../engine/surface/surfaceRegions";
import type { RegionBoundarySegment, SurfaceRegionsBuild } from "../../../engine/surface/surfaceRegions";
import { CITY_SOLID_COMPILER_VERSION, MOUNTABLE_POLICY_VERSION, type MountablePolicy } from "../staticSolidContracts";
import { DRIVING_DT, DRIVING_PARAMS, initialDrivingState, type DrivingInputState, type DrivingState } from "../../DrivingSimulation";
import { boxPoly, buildCollisionIndex, type CollisionIndex } from "../CollisionIndex";
import { DrivingKernel, type KernelStep } from "../DrivingKernel";
import { structureSolids } from "../citySolids";
import { DEFAULT_FOOTPRINT_PARAMS, footprintSupport, type FootprintParams, type VehicleFootprint } from "../surfaceFootprint";
import { polylineProgress, SurfaceDrivingEnvironment, SurfaceWorldValidator } from "../SurfaceDrivingWorld";
import { DRIVING_FOOTPRINT } from "../vehicleFootprint";
import { auditKeyId } from "./AuditIdentity";
import { DRIVING_PHYSICS_VERSION } from "../../DrivingSimulation";
import { DEFAULT_SWEEP_LIMITS, DRIVING_COLLISION_VERSION } from "../DrivingCollision";
import { CONTINUOUS_DRIVING_QUERY_VERSION, CONTINUOUS_MOTION_DEFAULTS, ContinuousDrivingEnvironment } from "../ContinuousDrivingEnvironment";
import { ContinuousWorldValidator } from "../ContinuousWorldValidator";
import { createContinuousDrivingKernel } from "../createContinuousDrivingKernel";
import { commitRecovery, findSafePose } from "../SafeRecovery";
import { DrivingRouteRunner } from "./DrivingRouteRunner";
import type { AuditEvidenceSink } from "./AuditEvidenceStore";
import { GateAuditObserver } from "./GateAuditObserver";
import type { AuditCause, AuditKey, AuditVerdict, AuditWorldValidator, DirectedGate, RoadAuditCase, RoadAuditCaseResult, RoutePilot, StaticUnitEvidence, StepValidation } from "./contracts";

export const ROAD_PASSABILITY_AUDIT_VERSION = 5; // 3: gate-plane crossings far from the gate are not the gate; 4: continuous run loads only the solids its corridor can reach; 5: collision-budget stops are budget-exhausted, not simulation-invalid

type P = Readonly<{ x: number; z: number }>;
type Ready = Extract<SurfaceRegionsBuild, { status: "ready" }>;

/** One frozen world, the only thing an audit may read. */
export type PassabilityWorld = Readonly<{
  worldRevision: string; surfaceRevision: string; regions: Ready;
  /** Exact solids only (structure descriptors): allowed as blocking evidence. */
  exact: CollisionIndex;
  /** Shared static-solid compilation: structures, scene proxies, and rendered envelopes. */
  dynamic: CollisionIndex;
  /** "complete" when every rendered solid family is represented in `dynamic` (exactly or by a proxy). */
  coverage: "complete" | "structures-only";
  isCurrent: () => boolean;
  /** Throttled, latching view of isCurrent for per-segment calls inside the dynamic run. The host check
   * re-samples the scene (CitySurfacePort.sourceCurrent) and dominated C runs at ~100 ms/tick. Staleness is
   * monotonic (generation bump / latched source), and every verdict re-checks the real isCurrent before it
   * is returned — a change mid-run can only discard a result, never produce one. */
  runCurrent: () => boolean;
}>;
/** Real check at most once per `every` calls; false latches. */
export function throttledCurrent(isCurrent: () => boolean, every = 1000): () => boolean {
  let calls = 0; let ok = isCurrent();
  return () => { if (!ok) return false; if (++calls >= every) { calls = 0; ok = isCurrent(); } return ok; };
}
/** Roles the region rules already bound exactly (or a hull would over-approximate): never cut evidence. */
const NON_EVIDENCE_ROLES: ReadonlySet<string> = new Set(["island", "bridge-railing", "expressway-rail", "bridge-deck", "expressway-deck", "ramp-rail", "ramp-deck"]);

/** `declareNoBuildings`: the caller asserts this world has no building/landmark layer at all (synthetic
 * fixtures). A plan-only capture is NOT such a world — its buildings simply were not captured. */
export function passabilityWorld(snapshot: CityDrivingSnapshot, regions: SurfaceRegionsBuild, isCurrent: () => boolean,
  options: Readonly<{ declareNoBuildings?: boolean }> = {}):
  Readonly<{ status: "ready"; world: PassabilityWorld }> | Readonly<{ status: "unresolved"; reason: string }> {
  if (regions.status !== "ready") return Object.freeze({ status: "unresolved", reason: `regions:${regions.reason}` });
  if (regions.revision !== snapshot.surface.revision) return Object.freeze({ status: "unresolved", reason: "surface-revision-mismatch" });
  const structure = structureSolids(snapshot.obstacles);
  const exactInputs = structure.filter((s) => !NON_EVIDENCE_ROLES.has(s.role));
  let exact: CollisionIndex; let dynamic: CollisionIndex; let capturedRenderedInstances = 0;
  try {
    exact = buildCollisionIndex(exactInputs);
    const compiled = compileCitySolidInputs(snapshot);
    if (compiled.status !== "ready") return Object.freeze({ status: "unresolved", reason: `static-solids:${compiled.reason}` });
    dynamic = compiled.collisionIndex;
    capturedRenderedInstances = compiled.counts.renderedInstances;
  } catch (error) { return Object.freeze({ status: "unresolved", reason: error instanceof Error ? error.message : "collision-index" }); }
  // Dynamic collisions consume the same compiled inputs as manual vehicles and flight.
  // Exact cut witnesses remain limited to non-proxy structural descriptors above.
  // A captured rendered layer is complete because its instances compile to conservative boxes;
  // a scene proxy can also conservatively cover the layer. Plan-only snapshots still need an
  // explicit no-buildings assertion before a run can certify passability.
  const hasCapturedRenderedLayer = snapshot.obstacleCoverage === "structures-and-rendered-buildings" &&
    (snapshot.renderedSolids.length === 0 || capturedRenderedInstances > 0);
  const coverage = hasCapturedRenderedLayer || snapshot.sceneSolids.length > 0 ||
    (options.declareNoBuildings === true && snapshot.renderedSolids.length === 0) ? "complete" : "structures-only";
  return Object.freeze({ status: "ready", world: Object.freeze({ worldRevision: snapshot.revision, surfaceRevision: snapshot.surface.revision, regions, exact, dynamic, coverage, isCurrent, runCurrent: throttledCurrent(isCurrent) }) });
}

/** A directed route: a legal corridor (centreline + half width) from its first point to an exit gate at
 * its last point. Units are the audit units it covers (normally one directed edge). */
export type PassabilityRoute = Readonly<{
  id: string; units: readonly string[];
  path: readonly P[]; halfWidth: number;
  startLayer?: string; exitLayer?: string;
  cruiseSpeed?: number;
}>;
export type CutWitness = Readonly<{
  kind: "cut"; station: number; a: P; b: P; layerId: string;
  /** Widest boundary-free, solid-free interval on the cut, vs the width a car body needs. */
  widest: number; required: number;
  limits: readonly string[];
}>;
export type TopologyWitness = Readonly<{ kind: "topology"; startRegion: string; exitRegion: string }>;
export type PassabilityWitness = CutWitness | TopologyWitness;
export type PassabilityResult = Readonly<{
  key: AuditKey; routeId: string; worldRevision: string; auditVersion: number;
  verdict: AuditVerdict; cause: AuditCause;
  /** Present iff verdict is "blocked" (or on a contradiction, for diagnosis). */
  witness: PassabilityWitness | null;
  detail: string;
  run: RoadAuditCaseResult | null;
  /** Release-policy inputs, one per unit, bound to the same key. */
  evidence: readonly StaticUnitEvidence[];
}>;
export type PassabilityOptions = Readonly<{
  finalBoundary?: FinalSurfaceBoundary;
  /** Local automatic-run diagnostics only; never used as release evidence. */
  evidence?:AuditEvidenceSink;
  footprint?: VehicleFootprint; params?: FootprintParams;
  /** Distance between cut stations along the corridor. */
  stationStep?: number;
  /** Solid occupancy sampling along a cut (sound: only sampled points count as occupied). */
  solidSample?: number;
  maxCutSegments?: number;
  /** Skip the dynamic run (static evidence only). */
  staticOnly?: boolean;
  /** Dynamic engine: C's continuous kernel (default) or the legacy whole-step-rejection environment. */
  engine?: "continuous" | "legacy";
  /** Continuous run's solid set: the route corridor's reach (default, corridorSolids) or the whole world
   * (differential check only — large cities exceed the continuous-world budget). */
  solidScope?: "corridor" | "world";
  collider?: AuditCollider;
  /** Explicit curb/island policy; defaults to strict disabled for both kernel and independent validator. */
  mountablePolicy?: MountablePolicy;
  /** Pilot factory (D's RoutePilot); default B's CorridorPilot. The key's controllerVersion names it. */
  pilot?: (path: readonly P[], cruise: number) => RoutePilot;
}>;
/** Calibrated collision box for the continuous engine (not the wheel footprint): the footprint plus the
 * product SPEC clearance (lateral 0.2, longitudinal 0.1), body from 0.1 above the support to 1.25. */
export type AuditCollider = Readonly<{ dimensions: Readonly<{ halfLength: number; halfWidth: number; halfHeight: number }>; centerHeight: number }>;
export const CONTINUOUS_AUDIT_COLLIDER: AuditCollider = Object.freeze({
  dimensions: Object.freeze({ halfLength: DRIVING_FOOTPRINT.halfLength + DEFAULT_FOOTPRINT_PARAMS.longitudinalMargin,
    halfWidth: DRIVING_FOOTPRINT.halfWidth + DEFAULT_FOOTPRINT_PARAMS.lateralMargin, halfHeight: (1.25 - 0.1) / 2 }),
  centerHeight: 0.1 + (1.25 - 0.1) / 2 });
/** Key fields the continuous engine is calibrated to. vehicleConfigHash names the vehicle, collider,
 * dynamics and solver parameters it covers — a key from the legacy engine never matches. */
export function continuousAuditKeyFields(collider: AuditCollider = CONTINUOUS_AUDIT_COLLIDER, mountablePolicy: MountablePolicy = "disabled") {
  const d = collider.dimensions;
  if(mountablePolicy!=="disabled"&&mountablePolicy!=="gameplay")throw new Error("invalid-mountable-policy");
  return Object.freeze({ snapshotCompilerVersion: CITY_SOLID_COMPILER_VERSION,
    physicsVersion: DRIVING_PHYSICS_VERSION, collisionVersion: DRIVING_COLLISION_VERSION, queryVersion: CONTINUOUS_DRIVING_QUERY_VERSION,
    vehicleConfigHash: JSON.stringify(["car-v1", "collider", d.halfLength, d.halfWidth, d.halfHeight, collider.centerHeight,
      "sweep", DEFAULT_SWEEP_LIMITS.skin, DEFAULT_SWEEP_LIMITS.timeTolerance, DEFAULT_SWEEP_LIMITS.maxTests,
      "motion", CONTINUOUS_MOTION_DEFAULTS.maxSlides, CONTINUOUS_MOTION_DEFAULTS.maxSupportSegments, CONTINUOUS_MOTION_DEFAULTS.supportStep,
      "footprint", DEFAULT_FOOTPRINT_PARAMS.lateralMargin, DEFAULT_FOOTPRINT_PARAMS.longitudinalMargin, DEFAULT_FOOTPRINT_PARAMS.maxSlope,
      "mountable-policy", MOUNTABLE_POLICY_VERSION, mountablePolicy]) });
}
function support0(regions: Ready, p: P, heading: number, regionId: string, y: number, footprint: VehicleFootprint, params: FootprintParams): DrivingState | null {
  const s = footprintSupport(regions, { x: p.x, z: p.z, heading, y }, regionId, footprint, params);
  return s.ok ? { ...initialDrivingState(p.x, p.z, heading, regionId), y: s.y, pitch: s.pitch, roll: s.roll } : null;
}

const finiteP = (p: P) => Number.isFinite(p.x) && Number.isFinite(p.z);
function segDist(a: P, b: P, c: P, d: P): number {
  const pd = (p: P, s: P, t: P) => { const dx = t.x - s.x, dz = t.z - s.z, ll = dx * dx + dz * dz; const u = ll ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.z - s.z) * dz) / ll)) : 0; return Math.hypot(p.x - s.x - dx * u, p.z - s.z - dz * u); };
  const o = (p: P, q: P, r: P) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b));
}
/** 按路线走廊局部载入碰撞体（2026-10-20）：整城一次装进连续世界，1000 会话以上的城市超过百万元素预算，
 * 每个用例都 continuous-world-budget 未确认。局部载入不改变任何被接受的运动：CorridorValidator 只接受车心
 * 在走廊（路线 ± halfWidth）内的状态，内核每步从这样的状态出发、水平行程 ≤ maxForward·dt（独立验证器同一上界），
 * 车身（含俯仰侧倾）离车心不超过三半轴的合长 bodyRadius——所以一步里车身能碰到的点都在路线 halfWidth + 行程 + bodyRadius 之内。
 * 保留与这个距离（再加 margin）内有交集的固体，内核与验证器看到的碰撞就与整城相同；更远的固体只会让一个
 * 已经偏出走廊、本来就判 route-deviation 的运动换个结局。按 XZ 包围盒与路线段的距离判断（保守：盒比固体大）。 */
export function corridorSolids<S extends Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }>>(solids: readonly S[], path: readonly P[], reach: number): S[] {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of path) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const out: S[] = [];
  for (const s of solids) {
    if (s.maxX < x0 - reach || s.minX > x1 + reach || s.maxZ < z0 - reach || s.minZ > z1 + reach) continue;
    const corners: P[] = [{ x: s.minX, z: s.minZ }, { x: s.maxX, z: s.minZ }, { x: s.maxX, z: s.maxZ }, { x: s.minX, z: s.maxZ }];
    let near = false;
    for (let i = 1; i < path.length && !near; i++) {
      const a = path[i - 1], b = path[i];
      // 端点在盒内，或与盒的四条边之一相距 ≤ reach。
      if ((a.x >= s.minX && a.x <= s.maxX && a.z >= s.minZ && a.z <= s.maxZ) || (b.x >= s.minX && b.x <= s.maxX && b.z >= s.minZ && b.z <= s.maxZ)) { near = true; break; }
      for (let k = 0; k < 4 && !near; k++) if (segDist(a, b, corners[k], corners[(k + 1) % 4]) <= reach) near = true;
    }
    if (near) out.push(s);
  }
  return out;
}
/** Parameter u ∈ [0,1] on the cut a→b where segment s crosses it (proper or touching), or null. */
function crossParam(a: P, b: P, s: RegionBoundarySegment): number | null {
  const rx = b.x - a.x, rz = b.z - a.z, qx = s.bx - s.ax, qz = s.bz - s.az;
  const den = rx * qz - rz * qx; const wx = s.ax - a.x, wz = s.az - a.z;
  if (Math.abs(den) < 1e-12 * Math.hypot(rx, rz) * Math.hypot(qx, qz)) return null; // parallel: probing the sides covers it
  const u = (wx * qz - wz * qx) / den; const v = (wx * rz - wz * rx) / den;
  return u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9 ? Math.min(1, Math.max(0, u)) : null;
}

type Interval = { u0: number; u1: number; layerId: string; y0: number; y1: number };
/** Exact drivable intervals of one cut, per layer of the region (classifier-consistent). */
function cutIntervals(regions: Ready, regionId: string, a: P, b: P, maxSegments: number): Interval[] | "budget" {
  const region = regions.regionById(regionId)!;
  const box = regions.segmentsInBox(regionId, Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z), maxSegments);
  if (box.status !== "ok") return "budget";
  const out: Interval[] = [];
  for (const layerId of region.layerIds) {
    const us = [0, 1];
    for (const s of box.segments) if (s.layerId === layerId) { const u = crossParam(a, b, s); if (u !== null) us.push(u); }
    us.sort((x, y) => x - y);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    for (let i = 1; i < us.length; i++) {
      if ((us[i] - us[i - 1]) * len < 1e-6) continue;
      const um = (us[i - 1] + us[i]) / 2;
      const c = regions.classify(a.x + (b.x - a.x) * um, a.z + (b.z - a.z) * um, layerId);
      if (c.status !== "drivable" || c.regionId !== regionId) continue;
      const at = (u: number) => c.y - (c.normal.x * ((a.x + (b.x - a.x) * u) - (a.x + (b.x - a.x) * um)) + c.normal.z * ((a.z + (b.z - a.z) * u) - (a.z + (b.z - a.z) * um))) / c.normal.y;
      out.push({ u0: us[i - 1], u1: us[i], layerId, y0: at(us[i - 1]), y1: at(us[i]) });
    }
  }
  return out;
}

/** Static cut evidence over a route corridor. Returns a witness, "clear", or an unresolved reason. */
export function corridorCutEvidence(world: PassabilityWorld, route: PassabilityRoute, regionId: string, options: PassabilityOptions = {}):
  Readonly<{ status: "blocked"; witness: CutWitness }> | Readonly<{ status: "clear"; stations: number }> | Readonly<{ status: "unresolved"; reason: string }> {
  const footprint = options.footprint ?? DRIVING_FOOTPRINT; const params = options.params ?? DEFAULT_FOOTPRINT_PARAMS;
  const step = options.stationStep ?? 0.5; const sample = options.solidSample ?? 0.05;
  const required = 2 * (footprint.halfWidth + params.lateralMargin);
  const path = route.path; const w = route.halfWidth;
  let along = 0; let stations = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1], q = path[i]; const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 1e-9) continue;
    const ux = (q.x - p.x) / len, uz = (q.z - p.z) / len, nx = -uz, nz = ux;
    // Straight interior only (≥ w from both vertices), so the cut spans the tube and separates it.
    for (let s = w; s <= len - w + 1e-9; s += step) {
      const cx = p.x + ux * s, cz = p.z + uz * s;
      const a = { x: cx - nx * w, z: cz - nz * w }, b = { x: cx + nx * w, z: cz + nz * w };
      // Another part of the corridor near this cut would let a path bypass it.
      let separated = true;
      for (let j = 1; j < path.length && separated; j++) if (j !== i && segDist(a, b, path[j - 1], path[j]) <= w) separated = false;
      if (!separated) continue;
      stations++;
      const intervals = cutIntervals(world.regions, regionId, a, b, options.maxCutSegments ?? 4096);
      if (intervals === "budget") return Object.freeze({ status: "unresolved", reason: "cut-budget" });
      // A free interval touching the corridor edge continues outside it: no claim from this cut.
      // Free intervals on two layers: the footprint rules may exempt segments across layers — no claim.
      if (new Set(intervals.map((x) => x.layerId)).size > 1) continue;
      let widest = 0; const limits = new Set<string>();
      let open = false;
      for (const iv of intervals) {
        if (iv.u0 <= 1e-9 || iv.u1 >= 1 - 1e-9) { open = true; break; }
        // Subtract exact solids at body height (sampled: unsampled points count as free → sound).
        const total = (iv.u1 - iv.u0) * 2 * w; const n = Math.max(1, Math.floor(total / sample));
        let runStart = iv.u0; let free = 0;
        for (let k = 1; k < n; k++) {
          const u = iv.u0 + (iv.u1 - iv.u0) * (k / n);
          const x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u, y = iv.y0 + (iv.y1 - iv.y0) * ((u - iv.u0) / (iv.u1 - iv.u0));
          // Column the car body must occupy over a chord point (support residual 0.06 shaved off both ends).
          const hit = world.exact.hit(boxPoly({ x, y: y + (0.16 + 1.19) / 2, z }, [{ x: 1e-4, y: 0, z: 0 }, { x: 0, y: (1.19 - 0.16) / 2, z: 0 }, { x: 0, y: 0, z: 1e-4 }]));
          if (hit.status === "budget" || hit.status === "invalid-input") return Object.freeze({ status: "unresolved", reason: `solid-${hit.status}` });
          if (hit.status === "hit") { free = Math.max(free, (u - runStart) * 2 * w); runStart = u; limits.add(hit.solid.id); }
        }
        free = Math.max(free, (iv.u1 - runStart) * 2 * w);
        widest = Math.max(widest, free);
      }
      if (open || widest >= required) continue;
      const segs = world.regions.segmentsInBox(regionId, Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z), options.maxCutSegments ?? 4096);
      if (segs.status === "ok") for (const s of segs.segments) if (crossParam(a, b, s) !== null) limits.add(`${s.label}:${s.cause}`);
      return Object.freeze({ status: "blocked", witness: Object.freeze({ kind: "cut", station: along + s, a: Object.freeze(a), b: Object.freeze(b),
        layerId: intervals[0]?.layerId ?? world.regions.regionById(regionId)!.layerId, widest, required, limits: Object.freeze([...limits].sort()) }) });
    }
    along += len;
  }
  return Object.freeze({ status: "clear", stations });
}

/** Button-only pure-pursuit pilot along the corridor centreline, holding a cruise speed. */
export class CorridorPilot implements RoutePilot {
  private readonly lengths: number[];
  private readonly progress: (s: Readonly<{ x: number; z: number }>) => number;
  constructor(private readonly path: readonly P[], private readonly cruise: number, private readonly lookahead = 4) {
    this.lengths = [0];
    for (let i = 1; i < path.length; i++) this.lengths.push(this.lengths[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    this.progress = polylineProgress(path);
  }
  private at(s: number): P {
    const L = this.lengths; let i = 1; while (i < this.path.length - 1 && L[i] < s) i++;
    const a = this.path[i - 1], b = this.path[i]; const t = Math.max(0, Math.min(1, (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1)));
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
  input(state: Readonly<DrivingState>): Readonly<DrivingInputState> {
    const total = this.lengths[this.lengths.length - 1];
    // Aim past the end so the exit gate is crossed along the final tangent.
    const s = this.progress(state) + this.lookahead;
    const end = this.path[this.path.length - 1], prev = this.path[this.path.length - 2];
    let target = this.at(Math.min(total, s));
    if (s > total) { const l = Math.hypot(end.x - prev.x, end.z - prev.z) || 1; target = { x: end.x + (end.x - prev.x) / l * (s - total), z: end.z + (end.z - prev.z) / l * (s - total) }; }
    const want = Math.atan2(target.z - state.z, target.x - state.x);
    const err = Math.atan2(Math.sin(want - state.heading), Math.cos(want - state.heading));
    return Object.freeze({ forward: state.speed < this.cruise, backward: false, left: err < -0.02, right: err > 0.02 });
  }
}

/** Corridor-bounded validator: the base validator plus "centre stays within halfWidth of the centreline". */
export class CorridorValidator implements AuditWorldValidator {
  private readonly progressOf: (s: Readonly<{ x: number; z: number }>) => number;
  constructor(private readonly base: AuditWorldValidator, private readonly path: readonly P[], private readonly halfWidth: number) {
    this.progressOf = polylineProgress(path);
  }
  private inside(s: Readonly<{ x: number; z: number }>): boolean {
    let best = Infinity;
    for (let i = 1; i < this.path.length; i++) best = Math.min(best, segDist(s, s, this.path[i - 1], this.path[i]));
    return best <= this.halfWidth;
  }
  validateStart(state: Readonly<DrivingState>): StepValidation { return this.inside(state) ? this.base.validateStart(state) : "route-deviation"; }
  validate(previous: Readonly<DrivingState>, next: KernelStep): StepValidation {
    const v = this.base.validate(previous, next);
    if (v !== "valid") return v;
    // Every piece of a slid (piecewise) motion must stay in the corridor, not only its end.
    const path = next.motion.trajectory ?? [next.state];
    return path.every((p) => this.inside(p)) && this.inside(next.state) ? "valid" : "route-deviation";
  }
  progress(state: Readonly<DrivingState>): number { return this.base.progress(state); }
}

function evidenceFor(key: AuditKey, units: readonly string[], topology: AuditVerdict, geometry: AuditVerdict, witness: string | null): StaticUnitEvidence[] {
  return units.map((unitId) => Object.freeze({ key, unitId, topology, geometry, witness }));
}
const witnessText = (w: PassabilityWitness) => w.kind === "topology" ? `topology:${w.startRegion}→${w.exitRegion}`
  : `cut@${w.station.toFixed(2)}:${w.layerId}:widest=${w.widest.toFixed(3)}<${w.required.toFixed(3)}:${w.limits.join(",")}`;

/** Audit one route against one frozen world. Never throws for world/route content; bad input is inconclusive. */
export function auditRoute(world: PassabilityWorld, key: AuditKey, route: PassabilityRoute, options: PassabilityOptions = {}): PassabilityResult {
  const footprint = options.footprint ?? DRIVING_FOOTPRINT; const params = options.params ?? DEFAULT_FOOTPRINT_PARAMS;
  const finish = (verdict: AuditVerdict, cause: AuditCause, detail: string, witness: PassabilityWitness | null, run: RoadAuditCaseResult | null,
    topology: AuditVerdict, geometry: AuditVerdict): PassabilityResult => {
    // A world that changed under the audit invalidates every conclusion drawn from it.
    if (!world.isCurrent()) { verdict = "inconclusive"; cause = "unconfirmed"; detail = "stale-world"; topology = geometry = "inconclusive"; }
    const evidenceWitness = verdict === "blocked" && witness ? witnessText(witness) : null;
    return Object.freeze({ key, routeId: route.id, worldRevision: world.worldRevision, auditVersion: ROAD_PASSABILITY_AUDIT_VERSION, verdict, cause,
      witness, detail, run, evidence: Object.freeze(evidenceFor(key, route.units, topology, geometry, evidenceWitness)) });
  };
  if (options.finalBoundary && (!matchesFinalSurfaceBoundary(options.finalBoundary,world,key) ||
    options.engine === "legacy" || options.mountablePolicy === "gameplay" || options.footprint || options.params || options.collider))
    return finish("inconclusive", "unconfirmed", "final-boundary-policy-mismatch", null, null, "inconclusive", "inconclusive");
  const mountablePolicy=options.mountablePolicy??"disabled";
  if(mountablePolicy!=="disabled"&&mountablePolicy!=="gameplay")return finish("inconclusive","unconfirmed","invalid-mountable-policy",null,null,"inconclusive","inconclusive");
  try { auditKeyId(key); } catch { return finish("inconclusive", "unconfirmed", "invalid-audit-key", null, null, "inconclusive", "inconclusive"); }
  if (key.baseSnapshotHash !== world.worldRevision) return finish("inconclusive", "unconfirmed", "key-world-mismatch", null, null, "inconclusive", "inconclusive");
  if (key.snapshotCompilerVersion !== CITY_SOLID_COMPILER_VERSION) return finish("inconclusive", "unconfirmed", "key-compiler-mismatch", null, null, "inconclusive", "inconclusive");
  if (!world.isCurrent()) return finish("inconclusive", "unconfirmed", "stale-world", null, null, "inconclusive", "inconclusive");
  if (!route.id || !route.units.length || route.path.length < 2 || !route.path.every(finiteP) || !(route.halfWidth > 0)) return finish("inconclusive", "unconfirmed", "invalid-route", null, null, "inconclusive", "inconclusive");
  const regions = world.regions;
  const p0 = route.path[0], p1 = route.path[1], pn = route.path[route.path.length - 1], pm = route.path[route.path.length - 2];
  const start = regions.classify(p0.x, p0.z, route.startLayer ?? "ground");
  const exit = regions.classify(pn.x, pn.z, route.exitLayer ?? "ground");
  if (start.status !== "drivable") return finish("inconclusive", "unconfirmed", `start:${start.cause}`, null, null, "inconclusive", "inconclusive");
  if (exit.status !== "drivable") return finish("inconclusive", "unconfirmed", `exit:${exit.cause}`, null, null, "inconclusive", "inconclusive");
  if (start.regionId !== exit.regionId) {
    const witness: TopologyWitness = Object.freeze({ kind: "topology", startRegion: start.regionId, exitRegion: exit.regionId });
    return finish("blocked", "topology-disconnected", "regions-differ", witness, null, "blocked", "inconclusive");
  }
  const regionId = start.regionId;
  const cut = corridorCutEvidence(world, route, regionId, options);
  if (cut.status === "unresolved") return finish("inconclusive", "budget-exhausted", cut.reason, null, null, "passed", "inconclusive");
  const witness = cut.status === "blocked" ? cut.witness : null;
  if (options.staticOnly) return witness ? finish("blocked", "geometry-blocked", "cut", witness, null, "passed", "blocked")
    : finish("inconclusive", "unconfirmed", "static-only", null, null, "passed", "passed");

  // ── Dynamic run on the same kernel (C continuous by default; legacy whole-step kept for comparison) ──
  const engine = options.engine ?? "continuous";
  if (engine === "continuous") {
    const expect = continuousAuditKeyFields(options.collider,mountablePolicy);
    if (key.physicsVersion !== expect.physicsVersion || key.collisionVersion !== expect.collisionVersion || key.queryVersion !== expect.queryVersion || key.vehicleConfigHash !== expect.vehicleConfigHash) {
      return finish("inconclusive", "unconfirmed", "key-engine-mismatch", witness, null, "passed", witness ? "blocked" : "passed");
    }
    // C requires the solid index to be complete: a dropped solid is an unseen obstacle.
    if (world.dynamic.report.rejected > 0) return finish("inconclusive", "unconfirmed", `solids-rejected:${world.dynamic.report.rejected}`, witness, null, "passed", witness ? "blocked" : "passed");
  }
  const heading = Math.atan2(p1.z - p0.z, p1.x - p0.x);
  const collider = options.collider ?? CONTINUOUS_AUDIT_COLLIDER;
  let validatorFor: () => AuditWorldValidator; let kernelFor: () => DrivingKernel;
  let startState: DrivingState | null = null; let recovered = "";
  const base = support0(regions, p0, heading, regionId, start.y, footprint, params);
  if (engine === "continuous") {
    let env: ContinuousDrivingEnvironment;
    try {
      env = new ContinuousDrivingEnvironment(regions, { surfaceRevision: regions.revision, worldRevision: world.worldRevision, solidRevision: world.worldRevision,
        solids: options.solidScope === "world" ? world.dynamic.solids() : corridorSolids(world.dynamic.solids(), route.path, route.halfWidth + Math.hypot(collider.dimensions.halfLength, collider.dimensions.halfWidth, collider.dimensions.halfHeight) + DRIVING_PARAMS.maxForward * DRIVING_DT + 1),
        dimensions: collider.dimensions, centerHeight: collider.centerHeight, isCurrent: world.runCurrent }, footprint, params, {}, {mountablePolicy});
    } catch (error) { return finish("inconclusive", "unconfirmed", `continuous-world:${error instanceof Error ? error.message : "error"}`, witness, null, "passed", witness ? "blocked" : "passed"); }
    validatorFor = () => new CorridorValidator(new ContinuousWorldValidator(env, polylineProgress(route.path)), route.path, route.halfWidth);
    kernelFor = () => createContinuousDrivingKernel(env, { worldRevision: world.worldRevision, vehicleConfigHash: key.vehicleConfigHash, kernelBuildId: key.kernelBuildId });
  } else {
    const env = new SurfaceDrivingEnvironment(regions, footprint, params, world.dynamic,mountablePolicy);
    validatorFor = () => new CorridorValidator(new SurfaceWorldValidator(regions, polylineProgress(route.path), footprint, params, world.dynamic,mountablePolicy), route.path, route.halfWidth);
    kernelFor = () => new DrivingKernel(env, { baseSnapshotHash: key.baseSnapshotHash, vehicleConfigHash: key.vehicleConfigHash, kernelBuildId: key.kernelBuildId,
      physicsVersion: key.physicsVersion, collisionVersion: key.collisionVersion, queryVersion: key.queryVersion });
  }
  if (base && validatorFor().validateStart(base) === "valid") startState = base;
  else {
    // Start overlapping a solid / off its support: SafeRecovery, then a NEW case from the recovered pose.
    const recovery = findSafePose({ worldRevision: world.worldRevision, regions, collision: world.dynamic, isCurrent: world.isCurrent },
      { x: p0.x, z: p0.z, heading, regionId, y: start.y }, { maxDistance: Math.min(3, route.halfWidth), allowReverse: false, footprint, params });
    const state = commitRecovery(recovery, { worldRevision: world.worldRevision, regions, collision: world.dynamic, isCurrent: world.isCurrent });
    if (state && validatorFor().validateStart(state) === "valid") { startState = { ...state }; recovered = `;recovered-start:${(recovery as { displacement: number }).displacement.toFixed(2)}`; }
    else {
      const why = recovery.status === "unrecoverable" ? recovery.reason : "recovered-pose-rejected";
      return witness ? finish("blocked", "geometry-blocked", `cut;start:${why}`, witness, null, "passed", "blocked")
        : finish("inconclusive", "unconfirmed", `start-unrecoverable:${why}`, null, null, "passed", "passed");
    }
  }
  const ex = pn.x - pm.x, ez = pn.z - pm.z, el = Math.hypot(ex, ez) || 1;
  const gate: DirectedGate = { id: `${route.id}:exit`, x: pn.x, y: exit.y, z: pn.z, forwardX: ex / el, forwardZ: ez / el,
    halfWidth: route.halfWidth + Math.hypot(footprint.halfLength, footprint.halfWidth), heightTolerance: 0.5, surfaceIds: [regionId] };
  let length = 0; for (let i = 1; i < route.path.length; i++) length += Math.hypot(route.path[i].x - route.path[i - 1].x, route.path[i].z - route.path[i - 1].z);
  const cruise = route.cruiseSpeed ?? 7;
  const test: RoadAuditCase = { id: recovered ? `${route.id}:recovered` : route.id, units: [...route.units], start: startState, gates: [gate],
    corridor: { surfaceSequence: [regionId], portalSequence: [], waypoints: route.path.map((p) => ({ x: p.x, z: p.z })) },
    policy: { cruiseSpeed: cruise, maxReverseSpeed: 0 }, maxTicks: Math.ceil(((length + 10) / cruise) * 60 * 2 + 600), maxNoProgressTicks: 240 };
  let run: RoadAuditCaseResult | null = null;
  try {
    const runner = new DrivingRouteRunner(key, test, kernelFor(), options.pilot ? options.pilot(route.path, cruise) : new CorridorPilot(route.path, cruise), new GateAuditObserver(test, validatorFor()), options.evidence);
    for (let guard = 0; !runner.result && guard < 10000; guard++) { runner.advance(250, key); if (!world.isCurrent()) { runner.cancel(); break; } }
    run = runner.result;
  } catch (error) {
    return finish("inconclusive", "simulation-invalid", `runner:${error instanceof Error ? error.message : "error"}${recovered}`, witness, null, "passed", witness ? "blocked" : "passed");
  }
  if (!run) return finish("inconclusive", "budget-exhausted", "runner-guard", witness, null, "passed", witness ? "blocked" : "passed");
  if (run.verdict === "passed") {
    // Evidence says impossible, the kernel did it anyway: the simulation or the evidence is wrong.
    if (witness) return finish("inconclusive", "simulation-invalid", "passed-against-witness", witness, run, "passed", "inconclusive");
    if (world.coverage !== "complete") return finish("inconclusive", "unconfirmed", "solid-coverage-incomplete", null, run, "passed", "passed");
    return finish("passed", "none", `run-passed${recovered}`, null, run, "passed", "passed");
  }
  if (witness) return finish("blocked", "geometry-blocked", `cut;run:${run.cause}${recovered}`, witness, run, "passed", "blocked");
  // A failed search, a failed pilot or a contact is never road evidence.
  return finish("inconclusive", run.cause, `run:${run.cause}${recovered}`, null, run, "passed", "passed");
}

/** Directed-edge routes from the layout's road edges (both directions), trimmed off the node fans.
 * A starting set for real cities, not D's planner: turns, spawn access and structures are not planned here. */
export function directedEdgeRoutes(edges: readonly Readonly<{ id: string; points: readonly P[]; width: number; bridge?: boolean; structure?: string }>[],
  options: Readonly<{ trim?: number; minLength?: number; corridorMargin?: number }> = {}): PassabilityRoute[] {
  const trim = options.trim ?? 6; const routes: PassabilityRoute[] = [];
  for (const edge of [...edges].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const pts = edge.points; if (pts.length < 2 || !pts.every(finiteP)) continue;
    const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const total = L[L.length - 1]; const t = Math.min(trim, total / 4);
    if (total - 2 * t < (options.minLength ?? 8)) continue;
    const at = (s: number): P => { let i = 1; while (i < pts.length - 1 && L[i] < s) i++; const u = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * u }; };
    const inner = pts.filter((_, i) => L[i] > t && L[i] < total - t);
    const path = [at(t), ...inner, at(total - t)];
    const halfWidth = edge.width / 2 + (options.corridorMargin ?? 0.5);
    routes.push(Object.freeze({ id: `edge:${edge.id}:fwd`, units: Object.freeze([`edge:${edge.id}:fwd`]), path: Object.freeze(path), halfWidth }));
    routes.push(Object.freeze({ id: `edge:${edge.id}:rev`, units: Object.freeze([`edge:${edge.id}:rev`]), path: Object.freeze([...path].reverse()), halfWidth }));
  }
  return routes;
}

/** Audit routes on a host capture (CitySurfacePort / CityEngine.captureDrivingWorld). The key is derived
 * from the captured world revision by the caller's identity rules; results are bound to that revision
 * and become inconclusive (stale-world) the moment the capture stops being current. */
export function auditCapture(capture: ReadyCitySurfaceCapture, keyFor: (worldRevision: string) => AuditKey,
  routes: readonly PassabilityRoute[], options: PassabilityOptions = {}):
  Readonly<{ status: "ready"; worldRevision: string; results: readonly PassabilityResult[] }> | Readonly<{ status: "unresolved"; reason: string }> {
  const snapshot = capture.readWorld();
  if (!snapshot || snapshot.revision !== capture.worldRevision || snapshot.surface.revision !== capture.revision) return Object.freeze({ status: "unresolved", reason: "stale-or-mismatched-capture" });
  const index = buildSurfaceIndex(snapshot.surface);
  if (index.status !== "ready") return Object.freeze({ status: "unresolved", reason: `surface-index:${index.reason}` });
  const built = passabilityWorld(snapshot, buildSurfaceRegions(snapshot.surface, index), capture.isCurrent);
  if (built.status !== "ready") return built;
  const key = keyFor(snapshot.revision);
  return Object.freeze({ status: "ready", worldRevision: snapshot.revision, results: Object.freeze(routes.map((route) => auditRoute(built.world, key, route, options))) });
}
