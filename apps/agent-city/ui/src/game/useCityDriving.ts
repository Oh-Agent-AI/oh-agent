/** React bridge for the frozen city/car runtime. Presentation stays outside React;
 * HUD observes runtime errors and pauses at 10 Hz, including when frames stop. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CityEngine } from "../engine/CityEngine";
import { EMPTY_DRIVING_INPUT, DRIVING_DT, type DrivingState, type DrivingInputState } from "./DrivingSimulation";
import { GameRuntime } from "./runtime/GameRuntime";
import { createCityCarSession, createCityCarDiagnosticSession, createCityCarFreeDriveSession, type CityCarSceneCapability } from "./runtime/createCityCarSession";
import type { CollisionDimensions } from "./driving/CollisionIndex";
import type { CarPresentation } from "./runtime/CarAdapter";
import type { CameraClearanceQuery, ChaseCameraSafety } from "./VehicleChaseCamera";
import type { RuntimeDiagnosticSnapshot } from "./runtime/RuntimeDiagnostics";
import { DrivingEventLog, type DrivingEvent } from "./runtime/DrivingEventLog";
import type { PreparationProgress } from "./runtime/Preparation";
import { noteBusy } from "../host";
import type { VerifiedSpawnCredential } from "./driving/spawnPoints";
import { resolveFormalSpawn, SpawnConfirmationStore, type SpawnCandidateChoice, type SpawnConfirmationBinding, type SpawnConfirmationSnapshot } from "./driving/SpawnConfirmation";

export const CITY_CAR_COLLIDER: Readonly<{ dimensions: CollisionDimensions; centerHeight: number; vehicleConfigHash: string }> = Object.freeze({
  dimensions: Object.freeze({ halfLength: 1.4, halfWidth: 0.7, halfHeight: 0.575 }),
  centerHeight: 0.55, vehicleConfigHash: "city-car-gameplay-v2",
});
export type DrivingHudSnapshot = Readonly<{
  phase: "idle" | "preparing" | "paused" | "running" | "error";
  reason: string | null; speed: number; blocked: boolean; coverage: string | null;
  /** 档位（演练场同口径）：R 倒车 / B 制动 / D 前进 / N 静止；FLY 为 VTOL 空中体制。 */
  gear: "D" | "R" | "B" | "N" | "FLY";
  /** VTOL 会话：高度（=state.y）与助推余量 [0,1]；默认会话为 null。 */
  altitude: number | null; boost: number | null;
}>;
const IDLE_HUD: DrivingHudSnapshot = Object.freeze({ phase: "idle", reason: null, speed: 0, blocked: false, coverage: null, gear: "N", altitude: null, boost: null });
export type DrivingPresentation = (state: Readonly<DrivingState>, blocked: boolean, reason: string | null, frameSeconds: number,
  cameraSweep: CameraClearanceQuery, scene: CityCarSceneCapability) => ChaseCameraSafety | void;

export function useCityDriving(engine: RefObject<CityEngine | null>, options: Readonly<{
  present: DrivingPresentation;
  /** Validator-issued spawn credential; diagnostics use a separate explicit entry below. */
  spawn: VerifiedSpawnCredential | null;
  /** Exact current scene and released-graph identity; absent means formal entry is unavailable. */
  spawnBinding?: SpawnConfirmationBinding | null;
  /** Diagnostic-only callers opt out so UAT never creates confirmation state. */
  confirmationEnabled?: boolean;
  /** VTOL 推进器会话（Space 喷升；仅游玩，审计/正式校验路径不变）。 */
  vtol?: boolean;
  cinemaActive: () => boolean; gameActive: () => boolean; busy: () => boolean;
}>) {
  const [hud, setHud] = useState<DrivingHudSnapshot>(IDLE_HUD);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [preparationProgress, setPreparationProgress] = useState<PreparationProgress | null>(null);
  const [events, setEvents] = useState<readonly DrivingEvent[]>(Object.freeze([]));
  const eventLog = useRef<DrivingEventLog | null>(null);
  if (!eventLog.current) eventLog.current = new DrivingEventLog();
  const runtimeRef = useRef<GameRuntime<DrivingInputState> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const preparing = useRef(false);
  const latest = useRef({ speed: 0, blocked: false, reason: null as string | null, coverage: null as string | null, gear: "N" as DrivingHudSnapshot["gear"], altitude: null as number | null, boost: null as number | null });
  const optionsRef = useRef(options); optionsRef.current = options;
  const confirmationRef = useRef<SpawnConfirmationStore | null>(null);
  if (!confirmationRef.current) confirmationRef.current = new SpawnConfirmationStore();
  const confirmationStore = confirmationRef.current;
  const [spawnConfirmation, setSpawnConfirmation] = useState<SpawnConfirmationSnapshot>(confirmationStore.snapshot);
  const alive = useRef(true);
  const publish = useCallback(() => {
    if (!alive.current) return;
    const snap = runtimeRef.current?.snapshot;
    const phase = preparing.current ? "preparing" : snap?.phase === "disposed" ? "idle" : snap?.phase ?? "idle";
    const next = Object.freeze({ ...latest.current, phase, reason: snap?.reason ?? latest.current.reason });
    setHud((previous) => Object.keys(next).every((key) => previous[key as keyof DrivingHudSnapshot] === next[key as keyof DrivingHudSnapshot]) ? previous : next);
  }, []);
  useEffect(() => {
    alive.current = true;
    if (options.confirmationEnabled === false) return () => { alive.current = false; abortRef.current?.abort(); runtimeRef.current?.dispose(); runtimeRef.current = null; };
    const unsubscribe = confirmationStore.subscribe(() => setSpawnConfirmation(confirmationStore.snapshot));
    return () => { alive.current = false; unsubscribe(); abortRef.current?.abort(); runtimeRef.current?.dispose(); runtimeRef.current = null; };
  }, [confirmationStore, options.confirmationEnabled]);
  useEffect(() => {
    if (options.confirmationEnabled === false) return;
    const binding = options.spawnBinding;
    const current = confirmationStore.snapshot;
    if (!binding) {
      if (current.status !== "unavailable") confirmationStore.markUnavailable("released-graph-unavailable");
      return;
    }
    if ((current.status === "derived" || current.status === "validated" || current.status === "confirmed") &&
      (current.binding.sceneId !== binding.sceneId || current.binding.worldRevision !== binding.worldRevision ||
        current.binding.graphBoundaryHash !== binding.graphBoundaryHash || current.binding.vehicleConfigHash !== binding.vehicleConfigHash)) {
      confirmationStore.invalidate("scene-or-vehicle-changed");
    }
  }, [confirmationStore, options.confirmationEnabled, options.spawnBinding?.sceneId, options.spawnBinding?.worldRevision,
    options.spawnBinding?.graphBoundaryHash, options.spawnBinding?.vehicleConfigHash]);
  useEffect(() => {
    if (hud.phase === "idle") return;
    const timer = window.setInterval(publish, 100);
    return () => window.clearInterval(timer);
  }, [hud.phase, publish]);

  const start = useCallback(async (mode: "formal" | "free-drive" | "diagnostic", vehicle?: Readonly<{ vtol: boolean }>, near?: Readonly<{ x: number; z: number }>): Promise<boolean> => {
    const host = engine.current;
    if (!host || runtimeRef.current) return false;
    if (optionsRef.current.cinemaActive() || optionsRef.current.gameActive() || optionsRef.current.busy()) {
      setEntryError("互斥状态（航拍/游戏/忙碌）中不可驾驶。"); return false;
    }
    const currentOptions = optionsRef.current;
    const authorization = mode === "formal" ? resolveFormalSpawn(confirmationStore, currentOptions.spawnBinding, currentOptions.spawn) : null;
    if (mode === "formal" && !authorization?.ok) {
      setEntryError(authorization?.reason === "released-graph-or-spawn-unavailable"
        ? "正式道路图尚不可用，暂不能开始驾驶。" : "驾驶出生点尚未完成当前场景确认，暂不能开始。"); return false;
    }
    const confirmedSpawn = authorization?.ok ? authorization.credential : null;
    try { await noteBusy(10_000); } catch { /* host pulse is best-effort */ }
    const abort = new AbortController(); abortRef.current = abort;
    const runtime = new GameRuntime<DrivingInputState>({ dt: DRIVING_DT, emptyInput: () => ({ ...EMPTY_DRIVING_INPUT }) }); runtimeRef.current = runtime;
    preparing.current = true;
    setPreparationProgress({ stage: "world-capture", state: "started" });
    eventLog.current!.clear(); setEvents(Object.freeze([]));
    latest.current = { speed: 0, blocked: false, reason: null, coverage: null, gear: "N", altitude: null, boost: null };
    setEntryError(null); setHud({ ...IDLE_HUD, phase: "preparing" });
    const request = { collider: CITY_CAR_COLLIDER, vtol: vehicle?.vtol ?? (currentOptions.vtol === true), near, onPreparationMetric: runtime.recordPreparation.bind(runtime),
      onPreparationProgress: async (value: PreparationProgress) => {
        if (value.state === "started") { try { await noteBusy(10_000); } catch { /* host pulse is best-effort */ } }
        setPreparationProgress(value);
      }, present: (frame: CarPresentation, scene: CityCarSceneCapability) => {
      const s = frame.state;
      latest.current = { ...latest.current, speed: Math.abs(frame.state.speed), blocked: frame.blocked, reason: frame.reason,
        altitude: Number.isFinite(s.boost) ? (s.y ?? null) : null, boost: Number.isFinite(s.boost) ? (s.boost ?? null) : null,
        gear: s.airborne === true ? "FLY" : frame.state.reversing ? "R" : frame.state.braking ? "B" : frame.state.speed > 0 ? "D" : "N" };
      const kind = frame.queryStatus === "unresolved" ? "unresolved" : frame.reason === "contact" ? "contact" : frame.blocked ? "blocked" : null;
      if (kind) {
        const event = eventLog.current!.record({ atMs: typeof performance !== "undefined" ? performance.now() : Date.now(), kind,
          x: s.x, y: s.y, z: s.z, reason: frame.reason, obstacleIds: frame.contactIds });
        if (event) setEvents(eventLog.current!.snapshot());
      }
      const cameraSafety = optionsRef.current.present(frame.state, frame.blocked, frame.reason, frame.frameSeconds, frame.cameraSweep, scene);
      if (cameraSafety) {
        runtime.noteCameraSafety(cameraSafety);
        if (cameraSafety === "unresolved") {
          const event = eventLog.current!.record({ atMs: typeof performance !== "undefined" ? performance.now() : Date.now(), kind: "camera-safety",
            x: s.x, y: s.y, z: s.z, reason: "camera-clearance-unresolved", obstacleIds: [] });
          if (event) setEvents(eventLog.current!.snapshot());
        }
      }
      if (cameraSafety === "unresolved") runtime.pause("camera-safety");
    } };
    try {
      const entry = mode === "diagnostic" ? await createCityCarDiagnosticSession(host, runtime, request, abort.signal)
        : mode === "free-drive" ? await createCityCarFreeDriveSession(host, runtime, request, abort.signal)
        : await createCityCarSession(host, runtime, { ...request, x: confirmedSpawn!.x, z: confirmedSpawn!.z, heading: confirmedSpawn!.heading,
          layerId: confirmedSpawn!.layerId, validatedSpawn: confirmedSpawn! }, abort.signal);
      if (abort.signal.aborted || runtimeRef.current !== runtime || !alive.current) { runtime.dispose(); return false; }
      preparing.current = false;
      setPreparationProgress(null);
      if (entry.status !== "ready") {
        runtime.dispose(); runtimeRef.current = null;
        setEntryError(`暂不能开始驾驶：${entry.reason}`); publish(); return false;
      }
      latest.current.coverage = entry.coverage; publish(); return true;
    } catch (error) {
      runtime.dispose();
      if (runtimeRef.current === runtime) { runtimeRef.current = null; preparing.current = false; setPreparationProgress(null); }
      if (alive.current && !abort.signal.aborted) { setEntryError(`暂不能开始驾驶：${error instanceof Error ? error.message : "city-driving-entry-failed"}`); publish(); }
      return false;
    }
  }, [confirmationStore, engine, publish]);
  const exit = useCallback(() => {
    abortRef.current?.abort(); abortRef.current = null;
    preparing.current = false; setPreparationProgress(null);
    runtimeRef.current?.dispose(); runtimeRef.current = null;
    latest.current = { speed: 0, blocked: false, reason: null, coverage: null, gear: "N", altitude: null, boost: null }; publish();
  }, [publish]);
  const pause = useCallback((reason = "user-paused") => { runtimeRef.current?.pause(reason); publish(); }, [publish]);
  const resume = useCallback(() => { runtimeRef.current?.resume(); publish(); }, [publish]);
  const toggle = useCallback(() => {
    if (runtimeRef.current?.snapshot.phase === "running") pause(); else resume();
  }, [pause, resume]);
  const setInput = useCallback((input: Partial<DrivingInputState>) => { runtimeRef.current?.setInput({ ...EMPTY_DRIVING_INPUT, ...input }); }, []);
  const deriveSpawnCandidates = useCallback((binding: SpawnConfirmationBinding, candidates: readonly SpawnCandidateChoice[]) => optionsRef.current.confirmationEnabled === false ? false : confirmationStore.derive(binding, candidates), [confirmationStore]);
  const validateSpawnCandidate = useCallback((binding: SpawnConfirmationBinding, credential: VerifiedSpawnCredential) => optionsRef.current.confirmationEnabled === false ? false : confirmationStore.validate(binding, credential), [confirmationStore]);
  const confirmSpawn = useCallback((binding: SpawnConfirmationBinding, spawnId: string) => optionsRef.current.confirmationEnabled === false ? false : confirmationStore.confirm(binding, spawnId), [confirmationStore]);
  const cancelSpawn = useCallback(() => { if (optionsRef.current.confirmationEnabled !== false) confirmationStore.cancel(); }, [confirmationStore]);
  const invalidateSpawn = useCallback((reason?: string) => { if (optionsRef.current.confirmationEnabled !== false) confirmationStore.invalidate(reason); }, [confirmationStore]);
  const diagnostics = useCallback((): RuntimeDiagnosticSnapshot | null => runtimeRef.current?.diagnostics ?? null, []);
  return { hud, entryError, preparationProgress, events, clearEntryError: () => setEntryError(null), spawnConfirmation,
    deriveSpawnCandidates, validateSpawnCandidate, confirmSpawn, cancelSpawn, invalidateSpawn,
    enter: () => start("formal"), enterFreeDrive: (vehicle?: Readonly<{ vtol: boolean }>, near?: Readonly<{ x: number; z: number }>) => start("free-drive", vehicle, near), enterDiagnostic: () => start("diagnostic"), exit, pause, resume, toggle, setInput, diagnostics, physicsStep: DRIVING_DT };
}
