/**
 * GameSession：游戏模式的引擎侧编排（§3/§5/§6/§7/§8）。持有 GameModeController、
 * FlightWorld/输入/模拟/相机/造型与穿环任务（RaceCourse/RaceMission），把控制器事件
 * 映射为引擎副作用；通过回调把状态变化通知 React（HUD）。不 import React；
 * 一个 CityEngine 同时至多一个会话。倒计时与任务计时共用固定步模拟时钟（§6.2）。
 */
import type { CityEngine } from "../engine/CityEngine";
import { GameModeController, type GameSnapshot } from "./GameModeController";
import { FlightWorld } from "./FlightWorld";
import { FlightInput } from "./FlightInput";
import { FlightCamera } from "./FlightCamera";
import { FlightCameraControls } from "./FlightCameraControls";
import { FlightVisuals } from "./FlightVisuals";
import { initialSimState, flightParamsFor, stepFlight, lerpSim, PHYSICS_VERSION, type FlightParams, type FlightSimState } from "./FlightSimulation";
import { sweepFlight } from "./FlightCollision";
import { generateRaceCourse, COURSE_VERSION, type RaceCourse } from "./RaceCourse";
import { RaceMission, type RaceMissionSnapshot, type RaceResult } from "./RaceMission";
import { GameAudio } from "./GameAudio";
import { GameSfx, type SfxTelemetry } from "./GameSfx";
import * as THREE from "three";
import { GameRuntime } from "./runtime/GameRuntime";
import { FlightAdapter } from "./runtime/FlightAdapter";
import type { GameSceneLease } from "./runtime/GameScenePort";
import type { GameSceneSnapshot } from "./runtime/GameSceneSnapshot";
import { compileCitySolidInputs } from "../engine/surface/compileCitySolidInputs";
import type { EnterHostState, GamePauseReason, GameSelection, ReturnCameraView, FlightInputState } from "./types";

const FIXED_DT = 1 / 60;
const HUD_HZ = 10;

export type GameSessionEvents = {
  /** 状态快照变化（HUD 重渲染的唯一来源）。 */
  onState: (snapshot: GameSessionSnapshot) => void;
  /** 退出已完成（相机已归还）；React 层再恢复 UI 状态并触发投影刷新。 */
  onExited: () => void;
  /** 新最佳成绩（React 层负责档案持久化，§9）。 */
  onRecord?: (courseId: string, bestTimeMs: number, collisions: number) => void;
};

export type GameSessionSnapshot = {
  controller: GameSnapshot;
  /** 供 HUD 展示的飞行读数（≤10 Hz 更新，不逐帧进 React）。 */
  telemetry: { speed: number; altitude: number; heading: number } | null;
  softOutside: boolean;
  collisions: number;
  /** 穿环任务（仅 race 模式；practice 为 null）。 */
  mission: RaceMissionSnapshot | null;
  /** 本路线最佳（含跨会话载入的档案成绩）。 */
  best: RaceResult | null;
  /** 当前路线身份摘要（无业务标识几何摘要；测试与调试用）。 */
  courseId: string | null;
  /** 当前路线变体（测试与调试用）。 */
  variant: number;
  /** 声音面板状态（HUD 三控件）。 */
  soundVolume: number;
  sfxEnabled: boolean;
  musicEnabled: boolean;
};

export class GameSession {
  readonly controller = new GameModeController();
  private world: FlightWorld | null = null;
  private params: FlightParams | null = null;
  private sim: FlightSimState | null = null;
  private prevSim: FlightSimState | null = null;
  private renderSim: FlightSimState | null = null;
  private lastSafe: { x: number; y: number; z: number } | null = null;
  private visuals: FlightVisuals | null = null;
  private camera: FlightCamera | null = null;
  private cameraScratch: THREE.PerspectiveCamera | null = null;
  private cameraControls: FlightCameraControls | null = null;
  private input: FlightInput | null = null;
  private sceneLease: GameSceneLease<GameSceneSnapshot, import("three").Object3D> | null = null;
  private prepareAbort: AbortController | null = null;
  private readonly runtime = new GameRuntime<FlightInputState>({
    dt: FIXED_DT, emptyInput: () => ({ throttleUp: false, throttleDown: false, turnLeft: false, turnRight: false, pitchUp: false, pitchDown: false }),
    onPause: (reason) => this.onRuntimePause(reason),
    onError: (reason) => { this.controller.fail(reason); this.emit(true); },
  });
  private collisions = 0;
  private softOutside = false;
  private hudAt = 0;
  private disposed = false;
  private citySeed = 0;
  private staticWorldRevision: string | null = null;
  private variant = 0;
  private course: RaceCourse | null = null;
  private mission: RaceMission | null = null;
  /** 最近一次准备失败的原因（驱动「生成失败重试换 variant」的判定）。 */
  private lastPrepareFailure: string | null = null;
  private bestByCourse = new Map<string, RaceResult>();
  /** 路线工厂（测试注入点：真实布局几乎不会生成失败，无法覆盖 no-course 分支）。 */
  private readonly courseFactory: typeof generateRaceCourse;
  /** 背景音乐（乐谱驱动合成，懒拉起；不可用时静默无音乐）。 */
  private audio = new GameAudio();
  /** 飞行音效（Web Audio 程序化合成：螺旋桨/风/雨 + 一次性事件音）。 */
  private sfx = new GameSfx();
  /** 声音面板状态：主音量 + 音效/BGM 独立开关（HUD 三控件的数据源）。 */
  private soundVolume = 1;
  private sfxEnabled = true;
  private musicEnabled = true;
  /** 倒计时秒数追踪（整数秒变化时发蜂鸣）。 */
  private lastCountdownSec: number | null = null;

  constructor(
    private readonly engine: CityEngine,
    private readonly events: GameSessionEvents,
    courseFactory?: typeof generateRaceCourse,
  ) {
    this.courseFactory = courseFactory ?? generateRaceCourse;
  }

  /** 宿主互斥状态快照（进入判定用；由 React 层如实填充）。 */
  hostState(cinemaActive: boolean, filmActive: boolean, busy: boolean): EnterHostState {
    return { cityReady: !!(this.engine.currentLayout && this.engine.currentModel), cinemaActive, filmActive, busy };
  }

  /** 练习从这里起飞（点了机坪上的飞机：跑道西端、顺跑道方向）；null = 按世界安全位挑出生点。 */
  private origin: Readonly<{ x: number; y: number; z: number; heading: number }> | null = null;

  async enter(kind: GameSelection, host: EnterHostState, origin?: Readonly<{ x: number; y: number; z: number; heading: number }>): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.origin = kind.mode === "practice" ? origin ?? null : null;
    const attempt = this.controller.enter(kind, host);
    if (!attempt.ok) return { ok: false, reason: attempt.refusal };
    const runId = this.controller.snapshot.runId;
    const abort = new AbortController();
    this.prepareAbort = abort;
    this.emit(true);
    let acquiredLease: GameSceneLease<GameSceneSnapshot, THREE.Object3D> | null = null;
    try {
      const selection = { vehicle: "plane" as const, activity: kind.mode };
      const acquisition = await this.engine.gameScenePort.acquireResult(selection, runId, abort.signal);
      if (acquisition.status !== "ready") {
        if (!abort.signal.aborted && this.controller.snapshot.runId === runId && this.controller.snapshot.phase === "preparing") {
          this.settleFailure(`场景准备失败：${acquisition.reason}`, acquisition.reason);
        }
        return { ok: false, reason: acquisition.reason };
      }
      const lease = acquisition.lease;
      acquiredLease = lease;
      if (abort.signal.aborted || this.controller.snapshot.runId !== runId || this.controller.snapshot.phase !== "preparing") {
        lease.release(); return { ok: false, reason: "cancelled" };
      }
      this.sceneLease = lease;
      const build = this.ensureRunObjects(kind);
      if (!build.ok) {
        lease.release(); this.sceneLease = null;
        this.settleFailure(build.message, build.reason);
        return { ok: false, reason: build.reason };
      }
      if (!this.attachRun()) {
        this.cleanupFailedPreparation();
        if (!this.controller.snapshot.error) this.settleFailure("场景已失效，请重新进入。", "runtime-refused");
        return { ok: false, reason: "runtime-refused" };
      }
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "scene-acquire-failed";
      const stillOwnsAttempt = this.controller.snapshot.runId === runId && this.sceneLease === acquiredLease &&
        this.controller.snapshot.phase !== "exiting" && this.controller.snapshot.phase !== "data";
      if (stillOwnsAttempt) this.cleanupFailedPreparation();
      if (!abort.signal.aborted && this.controller.snapshot.runId === runId && this.controller.snapshot.phase === "preparing") {
        this.settleFailure(`场景准备失败：${reason}`, reason);
      } else if (!abort.signal.aborted && this.controller.snapshot.runId === runId && this.controller.inGame) {
        this.controller.fail(reason); this.emit(true);
      }
      return { ok: false, reason };
    } finally {
      if (this.prepareAbort === abort) this.prepareAbort = null;
    }
  }

  /**
   * 准备/重试共用的对象保障：world/params 优先沿用既有冻结快照（重试复用原世界），
   * 缺失时从引擎现状态重建；race 缺 course 时按当前 variant 生成；出生点与相机接管
   * 在此检查。失败返回可识别原因——调用方进入错误面板，绝不带着半套对象起跑。
   */
  private ensureRunObjects(kind: GameSelection): { ok: true } | { ok: false; reason: string; message: string } {
    const lease = this.sceneLease;
    const staticWorld = lease?.snapshot.staticWorld;
    if (!lease?.isCurrent() || !staticWorld?.isLeaseCurrent() || !staticWorld.verifyCurrent()) return { ok: false, reason: "stale-world", message: "城市场景已更新，请重新进入。" };
    const staticContentRevision = staticWorld.worldRevision;
    if (this.world && this.staticWorldRevision !== staticContentRevision) {
      this.world = null; this.params = null; this.course = null; this.mission = null; this.staticWorldRevision = null;
    }
    if (!this.world || !this.params) {
      const layout = staticWorld.readWorld()?.layout;
      const model = this.engine.currentModel;
      if (!layout || !model) return { ok: false, reason: "not-ready", message: "城市尚未就绪，暂时无法起飞。" };
      const snapshot = staticWorld.readWorld();
      if (!snapshot) return { ok: false, reason: "static-snapshot-unavailable", message: "城市静态碰撞快照暂不可用。" };
      const compiled = compileCitySolidInputs(snapshot);
      if (compiled.status !== "ready") return { ok: false, reason: `static-solids:${compiled.reason}`, message: "城市静态碰撞内容无法安全准备。" };
      if (!lease.isCurrent() || !staticWorld.verifyCurrent()) return { ok: false, reason: "stale-world", message: "城市场景已更新，请重新进入。" };
      this.citySeed = layout.seed;
      this.world = new FlightWorld({ layout, model, cursorMs: this.engine.replayCursor, staticSolids: compiled.solids,
        cameraCollisionIndex: compiled.collisionIndex, staticContentRevision,
        solidCompilerVersion: compiled.compilerVersion, staticCoverage: compiled.coverage });
      this.staticWorldRevision = staticContentRevision;
      const diagonal = Math.hypot(layout.urbanBounds.right - layout.urbanBounds.left, layout.urbanBounds.south - layout.urbanBounds.north);
      this.params = flightParamsFor(diagonal);
    }
    if (kind.mode === "race") {
      if (!this.course) {
        const course = this.courseFactory({ world: this.world, params: this.params, citySeed: this.citySeed, physicsVersion: PHYSICS_VERSION,
          variant: this.variant, staticCollisionIdentity: `solid-v${this.world.solidCompilerVersion ?? 0}:${this.world.staticContentRevision ?? "legacy"}` });
        if (!course) return { ok: false, reason: "no-course", message: "这条航线暂时无法生成安全路线，可重试或先自由练习。" };
        this.course = course;
      }
    } else {
      this.course = null;
    }
    if (!this.spawnFor(this.params, this.world)) {
      return { ok: false, reason: "no-safe-spawn", message: "没有可用的安全出生点，暂不能进入飞行。" };
    }
    return { ok: true };
  }

  /** 挂载运行件（幂等）：造型/相机/输入/帧钩子/任务，随后重置到出生点并落成准备。 */
  private attachRun(): boolean {
    if (!this.sceneLease?.isCurrent()) return false;
    const params = this.params!;
    if (!this.visuals) {
      this.visuals = new FlightVisuals(params);
      this.sceneLease.attach([this.visuals.group, this.visuals.sceneRoot]);
    }
    if (this.course) this.visuals.setRings(this.course.rings);
    else this.visuals.clearRings();
    this.mission = this.course ? new RaceMission(this.course, params) : null;
    if (!this.camera) {
      const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      this.cameraScratch = this.engine.renderCamera.clone();
      this.camera = new FlightCamera(this.cameraScratch, reducedMotion);
    }
    // 环绕/缩放输入：只在真实 DOM 画布上挂（Worker/OffscreenCanvas 与测试桩没有指针事件）。
    const canvas = this.engine.domCanvas;
    if (!this.cameraControls && typeof HTMLElement !== "undefined" && canvas instanceof HTMLElement) {
      this.cameraControls = new FlightCameraControls({ canvas, camera: () => this.camera, isActive: () => this.controller.simulating });
      this.cameraControls.attach();
    }
    if (!this.input) {
      this.input = new FlightInput({
        isGameFocused: () => this.gameWindowFocused(),
        blurFocusTarget: () => {
          const target = this.engine.domCanvas;
          return typeof HTMLElement !== "undefined" && target instanceof HTMLElement ? target : null;
        },
        onInterrupt: (reason) => this.interrupt(reason),
      });
      this.input.attach();
    }
    this.applySoundSettings();
    this.audio.start();
    this.sfx.start();
    this.lastCountdownSec = null;
    this.resetToSpawn();
    this.controller.prepareDone();
    if (this.runtime.snapshot.phase === "idle" || this.runtime.snapshot.phase === "error") {
      const lease = this.sceneLease;
      if (!lease?.isCurrent()) return false;
      const revision = lease.revision;
      const isCurrent = () => !this.disposed && lease.isCurrent();
      const adapter = new FlightAdapter(revision, {
        isCurrent, prepare: () => { if (!this.sim || !this.world || !this.params) throw new Error("flight-not-prepared"); },
        fixedStep: (input, dt) => this.fixedFlightStep(input, dt),
        present: (alpha, seconds) => this.presentFlight(alpha, seconds),
        reset: () => this.resetToSpawn(), settle: () => { this.prevSim = this.sim; },
        dispose: () => this.releaseRunObjects(),
      });
      const runtimeLease: GameSceneLease<GameSceneSnapshot, import("three").Object3D> = {
        ...lease,
        setFrameHook: (frame) => lease.setFrameHook(frame ? (seconds) => {
          this.runtime.setInput(this.input?.snapshot() ?? { throttleUp: false, throttleDown: false, turnLeft: false, turnRight: false, pitchUp: false, pitchDown: false });
          frame(seconds);
        } : null),
        release: () => { lease.release(); if (this.sceneLease === lease) this.sceneLease = null; },
      };
      const ready = this.runtime.enterSync(runtimeLease, adapter);
      if (!ready) return false;
    } else {
      this.runtime.pause("activity-reset"); this.runtime.reset();
    }
    if (this.controller.simulating) this.runtime.resume();
    this.emit(true);
    return this.runtime.snapshot.phase === "running";
  }

  /** 出生点：挑战取首环后方进近位（沿切线），练习取世界安全位。 */
  private spawnFor(params: FlightParams, world: FlightWorld): { x: number; y: number; z: number; heading: number } | null {
    const first = this.course?.rings[0];
    if (first) {
      const back = Math.max(params.maxSpeed * 1.6, 30);
      const x = first.x - first.nx * back;
      const y = first.y;
      const z = first.z - first.nz * back;
      if (world.isPointClear(x, y, z, params.planeRadius + 2)) {
        return { x, y, z, heading: Math.atan2(first.nz, first.nx) };
      }
    }
    // 从机场起飞：没有地面滑跑。出生在跑道正上方的练习巡航高度、朝向顺着跑道。
    // 贴着平台顶（1.4）只抬几个机身半径时，人和追尾相机都还在航站楼/塔台高度里，画面仍停在机坪。
    // 这一档净空失败才退回世界安全位，不把人塞进障碍。
    const origin = this.origin;
    if (origin && !this.course) {
      const clearance = params.planeRadius + 1.5, back = params.planeRadius * 5.2, up = params.planeRadius * 2.4;
      const cruise = world.flightAltitude(clearance);
      const deck = Math.max(origin.y, Math.max(0, world.terrainHeight(origin.x, origin.z)));
      const ceiling = world.bounds.maxY - clearance;
      const camX = origin.x - Math.cos(origin.heading) * back, camZ = origin.z - Math.sin(origin.heading) * back;
      for (const y of [Math.max(cruise, deck + clearance * 2.5), cruise + 24, Math.min(ceiling, 120)]) {
        if (!Number.isFinite(y) || y <= deck || y > ceiling) continue;
        if (world.isPointClear(origin.x, y, origin.z, clearance) && world.isPointClear(camX, y + up, camZ, clearance * 0.6)) return { x: origin.x, y, z: origin.z, heading: origin.heading };
      }
    }
    return world.findSafeSpawn(params.planeRadius + 1.5, params.planeRadius * 5.2, params.planeRadius * 2.4);
  }

  pause(reason: GamePauseReason): void { this.runtime.pause(reason); }

  private onRuntimePause(reason: string): void {
    if (reason === "activity-reset" || reason === "activity-result") return;
    this.input?.clear(); this.audio.suspend(); this.sfx.suspend();
    this.controller.pause(reason === "long-frame" ? "lag" : reason as GamePauseReason);
    this.emit(true);
  }

  resume(): void {
    if (!this.controller.snapshot.paused) return;
    this.input?.clear();
    if (!this.runtime.resume()) return;
    this.audio.resume(); this.sfx.resume();
    this.controller.resume(); this.emit(true);
  }

  /** 重试/重新开始：挑战复用原路线（variant 不变，§7.1）；任务实例必须重建
   *  （上一局的 mission 已终态，不重建则重赛进度永远冻结）。 */
  restart(): void {
    for (const event of this.controller.restart()) {
      if (event.type === "restarted") this.attachRun();
    }
    this.emit(true);
  }

  /** 显式「新路线」：variant+1 重新生成（§7.1）。variant 在此递增且仅此一次；
   *  result/paused 走 restart 语义（控制器回 preparing→prepareDone），错误面板走
   *  retryPrepare——后者不得再推断式递增（曾因 result 阶段 retryPrepare 空转导致
   *  variant 双递增且相位卡死在 result）。 */
  async newCourse(): Promise<void> {
    const snapshot = this.controller.snapshot;
    if (snapshot.selection?.mode !== "race") return;
    if (snapshot.error) {
      // 显式换线是唯一的 variant 递增来源：清除失败标记，retryPrepare 不得再按
      // no-course 推断递增（曾因此双递增、跳过一个 variant）。
      this.variant += 1;
      this.course = null;
      this.lastPrepareFailure = null;
      await this.retryPrepare();
      return;
    }
    if (snapshot.phase !== "result" && !snapshot.paused) return;
    // restart 语义（result/paused → preparing → prepareDone）。先按新 variant 生成路线，
    // 失败则保留原路线退回结果页（本次换线未生效），不带空路线进比赛。
    const previousCourse = this.course;
    this.variant += 1;
    this.course = null;
    this.lastPrepareFailure = null;
    const build = this.ensureRunObjects({ mode: "race" });
    if (!build.ok) {
      this.course = previousCourse;
      this.lastPrepareFailure = build.reason;
      this.emit(true);
      return;
    }
    for (const event of this.controller.restart()) {
      if (event.type === "restarted") this.attachRun();
    }
    this.emit(true);
  }

  async retryPrepare(): Promise<void> {
    const selection = this.controller.snapshot.selection;
    if (!selection) return;
    // 生成失败后的重试换 variant，不再撞同一条死路；其他失败（未就绪/无出生点/
    // 相机占用）不换——路线本身没有被否决。
    const failedCourseGeneration = this.lastPrepareFailure === "no-course";
    this.lastPrepareFailure = null;
    this.controller.retryPrepare();
    if (failedCourseGeneration && selection.mode === "race") this.variant += 1;
    const runId = this.controller.snapshot.runId;
    const complete = () => {
      if (this.controller.snapshot.runId !== runId || this.controller.snapshot.phase !== "preparing") return;
      try {
        const build = this.ensureRunObjects(selection);
        if (!build.ok) { this.sceneLease?.release(); this.sceneLease = null; this.settleFailure(build.message, build.reason); return; }
        if (!this.attachRun()) {
          this.cleanupFailedPreparation();
          this.settleFailure("场景已失效，请重新进入。", "runtime-refused");
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "scene-prepare-failed";
        this.cleanupFailedPreparation(); this.settleFailure(`场景准备失败：${reason}`, reason);
      }
    };
    if (this.sceneLease?.isCurrent()) { complete(); return; }
    const abort = new AbortController(); this.prepareAbort = abort; this.emit(true);
    try {
      const lease = await this.engine.gameScenePort.acquire({ vehicle: "plane", activity: selection.mode }, runId, abort.signal);
      if (abort.signal.aborted || this.controller.snapshot.runId !== runId || this.controller.snapshot.phase !== "preparing") { lease.release(); return; }
      this.sceneLease = lease;
      complete();
    } catch (error) {
      if (!abort.signal.aborted && this.controller.snapshot.runId === runId && this.controller.snapshot.phase === "preparing") {
        const reason = error instanceof Error ? error.message : "scene-acquire-failed";
        this.settleFailure(`场景准备失败：${reason}`, reason);
      }
    } finally { if (this.prepareAbort === abort) this.prepareAbort = null; }
  }

  /** Explicit exit returns resources through the same runtime as the car. */
  exit(): void {
    if (!this.controller.inGame) return;
    this.controller.exit(); this.prepareAbort?.abort(); this.prepareAbort = null;
    const lease = this.sceneLease;
    this.runtime.exit(); this.releaseRunObjects();
    lease?.release(); this.sceneLease = null;
    this.controller.exitSettled(); this.emit(true); this.events.onExited();
  }

  private releaseRunObjects(): void {
    this.mission?.abort(); this.input?.detach(); this.input = null;
    this.audio.stop(); this.sfx.stop();
    if (this.visuals) {
      this.sceneLease?.detach([this.visuals.group, this.visuals.sceneRoot]);
      this.visuals.dispose(); this.visuals = null;
    }
    this.cameraControls?.detach(); this.cameraControls = null;
    this.camera?.dispose(); this.camera = null;
    this.cameraScratch = null;
    this.world = null; this.staticWorldRevision = null; this.sim = this.prevSim = this.renderSim = null; this.mission = null;
    this.sceneLease = null;
  }

  private cleanupFailedPreparation(): void {
    const lease = this.sceneLease;
    this.runtime.exit();
    this.releaseRunObjects();
    lease?.release();
    this.sceneLease = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.exit();
    this.disposed = true;
    this.runtime.dispose();
    this.audio.dispose();
    this.sfx.dispose();
  }

  snapshot(): GameSessionSnapshot {
    return {
      controller: this.controller.snapshot,
      telemetry: this.renderSim ? { speed: this.renderSim.speed, altitude: this.renderSim.y, heading: this.renderSim.heading } : null,
      softOutside: this.softOutside,
      collisions: this.collisions,
      mission: this.mission?.snapshot() ?? null,
      best: this.course ? this.bestByCourse.get(this.course.courseId) ?? null : null,
      courseId: this.course?.courseId ?? null,
      variant: this.variant,
      soundVolume: this.soundVolume,
      sfxEnabled: this.sfxEnabled,
      musicEnabled: this.musicEnabled,
    };
  }

  /** 把面板设置下发到两个引擎（进入 run 与每次面板操作时调用，幂等）。 */
  private applySoundSettings(): void {
    this.audio.setMuted(!this.musicEnabled);
    this.audio.setVolume(this.soundVolume);
    this.sfx.setMuted(!this.sfxEnabled);
    this.sfx.setVolume(this.soundVolume);
  }

  /** 声音面板：主音量（0-1，音乐与音效共用）。 */
  setSoundVolume(volume: number): void {
    this.soundVolume = Math.max(0, Math.min(1, volume));
    this.applySoundSettings();
    this.emit(true);
  }

  /** 声音面板：音效开关。 */
  toggleSfx(): void {
    this.sfxEnabled = !this.sfxEnabled;
    this.applySoundSettings();
    this.emit(true);
  }

  /** 声音面板：BGM 开关。 */
  toggleMusic(): void {
    this.musicEnabled = !this.musicEnabled;
    this.applySoundSettings();
    this.emit(true);
  }

  get physicsVersion(): number {
    return PHYSICS_VERSION;
  }

  /** 载入档案成绩（跨会话最佳；由 React 层在端口就绪后注入，§9）。 */
  adoptProfileRecords(records: Array<{ courseId: string; bestTimeMs: number; collisions: number }>): void {
    for (const record of records) {
      this.bestByCourse.set(record.courseId, { finished: true, elapsedMs: record.bestTimeMs, collisions: record.collisions, penaltyMs: 0, finalMs: record.bestTimeMs });
    }
    this.emit(true);
  }

  get courseVersion(): number {
    return COURSE_VERSION;
  }

  // ── 内部 ──

  /** Activity steps are driven only by GameRuntime's shared fixed clock. */
  private fixedFlightStep(input: Readonly<FlightInputState>, dt: number): boolean {
    const { phase, paused, error } = this.controller.snapshot;
    if (paused || error) return false;
    if (phase === "countdown" && this.mission) {
      const events = this.mission.tickCountdown(dt * 1000);
      if (events.some((event) => event.type === "countdown-done")) {
        this.controller.countdownDone(); this.sfx.countdownBeep(true); this.emit(true);
        return false; // Discard this frame's remainder, matching the flight transition contract.
      }
      return true;
    }
    if (phase !== "practice" && phase !== "racing") return false;
    this.stepPhysics(input);
    return this.controller.simulating;
  }

  private presentFlight(alpha: number, dt: number): void {
    const { phase, paused, error } = this.controller.snapshot;
    if (paused || error || phase === "result" || !this.sim || !this.prevSim || !this.params || !this.world) return;
    this.renderSim = lerpSim(this.prevSim, this.sim, alpha);
    if (phase === "countdown" && this.mission) {
      const sec = Math.ceil(this.mission.snapshot().countdownRemainingMs / 1000);
      if (sec !== this.lastCountdownSec) { this.lastCountdownSec = sec; if (sec > 0) this.sfx.countdownBeep(false); }
    }
    this.visuals?.update(this.renderSim, dt);
    if (this.mission) this.visuals?.updateRings(this.renderSim.simTime, this.mission.snapshot().targetIndex);
    const cameraSafety = this.camera?.update(dt, this.renderSim, this.params, this.world);
    if (cameraSafety) this.runtime.noteCameraSafety(cameraSafety);
    if (cameraSafety === "unresolved") {
      this.runtime.pause("camera-safety");
      return;
    }
    this.applyCameraPose();
    const input = this.input?.snapshot(); this.updateSfx(!!input?.throttleUp, !!input?.throttleDown); this.emit();
  }

  private applyCameraPose(): void {
    const camera = this.cameraScratch;
    const lease = this.sceneLease;
    if (!camera || !lease?.isCurrent()) return;
    const direction = camera.getWorldDirection(new THREE.Vector3());
    const target = camera.position.clone().addScaledVector(direction, 10);
    lease.setCamera({ position: camera.position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number], up: camera.up.toArray() as [number, number, number], fov: camera.fov });
  }

  /** 喂音效：每帧遥测 + 500ms 一次的天气雨强（跟随回放时钟，clear 恒 0）。 */
  private updateSfx(throttleUp: boolean, throttleDown: boolean): void {
    if (!this.renderSim || !this.params) return;
    this.sfx.update({
      speed: this.renderSim.speed,
      minSpeed: this.params.minSpeed,
      maxSpeed: this.params.maxSpeed,
      throttleUp,
      throttleDown,
      rainIntensity: this.engine.environmentState?.rainIntensity ?? 0,
    });
  }

  private stepPhysics(input: Readonly<FlightInputState>): void {
    const sim = this.sim, params = this.params, world = this.world;
    if (!sim || !params || !world) return;
    const next = stepFlight(sim, input, FIXED_DT, params);
    const hit = sweepFlight(world, sim, next, params.planeRadius);
    let teleported = false;
    if (hit) {
      // 温和重置（§6.3）：回到最近安全点、减速、短反馈；任务侧记罚时。
      this.collisions += 1;
      this.visuals?.pulseFeedback();
      this.sfx.collision();
      for (const event of this.mission?.onCollision() ?? []) {
        if (event.type === "failed") this.finishRace(event.result);
      }
      const safe = this.lastSafe ?? { x: sim.x, y: sim.y, z: sim.z };
      this.sim = { ...sim, x: safe.x, y: safe.y, z: safe.z, speed: Math.max(params.minSpeed, sim.speed * 0.4), verticalSpeed: 0, turnRate: 0, bank: 0 };
      this.prevSim = this.sim;
      this.lastSafe = { ...safe };
      teleported = true;
    } else {
      this.prevSim = sim;
      this.sim = next;
      // 维护最近安全点：带余量净空才记录，避免贴墙位置成为重置点。
      if (world.isPointClear(next.x, next.y, next.z, params.planeRadius * 1.6)) {
        this.lastSafe = { x: next.x, y: next.y, z: next.z };
      }
      const distance = Math.hypot(next.x - world.bounds.centerX, next.z - world.bounds.centerZ);
      this.softOutside = distance > world.bounds.softRadius;
    }
    if (this.mission) {
      // 穿环检测优先用碰撞前的真实飞行段（sim→next）；碰撞瞬移（sim→safe）跳过。
      // 2026-10-09 修复：环放在建筑旁（v2 路线），穿环同时擦楼会触发碰撞瞬移，
      // 旧实现 teleported=true 直接跳过环检测——用户穿过了环但没反应。
      if (teleported) {
        // 先用真实飞行段检测穿环（飞到碰撞点为止的路径可能穿过环）。
        for (const event of this.mission.step(sim, next, FIXED_DT * 1000, false)) {
          if (event.type === "finished") { this.finishRace(event.result); return; }
          else if (event.type === "failed") { this.finishRace(event.result); return; }
          else if (event.type === "ring-passed") this.sfx.ringPass();
        }
        // 推进任务时钟（不重复穿环检测——位置已瞬移回安全点）。
        for (const event of this.mission.step(this.sim, this.sim, FIXED_DT * 1000, true)) {
          if (event.type === "failed") this.finishRace(event.result);
        }
      } else {
        for (const event of this.mission.step(sim, this.sim, FIXED_DT * 1000, false)) {
          if (event.type === "finished") this.finishRace(event.result);
          else if (event.type === "failed") this.finishRace(event.result);
          else {
            if (event.type === "ring-passed") this.sfx.ringPass();
            this.emit(true);
          }
        }
      }
    }
  }

  private finishRace(result: RaceResult): void {
    // 结算恰好一次由 RaceMission 保证；控制器再收敛到 result 相位。
    this.controller.raceFinished();
    this.runtime.pause("activity-result");
    this.sfx.suspend();  // 结算画面静止：发动机/环境声随暂停语义一起挂起
    if (result.finished && this.course) {
      const best = this.bestByCourse.get(this.course.courseId);
      if (!best || result.finalMs < best.finalMs || (result.finalMs === best.finalMs && result.collisions < best.collisions)) {
        this.bestByCourse.set(this.course.courseId, result);
        this.events.onRecord?.(this.course.courseId, result.finalMs, result.collisions);
      }
    }
    this.emit(true);
  }

  private resetToSpawn(): void {
    const world = this.world;
    const params = this.params;
    if (!world || !params) return;
    const spawn = this.spawnFor(params, world);
    if (!spawn) {
      this.controller.fail("没有可用的安全出生点。");
      return;
    }
    this.sim = initialSimState(spawn, params);
    this.prevSim = this.sim;
    this.renderSim = this.sim;
    this.lastSafe = { x: spawn.x, y: spawn.y, z: spawn.z };
    this.collisions = 0;
    this.softOutside = false;
    this.input?.clear();
    this.camera?.reset(this.sim, params);
    this.visuals?.update(this.sim, 0);
    // reset 只动克隆相机。进场第一帧若净空查询未决，present 会在写回前返回，
    // 轨道相机已经关掉，画面就停在点飞机之前的视角。出生时先把追尾位写上。
    this.applyCameraPose();
  }

  private interrupt(reason: Extract<GamePauseReason, "focus-lost" | "host-hidden" | "lag">): void { this.runtime.pause(reason); }

  private settleFailure(message: string, reason?: string): void {
    this.lastPrepareFailure = reason ?? null;
    this.controller.fail(message);
    this.emit(true);
  }

  private gameWindowFocused(): boolean {
    return typeof document !== "undefined" && document.visibilityState !== "hidden" && document.hasFocus();
  }

  private emit(force = false): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!force && now - this.hudAt < 1000 / HUD_HZ) return;
    this.hudAt = now;
    this.events.onState(this.snapshot());
  }
}
