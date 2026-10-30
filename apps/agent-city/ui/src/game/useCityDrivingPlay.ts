/** Player-facing free-drive UI. The session chooses a safe local spawn, while
 * road-wide audit/release evidence remains a separate system. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CityEngine } from "../engine/CityEngine";
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

export function useCityDrivingPlay(engine: RefObject<CityEngine | null>, host: Readonly<{
  cinemaActive(): boolean; gameActive(): boolean; busy(): boolean;
}>) {
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
    ...host, spawn: null, confirmationEnabled: false,
    present: (state, blocked, _reason, frameSeconds, cameraSweep: CameraClearanceQuery, scene: CityCarSceneCapability) => {
      const current = engine.current;
      if (!current) return;
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
    carColorRef.current = undefined; setChoosingVehicle(false); setVtol(fly); setInitialPaused(false);
    void car.enterFreeDrive({ vtol: fly }).then((ready) => { if (ready) { captureRoadCheck(); setInitialPaused(true); } });
  }, [car.enterFreeDrive, captureRoadCheck]);
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
    else void noteBusy(8_000).catch(() => {}).finally(start);
  }, [car.resume]);
  const pause = useCallback((reason?: string) => { inputSource.current?.clear(); car.pause(reason); sfxRef.current?.suspend(); }, [car.pause]);
  const exit = useCallback(() => { setChoosingVehicle(false); inputSource.current?.clear(); car.exit(); removeVisuals(); sfxRef.current?.dispose(); sfxRef.current = null; setSoundAvailable(false); setInitialPaused(false); setRoadCheck(null); }, [car.exit, removeVisuals]);
  const openUiContext = useCallback(() => { inputSource.current?.clear(); if (phaseRef.current === "running") car.pause(); sfxRef.current?.suspend(); }, [car.pause]);
  useEffect(() => {
    if (car.hud.phase !== "running") { inputSource.current?.clear(); sfxRef.current?.suspend(); }
  }, [car.hud.phase]);
  useEffect(() => {
    if (car.hud.phase === "idle" || car.hud.phase === "error") { removeVisuals(); poseRef.current = null; }
  }, [car.hud.phase, removeVisuals]);
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
  useEffect(() => () => { sfxRef.current?.dispose(); sfxRef.current = null; }, []);
  const setSoundVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value)); soundVolumeRef.current = next; setSoundVolumeState(next); sfxRef.current?.setVolume(next);
  }, []);
  const toggleSfx = useCallback(() => { const next = !sfxEnabledRef.current; sfxEnabledRef.current = next; setSfxEnabled(next); sfxRef.current?.setMuted(!next); }, []);
  const sound = soundAvailable ? { volume: soundVolume, onVolume: setSoundVolume, sfx: { enabled: sfxEnabled, onToggle: toggleSfx } } : undefined;
  const pose = useCallback(() => poseRef.current, []);
  return { ...car, active, choosingVehicle, vtol, selectVehicle, enter, enterAt, exit, resume, pause, openUiContext, initialPaused, sound, pose, roadCheck };
}
