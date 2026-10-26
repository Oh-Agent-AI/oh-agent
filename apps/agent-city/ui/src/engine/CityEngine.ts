/**
 * CityEngine：Three.js 场景的唯一所有者。React 只通过本类的窄 API 驱动它
 * （换模型 / 时间游标 / 画质 / 聚焦 / 事件回调），业务数据不接触 3D 对象。
 *
 * 常驻成本控制：
 *  · 页面卸载 → dispose()（几何/材质/纹理/renderer 全部释放）。
 *  · 文档隐藏 → 停止 rAF 循环；恢复可见再续。
 *  · 空闲（无输入且相机静止 12s）→ 降为 ~20fps 的环境帧率；交互立即恢复。
 *  · 自适应画质：非空闲时统计帧率，连续低帧自动降档（阴影/像素比/生命感部件），
 *    富余时升档。"auto" 之外可由用户钉死。
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ModeLeaseBook } from "./modeLease";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import type { CityModel } from "../cityModel";
import { activeTheme, BIOME_GRADES, skyYawOf } from "./cityTheme";
import { loadCityAssets, type CityAssets } from "./cityAssets";
import { loadBiomeFlora } from "./cityFlora";
import { planCinematic, type CinematicCut, type CinematicPlan } from "./cityCinematic";
import { drawFilmOverlay, type FilmCardText } from "./cityFilmOverlay";
import { Mp4Writer } from "./mp4Muxer";
import { WebmFilmWriter, type WebmCodec } from "./webmMuxer";
import { layoutCity, type CityLayout, type BackdropMode } from "./cityLayout";
import { applyPlanPatch, layoutPinsFor, type PatchedLayout, type PlanPatchV1 } from "./planPatch";
import { CityParts, occupantsCanAppend, type QualityLevel } from "./cityParts";
import { applyBuildingEvent, parseBuildingChanged, replayDecision, type BuildingChangedEvent, type OverlayDecision } from "./sessionKitConstruction";
import { applyEditEvent, parseBuildingEdit, type BuildingEditEvent, type EditVisual } from "./sessionKitEditState";
import { parseSquadEnvelope, type ClaimTint, type SquadEnvelope } from "./squadEvents";
import { skyStateAt, type CitySkyPreset } from "./citySky";
import { MIAMI_COASTAL } from "./citySeaside";
import { CityAurora } from "./cityAurora";
import { CityAmbient } from "./cityAmbient";
import { CityWildlife } from "./cityWildlife";
import { LIGHT_BUDGET, nightFactor } from "./cityLightBudget";
import { DRIVING_PARAMS } from "../game/DrivingSimulation";
import { CAR_DIMENSIONS } from "../game/carDimensions";
import { PLAYABLE_CAR_PREFIX, PLAYABLE_MECHA_NAME, PLAYABLE_PLANE_NAME, playableKind, type PlayTarget } from "./render/playableVehicles";
import { paletteFor } from "./cityTextures";
import { CarCamera } from "../game/CarCamera";
import { FlightCameraControls } from "../game/FlightCameraControls";
import { RainbowArch, RainOverlay } from "./cityWeather";
import { CityEnvironment, type CityEnvironmentSnapshot } from "./environment/CityEnvironment";
import { createRenderCanvas, renderContext2D, type RenderCanvas } from "./renderCanvas";
import { buildingFrame, isSelectionGesture } from "./cityCameraInteraction";
import type { ReturnCameraView } from "../game/types";
import { CitySurfacePort, type CitySurfaceCapture, type ReadyCitySurfaceCapture } from "./surface/citySurfacePort";
import { CityStaticWorldPort, type ReadyCityStaticWorldCapture } from "./surface/cityStaticWorldPort";
import { HostGameScenePort } from "../game/runtime/HostGameScenePort";
import type { CameraPose, GameSelection } from "../game/runtime/GameScenePort";
import type { GameSceneSnapshot } from "../game/runtime/GameSceneSnapshot";
import type { CameraClearanceQuery, ChaseCameraSafety } from "../game/VehicleChaseCamera";
import type { GameSceneLease } from "../game/runtime/GameScenePort";

/** 航拍的昼夜区间（小时）：黄昏渐入，片尾 > 19:00 城市全亮（见 citySky 的灯光曲线）。 */
const CINEMATIC_HOUR_FROM = 15;
const CINEMATIC_HOUR_TO = 19.6;

export type EngineQualityMode = "auto" | "high" | "eco";
export type EngineStats = { fps: number; drawCalls: number; triangles: number; buildings: number; quality: QualityLevel; idle: boolean; geometries: number; textures: number };
export type CityDrivingWorldCapture = Exclude<CitySurfaceCapture, ReadyCitySurfaceCapture> | (ReadyCitySurfaceCapture & Readonly<{ release: () => void }>);
export type PhotoView = { position: number[]; target: number[]; fov: number; elapsed: number; cursorMs: number | null };
/** 相机所有权（游戏模式 §4）：同一帧只允许一个所有者推进相机。 */
export type CameraOwner = "orbit" | "cinematic" | "game";

/** 轻量模式租约：相机、帧钩子、场景对象由一个 token 持有，release 幂等。
 *  与 `gameScenePort` 的完整场景租约并存：后者冻结静态世界，这里只需要独占
 *  控制权（机甲战棋这类在同一座城市上叠加一层对象的模式）。 */
export type ModeOrbitView = {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fov?: number;
  minDistance?: number;
  maxDistance?: number;
};
export type ModeLease = {
  readonly id: number;
  attach: (objects: THREE.Object3D[]) => void;
  setFrameHook: (hook: ((dt: number) => void) | null) => void;
  setOrbitView: (view: ModeOrbitView) => void;
  release: () => void;
};

/** 规划修复模式的点击钩子：引擎把一次选取手势翻成「点中的会话楼/非楼物体 id + 点到的地面坐标」交给它，自己不再选楼/飞镜头。 */
/** 选取手势的射线（世界坐标）：设施拾取按占地盒求交，不能只靠射线与地形的交点（高楼会把交点推到楼后面）。 */
export type RepairRay = { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } };
export type RepairClick = { pickedId: string | null; ground: { x: number; z: number } | null; ray: RepairRay };
/** onMove：指针移动时的地面点（离开画布/朝天为 null）——画路/橡皮擦的悬停预览用。 */
export type RepairHook = { onClick(click: RepairClick): void; onMove?(ground: { x: number; z: number } | null, ray: RepairRay | null): void; /** 右键轻点（不拖动）：修复模式里用来退一步。 */ onSecondary?(): void };

export type CityEngineOptions = {
  canvas: RenderCanvas;
  /** Worker-only renderer: no DOM events, OrbitControls or realtime loop. */
  headless?: boolean;
  onHover?: (id: string | null, clientX: number, clientY: number) => void;
  onSelect?: (id: string | null) => void;
  /** 点到可开的载具（地标停车场的车 / 机坪的飞机）：宿主据此进入开车或开飞机，不走选中流程。 */
  onPlay?: (target: PlayTarget) => void;
  onOrbitLock?: (id: string | null) => void;
  onStats?: (stats: EngineStats) => void;
  onTimeCursor?: (ms: number, live: boolean) => void;
  /** 航拍进度（秒）；ended=true 表示片子放完或被打断。 */
  onCinematic?: (elapsedSec: number, plan: CinematicPlan, ended: boolean) => void;
  onFirstFrame?: () => void;
};

/** 补丁对底层布局的唯一影响是移楼钉子（layoutPinsFor）：钉子相同 → 底层布局相同。 */
// 没有移楼 = 没有钉子（layoutPinsFor 返回 null），与「没有补丁」同键——曾把档位也拼进去，空补丁与无补丁键不同，
// 第一笔编辑和撤销回空都走了全量重排（浏览器实测 4000 楼每次 ~1 s）。
const pinsKey = (patch: PlanPatchV1 | null, seed: number): string => {
  if (!patch || patch.seed !== seed || !Object.keys(patch.buildingMoves).length) return "";
  return `${patch.scaleTier}|${Object.keys(patch.buildingMoves).sort().map((id) => `${id}=${patch.buildingMoves[id]}`).join(",")}`;
};

const IDLE_AFTER_MS = 12_000;
const IDLE_FRAME_INTERVAL_MS = 50;

export class CityEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: Pick<OrbitControls, "target" | "enabled" | "enableDamping" | "enablePan" | "zoomToCursor" | "dampingFactor" | "maxPolarAngle" | "minDistance" | "maxDistance" | "autoRotate" | "autoRotateSpeed" | "update" | "dispose">;
  private assetsReady: Promise<void>;
  private floraReady: Promise<void> = Promise.resolve();
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private parts: CityParts | null = null;
  /** Last applyModel path: mount rebuilds CityParts; append keeps the scene and adds occupants. */
  lastApplyMode: "mount" | "append" = "mount";
  private readonly kitDecisions = new Map<string, OverlayDecision>();
  private readonly pendingKits = new Map<string, { event: BuildingChangedEvent; animate: boolean }>();
  private readonly editVisuals = new Map<string, EditVisual>();
  private readonly pendingEdits = new Map<string, BuildingEditEvent>();
  /** 对外的生效布局（已套规划修复补丁；无补丁时就是 baseLayout）。GameSession/FlightWorld/拾取读的都是它。 */
  private layout: CityLayout | null = null;
  /** Read-only driving-surface snapshots of the rendered city; invalidated whenever parts rebuild. */
  private readonly environment = new CityEnvironment();
  private environmentSnapshot = this.environment.sample(Date.now());
  /** Shared facts for lighting, rain, audio and future world systems. */
  get environmentState(): CityEnvironmentSnapshot { return this.environmentSnapshot; }
  private readonly surfacePort = new CitySurfacePort();
  private readonly staticWorldPort = new CityStaticWorldPort();
  private readonly drivingWorldPort = new CitySurfacePort();
  private drivingWorldFrame: { token: symbol; run: (dt: number) => void } | null = null;
  private drivingCameraInitialized = false;
  private drivingCamera: CarCamera | null = null;
  private drivingCameraScratch: THREE.PerspectiveCamera | null = null;
  private drivingControls: FlightCameraControls | null = null;
  private drivingShakeUntil = 0;
  /** layoutCity 的原始产物，下一轮 `previous`（刷新不搬家）只能读它：补丁每次重建后重新套，不能叠套。 */
  private baseLayout: CityLayout | null = null;
  private repairHook: RepairHook | null = null;
  private secondaryDown: { id: number; x: number; y: number; at: number } | null = null;
  private planPatchValue: PlanPatchV1 | null = null;
  private planResult: PatchedLayout | null = null;
  private model: CityModel | null = null;
  private frame = 0;
  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private lastRenderAt = 0;
  private disposed = false;
  private hostEpoch = 0;
  private gameSceneToken: symbol | null = null;
  private ambientCarsVisible = true;
  private documentHidden = false;
  private firstFrameSent = false;

  // 时间轴（replay）状态。
  private cursorMs: number | null = null; // null = live（跟随现在）
  /** 昼夜相位缓存（上次 apply 的 hour，变化才写 uniform）。 */
  private lastSkyHour = -1;
  private lastWeatherKey = "";
  private aurora: CityAurora | null = null;
  private ambient: CityAmbient | null = null;
  private wildlife: CityWildlife | null = null;
  private themeName = activeTheme().name;
  private rain: RainOverlay | null = null;
  private rainbow: RainbowArch | null = null;
  private fillLight: THREE.DirectionalLight | null = null;
  private backLight: THREE.DirectionalLight | null = null;
  /** 当前 theme 的立面自发光基线（昼夜在其上抬升）。 */
  private themeSelfLit = 0.24;
  private playing = false;
  private playbackSpeed = 3_600; // 1 秒 = 1 小时（默认）

  // 空闲与自适应画质。
  private lastActivityAt = 0;
  private qualityMode: EngineQualityMode = "auto";
  // Auto starts conservatively: first-frame shader compilation must not starve
  // plugin health/commands before adaptive frame measurements are available.
  private quality: QualityLevel = 0;
  private frameCount = 0;
  private lastStatsAt = 0;
  private fps = 60;
  private softwareRenderer = false;
  private surfaceDirty = true;
  private qualityDirty = true;
  private surfaceWidth = 0;
  private surfaceHeight = 0;
  private surfacePixelRatio = 0;
  private lastSurfaceChangeAt = 0;
  private contextLost = false;
  private lowFpsWindows = 0;
  private highFpsWindows = 0;
  private lastTierChangeAt = 0;
  private upgradeAfter = 0;

  // 聚焦 tween。
  private tween: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number; duration: number } | null = null;

  // 拾取状态。
  private pointerClient: { x: number; y: number } | null = null;
  private pointerMoved = false;
  private hoveredId: string | null = null;
  private pointerDown: { id: number; x: number; y: number; at: number; moved: number } | null = null;
  private selectedId: string | null = null;
  private orbitLockedId: string | null = null;
  private orbitLockedPoint: THREE.Vector3 | null = null;
  private pickedDecor: { id: string; point: THREE.Vector3 } | null = null;
  private attracted = true;
  private boundsRadius = 150;
  private cityCenter = { x: 0, z: 0 };
  private readonly disposablesSky: Array<{ dispose: () => void }> = [];
  private readonly observers: Array<() => void> = [];
  private skyDome: THREE.Mesh | null = null;
  private assets: CityAssets | null = null;
  private dayMix = 0;
  /** 地形种子：未拿到前不渲染城市（否则先闪一座默认岛再跳成用户自己的岛）。 */
  private seed: number | null = null;
  private backdrop: BackdropMode = "off"; // 默认纯数据城市（用户：不要没有作用的建筑）
  private composer: EffectComposer | null = null;
  /** 当前后处理链的配置键（主题霓虹 × AO）：变化时重建，避免每帧判断哪些 pass 该在。 */
  private composerKey = "";
  /** 水面平面镜：不进场景，只借它的镜像相机与渲染目标（three 的 Reflector 已处理斜裁剪面与视角判断）。 */
  private mirror: Reflector | null = null;
  private readonly mirrorMatrix = new THREE.Matrix4();
  private cinematic: { plan: CinematicPlan; startedAt: number; savedFov: number; look: THREE.Vector3 | null; lastSeconds: number; pace: number } | null = null;
  // 游戏模式（§4）：相机所有权 + 每帧钩子。game 拥有相机时禁用 OrbitControls/回放推进/
  // tween/拾取，唯一的相机更新来自 gameFrame 回调（由 GameModeController 侧注册）。
  private cameraOwner: CameraOwner = "orbit";
  private gameFrame: ((dt: number) => void) | null = null;
  /** 相机 / 帧钩子 / 叠加对象的独占租约。ID 单调递增，过期 token 不能操作新租约。 */
  private readonly modeLeases = new ModeLeaseBook();
  readonly gameScenePort = new HostGameScenePort<GameSceneSnapshot, THREE.Object3D>({
    epoch: () => this.hostEpoch,
    isAlive: () => !this.disposed,
    canAcquire: () => {
      if (!this.parts || !this.layout || !this.model) return Object.freeze({ status: "unavailable", reason: "city-not-ready" });
      if (this.cinematic || this.drivingWorldFrame || this.gameFrame || this.modeLeases.busy || this.cameraOwner !== "orbit") return Object.freeze({ status: "busy", reason: "host-busy" });
      return true;
    },
    capture: async (selection: GameSelection, signal) => {
      const parts = this.parts;
      if (!parts || !this.layout || this.disposed) return Object.freeze({ status: "unavailable", reason: "city-not-ready" });
      let frozen: ReturnType<CityParts["acquireStaticSceneSource"]>;
      try { frozen = parts.acquireStaticSceneSource(); }
      catch { return Object.freeze({ status: "unavailable", reason: "static-source-unavailable" }); }
      const staticWorld = await this.staticWorldPort.capture(frozen.source, frozen.release, signal);
      if (staticWorld.status !== "ready") return Object.freeze({ status: staticWorld.status === "cancelled" ? "cancelled" : "unavailable", reason: staticWorld.reason ?? staticWorld.status });
      let drivingWorld: ReadyCitySurfaceCapture | undefined;
      if (selection.vehicle === "car") {
        let roads: CitySurfaceCapture;
        try { roads = await this.surfacePort.capture(frozen.drivingSource, signal); }
        catch {
          staticWorld.release();
          return Object.freeze({ status: signal.aborted ? "cancelled" : "unavailable", reason: "driving-capture-failed" });
        }
        if (roads.status !== "ready") {
          staticWorld.release();
          return Object.freeze({ status: roads.status === "cancelled" ? "cancelled" : "unavailable", reason: `driving-${roads.status}` });
        }
        drivingWorld = roads;
      }
      const snapshot: GameSceneSnapshot = Object.freeze({ staticWorld, ...(drivingWorld ? { drivingWorld } : {}) });
      const release = () => {
        staticWorld.release();
        if (drivingWorld) this.surfacePort.releaseFrozenSource(frozen.drivingSource);
      };
      const current = () => staticWorld.isLeaseCurrent() && (!drivingWorld || drivingWorld.isLeaseCurrent());
      const verifyCurrent = () => staticWorld.verifyCurrent() && (!drivingWorld || drivingWorld.verifyCurrent());
      return Object.freeze({ status: "ready", capture: Object.freeze({ revision: drivingWorld?.worldRevision ?? staticWorld.worldRevision, snapshot,
        isCurrent: current, verifyCurrent, release }) });
    },
    captureReturnState: () => ({ view: this.captureReturnView(), cameraNear: this.camera.near, controlsEnabled: this.controls.enabled,
      autoRotate: this.controls.autoRotate, ambientCarsVisible: this.readAmbientCarsVisible() }),
    takeOwnership: (token) => {
      if (this.modeLeases.busy) return false;
      if (!this.setCameraOwner("game")) return false;
      this.gameSceneToken = token;
      this.camera.near = 0.15;
      this.camera.updateProjectionMatrix();
      return true;
    },
    restoreReturnState: (token, value) => {
      if (this.gameSceneToken !== token) return;
      this.gameSceneToken = null;
      const state = value as { view: ReturnCameraView; cameraNear: number; controlsEnabled: boolean; autoRotate: boolean; ambientCarsVisible: boolean };
      if (!this.disposed) {
        this.restoreReturnView(state.view);
        this.camera.near = state.cameraNear;
        this.camera.updateProjectionMatrix();
        this.controls.enabled = state.controlsEnabled;
        this.controls.autoRotate = state.autoRotate;
        this.writeAmbientCarsVisible(state.ambientCarsVisible);
        if (this.cameraOwner === "game") this.cameraOwner = "orbit";
      }
    },
    setFrameHook: (token, hook) => {
      if (this.gameSceneToken !== token) throw new Error("stale-game-scene");
      this.gameFrame = hook;
    },
    attach: (token, objects) => { if (this.gameSceneToken !== token) throw new Error("stale-game-scene"); this.scene.add(...objects); },
    detach: (token, objects) => { if (this.gameSceneToken === token) this.scene.remove(...objects); },
    setCamera: (token, pose: CameraPose) => {
      this.applyGameCameraPose(token, pose);
    },
    setAmbientCarsVisible: (token, visible) => { if (this.gameSceneToken !== token) throw new Error("stale-game-scene"); this.writeAmbientCarsVisible(visible); },
    onReleased: (token) => {
      if (this.gameSceneToken !== token) return;
      // Restore decal pools when leaving driving mode; no analytic lights leak into flight/orbit.
      this.parts?.clearDrivingStreetLamps();
      this.drivingControls?.detach(); this.drivingControls = null;
      this.drivingCamera?.dispose(); this.drivingCamera = null;
      this.drivingCameraScratch = null; this.drivingCameraInitialized = false; this.drivingShakeUntil = 0;
    },
  });

  constructor(private readonly options: CityEngineOptions) {
    // 开发调试钩子（仅 vite dev + ?cityDebug）：把场景与 THREE 挂到 window，供比例尺测量等脚本遍历真实场景图。生产构建不含。
    if (import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("cityDebug")) {
      const self = this;
      // 相机与控制器在构造后段才建好：用 getter 延迟取（截图/量尺寸时把镜头摆到指定物体旁）。
      (window as unknown as { __cityEngine?: unknown }).__cityEngine = { scene: this.scene, THREE, get camera() { return self.camera; }, get controls() { return self.controls; } };
    }
    const canvas = options.canvas;
    // 抗锯齿不再按屏幕像素密度关闭：视网膜屏在 0 档以 1.25 倍渲染再拉伸，没有 MSAA 时楼边与路缘锯齿很重。
    const lowPower = { antialias: true, powerPreference: "low-power" as const, stencil: false };
    this.renderer = new THREE.WebGLRenderer({ canvas, ...lowPower });
    const gl = this.renderer.getContext();
    const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    this.softwareRenderer = !!rendererInfo && /swiftshader|llvmpipe|software|softpipe/i.test(String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = activeTheme().exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(42, 1, 1.5, 8_000);
    this.camera.position.set(150, 120, 170);

    this.controls = options.headless ? {
      target: new THREE.Vector3(), enabled: false, enableDamping: false, enablePan: true, zoomToCursor: true, dampingFactor: 0,
      maxPolarAngle: 1.42, minDistance: 16, maxDistance: 900, autoRotate: false, autoRotateSpeed: 0,
      update: () => { this.camera.lookAt(this.controls.target); return false; }, dispose: () => {},
    } : new OrbitControls(this.camera, canvas as HTMLCanvasElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.42;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 900;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 0.45;
    this.controls.zoomToCursor = true;

    const theme = activeTheme();
    this.scene.background = new THREE.Color(theme.skyHorizon);
    this.hemisphere = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity);
    this.scene.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight(theme.sunColor, theme.sunIntensity);
    this.sun.position.set(120, 160, 70);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 620;
    this.sun.shadow.bias = -0.0006;
    // 太阳是点光源般的远光：影子边缘应当清晰。只留 PCF 自带的 1 像素过滤去锯齿，不加模糊半径。
    this.sun.shadow.radius = 1;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.skyDome = this.buildSkyDome();
    this.scene.add(this.skyDome);
    // 素材异步到达：天空原地换图，parts 按需重建（地面细节 / 立面 / 水面法线）。
    this.assetsReady = loadCityAssets().then((assets) => {
      if (this.disposed || !assets) return;
      this.assets = assets;
      this.applySkyImage();
      this.parts?.applyAssets(assets);
    });

    this.applyQualityLevel(0);
    this.upgradeAfter = performance.now() + 60_000;

    if (options.headless) return;
    const interactiveCanvas = canvas as HTMLCanvasElement;

    const onPointerMove = (event: PointerEvent) => {
      if (this.pointerDown?.id === event.pointerId) this.pointerDown.moved = Math.max(this.pointerDown.moved, Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y));
      this.pointerClient = { x: event.clientX, y: event.clientY };
      const rect = interactiveCanvas.getBoundingClientRect();
      this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      this.pointerMoved = true;
      if (this.repairHook?.onMove) { const ground = this.groundPointAtPointer(); this.repairHook.onMove(ground, this.currentRay()); }
      this.noteActivity();
    };
    const onPointerDown = (event: PointerEvent) => {
      this.interruptCameraFlight();
      this.hoveredId = null;
      this.parts?.setHovered(null);
      this.options.onHover?.(null, 0, 0);
      this.secondaryDown = event.button === 2 && event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() } : null;
      this.pointerDown = event.button === 0 && event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), moved: 0 } : null;
      interactiveCanvas.focus({ preventScroll: true });
      if (this.cinematic) this.stopCinematic();
      if (this.attracted) {
        this.attracted = false;
        this.controls.autoRotate = false;
      }
      this.noteActivity();
    };
    const onPointerUp = (event: PointerEvent) => {
      const secondary = this.secondaryDown;
      this.secondaryDown = null;
      if (secondary && secondary.id === event.pointerId && this.repairHook?.onSecondary && this.cameraOwner !== "game"
        && Math.hypot(event.clientX - secondary.x, event.clientY - secondary.y) < 5 && performance.now() - secondary.at < 500) {
        this.repairHook.onSecondary();
      }
      const down = this.pointerDown;
      this.pointerDown = null;
      this.noteActivity();
      if (!down || down.id !== event.pointerId) return;
      // 模式持有画布时，短点击由模式自己的拾取器处理；不能穿透为选楼或飞镜头。
      if (this.cameraOwner === "game" || this.modeLeases.busy) return;
      const moved = Math.max(down.moved, Math.hypot(event.clientX - down.x, event.clientY - down.y));
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!isSelectionGesture(event.button, event.isPrimary, moved, performance.now() - down.at)) return;
      onPointerMove(event); // Pick at release coordinates, not a stale hover ray.
      this.handleClick();
    };
    const onPointerCancel = () => { this.pointerDown = null; };
    const onPointerLeave = () => {
      this.repairHook?.onMove?.(null, null);
      this.pointerClient = null;
      this.hoveredId = null;
      this.parts?.setHovered(null);
      this.options.onHover?.(null, 0, 0);
    };
    const onWheel = () => { this.interruptCameraFlight(); if (this.cinematic) this.stopCinematic(); this.attracted = false; this.noteActivity(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "f" && this.selectedId) { event.preventDefault(); this.lockSelection(this.selectedId); }
    };
    const onVisibility = () => {
      this.documentHidden = document.visibilityState === "hidden";
      if (this.documentHidden) this.stopLoop();
      else this.startLoop();
    };

    interactiveCanvas.addEventListener("pointermove", onPointerMove);
    interactiveCanvas.tabIndex = 0;
    interactiveCanvas.addEventListener("pointerdown", onPointerDown, true);
    interactiveCanvas.addEventListener("pointerup", onPointerUp);
    interactiveCanvas.addEventListener("pointercancel", onPointerCancel);
    interactiveCanvas.addEventListener("pointerleave", onPointerLeave);
    interactiveCanvas.addEventListener("wheel", onWheel, { passive: true, capture: true });
    interactiveCanvas.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);
    const suspend = () => { this.documentHidden = true; this.stopLoop(); };
    const resume = () => { this.documentHidden = false; this.noteActivity(); this.startLoop(); };
    window.addEventListener("__AV_PLUGIN_SUSPENDED__", suspend);
    window.addEventListener("__AV_PLUGIN_RESUMED__", resume);
    this.observers.push(() => {
      window.removeEventListener("__AV_PLUGIN_SUSPENDED__", suspend);
      window.removeEventListener("__AV_PLUGIN_RESUMED__", resume);
    });
    this.observers.push(
      () => interactiveCanvas.removeEventListener("pointermove", onPointerMove),
      () => interactiveCanvas.removeEventListener("pointerdown", onPointerDown, true),
      () => interactiveCanvas.removeEventListener("pointerup", onPointerUp),
      () => interactiveCanvas.removeEventListener("pointercancel", onPointerCancel),
      () => interactiveCanvas.removeEventListener("pointerleave", onPointerLeave),
      () => interactiveCanvas.removeEventListener("wheel", onWheel, true),
      () => interactiveCanvas.removeEventListener("keydown", onKeyDown),
      () => document.removeEventListener("visibilitychange", onVisibility),
    );

    // Observers only invalidate. Buffer changes and drawing belong to ONE frame:
    // a second rAF could clear the canvas after the render rAF has already drawn.
    const observer = new ResizeObserver(() => { this.surfaceDirty = true; });
    observer.observe(interactiveCanvas.parentElement ?? interactiveCanvas);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stopLoop();
    };
    const onContextRestored = () => {
      this.contextLost = false;
      this.surfaceWidth = 0;
      this.surfaceDirty = this.qualityDirty = true;
      if (!this.documentHidden) this.startLoop();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    this.observers.push(() => {
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
    });

    this.startLoop();
  }

  private noteActivity(): void {
    this.lastActivityAt = performance.now();
  }

  /** 每帧渲染一次水面倒影（画质≥1）。半分辨率：倒影本来就被波纹扰动，全分辨率是浪费。 */
  private renderMirror(): void {
    const parts = this.parts;
    if (!parts) return;
    if (this.quality < 1) {
      parts.setMirror(null, null);
      return;
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(256, Math.floor(size.x / 2));
    const height = Math.max(256, Math.floor(size.y / 2));
    if (!this.mirror) {
      const mirror = new Reflector(new THREE.PlaneGeometry(1, 1), { textureWidth: width, textureHeight: height, clipBias: 0.003 });
      mirror.rotation.x = -Math.PI / 2;
      mirror.position.y = parts.water.position.y;
      mirror.updateMatrixWorld();
      this.mirror = mirror;
    } else {
      const target = this.mirror.getRenderTarget();
      if (target.width !== width || target.height !== height) target.setSize(width, height);
    }
    // 渲染倒影时藏起水面自身，否则镜像相机看到的是水面背面。
    parts.water.visible = false;
    this.mirror.onBeforeRender(this.renderer, this.scene, this.camera, undefined as never, undefined as never, undefined as never);
    parts.water.visible = true;
    // Reflector 的 textureMatrix 末尾乘了它自己的 matrixWorld（对象空间输入）；水面着色器给的是世界坐标，乘回逆矩阵。
    const textureMatrix = (this.mirror.material as THREE.ShaderMaterial).uniforms.textureMatrix.value as THREE.Matrix4;
    this.mirrorMatrix.copy(textureMatrix).multiply(new THREE.Matrix4().copy(this.mirror.matrixWorld).invert());
    parts.setMirror(this.mirror.getRenderTarget().texture, this.mirrorMatrix);
  }

  /** 后处理链：环境光遮蔽（GTAO，画质≥1）给楼脚、街角、楼间缝隙压出体积感；
   *  bloom 只在霓虹主题。都不需要时直渲，省一整条链。省电档（0）两者都关。 */
  private renderFrame(): void {
    // Never yield to the compositor between resetting the drawing buffer and drawing.
    this.flushSurface();
    this.renderMirror();
    const wantAo = this.quality >= 1;
    const wantBloom = activeTheme().neon && this.quality >= 1;
    if (!wantAo && !wantBloom) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const key = `${wantAo ? "ao" : ""}|${wantBloom ? "bloom" : ""}|${this.quality}`;
    if (!this.composer || this.composerKey !== key) {
      this.composer?.dispose();
      const size = this.renderer.getSize(new THREE.Vector2());
      // 后处理链画在自己的离屏缓冲里，画布的 antialias 对它不起作用——给读写缓冲配 4 倍多重采样（1 档以上才进此路径）。
      const ratio = this.renderer.getPixelRatio();
      const target = new THREE.WebGLRenderTarget(Math.max(1, Math.floor(size.x * ratio)), Math.max(1, Math.floor(size.y * ratio)), { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(this.renderer, target);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (wantAo) {
        // GTAOPass 构造时用 new SimplexNoise()（默认 Math.random）生成降噪噪声贴图：每次重建 composer
        // （换画质档/尺寸/新会话）AO 颗粒都不同，导出的片子逐像素不可复现。它不接受随机源参数，
        // 只能在构造期间把 Math.random 换成固定种子的 mulberry32，构造完立即还原。
        const nativeRandom = Math.random;
        let state = 0x9e3779b9;
        Math.random = () => {
          state = (state + 0x6d2b79f5) | 0;
          let t = Math.imul(state ^ (state >>> 15), 1 | state);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        let ao: GTAOPass;
        try {
          ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
        } finally {
          Math.random = nativeRandom;
        }
        // 城市尺度：半径以世界单位计（一层楼约 3.1），够把楼脚和街角压暗、又不把整条街染黑。
        // 半径/厚度过大会在平墙与树旁留下大片黑色污渍（拍照实测），收小到街角尺度。
        ao.updateGtaoMaterial({ radius: 14, distanceExponent: 1, thickness: 8, distanceFallOff: 1, scale: 2.4, samples: this.quality >= 2 ? 16 : 10 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: this.quality >= 2 ? 16 : 8 });
        ao.blendIntensity = 1;
        composer.addPass(ao);
      }
      // 阈值取 HDR 值：霓虹（×3.2）越线，被光照的沙地/天空不会整片泛光。
      if (wantBloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.4, 2.6));
      composer.addPass(new OutputPass());
      composer.setPixelRatio(this.renderer.getPixelRatio());
      composer.setSize(size.x, size.y);
      this.composer = composer;
      this.composerKey = key;
    }
    this.composer.render();
  }

  /** 导出期间的固定渲染尺寸（与窗口无关）；null = 跟随容器。 */
  private exportSize: { width: number; height: number } | null = null;

  private resize(): void {
    const canvas = this.options.canvas;
    const parent = this.options.headless ? null : (canvas as HTMLCanvasElement).parentElement;
    const width = this.exportSize?.width ?? Math.max(1, parent?.clientWidth ?? (this.options.headless ? canvas.width : (canvas as HTMLCanvasElement).clientWidth));
    const height = this.exportSize?.height ?? Math.max(1, parent?.clientHeight ?? (this.options.headless ? canvas.height : (canvas as HTMLCanvasElement).clientHeight));
    const dprCap = this.quality >= 2 ? 2 : this.quality === 1 ? 1.5 : 1.25;
    const pixelRatio = this.exportSize || this.options.headless ? 1 : Math.min(window.devicePixelRatio || 1, dprCap,
      this.softwareRenderer ? Math.min(640 / width, 360 / height) : Infinity);
    if (width === this.surfaceWidth && height === this.surfaceHeight && pixelRatio === this.surfacePixelRatio) return;
    const pixelRatioChanged = pixelRatio !== this.surfacePixelRatio;
    this.surfaceWidth = width;
    this.surfaceHeight = height;
    this.surfacePixelRatio = pixelRatio;
    this.lastSurfaceChangeAt = performance.now();
    // setPixelRatio + setSize would reset the canvas twice. Do it atomically once.
    this.renderer.setDrawingBufferSize(width, height, pixelRatio);
    if (this.composer) {
      if (pixelRatioChanged) this.composer.setPixelRatio(pixelRatio);
      this.composer.setSize(width, height);
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.layout && this.attracted) {
      const home = this.homeView();
      this.camera.position.set(home.x, home.y, home.z);
      this.controls.target.set(this.cityCenter.x, 6, this.cityCenter.z);
    }
  }

  /** 设定地形种子。换种子 = 换一座岛：丢弃旧布局整体重排（地址不再复用）。 */
  async prepareExportAssets(): Promise<void> {
    await Promise.all([this.assetsReady, this.floraReady]);
  }

  photoView(): PhotoView {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(),
      fov: this.camera.fov, elapsed: this.elapsed, cursorMs: this.cursorMs };
  }

  restorePhotoView(view: PhotoView): void {
    this.attracted = false; this.tween = null; this.playing = false;
    this.elapsed = view.elapsed; this.cursorMs = view.cursorMs;
    this.camera.position.fromArray(view.position); this.controls.target.fromArray(view.target);
    this.camera.fov = view.fov; this.camera.updateProjectionMatrix();
    this.parts?.applyCursor(view.cursorMs ?? this.model?.windowEndMs ?? Date.now(), view.cursorMs === null);
    this.updateScene(0);
  }

  get owner(): CameraOwner {
    return this.cameraOwner;
  }

  /** 游戏模式（GameSession）需要的只读入口：布局/模型/回放游标/画布。 */
  get currentLayout(): CityLayout | null {
    return this.layout;
  }

  /** 规划修复（CITY_PLAN_MANUAL_REPAIR_SPEC §13）：当前种子生效的补丁、套用结果（失效清单/id 对照）与未打补丁的底层布局。 */
  get planPatch(): PlanPatchV1 | null {
    return this.planPatchValue && this.planPatchValue.seed === this.seed ? this.planPatchValue : null;
  }

  get planPatched(): PatchedLayout | null {
    return this.planResult;
  }

  get generatedLayout(): CityLayout | null {
    return this.baseLayout;
  }

  /** 设置/清除补丁并重建城市。补丁只对自己的种子生效；移除某条移楼时全量重排一次——
   *  「刷新不搬家」会把那栋楼留在被钉住的地块，不重排就无法回到生成位置。 */
  setPlanPatch(patch: PlanPatchV1 | null): void {
    const previous = this.planPatch;
    this.planPatchValue = patch;
    if (!this.model || this.seed === null) return;
    // 提交分级（路线图 SPEC P0-1）：layoutCity 只为移楼的 pins 存在。钉子没变（只改了路/高架/设施）时，
    // 底层布局不会变——直接在缓存的 baseLayout 上重套补丁。4000 楼实测：每次编辑省掉 ~0.8–1.3 s 的重排。
    if (this.baseLayout && pinsKey(previous, this.seed) === pinsKey(patch, this.seed)) { this.applyModel(this.model, true, true); return; }
    const removed = !!previous && Object.keys(previous.buildingMoves).some((id) => patch?.seed !== this.seed || !(id in patch.buildingMoves));
    this.applyModel(this.model, !removed);
  }

  get currentModel(): CityModel | null {
    return this.model;
  }

  get replayCursor(): number | null {
    return this.cursorMs;
  }

  get domCanvas(): RenderCanvas {
    return this.options.canvas;
  }

  /** 游戏相机控制入口：仅 game 拥有相机期间由 GameSession/FlightCamera 写入。 */
  get renderCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** 游戏对象挂载/摘除（飞机、圆环等）；渲染管线与既有场景不动。 */
  attachGameObjects(...objects: THREE.Object3D[]): void {
    if (this.gameSceneToken) throw new Error("scene-lease-required");
    if (this.modeLeases.busy) throw new Error("mode-lease-active");
    this.scene.add(...objects);
  }

  detachGameObjects(...objects: THREE.Object3D[]): void {
    if (this.gameSceneToken) throw new Error("scene-lease-required");
    if (this.modeLeases.busy) throw new Error("mode-lease-active");
    this.scene.remove(...objects);
  }

  /** 相机所有权切换（§4）。game 接管要求航拍未在进行（互斥由调用方先拒，这里兜底返回 false）；
   *  orbit 归还时恢复 controls；cinematic 所有权由 startCinematic/stopCinematic 自管。 */
  setCameraOwner(owner: CameraOwner): boolean {
    if (this.gameSceneToken && owner !== "game") return false;
    if (this.modeLeases.busy && owner === "orbit") return false; // 租约未释放前不得改判
    if (owner === "game" && this.drivingWorldFrame) return false;
    if (owner === this.cameraOwner) return true;
    if (owner === "game") {
      if (this.cinematic) return false;
      this.controls.enabled = false;
      this.controls.autoRotate = false;
      this.tween = null;
      this.attracted = false;
      this.camera.up.set(0, 1, 0); // 游戏相机可能滚转了 up，归还前复位
    } else if (owner === "orbit") {
      if (this.cinematic) return false; // 航拍持有期间不得改判
      this.controls.enabled = true;
    }
    this.cameraOwner = owner;
    return true;
  }

  /** 取一份独占租约：相机 + 帧钩子 + 叠加对象。冲突时返回 null（调用方应保持
   *  原模式，不得静默覆盖别人的相机/钩子）。release 幂等；过期 token 的写操作
   *  抛 `stale-mode-lease`。 */
  acquireModeLease(options: { camera?: "fixed" | "orbit" } = {}): ModeLease | null {
    if (this.disposed || this.gameSceneToken || this.cinematic || this.drivingWorldFrame || this.gameFrame || this.modeLeases.busy || this.cameraOwner !== "orbit") return null;
    const token = this.modeLeases.acquire();
    if (!token) return null;
    if (options.camera !== "orbit" && !this.setCameraOwner("game")) {
      this.modeLeases.release(token);
      return null;
    }
    const attached = new Set<THREE.Object3D>();
    const current = () => this.modeLeases.isCurrent(token);
    const check = () => { if (!current()) throw new Error("stale-mode-lease"); };
    return {
      id: token.id,
      attach: (objects) => {
        check();
        for (const object of objects) {
          this.scene.add(object);
          attached.add(object);
        }
      },
      setFrameHook: (hook) => {
        check();
        this.gameFrame = hook;
      },
      setOrbitView: (view) => {
        check();
        if (options.camera !== "orbit") throw new Error("orbit-mode-required");
        this.tween = null;
        this.attracted = false;
        this.orbitLockedId = null;
        this.controls.autoRotate = false;
        this.controls.enabled = true;
        this.controls.enablePan = true;
        this.controls.zoomToCursor = true;
        this.controls.minDistance = view.minDistance ?? 36;
        this.controls.maxDistance = view.maxDistance ?? 480;
        this.camera.position.set(view.position.x, view.position.y, view.position.z);
        this.controls.target.set(view.target.x, view.target.y, view.target.z);
        this.camera.up.set(0, 1, 0);
        this.camera.fov = view.fov ?? 40;
        this.camera.updateProjectionMatrix();
        this.clearCameraMomentum();
        this.camera.lookAt(this.controls.target);
      },
      release: () => {
        // The book drops the token before the engine cleanup, so a second call
        // (or a stale lease) cannot clear the next owner's frame hook/camera.
        if (!this.modeLeases.release(token)) return;
        this.gameFrame = null;
        for (const object of attached) this.scene.remove(object);
        attached.clear();
        if (this.cameraOwner === "game") this.setCameraOwner("orbit");
      },
    };
  }

  /** 游戏每帧回调：owner === "game" 时在 updateScene 中调用（dt 秒），不启动第二个绘制循环。 */
  setGameFrameHook(fn: ((dt: number) => void) | null): void {
    if (this.gameSceneToken) throw new Error("scene-lease-required");
    if (this.modeLeases.busy) throw new Error("mode-lease-active");
    if (fn && this.drivingWorldFrame) throw new Error("driving-frame-already-owned");
    this.gameFrame = fn;
  }

  /** 进入游戏前保存返回视角（§8 ReturnState 相机部分；与 photoView 分离，互不复用生命周期）。 */
  captureReturnView(): ReturnCameraView {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
      up: this.camera.up.toArray() as [number, number, number],
      fov: this.camera.fov,
      controls: {
        minDistance: this.controls.minDistance,
        maxDistance: this.controls.maxDistance,
        enablePan: this.controls.enablePan,
        zoomToCursor: this.controls.zoomToCursor,
        orbitLockedId: this.orbitLockedId,
      },
    };
  }

  /** 退出游戏后恢复返回视角：取消未完成 tween、复位 up/FOV/OrbitControls 参数。 */
  restoreReturnView(view: ReturnCameraView): void {
    this.tween = null;
    this.attracted = false;
    this.camera.up.fromArray(view.up);
    this.camera.position.fromArray(view.position);
    this.controls.target.fromArray(view.target);
    this.camera.fov = view.fov;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = view.controls.minDistance;
    this.controls.maxDistance = view.controls.maxDistance;
    this.controls.enablePan = view.controls.enablePan;
    this.controls.zoomToCursor = view.controls.zoomToCursor;
    this.clearCameraMomentum();
    this.camera.lookAt(this.controls.target);
    this.updateScene(0);
  }

  /** 背景楼策略（CITY_DATA_LEGIBILITY_SPEC F4）：换档即重排背景楼（会话楼地址不变）。 */
  setBackdrop(mode: BackdropMode): void {
    if (mode === this.backdrop) return;
    this.backdrop = mode;
    if (this.model && this.seed !== null) this.applyModel(this.model, true);
  }

  setSeed(seed: number): void {
    if (seed === this.seed) return;
    const first = this.seed === null;
    this.seed = seed;
    this.surfacePort.invalidate();
    this.drivingWorldPort.invalidate();
    this.layout = null;
    this.baseLayout = null;
    this.planResult = null;
    if (this.model) this.applyModel(this.model, false);
    if (!first) this.resetView();
  }

  /** reuse=false：丢弃上一布局做全量重排（分页到齐后的圈层修正）。
   *  keepBase：模型与钉子都没变，沿用缓存的底层布局只重套补丁（setPlanPatch 的快路径）。 */
  applyModel(model: CityModel, reuse = true, keepBase = false): void {
    const previousModel = this.model;
    const sameModel = model === previousModel;
    this.model = model;
    if (this.seed === null) return;
    const patch = this.planPatch;
    const base = keepBase && sameModel && this.baseLayout ? this.baseLayout
      : layoutCity(model, reuse ? this.baseLayout : null, this.seed, MIAMI_COASTAL, this.backdrop, layoutPinsFor(patch));
    const planResult = patch ? applyPlanPatch(base, patch) : null;
    const layout = planResult ? planResult.layout : base;
    // 同岛分页：不拆 CityParts / 实例网格 / 相机 / 选中态；只把新楼写进已有批次。
    // 修订导致会话丢失或搬家时走下面的整层重建。
    if (reuse && this.parts && previousModel && this.layout && occupantsCanAppend(previousModel, model, this.layout, layout)) {
      this.baseLayout = base;
      this.planResult = planResult;
      this.layout = layout;
      this.lastApplyMode = "append";
      this.parts.appendOccupants(model, layout);
      this.drivingWorldPort.invalidate();
      this.parts.setLabelsVisible(true);
      this.parts.setQualityLevel(this.quality);
      if (this.cursorMs !== null) this.parts.applyCursor(this.cursorMs, false, this.playbackSpeed * 1000);
      this.parts.snapToTargets();
      this.parts.setSelected(this.selectedId?.startsWith("decor:") ? null : this.selectedId);
      this.parts.setHovered(this.hoveredId);
      this.reapplyKits("append");
      if (!this.options.headless && !this.contextLost) {
        this.updateScene(0);
        this.renderFrame();
        this.lastRenderAt = performance.now();
        if (!this.firstFrameSent) {
          this.firstFrameSent = true;
          this.options.onFirstFrame?.();
        }
      }
      return;
    }
    // 重建前抓显示进度：回访的楼保持高度（不闪缩、不重演生长），新到的楼从 0 长入。
    const previousDisplays = this.parts ? this.parts.displaySnapshot() : null;
    this.lastApplyMode = "mount";
    this.hostEpoch += 1;
    this.gameScenePort.invalidate();
    this.surfacePort.invalidate();
    this.drivingWorldPort.invalidate();
    if (this.parts) {
      this.scene.remove(this.parts.group, this.parts.water);
      this.parts.dispose();
      this.parts = null;
    }
    this.baseLayout = base;
    this.planResult = planResult;
    this.layout = layout;
    this.parts = new CityParts(model, layout, previousDisplays);
    if (this.assets) this.parts.applyAssets(this.assets);
    this.parts.setSkyMix(this.dayMix);
    this.lastSkyHour = -1; // 新建的 parts 还是白天默认状态：强制下一帧按当前时刻重新应用昼夜（灯光/亮窗/天空）
    // 生态带植被异步到达：只在 parts 仍是这一份时替换（换种子/换主题会重建 parts）。
    const parts = this.parts;
    this.floraReady = loadBiomeFlora(layout.biome).then((flora) => { if (this.parts === parts && !this.disposed) parts.applyFlora(flora); });
    this.scene.add(this.parts.group, this.parts.water);
    this.reapplyKits("mount");

    this.cityCenter = { x: (layout.urbanBounds.left + layout.urbanBounds.right) / 2, z: (layout.urbanBounds.north + layout.urbanBounds.south) / 2 };
    this.aurora?.dispose();
    this.aurora = new CityAurora(this.cityCenter, Math.max(120, layout.boundsRadius) * 0.6);
    this.scene.add(this.aurora.group);
    this.ambient?.dispose();
    this.ambient = new CityAmbient(this.cityCenter, Math.max(120, layout.boundsRadius) * 0.6, layout.terrain.height, layout.river);
    this.scene.add(this.ambient.group);
    this.wildlife?.dispose();
    // 萤火虫落点：城市公园与小区花园里撒点在前（确定性环形分布），山林/海岸的 parkTrees 在后。
    // 规划层的植树跳过所有高度 < 2.5 的点，而城市公园都在低平地上——曾只拿 parkTrees，萤火虫全落在
    // 山坡和海岸，公园里一只都没有（审计夜景实测）。
    const fireflySpots: Array<{ x: number; z: number; y: number }> = [];
    const ground = (x: number, z: number) => Math.max(0, layout.terrain.height(x, z));
    for (const site of layout.publicSites) {
      if (site.kind !== "park") continue;
      for (let i = 0; i < 48; i += 1) {
        const a = i * 2.399; const r = site.radius * 0.85 * Math.sqrt((i + 0.5) / 48);
        const x = site.x + Math.cos(a) * r; const z = site.z + Math.sin(a) * r;
        fireflySpots.push({ x, z, y: ground(x, z) });
      }
    }
    for (const garden of layout.gardens ?? []) {
      for (let i = 0; i < 14; i += 1) {
        const a = i * 2.399; const r = Math.min(garden.width, garden.depth) * 0.45 * Math.sqrt((i + 0.5) / 14);
        const x = garden.x + Math.cos(a) * r; const z = garden.z + Math.sin(a) * r;
        fireflySpots.push({ x, z, y: garden.y });
      }
    }
    fireflySpots.push(...(layout.parkTrees ?? []));
    this.wildlife = new CityWildlife(this.cityCenter, Math.max(120, layout.boundsRadius), fireflySpots, layout.seaMountains ?? [], layout.districts.flatMap((district) => district.carPaths), ground);
    this.scene.add(this.wildlife.group);
    if (!this.fillLight) {
      this.fillLight = new THREE.DirectionalLight("#cfe8ef", 0.35);
      this.backLight = new THREE.DirectionalLight("#ffffff", 0.15);
      this.scene.add(this.fillLight, this.backLight);
    }
    const bounds = Math.max(100, Math.hypot(layout.urbanBounds.right - layout.urbanBounds.left, layout.urbanBounds.south - layout.urbanBounds.north) / 2 + 35);
    this.boundsRadius = bounds;
    this.controls.maxDistance = bounds * 4.5;
    this.scene.fog = new THREE.Fog(new THREE.Color(activeTheme().fog), bounds * 2.1, bounds * 7.5);
    const shadowBox = bounds * 0.85 + 24;
    const shadowCamera = this.sun.shadow.camera as THREE.OrthographicCamera;
    this.placeSun();
    shadowCamera.far = this.sunDistance() + shadowBox * 2;
    shadowCamera.left = -shadowBox;
    shadowCamera.right = shadowBox;
    shadowCamera.top = shadowBox;
    shadowCamera.bottom = -shadowBox;
    shadowCamera.updateProjectionMatrix();

    if (this.attracted) {
      // 首个模型：入场镜头（远处高处 → 默认视角）。
      const home = this.homeView();
      this.flyTo(home, { ...this.cityCenter, y: 6 }, 900);
    }
    this.parts.setLabelsVisible(true);
    this.parts.setQualityLevel(this.quality);
    if (this.cursorMs !== null) this.parts.applyCursor(this.cursorMs, false, this.playbackSpeed * 1000);
    // 重建后 display 是「已完工」初值：先对齐到当前时间轴进度，否则回放中
    // 每次数据发布（分页到齐/后台刷新）都会看到城市闪满高再缩回去。
    this.parts.snapToTargets();
    // Present the newly mounted model before the loading overlay is dismissed.
    // A newly attached WKWebView may withhold rAF until its drawing surface has
    // been presented; later model replacements also need a fresh frame rather
    // than relying on CityApp to mistake applyModel() for a render.
    if (!this.options.headless && !this.contextLost) {
      this.updateScene(0);
      this.renderFrame();
      this.lastRenderAt = performance.now();
      if (!this.firstFrameSent) {
        this.firstFrameSent = true;
        this.options.onFirstFrame?.();
      }
    }
  }

  private sunDistance(): number {
    return Math.max(900, this.boundsRadius * 2.2);
  }

  /** 按主题的方位/高度角放太阳。曾放在城市中心正上方约 bounds 高、水平只偏 139 处——
   *  高度角约 79°，影子只有楼高的五分之一、全藏在楼底下，看起来像「没有太阳」。 */
  private placeSun(): void {
    const theme = activeTheme();
    const azimuth = THREE.MathUtils.degToRad(theme.sunAzimuthDeg);
    const elevation = THREE.MathUtils.degToRad(theme.sunElevationDeg);
    const distance = this.sunDistance();
    this.sun.position.set(
      this.cityCenter.x + Math.cos(azimuth) * Math.cos(elevation) * distance,
      Math.sin(elevation) * distance,
      this.cityCenter.z + Math.sin(azimuth) * Math.cos(elevation) * distance,
    );
    this.sun.target.position.set(this.cityCenter.x, 0, this.cityCenter.z);
    this.sun.target.updateMatrixWorld();
  }

  private homeView(): { x: number; y: number; z: number } {
    const bounds = Math.max(120, this.boundsRadius);
    // Frame the city rather than leaving excessive ocean margin: screenshots
    // showed the street fabric occupying too little of the default view.
    // The embedded landing prioritizes the skyline; native overview is unchanged.
    const landing = typeof window !== "undefined" && window.parent !== window
      && new URLSearchParams(window.location.search).get("presentation") === "landing";
    const fit = (landing ? 0.72 : 0.95) * Math.max(1, 1 / this.camera.aspect);
    // 海滨锚定取景（VICE B5）：有海滨带时，默认视角从海侧看向酒店街——
    // 「酒店—步道—棕榈—沙滩—浅海」的断面在首屏即可辨认（识别锚点）。
    const seaside = this.layout?.seaside;
    if (!landing && seaside && !seaside.degraded && seaside.samples.length) {
      const valid = seaside.samples.filter((s) => s.valid);
      if (valid.length) {
        const mid = valid[Math.floor(valid.length / 2)];
        // 相机在海侧（水线外 0.75×bounds），看向酒店线后方的城心。
        const out = { x: -mid.inward.x, z: -mid.inward.z };
        const camX = mid.waterline.x + out.x * bounds * 0.55;
        const camZ = mid.waterline.z + out.z * bounds * 0.55;
        const camY = bounds * 0.42;
        // 保证视线不全被楼挡：稍微抬高并偏向城心侧。
        const kx = this.cityCenter.x - camX; const kz = this.cityCenter.z - camZ;
        const kl = Math.hypot(kx, kz) || 1;
        return { x: camX - (kx / kl) * bounds * 0.2, y: camY, z: camZ - (kz / kl) * bounds * 0.2 };
      }
    }
    return { x: this.cityCenter.x + bounds * 0.86 * fit, y: bounds * 1.05 * fit, z: this.cityCenter.z + bounds * 1.16 * fit };
  }

  private flyTo(position: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, duration: number): void {
    this.clearCameraMomentum();
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: new THREE.Vector3(position.x, position.y, position.z),
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(target.x, target.y, target.z),
      start: this.elapsed,
      duration: duration / 1000,
    };
  }

  private clearCameraMomentum(): void {
    const position = this.camera.position.clone(), target = this.controls.target.clone();
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update(); // Consume OrbitControls' residual deltas without jumping the view.
    this.camera.position.copy(position); this.controls.target.copy(target);
    this.controls.update();
    this.controls.enableDamping = damping;
  }

  private interruptCameraFlight(lockTarget = true): void {
    if (!this.tween) return;
    // Input cancels movement immediately, but orbit must already use the building centre.
    if (lockTarget && this.orbitLockedId) this.controls.target.copy(this.tween.toTarget);
    this.tween = null;
    this.clearCameraMomentum();
  }

  releaseOrbitLock(): void {
    if (this.orbitLockedId) this.interruptCameraFlight(false);
    this.orbitLockedId = null;
    this.controls.enablePan = true;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 3;
    this.controls.maxDistance = Math.max(this.boundsRadius * 4.5, this.camera.position.distanceTo(this.controls.target));
    this.options.onOrbitLock?.(null);
  }

  /** Selection changes only the orbit pivot, never dollies or flies the camera. */
  lockSelection(id: string): boolean {
    if (!this.parts) return false;
    const anchor = id.startsWith("decor:") ? null : this.parts.focusAnchorFor(id);
    const target = anchor ? new THREE.Vector3(anchor.x, anchor.ground + anchor.height * 0.5, anchor.z)
      : this.pickedDecor?.id === id ? this.pickedDecor.point.clone()
      : this.selectedId === id ? this.orbitLockedPoint?.clone() : null;
    if (!target || !target.toArray().every(Number.isFinite)) return false;
    if (this.cinematic) this.stopCinematic();
    this.interruptCameraFlight(false);
    this.setSelected(id);
    this.attracted = false;
    this.controls.autoRotate = false;
    const position = this.camera.position.clone();
    this.controls.enablePan = false;
    this.controls.zoomToCursor = false;
    const distance = position.distanceTo(target);
    this.controls.minDistance = Math.min(3, distance);
    this.controls.maxDistance = Math.max(this.boundsRadius * 4.5, distance);
    this.orbitLockedId = id;
    this.orbitLockedPoint = target.clone();
    const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Same start/end position: interpolate only the look-at pivot, never zoom on selection.
    this.flyTo(position, target, reduceMotion ? 1 : 360);
    this.options.onOrbitLock?.(id);
    this.noteActivity();
    return true;
  }

  private buildingViewPosition(id: string, target: THREE.Vector3, direction: THREE.Vector3, distance: number): THREE.Vector3 {
    const ray = new THREE.Raycaster();
    const objects = [...(this.parts?.raycastTargets ?? []), ...(this.parts?.decorTargets ?? [])];
    const occupied: THREE.Box3[] = [];
    const matrix = new THREE.Matrix4();
    for (const object of objects) {
      // Instanced buildings grow after their first raycast; cached bounds can be stale.
      if (object instanceof THREE.InstancedMesh) object.computeBoundingSphere();
      object.updateWorldMatrix(true, false);
      if (object instanceof THREE.InstancedMesh) {
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (object.geometry.boundingBox) for (let index = 0; index < object.count; index++) {
          if (this.parts?.idAt(object, index) === id) continue;
          object.getMatrixAt(index, matrix);
          occupied.push(object.geometry.boundingBox.clone().applyMatrix4(matrix).applyMatrix4(object.matrixWorld).expandByScalar(this.camera.near));
        }
      }
    }
    let best = target.clone().addScaledVector(direction, distance * 0.5).add(new THREE.Vector3(0, distance * Math.sqrt(0.75), 0));
    let fewestBlockers = Infinity;
    // A focus action may choose a nearby azimuth instead of flying inside an adjacent tower.
    // This is a bounded one-off search, never a per-frame picking loop.
    for (const scale of [1, 2, 4]) for (const angle of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const heading = direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      const position = target.clone().addScaledVector(heading, distance * scale * 0.5).add(new THREE.Vector3(0, distance * scale * Math.sqrt(0.75), 0));
      ray.set(position, target.clone().sub(position).normalize());
      ray.far = position.distanceTo(target);
      const blockers = ray.intersectObjects(objects, false).filter(hit => {
        const hitId = hit.instanceId === undefined ? null : this.parts?.idAt(hit.object, hit.instanceId);
        return hitId !== id;
      }).length + occupied.filter(box => box.containsPoint(position)).length;
      if (blockers < fewestBlockers) { best = position; fewestBlockers = blockers; }
      if (blockers === 0) return position;
    }
    return best;
  }

  resetView(): void {
    const home = this.homeView();
    const damaged = ![...this.camera.position.toArray(), ...this.controls.target.toArray(), ...this.camera.quaternion.toArray()].every(Number.isFinite);
    if (damaged) {
      // NaN cannot be lerped away. Repair the endpoints before touching OrbitControls.
      this.tween = null;
      this.orbitLockedId = null;
      this.camera.position.set(home.x, home.y, home.z);
      this.controls.target.set(this.cityCenter.x, 6, this.cityCenter.z);
      this.controls.minDistance = 3;
      this.controls.maxDistance = Math.max(900, this.boundsRadius * 4.5);
      this.camera.lookAt(this.controls.target);
      console.warn("[city-camera] recovered invalid view on reset");
    }
    this.releaseOrbitLock();
    this.setSelected(null);
    this.flyTo(home, { ...this.cityCenter, y: 6 }, 900);
    this.options.onSelect?.(null);
  }

  focusBuilding(id: string): boolean {
    if (!this.parts) return false;
    if (this.cinematic) this.stopCinematic();
    const resolved = this.parts.sessionIdForAsset(id) ?? id;
    const anchor = this.parts.focusAnchorFor(resolved);
    if (!anchor) return false;
    this.setSelected(resolved); // Keyboard/menu selection must also update the engine's selected target.
    this.attracted = false;
    const framing = buildingFrame(anchor.height, anchor.footprint, this.camera.fov, this.camera.aspect);
    const target = new THREE.Vector3(anchor.x, anchor.ground + anchor.height * 0.5, anchor.z);
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).setY(0).normalize();
    if (direction.lengthSq() < 0.01) direction.set(0.8, 0, 0.6).normalize();
    // Start with neighbourhood context for small buildings; wheel zoom remains much closer.
    const position = this.buildingViewPosition(resolved, target, direction, Math.max(framing.distance, framing.minDistance * 6));
    this.controls.enablePan = false;
    this.controls.zoomToCursor = false;
    this.controls.minDistance = framing.minDistance;
    this.controls.maxDistance = Math.max(this.boundsRadius * 4.5, position.distanceTo(target) * 1.5);
    this.orbitLockedId = resolved;
    this.options.onOrbitLock?.(resolved);
    this.flyTo(position, target, 550);
    return true;
  }

  /** 建筑说明「查看实时模型」：把相机飞到该类建筑在本岛上的一个实例（与 cityCatalog 的 id 对应）。找不到返回 false。 */
  focusCatalog(id: string): boolean {
    const target = this.catalogTarget(id);
    if (!target) return false;
    this.releaseOrbitLock();
    const [x, y, z, d] = target;
    this.flyTo({ x: x + d * 0.8, y: y + d * 0.45, z: z + d * 0.8 }, { x, y, z }, 1100);
    return true;
  }

  /** 建筑说明条目在本岛上的取景点 [x, y, z, 距离]；本岛没有该类建筑时返回 null。 */
  catalogTarget(id: string): number[] | null {
    const L = this.layout; const P = this.parts; const model = this.model;
    if (!L || !P || !model) return null;
    if (id.startsWith("district-service:")) {
      const key = id.slice("district-service:".length);
      const civic = L.civics.find((item) => `${item.districtId}:${item.kind}` === key);
      return civic ? [civic.x, civic.y + 8, civic.z, 95] : null;
    }
    const slots = new Map(L.districts.flatMap((district) => [...district.slots]));
    const pick = (pred: (b: CityModel["buildings"][number], s: { blockId: string }) => boolean) => {
      for (const building of model.buildings) {
        const slot = slots.get(building.id);
        if (slot && pred(building, slot)) return [slot.x, building.height * 0.5, slot.z, Math.max(45, building.height * 2.2 + 25)];
      }
      return null;
    };
    const landmark = (kind: string, h: number, d: number) => {
      const l = (L.landmarks ?? []).find((x) => x.kind === kind);
      return l ? [l.to ? (l.x + l.to.x) / 2 : l.x, h, l.to ? (l.z + l.to.z) / 2 : l.z, d] : null;
    };
    const suspension = (L.landmarks ?? []).find((l) => l.kind === "suspension-bridge");
    const truss = (L.bridges ?? []).find((b) => !(suspension && Math.hypot(b.from.x - suspension.x, b.from.z - suspension.z) < 1));
    const harbor = L.publicSites.find((s) => s.kind === "harbor");
    const sample = L.seaside?.samples.filter((q) => q.valid)[0];
    const districtLandmark = (L.districtLandmarks ?? [])[0];
    const civicOf = (kind: string) => { const c = (L.civics ?? []).find((x) => x.kind === kind); return c ? [c.x, 8, c.z, 60] : null; };
    const site = (kind: string, h: number, d: number) => { const s = L.publicSites.find((x) => x.kind === kind); return s ? [s.x, h, s.z, d] : null; };
    const targets: Record<string, () => number[] | null> = {
      "session-tower": () => pick((b) => P.formOf(b) === "tower" && b.height > 25),
      "session-slab": () => pick((b) => P.formOf(b) === "slab" && b.height > 12),
      "session-deco": () => pick((b, s) => P.facadeFor(b) === 3 && !s.blockId.startsWith("hotel:")),
      "hero-tower": () => { let best: CityModel["buildings"][number] | null = null; for (const b of model.buildings) if (!best || b.tokensTotal > best.tokensTotal) best = b; const slot = best ? slots.get(best.id) : null; return best && slot ? [slot.x, best.height * 0.6, slot.z, Math.max(60, best.height * 2.4)] : null; },
      "session-hotel": () => pick((_b, s) => s.blockId.startsWith("hotel:")),
      "district-landmark": () => (districtLandmark ? [districtLandmark.x, 45, districtLandmark.z, 150] : null),
      "twin-towers": () => landmark("twin-towers", 38, 160),
      villa: () => landmark("villa-complex", 8, 80),
      "ferris-wheel": () => landmark("ferris-wheel", 26, 95),
      "sail-opera": () => landmark("sail-opera", 10, 75),
      "suspension-bridge": () => landmark("suspension-bridge", 12, 95),
      "truss-bridge": () => (truss ? [(truss.from.x + truss.to.x) / 2, 4, (truss.from.z + truss.to.z) / 2, 55] : null),
      airport: () => (L.airport ? [L.airport.centre.x, 6, L.airport.centre.z, 230] : null),
      harbor: () => (harbor ? [harbor.x, 6, harbor.z, 75] : null),
      hospital: () => civicOf("hospital"), school: () => civicOf("school"), mall: () => civicOf("mall"),
      garden: () => { const g = (L.gardens ?? [])[0]; return g ? [g.x, 2, g.z, 60] : null; },
      beach: () => (sample ? [sample.dryOuter.x, 2, sample.dryOuter.z, 34] : null),
      "civic-hall": () => site("civic", 10, 95),
      station: () => site("station", 6, 95),
      stadium: () => site("stadium", 6, 100),
      "observation-tower": () => site("tower", 28, 90),
      park: () => site("park", 3, 95),
      "tv-tower": () => landmark("tv-tower", 34, 120),
      arch: () => landmark("arch", 16, 120),
      lighthouse: () => landmark("lighthouse", 14, 95),
      "twist-tower": () => landmark("twist-tower", 34, 130),
      pagoda: () => landmark("pagoda", 14, 70),
      signs: () => {
        // 广告牌（L-2）：取第一组已摆放的立牌/路边牌立柱（未用槽位被藏在 y = -40）。
        const mesh = (P as unknown as { signPostMesh?: THREE.InstancedMesh }).signPostMesh;
        if (!mesh) return null;
        const m = new THREE.Matrix4();
        for (let i = 0; i < mesh.count; i += 1) { mesh.getMatrixAt(i, m); if (m.elements[13] > -5) return [m.elements[12], m.elements[13] + 7, m.elements[14], 48]; }
        return null;
      },
      expressway: () => { const run = (L.highways ?? [])[0]; const p = run?.[Math.floor((run?.length ?? 0) / 3)]; return p ? [p.x, 8, p.z, 70] : null; },
    };
    return targets[id]?.() ?? null;
  }

  focusDistrict(districtId: string): boolean {
    if (!this.parts) return false;
    const anchor = this.parts.districtAnchor(districtId);
    if (!anchor) return false;
    this.releaseOrbitLock();
    this.attracted = false;
    // A low-volume district has radius's 30-unit floor; 2.6× pushed the camera
    // inside the new pastel context skyline and clipped the tower crowns. Keep
    // a useful neighborhood view while scaling out naturally for larger districts.
    const distance = Math.max(108, anchor.radius * 3);
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).setY(0).normalize();
    if (direction.lengthSq() < 0.01) direction.set(0.8, 0, 0.6).normalize();
    const position = new THREE.Vector3(anchor.x, anchor.y, anchor.z).addScaledVector(direction, distance).add(new THREE.Vector3(0, distance * 0.7, 0));
    this.flyTo(position, { x: anchor.x, y: anchor.y, z: anchor.z }, 900);
    return true;
  }

  setQualityMode(mode: EngineQualityMode): void {
    if (mode === this.qualityMode) return;
    this.qualityMode = mode;
    this.lowFpsWindows = this.highFpsWindows = 0;
    if (mode === "high") this.applyQualityLevel(2);
    else if (mode === "eco") this.applyQualityLevel(0);
    else this.applyQualityLevel(0);
  }

  private applyQualityLevel(level: QualityLevel): void {
    if (this.quality === level && !this.exportSize) return;
    this.quality = level;
    this.qualityDirty = this.surfaceDirty = true;
  }

  private flushSurface(): void {
    if (this.qualityDirty) {
      this.qualityDirty = false;
      const level = this.quality;
      this.renderer.shadowMap.enabled = level >= 1;
      // 阴影盒覆盖约 1200 单位：1024 时一个阴影像素 ≈ 1.2 单位，楼宽 6–10 的影子糊成一团。
      const size = level >= 2 ? 4096 : 2048;
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
      this.parts?.setQualityLevel(level);
    }
    // Also notices DPR changes when moving between displays. Export dimensions
    // may change without a ResizeObserver notification.
    this.resize();
    this.surfaceDirty = false;
  }

  setLabelsVisible(visible: boolean): void {
    this.parts?.setLabelsVisible(visible);
  }

  /** 地块预算之外、被聚合为背景楼群的会话数（HUD 如实展示）。 */
  get overflowCount(): number {
    return (this.layout?.massing ?? []).reduce((sum, block) => sum + block.count, 0);
  }

  /** 模型重建后恢复选中态（刷新不打断用户的浏览上下文）。 */
  setSelected(id: string | null): void {
    if (id !== this.selectedId) this.orbitLockedPoint = null;
    this.selectedId = id;
    if (!id || (this.orbitLockedId && this.orbitLockedId !== id)) this.releaseOrbitLock();
    this.parts?.setSelected(id?.startsWith("decor:") ? null : id);
  }

  setHovered(id: string | null): void {
    this.hoveredId = id;
    this.parts?.setHovered(id);
  }

  /** 时间游标：null = live（跟随现在）；play = 以 speed 倍率回放。 */
  setTimeCursor(ms: number | null, options?: { playing?: boolean; speed?: number }): void {
    this.cursorMs = ms;
    if (options?.playing !== undefined) this.playing = options.playing;
    if (options?.speed !== undefined) this.playbackSpeed = options.speed;
    if (ms !== null) { this.parts?.applyCursor(ms, false, this.playbackSpeed * 1000); this.parts?.snapToTargets(true); } // 时间跳变时直接对齐城市
    else if (this.model) this.parts?.applyCursor(this.model.windowEndMs, true);
    this.noteActivity();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 规划修复模式（planRepair/）：挂上钩子后画布选取手势交给钩子；null 恢复原行为。 */
  setRepairHook(hook: RepairHook | null): void {
    this.repairHook = hook;
    this.noteActivity();
  }

  /** 画布光标样式（修复模式的画路/橡皮擦用十字）；空串恢复默认。 */
  setCursor(cursor: string): void {
    if (!this.options.headless) (this.options.canvas as HTMLCanvasElement).style.cursor = cursor;
  }

  /** 叠加层（候选地块高亮等）：直接挂在场景根上，不随 CityParts 重建而销毁。 */
  addOverlay(object: THREE.Object3D): void {
    this.scene.add(object);
    this.noteActivity();
  }

  removeOverlay(object: THREE.Object3D): void {
    this.scene.remove(object);
    this.noteActivity();
  }

  /** Car presentation shares the leased frame loop; no independent camera timer.
   * 与演练场同一套 VehicleChaseCamera 内核（阻尼 15/20）：手动 lerp(5/10) 版本存在
   * ~2.7 单位稳态滞后，驾驶中的转动与变向会持续糊。环绕/缩放由挂在该帧上的
   * FlightCameraControls 驱动。每次写相机都用活动场景 token 授权。 */
  presentDrivingCamera(pose: Readonly<{ x: number; y: number; z: number; heading: number; speed?: number }>, dt = 1 / 60,
    cameraSweep?: CameraClearanceQuery, sceneLease?: Pick<GameSceneLease<unknown, THREE.Object3D>, "token" | "isCurrent" | "setCamera">): ChaseCameraSafety {
    const token = this.gameSceneToken;
    if (!token || !sceneLease || sceneLease.token !== token || !sceneLease.isCurrent() || ![pose.x, pose.y, pose.z, pose.heading].every(Number.isFinite)) return "unresolved";
    if (!this.drivingCamera) {
      const reducedMotion = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      this.drivingCameraScratch = this.camera.clone();
      this.drivingCamera = new CarCamera(this.drivingCameraScratch, reducedMotion);
      if (!this.options.headless && this.options.canvas instanceof HTMLElement) {
        this.drivingControls = new FlightCameraControls({ canvas: this.options.canvas, camera: () => this.drivingCamera,
          isActive: () => this.gameSceneToken === token && sceneLease.isCurrent() });
        this.drivingControls.attach();
      }
    }
    const safeDt = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    // y 是支撑面高度：车停在桥面板/岛缘等实体上时，相机包络必须从车身中心出发
    // （sweepLift=半高），否则包络立方体与车下实体重叠 → 假「无法确认净空」暂停。
    const target = { x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, speed: pose.speed ?? 0, maxSpeed: DRIVING_PARAMS.maxForward, sweepLift: CAR_DIMENSIONS.height / 2 };
    if (!this.drivingCameraInitialized) { this.drivingCameraInitialized = true; this.drivingCamera.reset(target); }
    const failClosedSweep: CameraClearanceQuery = cameraSweep ?? (() => ({ status: "unresolved" }));
    const safety = this.drivingCamera.update(safeDt, target, { terrain: (x: number, z: number) => this.layout?.terrain.height(x, z) ?? 0, cameraSweep: failClosedSweep });
    if (safety === "unresolved") return safety;
    const camera = this.drivingCameraScratch;
    if (!camera || this.gameSceneToken !== token) return "unresolved";
    const direction = camera.getWorldDirection(new THREE.Vector3());
    const targetPoint = camera.position.clone().addScaledVector(direction, 10);
    sceneLease.setCamera({ position: camera.position.toArray() as [number, number, number],
      target: targetPoint.toArray() as [number, number, number], up: camera.up.toArray() as [number, number, number], fov: camera.fov });
    // N5: update the nearest analytic street lamps from the final leased camera pose.
    this.parts?.updateDrivingStreetLamps(camera.position.x, camera.position.z);
    return safety;
  }

  private applyGameCameraPose(token: symbol, pose: CameraPose): void {
    if (this.gameSceneToken !== token || ![...pose.position, ...pose.target, ...pose.up, pose.fov].every(Number.isFinite) ||
      pose.fov <= 0 || pose.fov >= 180) throw new Error("stale-game-scene");
    const direction = pose.target.map((value, index) => value - pose.position[index]);
    const upLength = Math.hypot(...pose.up), directionLength = Math.hypot(...direction);
    const cross = [pose.up[1] * direction[2] - pose.up[2] * direction[1], pose.up[2] * direction[0] - pose.up[0] * direction[2], pose.up[0] * direction[1] - pose.up[1] * direction[0]];
    if (upLength < 1e-8 || directionLength < 1e-8 || Math.hypot(...cross) <= upLength * directionLength * 1e-8) throw new Error("invalid-camera-pose");
    this.camera.position.fromArray(pose.position); this.camera.up.fromArray(pose.up); this.controls.target.fromArray(pose.target);
    this.camera.fov = pose.fov; this.camera.updateProjectionMatrix(); this.camera.lookAt(this.controls.target);
  }

  /** 撞击反馈入口（由驾驶 present 回调在 blocked 上升沿调用）：触发短暂相机抖动。 */
  pulseDrivingImpact(): void {
    if (!this.gameSceneToken) return;
    this.drivingShakeUntil = performance.now() + 200;
  }

  /** 指针射线与地形的交点（迭代逼近地形高度，3 轮足够；射线朝天或在城市包围盒外返回 null）。 */
  private groundPointAtPointer(): { x: number; z: number } | null {
    if (!this.layout) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const { origin, direction } = this.raycaster.ray;
    if (direction.y >= -1e-4) return null;
    let y = 0;
    let x = 0; let z = 0;
    for (let i = 0; i < 4; i += 1) {
      const t = (y - origin.y) / direction.y;
      x = origin.x + direction.x * t; z = origin.z + direction.z * t;
      y = Math.max(0, this.layout.terrain.height(x, z));
    }
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  }

  /** 指针射线（世界坐标），取自最近一次 setFromCamera。 */
  private currentRay(): RepairRay {
    const { origin, direction } = this.raycaster.ray;
    return { origin: { x: origin.x, y: origin.y, z: origin.z }, direction: { x: direction.x, y: direction.y, z: direction.z } };
  }

  /** 把相机飞到地面一点（体检「定位」用）。 */
  focusPoint(x: number, z: number): void {
    this.releaseOrbitLock();
    const y = Math.max(0, this.layout?.terrain.height(x, z) ?? 0);
    const d = 70;
    this.flyTo({ x: x + d * 0.8, y: y + d * 0.55, z: z + d * 0.8 }, { x, y, z }, 900);
  }

  private handleClick(): void {
    if (this.drivingWorldFrame) return;
    if (!this.parts) return;
    if (this.repairHook) {
      const picked = this.pick();
      const ground = this.groundPointAtPointer();
      this.repairHook.onClick({ pickedId: picked, ground, ray: this.currentRay() });
      return;
    }
    const id = this.pick();
    const play = playableKind(id) ? this.playableAt(id!) : null;
    if (play) { this.options.onPlay?.(play); return; }
    if (id && id.startsWith("decor:")) {
      // Decorations share orbit locking, but not session-only selection rings.
      this.lockSelection(id);
      this.options.onSelect?.(id);
    } else if (id) {
      this.lockSelection(id);
      this.options.onSelect?.(id);
    } else {
      this.setSelected(null);
      this.options.onSelect?.(null);
    }
  }

  /** 可开载具的世界位姿：车 = 停车位与车头朝向（出发点就是这座地标）；飞机 = 跑道西端、顺跑道方向（起飞点）。 */
  playableAt(id: string): PlayTarget | null {
    const kind = playableKind(id);
    if (!this.parts || !kind) return null;
    const heading = (object: THREE.Object3D, local: THREE.Vector3) => { const d = local.transformDirection(object.matrixWorld); return Math.atan2(d.z, d.x); };
    this.parts.group.updateMatrixWorld(true);
    if (kind === "car") {
      const districtId = id.slice("play:car:".length);
      const car = this.parts.group.getObjectByName(`${PLAYABLE_CAR_PREFIX}${districtId}`);
      if (!car) return null;
      const at = car.getWorldPosition(new THREE.Vector3());
      return { kind, districtId, color: paletteFor(districtId).accent, x: at.x, z: at.z, heading: heading(car, new THREE.Vector3(0, 0, 1)) };
    }
    if (kind === "mecha") {
      const squad = this.parts.group.getObjectByName(PLAYABLE_MECHA_NAME);
      return squad ? { kind } : null;
    }
    const runway = this.parts.group.getObjectByName(PLAYABLE_PLANE_NAME)?.userData.runway as THREE.Object3D | undefined;
    if (!runway) return null;
    const at = runway.getWorldPosition(new THREE.Vector3());
    return { kind, x: at.x, y: at.y, z: at.z, heading: heading(runway, new THREE.Vector3(1, 0, 0)) };
  }

  private pick(): string | null {
    if (!this.parts || !this.pointerClient) return null;
    this.pickedDecor = null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // 会话楼与非会话建筑一起测，取最近的命中：站在海滨酒店前点它，得到的是酒店说明而不是背后的会话楼。
    const hits = this.raycaster.intersectObjects([...this.parts.raycastTargets, ...this.parts.decorTargets], false);
    for (const hit of hits) {
      // Hidden zero-scale/procedural instances may produce non-finite ray intersections.
      // They are not visible targets and must never poison the camera or hover selection.
      if (!Number.isFinite(hit.distance) || hit.distance < this.camera.near || !hit.point.toArray().every(Number.isFinite)) continue;
      if (hit.instanceId !== undefined) {
        const id = this.parts.idAt(hit.object, hit.instanceId);
        if (id) return id;
      }
      const decor = this.parts.decorAt(hit.object, hit.instanceId, hit.point);
      if (decor) {
        // Merged/procedural decoration bounds can cover many objects; use the visible hit.
        this.pickedDecor = { id: decor, point: hit.point.clone() };
        return decor;
      }
    }
    return null;
  }

  /** 天穹：内翻大球，顶部到地平线的垂直渐变，1 次绘制的"天空感"。 */
  /** 白天天空照片的混合量：6–8 点渐入、16–18:30 渐出；同步给水面与玻璃反射（它们只用白天照片，调色量随之衰减）。 */
  private applyDayMix(hour: number): void {
    const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const dayMix = smooth(6, 8, hour) * (1 - smooth(16, 18.5, hour));
    const uniforms = (this.skyDome?.material as THREE.ShaderMaterial | undefined)?.uniforms;
    if (uniforms) uniforms.uDayMix.value = dayMix;
    this.dayMix = dayMix;
    this.parts?.setSkyMix(dayMix);
  }

  private applySkyImage(): void {
    const uniforms = (this.skyDome?.material as THREE.ShaderMaterial | undefined)?.uniforms;
    if (!uniforms || !this.assets) return;
    uniforms.uSky.value = this.assets.sky.dusk;
    uniforms.uSkyDay.value = this.assets.sky.day;
    uniforms.uHasSky.value = 1;
  }

  private buildSkyDome(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(6_000, 24, 14);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(activeTheme().skyTop) },
        midColor: { value: new THREE.Color(activeTheme().skyMid) },
        horizonColor: { value: new THREE.Color(activeTheme().skyHorizon) },
        // 全景天空图（HDR 转出）；uHasSky=0 时退回上面的三色渐变。
        uSky: { value: null as THREE.Texture | null },
        uHasSky: { value: 0 },
        // 白天照片与混合量：白天照片在 6–8 点渐入、16–18:30 渐出（见 updateDaylight），其余时间是黄昏照片（夜里再乘 uSkyDim）。
        uSkyDay: { value: null as THREE.Texture | null },
        uDayMix: { value: 0 },
        uGradeTop: { value: new THREE.Color(activeTheme().skyGrade.top) },
        uGradeHorizon: { value: new THREE.Color(activeTheme().skyGrade.horizon) },
        uGradeAmount: { value: activeTheme().skyGrade.amount },
        uSkyYaw: { value: skyYawOf(activeTheme()) },
        // 昼夜：渐变分支的程序星点强度；HDR 全景分支的夜间压暗（1=白天原样）。
        uStars: { value: 0 },
        uSkyDim: { value: 1 },
        // 夜晚混合量（0 = 照片天空，1 = 夜空渐变 + 星点）：夜里不再用压暗的黄昏照片。
        uNight: { value: 0 },
        // 阴天程度：照片天空也要变灰（曾只改渐变色，而照片会整个盖住渐变——阴天和雨天的天空照样晴朗）。
        uOvercast: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        uniform sampler2D uSky;
        uniform float uHasSky;
        uniform sampler2D uSkyDay;
        uniform float uDayMix;
        uniform vec3 uGradeTop;
        uniform vec3 uGradeHorizon;
        uniform float uGradeAmount;
        uniform float uSkyYaw;
        uniform float uStars;
        uniform float uSkyDim;
        uniform float uNight;
        uniform float uOvercast;
        varying vec3 vDirection;
        void main() {
          vec3 dir = normalize(vDirection);
          float height = clamp(dir.y, 0.0, 1.0);
          // 地平线 → 中段 → 天顶：日落主题靠中段的粉色撑出渐变带。
          vec3 color = mix(horizonColor, midColor, smoothstep(0.0, 0.28, height));
          color = mix(color, topColor, smoothstep(0.22, 0.85, height));
          vec3 gradient = color;
          if (uHasSky > 0.5) {
            // 等距柱状投影采样；地平线以下复用地平线那一行（下半球在水面以下，从不直接可见）。
            vec2 uv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5 + uSkyYaw, asin(clamp(dir.y, 0.002, 1.0)) / 3.1415927 + 0.5);
            vec3 photoDusk = texture2D(uSky, uv).rgb;
            vec3 photoDay = texture2D(uSkyDay, uv).rgb;
            vec3 photo = mix(photoDusk, photoDay, uDayMix) * uSkyDim;
            // 调色：按高度在两个色调之间做 overlay 式乘染（保留云的明暗，只换色相）。
            vec3 tint = mix(uGradeHorizon, uGradeTop, smoothstep(0.0, 0.6, height));
            vec3 graded = photo * tint * 1.55;
            // 粉紫调色只染黄昏那部分：白天照片保持原色。
            color = mix(photo, graded, uGradeAmount * (1.0 - uDayMix));
          }
          // 夜里整张照片天空换成渐变：照片会整个覆盖渐变（夜预设的深蓝从来显示不出来），
          // 压暗的黄昏照片在 20:00 是灰白雾、23:00 仍是橙色日落（用户截图）。
          color = mix(color, gradient, uNight);
          float skyLuma = dot(color, vec3(0.299, 0.587, 0.114));
          color = mix(color, vec3(skyLuma) * vec3(0.9, 0.93, 0.97), uOvercast);
          // 程序星点：方向量化到球面网格，每格 hash 决定有无星；只在上半天空。放在最后，照片/渐变都看得见。
          if (uStars > 0.01) {
            vec3 cell = floor(dir * 190.0);
            float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            float star = step(0.9965, h) * smoothstep(0.22, 0.65, dir.y);
            color += vec3(0.92, 0.95, 1.0) * star * uStars * (0.55 + 0.45 * h) * (0.3 + 0.7 * uNight);
          }
          gl_FragColor = vec4(color, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -10;
    this.disposablesSky.push(geometry, material);
    return mesh;
  }

  private startLoop(): void {
    if (this.options.headless || this.disposed || this.contextLost || this.raf) return;
    this.lastTime = performance.now();
    // 首个统计窗口从现在起算，而不是从 epoch 起（否则第一次 fps 恒为 0，
    // 会把 auto 画质立刻错误降档）。
    this.lastStatsAt = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  diagnosticState(): Record<string, number | boolean> {
    return { firstFrame: this.firstFrameSent, contextLost: this.contextLost,
      loopScheduled: !!this.raf, modelApplied: !!this.model,
      frameAgeMs: Math.round(performance.now() - this.lastRenderAt),
      width: this.renderer.domElement.width, height: this.renderer.domElement.height };
  }

  inspectScene() {
    const occupancy = this.parts?.occupancySnapshot() ?? { runtimeCount: 0, byId: {} as Record<string, { x: number; z: number; shaftPrimary: unknown }> };
    const positions: Record<string, { x: number; z: number; shaftPrimary: unknown }> = {};
    for (const [id, row] of Object.entries(occupancy.byId)) positions[id] = { x: row.x, z: row.z, shaftPrimary: row.shaftPrimary };
    return { lastApplyMode: this.lastApplyMode, scaleTier: this.layout?.scaleTier ?? null,
      selectedId: this.selectedId, hoveredId: this.hoveredId, camera: this.photoView(),
      occupantCount: occupancy.runtimeCount, positions, kits: this.parts?.kitSnapshot() ?? [],
      edits: this.parts?.editSnapshot() ?? [...this.editVisuals.values()].map((visual) => ({
        sessionId: visual.sessionId, assetRef: visual.assetRef, kind: visual.kind, eventId: visual.eventId,
      })),
      claims: this.parts?.claimSnapshot() ?? [] };
  }

  applyBuildingChanged(raw: unknown, animate: boolean): OverlayDecision | null {
    if (this.applyBuildingEdit(raw)) return null;
    const event = parseBuildingChanged(raw);
    if (!event) return null;
    const assetRef = event.entity_id;
    const sessionId = event.session_id
      ?? this.parts?.sessionIdForAsset(assetRef)
      ?? this.model?.buildings.find((building) => building.assetRef === assetRef)?.id;
    if (!sessionId) {
      this.pendingKits.set(assetRef, { event, animate });
      return null;
    }
    const current = this.kitDecisions.get(sessionId) ?? null;
    const next = applyBuildingEvent(current, event, sessionId, animate);
    if (!next) return null;
    if (current && current.buildEventId === next.buildEventId) return next;
    this.kitDecisions.set(sessionId, next);
    this.pendingKits.delete(assetRef);
    this.parts?.applySessionKit(next);
    this.clearBuildingEdit(sessionId);
    return next;
  }

  applyBuildingEdit(raw: unknown): boolean {
    const event = parseBuildingEdit(raw);
    if (!event) return false;
    const assetRef = event.entity_id;
    const sessionId = event.session_id
      ?? this.parts?.sessionIdForAsset(assetRef)
      ?? this.model?.buildings.find((building) => building.assetRef === assetRef)?.id;
    if (!sessionId) {
      this.pendingEdits.set(assetRef, event);
      return true;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const next = applyEditEvent(this.editVisuals.get(sessionId) ?? null, event, sessionId, now);
    if (!next) return true;
    this.editVisuals.set(sessionId, next);
    this.pendingEdits.delete(assetRef);
    this.parts?.applySessionEdit(next);
    return true;
  }

  clearBuildingEdit(sessionId: string): void {
    this.editVisuals.delete(sessionId);
    this.parts?.clearSessionEdit(sessionId);
  }

  applySquadEvent(raw: unknown): SquadEnvelope | null {
    const event = parseSquadEnvelope(raw);
    if (!event) return null;
    return event;
  }

  applyClaimTint(visual: ClaimTint): boolean {
    return this.parts?.applySessionClaim(visual) ?? false;
  }

  clearClaimTint(sessionOrAsset: string): boolean {
    const sessionId = this.parts?.sessionIdForAsset(sessionOrAsset) ?? sessionOrAsset;
    return this.parts?.clearSessionClaim(sessionId) ?? false;
  }

  replayBuilding(assetOrSession: string): boolean {
    const sessionId = this.kitDecisions.has(assetOrSession)
      ? assetOrSession
      : [...this.kitDecisions.values()].find((decision) => decision.assetRef === assetOrSession)?.sessionId;
    if (!sessionId) return false;
    const current = this.kitDecisions.get(sessionId);
    if (!current) return false;
    const next = replayDecision(current);
    this.kitDecisions.set(sessionId, next);
    return this.parts?.replaySessionKit(sessionId) ?? false;
  }

  private reapplyKits(mode: "mount" | "append"): void {
    if (!this.parts) return;
    const present = new Set(this.parts.kitSnapshot().map((row) => row.sessionId));
    for (const decision of this.kitDecisions.values()) {
      if (mode === "append" && present.has(decision.sessionId)) continue;
      this.parts.applySessionKit({ ...decision, animate: false });
    }
    for (const [assetRef, pending] of [...this.pendingKits]) {
      if (!this.parts.sessionIdForAsset(assetRef)) continue;
      this.pendingKits.delete(assetRef);
      this.applyBuildingChanged(pending.event, pending.animate);
    }
    for (const [assetRef, pending] of [...this.pendingEdits]) {
      if (!this.parts.sessionIdForAsset(assetRef)) continue;
      this.pendingEdits.delete(assetRef);
      this.applyBuildingEdit(pending);
    }
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    if (this.documentHidden) return;
    // CPU WebGL must leave time for iframe commands and the export worker.
    if (this.softwareRenderer && !this.surfaceDirty && !this.qualityDirty && now - this.lastRenderAt < 1000 / 15) return;
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastTime) / 1000));
    this.lastTime = now;
    this.elapsed += dt;
    this.noteActivityIfNeeded();

    // 游戏持有相机时不进入空闲降帧：飞行是持续活动，20fps 环境帧率会打断手感与物理步进节奏。
    const idle = !this.drivingWorldFrame && this.cameraOwner !== "game" && now - this.lastActivityAt > IDLE_AFTER_MS && !this.tween && !this.playing;
    if (idle && !this.surfaceDirty && !this.qualityDirty && now - this.lastRenderAt < IDLE_FRAME_INTERVAL_MS) return;

    this.updateScene(dt);
    this.renderFrame();
    this.lastRenderAt = now;
    this.accountFrame(now, idle);

    if (!this.firstFrameSent && this.model) {
      this.firstFrameSent = true;
      this.options.onFirstFrame?.();
    }
  };

  private noteActivityIfNeeded(): void {
    // 相机在动（阻尼/自动环绕）也算活动：环境帧率只在真正静止时启用。
    if (this.controls.autoRotate || this.tween) this.lastActivityAt = performance.now();
  }

  /** 开拍：镜头接管相机与时间游标；用户点/拖画布即中止。
   *  游戏持有相机期间拒绝开拍（§5 互斥；正常入口在进入游戏前已被禁用，此处兜底）。 */
  startCinematic(cut: CinematicCut = "full"): CinematicPlan | null {
    if (this.cameraOwner === "game" || this.drivingWorldFrame) return null;
    if (!this.layout || !this.model || !this.parts) return null;
    this.releaseOrbitLock();
    const plan = planCinematic(this.layout, this.model, this.parts.anchors(), { cut });
    this.tween = null;
    this.playing = false;
    this.attracted = false;
    this.controls.autoRotate = false;
    this.controls.enabled = false;
    // 航拍的时间加速率：整窗数据时长摊到片长上，喂给 applyCursor 做有节奏的升起。
    const cinemaPace = (this.model.windowEndMs - this.model.windowStartMs) / Math.max(1, plan.durationSec);
    // 航拍走晴天（applyWeather 在航拍中不调用）：把实况留下的彩虹收起，否则会一直挂在片子里。
    this.rainbow?.set(0, 0, this.cityCenter, 1);
    this.rain?.setAmount(0);
    this.cinematic = { plan, startedAt: this.elapsed, savedFov: this.camera.fov, look: null, lastSeconds: 0, pace: cinemaPace };
    this.camera.fov = 38; // 略长焦：压缩纵深，更像航拍镜头
    this.camera.updateProjectionMatrix();
    this.parts.setLabelsVisible(false);
    this.parts.setScaffoldVisible(false);
    this.parts.applyCursor(plan.cursor(0), false, cinemaPace);
    this.noteActivity();
    return plan;
  }

  stopCinematic(): void {
    const state = this.cinematic;
    if (!state) return;
    this.cinematic = null;
    this.controls.enabled = true;
    this.camera.fov = state.savedFov;
    this.parts?.setScaffoldVisible(true);
    this.camera.updateProjectionMatrix();
    this.cursorMs = null;
    this.parts?.applyCursor(this.model?.windowEndMs ?? Date.now(), true);
    this.options.onTimeCursor?.(this.model?.windowEndMs ?? Date.now(), true);
    this.options.onCinematic?.(0, state.plan, true);
  }

  /** 逐帧导出航拍（H.264 MP4；无 H.264 时 VP9/VP8 WebM，见 F5）。
   *  确定性：不读墙钟——每一帧用固定步长 1/fps 推进 elapsed、相机、昼夜与所有动画，再渲染、叠字、交给编码器；
   *  时间戳取自帧序号，所以渲染比实时慢多少都不影响成片速度（MediaRecorder 做不到这一点）。
   *  需要 WebCodecs H.264；不支持时明确报错，不伪装或静默切换容器。 */
  async renderFilm(options: {
    cut: CinematicCut; width: number; height: number; fps: number; bitrate: number; letterbox: number;
    describe: (card: import("./cityCinematic").CinematicCard) => FilmCardText | null; watermark: string;
    onProgress?: (frame: number, total: number) => void; signal?: AbortSignal;
    /** 每帧叠完字幕、交给编码器之前的回调；后台导出在此限频采样实际影片预览。 */
    onFrame?: (canvas: RenderCanvas, frame: number) => void;
    maxEncodedBytes?: number;
  }): Promise<Blob> {
    if (!this.layout || !this.model || !this.parts) throw new Error("city not ready");
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") throw new Error("WebCodecs unavailable");
    let config: VideoEncoderConfig | null = null;
    let container: { kind: "mp4" } | { kind: "webm"; codec: WebmCodec } = { kind: "mp4" };
    // Level 4.0 covers 1080p30. Baseline fallback accommodates stricter encoders.
    for (const codec of ["avc1.640028", "avc1.420028"]) {
      const candidate: VideoEncoderConfig = { codec, width: options.width, height: options.height,
        bitrate: options.bitrate, framerate: options.fps, latencyMode: "realtime", avc: { format: "avc" } };
      const support = await VideoEncoder.isConfigSupported(candidate);
      if (support.supported) { config = candidate; break; }
    }
    // F5：没有 H.264（部分 Linux/Chromium 构建）时退到 VP9/VP8 WebM——明确的 WebM 文件，不是改名的 MP4。
    if (!config) {
      for (const [codec, webm] of [["vp09.00.10.08", "V_VP9"], ["vp8", "V_VP8"]] as const) {
        const candidate: VideoEncoderConfig = { codec, width: options.width, height: options.height, bitrate: options.bitrate, framerate: options.fps, latencyMode: "realtime" };
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support.supported) { config = candidate; container = { kind: "webm", codec: webm }; break; }
      }
    }
    if (!config) throw new Error("video_encoder_unavailable");

    // 暂停实时循环，接管渲染。
    this.stopLoop();
    const wasQuality = this.quality;
    const savedElapsed = this.elapsed;
    let encoder: VideoEncoder | null = null;
    let writer: Mp4Writer | WebmFilmWriter | null = null;
    let completed = false;
    try {
    this.exportSize = { width: options.width, height: options.height };
    // Respect eco/adaptive quality during export; forcing expensive effects can starve
    // the plugin event loop on software GPUs even though the encoder is asynchronous.
    this.applyQualityLevel(wasQuality);
    // 从固定状态开拍：时钟归零、所有随帧累加的动画回到起点、天空强制重算。
    // 曾接着实时循环的 elapsed 与累加状态开拍，两次导出同一座城从第 ~17 帧起逐像素不同。
    this.elapsed = 0;
    this.lastSkyHour = Number.NaN;
    this.parts.resetAnimation();
    this.ambient?.reset();
    this.aurora?.reset();
    this.wildlife?.reset();
    this.rain?.reset();
    const plan = this.startCinematic(options.cut);
    if (!plan) throw new Error("cinematic unavailable");
    const film = createRenderCanvas(options.width, options.height);
    const ctx = renderContext2D(film);
    writer = container.kind === "mp4" ? new Mp4Writer(options.fps, options.width, options.height) : new WebmFilmWriter(container.codec, options.fps, options.width, options.height);
    await writer.start();
    let encodeError: unknown = null;
    let encodedBytes = 0;
    encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        encodedBytes += chunk.byteLength;
        if (encodedBytes > (options.maxEncodedBytes ?? 256 * 1024 * 1024)) { encodeError = new Error("export_memory_limit"); return; }
        writer!.addChunk(chunk, metadata);
      },
      error: (error) => { encodeError = error; },
    });
    encoder.configure(config);
    const dt = 1 / options.fps;
    let lastWorkMs = 0;
    const filmLength = plan.durationSec + 4; // 片尾停在全景 4 秒（同实时版）
    const total = Math.ceil(filmLength * options.fps);
    // 预热：渲染管线自带跨帧状态（同一状态连渲两次像素不同——倒影/阴影/后处理目标沿用上一帧），
    // 开拍前在起始状态原地渲几帧，把这些缓冲冲成同一个样子，不进片子。
    // 曾直接开拍：两次导出继承的是各自上一次实时帧的残留，片子逐像素不同。
      const yieldAndCheck = async () => {
        // Worker threads still share the GPU. Spend at most roughly 20% of the
        // measured frame work rate on export rather than saturating its queue.
        const pause = this.options.headless ? Math.max(80, Math.min(5000, lastWorkMs * 4)) : 16;
        await new Promise((resolve) => setTimeout(resolve, pause));
        if (options.signal?.aborted || this.disposed) throw new DOMException("aborted", "AbortError");
      };
      options.onProgress?.(0, total);
      await yieldAndCheck();
      this.updateScene(0);
      for (let warm = 0; warm < 3; warm += 1) {
        await yieldAndCheck();
        const started = performance.now();
        this.renderFrame();
        lastWorkMs = performance.now() - started;
      }
      for (let frame = 0; frame < total; frame += 1) {
        await yieldAndCheck();
        if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
        if (encodeError) throw encodeError;
        const started = performance.now();
        this.elapsed += dt;
        this.updateScene(dt);
        this.renderFrame();
        ctx.drawImage(this.options.canvas, 0, 0, options.width, options.height);
        drawFilmOverlay(ctx, { width: options.width, height: options.height, seconds: frame * dt, durationSec: filmLength, cards: plan.cards, describe: options.describe, watermark: options.watermark, letterbox: options.letterbox });
        options.onFrame?.(film, frame);
        const videoFrame = new VideoFrame(film, { timestamp: Math.round(frame * dt * 1_000_000), duration: Math.round(dt * 1_000_000) });
        encoder.encode(videoFrame, { keyFrame: frame % (options.fps * 2) === 0 });
        videoFrame.close();
        lastWorkMs = performance.now() - started;
        // 反压：编码队列堆积时让出事件循环，避免内存暴涨；顺便让进度条刷新。
        while (encoder.encodeQueueSize > 6) await yieldAndCheck();
        await writer.drain();
        options.onProgress?.(frame + 1, total);
      }
      await encoder.flush();
      if (encodeError) throw encodeError;
      const blob = await writer.finish(); completed = true;
      return blob;
    } finally {
      try { encoder?.close(); } catch { /* 已关闭 */ }
      if (!completed) { try { await writer?.cancel(); } catch { /* 保留原始失败 */ } }
      this.stopCinematic();
      this.exportSize = null;
      this.elapsed = savedElapsed;
      if (!this.disposed) {
        this.applyQualityLevel(wasQuality);
        this.startLoop();
      }
    }
  }

  /** 拍照：按当前机位，以固定尺寸、最高画质渲染一张 PNG（不带标签/悬停环，右下角水印）。
   *  不推进时间：画面就是用户此刻看到的城市。渲染管线有一帧滞后（倒影/阴影/后处理沿用上一帧），
   *  所以连渲两次再取第二帧。 */
  async capturePhoto(options: { width?: number; height?: number; watermark?: string } = {}): Promise<Blob> {
    if (!this.parts) throw new Error("city not ready");
    const requestedWidth = options.width ?? 2560;
    const requestedHeight = options.height ?? 1440;
    const scale = this.softwareRenderer ? Math.min(1, 640 / requestedWidth, 360 / requestedHeight) : 1;
    const width = Math.max(1, Math.round(requestedWidth * scale));
    const height = Math.max(1, Math.round(requestedHeight * scale));
    const wasQuality = this.quality;
    const aspect = this.camera.aspect;
    this.stopLoop();
    const restoreOverlays = this.parts.hideOverlaysForPhoto();
    this.exportSize = { width, height };
    this.applyQualityLevel(this.softwareRenderer ? 0 : this.options.headless ? wasQuality : 2);
    try {
      if (this.options.headless) await new Promise((resolve) => setTimeout(resolve, 80));
      const started = performance.now();
      this.renderFrame();
      if (this.options.headless) await new Promise((resolve) => setTimeout(resolve, Math.max(80, Math.min(5000, (performance.now() - started) * 4))));
      this.renderFrame();
      const photo = createRenderCanvas(width, height);
      const ctx = renderContext2D(photo);
      ctx.drawImage(this.options.canvas, 0, 0, width, height);
      if (options.watermark) {
        const unit = height / 1080;
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 8 * unit;
        ctx.textAlign = "right";
        ctx.font = `600 ${Math.round(16 * unit)}px system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif`;
        ctx.fillText(options.watermark, width - 28 * unit, height - 24 * unit);
        ctx.restore();
      }
      if (typeof document === "undefined") return await (photo as OffscreenCanvas).convertToBlob({ type: "image/png" });
      return await new Promise<Blob>((resolve, reject) => (photo as HTMLCanvasElement).toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed"))), "image/png"));
    } finally {
      restoreOverlays();
      this.exportSize = null;
      this.applyQualityLevel(wasQuality);
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      this.startLoop();
    }
  }

  get isCinematic(): boolean {
    return this.cinematic !== null;
  }

  private updateCinematic(): boolean {
    const state = this.cinematic;
    if (!state) return false;
    const seconds = this.elapsed - state.startedAt;
    const clamped = Math.min(seconds, state.plan.durationSec);
    // 分页数据到达会重建 parts，标签/脚手架被重置为可见：航拍期间每帧压住。
    this.parts?.setLabelsVisible(false);
    this.parts?.setScaffoldVisible(false);
    const position = state.plan.position(clamped);
    // 相机贴地保护在航拍里同样生效：路径插值偶尔会擦过山脊。
    if (this.layout) position.y = Math.max(position.y, Math.max(0, this.layout.terrain.height(position.x, position.z)) + 6);
    this.camera.position.copy(position);
    // 注视点做临界阻尼跟随：关键帧之间注视点切换会让镜头急甩，阻尼把甩头摊到 ~0.8s。
    const desired = state.plan.target(clamped);
    const frameDt = Math.max(0, seconds - state.lastSeconds);
    state.lastSeconds = seconds;
    if (!state.look) state.look = desired.clone();
    else state.look.lerp(desired, 1 - Math.exp(-frameDt / 0.35));
    this.controls.target.copy(state.look);
    this.camera.lookAt(state.look);
    const cursor = state.plan.cursor(clamped);
    this.parts?.applyCursor(cursor, false, state.pace);
    this.options.onTimeCursor?.(cursor, false);
    this.options.onCinematic?.(seconds, state.plan, false);
    this.lastActivityAt = performance.now();
    // 片尾停在全景上 4 秒再交还控制权。
    if (seconds > state.plan.durationSec + 4) this.stopCinematic();
    return true;
  }

  /** 昼夜循环：live 跟随真实本地时间，回放跟随时间轴游标的小时——
   *  拖动时间轴可以看到城市从白天进入黄昏与夜晚（亮窗/星空/水色变化）。 */
  private updateDaylight(): void {
    // 航拍用固定的「黄昏渐入」：15:00 → 19:36 随片长线性推进，片尾城市全亮。
    // 不能跟随真实时钟（导出的片子必须可复现），也不能跟随回放游标（90 天窗口在片中转 90 个昼夜，会频闪）。
    const cinematicHour = this.cinematic
      ? CINEMATIC_HOUR_FROM + (CINEMATIC_HOUR_TO - CINEMATIC_HOUR_FROM) * Math.min(1, this.cinematic.lastSeconds / this.cinematic.plan.durationSec)
      : undefined;
    this.environmentSnapshot = this.environment.sample(this.cursorMs ?? Date.now(), cinematicHour);
    const hour = this.environmentSnapshot.hour;
    const weather = this.environmentSnapshot.weather;
    const weatherKey = `${this.environmentSnapshot.mode}:${weather.kind}:${Math.round(weather.intensity * 100)}:${Math.round(weather.overcast * 100)}:${Math.round(weather.rainbow * 100)}`;
    // 插值随秒连续；仅在跨过 0.02h（~72s）时重写 uniform，避免无谓上传。
    if (Math.abs(hour - this.lastSkyHour) < (this.cinematic ? 0.0005 : 0.02) && weatherKey === this.lastWeatherKey) return;
    this.lastSkyHour = hour;
    this.lastWeatherKey = weatherKey;
    this.applyDayMix(hour);
    this.parts?.setNightHour(hour);
    const sky = skyStateAt(hour, this.themeName);
    this.applySky(sky);
    // 天气（按日期确定性）：航拍/胶片导出走晴朗（可复现），回放与实况按当天。
    if (!this.cinematic) this.applyWeather(this.environmentSnapshot);
  }

  /** 天气后处理（applySky 之后）：阴/雨对光照、雾、天色、云、水色的幂等调制——
   *  applySky 每个节流 tick 先按预设重写，这里再乘天气系数，不累积。夜灯判定
   *  在 applySky 内由未调制的 sunIntensity 推导，雨天中午不会被误判成夜晚开灯。 */
  private applyWeather(environment: CityEnvironmentSnapshot): void {
    const state = environment.weather;
    const overcast = state.overcast;
    if (!this.rain) {
      this.rain = new RainOverlay();
      this.scene.add(this.rain.mesh);
    }
    if (!this.rainbow) {
      this.rainbow = new RainbowArch(Math.max(90, this.boundsRadius * 0.35));
      this.scene.add(this.rainbow.mesh);
    }
    this.rain.setAspect(this.renderer.domElement.width, this.renderer.domElement.height);
    this.rain.setAmount(state.kind === "rain" ? state.intensity * 0.8 : 0);
    const azimuth = Math.atan2(this.sun.position.z - this.cityCenter.z, this.sun.position.x - this.cityCenter.x);
    this.rainbow.set(state.rainbow, azimuth, this.cityCenter, Math.max(240, this.boundsRadius * 0.85));
    const domeUniforms = (this.skyDome?.material as THREE.ShaderMaterial | undefined)?.uniforms;
    if (domeUniforms) domeUniforms.uOvercast.value = Math.min(0.85, overcast * 0.85);
    if (overcast <= 0.001 && state.rainbow <= 0.001) return;
    const greySky = new THREE.Color("#9aa3ab");
    const greyFog = new THREE.Color("#aeb6bc");
    const darkWater = new THREE.Color("#3c4a54");
    const dome = this.skyDome?.material as THREE.ShaderMaterial | undefined;
    if (dome) {
      (dome.uniforms.topColor.value as THREE.Color).lerp(greySky, 0.5 * overcast);
      (dome.uniforms.midColor.value as THREE.Color).lerp(greySky, 0.5 * overcast);
      (dome.uniforms.horizonColor.value as THREE.Color).lerp(greyFog, 0.55 * overcast);
    }
    (this.scene.background as THREE.Color).lerp(greyFog, 0.5 * overcast);
    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog) {
      fog.color.lerp(greyFog, 0.5 * overcast);
      fog.near *= 1 - 0.5 * overcast;
      fog.far *= 1 - 0.45 * overcast;
    }
    this.sun.intensity *= 1 - 0.55 * overcast;
    this.hemisphere.intensity *= 1 + 0.18 * overcast;
    if (this.fillLight) this.fillLight.intensity *= 1 - 0.3 * overcast;
    if (this.backLight) this.backLight.intensity *= 1 - 0.3 * overcast;
    if (this.parts) {
      const clouds = this.parts.cloudMaterial;
      if (clouds) clouds.opacity = Math.min(1, clouds.opacity + 0.55 * overcast);
      const water = this.parts.waterColors;
      if (water) {
        water.uShallow.value.lerp(darkWater, 0.35 * overcast);
        water.uDeep.value.lerp(darkWater, 0.35 * overcast);
      }
    }
  }

  private applySky(sky: CitySkyPreset): void {
    const domeMaterial = this.skyDome?.material as THREE.ShaderMaterial | undefined;
    if (!domeMaterial) return;
    const skyUniforms = domeMaterial.uniforms;
    (skyUniforms.topColor.value as THREE.Color).set(sky.top);
    (skyUniforms.midColor.value as THREE.Color).set(sky.middle);
    (skyUniforms.horizonColor.value as THREE.Color).set(sky.horizon);
    skyUniforms.uStars.value = sky.stars;
    skyUniforms.uSkyDim.value = 0.22 + 0.78 * Math.min(1, sky.sunIntensity / 1.2);
    // sunIntensity：日 1.55 / 黄昏 1.05 / 夜 0.32 → 黄昏及之前 0，入夜渐变到 1。
    const night = 1 - Math.min(1, Math.max(0, (sky.sunIntensity - 0.32) / (0.95 - 0.32)));
    skyUniforms.uNight.value = night * night * (3 - 2 * night);
    this.parts?.setNightWater(skyUniforms.uNight.value);
    skyUniforms.uOvercast.value = 0; // applyWeather 随后再按当天天气写入：每个 tick 先归零，不累积
    (this.scene.background as THREE.Color).set(sky.fog);
    const fog = this.scene.fog;
    if (fog && fog instanceof THREE.Fog) {
      fog.color.set(sky.fog);
      const bounds = Math.max(120, this.boundsRadius);
      fog.near = bounds * sky.fogNearFactor;
      fog.far = bounds * sky.fogFarFactor;
    }
    this.hemisphere.color.set(sky.hemiSky);
    this.hemisphere.groundColor.set(sky.hemiGround);
    this.hemisphere.intensity = sky.hemiIntensity;
    this.sun.color.set(sky.sunColor);
    this.sun.intensity = sky.sunIntensity;
    if (this.fillLight && this.backLight) {
      this.fillLight.color.set(sky.fillColor);
      this.fillLight.intensity = sky.fillIntensity;
      this.backLight.color.set(sky.backColor);
      this.backLight.intensity = sky.backIntensity;
    }
    // 太阳绕城心的方位/高度角：白天高、黄昏低、夜晚是月光方向。
    const radius = 320;
    this.sun.position.set(
      this.cityCenter.x + Math.cos(sky.sunAzimuth) * Math.cos(sky.sunElevation) * radius,
      Math.sin(sky.sunElevation) * radius,
      this.cityCenter.z + Math.sin(sky.sunAzimuth) * Math.cos(sky.sunElevation) * radius,
    );
    if (this.parts) {
      const water = this.parts.waterColors;
      if (water) {
        water.uShallow.value.set(sky.waterShallow);
        water.uDeep.value.set(sky.waterDeep);
        // 生态带水色：在昼夜预设之上轻度偏移（量随白天亮度衰减，夜里夜海仍是夜色）。
        const grade = this.layout ? BIOME_GRADES[this.layout.biome] : null;
        if (grade?.water) {
          const lightness = { h: 0, s: 0, l: 0 };
          new THREE.Color(sky.waterShallow).getHSL(lightness);
          const daylight = Math.min(1, lightness.l * 2.2);
          water.uShallow.value.lerp(new THREE.Color(grade.water.shallow), grade.waterAmount * daylight);
          water.uDeep.value.lerp(new THREE.Color(grade.water.deep), grade.waterAmount * daylight);
        }
        water.uSky.value.set(sky.fog);
      }
      const clouds = this.parts.cloudMaterial;
      if (clouds) clouds.opacity = sky.cloudOpacity;
      this.aurora?.setNight(sky.stars);
      this.ambient?.setNight(sky.stars);
      // 航拍/导出不读墙钟：流星夜按数据窗口末日决定（同一份数据永远同一种夜空）。
      this.wildlife?.setNight(sky.stars, this.cinematic ? (this.model?.windowEndMs ?? 0) : (this.cursorMs ?? Date.now()));
      // 夜晚城市亮窗：立面自发光抬升（保留 theme 基线的下限）。
      this.parts.setNightGlow(sky.selfLit);
      // N1：夜里曝光压低约 0.35 EV，暗是底色、光源才有层次。
      this.renderer.toneMappingExposure = activeTheme().exposure * (1 - LIGHT_BUDGET.ambient.exposureCut * nightFactor(sky.selfLit));
      this.parts.applySelfLit(this.themeSelfLit);
      this.parts.setNightWater(skyUniforms.uNight.value as number);
    }
  }

  private updateScene(dt: number): void {
    // A frozen driving consumer uses the existing host frame, never a second rAF.
    this.updateDaylight();
    this.drivingWorldFrame?.run(dt);
    this.aurora?.update(dt);
    this.ambient?.update(dt, this.elapsed);
    this.wildlife?.update(dt, this.elapsed);
    // 雨丝层贴相机前方；航拍期间强制晴朗（applyWeather 不跑，手动关掉防残留）。
    if (this.cinematic) this.rain?.setAmount(0);
    else this.rain?.update(dt, this.elapsed, this.camera);
    if (this.drivingWorldFrame) { this.parts?.update(dt, this.elapsed); return; }
    // 固定游戏相机由帧钩子独占；轨道模式在对象更新后继续走 City 的 OrbitControls。
    this.gameFrame?.(dt);
    if (this.cameraOwner === "game" && this.gameFrame) {
      this.parts?.update(dt, this.elapsed);
      return;
    }
    if (this.updateCinematic()) {
      this.parts?.update(dt, this.elapsed);
      return;
    }
    // 回放推进。
    if (this.playing && this.model) {
      const next = (this.cursorMs ?? this.model.windowStartMs) + dt * 1000 * this.playbackSpeed;
      if (next >= this.model.windowEndMs) {
        this.cursorMs = this.model.windowEndMs;
        this.playing = false;
      } else {
        this.cursorMs = next;
      }
      this.parts?.applyCursor(this.cursorMs, false, this.playbackSpeed * 1000);
      this.options.onTimeCursor?.(this.cursorMs, false);
    }

    // 聚焦 tween。
    if (this.tween) {
      const progress = Math.min(1, (this.elapsed - this.tween.start) / this.tween.duration);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, eased);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, eased);
      if (progress >= 1) this.tween = null;
    }

    if (this.orbitLockedId && !this.tween) {
      const anchor = this.orbitLockedId.startsWith("decor:") ? null : this.parts?.focusAnchorFor(this.orbitLockedId);
      if (anchor) {
        const target = new THREE.Vector3(anchor.x, anchor.ground + anchor.height * 0.5, anchor.z);
        this.camera.position.add(target.clone().sub(this.controls.target));
        this.controls.target.copy(target); // Follow growth/replay without changing orbit direction or distance.
      }
    }
    if (this.tween) this.camera.lookAt(this.controls.target);
    else this.controls.update();
    // 相机不得沉到地形/水面以下：低机位会让近裁剪面切出一条平直的陆地边。
    if (this.layout) {
      const floor = Math.max(0, this.layout.terrain.height(this.camera.position.x, this.camera.position.z)) + 3;
      if (this.camera.position.y < floor) this.camera.position.y = floor;
    }
    this.parts?.update(dt, this.elapsed);

    // 悬停拾取（每帧至多一次，且只在指针动过或相机在动时）。
    if (this.parts && !this.pointerDown && this.pointerClient && (this.pointerMoved || this.tween)) {
      this.pointerMoved = false;
      const id = this.pick();
      if (id !== this.hoveredId) {
        this.hoveredId = id;
        this.parts.setHovered(id);
      }
      if (id) this.options.onHover?.(id, this.pointerClient.x, this.pointerClient.y);
      else this.options.onHover?.(null, 0, 0);
    }
  }

  private accountFrame(now: number, idle: boolean): void {
    this.frameCount += 1;
    // 帧率统计（以 stats 周期计算滑动平均）。
    if (this.lastStatsAt === 0) {
      this.lastStatsAt = now;
      this.frameCount = 0;
      return;
    }
    if (now - this.lastStatsAt > 1_000) {
      const measured = this.frameCount * 1000 / Math.max(1, now - this.lastStatsAt);
      this.fps = measured;
      this.frameCount = 0;
      this.lastStatsAt = now;
      this.options.onStats?.({
        fps: Math.round(measured),
        drawCalls: this.renderer.info.render.calls,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        triangles: this.renderer.info.render.triangles,
        buildings: this.model?.buildings.length ?? 0,
        quality: this.quality,
        idle,
      });
      this.maybeRetier(measured, idle);
    }
  }

  private maybeRetier(fps: number, idle: boolean): void {
    if (this.qualityMode !== "auto" || idle || this.surfaceDirty || performance.now() - this.lastSurfaceChangeAt < 2_000) {
      this.lowFpsWindows = this.highFpsWindows = 0;
      return;
    }
    const now = performance.now();
    this.lowFpsWindows = fps < 27 ? this.lowFpsWindows + 1 : 0;
    this.highFpsWindows = fps > 55 ? this.highFpsWindows + 1 : 0;
    if (now - this.lastTierChangeAt < 12_000) return;
    if (this.lowFpsWindows >= 3 && this.quality > 0) {
      this.applyQualityLevel((this.quality - 1) as QualityLevel);
      this.upgradeAfter = now + 60_000;
    } else if (this.highFpsWindows >= 8 && now >= this.upgradeAfter && this.quality < 2) {
      this.applyQualityLevel((this.quality + 1) as QualityLevel);
    } else return;
    this.lastTierChangeAt = now;
    this.lowFpsWindows = this.highFpsWindows = 0;
  }

  /** Capture current rendered roads + structural solids, with lazy revision-bound queries.
   *  Model/patch/seed rebuild and teardown invalidate old handles, including cached indices.
   *  Building/landmark solids are not yet in this structural snapshot (coverage is explicit). */
  captureDrivingSurface(signal?: AbortSignal): Promise<CitySurfaceCapture> {
    return this.surfacePort.capture(this.parts?.drivingSurfaceSource() ?? null, signal);
  }

  /** Explicit display-freeze lease. The caller MUST release it, including on refused entry.
   * Captures actual building/landmark meshes at current displayed height, not final model height.
   * Independent readers share the freeze; releasing one cannot unfreeze another reader. */
  async captureDrivingWorld(signal?: AbortSignal): Promise<CityDrivingWorldCapture> {
    const parts = this.parts;
    if (!parts || this.disposed) return Object.freeze({ status: "unavailable" });
    if (signal?.aborted) return Object.freeze({ status: "cancelled" });
    let lease: ReturnType<CityParts["acquireDrivingWorldSource"]>;
    try { lease = parts.acquireDrivingWorldSource(); }
    catch { return Object.freeze({ status: "unavailable" }); }
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      lease.release();
      this.drivingWorldPort.releaseFrozenSource(lease.source);
    };
    try {
      const capture = await this.drivingWorldPort.capture(lease.source, signal);
      if (capture.status !== "ready") { release(); return capture; }
      const current = () => active && this.parts === parts && capture.isCurrent();
      const leaseCurrent = () => active && this.parts === parts && capture.isLeaseCurrent();
      return Object.freeze({ ...capture, isCurrent: current, isLeaseCurrent: leaseCurrent, release,
        verifyCurrent: () => active && this.parts === parts && capture.verifyCurrent(),
        read: () => current() ? capture.read() : null,
        readWorld: () => current() ? capture.readWorld() : null,
        querySurface: (request: Parameters<ReadyCitySurfaceCapture["querySurface"]>[0]) => current() ? capture.querySurface(request) : Object.freeze({ status: "stale" as const }),
        checkStructures: (options: Parameters<ReadyCitySurfaceCapture["checkStructures"]>[0]) => current() ? capture.checkStructures(options) : null,
        checkLandings: (options: Parameters<ReadyCitySurfaceCapture["checkLandings"]>[0]) => current() ? capture.checkLandings(options) : null,
      });
    } catch { release(); return Object.freeze({ status: "unavailable" }); }
  }

  private readAmbientCarsVisible(): boolean {
    const mesh = (this.parts as unknown as { carMesh?: THREE.InstancedMesh } | null)?.carMesh;
    return mesh ? mesh.visible : this.ambientCarsVisible;
  }
  private writeAmbientCarsVisible(visible: boolean): void {
    this.ambientCarsVisible = visible;
    const mesh = (this.parts as unknown as { carMesh?: THREE.InstancedMesh } | null)?.carMesh;
    if (mesh) mesh.visible = visible;
  }

  dispose(): void {
    this.disposed = true;
    this.hostEpoch += 1;
    this.gameScenePort.invalidate();
    this.surfacePort.invalidate();
    this.drivingWorldPort.invalidate();
    this.drivingWorldFrame = null;
    this.drivingControls?.detach(); this.drivingControls = null;
    this.drivingCamera?.dispose(); this.drivingCamera = null;
    this.drivingCameraInitialized = false;
    this.stopLoop();
    this.gameFrame = null;
    this.cameraOwner = "orbit";
    this.observers.forEach((cleanup) => cleanup());
    if (this.parts) {
      this.scene.remove(this.parts.group, this.parts.water);
      this.parts.dispose();
      this.parts = null;
    }
    this.composer?.dispose();
    this.composer = null;
    this.mirror?.dispose();
    this.mirror = null;
    this.controls.dispose();
    this.aurora?.dispose();
    this.aurora = null;
    this.ambient?.dispose();
    this.ambient = null;
    this.wildlife?.dispose();
    this.wildlife = null;
    this.rain?.dispose();
    this.rain = null;
    this.rainbow?.dispose();
    this.rainbow = null;
    this.disposablesSky.forEach((disposable) => disposable.dispose());
    this.renderer.dispose();
  }
}
