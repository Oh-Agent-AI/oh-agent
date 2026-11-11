/** Player-facing free-drive UI. The session chooses a safe local spawn, while
 * road-wide audit/release evidence remains a separate system. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CityEngine } from "../engine/CityEngine";
import type { CityActivityCoordinator } from "./activity/CityActivityCoordinator";
import { createCheckpointRacePlan, CheckpointRaceControllerV1, type CheckpointRaceSnapshotV1 } from "./activity/checkpointRace";
import { CheckpointRaceVisuals } from "./activity/CheckpointRaceVisuals";
import { createZoneCollectPlan, ZoneCollectControllerV1 } from "./activity/zoneCollect";
import { createCreatorMiniGamePlan, CreatorMiniGameDrivingControllerV1, type CreatorPublishedMiniGameV1 } from "./activity/creatorMiniGame";
import { compileCreatorSceneColliders } from "./activity/creatorSceneColliders";
import { CreatorColliderDebugVisuals } from "./activity/creatorColliderDebugVisuals";
import type { SolidInput } from "./driving/CollisionIndex";
import { CarVisuals } from "./CarVisuals";
import { useCityDriving } from "./useCityDriving";
import { DRIVING_PARAMS, EMPTY_DRIVING_INPUT } from "./DrivingSimulation";
import type { VtolInputState } from "./driving/vtolDriving";
import { KeyboardInput } from "./runtime/KeyboardInput";
import type { InputInterrupt } from "./runtime/KeyboardInput";
import { DrivingSfx } from "./driving/DrivingSfx";
import type { CityCarSceneCapability } from "./runtime/createCityCarSession";
import type { CameraClearanceQuery } from "./VehicleChaseCamera";
import { closeOpenGameDisclosure } from "./ui/closeOpenDisclosure";
import { noteBusy } from "../host";
import { roadValidationReport, type RoadValidationReport } from "./roadValidation";
import { m as worldUnits } from "../engine/worldScale";
import type { VisualPlaytestEvidenceV1 } from "@agent-vitals/city-sdk";

type DrivingMiniGameController = Readonly<{ snapshot: CheckpointRaceSnapshotV1; fixedStep(position: Readonly<{ x: number; y: number; z: number }>): void; dispose(): void;
  visualEvidence?(releaseId: string, projectRevision: number, snapshotDigest: string): VisualPlaytestEvidenceV1 }>;
type CreatorPlaytestContext = Readonly<{ runId: string; releaseId: string; projectId: string; revision: number; snapshotDigest: string }>;

export function useCityDrivingPlay(engine: RefObject<CityEngine | null>, host: Readonly<{
  cinemaActive(): boolean; gameActive(): boolean; busy(): boolean; activityCoordinator: CityActivityCoordinator;
}>, options: Readonly<{ notifyHostBusy?: boolean; creatorExperiences?: readonly CreatorPublishedMiniGameV1[]; playtestContext?: CreatorPlaytestContext;
  finishPlaytest?: (runId: string, status: "completed" | "cancelled" | "failed", evidence?: VisualPlaytestEvidenceV1, failureCode?: string) => Promise<void> }> = {}) {
  const visuals = useRef<CarVisuals | null>(null);
  const visualScene = useRef<CityCarSceneCapability | null>(null);
  const inputSource = useRef<KeyboardInput<VtolInputState> | null>(null);
  const blockedSeen = useRef(false);
  const sfxRef = useRef<DrivingSfx | null>(null);
  const [soundVolume, setSoundVolumeState] = useState(0.7);
  const [sfxEnabled, setSfxEnabled] = useState(true);
  const [soundAvailable, setSoundAvailable] = useState(false);
  const [initialPaused, setInitialPaused] = useState(false);
  const [choosingVehicle, setChoosingVehicle] = useState(false);
  const [vtol, setVtol] = useState(false);
  const [race, setRace] = useState<CheckpointRaceSnapshotV1 | null>(null);
  const [raceEntryError, setRaceEntryError] = useState<string | null>(null);
  const raceControllerRef = useRef<DrivingMiniGameController | null>(null);
  const [activityKind, setActivityKind] = useState<"race" | "collect" | "creator" | null>(null);
  const [activityTitle, setActivityTitle] = useState<string | null>(null);
  const raceVisualsRef = useRef<CheckpointRaceVisuals | null>(null);
  const raceVisualSceneRef = useRef<CityCarSceneCapability | null>(null);
  const creatorColliderVisualsRef = useRef<CreatorColliderDebugVisuals | null>(null);
  const creatorColliderVisualSceneRef = useRef<CityCarSceneCapability | null>(null);
  const racePauseRef = useRef<((reason?: string) => void) | null>(null);
  const racePauseQueuedRef = useRef(false);
  const exitCarRef = useRef<(() => void) | null>(null);
  const creatorSkinTokenRef = useRef<ReturnType<CityEngine["applyCreatorSkin"]> | null>(null);
  const creatorGameActiveRef = useRef(false);
  const creatorCollisionRef = useRef<Readonly<{ revision: string; solids: readonly SolidInput[] }> | null>(null);
  const restoreCreatorSkin = useCallback(() => {
    const token = creatorSkinTokenRef.current;
    creatorSkinTokenRef.current = null;
    if (token) engine.current?.restoreCreatorSkin(token);
  }, [engine]);
  const removeCreatorColliderVisuals = useCallback(() => {
    const debug = creatorColliderVisualsRef.current;
    if (debug) creatorColliderVisualSceneRef.current?.detach([debug.root]);
    debug?.dispose(); creatorColliderVisualsRef.current = null; creatorColliderVisualSceneRef.current = null;
  }, []);
  const playtestRef = useRef<{ runId: string; started: boolean; finishRequested: boolean; controller: DrivingMiniGameController | null } | null>(null);
  const playtestContextRef = useRef(options.playtestContext);
  playtestContextRef.current = options.playtestContext;
  if (options.playtestContext?.runId && playtestRef.current?.runId !== options.playtestContext.runId) {
    playtestRef.current = { runId: options.playtestContext.runId, started: false, finishRequested: false, controller: null };
  } else if (!options.playtestContext?.runId && playtestRef.current) playtestRef.current = null;
  const finishPlaytestRef = useRef(options.finishPlaytest);
  finishPlaytestRef.current = options.finishPlaytest;
  const finishPlaytestOnce = useCallback((status: "completed" | "cancelled" | "failed", failureCode?: string, includeEvidence = true) => {
    const current = playtestRef.current;
    if (!current?.started || current.finishRequested) return;
    current.finishRequested = true;
    const context = playtestContextRef.current;
    const evidence = includeEvidence && context ? current.controller?.visualEvidence?.(context.releaseId, context.revision, context.snapshotDigest) : undefined;
    void finishPlaytestRef.current?.(current.runId, status, evidence, failureCode).catch(() => {});
  }, []);
  const onFixedStep = useCallback((position: Readonly<{ x: number; y: number; z: number }>) => {
    const controller = raceControllerRef.current;
    if (!controller) return;
    controller.fixedStep(position);
    raceVisualsRef.current?.setProgress(controller.snapshot.completed);
    if (["success", "failure", "error"].includes(controller.snapshot.status) && !racePauseQueuedRef.current) {
      racePauseQueuedRef.current = true;
      queueMicrotask(() => {
        if (creatorGameActiveRef.current) {
          const playtest = playtestRef.current?.started === true;
          if (playtest) {
            creatorGameActiveRef.current = false;
            creatorCollisionRef.current = null;
            removeCreatorColliderVisuals();
            exitCarRef.current?.();
            restoreCreatorSkin();
            finishPlaytestOnce(controller.snapshot.status === "success" ? "completed" : "failed", controller.snapshot.reason ?? "creator_minigame_failed");
          }
        }
        racePauseRef.current?.("race-finished");
      });
    }
  }, [finishPlaytestOnce, removeCreatorColliderVisuals, restoreCreatorSkin]);
  /** 这一趟开的车的颜色：从地标停车场出发时是那个城区 harness 楼的颜色，其余入口用默认车色。 */
  const carColorRef = useRef<string | undefined>(undefined);
  /** 车的最新位姿（小地图画「我在哪」）：每帧 present 写，退出驾驶清空。 */
  const poseRef = useRef<Readonly<{ x: number; z: number; heading: number }> | null>(null);
  const [roadCheck, setRoadCheck] = useState<RoadValidationReport | null>(null);
  const removeVisuals = useCallback(() => {
    const currentVisuals = visuals.current;
    if (currentVisuals) visualScene.current?.detach([currentVisuals.root]);
    currentVisuals?.dispose(); visuals.current = null; visualScene.current = null; blockedSeen.current = false;
  }, []);
  const car = useCityDriving(engine, {
    ...host, spawn: null, confirmationEnabled: false, notifyHostBusy: options.notifyHostBusy,
    additionalSolids: () => creatorCollisionRef.current,
    onFixedStep,
    present: (state, blocked, _reason, frameSeconds, cameraSweep: CameraClearanceQuery, scene: CityCarSceneCapability) => {
      const current = engine.current;
      if (!current) return;
      if (raceVisualsRef.current && raceVisualSceneRef.current !== scene) {
        raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
        scene.attach([raceVisualsRef.current.root]); raceVisualSceneRef.current = scene;
      }
      if (creatorColliderVisualsRef.current && creatorColliderVisualSceneRef.current !== scene) {
        creatorColliderVisualSceneRef.current?.detach([creatorColliderVisualsRef.current.root]);
        scene.attach([creatorColliderVisualsRef.current.root]); creatorColliderVisualSceneRef.current = scene;
      }
      poseRef.current = { x: state.x, z: state.z, heading: state.heading };
      if (!visuals.current) { visuals.current = new CarVisuals(carColorRef.current); visualScene.current = scene; scene.attach([visuals.current.root]); }
      // 撞击反馈与音效都只在接触上升沿触发，不把 blocked 持续帧当多次碰撞。
      if (blocked && !blockedSeen.current) {
        visuals.current.pulseImpact(); current.pulseDrivingImpact();
        if (phaseRef.current === "running" && sfxEnabledRef.current) sfxRef.current?.collision();
      }
      blockedSeen.current = blocked;
      // 推进器强度由上升速度驱动：喷焰/嘶声随推进长大、松开收缩（物理直觉，无输入回声字段）。
      const vtolState = state as typeof state & Readonly<{ verticalSpeed?: number }>;
      const thruster = Math.max(0, Math.min(1, (vtolState.verticalSpeed ?? 0) / 4));
      if (phaseRef.current === "running") sfxRef.current?.update({ speed: state.speed, maxSpeed: DRIVING_PARAMS.maxForward,
        braking: state.braking, reversing: state.reversing, rainIntensity: current.environmentState?.rainIntensity ?? 0, thruster });
      visuals.current.update({ ...state, thruster }); return current.presentDrivingCamera(state, frameSeconds, cameraSweep, scene);
    },
  });
  exitCarRef.current = car.exit;
  racePauseRef.current = car.pause;
  const phaseRef = useRef(car.hud.phase);
  const soundVolumeRef = useRef(soundVolume); soundVolumeRef.current = soundVolume;
  const sfxEnabledRef = useRef(sfxEnabled); sfxEnabledRef.current = sfxEnabled;
  phaseRef.current = car.hud.phase;
  const active = choosingVehicle || car.hud.phase !== "idle";
  const captureRoadCheck = useCallback(() => {
    const layout = engine.current?.currentLayout;
    setRoadCheck(layout ? roadValidationReport(layout) : null);
  }, [engine]);
  const enter = useCallback(() => { car.clearEntryError(); carColorRef.current = undefined; setChoosingVehicle(true); }, [car.clearEntryError]);
  /** 点了地标停车场里的车：不弹选车，就开这辆（地面车、城区配色），出生点从离这座地标最近的路找起。 */
  const enterAt = useCallback((origin: Readonly<{ x: number; z: number; color: string }>) => {
    car.clearEntryError(); carColorRef.current = origin.color;
    setChoosingVehicle(false); setVtol(false); setInitialPaused(false);
    void car.enterFreeDrive({ vtol: false }, { x: origin.x, z: origin.z }).then((ready) => { if (ready) { captureRoadCheck(); setInitialPaused(true); } });
  }, [car.clearEntryError, car.enterFreeDrive, captureRoadCheck]);
  const selectVehicle = useCallback((fly: boolean) => {
    raceControllerRef.current?.dispose(); raceControllerRef.current = null; racePauseQueuedRef.current = false; setRace(null); setActivityKind(null); setActivityTitle(null); setRaceEntryError(null);
    if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
    raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
    carColorRef.current = undefined; setChoosingVehicle(false); setVtol(fly); setInitialPaused(false);
    void car.enterFreeDrive({ vtol: fly }).then((ready) => { if (ready) { captureRoadCheck(); setInitialPaused(true); } });
  }, [car.enterFreeDrive, captureRoadCheck]);
  const startRace = useCallback(() => {
    const current = engine.current;
    const view = current?.getCitySdkLayoutView();
    if (!current || !view) { setRaceEntryError("当前城市场景尚未准备好，无法生成竞速路线。"); return; }
    const plan = createCheckpointRacePlan(view, view.seed);
    if (!plan.ok) { setRaceEntryError(plan.diagnostics[0]?.message ?? "当前道路网络无法生成三检查点路线。"); return; }
    raceControllerRef.current?.dispose(); racePauseQueuedRef.current = false;
    const controller = new CheckpointRaceControllerV1(plan.value, setRace);
    raceControllerRef.current = controller;
    if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
    raceVisualsRef.current?.dispose(); raceVisualsRef.current = new CheckpointRaceVisuals(plan.value.checkpointGeometry); raceVisualSceneRef.current = null;
    setRace(controller.snapshot); setActivityKind("race"); setActivityTitle(null); setRaceEntryError(null); setChoosingVehicle(false); setVtol(false); setInitialPaused(false);
    carColorRef.current = undefined;
    const startPosition = { x: worldUnits(plan.value.course.startPositionMeters.x), z: worldUnits(plan.value.course.startPositionMeters.z) };
    void car.enterFreeDrive({ vtol: false }, startPosition).then(ready => {
      if (ready) {
        const actualSpawn = poseRef.current;
        if (!actualSpawn || Math.hypot(actualSpawn.x - startPosition.x, actualSpawn.z - startPosition.z) > 40) {
          car.exit(); controller.dispose(); if (raceControllerRef.current === controller) raceControllerRef.current = null; setRace(null);
          if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
          raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
          setRaceEntryError("安全出生点离竞速起点太远，未开始竞速。"); setChoosingVehicle(true); return;
        }
        captureRoadCheck(); setInitialPaused(true);
      }
      else {
        controller.dispose(); if (raceControllerRef.current === controller) raceControllerRef.current = null; setRace(null);
        if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
        raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
      }
    });
  }, [car.enterFreeDrive, car.exit, captureRoadCheck, engine]);
  const startCollect = useCallback(() => {
    const current = engine.current;
    const view = current?.getCitySdkLayoutView();
    if (!current || !view) { setRaceEntryError("当前城市场景尚未准备好，无法生成寻宝路线。"); return; }
    const plan = createZoneCollectPlan(view);
    if (!plan.ok) { setRaceEntryError(plan.diagnostics[0]?.message ?? "当前道路网络无法生成寻宝路线。"); return; }
    raceControllerRef.current?.dispose(); racePauseQueuedRef.current = false;
    const controller = new ZoneCollectControllerV1(plan.value, setRace);
    raceControllerRef.current = controller;
    if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
    raceVisualsRef.current?.dispose(); raceVisualsRef.current = new CheckpointRaceVisuals(plan.value.checkpointGeometry); raceVisualSceneRef.current = null;
    setRace(controller.snapshot); setActivityKind("collect"); setActivityTitle(null); setRaceEntryError(null); setChoosingVehicle(false); setVtol(false); setInitialPaused(false);
    carColorRef.current = undefined;
    const startPosition = { x: worldUnits(plan.value.course.startPositionMeters.x), z: worldUnits(plan.value.course.startPositionMeters.z) };
    void car.enterFreeDrive({ vtol: false }, startPosition).then(ready => {
      if (ready) {
        const actualSpawn = poseRef.current;
        if (!actualSpawn || Math.hypot(actualSpawn.x - startPosition.x, actualSpawn.z - startPosition.z) > 40) {
          car.exit(); controller.dispose(); if (raceControllerRef.current === controller) raceControllerRef.current = null; setRace(null); setActivityKind(null);
          raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
          setRaceEntryError("安全出生点离寻宝起点太远，未开始寻宝。"); setChoosingVehicle(true); return;
        }
        captureRoadCheck(); setInitialPaused(true);
      } else {
        controller.dispose(); if (raceControllerRef.current === controller) raceControllerRef.current = null; setRace(null); setActivityKind(null);
        raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
      }
    });
  }, [car.enterFreeDrive, car.exit, captureRoadCheck, engine]);
  const startCreatorGame = useCallback((releaseId: string, mountId: string) => {
    const pendingPlaytest = playtestRef.current;
    if (pendingPlaytest && !pendingPlaytest.finishRequested) pendingPlaytest.started = true;
    const failPlaytest = (failureCode = "creator_playtest_start_failed") => { creatorGameActiveRef.current = false; creatorCollisionRef.current = null; removeCreatorColliderVisuals(); restoreCreatorSkin(); finishPlaytestOnce("failed", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(failureCode) ? failureCode : "creator_playtest_start_failed", false); };
    const current = engine.current;
    const view = current?.getCitySdkLayoutView();
    const experience = options.creatorExperiences?.find(item => item.releaseId === releaseId && item.mount.mountId === mountId);
    if (!current || !view || !experience) { failPlaytest("creator_playtest_experience_unavailable"); setRaceEntryError("这个已发布小游戏不在当前城市版本中，请重新打开 City。"); setChoosingVehicle(true); return; }
    const plan = createCreatorMiniGamePlan(view, experience);
    if (!plan.ok) { failPlaytest(plan.diagnostics[0]?.code ?? "creator_game_plan_invalid"); setRaceEntryError(plan.diagnostics[0]?.message ?? "小游戏与当前城市不兼容。"); setChoosingVehicle(true); return; }
    try {
      creatorCollisionRef.current = compileCreatorSceneColliders(experience);
      removeCreatorColliderVisuals();
      if (playtestRef.current?.started) creatorColliderVisualsRef.current = new CreatorColliderDebugVisuals(creatorCollisionRef.current.solids);
    }
    catch (error) { failPlaytest(error instanceof Error ? error.message : "creator_scene_collider_invalid"); setRaceEntryError(error instanceof Error ? error.message : "小游戏碰撞代理无效。"); setChoosingVehicle(true); return; }
    const entryAnchor = view.layout.anchors.find(anchor => anchor.id === plan.value.mount.entryAnchorId);
    const entryGeometry = entryAnchor ? view.geometry.get(entryAnchor.geometryRef) : null;
    if (!entryAnchor || entryAnchor.kind !== "spawn" || !entryAnchor.capabilities.includes("drive") || !entryGeometry) {
      failPlaytest("creator_entry_spawn_unavailable"); setRaceEntryError("小游戏入口锚点缺少可信的驾驶出生位置。"); setChoosingVehicle(true); return;
    }
    restoreCreatorSkin();
    try {
      if (experience.skinId) creatorSkinTokenRef.current = current.applyCreatorSkin(experience.skinId);
    } catch {
      failPlaytest("creator_skin_apply_failed"); setRaceEntryError("这个小游戏的皮肤无法应用到当前 City。"); setChoosingVehicle(true); return;
    }
    raceControllerRef.current?.dispose(); racePauseQueuedRef.current = false;
    const controller = new CreatorMiniGameDrivingControllerV1(plan.value, setRace);
    raceControllerRef.current = controller;
    if (pendingPlaytest) pendingPlaytest.controller = controller;
    creatorGameActiveRef.current = true;
    raceVisualsRef.current?.dispose(); raceVisualsRef.current = new CheckpointRaceVisuals(Object.values(plan.value.zones).flat().map(zone => ({ ...zone, facingRadians: 0 })));
    raceVisualSceneRef.current = null;
    setRace(controller.snapshot); setActivityKind("creator"); setActivityTitle(experience.title); setRaceEntryError(null);
    setChoosingVehicle(false); setVtol(false); setInitialPaused(false); carColorRef.current = undefined;
    const startPosition = { x: worldUnits(entryGeometry.positionMeters.x), z: worldUnits(entryGeometry.positionMeters.z) };
    void car.enterFreeDrive({ vtol: false }, startPosition).then(ready => {
      if (ready) {
        const actualSpawn = poseRef.current;
        if (!actualSpawn || Math.hypot(actualSpawn.x - startPosition.x, actualSpawn.z - startPosition.z) > 40) {
          car.exit(); controller.dispose(); if (raceControllerRef.current === controller) raceControllerRef.current = null;
          failPlaytest("creator_spawn_distance_exceeded");
          setRace(null); setActivityKind(null); setActivityTitle(null); raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
          setRaceEntryError("安全出生点离小游戏入口太远，未开始游戏。"); setChoosingVehicle(true); return;
        }
        captureRoadCheck(); setInitialPaused(true);
      } else {
        failPlaytest(car.getLastEntryFailure() ?? "creator_city_drive_entry_unavailable");
        controller.dispose(); if (raceControllerRef.current === controller) raceControllerRef.current = null;
        setRace(null); setActivityKind(null); setActivityTitle(null); raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
      }
    });
  }, [car.enterFreeDrive, car.exit, car.getLastEntryFailure, captureRoadCheck, engine, options.creatorExperiences, finishPlaytestOnce, removeCreatorColliderVisuals, restoreCreatorSkin]);
  const resume = useCallback(() => {
    inputSource.current?.clear();
    const start = () => {
      if (!sfxRef.current) sfxRef.current = new DrivingSfx();
      const sfx = sfxRef.current;
      sfx.setVolume(soundVolumeRef.current); sfx.setMuted(!sfxEnabledRef.current); sfx.resume();
      setSoundAvailable(sfx.available);
      setInitialPaused(false); car.resume();
    };
    // First AudioContext on WKWebView can block the plugin thread for seconds.
    if (sfxRef.current) start();
    else if (options.notifyHostBusy === false) start();
    else void noteBusy(8_000).catch(() => {}).finally(start);
  }, [car.resume]);
  const focusCanvas = useCallback(() => {
    const canvas = engine.current?.domCanvas;
    if (canvas instanceof HTMLCanvasElement) canvas.focus({ preventScroll: true });
  }, [engine]);
  useEffect(() => {
    if (car.hud.phase === "running") focusCanvas();
  }, [car.hud.phase, focusCanvas]);
  const pause = useCallback((reason?: string) => { inputSource.current?.clear(); car.pause(reason); sfxRef.current?.suspend(); }, [car.pause]);
  const exit = useCallback(() => { const creatorGame = creatorGameActiveRef.current; creatorGameActiveRef.current = false; creatorCollisionRef.current = null; removeCreatorColliderVisuals(); setChoosingVehicle(false); inputSource.current?.clear(); car.exit(); if (creatorGame) restoreCreatorSkin(); finishPlaytestOnce("cancelled"); raceControllerRef.current?.dispose(); raceControllerRef.current = null; racePauseQueuedRef.current = false; setRace(null); setActivityKind(null); setActivityTitle(null); setRaceEntryError(null);
    if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
    raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
    removeVisuals(); sfxRef.current?.dispose(); sfxRef.current = null; setSoundAvailable(false); setInitialPaused(false); setRoadCheck(null); }, [car.exit, removeVisuals, finishPlaytestOnce, removeCreatorColliderVisuals, restoreCreatorSkin]);
  const openUiContext = useCallback(() => { inputSource.current?.clear(); if (phaseRef.current === "running") car.pause(); sfxRef.current?.suspend(); }, [car.pause]);
  useEffect(() => {
    if (car.hud.phase !== "running") { inputSource.current?.clear(); sfxRef.current?.suspend(); }
  }, [car.hud.phase]);
  useEffect(() => {
    if (car.hud.phase === "idle" || car.hud.phase === "error") { removeVisuals(); poseRef.current = null; }
  }, [car.hud.phase, removeVisuals]);
  useEffect(() => {
    if (car.hud.phase !== "error") return;
    creatorCollisionRef.current = null;
    removeCreatorColliderVisuals();
    if (creatorGameActiveRef.current) {
      creatorGameActiveRef.current = false;
      restoreCreatorSkin();
      finishPlaytestOnce("failed", "creator_city_driving_runtime_error");
    }
    // A stale/invalidated City lease ends the race as well as the car session.
    // Remove its scene-owned markers immediately; waiting for the user to press
    // Exit would leave old checkpoint geometry attached to an invalid world.
    raceControllerRef.current?.dispose(); raceControllerRef.current = null; racePauseQueuedRef.current = false;
    if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
    raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null;
    setRace(null); setActivityKind(null);
  }, [car.hud.phase, finishPlaytestOnce, removeCreatorColliderVisuals, restoreCreatorSkin]);
  useEffect(() => removeVisuals, [removeVisuals]);
  useEffect(() => {
    if (!active || choosingVehicle) return;
    const source = new KeyboardInput<VtolInputState>({
      keys: { KeyW: "forward", ArrowUp: "forward", KeyS: "backward", ArrowDown: "backward", KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right", ...(vtol ? { Space: "thruster" as const } : {}) },
      emptyInput: () => ({ ...EMPTY_DRIVING_INPUT, thruster: false }), capture: true,
      blurFocusTarget: () => {
        const target = engine.current?.domCanvas;
        return target instanceof HTMLElement ? target : null;
      },
      isFocused: () => document.hasFocus() && document.visibilityState !== "hidden",
      onInput: car.setInput,
      onInterrupt: (reason: InputInterrupt) => {
        inputSource.current?.clear(); sfxRef.current?.suspend();
        if (reason === "host-suspended") exit();
        else if (reason === "focus-lost" || reason === "host-hidden") car.pause(reason);
      },
      onCommand: (event) => {
        if (event.code === "Escape") {
          event.preventDefault(); event.stopImmediatePropagation();
          if (event.repeat) return true;
          if (closeOpenGameDisclosure()) return true;
          if (phaseRef.current === "preparing") exit();
          else if (phaseRef.current === "running") pause();
          else if (phaseRef.current === "paused") resume();
          return true;
        }
        if (!vtol && event.code === "Space" && !(event.target instanceof HTMLElement && event.target.closest("button, summary, input, select, [role='dialog']"))) {
          event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) { source.clear(); if (phaseRef.current === "running") pause(); else if (phaseRef.current === "paused") resume(); } return true;
        }
        return false;
      },
    });
    inputSource.current = source; source.attach();
    const canvas = engine.current?.domCanvas;
    canvas?.addEventListener("webglcontextlost", exit);
    return () => { source.detach(); if (inputSource.current === source) inputSource.current = null; canvas?.removeEventListener("webglcontextlost", exit); };

  }, [active, choosingVehicle, vtol, car.setInput, engine, exit, pause, resume]);
  useEffect(() => () => { sfxRef.current?.dispose(); sfxRef.current = null; raceControllerRef.current?.dispose(); raceControllerRef.current = null;
    creatorGameActiveRef.current = false; creatorCollisionRef.current = null; removeCreatorColliderVisuals(); creatorSkinTokenRef.current = null;
    if (raceVisualsRef.current) raceVisualSceneRef.current?.detach([raceVisualsRef.current.root]);
    raceVisualsRef.current?.dispose(); raceVisualsRef.current = null; raceVisualSceneRef.current = null; }, [finishPlaytestOnce, removeCreatorColliderVisuals, restoreCreatorSkin]);
  const setSoundVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value)); soundVolumeRef.current = next; setSoundVolumeState(next); sfxRef.current?.setVolume(next);
  }, []);
  const toggleSfx = useCallback(() => { const next = !sfxEnabledRef.current; sfxEnabledRef.current = next; setSfxEnabled(next); sfxRef.current?.setMuted(!next); }, []);
  const sound = soundAvailable ? { volume: soundVolume, onVolume: setSoundVolume, sfx: { enabled: sfxEnabled, onToggle: toggleSfx } } : undefined;
  const pose = useCallback(() => poseRef.current, []);
  return { ...car, active, choosingVehicle, vtol, selectVehicle, startRace, startCollect, startCreatorGame, activityKind, activityTitle,
    creatorGames: options.creatorExperiences?.filter(item => item.entryPositionWorld).map(item => ({ releaseId: item.releaseId, mountId: item.mount.mountId, title: item.title, at: item.entryPositionWorld! })) ?? [],
    race, raceEntryError, enter, enterAt, exit, resume, pause, openUiContext, initialPaused, sound, pose, roadCheck };
}
