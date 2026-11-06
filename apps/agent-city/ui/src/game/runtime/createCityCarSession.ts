/** Frozen host -> shared car kernel bridge. Exact architectural render-mesh
 * collision remains an explicit missing capability; building/landmark boxes enter
 * through the whitelisted scene proxies so a city with buildings is drivable with
 * conservative collision instead of being refused outright.
 */
import type { ReadyCitySurfaceCapture } from "../../engine/surface/citySurfacePort";
import type * as THREE from "three";
import { buildSurfaceIndex } from "../../engine/surface/SurfaceIndex";
import { compileCitySolidInputs } from "../../engine/surface/compileCitySolidInputs";
import { buildSurfaceRegions } from "../../engine/surface/surfaceRegions";
import { initialDrivingState, DRIVING_PHYSICS_VERSION, type DrivingInputState } from "../DrivingSimulation";
import { DrivingKernel, type KernelStepFn } from "../driving/DrivingKernel";
import { initialVtolState, stepVtolDriving, VTOL_PHYSICS_VERSION, type VtolDrivingState, type VtolInputState, type VtolWorld } from "../driving/vtolDriving";
import { VtolDrivingEnvironment } from "../driving/VtolDrivingEnvironment";
import type { CollisionDimensions } from "../driving/CollisionIndex";
import { ContinuousDrivingEnvironment, CONTINUOUS_DRIVING_QUERY_VERSION } from "../driving/ContinuousDrivingEnvironment";
import { DRIVING_COLLISION_VERSION } from "../driving/DrivingCollision";
import { GAMEPLAY_FOOTPRINT_PARAMS } from "../driving/surfaceFootprint";
import { GAMEPLAY_COLLISION_INSET, GAMEPLAY_DRIVING_FOOTPRINT } from "../driving/vehicleFootprint";
import { createCameraCollisionQuery } from "../driving/cameraCollisionQuery";
import { CarAdapter, type CarPresentation } from "./CarAdapter";
import { GameRuntime } from "./GameRuntime";
import { diagnosticSpawnAsync } from "./diagnosticSpawn";
import { measurePreparation, preparationCheckpoint, preparationNow, type PreparationMetric, type PreparationProgress } from "./Preparation";
import { isVerifiedSpawnCredential, type VerifiedSpawnCredential } from "../driving/spawnPoints";
import type { GameSceneLease, GameScenePort, RuntimeSceneLease } from "./GameScenePort";
import type { GameSceneSnapshot } from "./GameSceneSnapshot";
import { MOUNTABLE_POLICY_VERSION } from "../driving/staticSolidContracts";

type CityDrivingSnapshot = NonNullable<ReturnType<ReadyCitySurfaceCapture["readWorld"]>>;

export type CityCarSceneCapability = Pick<GameSceneLease<unknown, THREE.Object3D>,
  "token" | "isCurrent" | "attach" | "detach" | "setCamera">;
type CityCarWorldLease = RuntimeSceneLease & CityCarSceneCapability & Readonly<{ snapshot: GameSceneSnapshot }>;
export type CityCarHost = Readonly<{ gameScenePort: Pick<GameScenePort<GameSceneSnapshot, THREE.Object3D>, "acquireResult"> }>;
type CityCarRequestBase = Readonly<{
  x: number; z: number; heading: number; layerId: string;
  /** Explicit calibrated collider parameters; no silent visual-to-solid guess. */
  collider: Readonly<{ dimensions: CollisionDimensions; centerHeight: number; vehicleConfigHash: string }>;
  present(frame: CarPresentation, scene: CityCarSceneCapability): void;
  onPreparationMetric?(metric: PreparationMetric): void;
  onPreparationProgress?(progress: PreparationProgress): void | Promise<void>;
  /** VTOL 推进器会话（玩法专属）：地面段与默认完全一致，注入空中体制物理。 */
  vtol?: boolean;
  /** 自由驾驶的出发点：点了地标停车场里的车，出生点搜索从离这里最近的路开始（不改搜索的校验，只改先试哪里）。 */
  near?: Readonly<{ x: number; z: number }>;
}>;
export type CityCarRequest = CityCarRequestBase & Readonly<{
  /** Issued only after full current-world and released-graph spawn validation. */
  validatedSpawn: VerifiedSpawnCredential;
}>;
export type CityCarEntry =
  | Readonly<{ status: "ready"; worldRevision: string; coverage: "structures-only" | "structures-and-scene-proxies" | "structures-and-buildings" | "structures-and-buildings-and-scene-proxies"; adapter: CarAdapter }>
  | Readonly<{ status: "unavailable"; reason: string }>;
export async function createCityCarSession(host: CityCarHost, runtime: GameRuntime<DrivingInputState>, request: CityCarRequest,
  signal?: AbortSignal): Promise<CityCarEntry> {
  if (!isVerifiedSpawnCredential(request.validatedSpawn)) return Object.freeze({ status: "unavailable", reason: "validated-spawn-required" });
  if (request.validatedSpawn.x !== request.x || request.validatedSpawn.z !== request.z ||
    request.validatedSpawn.heading !== request.heading || request.validatedSpawn.layerId !== request.layerId ||
    request.validatedSpawn.vehicleConfigHash !== request.collider.vehicleConfigHash ||
    request.validatedSpawn.collider.centerHeight !== request.collider.centerHeight ||
    request.validatedSpawn.collider.dimensions.halfLength !== request.collider.dimensions.halfLength ||
    request.validatedSpawn.collider.dimensions.halfWidth !== request.collider.dimensions.halfWidth ||
    request.validatedSpawn.collider.dimensions.halfHeight !== request.collider.dimensions.halfHeight ||
    !request.validatedSpawn.isFresh()) {
    return Object.freeze({ status: "unavailable", reason: "validated-spawn-stale-or-mismatch" });
  }
  return createSession(host, runtime, request, "validated", signal);
}
/** Ordinary free-drive entry. Finds a safe, locally clear spawn in the current
 * frozen city. It does not certify/release road connectivity for the whole city. */
export async function createCityCarFreeDriveSession(host: CityCarHost, runtime: GameRuntime<DrivingInputState>,
  request: Pick<CityCarRequestBase, "collider" | "present" | "onPreparationMetric" | "onPreparationProgress" | "vtol" | "near">, signal?: AbortSignal): Promise<CityCarEntry> {
  return createSession(host, runtime, { ...request, x: 0, z: 0, heading: 0, layerId: "" }, "free-drive", signal);
}
/** Development diagnostic entry. Kept separate from player free drive and
 * never writes confirmation state or road-release evidence. */
export async function createCityCarDiagnosticSession(host: CityCarHost, runtime: GameRuntime<DrivingInputState>,
  request: Pick<CityCarRequestBase, "collider" | "present" | "onPreparationMetric" | "onPreparationProgress">, signal?: AbortSignal): Promise<CityCarEntry> {
  return createSession(host, runtime, { ...request, x: 0, z: 0, heading: 0, layerId: "" }, "diagnostic", signal);
}
async function createSession(host: CityCarHost, runtime: GameRuntime<DrivingInputState>, request: CityCarRequestBase,
  mode: "validated" | "free-drive" | "diagnostic", signal?: AbortSignal): Promise<CityCarEntry> {
  const unavailable = (reason: string): CityCarEntry => Object.freeze({ status: "unavailable", reason });
  if (signal?.aborted) return unavailable("cancelled");
  if (!["idle", "error"].includes(runtime.snapshot.phase)) return unavailable("runtime-busy");
  runtime.beginPreparation();
  const progress = async (stage: PreparationProgress["stage"], state: PreparationProgress["state"], extra: Omit<PreparationProgress, "stage" | "state"> = {}) => {
    try { await request.onPreparationProgress?.(Object.freeze({ stage, state, ...extra })); } catch { /* local presentation only */ }
  };
  const acquireSignal = signal ?? new AbortController().signal;
  let lease: CityCarWorldLease;
  try {
    await progress("world-capture", "started");
    await preparationCheckpoint(signal);
    const started = preparationNow();
    const acquisition = await host.gameScenePort.acquireResult({ vehicle: "car", activity: "free" }, runtime.snapshot.runId + 1, acquireSignal);
    if (acquisition.status !== "ready") return unavailable(`scene-${acquisition.status}:${acquisition.reason}`);
    lease = acquisition.lease;
    try { request.onPreparationMetric?.({ stage: "world-capture", durationMs: preparationNow() - started }); } catch { /* local diagnostic */ }
    await progress("world-capture", "completed");
  }
  catch (error) { return unavailable(error instanceof Error ? error.message : "scene-unavailable"); }
  const capture = lease.snapshot.drivingWorld;
  const staticCapture = lease.snapshot.staticWorld;
  if (!capture || !staticCapture) { lease.release(); return unavailable("driving-world-capability-unavailable"); }
  let transferred = false;
  const cancel = () => { if (transferred) runtime.exit(); else lease.release(); };
  signal?.addEventListener("abort", cancel, { once: true });
  const runtimeLease: RuntimeSceneLease = {
    revision: lease.revision,
    isCurrent: () => lease.isCurrent(),
    setFrameHook: (callback) => lease.setFrameHook(callback),
    release: () => { signal?.removeEventListener("abort", cancel); lease.release(); },
  };
  try {
    if (signal?.aborted || !lease.isCurrent() || !capture.verifyCurrent() || !staticCapture.verifyCurrent()) return unavailable("stale-or-cancelled");
    const leaseCurrent = () => lease.isCurrent() && capture.isLeaseCurrent() && staticCapture.isLeaseCurrent();
    await preparationCheckpoint(signal, leaseCurrent);
    const measured = async <T>(stage: PreparationMetric["stage"], work: () => T): Promise<T> => {
      await progress(stage, "started");
      await preparationCheckpoint(signal, leaseCurrent);
      const result = measurePreparation(stage, work, request.onPreparationMetric);
      await progress(stage, "completed");
      return result;
    };
    const worldRead = await measured("world-read", () => ({ snapshot: capture.readWorld(), staticSnapshot: staticCapture.readWorld() }));
    const { snapshot, staticSnapshot } = worldRead;
    if (!snapshot || snapshot.revision !== capture.worldRevision || snapshot.surface.revision !== capture.revision) return unavailable("revision-mismatch");
    if (!staticSnapshot || staticSnapshot.revision !== staticCapture.worldRevision) return unavailable("static-revision-mismatch");
    if (mode === "validated" && (!("validatedSpawn" in request) || !isVerifiedSpawnCredential(request.validatedSpawn) ||
      request.validatedSpawn.worldRevision !== capture.worldRevision || !request.validatedSpawn.isFresh())) return unavailable("validated-spawn-stale-or-mismatch");
    // Merge exact structural descriptors, whitelisted scene proxies, and
    // conservative per-instance rendered-solid bounds in one fail-closed index.
    if (!request.collider.vehicleConfigHash) return unavailable("invalid-vehicle-config");
    await preparationCheckpoint(signal, leaseCurrent);
    const surfaceIndex = await measured("surface-index", () => buildSurfaceIndex(snapshot.surface));
    if (surfaceIndex.status !== "ready") return unavailable(`surface-index:${surfaceIndex.reason}`);
    await preparationCheckpoint(signal, leaseCurrent);
    const regions = await measured("surface-regions", () => buildSurfaceRegions(snapshot.surface, surfaceIndex));
    if (regions.status !== "ready") return unavailable(`surface-regions:${regions.reason}`);
    await preparationCheckpoint(signal, leaseCurrent);
    const compiledSolids = await measured("static-solids", () => compileCitySolidInputs(staticSnapshot, undefined, capture.worldRevision));
    if (compiledSolids.status !== "ready") return unavailable(compiledSolids.reason);
    const collisionIndex = compiledSolids.collisionIndex;
    if (collisionIndex.revision !== capture.worldRevision) return unavailable("collision-index-revision-mismatch");
    // Manual play gets a small horizontal body clearance so conservative scene
    // proxies and curb contacts do not turn a brush into a full stop. Vertical
    // clearance stays exact. Audit environments keep the authored dimensions.
    const gameplayDimensions = Object.freeze({
      halfLength: Math.max(0.1, request.collider.dimensions.halfLength - GAMEPLAY_COLLISION_INSET),
      halfWidth: Math.max(0.1, request.collider.dimensions.halfWidth - GAMEPLAY_COLLISION_INSET),
      halfHeight: request.collider.dimensions.halfHeight,
    });
    await preparationCheckpoint(signal, leaseCurrent);
    const vtol = request.vtol === true;
    // 无支撑落点的悬停地板：全种类面片网格高度（人行道/岛缘/装饰面都算），
    // 否则非道路地面比海面高时，下降的车会沉进地里（用户实测非道路降落问题）。
    const ALL_SURFACE_KINDS = ["carriageway", "junction", "bridge-deck", "ramp", "expressway-deck", "sidewalk", "island", "decor"] as const;
    const vtolFloorAt = (x: number, z: number): number => {
      const query = surfaceIndex.query({ x, z, layerId: "ground", kinds: ALL_SURFACE_KINDS });
      const surfaceHeight = query.status === "hit" ? query.hit.point.y :
        query.status === "ambiguous" ? Math.max(...query.candidates.map((candidate) => candidate.point.y)) : 0;
      const terrainHeight = staticSnapshot.layout.terrain.height(x, z);
      return Math.max(surfaceHeight, Number.isFinite(terrainHeight) ? terrainHeight : 0);
    };
    // VTOL 与默认会话共用同一冻结世界事实与 gameplay 策略；VTOL 环境在地面段
    // 完全委托连续环境，仅追加垂直离地/空中移动两条查询。
    const environment = await measured("collision-world", () => vtol ? new VtolDrivingEnvironment(regions, {
      surfaceRevision: capture.revision, worldRevision: capture.worldRevision, solidRevision: capture.worldRevision,
      solids: collisionIndex.solids(), dimensions: gameplayDimensions,
      centerHeight: request.collider.centerHeight, isCurrent: leaseCurrent,
    }, GAMEPLAY_DRIVING_FOOTPRINT, GAMEPLAY_FOOTPRINT_PARAMS, {}, { boundarySlide: true, mountablePolicy: "gameplay" }, { floorAt: vtolFloorAt })
      : new ContinuousDrivingEnvironment(regions, {
      surfaceRevision: capture.revision, worldRevision: capture.worldRevision, solidRevision: capture.worldRevision,
      solids: collisionIndex.solids(), dimensions: gameplayDimensions,
      centerHeight: request.collider.centerHeight, isCurrent: leaseCurrent,
    }, GAMEPLAY_DRIVING_FOOTPRINT, GAMEPLAY_FOOTPRINT_PARAMS, {}, { boundarySlide: true, mountablePolicy: "gameplay" }));
    if (mode === "validated") {
      const point = regions.classify(request.x, request.z, request.layerId);
      if (point.status !== "drivable") return unavailable(`spawn:${point.cause}`);
    }
    const spawnStarted = preparationNow();
    await progress("diagnostic-spawn", "started");
    const rawSpawn = mode !== "validated" ? await diagnosticSpawnAsync(snapshot.surface, regions, environment, signal, leaseCurrent,
      (completedCandidates, candidateLimit) => { void progress("diagnostic-spawn", "started", { completedCandidates, candidateLimit }); }, mode === "free-drive" ? request.near : undefined) : (() => {
      const point = regions.classify(request.x, request.z, request.layerId);
      if (point.status !== "drivable") return null;
      const support = environment.place(request.x, request.z, request.heading, point.regionId);
      return support ? { ...(vtol ? initialVtolState(request.x, request.z, request.heading, point.regionId) : initialDrivingState(request.x, request.z, request.heading, point.regionId)), ...support } : null;
    })();
    // 诊断出生只构造 DrivingState：VTOL 会话在此补齐三字段（boost/airborne/verticalSpeed），
    // 否则 undefined 进入物理算术变成 NaN（HUD「Boost NaN」）。
    const spawn = vtol && rawSpawn ? { ...rawSpawn, airborne: false, verticalSpeed: 0, boost: 1 } : rawSpawn;
    try { request.onPreparationMetric?.({ stage: "diagnostic-spawn", durationMs: preparationNow() - spawnStarted }); } catch { /* local diagnostic */ }
    await progress("diagnostic-spawn", "completed");
    if (!spawn) return unavailable(mode === "diagnostic" ? "no-safe-diagnostic-spawn" : mode === "free-drive" ? "no-safe-free-drive-spawn" : "unsafe-car-spawn");
    // VTOL 步进注入：prev/input 的收窄转换只发生在这一个调用点（内核守卫对两种体制同界）。
    const vtolStep: KernelStepFn | null = vtol ? (previous, input, world) =>
      stepVtolDriving(previous as VtolDrivingState, input as VtolInputState, world as unknown as VtolWorld) : null;
    const kernel = new DrivingKernel(environment, { baseSnapshotHash: capture.worldRevision,
      vehicleConfigHash: `${request.collider.vehicleConfigHash}-forgiving-collider-v3-mountable-v${MOUNTABLE_POLICY_VERSION}${vtol ? "-vtol" : ""}`,
      kernelBuildId: `city-car-continuous-gameplay-v3-solid-compiler-v${compiledSolids.compilerVersion}-mountable-v${MOUNTABLE_POLICY_VERSION}${vtol ? `-vtol-v${VTOL_PHYSICS_VERSION}` : ""}`,
      physicsVersion: DRIVING_PHYSICS_VERSION, collisionVersion: DRIVING_COLLISION_VERSION, queryVersion: CONTINUOUS_DRIVING_QUERY_VERSION }, vtolStep ?? undefined);
    // 相机臂从车身出发，车停在桥面板/岛缘等可越实体之上——相机查询必须与会话同用
    // gameplay 越障策略，否则起始立方体在严格策略下即被判重叠，桥上立刻“无法确认净空”。
    const cameraSweep = createCameraCollisionQuery(collisionIndex, "gameplay");
    const adapter = new CarAdapter({ revision: capture.worldRevision, kernel, isCurrent: leaseCurrent,
      validateSpawn: (state) => {
        const placed = environment.place(state.x, state.z, state.heading, state.surfaceId);
        return !!placed && (["y", "pitch", "roll"] as const).every((key) => Math.abs(placed[key] - state[key]) <= 1e-6);
      } }, spawn, (frame) => request.present(frame, lease), cameraSweep);
    transferred = true;
    const entered = await runtime.enter(runtimeLease, adapter);
    return entered ? Object.freeze({ status: "ready", worldRevision: capture.worldRevision, coverage: compiledSolids.coverage, adapter }) : unavailable(runtime.snapshot.reason ?? "runtime-refused");
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "city-car-entry-failed");
  } finally {
    if (!transferred) { signal?.removeEventListener("abort", cancel); lease.release(); }
  }
}
